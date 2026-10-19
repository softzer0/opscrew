// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { ACTIONS, TOOLS } from "../pins";
import { sealsImage } from "./build";
import { RETENTION_SCRIPT } from "./retention";
import { block, DIGEST_REF_PATTERN, GHCR_LOGIN, job, run } from "./shared";

const IMAGE_ENV = "    IMAGE: ${{ needs.build.outputs.image }}";

/** Stops a step whose `$IMAGE` is not a GHCR digest reference. */
const CHECK_IMAGE = [
  `if [[ ! "$IMAGE" =~ ${DIGEST_REF_PATTERN} ]]; then`,
  '  echo "::error::The build job did not report the image digest; re-run the workflow."',
  "  exit 1",
  "fi",
];

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
      "- name: Install cosign",
      `  uses: ${ACTIONS.cosignInstaller}`,
      "  with:",
      `    cosign-release: ${TOOLS.cosign.version}`,
      ...GHCR_LOGIN,
      "- name: Sign the image (keyless, recorded in the public Sigstore log)",
      "  env:",
      IMAGE_ENV,
      ...run(["set -euo pipefail", ...CHECK_IMAGE, 'cosign sign --yes "$IMAGE"']),
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
 * Image retention (FR-1229), after a healthy deploy, holding only `packages: write`: deletes the
 * intermediate `build-<commit>` versions a seal build leaves ({@link sealsImage}) and, with
 * `cicd.imageRetention.enabled`, every `<commit>` version but the newest `keep`, never the running or
 * the previous image (see {@link RETENTION_SCRIPT}).
 */
function retentionJob(plan: DeployPlan): string[] {
  const { enabled, keep } = plan.cicd.imageRetention;
  return job({
    id: "prune",
    name: "Delete old images",
    needs: ["build", "deploy"],
    permissions: ["packages: write"],
    steps: [
      `- name: ${enabled ? `Keep the newest ${keep} images and delete older ones` : "Delete the intermediate build images"}`,
      "  shell: node {0}",
      "  env:",
      "    TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      IMAGE_ENV,
      "    PREVIOUS: ${{ needs.deploy.outputs.previous }}",
      ...(enabled ? [`    KEEP: "${keep}"`] : []),
      "  run: |",
      ...block([...RETENTION_SCRIPT.split("\n"), "main();"], 4),
    ],
  });
}

/**
 * The jobs after `build` and `deploy`, each with only the permission it needs: signing
 * (`supplyChain.sign`), the deploy tag (`cicd.deployTags.enabled`) and image retention (for
 * `cicd.imageRetention.enabled`, or to delete the intermediate images of a seal build).
 */
export function afterDeployJobs(plan: DeployPlan): string[] {
  return [
    ...(plan.supplyChain.sign ? ["", ...signJob()] : []),
    ...(plan.cicd.deployTags.enabled ? ["", ...deployTagsJob(plan)] : []),
    ...(plan.cicd.imageRetention.enabled || sealsImage(plan) ? ["", ...retentionJob(plan)] : []),
  ];
}
