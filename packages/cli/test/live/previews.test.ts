/**
 * The live test of feature 022 (docs/e2e.md "Previews", plan.md "10."), with
 * `OPSCREW_E2E_PREVIEWS=1`: `examples/koa-knex` (Postgres, Knex migrations) with a seed, a page of
 * the seeded rows and a marker each pull request changes, added in the throwaway copy only, as
 * prod at Hetzner behind Cloudflare; then `env add preview --previews --cap 1 --lifetime 1
 * --domain <OPSCREW_E2E_PREVIEW_DOMAIN>`, the secrets check, `provision --env preview` with the
 * recipe approved by its hash and the typed `<app>-preview`, and the deploy-setup pull request
 * merged. Pull request A gets its preview (an address `pr-<n>-<random>.<zone>` served through
 * Cloudflare only, A's commit, the seeded rows, `noindex`, the comment, the list, its deployment), a push
 * updates it with its generated passwords kept, B gets the cap comment, the restricted key is
 * refused everything outside the contract with nothing changed, closing A removes everything of
 * its preview, a push to B gives B its preview; then `preview destroy`, `destroy --env preview`,
 * prod unchanged throughout (SC-2205), prod's destroy and the leak search (SC-2204).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { githubEnvironment, previewWorkflowPath } from "@opscrew/iac-templates";
import { afterAll, describe, expect } from "vitest";
import {
  api,
  type CloudflareZone,
  canConnect,
  DEPLOY_WORKFLOW,
  GITHUB_API,
  httpRequest,
  minutes,
  retryDelete,
  sleep,
  waitFor,
} from "./cloud";
import {
  AppEnvironments,
  designProd,
  planHash,
  readGithubEnvironment,
  secretsRecord,
} from "./environment-checks";
import { EXAMPLES, LiveRun, serverSettings } from "./harness";
import { repoInfo, secretNames } from "./portainer-cloud";
import {
  CAPPED,
  type CommentState,
  commentState,
  deploymentStatus,
  E2E_PATH,
  e2eOverlay,
  e2ePage,
  keyRefusals,
  leftovers,
  leftoversCommand,
  MARKER_FILE,
  markerJson,
  PREVIEW_ENV,
  PREVIEW_VALUE,
  PREVIEWS_E2E_VARIABLES,
  PREVIEWS_EXAMPLE,
  PREVIEWS_GATE,
  previewAddressPattern,
  previewComments,
  previewDir,
  previewList,
  previewRunProblem,
  previewsPlanProblems,
  previewValues,
  pullImageTags,
  REMOVED,
  type RunExpectation,
  refusedForProd,
  SEED_ROWS,
  STARTED,
  serverReply,
  serverStateCommand,
} from "./previews-support";
import { approveHashes, leakedLabels, missingVariables } from "./support";

const MISSING = missingVariables(process.env, PREVIEWS_GATE, PREVIEWS_E2E_VARIABLES);
/** Always this example: Postgres, a release command, and a seed the throwaway copy adds. */
const SETTINGS = { ...serverSettings(process.env), app: PREVIEWS_EXAMPLE };
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
/** The previews' own domain: a Cloudflare zone of the token's used for nothing else. */
const PREVIEW_DOMAIN = process.env.OPSCREW_E2E_PREVIEW_DOMAIN?.trim().toLowerCase() ?? "";

if (process.env[PREVIEWS_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (previews): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Previews").`,
  );
}

/**
 * A pull request of the run: its number, branch and head commit, and its preview's address once
 * its comment gave it (`https://pr-<n>-<random>.<zone>`, kept for the preview's updates).
 */
interface Pull {
  name: string;
  number: number;
  branch: string;
  head: string;
  address?: string;
}

/** What prod's unchanged state is compared by (SC-2205). */
interface ProdState {
  /** `opscrew/plan.yaml` as it is on this computer. */
  plan: string;
  /** Where GitHub keeps prod's deploy secrets: their GitHub environment, or the repository. */
  secretsIn: string;
  /** The names of prod's deploy secrets GitHub has there, sorted. */
  secrets: string[];
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live previews (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live previews: examples/${SETTINGS.app}, prod and its previews at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "previews",
      name: "previews",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    const repo = () => `/repos/${run.github.name}`;
    /** The run's pull requests, for the cleanup and the leak search. */
    const pulls: Pull[] = [];
    /** Every preview run the pass waited for: the leak search reads their logs. */
    const previewRuns: number[] = [];
    /** The preview environment's app name (`<app>-preview`), preview zone and workflow file. */
    let previewApp = "";
    let base = "";
    let workflow = "";
    /** The preview zone in Cloudflare, once step 2 found it: the cleanup removes its wildcard. */
    let previewZone: CloudflareZone | undefined;
    let prodBefore: ProdState | undefined;
    let pullA: Pull | undefined;
    let pullB: Pull | undefined;
    /** Preview A after its creation: its listed record, its secrets' digest. */
    let firstA:
      | { preview: ReturnType<typeof previewList>["previews"][number] | undefined; secrets: string }
      | undefined;

    const address = (pull: Pull) => {
      if (pull.address === undefined) {
        throw new Error(`No comment gave pull request ${pull.name}'s preview address yet.`);
      }
      return pull.address;
    };
    const pullOf = (pull: Pull | undefined) => {
      if (pull === undefined) throw new Error("An earlier step opened no such pull request.");
      return pull;
    };

    // -------------------------------------------------------------------------------------------
    // Prod (SC-2205).

    async function prodState(): Promise<ProdState> {
      const record = await secretsRecord(envs.paths("prod"));
      if (record === undefined) throw new Error("OpsCrew kept no record of prod's deploy secrets.");
      const there = await secretNames(run.github, record.environment);
      return {
        plan: await readFile(envs.paths("prod").files.plan, "utf8"),
        secretsIn: record.environment ?? "the repository",
        secrets: record.names.filter((name) => there.includes(name)).sort(),
      };
    }

    /**
     * Prod as it was before the previews (SC-2205): its plan file and the names of its deploy secrets
     * where GitHub keeps them, nothing for prod's provision to apply (no change planned), its site
     * answering, and its database never seeded.
     */
    async function expectProdUnchanged(after: string): Promise<void> {
      if (prodBefore === undefined) throw new Error("Step 2 kept no state of prod.");
      expect(await prodState(), `prod's plan and deploy secrets after ${after}`).toEqual(
        prodBefore,
      );
      const planned = await run.opscrewOk("provision", "--env", "prod", "--plan-only", "--yes");
      expect(
        approveHashes(planned.output),
        `nothing to approve for prod after ${after}:\n${run.tail(planned.output)}`,
      ).toEqual([]);
      await run.waitForHealth();
      const prod = await page(`https://${run.appHost}`);
      expect(prod, `prod's page after ${after}`).toMatchObject({
        marker: "main",
        rows: [],
        previewValue: "unset",
      });
      log(`observed: prod unchanged after ${after}`);
    }

    // -------------------------------------------------------------------------------------------
    // The app's page.

    /**
     * `<origin>/e2e`: the marker, the seeded rows, the `X-Robots-Tag` header and whether Cloudflare
     * answered (its `cf-ray` header).
     */
    async function page(
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
     * The preview server's own address refuses web connections from this computer: its firewall
     * lets only Cloudflare reach ports 80 and 443. The address is read as the harness reads it and
     * never printed.
     */
    /** The wildcard records `*.<zone>` in the preview zone. */
    async function wildcardRecords() {
      const zone = previewZone;
      if (zone === undefined) throw new Error("Step 2 found no preview zone.");
      return (await run.cloudflare.zoneRecords(zone)).filter((r) => r.name === `*.${zone.name}`);
    }

    async function expectOnlyCloudflareServed(): Promise<void> {
      const ipv4 = (await readServerAddresses(envs.paths(PREVIEW_ENV))).deployment?.ipv4;
      if (ipv4 === undefined) throw new Error("OpsCrew recorded no preview server.");
      for (const port of [80, 443]) {
        expect(
          await canConnect(ipv4, port),
          `the preview server's port ${port} reached from this computer`,
        ).toBe(false);
      }
      log(
        "observed: the preview server's web ports refuse this computer (only Cloudflare gets in)",
      );
    }

    /** Waits up to 5 minutes until the pull request's preview serves `marker`. */
    function serving(pull: Pull, marker: string) {
      return waitFor(
        `${address(pull)}${E2E_PATH} serving the marker ${marker}`,
        minutes(5),
        async () => {
          const answer = await page(address(pull));
          return answer.marker === marker ? answer : undefined;
        },
        10_000,
      );
    }

    // -------------------------------------------------------------------------------------------
    // Pull requests and the preview workflow.

    /** Commits `marker` on `branch` (created from `main`), pushes it and returns the commit. */
    async function commitMarker(branch: string, marker: string, create: boolean): Promise<string> {
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
    async function openPull(name: string, marker: string): Promise<Pull> {
      const branch = `e2e/preview-${name}-${run.runId}`;
      const head = await commitMarker(branch, marker, true);
      const number = await run.github.createPullRequest(`e2e: preview ${name}`, branch);
      const pull = { name, number, branch, head };
      pulls.push(pull);
      log(`opened pull request ${name}, #${number}`);
      return pull;
    }

    async function pushTo(pull: Pull, marker: string): Promise<void> {
      pull.head = await commitMarker(pull.branch, marker, false);
      log(`pushed the marker ${marker} to pull request ${pull.name}`);
    }

    async function closePull(pull: Pull): Promise<void> {
      const closed = await run.github.call("PATCH", `${repo()}/pulls/${pull.number}`, {
        state: "closed",
      });
      if (closed.status !== 200) {
        throw new Error(`GitHub did not close pull request ${pull.name} (HTTP ${closed.status}).`);
      }
      log(`closed pull request ${pull.name}`);
    }

    /**
     * Waits for the preview workflow's run of the pull request's head (created at or after
     * `since`), which must end as `expected` says.
     */
    async function previewRun(
      pull: Pull,
      expected: RunExpectation,
      what: string,
      since?: Date,
    ): Promise<void> {
      log(`waiting for the preview run of ${what} (up to 30 minutes)`);
      const found = await run.github.waitForDeploy({
        headSha: pull.head,
        workflow,
        event: "pull_request",
        ...(since === undefined ? {} : { since }),
      });
      previewRuns.push(found.id);
      const problem = previewRunProblem(found, expected);
      if (problem !== undefined)
        throw new Error(`The preview run ${found.id} (${what}): ${problem}.`);
      log(`preview run ${found.id} (${what}) ended ${found.conclusion}, as expected`);
    }

    /** The pull request's comments, as GitHub lists them. */
    async function pullComments(pull: Pull): Promise<unknown> {
      const got = await run.github.call(
        "GET",
        `${repo()}/issues/${pull.number}/comments?per_page=100`,
      );
      if (got.status !== 200) {
        throw new Error(`pull request ${pull.name}'s comments unread (HTTP ${got.status})`);
      }
      return got.json;
    }

    /** The one preview comment on the pull request, by what it says. */
    async function comment(pull: Pull): Promise<CommentState> {
      const bodies = previewComments(await pullComments(pull), previewApp);
      expect(bodies.length, `the preview comments on pull request ${pull.name}`).toBe(1);
      const body = bodies[0] as string;
      const state = commentState(body);
      if (state.state === "unknown") {
        throw new Error(
          `The preview comment on pull request ${pull.name} says something else:\n${run.tail(body, 10)}`,
        );
      }
      return state;
    }

    /**
     * The comment says the preview runs the head commit at `pr-<n>-<random>.<zone>`, the same
     * address as before once it had one; the pull request keeps it.
     */
    async function expectRunningComment(pull: Pull): Promise<void> {
      const said = await comment(pull);
      expect(said, `the comment on pull request ${pull.name}`).toEqual({
        state: "running",
        address: pull.address ?? expect.stringMatching(previewAddressPattern(pull.number, base)),
        commit: pull.head.slice(0, 12),
      });
      if (said.state === "running") pull.address = said.address;
    }

    /** `opscrew preview list --env preview --json`. */
    async function listed() {
      return previewList(
        (await run.opscrewOk("preview", "list", "--env", PREVIEW_ENV, "--json")).stdout,
      );
    }

    /**
     * The newest status of the pull request's deployment in the preview environment's GitHub
     * environment reaches `state` (with `url`), within 2 minutes. A repository where the preview
     * environment's secrets are repository secrets (GitHub Free, private) has no GitHub
     * environment, so no deployment: that is logged.
     */
    async function expectDeployment(pull: Pull, state: string, url?: string): Promise<void> {
      const environment = githubEnvironment(await envs.readPlan(PREVIEW_ENV));
      if (environment === undefined) {
        log(
          `observed: the preview environment's secrets are repository secrets here (no GitHub environment), so pull request ${pull.name} has no deployment to check`,
        );
        return;
      }
      const status = await waitFor(
        `pull request ${pull.name}'s deployment in ${environment} being ${state}`,
        minutes(2),
        async () => {
          const list = await run.github.call(
            "GET",
            `${repo()}/deployments?environment=${encodeURIComponent(environment)}&ref=${encodeURIComponent(pull.branch)}&per_page=10`,
          );
          const id = (list.json as { id: number }[] | undefined)?.[0]?.id;
          if (list.status !== 200 || id === undefined) {
            throw new Error(`GitHub lists no deployment of it (HTTP ${list.status}).`);
          }
          const statuses = await run.github.call(
            "GET",
            `${repo()}/deployments/${id}/statuses?per_page=10`,
          );
          const newest = statuses.status === 200 ? deploymentStatus(statuses.json) : undefined;
          return newest?.state === state ? newest : undefined;
        },
        10_000,
      );
      if (url !== undefined)
        expect(status.url, `pull request ${pull.name}'s "View deployment"`).toBe(url);
      log(`observed: pull request ${pull.name}'s deployment is ${state}`);
    }

    // -------------------------------------------------------------------------------------------
    // The preview server and GitHub Container Registry.

    /** What is left of the pull request's preview on the server ({@link leftoversCommand}). */
    async function leftOf(pull: Pull): Promise<string[]> {
      const shell = await envs.shell(PREVIEW_ENV);
      return leftovers(await shell.ok(leftoversCommand(previewApp, pull.number)));
    }

    /**
     * Adds the values the preview server generated for the pull request's preview (its
     * `secrets.env`, read with the deploy key, never shown) to the scrubber, and returns their
     * digest.
     */
    async function previewSecrets(pull: Pull): Promise<string> {
      const shell = await envs.shell(PREVIEW_ENV);
      const text = await shell.ok(`cat ${previewDir(previewApp, pull.number)}/secrets.env`);
      // `<name>=<value>` lines, names such as `postgres-password` (no dotenv names).
      const values = text
        .split(/\r?\n/)
        .map((line) => line.slice(line.indexOf("=") + 1))
        .filter((value) => value.length >= 8);
      for (const value of values) run.scrubber.add(value, "preview-generated-value");
      if (values.length === 0) {
        run.findings.push(
          `preview ${pull.name}'s secrets.env holds no generated value, so the leak search misses its passwords`,
        );
      }
      return sha256(text);
    }

    /** The image tags of pull requests `numbers` in the app's package, with the GHCR read token. */
    async function imageTags(numbers: number[]): Promise<string[]> {
      const { owner, ownerType } = await repoInfo(run.github);
      const scope = ownerType === "Organization" ? "orgs" : "users";
      const name = run.github.name.split("/")[1]?.toLowerCase() ?? "";
      const tags: string[] = [];
      for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
        const got = await api(
          GITHUB_API,
          GHCR_READ_TOKEN,
          "GET",
          `/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(name)}/versions?per_page=100&page=${pageNumber}`,
        );
        if (got.status !== 200) {
          throw new Error(
            `Could not list the image's versions with OPSCREW_E2E_GHCR_READ_TOKEN (HTTP ${got.status}).`,
          );
        }
        tags.push(...pullImageTags(got.json, numbers));
        if ((got.json as unknown[]).length < 100) break;
      }
      return tags;
    }

    /** Waits up to 3 minutes until no image of the pull request is left in GHCR. */
    async function expectImagesGone(pull: Pull): Promise<void> {
      await waitFor(
        `GitHub Container Registry without pull request ${pull.name}'s images`,
        minutes(3),
        async () => ((await imageTags([pull.number])).length === 0 ? true : undefined),
        15_000,
      );
    }

    /**
     * `provision --env preview` in a script, until it is done: `--plan-only`, then each plan hash
     * a run printed approved (`--approve <hash>`: the IaC plan, the server's host plans, and the
     * previews host plan, whose refusal prints the command with its hash) with `--confirm
     * <app>-preview`, the typed name of the recipe that deletes previews' data. Stops at the
     * secrets check's refusal naming prod ({@link refusedForProd}), which only a run that applies
     * makes. Returns every run's output.
     */
    async function provisionPreviews(): Promise<{ refused: boolean; output: string }> {
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
        const confirm = approved.length === 0 ? [] : ["--confirm", previewApp];
        const applied = await cli(
          ...approved.flatMap((hash) => ["--approve", hash]),
          ...confirm,
          "--yes",
        );
        outputs.push(applied.output);
        const output = outputs.join("\n");
        if (applied.exitCode === 0) return { refused: false, output };
        if (refusedForProd(applied.output)) return { refused: true, output };
        const next = approveHashes(applied.output).filter((hash) => !approved.includes(hash));
        if (next.length === 0) {
          throw new Error(
            `opscrew provision --env preview exited with ${applied.exitCode}:\n${run.tail(applied.output)}`,
          );
        }
        log("provision --env preview stopped at another plan; approving the hash it printed");
        approved.push(...next);
      }
      throw new Error("opscrew provision --env preview did not finish after 5 rounds of plans.");
    }

    // -------------------------------------------------------------------------------------------
    // The steps.

    run.step(
      `1. examples/${PREVIEWS_EXAMPLE} with a seed, a page of its rows and a marker (in the throwaway copy only) deployed as prod at Hetzner behind Cloudflare`,
      minutes(60),
      async () => {
        const overlay = await mkdtemp(join(tmpdir(), "opscrew-e2e-previews-overlay-"));
        try {
          const index = await readFile(join(EXAMPLES, PREVIEWS_EXAMPLE, "index.js"), "utf8");
          for (const [path, text] of Object.entries(e2eOverlay(index))) {
            await mkdir(dirname(join(overlay, path)), { recursive: true });
            await writeFile(join(overlay, path), text);
          }
          await run.prepareRepo({
            commit: `e2e: examples/${SETTINGS.app} with a seed, for previews`,
            env: {
              HCLOUD_TOKEN: SETTINGS.hcloudToken,
              CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            },
            overlay,
          });
          // The app reads the preview value, so prod is asked for one too: a value that isn't a preview's.
          await appendFile(
            join(run.work, "production.env"),
            `${PREVIEW_VALUE}=prod
`,
          );
        } finally {
          await rm(overlay, { recursive: true, force: true });
        }
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        await run.deployAny("prod's first deploy");
        await run.waitForHealth();
        const prod = await page(`https://${run.appHost}`);
        expect(prod, "prod's page: the marker of main, no row").toMatchObject({
          marker: "main",
          rows: [],
          previewValue: "unset",
        });
      },
    );

    run.step(
      "2. env add preview --previews --cap 1 --lifetime 1 --domain <the preview zone> with the detected seed, the secrets check, provision --env preview with the recipe approved by its hash and the typed name, the deploy-setup pull request merged; prod unchanged (SC-2205)",
      minutes(75),
      async () => {
        const prodPlan = planHash(await run.readPlan());
        const zone = await run.cloudflare.zoneOf(PREVIEW_DOMAIN);
        if (zone.name !== PREVIEW_DOMAIN) {
          throw new Error(
            `OPSCREW_E2E_PREVIEW_DOMAIN is a name inside the Cloudflare zone ${zone.name}; set it to a zone of its own, used only for previews.`,
          );
        }
        // Set before env add, so the cleanup removes the wildcard record whatever happens next.
        previewZone = zone;
        await run.opscrewOk(
          "env",
          "add",
          PREVIEW_ENV,
          "--previews",
          "--cap",
          "1",
          "--lifetime",
          "1",
          "--domain",
          PREVIEW_DOMAIN,
        );
        const plan = await envs.designed(PREVIEW_ENV);
        previewApp = plan.app.name;
        const previews = plan.environment?.previews;
        if (previews === undefined) throw new Error("env add --previews designed no previews.");
        expect(previews, "the preview environment's previews").toMatchObject({
          cap: 1,
          lifetimeDays: 1,
          domain: PREVIEW_DOMAIN,
        });
        expect(previews.seed ?? "", "the seed command detection found").toContain("knex seed:run");
        base = previews.domain;
        workflow = posix.basename(previewWorkflowPath(plan));
        expect(planHash(await run.readPlan()), "prod's plan hash after env add").toBe(prodPlan);
        // The previews' own values: `.env.preview` in the checkout, which init's .gitignore keeps
        // out of every commit.
        const value = `preview-${randomBytes(16).toString("hex")}`;
        run.scrubber.add(value, "preview-value");
        await writeFile(join(run.repo, `.env.${PREVIEW_ENV}`), previewValues(value));
        const ignored = await run.runner.run(
          "git",
          ["-C", run.repo, "check-ignore", "-q", `.env.${PREVIEW_ENV}`],
          { env: run.env, timeoutMs: 60_000 },
        );
        if (ignored.exitCode !== 0) {
          throw new Error(`.env.${PREVIEW_ENV} is not gitignored in the throwaway checkout.`);
        }

        // The secrets check (FR-2202) first: where GitHub enforces branch rules on environments,
        // it refuses while prod's deploy secrets are repository secrets; provisioning prod, as the
        // refusal says, moves them into a GitHub environment only main may use.
        envs.provisioned.add(PREVIEW_ENV);
        let provisioned = await provisionPreviews();
        const { refused } = provisioned;
        if (refused) {
          log(
            "observed: provision --env preview refused while a pull request could read prod's deploy secrets; provisioning prod first, as the refusal says",
          );
          await envs.provision(
            "prod",
            "prod's secrets into a GitHub environment only main may use",
          );
          // Prod's deploy job already runs in `production`, so moving its secrets there changes
          // only opscrew/plan.yaml, which no deploy reads: the merge starts no deploy.
          await run.mergeDeploySetup("prod's secrets placed in its GitHub environment");
          await run.waitForHealth();
          const record = await envs.expectSecretsPlaced("prod");
          const github =
            record.environment === undefined
              ? undefined
              : await readGithubEnvironment(run.github, record.environment);
          expect(github?.branches, "the branches that may use prod's GitHub environment").toEqual([
            "main",
          ]);
        } else {
          log("observed: provision --env preview passed the secrets check at once");
        }
        // Prod before the previews exist (the check changed nothing): SC-2205 compares with this.
        prodBefore = await prodState();
        if (refused) {
          provisioned = await provisionPreviews();
          if (provisioned.refused) {
            throw new Error(
              `provision --env preview refused again after prod's provision:\n${run.tail(provisioned.output)}`,
            );
          }
        }
        const paths = envs.paths(PREVIEW_ENV);
        await run.rememberSecretFile(paths.files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(paths.files.statePassphrase, "state-passphrase");
        if (!(await run.rememberSecretFile(paths.files.previewKey, "preview-private-key"))) {
          throw new Error("provision --env preview made no preview key.");
        }
        // Where provision placed the previews' secrets: a GitHub environment where GitHub keeps
        // environments apart by branch, else prefixed repository secrets (GitHub Free, private).
        const environment = githubEnvironment(await envs.readPlan(PREVIEW_ENV));
        const branchRules = environment !== undefined;
        log(
          `observed: provision placed the previews' secrets ${branchRules ? `in the GitHub environment ${environment}` : "as prefixed repository secrets"}`,
        );
        if (refused) expect(branchRules, "a GitHub environment after the refusal").toBe(true);
        expect(
          previewsPlanProblems(provisioned.output, branchRules),
          `the previews host plan's text:\n${run.tail(provisioned.output, 40)}`,
        ).toEqual([]);

        const merged = await run.mergeDeploySetup("the preview workflow and recipe");
        if (merged === undefined) throw new Error("provision --env preview committed nothing.");
        const changed = (await run.git("diff", "--name-only", `${merged}^1`, merged)).split("\n");
        expect(changed, "the deploy-setup pull request's files").toContain(
          `.github/workflows/${workflow}`,
        );
        expect(
          changed.some((file) => file.startsWith(`opscrew/environments/${PREVIEW_ENV}/previews/`)),
          `the recipe in opscrew/environments/${PREVIEW_ENV}/previews/`,
        ).toBe(true);
        expect(changed, "no push-deploy workflow for the previews").not.toContain(
          `.github/workflows/opscrew-deploy-${PREVIEW_ENV}.yml`,
        );
        // A root app's deploy workflow leaves the preview workflow out: the merge deploys nothing.
        await sleep(90_000);
        const prodRuns = await run.github.call(
          "GET",
          `${repo()}/actions/workflows/${DEPLOY_WORKFLOW}/runs?head_sha=${merged}&per_page=10`,
        );
        if (prodRuns.status !== 200) {
          throw new Error(`Could not list prod's deploy runs (HTTP ${prodRuns.status}).`);
        }
        expect(
          (prodRuns.json as { total_count?: number } | undefined)?.total_count,
          "prod's deploy runs started by merging the preview workflow",
        ).toBe(0);
        if (environment !== undefined) {
          const github = await readGithubEnvironment(run.github, environment);
          expect(github?.branchPolicy, `the branch rule of ${environment}`).toBeNull();
        }
        await expectProdUnchanged("the previews' provision");
      },
    );

    run.step(
      "3. pull request A gets its preview: the comment's address (pr-<n>-<random>.<zone>) and commit, A's marker served through Cloudflare only with the seeded rows and noindex, the list, its deployment; the preview value on the server; its image in GHCR (SC-2201)",
      minutes(45),
      async () => {
        const a = await openPull("a", "a-1");
        pullA = a;
        await previewRun(a, STARTED, "A opened");
        await expectRunningComment(a);
        const served = await serving(a, "a-1");
        expect(served.rows, "preview A's rows: the seed's").toEqual([...SEED_ROWS]);
        expect(served.robots, "preview A's X-Robots-Tag header").toContain("noindex");
        expect(served.viaCloudflare, "preview A answered through Cloudflare (cf-ray)").toBe(true);
        await expectOnlyCloudflareServed();
        const list = await listed();
        expect(list, "opscrew preview list").toMatchObject({
          count: 1,
          cap: 1,
          previews: [{ number: a.number, state: "running", commit: a.head, address: address(a) }],
        });
        await expectDeployment(a, "success", address(a));
        const present = await leftOf(a);
        log(`observed: preview A has ${present.join(", ")} on the server`);
        expect(present, "what preview A has on the server").toEqual(
          expect.arrayContaining(["container", "folder", "site", "route"]),
        );
        expect(served.previewValue, "preview A got .env.preview's value").toBe("set");
        expect(
          (await imageTags([a.number])).length,
          "preview A's images in GitHub Container Registry",
        ).toBeGreaterThan(0);
        firstA = { preview: list.previews[0], secrets: await previewSecrets(a) };
      },
    );

    run.step(
      "4. a push to A: the new commit served, the seed not run again, the preview's generated passwords kept (SC-2201)",
      minutes(30),
      async () => {
        const a = pullOf(pullA);
        const first = firstA;
        if (first === undefined) throw new Error("Step 3 kept nothing of preview A.");
        await pushTo(a, "a-2");
        await previewRun(a, STARTED, "a push to A");
        await expectRunningComment(a);
        const served = await serving(a, "a-2");
        expect(served.rows, "preview A's rows after the push: the seed ran once").toEqual([
          ...SEED_ROWS,
        ]);
        const preview = (await listed()).previews.find((p) => p.number === a.number);
        expect(preview, "preview A in the list after the push").toMatchObject({
          state: "running",
          commit: a.head,
          createdAt: first.preview?.createdAt,
        });
        expect(preview?.digest, "preview A's image after the push").not.toBe(first.preview?.digest);
        expect(
          await previewSecrets(a),
          "preview A's generated passwords after the push (their digest)",
        ).toBe(first.secrets);
        await expectDeployment(a, "success", address(a));
      },
    );

    run.step(
      "5. pull request B at the cap: the cap comment, and preview A still running",
      minutes(30),
      async () => {
        const b = await openPull("b", "b-1");
        pullB = b;
        await previewRun(b, CAPPED, "B opened at the cap");
        expect(await comment(b), "the comment on pull request B").toEqual({
          state: "cap",
          count: 1,
          cap: 1,
        });
        const list = await listed();
        expect(
          list.previews.map((p) => p.number),
          "the previews while the cap is reached",
        ).toEqual([pullOf(pullA).number]);
        await serving(pullOf(pullA), "a-2");
      },
    );

    run.step(
      "6. the restricted key, from this computer, refused each request outside the contract with nothing changed on the server (SC-2202)",
      minutes(10),
      async () => {
        const b = pullOf(pullB);
        const key = await envs.shell(PREVIEW_ENV, envs.paths(PREVIEW_ENV).files.previewKey);
        const ssh = async (what: string, request: string | undefined) => {
          const result = await key.run(request, minutes(1));
          run.outputs.set(
            run.scrub(`#${run.outputs.size + 1} ssh with the preview key: ${what}`),
            `${result.stdout}\n${result.stderr}`,
          );
          return { exitCode: result.exitCode, reply: serverReply(result.stdout) };
        };
        const shell = await envs.shell(PREVIEW_ENV);
        const before = await shell.ok(serverStateCommand(previewApp));
        expect(await ssh("list", "list"), "list through the preview key").toEqual({
          exitCode: 0,
          reply: { state: "listed", detail: "1/1" },
        });
        for (const refusal of keyRefusals(b.number)) {
          const answer = await ssh(refusal.what, refusal.request);
          log(
            `observed: ${refusal.what}: exit ${answer.exitCode}, ${answer.reply === undefined ? "no answer line" : `${answer.reply.state} ${answer.reply.detail}`}`,
          );
          expect(answer, `the preview key's ${refusal.what}`).toEqual(
            refusal.detail === undefined
              ? { exitCode: 255, reply: undefined }
              : { exitCode: 2, reply: { state: "refused", detail: refusal.detail } },
          );
        }
        expect(
          await shell.ok(serverStateCommand(previewApp)),
          "the server's folders, previews, containers, volumes, log and secrets' digests after the refusals",
        ).toBe(before);
      },
    );

    run.step(
      "7. closing A removes its preview: no container, volume, folder, data, site or route, no image in GHCR, its deployment inactive, its address no longer served (SC-2201)",
      minutes(30),
      async () => {
        const a = pullOf(pullA);
        const since = new Date();
        await closePull(a);
        await previewRun(a, REMOVED, "A closed", since);
        expect(await comment(a), "the comment on pull request A").toEqual({ state: "removed" });
        expect(await leftOf(a), "what is left of preview A on the server").toEqual([]);
        expect((await listed()).count, "the previews after A closed").toBe(0);
        await expectImagesGone(a);
        await expectDeployment(a, "inactive");
        await waitFor(
          `${address(a)} no longer serving`,
          minutes(2),
          () =>
            page(address(a)).then(
              () => undefined,
              () => true,
            ),
          10_000,
        );
      },
    );

    run.step("8. a push to B gives B its preview, seeded on its own", minutes(30), async () => {
      const b = pullOf(pullB);
      await pushTo(b, "b-2");
      await previewRun(b, STARTED, "a push to B");
      await expectRunningComment(b);
      const served = await serving(b, "b-2");
      expect(served.rows, "preview B's rows: the seed's").toEqual([...SEED_ROWS]);
      expect(served.robots, "preview B's X-Robots-Tag header").toContain("noindex");
      expect(
        (await listed()).previews.map((p) => [p.number, p.state, p.commit]),
        "the previews after B's push",
      ).toEqual([[b.number, "running", b.head]]);
      await previewSecrets(b);
      await expectDeployment(b, "success", address(b));
    });

    run.step(
      "9. preview destroy B (typed pr-<n>), B's close finding nothing left, then destroy --env preview (typed): nothing of the previews at Hetzner, in Cloudflare or at GitHub",
      minutes(45),
      async () => {
        const b = pullOf(pullB);
        await run.opscrewOk(
          "preview",
          "destroy",
          String(b.number),
          "--env",
          PREVIEW_ENV,
          "--confirm",
          `pr-${b.number}`,
        );
        expect(await leftOf(b), "what is left of preview B after preview destroy").toEqual([]);
        expect((await listed()).count, "the previews after preview destroy").toBe(0);
        // Closed now, while the server runs: its run's down finds nothing to remove, and its
        // images go.
        const since = new Date();
        await closePull(b);
        await previewRun(b, REMOVED, "B closed after preview destroy", since);
        expect(await comment(b), "the comment on pull request B").toEqual({ state: "removed" });
        await expectImagesGone(b);

        const record = await secretsRecord(envs.paths(PREVIEW_ENV));
        await envs.destroy(PREVIEW_ENV);
        await envs.expectNothingLeft(PREVIEW_ENV);
        if (record !== undefined) await envs.expectSecretsGone(PREVIEW_ENV, record);
        expect(
          (await wildcardRecords()).map((r) => r.type),
          "the previews' wildcard records left",
        ).toEqual([]);
      },
    );

    run.step(
      "10. prod unchanged throughout: its plan, state, secrets and site (SC-2205)",
      minutes(20),
      () => expectProdUnchanged("the previews' whole life and their destroy"),
    );

    run.step(
      "11. destroy leaves nothing of prod at Hetzner or in Cloudflare",
      minutes(30),
      async () => {
        await envs.destroy("prod");
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "12. no token, key, generated password or preview value in any output, commit, pull request, comment, preview workflow log, audit entry, plan or state file, and no server address in a comment (SC-2204)",
      minutes(15),
      async () => {
        const problems = await envs.leaks({ cloudflare: true });
        const known = run.scrubber.entries();
        const secrets = known.filter(({ label }) => !label.startsWith("server-"));
        for (const pull of pulls) {
          let comments: { body?: string | null }[] | undefined;
          try {
            comments = (await pullComments(pull)) as typeof comments;
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
        for (const id of previewRuns) {
          const jobs = await run.github.call(
            "GET",
            `${repo()}/actions/runs/${id}/jobs?per_page=100`,
          );
          const list =
            (jobs.json as { jobs?: { id: number; name: string; conclusion: string | null }[] })
              ?.jobs ?? [];
          for (const job of list.filter((j) => j.conclusion !== "skipped")) {
            const got = await run.github.redirectedText(`${repo()}/actions/jobs/${job.id}/logs`);
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
        log(`observed: the leak search read ${logs} preview workflow job logs`);
        if (previewRuns.length > 0 && logs === 0) {
          run.findings.push("no preview workflow log could be read, so the leak search read none");
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    // The harness's cleanup: destroy if needed (the previews' environment, then prod), Hetzner's
    // API by the apps' labels, GitHub's environments and secrets, Cloudflare, then the wildcard
    // record in the preview zone (a finished destroy must have removed it), then the
    // repository's reset.
    envs.registerCleanup({
      last: async (attempt) => {
        const zone = previewZone;
        if (zone === undefined) return;
        await attempt("remove the previews' wildcard record", async () => {
          const problems: string[] = [];
          for (const record of await wildcardRecords()) {
            const what = `${record.type} ${record.name}`;
            const removed = await retryDelete(() =>
              run.cloudflare.call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`),
            );
            if (!removed) problems.push(`Cloudflare did not delete ${what}`);
            else if (envs.destroyed.has(PREVIEW_ENV)) {
              problems.push(`destroy left ${what}; the cleanup removed it`);
            }
          }
          return problems;
        });
      },
    });
    // Registered after the harness's cleanup, so it runs before it: while the preview server may
    // still run, each of the run's pull requests still open is closed and its preview run awaited
    // (its remove job takes the preview down and deletes its images), so no preview run starts
    // after the cleanup removed the GitHub environments; then no image of the run's pull requests
    // may be left in GitHub Container Registry.
    afterAll(async () => {
      const problems: string[] = [];
      const attempt = async (what: string, body: () => Promise<void>) => {
        try {
          await body();
        } catch (error) {
          problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const deadline = Date.now() + minutes(15);
      for (const pull of pulls) {
        await attempt(`close pull request ${pull.name} and wait for its preview run`, async () => {
          const state = await run.github.call("GET", `${repo()}/pulls/${pull.number}`);
          if ((state.json as { state?: string } | undefined)?.state !== "open") return;
          const since = new Date();
          await closePull(pull);
          const left = deadline - Date.now();
          if (left <= 0) throw new Error("no time was left to wait for its preview run");
          const found = await run.github.waitForDeploy(
            { headSha: pull.head, workflow, event: "pull_request", since },
            left,
          );
          log(`pull request ${pull.name}'s preview run ${found.id} ended ${found.conclusion}`);
        });
      }
      if (pulls.length > 0) {
        await attempt("look for the run's images in GitHub Container Registry", async () => {
          const tags = await imageTags(pulls.map((pull) => pull.number));
          if (tags.length > 0) {
            throw new Error(
              `${tags.length} image tag(s) of the run's pull requests are left (${tags.join(", ")}): delete those versions in the repository's package settings on GitHub`,
            );
          }
        });
      }
      if (problems.length > 0) {
        throw run.cleanError(
          new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
        );
      }
    }, minutes(25));
  },
);
