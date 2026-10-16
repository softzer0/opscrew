import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import {
  describePlan,
  findSavedPlan,
  hostPlanFile,
  type PhaseDeps,
  PORTAINER_BACKUPS_NOTE,
  PORTAINER_HOST_NOTE,
  type ProvisionOptions,
  type ProvisionResult,
  type ProvisionServices,
  previewDeploymentFiles,
  type RunSecureOptions,
  type RunVerifyOptions,
  runProvision,
  runSecure,
  runVerify,
  type SavedPlan,
  stackPlanFile,
  summarizeChecks,
} from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalKind,
  ApprovalRequest,
  CheckResult,
  Clock,
} from "@opscrew/contracts";
import { isPlanHash, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool } from "./shared";

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

/** How long OpsCrew waits for the user to answer one approval dialog. */
const ELICITATION_TIMEOUT_MS = 30 * 60_000;

/** `_meta` that makes Claude Code ask for permission on every call, even in auto modes. */
const REQUIRES_USER = { "anthropic/requiresUserInteraction": true } as const;

/** Per-call context the SDK passes to a tool callback (only what the deploy tools use). */
interface CallExtra {
  requestId?: string | number;
  signal?: AbortSignal;
}

/** True when the connected client declared form-mode MCP elicitation. */
export function clientSupportsElicitation(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (elicitation === undefined) return false;
  // An empty capability object means form mode (backwards compatibility).
  return elicitation.form !== undefined || elicitation.url === undefined;
}

const ElicitedAnswer = z.object({
  approve: z.boolean().optional(),
  confirmation: z.string().optional(),
});

/** The text of the approval dialog: title, details, failed policies, cost and destroy warning. */
export function approvalMessage(request: ApprovalRequest): string {
  const lines = [`OpsCrew asks for your approval: ${request.title}`, ""];
  if (request.details.trim() !== "") lines.push(request.details.trimEnd(), "");
  const failures = (request.policy ?? []).filter((result) => !result.passed);
  if (failures.length > 0) {
    lines.push("Policy checks that did not pass:");
    for (const f of failures) lines.push(`  ✗ [${f.severity}] ${f.title}: ${f.message}`);
    lines.push("");
  }
  if (request.costDelta !== undefined) {
    const { amount, currency } = request.costDelta;
    const change = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      signDisplay: "always",
    }).format(amount);
    lines.push(`Monthly cost change: ${change}`, "");
  }
  if (request.allowDestroy === true) {
    lines.push("WARNING: this change deletes or replaces resources.", "");
  }
  lines.push(
    request.confirmPhrase === undefined
      ? "Approve only if you reviewed the change above. Your coding agent cannot approve this for you."
      : `To approve, type "${request.confirmPhrase}" exactly. Anything else cancels.`,
  );
  return lines.join("\n");
}

/**
 * Asks the human through MCP elicitation (a dialog in the client, not the model). Each request
 * becomes a form with one yes/no field, or a text field when the user must type `confirmPhrase`.
 * It never asks for secret values. Declines, cancels, wrong phrases and client errors all refuse.
 */
export class ElicitationApprovalHandler implements ApprovalHandler {
  /** Every request and its outcome, in order. */
  readonly decisions: { kind: ApprovalKind; approved: boolean }[] = [];

  constructor(
    private readonly server: McpServer,
    private readonly options: {
      clock: Clock;
      redact: (text: string) => string;
      extra?: CallExtra;
    },
  ) {}

  private approver(): string {
    const client = this.server.server.getClientVersion()?.name;
    return `user via ${client ?? "MCP client"} (elicitation)`;
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = await this.ask(request);
    this.decisions.push({ kind: request.kind, approved: decision.approved });
    return decision;
  }

  private async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decide = (approved: boolean, extra: Partial<ApprovalDecision> = {}) => ({
      approved,
      approver: this.approver(),
      decidedAt: this.options.clock.now().toISOString(),
      ...extra,
    });
    const phrase = request.confirmPhrase;
    const requestedSchema: ElicitRequestFormParams["requestedSchema"] = {
      type: "object" as const,
      properties:
        phrase === undefined
          ? {
              approve: {
                type: "boolean" as const,
                title: "Approve",
                description: request.title,
                default: false,
              },
            }
          : {
              confirmation: {
                type: "string" as const,
                title: `Type "${phrase}" to approve`,
                description: request.title,
              },
            },
      required: [phrase === undefined ? "approve" : "confirmation"],
    };
    const extra = this.options.extra;
    let result: Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;
    try {
      result = await this.server.server.elicitInput(
        { mode: "form", message: this.options.redact(approvalMessage(request)), requestedSchema },
        {
          timeout: ELICITATION_TIMEOUT_MS,
          ...(extra?.requestId !== undefined ? { relatedRequestId: extra.requestId } : {}),
          ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
        },
      );
    } catch {
      return decide(false, {
        reason: "the approval dialog could not be shown or was not answered",
      });
    }
    if (result.action !== "accept") {
      return decide(false, {
        reason: result.action === "decline" ? "declined by the user" : "cancelled by the user",
      });
    }
    const answer = ElicitedAnswer.safeParse(result.content ?? {});
    if (!answer.success) return decide(false, { reason: "the approval answer was not understood" });
    if (phrase !== undefined) {
      const typed = (answer.data.confirmation ?? "").trim();
      return typed === phrase
        ? decide(true, { confirmation: typed })
        : decide(false, { confirmation: typed, reason: "confirmation phrase did not match" });
    }
    return answer.data.approve === true
      ? decide(true)
      : decide(false, { reason: "declined by the user" });
  }
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
    return {
      approved,
      approver: "user (opscrew_plan tool call)",
      decidedAt: this.clock.now().toISOString(),
      ...(approved
        ? {}
        : {
            reason:
              "opscrew_plan only plans. Apply the plan with opscrew_apply or `opscrew provision --approve <hash>`.",
          }),
    };
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
  const mark = { pass: "✓", fail: "✗", warn: "!", skip: "-" } as const;
  return checks.map(
    (c) =>
      `${mark[c.status]} [${c.severity}] ${c.title}: ${c.message}${c.status === "fail" && c.remediation ? ` Fix: ${c.remediation}` : ""}`,
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
  .array(z.enum(["repository", "registry"]))
  .max(2)
  .optional()
  .describe(
    'The user\'s Portainer, only when the user rotated a token and asks to send it again: "repository" (OPSCREW_REPO_READ_TOKEN) and/or "registry" (OPSCREW_GHCR_READ_TOKEN). Never the tokens themselves. Pass the same value to opscrew_plan and opscrew_apply.',
  );

/** `publicImage` and `replaceTokens` for `runProvision` from the tool's inputs. */
function portainerOptions(input: {
  publicImage?: boolean | undefined;
  replaceTokens?: readonly ("repository" | "registry")[] | undefined;
}): Pick<ProvisionOptions, "publicImage" | "replaceTokens"> {
  const tokens = input.replaceTokens ?? [];
  return {
    ...(input.publicImage === undefined ? {} : { publicImage: input.publicImage }),
    ...(tokens.length === 0
      ? {}
      : {
          replaceTokens: {
            ...(tokens.includes("repository") ? { repository: true } : {}),
            ...(tokens.includes("registry") ? { registry: true } : {}),
          },
        }),
  };
}

const SavedHostPlanSchema = z.looseObject({
  steps: z.array(z.looseObject({ state: z.string() })),
});

/**
 * A server the user owns: whether the saved host plan `hash` exists (`.opscrew/plans/host-<hash>.json`)
 * and whether it changes something on the server.
 */
async function savedHostPlan(
  phase: Pick<PhaseDeps, "paths">,
  hash: string,
): Promise<{ changes: boolean } | undefined> {
  let text: string;
  try {
    text = await readFile(hostPlanFile(phase.paths, hash), "utf8");
  } catch (error) {
    // Only a missing file means "no such host plan"; any other problem must not hide one.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = SavedHostPlanSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved host plan ${hash} (.opscrew/plans/host-${hash}.json) is damaged, so OpsCrew cannot tell what it changes.`,
      { hint: "Call opscrew_plan again and show the user the new plans." },
    );
  }
  return { changes: parsed.data.steps.some((step) => step.state === "change") };
}

/** The host plan as OpsCrew described it while planning (from the collected messages). */
function hostPlanText(messages: readonly { message: string }[]): string | undefined {
  return messages.find((m) => m.message.startsWith("Host plan for your server"))?.message;
}

const SavedStackPlanSchema = z.looseObject({
  changes: z.array(z.looseObject({ state: z.string() })),
});

/**
 * The user's Portainer: whether the saved stack plan `hash` exists
 * (`.opscrew/plans/stack-<hash>.json`) and whether it changes something in Portainer.
 */
async function savedStackPlan(
  phase: Pick<PhaseDeps, "paths">,
  hash: string,
): Promise<{ changes: boolean } | undefined> {
  let text: string;
  try {
    text = await readFile(stackPlanFile(phase.paths, hash), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = SavedStackPlanSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The saved stack plan ${hash} (.opscrew/plans/stack-${hash}.json) is damaged, so OpsCrew cannot tell what it changes.`,
      { hint: "Call opscrew_plan again and show the user the new plans." },
    );
  }
  return { changes: parsed.data.changes.some((change) => change.state === "change") };
}

/** The stack plan as OpsCrew described it while planning (from the collected messages). */
function stackPlanText(messages: readonly { message: string }[]): string | undefined {
  return messages.find((m) => m.message.startsWith("Stack plan for your Portainer"))?.message;
}

function outputsLines(result: ProvisionResult, own: boolean): string[] {
  // A server the user owns or their Portainer: no address leaves OpsCrew's local state.
  if (own) return [];
  const out = result.outputs;
  const lines: string[] = [];
  for (const [key, label] of [
    ["server_ipv4", "Server IPv4"],
    ["server_ipv6", "Server IPv6"],
    ["url", "URL"],
  ] as const) {
    if (typeof out[key] === "string" && out[key] !== "") lines.push(`${label}: ${out[key]}`);
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
        "Write the generated deployment files into the repository and make an OpenTofu/Terraform plan for the server on the planned cloud provider (Hetzner Cloud or DigitalOcean) and Cloudflare DNS when planned, then check it against OpsCrew's security policies. Returns the plan hash, the resource changes, the monthly cost and the policy results. On a server the user already has, it also inspects the server read-only and returns the host plan (every change OpsCrew would make on the server) with its own hash. When other users on that server log in with a password and no SSH key, OpsCrew stops until the user chooses: pass passwordLogins 'off' (turn password logins off anyway) or 'keep' (leave them on), the CLI's --password-logins, and pass the same value to opscrew_apply. In a Portainer the user already runs, it inspects Portainer read-only (with PORTAINER_API_KEY and the certificate the user confirmed in the interview) and returns the stack plan (the app's stacks, the registry entry, the repository access and the redeploy setting, each marked as already in place or a change) with its own hash, next to the Cloudflare plan when the app uses a tunnel or Cloudflare redeploys; when the stack plan needs the tunnel's token it follows after the Cloudflare apply. Never applies anything: show the plans to the user, then call opscrew_apply with the hashes. Needs the provider's API token (HCLOUD_TOKEN for Hetzner Cloud, DIGITALOCEAN_TOKEN for DigitalOcean; none for the user's own server, whose SSH host key must have been confirmed once; PORTAINER_API_KEY for the user's Portainer) and GitHub access in the MCP server's environment.",
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
          ...portainerOptions({ publicImage, replaceTokens }),
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
          (await savedHostPlan(phase, result.hostPlanHash))?.changes === true
            ? result.hostPlanHash
            : undefined;
        const hostText = hostHash === undefined ? undefined : hostPlanText(call.reporter.messages);
        // The user's Portainer: the stack plan, approved on its own by its hash.
        const stackHash =
          result.stackPlanHash !== undefined &&
          (await savedStackPlan(phase, result.stackPlanHash))?.changes === true
            ? result.stackPlanHash
            : undefined;
        const stackText =
          stackHash === undefined ? undefined : stackPlanText(call.reporter.messages);
        // The stack plan needs the Cloudflare Tunnel's token, which exists only after the apply.
        const stackFollows = portainer && saved !== undefined && result.stackPlanHash === undefined;
        const second = hostHash ?? stackHash;
        const hashes = [
          ...(saved !== undefined ? [saved.planHash] : []),
          ...(second !== undefined ? [second] : []),
        ];
        const imageFlags = [
          ...(publicImage === true ? ["--public-image"] : []),
          ...(publicImage === false ? ["--private-image"] : []),
          ...(replaceTokens ?? []).map((token) => `--replace-token ${token}`),
        ];
        const applyCommand = [
          "opscrew provision",
          ...hashes.map((h) => `--approve ${h}`),
          ...(passwordLogins === undefined ? [] : [`--password-logins ${passwordLogins}`]),
          ...imageFlags,
        ].join(" ");
        if (saved === undefined && second === undefined) {
          return {
            text: own
              ? "Cloudflare and the user's server already match the plans; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run `opscrew provision` in a terminal to finish any remaining steps."
              : portainer
                ? "Cloudflare and the user's Portainer already match the plans; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run `opscrew provision` in a terminal to finish any remaining steps."
                : "The infrastructure already matches the plan; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run `opscrew provision` in a terminal to finish any remaining steps.",
            data: {
              upToDate: true,
              ...(result.planHash ? { planHash: result.planHash } : {}),
              ...(result.stackPlanHash ? { stackPlanHash: result.stackPlanHash } : {}),
              ...(cost === undefined ? {} : { cost }),
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
        const applyArgs = `${
          saved !== undefined && second !== undefined
            ? `planHash ${saved.planHash} and ${secondArg} ${second}`
            : `planHash ${hashes[0]}`
        }${extras.map((extra) => ` and ${extra}`).join("")}`;
        const text = [
          // A server the user owns or their Portainer costs nothing more: no price in the plan.
          ...(saved !== undefined
            ? [describePlan(saved, plan, own || portainer ? { costUnchanged: true } : {})]
            : []),
          ...(hostText !== undefined ? ["", hostText] : []),
          ...(stackText !== undefined ? ["", stackText] : []),
          "",
          `Nothing was created${own ? " and nothing on the user's server was changed" : portainer ? " and nothing in the user's Portainer was changed" : ""}. Show ${hashes.length > 1 ? "both plans" : "this plan"} to the user. To apply exactly ${hashes.length > 1 ? "these plans" : "this plan"}, call opscrew_apply with ${applyArgs}: OpsCrew then asks the user to approve each in a dialog. Without that dialog, the user can run this in a terminal:`,
          `  ${applyCommand}`,
          ...(stackFollows
            ? [
                "The stack plan for the user's Portainer follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token: opscrew_apply then shows it to the user in its own dialog. In a terminal script that takes three runs: `opscrew provision --plan-only`, the command above, then `opscrew provision --approve <stack plan hash>`.",
              ]
            : []),
          ...(saved?.hasDestroy
            ? [
                `This plan deletes or replaces resources; the user must type "${plan.app.name}" to approve it.`,
              ]
            : []),
        ].join("\n");
        return {
          text,
          data: {
            ...(saved !== undefined ? planData(saved) : {}),
            ...(hostHash !== undefined ? { hostPlanHash: hostHash } : {}),
            ...(stackHash !== undefined ? { stackPlanHash: stackHash } : {}),
            ...(stackFollows ? { stackPlanFollows: true } : {}),
            ...(cost === undefined ? {} : { cost }),
            applyCommand,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_apply",
    {
      title: "Apply an approved plan",
      description:
        "Apply exactly the plan saved by opscrew_plan (pass its planHash) after the USER approves it in an MCP elicitation dialog that shows the plan summary; the coding agent cannot approve it. Creates or changes real resources on the user's cloud provider account (Hetzner Cloud or DigitalOcean, and Cloudflare when planned), waits for the server, then commits the generated files on a branch, pushes it and opens a pull request (each also approved in a dialog). On a server the user already has, also pass hostPlanHash: the host plan is shown and approved in its own dialog before OpsCrew changes the server (when only a host plan was returned, pass it as planHash), with the same passwordLogins choice given to opscrew_plan, if any. In a Portainer the user already runs, also pass stackPlanHash: the stack plan is shown and approved in its own dialog before OpsCrew changes anything in Portainer (when only a stack plan was returned, pass it as planHash; when the stack plan followed the Cloudflare plan, it is shown in a dialog after that apply), with the same publicImage and replaceTokens given to opscrew_plan, if any. Deploy secrets are stored only when OPSCREW_APP_ENV_FILE names the production environment file; otherwise the user finishes with `opscrew provision` in a terminal. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        planHash: z
          .string()
          .describe("SHA-256 hash of the saved plan, exactly as returned by opscrew_plan."),
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
        hostPlanHash,
        stackPlanHash,
        passwordLogins,
        publicImage,
        replaceTokens,
      },
      extra: CallExtra,
    ) =>
      runTool(deps, "opscrew_apply", projectDir, async (call) => {
        if (
          !isPlanHash(planHash) ||
          (hostPlanHash !== undefined && !isPlanHash(hostPlanHash)) ||
          (stackPlanHash !== undefined && !isPlanHash(stackPlanHash))
        ) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "planHash (and hostPlanHash or stackPlanHash) must be the 64-character SHA-256 hashes returned by opscrew_plan.",
            { hint: "Call opscrew_plan, show the plan to the user and pass its planHash." },
          );
        }
        const hash = planHash.toLowerCase();
        const hostHash = hostPlanHash?.toLowerCase();
        const stackHash = stackPlanHash?.toLowerCase();
        const terminal = [
          `opscrew provision --approve ${hash}`,
          ...(hostHash === undefined ? [] : [`--approve ${hostHash}`]),
          ...(stackHash === undefined ? [] : [`--approve ${stackHash}`]),
          ...(passwordLogins === undefined ? [] : [`--password-logins ${passwordLogins}`]),
          ...(publicImage === true ? ["--public-image"] : []),
          ...(publicImage === false ? ["--private-image"] : []),
          ...(replaceTokens ?? []).map((token) => `--replace-token ${token}`),
        ].join(" ");
        if (!clientSupportsElicitation(server)) {
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            "This MCP client cannot show OpsCrew's approval dialog (MCP elicitation), so OpsCrew will not apply the plan. Nothing was changed.",
            {
              hint: `Ask the user to review the plan and run \`${terminal}\` in a terminal in the project directory.`,
            },
          );
        }
        const handler = new ElicitationApprovalHandler(server, {
          clock: deps.clock,
          redact: deps.redactor.redact,
          extra,
        });
        const phase = await call.phaseDeps({ approvalHandler: handler });
        const saved = await findSavedPlan(phase.paths.files.plansDir, hash);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const own = plan.target.provider === "own";
        const portainer = plan.target.provider === "portainer";
        // A server the user owns whose infrastructure needs no change: the hash names the host plan.
        const hostOnly =
          saved === undefined && own && (await savedHostPlan(phase, hash)) !== undefined;
        // The user's Portainer whose Cloudflare setup needs no change: the hash names the stack plan.
        const stackOnly =
          saved === undefined && portainer && (await savedStackPlan(phase, hash)) !== undefined;
        if (saved === undefined && !hostOnly && !stackOnly) {
          throw new OpsCrewError("PLAN_HASH_MISMATCH", `No saved plan has the hash ${hash}.`, {
            hint: "Call opscrew_plan again, show the new plan to the user and apply its hash.",
          });
        }
        if (
          hostHash !== undefined &&
          (!own || (await savedHostPlan(phase, hostHash)) === undefined)
        ) {
          throw new OpsCrewError(
            "PLAN_HASH_MISMATCH",
            `No saved host plan has the hash ${hostHash}.`,
            {
              hint: "Call opscrew_plan again, show the new plans to the user and apply their hashes.",
            },
          );
        }
        if (
          stackHash !== undefined &&
          (!portainer || (await savedStackPlan(phase, stackHash)) === undefined)
        ) {
          throw new OpsCrewError(
            "PLAN_HASH_MISMATCH",
            `No saved stack plan has the hash ${stackHash}.`,
            {
              hint: "Call opscrew_plan again, show the new plans to the user and apply their hashes.",
            },
          );
        }
        const secrets = (phase.env.OPSCREW_APP_ENV_FILE ?? "").trim() !== "";
        let result: ProvisionResult;
        try {
          // The hashes only pick the saved plans: every approval still comes from the user's dialog.
          result = await (options.runProvision ?? runProvision)(phase, {
            approveHashes: [
              ...new Set([
                hash,
                ...(hostHash === undefined ? [] : [hostHash]),
                ...(stackHash === undefined ? [] : [stackHash]),
              ]),
            ],
            ...(saved === undefined ? {} : { engine: saved.engine.name }),
            ...(passwordLogins === undefined ? {} : { passwordLogins }),
            ...portainerOptions({ publicImage, replaceTokens }),
            secrets,
            ...servicesOption(options),
          });
        } catch (error) {
          throw refusalWithNextStep(error, handler, terminal);
        }
        const secretsNote = secrets
          ? []
          : [
              "",
              "The deploy secrets are NOT stored yet: OpsCrew never asks for production values through this chat. Ask the user to run `opscrew provision` in a terminal in the project directory. It finds no infrastructure changes, then asks for the production environment values and stores the GitHub Actions secrets.",
            ];
        const text = [
          hostOnly || stackOnly
            ? "The infrastructure needed no change."
            : result.applied
              ? `Applied plan ${hash}.`
              : `Plan ${hash} had nothing left to apply; the infrastructure already matches it.`,
          ...(own
            ? [
                result.hostApplied === true
                  ? `Prepared the user's server (host plan ${result.hostPlanHash}).`
                  : "The user's server needed no change.",
                "OpsCrew cannot turn on backups or snapshots on the user's own server; backups are the user's responsibility.",
              ]
            : []),
          ...(portainer
            ? [
                result.stackApplied === true
                  ? `Set up the app's stacks in the user's Portainer (stack plan ${result.stackPlanHash}).`
                  : "The user's Portainer needed no change.",
                "OpsCrew does not change the host (its firewall, SSH and Portainer's own security stay the user's); backups of the app's data volumes are the user's responsibility.",
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
          ...(inPortainer ? ["", `${PORTAINER_HOST_NOTE} ${PORTAINER_BACKUPS_NOTE}`] : []),
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
            ...(result.policies !== undefined ? { policies: result.policies } : {}),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
 * Adds the terminal command to a refusal: `--approve <hash>` while the plan is still unapplied,
 * plain `opscrew provision` once it was applied (a later step was refused; it resumes from there).
 */
function refusalWithNextStep(
  error: unknown,
  handler: ElicitationApprovalHandler,
  terminal: string,
): unknown {
  if (!isUserFacingError(error) || error.code !== "APPROVAL_REFUSED") return error;
  const applyApproved = handler.decisions.some((d) => d.kind === "iac-apply" && d.approved);
  const hostRefused = handler.decisions.some((d) => d.kind === "host-apply" && !d.approved);
  const stackRefused = handler.decisions.some((d) => d.kind === "stack-apply" && !d.approved);
  if (stackRefused) {
    // The user's Portainer: Cloudflare may already be changed; Portainer itself is not.
    const message = applyApproved
      ? "The user declined the stack plan. The Cloudflare changes are applied; nothing in the user's Portainer was changed."
      : "The user declined the stack plan; nothing in the user's Portainer was changed.";
    return new OpsCrewError("APPROVAL_REFUSED", message, {
      hint: "When the user is ready, call opscrew_plan again (it shows what is still missing) and opscrew_apply with its hashes, or ask them to run `opscrew provision` in a terminal in the project directory.",
      cause: error,
    });
  }
  if (hostRefused) {
    // The user's own server: Cloudflare may already be changed; the server itself is not.
    const message = applyApproved
      ? "The user declined the host plan. The Cloudflare changes are applied; nothing on the user's server was changed."
      : "The user declined the host plan; nothing on the user's server was changed.";
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
