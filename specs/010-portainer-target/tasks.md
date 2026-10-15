---
description: "Tasks for 010-portainer-target"
---

# Tasks: An existing Portainer as a deploy target

**Input**: `specs/010-portainer-target/` (spec.md, plan.md, research.md, data-model.md, contracts/,
quickstart.md) + features 000–009 (packages and conventions).
**Numbering**: T1001–T1099. **Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads /
Depends / Accept / Verify / Effort`. Contracts, schemas, the new package's skeleton and the lockfile
come from T1001 (the constitution 1.4.0 and ADR 0012 are already committed); fill only your files.
Fixtures never contain secret-shaped literals (`fakeSecret()` / `{{FAKE:…}}` +
`materializeFixture()`). No test touches a real Portainer, network or model.

## Phase 1: Foundation (serial)

- [X] T1001 Contracts, schemas, approvals, local state and the adapter package's skeleton in `packages/contracts/src/{connector,safety}.ts`, `packages/plan-schema/src/**` (+ regenerated `schemas/*.json`), `packages/core/src/approvals.ts`, `packages/agents/src/shared/server-address.ts`, `packages/connectors/portainer/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`
  - Owns: those paths (+ their tests); `packages/agents/package.json` (only the new dependency line)
  - Reads: plan.md "1. Contracts, schemas, constitution"; data-model.md "Plan target" and "Portainer connection"; research.md R3, R8; how 009's T901 added `own` and `host-apply` (git log of `packages/contracts`, `packages/core/src/approvals.ts`)
  - Depends: —
  - Accept: `ProviderId` includes `"portainer"` and `VpsProviderId` does not; `ApprovalKind` includes `"stack-apply"`, `APPROVAL_KINDS` and `validateRequest` require a 64-hex plan hash for it, and `assertApprovedStackPlan(store, hash, { allowDestroy })` mirrors `assertApprovedHostPlan`; the plan `target` gains `{ provider: "portainer", mode: "portainer-stack", environmentId, arch: "amd64" | "arm64", redeploy: "updater" | "cloudflare", web: { mode: "tunnel" } | { mode: "proxy", port } | { mode: "caddy" } }` in the discriminated union, with the rules: `tunnel` web mode and `cloudflare` redeploy need `dns.provider: cloudflare` and a domain, `caddy` needs a domain, Cloudflare-served names stay one level below the zone (as T924), `proxy` ports 1–65535, no retarget to or from `portainer`; the JSON schemas are regenerated; `.opscrew/server.json` gains `portainer: { url, certFingerprint?, environmentId, environmentName, created: { stacks: [{ id, name, role: "app" | "updater" | "tunnel-connector" }], registryId?, volumes: string[] } }` with no token field; the package `@opscrew/connector-portainer` exists (exports nothing yet) and `@opscrew/agents` depends on it; Hetzner, DigitalOcean and own-server plans and hashes unchanged.
  - Verify: `pnpm check`
  - Effort: high (contracts, schemas and approvals by an agent; the lockfile by the lead)

## Phase 2: Packages (parallel)

- [ ] T1002 [P] [US1] [US2] [US5] Portainer adapter: pinned client, inspect, stack plan, apply, record and teardown in `packages/connectors/portainer/src/`
  - Owns: `packages/connectors/portainer/src/**`
  - Reads: contracts/portainer-adapter.md; data-model.md "Portainer facts", "Stack plan", "Portainer connection"; research.md R1–R7, R9, R11; `packages/connectors/hetzner/src/client.ts` and `__fixtures__/fake-fetch.ts` (client, zod and error patterns); `@opscrew/core` redactor and errors
  - Depends: T1001
  - Accept: the contract exactly. A pinned request function: HTTPS where the certificate's SHA-256 fingerprint is compared before any request is sent (a changed certificate fails with a plain message naming both fingerprints, never the token), plain HTTP only for `localhost`/`127.0.0.1`/`::1`, `X-API-Key` on every authenticated call, the token registered with the redactor; tests against a local HTTPS server with a certificate generated at test time (skipped with a clear message when the platform cannot make one). `fetchCertificateFingerprint`. `inspectPortainer` parses with zod every response named in research R1–R4, R6 (version via `/api/system/status` and `/api/system/version`; `/api/users/me`; `/api/endpoints` with `Type` and `Snapshots[0].Swarm`; `docker/info` architecture; stacks with OpsCrew names and their env KEYS only; registries usable on the environment; for admins only, containers using OpsCrew project names and published ports 80/443) and turns into blocking findings: version below 2.45, Compose below 2.23, Swarm/Kubernetes/Edge environments, missing access (401/403 named), an OpsCrew name taken by a stack not in the record or (admin) by containers of an outside project, a limited token without a usable `ghcr.io` registry when the image is private (FR-1018 guidance with the exact steps), ports 80/443 taken for Caddy. `planStacks` orders `registry` (admin only), `app-stack`, `updater-stack` or `tunnel-connector-stack`, each `in-place`/`change`/`blocked`, never including a secret; `stackPlanHash` is SHA-256 of canonical JSON. `applyStackPlan` refuses a hash mismatch (PLAN_HASH_MISMATCH), creates the registry and grants it to the environment, creates the app Git stack from `refs/heads/opscrew-deploy` with `RepositoryAuthentication` for private repositories and `AutoUpdate: { Webhook: <uuid>, ForcePullImage: false }`, creates the updater or connector string stack, always sends the full `Env`, waits (bounded, injected clock/sleep) for `Status` 1 or reports `DeploymentStatus[-1].Message` on 4, records every id it created, and stops at the first failure saying what was done. `planStackTeardown` + apply remove exactly the recorded stacks and registry entry, and with `deleteData` first the recorded volumes through the Docker proxy endpoint. A fake Portainer (route map) covers every path, including the failure semantics of research R7, and encodes the R5 assumption that a webhook call for an unchanged branch does not redeploy, with a comment that the live test (T1008) checks it.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-portainer`
  - Effort: xhigh

- [X] T1003 [P] [US1] [US3] [US4] Templates: the app stack, the updater stack, the workflow's Portainer mode and the Cloudflare root in `packages/iac-templates/src/{portainer-target,workflow,infra}/`
  - Owns: `packages/iac-templates/src/portainer-target/**` (new), `packages/iac-templates/src/workflow/**` (the Portainer mode only), `packages/iac-templates/src/infra/portainer.ts` (new) and the export lines in `src/index.ts`, `src/infra/index.ts` (+ tests and snapshots)
  - Reads: plan.md "3. Templates"; research.md R5, R7, R8, R11; `src/runtime/index.ts` (compose, Caddyfile, `Cf-Visitor` redirect, `serviceLogging()`), `src/tunnel/**` and `src/infra/{own,tunnel}.ts` (009's Cloudflare root and modules), `src/workflow/index.ts`
  - Depends: T1001
  - Accept: `renderPortainerStack(plan, ctx)` → the app `compose.yaml` with `name: opscrew-<app>`, every app variable as explicit `${VAR}` in `environment:`, the release command as a one-off service the app waits for (`depends_on: { release: { condition: service_completed_successfully } }`), Postgres/Redis with named volumes, Caddy's configuration inline through Compose `configs` with `content` (no file next to the compose file), the web mode (`tunnel`: a cloudflared service with `TUNNEL_TOKEN=${TUNNEL_TOKEN}` and Caddy on plain HTTP with the `Cf-Visitor` redirect; `proxy`: Caddy published on the chosen host port, forwarding to the app with an `X-OpsCrew-Image` header; `caddy`: 80/443 with automatic certificates; OpsCrew's own variables named `OPSCREW_*` and app variables named `OPSCREW_*`/`COMPOSE_*` refused), per-service log rotation and `no-new-privileges`; `renderPlaceholderStack()` (R11: one pinned curl service that only sleeps, no ports); `renderUpdaterStack()` → `opscrew-<app>-updater` with `curlimages/curl` pinned by digest calling `POST ${PORTAINER_WEBHOOK_URL}` every 60 s with `--pinnedpubkey ${PORTAINER_PINNED_KEY}` and `extra_hosts: host.docker.internal:host-gateway`; all three pass `docker compose config` when Docker is available (gated by `OPSCREW_DOCKER_TESTS=1`). The workflow's Portainer mode: build and push as today; a job with `contents: write` that writes `compose.yaml` with the new digest to the orphan branch `opscrew-deploy`; in `cloudflare` mode it calls the webhook through Cloudflare Access with the service-token secrets; it waits (bounded) for the health URL and on failure writes the previous digest back (and calls the webhook again in `cloudflare` mode) and fails the run; every other target's workflow is byte-identical (snapshots). The Cloudflare root for `portainer`: no DNS record for `proxy`/`caddy` (the user creates it), the app tunnel for `tunnel`, and in `cloudflare` redeploy mode a tunnel route for `^/api/stacks/webhooks/` only plus Access for the Portainer hostname, reusing 009's modules (an optional route `path` and an Access label added to them); `renderDeployment` routes a Portainer plan to the Portainer renderer; both engines validate (`OPSCREW_IT=1`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [X] T1004 [P] [US1] Provider profile, interview and design for a Portainer target in `packages/agents/src/{providers,interview,design}/`
  - Owns: `packages/agents/src/providers/**`, `packages/agents/src/interview/**`, `packages/agents/src/design/**` (the Portainer parts, + tests)
  - Reads: contracts/cli.md "Interview"; data-model.md "Plan target", "Portainer connection"; 009's own-server interview and design (`interview/own-server.ts`, `design/own.ts`); `@opscrew/connector-portainer` root exports (from T1002 when merged; until then the contract)
  - Depends: T1001
  - Accept: provider profile `portainer` ("My existing Portainer"; no catalogue, no price); the provider question offers it; `buildPortainerQuestions(context)` asks `portainer.url`, `portainer.environment` (listed from Portainer through the adapter, after the certificate is confirmed through an injected callback), `portainer.redeploy` (`updater` default, `cloudflare`), `portainer.web` (`tunnel` default when the domain is on Cloudflare, else `proxy`; `caddy`) and `portainer.port` (for `proxy`); answers saved to `server.json` → `portainer` (never the token, which only comes from `PORTAINER_API_KEY`); refusals: `tunnel`/`cloudflare` without a Cloudflare domain, `caddy` without a domain, names Cloudflare serves deeper than one level below the zone; design builds one unpriced option with the environment's architecture and the notes that OpsCrew does not change the host and backups are the user's; the plan's `target` follows the answers; Hetzner, DigitalOcean and own-server flows unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 3: Flows

- [ ] T1005 [US1] [US2] [US3] [US4] Provision for a Portainer target in `packages/agents/src/provision/`
  - Owns: `packages/agents/src/provision/portainer.ts` (new), `packages/agents/src/provision/{run,types}.ts` (the Portainer branch), `packages/agents/src/provision/secrets.ts` (Portainer deploy secrets), `packages/agents/src/shared/server-address.ts` (the Portainer record schema only), `packages/agents/src/interview/portainer.ts` (the fingerprint normaliser switch only) (+ tests, fixtures)
  - Reads: plan.md "5. Provision"; research.md R4, R5, R8, R11; 009's own-server provision (`provision/own.ts`, `run.ts` steps, `connectorFirst`, `planAndApply` hooks); contracts/portainer-adapter.md; the T1003 renderers
  - Depends: T1002, T1003, T1004
  - Accept: the order of plan.md §5: preconditions (tokens from the environment, GitHub, Cloudflare when needed) → connect with the pinned certificate from `server.json` (a changed certificate stops with a plain message) → inspect → blocking findings (including the FR-1018 registry guidance) → render → IaC plan, policy, `iac-apply` approval, apply → push the deploy branch with the placeholder (R11, `git-push` approval) → stack plan → `stack-apply` approval → apply with the secrets (app `Env`, the webhook UUID generated and kept in `~/.opscrew/projects/<id>/` 0600, the repository and registry tokens, the tunnel token) → record in `server.json` → deploy secrets (in `cloudflare` mode the webhook URL and the Access service token) → the deploy pull request; `--plan-only` and `--approve <hash>` cover both plans; `--yes` never approves `stack-apply`; re-running with nothing changed shows no changes; no secret or Portainer address in plans, output, audit entries, files or the pull request; Hetzner, DigitalOcean and own-server provision unchanged. From the T1002/T1003 reviews: the engine gets Portainer's address only as the sensitive `TF_VAR_portainer_origin`; the IaC output `tunnel_token` goes into the app stack's `env` as `OPSCREW_TUNNEL_TOKEN` and `portainer_tunnel_token` into `secrets.tunnelToken`; `secrets.updaterEnv` is built from the webhook UUID and `inspectCertificate(url).publicKeyPin`; an unset optional app variable is sent as ""; a `StackApplyError` still records its `record` in `server.json` before the error is shown; in `proxy`/`caddy` mode the output names the DNS record the user creates; `interview/portainer.ts` switches its local `normalizeCertFingerprint` to the connector's (the TODO); a random 32-byte value key in `~/.opscrew/projects/<id>/portainer-env.key` (0600, created once) passed as `valueKey` to the client and to apply, with `valueFingerprints()` of the local values in `DesiredStacks.valueFingerprints`, so a rotated secret plans an update by key name; `registry.username` is the GitHub owner; `CreatedStackSchema` in `packages/agents/src/shared/server-address.ts` accepts the adapter's stack names (an app name may end with a dash, as plan-schema allows); replacing the repository or registry token is an explicit input.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T1006 [US5] Drift, destroy, verify and secure for a Portainer target in `packages/agents/src/{drift,destroy,verify,secure}/`
  - Owns: `packages/agents/src/{drift,destroy,verify,secure}/**` (the Portainer parts, + tests)
  - Reads: plan.md "6. Day 2"; research.md R7, R9; 009's own-server drift/destroy/verify/secure; T921/T922 (connector first, the tunnel wait)
  - Depends: T1005
  - Accept: drift compares the stack file, env keys (never values), `AutoUpdate`, the registry entry and the deploy branch's head with what OpsCrew renders, plus the IaC plan; read-only; destroy runs the stack teardown plan (`stack-apply`, `allowDestroy` + typed app name) and the IaC destroy (a connector stack goes first, then the tunnel after Cloudflare reports no connections), removes only what the record lists, never Portainer itself or another stack, deletes volumes only with `--delete-data` and the typed name; verify checks the site through its domain (or the user's route for `proxy`); secure checks the app and its stack; every text says OpsCrew does not change the host and backups are the user's; no Portainer address or secret in any output or file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew`
  - Effort: high

## Phase 4: Surfaces and live test

- [ ] T1007 [US1] [US2] [US5] CLI, MCP tools, plugin and user docs in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/portainer-target.md`, `README.md`
  - Owns: `packages/cli/src/**`, `packages/cli/test/e2e/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/portainer-target.md`, `README.md` (one link line only)
  - Reads: contracts/cli.md; spec FR-1017; 009's T908 (how `--host-key`, `--approve`, `--confirm` and the MCP dialogs work)
  - Depends: T1005, T1006
  - Accept: `--portainer-cert SHA256:…` (scripts), the certificate confirmed interactively otherwise; (from the T1004 review) `packages/cli/src/ui/options.ts` and the MCP design tool treat a `portainer` option like `own`: no price, no "fits", no "prices live from", and never the placeholder sizes; the MCP wiring never fills `PortainerInterviewOptions.certFingerprint` from tool input (only the dialog callback); the `PortainerAccess.listEnvironments` wiring maps the adapter's kinds (`docker-agent` → `docker`, `swarm: true` → `swarm`) and reads each environment's architecture (`dockerInfo`); `packages/cli/src/approval.ts` grants `stack-apply` only for a listed hash (`--yes` never); the destroy typed-name handler covers the stack teardown; the interview asks the Portainer questions in a terminal and the MCP interview returns them; MCP tools with the same approvals (no auto-approval; the certificate confirmed in a dialog; destroy and deleting data stay in the terminal; results never show Portainer's address or a token); the plugin skill; `docs/guide/portainer-target.md` written for users (what OpsCrew creates in Portainer and never touches, the tokens to create and their least permissions, the three web modes, the two redeploy modes, the limited-token registry steps, backups, removal) and one README line.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

- [ ] T1008 [US1] [US2] [US3] [US4] [US5] Gated live test against a throwaway Portainer CE in `packages/cli/test/live/portainer-target.test.ts`, `docs/e2e.md`
  - Owns: `packages/cli/test/live/portainer-target.test.ts` and helpers `packages/cli/test/live/portainer-*.ts`, `docs/e2e.md` (the setup section only)
  - Reads: quickstart.md "Gated live test"; research.md R10, R5 (the unchanged-branch webhook check); `packages/cli/test/live/own-server.test.ts` and its helpers (patterns, cleanup, leak check, per-run hostname)
  - Depends: T1007
  - Accept: quickstart.md steps 1–6; also checks that an updater webhook call for an unchanged branch does not redeploy (records the result in the run log), and the adapter's other live assumptions (T1002 report: `POST /api/stacks/{id}/git` then `PUT …/git/redeploy` for updates, whether `GET /api/stacks/{id}` returns `GitConfig`, that stopping a stack removes its containers, that GHCR ignores the registry user name), whether a bare `NAME:` environment entry stays unset when the stack has no value for it, the real shape of `DeploymentStatus` (logged without values), and that the Portainer hostname answers 404 outside `/api/stacks/webhooks/`; in `caddy` mode the test creates the DNS record OpsCrew prints (per-run hostname) and removes it in cleanup; the throwaway server is always deleted, even when a step fails; the decoy Compose project and the decoy Portainer stack are unchanged after every step; no token, secret or Portainer address in committed files, pull requests or output; a per-run hostname.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (skips without credentials)
  - Effort: high

- [ ] T1009 Live runs (updater + tunnel, caddy, cloudflare redeploy, destroy with and without data) and results in `docs/e2e.md` (lead)

## Dependencies

T1001 → {T1002, T1003, T1004} (parallel) → T1005 → T1006 → T1007 → T1008 → T1009.

## Parallel execution

- After T1001: T1002 (connector), T1003 (iac-templates) and T1004 (agents providers/interview/design)
  touch disjoint packages and run together.

## Implementation strategy

MVP: US1 + US2 (T1001–T1005 with the updater redeploy and one web mode) deploys to an existing
Portainer safely; US3/US4 (the other web modes and the Cloudflare redeploy) and US5 (day 2) follow in
T1003/T1005/T1006; surfaces and the live test close the feature.
