import type {
  ApprovalHandler,
  Clock,
  CommandRunner,
  FetchLike,
  Reporter,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  CostLedger,
  JsonlApprovalStore,
  JsonlAuditLog,
  ProjectStateStore,
  type Redactor,
  resolveProjectPaths,
} from "@opscrew/core";
import type { PhaseDeps } from "../context";

/** What {@link buildPhaseDeps} builds the phase's collaborators from. */
export interface PhaseDepsInput {
  /** Absolute project directory. */
  root: string;
  env: Record<string, string | undefined>;
  /** Home directory for `~/.opscrew` when `OPSCREW_HOME` is not set (default: the OS's). */
  homedir?: string;
  /**
   * The app's environment the phase acts on (`resolveEnvironment`'s answer); absent or `prod`:
   * prod's paths, as before environments.
   */
  environment?: string;
  reporter: Reporter;
  redactor: Redactor;
  /** Answers every approval request of the run. */
  approvalHandler: ApprovalHandler;
  runner: CommandRunner;
  fetch: FetchLike;
  clock: Clock;
  interactive: boolean;
  version: string;
}

/**
 * The {@link PhaseDeps} of one CLI command or MCP tool call: the paths of the project's
 * `environment` (prod's by default), the approval gate in front of `approvalHandler`, and that
 * environment's file-backed approvals, state and cost ledger, with the user's audit log. No model
 * runtime: the CLI adds one when a model may run.
 */
export function buildPhaseDeps(input: PhaseDepsInput): PhaseDeps {
  const { env, clock, redactor } = input;
  const paths = resolveProjectPaths(input.root, {
    env,
    ...(input.homedir === undefined ? {} : { homedir: input.homedir }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  const audit = new JsonlAuditLog({ dir: paths.auditDir, redact: redactor.redact, clock });
  return {
    paths,
    reporter: input.reporter,
    approvals: new ApprovalGate({
      handler: input.approvalHandler,
      store: new JsonlApprovalStore(paths.files.approvals),
      audit,
      clock,
    }),
    audit,
    state: new ProjectStateStore(paths.files.state, clock),
    costs: new CostLedger(paths.files.costs, clock),
    runner: input.runner,
    fetch: input.fetch,
    env,
    clock,
    redactor,
    interactive: input.interactive,
    version: input.version,
  };
}
