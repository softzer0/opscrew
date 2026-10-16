# Live test coverage

What has run against real clouds and what has not. Update this page after every live run. The
details, the history of each run and how to start one are in [e2e.md](e2e.md) (see its
[Live results](e2e.md#live-results)).

Every package's unit tests run in each check (`pnpm check`). This page is only about the gated
tests that need real accounts, Docker or the infrastructure engines.

## At a glance

| Live test | Gate | Status | Last passed | Needs to run |
|---|---|---|---|---|
| Hetzner, full flow (`live.test.ts`) | `OPSCREW_E2E_HCLOUD_TOKEN` + GitHub | Passed | 2026-10-13 (run 7) | — |
| Hetzner with a Cloudflare domain | + `OPSCREW_E2E_DOMAIN`, `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Passed | 2026-10-13 | — |
| Framework matrix on Hetzner (19 apps) | `OPSCREW_E2E_APP` per app | Passed | 2026-10-14 | — |
| With a model (`adapt`, `analyze`) | `OPSCREW_E2E_AI=1` | Passed (FastAPI + Redis) | 2026-10-14 | — |
| DigitalOcean, full flow (`live.test.ts`) | `OPSCREW_E2E_DIGITALOCEAN_TOKEN` + GitHub | **Not run yet** | — | A DigitalOcean API token for a throwaway project |
| Retarget Hetzner → DigitalOcean (`live.test.ts`) | both provider tokens, the default app | **Not run yet** | — | Both tokens |
| Cloudflare Registrar sandbox purchase (`domain.test.ts`) | `OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN`, account id | Passed | 2026-10-14 | — |
| Porkbun sandbox (`registrars.test.ts`) | Porkbun sandbox keys | Passed | 2026-10-14 | — |
| Namecheap sandbox (`registrars.test.ts`) | Namecheap sandbox keys | Passed | 2026-10-14 | — |
| GoDaddy | — | **No live test** (unit tests only) | — | A live test and GoDaddy test (OTE) credentials |
| Your own server (`own-server.test.ts`) | `OPSCREW_E2E_OWN_SERVER=1` | Passed | 2026-10-15 (run 11) | — |
| Your existing Portainer, core pass (`portainer-target.test.ts`) | `OPSCREW_E2E_PORTAINER=1` | **Partly passed** (run 1, 2026-10-15: steps 1–3 and the leak search; step 8 failed on a test check, step 9 not reached) | — | A rerun after T1013 |
| Your existing Portainer, full pass | + `OPSCREW_E2E_PORTAINER_STEPS=full` | **Partly passed** (run 5, 2026-10-16: steps 1–5; stopped in step 6, fixed in T1015) | — | A rerun (about 45–60 minutes) |

Run in development, not tracked by date:

- `OPSCREW_DOCKER_TESTS=1` builds and starts the example apps in local Docker (the framework matrix
  passed on 2026-10-14) and checks the Portainer stacks with `docker compose config` and
  `caddy validate`.
- `OPSCREW_IT=1` validates every infrastructure root with both OpenTofu and Terraform.

## Your existing Portainer, step by step

Tick a step once it has passed live.

| Step | Pass | Passed live |
|---|---|---|
| 1. A throwaway server with Portainer CE, an admin, a limited user and the decoys | core | [x] 2026-10-15 |
| 2. Updater + tunnel: init, interview, design, adapt, the limited token's registry steps, three provision runs, deploy, verify, secure, drift | core | [x] 2026-10-15; `init` 2026-10-16 |
| 3. A merged change deploys by itself; a webhook call on an unchanged branch does not redeploy | core | [x] 2026-10-15 |
| 3. A failing change rolls back | full | [x] 2026-10-16 |
| 4. An apply through MCP that replaces the registry token | full | [x] 2026-10-16 |
| 5. Caddy: the app stack updated in place, the DNS record OpsCrew prints, certificates on 80/443 | full | [x] 2026-10-16 |
| 6. Your own proxy: the app on a host port, `verify --url` | full | [ ] |
| 7. Cloudflare redeploys with the tunnel: a deploy through Access, 404 outside the webhook, a token replace | full | [ ] |
| 8. Destroy keeps the data volumes; Portainer, its settings and the decoys stay | core | [ ] |
| 9. `destroy --delete-data` removes the data volumes and nothing else | core | [ ] |
| 10. A loopback Portainer address (the updater through `host.docker.internal`) | full | [ ] |
| 11. A short Portainer host name in the leak check | full | [ ] |
| 12. No token, secret, server address or Portainer address anywhere | core | [x] 2026-10-15 (core pass) |

## Your existing Portainer: behaviour still to confirm live

OpsCrew's adapter and tests assume these from Portainer CE 2.45's source and documentation. The
live test records each one as an `observed:` line.

| Assumption | Checked in | Confirmed |
|---|---|---|
| A webhook call for an unchanged branch does not redeploy | core (step 3) | [x] 2026-10-15 |
| `GET /api/stacks/{id}` returns `GitConfig`, `AutoUpdate` and `DeploymentStatus` with `Time` | core | [x] 2026-10-15 |
| A Git stack is updated with `POST /api/stacks/{id}/git`, then `PUT …/git/redeploy` | full (step 5) | [x] 2026-10-16 |
| `GET /api/stacks/{id}/file` returns a Git stack's deployed file (secure and drift rely on it) | core | [x] 2026-10-15 |
| GHCR accepts the GitHub owner as the registry user name | core | [x] 2026-10-15 (any user name works; the token decides) |
| A bare `NAME:` entry stays unset when the stack has no value for it | core | [x] 2026-10-15: **no**, it arrives as an empty value, like `${NAME}`; the guide already says so |
| Stopping a stack removes its containers; volumes carry the Compose project label | core (steps 8–9) | [x] 2026-10-15 |
| A registry token replace keeps the entry granted to the environment | full (steps 4, 7) | [x] 2026-10-16 |
| Starting a stopped stack answers only once it runs | full | [ ] |
| The updater reaches a loopback Portainer through `host.docker.internal` | full (step 10) | [ ] |
| cloudflared reaches Portainer with `no_tls_verify`; the hostname answers 404 outside `/api/stacks/webhooks/` | full (step 7) | [ ] |
| GitHub accepts the orphan-branch calls and drift's `git fetch` with the user's fine-grained token | core | [x] 2026-10-15 |
| The smallest Cloudflare token for a tunnel-only `updater` setup | core, with `OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN` | [ ] |
| The guide's `openssl` command shows the fingerprint OpsCrew pins | core | [x] 2026-10-15 |
| The guide's steps that need a person: the certificate fingerprint in a browser, the registry steps in Portainer's UI | not automated | [ ] |
