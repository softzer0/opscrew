# Deploy to Contabo

OpsCrew can create your app's server at [Contabo](https://contabo.com/), on your own account, as it
does at [Hetzner Cloud](hetzner.md) and [DigitalOcean](digitalocean.md).
You get the same result: a hardened server, the app deployed from [GitHub](https://github.com/)
with TLS, health checks and rollback, and the `verify`, `secure` and `drift` checks.

## When to choose Contabo

- **Cheap servers:** a Cloud VPS with 4 vCPU and 8 GB of memory costs less than a small server at
  most other providers.
- **Monthly contracts:** a server is bought for at least a month, and removing it ends the contract
  only at the end of its term (see [Removing the app](#removing-the-app)).
- **Prices in EUR, before VAT.**
- **Contabo's Auto Backup:** a daily backup of the whole server, kept off the server (see
  [Auto Backup](#auto-backup)).

Choose Hetzner Cloud or DigitalOcean instead when you want a server billed by the hour, removed at
once, resized in place, or backed up by the provider at a price OpsCrew can show.

## The credentials

Contabo's API needs four values. Create them in Contabo's Customer Control Panel, under
Account → Security (<https://new.contabo.com/account/security>):

| Variable | The value |
|---|---|
| `CNTB_OAUTH2_CLIENT_ID` | the client ID |
| `CNTB_OAUTH2_CLIENT_SECRET` | the client secret |
| `CNTB_OAUTH2_USER` | the API user: your login email |
| `CNTB_OAUTH2_PASS` | the API password |

OpsCrew needs all four. When one is missing, `npx opscrew init` and `npx opscrew provision` name it
and call nothing.

```bash
export CNTB_OAUTH2_CLIENT_ID=… CNTB_OAUTH2_CLIENT_SECRET=… CNTB_OAUTH2_USER=… CNTB_OAUTH2_PASS=…
```

- **They reach your whole account.** Contabo has no keys limited to some servers or some actions.
- **They stay on your computer.** OpsCrew uses them only there, to plan and change your servers.
  They never go to the server or to GitHub, and OpsCrew masks them in every message, log, audit
  entry and report. Contabo's Terraform provider saves its login in
  `~/.cache/contabo/terraform/token`; OpsCrew deletes that file before and after each OpenTofu or
  Terraform command, so no run uses another account's login and none stays on disk.
- **Keep them out of your app.** `npx opscrew scan` reports them as a leaked secret when they turn
  up in your app's files or environment.

## Step by step

1. `npx opscrew interview`: choose **Contabo**. When only Contabo's credentials are set, OpsCrew
   chooses it without asking. In scripts, put `provider: contabo` in your answers file.
2. `npx opscrew design` shows Contabo's plans with their monthly price, the date of the price list,
   the one-month minimum term and whether Contabo's Auto Backup is on (see
   [Auto Backup](#auto-backup)).
3. `npx opscrew adapt` prepares the app for a container, as for any other deployment.
4. `npx opscrew provision` shows the plan and creates, only after you approve that exact plan:
   - the server, on a monthly contract, with Ubuntu 24.04 and the same first-boot hardening as on
     the other providers;
   - its SSH key;
   - a Contabo firewall with the same rules: SSH from the networks you allow, the web ports on the
     server that serves your site, and WireGuard where it is used. Contabo's Terraform provider
     can't manage a firewall, so OpsCrew sets it through Contabo's API right after the apply, to
     exactly the rules of the plan you approved. When that fails, provision says the server may not
     be protected yet: run `npx opscrew provision` again, which plans nothing new and sets the
     firewall again;
   - Contabo's Auto Backup, when it is on (see [Auto Backup](#auto-backup)).
5. `npx opscrew verify`, `npx opscrew secure` and `npx opscrew drift` work as on the other
   providers. `drift` also compares Contabo's firewall with the plan's and lists each difference,
   such as a rule added or a server removed in the Customer Control Panel; `npx opscrew provision`
   sets it back. For Auto Backup, `drift` compares the plan with OpsCrew's record of turning it
   on, not with Contabo: Contabo's API doesn't say which of a server's add-ons is Auto Backup.

## Plans and prices

| Plan | vCPU | Memory | Disk (SSD) | Snapshots included | EUR a month, before VAT |
|---|---|---|---|---|---|
| Cloud VPS 4 | 4 | 8 GB | 100 GB | 1 | 5.50 |
| Cloud VPS 6 | 6 | 12 GB | 200 GB | 2 | 7.50 |
| Cloud VPS 8 | 8 | 24 GB | 300 GB | 3 | 14.00 |
| Cloud VPS 12 | 12 | 48 GB | 400 GB | 3 | 25.00 |

- **From a dated list.** Contabo has no price API, so OpsCrew's prices come from
  [Contabo's VPS page](https://contabo.com/en/vps/), read on 2026-11-11. Design and advise show
  that date next to every Contabo price. The page names no extra charge for other regions, so
  OpsCrew uses the same prices everywhere.
- **Before VAT.** Contabo adds your country's VAT when you order. OpsCrew shows every provider's
  prices before VAT.
- **A setup fee on Cloud VPS 4.** Contabo charges €2.00 once, before VAT, for a Cloud VPS 4 on a
  monthly contract. Design shows it under the monthly price, and advise counts it before it
  proposes a move to Contabo.
- **Monthly contracts only.** Contabo's 12- and 24-month contracts cost less a month, but a removal
  would then keep billing for up to two years. OpsCrew offers only the monthly one.

## Auto Backup

Contabo's Auto Backup takes one backup of the whole server a day and keeps up to 10 days of them,
the oldest deleted first. It stores them off the server, on a separate Contabo storage system.

- **On by default only in prod,** when you tell `npx opscrew interview` that losing the app's data
  would be anything but "Not a problem". It is off by default in dev, staging and previews, which
  rely on OpsCrew's own snapshot before each release. `target.backups` in an environment's plan
  decides over the default: `true` turns it on, `false` off. Design says which, and why.
- **Priced on Contabo's order page.** Auto Backup is a paid monthly add-on, and Contabo publishes
  no price per plan for it, so OpsCrew shows none. Design, provision and advise leave it out of
  every monthly price and say so: check its price on Contabo's order page.
- **Turned on after the apply.** Contabo's Terraform provider can't turn it on by name, so OpsCrew
  turns it on through Contabo's API right after the apply, as it sets the firewall. The plan you
  approve lists it as `terraform_data.backup`, and nothing is ordered before you approve that exact
  plan.
- **Ordered once.** OpsCrew records each server's order on this computer, so a run that plans
  nothing new never orders it again. A run from another computer has no record and orders it
  again; whether Contabo takes a second order of a server that already has Auto Backup without
  harm isn't known yet. When Contabo gives no clear answer, OpsCrew doesn't ask again: provision
  says how to check the server in the Customer Control Panel, then tell OpsCrew what you found.
- **Turned off in the Customer Control Panel only.** Contabo's API can't turn it off. When the
  plan turns it off, provision says so, changes nothing at Contabo, and leaves it to you: cancel the
  Auto Backup add-on of the server in the Customer Control Panel. It stays on, and billed, until
  you do.
- **Restore in the Customer Control Panel.** Under **Servers & Hosting → VPS Auto Backup**, choose
  **Restore last backup** or one of the kept backups. A restore overwrites the server's data, and
  the server is down until it ends.
- **They go with the server.** The add-on ends with the server's contract, and Contabo doesn't
  promise that its backups outlive the server. OpsCrew's own data snapshot, with its encrypted copy
  off the server, is the copy that stays (see [Removing the app](#removing-the-app)).

## Regions

| Your answer in the interview | Contabo's region |
|---|---|
| Central Europe | EU, in Germany |
| Northern Europe | EU, in Germany: Contabo has no location in the Nordics, and design says so |
| United States, east coast | US East, in New York |
| United States, west coast | US West, in Seattle |
| Southeast Asia (Singapore) | Singapore |

When Contabo has no stock of a plan in a region, or your account has reached its server limit,
OpsCrew shows Contabo's answer in plain English with what to try next.

## Removing the app

Contabo can't delete a server at once. `npx opscrew destroy` cancels it instead, and its plan says
what that means before you type the server's name to approve it:

- **The server is billed to the end of its term.** Contabo ends the contract at the end of the
  current term, at least a month after the server was bought, and bills it until then.
- **OpsCrew shuts the server down now** and removes the app's other resources at once: its DNS
  records, its firewall and its SSH key. When Contabo refuses to delete the firewall, destroy says
  so and finishes; delete it in the Customer Control Panel (a firewall costs nothing).
- **The end date is shown.** After the cancel, OpsCrew shows the date Contabo answers and records it
  in the audit log.
- **The disk and Contabo's snapshots go when the term ends.** When the server holds your app's
  data, OpsCrew first offers its own snapshot of the data, with its encrypted copy off the server
  (see [Snapshots and restores](snapshots.md)). It offers no Contabo snapshot, because that would
  go with the server.
- **You can still start the server** in the Customer Control Panel until the end date, for example
  to copy something you forgot.
- **A server not created through Contabo's API** (bought in the panel, for example) can't be
  cancelled through it. OpsCrew stops with Contabo's reason; cancel it in the Customer Control
  Panel.

### Provisioning again

A cancelled server can't be taken back through Contabo's API. When you provision the app again while
its old server is still in its term, the plan says so: OpsCrew buys a new server, which is another
month.

### A create that stopped halfway

Contabo can't tell a repeated create from a new one, so a create that times out could buy a second
server. OpsCrew never repeats a create. The next `npx opscrew provision` looks for the app's server
at Contabo first, shows it in the plan and takes it over, without buying another one.

A server with the app's name that OpsCrew didn't create is never taken over. The plan stops, names
the server and tells you to rename or remove it in the Customer Control Panel.

## Snapshots

```bash
npx opscrew snapshot --server        # Contabo's snapshot of the whole server
npx opscrew restore --server <id>    # put the server back to it
```

- **Included in the plan's price:** 1 snapshot on Cloud VPS 4, 2 on Cloud VPS 6 and 3 on the larger
  plans. At the limit, OpsCrew refuses and says which snapshot to delete first.
- **Snapshots you take by hand** in the Customer Control Panel count towards the limit too.
- **Restoring an older snapshot deletes the newer ones.** OpsCrew says so before you approve it.

## Changing the size

OpsCrew can't change a Contabo server's plan in place: Contabo's Terraform provider ignores the
change. So design and advise refuse a new size on Contabo and name two ways:

- **Move to another provider** with `npx opscrew retarget --to hetzner` (or `--to digitalocean`),
  with a short maintenance window while the data is copied (see
  [Moving your app somewhere else](retarget.md)). `retarget` doesn't move an app within one
  provider.
- **A new Contabo server of the size you want**, with downtime:
  1. Take a snapshot of the app's data with its encrypted copy off the server: `npx opscrew snapshot`
     (first `npx opscrew snapshot offsite on --to <provider>` and `npx opscrew provision` if the
     copy is off).
  2. Remove the old server with `npx opscrew destroy`. It is billed to the end of its term.
  3. Choose the new size with `npx opscrew design`, then `npx opscrew provision`.
  4. Put the data back from the copy: `npx opscrew restore <id> --from offsite --key-file <path>`
     (see [Snapshots and restores](snapshots.md)).

## What isn't offered

- **Contabo's Object Storage for more than 250 GB.** Up to that, your app's bucket can be in it:
  see [Object storage](object-storage.md).
- **Contabo's private networks.** OpsCrew's own private network (WireGuard) connects the app's
  servers and your devices as on the other providers: see
  [Your devices on the private network](private-network.md).
- **Reverse DNS** for the server's address.

## Replacing the credentials

`npx opscrew rotate` lists Contabo's four values among your own tokens. Create new ones in the
Customer Control Panel, set the four variables, then run `npx opscrew rotate contabo`: see
[Rotating your app's credentials](credential-rotation.md).
