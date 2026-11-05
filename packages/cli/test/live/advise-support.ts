/**
 * Pure helpers of feature 021's live test (`advise.test.ts`, docs/e2e.md "Advise"): the gate, the
 * server type the pass starts on, the ballast container that makes the server short of memory,
 * `advise --json`'s report, the monthly prices expected from the provider's live price list, the
 * audit entries an advise run added, and the `notRead` lines the pass expects. No network, no
 * processes of their own; unit-tested in `advise-support.test.ts`.
 */
import { type AdviceReport, type Proposal, ProposalSchema, THRESHOLDS } from "@opscrew/agents";
import type { ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import { z } from "zod";

/** The test's gate. */
export const ADVISE_GATE = "OPSCREW_E2E_ADVISE";

/** Hetzner's smallest type, which a move up resizes in place (research R5, S1). */
export const SMALLEST_TYPE = "cx23";

/** SC-2101: `opscrew advise` finishes within 60 seconds. */
export const SC_2101_MS = 60_000;

/** The ballast container's label: the test's own, so nothing else on the server matches it. */
export const BALLAST_LABEL = "opscrew-e2e=advise-ballast";

/** The share of the server's memory in use the ballast aims at: above `memoryHigh` (85%). */
export const BALLAST_TARGET = 0.92;

/** The share the pass waits for before advise reads the server: a margin over `memoryHigh`. */
export const BALLAST_REACHED = THRESHOLDS.memoryHigh + 0.03;

/** `MemTotal` and `MemAvailable` from `/proc/meminfo`, in kB. */
function meminfo(text: string): { totalKb: number; availableKb: number } {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    if (match?.[1] === undefined) throw new Error(`/proc/meminfo has no ${name} line.`);
    return Number(match[1]);
  };
  return { totalKb: field("MemTotal"), availableKb: field("MemAvailable") };
}

/** The share of the server's memory in use, as `status` reads it (total less available). */
export function memoryShare(text: string): number {
  const { totalKb, availableKb } = meminfo(text);
  return (totalKb - availableKb) / totalKb;
}

/**
 * The MiB the ballast allocates so the memory in use reaches {@link BALLAST_TARGET} of the server,
 * from its `/proc/meminfo` now. Throws when there is too little room left to add a ballast.
 */
export function ballastMb(text: string): number {
  const { totalKb, availableKb } = meminfo(text);
  const mb = Math.floor((availableKb - (1 - BALLAST_TARGET) * totalKb) / 1024);
  if (mb < 256) {
    throw new Error(
      `The server has ${Math.round(availableKb / 1024)} MiB available of ${Math.round(totalKb / 1024)} MiB: too little to add a ballast.`,
    );
  }
  return mb;
}

/**
 * Starts the ballast as the deploy user: a detached container of `image` with
 * {@link BALLAST_LABEL} and no restart policy (so it is gone after the server restarts), whose
 * Node.js allocates and touches `mb` MiB, then only holds it.
 */
export function ballastCommand(mb: number, image: string): string {
  const script = [
    "const held = [];",
    "for (let i = 0; i < Number(process.env.BALLAST_MB); i++) held.push(Buffer.alloc(1048576, 1));",
    "setInterval(() => held.length, 60000);",
  ].join(" ");
  return [
    "docker run -d --restart no",
    `--label ${BALLAST_LABEL}`,
    `-e BALLAST_MB=${mb}`,
    image,
    `node -e '${script}'`,
  ].join(" ");
}

/** Lists the running ballast containers' ids (none: an empty output). */
export const BALLAST_RUNNING = `docker ps -q --filter label=${BALLAST_LABEL}`;

const ReportSchema = z.object({
  proposals: z.array(ProposalSchema),
  basis: z.record(z.string(), z.object({ kind: z.string() }).passthrough()),
  checked: z.array(z.string()),
  notRead: z.array(z.string()),
});

/** `opscrew advise --json`'s report, checked; throws without printing it when it isn't one. */
export function adviceReport(stdout: string): AdviceReport {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Never rethrown with the text: the message would quote it.
    throw new Error("opscrew advise --json printed no JSON on stdout.");
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `opscrew advise --json printed a report that doesn't match ProposalSchema: ${parsed.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  }
  return parsed.data as AdviceReport;
}

const roundCents = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;

/**
 * A server's monthly net price on `offer` from the provider's live price list, as OpsCrew prices a
 * server: the type, the primary IPv4 address, and with `backups` the provider's backup percentage
 * of the type's price. Throws when the list lacks a figure the price needs.
 */
export function expectedMonthly(
  offer: Pick<ComputeOffer, "monthly">,
  extras: Pick<ProviderExtras, "ipv4Monthly" | "backupPercent">,
  backups: boolean,
): number {
  const server = roundCents(offer.monthly.amount);
  if (backups && extras.backupPercent === undefined) {
    throw new Error("The live price list gives no backup percentage.");
  }
  const backupPrice = backups ? roundCents((server * (extras.backupPercent ?? 0)) / 100) : 0;
  return roundCents(server + (extras.ipv4Monthly?.amount ?? 0) + backupPrice);
}

/**
 * The audit lines added since `before` (each file's line count then), from `after` (each file's
 * lines now), in file order.
 */
export function newAuditLines(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, readonly string[]>,
): string[] {
  return [...after].flatMap(([file, lines]) => lines.slice(before.get(file) ?? 0));
}

/**
 * The audit lines that aren't reads, each as `<kind>: <action>`: a read is a `remote-exec` or
 * `provider-call` entry whose action says it is read-only, as every one advise makes does.
 */
export function notReads(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    let entry: { kind?: unknown; action?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      return ["an audit line that isn't JSON"];
    }
    const action = typeof entry.action === "string" ? entry.action : "";
    const read =
      (entry.kind === "remote-exec" || entry.kind === "provider-call") &&
      action.endsWith("(read-only)");
    return read ? [] : [`${String(entry.kind)}: ${action}`];
  });
}

/**
 * The `notRead` lines the pass doesn't expect. Expected: DigitalOcean's live prices without its
 * token (the run gives OpsCrew none; the cost rule compares with its dated list), and the
 * Cloudflare token's expiry, which an account-owned token doesn't give.
 */
export function unexpectedNotRead(lines: readonly string[]): string[] {
  return lines.filter(
    (line) =>
      !(line.startsWith("live prices: ") && line.includes("DIGITALOCEAN")) &&
      line !== "the Cloudflare token's expiry: Cloudflare gives none for an account-owned token",
  );
}

/** The headings `opscrew advise` groups its proposals under, by urgency. */
export const URGENCY_HEADINGS: Record<Proposal["urgency"], string> = {
  now: "Now:",
  soon: "Soon:",
  "when-convenient": "When convenient:",
};

/**
 * The heading `[id]` sits under in `opscrew advise`'s text: the nearest heading line before it;
 * `undefined` when the text doesn't show the id, or shows it under none.
 */
export function headingOf(text: string, id: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes(`[${id}]`));
  if (at < 0) return undefined;
  const headings = new Set(Object.values(URGENCY_HEADINGS));
  return lines
    .slice(0, at)
    .reverse()
    .find((line) => headings.has(line.trim()))
    ?.trim();
}

/** True when a token expiring at `expiresAt` (ISO 8601) is due a proposal at `now`. */
export function tokenDue(expiresAt: string | undefined, now: Date): boolean {
  if (expiresAt === undefined) return false;
  return (Date.parse(expiresAt) - now.getTime()) / 86_400_000 <= THRESHOLDS.tokenDays;
}
