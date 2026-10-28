/**
 * The files of the recovery copy: what OpsCrew keeps on this computer for the app and cannot
 * rebuild (FR-1410), each one value under its path in the copy (`home/<name>`, `state/<path>`).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isRecord,
  type ProjectPaths,
  type Redactor,
  readTextIfExists,
  toPosixRelative,
} from "@opscrew/core";

/** Prod's copy in the repository (committed); {@link copyPath} gives each environment's. */
export const COPY_PATH = "opscrew/secrets.sops.json";

/**
 * The environment's copy in the repository, relative to its root: {@link COPY_PATH} for prod,
 * `opscrew/environments/<env>/secrets.sops.json` for another, beside its plan.
 */
export function copyPath(paths: Pick<ProjectPaths, "root" | "artefactsDir">): string {
  return toPosixRelative(paths.root, join(paths.artefactsDir, "secrets.sops.json"));
}

/** From the project's folder in OpsCrew's home (`~/.opscrew/projects/<id>/`). */
const HOME_FILES = [
  "generated_values.json",
  "deploy_key",
  "deploy_key.pub",
  "known_hosts",
  "state_passphrase",
  "deploy_secrets.json",
  "portainer-env.key",
  "portainer-webhook",
  "portainer_password",
  "check_key",
  "beszel_secrets.json",
  "grafana_cloud_token",
] as const;

/**
 * From the project's `.opscrew/`, besides `tfstate/*.tfstate`. Not `state.json`: it only records
 * phase outcomes and times, and would change the copy on every run.
 */
const STATE_FILES = ["server.json", "cloudflare.json"] as const;

const TFSTATE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.tfstate$/;

/** The copy's path of the generated values, whose values are registered one by one. */
const GENERATED_VALUES = "home/generated_values.json";

/**
 * True for a path the copy may hold: `home/` and a name of the list, `state/` and a record of the
 * list or `tfstate/<name>.tfstate`. Never `..`, a backslash or an absolute path.
 */
export function isCopyPath(path: string): boolean {
  if (path.includes("..")) return false;
  if (path.startsWith("home/")) return (HOME_FILES as readonly string[]).includes(path.slice(5));
  if (!path.startsWith("state/")) return false;
  const rest = path.slice(6);
  if ((STATE_FILES as readonly string[]).includes(rest)) return true;
  return rest.startsWith("tfstate/") && TFSTATE.test(rest.slice(8));
}

/** Where a copy path (checked with {@link isCopyPath}) lives on this computer. */
export function localPath(paths: Pick<ProjectPaths, "projectHomeDir" | "stateDir">, path: string) {
  const [root, ...rest] = path.split("/");
  return join(root === "home" ? paths.projectHomeDir : paths.stateDir, ...rest);
}

/** The mode a restored file gets: 0600 for `home/*` and the infrastructure state, else 0644. */
export function fileMode(path: string): number {
  return path.startsWith("home/") || path.startsWith("state/tfstate/") ? 0o600 : 0o644;
}

/**
 * The copy's files present on this computer, by path (a missing file is absent). Every value
 * inside the generated values is registered with the redactor.
 */
export async function readLocalFiles(
  paths: Pick<ProjectPaths, "projectHomeDir" | "stateDir">,
  redactor: Redactor,
): Promise<Record<string, string>> {
  const tfstate = await readdir(join(paths.stateDir, "tfstate")).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const names = [
    ...HOME_FILES.map((name) => `home/${name}`),
    ...STATE_FILES.map((name) => `state/${name}`),
    ...tfstate
      .filter((name) => TFSTATE.test(name))
      .sort()
      .map((name) => `state/tfstate/${name}`),
  ];
  const files: Record<string, string> = {};
  for (const path of names) {
    const text = await readTextIfExists(localPath(paths, path));
    if (text !== undefined) files[path] = text;
  }
  registerGeneratedValues(redactor, files);
  return files;
}

/** Every string inside a JSON value with its dotted name (`env.SECRET_KEY_BASE`). */
function leaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    leaves(item, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function generatedLeaves(text: string | undefined): Map<string, string> {
  if (text === undefined) return new Map();
  try {
    return new Map(leaves(JSON.parse(text)));
  } catch {
    return new Map();
  }
}

/**
 * Registers every value inside `files`' generated values with the redactor, each by itself, under
 * the label provision gives them (`app-env`).
 */
export function registerGeneratedValues(redactor: Redactor, files: Record<string, string>): void {
  for (const value of generatedLeaves(files[GENERATED_VALUES]).values()) {
    redactor.addLiteral(value, "app-env");
  }
}

/**
 * The names (never the values) of the generated values that differ between two sets of files;
 * none when either has no generated values (a missing file is not a conflict).
 */
export function differingGeneratedNames(a: Record<string, string>, b: Record<string, string>) {
  if (a[GENERATED_VALUES] === undefined || b[GENERATED_VALUES] === undefined) return [];
  const left = generatedLeaves(a[GENERATED_VALUES]);
  const right = generatedLeaves(b[GENERATED_VALUES]);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((name) => left.get(name) !== right.get(name))
    .sort();
}
