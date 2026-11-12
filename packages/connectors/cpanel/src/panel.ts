import { randomBytes } from "node:crypto";
import type {
  FetchLike,
  HostingCertificate,
  HostingCronJob,
  HostingDomain,
  HostingFacts,
  HostingOperation,
  HostingPanel,
  HostingPanelAccess,
  PanelStep,
} from "@opscrew/contracts";
import {
  errorMessage,
  normalizeHostName,
  OpsCrewError,
  orText,
  type Redactor,
} from "@opscrew/core";
import { z } from "zod";
import { type CpanelClient, CpanelRefusal, cpanelClient } from "./client";

export interface CpanelPanelOptions {
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Per request (default 60 s). */
  timeoutMs?: number;
  /** Shared redactor; a private one is used when omitted. The token is always registered. */
  redactor?: Redactor;
  /** A fresh random part for temporary file names (default: 8 random bytes as hex). */
  randomName?: () => string;
  /** Epoch milliseconds, to tell an expired certificate (default `Date.now`). */
  now?: () => number;
}

const OPERATIONS: ReadonlySet<HostingOperation> = new Set<HostingOperation>([
  "addHostname",
  "removeHostname",
  "addDatabase",
  "removeDatabase",
  "addCron",
  "removeCron",
  "writeFile",
  "uploadTar",
  "remove",
  "requestCertificate",
  "removeCertificate",
  "setPhpVersion",
]);

const num = z
  .union([z.number(), z.string()])
  .transform(Number)
  .refine((value) => Number.isFinite(value), "a number");
const flag = z.union([z.number(), z.string()]).transform(Number);
const anything = z.unknown();

const ServerSchema = z.object({
  docroots_in_public_html_only: flag.nullish(),
  mysql_version: z.string().nullish(),
});

const DOMAIN_KINDS = {
  main_domain: "main",
  addon_domain: "addon",
  sub_domain: "subdomain",
  parked_domain: "parked",
  parked_domains: "parked",
} as const satisfies Record<string, HostingDomain["kind"]>;

const DomainsSchema = z.array(
  z.object({
    domain: z.string(),
    type: z.enum(Object.keys(DOMAIN_KINDS) as [keyof typeof DOMAIN_KINDS]),
    documentroot: z.string().nullish(),
    homedir: z.string().nullish(),
    ip: z.string().nullish(),
    ipv6: z.string().nullish(),
  }),
);

const QuotaSchema = z.object({ megabytes_used: num, megabyte_limit: num });
const RestrictionsSchema = z.object({
  prefix: z.string().nullish(),
  max_database_name_length: num.nullish(),
  max_username_length: num.nullish(),
});
const FeaturesSchema = z.record(z.string(), flag);
const UserSchema = z.object({
  maximum_passenger_apps: z.union([z.literal("unlimited"), num]).nullish(),
});
const AppsSchema = z.record(z.string(), anything).nullish();
const PhpVersionsSchema = z.object({ versions: z.array(z.string()) });
const DatabasesSchema = z.array(z.object({ database: z.string() }));
const UsersSchema = z.array(z.object({ user: z.string() }));
const FilesSchema = z.array(z.object({ file: z.string(), type: z.string() }));
const ContentSchema = z.object({ content: z.string() });

const CronLineSchema = z.object({
  linekey: z.union([z.string(), z.number()]).transform(String),
  minute: z.union([z.string(), z.number()]).transform(String),
  hour: z.union([z.string(), z.number()]).transform(String),
  day: z.union([z.string(), z.number()]).transform(String),
  month: z.union([z.string(), z.number()]).transform(String),
  weekday: z.union([z.string(), z.number()]).transform(String),
  command: z.string(),
});
/** `listcron` ends with a `{count: N}` entry that is no line (R10). */
const CronListSchema = z.array(
  z.union([CronLineSchema, z.strictObject({ count: num }).transform(() => undefined)]),
);
const CronAddSchema = z.tuple(
  [z.object({ linekey: z.union([z.string(), z.number()]).transform(String) })],
  z.unknown(),
);

const KeyFields = {
  id: z.string(),
  modulus: z.string().nullish(),
  ecdsa_public: z.string().nullish(),
};
const CertificateSchema = z.object({
  ...KeyFields,
  domains: z.array(z.string()).default([]),
  not_after: num.nullish(),
  is_self_signed: flag.nullish(),
});
const InstalledHostsSchema = z.array(
  z.object({
    servername: z.string(),
    domains: z.array(z.string()).default([]),
    certificate: CertificateSchema.nullish(),
  }),
);
const ProblemsSchema = z.array(z.object({ domain: z.string(), problem: z.string() })).nullish();
const CertificatesSchema = z.array(CertificateSchema);
const KeysSchema = z.array(z.object(KeyFields));

/**
 * A name that isn't there: `get_file_content` answers "The file “…” does not exist for the
 * account." (seen live); `fileop unlink`'s wording is assumed to be that or the system's "No such
 * file or directory".
 */
const MISSING_FILE = /no such file|does not exist/i;
/** R10: a deleted database listed again answers this on `delete_database`. */
const NOT_CONTROLLED = /does not control/i;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CRON_FIELD = /^[0-9*,/-]+$/;
/** A backslash, a comma (`fileop` reads a list) or a control character in a path's name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const UNSAFE_NAME = /[\\,\x00-\x1f\x7f]/;

/** The account's domains and home folder, as `domains_data` gives them. */
interface Account {
  home: string;
  main: string;
  domains: HostingDomain[];
  addresses: string[];
}

/**
 * A cPanel account through UAPI and API2 (`@opscrew/connector-cpanel`, ADR 0030). Every operation
 * of the contract is supported, so no change is ever a panel step. Paths are relative to the
 * account's home folder; the panel turns them into the absolute paths `Fileman` takes.
 */
export class CpanelPanel implements HostingPanel {
  readonly kind = "cpanel" as const;
  readonly operations = OPERATIONS;
  readonly #client: CpanelClient;
  readonly #randomName: () => string;
  readonly #now: () => number;
  #home: string | undefined;

  constructor(access: HostingPanelAccess, options: CpanelPanelOptions = {}) {
    this.#client = cpanelClient(access, {
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.redactor && { redactor: options.redactor }),
    });
    this.#randomName = options.randomName ?? (() => randomBytes(8).toString("hex"));
    this.#now = options.now ?? Date.now;
  }

  /** cPanel's API makes every change, so asking for a panel step is a mistake in OpsCrew. */
  panelStep(operation: HostingOperation): PanelStep {
    throw new OpsCrewError(
      "INTERNAL",
      `cPanel's API makes every change OpsCrew needs, so "${operation}" has no panel step.`,
    );
  }

  async inspect(): Promise<HostingFacts> {
    const read = <S extends z.ZodType>(module: string, func: string, schema: S, what: string) =>
      this.#client.uapi({ module, func, schema, what });
    const [server, account, quota, restrictions, features] = await Promise.all([
      read("Variables", "get_server_information", ServerSchema, "read the server's settings"),
      this.#account(),
      read("Quota", "get_quota_info", QuotaSchema, "read the account's disk quota"),
      read("Mysql", "get_restrictions", RestrictionsSchema, "read the database name rules"),
      read("Features", "list_features", FeaturesSchema, "list the account's features"),
    ]);
    const on = (feature: string) => features[feature] === 1;

    let slotsLeft: number | undefined;
    if (on("passengerapps")) {
      const [user, apps] = await Promise.all([
        read("Variables", "get_user_information", UserSchema, "read the account's app limit"),
        read("PassengerApps", "list_applications", AppsSchema, "list the account's apps"),
      ]);
      const limit = user.maximum_passenger_apps;
      if (typeof limit === "number") {
        slotsLeft = Math.max(0, limit - Object.keys(apps ?? {}).length);
      }
    }
    const phpPerHostname = on("multiphp") ? [...(await this.#phpVersions()).keys()] : [];
    const engines = databaseEngines(server.mysql_version);

    return {
      panel: "cpanel",
      domains: account.domains,
      addresses: account.addresses,
      quota: {
        usedMb: quota.megabytes_used,
        ...(quota.megabyte_limit > 0 && { limitMb: quota.megabyte_limit }),
      },
      databases: {
        engines,
        ...(restrictions.prefix && { prefix: restrictions.prefix }),
        ...(restrictions.max_database_name_length != null && {
          maxDatabaseName: restrictions.max_database_name_length,
        }),
        ...(restrictions.max_username_length != null && {
          maxUserName: restrictions.max_username_length,
        }),
      },
      apps: {
        selectors: [
          ...(on("lvenodejssel") ? (["nodejs"] as const) : []),
          ...(on("lvepythonsel") ? (["python"] as const) : []),
        ],
        ...(slotsLeft !== undefined && { slotsLeft }),
      },
      phpPerHostname,
      documentRoots: server.docroots_in_public_html_only === 0 ? "anywhere" : "public_html",
    };
  }

  async documentRoot(hostname: string): Promise<string | undefined> {
    const name = checkHostname(hostname);
    const domain = (await this.#account()).domains.find((entry) => entry.name === name);
    return domain?.documentRoot;
  }

  /**
   * A subdomain (`SubDomain::addsubdomain`) for a name under one of the account's domains,
   * otherwise an addon domain (API2 `AddonDomain::addaddondomain`) whose subdomain is the name
   * with its dots as hyphens. cPanel takes the document root given, which is answered; a name the
   * account already serves, or a call without a root, is refused.
   */
  async addHostname(hostname: string, documentRoot?: string): Promise<string> {
    const name = checkHostname(hostname);
    if (documentRoot === undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `cPanel takes the document root OpsCrew gives, and none was given for ${name}.`,
      );
    }
    const dir = checkPath(documentRoot, "The document root").join("/");
    const account = await this.#account();
    if (account.domains.some((domain) => domain.name === name)) {
      throw new OpsCrewError("INVALID_INPUT", `The account already serves ${name}.`, {
        hint: "OpsCrew never takes over a hostname that exists: choose another one, or remove it in cPanel first.",
      });
    }
    const root = account.domains
      .filter((domain) => domain.kind !== "subdomain" && name.endsWith(`.${domain.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (root !== undefined) {
      await this.#client.uapi({
        module: "SubDomain",
        func: "addsubdomain",
        params: {
          domain: name.slice(0, -root.name.length - 1),
          rootdomain: root.name,
          dir,
          disallowdot: "0",
        },
        write: true,
        what: `add the subdomain ${name}`,
        schema: anything,
      });
      return dir;
    }
    await this.#client.api2({
      module: "AddonDomain",
      func: "addaddondomain",
      params: { newdomain: name, subdomain: addonLabel(name), dir },
      what: `add the addon domain ${name}`,
      schema: anything,
    });
    return dir;
  }

  /** Removes a subdomain or an addon domain; nothing when the account doesn't serve it. */
  async removeHostname(hostname: string): Promise<void> {
    const name = checkHostname(hostname);
    const account = await this.#account();
    const domain = account.domains.find((entry) => entry.name === name);
    if (domain === undefined) return;
    if (domain.kind === "subdomain") {
      await this.#client.api2({
        module: "SubDomain",
        func: "delsubdomain",
        params: { domain: name },
        what: `remove the subdomain ${name}`,
        schema: anything,
      });
    } else if (domain.kind === "addon") {
      await this.#client.api2({
        module: "AddonDomain",
        func: "deladdondomain",
        params: { domain: name, subdomain: `${addonLabel(name)}_${account.main}` },
        what: `remove the addon domain ${name}`,
        schema: anything,
      });
    } else {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${name} is the account's ${domain.kind === "main" ? "main" : "parked"} domain; OpsCrew removes only the hostnames it added.`,
      );
    }
  }

  async listDatabases(): Promise<string[]> {
    const list = await this.#client.uapi({
      module: "Mysql",
      func: "list_databases",
      what: "list the account's databases",
      schema: DatabasesSchema,
    });
    return list.map((entry) => entry.database);
  }

  async addDatabase(input: { name: string; user: string; password: string }): Promise<void> {
    this.#client.registerSecret(input.password, "database password");
    const write = (func: string, params: Record<string, string>, what: string) =>
      this.#client.uapi({ module: "Mysql", func, params, write: true, what, schema: anything });
    await write("create_database", { name: input.name }, `create the database ${input.name}`);
    await write(
      "create_user",
      { name: input.user, password: input.password },
      `create the database user ${input.user}`,
    );
    await write(
      "set_privileges_on_database",
      { user: input.user, database: input.name, privileges: "ALL PRIVILEGES" },
      `give ${input.user} every privilege on ${input.name}`,
    );
  }

  /**
   * Removes the user and the database, then lists the databases: one still or again listed (R10's
   * reappearing database, which answers "does not control" when deleted) is made and removed once
   * more, and a database listed after that is an error.
   */
  async removeDatabase(input: { name: string; user: string }): Promise<void> {
    const { name, user } = input;
    const users = await this.#client.uapi({
      module: "Mysql",
      func: "list_users",
      what: "list the account's database users",
      schema: UsersSchema,
    });
    if (users.some((entry) => entry.user === user)) {
      await this.#mysql("delete_user", user, `remove the database user ${user}`);
    }
    if ((await this.listDatabases()).includes(name)) {
      try {
        await this.#mysql("delete_database", name, `remove the database ${name}`);
      } catch (error) {
        if (!(error instanceof CpanelRefusal && NOT_CONTROLLED.test(error.reason))) throw error;
        await this.#recreateAndRemove(name);
      }
    }
    if ((await this.listDatabases()).includes(name)) {
      await this.#recreateAndRemove(name);
      if ((await this.listDatabases()).includes(name)) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `cPanel still lists the database ${name} after removing it twice.`,
          {
            hint: "Remove it in cPanel under Databases → MySQL Databases, then run the command again.",
          },
        );
      }
    }
  }

  async listCron(): Promise<HostingCronJob[]> {
    const lines = await this.#client.api2({
      module: "Cron",
      func: "listcron",
      what: "list the account's cron jobs",
      schema: CronListSchema,
    });
    return lines.flatMap((line) =>
      line === undefined
        ? []
        : [
            {
              key: line.linekey,
              schedule: `${line.minute} ${line.hour} ${line.day} ${line.month} ${line.weekday}`,
              command: line.command,
            },
          ],
    );
  }

  async addCron(input: { schedule: string; command: string }): Promise<HostingCronJob> {
    const fields = input.schedule.trim().split(/\s+/);
    if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
      throw new OpsCrewError("INVALID_INPUT", `"${input.schedule}" isn't a cron schedule.`, {
        hint: "Give five fields of digits, *, commas, slashes and hyphens, such as */5 * * * *.",
      });
    }
    if (input.command.trim() === "" || /[\r\n]/.test(input.command)) {
      throw new OpsCrewError("INVALID_INPUT", "A cron command is one line of text.");
    }
    const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
    const answer = await this.#client.api2({
      module: "Cron",
      func: "add_line",
      params: { command: input.command, minute, hour, day, month, weekday },
      what: "add a cron job",
      schema: CronAddSchema,
    });
    return { key: answer[0].linekey, schedule: fields.join(" "), command: input.command };
  }

  async removeCron(key: string): Promise<void> {
    await this.#client.api2({
      module: "Cron",
      func: "remove_line",
      params: { linekey: key },
      what: "remove a cron job",
      schema: anything,
    });
  }

  /**
   * Uploads the content under a fresh temporary name in the same folder with the mode, then renames
   * it to the target with `fileop rename`. `rename` refuses an existing name (R10), so an existing
   * target is removed first: then, for a moment, the file is missing. The temporary file is removed
   * again when a later step fails.
   */
  async writeFile(path: string, content: Uint8Array, mode: number): Promise<void> {
    const parts = checkPath(path, "A file's path");
    const name = parts.pop() as string;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new OpsCrewError("INVALID_INPUT", `${mode} isn't a file mode.`);
    }
    const dir = await this.#absolute(parts);
    const temporary = `.opscrew-${this.#randomName()}.tmp`;
    await this.#client.upload({
      dir,
      files: [{ name: temporary, content }],
      permissions: `0${mode.toString(8).padStart(3, "0")}`,
      what: `upload ${path}`,
    });
    let replaced = false;
    try {
      const existing = (await this.#list(dir, parts.join("/") || "the home folder")).find(
        (entry) => entry.file === name,
      );
      if (existing?.type === "dir") {
        throw new OpsCrewError("INVALID_INPUT", `${path} is a folder on the account, not a file.`);
      }
      if (existing !== undefined) {
        await this.#fileop("unlink", `${dir}/${name}`, `replace ${path}`);
        replaced = true;
      }
      await this.#fileop("rename", `${dir}/${temporary}`, `put ${path} in place`, `${dir}/${name}`);
    } catch (error) {
      if (replaced) {
        // The old file is gone: the temporary file holds the only copy, so it stays.
        const kept = [...parts, temporary].join("/");
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `${errorMessage(error)} The old ${path} was already removed; its new content is kept in ${kept}.`,
          { hint: `Rename ${kept} to ${path} in cPanel's File Manager, or run the command again.` },
        );
      }
      await this.#fileop("unlink", `${dir}/${temporary}`, "remove the temporary file").catch(
        () => undefined,
      );
      throw error;
    }
  }

  /** Uploads the tar into `folder` (made when missing), unpacks it there (`fileop extract`), then removes it. */
  async uploadTar(folder: string, tar: Uint8Array): Promise<void> {
    const parts = checkPath(folder, "A folder's path");
    const dir = await this.#absolute(parts);
    const name = `.opscrew-${this.#randomName()}.tar`;
    const archive = `${dir}/${name}`;
    await this.#client.upload({
      dir,
      files: [{ name, content: tar }],
      permissions: "0600",
      what: `upload the files for ${folder}`,
    });
    try {
      await this.#fileop("extract", archive, `unpack the files into ${folder}`, dir);
    } catch (error) {
      await this.#fileop("unlink", archive, "remove the uploaded archive").catch(() => undefined);
      throw error;
    }
    await this.#fileop("unlink", archive, `remove the uploaded archive from ${folder}`);
  }

  async readFile(path: string): Promise<string | undefined> {
    const parts = checkPath(path, "A file's path");
    const file = parts.pop() as string;
    try {
      const answer = await this.#client.uapi({
        module: "Fileman",
        func: "get_file_content",
        params: { dir: await this.#absolute(parts), file },
        what: `read ${path}`,
        schema: ContentSchema,
      });
      return answer.content;
    } catch (error) {
      if (error instanceof CpanelRefusal && MISSING_FILE.test(error.reason)) return undefined;
      throw error;
    }
  }

  /**
   * `fileop unlink`, which removes a folder with everything in it; a path that isn't there counts
   * as removed.
   */
  async remove(path: string): Promise<void> {
    const parts = checkPath(path, "A path to remove");
    try {
      await this.#fileop("unlink", await this.#absolute(parts), `remove ${path}`);
    } catch (error) {
      // Already gone, so a clean-up run again goes on.
      if (!(error instanceof CpanelRefusal && MISSING_FILE.test(error.reason))) throw error;
    }
  }

  async certificate(hostname: string): Promise<HostingCertificate> {
    const name = checkHostname(hostname);
    const [hosts, inProgress, problems] = await Promise.all([
      this.#installedHosts(),
      this.#client.uapi({
        module: "SSL",
        func: "is_autossl_check_in_progress",
        what: "tell whether AutoSSL is running",
        schema: flag,
      }),
      this.#client.uapi({
        module: "SSL",
        func: "get_autossl_problems",
        what: "read AutoSSL's problems",
        schema: ProblemsSchema,
      }),
    ]);
    const host = hosts.find((entry) => entry.servername === name || entry.domains.includes(name));
    const certificate = host?.certificate ?? undefined;
    const notAfter = certificate?.not_after ?? undefined;
    const installed =
      certificate?.domains.some((domain) => covers(domain, name)) === true &&
      certificate.is_self_signed !== 1 &&
      notAfter !== undefined &&
      notAfter * 1000 > this.#now();
    const problem = (problems ?? []).find((entry) => normalizeHostName(entry.domain) === name);
    return {
      hostname: name,
      installed,
      ...(notAfter !== undefined && { notAfter: new Date(notAfter * 1000).toISOString() }),
      ...(certificate !== undefined && { id: certificate.id }),
      inProgress: inProgress === 1,
      ...(problem !== undefined && { problem: problem.problem }),
    };
  }

  /** Starts an AutoSSL check of the account's domains (`SSL::start_autossl_check`). */
  async requestCertificate(hostname: string): Promise<void> {
    checkHostname(hostname);
    await this.#client.uapi({
      module: "SSL",
      func: "start_autossl_check",
      write: true,
      what: "start an AutoSSL check",
      schema: anything,
    });
  }

  /**
   * `SSL::delete_cert`, then `SSL::delete_key` for its key unless another certificate uses it.
   * A certificate still installed for a hostname is refused; one already gone is nothing to do.
   */
  async removeCertificate(id: string): Promise<void> {
    const using = (await this.#installedHosts()).find((host) => host.certificate?.id === id);
    if (using !== undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The certificate is still installed for ${using.servername}; nothing was removed.`,
        { hint: `Remove ${using.servername} first, or keep the certificate.` },
      );
    }
    const certificates = await this.#client.uapi({
      module: "SSL",
      func: "list_certs",
      what: "list the account's certificates",
      schema: CertificatesSchema,
    });
    const certificate = certificates.find((entry) => entry.id === id);
    if (certificate === undefined) return;
    await this.#client.uapi({
      module: "SSL",
      func: "delete_cert",
      params: { id },
      write: true,
      what: "remove the certificate",
      schema: anything,
    });
    const others = certificates.filter((entry) => entry.id !== id);
    const keys = await this.#client.uapi({
      module: "SSL",
      func: "list_keys",
      what: "list the account's private keys",
      schema: KeysSchema,
    });
    for (const key of keys) {
      if (!sameKey(key, certificate) || others.some((entry) => sameKey(key, entry))) continue;
      await this.#client.uapi({
        module: "SSL",
        func: "delete_key",
        params: { id: key.id },
        write: true,
        what: "remove the certificate's private key",
        schema: anything,
      });
    }
  }

  /**
   * MultiPHP's version for one hostname (`LangPHP::php_set_vhost_versions`); `version` is `X.Y`,
   * as `inspect()` lists it. Refused where the account has no `multiphp` feature.
   */
  async setPhpVersion(hostname: string, version: string): Promise<void> {
    const name = checkHostname(hostname);
    const features = await this.#client.uapi({
      module: "Features",
      func: "list_features",
      what: "list the account's features",
      schema: FeaturesSchema,
    });
    if (features.multiphp !== 1) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `This cPanel account has no MultiPHP, so OpsCrew can't set ${name}'s PHP version.`,
        { hint: "Ask your host to turn on MultiPHP Manager for the account." },
      );
    }
    const versions = await this.#phpVersions();
    const id = versions.get(version);
    if (id === undefined) {
      throw new OpsCrewError("INVALID_INPUT", `MultiPHP has no PHP ${version} on this account.`, {
        hint: `Choose ${orText([...versions.keys()]) || "a version your host installs"}.`,
      });
    }
    await this.#client.uapi({
      module: "LangPHP",
      func: "php_set_vhost_versions",
      params: { version: id, vhost: name },
      write: true,
      what: `set ${name}'s PHP version to ${version}`,
      schema: anything,
    });
  }

  /** `DomainInfo::domains_data`; remembers the home folder for the file calls. */
  async #account(): Promise<Account> {
    const what = "list the account's domains";
    const list = await this.#client.uapi({
      module: "DomainInfo",
      func: "domains_data",
      params: { format: "list" },
      what,
      schema: DomainsSchema,
    });
    const main = list.find((entry) => entry.type === "main_domain");
    const home = main?.homedir?.replace(/\/+$/, "");
    if (main === undefined || !home) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `cPanel named no main domain with its home folder when trying to ${what}.`,
        { hint: "cPanel's API may have changed; please report this to OpsCrew." },
      );
    }
    this.#home = home;
    const ordered = [main, ...list.filter((entry) => entry !== main)];
    const addresses = new Set<string>();
    for (const entry of ordered) {
      if (entry.ip) addresses.add(entry.ip);
      if (entry.ipv6) addresses.add(entry.ipv6);
    }
    return {
      home,
      main: normalizeHostName(main.domain),
      addresses: [...addresses],
      domains: ordered.map((entry) => {
        const root = entry.documentroot ? relativeTo(home, entry.documentroot) : undefined;
        return {
          name: normalizeHostName(entry.domain),
          kind: DOMAIN_KINDS[entry.type],
          ...(root !== undefined && { documentRoot: root }),
        };
      }),
    };
  }

  /** The absolute path of `parts` (the home folder for none). */
  async #absolute(parts: readonly string[]): Promise<string> {
    const home = this.#home ?? (await this.#account()).home;
    return [home, ...parts].join("/");
  }

  async #list(dir: string, folder: string) {
    return this.#client.uapi({
      module: "Fileman",
      func: "list_files",
      params: { dir, types: "dir|file|link", show_hidden: "1", include_mime: "0" },
      what: `list ${folder}`,
      schema: FilesSchema,
    });
  }

  /** API2 `Fileman::fileop` on absolute paths. */
  async #fileop(op: string, source: string, what: string, destination?: string): Promise<void> {
    await this.#client.api2({
      module: "Fileman",
      func: "fileop",
      params: {
        op,
        sourcefiles: source,
        ...(destination !== undefined && { destfiles: destination }),
        doubledecode: "0",
      },
      what,
      schema: anything,
    });
  }

  async #mysql(func: string, name: string, what: string): Promise<void> {
    await this.#client.uapi({
      module: "Mysql",
      func,
      params: { name },
      write: true,
      what,
      schema: anything,
    });
  }

  async #recreateAndRemove(name: string): Promise<void> {
    await this.#mysql("create_database", name, `make the reappearing database ${name} again`);
    await this.#mysql("delete_database", name, `remove the database ${name} again`);
  }

  async #installedHosts() {
    return this.#client.uapi({
      module: "SSL",
      func: "installed_hosts",
      what: "list the installed certificates",
      schema: InstalledHostsSchema,
    });
  }

  /** MultiPHP's installed versions as `X.Y` → cPanel's id (`ea-php82`), oldest first. */
  async #phpVersions(): Promise<Map<string, string>> {
    const answer = await this.#client.uapi({
      module: "LangPHP",
      func: "php_get_installed_versions",
      what: "list the PHP versions MultiPHP has",
      schema: PhpVersionsSchema,
    });
    const versions = new Map<string, string>();
    for (const id of answer.versions) {
      const match = /php(\d)(\d+)$/.exec(id);
      if (match && !versions.has(`${match[1]}.${match[2]}`)) {
        versions.set(`${match[1]}.${match[2]}`, id);
      }
    }
    return new Map([...versions].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
  }
}

/** The database engines of the account's MySQL server: MariaDB's versions start at 10. */
function databaseEngines(version: string | null | undefined): ("mariadb" | "mysql")[] {
  if (!version) return [];
  const major = Number.parseInt(version, 10);
  return /mariadb/i.test(version) || major >= 10 ? ["mariadb"] : ["mysql"];
}

/** The subdomain an addon domain sits on: its name with the dots as hyphens. */
function addonLabel(hostname: string): string {
  return hostname.replaceAll(".", "-");
}

/** Whether a certificate's name (`*.example.com` included) covers the hostname. */
function covers(domain: string, hostname: string): boolean {
  const name = normalizeHostName(domain);
  if (name === hostname) return true;
  return name.startsWith("*.") && hostname.slice(hostname.indexOf(".") + 1) === name.slice(2);
}

function sameKey(
  key: { modulus?: string | null; ecdsa_public?: string | null },
  certificate: { modulus?: string | null; ecdsa_public?: string | null },
): boolean {
  return (
    (!!key.modulus && key.modulus === certificate.modulus) ||
    (!!key.ecdsa_public && key.ecdsa_public === certificate.ecdsa_public)
  );
}

/** A document root relative to the home folder; cPanel keeps every root inside it. */
function relativeTo(home: string, path: string): string {
  const root = path.replace(/\/+$/, "");
  if (root === home) return ".";
  if (!root.startsWith(`${home}/`)) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `cPanel gave a document root outside the account's home folder (${root}).`,
      { hint: "cPanel's API may have changed; please report this to OpsCrew." },
    );
  }
  return root.slice(home.length + 1);
}

function checkHostname(hostname: string): string {
  const name = normalizeHostName(hostname);
  if (!HOSTNAME.test(name)) {
    throw new OpsCrewError("INVALID_INPUT", `"${hostname}" isn't a hostname.`);
  }
  return name;
}

/**
 * The names of a path relative to the home folder. Refused: an empty or absolute path, an empty,
 * `.` or `..` name, and `\`, `,` (which `fileop` reads as a list) or a control character.
 */
function checkPath(path: string, what: string): string[] {
  const parts = path.split("/");
  if (
    path === "" ||
    parts.some((part) => part === "" || part === "." || part === ".." || UNSAFE_NAME.test(part))
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${what} must be relative to the account's home folder, without "..", empty names or commas ("${path}").`,
    );
  }
  return parts;
}
