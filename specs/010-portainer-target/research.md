# Research: An existing Portainer as a deploy target

Sources: Portainer's official docs (docs.portainer.io), its source and releases
(github.com/portainer/portainer, 2.45.2 LTS of 2026-10-08), and a live spike against a throwaway
Portainer CE 2.45.2 on Hetzner (Docker 29.9.1, 2026-10-15; every finding below marked CONFIRMED was
observed there). Founder decisions are dated.

## R1. Portainer version and edition

- **Decision**: support Portainer CE (and BE) 2.45 or newer on a single Docker host; refuse older
  versions, Swarm, Kubernetes and Edge environments with a plain message.
- **Rationale**: 2.45.2 is the current LTS and the only version tested live; 2.45 introduced a new
  GitOps model (`/api/gitops/*`) and deprecated older fields, so older servers would need separate
  testing. Reading the version: `GET /api/system/status` (no authentication, `{Version, InstanceID}`)
  and `GET /api/system/version` (authenticated: `ServerVersion`, `ServerEdition`, `VersionSupport`,
  `Dependencies.ComposeVersion`, `Dependencies.DockerVersion`) (CONFIRMED). Compose 2.23 or newer is
  required for inline `configs` (R7); the version is checked from `Dependencies.ComposeVersion`.
- **Alternatives**: support older 2.x (rejected for now: untested API differences).

## R2. Reaching Portainer safely from the user's computer

- **Decision**: HTTPS only, with the certificate pinned by its SHA-256 fingerprint on first use
  (shown and confirmed by the user, like an SSH host key) and checked on every request; plain HTTP
  only for `localhost`. Pinning: Node's `https` with the server's certificate as `ca` plus a
  `checkServerIdentity` that compares `cert.fingerprint256` (CONFIRMED: a wrong pin is refused before
  any request is sent).
- **Rationale**: Portainer's default certificate is self-signed (empty subject, SAN `localhost` and
  `0.0.0.0`, EC P-256, 5 years, kept across restarts in `/data`) (CONFIRMED); "skip verification"
  would let anyone on the network take the token.
- **Alternatives**: trusting the system CA store (fails for the default certificate); disabling
  verification (rejected).

## R3. Authentication and the two kinds of token

- **Decision**: the user gives an access token (`X-API-Key`) in the environment variable
  `PORTAINER_API_KEY`; OpsCrew never stores it, never asks for a Portainer password and never
  creates tokens. An admin's token and a limited user's token both work (founder, 2026-10-15).
- **Rationale**: tokens are created only in the UI or with a JWT plus the user's password
  (`POST /api/users/{id}/tokens`; an `X-API-Key` request gets 401) (CONFIRMED). A limited user (role
  2) granted the environment can list environments, read `docker/info`, and create, read, update,
  stop, start and delete its own stacks, including Git stacks; it gets 403 on registries, users,
  settings and other users' stacks, and cannot see containers it does not own (CONFIRMED). The
  token's user and role: `GET /api/users/me`.
- **Alternatives**: storing the token in local state (rejected: tokens stay in the environment, like
  every other provider token).

## R4. Registry access for the image

- **Decision**: with an admin token OpsCrew adds a Custom registry entry (`POST /api/registries`,
  `Type: 3`, `URL: ghcr.io`, a read-only package token) and grants it to the environment
  (`PUT /api/endpoints/{id}/registries/{rid}` with the user's access policy), records its id and
  removes only that entry on destroy. With a limited token, OpsCrew checks
  `GET /api/endpoints/{id}/registries` for a usable `ghcr.io` entry; when there is none it stops
  before any change and shows the one-time steps (add the entry as admin, or make the image public).
- **Rationale**: registries are admin-only for create, list and delete (CONFIRMED); Portainer uses a
  registry's credentials automatically when the image host matches the registry URL and the
  deploying user may use that registry on the environment (CONFIRMED by pulls failing with a dummy
  credential once the registry was granted, and succeeding after it was removed). There is no GHCR
  type; Custom works. The password is never returned by the API (CONFIRMED).
- **Token**: GitHub's fine-grained tokens cannot read packages, so the registry needs a classic
  token with only `read:packages`; the user creates it (OpsCrew links the exact page) and gives it
  in `OPSCREW_GHCR_READ_TOKEN`. Public images need none.

## R5. Redeploys without exposing Portainer (founder, 2026-10-15)

- **Decision**: two modes, `updater` by default and `cloudflare` as an option.
  - The app stack is a Git stack built from the dedicated branch `opscrew-deploy` of the app's
    repository (`POST /api/stacks/create/standalone/repository`, `RepositoryReferenceName:
    refs/heads/opscrew-deploy`, `ComposeFile: compose.yaml`, `RepositoryAuthentication` with a
    read-only repository token for private repositories, `AutoUpdate: { Webhook: <uuid OpsCrew
    generates>, ForcePullImage: false }`). The deploy workflow commits the rendered `compose.yaml`
    with the new image digest to that branch (an orphan branch holding only that file).
  - `updater`: a second, tiny stack `opscrew-<app>-updater` (a string stack: `POST
    /api/stacks/create/standalone/string`) runs the official curl image pinned by digest and calls
    `POST <portainer>/api/stacks/webhooks/<uuid>` once a minute, with Portainer's public key pinned
    (`--pinnedpubkey sha256//…`), reaching Portainer at the address the user gave (or through
    `host.docker.internal` with `host-gateway` when that address is not reachable from containers).
    Portainer fetches the branch and redeploys only when it changed. Its own stack means a failed
    app update cannot stop it.
  - `cloudflare`: a cloudflared connector (its own stack) and Cloudflare Access with a service token
    in front of a Portainer hostname; the deploy workflow calls the webhook through Access right
    after it writes the branch.
- **Rationale**: Portainer's scheduled Git polling (`AutoUpdate.Interval`, minimum `1m`) is accepted
  and stored but never ran in 2.45.2 over 15 minutes, for admin and limited users, with
  `ForcePullImage`/`ForceUpdate`, and after a restart (CONFIRMED: no fetch in the Git server's access
  log). The stack webhook works on CE 2.45.2 although the docs list it as Business Edition: `POST
  /api/stacks/webhooks/{uuid}` with no authentication returns 204 and the stack fetched and
  redeployed the new commit within 1–2 s; unknown UUIDs return 404; webhooks on string stacks are
  ignored (CONFIRMED). The webhook UUID is a secret (it alone triggers a redeploy).
- **Alternatives**: Portainer's polling (does not run); exposing the webhook to the internet
  (rejected); giving the updater the API key (rejected: far more power than a webhook).
- **To confirm in the first task**: that a webhook call for an unchanged branch does not redeploy
  (Portainer's `RedeployWhenChanged`); if it does, the updater compares the branch head first.

## R6. Stack names and outside projects

- **Decision**: every stack OpsCrew creates is named `opscrew-<app>` (and `opscrew-<app>-updater`,
  `opscrew-<app>-portainer-tunnel`); before creating one, OpsCrew refuses when a Portainer stack with
  that name exists that it did not create, and with an admin token also when any container carries
  `com.docker.compose.project=<name>` (`GET /api/endpoints/{id}/docker/containers/json` with a label
  filter).
- **Rationale**: Portainer lowercases names; a duplicate Portainer stack name returns 409; but a
  Compose project started outside Portainer does not appear in `GET /api/stacks` for anyone, and a
  new Portainer stack with the same name replaced that project's container (CONFIRMED). A limited
  token cannot see those containers, so an unmistakable prefix is the main protection.

## R7. The app stack's contents

- **Decision**: the same runtime OpsCrew renders for its servers, adapted to Portainer:
  - every app variable as explicit `${VAR}` interpolation in `environment:` (values only in the
    stack's `Env`, set through the API);
  - the release command as a one-off service the app waits for
    (`depends_on: { release: { condition: service_completed_successfully } }`);
  - Postgres or Redis with named volumes;
  - Caddy's configuration inline through Compose `configs` with `content` (no files next to the
    stack);
  - web access per the user's choice (R8);
  - per-service log rotation and `no-new-privileges`, as on other targets (T929).
- **Rationale**: Portainer's `Env` only fills `${VARS}` referenced in the compose file; variables not
  referenced are not injected (CONFIRMED). Relative-path bind mounts are Business Edition only, and
  Git repositories containing symlinks are refused (CONFIRMED), so no file may sit next to the
  compose file. `Env` is stored in plain text (`/data/compose/<id>/stack.env`) and returned in plain
  text to the owner and admins (CONFIRMED): OpsCrew never prints, plans or audits values.
- **Updates**: `PUT /api/stacks/{id}` and Git redeploys are asynchronous; OpsCrew polls
  `GET /api/stacks/{id}` (bounded): `Status` 1 active, 2 stopped, 3 deploying, 4 error with the
  reason in `DeploymentStatus[-1].Message` (CONFIRMED). Leaving out `Env` on an update clears it, so
  OpsCrew always sends the full list (CONFIRMED).
- **Failure semantics** (CONFIRMED): invalid YAML or schema keeps the old containers; a missing
  image keeps them only when the stack was healthy; a port conflict recreates the containers and
  leaves them stopped (the app is down); a stack already in error is fully removed before its next
  deploy; on a failed update Portainer keeps the last good file but saves the new `Env`.

## R8. How visitors reach the app (founder, 2026-10-15)

- **Decision**: `tunnel` (default): a cloudflared service in the app stack with the tunnel token in
  `Env`, Caddy serving plain HTTP behind it (as in 009's tunnel mode, with the HTTPS redirect on
  `Cf-Visitor`); `proxy`: Caddy in the stack published on a host port the user chooses, forwarding to
  the app and adding `X-OpsCrew-Image` (the digest's first 12 hex digits) so the deploy workflow can
  tell the new version is live (OpsCrew prints what to route; no TLS; Caddy trusts `X-Forwarded-*`
  from private addresses only); `caddy`: Caddy publishes 80/443 with automatic certificates after OpsCrew checks
  (admin token: containers' published ports; limited token: the user confirms) that the ports are
  free. The tunnel, DNS and Access are infrastructure code through the IaC engine, as in 009. In
  `proxy` and `caddy` mode OpsCrew creates no DNS record (a home address changes and OpsCrew never
  stores it); it prints the record the user creates (an A/AAAA record to their public address or a
  CNAME to their dynamic-DNS name). One stack environment serves every service, so OpsCrew's own
  variables are named `OPSCREW_*` (`OPSCREW_DB_PASSWORD`, `OPSCREW_TUNNEL_TOKEN`, …) and app
  variables named `OPSCREW_*` or `COMPOSE_*` are refused. An optional app variable left unset
  reaches the app as an empty value (the template stays independent of local values); the live test
  checks whether Compose in Portainer leaves a bare `NAME:` entry unset instead.

## R9. Data on destroy

- **Decision**: destroy deletes the app's stacks (`DELETE /api/stacks/{id}?endpointId=N`) and keeps
  their named volumes unless the user asks to delete data (`allowDestroy` + typed app name); then
  OpsCrew removes exactly the stack's volumes through Portainer's Docker proxy
  (`DELETE /api/endpoints/{id}/docker/volumes/{name}`).
- **Rationale**: stack deletion keeps named volumes (CONFIRMED); a limited user can no longer see
  them once the stack's resource control is gone (CONFIRMED), so OpsCrew records the volume names
  before deleting and deletes the volumes first when data deletion is approved.

## R10. Live test

- **Decision**: the gated live test creates a throwaway Hetzner server, installs Portainer CE 2.45.2
  (admin init needs the `X-Setup-Token` printed once in `docker logs portainer`; a fresh install has
  no environment until `POST /api/endpoints` creates the local one; tokens need a JWT session), runs
  a decoy Compose project and a decoy Portainer stack, deploys an example app in both redeploy modes
  and two web modes, checks the decoys are unchanged, destroys and deletes the server.
- **Rationale**: every API fact above was observed on such a server (CONFIRMED); the admin
  initialisation response includes the admin's password hash, so the test never logs it.

## R11. The first deploy (found while writing the tasks, 2026-10-15)

- **Decision**: provision pushes the `opscrew-deploy` branch (a `git-push` approval, as for other
  pushes) with a placeholder `compose.yaml` (one tiny service from the pinned curl image that only
  sleeps, no ports, no secrets used), creates the app's Git stack from it (Portainer clones and
  deploys immediately), and the first run of the deploy workflow after the deploy pull request is
  merged writes the real `compose.yaml`; the updater (or, in `cloudflare` mode, the workflow's
  webhook call) then redeploys the stack with the real app.
- **Rationale**: creating a Git stack clones and deploys at once, so the branch must exist; the real
  image exists only after the workflow's first build. A placeholder avoids a second manual run.
- **Alternatives**: creating the app stack in a second `opscrew provision` after the first build
  (rejected: an extra step the user would forget); letting the workflow create the stack through
  the API (rejected: it would need the Portainer token in GitHub).
