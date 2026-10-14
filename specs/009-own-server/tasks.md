---
description: "Tasks for 009-own-server"
---

# Tasks: Your own server, and Portainer

**Input**: `specs/009-own-server/` (spec.md, plan.md, research.md, data-model.md, contracts/) +
features 000–008 (packages and conventions).
**Numbering**: T901–T999. **Format**: `- [ ] T### [P] [USn] description` + `Owns / Reads / Depends /
Accept / Verify / Effort`. Contracts, schemas, the constitution amendment, the ADR, the new package's
skeleton and the lockfile come from T901; fill only your files. Fixtures never contain secret-shaped
literals (`fakeSecret()` / `{{FAKE:…}}` + `materializeFixture()`). No test touches a real server,
network or model.

## Phase 1: Foundation (serial)

- [X] T901 Contracts, schemas, approvals, local state, package skeleton, constitution 1.3.0 and ADR 0011 in `packages/contracts/src/{connector,safety}.ts`, `packages/plan-schema/src/**` (+ regenerated JSON Schemas), `packages/core/src/approvals.ts`, `packages/agents/src/shared/server-address.ts`, `packages/connectors/ssh-host/{package.json,tsconfig.json,src/index.ts}`, `packages/agents/package.json`, `pnpm-lock.yaml`, `.specify/memory/constitution.md`, `docs/adr/0011-own-servers.md`
  - Accept: plan.md "Contracts, schemas, constitution"; data-model.md; `ProviderId`/`VpsProviderId` include `own`; `ApprovalKind` includes `host-apply` with `assertApprovedHostPlan`; the plan `target` is a union on `provider` with `arch` and `access` for `own`; optional `plan.portainer`; `server.json` gains `own`; every existing artefact, fixture and test still parses and passes (Hetzner and DigitalOcean plans unchanged); `vpsConnector` refuses unknown ids instead of falling through to Hetzner; `pnpm check` passes.
  - Verify: `pnpm check`
  - Effort: xhigh (contracts, schemas, approvals by an agent; constitution, ADR and lockfile by the lead)

## Phase 2: Packages (parallel)

- [X] T902 [P] [US1] [US2] [US4] Host adapter: inspect, plan, apply with dead-man switches, record, teardown and undo in `packages/connectors/ssh-host/src/`
  - Owns: `packages/connectors/ssh-host/src/**`
  - Reads: contracts/host-adapter.md; data-model.md "Host facts", "Host plan", "Host setup record"; research.md R1, R2, R5, R6; `packages/contracts/src/io.ts` (`RemoteExec`); `packages/iac-templates/modules/hetzner-vps/cloud-init.yaml.tftpl` (what OpsCrew-created servers get; do not copy `AllowUsers` or `disable_root`)
  - Depends: T901
  - Accept: the contract exactly; inspection parses fixed read-only commands with zod (fake hosts for Ubuntu 22.04/24.04/26.04, Debian 12/13, amd64/arm64); every finding of FR-904/FR-906/FR-908 and one-app-per-server blocks with a plain message and hint; Docker ≥ 28 from Docker's repository (install or upgrade), refusal for Snap, Podman and distribution Docker; sshd drop-in validated with `sshd -t`, `PermitRootLogin` per the admin user, password logins off only when no other login user lacks a key (otherwise the step needs `params.disablePasswords` set explicitly); ufw only without another firewall, SSH rule for the real port before enable, web rules only in public mode; dead-man switch (`systemd-run --on-active`) around sshd and ufw with `verifyLogin` before cancelling; secrets only through stdin into root-only files, never in commands, plans, errors or logs; hash mismatch refused; idempotent and resumable; `/etc/opscrew/host.json` records previous values; `planTeardown` (data only with `deleteData`) and `planUndo`; every generated script passes `sh -n`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: xhigh

- [X] T903 [P] [US1] [US3] [US5] Templates: own-server root module, tunnel and Access modules, workflow tunnel mode and arm64, Portainer compose in `packages/iac-templates/`
  - Owns: `packages/iac-templates/modules/**`, `packages/iac-templates/src/**`, `packages/iac-templates/scripts/**`, their tests and snapshots
  - Reads: plan.md "Templates"; research.md R3, R4, R5, R7; `packages/iac-templates/src/{infra,workflow,runtime,providers}.ts`
  - Depends: T901
  - Accept: `own` renders no server resources and feeds the DNS module from `server_ipv4`/`server_ipv6` variables that never appear in `terraform.tfvars.json`; the tunnel module (remotely managed tunnel, ingress for the app, SSH and optional Portainer hostnames with a final 404 rule, proxied CNAMEs, sensitive token output from the data source) and the Access module (Service Auth policy + service token for SSH; for Portainer: Zero Trust organization when missing, one-time PIN identity provider, app allowing the listed emails) validate under both engines; workflow tunnel mode downloads cloudflared 2026.5.1, checks its vendored SHA-256, uses `ProxyCommand cloudflared access ssh --hostname %h` with the service token from two new deploy secrets and never echoes them; arm64 plans build on `ubuntu-24.04-arm`; Hetzner and DigitalOcean output is byte-identical to today (snapshots); Portainer compose binds only `127.0.0.1:9443`, mounts the socket and data volume, uses `--admin-password-file`, pins the version.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` (and `OPSCREW_IT=1` with OpenTofu for module validation)
  - Effort: high

- [X] T904 [P] [US1] Provider profile, own-server connector, interview and design in `packages/agents/src/{providers,design,interview}/`
  - Owns: `packages/agents/src/providers/**`, `packages/agents/src/design/**`, `packages/agents/src/interview/**`
  - Reads: plan.md "Provider, interview, design"; contracts/cli.md "Interview"; spec FR-901, FR-913
  - Depends: T901
  - Accept: profile `own` and connector (single unpriced catalogue entry from inspection facts passed in, `servers` undefined); interview offers "A server you already have" with host, port, user, key/agent and reachability questions (answers to local state, `requirements.yaml` keeps only `provider: own`); design: one option without a price, warnings for memory/disk below the app's needs, the tunnel requiring a Cloudflare domain, and the backups note; Hetzner and DigitalOcean unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 3: Flows (parallel after Phase 2)

- [ ] T905 [US1] [US2] [US3] Provision for own servers in `packages/agents/src/provision/`
  - Owns: `packages/agents/src/provision/**`, `packages/agents/src/shared/{remote,wait}.ts`, `packages/agents/src/shared/own-server.ts` (new), `packages/agents/src/init/**`
  - Reads: plan.md "Provision for own servers"; contracts/cli.md "Provision"; spec FR-902, FR-903, FR-905, FR-910
  - Depends: T902, T903, T904
  - Accept: a shared `connectOwnServer`/`inspectOwnServer` helper (in `shared/own-server.ts`, exported) that connects with the recorded login, shows and confirms the host key (or `--host-key`) on first use, pins it in `server.json` and the project's `known_hosts`, runs `inspectHost` and maps the facts to design's `OwnServerFacts` — design's callers (T908) use it before design, provision reuses it; host key shown and confirmed (or `--host-key`), pinned, a mismatch stops; `opscrew init` skips the provider-token check for own servers and checks the `ssh` binary instead; `checkProvider` for own servers says how to connect (interview answers, host key), never "replace the token"; inspect → blocking findings stop before any change; IaC plan/approve/apply for DNS/tunnel/Access with the address only through `TF_VAR_*`; host plan saved under `.opscrew/plans/`, `host-apply` approval by hash (`--approve` twice in scripts; the CLI's non-interactive approval handler grants `host-apply` by hash too, never through `--yes`), apply with the tunnel token from the IaC output and a `verifyLogin` that opens NEW connections (no SSH connection reuse: `ControlMaster=no`, `ControlPath=none`) as the deploy user and the admin login; the tunnel's SSH route uses the server's sshd port from inspection (`facts.sshd.ports`), not a NAT-forwarded port; deploy secrets include the service token in tunnel mode, and the known_hosts deploy secret holds the host key under the SSH hostname (`ssh-<app>.<zone>`) in tunnel mode (or the workflow's SSH config sets a matching `HostKeyAlias`); switching an own server between public and tunnel mode runs as two applies (remove the old DNS/tunnel records, then add the new ones) so Cloudflare never sees an A/AAAA and a CNAME for the same name; the address never reaches committed files, PRs or commit messages; re-running shows no changes; for own servers the hint for a damaged `server.json` never says to delete it (that loses the pinned host key and connection details); Hetzner/DigitalOcean flows unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [ ] T906 [P] [US4] Drift, destroy, secure and verify for own servers in `packages/agents/src/{drift,destroy,secure,verify}/`
  - Owns: `packages/agents/src/drift/**`, `packages/agents/src/destroy/**`, `packages/agents/src/secure/**`, `packages/agents/src/verify/**`
  - Reads: plan.md "Day 2"; contracts/cli.md "Destroy"; spec FR-911, FR-912, FR-913
  - Depends: T902, T903, T904
  - Accept: drift reports IaC drift plus host drift against the record; destroy removes DNS/tunnel/Access and the app (teardown plan; data only with `allowDestroy` + typed app name), never the server, no snapshot; `--undo-host` as a separate approved plan; secure's outside probes expect no web ports in tunnel mode; `secure`'s host checks (`packages/secops/src/hardening/checks.ts`, via the agents' secure flow) accept, for own servers, `PermitRootLogin prohibit-password` when the admin login is root, password logins kept by the user's explicit choice (reported as a plain warning, not a failure), and the server's real SSH ports in `listening-ports` (not only 22); if those rules live in secops, list the exact change for the lead; verify checks the domain only in tunnel mode; texts say backups are the user's responsibility.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [ ] T907 [P] [US5] Portainer on every target in `packages/agents/src/portainer/`
  - Owns: `packages/agents/src/portainer/**`
  - Reads: plan.md "Portainer on every target"; contracts/cli.md "Portainer"; research.md R5; spec FR-914–FR-916
  - Depends: T902, T903
  - Accept: enable/disable/status for own servers (host plan step) and for Hetzner/DigitalOcean (the `deploy` user's home, docker group); the password generated locally into `~/.opscrew/projects/<id>/portainer_password` (0600), supplied at apply only, the server file removed after the admin exists; status prints the tunnel command, the local URL and the password file's path, never the password; subdomain opt-in adds the tunnel and Access (`iac-apply`) and requires at least one allowed email and a Cloudflare domain; disable deletes data only with a typed confirmation.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [X] T911 [P] [US1] The deploy workflow honours the server's SSH port (found by T905: a public-mode own server listening on a port other than 22 cannot be deployed to) in `packages/iac-templates/src/workflow/**`
  - Owns: `packages/iac-templates/src/workflow/**` (+ tests and snapshots)
  - Reads: `packages/iac-templates/src/workflow/index.ts` (`SSH_OPTS`, the `scp` and `ssh` calls); `RenderContext.sshPort` (T903); `packages/agents/src/provision/secrets.ts` (known_hosts uses `[ip]:port` for such ports)
  - Accept: every `ssh` and `scp` call in the deploy and rollback jobs uses the plan's SSH port (`-p` / `-P`) when it is not 22; output for port 22 and for Hetzner/DigitalOcean is byte-identical (snapshots); tunnel mode unchanged (its ProxyCommand uses the server's sshd port).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

## Phase 4: Surfaces and live test

- [ ] T908 [US1] [US4] [US5] CLI commands and flags, MCP tools, plugin skill, user docs in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`, `README.md`
  - Owns: `packages/cli/src/**`, `packages/cli/test/e2e/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/own-server.md`, `docs/guide/portainer.md`, `README.md` (one link line only)
  - Reads: contracts/cli.md; spec FR-917
  - Depends: T905, T906, T907
  - Accept: `--host-key`, repeated `--approve`, `--undo-host`, the `portainer` commands; the CLI interview passes `askServer` (own-server questions work in a terminal) and the MCP interview questions include `buildServerQuestions()`; design's callers (CLI and MCP) run `connectOwnServer`/`inspectOwnServer` before design and pass the facts; the CLI options table (`ui/options.ts`) and the MCP design tool never print a price or "prices live from …" for an own server (FR-913); MCP tools with the same approvals (no auto-approval); the examples end-to-end suite runs one example through an own-server plan with fakes; user docs `docs/guide/own-server.md` and `docs/guide/portainer.md` (written for users: what OpsCrew changes on the server, the two approvals, tunnel mode, undo, backups, Portainer access) and one README line linking to them — no new README section.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: medium

- [ ] T909 [US1] [US3] [US5] Gated live test for own servers in `packages/cli/test/live/own-server.test.ts`, `docs/e2e.md`
  - Owns: `packages/cli/test/live/own-server.test.ts`, `docs/e2e.md` (setup section only)
  - Reads: quickstart.md "Gated live test"; `packages/cli/test/live/live.test.ts` (patterns, cleanup)
  - Depends: T908
  - Accept: quickstart.md steps 1–6; the throwaway server is always deleted, even when a step fails; nothing about the server's address in committed files or PRs.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew` (skips without credentials)
  - Effort: high

- [ ] T910 Live runs (public, tunnel, Portainer, destroy --undo-host) and results in `docs/e2e.md` (lead)
