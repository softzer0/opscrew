import { readFile } from "node:fs/promises";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, type Network, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork, type WireGuardPeerState } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import { reopenedPlan, serverRemote } from "../shared/server-address";
import { type ServerAddresses, updateServerAddresses } from "../shared/server-record";
import { writeKnownHost } from "../shared/wait";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  ScriptedApprovalHandler,
  ScriptedRunner,
  testKeyMaker,
  testKeyPair,
} from "../testing";
import { probeExpectedPorts } from "./probes";
import { closePublicSsh, openPublicSsh } from "./public-ssh";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const APP_IPV4 = "203.0.113.10";
const DATA_IPV4 = "203.0.113.30";
const ALLOWED = ["198.51.100.0/24", "2001:db8::/32"];
/** A pinned host key (a public key, not a secret). */
const HOST_KEY = {
  type: "ssh-ed25519",
  key: "AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfTheServersForTests",
};

/** A server OpsCrew created, as inspection reads it through Docker: ufw on, SSH public and on the network. */
function cloudFacts(open: boolean): HostFacts {
  const facts = freshFacts({ user: "deploy", privilege: "docker" });
  return HostFactsSchema.parse({
    ...facts,
    firewall: {
      ...facts.firewall,
      ufw: "active",
      ufwRules: [
        ...(open ? [{ rule: "allow 22/tcp", comment: null }] : []),
        { rule: "allow in on wg-opscrew0 to any port 22 proto tcp", comment: "opscrew-network" },
      ],
    },
    network: { dropIn: null, interfaces: [], filterUnit: null, filters: [] },
  });
}

/** The split plan (`db` on server `data`) on its network with the device laptop, deployed. */
function networked(o: { runner?: "github" | "server"; network?: Partial<Network> } = {}) {
  const split = splitPlan();
  const base = {
    ...split,
    environment: { runner: o.runner ?? "server" },
    security: { ...split.security, sshAllowedCidrs: ALLOWED },
    deployment: { ...split.deployment, lastApplyAt: DEPLOYED_AT },
  } as Omit<DeployPlan, "network">;
  const { network } = allocateNetwork(base, {}, testKeyMaker("server"));
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const laptop = {
    name: "laptop",
    address: `${prefix}.100`,
    publicKey: testKeyPair("laptop").publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  };
  return {
    plan: withNetwork(base, { ...network, devices: [laptop], ...o.network }),
    prefix,
  };
}

interface Apply {
  host: string;
  plan: HostPlan;
}

/**
 * A deployed project with `plan`, the servers' addresses and host keys on this computer, and fakes:
 * each server's shell (at the address `serverRemote` gives for the plan on disk now), WireGuard's
 * handshakes (`ages`, seconds by server), the host adapter and provision.
 */
async function world(o: {
  plan: DeployPlan;
  record?: Partial<ServerAddresses>;
  ages?: Record<string, number | undefined>;
  open?: boolean;
  answer?: () => boolean;
  /** This computer's commands (ssh's own logins), default all succeed. */
  runner?: ScriptedRunner;
  /** How provision stops, when it does. */
  provisionError?: OpsCrewError;
}) {
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    clock: { now: () => NOW },
    ...(o.runner !== undefined ? { runner: o.runner } : {}),
  });
  await writeArtifact("plan", deps.paths.files.plan, o.plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: APP_IPV4 },
    servers: { data: { ipv4: DATA_IPV4 } },
    thisDevice: "laptop",
    ...o.record,
  }));
  for (const name of [APP_IPV4, DATA_IPV4]) {
    await writeKnownHost(deps.paths.files.knownHosts, name, [HOST_KEY]);
  }
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  /** Where each server was reached, in order, and what ran there. */
  const events: string[] = [];
  const applies: Apply[] = [];
  const shellAt = (host: string): RemoteExec => ({
    host,
    async run(command): Promise<CommandResult> {
      if (command.startsWith("ping ")) {
        return { exitCode: 0, stdout: "3 received, rtt = 1/2/3/4 ms", stderr: "" };
      }
      return { exitCode: 0, stdout: "docker\n", stderr: "" };
    },
  });
  const ages = o.ages ?? { app: 5, data: 20 };
  /** Each server by its public and its private address. */
  const servers: Record<string, string> = {
    [APP_IPV4]: "app",
    [DATA_IPV4]: "data",
    ...Object.fromEntries((o.plan.network?.members ?? []).map((m) => [m.address, m.name])),
  };
  const provisioned: { options: ProvisionOptions; plan: DeployPlan }[] = [];
  const services = {
    remote: async (server: string) =>
      shellAt((await serverRemote(deps, await plan(), server)).host),
    readWireGuard: async (remote: RemoteExec): Promise<WireGuardPeerState[]> => {
      const age = ages[servers[remote.host] ?? ""];
      return age === undefined
        ? []
        : [
            {
              publicKey: testKeyPair("laptop").publicKey,
              latestHandshake: new Date(NOW.getTime() - age * 1000),
              allowedIps: [],
            },
          ];
    },
    host: {
      async inspect(remote: RemoteExec) {
        events.push(`inspect ${remote.host}`);
        return cloudFacts(o.open ?? true);
      },
      async apply(remote: RemoteExec, p: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(p)) throw new Error("host plan hash mismatch");
        events.push(`apply ${remote.host}`);
        applies.push({ host: remote.host, plan: p });
        return {
          applied: p.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
    provision: async (_deps: unknown, options: ProvisionOptions): Promise<ProvisionResult> => {
      events.push("provision");
      provisioned.push({ options, plan: await plan() });
      if (o.provisionError !== undefined) throw o.provisionError;
      return { planHash: "a".repeat(64), applied: true, outputs: {} } as ProvisionResult;
    },
  };
  return { deps, handler, services, plan, events, applies, provisioned };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The `public-ssh` step's parameters in a host plan. */
function paramsOf(plan: HostPlan) {
  return plan.steps.find((s) => s.id === "public-ssh")?.params;
}

describe("opscrew secure --close-public-ssh", () => {
  it("runs the infrastructure plan, then each server's host plan over the private network, approved by its hash", async () => {
    const { plan, prefix } = networked();
    const w = await world({ plan });

    const result = await closePublicSsh(w.deps, {
      approveHashes: ["b".repeat(64)],
      services: w.services,
    });

    // Provision (the cloud firewalls, the workflow, the check, the pull request) first, with the
    // plan already closed; then the host plans, app first, each reached at its private address.
    expect(w.events).toEqual([
      "provision",
      `inspect ${prefix}.1`,
      `apply ${prefix}.1`,
      `inspect ${prefix}.2`,
      `apply ${prefix}.2`,
    ]);
    expect(w.provisioned[0]?.options).toEqual({ approveHashes: ["b".repeat(64)] });
    expect(w.provisioned[0]?.plan.network?.publicSsh).toBe(false);
    expect(w.provisioned[0]?.plan.security.sshAllowedCidrs).toEqual([]);
    expect(w.handler.requests.map((r) => [r.kind, r.title])).toEqual([
      ["host-apply", "Close public SSH on server app"],
      ["host-apply", "Close public SSH on server data"],
    ]);
    for (const apply of w.applies) {
      expect(paramsOf(apply.plan)).toEqual({
        open: false,
        interface: "wg-opscrew0",
        allowedCidrs: "",
        sshPort: 22,
        cloudServer: true,
      });
    }
    expect(result).toMatchObject({
      open: false,
      hostPlanHashes: w.applies.map((a) => hostPlanHash(a.plan)),
      hostApplied: true,
    });

    // The plan: closed, the allow-list kept for opening, the host plans' approvals recorded.
    const after = await w.plan();
    expect(after.network?.publicSsh).toBe(false);
    expect(after.network?.publicSshAllowedCidrs).toEqual(ALLOWED);
    expect(after.security.sshAllowedCidrs).toEqual([]);
    expect(after.approvals.map((a) => a.planHash)).toEqual(result.hostPlanHashes);

    // The host keys are pinned under the private addresses, and connections go there now.
    const knownHosts = await readFile(w.deps.paths.files.knownHosts, "utf8");
    expect(knownHosts).toContain(`${prefix}.1 ${HOST_KEY.type} ${HOST_KEY.key}`);
    expect(knownHosts).toContain(`${prefix}.2 ${HOST_KEY.type} ${HOST_KEY.key}`);
    expect((await serverRemote(w.deps, after, "data")).host).toBe(`${prefix}.2`);
  });

  it("continues where it stopped: the allow-list it kept stays when it runs again", async () => {
    const { plan } = networked();
    let refuse = true;
    const w = await world({ plan, answer: () => !refuse });
    await expect(closePublicSsh(w.deps, { services: w.services })).rejects.toThrow();
    expect((await w.plan()).network?.publicSshAllowedCidrs).toEqual(ALLOWED);

    refuse = false;
    await closePublicSsh(w.deps, { services: w.services });
    const after = await w.plan();
    expect(after.network?.publicSshAllowedCidrs).toEqual(ALLOWED);
    expect(after.security.sshAllowedCidrs).toEqual([]);
  });

  it("refuses deploys outside the private network, before any change, with the fix", async () => {
    const { plan } = networked({ runner: "github" });
    const w = await world({ plan });
    const before = await readFile(w.deps.paths.files.plan, "utf8");

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("the deploys run on GitHub's machines");
    expect(error.message).toContain("Nothing was changed.");
    expect(error.hint).toContain("`opscrew env set prod --runner server`");
    expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
    expect(w.events).toEqual([]);
  });

  it("refuses when this computer is not a device on the network, with the fix", async () => {
    const { plan } = networked();
    const w = await world({ plan, record: { thisDevice: undefined } });

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.message).toContain("this computer is not a device on the app's private network");
    expect(error.hint).toContain("`opscrew vpn add <name> --this-computer`");
    expect(w.events).toEqual([]);
  });

  it("refuses when this computer's tunnel had no recent handshake with every server, naming them", async () => {
    const { plan } = networked();
    const w = await world({ plan, ages: { app: 5, data: 200 } });

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.message).toContain("had no handshake in the last 3 minutes");
    expect(error.message).toContain("server data: last handshake");
    expect(error.message).not.toContain("server app:");
    expect(error.hint).toContain("`opscrew vpn list`");
    expect((await w.plan()).network?.publicSsh).toBe(true);
    expect(w.events).toEqual([]);
  });

  it("refuses before any change when SSH doesn't answer over the private network", async () => {
    const { plan, prefix } = networked();
    // A login at server data's private address times out; every other command succeeds.
    const runner = new ScriptedRunner((command, args) =>
      command === "ssh" && args.some((arg) => arg.endsWith(`@${prefix}.2`))
        ? {
            exitCode: 255,
            stdout: "",
            stderr: `ssh: connect to host ${prefix}.2 port 22: Connection timed out`,
          }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    const w = await world({ plan, runner });
    const before = await readFile(w.deps.paths.files.plan, "utf8");

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "could not log in to server data over the app's private network",
    );
    expect(error.message).toContain("Nothing was changed.");
    expect(error.hint).toContain("`sudo wg show`");
    expect(error.hint).toContain("run `opscrew provision` first");
    expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
    expect(w.events).toEqual([]);
    // The probes were new logins at the private addresses, with a 30-second limit.
    const logins = runner.calls.filter((c) => c.command === "ssh");
    expect(logins.map((c) => c.args.find((arg) => arg.includes("@")))).toEqual([
      `deploy@${prefix}.1`,
      `deploy@${prefix}.2`,
    ]);
    expect(logins.every((c) => c.args.includes("ControlMaster=no"))).toBe(true);
    expect(logins[0]?.options?.timeoutMs).toBe(30_000);
  });

  it("says to run it again when provision stops", async () => {
    const { plan } = networked();
    const stopped = new OpsCrewError(
      "APPROVAL_REFUSED",
      "The infrastructure plan was not approved.",
    );
    const w = await world({ plan, provisionError: stopped });

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.message).toBe("The infrastructure plan was not approved.");
    expect(error.hint).toBe("Run `opscrew secure --close-public-ssh` again to finish closing.");
    expect(w.applies).toEqual([]);
  });

  it("names every missing condition at once, each with its fix", async () => {
    const { plan } = networked({ runner: "github" });
    const w = await world({ plan, record: { thisDevice: undefined } });

    const error = await failure(closePublicSsh(w.deps, { services: w.services }));

    expect(error.message).toContain("the deploys run on GitHub's machines");
    expect(error.message).toContain("this computer is not a device");
    expect(error.hint).toContain("--runner server");
    expect(error.hint).toContain("--this-computer");
    expect(error.hint).toContain("`opscrew secure --close-public-ssh` again");
  });
});

describe("opscrew secure --open-public-ssh", () => {
  it("opens SSH on each server over the private network to the kept allow-list, then runs provision", async () => {
    const { plan: open, prefix } = networked();
    const closed = withNetwork(
      { ...open, security: { ...open.security, sshAllowedCidrs: [] } },
      {
        ...(open.network as Network),
        publicSsh: false,
        publicSshAllowedCidrs: ALLOWED,
      },
    );
    const w = await world({ plan: closed, open: false });

    const result = await openPublicSsh(w.deps, { services: w.services });

    expect(w.events).toEqual([
      `inspect ${prefix}.1`,
      `apply ${prefix}.1`,
      `inspect ${prefix}.2`,
      `apply ${prefix}.2`,
      "provision",
    ]);
    for (const apply of w.applies) {
      expect(paramsOf(apply.plan)).toMatchObject({ open: true, allowedCidrs: ALLOWED.join(" ") });
    }
    // Provision renders the cloud firewalls, the workflow and the check for an open plan.
    const rendered = w.provisioned[0]?.plan;
    expect(rendered?.network?.publicSsh).toBe(true);
    expect(rendered?.network?.publicSshAllowedCidrs).toBeUndefined();
    expect(rendered?.security.sshAllowedCidrs).toEqual(ALLOWED);
    expect((await w.plan()).approvals.map((a) => a.planHash)).toEqual(result.hostPlanHashes);
    expect((await serverRemote(w.deps, await w.plan(), "data")).host).toBe(DATA_IPV4);
    // The audited titles never name an address range; the details do.
    expect(w.handler.requests.map((r) => r.title)).toEqual([
      "Open SSH on server app again",
      "Open SSH on server data again",
    ]);
    expect(w.handler.requests[0]?.details).toContain(ALLOWED[0]);
  });

  it("says to run provision when it stops before the cloud firewalls opened", async () => {
    const { plan: open } = networked();
    const closed = withNetwork(
      { ...open, security: { ...open.security, sshAllowedCidrs: [] } },
      { ...(open.network as Network), publicSsh: false, publicSshAllowedCidrs: ALLOWED },
    );
    const stopped = new OpsCrewError(
      "APPROVAL_REFUSED",
      "The infrastructure plan was not approved.",
      {
        hint: "Run it again to approve it.",
      },
    );
    const w = await world({ plan: closed, open: false, provisionError: stopped });

    const error = await failure(openPublicSsh(w.deps, { services: w.services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toBe(
      "Run it again to approve it. Then run `opscrew provision` to open SSH in the cloud firewalls.",
    );
    expect((await w.plan()).network?.publicSsh).toBe(true);
  });

  it("only runs provision for the cloud firewalls while the plan says public SSH is open", async () => {
    const { plan } = networked();
    const w = await world({ plan });
    const result = await openPublicSsh(w.deps, { services: w.services });
    expect(result).toMatchObject({ open: true, hostPlanHashes: [], hostApplied: false });
    expect(w.events).toEqual(["provision"]);
  });

  it("opens to the kept allow-list, else the plan's, else everyone", () => {
    const { plan } = networked();
    const network = plan.network as Network;
    const closed = (kept?: string[]) => ({
      ...plan,
      security: { ...plan.security, sshAllowedCidrs: [] },
      network: { ...network, publicSsh: false, ...(kept ? { publicSshAllowedCidrs: kept } : {}) },
    });
    const opened = reopenedPlan(closed(ALLOWED));
    expect(opened.security.sshAllowedCidrs).toEqual(ALLOWED);
    expect(opened.network).toMatchObject({ publicSsh: true });
    expect(opened.network?.publicSshAllowedCidrs).toBeUndefined();
    expect(reopenedPlan(closed()).security.sshAllowedCidrs).toEqual(["0.0.0.0/0", "::/0"]);
    expect(reopenedPlan(plan).security.sshAllowedCidrs).toEqual(ALLOWED);
  });
});

describe("the outside SSH probe with public SSH closed", () => {
  it("passes when port 22 does not answer, and fails when it still does", async () => {
    const { plan: open } = networked();
    const closed = withNetwork(
      { ...open, security: { ...open.security, sshAllowedCidrs: [] } },
      { ...(open.network as Network), publicSsh: false, publicSshAllowedCidrs: ALLOWED },
    );
    const quiet = await probeExpectedPorts("203.0.113.10", closed, { connect: async () => false });
    expect(quiet.find((c) => c.id === "port-22-open")).toMatchObject({
      status: "pass",
      title: "SSH (port 22) is closed to the internet",
    });
    const answers = await probeExpectedPorts("203.0.113.10", closed, {
      connect: async (_host, port) => port === 22,
    });
    const check = answers.find((c) => c.id === "port-22-open");
    expect(check).toMatchObject({ status: "fail", severity: "high" });
    expect(check?.remediation).toContain("opscrew secure --close-public-ssh");
  });
});
