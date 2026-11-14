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
import {
  changedApiHint,
  normalizeHostName,
  OpsCrewError,
  type PanelClientOptions,
  parentDomain,
  parseAnswer,
} from "@opscrew/core";
import { z } from "zod";
import { PLESK_ERRORS, type PleskClient, type PleskRequest, pleskClient } from "./client";
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

  constructor(access: HostingPanelAccess, options: PanelClientOptions = {}) {
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
    const [site] = await this.#all(
      {
        operator: "site",
        operation: "get",
        body: { filter: { name: hostname }, dataset: { gen_info: "", hosting: "" } },
        what: `read the site ${hostname}`,
        write: false,
      },
      SiteSchema,
      { missingOk: true },
    );
    const wwwRoot = site === undefined ? undefined : property(site.data.hosting, "www_root");
    return wwwRoot === undefined ? undefined : homeRelative(wwwRoot, subscription.folder);
  }

  /** Without `documentRoot`, the site gets Plesk's default root, which is read back. */
  async addHostname(hostname: string, documentRoot?: string): Promise<string> {
    if (documentRoot !== undefined) checkPath(documentRoot);
    const subscription = await this.#subscription();
    const parent = parentDomain(hostname, [
      subscription.name,
      ...(await this.#sites(subscription)).map((s) => s.name),
    ]);
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
    await this.#all(
      {
        operator: "site",
        operation: "del",
        body: { filter: { name: hostname } },
        what: `remove the hostname ${hostname}`,
        write: true,
      },
      z.looseObject({}),
      { missingOk: true },
    );
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
    const users = await this.#all(
      {
        operator: "database",
        operation: "get-db-users",
        body: { filter: { "db-id": db.id } },
        what: `read the users of the database ${input.name}`,
        write: false,
      },
      DatabaseUserSchema,
      { missingOk: true },
    );
    const user = users.find((u) => u.login === input.user);
    if (user !== undefined) {
      // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/deleting-database-users.34677/
      await this.#all(
        {
          operator: "database",
          operation: "del-db-user",
          body: { filter: { id: user.id } },
          what: `remove the database user ${input.user}`,
          write: true,
        },
        z.looseObject({}),
        { missingOk: true },
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
    const subscriptions = await this.#all(
      {
        operator: "webspace",
        operation: "get",
        body: { filter: "", dataset: { gen_info: "", hosting: "", limits: "" } },
        what: "read your subscription",
        write: false,
      },
      WebspaceSchema,
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
    // `parent-id` matches the sites of one subscription.
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/available-filters.66544/
    const sites = await this.#all(
      {
        operator: "site",
        operation: "get",
        body: { filter: { "parent-id": subscription.id }, dataset: { gen_info: "", hosting: "" } },
        what: "read your sites",
        write: false,
      },
      SiteSchema,
    );
    return sites.map((site) => ({
      name: site.data.gen_info.name,
      ...optional("wwwRoot", property(site.data.hosting, "www_root")),
    }));
  }

  /** The names of the login's subdomains, normalized. */
  async #subdomains(): Promise<Set<string>> {
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subdomains/available-filters.53472/
    const subdomains = await this.#all(
      {
        operator: "subdomain",
        operation: "get",
        body: { filter: "" },
        what: "read your subdomains",
        write: false,
      },
      SubdomainSchema,
    );
    return new Set(subdomains.map((s) => normalizeHostName(s.data.name)));
  }

  async #databases(subscription: Subscription): Promise<{ id: string; name: string }[]> {
    // The filter's `webspace-id` matches a subscription's databases.
    // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/available-filters.34404/
    return this.#all(
      {
        operator: "database",
        operation: "get-db",
        body: { filter: { "webspace-id": subscription.id } },
        what: "read your databases",
        write: false,
      },
      DatabaseSchema,
    );
  }

  /**
   * Removes a database; one already gone counts as removed. The filter is `id`, as the filter type
   * defines it (the page's sample shows `db-id`).
   * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/deleting-databases.34422/
   * https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases/available-filters.34404/
   */
  async #deleteDatabase(id: string, name: string): Promise<void> {
    await this.#all(
      {
        operator: "database",
        operation: "del-db",
        body: { filter: { id } },
        what: `remove the database ${name}`,
        write: true,
      },
      z.looseObject({}),
      { missingOk: true },
    );
  }

  /** The one result of a request, which must be ok. */
  async #one<T>(request: PleskRequest, schema: z.ZodType<T>): Promise<T> {
    const [result] = await this.#all(request, schema);
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

  /**
   * Every result of the request, each of which must be ok; with `missingOk`, "does not exist"
   * (1013) is no result rather than a failure.
   */
  async #all<T>(
    request: PleskRequest,
    schema: z.ZodType<T>,
    options: { missingOk?: boolean } = {},
  ): Promise<T[]> {
    const missingOk = options.missingOk === true;
    return (await this.#client.call(request))
      .filter(
        (r) => !(missingOk && r.status === "error" && r.errcode === PLESK_ERRORS.doesNotExist),
      )
      .map((result) => {
        if (result.status === "error") throw this.#client.failure(result, request.what);
        return parseAnswer(schema, result, "Plesk", request.what);
      });
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
      { hint: changedApiHint("Plesk") },
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
