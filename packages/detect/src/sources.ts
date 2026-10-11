/**
 * Per-file signal extraction from source code: environment-variable names, listening ports,
 * health routes, Python ASGI/WSGI app objects and database URL schemes. Pure functions over text.
 */
import { extractEnvReferences } from "./env";
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
const FILE_ROUTE = new RegExp(
  `^(?:src/)?(?:app/((?:api/)?(?:${HEALTH_NAMES}))/route|pages/(api/(?:${HEALTH_NAMES}))(?:/index)?)\\.[cm]?[jt]sx?$`,
);

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

/** Health route implied by a file-system route (`app/api/health/route.ts` → `/api/health`). */
export function healthRouteFromPath(unitRelativePath: string): string | undefined {
  const match = FILE_ROUTE.exec(unitRelativePath);
  const route = match?.[1] ?? match?.[2];
  return route ? `/${route}` : undefined;
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
  return {
    envNames: extractEnvReferences(text),
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
