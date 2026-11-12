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
import { normalizeHostName, OpsCrewError, parseAnswer } from "@opscrew/core";
import { z } from "zod";
import {
  PLESK_ERRORS,
  type PleskClient,
  type PleskClientOptions,
  type PleskRequest,
  type PleskResult,
  pleskClient,
} from "./client";
import { notInApi, PLESK_OPERATIONS, pleskPanelStep } from "./steps";

/** An element that may come back empty (`<limits/>` parses as `""`). */
function maybe<T extends z.ZodType>(schema: T) {
  return z.union([z.literal("").transform(() => undefined), schema]).optional();
}

/** A `property` or `limit`: a name and its value (`PleskPhysHostingPropertyType`). */
const PropertySchema = z.looseObject({ name: z.string(), value: z.unknown() });
const Properties = z.looseObject({ property: z.array(PropertySchema).optional() });
const Hosting = maybe(z.looseObject({ vrt_hst: maybe(Properties) }));

/**
 * A subscription (`webspace get` with `gen_info`, `hosting` and `limits`): its main domain, size
 * in bytes, DNS addresses, the main site's `www_root` and its limits (`disk_space` in bytes, `-1`
 * for unlimited).
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subscriptions/getting-information-about-subscriptions.33899/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subscriptions/subscription-settings/general-subscription-information/node-gen_info-type-domaingeninfotype.33856/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-service-plans/configuring-service-plan-settings.32929/
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/representation-of-object-descriptor/property-descriptor.39693/
 */
const WebspaceSchema = z.looseObject({
  id: z.string(),
  data: z.looseObject({
    gen_info: z.looseObject({
      name: z.string(),
      "ascii-name": z.string(),
      real_size: z.string().optional(),
      dns_ip_address: z.array(z.string()).optional(),
    }),
    hosting: Hosting,
    limits: maybe(z.looseObject({ limit: z.array(PropertySchema).optional() })),
  }),
});

/**
 * A site or subdomain (`site get` with `gen_info` and `hosting`); `www_root` is absolute
 * (`/var/www/vhosts/<subscription>/httpdocs`).
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/getting-information-about-sites.66583/
 */
const SiteSchema = z.looseObject({
  id: z.string(),
  data: z.looseObject({ gen_info: z.looseObject({ name: z.string() }), hosting: Hosting }),
});

/**
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subdomains/retrieving-information-on-subdomains.53501/
 */
const SubdomainSchema = z.looseObject({ data: z.looseObject({ name: z.string() }) });

/** The answer of an `add`, `add-db` or `add-db-user`. */
const AddedSchema = z.looseObject({ id: z.string() });

/**
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/retrieving-information-about-databases.34431/
 */
const DatabaseSchema = z.looseObject({ id: z.string(), name: z.string() });

/**
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/retrieving-database-users-info.34695/
 */
const DatabaseUserSchema = z.looseObject({ id: z.string(), login: z.string() });

interface Subscription {
  id: string;
  name: string;
  /** The folder Plesk names after the subscription: the account's home folder. */
  folder: string;
  realSize?: number;
  addresses: string[];
  wwwRoot?: string;
  diskSpace?: number;
}

interface Site {
  name: string;
  wwwRoot?: string;
}

const MB = 1024 * 1024;

/**
 * A Plesk customer's subscription through the XML API (ADR 0030). The login must have one
 * subscription: its main domain's folder is the account's home folder, which every path is
 * relative to. Hostnames are sites of it (a subdomain under one of its domains, else a domain of
 * its own); databases are MySQL (MariaDB counts as MySQL in Plesk) with one user each.
 */
export class PleskPanel implements HostingPanel {
  readonly kind = "plesk";
  readonly operations = PLESK_OPERATIONS;
  readonly #client: PleskClient;
  readonly #user: string;

  constructor(access: HostingPanelAccess, options: PleskClientOptions = {}) {
    this.#client = pleskClient(access, options);
    this.#user = access.user;
  }

  panelStep(operation: HostingOperation, details: Readonly<Record<string, string>>): PanelStep {
    return pleskPanelStep(operation, details);
  }

  async inspect(): Promise<HostingFacts> {
    const subscription = await this.#subscription();
    const sites = await this.#sites(subscription);
    const subdomains = await this.#subdomains();
    const main = normalizeHostName(subscription.name);
    const domains: HostingDomain[] = [
      domain(subscription.name, "main", subscription.wwwRoot, subscription.folder),
      ...sites
        .filter((site) => normalizeHostName(site.name) !== main)
        .map((site) =>
          domain(
            site.name,
            subdomains.has(normalizeHostName(site.name)) ? "subdomain" : "addon",
            site.wwwRoot,
            subscription.folder,
          ),
        ),
    ];
    const facts: HostingFacts = {
      panel: "plesk",
      domains,
      addresses: subscription.addresses,
      // Add-db makes only the `mysql` type here (MariaDB is that type in Plesk); which other
      // database servers a subscription may use is for the administrator to read (`db-servers`).
      databases: { engines: ["mysql"] },
      // Plesk has no CloudLinux selectors of its own, and its Node.js support is not in scope.
      apps: { selectors: [] },
      // A site's PHP version is set in the panel: the customer API documents no list of versions.
      phpPerHostname: [],
      // A customer types a site's or subdomain's document root: "You can use the default
      // directory httpdocs or specify another directory." (`www_root`, relative to the
      // subscription's folder).
      // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/hosting-settings/general-settings/hosting-types.72051/
      // https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/domains-and-dns/adding-subdomains.65180/
      documentRoots: "anywhere",
    };
    if (subscription.realSize !== undefined) {
      const usedMb = Math.round(subscription.realSize / MB);
      const limit = subscription.diskSpace;
      if (limit === -1) facts.quota = { usedMb };
      else if (limit !== undefined) facts.quota = { usedMb, limitMb: Math.round(limit / MB) };
    }
    return facts;
  }

  async documentRoot(hostname: string): Promise<string | undefined> {
    return this.#siteRoot(await this.#subscription(), hostname);
  }

  /** A site's document root relative to the subscription's folder, or undefined. */
  async #siteRoot(subscription: Subscription, hostname: string): Promise<string | undefined> {
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/getting-information-about-sites.66583/
    const what = `read the site ${hostname}`;
    const results = await this.#client.call({
      operator: "site",
      operation: "get",
      body: { filter: { name: hostname }, dataset: { gen_info: "", hosting: "" } },
      what,
      write: false,
    });
    const site = this.#found(results, SiteSchema, what)[0];
    const wwwRoot = site === undefined ? undefined : property(site.data.hosting, "www_root");
    return wwwRoot === undefined ? undefined : homeRelative(wwwRoot, subscription.folder);
  }

  /** Without `documentRoot`, the site gets Plesk's default root, which is read back. */
  async addHostname(hostname: string, documentRoot?: string): Promise<string> {
    if (documentRoot !== undefined) checkPath(documentRoot);
    const subscription = await this.#subscription();
    const host = normalizeHostName(hostname);
    const parent = [subscription.name, ...(await this.#sites(subscription)).map((s) => s.name)]
      .filter((name) => host.endsWith(`.${normalizeHostName(name)}`))
      .sort((a, b) => b.length - a.length)[0];
    // `site add` makes a site of the subscription, or a subdomain with `parent-site-name`;
    // `www_root` is relative to the subscription's folder.
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/creating-a-site.66574/
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/site-settings/general-site-information/node-addgen_setup.66547/
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subdomains/subdomain-properties.53600/
    await this.#one(
      {
        operator: "site",
        operation: "add",
        body: {
          gen_setup: {
            name: hostname,
            "webspace-id": subscription.id,
            ...(parent === undefined ? {} : { "parent-site-name": parent }),
          },
          ...(documentRoot === undefined
            ? {}
            : {
                hosting: {
                  vrt_hst: {
                    property: [
                      { name: "www_root", value: documentRoot === "." ? "/" : `/${documentRoot}` },
                    ],
                  },
                },
              }),
        },
        what: `add the hostname ${hostname}`,
        write: true,
      },
      AddedSchema,
    );
    if (documentRoot !== undefined) return documentRoot;
    const made = await this.#siteRoot(subscription, hostname);
    if (made === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Plesk added the hostname ${hostname} but gives no document root for it.`,
        { hint: "Check the hostname in Plesk (Websites & Domains), then try again." },
      );
    }
    return made;
  }

  async removeHostname(hostname: string): Promise<void> {
    const subscription = await this.#subscription();
    if (normalizeHostName(hostname) === normalizeHostName(subscription.name)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${hostname} is your subscription's main domain; OpsCrew never removes it.`,
      );
    }
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/removing-sites.66609/
    const what = `remove the hostname ${hostname}`;
    const results = await this.#client.call({
      operator: "site",
      operation: "del",
      body: { filter: { name: hostname } },
      what,
      write: true,
    });
    this.#found(results, z.looseObject({}), what);
  }

  async listDatabases(): Promise<string[]> {
    return (await this.#databases(await this.#subscription())).map((db) => db.name);
  }

  async addDatabase(input: { name: string; user: string; password: string }): Promise<void> {
    this.#client.secret(input.password, "DATABASE_PASSWORD");
    const subscription = await this.#subscription();
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/creating-databases.34407/
    const db = await this.#one(
      {
        operator: "database",
        operation: "add-db",
        body: { "webspace-id": subscription.id, name: input.name, type: "mysql" },
        what: `add the database ${input.name}`,
        write: true,
      },
      AddedSchema,
    );
    // A user of that database only, with every privilege on it (`readWrite`).
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/creating-database-users.34472/
    try {
      await this.#one(
        {
          operator: "database",
          operation: "add-db-user",
          body: {
            "db-id": db.id,
            login: input.user,
            password: input.password,
            "password-type": "plain",
            role: "readWrite",
          },
          what: `add the database user ${input.user}`,
          write: true,
        },
        AddedSchema,
      );
    } catch (error) {
      // The user's failure is what the caller needs; a failed clean-up must not hide it.
      try {
        await this.#deleteDatabase(db.id, input.name);
      } catch {}
      throw error;
    }
  }

  async removeDatabase(input: { name: string; user: string }): Promise<void> {
    const subscription = await this.#subscription();
    const db = (await this.#databases(subscription)).find((d) => d.name === input.name);
    if (db === undefined) return;
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/retrieving-database-users-info.34695/
    const users = this.#found(
      await this.#client.call({
        operator: "database",
        operation: "get-db-users",
        body: { filter: { "db-id": db.id } },
        what: `read the users of the database ${input.name}`,
        write: false,
      }),
      DatabaseUserSchema,
      `read the users of the database ${input.name}`,
    );
    const user = users.find((u) => u.login === input.user);
    if (user !== undefined) {
      // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/deleting-database-users.34677/
      const what = `remove the database user ${input.user}`;
      this.#found(
        await this.#client.call({
          operator: "database",
          operation: "del-db-user",
          body: { filter: { id: user.id } },
          what,
          write: true,
        }),
        z.looseObject({}),
        what,
      );
    }
    await this.#deleteDatabase(db.id, input.name);
    if ((await this.#databases(subscription)).some((d) => d.name === input.name)) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Plesk still lists the database ${input.name} after removing it.`,
        { hint: "Remove it in Plesk (Websites & Domains → Databases), then try again." },
      );
    }
  }

  async listCron(): Promise<HostingCronJob[] | undefined> {
    return undefined;
  }

  async addCron(_input: { schedule: string; command: string }): Promise<HostingCronJob> {
    throw notInApi("addCron");
  }

  async removeCron(_key: string): Promise<void> {
    throw notInApi("removeCron");
  }

  async writeFile(_path: string, _content: Uint8Array, _mode: number): Promise<void> {
    throw noFileCalls();
  }

  async uploadTar(_folder: string, _tar: Uint8Array): Promise<void> {
    throw noFileCalls();
  }

  async readFile(_path: string): Promise<string | undefined> {
    throw noFileCalls();
  }

  async list(_folder: string): Promise<string[] | undefined> {
    throw noFileCalls();
  }

  async remove(_path: string): Promise<void> {
    throw noFileCalls();
  }

  /** Undefined: only the administrator's and resellers' `certificate` operator reads them. */
  async certificate(_hostname: string): Promise<HostingCertificate | undefined> {
    return undefined;
  }

  async requestCertificate(_hostname: string): Promise<void> {
    throw notInApi("requestCertificate");
  }

  async removeCertificate(_id: string): Promise<void> {
    throw notInApi("removeCertificate");
  }

  async setPhpVersion(_hostname: string, _version: string): Promise<void> {
    throw notInApi("setPhpVersion");
  }

  /** The login's one subscription. */
  async #subscription(): Promise<Subscription> {
    const what = "read your subscription";
    const subscriptions = this.#ok(
      await this.#client.call({
        operator: "webspace",
        operation: "get",
        body: { filter: "", dataset: { gen_info: "", hosting: "", limits: "" } },
        what,
        write: false,
      }),
      WebspaceSchema,
      what,
    );
    const [first, ...others] = subscriptions;
    if (first === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The Plesk login ${this.#user} has no subscription.`,
        {
          hint: "Set OPSCREW_HOSTING_USER to the login of the customer whose subscription OpsCrew deploys to.",
        },
      );
    }
    if (others.length > 0) {
      const names = subscriptions.map((s) => s.data.gen_info.name).join(", ");
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The Plesk login ${this.#user} has ${subscriptions.length} subscriptions (${names}); OpsCrew works with a login that has one.`,
        { hint: "Use the login of a Plesk customer with one subscription." },
      );
    }
    const info = first.data.gen_info;
    const diskSpace = first.data.limits?.limit?.find((l) => l.name === "disk_space")?.value;
    return {
      id: first.id,
      name: info.name,
      folder: info["ascii-name"],
      ...(info.real_size === undefined ? {} : { realSize: Number(info.real_size) }),
      addresses: [...new Set(info.dns_ip_address ?? [])],
      ...optional("wwwRoot", property(first.data.hosting, "www_root")),
      ...(typeof diskSpace === "string" ? { diskSpace: Number(diskSpace) } : {}),
    };
  }

  /** The subscription's sites and subdomains (the main site may be among them). */
  async #sites(subscription: Subscription): Promise<Site[]> {
    const what = "read your sites";
    // `parent-id` matches the sites of one subscription.
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/available-filters.66544/
    const sites = this.#ok(
      await this.#client.call({
        operator: "site",
        operation: "get",
        body: { filter: { "parent-id": subscription.id }, dataset: { gen_info: "", hosting: "" } },
        what,
        write: false,
      }),
      SiteSchema,
      what,
    );
    return sites.map((site) => ({
      name: site.data.gen_info.name,
      ...optional("wwwRoot", property(site.data.hosting, "www_root")),
    }));
  }

  /** The names of the login's subdomains, normalized. */
  async #subdomains(): Promise<Set<string>> {
    const what = "read your subdomains";
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subdomains/available-filters.53472/
    const subdomains = this.#ok(
      await this.#client.call({
        operator: "subdomain",
        operation: "get",
        body: { filter: "" },
        what,
        write: false,
      }),
      SubdomainSchema,
      what,
    );
    return new Set(subdomains.map((s) => normalizeHostName(s.data.name)));
  }

  async #databases(subscription: Subscription): Promise<{ id: string; name: string }[]> {
    const what = "read your databases";
    // The filter's `webspace-id` matches a subscription's databases.
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/available-filters.34404/
    return this.#ok(
      await this.#client.call({
        operator: "database",
        operation: "get-db",
        body: { filter: { "webspace-id": subscription.id } },
        what,
        write: false,
      }),
      DatabaseSchema,
      what,
    );
  }

  /**
   * Removes a database; one already gone counts as removed. The filter is `id`, as the filter type
   * defines it (the page's sample shows `db-id`).
   * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/deleting-databases.34422/
   * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/available-filters.34404/
   */
  async #deleteDatabase(id: string, name: string): Promise<void> {
    const what = `remove the database ${name}`;
    this.#found(
      await this.#client.call({
        operator: "database",
        operation: "del-db",
        body: { filter: { id } },
        what,
        write: true,
      }),
      z.looseObject({}),
      what,
    );
  }

  /** The one result of a request, which must be ok. */
  async #one<T>(request: PleskRequest, schema: z.ZodType<T>): Promise<T> {
    const [result] = this.#ok(await this.#client.call(request), schema, request.what);
    if (result === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Plesk gave no result when trying to ${request.what}.`,
        {
          hint: "Check the account in Plesk before trying again: the change may have been made.",
        },
      );
    }
    return result;
  }

  /** Every result, each of which must be ok. */
  #ok<T>(results: PleskResult[], schema: z.ZodType<T>, what: string): T[] {
    return results.map((result) => {
      if (result.status === "error") throw this.#client.failure(result, what);
      return parseAnswer(schema, result, "Plesk", what);
    });
  }

  /** {@link #ok}, where "does not exist" (1013) is no result rather than a failure. */
  #found<T>(results: PleskResult[], schema: z.ZodType<T>, what: string): T[] {
    return this.#ok(
      results.filter((r) => !(r.status === "error" && r.errcode === PLESK_ERRORS.doesNotExist)),
      schema,
      what,
    );
  }
}

/**
 * The refusal of a file call: the customer API has none (the `upload` operator is the
 * administrator's), so OpsCrew reaches a Plesk account's files over SFTP.
 * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/uploading-files-to-server.36040/
 */
function noFileCalls(): OpsCrewError {
  return new OpsCrewError("INVALID_INPUT", "Plesk's API for customers has no file calls.", {
    hint: "OpsCrew reaches a Plesk account's files over SFTP.",
  });
}

/** A hosting setting's value, when it is text. */
function property(hosting: z.infer<typeof Hosting>, name: string): string | undefined {
  const value = hosting?.vrt_hst?.property?.find((p) => p.name === name)?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optional<K extends string>(key: K, value: string | undefined) {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
}

function domain(
  name: string,
  kind: HostingDomain["kind"],
  wwwRoot: string | undefined,
  folder: string,
): HostingDomain {
  return wwwRoot === undefined
    ? { name, kind }
    : { name, kind, documentRoot: homeRelative(wwwRoot, folder) };
}

/** An absolute `www_root` relative to the subscription's folder (the account's home folder). */
function homeRelative(path: string, folder: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  const at = parts.indexOf(folder);
  if (at < 0) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Plesk gave the document root ${path}, which is not in the subscription's folder ${folder}.`,
      { hint: "The Plesk API may have changed; please report this to OpsCrew." },
    );
  }
  return parts.slice(at + 1).join("/") || ".";
}

/** A document root: relative to the home folder, without `..`. */
function checkPath(path: string): void {
  if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The document root ${path || "(empty)"} must be a folder relative to the account's home folder, without "..".`,
    );
  }
}
