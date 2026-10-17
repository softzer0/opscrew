# Implementation Plan: Several OpsCrew apps in one Cloudflare zone

**Branch**: `mvp` | **Date**: 2026-10-17 | **Spec**: `specs/011-shared-cloudflare-zone/spec.md` |
**Research**: `specs/011-shared-cloudflare-zone/research.md`

## Summary

OpsCrew's two Cloudflare rules (the probe block and strict TLS) and the account's Zero Trust
organization and one-time-PIN identity provider leave each app's Terraform state. They become
**shared resources** that a new typed part of `@opscrew/connector-cloudflare` inspects, plans for
one app, and applies behind an approval of the new kind `cloudflare-apply`, bound to that plan's
SHA-256 hash.

Each zone holds one OpsCrew rule per phase, found by its fixed `ref`. The rule lists the hostnames
of every OpsCrew app in the zone, and each app adds and removes only the hostnames it recorded in
`.opscrew/cloudflare.json`. Rules OpsCrew did not create are never read beyond the entrypoint list,
never changed and never reordered.

DNS records, tunnels and Access applications stay per app in Terraform, as today.

## Technical Context

- **Stack:** the same as 000–010. No new package and no new dependency.
- **API:** the Cloudflare API calls are the four Rulesets endpoints of R1, plus the Zero Trust
  organization and identity provider endpoints. Organization and identity provider reads already
  exist.
- **Tests:** they use core's `fakeFetch` and a fake zone that keeps rulesets the way the spike
  showed.
- **Token:** permissions as R6.

## Constitution Check

- **I (safety gate).** The shared-resources change is a typed plan with blocking findings:
  - a hostname claimed by someone else;
  - no free rule slot;
  - the expression limit;
  - OpsCrew's rule changed beyond its hostnames;
  - a missing permission.

  The plan is approved as `cloudflare-apply`, bound to its SHA-256. `--yes` never grants it, and the
  adapter refuses a plan whose hash differs. The adapter re-checks OpsCrew's rule just before
  writing (R4). Deleting OpsCrew's rule or an entrypoint OpsCrew created is part of destroy's typed
  confirmation (`allowDestroy`).

  **Amendment 1.5.0** (T1101, lead): Principle I names OpsCrew's Cloudflare shared-resources adapter
  next to the IaC engine, the host adapter and the Portainer adapter.
- **II (user owns everything).** What OpsCrew added is recorded in `.opscrew/cloudflare.json`, and
  the plan and the guide show the rules. Removing OpsCrew's hostnames by hand leaves the user's
  rules intact. The Zero Trust pieces are the user's and stay.
- **III (dual engine).** HCL only loses resources. Both engines still validate every root.
- **IV (secrets).** Plans, the record and audit entries hold hostnames, ids and counts, never a
  token.
- **V (deterministic first).** Rule expressions are fixed templates over a sorted hostname set. No
  model is involved.
- **VI (contracts first).** These change in one serial task (T1101), recorded in ADR 0014:
  - `ApprovalKind` (`"cloudflare-apply"`);
  - core's approval table;
  - the adapter contract;
  - the local record.
- **VIII (typed adapters).** Every rule and Zero Trust mutation goes through the connector.
- **IX (plain language).** Every stop names what was found and what to do. Destroy says the Zero
  Trust pieces stay.
- **X (simplicity).** There are two fixed rules, no per-app rules, no locking service and no
  migration (unreleased). Zone-wide settings are not touched.

## Project Structure

| Package | Change |
|---|---|
| `packages/contracts` | `ApprovalKind` gains `cloudflare-apply` (T1101) |
| `packages/core` | the approval table gains `cloudflare-apply`, never granted by `--yes`; `files.cloudflareRecord` (T1101) |
| `.specify/memory/constitution.md`, `docs/adr/0014-shared-cloudflare-resources.md` | amendment 1.5.0, ADR (T1101, lead) |
| `packages/connectors/cloudflare` | `shared.ts`: inspect, plan, apply, read back (T1102) |
| `packages/iac-templates` | the DNS module loses its config ruleset; `cloudflare-waf` is deleted; the Access module takes the organization and identity-provider ids as required inputs (T1103) |
| `packages/agents` | provision, `dns` and `domain connect` plan and apply the shared change; the T919 ownership logic goes (T1104); destroy, drift and init (T1105) |
| `packages/cli`, `packages/mcp-server`, `plugin`, `docs/guide` | surfaces and docs (T1106) |
| `packages/cli/test/live` | a second app in the same zone and account (T1107) |

## Design

### 1. Contracts and approvals (T1101, serial, lead-reviewed)

- `ApprovalKind` adds `"cloudflare-apply"`. Core's `HASH_BOUND` table adds it with the same
  messages as `stack-apply`, and `--yes` never grants it.
- `ProjectFiles` gains `cloudflareRecord` (`.opscrew/cloudflare.json`).
- The constitution goes to 1.5.0. ADR 0014 records R1–R5, R7 and the shared-rule decision.

### 2. The shared-resources adapter (T1102)

The contract is in [contracts/cloudflare-shared.md](contracts/cloudflare-shared.md).

- `inspectShared(client, { zoneId, accountId, access })` reads the two entrypoints (404 means none),
  the organization and the identity providers.
- `planShared(facts, desired, record)` is pure. It returns the changes, the blocking findings and
  the hash.
  - `desired` holds the app's hostnames, and whether Access and the one-time PIN are needed.
  - `record` is the app's local record.
- `applyShared(client, plan, { approvedHash })` checks the hash, re-reads each touched entrypoint,
  compares OpsCrew's rule with the plan's expectation, and writes: `PUT` only for a missing
  entrypoint, otherwise `POST`, `PATCH` or `DELETE` of one rule. It then checks the returned
  ruleset. On a failure part-way, it raises `SharedApplyError {applied}`, so the caller records
  what happened.
- The expressions are built by one function per rule from the sorted hostnames. A rule whose
  expression, apart from its hostname set, differs from the template counts as "changed by
  someone".
- The Zero Trust organization and identity provider are created when absent and never deleted.

### 3. Templates (T1103)

- **Rules leave Terraform.** `cloudflare-dns` drops `cloudflare_ruleset.config` and the `waf`
  module call. `cloudflare-tunnel` drops its `waf` call. `cloudflare-waf` is deleted.
- **Variables and outputs go.** `manage_config_rule`, `manage_waf_rules`, `ruleset_ids` and the
  roots' `cloudflare_rulesets` output are removed.
- **Access module.** `cloudflare-access` drops `cloudflare_zero_trust_organization` and its own
  one-time-PIN identity provider. `organization_auth_domain` (where it is still needed) and
  `one_time_pin_identity_provider_id` become plain inputs.
- **Checks.** Both engines validate every root, and the snapshots change only by those removals.

### 4. Flows (T1104, T1105)

- **Provision** (every target). The shared change comes first, in one fixed order: `planShared`
  for the app's hostnames (and the Zero Trust pieces when Access is used), its approval and apply,
  then `.opscrew/cloudflare.json` is written; then the IaC plan, which takes the organization and
  identity-provider ids from the shared result, its approval and apply.
  - A rule listing a hostname that has no DNS record yet is harmless.
  - `--plan-only` shows the shared plan and, when nothing shared needs creating first, the IaC plan.
  - Both hashes are printed for `--approve`.
- **`dns` and `domain connect`.** When the hostnames change, the shared plan removes the old
  hostnames and adds the new ones.
- **Destroy.** The shared removal of this app's hostnames, including deleting an OpsCrew rule left
  empty and the entrypoint when OpsCrew's rule was its only rule, is part of the deletion preview
  and the typed confirmation. It runs after the IaC destroy, the mirror of provision. Destroy says
  the Zero Trust pieces stay.
- **Drift.** Inspect, then compare with the record: a missing rule, a missing hostname, or a rule
  changed beyond its hostnames.
- **Init.** It reads both entrypoints (403 means a missing permission) and names the permission.
- **Removed.** The T919 logic (`credentials.ts` entrypoint ownership, the skip warning) goes.

### 5. Surfaces (T1106)

- The CLI prints the shared plan like the stack plan.
- The MCP `opscrew_plan` and `opscrew_apply` include it and ask through the dialog, which never
  auto-approves.
- The plugin's deploy skill mentions the extra approval.
- The guide updates the Cloudflare domain pages ([quickstart.md](quickstart.md) has the scenarios).

### 6. Live tests (T1107)

- **Own-server and Portainer runs.** Each deploys a second app, B, into the same zone and account
  (another hostname under the run's subdomain) and checks:
  - A and B are both blocked on `/.env` and served with strict TLS;
  - both are in the shared rules;
  - a user rule seeded at the start in each phase stays byte-identical.
- **Destroy.** The test destroys A and checks that B still works. It then destroys B and checks:
  - OpsCrew's rules are gone;
  - the seeded rules and the Zero Trust pieces are still there.
- **Hetzner run.** It checks the shared rules for its single app.

## Order

T1101 → {T1102, T1103} → T1104 → T1105 → T1106 → T1107 → T1108 (live runs, lead).

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| A fourth hash-bound adapter plan (`cloudflare-apply`) | Terraform cannot own one rule in a shared ruleset (R1) | Keeping Terraform leaves a second app unprotected and blocks zones with the user's own rules |
| A local record of the hostnames each app added | The shared rule mixes apps; only the record says what is this app's | Reading ownership from rule descriptions would break when a person edits them |
