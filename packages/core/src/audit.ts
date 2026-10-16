import { appendFile, type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AuditEntry, AuditInput, AuditLog, Clock } from "@opscrew/contracts";
import type { z } from "zod";

const systemClock: Clock = { now: () => new Date() };

// ---------------------------------------------------------------------------------------------
// JSONL helpers (shared by the audit log, the approval store and the cost ledger)
// ---------------------------------------------------------------------------------------------

/** One promise chain per absolute file path, so appends from this process never interleave. */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Appends `value` as one JSON line to `file`, creating parent directories (mode 0o700; new files
 * get 0o600). Appends to the same file from one process are serialised, so concurrent calls never
 * interleave lines.
 */
export function appendJsonLine(file: string, value: unknown): Promise<void> {
  const key = resolve(file);
  const line = `${JSON.stringify(value)}\n`;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(key), { recursive: true, mode: 0o700 });
    // A torn last line (crash mid-write) must not swallow this record: start a fresh line.
    const prefix = (await endsWithNewline(key)) ? "" : "\n";
    await appendFile(key, prefix + line, { encoding: "utf8", mode: 0o600 });
  });
  const settled = next.catch(() => {});
  writeQueues.set(key, settled);
  void settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}

/** True when `file` is missing, empty or ends with a newline byte. */
async function endsWithNewline(file: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Reads a JSONL file. A missing file reads as empty; blank lines, CRLF line endings and a leading
 * BOM are accepted. Lines that are not valid JSON, or that fail `schema` when one is given, are
 * skipped.
 */
export async function readJsonLines<T = unknown>(
  file: string,
  schema?: z.ZodType<T>,
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const values: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (schema === undefined) {
      values.push(value as T);
      continue;
    }
    const result = schema.safeParse(value);
    if (result.success) values.push(result.data);
  }
  return values;
}

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

/** Builds a complete entry with every free-text field redacted. Fields outside `AuditEntry` are dropped. */
function toEntry(input: AuditInput, at: string, redact: (text: string) => string): AuditEntry {
  const entry: AuditEntry = {
    at,
    kind: input.kind,
    actor: input.actor,
    action: redact(input.action),
  };
  if (input.phase !== undefined) entry.phase = input.phase;
  if (input.sessionId !== undefined) entry.sessionId = redact(input.sessionId);
  if (input.target !== undefined) entry.target = redact(input.target);
  if (input.decision !== undefined) entry.decision = input.decision;
  if (input.detail !== undefined) entry.detail = redact(input.detail);
  return entry;
}

export interface JsonlAuditLogOptions {
  /** Directory for the daily files, normally `~/.opscrew/audit`. Created with mode 0o700. */
  dir: string;
  /** Applied to every string field before it is written (normally `Redactor.redact`). */
  redact: (text: string) => string;
  clock?: Clock;
}

/**
 * Append-only audit log writing one JSON object per line to `<dir>/<YYYY-MM-DD UTC>.jsonl`, where
 * the date is that of the entry's `at`. Every string field passes through `redact`; concurrent
 * appends never interleave.
 */
export class JsonlAuditLog implements AuditLog {
  private readonly dir: string;
  private readonly redact: (text: string) => string;
  private readonly clock: Clock;

  constructor(options: JsonlAuditLogOptions) {
    this.dir = options.dir;
    this.redact = options.redact;
    this.clock = options.clock ?? systemClock;
  }

  async append(input: AuditInput): Promise<void> {
    const parsed = input.at === undefined ? undefined : new Date(input.at);
    const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : this.clock.now();
    const entry = toEntry(input, input.at ?? date.toISOString(), this.redact);
    const file = join(this.dir, `${date.toISOString().slice(0, 10)}.jsonl`);
    await appendJsonLine(file, entry);
  }
}

/** In-memory audit log for tests. Entries are normalised and redacted like the JSONL log. */
export class MemoryAuditLog implements AuditLog {
  /** Every appended entry, in order. */
  readonly entries: AuditEntry[] = [];
  private readonly redact: (text: string) => string;
  private readonly clock: Clock;

  constructor(options: { redact?: (text: string) => string; clock?: Clock } = {}) {
    this.redact = options.redact ?? ((text) => text);
    this.clock = options.clock ?? systemClock;
  }

  async append(input: AuditInput): Promise<void> {
    const at = input.at ?? this.clock.now().toISOString();
    this.entries.push(toEntry(input, at, this.redact));
  }
}
