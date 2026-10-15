# ADR 0012: An existing Portainer as a deploy target

- Status: accepted
- Date: 2026-10-15
- Decision makers: founder, lead

## Context

People who run Portainer CE, often on a NAS, cannot use 009's own-server target: it needs SSH and
Ubuntu or Debian, and it changes the host. They manage everything through Portainer and want OpsCrew
to deploy into it without exposing Portainer to the internet. A live test of Portainer CE 2.45.2
showed that its scheduled Git polling never runs, that stack webhooks work on CE, that a new stack
can take over an outside Compose project with the same name, and that only admins can add registry
entries.

## Decision

- A deploy target `portainer`: OpsCrew changes Portainer only through its API, through a typed
  Portainer adapter, behind an approval of the new kind `stack-apply` bound to the stack plan's
  SHA-256 hash (constitution 1.4.0). It never uses SSH and never changes the host.
- Portainer is reached over HTTPS with its certificate pinned on first use (plain HTTP only for
  localhost); the access token comes from `PORTAINER_API_KEY` and is never stored.
- The app is a Git stack built from an `opscrew-deploy` branch the deploy workflow writes with the
  image digest. Redeploys: by default a tiny updater stack calls the stack's webhook once a minute
  over the local network; as an option the workflow calls it through Cloudflare Access.
- Visitors: a Cloudflare Tunnel in the app stack (default), the user's own reverse proxy, or Caddy on
  80/443.
- Every stack is named `opscrew-<app>…`; only what OpsCrew recorded is changed or removed; data
  volumes are deleted only with the typed app name.

## Consequences

- Provision for `portainer` has up to two approvals (IaC and stack plan); scripts pass both hashes.
- A limited token works but may need a one-time registry entry added by an admin.
- OpsCrew does not harden the host; secure checks only the app and says so.
- Portainer versions before 2.45, Swarm, Kubernetes and Edge environments are refused for now.
