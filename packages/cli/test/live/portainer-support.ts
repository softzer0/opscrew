/**
 * Pure helpers of the Portainer live test (`portainer-target.test.ts`, feature 010): its steps and
 * which of them a run takes, Portainer's setup token in `docker logs`, the openssl fingerprint the
 * user guide prints, the image version the deploy workflow writes, the firewall, a short host name
 * in text, value shapes without values, snapshot differences, the rollback's outcome and the DNS
 * preload that lets the CLI reach Portainer by a short host name. No network, no processes; the
 * safety and leak helpers and the step selection are unit-tested in `support.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { normalizeCertFingerprint } from "@opscrew/connector-portainer";
import type { FirewallRule } from "./cloud";

/** The Portainer CE release the live test installs as "the user's existing Portainer" (R1). */
export const PORTAINER_VERSION = "2.45.2";
/** Its image. */
export const PORTAINER_IMAGE = `portainer/portainer-ce:${PORTAINER_VERSION}`;
/** Portainer's HTTPS port on the throwaway server. */
export const PORTAINER_PORT = 9443;
/** The host port the app listens on in web mode `proxy`. */
export const PROXY_PORT = 8080;
/** The name the test gives the local Docker environment it creates (`portainer.environment`). */
export const ENVIRONMENT_NAME = "local";
/** The Compose project started outside Portainer, which OpsCrew must never touch. */
export const DECOY_PROJECT = "e2e-decoy-compose";
/** The Portainer stack of "the user", which OpsCrew must never touch. */
export const DECOY_STACK = "e2e-decoy-stack";
/** The short-lived stack the test uses to observe Portainer itself (bare variables, stop). */
export const PROBE_STACK = "e2e-probe-env";
/** A small pinned image for the decoys and the probe. */
export const BUSYBOX_IMAGE = "busybox:1.37";
/** A merged change must be live within this time of the deploy workflow writing it (quickstart 3). */
export const SELF_DEPLOY_TARGET_MS = 5 * 60_000;

/**
 * The live test's steps in order, each with the steps it needs (`OPSCREW_E2E_PORTAINER_STEPS`).
 * Every run takes 1 (the server with Portainer), 1b (the optional pause) and 12 (the leak search).
 */
export const PORTAINER_STEPS: readonly { id: string; needs: readonly string[] }[] = [
  { id: "1", needs: [] },
  { id: "1b", needs: ["1"] },
  { id: "2a", needs: ["1"] },
  { id: "2", needs: ["2a"] },
  { id: "3", needs: ["2"] },
  { id: "3b", needs: ["2"] },
  { id: "4", needs: ["2"] },
  { id: "5", needs: ["2"] },
  { id: "6", needs: ["2"] },
  { id: "7", needs: ["2"] },
  { id: "8", needs: ["2"] },
  { id: "9", needs: ["8"] },
  { id: "10", needs: ["2a"] },
  { id: "11", needs: ["2a"] },
  { id: "12", needs: ["1"] },
];

/** The steps of the core pass (the default). */
export const CORE_STEPS = ["1", "1b", "2a", "2", "3", "8", "9", "12"] as const;

/**
 * The steps `OPSCREW_E2E_PORTAINER_STEPS` selects, in order: `core` (or unset), `full` (every
 * step) or a comma-separated list such as `11,12`, to which every step a chosen one needs is
 * added (steps 1, 1b and 12 are always taken). OpsCrew refuses another Portainer address while its
 * record lists anything, so when step 2 sets the app up, the fresh setups of steps 10 and 11 also
 * take steps 8 and 9, which empty that record. `undefined` for anything else (an unknown step).
 */
export function portainerSteps(value: string | undefined): string[] | undefined {
  const text = (value ?? "").trim().toLowerCase() || "core";
  const ids = PORTAINER_STEPS.map((step) => step.id);
  if (text === "full") return ids;
  const chosen =
    text === "core"
      ? [...CORE_STEPS]
      : text.split(",").map((part) => part.trim().replace(/\.$/, ""));
  if (chosen.some((id) => !ids.includes(id))) return undefined;
  const selected = new Set<string>();
  const take = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const need of PORTAINER_STEPS.find((step) => step.id === id)?.needs ?? []) take(need);
  };
  for (const id of ["1", "1b", "12", ...chosen]) take(id);
  if (selected.has("2") && (selected.has("10") || selected.has("11"))) take("9");
  return ids.filter((id) => selected.has(id));
}

/** The step number a step title starts with (`"8. destroy …"` → `"8"`, `"1b. …"` → `"1b"`). */
export function stepNumber(title: string): string {
  return /^(\d+[a-z]?)\./.exec(title)?.[1] ?? "";
}

/**
 * A short host name for the output check: one lower-case DNS label of 2 to 15 characters that is
 * not a loopback name, and not `portainer`: OpsCrew's own text uses that word (`opscrew portainer
 * status`, "your Portainer"), so a bare mention would not tell a leak from a command name. By
 * default `nas` and five random letters or digits (`nasq7v2k`): still one short label, but never a
 * word an app or an encoded value contains by chance. Throws a plain message for anything else.
 */
export function shortHostName(value: string | undefined): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = [...randomBytes(5)].map((byte) => alphabet[byte % alphabet.length]).join("");
  const host = (value ?? "").trim() || `nas${suffix}`;
  if (!/^[a-z][a-z0-9-]{1,14}$/.test(host) || host.endsWith("-") || host === "localhost") {
    throw new Error(
      `OPSCREW_E2E_PORTAINER_SHORT_HOST="${host}" must be one lower-case label of 2 to 15 letters, digits or dashes (for example nas), not localhost.`,
    );
  }
  if (host === "portainer") {
    throw new Error(
      'OPSCREW_E2E_PORTAINER_SHORT_HOST="portainer" is a word OpsCrew itself prints (`opscrew portainer …`), so the output check could not tell a leak from it. Choose another short name, for example nas.',
    );
  }
  return host;
}

/**
 * Portainer's one-time setup token from `docker logs portainer` (research R10: admin
 * initialisation needs it as `X-Setup-Token`): Portainer 2.45 prints it on a line of its own as
 * `setup_token=<hex>`.
 */
export function setupTokenFromLogs(logs: string): string | undefined {
  return /^\s*setup_token=([0-9a-f]{16,})\b/m.exec(logs)?.[1];
}

/**
 * The fingerprint in the output of the user guide's command
 * (`openssl s_client … | openssl x509 -noout -fingerprint -sha256`): `sha256 Fingerprint=AB:…`
 * (OpenSSL 3) or `SHA256 Fingerprint=AB:…`, in OpsCrew's canonical form (`SHA256:AB:…`).
 */
export function opensslFingerprint(output: string): string | undefined {
  const value = /\bsha256 Fingerprint=([0-9A-Fa-f:]{95})\b/i.exec(output)?.[1];
  return value === undefined ? undefined : normalizeCertFingerprint(`SHA256:${value}`);
}

/** The app image the deploy branch's `compose.yaml` runs, and the version Caddy reports for it. */
export interface DeployedImage {
  /** `ghcr.io/<owner>/<name>`. */
  repository: string;
  /** The image digest, 64 hex digits. */
  digest: string;
  /** The digest's first 12 hex digits, as the `X-OpsCrew-Image` header shows it. */
  version: string;
}

/**
 * The app image in a stack file the deploy workflow wrote (`ghcr.io/<owner>/<name>@sha256:<hex>`);
 * `undefined` for the placeholder or a template that still has its marker.
 */
export function deployedImage(compose: string): DeployedImage | undefined {
  const match = /\b(ghcr\.io\/[a-z0-9._/-]+)@sha256:([0-9a-f]{64})\b/.exec(compose);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { repository: match[1], digest: match[2], version: match[2].slice(0, 12) };
}

/**
 * The throwaway server's firewall: SSH, HTTP and HTTPS from anywhere (Caddy's certificates and
 * the deploy workflow's health checks), Portainer's port and the `proxy` port only from the test
 * computer. Everything else is closed from outside.
 */
export function firewallRules(testIpv4: string): FirewallRule[] {
  const anywhere = ["0.0.0.0/0", "::/0"];
  const tester = [`${testIpv4}/32`];
  return [
    { direction: "in", protocol: "tcp", port: "22", source_ips: anywhere, description: "ssh" },
    { direction: "in", protocol: "tcp", port: "80", source_ips: anywhere, description: "http" },
    { direction: "in", protocol: "tcp", port: "443", source_ips: anywhere, description: "https" },
    { direction: "in", protocol: "udp", port: "443", source_ips: anywhere, description: "http3" },
    {
      direction: "in",
      protocol: "tcp",
      port: String(PORTAINER_PORT),
      source_ips: tester,
      description: "portainer (test computer only)",
    },
    {
      direction: "in",
      protocol: "tcp",
      port: String(PROXY_PORT),
      source_ips: tester,
      description: "proxy mode (test computer only)",
    },
  ];
}

/** A `multipart/form-data` body of plain text fields (Portainer's `POST /api/endpoints`). */
export function multipartForm(fields: Record<string, string>): {
  body: string;
  contentType: string;
} {
  const boundary = `opscrew-e2e-${randomBytes(12).toString("hex")}`;
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    body: `${parts.join("")}--${boundary}--\r\n`,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * How often `host` (a short, single-label name such as `nas`) appears in `text` as a host name:
 * case-sensitive, not inside a longer name or word (`opscrew-shop-nas-tunnel`, `nasal`), and not
 * as the first part of a dotted id (`nas.local`, `portainer.url`); `nas:9443`, `//nas/` and a
 * sentence ending in `nas.` count.
 */
export function shortHostMentions(text: string, host: string): number {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "g");
  return [...text.matchAll(pattern)].length;
}

/** Whether a saved plan file is OpenTofu's encrypted form: JSON with `meta` and `encrypted_data`. */
export function isEncryptedPlan(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "meta" in parsed &&
      typeof (parsed as { encrypted_data?: unknown }).encrypted_data === "string"
    );
  } catch {
    return false;
  }
}

/**
 * The shape of a value without its contents: types for scalars (`string`, `number`, …), keys with
 * their shapes for objects (sorted), and the first element's shape for arrays. Used to log what
 * Portainer returns (`DeploymentStatus`, `GitConfig`, `AutoUpdate`) without a single value.
 */
export function valueShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `${value.length} × ${valueShape(value[0], depth + 1)}`;
  }
  if (typeof value === "object") {
    if (depth >= 3) return "{…}";
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{ ${entries.map(([key, inner]) => `${key}: ${valueShape(inner, depth + 1)}`).join(", ")} }`;
  }
  return typeof value;
}

/** The top-level keys whose values differ between two JSON-like records (sorted). */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/**
 * The messages of the `##[error]` lines of a GitHub Actions job log (each line may start with a
 * timestamp), in order. The rest of the log is never returned: it may hold masked values.
 */
export function logErrors(log: string): string[] {
  const errors: string[] = [];
  for (const line of log.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?##\[error\](.*)$/.exec(line);
    if (match?.[1] !== undefined) errors.push(match[1].trim());
  }
  return errors;
}

/**
 * The rollback's outcome, read from the error lines of a failed deploy job's log. The rollback
 * step always fails the job and says in its error line what it did: it succeeded only when
 * it wrote the previous version back (and Portainer did not refuse the redeploy). Otherwise the
 * message names what the job reported instead (could not write it back, no earlier version).
 */
export function rollbackOutcome(messages: readonly string[]): { ok: boolean; message: string } {
  const reports = messages.filter((message) => message.startsWith("The deploy failed"));
  const wrote = reports.find(
    (message) =>
      message.includes("wrote the previous version back") &&
      !message.includes("did not confirm") &&
      !message.includes("could not"),
  );
  if (wrote !== undefined) return { ok: true, message: wrote };
  if (reports.length > 0) {
    return { ok: false, message: `the rollback did not succeed: ${reports.join(" | ")}` };
  }
  return {
    ok: false,
    message:
      messages.length === 0
        ? "the failed deploy job's log has no error lines, so the rollback reported nothing"
        : `the rollback reported no outcome; the job's errors: ${messages.join(" | ")}`,
  };
}

/**
 * The source of an ES module for `node --import` that makes `dns.lookup` (which `net`, `tls`,
 * `https` and `fetch` use) answer `hosts` (name → address) and pass every other name on. It lets
 * the CLI reach Portainer by a short host name that no DNS server knows.
 */
export function dnsPreloadSource(hosts: Readonly<Record<string, string>>): string {
  return [
    "// Written by the OpsCrew Portainer live test: resolves its short Portainer host name.",
    'import dns from "node:dns";',
    `const hosts = new Map(Object.entries(${JSON.stringify(hosts)}));`,
    'const answer = (hostname) => (typeof hostname === "string" ? hosts.get(hostname.toLowerCase()) : undefined);',
    "const original = dns.lookup;",
    "dns.lookup = function lookup(hostname, options, callback) {",
    '  if (typeof options === "function") {',
    "    callback = options;",
    "    options = {};",
    "  }",
    "  const address = answer(hostname);",
    "  if (address === undefined) return original.call(dns, hostname, options, callback);",
    '  const opts = typeof options === "number" ? { family: options } : (options ?? {});',
    '  const family = address.includes(":") ? 6 : 4;',
    "  process.nextTick(() =>",
    "    opts.all ? callback(null, [{ address, family }]) : callback(null, address, family),",
    "  );",
    "};",
    "const promises = dns.promises;",
    "const originalPromise = promises.lookup;",
    "promises.lookup = async function lookup(hostname, options) {",
    "  const address = answer(hostname);",
    "  if (address === undefined) return originalPromise.call(promises, hostname, options);",
    '  const family = address.includes(":") ? 6 : 4;',
    '  return typeof options === "object" && options?.all ? [{ address, family }] : { address, family };',
    "};",
    "",
  ].join("\n");
}

/** The interview answers for a Portainer target (written to a file for `interview --answers`). */
export interface PortainerAnswers {
  domain: string;
  url: string;
  redeploy: "updater" | "cloudflare";
  web: "tunnel" | "proxy" | "caddy";
}

/** The answers file's contents: the usual answers plus the `portainer.*` ones. */
export function portainerAnswers(answers: PortainerAnswers): Record<string, unknown> {
  return {
    provider: "portainer",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: 20,
    uptime: "best-effort",
    dataCriticality: "important",
    dnsProvider: "cloudflare",
    domain: answers.domain,
    keepExternalServices: [],
    "portainer.url": answers.url,
    "portainer.environment": ENVIRONMENT_NAME,
    "portainer.redeploy": answers.redeploy,
    "portainer.web": answers.web,
    ...(answers.web === "proxy" ? { "portainer.port": PROXY_PORT } : {}),
  };
}

/**
 * The names of a container's environment (`docker inspect -f '{{json .Config.Env}}'`) that start
 * with `prefix`, each with whether it has a non-empty value. Values are never returned.
 */
export function envNames(inspectJson: string, prefix: string): { name: string; empty: boolean }[] {
  const list = JSON.parse(inspectJson) as unknown;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is string => typeof item === "string" && item.startsWith(prefix))
    .map((item) => {
      const at = item.indexOf("=");
      const name = at === -1 ? item : item.slice(0, at);
      const value = at === -1 ? "" : item.slice(at + 1);
      return { name, empty: value === "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
