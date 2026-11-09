# Implementation Plan: Credential rotation

**Branch**: `main` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

## Summary

`opscrew rotate` lists every credential OpsCrew made for an environment with its age, and rotates
the ones named. A rotation is a plan approved by its hash. On a server it runs as one script over
SSH from this computer: deploys held, each service's change while it runs, the new env files, the
service restarted only where its image needs it, the app's own rolling switch with the image that
runs, then the old values dropped. The script is sent over SSH, as the deploy sends its own, and
switches the app in seconds instead of the minutes a GitHub Actions run takes. Portainer goes
through its Docker exec API and a stack plan; this computer through Docker directly. SSH keys,
WireGuard keys, the Cloudflare tokens, the state passphrase and the add-ons each have their own
path, all through typed adapters or the IaC engine.

## Technical Context

- TypeScript monorepo (`packages/*`), POSIX shell on servers, Docker Compose, OpenTofu/Terraform.
- Builds on:
  - 024: `agents/src/snapshot/*` (a one-time approval file on the server bound to the plan hash, a
    server script over SSH, holding deploys with `RESTORE_HELD`), the snapshot record `about.json`.
  - 019: the rollback's hold of deploys, `switch.ts` (the deploy's server script, rendered per run).
  - 013/018: the catalog (`iac-templates/src/catalog`), grants, split placement.
  - 011/014: the recovery copy (`agents/src/secrets/*`), the Access and Tunnel modules.
  - 021: advise's readings and rules; 017: the scheduled check.
- Approval kinds unchanged: a rotation is a `remote-exec` plan by hash (as 024's restore); app
  secrets that log users out add `allowDestroy`-grade typed confirmation of the app's name; token
  replacements and the state passphrase are IaC plans by hash.

## Constitution Check

- **I (gate):** every rotation is shown and approved by its hash before any change; the one-time
  approval file on the server is bound to that hash (024's pattern); infrastructure (the Access and
  Tunnel tokens, the state passphrase) through the IaC engine's approved apply; own servers' keys
  through host plans (ADR 0011); Portainer through stack plans (ADR 0012).
- **IV (secrets):** values travel only over SSH's stdin, in env files, GitHub secrets and the
  Portainer stack; every old and new value is registered with the redactor before anything prints;
  the workflow never sees a value outside its secrets; the rotation record holds names and dates
  only. The tools of research R10 that take a value only as an argument see it inside the service's
  container for the second they run, said in the guide.
- **VI (contracts):** one contract change, the engine's `replace` (below); ADR 0029 records the
  rotation design.
- **VII (tests):** every recipe has a Docker test gated by `OPSCREW_DOCKER_TESTS=1` (a client
  connected through the change), plus the live pass.

## Design

### 1. The inventory and the record

- `agents/src/rotate/inventory.ts`: from the plan, the generated values and the record, every
  credential of the environment: its name (what the command takes), kind, how it rotates
  (`seamless`, `swap` with seconds, `restart` with seconds, `logout`, `devices`), what else changes,
  and its date. Names:
  - each service by its plan name (all its generated secrets);
  - `app` (every generated app secret) and `app:<NAME>`;
  - `deploy-key`, `check-key`, `preview-key`;
  - `network`, `device:<name>`, `grant:<device>/<service>`;
  - `access-token`, `tunnel-token`, `state-passphrase`, `recovery-key`;
  - `monitoring`, `portainer`, `beszel`;
  - the user's tokens: `hetzner`, `digitalocean`, `cloudflare`, `github`, `cloudflare-deploy`,
    `ghcr`, `ntfy`.
- **The record** (plan-schema, committed): `opscrew/credentials.yaml`, per environment, per
  credential name: `rotatedAt` (or `madeAt`) and a `generation` counter. Never a value. A credential
  with no entry is "since the first deploy" (`deployment.firstDeployAt`).
- **The user's tokens' first-seen dates** live on this computer (`~/.opscrew/token-dates.json`: a
  SHA-256 fingerprint and a date per token), never committed: a token is the user's.

### 2. Per kind: the catalog's recipes (research R2–R4, R10)

A new optional `rotation` field on `ServiceSpec`:
- `mode`: `dual` (MySQL `RETAIN`, Valkey, Redis, Dragonfly, Garage's key), `swap` (PostgreSQL,
  MariaDB, MongoDB, Neo4j, RabbitMQ, Kafka, Redpanda, Elasticsearch, OpenSearch) or `restart`
  (ClickHouse, NATS, Meilisearch, Typesense's start key, Garage's RPC secret);
- `begin(ctx)`: the lines run in the service's container that make the new value valid (old and
  new arrive as the container env vars `OPSCREW_OLD` and `OPSCREW_NEW`, set with `docker exec -e
  NAME` from the script's own environment, never on its command line), with the login each needs
  (MySQL and MariaDB as root, both `root@localhost` and `root@'%'` when root rotates; MongoDB as its
  root user; Neo4j by `cypher-shell` in `system`; OpenSearch's account API; Elasticsearch's
  `_password` API);
- `finish(ctx)`: the lines that drop the old value once the app runs on the new (MySQL `DISCARD OLD
  PASSWORD`, Valkey/Redis/Dragonfly `<old`, Garage `key delete`);
- `recreate`: whether the service must restart with the new env (`restart` mode always; Redpanda
  and Garage too, since their tools and start read the env: R10).
Kinds without a recipe (none today) are refused with the reason.

A running container never needs its env's value after a rotation (lead, 2026-11-08, from T2503):
a service whose start or health check reads the password after its first start keeps it in a
container file (the container's filesystem, not the data volume), written from the env only when
missing; `begin` and `finish` rewrite that file. A `docker restart` or a reboot keeps the rotated
value, a later deploy's recreate writes it from the new env file, and no service restarts for a
rotation. ClickHouse's user file and NATS's token file follow the same rule. `rotate.sh` switches
only the app, never `compose up` the services.

### 3. Servers: one script, `rotate.sh`, over SSH

Run from this computer over SSH (the deploy key, through the tunnel when public SSH is closed),
after the plan's approval, like 024's restore:
1. a one-time approval file bound to the plan hash; deploys held (`RESTORE_HELD`'s mechanism), and
   a running deploy, move or snapshot refuses the rotation;
2. the new values arrive on stdin with the new env files (rendered by agents, as provision renders
   them); the old env files are kept as `.previous` until the end;
3. for each service, `begin`; for `restart` services, the new env file first, then the service
   recreated;
4. the env files written; services with `recreate` recreated;
5. the app's rolling switch with the image that runs (`switch.ts` rendered for this run, the same
   script the deploy sends; no pull, the image is on the server);
6. for each service, `finish`; the hold released; the `.previous` files removed;
7. on any failure: stop, keep the `.previous` files and the hold, report the step; running the
   command again resumes from the step (the state in the approval file's folder), or `opscrew
   rotate --undo` puts the old values back where the step allows (before `finish`).
Before the script, this computer replaces the GitHub secrets (the deploy then writes the same env
files), with deploys already held. After it, the record and the recovery copy (a pull request).

### 4. Portainer and this computer

- **Portainer:** `begin` and `finish` through the Docker exec API (`connectors/portainer`'s Docker
  proxy, as 023's carrier); the new values through a stack plan (ADR 0012, values by fingerprint),
  which recreates the changed containers; then `finish`.
- **This computer:** the same steps through local Docker, the files rewritten in place.

### 5. SSH keys (US3)

- `deploy-key`: a new pair; cloud servers get the new public half appended to `authorized_keys` over
  SSH with the old key; own servers through the host plan (`deployKeyStep` given both keys); the
  GitHub secret replaced; a deploy dispatched and followed (`dispatchAndFollow`) proves it; then the
  old half removed (`authorized_keys` rewritten; own servers' host plan with the new key only).
- `check-key`: the same with its `restrict` line and a check run as the proof.
- `preview-key`: the preview server's `authorized_keys`, proven by a preview server check; the key
  joins the recovery copy (`secrets/files.ts`).

### 6. App secrets (US4)

- Laravel `APP_KEY`: the new key current, the old appended to `APP_PREVIOUS_KEYS` (derived; dropped
  by `--drop-previous`).
- Better Auth (T2533, research R8):
  - `BETTER_AUTH_SECRETS=<n+1>:<new>,<n>:<current>,…`, with `BETTER_AUTH_SECRET` kept as it is. It
    is Better Auth's fallback for data from before the versioned envelope.
  - Every user is logged out (sessions are signed with the current secret only), so the
    consequence line and the typed app name apply.
  - `--drop-previous` keeps the first entry and sets `BETTER_AUTH_SECRET` to it.
- Others: the plan's consequence line and a typed confirmation of the app's name (R9).
- `CRON_SECRET`: in the same env write; no confirmation.
- They go through steps 2, 4 and 5 of `rotate.sh` (no service step). Cloudflare-hosted sites: the
  GitHub secret and a deploy.

### 7. The private network and devices (US5)

- `network`: new server keys; cloud servers over SSH, own servers by host plan: the private key file
  replaced and `wg syncconf` with the others' new public keys in one change; every device named, its
  new config written (a new pair, `vpn/devices.ts`'s writer) and shown as a QR on request.
- `device:<name>`: `vpn add`'s path with the same name (the old peer removed).
- `grant:<device>/<service>`: a new password shown once; the service's ACL line through `begin`
  (`ACL SETUSER <device> >new`) and the env (the hash), `finish` drops the old.

### 8. The Cloudflare tokens and the state passphrase (US8)

- **Engine contract change (lead, T2502):** `IacEngine.plan` options gain `replace?: string[]`
  (`-replace=<address>`, both engines); the plan summary already counts replacements, so the
  approval needs `allowDestroy` and the typed confirmation as any replacement does.
- `access-token`: an infrastructure plan replacing the token resource (`-replace`), approved by hash;
  the GitHub secrets or Portainer's webhook value follow, with the deploys paused.
- `tunnel-token` (R11): the Tunnel's secret changed in place through the Cloudflare connector
  (`PATCH …/cfd_tunnel/{id}` with a new `tunnel_secret`), under the rotation's own plan approved by
  hash. Running connectors stay connected. Then the new token goes into the server's tunnel token
  file (cloudflared restarted, one connector at a time) or Portainer's stack value. The gap is one
  connector's restart (seconds), none with two connectors. There is no replacement and no typed name.
- `state-passphrase`: `TF_ENCRYPTION` with a new key provider and method and the old as `fallback`
  (`iac-engine/src/encryption.ts`), a plan (no changes) approved by hash and applied, which rewrites
  the state under the new key (R10); then the new passphrase file replaces the old. OpenTofu keeps
  the key provider's name in the state's plaintext `meta`, and a name can't be reused for another
  key in one run (T2502), so the name alternates between `opscrew` and `opscrew_next` with each
  rotation and every run reads the current one from the state (`stateKeyName`): one apply per
  rotation, nothing else stored (lead, 2026-11-08).

### 9. The user's tokens (US6)

- Expiry: Cloudflare's `tokens/verify` `expires_on` (the connector has `verify`), GitHub's
  `GitHub-Authentication-Token-Expiration` (advise reads it); Hetzner and DigitalOcean: first-seen.
- Replacing: the new token from the environment, its permissions checked as `init` does, every copy
  replaced (GitHub secrets by provision's setters, Portainer's registry entry by its stack plan), the
  date recorded, and the provider's page named for deleting the old.

### 10. Add-ons (US8)

- `monitoring`: Grafana's admin password through Grafana's API in its container and the env;
  the Postgres monitoring login through the PostgreSQL recipe.
- `portainer`: Portainer's API (`PUT /api/users/{id}/passwd`) with the old password, then the local
  file.
- `beszel`: the hub's password and key through provision's add-on path.
- `recovery-key`: today's `rotateRecoveryKey`, moved; `opscrew secrets rotate` is removed.

### 11. Ages: advise and the check (US7)

- advise: a rule over the inventory: older than `credentials.maxAgeDays` (plan, default 365) is
  "soon", with the command.
- The check (`iac-templates/src/check`): with `check.credentials: true`, the workflow gets the
  record's dates (committed) and the age; an old credential opens an issue like the other findings.

### 12. Restores after a rotation (FR-2512)

- **Which copies hold logins.** Database dumps cover only the `app` database. Cache copies are RDB
  and AOF files, and Portainer copies only those two kinds. None of them holds a login, so restoring
  them needs nothing. Logins live in two places:
  - volume copies of the kinds snapshotted by stopping them: RabbitMQ, Neo4j, Kafka, Redpanda,
    OpenSearch, Elasticsearch, Garage's key;
  - whole-server snapshots, which hold every service's data (T2514's review).
- **What a snapshot records.** A volume copy's `about.json` records the service's `generation`
  from the server's or this computer's `.snapshots/generations`. `rotate.sh` and this computer's
  rotation write that file when the data takes the new value, and write the old value again on undo.
  The generated values keep each earlier generation (this computer, 0600, and the recovery copy)
  while a volume copy or a whole-server snapshot needs it. `snapshot list` in the CLI forgets the
  rest; the read-only MCP tool never does.
- **A volume copy's restore.** For each restored service whose generation is older: start the
  service without waiting for its health check (the check logs in), then `begin` with the old
  generation's value as the login and the current one as the new, then `finish`, then wait.
- **A whole-server restore (T2520).** The restored server's own `.snapshots/generations` gives each
  service's generation at the snapshot. For each one behind the record, `rotate.sh` runs from that
  generation's values to the current ones (begin, switch, finish), root first for MySQL and MariaDB,
  before deploys resume. Its review added these rules:
  - **Start commands:** a service on a start command from before 0.2.6 gets only that command, by a
    Compose override, and the restored definition stays as it is.
  - **Order:** the app's health is checked after the re-rotation.
  - **New services:** a service added since the snapshot is left to the next deploy.
  - **Deploy key:** a snapshot from before a `deploy-key` rotation is refused before the approval. The
    restored server would hold only the old key, whose private half is gone.
  - **Check key, network, logins:** rotated since, they are named in the approval, with
    `opscrew provision` to run next.
- **Snapshots of deleted servers:** forgetting earlier generations counts the whole-server snapshots
  of the servers the provider still lists for the app. Counting those of deleted servers would need
  a provider call that lists snapshots by label, which the contract has no method for (0.2.6).
- **Snapshots during a rotation.** A snapshot taken by hand is refused while a rotation holds the
  app; a scheduled one is skipped with a warning.

### 13. CLI, MCP, plugin, guide

- `opscrew rotate [<name>...] [--env] [--all] [--json] [--approve <hash>] [--confirm <app>]
  [--undo] [--drop-previous]`.
- MCP `opscrew_credentials` (read-only), the plugin skill `opscrew-rotate`, the guide page
  `docs/guide/credential-rotation.md`, `secrets-recovery.md` updated for the moved command.

### 14. Tests

- Recipes: unit tests of the rendered lines; Docker tests (`OPSCREW_DOCKER_TESTS=1`) per kind with a
  connected client, as the spike did (R10).
- `rotate.sh`: bash tests with a fake docker (as 024's snapshot script), every failure step.
- The inventory, the plan and its hash, the record, each path's adapter calls with fakes.
- Live (T2516): staging on Hetzner with PostgreSQL, MySQL, Valkey and a worker under steady requests;
  `deploy-key`; `app`; the Tunnel token; a restore of a snapshot from before; the user's own server
  and Portainer passes; a scan of every log and file for the old and new values.

## Decisions (lead, 2026-11-08)

1. **The rotation runs from this computer over SSH, not in a GitHub Actions run:** the app's switch
   follows the service's change within seconds (an Actions run adds minutes, the window of a swap).
2. **A swap's window is the switch's**, stated in the plan from the app's measured start time when
   known (status), else "about 30 seconds".
3. **Old values stay on this computer until the rotation completes**, and earlier generations while
   a snapshot needs them; nowhere else.
4. **`opscrew secrets rotate` moves to `opscrew rotate recovery-key`** (no alias, pre-1.0).
5. **Previews are left out**: each makes its own values; only the preview key is rotated.
6. **One plan per command run**, `--all` included; the typed confirmation once for all app secrets
   that log users out.
7. **Dragonfly rotates as Valkey** (R10).

## Order

- T2501 contracts and schema (lead): the record schema, `credentials.maxAgeDays`,
  `check.credentials`; T2502 the engine's `replace` (lead contract + iac-engine).
- Wave 1: T2503 recipes in the catalog (iac-templates) ∥ T2504 `rotate.sh` (iac-templates workflow)
  ∥ T2505 the inventory and the record (agents).
- Wave 2: T2506 the server path (agents) ∥ T2507 Portainer and this computer ∥ T2508 SSH keys.
- Wave 3: T2509 app secrets ∥ T2510 network, devices, grants ∥ T2511 tokens, passphrase, add-ons.
- Wave 4: T2512 the user's tokens ∥ T2513 advise and the check ∥ T2514 restores after a rotation.
- Wave 5: T2515 CLI, MCP, plugin, guide.
- T2516 live (lead); T2517 simplify (lead); T2518 the release 0.2.6 with 013's US8 (lead).
