// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { posix } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { appRoot } from "../app-root";
import { ACTIONS, type PinArch } from "../pins";

/** Shell pattern for a GHCR image pinned by digest, `ghcr.io/<owner>/<repo>@sha256:<hex>`. */
export const DIGEST_REF_PATTERN = "^ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$";

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

/** The CPU architecture the image is built for: the server's. */
export function buildArch(plan: DeployPlan): PinArch {
  const { target } = plan;
  return (target.provider === "own" || target.provider === "portainer") && target.arch === "arm64"
    ? "arm64"
    : "amd64";
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
      `storage.sqlite.dir in opscrew/plan.yaml is the app's own folder (${root}), so the SQLite volume would hide the app's code from its image.`,
      { hint: ownFolder },
    );
  }
  if (!SQLITE_FOLDER.test(folder)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The SQLite folder ${folder} (storage.sqlite.dir in opscrew/plan.yaml) has a character OpsCrew cannot use there: only letters, digits, ".", "_", "-" and "/" work.`,
      {
        hint: "Rename the database's folder (for example to data/), change the app's database path to it, then run `opscrew analyze` and `opscrew design` again.",
      },
    );
  }
  return folder;
}

/**
 * GitHub-hosted runner that builds the image: arm64 servers (and arm64 Portainer environments) get
 * an arm64 runner (no emulation).
 */
export function buildRunner(plan: DeployPlan): string {
  return buildArch(plan) === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-latest";
}

/** The plan's health path with a leading `/`. */
export function healthPath(plan: DeployPlan): string {
  const path = plan.app.healthPath;
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The name of the GitHub Actions secret that holds `name` (one of {@link DEPLOY_SECRETS}' names,
 * {@link serviceEnvSecret}'s, or the tunnel's and Portainer's) for the plan's environment: today's
 * name for prod, and `OPSCREW_<ENV>_…` (`OPSCREW_STAGING_HOST`) for any other environment, also
 * inside its GitHub environment. GitHub falls back from an environment secret to a repository
 * secret of the same name, so a missing staging secret never resolves to prod's.
 */
export function deploySecretName(plan: DeployPlan, name: string): string {
  const environment = plan.environment?.name;
  if (environment === undefined) return name;
  const prefix = environment.toUpperCase().replaceAll("-", "_");
  return `OPSCREW_${prefix}_${name.replace(/^OPSCREW_/, "")}`;
}

/** `${{ secrets.<name> }}` for the plan's environment ({@link deploySecretName}). */
export function secret(plan: DeployPlan, name: string): string {
  return `\${{ secrets.${deploySecretName(plan, name)} }}`;
}

/** The plan's environment name: `prod` for the plan without one. */
export function environmentName(plan: DeployPlan): string {
  return plan.environment?.name ?? "prod";
}

/** True when the environment is deployed only by `opscrew promote`, from a digest. */
export function promoted(plan: DeployPlan): boolean {
  return plan.environment?.deploySource.from === "promote";
}

/**
 * The job whose outputs `image` (`<name>@<digest>`) and `tag` (`<name>:<commit>`) the deploy
 * takes: `verify` for a promoted environment, else `build`.
 */
export function imageJob(plan: DeployPlan): "build" | "verify" {
  return promoted(plan) ? "verify" : "build";
}

/** `${{ needs.<imageJob>.outputs.<output> }}`. */
export function imageOutput(plan: DeployPlan, output: "image" | "tag"): string {
  return `\${{ needs.${imageJob(plan)}.outputs.${output} }}`;
}

/**
 * The GitHub environment the deploy job runs in: the environment's own name (prod's is
 * `production`) when its secrets live there, and prod's `production` too before provision has
 * checked what the repository supports (as before environments); none with prefixed secrets.
 */
export function githubEnvironment(plan: DeployPlan): string | undefined {
  const environment = plan.environment;
  if (environment?.secrets === "prefixed") return undefined;
  if (environment?.name === undefined) return "production";
  return environment.secrets === "environment" ? environment.name : undefined;
}

/** The label of the environment's self-hosted runner, `opscrew-<app>-<env>`. */
export function runnerLabel(plan: DeployPlan): string {
  // A named environment's app name is already `<app>-<env>`.
  return `opscrew-${plan.app.name}${plan.environment?.name === undefined ? "-prod" : ""}`;
}

/**
 * True when the deploy job runs on the environment's self-hosted runner (`environment.runner`
 * `server` or `local`), on the machine it deploys to.
 */
export function selfHosted(plan: DeployPlan): boolean {
  return (plan.environment?.runner ?? "github") !== "github";
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
 * its image comes from. The renderer goes on with what it does with the image.
 */
export function promotedAbout(plan: DeployPlan): string[] {
  const source = plan.environment?.deploySource;
  return [
    `# \`opscrew promote --to ${environmentName(plan)}\` starts this workflow with the digest of an image the ${source?.from === "promote" ? source.source : ""}`,
    "# environment runs. It checks that this repository's default branch built that image, then",
  ];
}

/** A promoted environment's trigger: `opscrew promote` dispatches the workflow with the digest. */
const DISPATCH_WITH_DIGEST = [
  "  workflow_dispatch:",
  "    inputs:",
  "      digest:",
  "        description: The image to deploy, by its digest (sha256:…); `opscrew promote` fills it in.",
  "        required: true",
  "        type: string",
];

/**
 * The workflow's header comment (`about`), triggers, default permissions and concurrency. An
 * environment that follows the branch deploys on each push to it (and by hand); a promoted one only
 * through a dispatch with the image's digest. Each environment's runs queue in a group of their own
 * (prod's `opscrew-deploy`, any other's `opscrew-deploy-<app>-<env>`), so one environment never
 * deploys twice at once and no run is cancelled.
 */
export function workflowStart(plan: DeployPlan, about: readonly string[]): string[] {
  const name = plan.environment?.name;
  const file = name === undefined ? "opscrew/plan.yaml" : `opscrew/environments/${name}/plan.yaml`;
  return [
    `# Generated by OpsCrew from ${file}; \`opscrew provision\` regenerates it.`,
    ...about,
    `name: OpsCrew deploy${name === undefined ? "" : ` (${name})`}`,
    "",
    "on:",
    ...(promoted(plan)
      ? DISPATCH_WITH_DIGEST
      : [
          "  push:",
          `    branches: [${JSON.stringify(plan.cicd.branch)}]`,
          "  workflow_dispatch: {}",
        ]),
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    `  group: opscrew-deploy${name === undefined ? "" : `-${plan.app.name}`}`,
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
 * `server` or `local` on the environment's self-hosted runner ({@link runnerLabel}), every step
 * with bash (Git for Windows' on a Windows computer). Its output `previous` is the image that ran
 * before this deploy (empty on the first one), which the image retention job never deletes and the
 * label job labels `opscrew-<env>-previous`.
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
