import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import {
  type RenderContext,
  type RenderedFile,
  type RenderedFileKind,
  renderDeployment,
  renderTunnelConnectorCompose,
  tunnelMode,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Requirements, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  diffRenderedFiles,
  ensureDeployKey,
  hidesServerAddress,
  readServerAddresses,
  type ServerAddress,
} from "../shared";
import { type CloudflareSetup, githubCoordinates, setupCloudflare } from "./credentials";
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
 * What the render of a server the user owns needs besides the plan: the port sshd listens on
 * (inspection, `sshd -T`; the tunnel routes the SSH hostname there) and, when the plan has
 * Cloudflare Access, whether this configuration creates the account's Zero Trust organization and
 * the id of an existing one-time PIN login method.
 */
export interface OwnRenderInput {
  sshPort?: number;
  createZeroTrustOrganization?: boolean;
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
            manageConfigRule: cloudflare.manageConfigRule,
            manageWafRules: cloudflare.manageWafRules,
            ...(cloudflare.ipRanges ? { ipRanges: cloudflare.ipRanges } : {}),
            ...(cloudflare.accountId !== undefined ? { accountId: cloudflare.accountId } : {}),
            ...(own?.createZeroTrustOrganization !== undefined
              ? { createZeroTrustOrganization: own.createZeroTrustOrganization }
              : {}),
            ...(own?.oneTimePinIdentityProviderId !== undefined
              ? { oneTimePinIdentityProviderId: own.oneTimePinIdentityProviderId }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Every file provision writes for the plan: the deployment (`renderDeployment`) and, when an own
 * server is served through a Cloudflare Tunnel, the tunnel connector's Compose file
 * (`opscrew/runtime/cloudflared/compose.yaml`, which the host plan installs on the server).
 */
export function deploymentFiles(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  const files = renderDeployment(plan, ctx);
  return tunnelMode(plan) ? [...files, renderTunnelConnectorCompose(plan, ctx)] : files;
}

/**
 * The values of the committed `terraform.tfvars.json` (the files of the last run), or `undefined`
 * when the file is missing or not a JSON object. Never holds secrets or a server address.
 */
export async function committedTfvars(
  root: string,
  plan: Pick<DeployPlan, "infra">,
): Promise<Record<string, unknown> | undefined> {
  try {
    const values = JSON.parse(
      await readFile(join(root, plan.infra.dir, "terraform.tfvars.json"), "utf8"),
    ) as unknown;
    return typeof values === "object" && values !== null && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The own-server render inputs the last run used, read from the committed `terraform.tfvars.json`
 * (`ssh_port`, `create_zero_trust_organization`, `one_time_pin_identity_provider_id`), for a
 * preview that must not connect to the server.
 */
export function ownRenderFromTfvars(values: Record<string, unknown> | undefined): OwnRenderInput {
  if (values === undefined) return {};
  const port = values.ssh_port;
  const create = values.create_zero_trust_organization;
  const pin = values.one_time_pin_identity_provider_id;
  return {
    ...(typeof port === "number" && Number.isInteger(port) ? { sshPort: port } : {}),
    ...(typeof create === "boolean" ? { createZeroTrustOrganization: create } : {}),
    ...(typeof pin === "string" && pin !== "" ? { oneTimePinIdentityProviderId: pin } : {}),
  };
}

/** The deploy key's public half: created once when allowed, otherwise read (never invented). */
async function deployPublicKeyFor(deps: PhaseDeps, create: boolean): Promise<string> {
  if (create) {
    const key = await ensureDeployKey(deps.paths);
    deps.redactor.addLiteral(key.privateKeyOpenSsh, "deploy-key");
    return key.publicKeyOpenSsh;
  }
  const existing = (await readFile(deps.paths.files.deployKeyPub, "utf8").catch(() => ""))?.trim();
  if (!existing) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The project's deploy key is not on this computer, so OpsCrew cannot render the files it would compare. Nothing was checked.",
      {
        hint: `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${deps.paths.files.deployKey} and ${deps.paths.files.deployKeyPub}, then try again.`,
      },
    );
  }
  return existing;
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
 * The files `opscrew provision` would write, compared with the repository, without writing
 * anything to it or recording a phase. Needs the Cloudflare token when the plan uses Cloudflare
 * (the zone id is part of the rendered code). Creates the project's deploy key in the user's
 * OpsCrew home when it does not exist yet, so the preview matches the later provision exactly.
 * A server the user owns is not contacted: its SSH port and Zero Trust choices come from the
 * committed `terraform.tfvars.json` of the last run.
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
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  if (!(await git.isRepo())) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project is not a git repository.", {
      hint: "Run OpsCrew from a clone of your GitHub repository.",
    });
  }
  const github = await githubCoordinates(git);
  const cloudflare = await setupCloudflare(deps, plan, options.services ?? {}, {
    foreignRecords: options.foreignRecords ?? "stop",
  });
  if (cloudflare) plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
  const deployPublicKey = await deployPublicKeyFor(deps, options.createDeployKey !== false);
  // The local record only (a preview runs no engine), and never a reason for it to fail.
  const server = hidesServerAddress(plan)
    ? undefined
    : await readServerAddresses(deps.paths).then(
        (record) => record.deployment,
        () => undefined,
      );
  const own =
    plan.target.provider === "own"
      ? ownRenderFromTfvars(await committedTfvars(deps.paths.root, plan))
      : undefined;
  const files = deploymentFiles(
    plan,
    deploymentRenderContext(deps, {
      plan,
      requirements,
      github,
      deployPublicKey,
      cloudflare,
      server,
      ...(own !== undefined ? { own } : {}),
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
