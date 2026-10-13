---
description: "Tasks for 008-first-real-run"
---

# Tasks: First real run and release

**Input**: `specs/008-first-real-run/` (spec.md, plan.md) + features 000–007 + live-run findings.
**Numbering**: T801–T899. Tasks are appended as live runs find problems.

## Phase 1: Spec (lead)

- [X] T801 Spec, plan and tasks from the first live runs (lead)

## Phase 2: Fixes from the first live runs

- [X] T802 [P] [US1] Next.js builds without a model in `packages/agents/src/adapt/` and `packages/iac-templates/src/docker/`
  - Owns: `packages/agents/src/adapt/**`, `packages/iac-templates/src/docker/**`
  - Reads: plan.md "Next.js without a model"; the Next.js playbook; the Dockerfile stacks and their tests
  - Accept: deterministic `output: "standalone"` edit for the plain-object config shapes (and a new `next.config.mjs` when none exists; `outputFileTracingRoot` for monorepo apps), shown in the PR as an OpsCrew change; other shapes stay agent/manual changes; the generated Next.js Dockerfile builds whether or not the config has standalone output (a real `docker build` test of `examples/nextjs-postgres` with and without the edit, run with OPSCREW_DOCKER_TESTS=1); existing tests pass.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: high

- [X] T803 [P] [US3] Owned domains and null MX in `packages/agents/src/domain/` and `packages/connectors/cloudflare/src/records.ts`
  - Owns: `packages/agents/src/domain/{search,connect-bind}.ts` (+ tests), `packages/connectors/cloudflare/src/records.ts` (+ test)
  - Accept: a name the registrar reports unavailable but the account holds → "already in your <Registrar> account" + `opscrew domain connect <domain>` (Porkbun/Namecheap/GoDaddy via `ownsDomain`, Cloudflare via `getDomain`), in search and compare; ownership lookups failing never fail the search; null MX (`0 .`) from a BIND file or a registrar named as a null MX ("accepts no mail") with one message.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-cloudflare`
  - Effort: medium

- [X] T808 [US1] Re-runs and the health route without a model in `packages/agents/src/adapt/` (and the deploy PR flow)
  - Owns: `packages/agents/src/adapt/**`, `packages/agents/src/provision/**`, `packages/connectors/github/src/**`
  - Accept: (a) a remote OpsCrew branch left from an earlier run never makes the push fail: with an open pull request from it, OpsCrew says so and stops before changing anything (or updates it when the remote head is OpsCrew's own commit — implementer's choice, explained); with none (merged or closed), it pushes to a new branch name and opens the PR; same for every branch OpsCrew pushes (adapt, the deploy/infra PR); (b) without a model, the Next.js health route is created deterministically (`app/api/health/route.ts` for the app router, `pages/api/health.ts` for the pages router, matching the plan's health path, never overwriting an existing file) and shown as an OpsCrew change; for stacks where the health route needs an edit to existing code, adapt says plainly that deploys fail their health check until it is added.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-github`
  - Effort: high

- [X] T809 Live test hygiene: the throwaway repository is reset (OpsCrew branches deleted, open PRs closed) before each pass (lead)

- [X] T810 Dropped by the founder (2026-10-13): the opt-in Docker build test (T802, `OPSCREW_DOCKER_TESTS=1`) already checks the image build locally, and the deploy job needs a real server, so `act` would add a large download and little coverage

- [X] T811 [US1] T808 review fixes: provision re-runs from another branch, a health route that type-checks on TypeScript < 5.2, the real created path in the PR, push failures after an unreachable origin, retarget's publish phase, route groups, `--no-push` advice
  - Owns: `packages/agents/src/adapt/**`, `packages/agents/src/provision/**`, `packages/agents/src/retarget/finish.ts`, `packages/connectors/github/src/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-github --filter=opscrew`
  - Effort: high

- [X] T812 Hetzner firewall drift false positive: `apply_to` mirrored from the server's `firewall_ids` is ignored (lead)

- [X] T813 Drift ignores read-only attributes for every provider (from the provider schema), keeping the explicit mirrored-relationship list (`hcloud_firewall.apply_to`)
  - Owns: `packages/iac-engine/src/**`, `packages/agents/src/drift/**`, `packages/agents/src/providers/**`
  - Accept: an optional `ProviderSchemaReader` capability of `@opscrew/iac-engine` (`tofu|terraform providers schema -json` after init, cached per run; the `IacEngine` contract is unchanged; zod parsing in drift); drift drops attributes that are computed and neither optional nor required for their resource type, and the mirrored ones; an update left with no attributes is dropped; schema unreadable → drift reports everything as today with a plain note; tests with recorded schema excerpts for digitalocean_tag counts, digitalocean_firewall status/pending_changes, hcloud_server status, cloudflare_dns_record modified_on, and real changes still reported (size, rules, firewall_ids, delete).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-engine --filter=@opscrew/agents`
  - Effort: high

- [X] T814 The server address is never published: no IP in pull requests ever; no IP in committed files (`opscrew/plan.yaml`, `opscrew/RUNBOOK.md`, reports) when the domain is behind Cloudflare's proxy — kept in OpsCrew's local state instead
  - Owns: `packages/plan-schema/src/plan.ts` (+ tests), `packages/agents/src/**` except `drift/**` beyond the address read, `packages/iac-templates/src/runbook/**`, `packages/iac-templates/src/types.ts`, `packages/cli/src/**` where it prints or reads the address
  - Accept: PR bodies say "the server" or the domain, never an IP; `plan.yaml` never contains the server address (founder: no backward compatibility, OpsCrew is unreleased); with a proxied domain the runbook and the security/verify reports contain none either (tests grep committed files, commits and PR bodies for the fake IPs); every command reads the address through one helper from `.opscrew/server.json` (gitignored) with OpenTofu outputs as the fallback; the CLI shows it locally (`opscrew status`, `status --ip`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=@opscrew/iac-templates --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: xhigh

- [X] T815 T814 review fixes: retarget never infers old/new servers from the step (outputs mapped by module, or stop when ambiguous); a fresh clone without local state gets a plain "run it where the server was provisioned" instead of a failed DNS check or "run provision"; the address is refreshed after a failed apply that replaced the server
  - Owns: `packages/agents/src/{retarget,verify,design,shared,provision}/**`, `packages/iac-templates/src/infra/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T816 Converge fixes (agents and CLI): provision/dns never branch from a stale or wrong HEAD; `.terraform/` gitignored; runbook stable between provision and verify; `status` survives a damaged `server.json`; `--finish` completes after the old server is gone; outputs read after `init` on a computer with copied state; a note when an already-public address goes behind the proxy
  - Owns: `packages/agents/src/{provision,dns,init,shared,retarget}/**`, `packages/cli/src/commands/status.ts` (+ test)
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: high

- [X] T817 Converge fixes (templates, adapt, live test): Django builds without `STATIC_ROOT`; a Next.js `basePath` is handled or warned about for the health route; the runbook's SSH line works for `npx` users; the live domain pass asserts that the server address is in no committed file, commit message or pull request
  - Owns: `packages/iac-templates/src/{docker,runbook}/**`, `packages/agents/src/adapt/**`, `packages/cli/test/live/live.test.ts`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew`
  - Effort: medium

- [X] T818 The AI path works for real: the SDK's `StructuredOutput` tool is allowed by the tool policy (agents can return their structured result), and tool gating has one clear path (the PreToolUse hook) without the SDK's "canUseTool will not be invoked" shadowing
  - Owns: `packages/runtime-claude/src/**`, `packages/core/src/policy.ts` (+ tests)
  - Accept: a real `opscrew adapt` with a model returns the Code-change agent's report (found 2026-10-14: "StructuredOutput denied: Unknown tool"); every phase with an output schema works; the PreToolUse gate still denies what the policy denies (shell interpreters, paths outside the project, web access) for built-in and MCP tools; no SDK shadowing warning; tests with the fake runtime and the SDK option shapes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/runtime-claude --filter=@opscrew/core --filter=@opscrew/agents`
  - Effort: high

- [X] T819 T818 review follow-ups: a tool call that never passed the PreToolUse gate stops the phase (audited as ungated); explicit hook timeouts (PreToolUse long enough for a human approval, PostToolUse redaction never skipped); hook-level tests for `node -e`, `sh -c`, a Grep path outside the project and a second foreign MCP prefix
  - Owns: `packages/runtime-claude/src/**`
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/runtime-claude --filter=@opscrew/agents`
  - Effort: medium

## Phase 3: Live runs (lead)

- [X] T804 Hetzner live pass green after the fixes; results in `docs/e2e.md` (lead)
- [X] T805 Hetzner + Cloudflare pass on `e2e.poasjet.com` (TLS, DNS, WAF) green; results in `docs/e2e.md` (lead)

## Phase 4: Release prep

- [X] T806 [US4] Version 0.1.0, README quickstart, pack and `npx` smoke test of the tarball
  - Owns: `packages/cli/package.json`, `README.md`, `scripts/pack-smoke.*`
  - Accept: SC-803; no publish.
  - Verify: `pnpm turbo run typecheck test build --filter=opscrew && node scripts/pack-smoke.mjs`
  - Effort: medium

## Phase 5: Verification

- [X] T807 Feature verification (lead): `pnpm check`, live passes recorded, converge review; remind the founder to restore poasjet.com to Afternic
