# OpsCrew Constitution

OpsCrew is an open-source crew of AI agents that takes an application from a GitHub repository to a
hardened production deployment on the user's own cloud account, and keeps it secure afterwards.
Primary v1 audience: "vibe coders" leaving Lovable, Bolt, Replit or v0 hosting. This constitution
governs every specification, plan, task and line of code in this repository.

## Core Principles

### I. Safety Gate on Every Mutation (NON-NEGOTIABLE)

- Every change to infrastructure, DNS, provider resources or remote hosts MUST follow
  `plan -> policy checks -> explicit human approval -> apply`. Nothing is ever auto-applied on a
  first run, and no code path may apply a change that was not shown to the user first.
- An apply MUST be bound to the exact plan that was approved: the plan file's SHA-256 hash is
  recorded with the approval, and the IaC engine refuses to apply a plan whose hash differs.
- Destructive operations (destroy, delete, replace with data loss, DNS zone deletion, server
  rebuild) are denied by default. They require an approval flagged `allowDestroy` plus a typed
  confirmation of the affected resource name.
- Safety hooks deny forbidden tool calls regardless of the agent runtime's permission mode.
- Every provider mutation and approval decision is appended to an audit log.
- Approvals in non-interactive mode MUST name the plan hash explicitly (`--approve <hash>`);
  a blanket `--yes` for applies is forbidden.
- Purchases (for example registering a domain) cost money and cannot be undone: they need an
  approval of their own kind with the price shown and a typed confirmation of the item, are never
  granted by a blanket flag, and in non-interactive mode need the exact item and a price bound.

Rationale: an agent that mutates someone's production infrastructure is only acceptable if a
human sees and approves every change.

### II. The User Owns Everything

- Every artefact OpsCrew produces is a plain, readable file in the user's repository:
  infrastructure code (HCL), CI workflows, runtime configs, plans, reports and the runbook.
  Committed artefacts live in `opscrew/`; machine-local state lives in `.opscrew/` (gitignored);
  user-level audit and sessions live in `~/.opscrew/`.
- Infrastructure modules are vendored into the user's repository; no remote module sources, no
  hidden state in an OpsCrew service, no proprietary runtime on the user's servers.
- A user who deletes OpsCrew MUST keep a working, documented deployment.
- Recommendations are made on technical merit and the user's stated budget. Affiliate or
  sponsorship relationships MUST never influence the Architect's choice, and the recommendation
  logic stays open source so this is verifiable.

### III. Dual IaC Engine: Terraform and OpenTofu

- Generated HCL MUST run unchanged with both `terraform` (>= 1.6) and `tofu` (>= 1.6) and stay in
  the common dialect subset. Engine-specific features are opt-in and gated by engine detection
  (for example OpenTofu state encryption is supplied via the `TF_ENCRYPTION` environment
  variable, never written into `.tf` files).
- All engine interaction goes through the `IacEngine` contract; agents and commands never shell
  out to `terraform` or `tofu` directly.
- Every HCL module MUST pass `validate` (and `plan` where offline-capable) under both engines in CI.
- The hosted control plane runs OpenTofu only (Terraform's BSL forbids embedding it in a competing
  hosted offering); the CLI uses whichever binary the user has installed.

### IV. Secrets Never Leak (NON-NEGOTIABLE)

- Secrets MUST NOT appear in prompts sent to a model, logs, the audit log, reports, generated
  files, test fixtures or commit history. Test secrets MUST be synthetic and clearly fake.
- Provider credentials are read from environment variables or the user's existing tooling, used
  only by the code that needs them, and never written to Terraform state or tfvars where avoidable.
- All text that leaves a trust boundary (model input, terminal output, audit entries, reports)
  passes through the shared redactor. Findings show masked evidence only.
- OpsCrew ships least-privilege credential templates per provider and asks for the narrowest
  token scope that works.

### V. Deterministic First, LLM Where It Adds Judgment

- Detection, sizing, pricing, rendering of infrastructure/runtime files, policy evaluation and
  security scanning are deterministic, testable code.
- Language models are used for exploration, explanation and adapting application code. Every
  model output that drives behaviour MUST be validated against a schema (zod) before use.
- The free `opscrew scan` MUST work with no model and no network except opt-in lookups.
- The MCP server is deterministic: in plugin mode the user's own agent does the reasoning and
  OpsCrew supplies safe, deterministic tools.

### VI. Contracts-First Package Boundaries

- Packages depend on each other only through `@opscrew/contracts` interfaces and each package's
  public `index.ts` exports. Deep imports into another package's `src/` are forbidden.
- Each contract has exactly one owning package. A contract change is its own task, reviewed on its
  own, and accompanied by an ADR in `docs/adr/` when it changes behaviour.
- Side effects (filesystem, network, subprocesses, clock, randomness) are injected so that every
  package can be tested in isolation.

### VII. Test-First and Verifiable

- New behaviour starts with a failing test. Every task names an exact `Verify:` command and is
  done only when that command passes.
- Unit tests MUST NOT call real cloud APIs, real models or the network. Connectors are tested with
  injected `fetch` fakes; the agent runtime with a fake runtime.
- Live end-to-end tests against real providers run only when their credentials are present in the
  environment (`OPSCREW_E2E_*`) and always tear down what they create.
- Tests that need external binaries (`tofu`, `terraform`, `gitleaks`, ...) skip with a clear
  message when the binary is absent.

### VIII. Official MCP for Inspection, Typed Adapters for Mutation

- Official provider MCP servers are used for inspection and documentation lookups.
- Every mutation goes through OpsCrew's own typed adapters or the IaC engine so the safety gate
  (Principle I) can see and stop it. Community MCP servers with large, unaudited tool surfaces are
  not used.

### IX. Plain Language and Honest UX

- Users are told what is about to happen and what it will cost before it happens, see the diff,
  and are never left with a hidden failure. Errors explain the next step in plain English.
- The brand is written **OpsCrew** in prose and `opscrew` in anything machine-facing (CLI, npm
  package `opscrew` and scope `@opscrew/*`, env vars `OPSCREW_*`, directories). Agents keep plain
  functional names (Analyst, Interviewer, Architect, Code-change, Infra, Domain, SecOps,
  Verifier). The product says "Powered by Claude" and never uses "Claude Code" in its naming.

### X. Simplicity and Lean Dependencies

- Prefer Node.js built-ins and small, well-maintained libraries; every new runtime dependency is
  justified in the feature's plan.
- External scanners (gitleaks, OSV-Scanner, Trivy, Conftest) are optional enhancers; built-in
  checks provide a useful baseline without them.
- YAGNI: no Kubernetes, multi-region or service mesh in v1. Start with the simplest topology that
  meets the user's stated requirements.

## Technology and Security Constraints

- Language and runtime: TypeScript (strict, ESM) on Node.js >= 22 (Node.js 20 reached end of life in
  April 2026); pnpm workspaces + Turborepo;
  TypeScript 7 for type checking; Biome for lint and format; Vitest for tests; zod 4 for schemas;
  `yaml` for YAML. Internal packages are consumed from source; the `opscrew` CLI is bundled.
- Agent runtime: the Claude Agent SDK behind the `AgentRuntime` contract (bring your own key:
  Anthropic API key, Amazon Bedrock, Google Vertex AI or Microsoft Foundry). A provider-agnostic
  runtime may be added later behind the same contract. OpsCrew never resells model tokens.
- Licensing: Apache-2.0 for everything outside `ee/`; FSL-1.1-ALv2 for `ee/`. No AGPL or
  non-commercial dependency may be linked into the CLI; such tools may only be invoked as optional
  external binaries. Semgrep-maintained rules are never used in the hosted control plane.
- Provider order: hosting on Hetzner Cloud and DigitalOcean (with Cloudflare DNS), then AWS,
  Google Cloud, Azure and Contabo; domains through Cloudflare Registrar first, then Namecheap,
  Porkbun and GoDaddy. Prices and availability are read live from provider APIs whenever
  possible; any static fallback is labelled with its date.
- CI/CD: GitHub Actions with OIDC federation for hyperscalers; per-repository deploy keys for VPS
  targets; third-party actions avoided or pinned by commit SHA.

## Development Workflow and Quality Gates

- Spec-driven: GitHub Spec Kit v1.1.3 (pinned). Specifications in `specs/NNN-name/`, one root
  `.specify/` project. Flow: specify -> clarify -> plan -> checklist -> tasks -> analyze ->
  implement -> converge. Specs, plans, `tasks.md`, contracts and `CLAUDE.md` are written by the
  lead only.
- Task format: `- [ ] T### [P] [USn] description` with sub-fields `Owns:` (globs), `Reads:`,
  `Depends:`, `Accept:` (spec IDs + Given/When/Then), `Verify:` (exact command) and `Effort:`
  (`medium` for simple tasks, `high` default, `xhigh` for complex or cross-cutting work, `max`
  only rarely; escalate only after a failed review).
- Parallel execution ("wave loop"): tasks in a wave have merged dependencies and disjoint `Owns`;
  each runs in its own worktree; each branch is checked against `Accept` by a fresh reviewer
  subagent or, for simple and medium-effort tasks, by the lead with targeted probes; the lead
  merges one branch at a time, runs the checks and ticks the task. Implementers never edit
  `tasks.md`, specs, root configuration or the lockfile.
- Model routing: research and investigation by Sonnet subagents with lean, official-source-only
  fetching; implementation by Opus subagents at the task's `Effort`.
- Definition of done: `pnpm lint`, `pnpm typecheck` and the task's tests pass; acceptance criteria
  met; reviewer found no correctness or requirement gaps; no secrets introduced; docs and runbook
  text updated when behaviour changes.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).

## Governance

- This constitution supersedes other practices in the repository. Runtime guidance for agents
  lives in `CLAUDE.md`, which MUST stay consistent with it.
- Amendments are made by pull request that edits this file, states the reason, bumps the version
  (MAJOR: principle removed or redefined; MINOR: principle or section added or materially
  expanded; PATCH: clarification) and updates dependent templates or docs in the same change.
- Every plan includes a Constitution Check; violations are either fixed or justified in the plan's
  Complexity Tracking table. Every reviewer pass checks constitution compliance.

**Version**: 1.2.0 | **Ratified**: 2026-10-11 | **Last Amended**: 2026-10-14
