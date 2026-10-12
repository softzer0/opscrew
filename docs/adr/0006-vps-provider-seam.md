# ADR 0006: One seam for VPS providers

- Status: accepted (2026-10-12)

## Context

Features 001–003 supported one provider, Hetzner Cloud. Design, provisioning, drift, init and
destroy imported the Hetzner connector directly, and the destroy flow assumed Hetzner's delete
protection and labelled snapshots. Feature 004 adds DigitalOcean Droplets with the same topology
(one server, Docker Compose, Caddy, cloud firewall), and AWS, Google Cloud and Azure follow later
with different topologies.

## Decision

- `@opscrew/contracts` defines `VpsConnector` (credentials, price catalogue, `configured`,
  `servers`) and `ServerSnapshotApi` (`findAppServers`, `snapshotServer`, string ids). Each VPS
  connector package implements them; the snapshot is the only provider API mutation and only
  adds a resource. Everything else changes through the IaC engine.
- `@opscrew/agents` keeps a provider profile per VPS provider (display name, token variables,
  console links, resource types, delete protection, default image, currency, backup percentage,
  region mapping, error patterns) and one factory, `vpsConnector(id, deps)`. Phases read the
  provider from `plan.target.provider` (or `requirements.provider` before a plan exists) and never
  import a provider connector themselves.
- The provider of a live deployment is fixed: design refuses to change it until `retarget`
  (feature 005) can move the deployment.
- Provider differences that change the safety flow are explicit profile flags, not string checks.
  DigitalOcean has no delete protection, so its destroy flow has no protection-lifting plan; the
  `allowDestroy` approval and the typed server name still guard the destroy plan.

## Consequences

- Adding the next VPS provider (for example Contabo) needs a connector package, an HCL module, a
  profile entry and region mapping; the phases do not change.
- Hyperscaler targets (AWS App Runner/ECS, Cloud Run, Container Apps) are not VPS providers and
  will need their own seam for deployment and teardown; the catalogue contract is shared.
- Existing Hetzner files stay valid: `requirements.provider` is optional and means Hetzner when
  absent, and rendered Hetzner infrastructure is unchanged.
