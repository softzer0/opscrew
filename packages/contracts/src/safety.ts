import type { IsoDateTime, Money, Severity } from "./common";
import type { PhaseName, ToolProfile } from "./runtime";

// ---------------------------------------------------------------------------------------------
// Tool policy: decides whether an agent's tool call may run. Enforced in every permission mode.
// ---------------------------------------------------------------------------------------------

export interface ToolCall {
  /** Tool name as the runtime reports it, for example `Read`, `Bash`, `StructuredOutput`. */
  tool: string;
  input: Record<string, unknown>;
  phase: PhaseName;
  profile: ToolProfile;
  /** Absolute project root; file access outside it is denied. */
  projectRoot: string;
}

export type ToolDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  /** Needs a human decision. Interactive runs ask via the approval gate; others deny. */
  | { decision: "ask"; reason: string };

export interface ToolPolicy {
  evaluate(call: ToolCall): ToolDecision;
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

export type ApprovalKind =
  | "iac-apply"
  | "repo-write"
  | "git-push"
  | "pull-request"
  | "github-secrets"
  | "remote-exec"
  | "tool-call"
  /** Buying a domain: costs money, cannot be refunded; always typed, never granted by `--yes`. */
  | "domain-purchase"
  /** Changing a registered domain's settings (auto-renew). */
  | "domain-settings"
  /** Applying a host plan to a server the user owns; bound to the host plan's SHA-256 hash. */
  | "host-apply"
  /**
   * Applying a stack plan to a Portainer the user runs (stacks, registry entry, volumes); bound to
   * the stack plan's SHA-256 hash, never granted by `--yes`.
   */
  | "stack-apply"
  /**
   * Applying a shared Cloudflare plan (OpsCrew's rules in a zone, the Zero Trust organization and
   * one-time-PIN identity provider); bound to the plan's SHA-256 hash, never granted by `--yes`.
   */
  | "cloudflare-apply";

export interface PolicyResult {
  policyId: string;
  title: string;
  severity: Severity;
  passed: boolean;
  /** Plain-English explanation; for failures it says what to change. */
  message: string;
  /** Resource address or file the result refers to. */
  resource?: string;
}

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** One line, plain English, for example "Create 4 resources on Hetzner Cloud". */
  title: string;
  /** Multi-line summary shown before asking (diff summary, resources, cost). Redacted. */
  details: string;
  /**
   * SHA-256 hex of the plan file. Required for `iac-apply`, `host-apply`, `stack-apply` and
   * `cloudflare-apply`.
   */
  planHash?: string;
  /** True when the change deletes or replaces anything. Requires `confirmPhrase`. */
  allowDestroy?: boolean;
  /** When set, the user must type exactly this phrase to approve. */
  confirmPhrase?: string;
  /** Change in monthly cost, when known. */
  costDelta?: Money;
  policy?: PolicyResult[];
}

export interface ApprovalDecision {
  approved: boolean;
  /** Who decided, for example the git user name or `--approve flag`. */
  approver: string;
  decidedAt: IsoDateTime;
  /** What the user typed when a confirmation phrase was requested. */
  confirmation?: string;
  reason?: string;
}

/** Asks a human. The CLI implements it with terminal prompts; MCP mode with elicitation. */
export interface ApprovalHandler {
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  title: string;
  planHash?: string;
  allowDestroy?: boolean;
  approved: boolean;
  approver: string;
  decidedAt: IsoDateTime;
  reason?: string;
}

export interface ApprovalStore {
  append(record: ApprovalRecord): Promise<void>;
  list(): Promise<ApprovalRecord[]>;
}

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

export type AuditKind =
  | "phase"
  | "tool-call"
  | "tool-denied"
  | "approval"
  | "iac"
  | "provider-call"
  | "git"
  | "secret-set"
  | "remote-exec";

export interface AuditEntry {
  at: IsoDateTime;
  kind: AuditKind;
  actor: "agent" | "user" | "opscrew";
  /** What happened, for example `apply`, `Bash`, `set secret OPSCREW_HOST`. */
  action: string;
  phase?: PhaseName;
  sessionId?: string;
  /** Resource, file, repository or host affected. */
  target?: string;
  decision?: "allow" | "deny" | "ask" | "approved" | "refused";
  /** Free text; redacted before it is written. */
  detail?: string;
}

export type AuditInput = Omit<AuditEntry, "at"> & { at?: IsoDateTime };

/** Append-only, redacting audit log. */
export interface AuditLog {
  append(entry: AuditInput): Promise<void>;
}
