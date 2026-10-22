// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { EDGE_PROJECT, EDGE_PROXIES, edgeProxy, originPullPem } from "../edge";
import { LOCALHOST_TLS } from "../edge/localhost";
import { LETSENCRYPT } from "../edge/nginx";
import { shellQuote } from "../runtime/services";
import { runtimeDir } from "../runtime-dir";
import { environmentName } from "./shared";
import type { EdgeFiles } from "./switch";

/** Where the step lays the edge out as the server has it, on the runner. */
const CHECK = '"$RUNNER_TEMP/opscrew-edge"';

/** A self-signed P-256 certificate and its key, made on the runner, that stand in for the real ones. */
function placeholder(key: string, certificate: string): string {
  return `    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=opscrew-placeholder -keyout ${key} -out ${certificate} 2> /dev/null`;
}

/** Shown when the proxy's own checker refused the edge; nothing has reached the server. */
function checkFailed(plan: DeployPlan, file: string, additions: boolean): string {
  const { label, additions: yours } = EDGE_PROXIES[edgeProxy(plan)];
  const also = additions ? ` with your additions in ${yours}` : "";
  return `::error::${label} refused this app's edge configuration (${file}${also}) for the reason above. Nothing was sent to the server, which keeps serving the previous version: fix the cause (opscrew provision renders the site again), then push again.`;
}

/**
 * On the local runner: the app's leaf certificate and key already in this computer's edge, copied
 * for the check. A workflow deploy brings no leaf; `opscrew provision` issues it.
 */
function localLeaf(plan: DeployPlan, tls: string): string[] {
  const app = plan.app.name;
  const { certificate, key } = LOCALHOST_TLS;
  const [pem, pemKey] = [certificate, key].map((file) => `"$OPSCREW_EDGE_DIR"/tls/${app}/${file}`);
  const env = environmentName(plan);
  const missing = `::error::This runner finds no leaf certificate for the app in this computer's edge (tls/${app}/${certificate} and ${key} in OPSCREW_EDGE_DIR). Run \`opscrew provision --env ${env}\`, which issues it, and start the runner with \`opscrew runner start --env ${env}\`, which sets OPSCREW_EDGE_DIR; then run the workflow again.`;
  return [
    `    if [[ -z "\${OPSCREW_EDGE_DIR:-}" || ! -f ${pem} || ! -f ${pemKey} ]]; then`,
    `      echo ${shellQuote(missing)}`,
    "      exit 1",
    "    fi",
    `    mkdir -p ${tls}`,
    `    cp ${pem} ${pemKey} ${tls}/`,
  ];
}

/**
 * The deploy job's step before any upload: the proxy's own checker in its pinned image, through
 * the uploaded edge Compose file on the runner (`caddy validate --adapter caddyfile`, or
 * `nginx -t`), against the whole edge this repository renders (from the environment's
 * {@link runtimeDir}): the main configuration, the app's site (on nginx also the one before
 * certbot's first certificate) and its additions, with placeholder certificates in place of the
 * origin certificate and certbot's. On this computer the site's leaf certificate is the one its
 * edge already has ({@link localLeaf}). A refusal ends the job with the checker's output before
 * anything reaches the server.
 */
export function edgeCheckStep(plan: DeployPlan, o: EdgeFiles): string[] {
  const proxy = edgeProxy(plan);
  const { label, site, additions } = EDGE_PROXIES[proxy];
  const app = plan.app.name;
  const dir = runtimeDir(plan);
  const tls = `${CHECK}/tls/${app}`;
  const live = `${CHECK}/letsencrypt/live/${app}`;
  const nginx = proxy === "nginx";
  const certbot = nginx && o.certbot !== undefined && o.certbot.hosts.length > 0;
  const files = [`${app}.${site}`, ...(certbot ? [`${app}.http.conf`] : [])];
  const check = nginx
    ? `run --rm --no-deps -T -v ${CHECK}/letsencrypt:${LETSENCRYPT}:ro --entrypoint nginx nginx -t`
    : "run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile";
  return [
    `- name: Validate the edge's configuration with ${label}`,
    "  run: |",
    "    set -euo pipefail",
    `    mkdir -p ${CHECK}/sites${nginx ? ` ${CHECK}/letsencrypt` : ""}`,
    `    cp ${dir}/edge/compose.yaml ${CHECK}/compose.yaml`,
    ...(o.additions ? [`    cp ${additions} ${CHECK}/sites/${app}.additions`] : []),
    ...(o.originTls
      ? [
          `    mkdir -p ${tls}`,
          placeholder(`${tls}/origin.key`, `${tls}/origin.pem`),
          `    cp ${originPullPem(plan)} ${tls}/pull.pem`,
        ]
      : []),
    ...(plan.target.provider === "localhost" ? localLeaf(plan, tls) : []),
    ...(certbot
      ? [`    mkdir -p ${live}`, placeholder(`${live}/privkey.pem`, `${live}/fullchain.pem`)]
      : []),
    // nginx runs as the deploy user on the server, here as the runner's.
    ...(nginx ? ['    export OPSCREW_DEPLOY_UID="$(id -u)" OPSCREW_DEPLOY_GID="$(id -g)"'] : []),
    `    docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    ...files.flatMap((file) => [
      `    cp ${dir}/edge/sites/${file} ${CHECK}/sites/${app}.${site}`,
      `    if ! docker compose -p opscrew-edge-check -f ${CHECK}/compose.yaml ${check} < /dev/null; then`,
      `      echo ${shellQuote(checkFailed(plan, `${dir}/edge/sites/${file}`, o.additions))}`,
      "      exit 1",
      "    fi",
    ]),
  ];
}
