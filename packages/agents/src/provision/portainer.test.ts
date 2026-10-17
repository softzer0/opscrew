import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PortainerCertificateError,
  type PortainerClientDeps,
  type PortainerEndpoint,
  portainerClient,
} from "@opscrew/connector-portainer";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  type PortainerDeployTarget,
  type PortainerWeb,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDns } from "../dns";
import {
  type PortainerConnection,
  type PortainerConnectionInput,
  readPortainerConnection,
  recordPortainerConnection,
} from "../shared";
import {
  deleteTunnelIn,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import {
  createProject,
  createTestPhaseDeps,
  encryptedState,
  FakeEngine,
  FakeGitHub,
  type FakePortainerOptions,
  fakeCertificate,
  fakePortainer,
  fakeZeroTrust,
  MANAGED_TUNNEL,
  ownCloudflare,
  PORTAINER_HOST,
  PORTAINER_URL,
  plainState,
  portainerPlan,
  portainerPlanJson,
  projectRunner,
  ScriptedApprovalHandler,
  withStateList,
  writeFakeState,
} from "../testing";
import {
  portainerContainerUrl,
  portainerValueKeyFile,
  portainerWebhookFile,
  REGISTRY_TOKEN_VAR,
  REPOSITORY_TOKEN_VAR,
  stackPlanFile,
} from "./portainer";
import { runProvision } from "./run";
import { ROUTE_CHANGE_NOTE, switchesWebRoute } from "./stack-plan";
import type { ProvisionOptions, ProvisionServices } from "./types";
import { tunnelTokenPermissions } from "./zero-trust";

const STRIPE = fakeSecret("stripe-live-key");
const PORTAINER_TOKEN = fakeSecret("generic-password", "portainer-token");
const REPO_TOKEN = fakeSecret("github-pat", "repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "ghcr read token");
const TUNNEL_TOKEN = fakeSecret("generic-password", "app tunnel token");
const WEBHOOK_TUNNEL_TOKEN = fakeSecret("generic-password", "webhook tunnel token");
const ACCESS_ID = fakeSecret("generic-password", "access client id");
const ACCESS_SECRET = fakeSecret("generic-password", "access client secret");
const CERT = fakeCertificate();
const UUIDS = ["6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"];

const tunnelChange = (
  module: string,
  type: string,
  name: string,
  action: ResourceChange["action"] = "create",
): ResourceChange => ({
  address: `module.${module}.${type}.${name}`,
  type,
  name,
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action,
});

const APP_TUNNEL: ResourceChange[] = [
  tunnelChange("tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this"),
  tunnelChange("tunnel", "cloudflare_dns_record", "route"),
];
const WEBHOOK_TUNNEL: ResourceChange[] = [
  tunnelChange("portainer_tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this"),
  tunnelChange("access", "cloudflare_zero_trust_access_application", "ssh"),
];

interface SetupOptions {
  plan?: DeployPlan;
  portainer?: Partial<FakePortainerOptions>;
  answer?: (request: ApprovalRequest) => boolean;
  env?: Record<string, string | undefined>;
  connection?: Partial<PortainerConnectionInput>;
  changes?: ResourceChange[];
  /** What the public resolver answers, by host name (default: the app's domain has an A record). */
  dns?: Map<string, FakeDnsRecords>;
}

/** The address records a host name has in the fake public resolver. */
interface FakeDnsRecords {
  A?: string;
  AAAA?: string;
  CNAME?: string;
}

/** Documentation addresses (RFC 5737 and RFC 3849) for the user's Portainer host. */
const HOST_IPV4 = "203.0.113.10";
const HOST_IPV6 = "2001:db8::10";

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DNS_TYPES: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5 };

/**
 * Cloudflare's public DNS over HTTPS (`application/dns-json`) as a fake: NXDOMAIN for a host
 * without records, else the records of the asked type (a CNAME answers every type). Each query is
 * logged in `queries` as `<name> <type>`; any other request goes to `other`. `failure` makes every
 * query fail with that HTTP status.
 */
function fakeDoh(
  records: Map<string, FakeDnsRecords>,
  queries: string[],
  other: (url: string | URL, init?: RequestInit) => Promise<Response>,
  failure?: { status?: number },
) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    if (`${parsed.origin}${parsed.pathname}` !== DOH_URL) return other(url, init);
    const accept = new Headers(init?.headers).get("accept");
    if (accept !== "application/dns-json") throw new Error(`unexpected accept header ${accept}`);
    if ((init?.method ?? "GET") !== "GET") throw new Error("DNS lookups are read-only");
    const name = parsed.searchParams.get("name") ?? "";
    const type = parsed.searchParams.get("type") ?? "";
    queries.push(`${name} ${type}`);
    if (failure !== undefined)
      return new Response("unavailable", { status: failure.status ?? 503 });
    const held = records.get(name);
    const answer = (status: number, list?: unknown[]) =>
      new Response(JSON.stringify({ Status: status, ...(list ? { Answer: list } : {}) }), {
        headers: { "content-type": "application/dns-json" },
      });
    if (held === undefined) return answer(3);
    if (held.CNAME !== undefined) {
      return answer(0, [
        { name: `${name}.`, type: DNS_TYPES.CNAME, TTL: 300, data: `${held.CNAME}.` },
      ]);
    }
    const data = held[type as "A" | "AAAA"];
    return answer(
      0,
      data ? [{ name: `${name}.`, type: DNS_TYPES[type], TTL: 300, data }] : undefined,
    );
  };
}

/** The app's domain resolves to the user's Portainer host. */
const resolving = () =>
  new Map<string, FakeDnsRecords>([
    ["shop.example.com", { A: HOST_IPV4 }],
    ["www.shop.example.com", { A: HOST_IPV4 }],
  ]);

/** A GitHub fake that also creates the deploy branch (in the bare repository pushes go to). */
class PortainerGitHub extends FakeGitHub {
  readonly branches: { branch: string; path: string; content: string }[] = [];
  constructor(private readonly createRef: (branch: string) => Promise<void>) {
    super();
  }
  override async createOrphanBranch(input: { branch: string; path: string; content: string }) {
    this.branches.push({ branch: input.branch, path: input.path, content: input.content });
    const created = await super.createOrphanBranch(input);
    await this.createRef(input.branch);
    return created;
  }
  /** Branches pointed at a new placeholder commit (`replaceOrphanBranch`). */
  readonly replaced: { branch: string; path: string; content: string }[] = [];
  override async replaceOrphanBranch(input: { branch: string; path: string; content: string }) {
    this.replaced.push({ branch: input.branch, path: input.path, content: input.content });
    return super.replaceOrphanBranch(input);
  }
}

async function setup(options: SetupOptions = {}) {
  const plan = options.plan ?? portainerPlan();
  const project = await createProject(plan);
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const fake = fakePortainer({ token: PORTAINER_TOKEN, ...options.portainer });
  const github = new PortainerGitHub(async (branch) => {
    // The deploy branch now exists where pushes go (its content does not matter here).
    const head = await project.git(project.root, "rev-parse", "HEAD");
    await project.git(project.root, "push", "-q", "origin", `${head}:refs/heads/${branch}`);
  });
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const inherited = { ...process.env };
  for (const name of ["PORTAINER_API_KEY", REPOSITORY_TOKEN_VAR, REGISTRY_TOKEN_VAR]) {
    delete inherited[name];
  }
  const env: Record<string, string | undefined> = {
    ...inherited,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    OPSCREW_APP_ENV_FILE: "production.env",
    PORTAINER_API_KEY: PORTAINER_TOKEN,
    [REPOSITORY_TOKEN_VAR]: REPO_TOKEN,
    [REGISTRY_TOKEN_VAR]: GHCR_TOKEN,
    ...options.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const dns = options.dns ?? resolving();
  const dnsQueries: string[] = [];
  /** `fetch` answering the public resolver from `dns`, every other request with `other`. */
  const withDns = (other: (url: string | URL, init?: RequestInit) => Promise<Response>) =>
    fakeDoh(dns, dnsQueries, other);
  deps.fetch = withDns(deps.fetch);
  const target = plan.target.provider === "portainer" ? plan.target : undefined;
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    ...(target !== undefined ? { redeploy: target.redeploy, web: target.web } : {}),
    ...options.connection,
  });
  const engine = new FakeEngine({
    changes: options.changes ?? [],
    planJson: portainerPlanJson(),
    outputs: {
      url: "https://shop.example.com",
      tunnel_id: "tunnel-app",
      tunnel_token: TUNNEL_TOKEN,
      portainer_hostname: "portainer-shop.example.com",
      portainer_tunnel_id: "tunnel-webhook",
      portainer_tunnel_token: WEBHOOK_TUNNEL_TOKEN,
      deploy_service_token_client_id: ACCESS_ID,
      deploy_service_token_client_secret: ACCESS_SECRET,
      cloudflare_rulesets: { http_config_settings: null, http_request_firewall_custom: null },
    },
  });
  let uuid = 0;
  const clients: { endpoint: PortainerEndpoint; deps: PortainerClientDeps }[] = [];
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: { ...ownCloudflare(), listAccounts: async () => [{ id: "acc-1", name: "acc" }] },
    sleep: async () => undefined,
    portainer: {
      client: (endpoint, token, clientDeps) => {
        clients.push({ endpoint, deps: clientDeps });
        return portainerClient(endpoint, token, { ...clientDeps, request: fake.request });
      },
      inspectCertificate: async () => CERT,
      randomUUID: () => UUIDS[uuid++ % UUIDS.length] as string,
      wait: { now: () => 0, sleep: async () => undefined },
    },
    zeroTrust: fakeZeroTrust(),
  };
  const run = (extra: ProvisionOptions = {}) => runProvision(deps, { services, ...extra });
  return {
    ...project,
    deps,
    fake,
    github,
    handler,
    engine,
    services,
    run,
    clients,
    dns,
    dnsQueries,
    withDns,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Every text a run produced or published: output, audit, pull requests, commits, files. */
async function everythingPublished(s: Setup): Promise<string> {
  const log = await s.git(s.root, "log", "-p", "--all", "--format=%B");
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    ...s.github.pulls.map((pull) => pull.body),
    log,
    await readFile(s.deps.paths.files.plan, "utf8"),
  ].join("\n");
}

function expectNoSecrets(text: string, webhookId?: string) {
  for (const secret of [
    PORTAINER_TOKEN,
    REPO_TOKEN,
    GHCR_TOKEN,
    TUNNEL_TOKEN,
    WEBHOOK_TUNNEL_TOKEN,
    ACCESS_ID,
    ACCESS_SECRET,
    STRIPE,
    ...(webhookId !== undefined ? [webhookId] : []),
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain(PORTAINER_HOST);
}

const kinds = (s: Setup) => s.handler.requests.map((request) => request.kind);

/** The pull request the first run opened, while it is still open (a re-run adds to it). */
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };

describe.skipIf(!findExecutable("git"))("opscrew provision for the user's Portainer", () => {
  it("tunnel and updater: Cloudflare plan, placeholder branch, stack plan by hash, record, secrets, pull request", async () => {
    const s = await setup({ changes: APP_TUNNEL });
    const result = await s.run();

    expect(kinds(s)).toEqual([
      "repo-write",
      "iac-apply",
      "git-push",
      "stack-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    const stackApproval = s.handler.requests.find((r) => r.kind === "stack-apply");
    expect(stackApproval?.planHash).toBe(result.stackPlanHash);
    expect(stackApproval?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ applied: true, stackApplied: true });
    // The client is pinned to the confirmed certificate and fingerprints values with the local key.
    expect(s.clients[0]?.endpoint).toEqual({
      url: PORTAINER_URL,
      certFingerprint: CERT.fingerprint,
    });
    expect(s.clients[0]?.deps.valueKey).toHaveLength(32);

    // The placeholder went to the deploy branch, through its own approval.
    expect(s.github.branches).toEqual([
      expect.objectContaining({ branch: "opscrew-deploy", path: "compose.yaml" }),
    ]);
    expect(s.github.branches[0]?.content).toContain("sleep");

    // Portainer: the registry entry for the owner, the app's Git stack, the updater.
    const webhookId = (await readFile(portainerWebhookFile(s.deps.paths), "utf8")).trim();
    expect(webhookId).toBe(UUIDS[0]);
    expect(s.fake.registries).toEqual([
      expect.objectContaining({ Name: "opscrew-shop", URL: "ghcr.io", Username: "acme" }),
    ]);
    const registryBody = s.fake.bodies.find((b) => b.call === "POST /api/registries")?.body;
    expect(registryBody).toMatchObject({ Password: GHCR_TOKEN });
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.GitConfig).toMatchObject({
      URL: "https://github.com/acme/shop",
      ReferenceName: "refs/heads/opscrew-deploy",
      ConfigFilePath: "compose.yaml",
      Authentication: { Username: "x-access-token" },
    });
    expect(app?.AutoUpdate?.Webhook).toBe(webhookId);
    const env = Object.fromEntries((app?.Env ?? []).map((pair) => [pair.name, pair.value]));
    expect(Object.keys(env).sort()).toEqual([
      "DATABASE_URL",
      "OPSCREW_DB_NAME",
      "OPSCREW_DB_PASSWORD",
      "OPSCREW_DB_USER",
      "OPSCREW_TUNNEL_TOKEN",
      "SESSION_SECRET",
      "STRIPE_SECRET_KEY",
    ]);
    expect(env.STRIPE_SECRET_KEY).toBe(STRIPE);
    expect(env.OPSCREW_TUNNEL_TOKEN).toBe(TUNNEL_TOKEN);
    expect(env.OPSCREW_DB_USER).toBe("app");
    expect(env.DATABASE_URL).toBe(`postgresql://app:${env.OPSCREW_DB_PASSWORD}@db:5432/app`);
    const repositoryBody = s.fake.bodies.find((b) =>
      b.call.startsWith("POST /api/stacks/create/standalone/repository"),
    )?.body;
    expect(repositoryBody).toMatchObject({ RepositoryPassword: REPO_TOKEN });
    const updater = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop-updater");
    expect(Object.fromEntries((updater?.Env ?? []).map((pair) => [pair.name, pair.value]))).toEqual(
      {
        PORTAINER_WEBHOOK_URL: `${PORTAINER_URL}/api/stacks/webhooks/${webhookId}`,
        PORTAINER_PINNED_KEY: CERT.publicKeyPin,
      },
    );

    // What OpsCrew created is recorded, so destroy removes exactly that.
    const connection = await readPortainerConnection(s.deps.paths);
    expect(connection?.created).toEqual({
      stacks: [
        { id: app?.Id, name: "opscrew-shop", role: "app" },
        { id: updater?.Id, name: "opscrew-shop-updater", role: "updater" },
      ],
      registryId: s.fake.registries[0]?.Id,
      volumes: ["opscrew-shop_postgres_data"],
    });

    // The value key: 32 random bytes, created once, readable only by the user.
    const keyFile = portainerValueKeyFile(s.deps.paths);
    expect(Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
      expect((await stat(portainerWebhookFile(s.deps.paths))).mode & 0o777).toBe(0o600);
    }

    // Only the build's values go to GitHub; the app's values live in Portainer.
    expect([...s.github.secrets.keys()]).toEqual(["OPSCREW_BUILD_ENV"]);
    // The engine never sees Portainer's address in updater mode.
    expect(s.engine.initOptions?.env?.TF_VAR_portainer_origin).toBeUndefined();

    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment).toMatchObject({
      url: "https://shop.example.com",
      lastPlanHash: result.planHash,
      lastCompletedPhase: "provision",
    });
    expect(plan.approvals.map((approval) => approval.kind)).toEqual(["iac-apply", "stack-apply"]);
    expect(s.github.pulls[0]?.body).toContain("runs as stacks in your Portainer");
    expect(s.deps.reporter.text()).not.toContain(ROUTE_CHANGE_NOTE);
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({ kind: "provider-call", action: "stack change app-stack" }),
    );
    expectNoSecrets(await everythingPublished(s), webhookId);
    expectNoSecrets(
      await readFile(stackPlanFile(s.deps.paths, result.stackPlanHash as string), "utf8"),
      webhookId,
    );
  });

  it("shows no changes and changes nothing in Portainer when run again", async () => {
    const s = await setup({ changes: APP_TUNNEL });
    const first = await s.run();
    s.github.openPull = OPEN_PULL;
    const mutations = s.fake.mutations().length;
    s.engine.scenario.changes = [];
    s.handler.requests.length = 0;
    s.deps.reporter.lines.length = 0;

    const second = await s.run();
    expect(s.fake.mutations()).toHaveLength(mutations);
    expect(kinds(s)).not.toContain("stack-apply");
    expect(kinds(s)).not.toContain("iac-apply");
    expect(s.github.branches).toHaveLength(1);
    expect(second).toMatchObject({ applied: false, stackApplied: false });
    expect(first.stackApplied).toBe(true);
    expect(s.deps.reporter.text()).toContain(
      "Your Portainer is already set up as planned; nothing in it changes.",
    );
  });

  it("plans an update naming only the key of a rotated secret", async () => {
    const s = await setup({ changes: APP_TUNNEL });
    await s.run();
    s.github.openPull = OPEN_PULL;
    s.engine.scenario.changes = [];
    const rotated = fakeSecret("stripe-live-key", "rotated");
    await writeFile(join(s.root, "production.env"), `STRIPE_SECRET_KEY=${rotated}\n`);
    s.handler.requests.length = 0;

    await s.run();
    const request = s.handler.requests.find((r) => r.kind === "stack-apply");
    expect(request?.details).toContain("the value of STRIPE_SECRET_KEY");
    expect(request?.details).not.toContain(rotated);
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.Env.find((pair) => pair.name === "STRIPE_SECRET_KEY")?.value).toBe(rotated);
    expect(s.deps.reporter.text()).not.toContain(rotated);
  });

  it("--plan-only shows the stack plan and its hash and changes nothing; --approve applies that plan", async () => {
    const plan = portainerPlan({ web: { mode: "proxy", port: 8080 } });
    const s = await setup({ plan });
    const planned = await s.run({ planOnly: true });

    expect(planned.stackPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.planHash).toBeUndefined();
    expect(s.fake.mutations()).toEqual([]);
    expect(s.github.branches).toEqual([]);
    // Like every --plan-only run, it writes the files it plans with (after their approval).
    expect(kinds(s)).toEqual(["repo-write"]);
    expect(s.engine.calls).toEqual([]);
    expect(s.deps.reporter.text()).toContain(`Stack plan hash: ${planned.stackPlanHash}`);
    expect(s.deps.reporter.text()).toContain("Applying creates the branch opscrew-deploy");
    expect((await readPortainerConnection(s.deps.paths))?.created).toEqual({
      stacks: [],
      volumes: [],
    });
  });

  it("stops when the stack plan's approval is refused, naming the hash to approve; nothing changes in Portainer", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      answer: (request) => request.kind !== "stack-apply",
    });
    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toMatch(
      /^To apply it later without prompts, run: opscrew provision --approve [0-9a-f]{64}$/,
    );
    expect(s.fake.mutations()).toEqual([]);
    expect((await readPortainerConnection(s.deps.paths))?.created).toEqual({
      stacks: [],
      volumes: [],
    });
  });

  it("applies the same stack plan when a later run approves its hash", async () => {
    const s = await setup({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    const planned = await s.run({ planOnly: true });
    const listed = planned.stackPlanHash as string;
    // A script approves the stack plan by its hash only (`--yes` never grants a stack-apply).
    const approving = new ScriptedApprovalHandler(
      (request) => request.kind !== "stack-apply" || request.planHash === listed,
    );
    const deps = await createTestPhaseDeps({
      root: s.root,
      env: s.deps.env,
      runner: projectRunner(),
      approvalHandler: approving,
    });
    const result = await runProvision(deps, { services: s.services, approveHashes: [listed] });
    expect(result.stackPlanHash).toBe(listed);
    expect(result.stackApplied).toBe(true);
    expect(s.fake.stacks.map((stack) => stack.Name).sort()).toEqual([
      "opscrew-shop",
      "opscrew-shop-updater",
    ]);
    // Behind the user's own proxy: the record to create and the port to route to.
    expect(deps.reporter.text()).toContain(
      "let your reverse proxy forward shop.example.com to port 8080 of that host",
    );
  });

  it("a limited token without a usable registry entry stops before any change with the steps", async () => {
    const s = await setup({ portainer: { admin: false } });
    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("no ghcr.io registry entry that deployer may use");
    expect(error.hint).toContain("read:packages");
    expect(error.hint).toContain("Change visibility");
    expect(error.hint).toContain("--public-image");
    expect(kinds(s)).toEqual([]);
    expect(s.fake.mutations()).toEqual([]);
    expect(s.engine.calls).toEqual([]);
  });

  it("a limited token uses the registry entry an administrator granted, and a public image needs none", async () => {
    const granted = await setup({
      plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      portainer: {
        admin: false,
        registries: [
          {
            Id: 5,
            Name: "ghcr",
            URL: "ghcr.io",
            Type: 3,
            RegistryAccesses: { "3": { UserAccessPolicies: { "7": { RoleId: 0 } } } },
          },
        ],
      },
    });
    await granted.run();
    expect(granted.fake.mutations().some((call) => call.includes("/api/registries"))).toBe(false);
    expect((await readPortainerConnection(granted.deps.paths))?.created.registryId).toBeUndefined();

    const publicImage = await setup({
      plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      env: { [REGISTRY_TOKEN_VAR]: undefined },
    });
    await publicImage.run({ publicImage: true });
    expect(publicImage.fake.registries).toEqual([]);
  });

  it("stops before any change when a token the setup needs is not set", async () => {
    const s = await setup({ env: { [REPOSITORY_TOKEN_VAR]: undefined } });
    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain(REPOSITORY_TOKEN_VAR);
    expect(error.hint).toContain("Contents: Read-only");
    expect(kinds(s)).toEqual([]);
    expect(s.fake.mutations()).toEqual([]);

    const registry = await setup({ env: { [REGISTRY_TOKEN_VAR]: undefined } });
    const missing = (await registry.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(missing.code).toBe("CREDENTIALS_MISSING");
    expect(missing.hint).toContain("read:packages");
  });

  it("stops with a plain message when PORTAINER_API_KEY is not set or the certificate changed", async () => {
    const s = await setup({ env: { PORTAINER_API_KEY: undefined } });
    const missing = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(missing.code).toBe("CREDENTIALS_MISSING");
    expect(missing.message).toContain("PORTAINER_API_KEY");

    const other = fakeCertificate("another certificate");
    const changed = await setup();
    const request = changed.fake.request;
    changed.services.portainer = {
      ...changed.services.portainer,
      client: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, {
          ...clientDeps,
          request: async (init) => {
            if (init.method === "GET") {
              throw new PortainerCertificateError(CERT.fingerprint, other.fingerprint);
            }
            return request(init);
          },
        }),
    };
    const error = (await changed.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(CERT.fingerprint);
    expect(error.message).toContain(other.fingerprint);
    expect(changed.fake.mutations()).toEqual([]);
    expect(kinds(changed)).toEqual([]);
    expectNoSecrets(error.message);
  });

  it("records what was created before a failed apply, then shows the failure", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      portainer: { failures: { "POST /api/stacks/create/standalone/string": "boom" } },
    });
    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.message).toContain("Done before it");
    const connection = await readPortainerConnection(s.deps.paths);
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(connection?.created.stacks).toEqual([
      { id: app?.Id, name: "opscrew-shop", role: "app" },
    ]);
    expect(connection?.created.registryId).toBe(s.fake.registries[0]?.Id);
    // The app's stack exists with this route now, so a later switch is noticed.
    expect(connection?.appliedWeb).toEqual({ mode: "proxy", port: 8080 });
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "stack apply failed", decision: "refused" }),
    );
    expectNoSecrets(`${error.message} ${error.hint}`);
  });

  it("Caddy with Cloudflare redeploys: the connector stack, the webhook secrets, the DNS record to create", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
      changes: WEBHOOK_TUNNEL,
    });
    await s.run();
    const webhookId = (await readFile(portainerWebhookFile(s.deps.paths), "utf8")).trim();
    // Portainer's address reaches the engine only as the sensitive TF_VAR_portainer_origin.
    expect(s.engine.initOptions?.env?.TF_VAR_portainer_origin).toBe(PORTAINER_URL);
    const connector = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop-portainer-tunnel");
    expect(connector?.Env).toEqual([{ name: "TUNNEL_TOKEN", value: WEBHOOK_TUNNEL_TOKEN }]);
    expect(s.fake.stacks.some((stack) => stack.Name === "opscrew-shop-updater")).toBe(false);
    expect(Object.fromEntries(s.github.secrets)).toEqual({
      OPSCREW_BUILD_ENV: expect.any(String),
      OPSCREW_PORTAINER_WEBHOOK_URL: `https://portainer-shop.example.com/api/stacks/webhooks/${webhookId}`,
      OPSCREW_PORTAINER_ACCESS_CLIENT_ID: ACCESS_ID,
      OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
    });
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.Env.map((pair) => pair.name)).not.toContain("OPSCREW_TUNNEL_TOKEN");
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew creates no DNS record for shop.example.com: create one yourself",
    );
    expectNoSecrets(await everythingPublished(s), webhookId);
  });

  it("replaces the registry token only when asked, bound to the new token", async () => {
    const s = await setup({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    await s.run();
    s.github.openPull = OPEN_PULL;
    const rotated = fakeSecret("github-token", "rotated ghcr token");
    s.deps.env[REGISTRY_TOKEN_VAR] = rotated;
    s.handler.requests.length = 0;

    const unchanged = await s.run();
    expect(unchanged.stackApplied).toBe(false);

    await s.run({ replaceTokens: { registry: true } });
    const update = s.fake.bodies.filter((b) => /^PUT \/api\/registries\/\d+$/.test(b.call));
    expect(update).toHaveLength(1);
    expect(update[0]?.body).toMatchObject({ Password: rotated, Name: "opscrew-shop" });
    const request = s.handler.requests.filter((r) => r.kind === "stack-apply").at(-1);
    expect(request?.details).not.toContain(rotated);
  });

  it("switching to the updater removes the Cloudflare connector stack before its tunnel is deleted", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
      changes: WEBHOOK_TUNNEL,
      env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token") },
    });
    await s.run();
    // A real apply leaves the infrastructure state (the fake engine keeps it in memory).
    await writeFakeState(s.deps.paths);
    s.github.openPull = OPEN_PULL;
    expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop-portainer-tunnel");

    const events: string[] = [];
    const current = await readArtifact("plan", s.deps.paths.files.plan);
    if (current.target.provider !== "portainer") throw new Error("expected a Portainer plan");
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...current,
      target: { ...current.target, redeploy: "updater" },
    });
    s.engine.scenario.changes = [];
    deleteTunnelIn(s.engine, events, () => true);
    const connectorRunning = () =>
      s.fake.stacks.some((stack) => stack.Name === "opscrew-shop-portainer-tunnel");
    s.deps.fetch = s.withDns(fakeTunnelApi({ events, connectorRunning }).fetch);
    const answered: string[] = [];
    s.handler.requests.length = 0;
    const handler = s.handler as unknown as { request: (r: ApprovalRequest) => Promise<unknown> };
    const request = handler.request.bind(s.handler);
    handler.request = async (r) => {
      answered.push(r.kind);
      if (r.kind === "stack-apply") events.push("stack-apply");
      return request(r);
    };

    await s.run();
    // The infrastructure plan is approved first, then the stack change goes first, then the apply.
    expect(answered.slice(0, 3)).toEqual(["repo-write", "iac-apply", "stack-apply"]);
    expect(events.indexOf("stack-apply")).toBeLessThan(events.indexOf("iac-apply"));
    expect(s.fake.stacks.map((stack) => stack.Name).sort()).toEqual([
      "opscrew-shop",
      "opscrew-shop-updater",
    ]);
    const created = (await readPortainerConnection(s.deps.paths))?.created;
    expect(created?.stacks.map((stack) => stack.role)).toEqual(["app", "updater"]);
    expect(answered.filter((kind) => kind === "stack-apply")).toHaveLength(1);
    // The removal was a `plan -destroy` of the committed configuration, approved with the app's
    // name; its files then left the repository (in the deploy pull request's commit).
    const removal = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(removal?.title).toContain(
      "Remove what an earlier setup of this app created in Cloudflare",
    );
    expect(removal?.confirmPhrase).toBe("shop");
    expect(s.engine.applied.at(-1)?.approval.allowDestroy).toBe(true);
    expect(answered).toContain("repo-write");
    await expect(stat(join(s.root, "opscrew/infra/prod/main.tf"))).rejects.toThrow();
    expect(s.deps.reporter.text()).toContain(ROUTE_CHANGE_NOTE);
    const tracked = await s.git(s.root, "ls-files", "--", "opscrew/infra");
    expect(tracked).toBe("");
    expect(tunnelDeletePlanJson(tunnelDeletes()).resource_changes).toHaveLength(4);
  });

  it("a refused stack change that goes first says nothing in Portainer or Cloudflare changed", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
      changes: WEBHOOK_TUNNEL,
      env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token") },
    });
    await s.run();
    await writeFakeState(s.deps.paths);
    s.github.openPull = OPEN_PULL;
    const current = await readArtifact("plan", s.deps.paths.files.plan);
    if (current.target.provider !== "portainer") throw new Error("expected a Portainer plan");
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...current,
      target: { ...current.target, redeploy: "updater" },
    });
    s.engine.scenario.changes = [];
    const events: string[] = [];
    deleteTunnelIn(s.engine, events, () => true);
    s.deps.fetch = s.withDns(fakeTunnelApi({ events, connectorRunning: () => true }).fetch);
    const handler = s.handler as unknown as { request: (r: ApprovalRequest) => Promise<unknown> };
    const request = handler.request.bind(s.handler);
    handler.request = async (r) =>
      r.kind === "stack-apply"
        ? { approved: false, approver: "test-user", decidedAt: "2026-10-11T12:00:00.000Z" }
        : request(r);
    const applies = s.engine.applied.length;

    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      "The stack plan was not approved. Nothing in your Portainer was changed and nothing in Cloudflare was deleted.",
    );
    expect(error.hint).toMatch(
      /^Run `opscrew provision --approve [0-9a-f]{64} --approve [0-9a-f]{64}` when you are ready, typing shop to confirm: the change in your Portainer goes first/,
    );
    expect(s.engine.applied).toHaveLength(applies);
    expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop-portainer-tunnel");
  });

  it("replaces the repository token only when asked, sending the new one with a Git update", async () => {
    const s = await setup({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    await s.run();
    s.github.openPull = OPEN_PULL;
    const rotated = fakeSecret("github-pat", "rotated repository token");
    s.deps.env[REPOSITORY_TOKEN_VAR] = rotated;

    await s.run({ replaceTokens: { repository: true } });
    const updates = s.fake.bodies.filter((b) => /^POST \/api\/stacks\/\d+\/git\?/.test(b.call));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toMatchObject({ RepositoryPassword: rotated });
    expect(s.deps.reporter.text()).toContain("the repository token (replaced)");
    expect(s.deps.reporter.text()).not.toContain(rotated);
  });

  it("refuses to replace a token there is none of, before anything changes", async () => {
    const s = await setup({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    const error = (await s
      .run({ publicImage: true, replaceTokens: { registry: true } })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("no registry token to replace");
    expect(s.fake.mutations()).toEqual([]);
    expect(kinds(s)).toEqual([]);
  });

  it("a public repository needs no repository token", async () => {
    const s = await setup({
      plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      env: { [REPOSITORY_TOKEN_VAR]: undefined },
    });
    s.github.getRepo = async () => ({ defaultBranch: "main", private: false, canPush: true });
    await s.run();
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.GitConfig?.Authentication).toBeUndefined();
    const body = s.fake.bodies.find((b) =>
      b.call.startsWith("POST /api/stacks/create/standalone/repository"),
    )?.body;
    expect(body).toMatchObject({ RepositoryAuthentication: false });
  });

  it("--plan-only in tunnel mode: the Cloudflare plan's hash now, the stack plan after its apply", async () => {
    const s = await setup({ changes: APP_TUNNEL });
    const planned = await s.run({ planOnly: true });
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.stackPlanHash).toBeUndefined();
    expect(s.engine.calls).not.toContain("apply");
    expect(s.fake.mutations()).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      "The stack plan for your Portainer follows once this infrastructure plan is applied",
    );

    // The script approves the Cloudflare plan; the stack plan is then shown and needs its own hash.
    const refusing = await createTestPhaseDeps({
      root: s.root,
      env: s.deps.env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler((request) => request.kind !== "stack-apply"),
    });
    const error = (await runProvision(refusing, {
      services: s.services,
      approveHashes: [planned.planHash as string],
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(s.engine.applied).toHaveLength(1);
    expect(s.fake.mutations()).toEqual([]);
    expect(error.hint).toMatch(/--approve [0-9a-f]{64}$/);
  });
});

describe("portainerContainerUrl", () => {
  it.each([
    ["https://localhost:9443", "https://host.docker.internal:9443"],
    ["http://127.0.0.1:9000", "http://host.docker.internal:9000"],
    ["https://[::1]:9443/base/", "https://host.docker.internal:9443/base"],
    ["https://192.168.1.10:9443", "https://192.168.1.10:9443"],
    ["https://nas.home.arpa:9443/", "https://nas.home.arpa:9443"],
  ])("%s → %s", (url, expected) => {
    expect(portainerContainerUrl(url)).toBe(expected);
  });
});

describe.skipIf(!findExecutable("git"))(
  "opscrew provision for the user's Portainer: review",
  () => {
    const proxyPlan = () => portainerPlan({ web: { mode: "proxy", port: 8080 } });

    it("remembers that the image is public, and an explicit false switches back", async () => {
      const s = await setup({ plan: proxyPlan(), env: { [REGISTRY_TOKEN_VAR]: undefined } });
      await s.run({ publicImage: true });
      expect(s.fake.registries).toEqual([]);
      expect((await readPortainerConnection(s.deps.paths))?.publicImage).toBe(true);
      s.github.openPull = OPEN_PULL;
      const mutations = s.fake.mutations().length;
      s.handler.requests.length = 0;

      await s.run();
      expect(s.fake.mutations()).toHaveLength(mutations);
      expect(kinds(s)).not.toContain("stack-apply");

      s.deps.env[REGISTRY_TOKEN_VAR] = GHCR_TOKEN;
      await s.run({ publicImage: false });
      expect(s.fake.registries).toEqual([expect.objectContaining({ Name: "opscrew-shop" })]);
      expect((await readPortainerConnection(s.deps.paths))?.publicImage).toBe(false);
    });

    it("a Portainer on this computer over plain HTTP: the updater reaches the host, no pin, no TLS probe", async () => {
      let probes = 0;
      const s = await setup({
        plan: proxyPlan(),
        connection: { url: "http://localhost:9000", certFingerprint: undefined },
      });
      const portainer = s.services.portainer ?? {};
      s.services.portainer = {
        ...portainer,
        inspectCertificate: async () => {
          probes++;
          return CERT;
        },
      };
      await s.run();
      const updater = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop-updater");
      const env = Object.fromEntries((updater?.Env ?? []).map((pair) => [pair.name, pair.value]));
      expect(env.PORTAINER_WEBHOOK_URL).toMatch(
        /^http:\/\/host\.docker\.internal:9000\/api\/stacks\/webhooks\/[0-9a-f-]{36}$/,
      );
      expect(env.PORTAINER_PINNED_KEY).toBe("");
      expect(probes).toBe(0);
      expect(s.clients[0]?.endpoint).toEqual({ url: "http://localhost:9000" });
    });

    it("Cloudflare redeploys with a Portainer on this computer: the connector reaches the host", async () => {
      const s = await setup({
        plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
        changes: WEBHOOK_TUNNEL,
        connection: { url: "https://localhost:9443" },
      });
      await s.run();
      expect(s.engine.initOptions?.env?.TF_VAR_portainer_origin).toBe(
        "https://host.docker.internal:9443",
      );
    });

    it("Cloudflare redeploys need Portainer's root address: a path stops before anything changes", async () => {
      const s = await setup({
        plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
        changes: WEBHOOK_TUNNEL,
        connection: { url: `${PORTAINER_URL}/portainer` },
      });
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("cannot add a path");
      expect(error.hint).toContain("root address");
      expect(kinds(s)).toEqual([]);
      expect(s.engine.calls).toEqual([]);
      expect(s.fake.calls).toEqual([]);
      expectNoSecrets(`${error.message} ${error.hint}`);
    });

    it("a refused deploy branch after the Cloudflare apply says the Cloudflare changes are applied", async () => {
      const s = await setup({
        changes: APP_TUNNEL,
        answer: (request) => !request.title.includes("opscrew-deploy"),
      });
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain(
        "The Cloudflare changes are applied; nothing in Portainer was changed.",
      );
      expect(s.engine.applied).toHaveLength(1);
      expect(s.fake.mutations()).toEqual([]);
    });

    it("refuses a stack plan approved by a hash that no longer matches what Portainer has", async () => {
      const s = await setup({ plan: proxyPlan() });
      const planned = await s.run({ planOnly: true });
      // Something changed in Portainer since: another ghcr.io entry, which the plan names.
      s.fake.registries.push({
        Id: 9,
        Name: "ghcr-other",
        URL: "ghcr.io",
        Type: 3,
        RegistryAccesses: {},
      });
      const listed = planned.stackPlanHash as string;
      const scripted = await createTestPhaseDeps({
        root: s.root,
        env: s.deps.env,
        runner: projectRunner(),
        approvalHandler: new ScriptedApprovalHandler(
          (request) => request.kind !== "stack-apply" || request.planHash === listed,
        ),
      });
      const error = (await runProvision(scripted, {
        services: s.services,
        approveHashes: [listed],
      }).catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.hint).not.toContain(listed);
      expect(s.fake.mutations()).toEqual([]);
    });

    /** A deployed Caddy + Cloudflare redeploy setup whose plan now uses the updater (no root). */
    async function switched(env: Record<string, string | undefined> = {}) {
      const s = await setup({
        plan: portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
        changes: WEBHOOK_TUNNEL,
        env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"), ...env },
      });
      await s.run();
      await writeFakeState(s.deps.paths);
      s.github.openPull = OPEN_PULL;
      const current = await readArtifact("plan", s.deps.paths.files.plan);
      if (current.target.provider !== "portainer") throw new Error("expected a Portainer plan");
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...current,
        target: { ...current.target, redeploy: "updater" },
      });
      const events: string[] = [];
      deleteTunnelIn(s.engine, events, () => true);
      const connectorRunning = () =>
        s.fake.stacks.some((stack) => stack.Name === "opscrew-shop-portainer-tunnel");
      const fetch = s.withDns(fakeTunnelApi({ events, connectorRunning }).fetch);
      s.deps.fetch = fetch;
      s.handler.requests.length = 0;
      s.deps.reporter.lines.length = 0;
      return { ...s, fetch };
    }

    it("the removal of an earlier Cloudflare setup through scripts: both hashes, connector first", async () => {
      const s = await switched();
      const planned = await s.run({ planOnly: true });
      expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(planned.stackPlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.deps.reporter.text()).toContain("Applying this removal also takes the Cloudflare");
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop-portainer-tunnel");

      const listed = new Set([planned.planHash, planned.stackPlanHash]);
      const scripted = await createTestPhaseDeps({
        root: s.root,
        env: s.deps.env,
        runner: projectRunner(),
        fetch: s.fetch,
        approvalHandler: new ScriptedApprovalHandler(
          (request) =>
            (request.kind !== "iac-apply" && request.kind !== "stack-apply") ||
            listed.has(request.planHash),
        ),
      });
      const result = await runProvision(scripted, {
        services: s.services,
        approveHashes: [planned.planHash as string, planned.stackPlanHash as string],
      });
      expect(result.applied).toBe(true);
      expect(s.fake.stacks.map((stack) => stack.Name).sort()).toEqual([
        "opscrew-shop",
        "opscrew-shop-updater",
      ]);
      expect(await s.git(s.root, "ls-files", "--", "opscrew/infra")).toBe("");
      expect(scripted.reporter.text()).toContain(ROUTE_CHANGE_NOTE);
    });

    it("the removal needs the Cloudflare token: without it nothing changes", async () => {
      const s = await switched();
      delete s.deps.env.CLOUDFLARE_API_TOKEN;
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("CREDENTIALS_MISSING");
      expect(error.message).toBe(
        "No Cloudflare token found: set CLOUDFLARE_API_TOKEN. Nothing was changed.",
      );
      expect(error.hint).toBe(
        `Create a token at https://dash.cloudflare.com/profile/api-tokens with these permissions: ${tunnelTokenPermissions()}. Then try again.`,
      );
      expect(kinds(s)).toEqual([]);
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop-portainer-tunnel");
    });

    it("an earlier setup counts only while the engine lists managed resources, not its outputs, encrypted or not", async () => {
      const s = await switched();
      // Without the token a removal stops before anything changes, so it shows plainly.
      delete s.deps.env.CLOUDFLARE_API_TOKEN;
      const statePath = join(s.deps.paths.files.tfstateDir, "prod.tfstate");
      let inside: string[] = [];
      const engine = withStateList(s.engine, () => inside);
      const tunnel = "module.portainer_tunnel.cloudflare_zero_trust_tunnel_cloudflared.this";

      for (const [held, listed] of [
        [plainState([MANAGED_TUNNEL]), []],
        [encryptedState(), [tunnel]],
      ] as const) {
        await writeFile(statePath, held);
        inside = [...listed];
        const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
        expect(error.code).toBe("CREDENTIALS_MISSING");
        expect(kinds(s)).toEqual([]);
      }
      // The encrypted state was read with the project's passphrase (OpenTofu's TF_ENCRYPTION).
      expect(engine.stateCalls.map((call) => call.encryption !== undefined)).toEqual([false, true]);

      // What a removal leaves: no resource, encrypted or not. The engine would still read outputs
      // (the fake's from its earlier apply); they are no infrastructure.
      expect(Object.keys(await s.engine.output())).not.toEqual([]);
      for (const emptied of [plainState([]), encryptedState()]) {
        await writeFile(statePath, emptied);
        inside = [];
        s.engine.calls.length = 0;
        s.handler.requests.length = 0;
        s.deps.reporter.lines.length = 0;
        await s.run();
        expect(kinds(s)).not.toContain("iac-apply");
        expect(s.engine.calls).not.toContain("plan");
        expect(s.deps.reporter.text()).not.toContain("an earlier setup");
      }
    });

    it("opscrew dns with a Portainer plan runs the same flow for the new domain", async () => {
      const s = await setup({ plan: proxyPlan() });
      const result = await runDns(s.deps, { services: s.services, domain: "app.example.com" });
      expect(result.stackApplied).toBe(true);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.dns.domain).toBe("app.example.com");
      expect(s.github.pulls[0]?.body).toContain("app.example.com");
      expect(s.deps.reporter.text()).toContain(
        "let your reverse proxy forward app.example.com to port 8080 of that host",
      );
      expect(s.deps.reporter.text()).not.toContain(ROUTE_CHANGE_NOTE);
    });

    it("records the web route the app's stack was set up with", async () => {
      const s = await setup({ plan: proxyPlan() });
      await s.run();
      expect((await readPortainerConnection(s.deps.paths))?.appliedWeb).toEqual({
        mode: "proxy",
        port: 8080,
      });
    });

    it("a switch that must create the app's stack again creates the deploy branch before the stack change that goes first", async () => {
      const s = await switched();
      // The user removed the app's stack in Portainer and the deploy branch on GitHub meanwhile.
      const index = s.fake.stacks.findIndex((stack) => stack.Name === "opscrew-shop");
      s.fake.stacks.splice(index, 1);
      await s.git(s.bare, "update-ref", "-d", "refs/heads/opscrew-deploy");

      await s.run();
      const order = s.handler.requests.map((request) =>
        request.kind === "git-push" && request.title.includes("opscrew-deploy")
          ? "deploy-branch"
          : request.kind,
      );
      expect(order.indexOf("iac-apply")).toBeLessThan(order.indexOf("deploy-branch"));
      expect(order.indexOf("deploy-branch")).toBeLessThan(order.indexOf("stack-apply"));
      expect(order.filter((kind) => kind === "deploy-branch")).toHaveLength(1);
      expect(s.github.branches).toHaveLength(2);
      expect(s.fake.stacks.map((stack) => stack.Name).sort()).toEqual([
        "opscrew-shop",
        "opscrew-shop-updater",
      ]);
    });

    it("a new app stack starts from the placeholder although opscrew-deploy exists (a fresh provision after destroy)", async () => {
      const s = await setup({ plan: proxyPlan() });
      // An earlier deployment (perhaps of another web mode) left the deploy branch behind.
      const head = await s.git(s.root, "rev-parse", "HEAD");
      await s.git(s.root, "push", "-q", "origin", `${head}:refs/heads/opscrew-deploy`);

      const planned = await s.run({ planOnly: true });
      expect(planned.stackPlanHash).toBeDefined();
      expect(s.deps.reporter.text()).toContain("Applying replaces the branch opscrew-deploy");
      expect(s.github.replaced).toEqual([]);

      s.handler.requests.length = 0;
      await s.run();
      const order = s.handler.requests.map((request) =>
        request.kind === "git-push" && request.title.includes("opscrew-deploy")
          ? request.title.split(" ")[0]
          : request.kind,
      );
      expect(order.indexOf("Replace")).toBeGreaterThan(-1);
      expect(order.indexOf("Replace")).toBeLessThan(order.indexOf("stack-apply"));
      expect(order.filter((kind) => kind === "Replace" || kind === "Create")).toHaveLength(1);
      expect(s.github.branches).toEqual([]);
      expect(s.github.replaced).toEqual([
        expect.objectContaining({ branch: "opscrew-deploy", path: "compose.yaml" }),
      ]);
      expect(s.github.replaced[0]?.content).toContain("sleep");
      expect(s.deps.audit.entries).toContainEqual(
        expect.objectContaining({
          kind: "git",
          target: "acme/shop:opscrew-deploy",
          detail: expect.stringContaining("replacing"),
        }),
      );
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");

      // Once the stack exists the branch is the deploy workflow's again: never replaced.
      s.github.openPull = OPEN_PULL;
      await s.run();
      expect(s.github.replaced).toHaveLength(1);
    });

    it("a refused replacement of opscrew-deploy creates no app stack from the earlier file", async () => {
      const s = await setup({
        plan: proxyPlan(),
        answer: (request) => !request.title.startsWith("Replace the branch opscrew-deploy"),
      });
      const head = await s.git(s.root, "rev-parse", "HEAD");
      await s.git(s.root, "push", "-q", "origin", `${head}:refs/heads/opscrew-deploy`);
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain(
        "The opscrew-deploy branch was not replaced, so OpsCrew does not create the app's stack in Portainer from its earlier file.",
      );
      expect(s.github.replaced).toEqual([]);
      expect(s.fake.mutations()).toEqual([]);
    });

    it("a switch that creates the app's stack again while opscrew-deploy exists replaces the branch once, before the stack change that goes first", async () => {
      const s = await switched();
      const index = s.fake.stacks.findIndex((stack) => stack.Name === "opscrew-shop");
      s.fake.stacks.splice(index, 1);
      // The deploy workflow wrote the app's stack file there since the placeholder.
      s.github.holds.set("opscrew-deploy", { path: "compose.yaml", content: "services: {}" });

      await s.run();
      const order = s.handler.requests.map((request) =>
        request.kind === "git-push" && request.title.includes("opscrew-deploy")
          ? "deploy-branch"
          : request.kind,
      );
      expect(order.filter((kind) => kind === "deploy-branch")).toHaveLength(1);
      expect(order.indexOf("iac-apply")).toBeLessThan(order.indexOf("deploy-branch"));
      expect(order.indexOf("deploy-branch")).toBeLessThan(order.indexOf("stack-apply"));
      expect(s.github.replaced).toHaveLength(1);
    });

    it("a refused stack-apply, then a rerun: the branch already holds only the placeholder, so nothing is asked or pushed for it", async () => {
      let refuse = true;
      const s = await setup({
        plan: proxyPlan(),
        answer: (request) => !(refuse && request.kind === "stack-apply"),
      });
      // A branch an earlier deployment left: replaced on the first run.
      const head = await s.git(s.root, "rev-parse", "HEAD");
      await s.git(s.root, "push", "-q", "origin", `${head}:refs/heads/opscrew-deploy`);
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(s.github.replaced).toHaveLength(1);

      refuse = false;
      s.handler.requests.length = 0;
      await s.run();
      const branchRequests = s.handler.requests.filter(
        (request) => request.kind === "git-push" && request.title.includes("opscrew-deploy"),
      );
      expect(branchRequests).toEqual([]);
      expect(s.github.replaced).toHaveLength(1);
      expect(s.github.branches).toEqual([]);
      expect(s.deps.reporter.text()).toContain(
        "The branch opscrew-deploy already holds only the placeholder compose.yaml; it stays as it is.",
      );
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
    });
  },
);

describe.skipIf(!findExecutable("git"))(
  "opscrew provision for the user's Portainer: Caddy waits for the domain's DNS record",
  () => {
    const caddyPlan = (options: { www?: boolean } = {}) =>
      portainerPlan({ web: { mode: "caddy" }, ...options });
    const MISSING = "has no DNS record that points at your Portainer host yet";
    const CONTINUES = "then run `opscrew provision` again: it continues from there";

    it("stops before the deploy branch and the stack change while the domain has no record, then continues", async () => {
      const s = await setup({ plan: caddyPlan(), dns: new Map() });
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`shop.example.com ${MISSING}`);
      expect(error.message).toContain("Caddy asks Let's Encrypt");
      expect(error.message).toContain("Nothing in Portainer was changed.");
      expect(error.hint).toContain(
        "an A record (and AAAA for IPv6) for shop.example.com to your Portainer host's public address, or a CNAME to its dynamic-DNS name",
      );
      expect(error.hint).toContain(CONTINUES);
      // A read-only lookup through the public resolver; NXDOMAIN answers for every type.
      expect(s.dnsQueries).toEqual(["shop.example.com A"]);
      expect(s.fake.mutations()).toEqual([]);
      expect(kinds(s)).toEqual(["repo-write"]);
      expect(s.github.branches).toEqual([]);
      expect(s.github.pulls).toEqual([]);
      expectNoSecrets(`${error.message} ${error.hint}`);

      // The user creates the record (an AAAA record counts): the next run continues from there.
      s.dns.set("shop.example.com", { AAAA: HOST_IPV6 });
      s.handler.requests.length = 0;
      s.dnsQueries.length = 0;
      const result = await s.run();
      expect(s.dnsQueries).toEqual(["shop.example.com A", "shop.example.com AAAA"]);
      expect(result.stackApplied).toBe(true);
      expect(kinds(s)).toEqual([
        "git-push",
        "stack-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
    });

    it("checks www. too when planned and names only the missing record; a CNAME counts", async () => {
      const dns = new Map<string, FakeDnsRecords>([["shop.example.com", { A: HOST_IPV4 }]]);
      const s = await setup({ plan: caddyPlan({ www: true }), dns });
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`www.shop.example.com ${MISSING}`);
      expect(error.message).not.toContain("shop.example.com and");
      expect(error.hint).toContain("for www.shop.example.com to");
      expect(s.fake.mutations()).toEqual([]);

      dns.set("www.shop.example.com", { CNAME: "nas.dyndns.example.net" });
      const result = await s.run();
      expect(result.stackApplied).toBe(true);
      expect(s.dnsQueries).toContain("www.shop.example.com A");
    });

    it("--plan-only says the record must exist first and looks nothing up", async () => {
      const s = await setup({ plan: caddyPlan(), dns: new Map() });
      const planned = await s.run({ planOnly: true });
      expect(planned.stackPlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.deps.reporter.text()).toContain(
        "Before Caddy starts, shop.example.com must have a DNS record that points at your Portainer host",
      );
      expect(s.deps.reporter.text()).toContain(
        "applying checks it through a public resolver and stops before the app's stack changes until it resolves",
      );
      expect(s.dnsQueries).toEqual([]);
      expect(s.fake.mutations()).toEqual([]);
    });

    it("a lookup that fails stops plainly before anything changes in Portainer", async () => {
      const s = await setup({ plan: caddyPlan() });
      const queries: string[] = [];
      s.deps.fetch = fakeDoh(s.dns, queries, s.deps.fetch, { status: 503 });
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain(
        "OpsCrew could not check through a public resolver whether shop.example.com has a DNS record (HTTP 503)",
      );
      expect(error.message).toContain("Nothing in Portainer was changed.");
      expect(error.hint).toContain("it continues from there");
      expect(queries).toEqual(["shop.example.com A"]);
      expect(s.fake.mutations()).toEqual([]);
    });

    it("other web modes look nothing up", async () => {
      const proxy = await setup({
        plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }),
        dns: new Map(),
      });
      await proxy.run();
      expect(proxy.dnsQueries).toEqual([]);
      const tunnel = await setup({ changes: APP_TUNNEL, dns: new Map() });
      await tunnel.run();
      expect(tunnel.dnsQueries).toEqual([]);
      expect(tunnel.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
    });

    /** A deployed tunnel + updater setup whose plan now serves the app with Caddy (no root). */
    async function tunnelToCaddy() {
      const s = await setup({
        changes: APP_TUNNEL,
        env: { CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token") },
      });
      await s.run();
      await writeFakeState(s.deps.paths);
      s.github.openPull = OPEN_PULL;
      const current = await readArtifact("plan", s.deps.paths.files.plan);
      if (current.target.provider !== "portainer") throw new Error("expected a Portainer plan");
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...current,
        target: { ...current.target, web: { mode: "caddy" } },
        dns: { ...current.dns, proxied: false },
      });
      const events: string[] = [];
      deleteTunnelIn(s.engine, events, () => true);
      // As OpenTofu names them: the tunnel's records are keyed by their host name.
      const plan = s.engine.plan.bind(s.engine);
      s.engine.plan = async (dir: string, planFile: string) => {
        const summary = await plan(dir, planFile);
        return {
          ...summary,
          changes: summary.changes.map((change) =>
            change.type === "cloudflare_dns_record"
              ? { ...change, address: `${change.address}["shop.example.com"]` }
              : change,
          ),
        };
      };
      const connectorRunning = () =>
        s.fake.stacks.some(
          (stack) =>
            stack.Name === "opscrew-shop" &&
            stack.Env.some((pair) => pair.name === "OPSCREW_TUNNEL_TOKEN"),
        );
      s.deps.fetch = s.withDns(fakeTunnelApi({ events, connectorRunning }).fetch);
      // The public resolver may still remember the tunnel's record for a few minutes.
      s.dns.set("shop.example.com", { CNAME: "shop.example.com.cdn.cloudflare.net" });
      s.handler.requests.length = 0;
      s.deps.reporter.lines.length = 0;
      return { ...s, events };
    }

    it("a switch from the tunnel stops after the removal deleted the tunnel's record, says what is applied, and continues once the record exists", async () => {
      const s = await tunnelToCaddy();
      const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`shop.example.com ${MISSING}`);
      expect(error.message).toContain("deleted the Cloudflare Tunnel's record");
      expect(error.message).toContain(
        "The earlier setup's Cloudflare resources (its Cloudflare Tunnel, DNS records and Access) are removed.",
      );
      expect(error.message).toContain("The change in your Portainer that goes first is applied");
      expect(error.message).toContain("nothing else in Portainer was changed");
      expect(error.hint).toContain(CONTINUES);
      // The record was just deleted: an answer now could only be the tunnel's, still cached.
      expect(s.dnsQueries.filter((query) => query.startsWith("shop.example.com"))).toEqual([]);
      expect(kinds(s)).toEqual(["repo-write", "iac-apply", "stack-apply", "repo-write"]);
      expect(s.events.indexOf("iac-apply")).toBeGreaterThan(-1);
      const stack = s.fake.stacks.find((item) => item.Name === "opscrew-shop");
      expect(stack?.Env.map((pair) => pair.name)).not.toContain("OPSCREW_TUNNEL_TOKEN");
      expectNoSecrets(`${error.message} ${error.hint}`);

      // A real removal leaves an empty state; the user creates the record OpsCrew named.
      await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), plainState([]));
      s.dns.set("shop.example.com", { A: HOST_IPV4 });
      s.handler.requests.length = 0;
      const result = await s.run();
      expect(s.dnsQueries).toContain("shop.example.com A");
      expect(kinds(s)).not.toContain("iac-apply");
      expect(kinds(s)).toContain("git-push");
      expect(result.branch).toBeDefined();
      // The earlier configuration the first run removed is committed with the deployment files.
      expect(await s.git(s.root, "ls-files", "--", "opscrew/infra")).toBe("");
      expect(await s.git(s.root, "status", "--porcelain", "--", "opscrew/infra")).toBe("");
    });

    it("--plan-only in a switch from the tunnel: create the record once the removal is applied", async () => {
      const s = await tunnelToCaddy();
      await s.run({ planOnly: true });
      const text = s.deps.reporter.text();
      expect(text).toContain("Before Caddy starts, shop.example.com must have a DNS record");
      expect(text).toContain(
        "This plan deletes the Cloudflare Tunnel's record for shop.example.com, so create yours once it is applied; the next `opscrew provision` then continues.",
      );
      expect(s.dnsQueries).toEqual([]);
    });
  },
);

describe("switchesWebRoute", () => {
  const target = (web: PortainerWeb): PortainerDeployTarget => ({
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web,
  });
  const connection = (appliedWeb?: PortainerWeb): PortainerConnection => ({
    url: "https://nas.example:9443",
    environmentId: 3,
    environmentName: "local",
    ...(appliedWeb !== undefined ? { appliedWeb } : {}),
    created: { stacks: [{ id: 12, name: "opscrew-shop", role: "app" }], volumes: [] },
  });
  const proxy = (port: number): PortainerWeb => ({ mode: "proxy", port });

  it("compares the recorded route with the plan's: proxy:8080 → caddy is a switch", () => {
    expect(switchesWebRoute(target({ mode: "caddy" }), connection(proxy(8080)))).toBe(true);
    expect(switchesWebRoute(target(proxy(8080)), connection({ mode: "caddy" }))).toBe(true);
  });

  it("the same proxy port is no switch, another port is", () => {
    expect(switchesWebRoute(target(proxy(8080)), connection(proxy(8080)))).toBe(false);
    expect(switchesWebRoute(target(proxy(9090)), connection(proxy(8080)))).toBe(true);
  });

  it("no route recorded or no stack recorded: never a switch", () => {
    expect(switchesWebRoute(target({ mode: "caddy" }), connection())).toBe(false);
    const none: PortainerConnection = {
      ...connection(proxy(8080)),
      created: { stacks: [], volumes: [] },
    };
    expect(switchesWebRoute(target({ mode: "caddy" }), none)).toBe(false);
  });
});
