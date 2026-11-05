# ADR 0027: Retarget anywhere: sides, and volumes through the Docker API

**Status**: Accepted (2026-11-05, feature 023). The founder set the scope on 2026-10-20 and gave
the go-ahead on 2026-11-05. The design is the lead's, settled by spike S2 (research R5) and a
review of the plan.

## Context

`opscrew retarget` moved an app between Hetzner and DigitalOcean only, and copied Postgres only.
The founder asked for moves between every target, with all of an app's data. The targets reach
their servers differently:
- a server OpsCrew created: SSH as `deploy`, and an IaC root;
- the user's own server: SSH, and host plans;
- the user's Portainer: its API only, with no SSH.

The catalog has 17 stateful kinds. Each has its own dump tool, its own handling of users, and its
own consistency limits.

## Decision

- **D1. One side per target under today's step machine.** A `MoveSide` (cloud, own, Portainer)
  prepares a target, deploys and checks the app, stops and starts the app and its services, lists
  the volumes, and removes what the move made or left. The steps (`started` to `switched`,
  `--finish`, `--abort`) stay, and each one asks the sides.
- **D2. Volumes move through the Docker Engine API on every side.** That means archive `GET` and
  `PUT` of a stopped service's volumes:
  - on Portainer, through its Docker proxy;
  - on SSH sides, through `docker system dial-stdio` over SSH.

  A pinned `busybox` carrier container mounts each volume to read, empty, write and hash it, so a
  service's own container is only ever stopped and started. Volumes are paired by Compose's volume
  key, and each side hashes its own copy, which must match. The data streams through the user's
  computer and is never stored there.
- **D3. Postgres keeps its dump.** It works across versions and architectures. On every side the
  dump and the restore run the same way: in one-off postgres containers on the service's network,
  through the Docker API. The dump sits in a move volume that copies like any other, and the
  password goes in a `.pgpass` written through the archive API, never in a container's
  environment or command.
- **D4. Copy or start empty, per service.** Copy is the default. Empty is a question, or `--empty`
  in a script.
- **D5. Buckets** move only between cloud providers' object storage, with rclone in a one-off
  container on the new server whose keys arrive only on standard input. The old bucket goes at
  `--finish`, after a typed name of its own.
- **D6. The user's server and Portainer are never removed.** At `--finish`, only the app goes:
  - from the user's server, through a teardown host plan;
  - from Portainer, through its stacks and volumes.

  Each needs `allowDestroy` and the typed name.
- **D7. Out for now:** a Cloudflare Tunnel on either side, a site to a server or back, Edge Agent
  environments, and two Portainer instances.

## Consequences

- **A new connector,** `@opscrew/connector-docker`, and two contracts: `StreamRunner` and
  `DockerTransport`.
- **Two new pinned images:** `busybox` (the carrier) and `rclone`.
- **The window's length grows with the data,** and the summary shows each volume's size and the
  expected minutes first. Through Portainer's proxy it is about 25 MB/s (R5).
- **The same image versions on both sides are required** for a volume copy. The plan pins them.

## Alternatives considered

- **A dump tool per kind:** 17 tools to maintain, each with its own user handling and consistency
  caveats (R1.1).
- **`docker cp` piped over two SSH sessions:** a second code path beside Portainer's, and a
  streaming shell anyway.
- **Exec through Portainer's proxy for Postgres:** it would need a hijacked stream, which the spike
  didn't check. One-off containers use only the calls it checked.
