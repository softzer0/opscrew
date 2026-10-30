# ADR 0022: Split placement and a private WireGuard network

**Status**: Proposed (2026-10-30, feature 018). The founder set the scope on 2026-10-18 and
2026-10-20 and gave the go-ahead on 2026-10-30; the design is the lead's.

## Context

An app was one server: the web process, its workers and every service on one machine. The
founder asked for a service on a server of its own, also at another provider, linked privately,
and for the user's devices on the same private network, to reach SSH and dashboards, close public
SSH and, opt-in, read the production database. He asked to compare Docker Swarm with WireGuard
plus Compose first.

## Decision

- **WireGuard plus a Compose project per server**, not Swarm (research R1):
  - Swarm needs its ports reachable between every node, which servers behind NAT can't give.
  - Its rescheduling doesn't help node-local databases.
  - Its quorum is awkward at two or three servers.
  - It would replace the Compose and kamal-proxy model.
- **One network per app and environment,** a full mesh between its servers:
  - Devices peer with each server that has a public address.
  - A server without one keeps its links alive from its side.
  - Plain WireGuard only; Tailscale and Headscale later.
- **Keys made on the user's computer** (Node's `x25519`):
  - Plans carry public keys only.
  - A server's private key reaches only its server, on standard input, into a root-only file.
    The config has no key (`PostUp = wg set %i private-key …`). Peer changes sync a full
    temporary config built from that file, because a keyless `wg syncconf` wipes the key (R5a).
  - A device's key is written only into its configuration.
- **Services listen only on their server's private address,** and a filter in `DOCKER-USER`
  admits only the app's servers and the devices granted access. The filter runs before Docker,
  which requires it (fail-closed). WireGuard starts before Docker. A port that came up
  unpublished is recreated, never trusted (R5a).
- **No TLS on the link, and no new logins for Kafka, Redpanda and OpenSearch** (R3). WireGuard
  encrypts and authenticates every packet between the servers. Their logins would break apps
  whose clients don't send them. Only the app's servers' addresses reach them.
- **Root on cloud servers through Docker:**
  - The host adapter's root steps run on cloud servers through a one-shot privileged container
    that enters the host's namespaces with `nsenter`, using the Caddy image already pinned.
    That is its third privilege, `docker`, next to `root` and `sudo`.
  - `deploy` is in the `docker` group, which is already root-equivalent, so nothing new is
    granted.
  - Cloud and own servers share every host step.
- **Extra cloud servers are more modules in the same root module** (`server_<name>`). On the same
  provider they reuse the app server's SSH key. An extra own server gets the same setup as an
  app server.
- **Device logins:**
  - The four databases get theirs from fixed statements in a host step.
  - Valkey, Redis and Dragonfly declare theirs in the service's environment, as password hashes,
    and the start wrapper writes a fresh ACL file at every start, so nothing can be lost or
    revived (R6a).
- **A live service's move** reuses retarget's window. The old copy is deleted only after an
  `allowDestroy` approval and its typed name.
- **No new approval kind:** `iac-apply`, `host-apply`, `pull-request` and `github-secrets`, as
  today.

## Consequences

- **A contract change (T1801a):** plan-schema's `servers`, `services[].server`, `network`,
  `deployment.placement` and `move`. A plan without them renders as before.
- **On servers:**
  - `wireguard-tools`, one interface and UDP port per app's network;
  - a filter unit and chain per interface;
  - ufw rules for the port and SSH on the interface.
- **Every command that reached "the server"** now takes a server's name.
- **The private addresses and public keys are committed in the plan.** The public addresses stay
  local, as ADR 0010 says.
- **Out of scope:**
  - placement on Portainer and server-less targets;
  - a service on a server without a public address;
  - workers on other servers;
  - add-ons on the extra servers;
  - moving data other than Postgres's;
  - retarget for apps with extra servers.
