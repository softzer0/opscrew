#!/usr/bin/env node
// Usage: pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]
//
// Without flags it refreshes src/pins.ts: image digests from the registries (the multi-arch
// index), tool checksums from the GitHub releases (each asset's SHA-256 digest; for a release whose
// notes give only a SHA-1, the asset is downloaded, checked against it and hashed), action commits
// from the GitHub tags, sops's checksums from its GitHub release (each one checked against the
// release's checksums file), the GitHub Actions runner's from its release body (the
// `BEGIN SHA <platform>` markers; a release without one is refused) and Lynis's from CISOfy's
// downloads page (checked against the downloaded tarball; a newer release there is only
// reported). Tags and versions stay as written in pins.ts: change one there first, then run
// this. The Python packages (PYPI_PACKAGES) and package managers (PACKAGE_MANAGERS) move to
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
  GITHUB_RUNNER_RELEASE,
  IMAGES,
  LOCAL_TOOLS,
  LYNIS_DOWNLOADS_PAGE,
  PACKAGE_MANAGERS,
  PYPI_PACKAGES,
  SOPS_RELEASE,
  TOOL_RELEASES,
  TOOLS,
  toolDownloadUrl,
} from "../src/pins.ts";
import { imageDigest, registryRequest } from "../src/registry.ts";
import {
  assetSha256,
  buildpackTomlUrl,
  buildpackVersion,
  checkedAssetSha256,
  dependencyVersions,
  formatActionPin,
  latestReleaseUrl,
  latestReleaseVersion,
  lynisPublished,
  OFFER_SOURCES,
  parseActionPin,
  parseImageRef,
  platformManifest,
  readBuilderConfig,
  releaseBodySha256,
  releaseNotesSha1,
  replaceOffers,
  replacePin,
  setAssetChecksum,
  setPackageVersion,
  setToolChecksum,
  verifiedSha256,
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

/** The body of `url` as text; throws unless it answers 200. */
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

/** Downloads an asset and returns its SHA-256 once it matches the published SHA-1 or SHA-256. */
async function downloadedSha256(url, published) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return verifiedSha256(new Uint8Array(await response.arrayBuffer()), published, url);
}

/** Digests, commits, checksums and package versions; returns the new source and what changed. */
async function updatePins(source) {
  const changes = [];
  const notes = [];
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
      const asset = where.asset[arch](tool.version);
      const sha256 = where.sha1InReleaseNotes
        ? await downloadedSha256(toolDownloadUrl(key, arch), releaseNotesSha1(release.body, asset))
        : assetSha256(release, asset);
      if (sha256 === tool.sha256[arch]) continue;
      source = setToolChecksum(source, key, arch, sha256);
      changes.push(`TOOLS.${key}.sha256.${arch}: ${sha256}`);
    }
  }
  const sops = LOCAL_TOOLS.sops;
  const sopsTag = SOPS_RELEASE.tag(sops.version);
  const sopsRelease = await github(`/repos/${SOPS_RELEASE.repo}/releases/tags/${sopsTag}`);
  const checksums = await fetchText(
    `https://github.com/${SOPS_RELEASE.repo}/releases/download/${sopsTag}/${SOPS_RELEASE.checksums(sops.version)}`,
  );
  for (const [platform, asset] of Object.entries(SOPS_RELEASE.asset)) {
    const sha256 = checkedAssetSha256(sopsRelease, checksums, asset(sops.version));
    if (sha256 === sops.assets[platform].sha256) continue;
    source = setAssetChecksum(source, "sopsAsset", platform, sha256);
    changes.push(`LOCAL_TOOLS.sops.${platform}: ${sha256}`);
  }
  const runner = TOOLS.githubRunner;
  const runnerRelease = await github(
    `/repos/${GITHUB_RUNNER_RELEASE.repo}/releases/tags/${GITHUB_RUNNER_RELEASE.tag(runner.version)}`,
  );
  for (const [platform, { sha256: pinned }] of Object.entries(runner.assets)) {
    const sha256 = releaseBodySha256(runnerRelease.body, platform);
    if (sha256 === pinned) continue;
    source = setAssetChecksum(source, "runnerAsset", platform, sha256);
    changes.push(`TOOLS.githubRunner.${platform}: ${sha256}`);
  }
  const lynis = TOOLS.lynis;
  const published = lynisPublished(await fetchText(LYNIS_DOWNLOADS_PAGE));
  if (published.version !== lynis.version) {
    notes.push(
      `Lynis ${published.version} is out; TOOLS.lynis stays at ${lynis.version} until you change its version and url.`,
    );
  } else {
    const sha256 = await downloadedSha256(lynis.url, published.sha256);
    if (sha256 !== lynis.sha256) {
      source = setToolChecksum(source, "lynis", "sha256", sha256);
      changes.push(`TOOLS.lynis.sha256: ${sha256}`);
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
  return { source, changes, notes };
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
const {
  source,
  changes,
  notes = [],
} = offersOnly ? await updateOffers(before) : await updatePins(before);
for (const note of notes) console.log(note);

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
