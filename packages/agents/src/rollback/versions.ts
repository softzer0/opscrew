/**
 * A server environment's versions (plan.md 3.): its images still in GHCR, from the runs of the
 * deploy workflow that builds them and GHCR's tags, each checked as `promote` checks an image.
 * Then the version a rollback goes to, and what the plan at that version's commit lacks.
 */
import { posix } from "node:path";
import type { WorkflowRunSource } from "@opscrew/connector-github";
import { listText, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { environmentTag } from "@opscrew/iac-templates";
import { ArtifactError, type DeployPlan, parseArtifact, targetArch } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { builderCicd } from "../environments/branches";
import {
  type AppImage,
  checkPlatform,
  checkProvenance,
  imageFactsOf,
  imageReference,
} from "../promote/image";
import { NOTHING as NOTHING_DEPLOYED } from "../promote/shared";
import { ghcrPackage } from "../shared/github";
import type { LeftOutVersion, Version, VersionList, VersionsContext } from "./types";

/** What every refusal of a rollback ends with. */
const NOTHING = "Nothing was changed.";

/** The most versions listed. */
const LISTED = 20;
/** The workflow runs read: GitHub's largest page. */
const RUNS_READ = 100;
/** How many versions a refusal names. */
const NAMED = 5;

/** The first line of a commit's message, redacted; `undefined` when it is empty. */
function messageOf(
  deps: Pick<PhaseDeps, "redactor">,
  commit: WorkflowRunSource["headCommit"],
): string | undefined {
  const line = commit?.message.split("\n")[0]?.trim();
  return line ? deps.redactor.redact(line) : undefined;
}

/** `sha256:` and the digest's first 12 digits. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 19);
}

/**
 * A version in one line: `<short commit> "<message>", built <time> (sha256:<12>)`, as the
 * approval and the refusals name it.
 */
export function versionText(version: Version): string {
  const message = version.message === undefined ? "" : ` "${version.message}"`;
  return `${version.commit.slice(0, 7)}${message}, built ${version.builtAt} (${shortDigest(version.digest)})`;
}

/** Why `promote`'s check refused an image, without its closing sentence. */
function reasonOf(error: OpsCrewError): string {
  const suffix = ` ${NOTHING_DEPLOYED}`;
  return error.message.endsWith(suffix) ? error.message.slice(0, -suffix.length) : error.message;
}

/**
 * The version a rollback goes to by default (ADR 0023 D4), in `versions` (newest first):
 * `opscrew-<env>-previous` (`previous`) when it was built before the running one, as after any
 * forward deploy; when it was built at or after it, as after a rollback, the newest version built
 * before the running one whose build succeeded. None without the label, or when its image is not
 * listed: {@link chooseVersion} says why.
 */
function previousOf(
  versions: Version[],
  running: Version,
  previous: string | undefined,
): Version | undefined {
  const at = versions.indexOf(running);
  const labelled = versions.findIndex((version) => version.digest === previous);
  if (labelled === -1) return undefined;
  if (labelled > at) return versions[labelled];
  return versions.slice(at + 1).find((version) => version.buildSucceeded);
}

/**
 * The environment's versions (FR-1903), newest first by their build run:
 * - the runs of the builder's deploy workflow on its branch (the environment's own, or for a
 *   promoted environment the one {@link builderCicd} names), newest first;
 * - the commit tags in the builder's form ({@link environmentTag}) that GHCR has: those of the
 *   newest 20 runs that have one, and the 20 from the build run of each label's image down, so
 *   the running version and the ones before it are listed after many paused pushes too;
 * - per tag the digest and facts (`describeTags`, with one pull token), with `checkProvenance`
 *   (on the builder's branch and form) and `checkPlatform` (the environment's CPU) as `promote`
 *   checks an image.
 *
 * An image that fails a check is left out, with why. The marks: `running` from the
 * `opscrew-<env>` label, `previous` by {@link previousOf}.
 * @throws OpsCrewError `CREDENTIALS_INVALID` when GHCR refuses its token (the hint names
 * `OPSCREW_GHCR_READ_TOKEN`).
 */
export async function listVersions(
  deps: Pick<PhaseDeps, "redactor">,
  ctx: VersionsContext,
): Promise<VersionList> {
  const { image, plan, paths } = ctx;
  const { github, owner, repo, credential } = image;
  const environment = paths.environment;
  const builder = (await builderCicd(paths, plan)) ?? {
    name: environment,
    branch: plan.cicd.branch,
    workflowPath: plan.cicd.workflowPath,
  };
  const runs = await github.listWorkflowRuns(owner, repo, {
    workflowFile: posix.basename(builder.workflowPath),
    branch: builder.branch,
    perPage: RUNS_READ,
  });
  const name = ghcrPackage(repo, image.key);
  const tags = new Set((await github.imageTags(owner, name, credential)) ?? []);
  // The commits of the tags to describe, by tag.
  const candidates = new Map<string, string>();
  /** Adds the first 20 commit tags GHCR has of the runs from the index `from` down. */
  const fill = (from: number) => {
    const added = new Set<string>();
    for (const run of runs.slice(from)) {
      if (added.size === LISTED) break;
      const tag = environmentTag(run.headSha, builder.name);
      if (!tags.has(tag)) continue;
      added.add(tag);
      candidates.set(tag, run.headSha);
    }
  };
  fill(0);
  const label = `opscrew-${environment}`;
  const labels = [label, `${label}-previous`].filter((tag) => tags.has(tag));
  const describe = async (asked: string[]) =>
    asked.length === 0 ? [] : github.describeTags(owner, name, asked, credential);
  const described = new Map(
    (await describe([...candidates.keys(), ...labels])).map((entry) => [entry.tag, entry]),
  );
  // A label's image outside the newest runs: the window from its build run down, read once more.
  const window = new Set(candidates.keys());
  const listed = new Set([...window].map((tag) => described.get(tag)?.digest));
  for (const tag of labels) {
    const entry = described.get(tag);
    if (listed.has(entry?.digest)) continue;
    const from = runs.findIndex((run) => run.id === entry?.facts?.provenance?.runId);
    if (from !== -1) fill(from);
  }
  for (const entry of await describe([...candidates.keys()].filter((tag) => !window.has(tag)))) {
    described.set(entry.tag, entry);
  }
  const tagged = new Map([...described].map(([tag, entry]) => [tag, entry.digest]));

  const built: { version: Version; runId: number }[] = [];
  const leftOut: LeftOutVersion[] = [];
  for (const [tag, commit] of candidates) {
    const { digest, facts } = described.get(tag) ?? {};
    if (digest === undefined || facts === undefined) {
      leftOut.push({
        commit,
        ...(digest !== undefined ? { digest } : {}),
        reason: "GitHub Container Registry no longer has the image.",
      });
      continue;
    }
    try {
      const build = await checkProvenance(
        image,
        digest,
        facts.provenance,
        builder.branch,
        [builder.name],
        tagged,
      );
      checkPlatform(image, digest, facts.platforms, environment, targetArch(plan.target));
      const run = runs.find((listed) => listed.id === facts.provenance?.runId);
      if (run === undefined) {
        leftOut.push({
          commit,
          digest,
          reason: `Its build run is older than the last ${RUNS_READ} runs of ${posix.basename(builder.workflowPath)}.`,
        });
        continue;
      }
      const message = messageOf(deps, run.headCommit);
      const version: Version = {
        digest,
        image: imageReference(image, digest),
        tag: build.tag,
        commit: build.commit,
        ...(message !== undefined ? { message } : {}),
        builtAt: run.createdAt,
        runUrl: build.runUrl,
        buildSucceeded: run.conclusion === "success",
        marks: [],
      };
      built.push({ version, runId: run.id });
    } catch (error) {
      if (!(error instanceof OpsCrewError) || error.code !== "PHASE_PRECONDITION") throw error;
      leftOut.push({ commit, digest, reason: reasonOf(error) });
    }
  }
  // Run ids grow with each run; two runs may share a second.
  const versions = built.sort((a, b) => b.runId - a.runId).map(({ version }) => version);

  const runningDigest = described.get(label)?.digest;
  const previousDigest = described.get(`${label}-previous`)?.digest;
  const running = versions.find((version) => version.digest === runningDigest);
  if (running !== undefined) {
    running.marks.push("running");
    previousOf(versions, running, previousDigest)?.marks.push("previous");
  }
  return {
    versions,
    leftOut,
    ...(runningDigest !== undefined ? { running: runningDigest } : {}),
    ...(previousDigest !== undefined ? { previous: previousDigest } : {}),
  };
}

/** The newest versions and the oldest one still there, for a refusal. */
function available(list: VersionList): string {
  const { versions } = list;
  if (versions.length === 0) return "GitHub Container Registry has no version of it left.";
  const newest = versions.slice(0, NAMED).map(versionText);
  const oldest = versions.at(-1) as Version;
  const named = `The newest ${newest.length === 1 ? "version" : `${newest.length} versions`} there: ${newest.join("; ")}.`;
  return versions.length > NAMED
    ? `${named} The oldest still there: ${versionText(oldest)}.`
    : named;
}

/** Why there is no default version (no `previous` mark), in a sentence or two. */
function noDefault(
  list: VersionList & { running: string },
  environment: string,
  running: Version | undefined,
): string {
  const { previous } = list;
  if (running === undefined) {
    return `the image it runs (${shortDigest(list.running)}) is not among its versions, so OpsCrew can't tell which one ran before it.`;
  }
  if (previous === undefined) {
    return `it has run only one version, ${versionText(running)}: GitHub Container Registry has no image labelled opscrew-${environment}-previous.`;
  }
  if (!list.versions.some((version) => version.digest === previous)) {
    const left = list.leftOut.find((version) => version.digest === previous);
    const before = `the version it ran before (${shortDigest(previous)})`;
    return left !== undefined
      ? `${before} can't be deployed: ${left.reason} ${available(list)}`
      : `${before} is not among its versions. ${available(list)}`;
  }
  return `no version of it built before the one it runs (${versionText(running)}) is still there.`;
}

const COMMIT_PREFIX = /^[0-9a-f]{7,40}$/;
const DIGEST_PREFIX = /^sha256:[0-9a-f]{12,64}$/;

/**
 * The version a rollback of `environment` goes to, and the one it runs when that is listed:
 * without `to`, the `previous` mark; with `to` (`--to`), the version whose commit starts with it
 * (7 to 40 hexadecimal digits) or whose digest does (`sha256:` and 12 to 64 of them).
 * `command` is the rollback's command, which the hints name.
 * @throws OpsCrewError `INVALID_INPUT` when `to` is neither, or names more than one version;
 * `PHASE_PRECONDITION` when no image is labelled `opscrew-<env>`, there is no version to go back
 * to (FR-1907), or `to` names none listed (with why, when it was left out) or the running one.
 */
export function chooseVersion(
  list: VersionList,
  input: { environment: string; to?: string; command: string },
): { target: Version; running?: Version } {
  const { environment, command } = input;
  const listed = `\`${command} --list\` shows the versions there`;
  if (list.running === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Container Registry has no image labelled opscrew-${environment}, so OpsCrew can't tell which version ${environment} runs. ${NOTHING}`,
      {
        hint: `${environment}'s deploy workflow labels its image after a healthy deploy: let a deploy of ${environment} finish, then run \`${command}\` again.`,
      },
    );
  }
  const running = list.versions.find((version) => version.marks.includes("running"));
  const withRunning = running !== undefined ? { running } : {};
  if (input.to === undefined) {
    const target = list.versions.find((version) => version.marks.includes("previous"));
    if (target !== undefined) return { target, ...withRunning };
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew can't roll ${environment} back: ${noDefault({ ...list, running: list.running }, environment, running)} ${NOTHING}`,
      {
        hint:
          list.versions.length > (running === undefined ? 0 : 1)
            ? `Name a version with --to: ${listed}. Or deploy a fix forward.`
            : "Deploy a fix forward instead.",
      },
    );
  }

  const to = input.to.trim().toLowerCase();
  const byDigest = DIGEST_PREFIX.test(to);
  if (!byDigest && !COMMIT_PREFIX.test(to)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${input.to}" is not a commit or an image digest. ${NOTHING}`,
      {
        hint: `Name a commit (7 to 40 hexadecimal digits) or a digest (sha256: and at least 12 of its digits): ${listed}.`,
      },
    );
  }
  const named = (entry: { commit: string; digest?: string }) =>
    byDigest ? entry.digest?.startsWith(to) === true : entry.commit.startsWith(to);
  const matches = list.versions.filter(named);
  if (matches.length > 1) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${input.to} names ${matches.length} versions of ${environment}: ${matches.map(versionText).join("; ")}. ${NOTHING}`,
      { hint: "Name one with more of its digits." },
    );
  }
  const [target] = matches;
  if (target === undefined) {
    const left = list.leftOut.find(named);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      left !== undefined
        ? `OpsCrew won't roll ${environment} back to ${input.to}: ${left.reason} ${NOTHING}`
        : `${input.to} is not among ${environment}'s versions in GitHub Container Registry: it was never built for ${environment}, or is gone. ${available(list)} ${NOTHING}`,
      { hint: `Name one of ${environment}'s versions with --to: ${listed}.` },
    );
  }
  if (target.digest === list.running) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} runs ${versionText(target)} already. ${NOTHING}`,
      { hint: `Name an earlier version with --to: ${listed}.` },
    );
  }
  return { target, ...withRunning };
}

/**
 * Where the image `digest` was built, from its provenance and GitHub's record of that run: its
 * commit, the commit message's first line (redacted), the run's time and URL. `undefined` when
 * GHCR has no such image, or its provenance names no run of this repository GitHub still has.
 */
export async function describeImage(
  deps: Pick<PhaseDeps, "redactor">,
  image: AppImage,
  digest: string,
): Promise<{ commit: string; message?: string; builtAt: string; runUrl: string } | undefined> {
  const provenance = (await imageFactsOf(image, digest))?.provenance;
  const repository = `${image.owner}/${image.repo}`.toLowerCase();
  if (provenance?.runId === undefined || provenance.repository?.toLowerCase() !== repository) {
    return undefined;
  }
  const run = await image.github.workflowRun(image.owner, image.repo, provenance.runId);
  if (run === undefined) return undefined;
  const message = messageOf(deps, run.headCommit);
  return {
    commit: run.headSha,
    ...(message !== undefined ? { message } : {}),
    builtAt: run.createdAt,
    runUrl: provenance.builderId,
  };
}

/** The enabled entries' names. */
function enabledNames(entries: readonly { name: string; enabled: boolean }[]): string[] {
  return entries.filter((entry) => entry.enabled).map((entry) => entry.name);
}

/** `today`'s names that `then` lacks. */
function addedSince(today: readonly string[], then: readonly string[]): string[] {
  return today.filter((name) => !then.includes(name));
}

/**
 * The environment's plan at the commit of `target` (a branch-following environment's, read from
 * GitHub), against today's (plan.md 2. step 5): a service that version ran with and today's plan
 * no longer has stops the rollback; the workers, cron jobs and variables added since are returned
 * as lines for the approval, since they run with the earlier image too. A plan GitHub has no copy
 * of, or that OpsCrew can't read, is `unchecked`. `command` is the rollback's, which the hint names.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the services gone.
 */
export async function checkOldPlan(
  ctx: VersionsContext,
  target: Version,
  command: string,
): Promise<{ unchecked: boolean; added: string[] }> {
  const { image, plan, paths } = ctx;
  const planFile = toPosixRelative(paths.root, paths.files.plan);
  let old: DeployPlan;
  try {
    const text = await image.github.fileText(image.owner, image.repo, planFile, target.commit);
    if (text === undefined) return { unchecked: true, added: [] };
    old = parseArtifact("plan", text, planFile);
  } catch (error) {
    // A plan this OpsCrew can't parse, or a file over GitHub's 1 MB.
    const unreadable =
      error instanceof ArtifactError ||
      (error instanceof OpsCrewError && error.code === "PHASE_PRECONDITION");
    if (unreadable) return { unchecked: true, added: [] };
    throw error;
  }
  const environment = paths.environment;
  const short = target.commit.slice(0, 7);
  const gone = addedSince(enabledNames(old.services), enabledNames(plan.services));
  if (gone.length > 0) {
    const one = gone.length === 1;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${short} ran with the ${one ? "service" : "services"} ${listText(gone)}, which ${environment}'s plan no longer has, so rolling back would run that version without ${one ? "it" : "them"}. ${NOTHING}`,
      {
        hint: `Choose a version built after ${one ? "it was" : "they were"} removed (\`${command} --list\` shows them), or deploy a fix forward.`,
      },
    );
  }
  const lines: string[] = [];
  const workers = addedSince(
    enabledNames(plan.processes.workers),
    enabledNames(old.processes.workers),
  );
  if (workers.length > 0) {
    lines.push(
      `Workers added since ${short}, which run with the earlier image too: ${listText(workers)}.`,
    );
  }
  const cron = addedSince(enabledNames(plan.processes.cron), enabledNames(old.processes.cron));
  if (cron.length > 0) {
    lines.push(
      `Cron jobs added since ${short}, which run with the earlier image too: ${listText(cron)}.`,
    );
  }
  const variables = addedSince(
    plan.app.env.map((variable) => variable.name),
    old.app.env.map((variable) => variable.name),
  );
  if (variables.length > 0) {
    lines.push(
      `Variables added since ${short}, which the earlier image gets too: ${listText(variables)}.`,
    );
  }
  return { unchecked: false, added: lines };
}
