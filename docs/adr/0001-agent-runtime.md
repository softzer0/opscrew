# ADR 0001: Claude Agent SDK behind an `AgentRuntime` contract

- Status: accepted (2026-10-11)
- Deciders: founder, lead

## Context

OpsCrew needs LLM phases (Analyst, Code-change) with tool permissions, approval prompts, hooks that
can deny dangerous calls in every mode, in-process tools, structured output, budgets and session
handling. Building that ourselves on a raw chat API is months of work; provider-agnostic agent
frameworks (Mastra, Vercel AI SDK, LangGraph) leave permissions, hooks and auditing to us.

## Decision

Use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) in a separate package
`@opscrew/runtime-claude` that implements the `AgentRuntime` contract from `@opscrew/contracts`.
All other packages depend only on the contract. A `FakeAgentRuntime` in `@opscrew/core/testing`
serves tests.

## Consequences

- Fast delivery of a safe agent loop; tool policy enforced in the SDK's pre-tool-use hook.
- Claude-only for now (Anthropic API key, Bedrock, Vertex AI, Foundry). Claude subscription users use
  the plugin path, where their own Claude Code session drives OpsCrew's deterministic MCP tools.
- The SDK is distributed under Anthropic's commercial terms (not OSI); it is an npm dependency, not
  vendored. Product copy says "Powered by Claude", never "Claude Code".
- A provider-agnostic runtime (e.g. Vercel AI SDK) can be added later as `@opscrew/runtime-<name>`.
