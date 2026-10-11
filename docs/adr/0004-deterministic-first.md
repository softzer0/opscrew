# ADR 0004: Deterministic phases, models only where they add judgment

- Status: accepted (2026-10-11)

## Context

The "agent swarm" could be built as many free-running agents. That is expensive, hard to test and
hard to make safe, and most steps (detection, sizing, pricing, rendering, policies, scanning) have
correct deterministic answers.

## Decision

Phases are workflows. Models run in exactly two places in v1: the read-only Analyst (refines the
summary, risks and a few facts) and the edit-repo Code-change agent (adapts application code). Their
outputs are validated with zod before use. The scan, interview, design, rendering, provisioning,
policies, hardening checks and verification are deterministic. The MCP server never calls a model.

## Consequences

- The free `opscrew scan` costs nothing and runs offline.
- Plugin users get the same deterministic tools; their own agent supplies the reasoning.
- Adding model-driven steps later requires an output schema and a fallback path.
