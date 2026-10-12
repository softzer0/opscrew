import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import {
  describePlan,
  findSavedPlan,
  type ProvisionResult,
  type ProvisionServices,
  previewDeploymentFiles,
  type RunSecureOptions,
  type RunVerifyOptions,
  runProvision,
  runSecure,
  runVerify,
  type SavedPlan,
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
  secure?: Pick<RunSecureOptions, "remote" | "tcpConnect" | "probeTimeoutMs">;
  /** Fakes for `runVerify` (resolver, fetch, TLS, TCP, Cloudflare ranges). */
  verify?: RunVerifyOptions;
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
    lines.push(`Monthly cost: ${amount.toFixed(2)} ${currency}`, "");
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

function outputsLines(result: ProvisionResult): string[] {
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
        "Write the generated deployment files into the repository and make an OpenTofu/Terraform plan for the server on the planned cloud provider (Hetzner Cloud or DigitalOcean) and Cloudflare DNS when planned, then check it against OpsCrew's security policies. Returns the plan hash, the resource changes, the monthly cost and the policy results. Never applies anything: show the plan to the user, then call opscrew_apply with the hash. Needs the provider's API token (HCLOUD_TOKEN for Hetzner Cloud, DIGITALOCEAN_TOKEN for DigitalOcean) and GitHub access in the MCP server's environment.",
      inputSchema: {
        ...projectDirInput,
        engine: z
          .enum(["auto", "tofu", "terraform"])
          .optional()
          .describe("IaC engine to use; defaults to the plan's choice (OpenTofu when installed)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, engine }) =>
      runTool(deps, "opscrew_plan", projectDir, async (call) => {
        const phase = await call.phaseDeps({
          approvalHandler: new PlanToolApprovalHandler(deps.clock),
        });
        const result = await runProvision(phase, {
          planOnly: true,
          ...(engine !== undefined ? { engine } : {}),
          ...servicesOption(options),
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const cost = plan.cost;
        const saved =
          result.planHash === undefined
            ? undefined
            : await findSavedPlan(phase.paths.files.plansDir, result.planHash);
        if (saved === undefined) {
          return {
            text: "The infrastructure already matches the plan; there is nothing to apply. Next: call opscrew_secure and opscrew_verify, or run `opscrew provision` in a terminal to finish any remaining steps.",
            data: {
              upToDate: true,
              ...(result.planHash ? { planHash: result.planHash } : {}),
              cost,
            },
          };
        }
        const text = [
          describePlan(saved, plan),
          "",
          "Nothing was created. Show this plan to the user. To apply exactly this plan, call opscrew_apply with this planHash: OpsCrew then asks the user to approve it in a dialog. Without that dialog, the user can run this in a terminal:",
          `  opscrew provision --approve ${saved.planHash}`,
          ...(saved.hasDestroy
            ? [
                `This plan deletes or replaces resources; the user must type "${plan.app.name}" to approve it.`,
              ]
            : []),
        ].join("\n");
        return {
          text,
          data: {
            ...planData(saved),
            cost,
            applyCommand: `opscrew provision --approve ${saved.planHash}`,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_apply",
    {
      title: "Apply an approved plan",
      description:
        "Apply exactly the plan saved by opscrew_plan (pass its planHash) after the USER approves it in an MCP elicitation dialog that shows the plan summary; the coding agent cannot approve it. Creates or changes real resources on the user's cloud provider account (Hetzner Cloud or DigitalOcean, and Cloudflare when planned), waits for the server, then commits the generated files on a branch, pushes it and opens a pull request (each also approved in a dialog). Deploy secrets are stored only when OPSCREW_APP_ENV_FILE names the production environment file; otherwise the user finishes with `opscrew provision` in a terminal. Refuses when the client cannot show dialogs.",
      inputSchema: {
        ...projectDirInput,
        planHash: z
          .string()
          .describe("SHA-256 hash of the saved plan, exactly as returned by opscrew_plan."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, planHash }, extra: CallExtra) =>
      runTool(deps, "opscrew_apply", projectDir, async (call) => {
        if (!isPlanHash(planHash)) {
          throw new OpsCrewError(
            "INVALID_INPUT",
            "planHash must be the 64-character SHA-256 hash returned by opscrew_plan.",
            { hint: "Call opscrew_plan, show the plan to the user and pass its planHash." },
          );
        }
        const hash = planHash.toLowerCase();
        const terminal = `opscrew provision --approve ${hash}`;
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
        if (saved === undefined) {
          throw new OpsCrewError("PLAN_HASH_MISMATCH", `No saved plan has the hash ${hash}.`, {
            hint: "Call opscrew_plan again, show the new plan to the user and apply its hash.",
          });
        }
        const secrets = (phase.env.OPSCREW_APP_ENV_FILE ?? "").trim() !== "";
        let result: ProvisionResult;
        try {
          result = await runProvision(phase, {
            approvePlanHash: hash,
            engine: saved.engine.name,
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
          result.applied
            ? `Applied plan ${hash}.`
            : `Plan ${hash} had nothing left to apply; the infrastructure already matches it.`,
          ...outputsLines(result),
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
            outputs: result.outputs,
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
        "Re-scan the repository, re-check the applied plan against the security policies, run hardening checks on the server over SSH (password and root login, firewall, fail2ban, automatic updates, Docker exposure, listening ports, pending reboot, disk) and probe from outside that only the expected ports answer. Writes opscrew/SECURITY_REPORT.md and returns every check result and the problems to fix. Changes nothing on the server.",
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
        const lines = [
          result.summary.trimEnd(),
          ...(result.hostChecks.length > 0
            ? ["", "Server checks:", ...checkLines(result.hostChecks)]
            : []),
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
        "Check the live deployment from outside: DNS, HTTPS and certificate validity, the HTTP-to-HTTPS redirect, the health endpoint, security headers, that .env and .git are not served, that the origin is not reachable around Cloudflare, and the latest GitHub Actions deploy run. Writes opscrew/RUNBOOK.md (deploys, rollbacks, logs, SSH access, backups, secret rotation, costs) and returns every check result. Run it after the deploy pull request is merged.",
      inputSchema: { ...projectDirInput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_verify", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        const result = await runVerify(phase, options.verify ?? {});
        const summary = summarizeChecks(result.checks);
        const text = [
          result.passed
            ? `${result.url} is live and healthy (${summary}).`
            : `Verification of ${result.url} found problems (${summary}). Fix them and call opscrew_verify again.`,
          ...checkLines(result.checks),
          "",
          `Runbook: ${result.runbookPath}`,
        ].join("\n");
        return {
          text,
          data: {
            passed: result.passed,
            url: result.url,
            summary,
            checks: result.checks,
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
  const next = applyApproved
    ? "Ask the user to run `opscrew provision` in a terminal in the project directory when ready; it continues where this stopped."
    : `Nothing was applied. When the user is ready, call opscrew_apply again, or ask them to run \`${terminal}\` in a terminal.`;
  return new OpsCrewError("APPROVAL_REFUSED", error.message, { hint: next, cause: error });
}
