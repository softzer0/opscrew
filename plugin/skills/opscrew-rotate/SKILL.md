---
name: opscrew-rotate
description: See which passwords, keys and tokens OpsCrew made for an app and how old each is (read-only), and guide the user through rotating one in their own terminal with `npx opscrew rotate`, after a leak or when a credential is old. Use when the user asks "rotate my database password", "a secret leaked", "I lost my laptop", "a teammate left", "change the deploy key", "how old are my credentials?", "my token expires", "advise says a credential is old", "replace my Hetzner (or Cloudflare, GitHub) token", or about the recovery copy's key.
---

# Rotating credentials with OpsCrew

OpsCrew makes the credentials an app runs on (each service's password, the app's own secrets, the
SSH keys, the private network's keys, Cloudflare's tokens, the state passphrase, the add-ons'
passwords, the recovery copy's key) and copies them where they are needed. `npx opscrew rotate`
replaces one everywhere, in the right order, without showing the old or the new value.

Only looking happens through a tool. **Rotating stays in the user's terminal**, because each
rotation is a plan the user approves by its hash. Never run it through a tool, never pass
`--approve`, `--confirm` or `--undo` on the user's behalf, and never ask for a value, a key or a
token in the chat.

## Looking: what can be rotated

- Call `opscrew_credentials` (read-only, with `app` and `environment` when the repository has
  several). Each credential has the name the command takes, how it rotates, when it was made or
  last rotated (or "since the first deploy"), and what else changes. Then come the user's own
  tokens with their expiry where the provider shows it.
- `opscrew_advise` names credentials older than the plan's `credentials.maxAgeDays` (a year by
  default) with the command that rotates each.
- Never claim a credential exists, or has an age, that the tool didn't list.

## Rotating one

The user runs `npx opscrew rotate <name>` (add `--env <name>`, and `--app <key>` for a further app).
Before they run it, say what the list says it costs:

- **seamless** (MySQL, Valkey, Redis, Dragonfly, Garage's key, the SSH keys, the state passphrase):
  nothing the app does fails;
- **a short swap** (PostgreSQL, MariaDB, MongoDB, Neo4j, RabbitMQ, Kafka, Redpanda, OpenSearch,
  Elasticsearch, ClickHouse, NATS): new connections the running app opens fail for up to about 30
  seconds, until its switch; open ones stay (NATS closes them and the clients reconnect);
- **a restart** (Meilisearch, Typesense's start key, Garage's RPC secret): the service is down for
  a few seconds; a new Meilisearch master key changes every API key made from it;
- **users logged out**: app secrets other than Laravel's `APP_KEY`, Better Auth's secret and
  `CRON_SECRET`. The plan says so and the user types the app's name;
- **devices**: `network` and `device:<name>` write new WireGuard configurations to import (`--qr`
  draws each as a QR code); `grant:<device>/<service>` shows the device login's new password once.

Several services and the app's own secrets rotate together in one plan
(`npx opscrew rotate db cache app`); everything else on its own. Other names: `app` and
`app:<NAME>` (the app's own secrets, on every target, a site through its GitHub secrets and a
deploy; `npx opscrew rotate app --drop-previous` drops Laravel's or Better Auth's previous value
once no data encrypted with it remains, after the user types the app's name), `deploy-key`,
`check-key`, `preview-key`, `access-token`, `tunnel-token` (terminal only), `state-passphrase`,
`monitoring`, `portainer`, `beszel`, and `recovery-key` (`--key-out <file>` for the new age key;
never read that file).

**The user's own tokens** (`hetzner`, `digitalocean`, `cloudflare`, `github`,
`cloudflare-deploy`, `ghcr`, `ntfy`): OpsCrew never makes them. The user makes the new token at
the provider and sets it in its variable, then runs `npx opscrew rotate <name>`. OpsCrew checks it,
replaces every copy it made and names the page where the user deletes the old one.

After a rotation OpsCrew records its date in `opscrew/credentials.yaml` (names and dates only) and
refreshes the recovery copy, both in the deploy pull request.

## When a rotation stops

Pass on what the error says. Running the same command again goes on from where it stopped. For
services, app secrets and device logins, `--undo` puts the old values back until they begin to be
dropped. The add-ons (`monitoring`, `beszel`) only go forward. Until the rotation completes,
the old values stay on the user's computer and the servers keep the old env files as `.previous`.
Earlier values a snapshot still needs stay in the generated values on the user's computer and,
encrypted, in the recovery copy (`history`).

A rotation is refused while a deploy, a move or a snapshot runs. On another computer, provision
stops when its values are older than the record and says to run `npx opscrew secrets restore`.

The user's guide is `docs/guide/credential-rotation.md` in the OpsCrew repository.
