#!/usr/bin/env node
// Usage: pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]
//
// Without flags it refreshes src/pins.ts: image digests from the registries (the multi-arch
// index), tool checksums from the GitHub releases (each asset's SHA-256 digest) and action commits
// from the GitHub tags. Tags and versions stay as written in pins.ts: change one there first, then
// run this. Values marked `TODO(pins)` are filled the same way, once their tag or version is set.
//
// With --offers it refreshes only BUILDPACKS_OFFERS: it reads the pinned Paketo builder's metadata
// label from the registry, then each dependency buildpack's buildpack.toml at the version the
// builder lists, and writes the versions available on the builder's stack.
//
// Every request is anonymous. Tests never run this script; its helpers are in update-pins-lib.ts.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ACTIONS, IMAGES, TOOLS } from "../src/pins.ts";
import {
  assetSha256,
  buildpackTomlUrl,
  buildpackVersion,
  dependencyVersions,
  formatActionPin,
  MANIFEST_ACCEPT,
  OFFER_SOURCES,
  parseActionPin,
  parseBearerChallenge,
  parseImageRef,
  platformManifest,
  readBuilderConfig,
  registryOf,
  replaceOffers,
  replacePin,
  setToolChecksum,
  TOOL_RELEASES,
} from "./update-pins-lib.ts";

const pinsFile = fileURLToPath(new URL("../src/pins.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * `GET`/`HEAD` of `/v2/<name>/<path>` on the image's registry, asking anonymously and answering a
 * bearer challenge with an anonymous pull token.
 */
async function registry(repo, path, { method = "GET", accept = MANIFEST_ACCEPT } = {}) {
  const { host, name } = registryOf(repo);
  const url = `https://${host}/v2/${name}/${path}`;
  let response = await fetch(url, { method, headers: { Accept: accept } });
  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull`);
    const tokenResponse = await fetch(tokenUrl);
    if (!tokenResponse.ok) {
      throw new Error(`${host} refused a pull token for ${repo} (${tokenResponse.status}).`);
    }
    const { token, access_token } = await tokenResponse.json();
    response = await fetch(url, {
      method,
      headers: { Accept: accept, Authorization: `Bearer ${token ?? access_token}` },
    });
  }
  if (!response.ok) throw new Error(`${host} answered ${response.status} for ${repo} ${path}.`);
  return response;
}

/** The index digest (hex) of `repo:tag`. */
async function imageDigest(repo, tag) {
  const response = await registry(repo, `manifests/${tag}`, { method: "HEAD" });
  const digest = /^sha256:([0-9a-f]{64})$/.exec(
    response.headers.get("docker-content-digest") ?? "",
  );
  if (!digest) throw new Error(`The registry sent no digest for ${repo}:${tag}.`);
  return digest[1];
}

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

/** Digests, commits and checksums; returns the new source and what changed. */
async function updatePins(source) {
  const changes = [];
  for (const [key, { ref }] of Object.entries(IMAGES)) {
    const { repo, tag } = parseImageRef(ref);
    const next = `${repo}:${tag}@sha256:${await imageDigest(repo, tag)}`;
    if (next === ref) continue;
    source = replacePin(source, ref, next);
    changes.push(`IMAGES.${key}: ${next}`);
  }
  for (const [key, value] of Object.entries(ACTIONS)) {
    const action = parseActionPin(value);
    if (action.tag === "TODO") throw new Error(`Set the tag of ACTIONS.${key} in pins.ts first.`);
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
