// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose files hold ${…} on purpose.
/**
 * Live end-to-end test for an existing Portainer as a deploy target (feature 010, quickstart
 * "Gated live test", steps 1–6, and the live checks of tasks.md T1008). It creates a throwaway
 * Hetzner server outside OpsCrew (its own SSH key and firewall), installs Portainer CE 2.45.2 on it
 * as "the user's existing Portainer" (admin through the setup token, the local environment, an
 * admin's and a limited user's access tokens), adds a decoy Compose project and a decoy Portainer
 * stack, and drives the built CLI (and once the MCP server) through every web and redeploy mode:
 * updater + tunnel (with a change that deploys by itself and one that rolls back), a registry token
 * replaced through MCP, caddy, proxy (with `verify --url`), the Cloudflare redeploy mode, then
 * `destroy` with and without `--delete-data`, and finally two setups of their own with a loopback
 * and a short Portainer address (OpsCrew refuses another address while its record lists
 * anything), each removed with its data. With `OPSCREW_E2E_GITHUB_REPO_B`, a second app goes into
 * the same Portainer, zone and account with the tunnel (step 7b) before the first one's destroy,
 * and is destroyed after it (step 9b; feature 011). A rule of the user's own seeded in each of
 * OpsCrew's rule phases must stay byte-identical after every provision and destroy, and OpsCrew's
 * shared rules must list exactly the live apps' hostnames. The server, its key and firewall are
 * always deleted (afterAll), and what OpsCrew created in Cloudflare is removed through the API
 * when `destroy` did not finish. Nothing the test prints contains a token, a secret, the server's
 * address or Portainer's: every line goes through a scrubber. Runs only with
 * OPSCREW_E2E_PORTAINER=1 and the variables in docs/e2e.md ("Your existing Portainer"); costs a
 * few cents of server time.
 *
 * `OPSCREW_E2E_PORTAINER_STEPS` selects the steps (`portainerSteps`): `core` (the default, about
 * 15 minutes), `full` (every step) or a list such as `11,12`, which also takes the steps those
 * need; every run starts from a fresh server and removes it at the end.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dohQuery, readPortainerConnection } from "@opscrew/agents";
import {
  COMPOSE_PROJECT_LABEL,
  DEPLOY_BRANCH,
  DEPLOY_REFERENCE,
  inspectCertificate,
  opscrewNames,
  sameCertFingerprint,
} from "@opscrew/connector-portainer";
import { describe, expect } from "vitest";
import {
  type CloudflareZone,
  canConnect,
  httpRequest,
  minutes,
  sleep,
  waitFor,
  waitForAccessRefusal,
} from "./cloud";
import { CLI, LiveRun, secondAppSkip, serverSettings } from "./harness";
import {
  changedRulesets,
  commitDetails,
  createDnsRecord,
  fileAt,
  ghcrPullStatus,
  jobErrors,
  McpSession,
  PortainerApi,
  packageVisibility,
  publicIpv4,
  branchHead as readBranchHead,
  repoInfo,
  rulesetRules,
  runSteps,
  secretNames,
  zoneRulesets,
} from "./portainer-cloud";
import {
  BUSYBOX_IMAGE,
  changedKeys,
  DECOY_PROJECT,
  DECOY_STACK,
  type DeployedImage,
  deployedImage,
  dnsPreloadSource,
  ENVIRONMENT_NAME,
  envNames,
  firewallRules,
  isEncryptedPlan,
  multipartForm,
  opensslFingerprint,
  PORTAINER_IMAGE,
  PORTAINER_PORT,
  PORTAINER_VERSION,
  type PortainerAnswers,
  PROBE_STACK,
  PROXY_PORT,
  portainerAnswers,
  portainerSteps,
  requiredLeakLabels,
  rollbackOutcome,
  SELF_DEPLOY_TARGET_MS,
  setupTokenFromLogs,
  shortHostMentions,
  shortHostName,
  stepNumber,
  valueShape,
} from "./portainer-support";
import {
  approveHashes,
  duration,
  failedInitChecks,
  leakedLabels,
  missingVariables,
  printedHash,
  SERVER_E2E_VARIABLES,
} from "./support";

const ENV = process.env;
const STEPS_VALUE = ENV.OPSCREW_E2E_PORTAINER_STEPS;
/** The steps this run takes (`OPSCREW_E2E_PORTAINER_STEPS`, `core` by default). */
const SELECTED = portainerSteps(STEPS_VALUE) ?? [];
const MISSING = [
  ...missingVariables(ENV, "OPSCREW_E2E_PORTAINER", [
    ...SERVER_E2E_VARIABLES,
    "OPSCREW_E2E_GHCR_READ_TOKEN",
  ]),
  ...(portainerSteps(STEPS_VALUE) === undefined
    ? ["OPSCREW_E2E_PORTAINER_STEPS=core, full or a list of steps such as 11,12"]
    : []),
];
const SETTINGS = serverSettings(ENV, "OPSCREW_E2E_PORTAINER_SERVER_TYPE");
/** Why the second app's steps (7b, 9b) are skipped, if they are. */
const SECOND_SKIP = secondAppSkip(SETTINGS);
const E2E = {
  /** Optional: a narrower Cloudflare token OpsCrew uses for the updater + tunnel steps (2–4). */
  cloudflareTunnelToken: ENV.OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN?.trim() || undefined,
  ghcrToken: ENV.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "",
  /** Needed only when the throwaway repository is private. */
  repoReadToken: ENV.OPSCREW_E2E_REPO_READ_TOKEN?.trim() || undefined,
  shortHost: ENV.OPSCREW_E2E_PORTAINER_SHORT_HOST,
  /** Optional: pause after the setup so the guide's browser and UI steps can be checked by hand. */
  manualMinutes: Number(ENV.OPSCREW_E2E_PORTAINER_MANUAL_MINUTES ?? "0") || 0,
};

if (MISSING.length > 0 && ENV.OPSCREW_E2E_PORTAINER === "1") {
  console.warn(
    `OpsCrew E2E (Portainer): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Your existing Portainer").`,
  );
}

const ADMIN_USER = "admin";
const LIMITED_USER = "opscrew-e2e-limited";

type Web = PortainerAnswers["web"];

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live end-to-end in your existing Portainer (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live end-to-end in your existing Portainer: examples/${SETTINGS.app} on a throwaway Portainer CE ${PORTAINER_VERSION}`,
  () => {
    /**
     * The latest content of every file in `.opscrew/plans/` (destroy removes the stack plans), by
     * name; the second app's under `b/`.
     */
    const planFiles = new Map<string, string>();
    /** Keeps the latest copy of every saved plan of `app` for the leak check. */
    const keepPlans = async (app: LiveRun, prefix: string) => {
      const dir = app.paths().files.plansDir;
      if (!existsSync(dir)) return;
      for (const file of await readdir(dir)) {
        planFiles.set(`${prefix}${file}`, await readFile(join(dir, file), "utf8").catch(() => ""));
      }
    };
    const run: LiveRun = new LiveRun({
      label: "Portainer",
      name: "portainer",
      settings: SETTINGS,
      afterCli: () => keepPlans(run, ""),
    });
    /** The second app, B: its own stacks in the same Portainer (steps 7b and 9b), when they run. */
    const b: LiveRun | undefined =
      SECOND_SKIP === undefined
        ? run.second({
            label: "Portainer, B",
            name: "portainer-b",
            settings: { ...SETTINGS, githubRepo: SETTINGS.secondRepo },
            afterCli: () => keepPlans(b as LiveRun, "b/"),
          })
        : undefined;
    const second = () => b as LiveRun;
    /** Whether the second app is set up and not destroyed. */
    const secondUp = () => b?.appName !== undefined && !b.destroyed;
    const { log, scrubber, appHost } = run;
    scrubber.add(E2E.cloudflareTunnelToken, "cloudflare-tunnel-token");
    scrubber.add(E2E.ghcrToken, "OPSCREW_GHCR_READ_TOKEN");
    scrubber.add(E2E.repoReadToken, "OPSCREW_REPO_READ_TOKEN");

    /** Everything the MCP server sent (results, dialogs, standard error). */
    const mcpTexts: string[] = [];
    /** The live facts the run observed (the run log of tasks.md T1008). */
    const observations: string[] = [];

    let repoPrivate = false;
    let owner = "";
    let ownerType = "User";
    let shortHost = "nas";
    let portainerUrl = "";
    let fingerprint = "";
    let admin: PortainerApi | undefined;
    let adminToken = "";
    let limitedToken = "";
    let limitedUserId = 0;
    let environmentId = 0;
    let decoyStackId = 0;
    let decoysBefore = "";
    let portainerBefore: Record<string, unknown> = {};
    /** The rules of every zone ruleset that existed before the run (id → name and rules). */
    const rulesetsBefore = new Map<string, { name: string; rules: string | undefined }>();
    let web: Web = "tunnel";
    let recordedVolumes: string[] = [];
    let registryId: number | undefined;
    const testRecords: string[] = [];
    let tunnel: ChildProcess | undefined;

    /** Records a live fact for the run log (tasks.md T1008); never a value. */
    const observe = (fact: string) => {
      observations.push(run.scrub(fact));
      log(`observed: ${fact}`);
    };

    if (MISSING.length === 0) {
      const pass = STEPS_VALUE?.trim() || "core";
      const estimates: Record<string, string> = {
        core: "; expected to take about 15 minutes",
        full: "; expected to take about 1–1½ hours",
      };
      log(
        `OPSCREW_E2E_PORTAINER_STEPS=${pass}: steps ${SELECTED.join(", ")}${estimates[pass] ?? ""}`,
      );
      if (SECOND_SKIP !== undefined) log(`the second app's steps are skipped: ${SECOND_SKIP}`);
    }

    /**
     * An ordered step of {@link run}, reported as skipped when the run does not select it, or with
     * `skip` as the reason.
     */
    function step(
      title: string,
      timeoutMs: number,
      body: () => Promise<void>,
      options: { always?: boolean; skip?: string | undefined } = {},
    ) {
      const selected = SELECTED.includes(stepNumber(title));
      const skip = selected
        ? options.skip
        : "not selected; OPSCREW_E2E_PORTAINER_STEPS=full or a list with it runs it";
      run.step(title, timeoutMs, body, {
        ...(options.always === true ? { always: true } : {}),
        ...(skip === undefined ? {} : { skip }),
      });
    }

    const portainer = () => admin as PortainerApi;
    const names = (app = run) => opscrewNames(app.app());
    const branchHead = (branch: string, app = run) => readBranchHead(app.github, branch);

    /**
     * Interview (Portainer, the pinned certificate) then design for `app` (A by default), checking
     * the plan's target.
     */
    async function answerAndDesign(
      answers: Omit<PortainerAnswers, "domain">,
      overrides: Record<string, string | undefined> = {},
      app = run,
    ): Promise<void> {
      const file = join(app.work, "answers.json");
      await writeFile(file, JSON.stringify(portainerAnswers({ ...answers, domain: app.appHost })));
      await app.opscrewOkWith(
        overrides,
        "interview",
        "--answers",
        file,
        "--portainer-cert",
        fingerprint,
      );
      await app.opscrewOkWith(overrides, "design");
      const plan = await app.readPlan();
      expect(plan.target, "design planned the user's Portainer as answered").toMatchObject({
        provider: "portainer",
        mode: "portainer-stack",
        environmentId,
        redeploy: answers.redeploy,
        web: answers.web === "proxy" ? { mode: "proxy", port: PROXY_PORT } : { mode: answers.web },
      });
      const local = await readPortainerConnection(app.paths());
      expect(local?.url, "server.json keeps Portainer's address").toBe(answers.url);
      expect(
        sameCertFingerprint(local?.certFingerprint ?? "", fingerprint),
        "server.json pins the confirmed certificate",
      ).toBe(true);
    }

    /** OpsCrew's record of what it created in Portainer (`.opscrew/server.json`). */
    async function createdRecord() {
      const created = (await readPortainerConnection(run.paths()))?.created;
      return {
        stacks: created?.stacks ?? [],
        registryId: created?.registryId,
        volumes: created?.volumes ?? [],
      };
    }

    /**
     * The documented three runs of a script when the stack plan needs a tunnel's token that does
     * not exist yet: `--plan-only` prints the infrastructure hash, after the Cloudflare plan's when
     * OpsCrew's shared rules change (and says so), applying them stops at the stack plan and prints
     * its hash, `--yes` alone never approves that plan, and the third run applies exactly that hash.
     * A deviation is a finding and the generic loop finishes.
     */
    async function threeRuns(label: string, firstSetup: boolean): Promise<string | undefined> {
      const first = await run.opscrewOk("provision", "--plan-only", "--yes");
      const hashes = approveHashes(first.output);
      const cloudflarePlan = printedHash(first.output, "Cloudflare plan hash");
      const infrastructure = hashes.filter((hash) => hash !== cloudflarePlan);
      const noted = first.output.includes("In a script that takes three runs");
      if (infrastructure.length !== 1 || !noted) {
        run.findings.push(
          `${label}: --plan-only printed ${infrastructure.length} infrastructure hash(es)${noted ? "" : " and no three-runs note"}, not one`,
        );
        await run.provisionUntilDone(label);
        return undefined;
      }
      const second = await run.opscrew(
        "provision",
        ...hashes.flatMap((hash) => ["--approve", hash]),
        "--yes",
      );
      const stackHash = printedHash(second.output, "Stack plan hash");
      if (
        second.exitCode === 0 ||
        stackHash === undefined ||
        !approveHashes(second.output).includes(stackHash)
      ) {
        run.findings.push(
          `${label}: the second run (exit ${second.exitCode}) did not stop at the stack plan with its hash`,
        );
        await run.provisionUntilDone(label);
        return undefined;
      }
      log(`${label}: the second run applied the infrastructure and stopped at the stack plan`);
      if (firstSetup) {
        expect(
          (await stackNames()).filter((name) => name.startsWith(names().app)),
          "nothing of the app is in Portainer before the stack plan is approved",
        ).toEqual([]);
      }
      // The deploy branch as the second run left it (a first setup: just created with the
      // placeholder); the later runs must not write it again (no replace of a placeholder).
      const deployHead = firstSetup
        ? await createdBranchHead(DEPLOY_BRANCH)
        : await branchHead(DEPLOY_BRANCH);
      const yesOnly = await run.opscrew("provision", "--yes");
      expect(yesOnly.exitCode, "--yes alone never approves the stack plan").not.toBe(0);
      if (printedHash(yesOnly.output, "Stack plan hash") !== stackHash) {
        run.findings.push(`${label}: a run with --yes alone showed another stack plan hash`);
      }
      expect(
        await branchHead(DEPLOY_BRANCH),
        `${label}: the run with --yes alone left the ${DEPLOY_BRANCH} branch as it was`,
      ).toBe(deployHead);
      const third = await run.opscrewOk("provision", "--approve", stackHash, "--yes");
      expect(
        /Applied the stack plan ([0-9a-f]{64}) to your Portainer\./.exec(third.output)?.[1],
        `${label}: the third run applies the stack plan the second printed`,
      ).toBe(stackHash);
      expect(
        await branchHead(DEPLOY_BRANCH),
        `${label}: the third run left the ${DEPLOY_BRANCH} branch as it was`,
      ).toBe(deployHead);
      observe(
        `${label}: the three script runs worked, with the same stack plan hash on the second and third run`,
      );
      return stackHash;
    }

    /** The app's health URL for the current web mode (proxy: Caddy on the host's port). */
    async function siteUrl(): Promise<string> {
      const health = (await run.readPlan()).app.healthPath;
      return web === "proxy"
        ? `http://${run.ipv4()}:${PROXY_PORT}${health}`
        : `https://${appHost}${health}`;
    }

    /** The version (`X-OpsCrew-Image`) the site answers 200 with, checking Cloudflare per mode. */
    async function siteVersion(): Promise<string> {
      const answer = await httpRequest(await siteUrl());
      if (answer.status !== 200) throw new Error(`the site answered ${answer.status}`);
      if (web !== "proxy") {
        const ray = answer.headers["cf-ray"] !== undefined;
        if (ray !== (web === "tunnel")) {
          throw new Error(
            `the site answered ${ray ? "with" : "without"} Cloudflare's cf-ray header`,
          );
        }
      }
      const version = answer.headers["x-opscrew-image"];
      return typeof version === "string" ? version : "";
    }

    /** Waits until the site answers 200 with `version`. */
    async function waitForSite(version: string, timeoutMs = minutes(10)) {
      log(`waiting for the site (${web}) to answer with version ${version}`);
      await waitFor(`the site (${web}) answering 200 with ${version}`, timeoutMs, async () => {
        const seen = await siteVersion();
        if (seen !== version) throw new Error(`it runs version ${seen || "(none)"}`);
        return true;
      });
    }

    /**
     * Before a `verify` that follows a DNS change: only records how long this computer's own
     * resolver took to find the app's hosts (or that it still did not after a short wait), never
     * the addresses, and never fails the step: `verify` itself checks such a host through the
     * public resolver's answer, since a cache beyond this computer can keep "no such name" longer.
     */
    async function waitForLocalResolution(what: string) {
      const hosts = (await run.readPlan()).dns.www ? [appHost, `www.${appHost}`] : [appHost];
      const started = Date.now();
      const deadline = started + minutes(2);
      const missing = new Set(hosts);
      for (;;) {
        for (const host of [...missing]) {
          try {
            await dnsPromises.lookup(host);
            missing.delete(host);
          } catch {
            // Still "no such name" here (or a resolver error): asked again below.
          }
        }
        if (missing.size === 0 || Date.now() >= deadline) break;
        await sleep(15_000);
      }
      observe(
        missing.size === 0
          ? `${what}: this computer resolved ${hosts.join(" and ")} ${duration(Date.now() - started)} after the wait began`
          : `${what}: this computer still did not resolve ${[...missing].join(" and ")} after ${duration(Date.now() - started)}; verify checks it through the public resolver's answer`,
      );
    }

    /** The image the deploy branch runs now. */
    async function deployBranchImage(): Promise<DeployedImage> {
      const compose = await fileAt(run.github, "compose.yaml", DEPLOY_BRANCH);
      const image = compose === undefined ? undefined : deployedImage(compose);
      if (image === undefined) {
        throw new Error(`The ${DEPLOY_BRANCH} branch does not run an app image yet.`);
      }
      return image;
    }

    /**
     * The head of a branch a product run just created: GitHub's reads can lag a fresh ref for a
     * moment, so this asks again for up to 30 seconds while the branch is absent. Only for a
     * branch expected to exist: where absence is expected, read once with `branchHead`, since a
     * retry there would only hide a failed deletion.
     */
    async function createdBranchHead(branch: string): Promise<string | undefined> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const head = await branchHead(branch);
        if (head !== undefined || Date.now() >= deadline) return head;
        await sleep(2_000);
      }
    }

    /**
     * The deploy branch holds exactly the placeholder: an orphan commit with only `compose.yaml`,
     * which runs no app image. Returns its head.
     */
    async function expectPlaceholderBranch(what: string): Promise<string> {
      const head = await createdBranchHead(DEPLOY_BRANCH);
      expect(head, `${what}: the ${DEPLOY_BRANCH} branch exists`).toBeDefined();
      const commit = await commitDetails(run.github, head as string);
      expect(
        { parents: commit.parents, paths: commit.paths },
        `${what}: the ${DEPLOY_BRANCH} branch is an orphan holding only compose.yaml`,
      ).toEqual({ parents: 0, paths: ["compose.yaml"] });
      const compose = await fileAt(run.github, "compose.yaml", DEPLOY_BRANCH);
      expect(
        compose === undefined ? "missing" : deployedImage(compose),
        `${what}: the ${DEPLOY_BRANCH} branch holds the placeholder, not an app image`,
      ).toBeUndefined();
      return head as string;
    }

    /**
     * Destroy deleted the deploy branch once the app's stack was gone, said so, and does not list
     * it under "What remains:". Only the branch's own item ("The opscrew-deploy branch of …")
     * counts: the workflow file `.github/workflows/opscrew-deploy.yml` stays listed.
     */
    async function expectDeployBranchDeleted(output: string, what: string): Promise<void> {
      expect(
        await branchHead(DEPLOY_BRANCH),
        `${what}: the ${DEPLOY_BRANCH} branch is deleted`,
      ).toBeUndefined();
      expect(
        output.includes(`Deleted the branch ${DEPLOY_BRANCH}`),
        `${what}: destroy says it deleted the ${DEPLOY_BRANCH} branch`,
      ).toBe(true);
      const lines = output.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim() === "What remains:");
      const remains = start === -1 ? [] : lines.slice(start + 1);
      const end = remains.findIndex((line) => !/^\s+- /.test(line));
      expect(
        remains
          .slice(0, end === -1 ? undefined : end)
          .filter((line) => line.trim().startsWith(`- The ${DEPLOY_BRANCH} branch of `)),
        `${what}: "What remains" does not list the ${DEPLOY_BRANCH} branch`,
      ).toEqual([]);
    }

    /**
     * Keeps the deploy branch's history of `app` in a local ref (`refs/e2e/deploy-<label>`) before
     * destroy deletes it on GitHub, so the leak search still covers every commit the workflow wrote.
     */
    async function keepDeployBranch(label: string, app = run): Promise<void> {
      if ((await branchHead(DEPLOY_BRANCH, app)) === undefined) {
        run.findings.push(
          `there was no ${DEPLOY_BRANCH} branch to keep before ${label}, so its history is not searched`,
        );
        return;
      }
      await app.git(
        "fetch",
        "-q",
        "origin",
        `+refs/heads/${DEPLOY_BRANCH}:refs/e2e/deploy-${label}`,
      );
    }

    /** The names of every stack in Portainer (admin view). */
    async function stackNames(): Promise<string[]> {
      const stacks = await portainer().ok<{ Name: string }[]>("GET", "/api/stacks", "list stacks");
      return stacks.map((stack) => stack.Name).sort();
    }

    /** A stack by name (admin view), or undefined. */
    async function stackByName(name: string): Promise<Record<string, unknown> | undefined> {
      const stacks = await portainer().ok<Record<string, unknown>[]>(
        "GET",
        "/api/stacks",
        "list stacks",
      );
      const found = stacks.find((stack) => stack.Name === name);
      if (found === undefined) return undefined;
      return portainer().ok<Record<string, unknown>>(
        "GET",
        `/api/stacks/${found.Id}`,
        "read a stack",
      );
    }

    /** The app's containers on the host, with their ids and start times. */
    const appContainers = () =>
      run
        .shell()
        .ok(
          `docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${names().app} | sort | xargs -r docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}'`,
        );

    /** The app's volumes on the host (by the Compose project label). */
    const appVolumes = async () =>
      (
        await run
          .shell()
          .ok(`docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().app}`)
      )
        .split("\n")
        .filter(Boolean);

    /** The decoys as they are now: their containers and volumes on the host, the decoy stack in Portainer. */
    async function decoys(): Promise<string> {
      const docker = await run
        .shell()
        .ok(
          [
            `for p in ${DECOY_PROJECT} ${DECOY_STACK}; do`,
            '  echo "project $p"',
            `  docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=$p | sort | xargs -r docker inspect -f '{{.Name}} {{.Id}} {{.Config.Image}} {{.State.Status}} {{.State.StartedAt}} {{.RestartCount}}'`,
            `  docker volume ls -q --filter label=${COMPOSE_PROJECT_LABEL}=$p | sort`,
            "done",
          ].join("\n"),
        );
      const stack = await portainer().ok<Record<string, unknown>>(
        "GET",
        `/api/stacks/${decoyStackId}`,
        "read the decoy stack",
      );
      const file = await portainer().ok<{ StackFileContent?: string }>(
        "GET",
        `/api/stacks/${decoyStackId}/file`,
        "read the decoy stack's file",
      );
      const kept = Object.fromEntries(
        [
          "Id",
          "Name",
          "Type",
          "EndpointId",
          "Status",
          "Env",
          "UpdateDate",
          "UpdatedBy",
          "CreationDate",
        ].map((key) => [key, stack[key]]),
      );
      return JSON.stringify({ docker, stack: kept, file: file.StackFileContent ?? "" }, null, 1);
    }

    async function expectDecoysUnchanged(after: string): Promise<void> {
      const now = await decoys();
      if (now !== decoysBefore) {
        const before = decoysBefore.split("\n");
        const lines = now.split("\n");
        const differ = [
          ...lines.filter((line) => !before.includes(line)).map((line) => `now: ${line}`),
          ...before.filter((line) => !lines.includes(line)).map((line) => `before: ${line}`),
        ];
        expect(
          differ,
          `the decoy Compose project and the decoy stack are unchanged after ${after}`,
        ).toEqual([]);
      }
      expect(now, `the decoys are exactly as before after ${after}`).toBe(decoysBefore);
      log(`the decoys are unchanged after ${after}`);
    }

    /**
     * What tells whether Portainer redeployed the app's stack, compared but never printed: its
     * `UpdateDate` and `UpdatedBy`, the number of `DeploymentStatus` entries and the deployed
     * commit (`GitConfig.ConfigHash`).
     */
    async function stackMarks(): Promise<Record<string, unknown>> {
      const stack = await stackByName(names().app);
      const status = stack?.DeploymentStatus;
      return {
        UpdateDate: stack?.UpdateDate,
        UpdatedBy: stack?.UpdatedBy,
        DeploymentStatus: Array.isArray(status) ? status.length : 0,
        ConfigHash: (stack?.GitConfig as { ConfigHash?: unknown } | null | undefined)?.ConfigHash,
      };
    }

    /**
     * What "the user's" Portainer holds besides the app: settings, users, environments, registries
     * (without the second app's own entry while it is set up), stacks.
     */
    async function portainerState(): Promise<Record<string, unknown>> {
      const secondRegistry = secondUp() ? names(second()).registry : undefined;
      const users = await portainer().ok<{ Id: number; Username: string; Role: number }[]>(
        "GET",
        "/api/users",
        "list users",
      );
      const endpoints = await portainer().ok<Record<string, unknown>[]>(
        "GET",
        "/api/endpoints",
        "list environments",
      );
      const registries = await portainer().ok<{ Id: number; Name: string; URL: string }[]>(
        "GET",
        "/api/registries",
        "list registries",
      );
      return {
        settings: await portainer().ok("GET", "/api/settings", "read its settings"),
        users: users.map((user) => [user.Id, user.Username, user.Role]),
        endpoints: endpoints.map((item) => [
          item.Id,
          item.Name,
          item.Type,
          item.URL,
          item.UserAccessPolicies,
          item.TeamAccessPolicies,
        ]),
        registries: registries
          .filter((item) => item.Name !== secondRegistry)
          .map((item) => [item.Id, item.Name, item.URL]),
        stacks: (await stackNames()).filter((name) => !name.startsWith("opscrew-")),
      };
    }

    /** Portainer's settings, users, environments, registries and other stacks are as before the run. */
    async function expectPortainerIntact(after: string): Promise<void> {
      const now = await portainerState();
      const settings = changedKeys(
        portainerBefore.settings as Record<string, unknown>,
        now.settings as Record<string, unknown>,
      );
      if (settings.length > 0)
        run.findings.push(`Portainer's settings changed after ${after}: ${settings.join(", ")}`);
      expect(
        changedKeys(portainerBefore, now).filter((key) => key !== "settings"),
        `Portainer's users, environments, registries and other stacks are unchanged after ${after}`,
      ).toEqual([]);
      log(`Portainer itself is unchanged after ${after}`);
    }

    /** OpsCrew's registry entry's `RegistryAccesses` (environment id → access). */
    async function registryAccesses(): Promise<Record<string, unknown>> {
      const entry = await portainer().ok<{ RegistryAccesses?: Record<string, unknown> | null }>(
        "GET",
        `/api/registries/${registryId}`,
        "read OpsCrew's registry entry",
      );
      return entry.RegistryAccesses ?? {};
    }

    /**
     * Adds every secret OpsCrew made for `app` (A by default) to the scrubber (missing ones are
     * findings).
     */
    async function rememberSecrets(outputNames: readonly string[], app = run): Promise<void> {
      const home = app.paths().projectHomeDir;
      for (const [file, label] of [
        ["portainer-webhook", "portainer-webhook"],
        ["portainer-env.key", "portainer-value-key"],
      ] as const) {
        if (!(await app.rememberSecretFile(join(home, file), label))) {
          run.findings.push(
            `OpsCrew's ${file} file is missing, so the leak search cannot look for it`,
          );
        }
      }
      await app.rememberSecretFile(app.paths().files.statePassphrase, "state-passphrase");
      if (outputNames.length > 0) {
        const outputsNow = await app.infraOutputs().catch((error: unknown) => {
          run.findings.push(`could not read the infrastructure outputs: ${String(error)}`);
          return {} as Record<string, unknown>;
        });
        for (const name of outputNames) {
          const value = outputsNow[name];
          if (typeof value === "string" && value !== "")
            scrubber.add(value, name.replaceAll("_", "-"));
          else
            run.findings.push(
              `the infrastructure outputs have no ${name}, so the leak search misses it`,
            );
        }
      }
      // The values Portainer holds for the app's stack (read as its administrator, never printed).
      const stack = await stackByName(names(app).app);
      for (const item of (stack?.Env as { name?: string; value?: string }[] | undefined) ?? []) {
        if (item.value === undefined || item.value.length < 8) continue;
        if (/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|REDIS_URL/.test(item.name ?? "")) {
          scrubber.add(item.value, `stack-env-${item.name}`);
        }
      }
    }

    /**
     * Merges a change from its own pull request and waits for its deploy run. On `success` it
     * measures how long the new version took to be live after the workflow wrote it to the deploy
     * branch (quickstart 3: within 5 minutes, with nobody calling Portainer).
     */
    async function mergeChange(
      title: string,
      files: Record<string, string>,
      expected: "success" | "failure",
    ): Promise<number> {
      await run.checkoutMain();
      const branch = `e2e/${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}-${run.runId}`;
      await run.git("checkout", "-q", "-b", branch);
      for (const [path, content] of Object.entries(files)) {
        await writeFile(join(run.repo, path), content);
        await run.git("add", path);
      }
      await run.git("commit", "-q", "-m", title);
      await run.git("push", "-q", "-u", "origin", branch);
      const number = await run.github.createPullRequest(title, branch);
      const headBefore = await branchHead(DEPLOY_BRANCH);
      log(`merging "${title}" (#${number}) and waiting for its deploy run (up to 30 minutes)`);
      const sha = await run.github.merge(number);
      await run.checkoutMain();
      const watch =
        expected === "success" ? watchSelfDeploy(headBefore, title) : Promise.resolve(undefined);
      const [deployed] = await Promise.all([run.github.waitForDeploy({ headSha: sha }), watch]);
      expect(
        deployed.conclusion,
        `the deploy run ${deployed.id} of "${title}": ${deployed.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}`,
      ).toBe(expected);
      return deployed.id;
    }

    /**
     * Waits for the deploy workflow to write a new version to the deploy branch, then for the site
     * to answer with it, and checks the time between the two against SELF_DEPLOY_TARGET_MS.
     */
    async function watchSelfDeploy(headBefore: string | undefined, what: string): Promise<void> {
      const written = await waitFor(
        `the deploy workflow writing "${what}" to ${DEPLOY_BRANCH}`,
        minutes(30),
        async () => {
          const head = await branchHead(DEPLOY_BRANCH);
          return head !== undefined && head !== headBefore ? Date.now() : undefined;
        },
        10_000,
      );
      const image = await deployBranchImage();
      await waitFor(
        `the site answering with the version of "${what}"`,
        minutes(15),
        async () => ((await siteVersion()) === image.version ? true : undefined),
        5_000,
      );
      const took = Date.now() - written;
      if (took >= SELF_DEPLOY_TARGET_MS) {
        run.findings.push(
          `"${what}" was live ${duration(took)} after the workflow wrote it to ${DEPLOY_BRANCH}, not within ${duration(SELF_DEPLOY_TARGET_MS)} (quickstart 3)`,
        );
      }
      observe(
        `"${what}" was live ${duration(took)} after the deploy workflow wrote it (${web} mode)`,
      );
    }

    /** Starts the SSH tunnel that makes Portainer reachable at https://localhost:9443 here. */
    async function openTunnel(): Promise<void> {
      if (await canConnect("127.0.0.1", PORTAINER_PORT, 2_000)) {
        throw new Error(
          `Port ${PORTAINER_PORT} on this computer is already in use; the loopback step needs it for the SSH tunnel to Portainer.`,
        );
      }
      let stderr = "";
      let exited: string | undefined;
      tunnel = spawn(
        "ssh",
        [
          "-i",
          run.keyFile,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${run.knownHostsFile}`,
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=15",
          "-N",
          "-L",
          `127.0.0.1:${PORTAINER_PORT}:127.0.0.1:${PORTAINER_PORT}`,
          `root@${run.ipv4()}`,
        ],
        { env: run.env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] },
      );
      tunnel.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      tunnel.once("exit", (code, signal) => {
        exited = `exit ${code ?? signal}`;
      });
      await waitFor(
        () =>
          `Portainer through the SSH tunnel (ssh said: ${stderr.trim().slice(-300) || "nothing"})`,
        minutes(2),
        async () => {
          const seen = await inspectCertificate(`https://localhost:${PORTAINER_PORT}`);
          return sameCertFingerprint(seen.fingerprint, fingerprint) ? true : undefined;
        },
        3_000,
        () =>
          exited === undefined
            ? undefined
            : `The SSH tunnel ended (${exited}): ${stderr.trim().slice(-300)}`,
      );
    }

    function closeTunnel(): void {
      tunnel?.kill();
      tunnel = undefined;
    }

    /**
     * Watches the updater for `seconds` after `poke` (for example a webhook call): none of the
     * updater's calls may fail, and the app's containers and the stack's redeploy marks must stay
     * as they were before `poke` (the deploy branch does not change meanwhile: research R5).
     */
    async function watchUpdater(
      what: string,
      seconds = 150,
      poke: () => Promise<void> = async () => undefined,
    ): Promise<void> {
      const since = await run.shell().ok("date +%s");
      const before = await appContainers();
      const marksBefore = await stackMarks();
      await poke();
      log(`watching the updater for ${seconds} seconds (${what})`);
      await sleep(seconds * 1000);
      const logs = await run
        .shell()
        .ok(
          `docker ps -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().updater} | head -n 1 | xargs -r -I{} docker logs --since ${since} {} 2>&1`,
        );
      const failures = logs
        .split(/\r?\n/)
        .filter((line) => line.includes("asking Portainer to redeploy the app failed")).length;
      if (failures > 0)
        run.findings.push(`${what}: ${failures} of the updater's calls to Portainer failed`);
      else observe(`${what}: every call of the updater to Portainer succeeded for ${seconds} s`);
      const after = await appContainers();
      const marks = changedKeys(marksBefore, await stackMarks());
      if (after !== before) {
        run.findings.push(
          `${what}: the app's containers were recreated although the deploy branch did not change (R5)`,
        );
      } else if (marks.length > 0) {
        run.findings.push(
          `${what}: Portainer redeployed the app's stack although the deploy branch did not change (R5; changed: ${marks.join(", ")})`,
        );
      } else {
        observe(
          `${what}: the app was not redeployed on an unchanged branch (containers, UpdateDate, UpdatedBy, DeploymentStatus count and ConfigHash unchanged; R5)`,
        );
      }
    }

    // -------------------------------------------------------------------------------------------

    step(
      `1. creates a throwaway server with Portainer CE ${PORTAINER_VERSION}, an admin, a limited user and the decoys`,
      minutes(40),
      async () => {
        shortHost = shortHostName(E2E.shortHost);
        const info = await repoInfo(run.github);
        repoPrivate = info.private;
        owner = info.owner;
        ownerType = info.ownerType;
        if (repoPrivate && E2E.repoReadToken === undefined) {
          throw new Error(
            "The throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN (docs/e2e.md).",
          );
        }
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} in your Portainer`,
          env: {
            CLOUDFLARE_API_TOKEN: E2E.cloudflareTunnelToken ?? SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: E2E.ghcrToken,
            ...(repoPrivate ? { OPSCREW_REPO_READ_TOKEN: E2E.repoReadToken } : {}),
          },
          // OpsCrew never gets an SSH login or a Portainer password, only `PORTAINER_API_KEY`.
          drop: ["PORTAINER_API_KEY", ...(repoPrivate ? [] : ["OPSCREW_REPO_READ_TOKEN"])],
        });
        const testIpv4 = await publicIpv4();
        scrubber.add(testIpv4, "test-computer-ipv4");
        await run.createServer(firewallRules(testIpv4));
        const shell = run.shell();

        log("installing Docker with get.docker.com (up to 10 minutes)");
        await shell.ok(
          "curl -fsSL https://get.docker.com -o /root/get-docker.sh && sh /root/get-docker.sh > /root/get-docker.log 2>&1",
          minutes(10),
        );
        observe(
          `Docker ${await shell.ok("docker version --format '{{.Server.Version}}'")} on the Portainer host`,
        );

        // The user's own Compose project, started outside Portainer.
        await shell.ok(
          [
            "mkdir -p /root/e2e-decoy && cat > /root/e2e-decoy/compose.yaml <<'EOF'",
            `name: ${DECOY_PROJECT}`,
            "services:",
            "  sleeper:",
            `    image: ${BUSYBOX_IMAGE}`,
            '    command: ["sh", "-c", "echo decoy > /data/marker; while true; do sleep 3600; done"]',
            "    restart: unless-stopped",
            "    volumes: [decoy_data:/data]",
            "volumes:",
            "  decoy_data: {}",
            "EOF",
            "docker compose -f /root/e2e-decoy/compose.yaml up -d --quiet-pull",
          ].join("\n"),
          minutes(5),
        );

        log(`starting Portainer CE ${PORTAINER_VERSION}`);
        await shell.ok(
          `docker volume create portainer_data >/dev/null && docker run -d --name portainer --restart=always -p ${PORTAINER_PORT}:${PORTAINER_PORT} -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data ${PORTAINER_IMAGE} >/dev/null`,
          minutes(5),
        );
        portainerUrl = `https://${run.ipv4()}:${PORTAINER_PORT}`;
        scrubber.add(portainerUrl, "portainer-address");
        scrubber.add(`${run.ipv4()}:${PORTAINER_PORT}`, "portainer-address");
        const seen = await waitFor(
          "Portainer's certificate from this computer (the firewall lets only this computer in)",
          minutes(3),
          async () => inspectCertificate(portainerUrl),
          5_000,
        );
        fingerprint = seen.fingerprint;
        // As the user guide says: read the fingerprint on the Portainer host with openssl.
        const openssl = opensslFingerprint(
          await shell.ok(
            `openssl s_client -connect localhost:${PORTAINER_PORT} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`,
          ),
        );
        expect(openssl, "the guide's openssl command prints a fingerprint").toBeDefined();
        expect(
          sameCertFingerprint(openssl as string, fingerprint),
          "the guide's openssl command shows the fingerprint OpsCrew reads",
        ).toBe(true);
        observe(
          "the user guide's openssl command on the Portainer host shows the same fingerprint OpsCrew reads",
        );

        // Admin initialisation needs the setup token Portainer prints once (research R10).
        const anonymous = new PortainerApi(portainerUrl, fingerprint);
        const setupToken = await waitFor(
          "Portainer's setup_token= line in `docker logs portainer`",
          minutes(1),
          async () => setupTokenFromLogs(await shell.ok("docker logs portainer 2>&1")),
          3_000,
        );
        scrubber.add(setupToken, "portainer-setup-token");
        const adminPassword = randomBytes(24).toString("base64url");
        scrubber.add(adminPassword, "portainer-admin-password");
        // The answer includes the admin's password hash: it is never logged.
        const init = await anonymous.call("POST", "/api/users/admin/init", {
          json: { Username: ADMIN_USER, Password: adminPassword },
          headers: { "X-Setup-Token": setupToken },
        });
        if (init.status !== 200)
          throw new Error(`Portainer refused the admin initialisation (HTTP ${init.status}).`);
        const login = async (username: string, password: string) => {
          const auth = await anonymous.ok<{ jwt?: string }>("POST", "/api/auth", "log in", {
            json: { Username: username, Password: password },
          });
          if (!auth.jwt) throw new Error("Portainer's login answered without a session.");
          scrubber.add(auth.jwt, "portainer-session");
          return auth.jwt;
        };
        const session = anonymous.withSession(await login(ADMIN_USER, adminPassword));

        // A fresh install has no environment: the local Docker host is added (research R10).
        const created = await session.ok<{ Id: number }>(
          "POST",
          "/api/endpoints",
          "add the local environment",
          { form: multipartForm({ Name: ENVIRONMENT_NAME, EndpointCreationType: "1" }) },
        );
        environmentId = created.Id;
        await waitFor(
          "the local environment's first snapshot",
          minutes(2),
          async () => {
            const environment = await session.ok<{ Snapshots?: unknown[] }>(
              "GET",
              `/api/endpoints/${environmentId}`,
              "read the environment",
            );
            return (environment.Snapshots ?? []).length > 0 ? true : undefined;
          },
          5_000,
        );

        const me = await session.ok<{ Id: number }>("GET", "/api/users/me", "read the admin");
        const adminKey = await session.ok<{ rawAPIKey?: string }>(
          "POST",
          `/api/users/${me.Id}/tokens`,
          "create the admin's token",
          { json: { description: "opscrew-e2e admin", password: adminPassword } },
        );
        if (!adminKey.rawAPIKey)
          throw new Error("Portainer created the admin's token without returning it.");
        adminToken = adminKey.rawAPIKey;
        scrubber.add(adminToken, "PORTAINER_API_KEY");
        admin = anonymous.withToken(adminToken);
        const version = await portainer().ok<{
          ServerVersion?: string;
          Dependencies?: { ComposeVersion?: string };
        }>("GET", "/api/system/version", "read its version");
        observe(
          `Portainer ${version.ServerVersion ?? "?"} with Compose ${version.Dependencies?.ComposeVersion ?? "?"}`,
        );

        // A limited user (role 2) the administrator gave access to the environment, and its token.
        const limitedPassword = randomBytes(24).toString("base64url");
        scrubber.add(limitedPassword, "portainer-limited-password");
        const limited = await portainer().ok<{ Id: number }>(
          "POST",
          "/api/users",
          "create the limited user",
          { json: { Username: LIMITED_USER, Password: limitedPassword, Role: 2 } },
        );
        limitedUserId = limited.Id;
        await portainer().ok(
          "PUT",
          `/api/endpoints/${environmentId}`,
          "give the limited user the environment",
          { json: { UserAccessPolicies: { [String(limitedUserId)]: { RoleId: 0 } } } },
        );
        const limitedSession = anonymous.withSession(await login(LIMITED_USER, limitedPassword));
        const limitedKey = await limitedSession.ok<{ rawAPIKey?: string }>(
          "POST",
          `/api/users/${limitedUserId}/tokens`,
          "create the limited user's token",
          { json: { description: "opscrew-e2e limited", password: limitedPassword } },
        );
        if (!limitedKey.rawAPIKey)
          throw new Error("Portainer created the limited token without returning it.");
        limitedToken = limitedKey.rawAPIKey;
        scrubber.add(limitedToken, "PORTAINER_API_KEY (limited)");
        const visible = await anonymous
          .withToken(limitedToken)
          .ok<{ Id: number }[]>(
            "GET",
            "/api/endpoints",
            "list environments with the limited token",
          );
        expect(
          visible.map((item) => item.Id),
          "the limited token sees the environment",
        ).toContain(environmentId);

        // The user's own Portainer stack.
        const decoy = await portainer().ok<{ Id: number }>(
          "POST",
          `/api/stacks/create/standalone/string?endpointId=${environmentId}`,
          "create the decoy stack",
          {
            json: {
              Name: DECOY_STACK,
              StackFileContent: [
                "services:",
                "  sleeper:",
                `    image: ${BUSYBOX_IMAGE}`,
                '    command: ["sh", "-c", "while true; do sleep 3600; done"]',
                "    restart: unless-stopped",
                "    environment:",
                "      DECOY_VALUE: ${DECOY_VALUE}",
                "    volumes: [decoy_stack_data:/data]",
                "volumes:",
                "  decoy_stack_data: {}",
                "",
              ].join("\n"),
              Env: [{ name: "DECOY_VALUE", value: "the user's own value" }],
            },
            timeoutMs: minutes(5),
          },
        );
        decoyStackId = decoy.Id;
        await waitFor(
          "the decoy stack running",
          minutes(3),
          async () => {
            const stack = await portainer().ok<{ Status?: number }>(
              "GET",
              `/api/stacks/${decoyStackId}`,
              "read the decoy stack",
            );
            return stack.Status === 1 ? true : undefined;
          },
          5_000,
        );

        await probePortainer();

        decoysBefore = await decoys();
        portainerBefore = await portainerState();
        log("Portainer is set up as the user's: admin, limited user, local environment, decoys");
      },
    );

    /**
     * What the adapter assumes about Portainer itself, observed with a short-lived stack of the
     * test's own: whether a bare `NAME:` entry stays unset when the stack has no value for it (and
     * whether a bare entry takes a value from the stack's Env), and whether stopping a stack
     * removes its containers. Every result goes to the run log; none of them stops the run.
     */
    async function probePortainer(): Promise<void> {
      const probe = await portainer().ok<{ Id: number }>(
        "POST",
        `/api/stacks/create/standalone/string?endpointId=${environmentId}`,
        "create the probe stack",
        {
          json: {
            Name: PROBE_STACK,
            StackFileContent: [
              "services:",
              "  probe:",
              `    image: ${BUSYBOX_IMAGE}`,
              '    command: ["sh", "-c", "while true; do sleep 3600; done"]',
              "    environment:",
              "      PROBE_BARE_UNSET:",
              "      PROBE_BARE_SET:",
              "      PROBE_REFERENCED: ${PROBE_REFERENCED_UNSET}",
              "",
            ].join("\n"),
            Env: [{ name: "PROBE_BARE_SET", value: "from the stack's Env" }],
          },
          timeoutMs: minutes(5),
        },
      );
      const containers = () =>
        run.shell().ok(`docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${PROBE_STACK}`);
      try {
        const id = await waitFor(
          "the probe stack's container",
          minutes(3),
          async () => (await containers()).split("\n")[0]?.trim() || undefined,
          5_000,
        );
        const seen = envNames(
          await run.shell().ok(`docker inspect -f '{{json .Config.Env}}' ${id}`),
          "PROBE_",
        );
        const state = (name: string) => {
          const item = seen.find((entry) => entry.name === name);
          return item === undefined
            ? "unset"
            : item.empty
              ? "set to an empty value"
              : "set to a value";
        };
        observe(
          `a bare NAME: entry the stack has no value for is ${state("PROBE_BARE_UNSET")} in the container`,
        );
        observe(
          `a bare NAME: entry the stack's Env has a value for is ${state("PROBE_BARE_SET")} in the container`,
        );
        observe(
          `\${NAME} with no value in the stack's Env is ${state("PROBE_REFERENCED")} in the container`,
        );
        await portainer().ok(
          "POST",
          `/api/stacks/${probe.Id}/stop?endpointId=${environmentId}`,
          "stop the probe stack",
          { timeoutMs: minutes(3) },
        );
        const removed = await waitFor(
          "the probe stack stopped",
          minutes(2),
          async () => {
            const left = await containers();
            const stack = await portainer().ok<{ Status?: number }>(
              "GET",
              `/api/stacks/${probe.Id}`,
              "read the probe stack",
            );
            return stack.Status === 2 ? left === "" : undefined;
          },
          5_000,
        ).catch(() => undefined);
        observe(
          removed === undefined
            ? "stopping a stack: Portainer did not report it stopped within 2 minutes"
            : removed
              ? "stopping a stack removes its containers"
              : "stopping a stack keeps its containers (stopped)",
        );
      } finally {
        await portainer().call("DELETE", `/api/stacks/${probe.Id}?endpointId=${environmentId}`, {
          timeoutMs: minutes(3),
        });
      }
    }

    step(
      "1b. (optional) pauses so the guide's browser and Portainer UI steps can be checked by hand",
      minutes(Math.max(1, E2E.manualMinutes) + 5),
      async () => {
        if (E2E.manualMinutes <= 0) {
          log(
            "OPSCREW_E2E_PORTAINER_MANUAL_MINUTES is not set: the browser and UI steps of the guide stay unchecked by hand",
          );
          return;
        }
        // Written only on this computer (the run's temporary folder, deleted at the end), never printed.
        const file = join(run.work, "manual-check.txt");
        await writeFile(
          file,
          [
            `Portainer: ${portainerUrl} (only this computer may reach it)`,
            `Admin: ${ADMIN_USER} / ${scrubber.value("portainer-admin-password")}`,
            `The fingerprint OpsCrew pins: ${fingerprint}`,
            "Check in a browser: the padlock shows this SHA-256 fingerprint; Registries → Add registry → Custom registry",
            "has the fields the guide names; the environment's Registries page has Manage access.",
            "Look only: do not save, add or change anything in Portainer (the run compares it with how it was).",
            "Delete this file to continue.",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        log(
          `the address and login are in ${file}; delete it to continue (waiting up to ${E2E.manualMinutes} minutes)`,
        );
        await waitFor(
          "the manual check (delete the file to continue)",
          minutes(E2E.manualMinutes),
          async () => (existsSync(file) ? undefined : true),
          5_000,
        ).catch(async () => {
          await rm(file, { force: true });
          log("the manual check timed out; continuing");
        });
        // A look in the UI may have touched something (a login, a setting): compare from here on.
        decoysBefore = await decoys();
        portainerBefore = await portainerState();
      },
    );

    step(
      "2a. prepares the project: init, analyze, the interview and design for updater + tunnel, adapt",
      minutes(30),
      async () => {
        const first = await run.initFix();
        if (![0, 1].includes(first.exitCode)) {
          throw new Error(
            `opscrew init failed before the interview (exit ${first.exitCode}):\n${run.tail(first.output)}`,
          );
        }
        const failedBefore = failedInitChecks(first.output);
        if (failedBefore.length > 0)
          log(`init before the interview: failed checks ${failedBefore.join(", ")}`);
        await run.opscrewOk("analyze", "--no-ai");
        run.env.PORTAINER_API_KEY = adminToken;
        await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "tunnel" });
        const requirements = await readFile(run.paths().files.requirements, "utf8");
        expect(
          leakedLabels(requirements, scrubber.entries()),
          "requirements.yaml holds no address or secret",
        ).toEqual([]);
        const init = await run.opscrew("init");
        const failedAfter = failedInitChecks(init.output);
        if (init.exitCode !== 0 || failedAfter.length > 0) {
          run.findings.push(
            `opscrew init after the Portainer interview exited with ${init.exitCode}${failedAfter.length > 0 ? `; failed checks: ${failedAfter.join(", ")}` : ""}`,
          );
        }
        const plan = await run.readPlan();
        run.appName = plan.app.name;
        expect(plan.target, "the environment's architecture").toMatchObject({ arch: "amd64" });

        const zone = await run.snapshotCloudflare((z) => [
          appHost,
          `www.${appHost}`,
          `portainer-${run.app()}.${z.name}`,
        ]);
        // The rules of every zone ruleset before the run: compared in the cleanup.
        for (const ruleset of await zoneRulesets(run.cloudflare, zone)) {
          rulesetsBefore.set(ruleset.id, {
            name: ruleset.name,
            rules: await rulesetRules(run.cloudflare, zone, ruleset.id).catch(() => undefined),
          });
        }
        // Before the first provision: a rule of the user's own in each of OpsCrew's phases.
        await run.seedUserRules();
        await run.adaptAndMerge();
      },
    );

    step(
      "2. updater + tunnel: the limited token's registry steps, three provision runs, deploy, verify, secure, drift",
      minutes(90),
      async () => {
        await limitedTokenRegistrySteps();

        const stackHash = await threeRuns("updater + tunnel, first setup", true);
        // A tunnel app in a Portainer is in OpsCrew's probe block only (no strict TLS there).
        await run.expectSharedCloudflare("the updater + tunnel provision");

        // The deploy branch OpsCrew created with the real fine-grained token (createOrphanBranch).
        await expectPlaceholderBranch("the first setup");
        observe(
          "createOrphanBranch with the fine-grained token (Contents: write) made a root commit holding only compose.yaml",
        );

        const record = await createdRecord();
        expect(
          record.stacks.map((stack) => stack.role).sort(),
          "OpsCrew recorded the app and the updater",
        ).toEqual(["app", "updater"]);
        expect(
          record.registryId,
          "with an admin token OpsCrew added the registry entry",
        ).toBeDefined();
        registryId = record.registryId;
        await rememberSecrets(["tunnel_token"]);
        if (stackHash !== undefined) {
          expect(
            planFiles.get(`stack-${stackHash}.json`),
            "the approved stack plan is saved in .opscrew/plans",
          ).toBeDefined();
        }

        // What Portainer returns for the app's Git stack (shapes only, never values).
        const stack = await stackByName(names().app);
        expect(stack, "Portainer has the app's stack").toBeDefined();
        const gitConfig = stack?.GitConfig as { ReferenceName?: string } | null | undefined;
        observe(
          gitConfig
            ? `GET /api/stacks/{id} returns GitConfig ${valueShape(gitConfig)}`
            : "GET /api/stacks/{id} returns no GitConfig",
        );
        expect(gitConfig?.ReferenceName, "the app stack follows the deploy branch").toBe(
          DEPLOY_REFERENCE,
        );
        const autoUpdate = stack?.AutoUpdate as
          | { Webhook?: string; ForcePullImage?: boolean }
          | undefined;
        expect(
          autoUpdate?.Webhook === scrubber.value("portainer-webhook"),
          "the stack's webhook is the one OpsCrew keeps",
        ).toBe(true);
        expect(autoUpdate?.ForcePullImage, "AutoUpdate.ForcePullImage").toBe(false);
        observe(
          `AutoUpdate ${valueShape(autoUpdate)}; DeploymentStatus ${valueShape(stack?.DeploymentStatus)}`,
        );

        await run.deploy("the first deploy, updater + tunnel");
        web = "tunnel";
        const image = await deployBranchImage();
        await waitForSite(image.version);
        const file = await portainer().ok<{ StackFileContent?: string }>(
          "GET",
          `/api/stacks/${stack?.Id}/file`,
          "read the app stack's file",
        );
        if (file.StackFileContent?.includes(image.digest) !== true)
          run.findings.push(
            "GET /api/stacks/{id}/file did not return the Git stack's deployed file",
          );
        else
          observe(
            "GET /api/stacks/{id}/file returns the Git stack's deployed file (with the new image)",
          );

        const volumes = await appVolumes();
        recordedVolumes = (await createdRecord()).volumes;
        observe(
          `the app's volumes carry ${COMPOSE_PROJECT_LABEL} (${volumes.length} found, ${recordedVolumes.length} recorded)`,
        );
        for (const volume of recordedVolumes) {
          expect(volumes, `the recorded volume ${volume} carries the project label`).toContain(
            volume,
          );
        }

        await ghcrFacts(image);

        // provision created the tunnel's record.
        await waitForLocalResolution("step 2 (the tunnel's record)");
        await run.opscrewOk("verify");
        const secure = await run.opscrewOk("secure");
        expect(secure.output.includes("SECURITY_REPORT.md"), "secure wrote its report").toBe(true);
        await run.opscrewOk("drift");
        observe("drift's git fetch of the deploy branch worked against the real GitHub remote");
        const again = await run.opscrewOk("provision", "--plan-only", "--yes");
        expect(
          approveHashes(again.output),
          `a re-run plans nothing:\n${run.tail(again.output)}`,
        ).toEqual([]);
        expect(again.output, "a re-run says nothing is to apply").toMatch(/Nothing to apply/);
        await expectDecoysUnchanged("the first setup");
      },
    );

    /**
     * FR-1018 with the limited user's token: a private image and no usable ghcr.io entry stop
     * provision before any change with the registry steps; after the user guide's step 1 (as the
     * administrator: a Custom registry for ghcr.io, granted to the user on the environment) the
     * same token gets past that check. The entry is removed again before the admin flow.
     */
    async function limitedTokenRegistrySteps(): Promise<void> {
      const limitedEnv = { PORTAINER_API_KEY: limitedToken };
      const stacksBefore = await stackNames();
      const refused = await run.opscrewWith(limitedEnv, "provision", "--plan-only", "--yes");
      if (refused.exitCode === 0 || !refused.output.includes("no ghcr.io registry entry")) {
        run.findings.push(
          `with the limited token and a private image, provision --plan-only exited with ${refused.exitCode} without the registry steps (FR-1018)`,
        );
      } else {
        observe(
          "limited token, private image, no registry entry: provision stopped before any change with the registry steps (FR-1018)",
        );
      }
      expect(await stackNames(), "the refused run changed nothing in Portainer").toEqual(
        stacksBefore,
      );
      const entry = await portainer().ok<{ Id: number }>(
        "POST",
        "/api/registries",
        "add the guide's registry entry",
        {
          json: {
            Name: "ghcr-e2e",
            Type: 3,
            URL: "ghcr.io",
            BaseURL: "",
            Authentication: true,
            Username: owner,
            Password: E2E.ghcrToken,
          },
        },
      );
      try {
        await portainer().ok(
          "PUT",
          `/api/endpoints/${environmentId}/registries/${entry.Id}`,
          "let the limited user use the entry",
          {
            json: {
              UserAccessPolicies: { [String(limitedUserId)]: { RoleId: 0 } },
              TeamAccessPolicies: {},
              Namespaces: [],
            },
          },
        );
        const passed = await run.opscrewWith(limitedEnv, "provision", "--plan-only", "--yes");
        if (passed.exitCode !== 0) {
          run.findings.push(
            `after the guide's registry steps, provision --plan-only with the limited token still exited with ${passed.exitCode}`,
          );
        } else {
          observe(
            "after the guide's registry steps (done through the API), the limited token plans the deploy",
          );
        }
      } finally {
        await portainer().call("DELETE", `/api/registries/${entry.Id}`);
      }
    }

    /**
     * GHCR's answers for the registry entry's login: the GitHub owner as the user name (what the
     * guide's limited-token steps type), another user name (OpsCrew sends the entry's own name,
     * `opscrew-<app>`), and a wrong token. A refused owner or other user name is a finding.
     */
    async function ghcrFacts(image: DeployedImage): Promise<void> {
      const repository = image.repository.replace(/^ghcr\.io\//, "");
      const name = repository.split("/").slice(1).join("/");
      const visibility = await packageVisibility(E2E.ghcrToken, owner, ownerType, name).catch(
        () => undefined,
      );
      const asOwner = await ghcrPullStatus(repository, owner, E2E.ghcrToken);
      const asOther = await ghcrPullStatus(repository, "opscrew-e2e-any-user", E2E.ghcrToken);
      const wrong = await ghcrPullStatus(repository, owner, `not-a-token-${randomUUID()}`);
      observe(
        `GHCR (${visibility ?? "visibility unknown"} package): the owner as user name → HTTP ${asOwner}, another user name → HTTP ${asOther}, a wrong token → HTTP ${wrong}`,
      );
      if (asOwner !== 200)
        run.findings.push(
          `GHCR refused the GitHub owner as the registry user name (HTTP ${asOwner})`,
        );
      if (asOther !== 200)
        run.findings.push(
          `GHCR refused a user name other than the owner, which OpsCrew's own entries use (HTTP ${asOther})`,
        );
      if (visibility === "public")
        observe("the package is public, so the registry user name checks are inconclusive");
    }

    step(
      "3. a merged change deploys by itself within 5 minutes; an unchanged branch is not redeployed",
      minutes(60),
      async () => {
        // Research R5: neither a webhook call nor the updater redeploys an unchanged branch.
        const webhookId = scrubber.value("portainer-webhook");
        await watchUpdater(
          "a webhook call and the updater on an unchanged branch",
          120,
          async () => {
            const code = await run
              .shell()
              .ok(
                `curl -sk -o /dev/null -w '%{http_code}' -X POST https://127.0.0.1:${PORTAINER_PORT}/api/stacks/webhooks/${webhookId}`,
              );
            observe(`a webhook call for the unchanged branch answered HTTP ${code}`);
          },
        );
        await mergeChange(
          "e2e: a change that deploys by itself",
          { "opscrew-e2e-change.txt": `Deployed by itself in run ${run.runId}.\n` },
          "success",
        );
        await expectDecoysUnchanged("the self-deploy");
      },
    );

    step(
      "3b. a failing change rolls back to the previous version, and a revert deploys again",
      minutes(75),
      async () => {
        const good = await deployBranchImage();
        const dockerfile = (await run.readPlan()).app.dockerfile;
        const original = await readFile(join(run.repo, dockerfile), "utf8");
        // The same image with a last `CMD` that exits at once: the new version never answers.
        const failingRun = await mergeChange(
          "e2e: a deliberately failing change",
          {
            [dockerfile]: `${original.trimEnd()}\n\n# opscrew-e2e: a deliberately failing version; the deploy must roll back.\nCMD ["/bin/sh", "-c", "echo 'opscrew-e2e: failing on purpose'; exit 1"]\n`,
          },
          "failure",
        );
        const steps = await runSteps(run.github, failingRun);
        const waited = steps.find((item) => item.step === "Wait until the new version answers");
        expect(waited?.conclusion, "the failing version did not answer").toBe("failure");
        const rollback = steps.find((item) => item.step === "Roll back to the previous version");
        // The rollback step always fails the job by design; its error line says what it did.
        expect(
          rollback?.conclusion === "success" || rollback?.conclusion === "failure",
          `the rollback step ran (conclusion ${String(rollback?.conclusion)})`,
        ).toBe(true);
        // Only the job log's `##[error]` messages are read; the log itself is never printed.
        const outcome = rollbackOutcome(
          await jobErrors(run.github, failingRun, "Deploy to Portainer"),
        );
        if (!outcome.ok) throw new Error(run.scrub(outcome.message));
        observe(`the rollback reported: ${outcome.message}`);
        const restored = await commitDetails(
          run.github,
          (await branchHead(DEPLOY_BRANCH)) as string,
        );
        expect(
          restored.subject,
          `the ${DEPLOY_BRANCH} branch's newest commit is the rollback`,
        ).toBe("Roll back to the previous version");
        expect(
          (await deployBranchImage()).digest,
          "the rollback wrote the previous image back",
        ).toBe(good.digest);
        await waitForSite(good.version, minutes(10));
        const stack = await stackByName(names().app);
        observe(
          `after the rollback the app stack has Status ${String(stack?.Status)}; DeploymentStatus ${valueShape(stack?.DeploymentStatus)}`,
        );
        observe("a deliberately failing change rolled back to the previous version");

        // The revert also changes a file, so its image differs from the one before the failure.
        await mergeChange(
          "e2e: revert the failing change",
          {
            [dockerfile]: original,
            "opscrew-e2e-change.txt": `Reverted in run ${run.runId}.\n`,
          },
          "success",
        );
        await expectDecoysUnchanged("the rollback and the revert");
      },
    );

    step(
      "4. an apply through MCP: opscrew_plan and opscrew_apply replace the registry token (the entry stays granted)",
      minutes(45),
      async () => {
        const mcp = await McpSession.start({
          cli: CLI,
          cwd: run.repo,
          env: run.env,
          // The user's answer in the dialog: approve what this step expects, nothing that deletes.
          approve: (message) =>
            !message.includes("WARNING: this change deletes or replaces resources"),
        });
        try {
          const replaceTokens = ["registry"];
          const planned = await mcp.call("opscrew_plan", { projectDir: run.repo, replaceTokens });
          expect(planned.isError, `opscrew_plan:\n${run.tail(planned.text)}`).toBe(false);
          const stackHash = planned.data.stackPlanHash;
          expect(typeof stackHash, "opscrew_plan returns the stack plan's hash").toBe("string");
          const applied = await mcp.call("opscrew_apply", {
            projectDir: run.repo,
            planHash: stackHash,
            replaceTokens,
          });
          expect(applied.isError, `opscrew_apply:\n${run.tail(applied.text)}`).toBe(false);
          expect(
            mcp.dialogs.some(
              (dialog) => dialog.approved && dialog.message.includes(stackHash as string),
            ),
            "the stack plan was approved in its own dialog",
          ).toBe(true);
          observe(
            `opscrew_apply ran the real provision through MCP (${mcp.dialogs.length} dialog(s)) and replaced the registry token`,
          );
        } finally {
          mcpTexts.push(...mcp.transcript);
          await mcp.close();
        }
        await run.expectSharedCloudflare("the apply through MCP");
        if (Object.keys(await registryAccesses()).includes(String(environmentId))) {
          observe(
            "after a registry token replace through MCP the entry is still granted to the environment",
          );
        } else {
          run.findings.push(
            "after a registry token replace through MCP the entry is no longer granted to the environment",
          );
        }
        await run.deploy("the token replace through MCP");
        await waitForSite((await deployBranchImage()).version, minutes(10));
        await expectDecoysUnchanged("the apply through MCP");
      },
    );

    step(
      "5. caddy: the app stack updated in place, the DNS record OpsCrew prints, certificates on 80/443",
      minutes(120),
      async () => {
        // From here on OpsCrew uses the full Cloudflare token (removing the tunnel needs it anyway).
        useFullCloudflareToken("steps 2–4");
        await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "caddy" });
        const envShape = (stack: Record<string, unknown> | undefined) =>
          JSON.stringify(
            ((stack?.Env as { name?: string }[] | undefined) ?? []).map((item) => item.name).sort(),
          );
        const stackBefore = await stackByName(names().app);

        /** What the public resolver answers for `name` now: record types only, never an address. */
        const publicAnswer = async (name: string, type: "A" | "AAAA" | "CNAME") => {
          const answer = await dohQuery(fetch, name, type);
          if (answer.state !== "answer") return answer.state;
          const kinds: Record<number, string> = { 1: "A", 5: "CNAME", 28: "AAAA" };
          const records = answer.records.map((record) => {
            const to =
              record.type === 1
                ? record.data === run.ipv4()
                  ? "the server's address"
                  : "another address"
                : record.type === 28
                  ? "an IPv6 address"
                  : "a name";
            return `${kinds[record.type] ?? `type ${record.type}`} to ${to} (TTL ${record.TTL ?? "?"})`;
          });
          return records.length > 0 ? records.join(", ") : "no answer";
        };
        /**
         * After a failed caddy deploy: the public resolver's answers and the Caddy container's log
         * lines about certificates (read on the host as root), scrubbed.
         */
        const caddyDiagnostics = async (checked: readonly string[]) => {
          for (const name of checked) {
            for (const type of ["A", "AAAA", "CNAME"] as const) {
              observe(
                `diagnostics: cloudflare-dns.com answers ${name} ${type} with ${await publicAnswer(name, type)}`,
              );
            }
          }
          const lines = (
            await run
              .shell()
              .ok(
                `docker ps -aq --filter label=${COMPOSE_PROJECT_LABEL}=${names().app} --filter label=com.docker.compose.service=caddy | head -n 1 | xargs -r docker logs --tail 2000 2>&1 | grep -iE 'certificate|acme|challenge|tls|error' | tail -n 40 || true`,
              )
          )
            .split("\n")
            .filter(Boolean);
          observe(`diagnostics: Caddy logged ${lines.length} line(s) about certificates or errors`);
          for (const line of lines) observe(`diagnostics: caddy: ${line.trim().slice(0, 500)}`);
        };

        // The removal deletes the tunnel's records, so the user's record cannot exist yet: provision
        // stops before Caddy can start (Let's Encrypt would cache the missing record) and names it.
        const CADDY_WAITS = "no DNS record that points at your Portainer host yet";
        let stop: string | undefined;
        try {
          await run.provisionUntilDone("caddy");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes(CADDY_WAITS)) throw error;
          stop = message;
        }
        expect(
          stop,
          "provision stops before Caddy starts while the domain has no record",
        ).toContain(`${appHost} has ${CADDY_WAITS}`);
        expect(stop, "the stop says the next provision continues").toContain(
          "it continues from there",
        );
        log("provision stopped before Caddy starts: the domain has no DNS record yet");
        const plan = await run.readPlan();
        const z = run.zone as CloudflareZone;
        const hosts = plan.dns.www ? [appHost, `www.${appHost}`] : [appHost];
        for (const name of hosts) {
          await waitFor(`the tunnel's record on ${name} gone`, minutes(5), async () => {
            const left = await run.cloudflare.list<{ name: string }>(
              `/zones/${z.id}/dns_records?name=${encodeURIComponent(name)}`,
            );
            return left.length === 0 ? true : undefined;
          });
          testRecords.push(
            await createDnsRecord(run.cloudflare, z, { type: "A", name, content: run.ipv4() }),
          );
        }
        log("created the DNS record OpsCrew named (DNS only, to the server)");
        // OpsCrew checks through Cloudflare's public resolver, which may remember the missing
        // record for up to 30 minutes (the zone's SOA): wait there until it answers with the server.
        for (const name of hosts) {
          await waitFor(
            `${name} resolving to the server through the public resolver`,
            minutes(35),
            async () => {
              const answer = await dohQuery(fetch, name, "A");
              if (answer.state === "unknown") throw new Error(`the resolver: ${answer.problem}`);
              return answer.state === "answer" &&
                answer.records.some((record) => record.type === 1 && record.data === run.ipv4())
                ? true
                : undefined;
            },
            30_000,
          );
        }
        observe("provision waited for the domain's record before Caddy started");
        const provisioned = await run.provisionUntilDone("caddy");
        expect(
          provisioned.includes(`OpsCrew creates no DNS record for ${appHost}`),
          "provision names the DNS record to create",
        ).toBe(true);
        // Without the tunnel, the app's hostnames left OpsCrew's probe block.
        await run.expectSharedCloudflare("the switch to caddy");
        try {
          await run.deploy("caddy");
          web = "caddy";
          await waitForSite((await deployBranchImage()).version, minutes(15));
        } catch (error) {
          // A failed deploy here may be Caddy's or a DNS cache's: record both (scrubbed).
          await caddyDiagnostics(hosts).catch((problem: unknown) => {
            observe(
              `step 5 diagnostics failed: ${problem instanceof Error ? problem.message : String(problem)}`,
            );
          });
          throw error;
        }
        const stack = await stackByName(names().app);
        const keys = ((stack?.Env as { name?: string }[] | undefined) ?? []).map(
          (item) => item.name,
        );
        expect(keys, "the app stack no longer has the tunnel's token").not.toContain(
          "OPSCREW_TUNNEL_TOKEN",
        );
        expect(
          { Id: stack?.Id, CreationDate: stack?.CreationDate },
          "the switch kept the same app stack (not deleted and created again)",
        ).toEqual({ Id: stackBefore?.Id, CreationDate: stackBefore?.CreationDate });
        expect(
          stack?.UpdateDate !== stackBefore?.UpdateDate ||
            envShape(stack) !== envShape(stackBefore),
          "the app stack was changed by the switch (UpdateDate or its variables)",
        ).toBe(true);
        observe(
          "the app stack was updated in place (POST /api/stacks/{id}/git, then PUT …/git/redeploy)",
        );
        expect(await canConnect(run.ipv4(), 443), "Caddy serves 443 on the host").toBe(true);
        // The tunnel's records went and the user's A record came.
        await waitForLocalResolution("step 5 (the A record to the host)");
        await run.opscrewOk("verify");
        await run.opscrewOk("drift");
        const left = await run.cloudflare.appResources(z, run.app(), run.hostnames);
        expect(
          left.tunnels.map((t) => t.name),
          "the app's tunnel is gone",
        ).toEqual([]);
        await expectDecoysUnchanged("the switch to caddy");
      },
    );

    /** The test's own DNS records (step 5's) go: the user points the domain elsewhere. */
    async function removeTestRecords(): Promise<void> {
      const z = run.zone as CloudflareZone;
      for (const id of testRecords.splice(0)) {
        await run.cloudflare.call("DELETE", `/zones/${z.id}/dns_records/${id}`);
      }
    }

    /**
     * Switches OpsCrew to the full Cloudflare token when the run gave it the narrower tunnel token
     * so far (removing the tunnel needs the full one), and records that the steps before worked.
     */
    function useFullCloudflareToken(before: string): void {
      if (run.env.CLOUDFLARE_API_TOKEN === SETTINGS.cloudflareToken) return;
      run.env.CLOUDFLARE_API_TOKEN = SETTINGS.cloudflareToken;
      observe(
        `the updater + tunnel setup (${before}) worked with OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN`,
      );
    }

    step("6. proxy: the app on a host port, `verify --url <route>`", minutes(60), async () => {
      useFullCloudflareToken("the steps before 6");
      // The user points the domain at their own reverse proxy: the record to Caddy goes first, so
      // the deploy workflow's reachability probe does not find the old Caddy on 443.
      await removeTestRecords();
      await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "proxy" });
      const provisioned = await run.provisionUntilDone("proxy");
      expect(
        provisioned.includes(`port ${PROXY_PORT}`),
        "provision names the port to route to",
      ).toBe(true);
      await run.expectSharedCloudflare("the switch to proxy");
      await run.deploy("proxy");
      web = "proxy";
      await waitForSite((await deployBranchImage()).version, minutes(10));
      await run.opscrewOk("verify", "--url", `http://${run.ipv4()}:${PROXY_PORT}`);
      observe("verify --url with a route on the Portainer host passed");
      await run.opscrewOk("drift");
      await waitFor(
        "Caddy leaving ports 80 and 443",
        minutes(3),
        async () => ((await canConnect(run.ipv4(), 443, 3_000)) ? undefined : true),
        5_000,
      );
      await expectDecoysUnchanged("the switch to proxy");
    });

    step(
      "7. Cloudflare redeploys with the tunnel: three runs, a deploy through Access, 404 outside the webhook, a token replace",
      minutes(75),
      async () => {
        useFullCloudflareToken("the steps before 7");
        const z = run.zone as CloudflareZone;
        await removeTestRecords();
        await answerAndDesign({ url: portainerUrl, redeploy: "cloudflare", web: "tunnel" });
        await threeRuns("Cloudflare redeploy + tunnel", false);
        // Back in the probe block; the webhook's Access uses (or creates) the Zero Trust organization.
        await run.expectSharedCloudflare("the switch to Cloudflare redeploys with the tunnel");
        await rememberSecrets([
          "tunnel_token",
          "portainer_tunnel_token",
          "deploy_service_token_client_id",
          "deploy_service_token_client_secret",
        ]);
        const deployed = await run.deploy("Cloudflare redeploy + tunnel");
        web = "tunnel";
        if (deployed !== undefined) {
          const asked = (await runSteps(run.github, deployed)).find(
            (item) => item.step === "Ask Portainer to deploy the new version",
          );
          expect(asked?.conclusion, "the workflow asked Portainer through Access").toBe("success");
          observe(
            "the deploy workflow reached Portainer's webhook through Access (cloudflared → Portainer with no_tls_verify)",
          );
        }
        await waitForSite((await deployBranchImage()).version, minutes(10));
        const all = await stackNames();
        expect(all, "the updater stack is gone").not.toContain(names().updater);
        expect(all, "the connector stack runs").toContain(names().tunnelConnector);

        const host = `portainer-${run.app()}.${z.name}`;
        const refused = await waitForAccessRefusal(`https://${host}/api/system/status`);
        observe(
          `Portainer's hostname refuses a request without the service token (HTTP ${refused})`,
        );
        const headers = {
          "CF-Access-Client-Id": scrubber.value("deploy-service-token-client-id"),
          "CF-Access-Client-Secret": scrubber.value("deploy-service-token-client-secret"),
        };
        for (const path of ["/", "/api/system/status", "/api/users/me"]) {
          const answer = await httpRequest(`https://${host}${path}`, { headers });
          expect(answer.status, `${host}${path} with the service token answers 404`).toBe(404);
        }
        observe(
          "with the service token, Portainer's hostname answers 404 outside /api/stacks/webhooks/",
        );

        // An earlier verify may have looked the domain up while it had no record, so this
        // computer may still hold "no such name" for the tunnel's new record.
        await waitForLocalResolution("step 7 (the tunnel's record)");
        await run.opscrewOk("verify");
        await run.opscrewOk("secure");
        await run.opscrewOk("drift");
        const again = await run.opscrewOk("provision", "--plan-only", "--yes");
        expect(approveHashes(again.output), "a re-run plans nothing").toEqual([]);

        // Replacing the registry (and a private repository's) token keeps the entry granted.
        const replace = ["registry", ...(repoPrivate ? ["repository"] : [])].flatMap((t) => [
          "--replace-token",
          t,
        ]);
        const before = await registryAccesses();
        const planned = await run.opscrewOk("provision", "--plan-only", ...replace, "--yes");
        const hashes = approveHashes(planned.output);
        expect(hashes.length, "replacing a token plans a change").toBeGreaterThan(0);
        await run.opscrewOk(
          "provision",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          ...replace,
          "--yes",
        );
        await run.deploy("the token replace");
        const after = await registryAccesses();
        if (!Object.keys(after).includes(String(environmentId)))
          run.findings.push(
            "after a registry token replace the entry is no longer granted to the environment",
          );
        else
          observe(
            `after a registry token replace the entry is still granted to the environment (${changedKeys(before, after).length === 0 ? "unchanged" : "access changed"})`,
          );
        await waitForSite((await deployBranchImage()).version, minutes(5));
        await expectDecoysUnchanged("the switch to Cloudflare redeploys and the token replace");
      },
    );

    step(
      "7b. a second app: its own stacks with the tunnel in the same Portainer, zone and account; both blocked on /.env, both in OpsCrew's probe block",
      minutes(60),
      async () => {
        const app = second();
        const info = await repoInfo(app.github);
        if (info.private && E2E.repoReadToken === undefined) {
          throw new Error(
            "The second throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN to one that covers both repositories (docs/e2e.md).",
          );
        }
        await app.prepareRepo({
          commit: `e2e: a second app (examples/${SETTINGS.app}) in your Portainer`,
          env: {
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: E2E.ghcrToken,
            ...(info.private ? { OPSCREW_REPO_READ_TOKEN: E2E.repoReadToken } : {}),
          },
          drop: ["PORTAINER_API_KEY", ...(info.private ? [] : ["OPSCREW_REPO_READ_TOKEN"])],
        });
        await app.initFix();
        await app.opscrewOk("analyze", "--no-ai");
        app.env.PORTAINER_API_KEY = adminToken;
        await answerAndDesign({ url: portainerUrl, redeploy: "updater", web: "tunnel" }, {}, app);
        app.appName = (await app.readPlan()).app.name;
        await app.snapshotCloudflare((z) => [
          app.appHost,
          `www.${app.appHost}`,
          `portainer-${app.app()}.${z.name}`,
        ]);
        await app.adaptAndMerge();
        await app.provisionUntilDone("the second app, updater + tunnel");
        await run.expectSharedCloudflare("the second app's provision");
        await rememberSecrets(["tunnel_token"], app);
        if ((await app.deploy("the second app")) === undefined)
          await app.deployMain("the second app");
        await app.waitForHealth();
        await app.opscrewOk("verify");
        if (web === "tunnel") await run.expectProbeBlocked(appHost);
        await run.expectProbeBlocked(app.appHost);
        observe(
          `a second app runs in the same Portainer, zone and account; OpsCrew's probe block lists both apps${web === "tunnel" ? "" : ` (the first one is in ${web} mode, so only the second)`}`,
        );
        await expectDecoysUnchanged("the second app's setup");
      },
      { skip: SECOND_SKIP },
    );

    step(
      "8. destroy keeps the data volumes; Portainer, its settings and the decoys stay; the second app keeps working",
      minutes(30),
      async () => {
        useFullCloudflareToken("the steps before 8");
        recordedVolumes = (await createdRecord()).volumes;
        await keepDeployBranch("destroy");
        const removed = await run.opscrewOk("destroy", "--confirm", run.app());
        run.destroyed = true;
        await expectDeployBranchDeleted(removed.output, "destroy");
        observe(`destroy deleted the ${DEPLOY_BRANCH} branch once the app's stack was gone`);
        expect(
          (await stackNames()).filter((name) => name.startsWith(names().app)),
          "no stack of the app is left",
        ).toEqual([]);
        if (registryId !== undefined) {
          const entry = await portainer().call("GET", `/api/registries/${registryId}`);
          expect(entry.status, "OpsCrew's registry entry is removed").toBe(404);
        }
        const volumes = await appVolumes();
        for (const volume of recordedVolumes) {
          expect(volumes, `destroy keeps the data volume ${volume}`).toContain(volume);
        }
        await run.expectCloudflareClean();
        await run.expectSharedCloudflare("the first app's destroy");
        if (secondUp()) {
          // SC-1102: the second app's tunnel and probe block still work.
          await second().waitForHealth();
          await run.expectProbeBlocked(second().appHost);
          observe("after the first app's destroy the second app still answers and is protected");
        }
        const secrets = await secretNames(run.github);
        const kept = [
          "OPSCREW_BUILD_ENV",
          "OPSCREW_PORTAINER_WEBHOOK_URL",
          "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
          "OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET",
        ].filter((name) => secrets.includes(name));
        if (kept.length > 0)
          run.findings.push(`destroy left the deploy secrets ${kept.join(", ")} in GitHub`);
        for (const file of ["portainer-webhook", "portainer-env.key"]) {
          if (existsSync(join(run.paths().projectHomeDir, file)))
            run.findings.push(`destroy left OpsCrew's ${file} file`);
        }
        const plansDir = run.paths().files.plansDir;
        const stackPlans = existsSync(plansDir)
          ? (await readdir(plansDir)).filter((name) => name.startsWith("stack-"))
          : [];
        if (stackPlans.length > 0)
          run.findings.push(`destroy left ${stackPlans.length} saved stack plan(s)`);
        await expectPortainerIntact("destroy");
        await expectDecoysUnchanged("destroy");
      },
    );

    step(
      "9. destroy --delete-data removes the data volumes, and nothing else",
      minutes(20),
      async () => {
        const secretsBefore = (await secretNames(run.github)).sort();
        const removed = await run.opscrewOk("destroy", "--confirm", run.app(), "--delete-data");
        // Data only: GitHub is left alone (the branch stays absent, the secrets as they were).
        expect(
          await branchHead(DEPLOY_BRANCH),
          `destroy --delete-data leaves the ${DEPLOY_BRANCH} branch absent`,
        ).toBeUndefined();
        expect(
          removed.output.includes(`Deleted the branch ${DEPLOY_BRANCH}`),
          "destroy --delete-data deletes no branch",
        ).toBe(false);
        expect(
          (await secretNames(run.github)).sort(),
          "destroy --delete-data leaves GitHub's secrets",
        ).toEqual(secretsBefore);
        const volumes = await appVolumes();
        for (const volume of recordedVolumes) {
          expect(volumes, `--delete-data removes ${volume}`).not.toContain(volume);
        }
        observe(`destroy --delete-data removed the ${recordedVolumes.length} recorded volume(s)`);
        await run.expectSharedCloudflare("destroy --delete-data");
        await expectPortainerIntact("destroy --delete-data");
        await expectDecoysUnchanged("destroy --delete-data");
      },
    );

    step(
      "9b. destroying the second app removes OpsCrew's shared rules; the seeded rules, the Zero Trust pieces, Portainer and the decoys stay",
      minutes(30),
      async () => {
        const app = second();
        await keepDeployBranch("second", app);
        await app.opscrewOk("destroy", "--confirm", app.app(), "--delete-data");
        app.destroyed = true;
        expect(
          (await stackNames()).filter((name) => name.startsWith(names(app).app)),
          "no stack of the second app is left",
        ).toEqual([]);
        await app.expectCloudflareClean();
        await run.expectSharedCloudflare("the second app's destroy");
        await expectPortainerIntact("the second app's destroy");
        await expectDecoysUnchanged("the second app's destroy");
      },
      { skip: SECOND_SKIP },
    );

    /**
     * Removes a fresh setup of steps 10 and 11 with its data (`destroy --confirm <app>
     * --delete-data`): no stack and no volume of the app are left, the deploy branch is deleted (its
     * history kept locally as `refs/e2e/deploy-<label>` for the leak search), Portainer and the
     * decoys are as before the run.
     */
    async function removeFreshSetup(
      what: string,
      label: string,
      overrides: Record<string, string | undefined> = {},
    ): Promise<void> {
      await keepDeployBranch(label);
      const removed = await run.opscrewOkWith(
        overrides,
        "destroy",
        "--confirm",
        run.app(),
        "--delete-data",
      );
      run.destroyed = true;
      await expectDeployBranchDeleted(removed.output, `removing ${what}`);
      expect(
        (await stackNames()).filter((name) => name.startsWith(names().app)),
        `no stack of the app is left after removing ${what}`,
      ).toEqual([]);
      expect(await appVolumes(), `no volume of the app is left after removing ${what}`).toEqual([]);
      await run.expectSharedCloudflare(`removing ${what}`);
      await expectPortainerIntact(`removing ${what}`);
      await expectDecoysUnchanged(`removing ${what}`);
    }

    step(
      "10. a loopback Portainer address: the updater reaches Portainer through host.docker.internal (a fresh setup, then removed)",
      minutes(60),
      async () => {
        // OpsCrew refuses another address while its record lists anything, so this runs after
        // destroy --delete-data emptied the record (or before anything was set up).
        await run.checkoutMain();
        await openTunnel();
        await answerAndDesign({
          url: `https://localhost:${PORTAINER_PORT}`,
          redeploy: "updater",
          web: "proxy",
        });
        const provisioned = await run.provisionUntilDone("the loopback address");
        await run.expectSharedCloudflare("the loopback setup");
        await rememberSecrets([]);
        // No deploy branch is left from before, so the new app stack starts from a new placeholder.
        expect(
          provisioned.includes(`Created the branch ${DEPLOY_BRANCH}`),
          `the fresh setup created the ${DEPLOY_BRANCH} branch anew`,
        ).toBe(true);
        expect(
          provisioned.includes(`Replaced the branch ${DEPLOY_BRANCH}`),
          `the fresh setup did not replace an earlier ${DEPLOY_BRANCH} branch`,
        ).toBe(false);
        const placeholderHead = await expectPlaceholderBranch("the loopback setup");
        if ((await run.deploy("the loopback address")) === undefined) {
          // provision opened no pull request: run the deploy workflow on main, as a user would.
          await run.deployMain("the loopback address");
        }
        web = "proxy";
        const line = (
          await run
            .shell()
            .ok(
              `docker ps -q --filter label=${COMPOSE_PROJECT_LABEL}=${names().updater} | head -n 1 | xargs -r docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}'`,
            )
        )
          .split("\n")
          .find((item) => item.startsWith("PORTAINER_WEBHOOK_URL="));
        expect(
          line?.includes(`://host.docker.internal:${PORTAINER_PORT}/api/stacks/webhooks/`),
          "with a loopback address the updater calls Portainer through host.docker.internal",
        ).toBe(true);
        await waitFor(
          `the deploy workflow writing the app to ${DEPLOY_BRANCH}`,
          minutes(15),
          async () => {
            const head = await branchHead(DEPLOY_BRANCH);
            return head !== undefined && head !== placeholderHead ? true : undefined;
          },
          10_000,
        );
        await waitForSite((await deployBranchImage()).version, minutes(10));
        observe(
          "with a loopback Portainer address the updater called Portainer through host.docker.internal",
        );
        await watchUpdater("the loopback address");
        await removeFreshSetup("the loopback setup", "loopback");
      },
    );

    step(
      "11. a short Portainer host name in the output check (a fresh setup, then removed)",
      minutes(45),
      async () => {
        if (tunnel === undefined || tunnel.exitCode !== null) await openTunnel();
        try {
          // The CLI reaches Portainer by a short name (default `nas`) through the SSH tunnel: a DNS
          // preload in its Node process resolves only that name. Containers on the server cannot
          // resolve it, so this setup is never deployed; it is checked, then removed.
          scrubber.add(`https://${shortHost}:${PORTAINER_PORT}`, "portainer-address");
          scrubber.add(`${shortHost}:${PORTAINER_PORT}`, "portainer-address");
          const preload = join(run.work, "short-host-dns.mjs");
          await writeFile(preload, dnsPreloadSource({ [shortHost]: "127.0.0.1" }));
          const short = {
            NODE_OPTIONS: [
              run.env.NODE_OPTIONS?.trim(),
              `--import="${pathToFileURL(preload).href}"`,
            ]
              .filter(Boolean)
              .join(" "),
          };
          const check = await run.runner.run(
            process.execPath,
            [
              "-e",
              `require("node:net").connect({ host: ${JSON.stringify(shortHost)}, port: ${PORTAINER_PORT} }).on("connect", function () { console.log("ok"); this.destroy(); }).on("error", (e) => console.log(e.code))`,
            ],
            { env: { ...run.env, ...short }, timeoutMs: 30_000 },
          );
          expect(
            check.stdout.trim(),
            `the CLI's Node process reaches Portainer as ${shortHost}`,
          ).toBe("ok");
          await answerAndDesign(
            { url: `https://${shortHost}:${PORTAINER_PORT}`, redeploy: "updater", web: "proxy" },
            short,
          );
          await run.provisionUntilDone("the short host name", short);
          await run.expectSharedCloudflare("the short-host setup");
          await rememberSecrets([]);
          // Never deployed: the app's stack runs the placeholder, so no app answers. secure and
          // drift run against that stack; their exits are recorded, not judged.
          await expectPlaceholderBranch("the short-host setup");
          const exits: string[] = [];
          for (const command of ["secure", "drift"]) {
            const result = await run.opscrewWith(short, command);
            exits.push(`${command} exited with ${result.exitCode}`);
          }
          const verified = await run.opscrewWith(
            short,
            "verify",
            "--url",
            `http://${run.ipv4()}:${PROXY_PORT}`,
          );
          observe(
            `with Portainer at "${shortHost}" and the placeholder deployed: provision passed, ${exits.join(", ")}; verify --url exited with ${verified.exitCode} (no app is expected to answer)`,
          );
          await removeFreshSetup("the short-host setup", "short-host", short);
        } finally {
          closeTunnel();
        }
      },
    );

    step(
      "12. no token, secret, server address or Portainer address in commits, pull requests, files, CLI output, MCP results, OpsCrew's Cloudflare record or the audit log",
      minutes(10),
      async () => {
        if (!run.repoReady) return;
        const known = scrubber.entries();
        const secrets = known.filter(
          ({ label }) =>
            !label.startsWith("server-") &&
            label !== "portainer-address" &&
            label !== "test-computer-ipv4",
        );
        const problems: string[] = [];
        // Every known value anywhere; the bare short host name (a common word) only in what OpsCrew
        // itself printed or saved (the app's own files and history may use it as a word), and only
        // when step 11 gave OpsCrew that name.
        const shortHostRan = SELECTED.includes("11");
        const search = (where: string, text: string, list = known, shortHostToo = shortHostRan) => {
          const found = leakedLabels(text, list);
          if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
          const mentions = shortHostToo ? shortHostMentions(text, shortHost) : 0;
          if (mentions > 0) {
            problems.push(`${where} names the short Portainer host ${mentions} time(s)`);
          }
        };
        for (const app of [run, ...(b?.repoReady === true ? [b] : [])]) {
          const which = app === run ? "" : " (the second app)";
          await app.git("fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
          // `--all` also walks refs/e2e/deploy-*: the deploy branches kept before each destroy
          // deleted them on GitHub.
          search(
            `the commits (every branch)${which}`,
            await app.git("log", "--all", "-p", "--format=%B"),
            known,
            false,
          );
          for (const pull of await app.github.pullRequestTexts()) {
            if (pull.createdAt >= app.startedAt) {
              search(`pull request #${pull.number}${which}`, pull.text);
            }
          }
          const tracked = (await app.git("ls-files", "-co", "--exclude-standard"))
            .split("\n")
            .filter(Boolean);
          for (const file of tracked) {
            const path = join(app.repo, file);
            if (!existsSync(path) || statSync(path).size > 1_000_000) continue;
            search(`the file ${file}${which}`, await readFile(path, "utf8"), known, false);
          }
          // The one local file meant to hold Portainer's address: the short host too.
          const local = join(app.paths().stateDir, "server.json");
          if (existsSync(local))
            search(`.opscrew/server.json${which}`, await readFile(local, "utf8"), secrets, false);
          const auditDir = app.paths().auditDir;
          if (existsSync(auditDir)) {
            for (const file of await readdir(auditDir)) {
              search(`the audit log ${file}${which}`, await readFile(join(auditDir, file), "utf8"));
            }
          }
        }
        for (const [label, output] of run.outputs) search(label, output);
        search("the MCP results", mcpTexts.join("\n"));
        for (const [file, content] of planFiles) {
          // OpenTofu encrypts saved plans: a search in the ciphertext finds only chance matches
          // of the short host.
          if (file.endsWith(".tfplan") && isEncryptedPlan(content)) continue;
          search(`.opscrew/plans/${file}`, content);
        }
        // The Cloudflare plans are in the CLI outputs; the steps that serve the first app through
        // the tunnel (2, 7) always show one.
        problems.push(
          ...run.sharedPlanLeaks(
            known,
            ["2", "7"].some((id) => SELECTED.includes(id)),
          ),
        );
        for (const label of requiredLeakLabels(SELECTED, repoPrivate)) {
          if (!known.some((entry) => entry.label === label))
            run.findings.push(`the leak search had no value for ${label}`);
        }
        log(
          `the leak search covered the commits, outputs, files and audit log of steps ${SELECTED.join(", ")}`,
        );
        for (const observation of observations) log(`run log: ${observation}`);
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    run.registerCleanup({
      first: closeTunnel,
      // Every zone ruleset must have the rules it had before the run, once the cleanup removed the
      // seeded rules (never restored here).
      cloudflare: (attempt) =>
        attempt("compare the zone's rulesets", () =>
          changedRulesets(run.cloudflare, run.zone as CloudflareZone, rulesetsBefore),
        ),
    });
  },
);
