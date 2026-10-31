// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { ACTIONS, TOOLS } from "../pins";
import type { RenderContext } from "../types";
import { buildJob, sealsImage } from "./build";
import { pausedJob, pausedTest } from "./pause";
import { retentionScript } from "./retention";
import {
  block,
  builderBranchOf,
  CHECK_IMAGE,
  DIGEST_REF_PATTERN,
  environmentName,
  GHCR_LOGIN,
  githubEnvironment,
  imageJobs,
  imageOutput,
  imageSubpath,
  job,
  promoted,
  ROLLING_BACK,
  run,
  runnerLabel,
  selfHosted,
} from "./shared";

const IMAGE_ENV = "    IMAGE: ${{ needs.build.outputs.image }}";

/**
 * The condition of a job after `build` and `deploy` that needs both to have succeeded. Its own
 * status check (`!cancelled()`) replaces the implicit `success()`, which skips a job when any job
 * before it was skipped, even indirectly: `deploy` also needs `verify`, which a push skips
 * (research R6, S3).
 */
const AFTER_BUILT_DEPLOY =
  "${{ !cancelled() && needs.build.result == 'success' && needs.deploy.result == 'success' }}";

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
 * The provenance check of the digest a promotion or a rollback gives (`$DIGEST`): the image's SLSA
 * provenance (`docker buildx imagetools inspect`) must name exactly one GitHub Actions run, as
 * buildx records it in `runDetails.builder.id`; that run must be this repository's, its API record
 * must show a `push`, or a run started by hand (`workflow_dispatch`, ADR 0023 D1), of this
 * repository's own commits on the branch that builds the environment's images (`$BUILD_BRANCH`:
 * its own `cicd.branch`, or a promoted environment's builder's), and the image with the commit tag
 * `$TAG` must be this digest. `$TAG` is the run's commit, or `<commit>-<env>`
 * ({@link environmentTag} of the environment that built it, which this workflow cannot know: the
 * source may itself be promoted from another). The image is the app's ({@link imageSubpath}).
 * Outputs `image`, `tag` (`<name>:<commit tag>`) and `identity`, the signing identity of the run's
 * workflow on that branch.
 */
const provenanceCheck = (plan: DeployPlan) => [
  "set -euo pipefail",
  'if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then',
  '  echo "::error::The digest input is not an image digest (sha256: and 64 hexadecimal digits). Start this workflow with \\`opscrew promote\\` or \\`opscrew rollback\\`, which fill it in."',
  "  exit 1",
  "fi",
  `name="ghcr.io/\${GITHUB_REPOSITORY,,}${imageSubpath(plan)}"`,
  'image="$name@$DIGEST"',
  'if ! provenance="$(docker buildx imagetools inspect "$image" --format \'{{json .Provenance}}\')"; then',
  '  echo "::error::GitHub Container Registry has no image $image. Start this workflow with \\`opscrew promote\\` or \\`opscrew rollback\\`, which choose an image that is there."',
  "  exit 1",
  "fi",
  "# buildx names the run that built the image in runDetails.builder.id (per platform).",
  `mapfile -t runs < <(jq -r '${BUILDER_ID_FILTER}' <<< "$provenance" | sort -u)`,
  'if [[ "${#runs[@]}" -ne 1 || ! "${runs[0]}" =~ ^https://github\\.com/([^/]+/[^/]+)/actions/runs/([0-9]+)/attempts/[0-9]+$ ]]; then',
  "  echo \"::error::The image's build provenance does not name one GitHub Actions run, so OpsCrew cannot tell where it was built. OpsCrew deploys a digest only when this repository's deploy workflow built it.\"",
  "  exit 1",
  "fi",
  'built_in="${BASH_REMATCH[1]}"',
  'run_id="${BASH_REMATCH[2]}"',
  'if [[ "${built_in,,}" != "${GITHUB_REPOSITORY,,}" ]]; then',
  '  echo "::error::The image was built by a run of $built_in, not of this repository ($GITHUB_REPOSITORY). OpsCrew deploys a digest only when this repository built it."',
  "  exit 1",
  "fi",
  'if ! record="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" --jq \'"\\(.event) \\(.head_repository.full_name) \\(.head_branch) \\(.head_sha) \\(.path)"\')"; then',
  '  echo "::error::GitHub shows no run $run_id in this repository, which the image\'s provenance names as its build. OpsCrew deploys a digest only when this repository built it."',
  "  exit 1",
  "fi",
  'read -r event head_repo branch commit workflow <<< "$record"',
  "# The run's path can end with @<ref>, which the signing identity carries separately.",
  'workflow="${workflow%%@*}"',
  "# A fork's pull request runs in this repository too, with its own branch name: only a push, or a",
  "# run started by hand, which takes write access (ADR 0023 D1), counts.",
  'if [[ "$event" != "push" && "$event" != "workflow_dispatch" ]]; then',
  '  echo "::error::The image was built by a $event run, not by a push or a run started by hand. OpsCrew deploys a digest only when a push to $BUILD_BRANCH, or a run started by hand there, built it."',
  "  exit 1",
  "fi",
  'if [[ "${head_repo,,}" != "${GITHUB_REPOSITORY,,}" ]]; then',
  '  echo "::error::The image was built from the commits of $head_repo, not of this repository ($GITHUB_REPOSITORY). OpsCrew deploys a digest only when this repository built it."',
  "  exit 1",
  "fi",
  'if [[ "$branch" != "$BUILD_BRANCH" ]]; then',
  '  echo "::error::The image was built from the branch $branch, not from $BUILD_BRANCH, the branch that builds this environment\'s images. OpsCrew deploys a digest only when a build on $BUILD_BRANCH made it."',
  "  exit 1",
  "fi",
  "# prod's build tags its commit, another environment's <commit>-<env>.",
  'if [[ "$TAG" != "$commit" && ! "$TAG" =~ ^$commit-[a-z][a-z0-9-]*$ ]]; then',
  '  echo "::error::The tag input is not a commit tag of the image\'s build ($commit, or $commit-<environment>). Start this workflow with \\`opscrew promote\\` or \\`opscrew rollback\\`, which fill it in."',
  "  exit 1",
  "fi",
  'if [[ "$(docker buildx imagetools inspect "$name:$TAG" --format \'{{.Manifest.Digest}}\')" != "$DIGEST" ]]; then',
  '  echo "::error::The image is not the one tagged with its build\'s commit ($TAG): a later build of that commit replaced the tag, or the image was pushed another way. \\`opscrew rollback --list\\` shows the versions to roll back to, and \\`opscrew promote\\` takes the image another environment runs."',
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
 * The job that checks a digest input, on GitHub's machines with `actions: read` and
 * `packages: read` only: a promoted environment's first job, and in an environment that follows a
 * branch the job a rollback dispatch runs instead of the build. The digest's provenance check
 * ({@link provenanceCheck}) is against the branch that builds the environment's images (its own
 * `cicd.branch`, or a promoted one's {@link builderBranchOf}) and, with `supplyChain.sign`, its
 * cosign signature by the build run's workflow. Its outputs `image` and `tag` stand for the build
 * job's.
 */
function verifyJob(plan: DeployPlan, ctx: Pick<RenderContext, "builderBranch">): string[] {
  const branch = promoted(plan) ? builderBranchOf(plan, ctx) : plan.cicd.branch;
  return job({
    id: "verify",
    name: "Check where the image was built",
    ...(promoted(plan) ? {} : { if: `\${{ ${ROLLING_BACK} }}` }),
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
      `    BUILD_BRANCH: ${JSON.stringify(branch)}`,
      "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      ...run(provenanceCheck(plan)),
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
 * The jobs before a server's or Portainer's deploy ({@link deployJob}): `paused`
 * ({@link pausedJob}), which says why a run doesn't deploy while the environment is paused (a
 * rollback dispatch deploys), then the jobs that give the deploy its image ({@link imageJobs}): for
 * an environment that follows a branch, the build, which a rollback dispatch skips, and the check
 * of the digest it gives ({@link verifyJob}); for a promoted environment, only that check.
 */
export function jobsBeforeDeploy(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch">,
): string[] {
  return [
    ...pausedJob(plan, `\${{ !${ROLLING_BACK} && ${pausedTest(plan)} }}`),
    "",
    ...(promoted(plan) ? [] : [...buildJob(plan), ""]),
    ...verifyJob(plan, ctx),
  ];
}

/**
 * The `deploy` job (`name` shown in GitHub): after the job that gave it the image
 * ({@link imageJobs}), in the {@link githubEnvironment}, with the token's `permissions`
 * (`contents: read`, …) and the `steps`. It runs on `ubuntu-latest`, or with `environment.runner`
 * `server`, `local` or `host` on the environment's self-hosted runner ({@link runnerLabel}), every
 * step with bash (Git for Windows' on a Windows computer). Its output `previous` is the image that
 * ran before this deploy (empty on the first one), which the image retention job never deletes and
 * the label job labels `opscrew-<env>-previous`.
 *
 * It is skipped while the environment is paused ({@link pausedTest}), except in a rollback
 * dispatch (a rollback of a rollback). In an environment that follows a branch one of `build` and
 * `verify` is always skipped, so it checks their results itself (research R6, S3).
 */
export function deployJob(
  plan: DeployPlan,
  name: string,
  permissions: readonly string[],
  previous: string,
  steps: readonly string[],
): string[] {
  const unpaused = `${ROLLING_BACK} || !${pausedTest(plan)}`;
  const own = selfHosted(plan);
  return job({
    id: "deploy",
    name,
    needs: imageJobs(plan),
    if: promoted(plan)
      ? `\${{ ${unpaused} }}`
      : `\${{ !cancelled() && (needs.build.result == 'success' || needs.verify.result == 'success') && (${unpaused}) }}`,
    environment: githubEnvironment(plan),
    runsOn: own ? `[self-hosted, ${runnerLabel(plan)}]` : undefined,
    shell: own ? "bash" : undefined,
    permissions,
    outputs: [`previous: ${previous}`],
    steps,
  });
}

/**
 * After a healthy deploy, holding only `packages: write`: tags the running image
 * `opscrew-<env>` and the one that ran before it `opscrew-<env>-previous`, with a tag-only
 * `imagetools create` that keeps the digest (and so its provenance and signature). `opscrew
 * promote` reads these labels, and image retention keeps every version one of the app's existing
 * environments' labels mark. In an environment that follows a branch, after the deploy of either
 * image job's image ({@link imageJobs}), one of which is always skipped.
 */
function labelJob(plan: DeployPlan): string[] {
  const label = `opscrew-${environmentName(plan)}`;
  return job({
    id: "label",
    name: "Label the deployed image",
    needs: [...imageJobs(plan), "deploy"],
    ...(promoted(plan) ? {} : { if: "${{ !cancelled() && needs.deploy.result == 'success' }}" }),
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
 * `cicd.deployTags`: after a healthy deploy, the tag `deploy-<UTC yyyymmdd-hhmmss>` (a further
 * app's `deploy-<key>-<UTC yyyymmdd-hhmmss>`, so two apps' deploys of a commit never take the same
 * tag) on the deployed commit and, with `release`, a GitHub Release naming the image digest; the
 * only job that holds `contents: write`. Tags made with the job's token start no other workflow.
 */
function deployTagsJob(plan: DeployPlan): string[] {
  const key = plan.app.key;
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
    if: AFTER_BUILT_DEPLOY,
    permissions: ["contents: write"],
    steps: [
      `- name: Tag the deployed commit${plan.cicd.deployTags.release ? " and create a release" : ""}`,
      "  env:",
      "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      IMAGE_ENV,
      ...run([
        "set -euo pipefail",
        ...CHECK_IMAGE,
        `tag="deploy-${key === undefined ? "" : `${key}-`}$(date -u +%Y%m%d-%H%M%S)"`,
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
    if: AFTER_BUILT_DEPLOY,
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
      ...block([...retentionScript(plan).split("\n"), "main();"], 4),
    ],
  });
}

/**
 * The jobs after `build` and `deploy`, each with only the permission it needs: signing
 * (`supplyChain.sign`), the deploy tag (`cicd.deployTags.enabled`), image retention (for
 * `cicd.imageRetention.enabled`, or to delete the intermediate images of a seal build) and the
 * environment's image labels ({@link labelJob}). A promoted environment builds nothing, so it only
 * labels: the workflow of the environment that builds signs, tags and prunes. A rollback dispatch
 * builds nothing either, so it too only labels.
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
