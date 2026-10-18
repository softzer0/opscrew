import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  applyCommand,
  CHECK_MARK,
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
  readSavedPlanChanges,
  runProvision,
  runSecure,
  runVerify,
  type SavedPlan,
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
import { approvalDecision, isPlanHash, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import {
  type CallExtra,
  dialogHandler,
  type ElicitationApprovalHandler,
  REQUIRES_USER,
  requireDialogs,
} from "./elicitation";
import { appliedCloudflarePlan, IDEMPOTENT_WRITE, projectDirInput, runTool } from "./shared";

/**
 * Test-only collaborators for the deploy tools. Production leaves them unset, so every phase uses
 * its real defaults (engine binary, provider APIs, SSH, DNS, TLS, TCP).
 */
export interface DeployToolOptions {
  /** Fakes for `runProvision` / `previewDeploymentFiles` (engine, cloud provider, GitHub, SSH, waits). */
  provisionServices?: ProvisionServices;
  /** Fakes for `runSecure` (remote shell, TCP probe). */
  secure?: Pick<RunSecureOptions, "remote" | "tcpConnect" | "probeTimeoutMs" | "portainer">;
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

function checkLines(checks: readonly CheckResult[]): string[] {
  return checks.map(
    (c) =>
      `${CHECK_MARK[c.status]} [${c.severity}] ${c.title}: ${c.message}${c.status === "fail" && c.remediation ? ` Fix: ${c.remediation}` : ""}`,
  );
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
 * Cloudflare plan the chat did not show.
 */
class CloudflarePlanGate implements ApprovalHandler {
  /** True once a Cloudflare plan with another hash was refused. */
  refusedOther = false;

  constructor(
    private readonly dialogs: ElicitationApprovalHandler,
    private readonly hash: string | undefined,
    private readonly clock: Clock,
  ) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
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
 * with the `opscrew provision --approve <hash>` command when the client cannot elicit or the user
 * declines), `opscrew_secure` and `opscrew_verify`. `options` is for tests only.
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
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_render", projectDir, async (call) => {
        const phase = await call.phaseDeps();
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
        "Write the generated deployment files into the repository and make an OpenTofu/Terraform plan for the server on the planned cloud provider (Hetzner Cloud or DigitalOcean) and Cloudflare DNS when planned, then check it against OpsCrew's security policies. Returns the plan hash, the resource changes, the monthly cost and the policy results. On a server the user already has, it also inspects the server read-only and returns the host plan (every change OpsCrew would make on the server) with its own hash. When other users on that server log in with a password and no SSH key, OpsCrew stops until the user chooses: pass passwordLogins 'off' (turn password logins off anyway) or 'keep' (leave them on), the CLI's --password-logins, and pass the same value to opscrew_apply. In a Portainer the user already runs, it inspects Portainer read-only (with PORTAINER_API_KEY and the certificate the user confirmed in the interview) and returns the stack plan (the app's stacks, the registry entry, the repository access and the redeploy setting, each marked as already in place or a change) with its own hash, next to the Cloudflare infrastructure plan when the app uses a tunnel or Cloudflare redeploys; when the stack plan needs the tunnel's token it follows after the infrastructure apply. When the app uses a Cloudflare zone it also returns the Cloudflare plan (cloudflarePlanHash): what OpsCrew changes in its shared rules in the zone (the probe block and the strict TLS rule, which list the hostnames of every OpsCrew app there; rules OpsCrew did not create are never changed) and in the account's Zero Trust organization and one-time PIN login. It is approved on its own, before the other plans; when only it is returned, the infrastructure plan follows after it is applied. Never applies anything: show the plans to the user, then call opscrew_apply with the hashes. Needs the provider's API token (HCLOUD_TOKEN for Hetzner Cloud, DIGITALOCEAN_TOKEN for DigitalOcean; none for the user's own server, whose SSH host key must have been confirmed once; PORTAINER_API_KEY for the user's Portainer) and GitHub access in the MCP server's environment.",
      inputSchema: {
        ...projectDirInput,
        engine: z
          .enum(["auto", "tofu", "terraform"])
          .optional()
          .describe("IaC engine to use; defaults to the plan's choice (OpenTofu when installed)."),
        passwordLogins: PASSWORD_LOGINS_INPUT.describe(
          'The user\'s own server, only when OpsCrew stopped because other users log in with a password and no SSH key: the user\'s explicit choice, "off" (turn password logins off anyway) or "keep" (leave them on). Ask the user; never choose for them. The host plan shows the choice and the user approves it.',
        ),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, engine, passwordLogins, publicImage, replaceTokens }) =>
      runTool(deps, "opscrew_plan", projectDir, async (call) => {
        const phase = await call.phaseDeps({
          approvalHandler: new PlanToolApprovalHandler(deps.clock),
        });
        const result = await (options.runProvision ?? runProvision)(phase, {
          planOnly: true,
          ...(engine !== undefined ? { engine } : {}),
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...portainerImageOptions(publicImage, replaceTokens),
          ...servicesOption(options),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const cost = own || portainer ? undefined : plan.cost;
        const saved =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, result.planHash);
        // A server the user owns: the host plan, approved on its own by its hash.
        const hostHash =
          result.hostPlanHash !== undefined &&
          (await readSavedPlanChanges(phase.paths, "host", result.hostPlanHash, PLAN_AGAIN)) ===
            true
            ? result.hostPlanHash
            : undefined;
        const hostText =
          hostHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Host plan for your server");
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
        // The stack plan needs the Cloudflare Tunnel's token, which exists only after the apply.
        const stackFollows = portainer && saved !== undefined && result.stackPlanHash === undefined;
        const second = hostHash ?? stackHash;
        // OpsCrew's shared Cloudflare resources: their plan comes first, approved on its own.
        const cloudflareHash = result.cloudflarePlanHash;
        const cloudflareText =
          cloudflareHash === undefined
            ? undefined
            : planText(call.reporter.messages, "Cloudflare plan for", cloudflareHash);
        const primary = saved?.planHash ?? second;
        const hashes = [
          ...(cloudflareHash !== undefined ? [cloudflareHash] : []),
          ...(saved !== undefined ? [saved.planHash] : []),
          ...(second !== undefined ? [second] : []),
        ];
        // The terminal run repeats this call's engine, password-logins and image choices.
        const command = applyCommand("provision", hashes, {
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
              : "The infrastructure already matches the plan";
          return {
            text: `${matched}; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run \`opscrew provision\` in a terminal to finish any remaining steps.`,
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
          ...extras,
        ].join(" and ");
        const several = hashes.length > 1;
        const shown = ["this plan", "both plans", "all three plans"][hashes.length - 1];
        const text = [
          ...(cloudflareText !== undefined ? [cloudflareText, ""] : []),
          // A server the user owns or their Portainer costs nothing more: no price in the plan.
          ...(saved !== undefined
            ? [describePlan(saved, plan, own || portainer ? { costUnchanged: true } : {})]
            : []),
          ...(hostText !== undefined ? ["", hostText] : []),
          ...(stackText !== undefined ? ["", stackText] : []),
          "",
          `Nothing was created${own ? " and nothing on the user's server was changed" : portainer ? " and nothing in the user's Portainer was changed" : ""}. Show ${shown} to the user. To apply exactly ${several ? "these plans" : "this plan"}, call opscrew_apply with ${applyArgs}: OpsCrew then asks the user to approve each in a dialog. Without that dialog, the user can run this in a terminal:`,
          `  ${command}`,
          ...(primary === undefined
            ? [
                "When the infrastructure needs a change once this Cloudflare plan is applied (for example the one-time PIN login it adds), opscrew_apply shows that plan to the user in its own dialog. When this Cloudflare plan removes the app from a zone it left, the new zone's Cloudflare plan needs another opscrew_plan after this apply.",
              ]
            : []),
          ...(stackFollows
            ? [
                "The stack plan for the user's Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token: opscrew_apply then shows it to the user in its own dialog. In a terminal script that takes three runs: `opscrew provision --plan-only`, the command above, then `opscrew provision --approve <stack plan hash>`.",
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
            ...(stackFollows ? { stackPlanFollows: true } : {}),
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
        "Apply exactly the plan saved by opscrew_plan (pass its planHash) after the USER approves it in an MCP elicitation dialog that shows the plan summary; the coding agent cannot approve it. Creates or changes real resources on the user's cloud provider account (Hetzner Cloud or DigitalOcean, and Cloudflare when planned), waits for the server, then commits the generated files on a branch, pushes it and opens a pull request (each also approved in a dialog). On a server the user already has, also pass hostPlanHash: the host plan is shown and approved in its own dialog before OpsCrew changes the server (when only a host plan was returned, pass it as planHash), with the same passwordLogins choice given to opscrew_plan, if any. In a Portainer the user already runs, also pass stackPlanHash: the stack plan is shown and approved in its own dialog before OpsCrew changes anything in Portainer (when only a stack plan was returned, pass it as planHash; when the stack plan followed the infrastructure plan, it is shown in a dialog after that apply), with the same publicImage and replaceTokens given to opscrew_plan, if any. When opscrew_plan returned a Cloudflare plan, also pass its cloudflarePlanHash (only it when opscrew_plan returned nothing else): it is shown and approved in its own dialog first, and a Cloudflare plan with another hash is refused before any dialog. A Cloudflare plan that deletes OpsCrew's rule asks the user to type the app's name in its dialog. Deploy secrets are stored only when OPSCREW_APP_ENV_FILE names the production environment file; otherwise the user finishes with `opscrew provision` in a terminal. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
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
        passwordLogins: PASSWORD_LOGINS_INPUT.describe(
          "The user's own server: the same password-logins choice that was passed to opscrew_plan (the host plan's hash depends on it).",
        ),
        publicImage: PUBLIC_IMAGE_INPUT,
        replaceTokens: REPLACE_TOKENS_INPUT,
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
        planHash,
        cloudflarePlanHash,
        hostPlanHash,
        stackPlanHash,
        passwordLogins,
        publicImage,
        replaceTokens,
      },
      extra: CallExtra,
    ) =>
      runTool(deps, "opscrew_apply", projectDir, async (call) => {
        const given = [planHash, cloudflarePlanHash, hostPlanHash, stackPlanHash];
        if (
          (planHash === undefined && cloudflarePlanHash === undefined) ||
          given.some((value) => value !== undefined && !isPlanHash(value))
        ) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "planHash or cloudflarePlanHash (and hostPlanHash or stackPlanHash) must be the 64-character SHA-256 hashes returned by opscrew_plan.",
            { hint: "Call opscrew_plan, show the plan to the user and pass its planHash." },
          );
        }
        const hash = planHash?.toLowerCase();
        const cloudflareHash = cloudflarePlanHash?.toLowerCase();
        const hostHash = hostPlanHash?.toLowerCase();
        const stackHash = stackPlanHash?.toLowerCase();
        const hashes = [cloudflareHash, hash, hostHash, stackHash].filter(
          (value): value is string => value !== undefined,
        );
        const terminal = applyCommand("provision", hashes, {
          ...(passwordLogins === undefined ? {} : { passwordLogins }),
          ...(publicImage === undefined ? {} : { publicImage }),
          ...(replaceTokens === undefined ? {} : { replaceTokens }),
        });
        requireDialogs(server, terminal);
        const handler = dialogHandler(server, deps, extra);
        const gate = new CloudflarePlanGate(handler, cloudflareHash, deps.clock);
        const phase = await call.phaseDeps({ approvalHandler: gate });
        const saved =
          hash === undefined ? undefined : await findSavedPlan(phase.paths.files.plansDir, hash);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        const savedChanges = (kind: "host" | "stack", planHash: string) =>
          readSavedPlanChanges(phase.paths, kind, planHash, PLAN_AGAIN);
        // A server the user owns whose infrastructure needs no change: the hash names the host plan.
        const hostOnly =
          hash !== undefined &&
          saved === undefined &&
          own &&
          (await savedChanges("host", hash)) !== undefined;
        // The user's Portainer whose Cloudflare setup needs no change: the hash names the stack plan.
        const stackOnly =
          hash !== undefined &&
          saved === undefined &&
          portainer &&
          (await savedChanges("stack", hash)) !== undefined;
        if (hash !== undefined && saved === undefined && !hostOnly && !stackOnly) {
          throw noSavedPlan("plan", hash);
        }
        if (
          hostHash !== undefined &&
          (!own || (await savedChanges("host", hostHash)) === undefined)
        ) {
          throw noSavedPlan("host plan", hostHash);
        }
        if (
          stackHash !== undefined &&
          (!portainer || (await savedChanges("stack", stackHash)) === undefined)
        ) {
          throw noSavedPlan("stack plan", stackHash);
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
                ...(cloudflareHash === undefined ? [] : [cloudflareHash]),
              ]),
            ],
            ...(saved === undefined ? {} : { engine: saved.engine.name }),
            ...(passwordLogins === undefined ? {} : { passwordLogins }),
            ...portainerImageOptions(publicImage, replaceTokens),
            secrets,
            ...servicesOption(options),
          });
        } catch (error) {
          throw refusalWithNextStep(error, handler, terminal, gate.refusedOther);
        }
        const secretsNote = secrets
          ? []
          : [
              "",
              "The deploy secrets are NOT stored yet: OpsCrew never asks for production values through this chat. Ask the user to run `opscrew provision` in a terminal in the project directory. It finds no infrastructure changes, then asks for the production environment values and stores the GitHub Actions secrets.",
            ];
        const text = [
          ...(result.cloudflarePlanHash !== undefined
            ? [appliedCloudflarePlan(result.cloudflarePlanHash)]
            : cloudflareHash !== undefined
              ? ["OpsCrew's shared Cloudflare resources needed no change."]
              : []),
          saved !== undefined
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
            : []),
          ...(portainer
            ? [
                result.stackApplied === true
                  ? `Set up the app's stacks in the user's Portainer (stack plan ${result.stackPlanHash}).`
                  : "The user's Portainer needed no change.",
                PORTAINER_NOTES,
              ]
            : []),
          ...outputsLines(result, own || portainer),
          ...(result.prUrl
            ? [`Pull request with the deployment files: ${result.prUrl}`]
            : result.branch
              ? [`Deployment files committed on branch ${result.branch}.`]
              : []),
          ...secretsNote,
          "",
          secrets
            ? "Next: merge the pull request to deploy, then call opscrew_verify."
            : "Then merge the pull request to deploy and call opscrew_verify.",
        ].join("\n");
        return {
          text,
          data: {
            planHash: hash,
            ...(result.cloudflarePlanHash !== undefined
              ? { cloudflarePlanHash: result.cloudflarePlanHash }
              : {}),
            applied: result.applied,
            ...(result.hostPlanHash !== undefined
              ? { hostPlanHash: result.hostPlanHash, hostApplied: result.hostApplied === true }
              : {}),
            ...(result.stackPlanHash !== undefined
              ? { stackPlanHash: result.stackPlanHash, stackApplied: result.stackApplied === true }
              : {}),
            outputs: own || portainer ? {} : result.outputs,
            secretsStored: secrets,
            approvals: handler.decisions,
            ...(result.prUrl ? { prUrl: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(secrets ? {} : { nextStep: "opscrew provision" }),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_secure",
    {
      title: "Security check of the deployment",
      description:
        "Re-scan the repository, re-check the applied plan against the security policies, run hardening checks on the server over SSH (password and root login, firewall, fail2ban, automatic updates, Docker exposure, listening ports, pending reboot, disk) and probe from outside that only the expected ports answer. In a Portainer the user already runs it checks the app's stack through Portainer's API instead (never the host: its firewall, SSH and Portainer's own security stay the user's, as do backups). Writes opscrew/SECURITY_REPORT.md and returns every check result and the problems to fix. Changes nothing on the server or in Portainer.",
      inputSchema: {
        ...projectDirInput,
        offline: z
          .boolean()
          .optional()
          .describe("Skip the online dependency-vulnerability lookup (default false)."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, offline }) =>
      runTool(deps, "opscrew_secure", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const result = await runSecure(phase, {
          offline: offline ?? false,
          scanners: deps.scanners(),
          ...options.secure,
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
        url: z
          .string()
          .optional()
          .describe(
            "Only for an app in the user's Portainer behind their own reverse proxy: the address the proxy serves the app on (for example https://shop.example.com), checked instead of the domain. Ask the user for it.",
          ),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, url }) =>
      runTool(deps, "opscrew_verify", projectDir, async (call) => {
        const phase = await call.phaseDeps();
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
 * Adds the next step to a refusal: a new opscrew_plan when a Cloudflare plan opscrew_plan did not
 * return was refused (`otherCloudflarePlan`), `--approve <hash>` while nothing is applied yet,
 * plain `opscrew provision` once something was (a later step was refused; it resumes from there).
 */
function refusalWithNextStep(
  error: unknown,
  handler: ElicitationApprovalHandler,
  terminal: string,
  otherCloudflarePlan: boolean,
): unknown {
  if (!isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") return error;
  // Cloudflare is changed once its shared plan or the infrastructure plan was approved.
  const applyApproved = handler.decisions.some(
    (d) => (d.kind === "iac-apply" || d.kind === "cloudflare-apply") && d.approved,
  );
  if (otherCloudflarePlan) {
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
    // The user's Portainer or own server: Cloudflare may already be changed; the target is not.
    const [plan, where] = stackRefused
      ? ["stack plan", "in the user's Portainer"]
      : ["host plan", "on the user's server"];
    const message = applyApproved
      ? `The user declined the ${plan}. The Cloudflare changes are applied; nothing ${where} was changed.`
      : `The user declined the ${plan}; nothing ${where} was changed.`;
    return new OpsCrewError("APPROVAL_REFUSED", message, {
      hint: "When the user is ready, call opscrew_plan again (it shows what is still missing) and opscrew_apply with its hashes, or ask them to run `opscrew provision` in a terminal in the project directory.",
      cause: error,
    });
  }
  const next = applyApproved
    ? "Ask the user to run `opscrew provision` in a terminal in the project directory when ready; it continues where this stopped."
    : `Nothing was applied. When the user is ready, call opscrew_apply again, or ask them to run \`${terminal}\` in a terminal.`;
  return new OpsCrewError("APPROVAL_REFUSED", error.message, { hint: next, cause: error });
}
