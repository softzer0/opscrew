# ADR 0009: Registrant contacts and connecting existing domains

- Status: accepted (2026-10-13)

## Context

Feature 007 adds Namecheap, Porkbun and GoDaddy (ADR 0008 set up the `Registrar` seam with
Cloudflare). ADR 0008 decided that OpsCrew never handles registrant contacts. Porkbun and
Cloudflare register with the account's own contact, but Namecheap's `domains.create` requires the
full Registrant, Tech, Admin and AuxBilling contacts on every call, and GoDaddy's v3 registration
takes a saved contact profile (or an inline one). Separately, most users already own their domain
at one of these registrars; switching its nameservers to Cloudflare by hand is where email and
other records get lost.

## Decision

- **Contacts are never collected from the user, stored, logged, audited or sent to a model.**
  - Namecheap: the adapter reads the account's own default address-book entry
    (`users.address.getList`/`getInfo`) and passes it, in memory, to the same account's
    `domains.create` call. The approval shows only a masked summary (`J*** D***, DE`). The data
    never appears in errors, reporter output, audit entries, files or return values.
  - GoDaddy: OpsCrew never sends an inline profile with contact data. It sends the saved profile
    id from `GODADDY_PROFILE_ID` when set; otherwise GoDaddy uses the account's default profile,
    then the account's own details (the v3 API cannot list saved profiles). When GoDaddy answers
    that contacts are missing, OpsCrew stops and says to create a contact profile.
  - Porkbun and Cloudflare: the account's own contact is used by the registrar.
- **After buying elsewhere, DNS moves to Cloudflare.** OpsCrew creates the Cloudflare zone and sets
  the registrar's nameservers to the zone's; DS records are added at the registrar where its API
  allows it (Porkbun), otherwise the values and the dashboard link are shown.
- **Connecting an existing domain copies records first.** `opscrew domain connect` reads the
  current records (registrar DNS, Cloudflare's scan, or a BIND file), shows the copy plan, and
  after a typed approval creates the zone, copies the records, switches the nameservers and
  triggers Cloudflare's activation check (Cloudflare's scan needs the zone, so creating it is its
  own approval first). Old DS records would take the domain offline after the switch: they are
  removed first (through the API where it can, else by the user) and the switch waits for a later
  run, at least 24 hours after they are gone. Cloudflare's own DS record is published only once the
  zone is active.
- **Optional capabilities.** Each registrar declares what its API supports; OpsCrew says plainly
  when a setting (auto-renew, DNSSEC) must be changed in the dashboard.
- Registrar purchases keep ADR 0008's safety rules (typed domain, never `--yes`, price bound,
  one purchase per domain, idempotency keys where available).

## Consequences

- ADR 0008's "never handles registrant contacts" is refined: OpsCrew relays a registrar account's
  own default contact back to that registrar in memory when the API requires it, and nothing else.
- Transfers between registrars stay out of scope.
