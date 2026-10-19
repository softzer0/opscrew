// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.

import type { DeployPlan } from "@opscrew/plan-schema";
import { enabledServices, initStepsFor, serviceSpec } from "../catalog";
import { appDir } from "../edge";
import { ACTIONS, type PinArch, TOOLS, toolDownloadUrl } from "../pins";
import { renderRuntimeFiles } from "../runtime";
import { sshHostname } from "../tunnel";
import type { RenderContext, RenderedFile } from "../types";
import { buildJob } from "./build";
import { afterDeployJobs } from "./jobs";
import { renderPortainerWorkflow } from "./portainer";
import {
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  deployJob,
  healthPath,
  secret,
  serviceEnvSecret,
  workflowStart,
} from "./shared";
import { dockerConfig, rollbackCommands, switchCommands } from "./switch";

export { PORTAINER_DEPLOY_SECRETS, portainerHealthUrl } from "./portainer";
export {
  buildRunner,
  DEPLOY_SECRETS,
  serviceEnvSecret,
  sqliteFolder,
  supercronicArch,
} from "./shared";

/**
 * The Cloudflare Access service token the deploy workflow reaches SSH through the tunnel with
 * (tunnel mode only; terraform outputs `deploy_service_token_client_id` and
 * `deploy_service_token_client_secret`). `opscrew provision` sets them next to
 * {@link DEPLOY_SECRETS}.
 */
export const TUNNEL_DEPLOY_SECRETS = {
  serviceTokenId: "OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
  serviceTokenSecret: "OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET",
} as const;

const SSH_OPTS_BASE =
  "-i ~/.ssh/opscrew -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20";

/**
 * The bash `ssh_opts` array shared by every `ssh` and `scp` call. A server whose sshd listens on a
 * port other than 22 (public mode) gets `-o Port=<port>`, which both `ssh` and `scp` honour (and
 * which makes ssh look up `[host]:port` in known_hosts, as provision writes it). Tunnel mode never
 * gets it: cloudflared's ProxyCommand ignores the client-side port, the tunnel itself routes to the
 * server's sshd port, and known_hosts holds the bare SSH hostname.
 */
function sshOptsLine(port: number | undefined, tunnel: boolean): string {
  const portOpt = port === undefined || port === 22 || tunnel ? "" : ` -o Port=${port}`;
  return `ssh_opts=(${SSH_OPTS_BASE}${portOpt})`;
}

function checkSshPort(port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `The server's SSH port "${port}" is not a whole number between 1 and 65535. Check the port sshd listens on (sshd -T) and run the command again.`,
    );
  }
}

/** URL the deploy job polls after starting the new version. */
export function healthUrl(plan: DeployPlan): string {
  return plan.dns.domain
    ? `https://${plan.dns.domain}${healthPath(plan)}`
    : `http://${secret(DEPLOY_SECRETS.host)}${healthPath(plan)}`;
}

/**
 * Let's Encrypt's limit on new certificates for the exact same set of names: 5 per 7 days, one
 * more about every 34 hours (https://letsencrypt.org/docs/rate-limits/, checked 2026-10-15).
 */
const LETS_ENCRYPT_SAME_NAMES_PER_WEEK = 5;

/**
 * Whether the health check reaches Caddy's own certificate: the plan has a domain and no tunnel.
 * Then a failed TLS handshake means that Caddy has no certificate yet (Let's Encrypt's limit is the
 * usual cause on a server rebuilt many times): curl's own (exit 35 or 60) or, behind Cloudflare's
 * proxy, Cloudflare's with the server (HTTP 525 or 526).
 */
function caddyServesTls(plan: DeployPlan, tunnelHost: string | undefined): boolean {
  return plan.dns.domain !== undefined && tunnelHost === undefined;
}

/**
 * The health check's script. With `tlsHint`, curl's exit codes and HTTP statuses are recorded
 * and, when every attempt failed a TLS handshake, the error says that the server has no
 * certificate yet; otherwise, and without `tlsHint`, it says only that the new version did not
 * answer.
 */
function healthScript(tlsHint: boolean): string[] {
  const failed = 'echo "::error::The new version did not answer at $URL."';
  return [
    "    set -euo pipefail",
    ...(tlsHint ? ["    tls_only=1"] : []),
    "    for attempt in $(seq 1 30); do",
    ...(tlsHint
      ? [
          "      code=0",
          '      status="$(curl -fsS --max-time 10 -o /dev/null -w \'%{http_code}\' "$URL")" || code=$?',
          '      if [ "$code" -eq 0 ]; then',
        ]
      : ['      if curl -fsS --max-time 10 -o /dev/null "$URL"; then']),
    '        echo "Healthy after $attempt attempt(s)."',
    "        exit 0",
    "      fi",
    ...(tlsHint
      ? ['      case "$code:$status" in 35:* | 60:* | 22:525 | 22:526) ;; *) tls_only=0 ;; esac']
      : []),
    "      sleep 6",
    "    done",
    ...(tlsHint
      ? [
          '    if [ "$tls_only" -eq 1 ]; then',
          `      echo "::error::The new version did not answer at $URL: every attempt failed the TLS handshake, so the server has no certificate for this domain yet. Let's Encrypt issues at most ${LETS_ENCRYPT_SAME_NAMES_PER_WEEK} certificates per week for the same set of names, so a server rebuilt many times can reach that limit. Wait (one more becomes available about every 34 hours) or use another hostname, then deploy again."`,
          "    else",
          `      ${failed}`,
          "    fi",
        ]
      : [`    ${failed}`]),
    "    exit 1",
  ];
}

/**
 * Tunnel mode: installs the pinned cloudflared on the runner after checking its SHA-256, so SSH can
 * go through Cloudflare Access (`ProxyCommand cloudflared access ssh`).
 */
function installCloudflaredStep(): string[] {
  const arch = (machine: string, name: PinArch) =>
    `      ${machine}) url='${toolDownloadUrl("cloudflared", name)}'; sum='${TOOLS.cloudflared.sha256[name]}' ;;`;
  return [
    `- name: Install cloudflared ${TOOLS.cloudflared.version}`,
    "  run: |",
    "    set -euo pipefail",
    '    case "$(uname -m)" in',
    arch("x86_64", "amd64"),
    arch("aarch64", "arm64"),
    '      *) echo "::error::OpsCrew has no cloudflared build for this runner ($(uname -m))."; exit 1 ;;',
    "    esac",
    '    curl -fsSL --retry 3 -o "$RUNNER_TEMP/cloudflared" "$url"',
    '    echo "$sum  $RUNNER_TEMP/cloudflared" | sha256sum -c -',
    '    sudo install -m 0755 "$RUNNER_TEMP/cloudflared" /usr/local/bin/cloudflared',
    "    cloudflared --version",
  ];
}

/** The plan's services that read `<name>.env` on the server: those with secrets. */
function envFileServices(plan: DeployPlan): string[] {
  return enabledServices(plan)
    .filter((service) => serviceSpec(service.kind).secrets.length > 0)
    .map((service) => service.name);
}

/**
 * What the upload copies next to compose.yaml: the `opscrew/runtime/services` folder and the
 * crontab when {@link renderRuntimeFiles} renders them, and the `opscrew/runtime/edge` folder (the
 * edge's Compose file and the app's site), which the start step puts in place.
 */
function runtimeUploads(plan: DeployPlan): string[] {
  const top = renderRuntimeFiles(plan).map((file) => file.path.split("/").slice(0, 3).join("/"));
  return [...new Set(top)];
}

/** The lines of a server script for a `run: |` block, ended by the heredoc's `REMOTE`. */
function remote(script: readonly string[]): string[] {
  return [...script.map((line) => (line.length > 0 ? `    ${line}` : "")), "    REMOTE"];
}

/**
 * `.github/workflows/opscrew-deploy.yml`: build → push to GHCR → deploy over SSH with rollback,
 * then the optional signing, deploy tag and image retention jobs. The image is built on an arm64
 * runner for arm64 servers; in tunnel mode SSH goes through Cloudflare Access to the SSH hostname
 * with the service token from {@link TUNNEL_DEPLOY_SECRETS}.
 *
 * For a Portainer target the deploy job instead writes the stack file with the new image to the
 * `opscrew-deploy` branch (its only `contents: write`), lets Portainer redeploy (the updater stack,
 * or a webhook call through Cloudflare Access with {@link PORTAINER_DEPLOY_SECRETS}), waits for
 * the new version on the site and, when it does not come up, writes the previous version back.
 */
export function renderWorkflow(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  if (plan.target.provider === "portainer") return renderPortainerWorkflow(plan);
  checkSshPort(ctx.sshPort);

  // Tunnel mode: SSH goes through Cloudflare Access to the SSH hostname (it is in the committed
  // HCL anyway); the service token reaches cloudflared only through the environment.
  const tunnelHost = sshHostname(plan);
  const sshOpts = sshOptsLine(ctx.sshPort, tunnelHost !== undefined);
  const hostEnv = [
    tunnelHost === undefined
      ? `    HOST: ${secret(DEPLOY_SECRETS.host)}`
      : `    HOST: ${tunnelHost}`,
    ...(tunnelHost === undefined
      ? []
      : [
          `    TUNNEL_SERVICE_TOKEN_ID: ${secret(TUNNEL_DEPLOY_SECRETS.serviceTokenId)}`,
          `    TUNNEL_SERVICE_TOKEN_SECRET: ${secret(TUNNEL_DEPLOY_SECRETS.serviceTokenSecret)}`,
        ]),
  ];

  // Each env file reaches the server on ssh's stdin from its secret (the step's variable of the
  // same name), never in a command line or the log.
  const envFiles = [
    { file: "app.env", secret: DEPLOY_SECRETS.appEnv },
    ...envFileServices(plan).map((name) => ({
      file: `${name}.env`,
      secret: serviceEnvSecret(name),
    })),
  ];
  const uploadEnv = [
    ...hostEnv,
    ...envFiles.map((env) => `    ${env.secret}: ${secret(env.secret)}`),
  ];
  // The app's folder: OpsCrew's own servers (cloud-init) have only /srv/apps before the first deploy.
  const dir = appDir(plan);
  const uploadRun = [
    "    set -euo pipefail",
    `    ${sshOpts}`,
    `    ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'mkdir -p ${dir}'`,
    `    scp -r "\${ssh_opts[@]}" ${["opscrew/runtime/compose.yaml", ...runtimeUploads(plan)].join(" ")} "deploy@\${HOST}:${dir}/"`,
    ...envFiles.map(
      (env) =>
        `    printf '%s\\n' "\${${env.secret}:-}" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > ${dir}/${env.file}'`,
    ),
  ];

  const deploySteps = [
    `- uses: ${ACTIONS.checkout}`,
    ...(tunnelHost === undefined ? [] : installCloudflaredStep()),
    "- name: Configure SSH with the pinned host key",
    "  env:",
    `    SSH_KEY: ${secret(DEPLOY_SECRETS.sshKey)}`,
    `    KNOWN_HOSTS: ${secret(DEPLOY_SECRETS.knownHosts)}`,
    "  run: |",
    "    set -euo pipefail",
    "    install -m 700 -d ~/.ssh",
    "    printf '%s\\n' \"$SSH_KEY\" > ~/.ssh/opscrew",
    "    chmod 600 ~/.ssh/opscrew",
    "    printf '%s\\n' \"$KNOWN_HOSTS\" > ~/.ssh/known_hosts",
    ...(tunnelHost === undefined
      ? []
      : [
          "    {",
          `      echo 'Host ${tunnelHost}'`,
          "      echo '  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h'",
          "    } > ~/.ssh/config",
          "    chmod 600 ~/.ssh/config",
        ]),
    "- name: Upload runtime files and environment",
    "  env:",
    ...uploadEnv,
    "  run: |",
    ...uploadRun,
    // Saving the running version is the first thing done on the server (its image is the job's
    // `previous` output), and the rollback only switches back when `.env` already names this
    // run's image, so a failure before the switch never restores an older version.
    "- id: start",
    "  name: Start the new version",
    "  env:",
    ...hostEnv,
    "    IMAGE: ${{ needs.build.outputs.image }}",
    "    TAG: ${{ needs.build.outputs.tag }}",
    "    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "  run: |",
    "    set -euo pipefail",
    `    if [[ ! "$IMAGE" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '      echo "::error::The build job did not report the image digest; re-run the workflow."',
    "      exit 1",
    "    fi",
    '    echo "Deploying ${TAG:-the new image} as $IMAGE"',
    `    ${sshOpts}`,
    `    previous="$(ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'cd ${dir} && rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous && sed -n "s/^APP_IMAGE=//p" .env; fi')"`,
    `    if [[ -n "$previous" && ! "$previous" =~ ${DIGEST_REF_PATTERN} ]]; then previous=unknown; fi`,
    '    echo "previous=$previous" >> "$GITHUB_OUTPUT"',
    // In the app's own Docker settings: another app's deploy logs out of the same registry.
    `    printf '%s\\n' "$REGISTRY_TOKEN" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "DOCKER_CONFIG=${dockerConfig(plan)} docker login ghcr.io -u '\${GITHUB_ACTOR}' --password-stdin"`,
    '    ssh "${ssh_opts[@]}" "deploy@${HOST}" sh -s -- "$IMAGE" <<\'REMOTE\'',
    // The services' one-time setup steps come from the catalog; no entry has any yet.
    ...remote(switchCommands(plan, initStepsFor(plan))),
    "- id: health",
    "  name: Check that the app is healthy",
    "  env:",
    `    URL: ${healthUrl(plan)}`,
    "  run: |",
    ...healthScript(caddyServesTls(plan, tunnelHost)),
    // Runs only when starting or checking the new version failed (not for upload or setup errors),
    // and always fails the job.
    "- name: Roll back to the previous version",
    "  if: failure() && (steps.start.outcome == 'failure' || steps.health.outcome == 'failure')",
    "  env:",
    ...hostEnv,
    "    IMAGE: ${{ needs.build.outputs.image }}",
    "  run: |",
    "    set -uo pipefail",
    `    ${sshOpts}`,
    "    cat > \"$RUNNER_TEMP/rollback.sh\" <<'REMOTE'",
    ...remote(rollbackCommands(plan)),
    "    outcome=unchanged",
    `    if [[ "\${IMAGE:-}" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '      outcome="$(ssh "${ssh_opts[@]}" "deploy@${HOST}" sh -s -- "$IMAGE" < "$RUNNER_TEMP/rollback.sh")"',
    "    fi",
    '    case "$outcome" in',
    "      restored)",
    '        echo "::error::The deploy failed; OpsCrew restored the previous version." ;;',
    "      unchanged)",
    '        echo "::error::The deploy failed before the new version took traffic; the server still runs the version it had." ;;',
    "      no-previous)",
    '        echo "::error::The deploy failed and there is no earlier version to restore (first deploy, or the same image was already running). Fix the problem and push again." ;;',
    "      *)",
    `        echo "::error::The deploy failed and OpsCrew could not restore the previous version. Connect to the server and run \\\`docker compose ps\\\` in ${dir}." ;;`,
    "    esac",
    "    exit 1",
  ];

  const lines = [
    ...workflowStart(plan, [
      "# Builds the app image, pushes it to GitHub Container Registry and deploys it to your server",
      "# over SSH. Secrets are set by `opscrew provision`; their values never appear in this file.",
    ]),
    ...buildJob(plan),
    "",
    ...deployJob(
      "Deploy to the server",
      ["contents: read", "packages: read"],
      "${{ steps.start.outputs.previous }}",
      deploySteps,
    ),
    ...afterDeployJobs(plan),
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
