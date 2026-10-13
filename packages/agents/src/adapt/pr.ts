import { SEVERITIES, type Severity } from "@opscrew/contracts";
import type { CodeChangeKind } from "@opscrew/plan-schema";
import type { CodeChange } from "../design";

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
  notes?: Readonly<Record<string, string>>;
  /** Finding counts from the last `opscrew scan`, when one exists. */
  scanCounts?: Partial<Record<Severity, number>>;
  /** Repo-relative report and artefact files included in the branch. */
  reports: readonly string[];
  /** GitHub repository and branch, used to link the reports. */
  repo?: { owner: string; repo: string };
  branch?: string;
  /** App name, container port and health path from the plan, for the review checklist. */
  app?: { name: string; port: number; healthPath: string };
  /** Packages the Code-change agent added. */
  addedDependencies?: readonly string[];
  /** Ids of the changes OpsCrew made itself (templates and deterministic edits). */
  byOpsCrew?: readonly string[];
  /**
   * The file a change was really made in, by change id, when it differs from the plan's path
   * (for example `route.js` where the plan says `route.ts`).
   */
  paths?: Readonly<Record<string, string>>;
}

/** What a missing health endpoint means for deploys, in one plain sentence. */
export function healthCheckWarning(healthPath: string): string {
  return `Until GET ${healthPath} answers 200, every deploy fails its health check and is rolled back.`;
}

function link(path: string, input: PullRequestBodyInput): string {
  if (input.repo === undefined || input.branch === undefined) return `\`${path}\``;
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
  const byOpsCrew = new Set(input.byOpsCrew ?? []);
  for (const change of input.changes) {
    lines.push(
      ...changeLine(
        change,
        input.notes?.[change.id],
        byOpsCrew.has(change.id),
        input.paths?.[change.id],
      ),
    );
  }
  const health = input.app?.healthPath ?? "/health";
  if (input.changes.some((c) => c.kind === "health-endpoint" && c.status === "pending")) {
    lines.push("", `**${healthCheckWarning(health)}**`);
  }
  if ((input.addedDependencies ?? []).length > 0) {
    lines.push("", "New dependencies added by the Code-change agent:");
    for (const dependency of input.addedDependencies ?? []) lines.push(`- \`${dependency}\``);
  }

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
      `| ${SEVERITIES.map((s) => s[0]?.toUpperCase() + s.slice(1)).join(" | ")} |`,
      `|${SEVERITIES.map(() => "---").join("|")}|`,
      `| ${SEVERITIES.map((s) => String(counts[s] ?? 0)).join(" | ")} |`,
    );
  }

  const name = input.app?.name ?? "app";
  const port = input.app?.port ?? 3000;
  lines.push(
    "",
    "## Review checklist",
    "",
    `- [ ] The image builds: \`docker build -t ${name} .\``,
    `- [ ] The container starts and \`http://localhost:${port}${health}\` answers 200: \`docker run --rm -p ${port}:${port} --env-file .env ${name}\``,
    "- [ ] Every edit keeps the app's behaviour the same.",
    "- [ ] No secret values appear anywhere in this diff.",
  );
  if (input.changes.some((c) => c.kind === "secret-removal")) {
    lines.push(
      "- [ ] Rotate every secret that was hard-coded: the old values stay in the git history.",
    );
  }
  if ((input.addedDependencies ?? []).length > 0) {
    lines.push("- [ ] The new dependencies are needed and trustworthy.");
  }
  if (input.changes.some((c) => c.status === "pending")) {
    lines.push('- [ ] Finish the changes marked "to do" above (or push them to this branch).');
  }

  lines.push("", "---", "", PULL_REQUEST_FOOTER);
  return `${lines.join("\n")}\n`;
}
