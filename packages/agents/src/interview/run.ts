import { ensureStateDir, toPosixRelative } from "@opscrew/core";
import { detectProject, detectProjectDetails, normalizeAppDir } from "@opscrew/detect";
import {
  type ProjectFacts,
  type Question,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { runAnalyze } from "../analyze";
import type { PhaseDeps } from "../context";
import { providerFromTokens } from "../providers";
import { type OwnServerConnection, readOwnServer, setAsideServerAddresses } from "../shared";
import { answersToRequirements } from "./answers";
import {
  answersToOwnServer,
  buildServerQuestions,
  hasServerAnswers,
  type OwnServerAnswers,
  recordOwnServerAnswers,
  type ServerQuestion,
  splitServerAnswers,
} from "./own-server";
import { buildQuestions, describesRoot, type InterviewAnswers } from "./questions";

export interface InterviewOptions {
  /** Asks the questions interactively and returns the answers keyed by question id. */
  ask?: (questions: Question[]) => Promise<InterviewAnswers>;
  /**
   * Asks the follow-up questions for a server the user already has (`provider: own`) and returns
   * the answers keyed by question id (`server.host`, …). Called after `ask`, only for `own` and
   * only when `answers` holds no server answers.
   */
  askServer?: (questions: ServerQuestion[]) => Promise<InterviewAnswers>;
  /**
   * Answers given up front (for example from `--answers <file>`); `ask` is then not called. May
   * include the server follow-ups as `server.host` keys or a nested `server:` mapping.
   */
  answers?: InterviewAnswers;
  /** Whether the internet reaches the server, as inspection suggests (the reachability default). */
  suggestedReachable?: boolean;
}

export interface InterviewResult {
  requirements: Requirements;
  /** The questions that applied to this project (asked or answered from the file). */
  questions: Question[];
  /**
   * True when the chosen app (`appDir`) differed from the app `opscrew/architecture.json`
   * described, so the deterministic analysis was re-run for it (without the AI review).
   */
  reanalyzed: boolean;
  /**
   * For a server the user already has: how OpsCrew reaches it, saved in `.opscrew/server.json`
   * (never in `opscrew/requirements.yaml`).
   */
  ownServer?: OwnServerAnswers;
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** Facts from `opscrew/architecture.json`, or fresh deterministic detection when it is unusable. */
async function loadFacts(deps: PhaseDeps): Promise<ProjectFacts> {
  try {
    return (await readArtifact("architecture", deps.paths.files.architecture)).facts;
  } catch (error) {
    if (errorCode(error) === "ARTIFACT_MISSING") {
      deps.reporter.info(
        "No opscrew/architecture.json yet, so OpsCrew detected the project again. Run `opscrew analyze` for the full analysis.",
      );
    } else if (errorCode(error) === "ARTIFACT_INVALID") {
      deps.reporter.warn(
        "opscrew/architecture.json is not valid, so OpsCrew detected the project again. Run `opscrew analyze` to rewrite it.",
      );
    } else {
      throw error;
    }
    return detectProject(deps.paths.root);
  }
}

/**
 * Deployable app folders when the facts describe the repository root of a monorepo with several
 * apps; empty otherwise (or when detection fails, which analyze reports).
 */
async function appCandidatesFor(deps: PhaseDeps, facts: ProjectFacts): Promise<string[]> {
  if (!describesRoot(facts)) return [];
  try {
    return (await detectProjectDetails(deps.paths.root)).appCandidates;
  } catch {
    return [];
  }
}

/** Previous answers from `opscrew/requirements.yaml`, if the file exists and is valid. */
async function loadPrevious(deps: PhaseDeps): Promise<Requirements | undefined> {
  try {
    return await readArtifact("requirements", deps.paths.files.requirements);
  } catch (error) {
    if (errorCode(error) === "ARTIFACT_MISSING") return undefined;
    if (errorCode(error) === "ARTIFACT_INVALID") {
      deps.reporter.warn(
        "The existing opscrew/requirements.yaml is not valid; its answers are not reused.",
      );
      return undefined;
    }
    throw error;
  }
}

/**
 * How OpsCrew reached the user's own server so far (`.opscrew/server.json` → `own`). A damaged
 * file gives no previous answers and `damaged: true`; it is set aside (never deleted) only once
 * the new answers are valid.
 */
async function loadPreviousServer(
  deps: PhaseDeps,
): Promise<{ previous?: OwnServerConnection; damaged?: true }> {
  try {
    const previous = await readOwnServer(deps.paths);
    return previous === undefined ? {} : { previous };
  } catch (error) {
    if (errorCode(error) === "ARTIFACT_INVALID") return { damaged: true };
    throw error;
  }
}

/**
 * The interview phase: builds the questions that cannot be inferred (previous answers pre-filled),
 * takes answers from `options.answers` or `options.ask`, validates them into requirements, writes
 * `opscrew/requirements.yaml` and records the phase. In a repository with several apps it asks
 * which one to deploy (`appDir`) and re-runs the deterministic analysis for the chosen app. For a
 * server the user already has (`provider: own`) it takes the follow-ups (`server.*`) from the
 * answers or `options.askServer` and saves them in `.opscrew/server.json`, never in
 * `opscrew/requirements.yaml`. Missing or invalid answers throw `OpsCrewError("INVALID_INPUT")`
 * listing them; nothing is written then.
 */
export async function runInterview(
  deps: PhaseDeps,
  options: InterviewOptions = {},
): Promise<InterviewResult> {
  const { reporter, paths } = deps;
  try {
    await ensureStateDir(paths);
    reporter.step("Collecting your deployment requirements");
    const facts = await loadFacts(deps);
    const previous = await loadPrevious(deps);
    const appCandidates = await appCandidatesFor(deps, facts);
    const inferredProvider = providerFromTokens(deps.env);
    const context = inferredProvider !== undefined ? { inferredProvider } : {};
    const questions = buildQuestions(facts, previous, appCandidates, context);
    if (previous !== undefined) reporter.info("Your previous answers are pre-filled.");

    let answers: InterviewAnswers = {};
    if (options.answers !== undefined) answers = options.answers;
    else if (options.ask !== undefined) answers = await options.ask(questions);
    let split = splitServerAnswers(answers);

    const requirements = answersToRequirements(split.rest, {
      now: deps.clock.now(),
      facts,
      appCandidates,
      ...context,
      ...(previous !== undefined ? { previous } : {}),
    });
    let ownServer: OwnServerAnswers | undefined;
    let damagedRecord = false;
    if (requirements.provider === "own") {
      const { damaged, ...loaded } = await loadPreviousServer(deps);
      damagedRecord = damaged === true;
      if (damagedRecord) {
        reporter.warn(
          "OpsCrew's record of your server (.opscrew/server.json) is damaged, so your earlier answers are not pre-filled.",
        );
      }
      const serverContext = {
        ...loaded,
        ...(options.suggestedReachable !== undefined
          ? { suggestedReachable: options.suggestedReachable }
          : {}),
        // Without a domain on Cloudflare the site can only be served with DNS only.
        cloudflareDomain:
          requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined,
      };
      if (!hasServerAnswers(split) && options.askServer !== undefined) {
        split = splitServerAnswers(await options.askServer(buildServerQuestions(serverContext)));
      }
      ownServer = answersToOwnServer(split, serverContext);
    } else if (hasServerAnswers(split)) {
      reporter.warn(
        "The answers about a server you already have (server.*) were ignored, because the app does not run on your own server.",
      );
    }
    // The analysis must describe the chosen app. Re-run it before saving the answers, so an app
    // folder detection rejects is never written to requirements.yaml.
    const reanalyzed =
      requirements.appDir !== undefined &&
      normalizeAppDir(requirements.appDir) !== normalizeAppDir(facts.appDir ?? ".");
    if (reanalyzed && requirements.appDir !== undefined) {
      reporter.info(`Analysing ${requirements.appDir} again, the app you chose to deploy.`);
      await runAnalyze(deps, { ai: false, appDir: requirements.appDir });
      reporter.info(
        `opscrew/architecture.json now describes ${requirements.appDir}. The Analyst's AI review was not re-run; run \`opscrew analyze\` to add it.`,
      );
    }
    if (ownServer !== undefined) {
      if (damagedRecord) {
        const copy = await setAsideServerAddresses(paths);
        if (copy !== undefined) {
          reporter.warn(
            `Kept the damaged record as ${toPosixRelative(paths.root, copy)} and started a new one. OpsCrew asks you to confirm your server's host key again when it next connects.`,
          );
        }
      }
      // Connection details stay on this computer: never in requirements.yaml.
      await recordOwnServerAnswers(paths, ownServer);
      reporter.info(
        "Saved how to reach your server in .opscrew/server.json, on this computer only.",
      );
    }
    await writeArtifact("requirements", paths.files.requirements, requirements);
    reporter.success("Wrote opscrew/requirements.yaml.");
    const budget = requirements.budgetMonthly;
    const where =
      requirements.provider === "own"
        ? ", your own server"
        : requirements.region === undefined
          ? ""
          : `, ${requirements.region}`;
    await deps.state.markPhase(
      "interview",
      "ok",
      `${requirements.expectedMonthlyUsers} users, ${budget.amount} ${budget.currency}/month${where}`,
    );
    return { requirements, questions, reanalyzed, ...(ownServer ? { ownServer } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await deps.state.markPhase(
        "interview",
        "failed",
        deps.redactor.redact(message).slice(0, 300),
      );
    } catch {
      // Keep the original error.
    }
    throw error;
  }
}
