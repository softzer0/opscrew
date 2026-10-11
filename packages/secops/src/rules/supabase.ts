/**
 * Supabase exposure rules (`opscrew-supabase`): service-role keys shipped to browsers,
 * client-exposed `SERVICE_ROLE` env names, and migration problems (tables without row-level
 * security, `using (true)` write policies, public reads of sensitive tables, write grants to
 * `anon`, public storage buckets). Deterministic and offline; raw secret values never leave
 * this module (evidence is masked with `maskSecret`).
 */
import type { Finding, ScanContext, Scanner, Severity } from "@opscrew/contracts";
import { maskSecret, Redactor } from "@opscrew/core";
import { CLIENT_EXPOSED_PREFIXES } from "@opscrew/detect";
import { findingId } from "../scan/finding";
import { basename } from "../scan/text";

const SOURCE = "opscrew-supabase";

const REFS = {
  apiKeys: "https://supabase.com/docs/guides/api/api-keys",
  rls: "https://supabase.com/docs/guides/database/postgres/row-level-security",
  cve: "https://nvd.nist.gov/vuln/detail/CVE-2025-48757",
  buckets: "https://supabase.com/docs/guides/storage/buckets/fundamentals",
  envVite: "https://vite.dev/guide/env-and-mode",
} as const;

/** Creates the built-in Supabase scanner. */
export function createSupabaseScanner(): Scanner {
  return {
    id: SOURCE,
    kind: "builtin",
    isAvailable: async () => true,
    scan: scanSupabase,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const redactor = new Redactor();

interface FindingInput {
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  /** Raw matched text; hashed into the id, never stored. */
  raw: string;
  evidence: string;
  description: string;
  remediation: string;
  references: string[];
}

function makeFinding(input: FindingInput): Finding {
  const { raw, ...rest } = input;
  return {
    id: findingId(input.ruleId, input.file, input.line, raw),
    ...rest,
    category: "supabase",
    source: SOURCE,
  };
}

/** Returns a function mapping a character offset in `text` to its 1-based line number. */
function lineLocator(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function extension(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at + 1).toLowerCase();
}

async function readSafe(context: ScanContext, file: string): Promise<string | undefined> {
  try {
    return await context.readFile(file);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Project shape: frontend packages and Supabase usage
// ---------------------------------------------------------------------------------------------

const FRONTEND_DEPENDENCIES = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@sveltejs/kit",
  "next",
  "nuxt",
  "vite",
  "@angular/core",
  "solid-js",
  "preact",
  "astro",
  "@remix-run/react",
  "react-native",
  "expo",
  "gatsby",
];

interface ProjectShape {
  /** Directories ("" = root) containing a package.json, mapped to "is a frontend app". */
  packages: Map<string, boolean>;
  usesSupabase: boolean;
}

async function readProjectShape(context: ScanContext): Promise<ProjectShape> {
  const packages = new Map<string, boolean>();
  let usesSupabase = context.files.some((file) => file.startsWith("supabase/"));
  for (const file of context.files) {
    const name = basename(file);
    if (name === "package.json") {
      const text = await readSafe(context, file);
      let deps: Record<string, unknown> = {};
      try {
        const json = JSON.parse(text ?? "{}") as Record<string, unknown>;
        for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
          const value = json[key];
          if (value && typeof value === "object") deps = { ...deps, ...value };
        }
      } catch {
        // Unparseable manifest: treat as a non-frontend package.
      }
      const names = Object.keys(deps);
      packages.set(
        dirname(file),
        names.some((dep) => FRONTEND_DEPENDENCIES.includes(dep)),
      );
      if (names.some((dep) => dep.startsWith("@supabase/") || dep === "supabase")) {
        usesSupabase = true;
      }
    } else if (
      !usesSupabase &&
      (/^requirements[^/]*\.txt$/.test(name) || name === "pyproject.toml")
    ) {
      const text = await readSafe(context, file);
      if (text && /^\s*supabase\b/im.test(text)) usesSupabase = true;
    }
  }
  return { packages, usesSupabase };
}

/** Nearest ancestor directory with a package.json, or undefined. */
function packageRootOf(file: string, packages: Map<string, boolean>): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (packages.has(dir)) return dir;
    if (dir === "") return undefined;
    dir = dirname(dir);
  }
}

// ---------------------------------------------------------------------------------------------
// Client-side classification
// ---------------------------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);
const MARKUP_EXTENSIONS = new Set(["html", "htm", "vue", "svelte", "astro"]);
const DATA_EXTENSIONS = new Set(["json", "yaml", "yml", "toml"]);
const FRONTEND_DIRS = new Set(["src", "app", "pages", "components", "public", "lib"]);
const STATIC_DIRS = new Set(["public", "static", "assets", "www"]);
const SERVER_SEGMENTS = new Set([
  "server",
  "servers",
  "backend",
  "api",
  "functions",
  "edge-functions",
  "netlify",
  "supabase",
  "scripts",
  "migrations",
  "seed",
  "seeds",
  "db",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "cypress",
  "playwright",
]);
const SERVER_FILE_NAME = /(^server\.|\.server\.|\.config\.|^middleware\.|\.(test|spec)\.)/i;

function isEnvFile(file: string): boolean {
  const name = basename(file);
  return name === ".env" || name.startsWith(".env.");
}

/**
 * True when `file` ends up in (or is) browser code: any file under `src/`, `app/`, `pages/`,
 * `components/`, `public/` or `lib/` of a frontend package, otherwise any markup/JS file that is
 * not in a server-side location.
 */
function isClientFile(file: string, shape: ProjectShape): boolean {
  const ext = extension(file);
  const root = packageRootOf(file, shape.packages);
  const relative = root ? file.slice(root.length + 1) : file;
  const segments = relative.split("/");
  const top = segments.length > 1 ? segments[0] : undefined;
  const frontendPackage = root !== undefined && shape.packages.get(root) === true;
  if (
    frontendPackage &&
    top !== undefined &&
    FRONTEND_DIRS.has(top) &&
    (CODE_EXTENSIONS.has(ext) || MARKUP_EXTENSIONS.has(ext) || DATA_EXTENSIONS.has(ext))
  ) {
    return true;
  }
  const dirs = file.split("/").slice(0, -1);
  if (dirs.some((dir) => SERVER_SEGMENTS.has(dir.toLowerCase()))) return false;
  if (SERVER_FILE_NAME.test(basename(file))) return false;
  if (MARKUP_EXTENSIONS.has(ext)) return true;
  if (!CODE_EXTENSIONS.has(ext)) return false;
  if (dirs.some((dir) => STATIC_DIRS.has(dir.toLowerCase()))) return true;
  // JS/TS outside any package (plain static site) or inside a frontend package is client code;
  // inside a non-frontend package (a Node backend) it is server code.
  return root === undefined ? true : frontendPackage;
}

// ---------------------------------------------------------------------------------------------
// Keys and env names
// ---------------------------------------------------------------------------------------------

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
const SECRET_KEY = /\bsb_secret_[A-Za-z0-9_-]{16,}/g;
const PLACEHOLDER = /your[-_]|xxx|changeme|example|placeholder|<|>|\$\{|process\.env/i;
const CLIENT_SECRET_ENV = new RegExp(
  `\\b(?:${CLIENT_EXPOSED_PREFIXES.join("|")})[A-Z0-9_]*(?:SERVICE_ROLE|SUPABASE_SECRET)[A-Z0-9_]*\\b`,
  "g",
);
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/;

/** Decodes a JWT payload and returns its `role` claim, or undefined. */
function jwtRole(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (claims && typeof claims === "object" && "role" in claims) {
      const role = (claims as { role: unknown }).role;
      return typeof role === "string" ? role : undefined;
    }
  } catch {
    // Not a JWT payload.
  }
  return undefined;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /^(.)\1*$/.test(value.replace(/^sb_secret_/, ""));
}

interface KeyMatch {
  value: string;
  index: number;
}

/** Service-role JWTs and `sb_secret_` keys in `text` (anon/publishable keys are never returned). */
function findSecretKeys(text: string): KeyMatch[] {
  const out: KeyMatch[] = [];
  for (const match of text.matchAll(JWT)) {
    if (jwtRole(match[0]) === "service_role") out.push({ value: match[0], index: match.index });
  }
  for (const match of text.matchAll(SECRET_KEY)) {
    if (!isPlaceholder(match[0])) out.push({ value: match[0], index: match.index });
  }
  return out;
}

function serviceRoleFinding(file: string, line: number, value: string, viaEnv?: string): Finding {
  const where = viaEnv
    ? `It is assigned to \`${viaEnv}\`, a variable the bundler copies into browser code.`
    : "This file is part of the code that is sent to every visitor's browser.";
  return makeFinding({
    ruleId: "supabase/service-role-in-client",
    title: "Supabase service-role key in client code",
    severity: "critical",
    file,
    line,
    raw: value,
    evidence: maskSecret(value),
    description:
      `A Supabase service-role (secret) key was found in frontend code. ${where} ` +
      "The service-role key bypasses row-level security, so anyone who opens the site can read, " +
      "change or delete every row in the database.",
    remediation:
      "Rotate the key now in the Supabase dashboard (Project Settings > API), remove it from the " +
      "frontend and use the anon/publishable key in the browser. Keep the secret key only in " +
      "server-side code such as Supabase Edge Functions or a backend, read from an environment " +
      "variable without a client prefix.",
    references: [REFS.apiKeys, REFS.cve],
  });
}

function exposedEnvFinding(file: string, line: number, name: string): Finding {
  return makeFinding({
    ruleId: "supabase/service-role-env-exposed",
    title: "Supabase secret key in a client-exposed environment variable",
    severity: "critical",
    file,
    line,
    raw: name,
    evidence: name,
    description:
      `\`${name}\` has a prefix that makes the bundler inline its value into browser code, and ` +
      "its name says it holds the Supabase service-role (secret) key. Anyone visiting the site " +
      "could extract the key and bypass row-level security.",
    remediation:
      "Rename the variable without the client prefix (for example `SUPABASE_SERVICE_ROLE_KEY`), " +
      "use it only in server-side code, and rotate the key in the Supabase dashboard if it was " +
      "ever deployed.",
    references: [REFS.apiKeys, REFS.envVite],
  });
}

/** Env files and code, markup or data files that a bundler might ship. */
function isScannable(file: string): boolean {
  const ext = extension(file);
  return (
    isEnvFile(file) ||
    CODE_EXTENSIONS.has(ext) ||
    MARKUP_EXTENSIONS.has(ext) ||
    DATA_EXTENSIONS.has(ext)
  );
}

function scanKeysAndEnv(file: string, text: string, shape: ProjectShape): Finding[] {
  const findings: Finding[] = [];
  const keyLines = new Set<number>();
  const lineAt = lineLocator(text);
  if (isEnvFile(file)) {
    // Only client-prefixed variables are browser-visible; server-side `.env` values are the
    // secrets scanner's concern (committed `.env`).
    for (const key of findSecretKeys(text)) {
      const lineStart = text.lastIndexOf("\n", key.index) + 1;
      const name = ENV_ASSIGNMENT.exec(text.slice(lineStart, key.index))?.[1];
      if (!name || !CLIENT_EXPOSED_PREFIXES.some((p) => name.toUpperCase().startsWith(p))) continue;
      const line = lineAt(key.index);
      keyLines.add(line);
      findings.push(serviceRoleFinding(file, line, key.value, name));
    }
  } else if (isClientFile(file, shape)) {
    for (const key of findSecretKeys(text)) {
      const line = lineAt(key.index);
      keyLines.add(line);
      findings.push(serviceRoleFinding(file, line, key.value));
    }
  }

  const seen = new Set<string>();
  for (const match of text.matchAll(CLIENT_SECRET_ENV)) {
    const name = match[0];
    if (seen.has(name)) continue;
    seen.add(name);
    const line = lineAt(match.index);
    if (!keyLines.has(line)) findings.push(exposedEnvFinding(file, line, name));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// SQL: tolerant tokenising
// ---------------------------------------------------------------------------------------------

interface Statement {
  /** Statement text with comments blanked (same length as the source slice). */
  text: string;
  /** Offset of the first non-space character in the blanked file text. */
  start: number;
  line: number;
}

/**
 * Blanks `--` and (nested) block comments with spaces, keeping newlines and string, quoted
 * identifier and dollar-quoted contents intact, and splits top-level statements on `;`.
 */
function splitSql(source: string): { text: string; statements: Statement[] } {
  const out = source.split("");
  const bounds: Array<[number, number]> = [];
  let stmtStart = 0;
  let i = 0;
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (source[k] === "/" && source[k + 1] === "*") {
          depth++;
          k += 2;
        } else if (source[k] === "*" && source[k + 1] === "/") {
          depth--;
          k += 2;
        } else k++;
      }
      blank(i, k);
      i = k;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n) {
        if (source[k] === c) {
          if (source[k + 1] === c) k += 2;
          else break;
        } else k++;
      }
      i = k + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(source.slice(i, i + 64))?.[0];
      if (tag) {
        const end = source.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
      } else i++;
    } else if (c === ";") {
      bounds.push([stmtStart, i]);
      stmtStart = i + 1;
      i++;
    } else i++;
  }
  bounds.push([stmtStart, n]);
  const text = out.join("");
  const lineAt = lineLocator(text);
  const statements: Statement[] = [];
  for (const [from, to] of bounds) {
    const slice = text.slice(from, to);
    const lead = slice.search(/\S/);
    if (lead < 0) continue;
    statements.push({
      text: slice.slice(lead),
      start: from + lead,
      line: lineAt(from + lead),
    });
  }
  return { text, statements };
}

const IDENT = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

function normIdent(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}

/** `schema.table` key; unqualified names resolve to `public` (the default search path). */
function tableKey(first: string, second: string | undefined): { schema: string; key: string } {
  const schema = second === undefined ? "public" : normIdent(first);
  const name = normIdent(second ?? first);
  return { schema, key: `${schema}.${name}` };
}

/** Content between the parenthesis at `open` and its match (quote-aware), or undefined. */
function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, k + 1);
      if (end < 0) return undefined;
      k = end;
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, k);
    }
  }
  return undefined;
}

/** Splits on commas that are not inside parentheses or quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, k + 1);
      k = end < 0 ? text.length : end;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function compact(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return redactor.redact(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

function isTrueExpression(expr: string | undefined): boolean {
  if (expr === undefined) return false;
  let value = expr.replace(/\s+/g, "").toLowerCase();
  while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1);
  return value === "true" || value === "1=1" || value === "true::boolean";
}

// ---------------------------------------------------------------------------------------------
// SQL: migration rules
// ---------------------------------------------------------------------------------------------

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${QNAME}`,
  "i",
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}`,
  "i",
);
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]*?)(?:\s+(?:cascade|restrict))?\s*$/i;
const RLS_TOGGLE = /\b(enable|disable)\s+row\s+level\s+security\b/i;
const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+(${IDENT})\s+on\s+${QNAME}([\s\S]*)$`,
  "i",
);
const CONSTRAINT_WORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "check",
  "foreign",
  "exclude",
  "like",
]);
const SENSITIVE_COLUMN = /email|phone|address|password|passwd|token|secret/i;
const HARMLESS_ROLES = new Set(["service_role", "postgres", "supabase_admin"]);
const WRITE_PRIVILEGES = new Set(["insert", "update", "delete", "truncate", "all"]);
const NON_TABLE_OBJECT =
  /^(?:schema|function|functions|procedure|procedures|routine|routines|sequence|sequences|type|domain|database|language|large\s+object|foreign|tablespace|all\s+(?:functions|sequences|routines|procedures))\b/i;

interface ParsedFile {
  file: string;
  text: string;
  statements: Statement[];
}

function isMigrationFile(file: string): boolean {
  if (extension(file) !== "sql") return false;
  return file.startsWith("supabase/migrations/") || /(^|\/)migrations\//i.test(file);
}

/**
 * Public tables created in the migrations without `enable row level security` (statements are
 * replayed in file order, so a later `drop table` or `disable row level security` counts).
 */
function rlsFindings(files: ParsedFile[]): Finding[] {
  const created = new Map<string, { file: string; line: number; header: string }>();
  const enabled = new Set<string>();
  for (const parsed of files) {
    for (const stmt of parsed.statements) {
      const create = CREATE_TABLE.exec(stmt.text);
      if (create?.[2] !== undefined) {
        const { schema, key } = tableKey(create[2], create[3]);
        if (schema !== "public" || /^temp/i.test(create[1] ?? "") || created.has(key)) continue;
        const paren = stmt.text.indexOf("(");
        const header = compact(paren < 0 ? stmt.text : stmt.text.slice(0, paren));
        created.set(key, { file: parsed.file, line: stmt.line, header });
        continue;
      }
      const alter = ALTER_TABLE.exec(stmt.text);
      const toggle = alter && RLS_TOGGLE.exec(stmt.text.slice(alter[0].length));
      if (alter?.[1] !== undefined && toggle) {
        const { key } = tableKey(alter[1], alter[2]);
        if (toggle[1]?.toLowerCase() === "enable") enabled.add(key);
        else enabled.delete(key);
        continue;
      }
      const drop = DROP_TABLE.exec(stmt.text);
      for (const part of splitTopLevel(drop?.[1] ?? "")) {
        const name = new RegExp(`^${QNAME}$`).exec(part);
        if (name?.[1] === undefined) continue;
        const { key } = tableKey(name[1], name[2]);
        created.delete(key);
        enabled.delete(key);
      }
    }
  }
  const findings: Finding[] = [];
  for (const [key, table] of created) {
    if (enabled.has(key)) continue;
    const name = key.slice("public.".length);
    findings.push(
      makeFinding({
        ruleId: "supabase/rls-disabled",
        title: `Row-level security is not enabled on table "${name}"`,
        severity: "high",
        file: table.file,
        line: table.line,
        raw: key,
        evidence: table.header,
        description:
          `The table \`${key}\` is in the \`public\` schema, which Supabase exposes through its ` +
          "REST API, but row-level security is never enabled for it in the migrations. Anyone " +
          "with the public anon key (which ships in the frontend) can read and change every row " +
          "(the CVE-2025-48757 class of Supabase data leaks).",
        remediation:
          `Add a migration with \`alter table ${key} enable row level security;\` and create ` +
          "policies that only allow each user to reach their own rows (for example " +
          "`using (auth.uid() = user_id)`).",
        references: [REFS.rls, REFS.cve],
      }),
    );
  }
  return findings;
}

/** Column names per table key from `create table` and `alter table … add column`. */
function collectColumns(files: ParsedFile[]): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  const add = (key: string, column: string) => {
    const set = columns.get(key) ?? new Set<string>();
    columns.set(key, set);
    set.add(column);
  };
  for (const parsed of files) {
    for (const stmt of parsed.statements) {
      const create = CREATE_TABLE.exec(stmt.text);
      if (create?.[2] !== undefined) {
        const { key } = tableKey(create[2], create[3]);
        const open = stmt.text.indexOf("(", create[0].length);
        const body = open < 0 ? undefined : balanced(stmt.text, open);
        for (const element of splitTopLevel(body ?? "")) {
          const name = new RegExp(`^${IDENT}`).exec(element)?.[0];
          if (name && !CONSTRAINT_WORDS.has(name.toLowerCase())) add(key, normIdent(name));
        }
        continue;
      }
      const alter = ALTER_TABLE.exec(stmt.text);
      if (alter?.[1] !== undefined) {
        const { key } = tableKey(alter[1], alter[2]);
        const rest = stmt.text.slice(alter[0].length);
        const addColumn = new RegExp(
          String.raw`\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})`,
          "gi",
        );
        for (const match of rest.matchAll(addColumn)) {
          const name = match[1];
          if (name && !CONSTRAINT_WORDS.has(name.toLowerCase())) add(key, normIdent(name));
        }
      }
    }
  }
  return columns;
}

function policyFindings(files: ParsedFile[], columns: Map<string, Set<string>>): Finding[] {
  const findings: Finding[] = [];
  for (const parsed of files) {
    for (const stmt of parsed.statements) {
      const policy = CREATE_POLICY.exec(stmt.text);
      if (!policy?.[1] || policy[2] === undefined) continue;
      const { key } = tableKey(policy[2], policy[3]);
      const rest = policy[4] ?? "";
      const usingAt = rest.search(/\busing\s*\(/i);
      const checkAt = rest.search(/\bwith\s+check\s*\(/i);
      const headEnd = Math.min(...[usingAt, checkAt, rest.length].filter((at) => at >= 0));
      const head = rest.slice(0, headEnd);
      if (/^\s*as\s+restrictive\b/i.test(head)) continue;
      const command =
        /\bfor\s+(all|select|insert|update|delete)\b/i.exec(head)?.[1]?.toLowerCase() ?? "all";
      const roles = (/\bto\s+([\s\S]*)$/i.exec(head)?.[1] ?? "")
        .split(",")
        .map((role) => normIdent(role.trim()))
        .filter((role) => role.length > 0);
      if (roles.length > 0 && roles.every((role) => HARMLESS_ROLES.has(role))) continue;
      const using = usingAt < 0 ? undefined : balanced(rest, rest.indexOf("(", usingAt));
      const check = checkAt < 0 ? undefined : balanced(rest, rest.indexOf("(", checkAt));
      const usingTrue = isTrueExpression(using);
      const checkTrue = isTrueExpression(check);
      const name = normIdent(policy[1]);
      const evidence = compact(stmt.text);
      if (command !== "select" && (usingTrue || checkTrue)) {
        findings.push(
          makeFinding({
            ruleId: "supabase/permissive-write-policy",
            title: `Policy "${name}" lets anyone ${command === "all" ? "write to" : command} "${key}"`,
            severity: "high",
            file: parsed.file,
            line: stmt.line,
            raw: `${key}|${name}|${command}`,
            evidence,
            description:
              `The row-level security policy "${name}" on \`${key}\` allows ${command.toUpperCase()} ` +
              `with \`${usingTrue ? "using" : "with check"} (true)\`, so every caller of the ` +
              "Supabase API (anyone with the public anon key, or any signed-in user) can change " +
              "or delete any row, including other users' data.",
            remediation:
              "Replace `true` with a condition that ties rows to the caller, for example " +
              "`using (auth.uid() = user_id) with check (auth.uid() = user_id)`, and limit the " +
              "policy to the `authenticated` role.",
            references: [REFS.rls, REFS.cve],
          }),
        );
      } else if (command === "select" && usingTrue) {
        const sensitive = [...(columns.get(key) ?? [])].filter((c) => SENSITIVE_COLUMN.test(c));
        if (sensitive.length === 0) continue;
        findings.push(
          makeFinding({
            ruleId: "supabase/public-read-sensitive",
            title: `Policy "${name}" makes sensitive columns of "${key}" readable by everyone`,
            severity: "medium",
            file: parsed.file,
            line: stmt.line,
            raw: `${key}|${name}|select`,
            evidence,
            description:
              `The policy "${name}" allows SELECT on \`${key}\` with \`using (true)\`, and the ` +
              `table has sensitive columns (${sensitive.sort().join(", ")}). Anyone with the ` +
              "public anon key can download them.",
            remediation:
              "Restrict the policy to the row owner (`using (auth.uid() = id)`), or move public " +
              "fields into a separate table or view that leaves out the sensitive columns.",
            references: [REFS.rls],
          }),
        );
      }
    }
  }
  return findings;
}

function grantFindings(files: ParsedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const parsed of files) {
    for (const stmt of parsed.statements) {
      let text = stmt.text;
      if (/^alter\s+default\s+privileges\b/i.test(text)) {
        const at = text.search(/\bgrant\b/i);
        if (at < 0) continue;
        text = text.slice(at);
      }
      const grant =
        /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i.exec(
          text,
        );
      if (!grant?.[1] || !grant[2] || !grant[3]) continue;
      if (!/^table\b/i.test(grant[2]) && NON_TABLE_OBJECT.test(grant[2])) continue;
      const privileges = splitTopLevel(grant[1]).map(
        (privilege) => /^[a-z]+/i.exec(privilege)?.[0]?.toLowerCase() ?? "",
      );
      const writes = privileges.filter((privilege) => WRITE_PRIVILEGES.has(privilege));
      const roles = grant[3]
        .split(",")
        .map((role) => normIdent(role.trim().replace(/^group\s+/i, "")));
      const role = roles.find((r) => r === "anon" || r === "public");
      if (writes.length === 0 || !role) continue;
      const target = compact(grant[2], 80);
      findings.push(
        makeFinding({
          ruleId: "supabase/anon-write-grant",
          title: `Write access granted to the ${role === "anon" ? "anon" : "PUBLIC"} role`,
          severity: "high",
          file: parsed.file,
          line: stmt.line,
          raw: compact(stmt.text, 400),
          evidence: compact(stmt.text),
          description:
            `This migration grants ${writes.map((w) => w.toUpperCase()).join(", ")} on ${target} ` +
            `to \`${role}\`, the role used by every unauthenticated request to the Supabase API. ` +
            "Unless every affected table has strict row-level security, anyone can change data.",
          remediation:
            "Remove write grants from `anon` (and `PUBLIC`); grant writes to `authenticated` only " +
            "where needed, and make sure row-level security with owner-based policies is enabled.",
          references: [REFS.rls],
        }),
      );
    }
  }
  return findings;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^'.*'$/s.test(trimmed) ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
}

function bucketFinding(
  file: string,
  line: number,
  bucket: string | undefined,
  stmt: string,
): Finding {
  const label = bucket ? `"${bucket}"` : "a storage bucket";
  return makeFinding({
    ruleId: "supabase/public-bucket",
    title: `Public storage bucket ${label}`,
    severity: "medium",
    file,
    line,
    raw: `${bucket ?? ""}|${compact(stmt, 400)}`,
    evidence: compact(stmt),
    description:
      `The migration makes ${label} public: every file in it can be downloaded by anyone who ` +
      "knows or guesses its URL, without any access check.",
    remediation:
      "Keep the bucket private unless it only holds files meant for everyone (such as public " +
      "images). Serve private files through signed URLs and storage policies on " +
      "`storage.objects`.",
    references: [REFS.buckets],
  });
}

function bucketFindings(files: ParsedFile[]): Finding[] {
  const findings: Finding[] = [];
  const truthy = (value: string | undefined) =>
    value !== undefined && /^(?:true|'true'|'t'|'on'|'yes')$/i.test(value.trim());
  for (const parsed of files) {
    for (const stmt of parsed.statements) {
      const insert =
        /^insert\s+into\s+storage\s*\.\s*"?buckets"?\s*\(([^)]*)\)\s*values\s*([\s\S]*)$/i.exec(
          stmt.text,
        );
      if (insert?.[1] !== undefined && insert[2] !== undefined) {
        const cols = splitTopLevel(insert[1]).map((col) => normIdent(col));
        const publicAt = cols.indexOf("public");
        const nameAt = cols.indexOf("id") >= 0 ? cols.indexOf("id") : cols.indexOf("name");
        if (publicAt < 0) continue;
        const valuesText = insert[2].replace(/\bon\s+conflict\b[\s\S]*$/i, "");
        for (let at = valuesText.indexOf("("); at >= 0; ) {
          const tuple = balanced(valuesText, at);
          if (tuple === undefined) break;
          const values = splitTopLevel(tuple);
          if (truthy(values[publicAt])) {
            const bucket = nameAt >= 0 && values[nameAt] ? unquote(values[nameAt]) : undefined;
            findings.push(bucketFinding(parsed.file, stmt.line, bucket, stmt.text));
          }
          at = valuesText.indexOf("(", at + tuple.length + 2);
        }
        continue;
      }
      const update = /^update\s+storage\s*\.\s*"?buckets"?\s+set\s+([\s\S]*)$/i.exec(stmt.text);
      if (update?.[1] && /\bpublic\s*=\s*(?:true|'true'|'t')\b/i.test(update[1])) {
        const bucket = /\bwhere\s+(?:id|name)\s*=\s*'([^']*)'/i.exec(update[1])?.[1];
        findings.push(bucketFinding(parsed.file, stmt.line, bucket, stmt.text));
        continue;
      }
      if (
        /\bcreate[\s_]+bucket\b/i.test(stmt.text) &&
        /["']?\bpublic\b["']?\s*(?:=>|:=|=|:)\s*'?true\b/i.test(stmt.text)
      ) {
        const bucket = /\bcreate[\s_]+bucket\b\s*\(?\s*'([^']*)'/i.exec(stmt.text)?.[1];
        findings.push(bucketFinding(parsed.file, stmt.line, bucket, stmt.text));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------

async function scanSupabase(context: ScanContext): Promise<Finding[]> {
  const shape = await readProjectShape(context);
  const findings: Finding[] = [];
  const migrations: ParsedFile[] = [];
  const migrationFiles = context.files.filter(isMigrationFile).sort();
  for (const file of context.files) {
    if (!isScannable(file)) continue;
    const text = await readSafe(context, file);
    if (text !== undefined) findings.push(...scanKeysAndEnv(file, text, shape));
  }
  for (const file of migrationFiles) {
    const text = await readSafe(context, file);
    if (text === undefined) continue;
    migrations.push({ file, ...splitSql(text) });
  }
  // Generic `migrations/` folders count only in Supabase projects; plain Postgres apps that are
  // not exposed through PostgREST do not need row-level security.
  const supabaseMigrations = migrations.filter(
    (parsed) =>
      parsed.file.startsWith("supabase/") ||
      shape.usesSupabase ||
      /\bauth\s*\.\s*(?:uid\s*\(|users\b)|\bstorage\s*\.\s*buckets\b|\bto\s+(?:anon|authenticated)\b/i.test(
        parsed.text,
      ),
  );
  if (supabaseMigrations.length > 0) {
    findings.push(
      ...rlsFindings(supabaseMigrations),
      ...policyFindings(supabaseMigrations, collectColumns(supabaseMigrations)),
      ...grantFindings(supabaseMigrations),
      ...bucketFindings(supabaseMigrations),
    );
  }
  return findings;
}
