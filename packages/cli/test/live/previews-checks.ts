/**
 * What feature 022's live passes (`previews.test.ts` and `previews-shared.test.ts`, docs/e2e.md
 * "Previews" and "Previews on dev's server") share on top of the harness: prod deployed from the
 * seeded throwaway copy of `examples/koa-knex`, the page `/e2e`, `provision --env preview` until it
 * is done, and the pull requests of a pass with their preview runs and comments. Everything logged
 * goes through the run's scrubber.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { type CloudflareZone, httpRequest, minutes, retryDelete, waitFor } from "./cloud";
import { type AppEnvironments, designProd } from "./environment-checks";
import { EXAMPLES, type LiveRun, type ServerSettings } from "./harness";
import {
  type CommentState,
  commentState,
  E2E_PATH,
  e2eOverlay,
  e2ePage,
  MARKER_FILE,
  markerJson,
  PREVIEW_ENV,
  PREVIEW_VALUE,
  PREVIEWS_EXAMPLE,
  previewAddressPattern,
  previewComments,
  previewRunProblem,
  type RunExpectation,
  secretsRefusedFor,
} from "./previews-support";
import { approveHashes, leakedLabels } from "./support";

/**
 * `<origin>/e2e`: the marker, the seeded rows, the `X-Robots-Tag` header and whether Cloudflare
 * answered (its `cf-ray` header).
 */
export async function previewPage(
  origin: string,
): Promise<ReturnType<typeof e2ePage> & { robots: string; viaCloudflare: boolean }> {
  const answer = await httpRequest(`${origin}${E2E_PATH}`, { timeoutMs: 15_000 });
  if (answer.status !== 200) throw new Error(`${origin}${E2E_PATH} answered ${answer.status}.`);
  return {
    ...e2ePage(answer.body),
    robots: String(answer.headers["x-robots-tag"] ?? ""),
    viaCloudflare: answer.headers["cf-ray"] !== undefined,
  };
}

/**
 * `examples/koa-knex` with a seed, a page of its rows and a marker (in the throwaway copy only)
 * deployed as prod at Hetzner behind Cloudflare; prod's page answers the marker `main`, no row and
 * no preview value.
 */
export async function deploySeededProd(
  run: LiveRun,
  envs: AppEnvironments,
  settings: ServerSettings,
): Promise<void> {
  const overlay = await mkdtemp(join(tmpdir(), "opscrew-e2e-previews-overlay-"));
  try {
    const index = await readFile(join(EXAMPLES, PREVIEWS_EXAMPLE, "index.js"), "utf8");
    for (const [path, text] of Object.entries(e2eOverlay(index))) {
      await mkdir(dirname(join(overlay, path)), { recursive: true });
      await writeFile(join(overlay, path), text);
    }
    await run.prepareRepo({
      commit: `e2e: examples/${settings.app} with a seed, for previews`,
      env: {
        HCLOUD_TOKEN: settings.hcloudToken,
        CLOUDFLARE_API_TOKEN: settings.cloudflareToken,
      },
      overlay,
    });
    // The app reads the preview value, so every environment is asked for one too: a value that
    // isn't a preview's.
    await appendFile(join(run.work, "production.env"), `${PREVIEW_VALUE}=prod\n`);
  } finally {
    await rm(overlay, { recursive: true, force: true });
  }
  await envs.snapshotGithub();
  await designProd(run, envs, settings.region);
  await run.adaptAndMerge();
  await envs.provision("prod", "prod");
  await run.deployAny("prod's first deploy");
  await run.waitForHealth();
  const prod = await previewPage(`https://${run.appHost}`);
  expect(prod, "prod's page: the marker of main, no row").toMatchObject({
    marker: "main",
    rows: [],
    previewValue: "unset",
  });
}

/**
 * `provision --env preview` in a script, until it is done: `--plan-only`, then each plan hash a
 * run printed approved (`--approve <hash>`: the IaC plan, the server's host plans, and the
 * previews host plan, whose refusal prints the command with its hash) with `--confirm <app>`, the
 * typed name of the recipe that deletes previews' data (`app`, the preview environment's). Stops
 * at the secrets check's refusal, which only a run that applies makes: `refused` then names the
 * environments it says to provision first ({@link secretsRefusedFor}). Returns every run's output.
 */
export async function provisionPreviews(
  run: LiveRun,
  app: string,
): Promise<{ refused: string[]; output: string }> {
  const cli = (...args: string[]) => run.opscrew("provision", "--env", PREVIEW_ENV, ...args);
  const planned = await cli("--plan-only", "--yes");
  if (planned.exitCode !== 0) {
    throw new Error(
      `opscrew provision --env preview --plan-only exited with ${planned.exitCode}:\n${run.tail(planned.output)}`,
    );
  }
  const outputs = [planned.output];
  const approved = approveHashes(planned.output);
  for (let round = 1; round <= 5; round++) {
    const confirm = approved.length === 0 ? [] : ["--confirm", app];
    const applied = await cli(
      ...approved.flatMap((hash) => ["--approve", hash]),
      ...confirm,
      "--yes",
    );
    outputs.push(applied.output);
    const output = outputs.join("\n");
    if (applied.exitCode === 0) return { refused: [], output };
    const refused = secretsRefusedFor(applied.output);
    if (refused.length > 0) return { refused, output };
    const next = approveHashes(applied.output).filter((hash) => !approved.includes(hash));
    if (next.length === 0) {
      throw new Error(
        `opscrew provision --env preview exited with ${applied.exitCode}:\n${run.tail(applied.output)}`,
      );
    }
    run.log("provision --env preview stopped at another plan; approving the hash it printed");
    approved.push(...next);
  }
  throw new Error("opscrew provision --env preview did not finish after 5 rounds of plans.");
}

/** The wildcard records `*.<zone>` in the preview zone. */
export async function wildcardRecords(run: LiveRun, zone: CloudflareZone) {
  return (await run.cloudflare.zoneRecords(zone)).filter((r) => r.name === `*.${zone.name}`);
}

/**
 * The cleanup's last part: removes the previews' wildcard records left in the preview zone `zone`
 * (the pass may stop before `destroy --env preview`); one a finished destroy (`destroyed`) left is
 * a problem. Returns the problems.
 */
export async function removeWildcards(
  run: LiveRun,
  zone: CloudflareZone,
  destroyed: boolean,
): Promise<string[]> {
  const problems: string[] = [];
  for (const record of await wildcardRecords(run, zone)) {
    const what = `${record.type} ${record.name}`;
    const removed = await retryDelete(() =>
      run.cloudflare.call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`),
    );
    if (!removed) problems.push(`Cloudflare did not delete ${what}`);
    else if (destroyed) problems.push(`destroy left ${what}; the cleanup removed it`);
  }
  return problems;
}

/**
 * A pull request of a pass: its number, branch and head commit, and its preview's address once
 * its comment gave it (`https://pr-<n>-<random>.<zone>`, kept for the preview's updates).
 */
export interface Pull {
  name: string;
  number: number;
  branch: string;
  head: string;
  address?: string;
}

/**
 * The pull requests of a pass, opened, pushed to and closed through the GitHub API from branches
 * of the throwaway repository, with the preview runs they start and the comments they get. Set
 * `app`, `zone` and `workflow` once the preview environment is designed.
 */
export class PreviewPulls {
  /** The pass's pull requests, for the cleanup and the leak search. */
  readonly pulls: Pull[] = [];
  /** Every preview run the pass waited for: the leak search reads their logs. */
  readonly runs: number[] = [];
  /** The preview environment's app name (`<app>-preview`). */
  app = "";
  /** The previews' domain. */
  zone = "";
  /** The preview workflow's file name. */
  workflow = "";

  constructor(private readonly run: LiveRun) {}

  private get repo(): string {
    return `/repos/${this.run.github.name}`;
  }

  /** The pull request's preview address, once its comment gave it. */
  address(pull: Pull): string {
    if (pull.address === undefined) {
      throw new Error(`No comment gave pull request ${pull.name}'s preview address yet.`);
    }
    return pull.address;
  }

  /** Waits up to 5 minutes until the pull request's preview serves `marker`. */
  serving(pull: Pull, marker: string) {
    return waitFor(
      `${this.address(pull)}${E2E_PATH} serving the marker ${marker}`,
      minutes(5),
      async () => {
        const answer = await previewPage(this.address(pull));
        return answer.marker === marker ? answer : undefined;
      },
      10_000,
    );
  }

  /** Commits `marker` on `branch` (created from `main`), pushes it and returns the commit. */
  private async commitMarker(branch: string, marker: string, create: boolean): Promise<string> {
    const { run } = this;
    await run.git("checkout", "-q", ...(create ? ["-b", branch, "main"] : [branch]));
    try {
      await writeFile(join(run.repo, MARKER_FILE), markerJson(marker));
      await run.git("add", MARKER_FILE);
      await run.git("commit", "-q", "-m", `e2e: the preview marker ${marker}`);
      await run.git("push", "-q", ...(create ? ["-u"] : []), "origin", branch);
      return await run.git("rev-parse", "HEAD");
    } finally {
      await run.git("checkout", "-q", "main");
    }
  }

  /** Opens pull request `name` from a branch of its own that changes the marker. */
  async open(name: string, marker: string): Promise<Pull> {
    const branch = `e2e/preview-${name}-${this.run.runId}`;
    const head = await this.commitMarker(branch, marker, true);
    const number = await this.run.github.createPullRequest(`e2e: preview ${name}`, branch);
    const pull = { name, number, branch, head };
    this.pulls.push(pull);
    this.run.log(`opened pull request ${name}, #${number}`);
    return pull;
  }

  async pushTo(pull: Pull, marker: string): Promise<void> {
    pull.head = await this.commitMarker(pull.branch, marker, false);
    this.run.log(`pushed the marker ${marker} to pull request ${pull.name}`);
  }

  async close(pull: Pull): Promise<void> {
    const closed = await this.run.github.call("PATCH", `${this.repo}/pulls/${pull.number}`, {
      state: "closed",
    });
    if (closed.status !== 200) {
      throw new Error(`GitHub did not close pull request ${pull.name} (HTTP ${closed.status}).`);
    }
    this.run.log(`closed pull request ${pull.name}`);
  }

  /**
   * Waits for the preview workflow's run of the pull request's head (created at or after
   * `since`), which must end as `expected` says.
   */
  async previewRun(
    pull: Pull,
    expected: RunExpectation,
    what: string,
    since?: Date,
  ): Promise<void> {
    this.run.log(`waiting for the preview run of ${what} (up to 30 minutes)`);
    const found = await this.run.github.waitForDeploy({
      headSha: pull.head,
      workflow: this.workflow,
      event: "pull_request",
      ...(since === undefined ? {} : { since }),
    });
    this.runs.push(found.id);
    const problem = previewRunProblem(found, expected);
    if (problem !== undefined)
      throw new Error(`The preview run ${found.id} (${what}): ${problem}.`);
    this.run.log(`preview run ${found.id} (${what}) ended ${found.conclusion}, as expected`);
  }

  /** The pull request's comments, as GitHub lists them. */
  async comments(pull: Pull): Promise<unknown> {
    const got = await this.run.github.call(
      "GET",
      `${this.repo}/issues/${pull.number}/comments?per_page=100`,
    );
    if (got.status !== 200) {
      throw new Error(`pull request ${pull.name}'s comments unread (HTTP ${got.status})`);
    }
    return got.json;
  }

  /** The one preview comment on the pull request, by what it says. */
  async comment(pull: Pull): Promise<CommentState> {
    const bodies = previewComments(await this.comments(pull), this.app);
    expect(bodies.length, `the preview comments on pull request ${pull.name}`).toBe(1);
    const body = bodies[0] as string;
    const state = commentState(body);
    if (state.state === "unknown") {
      throw new Error(
        `The preview comment on pull request ${pull.name} says something else:\n${this.run.tail(body, 10)}`,
      );
    }
    return state;
  }

  /**
   * The comment says the preview runs the head commit at `pr-<n>-<random>.<zone>`, the same
   * address as before once it had one; the pull request keeps it.
   */
  async expectRunningComment(pull: Pull): Promise<void> {
    const said = await this.comment(pull);
    expect(said, `the comment on pull request ${pull.name}`).toEqual({
      state: "running",
      address: pull.address ?? expect.stringMatching(previewAddressPattern(pull.number, this.zone)),
      commit: pull.head.slice(0, 12),
    });
    if (said.state === "running") pull.address = said.address;
  }

  /**
   * The pass's part of the leak search (SC-2204): no known value (the servers' addresses
   * included) in any comment of its pull requests, and no secret in the log of any job of the
   * preview runs it waited for (each job's log read through GitHub's API; reading none is a
   * finding). Returns the problems.
   */
  async leaks(): Promise<string[]> {
    const { run } = this;
    const problems: string[] = [];
    const known = run.scrubber.entries();
    const secrets = known.filter(({ label }) => !label.startsWith("server-"));
    for (const pull of this.pulls) {
      let comments: { body?: string | null }[] | undefined;
      try {
        comments = (await this.comments(pull)) as typeof comments;
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const text = (comments ?? []).map((c) => c.body ?? "").join("\n");
      const found = leakedLabels(text, known);
      if (found.length > 0) {
        problems.push(`the comments on pull request ${pull.name} contain: ${found.join(", ")}`);
      }
    }
    let logs = 0;
    for (const id of this.runs) {
      const jobs = await run.github.call(
        "GET",
        `${this.repo}/actions/runs/${id}/jobs?per_page=100`,
      );
      const list =
        (jobs.json as { jobs?: { id: number; name: string; conclusion: string | null }[] })?.jobs ??
        [];
      for (const job of list.filter((j) => j.conclusion !== "skipped")) {
        const got = await run.github.redirectedText(`${this.repo}/actions/jobs/${job.id}/logs`);
        if (got.status !== 200) continue;
        logs++;
        const found = leakedLabels(got.text, secrets);
        if (found.length > 0) {
          problems.push(
            `the log of "${job.name}" in preview run ${id} contains: ${found.join(", ")}`,
          );
        }
      }
    }
    run.log(`observed: the leak search read ${logs} preview workflow job logs`);
    if (this.runs.length > 0 && logs === 0) {
      run.findings.push("no preview workflow log could be read, so the leak search read none");
    }
    return problems;
  }

  /**
   * The cleanup's first part, while the preview server may still run: each pull request still
   * open is closed and its preview run awaited until `deadline` (its remove job takes the preview
   * down and deletes its images), so no preview run starts after the cleanup removed the GitHub
   * environments. Returns what went wrong.
   */
  async closeOpen(deadline: number): Promise<string[]> {
    const problems: string[] = [];
    for (const pull of this.pulls) {
      try {
        const state = await this.run.github.call("GET", `${this.repo}/pulls/${pull.number}`);
        if ((state.json as { state?: string } | undefined)?.state !== "open") continue;
        const since = new Date();
        await this.close(pull);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("no time was left to wait for its preview run");
        const found = await this.run.github.waitForDeploy(
          { headSha: pull.head, workflow: this.workflow, event: "pull_request", since },
          left,
        );
        this.run.log(
          `pull request ${pull.name}'s preview run ${found.id} ended ${found.conclusion}`,
        );
      } catch (error) {
        problems.push(
          `close pull request ${pull.name} and wait for its preview run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return problems;
  }
}
