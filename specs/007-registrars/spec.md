# Feature Specification: Namecheap, Porkbun and GoDaddy

**Feature Branch**: `mvp` (Spec Kit feature dir `specs/007-registrars`)
**Created**: 2026-10-13
**Status**: Ready for implementation
**Input**: Founder direction 2026-10-13 (domains through Cloudflare first, then Namecheap, Porkbun
and GoDaddy for buying and managing domains); feature 006 (Registrar contract, typed and
price-bounded purchases, Cloudflare Registrar); research `specs/007-registrars/research.md`.

## User Scenarios & Testing *(mandatory)*

Feature 006 lets users buy a domain through Cloudflare. Many users already have an account (and
domains) at Namecheap, Porkbun or GoDaddy, or find a better price there. DNS and TLS stay on
Cloudflare in every case: a domain registered elsewhere gets a Cloudflare zone and its
nameservers point at it.

### User Story 1 - Buy at another registrar (Priority: P1)

**Acceptance Scenarios**:

1. **Given** Porkbun API keys with the `purchase` scope, **When** the user runs
   `opscrew domain buy shopapp.dev --registrar porkbun`, **Then** OpsCrew checks the domain live,
   shows the price, renewal price, the registrar's term (Porkbun registers the registry minimum,
   usually one year), WHOIS privacy, the non-refundable note and the nameserver switch to
   Cloudflare, asks for the typed domain, buys it once (idempotency key), creates the Cloudflare
   zone, points the domain's nameservers at it and records the registrar in the plan.
2. **Given** a Namecheap account with API access, **When** the user buys with
   `--registrar namecheap`, **Then** OpsCrew checks the account balance first, uses the account's
   default address-book contact for the registration (shown masked, never stored or logged), and
   then points the domain at its new Cloudflare zone (Cloudflare creates a zone only for a
   registered domain, so the nameservers are set right after the purchase).
3. **Given** a GoDaddy account with API access and contact details (a saved contact profile, or the
   account's own details), **When** the user buys
   with `--registrar godaddy`, **Then** OpsCrew gets a quote, shows its locked price and required
   agreements, registers with the quote and the user's consent, waits for completion and switches
   the nameservers.
4. **Given** any interruption, **When** the user runs the same command again, **Then** OpsCrew
   never buys twice (the 006 purchase record rules apply per registrar).

---

### User Story 2 - Connect a domain you already own (Priority: P1)

**Why this priority**: most users already own their domain somewhere; switching nameservers by
hand is where email breaks.

**Acceptance Scenarios**:

1. **Given** a domain at Porkbun, Namecheap or GoDaddy that uses the registrar's DNS, **When** the
   user runs `opscrew domain connect example.com`, **Then** OpsCrew finds which configured
   registrar holds it, reads its current DNS records (A, AAAA, CNAME, MX, TXT, SRV, CAA), shows
   exactly which records it will copy into a new Cloudflare zone, and after the typed domain
   creates the zone, copies the records and switches the nameservers.
2. **Given** a domain whose DNS is hosted elsewhere (custom nameservers), **Then** OpsCrew says it
   cannot read those records through the registrar, offers Cloudflare's record scan (shown for
   review) or a BIND file (`--records-file`), and switches only after the user approved the list.
3. **Given** DNSSEC is active at the registrar for the old DNS provider, **Then** OpsCrew stops
   before any change and explains that the old DS records must be removed first (it removes them
   itself where the registrar API allows, after approval), because switching nameservers with old
   DS records takes the domain offline.
4. **Given** the switch is done, **Then** the plan records the domain, its zone and the registrar,
   OpsCrew triggers Cloudflare's activation check and says how long propagation can take.

---

### User Story 3 - Compare and manage (Priority: P2)

**Acceptance Scenarios**:

1. **When** the user runs `opscrew domain search shopapp --compare`, **Then** OpsCrew checks the
   name at every registrar with credentials and lists first-year and renewal prices side by side,
   cheapest renewal first, with no referral influence.
2. **When** the user runs `opscrew domain status` or `domain auto-renew on|off` for a domain at
   Porkbun (auto-renew via API), Namecheap or GoDaddy (dashboard only), **Then** OpsCrew shows the
   registrar's data or says plainly where to change it.
3. **When** the user runs `opscrew init`, **Then** each configured registrar is checked: Porkbun
   key scopes, Namecheap API access and the IPv4 address to whitelist, GoDaddy API access.

---

### User Story 4 - From Claude Code (Priority: P3)

1. **Then** `opscrew_domain_check` accepts a registrar (or `compare`); buying and connecting stay
   terminal-only; the skill describes the registrars.

### Edge Cases

- Namecheap API access not enabled or the account not eligible (20 domains, $50 balance or $50
  spent): stop with the rule and the settings page. Not whitelisted: show the IPv4 to whitelist.
- Namecheap balance below the price: stop before the approval with the balance and the price.
- Porkbun key without `purchase` (or `domains` for connect), domain without API access,
  monthly spend cap or insufficient credit: stop with Porkbun's `next_action` hint.
- GoDaddy account not allowed to use the API for purchases, or GoDaddy says contacts are missing: stop with
  the plain cause; connecting may still work (it only needs domain and DNS access).
- TLDs needing registrant extensions (Namecheap ExtendedAttributes, Porkbun registry
  requirements) or premium names: stop; buy in the registrar's dashboard, then `domain connect`.
- Namecheap `NonRealTimeDomain`, GoDaddy async registration: poll until done (006 rules).
- The domain is not in any configured registrar account: say so; `--registrar` picks one.
- Records that cannot be copied (ALIAS at the apex, URL redirects): list them and how they map
  (CNAME flattening at the apex) before the approval.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-701**: `opscrew domain buy <domain> --registrar <cloudflare|porkbun|namecheap|godaddy>` MUST
  buy through that registrar with the 006 safety rules (typed domain, never `--yes`,
  `--max-price` in scripts, one purchase per domain, audit) and then switch the nameservers to a
  Cloudflare zone.
- **FR-702**: Three new connectors (`@opscrew/connector-porkbun`, `-namecheap`, `-godaddy`) MUST
  implement the `Registrar` contract plus the optional capabilities their APIs offer: nameservers,
  current DNS records, DNSSEC (DS) records (Porkbun; Namecheap and GoDaddy have no DNSSEC API, so
  OpsCrew shows the values and the dashboard link), account checks; responses validated with zod;
  secrets never in errors.
- **FR-703**: `opscrew domain connect <domain> [--registrar …] [--records-file <bind file>]` MUST
  implement US2 with every change approved (typed domain) and nothing changed when refused.
- **FR-704**: Registrant contact data MUST never be collected from the user, stored, logged,
  audited or sent to a model; where a registrar requires contacts on every call (Namecheap), the
  account's own default contact is read and passed back to the same registrar in memory only
  (ADR 0009); GoDaddy uses a saved profile or the account's own details.
- **FR-705**: `opscrew domain search --compare` and `--registrar` MUST show live prices per
  registrar without ranking by anything but price.
- **FR-706**: `opscrew domain status` and `auto-renew` MUST work for every registrar, saying where
  a setting can only be changed in the dashboard.
- **FR-707**: `opscrew init` MUST check each configured registrar's credentials and access.
- **FR-708**: Cloudflare MUST provide the zone's nameservers, an activation check, record copy
  (batch) and DS values for another registrar.
- **FR-709**: The MCP check tool, skill and README MUST cover the registrars; no MCP tool buys or
  connects.
- **FR-710**: Gated sandbox tests MUST buy and connect through Porkbun's sandbox
  (`OPSCREW_E2E_PORKBUN_*`) and Namecheap's sandbox (`OPSCREW_E2E_NAMECHEAP_*`).

### Key Entities

- **Registrar capabilities**: purchase, years selectable, nameservers, records, DNSSEC, auto-renew.
- **Record copy plan**: records read from the registrar (or scan/BIND), how each maps to Cloudflare.

## Success Criteria *(mandatory)*

- **SC-701**: No test path buys or switches nameservers without the typed domain; `--yes` never.
- **SC-702**: No test or log output contains a contact field value (seeded fake contact data).
- **SC-703**: Connecting a domain with MX and TXT records copies them before the nameserver switch
  (tests assert the order).
- **SC-704**: Feature 006 behaviour for Cloudflare is unchanged.

## Assumptions

- Transfers between registrars are not part of this feature.
- DNS stays on Cloudflare; registrar DNS hosting is only read (to copy records).
- GoDaddy has no public test environment for v3; its adapter is tested with fakes only.
