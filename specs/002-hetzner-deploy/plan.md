# Implementation Plan: Hetzner Deploy (Phase 1b)

**Branch**: `mvp` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)
**Input**: `specs/002-hetzner-deploy/spec.md`; foundation `specs/000-platform-architecture/`;
planning outputs from `specs/001-scan-and-plan/`.

## Summary

Infrastructure is plain HCL rendered from `plan.yaml` and applied through the approval-bound
`IacEngine` (OpenTofu or Terraform). One root module composes two vendored modules
(`hetzner-vps`, `cloudflare-dns`). The server is hardened by cloud-init; the app runs under Docker
Compose behind Caddy; GitHub Actions builds, pushes to GHCR and deploys over SSH with a pinned host
key and automatic rollback. Secure and verify phases produce evidence and a runbook.

## Technical Context

**Language/Version**: TypeScript 7, Node ≥ 20.19; HCL for OpenTofu ≥ 1.6 / Terraform ≥ 1.6
(developed against OpenTofu 1.13.1 and Terraform 1.16.5).
**Providers** (verified 2026-10-11 from the registry): `hetznercloud/hcloud` 1.70.0
(`~> 1.70`), `cloudflare/cloudflare` 5.27.0 (`~> 5.27`).
**Primary Dependencies**: libsodium-wrappers (sealed boxes for GitHub secrets); Node built-ins
(`crypto` for Ed25519 keys and hashes, `dns/promises`, `tls`, `net`); system binaries `ssh`,
`ssh-keyscan`, `git` via `CommandRunner`.
**Storage**: rendered files in the user's repo; state, plans and keys as in the 000 data model.
**Testing**: Vitest; fake runner/fetch/remote; engine integration tests with real binaries on a
`terraform_data`-only module (offline); template validation tests run `init -backend=false` +
`validate` with both engines when `OPSCREW_IT=1` (provider download needs network).
**Constraints**: constitution I (gate), III (dual engine, no engine-specific syntax in files),
IV (no secrets in files, tfvars, state or logs).

## Constitution Check

| Principle | Compliance |
|---|---|
| I | Policies → approval (plan hash) → `assertApprovedPlan` → engine re-hashes → apply; destroys refused unless approved with `allowDestroy`; GitHub secrets, pushes and PRs each need approval. |
| II | All infra/runtime/workflow files rendered into the repo; modules vendored; state local. |
| III | Templates use only common HCL; OpenTofu encryption via `TF_ENCRYPTION` env; dialect checker in CI. |
| IV | Tokens only in env for the engine/adapters; tfvars contain no secrets; app secrets go straight from the user's terminal to GitHub's sealed-box API; deploy key and passphrase in `~/.opscrew/projects/<id>/` with mode 0600. |
| VII | Engine integration tests use `terraform_data` (no cloud); provider calls faked; live e2e gated by `OPSCREW_E2E_*`. |
| VIII | Cloudflare/Hetzner/GitHub mutations happen only through the engine or typed adapters behind the gate. |

## Project Structure

```text
packages/iac-engine/src/
  detect.ts      detectEngines(), selectEngine()
  engine.ts      createEngine(info, { runner }) → IacEngine (tofu | terraform)
  plan-json.ts   parsePlanJson(json) → { changes, counts, hasDestroy }
  hash.ts        hashFile(path)
  dialect.ts     checkDialect(files)
  encryption.ts  tofuEncryptionEnv(passphrase)
  index.ts
packages/iac-templates/
  modules/hetzner-vps/{versions.tf,variables.tf,main.tf,outputs.tf,cloud-init.yaml.tftpl}
  modules/cloudflare-dns/{versions.tf,variables.tf,main.tf,outputs.tf}
  scripts/gen-modules.ts           → src/generated/modules.ts (committed; drift test)
  src/types.ts                     RenderedFile, RenderContext            (lead-owned)
  src/render.ts                    renderDeployment()                      (lead-owned)
  src/infra/                       renderInfra(): root module + tfvars + vendored modules
  src/runtime/                     renderCompose(), renderCaddyfile()
  src/workflow/                    renderWorkflow()
  src/runbook/                     renderRunbook()
  src/docker/                      (feature 001)
packages/connectors/cloudflare/src/{client,connector,index}.ts
packages/connectors/github/src/{git,github,seal,token,connector,index}.ts
packages/secops/src/policies/plan.ts, src/hardening/{checks,probe}.ts
packages/agents/src/
  shared/        ssh-keys.ts (Ed25519 OpenSSH), remote.ts (SshRemoteExec), wait.ts,
                 app-env.ts (production env assembly), files.ts (write rendered files + diff)
  provision/     runProvision(), planAndApply()
  dns/           runDns()
  secure/        runSecure(), renderSecurityReport()
  verify/        checks.ts, runVerify()
packages/mcp-server/src/tools/deploy.ts
packages/cli/src/commands/{provision,dns,secure,verify,mcp}.ts
```

## Design

### IaC engine

- Detection order: explicit preference → `OPSCREW_TOFU_BIN` / `OPSCREW_TERRAFORM_BIN` → PATH
  (`findExecutable`). Version from `<bin> version -json` (`terraform_version` key for both).
  `auto` prefers OpenTofu. Minimum 1.6.0; older → `ENGINE_NOT_FOUND` with upgrade hint.
- Every command: `-no-color`, `-input=false` where accepted; env `TF_IN_AUTOMATION=1`,
  `TF_INPUT=0`, `CHECKPOINT_DISABLE=1`, plus caller env; timeout 30 min for apply, 10 min others.
- `init(dir, { backendConfig, upgrade })` → `init -input=false -no-color [-upgrade]
  -backend-config=path=<abs>`; `validate` → `validate -json -no-color` parsed into diagnostics;
  `plan(dir, planFile)` → `plan -input=false -no-color -out=<planFile> -detailed-exitcode
  [-destroy] [-var k=v]` (exit 0/2 ok, 1 error) then `show -json -no-color <planFile>`;
  `apply` → recompute SHA-256 of the plan file, compare (case-insensitive) with the approved hash
  (`PLAN_HASH_MISMATCH` otherwise), re-parse the plan and refuse destroys without `allowDestroy`
  (`DESTROY_NOT_APPROVED`), then `apply -input=false -no-color <planFile>` and `output -json`.
- Plan parsing: `resource_changes[].change.actions` → `["create"]` create, `["update"]` update,
  `["delete"]` delete, `["delete","create"]` or `["create","delete"]` replace, `["read"]`, `["no-op"]`.
- `tofuEncryptionEnv(passphrase)` returns the HCL text for `TF_ENCRYPTION`:
  `key_provider "pbkdf2" "opscrew" { passphrase = "<p>" }`, `method "aes_gcm" "opscrew" { keys =
  key_provider.pbkdf2.opscrew }`, `state { method = method.aes_gcm.opscrew }`, `plan { method =
  method.aes_gcm.opscrew }` (passphrase escaped; never logged). Integration test proves the state
  file is encrypted and a second plan works.
- Dialect checker per spec FR-203 (regex/HCL-light scanning with line numbers).

### Rendering

`RenderContext` (secret-free): `opscrewVersion`, `github: { owner, repo }`, `deploySshPublicKey`,
`acmeEmail?`, `cloudflare?: { zoneId; manageConfigRule; manageWafRules; ipRanges?: { ipv4: string[];
ipv6: string[] } }`, `serverIpv4?`, `serverIpv6?`, `trivyImage?` (pinned image reference).

Root module `opscrew/infra/prod/`:
- `versions.tf`: `required_version = ">= 1.6.0"`; `required_providers` hcloud `~> 1.70` and (only
  when DNS is Cloudflare) cloudflare `~> 5.27`; `backend "local" {}` (path supplied at init).
- `main.tf`: `provider "hcloud" {}` (token from `HCLOUD_TOKEN`), `provider "cloudflare" {}` (token
  from `CLOUDFLARE_API_TOKEN`) when needed; `module "server"` (source `../modules/hetzner-vps`);
  `module "dns"` when Cloudflare (inputs from the server outputs).
- `variables.tf` + `terraform.tfvars.json` (non-secret values only: app name, location, server type,
  image, backups, deploy public key, CIDRs, domain, zone id, proxied, www, rule toggles).
- `outputs.tf`: `server_ipv4`, `server_ipv6`, `server_id`, `server_name`, `url`.
- Header comment in every rendered file: generated by OpsCrew from `opscrew/plan.yaml`; edits are
  overwritten on the next `opscrew provision` (modules are vendored copies the user owns).

`hetzner-vps` module (resources and attributes verified against provider schema 1.70.0):
`hcloud_ssh_key.deploy` (`name`, `public_key`, `labels`); `hcloud_firewall.this` (`name`,
`labels`, `rule` blocks with `direction = "in"`, `protocol`, `port`, `source_ips`, `description`);
`hcloud_server.this` (`name`, `server_type`, `location`, `image`, `backups`, `ssh_keys =
[hcloud_ssh_key.deploy.id]`, `firewall_ids = [hcloud_firewall.this.id]`, `user_data =
templatefile(...)`, `delete_protection`, `rebuild_protection` (equal values), `labels`,
`public_net { ipv4_enabled = true, ipv6_enabled = true }`, `lifecycle { ignore_changes =
[user_data, image, ssh_keys] }`). Outputs `ipv4_address`, `ipv6_address`, `server_id`, `name`.

Cloud-init (`cloud-init.yaml.tftpl`, `#cloud-config`): user `deploy` (shell bash, `lock_passwd:
true`, `ssh_authorized_keys`), `ssh_pwauth: false`, `disable_root: true`, `package_update` +
`package_upgrade`, packages `docker.io docker-compose-v2 fail2ban unattended-upgrades ufw curl`,
`write_files`: `/etc/ssh/sshd_config.d/10-opscrew.conf` (`PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `PermitRootLogin no`, `MaxAuthTries 3`, `X11Forwarding no`,
`AllowUsers deploy`), `/etc/fail2ban/jail.d/opscrew.local` (sshd enabled, maxretry 5, bantime 1h),
`/etc/docker/daemon.json` (`log-driver json-file`, `max-size 10m`, `max-file 3`,
`no-new-privileges true`, `live-restore true`), `/etc/apt/apt.conf.d/20auto-upgrades`; `runcmd`:
`usermod -aG docker deploy`, create `/srv/app` (deploy:deploy, 750) and `/srv/data`, ufw default
deny + allow 22/tcp 80/tcp 443/tcp 443/udp + enable, `systemctl enable --now docker fail2ban
unattended-upgrades`, `systemctl restart ssh`, `touch /var/lib/opscrew-ready`. `$` characters that
are not template variables are escaped as `$${…}`.

`cloudflare-dns` module (provider 5.27.0 schema): `cloudflare_dns_record` A and AAAA (`zone_id`,
`name = var.domain`, `type`, `content`, `ttl = 1`, `proxied`, `comment = "Managed by OpsCrew"`),
optional `www` CNAME (`count`); `cloudflare_ruleset.config` (`count` on `manage_config_rule`;
`kind = "zone"`, `phase = "http_config_settings"`, rule `action = "set_config"`,
`action_parameters = { ssl = "strict" }`, `expression = "(http.host eq \"<domain>\")"`);
`cloudflare_ruleset.waf` (`count` on `manage_waf_rules`; `phase =
"http_request_firewall_custom"`, one rule `action = "block"` for the probe paths in FR-207 scoped to
the host). The implementer confirms nested attribute names with `tofu providers schema -json`.

Compose (`opscrew/runtime/compose.yaml`), Caddyfile and workflow: as FR-208/FR-209. Caddy site
address = domain (and `www.` when enabled) or `:80` when there is no domain; `reverse_proxy
app:<port>`; `encode zstd gzip`; headers `Strict-Transport-Security` (only with a domain),
`X-Content-Type-Options nosniff`, `X-Frame-Options SAMEORIGIN`, `Referrer-Policy
strict-origin-when-cross-origin`, `-Server`; global `email` when `acmeEmail` is set.
Workflow jobs `build` (`permissions: contents: read, packages: write`) and `deploy` (`needs:
build`, `environment: production`); `concurrency: { group: opscrew-deploy, cancel-in-progress:
false }`; `actions/checkout` pinned to the commit SHA of the latest v7 tag (resolve the annotated
tag with `git ls-remote https://github.com/actions/checkout 'refs/tags/v7*'` using the `^{}`
entries); everything else is plain `run:` steps (docker CLI, ssh, scp, curl). Image tag
`ghcr.io/${owner,,}/${repo,,}:${{ github.sha }}` computed in bash. Health URL
`https://<domain><healthPath>` or `http://${{ secrets.OPSCREW_HOST }}<healthPath>`; 20 attempts,
6 s apart. Rollback restores `.env.previous` and restarts, then fails the job.

### Provision orchestration (`agents/src/provision`)

`runProvision(deps, { planOnly?, approvePlanHash?, engine?, push = true })`:
1. Load `plan.yaml`, `architecture.json`; require the Dockerfile from the plan to exist on the
   current branch (else `PHASE_PRECONDITION` → "run `opscrew adapt` and merge its PR").
2. Credentials: Hetzner (`verifyCredentials`), Cloudflare when `dns.provider == "cloudflare"`
   (verify, `findZone`, entrypoint ruleset checks → `manageConfigRule`/`manageWafRules`, IP ranges
   when proxied), GitHub (`resolveGitHubToken`, repo info, default branch). Missing →
   `CREDENTIALS_MISSING` listing env vars, scopes and the create URL.
3. Engine via `selectEngine(plan.infra.engine)`; deploy key via `ensureDeployKey(paths)`; OpenTofu
   passphrase via `ensureStatePassphrase(paths)` → `TF_ENCRYPTION` when the engine is tofu and
   `plan.infra.stateEncryption`.
4. Render with `renderDeployment(plan, ctx)`; `writeRenderedFiles(root, files)` shows created/
   changed/unchanged files and asks `repo-write` approval when anything changes.
5. `planAndApply(deps, { engine, dir, env, deployPlan, approvePlanHash, planOnly })`: `init`
   (backend path `.opscrew/tfstate/prod.tfstate`) → `validate` (errors → stop) → `checkDialect`
   on the rendered `.tf` files → `plan` to `.opscrew/plans/<timestamp>.tfplan` → policies
   (`evaluatePlanPolicies`; any failed critical/high → stop with messages) → summary table (changes,
   cost from `plan.cost`, policy results) → if `planOnly`: save a sidecar
   `<plan>.tfplan.json` (hash, engine, changes, policy results, plan JSON for later policy
   re-checks), print hash and stop; with `approvePlanHash`: skip init/plan and apply the saved plan
   whose sidecar has that hash, after re-hashing the file and checking the engine → `iac-apply` approval
   (`allowDestroy` + `confirmPhrase` = server name when the plan destroys; non-interactive requires
   `approvePlanHash`) → `assertApprovedPlan` → `engine.apply` → outputs.
6. Update `plan.deployment` (IPs, url, lastPlanHash, lastApplyAt) and `plan.approvals`; write plan.
7. `waitForServer(ip)`: TCP 22 open, `ssh-keyscan -T 10 -t ed25519 <ip>` → pin into
   `~/.opscrew/projects/<id>/known_hosts` (existing different key → stop, require approval), then
   `ssh … test -f /var/lib/opscrew-ready` every 10 s up to 8 min.
8. App environment: `assembleAppEnv(deps, { plan, architecture })` → names from `plan.app.env`;
   values from the local `.env` only after the user confirms per variable (interactive) or from
   `OPSCREW_APP_ENV_FILE` (non-interactive); generated `POSTGRES_PASSWORD` (32 random chars) and
   derived `DATABASE_URL=postgres://app:<pw>@db:5432/app` when Postgres is self-hosted; `REDIS_URL=
   redis://cache:6379` when cached. Values never printed.
9. `github-secrets` approval listing secret names → `setActionsSecret` for each; audit entries name
   the secret, never the value.
10. Commit rendered files + plan on branch `opscrew/deploy-setup` → `git-push` approval → push →
    `pull-request` approval → PR "OpsCrew: deployment infrastructure for <app>" (or skip with
    `--no-push`). Print next steps (merge to deploy, then `opscrew verify`). Mark phase.

`runDns(deps, { domain? })`: update `plan.dns` (and requirements) → re-render → `planAndApply`.

### Secure and verify

- `evaluatePlanPolicies(planJson, deployPlan)` walks `planned_values.root_module` (recursively
  `child_modules`) and returns `PolicyResult[]` for: `firewall-attached` (high), `no-open-admin-ports`
  (critical; only 22/80/443 TCP, 443 UDP and ICMP may be open to 0.0.0.0/0 or ::/0),
  `ssh-keys-set` (high), `delete-protection` (medium), `origin-cloudflare-only` (medium; when proxied
  and `httpAllowedFrom == "cloudflare"`), `backups-for-critical-data` (high; when the plan says
  backups are required), `dns-proxied` (low).
- Host checks (`HostCheck { id; title; severity; command; evaluate(result) → CheckResult }`) run as
  the `deploy` user without sudo: sshd drop-in present and values set (read
  `/etc/ssh/sshd_config.d/10-opscrew.conf`), `systemctl is-active fail2ban`, `systemctl is-enabled
  unattended-upgrades`, `systemctl is-active ufw`, `ss -H -tln` (only 22/80/443 and loopback),
  no listener on 2375/2376, `test ! -f /var/run/reboot-required`, `df -P /` usage < 85 %, cloud-init
  marker present. Outside probes: TCP connect to 22 (expect open), 80/443 (open; when origin is
  Cloudflare-only expect filtered from non-Cloudflare IPs — reported as info), and 3000, 3306, 5432,
  5672, 6379, 8000, 8080, 9200, 27017 (expect closed) with 3 s timeouts; plus an SSH password-auth
  probe (`ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o BatchMode=yes`
  must fail with "Permission denied (publickey)").
- `runVerify` checks (`CheckResult[]`): DNS A/AAAA (Cloudflare ranges when proxied, server IPs
  otherwise); HTTPS GET `/` < 500; TLS certificate (hostname match, days to expiry ≥ 14, issuer);
  HTTP→HTTPS redirect; health endpoint 200; security headers; `/.env` and `/.git/config` not 200;
  direct origin TCP 443 blocked when proxied; latest `opscrew-deploy.yml` run on the deploy branch
  succeeded. All network functions injected (`resolve4/6`, `fetch`, `tlsConnect`, `tcpConnect`).
- Reports: `SECURITY_REPORT.md` (scan summary, policy results, host checks, outside probes,
  remediation list) and `RUNBOOK.md` (from `renderRunbook`): app URL, server IP, location and type,
  how deploys work, how to roll back (revert + push, or re-run an older successful workflow run),
  SSH command with the key path, logs (`docker compose logs -f app`), restart, database backup and
  restore notes (Hetzner backups; `pg_dump` one-liner), rotating app secrets (`opscrew provision`
  again), changing infrastructure, costs, and what OpsCrew changed on the server.

## Complexity Tracking

| Deviation from the approved plan | Why | Simpler alternative rejected because |
|---|---|---|
| Conftest/OPA replaced by TypeScript policies | no extra binary for vibe coders; policies are few and plan-JSON-shaped | Rego can be exported later behind `evaluatePlanPolicies` |
| SOPS + age not used | app secrets go straight to GitHub Actions secrets (encrypted by GitHub); no secret files in the repo | adding SOPS means two more binaries and key management for users |
| restic backups deferred | needs an object-storage bucket and credentials; Hetzner automated backups cover v1 | — |
| No ARM servers | GitHub-hosted runners are x86; cross-builds add QEMU complexity | — |
| Valkey instead of Redis | Redis 8 licence is no longer permissive | — |
| DNS mutations through HCL (not the adapter) | one plan, one approval, drift-detectable; adapter stays read-only | adapter writes would bypass plan review |
