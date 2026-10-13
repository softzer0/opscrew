# ADR 0008: Buying domains through registrar adapters

- Status: accepted (2026-10-13)

## Context

Users without a domain had to buy one elsewhere before OpsCrew could set up DNS and TLS. The
founder decided that OpsCrew buys and fully sets up domains through Cloudflare first, with
Namecheap, Porkbun and GoDaddy after it. Cloudflare's Registrar API can register new domains
since 2026-04 (beta; not premium names; some TLDs need the dashboard). A purchase is the first
OpsCrew action that spends money and cannot be undone.

## Decision

- A `Registrar` contract in `@opscrew/contracts` (check, suggest, register, registration status,
  domain details, auto-renew); one adapter per registrar. Cloudflare's lives in
  `@opscrew/connector-cloudflare`; the others come in feature 007 and, after buying, point the
  domain's nameservers at the user's Cloudflare zone.
- Purchases use the approval kind `domain-purchase` with the price shown and the domain typed;
  `--yes` never grants it; scripts pass `--confirm <domain>` and `--max-price <amount>`
  (constitution 1.1.0, principle I).
- Buying is idempotent per domain: OpsCrew checks the registration status before any create and
  keeps a local purchase record, because the Cloudflare API has no idempotency key.
- OpsCrew never handles payment details or registrant contacts: the registrar account's default
  contact and payment method are used.
- After a purchase OpsCrew ensures the zone, enables DNSSEC, applies auto-renew (on by default,
  shown before buying) and records the domain in `plan.dns.registration`.
- Buying is terminal-only; the MCP server only checks availability and prices.

## Consequences

- Domains needing registrant extensions (.us, .uk, .ca …) or premium names are bought in the
  dashboard for now.
- Token templates for Cloudflare gain account-level Registrar and zone-create permissions.
