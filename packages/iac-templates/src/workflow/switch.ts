// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { APP_SERVER, type DeployPlan, type ImageBuilder, servicesOn } from "@opscrew/plan-schema";
import {
  APPS_DIR,
  additionsPath,
  appDir,
  EDGE_DIR,
  EDGE_PROJECT,
  EDGE_PROXIES,
  EDGE_PROXY_KEY,
  EDGE_VERSION_KEY,
  type EdgeProxy,
  edgeProxy,
  type LocalhostSite,
  otherProxy,
} from "../edge";
import { LOCALHOST_TLS, localhostSite } from "../edge/localhost";
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
import { runtimeDir } from "../runtime-dir";
import { migrationDown, migrationRecord } from "./migrations";
import { portRepair } from "./servers";
import {
  appFlag,
  hasCronJobs,
  healthPath,
  opscrew,
  planFilePath,
  printfFormat,
  RELEASE_LOG,
  runbookFilePath,
  serverLogNote,
} from "./shared";
import {
  ROLLBACK_APPROVAL_FILE,
  SNAPSHOT_FUNCTIONS,
  SNAPSHOT_LOG,
  SNAPSHOTS_DIR,
  snapshotParts,
  snapshotScheduleLines,
  snapshotStep,
  snapshotTakenPath,
} from "./snapshots";

/**
 * The first lines of every script (contracts/localhost.md "The script roots"): the apps' and the
 * edge's folders, a server's unless the local executor names this computer's in
 * `OPSCREW_APPS_DIR` and `OPSCREW_EDGE_DIR`. Every path the scripts use is built from them.
 */
export const SCRIPT_ROOTS = [
  `APPS_DIR="\${OPSCREW_APPS_DIR:-${APPS_DIR}}"`,
  `EDGE_DIR="\${OPSCREW_EDGE_DIR:-${EDGE_DIR}}"`,
];

/** The apps' folder in a script. */
const APPS = '"$APPS_DIR"';

/** The edge's folder in a script. */
const EDGE = '"$EDGE_DIR"';

/** The app's folder in a script: `"$APPS_DIR"/<app>`. */
export function appFolder(plan: DeployPlan): string {
  return `${APPS}/${plan.app.name}`;
}

/**
 * `text` as one shell word ({@link shellQuote}) in which the scripts' roots ({@link APPS},
 * {@link EDGE}) are expanded, so a message names the folders the script uses.
 */
function shellMessage(text: string): string {
  return shellQuote(text).replace(/"\$(?:APPS|EDGE)_DIR"/g, (root) => `'${root}'`);
}

/**
 * Where the release command's output stays: on the server, readable only by the deploy user. It is
 * never printed in the workflow log, which is public for public repositories, because a failed
 * migration can quote rows of the database.
 */
function releaseLog(plan: DeployPlan): string {
  return `${appFolder(plan)}/${RELEASE_LOG}`;
}

/**
 * The app's own Docker client settings on the server (`DOCKER_CONFIG`), where its deploy logs in
 * to the registry and out again: one app's logout never ends the login another app's deploy pulls
 * with at the same time.
 */
export function dockerConfig(plan: DeployPlan): string {
  return `${appDir(plan)}/.docker`;
}

/**
 * Shown when the release command fails (FR-1912): where its output is, what a migration that
 * stopped partway means, and the ways forward; names neither the server nor any secret.
 */
function releaseFailed(plan: DeployPlan): string {
  return `::error::The release command (app.releaseCommand in ${planFilePath(plan)}) failed, so the new version was not started and the previous version keeps serving. Its output stays on the server in ${releaseLog(plan)} (it can quote data from the database, so it is not printed here; ${runbookFilePath(plan)} has the SSH command). A migration that stopped partway may have applied some of its changes, and the previous version now runs with them: read release.log to see how far it got, then fix the migration and push again to deploy forward, or restore a backup taken before this deploy.`;
}

/** Printed by a rollback's start script instead of running the release command. */
const NO_RELEASE = "A rollback runs no release command: the data and the schema stay as they are.";

/**
 * The folder in the app's folder where the deploy keeps the last failed copy's lines: `about`
 * (`image=`, `time=` in UTC, `failed=` `health`, `process <name>`, `start` or `check`) and
 * `<service>.log`.
 */
export const FAILED_DEPLOY_DIR = ".failed-deploy";

/** How many of a failed container's last lines the deploy keeps. */
const FAILED_LINES = 500;

/**
 * Where the start script records how far this run got, in the app's folder: `started`, then
 * `finished` when it succeeds, or `kept` once the run kept a failure's lines (`keep_failed`). The
 * rollback reads it to tell what failed.
 */
const START_OUTCOME = ".start.outcome";

/**
 * `keep_failed <service> <container> <why>`: writes the container's last lines (both streams, with
 * Docker's timestamps) to `<service>.log` in {@link FAILED_DEPLOY_DIR}, then `about` for this run's
 * image (`$RUN_IMAGE`), readable by the deploy user only (umask 077, as `release.log`). The first
 * lines a run keeps clear what an earlier run kept, of any image; then {@link START_OUTCOME} says
 * `kept`. It never fails the script: keeping the lines changes nothing in what the deploy or the
 * rollback does.
 */
function keepFailed(plan: DeployPlan): string[] {
  const dir = `${appFolder(plan)}/${FAILED_DEPLOY_DIR}`;
  return [
    "keep_failed() {",
    "  (",
    "    umask 077",
    `    grep -qxF kept ${START_OUTCOME} 2> /dev/null || rm -rf ${dir}`,
    `    mkdir -p ${dir}`,
    `    docker logs --timestamps --tail ${FAILED_LINES} "$2" > ${dir}/"$1".log 2>&1`,
    `    printf 'image=%s\\ntime=%s\\nfailed=%s\\n' "$RUN_IMAGE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > ${dir}/about`,
    `    echo kept > ${START_OUTCOME}`,
    "  ) || true",
    "}",
  ];
}

/**
 * `opscrew logs --failed` for the plan's app and environment ({@link opscrew}), with
 * `--service <service>` when given.
 */
function failedLogs(plan: DeployPlan, service?: string): string {
  return opscrew(plan, `logs --failed${service === undefined ? "" : ` --service ${service}`}`);
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

/**
 * How a changed builder reaches the workflow: design checks it, adapt and provision follow, each
 * with a further app's `--app <key>` ({@link appFlag}).
 */
function rerun(plan: DeployPlan): string {
  const app = appFlag(plan);
  return `run opscrew design${app}, opscrew adapt${app} and opscrew provision${app}`;
}

/**
 * The failed-deploy hint (FR-1206): which builder made the image and its `opscrew/plan.yaml` line,
 * and, when design recorded another automatic choice (`app.build.automatic`), that builder and the
 * settings that switch to it: the builder with `app.build.chosen: user`, as design keeps a builder
 * only when it is the user's choice.
 */
function builderHint(plan: DeployPlan): string {
  const build = plan.app.build;
  if (build === undefined) {
    return `It was built from ${plan.app.dockerfile}; to let OpsCrew choose a builder, ${rerun(plan)}.`;
  }
  const { builder, automatic } = build;
  const line = `(app.build.builder: ${builder} in ${planFilePath(plan)})`;
  if (automatic === builder) {
    return `It was built with ${BUILDER_LABEL[builder]}, the builder OpsCrew chooses for this app ${line}.`;
  }
  const built = `It was built with ${BUILDER_LABEL[builder]} ${line}.`;
  if (automatic === undefined) return built;
  return `${built} OpsCrew would choose ${BUILDER_LABEL[automatic]}: set app.build.builder: ${automatic} and app.build.chosen: user in ${planFilePath(plan)}, then ${rerun(plan)}.`;
}

/**
 * The services a deploy starts when they are not running, and never restarts unless their own
 * configuration changed: the plan's enabled services on the app's server by name, after the
 * one-shot containers that set their host kernel settings (named here, since `--no-deps` starts no
 * dependency).
 */
function steadyServices(plan: DeployPlan): string[] {
  return [
    ...hostSettingsServices(plan),
    ...servicesOn(plan, APP_SERVER).map((service) => service.name),
  ];
}

/** Where the output of a failed one-time setup step stays on the server, as {@link releaseLog}. */
function initLog(plan: DeployPlan): string {
  return `${appFolder(plan)}/init.log`;
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
function initFailed(plan: DeployPlan, service: string, log: string, server: string): string {
  const where =
    server === APP_SERVER
      ? `on the server in ${log} (it can quote a key, so it is not printed here; ${runbookFilePath(plan)} has the SSH command)`
      : `on the server ${server} in ${log} (it can quote a key, so it is not printed here)`;
  return `::error::The one-time setup of the ${service} service failed, so the new version was not started and the previous version keeps serving. The step's output stays ${where}: fix the cause and push again. The steps already done are skipped.`;
}

/**
 * The one-time setup steps in order on `server` (the app's or an extra one, which the failure
 * message names), each run only when its check fails; a failure stops here.
 */
function serviceInit(
  plan: DeployPlan,
  steps: readonly ServiceInitStep[],
  log: string,
  server: string = APP_SERVER,
): string[] {
  return steps.flatMap(({ service, check, run }) => [
    `if ! ${exec(service, check)} > /dev/null 2>&1; then`,
    `  if ! (umask 077; ${exec(service, run)} > ${log} 2>&1); then`,
    `    echo ${shellMessage(initFailed(plan, service, log, server))}`,
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

/**
 * printf's format for a worker that stopped: `%s` is its Compose service, twice. It points to the
 * worker's kept lines, since after the switch back its Compose logs are the previous version's.
 */
function processFailed(plan: DeployPlan): string {
  return `::error::The %s container did not keep running for ${PROCESS_CHECK_SECONDS} seconds after it started with the new version, so the deploy failed and OpsCrew puts the web and the workers back on the previous version, if there is one. Read its last lines, from before OpsCrew put the previous version back, with \`${failedLogs(plan, "%s")}\`, then fix its command (processes in ${planFilePath(plan)}) or the app, and push again.\\n`;
}

/**
 * Where the start script records, before the switch, which of the workers and cron had a running
 * container (one service per line), so the rollback restarts only those.
 */
const PREVIOUS_PROCESSES = ".processes.previous";

/** Writes {@link PREVIOUS_PROCESSES} for `services`; nothing without them. */
export function recordProcesses(services: readonly string[]): string[] {
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
 * not, keeps its container's lines (`keep_failed`) and exits 1.
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
    `    printf ${shellMessage(processFailed(plan))} "$service" "$service"`,
    '    keep_failed "$service" "$id" "process $service"',
    "    exit 1",
    "  done",
    "done",
  ];
}

/**
 * Stops the app's web, workers and cron, the containers of its image ({@link processServices}),
 * as the data under them changes.
 */
export function stopApp(plan: DeployPlan): string {
  return `docker compose stop ${["app", ...processServices(plan)].join(" ")}`;
}

/**
 * Starts the stopped web again, with the workers and cron that ran ({@link PREVIOUS_PROCESSES},
 * which {@link recordProcesses} wrote before {@link stopApp}).
 */
export function startApp(plan: DeployPlan): string {
  const processes = processServices(plan).length > 0;
  return `docker compose start app${processes ? ` $(cat ${PREVIOUS_PROCESSES} 2> /dev/null || true)` : ""}`;
}

/** The edge's Compose project, from any folder: `edge up -d`, `edge exec -T kamal-proxy …`. */
export const EDGE_FUNCTION = `edge() { docker compose -p ${EDGE_PROJECT} -f ${EDGE}/compose.yaml "$@"; }`;

/**
 * kamal-proxy's hostname for the app's service: the domain only, since the edge's proxy redirects
 * `www.<domain>` to `https://<domain>` itself (kamal-proxy's `--canonical-host` redirects to
 * `http://` behind a proxy that terminates TLS); none before the plan has a domain (the service
 * then gets every request). On this computer, the app's hostname there (`localhost`).
 */
function proxyHosts(plan: DeployPlan, localhost: LocalhostSite | undefined): string {
  const [domain] =
    plan.target.provider === "localhost" ? [localhostSite(localhost).hostname] : siteHosts(plan);
  return domain === undefined ? "" : ` --host ${domain}`;
}

/**
 * How long kamal-proxy holds a request while a recreate replaces the app: the default drain (30
 * seconds) and the new copy's health check ({@link DEPLOY_TIMEOUT_SECONDS}), below the 100 seconds
 * Cloudflare's proxy waits for an answer.
 */
const MAX_PAUSE_SECONDS = 90;

/** `kamal-proxy <words>` in the edge's kamal-proxy, with no stdin (the script arrives on it). */
function kamalProxy(words: string): string {
  return `edge exec -T kamal-proxy kamal-proxy ${words} < /dev/null`;
}

/**
 * The lock in the app's folder (fd 7) that the start script holds for its whole run and the
 * rollback script takes before it reads anything: a cancelled run's start script can go on on
 * the server after the workflow moved on to its rollback step. Neither the edge's lock nor this
 * computer's deploy lock (`OPSCREW_LOCAL_LOCK`, outside the app's folder) is this file.
 */
const START_LOCK = ".start.lock";

/** How long the rollback script waits for the start script's lock. */
const START_LOCK_WAIT_SECONDS = 900;

/**
 * Takes {@link START_LOCK}: the start script waits as long as it takes; the rollback script, with
 * `timedOut` (its message), waits {@link START_LOCK_WAIT_SECONDS} and then stops, changing
 * nothing. On this computer only where `flock` exists, as the edge's lock.
 */
export function startLock(plan: DeployPlan, timedOut?: string): string[] {
  const take =
    timedOut === undefined
      ? "flock 7"
      : `flock -w ${START_LOCK_WAIT_SECONDS} 7 || { echo ${shellQuote(timedOut)} >&2; exit 1; }`;
  return [
    `exec 7> ${START_LOCK}`,
    plan.target.provider === "localhost"
      ? `if command -v flock > /dev/null 2>&1; then ${take}; fi`
      : take,
  ];
}

/** What the start script's EXIT trap runs: the registry logout of the app's own Docker settings. */
const LOGOUT = "docker logout ghcr.io > /dev/null 2>&1";

/**
 * kamal-proxy holds the app's requests (the requests in flight finish, new ones wait up to
 * {@link MAX_PAUSE_SECONDS}), and the script's EXIT trap, which also runs `onExit`, resumes them on
 * every exit, since kamal-proxy keeps a pause even across its restarts. A service kamal-proxy does
 * not have yet (the first deploy) has nothing to hold, and the script goes on.
 */
export function holdRequests(plan: DeployPlan, onExit: readonly string[]): string[] {
  const app = plan.app.name;
  // Resuming a service that is not paused, or that kamal-proxy does not have, changes nothing.
  const trap = [`${kamalProxy(`resume ${app}`)} > /dev/null 2>&1 || true`, ...onExit].join("; ");
  return [
    `trap '${trap}' EXIT`,
    `${kamalProxy(`pause ${app} --drain-timeout ${plan.deploy.drainSeconds}s --max-pause ${MAX_PAUSE_SECONDS}s`)} > /dev/null 2>&1 || true`,
  ];
}

/**
 * Switches traffic to a copy of `$APP_IMAGE` (POSIX sh, in the app's folder) and writes it to
 * `.env`. `rolling`: starts a second `app` container next to the running one; the edge's
 * kamal-proxy, where the app is the service `<app>` with its hostnames, sends it traffic once its
 * health check passes and drains the old one, which is then removed. `recreate`: kamal-proxy
 * holds the service's requests ({@link holdRequests}, with `onExit`, the script's own trap
 * commands), the container is replaced and handed to kamal-proxy, and the service resumes. The
 * first deploy registers the first target the same way. Containers of
 * services the Compose file no longer has go with the new copy's start. When the new copy never
 * becomes healthy, the `failed` lines run (they print why), the copy is removed and the script
 * exits 1. `hosts` are kamal-proxy's for the service ({@link proxyHosts}).
 */
function switchApp(
  plan: DeployPlan,
  hosts: string,
  failed: readonly string[],
  onExit: readonly string[] = [],
): string[] {
  const { strategy, drainSeconds } = plan.deploy;
  const app = plan.app.name;
  const kamal = [
    'name="$(docker inspect --format \'{{.Name}}\' "$new")"',
    `if ! ${kamalProxy(`deploy ${app} --target "\${name#/}:${plan.app.port}"${hosts} --health-check-path ${shellQuote(healthPath(plan))} --deploy-timeout ${DEPLOY_TIMEOUT_SECONDS}s --drain-timeout ${drainSeconds}s --target-timeout ${TARGET_TIMEOUT_SECONDS}s`)}; then`,
    ...failed.map((line) => `  ${line}`),
    '  docker rm -f "$new" > /dev/null',
    "  exit 1",
    "fi",
  ];
  const writeEnv = "printf 'APP_IMAGE=%s\\n' \"$APP_IMAGE\" > .env";
  if (strategy === "recreate") {
    return [
      ...holdRequests(plan, onExit),
      writeEnv,
      "docker compose up -d --no-deps --remove-orphans app",
      'new="$(docker compose ps -aq app)"',
      ...kamal,
      kamalProxy(`resume ${app}`),
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

/**
 * Why a new copy failed: it got no traffic (rolling), where its lines are, what to check, and the
 * builder hint.
 */
function healthFailed(plan: DeployPlan): string {
  const path = healthPath(plan);
  const traffic =
    plan.deploy.strategy === "rolling"
      ? " It received no traffic: the previous version keeps serving."
      : "";
  return `::error::The new version did not pass its health check (GET ${path} on port ${plan.app.port}) within ${DEPLOY_TIMEOUT_SECONDS} seconds, so OpsCrew removed it.${traffic} Its last lines are kept on the server: \`${failedLogs(plan)}\`. Check that the app listens on port ${plan.app.port} (app.port in ${planFilePath(plan)}, passed to the app as PORT) and answers ${path}. ${builderHint(plan)}`;
}

/** The app's site as the server had it before this deploy, while the edge takes the new one. */
const PREVIOUS_SITE = ".site.previous";

/** The app's additions as the server had them before this deploy, as {@link PREVIOUS_SITE}. */
const PREVIOUS_ADDITIONS = ".additions.previous";

/** The server's edge Compose file before this deploy switched its proxy. */
const PREVIOUS_EDGE = ".edge.previous";

/** The app's site file in the repository, for the messages. */
function siteFile(plan: DeployPlan): string {
  return `${runtimeDir(plan)}/edge/sites/${plan.app.name}.${EDGE_PROXIES[edgeProxy(plan)].site}`;
}

/** Shown when the edge did not start or refused the app's site; names no server and no secret. */
function edgeFailed(plan: DeployPlan, additions: boolean): string {
  const { label } = EDGE_PROXIES[edgeProxy(plan)];
  const yours = additions ? ` or your additions (${additionsPath(plan)})` : "";
  return `::error::OpsCrew's shared edge on the server (${label} and kamal-proxy, in ${EDGE}) did not start or did not accept this app's site (${siteFile(plan)})${yours}, so the new version was not started, the previous version keeps serving and ${label} keeps the site it had. The error is above: fix its cause (for example a port another program uses, or a hostname another app on the server serves) and push again.`;
}

/**
 * Shown when the deploy switches the server's proxy (research.md R5): the interruption, which the
 * plan stated before its approval.
 */
function switchNotice(plan: DeployPlan): string {
  const to = EDGE_PROXIES[edgeProxy(plan)].label;
  const from = EDGE_PROXIES[otherProxy(edgeProxy(plan))].label;
  const issuer = edgeProxy(plan) === "nginx" ? "certbot gets" : "Caddy gets";
  return `::notice::OpsCrew switches this server's proxy from ${from} to ${to} (target.edge in ${planFilePath(plan)}). kamal-proxy and the apps keep running; the sites stop for a few seconds while ${to} starts, and hostnames not proxied by Cloudflare have no HTTPS for under a minute while ${issuer} their certificates.`;
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

/** On this computer, the app's leaf certificate and key in the edge's `tls/<app>`, the same way. */
const LOCAL_TLS_FILES = `${LOCALHOST_TLS.certificate} ${LOCALHOST_TLS.key}`;

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
  /**
   * The localhost target (required there): the app's hostname on this computer. `opscrew provision`
   * leaves its new leaf certificate and key where `localhostTlsUpload` says.
   */
  localhost?: LocalhostSite | undefined;
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
 * HTTPS as before. On this computer the app's leaf certificate and key take the origin files'
 * place, swapped in only when the deploy left new ones (`opscrew provision` does; a deploy on the
 * local runner keeps the edge's), there is no certbot, and the lock is taken only where `flock`
 * exists (Git for Windows and macOS have none; the local deploy serialises itself there).
 */
function edgeCommands(plan: DeployPlan, o: EdgeFiles): string[] {
  const proxy = edgeProxy(plan);
  const { site: ext } = EDGE_PROXIES[proxy];
  const from = EDGE_PROXIES[otherProxy(proxy)].label;
  const app = plan.app.name;
  const site = `${EDGE}/sites/${app}.${ext}`;
  const additions = `${EDGE}/sites/${app}.additions`;
  const tls = `${EDGE}/tls/${app}`;
  const local = plan.target.provider === "localhost";
  const tlsFiles = local ? LOCAL_TLS_FILES : TLS_FILES;
  /** The upload left new TLS files as `<file>.new`. */
  const newTls = local || o.originTls;
  const stamp = (key: string, file: string) => `sed -n 's/^${key}: //p' ${file}`;
  /** Puts `previous` back as `file`, or removes `file` when it had none. */
  const restore = (previous: string, file: string) =>
    `if [ -f ${previous} ]; then cp ${previous} ${file}; else rm -f ${file}; fi`;
  /** The app's previous site, additions and TLS files back, indented by `pad`. */
  const restoreFiles = (pad: string) =>
    [
      restore(PREVIOUS_SITE, site),
      restore(PREVIOUS_ADDITIONS, additions),
      `for f in ${tlsFiles}; do`,
      `  if [ -f ${tls}/$f.previous ]; then mv -f ${tls}/$f.previous ${tls}/$f; else rm -f ${tls}/$f; fi`,
      "done",
    ].map((line) => `${pad}${line}`);
  /** After a switch: the server's previous edge file back, which starts its proxy again. */
  const restoreEdge = (pad: string) =>
    [`cp ${PREVIOUS_EDGE} ${EDGE}/compose.yaml`, "edge up -d --wait --remove-orphans || true"].map(
      (line) => `${pad}${line}`,
    );
  const certbot =
    !local && proxy === "nginx" && o.certbot !== undefined && o.certbot.hosts.length > 0;
  /** A one-off container of the edge's certbot service. */
  const certbotRun = (args: string) => `edge run --rm --no-deps -T ${args} < /dev/null`;
  const nginxFiles =
    proxy === "nginx"
      ? [
          `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > ${EDGE}/.env`,
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
    `mkdir -p ${EDGE}/sites ${EDGE}/tls`,
    "(",
    local ? "  if command -v flock > /dev/null 2>&1; then flock 9; fi" : "  flock 9",
    `  docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    ...nginxFiles,
    `  uploaded="$(${stamp(EDGE_VERSION_KEY, "edge/compose.yaml")})"`,
    `  current="$(${stamp(EDGE_VERSION_KEY, `${EDGE}/compose.yaml`)} 2> /dev/null || true)"`,
    `  proxy="$(${stamp(EDGE_PROXY_KEY, `${EDGE}/compose.yaml`)} 2> /dev/null || true)"`,
    `  rm -f ${PREVIOUS_EDGE}`,
    `  if [ -n "$proxy" ] && [ "$proxy" != ${proxy} ]; then`,
    `    echo ${shellQuote(switchNotice(plan))}`,
    `    cp ${EDGE}/compose.yaml ${PREVIOUS_EDGE}`,
    `    cp edge/compose.yaml ${EDGE}/compose.yaml`,
    '  elif [ "$uploaded" -gt "${current:-0}" ]; then',
    `    cp edge/compose.yaml ${EDGE}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server is now version $uploaded."`,
    // The same version with other content: how the server's apps are served changed (they all are
    // served the same way, the host plan refuses anything else), or Cloudflare's addresses did, so
    // this app's copy is the one.
    `  elif [ "$uploaded" -eq "\${current:-0}" ] && ! cmp -s edge/compose.yaml ${EDGE}/compose.yaml; then`,
    `    cp edge/compose.yaml ${EDGE}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server now has this app's settings (its ports, and the Cloudflare addresses it trusts)."`,
    '  elif [ "$uploaded" -lt "${current:-0}" ]; then',
    `    echo "The server's shared edge (version $current) is newer than this app's ($uploaded), so it stays."`,
    "  fi",
    // Each file the server has is kept as `<file>.previous` (a stale one goes when it has none),
    // and the uploaded one, if any, takes its place.
    ...(o.originTls && !local ? [`  cp edge/tls/pull.pem ${tls}/pull.pem.new`] : []),
    `  for f in ${tlsFiles}; do`,
    ...(local
      ? [
          // A deploy on the local runner brings no leaf: the edge keeps the one it has.
          `    if [ -f ${tls}/$f ]; then cp ${tls}/$f ${tls}/$f.previous; else rm -f ${tls}/$f.previous; fi`,
          `    if [ -f ${tls}/$f.new ]; then mv -f ${tls}/$f.new ${tls}/$f; fi`,
        ]
      : [
          `    if [ -f ${tls}/$f ]; then mv -f ${tls}/$f ${tls}/$f.previous; else rm -f ${tls}/$f.previous; fi`,
          ...(newTls ? [`    mv -f ${tls}/$f.new ${tls}/$f`] : []),
        ]),
    "  done",
    ...(proxy === "nginx" && !local
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
    `    echo ${shellMessage(edgeFailed(plan, o.additions))}`,
    "    exit 1",
    "  fi",
    ...certificate,
    // Only now: a switch that failed above puts the previous proxy back with these files.
    `  rm -f ${EDGE}/sites/${app}.${EDGE_PROXIES[otherProxy(proxy)].site}`,
    newTls
      ? `  rm -f ${tlsFiles
          .split(" ")
          .map((f) => `${tls}/${f}.previous`)
          .join(" ")}`
      : `  rm -rf ${tls}`,
    `) 9> ${EDGE}/.lock`,
  ];
}

/** How {@link switchCommands} and {@link rollbackCommands} render a script. */
export interface ScriptOptions {
  /** A preview's scripts: no rollback changes a preview's data. */
  preview?: boolean;
}

/**
 * Whether a rollback can change the app's data (plan.md 12.4): not in a preview's scripts, with a
 * part a snapshot holds on the app's server ({@link snapshotParts}) or down migrations.
 */
function databaseRollback(plan: DeployPlan, o: ScriptOptions): boolean {
  if (o.preview === true) return false;
  return snapshotParts(plan).length > 0 || plan.app.migrations !== undefined;
}

/** The marker of a rollback's database step, in the app's folder (plan.md 12.4). */
export const DATABASE_CHANGED = ".database.changed";

/**
 * Reads a one-time approval `file` (`<what> <choice> <expiry>`) into `$approved`, `$choice` and
 * `$expiry`, and removes it at once, so it is used once.
 */
export function readApproval(file: string): string[] {
  return [
    'approved=""; choice=""; expiry=""',
    `read -r approved choice expiry < ${file} || true`,
    `rm -f ${file}`,
  ];
}

/**
 * Runs `refuse` (lines that stop the script) unless `$expiry` is a time after now, in seconds; an
 * expiry of more than ten digits is none.
 */
export function approvalExpiry(refuse: readonly string[]): string[] {
  return [
    'case "$expiry" in "" | *[!0-9]* | ???????????*) expiry=0 ;; esac',
    'if [ "$expiry" -le "$(date +%s)" ]; then',
    ...refuse.map((line) => `  ${line}`),
    "fi",
  ];
}

/**
 * The approval's check, first in the script: `$target` is `$1`'s digest and `$running` the one
 * `.env` names, if any. In `MODE` `rollback`, {@link ROLLBACK_APPROVAL_FILE} is read and removed
 * at once ({@link readApproval}), so it is used once:
 * - one for another version is ignored with a note, and the rollback keeps the data;
 * - one for `$target` sets `$database` to its choice (`snapshot` with a part a snapshot holds on
 *   the app's server, `migrations` with `app.migrations`), or, past its time
 *   ({@link approvalExpiry}) or with another choice, stops the script before any change: the user
 *   approved the switch and the database step together.
 * The deploy's snapshot uses `$target` and `$running` too.
 */
function approvalCheck(plan: DeployPlan): string[] {
  const choices = [
    ...(snapshotParts(plan).length > 0 ? ["snapshot"] : []),
    ...(plan.app.migrations === undefined ? [] : ["migrations"]),
  ];
  const file = ROLLBACK_APPROVAL_FILE;
  return [
    `rm -f ${DATABASE_CHANGED}`,
    "database=keep",
    'target="${1##*@sha256:}"',
    "running=\"$(sed -n 's/^APP_IMAGE=.*@sha256:\\([0-9a-f]\\{64\\}\\)$/\\1/p' .env 2> /dev/null || true)\"",
    `if [ "$MODE" = rollback ] && [ -f ${file} ]; then`,
    ...readApproval(file).map((line) => `  ${line}`),
    '  if [ "$approved" != "$target" ]; then',
    `    echo ${shellQuote(`::warning::The approval to change the database on a rollback (${file} on the server) is for another version, so OpsCrew removed it: this rollback keeps the database as it is.`)}`,
    "  else",
    `    case "$choice" in ${choices.join(" | ")}) ;; *)`,
    `      echo ${shellQuote(`::error::The one-time approval to change the database on this rollback (${file} on the server) names a choice this server can't carry out, so nothing was changed. Run opscrew rollback again.`)}`,
    "      exit 1 ;;",
    "    esac",
    ...approvalExpiry([
      `echo ${shellQuote("::error::The one-time approval to restore or migrate the database on this rollback expired before the run started, so nothing was changed. Run opscrew rollback again.")}`,
      "exit 1",
    ]).map((line) => `    ${line}`),
    '    database="$choice"',
    "  fi",
    "fi",
  ];
}

/** Where the dumps' and restores' output is, in a printf format whose `%s` is the app's folder. */
function snapshotLogNote(plan: DeployPlan): string {
  return `The output of the dumps and restores ${serverLogNote(plan, SNAPSHOT_LOG)}`;
}

/**
 * The rollback's database step (plan.md 12.4, FR-1927), in `MODE` `rollback` with an approval
 * (`$database` `snapshot` or `migrations`), before the switch; only with {@link
 * databaseRollback}. It refuses before any change when `.env` names no other version by digest,
 * or when the snapshot to restore is not complete on the server. Then, with {@link
 * DATABASE_CHANGED} written first (`changed=0`):
 * 1. kamal-proxy holds the app's requests ({@link holdRequests}, with the EXIT trap);
 * 2. the web, the workers and cron stop;
 * 3. the data the step changes on the app's server (the parts the snapshot holds, or for the down
 *    migrations the databases and SQLite) is copied under the running version, as at a deploy,
 *    whether or not snapshots are on (`$saved`; none without such a part); a failed copy, or too
 *    little free disk for one, changes nothing: the running version starts again and the script
 *    exits 1;
 * 4. the marker says `changed=1`, and the snapshot is restored (`snapshot_restore`), or the down
 *    migrations run ({@link migrationDown}) in a subshell.
 * The copies and restores are {@link SNAPSHOT_FUNCTIONS}'. The switch to `$1` that follows is always
 * `recreate`'s. When step 4 fails, step 3's copy is restored, the running version's web, workers
 * and cron start again (the ones {@link PREVIOUS_PROCESSES} lists), the marker goes, and the script
 * exits 1 with `.env` unchanged; the requests resume on the exit. When that restore fails too, no
 * version starts on the database and the marker stays, so the rollback script tries once more
 * ({@link databaseBack}). Without a copy, the running version starts on the database as step 4
 * left it.
 */
function databaseStep(plan: DeployPlan): string[] {
  const folder = appFolder(plan);
  const parts = snapshotParts(plan);
  const { migrations } = plan.app;
  const note = snapshotLogNote(plan);
  /** The marker with `changed` (0 before step 4, 1 from it on). */
  const mark = (changed: 0 | 1) =>
    `  (umask 077; printf 'target=%s\\nAPP_IMAGE=%s\\nsaved=%s\\nchanged=%s\\n' "$target" "$before" "$saved" ${changed} > ${DATABASE_CHANGED})`;
  /** Changes nothing more: the running version starts again, the marker goes, the script stops. */
  const giveUp = [`rm -f ${DATABASE_CHANGED}`, startApp(plan), "exit 1"];
  /** The parts the down migrations change: the databases and SQLite. */
  const migrated = parts
    .filter((part) => part.kind === "sqlite" || part.file.endsWith(".dump"))
    .map((part) => part.name);
  const save =
    parts.length > 0
      ? [
          '  parts=""',
          '  case "$database" in',
          '    snapshot) parts="$(snapshot_parts "$target")" ;;',
          ...(migrations === undefined
            ? []
            : [`    migrations) parts=${shellQuote(migrated.join(" "))} ;;`]),
          "  esac",
          '  if [ -n "$parts" ]; then',
          "    snap=0",
          '    snapshot_take "$running" release $parts || snap=$?',
          '    if [ "$snap" -eq 1 ]; then',
          `      printf ${printfFormat(`::error::OpsCrew could not save the current database before changing it, so the rollback changed nothing and the running version starts again. ${note} Fix the cause and run opscrew rollback again, or keep the database as it is.`)} ${folder}`,
          `      ${giveUp.join("; ")}`,
          "    fi",
          '    if [ "$snap" -eq 2 ]; then',
          `      echo ${shellQuote("::error::The server has too little free disk to save the current database before changing it, so the rollback changed nothing and the running version starts again. Free some space and run opscrew rollback again.")}`,
          `      ${giveUp.join("; ")}`,
          "    fi",
          '    saved="$running"',
          "  fi",
        ]
      : [];
  const noCopy = [
    `printf ${printfFormat(`::error::%s failed, and no copy of the database from before the rollback was saved (OpsCrew saves only the PostgreSQL, MySQL, MariaDB, MongoDB and SQLite databases on the app's server), so the database may be partly changed; the running version starts again. ${note} Fix the cause, then run opscrew rollback again or restore a backup.`)} "$what" ${folder}`,
    giveUp.join("; "),
  ];
  const putBack =
    parts.length > 0
      ? [
          ...(migrations === undefined
            ? []
            : ['    if [ -z "$saved" ]; then', ...noCopy.map((line) => `      ${line}`), "    fi"]),
          '    if snapshot_restore "$saved" $parts; then',
          `      printf ${printfFormat(`::error::%s failed, so OpsCrew put the database back as it was before the rollback, and the running version starts again: the rollback changed nothing. ${note} Fix the cause and run opscrew rollback again.`)} "$what" ${folder}`,
          `      ${giveUp.join("; ")}`,
          "    fi",
          `    printf ${printfFormat(`::error::%s failed, and putting the database back as it was before the rollback failed too, so it may be partly changed, and no version of the app starts on it. Its copy from before the rollback stays in %s/${SNAPSHOTS_DIR}/%s: the rollback step tries once more to restore it. ${note}`)} "$what" ${folder} "$saved" ${folder}`,
          "    exit 1",
        ]
      : noCopy.map((line) => `    ${line}`);
  const restore =
    parts.length === 0
      ? []
      : [
          "    snapshot)",
          '      what="Restoring the snapshot of the database"',
          '      if snapshot_restore "$target" $parts; then',
          `        echo "OpsCrew restored the database from the snapshot taken $(cat ${snapshotTakenPath('"$target"')})."`,
          "      else",
          "        failed=1",
          "      fi ;;",
        ];
  return [
    'if [ "$database" != keep ]; then',
    '  if [ -z "$running" ] || [ "$running" = "$target" ]; then',
    `    echo ${shellQuote("::error::The server's .env names no other version by its image digest, so OpsCrew can't save its database before changing it, and the rollback changed nothing. Run opscrew rollback again and keep the database as it is.")}`,
    "    exit 1",
    "  fi",
    ...(parts.length === 0
      ? []
      : [
          `  ${SNAPSHOT_FUNCTIONS}`,
          '  if [ "$database" = snapshot ] && ! snapshot_complete "$target"; then',
          `    echo ${shellQuote(`::error::The snapshot this rollback was approved to restore is no longer complete on the server (in ${SNAPSHOTS_DIR}), so the rollback changed nothing. Run opscrew rollback again to choose again.`)}`,
          "    exit 1",
          "  fi",
        ]),
    `  echo ${shellQuote("The rollback changes the database: the app's requests wait, and the app stops until the earlier version starts.")}`,
    '  saved=""',
    "  before=\"$(sed -n 's/^APP_IMAGE=//p' .env)\"",
    mark(0),
    ...holdRequests(plan, [LOGOUT]).map((line) => `  ${line}`),
    `  ${stopApp(plan)}`,
    ...save,
    mark(1),
    "  failed=0",
    '  case "$database" in',
    ...restore,
    ...(migrations === undefined
      ? []
      : [
          "    migrations)",
          '      what="Migrating the database down"',
          "      if ! (",
          ...migrationDown(plan, migrations).map((line) => `        ${line}`),
          "      ); then failed=1; fi ;;",
        ]),
    "  esac",
    '  if [ "$failed" -ne 0 ]; then',
    ...putBack,
    "  fi",
    "fi",
  ];
}

/**
 * The server script of the start step (POSIX sh, in the app's folder `/srv/apps/<app>`; the image
 * is `$1`, already checked to be a GHCR digest reference, and `$2` the mode, `deploy` (the default)
 * or `rollback`), in this order:
 * 1. pull the app's images;
 * 2. the shared edge with the app's site and the `edgeFiles` the upload left ({@link edgeCommands});
 * 3. start the plan's services when they are not running (Compose recreates one only when its own
 *    configuration changed; nothing forces it), then recreate any of them published on the
 *    server's private address that came up without its port ({@link portRepair});
 * 4. the services' one-time setup, `init` (the catalog's steps, see {@link ServiceInitStep}), then
 *    the deploy user's crontab line for scheduled snapshots, written or removed ({@link
 *    snapshotScheduleLines}; not in a preview's scripts);
 * 5. in mode `deploy`, the snapshot of the data under the running version ({@link
 *    snapshotStep}, through the uploaded `snapshot.sh`);
 * 6. the release command in a one-off container of the new image, never in mode `rollback`: an
 *    earlier version's migrations must not run against a newer schema; then the migrations' record
 *    ({@link migrationRecord});
 * 7. in mode `rollback` with the one-time approval ({@link approvalCheck}, first in the script),
 *    the database step ({@link databaseStep}), after recording which workers and cron run
 *    ({@link PREVIOUS_PROCESSES});
 * 8. the switch to the new image by `deploy.strategy` (`recreate` for SQLite apps, and after the
 *    database step);
 * 9. the workers and cron on the new image;
 * 10. a check that every worker and cron container keeps running for 30 seconds.
 * A copy that fails its health check, or a worker that stops, leaves its last lines in
 * {@link FAILED_DEPLOY_DIR} ({@link keepFailed}) before it goes, and the script records how far it
 * got in {@link START_OUTCOME}. A failure before the switch leaves
 * the running version untouched; after it, the workflow's
 * rollback ({@link rollbackCommands}) puts the web and the workers back. The services are never
 * named after the setup, and no Compose command names another app's folder or project. The script
 * reaches `sh` on its stdin, so the commands that read stdin (`docker compose exec` and `run`) get
 * `/dev/null`; otherwise they would swallow the rest of the script. It starts with
 * {@link SCRIPT_ROOTS}, so the local executor runs it on this computer under its own folders, and
 * holds {@link START_LOCK} from its first lines in the app's folder to its end.
 */
export function switchCommands(
  plan: DeployPlan,
  init: readonly ServiceInitStep[],
  edgeFiles: EdgeFiles = { originTls: false, additions: false },
  o: ScriptOptions = {},
): string[] {
  const steady = steadyServices(plan);
  const data = databaseRollback(plan, o);
  const release =
    plan.app.releaseCommand === undefined
      ? []
      : [
          'if [ "$MODE" = rollback ]; then',
          data
            ? `  if [ "$database" = keep ]; then echo ${shellQuote(NO_RELEASE)}; else echo ${shellQuote("A rollback runs no release command.")}; fi`
            : `  echo ${shellQuote(NO_RELEASE)}`,
          "else",
          `  if ! (umask 077; docker compose run --rm --no-deps -T release < /dev/null > ${releaseLog(plan)} 2>&1); then`,
          `    echo ${shellMessage(releaseFailed(plan))}`,
          "    exit 1",
          "  fi",
          `  echo ${shellMessage(`The release command finished; its output is in ${releaseLog(plan)} on the server.`)}`,
          ...(data ? migrationRecord(plan) : []).map((line) => `  ${line}`),
          "fi",
        ];
  const hosts = proxyHosts(plan, edgeFiles.localhost);
  /** The switch by `p`'s strategy, which names it when the new copy fails its health check. */
  const switchBy = (p: DeployPlan) =>
    switchApp(
      p,
      hosts,
      ['keep_failed app "$new" health', `echo ${shellQuote(healthFailed(p))}`],
      [LOGOUT],
    );
  // The database step always recreates: the newer version must not write to a database being replaced.
  const switching =
    !data || plan.deploy.strategy === "recreate"
      ? switchBy(plan)
      : [
          'if [ "$database" = keep ]; then',
          ...switchBy(plan).map((line) => `  ${line}`),
          "else",
          ...switchBy(recreatePlan(plan)).map((line) => `  ${line}`),
          "fi",
        ];
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    // The same folder as `dockerConfig`, where the workflow logs in to the registry.
    `export DOCKER_CONFIG=${appFolder(plan)}/.docker`,
    `trap '${LOGOUT}' EXIT`,
    `cd ${appFolder(plan)}`,
    ...startLock(plan),
    `echo started > ${START_OUTCOME}`,
    'export APP_IMAGE="$1"',
    'RUN_IMAGE="$1"',
    'MODE="${2:-deploy}"',
    ...(data ? approvalCheck(plan) : []),
    ...keepFailed(plan),
    EDGE_FUNCTION,
    "docker compose pull",
    ...edgeCommands(plan, edgeFiles),
    ...(steady.length === 0 ? [] : [`docker compose up -d --no-deps --wait ${steady.join(" ")}`]),
    ...portRepair(plan, APP_SERVER),
    ...serviceInit(plan, init, initLog(plan)),
    ...(o.preview === true ? [] : snapshotScheduleLines(plan, APP_SERVER)),
    ...(data ? snapshotStep(plan, appFolder(plan)) : []),
    ...release,
    // Before the switch: `recreate` writes `.env` first, and from then on the rollback acts.
    ...recordProcesses(processServices(plan)),
    ...(data ? databaseStep(plan) : []),
    ...switching,
    ...startProcesses(plan, processServices(plan)),
    `echo finished > ${START_OUTCOME}`,
  ];
}

/**
 * The script that updates the services on the extra server `server` (POSIX sh, in the app's folder
 * there, where the deploy uploaded the server's Compose file and its services' env files): pulls
 * their images, starts them (Compose recreates only what changed and removes the containers of
 * services that left the server) and waits until they are healthy, repairs a port that came up
 * unpublished ({@link portRepair}), runs their one-time setup steps (`init`), then writes or
 * removes the server's line for scheduled snapshots ({@link snapshotScheduleLines}). Any failure
 * exits non-zero, before the app's switch.
 */
export function serverCommands(
  plan: DeployPlan,
  server: string,
  init: readonly ServiceInitStep[],
): string[] {
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    "docker compose pull",
    "docker compose up -d --wait --remove-orphans",
    ...portRepair(plan, server),
    ...serviceInit(plan, init, initLog(plan), server),
    ...snapshotScheduleLines(plan, server),
  ];
}

/**
 * The server script of the rollback (POSIX sh; the failed image is `$1`): when `.env` names it and
 * `.env.previous` holds another image, switches the web back to that one the same way as the
 * deploy, starts on it the workers and cron that ran before the deploy and stops the others, and
 * prints `restored`; prints `unchanged` when this run never switched, `no-previous` when there is
 * nothing to go back to, and nothing when the switch back failed. Before the switch back it keeps
 * the lines of the app containers it replaces, unless this run's start script already kept its
 * failure (a health check or a worker; {@link START_OUTCOME}): `failed=check` when the start script
 * finished and the check from outside failed, `failed=start` when it stopped after the switch.
 * Before all of that, when this run's database step changed the database ({@link
 * DATABASE_CHANGED}), it puts the database back and starts the version that ran before
 * ({@link databaseBack}). First of all it takes {@link START_LOCK}, waiting for a start script
 * that still runs for up to 15 minutes, after which it stops with nothing changed. On this
 * computer `localhost` is the app's hostname there, as the start script had it.
 */
export function rollbackCommands(
  plan: DeployPlan,
  localhost?: LocalhostSite,
  o: ScriptOptions = {},
): string[] {
  const keepLines = [
    `outcome="$(cat ${START_OUTCOME} 2> /dev/null || true)"`,
    'if [ "$outcome" != kept ]; then',
    '  why=start; if [ "$outcome" = finished ]; then why=check; fi',
    '  for id in $(docker compose ps -aq app); do keep_failed app "$id" "$why"; done',
    "fi",
  ];
  /** The switch to `$APP_IMAGE` by `p`'s strategy, then the workers and cron that ran. */
  const back = (p: DeployPlan) => [
    ...switchApp(p, proxyHosts(plan, localhost), [
      `echo ${shellQuote("::error::The previous version did not pass its health check either.")}`,
    ]),
    ...restoreProcesses(processServices(plan)),
  ];
  const data = databaseRollback(plan, o);
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    ...startLock(
      plan,
      `::error::The start script of this run is still running on the server after ${START_LOCK_WAIT_SECONDS / 60} minutes, so the rollback step changed nothing. Check the app on the server (${runbookFilePath(plan)} has the SSH command), then run the deploy or opscrew rollback again.`,
    ),
    'RUN_IMAGE="$1"',
    ...keepFailed(plan),
    EDGE_FUNCTION,
    ...(data ? databaseBack(plan, keepLines, back(recreatePlan(plan))) : []),
    'if ! grep -qxF "APP_IMAGE=$1" .env 2> /dev/null; then echo unchanged; exit 0; fi',
    "if [ ! -f .env.previous ] || cmp -s .env .env.previous; then echo no-previous; exit 0; fi",
    ...keepLines,
    "APP_IMAGE=\"$(sed -n 's/^APP_IMAGE=//p' .env.previous)\"",
    "export APP_IMAGE",
    "{",
    ...back(plan).map((line) => `  ${line}`),
    "} >&2",
    `rm -f .env.previous ${PREVIOUS_PROCESSES}`,
    "echo restored",
  ];
}

/** `plan` with the `recreate` strategy: a rollback that changes the database always recreates. */
function recreatePlan(plan: DeployPlan): DeployPlan {
  return { ...plan, deploy: { ...plan.deploy, strategy: "recreate" } };
}

/**
 * The rollback script's lines for a run whose database step began (plan.md 12.4, {@link
 * DATABASE_CHANGED}), before any other check, so the app never stays stopped: the earlier version
 * failed, or the start script stopped, after the step stopped the app. They act only on this
 * run's marker, which names `$1` as its target and the version `.env.previous` (this run's start
 * step) names; another is an earlier run's and goes. The app's requests wait and its containers
 * stop; once step 4 began (`changed=1`), step 3's dump is restored (without one, the database
 * stays as the step left it, and the next deploy's release command migrates it up again; when the
 * restore fails, the script stops with no version on the database). Then the version that ran
 * before the run starts again by `back` (the recreate switch and the workers and cron that ran).
 * It prints `restored` when the earlier version had taken over (whose app containers' lines
 * `keepLines` keeps first), and `unchanged` otherwise.
 */
function databaseBack(
  plan: DeployPlan,
  keepLines: readonly string[],
  back: readonly string[],
): string[] {
  const folder = appFolder(plan);
  const failed = `::error::The earlier version failed after the rollback changed the database, and putting the database back as it was before the rollback failed, so it may be partly changed, and no version of the app starts on it. Its copy from before the rollback stays in %s/${SNAPSHOTS_DIR}/%s: restore it, then start the app. ${snapshotLogNote(plan)}`;
  const parts = snapshotParts(plan).length > 0;
  const restore = !parts
    ? []
    : [
        '  elif snapshot_restore "$saved"; then',
        `    echo ${shellQuote("The earlier version failed after the rollback changed the database, so OpsCrew put the database back as it was before the rollback.")}`,
        "  else",
        `    printf ${printfFormat(failed)} ${folder} "$saved" ${folder}`,
        "    exit 1",
      ];
  const field = (name: string) => `"$(sed -n 's/^${name}=//p' ${DATABASE_CHANGED})"`;
  return [
    `if [ -f ${DATABASE_CHANGED} ]; then`,
    `  marked=${field("target")}`,
    `  before=${field("APP_IMAGE")}`,
    '  if [ "$marked" != "${1##*@sha256:}" ] || ! grep -qxF "APP_IMAGE=$before" .env.previous 2> /dev/null; then',
    `    rm -f ${DATABASE_CHANGED}`,
    "  fi",
    "fi",
    `if [ -f ${DATABASE_CHANGED} ]; then`,
    ...(parts ? [`  ${SNAPSHOT_FUNCTIONS}`] : []),
    "  result=unchanged",
    '  if grep -qxF "APP_IMAGE=$1" .env 2> /dev/null; then',
    "    result=restored",
    ...keepLines.map((line) => `    ${line}`),
    "  fi",
    `  saved=${field("saved")}`,
    `  changed=${field("changed")}`,
    '  APP_IMAGE="$before"',
    "  export APP_IMAGE",
    "  {",
    ...[
      ...holdRequests(plan, []),
      stopApp(plan),
      'if [ "$changed" = 1 ]; then',
      '  if [ -z "$saved" ]; then',
      `    echo ${shellQuote("::warning::The earlier version failed after the rollback changed the database, and no copy of the database from before the rollback was saved, so it stays as the rollback left it while the version that ran before starts again. The next deploy's release command migrates it up again.")}`,
      ...restore,
      "  fi",
      "fi",
      `rm -f ${DATABASE_CHANGED}`,
      ...back,
    ].map((line) => `    ${line}`),
    "  } >&2",
    `  rm -f .env.previous ${PREVIOUS_PROCESSES}`,
    '  echo "$result"',
    "  exit 0",
    "fi",
  ];
}
