import type { GitHubClient } from "@opscrew/connector-github";
import { checkDiskVia } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { githubClientFromToken } from "../shared/github";
import type { CheckSettings } from "./settings";

/** What design reads of the repository for the check: GitHub's answers (a client or a fake). */
export type CheckRepositoryApi = Pick<GitHubClient, "getRepo" | "includedMinutes">;

/** What GitHub said about the repository; each field absent when it is not known. */
export interface CheckRepositoryFacts {
  public?: boolean;
  /** The Actions minutes a month the owner's plan includes for private repositories. */
  includedMinutes?: number;
  /** Only `false` means the repository's issues are off. */
  hasIssues?: boolean;
}

/** GitHub Free's included Actions minutes a month, counted when the owner's plan is unknown. */
const FREE_MINUTES = 2_000;

/** The most minutes a month the check may use in a private repository on GitHub Free (FR-1710). */
const FREE_SHARE_MINUTES = 750;

/**
 * How many `ubuntu-slim` minutes use one included minute: GitHub prices slim at $0.002 a minute
 * and the 2-core Linux runner the included minutes are counted in at $0.006.
 */
const SLIM_PER_INCLUDED = 3;

/**
 * The `ubuntu-slim` minutes a month the check's job on GitHub's machines uses at `interval`
 * minutes: one run a time, each billed as a whole minute, over a 31-day month.
 */
export function checkMinutes(interval: number): number {
  return (60 / interval) * 24 * 31;
}

/** The interval the check runs at: the repository's setting, else 15 minutes when public, else 60. */
export function checkInterval(settings: CheckSettings | undefined, isPublic: boolean): number {
  return settings?.intervalMinutes ?? (isPublic ? 15 : 60);
}

/**
 * The repository's visibility, issues and (when private) included minutes, from GitHub with
 * `api` (default: the user's token); nothing is known without a GitHub remote, a token or an
 * answer.
 */
export async function readCheckRepository(
  deps: Pick<PhaseDeps, "env" | "runner" | "redactor" | "fetch" | "version">,
  coordinates: { owner?: string; repo?: string },
  api?: CheckRepositoryApi | null,
): Promise<CheckRepositoryFacts> {
  const { owner, repo } = coordinates;
  if (owner === undefined || repo === undefined) return {};
  const github = api === undefined ? await githubClientFromToken(deps) : api;
  if (github === undefined || github === null) return {};
  try {
    const info = await github.getRepo(owner, repo);
    const facts: CheckRepositoryFacts = {
      public: !info.private,
      ...(info.hasIssues === undefined ? {} : { hasIssues: info.hasIssues }),
    };
    if (!info.private) return facts;
    const included = await github.includedMinutes(owner).catch(() => undefined);
    return included === undefined ? facts : { ...facts, includedMinutes: included };
  } catch {
    return {};
  }
}

/** Why the check reads no disk for `plan`'s environment; `undefined` when it reads one. */
function noDiskReason(plan: DeployPlan): string | undefined {
  switch (plan.target.provider) {
    case "portainer":
      return "OpsCrew reaches your Portainer only through its API, never its server";
    case "cloudflare-workers":
      return "Cloudflare's hosting has no server of the app's";
    case "github-pages":
      return "GitHub Pages has no server of the app's";
    default:
      return checkDiskVia(plan) === undefined
        ? "your server is reached through a Cloudflare Tunnel, and the check's SSH can't pass the tunnel's Cloudflare Access login. With the server's own runner (environment.runner: server) the check reads the disk there"
        : undefined;
  }
}

/**
 * What design says about the scheduled check of `plan`'s environment: whether it runs, its
 * interval (the repository's `settings`), what it checks and the Actions minutes a month against
 * the repository's plan (free in a public repository); with warnings when a set interval passes
 * 750 minutes a month on GitHub Free (or an unknown plan) and when the repository's issues are off.
 */
export function checkDesignText(
  plan: DeployPlan,
  settings: CheckSettings | undefined,
  repository: CheckRepositoryFacts,
): { lines: string[]; warnings: string[] } {
  if (plan.target.provider === "localhost") {
    return {
      lines: [
        "Scheduled check: none. GitHub can't reach your computer, so the check that opens an issue when the app is down doesn't apply here.",
      ],
      warnings: [],
    };
  }
  if (plan.observability?.check?.enabled !== true) {
    return {
      lines: [
        "Scheduled check: off for this environment (set observability.check.enabled to true to turn it on).",
      ],
      warnings: [],
    };
  }
  const isPublic = repository.public === true;
  const interval = checkInterval(settings, isPublic);
  const noDisk = noDiskReason(plan);
  const lines = [
    `Scheduled check: every ${interval} minutes in GitHub Actions, one run for every app and environment of the repository. It checks each hostname's health path and certificate${noDisk === undefined ? ", and the server's free disk" : ""}, and opens a GitHub issue when one fails.`,
  ];
  const minutes = checkMinutes(interval);
  const count = (n: number) => n.toLocaleString("en-US");
  const share = count(Math.round(minutes / SLIM_PER_INCLUDED));
  if (isPublic) {
    lines.push("Its Actions minutes are free: the repository is public.");
  } else {
    const included =
      repository.includedMinutes === undefined
        ? `the ${count(FREE_MINUTES)} included minutes of GitHub Free (OpsCrew could not read your plan)`
        : `the ${count(repository.includedMinutes)} included minutes of your GitHub plan`;
    const unknown =
      repository.public === undefined
        ? " OpsCrew could not tell whether the repository is public, so it counts it as private."
        : "";
    lines.push(
      `It uses about ${count(minutes)} ubuntu-slim minutes a month (each run counts as a whole minute), about ${share} of ${included}: a slim minute uses a third of an included one.${unknown}`,
    );
  }
  if (noDisk !== undefined) lines.push(`The check reads no disk here: ${noDisk}.`);
  const warnings: string[] = [];
  const onFree =
    repository.includedMinutes === undefined || repository.includedMinutes === FREE_MINUTES;
  if (
    settings?.intervalMinutes !== undefined &&
    !isPublic &&
    onFree &&
    minutes > FREE_SHARE_MINUTES
  ) {
    warnings.push(
      `observability.check.intervalMinutes is ${interval}, so the check uses about ${count(minutes)} ubuntu-slim minutes a month (about ${share} of the ${count(FREE_MINUTES)} included minutes of GitHub Free), more than the ${FREE_SHARE_MINUTES} OpsCrew keeps it to on a private repository; without a payment method GitHub stops every job once the included minutes run out, deploys included. Remove it from opscrew/plan.yaml for the default (every 60 minutes), or set 60.`,
    );
  }
  if (repository.hasIssues === false) {
    warnings.push(
      "The repository's issues are off, so the check can't open an issue when something fails: it reports through its failed run (and the webhook, when set) only. Turn issues on in the repository's Settings → General → Features.",
    );
  }
  return { lines, warnings };
}
