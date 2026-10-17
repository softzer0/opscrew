// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  PORTAINER_DEPLOY_BRANCH,
  PORTAINER_IMAGE_PLACEHOLDER,
  PORTAINER_STACK_TEMPLATE_PATH,
  PORTAINER_VERSION_HEADER,
  PORTAINER_VERSION_PLACEHOLDER,
  portainerStackName,
} from "../portainer-target/stack";
import { portainerTarget } from "../providers";
import type { RenderedFile } from "../types";
import {
  block,
  buildJob,
  CHECKOUT_ACTION,
  DIGEST_REF_PATTERN,
  deployJob,
  healthPath,
  secret,
  workflowStart,
} from "./shared";

/**
 * The GitHub Actions secrets of a Portainer target's deploy workflow in redeploy mode `cloudflare`
 * (the updater needs none): Portainer's webhook URL behind Cloudflare Access
 * (`https://<portainer hostname>/api/stacks/webhooks/<uuid>`, a secret) and the Access service
 * token (terraform outputs `deploy_service_token_client_id` and
 * `deploy_service_token_client_secret`). `opscrew provision` sets them; the build job also reads
 * `OPSCREW_BUILD_ENV`.
 */
export const PORTAINER_DEPLOY_SECRETS = {
  webhookUrl: "OPSCREW_PORTAINER_WEBHOOK_URL",
  accessClientId: "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
  accessClientSecret: "OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET",
} as const;

/**
 * Seconds between two health checks, and their number per redeploy mode: the updater asks
 * Portainer once a minute, so a new version may take that minute plus the image pull and the
 * release command; the webhook call through Cloudflare starts the redeploy at once.
 */
const HEALTH_INTERVAL = 10;
const HEALTH_ATTEMPTS = { updater: 60, cloudflare: 30 } as const;

/**
 * URL the deploy job checks for a Portainer target: the health path on the app's domain. Without a
 * domain (`proxy` mode only) there is nothing GitHub can reach, so `undefined`.
 */
export function portainerHealthUrl(plan: DeployPlan): string | undefined {
  if (plan.dns.domain === undefined) return undefined;
  return `https://${plan.dns.domain}${healthPath(plan)}`;
}

/** The commit identity of the deploy job's commits to the deploy branch. */
const GIT_IDENTITY = [
  "export GIT_AUTHOR_NAME='github-actions[bot]' GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'",
  'export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"',
];

/**
 * Writes the template with the new image as the only file of a new commit on the deploy branch
 * (an orphan history: each commit holds only `compose.yaml`, its parent the previous version), and
 * reports `previous`, `deployed` and `changed`. Nothing is written when the branch already holds
 * this version.
 */
function writeScript(branch: string): string[] {
  const template = PORTAINER_STACK_TEMPLATE_PATH;
  return [
    "set -euo pipefail",
    `if [[ ! "$IMAGE" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '  echo "::error::The build job did not report the image digest; re-run the workflow."',
    "  exit 1",
    "fi",
    `if [[ ! -f ${template} ]] || ! grep -qF ${PORTAINER_IMAGE_PLACEHOLDER} ${template}; then`,
    `  echo "::error::${template} does not mark the app's image (${PORTAINER_IMAGE_PLACEHOLDER}); run \\\`opscrew provision\\\` to write it again."`,
    "  exit 1",
    "fi",
    `template="$(cat ${template})"`,
    'digest="${IMAGE##*@sha256:}"',
    `compose="\${template//${PORTAINER_IMAGE_PLACEHOLDER}/"$IMAGE"}"`,
    `compose="\${compose//${PORTAINER_VERSION_PLACEHOLDER}/"\${digest:0:12}"}"`,
    'printf \'%s\\n\' "$compose" > "$RUNNER_TEMP/compose.yaml"',
    ...GIT_IDENTITY,
    'tree="$(printf \'100644 blob %s\\tcompose.yaml\\n\' "$(git hash-object -w "$RUNNER_TEMP/compose.yaml")" | git mktree)"',
    'previous=""',
    "parent=()",
    `remote="$(git ls-remote origin refs/heads/${branch})"`,
    'if [[ -n "$remote" ]]; then',
    `  git fetch --no-tags --depth=1 origin +refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `  previous="$(git rev-parse refs/remotes/origin/${branch})"`,
    '  parent=(-p "$previous")',
    "fi",
    'if [[ -n "$previous" && "$(git rev-parse "$previous^{tree}")" == "$tree" ]]; then',
    `  echo "The ${branch} branch already holds this version."`,
    '  echo "changed=false" >> "$GITHUB_OUTPUT"',
    "  exit 0",
    "fi",
    'deployed="$(git commit-tree "$tree" "${parent[@]}" -m "Deploy $IMAGE" -m "Built from $GITHUB_SHA by the OpsCrew deploy workflow.")"',
    `git push origin "$deployed:refs/heads/${branch}"`,
    "{",
    '  echo "previous=$previous"',
    '  echo "deployed=$deployed"',
    '  echo "changed=true"',
    '} >> "$GITHUB_OUTPUT"',
    `echo "Wrote \\\`$IMAGE\\\` to the \\\`${branch}\\\` branch." >> "$GITHUB_STEP_SUMMARY"`,
  ];
}

/**
 * Calls the webhook through Cloudflare Access and leaves the HTTP status in `code` (`000` when
 * nothing answered). The service token goes to curl in a file only the runner user can read, never
 * on its command line or in the log.
 */
const WEBHOOK_CALL = [
  'headers="$RUNNER_TEMP/access-headers"',
  '(umask 077 && printf \'CF-Access-Client-Id: %s\\nCF-Access-Client-Secret: %s\\n\' "$ACCESS_CLIENT_ID" "$ACCESS_CLIENT_SECRET" > "$headers")',
  'code="$(curl -sS --connect-timeout 20 --max-time 120 -X POST -H @"$headers" -o /dev/null -w \'%{http_code}\' "$WEBHOOK_URL" || true)"',
  'rm -f "$headers"',
];

function webhookEnv(): string[] {
  return [
    `    WEBHOOK_URL: ${secret(PORTAINER_DEPLOY_SECRETS.webhookUrl)}`,
    `    ACCESS_CLIENT_ID: ${secret(PORTAINER_DEPLOY_SECRETS.accessClientId)}`,
    `    ACCESS_CLIENT_SECRET: ${secret(PORTAINER_DEPLOY_SECRETS.accessClientSecret)}`,
  ];
}

/**
 * Waits until the site answers with the new image's version in {@link PORTAINER_VERSION_HEADER}
 * (curl 7.84 or newer reads it with `%header{}`): until then the previous version may still be
 * serving. Bounded by `attempts`.
 */
function healthScript(plan: DeployPlan, attempts: number): string[] {
  const minutes = Math.round((attempts * HEALTH_INTERVAL) / 60);
  const { web } = portainerTarget(plan.target);
  const route =
    web.mode === "proxy"
      ? ` Check also that your proxy forwards ${plan.dns.domain} to port ${web.port} of the Portainer host.`
      : "";
  const where = `Portainer shows why under Stacks → ${portainerStackName(plan)}.${route}`;
  return [
    "set -euo pipefail",
    'digest="${IMAGE##*@sha256:}"',
    'want="${digest:0:12}"',
    "state=down",
    `for attempt in $(seq 1 ${attempts}); do`,
    `  if seen="$(curl -fsS --max-time 10 -o /dev/null -w '%header{${PORTAINER_VERSION_HEADER.toLowerCase()}}' "$URL")"; then`,
    '    if [[ "$seen" == "$want" ]]; then',
    '      echo "The new version answers after $attempt attempt(s)."',
    "      exit 0",
    "    fi",
    "    state=previous",
    "  else",
    "    state=down",
    "  fi",
    `  sleep ${HEALTH_INTERVAL}`,
    "done",
    'if [[ "$state" == previous ]]; then',
    `  echo "::error::After ${minutes} minutes the site at $URL still runs the previous version: Portainer did not deploy the new one. ${where}"`,
    "else",
    `  echo "::error::The new version did not answer at $URL within ${minutes} minutes. ${where}"`,
    "fi",
    "exit 1",
  ];
}

/**
 * Asks the site once, before anything changes, whether GitHub reaches it at all: any HTTP answer
 * counts (the previous version may be down); no answer (an address only the user's network
 * resolves, a refused connection, a certificate curl does not trust) means it cannot be checked.
 */
const PROBE_SCRIPT = [
  "set -uo pipefail",
  'if curl -sS --max-time 15 -o /dev/null "$URL"; then',
  '  echo "reachable=true" >> "$GITHUB_OUTPUT"',
  "else",
  '  echo "reachable=false" >> "$GITHUB_OUTPUT"',
  "fi",
];

/** Writes the previous version back to the deploy branch (and asks Portainer to deploy it). */
function rollbackScript(branch: string, cloudflare: boolean): string[] {
  const done = cloudflare
    ? [
        ...WEBHOOK_CALL,
        'if [[ "$code" == 2[0-9][0-9] ]]; then',
        `  echo "::error::The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch and asked Portainer to deploy it."`,
        "else",
        `  echo "::error::The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, but Portainer did not confirm the redeploy (HTTP \${code:-none}). Redeploy the stack in Portainer, or run the workflow again."`,
        "fi",
      ]
    : [
        `echo "::error::The deploy failed; OpsCrew wrote the previous version back to the ${branch} branch, and Portainer's updater deploys it within about a minute."`,
      ];
  return [
    "set -uo pipefail",
    'if [[ -z "$PREVIOUS" ]]; then',
    `  echo "::error::The deploy failed and the ${branch} branch had no earlier version to restore. Fix the problem and push again."`,
    "  exit 1",
    "fi",
    ...GIT_IDENTITY,
    'if ! restored="$(git commit-tree "$PREVIOUS^{tree}" -p "$DEPLOYED" -m "Roll back to the previous version" -m "$IMAGE did not come up; OpsCrew wrote the version before it back.")" ||',
    `  ! git push origin "$restored:refs/heads/${branch}"; then`,
    `  echo "::error::The deploy failed and OpsCrew could not write the previous version back to the ${branch} branch. Write the compose.yaml of the commit before the newest one back to that branch by hand."`,
    "  exit 1",
    "fi",
    ...done,
    "exit 1",
  ];
}

/** Indents `script` as the body of a step's `run: |`. */
function run(script: readonly string[]): string[] {
  return ["  run: |", ...block(script, 4)];
}

/**
 * The deploy workflow of a Portainer target (`renderWorkflow` delegates here): the same build job
 * as other targets, then a deploy job with `contents: write` (only for the deploy branch) that
 * writes the stack file with the new image to `opscrew-deploy`, calls Portainer's webhook through
 * Cloudflare Access in redeploy mode `cloudflare`, waits (bounded) until the site answers with the
 * new version, and otherwise writes the previous version back (calling the webhook again in
 * `cloudflare` mode) and fails the run. Without a domain, or in web mode `proxy` when the site
 * does not answer GitHub at all before the deploy (a domain only the user's network resolves),
 * there is no site to check: the job writes the branch and says so.
 */
export function renderPortainerWorkflow(plan: DeployPlan): RenderedFile {
  const target = portainerTarget(plan.target);
  const build = buildJob(plan);
  const branch = PORTAINER_DEPLOY_BRANCH;
  const cloudflare = target.redeploy === "cloudflare";
  const url = portainerHealthUrl(plan);
  const image = "    IMAGE: ${{ needs.build.outputs.image }}";
  // Behind the user's own proxy the domain may resolve only on the user's network: then nothing
  // here can check the app, and a health check would roll back every deploy.
  const probe = target.web.mode === "proxy" && url !== undefined;

  const steps = [
    `- uses: ${CHECKOUT_ACTION}`,
    ...(probe
      ? [
          "- id: probe",
          "  name: Check that GitHub can reach the app",
          "  env:",
          `    URL: ${url}`,
          ...run(PROBE_SCRIPT),
        ]
      : []),
    "- id: write",
    `  name: Write the new version to the ${branch} branch`,
    "  env:",
    image,
    ...run(writeScript(branch)),
  ];
  if (cloudflare) {
    steps.push(
      "- id: redeploy",
      "  name: Ask Portainer to deploy the new version",
      "  if: steps.write.outputs.changed == 'true'",
      "  env:",
      ...webhookEnv(),
      ...run([
        "set -euo pipefail",
        ...WEBHOOK_CALL,
        'case "$code" in',
        '  2[0-9][0-9]) echo "Portainer accepted the redeploy." ;;',
        "  401|403)",
        '    echo "::error::Cloudflare Access refused the deploy workflow\'s service token (HTTP $code). Run \\`opscrew provision\\` again to set the deploy secrets."',
        "    exit 1 ;;",
        "  404)",
        "    echo \"::error::Portainer does not know this stack's webhook (HTTP 404). Run \\`opscrew provision\\` again to repair the stack's redeploy setting.\"",
        "    exit 1 ;;",
        "  *)",
        '    echo "::warning::Portainer did not confirm the redeploy (HTTP ${code:-none}); OpsCrew still waits for the new version." ;;',
        "esac",
      ]),
    );
  }
  const notice = (condition?: string) => [
    "- name: Check the app",
    ...(condition === undefined ? [] : [`  if: ${condition}`]),
    "  run: |",
    `    echo "::notice::OpsCrew wrote the new version to the ${branch} branch; Portainer deploys it${cloudflare ? "" : " within about a minute"}. GitHub cannot reach the app (opscrew/plan.yaml has no domain, or the domain answers only on your network), so this run does not check it: open the address your proxy serves it on."`,
  ];
  if (url === undefined) {
    steps.push(...notice());
  } else {
    if (probe) steps.push(...notice("steps.probe.outputs.reachable != 'true'"));
    steps.push(
      "- id: health",
      "  name: Wait until the new version answers",
      ...(probe ? ["  if: steps.probe.outputs.reachable == 'true'"] : []),
      "  env:",
      `    URL: ${url}`,
      image,
      ...run(healthScript(plan, HEALTH_ATTEMPTS[target.redeploy])),
      // Runs only when the branch was changed (not when the version was already there), and always
      // fails the job.
      "- name: Roll back to the previous version",
      "  if: failure() && steps.write.outputs.changed == 'true'",
      "  env:",
      "    PREVIOUS: ${{ steps.write.outputs.previous }}",
      "    DEPLOYED: ${{ steps.write.outputs.deployed }}",
      image,
      ...(cloudflare ? webhookEnv() : []),
      ...run(rollbackScript(branch, cloudflare)),
    );
  }

  const lines = [
    ...workflowStart(plan, [
      "# Builds the app image, pushes it to GitHub Container Registry and writes it to the",
      "# opscrew-deploy branch, which your Portainer deploys. Secrets are set by `opscrew provision`;",
      "# their values never appear in this file.",
    ]),
    ...build,
    "",
    ...deployJob("Deploy to Portainer", ["contents: write"], steps),
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
