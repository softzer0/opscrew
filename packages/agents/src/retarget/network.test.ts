/**
 * A move of an app with Postgres on an extra server (feature 023, US6, plan.md "7."): only its app
 * server moves, joining the private network as a new member; the old one leaves at `--finish`,
 * and `--abort` undoes it.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostFacts, type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { findExecutable, type MemoryAuditLog } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_PUSH_PORT,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { PREVIOUS_MEMBER } from "../network";
import { monitoredPlan, networked, senderPlan, splitPlan } from "../network/__fixtures__/plans";
import { monitoringOwner } from "../network/owner";
import { monitoringHostPlans } from "../provision/monitoring";
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
  OLD_IPV4,
  OWN_IPV4,
  ownRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import {
  endMoveKey,
  joinMoveNetwork,
  leaveMoveNetwork,
  moveMonitoring,
  networkBeforeMove,
  pointMonitoringAfterWindow,
  recordMoveKey,
  sideServer,
  startNetwork,
  undoMoveNetwork,
} from "./network";
import { appliesOf, cloudFacts, cloudHosts, peersOf } from "./network.fakes";
import { runRetarget } from "./run";
import type { MoveSession } from "./session";
import { startMove } from "./start";
import { deployStep, prepareStep, renameStep } from "./steps";
import type { RetargetServices } from "./types";

const OLD_IP = "203.0.113.10";
const NEW_IP = "198.51.100.10";
const DATA_IP = "203.0.113.20";
const MONITORING_IP = "203.0.113.30";

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
async function moving(o: {
  to?: "cloud" | "own";
  /**
   * Self-hosted monitoring on the app's server, on a server of its own, or (staging) on prod's
   * monitoring server.
   */
  monitoring?: "app" | "server" | "shared";
  interactive?: boolean;
}) {
  const shared = o.monitoring === "shared";
  const before = shared
    ? networked(senderPlan(), {
        monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
      })
    : networked(
        o.monitoring === undefined || o.monitoring === "shared"
          ? splitPlan()
          : monitoredPlan({ on: o.monitoring }),
      );
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
    ...(shared ? { environment: "staging" } : {}),
    approvalHandler: handler,
    interactive: o.interactive ?? true,
  });
  const owner = monitoringOwner(deps.paths, before.plan);
  if (owner !== undefined) {
    // Prod's plan and its monitoring server's address, beside staging's.
    await writeArtifact("plan", owner.paths.files.plan, networked(monitoredPlan()).plan);
    await updateServerAddresses(owner.paths, (current) => ({
      ...current,
      servers: { monitoring: { ipv4: MONITORING_IP } },
    }));
  }
  await recordGeneratedEntries(deps, "network", before.privateKeys);
  await recordMoveKey(deps, started.privateKey);
  const member = (name: string) => network.members.find((m) => m.name === name)?.publicKey;
  // Every server deployed: the edge and the app on the app servers, Postgres's app on data.
  const facts: Record<string, HostFacts> = {
    [OLD_IP]: cloudFacts({ publicKey: member("app"), projects: ["opscrew-edge", "shop"] }),
    [NEW_IP]: cloudFacts({ projects: ["opscrew-edge", "shop"] }),
    [DATA_IP]: cloudFacts({ publicKey: member("data"), projects: ["shop"] }),
    [MONITORING_IP]: cloudFacts({ publicKey: member("monitoring") }),
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
      ...(o.monitoring === "server" ? { monitoring: { ipv4: MONITORING_IP } } : {}),
    },
    retarget: { from: { ipv4: OLD_IP }, next: { ipv4: o.to === "own" ? OWN_IPV4 : NEW_IP } },
  }));
  const session = {
    deps,
    plan,
    services: {
      serverHost: hosts.adapter,
      remote: (host: string) => hosts.remote(host),
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
    const m = await moving({ monitoring: "server" });
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

  it("sending to another environment's monitoring server: that server adds the new app server too", async () => {
    const m = await moving({ monitoring: "shared" });
    await joinMoveNetwork(m.session);
    expect(m.hosts.applies.map((a) => a.host)).toEqual([NEW_IP, DATA_IP, MONITORING_IP]);
    const outside = m.hosts.applies.find((a) => a.host === MONITORING_IP)?.plan as HostPlan;
    // Staging's interface there, not prod's own.
    expect(outside.steps.find((s) => s.id === "network")?.params.interface).toBe("wg-opscrew1");
    expect(peersOf(outside)).toEqual([
      expect.objectContaining({ name: "app", endpoint: `${NEW_IP}:51820` }),
      expect.objectContaining({ name: "data" }),
      expect.objectContaining({ name: PREVIOUS_MEMBER, endpoint: `${OLD_IP}:51820` }),
    ]);
    const old = m.plan.retarget?.from.member?.address;
    expect(rulesOf(outside)).toContain(
      rule(MONITORING_PUSH_PORT, [addressOf(m.plan, APP_SERVER), addressOf(m.plan, "data"), old]),
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

/** The monitoring as provision set it up before the move, on the old app server and the others. */
async function provisioned(m: Awaited<ReturnType<typeof moving>>): Promise<void> {
  await monitoringHostPlans(m.deps, m.before.plan, {
    services: m.session.services,
    ownRun: undefined,
    extraOwn: [],
    planOnly: false,
    command: "opscrew provision",
    phase: "provision",
  });
  m.hosts.applies.length = 0;
  m.handler.requests.length = 0;
}

/** Runs `step` as a script would: again with `--approve` and each hash it stops with. */
async function approvingEach(
  m: Awaited<ReturnType<typeof moving>>,
  step: () => Promise<{ pendingPlanHash?: string } | undefined>,
): Promise<string[]> {
  const hashes: string[] = [];
  for (let stop = await step(); stop !== undefined; stop = await step()) {
    const hash = stop.pendingPlanHash as string;
    expect(hashes).not.toContain(hash);
    hashes.push(hash);
    m.session.approve = hash;
  }
  return hashes;
}

/** The address of `name` on the plan's network. */
const addressOf = (plan: DeployPlan, name: string) =>
  plan.network?.members.find((m) => m.name === name)?.address as string;

describe("self-hosted monitoring in a move", () => {
  it("on the app's server: the new app server gets the stack and Alloy, one plan per --approve; the others' Alloy follows after the window", async () => {
    const m = await moving({ monitoring: "app", interactive: false });
    await provisioned(m);
    const fresh = addressOf(m.plan, APP_SERVER);
    const old = m.plan.retarget?.from.member?.address as string;

    // Step deployed: the new app server only.
    const app = () => sideServer(m.session, "new");
    const deployed = await approvingEach(m, () =>
      moveMonitoring(m.session, m.plan, app, { servers: [APP_SERVER] }),
    );
    expect(deployed.length).toBeGreaterThan(0);
    expect(m.hosts.applies.map((a) => hostPlanHash(a.plan))).toEqual(deployed);
    expect(new Set(m.hosts.applies.map((a) => a.host))).toEqual(new Set([NEW_IP]));
    expect(appliesOf(m.hosts, "monitoring", NEW_IP)).toHaveLength(1);
    expect(appliesOf(m.hosts, "alloy", NEW_IP)).toHaveLength(1);

    // After the window: data's Alloy sends to the new stack; a run after that finds it as planned.
    m.hosts.applies.length = 0;
    const after = await approvingEach(m, () => pointMonitoringAfterWindow(m.session));
    expect(after).toHaveLength(1);
    const [alloy] = appliesOf(m.hosts, "alloy", DATA_IP);
    expect(JSON.stringify(alloy?.plan.steps)).toContain(fresh);
    expect(JSON.stringify(alloy?.plan.steps)).not.toContain(`${old}:`);
    expect(m.hosts.applies).toHaveLength(1);
    expect(await pointMonitoringAfterWindow(m.session)).toBeUndefined();
    expect(m.hosts.applies).toHaveLength(1);
  });

  it("on the app's server, from a side this computer has no deployment address for, still plans it", async () => {
    const m = await moving({ monitoring: "app", interactive: false });
    await updateServerAddresses(m.deps.paths, ({ deployment: _none, ...rest }) => rest);
    const stop = await moveMonitoring(m.session, m.plan, () => sideServer(m.session, "new"), {
      servers: [APP_SERVER],
    });
    expect(stop?.pendingPlanHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("on a server of its own: it stays as it is, and the new app server's Alloy sends to it", async () => {
    const m = await moving({ monitoring: "server" });
    await provisioned(m);
    await moveMonitoring(m.session, m.plan, () => sideServer(m.session, "new"), {
      servers: [APP_SERVER, "monitoring"],
    });
    expect(m.hosts.applies.map((a) => a.host)).toEqual([NEW_IP]);
    const [alloy] = appliesOf(m.hosts, "alloy", NEW_IP);
    expect(JSON.stringify(alloy?.plan.steps)).toContain(addressOf(m.plan, "monitoring"));
    // Nothing to point anywhere after the window: the stack did not move.
    expect(await pointMonitoringAfterWindow(m.session)).toBeUndefined();
    expect(m.hosts.applies).toHaveLength(1);
  });

  it("--abort points data's Alloy at the old app server's stack again", async () => {
    const m = await moving({ monitoring: "app" });
    await provisioned(m);
    await moveMonitoring(m.session, m.plan, () => sideServer(m.session, "new"), {
      servers: [APP_SERVER],
    });
    await pointMonitoringAfterWindow(m.session);
    m.hosts.applies.length = 0;
    let committed = 0;
    await undoMoveNetwork(m.session, async () => {
      committed++;
    });
    expect(committed).toBeGreaterThan(0);
    const old = m.plan.retarget?.from.member?.address as string;
    const [alloy] = appliesOf(m.hosts, "alloy", DATA_IP);
    expect(JSON.stringify(alloy?.plan.steps)).toContain(old);
    expect(JSON.stringify(alloy?.plan.steps)).not.toContain(addressOf(m.plan, APP_SERVER));
    // The old app server's stack and Alloy are as they were.
    expect(appliesOf(m.hosts, "monitoring", OLD_IP)).toEqual([]);
    expect(appliesOf(m.hosts, "alloy", OLD_IP)).toEqual([]);
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
    await endMoveKey(m.deps, m.plan.retarget as never, "finished");
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
    await endMoveKey(m.deps, m.plan.retarget as never, "aborted");
    expect(await keys(m.deps)).toEqual(m.before.privateKeys);
  });

  it("never puts a private key in a plan, the audit log or what OpsCrew says", async () => {
    const m = await moving({ monitoring: "server" });
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

/** {@link splitHarness} with the host adapter of the app's servers and data. */
async function splitMove() {
  const s = await splitHarness();
  const member = (name: string) => s.plan.network?.members.find((m) => m.name === name);
  const net = cloudHosts({
    [OLD_IPV4]: cloudFacts({ publicKey: member("app")?.publicKey }),
    [DATA_IP]: cloudFacts({ publicKey: member("data")?.publicKey }),
  });
  const services: RetargetServices = { ...s.h.services, serverHost: net.adapter };
  /** Data's host plans so far. */
  const data = () => net.applies.filter((a) => a.host === DATA_IP).map((a) => a.plan);
  return { ...s, net, services, data };
}

describe.skipIf(!findExecutable("git"))("a move of an app with Postgres on an extra server", () => {
  it("from Hetzner to DigitalOcean: data adds the new app server, and drops the old one at --finish", async () => {
    const m = await splitMove();
    const result = await runRetarget(m.h.deps, { services: m.services });
    expect(result).toMatchObject({ step: "switched" });
    const moving = await readArtifact("plan", m.h.paths.files.plan);
    const fresh = moving.network?.members.find((x) => x.name === APP_SERVER);
    const old = moving.retarget?.from.member;
    // The new server joined before its deploy; data links to both app servers.
    expect(net(m.net, m.h.newServer.ipv4)).toHaveLength(1);
    expect(peersOf(m.data().at(-1) as HostPlan).map((p) => [p.name, p.publicKey])).toEqual([
      [APP_SERVER, fresh?.publicKey],
      [PREVIOUS_MEMBER, old?.publicKey],
    ]);
    const started = await keys(m.h.deps);
    expect(started[PREVIOUS_MEMBER]).toBe(m.privateKeys.app);

    const finished = await finishRetarget(m.h.deps, {
      services: m.services,
      confirm: m.h.confirm,
    });
    expect(finished).toMatchObject({ step: "finished", done: true });
    expect(peersOf(m.data().at(-1) as HostPlan).map((p) => p.name)).toEqual([APP_SERVER]);
    expect(await keys(m.h.deps)).toEqual({ app: started.app, data: m.privateKeys.data });
    const final = await readArtifact("plan", m.h.paths.files.plan);
    expect(final.retarget).toBeUndefined();
    expect(final.network?.members.find((x) => x.name === APP_SERVER)).toEqual(fresh);
  });

  it("--abort after the deploy: data links to the old app server as app again", async () => {
    const m = await splitMove();
    const session = await startMove(m.h.deps, m.plan, { services: m.services });
    for (const step of [renameStep, (s: MoveSession) => prepareStep(s, {})]) {
      expect(await step(session)).toBeUndefined();
    }
    expect(await deployStep(session, {})).toBeUndefined();
    expect(peersOf(m.data().at(-1) as HostPlan).map((p) => p.name)).toEqual([
      APP_SERVER,
      PREVIOUS_MEMBER,
    ]);

    const aborted = await abortRetarget(m.h.deps, { services: m.services, confirm: m.h.confirm });
    expect(aborted).toMatchObject({ step: "aborted", done: true });
    const old = m.plan.network?.members.find((x) => x.name === APP_SERVER);
    expect(peersOf(m.data().at(-1) as HostPlan).map((p) => [p.name, p.publicKey])).toEqual([
      [APP_SERVER, old?.publicKey],
    ]);
    expect(await keys(m.h.deps)).toEqual(m.privateKeys);
    const restored = await readArtifact("plan", m.h.paths.files.plan);
    expect(restored.network).toEqual(m.plan.network);
  });
});

describe.skipIf(!findExecutable("git"))(
  "deployStep with self-hosted monitoring, in a script",
  () => {
    it("stops at the monitoring's host plan after the deploy, and the run with --approve does not deploy again", async () => {
      const h = await moveHarness();
      const plan = DeployPlanSchema.parse({
        ...h.plan,
        observability: monitoredPlan({ on: "app" }).observability,
      });
      await writeArtifact("plan", h.paths.files.plan, plan);
      const hosts = cloudHosts({
        [h.newServer.ipv4]: cloudFacts({ projects: ["opscrew-edge", "shop"] }),
      });
      // The servers' shells, but the monitoring login's check answers from the host adapter's state.
      const remote = (host: string): RemoteExec => {
        const login = hosts.remote(host);
        const server = h.hosts.remote(host);
        return {
          host,
          run: (command, options) =>
            (options?.input ?? "").includes("grant.check")
              ? login.run(command, options)
              : server.run(command, options),
        };
      };
      const services: RetargetServices = { ...h.services, serverHost: hosts.adapter, remote };
      const session = await startMove(h.deps, plan, { services });
      expect(await renameStep(session)).toBeUndefined();
      expect(await prepareStep(session, {})).toBeUndefined();
      h.deps.interactive = false;
      const dispatches = () => h.events.filter((e) => e.type === "dispatch").length;

      const first = await deployStep(session, {});
      expect(first?.pendingPlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dispatches()).toBe(1);
      expect(hosts.applies).toEqual([]);

      let stop = first;
      while (stop !== undefined) {
        session.approve = stop.pendingPlanHash;
        stop = await deployStep(session, {});
      }
      // One deploy only; every monitoring plan applied on the new app server, then step deployed.
      expect(dispatches()).toBe(1);
      expect(appliesOf(hosts, "monitoring", h.newServer.ipv4)).toHaveLength(1);
      expect(appliesOf(hosts, "alloy", h.newServer.ipv4)).toHaveLength(1);
      expect(session.plan.retarget?.step).toBe("deployed");

      // The window stops the monitoring stack on both sides with the services; after it the
      // monitoring is as planned, and the switch follows.
      h.deps.interactive = true;
      expect(await runRetarget(h.deps, { services })).toMatchObject({ step: "switched" });
      const ops = (ip: string) =>
        h.events.flatMap((e) => (e.type === "remote" && e.host === ip ? [e.op] : []));
      expect(ops(OLD_IPV4)).toContain("docker compose -p opscrew-monitoring stop -t 120");
      expect(ops(h.newServer.ipv4)).toContain("docker compose -p opscrew-monitoring start");
      expect(appliesOf(hosts, "alloy", h.newServer.ipv4)).toHaveLength(1);
    });
  },
);

/** The network host plans applied on `host`. */
const net = (hosts: ReturnType<typeof cloudHosts>, host: string) =>
  appliesOf(hosts, "network", host);
