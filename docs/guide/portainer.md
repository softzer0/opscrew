# Portainer: a web UI for your containers

[Portainer CE](https://www.portainer.io/) shows the containers, logs, images and volumes on your
server in a web browser. OpsCrew can install it on any server it deploys to: one it created on
Hetzner Cloud or DigitalOcean, or a server you already have. It is off until you turn it on.

## Why it stays private

Portainer controls Docker on the server, and control of Docker is the same as control of the whole
server (root). So OpsCrew never puts it on the open internet:

- it listens only on the server itself (`127.0.0.1`, port 9443), and you reach it through an SSH
  tunnel from your computer;
- its admin account gets a password OpsCrew generates when it first starts, so nobody else can
  claim the instance;
- a public address is only possible as an explicit opt-in, on a subdomain behind Cloudflare Access
  that lets in only the email addresses you list (Portainer's own login still applies).

## Turn it on

```bash
npx opscrew portainer enable
```

OpsCrew shows the plan of what it adds to the server (Portainer, pinned to a tested version) with
its hash and installs it after you approve. In scripts: `npx opscrew portainer enable --plan-only`,
review the plan, then `npx opscrew portainer enable --approve <hash>`: without other options,
`--approve` applies exactly what the `--plan-only` run planned.

The admin password is generated on your computer and saved in
`~/.opscrew/projects/<project>/portainer_password` (readable only by you). It goes to the server
only while Portainer creates its admin account, and that copy is deleted afterwards. OpsCrew never
prints the password and never writes it into your repository, plans, logs or reports.

Commit the changed `opscrew/plan.yaml` afterwards (the next `npx opscrew provision` also includes
it in its pull request).

On servers OpsCrew created, Portainer runs as the `deploy` user and needs Docker Engine 28 or
newer; OpsCrew checks that first and tells you what to do if the server has an older Docker. On
your own server, OpsCrew's host setup already installs Docker 28 or newer.

## Open it

```bash
npx opscrew portainer status
```

prints the SSH tunnel command for your server, the local address and where the password file is.
Start the tunnel and keep it running, then open <https://localhost:9443> in your browser (Portainer
uses a self-signed certificate, so your browser warns you once) and log in as `admin` with the
password from the file. The password file is only on the computer that turned Portainer on; copy it
from there if you work on another computer.

## Optional: a subdomain behind Cloudflare Access

```bash
npx opscrew portainer enable --subdomain portainer --allow-email you@example.com
```

serves Portainer on a subdomain of your Cloudflare domain as well (`portainer.example.com` for a
domain on `example.com`). It needs:

- the app's domain on Cloudflare;
- **Cloudflare Zero Trust turned on** for your account: open
  [one.dash.cloudflare.com](https://one.dash.cloudflare.com/), pick a team name and the Free plan;
- these extra permissions on your `CLOUDFLARE_API_TOKEN`: Account → Cloudflare Tunnel → Edit,
  Account → Access: Apps and Policies → Edit, Account → Access: Service Tokens → Edit and
  Account → Access: Organizations, Identity Providers, and Groups → Edit.

The subdomain always goes through a Cloudflare Tunnel, so the server opens no port for it.
Cloudflare Access lets in only the email addresses you listed with `--allow-email` (repeat it for
several), each after a one-time code sent to that address; then Portainer's own login follows. This
adds two plans, each approved separately: the Cloudflare plan, which adds the account's Zero Trust
organization and one-time PIN login when they are missing (every OpsCrew app in the account shares
them, and OpsCrew never deletes them; see [Your domain on Cloudflare](cloudflare.md)), and the
infrastructure plan (the tunnel and the Access rules in your infrastructure code). When the
Cloudflare plan adds the one-time PIN login, the infrastructure plan follows once it is applied: in
a script, the printed `--approve` command applies the Cloudflare plan and stops at the
infrastructure plan, printing its hash; run it again with `--approve` and that hash.

## Turn it off

```bash
npx opscrew portainer disable
```

removes Portainer (and the subdomain's tunnel and Access rules) after you approve the plan. Its data
(users and settings) stays on the server, so turning it on again keeps your setup.
`npx opscrew portainer disable --delete-data` also deletes the data; you confirm that by typing the
app's name. In a script, run `npx opscrew portainer disable --delete-data --plan-only` first, then
the printed `--approve` command with `--confirm <app name>` added; without `--confirm` a script never
deletes the data.

## From Claude Code

The OpsCrew plugin offers the same: Claude can show Portainer's status and turn it on or off, and
you approve each plan in a dialog. Turning it off there always keeps Portainer's data; deleting the
data stays in the terminal (`npx opscrew portainer disable --delete-data`, typing the app's name). Claude never sees the password. Your own server's address never
appears in the tools' results, in files or in pull requests (the tools say "your server"), but an
address you type into the chat during the plugin's interview does reach Claude. To keep it out of
the chat, answer the interview in your terminal with `npx opscrew interview`. To open Portainer, run
`npx opscrew portainer status` in your terminal: it prints the SSH tunnel command with the address.
