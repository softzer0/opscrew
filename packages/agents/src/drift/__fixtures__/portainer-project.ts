import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PortainerClientDeps, portainerClient } from "@opscrew/connector-portainer";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { fillPortainerStack, PORTAINER_STACK_TEMPLATE_PATH } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../../provision/portainer";
import { runProvision } from "../../provision/run";
import type { ProvisionServices } from "../../provision/types";
import { type PortainerConnectionInput, recordPortainerConnection } from "../../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  type FakePortainerOptions,
  fakeCertificate,
  PORTAINER_HOST,
  PORTAINER_URL,
  fakePortainer,
  fakeZeroTrust,
  ownCloudflare,
  portainerPlan,
  portainerPlanJson,
  projectRunner,
  ScriptedApprovalHandler,
  writeFakeState,
} from "../../testing";

export { fakeCertificate, portainerPlan };

/** Synthetic secrets of a Portainer project (generated at runtime, never committed). */
export function portainerSecrets() {
  return {
    stripe: fakeSecret("stripe-live-key"),
    portainerToken: fakeSecret("generic-password", "portainer-token"),
    repositoryToken: fakeSecret("github-pat", "repository read token"),
    registryToken: fakeSecret("github-token", "ghcr read token"),
    tunnelToken: fakeSecret("generic-password", "app tunnel token"),
    webhookTunnelToken: fakeSecret("generic-password", "webhook tunnel token"),
    accessId: fakeSecret("generic-password", "access client id"),
    accessSecret: fakeSecret("generic-password", "access client secret"),
  };
}

export const CERT = fakeCertificate();
export const WEBHOOK_UUID = "6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e";
/** The image the fake deploy workflow writes to the deploy branch. */
export const APP_IMAGE = `ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`;

const CF = "registry.opentofu.org/cloudflare/cloudflare";
const change = (module: string, type: string, name: string): ResourceChange => ({
  address: `module.${module}.${type}.${name}`,
  type,
  name,
  provider: CF,
  action: "create",
});

/** What the first Cloudflare plan of a Portainer root creates (the app's tunnel). */
export const APP_TUNNEL: ResourceChange[] = [
  change("tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this"),
  change("tunnel", "cloudflare_dns_record", "route"),
];
/** … and in redeploy mode `cloudflare` (the tunnel and Access in front of Portainer's webhook). */
export const WEBHOOK_TUNNEL: ResourceChange[] = [
  change("portainer_tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this"),
  change("access", "cloudflare_zero_trust_access_application", "ssh"),
];

const git = async (cwd: string, ...args: string[]) => {
  const result = await new NodeCommandRunner().run("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * Makes `content` the only file (`compose.yaml`) of a new orphan commit and force-pushes it to the
 * `branch` of the bare repository `bare` (as the deploy workflow writes the deploy branch).
 */
export async function writeBranch(bare: string, branch: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-deploy-branch-"));
  await git(dir, "init", "-q", "-b", "work");
  await git(dir, "config", "user.name", "OpsCrew Test");
  await git(dir, "config", "user.email", "test@example.invalid");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "compose.yaml"), content);
  await git(dir, "add", "compose.yaml");
  await git(dir, "commit", "-q", "-m", "Deploy");
  await git(dir, "push", "-q", "--force", bare, `HEAD:refs/heads/${branch}`);
  return git(dir, "rev-parse", "HEAD");
}

/** GitHub fake for a Portainer project: the deploy branch with its placeholder, deleted secrets. */
export class PortainerLifecycleGitHub extends FakeGitHub {
  readonly branches: { branch: string; path: string; content: string }[] = [];
  readonly deleted: string[] = [];
  constructor(private readonly bare: string) {
    super();
  }
  override async createOrphanBranch(input: { branch: string; path: string; content: string }) {
    this.branches.push({ branch: input.branch, path: input.path, content: input.content });
    return { commit: await writeBranch(this.bare, input.branch, input.content) };
  }
  async deleteActionsSecret(_owner: string, _repo: string, name: string): Promise<void> {
    this.deleted.push(name);
    this.secrets.delete(name);
  }
}

export interface PortainerProjectOptions {
  plan?: DeployPlan;
  portainer?: Partial<FakePortainerOptions>;
  answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
  env?: Record<string, string | undefined>;
  connection?: Partial<PortainerConnectionInput>;
}

/**
 * A git project deploying to the user's Portainer (by default web mode `tunnel` with the updater),
 * with fakes for Portainer's API, the engine, GitHub, Cloudflare and Zero Trust. Nothing is
 * provisioned yet: {@link provisionPortainerProject} does that as `opscrew provision` would.
 */
export async function portainerProject(o: PortainerProjectOptions = {}) {
  const secrets = portainerSecrets();
  const plan = o.plan ?? portainerPlan();
  const project = await createProject(plan);
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${secrets.stripe}\n`);
  const fake = fakePortainer({ token: secrets.portainerToken, ...o.portainer });
  const github = new PortainerLifecycleGitHub(project.bare);
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const inherited = { ...process.env };
  for (const name of [
    "PORTAINER_API_KEY",
    REPOSITORY_TOKEN_VAR,
    REGISTRY_TOKEN_VAR,
    "CLOUDFLARE_API_TOKEN",
    "TF_VAR_portainer_origin",
  ]) {
    delete inherited[name];
  }
  const env: Record<string, string | undefined> = {
    ...inherited,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    OPSCREW_APP_ENV_FILE: "production.env",
    PORTAINER_API_KEY: secrets.portainerToken,
    [REPOSITORY_TOKEN_VAR]: secrets.repositoryToken,
    [REGISTRY_TOKEN_VAR]: secrets.registryToken,
    ...o.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const target = plan.target.provider === "portainer" ? plan.target : undefined;
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    ...(target !== undefined ? { redeploy: target.redeploy, web: target.web } : {}),
    ...o.connection,
  });
  const changes =
    target === undefined
      ? []
      : [
          ...(target.web.mode === "tunnel" ? APP_TUNNEL : []),
          ...(target.redeploy === "cloudflare" ? WEBHOOK_TUNNEL : []),
        ];
  const engine = new FakeEngine({
    changes,
    planJson: portainerPlanJson(),
    outputs: {
      url: "https://shop.example.com",
      tunnel_id: "tunnel-app",
      tunnel_token: secrets.tunnelToken,
      portainer_hostname: "portainer-shop.example.com",
      portainer_tunnel_id: "tunnel-webhook",
      portainer_tunnel_token: secrets.webhookTunnelToken,
      deploy_service_token_client_id: secrets.accessId,
      deploy_service_token_client_secret: secrets.accessSecret,
      cloudflare_rulesets: { http_config_settings: null, http_request_firewall_custom: null },
    },
  });
  const clients: PortainerClientDeps[] = [];
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: { ...ownCloudflare(), listAccounts: async () => [{ id: "acc-1", name: "acc" }] },
    sleep: async () => undefined,
    portainer: {
      client: (endpoint, token, clientDeps) => {
        clients.push(clientDeps);
        return portainerClient(endpoint, token, { ...clientDeps, request: fake.request });
      },
      inspectCertificate: async () => CERT,
      randomUUID: () => WEBHOOK_UUID,
      wait: { now: () => 0, sleep: async () => undefined },
    },
    zeroTrust: fakeZeroTrust(),
  };
  return { ...project, plan, deps, fake, github, handler, engine, services, secrets, clients };
}

export type PortainerProject = Awaited<ReturnType<typeof portainerProject>>;

/**
 * Provisions the project as `opscrew provision` does (every plan approved), leaves the state file
 * an apply would leave when there is a Cloudflare root, and resets the recorded requests. The
 * engine plans nothing more afterwards.
 */
export async function provisionPortainerProject(s: PortainerProject): Promise<void> {
  await runProvision(s.deps, { services: s.services });
  if (s.engine.applied.length > 0) await writeFakeState(s.deps.paths);
  s.engine.scenario.changes = [];
  s.github.openPull = { number: 7, url: "https://github.com/acme/shop/pull/7" };
  s.handler.requests.length = 0;
  s.deps.reporter.lines.length = 0;
}

/**
 * Writes what the deploy workflow writes to the deploy branch: the committed stack template with
 * `image` filled in. Returns the file.
 */
export async function deployImage(s: PortainerProject, image = APP_IMAGE): Promise<string> {
  const template = await readFile(join(s.root, PORTAINER_STACK_TEMPLATE_PATH), "utf8");
  const content = `${fillPortainerStack(template.trimEnd(), image)}\n`;
  await writeBranch(s.bare, "opscrew-deploy", content);
  const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
  if (app !== undefined) app.file = content;
  return content;
}

/** Every user-visible or persisted text of a run: output, audit log, approvals, plan. */
export async function everythingShown(s: PortainerProject): Promise<string> {
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    await readFile(s.deps.paths.files.plan, "utf8"),
  ].join("\n");
}

/** The secrets and Portainer's address, none of which may appear in `text`. */
export function forbiddenIn(s: PortainerProject, webhookId = WEBHOOK_UUID): string[] {
  return [
    ...Object.values(s.secrets),
    webhookId,
    PORTAINER_HOST,
    CERT.publicKeyPin,
  ];
}
