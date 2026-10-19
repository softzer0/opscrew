#!/usr/bin/env node
// Usage: pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]
//
// Without flags it refreshes src/pins.ts: image digests from the registries (the multi-arch
// index), tool checksums from the GitHub releases (each asset's SHA-256 digest) and action commits
// from the GitHub tags. Tags and versions stay as written in pins.ts: change one there first, then
// run this. The Python packages (PYPI_PACKAGES) and package managers (PACKAGE_MANAGERS) move to
// their newest releases on PyPI and npm; check the Dockerfiles' Docker pass after a major moves.
//
// With --offers it refreshes only BUILDPACKS_OFFERS: it reads the pinned Paketo builder's metadata
// label from the registry, then each dependency buildpack's buildpack.toml at the version the
// builder lists, and writes the versions available on the builder's stack.
//
// Every request is anonymous. Tests never run this script; its helpers are in update-pins-lib.ts,
// and its registry requests in src/registry.ts (shared with `opscrew adapt`).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ACTIONS,
  IMAGES,
  PACKAGE_MANAGERS,
  PYPI_PACKAGES,
  TOOL_RELEASES,
  TOOLS,
} from "../src/pins.ts";
import { imageDigest, registryRequest } from "../src/registry.ts";
import {
  assetSha256,
  buildpackTomlUrl,
  buildpackVersion,
  dependencyVersions,
  formatActionPin,
  latestReleaseUrl,
  latestReleaseVersion,
  OFFER_SOURCES,
  parseActionPin,
  parseImageRef,
  platformManifest,
  readBuilderConfig,
  replaceOffers,
  replacePin,
  setPackageVersion,
  setToolChecksum,
} from "./update-pins-lib.ts";

/** Each package table of pins.ts, its values and where they are published. */
const PACKAGE_TABLES = [
  { table: "PYPI_PACKAGES", packages: PYPI_PACKAGES, registry: "pypi" },
  { table: "PACKAGE_MANAGERS", packages: PACKAGE_MANAGERS, registry: "npm" },
];

const pinsFile = fileURLToPath(new URL("../src/pins.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** `GET` of `/v2/<name>/<path>` on the image's registry, with the global fetch. */
const registry = (repo, path) => registryRequest(fetch, repo, path);

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return response.json();
}

/** The commit a tag points to, following annotated tags. */
async function tagCommit(repo, tag) {
  let { object } = await github(`/repos/${repo}/git/ref/tags/${tag}`);
  while (object.type === "tag")
    ({ object } = await github(`/repos/${repo}/git/tags/${object.sha}`));
  if (object.type !== "commit") throw new Error(`${repo}@${tag} does not point to a commit.`);
  return object.sha;
}

/** Digests, commits, checksums and package versions; returns the new source and what changed. */
async function updatePins(source) {
  const changes = [];
  for (const [key, { ref }] of Object.entries(IMAGES)) {
    const { repo, tag } = parseImageRef(ref);
    const next = `${repo}:${tag}@${await imageDigest(fetch, repo, tag)}`;
    if (next === ref) continue;
    source = replacePin(source, ref, next);
    changes.push(`IMAGES.${key}: ${next}`);
  }
  for (const [key, value] of Object.entries(ACTIONS)) {
    const action = parseActionPin(value);
    const next = formatActionPin({ ...action, sha: await tagCommit(action.repo, action.tag) });
    if (next === value) continue;
    source = replacePin(source, value, next);
    changes.push(`ACTIONS.${key}: ${next}`);
  }
  for (const [key, where] of Object.entries(TOOL_RELEASES)) {
    const tool = TOOLS[key];
    const release = await github(`/repos/${where.repo}/releases/tags/${where.tag(tool.version)}`);
    for (const arch of ["amd64", "arm64"]) {
      const sha256 = assetSha256(release, where.asset[arch](tool.version));
      if (sha256 === tool.sha256[arch]) continue;
      source = setToolChecksum(source, key, arch, sha256);
      changes.push(`TOOLS.${key}.sha256.${arch}: ${sha256}`);
    }
  }
  for (const { table, packages, registry } of PACKAGE_TABLES) {
    for (const [name, version] of Object.entries(packages)) {
      const url = latestReleaseUrl(registry, name);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
      const next = latestReleaseVersion(registry, await response.json());
      if (next === version) continue;
      source = setPackageVersion(source, table, name, next);
      changes.push(`${table}.${name}: ${version} → ${next}`);
    }
  }
  return { source, changes };
}

/** BUILDPACKS_OFFERS from the pinned builder (its amd64 image; both arches list the same). */
async function updateOffers(source) {
  const { repo, digest } = parseImageRef(IMAGES.paketoBuilder.ref);
  if (digest === undefined) throw new Error("Pin IMAGES.paketoBuilder by digest first.");
  const index = await (await registry(repo, `manifests/sha256:${digest}`)).json();
  const manifest = await (
    await registry(repo, `manifests/${platformManifest(index, "amd64")}`)
  ).json();
  const config = await (await registry(repo, `blobs/${manifest.config.digest}`)).json();
  const builder = readBuilderConfig(config);
  const offers = {};
  for (const [language, { buildpack, dependency }] of Object.entries(OFFER_SOURCES)) {
    const url = buildpackTomlUrl(buildpack, buildpackVersion(builder, buildpack));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
    offers[language] = dependencyVersions(await response.text(), dependency, builder.stack);
  }
  const changes = Object.entries(offers).map(([language, v]) => `${language}: ${v.join(", ")}`);
  return { source: replaceOffers(source, offers), changes };
}

const before = readFileSync(pinsFile, "utf8");
const offersOnly = process.argv.includes("--offers");
const { source, changes } = offersOnly ? await updateOffers(before) : await updatePins(before);

if (source === before) {
  console.log("Every pin in pins.ts is current.");
} else {
  writeFileSync(pinsFile, source, "utf8");
  const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  const result = spawnSync(process.execPath, [biome, "format", "--write", pinsFile], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("Biome could not format pins.ts; run `pnpm format`.");
    process.exitCode = 1;
  }
  console.log(`Updated pins.ts:\n${changes.join("\n")}`);
}
