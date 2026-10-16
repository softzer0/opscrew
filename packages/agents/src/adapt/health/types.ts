import { listText } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";
import type { PlaybookId } from "../playbooks";

/** Read-only access to the project's files (repo-relative POSIX paths). */
export interface HealthRepo {
  /** The project's files, gitignore-aware (read once, on first use). */
  files(): Promise<readonly string[]>;
  /** A file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Whether a file or folder exists. */
  exists(path: string): Promise<boolean>;
  /** Names of the sub-folders of a folder (`[]` when it is missing). */
  folders(path: string): Promise<string[]>;
}

/** What the registry needs to add the plan's health route. */
export interface HealthRouteInput {
  facts: ProjectFacts;
  /** The playbook (container stack) the app is deployed with. */
  stack: PlaybookId;
  /** The plan's path for the health-endpoint change (a file, or the app's folder). */
  path: string;
  /** The plan's health check path, e.g. `/health`. */
  healthPath: string;
  repo: HealthRepo;
}

/** A file OpsCrew writes for the health route. */
export interface HealthFile {
  path: string;
  content: string;
  /** True for a new file, false for an edit of an existing one. */
  created: boolean;
}

/** What OpsCrew does about the health route. */
export type HealthEdit =
  | {
      action: "write";
      /** The framework the route was added for (for messages). */
      framework: string;
      /** Every file written; the first is where the route lives. */
      files: HealthFile[];
      /** The file the route lives in (shown in the pull request and the commit). */
      path: string;
      note: string;
      /** Things the user should check (middleware that might protect the path …). */
      checks: string[];
      /** Set when the route may answer at another path than the plan's: what the plan must say. */
      pathNote?: string;
      /**
       * The path the route really answers at when it is not the plan's (a NestJS global prefix,
       * a Next.js basePath): adapt writes it to `app.healthPath` in the same pull request.
       */
      healthPath?: string;
    }
  /** A route for the path already exists. */
  | { action: "none"; reason: string; pathNote?: string; healthPath?: string }
  /** OpsCrew cannot tell safely where the route goes; the agent or the user adds it. */
  | { action: "manual"; reason: string };

/** Text that tells the user how to fix the plan's health path. */
export const PLAN_PATH_FIX =
  "run `opscrew design` and set it, or edit app.healthPath in `opscrew/plan.yaml`";

/** The JSON body every health route answers with. */
export const OK_BODY = '{"status":"ok"}';

/** A manual result. */
export function manual(reason: string): HealthEdit {
  return { action: "manual", reason };
}

/** Several app objects, none of them clearly the one that serves the app (`where` each). */
export function severalApps(where: readonly string[]): HealthEdit {
  return manual(
    `OpsCrew found ${where.length} app objects (${listText(where)}), so it cannot tell which one serves the app.`,
  );
}

/** The one app object, not assigned to a variable. */
export function unassignedApp(framework: string, file: string, line: number): HealthEdit {
  return manual(
    `the ${framework} app in ${file} (line ${line}) is not assigned to a variable OpsCrew can add a route to.`,
  );
}

/** The one app object, created inside a class. */
export function appInClass(framework: string, file: string, line: number): HealthEdit {
  return manual(
    `the ${framework} app in ${file} (line ${line}) is created inside a class, so OpsCrew cannot tell where a route belongs.`,
  );
}

/** The note for a route that answers at `actual` instead of the plan's `planned` path. */
export function movedPathNote(source: string, actual: string, planned: string): string {
  return `${source}, so the health route answers at ${actual}, not ${planned}: the plan's health check path must be ${actual} (${PLAN_PATH_FIX}), or every deploy fails its health check.`;
}

/** The note for a route that answers at `actual`, which adapt writes to the plan. */
export function planPathNote(source: string, actual: string): string {
  return `${source}, so the health route answers at ${actual}; OpsCrew set app.healthPath in \`opscrew/plan.yaml\` to ${actual} to match.`;
}

/** The check for middleware (or hooks) that might redirect or protect the health path. */
export function protectCheck(file: string, healthPath: string): string {
  return `Check that ${file} does not redirect or protect ${healthPath}: the deploy health check calls it without a session.`;
}

/** The note for a new route file. */
export function createdNote(path: string, healthPath: string): string {
  return `Created ${path} by OpsCrew: answers GET ${healthPath} with ${OK_BODY} for the deploy health check.`;
}

/** The note for a route added to an existing file. */
export function addedNote(path: string, healthPath: string, framework: string): string {
  return `Added GET ${healthPath} to ${path} by OpsCrew, right after the ${framework} app is created: answers ${OK_BODY} for the deploy health check.`;
}

/** The reason for an existing route. */
export function existsReason(where: string, healthPath: string): string {
  return `${where} already answers ${healthPath}; OpsCrew left it as it is.`;
}
