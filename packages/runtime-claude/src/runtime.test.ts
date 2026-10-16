import { resolve } from "node:path";
import {
  AbortError,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequest,
  PhaseName,
  PhaseRequest,
  RuntimeEvent,
  ToolDecision,
  ToolPolicy,
} from "@opscrew/contracts";
import { DefaultToolPolicy, MemoryAuditLog, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeAgentRuntime, type ClaudeAgentRuntimeOptions, type QueryFn } from "./runtime";

const ROOT = resolve("opscrew-test-project");
const SESSION = "session-1";

// ---------------------------------------------------------------------------------------------
// Scripted SDK
// ---------------------------------------------------------------------------------------------

interface ToolStep {
  tool: string;
  input: Record<string, unknown>;
  id?: string;
  /**
   * Which SDK entry point decides: the pre-tool-use hook (default), the callback, or both.
   * `none` runs the tool without either, as an SDK whose hooks were suppressed would.
   */
  via?: "hook" | "canUseTool" | "both" | "none";
  /** What the tool returned (default `"ok"`). */
  response?: unknown;
}
type Step = SDKMessage | ToolStep | { throw: Error };

interface ToolOutcome {
  tool: string;
  hook?: HookJSONOutput;
  permission?: PermissionResult;
  executed: boolean;
  /** What the post-tool-use hook returned. */
  post?: HookJSONOutput;
}

function isToolStep(step: Step): step is ToolStep {
  return "tool" in step && !("type" in step);
}

function scriptedQuery(steps: Step[]) {
  const calls: Array<{ prompt: string; options?: Options }> = [];
  const outcomes: ToolOutcome[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params);
    const options = params.options ?? {};
    return (async function* () {
      let n = 0;
      for (const step of steps) {
        // Like the SDK, stop once the runtime aborts the query.
        if (options.abortController?.signal.aborted === true) {
          throw new AbortError("Claude Code process aborted by user");
        }
        if ("throw" in step) throw step.throw;
        if (!isToolStep(step)) {
          yield step;
          continue;
        }
        const id = step.id ?? `tool-${++n}`;
        const via = step.via ?? "hook";
        const outcome: ToolOutcome = { tool: step.tool, executed: false };
        const signal = new AbortController().signal;
        let allowed = true;
        if (via === "hook" || via === "both") {
          const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
          if (pre === undefined) throw new Error("PreToolUse hook missing");
          outcome.hook = await pre(
            {
              hook_event_name: "PreToolUse",
              tool_name: step.tool,
              tool_input: step.input,
              tool_use_id: id,
              session_id: SESSION,
              transcript_path: "",
              cwd: ROOT,
            },
            id,
            { signal },
          );
          const specific = (
            outcome.hook as { hookSpecificOutput?: { permissionDecision?: string } }
          ).hookSpecificOutput;
          allowed = specific?.permissionDecision === "allow";
        }
        if (via === "canUseTool" || via === "both") {
          const canUse = options.canUseTool;
          if (canUse === undefined) throw new Error("canUseTool missing");
          const permission = await canUse(step.tool, step.input, {
            signal,
            toolUseID: id,
            requestId: `req-${id}`,
          });
          if (permission === null) throw new Error("canUseTool returned null");
          outcome.permission = permission;
          allowed = allowed && permission.behavior === "allow";
        }
        if (allowed) {
          outcome.executed = true;
          const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
          outcome.post = await post?.(
            {
              hook_event_name: "PostToolUse",
              tool_name: step.tool,
              tool_input: step.input,
              tool_response: step.response ?? "ok",
              tool_use_id: id,
              session_id: SESSION,
              transcript_path: "",
              cwd: ROOT,
            },
            id,
            { signal },
          );
        }
        outcomes.push(outcome);
      }
    })();
  };
  return { queryFn, calls, outcomes };
}

function init(model = "claude-opus-5-5"): SDKMessage {
  return { type: "system", subtype: "init", model, session_id: SESSION } as unknown as SDKMessage;
}

function assistant(text: string, parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: parent,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

function success(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "All done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.42,
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0.42,
        contextWindow: 0,
        maxOutputTokens: 0,
      },
    },
    permission_denials: [],
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

function failure(subtype: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    num_turns: 7,
    stop_reason: null,
    total_cost_usd: 1.5,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

function request<T = unknown>(overrides: Partial<PhaseRequest<T>> = {}): PhaseRequest<T> {
  return {
    phase: "analyze",
    systemPrompt: "You are the Analyst.",
    prompt: "Describe this repository.",
    projectRoot: ROOT,
    profile: "read-only",
    ...overrides,
  };
}

function setup(
  steps: Step[],
  options: Partial<ClaudeAgentRuntimeOptions> = {},
): {
  runtime: ClaudeAgentRuntime;
  audit: MemoryAuditLog;
  ledger: Array<{ phase: PhaseName; model?: string; costUsd: number }>;
  calls: Array<{ prompt: string; options?: Options }>;
  outcomes: ToolOutcome[];
} {
  const redactor = new Redactor();
  const audit = new MemoryAuditLog({ redact: redactor.redact });
  const ledger: Array<{ phase: PhaseName; model?: string; costUsd: number }> = [];
  const { queryFn, calls, outcomes } = scriptedQuery(steps);
  const runtime = new ClaudeAgentRuntime({
    policy: new DefaultToolPolicy(),
    audit,
    redact: redactor.redact,
    costLedger: { append: async (entry) => void ledger.push(entry) },
    env: { ANTHROPIC_API_KEY: "test", PATH: "/usr/bin" },
    queryFn,
    ...options,
  });
  return { runtime, audit, ledger, calls, outcomes };
}

function onlyCall(calls: Array<{ prompt: string; options?: Options }>) {
  expect(calls).toHaveLength(1);
  const options = calls[0]?.options;
  if (options === undefined) throw new Error("query() was called without options");
  return options;
}

function stubPolicy(decision: ToolDecision): ToolPolicy {
  return { evaluate: () => decision };
}

// ---------------------------------------------------------------------------------------------
// isConfigured
// ---------------------------------------------------------------------------------------------

describe("ClaudeAgentRuntime.isConfigured", () => {
  const make = (env: Record<string, string | undefined>) =>
    new ClaudeAgentRuntime({
      policy: new DefaultToolPolicy(),
      audit: new MemoryAuditLog(),
      redact: (text) => text,
      env,
    });

  it("has the id claude-agent-sdk", () => {
    expect(make({}).id).toBe("claude-agent-sdk");
  });

  it("explains how to configure credentials when none are present (US4-5)", async () => {
    const result = await make({ PATH: "/usr/bin", CLAUDE_CODE_USE_BEDROCK: "0" }).isConfigured();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/credentials/i);
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]) {
      expect(result.hint).toContain(name);
    }
  });

  it.each([
    [{ ANTHROPIC_API_KEY: "x" }],
    [{ ANTHROPIC_AUTH_TOKEN: "x" }],
    [{ CLAUDE_CODE_USE_BEDROCK: "1" }],
    [{ CLAUDE_CODE_USE_VERTEX: "1" }],
    [{ CLAUDE_CODE_USE_FOUNDRY: "1" }],
  ])("is configured with %o", async (env) => {
    expect(await make(env).isConfigured()).toEqual({ ok: true });
  });

  it("ignores empty keys", async () => {
    expect((await make({ ANTHROPIC_API_KEY: "  " }).isConfigured()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------------------------

describe("ClaudeAgentRuntime option mapping", () => {
  it("maps read-only to a plain system prompt, read tools and isolated settings", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(request());
    const options = onlyCall(calls);
    expect(calls[0]?.prompt).toBe("Describe this repository.");
    expect(options.systemPrompt).toBe("You are the Analyst.");
    expect(options.cwd).toBe(ROOT);
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "WebSearch", "Task"]),
    );
    expect(options.disallowedTools).not.toContain("Read");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof options.canUseTool).toBe("function");
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.mcpServers).toBeUndefined();
    expect(options.outputFormat).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
  });

  it("maps edit-repo to the Claude Code preset with the phase prompt appended", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(request({ phase: "adapt", profile: "edit-repo" }));
    const options = onlyCall(calls);
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are the Analyst.",
    });
    expect(options.tools).toEqual(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).not.toContain("Bash");
  });

  it("maps none to no tools and no MCP server", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(request({ phase: "design", profile: "none" }));
    const options = onlyCall(calls);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]),
    );
    expect(options.mcpServers).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
  });

  it("intersects the profile tools with builtinTools", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(request({ builtinTools: ["Read", "Bash"] }));
    const options = onlyCall(calls);
    expect(options.tools).toEqual(["Read"]);
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Glob", "Grep", "Bash"]));
  });

  it("passes model, effort, maxTurns and maxBudgetUsd through", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(
      request({ model: "claude-sonnet-5", effort: "high", maxTurns: 12, maxBudgetUsd: 0.75 }),
    );
    const options = onlyCall(calls);
    expect(options).toMatchObject({
      model: "claude-sonnet-5",
      effort: "high",
      maxTurns: 12,
      maxBudgetUsd: 0.75,
    });
  });

  it("uses the configured default model", async () => {
    const { runtime, calls } = setup([success()], { defaultModel: "claude-haiku-5" });
    await runtime.runPhase(request());
    expect(onlyCall(calls).model).toBe("claude-haiku-5");
  });

  it("requests structured output as a draft-07 JSON schema", async () => {
    const { runtime, calls } = setup([success({ structured_output: { summary: "x" } })]);
    await runtime.runPhase(
      request({ output: { name: "summary", schema: z.object({ summary: z.string() }) } }),
    );
    const format = onlyCall(calls).outputFormat;
    expect(format?.type).toBe("json_schema");
    expect(format?.schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });
  });

  it("removes provider tokens from the agent environment (US4-4)", async () => {
    const env = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: fakeSecret("anthropic-key"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"),
      GITHUB_TOKEN: fakeSecret("github-token"),
    };
    const { runtime, calls } = setup([success()], { env });
    await runtime.runPhase(request());
    const agentEnv = onlyCall(calls).env ?? {};
    expect(agentEnv).not.toHaveProperty("HCLOUD_TOKEN");
    expect(agentEnv).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(agentEnv).not.toHaveProperty("GITHUB_TOKEN");
    expect(agentEnv.ANTHROPIC_API_KEY).toBe(env.ANTHROPIC_API_KEY);
    expect(agentEnv.PATH).toBe("/usr/bin");
  });

  it("redacts the prompt and system prompt before they reach the model", async () => {
    const token = fakeSecret("github-token");
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(
      request({ prompt: `Token ${token} found`, systemPrompt: `Never print ${token}` }),
    );
    const options = onlyCall(calls);
    expect(calls[0]?.prompt).not.toContain(token);
    expect(String(options.systemPrompt)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------------------------
// Tool gating
// ---------------------------------------------------------------------------------------------

describe("ClaudeAgentRuntime tool gating", () => {
  it("denies a tool call the policy denies, with the reason, and audits it (US4-3)", async () => {
    const events: RuntimeEvent[] = [];
    const { runtime, audit, outcomes } = setup([
      init(),
      { tool: "Bash", input: { command: "ls" } },
      success(),
    ]);
    await runtime.runPhase(request({ onEvent: (event) => events.push(event) }));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.executed).toBe(false);
    expect(outcomes[0]?.hook).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Bash is not allowed in the read-only profile.",
      },
    });
    const denied = audit.entries.filter((entry) => entry.kind === "tool-denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      action: "Bash",
      phase: "analyze",
      decision: "deny",
      target: "ls",
      detail: "Bash is not allowed in the read-only profile.",
    });
    expect(audit.entries.some((entry) => entry.kind === "tool-call")).toBe(false);
    expect(events.some((event) => event.kind === "tool-denied" && event.tool === "Bash")).toBe(
      true,
    );
  });

  it("applies the same policy in the permission callback", async () => {
    const { runtime, audit, outcomes } = setup([
      { tool: "Write", input: { file_path: `${ROOT}/x.txt`, content: "" }, via: "canUseTool" },
      success(),
    ]);
    await runtime.runPhase(request());
    expect(outcomes[0]?.permission).toEqual({
      behavior: "deny",
      message: "Write is not allowed in the read-only profile.",
    });
    expect(outcomes[0]?.executed).toBe(false);
    expect(audit.entries.filter((entry) => entry.kind === "tool-denied")).toHaveLength(1);
  });

  it("allows a permitted call and audits it after it runs", async () => {
    const file = resolve(ROOT, "src", "index.ts");
    const { runtime, audit, outcomes } = setup([
      init(),
      { tool: "Read", input: { file_path: file }, via: "both" },
      success(),
    ]);
    await runtime.runPhase(request());
    expect(outcomes[0]?.executed).toBe(true);
    expect(outcomes[0]?.hook).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(outcomes[0]?.permission).toEqual({
      behavior: "allow",
      updatedInput: { file_path: file },
    });
    const calls = audit.entries.filter((entry) => entry.kind === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: "Read",
      actor: "agent",
      phase: "analyze",
      sessionId: SESSION,
      target: file,
      decision: "allow",
    });
  });

  it("redacts secrets in tool output before the model sees it (constitution IV)", async () => {
    const token = fakeSecret("stripe-live-key");
    const file = resolve(ROOT, "src", "pay.ts");
    const { runtime, outcomes } = setup([
      init(),
      {
        tool: "Read",
        input: { file_path: file },
        response: { type: "text", file: { content: `const key = "${token}";`, numLines: 1 } },
      },
      { tool: "Read", input: { file_path: resolve(ROOT, "README.md") }, response: "no secrets" },
      success(),
    ]);
    await runtime.runPhase(request());
    const rewritten = outcomes[0]?.post as {
      hookSpecificOutput?: { hookEventName: string; updatedToolOutput?: unknown };
    };
    expect(rewritten.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(JSON.stringify(rewritten.hookSpecificOutput?.updatedToolOutput)).not.toContain(token);
    expect(rewritten.hookSpecificOutput?.updatedToolOutput).toMatchObject({
      type: "text",
      file: { numLines: 1 },
    });
    // unchanged output is left alone (no identity rewrite)
    expect(outcomes[1]?.post).toEqual({});
  });

  it("redacts before shortening audit targets, so a cut never leaves part of a secret", async () => {
    const token = fakeSecret("github-token");
    const command = `${"echo padding && ".repeat(16)}curl -H "Authorization: ${token}" https://example.invalid`;
    const { runtime, audit } = setup([init(), { tool: "Bash", input: { command } }, success()]);
    await runtime.runPhase(request());
    const text = JSON.stringify(audit.entries);
    for (let cut = 8; cut < token.length; cut += 4)
      expect(text).not.toContain(token.slice(0, cut + 4));
  });

  it("denies a call outside the project root", async () => {
    const { runtime, outcomes } = setup([
      { tool: "Read", input: { file_path: resolve(ROOT, "..", "elsewhere.txt") } },
      success(),
    ]);
    await runtime.runPhase(request());
    expect(outcomes[0]?.executed).toBe(false);
  });

  it("denies an ask decision when no approval handler is configured", async () => {
    const { runtime, audit, outcomes } = setup(
      [{ tool: "Bash", input: { command: "npm install" } }, success()],
      { policy: stubPolicy({ decision: "ask", reason: "This command runs project code." }) },
    );
    await runtime.runPhase(request({ profile: "edit-repo" }));
    expect(outcomes[0]?.executed).toBe(false);
    const hook = outcomes[0]?.hook as
      | { hookSpecificOutput?: { permissionDecisionReason?: string } }
      | undefined;
    const reason = hook?.hookSpecificOutput?.permissionDecisionReason;
    expect(reason).toMatch(/runs project code/);
    expect(reason).toMatch(/denied/);
    expect(audit.entries.find((entry) => entry.kind === "tool-denied")).toMatchObject({
      action: "Bash",
      decision: "deny",
      target: "npm install",
    });
  });

  it("asks the approval handler once for an ask decision and runs the call when approved", async () => {
    const asked: ApprovalRequest[] = [];
    const approvals = {
      request: vi.fn(async (req: ApprovalRequest) => {
        asked.push(req);
        return { approved: true };
      }),
    };
    const { runtime, audit, outcomes } = setup(
      [{ tool: "Bash", input: { command: "npm install" }, via: "both" }, success()],
      {
        policy: stubPolicy({ decision: "ask", reason: "This command runs project code." }),
        approvals,
      },
    );
    await runtime.runPhase(request({ phase: "adapt", profile: "edit-repo" }));
    expect(outcomes[0]?.executed).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(asked[0]).toMatchObject({ kind: "tool-call" });
    expect(asked[0]?.title).toContain("Bash");
    expect(asked[0]?.details).toContain("npm install");
    expect(audit.entries.find((entry) => entry.kind === "tool-call")).toMatchObject({
      action: "Bash",
      decision: "approved",
    });
  });

  it("denies an ask decision the human refuses", async () => {
    const approvals = { request: async () => ({ approved: false }) };
    const { runtime, audit, outcomes } = setup(
      [{ tool: "Bash", input: { command: "docker build ." } }, success()],
      {
        policy: stubPolicy({ decision: "ask", reason: "This command runs project code." }),
        approvals,
      },
    );
    await runtime.runPhase(request({ profile: "edit-repo" }));
    expect(outcomes[0]?.executed).toBe(false);
    expect(audit.entries.find((entry) => entry.kind === "tool-denied")).toMatchObject({
      decision: "refused",
    });
  });

  it("denies when the approval handler fails", async () => {
    const approvals = {
      request: async (): Promise<{ approved: boolean }> => {
        throw new Error("no TTY");
      },
    };
    const { runtime, outcomes } = setup([{ tool: "Bash", input: { command: "make" } }, success()], {
      policy: stubPolicy({ decision: "ask", reason: "Runs project code." }),
      approvals,
    });
    await runtime.runPhase(request({ profile: "edit-repo" }));
    expect(outcomes[0]?.executed).toBe(false);
  });

  it("fails closed when the audit log cannot record a denial", async () => {
    const { runtime, outcomes } = setup([{ tool: "Bash", input: { command: "ls" } }, success()], {
      audit: {
        append: async () => {
          throw new Error("disk full");
        },
      },
    });
    const result = await runtime.runPhase(request());
    expect(outcomes[0]?.executed).toBe(false);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// One tool gate and structured results (T818)
// ---------------------------------------------------------------------------------------------

/**
 * The Claude Agent SDK's own check (sdk.mjs, CLAUDE_SDK_CAN_USE_TOOL_SHADOWED): with a
 * `canUseTool` callback, `bypassPermissions` or any bare `allowedTools` entry auto-approves calls
 * before the callback is consulted. Returns the shadowed names, or `undefined` when none are.
 */
function shadowedByOptions(options: Options): string[] | undefined {
  if (options.canUseTool === undefined) return undefined;
  if (options.permissionMode === "bypassPermissions") return ["*"];
  const bare = (options.allowedTools ?? []).filter((name) => name !== "" && !name.includes("("));
  return bare.length > 0 ? bare : undefined;
}

describe("ClaudeAgentRuntime: one tool gate and structured results (T818)", () => {
  const report = z.object({
    changes: z.array(z.object({ id: z.string(), status: z.enum(["applied", "skipped"]) })),
    path: z.string().optional(),
  });
  const profiles = ["none", "read-only", "edit-repo"] as const;

  it.each(
    profiles.flatMap((profile) => [
      { profile, output: false },
      { profile, output: true },
    ]),
  )("auto-approves nothing outside the gate ($profile, output $output)", async (c) => {
    const { runtime, calls } = setup([success({ structured_output: { changes: [] } })]);
    await runtime.runPhase(
      request({
        profile: c.profile,
        ...(c.output ? { output: { name: "code_change_report", schema: report } } : {}),
      }),
    );
    const options = onlyCall(calls);
    expect(shadowedByOptions(options)).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    // Nothing prompts in a non-interactive run: the hook allows or denies every call, and the
    // callback (consulted only if the SDK still wants a decision) repeats the same gate.
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.permissionPromptToolName).toBeUndefined();
    expect(typeof options.canUseTool).toBe("function");
    // The gate runs for every tool: no matcher narrows it.
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(options.hooks?.PostToolUse?.[0]?.matcher).toBeUndefined();
    expect(options.hooks?.PostToolUseFailure?.[0]?.matcher).toBeUndefined();
    // The SDK adds StructuredOutput itself when outputFormat is set; it is never a listed tool.
    expect(options.tools).not.toContain("StructuredOutput");
    expect(options.disallowedTools).not.toContain("StructuredOutput");
    expect(options.outputFormat?.type).toBe(c.output ? "json_schema" : undefined);
  });

  it.each(profiles)(
    "lets the %s agent return its structured result through StructuredOutput",
    async (profile) => {
      const events: RuntimeEvent[] = [];
      const answer = { changes: [{ id: "c1", status: "applied" }], path: "/etc/passwd" };
      const { runtime, audit, outcomes } = setup([
        init(),
        { tool: "StructuredOutput", input: answer, response: "Structured output provided" },
        success({ result: "", structured_output: answer }),
      ]);
      const result = await runtime.runPhase(
        request({
          phase: "adapt",
          profile,
          output: { name: "code_change_report", schema: report },
          onEvent: (event) => events.push(event),
        }),
      );
      expect(outcomes[0]?.hook).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      });
      expect(outcomes[0]?.executed).toBe(true);
      expect(events.some((event) => event.kind === "tool-denied")).toBe(false);
      expect(result).toMatchObject({ ok: true, stopReason: "completed", output: answer });
      // The call is audited, but its input (the phase's answer) is not copied into the target.
      const entry = audit.entries.find((e) => e.kind === "tool-call");
      expect(entry).toMatchObject({ action: "StructuredOutput", decision: "allow" });
      expect(entry).not.toHaveProperty("target");
    },
  );

  it("denies StructuredOutput when the phase asked for no structured result", async () => {
    const { runtime, audit, outcomes } = setup([
      { tool: "StructuredOutput", input: { anything: true } },
      success(),
    ]);
    await runtime.runPhase(request({ profile: "edit-repo" }));
    expect(outcomes[0]?.executed).toBe(false);
    expect(audit.entries.find((e) => e.kind === "tool-denied")).toMatchObject({
      action: "StructuredOutput",
      decision: "deny",
      detail: expect.stringMatching(/structured result/),
    });
  });

  it("the pre-tool-use hook alone denies what the policy denies and runs what it allows", async () => {
    const inside = resolve(ROOT, "main.py");
    const outside = resolve(ROOT, "..", "elsewhere", "notes.txt");
    const steps: ToolStep[] = [
      { tool: "Bash", input: { command: "python -c 'print(1)'" } },
      { tool: "Bash", input: { command: "bash -c 'ls'" } },
      { tool: "Bash", input: { command: "node -e 'process.exit(0)'" } },
      { tool: "Bash", input: { command: "sh -c 'cat /etc/passwd'" } },
      { tool: "Read", input: { file_path: outside } },
      { tool: "Write", input: { file_path: outside, content: "x" } },
      { tool: "Edit", input: { file_path: outside, old_string: "a", new_string: "b" } },
      { tool: "Glob", input: { pattern: "../**/*" } },
      { tool: "Grep", input: { pattern: "password", path: resolve(ROOT, "..", "elsewhere") } },
      { tool: "WebFetch", input: { url: "https://example.com", prompt: "read" } },
      { tool: "WebSearch", input: { query: "opscrew" } },
      { tool: "Task", input: { prompt: "help" } },
      { tool: "mcp__github__create_pull_request", input: {} },
      { tool: "mcp__other__x", input: {} },
      { tool: "mcp__opscrew__hetzner_list_offers", input: { location: "fsn1" } },
      { tool: "SomethingNew", input: {} },
      // allowed
      { tool: "Read", input: { file_path: inside } },
      { tool: "Edit", input: { file_path: inside, old_string: "a", new_string: "b" } },
      { tool: "Grep", input: { pattern: "REDIS_URL" } },
      { tool: "StructuredOutput", input: { changes: [] } },
    ];
    const { runtime, audit, outcomes } = setup([init(), ...steps, success()]);
    await runtime.runPhase(
      request({
        phase: "adapt",
        profile: "edit-repo",
        output: { name: "code_change_report", schema: report },
      }),
    );
    const executed = outcomes.map((o) => `${o.tool}:${o.executed}`);
    expect(executed).toEqual([
      "Bash:false",
      "Bash:false",
      "Bash:false",
      "Bash:false",
      "Read:false",
      "Write:false",
      "Edit:false",
      "Glob:false",
      "Grep:false",
      "WebFetch:false",
      "WebSearch:false",
      "Task:false",
      "mcp__github__create_pull_request:false",
      "mcp__other__x:false",
      "mcp__opscrew__hetzner_list_offers:false",
      "SomethingNew:false",
      "Read:true",
      "Edit:true",
      "Grep:true",
      "StructuredOutput:true",
    ]);
    const denied = audit.entries.filter((e) => e.kind === "tool-denied");
    expect(denied).toHaveLength(16);
    expect(denied.map((e) => e.action)).toEqual(
      executed.filter((e) => e.endsWith(":false")).map((e) => e.split(":")[0]),
    );
    expect(audit.entries.filter((e) => e.kind === "tool-call").map((e) => e.action)).toEqual([
      "Read",
      "Edit",
      "Grep",
      "StructuredOutput",
    ]);
  });

  it("a permission callback after the hook repeats its decision: one evaluation, one audit", async () => {
    const evaluate = vi.fn(new DefaultToolPolicy().evaluate.bind(new DefaultToolPolicy()));
    const { runtime, audit, outcomes } = setup(
      [
        { tool: "Bash", input: { command: "python3 script.py" }, via: "both" },
        { tool: "Read", input: { file_path: resolve(ROOT, "a.txt") }, via: "both" },
        { tool: "StructuredOutput", input: { changes: [] }, via: "both" },
        success({ structured_output: { changes: [] } }),
      ],
      { policy: { evaluate } },
    );
    const result = await runtime.runPhase(
      request({
        phase: "adapt",
        profile: "edit-repo",
        output: { name: "code_change_report", schema: report },
      }),
    );
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => [o.executed, o.permission?.behavior])).toEqual([
      [false, "deny"],
      [true, "allow"],
      [true, "allow"],
    ]);
    expect(audit.entries.filter((e) => e.kind === "tool-denied")).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------------------------

describe("ClaudeAgentRuntime result mapping", () => {
  it("maps a successful result with cost, turns, session and model", async () => {
    const { runtime, ledger, audit } = setup([init("claude-opus-5-5"), success()]);
    const result = await runtime.runPhase(request());
    expect(result).toEqual({
      ok: true,
      stopReason: "completed",
      text: "All done.",
      costUsd: 0.42,
      turns: 3,
      sessionId: SESSION,
      model: "claude-opus-5-5",
    });
    expect(ledger).toEqual([{ phase: "analyze", model: "claude-opus-5-5", costUsd: 0.42 }]);
    expect(audit.entries.find((entry) => entry.kind === "phase")).toMatchObject({
      action: "analyze",
      sessionId: SESSION,
    });
  });

  it("falls back to the requested model when the SDK names none", async () => {
    const { runtime } = setup([success({ modelUsage: {} })]);
    const result = await runtime.runPhase(request({ model: "claude-sonnet-5" }));
    expect(result.model).toBe("claude-sonnet-5");
  });

  const schema = z.object({ framework: z.string(), port: z.number().int() });
  const output = { name: "architecture_summary", schema };

  it("returns validated structured output", async () => {
    const { runtime } = setup([success({ structured_output: { framework: "next", port: 3000 } })]);
    const result = await runtime.runPhase(request({ output }));
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.output).toEqual({ framework: "next", port: 3000 });
  });

  it("falls back to JSON in the result text when structured_output is absent", async () => {
    const { runtime } = setup([
      success({ result: '```json\n{"framework":"vite","port":5173}\n```' }),
    ]);
    const result = await runtime.runPhase(request({ output }));
    expect(result.output).toEqual({ framework: "vite", port: 5173 });
  });

  it("fails with invalid_output when the output does not match the schema (US4-1)", async () => {
    const { runtime, ledger } = setup([
      success({ structured_output: { framework: "next", port: "3000" } }),
    ]);
    const result = await runtime.runPhase(request({ output }));
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("invalid_output");
    expect(result).not.toHaveProperty("output");
    expect(result.error).toMatch(/architecture_summary/);
    expect(result.error).toMatch(/port/);
    expect(ledger).toHaveLength(1);
  });

  it("maps structured-output retry exhaustion to invalid_output", async () => {
    const { runtime } = setup([failure("error_max_structured_output_retries")]);
    const result = await runtime.runPhase(request({ output }));
    expect(result).toMatchObject({ ok: false, stopReason: "invalid_output" });
    expect(result.output).toBeUndefined();
  });

  it("maps a budget stop and records the spend (US4-2)", async () => {
    const { runtime, ledger } = setup([init(), failure("error_max_budget_usd")]);
    const result = await runtime.runPhase(request({ maxBudgetUsd: 1 }));
    expect(result).toMatchObject({
      ok: false,
      stopReason: "budget_exceeded",
      costUsd: 1.5,
      turns: 7,
    });
    expect(result.error).toMatch(/\$1\b/);
    expect(ledger).toEqual([{ phase: "analyze", model: "claude-opus-5-5", costUsd: 1.5 }]);
  });

  it("maps a max-turns stop", async () => {
    const { runtime } = setup([failure("error_max_turns")]);
    const result = await runtime.runPhase(request({ maxTurns: 7 }));
    expect(result).toMatchObject({ ok: false, stopReason: "max_turns" });
    expect(result.error).toMatch(/7 turns/);
  });

  it("maps a refusal", async () => {
    const { runtime } = setup([success({ stop_reason: "refusal", result: "I can't help." })]);
    const result = await runtime.runPhase(request());
    expect(result).toMatchObject({ ok: false, stopReason: "refused" });

    const viaNotice = setup([
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        session_id: SESSION,
      } as unknown as SDKMessage,
      success(),
    ]);
    expect((await viaNotice.runtime.runPhase(request())).stopReason).toBe("refused");
  });

  it("maps execution errors to error with redacted, plain-English text", async () => {
    const token = fakeSecret("github-token");
    const { runtime } = setup([
      failure("error_during_execution", { errors: [`API rejected ${token}`] }),
    ]);
    const result = await runtime.runPhase(request());
    expect(result).toMatchObject({ ok: false, stopReason: "error" });
    expect(result.error).toMatch(/API rejected/);
    expect(result.error).not.toContain(token);
  });

  it("maps an is_error success to error", async () => {
    const { runtime } = setup([success({ is_error: true, result: "Overloaded" })]);
    const result = await runtime.runPhase(request());
    expect(result).toMatchObject({ ok: false, stopReason: "error", error: "Overloaded" });
  });

  it("returns an error result when query() throws", async () => {
    const { runtime, ledger } = setup([{ throw: new Error("spawn claude ENOENT") }]);
    const result = await runtime.runPhase(request());
    expect(result).toMatchObject({ ok: false, stopReason: "error", costUsd: 0 });
    expect(result.error).toMatch(/ENOENT/);
    expect(ledger).toEqual([]);
  });

  it("returns an error when the stream ends without a result", async () => {
    const { runtime } = setup([init()]);
    const result = await runtime.runPhase(request());
    expect(result).toMatchObject({ ok: false, stopReason: "error" });
  });

  it("maps an abort through the signal", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const steps: Step[] = [init(), { throw: abortError }];
    const { runtime, calls } = setup(steps);
    const pending = runtime.runPhase(request({ signal: controller.signal }));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, stopReason: "aborted" });
    expect(onlyCall(calls).abortController?.signal.aborted).toBe(true);
  });

  it("does not start the agent when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime, calls } = setup([success()]);
    const result = await runtime.runPhase(request({ signal: controller.signal }));
    expect(result.stopReason).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("redacts streamed assistant text and the final text", async () => {
    const token = fakeSecret("github-token");
    const events: RuntimeEvent[] = [];
    const { runtime } = setup([
      init(),
      assistant(`I found ${token} in .env`),
      success({ result: `Remove ${token} from the repo.` }),
    ]);
    const result = await runtime.runPhase(request({ onEvent: (event) => events.push(event) }));
    const texts = events.filter((event) => event.kind === "assistant-text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.message).toContain("I found");
    expect(texts[0]?.message).not.toContain(token);
    expect(result.text).toContain("Remove");
    expect(result.text).not.toContain(token);
  });

  it("keeps running when the onEvent listener throws", async () => {
    const { runtime } = setup([init(), assistant("hello"), success()]);
    const result = await runtime.runPhase(
      request({
        onEvent: () => {
          throw new Error("listener bug");
        },
      }),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Ungated calls and hook timeouts
// ---------------------------------------------------------------------------------------------

describe("ClaudeAgentRuntime ungated tool calls", () => {
  it("stops the phase when a tool ran without passing the gate", async () => {
    const { runtime, audit, outcomes, ledger } = setup([
      init(),
      { tool: "Bash", input: { command: "rm -rf build" }, id: "ungated-1", via: "none" },
      { tool: "Read", input: { file_path: resolve(ROOT, "a.txt") } },
      success(),
    ]);
    const result = await runtime.runPhase(request({ phase: "adapt", profile: "edit-repo" }));
    // The phase stopped right after the ungated call; nothing later ran.
    expect(outcomes.map((o) => o.tool)).toEqual(["Bash"]);
    expect(outcomes[0]?.post).toMatchObject({ continue: false });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/without passing its safety gate/);
    expect(result.error).toMatch(/managed/i);
    expect(ledger).toEqual([]);
    const entry = audit.entries.find((e) => e.kind === "tool-call");
    expect(entry).toMatchObject({
      action: "Bash",
      actor: "agent",
      target: "rm -rf build",
      detail: expect.stringMatching(/^ungated/),
    });
    expect(entry).not.toHaveProperty("decision");
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "phase",
      detail: expect.stringMatching(/^error/),
    });
  });

  it("treats a call that ran after the gate denied it as ungated", async () => {
    const audit = new MemoryAuditLog();
    const runtime = new ClaudeAgentRuntime({
      policy: new DefaultToolPolicy(),
      audit,
      redact: (text) => text,
      env: { ANTHROPIC_API_KEY: "test" },
      queryFn: (params) => {
        const options = params.options ?? {};
        return (async function* () {
          const signal = new AbortController().signal;
          const base = { session_id: SESSION, transcript_path: "", cwd: ROOT };
          const input = { command: "curl https://example.com" };
          await options.hooks?.PreToolUse?.[0]?.hooks[0]?.(
            {
              ...base,
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: input,
              tool_use_id: "t1",
            },
            "t1",
            { signal },
          );
          await options.hooks?.PostToolUse?.[0]?.hooks[0]?.(
            {
              ...base,
              hook_event_name: "PostToolUse",
              tool_name: "Bash",
              tool_input: input,
              tool_response: "ok",
              tool_use_id: "t1",
            },
            "t1",
            { signal },
          );
          if (options.abortController?.signal.aborted === true) throw new AbortError("aborted");
          yield success();
        })();
      },
    });
    const result = await runtime.runPhase(request({ phase: "adapt", profile: "edit-repo" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/safety gate/);
    expect(audit.entries.map((e) => e.kind)).toEqual(["tool-denied", "tool-call", "phase"]);
  });
});

describe("ClaudeAgentRuntime hook timeouts", () => {
  it("gives the gate time for a human approval and the post hook a short limit", async () => {
    const { runtime, calls } = setup([success()]);
    await runtime.runPhase(request());
    const hooks = onlyCall(calls).hooks;
    expect(hooks?.PreToolUse?.[0]?.timeout).toBe(30 * 60);
    expect(hooks?.PostToolUse?.[0]?.timeout).toBe(60);
    expect(hooks?.PostToolUseFailure?.[0]?.timeout).toBe(60);
  });

  it("denies the call when the gate's hook is cancelled while waiting for approval", async () => {
    const { runtime, calls, audit } = setup([success()], {
      policy: stubPolicy({ decision: "ask", reason: "Needs a person." }),
      // An approval that never answers, as a person away from the keyboard.
      approvals: { request: () => new Promise(() => {}) },
    });
    await runtime.runPhase(request({ phase: "adapt", profile: "edit-repo" }));
    const options = onlyCall(calls);
    const hookTimedOut = new AbortController();
    const pending = options.hooks?.PreToolUse?.[0]?.hooks[0]?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "slow-1",
        session_id: SESSION,
        transcript_path: "",
        cwd: ROOT,
      },
      "slow-1",
      { signal: hookTimedOut.signal },
    );
    hookTimedOut.abort();
    expect(await pending).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // The permission callback, if the SDK falls back to it, repeats the denial.
    const permission = await options.canUseTool?.(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "slow-1", requestId: "r1" },
    );
    expect(permission).toMatchObject({ behavior: "deny" });
    expect(audit.entries.find((e) => e.kind === "tool-denied")).toMatchObject({
      action: "Bash",
      detail: expect.stringMatching(/too long/),
    });
  });
});
