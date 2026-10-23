import { join } from "node:path";
import {
  ensureStateDir,
  errorMessage,
  exists,
  type ProjectPaths,
  toPosixRelative,
} from "@opscrew/core";
import { detectProject, detectProjectDetails, normalizeAppDir } from "@opscrew/detect";
import {
  isServerlessProvider,
  type ProjectFacts,
  type Question,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { runAnalyze } from "../analyze";
import type { PhaseDeps } from "../context";
import { serverlessTargetsFor } from "../design/serverless";
import { defaultBranchOf, remoteEnvironmentBranches } from "../environments/branches";
import { setupNote } from "../environments/setup";
import { PORTAINER_TOKEN_VAR, providerFromTokens } from "../providers";
import {
  gitClient,
  hidePortainerAddress,
  type OwnServerConnection,
  readOwnServer,
  readPortainerConnection,
  serverlessName,
  setAsideServerAddresses,
} from "../shared";
import { runPhase } from "../shared/phase-status";
import { answersToRequirements } from "./answers";
import {
  applyComponentAnswers,
  buildComponentQuestions,
  type ComponentQuestion,
  hasComponentAnswers,
  hostedAdditions,
  splitComponentAnswers,
} from "./components";
import { hasFollowUps, splitFollowUps } from "./follow-ups";
import {
  answersToOwnServer,
  buildServerQuestions,
  type OwnServerAnswers,
  recordOwnServerAnswers,
  SERVER_FIELDS,
  type ServerQuestion,
} from "./own-server";
import {
  answersToPortainer,
  buildPortainerQuestions,
  PORTAINER_FIELDS,
  type PortainerAnswers,
  type PortainerAnswersGiven,
  type PortainerContext,
  type PortainerInterviewOptions,
  type PortainerQuestion,
  portainerUrlAnswer,
  reachPortainer,
  recordPortainerAnswers,
} from "./portainer";
import {
  buildQuestions,
  describesRoot,
  type InterviewAnswers,
  signingPublicLog,
} from "./questions";

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
   * Asks the questions about the app's components (keep each hosted service, each worker's
   * command when no convention gives one) and returns the answers keyed by question id
   * (`keepExternalServices.mongodb`, `workerCommands.bullmq`). Called after `ask`, so the hosted
   * services' questions can say what a bigger server would cost; only when `answers` holds none.
   */
  askComponents?: (questions: ComponentQuestion[]) => Promise<InterviewAnswers>;
  /**
   * Answers given up front (for example from `--answers <file>`); `ask` is then not called. May
   * include the server follow-ups as `server.host` keys or a nested `server:` mapping, and the
   * component answers as `keepExternalServices.<kind>` and `workerCommands.<worker>` keys or
   * nested mappings.
   */
  answers?: InterviewAnswers;
  /** Whether the internet reaches the server, as inspection suggests (the reachability default). */
  suggestedReachable?: boolean;
  /**
   * Asks the follow-up questions for an existing Portainer (`provider: portainer`) and returns the
   * answers keyed by question id (`portainer.url`, …). Called twice, only when `answers` holds no
   * Portainer answers: first for the address, then (once the certificate is confirmed and
   * Portainer listed its environments) for the rest.
   */
  askPortainer?: (questions: PortainerQuestion[]) => Promise<InterviewAnswers>;
  /**
   * How the interview reaches an existing Portainer: the adapter, the certificate confirmation
   * (the user's, never a model's) or a fingerprint given up front. The token comes only from
   * `PORTAINER_API_KEY`.
   */
  portainer?: PortainerInterviewOptions;
  /**
   * Whether the GitHub repository is private, when the caller knows it: the signing question says
   * what a private repository makes public, and without it says so conditionally.
   */
  repositoryPrivate?: boolean;
}

/** FR-1229: image retention is on by default and not asked; the interview shows it. */
export const IMAGE_RETENTION_NOTE =
  "After each healthy deploy OpsCrew keeps the newest 10 images in GitHub's container registry and deletes older ones, never the running or the previous one. To keep more, or to keep them all, change cicd.imageRetention in opscrew/plan.yaml after `opscrew design`.";

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
  /**
   * For an existing Portainer: its address, pinned certificate, environment and the redeploy and
   * web modes, saved in `.opscrew/server.json` (never in `opscrew/requirements.yaml`; never the
   * token).
   */
  portainer?: PortainerAnswers;
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

/**
 * The previous answers with what a readable `opscrew/plan.yaml` sets: the plan's bucket, always,
 * since design never moves it for an answer (`objectStorage` its provider, and
 * `keepExternalServices.s3` `false` unless answered); and signing and deploy tags when the plan
 * was written after those answers (the user may have changed them there since). The same order
 * rule as design's: answers newer than the plan replace its settings at the next design, so they
 * win here too. The interview's defaults and unanswered values start from this.
 */
export async function withPlanSettings(
  paths: ProjectPaths,
  answers: Requirements,
): Promise<Requirements> {
  const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
  if (plan === undefined) return answers;
  const bucket = plan.storage?.objectStorage;
  const previous: Requirements =
    bucket === undefined
      ? answers
      : {
          ...answers,
          keepExternalServices: { s3: false, ...answers.keepExternalServices },
          objectStorage: bucket.provider,
        };
  if (Date.parse(previous.answeredAt) > Date.parse(plan.updatedAt)) return previous;
  const { enabled, release } = plan.cicd.deployTags;
  return {
    ...previous,
    signImages: plan.supplyChain.sign,
    deployTags: !enabled ? "off" : release ? "tag-and-release" : "tag",
  };
}

/**
 * Previous answers from `opscrew/requirements.yaml`, if the file exists and is valid, with the
 * plan's signing and deploy tags ({@link withPlanSettings}).
 */
async function loadPrevious(deps: PhaseDeps): Promise<Requirements | undefined> {
  try {
    const previous = await readArtifact("requirements", deps.paths.files.requirements);
    return await withPlanSettings(deps.paths, previous);
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
 * The follow-ups for an existing Portainer: the address (asked first when interactive), the
 * certificate confirmed and the environments listed through `options.portainer`, then the rest.
 * Nothing is written here.
 */
export async function portainerAnswers(
  deps: PhaseDeps,
  options: Pick<InterviewOptions, "askPortainer" | "portainer">,
  given: PortainerAnswersGiven,
  context: PortainerContext,
): Promise<PortainerAnswers> {
  let split = given;
  const ask = hasFollowUps(split) ? undefined : options.askPortainer;
  const merge = (answers: InterviewAnswers) => {
    const more = splitFollowUps(answers, "portainer", PORTAINER_FIELDS);
    split = {
      values: { ...split.values, ...more.values },
      unknown: [...split.unknown, ...more.unknown],
      rest: split.rest,
    };
  };
  if (ask !== undefined) {
    merge(await ask(buildPortainerQuestions(context).filter((q) => q.id === "portainer.url")));
  }
  const url = portainerUrlAnswer(split, context);
  // Before anything reaches Portainer, so no output, error or audit entry shows its address.
  hidePortainerAddress(deps.redactor, url);
  const token = deps.env[PORTAINER_TOKEN_VAR]?.trim();
  if (token !== undefined && token !== "") deps.redactor.addLiteral(token, PORTAINER_TOKEN_VAR);
  const reached = await reachPortainer(url, token, context, options.portainer);
  const listed = { ...context, url, environments: reached.environments };
  if (ask !== undefined) {
    merge(await ask(buildPortainerQuestions(listed).filter((q) => q.id !== "portainer.url")));
  }
  return answersToPortainer(split, {
    ...listed,
    url,
    ...(reached.certFingerprint !== undefined ? { certFingerprint: reached.certFingerprint } : {}),
  });
}

/**
 * While prod is the app's only environment: both setups of FR-1537 with their commands
 * (`setupNote`), when the repository on GitHub has branches named like dev or staging. The
 * environments are added once prod is designed, so the choice is made in `opscrew env add`. Says
 * so and proposes nothing when git cannot read the remote's branches.
 */
async function environmentSetupNote(
  deps: PhaseDeps,
  facts: ProjectFacts,
): Promise<string | undefined> {
  // Another environment's files are under opscrew/environments/ (no plan is read here).
  if (await exists(join(deps.paths.artefactsDir, "environments"))) return undefined;
  try {
    const matches = await remoteEnvironmentBranches(gitClient(deps));
    // The branch design gives prod.
    return setupNote(matches, defaultBranchOf(facts));
  } catch (error) {
    deps.reporter.warn(
      `OpsCrew could not read your repository's branches on GitHub, so it proposes no setup of environments: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * The interview phase: builds the questions that cannot be inferred (previous answers pre-filled),
 * takes answers from `options.answers` or `options.ask`, validates them into requirements, writes
 * `opscrew/requirements.yaml` and records the phase. In a repository with several apps it asks
 * which one to deploy (`appDir`) and re-runs the deterministic analysis for the chosen app. For a
 * server the user already has (`provider: own`) it takes the follow-ups (`server.*`) from the
 * answers or `options.askServer` and saves them in `.opscrew/server.json`, never in
 * `opscrew/requirements.yaml`. For an existing Portainer (`provider: portainer`) it takes the
 * follow-ups (`portainer.*`) from the answers or `options.askPortainer`, confirms Portainer's
 * certificate and lists its environments through `options.portainer`, and saves them in
 * `.opscrew/server.json` (never the token). The questions about the app's components (each hosted
 * service, each worker's command when no convention gives it) come from the answers or
 * `options.askComponents`. Missing or invalid answers throw `OpsCrewError("INVALID_INPUT")`
 * listing them; nothing is written then.
 */
export async function runInterview(
  deps: PhaseDeps,
  options: InterviewOptions = {},
): Promise<InterviewResult> {
  const { reporter, paths } = deps;
  return runPhase(deps, "interview", async () => {
    await ensureStateDir(paths);
    reporter.step("Collecting your deployment requirements");
    const facts = await loadFacts(deps);
    const previous = await loadPrevious(deps);
    const appCandidates = await appCandidatesFor(deps, facts);
    const inferredProvider = providerFromTokens(deps.env);
    // Offered where they fit the app, as design will check them.
    const serverless = await serverlessTargetsFor(
      paths.root,
      facts,
      previous?.keepExternalServices ?? {},
    );
    const context = {
      ...(inferredProvider !== undefined ? { inferredProvider } : {}),
      ...(options.repositoryPrivate !== undefined
        ? { repositoryPrivate: options.repositoryPrivate }
        : {}),
      ...(serverless.length > 0 ? { serverless } : {}),
    };
    const questions = buildQuestions(facts, previous, appCandidates, context);
    if (previous !== undefined) reporter.info("Your previous answers are pre-filled.");

    let answers: InterviewAnswers = {};
    if (options.answers !== undefined) answers = options.answers;
    else if (options.ask !== undefined) answers = await options.ask(questions);
    let split = splitFollowUps(answers, "server", SERVER_FIELDS);
    const portainerSplit = splitFollowUps(split.rest, "portainer", PORTAINER_FIELDS);
    let componentSplit = splitComponentAnswers(portainerSplit.rest, facts);

    let requirements = answersToRequirements(componentSplit.rest, {
      now: deps.clock.now(),
      facts,
      appCandidates,
      ...context,
      ...(previous !== undefined ? { previous } : {}),
    });
    // Asked once the provider and region are known: a hosted service's question names the price
    // of the server running it would need.
    if (!hasComponentAnswers(componentSplit) && options.askComponents !== undefined) {
      const questions = buildComponentQuestions(
        facts,
        requirements,
        await hostedAdditions(deps, facts, requirements),
      );
      if (questions.length > 0) {
        componentSplit = splitComponentAnswers(await options.askComponents(questions), facts);
      }
    }
    requirements = applyComponentAnswers(requirements, componentSplit);
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
        // Served through the tunnel or the proxy it must fit Cloudflare's free certificate.
        ...(requirements.domain !== undefined ? { domain: requirements.domain } : {}),
      };
      if (!hasFollowUps(split) && options.askServer !== undefined) {
        split = splitFollowUps(
          await options.askServer(buildServerQuestions(serverContext)),
          "server",
          SERVER_FIELDS,
        );
      }
      ownServer = answersToOwnServer(split, serverContext);
    } else if (hasFollowUps(split)) {
      reporter.warn(
        "The answers about a server you already have (server.*) were ignored, because the app does not run on your own server.",
      );
    }
    let portainer: PortainerAnswers | undefined;
    if (requirements.provider === "portainer") {
      // A damaged record stops here: it lists what OpsCrew created in Portainer, never set aside.
      const previous = await readPortainerConnection(paths);
      portainer = await portainerAnswers(deps, options, portainerSplit, {
        ...(previous !== undefined ? { previous } : {}),
        cloudflareDomain:
          requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined,
        ...(requirements.domain !== undefined ? { domain: requirements.domain } : {}),
      });
    } else if (hasFollowUps(portainerSplit)) {
      reporter.warn(
        "The answers about an existing Portainer (portainer.*) were ignored, because the app does not run in your Portainer.",
      );
    }
    // The analysis must describe the chosen app. Re-run it before saving the answers, so an app
    // folder detection rejects is never written to requirements.yaml.
    const reanalyzed =
      requirements.appDir !== undefined &&
      normalizeAppDir(requirements.appDir) !== normalizeAppDir(facts.appDir);
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
    if (portainer !== undefined) {
      // The address and environment stay on this computer; the token is never saved.
      await recordPortainerAnswers(paths, portainer);
      reporter.info(
        `Saved how to reach your Portainer in .opscrew/server.json, on this computer only. The access token stays in ${PORTAINER_TOKEN_VAR} and is never saved.`,
      );
    }
    await writeArtifact("requirements", paths.files.requirements, requirements);
    reporter.success("Wrote opscrew/requirements.yaml.");
    const publicLog = signingPublicLog(options.repositoryPrivate);
    if (requirements.signImages === true && publicLog !== undefined) reporter.warn(publicLog);
    reporter.info(IMAGE_RETENTION_NOTE);
    const setup = await environmentSetupNote(deps, facts);
    if (setup !== undefined) reporter.info(setup);
    const budget = requirements.budgetMonthly;
    const where =
      requirements.provider === "own"
        ? ", your own server"
        : requirements.provider === "portainer"
          ? ", your Portainer"
          : isServerlessProvider(requirements.provider)
            ? `, ${serverlessName(requirements.provider)}`
            : requirements.region === undefined
              ? ""
              : `, ${requirements.region}`;
    await deps.state.markPhase(
      "interview",
      "ok",
      `${requirements.expectedMonthlyUsers} users, ${budget.amount} ${budget.currency}/month${where}`,
    );
    return {
      requirements,
      questions,
      reanalyzed,
      ...(ownServer ? { ownServer } : {}),
      ...(portainer ? { portainer } : {}),
    };
  });
}
