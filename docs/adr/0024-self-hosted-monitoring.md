# ADR 0024: Self-hosted monitoring, pushed by Alloy to one server per repository

**Status**: Proposed (2026-11-01, feature 020). The founder set the scope on 2026-10-18 and made it
a feature of its own on 2026-10-30; the design is the lead's. The spike (T2001) may amend it.

## Context

017 gave every app logs and figures on demand, plus Beszel and Grafana Cloud as add-ons. The
founder asked for a private, self-hosted Prometheus, Loki and Grafana: by default on a small
monitoring server that watches all of the user's OpsCrew servers, on the app's server only from
4 GB, reached only through 018's private network, with ready-made dashboards for the server, the
containers, HTTP traffic, Postgres and Caddy.

## Decision

- **D1. Push, through one Grafana Alloy per server.**
  - Every monitored server runs Alloy, which 017 already pins. It sends the server's figures,
    cAdvisor's container figures, the masked logs, and Caddy's and Postgres's figures where they
    run.
  - No node-exporter, cAdvisor or postgres_exporter containers, and no list of targets on the
    monitoring server.
  - With Grafana Cloud on, the same Alloy sends to both.
- **D2. The monitoring server is one of 018's extra servers,** with no app services. Its creation,
  sizing, price, host key, network membership, disk check and deletion with a typed name are
  018's.
- **D3. One monitoring server per repository.**
  - The first environment to turn monitoring on owns it, and the others send to it.
  - It joins each sender's network as an outside member, with one WireGuard interface per network,
    as an own server with several apps does.
  - Across repositories is later.
- **D4. Nothing public, and least access inside the network.**
  - A Caddy front on the private addresses passes only the two push paths, and the filter admits
    only the network's servers to it.
  - Grafana answers only devices and the SSH tunnel.
  - Prometheus's and Loki's query APIs are reachable only from Grafana, on the stack's own Docker
    network.
  - App servers never admit the monitoring server.
- **D5. OpsCrew renders its own dashboards** (Apache-2.0): servers, containers, HTTP traffic, Caddy,
  Postgres and logs. They are provisioned read-only, and the user's own dashboards are kept.
- **D6. Retention by time, with a size cap for figures,** estimated at design. Alerts stay with
  017's scheduled check.

## Consequences

- One small server, about €4–5 a month at Hetzner, watches every environment of a repository.
- Each monitored server gives Alloy its memory, shown with its price share at design.
- Any device on any of the repository's networks can see every environment's dashboards. Grafana
  has one login.
- `retarget` refuses an environment with monitoring on until 023.
- Grafana and Loki are AGPL-3.0. OpsCrew renders configuration for the official, unmodified images
  and never links them into the CLI.

## Alternatives considered

- **Pull with exporters:** two or three more containers per server, and a target list on the
  monitoring server that changes with every server.
- **A monitoring network of its own:** a second WireGuard interface on every server, and a second
  configuration on every device.
- **grafana.com's community dashboards:** their licence couldn't be confirmed.
- **The projects' mixins:** they need Jsonnet and recording rules.
- **Grafana alerting:** a second alert path next to 017's check. Later, if users ask.
