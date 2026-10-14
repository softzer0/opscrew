/**
 * Per-file signal extraction from source code: environment-variable names, listening ports,
 * health routes, Python ASGI/WSGI app objects and database URL schemes. Pure functions over text.
 */
import { type EnvRead, extractEnvReads } from "./env";
import { basenameRel } from "./paths";

const SOURCE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "vue",
  "svelte",
  "astro",
  "py",
]);

/** True for source files worth reading (minified bundles and `.d.ts` are skipped). */
export function isSourceFile(path: string): boolean {
  const name = basenameRel(path);
  if (/\.min\.[cm]?js$/i.test(name) || /\.d\.[cm]?ts$/i.test(name)) return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Test and config files do not decide the app's port or health route. */
export function isAppCodeFile(path: string): boolean {
  const name = basenameRel(path);
  if (/\.(?:test|spec|config|stories)\.[\w]+$/i.test(name) || /^(?:test_|conftest)/.test(name)) {
    return false;
  }
  return !/(?:^|\/)(?:tests?|__tests__|e2e|cypress|playwright|scripts?)\//.test(path);
}

/** A Python web-app object such as `app = FastAPI()`. */
export interface PythonAppObject {
  framework: "fastapi" | "flask";
  variable: string;
}

/** Signals found in one source file. */
export interface SourceSignals {
  envNames: string[];
  /** The same variables, each with whether every read in the file has a default. */
  envReads: EnvRead[];
  ports: number[];
  healthPaths: string[];
  appObjects: PythonAppObject[];
  /** URL schemes seen in string literals (`postgres`, `mysql`, `mongodb`, `redis`). */
  urlSchemes: string[];
}

const PORT_PATTERNS: RegExp[] = [
  /\.listen\(\s*(\d{2,5})\b/g,
  /\.listen\(\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/g,
  /\bserve\(\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/g,
  /\bPORT\b["'`\]]*\)*\s*(?:\|\||\?\?)\s*["'`]?(\d{2,5})\b/g,
  /["']PORT["']\s*,\s*["']?(\d{2,5})\b/g,
  /\.run\([^)]*?\bport\s*=\s*(\d{2,5})\b/g,
];

const HEALTH_NAMES = "health|healthz|healthcheck|health-check|ping|status|up|ready|readyz|livez";
const HEALTH_ROUTE = new RegExp(
  `\\.(?:get|route|all|head|api_route)\\(\\s*["'\`](/(?:api/)?(?:${HEALTH_NAMES})/?)["'\`]`,
  "g",
);
const DJANGO_HEALTH_ROUTE = new RegExp(
  `\\b(?:re_)?path\\(\\s*r?["']\\^?((?:api/)?(?:${HEALTH_NAMES})/?)\\$?["']`,
  "g",
);
const HEALTH_PATH = new RegExp(`^/(?:api/)?(?:${HEALTH_NAMES})/?$`);
/** `@Controller(...)`, `@Get(...)`, `@All(...)`, `@Head(...)` with an optional string argument. */
const DECORATOR_ROUTE = /@(Controller|Get|All|Head)\(\s*(?:(["'`])([^"'`]*)\2\s*)?(\))?/g;
/** React Router framework mode: `route("health", "routes/health.ts")` in `app/routes.ts`. */
const ROUTE_CONFIG_HEALTH = new RegExp(
  `(?<![.\\w])route\\(\\s*["'\`]/?((?:api/)?(?:${HEALTH_NAMES})/?)["'\`]`,
  "g",
);
/** File-system routes; the first capture group is the route path without its leading slash. */
const FILE_ROUTES: readonly RegExp[] = [
  // Next.js: app/<name>/route.ts, pages/api/<name>.ts
  new RegExp(`^(?:src/)?app/((?:api/)?(?:${HEALTH_NAMES}))/route\\.[cm]?[jt]sx?$`),
  new RegExp(`^(?:src/)?pages/(api/(?:${HEALTH_NAMES}))(?:/index)?\\.[cm]?[jt]sx?$`),
  // Nuxt: server/routes/<name>.ts → /<name>, server/api/<name>.ts → /api/<name>
  new RegExp(`^server/(?:routes/|(?=api/))((?:api/)?(?:${HEALTH_NAMES}))(?:\\.get)?\\.[cm]?[jt]s$`),
  // SvelteKit: src/routes/<name>/+server.ts
  new RegExp(`^src/routes/((?:api/)?(?:${HEALTH_NAMES}))/\\+server\\.[jt]s$`),
  // Astro endpoint: src/pages/<name>.ts
  new RegExp(`^src/pages/((?:api/)?(?:${HEALTH_NAMES}))\\.[cm]?[jt]s$`),
];

const APP_OBJECT =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[\w.]+\s*)?=\s*(?:fastapi\.|flask\.)?(FastAPI|Flask)\(/gm;
const URL_SCHEME = /["'`](postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?)(?:\+\w+)?:\/\//g;

function toPort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Ports in command text: `--port 8000`, `-p 4000`, `PORT=8080`, `--bind 0.0.0.0:8000`. */
export function portsInCommand(command: string): number[] {
  const ports: number[] = [];
  for (const match of command.matchAll(
    /(?:--port[= ]|-p[= ]?|\bPORT=|--bind[= ]\S*:|-b[= ]?\S*:|--listen[= ]\S*:)\s*(\d{2,5})\b/g,
  )) {
    const port = toPort(match[1]);
    if (port) ports.push(port);
  }
  return ports;
}

/**
 * Health route implied by a file-system route: Next.js (`app/api/health/route.ts` → `/api/health`),
 * Nuxt (`server/routes/health.ts`), SvelteKit (`src/routes/health/+server.ts`) and Astro endpoints
 * (`src/pages/health.ts`).
 */
export function healthRouteFromPath(unitRelativePath: string): string | undefined {
  for (const pattern of FILE_ROUTES) {
    const route = pattern.exec(unitRelativePath)?.[1];
    if (route) return `/${route}`;
  }
  return undefined;
}

/**
 * Health routes declared with decorators (NestJS style): `@Get("health")`, or `@Controller("health")`
 * with `@Get()`. The path is the controller prefix joined with the method path; methods under a
 * controller whose prefix is not a plain string are skipped.
 */
function decoratorHealthPaths(text: string): string[] {
  const paths: string[] = [];
  let prefix: string | undefined = "";
  for (const match of text.matchAll(DECORATOR_ROUTE)) {
    const literal = match[4] === undefined ? undefined : (match[3] ?? "");
    if (match[1] === "Controller") {
      prefix = literal;
      continue;
    }
    if (prefix === undefined || literal === undefined) continue;
    const path = `/${[prefix, literal]
      .map((part) => part.replace(/^\/+|\/+$/g, ""))
      .filter((part) => part !== "")
      .join("/")}`;
    if (HEALTH_PATH.test(path)) paths.push(path);
  }
  return paths;
}

/** Extracts all signals from one source file. */
export function scanSource(text: string): SourceSignals {
  const ports: number[] = [];
  for (const pattern of PORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const port = toPort(match[1]);
      if (port) ports.push(port);
    }
  }
  const healthPaths: string[] = [];
  for (const match of text.matchAll(HEALTH_ROUTE)) if (match[1]) healthPaths.push(match[1]);
  for (const match of text.matchAll(DJANGO_HEALTH_ROUTE)) {
    if (match[1]) healthPaths.push(`/${match[1]}`);
  }
  for (const match of text.matchAll(ROUTE_CONFIG_HEALTH)) {
    if (match[1]) healthPaths.push(`/${match[1]}`);
  }
  healthPaths.push(...decoratorHealthPaths(text));
  const appObjects: PythonAppObject[] = [];
  for (const match of text.matchAll(APP_OBJECT)) {
    if (match[1] && match[2]) {
      appObjects.push({
        variable: match[1],
        framework: match[2] === "FastAPI" ? "fastapi" : "flask",
      });
    }
  }
  const urlSchemes = new Set<string>();
  for (const match of text.matchAll(URL_SCHEME)) {
    const scheme = (match[1] ?? "").toLowerCase();
    urlSchemes.add(
      scheme.startsWith("postgres")
        ? "postgres"
        : scheme.startsWith("mongodb")
          ? "mongodb"
          : scheme.startsWith("redis")
            ? "redis"
            : scheme,
    );
  }
  const envReads = extractEnvReads(text);
  return {
    envNames: envReads.map((read) => read.name),
    envReads,
    ports,
    healthPaths,
    appObjects,
    urlSchemes: [...urlSchemes].sort(),
  };
}

/** Python module path for a unit-relative file (`app/main.py` → `app.main`). */
export function pythonModule(unitRelativePath: string): string {
  return unitRelativePath
    .replace(/\.py$/, "")
    .replace(/\/__init__$/, "")
    .split("/")
    .join(".");
}
