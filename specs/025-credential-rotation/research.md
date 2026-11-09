# Research: credential rotation (025)

Research from 2026-11-08, the night 0.2.5 shipped (the founder's go-ahead). Four Sonnet agents
read only official documentation; a Haiku agent mapped the code. "Unverified" marks a fact no
fetched official page stated; the spike (plan) checks each one a design leans on.

The scope is the roadmap's 025 section: rotate every credential OpsCrew generates (each change a
plan approved by its hash, the recovery copy updated each time, no old or new value in any output
or log), check the age of the user's own tokens, and optionally flag credentials older than a
chosen age.

## R1. What OpsCrew makes today, and where it lives (code map)

No code path changes an existing secret: every generator makes a value once and reuses it
(`ensureSecretFile`, `ensureKeyPair`, `previous` in `assembleAppEnv`). The one rotation that
exists, `opscrew secrets rotate`, re-encrypts the recovery copy to a new age key and changes no
secret (`agents/src/secrets/copy.ts:372-420`; its message already says "change the secrets
themselves too").

| Credential | Made by | Kept on this computer | Delivered to |
|---|---|---|---|
| Services' secrets (catalog `secrets`, `hex32` or Garage's `GK…` key id) | `shared/app-env.ts:528-546` | `generated_values.json` → `services` | GitHub secret `OPSCREW_SERVICE_<NAME>_ENV`, written to `<svc>.env` by each deploy (`workflow/index.ts:422-427`); Portainer: the stack Env (`OPSCREW_SVC_<SERVICE>_<SECRET>`); localhost: the files |
| The database password | the same | `generated_values.json` → `dbPassword` | `OPSCREW_SERVICE_DB_ENV`; Portainer `OPSCREW_DB_PASSWORD` |
| App secrets (`SECRET_KEY_BASE`, `APP_KEY`, `SECRET_KEY`, `*_SECRET`, `CRON_SECRET`) | `design/plan.ts:161-162,228-246`, `shared/app-env.ts:86-101,596-604` | `generated_values.json` → `env` | `OPSCREW_APP_ENV` → `app.env`; Portainer stack Env |
| Device logins to Valkey, Redis and Dragonfly (018 grants) | `vpn/grants.ts:371-378` | `generated_values.json` → `grants` | the SHA-256 in the service's env (`grant-sha256:<device>`); the password shown once |
| Deploy SSH key | `shared/ssh-keys.ts:132-141` | `deploy_key`, `deploy_key.pub` | GitHub `OPSCREW_SSH_PRIVATE_KEY` (per environment); servers: cloud-init at first boot only (`user_data` is in `ignore_changes`), own servers: the host plan's `deployKeyStep` (`ssh-host/src/plan.ts:700-730`, keeps exactly the apps' keys) |
| The scheduled check's SSH key | `check/key.ts:49-61` | `check_key` | GitHub `OPSCREW_CHECK_SSH_KEY`; servers: cloud-init's second key line, `restrict` |
| The previews' key | `previews/keys.ts:11-17` | `preview_key` (not in the recovery copy) | the preview's GitHub secret |
| WireGuard keys of the servers | `network/keys.ts:21-28`, `network/allocate.ts` | `generated_values.json` → `network` | `/etc/wireguard/<iface>.key` (host plan, `ssh-host/src/network.ts:40-46`); public keys in `plan.yaml` |
| WireGuard keys of the user's devices | `vpn/devices.ts:203-260` | only the device's `.conf` (OpsCrew keeps no copy of the private key) | the user imports it; the public key in `plan.yaml` |
| Cloudflare Access service token (the deploy's way through a closed SSH, 013) | OpenTofu, `cloudflare-access/main.tf` (`duration = "forever"`) | the state | GitHub `OPSCREW_TUNNEL_SERVICE_TOKEN_ID` / `_SECRET` |
| Cloudflare Tunnel token | OpenTofu, `cloudflare-tunnel` (data source) | the state | a root-only file on the server; Portainer `OPSCREW_TUNNEL_TOKEN` |
| The state passphrase (OpenTofu state encryption) | `shared/secret-files.ts` | `state_passphrase` | nowhere else |
| Portainer's admin password, webhook and value key (when OpsCrew installs Portainer) | provision | `portainer_password`, `portainer-webhook`, `portainer-env.key` | Portainer |

What the user brings and OpsCrew only copies: `HCLOUD_TOKEN`, `DIGITALOCEAN_TOKEN`,
`CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` / `gh auth token` (read from the environment, no keychain);
`OPSCREW_CLOUDFLARE_DEPLOY_TOKEN` (to GitHub `OPSCREW_CLOUDFLARE_API_TOKEN`),
`OPSCREW_GHCR_READ_TOKEN` (to Portainer's registry entry; replaced when its fingerprint changes,
`portainer-flow.ts:411,458`), `OPSCREW_REPO_READ_TOKEN`, the check's ntfy token and webhook,
Grafana Cloud's and Beszel's tokens.

How a changed value reaches the running app today:
- `opscrew provision` rewrites `generated_values.json` and the GitHub secrets; the running app gets
  them on its next deploy ("run <workflow> … or push a commit", `provision/steps.ts:262-275`).
  Only origin TLS dispatches the deploy itself (`provision/origin-tls.ts:655-673`, through
  `shared/deploy-run.ts` `dispatchAndFollow`).
- Each deploy writes every env file from the GitHub secrets, then runs
  `docker compose up -d --no-deps --wait <services>` (`workflow/switch.ts:1258`): **a service whose
  env file changed is recreated, a short restart**, before the app's rolling switch.
- Portainer: provision updates the stack Env; the updater posts to the webhook every 60 seconds.
- Previews make their own values on the preview server (`previews/script.ts:262-292`), never in
  `generated_values.json`: a preview gets new ones when it is made again.

Plans approved by hash that a rotation can follow: the host plan (ADR 0011,
`shared/host-plan.ts:245-300`, `host-apply`), the Portainer stack plan (ADR 0012, `stack-apply`,
values bound by keyed fingerprints), 024's restore (`snapshot/restore-checks.ts:200-215`, a
one-time approval file on the server), 019's rollback (`rollback/record.ts:51-54`, then a workflow
dispatch).

## R2. The databases

| Service (pin) | Change while it runs | Two passwords at once | The env var on later starts | Order |
|---|---|---|---|---|
| PostgreSQL 17 | `ALTER ROLE app PASSWORD …` as `app` (the bootstrap superuser), `psql` over the container's socket | no; a second role (`GRANT app TO app_b`) works but owns nothing | read on the first start only, then unset | change, env files, rolling redeploy |
| MySQL 8.4 | `ALTER USER 'app'@'%' IDENTIFIED BY … RETAIN CURRENT PASSWORD` as root | **yes**: one secondary, ended by `DISCARD OLD PASSWORD` | first start only | retain, env files, redeploy, discard |
| MariaDB 12.3 | `ALTER USER 'app'@'%' IDENTIFIED BY …` as root | no verified equivalent (`IDENTIFIED VIA a OR b` is several plugins) | first start only | change, env files, redeploy |
| MongoDB 8.0 | `db.changeUserPassword("app", …)` in `admin` as root (`app` is the root user) | no | first start only, **but the entry's replica-set step and `mongosh` helper log in with `$MONGO_INITDB_ROOT_PASSWORD` on every deploy** | change, env files, redeploy |
| ClickHouse 26.3 | none by SQL: the image writes `app` into `users.d/default-user.xml` from `CLICKHOUSE_PASSWORD` **on every start**, and a user from a config file can't be altered | SQL users can (`ADD IDENTIFIED WITH`, version unconfirmed); the config user can't | applied on every start: the env is the truth | env files, the service recreated, redeploy |
| Neo4j 2026.09 | `ALTER USER neo4j SET PASSWORD … CHANGE NOT REQUIRED` in `system` (unverified in Community) | no | `NEO4J_AUTH` first start only (unverified) | change, env files, redeploy |

Notes:
- Root of MySQL and MariaDB is two accounts, `root@localhost` and `root@'%'`: both change.
- MariaDB's own health-check user has its own random password in `.my-healthcheck.cnf`; leave it.
- The health checks of PostgreSQL, MySQL, MongoDB, ClickHouse and Neo4j need no password.
- MongoDB's keyFile (the replica set) is a separate secret the image makes once; out of scope.
- Connections already open keep working after a change (unverified for all six: the docs don't
  say); a client that connects again with the old password fails at once.

## R3. Caches, brokers and object storage

| Service (pin) | Change while it runs | Two secrets at once | The value on later starts | Order |
|---|---|---|---|---|
| Valkey 8, Redis 8.10 | `ACL SETUSER default >new`, later `<old` | **yes**: any number of passwords per user | the start script rebuilds the password or ACL file from the env every start (nothing is `ACL SAVE`d) | add new, env files, redeploy (recreates it with only the new) |
| Dragonfly 2.0 | `ACL SETUSER default >new`, later `<old` | **yes** (the spike, R10: the docs' "only one password" is wrong for 2.0) | rebuilt from the env every start | add new, env files, redeploy |
| RabbitMQ 4.3 | `rabbitmqctl change_password app …` (syntax unverified) | no | `RABBITMQ_DEFAULT_PASS` on the first boot only | change, env files, redeploy |
| NATS 2.15 | the token is `$NATS_TOKEN` in the process's environment: only a restart changes it | no for a token | read every start | env files, the service recreated, redeploy |
| Kafka 4.3 (KRaft) | `kafka-configs --alter --add-config "SCRAM-SHA-512=[password=…]"` on the loopback listener | no (one credential per mechanism) | the entry's start loop sets it from `SASL_PASSWORD` every start | change, env files, redeploy |
| Redpanda 26.2 | `rpk security user update app --new-password …` | no | the start loop sets it from `RPK_PASS` every start; **`rpk` and the health check log in with `RPK_PASS`**, so they fail until the service is recreated | change, env files, redeploy (recreates it) |
| Garage 2.4 S3 key | a second key (`garage key import`, syntax unverified) allowed on the bucket, then the old one deleted | **yes**: several keys per bucket | the env's key is created only when missing | new key, env files, redeploy, delete the old |
| Garage RPC secret | none: a restart | no | read every start | env files, the service recreated |

Notes:
- Open connections keep working after a change for Valkey, Redis, Dragonfly (stated), RabbitMQ
  (its docs close them as a separate step) and Kafka (re-authentication is off by default,
  `connections.max.reauth.ms = 0`); Redpanda unverified.
- Kafka's broker and controller listeners are plain text on loopback: no internal credential.
- The device logins (018) on Valkey and Redis follow the same `>new`, `<old`; on Dragonfly, one.

## R4. The search engines

| Service (pin) | Change while it runs | Two secrets at once | The env var on later starts | Order |
|---|---|---|---|---|
| OpenSearch 3.9 | `PUT _plugins/_security/api/internalusers/admin` or the account API, as `admin` (unverified) | no for one user | `internal_users.yml` is loaded only when the security index is first made (the entry rewrites it every start, to no effect); **the health check reads `$OPENSEARCH_PASSWORD`** | change, env files, redeploy |
| Elasticsearch 9.5 | `POST _security/user/elastic/_password` as `elastic` | no for one user; API keys survive | `ELASTIC_PASSWORD` seeds the first start only (unverified); **the health check reads it** | change, env files, redeploy |
| Meilisearch 1.55 | none: a restart with a new `MEILI_MASTER_KEY` | no; **a new master key changes every API key made from it** | read every start | env files, the service recreated, redeploy |
| Typesense 30.2 | the bootstrap key changes only on a restart; `POST /keys` makes further keys with a chosen `value` | yes through a second key; the bootstrap key itself no | read every start; keys made through `/keys` stay | env files, the service recreated, redeploy (or the app on its own key first) |

The app reaches Meilisearch with the master key (`MEILISEARCH_KEY`, `entries.ts:1174`) and
Typesense with the bootstrap key, so today both restart for a rotation.

## R5. The ways a swap goes

1. **Two at once, seamless:** MySQL (`RETAIN CURRENT PASSWORD`), Valkey, Redis and Dragonfly (two
   passwords; Dragonfly from the spike, R10), Garage's S3 key (two keys). Add the new, deploy, remove the old.
2. **One password, a short ordered swap:** PostgreSQL, MariaDB, MongoDB, Neo4j,
   RabbitMQ, Kafka, Redpanda, OpenSearch, Elasticsearch. The runtime change first, then the env
   files and the rolling redeploy. Connections already open keep working; between the change and
   the switch a connection the old app opens fails. The roadmap's choice (founder, 2026-11-06:
   "elsewhere (PostgreSQL) a short ordered swap").
3. **A restart only:** ClickHouse's config user, NATS's token, Garage's RPC secret, Meilisearch's
   master key, Typesense's bootstrap key. The service restarts with the new value (seconds), then
   the app's switch.
4. **A second login (zero downtime for 2):** the login alternates between two names (`app`,
   `app_b`), each rotation moving the app to the other. Possible for all of 2 but PostgreSQL
   (ownership), at the cost of a changing user name in the app's address. Not the roadmap's choice.

What OpsCrew's deploy adds:
- Each deploy recreates a service whose env file changed (R1), so in 2 the deploy restarts the
  service too: the runtime change keeps its password, and the env file must hold the new one
  before any restart for the services that re-apply it (R2, R3, R4).
- The window in 2 is shortest when the deploy itself runs the change on the server, right before
  the app's switch, rather than the user's computer before dispatching the deploy (for the plan).

## R6. Keys and the user's devices

- **SSH keys (deploy, check):** a new pair, the public half added to every server beside the old
  one, the GitHub secret replaced, the old half removed once a deploy with the new key passed.
  Own servers: the host plan's `deployKeyStep` keeps exactly the listed keys, so the step takes
  both for a moment. Cloud servers: cloud-init ran once, so the change goes over SSH (a host plan
  for every server kind).
- **The previews' key:** the same, on the preview server; it is not in the recovery copy today.
- **WireGuard between servers:** `wg syncconf` changes only what differs and keeps the other
  peers' sessions (wg(8)); a node's new private key means a new handshake (seconds). A peer is
  named by its public key, so each other server gets the new key as a new peer and the old one
  removed in one `wg set` (two peers can't share allowed IPs for long).
- **WireGuard and the user's devices:** a device's config holds the server's public key, and
  OpsCrew keeps no copy of a device's private key. So a new server key means a new config on
  every device, and a device's own new key is a new config for that device (its `vpn add` again).
- **The Cloudflare Access service token and the Tunnel token:** made by OpenTofu; a new one is a
  replacement in the plan (`-replace`), then the GitHub secrets and the server's file. Their
  rotation inside Cloudflare is not researched yet (for the plan).
- **The state passphrase:** OpenTofu reads old state through a `fallback` method; see R8.

## R7. The user's own tokens

| Token | Readable with the token itself |
|---|---|
| Cloudflare | `GET /user/tokens/verify` (and `/accounts/{id}/tokens/verify`): `status`, `expires_on`, `not_before`; no issue date (`GET /user/tokens/{id}` has `issued_on` but needs API Tokens Read) |
| GitHub | the `GitHub-Authentication-Token-Expiration` header on any call (advise reads it today, `advise/readings.ts:297-350`, "now" at 7 days, "soon" at 30); no creation date |
| Hetzner | nothing: no expiry, no metadata (unverified, the reference page did not load) |
| DigitalOcean | nothing through the API (the control panel shows dates) |

So the age of a Hetzner or DigitalOcean token is only what OpsCrew records when it first sees the
token (a fingerprint and a date, never the value). Replacing a token OpsCrew copied (the Workers
deploy token, GHCR's on Portainer, the check's ntfy token) means updating each copy: provision
does it today when it finds a new value.

## R8. App secrets and the state passphrase

| Secret | Protects | A new one breaks | The previous one kept beside it |
|---|---|---|---|
| Laravel `APP_KEY` | every cookie (sessions too), `Crypt`, the `encrypted` casts (unverified) | sessions; data encrypted with it unreadable | **`APP_PREVIOUS_KEYS`**, a comma list tried after the current key; read by the default `config/app.php` (unverified, the page shows no config) |
| Better Auth `BETTER_AUTH_SECRET` | "encryption, signing, and hashing" | data tied to it unreadable | **`BETTER_AUTH_SECRETS`** = `2:new,1:old`, the first current, the rest decrypt-only; encrypted data names its version |
| Django `SECRET_KEY` | sessions, messages, password-reset links, signing (not passwords) | those invalid | `SECRET_KEY_FALLBACKS`, a setting: only when the app's settings read it from the environment |
| Flask `SECRET_KEY` | the session cookie, extensions | sessions, signed values | `SECRET_KEY_FALLBACKS` (3.1): from `FLASK_SECRET_KEY_FALLBACKS` (a JSON list) only when the app calls `from_prefixed_env()` |
| Rails `SECRET_KEY_BASE` | signed and encrypted cookies, sessions, signed ids (unverified); not Active Record encryption (own keys) | "require all users to log in again" | only through `rotate` in the app's code |
| Auth.js `AUTH_SECRET`, NextAuth `NEXTAUTH_SECRET` | the session cookie and JWT | sessions | `secret: [new, old]` in the app's code only |
| `SESSION_SECRET`, `JWT_SECRET`, `COOKIE_SECRET` | what the app's code signs | sessions or issued tokens | only if the app's code takes a list |
| `CRON_SECRET` | OpsCrew's cron caller to the app's cron route | nothing, both sides change in one deploy | not needed |

So from the environment alone, a seamless app-secret rotation exists for Laravel and Better Auth
(the old value kept as the previous one for a chosen time, then dropped). Every other one logs the
app's users out or invalidates its tokens; for Laravel's and Better Auth's encrypted data the
previous key must stay as long as data encrypted with it exists (the app re-encrypts only what it
writes again).

**The state passphrase (OpenTofu):** a new `pbkdf2` key provider and method, `state` and `plan`
pointed at them, and a `fallback` block naming the old method; OpenTofu reads with the fallback
when the new method fails and always writes with the new one. The docs' migration runs
`tofu apply`; whether a plan alone rewrites the state is unverified. Then the fallback is removed.
Key providers and methods are never renamed in place. (opentofu.org state encryption; the
version that added `fallback` unverified, the docs have it from 1.7.)

## R9. The founder's decisions (2026-11-08)

1. **A credential's age:** `opscrew advise` lists the age of every credential OpsCrew generated
   and suggests rotating any older than a year. The scheduled check flags them too, only when
   turned on in the plan, at the same age (changeable there). The token-expiry warnings (30 and 7
   days before) stay as they are.
2. **App secrets whose framework can't keep the old value** (Rails, Django, Flask, Auth.js and
   NextAuth, `SESSION_SECRET`, `JWT_SECRET`, `COOKIE_SECRET`): rotated after a typed
   confirmation, the plan first saying plainly that every user is logged out or that issued
   tokens stop working. Laravel's `APP_KEY` and Better Auth's secret rotate seamlessly, the old
   value kept as the previous one.

## R10. The spike (2026-11-08)

A Sonnet agent ran every service on local Docker with the pinned images and the catalog's settings,
a client connected with the old password the whole time. Every item passed; four corrected the
research above (marked).

| Service | Change while it runs (value over stdin or a container env var) | Open connection | Old / new on a new connection | After a restart with the old env |
|---|---|---|---|---|
| PostgreSQL | `psql -U app -d app` over the socket: `ALTER ROLE app PASSWORD …` | kept | fails / works | password unchanged (env read once) |
| MySQL | **as root only** (`app` gets error 1227): `ALTER USER 'app'@'%' IDENTIFIED BY … RETAIN CURRENT PASSWORD`, then `DISCARD OLD PASSWORD` | kept | both work until the discard | unchanged |
| MariaDB | as root: `ALTER USER 'app'@'%' IDENTIFIED BY …`; `RETAIN` is a syntax error | kept | fails / works | unchanged |
| MongoDB | `mongosh … changeUserPassword("app", process.env.NEWPW)` | kept | fails / works | unchanged |
| RabbitMQ | `rabbitmqctl change_password app "$NEWPW"` | kept (AMQP channel) | fails / works | unchanged |
| Kafka | `kafka-configs.sh --bootstrap-server localhost:9094 --alter --add-config "SCRAM-SHA-512=[password=$NEWPW]" --entity-type users --entity-name app` (`--add-config-file` refuses it) | kept (producer) | fails / works | the start loop sets the env's |
| Redpanda | `rpk security user update app --new-password "$NEWPW" --mechanism SCRAM-SHA-512` | kept | fails / works | the start loop sets the env's; `rpk` and the health check fail until the container has the new env |
| Valkey | `ACL SETUSER default >new`, later `<old` | kept | both work in between | the env's again |
| **Dragonfly** | `ACL SETUSER default >new` **adds** a password (so does `CONFIG SET requirepass`); `<old` removes it | kept | both work in between | the env's again |
| Neo4j | `cypher-shell -u neo4j -p <old> -d system`: `ALTER USER neo4j SET PASSWORD … CHANGE NOT REQUIRED` | kept | fails / works | unchanged (`NEO4J_AUTH` ignored once users exist) |
| ClickHouse | none by SQL; the entrypoint rewrites `users.d/default-user.xml` from the env every start; a mounted `users.d/*.xml` edited in place applies in about 2 s, no restart | — | fails / works | the env's again |
| Elasticsearch | `POST _security/user/elastic/_password` with the body on stdin | per request | 401 / 200 | unchanged; the health check (env) fails until the env changes |
| **OpenSearch** | the account API `PUT _plugins/_security/api/account` (`current_password`, `password`); **the internal users API is forbidden as `admin`**; weak passwords refused (random hex passes) | per request | 401 / 200 | unchanged; the health check fails until the env changes |
| Typesense | `POST /keys` with a chosen `value`; a new start key on a restart | per request | the old start key 401; keys made through `/keys` keep working | — |
| **Garage** | `garage key import --yes -n <name> <id> <secret>`, `garage bucket allow --read --write --owner <bucket> --key <id>`, `garage key delete --yes <old id>` | per request | the old key fails at once after the delete | **won't start while the env names a deleted key** ("cannot add it back"): the env must name the new key before any restart |
| NATS | a token in a mounted, included file, edited in place, then `nats-server --signal reload=1`: applied at once | **closed** (`Authorization Violation` within a second) | fails / works | — |

Also confirmed:
- MySQL and MariaDB: `root@localhost` and `root@'%'` are separate accounts; a TCP login to
  127.0.0.1 is `root@'%'`. Both change.
- Laravel's `config/app.php` (13.x, as `examples/laravel-app` pins) reads `APP_PREVIOUS_KEYS`
  (a comma list); the docs have it from 11.
- OpenTofu 1.13: with the new key and the old as `fallback`, `plan`, `plan -refresh-only` and
  `state list` leave the state as it is; any apply (`apply`, a saved plan, `apply -refresh-only`)
  rewrites it under the new key, after which the old key alone can't read it.
- **Values on a command line:** MySQL and MariaDB read the statement from stdin. MongoDB's login
  (`-p`), `rabbitmqctl change_password`, `kafka-configs --add-config`, `rpk … --new-password`,
  `garage key import` and Neo4j's login (`cypher-shell -p`) take the value only as an argument, so
  it is on that tool's command line inside the container for the second it runs. Root on the
  server can read the env files anyway; other local users of an own server could see it in the
  process list for that second.

Not tested: Kafka's and Redpanda's sessions with re-authentication on (both off by default).

Corrections to R3 and R5: Dragonfly holds two passwords, so it joins the seamless swaps; Garage's
env must name the new key before any restart once the old one is deleted; a NATS token reload
closes the old clients, so its swap is a restart in effect (the app's clients reconnect with the
new token after the switch).

## R11. The Tunnel token without an outage (2026-11-08, T2511's report)

Replacing the Tunnel (`-replace` of `cloudflare_zero_trust_tunnel_cloudflared`) fails while its
connector runs: Cloudflare refuses to delete a connected tunnel (error 1022). So that path means
stopping cloudflared, applying and starting it again, and what the tunnel serves is down for minutes.
Cloudflare documents a path without that outage ("Rotate a token without service disruption"):
- Refresh the token. In the API, `PATCH /accounts/{account_id}/cfd_tunnel/{tunnel_id}` takes
  `tunnel_secret` (random, base64, at least 32 bytes), and its response holds the new `token`.
  `GET …/cfd_tunnel/{tunnel_id}/token` returns the current token. There is no other refresh endpoint.
- "cloudflared can no longer establish new connections to Cloudflare using the old token. However,
  existing connectors will remain active and the tunnel will continue serving traffic."
- Restart the connectors on the new token, half at a time. With two replicas there is no gap. With
  one there is a gap of one restart and reconnect, seconds, though Cloudflare gives no figure.
- Provider v5: `tunnel_secret` is `Optional`, `Sensitive` and has no plan modifier, so it does not
  force a replacement. OpsCrew doesn't set it in configuration, so changing it through the API leaves
  no drift.
- Confirmed live (2026-11-09, T2516). Cloudflare's rotation page applies the same PATCH to token-run
  tunnels, although the field's description says "locally-managed". A throwaway token-run tunnel
  (`config_src: cloudflare`) with a cloudflared connector in Docker showed this:
  - Its 4 connections stayed up through the PATCH, and the connector kept running.
  - A new connector with the old token registered no connection.
  - One with the new token registered 4 at once.
  - The token from `GET …/token` changed, and the PATCH's answer held the new one.

Decision (lead): `tunnel-token` changes the secret through the Cloudflare connector, under the
rotation's own plan approved by its hash, with no `-replace` and no typed name. It then reads the
new token and restarts each connector with it.

Sources: developers.cloudflare.com cloudflare-one "Remote tunnel permissions" (rotate a token
without service disruption); the API reference for zero_trust tunnels cloudflared `edit` and `token`
`get`; terraform-provider-cloudflare `internal/services/zero_trust_tunnel_cloudflared/schema.go`.

## Unverified before the spike (all checked in R10)

1. Open connections survive a password change (every service in R2–R4).
2. Neo4j Community: `ALTER USER … SET PASSWORD`, and `NEO4J_AUTH` on a volume with users.
3. ClickHouse: users from a mounted `users.d` file reload without a restart.
4. RabbitMQ's `change_password`, Garage's `key import` / `key delete`, OpenSearch's internal users
   API, as written above.
5. Elasticsearch's `ELASTIC_PASSWORD` ignored after the first start.
6. Typesense's bootstrap key changing on a restart while `/keys` keys stay.
7. Kafka's and Redpanda's sessions when re-authentication is on (both off by default).
8. Laravel's default `config/app.php` reads `APP_PREVIOUS_KEYS` (and from which version).
9. OpenTofu rewrites state under the new key on a plan, or only on an apply.

Sources: postgres, mysql, mariadb and mongo images' `docker-entrypoint.sh` (docker-library,
MariaDB/mariadb-docker); dev.mysql.com 8.4 password management; mariadb.com ALTER USER and SET
PASSWORD; mongodb.com `db.changeUserPassword`; ClickHouse's `docker/server/entrypoint.sh`,
clickhouse.com ALTER USER and access rights; neo4j.com operations manual (manage users); redis.io
ACL; valkey.io ACL SETUSER; dragonflydb.io ACL; rabbitmq.com access control; docs.nats.io signals;
kafka.apache.org 4.3 SASL and broker configs; docs.redpanda.com authentication and cluster
properties; garagehq.deuxfleurs.fr configuration and quick start; docs.opensearch.org security
API and securityadmin; elastic.co change-password API and Docker install; meilisearch.com basic
security, master and API keys, tenant tokens; typesense.org 30.2 API keys;
developers.cloudflare.com token verify; docs.github.com token expiration and REST
troubleshooting; docs.hetzner.cloud; docs.digitalocean.com personal access tokens; man7.org wg(8),
wireguard.com quick start; docs.github.com REST Actions secrets; laravel.com 12.x encryption;
docs.djangoproject.com 5.2 settings; flask.palletsprojects.com configuration;
guides.rubyonrails.org security and api.rubyonrails.org MessageVerifiers; authjs.dev deployment
and core reference; better-auth.com options; opentofu.org state encryption (latest and v1.7).
