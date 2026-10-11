# Implementation Plan: Platform Architecture (monorepo foundation)

**Branch**: `mvp` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/000-platform-architecture/spec.md`

## Summary

Build the foundation every later feature stands on: a pnpm + Turborepo monorepo of 14 packages
consumed from source, the cross-package contracts (`@opscrew/contracts`, already written by the
lead), validated artefact schemas (`@opscrew/plan-schema`), the safety core (`@opscrew/core`:
paths, errors, redaction, audit, approvals, tool policy, env sanitizer, command runner, project
state, cost ledger), the Claude Agent SDK runtime behind the `AgentRuntime` contract
(`@opscrew/runtime-claude`) with a fake runtime for tests, and a bundled `opscrew` CLI skeleton.

## Technical Context

**Language/Version**: TypeScript 7.0 (strict, ESM, `moduleResolution: Bundler`), Node.js ≥ 20.19
(developed on 22).
**Primary Dependencies**: zod 4.6 (schemas, `z.toJSONSchema` draft-7), yaml 2.9,
`@anthropic-ai/claude-agent-sdk` 0.3.x (+ peers `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`),
commander 15, @clack/prompts 1.8, picocolors, tsup 8 (CLI bundle only).
**Storage**: files only — committed artefacts in `<project>/opscrew/`, local state in
`<project>/.opscrew/`, user-level data in `~/.opscrew/` (override `OPSCREW_HOME`).
**Testing**: Vitest 5, colocated `src/**/*.test.ts`; no network, no real models, no real clouds.
**Target Platform**: Windows, macOS and Linux terminals; GitHub Actions (ubuntu-latest).
**Project Type**: monorepo of libraries + CLI + MCP server.
**Performance Goals**: `pnpm check` < 3 min; CLI `--help` < 1 s.
**Constraints**: constitution I (safety gate), IV (secrets), VI (contracts, injected side effects),
VII (offline tests).
**Scale/Scope**: 14 packages; this feature fills contracts, plan-schema, core, runtime-claude and
the CLI skeleton.

## Constitution Check

| Principle | How this feature complies |
|---|---|
| I Safety gate | `ApprovalGate` binds `iac-apply` approvals to plan SHA-256, requires `allowDestroy` + typed phrase for destroys, records every decision; `DefaultToolPolicy` denies dangerous calls in every profile and the runtime enforces it in the SDK pre-tool-use hook (which applies even in bypass modes). |
| II User owns everything | Paths module fixes the `opscrew/` / `.opscrew/` / `~/.opscrew/` split; `.opscrew/` gets its own `.gitignore` (`*`). |
| III Dual engine | Only the `IacEngine` contract here; the tool policy denies agents running `tofu`/`terraform` directly. |
| IV Secrets | `Redactor` on every output path; `sanitizeAgentEnv` strips provider tokens from the agent process; policy denies reading secret files; audit log redacts. |
| V Deterministic first | Runtime validates structured output with zod; invalid output fails the phase. |
| VI Contracts | Contracts written first by the lead; packages export only from `src/index.ts`; side effects injected (fs roots, clock, ids, runner, fetch). |
| VII Test-first | Every task has an exact Verify command; SDK mocked; corpus-based tests for redaction and policy. |
| X Simplicity | Node built-ins for fs/crypto/child_process; no logging framework; no DI container. |

No violations; Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/000-platform-architecture/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
└── contracts/README.md      # points at packages/contracts/src (canonical)
```

### Source Code (repository root)

```text
packages/
├── contracts/src/{common,io,runtime,safety,iac,connector,secops,index}.ts   # lead-owned
├── plan-schema/
│   ├── src/{facts,architecture,requirements,plan,interview,design,io,json-schema,index}.ts
│   ├── scripts/gen-schemas.ts
│   └── schemas/{architecture,requirements,plan}.schema.json                  # generated, committed
├── core/src/
│   ├── errors.ts            # OpsCrewError, ERROR_CODES (lead, done)
│   ├── paths.ts redact.ts exec.ts                    # T004
│   ├── audit.ts approvals.ts state.ts                # T005
│   ├── policy.ts env.ts                              # T006
│   ├── testing/{index,fake-runtime}.ts               # T007
│   └── index.ts             # barrel (lead, fixed; do not edit)
├── runtime-claude/src/{runtime,mapping,hooks,index}.ts   # T007
└── cli/
    ├── src/{bin,program,reporter,approval,commands/status,index}.ts         # T008
    └── tsup.config.ts
docs/adr/0001..0005-*.md     # T009 (lead)
```

**Structure Decision**: monorepo with source-consumed internal packages
(`"exports": { ".": "./src/index.ts" }`) and a tsup-bundled CLI. The Claude runtime is its own
package (`@opscrew/runtime-claude`) rather than a folder in core, so core stays free of the SDK
dependency and a provider-agnostic runtime can be added beside it (ADR 0001). This refines the
approved layout, which placed the runtime under `core/src/runtime/`.

## Key design decisions (details in research.md)

1. **Barrel files are lead-owned.** `packages/core/src/index.ts` already re-exports every module;
   implementers fill module files only, so parallel tasks never edit the same file.
2. **Audit log takes a redact function**, not the `Redactor` class, so T005 does not depend on T004.
3. **Approval binding**: the gate records approvals; `assertApprovedPlan(hash)` is called by the
   caller of `IacEngine.apply`, and the engine independently re-hashes the plan file (defence in
   depth).
4. **Tool policy fails closed**: unknown tools are denied; Bash is parsed into segments on
   `&&`, `||`, `;`, `|` and newlines; any command substitution (`$(`, backticks) is denied;
   every segment must match the allow-list or the call becomes `ask` (interactive) / deny.
5. **Agents never write `opscrew/**`**: artefacts are written by validated code; this keeps model
   output schema-checked (constitution V).
6. **Runtime settings isolation**: the Claude runtime does not load user/project Claude settings,
   so a user's personal hooks, permissions or CLAUDE.md never change OpsCrew's behaviour.
7. **Environment sanitisation**: the agent subprocess receives the parent environment minus
   provider tokens and secrets; model credentials needed by the SDK are kept.

## Verification

- Per task: the task's `Verify:` command.
- Feature: `pnpm check` green; `pnpm --filter opscrew build && node packages/cli/dist/opscrew.js --version`.
