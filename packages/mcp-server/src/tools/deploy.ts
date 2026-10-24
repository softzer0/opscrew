import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  applyCommand,
  CHECK_MARK,
  describeChanges,
  describePlan,
  findSavedPlan,
  OWN_SERVER_BACKUPS_NOTE,
  PORTAINER_NOTES,
  type ProvisionResult,
  type ProvisionServices,
  portainerImageOptions,
  previewDeploymentFiles,
  REPLACEABLE_TOKENS,
  type RunSecureOptions,
  type RunVerifyOptions,
  readSavedLocalPlan,
  readSavedPlanChanges,
  runProvision,
  runSecure,
  runVerify,
  type SavedPlan,
  STORAGE_PLAN_SUFFIX,
  savedLocalPlanChanges,
  stackFollowsReason,
  stringOutput,
  summarizeChecks,
} from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CheckResult,
  Clock,
} from "@opscrew/contracts";
import {
  approvalDecision,
  formatMoney,
  isPlanHash,
  isUserFacingError,
  OpsCrewError,
  resolveProjectPaths,
} from "@opscrew/core";
import { type DeployPlan, onOneServer, readArtifact } from "@opscrew/plan-schema";
import { DEEP_TOOL_NAME, type DeepToolResult } from "@opscrew/secops";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import {
  type CallExtra,
  dialogHandler,
  type ElicitationApprovalHandler,
  REQUIRES_USER,
  requireDialogs,
} from "./elicitation";
import {
  appInput,
  appliedCloudflarePlan,
  environmentInput,
  IDEMPOTENT_WRITE,
  projectDirInput,
  runTool,
  toolEnvironment,
} from "./shared";

/**
 * Test-only collaborators for the deploy tools. Production leaves them unset, so every phase uses
 * its real defaults (engine binary, provider APIs, SSH, DNS, TLS, TCP).
 */
export interface DeployToolOptions {
  /** Fakes for `runProvision` / `previewDeploymentFiles` (engine, cloud provider, GitHub, SSH, waits). */
  provisionServices?: ProvisionServices;
  /** Fakes for `runSecure` (remote shell, TCP probe). */
  secure?: Pick<
    RunSecureOptions,
    "remote" | "tcpConnect" | "probeTimeoutMs" | "portainer" | "docker"
  >;
  /** Fakes for `runVerify` (resolver, fetch, TLS, TCP, Cloudflare ranges). */
  verify?: RunVerifyOptions;
  /** Replaces `runProvision` (tests of the user's Portainer, whose flow `@opscrew/agents` tests). */
  runProvision?: typeof runProvision;
}

/**
 * Approval handler for `opscrew_plan`: the user's call of that tool (Claude Code asks for it every
 * time, see `anthropic/requiresUserInteraction`) approves writing the generated deployment files
 * into the repository, which git shows and can undo. Everything else is refused.
 */
class PlanToolApprovalHandler implements ApprovalHandler {
  constructor(private readonly clock: Clock) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approved = request.kind === "repo-write";
    return approvalDecision(
      this.clock,
      "user (opscrew_plan tool call)",
      approved,
      approved
        ? {}
        : {
            reason:
              "opscrew_plan only plans. Apply the plan with opscrew_apply or `opscrew provision --approve <hash>`.",
          },
    );
  }
}

const servicesOption = (options: DeployToolOptions) =>
  options.provisionServices !== undefined ? { services: options.provisionServices } : {};

/** Plan file details for the result (the engine's raw plan JSON is left out: it is large). */
function planData(saved: SavedPlan) {
  return {
    planHash: saved.planHash,
    engine: saved.engine,
    createdAt: saved.createdAt,
    changes: saved.changes,
    counts: saved.counts,
    hasDestroy: saved.hasDestroy,
    policy: saved.policy,
  };
}

/**
 * The plan of the app's bucket (the `storage` root), for the user: its changes, its monthly price
 * with its source and date, and its policy results.
 */
function bucketPlanText(saved: SavedPlan, plan: DeployPlan): string {
  const storage = plan.storage?.objectStorage;
  const failed = saved.policy.filter((result) => !result.passed);
  return [
    `Plan of the app's bucket${storage === undefined ? "" : ` ${storage.bucket}`} (object storage), with its own hash ${saved.planHash}:`,
    ...describeChanges(saved.changes),
    ...(storage === undefined
      ? []
      : [
          `Cost: about ${formatMoney({ amount: storage.price.monthly, currency: storage.price.currency })} a month (from ${storage.price.source}, checked on ${storage.price.checkedOn}).`,
        ]),
    `Security policies: ${saved.policy.length - failed.length} passed, ${failed.length} failed.`,
    ...failed.map((result) => `  ✗ [${result.severity}] ${result.title}: ${result.message}`),
    "The app's key for it is the user's own: `opscrew provision` in a terminal asks for it, or it comes from OPSCREW_STORAGE_ACCESS_KEY_ID and OPSCREW_STORAGE_SECRET_ACCESS_KEY. Never ask for it in the chat.",
  ].join("\n");
}

function checkLines(checks: readonly CheckResult[]): string[] {
  return checks.map(
    (c) =>
      `${CHECK_MARK[c.status]} [${c.severity}] ${c.title}: ${c.message}${c.status === "fail" && c.remediation ? ` Fix: ${c.remediation}` : ""}`,
  );
}

/** The deeper checks per tool: its version, the results that count, then its known noise apart. */
function deepLines(runs: readonly DeepToolResult[]): string[] {
  return runs.flatMap((run) => {
    const index = run.hardeningIndex === undefined ? "" : `, hardening index ${run.hardeningIndex}`;
    const noise = run.results.filter((result) => result.noise !== undefined);
    return [
      "",
      `Deeper check: ${DEEP_TOOL_NAME[run.tool]} ${run.version}${index}`,
      ...checkLines(run.results.filter((result) => result.noise === undefined)),
      ...noise.map((result) => `  known noise: ${result.title} (${result.noise})`),
    ];
  });
}

/** The CLI's `--password-logins off|keep` for a server the user owns. */
const PASSWORD_LOGINS_INPUT = z.enum(["off", "keep"]).optional();

/** The CLI's `--public-image` (true) and `--private-image` (false) for the user's Portainer. */
const PUBLIC_IMAGE_INPUT = z
  .boolean()
  .optional()
  .describe(
    "The user's Portainer, only when the user says so: true when the app's image on GitHub Container Registry is public (Portainer pulls it without a registry entry), false to switch a remembered public image back to private. Omit it to keep the remembered choice; never guess. Pass the same value to opscrew_plan and opscrew_apply (the stack plan's hash depends on it).",
  );

/** The CLI's `--replace-token repository|registry` for the user's Portainer. */
const REPLACE_TOKENS_INPUT = z
  .array(z.enum(REPLACEABLE_TOKENS))
  .max(2)
  .optional()
  .describe(
    'The user\'s Portainer, only when the user rotated a token and asks to send it again: "repository" (OPSCREW_REPO_READ_TOKEN) and/or "registry" (OPSCREW_GHCR_READ_TOKEN). Never the tokens themselves. Pass the same value to opscrew_plan and opscrew_apply.',
  );

/** The CLI's `--pages-verification <value>` for a site on GitHub Pages. */
const PAGES_VERIFICATION_INPUT = z
  .string()
  .optional()
  .describe(
    "A site on GitHub Pages, only when OpsCrew stopped asking for it: the value of GitHub's domain verification record, which the user copies from their GitHub account's Pages settings after adding the domain there (it is public in DNS, not a secret). Pass the same value to opscrew_plan and opscrew_apply.",
  );

/** What to do about a missing or damaged saved plan through MCP. */
const PLAN_AGAIN =
  "Call opscrew_plan again, show the new plans to the user and apply their hashes.";

/** The stop when no saved `what` (`plan`, `host plan`, `stack plan`) has `hash`. */
function noSavedPlan(what: string, hash: string): OpsCrewError {
  return new OpsCrewError("PLAN_HASH_MISMATCH", `No saved ${what} has the hash ${hash}.`, {
    hint: PLAN_AGAIN,
  });
}

/**
 * The plan OpsCrew described while planning (from the collected messages): the first message that
 * starts with `prefix` and, when given, names `hash`.
 */
function planText(
  messages: readonly { message: string }[],
  prefix: string,
  hash?: string,
): string | undefined {
  return messages.find(
    (m) => m.message.startsWith(prefix) && (hash === undefined || m.message.includes(hash)),
  )?.message;
}

/**
 * The dialogs of `opscrew_apply`, which show a Cloudflare plan (`cloudflare-apply`) only when its
 * hash is the `cloudflarePlanHash` opscrew_plan returned: any other Cloudflare plan (it changed
 * since, or the hash was not passed) is refused before a dialog, so the user never approves a
 * Cloudflare plan the chat did not show. A plan of the app's bucket (a saved plan of the `storage`
 * root) is shown likewise only when its hash is the `storagePlanHash` given, and a GitHub Pages
 * site's Pages plan (`pages-apply`) only when its hash is the `pagesPlanHash` given.
 */
class CloudflarePlanGate implements ApprovalHandler {
  /** True once a Cloudflare plan with another hash was refused. */
  refusedOther = false;
  /** True once a bucket plan with another hash was refused. */
  refusedBucket = false;
  /** True once a Pages plan with another hash was refused. */
  refusedPages = false;

  constructor(
    private readonly dialogs: ElicitationApprovalHandler,
    private readonly hash: string | undefined,
    private readonly storage: { hash: string | undefined; plansDir: string },
    private readonly pagesHash: string | undefined,
    private readonly clock: Clock,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const planHash = request.planHash?.toLowerCase();
    if (request.kind === "pages-apply" && (planHash === undefined || planHash !== this.pagesHash)) {
      this.refusedPages = true;
      return approvalDecision(this.clock, "opscrew_apply", false, {
        reason:
          this.pagesHash === undefined
            ? "opscrew_apply was not given this Pages plan's pagesPlanHash"
            : `its hash is not the pagesPlanHash ${this.pagesHash}; the Pages plan changed since opscrew_plan returned it`,
      });
    }
    if (request.kind === "iac-apply" && planHash !== undefined && planHash !== this.storage.hash) {
      const saved = await findSavedPlan(this.storage.plansDir, planHash);
      if (saved?.planFile.endsWith(STORAGE_PLAN_SUFFIX) === true) {
        this.refusedBucket = true;
        return approvalDecision(this.clock, "opscrew_apply", false, {
          reason:
            this.storage.hash === undefined
              ? "opscrew_apply was not given this bucket plan's storagePlanHash"
              : `its hash is not the storagePlanHash ${this.storage.hash}; the bucket plan changed since opscrew_plan returned it`,
        });
      }
    }
    if (
      request.kind !== "cloudflare-apply" ||
      (this.hash !== undefined && request.planHash?.toLowerCase() === this.hash)
    ) {
      return this.dialogs.request(request);
    }
    this.refusedOther = true;
    return approvalDecision(this.clock, "opscrew_apply", false, {
      reason:
        this.hash === undefined
          ? "opscrew_apply was not given this Cloudflare plan's cloudflarePlanHash"
          : `its hash is not the cloudflarePlanHash ${this.hash}; the Cloudflare plan changed since opscrew_plan returned it`,
    });
  }
}

/**
 * Where the deployment files are after `opscrew_apply`: a pull request, a branch (pushed or still
 * to push), or unchanged, with `result.base`, the branch the deploy pull request goes into.
 */
function publishedLines(result: ProvisionResult): string[] {
  const { base } = result;
  if (result.published === false) {
    if (result.prUrl) {
      return [
        `The deployment files did not change, so nothing was committed. The pull request from earlier is still open: ${result.prUrl}`,
      ];
    }
    return [
      "The deployment files did not change, so nothing was committed and no pull request was opened.",
      ...(result.branch !== undefined && result.branch !== base
        ? [
            `They are already on ${base} on GitHub, but this clone is still on ${result.branch}: switch to ${base} and pull (\`git switch ${base} && git pull\`).`,
          ]
        : []),
    ];
  }
  if (result.prUrl) return [`Pull request with the deployment files: ${result.prUrl}`];
  if (result.pushed === false && result.branch) {
    return [
      `The deployment files are committed on branch ${result.branch}, which still needs pushing: push it (\`git push -u origin ${result.branch}\`) and open a pull request into ${base}.`,
    ];
  }
  return result.branch ? [`Deployment files committed on branch ${result.branch}.`] : [];
}

/** The next step after `opscrew_apply`; `secrets` says whether this call stored the deploy secrets. */
function nextLine(result: ProvisionResult, secrets: boolean): string {
  if (result.published === false && !result.prUrl) {
    return secrets
      ? "Next: call opscrew_verify to check the live site."
      : "Then call opscrew_verify to check the live site.";
  }
  if (result.pushed === false && !result.prUrl) {
    return secrets
      ? "Next: once the branch is pushed, merge its pull request to deploy, then call opscrew_verify."
      : "Then, once the branch is pushed, merge its pull request to deploy and call opscrew_verify.";
  }
  return secrets
    ? "Next: merge the pull request to deploy, then call opscrew_verify."
    : "Then merge the pull request to deploy and call opscrew_verify.";
}

function outputsLines(result: ProvisionResult, own: boolean): string[] {
  // A server the user owns or their Portainer: no address leaves OpsCrew's local state.
  if (own) return [];
  const lines: string[] = [];
  for (const [key, label] of [
    ["server_ipv4", "Server IPv4"],
    ["server_ipv6", "Server IPv6"],
    ["url", "URL"],
  ] as const) {
    const value = stringOutput(result.outputs, key);
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  return lines;
}

/**
 * The deploy tools: `opscrew_render` (read-only preview of the generated files), `opscrew_plan`
 * (writes the files, plans, saves the plan and returns its hash; never applies), `opscrew_apply`
 * (applies exactly a saved plan after the user approves it in an MCP elicitation dialog; refuses
 * with the `opscrew provision --approve <hash>` command when the client cannot elicit, and names
 * plain `opscrew provision` after the user declines), `opscrew_secure` and `opscrew_verify`.
 * `options` is for tests only.
 */
export function registerDeployTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: DeployToolOptions = {},
): void {
  server.registerTool(
    "opscrew_render",
    {
      title: "Preview the deployment files",
      description:
        "Preview the deployment files OpsCrew generates from opscrew/plan.yaml: the OpenTofu/Terraform code under opscrew/infra, the Docker Compose and Caddy files under opscrew/runtime and the GitHub Actions deploy workflow. Lists each file as new, changed or unchanged compared with the repository. Writes nothing (opscrew_plan writes the files). It reads the GitHub origin remote (and the Cloudflare zone when the plan has a Cloudflare domain) to fill in the files, and creates the project deploy key in the OpsCrew home when it is missing.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_render", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const preview = await previewDeploymentFiles(phase, servicesOption(options));
        const kindOf = new Map(preview.files.map((f) => [f.path, f.kind]));
        const line = (status: string) => (path: string) =>
          `  ${status.padEnd(9)} ${path} (${kindOf.get(path) ?? "file"})`;
        const toWrite = preview.created.length + preview.changed.length;
        const text = [
          `Deployment files for ${preview.plan.app.name} (${preview.files.length} files):`,
          ...preview.created.map(line("new")),
          ...preview.changed.map(line("changed")),
          ...preview.unchanged.map(line("unchanged")),
          "",
          toWrite === 0
            ? "The repository already has these files. Next: call opscrew_plan to plan the infrastructure."
            : `${toWrite} file${toWrite === 1 ? "" : "s"} would be written. Nothing was written. Next: call opscrew_plan; it writes the files and plans the infrastructure without creating anything.`,
        ].join("\n");
        return {
          text,
          data: {
            files: preview.files,
            created: preview.created,
            changed: preview.changed,
            unchanged: preview.unchanged,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_plan",
    {
      title: "Plan the infrastructure",
      description:
        "Write the generated deployment files into the repository and make an OpenTofu/Terraform plan for the server on the planned cloud provider (Hetzner Cloud or DigitalOcean) and Cloudflare DNS when planned, then check it against OpsCrew's security policies. Returns the plan hash, the resource changes, the monthly cost and the policy results. On a server the user already has, it also inspects the server read-only and returns the host plan (every change OpsCrew would make on the server) with its own hash. When other users on that server log in with a password and no SSH key, OpsCrew stops until the user chooses: pass passwordLogins 'off' (turn password logins off anyway) or 'keep' (leave them on), the CLI's --password-logins, and pass the same value to opscrew_apply. In a Portainer the user already runs, it inspects Portainer read-only (with PORTAINER_API_KEY and the certificate the user confirmed in the interview) and returns the stack plan (the app's stacks, the registry entry, the repository access and the redeploy setting, each marked as already in place or a change) with its own hash, next to the Cloudflare infrastructure plan when the app uses a tunnel or Cloudflare redeploys; when the stack plan needs the tunnel's token it follows after the infrastructure apply. When the app uses a Cloudflare zone it also returns the Cloudflare plan (cloudflarePlanHash): what OpsCrew changes in its shared rules in the zone (the probe block and the strict TLS rule, which list the hostnames of every OpsCrew app there; rules OpsCrew did not create are never changed) and in the account's Zero Trust organization and one-time PIN login. It is approved on its own, before the other plans; when only it is returned, the infrastructure plan follows after it is applied. When the app keeps its files in a bucket on Cloudflare R2, DigitalOcean Spaces or Hetzner Object Storage, it also returns the bucket's plan (storagePlanHash, the opscrew/infra/storage root, with its monthly price), approved on its own; the bucket's key is the user's own and comes only from their terminal or OPSCREW_STORAGE_ACCESS_KEY_ID and OPSCREW_STORAGE_SECRET_ACCESS_KEY, and in the user's Portainer the stack plan follows once the bucket exists. For an environment on the user's computer (localhost) it returns the local plan (the containers, networks, volumes and files OpsCrew would create or change there) with its hash, which opscrew_apply takes as planHash. When the environment's deploy job runs on a runner machine of the user's, or leaves one, it also returns each machine's host plan (runnerHostPlanHashes), each approved on its own. For a site on GitHub Pages it returns the Pages plan (pagesPlanHash: the site published by the workflow and its custom domain, set before any DNS record points at GitHub), the site's DNS records (planHash) and GitHub's domain verification record (pagesVerificationPlanHash), each approved on its own; when OpsCrew stops for the verification value, the user copies it from their GitHub account's Pages settings and you pass it as pagesVerification. For a site on Cloudflare's hosting it returns the Worker and its custom domains (planHash) and the www redirect in the Cloudflare plan. Never applies anything: show the plans to the user, then call opscrew_apply with the hashes. Needs the provider's API token (HCLOUD_TOKEN for Hetzner Cloud, DIGITALOCEAN_TOKEN for DigitalOcean; none for the user's own server, whose SSH host key must have been confirmed once; PORTAINER_API_KEY for the user's Portainer) and GitHub access in the MCP server's environment.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        engine: z
          .enum(["auto", "tofu", "terraform"])
          .optional()
          .describe("IaC engine to use; defaults to the plan's choice (OpenTofu when installed)."),
        passwordLogins: PASSWORD_LOGINS_INPUT.describe(
          'The user\'s own server, only when OpsCrew stopped because other users log in with a password and no SSH key: the user\'s explicit choice, "off" (turn password logins off anyway) or "keep" (leave them on). Ask the user; never choose for them. The host plan shows the choice and the user approves it.',
        ),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
        pagesVerification: PAGES_VERIFICATION_INPUT,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({
      projectDir,
      app,
      environment,
      engine,
      passwordLogins,
      publicImage,
      replaceTokens,
      pagesVerification,
    }) =>
      runTool(deps, "opscrew_plan", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({
          approvalHandler: new PlanToolApprovalHandler(deps.clock),
          app: appKey,
          environment: name,
        });
        const result = await (options.runProvision ?? runProvision)(phase, {
          planOnly: true,
          ...(engine !== undefined ? { engine } : {}),
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...portainerImageOptions(publicImage, replaceTokens),
          ...(pagesVerification === undefined ? {} : { pagesVerification }),
          ...servicesOption(options),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const local = plan.target.provider === "localhost";
        const cost = own || portainer ? undefined : plan.cost;
        const saved =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, result.planHash);
        const hostChanges = async (hash: string) =>
          (await readSavedPlanChanges(phase.paths, "host", hash, PLAN_AGAIN)) === true;
        // A server the user owns: the host plan, approved on its own by its hash.
        const hostHash =
          result.hostPlanHash !== undefined && (await hostChanges(result.hostPlanHash))
            ? result.hostPlanHash
            : undefined;
        const hostText =
          hostHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Host plan for your server", hostHash);
        // The runner machines: the environment's runner off each machine it left, then on its own,
        // each host plan approved on its own by its hash.
        const runnerHashes: string[] = [];
        for (const hash of result.runnerHostPlanHashes ?? []) {
          if (await hostChanges(hash)) runnerHashes.push(hash);
        }
        // This computer: the local plan, approved on its own by its hash.
        const localHash =
          result.localPlanHash !== undefined &&
          (await savedLocalPlanChanges(phase.paths, result.localPlanHash, PLAN_AGAIN))
            ? result.localPlanHash
            : undefined;
        // The user's Portainer: the stack plan, approved on its own by its hash.
        const stackHash =
          result.stackPlanHash !== undefined &&
          (await readSavedPlanChanges(phase.paths, "stack", result.stackPlanHash, PLAN_AGAIN)) ===
            true
            ? result.stackPlanHash
            : undefined;
        const stackText =
          stackHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Stack plan for your Portainer");
        // The app's bucket: the `storage` root's own plan, approved on its own by its hash.
        const storageHash = result.storagePlanHash;
        const storage =
          storageHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, storageHash);
        if (storageHash !== undefined && storage === undefined) {
          throw noSavedPlan("bucket plan", storageHash);
        }
        const stackFollows = portainer
          ? stackFollowsReason(result, saved !== undefined)
          : undefined;
        const second = hostHash ?? stackHash;
        // OpsCrew's shared Cloudflare resources: their plan comes first, approved on its own.
        const cloudflareHash = result.cloudflarePlanHash;
        const cloudflareText =
          cloudflareHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Cloudflare plan for", cloudflareHash);
        // GitHub Pages: the site's settings (the Pages plan) and GitHub's verification record (an
        // infrastructure plan of its own root), each approved on its own.
        const pagesHash = result.pagesPlanHash;
        const pagesText =
          pagesHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Pages plan for the GitHub Pages site", pagesHash);
        const verificationHash = result.pagesVerificationPlanHash;
        const verification =
          verificationHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, verificationHash);
        if (verificationHash !== undefined && verification === undefined) {
          throw noSavedPlan("plan of GitHub's verification record", verificationHash);
        }
        const primary = saved?.planHash ?? second ?? localHash;
        const hashes = [
          ...(cloudflareHash !== undefined ? [cloudflareHash] : []),
          ...(storageHash !== undefined ? [storageHash] : []),
          ...(pagesHash !== undefined ? [pagesHash] : []),
          ...(saved !== undefined ? [saved.planHash] : []),
          ...(verificationHash !== undefined ? [verificationHash] : []),
          ...(second !== undefined ? [second] : []),
          ...runnerHashes,
          ...(localHash !== undefined ? [localHash] : []),
        ];
        // The terminal run repeats this call's engine, password-logins and image choices.
        const command = applyCommand(`provision${flag}`, hashes, {
          ...(engine === "tofu" || engine === "terraform" ? { engine } : {}),
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...(publicImage === undefined ? {} : { publicImage }),
          ...(replaceTokens === undefined ? {} : { replaceTokens }),
        });
        if (hashes.length === 0) {
          const matched = own
            ? "Cloudflare and the user's server already match the plans"
            : portainer
              ? "Cloudflare and the user's Portainer already match the plans"
              : local
                ? "The app on the user's computer already matches the local plan"
                : "The infrastructure already matches the plan";
          return {
            text: `${matched}; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run \`opscrew provision${flag}\` in a terminal to finish any remaining steps.`,
            data: {
              upToDate: true,
              ...(result.planHash ? { planHash: result.planHash } : {}),
              ...(result.stackPlanHash ? { stackPlanHash: result.stackPlanHash } : {}),
              cost,
            },
          };
        }
        const secondArg = hostHash !== undefined ? "hostPlanHash" : "stackPlanHash";
        const extras = [
          ...(passwordLogins === undefined ? [] : [`passwordLogins "${passwordLogins}"`]),
          ...(publicImage === undefined ? [] : [`publicImage ${publicImage}`]),
          ...(replaceTokens === undefined || replaceTokens.length === 0
            ? []
            : [`replaceTokens ${JSON.stringify(replaceTokens)}`]),
        ];
        const applyArgs = [
          ...(primary !== undefined ? [`planHash ${primary}`] : []),
          ...(saved !== undefined && second !== undefined ? [`${secondArg} ${second}`] : []),
          ...(cloudflareHash !== undefined ? [`cloudflarePlanHash ${cloudflareHash}`] : []),
          ...(storageHash !== undefined ? [`storagePlanHash ${storageHash}`] : []),
          ...(pagesHash !== undefined ? [`pagesPlanHash ${pagesHash}`] : []),
          ...(verificationHash !== undefined
            ? [`pagesVerificationPlanHash ${verificationHash}`]
            : []),
          ...(runnerHashes.length > 0
            ? [`runnerHostPlanHashes ${JSON.stringify(runnerHashes)}`]
            : []),
          ...extras,
        ].join(" and ");
        const several = hashes.length > 1;
        const shown =
          ["this plan", "both plans", "all three plans", "all four plans"][hashes.length - 1] ??
          `all ${hashes.length} plans`;
        const runnerTexts = runnerHashes.flatMap((hash) => [
          "",
          planText(call.reporter.messages, "Host plan for the runner machine", hash) ?? "",
        ]);
        const localText =
          localHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Local plan for", localHash);
        const text = [
          ...(cloudflareText !== undefined ? [cloudflareText, ""] : []),
          ...(storage !== undefined ? [bucketPlanText(storage, plan), ""] : []),
          // A server the user owns or their Portainer costs nothing more: no price in the plan.
          ...(pagesText !== undefined ? [pagesText, ""] : []),
          ...(saved !== undefined
            ? [describePlan(saved, plan, own || portainer ? { costUnchanged: true } : {})]
            : []),
          ...(verification !== undefined
            ? ["", describePlan(verification, plan, { costUnchanged: true })]
            : []),
          ...(hostText !== undefined ? ["", hostText] : []),
          ...(stackText !== undefined ? ["", stackText] : []),
          ...runnerTexts,
          ...(localText !== undefined ? ["", localText] : []),
          "",
          `Nothing was created${own ? " and nothing on the user's server was changed" : portainer ? " and nothing in the user's Portainer was changed" : local ? " and nothing on the user's computer was changed" : ""}. Show ${shown} to the user. To apply exactly ${several ? "these plans" : "this plan"}, call opscrew_apply with ${applyArgs}: OpsCrew then asks the user to approve each in a dialog. Without that dialog, the user can run this in a terminal:`,
          `  ${command}`,
          ...(primary === undefined && cloudflareHash !== undefined
            ? [
                "When the infrastructure needs a change once this Cloudflare plan is applied (for example the one-time PIN login it adds), opscrew_apply shows that plan to the user in its own dialog. When this Cloudflare plan removes the app from a zone it left, the new zone's Cloudflare plan needs another opscrew_plan after this apply.",
              ]
            : []),
          ...(stackFollows !== undefined
            ? [
                `The stack plan for the user's Portainer follows once ${stackFollows}: opscrew_apply then shows it to the user in its own dialog. In a terminal script that takes three runs: \`opscrew provision${flag} --plan-only\`, the command above, then \`opscrew provision${flag} --approve <stack plan hash>\`.`,
              ]
            : []),
          ...(saved?.hasDestroy || result.cloudflarePlanDeletes
            ? [
                `This plan deletes or replaces resources; the user must type "${plan.app.name}" to approve it.`,
              ]
            : []),
        ].join("\n");
        return {
          text,
          data: {
            ...(saved !== undefined ? planData(saved) : {}),
            hostPlanHash: hostHash,
            stackPlanHash: stackHash,
            cloudflarePlanHash: cloudflareHash,
            storagePlanHash: storageHash,
            ...(pagesHash !== undefined ? { pagesPlanHash: pagesHash } : {}),
            ...(verificationHash !== undefined
              ? { pagesVerificationPlanHash: verificationHash }
              : {}),
            ...(runnerHashes.length > 0 ? { runnerHostPlanHashes: runnerHashes } : {}),
            ...(localHash !== undefined ? { localPlanHash: localHash } : {}),
            ...(stackFollows !== undefined ? { stackPlanFollows: true } : {}),
            cost,
            applyCommand: command,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_apply",
    {
      title: "Apply an approved plan",
      description:
        "Apply exactly the plan saved by opscrew_plan (pass its planHash) after the USER approves it in an MCP elicitation dialog that shows the plan summary; the coding agent cannot approve it. Creates or changes real resources on the user's cloud provider account (Hetzner Cloud or DigitalOcean, and Cloudflare when planned), waits for the server, then commits the generated files on a branch, pushes it and opens a pull request (each also approved in a dialog). On a server the user already has, also pass hostPlanHash: the host plan is shown and approved in its own dialog before OpsCrew changes the server (when only a host plan was returned, pass it as planHash), with the same passwordLogins choice given to opscrew_plan, if any. In a Portainer the user already runs, also pass stackPlanHash: the stack plan is shown and approved in its own dialog before OpsCrew changes anything in Portainer (when only a stack plan was returned, pass it as planHash; when the stack plan followed the infrastructure plan, it is shown in a dialog after that apply), with the same publicImage and replaceTokens given to opscrew_plan, if any. When opscrew_plan returned a Cloudflare plan, also pass its cloudflarePlanHash (only it when opscrew_plan returned nothing else): it is shown and approved in its own dialog first, and a Cloudflare plan with another hash is refused before any dialog. A Cloudflare plan that deletes OpsCrew's rule asks the user to type the app's name in its dialog. When opscrew_plan returned a bucket plan, also pass its storagePlanHash (only it when opscrew_plan returned nothing else): it is shown and approved in its own dialog. On the user's computer (localhost), pass the local plan's hash as planHash: it is shown and approved in its own dialog. When opscrew_plan returned runnerHostPlanHashes, pass them too: each runner machine's host plan is shown and approved in its own dialog. For a site on GitHub Pages, also pass pagesPlanHash and pagesVerificationPlanHash as opscrew_plan returned them (and the same pagesVerification): each is shown and approved in its own dialog, and a Pages plan with another hash is refused before any dialog. Deploy secrets are stored only when OPSCREW_APP_ENV_FILE names the production environment file; otherwise the user finishes with `opscrew provision` in a terminal. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        planHash: z
          .string()
          .optional()
          .describe(
            "SHA-256 hash of the saved plan, exactly as returned by opscrew_plan (leave it out when opscrew_plan returned only a Cloudflare plan).",
          ),
        cloudflarePlanHash: z
          .string()
          .optional()
          .describe(
            "SHA-256 hash of the Cloudflare plan (OpsCrew's shared rules in the zone and the account's Zero Trust pieces), exactly as returned by opscrew_plan. Without it a Cloudflare plan is refused.",
          ),
        hostPlanHash: z
          .string()
          .optional()
          .describe(
            "The user's own server: SHA-256 hash of the host plan, exactly as returned by opscrew_plan.",
          ),
        stackPlanHash: z
          .string()
          .optional()
          .describe(
            "The user's Portainer: SHA-256 hash of the stack plan, exactly as returned by opscrew_plan.",
          ),
        storagePlanHash: z
          .string()
          .optional()
          .describe(
            "The app's bucket: SHA-256 hash of the bucket plan (the opscrew/infra/storage root), exactly as returned by opscrew_plan. Its key comes only from the user's terminal or OPSCREW_STORAGE_ACCESS_KEY_ID and OPSCREW_STORAGE_SECRET_ACCESS_KEY, never from the chat.",
          ),
        runnerHostPlanHashes: z
          .array(z.string())
          .optional()
          .describe(
            "The runner machines' host plans: their SHA-256 hashes, exactly as returned by opscrew_plan.",
          ),
        pagesPlanHash: z
          .string()
          .optional()
          .describe(
            "A site on GitHub Pages: SHA-256 hash of the Pages plan, exactly as returned by opscrew_plan. Without it a Pages plan is refused.",
          ),
        pagesVerificationPlanHash: z
          .string()
          .optional()
          .describe(
            "A site on GitHub Pages: SHA-256 hash of the plan of GitHub's domain verification record, exactly as returned by opscrew_plan.",
          ),
        passwordLogins: PASSWORD_LOGINS_INPUT.describe(
          "The user's own server: the same password-logins choice that was passed to opscrew_plan (the host plan's hash depends on it).",
        ),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
        pagesVerification: PAGES_VERIFICATION_INPUT,
        keyOut: z
          .string()
          .optional()
          .describe(
            "The first time OpsCrew makes the encrypted recovery copy of the app's secrets: the full path of a file outside the repository, which the user chose, for their new age key. OpsCrew writes the key there once and never returns it; never read that file. Without it, no copy is made yet and the result says how to make it.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    (
      {
        projectDir,
        app,
        environment,
        planHash,
        cloudflarePlanHash,
        hostPlanHash,
        stackPlanHash,
        storagePlanHash,
        runnerHostPlanHashes,
        pagesPlanHash,
        pagesVerificationPlanHash,
        passwordLogins,
        publicImage,
        replaceTokens,
        pagesVerification,
        keyOut,
      },
      extra: CallExtra,
    ) =>
      runTool(deps, "opscrew_apply", projectDir, async (call) => {
        const runnerHashes = (runnerHostPlanHashes ?? []).map((value) => value.toLowerCase());
        const given = [
          planHash,
          cloudflarePlanHash,
          hostPlanHash,
          stackPlanHash,
          storagePlanHash,
          pagesPlanHash,
          pagesVerificationPlanHash,
        ];
        if (
          (planHash === undefined &&
            cloudflarePlanHash === undefined &&
            storagePlanHash === undefined &&
            pagesPlanHash === undefined &&
            pagesVerificationPlanHash === undefined &&
            runnerHashes.length === 0) ||
          [...given, ...runnerHashes].some((value) => value !== undefined && !isPlanHash(value))
        ) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "planHash, cloudflarePlanHash, storagePlanHash, pagesPlanHash, pagesVerificationPlanHash or runnerHostPlanHashes (and hostPlanHash or stackPlanHash) must be the 64-character SHA-256 hashes returned by opscrew_plan.",
            { hint: "Call opscrew_plan, show the plan to the user and pass its planHash." },
          );
        }
        const hash = planHash?.toLowerCase();
        const cloudflareHash = cloudflarePlanHash?.toLowerCase();
        const hostHash = hostPlanHash?.toLowerCase();
        const stackHash = stackPlanHash?.toLowerCase();
        const storageHash = storagePlanHash?.toLowerCase();
        const pagesHash = pagesPlanHash?.toLowerCase();
        const verificationHash = pagesVerificationPlanHash?.toLowerCase();
        const hashes = [
          ...[
            cloudflareHash,
            storageHash,
            pagesHash,
            hash,
            verificationHash,
            hostHash,
            stackHash,
          ].filter((value): value is string => value !== undefined),
          ...runnerHashes,
        ];
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const terminal = applyCommand(`provision${flag}`, hashes, {
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...(publicImage === undefined ? {} : { publicImage }),
          ...(replaceTokens === undefined ? {} : { replaceTokens }),
        });
        requireDialogs(server, terminal);
        const handler = dialogHandler(server, deps, extra);
        const gate = new CloudflarePlanGate(
          handler,
          cloudflareHash,
          {
            hash: storageHash,
            plansDir: resolveProjectPaths(call.projectDir, {
              env: deps.env,
              app: appKey,
              environment: name,
            }).files.plansDir,
          },
          pagesHash,
          deps.clock,
        );
        const phase = await call.phaseDeps({
          approvalHandler: gate,
          app: appKey,
          environment: name,
        });
        const saved =
          hash === undefined ? undefined : await findSavedPlan(phase.paths.files.plansDir, hash);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const local = plan.target.provider === "localhost";
        const savedChanges = (kind: "host" | "stack", planHash: string) =>
          readSavedPlanChanges(phase.paths, kind, planHash, PLAN_AGAIN);
        // A server (the user's own, or the server runner's on one OpsCrew created) whose
        // infrastructure needs no change: the hash names the host plan.
        const onServer = onOneServer(plan.target.provider);
        const hostOnly =
          hash !== undefined &&
          saved === undefined &&
          onServer &&
          (await savedChanges("host", hash)) !== undefined;
        // The user's Portainer whose Cloudflare setup needs no change: the hash names the stack plan.
        const stackOnly =
          hash !== undefined &&
          saved === undefined &&
          portainer &&
          (await savedChanges("stack", hash)) !== undefined;
        // The user's computer: the hash names the local plan.
        const localOnly =
          hash !== undefined &&
          local &&
          (await readSavedLocalPlan(phase.paths, hash, PLAN_AGAIN)) !== undefined;
        if (hash !== undefined && saved === undefined && !hostOnly && !stackOnly && !localOnly) {
          throw noSavedPlan("plan", hash);
        }
        for (const runnerHash of runnerHashes) {
          if ((await savedChanges("host", runnerHash)) === undefined) {
            throw noSavedPlan("host plan of a runner machine", runnerHash);
          }
        }
        if (
          hostHash !== undefined &&
          (!onServer || (await savedChanges("host", hostHash)) === undefined)
        ) {
          throw noSavedPlan("host plan", hostHash);
        }
        if (
          stackHash !== undefined &&
          (!portainer || (await savedChanges("stack", stackHash)) === undefined)
        ) {
          throw noSavedPlan("stack plan", stackHash);
        }
        if (
          storageHash !== undefined &&
          (await findSavedPlan(phase.paths.files.plansDir, storageHash)) === undefined
        ) {
          throw noSavedPlan("bucket plan", storageHash);
        }
        if (
          verificationHash !== undefined &&
          (await findSavedPlan(phase.paths.files.plansDir, verificationHash)) === undefined
        ) {
          throw noSavedPlan("plan of GitHub's verification record", verificationHash);
        }
        const secrets = (phase.env.OPSCREW_APP_ENV_FILE ?? "").trim() !== "";
        let result: ProvisionResult;
        try {
          // The hashes only pick the saved plans: every approval still comes from the user's dialog.
          result = await (options.runProvision ?? runProvision)(phase, {
            approveHashes: [
              ...new Set([
                ...(hash === undefined ? [] : [hash]),
                ...(hostHash === undefined ? [] : [hostHash]),
                ...(stackHash === undefined ? [] : [stackHash]),
                ...(storageHash === undefined ? [] : [storageHash]),
                ...(cloudflareHash === undefined ? [] : [cloudflareHash]),
                ...(pagesHash === undefined ? [] : [pagesHash]),
                ...(verificationHash === undefined ? [] : [verificationHash]),
                ...runnerHashes,
              ]),
            ],
            ...(saved === undefined ? {} : { engine: saved.engine.name }),
            ...(passwordLogins === undefined ? {} : { passwordLogins }),
            ...portainerImageOptions(publicImage, replaceTokens),
            ...(pagesVerification === undefined ? {} : { pagesVerification }),
            ...(keyOut !== undefined ? { recovery: { keyOut: async () => keyOut } } : {}),
            secrets,
            ...servicesOption(options),
          });
        } catch (error) {
          throw refusalWithNextStep(error, handler, gate, flag);
        }
        // The user's computer without its local runner: no GitHub secrets, workflow or pull request.
        const localOnlyRun = local && result.published === undefined;
        const secretsNote =
          secrets || localOnlyRun
            ? []
            : [
                "",
                `The deploy secrets are NOT stored yet: OpsCrew never asks for production values through this chat. Ask the user to run \`opscrew provision${flag}\` in a terminal in the project directory. It finds no infrastructure changes, then asks for the production environment values and stores the GitHub Actions secrets.`,
              ];
        const text = [
          ...(result.cloudflarePlanHash !== undefined
            ? [appliedCloudflarePlan(result.cloudflarePlanHash)]
            : cloudflareHash !== undefined
              ? ["OpsCrew's shared Cloudflare resources needed no change."]
              : []),
          ...(result.pagesPlanHash !== undefined &&
          handler.decisions.some((d) => d.kind === "pages-apply" && d.approved)
            ? [`Applied the Pages plan ${result.pagesPlanHash} to the GitHub Pages site.`]
            : pagesHash !== undefined
              ? ["The GitHub Pages site needed no change."]
              : []),
          ...(result.storagePlanHash !== undefined
            ? [`Applied the plan of the app's bucket ${result.storagePlanHash}.`]
            : storageHash !== undefined
              ? ["The app's bucket needed no change."]
              : []),
          local
            ? result.localApplied === true
              ? `Ran the app on the user's computer (local plan ${result.localPlanHash}).`
              : "The app on the user's computer needed no change."
            : saved !== undefined
              ? result.applied
                ? `Applied plan ${saved.planHash}.`
                : `Plan ${saved.planHash} had nothing left to apply; the infrastructure already matches it.`
              : result.applied
                ? `Applied the infrastructure plan ${result.planHash}.`
                : "The infrastructure needed no change.",
          ...(own
            ? [
                result.hostApplied === true
                  ? `Prepared the user's server (host plan ${result.hostPlanHash}).`
                  : "The user's server needed no change.",
                OWN_SERVER_BACKUPS_NOTE,
              ]
            : result.hostPlanHash !== undefined
              ? [
                  result.hostApplied === true
                    ? `Applied the server's host plan ${result.hostPlanHash} (its runner).`
                    : "The server's runner needed no change.",
                ]
              : []),
          ...(portainer
            ? [
                result.stackApplied === true
                  ? `Set up the app's stacks in the user's Portainer (stack plan ${result.stackPlanHash}).`
                  : "The user's Portainer needed no change.",
                PORTAINER_NOTES,
              ]
            : []),
          ...(result.runnerHostPlanHashes !== undefined
            ? [`The runner machines' host plans: ${result.runnerHostPlanHashes.join(", ")}.`]
            : []),
          ...outputsLines(result, own || portainer),
          ...publishedLines(result),
          ...secretsNote,
          "",
          localOnlyRun
            ? "Next: call opscrew_verify to check the app on the user's computer."
            : nextLine(result, secrets),
        ].join("\n");
        return {
          text,
          data: {
            planHash: hash,
            ...(result.cloudflarePlanHash !== undefined
              ? { cloudflarePlanHash: result.cloudflarePlanHash }
              : {}),
            ...(result.storagePlanHash !== undefined
              ? { storagePlanHash: result.storagePlanHash }
              : {}),
            applied: result.applied,
            ...(result.hostPlanHash !== undefined
              ? { hostPlanHash: result.hostPlanHash, hostApplied: result.hostApplied === true }
              : {}),
            ...(result.stackPlanHash !== undefined
              ? { stackPlanHash: result.stackPlanHash, stackApplied: result.stackApplied === true }
              : {}),
            ...(result.localPlanHash !== undefined
              ? { localPlanHash: result.localPlanHash, localApplied: result.localApplied === true }
              : {}),
            ...(result.runnerHostPlanHashes !== undefined
              ? { runnerHostPlanHashes: result.runnerHostPlanHashes }
              : {}),
            outputs: own || portainer ? {} : result.outputs,
            secretsStored: secrets,
            approvals: handler.decisions,
            ...(result.prUrl ? { prUrl: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(secrets || localOnlyRun ? {} : { nextStep: `opscrew provision${flag}` }),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_secure",
    {
      title: "Security check of the deployment",
      description:
        "Re-scan the repository, re-check the applied plan against the security policies, run hardening checks on the server over SSH (password and root login, firewall, fail2ban, automatic updates, Docker exposure, listening ports, pending reboot, disk) and probe from outside that only the expected ports answer. In a Portainer the user already runs it checks the app's stack through Portainer's API instead (never the host: its firewall, SSH and Portainer's own security stay the user's, as do backups). With deep, it also runs three pinned audits, read-only: Lynis on the server (through Docker over SSH), and ssh-audit and testssl.sh in Docker on the user's computer (skipped with how to enable them when Docker is missing; in a Portainer only testssl.sh), each with its known noise set apart; this takes a few minutes. Writes opscrew/SECURITY_REPORT.md and returns every check result and the problems to fix. Changes nothing on the server or in Portainer.",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        offline: z
          .boolean()
          .optional()
          .describe("Skip the online dependency-vulnerability lookup (default false)."),
        deep: z
          .boolean()
          .optional()
          .describe(
            "Also run the deeper checks: Lynis, ssh-audit and testssl.sh (default false). Only when the user asks for them.",
          ),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, app, environment, offline, deep }) =>
      runTool(deps, "opscrew_secure", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const result = await runSecure(phase, {
          offline: offline ?? false,
          scanners: deps.scanners(),
          ...options.secure,
          ...(deep === true ? { deep: true } : {}),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan).catch(() => undefined);
        const inPortainer = plan?.target.provider === "portainer";
        const lines = [
          result.summary.trimEnd(),
          ...(result.hostChecks.length > 0
            ? [
                "",
                inPortainer ? "Checks of the app's stack in Portainer:" : "Server checks:",
                ...checkLines(result.hostChecks),
              ]
            : []),
          ...(inPortainer ? ["", PORTAINER_NOTES] : []),
          ...(result.probes.length > 0
            ? ["", "Outside probes:", ...checkLines(result.probes)]
            : []),
          ...(result.deep !== undefined ? deepLines(result.deep) : []),
          "",
          `Report: ${result.reportPath}`,
        ];
        return {
          text: lines.join("\n"),
          data: {
            passed: result.passed,
            summary: result.summary,
            problems: result.problems,
            hostChecks: result.hostChecks,
            probes: result.probes,
            ...(result.deep !== undefined ? { deep: result.deep } : {}),
            policies: result.policies,
            scan: { counts: result.scan.counts, findings: result.scan.findings.length },
            reportPath: result.reportPath,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_verify",
    {
      title: "Verify the live deployment",
      description:
        "Check the live deployment from outside: DNS, HTTPS and certificate validity, the HTTP-to-HTTPS redirect, the health endpoint, security headers, that .env and .git are not served, that the origin is not reachable around Cloudflare, and the latest GitHub Actions deploy run. Writes opscrew/RUNBOOK.md (deploys, rollbacks, logs, SSH access, backups, secret rotation, costs) and returns every check result. Run it after the deploy pull request is merged. For an app in the user's Portainer behind their own reverse proxy, pass url: the address the proxy serves the app on (refused for every other deployment).",
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        url: z
          .string()
          .optional()
          .describe(
            "Only for an app in the user's Portainer behind their own reverse proxy: the address the proxy serves the app on (for example https://shop.example.com), checked instead of the domain. Ask the user for it.",
          ),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, app, environment, url }) =>
      runTool(deps, "opscrew_verify", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const route = url?.trim();
        const result = await runVerify(phase, {
          ...options.verify,
          ...(route === undefined || route === "" ? {} : { url: route }),
        });
        // Portainer's address is never shown, not even inside the route the user gave.
        const checked = phase.redactor.redact(result.url);
        const checks = phase.redactor.redactDeep(result.checks);
        const summary = summarizeChecks(checks);
        const text = [
          result.passed
            ? `${checked} is live and healthy (${summary}).`
            : `Verification of ${checked} found problems (${summary}). Fix them and call opscrew_verify again.`,
          ...checkLines(checks),
          "",
          `Runbook: ${result.runbookPath}`,
        ].join("\n");
        return {
          text,
          data: {
            passed: result.passed,
            url: checked,
            summary,
            checks,
            runbookPath: result.runbookPath,
          },
        };
      }),
  );
}

/**
 * Adds the next step to a refusal: a new opscrew_plan when a Cloudflare or bucket plan
 * opscrew_plan did not return was refused (`gate`); otherwise the user declined in a dialog, so
 * the step is opscrew_apply again or plain `opscrew provision` in a terminal (which shows each plan
 * and asks), never `--approve <hash>`, which would apply without asking.
 */
function refusalWithNextStep(
  error: unknown,
  handler: ElicitationApprovalHandler,
  gate: Pick<CloudflarePlanGate, "refusedOther" | "refusedBucket" | "refusedPages">,
  flag: string,
): unknown {
  if (!isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") return error;
  if (gate.refusedPages) {
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      "opscrew_plan did not return this Pages plan to the user, so OpsCrew did not show or apply it, and the GitHub Pages site was not changed.",
      {
        hint: "Call opscrew_plan again, show the user its Pages plan and pass its pagesPlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  // Cloudflare is changed once its shared plan or the infrastructure plan was approved, and the
  // GitHub Pages site once its Pages plan was.
  const applyApproved = handler.decisions.some(
    (d) =>
      (d.kind === "iac-apply" || d.kind === "cloudflare-apply" || d.kind === "pages-apply") &&
      d.approved,
  );
  if (gate.refusedBucket) {
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      "opscrew_plan did not return this plan of the app's bucket to the user, so OpsCrew did not show or apply it, and the bucket was not changed.",
      {
        hint: "Call opscrew_plan, show the user its bucket plan and pass its storagePlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  if (gate.refusedOther) {
    // The app moved zones: the removal from the zone it left is applied, the new zone's plan is not.
    const leftApplied = handler.decisions.some((d) => d.kind === "cloudflare-apply" && d.approved);
    return new OpsCrewError(
      "APPROVAL_REFUSED",
      leftApplied
        ? "The Cloudflare plan for the zone the app left is applied. The Cloudflare plan for its new zone was not returned by opscrew_plan, so nothing in the new zone was changed."
        : error.message,
      {
        hint: "Call opscrew_plan again, show the user its Cloudflare plan and pass its cloudflarePlanHash to opscrew_apply with the other hashes.",
        cause: error,
      },
    );
  }
  const hostRefused = handler.decisions.some((d) => d.kind === "host-apply" && !d.approved);
  const stackRefused = handler.decisions.some((d) => d.kind === "stack-apply" && !d.approved);
  if (stackRefused || hostRefused) {
    // The user's Portainer, own server, runner machine or computer: Cloudflare may already be
    // changed; the declined plan's target is not. A host plan's refusal names its machine.
    const declined = stackRefused
      ? applyApproved
        ? "The user declined the stack plan. The Cloudflare changes are applied; nothing in the user's Portainer was changed."
        : "The user declined the stack plan; nothing in the user's Portainer was changed."
      : `${error.message}${applyApproved ? " The Cloudflare changes are applied." : ""}`;
    return new OpsCrewError("APPROVAL_REFUSED", declined, {
      hint: `When the user is ready, call opscrew_plan again (it shows what is still missing) and opscrew_apply with its hashes, or ask them to run \`opscrew provision${flag}\` in a terminal in the project directory.`,
      cause: error,
    });
  }
  const next = applyApproved
    ? `Ask the user to run \`opscrew provision${flag}\` in a terminal in the project directory when ready; it continues where this stopped.`
    : `Nothing was applied. When the user is ready, call opscrew_apply again, or ask them to run \`opscrew provision${flag}\` in a terminal in the project directory: it shows each plan and asks.`;
  return new OpsCrewError("APPROVAL_REFUSED", error.message, { hint: next, cause: error });
}
