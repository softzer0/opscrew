# Implementation Plan: Retarget anywhere

**Feature**: `specs/023-retarget-anywhere` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md) |
**Research**: [research.md](research.md)

## Summary

Today's step machine stays (`started`, `renamed`, `created`, `deployed`, `migrated`, `switched`;
`--finish`, `--abort`). Every place it touches a server goes through a **`MoveSide`**, one per
side:
- cloud: an IaC root, and SSH as deploy;
- own: a host plan, and SSH;
- Portainer: stack plans, and Portainer's Docker proxy.

Volumes move one way on every side, through the Docker Engine API: on Portainer through its proxy,
on SSH sides through `ssh deploy@host docker system dial-stdio`, which is the Docker API over the
SSH channel. A pinned `busybox` "carrier" container mounts each volume:
- **Read:** archive `GET` from a carrier that is created and never started, with the volume
  mounted `:ro`.
- **Write:** the carrier empties the volume, then exits, and gets the archive `PUT` while it is
  stopped.
- **Digest:** the carrier prints a sorted listing with modes and SHA-256 sums, reduced to one
  hash. Each side hashes on its own server.

Service containers are only stopped and started. Postgres keeps its dump, run on every side the
same way: `pg_dump -Fc` and `pg_restore` in one-off postgres containers on the service's network,
through the Docker API, with the dump in a move volume that copies like any other (one path
wherever the sides are; `move` keeps its own).

## Technical Context

- **TypeScript and tooling:** TypeScript strict ESM, Vitest, zod, Biome. A new package,
  `@opscrew/connector-docker`, has no npm dependency: it speaks HTTP/1.1 over a Duplex stream with
  Node's `http` and `createConnection`.
- **Engines and images:** OpenTofu and Terraform for layouts and storage roots. New pins: `busybox`
  (the carrier) and `rclone` (bucket copies), multi-architecture digests.
- **Tests:**
  - fakes for every side;
  - a Docker-gated catalog copy test (`OPSCREW_DOCKER_TESTS=1`; spike S1 became this test);
  - a gated Portainer test against a local Portainer 2.33.1;
  - a gated live pass.

## Constitution Check

- **I:** every IaC change is approved by plan hash. That covers the new server, the layout's DNS
  switch, the new bucket, a removal, and own host plans (`host-apply`) and Portainer stacks
  (`stack-apply`). The window's container stops, starts and volume writes are one `remote-exec`
  approval listing each volume, with `--allow-downtime` in a script. `--finish` deletes after the
  typed name: a second one for a bucket. Never the user's server, Portainer or its environment.
- **IV:** bucket keys reach rclone only on standard input. Postgres passwords reach one-off
  containers only as a `.pgpass` written through the archive API, never in Env or Cmd. Volumes
  stream through this computer and are never stored. Leak tests in every agents task.
- **VIII:** Docker through a typed connector, DNS through the IaC engine, servers through the host
  adapter, stacks through the Portainer connector.
- **X:**
  - One copy mechanism for every kind and side, rather than 17 dump tools.
  - Sites move only between site hosts.
  - Tunnels are refused on either side at first: switching between A records and a tunnel's
    CNAME needs two applies with an outage, so a later feature does it.

## Design

### 1. Sides (T2301 writes the interface; T2307 and T2308 implement it)

`agents/src/retarget/sides/types.ts`:

```ts
interface MoveSide {
  kind: "cloud" | "own" | "portainer";
  docker: DockerClient;
  prepare(s): Promise<Stop | undefined>; // step created
  deploy(s): Promise<Stop | undefined>;  // step deployed: app healthy, edge stopped
  stopApp(); startApp(); stopServices(names); startServices(names); stopEdge(); startEdge();
  volumes(): Promise<{ owner: string; key: string; name: string; bytes: number }[]>;
  remove(s, confirm): Promise<void>;     // --finish (old side) and --abort (new side)
}
```

- Volumes are paired by Compose's volume key (`com.docker.compose.volume`), never by name. Sizes
  come from `GET /system/df?type=volume`.
- **cloud** `prepare` is today's `createStep`, and `remove` is today's removal.
- **own:**
  - `prepare` is `prepareOwnServer` plus the own host plan. It sets the app up beside other apps
    and refuses what provision refuses.
  - `remove` is `planTeardown(facts, { app, deleteData: true })` with `allowDestroy` and the typed
    name. Never undo-host.
- **portainer:**
  - `prepare` and `deploy` are the stack steps, extracted from `provisionPortainer` as
    `preparePortainerStacks`, deploying the image the old side runs.
  - Stop and start go through the Docker API on the stack's containers (by Compose labels).
  - Health is a carrier `wget` on the stack's network. The edge is the stack's Caddy.
  - `remove` is `planStackTeardown` plus the recorded volumes, after the typed name.
  - Edge Agent environments are refused.
- **Connections:** the old side's goes to `server.json` `retarget.fromOwn` / `fromPortainer`, and
  the new side's to the usual `own` / `portainer` slots, so existing helpers keep working.

### 2. The steps (T2309)

| Step | Change |
|---|---|
| started | `--to` takes any server target (answers for own and Portainer) and makes the new refusals. The summary lists each stateful volume (size, copy or empty), the window's minutes and the bucket. `from.target` accepts any server target. |
| renamed | Only for a cloud old side whose root keeps the old server; otherwise recorded with no plan. |
| created | `newSide.prepare`. The layout's IaC plan runs only when it changes something (a cloud new side, or extra servers). Also the new bucket's plan, and the network peers. |
| deployed | SSH: as today. If the new side's rendered deploy workflow differs from the committed one (SSH port, the build runner's architecture), the move stops with a workflow pull request and resumes once it is merged. Portainer: the stack apply and webhook-mode deploy secrets. Then the bucket's first copy. |
| migrated | The window (3). |
| switched | The DNS switch (4); `settleSwitch` calls the sides' `startEdge` and `stopApp`. |

### 3. The window (T2309)

1. One `remote-exec` approval listing both sides' steps, each volume, its size and the minutes.
2. Deploys paused, and the scheduled check paused.
3. Old side: the app, workers and cron stop.
4. Postgres dump, while the old database still runs.
5. Old side: the stateful services stop cleanly.
6. New side: the app and the services stop.
7. The bucket's last copy.
8. For each volume to copy, its digest on the old side, then read and write, then its digest on
   the new side. The two must match.
9. New side: the services start; Postgres is recreated and restored; the release runs; the app
   starts and is checked. Then `migrated`.

- **`--empty <service>`** skips that service's volumes, which stay as the new side's deploy made
  them; `app` names the app's own volumes.
- **On any failure:** the volumes written on the new side are emptied, then the old side's
  services start, then its app, and the step stays `deployed`.
- **After a crash:** `oldAppStoppedAt` restarts the old side's services and app.

### 4. The DNS switch (T2305, T2309)

Each side is a module (cloud: `module.server`, `server_previous`) or an address (`TF_VAR_[previous_]
server_ipv4/6` from `server.json`: an own public server, or a Portainer environment serving through
its Caddy).
- **Layouts:** `moveLayout(name, from, to)` accepts any pair of server targets, and `rootShape` no
  longer needs a server module.
- **The switch** stays an update-only DNS plan (`assertDnsUpdatesOnly`).
- **A Portainer old side whose records are the user's:** the switch layout adopts them with
  `import` blocks (record ids read through the Cloudflare connector). The check then allows import
  plus update of `module.dns.*`. A Portainer plan in Caddy mode gains `records: true` once OpsCrew
  manages them.
- **Without Cloudflare DNS:** today's `switchByHand`; a Portainer side's public address is asked
  for.
- **Refused on either side, until a later feature:**
  - a tunnel (own `access: tunnel`; Portainer `web.mode: tunnel` or `redeploy: cloudflare`);
  - Portainer `proxy` with Cloudflare DNS;
  - two different Portainer instances (one `PORTAINER_API_KEY`).

### 5. Buckets (T2311)

Only from cloud provider X to cloud provider Y, with the bucket at X.
- **started:** `rclone size --json` in a one-off container on the old server. The summary shows
  the size, objects, minutes and egress.
- **created:** the storage root renders the new bucket plus `bucket_previous`, with
  `prevent_destroy` and a second provider alias, through `iac-apply`.
- **deployed:** the deploy secrets carry the new bucket's login. Then the first copy on the new
  server:

  ```
  docker run -i --rm <rclone@digest> sh -c 'umask 077; cat >/tmp/r.conf; exec rclone --config /tmp/r.conf copy old:b new:b --checksum --metadata'
  ```

  The keys arrive on standard input only, and the output is redacted.
- **The window:** the last copy uses `sync`. The destination was made by this move.
- **`--finish`:** `bucket_previous` is deleted after its own typed name (`planBucketDeletion`).
- **`--abort`:** the new bucket is deleted after its typed name, and the secrets go back.
- **`--keep-bucket`:** skips all of this.

### 6. Sites (T2312)

Between Cloudflare's hosting and GitHub Pages only, in steps `started`, `deployed`, `switched`:
1. **started:** the site targets design offers the app.
2. **deployed:** the new target's provision without the hostname, with its setup pull request
   merged and its first deploy checked at `workers.dev` or `github.io`.
3. **switched:** one Cloudflare plan moves the hostname (`allowDestroy`, the typed name).
4. **`--finish`:** the old Worker or Pages site goes.

A site to a server and back stays refused (roadmap, later).

### 7. Several servers and monitoring (T2313)

- **Extra servers** stay in every layout.
- **At the start:** the `app` member moves to `retarget.from.member`, and a new `app` member is
  written (a new address, a new key).
- **`created`:** host plans on the extra servers and the monitoring server add the new peer.
- **`--finish`:** they drop the old member. **`--abort`:** the reverse.
- **Monitoring:** with `where: app`, its volumes copy like the others; with `server` or `shared`,
  it stays.

## Order

1. T2301 (lead).
2. Wave 1: T2302, T2303, T2304, T2305.
3. Wave 2: T2306, T2307, T2308.
4. Wave 3: T2309, T2310.
5. Wave 4: T2311, T2312.
6. Wave 5: T2313, T2314, T2315.
7. Live: T2316, T2317.
8. Simplify: T2318.
9. Release: T2319, with 022's opt-ins.

## Complexity Tracking

| Choice | Why | Simpler rejected |
|---|---|---|
| A Docker connector over dial-stdio | One volume copy for SSH and Portainer, with no exec, and streaming | A `docker cp` pipe per side: two code paths, and a streaming shell anyway |
| A `busybox` carrier image | Emptying and hashing a volume need a process; services' images may lack `find` or `sha256sum` | The service's own image: not every image has them |
| Import blocks for a Portainer side's records | Keeps the DNS switch automatic in both directions | Switching by hand whenever Portainer is a side: an outage, and the user's work |
