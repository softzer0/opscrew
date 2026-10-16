import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Clock, PHASES, type PhaseName } from "@opscrew/contracts";
import { z } from "zod";
import { appendJsonLine, readJsonLines } from "./audit";
import { OpsCrewError } from "./errors";

const systemClock: Clock = { now: () => new Date() };

// ---------------------------------------------------------------------------------------------
// Project state (`.opscrew/state.json`)
// ---------------------------------------------------------------------------------------------

/** Outcome of a phase run. */
export type PhaseStatus = "ok" | "failed" | "skipped";

export interface PhaseRecord {
  status: PhaseStatus;
  /** ISO-8601 UTC time the phase finished. */
  at: string;
  summary?: string;
}

/** Contents of `.opscrew/state.json`. */
export interface ProjectState {
  schemaVersion: 1;
  phases: Partial<Record<PhaseName, PhaseRecord>>;
  updatedAt?: string;
}

const phaseRecordSchema = z.object({
  status: z.enum(["ok", "failed", "skipped"]),
  at: z.string(),
  summary: z.string().optional(),
});

const projectStateSchema: z.ZodType<ProjectState> = z.object({
  schemaVersion: z.literal(1),
  phases: z.partialRecord(z.enum(PHASES), phaseRecordSchema),
  updatedAt: z.string().optional(),
});

/** Reads and updates `.opscrew/state.json`: which phases have run, when, and with what result. */
export class ProjectStateStore {
  private readonly clock: Clock;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Returns the current state; a missing file reads as `{ schemaVersion: 1, phases: {} }`.
   * Throws `OpsCrewError("ARTIFACT_INVALID")` when the file is not valid state JSON. Reads wait
   * for this store's pending writes.
   */
  read(): Promise<ProjectState> {
    return this.enqueue(() => this.readNow());
  }

  private async readNow(): Promise<ProjectState> {
    let text: string;
    try {
      // Windows briefly refuses access while another process renames over the file.
      text = await retryTransient(() => readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, phases: {} };
      throw error;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const result = projectStateSchema.safeParse(json);
    if (!result.success) {
      throw new OpsCrewError(
        "ARTIFACT_INVALID",
        `${this.file} is not a valid OpsCrew state file.`,
        {
          hint: "Delete the file to reset the recorded phase history; it is rebuilt on the next run.",
        },
      );
    }
    return result.data;
  }

  /**
   * Records the outcome of `phase` (replacing any earlier result) and writes the file atomically
   * (temp file + rename). Calls on one store are serialised. Returns the new state.
   */
  markPhase(phase: PhaseName, status: PhaseStatus, summary?: string): Promise<ProjectState> {
    return this.enqueue(async () => {
      const state = await this.readNow();
      const at = this.clock.now().toISOString();
      const record: PhaseRecord = { status, at };
      if (summary !== undefined) record.summary = summary;
      const next: ProjectState = {
        schemaVersion: 1,
        phases: { ...state.phases, [phase]: record },
        updatedAt: at,
      };
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  /** Runs `task` after every earlier read and write on this store. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}

// ---------------------------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------------------------

/** Retry tuning for transient Windows file-lock errors; defaults give about one second. */
export interface RetryOptions {
  /** Total attempts including the first (default 20, about 4 s in total). */
  attempts?: number;
  /** Wait before retry number `attempt` (1-based); default 10, 20, 40, 80, 160, then 250 ms. */
  delayMs?: (attempt: number) => number;
}

/** Error codes Windows raises while another process has the file open; worth retrying. */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_FS_CODES.has(code);
}

const defaultDelay = (attempt: number) => Math.min(10 * 2 ** (attempt - 1), 250);

async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 20);
  const delayMs = options.delayMs ?? defaultDelay;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      const wait = delayMs(attempt);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    }
  }
}

/**
 * Renames `from` to `to`, retrying with short backoff when Windows reports `EPERM`, `EACCES` or
 * `EBUSY` because something has the target open. Other errors are thrown at once.
 */
export function renameWithRetry(
  from: string,
  to: string,
  options: RetryOptions & { rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<void> {
  const doRename = options.rename ?? rename;
  return retryTransient(() => doRename(from, to), options);
}

/**
 * Writes `content` to `file` atomically: a temp file in the same directory, then
 * `renameWithRetry` over the target. Creates parent directories. The temp file is removed only
 * when the final rename attempt fails.
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  options: RetryOptions & {
    /** Mode for a newly created file (default 0o600). */
    mode?: number;
    rename?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: options.mode ?? 0o600 });
    await renameWithRetry(temp, file, options);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Cost ledger (`.opscrew/costs.jsonl`)
// ---------------------------------------------------------------------------------------------

/** One model spend record. */
export interface CostEntry {
  /** ISO-8601 UTC time the spend was recorded. */
  at: string;
  phase: PhaseName;
  model?: string;
  costUsd: number;
}

const costEntrySchema: z.ZodType<CostEntry> = z.object({
  at: z.string(),
  phase: z.enum(PHASES),
  model: z.string().optional(),
  costUsd: z.number().finite().nonnegative(),
});

/** Append-only JSONL ledger of model spend per phase. */
export class CostLedger {
  private readonly clock: Clock;

  constructor(
    private readonly file: string,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  /** Appends a spend record; `at` defaults to now. Rejects negative or non-finite amounts. */
  async append(entry: Omit<CostEntry, "at"> & { at?: string }): Promise<void> {
    if (!Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
      throw new OpsCrewError("INVALID_INPUT", "A cost entry must be a non-negative number of USD.");
    }
    const record: CostEntry = {
      at: entry.at ?? this.clock.now().toISOString(),
      phase: entry.phase,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      costUsd: entry.costUsd,
    };
    await appendJsonLine(this.file, record);
  }

  /** All valid entries in append order; corrupt lines are skipped. */
  entries(): Promise<CostEntry[]> {
    return readJsonLines(this.file, costEntrySchema);
  }

  /** Total spend in USD. */
  async total(): Promise<number> {
    return (await this.entries()).reduce((sum, e) => sum + e.costUsd, 0);
  }
}
