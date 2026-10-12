# Research: DigitalOcean Droplets (2026-10-12)

Official sources only (DigitalOcean docs and pricing, the official OpenAPI specification
`github.com/digitalocean/openapi`, the provider repository `digitalocean/terraform-provider-digitalocean`).
Items marked **confirm live** were not verifiable from the documents and are checked by the gated
live test (T413); code must not depend on them beyond what is stated.

## Terraform provider

- `digitalocean/digitalocean`, latest v2.106.0 (2026-10-12) → constraint `~> 2.106`. Token from
  `DIGITALOCEAN_TOKEN` (wins) or `DIGITALOCEAN_ACCESS_TOKEN`.
  https://github.com/digitalocean/terraform-provider-digitalocean/releases ·
  https://raw.githubusercontent.com/digitalocean/terraform-provider-digitalocean/main/docs/index.md
- Available on the OpenTofu registry under the same address: **confirm live** (`tofu init`).
- `digitalocean_droplet` (docs/resources/droplet.md): `image`, `name`, `region`, `size`,
  `backups` (bool), `backup_policy { plan = "daily"|"weekly", weekday, hour }`, `ipv6` (cannot be
  disabled later), `monitoring` (installs the metrics agent), `droplet_agent` (installed by
  default), `user_data` (change forces replacement), `ssh_keys` (ids or fingerprints; change forces
  replacement), `tags`, `resize_disk` (default true, permanent), `graceful_shutdown`. Exports
  `id`, `name`, `ipv4_address`, `ipv6_address`, `ipv4_address_private`, `status`, `tags`, ….
  **No delete protection exists** (none in the resource, none in the destroy guide
  https://docs.digitalocean.com/products/droplets/how-to/destroy/).
- `digitalocean_ssh_key`: `name`, `public_key` → exports `id`, `fingerprint` (docs/resources/ssh_key.md).
- `digitalocean_tag`: `name` (docs/resources/tag.md). Tag names may contain colons (DigitalOcean
  Kubernetes tags nodes `k8s:<id>`); OpsCrew uses `managed-by:opscrew` and `opscrew-app:<name>`.
- `digitalocean_firewall` (docs/resources/firewall.md): `inbound_rule { protocol tcp|udp|icmp,
  port_range, source_addresses }`, `outbound_rule { protocol, port_range,
  destination_addresses }`, `droplet_ids` (≤ 10) or `tags` (≤ 5). Firewalls are stateful and
  block everything not allowed; allow rules must name tcp, udp or icmp; ≤ 50 rules. Outbound rules
  are written explicitly (tcp and udp all ports, icmp, IPv4 and IPv6).
  https://docs.digitalocean.com/products/networking/firewalls/details/limits/

## API v2 (OpenAPI: https://raw.githubusercontent.com/digitalocean/openapi/main/specification/)

- Errors: `{ id, message, request_id? }` (shared/models/error.yml). 429 body
  `{ id: "too_many_requests", message }` with headers `ratelimit-limit`, `ratelimit-remaining`,
  `ratelimit-reset` (also present on normal responses). Hourly and per-minute limits: **not
  stated in the spec** — the client reads the headers instead of hard-coding numbers.
- `GET /v2/account` (`account:read`): `{ account: { droplet_limit, floating_ip_limit, email,
  name?, uuid, email_verified, status: active|warning|locked, status_message, team?: { uuid, name } } }`
  (resources/account/models/account.yml).
- `GET /v2/sizes?per_page&page` (`sizes:read`): `{ sizes: [{ slug, memory (MB), vcpus, disk (GB),
  transfer (TB), price_monthly, price_hourly (USD), regions[], available, description
  ("Basic", "General Purpose", "CPU-Optimized", …), disk_info?, gpu_info? }], links, meta: { total } }`.
  Pagination follows `links.pages.next` (field names **confirm live**; the client also stops when
  a page is empty).
- `GET /v2/regions` (`regions:read`): slugs and availability; Droplet regions today `nyc1 nyc2
  nyc3 sfo2 sfo3 ams3 sgp1 lon1 fra1 tor1 blr1 syd1 atl1 ric1 mkc1 mem1` (EU: `ams3`, `fra1`,
  `lon1`). https://docs.digitalocean.com/platform/regional-availability/
- `GET /v2/droplets?tag_name=<tag>` (`droplet:read`, `tag:read`): `{ droplets: [{ id, name,
  status: new|active|off|archive, tags[], size_slug, features[], networks: { v4[], v6[] }, region,
  image }] }`. Network element fields (`ip_address`, `type` public|private) **confirm live**;
  parse leniently.
- `POST /v2/droplets/{id}/actions` body `{ type: "snapshot", name }` (`droplet:update` +
  `image:create`) → 201 `{ action: { id, status: in-progress|completed|errored, type, started_at,
  completed_at, resource_id, resource_type, region_slug } }`; poll `GET /v2/actions/{id}`
  (`actions:read`). Snapshots cannot be tagged at creation (body has only `type` and `name`).
- The new snapshot's id: `GET /v2/droplets/{id}/snapshots` (`image:read`/`snapshot:read`) after the
  action completes, matched by the name OpsCrew gave it (response shape **confirm live**; parse
  leniently, id kept as a string).
- Ubuntu 24.04 image slug `ubuntu-24-04-x64` (follows the `ubuntu-22-04-x64` pattern): **confirm
  live**.

## Token scopes (custom scopes, https://docs.digitalocean.com/reference/api/scopes/)

Least privilege for OpsCrew (provision, drift, destroy with snapshot):
`account:read`, `regions:read`, `sizes:read`, `actions:read`, `droplet:create`, `droplet:read`,
`droplet:update`, `droplet:delete`, `ssh_key:create`, `ssh_key:read`, `ssh_key:delete`,
`firewall:create`, `firewall:read`, `firewall:update`, `firewall:delete`, `tag:create`,
`tag:read`, `tag:delete`, `image:create`, `image:read`, `snapshot:read`.
There is no `snapshot:create`; snapshots of Droplets need `droplet:update` + `image:create`. The
API cannot list a token's own scopes, so init lists the needed scopes instead of checking them;
a 403 from the API is reported with this list. Token pattern: `dop_v1_` + 64 hex characters.
Token page: https://cloud.digitalocean.com/account/api/tokens

## Pricing (https://www.digitalocean.com/pricing/droplets, 2026-10-12, USD, excl. tax)

Basic (shared CPU) — static fallback table, dated 2026-10-12:

| slug (confirm live) | vCPU | RAM | Disk | Transfer | $/month |
|---|---|---|---|---|---|
| `s-1vcpu-1gb` | 1 | 1 GiB | 25 GiB | 1 TB | 6 |
| `s-1vcpu-2gb` | 1 | 2 GiB | 50 GiB | 2 TB | 12 |
| `s-2vcpu-2gb` | 2 | 2 GiB | 60 GiB | 3 TB | 18 |
| `s-2vcpu-4gb` | 2 | 4 GiB | 80 GiB | 4 TB | 24 |
| `s-4vcpu-8gb` | 4 | 8 GiB | 160 GiB | 5 TB | 48 |

(The $4 512 MiB size is too small for Docker plus Postgres and is not offered.) Dedicated
(CPU-Optimized) sizes come from the live catalogue only.

- Backups: weekly 20 %, daily 30 % of the Droplet price
  (https://docs.digitalocean.com/products/backups/details/pricing/). OpsCrew uses daily.
- Snapshots $0.06/GB-month. Outbound transfer beyond the pooled allowance $0.01/GiB; inbound free.
- Billing per second (minimum 60 s or $0.01), capped at 672 hours a month; powered-off Droplets
  are still billed (https://docs.digitalocean.com/products/droplets/details/pricing/).
- Public IPv4: no separate charge in the published Basic plans on 2026-10-12; the pricing page
  also shows a separate public-IPv4 line item at an introductory $0.00 for newer configurations
  (**confirm live**; design treats IPv4 as included). Reserved IPs (not used) are free while
  assigned, $5/month unassigned.

## Behaviour that differs from Hetzner

- No delete protection → no protection-lifting plan in destroy; the preview and runbook say so.
- Automatic backups are **kept** after the Droplet is destroyed and expire four weeks after they
  were taken; snapshots and volumes are kept until deleted
  (https://docs.digitalocean.com/products/droplets/how-to/destroy/). Destroy's final report says so.
- `user_data` is cloud-init on Ubuntu images and cannot change after creation (as on Hetzner, the
  module ignores later changes). The default login is `root` with the SSH key; OpsCrew's
  cloud-init creates the `deploy` user and disables root SSH login as on Hetzner.
- Labels are plain tags (no key/value): lookups use the `opscrew-app:<name>` tag and require
  `managed-by:opscrew` as well.
- Prices are in USD; Hetzner's are in EUR. Budget comparison converts at the fixed rate already
  used by design (1 EUR = 1.10 USD), labelled approximate.
