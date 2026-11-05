// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, type Previews, previewWorkflowPathFor } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";
import { buildJob, buildReads } from "./build";
import { checkSshPort, sshKeySetup, sshOptsLine } from "./index";
import { pushPaths } from "./paths";
import { previewImagesScript } from "./preview-images";
import {
  block,
  CHECK_IMAGE,
  DEPLOY_SECRETS,
  githubEnvironment,
  healthPath,
  job,
  opscrew,
  planFilePath,
  provisionCommand,
  run,
  secret,
} from "./shared";

/**
 * A pull request that may get a preview: from a branch of this repository, not Dependabot's
 * (research R1.1: forks' and Dependabot's runs get no secrets). Every job but `skipped` needs it.
 */
const OWN_PULL =
  "github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'";

/** A pull request that is open and ready for review: its preview is built and started. */
const READY = `${OWN_PULL} && github.event.action != 'closed' && !github.event.pull_request.draft`;

/** The pull request's number, GitHub's (digits only). */
const NUMBER = "${{ github.event.pull_request.number }}";

/** The pull request's head commit, which the preview's comment and `previews.log` show. */
const HEAD_COMMIT = "${{ github.event.pull_request.head.sha }}";

/** The plan's previews (`environment.previews`); throws for a plan without them. */
function previewsOf(plan: DeployPlan): Previews {
  const previews = plan.environment?.previews;
  if (previews === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew rendered a preview workflow for ${planFilePath(plan)}, which has no previews.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  return previews;
}

/**
 * The preview workflow of the plan's app: `.github/workflows/opscrew-preview.yml`, or a further
 * app's `opscrew-preview-<key>.yml`.
 */
export function previewWorkflowPath(plan: Pick<DeployPlan, "app">): string {
  return previewWorkflowPathFor(plan.app.key);
}

/** Escapes `text` for bash's double quotes, leaving `$name` references to expand. */
function quoted(text: string): string {
  return `"${text.replace(/[\\"`]/g, (c) => `\\${c}`)}"`;
}

/**
 * Reads the server's answer (`$out`, `$code`) as contracts/opscrew-preview.md gives it: only the
 * last line, `opscrew-preview: <state> <detail>`, with its exit code and a detail of that state's
 * form, sets `state` and `detail`: for `up` one of `running`, `seed-failed` (this preview's
 * address), `refused`, `cap`, `failed` and `busy`; for `down` `removed` (this preview's number),
 * `refused` and `busy`. SSH's own failure (255) is `unreachable`, anything else `error`. Nothing
 * else the server printed is used or shown.
 */
function readAnswer(previews: Previews, request: "up" | "down"): string[] {
  const refused = "2 refused (request|number|image|commit|token|command)|6 busy [0-9]{1,6}";
  const exact =
    request === "up"
      ? '"$answer" == "0 running $site" || "$answer" == "5 seed-failed $site"'
      : '"$answer" == "0 removed $NUMBER"';
  return [
    "state=error",
    "detail=",
    "last=\"${out##*$'\\n'}\"",
    request === "up"
      ? `known='^(${refused}|3 cap [0-9]{1,2}/[0-9]{1,2}|4 failed (pull|release|start|health|edge))$'`
      : `known='^(${refused})$'`,
    'if [[ "$code" -eq 255 ]]; then',
    "  state=unreachable",
    "elif [[ \"$last\" == 'opscrew-preview: '* ]]; then",
    '  answer="$code ${last#opscrew-preview: }"',
    ...(request === "up" ? [`  site="pr-$NUMBER.${previews.domain}"`] : []),
    `  if [[ ${exact} || "$answer" =~ $known ]]; then`,
    '    answer="${answer#* }"',
    '    state="${answer%% *}"',
    '    detail="${answer#* }"',
    "  fi",
    "fi",
  ];
}

/** Gives `state` and `detail` as the step's outputs, and says them in the log. */
const WRITE_ANSWER = [
  '{ echo "state=$state"; echo "detail=$detail"; } >> "$GITHUB_OUTPUT"',
  'echo "The preview server answered: $state $detail"',
];

/** How long the deploy waits for the preview's address to answer: its first certificate. */
const HEALTH_SECONDS = 180;

/**
 * The `deploy` job, holding only `contents: read` and `packages: read` (its token goes to the
 * server, which pulls the image with it): in the preview environment's GitHub environment (when its
 * secrets live in one) with the preview's address as its `url`, it sends `up <n> <digest> <head
 * commit>` through the preview key with the token on stdin, reads the answer
 * ({@link readAnswer}), then checks the preview's health path from outside for up to 3 minutes.
 * Its outputs `state` and `detail` are the answer's (or `unanswered` when the address never
 * answered); it fails unless the preview runs.
 */
function deployJob(plan: DeployPlan, previews: Previews, ctx: RenderContext): string[] {
  const environment = githubEnvironment(plan);
  return job({
    id: "deploy",
    name: "Start or update the preview",
    needs: "build",
    if: `\${{ ${READY} }}`,
    // The preview's address, which GitHub shows as the pull request's "View deployment".
    ...(environment === undefined
      ? {}
      : { environment: { name: environment, url: `https://pr-${NUMBER}.${previews.domain}` } }),
    permissions: ["contents: read", "packages: read"],
    outputs: ["state: ${{ steps.up.outputs.state }}", "detail: ${{ steps.up.outputs.detail }}"],
    steps: [
      ...sshKeySetup(plan, false),
      "- id: up",
      "  name: Ask the preview server to start or update the preview",
      "  env:",
      `    HOST: ${secret(plan, DEPLOY_SECRETS.host)}`,
      "    IMAGE: ${{ needs.build.outputs.image }}",
      `    NUMBER: ${NUMBER}`,
      `    COMMIT: ${HEAD_COMMIT}`,
      `    URL: https://pr-${NUMBER}.${previews.domain}${healthPath(plan)}`,
      "    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      ...run([
        "set -uo pipefail",
        ...CHECK_IMAGE,
        sshOptsLine(ctx.sshPort, false, false),
        "code=0",
        "# The registry token goes on stdin, never in a command line; the server keeps it only while",
        "# up runs. The server's answer is read, never shown.",
        `out="$(printf '%s\\n' "$REGISTRY_TOKEN" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "up $NUMBER $IMAGE $COMMIT")" || code=$?`,
        "unset REGISTRY_TOKEN",
        ...readAnswer(previews, "up"),
        'if [[ "$state" == running || "$state" == seed-failed ]]; then',
        `  deadline=$((SECONDS + ${HEALTH_SECONDS}))`,
        '  until curl -fsS --max-time 10 -o /dev/null "$URL"; do',
        "    if (( SECONDS >= deadline )); then",
        "      state=unanswered",
        "      detail=",
        "      break",
        "    fi",
        "    sleep 6",
        "  done",
        "fi",
        ...WRITE_ANSWER,
      ]),
      "- name: Stop unless the preview runs",
      "  if: steps.up.outputs.state != 'running' && steps.up.outputs.state != 'seed-failed'",
      "  env:",
      "    STATE: ${{ steps.up.outputs.state }}",
      ...run([
        'echo "::error::The preview did not start ($STATE); the pull request\'s comment says why."',
        "exit 1",
      ]),
    ],
  });
}

/**
 * The script that writes the pull request's comment, found by its marker
 * (`<!-- opscrew-preview:<app> -->`) among the job token's own comments and edited in place, or
 * with `create` created when there is none. Its text is chosen by `$STATE` only, from this fixed
 * table; `$DETAIL` picks a fixed phrase, and only a cap's `<count>/<cap>` is written as it is,
 * after its check. Anything unknown gets the table's last text. Never a log line or a value.
 */
function commentScript(plan: DeployPlan, previews: Previews, create: boolean): string[] {
  const marker = `<!-- opscrew-preview:${plan.app.name} -->`;
  const logs = `\`${opscrew(plan, "preview logs $NUMBER")}\``;
  const list = `\`${opscrew(plan, "preview list")}\``;
  const unknown = `OpsCrew could not tell what happened to this pull request's preview: the preview server gave an answer it does not know. ${list} shows the previews; re-run this workflow to try again.`;
  const text = (line: string) => `    text=${quoted(line)} ;;`;
  return [
    "set -euo pipefail",
    `site="https://pr-$NUMBER.${previews.domain}"`,
    'commit="${COMMIT:0:12}"',
    '[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || commit=unknown',
    'case "$STATE" in',
    "  running)",
    text("The preview of this pull request runs at $site (commit `$commit`)."),
    "  seed-failed)",
    text(
      `The preview of this pull request runs at $site (commit \`$commit\`), but its seed command failed, so its data may be missing. The next push tries the seed again; ${logs} shows why it failed.`,
    ),
    "  refused)",
    '    case "$DETAIL" in',
    '      image) why="the image is not the app\'s own image the recipe allows" ;;',
    '      token) why="the registry token was missing or too long" ;;',
    '      command) why="the preview key may only start, update, remove and list previews" ;;',
    '      *) why="the request did not have the form the recipe accepts" ;;',
    "    esac",
    text(
      `No preview: the preview server refused the request ($why), and nothing changed there. If this workflow file was changed, \`${provisionCommand(plan)}\` writes it again.`,
    ),
    "  cap)",
    '    if [[ "$DETAIL" =~ ^[0-9]{1,2}/[0-9]{1,2}$ ]]; then',
    `      text=${quoted(`No preview: the preview server already runs \${DETAIL%/*} previews, its limit of \${DETAIL#*/}. Close or merge another pull request that has one, or wait until one has had no push for ${previews.lifetimeDays} days, then push again. Nothing running was stopped.`)}`,
    "    else",
    `      text=${quoted(unknown)}`,
    "    fi",
    "    ;;",
    "  failed)",
    '    case "$DETAIL" in',
    '      pull) step="pulling the image" ;;',
    '      release) step="the release command" ;;',
    '      start) step="starting the app" ;;',
    '      health) step="the app\'s health check" ;;',
    '      edge) step="routing the address to the app" ;;',
    '      *) step="one of its steps" ;;',
    "    esac",
    text(
      `The preview failed at $step (commit \`$commit\`). A preview that ran before keeps its earlier version; a new one is not served. ${logs} shows the app's logs.`,
    ),
    "  busy)",
    text(
      "The preview server was busy with another request for more than 10 minutes, so nothing changed. Re-run this workflow, or push again.",
    ),
    "  unreachable)",
    text(
      `OpsCrew could not reach the preview server over SSH, so nothing changed. Check that the server runs (\`${opscrew(plan, "status")}\`), then re-run this workflow.`,
    ),
    "  unanswered)",
    text(
      `The preview started but did not answer at $site within 3 minutes; its first certificate can take longer. Re-run this workflow, or see ${logs}.`,
    ),
    "  build-failed)",
    text("No preview: the image did not build. The workflow run says why: $RUN_URL"),
    "  removed)",
    text("The preview was removed with its data: the pull request was closed or merged."),
    "  remove-failed)",
    text(
      `OpsCrew could not remove the preview: the preview server did not confirm it. The server removes it after ${previews.lifetimeDays} days without a push.`,
    ),
    "  *)",
    text(unknown),
    "esac",
    `body='${marker}'$'\\n\\n'"$text"`,
    `ids="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$NUMBER/comments" --jq ${JSON.stringify(`.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${marker}"))) | .id`)})"`,
    "id=\"${ids%%$'\\n'*}\"",
    'if [[ -n "$id" ]]; then',
    '  gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" > /dev/null',
    ...(create
      ? [
          "else",
          '  gh api "repos/$GITHUB_REPOSITORY/issues/$NUMBER/comments" -f body="$body" > /dev/null',
        ]
      : []),
    "fi",
  ];
}

/**
 * The step that deletes pull requests' images ({@link previewImagesScript}), with `running` as its
 * `RUNNING` line (none: the pull request is closed); `always` runs it after a failed step too.
 */
function imagesStep(plan: DeployPlan, running: string[], always: boolean): string[] {
  return [
    "- name: Delete the images of pull requests no longer open",
    ...(always ? ["  if: ${{ !cancelled() }}"] : []),
    "  shell: node {0}",
    "  env:",
    "    TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    `    NUMBER: ${NUMBER}`,
    ...running,
    "  run: |",
    ...block([...previewImagesScript(plan).split("\n"), "main();"], 4),
  ];
}

/** The env lines of a comment step: its token, the pull request, `STATE` and `DETAIL`. */
function commentEnv(state: string, detail: string): string[] {
  return [
    "  env:",
    "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    `    NUMBER: ${NUMBER}`,
    `    COMMIT: ${HEAD_COMMIT}`,
    `    STATE: ${state}`,
    `    DETAIL: ${detail}`,
  ];
}

/**
 * The `report` job, after `deploy` however it ended (not when the run was cancelled), with
 * `pull-requests: write` and `packages: write`: the comment from `deploy`'s state (or
 * `build-failed`), then the images of pull requests no longer open, and this one's other than the
 * one its preview now runs.
 */
function reportJob(plan: DeployPlan, previews: Previews): string[] {
  const runs =
    "needs.deploy.outputs.state == 'running' || needs.deploy.outputs.state == 'seed-failed'";
  return job({
    id: "report",
    name: "Report on the pull request",
    needs: ["build", "deploy"],
    if: `\${{ !cancelled() && ${READY} }}`,
    permissions: ["packages: write", "pull-requests: write"],
    steps: [
      "- name: Update the preview's comment",
      ...commentEnv(
        "${{ needs.deploy.outputs.state || (needs.build.result == 'failure' && 'build-failed') || 'error' }}",
        "${{ needs.deploy.outputs.detail }}",
      ),
      "    RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      ...run(commentScript(plan, previews, true)),
      ...imagesStep(
        plan,
        [`    RUNNING: \${{ (${runs}) && needs.build.outputs.image || '' }}`],
        false,
      ),
    ],
  });
}

/**
 * The `remove` job, when the pull request is closed or merged, with `deployments: write`,
 * `packages: write` and `pull-requests: write`: in the preview environment's GitHub environment
 * without a deployment (`deployment: false`, for its secrets), it sends `down <n>` through the
 * preview key ({@link readAnswer}), marks the pull request's deployments `inactive` (so its "View
 * deployment" goes), deletes its images and those of pull requests no longer open, and updates
 * the comment when there is one; it fails unless the server confirmed the removal.
 */
function removeJob(plan: DeployPlan, previews: Previews, ctx: RenderContext): string[] {
  const environment = githubEnvironment(plan);
  return job({
    id: "remove",
    name: "Remove the preview",
    if: `\${{ ${OWN_PULL} && github.event.action == 'closed' }}`,
    // For its secrets only: no deployment of its own.
    ...(environment === undefined ? {} : { environment: { name: environment, deployment: false } }),
    permissions: ["deployments: write", "packages: write", "pull-requests: write"],
    steps: [
      ...sshKeySetup(plan, false),
      "- id: down",
      "  name: Ask the preview server to remove the preview",
      "  env:",
      `    HOST: ${secret(plan, DEPLOY_SECRETS.host)}`,
      `    NUMBER: ${NUMBER}`,
      ...run([
        "set -uo pipefail",
        sshOptsLine(ctx.sshPort, false, false),
        "code=0",
        `out="$(ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "down $NUMBER" < /dev/null)" || code=$?`,
        ...readAnswer(previews, "down"),
        ...WRITE_ANSWER,
      ]),
      ...(environment === undefined
        ? []
        : [
            "- name: Mark the pull request's deployments inactive",
            "  env:",
            "    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
            "    HEAD_REF: ${{ github.head_ref }}",
            ...run([
              "set -euo pipefail",
              `ids="$(gh api --method GET --paginate "repos/$GITHUB_REPOSITORY/deployments" -f environment=${environment} -f ref="$HEAD_REF" --jq '.[].id')"`,
              "for id in $ids; do",
              '  gh api "repos/$GITHUB_REPOSITORY/deployments/$id/statuses" -f state=inactive > /dev/null',
              "done",
            ]),
          ]),
      ...imagesStep(plan, [], true),
      "- name: Update the preview's comment",
      "  if: ${{ !cancelled() }}",
      ...commentEnv(
        "${{ steps.down.outputs.state == 'removed' && 'removed' || 'remove-failed' }}",
        "''",
      ),
      ...run(commentScript(plan, previews, false)),
      "- name: Stop unless the preview was removed",
      "  if: steps.down.outputs.state != 'removed'",
      "  env:",
      "    STATE: ${{ steps.down.outputs.state }}",
      ...run([
        'echo "::error::The preview server did not confirm the removal ($STATE); it removes the preview once it has been idle for its lifetime."',
        "exit 1",
      ]),
    ],
  });
}

/**
 * For a pull request from a fork or from Dependabot, whose run gets no secrets and whose token
 * cannot comment: says in the run's summary why there is no preview.
 */
function skippedJob(): string[] {
  return job({
    id: "skipped",
    name: "Say why there is no preview",
    if: `\${{ !(${OWN_PULL}) && github.event.action != 'closed' }}`,
    permissions: [],
    steps: [
      "- name: Say why there is no preview",
      ...run([
        "set -euo pipefail",
        'echo "No preview for this pull request: OpsCrew makes previews only of pull requests from branches of this repository, never from forks or Dependabot, whose runs get no secrets." >> "$GITHUB_STEP_SUMMARY"',
      ]),
    ],
  });
}

/**
 * `.github/workflows/opscrew-preview[-<app key>].yml` ({@link previewWorkflowPath}) for a preview
 * environment's plan (`environment.previews`, ADR 0026), as plan.md "4." gives it:
 * - `pull_request` (opened, synchronize, reopened, ready_for_review, closed) with the app's path
 *   filter ({@link pushPaths}, over what the build reads and this file), never
 *   `pull_request_target`; top-level `contents: read`; one concurrency group per pull request
 *   that cancels the run in progress.
 * - Every job only for a pull request from a branch of this repository and not Dependabot's;
 *   `skipped` says why in the summary for the others. Drafts wait until ready for review.
 * - `build` ({@link buildJob} in the preview mode: `pr-<n>-<commit>`), `deploy` (the token sent to
 *   the server may only read packages), `report` (the comment and the image cleanup) and, on close
 *   or merge, `remove`, each with only its own permissions, on `ubuntu-latest` (`build` on an arm64
 *   runner for an arm64 server).
 * - The comment's text comes only from the server's answer's state and detail, through a fixed
 *   table; never container output or a value.
 * @throws OpsCrewError `INTERNAL` for a plan without previews; Error for an invalid `ctx.sshPort`.
 */
export function renderPreviewWorkflow(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  const previews = previewsOf(plan);
  checkSshPort(ctx.sshPort);
  const path = previewWorkflowPath(plan);
  const key = plan.app.key;
  const paths = pushPaths(
    { ...plan, cicd: { ...plan.cicd, workflowPath: path } },
    buildReads(plan),
    ctx,
  );
  const lines = [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`${provisionCommand(plan)}\` regenerates it.`,
    "# Builds each pull request from a branch of this repository on GitHub's machines and asks the",
    `# preview server to start, update or remove its preview at pr-<number>.${previews.domain}. The server`,
    "# holds the recipe you approved and refuses anything outside it; the key this workflow has can do",
    "# nothing else there. Secrets are set by `opscrew provision`; their values never appear here.",
    `name: OpsCrew preview${key === undefined ? "" : ` ${key}`}`,
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened, ready_for_review, closed]",
    "    # A pull request gets a preview only when it changes one of these paths, which the build reads.",
    "    paths:",
    ...paths.map((p) => `      - ${JSON.stringify(p)}`),
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    `  group: opscrew-preview${key === undefined ? "" : `-${key}`}-${NUMBER}`,
    "  cancel-in-progress: true",
    "",
    "jobs:",
    ...skippedJob(),
    "",
    ...buildJob(plan, `\${{ ${READY} }}`),
    "",
    ...deployJob(plan, previews, ctx),
    "",
    ...reportJob(plan, previews),
    "",
    ...removeJob(plan, previews, ctx),
    "",
  ];
  return { path, content: lines.join("\n"), kind: "workflow" };
}
