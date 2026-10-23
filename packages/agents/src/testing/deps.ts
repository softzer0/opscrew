import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CommandOptions,
  CommandResult,
  CommandRunner,
  FetchLike,
  Reporter,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  CostLedger,
  MemoryApprovalStore,
  MemoryAuditLog,
  ProjectStateStore,
  Redactor,
  resolveProjectPaths,
} from "@opscrew/core";
import type { PhaseDeps } from "../context";

/** Approval handler for tests: answers from a queue (or a function) and records every request. */
export class ScriptedApprovalHandler implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  constructor(
    private readonly answer:
      | boolean[]
      | ((
          request: ApprovalRequest,
        ) => boolean | { approved: boolean; confirmation?: string }) = () => true,
  ) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    const raw = Array.isArray(this.answer) ? (this.answer.shift() ?? false) : this.answer(request);
    const decision = typeof raw === "boolean" ? { approved: raw } : raw;
    return {
      approved: decision.approved,
      approver: "test-user",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...(decision.confirmation !== undefined
        ? { confirmation: decision.confirmation }
        : decision.approved && request.confirmPhrase !== undefined
          ? { confirmation: request.confirmPhrase }
          : {}),
    };
  }
}

/** Reporter for tests: collects every message by level. */
export class MemoryReporter implements Reporter {
  readonly lines: { level: "step" | "info" | "success" | "warn" | "error"; message: string }[] = [];
  step(message: string) {
    this.lines.push({ level: "step", message });
  }
  info(message: string) {
    this.lines.push({ level: "info", message });
  }
  success(message: string) {
    this.lines.push({ level: "success", message });
  }
  warn(message: string) {
    this.lines.push({ level: "warn", message });
  }
  error(message: string) {
    this.lines.push({ level: "error", message });
  }
  text(): string {
    return this.lines.map((l) => `${l.level}: ${l.message}`).join("\n");
  }
}

/** Command runner for tests: scripted results keyed by `command args…` prefix, records calls. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: { command: string; args: string[]; options?: CommandOptions }[] = [];
  constructor(
    private readonly script: (
      command: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => CommandResult | Promise<CommandResult> = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  ) {}
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    this.calls.push({ command, args: [...args], ...(options ? { options } : {}) });
    return this.script(command, args, options);
  }
}

/** A `fetch` that fails loudly unless a test supplies one; phases must never hit the network. */
export const forbiddenFetch: FetchLike = async (input) => {
  throw new Error(`Unexpected network call in a test: ${String(input)}`);
};

export interface TestPhaseDepsOptions extends Partial<Omit<PhaseDeps, "paths" | "approvals">> {
  /** Project root; a fresh temp dir when omitted. */
  root?: string;
  /** The further app the paths belong to (default: the repository's first app). */
  app?: string;
  /** The app's environment the paths belong to (default prod). */
  environment?: string;
  approvalHandler?: ApprovalHandler;
}

export interface TestPhaseDeps extends PhaseDeps {
  reporter: MemoryReporter;
  audit: MemoryAuditLog;
  approvalHandler: ApprovalHandler;
}

/**
 * Builds `PhaseDeps` for tests: temp project root with `OPSCREW_HOME` inside it, in-memory audit and
 * approval stores, file-backed state/costs under `.opscrew/`, scripted approvals (approve all by
 * default), a runner that succeeds with empty output, a fetch that throws, a fixed clock.
 */
export async function createTestPhaseDeps(
  options: TestPhaseDepsOptions = {},
): Promise<TestPhaseDeps> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "opscrew-test-")));
  const env = options.env ?? { OPSCREW_HOME: join(root, ".home-opscrew") };
  const paths = resolveProjectPaths(root, {
    env,
    app: options.app,
    environment: options.environment,
  });
  const audit = new MemoryAuditLog();
  const approvalHandler = options.approvalHandler ?? new ScriptedApprovalHandler();
  const clock = options.clock ?? { now: () => new Date("2026-10-11T12:00:00.000Z") };
  const approvals = new ApprovalGate({
    handler: approvalHandler,
    store: new MemoryApprovalStore(),
    audit,
    clock,
  });
  const {
    root: _root,
    approvalHandler: _h,
    app: _app,
    environment: _environment,
    ...rest
  } = options;
  return {
    paths,
    reporter: new MemoryReporter(),
    audit,
    approvals,
    approvalHandler,
    state: new ProjectStateStore(paths.files.state, clock),
    costs: new CostLedger(paths.files.costs, clock),
    runner: new ScriptedRunner(),
    fetch: forbiddenFetch,
    env,
    clock,
    redactor: new Redactor(),
    interactive: false,
    version: "0.0.0-test",
    ...rest,
  } as TestPhaseDeps;
}
