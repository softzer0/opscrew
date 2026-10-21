// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Caddy placeholders and nginx variables, not JavaScript templates.
/**
 * `vercel.json`'s routing rules as an app's additions for the server's proxy (FR-1446, plan.md
 * "16.", research.md R7). Vercel's order is kept: headers, then redirects (`cleanUrls` and
 * `trailingSlash` first), then rewrites. A rewrite applies only when the app answers 404 for the
 * original path, since Vercel serves the app's own files before it rewrites ("Spike results" 17).
 */
import { type PlatformRouting, VercelSourceSchema } from "@opscrew/plan-schema";
import { BASELINE_HEADERS } from "../runtime/services";
import type { EdgeProxy } from "./index";

/** What the translation is for: the proxy, the app's hostnames and its upstream (`EDGE_PROXIES`). */
export interface VercelRoutingContext {
  proxy: EdgeProxy;
  hostnames: string[];
  /** Where the app's traffic goes, as the site file names it: `kamal-proxy:80`, or `kamal-proxy`. */
  upstream: string;
}

/** The additions text, and each rule left out (`rewrites[3]`, `cleanUrls`) with the reason. */
export interface VercelRoutingTranslation {
  text: string;
  skipped: { rule: string; reason: string }[];
}

/** A rule that cannot be translated; its message is the plain reason. */
class Skip extends Error {}

/** A source as an anchored regular expression, with its capture groups' names in order. */
interface Pattern {
  regex: string;
  groups: (string | undefined)[];
}

/** One path segment, path-to-regexp's default parameter pattern. */
const SEGMENT = "[^/]+";

/** Regular-expression forms Caddy's RE2 does not have: lookarounds, atomic groups, backreferences. */
const NOT_RE2 = /\(\?<?[=!]|\(\?>|\\[1-9]|\\k</;

/** Caddy placeholders that read the server's environment or files. */
const READS_SERVER = /\{(?:\$|env\.|file\.)/;

/** Headers OpsCrew's edge sets on every response itself (FR-1442). */
const EDGE_HEADERS = new Set(
  ["Strict-Transport-Security", "Alt-Svc", "Server", ...BASELINE_HEADERS.map(([name]) => name)].map(
    (name) => name.toLowerCase(),
  ),
);

/** Sources that match every path, which nginx gets at server level instead of in a `location`. */
const EVERY_PATH = /^(?:\/(?:\(\.\*\)|:[A-Za-z_]\w*(?:\*|\(\.\*\)))|\^\/?\(?\.\*\)?\$?)$/;

/**
 * nginx's guard on every pattern it gets: no path with a CR or LF, which nginx decodes into `$uri`
 * and a capture would carry into a header (response splitting).
 */
const NO_NEWLINE = "(?!.*[\\r\\n])";

/** Characters the proxy would not read as written: quotes, backslashes, control characters, nginx's `$`, Caddy's braces. */
const UNSAFE: Record<EdgeProxy, RegExp> = {
  nginx: /["\\$\p{Cc}]/u,
  caddy: /["\\{}\p{Cc}]/u,
};

/** The first character of `text` the proxy cannot take as it is (and any space, without `spaces`). */
function unsafeChar(text: string, proxy: EdgeProxy, spaces: boolean): string | undefined {
  return UNSAFE[proxy].exec(text)?.[0] ?? (spaces ? undefined : /\s/.exec(text)?.[0]);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The index of the `)` closing the group that opens at `start`; a capturing group inside it
 * cannot be numbered the way Vercel numbers parameters, so it is skipped.
 */
function groupEnd(source: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "\\") i++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "(") {
      if (depth > 0 && source.charAt(i + 1) !== "?") {
        throw new Skip("a parameter's pattern has a capturing group of its own");
      }
      depth++;
    } else if (ch === ")" && --depth === 0) return i;
  }
  throw new Skip("its pattern has an unclosed `(`");
}

/**
 * A path-to-regexp source (`/blog/:slug`, `/:path*`, `/(.*)`, `/:path((?!uk/).*)`) as an anchored
 * regular expression. A `*`, `+` or `?` parameter takes the `/` before it along, as in
 * path-to-regexp.
 */
function pathPattern(source: string): Pattern {
  let regex = "";
  const groups: (string | undefined)[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      regex += escapeRegex(source.charAt(i + 1));
      i += 2;
    } else if (ch === ":" || ch === "(") {
      let name: string | undefined;
      if (ch === ":") {
        name = /^[A-Za-z_]\w*/.exec(source.slice(i + 1))?.[0];
        if (name === undefined) throw new Skip("it has a `:` without a parameter name");
        i += 1 + name.length;
      }
      let inner = SEGMENT;
      if (source.charAt(i) === "(") {
        const end = groupEnd(source, i);
        inner = source.slice(i + 1, end);
        i = end + 1;
      }
      const modifier = "?*+".includes(source.charAt(i)) ? source.charAt(i++) : "";
      if (modifier !== "" && !regex.endsWith("/")) {
        throw new Skip(`its \`${modifier}\` parameter has no \`/\` before it`);
      }
      // At the root the `/` stays: every path starts with one.
      const prefix = modifier !== "" && regex !== "/" ? "/" : "";
      if (prefix !== "") regex = regex.slice(0, -1);
      const repeated = `(?:${inner})(?:/(?:${inner}))*`;
      regex +=
        modifier === "?" || modifier === "*"
          ? `(?:${prefix}(${modifier === "*" ? repeated : inner}))?`
          : `${prefix}(${modifier === "+" ? repeated : inner})`;
      groups.push(name);
    } else if ("{}*+?".includes(ch)) {
      throw new Skip(`its \`${ch}\` is a path-to-regexp form OpsCrew does not translate yet`);
    } else {
      regex += escapeRegex(ch);
      i++;
    }
  }
  return { regex: `^${regex}$`, groups };
}

/** A regular-expression source (`^/articles/(\d{4})/(.+)$`) as it is, with its groups' names. */
function regexPattern(source: string): Pattern {
  const groups: (string | undefined)[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "\\") i++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "(") {
      const named = /^\?P?<([A-Za-z_]\w*)>/.exec(source.slice(i + 1));
      if (named) groups.push(named[1]);
      else if (source.charAt(i + 1) !== "?") groups.push(undefined);
    }
  }
  return { regex: source, groups };
}

/** The rule's source for `proxy`, checked with plan-schema's `VercelSourceSchema`. */
function sourcePattern(source: string, proxy: EdgeProxy): Pattern {
  if (!VercelSourceSchema.safeParse(source).success) {
    throw new Skip(
      "its `source` must start with `/` (a path pattern) or `^` (a regular expression)",
    );
  }
  if (/["\p{Cc}\uFEFF]/u.test(source)) {
    throw new Skip("its `source` has a quote or a control character");
  }
  if (proxy === "caddy" && READS_SERVER.test(source)) {
    throw new Skip(
      "its `source` has a `{$…}`, `{env.…}` or `{file.…}` placeholder, which would read the server's environment or files",
    );
  }
  const pattern = source.startsWith("^") ? regexPattern(source) : pathPattern(source);
  if (proxy === "caddy" && NOT_RE2.test(pattern.regex)) {
    throw new Skip(
      "its pattern uses a lookahead, a lookbehind or a backreference, which Caddy's regular expressions do not have",
    );
  }
  try {
    new RegExp(pattern.regex);
  } catch {
    throw new Skip("its pattern is not a valid regular expression");
  }
  if (proxy === "nginx" && pattern.groups.length > 9) {
    throw new Skip("its pattern has more than 9 groups, and nginx numbers only $1 to $9");
  }
  return pattern;
}

/** Destination text the proxy reads as it is. */
function literal(text: string, proxy: EdgeProxy): string {
  const found = unsafeChar(text, proxy, false);
  if (found !== undefined) {
    throw new Skip(`its destination has \`${found}\`, which OpsCrew cannot write safely here`);
  }
  return text;
}

/**
 * The destination with its parameters (`:name`, `$1`, `$name`) as the proxy's captures (`ref`).
 * As Vercel's routing (`replaceSegments`): a rewrite whose destination uses no parameter gets the
 * named ones in its query string; a redirect never does.
 */
function destination(
  dest: string,
  pattern: Pattern,
  ref: (n: number) => string,
  proxy: EdgeProxy,
  rewrite: boolean,
): string {
  if (!dest.startsWith("/") && !isExternal(dest)) {
    throw new Skip("its destination must start with `/` or be a full URL");
  }
  let used = false;
  let out = "";
  let last = 0;
  for (const match of dest.matchAll(/:([A-Za-z_]\w*)[*+?]?|\$(\d+|[A-Za-z_]\w*)/g)) {
    const [whole, colon, dollar = ""] = match;
    let index: number;
    if (colon !== undefined) {
      index = pattern.groups.indexOf(colon);
      // `:name` that is no parameter of the source stays as it is.
      if (index < 0) continue;
    } else {
      index = /^\d+$/.test(dollar) ? Number(dollar) - 1 : pattern.groups.indexOf(dollar);
      if (index < 0 || index >= pattern.groups.length) {
        throw new Skip(`its destination uses \`$${dollar}\`, which its source does not capture`);
      }
    }
    out += literal(dest.slice(last, match.index), proxy) + ref(index + 1);
    used = true;
    last = match.index + whole.length;
  }
  out += literal(dest.slice(last), proxy);
  const query = pattern.groups.flatMap((name, i) =>
    name === undefined ? [] : [`${name}=${ref(i + 1)}`],
  );
  if (!rewrite || used || query.length === 0) return out;
  return `${out}${out.includes("?") ? "&" : "?"}${query.join("&")}`;
}

const isExternal = (dest: string) => /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//.test(dest);

/** The rules `cleanUrls` and `trailingSlash` stand for, in Vercel's regular-expression form. */
function platformRules(routing: PlatformRouting) {
  const slash = routing.trailingSlash;
  // A last segment without a dot: a page, not a file.
  const page = "^/((?:[^/]+/)*[^/.]+)$";
  const redirects: { rule: string; source: string; destination: string; statusCode: number }[] = [];
  const rewrites: { rule: string; source: string; destination: string }[] = [];
  if (routing.cleanUrls) {
    // `/index.html` goes to `/`, and `/dir/index.html` to `/dir/`.
    redirects.push(
      {
        rule: "cleanUrls",
        source: "^/((?:.+/)?)index\\.html$",
        destination: "/$1",
        statusCode: 308,
      },
      {
        rule: "cleanUrls",
        source: "^/(.+)\\.html$",
        destination: slash ? "/$1/" : "/$1",
        statusCode: 308,
      },
    );
    rewrites.push({
      rule: "cleanUrls",
      source: slash ? "^/(.+)/$" : page,
      destination: "/$1.html",
    });
  }
  if (slash === false) {
    redirects.push({
      rule: "trailingSlash",
      source: "^/(.+)/$",
      destination: "/$1",
      statusCode: 308,
    });
  } else if (slash === true) {
    redirects.push({ rule: "trailingSlash", source: page, destination: "/$1/", statusCode: 308 });
  }
  return { redirects, rewrites };
}

/**
 * The leading text every path a regular expression matches starts with: none with an alternative
 * (`|`), and without a character a quantifier makes optional.
 */
function literalPrefix(regex: string): string {
  if (/(?:^|[^\\])\|/.test(regex)) return "";
  let prefix = "";
  for (let i = regex.startsWith("^") ? 1 : 0; i < regex.length; i++) {
    const ch = regex.charAt(i);
    if (ch === "\\" && /^\W$/.test(regex.charAt(i + 1))) prefix += regex.charAt(++i);
    else if ("?*{".includes(ch)) return prefix.slice(0, -1);
    else if (/[\\.+^$()[\]|]/.test(ch)) break;
    else prefix += ch;
  }
  return prefix;
}

/** True when the paths two regular expressions match can share a start. */
const mayOverlap = (a: string, b: string) => {
  const [pa, pb] = [literalPrefix(a), literalPrefix(b)];
  return pa.startsWith(pb) || pb.startsWith(pa);
};

/** A quoted string, as both proxies read one (no backslash or `"` reach here unescaped). */
const quoted = (text: string) => `"${text}"`;

/** `regex` with `guards` after its `^`, which then hold for every alternative. */
const guarded = (regex: string, guards: string) => `^${guards}(?:${regex.slice(1)})`;

interface HeaderRule {
  rule: string;
  source: string;
  pattern: Pattern;
  headers: { key: string; value: string }[];
}

/**
 * `routing` as an additions file for `ctx.proxy` that passes `scanProxyAdditions` and the proxy's
 * own checker. Sources become anchored, case-sensitive regular expressions, and destinations'
 * parameters the proxy's captures. Left out, each with its reason: rewrites to another site, the
 * rules detect already lists in `unsupported` (`has` and `missing`, `routes`, malformed ones), a
 * header OpsCrew's edge sets itself, and patterns the proxy cannot express. On nginx a request
 * gets the headers of one `location` only, so a header rule whose paths can also match an earlier
 * one's, or a rewrite's, is left out too; a rule for every path goes at server level instead.
 * Requests for `/.well-known/` are never redirected or rewritten, as on Vercel, which keeps
 * certificates working.
 */
export function translateVercelRouting(
  routing: PlatformRouting,
  ctx: VercelRoutingContext,
): VercelRoutingTranslation {
  const { proxy, upstream } = ctx;
  const skipped: VercelRoutingTranslation["skipped"] = [];
  const skip = (rule: string, reason: string) => skipped.push({ rule, reason });
  /** `make()` for the rule, or nothing with the rule listed as skipped. */
  const attempt = <T>(rule: string, make: () => T): T | undefined => {
    try {
      return make();
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skip(rule, error.message);
      return undefined;
    }
  };

  const headers: HeaderRule[] = [];
  for (const entry of routing.headers) {
    const rule = `headers[${entry.index}]`;
    const pattern = attempt(rule, () => sourcePattern(entry.source, proxy));
    if (pattern === undefined) continue;
    const kept = entry.headers.filter(({ key, value }) => {
      const found = unsafeChar(value, proxy, true);
      if (!/^[A-Za-z0-9][A-Za-z0-9!#%&'*+.^_|~-]*$/.test(key)) {
        skip(rule, `\`${key}\` is not a header name OpsCrew can write`);
      } else if (EDGE_HEADERS.has(key.toLowerCase())) {
        skip(rule, `OpsCrew's edge already sends \`${key}\` on every response`);
      } else if (found !== undefined) {
        skip(
          rule,
          `the value of \`${key}\` has \`${found}\`, which OpsCrew cannot write safely here`,
        );
      } else {
        return true;
      }
      return false;
    });
    if (kept.length > 0) headers.push({ rule, source: entry.source, pattern, headers: kept });
  }

  const platform = platformRules(routing);
  const redirects = [
    ...platform.redirects,
    ...routing.redirects.map((r) => ({ ...r, rule: `redirects[${r.index}]` })),
  ];
  const rewrites = [
    ...platform.rewrites,
    ...routing.rewrites.map((r) => ({ ...r, rule: `rewrites[${r.index}]` })),
  ];

  const render = proxy === "nginx" ? nginxRules : caddyRules;
  const text = render({ headers, redirects, rewrites, upstream, attempt, skip });
  for (const entry of routing.unsupported) {
    skip(
      entry.index === undefined ? entry.property : `${entry.property}[${entry.index}]`,
      entry.reason,
    );
  }
  return { text, skipped };
}

interface RenderInput {
  headers: HeaderRule[];
  redirects: { rule: string; source: string; destination: string; statusCode: number }[];
  rewrites: { rule: string; source: string; destination: string }[];
  upstream: string;
  attempt: <T>(rule: string, make: () => T) => T | undefined;
  skip: (rule: string, reason: string) => void;
}

const ruleNote = (rule: string, source: string, dest?: string, status?: number) =>
  `# ${rule}: ${source}${dest === undefined ? "" : ` to ${dest}`}${status === undefined ? "" : ` (${status})`}`;

const SKIP_EXTERNAL = "it rewrites to another site, and the edge sends traffic only to this app";

/** Caddy: `header`, `redir` and a `handle` per rewrite, each on a named `path_regexp` matcher. */
function caddyRules({ headers, redirects, rewrites, upstream, attempt }: RenderInput): string {
  const lines: string[] = [];
  headers.forEach((rule, n) => {
    const name = `header${n}`;
    lines.push(
      ruleNote(rule.rule, rule.source),
      `@${name} path_regexp ${name} ${quoted(rule.pattern.regex)}`,
      // Deferred (`>`), so the value replaces one the app sends.
      ...rule.headers.map(({ key, value }) => `header @${name} >${key} ${quoted(value)}`),
      "",
    );
  });
  const matcher = (name: string, pattern: Pattern) => [
    `@${name} {`,
    `\tpath_regexp ${name} ${quoted(pattern.regex)}`,
    "\tnot path /.well-known/*",
    // RE2 has no lookahead: a path with a CR or LF is left out by a matcher of its own.
    `\tnot path_regexp ${quoted("[\\r\\n]")}`,
    "}",
  ];
  const ref = (name: string) => (n: number) => `{re.${name}.${n}}`;
  let count = 0;
  for (const rule of redirects) {
    const name = `redirect${count}`;
    const made = attempt(rule.rule, () => {
      const pattern = sourcePattern(rule.source, "caddy");
      return { pattern, to: destination(rule.destination, pattern, ref(name), "caddy", false) };
    });
    if (made === undefined) continue;
    count++;
    lines.push(
      ruleNote(rule.rule, rule.source, rule.destination, rule.statusCode),
      ...matcher(name, made.pattern),
      `redir @${name} ${made.to} ${rule.statusCode}`,
      "",
    );
  }
  const proxyTo = [`reverse_proxy ${upstream} {`, "\theader_up X-Forwarded-For {client_ip}"];
  count = 0;
  for (const rule of rewrites) {
    const name = `rewrite${count}`;
    const made = attempt(rule.rule, () => {
      if (isExternal(rule.destination)) throw new Skip(SKIP_EXTERNAL);
      const pattern = sourcePattern(rule.source, "caddy");
      return { pattern, to: destination(rule.destination, pattern, ref(name), "caddy", true) };
    });
    if (made === undefined) continue;
    count++;
    lines.push(
      `${ruleNote(rule.rule, rule.source, rule.destination)}, when the app answers 404`,
      ...matcher(name, made.pattern),
      `handle @${name} {`,
      ...[
        ...proxyTo,
        `\t@${name}_404 status 404`,
        `\thandle_response @${name}_404 {`,
        `\t\trewrite * ${made.to}`,
        ...[...proxyTo, "}"].map((line) => `\t\t${line}`),
        "\t}",
        "}",
      ].map((line) => `\t${line}`),
      "}",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * nginx: headers at server level or in a regular-expression `location`, redirects as server-level
 * `if` blocks (checked in order before any `location`), and the rewrites' sources in one
 * `location` whose 404 leads to a named location with the rewrites.
 */
function nginxRules({
  headers,
  redirects,
  rewrites,
  upstream,
  attempt,
  skip,
}: RenderInput): string {
  const lines: string[] = [];
  const proxyPass = `proxy_pass http://${upstream};`;
  const ref = (n: number) => `$${n}`;
  // Vercel never redirects or rewrites `/.well-known/`.
  const notWellKnown = (regex: string) =>
    quoted(guarded(regex, `(?!/\\.well-known/)${NO_NEWLINE}`));

  const rewritten = rewrites.flatMap((rule) => {
    const made = attempt(rule.rule, () => {
      if (isExternal(rule.destination)) throw new Skip(SKIP_EXTERNAL);
      const pattern = sourcePattern(rule.source, "nginx");
      return { pattern, to: destination(rule.destination, pattern, ref, "nginx", true) };
    });
    return made === undefined ? [] : [{ ...rule, ...made }];
  });

  // nginx keeps a level's `proxy_hide_header` lines only where a block sets none of its own.
  const everyPath = headers.filter((rule) => EVERY_PATH.test(rule.source));
  const hidden = everyPath.flatMap((rule) => rule.headers.map(({ key }) => key));
  const header = (key: string, value: string) => `add_header ${key} ${quoted(value)} always;`;
  for (const rule of everyPath) {
    lines.push(
      `${ruleNote(rule.rule, rule.source)}, on every path`,
      ...rule.headers.flatMap(({ key, value }) => [
        `proxy_hide_header ${key};`,
        header(key, value),
      ]),
      "",
    );
  }
  const located: HeaderRule[] = [];
  for (const rule of headers.filter((r) => !EVERY_PATH.test(r.source))) {
    const earlier = located.find((l) => mayOverlap(l.pattern.regex, rule.pattern.regex));
    if (earlier !== undefined) {
      skip(
        rule.rule,
        `nginx sends the headers of one \`location\` per request, and this rule's paths can also match ${earlier.rule}'s; merge the two rules by hand`,
      );
      continue;
    }
    const rewrite = rewritten.find((r) => mayOverlap(r.pattern.regex, rule.pattern.regex));
    if (rewrite !== undefined) {
      skip(
        rule.rule,
        `this rule's paths can also match ${rewrite.rule}'s, and nginx would drop its headers on rewritten responses`,
      );
      continue;
    }
    located.push(rule);
    const keys = [...new Set([...hidden, ...rule.headers.map(({ key }) => key)])];
    // certbot's challenges have a location of their own, which a regular expression would win over.
    const regex = guarded(rule.pattern.regex, `(?!/\\.well-known/acme-challenge/)${NO_NEWLINE}`);
    lines.push(
      ruleNote(rule.rule, rule.source),
      `location ~ ${quoted(regex)} {`,
      ...keys.map((key) => `\tproxy_hide_header ${key};`),
      ...rule.headers.map(({ key, value }) => `\t${header(key, value)}`),
      `\t${proxyPass}`,
      "}",
      "",
    );
  }
  for (const rule of redirects) {
    const made = attempt(rule.rule, () => {
      const pattern = sourcePattern(rule.source, "nginx");
      const to = destination(rule.destination, pattern, ref, "nginx", false);
      // nginx would add its own port (8443) to a relative Location.
      return {
        pattern,
        to: to.startsWith("/") && !to.startsWith("//") ? `$scheme://$host${to}` : to,
      };
    });
    if (made === undefined) continue;
    lines.push(
      ruleNote(rule.rule, rule.source, rule.destination, rule.statusCode),
      `if ($uri ~ ${notWellKnown(made.pattern.regex)}) {`,
      `\treturn ${rule.statusCode} ${quoted(made.to)};`,
      "}",
      "",
    );
  }
  if (rewritten.length > 0) {
    const sources = rewritten.map((r) => `(?:${r.pattern.regex.slice(1)})`).join("|");
    lines.push(
      "# The rewrites apply when the app answers 404 for one of their paths, as Vercel serves the",
      "# app's files first.",
      `location ~ ${notWellKnown(`^${sources}`)} {`,
      "\tproxy_intercept_errors on;",
      "\terror_page 404 = @vercel_rewrites;",
      `\t${proxyPass}`,
      "}",
      "location @vercel_rewrites {",
      ...rewritten.flatMap((rule) => [
        `\t${ruleNote(rule.rule, rule.source, rule.destination)}`,
        `\trewrite ${notWellKnown(rule.pattern.regex)} ${quoted(rule.to)} break;`,
      ]),
      `\t${proxyPass}`,
      "}",
      "",
    );
  }
  return lines.join("\n");
}
