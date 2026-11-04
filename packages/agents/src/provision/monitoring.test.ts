/** Provision's self-hosted monitoring (feature 020): the host plans per server, in order. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  type HostStep,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { IacEngine, RemoteExec } from "@opscrew/contracts";
import { findExecutable, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_PUSH_PORT,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoringDisable } from "../monitoring/disable";
import { allocateNetwork, type NetworkHostFacts } from "../network";
import { monitoredPlan, senderPlan, splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { generatedValuesFile, recordGeneratedEntries } from "../shared/app-secrets";
import { updateServerAddresses } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  DEPLOYED_AT,
  ED25519,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  freshFacts,
  ownRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedRunner,
  SERVER_IPV4,
  SERVER_IPV6,
  testKeyMaker,
} from "../testing";
import { monitoringHostPlans, monitoringStackInput } from "./monitoring";
import { runProvision } from "./run";
import { keepMonitoringValues, monitoringValues } from "./secrets";
import type { ProvisionServices } from "./types";

const DATA_IPV4 = "203.0.113.30";
const MONITORING_IPV4 = "203.0.113.40";
/** The monitoring server of another environment of the repository (qa). */
const QA_MONITORING_IPV4 = "203.0.113.41";
const STAGING_IPV4 = "203.0.113.50";
const STAGING_DATA_IPV4 = "203.0.113.51";
const PUBLIC = [
  SERVER_IPV4,
  SERVER_IPV6,
  DATA_IPV4,
  MONITORING_IPV4,
  STAGING_IPV4,
  STAGING_DATA_IPV4,
];
const HCLOUD = fakeSecret("hcloud-token");
/** The pull request the first run opened, while it is still open. */
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const STRIPE = fakeSecret("stripe-live-key");

/** The state's outputs after an apply: the app's server and the extra servers, by name. */
function outputs(
  app = SERVER_IPV4,
  extra: Record<string, string> = { data: DATA_IPV4, monitoring: MONITORING_IPV4 },
) {
  return {
    server_ipv4: app,
    server_id: "4711",
    server_name: "shop",
    url: `http://${app}`,
    extra_servers: Object.fromEntries(
      Object.entries(extra).map(([name, ipv4], i) => [name, { ipv4, id: `${4712 + i}` }]),
    ),
  };
}

/** A server OpsCrew created (root through Docker), running containers of `projects`. */
function cloudFacts(projects: readonly string[] = [], facts: Partial<HostFacts> = {}): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    containers: projects.map((project) => ({
      name: `${project}-main-1`,
      project,
      ports: "",
      running: true,
    })),
    ...facts,
  });
}

/** Every server deployed: the edge and the app on the app's server, the app on `data`. */
function deployedFacts(app = "shop", hosts = { app: SERVER_IPV4, data: DATA_IPV4 }) {
  return {
    [hosts.app]: cloudFacts(["opscrew-edge", app]),
    [hosts.data]: cloudFacts([app]),
  };
}

/** One host apply on a server OpsCrew created. */
interface CloudApply {
  host: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/** A step's rendered files (`file:<name>` parameters), each as its SHA-256. */
function fileHashes(step: HostStep): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.params).flatMap(([key, text]) =>
      key.startsWith("file:") ? [[key.slice("file:".length), sha256Hex(String(text))]] : [],
    ),
  );
}

/**
 * The deploy user's host adapter on the servers OpsCrew created, by address. Applying the
 * monitoring's steps changes what inspection reads there next (the stack's files, Alloy's), and
 * the monitoring login's state, which `remote` answers the `grant` step's check with.
 */
function cloudHosts(facts: Record<string, HostFacts>) {
  const applies: CloudApply[] = [];
  /** The servers whose Postgres has OpsCrew's monitoring login. */
  const granted = new Set<string>();
  const changed = (host: string, change: Partial<HostFacts>) => {
    facts[host] = HostFactsSchema.parse({ ...(facts[host] ?? cloudFacts()), ...change });
  };
  const running = (host: string, project: string, on: boolean) => {
    const others = (facts[host] ?? cloudFacts()).containers.filter((c) => c.project !== project);
    const name = `${project}-main-1`;
    changed(host, {
      containers: [...others, ...(on ? [{ name, project, ports: "", running: true }] : [])],
    });
  };
  return {
    applies,
    facts,
    granted,
    /** The deploy user's shell: `ready`, and the monitoring login's state on its check. */
    remote(host: string): RemoteExec {
      const ready = readyRemote(host);
      return {
        host,
        run: async (command, options) =>
          (options?.input ?? "").includes("grant.check")
            ? {
                exitCode: 0,
                // The removal's check holds once the login is gone.
                stdout: `state=${granted.has(host) !== /REMOVE=[^\n]*true/.test(options?.input ?? "") ? "in-place" : "change"}\n`,
                stderr: "",
              }
            : ready.run(command, options),
      };
    },
    adapter: {
      async inspect(remote: RemoteExec) {
        return facts[remote.host] ?? cloudFacts();
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ host: remote.host, plan, options });
        const host = remote.host;
        for (const step of plan.steps.filter((s) => s.state === "change")) {
          const removed = step.params.remove === true;
          if (step.id === "grant") {
            if (removed) granted.delete(host);
            else granted.add(host);
          } else if (step.id === "monitoring") {
            running(host, "opscrew-monitoring", !removed);
            const containers = [{ name: "opscrew-monitoring-main-1", running: true }];
            const stack = { containers, files: fileHashes(step), credential: true };
            if (removed) delete facts[host]?.monitoring;
            else changed(host, { monitoring: stack });
          } else if (step.id === "alloy") {
            running(host, "opscrew-alloy", !removed);
            const destinations = String(step.params.destinations ?? "grafanaCloud").split(" ");
            const postgres = step.params.postgresHost;
            const alloy = {
              destinations: destinations as ("grafanaCloud" | "monitoring")[],
              files: fileHashes(step),
              ...(typeof postgres === "string" ? { postgresHost: postgres } : {}),
            };
            if (removed) delete facts[host]?.alloy;
            else changed(host, { alloy });
          }
        }
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: plan.steps.filter((s) => s.state !== "change").map((s) => s.id),
        };
      },
    },
  };
}

/** Real git, `ssh` that works, and `ssh-keyscan` answering with {@link ED25519} on port 22. */
function keyscanRunner(): ScriptedRunner {
  const own = ownRunner();
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "ssh-keyscan" && !args.includes("-p")) {
      const stdout = `${args[args.length - 1]} ssh-ed25519 ${ED25519}\n`;
      return { exitCode: 0, stdout, stderr: "" };
    }
    return own.run(command, args, options);
  });
}

/** `plan` on its private network, with the keys allocation made. */
function networked(
  plan: Omit<DeployPlan, "network">,
  facts: Record<string, NetworkHostFacts> = {},
) {
  const { network, privateKeys } = allocateNetwork(plan, facts, testKeyMaker(plan.app.name));
  return { plan: withNetwork(plan, network), privateKeys };
}

interface Setup {
  plan: DeployPlan;
  privateKeys: Record<string, string>;
  facts?: Record<string, HostFacts>;
  engine?: IacEngine & { readonly calls: string[] };
  /** The project's root when the plan is another environment's of it. */
  root?: string;
  environment?: string;
  approve?: boolean;
}

/** A project with `plan` (prod's, or `environment`'s in `root`), and the fakes provision uses. */
async function setup(o: Setup) {
  const project =
    o.root === undefined
      ? await createProject(o.plan)
      : { root: o.root, git: undefined as never, bare: "" };
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const engine = o.engine ?? new FakeEngine({ outputs: outputs() });
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => o.approve ?? true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: keyscanRunner(),
    approvalHandler: handler,
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  if (o.environment !== undefined) await writeArtifact("plan", deps.paths.files.plan, o.plan);
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  await recordGeneratedEntries(deps, "network", o.privateKeys);
  const hosts = cloudHosts(o.facts ?? deployedFacts());
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: (host) => hosts.remote(host),
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    serverHost: hosts.adapter,
  };
  return { ...project, deps, engine, github, handler, services, hosts };
}

type Setup2 = Awaited<ReturnType<typeof setup>>;

const hostTitles = (s: Setup2) =>
  s.handler.requests.filter((r) => r.kind === "host-apply").map((r) => r.title);

/** The applies of host plans with a step `id`, on `host`. */
const appliesOf = (s: Setup2, id: string, host?: string) =>
  s.hosts.applies.filter(
    (a) => a.plan.steps.some((step) => step.id === id) && (host === undefined || a.host === host),
  );

/** The rendered file `name` of the add-on step `id` in `plan`. */
function fileOf(plan: HostPlan | undefined, id: string, name: string): string {
  const content = plan?.steps.find((step) => step.id === id)?.params[`file:${name}`];
  if (typeof content !== "string") throw new Error(`no ${name}`);
  return content;
}

/** The approvals' text, the audit log and the commit of the run. */
async function recordedText(s: Setup2): Promise<string> {
  const committed = s.git === undefined ? "" : await s.git(s.root, "show", "HEAD");
  return [JSON.stringify(s.deps.audit.entries), JSON.stringify(s.handler.requests), committed].join(
    "\n",
  );
}

/** Every user-visible or persisted text of the run: the output too. */
async function shownText(s: Setup2): Promise<string> {
  return `${s.deps.reporter.text()}\n${await recordedText(s)}`;
}

/** The output's lines about the monitoring (the wait for each server names its address). */
const monitoringLines = (s: Setup2) =>
  s.deps.reporter
    .text()
    .split("\n")
    .filter((line) => /Grafana|Alloy|monitoring stack|monitoring's/.test(line))
    .join("\n");

/** The host plans this computer saved. */
async function savedPlans(s: Setup2): Promise<string> {
  const dir = s.deps.paths.files.plansDir;
  const names = (await readdir(dir)).filter((name) => name.startsWith("host-"));
  return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("\n");
}

/** The owner's plan: the split plan with its own monitoring server, on its network. */
function ownerPlan() {
  return networked(monitoredPlan());
}

/** The member address of `server` on `plan`'s network. */
const addressOf = (plan: DeployPlan, server: string) =>
  plan.network?.members.find((m) => m.name === server)?.address as string;

const skipNoGit = !findExecutable("git");

describe.skipIf(skipNoGit)("provision with self-hosted monitoring", () => {
  it("sets up a monitoring server of its own: the login, the stack, then Alloy on every server, each approved by its hash", async () => {
    const { plan, privateKeys } = ownerPlan();
    const s = await setup({ plan, privateKeys });

    const result = await runProvision(s.deps, { services: s.services });

    // After the private network's host plans: Postgres's login on its server, the stack, then
    // Alloy on every server, the app's first; before the secrets and the pull request.
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      ...Array(8).fill("host-apply"),
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(hostTitles(s)).toEqual([
      expect.stringMatching(/^Apply the private network's host plan to server app /),
      expect.stringMatching(/^Apply the private network's host plan to server data /),
      expect.stringMatching(/^Apply the private network's host plan to server monitoring /),
      "Let OpsCrew's monitoring read the statistics of db on server data, with a login of its own",
      "Run the monitoring stack (Prometheus, Loki and Grafana) on server monitoring",
      "Run Grafana Alloy on the app's server, sending its figures and logs to the monitoring stack",
      "Run Grafana Alloy on server data, sending its figures and logs to the monitoring stack",
      "Run Grafana Alloy on server monitoring, sending its figures and logs to the monitoring stack",
    ]);
    // Each applied on its server by the hash its approval names.
    const approved = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(s.hosts.applies.map((a) => hostPlanHash(a.plan))).toEqual(
      approved.map((r) => r.planHash),
    );
    expect(
      s.hosts.applies.slice(3).map((a) => [a.host, a.plan.steps.map((step) => step.id)]),
    ).toEqual([
      [DATA_IPV4, ["grant"]],
      [MONITORING_IPV4, ["monitoring"]],
      [SERVER_IPV4, ["alloy"]],
      [DATA_IPV4, ["alloy"]],
      [MONITORING_IPV4, ["alloy"]],
    ]);
    expect(result.serverHostPlanHashes).toHaveLength(8);

    // The stack publishes its front on the monitoring server's private address; Alloy pushes there
    // from the other servers, and to `front` by name on the stack's own server.
    const monitoringAddress = addressOf(plan, "monitoring");
    const [stack] = appliesOf(s, "monitoring");
    expect(fileOf(stack?.plan, "monitoring", "compose.yaml")).toContain(
      `${monitoringAddress}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`,
    );
    const [onApp, onData, onMonitoring] = appliesOf(s, "alloy");
    expect(fileOf(onApp?.plan, "alloy", "config.alloy")).toContain(
      `http://${monitoringAddress}:${MONITORING_PUSH_PORT}`,
    );
    expect(fileOf(onMonitoring?.plan, "alloy", "config.alloy")).toContain(
      `http://front:${MONITORING_PUSH_PORT}`,
    );
    // Postgres's server reads it with the monitoring login.
    expect(onData?.plan.steps[0]?.params).toMatchObject({
      server: "data",
      destinations: "monitoring",
      postgresHost: "db",
    });
    expect(onApp?.plan.steps[0]?.params).not.toHaveProperty("postgresHost");

    // The passwords: generated once, kept with the generated values, passed only on apply.
    const kept = await monitoringValues(s.deps);
    expect(kept?.grafanaAdminPassword).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(kept?.postgresPassword).toMatch(/^[A-Za-z0-9]{16,128}$/);
    const grafana = kept?.grafanaAdminPassword as string;
    const postgres = kept?.postgresPassword as string;
    const secrets = s.hosts.applies.slice(3).map((a) => a.options.secrets);
    expect(secrets).toEqual([
      { monitoringPostgresPassword: postgres },
      { grafanaAdminPassword: grafana },
      {},
      { monitoringPostgresPassword: postgres },
      {},
    ]);
    // Provision's rewrite of the generated values keeps them, with the network's keys.
    const generated = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8"));
    expect(generated.monitoring).toEqual({
      grafanaAdminPassword: grafana,
      postgresPassword: postgres,
    });
    expect(generated.network).toEqual(privateKeys);

    // The summary says where Grafana is and how to open it.
    expect(s.deps.reporter.text()).toContain(
      "Run `opscrew addon open monitoring` to open it (through an SSH tunnel when this computer is not one of those devices).",
    );
    // The deploy-setup pull request carries the masking file on every server that runs the app.
    const workflow = await s.git(s.root, "show", "HEAD:.github/workflows/opscrew-deploy.yml");
    expect(workflow.match(/mask\.re/g)?.length).toBeGreaterThanOrEqual(2);

    // No password, key or token leaves this computer's private files, nor a public address the
    // approvals, the audit log, the commit or what is said about the monitoring.
    const text = await shownText(s);
    for (const secret of [grafana, postgres, STRIPE, ...Object.values(privateKeys)]) {
      expect(text).not.toContain(secret);
      expect(await savedPlans(s)).not.toContain(secret);
    }
    const recorded = `${await recordedText(s)}\n${monitoringLines(s)}`;
    for (const address of PUBLIC) expect(recorded).not.toContain(address);

    // A second provision with nothing changed shows each monitoring plan in place and asks for no
    // approval of any (the fake's network plans still ask: it reads no network state).
    s.github.openPull = OPEN_PULL;
    s.handler.requests.length = 0;
    const applied = s.hosts.applies.length;
    await runProvision(s.deps, { services: s.services });
    const monitoringTitles = /monitoring|Grafana Alloy/;
    expect(hostTitles(s).filter((title) => monitoringTitles.test(title))).toEqual([
      expect.stringMatching(/^Apply the private network's host plan to server monitoring /),
    ]);
    expect(s.hosts.applies.slice(applied).every((a) => a.plan.steps[0]?.id === "network")).toBe(
      true,
    );
    expect(s.deps.reporter.text()).toContain(
      "The monitoring stack on server monitoring is as planned; nothing on it changes.",
    );
    expect(s.deps.reporter.text()).toContain(
      "Grafana Alloy on server data already runs as planned; nothing on it changes.",
    );

    // A changed setting changes the stack's files: its plan is a change again, approved by its
    // hash, with the password kept on this computer.
    const before = await readArtifact("plan", s.deps.paths.files.plan);
    const longer = DeployPlanSchema.parse({
      ...before,
      observability: {
        ...before.observability,
        monitoring: {
          ...before.observability?.monitoring,
          retention: { metricsDays: 30, logsDays: 7, metricsMaxGb: 24 },
        },
      },
    });
    await writeArtifact("plan", s.deps.paths.files.plan, longer);
    s.handler.requests.length = 0;
    const changedAt = s.hosts.applies.length;
    await runProvision(s.deps, { services: s.services });
    expect(hostTitles(s).filter((title) => /stack|Grafana Alloy/.test(title))).toEqual([
      "Run the monitoring stack (Prometheus, Loki and Grafana) on server monitoring",
    ]);
    const stackAgain = s.hosts.applies
      .slice(changedAt)
      .find((a) => a.plan.steps[0]?.id === "monitoring");
    expect(stackAgain?.options.secrets).toEqual({ grafanaAdminPassword: grafana });
    expect(fileOf(stackAgain?.plan, "monitoring", "compose.yaml")).toContain(
      "--storage.tsdb.retention.time=30d",
    );
    expect(await monitoringValues(s.deps)).toEqual(kept);
  });

  it("writes a monitoring login's password this computer did not keep, though the server reads the login and Alloy in place", async () => {
    const { plan, privateKeys } = ownerPlan();
    const s = await setup({ plan, privateKeys });
    await runProvision(s.deps, { services: s.services });
    // The password is not on this computer any more (another computer set monitoring up).
    await keepMonitoringValues(s.deps, ({ postgresPassword: _, ...rest }) => rest);
    expect(s.hosts.granted.has(DATA_IPV4)).toBe(true);
    s.github.openPull = OPEN_PULL;
    s.handler.requests.length = 0;
    const before = s.hosts.applies.length;

    await runProvision(s.deps, { services: s.services });

    const fresh = (await monitoringValues(s.deps))?.postgresPassword as string;
    expect(fresh).toMatch(/^[A-Za-z0-9]{32}$/);
    const onData = s.hosts.applies
      .slice(before)
      .filter((a) => a.host === DATA_IPV4 && a.plan.steps[0]?.id !== "network");
    expect(onData.map((a) => [a.plan.steps[0]?.id, a.options.secrets])).toEqual([
      ["grant", { monitoringPostgresPassword: fresh }],
      ["alloy", { monitoringPostgresPassword: fresh }],
    ]);
    // The app's server's Alloy reads no Postgres: still in place.
    expect(appliesOf(s, "alloy", SERVER_IPV4)).toHaveLength(1);
  });

  it("keeps the login's password while a server the deploy hasn't started the app on still has the login", async () => {
    const { plan, privateKeys } = ownerPlan();
    const s = await setup({ plan, privateKeys });
    await runProvision(s.deps, { services: s.services });
    const password = (await monitoringValues(s.deps))?.postgresPassword;
    await monitoringDisable(s.deps, await readArtifact("plan", s.deps.paths.files.plan));
    // The app is not running on data now.
    const data = s.hosts.facts[DATA_IPV4] as HostFacts;
    s.hosts.facts[DATA_IPV4] = { ...data, containers: [] };
    s.github.openPull = OPEN_PULL;
    const before = s.hosts.applies.length;

    await runProvision(s.deps, { services: s.services });

    expect(s.hosts.applies.slice(before).some((a) => a.plan.steps[0]?.id === "grant")).toBe(false);
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew removes its monitoring login from db on server data at the next `opscrew provision`, once the app runs there again; until then this computer keeps the login's password.",
    );
    expect(await monitoringValues(s.deps)).toEqual({ postgresPassword: password });

    // Once the app runs there again, the login goes, and so does its password.
    s.hosts.facts[DATA_IPV4] = data;
    const again = s.hosts.applies.length;
    await runProvision(s.deps, { services: s.services });
    const grants = s.hosts.applies.slice(again).filter((a) => a.plan.steps[0]?.id === "grant");
    expect(grants.map((a) => a.plan.steps[0]?.params.remove)).toEqual([true]);
    expect(s.hosts.granted.has(DATA_IPV4)).toBe(false);
    expect(await monitoringValues(s.deps)).toBeUndefined();
  });

  it("runs the stack on the app's server with --on app: Alloy pushes to the front by name there, and to its private address elsewhere", async () => {
    const { plan, privateKeys } = networked(monitoredPlan({ on: "app" }));
    const s = await setup({
      plan,
      privateKeys,
      engine: new FakeEngine({ outputs: outputs(SERVER_IPV4, { data: DATA_IPV4 }) }),
    });

    await runProvision(s.deps, { services: s.services });

    expect(hostTitles(s).slice(2)).toEqual([
      "Let OpsCrew's monitoring read the statistics of db on server data, with a login of its own",
      "Run the monitoring stack (Prometheus, Loki and Grafana) on the app's server",
      "Run Grafana Alloy on the app's server, sending its figures and logs to the monitoring stack",
      "Run Grafana Alloy on server data, sending its figures and logs to the monitoring stack",
    ]);
    const [stack] = appliesOf(s, "monitoring");
    expect(stack?.host).toBe(SERVER_IPV4);
    const appAddress = addressOf(plan, "app");
    expect(fileOf(stack?.plan, "monitoring", "compose.yaml")).toContain(
      `${appAddress}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`,
    );
    const [onApp, onData] = appliesOf(s, "alloy");
    expect(fileOf(onApp?.plan, "alloy", "config.alloy")).toContain(
      `http://front:${MONITORING_PUSH_PORT}`,
    );
    expect(fileOf(onData?.plan, "alloy", "config.alloy")).toContain(
      `http://${appAddress}:${MONITORING_PUSH_PORT}`,
    );
  });

  it("leaves Alloy and the login of a server the deploy has not started the app on for the next run, and says so", async () => {
    const { plan, privateKeys } = ownerPlan();
    const s = await setup({
      plan,
      privateKeys,
      facts: { [SERVER_IPV4]: cloudFacts(["opscrew-edge", "shop"]) },
    });

    await runProvision(s.deps, { services: s.services });

    expect(hostTitles(s).slice(3)).toEqual([
      "Run the monitoring stack (Prometheus, Loki and Grafana) on server monitoring",
      "Run Grafana Alloy on the app's server, sending its figures and logs to the monitoring stack",
      "Run Grafana Alloy on server monitoring, sending its figures and logs to the monitoring stack",
    ]);
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew sets up Grafana Alloy on server data at the next `opscrew provision`, once a deploy has started the app there: Alloy joins Docker networks the deploy creates (shop_internal).",
    );
  });

  it("only shows and saves the host plans with --plan-only, and generates no password", async () => {
    const { plan, privateKeys } = ownerPlan();
    const deployed = DeployPlanSchema.parse({
      ...plan,
      deployment: { lastApplyAt: DEPLOYED_AT, placement: { db: "data" } },
    });
    const s = await setup({ plan: deployed, privateKeys });
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { data: { ipv4: DATA_IPV4 }, monitoring: { ipv4: MONITORING_IPV4 } },
    }));

    const result = await runProvision(s.deps, { services: s.services, planOnly: true });

    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toEqual([]);
    expect(s.hosts.applies).toEqual([]);
    expect(result.serverHostPlanHashes).toHaveLength(8);
    expect(await monitoringValues(s.deps)).toBeUndefined();
  });
});

describe.skipIf(skipNoGit)(
  "provision of an environment that sends to the repository's monitoring server",
  () => {
    /** Prod owns the monitoring server; staging sends to it on its own interface there. */
    async function repository() {
      const owner = ownerPlan();
      const ownerDeployed = DeployPlanSchema.parse({
        ...owner.plan,
        deployment: { lastApplyAt: DEPLOYED_AT, placement: { db: "data" } },
      });
      const project = await createProject(ownerDeployed);
      // Prod's provision left its servers' addresses and Grafana's password on this computer.
      const prod = await createTestPhaseDeps({
        root: project.root,
        env: { OPSCREW_HOME: join(project.root, ".home-opscrew") },
      });
      await updateServerAddresses(prod.paths, (current) => ({
        ...current,
        servers: { data: { ipv4: DATA_IPV4 }, monitoring: { ipv4: MONITORING_IPV4 } },
      }));
      const grafana = fakeSecret("generic-password", "grafana-admin").replace(/[^A-Za-z0-9]/g, "");
      await mkdir(dirname(generatedValuesFile(prod)), { recursive: true });
      await writeFile(
        generatedValuesFile(prod),
        JSON.stringify({
          monitoring: { grafanaAdminPassword: grafana },
          network: owner.privateKeys,
        }),
      );
      // The monitoring server holds prod's network on wg-opscrew0.
      const monitoringFacts = cloudFacts([], {
        wireguardInterfaces: ["wg-opscrew0"],
        udpPortsInUse: [51820],
      });
      const base = senderPlan();
      const staging = networked(
        {
          ...base,
          infra: { ...base.infra, dir: "opscrew/infra/staging" },
          cicd: { ...base.cicd, workflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
        },
        { monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] } },
      );
      const facts = {
        ...deployedFacts("shop-staging", { app: STAGING_IPV4, data: STAGING_DATA_IPV4 }),
        [MONITORING_IPV4]: monitoringFacts,
      };
      const s = await setup({
        plan: staging.plan,
        privateKeys: staging.privateKeys,
        root: project.root,
        environment: "staging",
        facts,
        engine: new FakeEngine({
          outputs: outputs(STAGING_IPV4, { data: STAGING_DATA_IPV4 }),
        }),
      });
      return { ...s, git: project.git, owner: ownerDeployed, staging, grafana, monitoringFacts };
    }

    it("renders the owner's stack from every environment whose interface is on the monitoring server", async () => {
      const r = await repository();
      const prod = await setup({
        plan: r.owner,
        privateKeys: {},
        root: r.root,
        facts: {
          ...deployedFacts(),
          [MONITORING_IPV4]: cloudFacts([], {
            wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
          }),
        },
      });

      await runProvision(prod.deps, { services: prod.services });

      const [stack] = appliesOf(prod, "monitoring");
      expect(stack?.plan.app).toBe("shop");
      const compose = fileOf(stack?.plan, "monitoring", "compose.yaml");
      const outside = r.staging.plan.network?.members.find((m) => m.name === "monitoring");
      for (const address of [addressOf(r.owner, "monitoring"), outside?.address]) {
        expect(compose).toContain(`${address}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`);
      }
      expect(stack?.options.secrets).toEqual({ grafanaAdminPassword: r.grafana });

      // Without staging's interface there yet, the stack keeps prod's network only.
      prod.hosts.facts[MONITORING_IPV4] = cloudFacts([], { wireguardInterfaces: ["wg-opscrew0"] });
      prod.github.openPull = OPEN_PULL;
      await runProvision(prod.deps, { services: prod.services });
      const [, again] = appliesOf(prod, "monitoring");
      expect(fileOf(again?.plan, "monitoring", "compose.yaml")).not.toContain(
        `${outside?.address}:`,
      );
    });

    it("joins the monitoring server over its owner's login: its interface, its filter, then the stack with both networks", async () => {
      const r = await repository();

      await runProvision(r.deps, { services: r.services });

      expect(hostTitles(r).slice(2)).toEqual([
        "Let OpsCrew's monitoring read the statistics of db on server data, with a login of its own",
        expect.stringMatching(/^Apply the private network's host plan to server monitoring /),
        "Receive this environment's figures and logs on the monitoring stack of server monitoring of opscrew/plan.yaml",
        "Run Grafana Alloy on the app's server, sending its figures and logs to the monitoring stack",
        "Run Grafana Alloy on server data, sending its figures and logs to the monitoring stack",
      ]);
      const applied = r.hosts.applies.slice(2);
      expect(applied.map((a) => [a.host, a.plan.app, a.plan.steps.map((step) => step.id)])).toEqual(
        [
          [STAGING_DATA_IPV4, "shop-staging", ["grant"]],
          [MONITORING_IPV4, "shop-staging", ["network", "network-filter"]],
          [MONITORING_IPV4, "shop", ["monitoring"]],
          [STAGING_IPV4, "shop-staging", ["alloy"]],
          [STAGING_DATA_IPV4, "shop-staging", ["alloy"]],
        ],
      );
      // The interface for staging's network, with the key staging made, and its filter: the front
      // for staging's servers, Grafana for its devices.
      const outside = r.staging.plan.network?.members.find((m) => m.name === "monitoring");
      const [, network] = applied;
      expect(network?.plan.steps[0]?.params).toMatchObject({
        interface: "wg-opscrew1",
        port: 51821,
      });
      expect(network?.options.secrets).toEqual({ wireguardKey: r.staging.privateKeys.monitoring });
      expect(network?.plan.steps[1]?.title).toContain(`${MONITORING_PUSH_PORT}`);
      // The stack publishes on both networks, and gets the owner's Grafana password on apply.
      const compose = fileOf(applied[2]?.plan, "monitoring", "compose.yaml");
      for (const address of [addressOf(r.owner, "monitoring"), outside?.address]) {
        expect(compose).toContain(`${address}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`);
      }
      expect(applied[2]?.options.secrets).toEqual({ grafanaAdminPassword: r.grafana });
      // Alloy pushes to the stack's address on staging's network.
      expect(fileOf(applied[3]?.plan, "alloy", "config.alloy")).toContain(
        `http://${outside?.address}:${MONITORING_PUSH_PORT}`,
      );
      // This computer keeps which interface staging has there, and its own login's password.
      const kept = await monitoringValues(r.deps);
      expect(kept?.owner).toEqual({
        plan: "opscrew/plan.yaml",
        server: "monitoring",
        interface: "wg-opscrew1",
      });
      expect(kept?.grafanaAdminPassword).toBeUndefined();
      expect(r.deps.reporter.text()).toContain(
        "Its admin password is kept with OpsCrew's generated values of opscrew/plan.yaml",
      );
      const text = await shownText(r);
      for (const secret of [r.grafana, kept?.postgresPassword as string]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toContain(MONITORING_IPV4);
    });

    it("stops before any of the monitoring's host plans when the shared stack's Grafana password is not on this computer", async () => {
      const r = await repository();
      const prod = await createTestPhaseDeps({
        root: r.root,
        env: { OPSCREW_HOME: join(r.root, ".home-opscrew") },
      });
      await writeFile(generatedValuesFile(prod), "{}");

      await expect(runProvision(r.deps, { services: r.services })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "The monitoring stack runs with Grafana's admin password of opscrew/plan.yaml, which is not on this computer, so OpsCrew applied none of the monitoring's host plans.",
      });
      // Only the private network's host plans of staging's own servers were applied.
      expect(r.hosts.applies.map((a) => a.plan.steps[0]?.id)).toEqual(["network", "network"]);
    });

    /** The applies on `host` from `from` on: each plan's app and its steps' ids. */
    const onHost = (r: Setup2, host: string, from: number) =>
      r.hosts.applies
        .slice(from)
        .filter((a) => a.host === host)
        .map((a) => [a.plan.app, a.plan.steps.map((step) => step.id)]);

    /** Staging's plan on disk with its outside member (the monitoring server) taken anew. */
    async function anewOutside(
      r: Setup2,
      change: (plan: DeployPlan) => DeployPlan,
      facts: NetworkHostFacts,
    ) {
      const { network, ...current } = change(await readArtifact("plan", r.deps.paths.files.plan));
      const kept = network?.members.filter((m) => m.name !== "monitoring") ?? [];
      const allocated = allocateNetwork(
        {
          ...current,
          ...(network === undefined ? {} : { network: { ...network, members: kept } }),
        },
        { monitoring: facts },
        testKeyMaker(`anew-${facts.wireguardInterfaces.length}`),
      );
      const plan = withNetwork(current, allocated.network);
      await writeArtifact("plan", r.deps.paths.files.plan, plan);
      await recordGeneratedEntries(r.deps, "network", allocated.privateKeys);
      return plan;
    }

    it("re-joins the same monitoring server on another interface: the old one goes, then the stack publishes on the new", async () => {
      const r = await repository();
      await runProvision(r.deps, { services: r.services });
      // Turned off and on again with no provision between: the monitoring server's interface for
      // staging is allocated anew while the old one is still there.
      const plan = await anewOutside(r, (p) => p, {
        udpPortsInUse: [51820, 51821],
        wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
      });
      const outside = plan.network?.members.find((m) => m.name === "monitoring");
      expect(outside?.port).toBe(51822);
      r.github.openPull = OPEN_PULL;
      const before = r.hosts.applies.length;

      await runProvision(r.deps, { services: r.services });

      expect(onHost(r, MONITORING_IPV4, before)).toEqual([
        ["shop", ["monitoring"]],
        ["shop-staging", ["network-filter", "network"]],
        ["shop-staging", ["network", "network-filter"]],
        ["shop", ["monitoring"]],
      ]);
      const removal = r.hosts.applies
        .slice(before)
        .find((a) => a.plan.steps[0]?.id === "network-filter");
      expect(removal?.plan.steps[1]?.params).toMatchObject({
        interface: "wg-opscrew1",
        remove: true,
      });
      // The stack ends publishing on staging's address again, now on wg-opscrew2.
      const stacks = appliesOf(r, "monitoring", MONITORING_IPV4).slice(-2);
      const publish = `${outside?.address}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`;
      expect(fileOf(stacks[0]?.plan, "monitoring", "compose.yaml")).not.toContain(publish);
      expect(fileOf(stacks[1]?.plan, "monitoring", "compose.yaml")).toContain(publish);
      expect((await monitoringValues(r.deps))?.owner).toEqual({
        plan: "opscrew/plan.yaml",
        server: "monitoring",
        interface: "wg-opscrew2",
      });
    });

    it("moves to another environment's monitoring server: leaves the old one over its owner's login, then joins the new", async () => {
      const r = await repository();
      await runProvision(r.deps, { services: r.services });
      // qa owns a monitoring server of its own, which holds qa's network on wg-opscrew0.
      const base = monitoredPlan();
      const qaNetworked = networked({
        ...base,
        app: { ...base.app, name: "shop-qa" },
        environment: { name: "qa", deploySource: { from: "main" }, runner: "github" },
        infra: { ...base.infra, dir: "opscrew/infra/qa" },
        cicd: { ...base.cicd, workflowPath: ".github/workflows/opscrew-deploy-qa.yml" },
      });
      const qaPlan = DeployPlanSchema.parse({
        ...qaNetworked.plan,
        deployment: { lastApplyAt: DEPLOYED_AT, placement: { db: "data" } },
      });
      const qa = await createTestPhaseDeps({
        root: r.root,
        env: { OPSCREW_HOME: join(r.root, ".home-opscrew") },
        environment: "qa",
      });
      await writeArtifact("plan", qa.paths.files.plan, qaPlan);
      await updateServerAddresses(qa.paths, (current) => ({
        ...current,
        servers: { monitoring: { ipv4: QA_MONITORING_IPV4 } },
      }));
      const qaGrafana = fakeSecret("generic-password", "qa-grafana").replace(/[^A-Za-z0-9]/g, "");
      await mkdir(dirname(generatedValuesFile(qa)), { recursive: true });
      await writeFile(
        generatedValuesFile(qa),
        JSON.stringify({ monitoring: { grafanaAdminPassword: qaGrafana } }),
      );
      const qaFacts = { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] };
      r.hosts.facts[QA_MONITORING_IPV4] = cloudFacts([], qaFacts);
      const qaOwner = { plan: "opscrew/environments/qa/plan.yaml", server: "monitoring" };
      const plan = await anewOutside(
        r,
        (p) => ({
          ...p,
          observability: {
            ...p.observability,
            monitoring: {
              ...(p.observability?.monitoring as NonNullable<
                NonNullable<DeployPlan["observability"]>["monitoring"]
              >),
              where: { kind: "shared", owner: qaOwner },
            },
          },
        }),
        qaFacts,
      );
      const outside = plan.network?.members.find((m) => m.name === "monitoring");
      r.github.openPull = OPEN_PULL;
      const before = r.hosts.applies.length;

      await runProvision(r.deps, { services: r.services });

      // prod's server, over prod's login: its stack without staging, then staging's interface.
      expect(onHost(r, MONITORING_IPV4, before)).toEqual([
        ["shop", ["monitoring"]],
        ["shop-staging", ["network-filter", "network"]],
      ]);
      // qa's server: staging's interface, then qa's stack with staging, with qa's password.
      expect(onHost(r, QA_MONITORING_IPV4, before)).toEqual([
        ["shop-staging", ["network", "network-filter"]],
        ["shop-qa", ["monitoring"]],
      ]);
      const [qaStack] = appliesOf(r, "monitoring", QA_MONITORING_IPV4);
      expect(qaStack?.options.secrets).toEqual({ grafanaAdminPassword: qaGrafana });
      expect(fileOf(qaStack?.plan, "monitoring", "compose.yaml")).toContain(
        `${outside?.address}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`,
      );
      const [, prodStack] = appliesOf(r, "monitoring", MONITORING_IPV4);
      expect(prodStack?.options.secrets).toEqual({ grafanaAdminPassword: r.grafana });
      // Staging's servers reach qa's server at the same private address: their network changes,
      // their Alloy doesn't.
      const staged = r.hosts.applies.slice(before).filter((a) => a.host === STAGING_IPV4);
      expect(staged.map((a) => a.plan.steps[0]?.id)).toEqual(["network"]);
      expect((await monitoringValues(r.deps))?.owner).toEqual({
        ...qaOwner,
        interface: "wg-opscrew1",
      });
      expect(await recordedText(r)).not.toContain(qaGrafana);
    });

    it("takes the monitoring server off its network once monitoring is off there: Alloy, the stack without it, the interface, the login", async () => {
      const r = await repository();
      await runProvision(r.deps, { services: r.services });
      const before = r.hosts.applies.length;
      // Its interface is on the monitoring server now, and Alloy sends to the stack.
      r.hosts.facts[MONITORING_IPV4] = cloudFacts([], {
        wireguardInterfaces: ["wg-opscrew0", "wg-opscrew1"],
      });
      for (const host of [STAGING_IPV4, STAGING_DATA_IPV4]) {
        r.hosts.facts[host] = cloudFacts(
          host === STAGING_IPV4 ? ["opscrew-edge", "shop-staging"] : ["shop-staging"],
          {
            alloy: { destinations: ["monitoring"], files: {} },
          },
        );
      }
      await monitoringDisable(r.deps, await readArtifact("plan", r.deps.paths.files.plan));
      r.github.openPull = OPEN_PULL;

      await runProvision(r.deps, { services: r.services });

      const applied = r.hosts.applies.slice(before + 2);
      expect(
        applied.map((a) => [
          a.host,
          a.plan.app,
          a.plan.steps.map((s) => [s.id, s.params.remove ?? false]),
        ]),
      ).toEqual([
        [STAGING_IPV4, "shop-staging", [["alloy", true]]],
        [STAGING_DATA_IPV4, "shop-staging", [["alloy", true]]],
        [MONITORING_IPV4, "shop", [["monitoring", false]]],
        [
          MONITORING_IPV4,
          "shop-staging",
          [
            ["network-filter", true],
            ["network", true],
          ],
        ],
        [STAGING_DATA_IPV4, "shop-staging", [["grant", true]]],
      ]);
      // The stack keeps prod's network only.
      const compose = fileOf(applied[2]?.plan, "monitoring", "compose.yaml");
      const outside = r.staging.plan.network?.members.find((m) => m.name === "monitoring");
      expect(compose).not.toContain(`${outside?.address}:`);
      expect(applied[3]?.plan.steps[1]?.params.otherInterfaces).toBe("wg-opscrew0");
      // Nothing of monitoring is left on this computer for staging.
      expect(await monitoringValues(r.deps)).toBeUndefined();
    });
  },
);

describe.skipIf(skipNoGit)("provision once monitoring is off", () => {
  it("removes Alloy everywhere, reverts it to Grafana Cloud alone where that is on, then the login", async () => {
    const { plan, privateKeys } = ownerPlan();
    const withCloud = DeployPlanSchema.parse({
      ...plan,
      observability: {
        ...plan.observability,
        grafanaCloud: {
          enabled: true,
          version: "1.21.3",
          metrics: { url: "https://prometheus.example.grafana.net/api/prom/push", user: "1" },
          logs: { url: "https://logs.example.grafana.net/loki/api/v1/push", user: "2" },
        },
      },
    });
    const token = fakeSecret("generic-password", "grafana-cloud");
    const s = await setup({ plan: withCloud, privateKeys });
    s.deps.env.OPSCREW_GRAFANA_CLOUD_TOKEN = token;
    await runProvision(s.deps, { services: s.services });
    const before = s.hosts.applies.length;
    // Grafana Cloud's Alloy on the app's server sends to both.
    expect(appliesOf(s, "alloy", SERVER_IPV4)[0]?.options.secrets).toEqual({
      grafanaCloudToken: token,
    });
    for (const [host, projects] of [
      [SERVER_IPV4, ["opscrew-edge", "shop"]],
      [DATA_IPV4, ["shop"]],
    ] as const) {
      s.hosts.facts[host] = cloudFacts(projects, {
        alloy: {
          destinations: host === SERVER_IPV4 ? ["grafanaCloud", "monitoring"] : ["monitoring"],
          files: {},
        },
      });
    }
    const off = await monitoringDisable(
      s.deps,
      await readArtifact("plan", s.deps.paths.files.plan),
    );
    s.github.openPull = OPEN_PULL;
    expect(off.plan.servers?.map((server) => server.name)).toEqual(["data"]);

    await runProvision(s.deps, { services: s.services });

    const applied = s.hosts.applies.slice(before + 2);
    expect(
      applied.map((a) => [
        a.host,
        a.plan.steps.map((step) => [step.id, step.params.remove ?? false]),
      ]),
    ).toEqual([
      [SERVER_IPV4, [["alloy", false]]],
      [DATA_IPV4, [["alloy", true]]],
      [DATA_IPV4, [["grant", true]]],
    ]);
    // Back to feature 017's Alloy: Grafana Cloud alone, with its token.
    expect(applied[0]?.plan.steps[0]?.params).not.toHaveProperty("destinations");
    expect(applied[0]?.options.secrets).toEqual({ grafanaCloudToken: token });
    expect(hostTitles(s).slice(-3)).toEqual([
      "Send the logs and figures of the app's server to Grafana Cloud alone again (Grafana Alloy)",
      "Remove Grafana Alloy from server data: self-hosted monitoring is off",
      "Remove OpsCrew's monitoring login from db on server data",
    ]);
    expect(await monitoringValues(s.deps)).toBeUndefined();
    expect(await shownText(s)).not.toContain(token);
  });

  it("removes the stack on the app's server with its data only after the app's name is typed", async () => {
    const { plan, privateKeys } = networked(monitoredPlan({ on: "app" }));
    const s = await setup({
      plan,
      privateKeys,
      engine: new FakeEngine({ outputs: outputs(SERVER_IPV4, { data: DATA_IPV4 }) }),
    });
    // The stack and Alloy run on the app's server, Alloy and the login on data, as inspection reads.
    await runProvision(s.deps, { services: s.services });
    const before = s.hosts.applies.length;
    await monitoringDisable(s.deps, await readArtifact("plan", s.deps.paths.files.plan));
    s.github.openPull = OPEN_PULL;

    await runProvision(s.deps, { services: s.services });

    const applied = s.hosts.applies.slice(before + 2);
    expect(applied.map((a) => [a.host, a.plan.steps.map((step) => step.id)])).toEqual([
      [SERVER_IPV4, ["alloy"]],
      [DATA_IPV4, ["alloy"]],
      [SERVER_IPV4, ["monitoring"]],
      [DATA_IPV4, ["grant"]],
    ]);
    expect(applied[2]?.plan).toMatchObject({ deleteData: true });
    expect(applied[2]?.plan.steps[0]?.params).toMatchObject({ remove: true, removeData: true });
    // Nothing of it is left: a provision after it reaches no server for monitoring.
    expect(s.hosts.facts[SERVER_IPV4]?.monitoring).toBeUndefined();
    expect(await monitoringValues(s.deps)).toBeUndefined();
    const removal = s.handler.requests.find(
      (r) => r.kind === "host-apply" && r.title.startsWith("Remove the monitoring stack"),
    );
    expect(removal).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(removal?.details).toContain("the figures and logs it kept are deleted with it");
  });

  it("deletes its own monitoring server through the infrastructure plan, by its typed name", async () => {
    const { plan, privateKeys } = ownerPlan();
    const s = await setup({ plan, privateKeys });
    await runProvision(s.deps, { services: s.services });
    await monitoringDisable(s.deps, await readArtifact("plan", s.deps.paths.files.plan));
    s.github.openPull = OPEN_PULL;
    const engine = new FakeEngine({
      outputs: outputs(SERVER_IPV4, { data: DATA_IPV4 }),
      changes: [
        {
          address: "module.server_monitoring.hcloud_server.this",
          type: "hcloud_server",
          name: "this",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "delete",
        },
      ],
    });
    s.services.engine = async () => engine;

    await runProvision(s.deps, { services: s.services });

    const iac = s.handler.requests.filter((r) => r.kind === "iac-apply").at(-1);
    expect(iac).toMatchObject({ allowDestroy: true, confirmPhrase: "shop-monitoring" });
  });
});

describe("monitoringHostPlans without monitoring", () => {
  it("reaches no server and plans nothing", async () => {
    const deps = await createTestPhaseDeps();
    const { plan } = networked(splitPlan());
    const reached: string[] = [];
    const outcomes = await monitoringHostPlans(deps, plan, {
      services: {
        remote: (host) => {
          reached.push(host);
          return readyRemote(host);
        },
      },
      ownRun: undefined,
      extraOwn: [],
      planOnly: false,
      command: "opscrew provision",
      phase: "provision",
    });
    expect(outcomes).toEqual([]);
    expect(reached).toEqual([]);
    expect(deps.audit.entries).toEqual([]);
  });
});

describe("monitoringStackInput", () => {
  it("lists the owner's network, then each sender's, at the stack's address on each", () => {
    const owner = ownerPlan().plan;
    const sender = networked(senderPlan(), {
      monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
    }).plan;
    const input = monitoringStackInput(owner, [sender]);
    expect(input.plan).toBe(owner);
    expect(input.settings).toEqual(owner.observability?.monitoring);
    expect(input.networks).toEqual([
      {
        address: addressOf(owner, "monitoring"),
        servers: [addressOf(owner, "app"), addressOf(owner, "data")],
        devices: [],
      },
      {
        address: addressOf(sender, "monitoring"),
        servers: [addressOf(sender, "app"), addressOf(sender, "data")],
        devices: [],
      },
    ]);
    expect(input.hasDevices).toBe(false);
  });
});
