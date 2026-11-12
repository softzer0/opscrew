import type { FetchLike, HostingPanelAccess } from "@opscrew/contracts";

/**
 * An in-memory DirectAdmin user account answering the calls `DirectAdminPanel` makes, in the
 * shapes DirectAdmin documents (swagger.json and the legacy API pages), for agents' tests:
 * `new DirectAdminPanel(fake.access, { fetch: fake.fetch })`. Its state is public so tests can
 * set it up and check it.
 */

/** A file, folder or symbolic link in the fake's home folder. */
export type FakeDirectAdminEntry =
  | { type: "file"; content: Uint8Array; mode: number }
  | { type: "dir" }
  | { type: "symlink"; target: string };

/** A certificate the fake's ACME client issued. */
export interface FakeDirectAdminCertificate {
  id: string;
  dnsNames: string[];
  notAfter: string;
  /** `core.TLSBundleErrorReason`; "" for a valid one. */
  error: string;
}

/** A request the fake received. */
export interface FakeDirectAdminCall {
  method: string;
  /** Path and query. */
  path: string;
}

export interface FakeDirectAdminOptions {
  /** Default "alice". */
  user?: string;
  /** The login key; default a fixed fake value. */
  token?: string;
  /** The account's domains; the first is the main one. Default `["example.com"]`. */
  domains?: string[];
  /** Default "203.0.113.10". */
  ip?: string;
  /** The database server's version. Default "10.11.9-MariaDB". */
  databaseVersion?: string;
  /**
   * Where new subdomains' document roots go: `own` (`domains/<sub.domain>/public_html`, since
   * DirectAdmin 1.647) or `parent` (`domains/<domain>/public_html/<sub>`, before). Default `own`.
   */
  subdomainLayout?: "own" | "parent";
  /** Whether the account may get ACME certificates. Default true. */
  acme?: boolean;
  /** Bytes used and the quota (absent: unlimited). */
  quota?: { usedBytes: number; limitBytes?: number };
}

/** A canned failure for the next request matching `METHOD /path` (without the query). */
export interface FakeDirectAdminFailure {
  status: number;
  /** Sent as JSON for `/api/…`, as it is for `/CMD_API_*`. */
  body?: unknown;
}

const API_CERT_DAYS = 90;

export class FakeDirectAdmin {
  readonly access: HostingPanelAccess;
  readonly calls: FakeDirectAdminCall[] = [];
  readonly domains: string[];
  /** Subdomain labels by domain. */
  readonly subdomains = new Map<string, string[]>();
  readonly databases = new Set<string>();
  /** Database user → the database it was made for. */
  readonly databaseUsers = new Map<string, string>();
  /** Cron id → `<five fields> <command>`. */
  readonly cron = new Map<string, string>();
  /** Paths relative to the home folder; the home folder itself is "". */
  readonly files = new Map<string, FakeDirectAdminEntry>();
  /** Certificates by domain. */
  readonly certificates = new Map<string, FakeDirectAdminCertificate[]>();
  readonly fetch: FetchLike;
  private readonly failures = new Map<string, FakeDirectAdminFailure[]>();
  private readonly options: Required<Omit<FakeDirectAdminOptions, "quota">> &
    Pick<FakeDirectAdminOptions, "quota">;
  private nextId = 1;

  constructor(options: FakeDirectAdminOptions = {}) {
    this.options = {
      user: options.user ?? "alice",
      token: options.token ?? "fake-directadmin-login-key-0001",
      domains: options.domains ?? ["example.com"],
      ip: options.ip ?? "203.0.113.10",
      databaseVersion: options.databaseVersion ?? "10.11.9-MariaDB",
      subdomainLayout: options.subdomainLayout ?? "own",
      acme: options.acme ?? true,
      ...(options.quota === undefined ? {} : { quota: options.quota }),
    };
    this.access = {
      url: "https://panel.example.test:2222",
      user: this.options.user,
      token: this.options.token,
    };
    this.domains = [...this.options.domains];
    this.files.set("", { type: "dir" });
    for (const domain of this.domains) {
      this.subdomains.set(domain, []);
      this.mkdir(`domains/${domain}/public_html`);
    }
    this.fetch = (input, init) => this.handle(String(input), init ?? {});
  }

  /** The next request to `METHOD /path` (no query) fails with `failure`. */
  failNext(route: string, failure: FakeDirectAdminFailure): void {
    this.failures.set(route, [...(this.failures.get(route) ?? []), failure]);
  }

  /** A file's content as text, or undefined. */
  text(path: string): string | undefined {
    const entry = this.files.get(path);
    return entry?.type === "file" ? new TextDecoder().decode(entry.content) : undefined;
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    this.calls.push({ method, path: `${parsed.pathname}${parsed.search}` });
    const headers = new Headers(init.headers);
    const expected = `Basic ${Buffer.from(`${this.access.user}:${this.access.token}`).toString("base64")}`;
    if (headers.get("authorization") !== expected) return json(401, { type: "UNAUTHORIZED" });
    const route = `${method} ${parsed.pathname}`;
    const failure = this.failures.get(route)?.shift();
    if (failure !== undefined) {
      return parsed.pathname.startsWith("/api/")
        ? json(failure.status, failure.body)
        : new Response(String(failure.body ?? ""), { status: failure.status });
    }
    if (parsed.pathname.startsWith("/CMD_API_")) {
      const params =
        method === "GET" ? parsed.searchParams : new URLSearchParams(String(init.body ?? ""));
      return legacy(this.legacy(parsed.pathname.slice(1), method, params));
    }
    return this.api(method, parsed, init);
  }

  // --- The legacy API -------------------------------------------------------------------------

  private legacy(command: string, method: string, params: URLSearchParams): URLSearchParams {
    if (command === "CMD_API_SUBDOMAINS") return this.subdomainCall(params);
    if (command === "CMD_API_CRON_JOBS") return this.cronCall(method, params);
    return failed(`Unknown command ${command}`);
  }

  private subdomainCall(params: URLSearchParams): URLSearchParams {
    const domain = params.get("domain") ?? "";
    const subs = this.subdomains.get(domain);
    if (subs === undefined) return failed("You do not own that domain");
    const action = params.get("action");
    if (action === null) {
      const answer = new URLSearchParams();
      for (const sub of subs) answer.append("list[]", sub);
      return answer;
    }
    if (action === "create") {
      const sub = params.get("subdomain") ?? "";
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(sub)) return failed("Invalid subdomain name");
      if (subs.includes(sub)) return failed("That subdomain already exists");
      subs.push(sub);
      this.mkdir(
        this.options.subdomainLayout === "own"
          ? `domains/${sub}.${domain}/public_html`
          : `domains/${domain}/public_html/${sub}`,
      );
      return done("Subdomain created");
    }
    if (action === "delete") {
      for (const [key, sub] of params) {
        if (!key.startsWith("select")) continue;
        const index = subs.indexOf(sub);
        if (index === -1) return failed(`No such subdomain ${sub}`);
        subs.splice(index, 1);
        if (params.get("contents") === "yes") {
          this.removeTree(`domains/${sub}.${domain}`);
          this.removeTree(`domains/${domain}/public_html/${sub}`);
        }
      }
      return done("Subdomain deleted");
    }
    return failed(`Unknown action ${action}`);
  }

  private cronCall(method: string, params: URLSearchParams): URLSearchParams {
    const action = params.get("action");
    if (method === "GET" && action === null) {
      const answer = new URLSearchParams();
      for (const [id, line] of this.cron) answer.append(id, line);
      return answer;
    }
    if (action === "create") {
      const fields = ["minute", "hour", "dayofmonth", "month", "dayofweek"].map(
        (name) => params.get(name) ?? "",
      );
      const command = params.get("command") ?? "";
      if (fields.some((field) => !/^[0-9*/,-]+$/.test(field)) || command === "") {
        return failed("Invalid cron job");
      }
      this.cron.set(String(this.nextId++), `${fields.join(" ")} ${command}`);
      return done("Cron job created");
    }
    if (action === "delete") {
      for (const [key, id] of params) {
        if (key.startsWith("select")) this.cron.delete(id);
      }
      return done("Cron jobs deleted");
    }
    return failed(`Unknown action ${action}`);
  }

  // --- The JSON API ---------------------------------------------------------------------------

  private async api(method: string, url: URL, init: RequestInit): Promise<Response> {
    const path = url.pathname;
    const query = url.searchParams;
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const route = `${method} ${path}`;
    const user = this.options.user;

    if (route === "GET /api/session/user-config") {
      return json(200, {
        domain: this.domains[0] ?? "",
        domains: this.domains,
        ip: this.options.ip,
      });
    }
    if (route === "GET /api/session/user-usage") {
      const quota = this.options.quota;
      return json(200, {
        quotaBytes: {
          usage: quota?.usedBytes ?? 0,
          limit: quota?.limitBytes ?? -1,
          unlimited: quota?.limitBytes === undefined,
        },
      });
    }
    if (route === "GET /api/db-show/info") {
      return json(200, {
        address: "localhost",
        unixSocket: false,
        version: this.options.databaseVersion,
        maxDatabaseLength: 64,
        maxUsernameLength: 32,
        maxHostsPerUser: 30,
        defaultHostPatterns: ["localhost"],
        oneClickPhpMyAdminLogin: true,
        sqlMode: [],
      });
    }
    if (route === "GET /api/db-show/databases") {
      return json(
        200,
        [...this.databases].map((database) => ({
          database,
          definerIssues: 0,
          sizeBytes: 0,
          tableCount: 0,
          userCount: [...this.databaseUsers.values()].filter((db) => db === database).length,
        })),
      );
    }
    if (route === "POST /api/db-manage/create-db-with-user") {
      const database = String(body.database ?? "");
      const dbuser = String(body.dbuser ?? database);
      if (!database.startsWith(`${user}_`) || !dbuser.startsWith(`${user}_`)) {
        return json(494, { type: "DATABASE_INVALID_ENTITY_NAME" });
      }
      if (this.databases.has(database) || this.databaseUsers.has(dbuser)) {
        return json(490, { type: "ALREADY_EXISTS" });
      }
      this.databases.add(database);
      this.databaseUsers.set(dbuser, database);
      return json(200, {
        address: "localhost",
        database,
        dbuser,
        hostPatterns: ["localhost"],
        password: String(body.password ?? ""),
        privileges: {},
        unixSocket: false,
      });
    }
    const dbUser = /^\/api\/db-manage\/users\/([^/]+)$/.exec(path);
    if (method === "DELETE" && dbUser) {
      this.databaseUsers.delete(decodeURIComponent(dbUser[1] as string));
      return new Response(null, { status: 204 });
    }
    const db = /^\/api\/db-manage\/databases\/([^/]+)$/.exec(path);
    if (method === "DELETE" && db) {
      this.databases.delete(decodeURIComponent(db[1] as string));
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/api/filemanager")) return this.fileCall(route, query, body, init);
    const tls = /^\/api\/domain-tls\/domains\/([^/]+)\/(certs|provision-certs)(?:\/([^/]+))?$/.exec(
      path,
    );
    if (tls) return this.tlsCall(method, decodeURIComponent(tls[1] as string), tls[2], tls[3]);
    return json(404, { type: "NOT_FOUND" });
  }

  private async fileCall(
    route: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    init: RequestInit,
  ): Promise<Response> {
    if (route === "GET /api/filemanager/stat") {
      const path = clean(query.get("path") ?? ".");
      const entry = this.files.get(path);
      if (entry === undefined) return opError(path, "NOT_FOUND");
      return json(200, {
        canonicalPath: path,
        info: { name: path.split("/").pop(), type: entry.type },
      });
    }
    if (route === "GET /api/filemanager/list") {
      const path = clean(query.get("path") ?? ".");
      if (this.files.get(path)?.type !== "dir") return opError(path, "NOT_FOUND");
      const prefix = path === "" ? "" : `${path}/`;
      const files = [...this.files]
        .filter(
          ([key]) =>
            key.startsWith(prefix) && key !== path && !key.slice(prefix.length).includes("/"),
        )
        .map(([key, entry]) => ({ name: key.slice(prefix.length), type: entry.type }));
      return json(200, {
        canonicalPath: path,
        files,
        filesLimit: Number(query.get("limit") ?? 1000),
        filesMatched: files.length,
        filesTotal: files.length,
      });
    }
    if (route === "GET /api/filemanager/download") {
      const entry = this.files.get(clean(query.get("path") ?? ""));
      if (entry?.type !== "file") return json(404, { type: "NOT_FOUND" });
      return new Response(new Uint8Array(entry.content), { status: 200 });
    }
    if (route === "POST /api/filemanager-actions/upload") {
      const dir = clean(query.get("dir") ?? ".");
      const form = init.body as FormData;
      const file = form.get("file") as File | null;
      const name = query.get("name") ?? file?.name ?? "";
      if (file === null || name === "" || name.includes("/")) {
        return json(400, { type: "BAD_REQUEST", message: "No file" });
      }
      if (this.files.get(dir)?.type !== "dir") return opError(dir, "NOT_FOUND");
      const path = join(dir, name);
      if (this.files.has(path) && query.get("overwrite") !== "true") {
        return opError(path, "ALREADY_EXISTS");
      }
      const perm = query.get("perm") ?? "0644";
      this.files.set(path, {
        type: "file",
        content: new Uint8Array(await file.arrayBuffer()),
        mode: Number.parseInt(perm, perm.startsWith("0") ? 8 : 10),
      });
      return new Response(null, { status: 204 });
    }
    if (route === "POST /api/filemanager-actions/move") {
      const source = clean(String(body.source));
      const destination = clean(String(body.destination));
      const entry = this.files.get(source);
      if (entry === undefined) return opError(source, "NOT_FOUND");
      if (this.files.has(destination) && body.overwrite !== true) {
        return opError(destination, "ALREADY_EXISTS");
      }
      if (this.files.get(parentOf(destination))?.type !== "dir") {
        return opError(destination, "NOT_FOUND");
      }
      this.files.delete(source);
      this.files.set(destination, entry);
      return new Response(null, { status: 204 });
    }
    if (route === "POST /api/filemanager-actions/remove") {
      const paths = (body.paths as string[]).map(clean);
      const missing = paths.filter((path) => !this.files.has(path));
      for (const path of paths) this.removeTree(path);
      if (missing.length > 0) {
        return json(409, {
          type: "FILEMANAGER_MULTI_OP_ERROR",
          errors: missing.map((path) => ({ path, reason: "NOT_FOUND" })),
        });
      }
      return new Response(null, { status: 204 });
    }
    if (route === "POST /api/filemanager-actions/extract-archive") {
      const source = clean(String(body.source));
      const destination = clean(String(body.destinationDir));
      const archive = this.files.get(source);
      if (archive?.type !== "file") return opError(source, "NOT_FOUND");
      if (this.files.get(destination)?.type !== "dir") return opError(destination, "NOT_FOUND");
      const entries = readTar(archive.content);
      if (entries === undefined) return opError(source, "FILE_NOT_SUPPORTED");
      for (const entry of entries) {
        const path = join(destination, entry.name);
        if (this.files.has(path) && body.mergeAndOverwrite !== true) {
          return opError(path, "ALREADY_EXISTS");
        }
        this.mkdir(parentOf(path));
        if (entry.entry.type === "dir") this.mkdir(path);
        else this.files.set(path, entry.entry);
      }
      return new Response(null, { status: 204 });
    }
    return json(404, { type: "NOT_FOUND" });
  }

  private tlsCall(
    method: string,
    domain: string,
    action: string | undefined,
    id: string | undefined,
  ): Response {
    if (!this.domains.includes(domain)) return json(404, { type: "NOT_FOUND" });
    const certs = this.certificates.get(domain) ?? [];
    const names = this.namesOf(domain);
    if (method === "GET" && action === "certs" && id === undefined) {
      const covered = (name: string) =>
        certs.some((cert) => cert.error === "" && cert.dnsNames.includes(name));
      return json(200, {
        certIds: certs.filter((cert) => cert.error === "").map((cert) => cert.id),
        certs: certs.map((cert) => ({
          id: cert.id,
          autorenewEnabled: true,
          error: cert.error,
          certificate: {
            dnsNames: cert.dnsNames,
            ipAddresses: [],
            issuer: "CN=Fake ACME",
            notBefore: "2026-11-01T00:00:00Z",
            notAfter: cert.notAfter,
            prettyType: "ECDSA P-256",
            serialNumber: cert.id,
            subject: `CN=${cert.dnsNames[0]}`,
          },
        })),
        missingDNSNames: names.filter((name) => !covered(name)),
      });
    }
    if (method === "POST" && action === "provision-certs") {
      if (!this.options.acme) return json(409, { type: "DOMAIN_ACME_IS_DISABLED" });
      const covered = new Set(
        certs.filter((cert) => cert.error === "").flatMap((cert) => cert.dnsNames),
      );
      const missing = names.filter((name) => !covered.has(name));
      for (const name of missing) {
        certs.push({
          id: `cert-${this.nextId++}`,
          dnsNames: [name],
          notAfter: new Date(Date.UTC(2027, 0, 1) + API_CERT_DAYS * 86_400_000).toISOString(),
          error: "",
        });
      }
      this.certificates.set(domain, certs);
      return json(200, { logIDs: missing.length === 0 ? [] : [this.nextId++] });
    }
    if (method === "DELETE" && action === "certs" && id !== undefined) {
      const index = certs.findIndex((cert) => cert.id === decodeURIComponent(id));
      if (index === -1) return json(404, { type: "NOT_FOUND" });
      certs.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json(404, { type: "NOT_FOUND" });
  }

  // --- State helpers --------------------------------------------------------------------------

  /** A domain's names that should have a certificate: itself and its subdomains. */
  private namesOf(domain: string): string[] {
    return [domain, ...(this.subdomains.get(domain) ?? []).map((sub) => `${sub}.${domain}`)];
  }

  private mkdir(path: string): void {
    const parts = path === "" ? [] : path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (!this.files.has(prefix)) this.files.set(prefix, { type: "dir" });
    }
  }

  private removeTree(path: string): void {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function opError(path: string, reason: string): Response {
  return json(409, { type: "FILEMANAGER_OP_ERROR", path, reason });
}

function legacy(answer: URLSearchParams): Response {
  return new Response(answer.toString(), {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function done(text: string): URLSearchParams {
  return new URLSearchParams({ error: "0", text, details: "" });
}

function failed(text: string): URLSearchParams {
  return new URLSearchParams({ error: "1", text: "Cannot do that", details: text });
}

function clean(path: string): string {
  return path === "." ? "" : path.replace(/^\.?\//, "").replace(/\/$/, "");
}

function join(dir: string, name: string): string {
  return dir === "" ? clean(name) : `${dir}/${clean(name)}`;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** A ustar archive's files, folders and links, or undefined when it isn't one. */
function readTar(archive: Uint8Array): { name: string; entry: FakeDirectAdminEntry }[] | undefined {
  const decoder = new TextDecoder();
  const field = (block: Uint8Array, start: number, length: number) =>
    decoder.decode(block.subarray(start, start + length)).replace(/\0.*$/s, "");
  const entries: { name: string; entry: FakeDirectAdminEntry }[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) return entries;
    if (!field(block, 257, 6).startsWith("ustar")) return undefined;
    const prefix = field(block, 345, 155);
    const name = clean(`${prefix === "" ? "" : `${prefix}/`}${field(block, 0, 100)}`);
    const mode = Number.parseInt(field(block, 100, 8).trim() || "0", 8);
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = field(block, 156, 1);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    if (type === "5") entries.push({ name, entry: { type: "dir" } });
    else if (type === "2")
      entries.push({ name, entry: { type: "symlink", target: field(block, 157, 100) } });
    else if (type === "0" || type === "") {
      entries.push({ name, entry: { type: "file", content: new Uint8Array(data), mode } });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
