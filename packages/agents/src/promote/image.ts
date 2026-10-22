import type { RegistryCredential } from "@opscrew/connector-github";
import { OpsCrewError, upperFirst } from "@opscrew/core";
import { environmentTag } from "@opscrew/iac-templates";
import type { PromoteGitHubApi } from "./types";

/** The app's image on GHCR: `ghcr.io/<owner>/<repo>`, read with `credential` when given. */
export interface AppImage {
  github: PromoteGitHubApi;
  owner: string;
  repo: string;
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

/** `ghcr.io/<owner>/<repo>@<digest>`, as GHCR names it (lower case). */
export function imageReference(image: Pick<AppImage, "owner" | "repo">, digest: string): string {
  return `ghcr.io/${image.owner}/${image.repo}@${digest}`.toLowerCase();
}

function digestOfTag(image: AppImage, tag: string): Promise<string | undefined> {
  return image.github.taggedDigest(image.owner, image.repo, tag, image.credential);
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
 * Step 2: the image's SLSA v1 provenance names its build run (`runDetails.builder.id`), which must
 * be this repository's; GitHub's record of the run must show a `push` of this repository's own
 * commits (a fork's pull request runs here too) to the default branch; and the image tagged with
 * the run's commit must be this digest. Each environment that builds tags its own form of the
 * commit ({@link environmentTag}), and the one that built the image may be the source's own
 * source, so the tag is looked up in the forms of the app's `environments`, in their order. A
 * builder id that is no run URL is never printed.
 * @throws OpsCrewError `PHASE_PRECONDITION` saying which check failed.
 */
export async function checkProvenance(
  image: AppImage,
  digest: string,
  defaultBranch: string,
  environments: readonly string[],
): Promise<ImageBuild> {
  const repository = `${image.owner}/${image.repo}`;
  const reference = imageReference(image, digest);
  const refuse = (why: string) =>
    new OpsCrewError("PHASE_PRECONDITION", `${why} ${nothing}`, {
      hint: `OpsCrew promotes only images ${repository}'s deploy workflow built from ${defaultBranch}. Promote the image another environment runs, built by a push to ${defaultBranch}.`,
    });
  const provenance = await image.github.imageProvenance(
    image.owner,
    image.repo,
    digest,
    image.credential,
  );
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
    throw refuse(`The image was built by a ${run.event} run, not by a push to ${defaultBranch}.`);
  }
  if (run.headRepository.toLowerCase() !== repository.toLowerCase()) {
    throw refuse(
      `The image was built from the commits of ${run.headRepository}, not of ${repository}.`,
    );
  }
  if (run.headBranch !== defaultBranch) {
    throw refuse(
      `The image was built from the branch ${run.headBranch}, not from the default branch ${defaultBranch}.`,
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
