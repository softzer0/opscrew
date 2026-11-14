/**
 * The PHP a hostname gets on a hosting account (027 plan 5, ADR 0030 D8, research R11), chosen from
 * what the app needs (`detectPhpNeeds`) and the PHP CLIs the agent's first report found, and the
 * app's cron lines run with that PHP. OpsCrew never changes the account's own version.
 */
import type { HostingPanelKind } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import type { PhpNeeds } from "@opscrew/detect";
import { HOSTING_PHP_VERSIONS } from "@opscrew/iac-templates";
import { satisfiesRange, type Version } from "../adapt/npm-range";
import { PANEL_NAMES } from "./panels";

/** A PHP CLI on the account, as the agent's report gives it. */
export interface PhpBinary {
  path: string;
  /** `major.minor.patch`, from the first line of its `-v`. */
  version: string;
  /** Its `-m` modules, lower-case, spaces as `-` (`zend-opcache`), as Composer names them. */
  modules: readonly string[];
}

/** The hostname's PHP: its version, how the hostname gets it, and that version's CLI. */
export interface PhpChoice {
  /** `major.minor`. */
  version: string;
  via: "account" | "multiphp" | "handler";
  /** The CLI the release command and the cron jobs run with. */
  cli: string;
  /** The handler line's type, with `via: "handler"`. */
  handler?: string;
  /**
   * The user sets the version in the panel (Plesk's and DirectAdmin's user APIs can't), as a
   * step in the panel; verify checks it.
   */
  panelStep?: true;
}

/** The account's own PHP CLI, the version every site of the account runs unless set otherwise. */
const ACCOUNT_CLI = "/usr/local/bin/php";
/** CloudLinux's alt-php CLIs, which a hostname reaches through a handler line on LiteSpeed. */
const ALT_PHP = /^\/opt\/alt\/php(\d)(\d+)\/usr\/bin\/php$/;
/** cPanel's MultiPHP (EasyApache) CLIs. */
const EA_PHP = /^\/opt\/cpanel\/ea-php(\d)(\d+)\/root\/usr\/bin\/php$/;
/** The CLIs of the versions Plesk and DirectAdmin set per domain. */
const PANEL_PHP: Readonly<Record<Exclude<HostingPanelKind, "cpanel">, RegExp>> = {
  plesk: /^\/opt\/plesk\/php\/(\d)\.(\d+)\/bin\/php$/,
  directadmin: /^\/usr\/local\/php(\d)(\d+)\/bin\/php$/,
};

/** `PHP 8.5.12 (cli) (built: …)` → `8.5.12`. */
export function phpVersionOf(line: string): string | undefined {
  return /^PHP (\d+\.\d+\.\d+)/.exec(line.trim())?.[1];
}

/** `major.minor` of `major.minor.patch`. */
const minorOf = (version: string) => version.split(".").slice(0, 2).join(".");

/** `a` before `b` by their numbers. */
const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * True when Composer's PHP constraint (`^8.1`, `>=7.4 <8.3`, `^7.4|^8.0`, `8.2.*`) allows
 * `version`; a constraint OpsCrew can't read counts as allowed, since the workflow's Composer
 * still checks it.
 */
export function constraintAllows(constraint: string | undefined, version: string): boolean {
  if (constraint === undefined) return true;
  const range = constraint
    .replace(/\s*\|\|?\s*/g, " || ")
    .replace(/\s*,\s*/g, " ")
    .replace(/\.\*/g, ".x");
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const parts: Version = [major, minor, patch];
  return satisfiesRange(range, parts) ?? true;
}

/** The extensions of `needs` that `binary` doesn't load. */
function missingExtensions(needs: PhpNeeds, binary: PhpBinary): string[] {
  const loaded = new Set(binary.modules);
  return needs.extensions.filter((extension) => !loaded.has(extension));
}

/** True when `binary` runs the app: its version allowed, built by the workflow, every extension. */
function fits(needs: PhpNeeds, binary: PhpBinary): boolean {
  return (
    HOSTING_PHP_VERSIONS.includes(minorOf(binary.version)) &&
    constraintAllows(needs.php, binary.version) &&
    missingExtensions(needs, binary).length === 0
  );
}

/** The oldest of `binaries` matching `pattern` that runs the app. */
function oldestFitting(
  binaries: readonly PhpBinary[],
  pattern: RegExp,
  needs: PhpNeeds,
): PhpBinary | undefined {
  return binaries
    .filter((binary) => pattern.test(binary.path) && fits(needs, binary))
    .sort((a, b) => byVersion(a.version, b.version))[0];
}

/** What {@link choosePhp} looks at. */
export interface PhpChoiceInput {
  needs: PhpNeeds;
  binaries: readonly PhpBinary[];
  panel: HostingPanelKind;
  /** The versions cPanel's MultiPHP sets per hostname (`inspect()`'s `phpPerHostname`). */
  phpPerHostname: readonly string[];
  /** The web server the account's main domain names (`LiteSpeed`, `Apache`). */
  webServer?: string;
}

/**
 * The hostname's PHP, in plan 5's order:
 * 1. the account's own version (`/usr/local/bin/php`), when it runs the app;
 * 2. on cPanel, the oldest MultiPHP version that does (set through `LangPHP`); on Plesk and
 *    DirectAdmin, the oldest of their per-domain versions the report found, which the user sets in
 *    the panel;
 * 3. on CloudLinux behind LiteSpeed, the oldest alt-php version whose default extensions cover the
 *    app, through its hostname's handler line;
 * 4. otherwise provision stops ({@link phpRefusal}).
 *
 * A version runs the app when Composer's constraint allows it, its CLI loads every extension the
 * app needs, and the deploy workflow builds with it.
 */
export function choosePhp(input: PhpChoiceInput): PhpChoice | undefined {
  const { needs, binaries } = input;
  const account = binaries.find((binary) => binary.path === ACCOUNT_CLI);
  if (account !== undefined && fits(needs, account)) {
    return { version: minorOf(account.version), via: "account", cli: account.path };
  }
  if (input.panel === "cpanel") {
    const offered = new Set(input.phpPerHostname);
    const multi = oldestFitting(
      binaries.filter((binary) => offered.has(minorOf(binary.version))),
      EA_PHP,
      needs,
    );
    if (multi !== undefined) {
      return { version: minorOf(multi.version), via: "multiphp", cli: multi.path };
    }
  } else {
    const own = oldestFitting(binaries, PANEL_PHP[input.panel], needs);
    if (own !== undefined) {
      return { version: minorOf(own.version), via: "multiphp", cli: own.path, panelStep: true };
    }
  }
  if (input.webServer === "LiteSpeed") {
    const alt = oldestFitting(binaries, ALT_PHP, needs);
    const match = alt === undefined ? null : ALT_PHP.exec(alt.path);
    if (alt !== undefined && match !== null) {
      return {
        version: minorOf(alt.version),
        via: "handler",
        cli: alt.path,
        handler: `application/x-httpd-alt-php${match[1]}${match[2]}___lsphp`,
      };
    }
  }
  return undefined;
}

/**
 * Plan 5 step 4: no PHP on the account runs the app. It names what the app needs, the account's
 * version, and the two ways out; OpsCrew never changes the account's version itself.
 */
export function phpRefusal(
  input: Pick<PhpChoiceInput, "needs" | "binaries" | "panel">,
): OpsCrewError {
  const { needs, binaries } = input;
  const wants = `PHP${needs.php === undefined ? "" : ` ${needs.php}`}${needs.extensions.length === 0 ? "" : ` with ${listText(needs.extensions)}`}`;
  const account = binaries.find((binary) => binary.path === ACCOUNT_CLI);
  const has =
    account === undefined
      ? "OpsCrew's agent found no PHP of the account's own at /usr/local/bin/php"
      : `the account runs PHP ${account.version}${missingExtensions(needs, account).length === 0 ? "" : `, without ${listText(missingExtensions(needs, account))}`}`;
  const others = binaries
    .filter((binary) => binary !== account)
    .map((binary) => minorOf(binary.version))
    .sort(byVersion);
  const found =
    others.length === 0
      ? ""
      : ` The other versions the agent found (${listText([...new Set(others)])}) don't run it for one hostname: each lacks the version or an extension the app needs, or the account can't give it to one hostname.`;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The app needs ${wants}, and ${has}.${found} OpsCrew never changes the account's PHP version, so it stopped before making the hostname or the database.`,
    {
      hint: `Choose the version the app needs with ${PANEL_NAMES[input.panel]}'s PHP selector (every site on the account changes with it), or ask your host for PHP per site (CloudLinux Isolates), then run \`opscrew provision\` again. Or choose a server target with \`opscrew interview\`.`,
    },
  );
}

/** `path` in the app's folder `folder` (from the home folder), quoted: `"$HOME/<folder>/<path>"`. */
const home = (folder: string, path: string) => `"$HOME/${folder}/${path}"`;

/**
 * The cron line of an app's scheduled `command` (plan 5): run in the running release with the
 * chosen PHP's CLI, never the account's `/usr/bin/php` (cron's `PATH` finds the account's own,
 * R10), the app's settings loaded first (`shared/env.php`) for a plain PHP app, and its output
 * appended to `state/cron.log`. A command that doesn't start with `php` runs as written.
 */
export function appCronCommand(input: {
  folder: string;
  command: string;
  cli: string | undefined;
  envPhp: boolean;
}): string {
  const { folder, cli } = input;
  const php = /^php\s+(.+)$/.exec(input.command.trim());
  const run =
    php !== null && cli !== undefined
      ? `${cli}${input.envPhp ? ` -d auto_prepend_file=${home(folder, "shared/env.php")}` : ""} ${php[1]}`
      : input.command.trim();
  return `cd ${home(folder, "current")} && ${run} >> ${home(folder, "state/cron.log")} 2>&1`;
}

/** The agent's cron line's command (plan 2): every minute, its output appended to `state/agent.log`. */
export function agentCronCommand(folder: string): string {
  return `/bin/bash ${home(folder, "agent.sh")} >> ${home(folder, "state/agent.log")} 2>&1`;
}

/** The agent's schedule: every minute (decision 6). */
export const AGENT_SCHEDULE = "* * * * *";

/** The agent's cron line, `<schedule> <command>`, as the record keeps it. */
export const agentCronLine = (folder: string) => `${AGENT_SCHEDULE} ${agentCronCommand(folder)}`;

/** A cron line `<schedule> <command>` as a panel's cron step names it. */
export function cronDetails(line: string): Record<string, string> {
  const [, schedule = "", command = ""] = /^(\S+(?: \S+){4}) (.+)$/.exec(line) ?? [];
  return { key: line, schedule, command };
}
