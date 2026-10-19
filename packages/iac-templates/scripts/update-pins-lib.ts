/**
 * Pure helpers of `scripts/update-pins.mjs`: parsing image and action pins, release, package and
 * builder metadata, and rewriting values in `src/pins.ts`. Tested in `src/pins.test.ts`; nothing
 * here touches the network. The registry requests are in `src/registry.ts`.
 */
import type { BUILDPACKS_OFFERS, PinArch } from "../src/pins";

type OfferLanguage = keyof typeof BUILDPACKS_OFFERS;

/** An image reference split into its parts; `digest` is the hex after `@sha256:`. */
export interface ImageRef {
  repo: string;
  tag: string;
  digest?: string;
}

const IMAGE_REF =
  /^([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*):([\w][\w.-]*)(?:@sha256:([0-9a-f]{64}))?$/;

/** Splits `repo:tag[@sha256:<hex>]`; throws for anything else. */
export function parseImageRef(ref: string): ImageRef {
  const match = IMAGE_REF.exec(ref);
  if (!match) throw new Error(`Not an image reference of the form repo:tag[@sha256:…]: ${ref}`);
  const [, repo, tag, digest] = match as unknown as [string, string, string, string | undefined];
  return digest === undefined ? { repo, tag } : { repo, tag, digest };
}

/**
 * A GitHub Action pin. `action` is what `uses:` names (`owner/name`, or `owner/name/path` for an
 * action in a subfolder), `repo` its repository.
 */
export interface ActionPin {
  action: string;
  repo: string;
  tag: string;
  sha: string;
}

const ACTION_PIN = /^(([\w.-]+\/[\w.-]+)(?:\/[\w.-]+)*)@([0-9a-f]{40}) # (\S+)$/;

/** Reads `<action>@<40-hex sha> # <tag>`. */
export function parseActionPin(value: string): ActionPin {
  const pinned = ACTION_PIN.exec(value);
  if (!pinned) throw new Error(`Not an action pin of the form owner/name@<sha> # <tag>: ${value}`);
  const [, action, repo, sha, tag] = pinned as unknown as string[];
  return { action, repo, tag, sha } as ActionPin;
}

/** `<action>@<sha> # <tag>`. */
export function formatActionPin(pin: ActionPin): string {
  return `${pin.action}@${pin.sha} # ${pin.tag}`;
}

/** The SHA-256 GitHub records for the asset `name` of a release (the API's `digest`). */
export function assetSha256(release: unknown, name: string): string {
  const assets = ((release as { assets?: unknown[] }).assets ?? []) as {
    name?: unknown;
    digest?: unknown;
  }[];
  const asset = assets.find((a) => a.name === name);
  if (asset === undefined) {
    const names = assets.map((a) => String(a.name)).join(", ");
    throw new Error(`The release has no asset ${name}; it has: ${names}`);
  }
  const digest =
    typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest) : null;
  if (!digest) throw new Error(`GitHub lists no SHA-256 for ${name}.`);
  return digest[1] as string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces the string literal `old` (it must appear exactly once) with `next`. */
export function replacePin(source: string, old: string, next: string): string {
  const literal = JSON.stringify(old);
  const at = source.indexOf(literal);
  if (at < 0 || source.indexOf(literal, at + 1) >= 0) {
    throw new Error(`Expected ${literal} exactly once in pins.ts.`);
  }
  return `${source.slice(0, at)}${JSON.stringify(next)}${source.slice(at + literal.length)}`;
}

/** The digest of the `linux/<arch>` manifest an image index lists. */
export function platformManifest(index: unknown, arch: PinArch): string {
  const manifests = ((index as { manifests?: unknown[] }).manifests ?? []) as {
    digest?: unknown;
    platform?: { architecture?: unknown; os?: unknown };
  }[];
  const found = manifests.find(
    (m) => m.platform?.os === "linux" && m.platform?.architecture === arch,
  );
  if (typeof found?.digest !== "string") throw new Error(`The index lists no linux/${arch} image.`);
  return found.digest;
}

/** A Buildpacks builder as its image config describes it: its stack and buildpack versions. */
export interface BuilderInfo {
  stack: string;
  /** Buildpack id → every version the builder lists (a buildpack may appear several times). */
  buildpacks: Record<string, string[]>;
}

/** Reads the labels `io.buildpacks.stack.id` and `io.buildpacks.builder.metadata`. */
export function readBuilderConfig(config: unknown): BuilderInfo {
  const labels = (config as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
  const stack = labels["io.buildpacks.stack.id"];
  const metadata = labels["io.buildpacks.builder.metadata"];
  if (stack === undefined || metadata === undefined) {
    throw new Error("The image has no Buildpacks builder metadata or stack label.");
  }
  const buildpacks: Record<string, string[]> = {};
  const listed = (JSON.parse(metadata) as { buildpacks?: { id?: unknown; version?: unknown }[] })
    .buildpacks;
  for (const { id, version } of listed ?? []) {
    if (typeof id !== "string" || typeof version !== "string") continue;
    const versions = buildpacks[id] ?? [];
    if (!versions.includes(version)) buildpacks[id] = [...versions, version];
  }
  return { stack, buildpacks };
}

/** The one version of buildpack `id` in the builder; throws when it lists none or several. */
export function buildpackVersion(builder: BuilderInfo, id: string): string {
  const versions = builder.buildpacks[id] ?? [];
  if (versions.length === 0) throw new Error(`The builder does not list ${id}.`);
  if (versions.length > 1) {
    throw new Error(`The builder lists several versions of ${id}: ${versions.join(", ")}.`);
  }
  return versions[0] as string;
}

/** The dependency buildpack, and the dependency in it, whose versions make each language's offer. */
export const OFFER_SOURCES: Record<OfferLanguage, { buildpack: string; dependency: string }> = {
  go: { buildpack: "paketo-buildpacks/go-dist", dependency: "go" },
  java: { buildpack: "paketo-buildpacks/bellsoft-liberica", dependency: "jdk" },
  dotnet: { buildpack: "paketo-buildpacks/dotnet-core-sdk", dependency: "dotnet-sdk" },
  ruby: { buildpack: "paketo-buildpacks/mri", dependency: "ruby" },
};

/** The `buildpack.toml` of a Paketo buildpack release (its id is its GitHub repository). */
export function buildpackTomlUrl(id: string, version: string): string {
  return `https://raw.githubusercontent.com/${id}/v${version}/buildpack.toml`;
}

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The versions of dependency `id` in a `buildpack.toml`'s `[[metadata.dependencies]]` that run on
 * `stack` (or on every stack, `*`), each once, oldest first. A dependency's keys come before any
 * sub-table, so every other table header ends it.
 */
export function dependencyVersions(toml: string, id: string, stack: string): string[] {
  const entries: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined;
  for (const line of toml.split(/\r?\n/).map((l) => l.trim())) {
    if (line.startsWith("[")) {
      current = line === "[[metadata.dependencies]]" ? {} : undefined;
      if (current) entries.push(current);
      continue;
    }
    const pair = current && /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    if (!current || !pair) continue;
    try {
      current[pair[1] as string] = JSON.parse(pair[2] as string);
    } catch {
      // Not a plain string or array of strings; no key OpsCrew reads.
    }
  }
  const versions = new Set<string>();
  for (const entry of entries) {
    const stacks = Array.isArray(entry.stacks) ? entry.stacks : ["*"];
    if (entry.id !== id || typeof entry.version !== "string") continue;
    if (stacks.includes(stack) || stacks.includes("*")) versions.add(entry.version);
  }
  if (versions.size === 0) throw new Error(`The buildpack lists no ${id} for ${stack}.`);
  return [...versions].sort(compareVersions);
}

/** Replaces the body of `BUILDPACKS_OFFERS` in the source of pins.ts with `offers`. */
export function replaceOffers(
  source: string,
  offers: Readonly<Record<OfferLanguage, readonly string[]>>,
): string {
  const start = source.indexOf("export const BUILDPACKS_OFFERS");
  const open = source.indexOf("= {", start);
  const close = source.indexOf("\n};", open);
  if (start < 0 || open < 0 || close < 0)
    throw new Error("pins.ts has no BUILDPACKS_OFFERS table.");
  const body = (Object.keys(OFFER_SOURCES) as OfferLanguage[])
    .map((language) => `  ${language}: ${JSON.stringify(offers[language]).replaceAll(",", ", ")},`)
    .join("\n");
  return `${source.slice(0, open)}= {\n${body}${source.slice(close)}`;
}

/** `source` with `change` applied to the text of `export const <table>` up to the next export. */
function inTable(source: string, table: string, change: (text: string) => string): string {
  const start = source.indexOf(`export const ${table} `);
  const end = source.indexOf("\nexport ", start + 1);
  if (start < 0 || end < 0) throw new Error(`pins.ts has no ${table} table.`);
  return `${source.slice(0, start)}${change(source.slice(start, end))}${source.slice(end)}`;
}

/** Sets `TOOLS[tool].sha256[arch]` in the source of pins.ts. */
export function setToolChecksum(
  source: string,
  tool: string,
  arch: PinArch,
  sha256: string,
): string {
  const pattern = new RegExp(`(\\b${escapeRegExp(tool)}: \\{[^}]*?\\b${arch}: )"[0-9a-f]*"`);
  return inTable(source, "TOOLS", (table) => {
    if (!pattern.test(table)) throw new Error(`pins.ts has no ${tool} ${arch} checksum in TOOLS.`);
    return table.replace(pattern, `$1"${sha256}"`);
  });
}

/** Where a package table of pins.ts is published. */
export type PackageRegistry = "pypi" | "npm";

/** The URL that answers with a package's newest release: PyPI's JSON API, or npm's `latest`. */
export function latestReleaseUrl(registry: PackageRegistry, name: string): string {
  return registry === "pypi"
    ? `https://pypi.org/pypi/${name}/json`
    : `https://registry.npmjs.org/${name}/latest`;
}

/**
 * The version in that answer (PyPI's `info.version`, npm's `version`); throws unless it is a
 * plain release such as `2.5.1`.
 */
export function latestReleaseVersion(registry: PackageRegistry, answer: unknown): string {
  const body = (answer ?? {}) as { info?: { version?: unknown }; version?: unknown };
  const version = registry === "pypi" ? body.info?.version : body.version;
  if (typeof version !== "string" || !/^\d+(?:\.\d+)*$/.test(version)) {
    throw new Error(`The ${registry} answer names no plain release: ${JSON.stringify(version)}`);
  }
  return version;
}

/** Sets `<table>.<name>` (a `name: "<version>",` line) in the source of pins.ts. */
export function setPackageVersion(
  source: string,
  table: string,
  name: string,
  version: string,
): string {
  const pattern = new RegExp(`(\\n {2}${escapeRegExp(name)}: )"[^"]*"`);
  return inTable(source, table, (text) => {
    if (!pattern.test(text)) throw new Error(`pins.ts has no ${name} in ${table}.`);
    return text.replace(pattern, `$1"${version}"`);
  });
}
