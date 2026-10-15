# Implementation Plan: An existing Portainer as a deploy target

**Branch**: `mvp` | **Date**: 2026-10-15 | **Spec**: `specs/010-portainer-target/spec.md` |
**Research**: `specs/010-portainer-target/research.md`

## Summary

A fourth deployment target, `portainer` ("my existing Portainer"), sits next to Hetzner Cloud,
DigitalOcean and the user's own server. OpsCrew creates nothing on the host and never uses SSH: it
inspects Portainer through its API, plans the Portainer changes (the app's Git stack built from an
`opscrew-deploy` branch, a tiny updater stack or a Cloudflare connector for redeploys, the registry
entry for the image, the repository access), and applies them through a new typed Portainer
adapter behind an approval of the new kind `stack-apply`, bound to the stack plan's SHA-256 hash.
DNS, the tunnel and Access stay infrastructure as code. The deploy workflow gains a Portainer mode:
build and push the image, write its digest to the deploy branch, let Portainer redeploy (through
the updater or a webhook call through Cloudflare Access), check the site and roll back by writing
the previous digest.

## Technical Context

Same stack as 000–009 (TypeScript strict ESM, pnpm + Turborepo, Vitest, zod, Biome; OpenTofu or
Terraform). New workspace package `@opscrew/connector-portainer` (dependencies:
`@opscrew/contracts`, `@opscrew/core`, `zod`), using Node's `https` for certificate pinning behind
an injected request function (tests use fakes; no network). No new third-party runtime dependency.
Supported Portainer: CE or BE 2.45 or newer, single Docker host environment, Compose 2.23 or newer
(R1). Updater image: the official `curlimages/curl`, pinned by digest. Cloudflare resources reuse
009's `cloudflare-tunnel` and `cloudflare-access` modules. Tokens come from the environment:
`PORTAINER_API_KEY`, `OPSCREW_GHCR_READ_TOKEN` (private images), `OPSCREW_REPO_READ_TOKEN` (private
repositories).

## Constitution Check

- **I (safety gate)**: Portainer changes get their own plan (a typed list of changes), policy checks
  (FR-1004's conflicts are blocking findings), an approval of the new kind `stack-apply` bound to
  the plan's SHA-256, and the Portainer adapter refuses a plan whose hash differs. DNS, the tunnel
  and Access stay `iac-apply`. Destroy never touches Portainer itself or other stacks; deleting data
  needs `allowDestroy` and the typed app name. **Amendment 1.4.0** (T1001, lead): Principle I names
  the Portainer adapter next to the IaC engine and the host adapter; the provider order adds "a
  Portainer the user already runs (through its API)".
- **II (user owns everything)**: the app's compose file lives in the user's repository (the deploy
  branch); Cloudflare resources are HCL in `opscrew/infra/`; what OpsCrew created in Portainer is
  recorded locally and removed exactly on destroy.
- **III (dual engine)**: no new HCL beyond reusing 009's modules; validated by both engines.
- **IV (secrets)**: tokens come from the environment and are never stored; app secrets reach
  Portainer only as `Env` through the API and are never printed, planned or audited (Portainer
  returns them in plain text); the webhook UUID, the tunnel token and the Access service token are
  secrets; Portainer's address stays in local state.
- **V (deterministic first)**: inspection, stack plans and the rendered stacks are fixed templates;
  no model writes stack files or API calls.
- **VI (contracts first)**: `ProviderId` (`"portainer"`), `ApprovalKind` (`"stack-apply"`), the plan
  schema's target and the local `server.json` entry change in one serial task (T1001) with ADR 0012.
- **VIII (typed adapters)**: every Portainer mutation goes through `@opscrew/connector-portainer`.
- **IX (plain language)**: every refusal names what was found and what to do; design, the runbook,
  secure and destroy say OpsCrew does not change the host and that backups are the user's
  responsibility.
- **X (simplicity)**: one environment type (single Docker host); no Portainer password, token
  creation or Business Edition feature; no retarget to or from Portainer.

## Project Structure

```text
packages/contracts/src/{connector,safety}.ts            # T1001: ProviderId "portainer", ApprovalKind "stack-apply"
packages/plan-schema/src/** (+ schemas/*.json)           # T1001: target "portainer" (environment, arch, redeploy, web)
packages/core/src/approvals.ts                           # T1001: assertApprovedStackPlan
packages/agents/src/shared/server-address.ts             # T1001: server.json gains the portainer entry
.specify/memory/constitution.md, docs/adr/0012-portainer-target.md   # T1001 (lead)
packages/connectors/portainer/**                         # T1002: pinned client, inspect, stack plan, apply, record, teardown
packages/iac-templates/src/{runtime,portainer-target,workflow}/**    # T1003: app stack, updater stack, workflow Portainer mode
packages/agents/src/{providers,interview,design}/**      # T1004: profile, connector, questions, design option
packages/agents/src/provision/**                         # T1005: the Portainer provision flow
packages/agents/src/{drift,destroy,secure,verify}/**     # T1006: drift, teardown, texts
packages/cli/src/**, packages/mcp-server/src/**, plugin/**, docs/guide/portainer-target.md, README.md   # T1007
packages/cli/test/live/**, docs/e2e.md                   # T1008 (live test; results by the lead, T1009)
```

## Design

### 1. Contracts, schemas, constitution (T1001, serial, lead-reviewed)

- `ProviderId` gains `"portainer"` (not a `VpsProviderId`: there is no server to create, size or
  price). `ApprovalKind` gains `"stack-apply"`; `assertApprovedStackPlan(store, hash, options)` in
  core mirrors `assertApprovedHostPlan` (including `allowDestroy`).
- Plan `target` for `portainer`: `{ provider: "portainer", mode: "portainer-stack", environmentId:
  number, arch: "amd64" | "arm64", redeploy: "updater" | "cloudflare", web: { mode: "tunnel" } |
  { mode: "proxy", port: number } | { mode: "caddy" } }`; the plan-schema rules: `tunnel` and
  `cloudflare` need a Cloudflare domain; `caddy` needs a domain; names Cloudflare serves stay one
  level below the zone (T924).
- `.opscrew/server.json` gains `portainer: { url, certFingerprint, environmentId, environmentName,
  created: { stacks: [{ id, name }], registryId?, volumes: [] } }` (local only; never the token).
- Constitution 1.4.0 (drafted) and ADR 0012 (decisions R1–R10).

### 2. Portainer adapter `@opscrew/connector-portainer` (T1002)

See `contracts/portainer-adapter.md`.

- A pinned client: HTTPS with the certificate's SHA-256 fingerprint checked on every connection
  (plain HTTP only for `localhost`), `X-API-Key`, zod-parsed responses, plain errors (401/403 name
  the missing access; 409 names the conflicting stack), the token added to the redactor.
- `inspectPortainer(client, { environmentId?, names })` → `PortainerFacts` (read-only): version and
  edition, Compose version, the token's user and role, environments (type, Swarm, status), the
  chosen environment's architecture, stacks with OpsCrew's names (ids, status, `AutoUpdate`, file,
  env keys only), registries usable on the environment, and (admin only) containers using OpsCrew's
  project names and the published ports 80/443.
- `planStacks(facts, desired)` → `StackPlan`: ordered changes (`registry`, `app-stack`,
  `updater-stack` or `tunnel-connector-stack`) each `in-place`, `change` or `blocked`, plus blocking
  findings; canonical JSON → SHA-256. Secrets are referenced by name, never included.
- `applyStackPlan(client, plan, { approvedHash, secrets, wait })`: refuses on a hash mismatch;
  applies each change, waits (bounded) for asynchronous stack deploys (`Status` 1, or the error
  message), records every id it creates, and stops at the first failure with what was done.
- `planTeardown(facts, record, { deleteData })` and its apply remove exactly the recorded stacks,
  the registry entry and (with `deleteData`) the recorded volumes.

### 3. Templates (T1003)

- `renderPortainerStack(plan, ctx)` → the app's `compose.yaml` for the deploy branch (R7): explicit
  `${VAR}` interpolation, the release service, Postgres/Redis volumes, inline Caddy `configs`, the
  web mode (tunnel connector service; proxy port; Caddy on 80/443), log rotation, `no-new-privileges`,
  project name `opscrew-<app>`.
- `renderUpdaterStack(ctx)` → the updater's compose (curl pinned by digest; the webhook URL and the
  pinned public key come from `Env`).
- Workflow Portainer mode: build and push as today; write `compose.yaml` with the new digest to the
  `opscrew-deploy` branch (the job has `contents: write` only for that); in `cloudflare` mode call
  the webhook through Access (service-token secrets); wait for the health URL; on failure write the
  previous digest back (and call the webhook again in `cloudflare` mode) and fail the run.
- The Cloudflare root for a Portainer target: the app tunnel (web `tunnel`; for `proxy` and `caddy`
  OpsCrew creates no DNS record and prints the one the user creates), and in `cloudflare` redeploy
  mode a tunnel route for the webhook path only plus Access for the Portainer hostname; reuses
  009's modules.

### 4. Provider, interview, design (T1004)

- Provider profile `portainer` (display name "My existing Portainer"); `vpsConnector` is not used.
- Interview: `portainer.url`, the environment (listed from Portainer), `portainer.redeploy`
  (`updater` default, `cloudflare`), `portainer.web` (`tunnel` default, `proxy` with a port,
  `caddy`), the certificate fingerprint confirmed on first connection; the token only from
  `PORTAINER_API_KEY`.
- Design: one option, no price, with the environment's architecture and the notes (no host
  changes, backups are the user's).

### 5. Provision for a Portainer target (T1005)

Order: preconditions (tokens, GitHub, Cloudflare when needed) → connect with the pinned certificate
→ inspect → refuse on blocking findings (including the limited-token registry guidance, FR-1018) →
render → IaC plan, policy, `iac-apply` approval, apply (DNS, tunnel, Access) → push the deploy
branch with a placeholder `compose.yaml` (R11, `git-push` approval) → stack plan (registry, app stack,
updater or connector stack) → policy → `stack-apply` approval → apply with secrets (`Env`, the
webhook UUID, the tunnel token) → record → deploy secrets (the webhook URL and Access service token
in `cloudflare` mode) → publish the deploy pull request. `--plan-only` and `--approve <hash>` cover
both plans.

### 6. Day 2 (T1006)

- Drift: the stack file, env keys (never values), `AutoUpdate`, the registry entry and the deploy
  branch against what OpsCrew renders, plus the IaC plan; read-only.
- Destroy: IaC (DNS/tunnel/Access; the connector stack goes first, as in T921) and a stack teardown
  plan (`stack-apply`, `allowDestroy` + typed app name); never Portainer itself or other stacks;
  volumes only with `--delete-data`.
- Verify: the site through its domain (or the user's route); secure: the app and its stack; texts
  say OpsCrew does not change the host and backups are the user's.

### 7. Surfaces (T1007)

CLI flags and commands as in `contracts/cli.md`; MCP tools with the same approvals (no
auto-approval; the certificate confirmed in a dialog; deleting data stays in the terminal); the
plugin skill; `docs/guide/portainer-target.md` and one README link line.

### 8. Live test (T1008)

A throwaway Hetzner server with Portainer CE 2.45.2 installed by the test (R10), a decoy Compose
project and a decoy Portainer stack; deploys an example app in `updater` mode with `tunnel`, then
switches to `caddy` and to `cloudflare` redeploy; checks a merged change deploys, a broken change
rolls back, the decoys are unchanged, drift is clean; destroys (with and without data) and deletes
the server.

## Order

1. T1001 (serial).
2. T1002, T1003, T1004 in parallel.
3. T1005, then T1006 (both touch provision/destroy seams).
4. T1007, then T1008 and the live runs (T1009).

## Complexity Tracking

| Item | Why | Simpler alternative rejected because |
|---|---|---|
| A separate updater stack | Portainer's own Git polling does not run in 2.45.2 (R5) | polling would silently never deploy; exposing the webhook would open Portainer to the internet |
| A pinned HTTPS client | Portainer's default certificate is self-signed (R2) | disabling verification would expose the token |
