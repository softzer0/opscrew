#!/usr/bin/env node
// Points the Claude Code plugin at a new `opscrew` version before npm makes it public: its
// package.json pins the version, and its lockfile records the integrity of the exact tarball the
// Release workflow staged (the run's `opscrew-tarball` artifact). npm publishes that same tarball
// when a maintainer approves the version, so the lockfile is right from then on.
//
// Usage: node scripts/plugin-lock.mjs <path to opscrew-<version>.tgz>

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = process.argv[2];
const version = /^opscrew-(\d+\.\d+\.\d+)\.tgz$/.exec(basename(tarball ?? ""))?.[1];
if (tarball === undefined || version === undefined) {
  console.error(
    "Name the staged tarball, for example: node scripts/plugin-lock.mjs ./opscrew-0.2.0.tgz",
  );
  process.exit(1);
}

const bytes = readFileSync(tarball);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const pluginPackage = JSON.parse(readFileSync(join(root, "plugin/package.json"), "utf8"));

// npm resolves the CLI's own dependencies from the registry, with the CLI from the tarball.
const work = mkdtempSync(join(tmpdir(), "opscrew-plugin-lock-"));
try {
  copyFileSync(tarball, join(work, basename(tarball)));
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ ...pluginPackage, dependencies: { opscrew: `file:./${basename(tarball)}` } }),
  );
  execSync("npm install --package-lock-only --ignore-scripts", { cwd: work, stdio: "inherit" });
  const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
  lock.packages[""].dependencies.opscrew = version;
  const cli = lock.packages["node_modules/opscrew"];
  cli.resolved = `https://registry.npmjs.org/opscrew/-/opscrew-${version}.tgz`;
  cli.integrity = integrity;

  pluginPackage.dependencies.opscrew = version;
  writeFileSync(join(root, "plugin/package.json"), `${JSON.stringify(pluginPackage, null, 2)}\n`);
  writeFileSync(join(root, "plugin/package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`plugin/package.json and plugin/package-lock.json now pin opscrew ${version}`);
  console.log(`integrity ${integrity}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
