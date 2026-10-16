# ADR 0013: Simplifying the contracts after features 000–010

- Status: accepted
- Date: 2026-10-16
- Decision makers: founder, lead

## Context

A review of all code built so far for overengineering (`specs/010-portainer-target/simplification.md`)
found contract surfaces that nothing uses, optional members that exist only so test fakes can leave
them out, and fields kept for releases that never shipped. OpsCrew has not been released, so there
is nothing to stay compatible with.

## Decision

- The in-process tool path goes: `ToolDefinition`, `ToolContext`, `ToolResult`, `mutates`,
  `PhaseRequest.builtinTools` and `tools`, and `Connector.tools()`. Phases reach providers through
  the typed connectors and the deterministic MCP server; the runtime's policy denies every `mcp__`
  tool.
- `findApprovedPlan` leaves the approvals contract; core keeps one table of approval checks.
- `IacEngine`'s provider-schema and state-resource reads and the registrar's `capabilities` become
  required; fakes implement them and the fallbacks go.
- A registration quote carries the registrar's agreement types instead of rebuilding them from
  display text.
- Provider ids, fields and options nothing reads are removed (`aws`, `gcp`, `azure` and `contabo`
  return with the features that build them).
- `requirements.provider` and the facts' `appDir` become required; the "before 004" and "older
  facts" defaults go.

## Consequences

- The safety core is unchanged: plan, policy, an approval bound to the plan's SHA-256 and apply
  through the IaC engine or a typed adapter; typed confirmation for deletions; redaction.
- Projects made before these changes may need `opscrew design` again.
- The provider plugin system (feature 015) designs its own versioned contract instead of reviving
  the in-process tools.
