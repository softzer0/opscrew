---
description: "Tasks for 001-scan-and-plan"
---

# Tasks: Scan and Plan (Phase 1a)

**Input**: `specs/001-scan-and-plan/` (spec.md, plan.md, research.md) and the foundation in
`specs/000-platform-architecture/` (data-model.md, contracts in `packages/contracts/src`).
**Numbering**: T101–T199 for this feature (feature 000 uses T001–T099, feature 002 T201–T299).
**Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.
**Rules**: barrels and registries marked lead-owned already exist — fill only your files. Fixtures
never contain secret-shaped literals: use `{{FAKE:<kind>}}` markers + `materializeFixture()` or
`fakeSecret()` from `@opscrew/core/testing`. Tests are offline (inject `fetch` / `CommandRunner`).

## Phase 1: Foundations for this feature

- [X] T101 [P] [US2] Implement deterministic repository detection in `packages/detect/src/`
  - Owns: `packages/detect/**`
  - Reads: plan.md "Detection"; 000 data-model.md `ProjectFacts`; `packages/plan-schema/src/index.ts`
  - Depends: 000/T003
  - Accept:
    - Exports `listProjectFiles(root, { maxFiles = 20000, maxFileBytes = 1_000_000, extraIgnores? }) → Promise<{ files: string[]; truncated: boolean }>`, `readGitInfo(root) → Promise<ProjectFacts["git"]>`, `parseGitRemote(url) → { remoteUrl; host?; owner?; repo? }`, `detectProject(root, { maxFiles? }) → Promise<ProjectFacts>` (validated with `ProjectFactsSchema` before returning).
    - Implements every rule in plan.md "Detection" (skip dirs, nested `.gitignore`, size limit, git files incl. worktree `.git` files, frameworks → app kind, build/start/port, env vars with `clientExposed`/`secretLikely`, services with evidence, platform fingerprints, monorepo).
    - Fixture repos in `packages/detect/test/fixtures/` (each with `expected.json` holding the expected facts subset): `lovable-vite-supabase`, `bolt-vite`, `replit-express`, `v0-next`, `base44`, `nextjs-prisma-postgres`, `nextjs-static-export`, `express-api`, `fastapi-redis`, `django-postgres`, `static-vite`, `monorepo-turbo`, `python-requirements`. Table-driven test asserts each.
    - `parseGitRemote` strips `user:pass@` and handles https, ssh, scp-like and `.git` suffixes; a test proves a token in a remote URL never appears in facts.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/detect`
  - Effort: high

- [X] T103 [P] [US3] Implement the Hetzner client, live and static catalogues and connector in `packages/connectors/hetzner/src/`
  - Owns: `packages/connectors/hetzner/**`
  - Reads: plan.md "Hetzner catalogue"; research.md "Hetzner prices"; `packages/contracts/src/connector.ts`
  - Depends: 000/T004 (OpsCrewError, redaction)
  - Accept:
    - `HetznerClient`, `HetznerCatalog`, `StaticHetznerCatalog`, `hetznerConnector()` exactly as in plan.md, with zod response schemas (passthrough), pagination, 429/5xx retry (injectable sleep), error mapping, `User-Agent: opscrew/<version>`.
    - `static-prices.ts` contains the dated table from research.md (or an empty table with `asOf` when research found no verified prices); offers with unknown prices are omitted.
    - Tests with a fake `fetch` (recorded-style JSON fixtures written by hand from the hcloud-go schema): pagination over 2 pages, 429 then success, 401 → `CREDENTIALS_INVALID`, location availability and deprecated flags, net prices parsed from strings, extras (IPv4, backup %, volume), tool definitions return redacted text.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-hetzner`
  - Effort: medium

---

## Phase 2: User Story 1 — Free security scan (P1)

- [X] T102 [US1] Implement the scan engine plus secret and config rules in `packages/secops/src/{scan,rules}/`
  - Owns: `packages/secops/src/scan/**`, `packages/secops/src/rules/secrets.ts`, `packages/secops/src/rules/secrets.test.ts`, `packages/secops/src/rules/config.ts`, `packages/secops/src/rules/config.test.ts`, `packages/secops/test/fixtures/{scan,secrets,config}/**`
  - Reads: plan.md "Scan"; spec FR-101..FR-103; `packages/contracts/src/secops.ts`; `packages/secops/src/{index,scanners}.ts` (lead-owned)
  - Depends: T101, 000/T004
  - Accept:
    - `scan/context.ts`: `createScanContext(root, { offline, fetch, runner, maxFiles? })` (files from `listProjectFiles`; `gitTracked` from `git ls-files -z` when `.git` exists and git is installed; `readFile` reads UTF-8 relative to root).
    - `scan/finding.ts`: `findingId(ruleId, file, line, rawMatch)`, `sortFindings`, `countFindings`, `SEVERITY_RANK`.
    - `scan/run.ts`: `runScan(root, { offline, fetch, runner, scanners?, version, onProgress? }) → ScanReport` per plan.md (concurrency 4, statuses, failure isolation, dedupe, sort, counts, `project` = directory name).
    - `rules/secrets.ts` `createSecretsScanner()` (`opscrew-secrets`): token families of FR-007, generic high-entropy assignments to secret-like names, private-key files/blocks, `.env` files with values (tracked → critical "committed .env", untracked but not ignored → high), placeholder filtering, masked evidence via `maskSecret`, binary/minified skip (lines > 5,000 chars skipped except PEM detection).
    - `rules/config.ts` `createConfigScanner()` (`opscrew-config`): Dockerfile without `USER` (medium), `FROM …:latest` or untagged (low), `ENV`/`ARG` with secret-like names and literal values (high), Django `DEBUG = True` (high), Flask `debug=True` (high), CORS `origin: "*"`/`allow_origins=["*"]` combined with credentials (medium), client-exposed env names containing `SECRET`, `SERVICE_ROLE`, `PRIVATE` or `PASSWORD` (critical), `.env` missing from `.gitignore` while a `.env` exists (medium).
    - Fixtures use `{{FAKE:…}}` markers; tests materialise them; a test asserts no generated fake value appears in any `Finding` field.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops`
  - Effort: high

- [X] T104 [P] [US1] Implement Supabase and Firebase rules in `packages/secops/src/rules/{supabase,firebase}.ts`
  - Owns: `packages/secops/src/rules/supabase.ts`, `packages/secops/src/rules/supabase.test.ts`, `packages/secops/src/rules/firebase.ts`, `packages/secops/src/rules/firebase.test.ts`, `packages/secops/test/fixtures/{supabase,firebase}/**`
  - Reads: plan.md "Scan"; spec FR-102; `packages/contracts/src/secops.ts`
  - Depends: 000/T004
  - Accept:
    - `createSupabaseScanner()` (`opscrew-supabase`): service-role JWT (decode payload, `role: "service_role"`) in any non-server file or any file under `src/`, `app/`, `pages/`, `components/`, `public/`, `lib/` of a frontend app → critical `supabase/service-role-in-client`; client-exposed env names with `SERVICE_ROLE` → critical; anon keys are never findings; migrations (`supabase/migrations/**/*.sql`, `**/migrations/**/*.sql`): `create table` in `public` (or unqualified) without a matching `alter table … enable row level security` anywhere in migrations → high `supabase/rls-disabled` per table (line of the create); `create policy … using (true)` or `with check (true)` on `insert|update|delete|all` → high `supabase/permissive-write-policy`; `using (true)` on `select` for tables with columns named like email/phone/address/password/token/secret → medium `supabase/public-read-sensitive`; `grant … on … to anon` with insert/update/delete/all → high; `insert into storage.buckets` / `create bucket` with `public = true` → medium. SQL parsing is tolerant (case-insensitive, comments stripped, quoted identifiers).
    - `createFirebaseScanner()` (`opscrew-firebase`): `firestore.rules`/`storage.rules` with `allow read, write: if true;` or `if request.time < timestamp.date(...)` (test mode) → critical; `allow read: if true` on collections → high; `database.rules.json` with `".read": true` or `".write": true` at root → critical.
    - Unit tests build a minimal `ScanContext` literal over materialised fixtures; at least 15 positive and 10 negative cases.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops`
  - Effort: high

- [ ] T105 [P] [US1] Implement dependency scanning (OSV) and optional external scanners in `packages/secops/src/{rules/deps.ts,lockfiles,external}/`
  - Owns: `packages/secops/src/rules/deps.ts`, `packages/secops/src/rules/deps.test.ts`, `packages/secops/src/lockfiles/**`, `packages/secops/src/external/**`, `packages/secops/test/fixtures/{deps,external}/**`
  - Reads: plan.md "Scan" (OSV + external commands); `packages/contracts/src/{secops,io}.ts`; `findExecutable` in `@opscrew/core`
  - Depends: 000/T004
  - Accept:
    - Lockfile parsers returning `{ ecosystem: "npm" | "PyPI"; name; version; file }[]` for `package-lock.json` (v2/v3 `packages`), `pnpm-lock.yaml` (v6–v9 keys), `yarn.lock` (classic and berry), `requirements*.txt` (`==` pins only), `poetry.lock`, `uv.lock`; de-duplicated.
    - `createOsvScanner()` (`osv`): skipped when `offline`; batches per plan.md through the injected `fetch`; maps severity; one finding per (package, vuln) with `ruleId: deps/<id>`, file = lockfile, remediation naming the fixed version when known; network errors → throws so the engine marks it `failed`.
    - `createGitleaksScanner()`, `createOsvScannerCli()`, `createTrivyScanner()`: `isAvailable` via `findExecutable`; commands per plan.md; defensive JSON parsing; findings namespaced `gitleaks/…`, `deps/…` (source `osv-scanner`), `trivy/…`; evidence masked again with `maskSecret`.
    - The OSV API scanner reports itself unavailable ("superseded by osv-scanner") when `osv-scanner` is installed, so the registry can list both.
    - Tests: parser fixtures for every lockfile format; fake `fetch` for OSV (batch + detail, chunking at 500, error path); fake runner JSON outputs for the three CLIs (including old/new gitleaks syntax).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops`
  - Effort: high

- [X] T106 [US1] Implement Markdown and terminal scan reports in `packages/secops/src/report/`
  - Owns: `packages/secops/src/report/**`
  - Reads: plan.md "Scan" (reports); `packages/contracts/src/secops.ts`
  - Depends: 000/T004
  - Accept: `renderScanMarkdown(report)` and `renderScanSummary(report, { color?: boolean; top?: number })` per plan.md; deterministic; no absolute paths; escapes Markdown special characters in evidence; snapshot tests for an empty report, a mixed report and a report with failed/skipped scanners.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops`
  - Effort: medium

---

## Phase 3: User Story 2 — Understand the app (P1)

- [X] T108 [P] [US1] [US2] Create example apps with expected results in `examples/`
  - Owns: `examples/**`
  - Reads: spec FR-112, US1 scenario 1, US2 scenarios 1–2; plan.md "Detection"
  - Depends: none
  - Accept:
    - `examples/lovable-supabase/`: Vite + React + TypeScript app exported Lovable-style (`lovable-tagger` devDependency, `src/integrations/supabase/client.ts` reading `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`, plus a planted `{{FAKE:supabase-service-role-jwt}}` in `src/lib/admin.ts`), `supabase/migrations/20260101000000_init.sql` creating `profiles` (with `email`) without RLS and a permissive update policy, `.env.fixture` (→ `.env`) with `{{FAKE:…}}` values, README.
    - `examples/nextjs-postgres/`: minimal real Next.js 15 app (app router, `pg`, `DATABASE_URL`, one page reading from Postgres, `next.config.mjs` without standalone) that builds with `npm install && npm run build`; no Dockerfile.
    - `examples/fastapi-redis/`: FastAPI app with `redis`, `REDIS_URL`, `requirements.txt` pinned, no health route.
    - `examples/static-vite/`: clean Vite + React static site (no secrets, no findings) with `.gitignore`.
    - Each has `expected.json`: `{ "facts": { …subset of ProjectFacts… }, "scan": { "mustInclude": [ruleIds], "clean": boolean } }`.
    - No `package-lock.json` is committed for the JS examples (keeps the repo small; the deploy Docker build runs `npm install`). No example is part of the pnpm workspace.
  - Verify: `node -e "for (const d of ['lovable-supabase','nextjs-postgres','fastapi-redis','static-vite']) JSON.parse(require('fs').readFileSync('examples/'+d+'/expected.json','utf8'))" && git grep -nE "(ghp_|sk-ant-|sk_live_|AKIA)[A-Za-z0-9]{8}" -- examples || echo "no secret literals"`
  - Effort: medium

- [ ] T109 [US2] [US3] Implement the analyze and interview phases in `packages/agents/src/{analyze,interview}/`
  - Owns: `packages/agents/src/analyze/**`, `packages/agents/src/interview/**`
  - Reads: spec US2, US3, FR-104, FR-106; plan.md "Interview, design and code changes"; `packages/agents/src/context.ts` (lead-owned `PhaseDeps`); 000 data-model.md
  - Depends: T101, 000/T003, 000/T005, 000/T007
  - Accept:
    - `analyze/`: `summarizeFacts(facts) → { summary; risks }` (deterministic plain English; risks include: no Dockerfile, no health endpoint, secrets in client env names, SQLite in production, monorepo ambiguity, unknown app kind); `renderArchitectureMarkdown(architecture)` (sections: Overview, Stack, Build and run, Configuration (env var names, client-exposed marked), Services, Platform export notes, Risks; generated-by footer); `runAnalyze(deps, { ai = true, model = "claude-haiku-5-5" })`: detect → deterministic architecture → when `ai` and `deps.runtime?.isConfigured()` ok: `runPhase` with profile `read-only`, `maxTurns` 25, `maxBudgetUsd` 0.5, output schema `{ summary: string; risks: string[]; corrections?: { appKind?; port?; startCommand?; healthEndpoint? } }`; corrections applied only to those fields and re-validated; failures fall back to deterministic with a warning; writes `architecture.json` + `ARCHITECTURE.md`, marks phase, records cost.
    - Analyst system prompt in `analyze/prompts.ts`: role, read-only, never print secret values or read `.env`/key files, focus on deployment facts; the facts JSON is passed in the prompt.
    - `interview/`: `buildQuestions(facts, previous?) → Question[]`, `answersToRequirements(answers, { now, previous? }) → Requirements`, `runInterview(deps, { ask?: (q: Question[]) => Promise<Record<string, unknown>>; answers?: Record<string, unknown> })` (answers file mode needs no `ask`; missing required answers → `INVALID_INPUT` listing them); writes `requirements.yaml`, marks phase.
    - Tests with `FakeAgentRuntime` and temp projects materialised from `examples/` (or detect fixtures): deterministic path, AI path, invalid AI output fallback, question skipping (no DB → no data-criticality question; no Supabase → no keep question; previous answers pre-filled), answers validation.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

---

## Phase 4: User Story 3 — Design (P2)

- [X] T110 [US3] Implement sizing, options, cost, code-change derivation and the design phase in `packages/agents/src/design/`
  - Owns: `packages/agents/src/design/**`
  - Reads: plan.md "Interview, design and code changes"; spec US3, FR-107; `packages/contracts/src/connector.ts`; `@opscrew/connector-hetzner` exports
  - Depends: T103, T109 (interview types), 000/T003
  - Accept:
    - `sizeFor(facts, requirements)`, `regionLocations(region)`, `buildDesignOptions({ facts, requirements, catalog, now }) → DesignOption[]` (validated with `DesignOptionListSchema`), `costFor(offer, extras, { backups })`, `deriveCodeChanges(facts, scanReport?)`, `optionToPlan(option, { facts, requirements, now, codeChanges }) → DeployPlan` (validated), `runDesign(deps, { choose?, optionId?, catalog? })` (live catalogue when `HCLOUD_TOKEN` verifies, else `StaticHetznerCatalog` with a warning; writes `plan.yaml`; marks phase).
    - All rules of plan.md (sizing table, Lean/Comfortable/Dedicated, recommended choice, x86 only, availability, backups, USD↔EUR at 1.10, cost breakdown sums, health path per framework, code changes list).
    - Tests with an in-memory catalogue: spec US3 scenarios 1–4, ARM/deprecated/unavailable exclusion, Dedicated only for high uptime or ≥ 10k users, deterministic option ids, plan validity.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

---

## Phase 5: User Story 4 — Adapt (P2)

- [X] T107 [P] [US4] Implement Docker asset templates in `packages/iac-templates/src/docker/`
  - Owns: `packages/iac-templates/src/docker/**`
  - Reads: plan.md "Docker templates"; spec FR-109; `packages/iac-templates/src/types.ts` (lead-owned)
  - Depends: 000/T003
  - Accept: `renderDockerAssets(facts, { appPort, healthPath }) → RenderedFile[]` (`Dockerfile`, `.dockerignore`, `.env.example`) for every stack in plan.md; non-root user in every image; package manager from facts (`npm ci`/`pnpm install --frozen-lockfile`/`yarn install --frozen-lockfile`, falling back to `npm install` when no lockfile); Next.js template requires `output: "standalone"` (documented in a header comment); `.env.example` lists names only; snapshot tests per stack; a test asserts no template contains a secret-shaped string.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

- [ ] T111 [US4] Implement the adapt phase (deterministic files, Code-change agent, commit, push, PR) in `packages/agents/src/adapt/`
  - Owns: `packages/agents/src/adapt/**`
  - Reads: plan.md "Adapt"; spec US4, FR-108; `@opscrew/connector-github` exports (feature 002 T203); `@opscrew/iac-templates` docker exports
  - Depends: T107, T110, 002/T203, 000/T007
  - Accept:
    - `runAdapt(deps, { ai = true, push = true, model = "claude-opus-5-5", github? })` implementing steps 1–7 of plan.md "Adapt" with `ApprovalGate` requests (`repo-write`, `git-push`, `pull-request`); refusal at any step leaves the repo as described in spec US4 scenario 4.
    - Framework playbooks in `adapt/playbooks/` (Next.js, Node server, static SPA, FastAPI, Django, generic) as plain-English instructions with acceptance checks; Code-change system prompt in `adapt/prompts.ts` (edit only listed files, keep behaviour, no secrets, no new dependencies unless unavoidable and then list them, report statuses).
    - PR body template in `adapt/pr.ts` (changes, scan summary counts, review checklist, "Opened by OpsCrew").
    - Tests use a real temporary git repo (`git init`, skipped when git is missing), `FakeAgentRuntime` that edits files through a fake tool-free script, fake GitHub client, and scripted approval handler: clean-tree precondition, branch naming, deterministic files only when missing, AI statuses, commit contents, no push on refusal, PR request shape, plan status update.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

---

## Phase 6: User Story 5 — MCP server and plugin (P3)

- [ ] T112 [US5] Implement the MCP server with the planning tools in `packages/mcp-server/src/`
  - Owns: `packages/mcp-server/src/**` except `packages/mcp-server/src/tools/deploy.ts`
  - Reads: plan.md "MCP server and plugin"; spec US5, FR-110; research.md "MCP"; installed `@modelcontextprotocol/sdk` type definitions
  - Depends: T102–T106, T109, T110
  - Accept: `createOpscrewMcpServer(deps)` registering the seven tools of FR-110 (plus `registerDeployTools` from `tools/deploy.ts`, a lead-owned stub until 002/T212); `startStdioServer(options)`; tool handlers call the deterministic package functions (never a model); outputs redacted; errors mapped to `isError` with message + hint; tests connect an in-memory client/server pair (SDK in-memory transport) and call every tool against materialised `examples/` fixtures.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server`
  - Effort: high

- [X] T113 [P] [US5] Create the Claude Code plugin and marketplace manifest in `plugin/` and `.claude-plugin/`
  - Owns: `plugin/**`, `.claude-plugin/marketplace.json`
  - Reads: research.md "Claude Code plugin format"; spec US5, FR-111
  - Depends: none
  - Accept: manifest, `.mcp.json` (`npx -y opscrew mcp`), skills `opscrew-deploy` (end-to-end flow using the MCP tools, approval rules, never run tofu/terraform/hcloud directly, never print secrets), `opscrew-scan`, `opscrew-adapt` (framework playbook summaries) with valid frontmatter, plugin README (install from marketplace, local development with `node packages/cli/dist/opscrew.js mcp`), marketplace file; a Node script `plugin/validate.mjs` checks required fields and that every skill has `name` + `description`, run by Verify.
  - Verify: `node plugin/validate.mjs`
  - Effort: medium

---

## Phase 7: CLI and end-to-end

- [ ] T114 [US1] [US2] [US3] [US4] Implement the CLI commands scan, analyze, interview, design and adapt in `packages/cli/src/commands/`
  - Owns: `packages/cli/src/commands/{scan,analyze,interview,design,adapt}.ts` and their tests, `packages/cli/src/ui/**`, `packages/cli/src/deps.ts`
  - Reads: spec FR-101, FR-104, FR-106..FR-108, FR-113; agents and secops exports; `packages/cli/src/{context,program,approval,reporter}.ts`
  - Depends: T102–T106, T109–T111, 000/T008
  - Accept: `deps.ts` builds `PhaseDeps` from `CliContext` (paths, core stores, ClaudeAgentRuntime when configured, ApprovalGate with the interactive or non-interactive handler, `NodeCommandRunner`, global `fetch`, redactor with env secrets registered); `ui/` has clack-based `askQuestions(questions)` and `chooseOption(options)` renderers (cost table, budget fit, recommended marker); commands: `scan [--offline] [--fail-on <sev>] [--json]` (exit codes per FR-101), `analyze [--no-ai] [--model <id>]`, `interview [--answers <file>]`, `design [--option <id>]`, `adapt [--no-ai] [--no-push] [--model <id>]`; each prints costs when a model ran and next-step hints; tests drive the commands through `createProgram` with temp projects and fakes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: high

- [ ] T115 End-to-end tests over the example apps in `packages/cli/test/e2e/`
  - Owns: `packages/cli/test/e2e/**`, `packages/cli/vitest.config.ts`
  - Reads: `examples/*/expected.json`; spec SC-102, SC-103, SC-106
  - Depends: T108, T114
  - Accept: for each example (materialised into a temp git repo): `scan --offline` findings ⊇ `mustInclude` (clean example → exit 0 and no high/critical), `analyze --no-ai` facts ⊇ expected subset, `interview --answers` + `design --option` produce a valid plan, `adapt --no-ai --no-push` with a scripted approval creates the expected files and commit; a final assertion greps all outputs and written files for every generated fake secret value and fails if any appears.
  - Verify: `pnpm turbo run test --filter=opscrew`
  - Effort: high

## Dependencies & waves

- Wave B: 000/T007, 000/T008, T101, T103, 002/T201
- Wave C: T102, T104, T105, 002/T202, 002/T203
- Wave D: T106, T107, T108, 002/T204, 002/T205
- Wave E: T109, T110, 002/T206, 002/T207, 002/T208
- Wave F: T111, T112, T113, 002/T209, 002/T210
- Wave G: T114, 002/T211, 002/T212, then T115
