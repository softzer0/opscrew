import type { CliContext } from "../context";
import { servicesOf } from "../deps";

/** Calls `stop` once on Ctrl-C (SIGINT) or SIGTERM of this process; returns what unsubscribes it. */
function onProcessStop(stop: () => void): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handler = () => {
    for (const signal of signals) process.off(signal, handler);
    stop();
  };
  for (const signal of signals) process.once(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

/**
 * A signal the user aborts with Ctrl-C (or SIGTERM) while a long-running command runs (`logs
 * --follow`, `addon open`), and `release`, which stops listening; after it, Ctrl-C ends the
 * process as usual.
 */
export function stopSignal(ctx: CliContext): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const release = (servicesOf(ctx).onStop ?? onProcessStop)(() => controller.abort());
  return { signal: controller.signal, release };
}

/**
 * Ends the process once stdout and stderr have flushed what was written, after `main` has set the
 * exit code: an open socket (Node's WebSocket to Cloudflare's tail, whose `close()` never
 * completes) would otherwise keep it alive after `logs --follow`.
 */
function endProcessWhenFlushed(): void {
  process.stdout.write("", () => {
    process.stderr.write("", () => setImmediate(() => process.exit()));
  });
}

/** Ends the process after a follow ({@link endProcessWhenFlushed}, or the test's fake). */
export function endProcess(ctx: CliContext): void {
  (servicesOf(ctx).endProcess ?? endProcessWhenFlushed)();
}
