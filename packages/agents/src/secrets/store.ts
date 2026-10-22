/**
 * What the recovery copy keeps beside it: the local record (`.opscrew/recovery.json`, hashes and
 * times only), the folder setting (`.opscrew/secrets.json`), the repository's `opscrew/.sops.yaml`
 * and `.gitattributes`, the key file handed to the user, and the sops binary.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureStateDir,
  errorMessage,
  exists,
  fetchPinnedTool,
  isAgeRecipient,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import { LOCAL_TOOLS, type RenderedFile } from "@opscrew/iac-templates";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readValidJson } from "../shared/files";
import { copyPath } from "./files";

/** The creation rule's file in the repository (committed). */
export const SOPS_CONFIG_PATH = "opscrew/.sops.yaml";

/** The `.gitattributes` lines that keep the environment's copy and its rule LF on every computer. */
function gitattributesLines(paths: Pick<ProjectPaths, "root" | "artefactsDir">): string[] {
  return [`${copyPath(paths)} text eol=lf`, `${SOPS_CONFIG_PATH} text eol=lf`];
}

/** The creation rule's `path_regex`, which matches every environment's copy wherever sops is run. */
const COPY_RULE = "secrets\\.sops\\.json$";

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);

const RecoveryRecordSchema = z.object({
  /** SHA-256 of each file the repository's copy holds, by path. */
  hashes: z.record(z.string(), HEX64).optional(),
  /** SHA-256 of the copy this computer last wrote or restored from. */
  copySha256: HEX64.optional(),
  /** When this computer last wrote a copy (the folder's or the repository's). */
  copiedAt: z.string().optional(),
  /** When this computer last handed a copy to the repository. */
  repositoryCopyAt: z.string().optional(),
  /** SHA-256 of each file the folder copy this computer last wrote holds, by path. */
  folderHashes: z.record(z.string(), HEX64).optional(),
  /** The answer to committing the copy to a public repository (FR-1415). */
  publicConfirmed: z.boolean().optional(),
});

/** `.opscrew/recovery.json`: hashes and times, never a value. */
export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;

function recordFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "recovery.json");
}

/** The local record; empty when there is none yet. */
export async function readRecord(paths: Pick<ProjectPaths, "stateDir">): Promise<RecoveryRecord> {
  return (await readValidJson(recordFile(paths), RecoveryRecordSchema)) ?? {};
}

export async function writeRecord(
  paths: Pick<ProjectPaths, "stateDir">,
  record: RecoveryRecord,
): Promise<void> {
  await writeFileAtomic(recordFile(paths), `${JSON.stringify(record, null, 2)}\n`);
}

const SettingsSchema = z.object({ folder: z.string().min(1).optional() });

function settingsFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "secrets.json");
}

/** The folder the copy is also written to (`.opscrew/secrets.json`), if the user named one. */
export async function readFolder(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<string | undefined> {
  return (await readValidJson(settingsFile(paths), SettingsSchema))?.folder;
}

/**
 * Sets the folder the recovery copy is also written to (`opscrew secrets folder <path>`), or clears
 * it (`undefined`). The setting is this computer's (`.opscrew/secrets.json`). A folder inside the
 * repository is refused.
 */
export async function setRecoveryFolder(
  deps: Pick<PhaseDeps, "paths">,
  folder: string | undefined,
): Promise<void> {
  const full =
    folder === undefined
      ? undefined
      : fullPathOutside(folder, [[deps.paths.root, "the repository"]], {
          what: "The folder for the recovery copy",
          refused: "OpsCrew does not keep the folder copy",
          hint: "Pick a folder outside the repository, for example on a backup drive or in a synced folder, then try again.",
        });
  await ensureStateDir(deps.paths);
  await writeFileAtomic(
    settingsFile(deps.paths),
    `${JSON.stringify(full === undefined ? {} : { folder: full })}\n`,
  );
}

/** The folder copy of the app's recovery copy: `<folder>/<app>.sops.json`. */
export function folderCopyPath(folder: string, app: string): string {
  return join(folder, `${app}.sops.json`);
}

/** The environment's copy in this checkout ({@link copyPath}), if there is one. */
export function readRepositoryCopy(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
): Promise<string | undefined> {
  return readTextIfExists(join(paths.root, copyPath(paths)));
}

/**
 * Stops with `SECRETS_COPY_CHANGED_ELSEWHERE` when the environment's copy in the repository is not
 * the one this computer last wrote or restored from: another computer updated it, so writing this
 * computer's files over it could lose that computer's secrets (FR-1417).
 */
export function requireOwnCopy(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
  repositoryCopy: string | undefined,
  record: RecoveryRecord,
): void {
  if (repositoryCopy === undefined || sha256Hex(repositoryCopy) === record.copySha256) return;
  throw new OpsCrewError(
    "SECRETS_COPY_CHANGED_ELSEWHERE",
    `${copyPath(paths)} in the repository is not the copy this computer last wrote: another computer updated it, so OpsCrew did not update it from this computer's files.`,
    {
      hint: "Run `opscrew secrets restore` first: it shows which files and generated values differ, by name only, and lets you choose which side to keep.",
    },
  );
}

const SopsConfigSchema = z.looseObject({
  creation_rules: z.array(z.looseObject({ path_regex: z.string(), age: z.string() })),
});

/**
 * The recipients (`age1…`) of the copy's creation rule in `opscrew/.sops.yaml`; `undefined` when
 * the file does not exist. A file without a valid rule for the copy stops plainly.
 */
export async function readRecipients(
  paths: Pick<ProjectPaths, "root">,
): Promise<string[] | undefined> {
  const text = await readTextIfExists(join(paths.root, SOPS_CONFIG_PATH));
  if (text === undefined) return undefined;
  let rule: { age: string } | undefined;
  try {
    const config = SopsConfigSchema.safeParse(parse(text));
    rule = config.data?.creation_rules.find((r) => r.path_regex === COPY_RULE);
  } catch {
    rule = undefined;
  }
  const recipients = rule?.age.split(",").map((r) => r.trim()) ?? [];
  if (recipients.length === 0 || recipients.length > 2 || !recipients.every(isAgeRecipient)) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `${SOPS_CONFIG_PATH} has no rule for secrets.sops.json with one or two age keys (age1…), so OpsCrew cannot tell whom to encrypt the recovery copy to.`,
      {
        hint: `Put back the ${SOPS_CONFIG_PATH} OpsCrew wrote (git restore ${SOPS_CONFIG_PATH}), or make a new key with \`opscrew secrets rotate\`.`,
      },
    );
  }
  return recipients;
}

/** `opscrew/.sops.yaml` with the copy's creation rule for `recipients`. */
export function sopsConfigFile(recipients: readonly string[]): RenderedFile {
  return {
    path: SOPS_CONFIG_PATH,
    content: [
      "# Written by OpsCrew: the age keys that can open opscrew/secrets.sops.json, the encrypted",
      "# recovery copy of what OpsCrew keeps on your computer for this app.",
      "creation_rules:",
      `  - path_regex: ${COPY_RULE}`,
      `    age: ${recipients.join(",")}`,
      "",
    ].join("\n"),
    kind: "doc",
    mode: 0o644,
  };
}

/**
 * `.gitattributes` with the environment's copy's lines added, or `undefined` when it has them
 * already.
 */
export async function gitattributesFile(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
): Promise<RenderedFile | undefined> {
  const current = (await readTextIfExists(join(paths.root, ".gitattributes"))) ?? "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = gitattributesLines(paths).filter((line) => !lines.has(line));
  if (missing.length === 0) return undefined;
  const head = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  return {
    path: ".gitattributes",
    content: `${head}${missing.join("\n")}\n`,
    kind: "doc",
    mode: 0o644,
  };
}

/** The environment's copy ({@link copyPath}) as a file for the pull request. */
export function copyFile(
  paths: Pick<ProjectPaths, "root" | "artefactsDir">,
  copy: string,
): RenderedFile {
  return { path: copyPath(paths), content: copy, kind: "doc", mode: 0o644 };
}

/** True when `file` is `dir` or lies below it. */
function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `file` as a full path, refused when it is not absolute or lies inside one of `dirs` (each with
 * its name for the message).
 */
function fullPathOutside(
  file: string,
  dirs: readonly (readonly [string, string])[],
  wording: { what: string; refused: string; hint: string },
): string {
  if (!isAbsolute(file)) {
    throw new OpsCrewError("INVALID_INPUT", `${wording.what} needs a full path, not ${file}.`, {
      hint: wording.hint,
    });
  }
  const full = resolve(file);
  for (const [dir, name] of dirs) {
    if (inside(dir, full)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${wording.refused} inside ${name} (${dir}): it could be committed or copied with it.`,
        { hint: wording.hint },
      );
    }
  }
  return full;
}

/**
 * The full path for a new key file, refused before anything is encrypted or written when it is not
 * absolute, lies inside the repository or OpsCrew's own folder, or already exists.
 */
export async function keyFilePath(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  file: string,
): Promise<string> {
  const hint =
    "Pick a file outside the repository and outside OpsCrew's folder, for example in your home folder, then try again.";
  const full = fullPathOutside(
    file,
    [
      [paths.root, "the repository"],
      [paths.homeDir, "OpsCrew's folder"],
    ],
    { what: "The key file", refused: "OpsCrew does not write the age key", hint },
  );
  if (await exists(full)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `A file already exists at ${full}, and OpsCrew never writes a key over a file. Nothing was written.`,
      { hint },
    );
  }
  return full;
}

/** The file a new age key was written to, once (mode 0600). The key itself is never returned. */
export interface KeyHandover {
  path: string;
}

/**
 * Writes a new age key once to `file` (from {@link keyFilePath}): mode 0600, never over an existing
 * file, in age's key file format (sops reads it as `SOPS_AGE_KEY_FILE`).
 */
export async function writeKeyFile(
  deps: Pick<PhaseDeps, "clock">,
  file: string,
  key: { identity: string; recipient: string },
): Promise<KeyHandover> {
  const content = [
    `# created: ${deps.clock.now().toISOString()}`,
    `# public key: ${key.recipient}`,
    key.identity,
    "",
  ].join("\n");
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    throw new OpsCrewError(
      "INVALID_INPUT",
      exists
        ? `A file already exists at ${file}, and OpsCrew never writes a key over a file.`
        : `OpsCrew could not write the new age key to ${file} (${errorMessage(error)}).`,
      { hint: "Pick another file for the key (its folder must exist), then try again." },
    );
  }
  return { path: file };
}

/** What to tell the user about a key file handed over. */
export function keyHandoverNote(handover: KeyHandover): string {
  return `OpsCrew wrote your new age key to ${handover.path}. Only it (or your backup key) opens the recovery copy of this app's secrets, and OpsCrew keeps no copy of it: move it into your password manager, then delete the file.`;
}

/**
 * The pinned sops (`LOCAL_TOOLS.sops`), fetched and checked into OpsCrew's tools folder, or
 * `OPSCREW_SOPS_BIN` as it is.
 */
export async function sopsBinary(deps: Pick<PhaseDeps, "fetch" | "env" | "paths">) {
  const tool = await fetchPinnedTool(LOCAL_TOOLS.sops, {
    fetch: deps.fetch,
    fs: { readFile, writeFile, mkdir, rename, chmod },
    env: deps.env,
    homeDir: deps.paths.homeDir,
    platform: process.platform,
    arch: process.arch,
  });
  return tool.path;
}
