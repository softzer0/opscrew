import { listText } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";

/** Known background-job libraries by package name, with the name users know them by. */
const JOB_LIBRARIES: Readonly<Record<string, string>> = {
  celery: "Celery",
  rq: "RQ",
  dramatiq: "Dramatiq",
  huey: "Huey",
  arq: "arq",
  bullmq: "BullMQ",
  bull: "Bull",
  "bee-queue": "Bee-Queue",
  agenda: "Agenda",
  sidekiq: "Sidekiq",
  "@temporalio/worker": "Temporal",
};

/** App kinds OpsCrew does not run as a web process next to separate jobs. */
const NO_WEB_PROCESS = new Set<ProjectFacts["appKind"]>(["worker", "static-spa"]);

/** Package name from runtime-dependency evidence (`dependency:celery[redis]` → `celery`). */
function dependencyName(evidence: string): string | undefined {
  const match = /^dependency:([^[\s]+)/.exec(evidence);
  return match?.[1];
}

/**
 * The background-job libraries the facts show (display names, sorted), from the `queue` service's
 * runtime-dependency evidence and from the detected frameworks.
 */
export function backgroundJobLibraries(facts: ProjectFacts): string[] {
  const names = new Set<string>();
  for (const service of facts.services) {
    for (const evidence of service.evidence) {
      const name = dependencyName(evidence);
      const label = name === undefined ? undefined : JOB_LIBRARIES[name];
      if (label !== undefined) names.add(label);
    }
  }
  for (const framework of facts.frameworks) {
    const label = JOB_LIBRARIES[framework.name];
    if (label !== undefined) names.add(label);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * The plain-English note for a web app that also runs background jobs (FR-812): only the web
 * process is deployed for now, the jobs will not run until worker support arrives, and what to do
 * meanwhile. `undefined` when the app has no background jobs or is not deployed as a server.
 */
export function backgroundJobsWarning(facts: ProjectFacts): string | undefined {
  if (NO_WEB_PROCESS.has(facts.appKind)) return undefined;
  const libraries = backgroundJobLibraries(facts);
  const hasQueue = facts.services.some((service) => service.kind === "queue");
  if (!hasQueue && libraries.length === 0) return undefined;
  const which = libraries.length === 0 ? "" : ` with ${listText(libraries)}`;
  return `This app also runs background jobs${which}. OpsCrew deploys only the web process for now, so the background jobs will not run until worker support arrives. Meanwhile, run the worker yourself, for example on the same server next to the app.`;
}
