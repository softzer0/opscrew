# Contract: CLI and MCP surface

Owned by T908 (wiring) with behaviour from T904–T907, T913, T916 and T921.

## Interview

The provider question gains `own` ("A server you already have"). Follow-up answers (also accepted
in `--answers` files): `server.host`, `server.port` (default 22), `server.user`, `server.key`
(a path, or `agent`), `server.reachable` (`true`/`false`; suggested from inspection) and
`server.serve` (`tunnel`, `proxy` or `dns-only`: how the site is served when the server is reachable
and the domain is on Cloudflare; the default is `tunnel`, `proxy` means directly behind Cloudflare's
proxy with the Cloudflare-only web filter; without a Cloudflare domain only `dns-only` is offered).
The answers go to local state, never to `opscrew/requirements.yaml` beyond `provider: own`.

## Design and drift

- `opscrew design --host-key SHA256:…` and `opscrew drift --host-key SHA256:…`: connect to and
  inspect the server read-only; the flag pins the host key in scripts when this is the first
  connection.

## Provision

- First connection: prints the host key's SHA-256 fingerprint and asks to confirm; in scripts
  `--host-key SHA256:…` is required.
- Shows the IaC plan (DNS, tunnel, Access) and the host plan, each with its hash; both need approval.
  Non-interactive: `--approve <iac-hash> --approve <host-hash>` (each `--approve` names one plan;
  `--yes` never approves either).
- `--plan-only` prints both plans and hashes and changes nothing. In tunnel mode the host plan's
  hash includes the tunnel id, so on a first provision the host plan is shown and approved in a
  second run, after the tunnel exists.
- `--password-logins off|keep`: the user's choice when other logins still use passwords (otherwise
  the SSH step blocks).
- `--confirm <app>`: in scripts, approves a plan that deletes or replaces resources (for example the
  removal plan of a switch between serving directly and the tunnel) together with `--approve` and
  that plan's hash; a terminal asks for the typed name instead.

## Destroy

- Own servers: removes the app from the server (host teardown plan) and its DNS/tunnel/Access
  (IaC); the tunnel's connector goes first and the tunnel is deleted once Cloudflare reports no
  connections. App data only with `--delete-data`, the destroy approval and the typed app name
  (`--confirm <app>` in scripts).
- `--undo-host`: also reverses OpsCrew's host changes (a separate host plan and approval; it deletes
  the OpsCrew-created `deploy` user, so it needs the typed app name too; `--approve <undo-hash>`
  with `--confirm <app>` in scripts).
- `--host-key SHA256:…` as for provision.

## Portainer

| Command | Effect |
|---|---|
| `opscrew portainer enable` | plan + approval; installs local-only Portainer; prints the tunnel command, the local URL and the path of the password file |
| `opscrew portainer enable --subdomain <host> --allow-email <email>…` | also plans the tunnel and Access (two approvals); the hostname must be one level below the zone |
| `opscrew portainer disable [--delete-data] [--confirm <app>]` | plan + approval; data deleted only with `--delete-data` and the typed name (`--confirm <app>` with `--approve` in scripts) |
| `opscrew portainer status [--json]` | read-only: version, access mode, tunnel command, password file path (never the password) |

`portainer enable` and `portainer disable` accept `--plan-only`, `--approve <hash>` (repeatable),
`--host-key`, `--engine` and `--yes` (which never approves an infrastructure or host plan);
`portainer status` takes only `--json`.

## MCP

The MCP server exposes the same choices; every apply still needs the user's approval through the
same gate (no auto-approval through MCP). Exceptions, as for OpsCrew-created servers: destroy,
`--undo-host` and deleting data stay in the terminal; a server's host key is confirmed by the user
in a dialog and is never passed by the model; tool results replace the server's address with
"your server".
