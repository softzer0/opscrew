# Deploy to DigitalOcean

OpsCrew can create your app's server at [DigitalOcean](https://www.digitalocean.com/), a Droplet
on your own account, as it does at [Hetzner Cloud](hetzner.md) and [Contabo](contabo.md). You get a
hardened server, the app deployed from [GitHub](https://github.com/) with TLS, health checks and
rollback, and the `verify`, `secure` and `drift` checks.

## When to choose DigitalOcean

- **Your account is already there,** or your team's.
- **No contract:** a Droplet has no minimum term, and `npx opscrew destroy` deletes it at once (see
  [Removing the app](#removing-the-app)).
- **Resized in place:** a larger size keeps the Droplet, its data and its addresses (see
  [Changing the size](#changing-the-size)).
- **DigitalOcean's backups:** a daily copy of the whole Droplet, each kept four weeks (see
  [Backups](#backups)).
- **Prices in USD, before tax,** with the IPv4 address included, and data centres in Germany, the
  Netherlands, the US and Singapore.

To compare, see [Deploy to Hetzner Cloud](hetzner.md) and [Deploy to Contabo](contabo.md). Once
your app runs, `npx opscrew advise` proposes a move when another provider has the same server for
less (see [Cost](advise.md#cost)).

## The token

OpsCrew needs one DigitalOcean personal access token with custom scopes. Create it at
<https://cloud.digitalocean.com/account/api/tokens>, in the team that should hold your Droplets,
and select only these scopes:

| For | Scopes |
|---|---|
| The account, regions, sizes and actions | `account:read`, `regions:read`, `sizes:read`, `actions:read` |
| Droplets | `droplet:create`, `droplet:read`, `droplet:update`, `droplet:delete` |
| SSH keys | `ssh_key:create`, `ssh_key:read`, `ssh_key:delete` |
| Firewalls | `firewall:create`, `firewall:read`, `firewall:update`, `firewall:delete` |
| Tags | `tag:create`, `tag:read`, `tag:delete` |
| Images and snapshots | `image:create`, `image:read`, `snapshot:read` |

Two more, `snapshot:delete` and `droplet:admin`, are needed only to delete or restore
[whole-server snapshots](snapshots.md#whole-server-snapshots).

```bash
export DIGITALOCEAN_TOKEN=…
```

- **OpsCrew reads `DIGITALOCEAN_TOKEN`,** else `DIGITALOCEAN_ACCESS_TOKEN`.
- **DigitalOcean can't say which scopes a token has,** so `npx opscrew init` reminds you of them.
  When DigitalOcean refuses a request later, `npx opscrew provision` names them again.
- **`npx opscrew init` checks the token and the account.** A locked account, or an email address
  not verified yet, stops it with what to do. It names your team, never your email address.
- **It stays on your computer.** OpsCrew, and OpenTofu or Terraform, read it from the variable.
  It is never written into a file, the infrastructure state, the server or GitHub, and OpsCrew
  masks it in every message, log, audit entry and report.
- **Keep it out of your app.** `npx opscrew scan` recognises a DigitalOcean token by its shape
  (`dop_v1_…`, `doo_v1_…` or `dor_v1_…`) in your app's files, and reports it as a critical
  finding.

## Step by step

1. `npx opscrew interview`: choose **DigitalOcean**. When `DIGITALOCEAN_TOKEN` is the only provider
   token set, DigitalOcean is the default answer. In scripts, put `provider: digitalocean` in your
   answers file.
2. `npx opscrew design` shows DigitalOcean's sizes in your region with their monthly price (see
   [Sizes and prices](#sizes-and-prices)), and whether DigitalOcean's backups are on, and why.
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan:
   - the Droplet, with Ubuntu 24.04, IPv6, DigitalOcean's monitoring and OpsCrew's first-boot
     hardening, tagged `opscrew-app:<app>` and `managed-by:opscrew`;
   - its SSH key, `<app>-deploy`;
   - a DigitalOcean cloud firewall, `<app>-firewall`: SSH from the networks you allow, the web ports
     (80 and 443, and UDP 443 for HTTP/3) on the Droplet that serves your site, ping, and WireGuard
     where it is used. Traffic out of the Droplet is allowed;
   - DigitalOcean's backups, when they are on (see [Backups](#backups)).
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` check the result. `drift`
   reports a change made in the DigitalOcean control panel, such as a firewall rule added;
   `npx opscrew provision` sets it back.

## Sizes and prices

With `DIGITALOCEAN_TOKEN` set, design reads DigitalOcean's sizes from its API, with the current
prices and the regions where each one is available now: the Basic sizes, with shared vCPUs and at
least 1 GB of memory, and the CPU-Optimized sizes, with dedicated vCPUs. Without the token, or when
it doesn't work or DigitalOcean's API doesn't answer, design uses OpsCrew's dated list of Basic
sizes instead and says so. Each price is then marked as an estimate with the list's date, and
availability isn't checked.

| Size | vCPU | Memory | Disk | USD a month, before tax |
|---|---|---|---|---|
| s-1vcpu-1gb | 1 | 1 GB | 25 GB | 6 |
| s-1vcpu-2gb | 1 | 2 GB | 50 GB | 12 |
| s-2vcpu-2gb | 2 | 2 GB | 60 GB | 18 |
| s-2vcpu-4gb | 2 | 4 GB | 80 GB | 24 |
| s-4vcpu-8gb | 4 | 8 GB | 160 GB | 48 |

- **The IPv4 address is included** in the Droplet's price.
- **The list's date:** 2026-10-12, from
  [DigitalOcean's Droplet pricing](https://www.digitalocean.com/pricing/droplets). Design shows the
  date next to each price from it, and says how old the list is once it is more than 180 days old.
- **The backup and snapshot rates are always published ones.** DigitalOcean's API doesn't return
  them, so OpsCrew uses the rates on DigitalOcean's pages, and an estimate with backups names that
  rate and its date even when the Droplet's price is live.

## Regions

| Your answer in the interview | DigitalOcean's regions |
|---|---|
| Central Europe | Frankfurt (fra1), then Amsterdam (ams3) |
| Northern Europe | Amsterdam (ams3): DigitalOcean has no data centre in northern Europe, and design says so |
| United States, east coast | New York (nyc3, then nyc1), then Atlanta (atl1) |
| United States, west coast | San Francisco (sfo3) |
| Southeast Asia (Singapore) | Singapore (sgp1) |

Design offers each size in the first of the region's data centres where DigitalOcean has it. When
DigitalOcean has no stock of a size in a region, or your account has reached its Droplet limit,
`npx opscrew provision` says so in plain English, with what to try next.

## Backups

DigitalOcean's automated backups copy the whole Droplet every day, at 04:00 UTC (control panel →
your Droplet → **Backups**).

- **On by default only in prod,** when you tell `npx opscrew interview` that losing the app's data
  would be anything but "Not a problem". They are off by default in dev, staging and previews; dev
  and staging rely on OpsCrew's own snapshot before each release. `target.backups` in an
  environment's plan decides over the default: `true` turns them on, `false` off. Design says
  which, and why.
- **Their price:** 30% of the Droplet's price, DigitalOcean's published rate for daily backups,
  dated 2026-10-12. It is a line of its own in design's estimate.
- **Each backup is kept four weeks,** also after the Droplet is deleted. You can delete them
  earlier in the control panel.
- **They copy a running Droplet.** For a copy of a database you can restore anywhere, see
  [Backups](databases.md#backups).

## Snapshots

```bash
npx opscrew snapshot --server        # DigitalOcean's snapshot of the whole Droplet
npx opscrew restore --server <id>    # rebuild the Droplet from it
```

- **USD 0.06 per GB a month,** before tax, from
  [DigitalOcean's snapshot pricing](https://docs.digitalocean.com/products/snapshots/details/pricing/),
  read on 2026-11-06. The summary shows the most it can cost before the snapshot is taken (see
  [Whole-server snapshots](snapshots.md#whole-server-snapshots)).
- **They outlive the Droplet.** A snapshot stays at DigitalOcean, and is billed, until you delete it
  in the control panel, also after `npx opscrew destroy`.
- **OpsCrew's own data snapshots** copy only the app's data, on a schedule and with an encrypted
  copy off the server if you like: see [Snapshots and restores](snapshots.md).

## Changing the size

DigitalOcean changes a Droplet's size in place: the Droplet keeps its data and its addresses.

1. Choose the new size: pick another option in `npx opscrew design`, apply advise's proposal
   (`npx opscrew advise --apply size.app.larger`), or set `target.serverType` in
   `opscrew/plan.yaml`.
2. `npx opscrew provision` shows the change. Once you approve it, DigitalOcean resizes the Droplet,
   and the app is offline for about a minute per GB of disk in use, often less.

The disk grows with the size and never shrinks, so a Droplet can't go back to a size with a smaller
disk: see [Changing a server's type](advise.md#changing-a-servers-type).

Another region means a new Droplet: design says so first, because the next `provision` deletes the
old Droplet with the data on it. To move the app to another provider, use
`npx opscrew retarget --to hetzner` or `--to contabo` (see
[Moving your app somewhere else](retarget.md)).

## Removing the app

`npx opscrew destroy` deletes the Droplet at once, with its firewall, its SSH key, its app tag
(`opscrew-app:<app>`) and the DNS records OpsCrew made. Its plan lists them before you type the
app's name to approve it.

- **No delete protection.** DigitalOcean has none for Droplets, so typing the name is the only
  safeguard: the Droplet is deleted as soon as the plan is applied. Deleting it in the control panel
  removes it and its data at once, without a plan or a snapshot.
- **A snapshot first, when it matters.** When the Droplet holds your app's data or DigitalOcean's
  backups are on, OpsCrew takes a DigitalOcean snapshot before it deletes the Droplet: the backups
  expire four weeks after they were taken, so the snapshot is the only copy that stays.
  `--no-snapshot` skips it; `--snapshot` takes one anyway.

What remains:

- the snapshot, billed per GB a month until you delete it in the control panel;
- the backups DigitalOcean already took, until they expire;
- the `managed-by:opscrew` tag, which other OpsCrew apps in the account may use;
- the app's bucket, unless you add `--delete-data` (see
  [Object storage](object-storage.md#removing-the-app));
- the container images in GitHub Container Registry, and the files in your repository.

## Object storage

Your app's bucket can be at DigitalOcean Spaces. [Object storage](object-storage.md) compares it
with the other options, Garage on the server and Cloudflare R2, and shows how to create its key.
The encrypted copy of OpsCrew's data snapshots can go to Spaces too, with
`npx opscrew snapshot offsite on --to digitalocean` (see
[An encrypted copy off the server](snapshots.md#an-encrypted-copy-off-the-server)).

## What isn't offered

- **Premium sizes, the 512 MB Basic size and the other size families.** Design offers the Basic
  sizes with at least 1 GB of memory and the CPU-Optimized sizes. 512 MB is too small for Docker and
  PostgreSQL.
- **Delete protection,** which DigitalOcean doesn't have (see [Removing the app](#removing-the-app)).
- **DigitalOcean's VPC networks and volumes.** The app's Droplets, and your devices if you like, are
  linked by OpsCrew's own private network (WireGuard): see
  [Your devices on the private network](private-network.md).

## Replacing the token

`npx opscrew rotate` lists the DigitalOcean token among your own tokens. Create a new token with
the same scopes, set `DIGITALOCEAN_TOKEN` to it, then run `npx opscrew rotate digitalocean`. OpsCrew
checks the new token and names where to delete the old one:
<https://cloud.digitalocean.com/account/api/tokens>. See
[Rotating your app's credentials](credential-rotation.md#your-own-tokens).
