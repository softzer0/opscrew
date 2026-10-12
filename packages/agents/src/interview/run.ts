import { ensureStateDir } from "@opscrew/core";
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
import { answersToRequirements } from "./answers";
import { buildQuestions, describesRoot, type InterviewAnswers } from "./questions";

export interface InterviewOptions {
  /** Asks the questions interactively and returns the answers keyed by question id. */
  ask?: (questions: Question[]) => Promise<InterviewAnswers>;
  /** Answers given up front (for example from `--answers <file>`); `ask` is then not called. */
  answers?: InterviewAnswers;
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
 * The interview phase: builds the questions that cannot be inferred (previous answers pre-filled),
 * takes answers from `options.answers` or `options.ask`, validates them into requirements, writes
 * `opscrew/requirements.yaml` and records the phase. In a repository with several apps it asks
 * which one to deploy (`appDir`) and re-runs the deterministic analysis for the chosen app. Missing or invalid answers throw
 * `OpsCrewError("INVALID_INPUT")` listing them.
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

    const requirements = answersToRequirements(answers, {
      now: deps.clock.now(),
      facts,
      appCandidates,
      ...context,
      ...(previous !== undefined ? { previous } : {}),
    });
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
    await writeArtifact("requirements", paths.files.requirements, requirements);
    reporter.success("Wrote opscrew/requirements.yaml.");
    const budget = requirements.budgetMonthly;
    await deps.state.markPhase(
      "interview",
      "ok",
      `${requirements.expectedMonthlyUsers} users, ${budget.amount} ${budget.currency}/month, ${requirements.region}`,
    );
    return { requirements, questions, reanalyzed };
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
