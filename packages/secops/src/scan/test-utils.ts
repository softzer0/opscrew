/**
 * Test-only helpers for the scan and rule tests (not exported from the package). Fixtures live in
 * `packages/secops/test/fixtures/<name>/` and contain `{{FAKE:<kind>}}` markers instead of
 * secret-shaped literals.
 */
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandResult,
  CommandRunner,
  Finding,
  ScanContext,
  Scanner,
} from "@opscrew/contracts";
import { expandFakeSecrets, materializeFixture } from "@opscrew/core/testing";
import { expect } from "vitest";
import { createScanContext } from "./context";

const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url));
const MARKER = /\{\{FAKE:[a-z0-9-]+(?::[A-Za-z0-9_-]+)?\}\}/g;

/** A materialised fixture project in a temporary directory. */
export interface MaterializedFixture {
  /** Absolute path of the project root. */
  dir: string;
  /** Every fake secret value generated for this fixture. */
  fakes: string[];
  cleanup(): Promise<void>;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Fake secret values produced by the markers in a fixture directory. */
async function collectFakes(srcDir: string): Promise<string[]> {
  const fakes = new Set<string>();
  for (const file of await walk(srcDir)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(MARKER)) fakes.add(expandFakeSecrets(match[0]));
  }
  return [...fakes];
}

/**
 * Renames `_env*` files to `.env*` after materialising. The repository's own `.gitignore` ignores
 * `.env.*`, so fixture dotenv files are committed as `_env`, `_env.local`, …
 */
async function renameDotenvFiles(dir: string): Promise<void> {
  for (const file of await walk(dir)) {
    const name = path.basename(file);
    if (name.startsWith("_env"))
      await rename(file, path.join(path.dirname(file), `.${name.slice(1)}`));
  }
}

/** Copies `test/fixtures/<name>` into a fresh temporary directory (named `<name>-…`). */
export async function materialize(name: string): Promise<MaterializedFixture> {
  const src = path.join(FIXTURES_DIR, name);
  const parent = await mkdtemp(path.join(tmpdir(), "opscrew-secops-"));
  const dir = path.join(parent, path.basename(name));
  await materializeFixture(src, dir);
  await renameDotenvFiles(dir);
  return {
    dir,
    fakes: await collectFakes(src),
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

/** Runner that fails every command, so `git ls-files` is never trusted by accident. */
export const failingRunner: CommandRunner = {
  run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
};

/** Runner that answers `git ls-files -z` with `tracked` and records every call. */
export function gitRunner(tracked: readonly string[]): CommandRunner & {
  calls: Array<{ command: string; args: readonly string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  return {
    calls,
    run: async (command, args, options): Promise<CommandResult> => {
      const call: { command: string; args: readonly string[]; cwd?: string } = { command, args };
      if (options?.cwd !== undefined) call.cwd = options.cwd;
      calls.push(call);
      if (command === "git" && args[0] === "ls-files") {
        return { exitCode: 0, stdout: tracked.map((file) => `${file}\0`).join(""), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
  };
}

/** Fetch that fails the test if any scanner touches the network. */
export const noFetch = async (): Promise<Response> => {
  throw new Error("network access is not allowed in tests");
};

/** Scan context over `dir` with the offline fakes. */
export function contextFor(
  dir: string,
  runner: CommandRunner = failingRunner,
): Promise<ScanContext> {
  return createScanContext(dir, { offline: true, fetch: noFetch, runner });
}

/** Runs one scanner over a context. */
export async function scanWith(scanner: Scanner, context: ScanContext): Promise<Finding[]> {
  expect(await scanner.isAvailable(context)).toBe(true);
  return scanner.scan(context);
}

/**
 * Asserts that no generated fake value (nor any 16+ character line of a multi-line value such as
 * a PEM block) appears in any string field of any finding.
 */
export function expectNoFakeValues(findings: readonly Finding[], fakes: readonly string[]): void {
  expect(fakes.length).toBeGreaterThan(0);
  const needles = fakes.flatMap((fake) => [
    fake,
    ...fake.split("\n").filter((line) => line.length >= 16),
  ]);
  for (const finding of findings) {
    const fields = Object.values(finding).flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [String(value)],
    );
    for (const field of fields) {
      for (const needle of needles) {
        if (field.includes(needle)) {
          throw new Error(`Finding ${finding.ruleId} (${finding.file}) leaks a fake secret value.`);
        }
      }
    }
  }
}

/** `ruleId@file:line` keys for compact assertions. */
export function keys(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.ruleId}@${f.file ?? ""}:${f.line ?? ""}`).sort();
}
