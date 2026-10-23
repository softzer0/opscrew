import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { OpsCrewError } from "./errors";
import { sha256Hex } from "./values";

/** Absolute paths of every file and directory OpsCrew reads or writes for one project. */
export interface ProjectFiles {
  architecture: string;
  architectureMd: string;
  requirements: string;
  plan: string;
  scanReportMd: string;
  scanReportJson: string;
  securityReport: string;
  runbook: string;
  state: string;
  approvals: string;
  costs: string;
  plansDir: string;
  tfstateDir: string;
  /** `.opscrew/cloudflare.json`: this app's hostnames in OpsCrew's shared Cloudflare rules. */
  cloudflareRecord: string;
  deployKey: string;
  deployKeyPub: string;
  knownHosts: string;
  statePassphrase: string;
  /** Private record of the server and repository the deploy secrets were last stored for. */
  deploySecrets: string;
  /** The files every environment of the app shares, at the app's prod paths. */
  shared: SharedProjectFiles;
}

/**
 * The files every environment of an app shares: the app's own at its prod paths, and the
 * repository's one scan report, which every app shares.
 */
export interface SharedProjectFiles {
  architecture: string;
  architectureMd: string;
  /** `opscrew/SECURITY_SCAN.md`, the repository's, for every app. */
  scanReportMd: string;
  /** `.opscrew/scan.json`, the repository's, for every app. */
  scanReportJson: string;
  /**
   * `opscrew/proxy/` (a further app: `opscrew/apps/<key>/proxy/`): the user's additions to the
   * proxy's configuration.
   */
  proxyDir: string;
  /**
   * `opscrew/requirements.yaml` (a further app: `opscrew/apps/<key>/requirements.yaml`): the
   * answers every environment starts from.
   */
  requirementsBase: string;
}

/** Resolved locations for a project: committed artefacts, local state and user-level data. */
export interface ProjectPaths {
  /** Absolute project root. */
  root: string;
  /** The app these paths belong to: a further app's key, absent for the repository's first app. */
  app?: string;
  /** The environment these paths belong to: `prod` unless another one was asked for. */
  environment: string;
  /** Stable id: `<slug(basename)>-<first 12 hex of sha256(normalised root)>`, one per repository. */
  projectId: string;
  /**
   * `<root>/opscrew` (another environment: `<root>/opscrew/environments/<env>`; a further app:
   * `<root>/opscrew/apps/<key>`, its environments inside it) — committed artefacts.
   */
  artefactsDir: string;
  /**
   * `<root>/.opscrew` (another environment: `.opscrew/environments/<env>`; a further app:
   * `.opscrew/apps/<key>`, its environments inside it) — local state (gitignored).
   */
  stateDir: string;
  /** `OPSCREW_HOME` or `<homedir>/.opscrew` — user-level data. */
  homeDir: string;
  /**
   * `<homeDir>/projects/<projectId>` (another environment: `…/environments/<env>`; a further app:
   * `…/apps/<key>`, its environments inside it) — per-project secrets (deploy key, passphrase).
   */
  projectHomeDir: string;
  /** `<homeDir>/audit` — audit log directory. */
  auditDir: string;
  files: ProjectFiles;
}

export interface ResolveProjectPathsOptions {
  /** Environment used for `OPSCREW_HOME`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** User home directory. Defaults to `os.homedir()`. */
  homedir?: string;
  /** A further app's key. Absent: the repository's first app, with today's paths. */
  app?: string;
  /** The app's environment. Absent or `prod`: the app's prod paths. */
  environment?: string;
}

/** The start of both name rules' messages, worded to follow a name. */
const NAME_RULE =
  "must be 1-16 lower-case letters, digits or hyphens and start with a letter, and not a name Windows reserves (con, nul, com1…) or one OpsCrew reserves";
/** The names both rules reserve beyond each one's own. */
const RESERVED_SHAPES =
  "github-pages, modules, storage, a name starting with storage-, or a name with service or env as one of its hyphen-separated parts, such as service, db-service or env";

/**
 * The rule for an environment's name; plan-schema's `EnvironmentNameSchema` checks it too. Never
 * `storage` or `storage-…`: an environment's infrastructure root `opscrew/infra/<env>` would be a
 * storage root (`opscrew/infra/storage` for prod, `opscrew/infra/storage-<env>` otherwise). Never
 * `modules`: that root would be `opscrew/infra/modules/`, the modules every root shares. Never
 * `production`, prod's GitHub environment. Never `github-pages`, the GitHub environment GitHub
 * Pages publishes from, which `opscrew destroy` deletes with a Pages site (plan-schema's
 * `githubEnvironmentFor` refuses a key and a name that join into it). Never `service` or `env` as
 * a part between hyphens: the environment's deploy secrets `OPSCREW_<ENV>_…` would then share a
 * name with a service's env file secret (`OPSCREW_SERVICE_<NAME>_ENV`, outside prod
 * `OPSCREW_<ENV>_SERVICE_<NAME>_ENV`) or a server-less site's variable (`OPSCREW_ENV_<NAME>`,
 * outside prod `OPSCREW_<ENV>_ENV_<NAME>`).
 */
export const ENVIRONMENT_NAME_PATTERN =
  /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|production|github-pages|modules)$)(?!storage(?:-|$))(?!(?:.*-)?(?:service|env)(?:-|$))[a-z][a-z0-9-]{0,15}$/;

/** What {@link ENVIRONMENT_NAME_PATTERN} asks for, worded to follow a name. */
export const ENVIRONMENT_NAME_MESSAGE = `${NAME_RULE} (production, ${RESERVED_SHAPES})`;

/**
 * The rule for a further app's key (`plan.app.key`, `opscrew/apps/<key>/`): an environment's
 * name rules ({@link ENVIRONMENT_NAME_PATTERN}), since the key takes an environment's place in
 * every name derived from it (`opscrew/infra/<key>`, `OPSCREW_<KEY>_…`), and never `prod`, whose
 * infrastructure root `opscrew/infra/prod` is the first app's.
 */
export const APP_KEY_PATTERN =
  /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|prod|production|github-pages|modules)$)(?!storage(?:-|$))(?!(?:.*-)?(?:service|env)(?:-|$))[a-z][a-z0-9-]{0,15}$/;

/** What {@link APP_KEY_PATTERN} asks for, worded to follow a key. */
export const APP_KEY_MESSAGE = `${NAME_RULE} (prod, production, ${RESERVED_SHAPES})`;

/**
 * Resolves all OpsCrew paths for the project at `root` (relative roots resolve against cwd).
 * The repository's first app (no `app`) at prod (or no environment) gets today's paths; another
 * environment gets its own artefacts, state and project-home folders, and shares `files.shared`
 * with prod. A further app's folders are under `apps/<key>`, with its environments inside them;
 * its `files.shared` holds its own architecture and the repository's scan report. Reads no
 * files, so it does not check that the app or the environment exists; a key or a name the schema
 * refuses is `INVALID_INPUT`.
 */
export function resolveProjectPaths(
  root: string,
  options: ResolveProjectPathsOptions = {},
): ProjectPaths {
  const { app } = options;
  if (app !== undefined && !APP_KEY_PATTERN.test(app)) {
    throw new OpsCrewError("INVALID_INPUT", `"${app}" is not an app key: it ${APP_KEY_MESSAGE}.`, {
      hint: "Run `opscrew app list` to see the repository's apps.",
    });
  }
  const environment = options.environment ?? "prod";
  if (!ENVIRONMENT_NAME_PATTERN.test(environment)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${environment}" is not an environment name: it ${ENVIRONMENT_NAME_MESSAGE}.`,
      { hint: "Run `opscrew env list` to see the app's environments." },
    );
  }
  const absRoot = path.resolve(root);
  const env = options.env ?? process.env;
  const override = env.OPSCREW_HOME;
  const homeDir =
    override !== undefined && override !== ""
      ? path.resolve(override)
      : path.join(path.resolve(options.homedir ?? osHomedir()), ".opscrew");
  const projectId = projectIdFor(absRoot);
  const repoArtefactsDir = path.join(absRoot, "opscrew");
  const repoStateDir = path.join(absRoot, ".opscrew");
  const ofApp = (dir: string) => (app === undefined ? dir : path.join(dir, "apps", app));
  const prodArtefactsDir = ofApp(repoArtefactsDir);
  const prodStateDir = ofApp(repoStateDir);
  const prodProjectHomeDir = ofApp(path.join(homeDir, "projects", projectId));
  const own = (dir: string) =>
    environment === "prod" ? dir : path.join(dir, "environments", environment);
  const artefactsDir = own(prodArtefactsDir);
  const stateDir = own(prodStateDir);
  const projectHomeDir = own(prodProjectHomeDir);
  const shared: SharedProjectFiles = {
    architecture: path.join(prodArtefactsDir, "architecture.json"),
    architectureMd: path.join(prodArtefactsDir, "ARCHITECTURE.md"),
    scanReportMd: path.join(repoArtefactsDir, "SECURITY_SCAN.md"),
    scanReportJson: path.join(repoStateDir, "scan.json"),
    proxyDir: path.join(prodArtefactsDir, "proxy"),
    requirementsBase: path.join(prodArtefactsDir, "requirements.yaml"),
  };

  return {
    root: absRoot,
    ...(app === undefined ? {} : { app }),
    environment,
    projectId,
    artefactsDir,
    stateDir,
    homeDir,
    projectHomeDir,
    auditDir: path.join(homeDir, "audit"),
    files: {
      architecture: shared.architecture,
      architectureMd: shared.architectureMd,
      requirements: path.join(artefactsDir, "requirements.yaml"),
      plan: path.join(artefactsDir, "plan.yaml"),
      scanReportMd: shared.scanReportMd,
      scanReportJson: shared.scanReportJson,
      securityReport: path.join(artefactsDir, "SECURITY_REPORT.md"),
      runbook: path.join(artefactsDir, "RUNBOOK.md"),
      state: path.join(stateDir, "state.json"),
      approvals: path.join(stateDir, "approvals.jsonl"),
      costs: path.join(stateDir, "costs.jsonl"),
      plansDir: path.join(stateDir, "plans"),
      tfstateDir: path.join(stateDir, "tfstate"),
      cloudflareRecord: path.join(stateDir, "cloudflare.json"),
      deployKey: path.join(projectHomeDir, "deploy_key"),
      deployKeyPub: path.join(projectHomeDir, "deploy_key.pub"),
      knownHosts: path.join(projectHomeDir, "known_hosts"),
      statePassphrase: path.join(projectHomeDir, "state_passphrase"),
      deploySecrets: path.join(projectHomeDir, "deploy_secrets.json"),
      shared,
    },
  };
}

/** The environment's infrastructure state file: `<tfstateDir>/<env>.tfstate` (`prod.tfstate` for prod). */
export function tfstateFile(paths: ProjectPaths): string {
  return path.join(paths.files.tfstateDir, `${paths.environment}.tfstate`);
}

/**
 * Normalises an absolute root so equivalent spellings hash the same: lower-cases a Windows drive
 * letter and removes trailing separators (but never the filesystem root itself).
 */
function normaliseRoot(absRoot: string): string {
  let value = absRoot.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const fsRoot = path.parse(value).root;
  while (value.length > fsRoot.length && /[\\/]$/.test(value)) value = value.slice(0, -1);
  return value;
}

function slug(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return value === "" ? "project" : value;
}

/** Stable project id: `<slug(basename)>-<first 12 hex of sha256(normalised absolute root)>`. */
export function projectIdFor(root: string): string {
  const normalised = normaliseRoot(path.resolve(root));
  const hash = sha256Hex(normalised).slice(0, 12);
  return `${slug(path.basename(normalised))}-${hash}`;
}

/** Creates `<root>/.opscrew/` and a `.gitignore` containing `*` inside it when missing. */
export async function ensureStateDir(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
  try {
    await writeFile(path.join(paths.stateDir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Path of `abs` relative to `root`, with forward slashes (`""` when they are the same). */
export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** `text` without a leading UTF-8 byte order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The file's UTF-8 text, or `undefined` when it does not exist; any other read error is thrown. */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** True when something exists at `file` (a file or a folder). */
export async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
