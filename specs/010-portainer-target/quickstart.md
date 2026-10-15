# Quickstart: An existing Portainer as a deploy target

## Unit and integration checks

```bash
pnpm turbo run typecheck test --filter=@opscrew/connector-portainer --filter=@opscrew/agents \
  --filter=@opscrew/iac-templates --filter=opscrew --filter=@opscrew/mcp-server
```

Fakes of Portainer's API cover: inspection refusals (old version, Swarm, Edge, missing access, a
taken OpsCrew name, a limited token without a registry), stack plans and hashes, apply with
asynchronous waits and failures, teardown with and without data, drift, and the pinned client
refusing a changed certificate.

## Gated live test (`OPSCREW_E2E_PORTAINER=1` with the Hetzner, GitHub and Cloudflare variables)

1. The test creates a throwaway Hetzner server and installs Portainer CE 2.45.2 (admin init with the
   setup token from its logs, the local environment, an admin token and a limited user's token), a
   decoy Compose project and a decoy Portainer stack.
2. `updater` redeploy with a `tunnel` web mode: `opscrew init` → `interview` (Portainer, the
   environment, the pinned certificate) → `design` → `adapt` → `provision` (both plans approved by
   hash) → merge the deploy PR → the site answers through the tunnel; `verify`, `secure`, `drift`
   clean; a re-run of `provision` shows no changes.
3. A merged change deploys by itself within 5 minutes; a deliberately failing change rolls back to
   the previous version.
4. Switch to `caddy` web mode and to the `cloudflare` redeploy mode; a merged change deploys through
   Access; Portainer refuses a request without the service token.
5. The decoy Compose project and the decoy Portainer stack are unchanged after every step.
6. `opscrew destroy` keeps the data volumes; `opscrew destroy --delete-data` (typed name) removes
   them; Portainer and the decoys are untouched; the test deletes the server.
