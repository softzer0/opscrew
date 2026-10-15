# Contract: CLI and MCP surface

Owned by T1007 (wiring) with behaviour from T1004–T1006.

## Interview

The provider question gains `portainer` ("My existing Portainer"). Follow-up answers (also in
`--answers` files): `portainer.url`, `portainer.environment` (name or id; listed from Portainer),
`portainer.redeploy` (`updater` default, `cloudflare`), `portainer.web` (`tunnel` default, `proxy`,
`caddy`) and `portainer.port` (for `proxy`). The answers go to local state, never to
`opscrew/requirements.yaml` beyond `provider: portainer`. The token comes only from
`PORTAINER_API_KEY`.

## First connection

Prints Portainer's certificate fingerprint and asks to confirm; in scripts `--portainer-cert
SHA256:…` is required. A changed certificate stops every command until confirmed.

## Provision

- Shows the IaC plan (DNS, tunnel, Access) when needed and the stack plan, each with its hash; both
  need approval. Non-interactive: `--approve <iac-hash> --approve <stack-hash>`; `--yes` never
  approves either.
- `--plan-only` prints the plans and hashes and changes nothing.
- With a limited token and no usable registry entry: stops before any change with the one-time
  steps.

## Destroy

- Removes OpsCrew's stacks, its registry entry, the deploy secrets and the Cloudflare resources;
  never Portainer itself or other stacks. App data only with `--delete-data`, the destroy approval
  and the typed app name (`--confirm <app>` with `--approve` in scripts).

## MCP

The MCP server exposes the same choices; every apply needs the user's approval in a dialog (no
auto-approval); Portainer's certificate is confirmed by the user in a dialog, never passed by the
model; destroy and deleting data stay in the terminal; tool results never show Portainer's address
or any token.
