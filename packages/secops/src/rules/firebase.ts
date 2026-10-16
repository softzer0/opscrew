/**
 * Firebase exposure rules (`opscrew-firebase`): open or test-mode Cloud Firestore and Cloud
 * Storage security rules, and open Realtime Database rules. Deterministic and offline.
 */
import type { Finding, ScanContext, Scanner } from "@opscrew/contracts";
import { createFinding, type FindingInput } from "../scan/finding";
import { basename, compact, dirname, lineLocator, readText } from "../scan/text";

const SOURCE = "opscrew-firebase";

const REFS = {
  insecure: "https://firebase.google.com/docs/rules/insecure-rules",
  firestore: "https://firebase.google.com/docs/firestore/security/get-started",
  storage: "https://firebase.google.com/docs/storage/security",
  rtdb: "https://firebase.google.com/docs/database/security",
} as const;

/** Creates the built-in Firebase scanner. */
export function createFirebaseScanner(): Scanner {
  return {
    id: SOURCE,
    kind: "builtin",
    isAvailable: async () => true,
    scan: scanFirebase,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A Firebase finding; its evidence (a rule, never a secret) is what its id fingerprints. */
function makeFinding(input: Omit<FindingInput, "category" | "source" | "rawMatch">): Finding {
  return createFinding({
    ...input,
    category: "firebase",
    source: SOURCE,
    rawMatch: input.evidence ?? "",
  });
}

/** Replaces `//` and block comments with spaces (newlines kept), leaving string contents alone. */
function stripComments(source: string): string {
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

/** Splits a condition on `||` outside parentheses and strings. */
function disjuncts(condition: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < condition.length; k++) {
    const c = condition[k];
    if (c === '"' || c === "'") {
      const end = condition.indexOf(c, k + 1);
      k = end < 0 ? condition.length : end;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && condition[k + 1] === "|" && depth === 0) {
      parts.push(condition.slice(from, k));
      from = k + 2;
      k++;
    }
  }
  parts.push(condition.slice(from));
  return parts.map(unwrap);
}

/** Removes whitespace-insensitive outer parentheses. */
function unwrap(expression: string): string {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  return value;
}

const TEST_MODE =
  /^request\s*\.\s*time\s*<\s*timestamp\s*\.\s*date\s*\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/;
const RTDB_TEST_MODE = /^now\s*<\s*\d+$/;

type Openness = { kind: "open" } | { kind: "test-mode"; until: string } | undefined;

/** Whether a rules condition lets everyone in (always, or until a test-mode date). */
function openness(condition: string | undefined): Openness {
  if (condition === undefined) return { kind: "open" };
  const parts = disjuncts(condition);
  if (parts.some((part) => part === "true")) return { kind: "open" };
  for (const part of parts) {
    const date = TEST_MODE.exec(part);
    if (date) {
      const until = `${date[1]}-${date[2]?.padStart(2, "0")}-${date[3]?.padStart(2, "0")}`;
      return { kind: "test-mode", until };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Firestore and Storage rules
// ---------------------------------------------------------------------------------------------

const WRITE_METHODS = new Set(["write", "create", "update", "delete"]);
/** `match <path> {`, `allow <methods>[: if <condition>];`, or a bare brace. Paths may contain `{wildcards}`. */
const TOKEN = /\bmatch\s+(\/\S*)\s*\{|\ballow\s+([a-z\s,]+?)\s*(?::\s*if\b([^;]*))?;|[{}]/g;

function scanRulesFile(file: string, source: string): Finding[] {
  const text = stripComments(source);
  const service = /\bservice\s+(cloud\.firestore|firebase\.storage)\b/.exec(text)?.[1];
  const storage = service ? service === "firebase.storage" : basename(file) === "storage.rules";
  const product = storage ? "Cloud Storage" : "Cloud Firestore";
  const findings: Finding[] = [];
  const lineAt = lineLocator(text);
  const stack: Array<string | null> = [];
  for (const token of text.matchAll(TOKEN)) {
    const [whole, matchPath, methodList, condition] = token;
    if (matchPath !== undefined) {
      stack.push(matchPath);
      continue;
    }
    if (whole === "{") {
      stack.push(null);
      continue;
    }
    if (whole === "}") {
      stack.pop();
      continue;
    }
    if (methodList === undefined) continue;
    const methods = methodList
      .split(",")
      .map((method) => method.trim())
      .filter((method) => method.length > 0);
    const open = openness(condition);
    if (!open) continue;
    // Drop the fixed service prefixes (`/databases/{database}/documents`, `/b/{bucket}/o`).
    const path =
      stack
        .filter((part): part is string => part !== null)
        .join("")
        .replace(/^\/databases\/\{[^}]*\}\/documents|^\/b\/\{[^}]*\}\/o/, "") || "/";
    const line = lineAt(token.index);
    const evidence = compact(`match ${path} { ${whole} }`);
    const writes = methods.some((method) => WRITE_METHODS.has(method));
    const what = methods.join(", ");
    if (open.kind === "test-mode") {
      findings.push(
        makeFinding({
          ruleId: "firebase/test-mode-rules",
          title: `${product} rules are still in test mode`,
          severity: "critical",
          file,
          line,
          evidence,
          description:
            `These ${product} rules allow ${what} for everyone until ${open.until} ("test ` +
            'mode"). Until then anyone can read and overwrite your data without signing in; ' +
            "after that date every request is refused and the app stops working.",
          remediation:
            "Replace the test-mode rule with real rules that require sign-in and check " +
            "ownership, for example `allow read, write: if request.auth != null && " +
            "request.auth.uid == userId;`, then deploy them with `firebase deploy --only " +
            `${storage ? "storage" : "firestore:rules"}\`.`,
          references: [REFS.insecure, storage ? REFS.storage : REFS.firestore],
        }),
      );
    } else if (writes) {
      findings.push(
        makeFinding({
          ruleId: "firebase/open-rules",
          title: `${product} rules let anyone ${methods.includes("read") ? "read and write" : "write"} ${path}`,
          severity: "critical",
          file,
          line,
          evidence,
          description:
            `This rule allows ${what} on \`${path}\` without any condition. Anyone on the ` +
            `internet can ${storage ? "upload, replace or delete files" : "create, change or delete documents"}` +
            `${methods.includes("read") ? " and read everything" : ""}, without signing in.`,
          remediation:
            "Require authentication and ownership, for example `allow write: if " +
            "request.auth != null && request.auth.uid == userId;`, and deploy the rules again.",
          references: [REFS.insecure, storage ? REFS.storage : REFS.firestore],
        }),
      );
    } else {
      findings.push(
        makeFinding({
          ruleId: "firebase/public-read",
          title: `${product} data under ${path} is readable by everyone`,
          severity: storage ? "medium" : "high",
          file,
          line,
          evidence,
          description: storage
            ? `This rule lets anyone download every file under \`${path}\` without signing in. ` +
              "That is fine for public assets, but not for user uploads or private documents."
            : `This rule lets anyone read every document under \`${path}\` without signing in, ` +
              "including personal data such as emails or phone numbers stored there.",
          remediation:
            "Limit reads to signed-in users who own the data (`allow read: if request.auth != " +
            "null && request.auth.uid == userId;`), or keep only truly public data in this path.",
          references: [REFS.insecure, storage ? REFS.storage : REFS.firestore],
        }),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Realtime Database rules (JSON)
// ---------------------------------------------------------------------------------------------

function scanDatabaseRules(file: string, source: string): Finding[] {
  const text = stripComments(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rules = (parsed as { rules?: unknown } | null)?.rules;
  if (!rules || typeof rules !== "object") return [];
  // Key occurrences in document order, matched to the depth-first walk below (same order).
  const positions: Record<string, number[]> = { ".read": [], ".write": [] };
  for (const match of text.matchAll(/"(\.read|\.write)"\s*:/g)) {
    positions[match[1] as string]?.push(match.index);
  }
  const seen: Record<string, number> = { ".read": 0, ".write": 0 };
  const findings: Finding[] = [];
  const lineAt = lineLocator(text);
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === ".read" || key === ".write") {
        const index = positions[key]?.[seen[key] ?? 0] ?? 0;
        seen[key] = (seen[key] ?? 0) + 1;
        const expression = typeof value === "string" ? unwrap(value) : value;
        const open = expression === true || expression === "true";
        const testMode = typeof expression === "string" && RTDB_TEST_MODE.test(expression);
        if (!open && !testMode) continue;
        const where = path.length === 0 ? "/" : `/${path.join("/")}`;
        const isWrite = key === ".write";
        const root = path.length === 0;
        const evidence = compact(`${where}: "${key}": ${JSON.stringify(value)}`);
        const line = lineAt(index);
        if (testMode) {
          findings.push(
            makeFinding({
              ruleId: "firebase/test-mode-rules",
              title: "Realtime Database rules are still in test mode",
              severity: "critical",
              file,
              line,
              evidence,
              description:
                `\`${key}\` at \`${where}\` is open to everyone until a fixed timestamp (test ` +
                "mode). Until then anyone can access the data without signing in; afterwards " +
                "every request is refused.",
              remediation:
                'Replace it with a real rule such as `"auth != null && auth.uid === $uid"` and ' +
                "deploy with `firebase deploy --only database`.",
              references: [REFS.insecure, REFS.rtdb],
            }),
          );
          continue;
        }
        findings.push(
          makeFinding({
            ruleId: "firebase/rtdb-open",
            title: `Realtime Database ${isWrite ? "writable" : "readable"} by everyone at ${where}`,
            severity: isWrite || root ? "critical" : "high",
            file,
            line,
            evidence,
            description:
              `\`"${key}": true\` at \`${where}\` lets anyone on the internet ` +
              `${isWrite ? "change or delete" : "read"} ${root ? "the entire database" : "everything under this path"} ` +
              "without signing in.",
            remediation:
              'Require authentication, for example `".' +
              `${isWrite ? "write" : "read"}": "auth != null && auth.uid === $uid"\` under a ` +
              "`$uid` path, and deploy with `firebase deploy --only database`.",
            references: [REFS.insecure, REFS.rtdb],
          }),
        );
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, [...path, key]);
      }
    }
  };
  walk(rules as Record<string, unknown>, []);
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------

/** Rules files declared in `firebase.json` (paths resolved against its directory). */
function declaredRules(firebaseJson: string, dir: string): { rules: string[]; database: string[] } {
  const rules: string[] = [];
  const database: string[] = [];
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(firebaseJson) as Record<string, unknown>;
  } catch {
    return { rules, database };
  }
  const collect = (section: unknown, into: string[]) => {
    for (const entry of Array.isArray(section) ? section : [section]) {
      const path = (entry as { rules?: unknown } | null)?.rules;
      if (typeof path === "string") {
        const clean = path.replace(/^\.\//, "");
        into.push(dir ? `${dir}/${clean}` : clean);
      }
    }
  };
  collect(config.firestore, rules);
  collect(config.storage, rules);
  collect(config.database, database);
  return { rules, database };
}

async function scanFirebase(context: ScanContext): Promise<Finding[]> {
  const read = (file: string) => readText(context, file);
  const available = new Set(context.files);
  const rulesFiles = new Set<string>();
  const databaseFiles = new Set<string>();
  for (const file of context.files) {
    const name = basename(file);
    if (name.endsWith(".rules.json")) databaseFiles.add(file);
    else if (name.endsWith(".rules")) rulesFiles.add(file);
    else if (name === "firebase.json") {
      const text = await read(file);
      if (text === undefined) continue;
      const declared = declaredRules(text, dirname(file));
      for (const path of declared.rules) if (available.has(path)) rulesFiles.add(path);
      for (const path of declared.database) if (available.has(path)) databaseFiles.add(path);
    }
  }
  const findings: Finding[] = [];
  for (const file of [...rulesFiles].sort()) {
    const text = await read(file);
    if (text === undefined) continue;
    const known = basename(file) === "firestore.rules" || basename(file) === "storage.rules";
    if (!known && !/\bservice\s+(?:cloud\.firestore|firebase\.storage)\b/.test(text)) continue;
    findings.push(...scanRulesFile(file, text));
  }
  for (const file of [...databaseFiles].sort()) {
    if (rulesFiles.has(file)) continue;
    const text = await read(file);
    if (text !== undefined) findings.push(...scanDatabaseRules(file, text));
  }
  return findings;
}
