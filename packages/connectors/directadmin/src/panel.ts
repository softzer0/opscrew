import { randomBytes } from "node:crypto";
import type {
  HostingCertificate,
  HostingCronJob,
  HostingDomain,
  HostingFacts,
  HostingOperation,
  HostingPanel,
  HostingPanelAccess,
  PanelStep,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { DirectAdminApiError, DirectAdminClient, type DirectAdminClientDeps } from "./client";
import { directAdminPanelStep } from "./steps";

/*
 * Every call below is one a DirectAdmin user (not an admin or reseller) may make with a login
 * key. JSON API calls are from the server's OpenAPI spec (`/static/swagger.json`, read from
 * https://demo.directadmin.com:2222/static/swagger.json on 2026-11-12); legacy calls name their
 * documentation page where they are made.
 */

/** What DirectAdmin's user API does; every other operation is a panel step. */
export const DIRECTADMIN_OPERATIONS: ReadonlySet<HostingOperation> = new Set<HostingOperation>([
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
]);

/** A certificate request may take a while: DirectAdmin answers once the ACME order is done. */
const PROVISION_TIMEOUT_MS = 300_000;
const MIB = 1024 * 1024;

const userConfigSchema = z.object({
  domain: z.string(),
  domains: z.array(z.string()),
  ip: z.string(),
});
const userLimitSchema = z.object({
  usage: z.number(),
  limit: z.number(),
  unlimited: z.boolean().optional(),
});
const userUsageSchema = z.object({ quotaBytes: userLimitSchema });
const dbInfoSchema = z.object({
  version: z.string(),
  maxDatabaseLength: z.number().int(),
  maxUsernameLength: z.number().int(),
});
const databaseListSchema = z.array(z.object({ database: z.string() }));
/** `web.dbFullConnectionResponse` without its `password`, which is never kept. */
const createdDatabaseSchema = z.object({ database: z.string(), dbuser: z.string() });
const statSchema = z.object({ canonicalPath: z.string() });
const listSchema = z.object({ files: z.array(z.object({ name: z.string() })) });
const certsSchema = z.object({
  certs: z.array(
    z.object({
      id: z.string(),
      error: z.string(),
      certificate: z
        .object({ dnsNames: z.array(z.string()), notAfter: z.iso.datetime({ offset: true }) })
        .optional(),
    }),
  ),
  missingDNSNames: z.array(z.string()),
});
const provisionSchema = z.object({ logIDs: z.array(z.number()) });
const cronFieldSchema = z.string().regex(/^[0-9*/,-]+$/, "is not a cron field");
const cronCommandSchema = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/, "spans more than one line");

/** DirectAdmin's reasons a certificate is unusable (`core.TLSBundleErrorReason`), in words. */
const CERTIFICATE_PROBLEMS: Record<string, string> = {
  malformed: "malformed",
  "key-mismatch": "installed with a key that doesn't match it",
  "self-signed": "self-signed",
  untrusted: "not trusted by browsers",
  "hostname-mismatch": "for another name",
  expired: "expired",
  other: "unusable",
};

/**
 * A DirectAdmin user account reached with a login key (`HostingPanel`, ADR 0030). Paths are
 * relative to the account's home folder, as DirectAdmin's file manager takes them.
 */
export class DirectAdminPanel implements HostingPanel {
  readonly kind = "directadmin" as const;
  readonly operations = DIRECTADMIN_OPERATIONS;
  private readonly client: DirectAdminClient;

  constructor(access: HostingPanelAccess, deps: DirectAdminClientDeps = {}) {
    this.client = new DirectAdminClient(access, deps);
  }

  panelStep(operation: HostingOperation, details: Readonly<Record<string, string>>): PanelStep {
    return directAdminPanelStep(operation, details);
  }

  async inspect(): Promise<HostingFacts> {
    const config = await this.userConfig();
    const usage = await this.client.json({
      what: "read the account's disk usage",
      method: "GET",
      path: "/api/session/user-usage",
      schema: userUsageSchema,
    });
    const db = await this.client.json({
      what: "read the database server's details",
      method: "GET",
      path: "/api/db-show/info",
      schema: dbInfoSchema,
    });
    const domains: HostingDomain[] = [];
    for (const name of config.domains) {
      domains.push({
        name,
        kind: name === config.domain ? "main" : "addon",
        documentRoot: domainRoot(name),
      });
      // A subdomain's root depends on the DirectAdmin version and any override: see documentRoot().
      for (const sub of await this.subdomains(name)) {
        domains.push({ name: `${sub}.${name}`, kind: "subdomain" });
      }
    }
    const quota = usage.quotaBytes;
    const unlimited = quota.unlimited === true || quota.limit < 0;
    return {
      panel: "directadmin",
      domains,
      addresses: config.ip === "" ? [] : [config.ip],
      quota: {
        usedMb: Math.round(quota.usage / MIB),
        ...(unlimited ? {} : { limitMb: Math.round(quota.limit / MIB) }),
      },
      databases: {
        engines: [/mariadb/i.test(db.version) ? "mariadb" : "mysql"],
        // DirectAdmin names databases and their users `<user>_<name>`.
        prefix: `${this.client.user}_`,
        maxDatabaseName: db.maxDatabaseLength,
        maxUserName: db.maxUsernameLength,
      },
      apps: { selectors: [] },
      phpPerHostname: [],
      // DirectAdmin puts a subdomain's root; an override is made only in the panel, inside
      // `domains/` (https://docs.directadmin.com/changelog/version-1.59.5.html).
      documentRoots: "panel",
    };
  }

  /**
   * A domain's root is `domains/<domain>/public_html`. A subdomain's is
   * `domains/<subdomain>/public_html` when made by DirectAdmin 1.647 or later, and
   * `domains/<domain>/public_html/<sub>` before
   * (https://docs.directadmin.com/changelog/version-1.647.html); the one that exists is answered.
   */
  async documentRoot(hostname: string): Promise<string | undefined> {
    const name = hostnameOf(hostname);
    const config = await this.userConfig();
    if (config.domains.includes(name)) return domainRoot(name);
    const parent = parentDomain(name, config.domains);
    if (parent === undefined) return undefined;
    const sub = name.slice(0, -(parent.length + 1));
    if (!(await this.subdomains(parent)).includes(sub)) return undefined;
    for (const root of subdomainRoots(name, parent)) {
      if (await this.exists(root)) return root;
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `DirectAdmin serves ${name}, but from neither ${subdomainRoots(name, parent).join(" nor ")}: it has a document root override.`,
      {
        hint: `In DirectAdmin, open Sub-Domains Setup → Document Root Override for ${name} and clear the override, or choose another hostname.`,
      },
    );
  }

  /**
   * Makes a subdomain of one of the account's domains (`CMD_API_SUBDOMAINS`, `action=create`,
   * https://docs.directadmin.com/developer/api/legacy-api.html) and answers the document root
   * DirectAdmin made for it: its API can't choose one (`documentRoots: "panel"`).
   */
  async addHostname(hostname: string, documentRoot?: string): Promise<string> {
    const name = hostnameOf(hostname);
    if (documentRoot !== undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `DirectAdmin chooses ${name}'s document root itself; OpsCrew can't ask for ${documentRoot}.`,
        { hint: "This is a bug in OpsCrew; please report it." },
      );
    }
    const config = await this.userConfig();
    if (config.domains.includes(name)) {
      throw new OpsCrewError("INVALID_INPUT", `${name} is already one of the account's domains.`, {
        hint: `DirectAdmin serves it from ${domainRoot(name)}; use it without adding it.`,
      });
    }
    const parent = parentDomain(name, config.domains);
    if (parent === undefined) {
      const step = this.panelStep("addHostname", { hostname: name });
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${name} is not under any of the account's domains, and OpsCrew adds only subdomains through DirectAdmin's API.`,
        { hint: `In DirectAdmin, open ${step.where}: ${step.what}. Then run OpsCrew again.` },
      );
    }
    await this.client.legacy(`add the subdomain ${name}`, "CMD_API_SUBDOMAINS", "POST", {
      domain: parent,
      action: "create",
      subdomain: name.slice(0, -(parent.length + 1)),
    });
    const made = await this.documentRoot(name);
    if (made === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `DirectAdmin accepted the subdomain ${name} but doesn't list it.`,
        { hint: "Look at Sub-Domains Setup in DirectAdmin, then try again." },
      );
    }
    return made;
  }

  /**
   * Deletes a subdomain (`CMD_API_SUBDOMAINS`, `action=delete`, `contents=no`,
   * https://docs.directadmin.com/developer/api/legacy-api.html): its folder stays, since it may
   * hold a link into the releases; OpsCrew removes what it put there with {@link remove}.
   */
  async removeHostname(hostname: string): Promise<void> {
    const name = hostnameOf(hostname);
    const config = await this.userConfig();
    if (config.domains.includes(name)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${name} is one of the account's domains, which OpsCrew never deletes.`,
        { hint: "Delete the domain yourself in DirectAdmin if you no longer need it." },
      );
    }
    const parent = parentDomain(name, config.domains);
    if (parent === undefined) return;
    const sub = name.slice(0, -(parent.length + 1));
    if (!(await this.subdomains(parent)).includes(sub)) return;
    await this.deleteSubdomain(name, parent, sub);
  }

  /** `GET /api/db-show/databases`. */
  async listDatabases(): Promise<string[]> {
    const list = await this.client.json({
      what: "list the account's databases",
      method: "GET",
      path: "/api/db-show/databases",
      query: { "no-size": "true" },
      schema: databaseListSchema,
    });
    return list.map((entry) => entry.database);
  }

  /**
   * `POST /api/db-manage/create-db-with-user`: names in full (`<user>_<name>`); no privileges
   * sent means every privilege. The answer's password is dropped.
   */
  async addDatabase(input: { name: string; user: string; password: string }): Promise<void> {
    this.client.addSecret(input.password, "database password");
    await this.client.json({
      what: `create the database ${input.name} with its user ${input.user}`,
      method: "POST",
      path: "/api/db-manage/create-db-with-user",
      body: { database: input.name, dbuser: input.user, password: input.password },
      schema: createdDatabaseSchema,
    });
  }

  /**
   * `DELETE /api/db-manage/users/{dbuser}` (204 also when already deleted), then
   * `DELETE /api/db-manage/databases/{database}`, then checks the list no longer has it.
   */
  async removeDatabase(input: { name: string; user: string }): Promise<void> {
    await this.client.json({
      what: `delete the database user ${input.user}`,
      method: "DELETE",
      path: `/api/db-manage/users/${encodeURIComponent(input.user)}`,
      schema: z.undefined(),
    });
    if ((await this.listDatabases()).includes(input.name)) {
      await this.client.json({
        what: `delete the database ${input.name}`,
        method: "DELETE",
        path: `/api/db-manage/databases/${encodeURIComponent(input.name)}`,
        schema: z.undefined(),
      });
    }
    if ((await this.listDatabases()).includes(input.name)) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `DirectAdmin still lists the database ${input.name} after deleting it.`,
        { hint: "Look at it in DirectAdmin's MySQL Management, delete it there, then try again." },
      );
    }
  }

  /**
   * `CMD_API_CRON_JOBS` with no parameters lists the jobs as `<id>=<minute> <hour> <day> <month>
   * <weekday> <command>` (https://docs.directadmin.com/changelog/version-1.21.3.html).
   */
  async listCron(): Promise<HostingCronJob[]> {
    const answer = await this.client.legacy(
      "list the account's cron jobs",
      "CMD_API_CRON_JOBS",
      "GET",
      {},
    );
    const jobs: HostingCronJob[] = [];
    for (const [key, line] of answer) {
      if (!/^\d+$/.test(key)) continue;
      const fields = line.trim().split(/\s+/);
      const command = line
        .trim()
        .replace(/^(\S+\s+){5}/, "")
        .trim();
      if (fields.length < 6 || command === "") {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `DirectAdmin listed the cron job ${key} in a form OpsCrew doesn't know.`,
          { hint: "The DirectAdmin API may have changed; please report this to OpsCrew." },
        );
      }
      jobs.push({ key, schedule: fields.slice(0, 5).join(" "), command });
    }
    return jobs;
  }

  /**
   * `CMD_API_CRON_JOBS` with `action=create` and the five fields and the command
   * (https://docs.directadmin.com/changelog/version-1.21.3.html); the answer has no id, so the
   * new job is found in the list.
   */
  async addCron(input: { schedule: string; command: string }): Promise<HostingCronJob> {
    const fields = input.schedule.trim().split(/\s+/);
    if (fields.length !== 5 || !fields.every((field) => cronFieldSchema.safeParse(field).success)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `"${input.schedule}" is not a cron schedule of five fields.`,
        {
          hint: "Write it as minute, hour, day of month, month and day of week, such as */5 * * * *.",
        },
      );
    }
    if (!cronCommandSchema.safeParse(input.command).success) {
      throw new OpsCrewError("INVALID_INPUT", "A cron job's command must be one line.", {
        hint: "Put a longer command in a script and run the script.",
      });
    }
    const schedule = fields.join(" ");
    const before = new Set((await this.listCron()).map((job) => job.key));
    const [minute, hour, dayofmonth, month, dayofweek] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    await this.client.legacy("add a cron job", "CMD_API_CRON_JOBS", "POST", {
      action: "create",
      minute,
      hour,
      dayofmonth,
      month,
      dayofweek,
      command: input.command,
    });
    const made = (await this.listCron()).find(
      (job) => !before.has(job.key) && job.schedule === schedule && job.command === input.command,
    );
    if (made === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        "DirectAdmin accepted the cron job but doesn't list it.",
        { hint: "Look at Cron Jobs in DirectAdmin, then try again." },
      );
    }
    return made;
  }

  /** `CMD_API_CRON_JOBS` with `action=delete&select0=<id>` (version 1.21.3's change log). */
  async removeCron(key: string): Promise<void> {
    if (!/^\d+$/.test(key)) {
      throw new OpsCrewError("INVALID_INPUT", `"${key}" is not a DirectAdmin cron job id.`, {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    await this.client.legacy(`delete the cron job ${key}`, "CMD_API_CRON_JOBS", "POST", {
      action: "delete",
      select0: key,
    });
  }

  /**
   * Uploads under a temporary name with the mode (`POST /api/filemanager-actions/upload`), then
   * renames it over the target (`POST /api/filemanager-actions/move`, `overwrite: true`).
   */
  async writeFile(path: string, content: Uint8Array, mode: number): Promise<void> {
    checkPath(path);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new OpsCrewError("INVALID_INPUT", `${mode} is not a file mode.`, {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    const { dir, name } = splitPath(path);
    const temporary = `.${name}.opscrew-${randomBytes(6).toString("hex")}.tmp`;
    await this.client.upload(
      `upload ${path}`,
      { dir, name: temporary, perm: `0${mode.toString(8)}` },
      content,
    );
    try {
      await this.move(joinPath(dir, temporary), path, `put ${path} in place`);
    } catch (error) {
      await this.remove(joinPath(dir, temporary)).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Uploads the tar into `folder` (`"."` is the home folder) with mode 0600, unpacks it there with the file manager
   * (`POST /api/filemanager-actions/extract-archive`, every member, existing files replaced), then
   * removes it.
   */
  async uploadTar(folder: string, tar: Uint8Array): Promise<void> {
    if (folder !== ".") checkPath(folder);
    const where = folder === "." ? "the home folder" : folder;
    const name = `.opscrew-${randomBytes(6).toString("hex")}.tar`;
    await this.client.upload(
      `upload an archive into ${where}`,
      { dir: folder, name, perm: "0600" },
      tar,
    );
    const archive = joinPath(folder, name);
    try {
      await this.client.json({
        what: `unpack the archive into ${where}`,
        method: "POST",
        path: "/api/filemanager-actions/extract-archive",
        body: { source: archive, destinationDir: folder, members: [], mergeAndOverwrite: true },
        schema: z.undefined(),
      });
    } catch (error) {
      await this.remove(archive).catch(() => undefined);
      throw error;
    }
    await this.remove(archive);
  }

  /**
   * `GET /api/filemanager/list` without its limit; undefined when the file manager reports
   * `NOT_FOUND`.
   */
  async list(folder: string): Promise<string[] | undefined> {
    checkPath(folder);
    try {
      const answer = await this.client.json({
        what: `list ${folder}`,
        method: "GET",
        path: "/api/filemanager/list",
        query: { path: folder, limit: "0" },
        schema: listSchema,
      });
      return answer.files.map((file) => file.name);
    } catch (error) {
      if (isOnly(error, "NOT_FOUND")) return undefined;
      throw error;
    }
  }

  /** `GET /api/filemanager/download`; undefined on 404. */
  async readFile(path: string): Promise<string | undefined> {
    checkPath(path);
    return this.client.download(`read ${path}`, path);
  }

  /**
   * `POST /api/filemanager-actions/remove` without the trash; a path that is already gone counts
   * as removed.
   */
  async remove(path: string): Promise<void> {
    checkPath(path);
    try {
      await this.client.json({
        what: `delete ${path}`,
        method: "POST",
        path: "/api/filemanager-actions/remove",
        body: { paths: [path], trash: false },
        schema: z.undefined(),
      });
    } catch (error) {
      if (isOnly(error, "NOT_FOUND")) return;
      throw error;
    }
  }

  /**
   * `GET /api/domain-tls/domains/{domain}/certs` for the domain the hostname belongs to. The id is
   * given only for a certificate covering the hostname alone, so removing it touches no other
   * name; `names` are the certificate's DNS names.
   */
  async certificate(hostname: string): Promise<HostingCertificate> {
    const name = hostnameOf(hostname);
    const domain = await this.owningDomain(name);
    const list = await this.client.json({
      what: `read the certificates of ${domain}`,
      method: "GET",
      path: `/api/domain-tls/domains/${encodeURIComponent(domain)}/certs`,
      schema: certsSchema,
    });
    const covering = list.certs.filter((cert) =>
      cert.certificate?.dnsNames.some((dns) => covers(dns, name)),
    );
    const valid = covering
      .filter((cert) => cert.error === "")
      .sort((a, b) =>
        (b.certificate?.notAfter ?? "").localeCompare(a.certificate?.notAfter ?? ""),
      )[0];
    if (valid?.certificate !== undefined) {
      const only = valid.certificate.dnsNames.every((dns) => dns.toLowerCase() === name);
      return {
        hostname: name,
        installed: true,
        notAfter: new Date(valid.certificate.notAfter).toISOString(),
        ...(only ? { id: `${domain}/${valid.id}` } : {}),
        names: valid.certificate.dnsNames,
        inProgress: false,
      };
    }
    const broken = covering[0];
    const problem =
      broken === undefined
        ? list.missingDNSNames.some((dns) => dns.toLowerCase() === name)
          ? "No certificate covers it yet."
          : undefined
        : `The certificate covering it is ${CERTIFICATE_PROBLEMS[broken.error] ?? broken.error}.`;
    return {
      hostname: name,
      installed: false,
      inProgress: false,
      ...(problem === undefined ? {} : { problem }),
    };
  }

  /**
   * `POST /api/domain-tls/domains/{domain}/provision-certs`: DirectAdmin's ACME client gets
   * certificates for the domain's names that have none, the new hostname's among them, and
   * answers when done. One already running counts as requested.
   */
  async requestCertificate(hostname: string): Promise<void> {
    const name = hostnameOf(hostname);
    const domain = await this.owningDomain(name);
    try {
      await this.client.json({
        what: `get a certificate for ${name}`,
        method: "POST",
        path: `/api/domain-tls/domains/${encodeURIComponent(domain)}/provision-certs`,
        schema: provisionSchema,
        timeoutMs: PROVISION_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof DirectAdminApiError)) throw error;
      if (error.type === "DOMAIN_ACME_ALREADY_IN_PROGRESS") return;
      if (error.type === "DOMAIN_ACME_IS_DISABLED") {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Automatic certificates are turned off for ${domain} in DirectAdmin.`,
          {
            hint: `In DirectAdmin, open SSL Certificates for ${domain} and turn on automatic certificates (or ask your host to allow Let's Encrypt for your account), then try again.`,
          },
        );
      }
      if (error.type === "RATELIMIT_REACHED") {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `The certificate authority's rate limit stopped the certificate for ${name}.`,
          {
            hint: "Wait an hour (Let's Encrypt's limits reset within a week at most), then try again.",
          },
        );
      }
      throw error;
    }
  }

  /**
   * `DELETE /api/domain-tls/domains/{domain}/certs/{id}`, with the id {@link certificate} gave;
   * one already gone counts as removed.
   */
  async removeCertificate(id: string): Promise<void> {
    const match = /^([a-z0-9.-]+)\/([^/]+)$/i.exec(id);
    if (match === null) {
      throw new OpsCrewError("INVALID_INPUT", `"${id}" is not a DirectAdmin certificate id.`, {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    const [, domain, certId] = match as unknown as [string, string, string];
    try {
      await this.client.json({
        what: `delete the certificate ${certId} of ${domain}`,
        method: "DELETE",
        path: `/api/domain-tls/domains/${encodeURIComponent(domain)}/certs/${encodeURIComponent(certId)}`,
        schema: z.undefined(),
      });
    } catch (error) {
      if (error instanceof DirectAdminApiError && error.status === 404) return;
      throw error;
    }
  }

  /** DirectAdmin's user API sets no PHP version: always the panel step. */
  async setPhpVersion(hostname: string, version: string): Promise<void> {
    const step = this.panelStep("setPhpVersion", { hostname, version });
    throw new OpsCrewError(
      "INVALID_INPUT",
      "DirectAdmin's API can't set a hostname's PHP version.",
      {
        hint: `In DirectAdmin, open ${step.where}: ${step.what}.`,
      },
    );
  }

  // --- Helpers --------------------------------------------------------------------------------

  /** `GET /api/session/user-config`: the main domain, every domain and the account's address. */
  private userConfig() {
    return this.client.json({
      what: "read the account's domains",
      method: "GET",
      path: "/api/session/user-config",
      schema: userConfigSchema,
    });
  }

  /** `CMD_API_SUBDOMAINS?domain=` answers `list[]=<sub>` (legacy API page). */
  private async subdomains(domain: string): Promise<string[]> {
    const answer = await this.client.legacy(
      `list the subdomains of ${domain}`,
      "CMD_API_SUBDOMAINS",
      "GET",
      { domain },
    );
    return answer.getAll("list[]").map((sub) => sub.toLowerCase());
  }

  private async deleteSubdomain(name: string, domain: string, sub: string): Promise<void> {
    await this.client.legacy(`delete the subdomain ${name}`, "CMD_API_SUBDOMAINS", "POST", {
      domain,
      action: "delete",
      select0: sub,
      contents: "no",
    });
  }

  /** `GET /api/filemanager/stat`: false when the file manager reports `NOT_FOUND`. */
  private async exists(path: string): Promise<boolean> {
    try {
      await this.client.json({
        what: `look for ${path}`,
        method: "GET",
        path: "/api/filemanager/stat",
        query: { path },
        schema: statSchema,
      });
      return true;
    } catch (error) {
      if (isOnly(error, "NOT_FOUND")) return false;
      throw error;
    }
  }

  /** `POST /api/filemanager-actions/move` with `overwrite: true`. */
  private async move(source: string, destination: string, what: string): Promise<void> {
    await this.client.json({
      what,
      method: "POST",
      path: "/api/filemanager-actions/move",
      body: { source, destination, overwrite: true },
      schema: z.undefined(),
    });
  }

  /** The account's domain a hostname is, or is a subdomain of. */
  private async owningDomain(name: string): Promise<string> {
    const config = await this.userConfig();
    const domain = config.domains.includes(name) ? name : parentDomain(name, config.domains);
    if (domain === undefined) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${name} is not under any of the account's domains.`,
        {
          hint: "Choose a hostname under one of the account's domains.",
        },
      );
    }
    return domain;
  }
}

function hostnameOf(hostname: string): string {
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(name)) {
    throw new OpsCrewError("INVALID_INPUT", `"${hostname}" is not a hostname.`, {
      hint: "Use a name such as app.example.com.",
    });
  }
  return name;
}

/** The longest of `domains` that `name` is a subdomain of. */
function parentDomain(name: string, domains: readonly string[]): string | undefined {
  return domains
    .filter((domain) => name.endsWith(`.${domain}`))
    .sort((a, b) => b.length - a.length)[0];
}

function domainRoot(domain: string): string {
  return `domains/${domain}/public_html`;
}

/** A subdomain's root since DirectAdmin 1.647, then before it. */
function subdomainRoots(name: string, parent: string): [string, string] {
  return [
    `domains/${name}/public_html`,
    `${domainRoot(parent)}/${name.slice(0, -(parent.length + 1))}`,
  ];
}

/** Whether a certificate's DNS name (maybe `*.domain`) covers `name`. */
function covers(dns: string, name: string): boolean {
  const pattern = dns.toLowerCase();
  if (pattern.startsWith("*.")) {
    const rest = pattern.slice(2);
    return name.endsWith(`.${rest}`) && !name.slice(0, -(rest.length + 1)).includes(".");
  }
  return pattern === name;
}

/** Refuses a path that is empty, absolute, the home folder itself or climbs out with `..`. */
function checkPath(path: string): void {
  const parts = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${path}" is not a path inside the account's home folder.`,
      { hint: "Paths are relative to the home folder, such as opscrew/shared/.env." },
    );
  }
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: ".", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

function joinPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

/** Whether `error` is a file manager error whose every reason is `reason`. */
function isOnly(error: unknown, reason: string): boolean {
  return (
    error instanceof DirectAdminApiError &&
    error.reasons.length > 0 &&
    error.reasons.every((each) => each === reason)
  );
}
