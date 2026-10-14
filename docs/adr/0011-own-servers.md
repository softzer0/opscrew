# ADR 0011: Servers the user already owns

- Status: accepted (2026-10-14)

## Context

OpsCrew created every server it deployed to (Hetzner Cloud, DigitalOcean) with OpenTofu and set it
up with cloud-init. Users also want to deploy to servers they already pay for or run at home
(founder decision 2026-10-14, feature 009). OpsCrew cannot create, rebuild or delete such a server,
has no cloud firewall or provider backups there, and must not break or take over what already runs
on it. Some of these servers have no public address. Constitution 1.2.0 bound applies only to IaC
plans and listed only cloud providers.

## Decision

- A third target, `own` ("Your own server"), joins the provider seam (`ProviderId`, `VpsProviderId`,
  `VpsProviderSchema`, a profile and a connector whose catalogue is the inspected server). The plan's
  `target` is a union on `provider`; for `own` it records the architecture and whether the server is
  reached directly (`public`) or through a Cloudflare Tunnel (`tunnel`), never the address or the
  login (those stay in `.opscrew/server.json`, as in ADR 0010).
- Host changes go through a typed host adapter (`@opscrew/connector-ssh-host`): read-only inspection,
  a host plan of fixed steps, an approval of the new kind `host-apply` bound to the plan's SHA-256,
  and an apply that refuses any other plan, records previous values in `/etc/opscrew/host.json`, and
  runs SSH and firewall changes under a dead-man switch on the server so the user is never locked
  out. Teardown and undo are host plans too.
- DNS, the tunnel and Cloudflare Access stay infrastructure as code in the user's repository. A server
  without a public address is served through a remotely managed tunnel; GitHub Actions reaches its SSH
  through an Access-protected hostname with a service token (cloudflared pinned to a version whose
  service-token support is tested).
- Docker Engine 28 or newer from Docker's repository; ufw only when no other firewall manages the
  host; only the reverse proxy or the tunnel connector publishes ports.
- One OpsCrew app per server for now. Portainer CE is an opt-in add-on on every target, local-only
  by default, with a Cloudflare Access subdomain (through a tunnel) as an explicit opt-in.
- Constitution 1.3.0: the hash-bound apply names the host adapter for host changes, and the provider
  order includes servers the user already owns.

## Consequences

- Provision for `own` has two approvals (IaC and host plan); scripts pass both hashes.
- Destroy never touches the server itself; undoing OpsCrew's host changes is a separate, approved
  step. Backups are the user's responsibility, and OpsCrew says so.
- `retarget` to or from an own server and several apps per server are left for later features.
