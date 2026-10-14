/**
 * Per-file signal extraction from source code: environment-variable names, listening ports,
 * health routes, Python ASGI/WSGI app objects and database URL schemes. Pure functions over text.
 */
import { parseAllDocuments } from "yaml";
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
  /**
   * Prefixes of Flask's `app.config.from_prefixed_env()` calls (`FLASK` by default), sorted and
   * unique. A call whose prefix is not a string literal is skipped.
   */
  configPrefixes: string[];
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
/** A health path in quotes, captured without them (`/health`, `/api/ready/`). */
const QUOTED_HEALTH = `["'\`](/(?:api/)?(?:${HEALTH_NAMES})/?)["'\`]`;
const HEALTH_ROUTE = new RegExp(
  `\\.(?:get|route|all|head|api_route|add_route|add_get|add_api_route)\\(\\s*r?${QUOTED_HEALTH}`,
  "g",
);
/**
 * Other ways to register a health route in code: Starlette `Route("/health", …)`, Litestar and
 * Bottle `@get("/health")` (Bottle's `@route(…)` is matched by {@link ROUTE_CONFIG_HEALTH}),
 * Tornado handler tuples `(r"/health", Handler)` and `url(…)`, Pyramid
 * `config.add_route("name", "/health")`, Hapi `server.route({ method: "GET", path: "/health", … })`
 * (and Fastify's `url:`) and a Koa middleware that checks `ctx.path === "/health"`.
 */
const CODE_HEALTH_ROUTES: readonly RegExp[] = [
  new RegExp(`(?<![\\w.])Route\\(\\s*${QUOTED_HEALTH}`, "g"),
  new RegExp(`@get\\(\\s*${QUOTED_HEALTH}`, "g"),
  new RegExp(
    `(?:\\burl|[[,]\\s*)\\(\\s*r?["'](/(?:api/)?(?:${HEALTH_NAMES})/?)\\$?["']\\s*,\\s*[A-Za-z_][\\w.]*\\s*[,)]`,
    "g",
  ),
  new RegExp(`\\.add_route\\(\\s*["'][^"'\\n]*["']\\s*,\\s*${QUOTED_HEALTH}`, "g"),
  new RegExp(`\\.route\\(\\s*\\{[^{}]*?\\b(?:path|url)\\s*:\\s*${QUOTED_HEALTH}`, "g"),
  new RegExp(`\\bctx\\.(?:path|url)\\s*===?\\s*${QUOTED_HEALTH}`, "g"),
];
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
  // SolidStart API route: src/routes/<name>.ts
  new RegExp(`^src/routes/((?:api/)?(?:${HEALTH_NAMES}))(?:/index)?\\.[cm]?[jt]s$`),
];

const APP_OBJECT =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[\w.]+\s*)?=\s*(?:fastapi\.|flask\.)?(FastAPI|Flask)\(/gm;
const PREFIXED_ENV = /\.from_prefixed_env\(/g;
const PREFIX_LITERAL = /^["']([A-Za-z_][A-Za-z0-9_]*)["']$/;

/** The argument list of a call whose opening parenthesis ends at `start` (nested ones kept). */
function callArguments(text: string, start: number): string | undefined {
  let depth = 1;
  for (let i = start; i < text.length && i < start + 500; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return text.slice(start, i);
  }
  return undefined;
}

/**
 * The prefix of a `from_prefixed_env(…)` call: a `prefix="APP"` keyword anywhere in the
 * arguments, else a first positional string literal, else `FLASK` when no prefix is passed.
 * Undefined when the prefix is computed (`from_prefixed_env(PREFIX)`, `prefix=name`).
 */
function prefixOf(args: string): string | undefined {
  const keyword = /(?:^|,)\s*prefix\s*=\s*([^,]*)/.exec(args);
  if (keyword) return PREFIX_LITERAL.exec((keyword[1] ?? "").trim())?.[1];
  const first = (args.split(",")[0] ?? "").trim();
  if (first === "" || /^\*{0,2}\w+\s*=/.test(first)) return "FLASK";
  return PREFIX_LITERAL.exec(first)?.[1];
}
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
 * Nuxt (`server/routes/health.ts`), SvelteKit (`src/routes/health/+server.ts`), Astro endpoints
 * (`src/pages/health.ts`) and SolidStart API routes (`src/routes/health.ts`).
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
  for (const pattern of CODE_HEALTH_ROUTES) {
    for (const match of text.matchAll(pattern)) if (match[1]) healthPaths.push(match[1]);
  }
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
  const configPrefixes = new Set<string>();
  for (const match of text.matchAll(PREFIXED_ENV)) {
    const args = callArguments(text, match.index + match[0].length);
    const prefix = args === undefined ? undefined : prefixOf(args);
    if (prefix) configPrefixes.add(prefix);
  }
  const envReads = extractEnvReads(text);
  return {
    envNames: envReads.map((read) => read.name),
    envReads,
    ports,
    healthPaths,
    appObjects,
    urlSchemes: [...urlSchemes].sort(),
    configPrefixes: [...configPrefixes].sort(),
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

/**
 * Unit-relative files that can declare a health endpoint the framework answers by itself (read by
 * {@link builtInHealthEndpoint}).
 */
export const BUILT_IN_HEALTH_FILES: readonly string[] = [
  "config/routes.rb",
  "bootstrap/app.php",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "src/main/resources/application.properties",
  "src/main/resources/application.yml",
  "src/main/resources/application.yaml",
];

/** The text without comment lines (`#`, `//`) and XML or C-style comment blocks. */
function uncommented(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .join("\n");
}

/** `key=value` / `key: value` pairs of a Spring Boot `application.properties` file. */
function springProperties(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#!]/.test(line)) continue;
    const match = /^\s*([\w.[\]-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) values.set(match[1], match[2] ?? "");
  }
  return values;
}

/** The first YAML document of a Spring Boot `application.yml`, flattened to dotted keys. */
function springYaml(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let document: unknown;
  try {
    document = parseAllDocuments(text)[0]?.toJS();
  } catch {
    return values;
  }
  const walk = (node: unknown, prefix: string) => {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, prefix === "" ? key : `${prefix}.${key}`);
      }
    } else if (prefix !== "" && node !== null && node !== undefined) {
      values.set(prefix, String(node));
    }
  };
  walk(document, "");
  return values;
}

/** `/a/b` for `a/b/`, `/a/b` or `a/b`; empty for `/` and an empty value. */
function urlSegment(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

/**
 * The health endpoint the app's framework answers by itself, so no route has to be added: Rails
 * 7.1+ (`get "up" => "rails/health#show"` in `config/routes.rb` → `/up`), Laravel 11+
 * (`health: '/up'` in `bootstrap/app.php`) and Spring Boot Actuator (`spring-boot-starter-actuator`
 * in `pom.xml` or `build.gradle` → `/actuator/health`, under `server.servlet.context-path` and
 * `management.endpoints.web.base-path` from `application.properties|yml`; none when the health
 * endpoint is turned off or served on a separate management port). `texts` maps the
 * {@link BUILT_IN_HEALTH_FILES} that exist to their content.
 */
export function builtInHealthEndpoint(texts: Readonly<Record<string, string>>): string | undefined {
  const routes = texts["config/routes.rb"];
  if (routes !== undefined) {
    const rails = /^\s*get\s+["']\/?([\w/-]+)["']\s*(?:=>|,\s*to:)\s*["']rails\/health#show["']/m;
    const path = rails.exec(uncommented(routes))?.[1];
    if (path) return `/${path}`;
  }
  const bootstrap = texts["bootstrap/app.php"];
  if (bootstrap !== undefined) {
    const path = /\bhealth\s*:\s*["'](\/[^"'\s]*)["']/.exec(uncommented(bootstrap))?.[1];
    if (path) return path;
  }
  const builds = ["pom.xml", "build.gradle", "build.gradle.kts"]
    .map((name) => texts[name])
    .filter((text): text is string => text !== undefined);
  if (!builds.some((text) => /spring-boot-starter-actuator/.test(uncommented(text)))) {
    return undefined;
  }
  const properties = new Map<string, string>();
  const yml =
    texts["src/main/resources/application.yml"] ?? texts["src/main/resources/application.yaml"];
  if (yml !== undefined) for (const [key, value] of springYaml(yml)) properties.set(key, value);
  const props = texts["src/main/resources/application.properties"];
  if (props !== undefined) {
    for (const [key, value] of springProperties(props)) properties.set(key, value);
  }
  const is = (key: string, pattern: RegExp) => pattern.test(properties.get(key) ?? "");
  if (
    properties.has("management.server.port") ||
    is("management.endpoint.health.enabled", /^false$/i) ||
    is("management.endpoint.health.access", /^none$/i) ||
    is("management.endpoints.web.exposure.exclude", /(?:^|,)\s*(?:health|\*)\s*(?:,|$)/) ||
    is("management.endpoints.enabled-by-default", /^false$/i)
  ) {
    return undefined;
  }
  const context = urlSegment(
    properties.get("server.servlet.context-path") ?? properties.get("spring.webflux.base-path"),
  );
  const base = urlSegment(properties.get("management.endpoints.web.base-path") ?? "/actuator");
  return `${context}${base}/health`;
}
