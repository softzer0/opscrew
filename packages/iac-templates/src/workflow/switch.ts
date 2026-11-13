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
  OPENLITESPEED_COMMAND,
  openlitespeedCachePurge,
  otherProxies,
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
  said,
  serverLogNote,
} from "./shared";
import {
  holdsData,
  migratedParts,
  queueServices,
  ROLLBACK_APPROVAL_FILE,
  RUNNING_FILE,
  releaseSnapshotOn,
  rollbackServers,
  SNAPSHOT_FUNCTIONS,
  SNAPSHOT_LOG,
  SNAPSHOT_SCRIPT,
  SNAPSHOTS_DIR,
  snapshotParts,
  snapshotRunning,
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
 * started with, for {@link PROCESS_CHECK_SECONDS}; otherwise the `failed` lines run for the first
 * that did not (`$service`, its container `$id`: they say why) and the script exits 1.
 */
export function startProcesses(services: readonly string[], failed: readonly string[]): string[] {
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
    ...failed.map((line) => `    ${line}`),
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
export function proxyHosts(plan: DeployPlan, localhost: LocalhostSite | undefined): string {
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
export const START_LOCK = ".start.lock";

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

/**
 * The marker in the app's folder while the app is held, so nothing deploys, starts the app or
 * changes its data ({@link heldRefusal}). It says who holds it: empty while `opscrew restore` holds
 * the app (`snapshot.sh hold` leaves it and `resume` removes it), as its data may be partly
 * restored; `rotation <hash>` while a credential rotation does ({@link ROTATION_HOLDER},
 * `rotate.sh`), as its services may have new values the app does not use yet.
 */
export const RESTORE_HELD = `${SNAPSHOTS_DIR}/.held`;

/** The first word of {@link RESTORE_HELD} while a rotation holds the app, before its plan's hash. */
export const ROTATION_HOLDER = "rotation";

/**
 * The sh line that prints, while {@link RESTORE_HELD} is in the app's folder `dir`, `held` and what
 * it says: `held` for a restore, `held rotation <hash>` for a rotation ({@link heldSaid} reads it).
 */
export function heldProbe(dir: string): string {
  return `if [ -f ${dir}/${RESTORE_HELD} ]; then echo held $(cat ${dir}/${RESTORE_HELD}); fi`;
}

/**
 * The sh line that prints why a script or a step stops while the app is held, after `prefix`: the
 * shell variable `variable` holds {@link heldProbe}'s line. A rotation's hold names its plan and the
 * way out (`opscrew rotate` again, or `--undo`); any other is a restore's, which only an app with
 * data on one of its servers can have ({@link holdsData}).
 */
export function heldSaid(plan: DeployPlan, variable: string, prefix: string): string {
  const restore = `${prefix}a restore holds the app (${RESTORE_HELD} in its folder), so its data may be partly restored: finish the restore with opscrew restore <copy>, or run sh snapshot.sh resume in the app's folder as the deploy user, then try again.`;
  const byRotation = rotationSaid(plan, variable, prefix);
  if (!holdsData(plan)) return byRotation;
  return `case "$${variable}" in "${ROTATION_HELD}"*) ${byRotation} ;; *) ${said(restore)} ;; esac`;
}

/** The start of {@link heldProbe}'s line while a rotation holds the app, before its plan's hash. */
const ROTATION_HELD = `held ${ROTATION_HOLDER} `;

/** What a rotation's hold says, its `%s` the plan's hash. */
function rotationHolds(plan: DeployPlan): string {
  return `a credential rotation holds the app (the rotation of the plan %s), so its services may have new values the app does not use yet: finish the rotation with ${opscrew(plan, "rotate")}, or put the old values back with ${opscrew(plan, "rotate --undo")}, then try again.`;
}

/** The printf of a rotation's hold, after `prefix`; `variable` holds {@link heldProbe}'s line. */
function rotationSaid(plan: DeployPlan, variable: string, prefix: string): string {
  return `${said(`${prefix}${rotationHolds(plan)}`)} "\${${variable}#${ROTATION_HELD}}"`;
}

/**
 * The sh function `snapshot_rotation_held <prefix>`, which succeeds, saying why after `prefix`,
 * while a rotation holds the app ({@link RESTORE_HELD} reads `rotation <hash>`), and fails on a
 * restore's hold or none: `if snapshot_rotation_held '<prefix>'; then return 1; fi`.
 */
export function rotationHeldFunction(plan: DeployPlan): string[] {
  return [
    "snapshot_rotation_held() {",
    `  _holder="held $(cat ${RESTORE_HELD} 2> /dev/null || true)"`,
    `  case "$_holder" in "${ROTATION_HELD}"*) ${said(`%s${rotationHolds(plan)}`)} "$1" "\${_holder#${ROTATION_HELD}}" >&2; return 0 ;; esac`,
    "  return 1",
    "}",
  ];
}

/**
 * The sh line, run while the app is held ({@link RESTORE_HELD}), that says why after `prefix`
 * ({@link heldSaid}) and ends with `end`.
 */
export function heldStop(plan: DeployPlan, prefix: string, end: string): string {
  return `held="held $(cat ${RESTORE_HELD})"; ${heldSaid(plan, "held", prefix)} >&2; ${end}`;
}

/**
 * The one line that stops a script, before it changes anything, while the app is held
 * ({@link RESTORE_HELD}): with `outcome`, it prints that word and what the marker says and exits 0
 * (the rollback script, whose step then says why: {@link HELD_ROLLBACK}), else it fails, saying why
 * ({@link heldStop}, after {@link HELD_STOP}). None in a preview's scripts: nothing holds a preview.
 */
function heldRefusal(plan: DeployPlan, o: ScriptOptions, outcome?: string): string[] {
  if (o.preview === true) return [];
  return [
    outcome === undefined
      ? `if [ -f ${RESTORE_HELD} ]; then ${heldStop(plan, HELD_STOP, "exit 1")}; fi`
      : `if [ -f ${RESTORE_HELD} ]; then echo ${outcome} $(cat ${RESTORE_HELD}); exit 0; fi`,
  ];
}

/**
 * How a script or the job's first step on the app's server begins to say why it stops, before any
 * change, while the app is held ({@link heldSaid}).
 */
export const HELD_STOP = "::error::OpsCrew changed nothing on the server: ";

/** How the rollback step begins to say that the rollback script found the app held. */
export const HELD_ROLLBACK = "::error::This run stopped before changing anything: ";

/** What the start script's EXIT trap runs: the registry logout of the app's own Docker settings. */
const LOGOUT = "docker logout ghcr.io > /dev/null 2>&1";

/**
 * kamal-proxy holds the app's requests (the requests in flight finish, new ones wait up to
 * {@link MAX_PAUSE_SECONDS}), and the script's EXIT trap, which also runs `onExit`, resumes them on
 * every exit, since kamal-proxy keeps a pause even across its restarts. A service kamal-proxy does
 * not have yet (the first deploy) has nothing to hold, and the script goes on.
 */
export function holdRequests(plan: DeployPlan, onExit: readonly string[]): string[] {
  const trap = [resumeRequests(plan), ...onExit].join("; ");
  return [`trap '${trap}' EXIT`, pauseRequests(plan)];
}

/** kamal-proxy holds the app's requests: the line of {@link holdRequests} without its trap. */
export function pauseRequests(plan: DeployPlan): string {
  return `${kamalProxy(`pause ${plan.app.name} --drain-timeout ${plan.deploy.drainSeconds}s --max-pause ${MAX_PAUSE_SECONDS}s`)} > /dev/null 2>&1 || true`;
}

/**
 * The lines that hold the app: kamal-proxy holds its requests ({@link pauseRequests}), and its web,
 * workers and cron stop ({@link stopApp}).
 */
export function holdApp(plan: DeployPlan): string[] {
  return [pauseRequests(plan), stopApp(plan)];
}

/**
 * The lines that end {@link holdApp}: the web, workers and cron start again ({@link startApp}),
 * and the requests go through ({@link resumeRequests}).
 */
export function resumeApp(plan: DeployPlan): string[] {
  return [startApp(plan), resumeRequests(plan)];
}

/**
 * kamal-proxy lets the app's requests through again. Resuming a service that is not paused, or
 * that kamal-proxy does not have, changes nothing.
 */
export function resumeRequests(plan: DeployPlan): string {
  return `${kamalProxy(`resume ${plan.app.name}`)} > /dev/null 2>&1 || true`;
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
 * exits 1. `hosts` are kamal-proxy's for the service ({@link proxyHosts}). On OpenLiteSpeed the
 * switch ends with {@link afterSwitch}.
 */
export function switchApp(
  plan: DeployPlan,
  hosts: string,
  failed: readonly string[],
  onExit: readonly string[] = [],
): string[] {
  return [...switchLines(plan, hosts, failed, onExit), ...afterSwitch(plan)];
}

/**
 * Takes the server's edge lock (fd 9 on `/srv/edge/.lock`), which every app's deploy holds while
 * it changes the edge; on this computer only where `flock` exists (Git for Windows and macOS have
 * none; the local deploy serialises itself there).
 */
function takeEdgeLock(plan: DeployPlan): string {
  return plan.target.provider === "localhost"
    ? "if command -v flock > /dev/null 2>&1; then flock 9; fi"
    : "flock 9";
}

/** Shown when OpenLiteSpeed did not empty the cache or restart after the switch. */
function afterSwitchFailed(plan: DeployPlan): string {
  return `::error::The new version of ${plan.app.name} serves, but OpenLiteSpeed did not empty the app's page cache or did not restart after the switch, so it keeps its running configuration. The reason is above: fix its cause and deploy again.`;
}

/**
 * On OpenLiteSpeed, once the new copy serves, under the edge's lock (so another app's deploy is
 * never halfway through copying its site files): the app's page cache emptied, so nobody gets a
 * page the version before left there (ADR 0031 D4), then the checked graceful restart that follows
 * every change that moves a backend (D3). A refusal only says so: the new version serves, and
 * OpenLiteSpeed keeps its running configuration. Nothing on Caddy and nginx.
 */
function afterSwitch(plan: DeployPlan): string[] {
  if (edgeProxy(plan) !== "openlitespeed") return [];
  const purge = `edge exec -T openlitespeed sh -c ${shellQuote(openlitespeedCachePurge(plan.app.name))} < /dev/null`;
  return [
    "(",
    `  ${takeEdgeLock(plan)}`,
    `  if ! ${purge} || ! ${RELOAD.openlitespeed}; then`,
    `    echo ${shellQuote(afterSwitchFailed(plan))}`,
    "  fi",
    `) 9> ${EDGE}/.lock`,
  ];
}

/** The switch of {@link switchApp}, by `deploy.strategy`. */
function switchLines(
  plan: DeployPlan,
  hosts: string,
  failed: readonly string[],
  onExit: readonly string[],
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

/**
 * OpenLiteSpeed's other site files (`<app>.vhost` and `<app>.map`), which its site before
 * certbot's first certificate shares: kept as the server had them as `.site.previous.<file>`.
 */
const OPENLITESPEED_SHARED = ["vhost", "map"] as const;

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
 * The proxies a switch to `proxy` replaces, as its script knows them: OpenLiteSpeed's any other;
 * Caddy's and nginx's only each other, as before OpenLiteSpeed (FR-2714 keeps their files as they
 * were), so after a switch from OpenLiteSpeed to either, its site files stay unused and the
 * messages name the other one.
 */
function replacedProxies(proxy: EdgeProxy): EdgeProxy[] {
  return proxy === "openlitespeed" ? otherProxies(proxy) : [proxy === "caddy" ? "nginx" : "caddy"];
}

/**
 * A line that prints `message(from)`, `from` naming the proxy a switch replaces: on OpenLiteSpeed
 * the one the server ran (`$from`, from the stamp of its edge file), else
 * {@link replacedProxies}' one.
 */
function sayFrom(plan: DeployPlan, message: (from: string) => string): string {
  const proxy = edgeProxy(plan);
  if (proxy === "openlitespeed") return `printf ${printfFormat(message("%s"))} "$from"`;
  const [from = proxy] = replacedProxies(proxy);
  return `echo ${shellQuote(message(EDGE_PROXIES[from].label))}`;
}

/**
 * Shown when the deploy switches the server's proxy from `from` (research.md R5): the
 * interruption, which the plan stated before its approval.
 */
function switchNotice(plan: DeployPlan, from: string): string {
  const proxy = edgeProxy(plan);
  const to = EDGE_PROXIES[proxy].label;
  const issuer = proxy === "caddy" ? "Caddy gets" : "certbot gets";
  return `::notice::OpsCrew switches this server's proxy from ${from} to ${to} (target.edge in ${planFilePath(plan)}). kamal-proxy and the apps keep running; the sites stop for a few seconds while ${to} starts, and hostnames not proxied by Cloudflare have no HTTPS for under a minute while ${issuer} their certificates.`;
}

/** Shown when the switch failed and the server's previous proxy, `from`, is back. */
function switchFailed(plan: DeployPlan, from: string): string {
  const to = EDGE_PROXIES[edgeProxy(plan)].label;
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

/** Shown when the proxy refused the site with certbot's new certificate, after certbot got it. */
function tlsSiteFailed(plan: DeployPlan): string {
  const { label } = EDGE_PROXIES[edgeProxy(plan)];
  return `::error::${label} did not accept this app's site (${siteFile(plan)}) with certbot's certificate, so the site it had stays (on HTTP only before its first certificate), and the new version was not started. ${label}'s error is above: fix its cause and push again.`;
}

/** The app's origin TLS files in `/srv/edge/tls/<app>`, as a shell word list. */
const TLS_FILES = "origin.pem origin.key pull.pem";

/** On this computer, the app's leaf certificate and key in the edge's `tls/<app>`, the same way. */
const LOCAL_TLS_FILES = `${LOCALHOST_TLS.certificate} ${LOCALHOST_TLS.key}`;

/**
 * How the deploy reloads the server's proxy: each keeps its running configuration on an error.
 * OpenLiteSpeed runs its edge's own check and graceful restart (ADR 0031 D2).
 */
const RELOAD: Record<EdgeProxy, string> = {
  caddy:
    "edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null",
  nginx: "edge exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null",
  openlitespeed: `edge exec -T openlitespeed ${OPENLITESPEED_COMMAND.reload} < /dev/null`,
};

/** What the upload left for the app's edge besides its site. */
export interface EdgeFiles {
  /**
   * The upload left the app's origin certificate and key in `/srv/edge/tls/<app>/` as
   * `origin.pem.new` and `origin.key.new`, and `pull.pem` in the app's `edge/tls/`.
   */
  originTls: boolean;
  /**
   * The upload left the user's additions in the app's folder (`additions.caddy`, `.nginx` or
   * `.openlitespeed`).
   */
  additions: boolean;
  /**
   * nginx and OpenLiteSpeed: the hostnames certbot gets the app's certificate for, and the
   * account's contact email; the upload left the app's site before its first certificate as
   * `edge/sites/<app>.http.conf` (`.http.vhconf`).
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
 *    gid to `/srv/edge/.env`, which the edge's Compose file runs nginx and certbot as (on
 *    OpenLiteSpeed certbot only, on a server);
 * 2. puts the uploaded edge Compose file (`edge/compose.yaml` in the app's folder) in `/srv/edge`
 *    when the server's runs the other proxy (the switch, offered only while the server holds this
 *    one OpsCrew app), when its {@link EDGE_VERSION_KEY} is larger than the server's, so an app
 *    with an older OpsCrew never downgrades the edge, or when it is the same version with other
 *    content (the ports of another access mode, or Cloudflare's addresses, which all the server's
 *    apps share);
 * 3. puts the app's new origin certificate, its key and `pull.pem` in `/srv/edge/tls/<app>`, so no
 *    other app's reload sees a certificate without its key, or, without origin TLS, takes the
 *    app's old ones out;
 * 4. on nginx and OpenLiteSpeed, gives the deploy user certbot's volumes (Docker creates them owned
 *    by root);
 * 5. puts the app's site and its additions in `/srv/edge/sites`, or takes old additions out
 *    (OpenLiteSpeed's site is three files, `<app>.vhconf`, `.vhost` and `.map`); with certbot's
 *    hostnames, the site before the first certificate until certbot has it;
 * 6. starts the edge (Compose recreates only what changed, and removes the other proxy's
 *    containers after a switch) and reloads the proxy;
 * 7. with certbot's hostnames, certbot gets or renews the app's certificate (the first one, and
 *    hostnames added since; once more when another certbot held its lock), then the HTTPS site
 *    goes in;
 * 8. the site files of the app for the proxies a switch replaces go ({@link replacedProxies}), and
 *    the app's earlier origin TLS files.
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
  const app = plan.app.name;
  const site = `${EDGE}/sites/${app}.${ext}`;
  /** OpenLiteSpeed's other site files, the same before and after certbot's first certificate. */
  const shared = proxy === "openlitespeed" ? OPENLITESPEED_SHARED.join(" ") : undefined;
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
      ...(shared === undefined
        ? []
        : [
            `for f in ${shared}; do`,
            `  ${restore(`${PREVIOUS_SITE}.$f`, `${EDGE}/sites/${app}.$f`)}`,
            "done",
          ]),
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
    !local && proxy !== "caddy" && o.certbot !== undefined && o.certbot.hosts.length > 0;
  /** A one-off container of the edge's certbot service. */
  const certbotRun = (args: string) => `edge run --rm --no-deps -T ${args} < /dev/null`;
  // nginx runs as the deploy user, and certbot beside nginx and OpenLiteSpeed on a server.
  const deployUser =
    proxy === "nginx" || (proxy === "openlitespeed" && !local)
      ? [
          `  printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > ${EDGE}/.env`,
        ]
      : [];
  const installSite = certbot
    ? [
        `  if ${certbotRun(`--entrypoint test certbot -f ${certbotLive(app)}/fullchain.pem`)}; then`,
        `    cp edge/sites/${app}.${ext} ${site}`,
        "    first=0",
        "  else",
        `    cp edge/sites/${app}.http.${ext} ${site}`,
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
      `      ${sayFrom(plan, (from) => certbotFailed(hosts, `the server keeps ${from} as its proxy`))}`,
      '    elif [ "$first" -eq 1 ]; then',
      `      echo ${shellQuote(certbotFailed(hosts, "the site stays on HTTP only"))}`,
      "    else",
      `      echo ${shellQuote(certbotFailed(hosts, "the site keeps its current certificate (which may not cover every hostname)"))}`,
      "    fi",
      "    exit 1",
      "  fi",
      `  ${certbotRun(`--entrypoint sh certbot -c ${shellQuote(certbotRenewBefore(app))}`)}`,
      `  cp edge/sites/${app}.${ext} ${site}`,
      `  if ! ${RELOAD[proxy]}; then`,
      `    if [ -f ${PREVIOUS_EDGE} ]; then`,
      ...restoreFiles("      "),
      ...restoreEdge("      "),
      `      ${sayFrom(plan, (from) => switchFailed(plan, from))}`,
      `    elif [ "$first" -eq 0 ] && [ -f ${PREVIOUS_SITE} ]; then`,
      `      cp ${PREVIOUS_SITE} ${site}`,
      `      ${RELOAD[proxy]} || true`,
      "    else",
      `      cp edge/sites/${app}.http.${ext} ${site}`,
      `      ${RELOAD[proxy]} || true`,
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
    `  ${takeEdgeLock(plan)}`,
    `  docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    ...deployUser,
    `  uploaded="$(${stamp(EDGE_VERSION_KEY, "edge/compose.yaml")})"`,
    `  current="$(${stamp(EDGE_VERSION_KEY, `${EDGE}/compose.yaml`)} 2> /dev/null || true)"`,
    `  proxy="$(${stamp(EDGE_PROXY_KEY, `${EDGE}/compose.yaml`)} 2> /dev/null || true)"`,
    // OpenLiteSpeed's messages name the proxy the server ran.
    ...(proxy === "openlitespeed"
      ? [
          `  case "$proxy" in ${replacedProxies(proxy)
            .map((p) => `${p}) from=${shellQuote(EDGE_PROXIES[p].label)} ;;`)
            .join(" ")} *) from="$proxy" ;; esac`,
        ]
      : []),
    `  rm -f ${PREVIOUS_EDGE}`,
    `  if [ -n "$proxy" ] && [ "$proxy" != ${proxy} ]; then`,
    `    ${sayFrom(plan, (from) => switchNotice(plan, from))}`,
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
    ...(proxy !== "caddy" && !local
      ? [
          `  ${certbotRun(`--user 0:0 --cap-add CHOWN --entrypoint chown certbot "$(id -u):$(id -g)" ${LETSENCRYPT} ${ACME_WEBROOT} ${RELOAD_DIR}`)}`,
        ]
      : []),
    `  rm -f ${PREVIOUS_SITE} ${PREVIOUS_ADDITIONS}`,
    `  if [ -f ${site} ]; then cp ${site} ${PREVIOUS_SITE}; fi`,
    ...(shared === undefined
      ? []
      : [
          `  for f in ${shared}; do`,
          `    rm -f ${PREVIOUS_SITE}.$f`,
          `    if [ -f ${EDGE}/sites/${app}.$f ]; then cp ${EDGE}/sites/${app}.$f ${PREVIOUS_SITE}.$f; fi`,
          "  done",
          `  cp ${OPENLITESPEED_SHARED.map((f) => `edge/sites/${app}.${f}`).join(" ")} ${EDGE}/sites/`,
        ]),
    `  if [ -f ${additions} ]; then cp ${additions} ${PREVIOUS_ADDITIONS}; fi`,
    ...installSite,
    o.additions ? `  cp additions.${proxy} ${additions}` : `  rm -f ${additions}`,
    `  if ! edge up -d --wait --remove-orphans || ! ${RELOAD[proxy]}; then`,
    ...restoreFiles("    "),
    `    if [ -f ${PREVIOUS_EDGE} ]; then`,
    ...restoreEdge("      "),
    `      ${sayFrom(plan, (from) => switchFailed(plan, from))}`,
    "    fi",
    `    echo ${shellMessage(edgeFailed(plan, o.additions))}`,
    "    exit 1",
    "  fi",
    ...certificate,
    // Only now: a switch that failed above puts the previous proxy back with these files.
    `  rm -f ${replacedProxies(proxy)
      .map((p) => `${EDGE}/sites/${app}.${EDGE_PROXIES[p].site}`)
      .join(" ")}`,
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
 * part a snapshot holds on the app's server ({@link snapshotParts}), down migrations, or data on
 * an extra server a rollback changes ({@link changesOthers}).
 */
function databaseRollback(plan: DeployPlan, o: ScriptOptions): boolean {
  if (o.preview === true) return false;
  return (
    snapshotParts(plan).length > 0 || plan.app.migrations !== undefined || changesOthers(plan, o)
  );
}

/**
 * Whether a rollback can change the data on the app's extra servers (plan.md D7, D13): not in a
 * preview's scripts, with an extra server a rollback's choice changes ({@link rollbackServers}).
 * The workflow saves, and for the snapshot restores, their data from the runner before the start
 * step, and names those it changed in the start script's `$3`, comma-joined.
 */
function changesOthers(plan: DeployPlan, o: ScriptOptions): boolean {
  return o.preview !== true && rollbackServers(plan).length > 0;
}

/** The marker of a rollback's database step, in the app's folder (plan.md 12.4). */
export const DATABASE_CHANGED = ".database.changed";

/**
 * Reads a one-time approval `file` (`<what> <choice> <expiry>`) into `$approved`, `$choice` and
 * `$expiry`, and removes it at once, so it is used once.
 */
export function readApproval(file: string): string[] {
  return [
    'approved=""; choice=""; expiry=""; kept=""',
    `read -r approved choice expiry kept < ${file} || true`,
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
 * Runs `refuse` (lines that stop the script) when the approval's `$kept` names anything but the
 * app's queues ({@link queueServices}), comma-joined: only those a rollback keeps as they are. None
 * without queues, whose restore reads no `$kept`.
 */
function keptCheck(plan: DeployPlan, refuse: readonly string[]): string[] {
  const queues = queueServices(plan);
  if (queues.length === 0) return [];
  return [
    'kept_rest="$kept"',
    'while [ -n "$kept_rest" ]; do',
    `  case "\${kept_rest%%,*}" in ${queues.join(" | ")}) ;; *)`,
    ...refuse.map((line) => `    ${line}`),
    "  ;; esac",
    '  case "$kept_rest" in *,*) kept_rest="${kept_rest#*,}" ;; *) kept_rest="" ;; esac',
    "done",
  ];
}

/** True when `server` holds a part of one of the app's queues, which a rollback may keep. */
function keepsQueues(plan: DeployPlan, server: string): boolean {
  const queues = queueServices(plan);
  return snapshotParts(plan, server).some((part) => queues.includes(part.name));
}

/**
 * The file in the app's folder on an extra server where `check` leaves the queues the approval
 * keeps, `<target> <kept>`, for `change` ({@link serverRollbackCommands}).
 */
const ROLLBACK_KEPT_FILE = ".rollback-kept";

/** `$parts` without the queues the approval's `$kept` names. */
const KEPT_OUT =
  'parts="$(for kept_part in $parts; do case ",$kept," in *",$kept_part,"*) ;; *) echo "$kept_part" ;; esac; done)"';

/**
 * The approval's check, first in the script: `$target` is `$1`'s digest and `$running` the one
 * `.env` names, if any. In `MODE` `rollback`, {@link ROLLBACK_APPROVAL_FILE} is read and removed
 * at once ({@link readApproval}), so it is used once:
 * - one for another version is ignored with a note, and the rollback keeps the data;
 * - one for `$target` sets `$database` to its choice (`snapshot` with a part a snapshot holds on
 *   the app's server or an extra server's; `migrations` with `app.migrations`), or, past its time
 *   ({@link approvalExpiry}), with another choice, or keeping a service that is not one of the
 *   app's queues ({@link keptCheck}), stops the script before any change: the user approved the
 *   switch and the database step together.
 * With `others` ({@link changesOthers}), `$others` is `$3` with its commas as spaces: the extra
 * servers whose data the workflow changed for this rollback. They must be exactly those the
 * choice changes ({@link rollbackServers}; none to keep the data); otherwise the script stops
 * before any change here, and the workflow's rollback step puts their data back.
 * The deploy's snapshot uses `$target` and `$running` too.
 */
function approvalCheck(plan: DeployPlan, others: boolean): string[] {
  const snapshotServers = rollbackServers(plan, "snapshot").join(" ");
  const choices = [
    ...(snapshotParts(plan).length > 0 || snapshotServers !== "" ? ["snapshot"] : []),
    ...(plan.app.migrations === undefined ? [] : ["migrations"]),
  ];
  const file = ROLLBACK_APPROVAL_FILE;
  const checkOthers = others
    ? [
        `others="$(printf '%s' "\${3:-}" | tr , ' ')"`,
        'case "$database" in',
        `  snapshot) expected=${shellQuote(snapshotServers)} ;;`,
        `  migrations) expected=${shellQuote(rollbackServers(plan, "migrations").join(" "))} ;;`,
        '  *) expected="" ;;',
        "esac",
        'if [ "$others" != "$expected" ]; then',
        `  printf ${printfFormat(`::error::The app's other servers this rollback changed (%s) aren't those this server's one-time approval (${file}) needs (%s), so nothing was changed here, and the rollback step puts their data back. Run opscrew rollback again.`)} "\${others:-none}" "\${expected:-none}"`,
        "  exit 1",
        "fi",
      ]
    : [];
  return [
    `rm -f ${DATABASE_CHANGED}`,
    "database=keep",
    'target="${1##*@sha256:}"',
    ...snapshotRunning(),
    'running="$(snapshot_running)"',
    `if [ "$MODE" = rollback ] && [ -f ${file} ]; then`,
    ...readApproval(file).map((line) => `  ${line}`),
    '  if [ "$approved" != "$target" ]; then',
    `    echo ${shellQuote(`::warning::The approval to change the database on a rollback (${file} on the server) is for another version, so OpsCrew removed it: this rollback keeps the database as it is.`)}`,
    "  else",
    `    case "$choice" in ${choices.join(" | ")}) ;; *)`,
    `      echo ${shellQuote(`::error::The one-time approval to change the database on this rollback (${file} on the server) names a choice this server can't carry out, so nothing was changed. Run opscrew rollback again.`)}`,
    "      exit 1 ;;",
    "    esac",
    ...keptCheck(plan, [
      `echo ${shellQuote(`::error::The one-time approval to change the database on this rollback (${file} on the server) keeps a service that isn't one of the app's queues, so nothing was changed. Run opscrew rollback again.`)}`,
      "exit 1",
    ]).map((line) => `    ${line}`),
    ...approvalExpiry([
      `echo ${shellQuote("::error::The one-time approval to restore or migrate the database on this rollback expired before the run started, so nothing was changed. Run opscrew rollback again.")}`,
      "exit 1",
    ]).map((line) => `    ${line}`),
    '    database="$choice"',
    "  fi",
    "fi",
    ...checkOthers,
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
 * A snapshot's copy and restore leave out the queues the approval keeps ({@link KEPT_OUT}).
 * The copies and restores are {@link SNAPSHOT_FUNCTIONS}'. The switch to `$1` that follows is always
 * `recreate`'s. When step 4 fails, step 3's copy is restored, the running version's web, workers
 * and cron start again (the ones {@link PREVIOUS_PROCESSES} lists), the marker goes, and the script
 * exits 1 with `.env` unchanged; the requests resume on the exit. When that restore fails too, no
 * version starts on the database and the marker stays, so the rollback script tries once more
 * ({@link databaseBack}). Without a copy, the running version starts on the database as step 4
 * left it.
 *
 * With `others` ({@link changesOthers}), the workflow saved, and for the snapshot restored, the
 * data on the extra servers `$others` names before this step, the app held and stopped. When this
 * step fails, the running version doesn't start here: the workflow's rollback step puts those
 * servers' data back first, then starts it. Without a part on the app's server, the marker never
 * says `changed=1`: the extra servers' own markers cover the data the step changes.
 */
function databaseStep(plan: DeployPlan, others: boolean): string[] {
  const folder = appFolder(plan);
  const parts = snapshotParts(plan);
  const { migrations } = plan.app;
  const note = snapshotLogNote(plan);
  /** The marker with `changed` (0 before step 4, 1 from it on). */
  const mark = (changed: 0 | 1) =>
    `  (umask 077; printf 'target=%s\\nAPP_IMAGE=%s\\nsaved=%s\\nchanged=%s\\n' "$target" "$before" "$saved" ${changed} > ${DATABASE_CHANGED})`;
  // The app's queues here the approval may keep as they are ({@link KEPT_OUT}).
  const keeps = keepsQueues(plan, APP_SERVER);
  const changing =
    // Without a part here, the extra servers' own markers cover the data the step changes.
    parts.length > 0 || !others
      ? keeps
        ? // A snapshot whose every part here is a kept queue changes nothing here.
          ['  if [ "$database" != snapshot ] || [ -n "$parts" ]; then', `  ${mark(1)}`, "  fi"]
        : [mark(1)]
      : [];
  /** Changes nothing more: the running version starts again, the marker goes, the script stops. */
  const giveUp = [
    `rm -f ${DATABASE_CHANGED}`,
    others ? `if [ -z "$others" ]; then ${startApp(plan)}; fi` : startApp(plan),
    "exit 1",
  ];
  /** The parts the down migrations change: the databases and SQLite. */
  const migrated = migratedParts(plan, APP_SERVER).map((part) => part.name);
  const save =
    parts.length > 0
      ? [
          '  parts=""',
          '  case "$database" in',
          `    snapshot) parts="$(snapshot_parts "$target")"${keeps ? `; ${KEPT_OUT}` : ""} ;;`,
          ...(migrations === undefined
            ? []
            : [`    migrations) parts=${shellQuote(migrated.join(" "))} ;;`]),
          "  esac",
          '  if [ -n "$parts" ]; then',
          "    snap=0",
          '    snapshot_take "$running" release "$running" $parts || snap=$?',
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
  const alone = `printf ${printfFormat(`::error::%s failed, and no copy of the database from before the rollback was saved (OpsCrew saves only the PostgreSQL, MySQL, MariaDB, MongoDB and SQLite databases on the app's server), so the database may be partly changed; the running version starts again. ${note} Fix the cause, then run opscrew rollback again or restore a backup.`)} "$what" ${folder}`;
  const noCopy = [
    others
      ? `if [ -n "$others" ]; then printf ${printfFormat(`::error::%s failed: the rollback step puts the data on the app's other servers back from the copies this run saved there, then starts the running version again. ${note}`)} "$what" ${folder}; else ${alone}; fi`
      : alone,
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
          ...(keeps
            ? [
                '      if [ -z "$parts" ]; then',
                `        echo ${shellQuote("OpsCrew kept the data on the server as it is: the rollback keeps the app's queues.")}`,
                '      elif snapshot_restore "$target" $parts; then',
              ]
            : ['      if snapshot_restore "$target" $parts; then']),
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
    ...changing,
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
 * holds {@link START_LOCK} from its first lines in the app's folder to its end. While a restore or a
 * rotation holds the app ({@link RESTORE_HELD}) it changes nothing and fails, saying which.
 */
export function switchCommands(
  plan: DeployPlan,
  init: readonly ServiceInitStep[],
  edgeFiles: EdgeFiles = { originTls: false, additions: false },
  o: ScriptOptions = {},
): string[] {
  const steady = steadyServices(plan);
  const data = databaseRollback(plan, o);
  const others = changesOthers(plan, o);
  const record = recordProcesses(processServices(plan));
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
    ...heldRefusal(plan, o),
    `echo started > ${START_OUTCOME}`,
    'export APP_IMAGE="$1"',
    'RUN_IMAGE="$1"',
    'MODE="${2:-deploy}"',
    ...(data ? approvalCheck(plan, others) : []),
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
    // A rollback that changes the extra servers' data finds the app held and stopped by the
    // workflow (`others`): the hold's record stays.
    ...(others && record.length > 0
      ? [
          'if [ "$MODE" = rollback ]; then',
          ...recordRunning(plan).map((line) => `  ${line}`),
          "else",
          ...record.map((line) => `  ${line}`),
          "fi",
        ]
      : record),
    ...(data ? databaseStep(plan, others) : []),
    ...switching,
    ...startProcesses(processServices(plan), [
      `printf ${shellMessage(processFailed(plan))} "$service" "$service"`,
      'keep_failed "$service" "$id" "process $service"',
    ]),
    `echo finished > ${START_OUTCOME}`,
  ];
}

/**
 * {@link recordProcesses} only while the web runs: after a hold, which stopped the workers and
 * cron, its record stays.
 */
export function recordRunning(plan: DeployPlan): string[] {
  const record = recordProcesses(processServices(plan));
  if (record.length === 0) return [];
  return [
    'if [ -n "$(docker compose ps -q app)" ]; then',
    ...record.map((line) => `  ${line}`),
    "fi",
  ];
}

/**
 * `image_ref <word>`: true for an image reference by digest that a script may pass on and write
 * (`<name>@sha256:<64 lower-case hex>`, of letters, digits and `./:@_-` only), and for an empty
 * word, which names none.
 */
const IMAGE_REF = [
  "image_ref() {",
  '  case "$1" in',
  '    "") return 0 ;;',
  "    *[!A-Za-z0-9./:@_-]* | *@*@*) return 1 ;;",
  "    *@sha256:*) ;;",
  "    *) return 1 ;;",
  "  esac",
  '  _ref_hex="${1##*@sha256:}"',
  '  case "$_ref_hex" in *[!0-9a-f]*) return 1 ;; esac',
  '  [ "${#_ref_hex}" -eq 64 ]',
  "}",
];

/** `server` in a message: "the app's server" or "the server <name>". */
export function serverWords(server: string): string {
  return server === APP_SERVER ? "the app's server" : `the server ${server}`;
}

/** Where the copies' and restores' output stays on `server`; `%s` is the app's folder. */
function serverLogWords(server: string): string {
  return `The output of the copies and restores stays on ${serverWords(server)} in %s/${SNAPSHOT_LOG} (it can quote data, so it is not printed here).`;
}

/**
 * The release snapshot on the extra server `server` (plan.md D7), before its services change:
 * in `MODE` `deploy`, when `$running` (the image the app's server runs, which the workflow read
 * there) is another version than `$target` (the new one), {@link SNAPSHOT_SCRIPT}'s
 * `take release --version` copies the server's data under the running version. A service with no
 * container yet (new on the server) has nothing to copy and is left out. A failed copy stops the
 * deploy before anything changes; too little disk warns, and the deploy goes on without its part.
 */
function serverSnapshotStep(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const where = serverWords(server);
  const names = snapshotParts(plan, server).map((part) => part.name);
  return [
    'if [ "$MODE" = deploy ] && [ -n "$running" ] && [ "${running##*@sha256:}" != "${target##*@sha256:}" ]; then',
    '  skip=""',
    `  for part in ${names.join(" ")}; do`,
    '    if [ -z "$(docker compose ps -aq "$part")" ]; then skip="$skip --skip $part"; fi',
    "  done",
    "  snap=0",
    `  sh ./${SNAPSHOT_SCRIPT} take release --version "sha256:\${running##*@sha256:}" $skip > /dev/null || snap=$?`,
    '  case "$snap" in',
    `    0) echo ${shellQuote(`OpsCrew took a snapshot of the data on ${where} before this release: a rollback to the previous version can restore it.`)} ;;`,
    `    2) printf ${printfFormat(`::warning::The disk that holds %s on ${where} has less than 1 GiB or 10%% free, so OpsCrew takes no snapshot of the data there this time, and a rollback can't restore it to this moment. Free some space, or keep fewer snapshots (deploy.keepSnapshots in ${planFilePath(plan)}).`)} ${folder} ;;`,
    "    *)",
    `      printf ${printfFormat(`::error::The snapshot of the data on ${where} before this release failed, so the new version was not started and the previous version keeps serving. ${serverLogWords(server)} Fix its cause and push again, or set deploy.snapshots: false in ${planFilePath(plan)} to deploy without snapshots.`)} ${folder}`,
    "      exit 1 ;;",
    "  esac",
    "fi",
  ];
}

/**
 * The script that updates the services on the extra server `server` (POSIX sh, in the app's folder
 * there, where the deploy uploaded the server's Compose file and its services' env files): pulls
 * their images, takes the server's part of the release snapshot when it has one
 * ({@link releaseSnapshotOn}, {@link serverSnapshotStep}), starts them (Compose recreates only what
 * changed and removes the containers of services that left the server) and waits until they are
 * healthy, repairs a port that came up unpublished ({@link portRepair}), runs their one-time setup
 * steps (`init`), then writes or removes the server's line for scheduled snapshots
 * ({@link snapshotScheduleLines}). With the release snapshot, its arguments are the new image, the
 * mode and the image the app's server runs (absent on a first deploy: ssh drops an empty word),
 * each checked before use. On a server a rollback changes ({@link rollbackServers}), an earlier
 * run's {@link DATABASE_CHANGED} goes first, as on the app's server. Any failure exits non-zero,
 * before the app's switch.
 */
export function serverCommands(
  plan: DeployPlan,
  server: string,
  init: readonly ServiceInitStep[],
): string[] {
  const release = releaseSnapshotOn(plan, server);
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    ...(rollbackServers(plan).includes(server) ? [`rm -f ${DATABASE_CHANGED}`] : []),
    ...(release
      ? [
          'target="${1:-}"',
          'MODE="${2:-}"',
          'running="${3:-}"',
          ...IMAGE_REF,
          'if [ -z "$target" ] || ! image_ref "$target" || ! image_ref "$running" || { [ "$MODE" != deploy ] && [ "$MODE" != rollback ]; }; then',
          `  echo ${shellQuote(`::error::The deploy step of the server ${server} was given no image digests or mode it can use, so nothing changed there. Run the workflow again.`)}`,
          "  exit 1",
          "fi",
        ]
      : []),
    "docker compose pull",
    ...(release ? serverSnapshotStep(plan, server) : []),
    "docker compose up -d --wait --remove-orphans",
    ...portRepair(plan, server),
    ...serviceInit(plan, init, initLog(plan), server),
    ...snapshotScheduleLines(plan, server),
  ];
}

/**
 * The rollback's script on the extra server `server` (POSIX sh, in the app's folder there; plan.md
 * D7, D13), which the workflow runs from the runner with the snapshot functions of the server's
 * {@link SNAPSHOT_SCRIPT}, under the app's start lock there. Its arguments are checked first. A
 * rollback that changes the data there leaves {@link DATABASE_CHANGED}, as the app's server does:
 * `target=`, `saved=` (the running version, whose copy it saved), `changed=` (1 once the data
 * may differ from that copy) and `choice=` (`snapshot` or `migrations`).
 * - `check <target>` reads and removes the server's one-time approval
 *   ({@link ROLLBACK_APPROVAL_FILE}) and prints its choice, `snapshot` (the target's snapshot there
 *   must be complete) or `migrations`, or `keep` without one (one for another version is removed
 *   with a note); an expired one, a choice it can't carry out, or one keeping a service that is not
 *   one of the app's queues ({@link keptCheck}), exits 1. It leaves the queues a snapshot's
 *   approval keeps for `change` ({@link ROLLBACK_KEPT_FILE});
 * - `change <choice> <target> <running>` (the app held and stopped): writes the marker, copies the
 *   parts the choice changes under the running version, as the app's server does (the target
 *   snapshot's parts, or the databases the down migrations change), marks `changed=1`, and for
 *   the snapshot restores it, leaving out the queues `check` left (with none other there, it
 *   changes nothing and exits 0). It exits 1 when nothing was changed (the copy failed, or the restore
 *   failed and the copy is back; the marker goes), 2 when putting the copy back failed too (the
 *   marker stays);
 * - `marked <target> <running>` prints `marked <choice>` when this run's marker (the same target and
 *   running version) says the data may have changed, `none` otherwise;
 * - `back <target> <running>` restores this run's copy where its marker says the data may have
 *   changed, and removes the marker; with no such marker it changes nothing.
 * Messages go to stderr and never quote data.
 */
export function serverRollbackCommands(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const where = serverWords(server);
  const file = ROLLBACK_APPROVAL_FILE;
  const marker = DATABASE_CHANGED;
  const log = serverLogWords(server);
  const migrated = migratedParts(plan, server).map((part) => part.name);
  // The app's queues here the approval may keep as they are ({@link KEPT_OUT}).
  const keeps = keepsQueues(plan, server);
  const choices = (["snapshot", "migrations"] as const).filter((choice) =>
    rollbackServers(plan, choice).includes(server),
  );
  const usage = (args: string, check: string) => [
    `    if ${check}; then`,
    `      echo ${shellQuote(`::error::The rollback's script on ${where} needs ${args}, so nothing was changed there.`)} >&2`,
    "      exit 1",
    "    fi",
  ];
  /** `$2`, `$3`… as `target` and `running`, both images by digest of other versions. */
  const versions = ['    target="${2##*@sha256:}"', '    running="${3##*@sha256:}"'];
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${folder}`,
    ...IMAGE_REF,
    SNAPSHOT_FUNCTIONS,
    ...startLock(
      plan,
      `::error::A snapshot on ${where} kept the app's start lock there for 15 minutes, so the rollback changed nothing there. Run opscrew rollback again.`,
    ),
    "mark() {",
    `  (umask 077; printf 'target=%s\\nsaved=%s\\nchanged=%s\\nchoice=%s\\n' "$target" "$running" "$1" "$2" > ${marker})`,
    "}",
    "ours() {",
    `  [ -f ${marker} ] && [ "$(sed -n 's/^target=//p' ${marker})" = "$target" ] && [ "$(sed -n 's/^saved=//p' ${marker})" = "$running" ]`,
    "}",
    "changed() {",
    `  ours && [ "$(sed -n 's/^changed=//p' ${marker})" = 1 ]`,
    "}",
    'case "${1:-}" in',
    "  check)",
    ...usage("the image it goes back to", '[ "$#" -ne 2 ] || [ -z "$2" ] || ! image_ref "$2"'),
    '    target="${2##*@sha256:}"',
    `    if [ ! -f ${file} ]; then echo keep; exit 0; fi`,
    ...readApproval(file).map((line) => `    ${line}`),
    '    if [ "$approved" != "$target" ]; then',
    `      echo ${shellQuote(`::warning::The approval to change the data on ${where} on a rollback (${file} there) is for another version, so OpsCrew removed it: this rollback keeps the data there as it is.`)} >&2`,
    "      echo keep",
    "      exit 0",
    "    fi",
    // A server a rollback changes ({@link rollbackServers}) has at least one of them.
    `    case "$choice" in ${choices.join(" | ")}) ;; *)`,
    `      echo ${shellQuote(`::error::The one-time approval on ${where} (${file}) names a choice it can't carry out, so nothing was changed. Run opscrew rollback again.`)} >&2`,
    "      exit 1 ;;",
    "    esac",
    ...keptCheck(plan, [
      `echo ${shellQuote(`::error::The one-time approval on ${where} (${file}) keeps a service that isn't one of the app's queues, so nothing was changed. Run opscrew rollback again.`)} >&2`,
      "exit 1",
    ]).map((line) => `    ${line}`),
    ...approvalExpiry([
      `echo ${shellQuote(`::error::The one-time approval to change the data on ${where} on this rollback expired before the run started, so nothing was changed. Run opscrew rollback again.`)} >&2`,
      "exit 1",
    ]).map((line) => `    ${line}`),
    '    if [ "$choice" = snapshot ] && ! snapshot_complete "$target"; then',
    `      echo ${shellQuote(`::error::The snapshot this rollback was approved to restore is no longer complete on ${where} (in ${SNAPSHOTS_DIR}), so the rollback changed nothing. Run opscrew rollback again to choose again.`)} >&2`,
    "      exit 1",
    "    fi",
    // `change` runs after `check` removed the approval: it reads the queues kept there.
    ...(keeps
      ? [
          `    rm -f ${ROLLBACK_KEPT_FILE}`,
          '    if [ "$choice" = snapshot ] && [ -n "$kept" ]; then',
          `      (umask 077; printf '%s %s\\n' "$target" "$kept" > ${ROLLBACK_KEPT_FILE})`,
          "    fi",
        ]
      : []),
    '    echo "$choice" ;;',
    "  change)",
    ...usage(
      "a choice, the image it goes back to and the one that runs",
      '[ "$#" -ne 4 ] || [ -z "$3" ] || [ -z "$4" ] || ! image_ref "$3" || ! image_ref "$4" || [ "${3##*@sha256:}" = "${4##*@sha256:}" ]',
    ),
    '    target="${3##*@sha256:}"',
    '    running="${4##*@sha256:}"',
    ...(keeps
      ? [
          '    kept=""; kept_for=""',
          `    if [ -f ${ROLLBACK_KEPT_FILE} ]; then read -r kept_for kept < ${ROLLBACK_KEPT_FILE} || true; rm -f ${ROLLBACK_KEPT_FILE}; fi`,
          '    if [ "$kept_for" != "$target" ]; then kept=""; fi',
          ...keptCheck(plan, [
            `echo ${shellQuote(`::error::The queues the rollback keeps on ${where} (${ROLLBACK_KEPT_FILE}) name a service that isn't one of the app's queues, so nothing was changed there. Run opscrew rollback again.`)} >&2`,
            "exit 1",
          ]).map((line) => `    ${line}`),
        ]
      : []),
    '    case "$2" in',
    `      snapshot) snapshot_complete "$target" || exit 1; parts="$(snapshot_parts "$target")"${keeps ? `; ${KEPT_OUT}` : ""} ;;`,
    `      migrations) parts=${shellQuote(migrated.join(" "))} ;;`,
    "      *) exit 1 ;;",
    "    esac",
    ...(keeps
      ? [
          '    if [ -z "$parts" ]; then',
          `      echo ${shellQuote(`OpsCrew kept the data on ${where} as it is: the rollback keeps the app's queues there.`)} >&2`,
          "      exit 0",
          "    fi",
        ]
      : []),
    '    mark 0 "$2"',
    '    if ! snapshot_take "$running" release "$running" $parts; then',
    `      rm -f ${marker}`,
    `      ${said(`::error::OpsCrew could not save the data on ${where} before changing it (a copy failed, or the disk is too full), so the rollback changed nothing there. ${log}`)} ${folder} >&2`,
    "      exit 1",
    "    fi",
    '    mark 1 "$2"',
    '    if [ "$2" = migrations ]; then',
    `      echo ${shellQuote(`OpsCrew saved the data on ${where} before the down migrations change it.`)} >&2`,
    "      exit 0",
    "    fi",
    '    if snapshot_restore "$target" $parts; then',
    `      echo "OpsCrew restored the data on ${where} from the snapshot taken $(cat ${snapshotTakenPath('"$target"')})." >&2`,
    "      exit 0",
    "    fi",
    '    if snapshot_restore "$running" $parts; then',
    `      rm -f ${marker}`,
    `      ${said(`::error::Restoring the snapshot on ${where} failed, so OpsCrew put its data back as it was before the rollback. ${log}`)} ${folder} >&2`,
    "      exit 1",
    "    fi",
    `    ${said(`::error::Restoring the snapshot on ${where} failed, and putting its data back as it was before the rollback failed too, so it may be partly changed. Its copy from before the rollback stays there in %s/${SNAPSHOTS_DIR}/%s. ${log}`)} ${folder} "$running" ${folder} >&2`,
    "    exit 2 ;;",
    "  marked)",
    ...usage(
      "the image it goes back to and the one that ran before",
      '[ "$#" -ne 3 ] || [ -z "$2" ] || [ -z "$3" ] || ! image_ref "$2" || ! image_ref "$3"',
    ),
    ...versions,
    `    if changed; then echo "marked $(sed -n 's/^choice=//p' ${marker})"; else echo none; fi ;;`,
    "  back)",
    ...usage(
      "the image it went back to and the one that ran before",
      '[ "$#" -ne 3 ] || [ -z "$2" ] || [ -z "$3" ] || ! image_ref "$2" || ! image_ref "$3"',
    ),
    ...versions,
    "    if ! changed; then",
    `      if ours; then rm -f ${marker}; fi`,
    "      exit 0",
    "    fi",
    '    if snapshot_complete "$running" && snapshot_restore "$running" $(snapshot_parts "$running"); then',
    `      rm -f ${marker}`,
    `      echo ${shellQuote(`OpsCrew put the data on ${where} back as it was before the rollback.`)} >&2`,
    "      exit 0",
    "    fi",
    `    ${said(`::error::Putting the data on ${where} back as it was before the rollback failed, so it may be partly changed. Its copy from before the rollback stays there in %s/${SNAPSHOTS_DIR}/%s. ${log}`)} ${folder} "$running" ${folder} >&2`,
    "    exit 1 ;;",
    "  *)",
    `    echo ${shellQuote(`::error::The rollback's script on ${where} knows only check, change, marked and back, so nothing was changed there.`)} >&2`,
    "    exit 1 ;;",
    "esac",
  ];
}

/**
 * The file in the app's folder on the app's server that says which workflow run
 * (`<run id>.<attempt>`) held the app to change the data on its extra servers: written by
 * `hold`, removed by `resume` and `forget` ({@link appHoldCommands}). Without it for this run, no
 * extra server's data was changed, and the rollback step asks none of them.
 */
export const OTHERS_HELD = ".others.held";

/**
 * The app's server's script that holds and resumes the app around the changes on its extra
 * servers (POSIX sh, in the app's folder; 019's code, as `snapshot.sh hold` and `resume`), which
 * the workflow runs from the runner with one command:
 * - `hold <run>`: under the start lock (waiting up to 15 minutes), records the run in
 *   {@link OTHERS_HELD} and which workers and cron run while the web runs
 *   ({@link recordRunning}), holds the requests ({@link pauseRequests}) and stops the web, workers
 *   and cron ({@link stopApp});
 * - `stop`: holds the requests and stops them, under the lock, keeping the earlier record;
 * - `resume`: starts them again ({@link startApp}), lets the requests through and removes the
 *   run's record;
 * - `requests`: lets the requests through, the app left stopped;
 * - `held <run>` prints `held` when the record names the run, `none` otherwise;
 * - `forget` removes the record.
 * kamal-proxy lets the requests through itself after its longest hold. While a restore or a rotation
 * holds the app ({@link RESTORE_HELD}), `hold`, `stop`, `resume` and `requests` fail before any
 * change.
 */
export function appHoldCommands(plan: DeployPlan): string[] {
  const lock = startLock(
    plan,
    `::error::The start script is still running on the app's server after ${START_LOCK_WAIT_SECONDS / 60} minutes, so OpsCrew changed nothing. Check the app on the server (${runbookFilePath(plan)} has the SSH command), then run the deploy or opscrew rollback again.`,
  );
  const record = recordRunning(plan);
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    EDGE_FUNCTION,
    ...heldRefusal(plan, {}).map(
      (line) => `case "\${1:-}" in hold | stop | resume | requests) ${line} ;; esac`,
    ),
    'case "${1:-}" in',
    "  hold | stop)",
    ...lock.map((line) => `    ${line}`),
    '    if [ "$1" = hold ]; then',
    '      case "${2:-}" in "" | *[!0-9.]*)',
    `        echo ${shellQuote("::error::The app's hold script needs the workflow run that holds the app, so nothing was changed.")} >&2`,
    "        exit 1 ;;",
    "      esac",
    `      (umask 077; printf '%s\\n' "$2" > ${OTHERS_HELD})`,
    ...record.map((line) => `      ${line}`),
    "    fi",
    ...holdApp(plan).map((line) => `    ${line}`),
    "    ;;",
    "  resume)",
    ...resumeApp(plan).map((line) => `    ${line}`),
    `    rm -f ${OTHERS_HELD} ;;`,
    `  requests) ${resumeRequests(plan)} ;;`,
    `  held) if [ -n "\${2:-}" ] && [ "$(cat ${OTHERS_HELD} 2> /dev/null)" = "$2" ]; then echo held; else echo none; fi ;;`,
    `  forget) rm -f ${OTHERS_HELD} ;;`,
    "  *)",
    `    echo ${shellQuote("::error::The app's hold script knows only hold, stop, resume, requests, held and forget.")} >&2`,
    "    exit 1 ;;",
    "esac",
  ];
}

/**
 * The script that writes {@link RUNNING_FILE} in the app's folder on an extra server (POSIX sh):
 * `$1`, the image the app's server runs, checked first; with none, the file goes, so the server's
 * snapshots record no version rather than a wrong one (plan.md D7).
 */
export function runningCommands(plan: DeployPlan): string[] {
  return [
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    ...IMAGE_REF,
    'if ! image_ref "${1:-}"; then',
    `  echo ${shellQuote(`::error::The version the app's server runs is no image digest, so OpsCrew left ${RUNNING_FILE} as it was.`)} >&2`,
    "  exit 1",
    "fi",
    `if [ -z "\${1:-}" ]; then rm -f ${RUNNING_FILE}; exit 0; fi`,
    `(umask 077; printf '%s\\n' "$1" > ${RUNNING_FILE}.new && mv -f ${RUNNING_FILE}.new ${RUNNING_FILE})`,
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
 * computer `localhost` is the app's hostname there, as the start script had it. Once it holds the
 * lock, while the app is held ({@link RESTORE_HELD}), it prints `held` and what holds it, and
 * changes nothing.
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
    ...heldRefusal(plan, o, "held"),
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
