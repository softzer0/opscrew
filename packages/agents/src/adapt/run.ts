import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  GitClient,
  GitHubClient,
  type GitStatusEntry,
  type PullRequest,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import { type AuditInput, SEVERITIES, type Severity } from "@opscrew/contracts";
import {
  findExecutable,
  isSecretPath,
  isUserFacingError,
  OpsCrewError,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { type RenderedFile, renderDockerAssets } from "@opscrew/iac-templates";
import {
  type CodeChangeKind,
  type CodeChangeStatus,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { CodeChange } from "../design";
import { writeRenderedFiles } from "../shared";
import { isNextConfigPath, type StandaloneEdit, standaloneConfigEdit } from "./next-config";
import { playbookFor } from "./playbooks";
import { PULL_REQUEST_TITLE, renderPullRequestBody } from "./pr";
import {
  buildCodeChangePrompt,
  CODE_CHANGE_MODEL,
  CODE_CHANGE_SYSTEM_PROMPT,
  type CodeChangeReport,
  CodeChangeReportSchema,
  manualInstructions,
} from "./prompts";

/** Branch adapt creates; `-2`, `-3`, … are appended when it already exists. */
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
}

/**
 * Code-change kinds OpsCrew writes from templates, and the rendered file each one uses: the
 * Dockerfile is rendered in the app's folder (`<appDir>/Dockerfile`), the others at the repository
 * root (the build context).
 */
const DETERMINISTIC: Partial<Record<CodeChangeKind, (path: string) => boolean>> = {
  dockerfile: (path) => path === "Dockerfile" || path.endsWith("/Dockerfile"),
  dockerignore: (path) => path === ".dockerignore",
  "env-example": (path) => path === ".env.example",
};

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

const ScanFileSchema = z.looseObject({
  counts: z.partialRecord(z.enum(SEVERITIES), z.number().int().nonnegative()).optional(),
  findings: z.array(z.looseObject({ severity: z.enum(SEVERITIES) })).optional(),
});

const PLURAL = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The adapt phase (plan.md "Adapt"): requires a clean working tree, creates the
 * `opscrew/prepare-deploy` branch, writes the Dockerfile, `.dockerignore` and `.env.example` when
 * the plan asks for them and they are missing, runs the Code-change agent (`edit-repo` profile)
 * for the other pending changes when a model is configured, updates the statuses in
 * `opscrew/plan.yaml`, and then — each step after its own approval (`repo-write`, `git-push`,
 * `pull-request`) — commits, pushes and opens a pull request. A refused approval stops there and
 * leaves everything before it in place (uncommitted changes on the branch, or an unpushed commit).
 */
export async function runAdapt(
  deps: PhaseDeps,
  options: RunAdaptOptions = {},
): Promise<AdaptResult> {
  try {
    return await adapt(deps, options);
  } catch (error) {
    await deps.state.markPhase(
      "adapt",
      "failed",
      isUserFacingError(error) ? deps.redactor.redact(error.message) : undefined,
    );
    throw error;
  }
}

async function adapt(deps: PhaseDeps, options: RunAdaptOptions): Promise<AdaptResult> {
  const { paths, reporter } = deps;
  const ai = options.ai ?? true;
  const push = options.push ?? true;
  const model = options.model ?? CODE_CHANGE_MODEL;
  const say = (text: string) => deps.redactor.redact(text);
  const warn = (text: string) => reporter.warn(say(text));
  const audit = (entry: Omit<AuditInput, "phase">) =>
    deps.audit.append({ ...entry, phase: "adapt", detail: entry.detail && say(entry.detail) });

  reporter.step("Preparing the code for deployment");
  const plan = await readArtifact("plan", paths.files.plan);
  const { facts } = await readArtifact("architecture", paths.files.architecture);

  // 1. Preconditions: a git repository with at least one commit and a clean working tree.
  const gitBin = findExecutable("git", deps.env) ?? "git";
  const git = new GitClient({
    cwd: paths.root,
    runner: deps.runner,
    env: deps.env,
    git: gitBin,
    redactor: deps.redactor,
  });
  if (!(await git.isRepo())) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This project is not a git repository, so OpsCrew cannot prepare a pull request.",
      {
        hint: "Run `git init`, commit your code, add your GitHub remote, then run `opscrew adapt` again.",
      },
    );
  }
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

  // 2. Branch from the current HEAD.
  const original = await git.currentBranch();
  const baseBranch = original === "HEAD" ? await git.defaultBranch() : original;
  const branch = await pickBranch(git);
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

  // 3. Deterministic files, only when missing.
  const createdFiles: string[] = [];
  const forAgent: CodeChange[] = [];
  /** Ids of the changes OpsCrew made itself (shown as such in the pull request). */
  const byOpsCrew = new Set<string>();
  const templated = pending.filter((change) => DETERMINISTIC[change.kind] !== undefined);
  let rendered: RenderedFile[] = [];
  if (templated.length > 0) {
    try {
      rendered = renderDockerAssets(facts, {
        appPort: plan.app.port,
        healthPath: plan.app.healthPath,
      });
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      warn(`${error.message} The Dockerfile change is left to the Code-change agent or to you.`);
    }
  }
  const toWrite: RenderedFile[] = [];
  for (const change of templated) {
    // Written at the change's path, which design sets to where the plan's build expects it.
    const template = templateFor(change, rendered);
    if (template !== undefined && template.path !== change.path) {
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
  await writeRenderedFiles(paths.root, toWrite);
  for (const file of toWrite) createdFiles.push(file.path);
  if (createdFiles.length > 0) reporter.success(`Wrote ${createdFiles.join(", ")}.`);

  // 3b. Next.js standalone output: edited by OpsCrew when the config is a plain object (or
  // missing); any other shape stays with the Code-change agent or the user.
  const playbook = playbookFor(facts);
  const editedFiles: string[] = [];
  const manualReasons = new Map<string, string>();
  for (const change of pending.filter((c) => DETERMINISTIC[c.kind] === undefined)) {
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
      // Notes for the pull request; the agent's report replaces them when it runs.
      notes[change.id] = say(`OpsCrew did not edit it: ${edit.reason}`);
      manualReasons.set(change.id, edit.reason);
      forAgent.push(change);
    }
  }

  // 4. Code-change agent for everything else.
  let aiRan = false;
  let costUsd = 0;
  let addedDependencies: string[] = [];
  if (forAgent.length > 0) {
    const skipReason = await agentSkipReason(deps, ai);
    if (skipReason === undefined && deps.runtime !== undefined) {
      aiRan = true;
      reporter.step(
        `Running the Code-change agent (${model}) on ${PLURAL(forAgent.length, "change")}`,
      );
      const result = await deps.runtime.runPhase({
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
      reporter.info(skipReason ?? "The Code-change agent did not run.");
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
    reporter.info(`${PLURAL(manual.length, "change")} still to make by hand:`);
    for (const item of manual) reporter.info(`- ${item.instructions}`);
  }

  // 7 (before the commit, so the committed plan carries the statuses). Update the plan.
  const changes = plan.codeChanges.map((change) => {
    const status = statuses.get(change.id);
    return status === undefined ? change : { ...change, status };
  });
  if (statuses.size > 0) {
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
  const artefacts = new Set(
    [
      paths.files.architecture,
      paths.files.architectureMd,
      paths.files.requirements,
      paths.files.plan,
      paths.files.scanReportMd,
    ].map((file) => toPosixRelative(paths.root, file)),
  );
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
    title: `Commit ${PLURAL(toCommit.length, "file")} to branch ${branch}`,
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
  const sha = await git.commit(say(commitMessage(changes)));
  result.committed = true;
  result.commitSha = sha;
  await audit({ kind: "git", actor: "opscrew", action: "commit", target: branch, detail: sha });
  reporter.success(`Committed ${sha.slice(0, 7)} on ${branch}.`);

  // 6. Push and open the pull request, each after approval.
  const done = async (summary: string) => {
    await deps.state.markPhase("adapt", "ok", say(summary));
    return result;
  };
  if (!push) {
    reporter.info(
      `Not pushed (--no-push). When you are ready: \`git push -u origin ${branch}\`, then open a pull request.`,
    );
    return done(`committed ${sha.slice(0, 7)} on ${branch}`);
  }
  const remote = await git.remoteUrl("origin");
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
  await git.push(branch, { setUpstream: true });
  result.pushed = true;
  await audit({ kind: "git", actor: "opscrew", action: "push", target: `origin ${branch}` });
  reporter.success(`Pushed ${branch} to origin.`);

  const repo = parseGitHubRepo(remote);
  if (repo === undefined) {
    warn(`origin is not a GitHub repository, so open a pull request for ${branch} yourself.`);
    return done(`pushed ${branch}`);
  }
  const compareUrl = `https://github.com/${repo.owner}/${repo.repo}/compare/${encodeURI(baseBranch)}...${encodeURI(branch)}?expand=1`;
  try {
    const github = options.github ?? (await defaultGitHub(deps));
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
    const body = say(
      renderPullRequestBody({
        changes,
        notes,
        scanCounts: await readScanCounts(paths.files.scanReportJson),
        reports: await existingFiles(paths.root, [...artefacts]),
        repo,
        branch,
        app: { name: plan.app.name, port: plan.app.port, healthPath: plan.app.healthPath },
        addedDependencies,
        byOpsCrew: [...byOpsCrew],
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

async function pickBranch(git: GitClient): Promise<string> {
  for (let i = 1; i <= 100; i++) {
    const name = i === 1 ? ADAPT_BRANCH : `${ADAPT_BRANCH}-${i}`;
    if (!(await git.branchExists(name))) return name;
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `There are already 100 ${ADAPT_BRANCH} branches, so OpsCrew did not create another one.`,
    { hint: `Delete the old ones with \`git branch -D ${ADAPT_BRANCH}-<n>\`, then try again.` },
  );
}

/** Why the Code-change agent will not run, or undefined when it will. */
async function agentSkipReason(deps: PhaseDeps, ai: boolean): Promise<string | undefined> {
  if (!ai) return "The Code-change agent was turned off (--no-ai).";
  if (deps.runtime === undefined) {
    return "No model is configured, so the Code-change agent did not run.";
  }
  const availability = await deps.runtime.isConfigured();
  if (availability.ok) return undefined;
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

function commitMessage(changes: readonly CodeChange[]): string {
  const done = changes.filter((change) => change.status === "applied");
  if (done.length === 0) return `${ADAPT_COMMIT_SUBJECT}\n`;
  const lines = done.map((change) => `- ${change.kind}: ${change.path}`);
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

const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

/**
 * The deterministic standalone edit for the Next.js config at `path` (repo-relative). A config in
 * a subfolder also gets `outputFileTracingRoot` pointing back at the project root, and a missing
 * config is created only when no other `next.config.*` sits next to where the plan expects it.
 */
async function nextConfigEdit(root: string, path: string): Promise<StandaloneEdit> {
  const dir = posix.dirname(path);
  let content: string | undefined;
  try {
    content = await readFile(join(root, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const name of NEXT_CONFIG_NAMES) {
      const other = dir === "." ? name : `${dir}/${name}`;
      if (other !== path && (await exists(join(root, other)))) {
        return {
          action: "manual",
          reason: `the plan expects ${path} but the app has ${other}; run \`opscrew design\` again.`,
        };
      }
    }
  }
  const tracingRoot = dir === "." ? undefined : "../".repeat(dir.split("/").length);
  return standaloneConfigEdit({
    path,
    content,
    ...(tracingRoot === undefined ? {} : { tracingRoot }),
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readScanCounts(
  file: string,
): Promise<Partial<Record<Severity, number>> | undefined> {
  let parsed: z.infer<typeof ScanFileSchema>;
  try {
    const result = ScanFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!result.success) return undefined;
    parsed = result.data;
  } catch {
    return undefined;
  }
  if (parsed.counts !== undefined) return parsed.counts;
  if (parsed.findings === undefined) return undefined;
  const counts: Partial<Record<Severity, number>> = {};
  for (const finding of parsed.findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

async function defaultGitHub(deps: PhaseDeps): Promise<AdaptGitHub | undefined> {
  const token = await resolveGitHubToken(deps.env, deps.runner);
  if (token === undefined) return undefined;
  deps.redactor.addLiteral(token, "github-token");
  return new GitHubClient({ token, fetch: deps.fetch, version: deps.version });
}
