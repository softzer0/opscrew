/**
 * Fetching a pinned tool binary onto the user's machine (sops), checked by SHA-256 against its pin
 * and cached under OpsCrew's home folder.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { errorMessage, OpsCrewError } from "../errors";
import { renameWithRetry } from "../state";
import { sha256Hex } from "../values";

/** An operating system and CPU OpsCrew has a pinned binary for. */
export type LocalPlatform = `${"linux" | "darwin" | "windows"}-${"amd64" | "arm64"}`;

/** A tool binary for the user's machine: its version and the release asset per platform. */
export interface LocalToolPin {
  name: "sops";
  version: string;
  assets: Partial<Record<LocalPlatform, { url: string; sha256: string }>>;
  /** The environment variable whose path is used instead of a download (`OPSCREW_SOPS_BIN`). */
  envOverride: string;
}

/** The file system calls {@link fetchPinnedTool} makes (a subset of `node:fs/promises`). */
export interface ToolFs {
  readFile(file: string): Promise<Uint8Array>;
  writeFile(file: string, data: Uint8Array, options: { mode: number }): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
}

export interface FetchPinnedToolDeps {
  fetch: FetchLike;
  fs: ToolFs;
  env: Record<string, string | undefined>;
  /** OpsCrew's home folder (`~/.opscrew`). */
  homeDir: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `process.arch`. */
  arch: string;
}

const OS: Partial<Record<NodeJS.Platform, string>> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};
const CPU: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/**
 * The path of `pin`'s binary for this machine. `pin.envOverride`, when set, is used as it is
 * (`source: "override"`). Otherwise the binary is `<homeDir>/tools/<name>/<version>/<name>[.exe]`:
 * used when its SHA-256 matches the pin (`"cache"`), else downloaded to a temporary file, checked
 * and moved into place with mode 0755 (`"download"`).
 */
export async function fetchPinnedTool(
  pin: LocalToolPin,
  deps: FetchPinnedToolDeps,
): Promise<{ path: string; source: "override" | "cache" | "download" }> {
  const override = deps.env[pin.envOverride];
  if (override !== undefined && override !== "") return { path: override, source: "override" };

  const tool = `${pin.name} ${pin.version}`;
  const placeByHand = `install ${tool} yourself and set ${pin.envOverride} to its path`;
  const platform = `${OS[deps.platform] ?? deps.platform}-${CPU[deps.arch] ?? deps.arch}`;
  const asset = pin.assets[platform as LocalPlatform];
  if (asset === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew has no ${tool} binary for this machine (${platform}).`,
      { hint: `To go on, ${placeByHand}.` },
    );
  }

  const windows = deps.platform === "win32";
  const file = path.join(
    deps.homeDir,
    "tools",
    pin.name,
    pin.version,
    `${pin.name}${windows ? ".exe" : ""}`,
  );
  const cached = await deps.fs.readFile(file).catch(() => undefined);
  if (cached !== undefined && sha256Hex(cached) === asset.sha256) {
    return { path: file, source: "cache" };
  }

  const byHand = `download ${asset.url} yourself, check that its SHA-256 is ${asset.sha256}, and save it as ${file}; or ${placeByHand}`;
  let bytes: Uint8Array;
  try {
    const response = await deps.fetch(asset.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not download ${tool} from ${asset.url} (${errorMessage(error)}).`,
      { hint: `Check the connection and try again, or ${byHand}.`, cause: error },
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The download of ${tool} from ${asset.url} has SHA-256 ${actual}, not the pinned ${asset.sha256}, so OpsCrew did not use it.`,
      { hint: `Try again later, or ${byHand}.` },
    );
  }

  await deps.fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await deps.fs.writeFile(temporary, bytes, { mode: 0o755 });
  if (!windows) await deps.fs.chmod(temporary, 0o755);
  await renameWithRetry(temporary, file, { rename: (from, to) => deps.fs.rename(from, to) });
  return { path: file, source: "download" };
}
