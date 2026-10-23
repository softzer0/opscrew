/**
 * The localhost target's image (data-model.md "Localhost target", `image`): the image another
 * environment runs, from GHCR by digest, byte-identical, when it is built for this computer's
 * CPU; otherwise built on this computer for apps built from a Dockerfile, or the other
 * environment's image under emulation.
 */
import { join } from "node:path";
import { resolveGitHubToken } from "@opscrew/connector-github";
import { exists, OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import {
  type DeployPlan,
  type ImageBuilder,
  readOptionalArtifact,
  targetArch,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";
import { REGISTRY_TOKEN_VAR } from "../provision/portainer";
import { githubClientFromToken, githubCoordinates, requireGitRepo } from "../shared";
import { runningImage } from "./plan";
import { appFolder } from "./services";

/** The app's image on GHCR, as the local deploy reads and pulls it. */
export interface LocalRegistry {
  /** `ghcr.io/<owner>/<repo>`, lower case. */
  image: string;
  /** The digest GHCR has for the app image's `tag`, or `undefined` when it has none. */
  taggedDigest(tag: string): Promise<string | undefined>;
  /** The login this computer's Docker pulls a private image with (registered with the redactor). */
  login(): Promise<{ username: string; token: string }>;
}

/** The image the local deploy runs. */
export type LocalImage =
  | {
      source: "registry";
      /** `ghcr.io/<owner>/<repo>@sha256:…`. */
      ref: string;
      /** The environment whose running image it is (its `opscrew-<env>` label). */
      environment: string;
      /** True when it is built for another CPU, so Docker emulates it. */
      emulated: boolean;
    }
  | {
      source: "local-build";
      /** The Dockerfile and the build context, relative to the repository. */
      dockerfile: string;
      context: string;
    };

/**
 * True when the plan's environment builds its own image though it runs on this computer
 * (FR-1540): it follows a branch and its deploy job runs on the local runner, so its workflow
 * builds the image on GitHub and the runner deploys it.
 */
function buildsOwnImage(plan: Pick<DeployPlan, "environment">): boolean {
  const { environment } = plan;
  return environment?.runner === "local" && environment.deploySource.from === "main";
}

/** The environment another one takes its image from: its name, its CPU and its plan. */
export interface ImageSource {
  environment: string;
  arch: "amd64" | "arm64";
  plan: DeployPlan;
}

/**
 * `environment`, the CPU its images are built for and its plan; `undefined` when it has no plan
 * yet or runs on this computer too.
 */
async function builtElsewhere(
  paths: ProjectPaths,
  environment: string,
): Promise<ImageSource | undefined> {
  const plan = await readOptionalArtifact("plan", environmentPaths(paths, environment).files.plan);
  if (plan === undefined || plan.target.provider === "localhost") return undefined;
  return { environment, arch: targetArch(plan.target), plan };
}

/**
 * The environment whose image this one runs (the source it is promoted from, else prod), the CPU
 * its images are built for and its plan; `undefined` when that is this environment itself (prod,
 * or one on the local runner that follows a branch: its own workflow builds its image), or one
 * that runs on this computer too: then no build elsewhere gives this computer an image.
 */
export async function imageSource(
  paths: ProjectPaths,
  plan: Pick<DeployPlan, "environment">,
): Promise<ImageSource | undefined> {
  if (buildsOwnImage(plan)) return undefined;
  const from = plan.environment?.deploySource;
  const environment = from?.from === "promote" ? from.source : "prod";
  if (environment === paths.environment) return undefined;
  return builtElsewhere(paths, environment);
}

/**
 * True when this computer can build the app's image as GitHub Actions does: from OpsCrew's
 * Dockerfile, or the user's own one when the build adds nothing to it (no cron job, no SQLite).
 */
export function buildsLocally(app: {
  builder: ImageBuilder | undefined;
  cron: boolean;
  sqlite: boolean;
}): boolean {
  if (app.builder === undefined || app.builder === "generated-dockerfile") return true;
  return app.builder === "own-dockerfile" && !app.cron && !app.sqlite;
}

/** {@link buildsLocally} for a plan. */
export function planBuildsLocally(plan: DeployPlan): boolean {
  return buildsLocally({
    builder: plan.app.build?.builder,
    cron: plan.processes.cron.some((job) => job.enabled),
    sqlite: plan.storage?.sqlite !== undefined,
  });
}

/** The Dockerfile and context of a local build, relative to the repository. */
export function localBuild(plan: DeployPlan): { dockerfile: string; context: string } {
  const context = plan.app.buildContext || ".";
  return {
    dockerfile: join(context, plan.app.dockerfile || "Dockerfile").replaceAll("\\", "/"),
    context,
  };
}

/**
 * `OPSCREW_GHCR_READ_TOKEN` as GHCR's login for `owner`'s images, registered with the redactor;
 * `undefined` when it is not set.
 */
export function ghcrReadCredential(
  deps: Pick<PhaseDeps, "env" | "redactor">,
  owner: string,
): { username: string; token: string } | undefined {
  const token = deps.env[REGISTRY_TOKEN_VAR]?.trim();
  if (!token) return undefined;
  deps.redactor.addLiteral(token, REGISTRY_TOKEN_VAR);
  return { username: owner, token };
}

/**
 * The app's image on GHCR through the GitHub connector: read and pulled with
 * `OPSCREW_GHCR_READ_TOKEN` when it is set (a classic `read:packages` token, which GHCR accepts
 * where it may refuse a fine-grained one, as `opscrew promote` reads it), else with the user's
 * GitHub token. Both are registered with the redactor.
 */
export async function githubRegistry(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "fetch" | "version">,
): Promise<LocalRegistry> {
  const { owner, repo } = await githubCoordinates(await requireGitRepo(deps));
  const client = await githubClientFromToken(deps);
  if (client === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew reads the app's image from GitHub Container Registry with your GitHub token, and none is set.",
      {
        hint: "Set GITHUB_TOKEN (or log in with `gh auth login`), or set target.image to local-build in the plan to build the image on this computer, then run the command again.",
      },
    );
  }
  const credential = ghcrReadCredential(deps, owner);
  return {
    image: `ghcr.io/${owner}/${repo}`.toLowerCase(),
    taggedDigest: (tag) => client.taggedDigest(owner, repo, tag, credential),
    login: async () =>
      credential ?? {
        username: await client.whoAmI(),
        token: (await resolveGitHubToken(deps.env, deps.runner)) as string,
      },
  };
}

/**
 * Said when this computer (`arch`) runs `whose` image (`prod's`, `the staging environment's`),
 * built for another CPU (`built`), under emulation.
 */
export function emulationNote(
  arch: string | undefined,
  whose: string,
  built: "amd64" | "arm64",
): string {
  return `This computer runs ${arch} and ${whose} image is built for ${built}, so Docker runs it under emulation, which is slower.`;
}

/**
 * The image an environment that builds its own image ({@link buildsOwnImage}) starts from before
 * its first labelled image, said with what replaces it: the GHCR image it already runs (a deploy
 * whose labelling failed), else a local build when this computer builds the app's image as GitHub
 * Actions does and its Dockerfile is in the repository, else the image prod runs (`opscrew-prod`),
 * with the emulation note when that is built for another CPU; `undefined` for prod, which has no
 * other image.
 * @throws OpsCrewError `PHASE_PRECONDITION` when there is neither.
 */
async function firstImage(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
  plan: DeployPlan,
  ghcr: LocalRegistry,
  arch: "amd64" | "arm64" | undefined,
): Promise<LocalImage | undefined> {
  const name = deps.paths.environment;
  const none = `${name} has no image of its own on GitHub Container Registry yet (opscrew-${name})`;
  const replaced = `The first deploy after a push to ${plan.cicd.branch} replaces it with ${name}'s own image, which its workflow builds.`;
  // A deploy whose labelling failed left its image running: keep it rather than build another.
  const running = await runningImage(appFolder(deps.paths, plan));
  if (running?.startsWith(`${ghcr.image}@sha256:`)) {
    deps.reporter.info(
      `${none}, so OpsCrew keeps ${running}, the image an earlier deploy pulled from there and this computer still runs. ${replaced}`,
    );
    return { source: "registry", ref: running, environment: name, emulated: false };
  }
  const build = localBuild(plan);
  const builds = planBuildsLocally(plan);
  const dockerfile = builds && (await exists(join(deps.paths.root, build.dockerfile)));
  if (dockerfile) {
    deps.reporter.info(
      `${none}, so OpsCrew starts it from an image built on this computer from ${build.dockerfile}. ${replaced}`,
    );
    return { source: "local-build", ...build };
  }
  if (name === "prod") return undefined;
  const digest = await ghcr.taggedDigest("opscrew-prod");
  if (digest === undefined) {
    const cannot = builds
      ? `${build.dockerfile} is not in the repository yet`
      : "this computer cannot build the app's image as GitHub Actions does (its builder adds to it there)";
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${none}: its workflow builds one on each push to ${plan.cicd.branch} once provision has set it up. Until then OpsCrew starts it from an image built on this computer or from the image prod runs, but ${cannot}, and GitHub Container Registry has no image labelled opscrew-prod yet. Nothing was changed.`,
      {
        hint: builds
          ? "Run `opscrew adapt`, merge its pull request and pull it, or deploy prod first, then run the command again."
          : "Deploy prod first, then run the command again.",
      },
    );
  }
  const prod = await builtElsewhere(deps.paths, "prod");
  const emulated = prod !== undefined && prod.arch !== arch;
  deps.reporter.info(
    `${none}, so OpsCrew starts it from the image prod runs (opscrew-prod). ${replaced}`,
  );
  if (emulated) deps.reporter.info(emulationNote(arch, "prod's", prod.arch));
  return { source: "registry", ref: `${ghcr.image}@${digest}`, environment: "prod", emulated };
}

/**
 * The image the plan runs on this computer: `local-build`, built at the deploy; `registry`, the
 * digest GHCR has for the `opscrew-<env>` label of the environment whose image this one runs (or
 * this one's own when it is the source), emulated when that is built for another CPU. An
 * environment that builds its own image starts from {@link firstImage} until GHCR has its own.
 * @throws OpsCrewError `PHASE_PRECONDITION` when GHCR has no such image.
 */
export async function resolveLocalImage(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
  plan: DeployPlan,
  registry: () => Promise<LocalRegistry>,
): Promise<LocalImage> {
  if (plan.target.provider === "localhost" && plan.target.image === "local-build") {
    return { source: "local-build", ...localBuild(plan) };
  }
  const source = await imageSource(deps.paths, plan);
  const environment = source?.environment ?? deps.paths.environment;
  const label = `opscrew-${environment}`;
  const ghcr = await registry();
  const digest = await ghcr.taggedDigest(label);
  const arch = plan.target.provider === "localhost" ? plan.target.arch : undefined;
  if (digest === undefined && buildsOwnImage(plan)) {
    const first = await firstImage(deps, plan, ghcr, arch);
    if (first !== undefined) return first;
  }
  if (digest === undefined) {
    const file = toPosixRelative(deps.paths.root, deps.paths.files.plan);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Container Registry has no image labelled ${label} yet: OpsCrew labels the image an environment runs after each healthy deploy, and ${environment} has not deployed one since. Nothing was changed.`,
      {
        // The local runner refuses local-build: it deploys the image GitHub Actions built.
        hint:
          planBuildsLocally(plan) && !buildsOwnImage(plan)
            ? `Deploy ${environment} first, or set target.image to local-build in ${file} to build the image on this computer, then run the command again.`
            : `Deploy ${environment} first, then run the command again.`,
      },
    );
  }
  return {
    source: "registry",
    ref: `${ghcr.image}@${digest}`,
    environment,
    emulated: source !== undefined && source.arch !== arch,
  };
}
