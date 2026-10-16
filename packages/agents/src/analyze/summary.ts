import { listText, plural } from "@opscrew/core";
import type { AppKind, PlatformExport, ProjectFacts, ServiceKind } from "@opscrew/plan-schema";

/** Plain-English summary and deployment risks of a project. */
export interface FactsSummary {
  summary: string;
  risks: string[];
}

/** Extra detection context for {@link summarizeFacts}. */
export interface SummarizeOptions {
  /** Deployable app directories when a monorepo has several (from `detectProjectDetails`). */
  appCandidates?: readonly string[];
}

const FRAMEWORK_NAMES: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  remix: "Remix",
  sveltekit: "SvelteKit",
  astro: "Astro",
  vite: "Vite",
  "create-react-app": "Create React App",
  angular: "Angular",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  solid: "Solid",
  preact: "Preact",
  express: "Express",
  fastify: "Fastify",
  nestjs: "NestJS",
  hono: "Hono",
  koa: "Koa",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  rails: "Rails",
  laravel: "Laravel",
};

const LANGUAGE_NAMES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  ruby: "Ruby",
  php: "PHP",
  java: "Java",
  rust: "Rust",
  other: "other languages",
};

/** Short label for each app kind, used in reports. */
export const APP_KIND_LABELS: Record<AppKind, string> = {
  "static-spa": "static single-page app",
  ssr: "server-rendered web app",
  api: "API server",
  fullstack: "full-stack web app",
  worker: "background worker",
  unknown: "unknown",
};

/** Display names of builder platforms. */
export const PLATFORM_NAMES: Record<Exclude<PlatformExport, "none">, string> = {
  lovable: "Lovable",
  bolt: "Bolt",
  replit: "Replit",
  v0: "v0",
  base44: "Base44",
};

/** Display names of backing services. */
export const SERVICE_NAMES: Record<ServiceKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  sqlite: "SQLite",
  supabase: "Supabase",
  firebase: "Firebase",
  s3: "S3-compatible object storage",
  stripe: "Stripe",
  email: "an email service",
  queue: "a job queue",
  websocket: "WebSockets",
  cron: "scheduled jobs",
};

/** Display name of a detected framework (`next` → `Next.js`). */
export function frameworkName(name: string): string {
  return FRAMEWORK_NAMES[name] ?? name;
}

/** Display name of a language (`typescript` → `TypeScript`). */
export function languageName(name: string): string {
  return LANGUAGE_NAMES[name] ?? name;
}

/** The app kind in a sentence: `an API server`, `an app of unknown type`. */
function appKindText(kind: AppKind): string {
  if (kind === "unknown") return "an app of unknown type";
  const label = APP_KIND_LABELS[kind];
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/** App kinds that serve HTTP from their own process and so need a health endpoint. */
const SERVER_KINDS: ReadonlySet<AppKind> = new Set(["ssr", "api", "fullstack"]);

/**
 * Deterministic plain-English summary and deployment risks for detected facts. Never includes
 * values, only names (environment variables, files, services).
 */
export function summarizeFacts(facts: ProjectFacts, options: SummarizeOptions = {}): FactsSummary {
  return { summary: summaryText(facts, options), risks: risksFor(facts, options) };
}

/** True when a monorepo has several deployable apps and the facts describe the repository root. */
function severalApps(options: SummarizeOptions): boolean {
  return (options.appCandidates?.length ?? 0) > 1;
}

/**
 * Plain-English list of monorepo app folders with their frameworks, for example
 * "`apps/api` (Express) and `apps/web` (Next.js and React)".
 */
export function appCandidatesText(facts: ProjectFacts, candidates: readonly string[]): string {
  return listText(
    candidates.map((dir) => {
      const names = [
        ...new Set(
          facts.frameworks.filter((f) => f.path === dir).map((f) => frameworkName(f.name)),
        ),
      ];
      return names.length > 0 ? `\`${dir}\` (${listText(names)})` : `\`${dir}\``;
    }),
  );
}

function summaryText(facts: ProjectFacts, options: SummarizeOptions): string {
  const sentences: string[] = [];
  const frameworks = [...new Set(facts.frameworks.map((f) => frameworkName(f.name)))];
  const languages = facts.languages.map(languageName);
  const candidates = options.appCandidates ?? [];
  let first: string;
  if (severalApps(options)) {
    first = `${facts.name} is a monorepo with ${candidates.length} deployable apps: ${appCandidatesText(facts, candidates)}`;
    if (languages.length > 0) first += `, written in ${listText(languages)}`;
  } else {
    first = `${facts.name} is ${appKindText(facts.appKind)}`;
    if (frameworks.length > 0) first += ` built with ${listText(frameworks)}`;
    if (languages.length > 0) {
      first +=
        frameworks.length > 0 ? ` (${listText(languages)})` : ` written in ${listText(languages)}`;
    }
  }
  sentences.push(`${first}.`);
  if (facts.platformExport.platform !== "none") {
    sentences.push(`It was exported from ${PLATFORM_NAMES[facts.platformExport.platform]}.`);
  }
  if (facts.appDir !== ".") {
    sentences.push(
      `It lives in \`${facts.appDir}\`${facts.monorepo ? " of a monorepo" : ""} and is built from the repository root.`,
    );
  } else if (facts.monorepo && !severalApps(options)) {
    sentences.push("The repository is a monorepo.");
  }
  if (facts.packageManager !== "none") {
    sentences.push(`Dependencies are installed with ${facts.packageManager}.`);
  }
  if (facts.appKind === "static-spa") {
    const out = facts.build.outputDir ? ` in \`${facts.build.outputDir}\`` : "";
    sentences.push(`It builds to static files${out} that a web server can serve.`);
  } else if (facts.port !== undefined) {
    sentences.push(`It listens on port ${facts.port}.`);
  }
  if (facts.healthEndpoint !== undefined) {
    sentences.push(`Its health check is at \`${facts.healthEndpoint}\`.`);
  }
  if (facts.services.length > 0) {
    sentences.push(`It uses ${listText(facts.services.map((s) => SERVICE_NAMES[s.kind]))}.`);
  }
  if (facts.envVars.length > 0) {
    const exposed = facts.envVars.filter((v) => v.clientExposed).length;
    const tail =
      exposed === 0
        ? ""
        : exposed === facts.envVars.length
          ? `, ${exposed === 1 ? "it is" : "all"} exposed to the browser`
          : `, ${exposed} of them exposed to the browser`;
    sentences.push(`It reads ${plural(facts.envVars.length, "environment variable")}${tail}.`);
  }
  return sentences.join(" ");
}

function risksFor(facts: ProjectFacts, options: SummarizeOptions): string[] {
  const risks: string[] = [];
  const candidates = options.appCandidates ?? [];
  if (severalApps(options)) {
    risks.push(
      `This repository contains several deployable apps (${listText(candidates.map((c) => `\`${c}\``))}). ` +
        "OpsCrew deploys one of them, so `opscrew design` stops until you choose which: answer the " +
        `question in \`opscrew interview\`, or run \`opscrew analyze --app ${candidates[0]}\`.`,
    );
  } else if (facts.appKind === "unknown") {
    risks.push(
      "OpsCrew could not tell what kind of app this is (no known web framework was found). " +
        "Check the start command and port before deploying.",
    );
  }
  if (facts.docker.dockerfile === undefined) {
    risks.push(
      "There is no Dockerfile. OpsCrew will add one when it prepares the code (`opscrew adapt`).",
    );
  }
  if (SERVER_KINDS.has(facts.appKind) && facts.healthEndpoint === undefined) {
    risks.push(
      "No health-check endpoint was found. The deployment needs one to know the app is up; " +
        "OpsCrew will propose a `/health` route.",
    );
  }
  for (const v of facts.envVars) {
    if (v.clientExposed && v.secretLikely) {
      risks.push(
        `\`${v.name}\` is exposed to the browser (its prefix bundles it into client code) but its ` +
          "name suggests a secret. Use it only in server code, rename it and rotate the value.",
      );
    }
  }
  if (facts.services.some((s) => s.kind === "sqlite")) {
    risks.push(
      "The app uses SQLite. Its data lives in one file on the server, so it needs a persistent " +
        "volume and backups, and it cannot be shared between several servers.",
    );
  }
  return risks;
}
