/**
 * The site a server-less target publishes (feature 016): how the deploy job builds it (Node.js
 * with the app's package manager, Hugo, or nothing), the folder it publishes, the site's own
 * `_headers`, `_redirects` and 404 page, and for a framework that renders pages on the server its
 * Cloudflare adapter with the Worker module and compatibility flags the adapter's build gives
 * (research.md "Spike results" 6). Deterministic: it reads a few of the app's own files.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exists, stripBom } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { normalizeAppDir } from "./app-dir";
import { type JsPackageManager, jsExec, jsRun } from "./detect";
import { findDependency, readUnits, type Unit } from "./manifests";
import { basenameRel, dirnameRel, joinRel, relativeTo, toFsPath } from "./paths";

/** The frameworks whose Cloudflare adapter OpsCrew sets up for server rendering. */
export type CloudflareFramework = "astro" | "next" | "nuxt" | "sveltekit";

/** A framework's Cloudflare adapter, as the app's server rendering needs it. */
export interface CloudflareAdapter {
  framework: CloudflareFramework;
  /** The adapter's package, or for Nuxt Nitro's preset `cloudflare_module`. */
  name: string;
  /** True when the app already builds with it; otherwise `opscrew adapt` adds it. */
  installed: boolean;
  /** The Worker module the adapter's build writes, relative to the site's folder. */
  entry: string;
  /** The Cloudflare compatibility flags the adapter's Worker needs. */
  compatibilityFlags: readonly string[];
}

/** Next.js options that make every server-rendered request hang on Workers (spike result 6). */
export type NextWorkersOption = "cacheComponents" | "partialPrefetching";

/** What a server-less target needs to know to build and publish the app as a site. */
export interface SiteDetection {
  /** The repository folder the build runs in (`app.buildContext`). */
  dir: string;
  /** `node` and `hugo` build the site; `none`: its files are in the repository as they are. */
  tool: "node" | "hugo" | "none";
  /** With `node`: the package manager that installs and builds it. */
  packageManager?: JsPackageManager;
  /** The build command, run in `dir`; absent with `none`, or when package.json has no build. */
  command?: string;
  /** `ssr` when the framework renders pages on the server. */
  render: "static" | "ssr";
  /** Detection's name of the framework (`astro`, `next`, `hugo` …); absent with `none`. */
  framework?: string;
  /** The framework's config file (repo-relative), for a server-rendered app that has one. */
  config?: string;
  /**
   * The folder the target publishes, relative to `dir`; absent when it cannot be told: the
   * framework has no Cloudflare adapter OpsCrew sets up, or the files with no build sit at the
   * repository root, which is never published.
   */
  outputDir?: string;
  /** Server rendering with Astro, Next.js, Nuxt or SvelteKit: their Cloudflare adapter. */
  adapter?: CloudflareAdapter;
  /** A single-page app: every path that is no file gets the app itself. */
  spa: boolean;
  /** The site's own `_headers`, `_redirects` and 404 page (repo-relative), where it has them. */
  headers?: string;
  redirects?: string;
  notFoundPage?: string;
  /** Next.js: the options its config turns on that must be off on Workers. */
  nextOptions?: NextWorkersOption[];
  /** What in the app needs a server process that keeps running, in words; empty when nothing. */
  serverNeeds: string[];
}

/** The Cloudflare adapters' builds (spike result 6): output folder, Worker module, flags. */
const ADAPTERS: Readonly<
  Record<
    CloudflareFramework,
    Omit<CloudflareAdapter, "framework" | "installed"> & { outputDir: string }
  >
> = {
  astro: {
    name: "@astrojs/cloudflare",
    outputDir: "dist/client",
    entry: "dist/server/entry.mjs",
    compatibilityFlags: [],
  },
  next: {
    name: "@opennextjs/cloudflare",
    outputDir: ".open-next/assets",
    entry: ".open-next/worker.js",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  },
  nuxt: {
    name: "cloudflare_module",
    outputDir: ".output/public",
    entry: ".output/server/index.mjs",
    compatibilityFlags: ["nodejs_compat"],
  },
  sveltekit: {
    name: "@sveltejs/adapter-cloudflare",
    outputDir: ".svelte-kit/cloudflare",
    entry: ".svelte-kit/cloudflare/_worker.js",
    compatibilityFlags: [],
  },
};

/** Server-rendering frameworks, the first one found naming the app's. */
const SSR_FRAMEWORKS = ["next", "nuxt", "sveltekit", "astro", "remix", "react-router"] as const;

/** Frameworks of a single-page app, unless a site framework builds it. */
const SPA_FRAMEWORKS = ["vite", "create-react-app", "angular"] as const;

/**
 * True for a framework whose Cloudflare adapter OpsCrew sets up ({@link ADAPTERS}): one that builds
 * a site of pages, which names a static site before a single-page app's build tool.
 */
function hasAdapter(name: string): name is CloudflareFramework {
  return Object.hasOwn(ADAPTERS, name);
}

/** Nitro's preset for Workers, in Nuxt's config or the build script's environment. */
const NITRO_CLOUDFLARE =
  /\bpreset\s*:\s*["'`]cloudflare[-_]module["'`]|NITRO_PRESET=cloudflare[-_]module\b/;

const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cjs"] as const;

/** Hugo's own config files; `config.*` counts only next to a `content/` folder. */
const HUGO_CONFIGS = ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"] as const;
const LEGACY_HUGO_CONFIGS = ["config.toml", "config.yaml", "config.yml", "config.json"] as const;

/** Hugo's publishDir in TOML, YAML or JSON. */
const PUBLISH_DIR = /^\s*["']?publishDir["']?\s*[=:]\s*["']?([^"'\s,#}]+)/m;

/** Folders that hold a site with no build, below the app's folder, in order. */
const NO_BUILD_FOLDERS = ["public", "docs", "site", "www"] as const;

/** Source files of a 404 page, relative to the site's folder, beside `404.html` itself. */
const NOT_FOUND_SOURCES = [
  "layouts/404.html",
  ...["astro", "md", "mdx"].map((ext) => `src/pages/404.${ext}`),
  ...["app", "src/app"].flatMap((dir) =>
    ["tsx", "jsx", "ts", "js"].map((ext) => `${dir}/not-found.${ext}`),
  ),
  ...["pages", "src/pages"].flatMap((dir) =>
    ["tsx", "jsx", "ts", "js"].map((ext) => `${dir}/404.${ext}`),
  ),
] as const;

/** Reads and checks repository files below `root`. */
interface Repository {
  read: (path: string) => Promise<string | undefined>;
  has: (path: string) => Promise<boolean>;
  /** The first of `paths` that exists. */
  first: (paths: readonly string[]) => Promise<string | undefined>;
}

function repository(root: string): Repository {
  const has = (path: string) => exists(toFsPath(root, path));
  return {
    read: async (path) => {
      try {
        return stripBom(await readFile(toFsPath(root, path), "utf8"));
      } catch {
        return undefined;
      }
    },
    has,
    first: async (paths) => {
      for (const path of paths) if (await has(path)) return path;
      return undefined;
    },
  };
}

/**
 * The app as a site for the server-less targets, from its `facts` and a few of its files below
 * `root`: a static or server-rendered app with a package.json, a Hugo site, or a folder holding an
 * `index.html` with no package.json. `undefined` when the app is no site (an API, a worker, or
 * nothing OpsCrew can build or publish).
 */
export async function detectSite(
  root: string,
  facts: ProjectFacts,
): Promise<SiteDetection | undefined> {
  const repo = repository(resolve(root));
  const dir = normalizeAppDir(facts.appDir);
  const serverNeeds = serverNeedsOf(facts);
  const [unit] = await readUnits([joinRel(dir, "package.json")], repo.read);
  const pkg = unit?.packageJson === undefined ? undefined : unit;
  if (facts.appKind === "unknown") {
    const hugo = await hugoSite(repo, dir, serverNeeds);
    if (hugo !== undefined || pkg !== undefined) return hugo;
    return noBuildSite(repo, dir, serverNeeds);
  }
  if (pkg === undefined || (facts.appKind !== "static-spa" && facts.appKind !== "ssr")) {
    return undefined;
  }
  return nodeSite(repo, facts, pkg, serverNeeds);
}

/** The site's own `_headers`, `_redirects` and 404 page, in the first of `folders` that has each. */
async function ownFiles(
  repo: Repository,
  folders: readonly string[],
  sources: readonly string[],
): Promise<Pick<SiteDetection, "headers" | "redirects" | "notFoundPage">> {
  const inFolders = (name: string) => folders.map((folder) => joinRel(folder, name));
  const headers = await repo.first(inFolders("_headers"));
  const redirects = await repo.first(inFolders("_redirects"));
  const notFoundPage = await repo.first([...inFolders("404.html"), ...sources]);
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(redirects === undefined ? {} : { redirects }),
    ...(notFoundPage === undefined ? {} : { notFoundPage }),
  };
}

/** A site built with Node.js: static, or server-rendered with its Cloudflare adapter. */
async function nodeSite(
  repo: Repository,
  facts: ProjectFacts,
  unit: Unit,
  serverNeeds: string[],
): Promise<SiteDetection> {
  const dir = unit.dir;
  const names = new Set(facts.frameworks.filter((f) => f.path === dir).map((f) => f.name));
  const pm: JsPackageManager =
    facts.packageManager === "pnpm" ||
    facts.packageManager === "yarn" ||
    facts.packageManager === "bun"
      ? facts.packageManager
      : "npm";
  const build = unit.packageJson?.scripts.build;
  const ssrFramework = SSR_FRAMEWORKS.find((name) => names.has(name));
  const has = (name: string) => findDependency(unit, "npm", name) !== undefined;
  const generated = ssrFramework === "nuxt" && /\bnuxt\s+generate\b/.test(build ?? "");
  const staticKit = ssrFramework === "sveltekit" && has("@sveltejs/adapter-static");
  const render = facts.appKind === "ssr" && !generated && !staticKit ? "ssr" : "static";
  const siteFramework = [...names].find(hasAdapter);
  const framework =
    render === "ssr"
      ? ssrFramework
      : (siteFramework ?? SPA_FRAMEWORKS.find((name) => names.has(name)) ?? [...names][0]);
  const configFor = (name: string) =>
    repo.first(CONFIG_EXTENSIONS.map((ext) => joinRel(dir, `${name}.config.${ext}`)));
  const nextConfig = names.has("next") ? await configFor("next") : undefined;
  const nextText = nextConfig === undefined ? undefined : await repo.read(nextConfig);
  const nextOptions = (["cacheComponents", "partialPrefetching"] as const).filter((option) =>
    new RegExp(`\\b${option}\\s*:\\s*true\\b`).test(nextText ?? ""),
  );

  let outputDir: string | undefined;
  let adapter: CloudflareAdapter | undefined;
  let config: string | undefined;
  if (render === "ssr") {
    const supported =
      ssrFramework !== undefined && hasAdapter(ssrFramework) ? ssrFramework : undefined;
    config =
      ssrFramework === undefined
        ? undefined
        : await configFor(ssrFramework === "sveltekit" ? "svelte" : ssrFramework);
    if (supported !== undefined) {
      const { outputDir: output, ...spec } = ADAPTERS[supported];
      const configText = config === undefined ? undefined : await repo.read(config);
      const installed =
        supported === "nuxt"
          ? NITRO_CLOUDFLARE.test(`${configText ?? ""} ${build ?? ""}`)
          : has(spec.name);
      outputDir = output;
      adapter = { framework: supported, ...spec, installed };
    }
  } else if (generated) {
    outputDir = ".output/public";
  } else if (staticKit) {
    outputDir = "build";
  } else if (facts.build.outputDir !== undefined) {
    outputDir = relativeTo(dir, facts.build.outputDir);
  }
  const command =
    render === "ssr" && ssrFramework === "next"
      ? `${jsExec(pm)} opennextjs-cloudflare build --skipWranglerConfigCheck`
      : build === undefined
        ? undefined
        : jsRun(pm, "build");
  const spa =
    render === "static" &&
    siteFramework === undefined &&
    SPA_FRAMEWORKS.some((name) => names.has(name));
  return {
    dir,
    tool: "node",
    packageManager: pm,
    ...(command === undefined ? {} : { command }),
    render,
    ...(framework === undefined ? {} : { framework }),
    ...(config === undefined ? {} : { config }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(adapter === undefined ? {} : { adapter }),
    spa,
    ...(await ownFiles(
      repo,
      [joinRel(dir, "public"), joinRel(dir, "static"), dir],
      NOT_FOUND_SOURCES.map((source) => joinRel(dir, source)),
    )),
    ...(nextOptions.length > 0 ? { nextOptions } : {}),
    serverNeeds,
  };
}

/** The Hugo config of a site in `dir` (repo-relative), when `dir` holds one; `has` tells what exists. */
async function hugoConfig(
  has: (path: string) => Promise<boolean>,
  dir: string,
): Promise<string | undefined> {
  const first = async (names: readonly string[]) => {
    for (const name of names) if (await has(joinRel(dir, name))) return joinRel(dir, name);
    return undefined;
  };
  return (
    (await first(HUGO_CONFIGS)) ??
    ((await has(joinRel(dir, "content"))) ? await first(LEGACY_HUGO_CONFIGS) : undefined)
  );
}

/**
 * The folders below the repository root that hold a site of their own without a manifest (a Hugo
 * site), among the repository's `files` (repo-relative). They are app folders like a manifest's.
 */
export async function manifestlessSiteDirs(files: readonly string[]): Promise<string[]> {
  const fileSet = new Set(files);
  const has = async (path: string) =>
    fileSet.has(path) || files.some((file) => file.startsWith(`${path}/`));
  const configNames = new Set<string>([...HUGO_CONFIGS, ...LEGACY_HUGO_CONFIGS]);
  const dirs = new Set(files.filter((file) => configNames.has(basenameRel(file))).map(dirnameRel));
  dirs.delete(".");
  const sites: string[] = [];
  for (const dir of dirs) if ((await hugoConfig(has, dir)) !== undefined) sites.push(dir);
  return sites;
}

/** A Hugo site in `dir`: its config, `hugo --minify`, and its publishDir (default `public`). */
async function hugoSite(
  repo: Repository,
  dir: string,
  serverNeeds: string[],
): Promise<SiteDetection | undefined> {
  const config = await hugoConfig(repo.has, dir);
  if (config === undefined) return undefined;
  const publishDir = PUBLISH_DIR.exec((await repo.read(config)) ?? "")?.[1] ?? "public";
  return {
    dir,
    tool: "hugo",
    command: "hugo --minify",
    render: "static",
    framework: "hugo",
    outputDir: normalizeAppDir(publishDir),
    spa: false,
    ...(await ownFiles(repo, [joinRel(dir, "static")], [joinRel(dir, "layouts/404.html")])),
    serverNeeds,
  };
}

/**
 * A site with no build: the folder that holds its `index.html`, the app's own folder or one of
 * {@link NO_BUILD_FOLDERS} below it, built from the repository root. An `index.html` at the
 * repository root is a site with no folder to publish (`outputDir` absent): publishing the root
 * would publish the whole repository.
 */
async function noBuildSite(
  repo: Repository,
  dir: string,
  serverNeeds: string[],
): Promise<SiteDetection | undefined> {
  const holds = (folder: string) => repo.has(joinRel(folder, "index.html"));
  const atRoot = dir === "." && (await holds("."));
  let folder: string | undefined;
  if (!atRoot) {
    for (const candidate of [dir, ...NO_BUILD_FOLDERS.map((name) => joinRel(dir, name))]) {
      if (candidate !== "." && (await holds(candidate))) {
        folder = candidate;
        break;
      }
    }
    if (folder === undefined) return undefined;
  }
  return {
    dir: ".",
    tool: "none",
    render: "static",
    ...(folder === undefined ? {} : { outputDir: folder }),
    spa: false,
    ...(folder === undefined ? {} : await ownFiles(repo, [folder], [])),
    serverNeeds,
  };
}

/**
 * What the facts show needs a server process that keeps running: WebSockets held open,
 * background workers or work through a queue, and a scheduler in the app's own process.
 */
function serverNeedsOf(facts: ProjectFacts): string[] {
  const via = (kind: string) => {
    const service = facts.services.find((s) => s.kind === kind);
    return service?.evidence.map((evidence) => evidence.replace(/^dependency:/, "")).join(", ");
  };
  const needs: string[] = [];
  const websocket = via("websocket");
  if (websocket !== undefined) needs.push(`WebSockets held open (${websocket})`);
  const queue = via("queue");
  if (facts.workers !== undefined) {
    needs.push(`background workers (${facts.workers.map((w) => w.name).join(", ")})`);
  } else if (queue !== undefined) {
    needs.push(`background work through a queue (${queue})`);
  }
  const scheduler = via("cron");
  if (scheduler !== undefined) needs.push(`a scheduler in the app's process (${scheduler})`);
  return needs;
}
