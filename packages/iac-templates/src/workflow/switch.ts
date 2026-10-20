// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import type { DeployPlan, ImageBuilder } from "@opscrew/plan-schema";
import { appDir, EDGE_DIR, EDGE_PROJECT, EDGE_VERSION_KEY } from "../edge";
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

/** The edge's Compose project, from any folder: `edge up -d`, `edge exec -T caddy …`. */
const EDGE_FUNCTION = `edge() { docker compose -p ${EDGE_PROJECT} -f ${EDGE_DIR}/compose.yaml "$@"; }`;

/**
 * kamal-proxy's hostnames for the app's service: the domain, and `www.<domain>` redirected to it
 * (`--canonical-host`); none before the plan has a domain (the service then gets every request).
 */
function proxyHosts(plan: DeployPlan): string {
  const [domain, ...others] = siteHosts(plan);
  if (domain === undefined) return "";
  return others.length === 0
    ? ` --host ${domain}`
    : ` --host ${[domain, ...others].join(",")} --canonical-host ${domain}`;
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

/** Shown when the edge did not start or refused the app's site; names no server and no secret. */
function edgeFailed(plan: DeployPlan): string {
  return `::error::OpsCrew's shared edge on the server (Caddy and kamal-proxy, in ${EDGE_DIR}) did not start or did not accept this app's site (opscrew/runtime/edge/sites/${plan.app.name}.caddy), so the new version was not started, the previous version keeps serving and Caddy keeps the site it had. The error is above: fix its cause (for example a port another program uses, or a hostname another app on the server serves) and push again.`;
}

/**
 * The shared edge, under a lock other apps' deploys wait for: creates the network `opscrew-edge`
 * when missing; puts the uploaded edge Compose file (`edge/compose.yaml` in the app's folder) in
 * `/srv/edge` only when its {@link EDGE_VERSION_KEY} is larger than the server's, so an app with an
 * older OpsCrew never downgrades the edge, or when it is the same version with other content (the
 * ports of another access mode, which all the server's apps share); puts the app's site in
 * `/srv/edge/sites`; then starts
 * the edge (Compose recreates only what changed) and reloads Caddy. When either fails, the app's
 * previous site goes back, so Caddy never keeps a site it refused.
 */
function edgeCommands(plan: DeployPlan): string[] {
  const site = `${EDGE_DIR}/sites/${plan.app.name}.caddy`;
  const version = (file: string) => `sed -n 's/^${EDGE_VERSION_KEY}: //p' ${file}`;
  return [
    `mkdir -p ${EDGE_DIR}/sites`,
    "(",
    "  flock 9",
    `  docker network inspect ${EDGE_PROJECT} > /dev/null 2>&1 || docker network create ${EDGE_PROJECT} > /dev/null`,
    `  uploaded="$(${version("edge/compose.yaml")})"`,
    `  current="$(${version(`${EDGE_DIR}/compose.yaml`)} 2> /dev/null || true)"`,
    '  if [ "$uploaded" -gt "${current:-0}" ]; then',
    `    cp edge/compose.yaml ${EDGE_DIR}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server is now version $uploaded."`,
    // The same version with other ports: how the server's apps are served changed (they all are
    // served the same way, the host plan refuses anything else), so this app's copy is the one.
    `  elif [ "$uploaded" -eq "\${current:-0}" ] && ! cmp -s edge/compose.yaml ${EDGE_DIR}/compose.yaml; then`,
    `    cp edge/compose.yaml ${EDGE_DIR}/compose.yaml`,
    `    echo "OpsCrew's shared edge on this server now publishes the ports for how this app is served."`,
    '  elif [ "$uploaded" -lt "${current:-0}" ]; then',
    `    echo "The server's shared edge (version $current) is newer than this app's ($uploaded), so it stays."`,
    "  fi",
    `  rm -f ${PREVIOUS_SITE}`,
    `  if [ -f ${site} ]; then cp ${site} ${PREVIOUS_SITE}; fi`,
    `  cp edge/sites/${plan.app.name}.caddy ${site}`,
    "  if ! edge up -d --wait || ! edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null; then",
    `    if [ -f ${PREVIOUS_SITE} ]; then cp ${PREVIOUS_SITE} ${site}; else rm -f ${site}; fi`,
    `    echo ${shellQuote(edgeFailed(plan))}`,
    "    exit 1",
    "  fi",
    `) 9> ${EDGE_DIR}/.lock`,
  ];
}

/**
 * The server script of the start step (POSIX sh, in the app's folder `/srv/apps/<app>`; the image
 * is `$1`, already checked to be a GHCR digest reference), in this order:
 * 1. pull the app's images;
 * 2. the shared edge ({@link edgeCommands});
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
export function switchCommands(plan: DeployPlan, init: readonly ServiceInitStep[]): string[] {
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
    ...edgeCommands(plan),
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
