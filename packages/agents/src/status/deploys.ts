/**
 * What `status` shows of an environment's deploys (feature 019, FR-1913, US5 #4, US6 #1), read
 * when the command runs and never stored: the version it runs and the one before it, with their
 * commits from GitHub, and whether its deploys are paused (`OPSCREW_DEPLOY_PAUSED`, with this
 * computer's `rollback.json` when GitHub can't be read).
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { errorText, isUserFacingError, OpsCrewError, readTextIfExists } from "@opscrew/core";
import { appDir } from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { followsBranch } from "../environments/branches";
import { commandFlags } from "../environments/choice";
import { ghcrReadCredential } from "../localhost/image";
import { appFolder } from "../localhost/services";
import type { AppImage } from "../promote/image";
import type { PromoteGitHubApi } from "../promote/types";
import type { VersionView } from "../rollback/types";
import { describeImage } from "../rollback/versions";
import { gitClient, githubClientFromToken, githubCoordinates, readValidJson } from "../shared";
import { type DeployPause, deployPauseOf, pinnedText } from "../shared/deploy-pause";
import { codeOf } from "../shared/errors";
import { ghcrPackage } from "../shared/github";
import { appServerCommand, sections } from "./resources";
import type { ComponentStatusOptions } from "./run";

/** The environment's deploys as `status` read them (`deploys` in `opscrew_status`'s data). */
export interface DeployState {
  /** The version it runs. */
  running?: VersionView;
  /** The version it ran before, where its deploy switches back to. */
  previous?: VersionView;
  /** Its entry in `OPSCREW_DEPLOY_PAUSED`; absent when its deploys are on. */
  paused?: DeployPause;
}

/** The mark before each part of the server read's output. */
const MARK = "==opscrew-deploys:";

/** An image reference as the deploy writes it into `.env` (`APP_IMAGE=`). */
const IMAGE = /^[A-Za-z0-9._/:@-]+$/;

/** The digest of an image reference pinned by digest. */
const DIGEST = /@(sha256:[0-9a-f]{64})$/;

/** What the repository's GitHub can't be read without. */
const NO_TOKEN = "No GitHub token is available (set GITHUB_TOKEN or run `gh auth login`).";

/** The images a target holds: the one it runs and the one before, and since when it runs it. */
interface Held {
  running?: string;
  previous?: string;
  /** When `.env` was written, at the switch (ISO 8601). */
  since?: string;
}

/** The repository with the client the section reads it with. */
interface Repository {
  api: PromoteGitHubApi;
  owner: string;
  repo: string;
}

/** The app's image references as `.env` names them; `undefined` for anything else. */
function imageOf(value: string | undefined): string | undefined {
  const image = value?.trim();
  return image !== undefined && IMAGE.test(image) ? image : undefined;
}

/** `APP_IMAGE`'s value in an env file's text. */
function appImageIn(text: string | undefined): string | undefined {
  return imageOf(/^APP_IMAGE=(.*)$/m.exec(text ?? "")?.[1]);
}

/**
 * The fixed read-only command that prints the app's `.env` and `.env.previous` images and
 * `.env`'s modification time (seconds) in the app's folder, each after its mark; it exits 3 when
 * the folder is not there.
 */
export function deploysCommand(plan: DeployPlan): string {
  return [
    `cd ${appDir(plan)} 2> /dev/null || exit 3`,
    `echo '${MARK}running'`,
    "sed -n 's/^APP_IMAGE=//p' .env 2> /dev/null",
    `echo '${MARK}previous'`,
    "sed -n 's/^APP_IMAGE=//p' .env.previous 2> /dev/null",
    `echo '${MARK}since'`,
    "stat -c %Y .env 2> /dev/null",
    "true",
  ].join("; ");
}

/**
 * The images on the app's server (a server OpsCrew created as `deploy`, the user's own through its
 * pinned admin login), with {@link deploysCommand}; audited without the address.
 * @throws OpsCrewError `COMMAND_FAILED` when the server can't be read, `PHASE_PRECONDITION` when
 * this computer has no login to it.
 */
async function serverImages(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
): Promise<Held> {
  const { remote, command } = await appServerCommand(
    deps,
    plan,
    options,
    deploysCommand(plan),
    "the versions on the server",
  );
  deps.reporter.step("Reading the versions on the server (read-only)");
  const result = await remote.run(command, { timeoutMs: 30_000 });
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the deployed versions (read-only)",
    target: plan.target.provider === "own" ? "own server" : "server",
    decision: "allow",
  });
  if (result.exitCode === 3) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The app's folder ${appDir(plan)} is not on the server, so no version of it runs there.`,
      { hint: "Run `opscrew verify`: it checks the app from the outside and says what fails." },
    );
  }
  if (result.exitCode !== 0 || !result.stdout.includes(MARK)) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the versions on the server over SSH (exit code ${result.exitCode}).`,
      {
        hint: "Check that the server is on and that this computer reaches it over SSH, then try again.",
      },
    );
  }
  const parts = sections(result.stdout, MARK);
  const seconds = parts.get("since")?.[0];
  const running = imageOf(parts.get("running")?.[0]);
  const previous = imageOf(parts.get("previous")?.[0]);
  return {
    ...(running !== undefined ? { running } : {}),
    ...(previous !== undefined ? { previous } : {}),
    ...(seconds !== undefined && /^\d+$/.test(seconds)
      ? { since: new Date(Number(seconds) * 1000).toISOString() }
      : {}),
  };
}

/** The images in the app's folder on this computer, and `.env`'s modification time. */
async function localImages(deps: PhaseDeps, plan: DeployPlan): Promise<Held> {
  const folder = appFolder(deps.paths, plan);
  const running = appImageIn(await readTextIfExists(join(folder, ".env")));
  const previous = appImageIn(await readTextIfExists(join(folder, ".env.previous")));
  return {
    ...(running !== undefined
      ? { running, since: (await stat(join(folder, ".env"))).mtime.toISOString() }
      : {}),
    ...(previous !== undefined ? { previous } : {}),
  };
}

/** The app's image on GHCR, read with `OPSCREW_GHCR_READ_TOKEN` when it is set. */
function appImage(deps: PhaseDeps, plan: DeployPlan, github: Repository): AppImage {
  const credential = ghcrReadCredential(deps, github.owner);
  return {
    github: github.api,
    owner: github.owner,
    repo: github.repo,
    key: plan.app.key,
    ...(credential !== undefined ? { credential } : {}),
  };
}

/**
 * The images the user's Portainer runs, by the labels its deploy job gives them in GHCR:
 * `opscrew-<env>` and `opscrew-<env>-previous`.
 */
async function labelledImages(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: Repository,
): Promise<Held> {
  const image = appImage(deps, plan, github);
  const label = `opscrew-${deps.paths.environment}`;
  const digestOf = (tag: string) =>
    image.github.taggedDigest(
      image.owner,
      ghcrPackage(image.repo, image.key),
      tag,
      image.credential,
    );
  const running = await digestOf(label);
  const previous = await digestOf(`${label}-previous`);
  return {
    ...(running !== undefined ? { running: `@${running}` } : {}),
    ...(previous !== undefined ? { previous: `@${previous}` } : {}),
  };
}

/** The repository with the section's client, or why GitHub can't be read. */
async function readRepository(
  deps: PhaseDeps,
  options: ComponentStatusOptions,
): Promise<Repository | { why: string }> {
  const given = options.services?.deploys;
  try {
    const api = given === undefined ? await githubClientFromToken(deps) : given;
    if (api === null || api === undefined) return { why: NO_TOKEN };
    const { owner, repo } = await githubCoordinates(gitClient(deps));
    return { api, owner, repo };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { why: errorText(error) };
  }
}

/** The last rollback `rollback.json` records on this computer (data-model.md). */
const RollbackRecordSchema = z.object({ commit: z.string(), at: z.string() });

/** A version in a line: `<short commit> "<message>" (sha256:<12>)`, or what is known of it. */
function versionWords(image: string, view: VersionView | undefined): string {
  const digest = view?.digest;
  if (digest === undefined) return image;
  const short = digest.slice(0, 19);
  if (view?.commit === undefined) return short;
  const message = view.message === undefined ? "" : ` "${view.message}"`;
  return `${view.commit.slice(0, 7)}${message} (${short})`;
}

/**
 * True when its workflow deploys the environment on its own: every target but this computer
 * without the local runner.
 */
function deploysOnTheirOwn(plan: DeployPlan): boolean {
  return plan.target.provider !== "localhost" || plan.environment?.runner === "local";
}

/** True when a push to the environment's branch deploys it: not promoted, {@link deploysOnTheirOwn}. */
function pushesDeploy(plan: DeployPlan): boolean {
  return followsBranch(plan) && deploysOnTheirOwn(plan);
}

/**
 * The pause's lines: on, a move's window, or a rollback's pin with how to resume, and when the
 * environment runs another image than the pinned one, that the rollback's run hasn't finished.
 */
function pauseLines(
  plan: DeployPlan,
  pause: DeployPause | undefined,
  flag: string,
  running: string | undefined,
): string[] {
  const branch = plan.cicd.branch;
  if (pause === undefined) {
    return [`  Deploys: on${pushesDeploy(plan) ? ` (each push to ${branch} deploys)` : ""}`];
  }
  const since = formatUtc(pause.since);
  if (pause.reason === "move") {
    return [`  Paused since ${since} for a move's window: \`opscrew provision${flag}\` ends it.`];
  }
  const resume = `\`opscrew rollback${flag} --resume\``;
  const lines = [
    pushesDeploy(plan)
      ? `  Paused since ${since}: ${pinnedText(pause)}. Run ${resume} when the fix is pushed (add --deploy to deploy ${branch}'s latest commit now).`
      : `  Paused since ${since}: ${pinnedText(pause)}. Run ${resume} to deploy forward again.`,
  ];
  if (running !== undefined && running !== pause.image) {
    lines.push(
      `  It runs ${running.slice(0, 19)}, not the pinned ${pause.image.slice(0, 19)}: the rollback's run hasn't finished.`,
    );
  }
  return lines;
}

/**
 * The version the environment runs and the one before it, described, as lines: on a server, its
 * `.env` and `.env.previous` and `.env`'s time ({@link deploysCommand}); on this computer, the
 * same files in the app's folder; in the user's Portainer, GHCR's `opscrew-<env>` and `-previous`
 * labels. Each is described by its provenance (`describeImage`), else by its short digest; each
 * read that fails is a line that says why.
 */
async function versionsSection(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
  github: Repository | { why: string },
  componentsRead: boolean,
): Promise<{ lines: string[]; running?: VersionView; previous?: VersionView }> {
  const { provider } = plan.target;
  const onServer = provider === "own" || provider === "hetzner" || provider === "digitalocean";
  if (onServer && !componentsRead) {
    // The same login failed or was refused: no second connection, no second host-key question.
    return {
      lines: ["  OpsCrew did not read the versions, for the same reason as the components."],
    };
  }
  let held: Held;
  try {
    if (provider === "portainer") {
      if ("why" in github) {
        return { lines: [`  OpsCrew could not read the versions from GitHub. ${github.why}`] };
      }
      held = await labelledImages(deps, plan, github);
    } else {
      held =
        provider === "localhost"
          ? await localImages(deps, plan)
          : await serverImages(deps, plan, options);
    }
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { lines: [`  OpsCrew could not read the versions. ${errorText(error)}`] };
  }
  if (held.running === undefined) {
    return { lines: ["  Running: OpsCrew found no deployed version."] };
  }
  const views = new Map<string, VersionView>();
  for (const image of [held.running, held.previous]) {
    const digest = DIGEST.exec(image ?? "")?.[1];
    if (digest !== undefined) views.set(digest, { digest });
  }
  const notes: string[] = [];
  if ("why" in github) {
    if (views.size > 0)
      notes.push(`  OpsCrew could not read their commits from GitHub. ${github.why}`);
  } else if (views.size > 0) {
    try {
      const image = appImage(deps, plan, github);
      for (const digest of views.keys()) {
        const described = await describeImage(deps, image, digest);
        if (described === undefined) continue;
        const { commit, message, builtAt } = described;
        views.set(digest, {
          digest,
          commit,
          ...(message !== undefined ? { message } : {}),
          builtAt,
        });
      }
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      notes.push(`  OpsCrew could not read their commits. ${errorText(error)}`);
    }
  }
  const viewOf = (image: string) => {
    const digest = DIGEST.exec(image)?.[1];
    return digest === undefined ? undefined : views.get(digest);
  };
  const running = viewOf(held.running);
  const previous = held.previous === undefined ? undefined : viewOf(held.previous);
  const since = held.since === undefined ? "" : `, since ${formatUtc(held.since)}`;
  return {
    lines: [
      `  Running: ${versionWords(held.running, running)}${since}`,
      held.previous === undefined
        ? "  Before it: none kept"
        : `  Before it: ${versionWords(held.previous, previous)}`,
      ...notes,
    ],
    ...(running !== undefined ? { running } : {}),
    ...(previous !== undefined ? { previous } : {}),
  };
}

/**
 * The pause's lines ({@link pauseLines}): from GitHub (`deployPauseOf`); a token GitHub refuses
 * the variable (no Variables: Read) is a line saying the pause is unknown, never "on"; when GitHub
 * can't be read, why, and the last rollback this computer's `rollback.json` records, never as the
 * pause.
 */
async function pauseSection(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: Repository | { why: string },
  running: string | undefined,
): Promise<{ lines: string[]; paused?: DeployPause }> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  let why: string;
  if ("why" in github) {
    why = github.why;
  } else {
    try {
      const paused = await deployPauseOf(github, plan);
      return {
        lines: pauseLines(plan, paused, flag, running),
        ...(paused !== undefined ? { paused } : {}),
      };
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      if (codeOf(error).startsWith("CREDENTIALS_")) {
        return {
          lines: [
            "  Deploys: OpsCrew can't tell whether they're paused: the GitHub token can't read repository variables (Variables: Read).",
          ],
        };
      }
      why = errorText(error);
    }
  }
  const lines = [`  OpsCrew could not read whether deploys are paused. ${why}`];
  const recorded = await readValidJson(
    join(deps.paths.stateDir, "rollback.json"),
    RollbackRecordSchema,
  );
  if (recorded !== undefined) {
    lines.push(
      `  The last rollback on this computer: ${recorded.commit.slice(0, 7)} at ${formatUtc(recorded.at)} (GitHub can't be read now, so OpsCrew can't tell whether deploys are still paused).`,
    );
  }
  return { lines };
}

/**
 * The deploys' section of `status` (FR-1913), redacted, with what it read (`deploys` in
 * `opscrew_status`'s data, US6 #1):
 * - the version running and the one before ({@link versionsSection}); a site's are in its own
 *   section (`siteStatusReport`);
 * - whether its deploys are paused ({@link pauseSection}); on this computer only with the local
 *   runner, since nothing else deploys it on its own.
 *
 * `options.check` runs first, as for the components, and stops every read when it fails. When the
 * components could not be read from the app's server (`componentsRead` false), the server is not
 * read again, and the pause still is.
 */
export async function deployStateReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions & { check?: () => Promise<void> } = {},
  componentsRead = true,
): Promise<{ lines: string[]; deploys?: DeployState }> {
  const { provider } = plan.target;
  const site = isServerlessProvider(provider);
  const where =
    provider === "localhost"
      ? "this computer and GitHub"
      : provider === "portainer" || site
        ? "GitHub"
        : provider === "own"
          ? "your server and GitHub"
          : "the server and GitHub";
  const head = `Deploys (read from ${where} now):`;
  try {
    await options.check?.();
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { lines: [head, "  OpsCrew did not read them, for the same reason as the components."] };
  }
  const github = await readRepository(deps, options);
  const versions = site
    ? { lines: [] }
    : await versionsSection(deps, plan, options, github, componentsRead);
  const deploys: DeployState = {
    ...(versions.running !== undefined ? { running: versions.running } : {}),
    ...(versions.previous !== undefined ? { previous: versions.previous } : {}),
  };
  const lines = [head, ...versions.lines];
  if (deploysOnTheirOwn(plan)) {
    const pause = await pauseSection(deps, plan, github, versions.running?.digest);
    lines.push(...pause.lines);
    if (pause.paused !== undefined) deploys.paused = pause.paused;
  }
  return { lines: lines.map((line) => deps.redactor.redact(line)), deploys };
}
