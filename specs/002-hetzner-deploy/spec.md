# Feature Specification: Hetzner Deploy (Phase 1b)

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/002-hetzner-deploy`)
**Created**: 2026-10-11
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, roadmap Phase 1b: "iac-engine (tofu + terraform); Hetzner adapter
+ vps-compose module; cloud-init/Caddy; Actions → GHCR → SSH deploy; Cloudflare DNS/proxy/WAF;
SecOps MVP set; Verifier + RUNBOOK. Exit: a stranger deploys Next.js + Postgres to Hetzner with a
custom domain in under 20 minutes from the CLI or Claude Code."

## User Scenarios & Testing *(mandatory)*

The user has a `plan.yaml` from feature 001 and a merged (or open) adaptation pull request. They have
a Hetzner Cloud project token, optionally a Cloudflare token for their domain, and a GitHub token or
`gh` login.

### User Story 1 - One infrastructure engine, two binaries (Priority: P1)

Whether the user has OpenTofu or Terraform installed, OpsCrew uses it the same way: it validates the
generated HCL, creates a saved plan, shows exactly what will change, and applies only that exact plan
after approval. With OpenTofu, state and plan files are encrypted at rest.

**Why this priority**: every infrastructure change in OpsCrew flows through this engine; it carries
the plan-hash safety gate.

**Independent Test**: integration tests with real `tofu` and `terraform` binaries on a module that
uses only the built-in `terraform_data` resource (no network, no cloud).

**Acceptance Scenarios**:

1. **Given** only `tofu` on PATH, **When** OpsCrew selects an engine with preference `auto`, **Then**
   it picks OpenTofu; **Given** both, it picks OpenTofu; **Given** `--engine terraform`, it picks
   Terraform; **Given** neither, it fails with install instructions for both.
2. **Given** a saved plan with hash H, **When** apply is called with approved hash H, **Then** the
   changes are applied and outputs returned; **When** the plan file changed after approval, **Then**
   apply refuses with "plan changed since it was approved".
3. **Given** a plan that deletes or replaces a resource, **When** apply is called without
   `allowDestroy`, **Then** it refuses and nothing changes.
4. **Given** OpenTofu and a state passphrase, **When** apply finishes, **Then** the state file on
   disk is encrypted (not readable JSON resources), and later plans still work.
5. **Given** HCL using an OpenTofu-only or Terraform-only construct, **When** the dialect check runs,
   **Then** it reports the file, line and construct.

---

### User Story 2 - Provision a hardened server and a deploy pipeline (Priority: P1)

The user runs `opscrew provision`. OpsCrew checks the tokens, generates a dedicated deploy SSH key,
renders the infrastructure code (vendored modules + root module), the runtime files (Docker Compose,
Caddy) and the GitHub Actions workflow into the repository, shows the plan with resources, cost and
policy results, and after approval creates the Hetzner server (firewall, SSH key, delete
protection, optional backups) with cloud-init hardening. It waits until the server is ready,
records the host key, stores the deploy secrets in GitHub Actions, commits the generated files on a
branch and opens a pull request. Merging the pull request (or pushing to the deploy branch) builds
the container image, pushes it to GitHub Container Registry and deploys it over SSH, with an
automatic rollback when the health check fails.

**Why this priority**: this is the deploy itself.

**Independent Test**: unit tests render files for fixture plans and validate the HCL with both
engines; an orchestrator test runs the whole provision flow with fake engine, fake Hetzner, fake
GitHub and fake SSH; a live end-to-end test runs when `OPSCREW_E2E_HCLOUD_TOKEN` is set.

**Acceptance Scenarios**:

1. **Given** a plan for a Next.js + Postgres app, **When** files are rendered, **Then** the repo
   contains `opscrew/infra/prod/*.tf`, `opscrew/infra/modules/hetzner-vps/*`, `opscrew/runtime/
   compose.yaml`, `opscrew/runtime/Caddyfile` and `.github/workflows/opscrew-deploy.yml`, and the HCL
   validates with both engines.
2. **Given** the rendered plan, **When** policies run, **Then** a server without a firewall, a
   firewall opening database ports to the internet, or a server without SSH keys fails a policy and
   provisioning stops before approval is requested.
3. **Given** the user approves, **When** apply finishes, **Then** `plan.yaml` records the server
   IPs, plan hash and approval, and the approval is in `.opscrew/approvals.jsonl` and the audit log.
4. **Given** the server is up, **When** provisioning continues, **Then** OpsCrew waits for
   cloud-init to finish (up to 8 minutes), pins the server's SSH host key, and sets the GitHub
   Actions secrets `OPSCREW_HOST`, `OPSCREW_SSH_PRIVATE_KEY`, `OPSCREW_SSH_KNOWN_HOSTS`,
   `OPSCREW_APP_ENV` (and `OPSCREW_DB_ENV` when Postgres is self-hosted) after showing their names
   (never their values) and getting approval.
5. **Given** a deploy run, **When** the new container fails its health check, **Then** the workflow
   restores the previous image, the site keeps serving the previous version, and the run fails with
   a clear message.
6. **Given** a non-interactive environment, **When** `opscrew provision --plan-only` runs, **Then**
   it prints the plan hash; **When** `opscrew provision --approve <hash>` runs, **Then** it applies
   exactly that plan or refuses.

---

### User Story 3 - Domain, TLS and edge protection with Cloudflare (Priority: P2)

When the plan has a domain on Cloudflare, the same infrastructure plan creates proxied DNS records,
sets Full (strict) TLS for that hostname only, adds a small set of WAF custom rules that block common
probes, and restricts the server's web ports to Cloudflare's IP ranges. Caddy obtains a real
certificate. `opscrew dns` adds or changes the domain later through the same plan/approve/apply path.

**Why this priority**: a custom domain with HTTPS is part of the Phase 1 exit criterion, but the
server works without it.

**Independent Test**: render and validate the DNS module; fake Cloudflare API for zone lookup and
existing-ruleset detection.

**Acceptance Scenarios**:

1. **Given** domain `app.example.com` in a Cloudflare zone `example.com`, **When** provisioning
   plans, **Then** the plan contains proxied A and AAAA records for that host, a configuration rule
   setting TLS to strict for that host only, and WAF custom rules; no zone-wide setting is changed.
2. **Given** the zone already has its own custom WAF rules or configuration rules, **When**
   provisioning plans, **Then** OpsCrew does not manage those phases, warns the user, and the plan
   contains only the DNS records.
3. **Given** a token without DNS edit permission, **When** provisioning starts, **Then** it stops
   with the exact permissions the token needs and a link to create it.
4. **Given** proxied DNS, **When** the firewall is rendered, **Then** ports 80/443 accept only
   Cloudflare's published IP ranges (fetched live), while SSH stays as configured.

---

### User Story 4 - Prove it is secure and working (Priority: P2)

`opscrew secure` re-runs the scan, runs hardening checks on the server over SSH (password login
disabled, root login disabled, firewall active, fail2ban running, automatic security updates on,
Docker not exposed on TCP, only expected ports listening, no reboot pending, disk not full) and
probes from outside that database and admin ports are closed, then writes
`opscrew/SECURITY_REPORT.md`. `opscrew verify` checks DNS, HTTPS and certificate validity,
HTTP-to-HTTPS redirect, the health endpoint, security headers, that `.env`/`.git` are not served,
that the origin is not directly reachable when proxied, and the latest deploy run, then writes
`opscrew/RUNBOOK.md` with plain instructions for deploys, rollbacks, logs, SSH access, backups,
secret rotation and costs.

**Why this priority**: closes the loop and gives the user evidence and a manual.

**Independent Test**: fake `RemoteExec`, fake resolver/fetch/TLS; snapshot the reports.

**Acceptance Scenarios**:

1. **Given** a server where password authentication is enabled, **When** `opscrew secure` runs,
   **Then** the report contains a high failure "SSH password login is enabled" with the fix.
2. **Given** port 5432 reachable from the internet, **When** the outside probe runs, **Then** the
   report contains a critical failure naming the port.
3. **Given** a healthy deployment, **When** `opscrew verify` runs, **Then** every check passes and
   `RUNBOOK.md` contains the real domain, server IP, SSH command and rollback steps.
4. **Given** an expired or mismatched certificate, **When** verify runs, **Then** the TLS check fails
   with the expiry date or the names on the certificate.

### Edge Cases

- Hetzner location without stock for the chosen type: the plan fails at apply; OpsCrew explains and
  suggests re-running `opscrew design` (no automatic substitution).
- Hetzner API returns 429: retry with backoff honouring `RateLimit-Reset`.
- Apply partly fails: state keeps what was created; the next `provision` plans the remainder; nothing
  is destroyed automatically.
- Cloud-init not finished after the timeout: provisioning stops with how to check
  (`ssh deploy@<ip> cloud-init status --long`) and can be resumed.
- Host key changes after a rebuild: OpsCrew refuses to overwrite the pinned key without approval.
- No domain: Caddy serves plain HTTP on the server IP; verify warns that HTTPS needs a domain.
- The GitHub repository is private: GHCR images are private; the deploy job logs the server in to
  GHCR with the job token for the pull.
- The user's `.env` contains development values: OpsCrew asks before using any value for
  production and lets the user replace each one; generated values (database password) are never
  shown.
- Windows clients: SSH, `ssh-keyscan`, paths and permissions for key files work with Windows OpenSSH.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-201**: `@opscrew/iac-engine` MUST implement the `IacEngine` contract for `tofu` and
  `terraform`: binary detection (`OPSCREW_TOFU_BIN`, `OPSCREW_TERRAFORM_BIN`, PATH), version from
  `version -json`, `init` with partial backend config, `validate -json`, `plan -out` + `show -json`
  summary with SHA-256 plan hash, hash- and destroy-guarded `apply` of the saved plan, `output -json`;
  non-interactive flags and `TF_IN_AUTOMATION=1`; redacted errors.
- **FR-202**: The engine MUST provide `tofuEncryptionEnv(passphrase)` producing a `TF_ENCRYPTION`
  value (PBKDF2 key provider, AES-GCM method, applied to state and plan) used only with OpenTofu.
- **FR-203**: `checkDialect(files)` MUST flag OpenTofu-only constructs (`encryption` block, `.tofu`
  files, `for_each` on providers, variables in `backend` blocks or module `source`) and
  Terraform-only constructs (`cloud` block, `.tfstack.hcl`/`.tfdeploy.hcl` files).
- **FR-204**: `@opscrew/iac-templates` MUST vendor the modules `hetzner-vps` and `cloudflare-dns`
  and render, from a `DeployPlan` and a secret-free render context: the root module (`versions.tf`
  with provider constraints and an empty local backend, `main.tf`, `variables.tf`, `outputs.tf`,
  `terraform.tfvars.json`), the vendored modules, `opscrew/runtime/compose.yaml`,
  `opscrew/runtime/Caddyfile`, `.github/workflows/opscrew-deploy.yml`, and `opscrew/RUNBOOK.md`.
- **FR-205**: The `hetzner-vps` module MUST create an SSH key, a firewall (22 from
  `ssh_allowed_cidrs`; 80/443 TCP and 443 UDP from `http_allowed_cidrs`; ICMP), and a server with
  delete and rebuild protection, optional backups, IPv4+IPv6, labels, cloud-init user data and
  `ignore_changes` on user data and image; outputs IPv4, IPv6, server id and name.
- **FR-206**: Cloud-init MUST create a non-root `deploy` user (key-only, docker group), disable
  password and root SSH login, install Docker + Compose v2, fail2ban, unattended-upgrades and ufw
  (22/80/443), set Docker log rotation and `no-new-privileges`, create `/srv/app` and `/srv/data`,
  and write `/var/lib/opscrew-ready` when finished.
- **FR-207**: The `cloudflare-dns` module MUST create proxied A/AAAA records (and optional `www`
  CNAME), and — only when enabled by OpsCrew after checking that the zone has no existing entrypoint
  ruleset for the phase — a host-scoped configuration rule (TLS strict) and WAF custom rules blocking
  probes for `/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php` and `/phpmyadmin`.
- **FR-208**: The compose file MUST run `app` (image `${APP_IMAGE}`, `env_file: app.env`,
  `no-new-privileges`, all capabilities dropped, internal network only), optional `db` (Postgres 17,
  data in `/srv/data/postgres`, health check, `env_file: db.env`) and `cache` (Valkey 8), and `caddy`
  (ports 80/443/443-udp, Caddyfile read-only, data volumes); no service except Caddy publishes ports.
- **FR-209**: The workflow MUST build the image on pushes to the deploy branch and on manual
  dispatch, push it to `ghcr.io/<owner>/<repo>` tagged with the commit SHA, optionally scan it with
  Trivy (reporting only), copy runtime files over SSH using the pinned host key, write `app.env` /
  `db.env` from secrets with mode 600, pull and start with Docker Compose, run the health check with
  retries, and roll back to the previous image on failure. It MUST use only first-party GitHub
  actions pinned by commit SHA, least-privilege `permissions`, and a concurrency group.
- **FR-210**: `@opscrew/connector-hetzner` MUST provide credential verification, server types,
  locations, pricing and images (paginated, zod-validated, 429/5xx retry), a live `ComputeCatalog`
  (net prices, availability per location, deprecated types excluded), a dated static fallback catalog,
  and in-process read tools.
- **FR-211**: `@opscrew/connector-cloudflare` MUST provide token verification, zone lookup from a
  domain (trying parent names), DNS record listing, entrypoint-ruleset existence checks for the
  `http_config_settings` and `http_request_firewall_custom` phases, and Cloudflare IP ranges.
- **FR-212**: `@opscrew/connector-github` MUST provide git operations through the command runner
  (status, branch, add, commit, push, diff, remote parsing), and REST operations (repository info,
  pull requests, Actions public key and secret upload sealed with libsodium, workflow runs); tokens
  from `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`.
- **FR-213**: `opscrew provision [--plan-only] [--approve <hash>] [--engine <name>] [--no-push] [--yes]`
  MUST implement US2 and US3 end to end through the approval gate, deploy-key generation (Ed25519,
  OpenSSH format, stored under `~/.opscrew/projects/<id>/`, mode 0600), OpenTofu state encryption
  with a generated passphrase stored beside the key, policy checks before approval, readiness wait,
  host-key pinning, GitHub secrets, commit and pull request. In non-interactive runs `--yes` approves only
  the non-infrastructure steps (writing generated files, GitHub secrets, push, pull request); an
  infrastructure apply still needs `--approve <hash>`, and destroys or changed host keys always need
  a human.
- **FR-214**: `opscrew dns [--domain <fqdn>]` MUST update the plan's DNS settings and run the same
  plan/approve/apply path.
- **FR-215**: `@opscrew/secops` MUST provide `evaluatePlanPolicies(planJson, deployPlan)` (firewall
  attached, no open admin/database ports, SSH keys set, delete protection, origin restricted to
  Cloudflare when proxied, backups when data is critical) and host hardening checks run through
  `RemoteExec`, plus outside port probes.
- **FR-216**: `opscrew secure` and `opscrew verify` MUST implement US4 and write their reports.
- **FR-217**: The MCP server MUST add deploy tools: `opscrew_render`, `opscrew_plan`,
  `opscrew_apply` (requires the plan hash and a user confirmation through MCP elicitation; refuses
  when the client cannot elicit and tells the user to run `opscrew provision --approve <hash>`),
  `opscrew_secure` and `opscrew_verify`.

### Key Entities

`DeployPlan` (feature 000 data model), `PlanSummary`, `PolicyResult`, `CheckResult`, approval and
audit records, rendered files (`{ path, content, mode? }`), deploy key pair, pinned host key.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-201**: Every rendered HCL fixture validates with OpenTofu and Terraform in CI.
- **SC-202**: 100% of apply attempts with a stale or unapproved plan hash are refused in tests.
- **SC-203**: From `opscrew provision` start to a server ready for the first deploy takes under
  10 minutes on Hetzner (live end-to-end test).
- **SC-204**: The live end-to-end flow (provision → merge → deploy → verify) for the Next.js +
  Postgres fixture with a Cloudflare domain completes in under 20 minutes and every verify check
  passes.
- **SC-205**: 0 secret values in rendered files, Terraform state (OpsCrew-supplied variables),
  logs, reports or the audit log across the test suite.

## Assumptions

- Ubuntu 24.04 LTS (`ubuntu-24.04` on Hetzner) is the server image; x86 server types only.
- A single server runs the app, the optional database and Caddy (Docker Compose). Split app/database
  servers, managed databases and load balancers are later features.
- Deploys run in GitHub Actions; infrastructure changes run locally in the CLI with the user's
  approval. CI never runs Terraform/OpenTofu in v1.
- Backups in v1 are Hetzner automated server backups; restic to object storage follows later.
- The user's GitHub token can write repository contents, pull requests, Actions secrets and
  workflow files; pushing uses the user's existing git credentials.
- Valkey (BSD) is used for the optional cache instead of Redis (licence change in Redis 8).
