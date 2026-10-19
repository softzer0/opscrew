import { listText } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";
import type { Components } from "./components";

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
 * The plain-English note for a web app that runs background jobs (FR-812) for which OpsCrew found
 * no worker (no Procfile type, no library with a conventional process) and the plan has none:
 * the jobs will not run until the user adds one. `undefined` when the app has no background jobs,
 * is not deployed as a server, or detection found its workers (design names those without a
 * command itself), or the plan's `components` have one.
 */
export function backgroundJobsWarning(
  facts: ProjectFacts,
  components?: Pick<Components, "processes">,
): string | undefined {
  if (NO_WEB_PROCESS.has(facts.appKind)) return undefined;
  if ((facts.workers ?? []).length > 0 || (components?.processes.workers.length ?? 0) > 0) {
    return undefined;
  }
  const libraries = backgroundJobLibraries(facts);
  const hasQueue = facts.services.some((service) => service.kind === "queue");
  if (!hasQueue && libraries.length === 0) return undefined;
  const which = libraries.length === 0 ? "" : ` with ${listText(libraries)}`;
  return `This app also runs background jobs${which}, but OpsCrew found no worker that runs them: no Procfile type and no job library with a process of its own. The jobs will not run until you add the worker's command to processes.workers in opscrew/plan.yaml (with source: user); then run \`opscrew design\` again.`;
}
