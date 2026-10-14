/**
 * Health routes for file-routed frameworks: one new file in the framework's routing folder
 * (Nuxt, SvelteKit, Astro, Remix, React Router, SolidStart), plus the entry in `app/routes.ts`
 * for React Router's config routes. Next.js keeps its own module (`../health-route`).
 */
import { nextHealthRoute } from "../health-route";
import { appFolder, packageDependencies, under } from "./common";
import { jsImports, jsStyle, scanJs, usesSemicolons } from "./js";
import { appendElement, applyInsertions, escapeRegExp, type Insertion } from "./text";
import {
  createdNote,
  existsReason,
  type HealthEdit,
  type HealthRouteInput,
  manual,
  movedPathNote,
  PLAN_PATH_FIX,
  protectCheck,
} from "./types";

const DOC = "/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */";

/** How new files are written: the style of an existing file of the app. */
interface FileStyle {
  q: (value: string) => string;
  s: string;
  u: string;
  ext: "ts" | "js";
}

/** Context shared by the file-routed frameworks. */
interface FileContext {
  input: HealthRouteInput;
  dir: string;
  /** `health` for `/health`, `api/health` for `/api/health`. */
  route: string;
  segments: string[];
  at: (path: string) => string;
  /** The first of `names` (app-relative) that exists, app-relative. */
  first: (names: readonly string[]) => Promise<string | undefined>;
  read: (name: string) => Promise<string | undefined>;
}

const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cjs"];

/** `name.ts`, `name.mts`, `name.js` … */
function configNames(stem: string): string[] {
  return CONFIG_EXTENSIONS.map((ext) => `${stem}.${ext}`);
}

/** The style for a new file, from the first sample file that exists. */
async function styleOf(ctx: FileContext, samples: readonly string[]): Promise<FileStyle> {
  const ext = (await ctx.input.repo.exists(ctx.at("tsconfig.json"))) ? "ts" : "js";
  for (const sample of samples) {
    const text = await ctx.read(sample);
    if (text === undefined || text.trim() === "") continue;
    const src = scanJs(text);
    const style = jsStyle(src, usesSemicolons(src));
    return {
      q: (value) => `${style.quote}${value}${style.quote}`,
      s: style.semi,
      u: style.unit,
      ext,
    };
  }
  return { q: (value) => `"${value}"`, s: ";", u: "  ", ext };
}

/** A string option in a config file (`base: "/docs"`), `unknown` when it is not a literal. */
function configString(
  text: string | undefined,
  key: string,
): { kind: "none" } | { kind: "literal"; value: string } | { kind: "unknown" } {
  if (text === undefined) return { kind: "none" };
  const code = scanJs(text).code;
  const at = new RegExp(`\\b${key}\\s*:`).exec(code);
  if (at === null) return { kind: "none" };
  const literal = new RegExp(`^\\b${key}\\s*:\\s*(["'\`])([^"'\`]*)\\1`).exec(text.slice(at.index));
  if (literal?.[2] === undefined) return { kind: "unknown" };
  return { kind: "literal", value: literal[2] };
}

/** The note for a base path set in `config`, if any. */
function basePathNote(
  ctx: FileContext,
  config: string | undefined,
  text: string | undefined,
  key: string,
): string | undefined {
  const option = configString(text, key);
  if (option.kind === "none" || config === undefined) return undefined;
  const healthPath = ctx.input.healthPath;
  if (option.kind === "unknown") {
    return `${ctx.at(config)} sets ${key} in a way OpsCrew cannot read: if it sets one, the health route answers at <${key}>${healthPath} and the plan's health check path must be that (${PLAN_PATH_FIX}), or every deploy fails its health check.`;
  }
  const base = option.value.replace(/\/+$/, "");
  if (base === "") return undefined;
  const prefixed = `${base.startsWith("/") ? "" : "/"}${base}${healthPath}`;
  return movedPathNote(`${ctx.at(config)} sets ${key} "${option.value}"`, prefixed, healthPath);
}

/** The edit that creates `path` (app-relative). */
function created(
  ctx: FileContext,
  framework: string,
  path: string,
  content: string,
  extra: { checks?: string[]; pathNote?: string | undefined } = {},
): HealthEdit {
  const file = ctx.at(path);
  return {
    action: "write",
    framework,
    files: [{ path: file, content, created: true }],
    path: file,
    note: createdNote(file, ctx.input.healthPath),
    checks: extra.checks ?? [],
    ...(extra.pathNote === undefined ? {} : { pathNote: extra.pathNote }),
  };
}

/** An existing route file answers the path. */
function exists(ctx: FileContext, path: string, pathNote?: string): HealthEdit {
  return {
    action: "none",
    reason: existsReason(ctx.at(path), ctx.input.healthPath),
    ...(pathNote === undefined ? {} : { pathNote }),
  };
}

/** A page (not an endpoint) already uses the path. */
function taken(ctx: FileContext, path: string): HealthEdit {
  return manual(
    `${ctx.at(path)} already uses ${ctx.input.healthPath} for a page, so OpsCrew did not add an endpoint there.`,
  );
}

/** The checks for files (app-relative) that might protect the path, when they exist. */
async function protectChecks(ctx: FileContext, names: readonly string[]): Promise<string[]> {
  const found = await ctx.first(names);
  return found === undefined ? [] : [protectCheck(ctx.at(found), ctx.input.healthPath)];
}

/** A JSON response that type-checks on every TypeScript version (no `Response.json`). */
function jsonResponse(style: FileStyle, name: string, lead: string[] = []): string {
  const { q, s, u } = style;
  return [
    ...lead,
    DOC,
    `export function ${name}() {`,
    `${u}const headers = { ${q("Content-Type")}: ${q("application/json")} }${s}`,
    `${u}return new Response(JSON.stringify({ status: ${q("ok")} }), { headers })${s}`,
    "}",
    "",
  ].join("\n");
}

/** Every `<base>.<ext>` for the extensions. */
function withExtensions(base: string, extensions: readonly string[]): string[] {
  return extensions.map((ext) => `${base}.${ext}`);
}

/** The first file under `root` that answers `segments` through route groups `(name)`. */
async function inGroups(
  ctx: FileContext,
  root: string,
  segments: readonly string[],
  leaves: readonly string[],
): Promise<string | undefined> {
  const walk = async (
    dir: string,
    rest: readonly string[],
    depth: number,
  ): Promise<string | undefined> => {
    if (rest.length === 0) {
      for (const leaf of leaves) {
        if (await ctx.input.repo.exists(ctx.at(`${dir}/${leaf}`))) return `${dir}/${leaf}`;
      }
    }
    if (depth >= 8) return undefined;
    for (const child of await ctx.input.repo.folders(ctx.at(dir))) {
      if (child === "node_modules" || child.startsWith(".")) continue;
      const next = /^\([^()]+\)$/.test(child)
        ? rest
        : child === rest[0]
          ? rest.slice(1)
          : undefined;
      if (next === undefined) continue;
      const found = await walk(`${dir}/${child}`, next, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root, segments, 0);
}

/** Nuxt: `server/routes/<path>.ts` with `defineEventHandler` (auto-imported by Nuxt). */
async function nuxt(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first(configNames("nuxt.config"));
  const text = config === undefined ? undefined : await ctx.read(config);
  if (text !== undefined && /\b(?:srcDir|serverDir)\s*:/.test(scanJs(text).code)) {
    return manual(
      `${ctx.at(config as string)} moves the server folder (srcDir or serverDir), so OpsCrew cannot tell where server routes live.`,
    );
  }
  const pathNote = basePathNote(ctx, config, text, "baseURL");
  const bases = [`server/routes/${ctx.route}`];
  if (ctx.segments[0] === "api" && ctx.segments.length > 1) {
    bases.push(`server/api/${ctx.segments.slice(1).join("/")}`);
  }
  for (const base of bases) {
    for (const stem of [base, `${base}.get`, `${base}/index`, `${base}/index.get`]) {
      const found = await ctx.first(withExtensions(stem, ["ts", "js", "mjs"]));
      if (found !== undefined) return exists(ctx, found, pathNote);
    }
  }
  const style = await styleOf(ctx, [config ?? "nuxt.config.ts"]);
  const content = [
    DOC,
    `export default defineEventHandler(() => ({ status: ${style.q("ok")} }))${style.s}`,
    "",
  ].join("\n");
  return created(ctx, "Nuxt", `server/routes/${ctx.route}.${style.ext}`, content, {
    checks: (await ctx.input.repo.exists(ctx.at("server/middleware")))
      ? [protectCheck(ctx.at("server/middleware/"), ctx.input.healthPath)]
      : [],
    pathNote,
  });
}

/** SvelteKit: `src/routes/<path>/+server.ts` with `json()`. */
async function sveltekit(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first(configNames("svelte.config"));
  const text = config === undefined ? undefined : await ctx.read(config);
  if (text !== undefined && /\bfiles\s*:\s*\{[^}]*\broutes\s*:/s.test(scanJs(text).code)) {
    return manual(
      `${ctx.at(config as string)} moves the routes folder, so OpsCrew cannot tell where routes live.`,
    );
  }
  const pathNote = basePathNote(ctx, config, text, "base");
  const endpoint = await inGroups(ctx, "src/routes", ctx.segments, ["+server.ts", "+server.js"]);
  if (endpoint !== undefined) return exists(ctx, endpoint, pathNote);
  const page = await inGroups(ctx, "src/routes", ctx.segments, [
    "+page.svelte",
    "+page.ts",
    "+page.js",
    "+page.server.ts",
    "+page.server.js",
  ]);
  if (page !== undefined) return taken(ctx, page);
  const style = await styleOf(ctx, [
    config ?? "svelte.config.js",
    "vite.config.ts",
    "vite.config.js",
  ]);
  const { q, s, u } = style;
  const content = [
    `import { json } from ${q("@sveltejs/kit")}${s}`,
    "",
    DOC,
    "export function GET() {",
    `${u}return json({ status: ${q("ok")} })${s}`,
    "}",
    "",
  ].join("\n");
  return created(ctx, "SvelteKit", `src/routes/${ctx.route}/+server.${style.ext}`, content, {
    checks: await protectChecks(ctx, ["src/hooks.server.ts", "src/hooks.server.js"]),
    pathNote,
  });
}

/** Astro: `src/pages/<path>.ts`, rendered on request (`prerender = false`). */
async function astro(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first(configNames("astro.config"));
  const text = config === undefined ? undefined : await ctx.read(config);
  const code = text === undefined ? "" : scanJs(text).code;
  const server =
    /\badapter\s*:/.test(code) || /\boutput\s*:\s*["'](?:server|hybrid)["']/.test(text ?? "");
  if (!server) {
    return manual(
      "the Astro site builds static files (no server output or adapter in astro.config), so there is no server to add a health route to.",
    );
  }
  if (/\bsrcDir\s*:/.test(code)) {
    return manual(
      `${ctx.at(config as string)} moves the source folder (srcDir), so OpsCrew cannot tell where pages live.`,
    );
  }
  const pathNote = basePathNote(ctx, config, text, "base");
  const base = `src/pages/${ctx.route}`;
  const endpoint = await ctx.first([
    ...withExtensions(base, ["ts", "js", "mjs"]),
    ...withExtensions(`${base}/index`, ["ts", "js", "mjs"]),
  ]);
  if (endpoint !== undefined) return exists(ctx, endpoint, pathNote);
  const page = await ctx.first([
    ...withExtensions(base, ["astro", "md", "mdx", "html"]),
    ...withExtensions(`${base}/index`, ["astro", "md", "mdx", "html"]),
  ]);
  if (page !== undefined) return taken(ctx, page);
  const style = await styleOf(ctx, [config as string]);
  const content = jsonResponse(style, "GET", [
    "// Rendered on every request, never prerendered at build time.",
    `export const prerender = false${style.s}`,
    "",
  ]);
  return created(ctx, "Astro", `${base}.${style.ext}`, content, {
    checks: await protectChecks(ctx, [
      "src/middleware.ts",
      "src/middleware.js",
      "src/middleware/index.ts",
      "src/middleware/index.js",
    ]),
    pathNote,
  });
}

const ROUTE_EXTENSIONS = ["ts", "js", "tsx", "jsx"];

/** An existing route module for `name` under `app/routes` (flat or folder form). */
async function routeModule(
  ctx: FileContext,
  names: readonly string[],
): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(
      ...withExtensions(`app/routes/${name}`, ROUTE_EXTENSIONS),
      ...withExtensions(`app/routes/${name}/route`, ROUTE_EXTENSIONS),
      ...withExtensions(`app/routes/${name}/index`, ROUTE_EXTENSIONS),
      ...withExtensions(`app/routes/${name}._index`, ROUTE_EXTENSIONS),
    );
  }
  return ctx.first(candidates);
}

/** An existing module: an endpoint (`.ts`/`.js`) answers, a component (`.tsx`/`.jsx`) is a page. */
function existing(ctx: FileContext, found: string, pathNote?: string): HealthEdit {
  return /\.[jt]sx$/.test(found) ? taken(ctx, found) : exists(ctx, found, pathNote);
}

/** Remix: a resource route `app/routes/<path>.ts` (flat routes; folders with Remix v1). */
async function remix(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first([...configNames("remix.config"), ...configNames("vite.config")]);
  const text = config === undefined ? undefined : await ctx.read(config);
  const code = text === undefined ? "" : scanJs(text).code;
  if (/\bappDirectory\s*:/.test(code)) {
    return manual(
      `${ctx.at(config as string)} moves the app folder (appDirectory), so OpsCrew cannot tell where routes live.`,
    );
  }
  if (/\bignoredRouteFiles\s*:\s*\[\s*["']\*\*\/\*["']/.test(text ?? "")) {
    return manual(
      `${ctx.at(config as string)} ignores every route file and defines routes in code, so OpsCrew cannot add one by file.`,
    );
  }
  const deps = await packageDependencies(ctx.input.repo, ctx.input.facts);
  const version = [...deps].find(([name]) => name.startsWith("@remix-run/"))?.[1] ?? "";
  const v1 = /^[~^]?1\./.test(version);
  if (v1 && ctx.segments.length > 1) {
    return manual(
      `the app uses Remix 1, and OpsCrew only adds one-segment routes for it, not ${ctx.input.healthPath}.`,
    );
  }
  const flat = ctx.segments.join(".");
  const found = await routeModule(ctx, [flat, ctx.segments.join("/")]);
  if (found !== undefined) return existing(ctx, found);
  const style = await styleOf(ctx, [config ?? "vite.config.ts", "app/root.tsx", "app/root.jsx"]);
  return created(ctx, "Remix", `app/routes/${flat}.${style.ext}`, jsonResponse(style, "loader"));
}

/**
 * React Router (framework mode): a resource route `app/routes/<path>.ts`, and its
 * `route("<path>", "routes/<path>.ts")` entry in `app/routes.ts` unless the routes come from the
 * file system (`flatRoutes()`).
 */
async function reactRouter(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first(configNames("react-router.config"));
  const configText = config === undefined ? undefined : await ctx.read(config);
  const configCode = configText === undefined ? "" : scanJs(configText).code;
  if (/\bappDirectory\s*:/.test(configCode)) {
    return manual(
      `${ctx.at(config as string)} moves the app folder (appDirectory), so OpsCrew cannot tell where routes live.`,
    );
  }
  if (/\bssr\s*:\s*false\b/.test(configCode)) {
    return manual(
      `${ctx.at(config as string)} turns server rendering off (ssr: false), so there is no server to add a health route to.`,
    );
  }
  const pathNote = basePathNote(ctx, config, configText, "basename");
  const routesFile = await ctx.first([
    "app/routes.ts",
    "app/routes.mts",
    "app/routes.js",
    "app/routes.mjs",
  ]);
  if (routesFile === undefined) {
    return manual(
      "the app has no app/routes.ts, so OpsCrew cannot tell how React Router finds its routes.",
    );
  }
  const routesText = (await ctx.read(routesFile)) as string;
  const routesSrc = scanJs(routesText);
  const flat = ctx.segments.join(".");
  const style = await styleOf(ctx, [routesFile]);
  const file = `app/routes/${flat}.${style.ext}`;
  const content = jsonResponse(style, "loader");
  if (/\bflatRoutes\s*\(/.test(routesSrc.code)) {
    const found = await routeModule(ctx, [flat]);
    if (found !== undefined) return existing(ctx, found, pathNote);
    return created(ctx, "React Router", file, content, { pathNote });
  }
  const registered = new RegExp(`\\broute\\(\\s*(["'\`])/?${escapeRegExp(ctx.route)}/?\\1`).exec(
    routesText,
  );
  if (registered !== null && routesSrc.code[registered.index] === "r") {
    return {
      action: "none",
      reason: existsReason(ctx.at(routesFile), ctx.input.healthPath),
      ...(pathNote === undefined ? {} : { pathNote }),
    };
  }
  const found = await routeModule(ctx, [flat]);
  if (found !== undefined) {
    return manual(
      `${ctx.at(found)} exists but ${ctx.at(routesFile)} does not register it, so OpsCrew did not touch either.`,
    );
  }
  const exported = /\bexport\s+default\s+\[/.exec(routesSrc.code);
  if (exported === null) {
    return manual(
      `${ctx.at(routesFile)} does not export a plain list of routes, so OpsCrew cannot add one to it.`,
    );
  }
  const imports = jsImports(routesSrc);
  const helpers = imports.find((entry) => entry.module === "@react-router/dev/routes");
  const insertions: Insertion[] = [];
  let route = [...(helpers?.bindings ?? [])].find(([, what]) => what === "route")?.[0];
  if (route === undefined) {
    route = "route";
    if (/\broute\b/.test(routesSrc.code)) {
      return manual(`${ctx.at(routesFile)} already uses the name route for something else.`);
    }
    if (helpers?.named !== undefined) {
      const inner = routesSrc.code.slice(helpers.named.open + 1, helpers.named.close);
      const end = helpers.named.open + 1 + inner.trimEnd().length;
      const comma = routesSrc.code[end - 1] === ",";
      insertions.push({ offset: end, text: comma ? " route" : ", route" });
    } else {
      const { q, s } = style;
      insertions.push({
        offset: 0,
        text: `import { route } from ${q("@react-router/dev/routes")}${s}\n`,
      });
    }
  }
  const open = exported.index + exported[0].length - 1;
  const entry = appendElement(
    routesText,
    routesSrc.code,
    open,
    `${route}(${style.q(ctx.route)}, ${style.q(`routes/${flat}.${style.ext}`)})`,
  );
  if (entry === undefined) return manual(`the route list in ${ctx.at(routesFile)} is not closed.`);
  insertions.push(...entry);
  const edit = created(ctx, "React Router", file, content, { pathNote });
  if (edit.action !== "write") return edit;
  edit.files.push({
    path: ctx.at(routesFile),
    content: applyInsertions(routesText, insertions),
    created: false,
  });
  edit.note = `${edit.note} Registered in ${ctx.at(routesFile)}.`;
  return edit;
}

/** SolidStart: an API route `src/routes/<path>.ts` exporting `GET`. */
async function solidStart(ctx: FileContext): Promise<HealthEdit> {
  const config = await ctx.first(configNames("app.config"));
  const text = config === undefined ? undefined : await ctx.read(config);
  if (text !== undefined && /\b(?:appRoot|routeDir)\s*:/.test(scanJs(text).code)) {
    return manual(
      `${ctx.at(config as string)} moves the routes folder, so OpsCrew cannot tell where routes live.`,
    );
  }
  const base = `src/routes/${ctx.route}`;
  const found = await ctx.first([
    ...withExtensions(base, ROUTE_EXTENSIONS),
    ...withExtensions(`${base}/index`, ROUTE_EXTENSIONS),
  ]);
  if (found !== undefined) return existing(ctx, found);
  const style = await styleOf(ctx, [config ?? "app.config.ts", "src/app.tsx", "src/app.jsx"]);
  return created(ctx, "SolidStart", `${base}.${style.ext}`, jsonResponse(style, "GET"));
}

/** Next.js: the existing deterministic route (`../health-route`), unchanged. */
async function next(input: HealthRouteInput): Promise<HealthEdit> {
  const edit = await nextHealthRoute({
    path: input.path,
    healthPath: input.healthPath,
    exists: (path) => input.repo.exists(path),
    folders: (path) => input.repo.folders(path),
    read: (path) => input.repo.read(path),
  });
  if (edit.action === "manual") return edit;
  const pathNote = edit.basePathNote === undefined ? {} : { pathNote: edit.basePathNote };
  if (edit.action === "none") return { action: "none", reason: edit.reason, ...pathNote };
  return {
    action: "write",
    framework: "Next.js",
    files: [{ path: edit.path, content: edit.content, created: true }],
    path: edit.path,
    note: edit.note,
    checks: edit.middleware === undefined ? [] : [protectCheck(edit.middleware, input.healthPath)],
    ...pathNote,
  };
}

/** A file-routed framework of the app. */
export type FileRouted =
  | "next"
  | "nuxt"
  | "sveltekit"
  | "astro"
  | "react-router"
  | "remix"
  | "solid-start";

const HANDLERS: Record<Exclude<FileRouted, "next">, (ctx: FileContext) => Promise<HealthEdit>> = {
  nuxt,
  sveltekit,
  astro,
  "react-router": reactRouter,
  remix,
  "solid-start": solidStart,
};

/** The file-routed framework the app uses, if any (React Router before Remix, its successor). */
export async function fileRoutedFramework(
  input: HealthRouteInput,
): Promise<FileRouted | undefined> {
  const names = new Set(input.facts.frameworks.map((framework) => framework.name));
  if (input.stack === "nextjs" || names.has("next")) return "next";
  const deps = await packageDependencies(input.repo, input.facts);
  const has = (name: string) => deps.has(name);
  const prefixed = (prefix: string) => [...deps.keys()].some((name) => name.startsWith(prefix));
  if (names.has("nuxt") || has("nuxt")) return "nuxt";
  if (names.has("sveltekit") || has("@sveltejs/kit")) return "sveltekit";
  if (names.has("astro") || has("astro")) return "astro";
  if (names.has("react-router") || prefixed("@react-router/")) return "react-router";
  if (names.has("remix") || prefixed("@remix-run/")) return "remix";
  if (has("@solidjs/start")) return "solid-start";
  return undefined;
}

/** The health route of a file-routed framework. */
export async function fileHealthRoute(
  input: HealthRouteInput,
  framework: FileRouted,
): Promise<HealthEdit> {
  if (framework === "next") return next(input);
  const route = input.healthPath.replace(/^\/+|\/+$/g, "");
  if (input.healthPath.endsWith("/") && input.healthPath !== "/") {
    return manual(
      `the plan checks ${input.healthPath} with a trailing slash, and OpsCrew only creates routes without one.`,
    );
  }
  const dir = appFolder(input.facts);
  const at = (path: string) => under(dir, path);
  const ctx: FileContext = {
    input,
    dir,
    route,
    segments: route.split("/"),
    at,
    read: (name) => input.repo.read(at(name)),
    first: async (names) => {
      for (const name of names) if (await input.repo.exists(at(name))) return name;
      return undefined;
    },
  };
  return HANDLERS[framework](ctx);
}
