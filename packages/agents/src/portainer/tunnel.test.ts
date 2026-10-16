import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyOptions, HostPlan } from "@opscrew/connector-ssh-host";
import { hostPlanHash } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { recordOwnServer } from "../shared";
import {
  BUSY_TUNNEL_LOG,
  deleteTunnelIn,
  fakeTunnelApi,
  ORIGIN_IP,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import { SERVER_GOES_FIRST } from "../shared/tunnel-connections";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  fakeZeroTrust,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  projectRunner,
  publicOutputs,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  TUNNEL_ID,
  testPlan,
} from "../testing";
import { pendingPortainerFile } from "./pending";
import { type PortainerServices, portainerDisable, portainerEnable } from "./run";
import { CLOUD_PORTAINER_DIR, CLOUD_TUNNEL_DIR, PORTAINER_VERSION } from "./settings";

const hasGit = findExecutable("git") !== undefined;
const SUBDOMAIN = { subdomain: "portainer", allowEmails: ["owner@example.com"] };
const tunnelCreate = [
  {
    address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
    type: "cloudflare_zero_trust_tunnel_cloudflared",
    name: "this",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create" as const,
  },
];

/**
 * Hetzner: Portainer on a subdomain is enabled (tunnel, Access, connector as the deploy user).
 * `events` lists approvals, host applies, polls and engine applies in order.
 */
async function cloudOnSubdomain(o: { closeAfter?: number; never?: boolean } = {}) {
  const events: string[] = [];
  const token = `eyJ${fakeSecret("cloudflare-token", "portainer-delete")}`;
  const engine = new FakeEngine({
    changes: tunnelCreate,
    outputs: { server_ipv4: SERVER_IPV4, tunnel_id: TUNNEL_ID, tunnel_token: token },
  });
  const project = await createProject(testPlan({ domain: "shop.example.com", deployed: true }));
  let answer = (_request: ApprovalRequest): boolean => true;
  const handler = new ScriptedApprovalHandler((request) => {
    events.push(`approve:${request.kind}`);
    return answer(request);
  });
  const apiToken = fakeSecret("cloudflare-token");
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: apiToken,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  let connector = false;
  const calls: { plan: HostPlan; options: ApplyOptions }[] = [];
  const services: PortainerServices = {
    deployRemote: (host: string): RemoteExec => ({
      host,
      run: async (command: string) =>
        command.startsWith("docker version")
          ? { exitCode: 0, stdout: "28.5.1\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "no such volume" },
    }),
    applyHost: async (_remote, plan, options) => {
      if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
      events.push("host");
      calls.push({ plan, options });
      const step = plan.steps.find((s) => s.id === "tunnel-connector");
      if (step !== undefined) connector = step.params.remove !== true;
      return { applied: plan.steps.map((s) => s.id), skipped: [] };
    },
    cloudflare: ownCloudflare(),
    engine: async () => engine,
    sleep: async () => undefined,
    zeroTrust: fakeZeroTrust("someone-else.cloudflareaccess.com", "pin-existing"),
  };
  await portainerEnable(deps, { ...SUBDOMAIN, services });
  expect(connector).toBe(true);
  // From now on the engine plans the removal of the tunnel, its record and Access.
  engine.scenario.changes = tunnelDeletes();
  engine.scenario.planJson = tunnelDeletePlanJson();
  events.length = 0;
  handler.requests.length = 0;
  const api = fakeTunnelApi({
    events,
    connectorRunning: () => connector,
    ...(o.closeAfter !== undefined ? { closeAfter: o.closeAfter } : {}),
    ...(o.never !== undefined ? { never: o.never } : {}),
  });
  deps.fetch = api.fetch;
  // Engine applies, in the event order.
  const apply = engine.apply.bind(engine);
  engine.apply = async (dir, planFile, approval) => {
    events.push("iac-apply");
    return apply(dir, planFile, approval);
  };
  return {
    ...project,
    deps,
    engine,
    handler,
    services,
    events,
    calls,
    api,
    apiToken,
    connector: () => connector,
    answer: (next: (request: ApprovalRequest) => boolean) => {
      answer = next;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const CONNECTOR_GONE =
  "The change on the server is applied (its Cloudflare Tunnel connector is removed); the Cloudflare Tunnel and Access for Portainer are still there.";
const CONNECTOR_GONE_OWN = CONNECTOR_GONE;

describe.skipIf(!hasGit)("portainer disable when the tunnel is deleted (Hetzner)", () => {
  it("approves both plans first, removes the connector, waits, then deletes the tunnel", async () => {
    const s = await cloudOnSubdomain({ closeAfter: 2 });
    const result = await portainerDisable(s.deps, { services: s.services });
    expect(s.events).toEqual([
      "approve:repo-write",
      "approve:iac-apply",
      "approve:host-apply",
      "host",
      "poll",
      "poll",
      "poll",
      "iac-apply",
    ]);
    expect(
      s.calls.at(-1)?.plan.steps.find((step) => step.id === "tunnel-connector")?.params,
    ).toMatchObject({
      remove: true,
    });
    expect(result).toMatchObject({ applied: true, hostApplied: true });
    expect(s.engine.applied.at(-1)?.approval.approvedPlanHash).toBe(result.planHash);
    // The infrastructure approval says the server's change comes first; the output reads in order.
    const iac = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(iac?.details).toContain(
      "The change on the server is shown next and applied first: Cloudflare deletes a tunnel only after its connector has stopped, so OpsCrew applies this plan after that.",
    );
    const text = s.deps.reporter.text();
    const goesFirst = text.indexOf(SERVER_GOES_FIRST);
    expect(goesFirst).toBeGreaterThan(text.indexOf("Applying the plan"));
    expect(goesFirst).toBeLessThan(text.lastIndexOf("Host plan"));
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.portainer).toBeUndefined();
    expect(plan.approvals.slice(-2).map((a) => a.kind)).toEqual(["iac-apply", "host-apply"]);
    expect(existsSync(pendingPortainerFile(s.deps.paths))).toBe(false);
    const printed = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
    expect(printed).not.toContain(ORIGIN_IP);
    expect(printed).not.toContain(s.apiToken);
  });

  it("connections that never close: stops before the deletion, says what is done, and a rerun finishes", async () => {
    const s = await cloudOnSubdomain({ never: true });
    const applied = s.engine.applied.length;
    const error = await failure(portainerDisable(s.deps, { services: s.services }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(
      `Cloudflare still reports active connections for the app's Cloudflare Tunnel after 3 minutes, so OpsCrew stopped before deleting it. Nothing in Cloudflare was deleted. ${CONNECTOR_GONE}`,
    );
    expect(error.message).toContain("The repository files were written (");
    expect(error.hint).toBe(
      "Run `opscrew portainer disable` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.",
    );
    expect(s.engine.applied).toHaveLength(applied);
    expect(s.events).not.toContain("iac-apply");
    // plan.yaml still describes Portainer on its subdomain; the change is pending.
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer?.access).toBe(
      "subdomain",
    );
    expect(existsSync(pendingPortainerFile(s.deps.paths))).toBe(true);

    s.events.length = 0;
    s.deps.fetch = fakeTunnelApi({ events: s.events, connectorRunning: () => false }).fetch;
    await portainerDisable(s.deps, { services: s.services });
    expect(s.events).toEqual([
      "approve:iac-apply",
      "approve:host-apply",
      "host",
      "poll",
      "iac-apply",
    ]);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();
  });

  it("turns Cloudflare's error 1022 during the apply into the plain message", async () => {
    const s = await cloudOnSubdomain();
    s.engine.scenario.applyOk = false;
    s.engine.scenario.applyLog = BUSY_TUNNEL_LOG;
    const error = await failure(portainerDisable(s.deps, { services: s.services }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(
      `Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. ${CONNECTOR_GONE}`,
    );
    expect(error.message).not.toContain("1022");
    expect(error.message).not.toContain("cfd_tunnel");
  });

  it("a refused host plan changes nothing anywhere", async () => {
    const s = await cloudOnSubdomain();
    s.answer((request) => request.kind !== "host-apply");
    const error = await failure(portainerDisable(s.deps, { services: s.services }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("The host plan was not approved.");
    expect(error.message).toContain("nothing in Cloudflare or on the server changed.");
    expect(s.events).toEqual(["approve:repo-write", "approve:iac-apply", "approve:host-apply"]);
    expect(s.connector()).toBe(true);
    // Both hashes to approve later, and the typed name the deletion needs.
    const [iac, host] = s.handler.requests.filter((r) => r.kind !== "repo-write");
    expect(error.hint).toBe(
      `Run \`opscrew portainer disable --approve ${iac?.planHash} --approve ${host?.planHash}\` when you are ready, typing shop to confirm: the change on the server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
    );
  });

  it("a refused host plan says once that nothing changed, after the files written", async () => {
    const s = await cloudOnSubdomain();
    s.answer((request) => request.kind !== "host-apply");
    const error = await failure(portainerDisable(s.deps, { services: s.services }));
    expect(error.message).toMatch(
      /^The host plan was not approved\. The repository files were written \([^)]+\); nothing in Cloudflare or on the server changed\.$/,
    );
    expect(error.message).not.toContain("Nothing on the server was changed");
  });

  it("--plan-only shows both plans; --approve with both hashes applies the host plan first", async () => {
    const s = await cloudOnSubdomain();
    const planned = await portainerDisable(s.deps, { planOnly: true, services: s.services });
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.deps.reporter.text()).toContain(
      `Approve both plans to apply them (\`opscrew portainer disable --approve ${planned.planHash} --approve ${planned.hostPlanHash}\`, typing shop to confirm): the change on the server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
    );
    expect(s.events).toEqual(["approve:repo-write"]);

    s.events.length = 0;
    s.handler.requests.length = 0;
    await portainerDisable(s.deps, {
      approvePlanHashes: [planned.planHash as string, planned.hostPlanHash as string],
      services: s.services,
    });
    // The saved plan's approval says the server's change comes first, too.
    expect(s.handler.requests[0]?.details).toContain("is shown next and applied first");
    expect(s.events).toEqual([
      "approve:iac-apply",
      "approve:host-apply",
      "host",
      "poll",
      "iac-apply",
    ]);
    expect(s.calls.at(-1)?.options.approvedHash).toBe(planned.hostPlanHash);
    expect(s.engine.applied.at(-1)?.approval.approvedPlanHash).toBe(planned.planHash);
  });

  it("no tunnel deleted (enable --subdomain): the infrastructure first, as before, and no polls", async () => {
    const events: string[] = [];
    const s = await cloudOnSubdomain();
    // Enabling again with the same subdomain creates nothing new; the order is the usual one.
    s.engine.scenario.changes = tunnelCreate;
    s.engine.scenario.planJson = undefined;
    s.events.length = 0;
    await portainerEnable(s.deps, { ...SUBDOMAIN, services: s.services });
    events.push(...s.events);
    expect(events).toEqual(["approve:iac-apply", "iac-apply", "approve:host-apply", "host"]);
    expect(s.handler.requests.find((r) => r.kind === "iac-apply")?.details).not.toContain(
      "applied first",
    );
    expect(s.deps.reporter.text()).not.toContain(SERVER_GOES_FIRST);
  });

  it("opscrew provision with a plan that no longer has the subdomain removes the connector first", async () => {
    const s = await cloudOnSubdomain();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...plan,
      portainer: { enabled: true, version: PORTAINER_VERSION, access: "local" },
    });
    s.handler.requests.length = 0;
    await runProvision(s.deps, {
      services: { ...s.services, ...cloudProvisionServices() },
      push: false,
      secrets: false,
    });
    const order = s.events.filter((e) =>
      ["approve:iac-apply", "approve:host-apply", "host", "poll", "iac-apply"].includes(e),
    );
    expect(order).toEqual(["approve:iac-apply", "approve:host-apply", "host", "poll", "iac-apply"]);
    const removal = s.calls.at(-1)?.plan;
    expect(removal?.steps.map((step) => step.id)).toEqual(["tunnel-connector", "portainer"]);
    expect(removal?.steps[0]?.params).toMatchObject({ remove: true, dir: CLOUD_TUNNEL_DIR });
    expect(removal?.steps[1]?.params).toMatchObject({ dir: CLOUD_PORTAINER_DIR, runAs: "login" });
    expect(s.connector()).toBe(false);
    const iac = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(iac?.details).toContain("The change on the server is shown next and applied first");
    const recorded = await readArtifact("plan", s.deps.paths.files.plan);
    expect(recorded.approvals.slice(-2).map((a) => a.kind)).toEqual(["iac-apply", "host-apply"]);
  });
});

/** What `opscrew provision` needs on Hetzner besides the Portainer fakes. */
function cloudProvisionServices(): ProvisionServices {
  return {
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github: new FakeGitHub(),
    tcpConnect: async () => true,
    remote: readyRemote,
  };
}

/** An own server in public mode with Portainer on a subdomain (the tunnel serves only Portainer). */
async function ownOnSubdomain(o: { never?: boolean } = {}) {
  const events: string[] = [];
  const project = await createProject(ownPlan());
  const engine = new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  let deleting = false;
  deleteTunnelIn(engine, events, (options) => deleting && options?.destroy !== true);
  const host = new FakeHostServer(freshFacts());
  let answer = (_request: ApprovalRequest): boolean => true;
  const handler = new ScriptedApprovalHandler((request) => {
    events.push(`approve:${request.kind}`);
    return answer(request);
  });
  const home = await mkdtemp(join(tmpdir(), "opscrew-portainer-tunnel-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token", "own-portainer"),
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
  });
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  const adapter = {
    inspect: (remote: RemoteExec) => host.inspect(remote),
    apply: async (remote: RemoteExec, plan: HostPlan, options: ApplyOptions) => {
      events.push("host");
      return host.apply(remote, plan, options);
    },
  };
  const services: ProvisionServices & PortainerServices = {
    engine: async () => engine,
    github: new FakeGitHub(),
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host: adapter, homeDir: home },
    zeroTrust: fakeZeroTrust(),
  };
  await runProvision(deps, { services, hostKey: ED25519_FINGERPRINT });
  engine.changes = tunnelCreate;
  engine.nextOutputs = {
    ...publicOutputs(),
    tunnel_id: TUNNEL_ID,
    tunnel_token: `eyJ${fakeSecret("cloudflare-token", "own-portainer-tunnel")}`,
  };
  await portainerEnable(deps, { ...SUBDOMAIN, services });
  expect(host.facts.tunnel.running).toBe(true);
  deleting = true;
  events.length = 0;
  deps.fetch = fakeTunnelApi({
    events,
    connectorRunning: () => host.facts.tunnel.running,
    ...(o.never !== undefined ? { never: o.never } : {}),
  }).fetch;
  handler.requests.length = 0;
  return {
    deps,
    engine,
    host,
    events,
    services,
    handler,
    answer: (next: (request: ApprovalRequest) => boolean) => {
      answer = next;
    },
  };
}

describe.skipIf(!hasGit)(
  "portainer disable on a server the user owns, when the tunnel is deleted",
  () => {
    it("the host plan removes the connector first; the tunnel goes once its connections closed", async () => {
      const s = await ownOnSubdomain();
      const result = await portainerDisable(s.deps, { services: s.services });
      expect(s.events).toEqual([
        "approve:repo-write",
        "approve:iac-apply",
        "approve:host-apply",
        "host",
        "poll",
        "iac-apply",
      ]);
      expect(s.host.facts.tunnel.running).toBe(false);
      expect(result).toMatchObject({ applied: true, hostApplied: true });
      expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();
      expect(s.deps.reporter.text()).not.toContain(ORIGIN_IP);
    });

    it("never closing: stops before the deletion; the rerun finds the server done and deletes the tunnel", async () => {
      const s = await ownOnSubdomain({ never: true });
      const error = await failure(portainerDisable(s.deps, { services: s.services }));
      expect(error.message).toContain("Nothing in Cloudflare was deleted.");
      expect(error.message).toContain(CONNECTOR_GONE);
      expect(s.events).not.toContain("iac-apply");

      s.events.length = 0;
      s.deps.fetch = fakeTunnelApi({ events: s.events, connectorRunning: () => false }).fetch;
      await portainerDisable(s.deps, { services: s.services });
      // The server already has the change: its host plan changes nothing and needs no approval.
      expect(s.events).toEqual(["approve:iac-apply", "poll", "iac-apply"]);
      expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();
    });

    it("a rerun that times out again still says the connector is gone", async () => {
      const s = await ownOnSubdomain({ never: true });
      await failure(portainerDisable(s.deps, { services: s.services }));
      s.events.length = 0;
      const again = await failure(portainerDisable(s.deps, { services: s.services }));
      // Nothing left to change on the server in this run, yet its change is done.
      expect(s.events.filter((e) => e === "host")).toEqual([]);
      expect(again.message).toContain(`Nothing in Cloudflare was deleted. ${CONNECTOR_GONE_OWN}`);
    });

    it("opscrew provision with a plan that no longer has the subdomain removes the connector first", async () => {
      const s = await ownOnSubdomain();
      // plan.yaml no longer has Portainer (the fake server does not model Portainer's state).
      const { portainer: _portainer, ...plan } = await readArtifact(
        "plan",
        s.deps.paths.files.plan,
      );
      await writeArtifact("plan", s.deps.paths.files.plan, plan);
      await runProvision(s.deps, { services: s.services, push: false, secrets: false });
      const order = s.events.filter((e) =>
        ["approve:iac-apply", "approve:host-apply", "host", "poll", "iac-apply"].includes(e),
      );
      // The final host plan finds the server prepared: one host apply, before the deletion.
      expect(order).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host",
        "poll",
        "iac-apply",
      ]);
      expect(s.host.facts.tunnel.running).toBe(false);
      expect(s.deps.reporter.text()).toContain(SERVER_GOES_FIRST);
    });

    it("a refused host plan in opscrew provision names both hashes and the typed name", async () => {
      const s = await ownOnSubdomain();
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        portainer: { enabled: true, version: PORTAINER_VERSION, access: "local" },
      });
      s.answer((request) => request.kind !== "host-apply");
      const error = await failure(
        runProvision(s.deps, { services: s.services, push: false, secrets: false }),
      );
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toBe(
        "The host plan was not approved. Nothing on your server was changed and nothing in Cloudflare was deleted.",
      );
      const iac = s.handler.requests.find((r) => r.kind === "iac-apply");
      const host = s.handler.requests.find((r) => r.kind === "host-apply");
      expect(error.hint).toBe(
        `Run \`opscrew provision --approve ${iac?.planHash} --approve ${host?.planHash}\` when you are ready, typing shop to confirm: the change on your server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
      );
      expect(s.host.facts.tunnel.running).toBe(true);
    });
  },
);
