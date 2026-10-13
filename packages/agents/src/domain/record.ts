import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Money, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import { DASHBOARD, formatDate } from "./common";
import { buyCommandOf, registrarDashboard } from "./links";

/**
 * Local note that a purchase was sent (or is about to be), written before `register` and removed
 * once the domain is set up. Together with the live registration status (and, where the registrar
 * takes one, the idempotency key) it makes sure a purchase is never sent twice. Holds no contact
 * data.
 */
export interface PurchaseRecord {
  domain: string;
  /** The Cloudflare account the domain's zone lives in. */
  accountId: string;
  requestedAt: string;
  years?: number;
  autoRenew?: boolean;
  total?: Money;
  /** Where the domain is bought; absent means Cloudflare (records written before feature 007). */
  registrar?: RegistrarId;
  /**
   * Created once, with the record, and sent with the purchase by registrars that take one
   * (Porkbun, GoDaddy); kept unchanged on every resumed run.
   */
  idempotencyKey?: string;
  /**
   * `uncertain` once `register` failed without a clear answer: the purchase may have started, so
   * the note is only cleared by the user (`forgetPendingPurchase`). `accepted` once the registrar
   * answered that it is working on the order (`pending`/`in_progress`): never cleared on its own
   * either, because a registrar may list such an order only hours later (Namecheap). Absent while
   * the request is being sent (or when the run stopped before or during it).
   */
  outcome?: "uncertain" | "accepted";
}

/** Wall-clock age after which a note without an outcome may be cleared (see `buyDomain`). */
export const UNSENT_PURCHASE_AGE_MS = 30 * 60_000;

const PurchaseRecordSchema = z.object({
  domain: z.string().min(1),
  accountId: z.string().min(1),
  requestedAt: z.string().min(1),
  years: z.number().int().min(1).max(10).optional(),
  autoRenew: z.boolean().optional(),
  total: z.object({ amount: z.number(), currency: z.enum(["EUR", "USD"]) }).optional(),
  registrar: z.enum(["cloudflare", "porkbun", "namecheap", "godaddy"]).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  outcome: z.enum(["uncertain", "accepted"]).optional(),
});

/** `<projectHome>/domain-purchase.json`. */
export function purchaseRecordPath(paths: ProjectPaths): string {
  return join(paths.projectHomeDir, "domain-purchase.json");
}

/** The registrar a record's purchase was sent to (Cloudflare for records without one). */
export function recordRegistrar(record: PurchaseRecord): RegistrarId {
  return record.registrar ?? "cloudflare";
}

/**
 * The record, or undefined when there is none. An unreadable record stops the run: OpsCrew cannot
 * tell whether a purchase is under way.
 */
export async function readPurchaseRecord(file: string): Promise<PurchaseRecord | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const parsed = PurchaseRecordSchema.safeParse(data);
  if (!parsed.success) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot read its note about an earlier domain purchase (${file}).`,
      {
        hint: `Check ${DASHBOARD} (or the dashboard of the registrar you were buying at) and its billing for a purchase that did not finish. Only then delete that file and run the command again; OpsCrew checks the registrar before it buys anything.`,
      },
    );
  }
  const { years, autoRenew, total, registrar, idempotencyKey, outcome, ...required } = parsed.data;
  return {
    ...required,
    ...(years === undefined ? {} : { years }),
    ...(autoRenew === undefined ? {} : { autoRenew }),
    ...(total === undefined ? {} : { total }),
    ...(registrar === undefined ? {} : { registrar }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/**
 * Creates the record, failing when one exists already (another run is buying at the same time),
 * so two runs can never both go on to `register`.
 */
export async function createPurchaseRecord(file: string, record: PurchaseRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Another OpsCrew run started buying a domain at the same time, so this run did not buy ${record.domain}.`,
      {
        hint: `Wait for it to finish, then run \`${buyCommandOf(record.domain, recordRegistrar(record))}\` again.`,
      },
    );
  }
}

/** Marks the record `uncertain`: only the user may clear it from now on. */
export async function markPurchaseUncertain(file: string, record: PurchaseRecord): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify({ ...record, outcome: "uncertain" }, null, 2)}\n`);
}

/** Marks the record `accepted` (the registrar is working on the order): never cleared on its own. */
export async function markPurchaseAccepted(file: string, record: PurchaseRecord): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify({ ...record, outcome: "accepted" }, null, 2)}\n`);
}

export async function removePurchaseRecord(file: string): Promise<void> {
  await rm(file, { force: true });
}

/**
 * Stops because an earlier run's purchase of another domain has not finished. `requested` is the
 * registrar the user asked to buy `domain` at (named in the commands of the hint).
 */
export function otherPurchaseInProgress(
  record: PurchaseRecord,
  domain: string,
  options: { requested?: RegistrarId; env?: Record<string, string | undefined> } = {},
): OpsCrewError {
  const at = recordRegistrar(record);
  const buy = buyCommandOf(domain, options.requested ?? "cloudflare");
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `An earlier OpsCrew run started buying ${record.domain} on ${formatDate(record.requestedAt, record.requestedAt)} and did not finish, so OpsCrew did not buy ${domain}.`,
    {
      hint: `OpsCrew buys one domain at a time. Run \`${buyCommandOf(record.domain, at)}\` to finish that purchase first. If ${registrarDashboard(at, options.env)} does not list ${record.domain} and you were not charged for it, run \`opscrew domain buy ${domain} --forget-pending-purchase\` to clear OpsCrew's note about it (that run buys nothing), then run \`${buy}\` to buy ${domain}.`,
    },
  );
}
