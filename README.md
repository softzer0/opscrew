# OpsCrew

**The ops crew you didn't hire.**

From a GitHub repo to a hardened production deployment on your own cloud. Any cloud. You keep the infrastructure code.

> Status: pre-alpha. Not ready for production use yet.

## What OpsCrew does

OpsCrew is an open-source crew of AI agents that does the DevOps and SecOps work for your app:

1. **Scan** your repo for leaked secrets, exposed Supabase/Firebase data and risky config (free, no AI needed).
2. **Analyze** how your app is built and **interview** you about traffic, budget and regions.
3. **Design** a deployment that fits your budget and **open a pull request** with the code changes it needs (Dockerfile, health check, config).
4. **Provision** the infrastructure on your own account with Terraform or OpenTofu. You approve every change before it is applied.
5. **Wire up** your domain, TLS and CI/CD, **harden** the server and **verify** the result.

Everything OpsCrew produces is a plain file in your repo: infrastructure code, workflows, reports, a runbook. Delete OpsCrew and your deployment keeps working.

Supported clouds: Hetzner Cloud and DigitalOcean (Droplets), with optional Cloudflare DNS. The interview asks which one to use. AWS, Google Cloud, Azure and Contabo follow.

Changed your mind about the provider later? `npx opscrew retarget --to <provider>` moves a live app between Hetzner Cloud and DigitalOcean with its data: it builds the new server next to the old one, copies the database in a short maintenance window, switches DNS, and deletes the old server only when you run `opscrew retarget --finish`.

No domain yet? `npx opscrew domain search <name>` checks availability and prices with Cloudflare Registrar, and `npx opscrew domain buy <domain>` buys one at cost after you confirm the price, then sets up its Cloudflare zone, DNSSEC and auto-renew and uses it for your deployment.

Prefer another registrar? Buy through Cloudflare (the default), Porkbun, Namecheap or GoDaddy with `--registrar <id>`; the domain's DNS still moves to Cloudflare. `npx opscrew domain search <name> --compare` lists the live prices of every registrar you set up side by side, sorted by price only. Already own a domain? `npx opscrew domain connect <domain>` copies its records into Cloudflare before switching the nameservers. OpsCrew never asks for your contact details: registrars use your account's own contact. Some settings can only be changed in the registrar's dashboard: auto-renew and DNSSEC at Namecheap and GoDaddy; OpsCrew tells you where.

Before you buy:

- Domain purchases cannot be refunded. You type the domain name to confirm; scripts also need `--confirm <domain>` and `--max-price <amount>`.
- Auto-renew is on by default: Cloudflare charges the renewal to your account's default payment method up to 30 days before the domain expires. Turn it off with `npx opscrew domain auto-renew off` (or buy with `--no-auto-renew`). At Porkbun OpsCrew sets auto-renew through its API the same way; Namecheap and GoDaddy keep your account's own auto-renew setting, which you change in their dashboard.
- Buying needs extra permissions on your Cloudflare API token: Account → Registrar (edit), only when buying through Cloudflare, and Zone → Zone → Edit for all zones of the account. The zone permissions OpsCrew already asks for (Zone → Zone → Read, Zone → DNS → Edit, Zone → Config Rules → Edit, Zone → Zone WAF → Edit) must then cover all zones of the account, because a token limited to the zones you have today does not cover the zone of a domain you buy. If you keep the token limited, add the new domain's zone to it right after buying, before `opscrew dns` or `opscrew provision`.

## Development

Requirements: Node.js 22+, pnpm 10+, and OpenTofu or Terraform for infrastructure tests.

```bash
pnpm install
pnpm check      # lint + typecheck + test
```

Specifications live in `specs/` and the project constitution in `.specify/memory/constitution.md`.

## License

Apache-2.0 (see `LICENSE`), except `ee/`, which is under FSL-1.1-ALv2 and converts to Apache-2.0 after two years. Anything primarily useful to individual developers stays outside `ee/` and stays free.

OpsCrew uses Claude by Anthropic. Powered by Claude.
