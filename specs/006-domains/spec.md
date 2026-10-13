# Feature Specification: Buying domains through Cloudflare

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/006-domains`)
**Created**: 2026-10-13
**Status**: Implemented (T601–T609)
**Input**: Founder direction 2026-10-13: OpsCrew buys and fully sets up domains through Cloudflare
first; Namecheap (in the plan from the start), Porkbun and GoDaddy follow for buying and managing
domains (feature 007). Plan section 3.1 (`opscrew dns`), 4.5 gap 3 (registrar/DNS/TLS as
first-class connectors). Research: `specs/006-domains/research.md` (Cloudflare Registrar API
beta, 2026-04-15).

## User Scenarios & Testing *(mandatory)*

Today OpsCrew can point a domain the user already owns at the server (Cloudflare DNS, TLS through
Caddy). Users without a domain must buy one elsewhere first. This feature lets them find and buy
one through their own Cloudflare account and leaves it fully set up for the deployment.

### User Story 1 - Find and buy a domain (Priority: P1)

**Why this priority**: "I have an app but no domain" is the first wall for the target audience;
Cloudflare sells domains at cost and already hosts OpsCrew's DNS.

**Independent Test**: connector tests with fake responses shaped like the API reference; agent
tests with a fake registrar; the gated sandbox test buys a .com in Cloudflare's registrar
sandbox.

**Acceptance Scenarios**:

1. **Given** a Cloudflare token with Registrar access, **When** the user runs
   `opscrew domain search shopapp`, **Then** OpsCrew lists suggestions with availability, first
   year and renewal prices, checked live, and marks premium or API-unsupported names as "buy in
   the Cloudflare dashboard".
2. **When** the user runs `opscrew domain buy shopapp.com`, **Then** OpsCrew checks the domain
   again, shows the price for the chosen years, the renewal price, that auto-renew, WHOIS privacy
   and DNSSEC will be on, that the account's default registrant contact is used, and that the
   purchase cannot be refunded; nothing is bought until the user types the domain name.
3. **Then** the purchase is made, OpsCrew waits until Cloudflare reports it succeeded, makes sure
   the zone exists on the account, turns on DNSSEC, and records the domain in the requirements
   and the plan (`dnsProvider: cloudflare`), so `opscrew dns` (or the next provision) points it
   at the server.
4. **Given** the run was interrupted after the purchase request, **When** the user runs the same
   command again, **Then** OpsCrew finds the registration (pending or done) and continues; it
   never sends a second purchase for the same domain.

---

### User Story 2 - Scripts and safety (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a non-interactive run, **When** `opscrew domain buy shopapp.com` runs without
   `--confirm shopapp.com` and `--max-price <amount>`, **Then** it refuses with the exact command;
   with both, it buys only if the checked first-year total is at most the maximum.
2. **Given** `--yes`, **Then** it never approves a purchase.
3. **Given** the domain is premium, unavailable, needs extra registrant data (for example .us,
   .uk, .ca) or its extension is not sold through the API, **Then** OpsCrew stops before buying
   and says what to do (another name, or the Cloudflare dashboard).

---

### User Story 3 - Manage the domain afterwards (Priority: P2)

**Acceptance Scenarios**:

1. **When** the user runs `opscrew domain status`, **Then** OpsCrew shows the registrar, expiry
   date, auto-renew, lock, privacy and DNSSEC state of the plan's domain.
2. **When** the user runs `opscrew domain auto-renew off` (or `on`), **Then** OpsCrew changes it
   after an approval and shows the next renewal date and price.
3. **Given** `opscrew init`, **Then** the Cloudflare check says whether the token can buy domains
   (Registrar access) and what to add if not; the check stays optional.

---

### User Story 4 - From Claude Code (Priority: P3)

**Acceptance Scenarios**:

1. **Given** the MCP server, **Then** `opscrew_domain_check` (read-only) reports availability and
   prices; no MCP tool buys a domain; the deploy skill tells the user to run
   `npx opscrew domain buy` in a terminal.

### Edge Cases

- No default registrant contact on the account, no payment method, unverified email or the
  500-domain limit: stop with the Cloudflare dashboard link; nothing bought.
- The token has DNS access but no Registrar access: search and buy explain which permission to add.
- The token can see several accounts: ask which one (interactive) or require `--account <id>`.
- The registration ends in `action_required`, `blocked` or `failed`: stop, say what Cloudflare
  reported and that nothing was charged unless the state says otherwise; the next run re-checks.
  After `failed` OpsCrew never sends the purchase again; the user buys in the dashboard, then
  `opscrew domain buy` sets the domain up.
- A purchase note without an outcome (a crash before or during the request) is cleared once
  Cloudflare still shows nothing 30 minutes later; `--forget-pending-purchase` (typed domain)
  clears an uncertain note and ends the run.
- The purchase request got an unclear answer (timeout, 5xx, unreadable reply): the purchase record
  is kept as uncertain and never cleared automatically; OpsCrew says "Cloudflare shows no
  purchase yet" (never "nothing was bought") until the status says otherwise or the user clears
  it with `--forget-pending-purchase` after checking the dashboard.
- The domain is already on the account: zone, DNSSEC and plan changes are listed and approved
  (`domain-settings`) before anything changes.
- The price changed between the check and the purchase: check again right before buying and stop
  if it is above the shown (or maximum) price.
- The zone already exists (for example created by an earlier run): reuse it.
- The plan already has another domain: buying records the new one only after a confirmation;
  the old DNS records stay until `opscrew dns`/provision updates them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-601**: `opscrew domain search <name>`, `opscrew domain buy <domain> [--years <n>]
  [--no-auto-renew] [--account <id or name>] [--confirm <domain>] [--max-price <amount>[<currency>]]
  [--forget-pending-purchase]` (clears an uncertain purchase record after the user checked the
  dashboard; typed domain),
  `opscrew domain status` and `opscrew domain auto-renew on|off` MUST implement US1–US3.
- **FR-602**: `@opscrew/connector-cloudflare` MUST add a typed Registrar client: domain check,
  domain search, extension lookup, registration create, registration status and get, auto-renew
  update, zone create/get for an account, DNSSEC enable, account listing; responses validated
  with zod; tokens never in errors.
- **FR-603**: A registrar contract MUST describe checking, buying and managing a domain so
  Namecheap, Porkbun and GoDaddy can implement it in feature 007.
- **FR-604**: A purchase MUST use a dedicated approval kind that `--yes` never grants, show the
  price, renewal price, years, auto-renew, privacy and the non-refundable note, require the typed
  domain name, and in non-interactive runs require `--confirm` and `--max-price`; it MUST be
  audited (domain, price, result; no contact data).
- **FR-605**: Buying MUST be idempotent per domain: check the registration status before any
  create, keep a local purchase record, and resume a pending registration.
- **FR-606**: After a purchase OpsCrew MUST ensure the zone, enable DNSSEC, apply the auto-renew
  choice and record the domain in requirements and, when a plan exists, the plan
  (`dns.provider: cloudflare`, `dns.registration`: registrar, registered and expiry dates,
  auto-renew); a plan created later gets `dns.registration` filled in by `opscrew domain status`
  or the next setup run. Because the new zone did not exist when the token was made, the token
  needs its zone permissions for all zones of the account (or the new zone added); OpsCrew says
  so after the purchase. `--yes` approves only project-file updates, never a purchase or a domain
  setting.
- **FR-607**: `opscrew init` MUST report whether the Cloudflare token can buy domains (optional
  check); the credentials template MUST list the extra permissions.
- **FR-608**: The MCP server MUST offer `opscrew_domain_check` (read-only) and no purchase tool;
  the skill and README MUST describe buying domains.
- **FR-609**: A gated test MUST buy a .com in Cloudflare's registrar sandbox when
  `OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN` and `OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID` are set.

### Key Entities

- **Domain check**: name, registrable, tier, first-year and renewal price, reason.
- **Registration** (`plan.dns.registration`): registrar (`cloudflare`), registered and expiry
  dates, auto-renew, privacy, DNSSEC.

## Success Criteria *(mandatory)*

- **SC-601**: No test path buys without the typed domain name, and `--yes` alone never buys.
- **SC-602**: Re-running an interrupted purchase never sends a second create request (tests at
  every point of the flow).
- **SC-603**: After a sandbox purchase the domain shows as registered with auto-renew and the
  plan records it.
- **SC-604**: Existing DNS and provision behaviour is unchanged for owned domains.

## Assumptions

- The user's own Cloudflare account pays; OpsCrew never handles payment details or registrant
  contact data (the account's default contact is used).
- Domains needing contact extensions are bought in the dashboard for now.
- Transfers between registrars and other registrars are feature 007.
