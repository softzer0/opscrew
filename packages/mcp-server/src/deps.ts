import { buildPhaseDeps, type PhaseDeps } from "@opscrew/agents";
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
import { approvalDecision, Redactor, registerEnvSecrets, systemClock } from "@opscrew/core";
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
   * Asks the human to approve a mutation: the deploy tools pass a dialog (elicitation) handler;
   * when absent, the default factory refuses every approval with a plain-English reason.
   */
  approvalHandler?: ApprovalHandler;
  /** The further app's key the call acts on (its `app` input, resolved); default the first app. */
  app?: string | undefined;
  /** The app's environment the call acts on (its `environment` input, resolved); default prod. */
  environment?: string;
}

/** Builds the `PhaseDeps` for one tool call on the project at `projectDir` (absolute). */
export type PhaseDepsFactory = (
  projectDir: string,
  extras: PhaseDepsExtras,
) => PhaseDeps | Promise<PhaseDeps>;

/**
 * Everything the OpsCrew MCP server needs from the outside world. Tests inject fakes; the real
 * process uses `startStdioServer`, which fills these from `process`.
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
}

/** {@link OpscrewMcpDeps} with every default filled in; what tool registrations receive. */
export interface ResolvedMcpDeps extends Required<Omit<OpscrewMcpDeps, "log">> {
  log: (message: string) => void;
}

/** Fills the defaults of {@link OpscrewMcpDeps}. */
export function resolveMcpDeps(deps: OpscrewMcpDeps): ResolvedMcpDeps {
  const redactor = deps.redactor ?? new Redactor();
  if (deps.redactor === undefined) registerEnvSecrets(redactor, deps.env);
  const clock = deps.clock ?? systemClock;
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
  };
  return {
    ...partial,
    createPhaseDeps: deps.createPhaseDeps ?? createDefaultPhaseDepsFactory(partial),
  };
}

/** Refuses every approval: a tool without a dialog for the user changes nothing. */
class RefusingApprovalHandler implements ApprovalHandler {
  constructor(private readonly clock: Clock) {}
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return approvalDecision(this.clock, "opscrew-mcp", false, {
      reason:
        "This OpsCrew MCP server cannot ask for approvals. Run the step with the opscrew CLI in a terminal.",
    });
  }
}

/**
 * The production `PhaseDeps` factory (see `buildPhaseDeps`): project paths (with `OPSCREW_HOME`
 * from `env`), file-backed state, cost ledger, approvals and audit log, the injected
 * fetch/runner/clock, no model runtime (the MCP server is deterministic) and `interactive: false`.
 */
function createDefaultPhaseDepsFactory(
  deps: Pick<ResolvedMcpDeps, "version" | "env" | "fetch" | "runner" | "clock">,
): PhaseDepsFactory {
  return (projectDir, extras) =>
    buildPhaseDeps({
      root: projectDir,
      env: deps.env,
      ...(extras.app === undefined ? {} : { app: extras.app }),
      ...(extras.environment === undefined ? {} : { environment: extras.environment }),
      reporter: extras.reporter,
      redactor: extras.redactor,
      approvalHandler: extras.approvalHandler ?? new RefusingApprovalHandler(deps.clock),
      runner: deps.runner,
      fetch: deps.fetch,
      clock: deps.clock,
      interactive: false,
      version: deps.version,
    });
}
