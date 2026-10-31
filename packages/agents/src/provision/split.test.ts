import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { IacEngine, PlanSummary, RemoteExec, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork, type NetworkHostFacts } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { providerProfile } from "../providers";
import { FakeCloudRunnerHost } from "../runners/__fixtures__/cloud-host";
import { generatedValuesFile, recordGeneratedEntries } from "../shared/app-secrets";
import { lastServerSetup } from "../shared/host-plan";
import {
  readServerAddresses,
  recordOwnServer,
  updateServerAddresses,
} from "../shared/server-record";
import { writeKnownHost } from "../shared/wait";
import {
  createProject,
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  FakeRunnerGitHub,
  fakeSharedCloudflare,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  planJsonFor,
  preparedServerFacts,
  publicOutputs,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedRunner,
  SERVER_IPV4,
  SERVER_IPV6,
  testKeyMaker,
  testPlan,
  writeFakeState,
} from "../testing";
import { runProvision } from "./run";
import { isRemovalLiftRequest } from "./servers";
import type { ProvisionServices } from "./types";

const DATA_IPV4 = "203.0.113.30";
const DATA_IPV6 = "2001:db8::30";
/** The pull request the first run opened, while it is still open. */
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const HCLOUD = fakeSecret("hcloud-token");
const STRIPE = fakeSecret("stripe-live-key");

/** The state's outputs after an apply: the app's server and the extra server `data`. */
function splitOutputs(extra: Record<string, unknown> = {}) {
  return {
    server_ipv4: SERVER_IPV4,
    server_ipv6: SERVER_IPV6,
    server_id: "4711",
    server_name: "shop",
    url: `http://${SERVER_IPV4}`,
    extra_servers: {
      data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6, id: "4712", name: "shop-data" },
      ...extra,
    },
  };
}

/** What deploy reads on a server OpsCrew created: a fresh Ubuntu, root only through Docker. */
function cloudFacts(network: HostFacts["network"] = null): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    network,
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
  const inspected: { host: string; rootImage: string }[] = [];
  const applies: CloudApply[] = [];
  return {
    inspected,
    applies,
    adapter: {
      async inspect(remote: RemoteExec, options: { rootImage: string }) {
        inspected.push({ host: remote.host, rootImage: options.rootImage });
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

/**
 * Real git, `ssh` that works, and `ssh-keyscan` answering with {@link ED25519}: on port 22 as
 * a server OpsCrew created presents it, elsewhere named `[host]:port` as for the user's own.
 */
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

/** The split plan (`db` on server `data`) on its private network, with the keys design made. */
function networkedPlan(data: "cloud" | "own" = "cloud") {
  const base = splitPlan({ data });
  const facts: Record<string, NetworkHostFacts> =
    data === "own" ? { data: { udpPortsInUse: [], wireguardInterfaces: [] } } : {};
  const { network, privateKeys } = allocateNetwork(base, facts, testKeyMaker(data));
  return { plan: withNetwork(base, network), privateKeys };
}

interface SplitSetup {
  plan: DeployPlan;
  privateKeys: Record<string, string>;
  /** The engine fake (default {@link FakeEngine} with {@link splitOutputs}); it lists its calls. */
  engine?: IacEngine & { readonly calls: string[] };
  facts?: Record<string, HostFacts>;
  services?: ProvisionServices;
}

async function setup(o: SplitSetup) {
  const project = await createProject(o.plan);
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const engine = o.engine ?? new FakeEngine({ outputs: splitOutputs() });
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: keyscanRunner(),
    approvalHandler: handler,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  // Design keeps the network's private keys with the generated values.
  await recordGeneratedEntries(deps, "network", o.privateKeys);
  const hosts = cloudHosts(o.facts ?? {});
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    serverHost: hosts.adapter,
    ...o.services,
  };
  return { ...project, deps, engine, github, handler, services, hosts };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The user's own server `data`: a fresh Ubuntu at {@link OWN_IPV4} answering SSH on 2222. */
function ownDataFacts(facts: Partial<HostFacts> = {}): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      sshPorts: [2222],
      addresses: [{ interface: "eth0", family: "ipv4", address: OWN_IPV4, public: true }],
    }),
    ...facts,
  });
}

/**
 * {@link setup} with `data` the user's own server (a fresh Ubuntu answering SSH on 2222, with
 * `facts` over it): its address and login on this computer, its host key pinned at design.
 */
async function ownExtraSetup(
  plan: DeployPlan,
  privateKeys: Record<string, string>,
  facts: Partial<HostFacts> = {},
) {
  const own = new FakeHostServer(ownDataFacts(facts));
  const s = await setup({
    plan,
    privateKeys,
    engine: new FakeEngine(),
    services: { own: { host: own } },
  });
  await updateServerAddresses(s.deps.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: OWN_IPV4 } },
    ownServers: {
      data: { host: OWN_IPV4, port: 2222, user: "root", agent: true, hostKey: ED25519_FINGERPRINT },
    },
  }));
  return { ...s, own };
}

/**
 * {@link setup} with the app on the user's own server (public mode on Cloudflare, a fresh Ubuntu),
 * whose engine has `outputs` after its apply; run it with the host key `ED25519_FINGERPRINT`.
 */
async function ownAppSetup(
  plan: DeployPlan,
  privateKeys: Record<string, string>,
  outputs: Record<string, unknown> = publicOutputs(),
) {
  const own = new FakeHostServer();
  const engine = new OwnEngine(PUBLIC_CHANGES, outputs);
  const s = await setup({
    plan,
    privateKeys,
    engine,
    services: {
      own: { host: own },
      cloudflare: ownCloudflare(),
      providers: {
        hetzner: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
      },
    },
  });
  delete s.deps.env.TF_VAR_server_ipv4;
  delete s.deps.env.TF_VAR_server_ipv6;
  await recordOwnServer(s.deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  return { ...s, own, ownEngine: engine };
}

/** `plan` with Portainer on, reached only from the server (and its private address). */
function withPortainer<P extends Omit<DeployPlan, "network">>(plan: P): P {
  return { ...plan, portainer: { enabled: true, version: "2.45.2", access: "local" } };
}

/** `plan` on its private network with the device `laptop`; `own` names the user's own servers. */
function withLaptop(plan: Omit<DeployPlan, "network">, own: readonly string[]) {
  const keys = testKeyMaker("laptop");
  const facts = Object.fromEntries(
    own.map((name) => [name, { udpPortsInUse: [], wireguardInterfaces: [] }]),
  );
  const { network, privateKeys } = allocateNetwork(plan, facts, keys);
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const laptop = {
    name: "laptop",
    address: `${prefix}.100`,
    publicKey: keys().publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  };
  return {
    plan: withNetwork(plan, { ...network, devices: [laptop] }),
    privateKeys,
    prefix,
  };
}

/** Every user-visible or persisted text of the run, the saved plans and the committed files. */
async function everything(s: Setup): Promise<string> {
  const plans = s.deps.paths.files.plansDir;
  const saved = await Promise.all(
    (await readdir(plans)).map((name) => readFile(join(plans, name), "utf8")),
  );
  const committed = await s.git(s.root, "show", "HEAD");
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    ...saved,
    committed,
  ].join("\n");
}

const titles = (s: Setup, kind: string) =>
  s.handler.requests.filter((r) => r.kind === kind).map((r) => r.title);

const stepOf = (plan: HostPlan, id: string) => plan.steps.find((step) => step.id === id);

describe.skipIf(!findExecutable("git"))("runProvision with extra servers", () => {
  it("creates the extra cloud server, links each server by its own host plan and stores each server's secrets", async () => {
    const { plan, privateKeys } = networkedPlan();
    const tried: string[] = [];
    const s = await setup({
      plan,
      privateKeys,
      services: {
        tcpConnect: async (host) => {
          tried.push(host);
          return true;
        },
      },
    });
    // A grant's password the device logins keep with the generated values.
    const grant = randomBytes(16).toString("hex");
    await recordGeneratedEntries(s.deps, "grants", { "laptop/db": grant });

    const result = await runProvision(s.deps, { services: s.services });

    // With public SSH open, each new server is awaited at its public address.
    expect(tried).toEqual([SERVER_IPV4, DATA_IPV4]);

    // The network's host plans after the infrastructure, one per server, `app` first, each
    // approved by its own hash, before the secrets and the pull request.
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "host-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    const network = titles(s, "host-apply");
    expect(network[0]).toMatch(/^Apply the private network's host plan to server app /);
    expect(network[1]).toMatch(/^Apply the private network's host plan to server data /);
    expect(s.handler.requests.find((r) => r.kind === "host-apply")?.details).toContain(
      "Host plan for server app",
    );

    // The extra server's address is on this computer only, and its host key is pinned.
    expect((await readServerAddresses(s.deps.paths)).servers).toEqual({
      data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6 },
    });
    await expect(readFile(s.deps.paths.files.knownHosts, "utf8")).resolves.toContain(
      `${DATA_IPV4} ssh-ed25519 ${ED25519}`,
    );

    // Each server inspected and changed as deploy, root through Docker in the pinned image.
    expect(s.hosts.inspected).toEqual([
      { host: SERVER_IPV4, rootImage: IMAGES.caddy.ref },
      { host: DATA_IPV4, rootImage: IMAGES.caddy.ref },
    ]);
    expect(s.hosts.applies.map((a) => [a.host, a.options.rootImage])).toEqual([
      [SERVER_IPV4, IMAGES.caddy.ref],
      [DATA_IPV4, IMAGES.caddy.ref],
    ]);
    // Neither server holds its key yet, so each gets its own, and only its own.
    expect(s.hosts.applies.map((a) => a.options.secrets?.wireguardKey)).toEqual([
      privateKeys.app,
      privateKeys.data,
    ]);
    // Postgres is published on data's private address: its host's own containers may reach it,
    // and its filter lets the app's server in.
    const [app, data] = s.hosts.applies.map((a) => a.plan);
    expect(stepOf(app as HostPlan, "network")?.params.localPorts).toBe("");
    expect(stepOf(data as HostPlan, "network")?.params).toMatchObject({
      localPorts: "5432",
      sshPort: 22,
    });
    expect(stepOf(data as HostPlan, "network-filter")?.title).toContain("TCP port 5432");

    // The deploy reaches the extra server with its own secrets.
    expect(s.github.secrets.get("OPSCREW_SERVER_DATA_HOST")).toBe(DATA_IPV4);
    expect(s.github.secrets.get("OPSCREW_SERVER_DATA_KNOWN_HOSTS")).toBe(
      `${DATA_IPV4} ssh-ed25519 ${ED25519}\n`,
    );
    // The pull request carries the extra server's Compose file and the workflow.
    const committed = await s.git(s.root, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain("opscrew/runtime/servers/data/compose.yaml");
    expect(committed).toContain(".github/workflows/opscrew-deploy.yml");
    expect(result.serverHostPlanHashes).toHaveLength(2);

    // The approvals are on record, and where each service runs from now on, also in the commit.
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.approvals.filter((a) => a.kind === "host-apply")).toHaveLength(2);
    expect(after.deployment.placement).toEqual({ db: "data" });
    expect(await s.git(s.root, "show", "HEAD:opscrew/plan.yaml")).toContain("placement:");

    // Provision's rewrite of the generated values keeps the network's keys and the grants.
    const generated = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8"));
    expect(generated.network).toEqual(privateKeys);
    expect(generated.grants).toEqual({ "laptop/db": grant });

    // No private key reaches a plan, the output, the audit log or the repository.
    const text = await everything(s);
    for (const key of Object.values(privateKeys)) expect(text).not.toContain(key);
    expect(text).not.toContain(grant);
    expect(text).not.toContain(STRIPE);
  });

  it("passes a server's private key only when it lacks it or holds another", async () => {
    const { plan, privateKeys } = networkedPlan();
    const data = plan.network?.members.find((m) => m.name === "data");
    const holds = (publicKey: string): HostFacts["network"] => ({
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
    });
    const s = await setup({
      plan,
      privateKeys,
      // The app's server holds another key; data holds its own.
      facts: {
        [SERVER_IPV4]: cloudFacts(holds(testKeyMaker("other")().publicKey)),
        [DATA_IPV4]: cloudFacts(holds(data?.publicKey ?? "")),
      },
    });

    await runProvision(s.deps, { services: s.services });

    expect(s.hosts.applies.map((a) => a.options.secrets)).toEqual([
      { wireguardKey: privateKeys.app },
      {},
    ]);
  });

  it("stops before a server's plan when it needs its key and this computer has none", async () => {
    const { plan, privateKeys } = networkedPlan();
    const s = await setup({ plan, privateKeys: { app: privateKeys.app as string } });

    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      /Server data needs its private network key, and this computer does not have it/,
    );
    expect(s.hosts.applies.map((a) => a.host)).toEqual([SERVER_IPV4]);
  });

  it("with --plan-only, leaves the network's host plans for when the servers exist", async () => {
    const { plan, privateKeys } = networkedPlan();
    const s = await setup({ plan, privateKeys });

    const result = await runProvision(s.deps, { services: s.services, planOnly: true });

    expect(s.handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(s.deps.reporter.text()).toContain(
      "The private network's host plans follow once every server exists and is set up",
    );
    expect(result.serverHostPlanHashes).toBeUndefined();
  });

  it("with --plan-only on servers that exist, shows each server's plan, and --approve takes one hash per server", async () => {
    const { plan, privateKeys } = networkedPlan();
    const deployed = DeployPlanSchema.parse({
      ...plan,
      deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z", placement: { db: "data" } },
    });
    const s = await setup({ plan: deployed, privateKeys });
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6 } },
    }));

    const planned = await runProvision(s.deps, { services: s.services, planOnly: true });

    expect(planned.serverHostPlanHashes).toHaveLength(2);
    expect(s.hosts.applies).toEqual([]);
    // In scripts every plan is approved by its own hash, and nothing else is.
    const hashes = [planned.planHash as string, ...(planned.serverHostPlanHashes ?? [])];
    const byHash = new ScriptedApprovalHandler((request) =>
      request.kind === "iac-apply" || request.kind === "host-apply"
        ? hashes.includes(request.planHash ?? "")
        : true,
    );
    const deps = await createTestPhaseDeps({
      root: s.root,
      env: s.deps.env,
      runner: keyscanRunner(),
      approvalHandler: byHash,
    });
    await runProvision(deps, { services: s.services, approveHashes: hashes });

    expect(s.hosts.applies.map((a) => a.host)).toEqual([SERVER_IPV4, DATA_IPV4]);
    expect(byHash.requests.filter((r) => r.kind === "host-apply").map((r) => r.planHash)).toEqual(
      planned.serverHostPlanHashes,
    );
  });

  it("in a script that names an applied infrastructure plan again, plans afresh rather than applying it twice", async () => {
    const { plan, privateKeys } = networkedPlan();
    const deployed = DeployPlanSchema.parse({
      ...plan,
      deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z", placement: { db: "data" } },
    });
    const engine = new FakeEngine({ outputs: splitOutputs() });
    const s = await setup({ plan: deployed, privateKeys, engine });
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6 } },
    }));
    const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
    const infrastructure = planned.planHash as string;
    const approved = [infrastructure];
    const byHash = new ScriptedApprovalHandler((request) =>
      request.kind === "iac-apply" || request.kind === "host-apply"
        ? approved.includes(request.planHash ?? "")
        : true,
    );
    const deps = await createTestPhaseDeps({
      root: s.root,
      env: s.deps.env,
      runner: keyscanRunner(),
      approvalHandler: byHash,
    });
    // Only the infrastructure plan's hash: it is applied, and the run stops at the host plans.
    await expect(
      runProvision(deps, { services: s.services, approveHashes: [infrastructure] }),
    ).rejects.toBeInstanceOf(OpsCrewError);
    const applies = () => s.engine.calls.filter((call) => call === "apply").length;
    expect(applies()).toBe(1);

    // Every hash again, as a script gives them: the applied plan is not applied twice (a real
    // engine refuses a stale saved plan); a fresh plan finds nothing to change.
    approved.push(...(planned.serverHostPlanHashes ?? []));
    engine.scenario.changes = [];
    await runProvision(deps, { services: s.services, approveHashes: [...approved] });
    expect(applies()).toBe(1);
    expect(s.hosts.applies.map((a) => a.host)).toEqual([SERVER_IPV4, DATA_IPV4]);
  });

  it("refuses a live service placed on another server by hand, before anything changes", async () => {
    const { plan, privateKeys } = networkedPlan();
    // db runs on the app's server; plan.yaml was edited to place it on data, without design's move.
    const edited = DeployPlanSchema.parse({
      ...plan,
      deployment: {
        lastApplyAt: "2026-10-12T08:00:00.000Z",
        firstDeployAt: "2026-10-12T09:00:00.000Z",
        placement: { db: "app" },
      },
    });
    const s = await setup({ plan: edited, privateKeys });

    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      message: expect.stringMatching(/places db on server data, but it runs on the app's server/),
      hint: expect.stringContaining("Run `opscrew design`"),
    });
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
  });

  /**
   * db moving to data at `step`, with its password on this computer, and the app's settings on the
   * app's server using db's copy on `uses` (`data` when an earlier window switched them and was
   * interrupted): `url` is db's address on data.
   */
  async function movingSetup(step: "started" | "deployed", uses: "app" | "data") {
    const { plan, privateKeys } = networkedPlan();
    const moving = DeployPlanSchema.parse({
      ...plan,
      deployment: {
        lastApplyAt: "2026-10-12T08:00:00.000Z",
        firstDeployAt: "2026-10-12T09:00:00.000Z",
        placement: { db: "app" },
      },
      move: { service: "db", from: "app", to: "data", step, copy: "dump" },
    });
    const s = await setup({ plan: moving, privateKeys });
    const password = randomBytes(16).toString("hex");
    const file = generatedValuesFile(s.deps);
    const kept = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...kept, dbPassword: password }));
    const data = moving.network?.members.find((m) => m.name === "data")?.address;
    const url = `postgresql://app:${password}@${data}:5432/app`;
    const used = uses === "data" ? url : `postgresql://app:${password}@db:5432/app`;
    s.services.remote = (host) =>
      host === SERVER_IPV4
        ? {
            host,
            run: async (command, options) =>
              command === "cat /srv/apps/shop/app.env"
                ? { exitCode: 0, stdout: `DATABASE_URL=${used}\n\n`, stderr: "" }
                : readyRemote(host).run(command, options),
          }
        : readyRemote(host);
    return { ...s, url };
  }

  it("hands a move over once everything else is set up", async () => {
    const s = await movingSetup("started", "app");

    await runProvision(s.deps, { services: s.services });
    // The move waits for the deploy of these files to start db's new copy on data.
    expect(s.deps.reporter.text()).toContain(
      "db moves to server data once the deploy has started its new copy there",
    );
    // Everything before the move is done, and the placement waits for the move.
    expect(s.github.pulls).toHaveLength(1);
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.deployment.placement).toEqual({ db: "app" });
    expect(after.move?.step).toBe("started");
  });

  it("records a switch the app's server already made before it stores the settings, even when publishing then fails", async () => {
    const s = await movingSetup("deployed", "data");
    s.github.createPullRequest = async () => {
      throw new Error("GitHub is down");
    };

    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow();
    expect(s.github.secrets.get("OPSCREW_APP_ENV")).toContain(`DATABASE_URL=${s.url}`);
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.move?.step).toBe("switched");
  });

  it("records the switch from a plan that still says started, as committed", async () => {
    const s = await movingSetup("started", "data");
    await runProvision(s.deps, { services: s.services });
    expect(s.github.secrets.get("OPSCREW_APP_ENV")).toContain(`DATABASE_URL=${s.url}`);
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.move?.step).toBe("switched");
  });

  it("doesn't record the switch when the new settings can't be stored in GitHub", async () => {
    const s = await movingSetup("deployed", "data");
    s.github.setActionsSecret = async () => {
      throw new OpsCrewError("COMMAND_FAILED", "GitHub is down.");
    };
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(/GitHub is down/);
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.move?.step).toBe("deployed");
  });

  it("sets up an extra server the user owns with its own host plan, kept as that server's setup", async () => {
    const { plan, privateKeys } = networkedPlan("own");
    const s = await ownExtraSetup(plan, privateKeys);
    const { own } = s;

    await runProvision(s.deps, { services: s.services });

    expect(titles(s, "host-apply")).toEqual([
      expect.stringMatching(/^Apply the host plan to server data \(\d+ changes\)$/),
      expect.stringMatching(/^Apply the private network's host plan to server app /),
      expect.stringMatching(/^Apply the private network's host plan to server data /),
    ]);
    // The own-server setup, as root over the admin login; then its network with sshd's own port.
    const [setupPlan, networkPlan] = own.applies.map((a) => a.plan);
    expect(stepOf(setupPlan as HostPlan, "sshd")).toBeDefined();
    expect(stepOf(networkPlan as HostPlan, "network")?.params.sshPort).toBe(2222);
    expect(own.applies[1]?.options.rootImage).toBeUndefined();

    // Its last setup plan is kept per server, never as the app's server's approval.
    const kept = await lastServerSetup(s.deps, "data");
    expect(kept && hostPlanHash(kept)).toBe(hostPlanHash(setupPlan as HostPlan));
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.approvals.map((a) => a.planHash)).not.toContain(
      hostPlanHash(setupPlan as HostPlan),
    );

    // The deploy reaches it on its login's port, its host key under `[host]:port`.
    expect(s.github.secrets.get("OPSCREW_SERVER_DATA_HOST")).toBe(OWN_IPV4);
    expect(s.github.secrets.get("OPSCREW_SERVER_DATA_KNOWN_HOSTS")).toBe(
      `[${OWN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    );
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain("2222");
  });

  it("opens no web ports on an extra server the user owns, and something on port 80 there is no conflict", async () => {
    const { plan, privateKeys } = networkedPlan("own");
    const s = await ownExtraSetup(plan, privateKeys, {
      listeners: [
        { proto: "tcp", address: "0.0.0.0", port: 2222, process: "sshd" },
        { proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" },
      ],
      firewall: {
        ufw: "active",
        ufwRules: [{ rule: "allow 80/tcp", comment: null }],
        ufwDefaults: { incoming: "deny", outgoing: "allow", routed: "disabled" },
        foreign: [],
      },
    });

    await runProvision(s.deps, { services: s.services });

    const setupPlan = s.own.applies[0]?.plan as HostPlan;
    expect(setupPlan.findings).toEqual([]);
    expect(stepOf(setupPlan, "ufw")?.params).toMatchObject({ webRules: "" });
    expect(stepOf(setupPlan, "ufw")?.title).not.toContain("HTTP");
  });

  it("gives an extra server the user owns the scheduled check's key, as root, once", async () => {
    const { plan, privateKeys } = networkedPlan("own");
    const checked = DeployPlanSchema.parse({
      ...plan,
      observability: { check: { enabled: true } },
    });
    const s = await ownExtraSetup(checked, privateKeys);

    await runProvision(s.deps, { services: s.services });

    expect(titles(s, "host-apply")).toContain(
      "Let the scheduled check of acme/shop read the disk of server data with its own key",
    );
    const step = s.own.applies.flatMap((a) => a.plan.steps).find((st) => st.id === "check-key");
    expect(step?.params).toMatchObject({ repository: "acme/shop", runAs: "root" });

    // Once the server lists the repository's check key, no step is planned for it.
    s.own.facts = {
      ...s.own.facts,
      deployUser: {
        groups: ["deploy", "docker"],
        keys: s.own.facts.deployUser?.keys ?? [],
        checkKeys: ["acme/shop"],
      },
    };
    s.github.openPull = OPEN_PULL;
    s.handler.requests.length = 0;
    await runProvision(s.deps, { services: s.services });
    expect(titles(s, "host-apply").some((t) => t.includes("scheduled check"))).toBe(false);
  });

  it("puts Portainer on the own app server's private address once the network is up there", async () => {
    const { plan, privateKeys, prefix } = withLaptop(withPortainer(ownPlan()), ["app"]);
    const s = await ownAppSetup(plan, privateKeys);
    const privatePort = `${prefix}.1:9443:9443`;
    const portainerCompose = (hostPlan: HostPlan | undefined) =>
      String(hostPlan && stepOf(hostPlan, "portainer")?.params.composeFinal);

    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });

    // The setup comes first, without the private address the network plan after it brings up.
    const [setupPlan, networkPlan] = s.own.applies.map((a) => a.plan);
    expect(portainerCompose(setupPlan)).not.toContain(privatePort);
    expect(stepOf(networkPlan as HostPlan, "network")).toBeDefined();
    expect(s.deps.reporter.text()).toContain(
      "Portainer's web UI goes on your server's private address at the next `opscrew provision`",
    );

    // Once the server has the network's interface, the next run publishes it there.
    const member = plan.network?.members.find((m) => m.name === "app");
    s.own.facts = HostFactsSchema.parse({
      ...s.own.facts,
      network: {
        dropIn: null,
        interfaces: [
          {
            name: "wg-opscrew0",
            config: "0".repeat(64),
            publicKey: member?.publicKey ?? "",
            enabled: true,
            active: true,
            addresses: [`${prefix}.1/24`],
            peers: [],
          },
        ],
        filterUnit: null,
        filters: [],
      },
    });
    s.ownEngine.changes = [];
    s.github.openPull = OPEN_PULL;
    await runProvision(s.deps, { services: s.services });
    const last = s.own.applies.filter((a) => stepOf(a.plan, "portainer") !== undefined).at(-1);
    expect(portainerCompose(last?.plan)).toContain(privatePort);
  });

  it("lets the devices reach the app server's dashboards on its private address, through the filter", async () => {
    const { plan, privateKeys, prefix } = withLaptop(withPortainer(splitPlan()), []);
    const s = await setup({ plan, privateKeys });

    await runProvision(s.deps, { services: s.services });

    const [app] = s.hosts.applies.map((a) => a.plan);
    const filter = stepOf(app as HostPlan, "network-filter");
    expect(filter?.title).toContain("TCP port 9443");
    expect(filter?.reason).toContain(`9443 from ${prefix}.100`);
  });

  it("gives an extra cloud server the check's key at its first boot under the user's own app server", async () => {
    const { plan: networked, privateKeys } = withLaptop(splitPlan({ app: "own" }), ["app"]);
    const plan = DeployPlanSchema.parse({
      ...networked,
      observability: { check: { enabled: true } },
    });
    const s = await ownAppSetup(plan, privateKeys, {
      ...publicOutputs(),
      extra_servers: { data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6, id: "4712", name: "shop-data" } },
    });

    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });

    const infra = join(s.root, plan.infra.dir);
    const main = await readFile(join(infra, "main.tf"), "utf8");
    const module = main.slice(main.indexOf('module "server_data"'));
    expect(module.slice(0, module.indexOf("\n}\n"))).toContain("check_key_line");
    const tfvars = JSON.parse(await readFile(join(infra, "terraform.tfvars.json"), "utf8"));
    expect(tfvars.check_key_line).toContain("acme/shop");
    expect(s.github.secrets.get("OPSCREW_SERVER_DATA_HOST")).toBe(DATA_IPV4);
  });

  it("refuses before any change when the token of an extra server's provider is missing", async () => {
    const split = splitPlan();
    const { plan, privateKeys } = withLaptop(
      {
        ...split,
        servers: [
          {
            name: "data",
            target: {
              provider: "digitalocean",
              mode: "vps-compose",
              location: "fra1",
              serverType: "s-1vcpu-2gb",
              image: "ubuntu-24-04-x64",
              backups: false,
            },
          },
        ],
      },
      [],
    );
    const s = await setup({ plan, privateKeys });
    for (const name of providerProfile("digitalocean").tokenVars) delete s.deps.env[name];

    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(/DigitalOcean/);
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
  });

  it("stops before any change when MongoDB goes on an extra server whose CPU lacks AVX", async () => {
    const base = splitPlan({ data: "own" });
    const mongo = {
      ...base,
      services: [
        ...base.services,
        {
          kind: "mongodb",
          version: "8.0",
          memoryMb: 512,
          reason: "The app uses mongoose.",
          licence: "SSPL-1.0",
          server: "data",
        },
      ],
    } as Omit<DeployPlan, "network">;
    const facts = { data: { udpPortsInUse: [], wireguardInterfaces: [] } };
    const { network, privateKeys } = allocateNetwork(mongo, facts, testKeyMaker("mongo"));
    const s = await ownExtraSetup(withNetwork(mongo, network), privateKeys, { avx: false });

    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      "Server data's CPU lacks AVX, which MongoDB needs on x86 since version 5, so the service mongodb could not start there. Nothing was changed.",
    );
    expect(s.handler.requests).toEqual([]);
    expect(s.own.applies).toEqual([]);
  });

  /**
   * The deployed split plan without server `data`, whose state, address, deploy secrets and
   * protection the last run left (`RemovalEngine`).
   */
  async function removalSetup(engine = new RemovalEngine()) {
    const { plan: split, privateKeys } = networkedPlan();
    const { servers: _servers, network: _network, ...rest } = split;
    const plan = DeployPlanSchema.parse({
      ...rest,
      services: split.services.map(({ server: _server, ...service }) => service),
      deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z" },
    });
    const s = await setup({ plan, privateKeys, engine });
    await writeFakeState(s.deps.paths);
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { data: { ipv4: DATA_IPV4 } },
    }));
    // The last run stored the server's deploy secrets.
    await mkdir(dirname(s.deps.paths.files.deploySecrets), { recursive: true });
    const names = ["OPSCREW_SERVER_DATA_HOST", "OPSCREW_SERVER_DATA_KNOWN_HOSTS"];
    await writeFile(
      s.deps.paths.files.deploySecrets,
      JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names }),
    );
    for (const name of names) s.github.secrets.set(name, DATA_IPV4);
    // The root as the last run left it still declares the server's protection.
    const dir = join(s.root, plan.infra.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "variables.tf"),
      'variable "data_delete_protection" {\n  type    = bool\n  default = true\n}\n',
    );
    return { ...s, engine };
  }

  it("deletes an extra cloud server the plan no longer lists only with its name typed, its protection lifted first", async () => {
    const s = await removalSetup();
    const { engine } = s;

    // A run that applies nothing cannot lift the protection its deletion needs: it stops first,
    // and names the script's way.
    const refusal = runProvision(s.deps, { services: s.services, planOnly: true });
    await expect(refusal).rejects.toThrow(
      /Server data is no longer in servers, so the next plan deletes it/,
    );
    await expect(refusal).rejects.toMatchObject({
      hint: expect.stringContaining(
        "In a script, run `opscrew provision --confirm shop-data --yes`: it lifts the protection, then plans the deletion",
      ),
    });
    expect(s.handler.requests).toEqual([]);

    await runProvision(s.deps, { services: s.services });

    const iac = s.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(iac.map((r) => r.title)).toEqual([
      "Lift delete protection on shop-data",
      expect.stringContaining("Apply the infrastructure plan"),
    ]);
    // The protection is lifted before any file is written, with the server's variable.
    expect(s.handler.requests.map((r) => r.kind).indexOf("repo-write")).toBe(1);
    expect(engine.vars[0]).toEqual({ data_delete_protection: "false" });
    expect(iac[1]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop-data" });
    expect(iac[1]?.details).toContain(
      "Server data is no longer in servers in opscrew/plan.yaml, so this plan deletes it (shop-data)",
    );
    // Both approvals are on record in the plan, the lift's too.
    const recorded = await readArtifact("plan", s.deps.paths.files.plan);
    expect(recorded.approvals.map((a) => a.planHash)).toEqual(
      expect.arrayContaining([iac[0]?.planHash, iac[1]?.planHash]),
    );
    // Gone from the state, it is forgotten on this computer too, and so are its deploy secrets.
    expect((await readServerAddresses(s.deps.paths)).servers).toBeUndefined();
    expect(s.handler.requests.find((r) => r.kind === "github-secrets")?.details).toContain(
      "Deleted, since their services no longer run or their servers are gone (names only):\n  OPSCREW_SERVER_DATA_HOST\n  OPSCREW_SERVER_DATA_KNOWN_HOSTS",
    );
    expect(s.github.secrets.has("OPSCREW_SERVER_DATA_HOST")).toBe(false);
  });

  it("in a script, lifts the protection its --confirm names cover, then only plans the deletion that --approve applies", async () => {
    const s = await removalSetup();
    const { engine } = s;

    // The script's --confirm run: the lift, approved by its hash, then the deletion planned only.
    const planned = await runProvision(s.deps, {
      services: s.services,
      planOnly: true,
      liftConfirmedBy: ["shop-data"],
    });
    expect(titles(s, "iac-apply")).toEqual(["Lift delete protection on shop-data"]);
    const lift = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(lift?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lift !== undefined && isRemovalLiftRequest(lift)).toBe(true);
    expect(engine.vars).toEqual([{ data_delete_protection: "false" }, undefined]);
    expect(planned.applied).toBe(false);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.planHash).not.toBe(lift?.planHash);
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "iac-apply",
        target: lift?.planHash,
        decision: "approved",
      }),
    );
    const recorded = await readArtifact("plan", s.deps.paths.files.plan);
    expect(recorded.approvals.map((a) => a.planHash)).toContain(lift?.planHash);

    // The protection is off, so --plan-only plans the deletion again, and lifts nothing.
    const again = await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(again.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(titles(s, "iac-apply")).toEqual(["Lift delete protection on shop-data"]);

    // --approve applies the deletion, typed by name, and lifts nothing.
    const before = s.handler.requests.length;
    await runProvision(s.deps, { services: s.services, approveHashes: [again.planHash ?? ""] });
    const iac = s.handler.requests.slice(before).filter((r) => r.kind === "iac-apply");
    expect(iac).toEqual([
      expect.objectContaining({
        planHash: again.planHash,
        allowDestroy: true,
        confirmPhrase: "shop-data",
      }),
    ]);
    expect(engine.vars.slice(2).every((vars) => vars === undefined)).toBe(true);
    expect((await readServerAddresses(s.deps.paths)).servers).toBeUndefined();
  });

  it("refuses a lift plan that also turns off the app's server's protection", async () => {
    const s = await removalSetup(new RemovalEngine(["module.server.hcloud_server.this"]));
    const refusal = runProvision(s.deps, {
      services: s.services,
      planOnly: true,
      liftConfirmedBy: ["shop-data"],
    });
    await expect(refusal).rejects.toThrow(
      "Lifting the delete protection on shop-data would also change other things",
    );
    await expect(refusal).rejects.toMatchObject({
      message: expect.stringContaining("update module.server.hcloud_server.this"),
    });
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).not.toContain("apply");
  });

  it("in a script, refuses before any plan when --confirm misses a server the lift covers", async () => {
    const s = await removalSetup();
    const refusal = runProvision(s.deps, {
      services: s.services,
      planOnly: true,
      liftConfirmedBy: ["shop"],
    });
    await expect(refusal).rejects.toThrow(
      "Lifting the delete protection on shop-data needs its name confirmed, so nothing was changed.",
    );
    await expect(refusal).rejects.toMatchObject({
      hint: expect.stringContaining("with --confirm shop-data added"),
    });
    expect(s.engine.vars).toEqual([]);
    expect(s.handler.requests).toEqual([]);
  });

  it("takes the app off an extra server the user owns that the plan no longer lists, with its name typed", async () => {
    const own = new FakeHostServer();
    const s = await setup({
      plan: testPlan({ deployed: true }),
      privateKeys: {},
      engine: new FakeEngine(),
      services: { own: { host: own } },
    });
    own.facts = preparedServerFacts(s.deps.paths.projectId);
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { old: { ipv4: OWN_IPV4 } },
      ownServers: {
        old: { host: OWN_IPV4, port: 22, user: "root", agent: true, hostKey: ED25519_FINGERPRINT },
      },
    }));

    await runProvision(s.deps, { services: s.services });

    const removal = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(removal.map((r) => r.title)).toEqual([
      "Remove shop from server old (its data stays)",
      "Undo OpsCrew's settings on server old",
    ]);
    for (const request of removal) {
      expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "old" });
    }
    expect(own.applies.map((a) => a.plan.purpose)).toEqual(["teardown", "undo"]);
    const record = await readServerAddresses(s.deps.paths);
    expect(record.ownServers).toBeUndefined();
    expect(record.servers).toBeUndefined();
  });

  describe("with public SSH closed", () => {
    /**
     * {@link setup} for the split plan with public SSH closed, deploys on the server's runner and
     * this computer the device `laptop`, after earlier runs pinned the host keys at the public
     * addresses. `tcpConnect` answers only on the private addresses (or nowhere: `offline`), and
     * lists the addresses it was asked for. With `data: "own"`, `data` is the user's own server (a
     * fresh Ubuntu answering SSH on 2222), its login and host key on this computer.
     */
    async function closedSetup(o: { offline?: boolean; data?: "cloud" | "own" } = {}) {
      const own = o.data === "own";
      const {
        plan: open,
        privateKeys,
        prefix,
      } = withLaptop(splitPlan({ data: o.data ?? "cloud" }), own ? ["data"] : []);
      const plan = DeployPlanSchema.parse({
        ...open,
        environment: { ...open.environment, runner: "server" },
        security: { ...open.security, sshAllowedCidrs: [] },
        network: { ...open.network, publicSsh: false },
      });
      // The cloud firewalls lose their SSH rule: the plan's only change.
      const planJson = planJsonFor();
      for (const resource of planJson.planned_values.root_module.child_modules[0]?.resources ??
        []) {
        const values = resource.values as { rule?: { port: string }[] };
        values.rule = values.rule?.filter((rule) => rule.port !== "22");
      }
      const firewall: ResourceChange = {
        address: "module.server.hcloud_firewall.this",
        type: "hcloud_firewall",
        name: "this",
        provider: "hcloud",
        action: "update",
      };
      const { extra_servers: _data, ...appOnly } = splitOutputs();
      const tried: string[] = [];
      // Every address the first-boot (cloud-init) check ran at.
      const firstBoot: string[] = [];
      let clock = 0;
      const s = await setup({
        plan,
        privateKeys,
        engine: new FakeEngine({
          outputs: own ? appOnly : splitOutputs(),
          changes: [firewall],
          planJson,
        }),
        services: {
          tcpConnect: async (host) => {
            tried.push(host);
            return o.offline !== true && host !== SERVER_IPV4 && host !== DATA_IPV4;
          },
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
          runnerHost: new FakeCloudRunnerHost(),
          runnerGitHub: new FakeRunnerGitHub(),
          remote: (host) => {
            const shell = readyRemote(host);
            return {
              host,
              run: async (command, options) => {
                if (command.includes("/var/lib/opscrew-ready")) firstBoot.push(host);
                return shell.run(command, options);
              },
            };
          },
          ...(own ? { own: { host: new FakeHostServer(ownDataFacts()) } } : {}),
        },
      });
      const ownData = {
        servers: { data: { ipv4: OWN_IPV4 } },
        ownServers: {
          data: {
            host: OWN_IPV4,
            port: 2222,
            user: "root",
            agent: true,
            hostKey: ED25519_FINGERPRINT,
          },
        },
      };
      await updateServerAddresses(s.deps.paths, (current) => ({
        ...current,
        deployment: { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 },
        thisDevice: "laptop",
        ...(own ? ownData : { servers: { data: { ipv4: DATA_IPV4, ipv6: DATA_IPV6 } } }),
      }));
      for (const host of own ? [SERVER_IPV4] : [SERVER_IPV4, DATA_IPV4]) {
        await writeKnownHost(s.deps.paths.files.knownHosts, host, [
          { type: "ssh-ed25519", key: ED25519 },
        ]);
      }
      return { ...s, prefix, tried, firstBoot, elapsed: () => clock };
    }

    it("waits for and pins each server on its private address, where the deploy reaches it", async () => {
      const s = await closedSetup();

      await runProvision(s.deps, { services: s.services });

      // Each server is awaited on the network only: the public addresses no longer answer SSH.
      expect(s.tried).toEqual([`${s.prefix}.1`, `${s.prefix}.2`]);
      // Their first-boot checks go there too.
      expect(s.firstBoot).toEqual([`${s.prefix}.1`, `${s.prefix}.2`]);
      expect(s.firstBoot).not.toContain(SERVER_IPV4);
      expect(s.firstBoot).not.toContain(DATA_IPV4);
      const text = s.deps.reporter.text();
      expect(text).toContain(
        `Waiting for the server at ${s.prefix}.1 to accept SSH over the app's private network`,
      );
      expect(text).toContain(
        `Waiting for the server data at ${s.prefix}.2 to accept SSH over the app's private network`,
      );
      // The keys pinned earlier, under the private addresses too; none read again publicly.
      const pinned = await readFile(s.deps.paths.files.knownHosts, "utf8");
      expect(pinned).toContain(`${s.prefix}.1 ssh-ed25519 ${ED25519}`);
      expect(pinned).toContain(`${s.prefix}.2 ssh-ed25519 ${ED25519}`);
      const { calls } = s.deps.runner as ScriptedRunner;
      expect(calls.filter((call) => call.command === "ssh-keyscan")).toEqual([]);
      // The deploy reaches the extra server at its private address, with the key named there.
      expect(s.github.secrets.get("OPSCREW_SERVER_DATA_KNOWN_HOSTS")).toBe(
        `${s.prefix}.2 ssh-ed25519 ${ED25519}\n`,
      );
      expect(s.github.secrets.has("OPSCREW_SERVER_DATA_HOST")).toBe(false);
    });

    it("gives the deploy an extra server the user owns at its private address, as this run reached it", async () => {
      const s = await closedSetup({ data: "own" });

      await runProvision(s.deps, { services: s.services });

      expect(s.github.secrets.get("OPSCREW_SERVER_DATA_KNOWN_HOSTS")).toBe(
        `[${s.prefix}.2]:2222 ssh-ed25519 ${ED25519}\n`,
      );
    });

    it("says this computer's tunnel looks down when a server doesn't answer on the network", async () => {
      const s = await closedSetup({ offline: true });

      const error = await runProvision(s.deps, { services: s.services }).catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "COMMAND_FAILED",
        message: `OpsCrew could not reach server app at its private address ${s.prefix}.1. Public SSH is closed, so OpsCrew connects over the app's private network, and this computer's tunnel (device laptop) looks down.`,
      });
      expect((error as OpsCrewError).hint).toContain("`sudo wg show`");
      expect(s.tried.every((host) => host === `${s.prefix}.1`)).toBe(true);
      // The server exists, so the wait over the network is short: 30 seconds, not 5 minutes.
      expect(s.elapsed()).toBe(30_000);
    });
  });

  it("refuses before any change to take the app off an extra own server while public SSH is closed", async () => {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      environment: { runner: "server" },
      security: { ...base.security, sshAllowedCidrs: [] },
      network: {
        range: "10.200.4.0/24",
        members: [
          {
            name: "app",
            address: "10.200.4.1",
            port: 51820,
            publicKey: Buffer.alloc(32, 1).toString("base64"),
          },
        ],
        publicSsh: false,
      },
    });
    const own = new FakeHostServer();
    const s = await setup({
      plan,
      privateKeys: {},
      engine: new FakeEngine(),
      services: { own: { host: own } },
    });
    await updateServerAddresses(s.deps.paths, (current) => ({
      ...current,
      servers: { old: { ipv4: OWN_IPV4 } },
      ownServers: {
        old: { host: OWN_IPV4, port: 22, user: "root", agent: true, hostKey: ED25519_FINGERPRINT },
      },
    }));

    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "opscrew/plan.yaml no longer lists server old, but public SSH is closed, so OpsCrew could not reach it to take the app off. Nothing was changed.",
      hint: expect.stringContaining(
        "run `opscrew secure --open-public-ssh`, then remove it again and run `opscrew provision`",
      ),
    });
    expect(s.engine.calls).toEqual([]);
    expect(own.applies).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    expect((await readServerAddresses(s.deps.paths)).ownServers?.old).toBeDefined();
  });
});

/**
 * The engine of a deployment whose extra server `data` was removed from the plan: the state lists
 * it until the deletion is applied; the first plan lifts its delete protection, the next deletes it.
 */
class RemovalEngine extends FakeEngine {
  readonly vars: (Record<string, string> | undefined)[] = [];
  #deleted = false;

  /** `liftsAlso`: other servers whose protection the lift plan turns off too. */
  constructor(private readonly liftsAlso: readonly string[] = []) {
    super({ outputs: splitOutputs() });
  }

  override get outputs(): Record<string, unknown> {
    const { extra_servers: _extra, ...rest } = splitOutputs();
    return this.#deleted ? rest : splitOutputs();
  }

  override async plan(
    dir: string,
    planFile: string,
    options?: { vars?: Record<string, string> },
  ): Promise<PlanSummary> {
    this.vars.push(options?.vars);
    const lift = options?.vars !== undefined;
    const server = "module.server_data.hcloud_server.this";
    const lifted = [server, ...this.liftsAlso];
    const changes: ResourceChange[] = lift
      ? lifted.map((address) => ({
          address,
          type: "hcloud_server",
          name: "this",
          provider: "hcloud",
          action: "update",
        }))
      : [
          {
            address: server,
            type: "hcloud_server",
            name: "this",
            provider: "hcloud",
            action: "delete",
          },
          {
            address: "module.server_data.hcloud_firewall.this",
            type: "hcloud_firewall",
            name: "this",
            provider: "hcloud",
            action: "delete",
          },
        ];
    const protection = (on: boolean) => ({ delete_protection: on, rebuild_protection: on });
    this.scenario.changes = changes;
    this.scenario.planJson = lift
      ? {
          resource_changes: lifted.map((address) => ({
            address,
            change: { actions: ["update"], before: protection(true), after: protection(false) },
          })),
        }
      : undefined;
    return super.plan(dir, planFile);
  }

  override async apply(...args: Parameters<FakeEngine["apply"]>) {
    const result = await super.apply(...args);
    if (this.scenario.changes?.some((c) => c.action === "delete")) this.#deleted = true;
    return { ...result, outputs: this.outputs };
  }

  override async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.outputs;
  }
}
