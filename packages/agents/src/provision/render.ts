import { join } from "node:path";
import {
  type RenderContext,
  type RenderedFile,
  type RenderedFileKind,
  renderDeployment,
  renderStorage,
  renderTunnelConnectorCompose,
  tunnelMode,
  usesTunnel,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Requirements, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  diffRenderedFiles,
  ensureDeployKey,
  githubCoordinates,
  hidesServerAddress,
  readDeployPublicKey,
  readServerAddresses,
  readValidJson,
  requireGitRepo,
  type ServerAddress,
} from "../shared";
import { readOwnServerRecord } from "../shared/own-server";
import { type CloudflareSetup, setupCloudflare } from "./credentials";
import type { ProvisionServices } from "./types";

export async function readRequirements(deps: PhaseDeps): Promise<Requirements | undefined> {
  try {
    return await readArtifact("requirements", deps.paths.files.requirements);
  } catch (error) {
    if ((error as { code?: string }).code === "ARTIFACT_MISSING") return undefined;
    throw error;
  }
}

/**
 * What the render needs besides the plan: on a server the user owns the SSH port (`sshPort`) and,
 * with Portainer on a subdomain (any target), the id of the account's one-time PIN login, which
 * the Cloudflare plan sets up first.
 */
export interface OwnRenderInput {
  /**
   * The login port in public mode (which differs from sshd's when a router forwards it), sshd's
   * own port in tunnel mode (inspection, `sshd -T`; the tunnel routes the SSH hostname there).
   */
  sshPort?: number;
  oneTimePinIdentityProviderId?: string;
}

/**
 * The secret-free render context provision uses (shared with the read-only preview). The rendered
 * files are committed, so it carries the server's address (`input.server`, from
 * `serverAddress`) only when the plan does not hide it behind Cloudflare's proxy: then the
 * runbook shows the same address `opscrew verify` writes into it, and never one behind the proxy.
 * A server the user owns never gets its address into a rendered file (FR-902): the engine reads it
 * from `TF_VAR_server_ipv4`/`TF_VAR_server_ipv6`.
 */
export function deploymentRenderContext(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    requirements: Requirements | undefined;
    github: { owner: string; repo: string };
    deployPublicKey: string;
    cloudflare: CloudflareSetup | undefined;
    /** The server's address when known on this computer. */
    server?: ServerAddress | undefined;
    /** A server the user owns: see {@link OwnRenderInput}. */
    own?: OwnRenderInput;
  },
): RenderContext {
  const { requirements, cloudflare, own } = input;
  const ownServer = input.plan.target.provider === "own";
  const server = hidesServerAddress(input.plan) || ownServer ? undefined : input.server;
  return {
    opscrewVersion: deps.version,
    github: { owner: input.github.owner, repo: input.github.repo },
    deploySshPublicKey: input.deployPublicKey,
    projectId: deps.paths.projectId,
    ...(server !== undefined ? { serverIpv4: server.ipv4 } : {}),
    ...(server?.ipv6 !== undefined ? { serverIpv6: server.ipv6 } : {}),
    ...(requirements?.contactEmail ? { acmeEmail: requirements.contactEmail } : {}),
    ...(own?.sshPort !== undefined ? { sshPort: own.sshPort } : {}),
    ...(cloudflare
      ? {
          cloudflare: {
            zoneId: cloudflare.zoneId,
            ...(cloudflare.ipRanges ? { ipRanges: cloudflare.ipRanges } : {}),
            accountId: cloudflare.accountId,
            ...(own?.oneTimePinIdentityProviderId !== undefined
              ? { oneTimePinIdentityProviderId: own.oneTimePinIdentityProviderId }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Every file provision writes for the plan: the deployment (`renderDeployment`), the
 * `storage` root of the app's bucket at a provider (`renderStorage`) and, whenever the plan has a
 * Cloudflare Tunnel (an own server in tunnel mode, or a Portainer subdomain), the tunnel
 * connector's Compose file (`opscrew/runtime/cloudflared/compose.yaml`, which runs on the server).
 */
export function deploymentFiles(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  const files = [...renderDeployment(plan, ctx), ...renderStorage(plan, ctx)];
  return usesTunnel(plan) ? [...files, renderTunnelConnectorCompose(plan)] : files;
}

/**
 * The values of the committed `terraform.tfvars.json` (the files of the last run), or `undefined`
 * when the file is missing or not a JSON object. Never holds secrets or a server address.
 */
export function committedTfvars(
  root: string,
  plan: Pick<DeployPlan, "infra">,
): Promise<Record<string, unknown> | undefined> {
  return readValidJson(
    join(root, plan.infra.dir, "terraform.tfvars.json"),
    z.record(z.string(), z.unknown()),
  );
}

/**
 * The render inputs the last run used, read from the committed `terraform.tfvars.json`
 * (`ssh_port`, `one_time_pin_identity_provider_id`), for a preview that must not connect to the
 * server.
 */
export function ownRenderFromTfvars(values: Record<string, unknown> | undefined): OwnRenderInput {
  if (values === undefined) return {};
  const port = values.ssh_port;
  const pin = values.one_time_pin_identity_provider_id;
  return {
    ...(typeof port === "number" && Number.isInteger(port) ? { sshPort: port } : {}),
    ...(typeof pin === "string" && pin !== "" ? { oneTimePinIdentityProviderId: pin } : {}),
  };
}

/**
 * The render inputs for a preview that connects to no server: those of the committed
 * `terraform.tfvars.json` ({@link ownRenderFromTfvars}) and, on a server the user owns, the SSH
 * port provision used. In public mode that is the recorded login port (`.opscrew/server.json`,
 * which differs from sshd's when a router forwards it); the committed `ssh_port` (written only in
 * tunnel mode) stands in when no login is recorded on this computer.
 */
async function previewRender(deps: PhaseDeps, plan: DeployPlan): Promise<OwnRenderInput> {
  const committed = ownRenderFromTfvars(await committedTfvars(deps.paths.root, plan));
  if (plan.target.provider !== "own" || tunnelMode(plan)) return committed;
  const login = await readOwnServerRecord(deps.paths).catch(() => undefined);
  return login?.port !== undefined ? { ...committed, sshPort: login.port } : committed;
}

/** The deploy key's public half: created once when allowed, otherwise read (never invented). */
async function deployPublicKeyFor(deps: PhaseDeps, create: boolean): Promise<string> {
  if (create) return (await ensureDeployKey(deps.paths, deps.redactor)).publicKeyOpenSsh;
  return readDeployPublicKey(deps, "cannot render the files it would compare");
}

export interface DeploymentPreview {
  plan: DeployPlan;
  /** DNS records at the app's hostnames OpsCrew did not create (only with `foreignRecords: "report"`). */
  foreignDnsRecords?: { type: string; name: string; content: string }[];
  files: { path: string; kind: RenderedFileKind }[];
  created: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * `plan` with the zone Cloudflare reported (`dns.zone`), which every render of the deployment
 * needs (the DNS module's CAA issuers, for one), so provision and retarget render the same files.
 */
export function withCloudflareZone(
  plan: DeployPlan,
  cloudflare: CloudflareSetup | undefined,
): DeployPlan {
  return cloudflare ? { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } } : plan;
}

/**
 * The files `opscrew provision` would write, compared with the repository, without writing
 * anything to it or recording a phase. Needs the Cloudflare token when the plan uses Cloudflare
 * (the zone id is part of the rendered code). Creates the project's deploy key in the user's
 * OpsCrew home when it does not exist yet, so the preview matches the later provision exactly.
 * No server is contacted and no Cloudflare plan is made: the one-time PIN login's id comes from the
 * committed `terraform.tfvars.json` of the last run, and a server the user owns gets the SSH port
 * provision used (the recorded login port in public mode, sshd's committed port in tunnel mode).
 */
export async function previewDeploymentFiles(
  deps: PhaseDeps,
  options: {
    services?: ProvisionServices;
    foreignRecords?: "stop" | "report";
    /** Create the project's deploy key when it is missing (default true; drift passes false). */
    createDeployKey?: boolean;
  } = {},
): Promise<DeploymentPreview> {
  let plan = await readArtifact("plan", deps.paths.files.plan);
  const requirements = await readRequirements(deps);
  const git = await requireGitRepo(deps);
  const github = await githubCoordinates(git);
  const cloudflare = await setupCloudflare(deps, plan, options.services ?? {}, {
    foreignRecords: options.foreignRecords ?? "stop",
  });
  plan = withCloudflareZone(plan, cloudflare);
  const deployPublicKey = await deployPublicKeyFor(deps, options.createDeployKey !== false);
  // The local record only (a preview runs no engine), and never a reason for it to fail.
  const server = hidesServerAddress(plan)
    ? undefined
    : await readServerAddresses(deps.paths).then(
        (record) => record.deployment,
        () => undefined,
      );
  const own = await previewRender(deps, plan);
  const files = deploymentFiles(
    plan,
    deploymentRenderContext(deps, {
      plan,
      requirements,
      github,
      deployPublicKey,
      cloudflare,
      server,
      own,
    }),
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  return {
    plan,
    ...(cloudflare?.foreignRecords ? { foreignDnsRecords: cloudflare.foreignRecords } : {}),
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    created: diff.created.map((f) => f.path),
    changed: diff.changed.map((f) => f.path),
    unchanged: diff.unchanged.map((f) => f.path),
  };
}
