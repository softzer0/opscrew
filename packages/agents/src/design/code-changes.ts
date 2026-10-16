import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Finding, SEVERITIES } from "@opscrew/contracts";
import { plural } from "@opscrew/core";
import { listProjectFiles } from "@opscrew/detect";
import {
  type CodeChangeKind,
  type DeployPlan,
  type ProjectFacts,
  RepoPathSchema,
} from "@opscrew/plan-schema";
import { z } from "zod";

/** One entry of `plan.codeChanges`. */
export type CodeChange = DeployPlan["codeChanges"][number];

/**
 * Repository details that are not part of `ProjectFacts` but decide which code changes are
 * needed. Collected by {@link collectCodeChangeSignals}; every field is optional and a missing
 * field falls back to a conservative default.
 */
export interface CodeChangeSignals {
  /** Repo-relative POSIX paths of the project's files. */
  files?: readonly string[];
  /**
   * The Next.js config file and whether it sets `output: "standalone"`. `tracingRoot` (whether it
   * sets `outputFileTracingRoot`) is only checked for an app in a monorepo folder.
   */
  nextConfig?: { path: string; standalone: boolean; tracingRoot?: boolean };
  /** App source files that pass a literal port number to `listen(...)` / `run(port=...)`. */
  hardcodedPortFiles?: readonly string[];
  /** File where the server app is created; the health endpoint is added there. */
  serverEntry?: string;
  /**
   * Django settings: the main settings file and whether any settings file sets `STATIC_ROOT`
   * (the generated image runs `collectstatic`, which needs it).
   */
  djangoSettings?: { path: string; staticRoot: boolean };
}

/** The subset of a scan report that code-change derivation reads. */
export interface ScanFindings {
  findings: readonly Pick<Finding, "ruleId" | "file" | "title">[];
}

/** What design and adapt read from `.opscrew/scan.json`. */
const ScanReportSchema = z.looseObject({
  counts: z.partialRecord(z.enum(SEVERITIES), z.number().int().nonnegative()),
  findings: z.array(
    z.looseObject({ ruleId: z.string(), title: z.string(), file: z.string().optional() }),
  ),
});

/** The finding counts and findings of the last `opscrew scan`. */
export type ScanReportSummary = z.infer<typeof ScanReportSchema>;

/** The last `opscrew scan` report (`.opscrew/scan.json`); undefined when missing or damaged. */
export async function readScanReport(file: string): Promise<ScanReportSummary | undefined> {
  try {
    const parsed = ScanReportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Health check path and, when one must be added, where the endpoint lives. */
export interface HealthRoute {
  path: string;
  /** Repo-relative file the endpoint is added to (absent for static sites and existing routes). */
  file?: string;
}

/** The Next.js config file names, in the order Next.js loads them. */
export const NEXT_CONFIG_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.cjs",
];
const STANDALONE = /\boutput\s*:\s*["'`]standalone["'`]/;
const TRACING_ROOT = /\boutputFileTracingRoot\b/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|e2e|cypress)\/|\.(?:test|spec)\.[^/]+$/;
const JS_LITERAL_LISTEN = /\.listen\(\s*\d{2,5}\s*[,)]/;
const PY_LITERAL_RUN = /\.run\([^)\n]*\bport\s*=\s*\d{2,5}\b/;
const SERVER_ENTRY = [
  /\bexpress\(\s*\)/,
  /\bfastify\(/,
  /\bnew\s+Hono\b/,
  /\bnew\s+Koa\(/,
  /\bNestFactory\.create\b/,
  /\bFastAPI\(/,
  /\bFlask\(__name__/,
  /\bcreateServer\(/,
];
const MAX_SOURCE_FILES = 5_000;
/** Scan rules whose findings are hard-coded secrets (built-in, gitleaks and Supabase service role). */
const SECRET_RULE_PREFIXES = ["secrets/", "gitleaks/", "supabase/service-role-"];

function isRootDir(dir: string): boolean {
  return dir === "." || dir === "" || dir === "./";
}

/** `<dir>/<path>` for a repo-relative folder, or `path` for the repository root. */
export function under(dir: string, path: string): string {
  return isRootDir(dir) ? path : `${dir.replace(/\/+$/, "")}/${path}`;
}

/** Repo-relative folder of the app the facts describe (`.` for the repository root). */
export function appDirOf(facts: ProjectFacts): string {
  const dir = (facts.appDir ?? ".").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return isRootDir(dir) ? "." : dir;
}

function isInDir(dir: string, file: string): boolean {
  return isRootDir(dir) || file.startsWith(`${dir}/`);
}

/**
 * The Dockerfile the deployment builds and whether it exists. At the repository root that is
 * `Dockerfile` (present when detection found any Dockerfile). For an app in a subfolder it is a
 * Dockerfile detected inside that folder, otherwise `<appDir>/Dockerfile`, which adapt creates;
 * the build context is the repository root either way.
 */
export function appDockerfile(facts: ProjectFacts): { path: string; exists: boolean } {
  const dir = appDirOf(facts);
  const found = facts.docker.dockerfile;
  if (dir === ".") return { path: "Dockerfile", exists: found !== undefined };
  if (found !== undefined && isInDir(dir, found)) return { path: found, exists: true };
  return { path: under(dir, "Dockerfile"), exists: false };
}

function nextDir(facts: ProjectFacts): string | undefined {
  return facts.frameworks.find((framework) => framework.name === "next")?.path;
}

function usesDjango(facts: ProjectFacts): boolean {
  return facts.frameworks.some((framework) => framework.name === "django");
}

const DJANGO_SETTINGS = /(?:^|\/)settings(?:\/[^/]+)?\.py$/;
const STATIC_ROOT = /^\s*STATIC_ROOT\s*=/m;

function depth(path: string): number {
  return path.split("/").length;
}

/**
 * Reads the repository for {@link CodeChangeSignals}: the Next.js config, literal ports in app
 * source files and the server entry file. Uses the same gitignore-aware file walk as detection.
 */
export async function collectCodeChangeSignals(
  root: string,
  facts: ProjectFacts,
): Promise<CodeChangeSignals> {
  const { files } = await listProjectFiles(root);
  const read = (file: string) => readFile(join(root, ...file.split("/")), "utf8").catch(() => "");
  const signals: CodeChangeSignals = { files };

  const next = nextDir(facts);
  if (next !== undefined) {
    const fileSet = new Set(files);
    const config = NEXT_CONFIG_NAMES.map((name) => under(next, name)).find((f) => fileSet.has(f));
    if (config !== undefined) {
      const text = await read(config);
      signals.nextConfig = {
        path: config,
        standalone: STANDALONE.test(text),
        ...(isRootDir(next) ? {} : { tracingRoot: TRACING_ROOT.test(text) }),
      };
    }
  }

  // Only the chosen app's folder counts in a repository with several apps.
  const appDir = appDirOf(facts);
  const sources = files
    .filter((file) => isInDir(appDir, file))
    .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file) && !/\.d\.ts$/.test(file))
    .filter((file) => !/(?:^|\/)(?:next|vite|vitest|jest|webpack|tailwind)\.config\./.test(file))
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))
    .slice(0, MAX_SOURCE_FILES);
  const hardcoded: string[] = [];
  for (const file of sources) {
    const text = await read(file);
    const literalPort = file.endsWith(".py")
      ? PY_LITERAL_RUN.test(text)
      : JS_LITERAL_LISTEN.test(text);
    if (literalPort) hardcoded.push(file);
    if (signals.serverEntry === undefined && SERVER_ENTRY.some((pattern) => pattern.test(text))) {
      signals.serverEntry = file;
    }
  }
  signals.hardcodedPortFiles = hardcoded.sort();

  if (usesDjango(facts)) {
    const settings = files
      .filter((file) => isInDir(appDir, file))
      .filter((file) => DJANGO_SETTINGS.test(file) && !TEST_FILE.test(file))
      .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
    const main = settings.find((file) => file.endsWith("/settings.py") || file === "settings.py");
    if (settings.length > 0) {
      let staticRoot = false;
      for (const file of settings) if (STATIC_ROOT.test(await read(file))) staticRoot = true;
      signals.djangoSettings = { path: main ?? (settings[0] as string), staticRoot };
    }
  }
  return signals;
}

/**
 * Health check path for the app, and the file to add the endpoint to when the app has none:
 * an existing detected endpoint wins; static sites use `/`; Next.js uses `/api/health`
 * (`app/api/health/route.ts` with the app router, `pages/api/health.ts` with the pages router);
 * everything else uses `/health` in the server entry file.
 */
export function healthRouteFor(facts: ProjectFacts, signals: CodeChangeSignals = {}): HealthRoute {
  if (facts.healthEndpoint !== undefined) return { path: facts.healthEndpoint };
  if (facts.appKind === "static-spa") return { path: "/" };
  const ext = facts.languages.includes("typescript") ? "ts" : "js";
  const next = nextDir(facts);
  if (next !== undefined) {
    const files = signals.files ?? [];
    const has = (prefix: string) => files.some((f) => f.startsWith(under(next, prefix)));
    const router = (["app/", "src/app/", "pages/", "src/pages/"] as const).find(has) ?? "app/";
    const file = router.endsWith("pages/")
      ? under(next, `${router}api/health.${ext}`)
      : under(next, `${router}api/health/route.${ext}`);
    return { path: "/api/health", file };
  }
  const entry = signals.serverEntry ?? facts.frameworks[0]?.path ?? ".";
  return { path: "/health", file: entry };
}

function isDotenvFile(file: string): boolean {
  return /^\.env(?:\..*)?$/.test(file.split("/").at(-1) ?? "");
}

function hasEnvExample(facts: ProjectFacts, signals: CodeChangeSignals): boolean {
  const isExample = (file: string) =>
    /^\.env\.(?:example|sample|template)$/.test(file.split("/").at(-1) ?? "");
  if (signals.files !== undefined) return signals.files.some(isExample);
  return facts.envVars.some((variable) => variable.files.some(isExample));
}

/**
 * Code changes the app needs before it can be deployed (plan.md): Dockerfile, `.dockerignore`,
 * health endpoint, port from the environment, `.env.example`, Next.js standalone output (plus
 * `outputFileTracingRoot` for an app in a monorepo folder), and one `secret-removal` per source
 * file with a hard-coded secret found by the scan (`secrets/*`, `gitleaks/*`,
 * `supabase/service-role-*`; `.env` files are excluded). Ids are stable: the kind, plus a number
 * for kinds that can repeat (`port-config-1`, `secret-removal-2`). All start `pending`.
 */
export function deriveCodeChanges(
  facts: ProjectFacts,
  scan?: ScanFindings,
  signals: CodeChangeSignals = {},
): CodeChange[] {
  const changes: CodeChange[] = [];
  const add = (id: string, kind: CodeChangeKind, path: string, reason: string) => {
    changes.push({ id, kind, path, reason, status: "pending" });
  };

  const dockerfile = appDockerfile(facts);
  if (!dockerfile.exists) {
    add(
      "dockerfile",
      "dockerfile",
      dockerfile.path,
      "The app has no Dockerfile; OpsCrew adds a production Dockerfile for the detected stack that runs as a non-root user.",
    );
  }
  // The build context is the repository root, so that is where `.dockerignore` must be.
  const rootIgnore =
    appDirOf(facts) === "."
      ? facts.docker.dockerignore !== undefined
      : facts.docker.dockerignore === ".dockerignore";
  if (!rootIgnore) {
    add(
      "dockerignore",
      "dockerignore",
      ".dockerignore",
      "Keeps .env files, git data and local build output out of the container image.",
    );
  }

  const health = healthRouteFor(facts, signals);
  if (health.file !== undefined) {
    add(
      "health-endpoint",
      "health-endpoint",
      health.file,
      `Add a ${health.path} endpoint that answers 200 OK without touching the database, so deploys can check the app started and roll back if not.`,
    );
  }

  if (facts.appKind !== "static-spa") {
    (signals.hardcodedPortFiles ?? []).forEach((file, i) => {
      add(
        `port-config-${i + 1}`,
        "port-config",
        file,
        `The listening port is hard-coded; read it from the PORT environment variable (keep ${facts.port ?? "the current port"} as the default).`,
      );
    });
  }

  if (facts.envVars.length > 0 && !hasEnvExample(facts, signals)) {
    add(
      "env-example",
      "env-example",
      ".env.example",
      `The app reads ${plural(facts.envVars.length, "environment variable")} but has no .env.example; OpsCrew lists their names (never values).`,
    );
  }

  const next = nextDir(facts);
  if (next !== undefined && facts.appKind !== "static-spa") {
    const config = signals.nextConfig;
    const inFolder = !isRootDir(next);
    if (!config?.standalone || (inFolder && config.tracingRoot === false)) {
      const toRoot = `${"../".repeat(next.replace(/\/+$/, "").split("/").length)}`;
      add(
        "build-config",
        "build-config",
        config?.path ?? under(next, "next.config.mjs"),
        inFolder
          ? `Set output: "standalone" and outputFileTracingRoot (the repository root, for example path.join(__dirname, "${toRoot}")) in the Next.js config, so the container image only ships the files the server needs, including workspace packages.`
          : 'Set output: "standalone" in the Next.js config so the container image only ships the files the server needs.',
      );
    }
  }

  const django = signals.djangoSettings;
  if (django !== undefined && !django.staticRoot) {
    add(
      "build-config",
      "build-config",
      django.path,
      'Set STATIC_ROOT (for example BASE_DIR / "staticfiles") so `collectstatic` works when the container image is built, and read SECRET_KEY, DEBUG and ALLOWED_HOSTS from the environment.',
    );
  }

  const secretFiles = new Map<string, Set<string>>();
  for (const finding of scan?.findings ?? []) {
    const isSecret = SECRET_RULE_PREFIXES.some((prefix) => finding.ruleId.startsWith(prefix));
    if (!isSecret || finding.file === undefined || isDotenvFile(finding.file)) continue;
    if (!RepoPathSchema.safeParse(finding.file).success) continue;
    const titles = secretFiles.get(finding.file) ?? new Set<string>();
    titles.add(finding.title);
    secretFiles.set(finding.file, titles);
  }
  [...secretFiles.keys()].sort().forEach((file, i) => {
    const titles = [...(secretFiles.get(file) ?? [])].sort().join("; ");
    add(
      `secret-removal-${i + 1}`,
      "secret-removal",
      file,
      `Hard-coded secret found by the scan (${titles}); read it from an environment variable instead and rotate the exposed value.`,
    );
  });

  return changes;
}
