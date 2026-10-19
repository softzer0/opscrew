/**
 * Framework rules: which dependencies are frameworks, how they map to an app kind, and the
 * framework defaults for ports, start commands and static output directories.
 */
import type { AppKind } from "@opscrew/plan-schema";
import { type Dependency, type DependencyEcosystem, findDependency, type Unit } from "./manifests";

/**
 * How a framework shapes the app: `ssr` meta-frameworks, `frontend` build tools, `ui` libraries,
 * `server` frameworks, `fullstack` frameworks (Rails, Laravel), and Astro/Django which depend on
 * their configuration.
 */
export type FrameworkRole = "ssr" | "frontend" | "ui" | "server" | "fullstack" | "astro" | "django";

interface FrameworkRule {
  ecosystem: DependencyEcosystem;
  /** Exact package name or a prefix ending in `/` (for `@remix-run/*`). */
  match: string;
  name: string;
  role: FrameworkRole;
}

const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  { ecosystem: "npm", match: "next", name: "next", role: "ssr" },
  { ecosystem: "npm", match: "nuxt", name: "nuxt", role: "ssr" },
  { ecosystem: "npm", match: "@remix-run/", name: "remix", role: "ssr" },
  // React Router framework mode (`@react-router/dev`, `/node`, `/serve`); plain `react-router` is a
  // client library and stays a UI dependency.
  { ecosystem: "npm", match: "@react-router/", name: "react-router", role: "ssr" },
  { ecosystem: "npm", match: "@sveltejs/kit", name: "sveltekit", role: "ssr" },
  { ecosystem: "npm", match: "astro", name: "astro", role: "astro" },
  { ecosystem: "npm", match: "vite", name: "vite", role: "frontend" },
  { ecosystem: "npm", match: "react-scripts", name: "create-react-app", role: "frontend" },
  { ecosystem: "npm", match: "@angular/core", name: "angular", role: "frontend" },
  { ecosystem: "npm", match: "react", name: "react", role: "ui" },
  { ecosystem: "npm", match: "vue", name: "vue", role: "ui" },
  { ecosystem: "npm", match: "svelte", name: "svelte", role: "ui" },
  { ecosystem: "npm", match: "solid-js", name: "solid", role: "ui" },
  { ecosystem: "npm", match: "preact", name: "preact", role: "ui" },
  { ecosystem: "npm", match: "express", name: "express", role: "server" },
  { ecosystem: "npm", match: "fastify", name: "fastify", role: "server" },
  { ecosystem: "npm", match: "@nestjs/core", name: "nestjs", role: "server" },
  { ecosystem: "npm", match: "hono", name: "hono", role: "server" },
  { ecosystem: "npm", match: "koa", name: "koa", role: "server" },
  // The api side of a Redwood project (its web side is a React app built to static files).
  { ecosystem: "npm", match: "@redwoodjs/api", name: "redwood", role: "server" },
  { ecosystem: "pypi", match: "fastapi", name: "fastapi", role: "server" },
  { ecosystem: "pypi", match: "flask", name: "flask", role: "server" },
  { ecosystem: "pypi", match: "django", name: "django", role: "django" },
  { ecosystem: "gem", match: "rails", name: "rails", role: "fullstack" },
  { ecosystem: "composer", match: "laravel/framework", name: "laravel", role: "fullstack" },
];

const WORKER_LIBRARIES: Record<DependencyEcosystem, readonly string[]> = {
  npm: ["bullmq", "bull", "bee-queue", "agenda", "node-cron", "cron", "@temporalio/worker"],
  pypi: ["celery", "rq", "dramatiq", "huey", "apscheduler", "arq"],
  gem: ["sidekiq"],
  composer: [],
  // No web framework is detected for these yet, so a job library must not make the app a worker.
  go: [],
  maven: [],
  nuget: [],
};

const ASTRO_ADAPTERS = /^@astrojs\/(?:node|vercel|netlify|cloudflare|deno)$/;

/** A framework found in a unit. */
export interface DetectedFramework {
  name: string;
  role: FrameworkRole;
  version?: string;
  dev: boolean;
}

function matches(rule: FrameworkRule, dep: Dependency): boolean {
  if (rule.ecosystem !== dep.ecosystem) return false;
  return rule.match.endsWith("/") ? dep.name.startsWith(rule.match) : dep.name === rule.match;
}

/** Frameworks declared by a unit, in rule order (one entry per framework name). */
export function detectFrameworks(unit: Unit): DetectedFramework[] {
  const found: DetectedFramework[] = [];
  for (const rule of FRAMEWORK_RULES) {
    const deps = unit.dependencies.filter((dep) => matches(rule, dep));
    const dep = deps.find((d) => !d.dev) ?? deps[0];
    if (!dep) continue;
    found.push({
      name: rule.name,
      role: rule.role,
      dev: dep.dev,
      ...(dep.version ? { version: dep.version } : {}),
    });
  }
  return found;
}

/** Configuration facts that refine the app kind. */
export interface AppKindHints {
  /** `output: "export"` in next.config.*. */
  nextStaticExport: boolean;
  /** Astro has a server adapter (dependency or `adapter:` in astro.config.*). */
  astroServer: boolean;
  /** Django project has HTML templates. */
  djangoTemplates: boolean;
}

/** Does the unit's dependency list include an Astro server adapter? */
export function hasAstroAdapter(unit: Unit): boolean {
  return unit.dependencies.some((dep) => dep.ecosystem === "npm" && ASTRO_ADAPTERS.test(dep.name));
}

/** True when a unit uses only queue/cron libraries (no web framework). */
export function hasWorkerLibraries(unit: Unit): boolean {
  return unit.dependencies.some(
    (dep) => !dep.dev && WORKER_LIBRARIES[dep.ecosystem].includes(dep.name),
  );
}

/** Effective roles after applying configuration hints (static Next, Astro adapters, Django). */
export function effectiveRoles(
  unit: Unit,
  frameworks: readonly DetectedFramework[],
  hints: AppKindHints,
): Set<FrameworkRole> {
  const roles = new Set<FrameworkRole>();
  for (const framework of frameworks) {
    if (framework.name === "next" && hints.nextStaticExport) roles.add("frontend");
    else if (framework.role === "astro") roles.add(hints.astroServer ? "ssr" : "frontend");
    else if (framework.role === "django") {
      const restOnly =
        findDependency(unit, "pypi", "djangorestframework") && !hints.djangoTemplates;
      roles.add(restOnly ? "server" : "fullstack");
    } else roles.add(framework.role);
  }
  return roles;
}

/** App kind from a unit's frameworks (plan.md "Frameworks → app kind"). */
export function appKindOf(
  unit: Unit,
  frameworks: readonly DetectedFramework[],
  hints: AppKindHints,
): AppKind {
  const roles = effectiveRoles(unit, frameworks, hints);
  const hasFrontend = roles.has("frontend") || roles.has("ui");
  if (roles.has("fullstack")) return "fullstack";
  if (roles.has("ssr")) return "ssr";
  if (roles.has("server")) return hasFrontend ? "fullstack" : "api";
  if (hasFrontend) return "static-spa";
  if (hasWorkerLibraries(unit)) return "worker";
  return "unknown";
}

/** True when a unit can run as a deployable server (start script or server-side framework). */
export function isServerUnit(unit: Unit, roles: ReadonlySet<FrameworkRole>): boolean {
  return (
    Boolean(unit.packageJson?.scripts.start) ||
    roles.has("ssr") ||
    roles.has("server") ||
    roles.has("fullstack")
  );
}

/** Default listening port of the unit's main framework. */
export function defaultPort(frameworks: readonly DetectedFramework[]): number | undefined {
  const names = new Set(frameworks.map((f) => f.name));
  if (["next", "nuxt", "remix", "react-router"].some((n) => names.has(n))) return 3000;
  if (names.has("sveltekit") || names.has("astro")) return 3000;
  if (["express", "fastify", "nestjs", "hono", "koa"].some((n) => names.has(n))) return 3000;
  if (names.has("fastapi") || names.has("django")) return 8000;
  if (names.has("flask")) return 5000;
  if (names.has("rails")) return 3000;
  if (names.has("laravel")) return 8000;
  // `yarn rw serve api` listens on 8911 by default.
  if (names.has("redwood")) return 8911;
  return undefined;
}
