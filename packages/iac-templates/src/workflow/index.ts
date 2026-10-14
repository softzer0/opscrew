// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { CLOUDFLARED_SHA256, CLOUDFLARED_VERSION, cloudflaredUrl, sshHostname } from "../tunnel";
import type { RenderContext, RenderedFile } from "../types";

/** actions/checkout v7.0.1 (lightweight tag → commit), pinned by SHA. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
/**
 * Default image for the optional, report-only image scan, pinned by digest because it runs with the
 * Docker socket. Digest of the multi-arch OCI index for tag 0.75.0, resolved on 2026-10-11 from the
 * Docker Hub registry API (`registry-1.docker.io/v2/aquasec/trivy/manifests/0.75.0`) and identical
 * on `ghcr.io/aquasecurity/trivy:0.75.0`.
 */
export const DEFAULT_TRIVY_IMAGE =
  "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";

/** Shell pattern for a GHCR image pinned by digest, `ghcr.io/<owner>/<repo>@sha256:<hex>`. */
const DIGEST_REF_PATTERN = "^ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$";

/** Names of the GitHub Actions secrets the workflow reads. `opscrew provision` sets them. */
export const DEPLOY_SECRETS = {
  host: "OPSCREW_HOST",
  sshKey: "OPSCREW_SSH_PRIVATE_KEY",
  knownHosts: "OPSCREW_SSH_KNOWN_HOSTS",
  appEnv: "OPSCREW_APP_ENV",
  dbEnv: "OPSCREW_DB_ENV",
  buildEnv: "OPSCREW_BUILD_ENV",
} as const;

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

/** GitHub-hosted runner that builds the image: arm64 servers get an arm64 runner (no emulation). */
export function buildRunner(plan: DeployPlan): string {
  return plan.target.provider === "own" && plan.target.arch === "arm64"
    ? "ubuntu-24.04-arm"
    : "ubuntu-latest";
}

const SSH_OPTS =
  "ssh_opts=(-i ~/.ssh/opscrew -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20)";

function secret(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/** URL the deploy job polls after starting the new version. */
export function healthUrl(plan: DeployPlan): string {
  const path = plan.app.healthPath.startsWith("/")
    ? plan.app.healthPath
    : `/${plan.app.healthPath}`;
  return plan.dns.domain
    ? `https://${plan.dns.domain}${path}`
    : `http://${secret(DEPLOY_SECRETS.host)}${path}`;
}

function block(lines: string[], indent: number): string[] {
  const pad = " ".repeat(indent);
  return lines.map((line) => (line.length > 0 ? `${pad}${line}` : ""));
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
 */
export function renderWorkflow(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  const context = plan.app.buildContext || ".";
  const dockerfile = plan.app.dockerfile || "Dockerfile";
  const scanImage = ctx.trivyImage ?? DEFAULT_TRIVY_IMAGE;
  if (!/@sha256:[0-9a-f]{64}$/.test(scanImage)) {
    throw new Error(
      `The Trivy image "${scanImage}" must be pinned by digest (name:tag@sha256:...) because the scan runs with the Docker socket. Use a digest-pinned reference or leave trivyImage unset.`,
    );
  }
  const hasDb = plan.services.postgres;

  const buildSteps = [
    `- uses: ${CHECKOUT_ACTION}`,
    "- id: image",
    "  name: Choose the image name",
    "  run: |",
    "    set -euo pipefail",
    '    repo="${GITHUB_REPOSITORY,,}"',
    '    echo "image=ghcr.io/${repo}:${GITHUB_SHA}" >> "$GITHUB_OUTPUT"',
    "- name: Log in to GitHub Container Registry",
    "  env:",
    "    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    '  run: printf \'%s\\n\' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
    // The deploy pulls `ref` (the digest that was pushed), so it runs exactly this build; the SHA
    // tag stays for humans. Logging out here keeps the `packages: write` token away from the scan.
    "- id: push",
    "  name: Build and push the image",
    "  env:",
    "    IMAGE: ${{ steps.image.outputs.image }}",
    `    BUILD_ENV: ${secret(DEPLOY_SECRETS.buildEnv)}`,
    "  run: |",
    "    set -euo pipefail",
    "    build_args=()",
    "    while IFS= read -r line; do",
    '      [[ -z "$line" || "$line" == \\#* ]] && continue',
    '      build_args+=(--build-arg "$line")',
    '    done <<< "${BUILD_ENV:-}"',
    `    docker build "\${build_args[@]}" -t "$IMAGE" -f ${JSON.stringify(dockerfile)} ${JSON.stringify(context)}`,
    '    docker push "$IMAGE"',
    "    docker logout ghcr.io",
    '    ref="$(docker image inspect --format \'{{range .RepoDigests}}{{println .}}{{end}}\' "$IMAGE" | grep -m1 -F "${IMAGE%:*}@sha256:" || true)"',
    `    if [[ ! "$ref" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    '      echo "::error::Could not read the digest of the pushed image $IMAGE; re-run the workflow."',
    "      exit 1",
    "    fi",
    '    echo "ref=$ref" >> "$GITHUB_OUTPUT"',
    '    echo "Pushed \\`$IMAGE\\` as \\`$ref\\`." >> "$GITHUB_STEP_SUMMARY"',
  ];
  if (plan.security.imageScan) {
    // Scans the local image the digest above was read from (same image id), without registry login.
    buildSteps.push(
      "- name: Scan the image (report only)",
      "  env:",
      "    IMAGE: ${{ steps.image.outputs.image }}",
      `  run: docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${scanImage} image --no-progress --severity HIGH,CRITICAL --exit-code 0 "$IMAGE"`,
    );
  }

  // Tunnel mode: SSH goes through Cloudflare Access to the SSH hostname (it is in the committed
  // HCL anyway); the service token reaches cloudflared only through the environment.
  const tunnelHost = sshHostname(plan);
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
    `    ${SSH_OPTS}`,
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
    `    ${SSH_OPTS}`,
    '    ssh "${ssh_opts[@]}" "deploy@${HOST}" \'cd /srv/app && rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous; fi\'',
    '    printf \'%s\\n\' "$REGISTRY_TOKEN" | ssh "${ssh_opts[@]}" "deploy@${HOST}" "docker login ghcr.io -u \'${GITHUB_ACTOR}\' --password-stdin"',
    `    ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "set -e; trap 'docker logout ghcr.io >/dev/null 2>&1' EXIT; cd /srv/app; ${switchCommands(plan)}"`,
    "- id: health",
    "  name: Check that the app is healthy",
    "  env:",
    `    URL: ${healthUrl(plan)}`,
    "  run: |",
    "    set -euo pipefail",
    "    for attempt in $(seq 1 30); do",
    '      if curl -fsS --max-time 10 -o /dev/null "$URL"; then',
    '        echo "Healthy after $attempt attempt(s)."',
    "        exit 0",
    "      fi",
    "      sleep 6",
    "    done",
    '    echo "::error::The new version did not answer at $URL."',
    "    exit 1",
    // Runs only when starting or checking the new version failed (not for upload or setup errors),
    // and always fails the job.
    "- name: Roll back to the previous version",
    "  if: failure() && (steps.start.outcome == 'failure' || steps.health.outcome == 'failure')",
    "  env:",
    ...hostEnv,
    "    IMAGE: ${{ needs.build.outputs.image }}",
    "  run: |",
    "    set -uo pipefail",
    `    ${SSH_OPTS}`,
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
    "# Generated by OpsCrew from opscrew/plan.yaml; `opscrew provision` regenerates it.",
    "# Builds the app image, pushes it to GitHub Container Registry and deploys it to your server",
    "# over SSH. Secrets are set by `opscrew provision`; their values never appear in this file.",
    "name: OpsCrew deploy",
    "",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(plan.cicd.branch)}]`,
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: opscrew-deploy",
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  build:",
    "    name: Build the image",
    `    runs-on: ${buildRunner(plan)}`,
    "    permissions:",
    "      contents: read",
    "      packages: write",
    "    outputs:",
    "      image: ${{ steps.push.outputs.ref }}",
    "      tag: ${{ steps.image.outputs.image }}",
    "    steps:",
    ...block(buildSteps, 6),
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
