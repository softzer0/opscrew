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
 * `opscrew provision` for the plan's app and environment: `--app <key>` for a further app
 * ({@link appFlag}), then `--env <env>` for an environment other than prod.
 */
export function provisionCommand(plan: DeployPlan): string {
  const name = plan.environment?.name;
  return `opscrew provision${appFlag(plan)}${name === undefined ? "" : ` --env ${name}`}`;
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
 * The job whose outputs `image` (`<name>@<digest>`) and `tag` (`<name>:<commit tag>`, see
 * {@link environmentTag}) the deploy takes: `verify` for a promoted environment, else `build`.
 */
export function imageJob(plan: DeployPlan): "build" | "verify" {
  return promoted(plan) ? "verify" : "build";
}

/** `${{ needs.<imageJob>.outputs.<output> }}`. */
export function imageOutput(plan: DeployPlan, output: "image" | "tag"): string {
  return `\${{ needs.${imageJob(plan)}.outputs.${output} }}`;
}

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

/** Stops a step whose `$IMAGE` is not a GHCR digest reference. */
export const CHECK_IMAGE = [
  `if [[ ! "$IMAGE" =~ ${DIGEST_REF_PATTERN} ]]; then`,
  '  echo "::error::The build job did not report the image digest; re-run the workflow."',
  "  exit 1",
  "fi",
];

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
 * A promoted environment's trigger: `opscrew promote` dispatches the workflow with the digest and
 * the image's commit tag ({@link environmentTag} of the environment that built it, which may be the
 * source's own source).
 */
const DISPATCH_WITH_DIGEST = [
  "  workflow_dispatch:",
  "    inputs:",
  "      digest:",
  "        description: The image to deploy, by its digest (sha256:…); `opscrew promote` fills it in.",
  "        required: true",
  "        type: string",
  "      tag:",
  "        description: The image's commit tag (<commit>, or <commit>-<env> when another environment than prod built it); `opscrew promote` fills it in.",
  "        required: true",
  "        type: string",
];

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
 * through a dispatch with `dispatch`'s inputs (by default the image's digest and commit tag). Each
 * environment's runs queue in a group of their own (the first app's prod's `opscrew-deploy`, any
 * other's `opscrew-deploy-<app name>`, which is unique in the repository), so one environment never
 * deploys twice at once. A running deploy is never cancelled; of the runs waiting behind it, GitHub
 * keeps only the newest.
 */
export function workflowStart(
  plan: DeployPlan,
  about: readonly string[],
  paths: readonly string[],
  dispatch: readonly string[] = DISPATCH_WITH_DIGEST,
): string[] {
  const first = plan.app.key === undefined && plan.environment?.name === undefined;
  return [
    `# Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    ...about,
    `name: ${workflowName(plan)}`,
    "",
    "on:",
    ...(promoted(plan)
      ? dispatch
      : [
          "  push:",
          `    branches: [${JSON.stringify(plan.cicd.branch)}]`,
          "    # A push starts it only when it changes one of these paths, which the run reads.",
          "    paths:",
          ...paths.map((path) => `      - ${JSON.stringify(path)}`),
          "  workflow_dispatch: {}",
        ]),
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
  needs?: string | readonly string[];
  /** `contents: read`, …; nothing else is granted. */
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
    typeof j.needs === "string" || j.needs === undefined ? j.needs : `[${j.needs.join(", ")}]`;
  return [
    `  ${j.id}:`,
    `    name: ${j.name}`,
    ...(needs === undefined ? [] : [`    needs: ${needs}`]),
    `    runs-on: ${j.runsOn ?? "ubuntu-latest"}`,
    ...(j.environment === undefined ? [] : [`    environment: ${j.environment}`]),
    ...(j.shell === undefined ? [] : ["    defaults:", "      run:", `        shell: ${j.shell}`]),
    "    permissions:",
    ...block(j.permissions, 6),
    ...(j.outputs === undefined ? [] : ["    outputs:", ...block(j.outputs, 6)]),
    "    steps:",
    ...block(j.steps, 6),
  ];
}

/**
 * The `deploy` job (`name` shown in GitHub): after the job that gives it the image
 * ({@link imageJob}), in the {@link githubEnvironment}, with the token's `permissions`
 * (`contents: read`, …) and the `steps`. It runs on `ubuntu-latest`, or with `environment.runner`
 * `server`, `local` or `host` on the environment's self-hosted runner ({@link runnerLabel}), every
 * step with bash (Git for Windows' on a Windows computer). Its output `previous` is the image that
 * ran before this deploy (empty on the first one), which the image retention job never deletes and
 * the label job labels `opscrew-<env>-previous`.
 */
export function deployJob(
  plan: DeployPlan,
  name: string,
  permissions: readonly string[],
  previous: string,
  steps: readonly string[],
): string[] {
  const own = selfHosted(plan);
  return job({
    id: "deploy",
    name,
    needs: imageJob(plan),
    environment: githubEnvironment(plan),
    runsOn: own ? `[self-hosted, ${runnerLabel(plan)}]` : undefined,
    shell: own ? "bash" : undefined,
    permissions,
    outputs: [`previous: ${previous}`],
    steps,
  });
}
