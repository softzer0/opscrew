// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import type { DeployPlan, ImageBuilder } from "@opscrew/plan-schema";
import {
  appDir,
  EDGE_DIR,
  EDGE_PROJECT,
  EDGE_PROXIES,
  EDGE_PROXY_KEY,
  EDGE_VERSION_KEY,
  type EdgeProxy,
  edgeProxy,
  otherProxy,
} from "../edge";
import {
  ACME_WEBROOT,
  CERTBOT_LOCKED,
  certbotCertonly,
  certbotLive,
  certbotRenewBefore,
  LETSENCRYPT,
  RELOAD_DIR,
} from "../edge/nginx";
import { hostSettingsServices, siteHosts } from "../runtime";
import { shellQuote } from "../runtime/services";
import { hasCronJobs, healthPath } from "./shared";

/**
 * Where the release command's output stays: on the server, readable only by the deploy user. It is
 * never printed in the workflow log, which is public for public repositories, because a failed
 * migration can quote rows of the database.
 */
function releaseLog(plan: DeployPlan): string {
  return `${appDir(plan)}/release.log`;
}

/**
 * The app's own Docker client settings on the server (`DOCKER_CONFIG`), where its deploy logs in
 * to the registry and out again: one app's logout never ends the login another app's deploy pulls
 * with at the same time.
 */
export function dockerConfig(plan: DeployPlan): string {
  return `${appDir(plan)}/.docker`;
}

/** Shown when the release command fails; names neither the server nor any secret. */
function releaseFailed(plan: DeployPlan): string {
  return `::error::The release command (app.releaseCommand in opscrew/plan.yaml) failed, so the new version was not started and the previous version keeps serving. Its output stays on the server in ${releaseLog(plan)} (it can quote data from the database, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the command or the app and push again.`;
}

/** How long kamal-proxy waits for the new copy to pass its health check. */
const DEPLOY_TIMEOUT_SECONDS = 60;

/**
 * How long kamal-proxy waits for the app to answer one request. Its default of 30 seconds would cut
 * long requests and uploads, which Caddy alone never did.
 */
const TARGET_TIMEOUT_SECONDS = 300;

const BUILDER_LABEL: Record<ImageBuilder, string> = {
  "generated-dockerfile": "the Dockerfile OpsCrew generates",
  "own-dockerfile": "your own Dockerfile",
  buildpacks: "Buildpacks",
  railpack: "Railpack",
};

/** How a changed builder reaches the workflow: design checks it, adapt and provision follow. */
const RERUN = "run opscrew design, opscrew adapt and opscrew provision";

/**
 * The failed-deploy hint (FR-1206): which builder made the image and its `opscrew/plan.yaml` line,
 * and, when design recorded another automatic choice (`app.build.automatic`), that builder and the
 * settings that switch to it: the builder with `app.build.chosen: user`, as design keeps a builder
 * only when it is the user's choice.
 */
function builderHint(plan: DeployPlan): string {
  const build = plan.app.build;
  if (build === undefined) {
    return `It was built from ${plan.app.dockerfile}; to let OpsCrew choose a builder, ${RERUN}.`;
  }
  const { builder, automatic } = build;
  const line = `(app.build.builder: ${builder} in opscrew/plan.yaml)`;
  if (automatic === builder) {
    return `It was built with ${BUILDER_LABEL[builder]}, the builder OpsCrew chooses for this app ${line}.`;
  }
  const built = `It was built with ${BUILDER_LABEL[builder]} ${line}.`;
  if (automatic === undefined) return built;
  return `${built} OpsCrew would choose ${BUILDER_LABEL[automatic]}: set app.build.builder: ${automatic} and app.build.chosen: user in opscrew/plan.yaml, then ${RERUN}.`;
}

/**
 * The services a deploy starts when they are not running, and never restarts unless their own
 * configuration changed: the plan's enabled services by name, after the one-shot containers that
 * set their host kernel settings (named here, since `--no-deps` starts no dependency).
 */
function steadyServices(plan: DeployPlan): string[] {
  return [
    ...hostSettingsServices(plan),
    ...plan.services.filter((service) => service.enabled).map((service) => service.name),
  ];
}

/** Where the output of a failed one-time setup step stays on the server, as {@link releaseLog}. */
function initLog(plan: DeployPlan): string {
  return `${appDir(plan)}/init.log`;
}

/**
 * A step of a service's one-time setup, from the catalog (for example MongoDB's replica set):
 * `run` executes in the running `service` only when `check` fails there, so a deploy skips the
 * steps an earlier one did. Both are argument lists for `docker compose exec`, which needs no
 * shell in the image.
 */
export interface ServiceInitStep {
  /** The Compose service, started by the deploy just before. */
  service: string;
  /** Exits 0 when the step is already done. */
  check: readonly string[];
  run: readonly string[];
}

/** `words` in the running `service`, without a TTY and with no stdin (the script arrives on it). */
function exec(service: string, words: readonly string[]): string {
  return `docker compose exec -T ${service} ${words.map(shellQuote).join(" ")} < /dev/null`;
}

/** Shown when a setup step fails; names the service only. */
function initFailed(service: string, log: string): string {
  return `::error::The one-time setup of the ${service} service failed, so the new version was not started and the previous version keeps serving. The step's output stays on the server in ${log} (it can quote a key, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the cause and push again. The steps already done are skipped.`;
}

/** The one-time setup steps in order, each run only when its check fails; a failure stops here. */
function serviceInit(steps: readonly ServiceInitStep[], log: string): string[] {
  return steps.flatMap(({ service, check, run }) => [
    `if ! ${exec(service, check)} > /dev/null 2>&1; then`,
    `  if ! (umask 077; ${exec(service, run)} > ${log} 2>&1); then`,
    `    echo ${shellQuote(initFailed(service, log))}`,
    "    exit 1",
    "  fi",
    "fi",
  ]);
}

/** The Compose services of the enabled workers, and `cron` when a cron job is enabled. */
export function processServices(plan: DeployPlan): string[] {
  return [
    ...plan.processes.workers.filter((worker) => worker.enabled).map((worker) => worker.name),
    ...(hasCronJobs(plan) ? ["cron"] : []),
  ];
}

/** How long every worker and cron container must keep running after the deploy starts it. */
const PROCESS_CHECK_SECONDS = 30;

/** printf's format for a worker that stopped: `%s` is its Compose service, twice. */
function processFailed(plan: DeployPlan): string {
  return `::error::The %s container did not keep running for ${PROCESS_CHECK_SECONDS} seconds after it started with the new version, so the deploy failed and OpsCrew puts the web and the workers back on the previous version, if there is one. Read its log on the server with \`docker compose logs %s\` in ${appDir(plan)} (opscrew/RUNBOOK.md has the SSH command), fix its command (processes in opscrew/plan.yaml) or the app, and push again.\\n`;
}

/**
 * Where the start script records, before the switch, which of the workers and cron had a running
 * container (one service per line), so the rollback restarts only those.
 */
const PREVIOUS_PROCESSES = ".processes.previous";

/** Writes {@link PREVIOUS_PROCESSES} for `services`; nothing without them. */
function recordProcesses(services: readonly string[]): string[] {
  if (services.length === 0) return [];
  return [
    `for service in ${services.join(" ")}; do`,
    '  if [ -n "$(docker compose ps -q "$service")" ]; then echo "$service"; fi',
    `done > ${PREVIOUS_PROCESSES}`,
  ];
}

/**
 * The rollback's workers and cron: those in {@link PREVIOUS_PROCESSES} start again on
 * `$APP_IMAGE`, the others stop, so a service this deploy added never runs on the old image.
 */
function restoreProcesses(services: readonly string[]): string[] {
  if (services.length === 0) return [];
  return [
    'up=""',
    'stop=""',
    `for service in ${services.join(" ")}; do`,
    `  if grep -qxF "$service" ${PREVIOUS_PROCESSES} 2> /dev/null; then up="$up $service"; else stop="$stop $service"; fi`,
    "done",
    'if [ -n "$up" ]; then docker compose up -d --no-deps $up; fi',
    'if [ -n "$stop" ]; then docker compose stop $stop; fi',
  ];
}

/**
 * Starts `services` (the workers and cron) on `$APP_IMAGE`; Compose recreates only those whose
 * image or settings changed. Then each container must stay running, with the restart count it
 * started with, for {@link PROCESS_CHECK_SECONDS}; otherwise the script names the first that did
 * not and exits 1.
 */
function startProcesses(plan: DeployPlan, services: readonly string[]): string[] {
  if (services.length === 0) return [];
  const each = [
    `for service in ${services.join(" ")}; do`,
    '  for id in $(docker compose ps -aq "$service"); do',
  ];
  return [
    `docker compose up -d --no-deps ${services.join(" ")}`,
    'started=""',
    ...each,
    `    started="$started $id=running:$(docker inspect --format '{{.RestartCount}}' "$id")"`,
    "  done",
    "done",
    `sleep ${PROCESS_CHECK_SECONDS}`,
    ...each,
    `    now="$id=$(docker inspect --format '{{.State.Status}}:{{.RestartCount}}' "$id")"`,
    '    case " $started " in *" $now "*) continue ;; esac',
    `    printf ${shellQuote(processFailed(plan))} "$service" "$service"`,
    "    exit 1",
    "  done",
    "done",
  ];
}

/** The edge's Compose project, from any folder: `edge up -d`, `edge exec -T kamal-proxy …`. */
const EDGE_FUNCTION = `edge() { docker compose -p ${EDGE_PROJECT} -f ${EDGE_DIR}/compose.yaml "$@"; }`;

/**
 * kamal-proxy's hostname for the app's service: the domain only, since the edge's proxy redirects
 * `www.<domain>` to `https://<domain>` itself (kamal-proxy's `--canonical-host` redirects to
 * `http://` behind a proxy that terminates TLS); none before the plan has a domain (the service
 * then gets every request).
 */
function proxyHosts(plan: DeployPlan): string {
  const [domain] = siteHosts(plan);
  return domain === undefined ? "" : ` --host ${domain}`;
}

/**
 * Switches traffic to a copy of `$APP_IMAGE` (POSIX sh, in the app's folder) and writes it to
 * `.env`. `rolling`: starts a second `app` container next to the running one; the edge's
 * kamal-proxy, where the app is the service `<app>` with its hostnames, sends it traffic once its
 * health check passes and drains the old one, which is then removed. `recreate`: replaces the
 * container, then hands it to kamal-proxy. The first deploy registers the first target the same
 * way. Containers of services the Compose file no longer has go with the new copy's start. When
 * the new copy never becomes healthy it is removed, `failed` is printed and the script exits 1.
 */
function switchApp(plan: DeployPlan, failed: string): string[] {
  const { strategy, drainSeconds } = plan.deploy;
  const kamal = [
    'name="$(docker inspect --format \'{{.Name}}\' "$new")"',
    `if ! edge exec -T kamal-proxy kamal-proxy deploy ${plan.app.name} --target "\${name#/}:${plan.app.port}"${proxyHosts(plan)} --health-check-path ${shellQuote(healthPath(plan))} --deploy-timeout ${DEPLOY_TIMEOUT_SECONDS}s --drain-timeout ${drainSeconds}s --target-timeout ${TARGET_TIMEOUT_SECONDS}s < /dev/null; then`,
    '  docker rm -f "$new" > /dev/null',
    `  echo ${shellQuote(failed)}`,
    "  exit 1",
    "fi",
  ];
  const writeEnv = "printf 'APP_IMAGE=%s\\n' \"$APP_IMAGE\" > .env";
  if (strategy === "recreate") {
    return [
      writeEnv,
      "docker compose up -d --no-deps --remove-orphans app",
      'new="$(docker compose ps -aq app)"',
      ...kamal,
    ];
  }
  return [
    "old=\"$(docker compose ps -aq app | tr '\\n' ' ')\"",
    'docker compose up -d --no-deps --no-recreate --remove-orphans --scale "app=$(( $(echo $old | wc -w) + 1 ))" app',
    'new=""',
    "for id in $(docker compose ps -aq app); do",
    '  case " $old " in *" $id "*) ;; *) new="$id" ;; esac',
    "done",
    ...kamal,
    writeEnv,
    "for id in $old; do",
    '  docker stop "$id" > /dev/null',
    '  docker rm "$id" > /dev/null',
    "done",
  ];
}

/** Why a new copy failed: it got no traffic (rolling), what to check, and the builder hint. */
function healthFailed(plan: DeployPlan): string {
  const path = healthPath(plan);
  const traffic =
    plan.deploy.strategy === "rolling"
      ? " It received no traffic: the previous version keeps serving."
      : "";
  return `::error::The new version did not pass its health check (GET ${path} on port ${plan.app.port}) within ${DEPLOY_TIMEOUT_SECONDS} seconds, so OpsCrew removed it.${traffic} Check that the app listens on port ${plan.app.port} (app.port in opscrew/plan.yaml, passed to the app as PORT) and answers ${path}. ${builderHint(plan)}`;
}

/** The app's site as the server had it before this deploy, while the edge takes the new one. */
const PREVIOUS_SITE = ".site.previous";

/** The app's additions as the server had them before this deploy, as {@link PREVIOUS_SITE}. */
const PREVIOUS_ADDITIONS = ".additions.previous";

/** The server's edge Compose file before this deploy switched its proxy. */
const PREVIOUS_EDGE = ".edge.previous";

/** The app's site file in the repository, for the messages. */
function siteFile(plan: DeployPlan): string {
  return `opscrew/runtime/edge/sites/${plan.app.name}.${EDGE_PROXIES[edgeProxy(plan)].site}`;
}

/** Shown when the edge did not start or refused the app's site; names no server and no secret. */
function edgeFailed(plan: DeployPlan, additions: boolean): string {
  const { label, additions: file } = EDGE_PROXIES[edgeProxy(plan)];
  const yours = additions ? ` or your additions (${file})` : "";
  return `::error::OpsCrew's shared edge on the server (${label} and kamal-proxy, in ${EDGE_DIR}) did not start or did not accept this app's site (${siteFile(plan)})${yours}, so the new version was not started, the previous version keeps serving and ${label} keeps the site it had. The error is above: fix its cause (for example a port another program uses, or a hostname another app on the server serves) and push again.`;
}

/**
 * Shown when the deploy switches the server's proxy (research.md R5): the interruption, which the
 * plan stated before its approval.
 */
function switchNotice(plan: DeployPlan): string {
  const to = EDGE_PROXIES[edgeProxy(plan)].label;
  const from = EDGE_PROXIES[otherProxy(edgeProxy(plan))].label;
  const issuer = edgeProxy(plan) === "nginx" ? "certbot gets" : "Caddy gets";
  return `::notice::OpsCrew switches this server's proxy from ${from} to ${to} (target.edge in opscrew/plan.yaml). kamal-proxy and the apps keep running; the sites stop for a few seconds while ${to} starts, and hostnames not proxied by Cloudflare have no HTTPS for under a minute while ${issuer} their certificates.`;
}

/** Shown when the switch failed and the server's previous proxy is back. */
function switchFailed(plan: DeployPlan): string {
  const to = EDGE_PROXIES[edgeProxy(plan)].label;
  const from = EDGE_PROXIES[otherProxy(edgeProxy(plan))].label;
  return `::error::The switch to ${to} did not work, so the server keeps ${from} as its proxy.`;
}

/**
 * Let's Encrypt's limits that a failed first certificate can meet (https://letsencrypt.org/docs/rate-limits/,
 * checked 2026-10-21).
 */
const LETS_ENCRYPT_LIMITS =
  "Let's Encrypt issues at most 5 certificates a week for the same hostnames and allows 5 failed validations an hour for each hostname: when certbot's reason names a rate limit, wait until it passes, then push again. Otherwise check that the hostnames' DNS records point to this server and that port 80 reaches it, then push again.";

/**
 * Shown when certbot did not get the app's certificate; `site` says what visitors get meanwhile.
 */
function certbotFailed(hosts: readonly string[], site: string): string {
  return `::error::certbot could not get the certificate for ${hosts.join(", ")}, so ${site}, and the new version was not started. certbot's reason is above. ${LETS_ENCRYPT_LIMITS}`;
}

/** Shown when nginx refused the site with certbot's new certificate, after certbot got it. */
function tlsSiteFailed(plan: DeployPlan): string {
  return `::error::nginx did not accept this app's site (${siteFile(plan)}) with certbot's certificate, so the site it had stays (on HTTP only before its first certificate), and the new version was not started. nginx's error is above: fix its cause and push again.`;
}

/** The app's origin TLS files in `/srv/edge/tls/<app>`, as a shell word list. */
const TLS_FILES = "origin.pem origin.key pull.pem";

/** How the deploy reloads the server's proxy: each keeps its running configuration on an error. */
const RELOAD: Record<EdgeProxy, string> = {
  caddy:
    "edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null",
  nginx: "edge exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null",
};

/** What the upload left for the app's edge besides its site. */
export interface EdgeFiles {
  /**
   * The upload left the app's origin certificate and key in `/srv/edge/tls/<app>/` as
   * `origin.pem.new` and `origin.key.new`, and `pull.pem` in the app's `edge/tls/`.
   */
  originTls: boolean;
  /** The upload left the user's additions in the app's folder (`additions.caddy` or `.nginx`). */
  additions: boolean;
  /**
   * nginx: the hostnames certbot gets the app's certificate for, and the account's contact email;
   * the upload left the app's site before its first certificate as `edge/sites/<app>.http.conf`.
   */
  certbot?: { hosts: readonly string[]; email?: string | undefined } | undefined;
}

/**
 * The shared edge, under a lock other apps' deploys wait for:
 * 1. creates the network `opscrew-edge` when missing; on nginx, writes the deploy user's uid and
 *    gid to `/srv/edge/.env`, which the edge's Compose file runs nginx and certbot as;
 * 2. puts the uploaded edge Compose file (`edge/compose.yaml` in the app's folder) in `/srv/edge`
 *    when the server's runs the other proxy (the switch, offered only while the server holds this
 *    one OpsCrew app), when its {@link EDGE_VERSION_KEY} is larger than the server's, so an app
 *    with an older OpsCrew never downgrades the edge, or when it is the same version with other
 *    content (the ports of another access mode, or Cloudflare's addresses, which all the server's
 *    apps share);
 * 3. puts the app's new origin certificate, its key and `pull.pem` in `/srv/edge/tls/<app>`, so no
 *    other app's reload sees a certificate without its key, or, without origin TLS, takes the
 *    app's old ones out;
 * 4. on nginx, gives the deploy user certbot's volumes (Docker creates them owned by root);
 * 5. puts the app's site and its additions in `/srv/edge/sites`, or takes old additions out; on
 *    nginx with certbot's hostnames, the site before the first certificate until certbot has it;
 * 6. starts the edge (Compose recreates only what changed, and removes the other proxy's
 *    containers after a switch) and reloads the proxy;
 * 7. on nginx with certbot's hostnames, certbot gets or renews the app's certificate (the first
 *    one, and hostnames added since; once more when another certbot held its lock), then the HTTPS
 *    site goes in;
 * 8. the other proxy's site file of the app goes, and the app's earlier origin TLS files.
 *
 * When the start or the reload fails, the app's previous site, additions and origin TLS files go
 * back (or the new ones go, when it had none), so the proxy never keeps a site it refused. After a
 * switch, any failure, also certbot's, puts the previous proxy back with its files, so it serves
 * HTTPS as before.
 */
function edgeCommands(plan: DeployPlan, o: EdgeFiles): string[] {
  const proxy = edgeProxy(plan);
  const { site: ext } = EDGE_PROXIES[proxy];
  const from = EDGE_PROXIES[otherProxy(proxy)].label;
  const app = plan.app.name;
  const site = `${EDGE_DIR}/sites/${app}.${ext}`;
  const additions = `${EDGE_DIR}/sites/${app}.additions`;
  const tls = `${EDGE_DIR}/tls/${app}`;
  const stamp = (key: string, file: string) => `sed -n 's/^${key}: //p' ${file}`;
  /** Puts `previous` back as `file`, or removes `file` when it had none. */
  const restore = (previous: string, file: string) =>
    `if [ -f ${previous} ]; then cp ${previous} ${file}; else rm -f ${file}; fi`;
  /** The app's previous site, additions and origin TLS files back, indented by `pad`. */
  const restoreFiles = (pad: string) =>
    [
      restore(PREVIOUS_SITE, site),
      restore(PREVIOUS_ADDITIONS, additions),
      `for f in ${TLS_FILES}; do`,
      `  if [ -f ${tls}/$f.previous ]; then mv -f ${tls}/$f.previous ${tls}/$f; else rm -f ${tls}/$f; fi`,
      "done",
    ].map((line) => `${pad}${line}`);
  /** After a switch: the server's previous edge file back, which starts its proxy again. */
  const restoreEdge = (pad: string) =>
    [
      `cp ${PREVIOUS_EDGE} ${EDGE_DIR}/compose.yaml`,
      "edge up -d --wait --remove-orphans || true",
    ].map((line) => `${pad}${line}`);
  const certbot = proxy === "nginx" && o.certbot !== undefined && o.certbot.hosts.length > 0;
  /** A one-off container of the edge's certbot service. */
  const certbotRun = (args: string) => `edge run --rm --no-deps -T ${args} < /dev/null`;
  const nginxFiles =
    proxy === "nginx"
      ? [
          `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > ${EDGE_DIR}/.env`,
        ]
      : [];
  const installSite = certbot
    ? [
        `  if ${certbotRun(`--entrypoint test certbot -f ${certbotLive(app)}/fullchain.pem`)}; then`,
        `    cp edge/sites/${app}.conf ${site}`,
        "    first=0",
        "  else",
        `    cp edge/sites/${app}.http.conf ${site}`,
        "    first=1",
        "  fi",
      ]
    : [`  cp edge/sites/${app}.${ext} ${site}`];
  let certificate: string[] = [];
  if (certbot && o.certbot !== undefined) {
    const hosts = o.certbot.hosts;
    // certbot's output is kept to tell its lock apart, and printed: it holds certbot's reason.
    const certonly = `out="$(${certbotRun(`--entrypoint certbot certbot ${certbotCertonly(app, hosts, o.certbot.email)}`)} 2>&1)" || status=$?`;
    certificate = [
      "  status=0",
      `  ${certonly}`,
      '  case "$status:$out" in',
      "    0:*) ;;",
      `    *${shellQuote(CERTBOT_LOCKED)}*)`,
      `      printf '%s\\n' "$out"`,
      "      sleep 10",
      "      status=0",
      `      ${certonly}`,
      "      ;;",
      "  esac",
      `  printf '%s\\n' "$out"`,
      '  if [ "$status" -ne 0 ]; then',
      `    if [ -f ${PREVIOUS_EDGE} ]; then`,
      ...restoreFiles("      "),
      ...restoreEdge("      "),
      `      echo ${shellQuote(certbotFailed(hosts, `the server keeps ${from} as its proxy`))}`,
      '    elif [ "$first" -eq 1 ]; then',
      `      echo ${shellQuote(certbotFailed(hosts, "the site stays on HTTP only"))}`,
      "    else",
      `      echo ${shellQuote(certbotFailed(hosts, "the site keeps its current certificate (which may not cover every hostname)"))}`,
      "    fi",
      "    exit 1",
      "  fi",
      `  ${certbotRun(`--entrypoint sh certbot -c ${shellQuote(certbotRenewBefore(app))}`)}`,
      `  cp edge/sites/${app}.conf ${site}`,
      `  if ! ${RELOAD.nginx}; then`,
      `    if [ -f ${PREVIOUS_EDGE} ]; then`,
      ...restoreFiles("      "),
      ...restoreEdge("      "),
      `      echo ${shellQuote(switchFailed(plan))}`,
      `    elif [ "$first" -eq 0 ] && [ -f ${PREVIOUS_SITE} ]; then`,
      `      cp ${PREVIOUS_SITE} ${site}`,
      `      ${RELOAD.nginx} || true`,
      "    else",
      `      cp edge/sites/${app}.http.conf ${site}`,
      `      ${RELOAD.nginx} || true`,
      "    fi",
      `    echo ${shellQuote(tlsSiteFailed(plan))}`,
      "    exit 1",
      "  fi",
    ];
  }
  return [
    // Before the edge's Compose mounts them: Docker would create them owned by root.
    `mkdir -p ${EDGE_DIR}/sites ${EDGE_DIR}/tls`,
    "(",
    "  flock 9",
    `  docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    ...nginxFiles,
    `  uploaded="$(${stamp(EDGE_VERSION_KEY, "edge/compose.yaml")})"`,
    `  current="$(${stamp(EDGE_VERSION_KEY, `${EDGE_DIR}/compose.yaml`)} 2> /dev/null || true)"`,
    `  proxy="$(${stamp(EDGE_PROXY_KEY, `${EDGE_DIR}/compose.yaml`)} 2> /dev/null || true)"`,
    `  rm -f ${PREVIOUS_EDGE}`,
    `  if [ -n "$proxy" ] && [ "$proxy" != ${proxy} ]; then`,
    `    echo ${shellQuote(switchNotice(plan))}`,
    `    cp ${EDGE_DIR}/compose.yaml ${PREVIOUS_EDGE}`,
    `    cp edge/compose.yaml ${EDGE_DIR}/compose.yaml`,
    '  elif [ "$uploaded" -gt "${current:-0}" ]; then',
    `    cp edge/compose.yaml ${EDGE_DIR}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server is now version $uploaded."`,
    // The same version with other content: how the server's apps are served changed (they all are
    // served the same way, the host plan refuses anything else), or Cloudflare's addresses did, so
    // this app's copy is the one.
    `  elif [ "$uploaded" -eq "\${current:-0}" ] && ! cmp -s edge/compose.yaml ${EDGE_DIR}/compose.yaml; then`,
    `    cp edge/compose.yaml ${EDGE_DIR}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server now has this app's settings (its ports, and the Cloudflare addresses it trusts)."`,
    '  elif [ "$uploaded" -lt "${current:-0}" ]; then',
    `    echo "The server's shared edge (version $current) is newer than this app's ($uploaded), so it stays."`,
    "  fi",
    // Each file the server has is kept as `<file>.previous` (a stale one goes when it has none),
    // and the uploaded one, if any, takes its place.
    ...(o.originTls ? [`  cp edge/tls/pull.pem ${tls}/pull.pem.new`] : []),
    `  for f in ${TLS_FILES}; do`,
    `    if [ -f ${tls}/$f ]; then mv -f ${tls}/$f ${tls}/$f.previous; else rm -f ${tls}/$f.previous; fi`,
    ...(o.originTls ? [`    mv -f ${tls}/$f.new ${tls}/$f`] : []),
    "  done",
    ...(proxy === "nginx"
      ? [
          `  ${certbotRun(`--user 0:0 --cap-add CHOWN --entrypoint chown certbot "$(id -u):$(id -g)" ${LETSENCRYPT} ${ACME_WEBROOT} ${RELOAD_DIR}`)}`,
        ]
      : []),
    `  rm -f ${PREVIOUS_SITE} ${PREVIOUS_ADDITIONS}`,
    `  if [ -f ${site} ]; then cp ${site} ${PREVIOUS_SITE}; fi`,
    `  if [ -f ${additions} ]; then cp ${additions} ${PREVIOUS_ADDITIONS}; fi`,
    ...installSite,
    o.additions ? `  cp additions.${proxy} ${additions}` : `  rm -f ${additions}`,
    `  if ! edge up -d --wait --remove-orphans || ! ${RELOAD[proxy]}; then`,
    ...restoreFiles("    "),
    `    if [ -f ${PREVIOUS_EDGE} ]; then`,
    ...restoreEdge("      "),
    `      echo ${shellQuote(switchFailed(plan))}`,
    "    fi",
    `    echo ${shellQuote(edgeFailed(plan, o.additions))}`,
    "    exit 1",
    "  fi",
    ...certificate,
    // Only now: a switch that failed above puts the previous proxy back with these files.
    `  rm -f ${EDGE_DIR}/sites/${app}.${EDGE_PROXIES[otherProxy(proxy)].site}`,
    o.originTls
      ? `  rm -f ${TLS_FILES.split(" ")
          .map((f) => `${tls}/${f}.previous`)
          .join(" ")}`
      : `  rm -rf ${tls}`,
    `) 9> ${EDGE_DIR}/.lock`,
  ];
}

/**
 * The server script of the start step (POSIX sh, in the app's folder `/srv/apps/<app>`; the image
 * is `$1`, already checked to be a GHCR digest reference), in this order:
 * 1. pull the app's images;
 * 2. the shared edge with the app's site and the `edgeFiles` the upload left ({@link edgeCommands});
 * 3. start the plan's services when they are not running (Compose recreates one only when its own
 *    configuration changed; nothing forces it);
 * 4. the services' one-time setup, `init` (the catalog's steps, see {@link ServiceInitStep});
 * 5. the release command in a one-off container of the new image;
 * 6. the switch to the new image by `deploy.strategy` (`recreate` for SQLite apps), after recording
 *    which workers and cron run ({@link PREVIOUS_PROCESSES});
 * 7. the workers and cron on the new image;
 * 8. a check that every worker and cron container keeps running for 30 seconds.
 * A failure before the switch leaves the running version untouched; after it, the workflow's
 * rollback ({@link rollbackCommands}) puts the web and the workers back. The services are never
 * named after the setup, and no Compose command names another app's folder or project. The script
 * reaches `sh` on its stdin, so the commands that read stdin (`docker compose exec` and `run`) get
 * `/dev/null`; otherwise they would swallow the rest of the script.
 */
export function switchCommands(
  plan: DeployPlan,
  init: readonly ServiceInitStep[],
  edgeFiles: EdgeFiles = { originTls: false, additions: false },
): string[] {
  const steady = steadyServices(plan);
  const release =
    plan.app.releaseCommand === undefined
      ? []
      : [
          `if ! (umask 077; docker compose run --rm --no-deps -T release < /dev/null > ${releaseLog(plan)} 2>&1); then`,
          `  echo ${shellQuote(releaseFailed(plan))}`,
          "  exit 1",
          "fi",
          `echo ${shellQuote(`The release command finished; its output is in ${releaseLog(plan)} on the server.`)}`,
        ];
  return [
    "set -eu",
    `export DOCKER_CONFIG=${dockerConfig(plan)}`,
    "trap 'docker logout ghcr.io > /dev/null 2>&1' EXIT",
    `cd ${appDir(plan)}`,
    'export APP_IMAGE="$1"',
    EDGE_FUNCTION,
    "docker compose pull",
    ...edgeCommands(plan, edgeFiles),
    ...(steady.length === 0 ? [] : [`docker compose up -d --no-deps --wait ${steady.join(" ")}`]),
    ...serviceInit(init, initLog(plan)),
    ...release,
    // Before the switch: `recreate` writes `.env` first, and from then on the rollback acts.
    ...recordProcesses(processServices(plan)),
    ...switchApp(plan, healthFailed(plan)),
    ...startProcesses(plan, processServices(plan)),
  ];
}

/**
 * The server script of the rollback (POSIX sh; the failed image is `$1`): when `.env` names it and
 * `.env.previous` holds another image, switches the web back to that one the same way as the
 * deploy, starts on it the workers and cron that ran before the deploy and stops the others, and
 * prints `restored`; prints `unchanged` when this run never switched, `no-previous` when there is
 * nothing to go back to, and nothing when the switch back failed.
 */
export function rollbackCommands(plan: DeployPlan): string[] {
  return [
    "set -eu",
    `cd ${appDir(plan)}`,
    EDGE_FUNCTION,
    'if ! grep -qxF "APP_IMAGE=$1" .env 2> /dev/null; then echo unchanged; exit 0; fi',
    "if [ ! -f .env.previous ] || cmp -s .env .env.previous; then echo no-previous; exit 0; fi",
    "APP_IMAGE=\"$(sed -n 's/^APP_IMAGE=//p' .env.previous)\"",
    "export APP_IMAGE",
    "{",
    ...[
      ...switchApp(plan, "::error::The previous version did not pass its health check either."),
      ...restoreProcesses(processServices(plan)),
    ].map((line) => `  ${line}`),
    "} >&2",
    `rm -f .env.previous ${PREVIOUS_PROCESSES}`,
    "echo restored",
  ];
}
