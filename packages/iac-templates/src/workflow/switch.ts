import type { DeployPlan, ImageBuilder } from "@opscrew/plan-schema";
import { hasCronJobs, healthPath } from "./shared";

/**
 * Where the release command's output stays: on the server, readable only by the deploy user. It is
 * never printed in the workflow log, which is public for public repositories, because a failed
 * migration can quote rows of the database.
 */
const RELEASE_LOG = "/srv/app/release.log";

/** Shown when the release command fails; names neither the server nor any secret. */
const RELEASE_FAILED = `::error::The release command (app.releaseCommand in opscrew/plan.yaml) failed, so the new version was not started and the previous version keeps serving. Its output stays on the server in ${RELEASE_LOG} (it can quote data from the database, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the command or the app and push again.`;

const RELEASE_DONE = `The release command finished; its output is in ${RELEASE_LOG} on the server.`;

/** Quotes `value` for a POSIX shell (single quotes; embedded quotes become `'\''`). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
 * configuration changed: the plan's enabled services by name, kamal-proxy and Caddy.
 */
function steadyServices(plan: DeployPlan): string[] {
  return [
    ...plan.services.filter((service) => service.enabled).map((service) => service.name),
    "proxy",
    "caddy",
  ];
}

/** Where the output of a failed one-time setup step stays on the server, as {@link RELEASE_LOG}. */
const INIT_LOG = "/srv/app/init.log";

/**
 * A step of a service's one-time setup, from the catalog (for example Garage's key and bucket):
 * `run` executes in the running `service` only when `check` fails there, so a deploy skips the
 * steps an earlier one did. Both are argument lists for `docker compose exec`, which needs no
 * shell in the image.
 */
export interface ServiceInitStep {
  /** The Compose service, started by the deploy just before. */
  service: string;
  /** Exits 0 when the step is already done; without it, `run` (harmless to repeat) always runs. */
  check?: readonly string[];
  run: readonly string[];
  /**
   * The service's env file in the app's folder, for example `garage.env`: the step loads it in a
   * subshell, and a word may name one of its variables as `${NAME}`, which the server's shell
   * fills in. Its values reach only the command, never the output.
   */
  envFile?: string;
}

/** A variable of a step's env file, as a word names it. */
const ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;

/**
 * A word for the server's shell: single-quoted, or, with `expand` and a `${NAME}` in it,
 * double-quoted with only those references left for the shell to fill in.
 */
function shellWord(word: string, expand: boolean): string {
  if (!expand || !word.match(ENV_REFERENCE)) return shellQuote(word);
  const literal = (text: string) => text.replace(/[\\"`$]/g, "\\$&");
  let quoted = "";
  let last = 0;
  for (const match of word.matchAll(ENV_REFERENCE)) {
    quoted += literal(word.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return `"${quoted}${literal(word.slice(last))}"`;
}

/** `words` in the running `service`, without a TTY and with no stdin (the script arrives on it). */
function exec(service: string, words: readonly string[], expand = false): string {
  const quoted = words.map((word) => shellWord(word, expand)).join(" ");
  return `docker compose exec -T ${service} ${quoted} < /dev/null`;
}

/** `exec`, in a subshell that first loads `envFile` (`set -a` exports its variables) when given. */
function stepExec(service: string, words: readonly string[], envFile?: string): string {
  if (envFile === undefined) return exec(service, words);
  return `(set -a; . ./${envFile}; set +a; ${exec(service, words, true)})`;
}

/** Shown when a setup step fails; names the service only. */
function initFailed(service: string): string {
  return `::error::The one-time setup of the ${service} service failed, so the new version was not started and the previous version keeps serving. The step's output stays on the server in ${INIT_LOG} (it can quote a key, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the cause and push again. The steps already done are skipped.`;
}

/** The one-time setup steps in order, each run only when its check fails; a failure stops here. */
function serviceInit(steps: readonly ServiceInitStep[]): string[] {
  return steps.flatMap(({ service, check, run, envFile }) => {
    const step = [
      `if ! (umask 077; ${stepExec(service, run, envFile)} > ${INIT_LOG} 2>&1); then`,
      `  echo ${shellQuote(initFailed(service))}`,
      "  exit 1",
      "fi",
    ];
    if (check === undefined) return step;
    return [
      `if ! ${stepExec(service, check, envFile)} > /dev/null 2>&1; then`,
      ...step.map((line) => `  ${line}`),
      "fi",
    ];
  });
}

/** The Compose services of the enabled workers, and `cron` when a cron job is enabled. */
function processServices(plan: DeployPlan): string[] {
  return [
    ...plan.processes.workers.filter((worker) => worker.enabled).map((worker) => worker.name),
    ...(hasCronJobs(plan) ? ["cron"] : []),
  ];
}

/** How long every worker and cron container must keep running after the deploy starts it. */
const PROCESS_CHECK_SECONDS = 30;

/** printf's format for a worker that stopped: `%s` is its Compose service, twice. */
const PROCESS_FAILED = `::error::The %s container did not keep running for ${PROCESS_CHECK_SECONDS} seconds after it started with the new version, so the deploy failed and OpsCrew puts the web and the workers back on the previous version. Read its log on the server with \`docker compose logs %s\` in /srv/app (opscrew/RUNBOOK.md has the SSH command), fix its command (processes in opscrew/plan.yaml) or the app, and push again.\\n`;

/**
 * Starts `services` (the workers and cron) on `$APP_IMAGE`; Compose recreates only those whose
 * image or settings changed. Then each container must stay running, with the restart count it
 * started with, for {@link PROCESS_CHECK_SECONDS}; otherwise the script names the first that did
 * not and exits 1.
 */
function startProcesses(services: readonly string[]): string[] {
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
    `    printf ${shellQuote(PROCESS_FAILED)} "$service" "$service"`,
    "    exit 1",
    "  done",
    "done",
  ];
}

/**
 * Switches traffic to a copy of `$APP_IMAGE` (POSIX sh, in /srv/app) and writes it to `.env`.
 * `rolling`: starts a second `app` container next to the running one; kamal-proxy sends it traffic
 * once its health check passes and drains the old one, which is then removed. `recreate`: replaces
 * the container, then hands it to kamal-proxy. The first deploy registers the first target the
 * same way. When the new copy never becomes healthy it is removed, `failed` is printed and the
 * script exits 1.
 */
function switchApp(plan: DeployPlan, failed: string): string[] {
  const { strategy, drainSeconds } = plan.deploy;
  const kamal = [
    'name="$(docker inspect --format \'{{.Name}}\' "$new")"',
    `if ! docker compose exec -T proxy kamal-proxy deploy app --target "\${name#/}:${plan.app.port}" --health-check-path ${shellQuote(healthPath(plan))} --deploy-timeout ${DEPLOY_TIMEOUT_SECONDS}s --drain-timeout ${drainSeconds}s --target-timeout ${TARGET_TIMEOUT_SECONDS}s < /dev/null; then`,
    '  docker rm -f "$new" > /dev/null',
    `  echo ${shellQuote(failed)}`,
    "  exit 1",
    "fi",
  ];
  const writeEnv = "printf 'APP_IMAGE=%s\\n' \"$APP_IMAGE\" > .env";
  if (strategy === "recreate") {
    return [
      writeEnv,
      "docker compose up -d --no-deps app",
      'new="$(docker compose ps -aq app)"',
      ...kamal,
    ];
  }
  return [
    "old=\"$(docker compose ps -aq app | tr '\\n' ' ')\"",
    'docker compose up -d --no-deps --no-recreate --scale "app=$(( $(echo $old | wc -w) + 1 ))" app',
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

/**
 * The server script of the start step (POSIX sh; the image is `$1`, already checked to be a GHCR
 * digest reference), in this order:
 * 1. pull, and start the plan's services, kamal-proxy and Caddy when they are not running
 *    (Compose recreates one only when its own configuration changed; nothing forces it);
 * 2. the services' one-time setup, `init` (the catalog's steps, see {@link ServiceInitStep});
 * 3. the release command in a one-off container of the new image;
 * 4. the switch to the new image by `deploy.strategy` (`recreate` for SQLite apps);
 * 5. the workers and cron on the new image;
 * 6. a check that every worker and cron container keeps running for 30 seconds.
 * A failure before the switch leaves the running version untouched; after it, the workflow's
 * rollback ({@link rollbackCommands}) puts the web and the workers back. The services are never
 * named after the setup. The script reaches `sh` on its stdin, so the commands that read stdin
 * (`docker compose exec` and `run`) get `/dev/null`; otherwise they would swallow the rest of the
 * script.
 */
export function switchCommands(plan: DeployPlan, init: readonly ServiceInitStep[]): string[] {
  const release =
    plan.app.releaseCommand === undefined
      ? []
      : [
          `if ! (umask 077; docker compose run --rm --no-deps -T release < /dev/null > ${RELEASE_LOG} 2>&1); then`,
          `  echo ${shellQuote(RELEASE_FAILED)}`,
          "  exit 1",
          "fi",
          `echo ${shellQuote(RELEASE_DONE)}`,
        ];
  return [
    "set -eu",
    "trap 'docker logout ghcr.io > /dev/null 2>&1' EXIT",
    "cd /srv/app",
    'export APP_IMAGE="$1"',
    "docker compose pull",
    `docker compose up -d --no-deps --wait --remove-orphans ${steadyServices(plan).join(" ")}`,
    ...serviceInit(init),
    ...release,
    ...switchApp(plan, healthFailed(plan)),
    ...startProcesses(processServices(plan)),
  ];
}

/**
 * The server script of the rollback (POSIX sh; the failed image is `$1`): when `.env` names it and
 * `.env.previous` holds another image, switches the web back to that one the same way as the
 * deploy, starts the workers and cron on it too, and prints `restored`; prints `unchanged` when
 * this run never switched, `no-previous` when there is nothing to go back to, and nothing when the
 * switch back failed.
 */
export function rollbackCommands(plan: DeployPlan): string[] {
  const processes = processServices(plan);
  return [
    "set -eu",
    "cd /srv/app",
    'if ! grep -qxF "APP_IMAGE=$1" .env 2> /dev/null; then echo unchanged; exit 0; fi',
    "if [ ! -f .env.previous ] || cmp -s .env .env.previous; then echo no-previous; exit 0; fi",
    "APP_IMAGE=\"$(sed -n 's/^APP_IMAGE=//p' .env.previous)\"",
    "export APP_IMAGE",
    "{",
    ...[
      ...switchApp(plan, "::error::The previous version did not pass its health check either."),
      ...(processes.length === 0 ? [] : [`docker compose up -d --no-deps ${processes.join(" ")}`]),
    ].map((line) => `  ${line}`),
    "} >&2",
    "rm -f .env.previous",
    "echo restored",
  ];
}
