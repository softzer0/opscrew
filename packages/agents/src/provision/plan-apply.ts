import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";
import {
  type ApprovalRecord,
  type IacEngine,
  type Money,
  type PhaseName,
  type PlanSummary,
  type PolicyResult,
  type ResourceAction,
  SEVERITIES,
  type VpsProviderId,
} from "@opscrew/contracts";
import { OpsCrewError, type Redactor, writeFileAtomic } from "@opscrew/core";
import { checkDialect, engineLabel, hashFile } from "@opscrew/iac-engine";
import type { RenderedFile } from "@opscrew/iac-templates";
import { usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { blockingPolicyFailures, evaluatePlanPolicies } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile, vpsConnector } from "../providers";
import { engineErrorBlocks } from "../shared/tunnel-connections";
import { maskSensitivePlanJson } from "./plan-json";
import type { SavedPlan } from "./types";
import { tunnelTokenPermissions } from "./zero-trust";

export interface PlanAndApplyOptions {
  engine: IacEngine;
  /** Absolute root module directory. */
  dir: string;
  /** Engine environment: provider tokens and `TF_ENCRYPTION`. Never logged. */
  env: Record<string, string | undefined>;
  deployPlan: DeployPlan;
  /** Rendered files, checked for engine-specific constructs before planning. */
  files: readonly RenderedFile[];
  /** Apply the saved plan with this hash instead of planning again. */
  approvePlanHash?: string;
  planOnly?: boolean;
  /** Command named in hints, for example `opscrew dns` (default `opscrew provision`). */
  command?: string;
  /** Phase recorded in the audit log (default `provision`). */
  phase?: PhaseName;
  /**
   * Plain-English warnings added to the `iac-apply` approval details: a fixed list, or computed
   * from the plan about to be shown for approval (this run's plan, or the saved plan of
   * `approvePlanHash`). Not asked for when no approval is requested (`planOnly`, no changes).
   */
  approvalNotes?: readonly string[] | ((plan: SavedPlan) => readonly string[]);
  /**
   * Awaited once the approval is granted and checked, right before the engine applies the plan;
   * never on a refusal, with `planOnly` or for a plan without changes. It may throw to stop before
   * the apply (for example: the host change that removes a tunnel's connector goes first).
   */
  beforeApply?: (plan: SavedPlan) => Promise<void>;
  /** Hears of a failed apply, with the redacted engine log, before the error is thrown. */
  applyFailed?: (log: string, plan: SavedPlan) => void;
  /**
   * Monthly cost change shown with the approval. Default: the plan's monthly cost (the plan
   * creates the deployment's servers); `null` for a server the user owns. `null`: the plan changes
   * nothing that is billed (a DNS switch), so the approval claims no cost change.
   */
  costDelta?: Money | null;
  /**
   * Plan the removal of every resource in the state (`plan -destroy`), for example the old DNS
   * records or tunnel before an own server switches between public and tunnel mode. Such a plan
   * deletes resources, so its approval needs the typed app name.
   */
  destroy?: boolean;
  /** Title of the approval instead of the default "Apply the infrastructure plan on …". */
  approvalTitle?: string;
}

/** Engine log text meaning an API refused the token's permissions (HTTP 403, read-only token). */
const FORBIDDEN =
  /:\s*403\b|\bforbidden\b|not authori[sz]ed|insufficient[_ ]permissions?|missing (?:the )?(?:required )?scopes?|token_readonly|only allowed to perform GET requests/i;

/** Engine log text naming each provider's API or resources, so a 403 is blamed on the right token. */
const PROVIDER_API: Readonly<Record<VpsProviderId, RegExp>> = {
  hetzner: /api\.hetzner\.cloud|hcloud_|token_readonly/i,
  digitalocean: /api\.digitalocean\.com|digitalocean_/i,
  // A server the user owns has no provider API: no engine error is blamed on a provider token.
  own: /(?!)/,
};

const CLOUDFLARE_API = /api\.cloudflare\.com|cloudflare_/i;

/** A provider outage (HTTP 502/503), not a size that is unavailable in the location. */
const SERVICE_DOWN = /service (?:temporarily )?unavailable|\b50[23]\b/i;

/** The error blocks of an engine log; the whole log is one block when it has no `Error:` line. */
function errorBlocks(log: string): string[] {
  const blocks = engineErrorBlocks(log);
  return blocks.length > 0 ? blocks : [log];
}

/**
 * Whose API an error block came from: the resource address the engine prints in the block
 * (`with module.dns.…` or `with module.server.…`), else the only API or resource type it names.
 */
function blockOwner(block: string, provider: VpsProviderId): "cloudflare" | "provider" | undefined {
  if (/\bwith module\.(?:dns|tunnel|portainer_tunnel|access)\./.test(block)) return "cloudflare";
  if (/\bwith module\.server\./.test(block)) return "provider";
  const cloudflare = CLOUDFLARE_API.test(block);
  const named = PROVIDER_API[provider].test(block);
  if (cloudflare && !named) return "cloudflare";
  if (named && !cloudflare) return "provider";
  return undefined;
}

/**
 * Next step after a failed apply, in the plan provider's words: an exhausted server limit, a token
 * without a needed permission (blamed on the token of the API whose error block holds the 403), a
 * size unavailable in the location, or else "fix and re-run".
 */
function applyFailureHint(
  deps: PhaseDeps,
  log: string,
  deployPlan: DeployPlan,
  command: string,
): string {
  if (deployPlan.target.provider === "portainer") return portainerFailureHint(log, command);
  const provider = planProvider(deployPlan);
  const profile = providerProfile(provider);
  const { displayName, serverNoun } = profile;
  const kept = "Nothing that was already created is removed.";
  const blocks = errorBlocks(log);
  const errors = blocks.join("\n");
  if (profile.serverLimit.test(errors)) {
    return `Your ${displayName} account reached its ${serverNoun} limit, so it cannot create another ${serverNoun}. Delete a ${serverNoun} you no longer need or ask ${displayName} for a higher limit on your account page (${profile.accountUrl}), then run \`${command}\` again. ${kept}`;
  }
  const refused = new Set(
    blocks.filter((block) => FORBIDDEN.test(block)).map((block) => blockOwner(block, provider)),
  );
  if (refused.has("cloudflare") && !refused.has("provider")) {
    return cloudflareRefusedHint(
      usesTunnel(deployPlan) ? tunnelTokenPermissions() : CLOUDFLARE_TOKEN_PERMISSIONS.join(", "),
      command,
    );
  }
  if (refused.has("provider")) {
    const requirement = vpsConnector(provider, deps).credentials;
    const needed =
      requirement.scopes.length === 1
        ? `${requirement.scopes[0]} permission`
        : `these scopes (${requirement.scopes.join(", ")})`;
    return `${displayName} refused the request, so the API token is probably missing a permission OpsCrew needs. Create a token at ${requirement.createUrl} with ${needed}, set ${profile.tokenVars[0]} to it, then run \`${command}\` again. ${kept}`;
  }
  const target = deployPlan.target;
  // A server the user owns is never created, so no size can be unavailable (a Portainer target
  // returned above).
  if (target.provider !== "own" && profile.unavailable.test(errors) && !SERVICE_DOWN.test(errors)) {
    const size = provider === "hetzner" ? "server type" : "size";
    const { serverType, location } = target;
    return `${displayName} cannot create a ${serverType} ${serverNoun} in ${location} right now (the ${size} is unavailable or out of stock there). Run \`opscrew design\` to pick another ${size} or location, then run \`${command}\` again. ${kept}`;
  }
  return `Fix the cause shown above, then run \`${command}\` again; it plans the remaining changes.`;
}

/**
 * Next step after a failed apply for the user's Portainer, whose infrastructure is only Cloudflare
 * (tunnels, their routes and Access): a refused request is the Cloudflare token's, anything else
 * is "fix and re-run". OpsCrew creates no server there, so no provider limit or size applies.
 */
function portainerFailureHint(log: string, command: string): string {
  if (errorBlocks(log).some((block) => FORBIDDEN.test(block))) {
    return cloudflareRefusedHint(tunnelTokenPermissions(), command);
  }
  return `Fix the cause shown above, then run \`${command}\` again; it plans the remaining changes.`;
}

/** Next step when Cloudflare refused a request of the apply: a token with `permissions`. */
function cloudflareRefusedHint(permissions: string, command: string): string {
  return `Cloudflare refused the request, so the Cloudflare API token is probably missing a permission OpsCrew needs. Create a token at https://dash.cloudflare.com/profile/api-tokens with ${permissions} for the app's zone, set CLOUDFLARE_API_TOKEN to it, then run \`${command}\` again. Nothing that was already created is removed.`;
}

/** File name ending of a saved plan that removes everything in the state (`destroy: true`). */
export const REMOVAL_PLAN_SUFFIX = "-removal.tfplan";

export interface PlanAndApplyResult {
  planHash?: string;
  applied: boolean;
  outputs: Record<string, unknown>;
  approval?: ApprovalRecord;
  plan?: SavedPlan;
}

const SYMBOL: Record<ResourceAction, string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "?",
  "no-op": " ",
};

function money(amount: number, currency: string): string {
  return `${currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
}

function resources(count: number): string {
  return `${count} resource${count === 1 ? "" : "s"}`;
}

/** `Estimated cost: €4.51 per month (…)`: the deployment's monthly price with its source. */
function estimatedCost(deployPlan: DeployPlan): string {
  const cost = deployPlan.cost.monthly;
  // EUR prices (Hetzner) are quoted with or without VAT; USD prices (DigitalOcean) exclude sales tax.
  const tax = cost.currency === "EUR" ? "VAT" : "tax";
  return `Estimated cost: ${money(cost.amount, cost.currency)} per month (${deployPlan.cost.source === "live" ? "live prices" : `price list of ${deployPlan.cost.asOf.slice(0, 10)}`}, ${deployPlan.cost.pricesIncludeVat ? "incl." : "excl."} ${tax}).`;
}

/** True when the plan only renames resources in the state (`moved` blocks) and changes nothing. */
export function isMovesOnly(saved: Pick<SavedPlan, "changes" | "moves">): boolean {
  return saved.changes.length === 0 && (saved.moves?.length ?? 0) > 0;
}

/**
 * Plain-English plan summary shown before approval (resources, state renames, cost, policies,
 * hash). A plan that only renames resources in the state says that nothing changes in the cloud;
 * with `costUnchanged` (a plan that only updates what is not billed, such as DNS records) the cost
 * line says the cost does not change instead of quoting the deployment's monthly price.
 */
export function describePlan(
  saved: SavedPlan,
  deployPlan: DeployPlan,
  options: { costUnchanged?: boolean } = {},
): string {
  const lines = [`${engineLabel(saved.engine.name)} ${saved.engine.version} plan:`];
  for (const change of saved.changes) {
    lines.push(`  ${SYMBOL[change.action]} ${change.action.padEnd(7)} ${change.address}`);
  }
  const moves = saved.moves ?? [];
  for (const move of moves) {
    lines.push(`  → ${"moved".padEnd(7)} ${move.from} → ${move.to}`);
  }
  if (isMovesOnly(saved)) {
    lines.push(
      `Changes: none in the cloud; ${resources(moves.length)} renamed in the infrastructure state only.`,
      "Cost: unchanged (nothing is created, updated or deleted).",
    );
  } else {
    const { create, update, delete: del, replace } = saved.counts;
    const renamed =
      moves.length > 0 ? ` ${resources(moves.length)} renamed in the infrastructure state.` : "";
    lines.push(
      `Changes: ${create} to create, ${update} to update, ${del} to delete, ${replace} to replace.${renamed}`,
    );
    if (options.costUnchanged === true) {
      lines.push("Cost: unchanged (nothing that is billed is created or deleted).");
    } else {
      lines.push(estimatedCost(deployPlan));
    }
  }
  const failed = saved.policy.filter((p) => !p.passed);
  lines.push(
    `Security policies: ${saved.policy.length - failed.length} passed, ${failed.length} failed.`,
  );
  for (const result of saved.policy) {
    lines.push(`  ${result.passed ? "✓" : "✗"} [${result.severity}] ${result.title}`);
    if (!result.passed) lines.push(`      ${result.message}`);
  }
  lines.push(`Plan hash: ${saved.planHash}`);
  return lines.join("\n");
}

const SIDECAR_SUFFIX = ".json";

function sidecarFor(planFile: string): string {
  return `${planFile}${SIDECAR_SUFFIX}`;
}

/** `value` with every string and every object key passed through `redact` (a copy). */
function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]),
  );
}

/**
 * Writes the sidecar of a saved plan (`<plan file>.json`). Its plan JSON never holds the prior
 * state or a value the plan marks sensitive, and every string and key in it passes through the
 * redactor, so registered secrets and names (Portainer's address and host, server addresses) are
 * masked also where the engine does not mark them (a refreshed tunnel's `connections[].origin_ip`
 * is the address of the host running its connector). Only the plan hash is kept as it is: it is
 * what an approval binds to, and {@link findSavedPlan} takes the plan file from the sidecar's own
 * location, so a masked path cannot misdirect it.
 */
export async function writePlanSidecar(
  redactor: Pick<Redactor, "redact">,
  saved: SavedPlan,
): Promise<void> {
  const masked: SavedPlan = { ...saved, planJson: maskSensitivePlanJson(saved.planJson) };
  const redacted = redactJson(masked, (text) => redactor.redact(text)) as SavedPlan;
  const safe: SavedPlan = { ...redacted, planHash: saved.planHash };
  await writeFileAtomic(sidecarFor(saved.planFile), `${JSON.stringify(safe, null, 2)}\n`);
}

const PlanHashSchema = z.string().regex(/^[0-9a-f]{64}$/i);

/** Just enough of a sidecar to tell which plan it describes. */
const SidecarHashSchema = z.looseObject({ planHash: z.string() });

/** A sidecar written by `--plan-only` (or a move's deletion step), checked before any use. */
const SavedPlanSchema = z.object({
  planHash: PlanHashSchema,
  planFile: z.string().min(1),
  dir: z.string(),
  engine: z.object({
    name: z.enum(["tofu", "terraform"]),
    version: z.string(),
    binary: z.string(),
  }),
  createdAt: z.string(),
  changes: z.array(
    z.object({
      address: z.string().min(1),
      type: z.string(),
      name: z.string(),
      provider: z.string(),
      action: z.enum(["create", "update", "delete", "replace", "read", "no-op"]),
    }),
  ),
  moves: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1), type: z.string() }))
    .optional(),
  counts: z.object({
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    delete: z.number().int().nonnegative(),
    replace: z.number().int().nonnegative(),
  }),
  hasDestroy: z.boolean(),
  policy: z.array(
    z.object({
      policyId: z.string(),
      title: z.string(),
      severity: z.enum(SEVERITIES),
      passed: z.boolean(),
      message: z.string(),
      resource: z.string().optional(),
    }),
  ),
  planJson: z
    .unknown()
    .refine((value) => value !== undefined && value !== null, "the plan JSON is missing"),
});

/** The first problem zod found, as `changes.0.address: …`. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "unknown problem";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * The saved plan (from an earlier `--plan-only`) whose hash matches, if any. Sidecars of other
 * plans that cannot be read are ignored; the matching sidecar is validated in full (changes,
 * moves, counts, policies, engine, plan JSON, hash) and an incomplete or damaged one stops with a
 * plain `PLAN_HASH_MISMATCH` error (fail closed: it is never applied or shown as the plan) whose
 * hint is `options.hint` (default: plan again and approve the new hash). The returned `planFile`
 * is the file beside the sidecar (`<plan file>.json`), not the path stored in it (the redactor may
 * have masked part of that); callers still check that file's hash before applying it.
 */
export async function findSavedPlan(
  plansDir: string,
  planHash: string,
  options: { hint?: string } = {},
): Promise<SavedPlan | undefined> {
  let names: string[];
  try {
    names = await readdir(plansDir);
  } catch {
    return undefined;
  }
  const wanted = planHash.toLowerCase();
  for (const name of names
    .filter((n) => n.endsWith(".tfplan.json"))
    .sort()
    .reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(plansDir, name), "utf8"));
    } catch {
      continue; // an unreadable sidecar cannot name the wanted plan
    }
    const named = SidecarHashSchema.safeParse(raw);
    if (!named.success || named.data.planHash.toLowerCase() !== wanted) continue;
    const saved = SavedPlanSchema.safeParse(raw);
    if (!saved.success) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The saved plan with the hash ${planHash} is incomplete or damaged (${firstIssue(saved.error)}), so OpsCrew will not use it. Nothing was changed.`,
        {
          hint:
            options.hint ??
            "Run the command again without --approve to plan again, review the new plan and approve its hash.",
        },
      );
    }
    const { moves, planJson, ...rest } = saved.data;
    const planFile = join(plansDir, name.slice(0, -SIDECAR_SUFFIX.length));
    return { ...rest, planFile, ...(moves !== undefined ? { moves } : {}), planJson };
  }
  return undefined;
}

function toSaved(summary: PlanSummary, policy: PolicyResult[]): SavedPlan {
  return {
    planHash: summary.planHash,
    planFile: summary.planFile,
    dir: summary.dir,
    engine: summary.engine,
    createdAt: summary.createdAt,
    changes: summary.changes,
    ...(summary.moves !== undefined && summary.moves.length > 0 ? { moves: summary.moves } : {}),
    counts: summary.counts,
    hasDestroy: summary.hasDestroy,
    policy,
    planJson: summary.planJson,
  };
}

function lastLines(text: string, count = 8): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

async function freshPlan(deps: PhaseDeps, options: PlanAndApplyOptions): Promise<SavedPlan> {
  const { engine, dir, env } = options;
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await mkdir(deps.paths.files.plansDir, { recursive: true });

  deps.reporter.step(
    `Initialising ${engineLabel(engine.info.name)} in ${options.deployPlan.infra.dir}`,
  );
  await engine.init(dir, { env, backendConfig: { path: statePath } });

  const validation = await engine.validate(dir, { env });
  if (!validation.valid) {
    const errors = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${d.summary}${d.file ? ` (${d.file}${d.line ? `:${d.line}` : ""})` : ""}`);
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure code is not valid: ${errors.join("; ")}.`,
      { hint: "Undo manual edits under opscrew/infra (they are regenerated), then try again." },
    );
  }

  const tfFiles = options.files.filter((f) => /\.(?:tf|tofu)(?:\.json)?$/.test(f.path));
  const issues = checkDialect(tfFiles.map((f) => ({ path: f.path, content: f.content })));
  const unsupported = issues.filter((issue) => issue.onlyIn !== engine.info.name);
  if (unsupported.length > 0) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure code uses features ${engineLabel(engine.info.name)} does not support: ${unsupported.map((i) => `${i.message} (${i.file}:${i.line})`).join("; ")}.`,
      { hint: "Remove the engine-specific construct or run with the other engine (--engine)." },
    );
  }
  for (const issue of issues) {
    deps.reporter.warn(`${issue.file}:${issue.line}: ${issue.message}`);
  }

  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
  const planFile = join(
    deps.paths.files.plansDir,
    options.destroy === true ? `${stamp}${REMOVAL_PLAN_SUFFIX}` : `${stamp}.tfplan`,
  );
  deps.reporter.step(
    options.destroy === true
      ? "Planning the removal of the current infrastructure"
      : "Planning the infrastructure changes",
  );
  const summary = await engine.plan(dir, planFile, {
    env,
    ...(options.destroy === true ? { destroy: true } : {}),
  });
  // Policies, summaries and the saved sidecar only ever see non-sensitive values.
  const planJson = maskSensitivePlanJson(summary.planJson);
  return toSaved({ ...summary, planJson }, evaluatePlanPolicies(planJson, options.deployPlan));
}

/**
 * Removes `deployment.destroyedAt` from `opscrew/plan.yaml` before a new apply starts: from then on
 * the deployment may have resources again, even when the apply fails half-way.
 */
async function clearDestroyedAt(deps: PhaseDeps): Promise<void> {
  const onDisk = await readArtifact("plan", deps.paths.files.plan);
  if (onDisk.deployment.destroyedAt === undefined) return;
  const { destroyedAt: _destroyedAt, ...deployment } = onDisk.deployment;
  await writeArtifact("plan", deps.paths.files.plan, { ...onDisk, deployment });
}

/** Commands with `--confirm <app>`, which approves a plan that needs the typed app name. */
const CONFIRM_COMMANDS = ["opscrew provision", "opscrew retarget"];

/**
 * How to apply a refused plan later. A plan that needs the typed app name (`confirmPhrase`) also
 * needs `--confirm <app>`; a command without that flag (`opscrew dns`, `opscrew portainer …`)
 * points to a terminal instead, and `opscrew dns` also to `opscrew provision` for scripts.
 */
function approveLaterHint(command: string, planHash: string, confirmPhrase?: string): string {
  if (confirmPhrase === undefined) {
    return `To apply it later without prompts, run: ${command} --approve ${planHash}`;
  }
  if (CONFIRM_COMMANDS.some((name) => command === name || command.startsWith(`${name} `))) {
    return `To apply it later without prompts, run: ${command} --approve ${planHash} --confirm ${confirmPhrase}`;
  }
  const script =
    command === "opscrew dns"
      ? `, or in a script run \`opscrew provision --plan-only\` and then the command it prints (with --confirm ${confirmPhrase})`
      : "";
  return `This plan deletes or replaces resources, so it needs the app's name: run \`${command}\` in a terminal and type ${confirmPhrase} when asked${script}.`;
}

/**
 * Plan → policies → approval bound to the plan hash → apply (constitution I). With `planOnly` it
 * stops after saving the plan and printing its hash; with `approvePlanHash` it applies the saved
 * plan from that earlier run (plans are never re-made, so the hash the user reviewed is the one
 * applied). Policy failures (critical/high) stop before approval is requested. A plan without
 * changes is "already up to date" only when it has no state renames either: a moves-only plan is
 * approved as a state rename (nothing changes in the cloud) and applied like any other. The hooks
 * (`approvalNotes`, `beforeApply`, `applyFailed`) see the plan being approved and applied.
 */
export async function planAndApply(
  deps: PhaseDeps,
  options: PlanAndApplyOptions,
): Promise<PlanAndApplyResult> {
  const { engine, dir, env, deployPlan } = options;
  const command = options.command ?? "opscrew provision";
  let saved: SavedPlan;
  if (options.approvePlanHash !== undefined) {
    const found = await findSavedPlan(deps.paths.files.plansDir, options.approvePlanHash, {
      hint: `Run \`${command} --plan-only\` again, review the plan and approve the new hash.`,
    });
    if (!found) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `No saved plan has the hash ${options.approvePlanHash}.`,
        {
          hint: `Run \`${command} --plan-only\` again, review the plan and approve the new hash.`,
        },
      );
    }
    if ((await hashFile(found.planFile).catch(() => "")) !== found.planHash) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        "The saved plan file changed after it was reviewed, so OpsCrew will not apply it.",
        { hint: `Run \`${command} --plan-only\` again and approve the new hash.` },
      );
    }
    if (found.engine.name !== engine.info.name) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `That plan was made with ${engineLabel(found.engine.name)}, but this run uses ${engineLabel(engine.info.name)}.`,
        { hint: `Re-run with --engine ${found.engine.name}.` },
      );
    }
    saved = found;
  } else {
    saved = await freshPlan(deps, options);
  }

  // A server the user owns, or the user's Portainer, costs nothing more: only Cloudflare records,
  // tunnels and Access.
  const ownServer = deployPlan.target.provider === "own";
  const portainer = deployPlan.target.provider === "portainer";
  const costDeltaOption =
    options.costDelta === undefined && (ownServer || portainer) ? null : options.costDelta;
  const details = describePlan(saved, deployPlan, { costUnchanged: costDeltaOption === null });
  deps.reporter.info(details);
  const blocking = blockingPolicyFailures(saved.policy);
  if (blocking.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The plan fails ${blocking.length} security ${blocking.length === 1 ? "policy" : "policies"}: ${blocking.map((p) => p.title).join("; ")}. Nothing was changed.`,
      { hint: blocking.map((p) => p.message).join(" ") },
    );
  }

  // A plan that only renames resources in the state (`moved` blocks) still has to be applied.
  const movesOnly = isMovesOnly(saved);
  if (saved.changes.length === 0 && !movesOnly) {
    deps.reporter.success("The infrastructure is already up to date.");
    const outputs = await engine.output(dir, { env }).catch(() => ({}));
    return { planHash: saved.planHash, applied: false, outputs, plan: saved };
  }

  if (options.approvePlanHash === undefined) await writePlanSidecar(deps.redactor, saved);
  if (options.planOnly) {
    deps.reporter.info(`Saved the plan (hash ${saved.planHash}); nothing was changed.`);
    return { planHash: saved.planHash, applied: false, outputs: {}, plan: saved };
  }

  const { create, update, delete: del, replace } = saved.counts;
  const cloudflare = deployPlan.dns.provider === "cloudflare";
  // A server the user owns has no provider API: only Cloudflare resources are planned. The user's
  // Portainer has only Cloudflare resources (tunnels, their routes and Access).
  const cloud = () => providerProfile(planProvider(deployPlan)).displayName;
  const providers = portainer
    ? "Cloudflare"
    : ownServer
      ? cloudflare
        ? "Cloudflare"
        : "your server's configuration"
      : cloudflare
        ? `${cloud()} and Cloudflare`
        : cloud();
  const notes =
    typeof options.approvalNotes === "function"
      ? options.approvalNotes(saved)
      : (options.approvalNotes ?? []);
  const costDelta = movesOnly
    ? null
    : costDeltaOption === undefined
      ? deployPlan.cost.monthly
      : costDeltaOption;
  const title = movesOnly
    ? `Rename ${resources(saved.moves?.length ?? 0)} in the infrastructure state (nothing changes in the cloud)`
    : (options.approvalTitle ??
      `Apply the infrastructure plan on ${providers} (${create} to create, ${update} to update, ${del} to delete, ${replace} to replace)`);
  const approval = await deps.approvals.request({
    kind: "iac-apply",
    title,
    details: notes.length > 0 ? `${details}\n\n${notes.join("\n")}` : details,
    planHash: saved.planHash,
    ...(costDelta !== null ? { costDelta } : {}),
    policy: saved.policy,
    ...(saved.hasDestroy ? { allowDestroy: true, confirmPhrase: deployPlan.app.name } : {}),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The infrastructure plan was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was changed.`,
      {
        hint: approveLaterHint(
          command,
          saved.planHash,
          saved.hasDestroy ? deployPlan.app.name : undefined,
        ),
      },
    );
  }
  await deps.approvals.assertApprovedPlan(saved.planHash, { allowDestroy: saved.hasDestroy });
  if (options.beforeApply !== undefined) await options.beforeApply(saved);
  if (deployPlan.deployment.destroyedAt !== undefined) await clearDestroyedAt(deps);

  deps.reporter.step(
    movesOnly
      ? "Applying the plan (it only renames resources in the infrastructure state)"
      : "Applying the plan (this usually takes one to three minutes)",
  );
  const result = await engine.apply(
    dir,
    saved.planFile,
    { approvedPlanHash: saved.planHash, allowDestroy: saved.hasDestroy },
    { env },
  );
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "apply",
    phase: options.phase ?? "provision",
    target: saved.planHash,
    decision: result.ok ? "approved" : "refused",
    detail: result.ok ? "apply finished" : "apply failed",
  });
  if (!result.ok) {
    // The message shows the last lines; the hint reads every error block of the redacted log.
    const fullLog = deps.redactor.redact(result.log);
    options.applyFailed?.(fullLog, saved);
    throw new OpsCrewError("ENGINE_FAILED", `Applying the plan failed:\n${lastLines(fullLog)}`, {
      hint: applyFailureHint(deps, fullLog, deployPlan, command),
    });
  }
  deps.reporter.success(
    movesOnly
      ? "Renamed the resources in the infrastructure state; nothing changed in the cloud."
      : "Infrastructure applied.",
  );
  return {
    planHash: saved.planHash,
    applied: true,
    outputs: result.outputs,
    approval,
    plan: saved,
  };
}
