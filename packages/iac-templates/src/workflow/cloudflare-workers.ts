// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { ACTIONS, TOOLS } from "../pins";
import { shellQuote } from "../runtime/services";
import { HEADERS_ENTRY, headersProgram } from "../serverless/headers";
import {
  answerCheck,
  cloudflareDir,
  SITE_ARTIFACT,
  type SiteFiles,
  siteBuildSteps,
  siteEnvSecret,
  siteExists,
  siteFiles,
  siteUrl,
  workersTarget,
} from "../serverless/site";
import { wranglerConfigPath } from "../serverless/wrangler";
import type { RenderContext, RenderedFile } from "../types";
import { pushPaths, siteReads } from "./paths";
import {
  appFlag,
  block,
  builderBranchOf,
  deploySecretName,
  environmentName,
  githubEnvironment,
  job,
  promoteCommand,
  promoted,
  run,
  secret,
  workflowStart,
} from "./shared";

/**
 * The GitHub Actions secrets of a Cloudflare hosting target's deploy job (before
 * `deploySecretName`): the deploy token, which holds only Account → Workers Scripts → Edit, and
 * the account id. `opscrew provision` sets them; the build reads the app's variables
 * ({@link siteEnvSecret}).
 */
export const CLOUDFLARE_DEPLOY_SECRETS = {
  apiToken: "OPSCREW_CLOUDFLARE_API_TOKEN",
  accountId: "OPSCREW_CLOUDFLARE_ACCOUNT_ID",
} as const;

/** The files a version may have on Cloudflare's free plan. */
const FREE_PLAN_FILES = 20_000;

/** Where the deploy job writes the app's secrets for the new version (bash, then Actions syntax). */
const SECRETS_FILE = "$RUNNER_TEMP/opscrew-secrets.json";
const SECRETS_FILE_INPUT = "${{ runner.temp }}/opscrew-secrets.json";

/** Wrangler's own folder, apart from the site's packages (bash, then Actions syntax). */
const WRANGLER_DIR = "$RUNNER_TEMP/wrangler";
const WRANGLER_DIR_INPUT = "${{ runner.temp }}/wrangler";

/**
 * The build as the artifact holds it (bash, then Actions syntax): the site's static files in
 * `assets/` and, for server rendering, the Worker bundled with its packages in `worker/`. The build
 * job gathers it there, and the deploy job downloads it there.
 */
const SITE_DIR = "$RUNNER_TEMP/opscrew-site";
const SITE_DIR_INPUT = "${{ runner.temp }}/opscrew-site";

/** The bundled Worker in the artifact: Wrangler names it after the config's `main`. */
const WORKER_BUNDLE = `worker/${HEADERS_ENTRY}`;

/** The build's SHA-256, run in {@link SITE_DIR}: of the sorted `<sha256>  <path>` lines, one per file. */
const MANIFEST =
  "find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1";

/**
 * A step of the pinned Wrangler through its action, with the environment's committed config, run
 * in {@link WRANGLER_DIR}; with `credentials`, the deploy token and the account id.
 */
function wranglerStep(
  plan: DeployPlan,
  step: { id: string; name: string; command: string; if?: string },
  credentials: boolean,
): string[] {
  return [
    `- id: ${step.id}`,
    `  name: ${step.name}`,
    ...(step.if === undefined ? [] : [`  if: ${step.if}`]),
    `  uses: ${ACTIONS.wranglerAction}`,
    "  with:",
    ...(credentials
      ? [
          `    apiToken: ${secret(plan, CLOUDFLARE_DEPLOY_SECRETS.apiToken)}`,
          `    accountId: ${secret(plan, CLOUDFLARE_DEPLOY_SECRETS.accountId)}`,
        ]
      : []),
    `    wranglerVersion: ${JSON.stringify(TOOLS.wrangler.version)}`,
    `    workingDirectory: ${WRANGLER_DIR_INPUT}`,
    `    command: ${step.command} --config \${{ github.workspace }}/${wranglerConfigPath(plan)}`,
  ];
}

/**
 * The step that makes {@link WRANGLER_DIR}, where the action installs Wrangler apart from the
 * site's packages (npm would otherwise install it into the nearest package.json, the site's), with
 * `env` lines and more script `lines`.
 */
function prepareWrangler(env: readonly string[], lines: readonly string[]): string[] {
  return [
    "- name: Prepare Wrangler",
    ...(env.length === 0 ? [] : ["  env:", ...env]),
    ...run([
      "set -euo pipefail",
      "# Wrangler is installed in a folder of its own, apart from the site's packages.",
      `mkdir -p "${WRANGLER_DIR}"`,
      `printf '{"private": true}\\n' > "${WRANGLER_DIR}/package.json"`,
      ...lines,
    ]),
  ];
}

/**
 * The build job: the site's build ({@link siteBuildSteps}, with `WORKERS_CI=1` as Cloudflare's own
 * builds have it, so SvelteKit builds for Workers and not for Pages) and the check against the
 * free plan's 20,000 files per version. For server rendering, Wrangler then bundles the Worker
 * (the headers wrapper around the adapter's module) with the site's packages, which only this job
 * has, into the artifact (`wrangler deploy --dry-run --outdir`). Then the static files are copied
 * next to it, and the build's SHA-256 (output `sha256`, {@link MANIFEST}) covers exactly what the
 * deploy uploads: the artifact {@link SITE_ARTIFACT}, hidden files (`.assetsignore`) included.
 */
function buildJob(plan: DeployPlan, files: SiteFiles): string[] {
  const ssr = files.entry !== undefined;
  return job({
    id: "build",
    name: "Build the site",
    permissions: ["contents: read"],
    outputs: ["sha256: ${{ steps.manifest.outputs.sha256 }}"],
    steps: [
      ...siteBuildSteps(plan, [["WORKERS_CI", '"1"']]),
      "- name: Check the site against Cloudflare's limits",
      ...run([
        "set -euo pipefail",
        ...siteExists(plan, files),
        `files="$(find ${shellQuote(files.assets)} -type f -printf . | wc -c)"`,
        `if [[ "$files" -gt ${FREE_PLAN_FILES} ]]; then`,
        `  echo "::error::The site has $files files in ${files.assets}, over the 20,000 files a version may have on Cloudflare's free plan. Leave out the files the site does not need, then push again."`,
        "  exit 1",
        "fi",
      ]),
      ...(ssr
        ? [
            ...prepareWrangler([], []),
            ...wranglerStep(
              plan,
              {
                id: "bundle",
                name: "Bundle the Worker with its packages",
                command: `deploy --dry-run --outdir ${SITE_DIR_INPUT}/worker`,
              },
              false,
            ),
          ]
        : []),
      "- id: manifest",
      "  name: Record the build's SHA-256",
      ...run([
        "set -euo pipefail",
        `mkdir -p "${SITE_DIR}/assets"`,
        "# Links are copied as the files they name, as the artifact's upload sends them.",
        `cp -RL ${shellQuote(files.assets)}/. "${SITE_DIR}/assets/"`,
        ...(ssr
          ? [
              `if [[ ! -f "${SITE_DIR}/${WORKER_BUNDLE}" ]]; then`,
              `  echo "::error::Wrangler wrote no ${WORKER_BUNDLE}, the bundled Worker; its output above says why."`,
              "  exit 1",
              "fi",
            ]
          : []),
        `cd "${SITE_DIR}"`,
        `sha256="$(${MANIFEST})"`,
        'echo "sha256=$sha256" >> "$GITHUB_OUTPUT"',
        'echo "Built the site with the SHA-256 \\`$sha256\\`." >> "$GITHUB_STEP_SUMMARY"',
      ]),
      "- name: Keep the built site for the deploy",
      `  uses: ${ACTIONS.uploadArtifact}`,
      "  with:",
      `    name: ${SITE_ARTIFACT}`,
      `    path: ${SITE_DIR_INPUT}`,
      "    include-hidden-files: true",
      "    if-no-files-found: error",
    ],
  });
}

/**
 * A bash function `api <path>` that asks Cloudflare's API for `<path>` under the Worker `worker`
 * with the deploy token and prints the answer. The token goes to curl in a file only the runner
 * user can read, never on its command line or in the log.
 */
function apiFunction(worker: string): string[] {
  return [
    "api() {",
    '  local headers="$RUNNER_TEMP/opscrew-cloudflare-headers" code=0',
    '  (umask 077 && printf \'Authorization: Bearer %s\\n\' "$CLOUDFLARE_API_TOKEN" > "$headers")',
    `  curl -fsS --max-time 30 -H @"$headers" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/${worker}/$1" || code=$?`,
    '  rm -f "$headers"',
    '  return "$code"',
    "}",
  ];
}

/** How many times, 5 s apart, the activation tries while Cloudflare answers 100146 (2 minutes). */
const ACTIVATE_ATTEMPTS = 24;

/**
 * The step `activate`: `wrangler versions deploy <new id>@100` with the Wrangler the upload
 * installed in {@link WRANGLER_DIR}, and the deploy token and account id from `env` (the job's
 * `apiEnv` lines). Cloudflare can answer 100146 ("version could not be found") for a version it
 * created seconds before, even after it has read it, so on that error the step tries again every
 * 5 s for up to 2 minutes; any other error fails it at once.
 */
function activateStep(plan: DeployPlan, env: readonly string[]): string[] {
  return [
    "- id: activate",
    "  name: Activate the new version",
    ...env,
    "    VERSION: ${{ steps.version.outputs.id }}",
    ...run([
      "set -uo pipefail",
      `cd "${WRANGLER_DIR}"`,
      `for attempt in $(seq 1 ${ACTIVATE_ATTEMPTS}); do`,
      `  if output="$(npx --no-install wrangler versions deploy "$VERSION@100" -y --config "$GITHUB_WORKSPACE"/${shellQuote(wranglerConfigPath(plan))} 2>&1)"; then`,
      "    printf '%s\\n' \"$output\"",
      "    exit 0",
      "  fi",
      "  printf '%s\\n' \"$output\"",
      "  if ! grep -q 'code: 100146' <<< \"$output\"; then",
      '    echo "::error::Wrangler could not activate the new version $VERSION; its output above says why."',
      "    exit 1",
      "  fi",
      `  if [[ "$attempt" -lt ${ACTIVATE_ATTEMPTS} ]]; then`,
      '    echo "Cloudflare does not find the new version yet; trying again in 5 s."',
      "    sleep 5",
      "  fi",
      "done",
      'echo "::error::Cloudflare did not find the new version $VERSION within 2 minutes, so OpsCrew could not activate it. Run the workflow again."',
      "exit 1",
    ]),
  ];
}

/**
 * A promoted environment's trigger: `opscrew promote` dispatches the workflow with the run that
 * built the site the source environment runs, and that build's SHA-256.
 */
const DISPATCH_WITH_BUILD = [
  "  workflow_dispatch:",
  "    inputs:",
  "      run:",
  "        description: The workflow run that built the site to deploy, by its id; `opscrew promote` fills it in.",
  "        required: true",
  "        type: string",
  "      sha256:",
  "        description: The SHA-256 of that build; `opscrew promote` fills it in.",
  "        required: true",
  "        type: string",
];

/**
 * The workflow path of the environment that builds the sites the promoted environment `plan` is
 * promoted with (`ctx.builderWorkflowPath`).
 * @throws OpsCrewError `INTERNAL` when the render was given none.
 */
function builderWorkflowPathOf(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderWorkflowPath">,
): string {
  if (ctx.builderWorkflowPath !== undefined) return ctx.builderWorkflowPath;
  throw new OpsCrewError(
    "INTERNAL",
    `OpsCrew rendered the workflow of the ${environmentName(plan)} environment, which is promoted, without the workflow that builds the sites it is promoted with.`,
    { hint: "This is a bug in OpsCrew; please report it." },
  );
}

/**
 * A promoted environment's first step, before anything is downloaded: the dispatch's inputs must
 * be a run id and a SHA-256, and GitHub's record of that run (read with the job's token,
 * `actions: read`) must show a successful run of the workflow that builds the sites this
 * environment is promoted with (`ctx.builderWorkflowPath`, the first of its sources that follows a
 * branch), started by a push of this repository's own commits to that environment's branch
 * (`ctx.builderBranch`). A fork's pull request runs in this repository too, and its artifact must
 * never reach this environment's secrets.
 */
function buildRunCheck(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch" | "builderWorkflowPath">,
): string[] {
  const promote = `\\\`${promoteCommand(plan)}\\\``;
  const only = "OpsCrew promotes only a site a push to $BUILD_BRANCH built with $BUILD_WORKFLOW.";
  const refuse = (condition: string, message: string) => [
    `if [[ ${condition} ]]; then`,
    `  echo "::error::${message}"`,
    "  exit 1",
    "fi",
  ];
  return [
    "- name: Check the run that built the site",
    "  env:",
    "    RUN: ${{ inputs.run }}",
    "    SHA256: ${{ inputs.sha256 }}",
    `    BUILD_BRANCH: ${JSON.stringify(builderBranchOf(plan, ctx))}`,
    `    BUILD_WORKFLOW: ${JSON.stringify(builderWorkflowPathOf(plan, ctx))}`,
    "    GH_TOKEN: ${{ github.token }}",
    ...run([
      "set -euo pipefail",
      ...refuse(
        '! "$RUN" =~ ^[0-9]+$ || ! "$SHA256" =~ ^[0-9a-f]{64}$',
        `The run input must be a workflow run's id, and sha256 a SHA-256 (64 hexadecimal digits). Start this workflow with ${promote}, which fills them in.`,
      ),
      'if ! record="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN" --jq \'"\\(.event) \\(.conclusion) \\(.head_repository.full_name) \\(.head_branch) \\(.path)"\')"; then',
      `  echo "::error::GitHub shows no run $RUN in this repository. Promote with ${promote}, which reads the build the source environment runs."`,
      "  exit 1",
      "fi",
      'read -r event conclusion head_repo branch workflow <<< "$record"',
      "# The run's path can end with @<ref>.",
      'workflow="${workflow%%@*}"',
      ...refuse('"$event" != "push"', `Run $RUN was started by a $event, not by a push. ${only}`),
      ...refuse(
        '"${head_repo,,}" != "${GITHUB_REPOSITORY,,}"',
        `Run $RUN built the commits of $head_repo, not of this repository ($GITHUB_REPOSITORY). ${only}`,
      ),
      ...refuse('"$branch" != "$BUILD_BRANCH"', `Run $RUN built the branch $branch. ${only}`),
      ...refuse(
        '"$workflow" != "$BUILD_WORKFLOW"',
        `Run $RUN is of the workflow $workflow. ${only}`,
      ),
      ...refuse(
        '"$conclusion" != "success"',
        `Run $RUN did not succeed (its conclusion is $conclusion). Promote the build the source environment runs with ${promote}.`,
      ),
    ]),
  ];
}

/**
 * The deploy job on GitHub's machines, in the environment's GitHub environment:
 * 1. the build's artifact, from this run or, for a promoted environment, from the run its
 *    dispatch names (`actions: read`), refused unless its SHA-256 is the build's; its static files
 *    are then put where the Wrangler config expects them;
 * 2. OpsCrew's headers written into `_headers` ({@link headersProgram});
 * 3. `wrangler versions upload` through the pinned action with the committed config and the
 *    message `opscrew <run id> <sha256>`, which names the build for status and promotion; for
 *    `render: ssr` it uploads the build job's bundle as it is (`--no-bundle`; Wrangler adds the
 *    bundle's other modules from its folder), with `--secrets-file`: the app's variables written
 *    from their GitHub secrets to a file only the runner user can read, removed right after, so
 *    they come with the version and have no version of their own;
 * 4. the new version's id from the action's `command-output`;
 * 5. `wrangler versions deploy <id>@100`, tried again for up to 2 minutes while Cloudflare does not
 *    find the version it just created ({@link activateStep}), then a check of the answer on the domain
 *    ({@link answerCheck}). When the activation or the check fails, the version that ran before
 *    (the latest deployment's, read before the upload) is activated again and the job fails.
 */
function deployJob(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch" | "builderWorkflowPath">,
  files: SiteFiles,
): string[] {
  const target = workersTarget(plan);
  const fromRun = promoted(plan);
  const ssr = target.render === "ssr";
  const secrets = ssr ? plan.app.env : [];
  const want = fromRun ? "${{ inputs.sha256 }}" : "${{ needs.build.outputs.sha256 }}";
  const builtBy = fromRun ? "${{ inputs.run }}" : "${{ github.run_id }}";
  const apiEnv = [
    "  env:",
    `    CLOUDFLARE_API_TOKEN: ${secret(plan, CLOUDFLARE_DEPLOY_SECRETS.apiToken)}`,
    `    CLOUDFLARE_ACCOUNT_ID: ${secret(plan, CLOUDFLARE_DEPLOY_SECRETS.accountId)}`,
  ];
  const wrangler = (id: string, name: string, command: string, condition?: string) =>
    wranglerStep(
      plan,
      { id, name, command, ...(condition === undefined ? {} : { if: condition }) },
      true,
    );
  const stored = (name: string) => deploySecretName(plan, siteEnvSecret(name));
  const values = secrets.map((variable) => `"${variable.name}": env.${stored(variable.name)}`);
  const mismatch = fromRun
    ? `The site run $RUN built has the SHA-256 $sha256, not $SHA256, the one \\\`opscrew promote\\\` asked for. Promote again with \\\`${promoteCommand(plan)}\\\`, which reads the build the source environment runs.`
    : "The downloaded site has the SHA-256 $sha256, not $SHA256, the build's. Run the workflow again.";
  const failed =
    "failure() && (steps.activate.outcome == 'failure' || steps.check.outcome == 'failure')";
  const steps = [
    `- uses: ${ACTIONS.checkout}`,
    "  with:",
    "    persist-credentials: false",
    ...(fromRun ? buildRunCheck(plan, ctx) : []),
    "- name: Download the built site",
    `  uses: ${ACTIONS.downloadArtifact}`,
    "  with:",
    `    name: ${SITE_ARTIFACT}`,
    `    path: ${SITE_DIR_INPUT}`,
    ...(fromRun ? ["    run-id: ${{ inputs.run }}", "    github-token: ${{ github.token }}"] : []),
    "- name: Check the build's SHA-256 and put the site in place",
    "  env:",
    ...(fromRun ? ["    RUN: ${{ inputs.run }}"] : []),
    `    SHA256: ${want}`,
    ...run([
      "set -euo pipefail",
      `cd "${SITE_DIR}"`,
      `sha256="$(${MANIFEST})"`,
      'if [[ "$sha256" != "$SHA256" ]]; then',
      `  echo "::error::${mismatch}"`,
      "  exit 1",
      "fi",
      'cd "$GITHUB_WORKSPACE"',
      `rm -rf -- ${shellQuote(files.assets)}`,
      `mkdir -p -- ${shellQuote(files.assets)}`,
      `cp -a "${SITE_DIR}/assets/." ${shellQuote(files.assets)}/`,
    ]),
    "- name: Add OpsCrew's security headers to _headers",
    "  shell: node {0}",
    "  env:",
    `    SITE: ${JSON.stringify(files.assets)}`,
    "  run: |",
    ...block([...headersProgram(plan).split("\n"), "main();"], 4),
    ...prepareWrangler(
      secrets.map(
        (variable) => `    ${stored(variable.name)}: ${secret(plan, siteEnvSecret(variable.name))}`,
      ),
      secrets.length === 0
        ? []
        : [
            "# The app's variables, for the new version only; the file is removed after the upload.",
            `(umask 077 && jq -n '{${values.join(", ")}}' > "${SECRETS_FILE}")`,
          ],
    ),
    "- id: previous",
    "  name: Find the version running now",
    ...apiEnv,
    ...run([
      "set -euo pipefail",
      ...apiFunction(target.worker),
      'if ! answer="$(api deployments)"; then',
      `  echo "::error::Cloudflare did not list the deployments of the Worker ${target.worker}. Check that the deploy token in ${deploySecretName(plan, CLOUDFLARE_DEPLOY_SECRETS.apiToken)} holds Account → Workers Scripts → Edit and that the Worker exists (\\\`opscrew provision${appFlag(plan)}\\\` creates it), then run the workflow again."`,
      "  exit 1",
      "fi",
      'previous="$(jq -r \'[.result.deployments[0].versions[]? | select(.percentage == 100) | .version_id][0] // empty\' <<< "$answer")"',
      'echo "id=$previous" >> "$GITHUB_OUTPUT"',
    ]),
    ...wrangler(
      "upload",
      "Upload the new version",
      [
        "versions upload",
        // The build job's bundle, as it is: the SHA-256 covers it.
        ...(ssr ? [`${SITE_DIR_INPUT}/${WORKER_BUNDLE} --no-bundle`] : []),
        `--message "opscrew ${builtBy} ${want}"`,
        ...(secrets.length === 0 ? [] : [`--secrets-file ${SECRETS_FILE_INPUT}`]),
      ].join(" "),
    ),
    ...(secrets.length === 0
      ? []
      : ["- name: Remove the secrets file", "  if: always()", ...run([`rm -f "${SECRETS_FILE}"`])]),
    "- id: version",
    "  name: Read the new version's id",
    "  env:",
    "    OUTPUT: ${{ steps.upload.outputs.command-output }}",
    ...run([
      "set -euo pipefail",
      "id=\"$(grep -oE 'Version ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<< \"$OUTPUT\" | head -n 1 | cut -d ' ' -f 3 || true)\"",
      'if [[ -z "$id" ]]; then',
      `  echo "::error::Wrangler did not report the new version's id; its output above says why. Run the workflow again."`,
      "  exit 1",
      "fi",
      'echo "id=$id" >> "$GITHUB_OUTPUT"',
    ]),
    ...activateStep(plan, apiEnv),
    "- id: check",
    "  name: Check that the new version answers",
    "  env:",
    `    URL: ${siteUrl(plan)}`,
    ...run(
      answerCheck(
        `Cloudflare has not issued the certificate for ${plan.dns.domain} yet, so this run could not check the new version over HTTPS. It usually comes within a few minutes of the custom domain; \\\`opscrew verify${appFlag(plan)}\\\` checks the site once it is there.`,
      ),
    ),
    ...wrangler(
      "rollback",
      "Activate the version that ran before again",
      "versions deploy ${{ steps.previous.outputs.id }}@100 -y",
      `${failed} && steps.previous.outputs.id != ''`,
    ),
    "- name: Report the failed deploy",
    `  if: ${failed}`,
    "  env:",
    "    PREVIOUS: ${{ steps.previous.outputs.id }}",
    "    ROLLBACK: ${{ steps.rollback.outcome }}",
    ...run([
      "set -uo pipefail",
      'case "$ROLLBACK" in',
      "  success)",
      '    echo "::error::The deploy failed; OpsCrew activated the version that ran before ($PREVIOUS) again." ;;',
      "  skipped)",
      '    echo "::error::The deploy failed, and the Worker had no earlier version to activate. Fix the problem and deploy again." ;;',
      "  *)",
      `    echo "::error::The deploy failed, and OpsCrew could not activate the version that ran before ($PREVIOUS) again. Activate it with \\\`${promoteCommand(plan)} --version $PREVIOUS\\\`." ;;`,
      "esac",
      "exit 1",
    ]),
  ];
  return job({
    id: "deploy",
    name: "Deploy to Cloudflare",
    needs: fromRun ? undefined : "build",
    environment: githubEnvironment(plan),
    permissions: fromRun ? ["actions: read", "contents: read"] : ["contents: read"],
    steps,
  });
}

/**
 * `cicd.workflowPath` for Cloudflare's hosting (`renderWorkflow` delegates here): an environment
 * that follows its branch builds the site ({@link buildJob}) and deploys it ({@link deployJob}) on
 * each push; a promoted environment builds nothing, and its dispatch (`run`, `sha256`, from
 * `opscrew promote`) names the build the source environment runs, which it deploys after checking
 * where it was built ({@link buildRunCheck}, from `ctx.builderBranch` and
 * `ctx.builderWorkflowPath`) and its SHA-256. The triggers, permissions and concurrency are as for
 * servers; the push filter ({@link pushPaths}) adds the repository root's files the build reads
 * ({@link siteReads}) and the committed Wrangler config with, for server rendering, the headers
 * wrapper it names as `main`, with `ctx.otherAppDirs` for a site at the root.
 * @throws OpsCrewError `INTERNAL` for a promoted environment rendered without either.
 */
export function renderCloudflareWorkersWorkflow(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch" | "builderWorkflowPath" | "otherAppDirs">,
): RenderedFile {
  const target = workersTarget(plan);
  const files = siteFiles(plan);
  const source = plan.environment?.deploySource;
  const about =
    source?.from === "promote"
      ? [
          `# \`${promoteCommand(plan)}\` starts this workflow with the run and SHA-256 of the build the`,
          `# ${source.source} environment runs, and it deploys exactly that build to the Worker ${target.worker}, without`,
          "# building. Secrets are set by `opscrew provision`; their values never appear in this file.",
        ]
      : [
          `# Builds the site and deploys it to Cloudflare as a new version of the Worker ${target.worker}, with`,
          "# Wrangler. Secrets are set by `opscrew provision`; their values never appear in this file.",
        ];
  const reads = [
    ...siteReads(plan),
    wranglerConfigPath(plan),
    ...(files.entry === undefined ? [] : [`${cloudflareDir(plan)}/${HEADERS_ENTRY}`]),
  ];
  const lines = [
    ...workflowStart(plan, about, pushPaths(plan, reads, ctx), DISPATCH_WITH_BUILD),
    ...(promoted(plan) ? [] : [...buildJob(plan, files), ""]),
    ...deployJob(plan, ctx, files),
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
