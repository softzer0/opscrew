# Feature Specification: DigitalOcean Droplets

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/004-digitalocean`)
**Created**: 2026-10-12
**Status**: Ready for implementation
**Input**: Approved OpsCrew plan, section 5 decision 5 (Hetzner first, then DigitalOcean, then AWS),
section 7.4 (Droplet + Docker Compose + Caddy as the DigitalOcean target), section 8 Phase 2
("Breadth"), and the constitution's provider order. `retarget` (moving a live deployment between
providers) is feature 005; DigitalOcean App Platform is out of scope.

## User Scenarios & Testing *(mandatory)*

The user has an app analysed by feature 001 and wants it on their DigitalOcean account instead of
Hetzner. Everything that works on Hetzner today (features 002 and 003) works the same way on a
DigitalOcean Droplet: one server running Docker Compose and Caddy, a cloud firewall, the deploy
key, GitHub Actions deploys over SSH, optional Cloudflare DNS, hardening, verification, drift,
destroy and the preflight.

### User Story 1 - Deploy to DigitalOcean (Priority: P1)

The interview asks where to run the app (Hetzner Cloud or DigitalOcean). The design phase then
offers Droplet sizes in the region closest to the users, with live prices in USD from the
DigitalOcean API, and the user picks one. `opscrew adapt`, `opscrew provision`, `opscrew dns`,
`opscrew secure` and `opscrew verify` work exactly as on Hetzner: the infrastructure code in
`opscrew/infra/prod/` creates a Droplet, an SSH key and a firewall through the same
plan → approval → apply path.

**Why this priority**: DigitalOcean is the next provider in the constitution's order; many of the
target users already have a DigitalOcean account. (DigitalOcean also has data centres Hetzner lacks,
such as London, Toronto, Bangalore and Sydney; offering them needs new interview regions and is
left for a later feature.)

**Independent Test**: unit tests with fake DigitalOcean API responses, the rendered HCL validated
by both engines, the end-to-end suite running one example through design → provision with a
DigitalOcean plan and fakes, and the gated live test deploying to a real Droplet.

**Acceptance Scenarios**:

1. **Given** `DIGITALOCEAN_TOKEN` is set and `HCLOUD_TOKEN` is not, **When** the user runs
   `opscrew interview`, **Then** the question "Where should OpsCrew run your app?" offers Hetzner
   Cloud and DigitalOcean with DigitalOcean pre-selected, and the answer is saved as
   `provider: digitalocean` in `opscrew/requirements.yaml`.
2. **Given** `provider: digitalocean` and region `eu-central`, **When** the user runs
   `opscrew design`, **Then** the options are Droplet sizes in Frankfurt or Amsterdam with monthly
   prices in USD read from the API (labelled "live"), daily backups priced at 30 % of the Droplet
   price when chosen, and a budget comparison that converts EUR budgets at the documented fixed
   rate and says so.
3. **Given** the chosen option, **When** the user runs `opscrew provision`, **Then** the plan
   shows a `digitalocean_droplet`, a `digitalocean_ssh_key` and a `digitalocean_firewall`, the
   apply happens only after an approval bound to the plan hash, and the deployment ends with the
   Droplet's IPv4 and IPv6 addresses in `plan.yaml`, the host key pinned and the GitHub deploy
   secrets set, as on Hetzner.
4. **Given** the DigitalOcean token is missing or rejected, **When** the user runs
   `opscrew provision`, **Then** OpsCrew stops before planning and names the variable, the
   scopes and the token page; a token that lacks a scope needed only later fails at apply with a
   hint naming the token page and the scopes (the API cannot list a token's scopes up front).
5. **Given** an existing Hetzner project, **When** the user upgrades OpsCrew and runs any command,
   **Then** nothing changes for them: `requirements.yaml` without `provider` means Hetzner, and the
   rendered Hetzner infrastructure files are byte-for-byte the same (only the init checklist's
   token check is now identified as `provider` instead of `hetzner` in `--json` and MCP output).

---

### User Story 2 - Day-2 operations on DigitalOcean (Priority: P1)

`opscrew drift`, `opscrew destroy` and `opscrew init` work for a DigitalOcean deployment.
DigitalOcean has no delete protection for Droplets, so the teardown has no protection-lifting
step and the preview says plainly that the safety comes from OpsCrew's own confirmation.

**Why this priority**: a provider is only supported when the user can also check and remove what
OpsCrew created there (constitution I and II).

**Independent Test**: destroy and drift orchestrator tests with a fake engine and a fake
DigitalOcean snapshot API; init tests with fake fetch.

**Acceptance Scenarios**:

1. **Given** a DigitalOcean deployment with self-hosted Postgres, **When** the user runs
   `opscrew destroy`, **Then** the preview lists the Droplet, firewall, SSH key, the app's tag and the DNS records,
   says the database is deleted with the Droplet, says DigitalOcean has no delete protection, and
   announces a snapshot; after the typed name it takes the snapshot through a Droplet snapshot
   action, applies the approved destroy plan (no protection step), removes the GitHub deploy
   secrets and the pinned host key, and reports what remains (the snapshot, any automatic backups
   DigitalOcean keeps, the GHCR images, the repository files).
2. **Given** the user opened port 3306 in the DigitalOcean firewall in the console, **When** the
   user runs `opscrew drift`, **Then** the report names `digitalocean_firewall` and the changed
   attribute and exits 1.
3. **Given** a plan with `provider: digitalocean`, **When** the user runs `opscrew init`, **Then**
   the checklist verifies the DigitalOcean token (account active, email verified) and lists the
   token scopes OpsCrew needs; the Hetzner token check is skipped.
4. **Given** no plan or requirements yet, **When** the user runs `opscrew init`, **Then** the
   checklist passes the provider check when either token is set and explains that only one is
   needed.

---

### User Story 3 - Honest provider choice (Priority: P2)

The user sees what each provider costs in its own currency, where prices come from (live or a
dated table), and why an option was recommended. Referral programmes never influence the choice
(constitution II).

**Acceptance Scenarios**:

1. **Given** no DigitalOcean token, **When** the user runs `opscrew design` with
   `provider: digitalocean`, **Then** the options come from the dated static price table, are
   labelled with its date, and the output says how to get live prices.
2. **Given** a deployed Hetzner plan, **When** the user changes the interview answer to
   DigitalOcean and runs `opscrew design`, **Then** design stops without changing `plan.yaml` and
   explains that moving a live deployment is not supported yet (destroy first, or wait for
   `opscrew retarget`).

---

### User Story 4 - The same from Claude Code (Priority: P3)

The MCP tools (`opscrew_interview`, `opscrew_design`, the deploy tools, `opscrew_drift`,
`opscrew_init_check`) work with DigitalOcean plans and never print the token; the deploy skill
mentions both providers.

**Acceptance Scenarios**:

1. **Given** a DigitalOcean plan, **When** the client calls `opscrew_init_check`, **Then** the
   result checks `DIGITALOCEAN_TOKEN` and no token value appears in the output.

### Edge Cases

- The chosen size is not available in the region at provision time: the error names the size and
  region and tells the user to run `opscrew design` again (design only offers sizes the API
  reports as available in that region).
- The account reached its Droplet limit: provision says so and links to the account page. The
  account is locked or its email unverified: init and provision say so and link to the account
  page (not to the token page).
- The API answers 429: the client waits until `ratelimit-reset` (bounded) and retries once, then
  stops with a plain message.
- Region `eu-north` has no DigitalOcean data centre: design uses Amsterdam and says why.
- Both tokens are set: only the planned provider's token is used and checked.
- A Droplet deleted in the DigitalOcean console: drift reports it as deleted outside OpsCrew;
  destroy skips the snapshot with a note and removes what is left.
- Snapshot creation fails, errors or times out: stop before deleting anything (as on Hetzner).
- An older OpsCrew Hetzner deployment without the `delete_protection` variable keeps the 003
  behaviour; DigitalOcean deployments never have that variable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-401**: The plan schema MUST accept `target.provider` `hetzner` or `digitalocean` (design
  options likewise) and requirements MUST accept an optional `provider` with the same values
  (absent means `hetzner`); every existing artefact stays valid.
- **FR-402**: A new `@opscrew/connector-digitalocean` MUST provide: credentials
  (`DIGITALOCEAN_TOKEN`, then `DIGITALOCEAN_ACCESS_TOKEN`; least-privilege custom scopes; token
  page link), credential verification through the account endpoint (active account, verified
  email), a live catalogue of regions and Droplet sizes with prices and availability, a dated
  static fallback catalogue, server lookup by OpsCrew's tags, a Droplet snapshot that waits for
  its action and returns the snapshot id, read-only agent tools, rate-limit handling, the token
  registered with the redactor and every response validated with zod.
- **FR-403**: The interview MUST ask for the provider (default: the previous answer, else the
  provider whose token is set when exactly one is, else Hetzner) and always record it.
- **FR-404**: Design MUST build options from the planned provider's catalogue with that
  provider's region mapping, backup percentage, IPv4 cost and currency, provider-prefixed option
  ids and the provider-specific default image, and MUST refuse to change the provider of a plan
  whose deployment is live (an address recorded or an apply made, and not destroyed since).
- **FR-405**: The infrastructure templates MUST add a `digitalocean-droplet` module (Droplet, SSH
  key, firewall with explicit outbound rules, OpsCrew tags) with the same root outputs as the
  Hetzner module, render the root module for the planned provider, keep Hetzner output
  unchanged, share one cloud-init template between both modules, validate under both engines, and
  make the runbook provider-aware.
- **FR-406**: Provision, drift, secure, verify and init MUST use the planned provider's
  credential check, console links and error hints (size unavailable, Droplet limit, missing
  scope); init MUST check only the planned provider's token, or accept either before a provider
  is chosen.
- **FR-407**: Destroy MUST work for DigitalOcean: no protection-lifting step (the preview says the
  provider has no delete protection), a Droplet snapshot through the provider-neutral snapshot
  contract with the same reuse record, and a final report that mentions DigitalOcean's retained
  backups; the Hetzner flow stays as it is.
- **FR-408**: Security checks MUST cover DigitalOcean: plan policies for `digitalocean_droplet`
  and `digitalocean_firewall` (firewall attached, SSH key set, SSH not open to the world unless
  chosen, backups as planned), a secret-scan rule and a redactor pattern for DigitalOcean personal
  access tokens.
- **FR-409**: CLI, MCP, plugin skill, README and runbook text MUST name the planned provider (or
  both) instead of assuming Hetzner.
- **FR-410**: A gated live test MUST deploy an example to DigitalOcean when
  `OPSCREW_E2E_DIGITALOCEAN_TOKEN` (and the existing GitHub e2e variables) are set, tear it down
  with `opscrew destroy --confirm <name> --no-snapshot`, and fall back to an engine destroy and
  then API cleanup (Droplets by the app tag, the firewall and SSH key by name, the app tag
  itself; never the shared `managed-by:opscrew` tag); `docs/e2e.md` explains setup and cost.
- **FR-411**: A provider-neutral contract MUST describe server lookup and snapshots (used by
  destroy) and the VPS connector shape (credentials, catalogue, servers); the Hetzner connector
  MUST implement it without changing its behaviour.

### Key Entities

- **Provider**: `hetzner` or `digitalocean`; chosen in the interview, recorded in requirements and
  in `plan.target.provider`.
- **Provider profile** (code, not a file): display name, token variables, console and token links,
  server and firewall resource types, whether delete protection exists, default image, region
  mapping, backup percentage.
- **Server snapshot**: provider-neutral `{ serverId, snapshotId }` (ids as strings).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-401**: With only `DIGITALOCEAN_TOKEN` (no Hetzner token), the live test deploys an example
  to a Droplet and tears it down with nothing labelled for the app left behind.
- **SC-402**: All feature 002 and 003 tests pass unchanged in meaning; rendered Hetzner
  infrastructure files are byte-identical to before (snapshot tests).
- **SC-403**: The rendered DigitalOcean root module and module pass `validate` under both
  OpenTofu and Terraform.
- **SC-404**: No DigitalOcean token value appears in terminal output, audit entries, reports or
  generated files in any test (seeded fake token, grep assertions).

## Assumptions

- DNS stays on Cloudflare (or none); DigitalOcean DNS is not used in this feature.
- Resources go to the account's default project; no reserved IP, volumes or VPC customisation.
- Backups, when chosen, are daily (30 % of the Droplet price); Hetzner backups stay daily at 20 %.
- Droplet sizes offered: Basic shared-CPU sizes and CPU-Optimized dedicated sizes, x86 only.
- `retarget` (feature 005) moves a live deployment between providers; until then the provider of
  a live deployment is fixed.
- DigitalOcean's referral programme is never used to rank options; no referral links are added.
