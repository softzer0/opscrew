#!/usr/bin/env node
// Pack smoke test for the `opscrew` CLI package (FR-805, SC-803).
//
// Builds the bundled CLI, packs it with `pnpm pack`, checks the tarball's contents and manifest,
// then copies the tarball into an empty temporary folder and runs `npx --yes ./<tarball> --version`
// and `--help` there. npx installs
// the tarball's runtime dependencies from the npm registry (read-only); nothing is published.
//
// Usage: node scripts/pack-smoke.mjs [--keep]   (--keep leaves the temporary folders in place)

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "packages", "cli");
const keep = process.argv.includes("--keep");
const expectedVersion = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
const expectedCommands = [
  "init",
  "scan",
  "analyze",
  "interview",
  "design",
  "adapt",
  "provision",
  "verify",
  "secure",
  "destroy",
];

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

/** Runs a command and returns its stdout; `.cmd` shims (pnpm, npx) need a shell on Windows. */
function run(command, args, cwd) {
  const isWindows = process.platform === "win32";
  const quoted = isWindows ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync(command, quoted, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Lists the entries of a gzipped tarball and returns the text of `package/package.json`. */
function readTarball(file) {
  const data = gunzipSync(readFileSync(file));
  const entries = [];
  let manifest;
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const body = data.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, size });
    if (name === "package/package.json") manifest = body.toString("utf8");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, manifest };
}

const packDir = mkdtempSync(join(tmpdir(), "opscrew-pack-"));
const emptyDir = mkdtempSync(join(tmpdir(), "opscrew-npx-"));
try {
  console.log("Building the CLI (pnpm --filter opscrew build)...");
  run("pnpm", ["--filter", "opscrew", "build"], root);

  console.log(`Packing into ${packDir}...`);
  run("pnpm", ["pack", "--pack-destination", packDir], cliDir);
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  check(tarballs.length === 1, `one tarball was produced (${tarballs.join(", ") || "none"})`);
  if (tarballs.length !== 1) throw new Error("pnpm pack did not produce exactly one tarball");
  const tarball = join(packDir, tarballs[0]);
  check(
    tarballs[0] === `opscrew-${expectedVersion}.tgz`,
    `tarball is named opscrew-${expectedVersion}.tgz`,
  );

  const { entries, manifest } = readTarball(tarball);
  const totalKb = (entries.reduce((sum, e) => sum + e.size, 0) / 1024).toFixed(0);
  console.log(`Tarball contents (${entries.length} files, ${totalKb} KiB unpacked):`);
  for (const e of entries) console.log(`  ${e.name} (${(e.size / 1024).toFixed(1)} KiB)`);
  for (const required of ["dist/opscrew.js", "package.json", "README.md", "LICENSE", "NOTICE"]) {
    check(
      entries.some((e) => e.name === `package/${required}`),
      `tarball contains ${required}`,
    );
  }
  check(
    entries.every((e) =>
      /^package\/(dist\/|README\.md$|LICENSE$|NOTICE$|package\.json$)/.test(e.name),
    ),
    "tarball holds only dist/, README.md, LICENSE, NOTICE and package.json",
  );
  check(manifest !== undefined, "tarball has a package.json");
  const pkg = JSON.parse(manifest ?? "{}");
  check(pkg.version === expectedVersion, `packed manifest version is ${expectedVersion}`);
  // `private: true` guards against an accidental publish until the founder approves the release;
  // publishing removes it then. Packing and running from the tarball work either way.
  console.log(
    `info ${pkg.private === true ? "private: true (remove it only when publishing is approved)" : "not private: publishable"}`,
  );
  check(!/workspace:/.test(manifest ?? ""), "packed manifest has no workspace: specifiers");
  check(
    !Object.keys(pkg.dependencies ?? {}).some((d) => d.startsWith("@opscrew/")),
    "no @opscrew/* runtime dependency (workspace packages are bundled)",
  );

  // As in SC-803: `npx ./opscrew-<version>.tgz` from a folder holding only the tarball. (npx exits
  // silently with an absolute Windows tarball path, so the relative form is used everywhere.)
  console.log(`Running npx in the empty folder ${emptyDir}...`);
  copyFileSync(tarball, join(emptyDir, tarballs[0]));
  const local = `./${tarballs[0]}`;
  const version = run("npx", ["--yes", local, "--version"], emptyDir).trim();
  check(version === expectedVersion, `npx ${local} --version printed "${version}"`);
  const help = run("npx", ["--yes", local, "--help"], emptyDir);
  const missing = expectedCommands.filter((c) => !new RegExp(`^\\s+${c}\\b`, "m").test(help));
  check(missing.length === 0, `--help lists ${expectedCommands.join(", ")}`);
  if (missing.length > 0) console.log(`  missing: ${missing.join(", ")}`);
  check(readdirSync(emptyDir).join() === tarballs[0], "npx wrote nothing next to the tarball");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(`FAIL ${failures.at(-1)}`);
} finally {
  if (keep) console.log(`Kept ${packDir} and ${emptyDir}`);
  else {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`\nPack smoke test failed (${failures.length} problem(s)).`);
  process.exit(1);
}
console.log(`\nPack smoke test passed: opscrew ${expectedVersion} runs from its tarball with npx.`);
