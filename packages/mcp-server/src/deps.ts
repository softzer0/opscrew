import { tmpdir } from "node:os";
import type { PhaseDeps } from "@opscrew/agents";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  Clock,
  CommandRunner,
  FetchLike,
  Reporter,
  Scanner,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  CostLedger,
  JsonlApprovalStore,
  JsonlAuditLog,
  ProjectStateStore,
  Redactor,
  registerEnvSecrets,
  resolveProjectPaths,
} from "@opscrew/core";
import { defaultScanners } from "@opscrew/secops";

/** One message a phase reported while a tool ran. */
export interface ReportedMessage {
  level: "step" | "info" | "success" | "warn" | "error";
  message: string;
}

/**
 * Reporter that collects messages (redacted) so a tool can return them in its result instead of
 * printing them; stdout belongs to the MCP channel.
 */
export class CollectingReporter implements Reporter {
  readonly messages: ReportedMessage[] = [];
  constructor(private readonly redact: (text: string) => string) {}
  private push(level: ReportedMessage["level"], message: string) {
    this.messages.push({ level, message: this.redact(message) });
  }
  step(message: string) {
    this.push("step", message);
  }
  info(message: string) {
    this.push("info", message);
  }
  success(message: string) {
    this.push("success", message);
  }
  warn(message: string) {
    this.push("warn", message);
  }
  error(message: string) {
    this.push("error", message);
  }
}

/** Per-call additions the server hands to {@link PhaseDepsFactory}. */
export interface PhaseDepsExtras {
  /** Collects the phase's messages into the tool result. Use it as `PhaseDeps.reporter`. */
  reporter: Reporter;
  /** The server's redactor (env secrets registered). Use it as `PhaseDeps.redactor`. */
  redactor: Redactor;
  /**
   * Asks the human to approve a mutation. Deploy tools (002/T212) pass an elicitation-based
   * handler; when absent, the default factory refuses every approval with a plain-English reason.
   */
  approvalHandler?: ApprovalHandler;
}

/** Builds the `PhaseDeps` for one tool call on the project at `projectDir` (absolute). */
export type PhaseDepsFactory = (
  projectDir: string,
  extras: PhaseDepsExtras,
) => PhaseDeps | Promise<PhaseDeps>;

/**
 * Everything the OpsCrew MCP server needs from the outside world. Tests inject fakes; the real
 * process uses {@link startStdioServer}, which fills these from `process`.
 */
export interface OpscrewMcpDeps {
  /** OpsCrew version: reported to the client and written into reports and plans. */
  version: string;
  /** Environment (for example `HCLOUD_TOKEN`, `DIGITALOCEAN_TOKEN`, `OPSCREW_HOME`). Secret values are redacted. */
  env: Record<string, string | undefined>;
  /** HTTP client for opt-in lookups (OSV, live provider prices). */
  fetch: FetchLike;
  /** Runs optional external scanners (gitleaks, osv-scanner, trivy). */
  runner: CommandRunner;
  /** Clock for timestamps (default: system time). */
  clock?: Clock;
  /** Absolute default project directory for calls that omit `projectDir`. */
  cwd: string;
  /** Builds `PhaseDeps` per call (default: {@link createDefaultPhaseDepsFactory}). */
  createPhaseDeps?: PhaseDepsFactory;
  /** Scanners `opscrew_scan` runs (default: `defaultScanners()` from `@opscrew/secops`). */
  scanners?: () => readonly Scanner[];
  /** Redactor for every output (default: a new one with the env secrets registered). */
  redactor?: Redactor;
  /** Diagnostics sink; never stdout (default: discard). `startStdioServer` writes to stderr. */
  log?: (message: string) => void;
  /** Directory for scratch files (default: `os.tmpdir()`). */
  tmpDir?: string;
}

/** {@link OpscrewMcpDeps} with every default filled in; what tool registrations receive. */
export interface ResolvedMcpDeps extends Required<Omit<OpscrewMcpDeps, "log">> {
  log: (message: string) => void;
}

/** Fills the defaults of {@link OpscrewMcpDeps}. */
export function resolveMcpDeps(deps: OpscrewMcpDeps): ResolvedMcpDeps {
  const redactor = deps.redactor ?? new Redactor();
  if (deps.redactor === undefined) registerEnvSecrets(redactor, deps.env);
  const clock = deps.clock ?? { now: () => new Date() };
  const partial = {
    version: deps.version,
    env: deps.env,
    fetch: deps.fetch,
    runner: deps.runner,
    clock,
    cwd: deps.cwd,
    scanners: deps.scanners ?? (() => defaultScanners()),
    redactor,
    log: (message: string) => deps.log?.(redactor.redact(message)),
    tmpDir: deps.tmpDir ?? tmpdir(),
  };
  return {
    ...partial,
    createPhaseDeps: deps.createPhaseDeps ?? createDefaultPhaseDepsFactory(partial),
  };
}

/** Refuses every approval: planning tools never mutate, and MCP approvals arrive with 002/T212. */
export class RefusingApprovalHandler implements ApprovalHandler {
  constructor(private readonly clock: Clock) {}
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      approved: false,
      approver: "opscrew-mcp",
      decidedAt: this.clock.now().toISOString(),
      reason:
        "This OpsCrew MCP server cannot ask for approvals. Run the step with the opscrew CLI in a terminal.",
    };
  }
}

/**
 * The production `PhaseDeps` factory: project paths (with `OPSCREW_HOME` from `env`), file-backed
 * state, cost ledger, approvals and audit log, the injected fetch/runner/clock, no model runtime
 * (the MCP server is deterministic) and `interactive: false`.
 */
export function createDefaultPhaseDepsFactory(
  deps: Pick<ResolvedMcpDeps, "version" | "env" | "fetch" | "runner" | "clock">,
): PhaseDepsFactory {
  return (projectDir, extras) => {
    const paths = resolveProjectPaths(projectDir, { env: deps.env });
    const audit = new JsonlAuditLog({
      dir: paths.auditDir,
      redact: extras.redactor.redact,
      clock: deps.clock,
    });
    return {
      paths,
      reporter: extras.reporter,
      approvals: new ApprovalGate({
        handler: extras.approvalHandler ?? new RefusingApprovalHandler(deps.clock),
        store: new JsonlApprovalStore(paths.files.approvals),
        audit,
        clock: deps.clock,
      }),
      audit,
      state: new ProjectStateStore(paths.files.state, deps.clock),
      costs: new CostLedger(paths.files.costs, deps.clock),
      runner: deps.runner,
      fetch: deps.fetch,
      env: deps.env,
      clock: deps.clock,
      redactor: extras.redactor,
      interactive: false,
      version: deps.version,
    };
  };
}
