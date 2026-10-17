import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
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
import { systemClock } from "./time";

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
  "stack-apply",
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

/** Approval kinds bound to a plan's SHA-256 hash. */
type HashBoundKind = "iac-apply" | "host-apply" | "stack-apply";

interface Refusal {
  message: string;
  hint: string;
  /** Detail of the audit entry that records the refusal. */
  audit: string;
}

/** What each hash-bound kind says when a request has no hash or an apply is not approved. */
const HASH_BOUND: Record<
  HashBoundKind,
  {
    noHash: { message: string; hint: string };
    notApproved(planHash: string): Refusal;
    destroyNotApproved: Refusal;
  }
> = {
  "iac-apply": {
    noHash: {
      message:
        "An infrastructure apply can only be approved for a specific plan, but no valid plan hash was given.",
      hint: "Pass the plan's SHA-256 hash (64 hexadecimal characters) with the request.",
    },
    notApproved: (planHash) => ({
      message: "This plan has not been approved, so OpsCrew will not apply it.",
      hint: `Review the plan, then approve it when asked or re-run with --approve ${planHash}.`,
      audit: "no approval recorded for this plan hash",
    }),
    destroyNotApproved: {
      message:
        "This plan deletes or replaces resources, but the approval did not allow destructive changes.",
      hint: "Run the command interactively and type the confirmation phrase to approve the destroy.",
      audit: "plan deletes or replaces resources; destroy not approved",
    },
  },
  "host-apply": {
    noHash: {
      message:
        "A change to a server can only be approved for a specific host plan, but no valid plan hash was given.",
      hint: "Pass the host plan's SHA-256 hash (64 hexadecimal characters) with the request.",
    },
    notApproved: (planHash) => ({
      message: "This host plan has not been approved, so OpsCrew will not change the server.",
      hint: `Review the host plan, then approve it when asked or re-run with --approve ${planHash}.`,
      audit: "no approval recorded for this host plan",
    }),
    destroyNotApproved: {
      message:
        "This host plan deletes the app's data on the server, but the approval did not allow deleting it.",
      hint: "Run the command interactively and type the confirmation phrase to approve deleting the data.",
      audit: "host plan deletes app data; deleting it was not approved",
    },
  },
  "stack-apply": {
    noHash: {
      message:
        "A change in Portainer can only be approved for a specific stack plan, but no valid plan hash was given.",
      hint: "Pass the stack plan's SHA-256 hash (64 hexadecimal characters) with the request.",
    },
    notApproved: (planHash) => ({
      message:
        "This stack plan has not been approved, so OpsCrew will not change anything in Portainer.",
      hint: `Review the stack plan, then approve it when asked or re-run with --approve ${planHash}.`,
      audit: "no approval recorded for this stack plan",
    }),
    destroyNotApproved: {
      message:
        "This stack plan deletes the app's data in Portainer, but the approval did not allow deleting it.",
      hint: "Run the command interactively and type the confirmation phrase to approve deleting the data.",
      audit: "stack plan deletes app data; deleting it was not approved",
    },
  },
};

function isHashBound(kind: ApprovalKind): kind is HashBoundKind {
  return Object.hasOwn(HASH_BOUND, kind);
}

/** Approval store backed by a JSONL file (normally `.opscrew/approvals.jsonl`). */
export class JsonlApprovalStore implements ApprovalStore {
  constructor(private readonly file: string) {}

  async append(record: ApprovalRecord): Promise<void> {
    await appendJsonLine(this.file, record);
  }

  /** Every valid record in append order; corrupt or malformed lines are skipped. */
  list(): Promise<ApprovalRecord[]> {
    return readJsonLines(this.file, approvalRecordSchema);
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

/** The reason recorded when the typed confirmation was not the requested phrase. */
export const PHRASE_MISMATCH = "confirmation phrase did not match";
/** The reason recorded when the user cancelled the question (Ctrl+C, Escape). */
export const CANCELLED_BY_USER = "cancelled by the user";
/** The reason recorded when the user answered no. */
export const DECLINED_BY_USER = "declined by the user";

/**
 * A decision `approver` made now (by `clock`); `extra` adds the typed confirmation or the
 * reason for a refusal. The {@link ApprovalGate} still checks it against the request.
 */
export function approvalDecision(
  clock: Clock,
  approver: string,
  approved: boolean,
  extra: Pick<ApprovalDecision, "confirmation" | "reason"> = {},
): ApprovalDecision {
  return { approved, approver, decidedAt: clock.now().toISOString(), ...extra };
}

/**
 * The single place where humans approve mutations (constitution I). Every decision, approved or
 * not, is written to the approval store and the audit log; `iac-apply`, `host-apply` and
 * `stack-apply` approvals are bound to the plan's SHA-256 hash and destroys need `allowDestroy`
 * plus the exact typed confirmation phrase.
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
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Validates the request, asks the handler and records the decision. Throws
   * `OpsCrewError("INVALID_INPUT")` for an `iac-apply`, `host-apply` or `stack-apply` without a
   * valid plan hash, an `allowDestroy`, `domain-purchase` or `domain-settings` request without a
   * confirmation phrase. A refusal is returned, not thrown.
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
   * Returns the latest approved `iac-apply` record for `planHash` (matched case-insensitively), or
   * audits the refusal and throws: `PLAN_NOT_APPROVED` when no approval of this kind exists for
   * this exact hash, `DESTROY_NOT_APPROVED` when `allowDestroy` is required but the approval did
   * not grant it. Call before every apply.
   */
  assertApprovedPlan(
    planHash: string,
    options: { allowDestroy?: boolean } = {},
  ): Promise<ApprovalRecord> {
    return this.assertApproved("iac-apply", planHash, options);
  }

  /**
   * {@link assertApprovedPlan} for the `host-apply` approval of a host plan (`allowDestroy` for a
   * teardown that deletes the app's data). Call before every host apply.
   */
  assertApprovedHostPlan(
    planHash: string,
    options: { allowDestroy?: boolean } = {},
  ): Promise<ApprovalRecord> {
    return this.assertApproved("host-apply", planHash, options);
  }

  /**
   * {@link assertApprovedPlan} for the `stack-apply` approval of a Portainer stack plan
   * (`allowDestroy` for a teardown that deletes the app's data). Call before every stack apply.
   */
  assertApprovedStackPlan(
    planHash: string,
    options: { allowDestroy?: boolean } = {},
  ): Promise<ApprovalRecord> {
    return this.assertApproved("stack-apply", planHash, options);
  }

  private async assertApproved(
    kind: HashBoundKind,
    planHash: string,
    options: { allowDestroy?: boolean },
  ): Promise<ApprovalRecord> {
    const wanted = planHash.toLowerCase();
    const record = isPlanHash(planHash)
      ? (await this.store.list()).findLast(
          (r) => r.approved && r.kind === kind && r.planHash?.toLowerCase() === wanted,
        )
      : undefined;
    const rules = HASH_BOUND[kind];
    if (record === undefined) {
      throw await this.refusal("PLAN_NOT_APPROVED", kind, planHash, rules.notApproved(planHash));
    }
    if (options.allowDestroy === true && record.allowDestroy !== true) {
      throw await this.refusal("DESTROY_NOT_APPROVED", kind, planHash, rules.destroyNotApproved);
    }
    return record;
  }

  /** Audits the refusal of an apply and returns the error to throw. */
  private async refusal(
    code: "PLAN_NOT_APPROVED" | "DESTROY_NOT_APPROVED",
    kind: HashBoundKind,
    planHash: string,
    refusal: Refusal,
  ): Promise<OpsCrewError> {
    await this.audit.append({
      at: this.clock.now().toISOString(),
      kind: "approval",
      actor: "opscrew",
      action: kind,
      target: isPlanHash(planHash) ? planHash.toLowerCase() : planHash,
      decision: "refused",
      detail: refusal.audit,
    });
    return new OpsCrewError(code, refusal.message, { hint: refusal.hint });
  }
}

function validateRequest(request: ApprovalRequest): void {
  if (isHashBound(request.kind) && !isPlanHash(request.planHash)) {
    const { message, hint } = HASH_BOUND[request.kind].noHash;
    throw new OpsCrewError("INVALID_INPUT", message, { hint });
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
