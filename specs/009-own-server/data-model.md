# Data model: Your own server, and Portainer

## Plan target (committed, `opscrew/plan.yaml`)

`target` becomes a discriminated union on `provider`:

| Field | Hetzner / DigitalOcean | Own server |
|---|---|---|
| `provider` | `hetzner` / `digitalocean` | `own` |
| `mode` | `vps-compose` | `vps-compose` |
| `location`, `serverType`, `image`, `backups` | as today | absent |
| `arch` | absent (amd64) | `amd64` or `arm64` (from inspection) |
| `access` | absent (public) | `public` or `tunnel` |

Never in the plan: the address, the SSH user, the key path, the host key, tokens, passwords.

## Portainer settings (committed, `plan.portainer`, optional)

| Field | Meaning |
|---|---|
| `enabled` | `false` by default |
| `version` | pinned image version tag |
| `access` | `local` (default) or `subdomain` |
| `hostname` | subdomain on the user's Cloudflare domain (subdomain mode only) |
| `allowedEmails` | email addresses Access lets in (subdomain mode only, at least one) |

## Own-server connection (local, `.opscrew/server.json` → `own`)

| Field | Meaning |
|---|---|
| `host` | address or hostname the CLI connects to |
| `port` | SSH port (default 22) |
| `user` | the admin login (root or a passwordless-sudo user) |
| `keyPath` | path to the private key, or absent when `agent` is true |
| `agent` | use the SSH agent |
| `hostKey` | pinned `SHA256:` fingerprint (also in the project's `known_hosts`); absent until the first connection, and dropped when the host or port changes, so the next connection asks again |
| `reachable` | the user's answer: whether the internet can reach the server directly (`public` mode) or not (`tunnel` mode) |
| `publicIpv4`, `publicIpv6` | the addresses DNS points to in public mode |

## Host facts (in memory, from `inspectHost`)

OS id, version and codename; architecture; CPU count; memory and free disk; root or passwordless
sudo; the effective sshd settings (port, password and root login); listeners on 80/443 with process
names; active web servers; the firewall in use (ufw active/inactive, firewalld, foreign nftables
rules); Docker (absent, Docker repository with version, Snap, Podman, distribution package);
existing containers publishing 80/443; login users with a password and no authorized keys; the
OpsCrew app marker and host record when present.

## Host plan (local, `.opscrew/plans/host-<sha256>.json`)

| Field | Meaning |
|---|---|
| `schemaVersion` | 1 |
| `purpose` | `setup`, `teardown` or `undo` |
| `app` | the app name the marker binds the server to |
| `steps[]` | `{ id, title, state: in-place|change|blocked, reason?, params }` in order |
| `findings[]` | blocking findings with the plain reason and what to do |
| `deleteData` | teardown only: whether app data is deleted (needs `allowDestroy` + typed name) |

The SHA-256 of the canonical JSON is the hash the `host-apply` approval names. Secrets
(tunnel token, Portainer password) are not part of the plan; they are supplied at apply.

## Host setup record (on the server, `/etc/opscrew/host.json`, root-only)

| Field | Meaning |
|---|---|
| `app`, `projectId` | which OpsCrew app owns the server (one app per server) |
| `changes[]` | `{ step, at, previous }`: what OpsCrew changed and the value it replaced (sshd drop-in absent or its old content hash, ufw inactive/rules before, packages OpsCrew installed, users it created) |
| `opscrewVersion` | the CLI version that applied it |

No secrets. Drift, teardown and undo read it.

## State transitions

```text
unknown ──connect+confirm host key──▶ pinned ──inspect──▶ inspected
inspected ──blocking finding──▶ refused (nothing changed)
inspected ──host-apply approved──▶ prepared ──deploy──▶ serving
serving ──destroy──▶ app removed (server prepared) ──destroy --undo-host──▶ host restored
```
