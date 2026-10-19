import { type Finding, SEVERITIES, type Severity } from "@opscrew/contracts";
import { upperFirst } from "@opscrew/core";
import type { CodeChangeKind, ImageBuilder } from "@opscrew/plan-schema";
import { BUILDER_NAMES } from "../design/builder";
import type { CodeChange } from "../design/code-changes";
import { BASELINE_MET, NO_DOCKERFILE_NEEDED } from "./build-files";

/** Title of the pull request opened by `opscrew adapt`. */
export const PULL_REQUEST_TITLE = "OpsCrew: prepare the app for deployment";

/** Last line of every pull request body OpsCrew writes. */
export const PULL_REQUEST_FOOTER = "Opened by OpsCrew";

const KIND_LABELS: Record<CodeChangeKind, string> = {
  dockerfile: "Production Dockerfile",
  dockerignore: ".dockerignore",
  "health-endpoint": "Health endpoint",
  "port-config": "Port read from the environment",
  "env-example": ".env.example",
  "build-config": "Build configuration",
  "secret-removal": "Hard-coded secret moved to the environment",
  other: "Other change",
};

export interface PullRequestBodyInput {
  /** The plan's code changes with their final statuses. */
  changes: readonly CodeChange[];
  /** Notes per change id (from the Code-change agent or OpsCrew). */
  notes: Readonly<Record<string, string>>;
  /** Finding counts from the last `opscrew scan`, when one exists. */
  scanCounts?: Partial<Record<Severity, number>>;
  /** Repo-relative report and artefact files included in the branch. */
  reports: readonly string[];
  /** GitHub repository and branch, used to link the reports. */
  repo: { owner: string; repo: string };
  branch: string;
  /** App name, container port and health path from the plan, for the review checklist. */
  app: { name: string; port: number; healthPath: string };
  /** Packages the Code-change agent added. */
  addedDependencies: readonly string[];
  /** Ids of the changes OpsCrew made itself (templates and deterministic edits). */
  byOpsCrew: readonly string[];
  /**
   * The file a change was really made in, by change id, when it differs from the plan's path
   * (for example `route.js` where the plan says `route.ts`).
   */
  paths: Readonly<Record<string, string>>;
  /** The background-jobs note (FR-812) when the app also runs jobs that are not deployed yet. */
  backgroundJobs?: string;
  /** What detection noted about the app, such as parts OpsCrew does not deploy yet. */
  appNotes?: readonly string[];
  /** The database-migrations note (FR-813): the release command every deploy runs. */
  migrations?: string;
  /** What adapt did for the image's build: its section and the checklist's build line. */
  build?: PullRequestBuild;
}

/** The image build in the pull request (absent: `docker build` at the root in the checklist). */
export interface PullRequestBuild {
  /** `app.build.builder`. */
  builder: ImageBuilder;
  /** `app.dockerfile` and `app.buildContext`, for the `docker build` line. */
  dockerfile: string;
  context: string;
  /** The runtime version file adapt added, with the version in it. */
  versionFile?: { path: string; version: string };
  /** The user's own Dockerfile's baseline findings, each with its fix (empty: it meets it). */
  baseline?: readonly Pick<Finding, "line" | "title" | "remediation">[];
}

/** The name of a builder that needs no Dockerfile (Buildpacks, Railpack); else undefined. */
function codeBuilder(builder: ImageBuilder | undefined): string | undefined {
  return builder === "buildpacks" || builder === "railpack" ? BUILDER_NAMES[builder] : undefined;
}

/** The `## Image build` section: who builds the image and the files adapt added or checked. */
function buildSection(build: PullRequestBuild): string[] {
  const named = codeBuilder(build.builder);
  const lines = [
    "",
    "## Image build",
    "",
    named !== undefined
      ? `${named} ${NO_DOCKERFILE_NEEDED}.`
      : `The deploy workflow builds the image with ${BUILDER_NAMES[build.builder]}, \`${build.dockerfile}\`.`,
  ];
  if (build.versionFile !== undefined) {
    lines.push(
      `- \`${build.versionFile.path}\` (added by OpsCrew): the runtime version the image uses, ${build.versionFile.version}, as recorded in \`opscrew/plan.yaml\` (\`app.build.runtime\`).`,
    );
  }
  if (build.baseline !== undefined) {
    lines.push(
      build.baseline.length === 0
        ? `- \`${build.dockerfile}\` ${BASELINE_MET}.`
        : `- \`${build.dockerfile}\` (yours, unchanged) misses OpsCrew's image baseline:`,
      ...build.baseline.map(
        (finding) => `  - line ${finding.line}: ${finding.title}. Fix: ${finding.remediation}`,
      ),
    );
  }
  return lines;
}

/** The checklist's lines that check the image: the build, and the container answering. */
function buildChecks(input: PullRequestBodyInput): string[] {
  const { name, port, healthPath } = input.app;
  const { build } = input;
  const named = codeBuilder(build?.builder);
  if (named !== undefined) {
    return [
      `- [ ] The image is built with ${named} in the deploy workflow: after the merge, its build job succeeds and the deploy's health check of \`${healthPath}\` passes.`,
    ];
  }
  const custom =
    build !== undefined && (build.dockerfile !== "Dockerfile" || build.context !== ".");
  const command = custom
    ? `docker build -f ${build.dockerfile} -t ${name} ${build.context}`
    : `docker build -t ${name} .`;
  return [
    `- [ ] The image builds: \`${command}\``,
    `- [ ] The container starts and \`http://localhost:${port}${healthPath}\` answers 200: \`docker run --rm -p ${port}:${port} --env-file .env ${name}\``,
  ];
}

/** What a missing health endpoint means for deploys, in one plain sentence. */
export function healthCheckWarning(healthPath: string): string {
  return `Until GET ${healthPath} answers 200, every deploy fails its health check and is rolled back.`;
}

function link(path: string, input: PullRequestBodyInput): string {
  const url = `https://github.com/${input.repo.owner}/${input.repo.repo}/blob/${encodeURI(input.branch)}/${encodeURI(path)}`;
  return `[\`${path}\`](${url})`;
}

function changeLine(
  change: CodeChange,
  notes: string | undefined,
  byOpsCrew: boolean,
  path = change.path,
): string[] {
  const box = change.status === "applied" ? "[x]" : "[ ]";
  const status =
    change.status === "pending"
      ? "to do"
      : change.status === "applied" && byOpsCrew
        ? "applied by OpsCrew"
        : change.status;
  const lines = [
    `- ${box} **${KIND_LABELS[change.kind]}** in \`${path}\` (${status}): ${change.reason}`,
  ];
  const text = notes?.trim().replace(/\s+/g, " ");
  if (text) lines.push(`  - Notes: ${text}`);
  return lines;
}

/**
 * Pull request body for `opscrew adapt`: every code change with its status and notes, links to
 * the committed reports, the scan summary counts, a review checklist and the closing line
 * "Opened by OpsCrew". Pure: callers redact the result before sending it.
 */
export function renderPullRequestBody(input: PullRequestBodyInput): string {
  const lines: string[] = [
    'This pull request prepares the app to run in a production container. OpsCrew wrote the deterministic files and edits (marked "applied by OpsCrew"); the Code-change agent (when a model was configured) made the other code edits. Nothing is deployed until you merge and approve the infrastructure plan.',
    "",
    "## Changes",
    "",
  ];
  if (input.changes.length === 0) lines.push("No code changes were needed.");
  const byOpsCrew = new Set(input.byOpsCrew);
  for (const change of input.changes) {
    lines.push(
      ...changeLine(
        change,
        input.notes[change.id],
        byOpsCrew.has(change.id),
        input.paths[change.id],
      ),
    );
  }
  const health = input.app.healthPath;
  if (input.changes.some((c) => c.kind === "health-endpoint" && c.status === "pending")) {
    lines.push("", `**${healthCheckWarning(health)}**`);
  }
  if (input.addedDependencies.length > 0) {
    lines.push("", "New dependencies added by the Code-change agent:");
    for (const dependency of input.addedDependencies) lines.push(`- \`${dependency}\``);
  }

  if (input.backgroundJobs !== undefined) {
    lines.push("", "## Background jobs", "", input.backgroundJobs);
  }
  if (input.migrations !== undefined) {
    lines.push("", "## Database migrations", "", input.migrations);
  }
  if ((input.appNotes ?? []).length > 0) {
    lines.push("", "## Notes", "");
    for (const note of input.appNotes ?? []) lines.push(`- ${note}`);
  }
  if (input.build !== undefined) lines.push(...buildSection(input.build));

  lines.push("", "## Reports", "");
  if (input.reports.length === 0) lines.push("No OpsCrew reports were included.");
  for (const report of input.reports) lines.push(`- ${link(report, input)}`);

  lines.push("", "## Security scan", "");
  if (input.scanCounts === undefined) {
    lines.push(
      "No scan report was found. Run `opscrew scan` to check the app for security issues.",
    );
  } else {
    const counts = input.scanCounts;
    lines.push(
      `| ${SEVERITIES.map(upperFirst).join(" | ")} |`,
      `|${SEVERITIES.map(() => "---").join("|")}|`,
      `| ${SEVERITIES.map((s) => String(counts[s] ?? 0)).join(" | ")} |`,
    );
  }

  lines.push(
    "",
    "## Review checklist",
    "",
    ...buildChecks(input),
    "- [ ] Every edit keeps the app's behaviour the same.",
    "- [ ] No secret values appear anywhere in this diff.",
  );
  if (input.changes.some((c) => c.kind === "secret-removal")) {
    lines.push(
      "- [ ] Rotate every secret that was hard-coded: the old values stay in the git history.",
    );
  }
  if (input.addedDependencies.length > 0) {
    lines.push("- [ ] The new dependencies are needed and trustworthy.");
  }
  if (input.changes.some((c) => c.status === "pending")) {
    lines.push('- [ ] Finish the changes marked "to do" above (or push them to this branch).');
  }

  lines.push("", "---", "", PULL_REQUEST_FOOTER);
  return `${lines.join("\n")}\n`;
}
