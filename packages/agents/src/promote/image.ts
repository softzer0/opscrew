import type { ImageFacts, RegistryCredential } from "@opscrew/connector-github";
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { environmentTag } from "@opscrew/iac-templates";
import { ghcrImageFor } from "@opscrew/plan-schema";
import { ghcrPackage } from "../shared/github";
import type { PromoteGitHubApi } from "./types";

/**
 * The app's image on GHCR: `ghcr.io/<owner>/<repo>`, a further app's `ghcr.io/<owner>/<repo>/<key>`
 * (plan-schema's `ghcrImageFor`), read with `credential` when given.
 */
export interface AppImage {
  github: PromoteGitHubApi;
  owner: string;
  /** The GitHub repository's name. */
  repo: string;
  /** A further app's key (`plan.app.key`); absent for the repository's first app. */
  key?: string | undefined;
  credential?: RegistryCredential;
}

/** The image a promotion deploys. */
export interface ChosenImage {
  digest: string;
  /** True when it is the target's previous image (`opscrew-<target>-previous`). */
  rollback: boolean;
}

/** Where the image was built, from its provenance and GitHub's record of the run. */
export interface ImageBuild {
  /** The build run's URL, as the provenance names it. */
  runUrl: string;
  branch: string;
  commit: string;
  /** The image's commit tag: `commit`, or `<commit>-<env>` when another environment than prod built it. */
  tag: string;
}

/** `ghcr.io/<owner>/<repo>[/<key>]@<digest>`, as GHCR names it (lower case). */
export function imageReference(
  image: Pick<AppImage, "owner" | "repo" | "key">,
  digest: string,
): string {
  return `${ghcrImageFor(`${image.owner}/${image.repo}`, image.key)}@${digest}`.toLowerCase();
}

function digestOfTag(image: AppImage, tag: string): Promise<string | undefined> {
  const { github, owner, repo, key, credential } = image;
  return github.taggedDigest(owner, ghcrPackage(repo, key), tag, credential);
}

/** What GHCR shows of the app's image `digest`: its provenance and platforms (`imageFacts`). */
export function imageFactsOf(image: AppImage, digest: string): Promise<ImageFacts | undefined> {
  const { github, owner, repo, key, credential } = image;
  return github.imageFacts(owner, ghcrPackage(repo, key), digest, credential);
}

const nothing = "Nothing was deployed.";

/**
 * Step 1: the image to deploy. Without `requested`, the image the source runs (its
 * `opscrew-<source>` label); a requested digest must be that image, or the target's previous one
 * (`opscrew-<target>-previous`) for a rollback.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the source runs no image (`sourceDeployed` false,
 * or no label) and none was requested, or the requested digest is neither image.
 */
export async function chooseImage(
  image: AppImage,
  input: { source: string; target: string; sourceDeployed: boolean; requested?: string },
): Promise<ChosenImage> {
  const { source, target, requested } = input;
  const label = `opscrew-${source}`;
  const again = `then run \`opscrew promote --to ${target}\` again`;
  const running = input.sourceDeployed ? await digestOfTag(image, label) : undefined;
  if (requested === undefined) {
    if (!input.sourceDeployed) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The ${source} environment is not deployed, so it runs no image to promote to ${target}. ${nothing}`,
        { hint: `Deploy ${source} first (\`opscrew provision --env ${source}\`), ${again}.` },
      );
    }
    if (running === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GitHub Container Registry has no image labelled ${label}, so the ${source} environment runs no image OpsCrew can promote yet. ${nothing}`,
        {
          hint: `${source}'s deploy workflow labels its image after a healthy deploy: let a deploy of ${source} finish, ${again}.`,
        },
      );
    }
    return { digest: running, rollback: false };
  }
  if (requested === running) return { digest: requested, rollback: false };
  const previousLabel = `opscrew-${target}-previous`;
  const previous = await digestOfTag(image, previousLabel);
  if (requested === previous) return { digest: requested, rollback: true };
  const choices = [
    ...(running !== undefined
      ? [
          `run \`opscrew promote --to ${target}\` without --digest to deploy the image ${source} runs`,
        ]
      : []),
    ...(previous !== undefined
      ? [`run \`opscrew promote --to ${target} --digest ${previous}\` to roll ${target} back`]
      : []),
  ];
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${requested} is neither the image ${source} runs (${label}: ${running ?? "none"}) nor ${target}'s previous image (${previousLabel}: ${previous ?? "none"}), so OpsCrew will not deploy it. ${nothing}`,
    {
      hint:
        choices.length > 0
          ? `${upperFirst(choices.join(", or "))}.`
          : `Let a deploy of ${source} finish, ${again}.`,
    },
  );
}

/**
 * The image is built for the target's CPU (`arch`, from `targetArch`): its manifest, or one image
 * of its index, names that architecture (`platforms`, as GHCR shows them). Platforms GHCR does not
 * name stop the promotion too, so an image of unknown CPU is never deployed.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming both CPUs and how to build for the target's.
 */
export function checkPlatform(
  image: AppImage,
  digest: string,
  platforms: ImageFacts["platforms"],
  target: string,
  arch: "amd64" | "arm64",
): void {
  const reference = imageReference(image, digest);
  const again = `then run \`opscrew promote --to ${target}\` again`;
  if (platforms === undefined || platforms.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Container Registry names no CPU for the image ${reference}, so OpsCrew cannot tell whether it runs on ${target}'s ${arch}. ${nothing}`,
      { hint: `Promote an image OpsCrew's deploy workflow pushed, which names its CPU, ${again}.` },
    );
  }
  const built = [...new Set(platforms.map((platform) => platform.architecture))];
  if (built.includes(arch)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The image ${reference} is built for ${listText(built)} only, but ${target} runs on ${arch}, so it would not start there. ${nothing}`,
    {
      hint: `Build the image for ${arch}: let it be built by a source environment on an ${arch} server, or by the GitHub-hosted build, ${again}.`,
    },
  );
}

/**
 * Step 2: the image's SLSA v1 provenance (`provenance`, as GHCR shows it) names its build run
 * (`runDetails.builder.id`), which must
 * be this repository's; GitHub's record of the run must show a `push` of this repository's own
 * commits (a fork's pull request runs here too) to `branch`, the branch that builds the images the
 * target is promoted with (`builderBranch`, as its workflow's verify job checks); and the image
 * tagged with the run's commit must be this digest. Each environment that builds tags its own form
 * of the commit ({@link environmentTag}), and the one that built the image may be the source's
 * own source, so the tag is looked up in the forms of the app's `environments`, in their order. A
 * builder id that is no run URL is never printed.
 * @throws OpsCrewError `PHASE_PRECONDITION` saying which check failed.
 */
export async function checkProvenance(
  image: AppImage,
  digest: string,
  provenance: ImageFacts["provenance"],
  branch: string,
  environments: readonly string[],
): Promise<ImageBuild> {
  const repository = `${image.owner}/${image.repo}`;
  const reference = imageReference(image, digest);
  const refuse = (why: string) =>
    new OpsCrewError("PHASE_PRECONDITION", `${why} ${nothing}`, {
      hint: `OpsCrew promotes only images ${repository}'s deploy workflow built from ${branch}. Promote the image another environment runs, built by a push to ${branch}.`,
    });
  if (provenance === undefined) {
    throw refuse(
      `The image ${reference} carries no SLSA build provenance, so OpsCrew cannot tell where it was built.`,
    );
  }
  // The connector gives a run and its repository only for a builder id that is a run's URL.
  if (provenance.runId === undefined || provenance.repository === undefined) {
    throw refuse(
      `The image ${reference} was not built by a GitHub Actions run of ${repository}: its provenance names another builder.`,
    );
  }
  if (provenance.repository.toLowerCase() !== repository.toLowerCase()) {
    throw refuse(
      `The image ${reference} was built by ${provenance.builderId}, a run of ${provenance.repository}, not of ${repository}.`,
    );
  }
  const run = await image.github.workflowRun(image.owner, image.repo, provenance.runId);
  if (run === undefined) {
    throw refuse(
      `GitHub shows no run ${provenance.runId} in ${repository}, which the image's provenance names as its build.`,
    );
  }
  if (run.event !== "push") {
    throw refuse(`The image was built by a ${run.event} run, not by a push to ${branch}.`);
  }
  if (run.headRepository.toLowerCase() !== repository.toLowerCase()) {
    throw refuse(
      `The image was built from the commits of ${run.headRepository}, not of ${repository}.`,
    );
  }
  if (run.headBranch !== branch) {
    throw refuse(
      `The image was built from the branch ${run.headBranch}, not from ${branch}, the branch whose pushes build the images this environment is promoted with.`,
    );
  }
  for (const environment of environments) {
    const tag = environmentTag(run.headSha, environment);
    if ((await digestOfTag(image, tag)) === digest) {
      return { runUrl: provenance.builderId, branch: run.headBranch, commit: run.headSha, tag };
    }
  }
  throw refuse(
    `The image is not the one tagged with its build's commit (${run.headSha}, or ${run.headSha}-<environment> for an environment other than prod): a later build of that commit replaced the tag, or the image was pushed another way.`,
  );
}
