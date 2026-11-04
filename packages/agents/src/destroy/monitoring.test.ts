/** `opscrew destroy` with self-hosted monitoring (feature 020, US5 #4, US7 #2–#3). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_PUSH_PORT,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownProject, provisionOwn } from "../drift/__fixtures__/own-project";
import { allocateNetwork, type NetworkHostFacts } from "../network";
import { monitoredPlan, senderPlan, withNetwork } from "../network/__fixtures__/plans";
import { monitoringValues } from "../provision/secrets";
import { ensureStatePassphrase } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { updateServerAddresses } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  DEPLOYED_AT,
  deployedResources,
  FakeDestroyGitHub,
  FakeServers,
  fakeCloudflare,
  freshFacts,
  HOST_KEY,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_ADDRESS,
  SERVER_IPV4,
  serverAttributes,
  testKeyMaker,
} from "../testing";
import { runDestroy } from "./run";
import type { DestroyPreview, DestroyServices } from "./types";

const DATA_IPV4 = "203.0.113.30";
const MONITORING_IPV4 = "203.0.113.40";
const MONITORING_ADDRESS = "module.server_monitoring.hcloud_server.this";
const HCLOUD = fakeSecret("hcloud-token");

/** `plan` deployed, on its private network (`facts`: the servers' it shares). */
function deployed(
  plan: Omit<DeployPlan, "network">,
  facts: Record<string, NetworkHostFacts> = {},
): DeployPlan {
  const { network } = allocateNetwork(plan, facts, testKeyMaker(plan.app.name));
  return DeployPlanSchema.parse({
    ...withNetwork(plan, network),
    deployment: {
      ...plan.deployment,
      lastPlanHash: "a".repeat(64),
      lastApplyAt: DEPLOYED_AT,
      firstDeployAt: DEPLOYED_AT,
      placement: { db: "data" },
    },
  });
}

/** Prod: the owner of the repository's monitoring server. */
const ownerPlan = () => deployed(monitoredPlan());

/** Staging: sends to prod's monitoring server, on its interface `wg-opscrew1` there. */
function stagingPlan(o: { deployed?: boolean } = {}): DeployPlan {
  const base = senderPlan();
  const plan = deployed(
    {
      ...base,
      infra: { ...base.infra, dir: "opscrew/infra/staging" },
      cicd: { ...base.cicd, workflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
    },
    { monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] } },
  );
  if (o.deployed !== false) return plan;
  const { lastPlanHash: _h, lastApplyAt: _a, firstDeployAt: _f, ...rest } = plan.deployment;
  return { ...plan, deployment: rest };
}

/** A resource of the destroy plan. */
function resource(address: string, type: string) {
  return {
    address,
    type,
    name: "this",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action: "delete" as const,
  };
}

/** The destroy plan's resources: the app's server, then each extra server's firewall and server. */
function resources(extras: readonly string[]) {
  return [
    ...deployedResources(),
    ...extras.flatMap((name) => [
      resource(`module.server_${name}.hcloud_firewall.this`, "hcloud_firewall"),
      resource(`module.server_${name}.hcloud_server.this`, "hcloud_server"),
    ]),
  ];
}

/** The protection-lifting plan of the Hetzner servers at `addresses`. */
function unprotect(addresses: readonly string[]) {
  const change = (address: string) => ({
    address,
    mode: "managed",
    type: "hcloud_server",
    change: {
      actions: ["update"],
      before: serverAttributes(),
      after: serverAttributes({ delete_protection: false, rebuild_protection: false }),
      after_unknown: {},
    },
  });
  return {
    changes: addresses.map((address) => ({
      ...resource(address, "hcloud_server"),
      action: "update" as const,
    })),
    planJson: { format_version: "1.2", resource_changes: addresses.map(change) },
  };
}

/** One host apply on a server OpsCrew created. */
interface HostApply {
  host: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/** The deploy user's host adapter on the servers OpsCrew created, by address; `events` in order. */
function cloudHosts(facts: Record<string, HostFacts>, events: string[]) {
  const applies: HostApply[] = [];
  return {
    applies,
    remote: (host: string): RemoteExec => readyRemote(host),
    adapter: {
      async inspect(remote: RemoteExec) {
        return (
          facts[remote.host] ??
          HostFactsSchema.parse(freshFacts({ user: "deploy", privilege: "docker" }))
        );
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ host: remote.host, plan, options });
        events.push(`host:${plan.steps.map((step) => step.id).join(",")}`);
        return { applied: plan.steps.map((s) => s.id), skipped: [] };
      },
    },
  };
}

interface Setup {
  /** The plan destroyed: prod's, or `environment`'s. */
  plan: DeployPlan;
  environment?: string;
  /** Prod's plan when another environment is destroyed. */
  owner?: DeployPlan;
  /** The repository's other environments' plans, by name. */
  others?: Record<string, DeployPlan>;
  extras: readonly string[];
  answer?: (request: ApprovalRequest) => boolean;
}

/** A project with the plans, this computer's records of prod's servers, and the fakes. */
async function setup(o: Setup) {
  const project = await createProject(o.owner ?? o.plan);
  const events: string[] = [];
  const engine = new ScriptedDestroyEngine(
    {
      resources: resources(o.extras),
      unprotect: unprotect([
        SERVER_ADDRESS,
        ...o.extras.map((name) => `module.server_${name}.hcloud_server.this`),
      ]),
    },
    events,
  );
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const env = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    CLOUDFLARE_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };
  // Prod's provision left its servers' addresses and Grafana's password on this computer.
  const prod = await createTestPhaseDeps({ root: project.root, env });
  await updateServerAddresses(prod.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: DATA_IPV4 }, monitoring: { ipv4: MONITORING_IPV4 } },
  }));
  const grafana = fakeSecret("generic-password", "grafana-admin").replace(/[^A-Za-z0-9]/g, "");
  await mkdir(dirname(generatedValuesFile(prod)), { recursive: true });
  await writeFile(
    generatedValuesFile(prod),
    JSON.stringify({ monitoring: { grafanaAdminPassword: grafana } }),
  );
  for (const [environment, plan] of Object.entries(o.others ?? {})) {
    const other = await createTestPhaseDeps({ root: project.root, env, environment });
    await writeArtifact("plan", other.paths.files.plan, plan);
  }
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  if (o.environment !== undefined) await writeArtifact("plan", deps.paths.files.plan, o.plan);
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  await ensureStatePassphrase(deps.paths);
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), '{"version":4}\n');
  await mkdir(join(project.root, o.plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  // The monitoring server holds prod's network on wg-opscrew0 and staging's on wg-opscrew1.
  const hosts = cloudHosts(
    {
      [MONITORING_IPV4]: HostFactsSchema.parse({
        ...freshFacts({ user: "deploy", privilege: "docker" }),
        wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
        udpPortsInUse: [51820, 51821],
      }),
    },
    events,
  );
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers(),
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(),
    sleep: async () => undefined,
    remote: (host) => hosts.remote(host),
    serverHost: hosts.adapter,
  };
  return { ...project, deps, engine, events, handler, hosts, services, grafana };
}

type Setup2 = Awaited<ReturnType<typeof setup>>;

/**
 * This computer's record of the environment's interface `wg-opscrew1` on the monitoring server of
 * `plan` (prod's by default), beside its other generated values.
 */
async function keepOwner(s: Pick<Setup2, "deps">, plan = "opscrew/plan.yaml") {
  const file = generatedValuesFile(s.deps);
  await mkdir(dirname(file), { recursive: true });
  const generated = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  await writeFile(
    file,
    JSON.stringify({
      ...generated,
      monitoring: { owner: { plan, server: "monitoring", interface: "wg-opscrew1" } },
    }),
  );
}

/** The approvals, the audit log, and the output's lines about the monitoring. */
function shown(s: Setup2): string {
  const monitoring = s.deps.reporter
    .text()
    .split("\n")
    .filter((line) => /monitoring|Grafana|Alloy|network/.test(line));
  return [
    JSON.stringify(s.handler.requests),
    JSON.stringify(s.deps.audit.entries),
    ...monitoring,
  ].join("\n");
}

const skipNoGit = !findExecutable("git");

describe.skipIf(skipNoGit)("destroy of the environment that owns the monitoring server", () => {
  it("refuses before any change while another environment sends to it, naming it", async () => {
    const s = await setup({
      plan: ownerPlan(),
      others: { staging: stagingPlan() },
      extras: ["data", "monitoring"],
    });
    const asked: DestroyPreview[] = [];

    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Other environments send their figures and logs to this environment's monitoring server: opscrew/environments/staging/plan.yaml. Deleting it would leave them sending nowhere. Nothing was changed.",
      hint: "Turn monitoring off there first (`opscrew addon disable monitoring --env staging`, each followed by `opscrew provision` with the same options), then run `opscrew destroy --env prod` again.",
    });
    // Nothing was asked, planned or reached.
    expect(asked).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(s.hosts.applies).toEqual([]);
  });

  it("deletes the monitoring server with the rest, after its own typed name, when no deployed environment sends to it", async () => {
    // Staging names prod's server, but was never deployed: nothing of it is there.
    const s = await setup({
      plan: ownerPlan(),
      others: { staging: stagingPlan({ deployed: false }) },
      extras: ["data", "monitoring"],
    });
    const asked: DestroyPreview[] = [];

    await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(asked.map((p) => [p.name, p.server])).toEqual([
      ["shop", undefined],
      ["shop-data", "data"],
      ["shop-monitoring", "monitoring"],
    ]);
    expect(asked[0]?.servers).toContain(
      "Server monitoring: the Hetzner Cloud server shop-monitoring is deleted; OpsCrew takes no snapshot of it.",
    );
    const destroy = s.handler.requests.find((r) => r.title.startsWith("Delete shop"));
    expect(destroy).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(destroy?.details).toContain(MONITORING_ADDRESS);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    // The stack and Alloy go with the servers: no host plan reaches any of them.
    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toEqual([]);
    expect(s.hosts.applies).toEqual([]);
    expect(shown(s)).not.toContain(s.grafana);
  });
});

describe.skipIf(skipNoGit)("destroy of an environment that sends to the monitoring server", () => {
  /** Staging, destroyed with prod's plan in the repository. */
  async function sender(answer?: (request: ApprovalRequest) => boolean) {
    const s = await setup({
      plan: stagingPlan(),
      environment: "staging",
      owner: ownerPlan(),
      extras: ["data"],
      ...(answer === undefined ? {} : { answer }),
    });
    await keepOwner(s);
    return s;
  }

  it("leaves the monitoring server over its owner's login, each change by its hash, before its own servers go", async () => {
    const s = await sender();
    const asked: DestroyPreview[] = [];

    await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    // After the typed names: prod's stack without staging's network, then staging's interface
    // and filter there; then the infrastructure, which deletes staging's servers with their Alloy.
    expect(asked.map((p) => p.name)).toEqual(["shop-staging", "shop-staging-data"]);
    expect(
      s.hosts.applies.map((a) => [a.host, a.plan.app, a.plan.steps.map((step) => step.id)]),
    ).toEqual([
      [MONITORING_IPV4, "shop", ["monitoring"]],
      [MONITORING_IPV4, "shop-staging", ["network-filter", "network"]],
    ]);
    expect(s.events.filter((e) => e.startsWith("host:") || e.startsWith("apply:"))).toEqual([
      "host:monitoring",
      "host:network-filter,network",
      "apply:unprotect",
      "apply:destroy",
    ]);
    const hostApprovals = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(hostApprovals.map((r) => r.title)).toEqual([
      "Stop receiving this environment's figures and logs on the monitoring stack of server monitoring of opscrew/plan.yaml",
      "Take server monitoring of opscrew/plan.yaml off this environment's private network",
    ]);
    expect(s.hosts.applies.map((a) => hostPlanHash(a.plan))).toEqual(
      hostApprovals.map((r) => r.planHash),
    );
    // The stack keeps prod's network only, with prod's Grafana password on apply.
    const [stack, removal] = s.hosts.applies;
    const compose = String(stack?.plan.steps[0]?.params["file:compose.yaml"]);
    const ownerAddress = ownerPlan().network?.members.find((m) => m.name === "monitoring")?.address;
    const outside = stagingPlan().network?.members.find((m) => m.name === "monitoring")?.address;
    expect(compose).toContain(`${ownerAddress}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`);
    expect(compose).not.toContain(`${outside}:`);
    expect(stack?.options.secrets).toEqual({ grafanaAdminPassword: s.grafana });
    expect(removal?.plan.steps[1]?.params).toMatchObject({
      interface: "wg-opscrew1",
      remove: true,
    });
    // This computer no longer records an interface there, and says how to join again.
    expect((await monitoringValues(s.deps))?.owner).toBeUndefined();
    expect(s.deps.reporter.text()).toContain(
      "This environment no longer sends to server monitoring of opscrew/plan.yaml; `opscrew provision --env staging` adds it again if you stop here.",
    );
    // No password or public address in the approvals, the audit log or what is said about it.
    const text = shown(s);
    expect(text).not.toContain(s.grafana);
    expect(text).not.toContain(MONITORING_IPV4);
  });

  it("deletes nothing when leaving the monitoring server is not approved", async () => {
    const s = await sender((request) => request.kind !== "host-apply");

    const error = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async () => true,
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(s.hosts.applies).toEqual([]);
    expect(s.engine.applied).toEqual([]);
    // Staging's interface there stays recorded, so a later run leaves it.
    expect((await monitoringValues(s.deps))?.owner?.interface).toBe("wg-opscrew1");
  });

  it("reaches no other server when this computer recorded no interface there", async () => {
    const s = await setup({
      plan: stagingPlan(),
      environment: "staging",
      owner: ownerPlan(),
      extras: ["data"],
    });

    await runDestroy(s.deps, { services: s.services, snapshot: false, confirm: async () => true });

    expect(s.hosts.applies).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
  });

  it("reaches no other server when the owner's deployment was torn down, and forgets its interface there", async () => {
    const owner = ownerPlan();
    const s = await setup({
      plan: stagingPlan(),
      environment: "staging",
      owner: { ...owner, deployment: { ...owner.deployment, destroyedAt: DEPLOYED_AT } },
      extras: ["data"],
    });
    await keepOwner(s);

    await runDestroy(s.deps, { services: s.services, snapshot: false, confirm: async () => true });

    expect(s.hosts.applies).toEqual([]);
    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    expect((await monitoringValues(s.deps))?.owner).toBeUndefined();
    expect(s.deps.reporter.text()).not.toContain("no longer sends to");
  });
});

describe.skipIf(skipNoGit)("destroy of a sender on the user's own server", () => {
  /** The qa environment: the owner of a monitoring server OpsCrew created. */
  const QA_PLAN = "opscrew/environments/qa/plan.yaml";

  /**
   * Prod on the user's own server, provisioned, sending to qa's monitoring server on its
   * interface `wg-opscrew1` there, with Alloy this app turned on.
   */
  async function ownSender() {
    let answer: (request: ApprovalRequest) => boolean = () => true;
    const s = await ownProject({ answer: (request) => answer(request) });
    await provisionOwn(s);
    // qa's plan, its servers' addresses and Grafana's password on this computer.
    const base = monitoredPlan();
    const qaPlan = deployed({
      ...base,
      app: { ...base.app, name: "shop-qa" },
      environment: { name: "qa", deploySource: { from: "main" }, runner: "github" },
      infra: { ...base.infra, dir: "opscrew/infra/qa" },
      cicd: { ...base.cicd, workflowPath: ".github/workflows/opscrew-deploy-qa.yml" },
    });
    const qa = await createTestPhaseDeps({
      root: s.root,
      env: { OPSCREW_HOME: join(s.root, ".home-opscrew") },
      environment: "qa",
    });
    await writeArtifact("plan", qa.paths.files.plan, qaPlan);
    await updateServerAddresses(qa.paths, (current) => ({
      ...current,
      servers: { monitoring: { ipv4: MONITORING_IPV4 } },
    }));
    const grafana = fakeSecret("generic-password", "qa-grafana").replace(/[^A-Za-z0-9]/g, "");
    await mkdir(dirname(generatedValuesFile(qa)), { recursive: true });
    await writeFile(
      generatedValuesFile(qa),
      JSON.stringify({ monitoring: { grafanaAdminPassword: grafana } }),
    );
    // Prod sends to qa's server, which is its network's outside member.
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    const sender = {
      ...plan,
      observability: {
        ...plan.observability,
        monitoring: {
          ...senderPlan().observability?.monitoring,
          where: { kind: "shared", owner: { plan: QA_PLAN, server: "monitoring" } },
        },
      },
    } as Omit<DeployPlan, "network">;
    const { network } = allocateNetwork(
      sender,
      {
        app: { udpPortsInUse: [], wireguardInterfaces: [] },
        monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
      },
      testKeyMaker("shop"),
    );
    await writeArtifact("plan", s.deps.paths.files.plan, withNetwork(sender, network));
    await keepOwner(s, QA_PLAN);
    const installed = {
      installed: true,
      composeSha256: "b".repeat(64),
      running: true,
      secretFile: false,
      dataVolume: false,
      tunnelId: null,
    };
    const facts = structuredClone(s.host.facts);
    facts.addons = { ...facts.addons, alloy: installed };
    facts.alloy = { destinations: ["monitoring"], files: {} };
    if (facts.record !== null) facts.record.addons = { alloy: "shop" };
    s.host.facts = HostFactsSchema.parse(facts);
    const hosts = cloudHosts(
      {
        [MONITORING_IPV4]: HostFactsSchema.parse({
          ...freshFacts({ user: "deploy", privilege: "docker" }),
          wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
          udpPortsInUse: [51820, 51821],
        }),
      },
      [],
    );
    const services: DestroyServices = {
      engine: s.services.engine,
      github: s.github,
      cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
      ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
      ...(s.services.own !== undefined ? { own: s.services.own } : {}),
      remote: (host) => hosts.remote(host),
      serverHost: hosts.adapter,
    };
    return Object.assign(s, {
      hosts,
      services,
      grafana,
      answer: (next: typeof answer) => {
        answer = next;
      },
    });
  }

  it("leaves qa's monitoring server before the teardown, which removes its Alloy", async () => {
    const s = await ownSender();
    const before = s.host.applies.length;

    await runDestroy(s.deps, { services: s.services, confirm: async () => true });

    // qa's stack without prod's network, then prod's interface and filter there.
    expect(
      s.hosts.applies.map((a) => [a.host, a.plan.app, a.plan.steps.map((step) => step.id)]),
    ).toEqual([
      [MONITORING_IPV4, "shop-qa", ["monitoring"]],
      [MONITORING_IPV4, "shop", ["network-filter", "network"]],
    ]);
    expect(s.hosts.applies[0]?.options.secrets).toEqual({ grafanaAdminPassword: s.grafana });
    // Each approved by its hash, before the teardown host plan.
    const hostApprovals = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(hostApprovals.slice(0, 2).map((r) => r.planHash)).toEqual(
      s.hosts.applies.map((a) => hostPlanHash(a.plan)),
    );
    expect(hostApprovals[2]?.title).toMatch(/^Remove shop from your server/);
    const teardown = s.host.applies.slice(before);
    expect(teardown.map((a) => a.plan.purpose)).toEqual(["teardown"]);
    expect(teardown[0]?.plan.steps.find((step) => step.id === "alloy")?.params.remove).toBe(true);
    expect(hostApprovals[2]?.planHash).toBe(hostPlanHash(teardown[0]?.plan as HostPlan));
    expect((await monitoringValues(s.deps))?.owner).toBeUndefined();
    expect(s.deps.reporter.text()).toContain(
      `This environment no longer sends to server monitoring of ${QA_PLAN};`,
    );
    const text = `${JSON.stringify(s.handler.requests)}\n${JSON.stringify(s.deps.audit.entries)}`;
    expect(text).not.toContain(s.grafana);
    expect(text).not.toContain(MONITORING_IPV4);
  });

  it("applies no teardown when leaving is refused, and keeps the interface recorded", async () => {
    const s = await ownSender();
    s.answer((request) => !request.title.startsWith("Stop receiving"));
    const before = s.host.applies.length;

    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async () => true,
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(s.hosts.applies).toEqual([]);
    expect(s.host.applies.slice(before)).toEqual([]);
    expect((await monitoringValues(s.deps))?.owner?.interface).toBe("wg-opscrew1");
  });
});

describe.skipIf(skipNoGit)("destroy of a plan without monitoring", () => {
  it("reads no other environment and reaches no monitoring server", async () => {
    const { observability, ...base } = ownerPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      servers: base.servers?.filter((server) => server.name !== "monitoring"),
      network: {
        ...base.network,
        members: base.network?.members.filter((m) => m.name !== "monitoring"),
      },
      observability: { ...observability, monitoring: undefined },
    });
    const s = await setup({ plan, others: { staging: stagingPlan() }, extras: ["data"] });

    await runDestroy(s.deps, { services: s.services, snapshot: false, confirm: async () => true });

    expect(s.hosts.applies).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
  });
});

describe.skipIf(skipNoGit)(
  "destroy on the user's own server with the monitoring stack on it",
  () => {
    /** The app's own server, provisioned, running Alloy and the stack this app turned on. */
    async function ownWithStack() {
      const s = await ownProject();
      await provisionOwn(s);
      const installed = {
        installed: true,
        composeSha256: "b".repeat(64),
        running: true,
        secretFile: false,
        dataVolume: true,
        tunnelId: null,
      };
      const facts = structuredClone(s.host.facts);
      facts.addons = { ...facts.addons, alloy: installed, monitoring: installed };
      facts.alloy = { destinations: ["monitoring"], files: {} };
      facts.monitoring = { containers: [], files: {}, credential: true };
      if (facts.record !== null) facts.record.addons = { alloy: "shop", monitoring: "shop" };
      s.host.facts = HostFactsSchema.parse(facts);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        observability: {
          ...plan.observability,
          monitoring: monitoredPlan({ on: "app" }).observability?.monitoring,
        },
      });
      return s;
    }

    const ownServices = (s: Awaited<ReturnType<typeof ownWithStack>>): DestroyServices => ({
      engine: s.services.engine,
      github: s.github,
      cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
      ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
      ...(s.services.own !== undefined ? { own: s.services.own } : {}),
    });

    it.each([
      [false, false],
      [true, true],
    ])(
      "removes Alloy and the stack in the teardown (--delete-data %s: the stack's data goes %s)",
      async (deleteData, removeData) => {
        const s = await ownWithStack();

        await runDestroy(s.deps, {
          services: ownServices(s),
          deleteData,
          confirm: async () => true,
        });

        const teardown = s.host.applies.at(-1)?.plan;
        expect(teardown?.purpose).toBe("teardown");
        const steps = teardown?.steps.filter(
          (step) => step.id === "alloy" || step.id === "monitoring",
        );
        expect(steps?.map((step) => [step.id, step.params.remove])).toEqual([
          ["alloy", true],
          ["monitoring", true],
        ]);
        expect(steps?.[1]?.params.removeData).toBe(removeData);
        // Approved with the app's name typed, by the hash it was applied with.
        const approval = s.handler.requests.find((r) => r.kind === "host-apply");
        expect(approval).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
        expect(approval?.planHash).toBe(hostPlanHash(teardown as HostPlan));
      },
    );
  },
);
