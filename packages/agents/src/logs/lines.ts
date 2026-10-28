/**
 * The lines `logs` returns (data-model.md "Log lines"): the ones read, then, when following, the
 * new ones as they arrive until the caller's signal aborts or it stops iterating.
 */

/** One line of the app's logs. `text` has passed the redactor. */
export interface LogLine {
  /** When it was logged: Docker's timestamp (RFC 3339, UTC), or a deploy run's creation. */
  time: string;
  /** Its part: `app`, a worker, a cron job, a service, `edge`; `deploy` for a site's runs. */
  service: string;
  stream: "stdout" | "stderr" | "edge";
  text: string;
}

/** What `readLogs` returns: its first line, then the lines when iterated. */
export interface LogRead extends AsyncIterable<LogLine> {
  /**
   * The first line to show: how far back the lines go, or why the host keeps none. Redacted.
   */
  readonly first: string;
}

/** Follows new lines, each to `push`, until `signal` aborts; resolves when nothing more comes. */
export type Follow = (push: (line: LogLine) => void, signal: AbortSignal) => Promise<void>;

/** Lines pushed by a follow, waited for by the iterator; ended by the follow or its stop. */
class LineQueue implements AsyncIterable<LogLine> {
  readonly #lines: LogLine[] = [];
  #ended = false;
  #error: unknown;
  #wake: (() => void) | undefined;

  push(line: LogLine): void {
    if (this.#ended) return;
    this.#lines.push(line);
    this.#wakeUp();
  }

  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#wakeUp();
  }

  #wakeUp(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<LogLine> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (this.#ended) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/** `past`, then what `follow` pushes until `signal` aborts or the caller stops iterating. */
async function* linesOf(
  past: readonly LogLine[],
  follow: Follow | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<LogLine> {
  yield* past;
  if (follow === undefined || signal?.aborted === true) return;
  const stop = new AbortController();
  const queue = new LineQueue();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  stop.signal.addEventListener("abort", () => queue.end(), { once: true });
  follow((line) => queue.push(line), stop.signal).then(
    () => queue.end(),
    (error: unknown) => queue.end(stop.signal.aborted ? undefined : error),
  );
  try {
    yield* queue;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A caller that stops iterating stops the follow too (ssh, the runner, the polling).
    stop.abort();
  }
}

/** A {@link LogRead} of `first` and `past`, then what `follow` pushes until `signal` aborts. */
export function logRead(
  first: string,
  past: readonly LogLine[],
  follow?: Follow,
  signal?: AbortSignal,
): LogRead {
  return { first, [Symbol.asyncIterator]: () => linesOf(past, follow, signal) };
}
