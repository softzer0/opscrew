import type { Architecture, PlatformExport } from "@opscrew/plan-schema";
import {
  APP_KIND_LABELS,
  frameworkName,
  languageName,
  listText,
  PLATFORM_NAMES,
  SERVICE_NAMES,
} from "./summary";

const PLATFORM_NOTES: Record<Exclude<PlatformExport, "none">, string> = {
  lovable:
    "Lovable apps are usually Vite + React static sites that talk to Supabase from the browser. " +
    "Only the Supabase URL and publishable (anon) key belong in client code; the service-role key " +
    "must never be bundled. The `lovable-tagger` package is only used in development builds.",
  bolt:
    "Bolt projects run in a browser sandbox while you build them. Check that the start command " +
    "and port work outside Bolt and remove the `.bolt/` folder from the production image.",
  replit:
    "Replit projects often rely on `.replit` and `replit.nix` for their run command and on " +
    "Replit Secrets for configuration. Those files are ignored in production; the run command " +
    "and environment variables must be set explicitly.",
  v0:
    "v0 projects are Next.js apps with shadcn/ui components. They deploy like any Next.js app " +
    'once `output: "standalone"` is set for the container build.',
  base44:
    "Base44 apps use the `@base44/sdk` package to talk to Base44's hosted backend. That backend " +
    "keeps running on Base44; only the frontend is deployed to your server.",
};

const cell = (text: string) => text.replace(/\|/g, "\\|");
const code = (text: string) => `\`${text}\``;
const orNone = (value: string | undefined, none = "not detected") =>
  value === undefined ? none : code(value);

/**
 * Renders `opscrew/ARCHITECTURE.md`: Overview, Stack, Build and run, Configuration (environment
 * variable names, client-exposed ones marked), Services, Platform export notes and Risks, with a
 * generated-by footer. Contains names only, never values.
 */
export function renderArchitectureMarkdown(architecture: Architecture): string {
  const { facts } = architecture;
  const lines: string[] = [];
  const push = (...items: string[]) => lines.push(...items);

  push(`# Architecture: ${facts.name}`, "");

  push("## Overview", "", architecture.summary, "");
  if (architecture.aiEnriched) {
    push("_The summary and risks were refined by the OpsCrew Analyst (AI, read-only)._", "");
  }

  push("## Stack", "");
  push(`- App kind: ${APP_KIND_LABELS[facts.appKind]} (${code(facts.appKind)})`);
  push(
    `- Languages: ${facts.languages.length > 0 ? listText(facts.languages.map(languageName)) : "not detected"}`,
  );
  const frameworks = facts.frameworks.map((f) => {
    const version = f.version !== undefined ? ` ${f.version}` : "";
    const where = f.path !== "." ? ` in ${code(f.path)}` : "";
    return `${frameworkName(f.name)}${version}${where}`;
  });
  push(`- Frameworks: ${frameworks.length > 0 ? frameworks.join(", ") : "none detected"}`);
  push(`- Package manager: ${facts.packageManager}`);
  const runtimes = [
    facts.runtimeVersions.node !== undefined ? `Node.js ${facts.runtimeVersions.node}` : undefined,
    facts.runtimeVersions.python !== undefined
      ? `Python ${facts.runtimeVersions.python}`
      : undefined,
  ].filter((r): r is string => r !== undefined);
  if (runtimes.length > 0) push(`- Runtime versions: ${runtimes.join(", ")}`);
  push(`- Monorepo: ${facts.monorepo ? "yes" : "no"}`, "");

  push("## Build and run", "");
  push(`- Install: ${orNone(facts.build.installCommand)}`);
  push(`- Build: ${orNone(facts.build.buildCommand)}`);
  push(`- Start: ${orNone(facts.build.startCommand)}`);
  if (facts.build.outputDir !== undefined)
    push(`- Output directory: ${code(facts.build.outputDir)}`);
  push(`- Port: ${facts.port !== undefined ? String(facts.port) : "not detected"}`);
  push(`- Health endpoint: ${orNone(facts.healthEndpoint, "none found")}`);
  push(`- Dockerfile: ${orNone(facts.docker.dockerfile, "none")}`);
  push(`- .dockerignore: ${orNone(facts.docker.dockerignore, "none")}`);
  if (facts.docker.compose !== undefined) push(`- Compose file: ${code(facts.docker.compose)}`);
  push("");

  push("## Configuration", "");
  if (facts.envVars.length === 0) {
    push("No environment variables were detected.", "");
  } else {
    push(
      "Environment variables the app reads (names only; OpsCrew never records values). " +
        "**Client-exposed** variables are bundled into code that runs in the browser.",
      "",
      "| Name | Client-exposed | Looks secret | Used in |",
      "| --- | --- | --- | --- |",
    );
    for (const v of facts.envVars) {
      const exposed = v.clientExposed ? "**yes**" : "no";
      const secret = v.secretLikely ? "yes" : "no";
      const files = v.files.length > 0 ? v.files.map((f) => code(cell(f))).join(", ") : "-";
      push(`| ${code(v.name)} | ${exposed} | ${secret} | ${files} |`);
    }
    push("");
  }

  push("## Services", "");
  if (facts.services.length === 0) {
    push("No backing services were detected.", "");
  } else {
    for (const s of facts.services) {
      const evidence =
        s.evidence.length > 0 ? ` (evidence: ${s.evidence.map(code).join(", ")})` : "";
      push(`- ${SERVICE_NAMES[s.kind]}${evidence}`);
    }
    push("");
  }

  push("## Platform export notes", "");
  const platform = facts.platformExport.platform;
  if (platform === "none") {
    push("The code does not look like an export from a hosted app builder.", "");
  } else {
    const evidence = facts.platformExport.evidence;
    const why = evidence.length > 0 ? ` (evidence: ${evidence.map(code).join(", ")})` : "";
    push(`Exported from ${PLATFORM_NAMES[platform]}${why}.`, "", PLATFORM_NOTES[platform], "");
  }

  push("## Risks", "");
  if (architecture.risks.length === 0) push("No deployment risks were found.");
  else for (const risk of architecture.risks) push(`- ${risk}`);
  push("");

  push(
    "---",
    "",
    `_Generated by OpsCrew ${architecture.generator.version} on ${architecture.generatedAt}. ` +
      "Run `opscrew analyze` to regenerate it; the data is in `opscrew/architecture.json`._",
    "",
  );
  return lines.join("\n");
}
