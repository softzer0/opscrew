---
description: "Tasks for 000-platform-architecture"
---

# Tasks: Platform Architecture (monorepo foundation)

**Input**: `specs/000-platform-architecture/` (spec.md, plan.md, data-model.md, research.md)
**Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.
Implementers edit only `Owns:` paths; barrel files (`src/index.ts`) listed as lead-owned are fixed.
All test fixtures with secrets use obviously fake values.

## Phase 1: Setup

- [X] T001 Scaffold 14 packages, root workspace config and dependencies (lead) in `packages/*/package.json`, `packages/*/tsconfig.json`, `pnpm-workspace.yaml`, `.npmrc`
- [X] T002 Write cross-package contracts (lead) in `packages/contracts/src/*.ts`

---

## Phase 2: User Story 2 - Validated artefacts (P1)

- [X] T003 [P] [US2] Implement artefact schemas, read/write helpers and JSON Schema export in `packages/plan-schema/src/`
  - Owns: `packages/plan-schema/src/**`, `packages/plan-schema/scripts/**`, `packages/plan-schema/schemas/**`
  - Reads: `specs/000-platform-architecture/data-model.md` (authoritative field list), `packages/contracts/src/*`
  - Depends: T001, T002
  - Accept:
    - FR-004/FR-005; spec US2 scenarios 1–3.
    - Modules: `enums.ts`, `facts.ts`, `architecture.ts`, `requirements.ts`, `interview.ts`, `design.ts`, `plan.ts`, `io.ts`, `json-schema.ts`, `index.ts` exporting every schema (`ProjectFactsSchema`, `ArchitectureSchema`, `RequirementsSchema`, `QuestionSchema`, `CostEstimateSchema`, `DesignOptionSchema`, `DeployPlanSchema`, `MoneySchema`, enum schemas) and inferred types (`ProjectFacts`, `Architecture`, `Requirements`, `Question`, `CostEstimate`, `DesignOption`, `DeployPlan`, `Money` re-exported from contracts where identical).
    - Exactly the fields, enums, defaults and cross-field rules in data-model.md; strict objects.
    - `parseArtifact`, `serializeArtifact`, `readArtifact`, `writeArtifact`, `ArtifactError` (with `code`, `file`, `issues[{path,message}]`, `hint`) as specified; deterministic output; BOM/CRLF tolerant; atomic write.
    - `scripts/gen-schemas.ts` writes `schemas/{architecture,requirements,plan}.schema.json`; committed files generated; drift test.
    - Tests: valid fixtures round-trip byte-identically; each cross-field rule rejects a violating fixture with a dotted issue path; missing-field error mentions file + field + hint.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema`
  - Effort: high

---

## Phase 3: User Story 3 - Safety gate (P1)

- [X] T004 [P] [US3] Implement project paths, redactor and command runner in `packages/core/src/{paths,redact,exec}.ts`
  - Owns: `packages/core/src/paths.ts`, `packages/core/src/redact.ts`, `packages/core/src/exec.ts`, `packages/core/src/paths.test.ts`, `packages/core/src/redact.test.ts`, `packages/core/src/exec.test.ts`, `packages/core/test/fixtures/redaction/**`
  - Reads: data-model.md "Local state"; `packages/core/src/errors.ts`; `packages/contracts/src/io.ts`
  - Depends: T001, T002
  - Accept:
    - `paths.ts`: `resolveProjectPaths(root, { env?, homedir? })` → `ProjectPaths` with `root`, `projectId`, `artefactsDir` (`<root>/opscrew`), `stateDir` (`<root>/.opscrew`), `homeDir` (`OPSCREW_HOME` or `<homedir>/.opscrew`), `projectHomeDir` (`<homeDir>/projects/<projectId>`), `auditDir` (`<homeDir>/audit`) and `files` = { `architecture`: opscrew/architecture.json, `architectureMd`: opscrew/ARCHITECTURE.md, `requirements`: opscrew/requirements.yaml, `plan`: opscrew/plan.yaml, `scanReportMd`: opscrew/SECURITY_SCAN.md, `scanReportJson`: .opscrew/scan.json, `securityReport`: opscrew/SECURITY_REPORT.md, `runbook`: opscrew/RUNBOOK.md, `infraDir`: opscrew/infra, `runtimeDir`: opscrew/runtime, `workflow`: .github/workflows/opscrew-deploy.yml, `state`: .opscrew/state.json, `approvals`: .opscrew/approvals.jsonl, `costs`: .opscrew/costs.jsonl, `plansDir`: .opscrew/plans, `tfstateDir`: .opscrew/tfstate, `deployKey`/`deployKeyPub`/`knownHosts`/`statePassphrase` under `projectHomeDir` } (all absolute, platform separators). `projectIdFor(root)` = `<slug(basename)>-<first 12 hex of sha256(normalised absolute root)>`; normalisation lower-cases a Windows drive letter and removes trailing separators, so the id is stable. `ensureStateDir(paths)` creates `.opscrew/` and writes `.opscrew/.gitignore` containing `*` if missing. `ensureProjectHome(paths)` creates `projectHomeDir` (mode 0o700 where supported). `toPosixRelative(root, abs)`.
    - `redact.ts`: `RedactionRule { id; pattern: RegExp (global); group?: number; validate?(secret) }`, `DEFAULT_REDACTION_RULES` covering FR-007 (GitHub classic `gh[pousr]_` and `github_pat_`, Anthropic `sk-ant-`, OpenAI `sk-`/`sk-proj-`, AWS `AKIA`/`ASIA` ids and `aws_secret_access_key` assignments, Stripe `sk_live_`/`sk_test_`/`rk_live_`, Slack `xox[abposr]-`, Google `AIza`, JWT `eyJ….eyJ….sig`, PEM `-----BEGIN … PRIVATE KEY-----…-----END … PRIVATE KEY-----` (multi-line), URL userinfo passwords `scheme://user:PASSWORD@host`, labelled assignments `(token|secret|password|passwd|api_key|apikey|hcloud_token|cloudflare_api_token)\s*[=:]\s*value` where the value is ≥ 12 chars, contains none of `.(){}$<>` and has Shannon entropy ≥ 3.0 bits/char). Replacement: `[REDACTED:<rule id>]` (literals: `[REDACTED:<label or "secret">]`). `Redactor` with `addLiteral(value, label?)` (ignores values < 8 chars; also matches the URL-encoded form), `redact(text)`, `redactDeep(value)` (strings inside arrays/objects, returns a copy). `maskSecret(value)` → first 4 chars + `…(N chars)` (values < 12 chars → `…(N chars)` only). `SECRET_ENV_NAMES` (HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN, CF_API_TOKEN, GITHUB_TOKEN, GH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, DIGITALOCEAN_TOKEN, OPSCREW_STATE_PASSPHRASE, TF_ENCRYPTION) and `registerEnvSecrets(redactor, env)` registering those plus any variable whose name ends with `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASSWD`, `_API_KEY` or `_PRIVATE_KEY` (value ≥ 8 chars); returns the count.
    - Redaction corpus in `packages/core/test/fixtures/redaction/{secrets,benign}.txt` (one sample per line; PEM sample in its own file): ≥ 25 fake secret samples all masked (SC-002) and ≥ 25 benign samples (code lines like `const token = process.env.GITHUB_TOKEN`, `password: string`, git SHAs, UUIDs, base64 image prefixes, URLs without passwords) unchanged.
    - `exec.ts`: `NodeCommandRunner implements CommandRunner` (`node:child_process.spawn`, `shell: false`, `windowsHide: true`), options `defaultTimeoutMs` (default 600000) and `maxOutputBytes` (default 16 MiB, then truncate with a `[output truncated]` marker); supports `cwd`, `env`, `input`, `timeoutMs` (kills the process tree; on Windows via `taskkill /pid <pid> /T /F`; result `timedOut: true`, `exitCode` 124), `signal`, `onLine`. Spawn failure (ENOENT) → `OpsCrewError("COMMAND_FAILED", "Could not run <cmd>: it is not installed or not on PATH.", { hint })`. Non-zero exit codes resolve normally. `findExecutable(name, env?)` searches `PATH` (Windows: `PATHEXT`, default `.EXE;.CMD;.BAT`) and returns an absolute path or `undefined`.
    - Tests are offline; exec tests use `process.execPath` (node) as the child binary.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core`
  - Effort: high

- [X] T005 [P] [US3] Implement audit log, approval store/gate, project state and cost ledger in `packages/core/src/{audit,approvals,state}.ts`
  - Owns: `packages/core/src/audit.ts`, `packages/core/src/approvals.ts`, `packages/core/src/state.ts`, `packages/core/src/audit.test.ts`, `packages/core/src/approvals.test.ts`, `packages/core/src/state.test.ts`
  - Reads: `packages/contracts/src/safety.ts`, `packages/core/src/errors.ts`, data-model.md "Local state"
  - Depends: T001, T002
  - Accept:
    - `audit.ts`: `JsonlAuditLog implements AuditLog` with constructor `{ dir; redact: (text: string) => string; clock?: Clock }`; writes one JSON object per line to `<dir>/<YYYY-MM-DD UTC>.jsonl`; every string field passed through `redact`; `at` defaulted from the clock; creates `dir` (mode 0o700 where supported); concurrent `append` calls from one process never interleave (in-process write queue). `MemoryAuditLog` (exposes `entries`) for other packages' tests.
    - `approvals.ts`: `isPlanHash(v)` (`/^[0-9a-f]{64}$/i`). `JsonlApprovalStore(file)` and `MemoryApprovalStore` implementing `ApprovalStore`; JSONL store creates parent dirs, skips corrupt lines (exposes `warnings: string[]`), matches hashes case-insensitively and returns the latest approved `iac-apply` record. `ApprovalGate` constructor `{ handler; store; audit; clock?; newId? }`; `request(req)`: validates (`iac-apply` needs a valid `planHash`; `allowDestroy` needs non-empty `confirmPhrase`, else `OpsCrewError("INVALID_INPUT")`), calls the handler, treats an approval whose `confirmation.trim()` differs from `confirmPhrase` as refused (reason "confirmation phrase did not match"), lower-cases the hash, appends the record to the store and an `approval` audit entry (`decision: approved|refused`), returns the record. `assertApprovedPlan(hash, { allowDestroy? })` throws `OpsCrewError("PLAN_NOT_APPROVED")` (hint mentions `--approve <hash>`) when no approved record exists and `OpsCrewError("DESTROY_NOT_APPROVED")` when `allowDestroy` is required but the record lacks it.
    - `state.ts`: `ProjectStateStore(file, clock?)` with `read()` (missing file → `{ schemaVersion: 1, phases: {} }`) and `markPhase(phase, status, summary?)` (atomic temp+rename write); `CostLedger(file, clock?)` with `append`, `entries`, `total`, `byPhase` (JSONL, skips corrupt lines).
    - Tests cover spec US3 scenarios 2 and 3, corrupt-line handling and concurrent appends (100 parallel appends → 100 valid lines).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core`
  - Effort: high

- [X] T006 [P] [US3] Implement the default tool policy and agent environment sanitizer in `packages/core/src/{policy,env}.ts`
  - Owns: `packages/core/src/policy.ts`, `packages/core/src/env.ts`, `packages/core/src/policy.test.ts`, `packages/core/src/env.test.ts`, `packages/core/test/fixtures/policy/**`
  - Reads: `packages/contracts/src/safety.ts`, `packages/contracts/src/runtime.ts`, spec FR-009, plan.md decision 4
  - Depends: T001, T002
  - Accept:
    - `PROFILE_TOOLS`: `none` → []; `read-only` → Read, Glob, Grep; `edit-repo` → Read, Glob, Grep, Edit, Write, Bash (`MultiEdit` treated as Edit).
    - `DefaultToolPolicy implements ToolPolicy` (options `{ mcpServerName?: string = "opscrew" }`), deciding in this order: (1) tools `mcp__<mcpServerName>__*` → allow; other `mcp__*` → deny. (2) `TodoWrite` → allow. (3) `WebFetch`, `WebSearch`, `Task`, `Agent`, `NotebookEdit`, `KillShell`, any unknown tool → deny. (4) Built-in tool not in the profile → deny ("not allowed in the <profile> profile"). (5) File tools (`Read`, `Edit`, `MultiEdit`, `Write`: `file_path`; `Glob`, `Grep`: optional `path`) → resolve against `projectRoot`; deny when outside the root (case-insensitive on Windows, `..` resolved) or when `isSecretPath` matches; writes additionally denied under `.git/`, `.opscrew/`, `opscrew/` and `.github/workflows/opscrew-deploy.yml`. (6) `Bash` (`command`) → deny if it contains command substitution (`$(`, backticks), process substitution, here-docs or redirection to `/dev/tcp`; split with `splitShellCommand` on `&&`, `||`, `;`, `|`, `&`, newlines; deny if any segment matches the deny list or references a secret path; allow if every segment matches the allow list; otherwise `ask`.
    - Deny list (all profiles): `terraform`, `tofu`, `hcloud`, `doctl`, `aws`, `gcloud`, `az`, `kubectl`, `helm`, `ssh`, `scp`, `sftp`, `rsync`, `curl`, `wget`, `nc`/`ncat`/`netcat`, `telnet`, `gh`, `git push|remote|config|credential|filter-branch|reset --hard|clean`, `sudo`, `su`, `chmod 777`, `chown`, `rm -rf` (or `-fr`, `-r -f`) on `/`, `~`, `$HOME`, `..`, `*`, `docker push|login|run|exec|system prune|rm|rmi|volume rm`, `npm|pnpm|yarn publish|login|adduser|token`, `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `env`, `printenv`, `set`, `export`, `echo $…`, `eval`, `source`/`.`, `bash -c`, `sh -c`, `powershell`, `pwsh`, `cmd`, `iex`, `Invoke-WebRequest`, `python -c`, `node -e`, `dd if=`, `mkfs`, `shutdown`, `reboot`, `kill`, `pkill`, `crontab`, `history`, SQL `DROP (TABLE|DATABASE)`.
    - Allow list (edit-repo): `node --version`; read-only git (`status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`); `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep` (non-recursive), `find` (no actions), `tree`; `mkdir -p <path>`.
    - Always `ask` (never pre-approved): commands that run project code an agent could have edited — package managers (`npm`, `pnpm`, `yarn`, `bun` installs and scripts), `docker build`, `python -m pytest` / pip / uv / poetry installs, `go build|test|mod`, `make`, `cargo`, `gradle`, `mvn` and similar.
    - Always `deny` for agents: git writes (`add`, `commit`, `branch`, `checkout`, `switch`, `stash`, `restore`, `reset`, `merge`, `rebase`, `tag`, `pull`, …) — OpsCrew commits itself after the user reviews the diff.
    - `isSecretPath(p)`: basename `.env` or `.env.*` except `.env.example|.env.sample|.env.template|.env.dist`; extensions `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.tfstate`, `.tfstate.backup`, `.tfvars`; names `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `credentials` (under `.aws`), `known_hosts`; any path segment `.ssh`, `.aws`, `.gnupg`, `.docker`, `.terraform`, `.opscrew`; files under `.git/` (but `.gitignore`, `.gitattributes` are not secret).
    - `env.ts`: `PROVIDER_SECRET_ENV` and `sanitizeAgentEnv(env)` returning a new object without: `HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CF_API_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `DIGITALOCEAN_TOKEN`, `DIGITALOCEAN_ACCESS_TOKEN`, `NAMECHEAP_API_KEY`, `NAMECHEAP_API_USER`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `TF_ENCRYPTION`, `OPSCREW_STATE_PASSPHRASE`, every `TF_VAR_*`, `CONTABO_*`, `ARM_*`, `AZURE_*` (unless `CLAUDE_CODE_USE_FOUNDRY=1`), `AWS_*` (unless `CLAUDE_CODE_USE_BEDROCK=1`), `GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_CREDENTIALS`/`CLOUDSDK_*` (unless `CLAUDE_CODE_USE_VERTEX=1`), and any name ending in `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASSWD`, `_PRIVATE_KEY` or `_API_KEY` — except `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, which are kept. Undefined values are dropped.
    - Policy corpus in `packages/core/test/fixtures/policy/` (`deny.txt`, `allow.txt`, `ask.txt`, one command per line) with ≥ 40 deny, ≥ 20 allow and ≥ 5 ask samples; table-driven tests over all profiles (SC-003) plus path tests (outside root, `..`, Windows drive letters, secret files).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core`
  - Effort: high

---

## Phase 4: User Story 4 - Agent runtime (P2)

- [X] T007 [US4] Implement the Claude Agent SDK runtime and the fake runtime in `packages/runtime-claude/src/` and `packages/core/src/testing/`
  - Owns: `packages/runtime-claude/src/**`, `packages/core/src/testing/**`
  - Reads: `packages/contracts/src/runtime.ts`, `packages/contracts/src/safety.ts`, `packages/core/src/index.ts` and the modules it exports, the installed SDK types `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts` (authoritative API; do not guess), plan.md decisions 4–7
  - Depends: T004, T005, T006
  - Accept:
    - FR-010, FR-011; spec US4 scenarios 1–5.
    - `ClaudeAgentRuntime implements AgentRuntime` (`id: "claude-agent-sdk"`), constructor options `{ policy: ToolPolicy; audit: AuditLog; redact: (text: string) => string; approvals?: { request(req: ApprovalRequest): Promise<{ approved: boolean }> }; costLedger?: { append(entry: { phase: PhaseName; model?: string; costUsd: number }): Promise<void> }; defaultModel?: string (default "claude-opus-5-5"); env?: Record<string, string | undefined> (default process.env); queryFn?: typeof query }`.
    - `isConfigured()`: ok when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set or `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`/`CLAUDE_CODE_USE_FOUNDRY` is `1`; otherwise `{ ok: false, reason, hint }` naming those options.
    - `runPhase`: calls `query()` with: the phase prompt; system prompt (for `edit-repo`, the SDK's Claude Code preset with the phase prompt appended; otherwise the phase prompt as a plain system prompt); `cwd: projectRoot`; the profile's built-in tools (intersected with `builtinTools` when given) plus `mcp__opscrew__<tool>` names as the allow-list; every other tool disallowed; in-process tools registered through the SDK's in-process MCP server named `opscrew` (zod `inputSchema.shape`); a pre-tool-use hook (matcher for all tools) that calls `policy.evaluate` and returns deny with the reason (audit `tool-denied`), allow, or — for `ask` — consults `approvals` (kind `tool-call`) and denies when absent or refused; a permission callback that applies the same policy; a post-tool-use hook that audits `tool-call`; no filesystem settings loaded (user/project/local settings sources disabled); `env: sanitizeAgentEnv(env)`; `model`, `maxTurns`, `maxBudgetUsd`, effort when the SDK supports it; abort via `signal`; structured output via the SDK's JSON-schema output option using `z.toJSONSchema(schema, { target: "draft-7" })` when `output` is set.
    - Maps the SDK result to `PhaseResult`: success → `completed`; max-turns → `max_turns`; budget exceeded → `budget_exceeded`; abort → `aborted`; refusal → `refused`; anything else → `error`; output failing `schema.safeParse` → `ok: false`, `stopReason: "invalid_output"`. `costUsd`, `turns`, `sessionId`, `usage`, `model` filled from the result; cost appended to `costLedger`; assistant text and events passed through `redact`.
    - `FakeAgentRuntime implements AgentRuntime` in `packages/core/src/testing/fake-runtime.ts`: constructor takes scripted responses (per phase or a queue; each a partial `PhaseResult` or a function of the request), records `requests`, validates scripted `output` against the request's schema exactly like the real runtime, `isConfigured()` configurable.
    - Tests mock the SDK through `queryFn` (no network): option mapping per profile, deny/allow/ask paths, env sanitisation, structured-output success and invalid output, budget/max-turn mapping, cost ledger and audit calls.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/runtime-claude --filter=@opscrew/core`
  - Effort: high

---

## Phase 5: User Story 5 - CLI skeleton (P3)

- [X] T008 [US5] Implement the `opscrew` CLI skeleton, reporter, approval handlers and bundle in `packages/cli/`
  - Owns: `packages/cli/src/**`, `packages/cli/tsup.config.ts`
  - Reads: `packages/contracts/src/{io,safety}.ts`, `packages/core/src/index.ts` and modules, spec US5, FR-012
  - Depends: T004, T005
  - Accept:
    - `src/context.ts`: `CliContext { cwd; env; version; isInteractive; stdout(text); stderr(text); reporter: Reporter; redactor }` and `createDefaultContext()`.
    - `src/reporter.ts`: `TerminalReporter implements Reporter` (picocolors; prefixes ◆ step, ✓ success, ▲ warn, ✗ error; every message redacted; respects `NO_COLOR`).
    - `src/approval.ts`: `InteractiveApprovalHandler` (@clack/prompts: prints title + details + policy failures + cost delta; `confirm` for normal requests; `text` input that must equal `confirmPhrase` when set; approver = `git config user.name` via `NodeCommandRunner`, fallback OS user name) and `NonInteractiveApprovalHandler({ approvePlanHash?, approver })` that approves only `iac-apply` requests whose `planHash` equals `approvePlanHash` (case-insensitive) and without `allowDestroy`; refuses everything else with a reason telling the user to run interactively or pass `--approve <hash>`.
    - `src/commands/<name>.ts` for `scan`, `analyze`, `interview`, `design`, `adapt`, `provision`, `dns`, `secure`, `verify`, `mcp`, `status`, each exporting `register(program: Command, ctx: CliContext): void`; all except `status` are stubs that print "`opscrew <name>` is not available yet." and exit 2. `src/commands/index.ts` exports `ALL_COMMANDS` (lead-owned after this task).
    - `status`: reads `.opscrew/state.json` via `ProjectStateStore` and prints each phase with status and time; with no state prints "No phases have run yet. Start with `opscrew scan`.".
    - `src/program.ts`: `createProgram(ctx)` (commander, `name("opscrew")`, `.version(ctx.version)`, description from the brand line, global `--cwd <dir>`), registers `ALL_COMMANDS`; maps `UserFacingError`s to `✗ message` + hint and exit code 1; never prints stack traces unless `OPSCREW_DEBUG=1`.
    - `src/bin.ts`: entry (`#!/usr/bin/env node` added by the bundler banner) calling `main(process.argv)`.
    - `tsup.config.ts`: entry `{ opscrew: "src/bin.ts" }`, ESM, platform node, target node20, `noExternal: [/^@opscrew\//]`, dependencies of the `opscrew` package external, shebang banner, `outDir: "dist"`, clean.
    - Tests: `--version`, `--help`, `status` with and without state (temp dirs), stub exit code, non-interactive approval rules, user-facing error mapping.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && pnpm --filter opscrew build && node packages/cli/dist/opscrew.js --version`
  - Effort: high

---

## Phase 6: Polish

- [X] T009 Write ADRs 0001–0005 (lead) in `docs/adr/`
- [X] T010 Feature verification (lead): `pnpm check`, CLI bundle smoke test, `/speckit-converge`-style review against spec FR-001..FR-013

## Phase 7: Converge (review of 2026-10-11 against FR-001..FR-013 and the constitution)

- [X] T011 Redact every tool result before the model sees it (post-tool-use `updatedToolOutput`) and redact audit targets before shortening them in `packages/runtime-claude/src/runtime.ts` (FR-010, constitution IV)
- [X] T012 Check file and command paths where symbolic links really lead (`realpath` option, `nodeRealpath`, wired in the CLI) in `packages/core/src/policy.ts` and `packages/cli/src/deps.ts` (FR-009, US3.5)
- [X] T013 Mask PEM private-key blocks cut before their END line in `packages/core/src/redact.ts`; give the concurrent state-store test a Windows-safe timeout (FR-007, SC-001)
- [X] T014 One exit-code contract for every CLI command (0 done, 1 stopped on purpose, 2 could not run), each hint printed once, programmatic `src/index.ts`, plugin MCP server pinned to the plugin version and a valid marketplace manifest in `packages/cli/`, `plugin/`, `.claude-plugin/` (FR-002, FR-012)

## Dependencies & execution order

- Wave A (parallel): T003, T004, T005, T006 — disjoint files, depend only on T001/T002.
- Wave B: T007 (needs T004–T006), T008 (needs T004, T005) — can run with feature 001/002 tasks.
- T009, T010 by the lead.
