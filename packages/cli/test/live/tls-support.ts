/**
 * Pure helpers of feature 014's live passes (docs/e2e.md "Origin TLS, the recovery copy and the
 * deeper checks"): the deeper checks read back from `opscrew/SECURITY_REPORT.md`, the origin check
 * from a container on the edge's network, what of a run's certificates and settings is left in the
 * zone, the zone's other DNS records, the minimum-TLS decision, CAA records, the longest
 * interruption a load saw, and the secret parts of OpsCrew's generated values. No network, no
 * processes; unit-tested in `tls-support.test.ts`.
 */
import { OPSCREW_MANAGED_COMMENT, type SharedRecord } from "@opscrew/connector-cloudflare";
import { EDGE_PROJECT, type EdgeProxy } from "@opscrew/iac-templates";
import { DEEP_TOOL_NAME, type DeepTool } from "@opscrew/secops";
import { jsonStrings, type LoadFailure } from "./support";

// ---------------------------------------------------------------------------------------------
// The deeper checks in SECURITY_REPORT.md (`opscrew secure --deep`).

/** One counted row of a tool's table in the report's "Deeper checks". */
export interface DeepRow {
  /** `Pass`, `Fail`, `Warn` or `Skip`. */
  result: string;
  /** `Critical`, `High`, `Medium`, `Low` or `Info`. */
  severity: string;
  check: string;
  where: string;
  details: string;
}

/** One tool's subsection of "Deeper checks": its counted rows and its known noise apart. */
export interface DeepSection {
  /** The tool's name as the report shows it (`Lynis`, `ssh-audit`, `testssl.sh`). */
  tool: string;
  version: string;
  hardeningIndex?: number;
  rows: DeepRow[];
  /** The checks set apart as known noise. */
  noise: string[];
}

/** The cells of a Markdown table row (`| a | b \| c |`), with escaped pipes kept as text. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) =>
      cell
        .trim()
        .replaceAll("\\|", "|")
        .replace(/^\*\*(.*)\*\*$/, "$1"),
    );
}

/** Each tool's subsection of the report's "## Deeper checks", in order; none without it. */
export function deepSections(report: string): DeepSection[] {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Deeper checks");
  if (start === -1) return [];
  const sections: DeepSection[] = [];
  let table: "rows" | "noise" | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const heading = /^### (\S+)(?: (.*))?$/.exec(line.trim());
    if (heading !== null) {
      sections.push({ tool: heading[1] ?? "", version: heading[2] ?? "", rows: [], noise: [] });
      table = undefined;
      continue;
    }
    const section = sections.at(-1);
    if (section === undefined) continue;
    const index = /^Hardening index: \*\*(\d+)\*\*/.exec(line.trim());
    if (index !== null) section.hardeningIndex = Number(index[1]);
    if (!line.trim().startsWith("|")) {
      if (line.trim() === "") table = undefined;
      continue;
    }
    const row = cells(line);
    if (row[0] === "Result") table = "rows";
    else if (row[0] === "Check" && row[3] === "Why it is set apart") table = "noise";
    else if (/^-+$/.test(row[0] ?? "")) continue;
    else if (table === "rows") {
      const [result = "", severity = "", check = "", where = "", details = ""] = row;
      section.rows.push({ result, severity, check, where, details });
    } else if (table === "noise") section.noise.push(row[0] ?? "");
  }
  return sections;
}

/** The title of ssh-audit's policy result (`SSH meets ssh-audit's "<policy>" policy`). */
const SSH_POLICY = /^SSH meets ssh-audit's /;

/**
 * What is wrong with the deeper checks in a report: a tool of `ran` or `skipped` with no section;
 * a tool of `ran` that was skipped; testssl.sh reporting a high or critical finding (SC-1407);
 * ssh-audit's policy test failing apart from the listed noise (T1418); Lynis without its
 * hardening index; and a tool of `skipped` that ran (or was skipped without a reason).
 */
export function deepProblems(
  report: string,
  expected: { ran: readonly DeepTool[]; skipped?: readonly DeepTool[] },
): string[] {
  const sections = deepSections(report);
  const problems: string[] = [];
  const sectionOf = (tool: DeepTool) => {
    const section = sections.find((item) => item.tool === DEEP_TOOL_NAME[tool]);
    if (section === undefined)
      problems.push(`the report has no section for ${DEEP_TOOL_NAME[tool]}`);
    return section;
  };
  for (const tool of expected.ran) {
    const section = sectionOf(tool);
    if (section === undefined) continue;
    const name = DEEP_TOOL_NAME[tool];
    for (const row of section.rows.filter((item) => item.result === "Skip")) {
      problems.push(`${name} did not run: ${row.details}`);
    }
    if (tool === "testssl") {
      for (const row of section.rows) {
        const high = row.severity === "High" || row.severity === "Critical";
        if (high && (row.result === "Fail" || row.result === "Warn")) {
          problems.push(`testssl.sh reports ${row.check} (${row.severity}) at ${row.where}`);
        }
      }
    }
    if (tool === "ssh-audit") {
      const policy = section.rows.find((item) => SSH_POLICY.test(item.check));
      const noise = section.noise.some((check) => SSH_POLICY.test(check));
      if (policy === undefined && !noise)
        problems.push("ssh-audit's policy test is not in the report");
      if (policy !== undefined && policy.result !== "Pass") {
        problems.push(`ssh-audit's policy test: ${policy.details}`);
      }
    }
    if (tool === "lynis" && section.hardeningIndex === undefined) {
      problems.push("Lynis gave no hardening index");
    }
  }
  for (const tool of expected.skipped ?? []) {
    const section = sectionOf(tool);
    if (section === undefined) continue;
    const ran = section.rows.length === 0 || section.rows.some((row) => row.result !== "Skip");
    const unexplained = section.rows.some((row) => row.result === "Skip" && row.details === "");
    if (ran || unexplained) {
      problems.push(`${DEEP_TOOL_NAME[tool]} should be skipped with its reason here`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The origin check from the server.

/** Where each proxy listens for HTTPS on the edge's network (the nginx edge runs unprivileged). */
const EDGE_HTTPS: Record<EdgeProxy, string> = { caddy: "caddy:443", nginx: "nginx:8443" };

/**
 * The fallback of the origin check (research "Spike results" 14): `command`, a check that runs
 * `openssl s_client -connect 127.0.0.1:443` on the server, run instead in a throwaway container of
 * `image` (one with openssl and a shell) on the edge's network, against the proxy's own address
 * there. The script goes to the container's shell on stdin (base64 on the command line), so no
 * quoting of the check's own quotes is needed.
 */
export function fromEdgeNetwork(command: string, proxy: EdgeProxy, image: string): string {
  if (!command.includes("127.0.0.1:443")) {
    throw new Error("The origin check no longer connects to 127.0.0.1:443; update the fallback.");
  }
  const script = command.replace("127.0.0.1:443", EDGE_HTTPS[proxy]);
  const encoded = Buffer.from(`${script}\n`).toString("base64");
  return `printf '%s' '${encoded}' | base64 -d | docker run --rm -i --network ${EDGE_PROJECT} --entrypoint /bin/sh ${image}`;
}

// ---------------------------------------------------------------------------------------------
// The zone's certificates, settings and records (feature 014's Cloudflare side).

/** A zone's origin TLS as the live tests read it through Cloudflare's API. */
export interface ZoneTls {
  /** Origin CA certificates that are not revoked. */
  originCertificates: { id: string; hostnames: string[] }[];
  /** The ids of the client certificates for per-hostname origin pulls, those being deleted left out. */
  clientCertificates: string[];
  /** The per-hostname origin pull settings of the hostnames asked for (one without is left out). */
  hostnameSettings: { hostname: string; certId?: string; enabled: boolean | null }[];
  minTls: { value: string; editable: boolean };
}

/** What of a run's origin TLS is still in the zone: ids of certificates, and hostnames. */
export interface TlsLeft {
  originCertificates: string[];
  clientCertificates: string[];
  hostnameSettings: string[];
}

/**
 * What of the run is left in the zone `now`, compared with the zone `before` the run: origin
 * certificates for one of the run's `hostnames` (each run has hostnames of its own), client
 * certificates that were not there before, and the run's hostnames whose setting is still on.
 */
export function tlsLeft(now: ZoneTls, before: ZoneTls, hostnames: readonly string[]): TlsLeft {
  const ours = new Set(hostnames.map((host) => host.toLowerCase()));
  return {
    originCertificates: now.originCertificates
      .filter((cert) => cert.hostnames.some((host) => ours.has(host.toLowerCase())))
      .map((cert) => cert.id),
    clientCertificates: now.clientCertificates.filter(
      (id) => !before.clientCertificates.includes(id),
    ),
    hostnameSettings: now.hostnameSettings
      .filter((setting) => ours.has(setting.hostname.toLowerCase()) && setting.enabled === true)
      .map((setting) => setting.hostname),
  };
}

/** `left` as a list of what is left, for a message (empty when nothing is). */
export function tlsLeftText(left: TlsLeft): string[] {
  return [
    ...left.originCertificates.map((id) => `the origin certificate ${id}`),
    ...left.clientCertificates.map((id) => `the client certificate ${id}`),
    ...left.hostnameSettings.map((host) => `the origin pull setting of ${host}`),
  ];
}

/**
 * What is wrong from Cloudflare's side with an app's origin TLS (contracts/cloudflare-tls.md):
 * its record (`.opscrew/cloudflare.json`) must name an origin certificate for exactly the app's
 * proxied `hostnames` and a client certificate turned on for each of them, with no permission
 * gap; the zone must hold both, and each hostname's origin pull setting must be on with that
 * client certificate.
 */
export function cloudflareSideProblems(
  zone: ZoneTls,
  record: SharedRecord | undefined,
  hostnames: readonly string[],
): string[] {
  const want = [...hostnames].map((host) => host.toLowerCase()).sort();
  const { origin, client, gap } = record?.tls ?? {};
  const problems: string[] = [];
  if (gap !== undefined) problems.push(`the record has the gap "${gap}"`);
  if (origin === undefined) problems.push("the record names no origin certificate");
  else {
    const listed = zone.originCertificates.find((cert) => cert.id === origin.id);
    if (listed === undefined) problems.push(`the zone has no origin certificate ${origin.id}`);
    const covers = [...(listed?.hostnames ?? origin.hostnames)].map((h) => h.toLowerCase()).sort();
    if (JSON.stringify(covers) !== JSON.stringify(want)) {
      problems.push(`the origin certificate covers ${covers.join(", ")}, not ${want.join(", ")}`);
    }
  }
  if (client === undefined) problems.push("the record names no client certificate");
  else {
    if (!zone.clientCertificates.includes(client.id)) {
      problems.push(`the zone has no client certificate ${client.id}`);
    }
    for (const host of want) {
      const setting = zone.hostnameSettings.find((s) => s.hostname.toLowerCase() === host);
      if (setting?.enabled !== true || setting.certId !== client.id) {
        problems.push(
          `the origin pull setting of ${host} is not on with the app's client certificate`,
        );
      }
    }
  }
  return problems;
}

/** A DNS record as Cloudflare's API lists it: the fields the tests compare. */
export interface ZoneRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  proxied?: boolean;
  comment?: string | null;
  data?: { flags?: number; tag?: string; value?: string };
}

/**
 * How the zone's DNS records that are not on the run's `own` hostnames changed between `before`
 * and `after`: each added, removed or changed record by its type and a count, never its name or
 * content (another app's or the user's).
 */
export function otherRecordChanges(
  before: readonly ZoneRecord[],
  after: readonly ZoneRecord[],
  own: readonly string[],
): string[] {
  const ours = new Set(own.map((host) => host.toLowerCase()));
  const others = (records: readonly ZoneRecord[]) =>
    new Map(
      records
        .filter((record) => !ours.has(record.name.toLowerCase()))
        .map((record) => {
          const { id, type, name, content, proxied, comment, data } = record;
          return [id, { type, text: JSON.stringify({ name, content, proxied, comment, data }) }];
        }),
    );
  const was = others(before);
  const now = others(after);
  const counts = new Map<string, number>();
  const count = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  for (const [id, record] of was) {
    const current = now.get(id);
    if (current === undefined) count(`a ${record.type} record was removed`);
    else if (current.text !== record.text) count(`a ${record.type} record was changed`);
  }
  for (const [id, record] of now) if (!was.has(id)) count(`a ${record.type} record was added`);
  return [...counts].map(([what, n]) => (n === 1 ? what : `${what} (${n} times)`));
}

/** What the plan must decide about the zone's minimum TLS version (research R4). */
export type MinTlsDecision = "raise" | "advise" | "none";

/**
 * The decision the Cloudflare plan must make for a zone with the `setting` and `records`, read
 * before the provision: raise 1.0 to 1.2 when Cloudflare lets it be changed and every proxied A,
 * AAAA and CNAME record is OpsCrew's; only advise while it is below 1.2 otherwise; nothing at 1.2
 * or above.
 */
export function minTlsDecision(
  setting: ZoneTls["minTls"],
  records: readonly ZoneRecord[],
): MinTlsDecision {
  if (setting.value !== "1.0" && setting.value !== "1.1") return "none";
  const others = records.filter(
    (record) =>
      record.proxied === true &&
      ["A", "AAAA", "CNAME"].includes(record.type) &&
      record.comment !== OPSCREW_MANAGED_COMMENT,
  );
  return setting.value === "1.0" && setting.editable && others.length === 0 ? "raise" : "advise";
}

/** The issuers of the `issue` CAA records at `name` (sorted), with whether each is OpsCrew's. */
export function caaAt(
  records: readonly ZoneRecord[],
  name: string,
): { issuer: string; opscrew: boolean }[] {
  return records
    .filter((record) => record.type === "CAA" && record.name.toLowerCase() === name.toLowerCase())
    .filter((record) => record.data?.tag === "issue")
    .map((record) => ({
      issuer: record.data?.value ?? "",
      opscrew: record.comment === OPSCREW_MANAGED_COMMENT,
    }))
    .sort((a, b) => a.issuer.localeCompare(b.issuer));
}

// ---------------------------------------------------------------------------------------------
// The load, and the leak search's values.

/**
 * The longest stretch of failed requests in a steady load, in ms: failures sent at most
 * `gapMs` apart belong to one stretch, which lasts from its first to its last plus `intervalMs`
 * (the time between two requests); 0 without a failure.
 */
export function longestInterruption(
  failures: readonly LoadFailure[],
  intervalMs: number,
  gapMs = 2_000,
): number {
  const times = failures.map((failure) => Date.parse(failure.at)).sort((a, b) => a - b);
  let longest = 0;
  let first = times[0];
  let last = times[0];
  for (const time of times.slice(1)) {
    if (first === undefined || last === undefined) break;
    if (time - last > gapMs) {
      longest = Math.max(longest, last - first + intervalMs);
      first = time;
    }
    last = time;
  }
  if (first !== undefined && last !== undefined) {
    longest = Math.max(longest, last - first + intervalMs);
  }
  return longest;
}

/**
 * The secret values in OpsCrew's generated values (`generated_values.json`): every string of 8
 * characters or more, except in its origin TLS entry, where only the private keys are secret (the
 * certificates, the certificate request and its hostnames are public: `pull.pem` is committed and
 * the request is in the Cloudflare plan); plus the Portainer stack variable built from them
 * (base64 of the origin certificate, its key and `pull.pem`) when they are all there.
 */
export function generatedSecrets(json: unknown): string[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return jsonStrings(json);
  const { originTls, ...rest } = json as Record<string, unknown>;
  const tls = (originTls ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const request = (tls.ORIGIN_TLS_REQUEST ?? {}) as Record<string, unknown>;
  const keys = [tls.ORIGIN_TLS_KEY, tls.ORIGIN_PULL_KEY, request.key]
    .map(text)
    .filter((value): value is string => value !== undefined);
  const [cert, key, pull] = [tls.ORIGIN_TLS_CERT, tls.ORIGIN_TLS_KEY, tls.ORIGIN_PULL_CERT].map(
    text,
  );
  const bundle =
    cert !== undefined && key !== undefined && pull !== undefined
      ? [Buffer.from(`${cert}${key}${pull}`).toString("base64")]
      : [];
  return [...jsonStrings(rest), ...keys, ...bundle];
}
