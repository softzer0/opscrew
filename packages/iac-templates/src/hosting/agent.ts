import { ENVIRONMENT_NAME_PATTERN, OpsCrewError } from "@opscrew/core";
import { shellQuote } from "../runtime/services";

export { AGENT_SH } from "./agent/script";

/**
 * One app's environment on a hosting account, as the agent reads it from `settings.sh` (027 plan
 * 3). It holds no secret: the app's values and the database's password stay in 0600 files in
 * `shared/`.
 */
export interface AgentSettings {
  /** The app's name (the plan's `app.name` rule); with the environment, its folder `~/opscrew/<app>-<env>/`. */
  app: string;
  environment: string;
  /** The hostname the app answers on (the plan's `dns.domain`). */
  hostname: string;
  /** The GitHub repository, `owner/name`. */
  repository: string;
  /** The branch the workflow publishes the releases on (`opscrew/release/<env>`, `opscrew/release/<key>-<env>`). */
  releaseBranch: string;
  /** The folder inside a release the hostname serves: `public`, or `.` for the release itself. */
  webRoot: string;
  /** The path the agent asks for after a switch, from `/`. */
  healthPath: string;
  appKind: "static" | "php" | "node" | "python";
  /**
   * A PHP app's CLI, the version the plan chose (`/opt/alt/php85/usr/bin/php`); PHP apps only.
   * Absent before the agent's first report lets provision choose one: the agent then runs no PHP
   * release command.
   */
  phpCli?: string;
  /** The handler line's type when the hostname gets its PHP through one (`application/x-httpd-alt-php85___lsphp`). */
  phpHandler?: string;
  /** The release command, run in the release's folder; `php` in it is {@link phpCli}. */
  releaseCommand?: string;
  /** Paths in each release linked to `shared/`: `.env`, Laravel's `storage` and the plan's kept folders. */
  sharedPaths: readonly string[];
  /** How many releases are kept besides the running one. */
  keep: number;
  /** A dump of the database before each release (ADR 0028 D7). */
  snapshots: boolean;
  /** The database's full name, the account's prefix included; absent without one. */
  database?: string;
  /** A Node.js or Python app's version in CloudLinux's selector (`22`, `3.12`); those apps only. */
  runtimeVersion?: string;
  /**
   * The file a Node.js or Python app starts from, in the release; the selector runs it as
   * `current/<file>` from `app/`. Those apps only.
   */
  startupFile?: string;
}

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const RELEASE_BRANCH = /^opscrew\/release\/[a-z0-9][a-z0-9-]{0,62}$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/?=&%-]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PHP_HANDLER = /^application\/x-httpd-[a-z0-9_-]+$/;
const DATABASE = /^[A-Za-z0-9_]{1,64}$/;
const APP_KINDS = ["static", "php", "node", "python"];
const RUNTIME_VERSION = /^\d+(?:\.\d+){0,2}$/;

/** Each `/`-separated part a name, none `.` or `..`. */
function isPath(value: string): boolean {
  return value.split("/").every((part) => PATH_SEGMENT.test(part) && part !== "." && part !== "..");
}

/** The first field of `settings` that doesn't have its form, with what it must be. */
function problemOf(s: AgentSettings): [field: string, rule: string] | undefined {
  const php = s.appKind === "php";
  const selected = s.appKind === "node" || s.appKind === "python";
  const checks: [field: string, ok: boolean, rule: string][] = [
    ["app", APP_NAME.test(s.app), "1-41 lower-case letters, digits or hyphens"],
    ["environment", ENVIRONMENT_NAME_PATTERN.test(s.environment), "an environment's name"],
    ["hostname", HOSTNAME.test(s.hostname), "a lower-case hostname"],
    ["repository", REPOSITORY.test(s.repository), "a GitHub repository, owner/name"],
    ["releaseBranch", RELEASE_BRANCH.test(s.releaseBranch), "opscrew/release/<name>"],
    ["webRoot", s.webRoot === "." || isPath(s.webRoot), '"." or a relative path without ".."'],
    ["healthPath", HEALTH_PATH.test(s.healthPath), "a path from /"],
    ["appKind", APP_KINDS.includes(s.appKind), APP_KINDS.join(", ")],
    [
      "phpCli",
      s.phpCli === undefined || (php && /^\/./.test(s.phpCli) && isPath(s.phpCli.slice(1))),
      "an absolute path for a PHP app (or absent until its version is chosen), absent otherwise",
    ],
    [
      "phpHandler",
      s.phpHandler === undefined || (php && PHP_HANDLER.test(s.phpHandler)),
      "application/x-httpd-<handler> for a PHP app, or absent",
    ],
    [
      "releaseCommand",
      s.releaseCommand === undefined ||
        (s.releaseCommand.trim() !== "" &&
          s.releaseCommand.length <= 1000 &&
          // biome-ignore lint/suspicious/noControlCharactersInRegex: a command must have none.
          !/[\u0000-\u001f\u007f]/.test(s.releaseCommand)),
      "one line of at most 1,000 characters, or absent",
    ],
    [
      "sharedPaths",
      s.sharedPaths.every(isPath) && new Set(s.sharedPaths).size === s.sharedPaths.length,
      "distinct relative paths without . or ..",
    ],
    [
      "keep",
      Number.isInteger(s.keep) && s.keep >= 1 && s.keep <= 10,
      "a whole number from 1 to 10",
    ],
    [
      "database",
      s.database === undefined || DATABASE.test(s.database),
      "a database's name, or absent",
    ],
    [
      "runtimeVersion",
      selected ? RUNTIME_VERSION.test(s.runtimeVersion ?? "") : s.runtimeVersion === undefined,
      "a version such as 22 or 3.12 for a Node.js or Python app, absent otherwise",
    ],
    [
      "startupFile",
      selected ? isPath(s.startupFile ?? "") : s.startupFile === undefined,
      "a relative path without . or .. for a Node.js or Python app, absent otherwise",
    ],
  ];
  const failed = checks.find(([, ok]) => !ok);
  return failed && [failed[0], failed[2]];
}

/**
 * The agent's `settings.sh` for one app's environment (committed as `opscrew/hosting/<env>.sh`):
 * one single-quoted assignment per line, which the agent sources. Every value is checked against
 * its form first, so nothing else reaches it.
 *
 * @throws OpsCrewError `INVALID_INPUT` naming the first field without its form.
 */
export function renderAgentSettings(settings: AgentSettings): string {
  const problem = problemOf(settings);
  if (problem !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The hosting agent's setting ${problem[0]} must be ${problem[1]}.`,
    );
  }
  const values: [name: string, value: string][] = [
    ["APP", settings.app],
    ["ENVIRONMENT", settings.environment],
    ["HOST_NAME", settings.hostname],
    ["REPOSITORY", settings.repository],
    ["RELEASE_BRANCH", settings.releaseBranch],
    ["WEB_ROOT", settings.webRoot],
    ["HEALTH_PATH", settings.healthPath],
    ["APP_KIND", settings.appKind],
    ["PHP_CLI", settings.phpCli ?? ""],
    ["PHP_HANDLER", settings.phpHandler ?? ""],
    ["RELEASE_COMMAND", settings.releaseCommand ?? ""],
    ["SHARED_PATHS", settings.sharedPaths.join(" ")],
    ["KEEP", String(settings.keep)],
    ["SNAPSHOTS", settings.snapshots ? "yes" : "no"],
    ["DATABASE", settings.database ?? ""],
    ["RUNTIME_VERSION", settings.runtimeVersion ?? ""],
    ["STARTUP_FILE", settings.startupFile ?? ""],
  ];
  return [
    `# OpsCrew's agent settings for ${settings.app} in ${settings.environment}, rendered by OpsCrew. No secret.`,
    ...values.map(([name, value]) => `${name}=${shellQuote(value)}`),
    "",
  ].join("\n");
}
