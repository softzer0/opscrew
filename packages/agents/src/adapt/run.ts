import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type GitClient,
  type GitStatusEntry,
  type PullRequest,
  parseGitHubRepo,
} from "@opscrew/connector-github";
import type { AgentRuntime, AuditInput } from "@opscrew/contracts";
import {
  exists,
  findExecutable,
  isSecretPath,
  isUserFacingError,
  OpsCrewError,
  plural,
  readTextIfExists,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { detectSite, listProjectFiles } from "@opscrew/detect";
import type { RenderedFile } from "@opscrew/iac-templates";
import {
  appBranch,
  type CodeChangeKind,
  type CodeChangeStatus,
  type DeployPlan,
  isServerlessTarget,
  type ProjectFacts,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { scanDockerfile } from "@opscrew/secops";
import { appFlag } from "../apps/choice";
import type { PhaseDeps } from "../context";
import { backgroundJobsWarning } from "../design/background-jobs";
import { type CodeChange, readScanReport } from "../design/code-changes";
import { releaseCommandNote } from "../design/release";
import {
  githubClientFromToken,
  requireGitRepo,
  serverlessName,
  writeRenderedFiles,
} from "../shared";
import { appBranchNames, numberedBranches } from "../shared/app-branches";
import { runPhase } from "../shared/phase-status";
import {
  BASELINE_MET,
  noDockerfileNote,
  renderDockerFiles,
  runtimeVersionFile,
} from "./build-files";
import {
  cloudflareAdapterEdit,
  type EditedFile,
  nextWorkersOptionsEdit,
} from "./cloudflare-adapter";
import { healthRouteEdit } from "./health";
import { updateLockfile } from "./lockfile";
import { isNextConfigPath, nextConfigEdit } from "./next-config";
import { CLOUDFLARE_PLAYBOOKS, playbookFor, serverlessStaticPlaybook } from "./playbooks";
import {
  healthCheckWarning,
  PULL_REQUEST_TITLE,
  type PullRequestBuild,
  renderPullRequestBody,
} from "./pr";
import {
  buildCodeChangePrompt,
  CODE_CHANGE_MODEL,
  CODE_CHANGE_SYSTEM_PROMPT,
  type CodeChangeReport,
  CodeChangeReportSchema,
  manualInstructions,
} from "./prompts";
import { staticOutputNote } from "./static-output";

/**
 * Branch adapt creates for the repository's first app; `-2`, `-3`, … are appended when it already
 * exists. A further app's is `opscrew/prepare-deploy-<key>`, then `_2`, … (`appBranchNames`).
 */
export const ADAPT_BRANCH = "opscrew/prepare-deploy";

/** Subject line of the adapt commit. */
export const ADAPT_COMMIT_SUBJECT = "chore(opscrew): prepare app for deployment";

/** The GitHub operations adapt needs (implemented by `GitHubClient`; faked in tests). */
export interface AdaptGitHub {
  findOpenPullRequest(owner: string, repo: string, head: string): Promise<PullRequest | undefined>;
  createPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
}

export interface RunAdaptOptions {
  /** Run the Code-change agent when a model is configured (`--no-ai` sets false). Default true. */
  ai?: boolean;
  /** Push the branch and open a pull request after the commit (`--no-push` sets false). */
  push?: boolean;
  /** Model for the Code-change agent. Default `claude-opus-5-5`. */
  model?: string;
  /**
   * GitHub client override (tests, MCP). Default: a `GitHubClient` with the token from
   * `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`; without a token no pull request is opened.
   */
  github?: AdaptGitHub;
}

/** A pending change the user has to make by hand, with plain-English instructions. */
export interface ManualChange {
  change: CodeChange;
  instructions: string;
}

export interface AdaptResult {
  /** Branch the changes are on. */
  branch: string;
  /** Branch it was created from, and the pull request's base. */
  baseBranch: string;
  /** Deterministic files OpsCrew wrote (repo-relative). */
  createdFiles: string[];
  /** Existing files OpsCrew edited deterministically (repo-relative), such as `next.config.mjs`. */
  editedFiles: string[];
  /** The plan's code changes with their updated statuses. */
  changes: CodeChange[];
  /** Notes per change id. */
  notes: Record<string, string>;
  /** Changes still pending, with instructions for doing them by hand. */
  manual: ManualChange[];
  /** Packages the Code-change agent added. */
  addedDependencies: string[];
  /** True when the Code-change agent ran. */
  aiRan: boolean;
  costUsd: number;
  committed: boolean;
  commitSha?: string;
  pushed: boolean;
  pullRequest?: PullRequest;
  /**
   * The command that pushes the commit when OpsCrew did not (`--no-push`), checked against
   * origin when it can be reached: `git push -u origin <branch>`, or
   * `git push -u origin <branch>:<free name>` when origin already has the branch.
   */
  pushCommand?: string;
}

/**
 * Code-change kinds OpsCrew writes from templates, and the rendered file each one uses: the
 * Dockerfile is rendered in the app's folder (`<appDir>/Dockerfile`), the others at the repository
 * root. Each is written at its change's path (the `.dockerignore` at the build context's root).
 */
const DETERMINISTIC: Partial<Record<CodeChangeKind, (path: string) => boolean>> = {
  dockerfile: (path) => path === "Dockerfile" || path.endsWith("/Dockerfile"),
  dockerignore: (path) => path === ".dockerignore",
  "env-example": (path) => path === ".env.example",
};

/** The Cloudflare adapter's changes design adds for a server-rendered app (`serverlessCodeChanges`). */
const ADAPTER_CHANGES = new Set(["cloudflare-adapter", "next-workers-options"]);

/** The rendered template for a deterministic change, preferring one at the change's own path. */
function templateFor(
  change: CodeChange,
  rendered: readonly RenderedFile[],
): RenderedFile | undefined {
  const matches = DETERMINISTIC[change.kind];
  if (matches === undefined) return undefined;
  return (
    rendered.find((file) => file.path === change.path && matches(file.path)) ??
    rendered.find((file) => matches(file.path))
  );
}

/**
 * The adapt phase (plan.md "Adapt"): requires a clean working tree, creates the
 * `opscrew/prepare-deploy` branch (the next free `-2`, `-3`, … when this clone or origin already has
 * it; it stops before changing anything while a pull request from an earlier run's branch is still
 * open), writes the Dockerfile (only for the `generated-dockerfile` builder, its runtime image
 * pinned by the registry's digest), `.dockerignore` and `.env.example` when the plan asks for them
 * and they are missing, adds the runtime version file when the repository has none, checks the
 * user's own Dockerfile against
 * the image baseline, adds the health route itself for the frameworks it knows (`./health`), makes
 * the deterministic Next.js standalone edit, on Cloudflare's hosting sets up a server-rendered
 * app's Cloudflare adapter (`./cloudflare-adapter`, its release read from the npm registry) and
 * has the app's package manager update its lockfile, runs the Code-change agent (`edit-repo` profile)
 * for the other pending changes when a model is configured, updates the statuses in
 * `opscrew/plan.yaml`, and then — each step after its own approval (`repo-write`, `git-push`,
 * `pull-request`) — commits, pushes and opens a pull request. A refused approval stops there and
 * leaves everything before it in place (uncommitted changes on the branch, or an unpushed commit).
 * Run again on the branch of such an unpushed commit, it pushes that commit (renamed to a free
 * branch name when origin has the branch already) and opens the pull request instead of starting
 * over; with `--no-push` it says how to push it. A failed push says what to do; nothing is ever
 * force-pushed.
 */
export async function runAdapt(
  deps: PhaseDeps,
  options: RunAdaptOptions = {},
): Promise<AdaptResult> {
  return runPhase(deps, "adapt", () => adapt(deps, options));
}

async function adapt(deps: PhaseDeps, options: RunAdaptOptions): Promise<AdaptResult> {
  const { paths, reporter } = deps;
  const ai = options.ai ?? true;
  const push = options.push ?? true;
  const model = options.model ?? CODE_CHANGE_MODEL;
  const { say, warn, audit } = voice(deps);

  reporter.step("Preparing the code for deployment");
  let plan = await readArtifact("plan", paths.files.plan);
  const { facts } = await readArtifact("architecture", paths.files.architecture);

  // 1. Preconditions: a git repository with at least one commit and a clean working tree.
  const gitBin = findExecutable("git", deps.env) ?? "git";
  const git = await requireGitRepo(deps, gitBin);
  try {
    await git.headSha();
  } catch {
    throw new OpsCrewError("PHASE_PRECONDITION", "The git repository has no commits yet.", {
      hint: "Commit your code first, then run `opscrew adapt` again.",
    });
  }
  const prefix = await repoPrefix(deps, gitBin);
  if (!(await git.isClean({ ignore: [`${prefix}opscrew/`, `${prefix}.opscrew/`] }))) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The working tree has uncommitted changes, so OpsCrew did not touch anything.",
      {
        hint: "Commit or stash your changes first (`git stash -u`), then run `opscrew adapt` again.",
      },
    );
  }

  // 2. Branch from the current HEAD (or continue an earlier run's commit that was never pushed).
  const key = plan.app.key;
  const original = await git.currentBranch();
  const remote = push ? await git.remoteUrl("origin") : undefined;
  const repo = remote === undefined ? undefined : parseGitHubRepo(remote);
  // Resolved once, when first needed: before the branch is picked only if origin has it already.
  let client: Promise<AdaptGitHub | undefined> | undefined;
  const gitHub = () => {
    client ??=
      options.github === undefined ? githubClientFromToken(deps) : Promise.resolve(options.github);
    return client;
  };
  const originCheck: OriginCheck | undefined =
    remote === undefined
      ? undefined
      : {
          openPullRequest: async (head) => {
            const api = repo === undefined ? undefined : await gitHub();
            if (repo === undefined || api === undefined) return { known: false };
            try {
              const pullRequest = await api.findOpenPullRequest(repo.owner, repo.repo, head);
              return pullRequest === undefined ? { known: true } : { pullRequest, known: true };
            } catch (error) {
              if (!isUserFacingError(error)) throw error;
              return { known: false };
            }
          },
          info: (text) => reporter.info(say(text)),
          warn,
        };

  const unpushed = await unpushedAdaptCommit(git, key, original);
  if (unpushed !== undefined) {
    const baseBranch = await git.defaultBranch();
    const short = unpushed.slice(0, 7);
    if (!push) {
      const advice = await pushAdvice(git, key, original);
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `You are on ${original}, and OpsCrew's commit ${short} on it is not on origin yet, so OpsCrew did not start another run.`,
        {
          hint: say(
            `${advice.text} Then open a pull request into ${baseBranch}. Or run \`opscrew adapt\` without --no-push: it pushes the commit and opens the pull request. To start over instead, run \`git checkout ${baseBranch}\` first.`,
          ),
        },
      );
    }
    reporter.info(
      say(
        `You are on ${original}, and OpsCrew's commit ${short} on it is not on origin yet, so OpsCrew pushes it and opens the pull request instead of starting another run. To start over, run \`git checkout ${baseBranch}\` and \`opscrew adapt\` again.`,
      ),
    );
    const picked =
      originCheck === undefined
        ? { branch: original, originChecked: false }
        : await pickBranch(git, key, originCheck, original);
    if (picked.branch !== original) {
      await git.renameBranch(original, picked.branch);
      await audit({
        kind: "git",
        actor: "opscrew",
        action: "rename branch",
        target: `${original} -> ${picked.branch}`,
      });
      reporter.info(
        `Renamed ${original} to ${picked.branch}, so the push does not touch the branch on origin.`,
      );
    }
    return pushAndOpen({
      deps,
      git,
      plan,
      facts,
      sha: unpushed,
      remote,
      repo,
      gitHub,
      originChecked: picked.originChecked,
      byOpsCrew: [],
      paths: {},
      result: {
        branch: picked.branch,
        baseBranch,
        createdFiles: [],
        editedFiles: [],
        changes: plan.codeChanges,
        notes: {},
        manual: [],
        addedDependencies: [],
        aiRan: false,
        costUsd: 0,
        committed: true,
        commitSha: unpushed,
        pushed: false,
      },
    });
  }

  // The user's own Dockerfile must be where the plan builds the image from.
  const builder = plan.app.build?.builder;
  const ownDockerfile =
    builder === "own-dockerfile"
      ? await readTextIfExists(join(paths.root, plan.app.dockerfile))
      : undefined;
  if (builder === "own-dockerfile" && ownDockerfile === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml builds the image with your own Dockerfile at ${plan.app.dockerfile}, which does not exist, so OpsCrew did not touch anything.`,
      {
        hint: "Set app.dockerfile in opscrew/plan.yaml to your Dockerfile's path from the repository root, then run `opscrew adapt` again.",
      },
    );
  }

  const baseBranch = original === "HEAD" ? await git.defaultBranch() : original;
  const { branch, originChecked } = await pickBranch(git, key, originCheck);
  await git.createBranch(branch);
  await audit({ kind: "git", actor: "opscrew", action: "create branch", target: branch });
  reporter.info(
    `Created branch ${branch} from ${original === "HEAD" ? "the current commit" : original}.`,
  );

  const statuses = new Map<string, CodeChangeStatus>();
  const notes: Record<string, string> = {};
  const set = (change: CodeChange, status: CodeChangeStatus, note: string) => {
    statuses.set(change.id, status);
    if (note !== "") notes[change.id] = say(note);
  };
  const pending = plan.codeChanges.filter((change) => change.status === "pending");

  // 3. Deterministic files, only when missing. OpsCrew writes its Dockerfile only when it builds
  // the image with it; another builder needs none.
  const createdFiles: string[] = [];
  const forAgent: CodeChange[] = [];
  /** Ids of the changes OpsCrew made itself (shown as such in the pull request). */
  const byOpsCrew = new Set<string>();
  const noDockerfile = noDockerfileNote(builder, plan.app.dockerfile);
  const templated: CodeChange[] = [];
  for (const change of pending.filter((c) => DETERMINISTIC[c.kind] !== undefined)) {
    if (change.kind === "dockerfile" && noDockerfile !== undefined) {
      set(change, "skipped", noDockerfile);
    } else {
      templated.push(change);
    }
  }
  let rendered: RenderedFile[] = [];
  if (templated.length > 0) {
    try {
      rendered = await renderDockerFiles(deps, facts, plan, {
        dockerfile: noDockerfile === undefined,
        warn,
      });
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      warn(`${error.message} The Dockerfile change is left to the Code-change agent or to you.`);
    }
  }
  const toWrite: RenderedFile[] = [];
  for (const change of templated) {
    // Written at the change's path, which design sets to where the plan's build expects it. Only
    // the Dockerfile is rendered for the analysed app's folder.
    const template = templateFor(change, rendered);
    if (change.kind === "dockerfile" && template !== undefined && template.path !== change.path) {
      warn(
        `The plan puts the ${change.kind} at ${change.path}, but OpsCrew would render it at ${template.path} for the analysed app. If you changed which app to deploy, run \`opscrew design\` again.`,
      );
    }
    if (template === undefined) {
      forAgent.push(change);
    } else if (await exists(join(paths.root, change.path))) {
      set(change, "skipped", `${change.path} already exists; OpsCrew left it as it is.`);
    } else {
      toWrite.push({ ...template, path: change.path });
      set(change, "applied", "Written by OpsCrew from its template for this stack.");
      byOpsCrew.add(change.id);
    }
  }
  // The runtime version file (FR-1228 rule 5), only when the repository has none. Dependabot's
  // configuration comes with provision's deploy-setup pull request, with the files it watches.
  const versionFile = await runtimeVersionFile(paths.root, facts, plan);
  if (versionFile !== undefined) toWrite.push(versionFile);
  await writeRenderedFiles(paths.root, toWrite);
  for (const file of toWrite) createdFiles.push(file.path);
  if (createdFiles.length > 0) reporter.success(`Wrote ${createdFiles.join(", ")}.`);

  // 3a. The user's own Dockerfile against the image baseline: each finding with its fix.
  const baseline =
    ownDockerfile === undefined ? undefined : scanDockerfile(plan.app.dockerfile, ownDockerfile);
  if (baseline !== undefined) {
    if (baseline.length === 0) {
      reporter.info(say(`${plan.app.dockerfile} ${BASELINE_MET}.`));
    } else {
      warn(
        `${plan.app.dockerfile} misses OpsCrew's image baseline in ${plural(baseline.length, "place")}; OpsCrew does not change your Dockerfile:`,
      );
      for (const finding of baseline) {
        warn(`- line ${finding.line}: ${finding.title}. Fix: ${finding.remediation}`);
      }
    }
  }
  const version = plan.app.build?.runtime.version;
  /** The build's part of the pull request, once design chose the builder. */
  const build: PullRequestBuild | undefined =
    builder === undefined
      ? undefined
      : {
          builder,
          dockerfile: plan.app.dockerfile,
          context: plan.app.buildContext,
          ...(versionFile !== undefined && version !== undefined
            ? { versionFile: { path: versionFile.path, version } }
            : {}),
          ...(baseline !== undefined ? { baseline } : {}),
        };

  // 3b. The health route, added by OpsCrew for the frameworks it knows when it can tell where
  // it goes (`./health`), the Next.js standalone output, edited when the config is a plain
  // object (or missing), and on Cloudflare the server-rendered app's adapter; anything else stays
  // with the Code-change agent or the user.
  const deployTarget = plan.target;
  const site = isServerlessTarget(deployTarget) ? await detectSite(paths.root, facts) : undefined;
  const adapter =
    deployTarget.provider === "cloudflare-workers" && deployTarget.render === "ssr"
      ? site?.adapter
      : undefined;
  if (site !== undefined && isServerlessTarget(deployTarget) && site.render === "static") {
    const note = staticOutputNote(site, deployTarget.site.outputDir, deployTarget.provider);
    if (note !== undefined) reporter.info(say(note));
  }
  const playbook =
    adapter !== undefined
      ? CLOUDFLARE_PLAYBOOKS[adapter.framework]
      : isServerlessTarget(deployTarget)
        ? serverlessStaticPlaybook(serverlessName(deployTarget.provider))
        : playbookFor(facts);
  const editedFiles: string[] = [];
  /** Writes edited and new files, edited ones keeping their mode (the build must still read them). */
  const writeEdited = async (files: readonly EditedFile[]) => {
    for (const file of files) {
      const path = join(paths.root, file.path);
      const mode = file.created ? 0o644 : (await stat(path)).mode & 0o777;
      await writeFileAtomic(path, file.content, { mode });
      (file.created ? createdFiles : editedFiles).push(file.path);
    }
  };
  /** The adapter change whose package.json edit needs the lockfile updated. */
  let lockfileFor: CodeChange | undefined;
  /** The file a change was really made in, when it is not the plan's path. */
  const madeIn: Record<string, string> = {};
  const manualReasons = new Map<string, string>();
  const leaveToAgent = (change: CodeChange, note: string, reason: string) => {
    // Notes for the pull request; the agent's report replaces them when it runs.
    notes[change.id] = say(note);
    manualReasons.set(change.id, reason);
    forAgent.push(change);
  };
  let projectFiles: Promise<readonly string[]> | undefined;
  /** True when adapt changed `app.healthPath` to where the new route answers. */
  let planChanged = false;
  for (const change of pending.filter((c) => DETERMINISTIC[c.kind] === undefined)) {
    if (site !== undefined && adapter !== undefined && ADAPTER_CHANGES.has(change.id)) {
      const edit =
        change.id === "cloudflare-adapter"
          ? await cloudflareAdapterEdit(paths.root, site, deps.fetch)
          : await nextWorkersOptionsEdit(paths.root, change.path, site.nextOptions ?? []);
      if (edit.action === "write") {
        await writeEdited(edit.files);
        if (edit.path !== change.path) madeIn[change.id] = edit.path;
        if (edit.packageJson) lockfileFor = change;
        set(change, "applied", edit.note);
        byOpsCrew.add(change.id);
        reporter.success(say(edit.note));
      } else if (edit.action === "none") {
        set(change, "skipped", edit.reason);
      } else {
        leaveToAgent(change, `OpsCrew did not make it: ${edit.reason}`, edit.reason);
      }
      continue;
    }
    if (change.kind === "health-endpoint") {
      // The health route for every stack OpsCrew knows (FR-816), before the Code-change agent.
      const edit = await healthRouteEdit({
        facts,
        stack: playbook.id,
        path: change.path,
        healthPath: plan.app.healthPath,
        repo: {
          files: () => {
            projectFiles ??= listProjectFiles(paths.root).then((list) => list.files);
            return projectFiles;
          },
          read: (path) => readTextIfExists(join(paths.root, path)),
          exists: (path) => exists(join(paths.root, path)),
          folders: (path) => subfolders(join(paths.root, path)),
        },
      });
      // A literal global prefix or basePath moves the route: the plan's health path follows it in
      // the same pull request. One OpsCrew cannot read is only named (the user's to set).
      const pathNote = edit.action === "manual" ? undefined : edit.pathNote;
      const moved = edit.action === "manual" ? undefined : edit.healthPath;
      if (moved !== undefined && moved !== plan.app.healthPath) {
        plan = { ...plan, app: { ...plan.app, healthPath: moved } };
        planChanged = true;
      }
      const tell = (text: string) => (moved === undefined ? warn(text) : reporter.info(say(text)));
      if (edit.action === "write") {
        await writeEdited(edit.files);
        if (edit.path !== change.path) madeIn[change.id] = edit.path;
        const note = [edit.note, ...edit.checks, pathNote]
          .filter((line) => line !== undefined)
          .join(" ");
        set(change, "applied", note);
        byOpsCrew.add(change.id);
        reporter.success(
          edit.files[0]?.created === true && edit.files.length === 1
            ? `Created ${edit.path} for the deploy health check.`
            : `Added the ${edit.framework} health route for the deploy health check (${edit.files.map((f) => f.path).join(", ")}).`,
        );
        for (const check of edit.checks) warn(check);
        if (pathNote !== undefined) tell(pathNote);
      } else if (edit.action === "none") {
        set(change, "skipped", pathNote === undefined ? edit.reason : `${edit.reason} ${pathNote}`);
        if (pathNote !== undefined) tell(pathNote);
      } else {
        leaveToAgent(change, `OpsCrew did not add it: ${edit.reason}`, edit.reason);
      }
      continue;
    }
    if (
      playbook.id !== "nextjs" ||
      change.kind !== "build-config" ||
      !isNextConfigPath(change.path)
    ) {
      forAgent.push(change);
      continue;
    }
    const edit = await nextConfigEdit(paths.root, change.path);
    if (edit.action === "write") {
      await writeFileAtomic(join(paths.root, change.path), edit.content);
      (edit.created ? createdFiles : editedFiles).push(change.path);
      set(change, "applied", edit.note);
      byOpsCrew.add(change.id);
      reporter.success(
        `${edit.created ? "Created" : "Edited"} ${change.path} to build the standalone Next.js server.`,
      );
    } else if (edit.action === "none") {
      set(change, "skipped", edit.reason);
    } else {
      leaveToAgent(change, `OpsCrew did not edit it: ${edit.reason}`, edit.reason);
    }
  }
  // The adapter's new dependencies into the app's lockfile, by its own package manager.
  if (lockfileFor !== undefined && site?.packageManager !== undefined) {
    const update = await updateLockfile(deps, site.dir, site.packageManager);
    if (update.status !== "none") {
      notes[lockfileFor.id] = say(`${notes[lockfileFor.id] ?? ""} ${update.note}`.trim());
      if (update.status === "updated") {
        editedFiles.push(update.lockfile);
        reporter.success(say(update.note));
      } else {
        warn(update.note);
      }
    }
  }

  // 4. Code-change agent for everything else.
  let aiRan = false;
  let costUsd = 0;
  let addedDependencies: string[] = [];
  if (forAgent.length > 0) {
    const runtime = await codeChangeRuntime(deps, ai);
    if (typeof runtime !== "string") {
      aiRan = true;
      reporter.step(
        `Running the Code-change agent (${model}) on ${plural(forAgent.length, "change")}`,
      );
      const result = await runtime.runPhase({
        phase: "adapt",
        systemPrompt: CODE_CHANGE_SYSTEM_PROMPT,
        prompt: say(buildCodeChangePrompt({ facts, plan, changes: forAgent, playbook })),
        projectRoot: paths.root,
        profile: "edit-repo",
        output: {
          name: "code_change_report",
          description: "One status (applied or skipped) and notes per code change id.",
          schema: CodeChangeReportSchema,
        },
        model,
        effort: "high",
        maxTurns: 60,
        maxBudgetUsd: 3,
        onEvent: (event) => {
          if (event.kind === "tool-denied") warn(`Blocked agent action: ${event.message}`);
        },
      });
      costUsd = result.costUsd;
      await deps.costs.append({ phase: "adapt", model: result.model ?? model, costUsd });
      const report = result.ok ? CodeChangeReportSchema.safeParse(result.output) : undefined;
      if (report?.success) {
        addedDependencies = applyReport(report.data, forAgent, set, warn);
      } else {
        warn(
          `The Code-change agent did not finish (${result.error ?? result.stopReason}). Any edits it made are left for you to review; its changes stay pending.`,
        );
      }
    } else {
      reporter.info(runtime);
    }
  }
  const manual: ManualChange[] = forAgent
    .filter((change) => !statuses.has(change.id))
    .map((change) => {
      const reason = manualReasons.get(change.id);
      const instructions = manualInstructions(change, playbook);
      return {
        change,
        instructions: say(reason === undefined ? instructions : `${instructions} (${reason})`),
      };
    });
  if (manual.length > 0) {
    reporter.info(`${plural(manual.length, "change")} still to make by hand:`);
    for (const item of manual) reporter.info(`- ${item.instructions}`);
  }
  if (manual.some((item) => item.change.kind === "health-endpoint")) {
    warn(healthCheckWarning(plan.app.healthPath));
  }

  // 7 (before the commit, so the committed plan carries the statuses). Update the plan.
  const changes = plan.codeChanges.map((change) => {
    const status = statuses.get(change.id);
    return status === undefined ? change : { ...change, status };
  });
  if (statuses.size > 0 || planChanged) {
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      codeChanges: changes,
      updatedAt: deps.clock.now().toISOString(),
    });
  }

  const result: AdaptResult = {
    branch,
    baseBranch,
    createdFiles,
    editedFiles,
    changes,
    notes,
    manual,
    addedDependencies,
    aiRan,
    costUsd,
    committed: false,
    pushed: false,
  };

  // 5. Show what changed, then commit after approval.
  const artefacts = new Set(artefactPaths(deps));
  const changed = (await git.status())
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  const heldBack = changed.filter(
    (entry) => isSecretPath(entry.path) && !entry.path.startsWith(".opscrew/"),
  );
  if (heldBack.length > 0) {
    warn(
      `Left out of the commit because they may hold secrets: ${heldBack.map((e) => e.path).join(", ")}.`,
    );
  }
  const toCommit = changed.filter(
    (entry) =>
      !isSecretPath(entry.path) &&
      (!entry.path.startsWith("opscrew/") || artefacts.has(entry.path)),
  );
  if (toCommit.length === 0) {
    reporter.info("Nothing to commit: the app already has everything the plan asks for.");
    await deps.state.markPhase("adapt", "ok", "nothing to change");
    return result;
  }

  const diffStat = await git.diffStat();
  const details = [
    `Branch: ${branch} (from ${baseBranch})`,
    `Files (${toCommit.length}):`,
    ...toCommit.map((entry) => `  ${statusLabel(entry)} ${entry.path}`),
    ...(diffStat === "" ? [] : ["", diffStat]),
  ].join("\n");
  reporter.info(say(details));
  const commitApproval = await deps.approvals.request({
    kind: "repo-write",
    title: `Commit ${plural(toCommit.length, "file")} to branch ${branch}`,
    details: say(details),
  });
  if (!commitApproval.approved) {
    warn(
      `Nothing was committed. The changes stay uncommitted on branch ${branch}: review them with \`git status\` and \`git diff\`, then commit them yourself or discard them.`,
    );
    await deps.state.markPhase("adapt", "skipped", say(`changes left uncommitted on ${branch}`));
    return result;
  }
  await git.add(toCommit.map((entry) => entry.path));
  const sha = await git.commit(say(commitMessage(changes, madeIn)));
  result.committed = true;
  result.commitSha = sha;
  await audit({ kind: "git", actor: "opscrew", action: "commit", target: branch, detail: sha });
  reporter.success(`Committed ${sha.slice(0, 7)} on ${branch}.`);

  // 6. Push and open the pull request, each after approval.
  if (!push) {
    const advice = await pushAdvice(git, key, branch);
    result.pushCommand = advice.command;
    reporter.info(say(`Not pushed (--no-push). ${advice.text} Then open a pull request.`));
    await deps.state.markPhase("adapt", "ok", say(`committed ${sha.slice(0, 7)} on ${branch}`));
    return result;
  }
  return pushAndOpen({
    deps,
    git,
    plan,
    facts,
    sha,
    remote,
    repo,
    gitHub,
    originChecked,
    byOpsCrew: [...byOpsCrew],
    paths: madeIn,
    build,
    result,
  });
}

/** Adapt's reporting: `say` redacts, `warn` reports redacted, `audit` records redacted. */
function voice(deps: PhaseDeps) {
  const say = (text: string) => deps.redactor.redact(text);
  return {
    say,
    warn: (text: string) => deps.reporter.warn(say(text)),
    audit: (entry: Omit<AuditInput, "phase">) =>
      deps.audit.append({ ...entry, phase: "adapt", detail: entry.detail && say(entry.detail) }),
  };
}

/** What {@link pushAndOpen} needs: the commit, the branch it is on and where it goes. */
interface PushContext {
  deps: PhaseDeps;
  git: GitClient;
  plan: DeployPlan;
  /** The app the facts describe: its background jobs, migrations and notes go into the PR. */
  facts: ProjectFacts;
  /** The OpsCrew commit on `result.branch`. */
  sha: string;
  /** origin's URL; undefined without an `origin` remote. */
  remote: string | undefined;
  /** The GitHub repository origin points at. */
  repo: { owner: string; repo: string } | undefined;
  gitHub: () => Promise<AdaptGitHub | undefined>;
  /** False when origin could not be checked before the branch name was picked. */
  originChecked: boolean;
  /** Ids of the changes OpsCrew made itself. */
  byOpsCrew: readonly string[];
  /** The file a change was really made in, when it is not the plan's path. */
  paths: Readonly<Record<string, string>>;
  /** What this run did for the image's build (absent when pushing an earlier run's commit). */
  build?: PullRequestBuild;
  /** The result so far: its branch, base, changes, notes and dependencies go into the PR. */
  result: AdaptResult;
}

/**
 * Pushes the OpsCrew commit and opens the pull request, each after its own approval. A refused
 * approval, a missing token or a failed pull request is a warning that says how to continue; a
 * failed push throws `COMMAND_FAILED` with what to do (nothing is ever force-pushed).
 */
async function pushAndOpen(ctx: PushContext): Promise<AdaptResult> {
  const { deps, git, plan, facts, sha, remote, repo, gitHub, result } = ctx;
  const { branch, baseBranch, changes, notes, addedDependencies } = result;
  const { paths, reporter } = deps;
  const { say, warn, audit } = voice(deps);
  const done = async (summary: string) => {
    await deps.state.markPhase("adapt", "ok", say(summary));
    return result;
  };
  if (remote === undefined) {
    warn(
      `This repository has no \`origin\` remote, so OpsCrew did not push. Add your GitHub repository with \`git remote add origin <url>\`, then run \`git push -u origin ${branch}\`.`,
    );
    return done(`committed ${sha.slice(0, 7)} on ${branch}`);
  }
  const shownRemote = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  const pushApproval = await deps.approvals.request({
    kind: "git-push",
    title: `Push branch ${branch} to origin`,
    details: say(`Remote: origin (${shownRemote})\nBranch: ${branch}\nCommit: ${sha}`),
  });
  if (!pushApproval.approved) {
    warn(
      `Not pushed. The commit stays on the local branch ${branch}; push it with \`git push -u origin ${branch}\` when you are ready.`,
    );
    return done(`committed ${sha.slice(0, 7)} on ${branch}, not pushed`);
  }
  try {
    await git.push(branch, { setUpstream: true });
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const later = `Once origin is reachable, run \`opscrew adapt\` again on this branch: it pushes the commit${ctx.originChecked ? "" : " (to a free branch name when origin has this one)"} and opens the pull request.`;
    throw new OpsCrewError(
      "COMMAND_FAILED",
      say(
        `OpsCrew committed ${sha.slice(0, 7)} on ${branch}, but the push to origin failed: ${error.message}`,
      ),
      {
        hint: say(
          ctx.originChecked
            ? `Check that you can push to origin. ${later} Or push it yourself with \`git push -u origin ${branch}\` and open a pull request into ${baseBranch}.`
            : `OpsCrew could not check origin before it picked ${branch}, so origin may already have a branch of that name from an earlier run. Push the commit to a free branch name yourself with \`git push -u origin ${branch}:<new name>\` and open a pull request into ${baseBranch}. ${later} Or run \`git checkout ${baseBranch}\` and \`opscrew adapt\` again to start over.`,
        ),
        cause: error,
      },
    );
  }
  result.pushed = true;
  await audit({ kind: "git", actor: "opscrew", action: "push", target: `origin ${branch}` });
  reporter.success(`Pushed ${branch} to origin.`);

  if (repo === undefined) {
    warn(`origin is not a GitHub repository, so open a pull request for ${branch} yourself.`);
    return done(`pushed ${branch}`);
  }
  const compareUrl = `https://github.com/${repo.owner}/${repo.repo}/compare/${encodeURI(baseBranch)}...${encodeURI(branch)}?expand=1`;
  try {
    const github = await gitHub();
    if (github === undefined) {
      warn(
        `No GitHub token was found, so OpsCrew did not open the pull request. Set GITHUB_TOKEN or run \`gh auth login\`, or open it yourself: ${compareUrl}`,
      );
      return done(`pushed ${branch}`);
    }
    const existing = await github.findOpenPullRequest(repo.owner, repo.repo, branch);
    if (existing !== undefined) {
      result.pullRequest = existing;
      reporter.success(`A pull request for ${branch} is already open: ${existing.url}`);
      return done(`pull request #${existing.number}`);
    }
    const backgroundJobs = backgroundJobsWarning(facts);
    const migrations = releaseCommandNote(plan, facts, await appFlag(paths.root, paths.app))?.text;
    const body = say(
      renderPullRequestBody({
        changes,
        notes,
        scanCounts: (await readScanReport(paths.files.scanReportJson))?.counts,
        reports: await existingFiles(paths.root, artefactPaths(deps)),
        repo,
        branch,
        app: { name: plan.app.name, port: plan.app.port, healthPath: plan.app.healthPath },
        addedDependencies,
        byOpsCrew: ctx.byOpsCrew,
        paths: ctx.paths,
        ...(ctx.build === undefined ? {} : { build: ctx.build }),
        ...(isServerlessTarget(plan.target)
          ? {
              site: {
                target: serverlessName(plan.target.provider),
                ...(plan.target.site.command === undefined
                  ? {}
                  : { command: plan.target.site.command }),
                buildContext: plan.app.buildContext,
                outputDir: plan.target.site.outputDir,
              },
            }
          : {}),
        ...(backgroundJobs === undefined ? {} : { backgroundJobs }),
        ...(migrations === undefined ? {} : { migrations }),
        ...(facts.notes === undefined ? {} : { appNotes: facts.notes }),
      }),
    );
    const prApproval = await deps.approvals.request({
      kind: "pull-request",
      title: `Open a pull request from ${branch} into ${baseBranch} on ${repo.owner}/${repo.repo}`,
      details: say(`Title: ${PULL_REQUEST_TITLE}\n\n${body}`),
    });
    if (!prApproval.approved) {
      warn(`No pull request was opened. Open it yourself when you are ready: ${compareUrl}`);
      return done(`pushed ${branch}`);
    }
    const pullRequest = await github.createPullRequest({
      owner: repo.owner,
      repo: repo.repo,
      head: branch,
      base: baseBranch,
      title: PULL_REQUEST_TITLE,
      body,
    });
    result.pullRequest = pullRequest;
    await audit({
      kind: "provider-call",
      actor: "opscrew",
      action: "create pull request",
      target: `${repo.owner}/${repo.repo}#${pullRequest.number}`,
    });
    reporter.success(`Opened pull request #${pullRequest.number}: ${pullRequest.url}`);
    return done(`pull request #${pullRequest.number}`);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    warn(`The pull request could not be opened: ${error.message} Open it yourself: ${compareUrl}`);
    return done(`pushed ${branch}, pull request not opened`);
  }
}

/** Repo-root-relative POSIX prefix of the project directory (`""` at the repository root). */
async function repoPrefix(deps: PhaseDeps, gitBin: string): Promise<string> {
  const result = await deps.runner.run(
    gitBin,
    ["-C", deps.paths.root, "rev-parse", "--show-prefix"],
    {
      env: { ...deps.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 30_000,
    },
  );
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** How adapt looks at origin before it picks a branch name (only when it will push). */
interface OriginCheck {
  /** The open pull request from `branch`, or undefined when there is none or it cannot tell. */
  openPullRequest(branch: string): Promise<{ pullRequest?: PullRequest; known: boolean }>;
  info(text: string): void;
  warn(text: string): void;
}

/**
 * The first free name of the app `key`'s adapt branches (`appBranchNames`: the plan's key, none
 * for the first app): not in this clone (except `current`, the branch already holding the commit
 * to push) and, when adapt will push, not on origin either, so the push never collides with a
 * branch an earlier run left behind. A branch on origin with an open pull request stops adapt
 * before it changes anything (that pull request is still the place to finish the earlier run); one
 * without (merged or closed) is skipped, never pushed to. `originChecked` is false when origin was
 * not checked (no push, or it could not be reached).
 */
async function pickBranch(
  git: GitClient,
  key: string | undefined,
  origin?: OriginCheck,
  current?: string,
): Promise<{ branch: string; originChecked: boolean }> {
  let check = origin;
  for (const name of appBranchNames(ADAPT_BRANCH, key)) {
    if (check !== undefined) {
      let sha: string | undefined;
      try {
        sha = await git.remoteBranchSha(name);
      } catch (error) {
        if (!isUserFacingError(error)) throw error;
        check.warn(
          `OpsCrew could not check origin for a branch left by an earlier run (${error.message}). It continues; if the push is refused, run \`opscrew adapt\` again when origin is reachable.`,
        );
        check = undefined;
      }
      if (sha !== undefined && check !== undefined) {
        const { pullRequest, known } = await check.openPullRequest(name);
        if (pullRequest !== undefined) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            `The pull request from an earlier OpsCrew run is still open: ${pullRequest.url} (branch ${name}). OpsCrew did not change anything.`,
            {
              hint: "Merge or close that pull request on GitHub, then run `opscrew adapt` again.",
            },
          );
        }
        check.info(
          known
            ? `${name} is already on origin from an earlier run, and no pull request from it is open, so OpsCrew leaves it alone.`
            : `${name} is already on origin, and OpsCrew cannot check its pull request, so OpsCrew leaves it alone.`,
        );
        continue;
      }
    }
    if (name === current || !(await git.branchExists(name))) {
      return { branch: name, originChecked: check !== undefined };
    }
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `There are already 100 ${appBranch(ADAPT_BRANCH, key)} branches, so OpsCrew did not create another one.`,
    {
      hint: `Delete the old ones with \`git branch -D ${numberedBranches(ADAPT_BRANCH, key)}\`, then try again.`,
    },
  );
}

/**
 * The sha of OpsCrew's adapt commit at `HEAD` when it was never pushed: `branch` is one of the
 * app `key`'s adapt branches (`appBranchNames`), its last commit is the adapt commit, and neither
 * origin's copy of the branch (as this clone last saw it) nor origin's default branch contains it.
 * Reads only this clone.
 */
async function unpushedAdaptCommit(
  git: GitClient,
  key: string | undefined,
  branch: string,
): Promise<string | undefined> {
  if (!appBranchNames(ADAPT_BRANCH, key).includes(branch)) return undefined;
  if ((await git.commitSubject()) !== ADAPT_COMMIT_SUBJECT) return undefined;
  const sha = await git.headSha();
  if (await git.isAncestor(sha, `refs/remotes/origin/${branch}`)) return undefined;
  if (await git.isAncestor(sha, `refs/remotes/origin/${await git.defaultBranch()}`)) {
    return undefined;
  }
  return sha;
}

/**
 * The command that pushes `branch` (and how to say it), checked read-only against origin when it
 * can be reached: when origin already has `branch` from an earlier run, the commit goes to the
 * next of the app `key`'s adapt branches (`appBranchNames`) that is free on origin and in this
 * clone (`git push -u origin <branch>:<free name>`).
 */
async function pushAdvice(
  git: GitClient,
  key: string | undefined,
  branch: string,
): Promise<{ command: string; text: string }> {
  const plain = `git push -u origin ${branch}`;
  if ((await git.remoteUrl("origin")) === undefined) {
    return {
      command: plain,
      text: `When you are ready, add your GitHub repository with \`git remote add origin <url>\`, then run \`${plain}\`.`,
    };
  }
  const unknown = {
    command: plain,
    text: `When you are ready: \`${plain}\`. OpsCrew could not check origin; if it already has ${branch} from an earlier run, push to a new branch name instead: \`git push -u origin ${branch}:<new name>\`.`,
  };
  try {
    if ((await git.remoteBranchSha(branch)) === undefined) {
      return { command: plain, text: `When you are ready: \`${plain}\`.` };
    }
    for (const name of appBranchNames(ADAPT_BRANCH, key)) {
      if (name === branch || (await git.branchExists(name))) continue;
      if ((await git.remoteBranchSha(name)) !== undefined) continue;
      const command = `git push -u origin ${branch}:${name}`;
      return {
        command,
        text: `${branch} is already on origin from an earlier run, so push this commit to a new branch when you are ready: \`${command}\`.`,
      };
    }
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
  }
  return unknown;
}

/** The OpsCrew artefacts adapt commits and links (project-relative POSIX paths). */
function artefactPaths(deps: PhaseDeps): string[] {
  const { paths } = deps;
  return [
    paths.files.architecture,
    paths.files.architectureMd,
    paths.files.requirements,
    paths.files.plan,
    paths.files.scanReportMd,
  ].map((file) => toPosixRelative(paths.root, file));
}

/** Names of the sub-folders of `dir` (`[]` when it is missing or unreadable). */
async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The runtime the Code-change agent runs on, or why it will not run. */
async function codeChangeRuntime(deps: PhaseDeps, ai: boolean): Promise<AgentRuntime | string> {
  if (!ai) return "The Code-change agent was turned off (--no-ai).";
  if (deps.runtime === undefined) {
    return "No model is configured, so the Code-change agent did not run.";
  }
  const availability = await deps.runtime.isConfigured();
  if (availability.ok) return deps.runtime;
  const why = availability.reason ?? "the model is not available";
  return `The Code-change agent did not run: ${why}${availability.hint ? ` ${availability.hint}` : ""}`;
}

/** Applies the agent's report to the changes it was given; returns the dependencies it added. */
function applyReport(
  report: CodeChangeReport,
  given: readonly CodeChange[],
  set: (change: CodeChange, status: CodeChangeStatus, note: string) => void,
  warn: (text: string) => void,
): string[] {
  const byId = new Map(given.map((change) => [change.id, change]));
  const reported = new Set<string>();
  for (const entry of report.changes) {
    const change = byId.get(entry.id);
    if (change === undefined || reported.has(entry.id)) {
      warn(`The Code-change agent reported an unknown or repeated change "${entry.id}"; ignored.`);
      continue;
    }
    reported.add(entry.id);
    set(change, entry.status, entry.notes);
  }
  const missing = given.filter((change) => !reported.has(change.id)).map((change) => change.id);
  if (missing.length > 0) {
    warn(`The Code-change agent did not report on ${missing.join(", ")}; they stay pending.`);
  }
  return [...report.addedDependencies];
}

/** The adapt commit message; `madeIn` names the real file when it is not the plan's path. */
function commitMessage(
  changes: readonly CodeChange[],
  madeIn: Readonly<Record<string, string>>,
): string {
  const done = changes.filter((change) => change.status === "applied");
  if (done.length === 0) return `${ADAPT_COMMIT_SUBJECT}\n`;
  const lines = done.map((change) => `- ${change.kind}: ${madeIn[change.id] ?? change.path}`);
  return `${ADAPT_COMMIT_SUBJECT}\n\n${lines.join("\n")}\n`;
}

function statusLabel(entry: GitStatusEntry): string {
  if (entry.code.includes("?") || entry.code.includes("A")) return "new    ";
  if (entry.code.includes("D")) return "deleted";
  return "changed";
}

async function existingFiles(root: string, files: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) if (await exists(join(root, file))) found.push(file);
  return found;
}
