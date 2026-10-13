import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ComputeCatalog, VpsProviderId } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { detectProjectDetails, normalizeAppDir } from "@opscrew/detect";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  type ProjectFacts,
  type Region,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { appCandidatesText } from "../analyze/summary";
import type { PhaseDeps } from "../context";
import { providerProfile, requestedProvider, vpsConnector } from "../providers";
import { moveInProgress, requireNoMoveInProgress } from "../provision/guard";
import {
  type CodeChangeSignals,
  collectCodeChangeSignals,
  deriveCodeChanges,
  type ScanFindings,
} from "./code-changes";
import { convertMoney, EXCHANGE_RATE_NOTE, formatMoney, priceLabel } from "./cost";
import { buildDesignOptions, minimumMonthlyCost } from "./options";
import { optionToPlan } from "./plan";
import { designWording } from "./wording";

export interface RunDesignOptions {
  /**
   * Interactive picker: receives the options and returns the chosen option id. Ignored when
   * `optionId` is set; without either, the recommended option is used.
   */
  choose?: (options: readonly DesignOption[]) => Promise<string>;
  /** Option id chosen up front (`opscrew design --option <id>`). */
  optionId?: string;
  /**
   * Catalogue override (tests, MCP). Default: the requested provider's live catalogue when its
   * token works, else its dated static price list.
   */
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
 * options on the requested provider (live catalogue when its token verifies, otherwise the dated
 * static table with a warning), lets the user choose (or takes `optionId` / the recommendation),
 * derives the code changes and writes `opscrew/plan.yaml`. Marks the `design` phase.
 * @throws OpsCrewError `PHASE_PRECONDITION` (nothing written) when the plan has a live deployment
 * on another provider than the one requested, and (before reading anything else) while
 * `opscrew retarget` is moving the deployment.
 */
export async function runDesign(
  deps: PhaseDeps,
  options: RunDesignOptions = {},
): Promise<DesignResult> {
  // A move in progress stops before anything else, without recording a failed design phase.
  const onDisk = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  if (onDisk !== undefined) requireNoMoveInProgress(onDisk);
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
  /** Catalogue to price against (default: the requested provider's, live when its token works). */
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

interface DesignInputs {
  facts: ProjectFacts;
  requirements: Requirements;
}

/** Collects warnings: redacted, sent to the reporter and kept for the result. */
function warner(deps: PhaseDeps, warnings: string[]): (text: string) => void {
  return (text) => {
    const said = deps.redactor.redact(text);
    warnings.push(said);
    deps.reporter.warn(said);
  };
}

/**
 * Prices the deployment options for the saved requirements without writing anything (no plan, no
 * phase state). `runDesign` builds on it; the MCP server uses it for its read-only preview. When
 * the existing plan has a live deployment on another provider than the one requested, the preview
 * still lists the options and adds a warning that `runDesign` would stop; the same while
 * `opscrew retarget` is moving the deployment.
 */
export async function previewDesignOptions(
  deps: PhaseDeps,
  options: PreviewDesignOptions = {},
): Promise<DesignPreview> {
  const inputs = await readInputs(deps, options.facts);
  const warnings: string[] = [];
  const previous = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  const move = previous === undefined ? undefined : moveInProgress(previous);
  if (move !== undefined) {
    const notice = `${move.message} \`opscrew design\` will stop without changing opscrew/plan.yaml until the move is finished or aborted. ${move.hint}`;
    warner(deps, warnings)(notice);
  } else if (previous !== undefined) {
    const block = providerSwitchBlock(
      previous,
      inputs.requirements,
      await stateExists(deps),
      "`opscrew design` will stop without changing opscrew/plan.yaml",
    );
    if (block !== undefined) warner(deps, warnings)(`${block.message} ${block.hint}`);
  }
  return priceOptions(deps, inputs, options.catalog, warnings);
}

async function readInputs(deps: PhaseDeps, facts?: ProjectFacts): Promise<DesignInputs> {
  const { paths } = deps;
  deps.reporter.step("Designing deployment options");
  const resolvedFacts =
    facts ?? (await readArtifact("architecture", paths.files.architecture)).facts;
  const requirements = await readArtifact("requirements", paths.files.requirements);
  await requireChosenApp(paths.root, resolvedFacts, requirements);
  return { facts: resolvedFacts, requirements };
}

async function priceOptions(
  deps: PhaseDeps,
  { facts, requirements }: DesignInputs,
  override: ComputeCatalog | undefined,
  warnings: string[],
): Promise<DesignPreview> {
  const { reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const warn = warner(deps, warnings);
  const provider = requestedProvider(requirements);
  const wording = designWording(provider);
  const now = deps.clock.now();

  let catalog = override;
  let isStatic = false;
  if (catalog === undefined) {
    const resolved = await resolveCatalog(deps, provider, requirements.region);
    catalog = resolved.catalog;
    isStatic = resolved.isStatic;
    if (resolved.warning !== undefined) warn(resolved.warning);
  }
  let designOptions: DesignOption[];
  try {
    designOptions = await buildDesignOptions({ facts, requirements, catalog, now });
  } catch (error) {
    // A live catalogue that fails half-way falls back to the static table; sizing errors do not.
    if (override !== undefined || isStatic) throw error;
    if (isUserFacingError(error) && error.code === "INVALID_INPUT") throw error;
    const reason = isUserFacingError(error) ? error.message : "an unexpected error";
    const fallback = await staticCatalog(deps, provider, requirements.region);
    catalog = fallback.catalog;
    warn(
      `Could not read live prices from ${wording.name} (${reason}). Using the price list dated ${fallback.date} instead; prices are estimates.`,
    );
    designOptions = await buildDesignOptions({ facts, requirements, catalog, now });
  }
  const priceSource = designOptions.every((option) => option.cost.source === "live")
    ? "live"
    : "static";

  const regionNote = wording.profile.regionNotes[requirements.region];
  if (regionNote !== undefined) reporter.info(say(regionNote));
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
  const crossCurrency = designOptions.some((o) => o.cost.monthly.currency !== budget.currency);
  if (!designOptions.some((option) => option.fitsBudget)) {
    const minimum = minimumMonthlyCost(designOptions, budget.currency);
    warn(
      `None of the options fits your budget of ${formatMoney(budget)}/month. The cheapest costs ${minimum ? formatMoney(minimum) : "more"}/month.${crossCurrency ? ` ${EXCHANGE_RATE_NOTE}` : ""} Raise the budget with \`opscrew interview\` or accept the cheapest option.`,
    );
  } else if (crossCurrency) {
    const currency = designOptions[0]?.cost.monthly.currency ?? wording.profile.currency;
    reporter.info(
      say(
        `${wording.name} prices are in ${currency} and your budget is in ${budget.currency}, so the budget comparison is approximate. ${EXCHANGE_RATE_NOTE}`,
      ),
    );
  }
  return { options: designOptions, priceSource, warnings, facts, requirements };
}

async function design(deps: PhaseDeps, options: RunDesignOptions): Promise<DesignResult> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const warnings: string[] = [];
  const warn = warner(deps, warnings);

  const inputs = await readInputs(deps);
  const previous = await readArtifact("plan", paths.files.plan).catch((error: unknown) => {
    if (!(isUserFacingError(error) && error.code === "ARTIFACT_MISSING")) {
      warn(
        "The existing opscrew/plan.yaml could not be read, so OpsCrew wrote a new plan. Settings you changed in it by hand (security, infra) and the record of an earlier deployment were not kept; check them before you run `opscrew provision`.",
      );
    }
    return undefined;
  });
  if (previous !== undefined) {
    requireSameProvider(previous, inputs.requirements, await stateExists(deps));
  }

  const preview = await priceOptions(deps, inputs, options.catalog, warnings);
  const { facts, requirements, priceSource } = preview;
  const designOptions = preview.options;
  const budget = requirements.budgetMonthly;
  const now = deps.clock.now();

  const chosen = await pick(designOptions, options);

  const [signals, scan] = await Promise.all([
    collectCodeChangeSignals(paths.root, facts).catch((): CodeChangeSignals => ({})),
    readScanFindings(paths.files.scanReportJson),
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

/** True when the local infrastructure state file exists and is not empty. */
async function stateExists(deps: PhaseDeps): Promise<boolean> {
  try {
    return (await stat(join(deps.paths.files.tfstateDir, "prod.tfstate"))).size > 0;
  } catch {
    return false;
  }
}

/**
 * The provider of a deployment that may still have resources: not destroyed, and either a server
 * address recorded, an apply recorded, or a non-empty state file (`stateExists`: a first apply
 * that fails half-way records nothing in the plan but keeps what it created in the state).
 * `undefined` when nothing can be live.
 */
export function liveDeploymentProvider(
  plan: Pick<DeployPlan, "target" | "deployment">,
  stateExists = false,
): VpsProviderId | undefined {
  const { deployment } = plan;
  if (deployment.destroyedAt !== undefined) return undefined;
  const applied =
    deployment.serverIpv4 !== undefined || deployment.lastApplyAt !== undefined || stateExists;
  return applied ? plan.target.provider : undefined;
}

/**
 * Why the requested provider cannot replace the plan's (a live deployment moves only through
 * `opscrew retarget`), or `undefined` when the switch is allowed. `outcome` is the message's last
 * sentence: what happened (or will happen) to `opscrew/plan.yaml`.
 */
function providerSwitchBlock(
  previous: DeployPlan,
  requirements: Requirements,
  stateExists: boolean,
  outcome: string,
): { message: string; hint: string } | undefined {
  const current = liveDeploymentProvider(previous, stateExists);
  const requested = requestedProvider(requirements);
  if (current === undefined || requested === current) return undefined;
  const from = providerProfile(current).displayName;
  const to = providerProfile(requested).displayName;
  const ipv4 = previous.deployment.serverIpv4;
  const where =
    ipv4 !== undefined
      ? `Your app is deployed on ${from} (${ipv4})`
      : `An earlier apply may have created resources at ${from}`;
  const retarget = `\`opscrew retarget --to ${requested}\``;
  // A move starts from a deployed server, so without an address the deployment is finished first.
  const move =
    ipv4 !== undefined
      ? `Run ${retarget} to move the deployment with its data`
      : `Run \`opscrew provision\` to finish the deployment on ${from} and then ${retarget} to move it with its data`;
  return {
    message: `${where}, but opscrew/requirements.yaml now asks for ${to}. ${outcome}.`,
    hint: `${move}, or \`opscrew destroy\` first and then \`opscrew design\`, or keep ${from} by answering \`opscrew interview\` again.`,
  };
}

/**
 * Stops with `PHASE_PRECONDITION` before anything is written when the plan has a live deployment
 * (see {@link liveDeploymentProvider}) and the requirements ask for another provider. A destroyed
 * or never-applied plan may switch.
 */
function requireSameProvider(
  previous: DeployPlan,
  requirements: Requirements,
  stateExists: boolean,
): void {
  const block = providerSwitchBlock(
    previous,
    requirements,
    stateExists,
    "opscrew/plan.yaml was not changed",
  );
  if (block !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", block.message, { hint: block.hint });
  }
}

/**
 * OpsCrew deploys one app per repository. When neither the requirements nor the facts name an app
 * folder, re-detects the repository (the saved facts may be stale) and stops with
 * `PHASE_PRECONDITION` when it has several deployable apps, instead of designing a plan from the
 * mixed facts of the repository root. When the requirements chose an app the analysis does not
 * describe, stops and says how to bring them back in line.
 */
async function requireChosenApp(
  root: string,
  facts: ProjectFacts,
  requirements: Requirements,
): Promise<void> {
  const factsDir = normalizeAppDir(facts.appDir ?? ".");
  if (requirements.appDir !== undefined) {
    const chosen = normalizeAppDir(requirements.appDir);
    if (chosen === factsDir) return;
    const described = factsDir === "." ? "the repository root" : factsDir;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/requirements.yaml chooses the app in ${chosen === "." ? "the repository root" : chosen}, but opscrew/architecture.json describes ${described}.`,
      {
        hint: `Run \`opscrew analyze\` to describe the chosen app${factsDir === "." ? "" : `, or \`opscrew interview\` to deploy ${factsDir} instead`}, then run \`opscrew design\` again.`,
      },
    );
  }
  if (factsDir !== ".") return;
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
    `This repository contains ${candidates.length} deployable apps: ${appCandidatesText(detection.facts, candidates)}. OpsCrew deploys one app, so choose which one before designing the deployment.`,
    {
      hint: `Run \`opscrew interview\` and pick the app, or \`opscrew analyze --app ${candidates[0]}\`, then run \`opscrew design\` again.`,
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

/**
 * Plain-English warnings when the new plan moves or resizes a server that already exists. A
 * destroyed deployment, or one on another provider (only possible once destroyed), has no server
 * to move.
 */
function serverChangeWarnings(previous: DeployPlan, plan: DeployPlan): string[] {
  const { deployment } = previous;
  const deployed =
    deployment.serverIpv4 !== undefined ||
    deployment.serverIpv6 !== undefined ||
    deployment.lastApplyAt !== undefined ||
    deployment.lastPlanHash !== undefined;
  if (!deployed || deployment.destroyedAt !== undefined) return [];
  const before = previous.target;
  const after = plan.target;
  if (before.provider !== after.provider) return [];
  const server = providerProfile(after.provider).serverNoun;
  if (before.location !== after.location) {
    return [
      `Your ${server} already runs in ${before.location} (${before.serverType}). The chosen option uses ${after.location} (${after.serverType}), so the next \`opscrew provision\` will replace the ${server}: it creates a new one and deletes the old one together with the data on it. Back up your data first, or choose an option in ${before.location} to keep the ${server}.`,
    ];
  }
  if (before.serverType !== after.serverType) {
    return [
      `The chosen option changes the server type from ${before.serverType} to ${after.serverType}, so the next \`opscrew provision\` will resize the ${server}. The app is offline while the ${server} restarts.`,
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

interface ResolvedCatalog {
  catalog: ComputeCatalog;
  /** True for the dated static price list. */
  isStatic: boolean;
  warning?: string;
}

/**
 * The provider's live catalogue when its token is set and verifies; otherwise its dated static
 * price list with a warning that names the date and the token variable to set.
 */
async function resolveCatalog(
  deps: PhaseDeps,
  provider: VpsProviderId,
  region: Region,
): Promise<ResolvedCatalog> {
  const wording = designWording(provider);
  const connector = vpsConnector(provider, deps, { now: () => deps.clock.now() });
  if (!connector.configured) {
    const fallback = await staticCatalog(deps, provider, region);
    return {
      catalog: fallback.catalog,
      isStatic: true,
      warning: `${wording.tokenVar} is not set, so prices come from ${fallback.dated} and are estimates; ${wording.profile.serverNoun} availability is not checked. Set ${wording.tokenVar} for live prices.`,
    };
  }
  const check = await connector.verifyCredentials();
  if (!check.ok) {
    const fallback = await staticCatalog(deps, provider, region);
    return {
      catalog: fallback.catalog,
      isStatic: true,
      warning: `The ${wording.name} token could not be used (${check.message}) Prices come from ${fallback.dated} and are estimates.`,
    };
  }
  return { catalog: connector.catalog(), isStatic: false };
}

/**
 * The provider's dated static price list (its connector without a token) and the list's date,
 * read from the static extras of the region's first location.
 */
async function staticCatalog(
  deps: PhaseDeps,
  provider: VpsProviderId,
  region: Region,
): Promise<{ catalog: ComputeCatalog; date: string; dated: string }> {
  const catalog = vpsConnector(provider, {
    env: {},
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  }).catalog();
  const location = providerProfile(provider).regionLocations[region][0] ?? "";
  const date = (await catalog.extras(location)).asOf.slice(0, 10);
  return {
    catalog,
    date,
    dated: `${designWording(provider).name}'s published price list dated ${date}`,
  };
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
