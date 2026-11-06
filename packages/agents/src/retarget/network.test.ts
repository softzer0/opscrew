/**
 * A move of an app with Postgres on an extra server (feature 023, US6, plan.md "7."): only its app
 * server moves, joining the private network as a new member; the old one leaves at `--finish`,
 * and `--abort` undoes it.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { findExecutable, type MemoryAuditLog } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_PUSH_PORT,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { PREVIOUS_MEMBER } from "../network";
import { monitoredPlan, networked, splitPlan } from "../network/__fixtures__/plans";
import { ensureDeployKey, recordOwnServer, updateServerAddresses } from "../shared";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  type MemoryReporter,
  moveHarness,
  OWN_IPV4,
  ownRunner,
  ScriptedApprovalHandler,
} from "../testing";
import {
  endMoveKey,
  joinMoveNetwork,
  leaveMoveNetwork,
  networkBeforeMove,
  recordMoveKey,
  startNetwork,
  undoMoveNetwork,
} from "./network";
import type { MoveSession } from "./session";
import { startMove } from "./start";

const OLD_IP = "203.0.113.10";
const NEW_IP = "198.51.100.10";
const DATA_IP = "203.0.113.20";
const MONITORING_IP = "203.0.113.30";

/** What deploy reads on a server OpsCrew created: root only through Docker, maybe its interface. */
function cloudFacts(publicKey?: string): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    network:
      publicKey === undefined
        ? null
        : {
            dropIn: null,
            interfaces: [
              {
                name: "wg-opscrew0",
                config: "0".repeat(64),
                publicKey,
                enabled: true,
                active: true,
                addresses: [],
                peers: [],
              },
            ],
            filterUnit: null,
            filters: [],
          },
  });
}

/** One host apply on a server OpsCrew created. */
interface CloudApply {
  host: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/** The deploy user's host adapter on the servers OpsCrew created, by address. */
function cloudHosts(facts: Record<string, HostFacts>) {
  const applies: CloudApply[] = [];
  return {
    applies,
    adapter: {
      async inspect(remote: RemoteExec) {
        return facts[remote.host] ?? cloudFacts();
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ host: remote.host, plan, options });
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: plan.steps.filter((s) => s.state !== "change").map((s) => s.id),
        };
      },
    },
  };
}

/** A remote shell the fake host adapter stands in for. */
const shell = (host: string): RemoteExec => ({
  host,
  run: async () => {
    throw new Error("the fake host adapter should have handled this");
  },
});

/** The peers of a host plan's `network` step, by name. */
function peersOf(plan: HostPlan): { name: string; publicKey: string; endpoint?: string }[] {
  const params = plan.steps.find((s) => s.id === "network")?.params;
  return JSON.parse(String(params?.peers ?? "[]"));
}

/** A `network-filter` rule as its step keeps it: the port and the sources, sorted. */
function rule(port: number, sources: (string | undefined)[]): string {
  return `${port}=${[...sources].sort().join(",")}`;
}

/** The `network-filter` step's rules (`port=source,source …`). */
function rulesOf(plan: HostPlan): string {
  return String(plan.steps.find((s) => s.id === "network-filter")?.params.rules ?? "");
}

const DO_TARGET = {
  provider: "digitalocean",
  mode: "vps-compose",
  location: "fra1",
  serverType: "s-2vcpu-4gb",
  image: "ubuntu-24-04-x64",
  backups: false,
  edge: "caddy",
} as const;

const OWN_TARGET = {
  provider: "own",
  mode: "vps-compose",
  arch: "amd64",
  access: "public",
  edge: "caddy",
} as const;

/**
 * An app with Postgres on its Hetzner server `data` (or with monitoring on a server of its own),
 * at step `created` of a move of its app server to `to`, as the move's start recorded it: the new
 * member in the plan, the old one in `retarget.from.member`, both keys on this computer.
 */
async function moving(o: { to?: "cloud" | "own"; monitoring?: boolean; interactive?: boolean }) {
  const before = networked(o.monitoring === true ? monitoredPlan() : splitPlan());
  const network = before.plan.network;
  if (network === undefined) throw new Error("no network");
  const own = o.to === "own" ? { udpPortsInUse: [51820], wireguardInterfaces: [] } : undefined;
  const started = startNetwork(network, own);
  const plan = DeployPlanSchema.parse({
    ...before.plan,
    target: o.to === "own" ? OWN_TARGET : DO_TARGET,
    network: started.network,
    retarget: {
      from: { target: before.plan.target, deploy: before.plan.deploy, member: started.member },
      step: "created",
      startedAt: "2026-11-06T10:00:00.000Z",
    },
  });
  const handler = new ScriptedApprovalHandler();
  const deps = await createTestPhaseDeps({
    ...(o.to === "own" ? { runner: ownRunner() } : {}),
    approvalHandler: handler,
    interactive: o.interactive ?? true,
  });
  await recordGeneratedEntries(deps, "network", before.privateKeys);
  await recordMoveKey(deps, started.privateKey);
  const member = (name: string) => network.members.find((m) => m.name === name)?.publicKey;
  const facts: Record<string, HostFacts> = {
    [OLD_IP]: cloudFacts(member("app")),
    [DATA_IP]: cloudFacts(member("data")),
    [MONITORING_IP]: cloudFacts(member("monitoring")),
  };
  const hosts = cloudHosts(facts);
  const ownHost = new FakeHostServer(freshFacts());
  if (o.to === "own") {
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      hostKey: ED25519_FINGERPRINT,
    });
  }
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: OLD_IP },
    servers: {
      data: { ipv4: DATA_IP },
      ...(o.monitoring === true ? { monitoring: { ipv4: MONITORING_IP } } : {}),
    },
    retarget: { from: { ipv4: OLD_IP }, next: { ipv4: o.to === "own" ? OWN_IPV4 : NEW_IP } },
  }));
  const session = {
    deps,
    plan,
    services: {
      serverHost: hosts.adapter,
      remote: shell,
      own: { host: ownHost, homeDir: await mkdtemp(join(tmpdir(), "opscrew-own-home-")) },
    },
    deployKey: await ensureDeployKey(deps.paths, deps.redactor),
    servers: { from: { ipv4: OLD_IP }, next: { ipv4: o.to === "own" ? OWN_IPV4 : NEW_IP } },
    command: "opscrew retarget",
    approve: undefined,
  } as unknown as MoveSession;
  return { deps, plan, session, hosts, ownHost, handler, started, before };
}

/** The generated values' network keys on this computer. */
async function keys(deps: MoveSession["deps"]) {
  return (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.network ?? {};
}

describe("startNetwork: the move's start", () => {
  it("writes a new app member and keeps the old one for the move, a plan the schema accepts", async () => {
    const m = await moving({});
    const old = m.before.plan.network?.members.find((x) => x.name === "app");
    expect(m.plan.retarget?.from.member).toEqual(old);
    const fresh = m.plan.network?.members.find((x) => x.name === "app");
    expect(fresh?.address).not.toBe(old?.address);
    expect(fresh?.publicKey).not.toBe(old?.publicKey);
    expect(m.plan.network?.members.find((x) => x.name === "data")).toEqual(
      m.before.plan.network?.members.find((x) => x.name === "data"),
    );
    // The new key is `app`'s; the old app server's stays as previous until the move ends.
    expect(await keys(m.deps)).toEqual({
      app: m.started.privateKey,
      data: m.before.privateKeys.data,
      [PREVIOUS_MEMBER]: m.before.privateKeys.app,
    });
    expect(networkBeforeMove(m.plan)).toEqual(m.before.plan.network);
  });
});

describe("joinMoveNetwork: step created", () => {
  it("cloud to cloud: the new app server joins with its key; data adds it and keeps the old one", async () => {
    const m = await moving({});
    expect(await joinMoveNetwork(m.session)).toBeUndefined();
    const [fresh, data] = m.hosts.applies;
    expect(m.hosts.applies.map((a) => a.host)).toEqual([NEW_IP, DATA_IP]);
    const member = (name: string) => m.plan.network?.members.find((x) => x.name === name);
    const old = m.plan.retarget?.from.member;
    // The new server gets its private key on standard input; data holds its own already.
    expect(fresh?.options.secrets).toEqual({ wireguardKey: m.started.privateKey });
    expect(data?.options.secrets).toEqual({});
    expect(peersOf(fresh?.plan as HostPlan).map((p) => p.name)).toEqual(["data"]);
    expect(peersOf(data?.plan as HostPlan)).toEqual([
      expect.objectContaining({
        name: "app",
        publicKey: member("app")?.publicKey,
        endpoint: `${NEW_IP}:51820`,
      }),
      expect.objectContaining({
        name: PREVIOUS_MEMBER,
        publicKey: old?.publicKey,
        endpoint: `${OLD_IP}:51820`,
      }),
    ]);
    expect(rulesOf(data?.plan as HostPlan)).toBe(
      rule(5432, [member("app")?.address, old?.address]),
    );
    // Each plan was asked for by its own hash.
    expect(m.handler.requests.map((r) => r.planHash)).toEqual(
      m.hosts.applies.map((a) => hostPlanHash(a.plan)),
    );
  });

  it("cloud to own: the user's own new server joins on the port it leaves free", async () => {
    const m = await moving({ to: "own" });
    expect(await joinMoveNetwork(m.session)).toBeUndefined();
    const [own] = m.ownHost.applies;
    const step = own?.plan.steps.find((s) => s.id === "network");
    expect(step?.params.port).toBe(51821);
    expect(own?.options.secrets).toEqual({ wireguardKey: m.started.privateKey });
    const data = m.hosts.applies.find((a) => a.host === DATA_IP);
    expect(peersOf(data?.plan as HostPlan)).toEqual([
      expect.objectContaining({ name: "app", endpoint: `${OWN_IPV4}:51821` }),
      expect.objectContaining({ name: PREVIOUS_MEMBER, endpoint: `${OLD_IP}:51820` }),
    ]);
  });

  it("keeps monitoring on a server of its own: it adds the new app server, which may push to it", async () => {
    const m = await moving({ monitoring: true });
    await joinMoveNetwork(m.session);
    const monitoring = m.hosts.applies.find((a) => a.host === MONITORING_IP);
    const fresh = m.plan.network?.members.find((x) => x.name === "app")?.address;
    const old = m.plan.retarget?.from.member?.address;
    expect(peersOf(monitoring?.plan as HostPlan).map((p) => p.name)).toEqual([
      "app",
      "data",
      PREVIOUS_MEMBER,
    ]);
    const data = m.plan.network?.members.find((x) => x.name === "data")?.address;
    expect(rulesOf(monitoring?.plan as HostPlan)).toContain(
      rule(MONITORING_PUSH_PORT, [fresh, data, old]),
    );
  });

  it("in a script, stops at each server's plan with its hash and applies it once --approve names it", async () => {
    const m = await moving({ interactive: false });
    const first = await joinMoveNetwork(m.session);
    expect(first).toMatchObject({ done: false, pendingPlanHash: expect.any(String) });
    expect(m.hosts.applies).toEqual([]);
    m.session.approve = first?.pendingPlanHash;
    const second = await joinMoveNetwork(m.session);
    expect(m.hosts.applies.map((a) => a.host)).toEqual([NEW_IP]);
    expect(second?.pendingPlanHash).not.toBe(first?.pendingPlanHash);
  });
});

describe("--finish and --abort", () => {
  it("--finish: data drops the old app server; its key goes from this computer", async () => {
    const m = await moving({});
    expect(await leaveMoveNetwork(m.session)).toBeUndefined();
    expect(m.hosts.applies.map((a) => a.host)).toEqual([DATA_IP]);
    const data = m.hosts.applies[0]?.plan as HostPlan;
    const fresh = m.plan.network?.members.find((x) => x.name === "app");
    expect(peersOf(data)).toEqual([
      expect.objectContaining({ name: "app", publicKey: fresh?.publicKey }),
    ]);
    expect(rulesOf(data)).toBe(`5432=${fresh?.address}`);
    await endMoveKey(m.deps, "finished");
    expect(await keys(m.deps)).toEqual({
      app: m.started.privateKey,
      data: m.before.privateKeys.data,
    });
  });

  it("--abort: data links to the old app server as app again, without the new one", async () => {
    const m = await moving({});
    let committed = 0;
    expect(
      await undoMoveNetwork(m.session, async () => {
        committed++;
      }),
    ).toBeUndefined();
    expect(committed).toBe(1);
    const data = m.hosts.applies[0]?.plan as HostPlan;
    const old = m.plan.retarget?.from.member;
    expect(peersOf(data)).toEqual([
      expect.objectContaining({
        name: "app",
        publicKey: old?.publicKey,
        endpoint: `${OLD_IP}:51820`,
      }),
    ]);
    expect(rulesOf(data)).toBe(`5432=${old?.address}`);
    await endMoveKey(m.deps, "aborted");
    expect(await keys(m.deps)).toEqual(m.before.privateKeys);
  });

  it("never puts a private key in a plan, the audit log or what OpsCrew says", async () => {
    const m = await moving({ monitoring: true });
    await joinMoveNetwork(m.session);
    await leaveMoveNetwork(m.session);
    await undoMoveNetwork(m.session, async () => {});
    const secrets = [m.started.privateKey, ...Object.values(m.before.privateKeys)];
    const saved = await Promise.all(
      m.hosts.applies.map((a) =>
        readFile(join(m.deps.paths.files.plansDir, `host-${hostPlanHash(a.plan)}.json`), "utf8"),
      ),
    );
    const said = JSON.stringify((m.deps.reporter as MemoryReporter).lines);
    const text = [
      ...saved,
      ...m.hosts.applies.map((a) => JSON.stringify(a.plan)),
      JSON.stringify((m.deps.audit as MemoryAuditLog).entries),
      said,
      JSON.stringify(m.handler.requests),
      JSON.stringify(m.plan satisfies DeployPlan),
    ].join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

/** The harness's live Hetzner deployment with Postgres on an extra server `data`. */
async function splitHarness() {
  const h = await moveHarness();
  const { network: _none, ...base } = h.plan;
  const split = {
    ...base,
    servers: [
      {
        name: "data",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
      },
    ],
    services: base.services.map((s) => (s.name === "db" ? { ...s, server: "data" } : s)),
  } as Omit<DeployPlan, "network">;
  const { plan, privateKeys } = networked(split);
  await writeArtifact("plan", h.paths.files.plan, plan);
  await recordGeneratedEntries(h.deps, "network", privateKeys);
  await updateServerAddresses(h.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: DATA_IP } },
  }));
  return { h, plan, privateKeys };
}

describe.skipIf(!findExecutable("git"))("startMove: an app with an extra server", () => {
  it("moves only its app server: a new app member, the old one kept until --finish", async () => {
    const { h, plan, privateKeys } = await splitHarness();
    const session = await startMove(h.deps, plan, { services: h.services });
    const old = plan.network?.members.find((m) => m.name === "app");
    const saved = await readArtifact("plan", h.paths.files.plan);
    expect(saved.retarget?.from.member).toEqual(old);
    expect(saved.servers).toEqual(plan.servers);
    const fresh = saved.network?.members.find((m) => m.name === "app");
    expect(fresh?.address).not.toBe(old?.address);
    expect(session.plan.network).toEqual(saved.network);
    const kept = await keys(h.deps);
    expect(kept[PREVIOUS_MEMBER]).toBe(privateKeys.app);
    expect(kept.app).not.toBe(privateKeys.app);
    // The new key never reaches the plan or what OpsCrew says.
    expect(await readFile(h.paths.files.plan, "utf8")).not.toContain(kept.app as string);
    expect(h.reporter.text()).not.toContain(kept.app as string);
  });

  it("refuses a move to Portainer before any change: placement needs a server", async () => {
    const { h, plan } = await splitHarness();
    const before = await readFile(h.paths.files.plan, "utf8");
    const error = await startMove(h.deps, plan, { services: h.services, to: "portainer" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "shop runs services on other servers (data), which need a server, so it does not move to your Portainer. Nothing was changed.",
    });
    expect(await readFile(h.paths.files.plan, "utf8")).toBe(before);
  });
});
