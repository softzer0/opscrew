// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";

/** actions/checkout v7.0.1 (lightweight tag → commit), pinned by SHA. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
/** Default image for the optional, report-only image scan. */
export const DEFAULT_TRIVY_IMAGE = "aquasec/trivy:0.75.0";

/** Names of the GitHub Actions secrets the workflow reads. `opscrew provision` sets them. */
export const DEPLOY_SECRETS = {
  host: "OPSCREW_HOST",
  sshKey: "OPSCREW_SSH_PRIVATE_KEY",
  knownHosts: "OPSCREW_SSH_KNOWN_HOSTS",
  appEnv: "OPSCREW_APP_ENV",
  dbEnv: "OPSCREW_DB_ENV",
  buildEnv: "OPSCREW_BUILD_ENV",
} as const;

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

/** `.github/workflows/opscrew-deploy.yml`: build → push to GHCR → deploy over SSH with rollback. */
export function renderWorkflow(plan: DeployPlan, ctx: RenderContext): RenderedFile {
  const context = plan.app.buildContext || ".";
  const dockerfile = plan.app.dockerfile || "Dockerfile";
  const scanImage = ctx.trivyImage ?? DEFAULT_TRIVY_IMAGE;
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
    "- name: Build and push the image",
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
  ];
  if (plan.security.imageScan) {
    buildSteps.push(
      "- name: Scan the image (report only)",
      "  env:",
      "    IMAGE: ${{ steps.image.outputs.image }}",
      `  run: docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${scanImage} image --no-progress --severity HIGH,CRITICAL --exit-code 0 "$IMAGE"`,
    );
  }

  const uploadEnv = [
    `    HOST: ${secret(DEPLOY_SECRETS.host)}`,
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
    "- name: Upload runtime files and environment",
    "  env:",
    ...uploadEnv,
    "  run: |",
    ...uploadRun,
    "- name: Start the new version",
    "  env:",
    `    HOST: ${secret(DEPLOY_SECRETS.host)}`,
    "    IMAGE: ${{ needs.build.outputs.image }}",
    "    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "  run: |",
    "    set -euo pipefail",
    `    ${SSH_OPTS}`,
    '    printf \'%s\\n\' "$REGISTRY_TOKEN" | ssh "${ssh_opts[@]}" "deploy@${HOST}" "docker login ghcr.io -u \'${GITHUB_ACTOR}\' --password-stdin"',
    '    ssh "${ssh_opts[@]}" "deploy@${HOST}" "set -e; cd /srv/app; if [ -f .env ]; then cp .env .env.previous; fi; printf \'APP_IMAGE=%s\\n\' \'${IMAGE}\' > .env; docker compose pull; docker compose up -d --remove-orphans; docker logout ghcr.io"',
    "- name: Check that the app is healthy",
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
    "- name: Roll back to the previous version",
    "  if: failure()",
    "  env:",
    `    HOST: ${secret(DEPLOY_SECRETS.host)}`,
    "  run: |",
    "    set -uo pipefail",
    `    ${SSH_OPTS}`,
    '    ssh "${ssh_opts[@]}" "deploy@${HOST}" \'cd /srv/app && if [ -f .env.previous ]; then mv .env.previous .env && docker compose up -d --remove-orphans; fi\'',
    '    echo "::error::The deploy failed; OpsCrew restored the previous version."',
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
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "      packages: write",
    "    outputs:",
    "      image: ${{ steps.image.outputs.image }}",
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
