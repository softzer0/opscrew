# Implementation Plan: Buying domains through Cloudflare

**Branch**: `mvp` | **Date**: 2026-10-13 | **Spec**: `specs/006-domains/spec.md` |
**Research**: `specs/006-domains/research.md`

## Summary

A typed Cloudflare Registrar client, a provider-neutral registrar contract, and `opscrew domain
search | buy | status | auto-renew`. A purchase is a new approval kind (`domain-purchase`) with
the typed domain name, never granted by `--yes`, bounded by `--max-price` in scripts, idempotent
per domain, and followed by zone, DNSSEC and auto-renew setup and recording the domain in
requirements and the plan. Namecheap, Porkbun and GoDaddy implement the same contract in 007.

## Technical Context

Same stack. No new dependencies. Cloudflare API v4 (`api.cloudflare.com/client/v4`), Registrar
endpoints under `/accounts/{account_id}/registrar/…` (sandbox `/registrar-sandbox/…`).

## Constitution Check

- I: buying is a provider mutation that costs money: preview (price, renewal, years, options,
  non-refundable) → approval kind `domain-purchase` with `confirmPhrase` = the domain → purchase;
  non-interactive runs name the domain (`--confirm`) and a price bound (`--max-price`); `--yes`
  never applies; audited. Auto-renew changes are approvals too.
- II: the domain lives in the user's own Cloudflare account; OpsCrew records it in
  `opscrew/plan.yaml`.
- IV: the token is registered with the redactor; no contact data is read, stored or logged
  (Cloudflare uses the account's default contact).
- VIII: the Registrar client is a typed adapter (no MCP-driven purchases).
- Amendment: the constitution's provider order gains Cloudflare Registrar, Porkbun and GoDaddy
  next to Namecheap (MINOR, 1.1.0).

## Project Structure

```text
.specify/memory/constitution.md                       # T601: provider order amendment (1.1.0)
packages/contracts/src/{safety,registrar}.ts          # T601: ApprovalKind domain-purchase, Registrar contract
packages/plan-schema/src/plan.ts (+ JSON Schemas)     # T601: dns.registration
packages/agents/src/domain/index.ts, src/index.ts     # T601: stubs
packages/cli/src/approval.ts                          # T601: confirmPhrase handling covers the new kind (no --yes)
docs/adr/0008-registrar-seam.md                       # T601
packages/connectors/cloudflare/src/**                 # T602
packages/agents/src/domain/**                         # T603
packages/agents/src/init/**                           # T604
packages/cli/src/commands/domain.ts (+ registration)  # T605
packages/mcp-server/src/**, plugin/**, README.md      # T606
packages/connectors/cloudflare/test/live/** or cli live, docs/e2e.md  # T607 (lead)
```

## Design

### Contracts (T601, lead)

```ts
// contracts/src/registrar.ts
export type RegistrarId = "cloudflare" | "namecheap" | "porkbun" | "godaddy";
export interface DomainCheck {
  domain: string;
  registrable: boolean;
  tier?: "standard" | "premium";
  firstYear?: Money;      // registration price for one year
  renewal?: Money;        // yearly renewal price
  /** Why it cannot be bought here, plain English (premium, unavailable, needs the dashboard …). */
  reason?: string;
}
export interface RegistrationRequest { domain: string; years: number; autoRenew: boolean; privacy: boolean }
export type RegistrationState = "pending" | "in_progress" | "action_required" | "blocked" | "succeeded" | "failed";
export interface RegistrationStatus { domain: string; state: RegistrationState; message?: string }
export interface RegisteredDomain {
  domain: string; registrar: RegistrarId; createdAt?: IsoDateTime; expiresAt?: IsoDateTime;
  autoRenew: boolean; locked?: boolean; privacy?: boolean;
}
export interface Registrar {
  readonly id: RegistrarId;
  check(domains: string[]): Promise<DomainCheck[]>;
  suggest(query: string): Promise<DomainCheck[]>;
  /** Undefined when the account has no registration (or request) for the domain. */
  registrationStatus(domain: string): Promise<RegistrationStatus | undefined>;
  /** Starts the purchase; resolves with the first status. Never call twice for one domain. */
  register(request: RegistrationRequest): Promise<RegistrationStatus>;
  getDomain(domain: string): Promise<RegisteredDomain | undefined>;
  setAutoRenew(domain: string, on: boolean): Promise<RegisteredDomain>;
}
```

`ApprovalKind` gains `domain-purchase` (and `domain-settings` for auto-renew changes; both
outside `ASSUME_YES_KINDS`). `plan.dns.registration` (optional): `{ registrar, registeredAt?,
expiresAt?, autoRenew, privacy, dnssec }`. Stubs: `agents/src/domain/index.ts` (`searchDomains`,
`buyDomain`, `domainStatus`, `setDomainAutoRenew` with their option/result types). ADR 0008:
registrar seam, Cloudflare first, purchase safety rules.

### Cloudflare Registrar client (T602)

In `@opscrew/connector-cloudflare`: `listAccounts()`; `domainCheck(accountId, domains)`;
`domainSearch(accountId, query)`; `getExtension(accountId, tld)`; `createRegistration(accountId,
request)` (`Prefer: respond-async`; returns the workflow status); `registrationStatus(accountId,
domain)` (404 → undefined); `getRegistration`; `setAutoRenew`; `findZone`/`createZone(accountId,
name)` (409/"already exists" → get); `enableDnssec(zoneId)`; client option `registrarSandbox: true` (turned on by
`OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1`, tests only; zone and DNSSEC setup skipped) switches
`registrar` to `registrar-sandbox`. A `CloudflareRegistrar` class implements `Registrar` for one
account (prices parsed from strings to `Money`; `reason` codes mapped to plain English).
`cloudflareConnector` credentials gain the Registrar and zone-create permissions (exact names
confirmed live; one constant, `CLOUDFLARE_REGISTRAR_PERMISSIONS`, used everywhere); the zone
permissions must cover all zones of the account so a newly bought domain's zone is included.

### Orchestration (T603, `agents/src/domain/`)

- `searchDomains(deps, { query, account? })`: suggestions + live check of the top results.
- `buyDomain(deps, { domain, years = 1, autoRenew = true, account?, maxPrice?, services })`:
  1. Preconditions: Cloudflare token, account resolved (one account, or `account`), domain
     syntax and TLD supported; an existing registration of the domain on the account → resume.
  2. Purchase record `<projectHome>/domain-purchase.json` `{ domain, accountId, requestedAt,
     years, autoRenew, total, outcome? }` (created exclusively): when present, never create
     again; poll the status instead. An ambiguous create marks it `uncertain` (never cleared
     automatically; only `--forget-pending-purchase` with the typed domain clears it, and that run
     ends); a record without an outcome is cleared only after 30 minutes of wall-clock time when
     both registration reads say none. A clear rejection (enveloped 4xx) clears it after the
     status re-check confirms none.
  3. `check` right before buying: registrable, standard tier, no contact extensions
     (`getExtension`), price ≤ shown (and ≤ `maxPrice`, same currency); for more than one year the
     bound is years × max(first year, renewal) until the sandbox confirms the billing.
  4. Approval `domain-purchase` (`confirmPhrase` = domain; details: years, first-year total,
     renewal, auto-renew, privacy, DNSSEC, default contact, non-refundable).
  5. Write the purchase record, `register`, poll `registrationStatus` (backoff, ~10 min) until
     `succeeded`; `action_required`/`blocked`/`failed` → stop with Cloudflare's message.
  6. Ensure the zone, enable DNSSEC, apply auto-renew, read expiry; write `requirements`
     (`domain`, `dnsProvider: cloudflare`) and, when a plan exists, `plan.dns` (`provider`,
     `domain`, `zone`, `registration`, `proxied: true`, `security.httpAllowedFrom: cloudflare`)
     after a `repo-write` approval if the plan had another domain. A domain already on the account
     is set up only after a `domain-settings` approval (typed domain) listing every change.
  7. Remove the purchase record; audit `{ domain, price, years, result }`; next steps
     (`opscrew dns` or `opscrew provision`).
- `domainStatus(deps)`, `setDomainAutoRenew(deps, on)` (approval `domain-settings`).

### Init (T604)

The Cloudflare check reports whether the token can use the Registrar (a cheap read such as
`domain-check` on a reserved name or listing registrations) and names the missing permission;
it stays a warning.

### CLI (T605)

`opscrew domain search|buy|status|auto-renew` with the flags of FR-601; a typed confirmation
handler for `domain-purchase` (interactive prompt shows the details, then "Type <domain> to buy
it"); non-interactive requires `--confirm` and `--max-price` (else exit 1 with the command);
`--yes` does not approve purchases.

### MCP and plugin (T606)

`opscrew_domain_check` (read-only, redacted); skill: buying is terminal-only; README.

### Sandbox test (T607, lead)

Gated on `OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN` + `OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID`: check,
buy (sandbox) a random .com with `--confirm` and `--max-price`, status, auto-renew off; confirms
the "confirm live" items of research.md.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Local purchase record in addition to the status check | The API has no idempotency key; a crash between request and response must not lead to a second purchase | Status check alone races with a pending create |
