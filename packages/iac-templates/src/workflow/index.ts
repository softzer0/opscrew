// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { CLOUDFLARED_SHA256, CLOUDFLARED_VERSION, cloudflaredUrl, sshHostname } from "../tunnel";
import type { RenderContext, RenderedFile } from "../types";
import { renderPortainerWorkflow } from "./portainer";
import {
  block,
  buildJob,
  CHECKOUT_ACTION,
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  healthPath,
  secret,
  workflowStart,
} from "./shared";

export { PORTAINER_DEPLOY_SECRETS, portainerHealthUrl } from "./portainer";
export { buildRunner, CHECKOUT_ACTION, DEFAULT_TRIVY_IMAGE, DEPLOY_SECRETS } from "./shared";

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
 * Whether the health check reaches Caddy's own certificate: the plan has a domain that Cloudflare
 * does not proxy and no tunnel. Only then does a TLS handshake failure mean that Caddy has no
 * certificate yet (Let's Encrypt's limit is the usual cause on a server rebuilt many times).
 */
function caddyServesTls(plan: DeployPlan, tunnelHost: string | undefined): boolean {
  return plan.dns.domain !== undefined && !plan.dns.proxied && tunnelHost === undefined;
}

/**
 * The health check's script. With `tlsHint`, curl's exit codes are recorded and, when every
 * attempt failed the TLS handshake (35 or 60), the error says that the server has no certificate
 * yet; otherwise, and without `tlsHint`, it says only that the new version did not answer.
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
          '      curl -fsS --max-time 10 -o /dev/null "$URL" || code=$?',
          '      if [ "$code" -eq 0 ]; then',
        ]
      : ['      if curl -fsS --max-time 10 -o /dev/null "$URL"; then']),
    '        echo "Healthy after $attempt attempt(s)."',
    "        exit 0",
    "      fi",
    ...(tlsHint ? ['      if [ "$code" -ne 35 ] && [ "$code" -ne 60 ]; then tls_only=0; fi'] : []),
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
 * Where the release command's output stays: on the server, readable only by the deploy user. It is
 * never printed in the workflow log, which is public for public repositories, because a failed
 * migration can quote rows of the database.
 */
const RELEASE_LOG = "/srv/app/release.log";

/** Shown when the release command fails; names neither the server nor any secret. */
const RELEASE_FAILED = `::error::The release command (app.releaseCommand in opscrew/plan.yaml) failed, so the new version was not started and the previous version keeps serving. Its output stays on the server in ${RELEASE_LOG} (it can quote data from the database, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the command or the app and push again.`;

const RELEASE_DONE = `The release command finished; its output is in ${RELEASE_LOG} on the server.`;

/**
 * Server-side commands (in /srv/app, after the registry login) that start the new image. Without a
 * release command: write `.env` with the new image, pull, `up`. With one: pull the new image (named
 * through the environment, so `.env` still names the running version), start the backing services,
 * run the `release` service of compose.yaml in a one-off container of the new image, and only when
 * it succeeds write `.env` and replace the app. A failure leaves the running version untouched.
 */
function switchCommands(plan: DeployPlan): string {
  const writeEnv = "printf 'APP_IMAGE=%s\\n' '${IMAGE}' > .env";
  if (plan.app.releaseCommand === undefined) {
    return `${writeEnv}; docker compose pull; docker compose up -d --remove-orphans`;
  }
  const backing = [
    ...(plan.services.postgres ? ["db"] : []),
    ...(plan.services.redis ? ["cache"] : []),
  ];
  return [
    "export APP_IMAGE='${IMAGE}'",
    "docker compose pull",
    ...(backing.length > 0 ? [`docker compose up -d --wait ${backing.join(" ")}`] : []),
    `if ! (umask 077; docker compose run --rm --no-deps -T release > ${RELEASE_LOG} 2>&1); then echo '${RELEASE_FAILED}'; exit 1; fi`,
    `echo '${RELEASE_DONE}'`,
    writeEnv,
    "docker compose up -d --remove-orphans",
  ].join("; ");
}

/**
 * Tunnel mode: installs the pinned cloudflared on the runner after checking its SHA-256, so SSH can
 * go through Cloudflare Access (`ProxyCommand cloudflared access ssh`).
 */
function installCloudflaredStep(): string[] {
  const arch = (machine: string, name: keyof typeof CLOUDFLARED_SHA256) =>
    `      ${machine}) url='${cloudflaredUrl(name)}'; sum='${CLOUDFLARED_SHA256[name]}' ;;`;
  return [
    `- name: Install cloudflared ${CLOUDFLARED_VERSION}`,
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

/**
 * `.github/workflows/opscrew-deploy.yml`: build → push to GHCR → deploy over SSH with rollback. The
 * image is built on an arm64 runner for arm64 servers; in tunnel mode SSH goes through Cloudflare
 * Access to the SSH hostname with the service token from {@link TUNNEL_DEPLOY_SECRETS}.
 *
 * For a Portainer target the deploy job instead writes the stack file with the new image to the
 * `opscrew-deploy` branch (its only `contents: write`), lets Portainer redeploy (the updater stack,
 * or a webhook call through Cloudflare Access with {@link PORTAINER_DEPLOY_SECRETS}), waits for
 * the new version on the site and, when it does not come up, writes the previous version back.
 */
export function renderWorkflow(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  if (plan.target.provider === "portainer") return renderPortainerWorkflow(plan);
  const build = buildJob(plan);
  const hasDb = plan.services.postgres;
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

  const uploadEnv = [
    ...hostEnv,
    `    APP_ENV: ${secret(DEPLOY_SECRETS.appEnv)}`,
    ...(hasDb ? [`    DB_ENV: ${secret(DEPLOY_SECRETS.dbEnv)}`] : []),
  ];
  const uploadRun = [
    "    set -euo pipefail",
    `    ${sshOpts}`,
    '    scp "${ssh_opts[@]}" opscrew/runtime/compose.yaml opscrew/runtime/Caddyfile "deploy@${HOST}:/srv/app/"',
    '    printf \'%s\\n\' "${APP_ENV:-}" | ssh "${ssh_opts[@]}" "deploy@${HOST}" \'umask 077 && cat > /srv/app/app.env\'',
    ...(hasDb
      ? [
          '    printf \'%s\\n\' "${DB_ENV:-}" | ssh "${ssh_opts[@]}" "deploy@${HOST}" \'umask 077 && cat > /srv/app/db.env\'',
        ]
      : []),
  ];

  const deploySteps = [
    `- uses: ${CHECKOUT_ACTION}`,
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
    // Saving the running version is the first thing done on the server, and the rollback only
    // swaps it back when `.env` already names this run's image, so a failure before the switch
    // never restores an older version.
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
    '    ssh "${ssh_opts[@]}" "deploy@${HOST}" \'cd /srv/app && rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous; fi\'',
    '    printf \'%s\\n\' "$REGISTRY_TOKEN" | ssh "${ssh_opts[@]}" "deploy@${HOST}" "docker login ghcr.io -u \'${GITHUB_ACTOR}\' --password-stdin"',
    `    ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "set -e; trap 'docker logout ghcr.io >/dev/null 2>&1' EXIT; cd /srv/app; ${switchCommands(plan)}"`,
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
    "    outcome=unchanged",
    `    if [[ "\${IMAGE:-}" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '      outcome="$(ssh "${ssh_opts[@]}" "deploy@${HOST}" "cd /srv/app || exit 1; if ! grep -qxF \'APP_IMAGE=${IMAGE}\' .env 2>/dev/null; then echo unchanged; elif [ ! -f .env.previous ] || cmp -s .env .env.previous; then echo no-previous; else mv .env.previous .env && docker compose up -d --remove-orphans >&2 && echo restored; fi")"',
    "    fi",
    '    case "$outcome" in',
    "      restored)",
    '        echo "::error::The deploy failed; OpsCrew restored the previous version." ;;',
    "      unchanged)",
    '        echo "::error::The deploy failed before the new version started; the server still runs the version it had." ;;',
    "      no-previous)",
    '        echo "::error::The deploy failed and there is no earlier version to restore (first deploy, or the same image was already running). Fix the problem and push again." ;;',
    "      *)",
    '        echo "::error::The deploy failed and OpsCrew could not restore the previous version. Connect to the server and run \\`docker compose ps\\` in /srv/app." ;;',
    "    esac",
    "    exit 1",
  ];

  const lines = [
    ...workflowStart(plan, [
      "# Builds the app image, pushes it to GitHub Container Registry and deploys it to your server",
      "# over SSH. Secrets are set by `opscrew provision`; their values never appear in this file.",
    ]),
    ...build,
    "",
    "  deploy:",
    "    name: Deploy to the server",
    "    needs: build",
    "    runs-on: ubuntu-latest",
    "    environment: production",
    "    permissions:",
    "      contents: read",
    "      packages: read",
    "    steps:",
    ...block(deploySteps, 6),
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
