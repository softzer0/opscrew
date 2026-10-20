# ADR 0016: Components, the service catalog, the shared edge and object storage

**Status**: Accepted (2026-10-19, feature 013)

## Context

Until 012, OpsCrew deployed one web process plus Postgres and Redis. Real apps also need:
- workers and scheduled jobs;
- other databases (MySQL, MongoDB, SQLite);
- object storage;
- message brokers;
- in part 2 of the feature, search and analytics engines.

The founder decided (2026-10-13, 14, 16) that OpsCrew provides only what the app already uses, and
that several OpsCrew apps may share a server the user owns. No container had a memory limit.

## Decision

- **Components in `plan.yaml`.** The app is a list of components: the web process, workers, cron
  jobs, services and storage. Each has a version, a memory limit and settings. A later design keeps
  the user's edits.
- **One service catalog.** Per service kind, a typed table holds:
  - the pinned image, the default version and memory, the smallest server and the licence;
  - the port, data folder, config files and healthcheck;
  - the variables the app receives, the generated secrets, a one-shot init and the host settings.
  One renderer turns it into Compose, and one into Portainer stacks. Postgres and Valkey move into it.
- **Processes.**
  - Workers run from the app's image, with each builder's start form.
  - Cron runs through supercronic, added to the image at build time with `ADD --checksum`.
  - A deploy replaces workers and cron after the web switch, and restores the previous version when
    a new worker does not stay up.
- **Every container has a memory limit.** Sizing adds them up.
- **Object storage through the IaC engine,** in a separate `storage` root that destroy and
  retarget leave alone unless the user asks to delete data:
  - R2: the bucket through the Cloudflare provider;
  - DigitalOcean Spaces and Hetzner Object Storage: the bucket through `hashicorp/aws` pointed at the
    provider's S3 endpoint;
  - OpsCrew never creates storage keys. The user creates one in the provider's console with
    OpsCrew's steps; for R2, a token limited to the bucket. It reaches the engine only as
    environment variables, so no key is in infrastructure state;
  - Garage: a container on the app's server. It can be the default on an own server or Portainer;
    on a cloud server it runs only when the user chooses it (founder, 2026-10-20).
  - An app's own storage is never replaced unasked. A known S3 host counts as a hosted service,
    and with no answer OpsCrew plans no bucket.
  - MinIO is not offered: it is archived and its images are gone.
- **Redis-protocol engines.** Valkey is the default.
  - Redis 8 runs when the app's client needs Redis's own data types, or when the app's Compose file
    runs Redis.
  - Dragonfly runs when the app's Compose file runs it, or as the user's choice on 2 or more vCPUs.
  - KeyDB is not offered: it has had no release since 2023 (founder, 2026-10-20).
- **A shared edge per server.**
  - Each app is a Compose project under `/srv/apps/<app>`.
  - A shared `opscrew-edge` project holds Caddy and kamal-proxy. kamal-proxy routes by host, and
    Caddy imports one site file per app.
  - Each app keeps its own Cloudflare Tunnel, owned by its own root as today.
  - Each deploy brings the edge's files; a version stamp keeps the newest.
  - The host record lists the apps, and the edge goes with the last one.
  - Cloud servers use the same layout with one app each.
- **Host kernel settings** for the search engines: a one-shot privileged init container on cloud
  servers, a host-plan item on an own server, refused on Portainer.
- **Kafka and Redpanda run without a login,** reachable only from the app's own containers, as
  Valkey is today.
- **Retarget** refuses before any change when the app has a stateful service other than Postgres and
  Valkey. Their data copy comes later.

## Consequences

- No new adapter and no new approval kind: every mutation goes through the IaC engine, the host
  adapter or the Portainer adapter, as constitution I lists.
- The single-app paths on servers (`/srv/app`, `/etc/opscrew/app.json`) go. Nothing is released, so
  there is no migration.
- The licences of MongoDB (SSPL), Redpanda (BSL), Elasticsearch (ELv2), Garage (AGPL), Typesense
  and Neo4j Community (GPL) are named at design. They cover the containers, never OpsCrew's code.
- Backups stay the provider's server backups. They are crash-consistent only, and the guide says
  so.

## Alternatives considered

- **A function per service:** more code, and drift between Compose and Portainer.
- **A custom S3 adapter for buckets:** a new mutation path, which would need a constitution change.
- **One edge per app on other ports:** breaks 80 and 443 and the tunnel.
- **A host-mounted supercronic:** impossible on Portainer.
