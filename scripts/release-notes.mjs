#!/usr/bin/env node
// Prints the GitHub release notes for one version: its CHANGELOG.md section, with the repository's
// relative links made absolute at the version's tag, and the link that compares it with the
// previous release.
//
// Usage: node scripts/release-notes.mjs <version> > notes.md

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version) {
  console.error("Name the version, for example: node scripts/release-notes.mjs 0.1.1");
  process.exit(1);
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}. Write it first (docs/releasing.md).`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## [") || /^\[[^\]]+\]: /.test(line));
// GitHub shows each line break of a release's notes, so the changelog's wrapped lines are joined.
const unwrapped = [];
for (const line of end === -1 ? rest : rest.slice(0, end)) {
  const previous = unwrapped.length - 1;
  if (line.trim() && unwrapped[previous]?.trim() && !/^(- |#)/.test(line)) {
    unwrapped[previous] += ` ${line.trim()}`;
  } else {
    unwrapped.push(line);
  }
}
const body = unwrapped.join("\n").trim();

const tree = `https://github.com/softzer0/opscrew/blob/v${version}/`;
const notes = body.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path) => `](${tree}${path})`);
const compare = lines.find((line) => line.startsWith(`[${version}]: `))?.slice(version.length + 4);

process.stdout.write(`${notes}\n${compare ? `\n**Full changelog:** ${compare}\n` : ""}`);
