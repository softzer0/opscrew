import type {
  AgentRuntime,
  PhaseName,
  PhaseRequest,
  PhaseResult,
  RuntimeAvailability,
  RuntimeEvent,
} from "@opscrew/contracts";

/** A scripted result: any part of a `PhaseResult`, plus events to replay through `onEvent`. */
export type FakePhaseResponse = Partial<PhaseResult<unknown>> & { events?: RuntimeEvent[] };

/** A scripted response, or a function computing one from the request. */
export type FakeScript =
  | FakePhaseResponse
  | ((request: PhaseRequest<unknown>) => FakePhaseResponse | Promise<FakePhaseResponse>);

export interface FakeAgentRuntimeOptions {
  /**
   * Responses per phase. A single script answers every request for that phase; an array is
   * consumed in order. Per-phase scripts take precedence over `queue`.
   */
  phases?: Partial<Record<PhaseName, FakeScript | FakeScript[]>>;
  /** Responses consumed in order for phases without a per-phase script. */
  queue?: FakeScript[];
  /** What `isConfigured()` returns. Defaults to `{ ok: true }`. */
  availability?: RuntimeAvailability;
}

/**
 * Agent runtime for tests: returns scripted results, records every request and validates scripted
 * `output` against the request's schema exactly like the real runtime (invalid or missing output
 * yields `ok: false`, `stopReason: "invalid_output"` and no `output`). Never calls a model.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly id = "fake";
  /** Every request passed to `runPhase`, in order. */
  readonly requests: PhaseRequest<unknown>[] = [];
  /** What `isConfigured()` returns; may be changed between calls. */
  availability: RuntimeAvailability;

  readonly #phases = new Map<PhaseName, FakeScript | FakeScript[]>();
  readonly #queue: FakeScript[];

  constructor(options: FakeAgentRuntimeOptions = {}) {
    for (const [phase, script] of Object.entries(options.phases ?? {})) {
      if (script !== undefined) {
        this.#phases.set(phase as PhaseName, Array.isArray(script) ? [...script] : script);
      }
    }
    this.#queue = [...(options.queue ?? [])];
    this.availability = options.availability ?? { ok: true };
  }

  async isConfigured(): Promise<RuntimeAvailability> {
    return { ...this.availability };
  }

  async runPhase<T>(request: PhaseRequest<T>): Promise<PhaseResult<T>> {
    this.requests.push(request as PhaseRequest<unknown>);
    if (request.signal?.aborted === true) {
      return {
        ok: false,
        stopReason: "aborted",
        text: "",
        costUsd: 0,
        turns: 0,
        error: `The ${request.phase} phase was cancelled.`,
      };
    }

    const script = this.#next(request.phase);
    const scripted =
      typeof script === "function" ? await script(request as PhaseRequest<unknown>) : script;
    const { events, ...response } = scripted;
    for (const event of events ?? []) request.onEvent?.(event);

    const result: PhaseResult<T> = {
      stopReason: "completed",
      text: "",
      costUsd: 0,
      turns: 1,
      ...(response as Partial<PhaseResult<T>>),
      ok: false,
    };
    delete result.output;

    if (result.stopReason !== "completed") return result;

    if (request.output === undefined) {
      if (response.output !== undefined) result.output = response.output as T;
      result.ok = response.ok !== false;
      return result;
    }

    const parsed = request.output.schema.safeParse(response.output);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      result.stopReason = "invalid_output";
      result.error = `The model's output did not match the expected ${request.output.name} format (${issues}).`;
      return result;
    }
    result.output = parsed.data;
    result.ok = response.ok !== false;
    return result;
  }

  #next(phase: PhaseName): FakeScript {
    const perPhase = this.#phases.get(phase);
    if (perPhase !== undefined) {
      if (!Array.isArray(perPhase)) return perPhase;
      const next = perPhase.shift();
      if (next !== undefined) return next;
      throw new Error(`FakeAgentRuntime: the scripted responses for phase "${phase}" ran out.`);
    }
    const next = this.#queue.shift();
    if (next !== undefined) return next;
    throw new Error(`FakeAgentRuntime: no scripted response left for phase "${phase}".`);
  }
}
