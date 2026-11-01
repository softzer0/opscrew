// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { posix } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  deploySecretPrefix,
  githubEnvironmentFor,
  targetArch,
} from "@opscrew/plan-schema";
import { appRoot } from "../app-root";
import { ACTIONS, type PinArch } from "../pins";
import { type AppEnvironment, artefactsFolder } from "../runtime-dir";
import type { RenderContext } from "../types";

/**
 * Shell pattern for a GHCR image pinned by digest, `ghcr.io/<owner>/<repo>[/<key>]@sha256:<hex>`.
 */
export const DIGEST_REF_PATTERN = "^ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$";

/**
 * What a workflow appends to `ghcr.io/<owner>/<repo>`, which it lower-cases in shell
 * (`${GITHUB_REPOSITORY,,}`), for the app's image as plan-schema's `ghcrImageFor` names it:
 * `/<key>` for a further app (a key is lower case), nothing for the repository's first app.
 */
export function imageSubpath(plan: Pick<AppEnvironment, "app">): string {
  return plan.app.key === undefined ? "" : `/${plan.app.key}`;
}

/** Names of the GitHub Actions secrets the workflow reads. `opscrew provision` sets them. */
export const DEPLOY_SECRETS = {
  host: "OPSCREW_HOST",
  sshKey: "OPSCREW_SSH_PRIVATE_KEY",
  knownHosts: "OPSCREW_SSH_KNOWN_HOSTS",
  appEnv: "OPSCREW_APP_ENV",
  /** `db.env`, the env file of the Postgres service `db`: {@link serviceEnvSecret}`("db")`. */
  dbEnv: "OPSCREW_SERVICE_DB_ENV",
  /** Non-secret build values (`NAME=value` lines): build arguments, baked into the image. */
  buildEnv: "OPSCREW_BUILD_ENV",
  /** Secret build values (`NAME=value` lines): BuildKit secret mounts only, never build arguments. */
  buildSecrets: "OPSCREW_BUILD_SECRETS",
  /**
   * With origin TLS: the app's Cloudflare origin certificate (PEM), then its private key (PEM),
   * which the deploy writes to `/srv/edge/tls/<app>/origin.pem` and `origin.key`.
   */
  originTls: "OPSCREW_ORIGIN_TLS",
} as const;

/**
 * The GitHub Actions secret that holds `<service>.env`, the env file a catalog service with
 * secrets reads on a server (`OPSCREW_SERVICE_MAIN_DB_ENV` for `main-db`). `opscrew provision`
 * sets it; the deploy writes it next to compose.yaml.
 */
export function serviceEnvSecret(service: string): string {
  return `OPSCREW_SERVICE_${service.toUpperCase().replaceAll("-", "_")}_ENV`;
}

/** The CPU architecture the image is built for: the target's ({@link targetArch}). */
export function buildArch(plan: DeployPlan): PinArch {
  return targetArch(plan.target);
}

/** True when the plan has an enabled cron job, which the `cron` service runs with supercronic. */
export function hasCronJobs(plan: DeployPlan): boolean {
  return plan.processes.cron.some((job) => job.enabled);
}

/**
 * The architecture the image gets supercronic for: the image's, when the plan has an enabled cron
 * job; otherwise undefined. The seal and the generated Dockerfile's runtime stage add it.
 */
export function supercronicArch(plan: DeployPlan): PinArch | undefined {
  return hasCronJobs(plan) ? buildArch(plan) : undefined;
}

/** The characters a SQLite folder's path may have. */
const SQLITE_FOLDER = /^\/[A-Za-z0-9._/-]+$/;

/**
 * The SQLite database's folder in the app's image, `appRoot(plan)/<storage.sqlite.dir>`, which the
 * volume `sqlite` keeps; undefined without `storage.sqlite`.
 * @throws OpsCrewError `INVALID_INPUT` when OpsCrew does not know the folder the app runs in (the
 * user's own Dockerfile without a `WORKDIR` detection could read), when the folder is the app's
 * own (the volume would hide its code), or when its path has a character other than
 * {@link SQLITE_FOLDER}'s, which the seal's `RUN`, its `printf` and Compose's short mount syntax
 * cannot hold.
 */
export function sqliteFolder(plan: DeployPlan): string | undefined {
  const dir = plan.storage?.sqlite?.dir;
  if (dir === undefined) return undefined;
  const root = appRoot(plan);
  if (root === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app keeps its SQLite database in ${dir}/ on a persistent volume, but OpsCrew does not know the folder the app runs in: the last stage of your Dockerfile (${plan.app.dockerfile}) has no WORKDIR with an absolute path.`,
      {
        hint: `Add a WORKDIR with an absolute path to the last stage of ${plan.app.dockerfile} (for example WORKDIR /app), then run \`opscrew analyze\` and \`opscrew design\` again.`,
      },
    );
  }
  const folder = posix.join(root, dir).replace(/\/$/, "");
  const ownFolder =
    "Move the database into a folder of its own, for example data/ (data/app.sqlite3), change the app's database path to it, then run `opscrew analyze` and `opscrew design` again.";
  if (folder === root) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `storage.sqlite.dir in ${planFilePath(plan)} is the app's own folder (${root}), so the SQLite volume would hide the app's code from its image.`,
      { hint: ownFolder },
    );
  }
  if (!SQLITE_FOLDER.test(folder)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The SQLite folder ${folder} (storage.sqlite.dir in ${planFilePath(plan)}) has a character OpsCrew cannot use there: only letters, digits, ".", "_", "-" and "/" work.`,
      {
        hint: "Rename the database's folder (for example to data/), change the app's database path to it, then run `opscrew analyze` and `opscrew design` again.",
      },
    );
  }
  return folder;
}

/**
 * The `runs-on` of the job that builds the image: with `environment.build` `runner`, the
 * environment's self-hosted runner ({@link runnerLabel}), whose architecture is the target's;
 * otherwise a GitHub-hosted runner, an arm64 one for arm64 servers (and arm64 Portainer
 * environments), with no emulation.
 */
export function buildRunner(plan: DeployPlan): string {
  if (buildsOnRunner(plan)) return `[self-hosted, ${runnerLabel(plan)}]`;
  return buildArch(plan) === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-latest";
}

/** True when the image is built on the environment's own runner (`environment.build` `runner`). */
export function buildsOnRunner(plan: DeployPlan): boolean {
  return plan.environment?.build === "runner";
}

/** The plan's health path with a leading `/`. */
export function healthPath(plan: DeployPlan): string {
  const path = plan.app.healthPath;
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The name of the GitHub Actions secret that holds `name` (one of {@link DEPLOY_SECRETS}' names,
 * {@link serviceEnvSecret}'s, or the tunnel's and Portainer's, each `OPSCREW_…`) for the plan's app
 * and environment: `name` after the app's environment's prefix ({@link deploySecretPrefix}) in
 * place of `OPSCREW_`. That is today's name for the first app's prod, `OPSCREW_<ENV>_…`
 * (`OPSCREW_STAGING_HOST`) for its other environments, also inside their GitHub environments, and
 * `OPSCREW_<KEY>_…` and `OPSCREW_<KEY>_<ENV>_…` for a further app. GitHub falls back from an
 * environment secret to a repository secret of the same name, so a missing staging secret never
 * resolves to prod's.
 */
export function deploySecretName(plan: DeployPlan, name: string): string {
  const prefix = deploySecretPrefix(plan.app.key, plan.environment?.name);
  return `${prefix}${name.replace(/^OPSCREW_/, "")}`;
}

/** `${{ secrets.<name> }}` for the plan's environment ({@link deploySecretName}). */
export function secret(plan: DeployPlan, name: string): string {
  return `\${{ secrets.${deploySecretName(plan, name)} }}`;
}

/** The plan's environment name: `prod` for the plan without one. */
export function environmentName(plan: Pick<AppEnvironment, "environment">): string {
  return plan.environment?.name ?? "prod";
}

/**
 * The form of the image tag `tag` that `environment`'s build pushes: `tag` itself for prod,
 * `<tag>-<env>` for any other environment. Two environments that follow the same branch build each
 * commit separately, at the same time, and a shared tag would move to the later build. So each
 * environment has its own commit tag (`<commit>`, `tag` a commit or the shell or GitHub Actions
 * expression of one), seal intermediate (`build-<commit>`) and Buildpacks cache (`buildcache`).
 */
export function environmentTag(tag: string, environment: string): string {
  return environment === "prod" ? tag : `${tag}-${environment}`;
}

/**
 * ` --app <key>` for a further app, which every command that acts on one of its environments names
 * as it names `--env`; nothing for the repository's first app.
 */
export function appFlag(plan: Pick<AppEnvironment, "app">): string {
  return plan.app.key === undefined ? "" : ` --app ${plan.app.key}`;
}

/**
 * The environment a command names with `--env`: its own outside prod, and `prod` for prod when the
 * app has other `environments`; none for a prod-only app.
 */
export function commandEnvironment(
  plan: DeployPlan,
  environments: readonly string[] | undefined,
): string | undefined {
  return plan.environment?.name ?? ((environments?.length ?? 0) > 1 ? "prod" : undefined);
}

/**
 * `opscrew <command>` for the plan's app and environment: a further app's `--app <key>`
 * ({@link appFlag}), then `--env <name>` outside prod, and `--env prod` for prod when the app has
 * other `environments` (a bare command then asks which one, or stops in scripts), so every command
 * acts on that environment only.
 */
export function opscrew(
  plan: DeployPlan,
  command: string,
  environments?: readonly string[],
): string {
  const env = commandEnvironment(plan, environments);
  return `opscrew ${command}${appFlag(plan)}${env === undefined ? "" : ` --env ${env}`}`;
}

/** `opscrew provision` for the plan's app and environment ({@link opscrew}). */
export function provisionCommand(plan: DeployPlan): string {
  return opscrew(plan, "provision");
}

/**
 * `opscrew runner start --env <env>` for the plan's environment, prod's included, with a further
 * app's {@link appFlag}.
 */
export function runnerStartCommand(plan: AppEnvironment): string {
  return `opscrew runner start${appFlag(plan)} --env ${environmentName(plan)}`;
}

/** `opscrew promote --to <env>` for the plan's environment, with a further app's {@link appFlag}. */
export function promoteCommand(plan: AppEnvironment): string {
  return `opscrew promote${appFlag(plan)} --to ${environmentName(plan)}`;
}

/** True when the environment is deployed only by `opscrew promote`, from a digest. */
export function promoted(plan: DeployPlan): boolean {
  return plan.environment?.deploySource.from === "promote";
}

/**
 * The branch whose pushes build the images of the promoted environment `plan`
 * (`ctx.builderBranch`).
 * @throws OpsCrewError `INTERNAL` when the render was given none.
 */
export function builderBranchOf(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch">,
): string {
  if (ctx.builderBranch !== undefined) return ctx.builderBranch;
  throw new OpsCrewError(
    "INTERNAL",
    `OpsCrew rendered the files of the ${environmentName(plan)} environment, which is promoted, without the branch that builds its images.`,
    { hint: "This is a bug in OpsCrew; please report it." },
  );
}

/**
 * The jobs whose outputs `image` (`<name>@<digest>`) and `tag` (`<name>:<commit tag>`, see
 * {@link environmentTag}) the deploy takes, one of which runs: for an environment that follows a
 * branch, `build` (a push, or a run started by hand) or `verify` (a rollback dispatch); for a
 * promoted environment, `verify`.
 */
export function imageJobs(plan: DeployPlan): readonly ("build" | "verify")[] {
  return promoted(plan) ? ["verify"] : ["build", "verify"];
}

/** `${{ needs.<job>.outputs.<output> || … }}` over {@link imageJobs}: a skipped job's is empty. */
export function imageOutput(plan: DeployPlan, output: "image" | "tag"): string {
  return `\${{ ${imageJobs(plan)
    .map((id) => `needs.${id}.outputs.${output}`)
    .join(" || ")} }}`;
}

/** The deploy workflow's `workflow_dispatch` inputs of a rollback, which `opscrew rollback` gives. */
export const ROLLBACK_INPUTS = { digest: "digest", tag: "tag", rollback: "rollback" } as const;

/**
 * True in a rollback dispatch (an expression). A dispatch makes the input a boolean, and a push
 * has `inputs` `{}` (research R6, S3), so it is never compared with `'true'`.
 */
export const ROLLING_BACK = `inputs.${ROLLBACK_INPUTS.rollback}`;

/** A step's `MODE`: `rollback` in a rollback dispatch, otherwise `deploy`. */
export const MODE_ENV = `    MODE: \${{ ${ROLLING_BACK} && 'rollback' || 'deploy' }}`;

/**
 * The GitHub environment the deploy job runs in, the app's environment's own
 * ({@link githubEnvironmentFor}: `production` for the first app's prod, `<env>`, `<key>-production`
 * or `<key>-<env>`): when its secrets live there, and for prod also before provision has checked
 * what the repository supports; none with prefixed secrets.
 */
export function githubEnvironment(plan: DeployPlan): string | undefined {
  const environment = plan.environment;
  if (environment?.secrets === "prefixed") return undefined;
  if (environment?.name !== undefined && environment.secrets !== "environment") return undefined;
  return githubEnvironmentFor(plan.app.key, environment?.name);
}

/** The label of the environment's self-hosted runner, `opscrew-<app>-<env>`. */
export function runnerLabel(plan: DeployPlan): string {
  // A named environment's app name is already `<app>-<env>`.
  return `opscrew-${plan.app.name}${plan.environment?.name === undefined ? "-prod" : ""}`;
}

/**
 * True when the deploy job runs on the environment's self-hosted runner (`environment.runner`
 * `server`, `local` or `host`) rather than on GitHub's machines.
 */
export function selfHosted(plan: DeployPlan): boolean {
  return (plan.environment?.runner ?? "github") !== "github";
}

/**
 * True when the deploy job runs on the machine it deploys to: the server's runner or the local
 * runner (`environment.runner` `server` or `local`). A runner machine (`host`) deploys over SSH,
 * as GitHub's machines do.
 */
export function deploysInPlace(plan: DeployPlan): boolean {
  const runner = plan.environment?.runner;
  return runner === "server" || runner === "local";
}

/**
 * True when the deploy job runs on a runner machine (`environment.runner` `host`). It runs other
 * environments' jobs as the same user and keeps its home folder, so the job keeps its SSH files
 * and Docker settings in its own temp folder (`$RUNNER_TEMP`, which the runner empties after each
 * job), and its user has no sudo.
 */
export function onRunnerMachine(plan: DeployPlan): boolean {
  return plan.environment?.runner === "host";
}

/**
 * Bash lines that stop the step with `message` as the run's error when `condition` (a bash
 * condition, such as `[[ … ]]` or `! command`) holds. `message` goes between double quotes.
 */
export function refuse(condition: string, message: string): string[] {
  return [`if ${condition}; then`, `  echo "::error::${message}"`, "  exit 1", "fi"];
}

/** Stops a step whose `$IMAGE` is not a GHCR digest reference. */
export const CHECK_IMAGE = refuse(
  `[[ ! "$IMAGE" =~ ${DIGEST_REF_PATTERN} ]]`,
  "The build job did not report the image digest; re-run the workflow.",
);

export function block(lines: readonly string[], indent: number): string[] {
  const pad = " ".repeat(indent);
  return lines.map((line) => (line.length > 0 ? `${pad}${line}` : ""));
}

/** Indents `script` as the body of a step's `run: |`. */
export function run(script: readonly string[]): string[] {
  return ["  run: |", ...block(script, 4)];
}

/** The step that logs in to GitHub Container Registry with the job's token. */
/**
 * Script lines that give the job's later steps the daemon of the current Docker context
 * (`DOCKER_HOST` through `$GITHUB_ENV`), so docker reaches Docker Desktop's on macOS also with
 * other Docker settings than the user's or without its default socket. Harmless on Linux and
 * Windows, where the context names the usual daemon.
 */
export const DOCKER_CONTEXT_HOST = [
  "docker_host=\"$(docker context inspect --format '{{.Endpoints.docker.Host}}')\"",
  'echo "DOCKER_HOST=$docker_host" >> "$GITHUB_ENV"',
];

export const GHCR_LOGIN = [
  "- name: Log in to GitHub Container Registry",
  `  uses: ${ACTIONS.login}`,
  "  with:",
  "    registry: ghcr.io",
  "    username: ${{ github.actor }}",
  "    password: ${{ secrets.GITHUB_TOKEN }}",
];

/**
 * The first lines of a promoted environment's header comment: what starts the workflow and where
 * its image comes from ({@link builderBranchOf}). The renderer goes on with what it does with the
 * image.
 */
export function promotedAbout(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "builderBranch">,
): string[] {
  const source = plan.environment?.deploySource;
  return [
    `# \`${promoteCommand(plan)}\` starts this workflow with the digest of an image the ${source?.from === "promote" ? source.source : ""}`,
    `# environment runs. It checks that a push to ${builderBranchOf(plan, ctx)} in this repository built that image, then`,
  ];
}

/**
 * The `workflow_dispatch` trigger of a server or Portainer environment, with a digest, the image's
 * commit tag and `rollback` ({@link ROLLBACK_INPUTS}). For a promoted environment (`promotion`),
 * `opscrew promote` and `opscrew rollback` dispatch it with the digest and the commit tag
 * ({@link environmentTag} of the environment that built the image, which may be the source's own
 * source), required. For one that follows a branch they are optional: without inputs it builds and
 * deploys the branch, and `opscrew rollback` gives it an earlier image's, which it deploys without
 * a build. A rollback sets `rollback`.
 */
function imageDispatch(promotion: boolean): string[] {
  const fills = promotion
    ? "`opscrew promote` or `opscrew rollback` fills it in."
    : "`opscrew rollback` fills it in.";
  const input = (name: string, description: string) => [
    `      ${name}:`,
    `        description: ${description} ${fills}`,
    `        required: ${promotion}`,
    "        type: string",
    ...(promotion ? [] : ['        default: ""']),
  ];
  return [
    "  workflow_dispatch:",
    "    inputs:",
    ...input(
      ROLLBACK_INPUTS.digest,
      `${promotion ? "The image" : "For a rollback, the image"} to deploy, by its digest (sha256:…);`,
    ),
    ...input(
      ROLLBACK_INPUTS.tag,
      promotion
        ? "The image's commit tag (<commit>, or <commit>-<env> when another environment than prod built it);"
        : "For a rollback, the image's commit tag (<commit>, or <commit>-<env> outside prod);",
    ),
    `      ${ROLLBACK_INPUTS.rollback}:`,
    "        description: Deploy the image without running the release command, for a rollback; `opscrew rollback` sets it.",
    "        required: false",
    "        type: boolean",
    "        default: false",
  ];
}

/** The trigger by hand with no inputs, of a site that follows its branch. */
export const DISPATCH_BY_HAND = ["  workflow_dispatch: {}"];

/**
 * The deploy workflow's name in GitHub → Actions: `OpsCrew deploy`, then a further app's key, then
 * `(<env>)` outside prod (`OpsCrew deploy`, `OpsCrew deploy (staging)`, `OpsCrew deploy docs`,
 * `OpsCrew deploy docs (staging)`).
 */
export function workflowName(plan: AppEnvironment): string {
  const key = plan.app.key;
  const env = plan.environment?.name;
  return `OpsCrew deploy${key === undefined ? "" : ` ${key}`}${env === undefined ? "" : ` (${env})`}`;
}

/**
 * The plan of the app's environment `environment` (the plan's own unless given) in the
 * repository: `plan.yaml` in its {@link artefactsFolder} (`opscrew/plan.yaml` for the first app's
 * prod).
 */
export function planFilePath(plan: AppEnvironment, environment?: string): string {
  return `${artefactsFolder(plan, environment)}/plan.yaml`;
}

/**
 * The runbook of the plan's app's environment in the repository: `RUNBOOK.md` in its
 * {@link artefactsFolder} (`opscrew/RUNBOOK.md` for the first app's prod).
 */
export function runbookFilePath(plan: AppEnvironment): string {
  return `${artefactsFolder(plan)}/RUNBOOK.md`;
}

/**
 * The workflow's header comment (`about`), triggers, default permissions and concurrency. An
 * environment that follows the branch deploys on each push to it that changes one of `paths`
 * (the filter `pushPaths` makes from what the run reads), and by hand; a promoted one only
 * through a dispatch. `dispatch` is the `workflow_dispatch` trigger: by default a server's or
 * Portainer's, which takes an image's digest and commit tag, for a promotion or a rollback
 * ({@link imageDispatch}). Each
 * environment's runs queue in a group of their own (the first app's prod's `opscrew-deploy`, any
 * other's `opscrew-deploy-<app name>`, which is unique in the repository), so one environment never
 * deploys twice at once. A running deploy is never cancelled; of the runs waiting behind it, GitHub
 * keeps only the newest.
 */
export function workflowStart(
  plan: DeployPlan,
  about: readonly string[],
  paths: readonly string[],
  dispatch: readonly string[] = imageDispatch(promoted(plan)),
): string[] {
  const first = plan.app.key === undefined && plan.environment?.name === undefined;
  return [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    ...about,
    `name: ${workflowName(plan)}`,
    "",
    "on:",
    ...(promoted(plan)
      ? []
      : [
          "  push:",
          `    branches: [${JSON.stringify(plan.cicd.branch)}]`,
          "    # A push starts it only when it changes one of these paths, which the run reads.",
          "    paths:",
          ...paths.map((path) => `      - ${JSON.stringify(path)}`),
        ]),
    ...dispatch,
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    `  group: opscrew-deploy${first ? "" : `-${plan.app.name}`}`,
    "  cancel-in-progress: false",
    "",
    "jobs:",
  ];
}

/** A job of the workflow: its id, the jobs it needs, the token's permissions and its steps. */
export interface Job {
  id: string;
  name: string;
  /** One job's id, or a list (a list of one is rendered as its id). */
  needs?: string | readonly string[];
  /** The job's condition (`if:`); it always runs when absent. */
  if?: string;
  /** `contents: read`, …; nothing else is granted, and none is `permissions: {}`. */
  permissions: readonly string[];
  /** `name: ${{ … }}` lines. */
  outputs?: readonly string[];
  environment?: string;
  runsOn?: string;
  /** The shell of every `run:` step (`defaults.run.shell`); GitHub's default when absent. */
  shell?: string;
  steps: readonly string[];
}

/** Renders `job` as YAML lines under `jobs:`. */
export function job(j: Job): string[] {
  const needs =
    typeof j.needs === "string" || j.needs === undefined
      ? j.needs
      : j.needs.length === 1
        ? j.needs[0]
        : `[${j.needs.join(", ")}]`;
  return [
    `  ${j.id}:`,
    `    name: ${j.name}`,
    ...(needs === undefined ? [] : [`    needs: ${needs}`]),
    ...(j.if === undefined ? [] : [`    if: ${j.if}`]),
    `    runs-on: ${j.runsOn ?? "ubuntu-latest"}`,
    ...(j.environment === undefined ? [] : [`    environment: ${j.environment}`]),
    ...(j.shell === undefined ? [] : ["    defaults:", "      run:", `        shell: ${j.shell}`]),
    ...(j.permissions.length === 0
      ? ["    permissions: {}"]
      : ["    permissions:", ...block(j.permissions, 6)]),
    ...(j.outputs === undefined ? [] : ["    outputs:", ...block(j.outputs, 6)]),
    "    steps:",
    ...block(j.steps, 6),
  ];
}
