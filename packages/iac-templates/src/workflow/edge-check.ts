// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  additionsPath,
  EDGE_PROJECT,
  EDGE_PROXIES,
  type EdgeProxy,
  edgeProxy,
  OPENLITESPEED_COMMAND,
  originPullPem,
} from "../edge";
import { LOCALHOST_TLS } from "../edge/localhost";
import { LETSENCRYPT } from "../edge/nginx";
import { shellQuote } from "../runtime/services";
import { runtimeDir } from "../runtime-dir";
import {
  appFlag,
  environmentName,
  onRunnerMachine,
  provisionCommand,
  runnerStartCommand,
} from "./shared";
import type { EdgeFiles } from "./switch";

/** Where the step lays the edge out as the server has it, on the runner. */
const CHECK = '"$RUNNER_TEMP/opscrew-edge"';

/** A self-signed P-256 certificate and its key, made on the runner, that stand in for the real ones. */
function placeholder(key: string, certificate: string): string {
  return `    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=opscrew-placeholder -keyout ${key} -out ${certificate} 2> /dev/null`;
}

/** Shown when the proxy's own checker refused the edge; nothing has reached the server. */
function checkFailed(plan: DeployPlan, file: string, additions: boolean): string {
  const { label } = EDGE_PROXIES[edgeProxy(plan)];
  const also = additions ? ` with your additions in ${additionsPath(plan)}` : "";
  return `::error::${label} refused this app's edge configuration (${file}${also}) for the reason above. Nothing was sent to the server, which keeps serving the previous version: fix the cause (${provisionCommand(plan)} renders the site again), then push again.`;
}

/**
 * On the local runner: the app's leaf certificate and key already in this computer's edge, copied
 * for the check. A workflow deploy brings no leaf; `opscrew provision` issues it.
 */
function localLeaf(plan: DeployPlan, tls: string): string[] {
  const app = plan.app.name;
  const { certificate, key } = LOCALHOST_TLS;
  const [pem, pemKey] = [certificate, key].map((file) => `"$OPSCREW_EDGE_DIR"/tls/${app}/${file}`);
  // The local runner is started per environment, so the command names prod's too.
  const provision = `opscrew provision${appFlag(plan)} --env ${environmentName(plan)}`;
  const missing = `::error::This runner finds no leaf certificate for the app in this computer's edge (tls/${app}/${certificate} and ${key} in OPSCREW_EDGE_DIR). Run \`${provision}\`, which issues it, and start the runner with \`${runnerStartCommand(plan)}\`, which sets OPSCREW_EDGE_DIR; then run the workflow again.`;
  return [
    `    if [[ -z "\${OPSCREW_EDGE_DIR:-}" || ! -f ${pem} || ! -f ${pemKey} ]]; then`,
    `      echo ${shellQuote(missing)}`,
    "      exit 1",
    "    fi",
    `    mkdir -p ${tls}`,
    `    cp ${pem} ${pemKey} ${tls}/`,
  ];
}

/** certbot's certificates in place of the edge's volume, for the proxies beside certbot. */
const LETSENCRYPT_MOUNT = `-v ${CHECK}/letsencrypt:${LETSENCRYPT}:ro`;

/**
 * The Compose words of each proxy's own checker, in a one-off container of its service.
 * OpenLiteSpeed's edge runs its own check (ADR 0031 D2). `openlitespeed -t` needs kamal-proxy's
 * name to resolve, so the container names it itself: a kamal-proxy started for the check would join
 * the edge's network, which on the server's or the local runner is the running edge's, and answer
 * for kamal-proxy's name there too.
 */
const CHECKER: Record<EdgeProxy, string> = {
  caddy:
    "run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
  nginx: `run --rm --no-deps -T ${LETSENCRYPT_MOUNT} --entrypoint nginx nginx -t`,
  openlitespeed: `run --rm --no-deps -T ${LETSENCRYPT_MOUNT} --entrypoint sh openlitespeed -c 'printf "127.0.0.1 kamal-proxy\\n" >> /etc/hosts && ${OPENLITESPEED_COMMAND.check}'`,
};

/**
 * The deploy job's step before any upload: the proxy's own checker in its pinned image, through
 * the uploaded edge Compose file on the runner (`caddy validate --adapter caddyfile`,
 * `nginx -t`, or OpenLiteSpeed's edge's own check), against the whole edge this repository
 * renders (from the environment's {@link runtimeDir}): the main configuration, the app's site (with
 * certbot's hostnames also the one before its first certificate; on OpenLiteSpeed its other site
 * files too) and its additions, with placeholder certificates in place of the origin certificate
 * and certbot's. On this computer the site's leaf certificate is the one its edge already has
 * ({@link localLeaf}). A refusal ends the job with the checker's output before anything reaches
 * the server.
 */
export function edgeCheckStep(plan: DeployPlan, o: EdgeFiles): string[] {
  const proxy = edgeProxy(plan);
  const { label, site } = EDGE_PROXIES[proxy];
  const additions = additionsPath(plan, proxy);
  const app = plan.app.name;
  const dir = runtimeDir(plan);
  const tls = `${CHECK}/tls/${app}`;
  const live = `${CHECK}/letsencrypt/live/${app}`;
  const beside = proxy !== "caddy";
  const certbot = beside && o.certbot !== undefined && o.certbot.hosts.length > 0;
  const files = [`${app}.${site}`, ...(certbot ? [`${app}.http.${site}`] : [])];
  /** OpenLiteSpeed's site files that both of its sites share. */
  const shared = proxy === "openlitespeed" ? [`${app}.vhost`, `${app}.map`] : [];
  return [
    `- name: Validate the edge's configuration with ${label}`,
    "  run: |",
    "    set -euo pipefail",
    `    mkdir -p ${CHECK}/sites${beside ? ` ${CHECK}/letsencrypt` : ""}`,
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
    // nginx runs as the deploy user on the server, here as the runner's, and so does certbot beside
    // OpenLiteSpeed (the Compose file names the deploy user wherever certbot runs).
    ...(beside ? ['    export OPSCREW_DEPLOY_UID="$(id -u)" OPSCREW_DEPLOY_GID="$(id -g)"'] : []),
    // `run --rm` keeps the volumes the edge's Compose file names: on the user's own runner they
    // would stay, so they go at the end, also after a refusal. One another deploy's check uses
    // at that moment stays, and that check removes it.
    "    remove_check_volumes() {",
    "      for volume in $(docker volume ls -q --filter label=com.docker.compose.project=opscrew-edge-check); do",
    '        docker volume rm "$volume" > /dev/null 2>&1 || true',
    "      done",
    "    }",
    "    trap remove_check_volumes EXIT",
    // A runner machine runs other environments' deploys at once: one of them may create it first.
    onRunnerMachine(plan)
      ? `    docker network create ${EDGE_PROJECT} > /dev/null 2>&1 || docker network inspect ${EDGE_PROJECT} > /dev/null`
      : `    docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    ...shared.map((file) => `    cp ${dir}/edge/sites/${file} ${CHECK}/sites/${file}`),
    ...files.flatMap((file) => [
      `    cp ${dir}/edge/sites/${file} ${CHECK}/sites/${app}.${site}`,
      `    if ! docker compose -p opscrew-edge-check -f ${CHECK}/compose.yaml ${CHECKER[proxy]} < /dev/null; then`,
      `      echo ${shellQuote(checkFailed(plan, `${dir}/edge/sites/${file}`, o.additions))}`,
      "      exit 1",
      "    fi",
    ]),
  ];
}
