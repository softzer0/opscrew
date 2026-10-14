# Contract: CLI and MCP surface

Owned by T908 (wiring) with behaviour from T904–T907.

## Interview

The provider question gains `own` ("A server you already have"). Follow-up answers (also accepted
in `--answers` files): `server.host`, `server.port` (default 22), `server.user`, `server.key`
(a path, or `agent`), `server.reachable` (`true`/`false`; suggested from inspection). The answers
go to local state, never to `opscrew/requirements.yaml` beyond `provider: own`.

## Provision

- First connection: prints the host key's SHA-256 fingerprint and asks to confirm; in scripts
  `--host-key SHA256:…` is required.
- Shows the IaC plan (DNS, tunnel, Access) and the host plan, each with its hash; both need approval.
  Non-interactive: `--approve <iac-hash> --approve <host-hash>` (each `--approve` names one plan).
- `--plan-only` prints both plans and hashes and changes nothing.

## Destroy

- Own servers: removes DNS/tunnel/Access (IaC) and the app from the server (host teardown plan); app
  data only with the destroy approval and the typed app name.
- `--undo-host`: also reverses OpsCrew's host changes (separate host plan and approval).

## Portainer

| Command | Effect |
|---|---|
| `opscrew portainer enable` | plan + approval; installs local-only Portainer; prints the tunnel command, the local URL and the path of the password file |
| `opscrew portainer enable --subdomain <host> --allow-email <email>…` | also plans the tunnel and Access (two approvals) |
| `opscrew portainer disable` | plan + approval; data deleted only with a typed confirmation |
| `opscrew portainer status` | read-only: version, access mode, tunnel command, password file path |

## MCP

The MCP server exposes the same choices; every apply still needs the user's approval through the
same gate (no auto-approval through MCP).
