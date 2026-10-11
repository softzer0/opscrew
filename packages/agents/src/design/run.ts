import { readFile } from "node:fs/promises";
import { hetznerConnector, StaticHetznerCatalog } from "@opscrew/connector-hetzner";
import type { ComputeCatalog } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { detectProjectDetails } from "@opscrew/detect";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { appCandidatesText } from "../analyze/summary";
import type { PhaseDeps } from "../context";
import {
  type CodeChangeSignals,
  collectCodeChangeSignals,
  deriveCodeChanges,
  type ScanFindings,
} from "./code-changes";
import { convertMoney, EXCHANGE_RATE_NOTE, formatMoney, priceLabel } from "./cost";
import { buildDesignOptions, minimumMonthlyCost } from "./options";
import { optionToPlan } from "./plan";

export interface RunDesignOptions {
  /**
   * Interactive picker: receives the options and returns the chosen option id. Ignored when
   * `optionId` is set; without either, the recommended option is used.
   */
  choose?: (options: readonly DesignOption[]) => Promise<string>;
  /** Option id chosen up front (`opscrew design --option <id>`). */
  optionId?: string;
  /** Catalogue override (tests, MCP). Default: live Hetzner when HCLOUD_TOKEN works, else static. */
  catalog?: ComputeCatalog;
}

export interface DesignResult {
  options: DesignOption[];
  chosen: DesignOption;
  plan: DeployPlan;
  /** Where prices came from. */
  priceSource: "live" | "static";
  /** Plain-English warnings that were also sent to the reporter. */
  warnings: string[];
}

/** Lenient reader for `.opscrew/scan.json`: only the fields code-change derivation needs. */
const ScanFileSchema = z.looseObject({
  findings: z.array(
    z.looseObject({ ruleId: z.string(), title: z.string(), file: z.string().optional() }),
  ),
});

/**
 * The design phase: reads `opscrew/architecture.json` and `opscrew/requirements.yaml`, prices 2–3
 * Hetzner options (live catalogue when `HCLOUD_TOKEN` verifies, otherwise the dated static table
 * with a warning), lets the user choose (or takes `optionId` / the recommendation), derives the
 * code changes and writes `opscrew/plan.yaml`. Marks the `design` phase.
 */
export async function runDesign(
  deps: PhaseDeps,
  options: RunDesignOptions = {},
): Promise<DesignResult> {
  try {
    return await design(deps, options);
  } catch (error) {
    await deps.state.markPhase(
      "design",
      "failed",
      isUserFacingError(error) ? deps.redactor.redact(error.message) : undefined,
    );
    throw error;
  }
}

export interface PreviewDesignOptions {
  /** Catalogue to price against (default: live when `HCLOUD_TOKEN` verifies, else static). */
  catalog?: ComputeCatalog;
  /** Project facts to use instead of reading `opscrew/architecture.json`. */
  facts?: ProjectFacts;
}

export interface DesignPreview {
  options: DesignOption[];
  priceSource: "live" | "static";
  warnings: string[];
  facts: ProjectFacts;
  requirements: Requirements;
}

/**
 * Prices the deployment options for the saved requirements without writing anything (no plan, no
 * phase state). `runDesign` builds on it; the MCP server uses it for its read-only preview.
 */
export async function previewDesignOptions(
  deps: PhaseDeps,
  options: PreviewDesignOptions = {},
): Promise<DesignPreview> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const warnings: string[] = [];
  const warn = (text: string) => {
    warnings.push(say(text));
    reporter.warn(say(text));
  };

  reporter.step("Designing deployment options");
  const facts =
    options.facts ?? (await readArtifact("architecture", paths.files.architecture)).facts;
  const requirements = await readArtifact("requirements", paths.files.requirements);
  await requireSingleApp(paths.root);
  const now = deps.clock.now();

  let catalog = options.catalog;
  if (catalog === undefined) {
    const resolved = await resolveCatalog(deps);
    catalog = resolved.catalog;
    if (resolved.warning !== undefined) warn(resolved.warning);
  }
  let designOptions: DesignOption[];
  try {
    designOptions = await buildDesignOptions({ facts, requirements, catalog, now });
  } catch (error) {
    // A live catalogue that fails half-way falls back to the static table; sizing errors do not.
    if (options.catalog !== undefined || catalog instanceof StaticHetznerCatalog) throw error;
    if (isUserFacingError(error) && error.code === "INVALID_INPUT") throw error;
    const reason = isUserFacingError(error) ? error.message : "an unexpected error";
    const fallback = new StaticHetznerCatalog();
    catalog = fallback;
    warn(
      `Could not read live prices from Hetzner (${reason}). Using the price list dated ${fallback.asOf.slice(0, 10)} instead; prices are estimates.`,
    );
    designOptions = await buildDesignOptions({ facts, requirements, catalog, now });
  }
  const priceSource = designOptions.every((option) => option.cost.source === "live")
    ? "live"
    : "static";

  const budget = requirements.budgetMonthly;
  for (const option of designOptions) {
    const marks = [
      option.fitsBudget ? "fits the budget" : "over budget",
      ...(option.recommended ? ["recommended"] : []),
    ];
    reporter.info(
      say(
        `${option.title} (${option.id}): ${formatMoney(option.cost.monthly)}/month, ${priceLabel(option.cost)} — ${marks.join(", ")}`,
      ),
    );
  }
  if (!designOptions.some((option) => option.fitsBudget)) {
    const minimum = minimumMonthlyCost(designOptions, budget.currency);
    const crossCurrency = designOptions.some((o) => o.cost.monthly.currency !== budget.currency);
    warn(
      `None of the options fits your budget of ${formatMoney(budget)}/month. The cheapest costs ${minimum ? formatMoney(minimum) : "more"}/month.${crossCurrency ? ` ${EXCHANGE_RATE_NOTE}` : ""} Raise the budget with \`opscrew interview\` or accept the cheapest option.`,
    );
  }
  return { options: designOptions, priceSource, warnings, facts, requirements };
}

async function design(deps: PhaseDeps, options: RunDesignOptions): Promise<DesignResult> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const preview = await previewDesignOptions(
    deps,
    options.catalog !== undefined ? { catalog: options.catalog } : {},
  );
  const { facts, requirements, priceSource, warnings } = preview;
  const designOptions = preview.options;
  const budget = requirements.budgetMonthly;
  const now = deps.clock.now();

  const chosen = await pick(designOptions, options);

  const warn = (text: string) => {
    warnings.push(say(text));
    reporter.warn(say(text));
  };

  const [signals, scan, previous] = await Promise.all([
    collectCodeChangeSignals(paths.root, facts).catch((): CodeChangeSignals => ({})),
    readScanFindings(paths.files.scanReportJson),
    readArtifact("plan", paths.files.plan).catch((error: unknown) => {
      if (!(isUserFacingError(error) && error.code === "ARTIFACT_MISSING")) {
        warn(
          "The existing opscrew/plan.yaml could not be read, so OpsCrew wrote a new plan. Settings you changed in it by hand (security, infra) and the record of an earlier deployment were not kept; check them before you run `opscrew provision`.",
        );
      }
      return undefined;
    }),
  ]);
  const codeChanges = deriveCodeChanges(facts, scan, signals);
  const fresh = optionToPlan(chosen, {
    facts,
    requirements,
    now,
    codeChanges,
    signals,
    ...(previous ? { createdAt: previous.createdAt } : {}),
  });
  const plan = previous ? keepPlanSettings(fresh, previous) : fresh;
  if (previous) for (const warning of serverChangeWarnings(previous, plan)) warn(warning);
  await writeArtifact("plan", paths.files.plan, plan);

  const planFile = toPosixRelative(paths.root, paths.files.plan);
  const cost = formatMoney(chosen.cost.monthly);
  const inBudget =
    chosen.cost.monthly.currency === budget.currency
      ? ""
      : ` (about ${formatMoney(convertMoney(chosen.cost.monthly, budget.currency))})`;
  reporter.success(
    say(
      `Wrote ${planFile}: ${chosen.title}, ${cost}/month${inBudget}, ${codeChanges.length} code change${codeChanges.length === 1 ? "" : "s"} to make.`,
    ),
  );
  reporter.info("Next: run `opscrew adapt` to prepare the code in a pull request.");
  await deps.state.markPhase(
    "design",
    "ok",
    say(`${chosen.id}, ${cost}/month (${priceLabel(chosen.cost)})`),
  );
  return { options: designOptions, chosen, plan, priceSource, warnings };
}

/**
 * OpsCrew v1 deploys one app per repository. Re-detects the repository (the saved facts may be
 * stale) and stops with `PHASE_PRECONDITION` when a monorepo has several deployable apps, instead
 * of designing a plan from the mixed facts of the repository root.
 */
async function requireSingleApp(root: string): Promise<void> {
  let detection: Awaited<ReturnType<typeof detectProjectDetails>>;
  try {
    detection = await detectProjectDetails(root);
  } catch {
    return; // Analyze already reported detection problems; the saved facts are used as they are.
  }
  const candidates = detection.appCandidates;
  if (candidates.length <= 1) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This repository contains ${candidates.length} deployable apps: ${appCandidatesText(detection.facts, candidates)}. OpsCrew v1 deploys one app per repository, so it cannot design one deployment for all of them.`,
    {
      hint: `If the app you want to deploy is self-contained (it does not use code from other folders of this repository), run OpsCrew from the app's folder, for example \`cd ${candidates[0]}\` and then \`opscrew analyze\`. Otherwise wait for monorepo support in a later OpsCrew version.`,
    },
  );
}

/**
 * Carries what the user and later phases put into the previous plan over to the new one:
 * `deployment`, `approvals`, `security`, `infra` and the status of code changes that are still
 * the same change (id, kind and path). `security.httpAllowedFrom` is re-derived when the DNS proxy
 * setting changed, so a Cloudflare-only allow-list never outlives the Cloudflare proxy.
 */
function keepPlanSettings(fresh: DeployPlan, previous: DeployPlan): DeployPlan {
  const key = (change: DeployPlan["codeChanges"][number]) =>
    `${change.id}\u0000${change.kind}\u0000${change.path}`;
  const statuses = new Map(previous.codeChanges.map((change) => [key(change), change.status]));
  const { httpAllowedFrom, ...security } = previous.security;
  return DeployPlanSchema.parse({
    ...fresh,
    codeChanges: fresh.codeChanges.map((change) => ({
      ...change,
      status: statuses.get(key(change)) ?? change.status,
    })),
    infra: previous.infra,
    security: previous.dns.proxied === fresh.dns.proxied ? previous.security : security,
    approvals: previous.approvals,
    deployment: previous.deployment,
  });
}

/** Plain-English warnings when the new plan moves or resizes a server that already exists. */
function serverChangeWarnings(previous: DeployPlan, plan: DeployPlan): string[] {
  const { deployment } = previous;
  const deployed =
    deployment.serverIpv4 !== undefined ||
    deployment.serverIpv6 !== undefined ||
    deployment.lastApplyAt !== undefined ||
    deployment.lastPlanHash !== undefined;
  if (!deployed) return [];
  const before = previous.target;
  const after = plan.target;
  if (before.location !== after.location) {
    return [
      `Your server already runs in ${before.location} (${before.serverType}). The chosen option uses ${after.location} (${after.serverType}), so the next \`opscrew provision\` will replace the server: it creates a new one and deletes the old one together with the data on it. Back up your data first, or choose an option in ${before.location} to keep the server.`,
    ];
  }
  if (before.serverType !== after.serverType) {
    return [
      `The chosen option changes the server type from ${before.serverType} to ${after.serverType}, so the next \`opscrew provision\` will resize the server. The app is offline while the server restarts.`,
    ];
  }
  return [];
}

async function pick(
  designOptions: readonly DesignOption[],
  options: RunDesignOptions,
): Promise<DesignOption> {
  let id = options.optionId;
  if (id === undefined && options.choose !== undefined) id = await options.choose(designOptions);
  if (id === undefined) {
    return designOptions.find((option) => option.recommended) as DesignOption;
  }
  const chosen = designOptions.find((option) => option.id === id);
  if (chosen === undefined) {
    throw new OpsCrewError("INVALID_INPUT", `There is no design option "${id}".`, {
      hint: `Choose one of: ${designOptions.map((option) => option.id).join(", ")}.`,
    });
  }
  return chosen;
}

async function resolveCatalog(
  deps: PhaseDeps,
): Promise<{ catalog: ComputeCatalog; warning?: string }> {
  const fallback = new StaticHetznerCatalog();
  const dated = `Hetzner's published price list dated ${fallback.asOf.slice(0, 10)}`;
  if (!deps.env.HCLOUD_TOKEN?.trim()) {
    return {
      catalog: fallback,
      warning: `HCLOUD_TOKEN is not set, so prices come from ${dated} and are estimates; server availability is not checked. Set HCLOUD_TOKEN for live prices.`,
    };
  }
  const connector = hetznerConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
    now: () => deps.clock.now(),
  });
  const check = await connector.verifyCredentials();
  if (!check.ok) {
    return {
      catalog: fallback,
      warning: `The Hetzner token could not be used (${check.message}) Prices come from ${dated} and are estimates.`,
    };
  }
  return { catalog: connector.catalog() };
}

async function readScanFindings(file: string): Promise<ScanFindings | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = ScanFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
