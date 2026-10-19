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
- **Object storage through the IaC engine:**
  - R2: bucket and a bucket-scoped token in the Cloudflare root;
  - DigitalOcean Spaces: bucket and a bucket-scoped key in the DigitalOcean root, with one key from
    the user for Terraform's bucket calls;
  - Hetzner Object Storage: the bucket through `hashicorp/aws` pointed at Hetzner's endpoint, with
    the user's key pair (Hetzner has no API to create one);
  - Garage: a container on an own server or Portainer.
  - MinIO is not offered: it is archived and its images are gone.
- **A shared edge per server.**
  - Each app is a Compose project under `/srv/apps/<app>`.
  - A shared `opscrew-edge` project holds Caddy, kamal-proxy and cloudflared. kamal-proxy routes by
    host, and Caddy imports one site file per app.
  - The host record lists the apps, and the edge goes with the last one.
  - Cloud servers use the same layout with one app each.
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
