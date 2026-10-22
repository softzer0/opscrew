/**
 * A self-hosted runner's state for `status` and `secure` (FR-1530): registered and online or
 * offline, its version against GitHub's releases (GitHub stops sending jobs to a runner 30 days
 * after a release it did not take), and the repository's visibility with its fork-PR policy.
 */
import type { ForkPrApprovalPolicy } from "@opscrew/connector-github";
import type { CheckResult } from "@opscrew/contracts";
import { errorText, isUserFacingError, plural, upperFirst } from "@opscrew/core";
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { checkResult } from "../shared";
import {
  type RunnerGitHubApi,
  type RunnerRepository,
  runnerRepository,
  SAFE_FORK_PR_POLICY,
} from "./github";
import { planWhere } from "./words";

/** GitHub's runner releases, newest first (the first page is months of them). */
const RELEASES_URL = "https://api.github.com/repos/actions/runner/releases?per_page=30";

/** A runner this many days behind a release it did not take is warned about (GitHub stops at 30). */
const BEHIND_DAYS = 21;

const ReleasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    published_at: z.string().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
);

/** What `runnerStatus` found. */
export interface RunnerStatus {
  /** GitHub lists a runner with the environment's label. */
  registered: boolean;
  online?: boolean;
  version?: string;
  /** More than 21 days behind a newer GitHub release; undefined when the releases were unreadable. */
  behind?: boolean;
  /** GitHub's newest runner release, when it was read. */
  latest?: string;
  visibility: "public" | "private" | "internal";
  /** A public repository's approval policy for fork pull requests. */
  forkPrApproval?: ForkPrApprovalPolicy;
}

/** `2.338.0` as numbers; undefined for anything else. */
function versionOf(text: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null ? undefined : match.slice(1).map(Number);
}

/** True when version `a` is older than `b`. */
function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * GitHub's published runner releases newer than `version`, oldest first, and the newest release;
 * undefined when GitHub's release list could not be read.
 */
async function releasesAfter(
  deps: Pick<PhaseDeps, "fetch">,
  version: string | undefined,
): Promise<{ newer: { version: string; publishedAt: Date }[]; latest?: string } | undefined> {
  let json: unknown;
  try {
    const response = await deps.fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return undefined;
    json = await response.json();
  } catch {
    return undefined;
  }
  const parsed = ReleasesSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const releases = parsed.data.flatMap((release) => {
    const parts = versionOf(release.tag_name);
    return release.draft || release.prerelease || parts === undefined || !release.published_at
      ? []
      : [{ version: parts.join("."), parts, publishedAt: new Date(release.published_at) }];
  });
  const current = version === undefined ? undefined : versionOf(version);
  const newer = releases
    .filter((release) => current !== undefined && older(current, release.parts))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  const latest = releases.reduce<(typeof releases)[number] | undefined>(
    (top, release) => (top === undefined || older(top.parts, release.parts) ? release : top),
    undefined,
  );
  return {
    newer: newer.map(({ version: v, publishedAt }) => ({ version: v, publishedAt })),
    ...(latest !== undefined ? { latest: latest.version } : {}),
  };
}

/**
 * The environment's self-hosted runner as GitHub lists it (its label `opscrew-<app>-<env>`), its
 * version against GitHub's runner releases, and the repository's visibility with, for a public
 * one, its fork-PR approval policy (contracts/runners.md "Agents"). Read-only.
 */
export async function runnerStatus(
  deps: Pick<PhaseDeps, "fetch" | "clock">,
  repository: RunnerRepository,
  plan: DeployPlan,
): Promise<RunnerStatus> {
  const { api, owner, repo } = repository;
  const visibility = await api.repositoryVisibility(owner, repo);
  const forkPrApproval =
    visibility === "public" ? await api.forkPrApprovalPolicy(owner, repo) : undefined;
  const label = runnerLabel(plan);
  const runners = (await api.listRunners(owner, repo)).filter((r) => r.labels.includes(label));
  const runner = runners.find((r) => r.status === "online") ?? runners[0];
  const releases = runner === undefined ? undefined : await releasesAfter(deps, runner.version);
  const now = deps.clock.now().getTime();
  const behind =
    releases === undefined || runner?.version === undefined
      ? undefined
      : releases.newer.some((r) => now - r.publishedAt.getTime() > BEHIND_DAYS * 86_400_000);
  return {
    registered: runner !== undefined,
    ...(runner !== undefined ? { online: runner.status === "online" } : {}),
    ...(runner?.version !== undefined ? { version: runner.version } : {}),
    ...(behind !== undefined ? { behind } : {}),
    ...(releases?.latest !== undefined ? { latest: releases.latest } : {}),
    visibility,
    ...(forkPrApproval !== undefined ? { forkPrApproval } : {}),
  };
}

/** `the server's runner` or `the local runner`. */
function runnerWords(plan: DeployPlan): string {
  return plan.environment?.runner === "local" ? "the local runner" : "the server's runner";
}

/** The command that brings the runner back. */
function fix(plan: DeployPlan): string {
  const env = plan.environment?.name ?? "prod";
  return plan.environment?.runner === "local"
    ? `\`opscrew runner start --env ${env}\``
    : `\`opscrew provision${planWhere(plan).flag}\``;
}

/**
 * The environment's runner as GitHub has it, for `status` and `secure`: none on GitHub's
 * machines; `unreadable` says why GitHub could not be read.
 */
async function readRunner(
  deps: PhaseDeps,
  plan: DeployPlan,
  api: RunnerGitHubApi | undefined,
): Promise<RunnerStatus | { unreadable: string } | undefined> {
  if ((plan.environment?.runner ?? "github") === "github") return undefined;
  try {
    return await runnerStatus(deps, await runnerRepository(deps, api), plan);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { unreadable: errorText(error) };
  }
}

/**
 * The runner's checks for `secure` (FR-1530), none on GitHub's machines: offline is a warning, as
 * is a version more than 21 days behind a newer GitHub release; a public repository whose outside
 * contributors' workflow runs need no approval fails as high. A local runner that is not running
 * passes (it runs only while started). Skipped when GitHub could not be read.
 */
export async function runnerChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  api?: RunnerGitHubApi,
): Promise<CheckResult[]> {
  const status = await readRunner(deps, plan, api);
  if (status === undefined) return [];
  const label = runnerLabel(plan);
  const which = runnerWords(plan);
  if ("unreadable" in status) {
    return [
      checkResult(
        "runner",
        `The self-hosted runner ${label} is online and current`,
        "medium",
        "skip",
        `OpsCrew could not read ${which} at GitHub. ${status.unreadable}`,
      ),
    ];
  }
  const results: CheckResult[] = [];
  const local = plan.environment?.runner === "local";
  const online = `The self-hosted runner ${label} is online`;
  if (!status.registered) {
    results.push(
      local
        ? checkResult(
            "runner-online",
            online,
            "low",
            "pass",
            `The local runner is not running; it runs only while ${fix(plan)} does.`,
          )
        : checkResult(
            "runner-online",
            online,
            "medium",
            "warn",
            "GitHub lists no runner for this environment, so its deploy jobs wait.",
            { remediation: `Run ${fix(plan)}, which installs it again.` },
          ),
    );
  } else if (status.online === false) {
    results.push(
      checkResult(
        "runner-online",
        online,
        "medium",
        "warn",
        `GitHub lists ${which} as offline, so the environment's deploy jobs wait.`,
        {
          remediation: local
            ? `Start it with ${fix(plan)}.`
            : `Check that the server is up, then run ${fix(plan)}, which starts it again.`,
        },
      ),
    );
  } else {
    results.push(
      checkResult("runner-online", online, "medium", "pass", `${upperFirst(which)} is online.`),
    );
  }
  if (status.behind === true) {
    results.push(
      checkResult(
        "runner-version",
        `The self-hosted runner ${label} takes GitHub's runner releases`,
        "medium",
        "warn",
        `${upperFirst(which)} runs ${status.version}, over ${plural(BEHIND_DAYS, "day")} behind a newer release (GitHub's newest is ${status.latest}); GitHub stops sending it jobs 30 days after a release.`,
        {
          remediation: `Run ${fix(plan)}: it installs the pinned runner, which then updates itself.`,
        },
      ),
    );
  }
  if (status.visibility === "public") {
    const safe = status.forkPrApproval === SAFE_FORK_PR_POLICY;
    results.push(
      checkResult(
        "runner-public-repository",
        "Outside contributors' workflow runs need approval before the self-hosted runner runs them",
        "high",
        safe ? "pass" : "fail",
        safe
          ? "The repository is public, and every outside contributor's workflow runs need your approval first."
          : `The repository is public, and outside contributors' workflow runs need no approval from you (its policy is ${status.forkPrApproval}): a pull request from a fork could run its own code on ${which}'s machine.`,
        safe
          ? {}
          : {
              remediation: `Run ${fix(plan)}, which asks to require approval for every outside contributor, make the repository private, or set environment.runner to github.`,
            },
      ),
    );
  }
  return results;
}

/** The runner's lines in `status`: none on GitHub's machines; redacted. */
export async function runnerStatusLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  api?: RunnerGitHubApi,
): Promise<string[]> {
  const status = await readRunner(deps, plan, api);
  if (status === undefined) return [];
  const heading = `Self-hosted runner (${runnerLabel(plan)}, ${plan.environment?.runner === "local" ? "on this computer" : "on the server"}):`;
  if ("unreadable" in status) {
    return [heading, deps.redactor.redact(`  OpsCrew could not read it. ${status.unreadable}`)];
  }
  const state = !status.registered
    ? plan.environment?.runner === "local"
      ? `not running (start it with ${fix(plan)})`
      : `not registered (run ${fix(plan)})`
    : status.online
      ? "online"
      : `offline (${plan.environment?.runner === "local" ? `start it with ${fix(plan)}` : `check the server, then run ${fix(plan)}`})`;
  const lines = [heading, `  ${state}`];
  if (status.version !== undefined) {
    lines.push(
      `  version ${status.version}${status.latest !== undefined ? ` (GitHub's newest: ${status.latest})` : ""}${status.behind === true ? `, over ${BEHIND_DAYS} days behind: run ${fix(plan)}` : ""}`,
    );
  }
  lines.push(
    status.visibility === "public"
      ? status.forkPrApproval === SAFE_FORK_PR_POLICY
        ? "  repository: public; outside contributors' workflow runs need your approval"
        : `  repository: public, and outside contributors' workflow runs need no approval: run ${fix(plan)} to require it`
      : `  repository: ${status.visibility}`,
  );
  return lines.map((line) => deps.redactor.redact(line));
}
