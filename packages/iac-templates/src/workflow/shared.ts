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

export function secret(name: string): string {
  return `\${{ secrets.${name} }}`;
}

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

/** The workflow's header comment (`about`), triggers, default permissions and concurrency. */
export function workflowStart(plan: DeployPlan, about: readonly string[]): string[] {
  return [
    "# Generated by OpsCrew from opscrew/plan.yaml; `opscrew provision` regenerates it.",
    ...about,
    "name: OpsCrew deploy",
    "",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(plan.cicd.branch)}]`,
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: opscrew-deploy",
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
    "    permissions:",
    ...block(j.permissions, 6),
    ...(j.outputs === undefined ? [] : ["    outputs:", ...block(j.outputs, 6)]),
    "    steps:",
    ...block(j.steps, 6),
  ];
}

/**
 * The `deploy` job (`name` shown in GitHub): after `build`, on `ubuntu-latest` in the `production`
 * environment, with the token's `permissions` (`contents: read`, …) and the `steps`. Its output
 * `previous` is the image that ran before this deploy (empty on the first one), which the image
 * retention job never deletes.
 */
export function deployJob(
  name: string,
  permissions: readonly string[],
  previous: string,
  steps: readonly string[],
): string[] {
  return job({
    id: "deploy",
    name,
    needs: "build",
    environment: "production",
    permissions,
    outputs: [`previous: ${previous}`],
    steps,
  });
}
