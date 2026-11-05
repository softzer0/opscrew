# Moving your app to another cloud provider: `opscrew retarget`

`opscrew retarget` moves a live app from Hetzner Cloud to DigitalOcean, or the other way round, with
its database. The new server is built next to the old one, the app is deployed and checked there,
the database is copied in a short maintenance window, and then your DNS records switch to the new
server. The old server stays until you say the new one is good.

```bash
npx opscrew retarget --to digitalocean   # start the move, or continue it after a stop
npx opscrew retarget --finish            # after the switch: delete the old server
npx opscrew retarget --abort             # before the switch: back to the old server
```

`--to hetzner` or `--to digitalocean` names the provider; without `--to`, the provider from your
interview is used. Moves run only in your terminal; in Claude Code, `opscrew_status` shows where a
move stands.

It moves apps only between cloud providers: not to or from
[a server you already have](own-server.md), [a Portainer](portainer-target.md),
[your own computer](localhost.md), [Cloudflare's hosting](cloudflare-hosting.md) or
[GitHub Pages](github-pages.md). For those, remove the app with `npx opscrew destroy`, then run
`interview`, `design` and `provision` for the new target. `destroy` deletes the server and the data
on it (it offers a snapshot first), so copy your database first and restore it on the new target
(see [Backups](databases.md#backups)). A move within one provider (another location or another size)
isn't possible either; for another size, see
[Advice on size, cost and upkeep](advise.md#applying-a-proposal).

Like every command, it takes `--app <key>` and `--env <name>` for [another app](several-apps.md) or
[environment](environments.md).

## Before you move

- **Both providers' tokens:** `HCLOUD_TOKEN` and `DIGITALOCEAN_TOKEN`, plus your GitHub token, and
  `CLOUDFLARE_API_TOKEN` when your domain's DNS is on Cloudflare. A missing or rejected token stops
  the move before anything changes.
- **This computer:** run the move on the computer that deployed the app: it has the infrastructure
  state and the server's SSH key, and the database copy passes through it.
- **The data:** only a PostgreSQL database is copied. Check that the app has nothing that
  [can't move yet](#what-cant-move-yet).
- **A Valkey queue:** Valkey starts empty on the new server. Let a queue drain before the move, or
  the jobs waiting in it are lost.
- **Your DNS, if it isn't on Cloudflare:** lower the TTL of the app's records (for example to 60
  seconds) beforehand, so the switch reaches your visitors quickly (see
  [Without DNS on Cloudflare](#without-dns-on-cloudflare)).
- **The cost:** both servers run, and are billed, until you finish the move. The summary shows the
  new server's monthly price before anything changes.

## How a move works

```bash
npx opscrew retarget --to digitalocean
```

OpsCrew first offers the new provider's servers for the region and budget from your interview, as
`opscrew design` does, and you pick one. It then shows a summary: each step, the extra monthly cost
while both servers run, the database's size and the expected maintenance window. Nothing changes
until you continue. Then:

1. **The current server is renamed** in OpsCrew's infrastructure state, so both servers fit in it.
   Nothing changes in your cloud.
2. **The new server is created** next to the old one. OpsCrew waits for it and records its SSH host
   key.
3. **The app is deployed there:** the GitHub deploy secrets point to the new server, the deploy
   workflow runs, and OpsCrew checks over SSH that the app answers. Your visitors are still served
   by the old server. Until you finish or abort the move, a push to your branch deploys to the new
   server only, so hold changes until the switch.
4. **The maintenance window** copies the database (see below).
5. **DNS switches** to the new server, and OpsCrew checks the app through its domain. The old server
   stays, with its app stopped, until you [finish the move](#finishing-the-move).

Each infrastructure plan is shown first and applied only once you approve its exact hash, as with
`opscrew provision`. Storing the new deploy secrets and starting the maintenance window each ask for
your approval too.

If the new server needs a different image builder or deploy strategy (for example an Arm server),
the summary says so, and the move uses it.

## The maintenance window

With a PostgreSQL database on the server, the copy needs a short downtime: OpsCrew stops the app on
the old server, dumps the database there, copies the dump to the new server through this computer
(over SSH), restores it, runs your release command on it when the app has one, starts the app there
and checks it. The summary gives the expected time: about two minutes plus one per 100 MB of
database, so a fast connection on this computer helps. The approval lists the commands it runs, and
the dump files are deleted afterwards.

If the copy, the restore or the new app's check fails, OpsCrew starts the app on the old server
again and stops: your visitors are served by the old server, and the next run repeats the window. If
the DNS switch fails, the same happens.

During the window OpsCrew pauses the [scheduled check](alerts.md) for the environment, after its own
approval, so it opens no issue while the app is offline. Finishing or aborting the move resumes it.

Without a database on the server (none, or one hosted elsewhere), there is no window: the old server
serves until the switch.

## Without DNS on Cloudflare

When OpsCrew doesn't manage your DNS, it shows the records to change (or, without a domain, the new
server's address). Your confirmation is the switch: confirm only once you made the change, since
after it the move can't be aborted. OpsCrew then waits up to 5 minutes for your domain to point only
to the new server before checking the app; if it doesn't yet, run `npx opscrew retarget` again later
to check.

With a database to copy, the app on the old server stays stopped from the copy until your change has
reached your visitors, so the downtime is the copy plus your DNS change. That is why a low TTL
matters.

## Finishing the move

Once the app runs on the new server and you are happy with it:

```bash
npx opscrew retarget --finish
```

OpsCrew first checks that the app answers on the new server through its URL; otherwise it keeps the
old server. Then it lists only the old server's resources and asks you to type the app's name. It
takes a snapshot of the old server first when the database or backups lived there (`--snapshot` or
`--no-snapshot` to choose), deletes the old server, forgets its host key, and opens a pull request
with the final infrastructure files: merge it, so the repository describes the new deployment. The
snapshot is billed until you delete it in the provider's console. The move is then done, and
`opscrew provision` and the other commands work as usual.

## Aborting the move

Until DNS switches, you can go back:

```bash
npx opscrew retarget --abort
```

OpsCrew starts the app on the old server again if it was stopped, deletes the new server (after you
type the app's name), points the deploy secrets back to the old server and restores your plan as it
was. Once you have typed the name, the move can only be aborted, not continued.

After the switch, `--abort` refuses: finish the move, then move back with
`npx opscrew retarget --to <the previous provider>`.

## When a move stops

A move remembers each step in `opscrew/plan.yaml`. If it stops, because a step failed, you declined
an approval or the terminal closed, run `npx opscrew retarget` again: it continues from the last
completed step. If it stopped during the maintenance window before the copy was complete, it first
starts the app on the old server again.

If it stops after the copy, before the switch, the app stays offline: its data is already on the new
server. Run `npx opscrew retarget` soon to continue, or `npx opscrew retarget --abort` to start the
old app again. Don't start the app on the old server yourself, or what it saves won't reach the new
server.

While a move is in progress, `opscrew provision`, `design`, `dns`, `drift`, `destroy`, `rollback`,
`domain buy`, `domain connect` and the add-on commands stop and say how to continue, finish or abort
it. `opscrew status` shows where the move stands and the next command.

## In scripts

A run without a terminal stops at each infrastructure plan, prints its hash and the command to
continue with `--approve <hash>`. The other approvals take flags:

| Flag | What it does |
|---|---|
| `--option <id>` | The new server to move to (the run lists the ids); without it, a script takes the recommended one |
| `--approve <hash>` | Applies exactly the saved plan with this hash and continues |
| `--allow-downtime` | Allows the maintenance window |
| `--dns-switched` | You changed the DNS records (or the address) to the new server yourself |
| `--yes` | Approves storing the GitHub deploy secrets, pausing the scheduled check, the push and the pull request |
| `--confirm <app name>` | With `--finish` or `--abort`, instead of typing the name |
| `--engine <name>` | `tofu` or `terraform` |

Without DNS on Cloudflare, pass `--allow-downtime --dns-switched` together only when the records are
ready to change right after the copy: with `--allow-downtime` alone, the run stops after the copy,
with the app offline, until you change them and run `npx opscrew retarget --dns-switched`.

## What can't move yet

`opscrew retarget` stops before any change, and says why, for an app with:

- **Data other than PostgreSQL:** MySQL, MariaDB, MongoDB, Redis 8, Dragonfly, Neo4j, a broker, a
  search or analytics engine, Garage or a SQLite database. Valkey and the
  [workers and cron jobs](workers-and-cron.md) move with the app. A bucket at a provider stays where
  it is, and the app on the new server uses it (OpsCrew asks for its key if this computer doesn't
  have it).
- **[Services on servers of their own](split-placement.md):** place them back on the app's server
  first.
- **[Self-hosted monitoring](monitoring.md) on:** turn it off with
  `npx opscrew addon disable monitoring` and `npx opscrew provision`, move, then turn it on again.
- **[Public SSH](public-ssh.md) closed:** the new server is reached over public SSH before it joins
  the private network. Open it with `npx opscrew secure --open-public-ssh`, move, then close it
  again.
