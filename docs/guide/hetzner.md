# Deploy to Hetzner Cloud

OpsCrew can create your app's server at [Hetzner Cloud](https://www.hetzner.com/cloud), on your
own account, as it does at [DigitalOcean](digitalocean.md) and [Contabo](contabo.md). You get a
hardened server, the app deployed from [GitHub](https://github.com/) with TLS, health checks and
rollback, and the `verify`, `secure` and `drift` checks.

## When to choose Hetzner Cloud

- **No contract:** a server has no minimum term, and `npx opscrew destroy` deletes it at once (see
  [Removing the app](#removing-the-app)).
- **Resized in place:** a larger server type keeps the server, its data and its addresses (see
  [Changing the size](#changing-the-size)).
- **Hetzner's backups:** a daily copy of the whole server, the last seven kept (see
  [Backups](#backups)).
- **Live prices and stock:** with the token set, design reads both from Hetzner's API.
- **Prices in EUR, before VAT,** with servers in Germany, Finland, the US and Singapore.

To compare, see [Deploy to DigitalOcean](digitalocean.md) and [Deploy to Contabo](contabo.md).
Once your app runs, `npx opscrew advise` proposes a move when another provider has the same server
for less (see [Cost](advise.md#cost)).

## The token

OpsCrew needs one Hetzner Cloud API token with **Read & Write** permission. Create it in the
[Hetzner Cloud Console](https://console.hetzner.cloud/): open the project that should hold the
app's servers, then **Security → API tokens**.

```bash
export HCLOUD_TOKEN=…
```

- **It works in its project.** It can create, change and delete the servers of the project it was
  created in.
- **`npx opscrew init` checks that it works.** When it is missing, `init` and `provision` say how to
  create it.
- **It stays on your computer.** OpsCrew, and OpenTofu or Terraform, read it from `HCLOUD_TOKEN`.
  It is never written into a file, the infrastructure state, the server or GitHub, and OpsCrew
  masks it in every message, log, audit entry and report.
- **Keep it out of your app.** `npx opscrew scan` reports a Hetzner Cloud API token written in your
  app's files, under a name such as `HCLOUD_TOKEN`, as a critical finding.

## Step by step

1. `npx opscrew interview`: choose **Hetzner Cloud**. When `HCLOUD_TOKEN` is the only provider
   token set, Hetzner Cloud is the default answer. In scripts, put `provider: hetzner` in your
   answers file.
2. `npx opscrew design` shows Hetzner's server types in your region with their monthly price (see
   [Server types and prices](#server-types-and-prices)), and whether Hetzner's backups are on, and
   why.
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan:
   - the server, with Ubuntu 24.04, a public IPv4 and IPv6 address and OpsCrew's first-boot
     hardening, labelled `managed-by=opscrew` and `app=<app>`;
   - its delete and rebuild protection, so it can't be deleted or rebuilt by mistake;
   - its SSH key, `<app>-deploy`;
   - a Hetzner firewall, `<app>-firewall`, attached from the first boot: SSH from the networks you
     allow, the web ports (80 and 443, and UDP 443 for HTTP/3) on the server that serves your
     site, ping, and WireGuard where it is used;
   - Hetzner's backups, when they are on (see [Backups](#backups)).
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` check the result. `drift`
   reports a change made in the Hetzner Cloud Console, such as a firewall rule added or the
   firewall detached; `npx opscrew provision` sets it back.

## Server types and prices

With `HCLOUD_TOKEN` set, design reads Hetzner's server types from its API: the current prices,
where each type is available now, and which types Hetzner is retiring, which design leaves out.
Without the token, or when it doesn't work or Hetzner's API doesn't answer, design uses OpsCrew's
dated list instead and says so. Each price is then marked as an estimate with the list's date, and
availability isn't checked.

The dated list has these lines of x86 types:

| Types | CPU | Sold in | The smallest | EUR a month, before VAT |
|---|---|---|---|---|
| cx23 to cx53 | shared | Germany and Finland | cx23: 2 vCPU, 4 GB memory, 40 GB disk | from 5.49 |
| cpx02 to cpx62 | shared | Germany, Finland and Singapore | cpx02: 1 vCPU, 1 GB, 20 GB | from 5.99; 7.49 in Singapore |
| cpx11 to cpx51 | shared | the US | cpx11: 2 vCPU, 2 GB, 40 GB | from 17.49 |
| ccx13 to ccx63 | dedicated | every location | ccx13: 2 vCPU, 8 GB, 80 GB | from 42.99; 43.49 in the US, 53.99 in Singapore |

- **Plus the IPv4 address:** Hetzner bills the server's public IPv4 address on its own, €0.50 a
  month in the dated list. Design adds it to every price.
- **The list's date:** 2026-10-14. It holds the prices Hetzner set from 15 June 2026, checked
  against Hetzner's API that day. Design shows the date next to each price from it, and says how
  old the list is once it is more than 180 days old.
- **Before VAT,** as OpsCrew shows every provider's prices.

## Regions

| Your answer in the interview | Hetzner Cloud's locations |
|---|---|
| Central Europe | Nuremberg (nbg1), then Falkenstein (fsn1), in Germany |
| Northern Europe | Helsinki (hel1), in Finland |
| United States, east coast | Ashburn (ash), in the US |
| United States, west coast | Hillsboro (hil), in the US |
| Southeast Asia (Singapore) | Singapore (sin) |

Design offers each server type in the first of the region's locations where Hetzner has it. When
Hetzner has no stock of a type in a location, or your account has reached its server limit,
`npx opscrew provision` says so in plain English, with what to try next.

## Backups

Hetzner's automated backups copy the whole server every day and keep the last seven (Hetzner Cloud
Console → your server → **Backups**).

- **On by default only in prod,** when you tell `npx opscrew interview` that losing the app's data
  would be anything but "Not a problem". They are off by default in dev, staging and previews; dev
  and staging rely on OpsCrew's own snapshot before each release. `target.backups` in an
  environment's plan decides over the default: `true` turns them on, `false` off. Design says
  which, and why.
- **Their price:** 20% of the server's price, a line of its own in design's estimate. With the
  token set, design reads the percentage from Hetzner's API.
- **They go with the server.** Hetzner deletes a server's backups when it deletes the server, so
  `destroy` takes a snapshot first (see [Removing the app](#removing-the-app)).
- **They copy a running server.** For a copy of a database you can restore anywhere, see
  [Backups](databases.md#backups).

## Snapshots

```bash
npx opscrew snapshot --server        # Hetzner's snapshot of the whole server
npx opscrew restore --server <id>    # rebuild the server from it
```

- **Billed per GB a month,** at the rate OpsCrew reads from Hetzner's API. The summary shows it
  before the snapshot is taken (see [Whole-server snapshots](snapshots.md#whole-server-snapshots)).
- **They outlive the server.** A snapshot stays at Hetzner, and is billed, until you delete it in
  the Hetzner Cloud Console under **Snapshots**, also after `npx opscrew destroy`.
- **OpsCrew's own data snapshots** copy only the app's data, on a schedule and with an encrypted
  copy off the server if you like: see [Snapshots and restores](snapshots.md).

## Changing the size

Hetzner Cloud changes a server's type in place: the server keeps its data and its addresses.

1. Choose the new type: pick another option in `npx opscrew design`, apply advise's proposal
   (`npx opscrew advise --apply size.app.larger`), or set `target.serverType` in
   `opscrew/plan.yaml`.
2. `npx opscrew provision` shows the change. Once you approve it, Hetzner restarts the server on
   its new type, and the app is offline for one to three minutes.

The disk grows with the type and never shrinks, so a server can't go back to a type with a smaller
disk: see [Changing a server's type](advise.md#changing-a-servers-type).

Another location means a new server: design says so first, because the next `provision` deletes
the old server with the data on it. To move the app to another provider, use
`npx opscrew retarget --to digitalocean` or `--to contabo` (see
[Moving your app somewhere else](retarget.md)).

## Removing the app

`npx opscrew destroy` deletes the server at once, with its firewall, its SSH key and the DNS
records OpsCrew made. Its plan lists them before you type the app's name to approve it. Then:

- **A snapshot first, when it matters.** When the server holds your app's data or Hetzner's backups
  are on, OpsCrew takes a Hetzner snapshot before it deletes the server, since the backups go with
  it. `--no-snapshot` skips it; `--snapshot` takes one anyway.
- **The delete protection is lifted** in a plan of its own, which you approve on its own. It
  changes nothing else and deletes nothing.
- **The server is deleted** by the plan you approved with the app's name.

What remains:

- the snapshot, billed per GB a month until you delete it in the Hetzner Cloud Console under
  **Snapshots**;
- the app's bucket, unless you add `--delete-data` (see
  [Object storage](object-storage.md#removing-the-app));
- the container images in GitHub Container Registry, and the files in your repository.

## Object storage

Your app's bucket can be at Hetzner Object Storage when the server is in Falkenstein, Nuremberg
or Helsinki. [Object storage](object-storage.md) compares it with the other options, Garage on the
server and Cloudflare R2, and shows how to create its key. The encrypted copy of OpsCrew's data
snapshots can go there too, with `npx opscrew snapshot offsite on --to hetzner` (see
[An encrypted copy off the server](snapshots.md#an-encrypted-copy-off-the-server)).

## What isn't offered

- **ARM server types (cax).** Design offers x86 types only.
- **Hetzner Cloud's networks and volumes.** The app's servers, and your devices if you like, are
  linked by OpsCrew's own private network (WireGuard): see
  [Your devices on the private network](private-network.md).

## Replacing the token

`npx opscrew rotate` lists the Hetzner token among your own tokens. Create a new Read & Write token
in the same project, set `HCLOUD_TOKEN` to it, then run `npx opscrew rotate hetzner`. OpsCrew checks
the new token and names where to delete the old one: the Hetzner Cloud Console, your project,
**Security → API tokens**. See [Rotating your app's credentials](credential-rotation.md#your-own-tokens).
