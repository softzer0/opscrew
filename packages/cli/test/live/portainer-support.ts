/**
 * Pure helpers of the Portainer live test (`portainer-target.test.ts`, feature 010): its variables,
 * Portainer's setup token in `docker logs`, the openssl fingerprint the user guide prints, plan
 * hashes and DNS notes in CLI output, the image version the deploy workflow writes, a short host
 * name in text, value shapes without values, snapshot differences, and the DNS preload that lets
 * the CLI reach Portainer by a short host name. No network, no processes; unit-tested in
 * `portainer-target.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { normalizeCertFingerprint } from "@opscrew/connector-portainer";

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

/** The variables the Portainer live test needs; each missing one is named in the skip message. */
export const PORTAINER_E2E_VARIABLES = [
  "OPSCREW_E2E_PORTAINER",
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
  "OPSCREW_E2E_GHCR_READ_TOKEN",
] as const;

/** The variables of {@link PORTAINER_E2E_VARIABLES} that are not set (`OPSCREW_E2E_PORTAINER` must be `1`). */
export function missingPortainerVariables(env: Record<string, string | undefined>): string[] {
  return PORTAINER_E2E_VARIABLES.filter((name) =>
    name === "OPSCREW_E2E_PORTAINER" ? env[name] !== "1" : (env[name] ?? "").trim() === "",
  ).map((name) => (name === "OPSCREW_E2E_PORTAINER" ? `${name}=1` : name));
}

/**
 * A short host name for the output check (default `nas`): one lower-case DNS label of 2 to 15
 * characters that is not a loopback name, and not `portainer`: OpsCrew's own text uses that word
 * (`opscrew portainer status`, "your Portainer"), so a bare mention would not tell a leak from a
 * command name. Throws a plain message for anything else.
 */
export function shortHostName(value: string | undefined): string {
  const host = (value ?? "").trim() || "nas";
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

/** A token-like value: 8 or more characters with at least one digit or upper-case letter. */
const tokenLike = (value: string) => value.length >= 8 && /[0-9A-Z]/.test(value);

/**
 * Portainer's one-time setup token from `docker logs portainer` (research R10: admin
 * initialisation needs it as `X-Setup-Token`). Looks only at lines that mention a setup token and
 * takes `token=<value>`, `token: <value>` or `"token":"<value>"`, or else the longest token-like
 * run on the line that is not a path or a time. `undefined` when no such line has one.
 */
export function setupTokenFromLogs(logs: string): string | undefined {
  for (const line of logs.split(/\r?\n/)) {
    if (!/setup[ _-]?token/i.test(line)) continue;
    const keyed = /\btoken["']?\s*[=:]\s*["']?([A-Za-z0-9._~+=-]+)/i.exec(line)?.[1];
    if (keyed !== undefined && tokenLike(keyed)) return keyed;
    const runs = [...line.matchAll(/[A-Za-z0-9_-]{16,}/g)]
      .map((match) => match[0])
      .filter((run) => tokenLike(run) && !/^[\d_-]+$/.test(run));
    const longest = runs.sort((a, b) => b.length - a.length)[0];
    if (longest !== undefined) return longest;
  }
  return undefined;
}

/**
 * The shape of a log line with every value-like run masked (`<value>`), so a line that should
 * have held the setup token can be described without showing a token.
 */
export function logLineShape(line: string): string {
  return line
    .replace(/[A-Za-z0-9._~+/=-]{8,}/g, (run) =>
      tokenLike(run) || run.length >= 20 ? "<value>" : run,
    )
    .slice(0, 200);
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

/** The last stack plan hash a run showed (`Stack plan hash: <hash>`). */
export function stackPlanHashOf(output: string): string | undefined {
  return [...output.matchAll(/Stack plan hash: ([0-9a-f]{64})\b/g)].at(-1)?.[1];
}

/** The stack plan hash a run applied (`Applied the stack plan <hash> to your Portainer.`). */
export function appliedStackPlan(output: string): string | undefined {
  return /Applied the stack plan ([0-9a-f]{64}) to your Portainer\./.exec(output)?.[1];
}

/** The sentence `provision --plan-only` prints when the stack plan follows the infrastructure apply. */
export const THREE_RUNS_SENTENCE = "In a script that takes three runs";

/**
 * True when the output names the DNS record the user creates for `host` in web mode `proxy` or
 * `caddy` ("OpsCrew creates no DNS record for <host>…").
 */
export function namesDnsRecord(output: string, host: string): boolean {
  return output.includes(`OpsCrew creates no DNS record for ${host}`);
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

/** The test computer's public IPv4 address in Cloudflare's trace (`ip=<address>`). */
export function ipv4FromTrace(trace: string): string | undefined {
  const ip = /^ip=(\d{1,3}(?:\.\d{1,3}){3})$/m.exec(trace)?.[1];
  if (ip === undefined) return undefined;
  return ip.split(".").every((part) => Number(part) <= 255) ? ip : undefined;
}

/** One inbound rule of a Hetzner Cloud firewall. */
export interface FirewallRule {
  direction: "in";
  protocol: "tcp" | "udp";
  port: string;
  source_ips: string[];
  description: string;
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

/** How many lines of the updater's log say that asking Portainer to redeploy failed. */
export function updaterFailures(logs: string): number {
  return logs
    .split(/\r?\n/)
    .filter((line) => line.includes("asking Portainer to redeploy the app failed")).length;
}

/**
 * The Dockerfile of a deliberately failing change: the same image with a last `CMD` that exits at
 * once, so the new version never answers and the deploy workflow must roll back.
 */
export function failingDockerfile(dockerfile: string): string {
  return `${dockerfile.trimEnd()}\n\n# opscrew-e2e: a deliberately failing version; the deploy must roll back.\nCMD ["/bin/sh", "-c", "echo 'opscrew-e2e: failing on purpose'; exit 1"]\n`;
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

/** `NODE_OPTIONS` that loads the preload module at `fileUrl` (quoted: the path may have spaces). */
export function preloadNodeOptions(fileUrl: string, existing?: string): string {
  return [existing?.trim(), `--import="${fileUrl}"`].filter(Boolean).join(" ");
}

/** The interview answers for a Portainer target (written to a file for `interview --answers`). */
export interface PortainerAnswers {
  domain: string;
  url: string;
  redeploy: "updater" | "cloudflare";
  web: "tunnel" | "proxy" | "caddy";
  port?: number;
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
    ...(answers.web === "proxy" ? { "portainer.port": answers.port ?? PROXY_PORT } : {}),
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

/** Minutes and seconds in words (`3 min 5 s`). */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A merged change must be live within this time of the deploy workflow writing it (quickstart 3). */
export const SELF_DEPLOY_TARGET_MS = 5 * 60_000;

/**
 * Which steps a live run takes (`OPSCREW_E2E_PORTAINER_STEPS`): `core` (the default) takes the
 * setup, updater + tunnel, one change deploying by itself with the unchanged-branch check, both
 * destroys and the leak check; `full` takes every step.
 */
export type PortainerPass = "core" | "full";

/** The steps of the core pass, by the number their title starts with (1b is the optional pause). */
export const CORE_STEPS: readonly string[] = ["1", "1b", "2", "3", "8", "9", "12"];

/** Why a step, or a part of one, does not run in the core pass. */
export const NOT_IN_CORE = "not in the core pass; set OPSCREW_E2E_PORTAINER_STEPS=full";

/**
 * How long each pass takes, roughly (on 2026-10-15 the full matrix took about 2 hours and the
 * first core pass 14½ minutes).
 */
export const PASS_ESTIMATE: Readonly<Record<PortainerPass, string>> = {
  core: "about 15 minutes",
  full: "about 1–1½ hours",
};

/** The pass `OPSCREW_E2E_PORTAINER_STEPS` selects (`core` when unset); undefined for anything else. */
export function portainerPass(value: string | undefined): PortainerPass | undefined {
  const pass = (value ?? "").trim().toLowerCase() || "core";
  return pass === "core" || pass === "full" ? pass : undefined;
}

/** The step number a step title starts with (`"8. destroy …"` → `"8"`, `"1b. …"` → `"1b"`). */
export function stepNumber(title: string): string {
  return /^(\d+[a-z]?)\./.exec(title)?.[1] ?? "";
}

/** Whether a step, by its title or its number, runs in `pass`. */
export function inPass(pass: PortainerPass, step: string): boolean {
  return pass === "full" || CORE_STEPS.includes(stepNumber(step) || step);
}
