// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan, RuntimeLanguage } from "@opscrew/plan-schema";
import { TOOL_RELEASES } from "../../scripts/update-pins-lib";
import { ACTIONS, IMAGES, TOOLS } from "../pins";
import {
  buildArch,
  buildRunner,
  DEFAULT_TRIVY_IMAGE,
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  GHCR_LOGIN,
  job,
  run,
  secret,
} from "./shared";

/**
 * The Buildpacks setting that selects the runtime version, per language the Paketo builder
 * builds: Buildpacks ignores some version files (`.python-version`), so OpsCrew always passes the
 * version recorded in `app.build.runtime`.
 */
const BUILDPACKS_VERSION_SETTING: Partial<Record<RuntimeLanguage, string>> = {
  node: "BP_NODE_VERSION",
  python: "BP_CPYTHON_VERSION",
  go: "BP_GO_VERSION",
  java: "BP_JVM_VERSION",
  dotnet: "BP_DOTNET_FRAMEWORK_VERSION",
  ruby: "BP_MRI_VERSION",
  php: "BP_PHP_VERSION",
};

/**
 * The folders under `/app` a framework writes to, which the Railpack seal gives to the app's user
 * (Rails for Ruby, Laravel for PHP): Railpack images run as root, and uid 10001 cannot create
 * them in the root-owned `/app`.
 */
const RAILPACK_WRITABLE: Partial<Record<RuntimeLanguage, readonly string[]>> = {
  ruby: ["tmp", "log", "storage", "db"],
  php: ["storage", "bootstrap/cache", "database"],
};

/** The user every Railpack image runs as after the seal. */
const RAILPACK_USER = "10001:10001";

/** `owner/name@<sha> # vX` for `uses:`. */
const uses = (key: keyof typeof ACTIONS) => `  uses: ${ACTIONS[key]}`;

/** `name` (`ghcr.io/<owner>/<repo>`) and `image` (`<name>:<commit>`), lower case as GHCR needs. */
const IMAGE_NAME = [
  "- id: image",
  "  name: Choose the image name",
  ...run([
    "set -euo pipefail",
    'repo="${GITHUB_REPOSITORY,,}"',
    'echo "name=ghcr.io/${repo}" >> "$GITHUB_OUTPUT"',
    'echo "image=ghcr.io/${repo}:${GITHUB_SHA}" >> "$GITHUB_OUTPUT"',
  ]),
];

const SETUP_BUILDX = [
  "# Keeps the GitHub event (commit messages, emails) out of the provenance; it still names the",
  "# workflow run, and the repository and commit of the checkout.",
  "- name: Set up Docker Buildx",
  uses("setupBuildx"),
  "  with:",
  "    driver-opts: provenance-add-gha=false",
];

/**
 * The final `build-push-action` step (`push`): pushed as `<name>:<commit>` with a mode=max
 * provenance and an SBOM; its `digest` output is the image index digest the deploy uses.
 */
function finalBuild(name: string, inputs: readonly string[], cache: string): string[] {
  return [
    "- id: push",
    `  name: ${name}`,
    uses("buildPush"),
    "  with:",
    ...inputs.map((line) => `    ${line}`),
    "    push: true",
    "    tags: ${{ steps.image.outputs.image }}",
    "    provenance: mode=max",
    "    sbom: true",
    `    cache-from: type=gha${cache === "" ? "" : `,${cache}`}`,
    `    cache-to: type=gha,mode=${cache === "" ? "max" : `min,${cache}`}`,
  ];
}

/** `generated-dockerfile` and `own-dockerfile` (and a plan without a builder yet). */
function dockerfileSteps(plan: DeployPlan): string[] {
  return finalBuild(
    "Build and push the image",
    [
      `context: ${JSON.stringify(plan.app.buildContext || ".")}`,
      `file: ${JSON.stringify(plan.app.dockerfile || "Dockerfile")}`,
      "# The provenance records build arguments: only non-secret values go there.",
      `build-args: ${secret(DEPLOY_SECRETS.buildEnv)}`,
      `secrets: ${secret(DEPLOY_SECRETS.buildSecrets)}`,
    ],
    "",
  );
}

/**
 * Writes the seal's Dockerfile, `FROM` the intermediate image by digest (`$BASE`), plus `extra`
 * lines, outside the checkout so that it stays clean for the provenance's commit.
 */
function sealSteps(digestOf: string, extra: readonly string[]): string[] {
  const lines = ['"FROM $BASE"', ...extra.map((line) => `'${line}'`)].join(" ");
  return [
    "- name: Write the seal Dockerfile",
    "  env:",
    `    BASE: \${{ steps.image.outputs.name }}:build-\${{ github.sha }}@\${{ steps.${digestOf}.outputs.digest }}`,
    ...run([
      "set -euo pipefail",
      'mkdir -p "$RUNNER_TEMP/seal"',
      `printf '%s\\n' ${lines} > "$RUNNER_TEMP/seal/Dockerfile"`,
    ]),
    ...finalBuild(
      "Seal and push the image",
      [
        "# The checkout is the context, so the provenance names its repository and commit; the",
        "# seal copies nothing from it.",
        'context: "."',
        "file: ${{ runner.temp }}/seal/Dockerfile",
      ],
      "scope=seal",
    ),
  ];
}

/**
 * Adds the `NAME=value` lines of `input` to the bash array `array` as `--env` arguments: `pair`
 * (`"$line"` for the whole line, `"${line%%=*}="` for the name only).
 */
function envPairs(array: string, input: string, pair = '"$line"'): string[] {
  return [
    "while IFS= read -r line; do",
    '  [[ -z "$line" || "$line" == \\#* ]] && continue',
    `  ${array}+=(--env ${pair})`,
    `done <<< ${input}`,
  ];
}

/**
 * Buildpacks: pack builds `build-<commit>` with the version setting and the non-secret build values
 * (`--env`), pushes it with its cache image, and reports its digest in `report.toml`; then the seal.
 * pack has no secret mounts, so it never reads the secret build values.
 */
function buildpacksSteps(plan: DeployPlan): string[] {
  const runtime = plan.app.build?.runtime;
  const setting =
    runtime?.version === undefined ? undefined : BUILDPACKS_VERSION_SETTING[runtime.language];
  return [
    "- name: Set up pack",
    uses("setupPack"),
    "  with:",
    `    pack-version: ${TOOLS.pack.version}`,
    "- id: pack",
    "  name: Build the image with Buildpacks",
    "  env:",
    "    NAME: ${{ steps.image.outputs.name }}",
    `    BUILD_ENV: ${secret(DEPLOY_SECRETS.buildEnv)}`,
    ...run([
      "set -euo pipefail",
      setting === undefined ? "settings=()" : `settings=(--env ${setting}=${runtime?.version})`,
      ...envPairs("settings", '"${BUILD_ENV:-}"'),
      // pack writes a file instead when the folder is missing.
      'report="$RUNNER_TEMP/pack-report"',
      'mkdir -p "$report"',
      `pack build "$NAME:build-$GITHUB_SHA" --path ${JSON.stringify(plan.app.buildContext || ".")} \\`,
      `  --builder ${IMAGES.paketoBuilder.ref} \\`,
      `  --run-image ${IMAGES.paketoRun.ref} \\`,
      '  "${settings[@]}" --publish --cache-image "$NAME:buildcache" --report-output-dir "$report"',
      'digest="$(sed -nE \'s/^[[:space:]]*digest = "(sha256:[0-9a-f]{64})".*/\\1/p\' "$report/report.toml" | head -n 1)"',
      'if [[ -z "$digest" ]]; then',
      '  echo "::error::pack did not report the digest of the image it pushed; re-run the workflow."',
      "  exit 1",
      "fi",
      'echo "digest=$digest" >> "$GITHUB_OUTPUT"',
    ]),
    ...sealSteps("pack", []),
  ];
}

/**
 * Railpack: installs the pinned CLI (checksum from pins.ts), plans the build with the non-secret
 * build values and the names of the secret ones, and builds `build-<commit>` with its frontend, all
 * values as BuildKit secrets; then the seal, which makes the image run as uid 10001.
 */
function railpackSteps(plan: DeployPlan): string[] {
  const arch = buildArch(plan);
  const { version } = TOOLS.railpack;
  const release = TOOL_RELEASES.railpack;
  const url = `https://github.com/${release.repo}/releases/download/${release.tag(version)}/${release.asset[arch](version)}`;
  const context = JSON.stringify(plan.app.buildContext || ".");
  const writable = (RAILPACK_WRITABLE[plan.app.build?.runtime.language ?? "other"] ?? []).map(
    (dir) => `/app/${dir}`,
  );
  return [
    `- name: Install Railpack ${version}`,
    ...run([
      "set -euo pipefail",
      `curl -fsSL --retry 3 -o "$RUNNER_TEMP/railpack.tar.gz" ${url}`,
      `echo "${TOOLS.railpack.sha256[arch]}  $RUNNER_TEMP/railpack.tar.gz" | sha256sum -c -`,
      'mkdir -p "$RUNNER_TEMP/railpack"',
      'tar -xzf "$RUNNER_TEMP/railpack.tar.gz" -C "$RUNNER_TEMP/railpack"',
      'sudo install -m 0755 "$(find "$RUNNER_TEMP/railpack" -type f -name railpack | head -n 1)" /usr/local/bin/railpack',
    ]),
    "- id: prepare",
    "  name: Plan the Railpack build",
    "  env:",
    `    BUILD_ENV: ${secret(DEPLOY_SECRETS.buildEnv)}`,
    `    BUILD_SECRETS: ${secret(DEPLOY_SECRETS.buildSecrets)}`,
    ...run([
      "set -euo pipefail",
      "# The plan lists the names; the build reads the values as BuildKit secrets. Railpack",
      "# never sees a secret value here, only its name.",
      "values=()",
      ...envPairs("values", '"${BUILD_ENV:-}"'),
      ...envPairs("values", '"${BUILD_SECRETS:-}"', '"${line%%=*}="'),
      "for attempt in 1 2 3; do",
      "  code=0",
      `  railpack prepare ${context} --plan-out "$RUNNER_TEMP/railpack-plan.json" --info-out "$RUNNER_TEMP/railpack-info.json" "\${values[@]}" || code=$?`,
      "  # 75 is a temporary failure, such as a download; anything else is final.",
      '  if [[ "$code" -ne 75 ]]; then break; fi',
      "  sleep 10",
      "done",
      'if [[ "$code" -ne 0 ]]; then',
      '  echo "::error::Railpack could not plan the build (exit code $code); its output above says why."',
      "  exit 1",
      "fi",
      // A new non-secret value changes the cache key, so it is not served from the cache.
      'echo "hash=$(printf \'%s\' "${BUILD_ENV:-}" | sha256sum | cut -d \' \' -f 1)" >> "$GITHUB_OUTPUT"',
    ]),
    "- id: railpack",
    "  name: Build the image with Railpack",
    uses("buildPush"),
    "  with:",
    `    context: ${context}`,
    "    file: ${{ runner.temp }}/railpack-plan.json",
    "    push: true",
    "    tags: ${{ steps.image.outputs.name }}:build-${{ github.sha }}",
    "    provenance: false",
    "    build-args: |",
    `      BUILDKIT_SYNTAX=${IMAGES.railpackFrontend.ref}`,
    "      secrets-hash=${{ steps.prepare.outputs.hash }}",
    "    secrets: |",
    `      ${secret(DEPLOY_SECRETS.buildEnv)}`,
    `      ${secret(DEPLOY_SECRETS.buildSecrets)}`,
    "    cache-from: type=gha,scope=railpack",
    "    cache-to: type=gha,mode=min,scope=railpack",
    ...sealSteps("railpack", [
      ...(writable.length === 0
        ? []
        : [
            `RUN mkdir -p ${writable.join(" ")} && chown -R ${RAILPACK_USER} ${writable.join(" ")}`,
          ]),
      `USER ${RAILPACK_USER}`,
    ]),
  ];
}

/** Checks the final digest and records `<name>@<digest>` as `ref`, which every deploy uses. */
const RECORD = [
  "- id: final",
  "  name: Record the image digest",
  "  env:",
  "    NAME: ${{ steps.image.outputs.name }}",
  "    DIGEST: ${{ steps.push.outputs.digest }}",
  ...run([
    "set -euo pipefail",
    'ref="$NAME@$DIGEST"',
    `if [[ ! "$ref" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '  echo "::error::Could not read the digest of the pushed image; re-run the workflow."',
    "  exit 1",
    "fi",
    'echo "ref=$ref" >> "$GITHUB_OUTPUT"',
    'echo "Pushed \\`$NAME:$GITHUB_SHA\\` as \\`$ref\\`." >> "$GITHUB_STEP_SUMMARY"',
  ]),
];

const SCAN = [
  "# The scan runs after the registry logout, so it never holds the job's packages: write token.",
  "- name: Scan the image (report only)",
  "  env:",
  "    IMAGE: ${{ steps.final.outputs.ref }}",
  ...run([
    "set -euo pipefail",
    'docker pull --quiet "$IMAGE"',
    "docker logout ghcr.io",
    `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${DEFAULT_TRIVY_IMAGE} image --no-progress --severity HIGH,CRITICAL --exit-code 0 "$IMAGE"`,
  ]),
];

/**
 * The `build` job: builds the image with the plan's builder on a runner of the server's
 * architecture and pushes it to GHCR (`app.build` absent: the Dockerfile, as before). Buildpacks
 * and Railpack push `<name>:build-<commit>` first, then a seal build. Every builder ends in one
 * `build-push-action` build with a mode=max provenance and an SBOM. Outputs: `image`, the final
 * index digest reference, and `tag`, `<name>:<commit>`. Then the optional report-only scan.
 */
export function buildJob(plan: DeployPlan): string[] {
  const builder = plan.app.build?.builder;
  const steps =
    builder === "buildpacks"
      ? buildpacksSteps(plan)
      : builder === "railpack"
        ? railpackSteps(plan)
        : dockerfileSteps(plan);
  return job({
    id: "build",
    name: "Build the image",
    runsOn: buildRunner(plan),
    permissions: ["contents: read", "packages: write"],
    outputs: ["image: ${{ steps.final.outputs.ref }}", "tag: ${{ steps.image.outputs.image }}"],
    steps: [
      `- uses: ${ACTIONS.checkout}`,
      ...IMAGE_NAME,
      ...SETUP_BUILDX,
      ...GHCR_LOGIN,
      ...steps,
      ...RECORD,
      ...(plan.security.imageScan ? SCAN : []),
    ],
  });
}
