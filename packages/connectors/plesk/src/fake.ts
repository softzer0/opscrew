import type { FetchLike } from "@opscrew/contracts";
import { PLESK_XML_API_PATH } from "./client";
import { buildXml, parseXml } from "./xml";

/**
 * A fake Plesk XML API for tests (this package's and agents'), answering with the packet shapes
 * of the XML API reference's samples: one customer with one subscription by default, its sites
 * and subdomains (`site`, `subdomain`) and its databases (`database`). Requests other than the
 * ones the connector sends answer a parse error (1014), as Plesk does for an unknown operation.
 */

/** The panel's address in the fake. */
export const FAKE_PLESK_URL = "https://plesk.example.test:8443";

/** Plesk's folder of virtual hosts; a subscription's home folder is `<this>/<its name>`. */
const VHOSTS = "/var/www/vhosts";

export interface FakePleskSubscription {
  id: number;
  name: string;
  /** Bytes. */
  realSize?: number;
  /** Bytes; `-1` for unlimited. Absent: the answer has no `disk_space` limit. */
  diskSpace?: number;
  addresses?: string[];
}

export interface FakePleskSite {
  id: number;
  name: string;
  /** Relative to the subscription's folder: `httpdocs`, `opscrew/app/current/public`. */
  wwwRoot: string;
  /** The parent site's name, for a subdomain. */
  subdomainOf?: string;
  subscriptionId: number;
}

export interface FakePleskDatabase {
  id: number;
  name: string;
  type: string;
  subscriptionId: number;
  users: { id: number; login: string; password: string; role: string }[];
}

export interface FakePleskOptions {
  /** The customer's login; default `jdoe`. */
  login?: string;
  /** The customer's password, or a secret key, that the fake accepts. */
  token: string;
  /** Default: one subscription `example.com` (id 1) of 300 MB, limited to 1 GB. */
  subscriptions?: FakePleskSubscription[];
  /** Sites besides each subscription's main site (which is `httpdocs`). */
  sites?: Omit<FakePleskSite, "id" | "subscriptionId">[];
  databases?: { name: string; users?: string[] }[];
  /** `"<operator>.<operation>"` → the error every result of it gets. */
  failures?: Record<string, { errcode: string; errtext: string }>;
  /** The hosting plan lacks "Ability to use remote API": every packet fails with 1006. */
  noRemoteApi?: boolean;
}

/** A request the fake received: the packet's one operation, and the headers. */
export interface FakePleskRequest {
  operator: string;
  operation: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Result = Record<string, unknown>;

const ok = (fields: Result = {}): Result => ({ status: "ok", ...fields });
const error = (errcode: string, errtext: string, fields: Result = {}): Result => ({
  status: "error",
  errcode,
  errtext,
  ...fields,
});

/** The fake's `fetch`, its state (change it to set a scene) and the requests it received. */
export function fakePlesk(options: FakePleskOptions) {
  const login = options.login ?? "jdoe";
  const subscriptions = options.subscriptions ?? [
    {
      id: 1,
      name: "example.com",
      realSize: 300 * 1024 * 1024,
      diskSpace: 1024 * 1024 * 1024,
      addresses: ["192.0.2.10", "2001:db8::10"],
    },
  ];
  let nextId = 100;
  const first = subscriptions[0];
  const sites: FakePleskSite[] = (options.sites ?? []).map((site) => ({
    ...site,
    id: nextId++,
    subscriptionId: first?.id ?? 1,
  }));
  const databases: FakePleskDatabase[] = (options.databases ?? []).map((db) => ({
    id: nextId++,
    name: db.name,
    type: "mysql",
    subscriptionId: first?.id ?? 1,
    users: (db.users ?? []).map((user) => ({
      id: nextId++,
      login: user,
      password: "",
      role: "readWrite",
    })),
  }));
  const state = { subscriptions, sites, databases };
  const requests: FakePleskRequest[] = [];

  const home = (subscriptionId: number) =>
    `${VHOSTS}/${subscriptions.find((s) => s.id === subscriptionId)?.name ?? "unknown"}`;
  const property = (name: string, value: unknown) => ({ name, value });
  const mainSite = (s: FakePleskSubscription): FakePleskSite => ({
    id: s.id,
    name: s.name,
    wwwRoot: "httpdocs",
    subscriptionId: s.id,
  });
  const allSites = () => [...subscriptions.map(mainSite), ...sites];
  const siteData = (site: FakePleskSite) => ({
    gen_info: {
      cr_date: "2026-11-12",
      name: site.name,
      "ascii-name": site.name,
      status: "0",
      real_size: "0",
      htype: "vrt_hst",
      "webspace-id": String(site.subscriptionId),
    },
    hosting: {
      vrt_hst: {
        property: [
          property("ftp_login", login),
          property("www_root", `${home(site.subscriptionId)}/${site.wwwRoot}`.replace(/\/$/, "")),
        ],
      },
    },
  });

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subscriptions/getting-information-about-subscriptions.33899/
  const webspaceGet = (): Result[] =>
    subscriptions.map((s) =>
      ok({
        "filter-id": String(s.id),
        id: String(s.id),
        data: {
          gen_info: {
            cr_date: "2026-11-12",
            name: s.name,
            "ascii-name": s.name,
            status: "0",
            ...(s.realSize === undefined ? {} : { real_size: String(s.realSize) }),
            dns_ip_address: s.addresses ?? [],
            htype: "vrt_hst",
          },
          hosting: {
            vrt_hst: {
              property: [
                property("ftp_login", login),
                property("www_root", `${home(s.id)}/httpdocs`),
              ],
              ip_address: s.addresses ?? [],
            },
          },
          limits:
            s.diskSpace === undefined
              ? ""
              : { overuse: "block", limit: [property("disk_space", String(s.diskSpace))] },
        },
      }),
    );

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/getting-information-about-sites.66583/
  const siteGet = (filter: Record<string, string>): Result[] => {
    if (filter.name !== undefined) {
      const site = allSites().find((s) => s.name === filter.name);
      return site === undefined
        ? [error("1013", "Site does not exist", { "filter-id": filter.name })]
        : [ok({ "filter-id": filter.name, id: String(site.id), data: siteData(site) })];
    }
    const parent = Number(filter["parent-id"]);
    return sites
      .filter((s) => s.subscriptionId === parent)
      .map((s) => ok({ "filter-id": String(parent), id: String(s.id), data: siteData(s) }));
  };

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/creating-a-site.66574/
  const siteAdd = (body: Result): Result[] => {
    const setup = body.gen_setup as Record<string, string>;
    const subscriptionId = Number(setup["webspace-id"]);
    if (!subscriptions.some((s) => s.id === subscriptionId)) {
      return [error("1015", "Webspace does not exist")];
    }
    if (allSites().some((s) => s.name === setup.name)) {
      return [error("1007", "Site with such name already exists")];
    }
    const parent = setup["parent-site-name"];
    if (parent !== undefined && !allSites().some((s) => s.name === parent)) {
      return [error("1015", "Parent site is not found")];
    }
    const vrt = (body.hosting as { vrt_hst?: { property?: { name: string; value: string }[] } })
      ?.vrt_hst;
    const root = vrt?.property?.find((p) => p.name === "www_root")?.value;
    // Without `www_root`, the fake gives the site a folder named after it.
    const wwwRoot = root === undefined ? String(setup.name) : root.replace(/^\//, "");
    const site: FakePleskSite = {
      id: nextId++,
      name: String(setup.name),
      wwwRoot,
      subscriptionId,
      ...(parent === undefined ? {} : { subdomainOf: parent }),
    };
    sites.push(site);
    return [
      ok({
        id: String(site.id),
        guid: `00000000-0000-4000-8000-${String(site.id).padStart(12, "0")}`,
      }),
    ];
  };

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-sites-domains/removing-sites.66609/
  const siteDel = (filter: Record<string, string>): Result[] => {
    const at = sites.findIndex((s) => s.name === filter.name);
    if (at < 0) return [error("1013", "Site does not exist", { "filter-id": filter.name })];
    const [site] = sites.splice(at, 1);
    return [ok({ "filter-id": filter.name, id: String(site?.id) })];
  };

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-subdomains/retrieving-information-on-subdomains.53501/
  const subdomainGet = (): Result[] =>
    sites
      .filter((s) => s.subdomainOf !== undefined)
      .map((s) =>
        ok({
          "filter-id": String(s.id),
          id: String(s.id),
          data: {
            parent: s.subdomainOf,
            name: s.name,
            property: [property("www_root", `/${s.wwwRoot}`), property("php", "true")],
          },
        }),
      );

  const dbResult = (db: FakePleskDatabase, filterId: string) =>
    ok({
      "filter-id": filterId,
      id: String(db.id),
      name: db.name,
      type: db.type,
      "webspace-id": String(db.subscriptionId),
      "db-server-id": "1",
      "default-user-id": String(db.users[0]?.id ?? 0),
    });

  // https://docs.plesk.com/en-US/obsidian/api-rpc/about-xml-api/reference/managing-databases.34398/
  const database = (operation: string, body: Result): Result[] | undefined => {
    const filter = (body.filter ?? {}) as Record<string, string>;
    switch (operation) {
      case "add-db": {
        const subscriptionId = Number(body["webspace-id"]);
        if (!subscriptions.some((s) => s.id === subscriptionId)) {
          return [error("1015", "Domain does not exist")];
        }
        if (databases.some((d) => d.name === body.name)) {
          return [error("1007", "Database already exists")];
        }
        if (body.type !== "mysql" && body.type !== "postgresql") {
          return [error("1019", "Invalid database type")];
        }
        const db = {
          id: nextId++,
          name: String(body.name),
          type: String(body.type),
          subscriptionId,
          users: [],
        };
        databases.push(db);
        return [ok({ id: String(db.id) })];
      }
      case "get-db":
        return databases
          .filter((d) => String(d.subscriptionId) === filter["webspace-id"])
          .map((d) => dbResult(d, filter["webspace-id"] ?? ""));
      case "del-db": {
        const at = databases.findIndex((d) => String(d.id) === filter.id);
        if (at < 0) return [error("1013", "Database does not exist", { "filter-id": filter.id })];
        databases.splice(at, 1);
        return [ok({ "filter-id": filter.id, id: filter.id })];
      }
      case "add-db-user": {
        const db = databases.find((d) => String(d.id) === body["db-id"]);
        if (db === undefined) return [error("1015", "Database does not exist")];
        if (databases.some((d) => d.users.some((u) => u.login === body.login))) {
          return [error("1007", "Database user already exists")];
        }
        const password = String(body.password ?? "");
        const user = {
          id: nextId++,
          login: String(body.login),
          password,
          role: String(body.role ?? "readWrite"),
        };
        db.users.push(user);
        return [ok({ id: String(user.id) })];
      }
      case "get-db-users": {
        const db = databases.find((d) => String(d.id) === filter["db-id"]);
        return (db?.users ?? []).map((u) =>
          ok({
            "filter-id": filter["db-id"],
            id: String(u.id),
            login: u.login,
            "db-id": String(db?.id),
          }),
        );
      }
      case "del-db-user": {
        for (const db of databases) {
          const at = db.users.findIndex((u) => String(u.id) === filter.id);
          if (at >= 0) {
            db.users.splice(at, 1);
            return [ok({ "filter-id": filter.id, id: filter.id })];
          }
        }
        return [error("1013", "Database user does not exist", { "filter-id": filter.id })];
      }
      default:
        return undefined;
    }
  };

  const answer = (operator: string, operation: string, body: Result): Result[] | undefined => {
    const filter = (body.filter === "" ? {} : (body.filter ?? {})) as Record<string, string>;
    switch (`${operator}.${operation}`) {
      case "webspace.get":
        return webspaceGet();
      case "site.get":
        return siteGet(filter);
      case "site.add":
        return siteAdd(body);
      case "site.del":
        return siteDel(filter);
      case "subdomain.get":
        return subdomainGet();
      default:
        return operator === "database" ? database(operation, body) : undefined;
    }
  };

  const reply = (packet: Record<string, unknown>) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${buildXml({ packet })}`, {
      status: 200,
      headers: { "content-type": "text/xml" },
    });
  const system = (errcode: string, errtext: string) => reply({ system: error(errcode, errtext) });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== `${FAKE_PLESK_URL}${PLESK_XML_API_PATH}`) {
      return new Response("Not Found", { status: 404 });
    }
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const parsed = parseXml(String(init?.body ?? "")) as
      | { packet?: Record<string, Record<string, Result>> }
      | undefined;
    const [operator, ops] = Object.entries(parsed?.packet ?? {})[0] ?? [];
    const [operation, rawBody] = Object.entries(ops ?? {})[0] ?? [];
    const body = (typeof rawBody === "object" && rawBody !== null ? rawBody : {}) as Result;
    requests.push({ operator: operator ?? "", operation: operation ?? "", body, headers });

    const authorized =
      headers.KEY === options.token ||
      (headers.HTTP_AUTH_LOGIN === login && headers.HTTP_AUTH_PASSWD === options.token);
    if (!authorized) return system("1001", "Authentication failed - wrong password.");
    if (options.noRemoteApi) return system("1006", "Permission denied.");
    if (operator === undefined || operation === undefined) {
      return system("1014", "Parser error: Request is invalid.");
    }
    const failure = options.failures?.[`${operator}.${operation}`];
    const results = failure
      ? [error(failure.errcode, failure.errtext)]
      : answer(operator, operation, body);
    if (results === undefined) return system("1014", "Parser error: Request is invalid.");
    return reply({ [operator]: { [operation]: results.length === 0 ? "" : { result: results } } });
  };

  return { fetch, state, requests, url: FAKE_PLESK_URL, login };
}
