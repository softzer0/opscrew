/**
 * The localhost target's image (data-model.md "Localhost target", `image`): the image another
 * environment runs, from GHCR by digest, byte-identical, when it is built for this computer's
 * CPU; otherwise built on this computer for apps built from a Dockerfile, or the other
 * environment's image under emulation.
 */
import { join } from "node:path";
import { resolveGitHubToken } from "@opscrew/connector-github";
import { OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { type DeployPlan, type ImageBuilder, readOptionalArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentPaths } from "../environments/paths";
import { REGISTRY_TOKEN_VAR } from "../provision/portainer";
import { githubClientFromToken, githubCoordinates, requireGitRepo } from "../shared";

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

/** The CPU an environment's images are built for: its server's, or amd64 on a cloud server. */
function buildArch(plan: DeployPlan): "amd64" | "arm64" {
  const { target } = plan;
  return target.provider === "own" || target.provider === "portainer" ? target.arch : "amd64";
}

/**
 * The environment whose image this one runs (the source it is promoted from, else prod) and the
 * CPU its images are built for; `undefined` when that is this environment itself, or one that
 * runs on this computer too: then no build elsewhere gives this computer an image.
 */
export async function imageSource(
  paths: ProjectPaths,
  plan: Pick<DeployPlan, "environment">,
): Promise<{ environment: string; arch: "amd64" | "arm64" } | undefined> {
  const from = plan.environment?.deploySource;
  const environment = from?.from === "promote" ? from.source : "prod";
  if (environment === paths.environment) return undefined;
  const source = await readOptionalArtifact(
    "plan",
    environmentPaths(paths, environment).files.plan,
  );
  if (source === undefined || source.target.provider === "localhost") return undefined;
  return { environment, arch: buildArch(source) };
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
 * The image the plan runs on this computer: `local-build`, built at the deploy; `registry`, the
 * digest GHCR has for the `opscrew-<env>` label of the environment whose image this one runs (or
 * this one's own when it is the source), emulated when that is built for another CPU.
 * @throws OpsCrewError `PHASE_PRECONDITION` when GHCR has no such image.
 */
export async function resolveLocalImage(
  deps: Pick<PhaseDeps, "paths">,
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
  if (digest === undefined) {
    const file = toPosixRelative(deps.paths.root, deps.paths.files.plan);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Container Registry has no image labelled ${label} yet: OpsCrew labels the image an environment runs after each healthy deploy, and ${environment} has not deployed one since. Nothing was changed.`,
      {
        hint: planBuildsLocally(plan)
          ? `Deploy ${environment} first, or set target.image to local-build in ${file} to build the image on this computer, then run the command again.`
          : `Deploy ${environment} first, then run the command again.`,
      },
    );
  }
  const arch = plan.target.provider === "localhost" ? plan.target.arch : undefined;
  return {
    source: "registry",
    ref: `${ghcr.image}@${digest}`,
    environment,
    emulated: source !== undefined && source.arch !== arch,
  };
}
