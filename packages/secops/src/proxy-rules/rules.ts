import { listText, normalizeHostName } from "@opscrew/core";
import { parseCaddy, parseNginx, type Statement } from "./parse";

/** What {@link scanProxyAdditions} checks an app's additions against. */
export interface ProxyAdditionsContext {
  proxy: "caddy" | "nginx";
  /** The app's own hostnames. */
  hostnames: string[];
  /** Where the app's traffic goes, as the site file names it (`host:port`). */
  upstream: string;
}

/** One refused line of an additions file: where, which rule, and what to do instead. */
export interface ProxyRefusal {
  line: number;
  rule: string;
  message: string;
}

/** The largest additions file accepted, in bytes. */
export const MAX_ADDITIONS_BYTES = 64 * 1024;

interface Syntax {
  parse(text: string): Statement[];
  /** Blocks whose lines are values (user names, header fields), not directives. */
  valueBlocks: ReadonlySet<string>;
  /** Directives that change the edge's TLS, which OpsCrew manages. */
  tls: RegExp;
  admin: ReadonlySet<string>;
  filesystem: ReadonlySet<string>;
  includes: ReadonlySet<string>;
  /** Directives that set where the edge listens. */
  listening: ReadonlySet<string>;
  /** Words that read the server's files or environment into the configuration. */
  readsServer?: RegExp;
  /** Where a directive sends requests on, when it does. */
  targets(s: Statement): string[] | undefined;
  /** The hostnames a directive serves or matches, when it names any. */
  hosts(s: Statement): string[] | undefined;
  /** How a directive sends logs off the server (`access_log syslog:`), when it does. */
  remoteLog(s: Statement): string | undefined;
  /** The name that is not on the contract's allow-list where it stands, if any. */
  notAllowed(s: Statement): string | undefined;
}

const nameOf = (s: Statement) => s.words[0]?.text ?? "";
const args = (s: Statement) => s.words.slice(1).map((w) => w.text);

/** The directives nginx additions may use, anywhere (contracts/edge-and-checks.md). */
const NGINX_ALLOWED = new Set([
  "location",
  "if",
  "add_header",
  "proxy_set_header",
  "proxy_hide_header",
  "proxy_redirect",
  "proxy_pass",
  "proxy_intercept_errors",
  "proxy_read_timeout",
  "proxy_send_timeout",
  "proxy_connect_timeout",
  "proxy_buffering",
  "proxy_request_buffering",
  "error_page",
  "return",
  "rewrite",
  "break",
  "internal",
  "limit_req",
  "limit_req_status",
  "allow",
  "deny",
  "client_max_body_size",
  "expires",
  "etag",
  "charset",
  "gzip",
  "gzip_types",
  "gzip_min_length",
  "gzip_vary",
  "gzip_proxied",
]);

/** The Caddy directives allowed at the top and in blocks of handlers. */
const CADDY_HANDLERS = new Set([
  "header",
  "request_header",
  "redir",
  "rewrite",
  "uri",
  "respond",
  "error",
  "abort",
  "handle",
  "handle_path",
  "route",
  "encode",
  "basic_auth",
  "basicauth",
  "request_body",
  "reverse_proxy",
  "copy_response",
  "copy_response_headers",
]);
/** Blocks whose lines are handler directives; `""` is the top of the file. */
const CADDY_HANDLER_BLOCKS = new Set(["", "handle", "handle_path", "route", "handle_response"]);
const CADDY_REQUEST_MATCHERS = new Set([
  "path",
  "path_regexp",
  "header",
  "header_regexp",
  "method",
  "query",
  "host",
  "remote_ip",
  "client_ip",
  "protocol",
  "not",
]);
/** Matchers on the app's response, in `@name` definitions inside `reverse_proxy`. */
const CADDY_RESPONSE_MATCHERS = new Set(["status", "header"]);
/** What `reverse_proxy`'s block may hold, besides `@name` response matchers. */
const CADDY_PROXY_OPTIONS = new Set([
  "to",
  "header_up",
  "header_down",
  "handle_response",
  "lb_try_duration",
  "lb_try_interval",
  "flush_interval",
  "stream_timeout",
]);
const CADDY_BLOCK_OPTIONS: Record<string, ReadonlySet<string>> = {
  reverse_proxy: CADDY_PROXY_OPTIONS,
  request_body: new Set(["max_size"]),
  encode: new Set(["gzip", "zstd", "minimum_length", "match"]),
  // `encode`'s `match` block holds matchers on the response.
  match: CADDY_RESPONSE_MATCHERS,
  copy_response_headers: new Set(["include", "exclude"]),
};

/** The matcher a matcher line uses (`path` in `@api path /api/*` or `not path /x`), if allowed. */
function notAllowedMatcher(
  words: Statement["words"],
  set: ReadonlySet<string>,
): string | undefined {
  const [first, second] = words;
  if (!first) return undefined;
  // A quoted word right after `@name` is the `expression` matcher's short form.
  if (first.quoted) return "expression";
  if (!set.has(first.text)) return first.text;
  return first.text === "not" && second ? notAllowedMatcher(words.slice(1), set) : undefined;
}

function caddyNotAllowed(s: Statement): string | undefined {
  const name = nameOf(s);
  const block = s.parents.at(-1) ?? "";
  const definition = s.parents.findLastIndex((p) => p.startsWith("@"));
  const matchers =
    s.parents[definition - 1] === "reverse_proxy"
      ? CADDY_RESPONSE_MATCHERS
      : CADDY_REQUEST_MATCHERS;
  if (block.startsWith("@") || block === "not") return notAllowedMatcher(s.words, matchers);
  if (name.startsWith("@") && !s.words[0]?.quoted) {
    if (block !== "reverse_proxy" && !CADDY_HANDLER_BLOCKS.has(block)) return name;
    const set = block === "reverse_proxy" ? CADDY_RESPONSE_MATCHERS : CADDY_REQUEST_MATCHERS;
    return notAllowedMatcher(s.words.slice(1), set);
  }
  const allowed = CADDY_HANDLER_BLOCKS.has(block) ? CADDY_HANDLERS : CADDY_BLOCK_OPTIONS[block];
  return allowed?.has(name) ? undefined : name;
}

const NGINX_UPSTREAMS = new Set([
  "proxy_pass",
  "fastcgi_pass",
  "grpc_pass",
  "uwsgi_pass",
  "scgi_pass",
  "memcached_pass",
]);
const CADDY_UPSTREAMS = new Set(["reverse_proxy", "php_fastcgi", "forward_auth"]);

const SYNTAX: Record<ProxyAdditionsContext["proxy"], Syntax> = {
  nginx: {
    parse: parseNginx,
    valueBlocks: new Set(),
    tls: /^ssl(?:_|$)/,
    admin: new Set(["stub_status", "api", "status"]),
    filesystem: new Set(["root", "alias", "autoindex", "auth_basic_user_file"]),
    includes: new Set(["include"]),
    listening: new Set(["listen"]),
    targets: (s) => (NGINX_UPSTREAMS.has(nameOf(s)) ? [args(s)[0] ?? ""] : undefined),
    hosts: (s) => (nameOf(s) === "server_name" ? args(s) : undefined),
    remoteLog(s) {
      const name = nameOf(s);
      const remote =
        (name === "access_log" || name === "error_log") && /^syslog:/.test(args(s)[0] ?? "");
      return remote ? `${name} syslog:` : undefined;
    },
    notAllowed(s) {
      const name = nameOf(s);
      if (!NGINX_ALLOWED.has(name)) return name;
      // The app's own request zone is `opscrew_<app>`, defined by OpsCrew's site template.
      const sharedZone = name === "limit_req" && !args(s).some((a) => /^zone=opscrew_/.test(a));
      return sharedZone ? name : undefined;
    },
  },
  caddy: {
    parse: parseCaddy,
    valueBlocks: new Set(["basic_auth", "basicauth", "header", "request_header"]),
    tls: /^tls$/,
    admin: new Set(["admin", "metrics"]),
    filesystem: new Set(["root", "file_server"]),
    includes: new Set(["import"]),
    listening: new Set(["bind"]),
    readsServer: /\{(?:file\.|env\.|\$)/,
    targets(s) {
      const name = nameOf(s);
      if (CADDY_UPSTREAMS.has(name)) {
        const list = args(s);
        // The first word may be a matcher: `*`, a path or `@name`.
        return /^[*/@]/.test(list[0] ?? "") ? list.slice(1) : list;
      }
      if (!CADDY_UPSTREAMS.has(s.parents.at(-1) ?? "")) return undefined;
      if (name === "to") return args(s);
      // `dynamic` picks upstreams while the site runs, and `transport` can send the traffic
      // through other proxies or resolvers: neither can be checked.
      return name === "dynamic" || name === "transport" ? [""] : undefined;
    },
    hosts(s) {
      const words = s.words.map((w) => w.text);
      if (words[0]?.startsWith("@") && words[1] === "host") return words.slice(2);
      if (words[0] === "host" && s.parents.some((p) => p.startsWith("@"))) return words.slice(1);
      return undefined;
    },
    remoteLog: (s) =>
      nameOf(s) === "output" && s.parents.at(-1) === "log" && args(s)[0] === "net"
        ? "output net"
        : undefined,
    notAllowed: caddyNotAllowed,
  },
};

const SCRIPTING = /_by_lua|^js_|^perl(?:_|$)/;

/** True when `target` is the app's upstream, optionally with a path (`http://app:3000/v2/`). */
function isUpstream(target: string, upstream: string): boolean {
  const bare = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const got = bare(target);
  const want = bare(upstream);
  return got === want || got.startsWith(`${want}/`);
}

type Check = (s: Statement, syntax: Syntax, ctx: ProxyAdditionsContext) => string | undefined;

/** Rules that also apply inside value blocks, since they look at every word. */
const EVERY_WORD = new Set(["placeholder"]);

/** Each rule: a message saying what to do instead when the statement breaks it. */
const RULES: Record<string, Check> = {
  tls: (s, syntax) => {
    const name = nameOf(s);
    if (!syntax.tls.test(name)) return undefined;
    return `\`${name}\` changes the edge's TLS, which OpsCrew manages for every app (TLS 1.2 and 1.3, the certificates and the client checks). Remove it.`;
  },
  "admin-endpoint": (s, syntax) => {
    const name = nameOf(s);
    if (!syntax.admin.has(name)) return undefined;
    return `\`${name}\` would open the proxy's own admin, metrics or status page to the internet. Remove it: the edge exposes none.`;
  },
  upstream: (s, syntax, { upstream }) => {
    const targets = syntax.targets(s);
    if (targets === undefined || targets.every((t) => isUpstream(t, upstream))) return undefined;
    const name = nameOf(s);
    if (name === "dynamic" || name === "transport") {
      return `\`${name}\` could send traffic somewhere other than this app, through upstreams or proxies chosen elsewhere. Remove it, and list only \`${upstream}\`, the app's upstream.`;
    }
    return `\`${name}\` sends traffic somewhere other than this app. Send it only to \`${upstream}\`, the app's upstream, or remove the line.`;
  },
  logs: (s, syntax) => {
    const remote = syntax.remoteLog(s);
    if (remote === undefined) return undefined;
    return `\`${remote}\` sends the app's logs off the server. Remove it: the edge keeps its logs on the server.`;
  },
  hostname: (s, syntax, { hostnames }) => {
    const name = nameOf(s);
    if (name === "}" && s.words.length === 1 && s.parents.length === 0) {
      return "This `}` closes no block of the file, so it would close the app's site and what follows could serve other hostnames. Remove it.";
    }
    if (syntax.listening.has(name)) {
      return `\`${name}\` changes where the edge listens, which OpsCrew sets for every app. Remove it.`;
    }
    const names = syntax.hosts(s);
    if (names === undefined) return undefined;
    const own = new Set(hostnames.map(normalizeHostName));
    const others = names.filter((n) => !own.has(normalizeHostName(n)));
    if (others.length === 0) return undefined;
    const what = name === "server_name" ? "`server_name`" : "The `host` matcher";
    return `${what} names ${listText(others)}, which ${others.length === 1 ? "is" : "are"} not this app's (${listText(hostnames)}). Use only the app's hostnames, which come from plan.yaml.`;
  },
  filesystem: (s, syntax) => {
    const name = nameOf(s);
    if (!syntax.filesystem.has(name)) return undefined;
    if (name === "auth_basic_user_file") {
      return "`auth_basic_user_file` reads a password file on the server, and the edge keeps no files of its own. Protect the paths with Cloudflare Access or in the app instead.";
    }
    return `\`${name}\` would make the edge serve files from the server, and it serves none of its own. Serve the files from the app instead.`;
  },
  placeholder: (s, syntax) => {
    const reads = syntax.readsServer;
    if (reads === undefined || !s.words.some((w) => reads.test(w.text))) return undefined;
    return "A `{file.…}`, `{env.…}` or `{$…}` placeholder reads the server's files or environment, which can hold secrets. Write the value itself instead.";
  },
  includes: (s, syntax) => {
    const name = nameOf(s);
    if (!syntax.includes.has(name)) return undefined;
    return `\`${name}\` pulls in another file, which OpsCrew cannot check. Put the rules in this file instead.`;
  },
  scripting: (s) => {
    const name = nameOf(s);
    if (!SCRIPTING.test(name)) return undefined;
    return `\`${name}\` runs a script inside the proxy. Do this in the app instead.`;
  },
};

/**
 * Per line: control characters other than tab and a final CR, a CR inside the line, U+FEFF, and
 * every space separator but U+0020, which the proxies do not split words on as JavaScript does.
 */
const CONTROL = /[^\P{Cc}\t\r]|\r(?!$)|[^\P{Z} ]|\uFEFF/u;

function notAllowedMessage(name: string): string {
  if (name === "limit_req") {
    return "`limit_req` may use only this app's own zone, `zone=opscrew_<app>`, which OpsCrew defines. Use that zone.";
  }
  return `\`${name}\` is not supported in additions yet; tell OpsCrew if you need it.`;
}

/**
 * Checks an app's additions file for `ctx.proxy`. Every directive must be on the contract's
 * allow-list for its proxy and place (`not-allowed`), and OpsCrew's rules check the arguments
 * and give clearer messages for the commonest cases: TLS settings, admin endpoints, traffic or
 * logs sent anywhere but the app's upstream, other hostnames, files, placeholders that read the
 * server's files or environment, includes, scripting, control characters and the size limit.
 * Comments and quoted words never trigger a rule, except a placeholder. Inside a refused block
 * only these rules apply, not the allow-list. Pure: returns the refusals in line order, none when
 * the file may be used.
 */
export function scanProxyAdditions(text: string, ctx: ProxyAdditionsContext): ProxyRefusal[] {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ADDITIONS_BYTES) {
    return [
      {
        line: 1,
        rule: "size",
        message: `The additions file is ${Math.ceil(bytes / 1024)} KiB, over the 64 KiB limit. Keep only what the edge must do and move the rest into the app.`,
      },
    ];
  }
  const syntax = SYNTAX[ctx.proxy];
  const refusals: ProxyRefusal[] = [];
  text.split("\n").forEach((content, index) => {
    if (CONTROL.test(content)) {
      refusals.push({
        line: index + 1,
        rule: "characters",
        message:
          "This line holds a control character or an unusual space, which can hide what the line does. Use plain spaces and remove the rest.",
      });
    }
  });
  const statements = syntax.parse(text);
  /** Per statement: whether it, or a block around it, was refused. */
  const refused: boolean[] = [];
  for (const statement of statements) {
    const values = statement.parents.some((p) => syntax.valueBlocks.has(p));
    const before = refusals.length;
    for (const [rule, check] of Object.entries(RULES)) {
      if (values && !EVERY_WORD.has(rule)) continue;
      const message = check(statement, syntax, ctx);
      if (message !== undefined) refusals.push({ line: statement.line, rule, message });
    }
    const inRefused = refused[statement.parent] ?? false;
    const name = values || inRefused ? undefined : syntax.notAllowed(statement);
    if (name !== undefined && refusals.length === before) {
      refusals.push({
        line: statement.line,
        rule: "not-allowed",
        message: notAllowedMessage(name),
      });
    }
    refused.push(inRefused || refusals.length > before);
  }
  return refusals.sort((a, b) => a.line - b.line);
}
