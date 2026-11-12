import type { IsoDateTime } from "./common";

/**
 * Hosting accounts (feature 027, ADR 0030): a shared hosting account reached through its control
 * panel's API. One contract, three implementations (`@opscrew/connector-cpanel`, `-plesk`,
 * `-directadmin`); SFTP-only hosts have no panel and don't implement it.
 */

/** The control panels OpsCrew reaches a hosting account through. */
export type HostingPanelKind = "cpanel" | "plesk" | "directadmin";

/**
 * How to reach a panel, read from the environment on the user's computer only (`OPSCREW_HOSTING_*`)
 * and never written anywhere. The token is registered with the redactor when it is read.
 */
export interface HostingPanelAccess {
  /** The panel's address, `https://<host>:<port>`. */
  url: string;
  /** The account's user name. */
  user: string;
  /** cPanel: an API token; Plesk: an API key or the customer's password; DirectAdmin: a login key. */
  token: string;
}

/** A domain name the account serves, as the panel lists it. */
export interface HostingDomain {
  name: string;
  kind: "main" | "addon" | "subdomain" | "parked";
  /** Relative to the account's home folder. */
  documentRoot?: string;
}

/** What design shows and checks before anything changes on the account (read-only calls only). */
export interface HostingFacts {
  panel: HostingPanelKind;
  panelVersion?: string;
  domains: HostingDomain[];
  /** The addresses the account's sites answer on, for a DNS record OpsCrew makes elsewhere. */
  addresses: string[];
  /** Absent when the panel doesn't say; `limitMb` absent means unlimited. */
  quota?: { usedMb: number; limitMb?: number };
  databases: {
    engines: ("mariadb" | "mysql" | "postgres")[];
    /** The prefix every database and database user gets (`<user>_` on cPanel). */
    prefix?: string;
    maxDatabaseName?: number;
    maxUserName?: number;
  };
  /** The panel's app support (cPanel's Application Manager and CloudLinux's selectors). */
  apps: { selectors: ("nodejs" | "python")[]; slotsLeft?: number };
  /** PHP versions the panel can set per hostname (cPanel's MultiPHP); empty when it can't. */
  phpPerHostname: string[];
  /**
   * Where a new hostname's document root can be: `anywhere` under the home folder (cPanel with
   * "Restrict document roots to public_html" off), only inside `public_html` (on), or only where
   * the `panel` puts it (DirectAdmin). Outside `anywhere`, OpsCrew serves the release through a link
   * at the root the panel takes.
   */
  documentRoots: "anywhere" | "public_html" | "panel";
}

/**
 * The changes a panel can make through its API. Whatever a panel can't do is a step the user takes
 * in the panel, shown in the hosting plan with its exact text.
 */
export type HostingOperation =
  | "addHostname"
  | "removeHostname"
  | "addDatabase"
  | "removeDatabase"
  | "addCron"
  | "removeCron"
  | "writeFile"
  | "uploadTar"
  | "remove"
  | "requestCertificate"
  | "removeCertificate"
  | "setPhpVersion";

/**
 * A step the user takes in the panel because its API can't. `panelStep`'s details use these keys:
 * `hostname` and `documentRoot` (hostnames), `name` and `user` (databases), `schedule` and
 * `command` (cron), `key` (removing a cron line), `path` and `mode` (files; never a file's
 * content), `folder` and `file` (tars), `id` (certificates), `version` (PHP).
 */
export interface PanelStep {
  operation: HostingOperation;
  /** What to do, in plain English ("Add this scheduled task"). */
  what: string;
  /** Where in the panel ("Websites & Domains → Scheduled Tasks"). */
  where: string;
  /** The exact value to enter, when there is one (a cron line, a document root). */
  value?: string;
}

export interface HostingCronJob {
  /** The panel's own key for the line (cPanel's `linekey`). */
  key: string;
  schedule: string;
  command: string;
}

export interface HostingCertificate {
  hostname: string;
  /** A valid certificate covering the hostname is installed. */
  installed: boolean;
  notAfter?: IsoDateTime;
  /** The panel's id for it, used to remove it after the hostname. */
  id?: string;
  /** Whether the panel is issuing one now (cPanel's AutoSSL check in progress). */
  inProgress: boolean;
  /** The panel's reason when it can't issue one (the hostname's DNS points elsewhere, …). */
  problem?: string;
}

/**
 * Files in a hosting account, by the panel's API or over SFTP (`@opscrew/connector-sftp`, for a
 * panel whose API has no file calls, such as Plesk's: one without `writeFile` in its `operations`
 * refuses every file call). Paths are relative to the account's home folder and never contain `..`.
 */
export interface HostingFiles {
  /**
   * Writes a file with the given mode (0600 for values), into an existing folder: under a
   * temporary name, then renamed. A new name appears whole; an existing file is replaced.
   */
  writeFile(path: string, content: Uint8Array, mode: number): Promise<void>;
  /**
   * Uploads a tar and unpacks it into `folder`, then removes the tar. `folder` may be `"."`, the
   * home folder itself (the only path that may name it), so one tar makes a new folder tree.
   */
  uploadTar(folder: string, tar: Uint8Array): Promise<void>;
  /** A small text file's content, or undefined when it doesn't exist. */
  readFile(path: string): Promise<string | undefined>;
  /**
   * The names directly in `folder` (files, folders and links, hidden ones included, without `.`
   * and `..`), or undefined when the folder doesn't exist.
   */
  list(folder: string): Promise<string[] | undefined>;
  /** Removes a file, or a folder with everything in it. */
  remove(path: string): Promise<void>;
}

/**
 * A hosting account's panel. Every answer is validated with zod and the panel's own success flag is
 * read (cPanel answers HTTP 200 for failures); a failure is an `OpsCrewError` `PROVIDER_ERROR`
 * carrying the panel's reason and never the token. A change outside `operations`, its file calls
 * included, is refused with `INVALID_INPUT` and sends nothing.
 */
export interface HostingPanel extends HostingFiles {
  readonly kind: HostingPanelKind;
  readonly operations: ReadonlySet<HostingOperation>;
  /** The step the user takes in the panel for an operation outside `operations`. */
  panelStep(operation: HostingOperation, details: Readonly<Record<string, string>>): PanelStep;

  inspect(): Promise<HostingFacts>;

  /** The hostname's document root, or undefined when the account doesn't serve it. */
  documentRoot(hostname: string): Promise<string | undefined>;
  /**
   * Adds the hostname and answers the document root the panel made: `documentRoot` where the panel
   * takes one (`documentRoots` `anywhere` or `public_html`), the panel's own where it chooses
   * (`panel`, called without one).
   */
  addHostname(hostname: string, documentRoot?: string): Promise<string>;
  removeHostname(hostname: string): Promise<void>;

  /** Full names, prefix included. */
  listDatabases(): Promise<string[]>;
  /** Makes the database and its user and grants the user every privilege on it. */
  addDatabase(input: { name: string; user: string; password: string }): Promise<void>;
  /** Removes the user and the database, and checks the database is gone. */
  removeDatabase(input: { name: string; user: string }): Promise<void>;

  /** Undefined when the panel's API can't list them. */
  listCron(): Promise<HostingCronJob[] | undefined>;
  addCron(input: { schedule: string; command: string }): Promise<HostingCronJob>;
  removeCron(key: string): Promise<void>;

  /** Undefined when the panel's API can't read it (Plesk's customer API). */
  certificate(hostname: string): Promise<HostingCertificate | undefined>;
  requestCertificate(hostname: string): Promise<void>;
  removeCertificate(id: string): Promise<void>;

  /** Sets one hostname's PHP version (cPanel's MultiPHP); only where `inspect()` lists versions. */
  setPhpVersion(hostname: string, version: string): Promise<void>;
}
