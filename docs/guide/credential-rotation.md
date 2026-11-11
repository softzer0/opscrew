# Rotating your app's credentials

OpsCrew makes the passwords, keys and tokens your app runs on: each database's password, the app's
own secrets, the deploy key, the private network's keys and more. It also copies them where they
are needed: the env files on your servers, [GitHub](https://github.com/) secrets, your
[Portainer](https://www.portainer.io/) stack, the [recovery copy](secrets-recovery.md).

When one may have leaked (a laptop lost, a log shared, a teammate gone), or simply when it is old,
`npx opscrew rotate` replaces it everywhere OpsCrew put it, in the right order and without breaking
the running app. Neither the old nor the new value is ever shown.

## See what can be rotated

```bash
npx opscrew rotate                  # prod, or the only environment
npx opscrew rotate --env staging    # another environment
npx opscrew rotate --json           # the same, as JSON
```

The list names every credential OpsCrew made for the environment by the name the command takes.
For each it says how it rotates, when it was made or last rotated, and what else changes. A
credential made before OpsCrew kept dates counts from the environment's first deploy. Then come
your own tokens (the Hetzner, DigitalOcean, Contabo, Cloudflare and GitHub tokens, and the others
you gave OpsCrew) with their expiry where the provider shows it, else the date this computer first
saw them. Listing reads only: it changes nothing and records nothing.

## Rotating one

```bash
npx opscrew rotate db               # the service db
npx opscrew rotate db cache         # two services, in one plan
```

Each rotation is a plan. OpsCrew shows every credential it changes, how long anything is
affected, and each step in order. You approve the plan by its hash. In a terminal OpsCrew asks;
in a script, run the command once to see the plan and its hash, then again with
`--approve <hash>`. Several services and the app's own secrets rotate together in one plan
(`npx opscrew rotate db app`); every other credential rotates on its own.

When it is done, OpsCrew records the date in `opscrew/credentials.yaml` (names and dates, never a
value) and refreshes the recovery copy. Both go into the deploy pull request. In a script, add
`--yes` to push them and open the pull request; `--yes` approves nothing else, never the rotation
itself. For an app on this computer that GitHub doesn't deploy, OpsCrew writes them and asks you
to commit them.

While a deploy, a move or a snapshot runs, a rotation is refused, and they refuse a rotation in
turn. On servers and in your Portainer, a rotation of services pauses the app's deploys in GitHub
until it ends; on this computer it holds the app's deploys there.

`npx opscrew rotate --all`, after a leak, rotates every service and the app's own secrets in one
plan, each as it rotates alone; you type the app's name once for those that log users out. Then
it lists the other credentials, to rotate one by one.

## What each name rotates

### Services

Each service by its name in the plan (`db`, `cache`, `search`) rotates all of its generated
secrets. How depends on the service:

| How it rotates | Services | What you notice |
|---|---|---|
| Seamless | MySQL, Valkey, Redis, Dragonfly, Garage's access key | Nothing. The old and the new value both work until the app runs on the new one, then the old one is dropped. Garage restarts for about 2 seconds. |
| A short swap | PostgreSQL, MariaDB, MongoDB, Neo4j, RabbitMQ, Kafka, Redpanda, OpenSearch, Elasticsearch, ClickHouse, NATS | The service takes the new value first. Until the app runs on it (its rolling switch, about 30 seconds), new connections the running app opens fail; connections already open stay. NATS's change also closes the open ones, and the app's clients reconnect. |
| A restart | Meilisearch's master key, Typesense's start key, Garage's RPC secret | The service starts again with the new value (about 5 seconds for Meilisearch, 10 for Typesense, 2 for Garage) and answers no one meanwhile. A new Meilisearch master key also changes every API key made from it. |

The order is always the same:

1. where the app deploys from GitHub, its deploys pause and GitHub's secrets take the new values
   first, so no deploy can bring the old ones back;
2. the service's own change while it runs;
3. the new env files (or the Portainer stack);
4. the app's switch to them, with the image that runs (nothing is built or pulled);
5. the old value dropped, where both were valid.

The app's own address variables, such as `DATABASE_URL`, follow. A service on another server gets
its change there, and the app's server the new address. A service that is off changes only in
OpsCrew's files and starts with the new value.

This works on a cloud server, on a server you own, in your Portainer (through its Docker API and
the stack plan) and on this computer (through Docker).

In your Portainer, the stack holds every service's values, so the stack plan's apply creates each
service of the stack again, seamless ones included: each restarts with its new value and closes
its open connections, and the app with them. The site can fail requests meanwhile, for about as
long as the plan says, usually half a minute.

Kafka and Redpanda without their login have nothing to rotate; the list says so.

### The app's own secrets

`app` rotates every secret OpsCrew generated for the app; `app:<NAME>` only that one, for example
`app:SECRET_KEY_BASE`. Secrets you set yourself are yours to change.

- **Laravel's `APP_KEY`** rotates without logging anyone out. The new key becomes current and the
  old one stays as the previous one, in `APP_PREVIOUS_KEYS`. Sessions and encrypted data stay
  readable.
- **Better Auth's secret** keeps what it encrypted readable, but logs every user out: Better Auth
  checks sessions with its current secret only. The new secret becomes current in
  `BETTER_AUTH_SECRETS`. The old one stays there, and `BETTER_AUTH_SECRET` keeps its value, both
  only to decrypt what was encrypted before, such as two-factor secrets and OAuth tokens. The plan
  says users are logged out, and you type the app's name, as below.
- **The previous value stays until you drop it**, because data encrypted with it may remain: the
  app encrypts again only what it writes again. When nothing encrypted with the old key is left,
  drop it with `npx opscrew rotate app --drop-previous`. For Better Auth, `BETTER_AUTH_SECRET`
  then takes the current secret too. What is still encrypted with the old key can't be read
  afterwards, so the plan says so and you type the app's name, as below.
- **Every other app secret logs your users out**, or makes the tokens the app issued stop
  working. Examples are Rails's `SECRET_KEY_BASE`, Django's and Flask's `SECRET_KEY`, Auth.js's
  `AUTH_SECRET`, NextAuth's `NEXTAUTH_SECRET`, `SESSION_SECRET`, `JWT_SECRET` and
  `COOKIE_SECRET`. The plan says so first, and you type the app's name to go ahead. In a script,
  give `--confirm <app>` with `--approve <hash>`. With `app`, you type it once for all of them.
- **`CRON_SECRET`** changes for the app and its cron jobs in one switch, with no confirmation.
- **On a server, in your Portainer and on this computer**, the app switches to the new values as
  a services' rotation does. **A site on [Cloudflare's hosting](cloudflare-hosting.md) or
  [GitHub Pages](github-pages.md)** gets them through its GitHub secrets and a deploy, which
  OpsCrew starts and follows to its end.

### SSH keys

| Name | What it opens |
|---|---|
| `deploy-key` | Every server of the environment, for the deploys. |
| `check-key` | The servers the [scheduled check](alerts.md) reads over SSH. |
| `preview-key` | The [preview](previews.md) server. |

A new pair is made on this computer, and its public half is added on every server it opens,
beside the old one. GitHub's secret is replaced. Then the new key proves itself: a deploy, a
check run or the preview server's check. Only after that is the old half removed. Nothing is down
meanwhile.

On a server you own, the deploy key changes through the server's setup host plan: one with both
keys, then one with the new key alone, each shown and approved by its hash.

On a cloud server, `deploy-key` ends with an infrastructure plan that replaces the provider's copy
of the key, which only servers created from then on get. It replaces a resource, so you type the
app's name. In a script, the refused run saves that plan and prints its hash. Run the same command
again with that hash added to its `--approve` hashes and `--confirm <app>`, and it applies the
saved plan. The Access token and the state passphrase work the same way.

The preview key is in the recovery copy too.

### The private network, devices and their logins

| Name | What changes |
|---|---|
| `network` | Each server gets a new WireGuard key, and the others take it in one change (a new handshake, a few seconds). The plan names every device whose configuration must change. OpsCrew writes each one's new configuration, and the old ones work until then. |
| `device:<name>` | That device gets a new key pair and configuration; its old configuration stops working. |
| `grant:<device>/<service>` | That device's own login to a database or cache gets a new password, shown once. The old one stops working at once, or for Valkey, Redis and Dragonfly after the app's switch. |

Import each new configuration as after `npx opscrew vpn add`. With `--qr`, OpsCrew also draws
each one as a QR code for the WireGuard app on a phone. It holds the device's private key, so
clear the terminal once it is scanned. See [Your devices on the private network](private-network.md).

### Cloudflare's tokens

| Name | What changes |
|---|---|
| `access-token` | The [Cloudflare](https://www.cloudflare.com/) Access service token the deploy reaches your server (or Portainer's webhook) through. An infrastructure plan replaces it, approved by its hash with the app's name typed (in a script, `--confirm <app>` with `--approve <hash>`). Then the deploy's GitHub secrets follow, with deploys paused. |
| `tunnel-token` | The Cloudflare Tunnel's token. Cloudflare takes a new secret in place, and the running connectors stay connected. Then each connector restarts with the new token: with one connector, what the tunnel serves pauses for a few seconds; with two, not at all. |

### The state passphrase

`state-passphrase` is the passphrase that encrypts the infrastructure state. OpenTofu reads every
state it encrypts with the old passphrase as the fallback, then writes it with the new one, in one
approved apply per state. Nothing in the cloud changes. The new passphrase replaces the old one
once every state opens with it alone.

In a script, each state's plan is saved when its approval is refused, and the next run applies it
when you add its hash: `--approve <hash>`. Until then the new passphrase waits on this computer,
and the commands that read the states stop. Run the rotation again with the hash to go on, or
`npx opscrew rotate state-passphrase --undo` to step back. The undo works only while no state has
been written with the new passphrase yet.

### Add-ons

| Name | What changes |
|---|---|
| `monitoring` | Grafana's admin password, and the [monitoring](monitoring.md)'s login to PostgreSQL. Each goes through the monitoring's host plans, approved by their hashes. Shared monitoring is rotated from the environment that runs it. |
| `portainer` | The admin password of the Portainer OpsCrew installed, through Portainer's own API. |
| `beszel` | [Beszel](beszel.md)'s dashboard password, its agent's token and the hub's key, in hub mode. The hub and the agent restart with them, so Beszel shows no new figures for a few seconds. |

Sign in with the new passwords afterwards; OpsCrew keeps them where it kept the old ones.

### The recovery key

```bash
npx opscrew rotate recovery-key --key-out ~/opscrew-shop-age-key-2.txt
```

A new age key for the recovery copy, written only to that file. [A new key](secrets-recovery.md#a-new-key)
has the rest, including the backup key's options.

### Your own tokens

| Name | Read from |
|---|---|
| `hetzner` | `HCLOUD_TOKEN` |
| `digitalocean` | `DIGITALOCEAN_TOKEN` |
| `contabo` | `CNTB_OAUTH2_CLIENT_ID`, `CNTB_OAUTH2_CLIENT_SECRET`, `CNTB_OAUTH2_USER` and `CNTB_OAUTH2_PASS`, all four |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` |
| `github` | `GITHUB_TOKEN` or `GH_TOKEN` |
| `cloudflare-deploy` | `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN` |
| `ghcr` | `OPSCREW_GHCR_READ_TOKEN` |
| `ntfy` | `OPSCREW_CHECK_NTFY_TOKEN` |

OpsCrew never makes these. Make the new token at the provider, set it in its variable, then run
`npx opscrew rotate <name>`. OpsCrew checks that the token has the permissions it needs. Then it
replaces every copy it made (GitHub secrets, Portainer's registry entry), records the date and
names the page where you delete the old token.

## When a rotation stops

If a step fails, OpsCrew stops, says which step and what it changed, and keeps the old values on
this computer:

- run the same command again, and it goes on from where it stopped;
- or, for services, app secrets and device logins, add `--undo` to put the old values back. That
  works until the old values begin to be dropped; from then on the rotation only goes forward. The
  state passphrase's `--undo` works until the first state is written with the new one.

The app's deploys stay paused (or held, on this computer) until the rotation or its undo is run
to its end. While a rotation holds the app, a snapshot you take is refused and a scheduled one is
skipped, with a line in its log.

## Where the old values live until it's done

Until a rotation completes, the old values stay only here:

- **On this computer**, beside the generated values in OpsCrew's folder for the project
  (`~/.opscrew/projects/<project>/`): the unfinished rotation's old and new values
  (`pending_rotation.json`), the new state passphrase (`state_passphrase.next`), Portainer's new
  password (`portainer_password.next`), and an SSH key's new pair (`<key>.next`) and then its old
  public half (`<key>.previous.pub`). Each file is readable only by you.
- **On each server**, the app's folder keeps the old env files as `.previous` until the rotation
  is done.

Nothing else holds an unfinished rotation's old values: not GitHub or the record. When the
rotation completes, the new values become the current ones and those files are removed.

Earlier values that a snapshot taken before a rotation still needs are kept in the generated
values on this computer (readable only by you) and, encrypted, in the recovery copy (`history`),
so a restore of that snapshot can log in with them.

## Values never on a command line

Values reach your servers only over SSH's standard input, in env files, in GitHub secrets and in
the Portainer stack, never on a command line on this computer or in a workflow.

On the server, a few tools take the value only as an argument: MongoDB's login, RabbitMQ's
`rabbitmqctl change_password`, Kafka's `kafka-configs --add-config`, Redpanda's
`rpk … --new-password` and Neo4j's `cypher-shell -p`. MySQL and MariaDB read theirs from
standard input. For the second those tools run, the value is on their
command line inside the service's container. Root on the server can read the env files anyway;
other local users of a server you own could see it in the process list for that second.

## Two computers

The record of each rotation is committed, with no values. When you provision from another
computer whose generated values are older than the record, OpsCrew stops before changing anything
and says to run `npx opscrew secrets restore` first.

## Restoring a snapshot taken before a rotation

Database dumps and cache copies hold no passwords, so they restore as they are.

Two kinds of snapshot do hold the old passwords:
- a copy of a service taken by stopping it (RabbitMQ, Neo4j, Kafka, Redpanda, OpenSearch,
  Elasticsearch, Garage);
- a [whole-server snapshot](snapshots.md).

When [`npx opscrew restore`](snapshots.md) puts one of these back, OpsCrew sets the current
passwords on each such service again, after waiting until it accepts logins. Then the app reaches
it.

A rollback doesn't offer such a copy. It says to roll back with `--database keep`, then restore.

## Old credentials

[`npx opscrew advise`](advise.md) lists every credential older than a year with the command that
rotates it. Set another age in the plan with `credentials.maxAgeDays` (30 to 3650). With
`check.credentials: true` in the plan, the [scheduled check](alerts.md) also opens an issue for
an old credential. The token-expiry warnings, 30 and 7 days before, stay as they are.

## From Claude Code

The `opscrew_credentials` tool of the [plugin](claude-code-plugin.md) lists what
`npx opscrew rotate` lists and changes nothing. Rotating stays a command you run in your terminal.

## Known limits

- **Add-on rotations only go forward.** `monitoring` and `beszel` have no `--undo`: run the
  command again to finish one that stopped. `--undo` only forgets one you never approved.
- **After a retarget**, onto a server or this computer, a service rotated before the move counts
  as its first generation until its next rotation. A rollback that restores such a service's data
  by stopping it can then not set its password again: put that data back with
  `npx opscrew restore` instead.
- **The Cloudflare Tunnel token rotates only in a terminal.** Each of its approvals is of a plan
  made from the step before, so a script can't name the hashes ahead. It takes no `--approve`.
- **Previews** make their own values on the preview server; a new preview gets new ones. Only the
  preview key is OpsCrew's to rotate.
- **MongoDB's replica-set key file and OpenSearch's transport key are not rotated.** Each is made
  on the server by the service itself and used only inside it. OpenSearch makes a new one whenever
  its container is created again.
