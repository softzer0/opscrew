import type { FetchLike, HostingDomain } from "@opscrew/contracts";

/**
 * A fake cPanel account behind `fetch`, for tests of `CpanelPanel` and of the agents that drive
 * it. Its answers have the shapes the spikes saw on a real account (research R1, R10, R11) and the
 * documented ones elsewhere: HTTP 200 for every refusal (UAPI `status: 0`; API2 `event.result: 1`
 * with an `error`, or a `data[]` item with `result: 0` for `fileop`), `listcron`'s trailing
 * `{count}` entry, `rename` refusing an existing name, AutoSSL issuing a certificate when a
 * hostname is made and keeping it after the hostname is removed, LangPHP refused without the
 * `multiphp` feature, and, with `reappearingDatabases`, R10's deleted database that comes back
 * once and answers "does not control" until it is made and removed again.
 *
 * A missing file answers the live text, "The file “…” does not exist for the account." Not
 * recorded by the spikes, so assumed here: an HTTP 401 for a wrong token.
 */
export interface FakeCpanelOptions {
  /** The account's user and the API token the fake accepts. */
  user: string;
  token: string;
  /** Default `example.com`. */
  mainDomain?: string;
  /** Default 192.0.2.10 (a documentation address). */
  address?: string;
  /** Features over the test account's (R1, R10): selectors and `passengerapps` on, `multiphp` off. */
  features?: Record<string, 0 | 1>;
  /** MultiPHP's installed versions (`ea-php82`, …), answered only with the `multiphp` feature. */
  phpVersions?: string[];
  /** WHM's "Restrict document roots to public_html" (off on the test account). */
  docrootsInPublicHtmlOnly?: boolean;
  /** R10: a deleted database comes back once, listed, until it is made and removed again. */
  reappearingDatabases?: boolean;
  /** AutoSSL records this problem for a new hostname instead of issuing its certificate. */
  autoSslProblem?: string;
  /**
   * The names AutoSSL's certificate for a hostname covers (default the hostname and `www.` of
   * it). A certificate with the same names already there is installed instead of a new one, as the
   * domain's wildcard (`*.example.com`) is on a new subdomain (R13).
   */
  certificateNames?: (hostname: string) => string[];
  /** Epoch milliseconds, for certificate dates (default `Date.now`). */
  now?: () => number;
}

/** A file or a symbolic link in the fake home folder. */
export type FakeCpanelEntry =
  | { kind: "file"; content: Uint8Array; mode: number }
  | { kind: "link"; target: string };

export interface FakeCpanelCertificate {
  id: string;
  domains: string[];
  /** Epoch seconds. */
  notAfter: number;
  /** Its key's modulus, shared with the key of the same modulus. */
  modulus: string;
}

/** Everything the fake account holds; tests may read and change it. Paths are relative to home. */
export interface FakeCpanelState {
  readonly home: string;
  readonly mainDomain: string;
  domains: (HostingDomain & { addonSubdomain?: string })[];
  files: Map<string, FakeCpanelEntry>;
  folders: Set<string>;
  databases: Map<string, { users: Set<string>; ghost: boolean }>;
  databaseUsers: Set<string>;
  cron: {
    linekey: string;
    minute: string;
    hour: string;
    day: string;
    month: string;
    weekday: string;
    command: string;
  }[];
  certificates: FakeCpanelCertificate[];
  keys: { id: string; modulus: string }[];
  /** Hostname → the id of the certificate installed for it. */
  installed: Map<string, string>;
  autosslProblems: { domain: string; problem: string }[];
  autosslInProgress: boolean;
  features: Record<string, 0 | 1>;
  phpVersions: string[];
  /** Hostname → MultiPHP version id set for it. */
  vhostPhp: Map<string, string>;
  passengerApps: string[];
  maximumPassengerApps: number | "unlimited";
  quota: { usedMb: number; limitMb: number };
}

/** A call the fake received (`files`: the names of uploaded files). */
export interface FakeCpanelCall {
  api: "uapi" | "api2";
  module: string;
  func: string;
  params: Record<string, string>;
  files?: string[];
}

export interface FakeCpanel {
  fetch: FetchLike;
  calls: FakeCpanelCall[];
  state: FakeCpanelState;
  /** The next call of `Module::func` fails with `reason`, in its API's refusal shape. */
  failNext(module: string, func: string, reason: string): void;
  /** A text file's content, or undefined. */
  readText(path: string): string | undefined;
  /** Writes a text file (its folders made), as the agent on the account does. */
  writeText(path: string, text: string, mode?: number): void;
}

const DEFAULT_FEATURES: Record<string, 0 | 1> = {
  lvenodejssel: 1,
  lvepythonsel: 1,
  lverubysel: 1,
  lvephpsel: 1,
  passengerapps: 1,
  multiphp: 0,
  ssh: 1,
};

/** Module → the feature it needs (R1: "You do not have the feature multiphp"). */
const MODULE_FEATURES: Record<string, string> = {
  LangPHP: "multiphp",
  PassengerApps: "passengerapps",
};

class Refusal extends Error {}

type Params = Record<string, string>;
type Handler = (params: Params, files: { name: string; content: Uint8Array }[]) => unknown;

/** A fake cPanel account (see {@link FakeCpanelOptions}). */
export function fakeCpanel(options: FakeCpanelOptions): FakeCpanel {
  const now = options.now ?? Date.now;
  const home = `/home/${options.user}`;
  const main = options.mainDomain ?? "example.com";
  const address = options.address ?? "192.0.2.10";
  const state: FakeCpanelState = {
    home,
    mainDomain: main,
    domains: [{ name: main, kind: "main", documentRoot: "public_html" }],
    files: new Map(),
    folders: new Set(["public_html"]),
    databases: new Map(),
    databaseUsers: new Set(),
    cron: [],
    certificates: [],
    keys: [],
    installed: new Map(),
    autosslProblems: [],
    autosslInProgress: false,
    features: { ...DEFAULT_FEATURES, ...options.features },
    phpVersions: options.phpVersions ?? [],
    vhostPhp: new Map(),
    passengerApps: [],
    maximumPassengerApps: 4,
    quota: { usedMb: 512, limitMb: 10_240 },
  };
  const calls: FakeCpanelCall[] = [];
  const failures = new Map<string, string[]>();
  const reappeared = new Set<string>();
  let serial = 0;
  const next = () => (++serial).toString(16).padStart(8, "0");

  // --- the home folder ---------------------------------------------------------------------------

  /** An absolute path (or one relative to home) as a path relative to home. */
  function relative(path: string): string {
    const clean = path.replace(/\/+$/, "");
    if (clean === home) return "";
    if (clean.startsWith(`${home}/`)) return clean.slice(home.length + 1);
    if (clean.startsWith("/")) throw new Refusal(`“${path}” is outside your home directory.`);
    return clean;
  }
  const isFolder = (path: string) =>
    path === "" ||
    state.folders.has(path) ||
    [...state.files.keys(), ...state.folders].some((key) => key.startsWith(`${path}/`));
  function makeFolders(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) state.folders.add(parts.slice(0, i).join("/"));
  }
  function put(path: string, entry: FakeCpanelEntry) {
    makeFolders(path.split("/").slice(0, -1).join("/"));
    state.files.set(path, entry);
  }
  function exists(path: string) {
    return state.files.has(path) || isFolder(path);
  }
  function removeTree(path: string) {
    state.files.delete(path);
    state.folders.delete(path);
    for (const key of [...state.files.keys()])
      if (key.startsWith(`${path}/`)) state.files.delete(key);
    for (const key of [...state.folders]) if (key.startsWith(`${path}/`)) state.folders.delete(key);
  }
  const missing = (path: string) =>
    new Refusal(`The file “${home}/${path}” does not exist for the account.`);

  // --- domains and AutoSSL -----------------------------------------------------------------------

  const findDomain = (name: string) => state.domains.find((domain) => domain.name === name);
  const rootOf = (domain: HostingDomain) =>
    domain.documentRoot === undefined ? home : `${home}/${domain.documentRoot}`;

  function issueCertificate(hostname: string) {
    if (options.autoSslProblem !== undefined) {
      state.autosslProblems.push({ domain: hostname, problem: options.autoSslProblem });
      return;
    }
    const domains = options.certificateNames?.(hostname) ?? [hostname, `www.${hostname}`];
    const same = state.certificates.find((entry) => entry.domains.join() === domains.join());
    if (same !== undefined) {
      state.installed.set(hostname, same.id);
      return;
    }
    const modulus = `${next()}${"ab".repeat(16)}`;
    const key = { id: `${next()}_${next()}`, modulus };
    // cPanel names a wildcard's id `_wildcard__example_com_…`.
    const label = (domains[0] ?? hostname).replace("*", "_wildcard_").replace(/[.-]/g, "_");
    const id = `${label}_${key.id}_${next()}`;
    state.keys.push(key);
    state.certificates.push({
      id,
      domains,
      notAfter: Math.floor(now() / 1000) + 90 * 86_400,
      modulus,
    });
    state.installed.set(hostname, id);
  }
  issueCertificate(main);

  function addDomain(name: string, kind: "addon" | "subdomain", dir: string, label?: string) {
    if (findDomain(name)) throw new Refusal(`The domain “${name}” already exists.`);
    const root = dir.replace(/^\/+|\/+$/g, "");
    if (options.docrootsInPublicHtmlOnly && !root.startsWith("public_html/")) {
      throw new Refusal("The document root must be inside “public_html”.");
    }
    // cPanel makes a missing root, but keeps a link's path as it is (R10).
    const parts = root.split("/");
    const linked = parts.some((_, i) => state.files.has(parts.slice(0, i + 1).join("/")));
    if (!linked) makeFolders(root);
    state.domains.push({
      name,
      kind,
      documentRoot: root,
      ...(label !== undefined && { addonSubdomain: label }),
    });
    issueCertificate(name);
  }
  function removeDomain(name: string) {
    state.domains = state.domains.filter((domain) => domain.name !== name);
    state.installed.delete(name);
  }

  const certificateFields = (certificate: FakeCpanelCertificate) => ({
    id: certificate.id,
    domains: certificate.domains,
    not_after: certificate.notAfter,
    not_before: certificate.notAfter - 90 * 86_400,
    is_self_signed: 0,
    is_autossl: 1,
    key_algorithm: "rsaEncryption",
    modulus: certificate.modulus,
    modulus_length: 2048,
    ecdsa_public: null,
    validation_type: "dv",
  });

  // --- UAPI ----------------------------------------------------------------------------------------

  const uapi: Record<string, Handler> = {
    "Variables::get_server_information": () => ({
      docroots_in_public_html_only: options.docrootsInPublicHtmlOnly ? 1 : 0,
      mysql_version: "10.11",
      mysql_host: "localhost",
      version: "4.18.0",
      apache_port: "0.0.0.0:80",
      apache_ssl_port: "0.0.0.0:443",
    }),
    "Variables::get_user_information": () => ({
      user: options.user,
      home,
      domain: main,
      ip: address,
      shell: "/bin/bash",
      maximum_passenger_apps: state.maximumPassengerApps,
    }),
    // R13: `format=list` leaves parked domains out; without it they are names only.
    "DomainInfo::domains_data": (params) => {
      const entry = (domain: HostingDomain) => ({
        domain: domain.name,
        type: `${domain.kind === "subdomain" ? "sub" : domain.kind}_domain`,
        documentroot: rootOf(domain),
        homedir: home,
        ip: address,
        ipv6: null,
        servername: domain.name,
        serveralias: `www.${domain.name}`,
        user: options.user,
        owner: "root",
      });
      const of = (kind: HostingDomain["kind"]) =>
        state.domains.filter((domain) => domain.kind === kind);
      if (params.format === "list") {
        return state.domains.filter((domain) => domain.kind !== "parked").map(entry);
      }
      return {
        main_domain: entry(state.domains[0] as HostingDomain),
        addon_domains: of("addon").map(entry),
        sub_domains: of("subdomain").map(entry),
        parked_domains: of("parked").map((domain) => domain.name),
      };
    },
    "Quota::get_quota_info": () => ({
      megabytes_used: state.quota.usedMb,
      megabyte_limit: state.quota.limitMb,
      megabytes_remain: Math.max(0, state.quota.limitMb - state.quota.usedMb),
      under_megabyte_limit: 1,
    }),
    "Features::list_features": () => ({ ...state.features }),
    "PassengerApps::list_applications": () =>
      Object.fromEntries(state.passengerApps.map((name) => [name, { name, enabled: 1 }])),
    "LangPHP::php_get_installed_versions": () => ({ versions: [...state.phpVersions] }),
    "LangPHP::php_set_vhost_versions": (params) => {
      const version = need(params, "version");
      const vhost = need(params, "vhost");
      if (!state.phpVersions.includes(version)) throw new Refusal(`“${version}” isn't installed.`);
      if (!findDomain(vhost)) throw new Refusal(`The virtual host “${vhost}” does not exist.`);
      state.vhostPhp.set(vhost, version);
      return { vhosts: [vhost] };
    },

    "SubDomain::addsubdomain": (params) => {
      const label = need(params, "domain");
      const rootdomain = need(params, "rootdomain");
      const root = findDomain(rootdomain);
      if (!root || root.kind === "subdomain") {
        throw new Refusal(`You do not own the domain “${rootdomain}”.`);
      }
      addDomain(`${label}.${rootdomain}`, "subdomain", need(params, "dir"));
      return null;
    },

    "Mysql::get_restrictions": () => ({
      prefix: `${options.user}_`,
      max_database_name_length: 64,
      max_username_length: 47,
    }),
    "Mysql::list_databases": () =>
      [...state.databases].map(([database, entry]) => ({
        database,
        disk_usage: 0,
        users: [...entry.users],
      })),
    "Mysql::list_users": () =>
      [...state.databaseUsers].map((user) => ({
        user,
        shortuser: user.replace(`${options.user}_`, ""),
        databases: [...state.databases]
          .filter(([, entry]) => entry.users.has(user))
          .map(([name]) => name),
      })),
    "Mysql::create_database": (params) => {
      const name = need(params, "name");
      const existing = state.databases.get(name);
      if (existing && !existing.ghost) throw new Refusal(`The database “${name}” already exists.`);
      state.databases.set(name, { users: new Set(), ghost: false });
      return null;
    },
    "Mysql::create_user": (params) => {
      const name = need(params, "name");
      need(params, "password");
      if (state.databaseUsers.has(name)) throw new Refusal(`The user “${name}” already exists.`);
      state.databaseUsers.add(name);
      return null;
    },
    "Mysql::set_privileges_on_database": (params) => {
      const user = need(params, "user");
      const database = state.databases.get(need(params, "database"));
      if (!database || database.ghost || !state.databaseUsers.has(user)) {
        throw new Refusal("The database or the user does not exist.");
      }
      if (need(params, "privileges") !== "ALL PRIVILEGES")
        throw new Refusal("Unexpected privileges.");
      database.users.add(user);
      return null;
    },
    "Mysql::delete_user": (params) => {
      const name = need(params, "name");
      if (!state.databaseUsers.delete(name))
        throw new Refusal(`The user “${name}” does not exist.`);
      for (const entry of state.databases.values()) entry.users.delete(name);
      return null;
    },
    "Mysql::delete_database": (params) => {
      const name = need(params, "name");
      const entry = state.databases.get(name);
      if (!entry || entry.ghost) {
        throw new Refusal(
          `The account “${options.user}” does not control a database named “${name}”.`,
        );
      }
      state.databases.delete(name);
      if (options.reappearingDatabases && !reappeared.has(name)) {
        reappeared.add(name);
        state.databases.set(name, { users: new Set(), ghost: true });
      }
      return null;
    },

    "Fileman::upload_files": (params, files) => {
      const dir = relative(need(params, "dir"));
      if (state.files.has(dir)) throw new Refusal(`“${home}/${dir}” is not a directory.`);
      makeFolders(dir);
      const mode = Number.parseInt(params.permissions ?? "0644", 8);
      const uploads = files.map((file) => {
        const path = dir === "" ? file.name : `${dir}/${file.name}`;
        if (exists(path) && params.overwrite !== "1") {
          return {
            file: file.name,
            status: 0,
            reason: `“${file.name}” already exists.`,
            size: null,
          };
        }
        put(path, { kind: "file", content: file.content, mode });
        return {
          file: file.name,
          status: 1,
          reason: `Upload of “${file.name}” succeeded.`,
          size: file.content.length,
        };
      });
      const failed = uploads.filter((upload) => upload.status === 0);
      if (failed.length > 0) throw new Refusal(failed.map((upload) => upload.reason).join(" "));
      return { uploads, succeeded: uploads.length, failed: 0, warned: 0 };
    },
    "Fileman::get_file_content": (params) => {
      const dir = relative(need(params, "dir"));
      const file = need(params, "file");
      const path = dir === "" ? file : `${dir}/${file}`;
      const entry = state.files.get(path);
      if (entry?.kind !== "file") throw missing(path);
      return {
        // cPanel answers null, not "", for a file of 0 bytes (research R13).
        content: entry.content.length === 0 ? null : new TextDecoder().decode(entry.content),
        dir: `${home}/${dir}`,
        filename: file,
        path: `${home}/${path}`,
        from_charset: "UTF-8",
        to_charset: "UTF-8",
      };
    },
    "Fileman::list_files": (params) => {
      const dir = relative(need(params, "dir"));
      if (!isFolder(dir)) throw missing(dir);
      const types = (params.types ?? "file|dir").split("|");
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, string>();
      for (const [key, entry] of state.files) {
        const rest = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
        if (rest === undefined || rest === "") continue;
        const [first, ...deeper] = rest.split("/");
        if (first !== undefined) children.set(first, deeper.length > 0 ? "dir" : entry.kind);
      }
      for (const folder of state.folders) {
        const rest = folder.startsWith(prefix) ? folder.slice(prefix.length) : undefined;
        const first = rest?.split("/")[0];
        if (first) children.set(first, "dir");
      }
      return [...children]
        .filter(
          ([name, type]) =>
            types.includes(type) && (params.show_hidden === "1" || !name.startsWith(".")),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, type]) => ({
          file,
          type,
          absdir: `${home}/${dir}`.replace(/\/$/, ""),
          fullpath: `${home}/${prefix}${file}`,
          exists: 1,
        }));
    },

    "SSL::installed_hosts": () =>
      [...state.installed].flatMap(([servername, id]) => {
        const certificate = state.certificates.find((entry) => entry.id === id);
        const domain = findDomain(servername);
        if (!certificate || !domain) return [];
        return [
          {
            servername,
            domains: [servername],
            fqdns: [servername, `www.${servername}`],
            docroot: rootOf(domain),
            ip: address,
            is_primary_on_ip: 0,
            needs_sni: 1,
            certificate: certificateFields(certificate),
          },
        ];
      }),
    "SSL::list_certs": () => state.certificates.map(certificateFields),
    "SSL::list_keys": () =>
      state.keys.map((key) => ({
        id: key.id,
        modulus: key.modulus,
        modulus_length: 2048,
        key_algorithm: "rsaEncryption",
        ecdsa_public: null,
      })),
    "SSL::get_autossl_problems": () =>
      state.autosslProblems.map((problem) => ({ ...problem, time: new Date(now()).toISOString() })),
    "SSL::is_autossl_check_in_progress": () => (state.autosslInProgress ? 1 : 0),
    "SSL::start_autossl_check": () => {
      for (const domain of state.domains) {
        const covered = state.installed.has(domain.name);
        const problem = state.autosslProblems.some((entry) => entry.domain === domain.name);
        if (domain.kind !== "parked" && !covered && !problem) issueCertificate(domain.name);
      }
      return null;
    },
    "SSL::delete_cert": (params) => {
      const id = need(params, "id");
      const certificate = state.certificates.find((entry) => entry.id === id);
      if (!certificate) throw new Refusal(`No certificate has the ID “${id}”.`);
      if ([...state.installed.values()].includes(id)) {
        throw new Refusal("The certificate is installed and cannot be deleted.");
      }
      state.certificates = state.certificates.filter((entry) => entry !== certificate);
      return [certificateFields(certificate)];
    },
    "SSL::delete_key": (params) => {
      const id = need(params, "id");
      const key = state.keys.find((entry) => entry.id === id);
      if (!key) throw new Refusal(`No key has the ID “${id}”.`);
      state.keys = state.keys.filter((entry) => entry !== key);
      return [{ id, modulus: key.modulus, key_algorithm: "rsaEncryption" }];
    },
  };

  // --- API2 ----------------------------------------------------------------------------------------

  const api2: Record<string, Handler> = {
    "AddonDomain::addaddondomain": (params) => {
      const name = need(params, "newdomain");
      const label = need(params, "subdomain");
      addDomain(name, "addon", need(params, "dir"), label);
      return [
        { result: 1, reason: `“${name}” was successfully parked on top of “${label}.${main}”.` },
      ];
    },
    "AddonDomain::deladdondomain": (params) => {
      const name = need(params, "domain");
      const domain = findDomain(name);
      if (domain?.kind !== "addon" || `${domain.addonSubdomain}_${main}` !== params.subdomain) {
        throw new Refusal(`The addon domain “${name}” does not exist.`);
      }
      removeDomain(name);
      return [{ result: 1, reason: `The addon domain “${name}” has been removed.` }];
    },
    "SubDomain::delsubdomain": (params) => {
      const name = need(params, "domain");
      if (findDomain(name)?.kind !== "subdomain") {
        throw new Refusal(`The subdomain “${name}” does not exist.`);
      }
      removeDomain(name);
      return [{ result: 1, reason: `The subdomain “${name}” has been removed.` }];
    },
    "Cron::add_line": (params) => {
      const line = {
        linekey: next(),
        minute: need(params, "minute"),
        hour: need(params, "hour"),
        day: need(params, "day"),
        month: need(params, "month"),
        weekday: need(params, "weekday"),
        command: need(params, "command"),
      };
      state.cron.push(line);
      return [{ linekey: line.linekey, statusmsg: "crontab installed", status: 1 }];
    },
    "Cron::listcron": () => [
      ...state.cron.map((line, index) => ({
        ...line,
        count: index + 1,
        command_htmlsafe: line.command,
      })),
      { count: state.cron.length + 1 },
    ],
    "Cron::remove_line": (params) => {
      const key = need(params, "linekey");
      if (!state.cron.some((line) => line.linekey === key)) {
        throw new Refusal(`No cron job has the key “${key}”.`);
      }
      state.cron = state.cron.filter((line) => line.linekey !== key);
      return [{ statusmsg: "crontab installed", status: 1 }];
    },
    "Fileman::fileop": (params) => {
      const op = need(params, "op");
      const source = need(params, "sourcefiles");
      const destination = params.destfiles;
      const fail = (reason: string) => [{ src: source, dest: destination, result: 0, reason }];
      let from: string;
      try {
        from = relative(source);
      } catch (error) {
        return fail((error as Error).message);
      }
      if (op === "unlink") {
        if (!exists(from)) return fail(missing(from).message);
        removeTree(from);
        return [{ src: source, result: 1 }];
      }
      if (op === "rename") {
        const to = relative(need(params, "destfiles"));
        if (!exists(from)) return fail(missing(from).message);
        if (exists(to)) return fail(`“${home}/${to}” already exists.`);
        for (const [key, entry] of [...state.files]) {
          if (key === from || key.startsWith(`${from}/`)) {
            state.files.delete(key);
            state.files.set(to + key.slice(from.length), entry);
          }
        }
        for (const folder of [...state.folders]) {
          if (folder === from || folder.startsWith(`${from}/`)) {
            state.folders.delete(folder);
            state.folders.add(to + folder.slice(from.length));
          }
        }
        return [{ src: source, dest: destination, result: 1 }];
      }
      if (op === "extract") {
        const to = relative(need(params, "destfiles"));
        const archive = state.files.get(from);
        if (archive?.kind !== "file") return fail(missing(from).message);
        const entries = untar(archive.content);
        if (entries === undefined) return fail("The archive could not be read.");
        for (const entry of entries) {
          const path = to === "" ? entry.name : `${to}/${entry.name}`;
          if (entry.type === "dir") {
            makeFolders(path);
          } else {
            removeTree(path);
            put(
              path,
              entry.type === "link"
                ? { kind: "link", target: entry.target }
                : { kind: "file", content: entry.content, mode: entry.mode },
            );
          }
        }
        return [{ src: source, dest: destination, result: 1, output: "" }];
      }
      return fail(`Unknown operation “${op}”.`);
    },
  };

  // --- HTTP ----------------------------------------------------------------------------------------

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const uapiAnswer = (
    module: string,
    func: string,
    status: 0 | 1,
    data: unknown,
    errors?: string[],
  ) =>
    json({
      apiversion: 3,
      func,
      module,
      result: {
        status,
        data,
        errors: errors ?? null,
        messages: null,
        warnings: null,
        metadata: {},
      },
    });
  const api2Answer = (module: string, func: string, data: unknown, error?: string) =>
    json({
      cpanelresult: {
        apiversion: 2,
        func,
        module,
        data,
        event: { result: 1 },
        ...(error !== undefined && { error }),
      },
    });

  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("authorization") !== `cpanel ${options.user}:${options.token}`) {
      return new Response("Access denied", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }
    const url = new URL(request.url);
    const params: Params = Object.fromEntries(url.searchParams);
    const files: { name: string; content: Uint8Array }[] = [];
    if (request.method === "POST") {
      for (const [name, value] of await request.formData()) {
        if (typeof value === "string") params[name] = value;
        else files.push({ name: value.name, content: new Uint8Array(await value.arrayBuffer()) });
      }
    }

    let api: "uapi" | "api2";
    let module: string;
    let func: string;
    const execute = /^\/execute\/([A-Za-z]+)\/([a-z_]+)$/.exec(url.pathname);
    if (execute) {
      api = "uapi";
      module = execute[1] as string;
      func = execute[2] as string;
    } else if (url.pathname === "/json-api/cpanel" && params.cpanel_jsonapi_apiversion === "2") {
      if (params.cpanel_jsonapi_user !== options.user)
        throw new Error("fakeCpanel: wrong API2 user");
      api = "api2";
      module = params.cpanel_jsonapi_module ?? "";
      func = params.cpanel_jsonapi_func ?? "";
      for (const key of Object.keys(params))
        if (key.startsWith("cpanel_jsonapi_")) delete params[key];
    } else {
      return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    calls.push({
      api,
      module,
      func,
      params: { ...params },
      ...(files.length > 0 && { files: files.map((file) => file.name) }),
    });

    const key = `${module}::${func}`;
    const handler = (api === "uapi" ? uapi : api2)[key];
    if (handler === undefined) throw new Error(`fakeCpanel: no ${api} handler for ${key}`);
    const feature = MODULE_FEATURES[module];
    const failure =
      failures.get(key)?.shift() ??
      (feature !== undefined && state.features[feature] !== 1
        ? `You do not have the feature “${feature}”.`
        : undefined);
    if (failure !== undefined) {
      if (api === "uapi") return uapiAnswer(module, func, 0, null, [failure]);
      return key === "Fileman::fileop"
        ? api2Answer(module, func, [{ result: 0, reason: failure }])
        : api2Answer(module, func, [], failure);
    }
    try {
      const data = handler(params, files);
      return api === "uapi" ? uapiAnswer(module, func, 1, data) : api2Answer(module, func, data);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return api === "uapi"
        ? uapiAnswer(module, func, 0, null, [error.message])
        : api2Answer(module, func, [], error.message);
    }
  };

  return {
    fetch,
    calls,
    state,
    failNext(module, func, reason) {
      const key = `${module}::${func}`;
      failures.set(key, [...(failures.get(key) ?? []), reason]);
    },
    readText(path) {
      const entry = state.files.get(path);
      return entry?.kind === "file" ? new TextDecoder().decode(entry.content) : undefined;
    },
    writeText(path, text, mode = 0o644) {
      put(path, { kind: "file", content: new TextEncoder().encode(text), mode });
    },
  };
}

function need(params: Params, name: string): string {
  const value = params[name];
  if (value === undefined || value === "")
    throw new Refusal(`The “${name}” parameter is required.`);
  return value;
}

type TarEntry =
  | { name: string; type: "file"; mode: number; content: Uint8Array }
  | { name: string; type: "dir" }
  | { name: string; type: "link"; target: string };

/** The entries of a ustar archive (files, folders and symbolic links), or undefined. */
function untar(bytes: Uint8Array): TarEntry[] | undefined {
  const text = (start: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, "");
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) return entries;
    if (text(offset + 257, 5) !== "ustar") return undefined;
    const prefix = text(offset + 345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${text(offset, 100)}`
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = text(offset + 156, 1) || "0";
    const body = offset + 512;
    if (type === "0") {
      const mode = Number.parseInt(text(offset + 100, 8).trim() || "644", 8);
      entries.push({ name, type: "file", mode, content: bytes.slice(body, body + size) });
    } else if (type === "5") {
      if (name !== "" && name !== ".") entries.push({ name, type: "dir" });
    } else if (type === "2") {
      entries.push({ name, type: "link", target: text(offset + 157, 100) });
    } else {
      return undefined;
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return entries;
}
