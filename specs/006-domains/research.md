# Research: Buying domains (2026-10-13)

Official sources only. Items marked **confirm live** are checked by the gated sandbox test.

## Cloudflare Registrar API (beta since 2026-04-15)

https://developers.cloudflare.com/changelog/post/2026-04-15-registrar-api-beta/ ·
https://developers.cloudflare.com/registrar/registrar-api/ ·
https://developers.cloudflare.com/api/resources/registrar/

- **Check**: `POST /accounts/{account_id}/registrar/domain-check` `{ "domains": [...] }` (1–20,
  real-time registry query). Per domain: `registrable`, `tier` (`standard`/`premium`), `pricing`
  `{ currency, registration_cost, renewal_cost }` (strings, only when registrable), `reason`
  (`extension_not_supported_via_api`, `extension_not_supported`,
  `extension_disallows_registration`, `domain_premium`, `domain_unavailable`). Premium domains
  cannot be bought through the API.
- **Search**: `GET /accounts/{id}/registrar/domain-search` — cached suggestions; always confirm
  with domain-check before buying.
- **Register**: `POST /accounts/{id}/registrar/registrations` `{ domain_name, years (1–10, default
  TLD minimum), auto_renew (default false), privacy_mode ("redaction" default | "off"),
  contacts?, contact_extensions?, acknowledgements? }`. Billable and non-refundable once
  `succeeded`. 201 (done) or 202 (processing); `Prefer: respond-async` → 202. Poll
  `result.links.self` or `GET /registrar/registrations/{domain}/registration-status`; states
  `pending`, `in_progress`, `action_required`, `blocked`, `succeeded`, `failed` (with
  `error.code`/`error.message`).
- **Prerequisites**: billing profile with a default payment method, verified account email, at
  most 500 domains per account; registrant contact taken from the account's default address-book
  entry when `contacts` is omitted (request fails without one). Contact data ASCII, phone E.164.
  Some TLDs need `contact_extensions` (.us, .uk, .ca …; schema via
  `GET /registrar/extensions/{ext}`). Unsupported via API: giving, mom, inc, lol, sh, link, cc,
  new, and internationalized names.
- **After registration**: Cloudflare nameservers are mandatory. Zone creation on the account
  **confirm live** (OpsCrew calls `POST /zones` and treats "already exists" as success).
  `PATCH /registrar/registrations/{domain}` updates `auto_renew` only; `locked` and
  `privacy_mode` are read-only. DNSSEC: zone DNSSEC endpoint (`PATCH /zones/{id}/dnssec`
  `{ status: "active" }`) — Registrar publishes the DS record (**confirm live**).
- **Multi-year price**: whether a multi-year registration is billed as first year + renewals or
  `registration_cost × years` is not documented (**confirm live**); until confirmed OpsCrew
  bounds and shows `years × max(registration_cost, renewal_cost)`.
- **DNSSEC states**: OpsCrew treats a zone DNSSEC status of `pending` as already on (no second
  enable) (**confirm live**).
- **Auto-renew**: `auto_renew: true` authorizes Cloudflare to charge up to 30 days before expiry
  (registrations create reference).
- **Idempotency**: none documented; `domain_name` is the natural key (one registration per
  domain). OpsCrew checks the registration status before every create and keeps a local record.
- **Token permission**: an account-level Registrar permission (exact name **confirm live**),
  plus Zone create (`Zone → Zone → Edit` at account level) for the zone, plus the existing zone
  permissions.
- **Sandbox**: `/accounts/{id}/registrar-sandbox/...`, .com and .net only.

## Later registrars (feature 007)

- **Porkbun API v3** (https://porkbun.com/api/json/v3/documentation): API key + secret (scoped
  keys incl. "manage but no purchases"), per-domain API opt-in, registration from account credit
  or per-purchase payment, a $100/month default spend cap for keys, idempotency keys, sandbox
  (`pk1_sb_` keys), dry runs, nameserver and DNS management, official MCP server. Strongest
  candidate after Cloudflare.
- **Namecheap API** (https://www.namecheap.com/support/api/intro/): production access needs 20+
  domains, a $50 balance or $50 spent in 2 years; a whitelisted IPv4; account-balance billing;
  XML; sandbox at `api.sandbox.namecheap.com`. Commands `domains.check`, `users.getPricing`,
  `domains.create`, `domains.dns.setCustom` (parameters to verify in 007).
- **GoDaddy Domains API v3** (https://developer.godaddy.com/doc/endpoint/domains): PAT bearer;
  `check-availability`, `registration-quotes` (quote token, required agreements),
  `registrations` with `Idempotency-Key` and `consent`; production access rules unclear
  (minimum domains or spend) — preflight and fall back to manual.
