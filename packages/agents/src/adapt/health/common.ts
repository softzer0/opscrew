import type { ProjectFacts } from "@opscrew/plan-schema";
import { escapeRegExp, lineAt, lineStarts } from "./text";
import type { HealthEdit, HealthRepo } from "./types";

/** Repo-relative folder of the app (`.` for the repository root). */
export function appFolder(facts: ProjectFacts): string {
  const dir = (facts.appDir ?? ".").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return dir === "" || dir === "." ? "." : dir;
}

/** `<dir>/<path>`, or `path` for the root. */
export function under(dir: string, path: string): string {
  return dir === "." ? path : `${dir}/${path}`;
}

/** Folders and files that never hold the app's own server code. */
const NOT_APP_CODE =
  /(?:^|\/)(?:tests?|__tests__|spec|e2e|cypress|playwright|scripts?|migrations|alembic|fixtures|__fixtures__|__mocks__|examples?|docs?|node_modules|site-packages|\.?venv)\//;
const NOT_APP_FILE =
  /(?:\.(?:test|spec|stories|config|d|min)\.[^./]+$)|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/;

/** Files of the app (inside its folder) that may hold server code with one of `extensions`. */
export async function appCodeFiles(
  repo: HealthRepo,
  facts: ProjectFacts,
  extensions: RegExp,
): Promise<string[]> {
  const dir = appFolder(facts);
  const prefix = dir === "." ? "" : `${dir}/`;
  return (await repo.files())
    .filter((file) => file.startsWith(prefix))
    .filter((file) => extensions.test(file))
    .filter((file) => {
      const rest = file.slice(prefix.length);
      return !NOT_APP_CODE.test(rest) && !NOT_APP_FILE.test(rest);
    })
    .slice(0, 3_000);
}

/** A file's text, at most 400 kB (larger files are generated or vendored). */
export async function readSource(repo: HealthRepo, file: string): Promise<string | undefined> {
  const text = await repo.read(file);
  return text === undefined || text.length > 400_000 ? undefined : text;
}

/** The plan's path and the same path with (or without) a trailing slash. */
export function pathVariants(healthPath: string): string[] {
  const bare = healthPath.length > 1 ? healthPath.replace(/\/+$/, "") : healthPath;
  return [...new Set([healthPath, bare, `${bare}/`])];
}

/**
 * Code just before a path literal that registers a GET route for it: `app.get(`, `@app.route(`,
 * `@get(`, `Route(`, `add_get(`, Tornado's `[(r"`, Pyramid's `add_route("name", `, a
 * `route({ path: ` / `url: ` object (Hapi, Fastify) and Koa's `ctx.path === `.
 */
const GET_ROUTE = [
  /(?:[.@](?:get|route|api_route|all|head|add_get|add_route|add_api_route)|(?<![\w.])(?:Route|route|url)|@(?:Get|All|Head))\s*\(\s*r?$/,
  /[[,]\s*\(\s*r?$/,
  /\.add_route\s*\([^()]*,\s*$/,
  /\.route\s*\(\s*\{[^{}]*\b(?:path|url)\s*:\s*$/,
  /\bctx\.(?:path|url)\s*===?\s*$/,
];
/** Code just before a path literal that uses the path for something else. */
const OTHER_ROUTE =
  /(?:[.@](?:post|put|patch|delete|options|use|mount|websocket|websocket_route|ws|register)|\bMount|@(?:Post|Put|Patch|Delete|Controller))\s*\(\s*r?$|\bprefix\s*[=:]\s*$/;

/** Where a file already uses the health path. */
export interface PathUse {
  file: string;
  line: number;
  get: boolean;
}

/**
 * The places in `text` where one of `paths` is a string literal in a route registration; `code`
 * is the same text with comments (and string contents) blanked.
 */
export function routeUses(
  file: string,
  text: string,
  code: string,
  paths: readonly string[],
): PathUse[] {
  const uses: PathUse[] = [];
  const starts = lineStarts(text);
  for (const path of paths) {
    const pattern = new RegExp(`(["'\`])${escapeRegExp(path)}\\1`, "g");
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      // A string in code (not in a comment): its opening quote survives in the code text.
      if (code[at] !== match[1]) continue;
      // The code before it, across lines (route objects and calls are often split over lines).
      const before = code.slice(Math.max(0, at - 300), at).trimEnd();
      const line = lineAt(starts, at) + 1;
      if (GET_ROUTE.some((pattern) => pattern.test(before))) uses.push({ file, line, get: true });
      else if (OTHER_ROUTE.test(before)) uses.push({ file, line, get: false });
    }
  }
  return uses;
}

/** `none` for an existing GET route, `manual` for another use of the path, or undefined. */
export function pathTaken(uses: readonly PathUse[], healthPath: string): HealthEdit | undefined {
  const get = uses.find((use) => use.get);
  if (get !== undefined) {
    return {
      action: "none",
      reason: `${get.file} (line ${get.line}) already answers ${healthPath}; OpsCrew left it as it is.`,
    };
  }
  const other = uses[0];
  if (other !== undefined) {
    return {
      action: "manual",
      reason: `${other.file} already uses ${healthPath} (line ${other.line}), so OpsCrew did not add a second route there.`,
    };
  }
  return undefined;
}

/** A plain URL path made of simple segments, such as `/health` or `/api/health`. */
export const SIMPLE_PATH = /^(?:\/[A-Za-z0-9_-]+)+\/?$/;

/** Reads the app's `package.json` dependencies (all kinds), or an empty set. */
export async function packageDependencies(
  repo: HealthRepo,
  facts: ProjectFacts,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const text = await repo.read(under(appFolder(facts), "package.json"));
  if (text === undefined) return found;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = json[key];
      if (deps === null || typeof deps !== "object") continue;
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
        if (!found.has(name)) found.set(name, typeof version === "string" ? version : "");
      }
    }
  } catch {
    // An unreadable package.json names no dependencies.
  }
  return found;
}
