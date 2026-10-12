# OpsCrew — agent guidance

OpsCrew is an open-source crew of AI agents that takes an app from a GitHub repo to a hardened
production deployment on the user's own cloud (Hetzner Cloud or DigitalOcean, plus Cloudflare),
with Terraform or OpenTofu, and keeps it secure. Read `.specify/memory/constitution.md` before changing anything;
it is the source of truth and overrides this file.

## Where things are

- `specs/NNN-name/` — Spec Kit feature artefacts: `spec.md`, `plan.md`, `research.md`,
  `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`.
- `packages/contracts` — shared TypeScript interfaces (`@opscrew/contracts`). One owner per
  contract; consumers import only from the package root.
- `packages/plan-schema` — zod schemas for `opscrew/architecture.json`, `opscrew/requirements.yaml`,
  `opscrew/plan.yaml`.
- `packages/core` — config/paths, redaction, audit log, approvals, safety policy, agent runtime
  (Claude Agent SDK adapter + fake), orchestrator, cost ledger.
- `packages/detect` — deterministic repository analysis (frameworks, platform exports, env vars).
- `packages/secops` — `opscrew scan` engine, built-in rules, optional external scanners, policies.
- `packages/agents` — Analyst, Interviewer, Architect, Code-change, Infra, Domain, SecOps, Verifier.
- `packages/iac-engine` — `tofu`/`terraform` abstraction (plan JSON, plan-hash-bound apply).
- `packages/iac-templates` — vendored HCL modules + runtime templates (compose, Caddyfile,
  cloud-init, GitHub workflow) and the renderer.
- `packages/connectors/*` — `github`, `hetzner`, `digitalocean`, `cloudflare` typed adapters (`@opscrew/connector-*`);
  phases reach a VPS provider only through `vpsConnector` and `providerProfile` in `packages/agents/src/providers`.
- `packages/cli` — the `opscrew` CLI (bundled for publishing).
- `packages/mcp-server` — deterministic MCP server (`opscrew mcp`).
- `plugin/` — Claude Code plugin (skills + MCP config).
- `examples/` — fixture apps for end-to-end tests. `docs/adr/` — architecture decision records.

## Commands

```bash
pnpm install                                   # install
pnpm check                                     # lint + typecheck + test (everything)
pnpm lint                                      # biome check .
pnpm format                                    # biome check --write .
pnpm turbo run typecheck test --filter=@opscrew/<pkg>   # one package
```

OpenTofu and Terraform binaries for local development live in `.tools/bin` (gitignored). Tests that
need them read `OPSCREW_TOFU_BIN` / `OPSCREW_TERRAFORM_BIN` or find them on `PATH`, and skip with a
clear message when absent: `PATH="$PWD/.tools/bin:$PATH" pnpm test`.

## Code conventions

- TypeScript strict ESM, `moduleResolution: Bundler`, no file extensions in relative imports.
  Each package extends `tsconfig.base.json` and exports from `src/index.ts`.
- Packages are consumed from source (`"exports": { ".": "./src/index.ts" }`); only the CLI is built.
- Never import another package's internals (`@opscrew/x/src/...`); use its root export.
- Inject side effects (fs, fetch, child processes, clock, randomness, env) through parameters or
  small interfaces so tests never touch the network, real clouds or real models.
- Validate every external input and every model output with zod before use.
- Tests: Vitest, colocated as `src/**/*.test.ts`; fixtures under `test/fixtures/` or
  `src/**/__fixtures__/`. Never commit a secret-shaped literal (it trips GitHub push protection):
  generate values with `fakeSecret(kind)` or write `{{FAKE:<kind>}}` markers in fixture files and
  copy them with `materializeFixture()` (both from `@opscrew/core/testing`).
- Errors shown to users are plain English and say what to do next. Never print secrets; route
  user-visible text through the redactor from `@opscrew/core`.
- Formatting: Biome (2 spaces, double quotes, trailing commas, width 100). Run `pnpm format`.
- Brand: **OpsCrew** in prose, `opscrew` in machine-facing names, env vars `OPSCREW_*`.

## Safety rules (constitution I and IV, non-negotiable)

- No code path applies infrastructure changes without a plan, policy checks and an approval bound
  to the plan's SHA-256 hash. Destroys need `allowDestroy` + typed resource-name confirmation.
- Secrets never go into prompts, logs, audit entries, reports, generated files or fixtures.
- Mutations go through typed adapters or the IaC engine, never ad-hoc shell commands.

## Working as an implementation subagent

- Read your task block in `specs/*/tasks.md`, the feature's `spec.md`, `plan.md` and any files
  listed under `Reads:`. Do not explore beyond what the task needs.
- Edit only files matching your task's `Owns:` globs. Never edit `tasks.md`, `specs/**`,
  `CLAUDE.md`, root config files, `pnpm-lock.yaml` or another package's files. If you need a new
  dependency or a contract change, stop and report it instead of making it.
- Test first, then implement. Run the task's exact `Verify:` command and include its output in your
  final report. Commit on your worktree branch with a Conventional Commit message ending with
  the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Detailed rules: `.claude/agents/task-implementer.md`; reviewer rules:
  `.claude/agents/task-reviewer.md`.

## Lead-only responsibilities

- Writing specs, plans, `tasks.md`, contracts, ADRs and this file; adding dependencies; merging
  branches one at a time; regenerating the lockfile; ticking tasks.
- Spec Kit v1.1.3 is pinned. Never re-run `specify init --here --force` (it can overwrite the
  constitution and templates). Spec Kit skills live in `.claude/skills/speckit-*`.
- Model routing: research with Sonnet subagents (official sources only, few fetches); coding with
  Opus subagents at the task's `Effort:` (`medium` simple, `high` default, `xhigh` complex,
  `max` rarely).
