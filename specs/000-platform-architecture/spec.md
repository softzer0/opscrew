# Feature Specification: Platform Architecture (monorepo foundation)

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/000-platform-architecture`)
**Created**: 2026-10-11
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, sections 2, 3, 7 and 8c: "Monorepo foundation: shared contracts,
artefact schemas, core safety/audit/approval/runtime infrastructure, package scaffolds and ADRs."

## User Scenarios & Testing *(mandatory)*

The users of this feature are OpsCrew contributors and the later features (001 scan-and-plan,
002 hetzner-deploy) that build on it. End users see its effects as consistent artefacts, a safety
gate that cannot be bypassed, and secrets that never leak.

### User Story 1 - One-command build health for the whole repo (Priority: P1)

A contributor clones the repo, installs dependencies and runs one command that lints, type-checks
and tests every package. Every package has the same layout, so a new contributor (human or agent)
knows where code, tests and exports live.

**Why this priority**: every later task's `Verify:` command depends on this working.

**Independent Test**: fresh clone → `pnpm install` → `pnpm check` exits 0.

**Acceptance Scenarios**:

1. **Given** a fresh clone with Node 22 and pnpm 10, **When** the contributor runs `pnpm install`
   then `pnpm check`, **Then** lint, typecheck and tests all pass with exit code 0.
2. **Given** any package, **When** a contributor runs
   `pnpm turbo run typecheck test --filter=<package>`, **Then** only that package and its
   dependencies are checked.

---

### User Story 2 - Validated artefacts shared by every phase (Priority: P1)

Every phase reads and writes the same three committed artefacts (`opscrew/architecture.json`,
`opscrew/requirements.yaml`, `opscrew/plan.yaml`). A file that is malformed or edited into an
invalid state is rejected with a plain-English message naming the field and the fix, never with a
stack trace.

**Why this priority**: the artefacts are the contract between agents, the CLI and the MCP server.

**Independent Test**: round-trip valid fixtures through write → read; feed invalid fixtures and
check the error messages.

**Acceptance Scenarios**:

1. **Given** a valid plan object, **When** it is written and read back, **Then** the result is
   deeply equal and the YAML on disk is stable (same input → byte-identical output).
2. **Given** a `plan.yaml` with `target.serverType` missing, **When** it is read, **Then** the
   error says which file and field are wrong and suggests re-running `opscrew design`.
3. **Given** the schemas, **When** JSON Schema files are generated, **Then** they are draft-07 and
   match the committed copies in `packages/plan-schema/schemas/`.

---

### User Story 3 - A safety gate later features inherit automatically (Priority: P1)

Any feature that mutates infrastructure, a repository or a remote host gets, for free: secret
redaction of everything shown or logged, an audit log entry for every mutation and decision,
approvals bound to the SHA-256 hash of the exact plan, typed confirmation for destructive
operations, and a tool-call policy that denies dangerous agent actions in every permission mode.

**Why this priority**: constitution principles I and IV are non-negotiable; building them once,
centrally, is the only way to make them hold everywhere.

**Independent Test**: unit tests drive the redactor, audit log, approval gate and tool policy with
crafted inputs (fake secrets, destructive commands, mismatched hashes).

**Acceptance Scenarios**:

1. **Given** a string containing a GitHub token, an Anthropic key and a registered literal secret,
   **When** it is redacted, **Then** none of the three values appear in the output and each is
   replaced by a label such as `[REDACTED:github-token]`.
2. **Given** an approval recorded for plan hash `A`, **When** an apply is requested for hash `B`,
   **Then** the gate refuses and the audit log records the refusal.
3. **Given** a plan containing deletions, **When** approval is requested, **Then** the user must
   type the confirmation phrase exactly; any other input is a refusal.
4. **Given** an agent in the `read-only` profile, **When** it calls `Write`, `Edit` or `Bash`,
   **Then** the tool policy denies the call with a reason. **Given** any profile, **When** an agent
   calls `Bash` with `tofu destroy`, `terraform apply`, `git push`, `rm -rf /` or
   `curl … | sh`, **Then** the call is denied.
5. **Given** an agent in any profile, **When** it tries to read `.env`, a private key, Terraform
   state or a file outside the project root, **Then** the call is denied.

---

### User Story 4 - Run an LLM phase safely behind one contract (Priority: P2)

A feature author runs an LLM-backed phase (for example the Analyst) by building a `PhaseRequest`
(system prompt, prompt, tool profile, optional in-process tools, optional output schema, budget)
and gets back a `PhaseResult` with schema-validated output, cost and stop reason. The Claude Agent
SDK sits behind the contract; tests use a fake runtime and never call a model.

**Why this priority**: needed by 001 (analyze, adapt) but not by deterministic parts.

**Independent Test**: the Claude adapter is unit-tested with a mocked SDK `query()`; agents are
tested with the fake runtime.

**Acceptance Scenarios**:

1. **Given** a request with an output schema, **When** the model returns output that fails the
   schema, **Then** the result has `ok: false`, `stopReason: "invalid_output"` and no `output`.
2. **Given** a request with `maxBudgetUsd`, **When** the run exceeds it, **Then** the result has
   `stopReason: "budget_exceeded"` and the cost ledger records the spend.
3. **Given** a tool call that the tool policy denies, **When** the model makes it, **Then** the SDK
   receives a deny decision with the reason, the call never executes, and the audit log records it.
4. **Given** environment variables containing provider tokens (`HCLOUD_TOKEN`,
   `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`), **When** the runtime starts the agent process, **Then**
   those variables are not passed to it.
5. **Given** no Anthropic credentials, **When** `isConfigured()` is called, **Then** it returns
   `ok: false` with a plain-English hint (set `ANTHROPIC_API_KEY`, or Bedrock/Vertex/Foundry vars).

---

### User Story 5 - A runnable `opscrew` CLI skeleton (Priority: P3)

A user runs `opscrew --version`, `opscrew --help` and `opscrew status` from the bundled CLI. Later
features add commands to the same program.

**Why this priority**: gives later features a home; low risk.

**Independent Test**: build the CLI bundle and run it with Node in a temp project directory.

**Acceptance Scenarios**:

1. **Given** the bundle is built, **When** `node packages/cli/dist/opscrew.js --version` runs,
   **Then** it prints the package version and exits 0.
2. **Given** a directory with no `opscrew/` folder, **When** `opscrew status` runs, **Then** it says
   no phases have run yet and suggests `opscrew scan`.

### Edge Cases

- Windows paths (`D:\x\y`), paths with spaces, CRLF line endings in YAML input.
- Concurrent appends to the same JSONL file (audit log, approvals) must not interleave lines.
- Redaction must not corrupt non-secret text (no over-redaction of normal words, hashes or UUIDs
  that are not secrets) and must handle secrets split across lines in PEM blocks.
- Approval store file missing, empty, or containing a corrupted line (skip the bad line, warn).
- `OPSCREW_HOME` override for the user-level directory (tests and CI).
- Plan hash comparison is case-insensitive hex and rejects empty or non-hex input.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST provide `pnpm check` (lint + typecheck + test) and per-package
  `typecheck` and `test` scripts orchestrated by Turborepo.
- **FR-002**: The repository MUST contain these packages with the standard layout (`package.json`,
  `tsconfig.json`, `src/index.ts`): contracts, plan-schema, core, runtime-claude, detect, secops,
  agents, iac-engine, iac-templates, connectors/github, connectors/hetzner, connectors/cloudflare,
  cli (`opscrew`), mcp-server.
- **FR-003**: `@opscrew/contracts` MUST define the cross-package interfaces: agent runtime, tool
  definitions, approvals, audit, tool policy, IaC engine, connectors and compute catalog, scanners
  and findings, policy and check results, command runner, remote exec, reporter.
- **FR-004**: `@opscrew/plan-schema` MUST define zod schemas, inferred types, read/write helpers and
  draft-07 JSON Schema export for `architecture.json`, `requirements.yaml` and `plan.yaml`, plus
  the non-persisted `Question` and `DesignOption` shapes used by the MCP server.
- **FR-005**: Reading an artefact MUST return either a fully validated object or an error that
  names the file, the field path and a next step; it MUST accept CRLF input and BOMs.
- **FR-006**: `@opscrew/core` MUST provide project path resolution (`opscrew/`, `.opscrew/`,
  `~/.opscrew/` with `OPSCREW_HOME` override, stable project id), a user-facing error type, a
  redactor, a JSONL audit log, a JSONL approval store, an approval gate, a default tool policy, an
  environment sanitizer for agent processes, a Node command runner, a project state store and a
  cost ledger.
- **FR-007**: The redactor MUST mask at least: GitHub tokens (classic and fine-grained), Anthropic
  and OpenAI keys, AWS access keys and secret keys in assignments, Stripe secret keys, Slack tokens,
  Google API keys, Hetzner and Cloudflare tokens when labelled, JWTs, PEM private-key blocks,
  passwords in URLs, plus any literal value registered at runtime.
- **FR-008**: The approval gate MUST bind `iac-apply` approvals to a plan hash, require
  `allowDestroy` plus an exact typed phrase for destructive changes, record every decision (approved
  or not) in the approval store and the audit log, and expose `assertApprovedPlan(hash)` for the IaC
  engine caller.
- **FR-009**: The default tool policy MUST implement the profiles `none`, `read-only` and
  `edit-repo`, deny destructive or exfiltrating Bash commands in every profile, deny reads of
  secret files and paths outside the project root (checked where symbolic links really lead when a
  `realpath` function is supplied, which the CLI does), ask before running project code (package
  managers, build and test runners), deny git writes, and deny writes outside the project root or
  into `.git/`, `.opscrew/`, `opscrew/` and the OpsCrew deploy workflow (OpsCrew artefacts are
  rendered deterministically, never hand-edited by an agent).
- **FR-010**: `@opscrew/runtime-claude` MUST implement `AgentRuntime` with the Claude Agent SDK:
  map profiles to SDK tool allow-lists, wire the tool policy into the SDK's pre-tool-use hook and
  permission callback, register in-process tools, request structured output when an output schema
  is given and validate it with zod, enforce `maxTurns` and `maxBudgetUsd`, sanitize the
  environment, not load user or project Claude settings, audit tool calls, redact streamed events
  and every tool result before the model sees it (post-tool-use `updatedToolOutput`), and record
  cost in the cost ledger.
- **FR-011**: `@opscrew/core` MUST export a `FakeAgentRuntime` (subpath `@opscrew/core/testing`)
  that returns scripted results and records requests, for use in other packages' tests.
- **FR-012**: The `opscrew` CLI MUST provide `--version`, `--help` and `status`, a terminal
  reporter, an interactive approval handler (TTY) and a non-interactive approval handler that
  approves an `iac-apply` only when its plan hash matches `--approve <hash>` and nothing is
  destroyed; with `--yes` it also approves writing generated files, storing GitHub deploy secrets,
  pushing and opening pull requests, never destroys, changed host keys or agent tool calls. Every
  command exits 0 when done, 1 when it stopped on purpose (refused or cancelled approval, failed
  policy or check, an earlier step not run yet) and 2 when it could not run. The CLI MUST bundle to
  a single executable file for Node ≥ 20.19 (entry `src/bin.ts`; `src/index.ts` exports the
  programmatic API).
- **FR-013**: ADRs MUST record: agent runtime choice, dual IaC engine, licensing, deterministic-first
  phases, and source-consumed packages with a bundled CLI.

### Key Entities

- **Architecture** (`opscrew/architecture.json`): detected project facts plus a narrative summary
  and risks; produced by `analyze`.
- **Requirements** (`opscrew/requirements.yaml`): the user's answers about scale, budget, region,
  uptime, data criticality, domain and DNS; produced by `interview`.
- **Deploy plan** (`opscrew/plan.yaml`): chosen target, sizing, cost estimate, code changes, IaC,
  DNS, CI/CD and security settings, approvals history and deployment state; produced by `design`
  and updated by later phases.
- **Approval record**: who approved what (kind, title, plan hash, allowDestroy) and when.
- **Audit entry**: one redacted line per tool call, denial, approval, IaC run, provider call, git
  operation or secret upload.
- **Project state**: which phases have run, when, and with what result; plus the cost ledger.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `pnpm check` passes on a fresh clone in under 3 minutes on a typical laptop.
- **SC-002**: 100% of the secret samples in the redaction test corpus are masked, and 0 of the
  benign samples are altered.
- **SC-003**: 100% of the destructive and exfiltrating command samples in the policy test corpus
  are denied in every profile; 100% of allowed read-only samples pass in `read-only`.
- **SC-004**: An apply with a mismatched or unapproved plan hash is refused in 100% of tests.
- **SC-005**: The bundled CLI starts and prints `--help` in under 1 second.

## Assumptions

- Contributors use Node.js 22 (minimum 20.19) and pnpm 10; Windows, macOS and Linux are supported.
- Users bring their own model access (Anthropic API key, Bedrock, Vertex AI or Foundry). Claude
  subscription users are served by the plugin path (feature 001), not by this runtime.
- The artefact schemas start at `schemaVersion: 1`; migrations are out of scope until version 2.
- Provider adapters, scanners and the IaC engine are implemented in features 001 and 002; this
  feature only defines their contracts and scaffolds their packages.
