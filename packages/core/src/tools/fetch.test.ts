import { createHash } from "node:crypto";
import path from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { type FetchPinnedToolDeps, fetchPinnedTool, type LocalToolPin, type ToolFs } from "./fetch";

const BINARY = new TextEncoder().encode("#!fake sops binary\n");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const URL_LINUX = "https://example.test/sops-v3.13.3.linux.amd64";
const URL_WINDOWS = "https://example.test/sops-v3.13.3.amd64.exe";

const PIN: LocalToolPin = {
  name: "sops",
  version: "3.13.3",
  envOverride: "OPSCREW_SOPS_BIN",
  assets: {
    "linux-amd64": { url: URL_LINUX, sha256: sha256(BINARY) },
    "windows-amd64": { url: URL_WINDOWS, sha256: sha256(BINARY) },
  },
};

/** An in-memory file system that records each call. */
function memoryFs(files: Record<string, Uint8Array> = {}) {
  const stored = new Map(Object.entries(files));
  const modes = new Map<string, number>();
  const calls: string[] = [];
  const fs: ToolFs = {
    async readFile(file) {
      calls.push(`read ${file}`);
      const bytes = stored.get(file);
      if (bytes === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return bytes;
    },
    async writeFile(file, data, { mode }) {
      calls.push(`write ${file} ${mode.toString(8)}`);
      stored.set(file, data);
    },
    async mkdir(dir) {
      calls.push(`mkdir ${dir}`);
    },
    async rename(from, to) {
      calls.push(`rename ${from} ${to}`);
      stored.set(to, stored.get(from) as Uint8Array);
      stored.delete(from);
      if (modes.has(from)) modes.set(to, modes.get(from) as number);
    },
    async chmod(file, mode) {
      calls.push(`chmod ${file} ${mode.toString(8)}`);
      modes.set(file, mode);
    },
  };
  return { fs, stored, modes, calls };
}

function binaryFetch(reply: () => Response) {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(String(input));
    return reply();
  };
  return { fetch, urls };
}

const HOME = path.join("/home", "u", ".opscrew");
const LINUX_FILE = path.join(HOME, "tools", "sops", "3.13.3", "sops");
const WINDOWS_FILE = path.join(HOME, "tools", "sops", "3.13.3", "sops.exe");

function deps(over: Partial<FetchPinnedToolDeps> & Pick<FetchPinnedToolDeps, "fs" | "fetch">) {
  return { env: {}, homeDir: HOME, platform: "linux" as const, arch: "x64", ...over };
}

async function failure(promise: Promise<unknown>): Promise<{ message: string; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; hint?: string };
  }
  throw new Error("expected a failure");
}

describe("fetchPinnedTool", () => {
  it("downloads to a temporary file, checks it and moves it into the cache with mode 0755", async () => {
    const { fs, stored, modes, calls } = memoryFs();
    const { fetch, urls } = binaryFetch(() => new Response(BINARY));
    const result = await fetchPinnedTool(PIN, deps({ fs, fetch }));
    expect(result).toEqual({ path: LINUX_FILE, source: "download" });
    expect(urls).toEqual([URL_LINUX]);
    expect(stored.get(LINUX_FILE)).toEqual(BINARY);
    expect(modes.get(LINUX_FILE)).toBe(0o755);
    const temporary = /^write (.+\.\d+\.[0-9a-f]{12}\.tmp) 755$/.exec(calls[2] ?? "")?.[1];
    expect(temporary?.startsWith(`${LINUX_FILE}.`)).toBe(true);
    expect(calls.slice(1)).toEqual([
      `mkdir ${path.dirname(LINUX_FILE)}`,
      `write ${temporary} 755`,
      `chmod ${temporary} 755`,
      `rename ${temporary} ${LINUX_FILE}`,
    ]);
    expect([...stored.keys()]).toEqual([LINUX_FILE]);

    // Each download writes its own temporary file.
    const again = memoryFs();
    await fetchPinnedTool(PIN, deps({ fs: again.fs, fetch }));
    expect(again.calls[2]).not.toBe(calls[2]);
  });

  it("retries the rename while Windows holds the file", async () => {
    const { fs, stored } = memoryFs();
    const rename = fs.rename;
    let refused = 0;
    fs.rename = async (from, to) => {
      if (refused++ < 2) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return rename(from, to);
    };
    const { fetch } = binaryFetch(() => new Response(BINARY));
    const result = await fetchPinnedTool(PIN, deps({ fs, fetch, platform: "win32" }));
    expect(result).toEqual({ path: WINDOWS_FILE, source: "download" });
    expect(refused).toBe(3);
    expect(stored.get(WINDOWS_FILE)).toEqual(BINARY);
  });

  it("uses the .exe on Windows, without chmod", async () => {
    const { fs, calls } = memoryFs();
    const { fetch, urls } = binaryFetch(() => new Response(BINARY));
    const result = await fetchPinnedTool(PIN, deps({ fs, fetch, platform: "win32" }));
    expect(result).toEqual({ path: WINDOWS_FILE, source: "download" });
    expect(urls).toEqual([URL_WINDOWS]);
    expect(calls.some((call) => call.startsWith("chmod"))).toBe(false);
  });

  it("checks a cached file on every call and downloads a changed one again", async () => {
    const { fs, stored } = memoryFs({ [LINUX_FILE]: BINARY });
    const { fetch, urls } = binaryFetch(() => new Response(BINARY));
    expect(await fetchPinnedTool(PIN, deps({ fs, fetch }))).toEqual({
      path: LINUX_FILE,
      source: "cache",
    });
    expect(await fetchPinnedTool(PIN, deps({ fs, fetch }))).toEqual({
      path: LINUX_FILE,
      source: "cache",
    });
    expect(urls).toEqual([]);

    stored.set(LINUX_FILE, new TextEncoder().encode("tampered"));
    expect(await fetchPinnedTool(PIN, deps({ fs, fetch }))).toEqual({
      path: LINUX_FILE,
      source: "download",
    });
    expect(urls).toEqual([URL_LINUX]);
    expect(stored.get(LINUX_FILE)).toEqual(BINARY);
  });

  it("uses the override as it is", async () => {
    const { fs, calls } = memoryFs();
    const { fetch, urls } = binaryFetch(() => new Response(BINARY));
    const override = path.join("/opt", "sops-dev");
    const result = await fetchPinnedTool(
      PIN,
      deps({ fs, fetch, env: { OPSCREW_SOPS_BIN: override }, arch: "riscv64" }),
    );
    expect(result).toEqual({ path: override, source: "override" });
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("says when the platform has no pinned binary", async () => {
    const { fs } = memoryFs();
    const { fetch, urls } = binaryFetch(() => new Response(BINARY));
    const error = await failure(
      fetchPinnedTool(PIN, deps({ fs, fetch, platform: "darwin", arch: "arm64" })),
    );
    expect(error.message).toBe(
      "OpsCrew has no sops 3.13.3 binary for this machine (darwin-arm64).",
    );
    expect(error.hint).toContain("set OPSCREW_SOPS_BIN");
    expect(urls).toEqual([]);
  });

  it("names the URL when the download fails, and writes nothing", async () => {
    for (const reply of [
      () => new Response("missing", { status: 404 }),
      () => {
        throw new Error("getaddrinfo ENOTFOUND example.test");
      },
    ]) {
      const { fs, stored } = memoryFs();
      const { fetch } = binaryFetch(reply);
      const error = await failure(fetchPinnedTool(PIN, deps({ fs, fetch })));
      expect(error.message).toMatch(
        new RegExp(
          `^Could not download sops 3\\.13\\.3 from ${URL_LINUX} \\((HTTP 404|getaddrinfo)`,
        ),
      );
      expect(error.hint).toContain(`save it as ${LINUX_FILE}`);
      expect(stored.size).toBe(0);
    }
  });

  it("refuses a download whose checksum differs, and writes nothing", async () => {
    const { fs, stored } = memoryFs();
    const other = new TextEncoder().encode("something else");
    const { fetch } = binaryFetch(() => new Response(other));
    const error = await failure(fetchPinnedTool(PIN, deps({ fs, fetch })));
    expect(error.message).toBe(
      `The download of sops 3.13.3 from ${URL_LINUX} has SHA-256 ${sha256(other)}, not the pinned ${sha256(BINARY)}, so OpsCrew did not use it.`,
    );
    expect(error.hint).toMatch(/Try again later, or download .* yourself/);
    expect(stored.size).toBe(0);
  });
});
