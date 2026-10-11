import type { PhaseRequest, RuntimeEvent } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeAgentRuntime } from "./fake-runtime";

function request<T = unknown>(overrides: Partial<PhaseRequest<T>> = {}): PhaseRequest<T> {
  return {
    phase: "analyze",
    systemPrompt: "You are the Analyst.",
    prompt: "Summarise the repository.",
    projectRoot: "/tmp/project",
    profile: "read-only",
    ...overrides,
  };
}

const summarySchema = z.object({ summary: z.string(), risks: z.array(z.string()) });

describe("FakeAgentRuntime", () => {
  it("implements AgentRuntime with a stable id and a configurable availability", async () => {
    const runtime = new FakeAgentRuntime();
    expect(runtime.id).toBe("fake");
    expect(await runtime.isConfigured()).toEqual({ ok: true });

    const offline = new FakeAgentRuntime({
      availability: { ok: false, reason: "No key.", hint: "Set ANTHROPIC_API_KEY." },
    });
    expect(await offline.isConfigured()).toEqual({
      ok: false,
      reason: "No key.",
      hint: "Set ANTHROPIC_API_KEY.",
    });
    offline.availability = { ok: true };
    expect((await offline.isConfigured()).ok).toBe(true);
  });

  it("returns a completed result with defaults and records every request", async () => {
    const runtime = new FakeAgentRuntime({ phases: { analyze: { text: "done", costUsd: 0.25 } } });
    const req = request();
    const result = await runtime.runPhase(req);
    expect(result).toEqual({
      ok: true,
      stopReason: "completed",
      text: "done",
      costUsd: 0.25,
      turns: 1,
    });
    expect(runtime.requests).toEqual([req]);
  });

  it("reuses a single per-phase response and consumes per-phase arrays in order", async () => {
    const runtime = new FakeAgentRuntime({
      phases: {
        analyze: { text: "always" },
        adapt: [{ text: "first" }, { text: "second" }],
      },
    });
    expect((await runtime.runPhase(request())).text).toBe("always");
    expect((await runtime.runPhase(request())).text).toBe("always");
    expect((await runtime.runPhase(request({ phase: "adapt" }))).text).toBe("first");
    expect((await runtime.runPhase(request({ phase: "adapt" }))).text).toBe("second");
    await expect(runtime.runPhase(request({ phase: "adapt" }))).rejects.toThrow(/adapt/);
  });

  it("falls back to the queue when no per-phase response exists", async () => {
    const runtime = new FakeAgentRuntime({ queue: [{ text: "one" }, { text: "two" }] });
    expect((await runtime.runPhase(request({ phase: "design" }))).text).toBe("one");
    expect((await runtime.runPhase(request({ phase: "verify" }))).text).toBe("two");
    await expect(runtime.runPhase(request())).rejects.toThrow(/no scripted response/i);
  });

  it("accepts responses computed from the request, sync or async", async () => {
    const runtime = new FakeAgentRuntime({
      queue: [
        (req) => ({ text: `echo: ${req.prompt}` }),
        async (req) => ({ text: `phase: ${req.phase}`, turns: 3 }),
      ],
    });
    expect((await runtime.runPhase(request({ prompt: "hi" }))).text).toBe("echo: hi");
    const second = await runtime.runPhase(request());
    expect(second.text).toBe("phase: analyze");
    expect(second.turns).toBe(3);
  });

  it("validates scripted output against the request schema", async () => {
    const runtime = new FakeAgentRuntime({
      queue: [
        { output: { summary: "A Next.js app", risks: [] } },
        { output: { summary: 42 } },
        { text: "no structured output" },
      ],
    });
    const output = { name: "architecture_summary", schema: summarySchema };

    const good = await runtime.runPhase(request({ output }));
    expect(good.ok).toBe(true);
    expect(good.output).toEqual({ summary: "A Next.js app", risks: [] });

    const bad = await runtime.runPhase(request({ output }));
    expect(bad.ok).toBe(false);
    expect(bad.stopReason).toBe("invalid_output");
    expect(bad.output).toBeUndefined();
    expect(bad.error).toMatch(/summary/);

    const missing = await runtime.runPhase(request({ output }));
    expect(missing.ok).toBe(false);
    expect(missing.stopReason).toBe("invalid_output");
  });

  it("returns parsed (transformed) output like the real runtime", async () => {
    const schema = z.object({ count: z.coerce.number() });
    const runtime = new FakeAgentRuntime({ queue: [{ output: { count: "3" } }] });
    const result = await runtime.runPhase(request({ output: { name: "count", schema } }));
    expect(result.output).toEqual({ count: 3 });
  });

  it("keeps non-completed stop reasons and marks them not ok", async () => {
    const runtime = new FakeAgentRuntime({
      queue: [
        { stopReason: "budget_exceeded", costUsd: 2, error: "Budget reached." },
        { stopReason: "max_turns", output: { summary: "x", risks: [] } },
      ],
    });
    const budget = await runtime.runPhase(request({ maxBudgetUsd: 1 }));
    expect(budget).toMatchObject({ ok: false, stopReason: "budget_exceeded", costUsd: 2 });

    const turns = await runtime.runPhase(request({ output: { name: "s", schema: summarySchema } }));
    expect(turns.ok).toBe(false);
    expect(turns.stopReason).toBe("max_turns");
    expect(turns.output).toBeUndefined();
  });

  it("forwards scripted events to onEvent", async () => {
    const events: RuntimeEvent[] = [];
    const runtime = new FakeAgentRuntime({
      queue: [{ text: "ok", events: [{ kind: "assistant-text", message: "thinking" }] }],
    });
    await runtime.runPhase(request({ onEvent: (event) => events.push(event) }));
    expect(events).toEqual([{ kind: "assistant-text", message: "thinking" }]);
  });

  it("returns an aborted result when the signal is already aborted", async () => {
    const runtime = new FakeAgentRuntime({ queue: [{ text: "unused" }] });
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.runPhase(request({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, stopReason: "aborted" });
    expect(runtime.requests).toHaveLength(1);
  });
});
