// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { ACTIONS, TOOLS } from "../pins";
import type { RenderContext } from "../types";
import { buildJob, sealsImage } from "./build";
import { retentionScript } from "./retention";
import {
  block,
  builderBranchOf,
  CHECK_IMAGE,
  DIGEST_REF_PATTERN,
  environmentName,
  GHCR_LOGIN,
  imageJob,
  imageOutput,
  job,
  promoted,
  run,
} from "./shared";

const IMAGE_ENV = "    IMAGE: ${{ needs.build.outputs.image }}";

/** The pinned cosign, from Sigstore's installer action. */
const INSTALL_COSIGN = [
  "- name: Install cosign",
  `  uses: ${ACTIONS.cosignInstaller}`,
  "  with:",
  `    cosign-release: ${TOOLS.cosign.version}`,
];

/** The issuer of the keyless signatures GitHub Actions makes. */
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * `supplyChain.sign`: a keyless cosign signature of the image digest, from the only job that holds
 * `id-token: write` (with `packages: write` to push the signature next to the image).
 */
function signJob(): string[] {
  return job({
    id: "sign",
    name: "Sign the image",
    needs: "build",
    permissions: ["id-token: write", "packages: write"],
    steps: [
      ...INSTALL_COSIGN,
      ...GHCR_LOGIN,
      "- name: Sign the image (keyless, recorded in the public Sigstore log)",
      "  env:",
      IMAGE_ENV,
      ...run(["set -euo pipefail", ...CHECK_IMAGE, 'cosign sign --yes "$IMAGE"']),
    ],
  });
}

/** jq's filter for every `runDetails.builder.id` in the provenance, at any depth (per platform). */
const BUILDER_ID_FILTER = ".. | .runDetails?.builder?.id? // empty";

/**
 * The provenance check of a promoted environment's digest (`$DIGEST`): the image's SLSA provenance
 * (`docker buildx imagetools inspect`) must name exactly one GitHub Actions run, as buildx records
 * it in `runDetails.builder.id`; that run must be this repository's, its API record must show a
 * `push` of this repository's own commits to the branch that builds the environment's images
 * (`$BUILD_BRANCH`: the `cicd.branch` of the first of its sources that follows a branch), and the image
 * with the commit tag `$TAG` must be this digest. `$TAG` is the run's commit, or `<commit>-<env>`
 * ({@link environmentTag} of the environment that built it, which this workflow cannot know: the
 * source may itself be promoted from another). Outputs `image`, `tag` (`<name>:<commit tag>`) and
 * `identity`, the signing identity of the run's workflow on that branch.
 */
const PROVENANCE_CHECK = [
  "set -euo pipefail",
  'if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then',
  '  echo "::error::The digest input is not an image digest (sha256: and 64 hexadecimal digits). Start this workflow with \\`opscrew promote\\`, which fills it in."',
  "  exit 1",
  "fi",
  'name="ghcr.io/${GITHUB_REPOSITORY,,}"',
  'image="$name@$DIGEST"',
  'if ! provenance="$(docker buildx imagetools inspect "$image" --format \'{{json .Provenance}}\')"; then',
  '  echo "::error::GitHub Container Registry has no image $image. Promote an image another environment runs: \\`opscrew promote\\` reads it from that environment\'s label."',
  "  exit 1",
  "fi",
  "# buildx names the run that built the image in runDetails.builder.id (per platform).",
  `mapfile -t runs < <(jq -r '${BUILDER_ID_FILTER}' <<< "$provenance" | sort -u)`,
  'if [[ "${#runs[@]}" -ne 1 || ! "${runs[0]}" =~ ^https://github\\.com/([^/]+/[^/]+)/actions/runs/([0-9]+)/attempts/[0-9]+$ ]]; then',
  "  echo \"::error::The image's build provenance does not name one GitHub Actions run, so OpsCrew cannot tell where it was built. Promote only an image this repository's deploy workflow built.\"",
  "  exit 1",
  "fi",
  'built_in="${BASH_REMATCH[1]}"',
  'run_id="${BASH_REMATCH[2]}"',
  'if [[ "${built_in,,}" != "${GITHUB_REPOSITORY,,}" ]]; then',
  '  echo "::error::The image was built by a run of $built_in, not of this repository ($GITHUB_REPOSITORY). OpsCrew promotes only images this repository built."',
  "  exit 1",
  "fi",
  'if ! record="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" --jq \'"\\(.event) \\(.head_repository.full_name) \\(.head_branch) \\(.head_sha) \\(.path)"\')"; then',
  '  echo "::error::GitHub shows no run $run_id in this repository, which the image\'s provenance names as its build. OpsCrew promotes only images this repository built."',
  "  exit 1",
  "fi",
  'read -r event head_repo branch commit workflow <<< "$record"',
  "# The run's path can end with @<ref>, which the signing identity carries separately.",
  'workflow="${workflow%%@*}"',
  "# A fork's pull request runs in this repository too, with its own branch name: only a push counts.",
  'if [[ "$event" != "push" ]]; then',
  '  echo "::error::The image was built by a $event run, not by a push. OpsCrew promotes only images a push to $BUILD_BRANCH built."',
  "  exit 1",
  "fi",
  'if [[ "${head_repo,,}" != "${GITHUB_REPOSITORY,,}" ]]; then',
  '  echo "::error::The image was built from the commits of $head_repo, not of this repository ($GITHUB_REPOSITORY). OpsCrew promotes only images this repository built."',
  "  exit 1",
  "fi",
  'if [[ "$branch" != "$BUILD_BRANCH" ]]; then',
  '  echo "::error::The image was built from the branch $branch, not from $BUILD_BRANCH, the branch whose pushes build the images this environment is promoted with. OpsCrew promotes only images a push to $BUILD_BRANCH built."',
  "  exit 1",
  "fi",
  "# prod's build tags its commit, another environment's <commit>-<env>.",
  'if [[ "$TAG" != "$commit" && ! "$TAG" =~ ^$commit-[a-z][a-z0-9-]*$ ]]; then',
  '  echo "::error::The tag input is not a commit tag of the image\'s build ($commit, or $commit-<environment>). Start this workflow with \\`opscrew promote\\`, which fills it in."',
  "  exit 1",
  "fi",
  'if [[ "$(docker buildx imagetools inspect "$name:$TAG" --format \'{{.Manifest.Digest}}\')" != "$DIGEST" ]]; then',
  '  echo "::error::The image is not the one tagged with its build\'s commit ($TAG): a later build of that commit replaced the tag, or the image was pushed another way. Promote the image another environment runs."',
  "  exit 1",
  "fi",
  "{",
  '  echo "image=$image"',
  '  echo "tag=$name:$TAG"',
  '  echo "identity=https://github.com/$GITHUB_REPOSITORY/$workflow@refs/heads/$branch"',
  '} >> "$GITHUB_OUTPUT"',
  'echo "Deploying \\`$image\\`, built by run $run_id from \\`$commit\\` on \\`$branch\\`." >> "$GITHUB_STEP_SUMMARY"',
];

/**
 * A promoted environment's first job, on GitHub's machines with `actions: read` and
 * `packages: read` only: the digest input's provenance check ({@link PROVENANCE_CHECK}) against the
 * branch that builds its images ({@link builderBranchOf}) and, with `supplyChain.sign`, its cosign
 * signature by the build run's workflow. Its outputs `image` and `tag` stand for the build job's.
 */
function verifyJob(plan: DeployPlan, ctx: Pick<RenderContext, "builderBranch">): string[] {
  return job({
    id: "verify",
    name: "Check where the image was built",
    permissions: ["actions: read", "packages: read"],
    outputs: [
      "image: ${{ steps.provenance.outputs.image }}",
      "tag: ${{ steps.provenance.outputs.tag }}",
    ],
    steps: [
      ...GHCR_LOGIN,
      "- id: provenance",
      "  name: Check the image's provenance",
      "  env:",
      "    DIGEST: ${{ inputs.digest }}",
      "    TAG: ${{ inputs.tag }}",
      `    BUILD_BRANCH: ${JSON.stringify(builderBranchOf(plan, ctx))}`,
      "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      ...run(PROVENANCE_CHECK),
      ...(plan.supplyChain.sign
        ? [
            ...INSTALL_COSIGN,
            "- name: Check the image's signature",
            "  env:",
            "    IMAGE: ${{ steps.provenance.outputs.image }}",
            "    IDENTITY: ${{ steps.provenance.outputs.identity }}",
            ...run([
              "set -euo pipefail",
              `if ! cosign verify "$IMAGE" --certificate-identity "$IDENTITY" --certificate-oidc-issuer ${GITHUB_OIDC_ISSUER} > /dev/null; then`,
              '  echo "::error::The image\'s signature does not verify for $IDENTITY, the workflow that built it. With supplyChain.sign on, OpsCrew deploys only images their build signed."',
              "  exit 1",
              "fi",
              'echo "The signature verifies for $IDENTITY."',
            ]),
          ]
        : []),
    ],
  });
}

/**
 * The job that gives the deploy its image: the build, or for a promoted environment the check of
 * the digest it was given ({@link verifyJob}).
 */
export function imageSourceJob(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch">,
): string[] {
  return promoted(plan) ? verifyJob(plan, ctx) : buildJob(plan);
}

/**
 * After a healthy deploy, holding only `packages: write`: tags the running image
 * `opscrew-<env>` and the one that ran before it `opscrew-<env>-previous`, with a tag-only
 * `imagetools create` that keeps the digest (and so its provenance and signature). `opscrew
 * promote` reads these labels, and image retention keeps every version one of the app's existing
 * environments' labels mark.
 */
function labelJob(plan: DeployPlan): string[] {
  const label = `opscrew-${environmentName(plan)}`;
  return job({
    id: "label",
    name: "Label the deployed image",
    needs: [imageJob(plan), "deploy"],
    permissions: ["packages: write"],
    steps: [
      ...GHCR_LOGIN,
      `- name: Tag the image ${label}, and the one before it ${label}-previous`,
      "  env:",
      `    IMAGE: ${imageOutput(plan, "image")}`,
      "    PREVIOUS: ${{ needs.deploy.outputs.previous }}",
      ...run([
        "set -euo pipefail",
        ...CHECK_IMAGE,
        'name="${IMAGE%@*}"',
        "# Tag-only: the image keeps its digest, so its provenance and signature stay valid. The",
        "# running label first, so a failed previous label never leaves it stale.",
        `docker buildx imagetools create --tag "$name:${label}" "$IMAGE"`,
        `echo "Labelled \\\`$IMAGE\\\` as \\\`${label}\\\`." >> "$GITHUB_STEP_SUMMARY"`,
        `if [[ "\${PREVIOUS:-}" =~ ${DIGEST_REF_PATTERN} && "$PREVIOUS" != "$IMAGE" ]]; then`,
        `  docker buildx imagetools create --tag "$name:${label}-previous" "$PREVIOUS"`,
        "fi",
      ]),
    ],
  });
}

/**
 * `cicd.deployTags`: after a healthy deploy, the tag `deploy-<UTC yyyymmdd-hhmmss>` on the deployed
 * commit and, with `release`, a GitHub Release naming the image digest; the only job that holds
 * `contents: write`. Tags made with the job's token start no other workflow.
 */
function deployTagsJob(plan: DeployPlan): string[] {
  const create = plan.cicd.deployTags.release
    ? [
        'gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "$tag" --notes "Deployed image: \\`$IMAGE\\`"',
      ]
    : [
        'gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/tags/$tag" -f "sha=$GITHUB_SHA" > /dev/null',
      ];
  return job({
    id: "tag",
    name: "Tag the deploy",
    needs: ["build", "deploy"],
    permissions: ["contents: write"],
    steps: [
      `- name: Tag the deployed commit${plan.cicd.deployTags.release ? " and create a release" : ""}`,
      "  env:",
      "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      IMAGE_ENV,
      ...run([
        "set -euo pipefail",
        ...CHECK_IMAGE,
        'tag="deploy-$(date -u +%Y%m%d-%H%M%S)"',
        ...create,
        'echo "Tagged \\`$GITHUB_SHA\\` as \\`$tag\\`." >> "$GITHUB_STEP_SUMMARY"',
      ]),
    ],
  });
}

/**
 * Image retention (FR-1229), after a healthy deploy, holding `packages: write` and `actions: read`
 * (to list the app's environments by their workflows): deletes the environment's intermediate
 * `build-<commit tag>` versions a seal build leaves ({@link sealsImage}) and, with
 * `cicd.imageRetention.enabled`, every version with its commit tag but the newest `keep`, never
 * the running or the previous image, one an existing environment's label tags, nor another
 * environment's builds (see {@link retentionScript}).
 */
function retentionJob(plan: DeployPlan): string[] {
  const { enabled, keep } = plan.cicd.imageRetention;
  return job({
    id: "prune",
    name: "Delete old images",
    needs: ["build", "deploy"],
    permissions: ["actions: read", "packages: write"],
    steps: [
      `- name: ${enabled ? `Keep the newest ${keep} images and delete older ones` : "Delete the intermediate build images"}`,
      "  shell: node {0}",
      "  env:",
      "    TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      IMAGE_ENV,
      "    PREVIOUS: ${{ needs.deploy.outputs.previous }}",
      ...(enabled ? [`    KEEP: "${keep}"`] : []),
      "  run: |",
      ...block([...retentionScript(environmentName(plan)).split("\n"), "main();"], 4),
    ],
  });
}

/**
 * The jobs after `build` and `deploy`, each with only the permission it needs: signing
 * (`supplyChain.sign`), the deploy tag (`cicd.deployTags.enabled`), image retention (for
 * `cicd.imageRetention.enabled`, or to delete the intermediate images of a seal build) and the
 * environment's image labels ({@link labelJob}). A promoted environment builds nothing, so it only
 * labels: the workflow of the environment that builds signs, tags and prunes.
 */
export function afterDeployJobs(plan: DeployPlan): string[] {
  if (promoted(plan)) return ["", ...labelJob(plan)];
  return [
    ...(plan.supplyChain.sign ? ["", ...signJob()] : []),
    ...(plan.cicd.deployTags.enabled ? ["", ...deployTagsJob(plan)] : []),
    ...(plan.cicd.imageRetention.enabled || sealsImage(plan) ? ["", ...retentionJob(plan)] : []),
    "",
    ...labelJob(plan),
  ];
}
