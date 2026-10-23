/**
 * Deterministic edits for the Cloudflare adapters of server-rendered apps (feature 016, T1611;
 * research.md "Spike results" 6): Astro's `@astrojs/cloudflare` with `adapter: cloudflare()`,
 * Next.js's `@opennextjs/cloudflare` with its `open-next.config.ts` (and `.open-next/` ignored),
 * Nuxt's `cloudflare_module` preset and SvelteKit's `@sveltejs/adapter-cloudflare`, each adapter
 * pinned to its newest release that supports the app's framework version, with `wrangler` beside
 * it. Careful text edits of the
 * shapes the frameworks' starters write; anything else is `manual`, for the Code-change agent or
 * the user.
 */
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { exists, listText, readTextIfExists } from "@opscrew/core";
import type { CloudflareFramework, NextWorkersOption, SiteDetection } from "@opscrew/detect";
import { TOOLS } from "@opscrew/iac-templates";
import { z } from "zod";
import { frameworkName } from "../analyze/summary";
import { under } from "../design/code-changes";
import { adapterRelease } from "./adapter-release";
import {
  commentEnd,
  insertProperties,
  normalized,
  preferredQuote,
  scanObject,
  stringEnd,
} from "./next-config";
import { lowestAllowed, versionText } from "./npm-range";

/** A file the edit writes (repo-relative). */
export interface EditedFile {
  path: string;
  content: string;
  created: boolean;
}

/** What to do for a change: write files, nothing (already done), or leave it to the agent/user. */
export type AdapterEdit =
  | {
      action: "write";
      files: EditedFile[];
      /** The file the change is made in, for the pull request. */
      path: string;
      /** True when package.json changed, so its lockfile needs updating. */
      packageJson: boolean;
      note: string;
    }
  | { action: "none"; reason: string }
  | { action: "manual"; reason: string };

const manual = (reason: string): AdapterEdit => ({ action: "manual", reason });

/** The npm package of each adapter, and the framework package its peer dependency names. */
const PACKAGES: Readonly<
  Record<Exclude<CloudflareFramework, "nuxt">, { adapter: string; framework: string }>
> = {
  astro: { adapter: "@astrojs/cloudflare", framework: "astro" },
  next: { adapter: "@opennextjs/cloudflare", framework: "next" },
  sveltekit: { adapter: "@sveltejs/adapter-cloudflare", framework: "@sveltejs/kit" },
};

/** The OpenNext config OpsCrew writes (never `opennextjs-cloudflare migrate`, which waits for a login). */
export const OPEN_NEXT_CONFIG = `import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
`;

const PackageJsonSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});
type Section = "dependencies" | "devDependencies";

/**
 * The index of the `)` closing the call whose `(` is at `open`, skipping strings and comments;
 * undefined when it cannot tell (an unterminated or multi-line string or comment).
 */
function closingParen(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const comment = commentEnd(text, i);
    if (comment !== undefined) {
      if (comment < 0) return undefined;
      i = comment - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(text, i);
      if (end < 0) return undefined;
      i = end;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : undefined;
    }
  }
  return undefined;
}

const escapeName = (name: string) => name.replace(/\$/g, "\\$");

/** `text` with the single call `name(…)` replaced by `name()`, or undefined unless there is one. */
function resetCall(text: string, name: string): string | undefined {
  const calls = [
    ...text.matchAll(new RegExp(String.raw`(?<![\w$.])${escapeName(name)}\s*\(`, "g")),
  ];
  const call = calls[0];
  if (calls.length !== 1 || call === undefined) return undefined;
  const open = call.index + call[0].length - 1;
  const close = closingParen(text, open);
  if (close === undefined) return undefined;
  return `${text.slice(0, call.index)}${name}()${text.slice(close + 1)}`;
}

/**
 * The default import of one of `packages` (`import node from '@astrojs/node';`), `once` when the
 * file uses its name just once more (the adapter call), outside comments and object keys.
 */
function importOf(text: string, packages: RegExp) {
  for (const match of text.matchAll(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"'\n]+)\2(;?)[ \t]*$/gm,
  )) {
    const [line, name, quote, from, semicolon] = match;
    if (!packages.test(from as string)) continue;
    const rest = `${text.slice(0, match.index)}${text.slice(match.index + line.length)}`
      // Comments, but not `//` in a URL string.
      .replace(/\/\*[\s\S]*?\*\/|(?<![:"'\\])\/\/[^\n]*/g, "");
    const uses = rest.match(
      new RegExp(String.raw`(?<![\w$.])${escapeName(name as string)}(?![\w$])(?!\s*:)`, "g"),
    );
    return {
      line,
      at: match.index,
      name: name as string,
      quote: quote as string,
      from: from as string,
      semicolon: semicolon as string,
      once: uses?.length === 1,
    };
  }
  return undefined;
}

/** `text` with `line` added before its first import (after leading comments when it has none). */
function addImport(text: string, line: string): string {
  const first = /^import\s/m.exec(text);
  const at = first?.index ?? text.match(/^(?:\/\/[^\n]*\n)*/)?.[0].length ?? 0;
  return `${text.slice(0, at)}${line}\n${first === null ? "\n" : ""}${text.slice(at)}`;
}

/** The config object passed to `fn({ … })`: its `{` and its scan, or why OpsCrew cannot edit it. */
function configObject(text: string, fn: string, name: string) {
  const call = new RegExp(String.raw`\b${fn}\(\s*\{`).exec(text);
  if (call === null) return `${name} does not call ${fn}({ … }) with a plain object.`;
  const open = call.index + call[0].length - 1;
  const scan = scanObject(text, open);
  return typeof scan === "string" ? `${name} ${scan}` : { open, ...scan };
}

/** A config edit: the new text, the package it replaced (to remove), and what it did. */
type ConfigEdit = { text: string; replaced?: string; did: string } | string;

/** Astro: `adapter: cloudflare()`, replacing the app's other adapter when it has one. */
function astroConfig(text: string, name: string): ConfigEdit {
  if (/(?<![\w$.])cloudflare(?![\w$])/.test(text)) {
    return `${name} already uses the name cloudflare, so OpsCrew did not add the adapter itself.`;
  }
  const other = importOf(text, /^@astrojs\/(?:node|vercel|netlify|deno)$/);
  if (other !== undefined) {
    const line = `import cloudflare from ${other.quote}@astrojs/cloudflare${other.quote}${other.semicolon}`;
    const imported = `${text.slice(0, other.at)}${line}${text.slice(other.at + other.line.length)}`;
    const reset = other.once ? resetCall(imported, other.name) : undefined;
    if (reset === undefined) {
      return `${name} does not call ${other.name}(…) exactly once, so OpsCrew did not replace ${other.from}.`;
    }
    const call = new RegExp(String.raw`(?<![\w$.])${escapeName(other.name)}\(\)`);
    return {
      text: reset.replace(call, () => "cloudflare()"),
      replaced: other.from,
      did: `set adapter: cloudflare() in ${name} in place of ${other.from}`,
    };
  }
  const found = configObject(text, "defineConfig", name);
  if (typeof found === "string") return found;
  if (found.keys.has("adapter")) {
    return `${name} sets an adapter OpsCrew does not replace itself.`;
  }
  const quote = preferredQuote(text);
  const edited = insertProperties(text, found.open, found.close, ["adapter: cloudflare()"]);
  return {
    text: addImport(edited, `import cloudflare from ${quote}@astrojs/cloudflare${quote};`),
    did: `set adapter: cloudflare() in ${name}`,
  };
}

/** Nuxt: `nitro: { preset: "cloudflare_module" }`. */
function nuxtConfig(text: string, name: string): ConfigEdit {
  const found = configObject(text, "defineNuxtConfig", name);
  if (typeof found === "string") return found;
  if (found.keys.has("nitro")) {
    return `${name} already has a nitro block; set nitro.preset to "cloudflare_module" in it.`;
  }
  const quote = preferredQuote(text.slice(found.open, found.close));
  return {
    text: insertProperties(text, found.open, found.close, [
      `nitro: { preset: ${quote}cloudflare_module${quote} }`,
    ]),
    did: `set Nitro's preset to cloudflare_module in ${name}`,
  };
}

/** SvelteKit: the app's adapter import pointed at `@sveltejs/adapter-cloudflare`, called with no options. */
function svelteConfig(text: string, name: string): ConfigEdit {
  const other = importOf(text, /^@sveltejs\/adapter-(?!cloudflare$)[\w-]+$/);
  if (other === undefined) return `${name} imports no SvelteKit adapter OpsCrew can replace.`;
  const line = `import ${other.name} from ${other.quote}@sveltejs/adapter-cloudflare${other.quote}${other.semicolon}`;
  const imported = `${text.slice(0, other.at)}${line}${text.slice(other.at + other.line.length)}`;
  const reset = other.once ? resetCall(imported, other.name) : undefined;
  if (reset === undefined) {
    return `${name} does not call ${other.name}(…) exactly once, so OpsCrew did not replace ${other.from}.`;
  }
  return {
    text: reset,
    replaced: other.from,
    did: `built the app with @sveltejs/adapter-cloudflare in ${name} in place of ${other.from}`,
  };
}

/** The SvelteKit config that imports the app's adapter: svelte.config.* or vite.config.*. */
async function svelteConfigPath(root: string, dir: string): Promise<string | undefined> {
  const names = [
    ...["js", "mjs", "ts"].map((ext) => `svelte.config.${ext}`),
    ...["ts", "js", "mjs", "mts"].map((ext) => `vite.config.${ext}`),
  ];
  for (const name of names) {
    const text = await readTextIfExists(join(root, under(dir, name)));
    if (text !== undefined && /from\s+["']@sveltejs\/adapter-/.test(text)) return under(dir, name);
  }
  return undefined;
}

/** package.json with `add` set and `remove` dropped, in its own indentation and key order. */
function editPackageJson(
  source: string,
  data: z.infer<typeof PackageJsonSchema>,
  add: readonly { name: string; version: string; section: Section }[],
  remove: readonly string[],
): string {
  const { text, restore } = normalized(source);
  const indent = text.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  // The file's own key order (`data` is validated, in the schema's order).
  const next = JSON.parse(text) as Record<string, unknown>;
  const sections: Section[] = ["dependencies", "devDependencies"];
  for (const section of sections) {
    const before = data[section];
    let entries = Object.entries(before ?? {}).filter(([name]) => !remove.includes(name));
    const added = add.filter((entry) => entry.section === section);
    if (before === undefined && added.length === 0) continue;
    const sorted = entries.every(([name], i) => i === 0 || (entries[i - 1]?.[0] ?? "") <= name);
    entries = [
      ...entries.filter(([name]) => !added.some((entry) => entry.name === name)),
      ...added.map((entry): [string, string] => [entry.name, entry.version]),
    ];
    if (sorted) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    next[section] = Object.fromEntries(entries);
  }
  const ending = text.endsWith("\n") ? "\n" : "";
  return restore(`${JSON.stringify(next, null, indent)}${ending}`);
}

/**
 * The edit that builds a server-rendered app with its Cloudflare adapter (`site.adapter`, not yet
 * installed), with the adapter's release read through `fetch`.
 */
export async function cloudflareAdapterEdit(
  root: string,
  site: SiteDetection,
  fetch: FetchLike,
): Promise<AdapterEdit> {
  const framework = site.adapter?.framework;
  if (framework === undefined) return manual("OpsCrew found no Cloudflare adapter for the app.");
  if (framework === "nuxt") {
    const config = await configEdit(root, site, framework);
    if (typeof config === "string") return manual(config);
    return {
      action: "write",
      files: [{ path: config.path, content: config.content, created: false }],
      path: config.path,
      packageJson: false,
      note: `OpsCrew ${config.did}.`,
    };
  }

  // The adapter's package, pinned to its newest release for the app's framework version.
  const packages = PACKAGES[framework];
  const packagePath = under(site.dir, "package.json");
  const source = await readTextIfExists(join(root, packagePath));
  const parsed = PackageJsonSchema.safeParse(source === undefined ? undefined : safeJson(source));
  if (source === undefined || !parsed.success) {
    return manual(`OpsCrew cannot read ${packagePath}.`);
  }
  const data = parsed.data;
  const section: Section =
    data.dependencies?.[packages.framework] !== undefined ? "dependencies" : "devDependencies";
  const spec = data[section]?.[packages.framework];
  const version = spec === undefined ? undefined : lowestAllowed(spec);
  if (version === undefined) {
    return manual(
      `${packagePath} gives ${packages.framework} ${spec === undefined ? "no version" : `as "${spec}"`}, so OpsCrew cannot tell which release of ${packages.adapter} supports it.`,
    );
  }
  const release = await adapterRelease(fetch, packages.adapter, packages.framework, version);
  if (!release.ok) return manual(release.reason);
  const app = `${packages.framework} ${versionText(version)}`;
  const pinned = `${packages.adapter} ${release.version}, its newest release for ${app}`;

  // Next.js needs no change to its own config for OpenNext; the others name their adapter there.
  const config = framework === "next" ? undefined : await configEdit(root, site, framework);
  if (typeof config === "string") return manual(`${config} Add ${pinned}.`);
  const files: EditedFile[] = [];
  if (config !== undefined)
    files.push({ path: config.path, content: config.content, created: false });

  const add = [{ name: packages.adapter, version: release.version, section }];
  // The adapters' builds need Wrangler in the project (spike result 6), whether or not the package
  // manager installs peer dependencies itself: the release the deploy job uses.
  const wrangler = TOOLS.wrangler.version;
  const withWrangler =
    data.dependencies?.wrangler === undefined && data.devDependencies?.wrangler === undefined;
  if (withWrangler) add.push({ name: "wrangler", version: wrangler, section: "devDependencies" });
  const replaced = config?.replaced;
  files.push({
    path: packagePath,
    content: editPackageJson(source, data, add, replaced === undefined ? [] : [replaced]),
    created: false,
  });
  const openNext = under(site.dir, "open-next.config.ts");
  const writeOpenNext = framework === "next" && !(await exists(join(root, openNext)));
  if (writeOpenNext) files.push({ path: openNext, content: OPEN_NEXT_CONFIG, created: true });
  // OpenNext's build output stays out of the repository.
  const gitignore = framework === "next" ? await ignoredOpenNext(root, site.dir) : undefined;
  if (gitignore !== undefined) files.push(gitignore);

  const newer =
    release.newer === undefined
      ? ""
      : ` (${release.newer.version} needs ${packages.framework} ${release.newer.range}: upgrade ${packages.framework} to move to it)`;
  const did = [
    `added ${pinned}${newer}`,
    ...(withWrangler ? [`wrangler ${wrangler} as a dev dependency`] : []),
    ...(config === undefined ? [] : [config.did]),
    ...(replaced === undefined ? [] : [`removed ${replaced} from ${packagePath}`]),
    ...(framework !== "next"
      ? []
      : [writeOpenNext ? `wrote ${openNext}` : `kept the app's ${openNext}`]),
    ...(gitignore === undefined ? [] : [`added .open-next/ to ${gitignore.path}`]),
  ];
  return {
    action: "write",
    files,
    path: config?.path ?? openNext,
    packageJson: true,
    note: `OpsCrew ${listText(did)}.`,
  };
}

/**
 * The adapter's change to the framework's config (Astro's, Nuxt's, or the SvelteKit config that
 * imports the adapter), or why OpsCrew cannot make it.
 */
async function configEdit(
  root: string,
  site: SiteDetection,
  framework: Exclude<CloudflareFramework, "next">,
): Promise<{ path: string; content: string; did: string; replaced?: string } | string> {
  const path = framework === "sveltekit" ? await svelteConfigPath(root, site.dir) : site.config;
  const source = path === undefined ? undefined : await readTextIfExists(join(root, path));
  if (path === undefined || source === undefined) {
    return `OpsCrew found no ${frameworkName(framework)} config for the app.`;
  }
  const { text, restore } = normalized(source);
  const name = path.split("/").at(-1) ?? path;
  const edit =
    framework === "astro"
      ? astroConfig(text, name)
      : framework === "nuxt"
        ? nuxtConfig(text, name)
        : svelteConfig(text, name);
  if (typeof edit === "string") return edit;
  return {
    path,
    content: restore(edit.text),
    did: edit.did,
    ...(edit.replaced === undefined ? {} : { replaced: edit.replaced }),
  };
}

/**
 * The app's `.gitignore` with `.open-next/` added (the file created when missing), or undefined
 * when it already ignores that folder.
 */
async function ignoredOpenNext(root: string, dir: string): Promise<EditedFile | undefined> {
  const path = under(dir, ".gitignore");
  const source = await readTextIfExists(join(root, path));
  if (source === undefined) return { path, content: ".open-next/\n", created: true };
  if (/^\/?\.open-next\/?[ \t]*\r?$/m.test(source)) return undefined;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const separator = source === "" || source.endsWith("\n") ? "" : eol;
  return { path, content: `${source}${separator}.open-next/${eol}`, created: false };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The edit that turns off `options` (Next.js's `cacheComponents`, `partialPrefetching`) where the
 * config at `path` sets them to `true`, keeping everything else.
 */
export async function nextWorkersOptionsEdit(
  root: string,
  path: string,
  options: readonly NextWorkersOption[],
): Promise<AdapterEdit> {
  const source = await readTextIfExists(join(root, path));
  if (source === undefined) return manual(`${path} does not exist.`);
  const name = path.split("/").at(-1) ?? path;
  const turnedOff: string[] = [];
  let content = source;
  for (const option of options) {
    const on = new RegExp(String.raw`\b(${option}\s*:\s*)true\b`, "g");
    if (!on.test(content)) continue;
    content = content.replace(on, (_all, key: string) => `${key}false`);
    turnedOff.push(option);
  }
  if (turnedOff.length === 0) {
    return { action: "none", reason: `${name} does not turn on ${listText(options)}.` };
  }
  return {
    action: "write",
    files: [{ path, content, created: false }],
    path,
    packageJson: false,
    note: `OpsCrew set ${listText(turnedOff.map((option) => `${option}: false`))} in ${name}, so server-rendered requests do not hang on Cloudflare's Workers.`,
  };
}
