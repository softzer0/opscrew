import type { ComputeCatalog, VpsProviderId } from "@opscrew/contracts";
import {
  canonicalJson,
  formatMoney,
  isUserFacingError,
  listText,
  lowerFirst,
  OpsCrewError,
  plural,
  toPosixRelative,
} from "@opscrew/core";
import { detectProjectDetails, normalizeAppDir } from "@opscrew/detect";
import { type EdgeProxy, edgeMemoryMb, edgeProxy, serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DeployProvider,
  type DesignOption,
  EnvironmentSchema,
  type PlanService,
  type ProjectFacts,
  type Region,
  type Requirements,
  readArtifact,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { appCandidatesText } from "../analyze/summary";
import type { PhaseDeps } from "../context";
import { requireOwnHostnames } from "../environments/hostnames";
import {
  environmentInfraDir,
  environmentPaths,
  environmentWorkflowPath,
} from "../environments/paths";
import { readEnvironmentRequirements } from "../environments/requirements";
import {
  type SharedPartsSource,
  sharedPartsSource,
  withSharedParts,
} from "../environments/shared-parts";
import {
  buildLocalhostOption,
  LOCALHOST_PRICE_NOTE,
  type LocalhostDesignChoice,
  localhostDesignChoice,
  localhostImageWarnings,
  onThisComputer,
} from "../localhost/design";
import { githubRegistry, type LocalRegistry } from "../localhost/image";
import type { LocalhostServices } from "../localhost/services";
import {
  type OwnServerFacts,
  providerProfile,
  requestedProvider,
  requestedRegion,
  vpsConnector,
} from "../providers";
import { moveInProgress, requireNoMoveInProgress } from "../provision/guard";
import { reasonOf } from "../retarget/steps";
import {
  appMemoryMb,
  designOptionLine,
  hasDeployment,
  hasState,
  memoryHeadroom,
  readOwnServer,
  readPortainerConnection,
  serverAddress,
  serviceFilledNames,
} from "../shared";
import { buildStatusLines, runPhase, supplyChainLines } from "../shared/phase-status";
import { vercelAdditions } from "./additions";
import { backgroundJobsWarning } from "./background-jobs";
import { chooseBuilder } from "./builder";
import {
  type CodeChangeSignals,
  collectCodeChangeSignals,
  deriveCodeChanges,
  readScanReport,
} from "./code-changes";
import {
  type Components,
  designComponents,
  memoryText,
  routeJobsOffText,
  uncallableRouteJobs,
} from "./components";
import { convertMoney, EXCHANGE_RATE_NOTE, priceLabel } from "./cost";
import { buildDesignOptions, lowHeadroomText, minimumMonthlyCost } from "./options";
import {
  buildOwnServerOption,
  mayHavePublicIpv4,
  OWN_SERVER_BACKUPS_NOTE,
  OWN_SERVER_PRICE_NOTE,
  type OwnServerAccess,
  type OwnServerServing,
  ownServerServing,
  proxyNeedsIpv4Message,
  servingAccess,
  tunnelDomainMessage,
  tunnelNeedsCloudflareDomain,
} from "./own";
import { optionToPlan } from "./plan";
import {
  buildPortainerOption,
  PORTAINER_BACKUPS_NOTE,
  PORTAINER_HOST_NOTE,
  PORTAINER_PRICE_NOTE,
  type PortainerDesignChoice,
  portainerChoiceProblem,
  portainerDesignChoice,
} from "./portainer";
import { releaseCommandNote } from "./release";
import { ownServerMemory, type ServerApp } from "./sizing";
import { checkSqliteFolder, sqliteOwnerWarning } from "./storage";
import { keptDeploy } from "./strategy";
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
  /** A server the user owns: what inspection found and how the internet reaches it. */
  ownServer?: OwnServerDesignInput;
  /**
   * A new environment's deploy source and runner (`opscrew env add`), with its runner machine and
   * where it builds, written into its first plan; a later design keeps the plan's own.
   */
  environment?: Pick<
    NonNullable<DeployPlan["environment"]>,
    "deploySource" | "runner" | "runnerHost" | "build"
  >;
  /**
   * A new environment's `cicd.branch` (`opscrew env add --branch`), written into its first plan;
   * a later design keeps the plan's own.
   */
  branch?: string;
  /** This computer (the localhost target): its CPU and the port probe (fakes in tests). */
  localhost?: Pick<LocalhostServices, "arch" | "portFree">;
  /**
   * The app's image on GHCR (a fake in tests; default `githubRegistry`, with the user's GitHub
   * token). A promoted environment's design reads which image it and its source run when it has a
   * service its source no longer has.
   */
  registry?: Pick<LocalRegistry, "taggedDigest">;
}

/**
 * Design input for a server the user already owns. The caller inspects the server (over SSH,
 * through the host adapter); design itself never connects to it.
 */
export interface OwnServerDesignInput {
  /** The inspected server, offered as the single option (ignored with a catalogue override). */
  facts?: OwnServerFacts;
  /**
   * How the internet reaches the server; default: the interview's answers. `public` means the
   * server is reachable (it is then served as `serving` or the interview's `server.serve` says).
   */
  access?: OwnServerAccess;
  /** How the site is served; default: the interview's answers (see `ownServerServing`). */
  serving?: OwnServerServing;
  /**
   * The OpsCrew apps set up on the server with the sum of their memory limits (their records): the
   * server's memory must hold this app next to the others. This app's own record, on a later
   * design, is left out by its name.
   */
  apps?: readonly ServerApp[];
  /** The server's x86 CPU has AVX (inspection's CPU flags; MongoDB 5 and later need it). */
  avx?: boolean;
}

export interface DesignResult {
  options: DesignOption[];
  chosen: DesignOption;
  plan: DeployPlan;
  /** Where prices came from. */
  priceSource: "live" | "static";
  /** Plain-English warnings that were also sent to the reporter. */
  warnings: string[];
  /**
   * The image builder, deploy strategy and supply-chain lines, each with its reason, and the
   * additions written from `vercel.json` with the rules left out, as design reported them.
   */
  lines: string[];
}

/**
 * The design phase: reads `opscrew/architecture.json` and `opscrew/requirements.yaml`, prices 2–3
 * options on the requested provider (live catalogue when its token verifies, otherwise the dated
 * static table with a warning), lets the user choose (or takes `optionId` / the recommendation),
 * derives the code changes and writes `opscrew/plan.yaml`. Marks the `design` phase.
 *
 * For an environment other than prod (`deps.paths.environment`) the requirements are prod's with
 * the environment's own answers over them, and the plan (`opscrew/environments/<env>/plan.yaml`)
 * is named after prod's: its app name is `<app>-<env>`, with its own infrastructure root, workflow
 * and `environment` block. What every environment shares follows the image (FR-1539): an
 * environment that builds, prod included, takes it from its own design; one that runs another
 * environment's image (`sharedPartsSource`: the one it is promoted from, or prod's for this
 * computer pulling prod's image) takes it from that plan, whose components it is designed from and
 * whose shared parts it copies (`withSharedParts`). A promoted one keeps the services its source no
 * longer has while it does not run the source's image yet ({@link servicesToKeep}). A hostname
 * another environment uses stops design.
 * @throws OpsCrewError `PHASE_PRECONDITION` (nothing written) when the plan has a live deployment
 * on another provider than the one requested, before prod's plan exists for another environment,
 * before a promoted environment's source has a plan, and (before reading anything else) while
 * `opscrew retarget` is moving the deployment.
 */
export async function runDesign(
  deps: PhaseDeps,
  options: RunDesignOptions = {},
): Promise<DesignResult> {
  // A move in progress stops before anything else, without recording a failed design phase.
  const onDisk = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  if (onDisk !== undefined) requireNoMoveInProgress(onDisk);
  return runPhase(deps, "design", () => design(deps, options));
}

export interface PreviewDesignOptions {
  /** Catalogue to price against (default: the requested provider's, live when its token works). */
  catalog?: ComputeCatalog;
  /** Project facts to use instead of reading `opscrew/architecture.json`. */
  facts?: ProjectFacts;
  /** A server the user owns: what inspection found and how the internet reaches it. */
  ownServer?: OwnServerDesignInput;
  /** This computer (the localhost target): its CPU and the port probe (fakes in tests). */
  localhost?: Pick<LocalhostServices, "arch" | "portFree">;
}

export interface DesignPreview {
  options: DesignOption[];
  priceSource: "live" | "static";
  warnings: string[];
  facts: ProjectFacts;
  requirements: Requirements;
  /** A server the user owns: how the internet reaches it (the plan's `target.access`). */
  access?: OwnServerAccess;
  /** A server the user owns: how the site is served (tunnel, proxy with the filter, DNS only). */
  serving?: OwnServerServing;
  /** An existing Portainer: the environment, its architecture and the chosen modes. */
  portainer?: PortainerDesignChoice;
  /** This computer: its CPU, the edge's ports and where the image comes from. */
  localhost?: LocalhostDesignChoice;
  /** What runs next to the app, with the previous plan's edits kept. */
  components: Components;
  /** One plain sentence per component, licence, storage choice and kept edit. */
  lines: string[];
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
  const source = await sharedPartsSource(deps.paths, previous ?? {});
  const move = previous === undefined ? undefined : moveInProgress(previous);
  if (move !== undefined) {
    const notice = `${move.message} \`opscrew design\` will stop without changing opscrew/plan.yaml until the move is finished or aborted. ${move.hint}`;
    warner(deps, warnings)(notice);
  } else if (previous !== undefined) {
    const block = providerSwitchBlock(
      previous,
      inputs.requirements,
      await mayHaveResources(deps, previous),
      "`opscrew design` will stop without changing opscrew/plan.yaml",
      await knowsDeployment(deps, previous),
    );
    if (block !== undefined) warner(deps, warnings)(`${block.message} ${block.hint}`);
  }
  return priceOptions(deps, inputs, options.catalog, warnings, options.ownServer, {
    previous,
    shared: source?.plan,
    localhost: { services: options.localhost, environment: previous ?? {} },
  });
}

/**
 * Prod's plan, which an environment other than prod is named after (`<app>-<env>`).
 * @throws OpsCrewError `PHASE_PRECONDITION` when it does not exist yet.
 */
async function prodPlanOf(deps: PhaseDeps): Promise<DeployPlan> {
  const name = deps.paths.environment;
  const prodPlan = await readOptionalArtifact(
    "plan",
    environmentPaths(deps.paths, "prod").files.plan,
  );
  if (prodPlan !== undefined) return prodPlan;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${name} environment's app is named after prod's (\`<app>-${name}\`), and opscrew/plan.yaml does not exist yet. Nothing was written.`,
    { hint: `Run \`opscrew design\` for prod first, then \`opscrew design --env ${name}\`.` },
  );
}

/**
 * How the user's own server serves the site: `input.serving`, else from `input.access` or the
 * interview's answers (`server.reachable` and `server.serve`, see `ownServerServing`): the tunnel
 * by default whenever the domain is on Cloudflare, behind Cloudflare's proxy with the web filter
 * only as the explicit `proxy` answer, DNS only without a Cloudflare domain or as the answer.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the interview has no answers about the server.
 */
async function ownServerAccess(
  deps: PhaseDeps,
  input: OwnServerDesignInput | undefined,
  requirements: Requirements,
): Promise<OwnServerServing> {
  if (input?.serving !== undefined) return input.serving;
  if (input?.access === "tunnel") return "tunnel";
  const recorded = await readOwnServer(deps.paths);
  const reachable = input?.access === "public" ? true : recorded?.reachable;
  if (reachable === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/requirements.yaml says the app runs on a server you already have, but OpsCrew does not know how to reach it on this computer.",
      {
        hint: "Run `opscrew interview` and answer the questions about your server, then run `opscrew design` again.",
      },
    );
  }
  const serving = ownServerServing({ reachable, serve: recorded?.serve, requirements });
  if (serving === "proxy" && recorded !== undefined && !mayHavePublicIpv4(recorded)) {
    const { message, hint } = proxyNeedsIpv4Message();
    throw new OpsCrewError("PHASE_PRECONDITION", message, { hint });
  }
  return serving;
}

/** Warnings about the app itself: background jobs and what detection noted. */
function appWarnings(
  facts: ProjectFacts,
  components: Components,
  warn: (text: string) => void,
): void {
  const jobs = backgroundJobsWarning(facts, components);
  if (jobs !== undefined) warn(jobs);
  // What detection noted about the app, such as parts of it OpsCrew does not deploy yet.
  for (const note of facts.notes ?? []) warn(note);
}

/** What runs next to the app, from the facts, the interview and the previous plan's edits. */
interface Designed {
  components: Components;
  lines: string[];
}

/**
 * The single option on the user's own server: no price, warnings when the server is smaller than
 * the app needs or a tunnel has no Cloudflare domain, and the backups note.
 */
async function priceOwnServer(
  deps: PhaseDeps,
  { facts, requirements }: DesignInputs,
  catalog: ComputeCatalog,
  warnings: string[],
  input: OwnServerDesignInput | undefined,
  designed: Designed,
  edge: EdgeProxy,
): Promise<DesignPreview> {
  const say = (text: string) => deps.redactor.redact(text);
  const warn = warner(deps, warnings);
  const serving = await ownServerAccess(deps, input, requirements);
  const access = servingAccess(serving);
  const own = await buildOwnServerOption({
    facts,
    requirements,
    catalog,
    access,
    serving,
    components: designed.components,
    edge,
  });
  for (const warning of own.warnings) warn(warning);
  const { option } = own;
  deps.reporter.info(
    say(`${option.title} (${option.id}): ${lowerFirst(OWN_SERVER_PRICE_NOTE)} — recommended`),
  );
  deps.reporter.info(OWN_SERVER_BACKUPS_NOTE);
  appWarnings(facts, designed.components, warn);
  return {
    options: [option],
    priceSource: "live",
    warnings,
    facts,
    requirements,
    access,
    serving,
    ...designed,
  };
}

/**
 * The single option in the user's existing Portainer, from the interview's answers in
 * `.opscrew/server.json`: no price, the environment's architecture, and the notes that OpsCrew
 * does not change the host and that backups are the user's.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the answers are missing or the requirements no
 * longer allow them.
 */
async function pricePortainer(
  deps: PhaseDeps,
  { facts, requirements }: DesignInputs,
  warnings: string[],
  designed: Designed,
): Promise<DesignPreview> {
  const choice = portainerDesignChoice(await readPortainerConnection(deps.paths));
  const problem = portainerChoiceProblem(requirements, choice);
  if (problem !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", problem.message, { hint: problem.hint });
  }
  const option = buildPortainerOption({ facts, requirements, choice, now: deps.clock.now() });
  deps.reporter.info(
    deps.redactor.redact(
      `${option.title} (${option.id}): ${lowerFirst(PORTAINER_PRICE_NOTE)} — recommended`,
    ),
  );
  deps.reporter.info(PORTAINER_HOST_NOTE);
  deps.reporter.info(PORTAINER_BACKUPS_NOTE);
  appWarnings(facts, designed.components, warner(deps, warnings));
  return {
    options: [option],
    priceSource: "live",
    warnings,
    facts,
    requirements,
    portainer: choice,
    ...designed,
  };
}

async function readInputs(deps: PhaseDeps, facts?: ProjectFacts): Promise<DesignInputs> {
  const { paths } = deps;
  deps.reporter.step("Designing deployment options");
  const resolvedFacts =
    facts ?? (await readArtifact("architecture", paths.files.architecture)).facts;
  const answered = await readEnvironmentRequirements(paths);
  // This computer has no region, domain or DNS, whatever prod's answers say.
  const requirements = answered.provider === "localhost" ? onThisComputer(answered) : answered;
  await requireChosenApp(paths.root, resolvedFacts, requirements);
  return { facts: resolvedFacts, requirements };
}

/**
 * What runs next to the app ({@link designComponents}, keeping the edits of `previous`: the
 * plan's own, or its source's for a promoted environment), its warnings said, after refusing an SQLite
 * folder a persistent volume cannot take (the folder the database is moved to, when the framework
 * reads its path from the environment, `sqliteMove`).
 */
async function componentsFor(
  deps: PhaseDeps,
  { facts, requirements }: DesignInputs,
  previous: DeployPlan | undefined,
  warn: (text: string) => void,
  vcpus: number | undefined,
): Promise<Designed> {
  const designed = designComponents({ facts, requirements, previous, vcpus });
  const sqlite = designed.components.storage?.sqlite;
  if (sqlite !== undefined) await checkSqliteFolder(deps.paths.root, facts, sqlite.dir);
  for (const warning of designed.warnings) warn(warning);
  return { components: designed.components, lines: designed.lines };
}

/**
 * The plans design starts from: the environment's own `previous` plan, and for a promoted
 * environment its source's plan (`shared`), whose shared parts it takes.
 */
interface PlanBasis {
  previous: DeployPlan | undefined;
  shared: DeployPlan | undefined;
  /**
   * This computer: its CPU and port probe, and the environment block whose deploy source decides
   * where the image comes from (the new environment's, else the previous plan's).
   */
  localhost?: {
    services: Pick<LocalhostServices, "arch" | "portFree"> | undefined;
    environment: Pick<DeployPlan, "environment">;
  };
}

/**
 * The single option on this computer: no price, the computer's CPU and the edge's ports
 * (`localhostDesignChoice`), with the app's warnings.
 */
async function priceLocalhost(
  deps: PhaseDeps,
  { facts, requirements }: DesignInputs,
  warnings: string[],
  designed: Designed,
  basis: PlanBasis,
): Promise<DesignPreview> {
  const choice = await localhostDesignChoice(
    deps,
    { previous: basis.previous, environment: basis.localhost?.environment ?? basis.previous ?? {} },
    basis.localhost?.services,
  );
  const option = buildLocalhostOption({
    facts,
    requirements,
    arch: choice.arch,
    now: deps.clock.now(),
  });
  deps.reporter.info(
    deps.redactor.redact(
      `${option.title} (${option.id}): ${lowerFirst(LOCALHOST_PRICE_NOTE)} — recommended`,
    ),
  );
  appWarnings(facts, designed.components, warner(deps, warnings));
  return {
    options: [option],
    priceSource: "live",
    warnings,
    facts,
    requirements,
    localhost: choice,
    ...designed,
  };
}

async function priceOptions(
  deps: PhaseDeps,
  inputs: DesignInputs,
  override: ComputeCatalog | undefined,
  warnings: string[],
  ownServer: OwnServerDesignInput | undefined,
  basis: PlanBasis,
): Promise<DesignPreview> {
  const { previous, shared } = basis;
  const { facts, requirements } = inputs;
  // The user's own server is the catalogue's only offer; its vCPUs decide whether Dragonfly is
  // offered there.
  const ownCatalog =
    requirements.provider === "own"
      ? (override ??
        vpsConnector("own", deps, {
          now: () => deps.clock.now(),
          ...(ownServer?.facts !== undefined ? { ownServer: ownServer.facts } : {}),
        }).catalog())
      : undefined;
  const vcpus = (await ownCatalog?.listOffers())?.[0]?.vcpus;
  const designed = await componentsFor(
    deps,
    inputs,
    shared ?? previous,
    warner(deps, warnings),
    vcpus,
  );
  if (requirements.provider === "portainer") {
    return pricePortainer(deps, inputs, warnings, designed);
  }
  if (requirements.provider === "localhost") {
    return priceLocalhost(deps, inputs, warnings, designed, basis);
  }
  // The server's proxy carries over from the earlier plan (`keepPlanSettings`).
  const edge = previous === undefined ? "caddy" : edgeProxy(previous);
  if (ownCatalog !== undefined) {
    return priceOwnServer(deps, inputs, ownCatalog, warnings, ownServer, designed, edge);
  }
  const provider = requestedProvider(requirements);
  const { components } = designed;
  const { reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const warn = warner(deps, warnings);
  const wording = designWording(provider);
  const region = requestedRegion(requirements);
  if (region === undefined) throw new Error(`${provider} requirements need a region.`);
  const now = deps.clock.now();

  let catalog = override;
  let isStatic = false;
  if (catalog === undefined) {
    const resolved = await resolveCatalog(deps, provider, region);
    catalog = resolved.catalog;
    isStatic = resolved.isStatic;
    if (resolved.warning !== undefined) warn(resolved.warning);
  }
  let designOptions: DesignOption[];
  try {
    designOptions = await buildDesignOptions({
      facts,
      requirements,
      catalog,
      now,
      components,
      edge,
    });
  } catch (error) {
    // A live catalogue that fails half-way falls back to the static table; sizing errors do not.
    if (override !== undefined || isStatic) throw error;
    if (isUserFacingError(error) && error.code === "INVALID_INPUT") throw error;
    const reason = isUserFacingError(error) ? error.message : "an unexpected error";
    const fallback = await staticCatalog(deps, provider, region);
    catalog = fallback.catalog;
    warn(
      `Could not read live prices from ${wording.name} (${reason}). Using the price list dated ${fallback.date} instead; prices are estimates.`,
    );
    designOptions = await buildDesignOptions({
      facts,
      requirements,
      catalog,
      now,
      components,
      edge,
    });
  }
  const priceSource = designOptions.every((option) => option.cost.source === "live")
    ? "live"
    : "static";

  const regionNote = wording.profile.regionNotes[region];
  if (regionNote !== undefined) reporter.info(say(regionNote));
  const budget = requirements.budgetMonthly;
  for (const option of designOptions) reporter.info(say(designOptionLine(option)));
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
  appWarnings(facts, components, warn);
  return { options: designOptions, priceSource, warnings, facts, requirements, ...designed };
}

async function design(deps: PhaseDeps, options: RunDesignOptions): Promise<DesignResult> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const warnings: string[] = [];
  const warn = warner(deps, warnings);

  const inputs = await readInputs(deps);
  const name = paths.environment;
  const prodPlan = name === "prod" ? undefined : await prodPlanOf(deps);
  const previous = await readArtifact("plan", paths.files.plan).catch((error: unknown) => {
    if (!(isUserFacingError(error) && error.code === "ARTIFACT_MISSING")) {
      warn(
        "The existing opscrew/plan.yaml could not be read, so OpsCrew wrote a new plan. Settings you changed in it by hand (security, infra) and the record of an earlier deployment were not kept; check them before you run `opscrew provision`.",
      );
    }
    return undefined;
  });
  if (previous !== undefined) {
    requireSameProvider(
      previous,
      inputs.requirements,
      await mayHaveResources(deps, previous),
      await knowsDeployment(deps, previous),
    );
  }
  // The plan the components are designed from, as far as the earlier plan (or a new
  // environment's block) tells; the plan's own target decides it below.
  const basis = await sharedPartsSource(paths, previous ?? { environment: options.environment });

  let ownServer = options.ownServer;
  if (inputs.requirements.provider === "own") {
    // A tunnel without a Cloudflare domain cannot be provisioned: stop before writing anything.
    const serving = await ownServerAccess(deps, ownServer, inputs.requirements);
    const access = servingAccess(serving);
    if (tunnelNeedsCloudflareDomain(inputs.requirements, access)) {
      const { message, hint } = tunnelDomainMessage();
      throw new OpsCrewError("PHASE_PRECONDITION", message, { hint });
    }
    ownServer = { ...ownServer, access, serving };
  }

  const preview = await priceOptions(deps, inputs, options.catalog, warnings, ownServer, {
    previous,
    shared: basis?.plan,
    localhost: {
      services: options.localhost,
      environment:
        options.environment === undefined ? (previous ?? {}) : { environment: options.environment },
    },
  });
  const { facts, requirements, priceSource, components } = preview;
  const designOptions = preview.options;
  const budget = requirements.budgetMonthly;
  const now = deps.clock.now();

  const chosen = await pick(designOptions, options);
  const build = chooseBuilder(
    facts,
    basis?.plan ?? previous,
    chosen.target.architecture === "arm" ? "arm64" : "amd64",
  );
  if ("refused" in build) {
    throw new OpsCrewError("INVALID_INPUT", build.refused, {
      hint: "Change app.build.builder in opscrew/plan.yaml, then run `opscrew design` again.",
    });
  }
  for (const warning of build.warnings) warn(warning);

  const [signals, scan] = await Promise.all([
    collectCodeChangeSignals(paths.root, facts).catch((): CodeChangeSignals => ({})),
    readScanReport(paths.files.scanReportJson),
  ]);
  const codeChanges = deriveCodeChanges(facts, build.builder, scan, signals);
  const planFor = (planned: Components) =>
    optionToPlan(chosen, {
      facts,
      requirements,
      now,
      codeChanges,
      signals,
      ...(previous ? { createdAt: previous.createdAt } : {}),
      ...(preview.access !== undefined ? { access: preview.access } : {}),
      ...(preview.serving !== undefined ? { serving: preview.serving } : {}),
      ...(preview.portainer !== undefined ? { portainer: preview.portainer } : {}),
      ...(preview.localhost !== undefined ? { localhost: preview.localhost } : {}),
      build,
      components: planned,
    });
  let fresh = planFor(components);
  // New cron jobs on routes the image cannot call are planned turned off, with what to do.
  const off = uncallableRouteJobs(fresh, previous);
  if (off.length > 0) {
    const cron = components.processes.cron.map((job) =>
      off.includes(job.name) ? { ...job, enabled: false } : job,
    );
    fresh = planFor({ ...components, processes: { ...components.processes, cron } });
  }
  const named = prodPlan === undefined ? fresh : environmentNames(fresh, prodPlan, name, options);
  const own = previous ? keepPlanSettings(named, previous, requirements) : named;
  // Where the shared parts come from, now that the plan's target (on this computer, where its
  // image comes from) is chosen.
  const source = await sharedPartsSource(paths, own);
  const keep =
    source === undefined ||
    previous === undefined ||
    own.environment?.deploySource.from !== "promote"
      ? []
      : await servicesToKeep(deps, previous, source, options.registry, warn);
  const kept =
    prodPlan === undefined && source === undefined
      ? own
      : environmentPlan(own, source, keep, paths);
  // SC-1307: with nothing changed the plan stays as it is, its date and price check included. After
  // a newer interview it is written anyway: its date then says the answers are in it, so the next
  // design keeps what the user edits in plan.yaml instead of taking the answers again.
  const answeredLater =
    previous !== undefined && Date.parse(requirements.answeredAt) > Date.parse(previous.updatedAt);
  const plan =
    previous !== undefined && !answeredLater && samePlan(kept, previous) ? previous : kept;
  // On the user's own server, its memory must hold this app next to the other OpsCrew apps there.
  if (chosen.target.provider === "own") {
    const memory = ownServerMemory(
      chosen.target.memoryGb * 1024,
      appMemoryMb(plan),
      (ownServer?.apps ?? []).filter((app) => app.name !== plan.app.name),
      edgeMemoryMb(edgeProxy(plan)),
    );
    if (memory?.refused !== undefined) {
      throw new OpsCrewError("PHASE_PRECONDITION", memory.refused.message, {
        hint: memory.refused.hint,
      });
    }
    if (memory?.warning !== undefined) warn(memory.warning);
  }
  if (previous) {
    for (const warning of serverChangeWarnings(previous, plan)) warn(warning);
    const owner = sqliteOwnerWarning(previous, plan);
    if (owner !== undefined) warn(owner);
  }
  if (plan.target.provider === "localhost" && preview.localhost !== undefined) {
    for (const warning of localhostImageWarnings(plan.target, preview.localhost)) warn(warning);
  }
  await requireOwnHostnames(paths, plan);
  if (plan !== previous) await writeArtifact("plan", paths.files.plan, plan);

  const planFile = toPosixRelative(paths.root, paths.files.plan);
  const onComputer = chosen.target.provider === "localhost";
  // Neither a Portainer host nor this computer is sized by OpsCrew: no memory line or headroom.
  const inPortainer = chosen.target.provider === "portainer" || onComputer;
  const ownsServer = chosen.target.provider === "own" || inPortainer;
  const cost = formatMoney(chosen.cost.monthly);
  const inBudget =
    chosen.cost.monthly.currency === budget.currency
      ? ""
      : ` (about ${formatMoney(convertMoney(chosen.cost.monthly, budget.currency))})`;
  const price = onComputer
    ? "no server cost (it runs in this computer's Docker)"
    : inPortainer
      ? "no server cost (you already run this Portainer)"
      : ownsServer
        ? "no server cost (you already pay for this server)"
        : `${cost}/month${inBudget}`;
  reporter.success(
    say(
      `${plan === previous ? `${planFile} is up to date` : `Wrote ${planFile}`}: ${chosen.title}, ${price}, ${plural(codeChanges.length, "code change")} to make.`,
    ),
  );
  const buildLines = buildStatusLines(plan, fresh.deploy).map(say);
  const supplyLines = supplyChainLines(plan);
  for (const line of buildLines) reporter.info(line);
  // The components, with each one's memory on the chosen server (SC-1308).
  const serverMb = chosen.target.memoryGb * 1024;
  const edgeMb = edgeMemoryMb(edgeProxy(plan));
  const componentLines = [
    // Copied from a source, the components are its plan's, not those designed from the code here.
    ...(source !== undefined
      ? [copiedComponentsLine(plan, source.name)]
      : [
          ...preview.lines.filter(
            (line) => !off.some((name) => line.startsWith(`Cron job ${name} (`)),
          ),
          ...(off.length > 0 ? [routeJobsOffText(off, plan)] : []),
        ]),
    ...(inPortainer
      ? []
      : [memoryText(plan, serverMb, edgeMb, ownsServer ? undefined : chosen.cost.monthly)]),
  ].map(say);
  for (const line of componentLines) reporter.info(line);
  const headroom = memoryHeadroom(serverMb, appMemoryMb(plan), edgeMb);
  if (!ownsServer && headroom.low) warn(lowHeadroomText(chosen.target.serverType, headroom.free));
  const migrations = releaseCommandNote(plan, facts);
  if (migrations?.warning) warn(migrations.text);
  else if (migrations !== undefined) reporter.info(say(migrations.text));
  for (const line of supplyLines) reporter.info(line);
  // vercel.json's routing rules become the app's additions for the server's proxy (FR-1446).
  const additions = await vercelAdditions(paths.root, plan, facts);
  const additionLines = additions.lines.map(say);
  for (const line of additionLines) reporter.info(line);
  for (const warning of additions.warnings) warn(warning);
  reporter.info(
    prodPlan === undefined
      ? "Next: run `opscrew adapt` to prepare the code in a pull request."
      : `Next: run \`opscrew provision --env ${name}\`. The code is prod's, which \`opscrew adapt\` prepares.`,
  );
  await deps.state.markPhase(
    "design",
    "ok",
    say(
      ownsServer
        ? `${chosen.id}, no server cost`
        : `${chosen.id}, ${cost}/month (${priceLabel(chosen.cost)})`,
    ),
  );
  return {
    options: designOptions,
    chosen,
    plan,
    priceSource,
    warnings,
    lines: [...buildLines, ...componentLines, ...supplyLines, ...additionLines],
  };
}

/**
 * True when two plans differ only in when they were written and when their price was read
 * (SC-1307): a design with nothing changed then leaves plan.yaml as it is.
 */
function samePlan(a: DeployPlan, b: DeployPlan): boolean {
  const undated = (plan: DeployPlan) => ({
    ...plan,
    updatedAt: "",
    cost: { ...plan.cost, asOf: "" },
  });
  return canonicalJson(undated(a)) === canonicalJson(undated(b));
}

/**
 * The fresh plan `plan` named for the environment `name`: the app name `<app>-<env>`, its own
 * workflow and infrastructure root, and its `environment` block (with the deploy source and runner
 * `opscrew env add` chose) and branch (`--branch`). An earlier plan's root, block and branch are
 * kept over these (`keepPlanSettings`).
 */
function environmentNames(
  plan: DeployPlan,
  prodPlan: DeployPlan,
  name: string,
  options: Pick<RunDesignOptions, "environment" | "branch">,
): DeployPlan {
  return {
    ...plan,
    environment: EnvironmentSchema.parse({ ...options.environment, name }),
    app: { ...plan.app, name: `${prodPlan.app.name}-${name}` },
    infra: { ...plan.infra, dir: environmentInfraDir(name) },
    cicd: {
      ...plan.cicd,
      workflowPath: environmentWorkflowPath(name),
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
    },
  };
}

/**
 * The plan of the environment `paths` belong to, validated: `plan`, with the shared parts of its
 * `source` and the services it keeps (`withSharedParts`) when it is promoted.
 * @throws OpsCrewError `INVALID_INPUT` when the result is no valid plan (for example a runner its
 * target does not take), naming the field.
 */
function environmentPlan(
  plan: DeployPlan,
  source: SharedPartsSource | undefined,
  keep: readonly PlanService[],
  paths: PhaseDeps["paths"],
): DeployPlan {
  const name = paths.environment;
  const parsed = DeployPlanSchema.safeParse(
    source === undefined ? plan : withSharedParts(plan, source.plan, keep),
  );
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew cannot design the ${name} environment: ${issue?.path.join(".") || "plan"} ${issue?.message ?? "is not valid"}. ${toPosixRelative(paths.root, paths.files.plan)} was not changed.`,
    {
      hint: `Fix the field shown above in ${toPosixRelative(paths.root, paths.files.plan)}, or change the environment's answers in ${toPosixRelative(paths.root, paths.files.requirements)}, then run \`opscrew design --env ${name}\` again.`,
    },
  );
}

/**
 * The services a promoted environment's earlier plan has and its source's plan no longer has
 * (FR-1539). They are kept while the environment does not run the source's image yet, since the
 * image it runs may still use them: GHCR's labels of the images each runs (`opscrew-<env>`, as
 * `opscrew promote` reads the source's) differ, or cannot be read (no token, no GitHub remote, a
 * refusal or a network error). Once both run the same image none is kept, so the plan no longer
 * has them and provision asks before their data is deleted. Says which, and why.
 */
async function servicesToKeep(
  deps: PhaseDeps,
  previous: DeployPlan,
  source: SharedPartsSource,
  registry: Pick<LocalRegistry, "taggedDigest"> | undefined,
  warn: (text: string) => void,
): Promise<PlanService[]> {
  const theirs = new Set(source.plan.services.map((service) => service.name));
  const dropped = previous.services.filter((service) => !theirs.has(service.name));
  if (dropped.length === 0) return [];
  const name = deps.paths.environment;
  const from = source.name;
  const one = dropped.length === 1;
  const services = `the ${one ? "service" : "services"} ${listText(dropped.map((s) => s.name))}`;
  const it = one ? "it" : "them";
  let why = `${name} does not run ${from}'s image yet`;
  try {
    const ghcr = registry ?? (await githubRegistry(deps));
    const own = await ghcr.taggedDigest(`opscrew-${name}`);
    if (own !== undefined && own === (await ghcr.taggedDigest(`opscrew-${from}`))) {
      deps.reporter.info(
        deps.redactor.redact(
          `The ${name} environment runs ${from}'s image now, so its plan drops ${services}, as ${from}'s did. \`opscrew provision --env ${name}\` removes ${it}, asking as usual before any data is deleted.`,
        ),
      );
      return [];
    }
  } catch (error) {
    // Unknown is kept: design never removes a service it cannot tell is unused.
    why = `OpsCrew cannot tell whether ${name} runs ${from}'s image yet (${reasonOf(error)})`;
  }
  warn(
    `The ${name} environment keeps ${services}, which ${from}'s plan no longer has: ${why}, and the image it runs may still use ${it}. Once \`opscrew promote --to ${name}\` has deployed ${from}'s image, the next \`opscrew design --env ${name}\` removes ${it}.`,
  );
  return dropped;
}

/**
 * The one line design says of the components a plan copied from `source`'s plan, instead of those
 * designed from the code here: its enabled services, workers and cron jobs, and its SQLite folder.
 */
function copiedComponentsLine(plan: DeployPlan, source: string): string {
  const components = [
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => `${serviceSpec(service.kind).title} ${service.version} (${service.name})`),
    ...plan.processes.workers.filter((w) => w.enabled).map((worker) => `worker ${worker.name}`),
    ...plan.processes.cron.filter((job) => job.enabled).map((job) => `cron job ${job.name}`),
    ...(plan.storage?.sqlite === undefined ? [] : [`SQLite in ${plan.storage.sqlite.dir}/`]),
  ];
  return `Components (copied from ${source}'s plan): ${components.length === 0 ? "none besides the app" : listText(components)}.`;
}

/**
 * True when an earlier provision may have left resources behind: a non-empty infrastructure state,
 * or for a Portainer target anything OpsCrew's record lists as created there (a stack apply that
 * failed half-way records what it made without an apply time in the plan).
 */
async function mayHaveResources(deps: PhaseDeps, previous: DeployPlan): Promise<boolean> {
  if (await hasState(deps.paths)) return true;
  if (previous.target.provider !== "portainer") return false;
  const created = (await readPortainerConnection(deps.paths).catch(() => undefined))?.created;
  return (
    created !== undefined &&
    (created.stacks.length > 0 || created.registryId !== undefined || created.volumes.length > 0)
  );
}

/**
 * The provider of a deployment that may still have resources: not destroyed, and either an apply
 * recorded or, with `stateExists`, resources left behind ({@link mayHaveResources}: a first apply
 * that fails half-way records nothing in the plan but keeps what it created). `undefined` when
 * nothing can be live.
 */
function liveProvider(
  plan: Pick<DeployPlan, "target" | "deployment">,
  stateExists: boolean,
): DeployProvider | undefined {
  const { deployment } = plan;
  if (deployment.destroyedAt !== undefined) return undefined;
  const applied = deployment.lastApplyAt !== undefined || stateExists;
  return applied ? plan.target.provider : undefined;
}

/**
 * True when this computer knows where the previous plan's app runs: the server's address, or for
 * a Portainer target with a recorded apply OpsCrew's record of it (`.opscrew/server.json` →
 * `portainer`; without an apply the record alone does not mean the app is deployed).
 */
async function knowsDeployment(deps: PhaseDeps, previous: DeployPlan): Promise<boolean> {
  if (previous.target.provider === "portainer") {
    if (!hasDeployment(previous)) return false;
    return (await readPortainerConnection(deps.paths).catch(() => undefined)) !== undefined;
  }
  return (await serverAddress(deps, previous)) !== undefined;
}

/** A provider's name in a sentence. */
function providerName(id: DeployProvider): string {
  if (id === "own") return "your own server";
  if (id === "portainer") return "your Portainer";
  if (id === "localhost") return "this computer";
  return providerProfile(id).displayName;
}

/**
 * Why the requested provider cannot replace the plan's (a live deployment moves only through
 * `opscrew retarget`), or `undefined` when the switch is allowed. `outcome` is the message's last
 * sentence: what happened (or will happen) to `opscrew/plan.yaml`. `hasServer` says whether
 * OpsCrew knows the deployed server's address (`serverAddress`; a move starts from it). A plan that
 * records an applied deployment is deployed even when this computer lacks the address (a fresh
 * clone): the move or the teardown then runs where the server was provisioned, never a second
 * `opscrew provision` here (it would create another server).
 */
function providerSwitchBlock(
  previous: DeployPlan,
  requirements: Requirements,
  stateExists: boolean,
  outcome: string,
  hasServer: boolean,
): { message: string; hint: string } | undefined {
  const current = liveProvider(previous, stateExists);
  const requested: DeployProvider = requirements.provider ?? "hetzner";
  if (current === undefined || requested === current) return undefined;
  const from = providerName(current);
  const to = providerName(requested);
  const deployed = hasServer || hasDeployment(previous);
  const owned = current === "own" || current === "portainer" || current === "localhost";
  const where = deployed
    ? `Your app is deployed ${current === "portainer" ? "in" : "on"} ${from}`
    : `An earlier apply may have created resources ${owned ? "for" : "at"} ${from}`;
  const retarget = `\`opscrew retarget --to ${requested}\``;
  const keep = `or keep ${from} by answering \`opscrew interview\` again.`;
  const portainer = current === "portainer" || requested === "portainer";
  const localhost = current === "localhost";
  let hint: string;
  if (portainer || localhost || current === "own" || requested === "own") {
    // `opscrew retarget` does not move an app to or from a Portainer, a server the user owns or
    // this computer.
    const what = portainer
      ? "your Portainer"
      : localhost
        ? "this computer"
        : "a server you already own";
    const there = deployed && !hasServer ? " on the computer that provisioned it" : "";
    hint = `OpsCrew cannot move an app to or from ${what}. Run \`opscrew destroy\`${there} first and then \`opscrew design\`, ${keep}`;
  } else if (hasServer) {
    hint = `Run ${retarget} to move the deployment with its data, or \`opscrew destroy\` first and then \`opscrew design\`, ${keep}`;
  } else if (deployed) {
    hint = `OpsCrew does not know the server's address on this computer: on the computer that provisioned it (its .opscrew/ folder holds the address), run ${retarget} to move the deployment with its data, or \`opscrew destroy\` there first and then \`opscrew design\`, ${keep}`;
  } else {
    // A failed first apply here: a move starts from a deployed server, so it is finished first.
    hint = `Run \`opscrew provision\` to finish the deployment on ${from} and then ${retarget} to move it with its data, or \`opscrew destroy\` first and then \`opscrew design\`, ${keep}`;
  }
  return {
    message: `${where}, but opscrew/requirements.yaml now asks for ${to}. ${outcome}.`,
    hint,
  };
}

/**
 * Stops with `PHASE_PRECONDITION` before anything is written when the plan has a live deployment
 * (see {@link liveProvider}) and the requirements ask for another provider. A destroyed
 * or never-applied plan may switch.
 */
function requireSameProvider(
  previous: DeployPlan,
  requirements: Requirements,
  stateExists: boolean,
  hasServer: boolean,
): void {
  const block = providerSwitchBlock(
    previous,
    requirements,
    stateExists,
    "opscrew/plan.yaml was not changed",
    hasServer,
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
  const factsDir = normalizeAppDir(facts.appDir);
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
 * `deployment`, `approvals`, `security`, `infra`, `environment`, `cicd.branch`, `app.maxBodyMb`,
 * the server's proxy (`target.edge`, between server targets) and the status of code changes that
 * are still the same change (id, kind and path). `security.httpAllowedFrom` is re-derived when the
 * DNS proxy setting changed, so a Cloudflare-only allow-list never outlives the Cloudflare proxy.
 * `portainer` is kept exactly as it was, with the Cloudflare zone learned for it (`dns.zone`)
 * while the app's domain is still on Cloudflare inside that zone. A Portainer subdomain the new
 * DNS settings no longer allow stops design before plan.yaml changes. Image retention is kept, and
 * signing and deploy tags too unless the interview was answered after the previous plan was
 * written. The deploy settings come from {@link keptDeploy}. Of the app, each variable that is
 * still there keeps its `secret` (secret if either plan says so), `source` and `optional`, except
 * the variables what runs fills in either plan (`serviceFilledNames`), which follow it, and one it
 * filled that nothing fills now, which is the user's again; and the user's own
 * Dockerfile they chose (`app.build.chosen: user`) keeps its path. The components (workers, cron,
 * services, storage, the web process's memory) are already the user's: `fresh` was made from
 * `designComponents` with this previous plan.
 */
function keepPlanSettings(
  fresh: DeployPlan,
  previous: DeployPlan,
  requirements: Requirements,
): DeployPlan {
  const key = (change: DeployPlan["codeChanges"][number]) =>
    `${change.id}\u0000${change.kind}\u0000${change.path}`;
  const statuses = new Map(previous.codeChanges.map((change) => [key(change), change.status]));
  const variables = new Map(previous.app.env.map((variable) => [variable.name, variable]));
  const userDockerfile =
    fresh.app.build?.chosen === "user" && fresh.app.build.builder === "own-dockerfile";
  const { httpAllowedFrom, ...security } = previous.security;
  const zone = previous.dns.zone;
  const sameZone =
    fresh.dns.zone === undefined &&
    zone !== undefined &&
    fresh.dns.provider === "cloudflare" &&
    (fresh.dns.domain === zone || (fresh.dns.domain ?? "").endsWith(`.${zone}`));
  // The interview's answers on signing and deploy tags replace plan.yaml's only when newer.
  const answeredLater = Date.parse(requirements.answeredAt) > Date.parse(previous.updatedAt);
  const filledBefore = serviceFilledNames(previous);
  const filledNow = serviceFilledNames(fresh);
  const kept = DeployPlanSchema.safeParse({
    ...fresh,
    ...("edge" in fresh.target && "edge" in previous.target
      ? { target: { ...fresh.target, edge: previous.target.edge } }
      : {}),
    app: {
      ...fresh.app,
      maxBodyMb: previous.app.maxBodyMb,
      ...(userDockerfile ? { dockerfile: previous.app.dockerfile } : {}),
      env: fresh.app.env.map((variable) => {
        const before = variables.get(variable.name);
        if (before === undefined) return variable;
        // A service turned on or off decides the variables OpsCrew fills from it.
        // What runs decides the variables it fills, and one it filled that nothing fills now (a
        // service turned off) is the user's again.
        const filled = filledBefore.has(variable.name) || filledNow.has(variable.name);
        const unfilled = before.source === "derived" && variable.source !== "derived";
        if (filled || unfilled) return { ...variable, secret: before.secret || variable.secret };
        // Fail closed: a name now detected as secret stays secret, never a build argument.
        return { ...before, secret: before.secret || variable.secret };
      }),
    },
    ...(sameZone ? { dns: { ...fresh.dns, zone } } : {}),
    codeChanges: fresh.codeChanges.map((change) => ({
      ...change,
      status: statuses.get(key(change)) ?? change.status,
    })),
    infra: previous.infra,
    ...(previous.environment === undefined ? {} : { environment: previous.environment }),
    security: previous.dns.proxied === fresh.dns.proxied ? previous.security : security,
    approvals: previous.approvals,
    deployment: previous.deployment,
    ...(previous.portainer === undefined ? {} : { portainer: previous.portainer }),
    deploy: keptDeploy(fresh, previous),
    cicd: {
      ...fresh.cicd,
      // The branch it follows, set by `opscrew env add|set --branch` or by an earlier design.
      branch: previous.cicd.branch,
      imageRetention: previous.cicd.imageRetention,
      ...(answeredLater ? {} : { deployTags: previous.cicd.deployTags }),
    },
    supplyChain: answeredLater ? fresh.supplyChain : previous.supplyChain,
  });
  if (kept.success) return kept.data;
  const portainer = previous.portainer;
  const issue = kept.error.issues[0];
  const field = issue?.path.join(".") || "plan";
  // Portainer's subdomain needs the app's domain on Cloudflare, in the zone it was learned for.
  const offCloudflare = field === "portainer.access" || field === "dns.zone";
  if (portainer?.access === "subdomain" && offCloudflare) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Portainer is served on ${portainer.hostname ?? "a subdomain"} through Cloudflare, but the new requirements no longer put the app's domain on Cloudflare${zone === undefined ? "" : ` in the zone ${zone}`}, so OpsCrew cannot keep it. plan.yaml was not changed.`,
      {
        hint: "Keep the domain on Cloudflare when you run `opscrew interview`, or turn Portainer off with `opscrew portainer disable` first, then run `opscrew design` again.",
      },
    );
  }
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew cannot keep the settings of the current plan with the new design: ${field} ${issue?.message ?? "is not valid"}. plan.yaml was not changed.`,
    {
      hint: "Change your answers with `opscrew interview`, or fix the field shown above in opscrew/plan.yaml, then run `opscrew design` again.",
    },
  );
}

/**
 * Plain-English warnings when the new plan moves or resizes a server that already exists. A
 * destroyed deployment, or one on another provider (only possible once destroyed), has no server
 * to move.
 */
function serverChangeWarnings(previous: DeployPlan, plan: DeployPlan): string[] {
  const { deployment } = previous;
  const deployed = deployment.lastApplyAt !== undefined || deployment.lastPlanHash !== undefined;
  if (!deployed || deployment.destroyedAt !== undefined) return [];
  const before = previous.target;
  const after = plan.target;
  if (before.provider !== after.provider) return [];
  // A server the user owns (or a Portainer, or this computer) is never moved or resized by OpsCrew.
  if (before.provider === "own" || after.provider === "own") return [];
  if (before.provider === "portainer" || after.provider === "portainer") return [];
  if (before.provider === "localhost" || after.provider === "localhost") return [];
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
