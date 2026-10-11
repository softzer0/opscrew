import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "@opscrew/contracts";
import { listProjectFiles } from "@opscrew/detect";
import {
  type CodeChangeKind,
  type DeployPlan,
  type ProjectFacts,
  RepoPathSchema,
} from "@opscrew/plan-schema";

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
  /** The Next.js config file and whether it sets `output: "standalone"`. */
  nextConfig?: { path: string; standalone: boolean };
  /** App source files that pass a literal port number to `listen(...)` / `run(port=...)`. */
  hardcodedPortFiles?: readonly string[];
  /** File where the server app is created; the health endpoint is added there. */
  serverEntry?: string;
}

/** The subset of a scan report that code-change derivation reads. */
export interface ScanFindings {
  findings: readonly Pick<Finding, "ruleId" | "file" | "title">[];
}

/** Health check path and, when one must be added, where the endpoint lives. */
export interface HealthRoute {
  path: string;
  /** Repo-relative file the endpoint is added to (absent for static sites and existing routes). */
  file?: string;
}

const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];
const STANDALONE = /\boutput\s*:\s*["'`]standalone["'`]/;
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

function joinRel(dir: string, file: string): string {
  return dir === "." || dir === "" ? file : `${dir}/${file}`;
}

function nextDir(facts: ProjectFacts): string | undefined {
  return facts.frameworks.find((framework) => framework.name === "next")?.path;
}

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
    const config = NEXT_CONFIG_NAMES.map((name) => joinRel(next, name)).find((f) => fileSet.has(f));
    if (config !== undefined) {
      signals.nextConfig = { path: config, standalone: STANDALONE.test(await read(config)) };
    }
  }

  const sources = files
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
    const has = (prefix: string) => files.some((f) => f.startsWith(joinRel(next, prefix)));
    const router = (["app/", "src/app/", "pages/", "src/pages/"] as const).find(has) ?? "app/";
    const file = router.endsWith("pages/")
      ? joinRel(next, `${router}api/health.${ext}`)
      : joinRel(next, `${router}api/health/route.${ext}`);
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
 * health endpoint, port from the environment, `.env.example`, Next.js standalone output, and one
 * `secret-removal` per source file with a hard-coded secret found by the scan (`secrets/*`,
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

  if (facts.docker.dockerfile === undefined) {
    add(
      "dockerfile",
      "dockerfile",
      "Dockerfile",
      "The app has no Dockerfile; OpsCrew adds a production Dockerfile for the detected stack that runs as a non-root user.",
    );
  }
  if (facts.docker.dockerignore === undefined) {
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
      `The app reads ${facts.envVars.length} environment variable${facts.envVars.length === 1 ? "" : "s"} but has no .env.example; OpsCrew lists their names (never values).`,
    );
  }

  const next = nextDir(facts);
  if (next !== undefined && facts.appKind !== "static-spa" && !signals.nextConfig?.standalone) {
    add(
      "build-config",
      "build-config",
      signals.nextConfig?.path ?? joinRel(next, "next.config.mjs"),
      'Set output: "standalone" in the Next.js config so the container image only ships the files the server needs.',
    );
  }

  const secretFiles = new Map<string, Set<string>>();
  for (const finding of scan?.findings ?? []) {
    const isSecret =
      finding.ruleId.startsWith("secrets/") || finding.ruleId.startsWith("supabase/service-role-");
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
