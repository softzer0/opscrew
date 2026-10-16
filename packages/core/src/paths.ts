import { mkdir, writeFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
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
  deployKey: string;
  deployKeyPub: string;
  knownHosts: string;
  statePassphrase: string;
  /** Private record of the server and repository the deploy secrets were last stored for. */
  deploySecrets: string;
}

/** Resolved locations for a project: committed artefacts, local state and user-level data. */
export interface ProjectPaths {
  /** Absolute project root. */
  root: string;
  /** Stable id: `<slug(basename)>-<first 12 hex of sha256(normalised root)>`. */
  projectId: string;
  /** `<root>/opscrew` — committed artefacts. */
  artefactsDir: string;
  /** `<root>/.opscrew` — machine-local state (gitignored). */
  stateDir: string;
  /** `OPSCREW_HOME` or `<homedir>/.opscrew` — user-level data. */
  homeDir: string;
  /** `<homeDir>/projects/<projectId>` — per-project secrets (deploy key, passphrase). */
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
}

/** Resolves all OpsCrew paths for the project at `root` (relative roots resolve against cwd). */
export function resolveProjectPaths(
  root: string,
  options: ResolveProjectPathsOptions = {},
): ProjectPaths {
  const absRoot = path.resolve(root);
  const env = options.env ?? process.env;
  const override = env.OPSCREW_HOME;
  const homeDir =
    override !== undefined && override !== ""
      ? path.resolve(override)
      : path.join(path.resolve(options.homedir ?? osHomedir()), ".opscrew");
  const projectId = projectIdFor(absRoot);
  const projectHomeDir = path.join(homeDir, "projects", projectId);
  const artefactsDir = path.join(absRoot, "opscrew");
  const stateDir = path.join(absRoot, ".opscrew");

  return {
    root: absRoot,
    projectId,
    artefactsDir,
    stateDir,
    homeDir,
    projectHomeDir,
    auditDir: path.join(homeDir, "audit"),
    files: {
      architecture: path.join(artefactsDir, "architecture.json"),
      architectureMd: path.join(artefactsDir, "ARCHITECTURE.md"),
      requirements: path.join(artefactsDir, "requirements.yaml"),
      plan: path.join(artefactsDir, "plan.yaml"),
      scanReportMd: path.join(artefactsDir, "SECURITY_SCAN.md"),
      scanReportJson: path.join(stateDir, "scan.json"),
      securityReport: path.join(artefactsDir, "SECURITY_REPORT.md"),
      runbook: path.join(artefactsDir, "RUNBOOK.md"),
      state: path.join(stateDir, "state.json"),
      approvals: path.join(stateDir, "approvals.jsonl"),
      costs: path.join(stateDir, "costs.jsonl"),
      plansDir: path.join(stateDir, "plans"),
      tfstateDir: path.join(stateDir, "tfstate"),
      deployKey: path.join(projectHomeDir, "deploy_key"),
      deployKeyPub: path.join(projectHomeDir, "deploy_key.pub"),
      knownHosts: path.join(projectHomeDir, "known_hosts"),
      statePassphrase: path.join(projectHomeDir, "state_passphrase"),
      deploySecrets: path.join(projectHomeDir, "deploy_secrets.json"),
    },
  };
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
