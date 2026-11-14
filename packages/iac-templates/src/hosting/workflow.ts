// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { posix } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import {
  cleanRepoPath,
  type DeployPlan,
  type HostingDeployTarget,
  isHostingTarget,
} from "@opscrew/plan-schema";
import { packageManagerSpec } from "../docker/stacks";
import { ACTIONS, IMAGES, type ImagePin, RUNTIME_DEFAULTS } from "../pins";
import { wrongTarget } from "../providers";
import { shellQuote } from "../runtime/services";
import { siteExists, siteToolSteps } from "../serverless/site";
import type { RenderContext, RenderedFile } from "../types";
import { pushPaths } from "../workflow/paths";
import { pausedJob, unpaused } from "../workflow/pause";
import {
  DISPATCH_BY_HAND,
  deploySecretName,
  environmentName,
  githubEnvironment,
  healthPath,
  job,
  opscrew,
  promoted,
  provisionCommand,
  run,
  secret,
  workflowStart,
} from "../workflow/shared";

/**
 * The GitHub Actions secret (before `deploySecretName`) holding the key that signs the
 * environment's releases: an ECDSA P-256 private key in PEM. `opscrew provision` sets it as a
 * secret of the deploy environment; the account holds only its public half (ADR 0030 D4).
 */
export const RELEASE_SIGNING_KEY_SECRET = "OPSCREW_RELEASE_SIGNING_KEY";

/**
 * The branch the environment's releases are force-pushed to: `opscrew/release/<env>` for the
 * repository's first app, `opscrew/release/<key>-<env>` for a further app (`prod` for prod), as
 * `workflowPathFor` names the workflow.
 */
export function releaseBranch(plan: DeployPlan): string {
  const env = environmentName(plan);
  return `opscrew/release/${plan.app.key === undefined ? env : `${plan.app.key}-${env}`}`;
}

/** The build's artifact: the release tree as a tar, which keeps file modes and links. */
export const RELEASE_ARTIFACT = "opscrew-release";

/** The PHP CLI image per version a hosting plan can choose (`major.minor`). */
const PHP_CLI_IMAGES: Readonly<Record<string, ImagePin>> = {
  "7.4": IMAGES.php74Cli,
  "8.0": IMAGES.php80Cli,
  "8.1": IMAGES.php81Cli,
  "8.2": IMAGES.php82Cli,
  "8.3": IMAGES.php83Cli,
  "8.4": IMAGES.php84Cli,
  "8.5": IMAGES.php85Cli,
};

/**
 * The PHP versions (`major.minor`) the deploy workflow builds a release with, oldest first: a
 * hosting plan can choose only these.
 */
export const HOSTING_PHP_VERSIONS: readonly string[] = Object.keys(PHP_CLI_IMAGES);

/**
 * The PHP CLI image of the target's PHP version.
 * @throws OpsCrewError `INVALID_INPUT` for a version OpsCrew has no image of.
 */
function phpImage(plan: DeployPlan, target: HostingDeployTarget): ImagePin {
  const version = target.php?.version;
  const image = version === undefined ? undefined : PHP_CLI_IMAGES[version];
  if (image !== undefined) return image;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew builds PHP apps for a hosting account with PHP ${HOSTING_PHP_VERSIONS.join(", ")}; the plan's PHP version is ${version ?? "not set"}.`,
    {
      hint: `Choose one of these versions for the app, then run \`${provisionCommand(plan)}\` again.`,
    },
  );
}

/**
 * The step that builds the app's assets with Node.js when package.json has a `build` script: the
 * install from the lockfile with its package manager (pnpm and Yarn at package.json's exact
 * `packageManager` version, else OpsCrew's pin), then `build`. The release leaves `node_modules`
 * out, so nothing else needs the install.
 */
function assetBuild(dir: string, title: string): string[] {
  return [
    `- name: ${title}`,
    `  working-directory: ${dir}`,
    ...run([
      "set -euo pipefail",
      "if [[ ! -f package.json ]] || ! node -e 'process.exit(require(\"./package.json\").scripts?.build ? 0 : 1)'; then",
      '  echo "package.json has no build script: nothing to build."',
      "  exit 0",
      "fi",
      "if [[ -f pnpm-lock.yaml ]]; then",
      `  ${packageManagerSpec("pnpm")}`,
      '  npm install -g --no-audit --no-fund "$spec"',
      "  pm=pnpm",
      "  pnpm install --frozen-lockfile",
      "elif [[ -f yarn.lock ]]; then",
      `  ${packageManagerSpec("yarn")}`,
      '  npm install -g --no-audit --no-fund "$spec"',
      "  pm=yarn",
      "  yarn install --frozen-lockfile",
      "elif [[ -f package-lock.json ]]; then",
      "  pm=npm",
      "  npm ci",
      "else",
      "  pm=npm",
      "  npm install",
      "fi",
      '"$pm" run build',
    ]),
  ];
}

/** Sets up Node.js at `version`. */
function setupNode(version: string): string[] {
  return [
    `- uses: ${ACTIONS.setupNode}`,
    "  with:",
    `    node-version: ${JSON.stringify(version)}`,
  ];
}

/**
 * The PHP app's build: Composer's install (no dev packages, an optimized autoloader) in the PHP CLI
 * image of the hostname's version, so Composer still checks the PHP version the lockfile needs;
 * the extensions were checked against the account at provision, so `ext-*` requirements are
 * ignored here. Composer comes from its pinned image. Then the assets ({@link assetBuild}).
 */
function phpBuild(plan: DeployPlan, target: HostingDeployTarget, dir: string): string[] {
  const image = phpImage(plan, target);
  return [
    `- name: Install the app's PHP packages with Composer in PHP ${target.php?.version}`,
    `  working-directory: ${dir}`,
    "  env:",
    `    PHP_IMAGE: ${image.ref}`,
    `    COMPOSER_IMAGE: ${IMAGES.composer.ref}`,
    ...run([
      "set -euo pipefail",
      "if [[ ! -f composer.json ]]; then",
      '  echo "The app has no composer.json: no PHP packages to install."',
      "  exit 0",
      "fi",
      'docker create --name opscrew-composer "$COMPOSER_IMAGE" > /dev/null',
      'docker cp opscrew-composer:/usr/bin/composer "$RUNNER_TEMP/composer"',
      "docker rm opscrew-composer > /dev/null",
      "# The PHP image has neither unzip nor PHP's zip extension, one of which Composer unpacks with.",
      // apt checks the packages' signatures. The 7.4 and 8.0 images are Debian bullseye: should
      // its sources move to archive.debian.org, their apt-get update fails and they need a fix.
      "# The container runs as root: vendor/ goes back to the runner's user, so a self-hosted runner's next checkout can clean it.",
      'docker run --rm -e COMPOSER_ALLOW_SUPERUSER=1 -e OWNER="$(id -u):$(id -g)" -v "$PWD:/app" -v "$RUNNER_TEMP/composer:/usr/local/bin/composer:ro" -w /app "$PHP_IMAGE" \\',
      '  bash -c \'apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip > /dev/null && composer install --no-dev --optimize-autoloader --no-interaction --no-progress --ignore-platform-req="ext-*" && chown -R "$OWNER" vendor\'',
    ]),
    ...setupNode(RUNTIME_DEFAULTS.node),
    ...assetBuild(dir, "Build the app's assets"),
  ];
}

/**
 * The build job's steps after the checkout, and the repository folder the release is made of: the
 * app's folder (a Python app's as it is), or a static site's output.
 */
function buildSteps(
  plan: DeployPlan,
  target: HostingDeployTarget,
): { steps: string[]; release: string } {
  const folder = plan.app.buildContext;
  const dir = JSON.stringify(folder);
  switch (target.app) {
    case "php":
      return { steps: phpBuild(plan, target, dir), release: folder };
    case "node":
      return {
        steps: [
          ...setupNode(target.runtime?.version ?? RUNTIME_DEFAULTS.node),
          ...assetBuild(dir, "Build the app"),
        ],
        release: folder,
      };
    case "static": {
      const site = target.site;
      if (site === undefined) {
        throw new OpsCrewError(
          "INTERNAL",
          "OpsCrew rendered a static site's workflow for a hosting account without its build.",
          { hint: "This is a bug in OpsCrew; please report it." },
        );
      }
      const assets = cleanRepoPath(posix.join(folder, site.outputDir));
      // No app values: a hosting account's values stay on the account, never in GitHub.
      const build =
        site.command === undefined
          ? []
          : [
              "- name: Build the site",
              `  working-directory: ${dir}`,
              ...run(["set -euo pipefail", site.command]),
            ];
      return {
        steps: [
          ...siteToolSteps(site, dir),
          ...build,
          "- name: Check the built site",
          ...run(["set -euo pipefail", ...siteExists(plan, { assets })]),
        ],
        release: assets,
      };
    }
    case "python":
      // No build: the source is the release; the selector installs its packages on the account.
      return { steps: [], release: folder };
  }
}

/**
 * The build job of a hosting account's workflow: the app's release built ({@link buildSteps}) with
 * `contents: read` and kept as a tar, which keeps file modes and links, in the artifact
 * {@link RELEASE_ARTIFACT}.
 */
export function releaseBuildJob(plan: DeployPlan, target: HostingDeployTarget): string[] {
  const { steps, release } = buildSteps(plan, target);
  return job({
    id: "build",
    name: "Build the release",
    permissions: ["contents: read"],
    steps: [
      `- uses: ${ACTIONS.checkout}`,
      "  with:",
      "    persist-credentials: false",
      ...steps,
      "- name: Keep the release",
      ...run([
        "set -euo pipefail",
        `tar -cf "$RUNNER_TEMP/release.tar" -C ${shellQuote(release)} --exclude=.git --exclude=node_modules --exclude=./.github --exclude=./opscrew .`,
      ]),
      `- uses: ${ACTIONS.uploadArtifact}`,
      "  with:",
      `    name: ${RELEASE_ARTIFACT}`,
      "    path: ${{ runner.temp }}/release.tar",
      "    if-no-files-found: error",
      "    retention-days: 1",
    ],
  });
}

/** The step that gets the build's release tar ({@link RELEASE_ARTIFACT}) into the runner's temp folder. */
export const DOWNLOAD_RELEASE = [
  `- uses: ${ACTIONS.downloadArtifact}`,
  "  with:",
  `    name: ${RELEASE_ARTIFACT}`,
  "    path: ${{ runner.temp }}",
];

/**
 * The app's hostname, for the workflow of an app on `where` (`a hosting account`).
 * @throws OpsCrewError `INVALID_INPUT` for a promoted environment, as each environment builds its
 * own release; `INTERNAL` without a hostname.
 */
export function hostingDomain(plan: DeployPlan, where: string): string {
  if (promoted(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `An app on ${where} cannot be promoted: each environment builds its own release.`,
      {
        hint: `Set environment.deploySource to { from: main } in the environment's plan, then run \`${provisionCommand(plan)}\` again.`,
      },
    );
  }
  const domain = plan.dns.domain;
  if (domain === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew rendered the workflow of an app on ${where} without the app's hostname.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  return domain;
}

/**
 * A hosting workflow's file at `cicd.workflowPath`: its start with the `header` comment lines, on
 * each push to the deploy branch and by hand, the `paused` job, the build job
 * ({@link releaseBuildJob}), then `jobs`.
 */
export function hostingWorkflowFile(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "otherAppDirs">,
  header: readonly string[],
  target: HostingDeployTarget,
  jobs: readonly (readonly string[])[],
): RenderedFile {
  const lines = [
    ...workflowStart(plan, header, pushPaths(plan, [], ctx), DISPATCH_BY_HAND),
    ...pausedJob(plan),
    "",
    ...releaseBuildJob(plan, target),
    "",
    ...jobs.flatMap((one) => [...one, ""]),
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}

/**
 * The publish step's script: the release tree from the build's tar goes into an orphan commit
 * through a temporary index (`git add --force`, so the app's `.gitignore` can't drop `vendor/` or
 * `dist/`), signed over `<tree id> <run id> <attempt> <env>` with `openssl dgst -sha256 -sign` and
 * the key written to a 0600 temporary file, removed right after; the signature, base64 on one
 * line, goes into the `OpsCrew-Release: <run id> <attempt> <env> <signature>` trailer. A shallow fetch of the previous release
 * (none on the first) lets the force-push send only the files that changed.
 */
function publishScript(plan: DeployPlan): string[] {
  return [
    "set -euo pipefail",
    'if [[ -z "$SIGNING_KEY" ]]; then',
    `  echo "::error::The deploy environment has no release signing key (${deploySecretName(plan, RELEASE_SIGNING_KEY_SECRET)}): run \\\`${provisionCommand(plan)}\\\`, which sets it."`,
    "  exit 1",
    "fi",
    'release="$RUNNER_TEMP/release"',
    'mkdir -p "$release"',
    'tar -xf "$RUNNER_TEMP/release.tar" -C "$release"',
    'git init -q --bare "$RUNNER_TEMP/release.git"',
    'export GIT_DIR="$RUNNER_TEMP/release.git" GIT_WORK_TREE="$release" GIT_INDEX_FILE="$RUNNER_TEMP/release.index"',
    'remote="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"',
    'auth="$(printf \'x-access-token:%s\' "$TOKEN" | base64 -w0)"',
    'echo "::add-mask::$auth"',
    'git config "http.$GITHUB_SERVER_URL/.extraheader" "AUTHORIZATION: basic $auth"',
    "found=0",
    'git ls-remote --exit-code "$remote" "refs/heads/$BRANCH" > /dev/null || found=$?',
    'if [[ "$found" -eq 0 ]]; then',
    '  git fetch -q --depth=1 --no-tags "$remote" "+refs/heads/$BRANCH:refs/remotes/origin/release"',
    'elif [[ "$found" -ne 2 ]]; then',
    '  echo "::error::GitHub did not answer whether $BRANCH exists; re-run the workflow."',
    "  exit 1",
    "fi",
    "# No attribute of the app's .gitattributes may rewrite a file: the release is kept byte for byte.",
    "printf '* -text -eol -filter -ident\\n' > \"$GIT_DIR/info/attributes\"",
    "git add --force --all .",
    'tree="$(git write-tree)"',
    "# mktemp makes the file 0600, the runner's user's only.",
    'key="$(mktemp)"',
    "trap 'rm -f \"$key\"' EXIT",
    'printf \'%s\\n\' "$SIGNING_KEY" > "$key"',
    'signature="$(printf \'%s\' "$tree $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $ENVIRONMENT" | openssl dgst -sha256 -sign "$key" | base64 -w0)"',
    'rm -f "$key"',
    'commit="$(git commit-tree "$tree" \\',
    '  -m "OpsCrew release of ${GITHUB_SHA:0:7} for $ENVIRONMENT" \\',
    '  -m "Built by $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID from $GITHUB_SHA." \\',
    '  -m "OpsCrew-Release: $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $ENVIRONMENT $signature")"',
    'git push -q --force "$remote" "$commit:refs/heads/$BRANCH"',
    'echo "release=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"',
    'echo "::notice::Published release $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT on $BRANCH; the account deploys it within about a minute."',
  ];
}

/**
 * The wait for the account to serve the release the publish job made: 40 tries of up to 5 seconds,
 * 10 seconds apart, about 10 minutes.
 */
function waitScript(plan: DeployPlan): string[] {
  return [
    "set -uo pipefail",
    "for attempt in $(seq 1 40); do",
    "  # Served only by a 2xx or 3xx answer with the release, as the agent's health check keeps it;",
    "  # awk reads to the end, so no writer in the pipe breaks; || true makes a failed curl a retry.",
    '  served="$(curl -sS --max-time 5 -o /dev/null -D - "$URL" 2> /dev/null | tr -d \'\\r\' | awk \'/^HTTP\\// { ok = $2 ~ /^[23][0-9][0-9]$/ } ok && !found && tolower($0) ~ /^x-opscrew-release:/ { sub(/^[^:]*: */, ""); print; found = 1 }\' || true)"',
    '  if [[ "$served" == "$RELEASE" ]]; then',
    '    echo "The account serves release $RELEASE."',
    "    exit 0",
    "  fi",
    "  sleep 10",
    "done",
    `echo "::error::The account didn't switch to this release: run \\\`${opscrew(plan, "status")}\\\` to see why."`,
    "exit 1",
  ];
}

/**
 * `cicd.workflowPath` for an app on a hosting account with a panel (ADR 0030 D4): on each push to
 * the deploy branch, and by hand. The build job builds the release ({@link buildSteps}) with
 * `contents: read` and keeps it as a tar; the publish job, in the deploy environment and the only
 * one with `contents: write`, signs it and force-pushes it to {@link releaseBranch}
 * ({@link publishScript}); the wait job waits up to 10 minutes for the app's health path on the
 * hostname to answer 2xx or 3xx with the published release's `X-OpsCrew-Release`
 * (`<run id>-<attempt>`), which the agent on the account sets once it has switched to it. While the
 * environment's deploys are paused (ADR 0023), the publish job is skipped and the `paused` job says
 * why.
 * @throws OpsCrewError `INVALID_INPUT` for a promoted environment or a PHP version OpsCrew has no
 * image of; `PHASE_PRECONDITION` for any target but a hosting account with a panel.
 */
export function renderHostingWorkflow(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "otherAppDirs"> = {},
): RenderedFile {
  const target = plan.target;
  if (!isHostingTarget(target) || target.panel === "sftp") {
    throw wrongTarget("This step only applies to an app on a hosting account with a panel.");
  }
  const domain = hostingDomain(plan, "a hosting account");
  const env = environmentName(plan);
  const branch = releaseBranch(plan);
  const environment = githubEnvironment(plan);
  const publish = job({
    id: "publish",
    name: `Publish the release on ${branch}`,
    needs: "build",
    if: `\${{ ${unpaused(plan)} }}`,
    ...(environment === undefined ? {} : { environment }),
    permissions: ["contents: write"],
    outputs: ["release: ${{ steps.publish.outputs.release }}"],
    steps: [
      ...DOWNLOAD_RELEASE,
      "- id: publish",
      "  name: Sign the release and push it",
      "  env:",
      `    ENVIRONMENT: ${env}`,
      `    BRANCH: ${branch}`,
      `    SIGNING_KEY: ${secret(plan, RELEASE_SIGNING_KEY_SECRET)}`,
      "    TOKEN: ${{ github.token }}",
      "    GIT_AUTHOR_NAME: github-actions[bot]",
      "    GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com",
      "    GIT_COMMITTER_NAME: github-actions[bot]",
      "    GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com",
      ...run(publishScript(plan)),
    ],
  });
  const wait = job({
    id: "wait",
    name: `Wait for ${domain} to serve the release`,
    needs: "publish",
    permissions: [],
    steps: [
      "- name: Wait for the account to switch to the release",
      // The job has one step, so the step's limit is the job's.
      "  timeout-minutes: 12",
      "  env:",
      // The path the agent's health check asks (R13: the site's root may answer otherwise).
      `    URL: https://${domain}${healthPath(plan)}`,
      // The release the publish job made, also after "Re-run failed jobs" of this job.
      "    RELEASE: ${{ needs.publish.outputs.release }}",
      ...run(waitScript(plan)),
    ],
  });
  return hostingWorkflowFile(
    plan,
    ctx,
    [
      `# Builds the app and publishes each release, signed, on the branch ${branch}. The OpsCrew agent`,
      "# on the hosting account checks the signature and deploys it; the last job waits for the account",
      "# to serve it. The signing key is the only secret here: no credential of the account is in GitHub.",
    ],
    target,
    [publish, wait],
  );
}
