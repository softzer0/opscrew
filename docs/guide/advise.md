# Advice on size, cost and upkeep: `opscrew advise`

Once your app runs, `opscrew advise` answers "is it the right size?", "can it cost less?" and "is
anything about to break?". It reads your environment, then lists what it would change and why, the
most urgent first, each with its figures, the monthly price before and after, and how to apply it:

```bash
npx opscrew advise
```

It only reads. It changes nothing on any server, account or repository, and nothing in your files.
Applying a proposal is a separate step that you start, and every change to a server still goes
through `opscrew provision` and your approval (see [Applying a proposal](#applying-a-proposal)).

## What it reads

- **Each server,** as [`opscrew status`](logs-and-status.md#the-figures-in-opscrew-status) reads it:
  the load against the CPUs, the memory and the disk in use, and each container's memory against its
  limit and its restarts.
- **14 days of history,** when [self-hosted monitoring](monitoring.md) is on: each server's CPU and
  memory at the 95th percentile, how long the load stayed above the CPUs, how fast the disk fills,
  and each container's memory, restarts and stops for lack of memory. It reads them with fixed,
  read-only queries on the monitoring server.
- **Your plan and the interview's answers:** what runs where, the budget you gave, the region, and
  how much the app's data matters.
- **The providers' prices,** live from [Hetzner](https://www.hetzner.com/)'s and [DigitalOcean](https://www.digitalocean.com/)'s price lists when their tokens
  can read them, otherwise OpsCrew's dated list, and it says so with the date. [Contabo](https://contabo.com/)
  has no price API, so its prices always come from OpsCrew's dated list.
- **[GitHub](https://github.com/):** the repository's [Dependabot](https://docs.github.com/en/code-security/dependabot) alerts and Dependabot's open pull requests, the
  [scheduled check](alerts.md)'s issues of the last 14 days when the check is on, and when your
  GitHub token expires.
- **[Cloudflare](https://www.cloudflare.com/):** when your Cloudflare token expires, when it has an expiry date.
- **[`secure`](security.md)'s host checks** on each server it reaches over SSH: pending security
  updates, a required reboot, and any check that fails.

Every command it runs on a server is fixed and read-only, and written to OpsCrew's audit log
without the server's address. What it couldn't read (a server that didn't answer, a missing
permission) is listed at the end with the reason; the rest of the advice still comes.

## History or one reading

Without monitoring, advise sees one moment: the figures as they are while it runs. A busy minute
and a quiet one look very different, so it is careful with them:

- **It never proposes a smaller server on one reading,** or with fewer than 7 days of history.
- **It still proposes a larger server, a higher memory limit or a fix for the disk** on one reading,
  since waiting costs more than checking.
- Each figure says what it rests on: 14 days (or as many as there are), or one reading.

For servers OpsCrew created on Hetzner Cloud or DigitalOcean without monitoring, a report on one
reading ends with a line suggesting self-hosted monitoring, whose history advise uses from the
first day:

```bash
npx opscrew addon enable monitoring
npx opscrew provision
```

## What it proposes

Each proposal has an id such as `size.app.larger`: the kind, the server (`app` for the app's
server, or an extra server's name, `env` for the whole environment) and what it is about. The id
stays the same from one run to the next.

### Size

| Proposal | When |
|---|---|
| **A higher memory limit** for a container | Its memory reached 95% of its limit, or the system stopped it for lack of memory, in the 14 days (on one reading: its memory now at 95% of its limit). The new limit is 1.5 times the current one, rounded up to 64 MB, when the server's memory in use plus the raise stays at or under 85% |
| **A larger server** | Its memory in use is above 85% (at the 95th percentile with history), or the 15-minute load was above its CPUs for 25% of the time or more (on one reading: the load now above its CPUs), or a container at its limit has no room for a higher one. The type proposed is the cheapest where the server runs that holds the memory under 85%, with the CPUs it needs |
| **A smaller server** | With at least 7 days of history only, and only when nothing else is proposed for the server: the next cheaper type that keeps the CPU and memory at the 95th percentile at or under 60% of it (40% to spare), still holds the memory limits of the containers OpsCrew gives the server, and has at least the current disk |
| **The disk** | The disk is 85% full or more, or at the pace of the last 7 days it is full within 30 days. A type with a larger disk that brings it under 85%, or, when there is none or the server is your own, freeing space with `docker image prune` |

When a server needs both more memory or CPUs and a larger disk, one type covers both. On a server
OpsCrew can't resize (the largest type at its location, or one it
[doesn't change the hardware of](#what-it-doesnt-do)), a server short of memory or CPUs still gets
a proposal: what it needs, without a price, and what to do yourself.

### Cost

| Proposal | When |
|---|---|
| **Over budget** | The servers OpsCrew created cost more a month than the budget you gave in the interview. It names the other proposals that each bring them under it, or suggests `opscrew design` when none does |
| **A cheaper type** | Where the server runs, a type with at least its CPUs, memory and disk costs less |
| **Another provider** | A server with at least the vCPUs, memory and disk of yours costs less at another provider in your region. It names [`opscrew retarget`](retarget.md), which moves an app on one server with a short maintenance window. It is proposed only when the saving holds whatever VAT you pay, is at least 10% of the current server's monthly price, and pays any setup fee back within 3 months |

Prices are monthly, with the server's IPv4 address and backups when they are on. Each price says
whether it includes VAT (Contabo's prices do, Hetzner's and DigitalOcean's don't) and gives its
date: live, or the date of OpsCrew's price list. OpsCrew doesn't know your VAT rate, so a saving
counts, here and toward the budget, only when it holds whatever VAT you pay: moving off a price
that includes VAT, the new price is compared with 27% VAT on top, the highest standard rate in the
EU.

A move to another provider compares both servers with the same data protection: where the new
provider offers no automated backups, the current server is priced without them too, and OpsCrew's
[data snapshots](snapshots.md) take their place. Its text also names the new provider's terms where
it has them: a one-time setup fee, a minimum term with a removal that ends only at the end of it,
no change of size in place, and no automated backups from the provider.

Moving off a provider with terms, the old server is billed to the end of its term, so the saving
starts after it, and `opscrew retarget --finish` cancels the old server rather than deleting it.
The new server's automated backups are priced in when the interview says your data matters.

### Reliability

| Proposal | When |
|---|---|
| **Backups** | A server without automated backups while the interview says the app's data is important or critical |
| **The scheduled check** | The [scheduled check](alerts.md) is off for prod. It adds no server cost |
| **A flapping check** | The scheduled check opened its issue 3 times or more in 14 days: the app keeps failing and recovering. It suggests reading the logs around those dates |
| **A restart loop** | A container restarted 3 times or more in 14 days (deploys don't count, as each starts a new container); on one reading, since it was last deployed |

### Upkeep and security

| Proposal | When |
|---|---|
| **Dependabot alerts** | The repository has open Dependabot alerts: how many by severity, the packages, and Dependabot's open pull requests |
| **Dependabot alerts are off** | GitHub has them off for the repository, its default for a private one: turn them on in the repository's Settings, Code security |
| **A reboot** | A server installed security updates that need a reboot |
| **Security updates** | Security updates are waiting on a server |
| **Failing host checks** | One of `secure`'s host checks fails on a server, most severe first |
| **A token expiring** | Your GitHub or Cloudflare token expires within 30 days: make a new one with the same permissions |

### Components

| Proposal | When |
|---|---|
| **A server of its own for [Postgres](https://www.postgresql.org/)** | With history, the app's server's memory is above 85% at the 95th percentile and Postgres uses more than 50% of it: an alternative to a larger server, [split placement](split-placement.md), priced |
| **Object storage** | The disk is filling (as above) while [Garage](https://garagehq.deuxfleurs.fr/) keeps the app's files on the server: the cheapest [object storage](object-storage.md) that keeps them off it, priced |

## How urgent

| Urgency | What it holds |
|---|---|
| **Now** | About to break: a container at its memory limit, a disk full within 7 days, a required reboot, a token expiring within 7 days, a move in progress |
| **Soon** | A server short of memory or CPUs, a filling disk, security findings, the alerts off, over budget, a flapping check, a restart loop, a token expiring within 30 days |
| **When convenient** | Savings, backups, the scheduled check, Postgres on its own server |

Within an urgency, the size of a server comes first, then security, upkeep, cost, reliability and
components.

While a move to another provider ([`opscrew retarget`](retarget.md)) or a move between the app's
servers is in progress, advise lists it first, with how to finish it, and proposes nothing that
changes the servers or the plan until it is done.

## Applying a proposal

```bash
npx opscrew advise --apply size.app.larger
npx opscrew provision
```

`--apply` reads everything again first, so it refuses an id that no longer stands (the figures may
have changed) and lists the current ones. Then:

- **A server's type, a container's memory limit, backups or the scheduled check:** it writes that
  one field of `opscrew/plan.yaml`, and only that, and prints the change and the new monthly price.
  Nothing else changes yet. `npx opscrew provision` then shows the change and applies it once you
  approve its hash, as for every change.
- **Anything else:** it prints the command to run (such as [`opscrew retarget`](retarget.md) or
  `opscrew secure`), or what to do yourself (such as turning Dependabot alerts on).

A proposal already written to the plan but not provisioned yet says so, and names
`opscrew provision`.

### Changing a server's type

- **The app is offline while the server changes type:** one to three minutes at Hetzner, while it
  restarts on its new type; at DigitalOcean about a minute per GB of disk in use, often less. Its
  addresses stay the same.
- **The disk grows with the type, and neither provider makes it smaller again.** So once a server
  is larger, it can't go back to its previous type. Advise says so in the proposal.
- **A smaller server is rare at Hetzner:** within a line of types each smaller one has a smaller
  disk, and a type with the same disk in another line costs more. The usual saving is a cheaper type
  with at least the same CPUs, memory and disk, which the cost proposals find.
- **`opscrew provision` refuses a type with a smaller disk than the server has,** before any change,
  even in a plan edited by hand: at Hetzner such a change would switch the server off and leave it
  off.

## Options

| Flag | What it does |
|---|---|
| `--apply <id>` | Applies one proposal, as [above](#applying-a-proposal) |
| `--json` | Prints the proposals as JSON, with each one's figures, prices and how to apply it, what was read and what couldn't be (not with `--apply`) |
| `--app <key>`, `--env <name>` | Another [app](several-apps.md) or [environment](environments.md), as every command takes them |

## The permissions it uses

Advise uses the tokens you already gave OpsCrew, and only reads with them:

- **The GitHub token:** "Dependabot alerts: Read", optional, for the alerts. Without it, advise
  says the token lacks "Dependabot alerts: Read" under what it couldn't read, and the rest of the
  advice still comes. Add it to the token to have the alerts read (see
  [The GitHub token](security.md#the-github-token)). The scheduled check's issues need "Issues: Read",
  which the check already asks for.
- **The provider's token** reads the live prices; without one, the dated list is used. Contabo has
  no price API, so its dated list is always used.
- **The Cloudflare token** is only checked for its expiry date.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) gives [Claude](https://claude.com/) the same proposals through a read-only tool
when you ask "is it the right size?", "why is it slow?" or "can it cost less?". Applying stays in
your terminal (see [Applying a proposal](#applying-a-proposal)).

## What it doesn't do

- **Use a model:** every proposal comes from fixed rules and the thresholds on this page.
- **Read history from [Grafana Cloud](grafana-cloud.md) or [Beszel](beszel.md):** only from
  [self-hosted monitoring](monitoring.md). With those, advise works on one reading.
- **Grow a disk with a block volume:** a larger disk comes with a larger type.
- **Resize or price [a server you own](own-server.md), [a Portainer](portainer-target.md) or
  [your computer](localhost.md):** OpsCrew doesn't change their hardware. On
  [Cloudflare's hosting](cloudflare-hosting.md) and [GitHub Pages](github-pages.md), with no server, it gives only
  the upkeep and security proposals.
