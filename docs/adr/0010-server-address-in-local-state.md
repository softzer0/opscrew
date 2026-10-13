# ADR 0010: The server address lives in local state, not in the plan

- Status: accepted (2026-10-14)

## Context

The first real deploy (feature 008) wrote "deploys the app to <the server's IP address>" into the deploy pull
request. The address was also committed in `opscrew/plan.yaml` (`deployment.serverIpv4/6`, and
during a move `retarget.from`/`retarget.next`) and in `opscrew/RUNBOOK.md`. Behind Cloudflare's
proxy, hiding the origin is one of the main benefits; a committed address (in public repositories
especially) lets anyone bypass Cloudflare: direct floods, SSH brute force. A move between providers
also read the old and new servers' addresses from outputs named after the layout
(`server_*`, `other_server_*`), which could swap them after a manual DNS switch.

## Decision

- `plan.yaml` holds no server address. `deployment.url` accepts domain URLs only.
- The address is OpsCrew's local state: `.opscrew/server.json` (gitignored; written by provision,
  dns, retarget and destroy), read through one helper (`serverAddress`), with the root module's
  OpenTofu outputs as the fallback. A damaged file stops with a plain message.
- Pull requests and commit messages never contain the address. The runbook and the security report
  contain it only when the domain is not behind the proxy (the app is served on it then).
- The root module renders `servers`, each server keyed by its provider, in every layout. A move
  always changes provider, so its old server is `servers[from.provider]` and its new one
  `servers[target.provider]`, whatever layout was applied last; when either cannot be named, the
  move stops before acting.
- OpsCrew is unreleased, so there is no migration from the old fields.

## Consequences

- Commands that need the address on another computer need that computer's `.opscrew/` folder (or
  the copied state, from which the outputs are read). They say so plainly instead of guessing.
- An address that was public earlier (an unproxied deployment) stays public; OpsCrew notes this
  when the proxy is turned on, and only a new server gets a fresh address.
