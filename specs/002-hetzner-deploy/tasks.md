---
description: "Tasks for 002-hetzner-deploy"
---

# Tasks: Hetzner Deploy (Phase 1b)

**Input**: `specs/002-hetzner-deploy/` (spec.md, plan.md, research.md) + `specs/000-platform-architecture/`
+ `specs/001-scan-and-plan/` (design outputs, shared packages).
**Numbering**: T201–T299. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Lead-owned barrels/registries already exist; fill only your files.
Fixtures never contain secret-shaped literals (`fakeSecret()` / `{{FAKE:…}}` + `materializeFixture()`).

## Phase 1: Engine and adapters

- [X] T201 [P] [US1] Implement the dual Terraform/OpenTofu engine in `packages/iac-engine/src/`
  - Owns: `packages/iac-engine/**`
  - Reads: plan.md "IaC engine"; spec US1, FR-201..FR-203; `packages/contracts/src/iac.ts`; `@opscrew/core` (`NodeCommandRunner`, `findExecutable`, `OpsCrewError`)
  - Depends: 000/T004, 000/T005
  - Accept:
    - Exports `detectEngines(opts)`, `selectEngine(preference, opts) → Promise<IacEngine>`, `createEngine(info, { runner })`, `parsePlanJson(json)`, `hashFile(path)`, `checkDialect(files: { path; content }[]) → DialectIssue[]`, `tofuEncryptionEnv(passphrase)`, `MIN_ENGINE_VERSION`.
    - Behaviour exactly as plan.md (flags, env, exit codes, hash- and destroy-guarded apply, output parsing, error mapping with redacted stderr tail, timeouts).
    - Unit tests with a scripted fake runner (version JSON, validate JSON, show JSON fixtures for create/update/delete/replace/read/no-op).
    - Integration tests (`*.it.test.ts`, run when the binary is found via `OPSCREW_TOFU_BIN`/`OPSCREW_TERRAFORM_BIN`/PATH, otherwise `skip` with a message; no network): a module with two `terraform_data` resources — init → validate → plan → apply with the right hash → change input → plan shows replace → apply without `allowDestroy` refused → tamper with the plan file → apply refused; with tofu + `tofuEncryptionEnv` the state file contains no plaintext resource data and a second plan works. Run for both engines.
  - Verify: `OPSCREW_TOFU_BIN="$PWD/.tools/bin/tofu.exe" OPSCREW_TERRAFORM_BIN="$PWD/.tools/bin/terraform.exe" pnpm turbo run typecheck test --filter=@opscrew/iac-engine`
  - Effort: high

- [X] T202 [P] [US3] Implement the Cloudflare read adapter in `packages/connectors/cloudflare/src/`
  - Owns: `packages/connectors/cloudflare/**`
  - Reads: spec US3, FR-211; plan.md "Provision orchestration" step 2; `packages/contracts/src/connector.ts`
  - Depends: 000/T004
  - Accept: `CloudflareClient({ token, fetch, baseUrl = "https://api.cloudflare.com/client/v4" })` with `verifyToken()` (`GET /user/tokens/verify`, active → ok; falls back to `GET /zones?per_page=1` success for account-owned tokens), `findZone(domain)` (tries the domain and each parent name, returns `{ id, name, status, nameServers }` or undefined), `listDnsRecords(zoneId, { name?, type? })`, `hasEntrypointRuleset(zoneId, phase)` (`GET /zones/{id}/rulesets/phases/{phase}/entrypoint`: 404 → false; 200 with rules → true; 200 without rules → false), `getIpRanges()` (`GET /ips`, no auth); envelope handling (`success`, `errors[]`), 429/5xx retry, `OpsCrewError` mapping (401/403 → `CREDENTIALS_INVALID` with the required permissions); `cloudflareConnector({ env, fetch })` with credentials `CLOUDFLARE_API_TOKEN`, scopes `Zone:Read`, `DNS:Edit`, `Zone WAF:Edit`, `Config Rules:Edit` (named as in the Cloudflare dashboard; see research.md), create URL `https://dash.cloudflare.com/profile/api-tokens`; read-only tools `cloudflare_find_zone`, `cloudflare_list_dns_records`. Fake-fetch tests for every method and error path.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare`
  - Effort: medium

- [X] T203 [P] [US2] Implement git and GitHub operations in `packages/connectors/github/src/`
  - Owns: `packages/connectors/github/**`
  - Reads: spec FR-212; plan.md "Provision orchestration" steps 9–10; 001 plan.md "Adapt"; `packages/contracts/src/{io,connector}.ts`
  - Depends: 000/T004
  - Accept:
    - `GitClient({ cwd, runner })`: `isRepo()`, `root()`, `currentBranch()`, `headSha()`, `status()` (porcelain v1 parsed), `isClean({ ignore?: string[] })`, `branchExists(name)`, `createBranch(name)` / `checkout(name)`, `add(paths)`, `commit(message)` (returns sha; fails clearly when user.name/email are missing), `push(branch, { setUpstream })`, `diffStat()`, `remoteUrl(name = "origin")`, `defaultBranch()`; all via `git -C <cwd> …` with `GIT_TERMINAL_PROMPT=0`.
    - `GitHubClient({ token, fetch, baseUrl = "https://api.github.com" })`: `getRepo(owner, repo)`, `findOpenPullRequest(owner, repo, head)`, `createPullRequest({ owner, repo, head, base, title, body })`, `getActionsPublicKey(owner, repo)`, `setActionsSecret(owner, repo, name, value)` (sealed with `sealSecret`), `listWorkflowRuns(owner, repo, { workflowFile, branch, perPage })`; headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent`; error mapping (401 → `CREDENTIALS_INVALID`, 403/404 on secrets → missing permission message).
    - `sealSecret(publicKeyBase64, value)` with libsodium `crypto_box_seal` (base64 original variant); test decrypts with a generated keypair (`crypto_box_seal_open`).
    - `resolveGitHubToken(env, runner)`: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token` (runner), else undefined.
    - `githubConnector({ env, fetch, runner })` with credentials (fine-grained PAT: Contents, Pull requests, Secrets, Actions, Workflows read/write; Metadata read; create URL `https://github.com/settings/personal-access-tokens/new`).
    - Tests: git operations on a real temp repo (skip when git is missing), REST with fake fetch, secret values never appear in errors or audit-facing strings.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github`
  - Effort: high

---

## Phase 2: Templates

- [X] T204 [US2] [US3] Implement the vendored HCL modules, root-module renderer and module generator in `packages/iac-templates/`
  - Owns: `packages/iac-templates/modules/**`, `packages/iac-templates/scripts/**`, `packages/iac-templates/src/infra/**`, `packages/iac-templates/src/generated/**`
  - Reads: plan.md "Rendering" (module and cloud-init details, provider versions); spec FR-204..FR-207; research.md (provider schema notes); `packages/iac-templates/src/{types,render}.ts` (lead-owned)
  - Depends: 000/T003, T201 (dialect checker used in tests)
  - Accept:
    - Modules `hetzner-vps` and `cloudflare-dns` exactly as plan.md; valid HCL for both engines; no engine-specific syntax (checked with `checkDialect` in a test).
    - `scripts/gen-modules.ts` writes `src/generated/modules.ts` (`MODULE_FILES: Record<string, string>` keyed `hetzner-vps/main.tf` etc.); drift test.
    - `renderInfra(plan, ctx) → RenderedFile[]`: root module files + `terraform.tfvars.json` + vendored module copies under `opscrew/infra/modules/`; Cloudflare provider/module only when `plan.dns.provider == "cloudflare"`; http CIDRs = Cloudflare ranges when proxied and `httpAllowedFrom == "cloudflare"` (from `ctx.cloudflare.ipRanges`, else any); deterministic output; header comments; snapshot tests for: no domain, Cloudflare domain proxied with rules, Cloudflare with existing rulesets (rules off), backups on/off.
    - Validation test (`*.it.test.ts`, only when `OPSCREW_IT=1` and a binary is available): render each snapshot case to a temp dir, `init -backend=false` + `validate` with tofu and terraform.
    - A test asserts rendered files contain no secret-shaped strings and no absolute paths.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T205 [P] [US2] Implement the Compose, Caddyfile and GitHub Actions workflow renderers in `packages/iac-templates/src/{runtime,workflow}/`
  - Owns: `packages/iac-templates/src/runtime/**`, `packages/iac-templates/src/workflow/**`
  - Reads: plan.md "Rendering"; spec FR-208, FR-209, US2 scenario 5; `packages/iac-templates/src/types.ts`
  - Depends: 000/T003
  - Accept: `renderCompose(plan, ctx)`, `renderCaddyfile(plan, ctx)`, `renderWorkflow(plan, ctx)` returning `RenderedFile`s at `opscrew/runtime/compose.yaml`, `opscrew/runtime/Caddyfile`, `plan.cicd.workflowPath`; compose and workflow are valid YAML (parsed in tests); services/caps/networks/volumes per FR-208; workflow per FR-209 and plan.md (pinned `actions/checkout` SHA constant documented in research.md, `permissions`, `concurrency`, build/scan/deploy/health/rollback steps, secrets referenced only by name, `set -euo pipefail` in every multi-line step, no `${{ }}` interpolation of untrusted input inside `run:` — pass through `env:`); snapshot tests for Postgres+Valkey, static app without DB, with/without domain, imageScan off.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T208 [P] [US4] Implement the runbook renderer in `packages/iac-templates/src/runbook/`
  - Owns: `packages/iac-templates/src/runbook/**`
  - Reads: plan.md "Secure and verify" (RUNBOOK contents); spec US4 scenario 3
  - Depends: 000/T003
  - Accept: `renderRunbook(plan, ctx) → RenderedFile` (`opscrew/RUNBOOK.md`) with every section listed in plan.md, real values from the plan/context (domain, IPs, location, server type, app name, health path, workflow path, deploy branch), placeholders explained when values are missing (before first apply); plain English; snapshot tests.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

---

## Phase 3: Checks and shared helpers

- [X] T206 [P] [US2] [US4] Implement plan policies, host hardening checks and outside probes in `packages/secops/src/{policies,hardening}/`
  - Owns: `packages/secops/src/policies/**`, `packages/secops/src/hardening/**`, `packages/secops/test/fixtures/{policies,hardening}/**`
  - Reads: plan.md "Secure and verify"; spec FR-215, US2 scenario 2, US4 scenarios 1–2; `packages/contracts/src/{safety,secops,io}.ts`
  - Depends: 000/T003
  - Accept: `evaluatePlanPolicies(planJson, deployPlan) → PolicyResult[]` (all policies of plan.md; works on `planned_values` with nested child modules; plan-JSON fixtures hand-written for passing and failing cases); `HOST_CHECKS`, `runHostChecks(remote: RemoteExec) → Promise<CheckResult[]>` (each check isolated; command failures → `warn` with the reason); `probePorts(host, { ports, timeoutMs, connect? })`, `probeSshPasswordAuth(host, { runner, knownHostsFile })`; tests with fake `RemoteExec` outputs (Ubuntu 24.04 shaped) and a fake `connect`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/secops`
  - Effort: medium

- [X] T207 [P] [US2] Implement shared provisioning helpers in `packages/agents/src/shared/`
  - Owns: `packages/agents/src/shared/**`
  - Reads: plan.md "Provision orchestration" steps 3, 4, 7, 8; spec FR-213; 000 data-model.md (project home files)
  - Depends: 000/T004, 000/T005
  - Accept:
    - `ssh-keys.ts`: `generateEd25519KeyPair(comment) → { privateKeyOpenSsh; publicKeyOpenSsh; fingerprintSha256 }` using `node:crypto` (OpenSSH `openssh-key-v1` private format, unencrypted, correct padding and check ints; public `ssh-ed25519 <base64> <comment>`); `ensureDeployKey(paths)` (create once, mode 0600 where supported, reuse after); `ensureStatePassphrase(paths)` (32 random bytes base64url, 0600). Test: `ssh-keygen -y -f <key>` reproduces the public key (skip when `ssh-keygen` is missing).
    - `remote.ts`: `SshRemoteExec({ host, user = "deploy", keyFile, knownHostsFile, runner })` implementing `RemoteExec` with `-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<file> -o ConnectTimeout=10`; Windows key-file ACL note in docs.
    - `wait.ts`: `waitForPort(host, port, { timeoutMs, intervalMs, connect })`, `pinHostKey({ host, knownHostsFile, runner, approvals })` (ssh-keyscan ed25519; refuses a changed key without a `remote-exec` approval), `waitForCloudInit(remote, { timeoutMs, intervalMs })`; injected clock/sleep for tests.
    - `app-env.ts`: `assembleAppEnv({ plan, architecture, dotenvText?, ask?, env, random })` → `{ appEnv: string; dbEnv?: string; names: string[] }` per plan.md step 8 (dotenv parsing with quotes/escapes; generated password; derived URLs; values never logged; non-interactive file mode).
    - `files.ts`: `diffRenderedFiles(root, files) → { created; changed; unchanged }`, `writeRenderedFiles(root, files)` (atomic, LF, mode when given).
    - Tests for all of the above offline.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

---

## Phase 4: Phases

- [X] T209 [US2] [US3] Implement the provision and dns phases in `packages/agents/src/{provision,dns}/`
  - Owns: `packages/agents/src/provision/**`, `packages/agents/src/dns/**`
  - Reads: plan.md "Provision orchestration"; spec US2, US3, FR-213, FR-214; exports of iac-engine, iac-templates, connectors, secops policies, agents/shared
  - Depends: T201–T207, 001/T110
  - Accept: `runProvision(deps, options)`, `planAndApply(deps, options)`, `runDns(deps, options)` implementing every step of plan.md with the approval kinds named there; resumable (re-running after partial failure plans the remainder; existing deploy key, passphrase and pinned host key reused); results `{ planHash, applied, outputs, prUrl? }`; orchestrator tests with fakes for engine (scripted `PlanSummary`), connectors, GitHub, `RemoteExec`, runner and approval handler: happy path, `--plan-only`, `--approve` with matching and non-matching hash, policy failure stops before approval, destroy requires typed confirmation, credentials missing message, Cloudflare existing rulesets disable rule management, push refused, host key changed, no secret value in any reporter/audit output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T210 [P] [US4] Implement the secure and verify phases in `packages/agents/src/{secure,verify}/`
  - Owns: `packages/agents/src/secure/**`, `packages/agents/src/verify/**`
  - Reads: plan.md "Secure and verify"; spec US4, FR-216; secops exports (scan, policies, hardening); `renderRunbook`
  - Depends: T206, T207, T208, 001/T102–T106
  - Accept: `runSecure(deps)` → `SECURITY_REPORT.md` (`renderSecurityReport` deterministic) + summary; `runVerify(deps, { resolver?, fetch?, tlsConnect?, tcpConnect? })` with every check in plan.md → `CheckResult[]`, writes `RUNBOOK.md` via `renderRunbook`, records `lastDeployAt`/`url` in the plan when checks pass; tests with fakes for spec US4 scenarios 1–4 and the no-domain warning path.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

---

## Phase 5: Interfaces

- [ ] T211 [US2] [US3] [US4] Implement the CLI commands provision, dns, secure, verify and mcp in `packages/cli/src/commands/`
  - Owns: `packages/cli/src/commands/{provision,dns,secure,verify,mcp}.ts` and their tests
  - Reads: spec FR-213, FR-214, FR-216; agents exports; `packages/cli/src/{deps,context,program,approval}.ts`
  - Depends: T209, T210, 001/T112, 001/T114 (`deps.ts`)
  - Accept: `provision [--plan-only] [--approve <hash>] [--engine tofu|terraform] [--no-push]`, `dns [--domain <fqdn>]`, `secure`, `verify`, `mcp` (starts `startStdioServer` with deps built from the cwd; logs to stderr only); exit codes (0 ok, 1 checks/policies failed or refused, 2 error); next-step hints; tests through `createProgram` with fakes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew`
  - Effort: high

- [ ] T212 [P] [US2] [US4] Implement the MCP deploy tools in `packages/mcp-server/src/tools/deploy.ts`
  - Owns: `packages/mcp-server/src/tools/deploy.ts`, `packages/mcp-server/src/tools/deploy.test.ts`
  - Reads: spec FR-217; research.md "MCP elicitation"; `packages/mcp-server/src/server.ts`
  - Depends: T209, T210, 001/T112
  - Accept: `registerDeployTools(server, deps)` adding `opscrew_render`, `opscrew_plan` (returns hash, changes, cost, policy results), `opscrew_apply` (requires `planHash`; asks the user through elicitation with the plan summary; refuses with the CLI command when the client lacks elicitation or the user declines; never applies on a model's say-so), `opscrew_secure`, `opscrew_verify`; tests with the SDK in-memory transport and a client that does / does not support elicitation.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server`
  - Effort: high

- [ ] T213 Live end-to-end test (gated) in `packages/cli/test/live/`
  - Owns: `packages/cli/test/live/**`, `docs/e2e.md`
  - Reads: spec SC-203, SC-204; all phases
  - Depends: T211, 001/T115
  - Accept: runs only when `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_REPO` (a throwaway repo) and `OPSCREW_E2E_GITHUB_TOKEN` are set (Cloudflare part when `OPSCREW_E2E_CLOUDFLARE_TOKEN` + `OPSCREW_E2E_DOMAIN` are set): pushes `examples/nextjs-postgres` to the repo, runs analyze → interview (answers file) → design → adapt → provision (`--approve` the printed hash) → merges the PRs via API → waits for the deploy run → verify → destroys everything (plan with destroy + approval) → asserts teardown; `docs/e2e.md` explains setup and cost (cents). Skipped in normal CI.
  - Verify: `pnpm turbo run test --filter=opscrew` (live suite skipped without env)
  - Effort: high

## Waves

See `specs/001-scan-and-plan/tasks.md` "Dependencies & waves" (features 001 and 002 are scheduled
together). T213 runs last.
