import type {
  AgentRuntime,
  AuditLog,
  Clock,
  CommandRunner,
  FetchLike,
  Reporter,
  StreamRunner,
} from "@opscrew/contracts";
import type {
  ApprovalGate,
  CostLedger,
  ProjectPaths,
  ProjectStateStore,
  Redactor,
} from "@opscrew/core";

/**
 * Everything a phase needs, injected by the CLI or the MCP server. Phases never reach for globals
 * (process.env, fetch, child_process, Date) directly — they use these. Lead-owned.
 */
export interface PhaseDeps {
  paths: ProjectPaths;
  reporter: Reporter;
  /** Present when a model is configured and allowed for this run (`--no-ai` leaves it unset). */
  runtime?: AgentRuntime;
  approvals: ApprovalGate;
  audit: AuditLog;
  state: ProjectStateStore;
  costs: CostLedger;
  runner: CommandRunner;
  /**
   * Starts a binary with its stdin and stdout as one stream (`ssh … docker system dial-stdio` for a
   * move's Docker API). Absent, a move uses core's `NodeStreamRunner`.
   */
  streams?: StreamRunner;
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  clock: Clock;
  redactor: Redactor;
  /** True when a human can answer prompts (TTY, not CI). */
  interactive: boolean;
  /** OpsCrew version, written into generated files and reports. */
  version: string;
}
