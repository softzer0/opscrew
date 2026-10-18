# Buying or connecting a domain

OpsCrew can find and buy a domain for your app, or move a domain you already own to Cloudflare. The
domain's DNS always ends up on Cloudflare, where OpsCrew sets up the records, TLS and protection for
your app (see [Your domain on Cloudflare](cloudflare.md)).

## Finding and buying a domain

- `npx opscrew domain search <name>` checks availability and prices with Cloudflare Registrar.
- `npx opscrew domain buy <domain>` buys the domain at cost after you confirm the price. It then sets
  up its Cloudflare zone, DNSSEC and auto-renew, and uses the domain for your deployment.

Prefer another registrar? Add `--registrar <id>` to buy through Porkbun, Namecheap or GoDaddy
instead of Cloudflare, the default. The domain's DNS still moves to Cloudflare.

`npx opscrew domain search <name> --compare` lists the live prices of every registrar you set up,
side by side and sorted by price only.

OpsCrew never asks for your contact details: registrars use your account's own contact.

## A domain you already own

`npx opscrew domain connect <domain>` copies the domain's records into Cloudflare, then switches its
nameservers to Cloudflare.

## Before you buy

- **Purchases cannot be refunded.** You type the domain name to confirm. Scripts also need
  `--confirm <domain>` and `--max-price <amount>`.
- **Auto-renew is on by default.** Cloudflare charges the renewal to your account's default payment
  method up to 30 days before the domain expires. Turn it off with
  `npx opscrew domain auto-renew off`, or buy with `--no-auto-renew`.
- **At other registrars:**
  - Porkbun: OpsCrew sets auto-renew through its API the same way.
  - Namecheap and GoDaddy: your account's own auto-renew setting applies, and you change it in their
    dashboard.

## Settings only the registrar's dashboard can change

At Namecheap and GoDaddy, change auto-renew and DNSSEC in the registrar's dashboard. OpsCrew tells you
where.

## Cloudflare token permissions for buying

Buying needs extra permissions on your Cloudflare API token:

- **Account → Registrar → Edit**, only when you buy through Cloudflare;
- **Zone → Zone → Edit**, for all zones of the account.

The zone permissions OpsCrew already asks for must then also cover all zones of the account:

- Zone → Zone → Read;
- Zone → DNS → Edit;
- Zone → Config Rules → Edit;
- Zone → Zone WAF → Edit.

A token limited to the zones you have today does not cover the zone of a domain you buy. If you keep
the token limited, add the new domain's zone to it right after buying, before `opscrew dns` or
`opscrew provision`.
