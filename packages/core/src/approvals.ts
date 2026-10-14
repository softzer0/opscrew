import { randomUUID } from "node:crypto";
import type {
  ApprovalHandler,
  ApprovalKind,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  AuditLog,
  Clock,
} from "@opscrew/contracts";
import { z } from "zod";
import { appendJsonLine, readJsonLines } from "./audit";
import { OpsCrewError } from "./errors";

const PLAN_HASH_RE = /^[0-9a-f]{64}$/i;

/** True when `value` is a SHA-256 hex digest (64 hex characters, either case). */
export function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && PLAN_HASH_RE.test(value);
}

const APPROVAL_KINDS = [
  "iac-apply",
  "repo-write",
  "git-push",
  "pull-request",
  "github-secrets",
  "remote-exec",
  "tool-call",
  "domain-purchase",
  "domain-settings",
  "host-apply",
] as const satisfies readonly ApprovalKind[];

const approvalRecordSchema: z.ZodType<ApprovalRecord> = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  title: z.string(),
  planHash: z.string().optional(),
  allowDestroy: z.boolean().optional(),
  approved: z.boolean(),
  approver: z.string(),
  decidedAt: z.string(),
  reason: z.string().optional(),
});

/** Latest approved record of `kind` whose plan hash equals `planHash` (case-insensitive). */
function latestApproved(
  records: readonly ApprovalRecord[],
  kind: "iac-apply" | "host-apply",
  planHash: string,
): ApprovalRecord | undefined {
  const wanted = planHash.toLowerCase();
  return records.findLast(
    (r) => r.approved && r.kind === kind && r.planHash?.toLowerCase() === wanted,
  );
}

/** Latest approved `iac-apply` record whose plan hash equals `planHash` (case-insensitive). */
function latestApprovedPlan(
  records: readonly ApprovalRecord[],
  planHash: string,
): ApprovalRecord | undefined {
  return latestApproved(records, "iac-apply", planHash);
}

/**
 * Returns the latest approved `host-apply` record for `planHash` (the SHA-256 of a host plan,
 * matched case-insensitively), or throws: `PLAN_NOT_APPROVED` when no approval exists for this
 * exact hash (an `iac-apply` approval with the same hash does not count), `DESTROY_NOT_APPROVED`
 * when `allowDestroy` is required (a teardown that deletes app data) but the approval did not grant
 * it. Call before every host apply; the {@link ApprovalGate} method of the same name also audits
 * the refusal.
 */
export async function assertApprovedHostPlan(
  store: ApprovalStore,
  planHash: string,
  options: { allowDestroy?: boolean } = {},
): Promise<ApprovalRecord> {
  const record = isPlanHash(planHash)
    ? latestApproved(await store.list(), "host-apply", planHash)
    : undefined;
  if (record === undefined) {
    throw new OpsCrewError(
      "PLAN_NOT_APPROVED",
      "This host plan has not been approved, so OpsCrew will not change the server.",
      {
        hint: `Review the host plan, then approve it when asked or re-run with --approve ${planHash}.`,
      },
    );
  }
  if (options.allowDestroy === true && record.allowDestroy !== true) {
    throw new OpsCrewError(
      "DESTROY_NOT_APPROVED",
      "This host plan deletes the app's data on the server, but the approval did not allow deleting it.",
      {
        hint: "Run the command interactively and type the confirmation phrase to approve deleting the data.",
      },
    );
  }
  return record;
}

/** Approval store backed by a JSONL file (normally `.opscrew/approvals.jsonl`). */
export class JsonlApprovalStore implements ApprovalStore {
  /** Warnings about skipped (corrupt or malformed) lines from the most recent read. */
  warnings: string[] = [];

  constructor(private readonly file: string) {}

  async append(record: ApprovalRecord): Promise<void> {
    await appendJsonLine(this.file, record);
  }

  async list(): Promise<ApprovalRecord[]> {
    const { values, warnings } = await readJsonLines(this.file, approvalRecordSchema);
    this.warnings = warnings;
    return values;
  }

  async findApprovedPlan(planHash: string): Promise<ApprovalRecord | undefined> {
    return latestApprovedPlan(await this.list(), planHash);
  }
}

/** In-memory approval store for tests. */
export class MemoryApprovalStore implements ApprovalStore {
  readonly records: ApprovalRecord[] = [];

  async append(record: ApprovalRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async list(): Promise<ApprovalRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }

  async findApprovedPlan(planHash: string): Promise<ApprovalRecord | undefined> {
    const found = latestApprovedPlan(this.records, planHash);
    return found && { ...found };
  }
}

export interface ApprovalGateOptions {
  /** Asks the human (terminal prompts in the CLI, elicitation in MCP mode). */
  handler: ApprovalHandler;
  store: ApprovalStore;
  audit: AuditLog;
  clock?: Clock;
  /** Record id generator; defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

const PHRASE_MISMATCH = "confirmation phrase did not match";

/**
 * The single place where humans approve mutations (constitution I). Every decision, approved or
 * not, is written to the approval store and the audit log; `iac-apply` and `host-apply` approvals
 * are bound to the plan's SHA-256 hash and destroys need `allowDestroy` plus the exact typed
 * confirmation phrase.
 */
export class ApprovalGate {
  private readonly handler: ApprovalHandler;
  private readonly store: ApprovalStore;
  private readonly audit: AuditLog;
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(options: ApprovalGateOptions) {
    this.handler = options.handler;
    this.store = options.store;
    this.audit = options.audit;
    this.clock = options.clock ?? { now: () => new Date() };
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Validates the request, asks the handler and records the decision. Throws
   * `OpsCrewError("INVALID_INPUT")` for an `iac-apply` or `host-apply` without a valid plan hash, an
   * `allowDestroy`, `domain-purchase` or `domain-settings` request without a confirmation phrase.
   * A refusal is returned, not thrown.
   */
  async request(request: ApprovalRequest): Promise<ApprovalRecord> {
    validateRequest(request);

    const decision = await this.handler.request(request);
    let approved = decision.approved === true;
    let reason = decision.reason;
    if (approved && request.confirmPhrase !== undefined) {
      if ((decision.confirmation ?? "").trim() !== request.confirmPhrase) {
        approved = false;
        reason = PHRASE_MISMATCH;
      }
    }

    const record: ApprovalRecord = {
      id: this.newId(),
      kind: request.kind,
      title: request.title,
      approved,
      approver: decision.approver,
      decidedAt: decision.decidedAt || this.clock.now().toISOString(),
    };
    if (request.planHash !== undefined) record.planHash = request.planHash.toLowerCase();
    if (request.allowDestroy === true) record.allowDestroy = true;
    if (reason !== undefined) record.reason = reason;

    await this.store.append(record);
    await this.audit.append({
      at: this.clock.now().toISOString(),
      kind: "approval",
      actor: "user",
      action: request.kind,
      ...(record.planHash === undefined ? {} : { target: record.planHash }),
      decision: approved ? "approved" : "refused",
      detail: `${request.title} (by ${record.approver}${reason === undefined ? "" : `: ${reason}`})`,
    });
    return record;
  }

  /**
   * Returns the approved `iac-apply` record for `planHash`, or throws (and audits the refusal):
   * `PLAN_NOT_APPROVED` when no approval exists for this exact hash, `DESTROY_NOT_APPROVED` when
   * `allowDestroy` is required but the approval did not grant it. Call before every apply.
   */
  async assertApprovedPlan(
    planHash: string,
    options: { allowDestroy?: boolean } = {},
  ): Promise<ApprovalRecord> {
    const record = isPlanHash(planHash) ? await this.store.findApprovedPlan(planHash) : undefined;
    if (record === undefined) {
      await this.auditRefusal("iac-apply", planHash, "no approval recorded for this plan hash");
      throw new OpsCrewError(
        "PLAN_NOT_APPROVED",
        "This plan has not been approved, so OpsCrew will not apply it.",
        {
          hint: `Review the plan, then approve it when asked or re-run with --approve ${planHash}.`,
        },
      );
    }
    if (options.allowDestroy === true && record.allowDestroy !== true) {
      await this.auditRefusal(
        "iac-apply",
        planHash,
        "plan deletes or replaces resources; destroy not approved",
      );
      throw new OpsCrewError(
        "DESTROY_NOT_APPROVED",
        "This plan deletes or replaces resources, but the approval did not allow destructive changes.",
        {
          hint: "Run the command interactively and type the confirmation phrase to approve the destroy.",
        },
      );
    }
    return record;
  }

  /**
   * Returns the approved `host-apply` record for the host plan hash `planHash`, or audits the
   * refusal and throws `PLAN_NOT_APPROVED` or `DESTROY_NOT_APPROVED` (see
   * {@link assertApprovedHostPlan}). Call before every host apply.
   */
  async assertApprovedHostPlan(
    planHash: string,
    options: { allowDestroy?: boolean } = {},
  ): Promise<ApprovalRecord> {
    try {
      return await assertApprovedHostPlan(this.store, planHash, options);
    } catch (error) {
      if (error instanceof OpsCrewError && error.code === "PLAN_NOT_APPROVED") {
        await this.auditRefusal("host-apply", planHash, "no approval recorded for this host plan");
      } else if (error instanceof OpsCrewError && error.code === "DESTROY_NOT_APPROVED") {
        await this.auditRefusal(
          "host-apply",
          planHash,
          "host plan deletes app data; deleting it was not approved",
        );
      }
      throw error;
    }
  }

  private async auditRefusal(
    action: "iac-apply" | "host-apply",
    planHash: string,
    detail: string,
  ): Promise<void> {
    await this.audit.append({
      at: this.clock.now().toISOString(),
      kind: "approval",
      actor: "opscrew",
      action,
      target: isPlanHash(planHash) ? planHash.toLowerCase() : planHash,
      decision: "refused",
      detail,
    });
  }
}

function validateRequest(request: ApprovalRequest): void {
  if (request.kind === "iac-apply" && !isPlanHash(request.planHash)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "An infrastructure apply can only be approved for a specific plan, but no valid plan hash was given.",
      { hint: "Pass the plan's SHA-256 hash (64 hexadecimal characters) with the request." },
    );
  }
  if (request.kind === "host-apply" && !isPlanHash(request.planHash)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A change to a server can only be approved for a specific host plan, but no valid plan hash was given.",
      { hint: "Pass the host plan's SHA-256 hash (64 hexadecimal characters) with the request." },
    );
  }
  if (request.planHash !== undefined && !isPlanHash(request.planHash)) {
    throw new OpsCrewError("INVALID_INPUT", "The plan hash must be 64 hexadecimal characters.", {
      hint: "Use the SHA-256 hash printed with the plan.",
    });
  }
  if (request.allowDestroy === true && (request.confirmPhrase ?? "").trim() === "") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A destructive change needs a confirmation phrase that the user must type.",
      { hint: "Set confirmPhrase to the name of the affected resource." },
    );
  }
  if (
    (request.kind === "domain-purchase" || request.kind === "domain-settings") &&
    (request.confirmPhrase ?? "").trim() === ""
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A domain purchase or domain setting needs a confirmation phrase that the user must type.",
      { hint: "Set confirmPhrase to the domain name." },
    );
  }
}
