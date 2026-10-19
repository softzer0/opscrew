import type { DeployPlan, ImageBuilder } from "@opscrew/plan-schema";
import { healthPath } from "./shared";

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

/** The services a deploy starts when they are not running, and never restarts otherwise. */
function steadyServices(plan: DeployPlan): string[] {
  return [
    ...(plan.services.postgres ? ["db"] : []),
    ...(plan.services.redis ? ["cache"] : []),
    "proxy",
    "caddy",
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
 * digest reference): pull, start the database, cache and proxy when they are not running, run the
 * release command in a one-off container of the new image, then switch to the new image by
 * `deploy.strategy`. A failure before the switch leaves the running version untouched; the
 * database, cache and proxy are never named after the release command. The script reaches `sh` on
 * its stdin, so the commands that read stdin (`docker compose exec` and `run`) get `/dev/null`;
 * otherwise they would swallow the rest of the script.
 */
export function switchCommands(plan: DeployPlan): string[] {
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
    ...release,
    ...switchApp(plan, healthFailed(plan)),
  ];
}

/**
 * The server script of the rollback (POSIX sh; the failed image is `$1`): when `.env` names it and
 * `.env.previous` holds another image, switches back to that one the same way as the deploy and
 * prints `restored`; prints `unchanged` when this run never switched, `no-previous` when there is
 * nothing to go back to, and nothing when the switch back failed.
 */
export function rollbackCommands(plan: DeployPlan): string[] {
  return [
    "set -eu",
    "cd /srv/app",
    'if ! grep -qxF "APP_IMAGE=$1" .env 2> /dev/null; then echo unchanged; exit 0; fi',
    "if [ ! -f .env.previous ] || cmp -s .env .env.previous; then echo no-previous; exit 0; fi",
    "APP_IMAGE=\"$(sed -n 's/^APP_IMAGE=//p' .env.previous)\"",
    "export APP_IMAGE",
    "{",
    ...switchApp(plan, "::error::The previous version did not pass its health check either.").map(
      (line) => `  ${line}`,
    ),
    "} >&2",
    "rm -f .env.previous",
    "echo restored",
  ];
}
