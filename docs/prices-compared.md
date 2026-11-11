# What a small app costs: OpsCrew's targets and popular platforms

Prices as of 2026-11-03, excluding VAT and sales tax. They change often: check the sources before
quoting a figure, and redo this page rather than editing one number.

AWS, Google Cloud and Azure are planned targets that OpsCrew does not support yet, so they are
named here but not priced. [Contabo](guide/contabo.md) became a target after this comparison; see
[Contabo](#contabo) below.

## The reference app

`examples/nextjs-postgres`: one Next.js web service and one PostgreSQL database, always on, with a
custom domain over HTTPS and light traffic (under 100 GB sent a month). This is the default app of
the live end-to-end test.

## On OpsCrew's targets

What `opscrew design` proposed for that app (interview: under 1,000 users a month, best-effort
uptime, important data):

| Target | Cheapest option | Monthly |
|---|---|---|
| Hetzner Cloud, live prices | cpx22 in Nuremberg: 2 vCPU, 4 GB, 80 GB disk, 20 TB traffic; the app and Postgres on it; backups on | **€23.89** (server €19.49, IPv4 €0.50, backups €3.90) |
| DigitalOcean, published prices of 2026-10-12 | s-2vcpu-4gb in Frankfurt; backups on | **$31.20** |

Two things raise the Hetzner figure:
- **Stock.** Hetzner's API listed its cheapest types as unavailable in nbg1, fsn1 and hel1 that
  day: cx23 (2 vCPU, 4 GB, 40 GB, €5.49), cx33 (4 vCPU, 8 GB, 80 GB, €8.49) and cax11 (Arm, 2 vCPU,
  4 GB, 40 GB, €5.99). The older cpx11 and cpx21 are deprecated. When cx33 is back, the same plan
  costs about **€10.69** (€8.49 + €0.50 + €1.70 for backups).
- **Sizing.** Under 1,000 users, design sizes the app at 1 vCPU and 2 GB and Postgres at the same
  again, so it asks for 2 vCPU, 4 GB and 60 GB of disk. That rules out 2 GB servers (cpx12, €11.49)
  and the 40 GB disks of cx23 and cax11, even when they are in stock.

The live run that deployed this app on 2026-11-03 took 9 min 39 s from a clean repository to the
app answering on its own HTTPS hostname, with no human time in it (see
[e2e-coverage.md](e2e-coverage.md)).

### Contabo

Contabo was not part of the comparison above, and design was not run against it. From Contabo's
price list of 2026-11-11, its smallest plan, Cloud VPS 4 (4 vCPU, 8 GB, 100 GB disk), holds what
design asks for this app (2 vCPU, 4 GB, 60 GB):
- **€5.50 a month,** including VAT, unlike the other prices on this page, on a monthly contract.
- **A one-time setup fee** on top, whose amount Contabo's page doesn't give.
- **No provider backups:** OpsCrew's own snapshots cover the data
  (see [Snapshots and restores](guide/snapshots.md)).
- **At least a month:** a removal ends the contract at the end of its term
  (see [Deploy to Contabo](guide/contabo.md)).

## On popular platforms

The smallest always-on web service plus the smallest production-usable PostgreSQL (with
persistent storage and backups), in USD:

| Platform | Web | Postgres | Monthly | With about 1 GB for the web |
|---|---|---|---|---|
| Heroku | Basic dyno, 512 MB, $7 | Essential-0, 1 GB disk, 20 connections, $5 | **$12** | $55 (Standard-2X $50) |
| DigitalOcean App Platform | 1 vCPU, 512 MiB, $5 | 1 vCPU, 1 GiB, $15.15 | **$20.15** | $25.15 |
| Railway | usage-based | a service with a volume | **about $20–55** | about $25–60 |
| Render | Starter, 0.5 CPU, 512 MB, $7 | 0.5 CPU, 1 GB, 1 GB disk, $19 | **$26** | $44 (Standard, 2 GB, $25) |
| Vercel with Neon | Pro, $20 a seat (functions, not a server) | Neon Launch, always on, about $19.70 | **about $40** | about $40 |
| Fly.io | shared-cpu-1x, 512 MB, $3.69 | Managed Postgres Basic, 1 GB, with HA, $38 + 10 GB storage $2.80 | **$44.49** | $47.50 |

Notes:
- **Heroku:** Essential Postgres is shared, with no high availability and no rollback, at 99.5%
  uptime. Its backup retention was not found.
- **DigitalOcean App Platform:** the $15.15 database is a single node. It was unclear whether that
  price includes the first 10 GiB of storage. The $7 development database has no backups.
- **Railway:** bills the CPU and memory used. $10 per GB of memory a month and $20 per vCPU a
  month, with a Hobby plan of $5 that includes $5 of usage. Database backups were not found on its
  pricing page.
- **Render:** the Hobby workspace includes 5 GB of bandwidth, then $0.15 per GB, so 100 GB adds
  about $14. Pro is $25 a month for the workspace. There is no 1 GB web tier.
- **Vercel:** Hobby is for non-commercial use only. Next.js runs as functions billed by use, which
  Pro's $20 credit covers for a small app. The Neon figure assumes 0.25 compute units kept always on.
- **Fly.io:** its database includes high availability, which the other small databases do not.
- **Koyeb** starts at $29 a month (Pro), with Postgres from $29.76; it was not priced further.
  Netlify and Northflank were not checked.

## What it means

- For the smallest app, the bill alone is not where OpsCrew wins today. Heroku ($12) and
  DigitalOcean App Platform ($20.15) cost less than Hetzner's €23.89, for a 512 MB web service
  (against a 4 GB server) and a 1 GB database.
- At about the same size (1 GB or more for the web, a database next to it), the platforms cost
  $25–55. OpsCrew's €23.89 buys 4 GB shared by both, 80 GB of disk and 20 TB of traffic.
- Each further part (a worker, cron jobs, Redis, a second app) is another line on a platform's bill.
  On OpsCrew's server it costs nothing extra until the server is full. Those parts' platform prices
  are not priced here.

## Sources

- **Hetzner:** the Cloud API's `GET /v1/server_types` (prices and availability per location),
  https://www.hetzner.com/cloud/cost-optimized/, https://www.hetzner.com/cloud/regular-performance/,
  https://docs.hetzner.com/cloud/servers/overview/
- **DigitalOcean:** https://www.digitalocean.com/pricing/droplets,
  https://www.digitalocean.com/pricing/app-platform,
  https://www.digitalocean.com/pricing/managed-databases
- **Contabo:** https://contabo.com/en/vps/
- **Heroku:** https://www.heroku.com/pricing,
  https://devcenter.heroku.com/articles/heroku-postgres-plans
- **Railway:** https://railway.com/pricing
- **Render:** https://render.com/pricing, https://render.com/docs/compute-plans,
  https://render.com/docs/postgresql-backups,
  https://render.com/changelog/updated-plans-for-render-workspaces
- **Vercel and Neon:** https://vercel.com/pricing, https://neon.com/pricing
- **Fly.io:** https://docs.fly.io/about/pricing, https://docs.fly.io/mpg
- **Koyeb:** https://www.koyeb.com/pricing
