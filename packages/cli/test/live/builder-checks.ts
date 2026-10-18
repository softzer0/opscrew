/**
 * The builder checks of the Hetzner pass (feature 012, docs/e2e.md "The builders"), for the three
 * builder examples: the builder the deploy used, a non-root container, the image's provenance and
 * SBOM (with the leak search), a merged change deployed under a steady load, a release whose health
 * route fails, GHCR keeping the layers after the image retention job, and optionally the cosign
 * signatures. Nothing here prints a secret or a log; messages name labels, images and statuses.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv, readServerAddresses } from "@opscrew/agents";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type ImageBuilder, readArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { type GitHubRepo, ghcrMissingBlobs, minutes } from "./cloud";
import { jobErrors, jobLog, runSteps } from "./portainer-cloud";
import { deployedImage } from "./portainer-support";
import {
  applyEdit,
  BUILD_JOB,
  deployJobFailed,
  EXPECTED_BUILDERS,
  HEALTH_BREAKS,
  jsonStrings,
  type LoadFailure,
  leakedLabels,
  missingBuildSteps,
  provenanceProblems,
  Scrubber,
  type SourceEdit,
  sbomPackages,
  steadyLoad,
} from "./support";

/** The deploy workflow's jobs the checks read (their names in the workflow). */
const DEPLOY_JOB = "Deploy to the server";
const PRUNE_JOB = "Delete old images";

/** Requests per second the load sends to the health route. */
const LOAD_RPS = 20;

/** The file the merged change adds, so that the deploy builds a new image. */
const CHANGE_FILE = "opscrew-e2e-change.txt";

/** What T1205 asked to confirm live that this pass cannot, logged on every run. */
const NOT_COVERED = [
  "image retention on a package owned by an organization (the /orgs endpoints): the throwaway repository is owned by a user",
  "kamal-proxy's --target-timeout 300s letting a 60-second request through: no example has a slow route",
  "Railpack with a secret build value that is empty at prepare: no example has a secret build value",
];

const runner = new NodeCommandRunner();

/** What the builder checks need from their variables. */
export interface BuilderSettings {
  app: string;
  builder: ImageBuilder;
  /** `OPSCREW_E2E_GHCR_READ_TOKEN`: reads the image's attestations and blobs. */
  ghcrToken: string;
  /** `OPSCREW_E2E_SIGN=1`: the deploy signs the image, and the signatures are verified. */
  sign: boolean;
}

/**
 * The settings for `app` (an example name, `undefined` for a GitHub repository) with
 * `OPSCREW_E2E_BUILDS=1`; otherwise the one line the pass logs to say why the checks do not run.
 */
export function builderSettings(
  app: string | undefined,
  env: Record<string, string | undefined>,
): BuilderSettings | string {
  if (env.OPSCREW_E2E_BUILDS !== "1") {
    return "not checked: the builder checks of feature 012 (set OPSCREW_E2E_BUILDS=1, see docs/e2e.md)";
  }
  const builder = app === undefined ? undefined : EXPECTED_BUILDERS[app];
  if (app === undefined || builder === undefined) {
    return `not checked: OPSCREW_E2E_BUILDS=1 checks only ${Object.keys(EXPECTED_BUILDERS).join(", ")}`;
  }
  return {
    app,
    builder,
    ghcrToken: env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "",
    sign: env.OPSCREW_E2E_SIGN === "1",
  };
}

/**
 * Stops before any GitHub or cloud call when a check could not run: the GHCR read token, Docker
 * with Buildx (`docker buildx imagetools`) and, with signing, cosign.
 */
export async function builderPreflight(settings: BuilderSettings): Promise<void> {
  if (settings.ghcrToken === "") {
    throw new Error(
      `The builder checks of examples/${settings.app} read the image's SBOM and provenance with OPSCREW_E2E_GHCR_READ_TOKEN, a classic token with only read:packages (docs/e2e.md); set it.`,
    );
  }
  const missing = (what: string, command: string) =>
    new Error(
      `The builder checks need ${what} on this computer (\`${command}\` failed); install it, or run another app.`,
    );
  // With an empty Docker configuration, as the checks run it (registryLogin): Buildx must be
  // found without the user's own configuration.
  const dir = await mkdtemp(join(tmpdir(), "opscrew-e2e-docker-"));
  try {
    const buildx = await runner
      .run("docker", ["buildx", "version"], {
        env: { ...process.env, DOCKER_CONFIG: dir },
        timeoutMs: 60_000,
      })
      .catch(() => ({ exitCode: -1 }));
    if (buildx.exitCode !== 0) throw missing("Docker with Buildx", "docker buildx version");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (settings.sign) {
    const cosign = await runner
      .run("cosign", ["version"], { timeoutMs: 60_000 })
      .catch(() => ({ exitCode: -1 }));
    if (cosign.exitCode !== 0) throw missing("cosign", "cosign version");
  }
}

/** What the checks need from the deployed run of `live.test.ts`. */
export interface BuilderRun {
  repo: string;
  env: Record<string, string | undefined>;
  github: GitHubRepo;
  /** The first deploy's workflow run and the commit it built. */
  deployed: { runId: number; sha: string };
  /** SSH as `deploy` with the project's deploy key and OpsCrew's known_hosts. */
  ssh: (host: string, command: string) => Promise<string>;
  /**
   * Commits `files` on `branch`, opens a pull request, merges it and checks `main` out again;
   * returns the merge commit.
   */
  mergeFiles: (branch: string, message: string, files: readonly string[]) => Promise<string>;
}

/** A Docker configuration of its own holding only the GHCR login, for `docker` and `cosign`. */
async function registryLogin(user: string, token: string) {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-e2e-docker-"));
  // Written directly: `docker login` would store the token in the computer's credential store
  // when the configuration names none.
  const auth = Buffer.from(`${user}:${token}`).toString("base64");
  await writeFile(join(dir, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth } } }));
  const env = { ...process.env, DOCKER_CONFIG: dir };
  const run = async (command: string, args: string[], what: string) => {
    const result = await runner.run(command, args, { env, timeoutMs: minutes(5) });
    if (result.exitCode !== 0) {
      throw new Error(
        `${what} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-500)}`,
      );
    }
    return result.stdout;
  };
  return {
    /** The guide's command: `docker buildx imagetools inspect <image> --format '{{json .<field>}}'`. */
    async inspect(image: string, field: "Provenance" | "SBOM"): Promise<unknown> {
      const format = `{{json .${field}}}`;
      return JSON.parse(
        await run(
          "docker",
          ["buildx", "imagetools", "inspect", image, "--format", format],
          `docker buildx imagetools inspect ${image} --format '${format}'`,
        ),
      );
    },
    /** The guide's `cosign verify` for the deploy workflow's identity. */
    async verifySignature(image: string, identity: string): Promise<void> {
      await run(
        "cosign",
        [
          "verify",
          image,
          "--certificate-identity",
          identity,
          "--certificate-oidc-issuer",
          "https://token.actions.githubusercontent.com",
        ],
        `cosign verify ${image}`,
      );
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Every secret value the attestations must not hold: `tokens`, the deploy key, the state
 * passphrase, the values OpsCrew generated for the app and the `OPSCREW_E2E_APP_ENV` values of 8
 * characters or more.
 */
async function knownSecrets(
  run: BuilderRun,
  tokens: readonly { label: string; value: string | undefined }[],
): Promise<{ label: string; value: string }[]> {
  const scrubber = new Scrubber();
  for (const { label, value } of tokens) scrubber.add(value, label);
  const paths = resolveProjectPaths(run.repo, { env: run.env });
  for (const [file, label] of [
    [paths.files.deployKey, "deploy-key"],
    [paths.files.statePassphrase, "state-passphrase"],
  ] as const) {
    if (existsSync(file)) scrubber.add(await readFile(file, "utf8"), label);
  }
  const generated = join(paths.projectHomeDir, "generated_values.json");
  if (existsSync(generated)) {
    for (const value of jsonStrings(JSON.parse(await readFile(generated, "utf8")))) {
      scrubber.add(value, "generated-value");
    }
  }
  const appEnv = run.env.OPSCREW_APP_ENV_FILE;
  if (appEnv !== undefined && existsSync(appEnv)) {
    for (const value of parseDotenv(await readFile(appEnv, "utf8")).values()) {
      if (value.length >= 8) scrubber.add(value, "app-env-value");
    }
  }
  return scrubber.entries();
}

/**
 * Runs `body` (a deploy) under a steady load on `url`, logs every failed request with the time it
 * was sent, and fails when any request failed.
 */
async function underLoad<T>(
  url: string,
  what: string,
  log: (message: string) => void,
  body: () => Promise<T>,
): Promise<T> {
  log(`${what}: sending ${LOAD_RPS} requests per second to the health route until its deploy ends`);
  const startedAt = Date.now();
  const load = steadyLoad(
    async () => {
      const answer = await fetch(url, {
        headers: { "User-Agent": "opscrew-e2e" },
        signal: AbortSignal.timeout(10_000),
      });
      await answer.arrayBuffer();
      return answer.status;
    },
    LOAD_RPS,
    (failure) => log(`${what}: the request sent at ${failure.at} failed: ${failure.what}`),
  );
  let summary: { sent: number; failures: LoadFailure[] } = { sent: 0, failures: [] };
  let seconds = 0;
  let result: T;
  try {
    result = await body();
  } finally {
    seconds = (Date.now() - startedAt) / 1000;
    summary = await load.stop();
  }
  log(
    `${what}: ${summary.sent} requests in ${Math.round(seconds)} s, ${summary.failures.length} failed`,
  );
  expect(summary.failures, `requests that failed during ${what}`).toEqual([]);
  // A computer too busy to keep the rate would test less than the documented load.
  expect(
    summary.sent,
    `requests sent in ${Math.round(seconds)} s (at least 90% of ${LOAD_RPS} per second)`,
  ).toBeGreaterThanOrEqual(0.9 * LOAD_RPS * seconds);
  return result;
}

/**
 * The checks after the first deploy (docs/e2e.md "The builders"), in order: the builder, a
 * non-root container, the attestations and the leak search, a change under load, a broken release
 * under load and its restore, the blobs after the image retention job, and the signatures.
 */
export async function builderChecks(
  run: BuilderRun,
  settings: BuilderSettings,
  tokens: readonly { label: string; value: string | undefined }[],
): Promise<void> {
  const log = (message: string) => console.log(`OpsCrew E2E (${settings.app}): ${message}`);
  const { builder } = settings;
  const plan = await readArtifact("plan", join(run.repo, "opscrew/plan.yaml"));

  // The builder: the plan's, and the build job's steps (and, for Buildpacks, the pinned refs).
  expect(plan.app.build?.builder, "app.build.builder in opscrew/plan.yaml").toBe(builder);
  expect(plan.deploy.strategy, "deploy.strategy (the switch without downtime)").toBe("rolling");
  expect(plan.supplyChain.sign, "supplyChain.sign (OPSCREW_E2E_SIGN)").toBe(settings.sign);
  expect(
    missingBuildSteps(await runSteps(run.github, run.deployed.runId), builder),
    `the ${builder} steps of the build job`,
  ).toEqual([]);
  if (builder === "buildpacks") {
    const buildLog = await jobLog(run.github, run.deployed.runId, BUILD_JOB);
    for (const pin of [IMAGES.paketoBuilder.ref, IMAGES.paketoRun.ref]) {
      expect(buildLog.includes(pin), `pack ran with the pinned ${pin}`).toBe(true);
    }
  }
  log(`the deploy built the image with ${builder}`);

  const paths = resolveProjectPaths(run.repo, { env: run.env });
  const ipv4 = (await readServerAddresses(paths)).deployment?.ipv4 as string;
  const runningImage = async () => {
    const image = deployedImage(await run.ssh(ipv4, "cat /srv/app/.env"));
    expect(image, "the server's /srv/app/.env names a GHCR image digest").toBeDefined();
    return `${image?.repository}@sha256:${image?.digest}`;
  };
  const first = await runningImage();

  // Non-root: every running app container's user.
  const uids = (
    await run.ssh(
      ipv4,
      'cd /srv/app && for id in $(docker compose ps -q app); do docker exec "$id" id -u; done',
    )
  )
    .split(/\s+/)
    .filter(Boolean);
  expect(uids.length, "running app containers").toBeGreaterThan(0);
  expect(
    uids.filter((uid) => uid === "0"),
    "app containers running as root",
  ).toEqual([]);
  log(`the app container runs as uid ${uids.join(", ")}`);

  const owner = run.github.name.split("/")[0] as string;
  const registry = await registryLogin(owner, settings.ghcrToken);
  try {
    // The attestations, read with the guide's command, and the leak search over them.
    const provenance = await registry.inspect(first, "Provenance");
    const sbom = await registry.inspect(first, "SBOM");
    expect(
      provenanceProblems(provenance, { repository: run.github.name, commit: run.deployed.sha }),
      "the provenance",
    ).toEqual([]);
    const packages = sbomPackages(sbom);
    expect(packages, "packages the SBOM lists").toBeGreaterThan(0);
    log(
      `the provenance names the repository and the commit and holds no event data; the SBOM lists ${packages} packages`,
    );
    const known = await knownSecrets(run, [
      ...tokens,
      { label: "OPSCREW_E2E_GHCR_READ_TOKEN", value: settings.ghcrToken },
    ]);
    expect(
      leakedLabels(`${JSON.stringify(provenance)}\n${JSON.stringify(sbom)}`, known),
      "secrets in the provenance or the SBOM",
    ).toEqual([]);
    log(`none of the ${known.length} known secret values is in the provenance or the SBOM`);

    // A merged change deploys under a steady load.
    const health = new URL(plan.app.healthPath, plan.deployment.url ?? `http://${ipv4}`).toString();
    await writeFile(
      join(run.repo, CHANGE_FILE),
      `Deployed under load (${new Date().toISOString()}).\n`,
    );
    const changed = await underLoad(health, "a merged change", log, async () =>
      run.github.waitForDeploy({
        headSha: await run.mergeFiles("e2e/change", "e2e: a change deployed under load", [
          CHANGE_FILE,
        ]),
      }),
    );
    expect(changed.conclusion, "the deploy run of the change").toBe("success");
    const second = await runningImage();
    expect(second, "the change deployed a new image").not.toBe(first);

    // A release whose health route fails: no request fails, the run fails with the builder hint,
    // and the previous version still answers. Then the route is restored.
    const edit = HEALTH_BREAKS[settings.app] as SourceEdit;
    const file = join(run.repo, edit.file);
    const original = await readFile(file, "utf8");
    await writeFile(file, applyEdit(original, edit));
    const broken = await underLoad(health, "a broken release", log, async () =>
      run.github.waitForDeploy({
        headSha: await run.mergeFiles("e2e/broken", "e2e: a release whose health route fails", [
          edit.file,
        ]),
      }),
    );
    expect(broken.conclusion, "the deploy run of the broken release").toBe("failure");
    const errors = await jobErrors(run.github, broken.id, DEPLOY_JOB);
    expect(
      errors.some(
        (message) =>
          message.includes("did not pass its health check") &&
          message.includes(`app.build.builder: ${builder}`),
      ),
      `an error of the deploy job names the builder:\n${errors.join("\n")}`,
    ).toBe(true);
    expect(await runningImage(), "the server still runs the previous version").toBe(second);
    const answer = await fetch(health, { signal: AbortSignal.timeout(15_000) });
    await answer.arrayBuffer();
    expect(answer.status, `GET ${plan.app.healthPath} after the broken release`).toBe(200);
    log("the broken release failed with the builder hint, and the previous version still answers");

    await writeFile(file, original);
    const restored = await run.github.waitForDeploy({
      headSha: await run.mergeFiles("e2e/restore", "e2e: restore the health route", [edit.file]),
    });
    expect(restored.conclusion, "the deploy run of the restored health route").toBe("success");
    const final = await runningImage();

    // After the image retention job, GHCR still has every blob of the first and the running image
    // (Buildpacks and Railpack: their build-<commit> images, which share the layers, are deleted).
    const prune = restored.jobs.find((job) => job.name === PRUNE_JOB);
    expect(
      prune !== undefined && !deployJobFailed(prune, restored.conclusion),
      `the "${PRUNE_JOB}" job of the last deploy succeeded`,
    ).toBe(true);
    for (const image of [first, final]) {
      expect(
        await ghcrMissingBlobs(image, owner, settings.ghcrToken),
        `blobs of ${image} that GHCR no longer has`,
      ).toEqual([]);
    }
    log(
      "after the image retention job GHCR still has every blob of the first and the running image",
    );

    if (settings.sign) {
      // The certificate names the repository as GitHub spells it, which the variable may not.
      const repository = await run.github.call("GET", `/repos/${run.github.name}`);
      const fullName = (repository.json as { full_name?: string } | undefined)?.full_name;
      if (repository.status !== 200 || fullName === undefined) {
        throw new Error(`GitHub did not show ${run.github.name} (HTTP ${repository.status}).`);
      }
      const identity = `https://github.com/${fullName}/${plan.cicd.workflowPath}@refs/heads/${plan.cicd.branch}`;
      for (const image of [first, final]) await registry.verifySignature(image, identity);
      log("cosign verifies the signatures of the first and the running image after the prunes");
    } else {
      log("not checked: image signing, which is opt-in (OPSCREW_E2E_SIGN=1, see docs/e2e.md)");
    }
    for (const note of NOT_COVERED) log(`not checked: ${note}`);
  } finally {
    await registry.dispose();
  }
}
