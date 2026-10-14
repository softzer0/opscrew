# Implementation Plan: Your own server, and Portainer

**Branch**: `mvp` | **Date**: 2026-10-14 | **Spec**: `specs/009-own-server/spec.md` |
**Research**: `specs/009-own-server/research.md`

## Summary

A third deployment target, `own` ("Your own server"), sits next to Hetzner Cloud and DigitalOcean
in the provider seam. OpsCrew does not create the server: it inspects it over SSH, plans the host
changes the cloud-init file makes on OpsCrew-created servers (plus Docker from Docker's repository
and ufw instead of a cloud firewall), and applies them over SSH through a new typed host adapter,
behind an approval bound to the host plan's SHA-256 hash. DNS, and for servers without a public
address a Cloudflare Tunnel with an Access-protected SSH hostname for GitHub Actions, stay
infrastructure as code. Everything after that (deploy workflow, release command, health checks,
verify, secure) is the existing path. Portainer CE becomes an optional, local-only add-on for every
target, with a Cloudflare Access subdomain behind a tunnel as an explicit opt-in.

## Technical Context

Same stack as 000–008 (TypeScript strict ESM, pnpm + Turborepo, Vitest, zod, Biome; OpenTofu or
Terraform). New workspace package `@opscrew/connector-ssh-host` (dependencies: `@opscrew/contracts`,
`@opscrew/core`, `zod`). Remote commands use the `ssh` binary through the existing `CommandRunner`,
as `SshRemoteExec` does today. New HCL resources from the Cloudflare provider v5 already used for
DNS. No new third-party runtime dependency. Server-side software: Docker Engine ≥ 28 (Docker's apt
repository), ufw, unattended-upgrades, cloudflared (container, pinned), Portainer CE (container,
pinned). GitHub workflow: cloudflared 2026.5.1 with a vendored SHA-256; `ubuntu-24.04-arm` for arm64
servers.

## Constitution Check

- **I (safety gate)**: host changes get their own plan (a typed list of steps), policy checks (the
  conflicts of FR-904/FR-908 are blocking findings), an approval of the new kind `host-apply`
  bound to the plan's SHA-256, and the host adapter refuses to apply a plan whose hash differs.
  DNS, the tunnel and Access stay `iac-apply`. Destroy on an own server never removes the server;
  deleting app data needs `allowDestroy` and the typed app name. **Amendment 1.3.0** (T901, lead):
  Principle I's hash-bound apply names "the IaC engine, or OpsCrew's host adapter for host changes";
  the provider order adds "servers the user already owns (over SSH)" after DigitalOcean.
- **II (user owns everything)**: DNS, tunnel and Access are HCL in `opscrew/infra/`; host changes
  are listed in the plan and recorded on the server (`/etc/opscrew/host.json`); destroy can undo
  them.
- **III (dual engine)**: the new modules stay in the common HCL subset and are validated by both
  engines.
- **IV (secrets)**: OpsCrew never asks for passwords or passphrases (the SSH agent handles keys with
  passphrases); the private key is referenced by path, never read into prompts or state; the tunnel
  token and the Access service token are sensitive outputs that go only to the server (root-only
  file) and the deploy secrets; the Portainer password lives only in `~/.opscrew/projects/<id>/`
  and a root-only file on the server that is deleted after first start; the server address stays in
  local state (FR-809/FR-902) and reaches the engine only through the environment.
- **V (deterministic first)**: inspection, host plans and their scripts are fixed templates; no
  model writes host commands.
- **VI (contracts first)**: `ProviderId`/`VpsProviderId` (`"own"`), `ApprovalKind`
  (`"host-apply"`), the plan schema and the local `server.json` schema change in one serial task
  (T901) with ADR 0011; every other task owns one package or one agents area.
- **VIII (typed adapters)**: every host mutation goes through `@opscrew/connector-ssh-host`;
  Cloudflare resources through the IaC engine.
- **IX (plain language)**: every refusal names what was found and what to do; design and the runbook
  say that backups are the user's responsibility.
- **X (simplicity)**: one app per server (founder, 2026-10-14); no retarget to or from own servers;
  no Portainer agents or Business Edition.

## Project Structure

```text
packages/contracts/src/{connector,safety}.ts            # T901: ProviderId/VpsProviderId "own", ApprovalKind "host-apply"
packages/plan-schema/src/** (+ schemas/*.json)           # T901: target "own", access mode, arch, portainer settings
packages/core/src/approvals.ts                           # T901: assertApprovedHostPlan
packages/agents/src/shared/server-address.ts             # T901: server.json gains the own-server entry
.specify/memory/constitution.md, docs/adr/0011-own-servers.md   # T901 (lead)
packages/connectors/ssh-host/**                          # T902: inspect, host plan, apply, record, undo
packages/iac-templates/{modules,src,scripts}/**          # T903: own-server root, cloudflare-tunnel, cloudflare-access,
                                                         #       workflow tunnel mode + arm64, Portainer compose
packages/agents/src/{providers,design,interview}/**      # T904: profile, connector, questions, sizing check
packages/agents/src/provision/**                         # T905: the own-server provision flow
packages/agents/src/{drift,destroy,secure,verify}/**     # T906: host drift, teardown, undo, texts
packages/agents/src/portainer/**                         # T907: enable/disable/status on every target
packages/cli/src/**, packages/mcp-server/src/**, plugin/**, README.md   # T908
packages/cli/test/live/**, docs/e2e.md                   # T909 (live test; results by the lead)
```

## Design

### 1. Contracts, schemas, constitution (T901, serial, lead-reviewed)

- `ProviderId` and `VpsProviderId` gain `"own"`; `VpsProviderSchema` gains `"own"`.
- `ApprovalKind` gains `"host-apply"`; `assertApprovedHostPlan(store, hash)` in core mirrors
  `assertApprovedPlan`.
- Plan `target` for `own`: `{ provider: "own", mode: "vps-compose", arch: "amd64" | "arm64",
  access: "public" | "tunnel" }`; `location`, `serverType`, `image` and `backups` do not apply
  (the schema becomes a discriminated union on `provider`). Plan gains optional
  `portainer: { enabled, version, access: "local" | "subdomain", hostname?, allowedEmails? }`.
- `.opscrew/server.json` gains `own: { host, port, user, keyPath? , agent: boolean, hostKey,
  publicIpv4?, publicIpv6? }` (local only).
- Constitution 1.3.0 and ADR 0011 (decisions R1–R7).

### 2. Host adapter `@opscrew/connector-ssh-host` (T902)

Pure planning plus one apply function, all over an injected `RemoteExec` that runs as the user's
admin login (`sudo -n` when not root). See `contracts/host-adapter.md`.

- `inspectHost(remote)` → `HostFacts` (zod-parsed from fixed read-only commands: `/etc/os-release`,
  `uname -m`, `nproc`, `free -b`, `df -B1 /`, `sudo -n true`, `sshd -T`, `ss -H -ltnp` for 80/443,
  `systemctl is-active` for nginx/apache2/caddy/traefik/haproxy/firewalld, `nft list ruleset`,
  `ufw status`, `snap list docker`, `dpkg-query` for Docker and conflicting packages,
  `docker version`, `getent passwd` with shells and authorized keys, the OpsCrew marker and record).
- `planHost(facts, desired)` → `HostPlan`: ordered steps (`docker`, `deploy-user`, `sshd`, `ufw`,
  `unattended-upgrades`, `runtime-dirs`, `app-marker`, `tunnel-connector`, `portainer`), each
  `in-place`, `change` or `blocked` (with the plain reason), plus blocking findings (unsupported OS,
  sudo needs a password, ports taken, another firewall, Snap/Podman/distro Docker, another OpsCrew
  app). Canonical JSON → SHA-256. Secrets are referenced, never included.
- `applyHostPlan(remote, plan, { approvedHash, secrets, verifyLogin })`: refuses on a hash mismatch;
  runs each `change` step as check → apply → verify; `sshd` and `ufw` run under the R6 dead-man
  switch and call `verifyLogin` (new connections as the deploy user and as the admin login) before
  cancelling it; records every change and the previous value in `/etc/opscrew/host.json`; idempotent
  and resumable after a dropped connection.
- `planUndo(record)` and `planTeardown(record, { deleteData })` produce host plans for destroy.
- Steps are fixed shell templates with shell-quoted parameters; tests run the generated scripts
  against fake hosts (and `sh -n`) without a network.

### 3. Templates (T903)

- `own-server` root module: no server resources; `module "dns"` gets `server_ipv4`/`server_ipv6`
  from variables supplied through `TF_VAR_*` at plan time (never in `terraform.tfvars.json`).
- `cloudflare-tunnel` module: tunnel (`config_src = "cloudflare"`), its config (app hostname → Caddy,
  SSH hostname → `ssh://localhost:<port>`, optional Portainer hostname → `https://localhost:9443`
  with `no_tls_verify`, final `http_status:404`), proxied CNAMEs, the token data source (sensitive
  output).
- `cloudflare-access` module: Access app for the SSH hostname with a Service Auth policy and a service
  token (sensitive outputs); for the Portainer opt-in, the Zero Trust organization when missing, the
  one-time PIN identity provider and an app allowing the listed emails.
- Workflow: tunnel mode installs cloudflared 2026.5.1 (SHA-256 vendored), sets `ProxyCommand` with
  the service-token env vars from two new deploy secrets, and uses the SSH hostname; `runs-on` is
  `ubuntu-24.04-arm` for arm64 servers. Public mode is unchanged.
- Portainer compose (`127.0.0.1:9443:9443`, socket, volume, `--admin-password-file`, pinned image).

### 4. Provider, interview, design (T904)

- Profile `own`: display name "Your own server", `serverNoun` "server", no token variables, no
  delete protection, `backupsOutliveServer` not applicable, no regions; `vpsConnector("own")` returns
  an own-server connector whose `catalog()` is the inspected server as the single, unpriced option and
  whose `servers` is undefined; `vpsConnector` no longer falls through to Hetzner for unknown ids.
- Interview: the provider question offers "A server you already have"; follow-ups ask for the
  address, SSH port (22), SSH user, key (path, or the SSH agent) and whether the internet can reach
  the server (suggested from the inspected addresses).
- Design: one option, "your server", no price ("you already pay for this server"); warnings when
  memory or disk are below the app's needs; the tunnel requires a Cloudflare domain; the backups note.

### 5. Provision for own servers (T905)

Order: preconditions → connect and confirm the host key (FR-903) → inspect → refuse on blocking
findings → render → IaC plan, policy, `iac-apply` approval, apply (DNS, tunnel, Access) → host plan
(with the tunnel token and Portainer password supplied as secrets at apply) → policy → `host-apply`
approval → apply → record the address → deploy secrets (plus the service-token secrets in tunnel
mode) → publish the deploy pull request. `--plan-only` and `--approve <hash>` cover both plans.

### 6. Day 2 (T906)

- `drift`: IaC drift for DNS/tunnel/Access plus host drift (re-inspect and compare with
  `/etc/opscrew/host.json` and the desired plan).
- `destroy`: IaC destroy for DNS/tunnel/Access, then a teardown host plan (app containers, runtime
  files, marker; data only with `allowDestroy` and the typed app name), deploy secrets removed;
  `--undo-host` adds the undo plan as a separate approval. No snapshots, no server deletion.
- `secure`: host checks as today; outside probes expect no web ports in tunnel mode.
- `verify`: unchanged for public mode; tunnel mode checks the domain only.
- Texts: backups are the user's responsibility; no server price.

### 7. Portainer on every target (T907)

`opscrew portainer enable [--subdomain <host> --allow-email <email>…]`, `opscrew portainer disable`,
`opscrew portainer status`. On own servers it is a host-plan step; on Hetzner and DigitalOcean the same
step runs as the `deploy` user (member of the `docker` group, which cloud-init sets up) in its home
directory. The subdomain opt-in adds the tunnel and Access modules through `iac-apply`. Status prints
the SSH tunnel command and the local URL, and names the password file.

### 8. Surfaces (T908)

CLI commands and flags (`--host-key`, `--undo-host`, the Portainer commands), MCP tools with the same
approvals, plugin skill text, README.

### 9. Live test (T909)

The test creates a throwaway Hetzner server through Hetzner's API (not through OpsCrew), passes it to
OpsCrew as the user's own server (root with a test key), and runs: public mode with a domain;
tunnel mode with ufw blocking web traffic; Portainer local-only (port scan from outside, tunnel
command works); destroy with `--undo-host`; it then deletes the server itself.

## Order

1. T901 (serial).
2. T902, T903, T904 in parallel.
3. T905, T906, T907 in parallel (T905 first if they collide in `provision/`).
4. T908, then T909 and the live runs.

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| New package `@opscrew/connector-ssh-host` | Host mutations need a typed adapter (Principle VIII) with plans, hashes and undo | Ad-hoc SSH commands from agents would bypass the safety gate |
| New approval kind `host-apply` | A host plan is not an IaC plan; mixing them in `iac-apply` would blur what was approved | Reusing `iac-apply` with a different hash format would make audits ambiguous |
| Dead-man switch on the server | An established SSH session can drop when sshd reloads or ufw starts | Checking after the fact cannot restore access once it is lost |
