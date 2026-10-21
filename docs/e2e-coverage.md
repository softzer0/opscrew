# Live test coverage

What has run against real clouds and what has not. Update this page after every live run. The
details, the history of each run and how to start one are in [e2e.md](e2e.md) (see its
[Live results](e2e.md#live-results)).

Every package's unit tests run in each check (`pnpm check`). This page is only about the gated
tests that need real accounts, Docker or the infrastructure engines.

## At a glance

| Live test | Gate | Status | Last passed | Needs to run |
|---|---|---|---|---|
| Hetzner, full flow (`live.test.ts`) | `OPSCREW_E2E_HCLOUD_TOKEN` + GitHub | Passed | 2026-10-19 (with 012's builders) | — |
| Hetzner with a Cloudflare domain, the app's hostnames in OpsCrew's shared rules after provision and gone after destroy (feature 011) | + `OPSCREW_E2E_DOMAIN`, `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Passed (the zone had no rule lists: OpsCrew created both and deleted them again on destroy) | 2026-10-18 | — |
| Framework matrix on Hetzner (19 apps) | `OPSCREW_E2E_APP` per app | Passed | 2026-10-14 | — |
| Hetzner builder checks (feature 012): the builder, non-root, the attestations and their leak search, a change and a broken release under load, GHCR's blobs after the image retention job ([details below](#image-builders-feature-012)) | `OPSCREW_E2E_BUILDS=1`, `OPSCREW_E2E_APP` = `nextjs-postgres`, `go-api` or `rust-api`, + `OPSCREW_E2E_GHCR_READ_TOKEN` | Passed, all three apps (generated Dockerfile, Buildpacks, Railpack) | 2026-10-19 | — |
| Image signing with the builder checks | + `OPSCREW_E2E_SIGN=1` (only with `OPSCREW_E2E_BUILDS=1`; opt-in: it publishes the throwaway repository's name in Sigstore's public log) | Passed, all three apps (the owner agreed on 2026-10-18) | 2026-10-19 | — |
| With a model (`adapt`, `analyze`) | `OPSCREW_E2E_AI=1` | Passed (FastAPI + Redis) | 2026-10-14 | — |
| DigitalOcean, full flow (`live.test.ts`) | `OPSCREW_E2E_DIGITALOCEAN_TOKEN` + GitHub | **Not run yet** | — | A DigitalOcean API token for a throwaway project |
| Retarget Hetzner → DigitalOcean (`live.test.ts`) | both provider tokens, the default app | **Not run yet** | — | Both tokens |
| Cloudflare Registrar sandbox purchase (`domain.test.ts`) | `OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN`, account id | Passed | 2026-10-14 | — |
| Porkbun sandbox (`registrars.test.ts`) | Porkbun sandbox keys | Passed | 2026-10-14 | — |
| Namecheap sandbox (`registrars.test.ts`) | Namecheap sandbox keys | Passed | 2026-10-14 | — |
| GoDaddy | — | **No live test** (unit tests only) | — | A live test and GoDaddy test (OTE) credentials |
| Your own server (`own-server.test.ts`), with a second app in the same zone and account, seeded rules and shared-rule checks (steps 6b, 7b; feature 011) | `OPSCREW_E2E_OWN_SERVER=1`, + `OPSCREW_E2E_GITHUB_REPO_B` for the second app | Passed (all 10 steps), again after 011's simplification | 2026-10-19 (with 012's switch, pins and builds) | — |
| Your existing Portainer, core pass (`portainer-target.test.ts`), with a second app in the same Portainer, zone and account, seeded rules and shared-rule checks (steps 7b, 9b; feature 011) | `OPSCREW_E2E_PORTAINER=1`, + `OPSCREW_E2E_GITHUB_REPO_B` for the second app | Passed (after T1109), again after 011's simplification | 2026-10-19 (with 012, and the tunnel token) | — |
| Your existing Portainer, full pass | + `OPSCREW_E2E_PORTAINER_STEPS=full` | Passed: steps 1–11 in run 10 (2026-10-16), steps 11 and 12 with the fixed leak check on 2026-10-17 | 2026-10-17 (steps 11, 12) | — |
| Hetzner component checks (feature 013): the live set of SC-1301, one pass per example, each with its data through a deploy and a reboot, the worker and cron, limits, no public port, the server-side checks and the leak search ([details below](#components-feature-013)) | `OPSCREW_E2E_COMPONENTS=1`, `OPSCREW_E2E_APP` = one of the eight component examples | Passed: `node-bullmq`, `express-mysql`, `node-mongo`, `rabbitmq-worker`, `kafka-app`, `meili-search` (+ OpenSearch), `clickhouse-events` | 2026-10-20 | — |
| The bucket on Cloudflare R2 (`s3-uploads`) | + `OPSCREW_E2E_R2=1` (default `OPSCREW_E2E_STORAGE=r2`), a Cloudflare domain | Passed | 2026-10-20 | — |
| The bucket on Hetzner Object Storage (`s3-uploads`) | + `OPSCREW_E2E_STORAGE=hetzner`, `OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID`, `OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY` | Passed (run 5, after T1315a–T1315c; Hetzner can show a new bucket late, which OpsCrew now handles) | 2026-10-20 | — |
| Your own server with two apps on one server behind one edge (feature 013, steps 6b–7b): `s3-uploads` with Garage next to the first app, a change to each under 20 requests per second each, the first app's destroy under load, the edge gone with the last app | `OPSCREW_E2E_OWN_SERVER=1`, `OPSCREW_E2E_GITHUB_REPO_B` (now required) | Passed (11 tests) | 2026-10-20 | — |
| Your existing Portainer, components in stacks and the host-setting refusal (feature 013, step 7b with `node-mongo`) | `OPSCREW_E2E_PORTAINER=1`, `OPSCREW_E2E_GITHUB_REPO_B` (now required) | Passed (10 tests) | 2026-10-20 | — |
| Hetzner, proxied, with origin TLS (feature 014): Cloudflare's side, the origin check from the server, `secure --deep`, the zone after destroy ([details below](#secops-and-tls-feature-014)) | `OPSCREW_E2E_TLS=proxied`, a Cloudflare domain, Docker here | **Not run yet** | — | The e2e Cloudflare token with SSL and Certificates Edit and Zone Settings Edit |
| Hetzner, origin protection turned on for an app already live, under load | `OPSCREW_E2E_TLS=live`, + `OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS` | **Not run yet** | — | A second token for the zone without the two TLS permissions |
| Hetzner, DNS only: CAA at the hostname, not at the apex; the minimum TLS decision | `OPSCREW_E2E_TLS=dns-only` | **Not run yet** | — | — |
| Hetzner, the recovery copy restored on a fresh clone | `OPSCREW_E2E_TLS=recovery`, the default app | **Not run yet** | — | — |
| Your own server with nginx (`own-nginx.test.ts`): certbot, an addition, a forced renewal under load, testssl.sh, two apps on one edge, origin TLS on nginx, a switch to Caddy and back | `OPSCREW_E2E_OWN_NGINX=1`, + `OPSCREW_E2E_GITHUB_REPO_B`, Docker here | **Not run yet** | — | — |
| Your existing Portainer, step 5b: the stack's Caddy with origin TLS, `secure --deep` with only testssl.sh, a redeploy under load | `OPSCREW_E2E_PORTAINER_STEPS=5b` (or `full`), Docker here | **Not run yet** | — | — |

Run in development, not tracked by date:

- `OPSCREW_DOCKER_TESTS=1` builds every example with its chosen builder (feature 012) and starts it
  in local Docker, and checks the Portainer stacks with `docker compose config` and
  `caddy validate`. All 25 examples (26 builds) passed on 2026-10-18 and 2026-10-19, after T1213's
  fixes; after the end-of-feature review's fixes, 14 of them (one or more per stack and builder)
  passed again, with the new search of each image's files, history and configuration (see
  [e2e.md](e2e.md#live-results)).
- `OPSCREW_IT=1` validates every infrastructure root with both OpenTofu and Terraform.

## Your existing Portainer, step by step

Tick a step once it has passed live. Since the simplification (T1031) any steps can be rerun on their own with
`OPSCREW_E2E_PORTAINER_STEPS=<list>`, for example `11,12` (see [e2e.md](e2e.md#running-chosen-steps)).

| Step | Pass | Passed live |
|---|---|---|
| 1. A throwaway server with Portainer CE, an admin, a limited user and the decoys | core | [x] 2026-10-15 |
| 2a. Preparing the project: init, analyze, interview, design, adapt (since the simplification, its own step) | core | [x] 2026-10-15 (as part of step 2); `init` 2026-10-16 |
| 2. Updater + tunnel: the limited token's registry steps, three provision runs, deploy, verify, secure, drift | core | [x] 2026-10-15 |
| 3. A merged change deploys by itself; a webhook call on an unchanged branch does not redeploy | core | [x] 2026-10-15 |
| 3b. A failing change rolls back (step 3 until the simplification) | full | [x] 2026-10-16 |
| 4. An apply through MCP that replaces the registry token | full | [x] 2026-10-16 |
| 5. Caddy: the app stack updated in place, the DNS record OpsCrew prints, certificates on 80/443 | full | [x] 2026-10-16 |
| 5b. Caddy behind Cloudflare's proxy: origin TLS in the stack, `secure --deep` with only testssl.sh, a redeploy under load with no failed request (feature 014) | full | [ ] |
| 6. Your own proxy: the app on a host port, `verify --url` | full | [x] 2026-10-16 |
| 7. Cloudflare redeploys with the tunnel: a deploy through Access, 404 outside the webhook, a token replace | full | [x] 2026-10-16 |
| 7b. A second app in the same Portainer, zone and account with the tunnel: both blocked on `/.env`, both in OpsCrew's probe block (feature 011) | core | [x] 2026-10-18 (after T1109) |
| 8. Destroy keeps the data volumes; Portainer, its settings and the decoys stay | core | [x] 2026-10-16; the second app still working after it: [x] 2026-10-18 |
| 9. `destroy --delete-data` removes the data volumes and nothing else | core | [x] 2026-10-16 |
| 9b. Destroying the second app removes OpsCrew's shared rules; the seeded rules and the Zero Trust pieces stay (feature 011) | core | [x] 2026-10-18 |
| From 2a on: a seeded rule of the user's own per phase byte-identical, and OpsCrew's shared rules listing exactly the live apps' hostnames, after every provision and destroy; the cleanup by `ref` (feature 011) | core | [x] 2026-10-18 |
| 10. A loopback Portainer address (the updater through `host.docker.internal`) | full | [x] 2026-10-16 |
| 11. A short Portainer host name in the leak check | full | [x] 2026-10-16; 2026-10-17 with a random short host |
| 12. No token, secret, server address or Portainer address anywhere | core | [x] 2026-10-15 (core pass); 2026-10-17 with step 11 (nothing found) |

## Your existing Portainer: behaviour still to confirm live

OpsCrew's adapter and tests assume these from Portainer CE 2.45's source and documentation. The
live test records each one as an `observed:` line.

| Assumption | Checked in | Confirmed |
|---|---|---|
| A webhook call for an unchanged branch does not redeploy | core (step 3) | [x] 2026-10-15 |
| `GET /api/stacks/{id}` returns `GitConfig`, `AutoUpdate` and `DeploymentStatus` with `Time` | core | [x] 2026-10-15 |
| A Git stack is updated with `POST /api/stacks/{id}/git`, then `PUT …/git/redeploy` | full (step 5) | [x] 2026-10-16 |
| `GET /api/stacks/{id}/file` returns a Git stack's deployed file (secure and drift rely on it) | core | [x] 2026-10-15 |
| GHCR accepts any registry user name: the owner (the guide's limited-token steps) and `opscrew-<app>` (OpsCrew's own entries, since T1109) | core | [x] 2026-10-15 (any user name works; the token decides) |
| A bare `NAME:` entry stays unset when the stack has no value for it | core | [x] 2026-10-15: **no**, it arrives as an empty value, like `${NAME}`; the guide already says so |
| Stopping a stack removes its containers; volumes carry the Compose project label | core (steps 8–9) | [x] 2026-10-15 |
| A registry token replace keeps the entry granted to the environment | full (steps 4, 7) | [x] 2026-10-16 |
| Starting a stopped stack answers only once it runs | full | [ ] (not exercised: no step stops a stack and starts it again) |
| The updater reaches a loopback Portainer through `host.docker.internal` | full (step 10) | [x] 2026-10-16 |
| cloudflared reaches Portainer with `no_tls_verify`; the hostname answers 404 outside `/api/stacks/webhooks/` | full (step 7) | [x] 2026-10-16 (401 without the service token) |
| GitHub accepts the orphan-branch calls and drift's `git fetch` with the user's fine-grained token | core | [x] 2026-10-15 |
| The smallest Cloudflare token for a tunnel-only `updater` setup | core, with `OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN` | [x] 2026-10-19: steps 2–3 (and up to step 8) ran with it; its permissions were exactly [the starting list](e2e.md#your-existing-portainer), the same as the guide's for tunnel mode: Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit, Zone → Config Rules → Edit, and Account → Cloudflare Tunnel → Edit. Whether a smaller list also works is not tested |
| The guide's `openssl` command shows the fingerprint OpsCrew pins | core | [x] 2026-10-15 |
| Two OpsCrew apps in one environment stay apart (their own stacks, registry entries and volumes, and their ports, 80/443 among them) | core (steps 7b, 8, 9b) | [x] 2026-10-18: their own stacks, registry entries and tunnels; volumes and ports are not checked |
| The guide's steps that need a person: the certificate fingerprint in a browser, the registry steps in Portainer's UI | not automated | [ ] |

## Several OpsCrew apps in one zone (feature 011): confirmed live

The test's own Cloudflare calls and checks assumed these; the live runs of 2026-10-18 confirmed all
but the one still open below.

| Assumption | Checked in | Confirmed |
|---|---|---|
| A rule the test seeds as the user's (a `block` WAF custom rule, a configuration rule with Automatic HTTPS Rewrites) is taken on the Free plan: `POST` to an existing rule list, `PUT` of the list only when the zone has none (404) | own server step 2, Portainer step 2a | [x] 2026-10-18, the `PUT` path (the zone had no rule lists); OpsCrew's own rule then went in by `POST` to the lists the seeds created |
| Cloudflare's answer to a blocked `/.env` is HTTP 403 with `cf-ray` and "you have been blocked", error 1020 or "access denied" in the page | own server steps 6b and 7, Portainer steps 7b and 8 | [x] 2026-10-18 (own server and Portainer, both apps, also after the first app's destroy) |
| The zone's rules OpsCrew did not create read back byte-identical (each whole rule, apart from the `version` and `last_updated` Cloudflare changes on its own) and in the same order after OpsCrew's writes | own server, Portainer (every provision and destroy) | [x] 2026-10-18 (own server: after each of the 4 provisions that changed something and both destroys; Portainer: after every provision and destroy) |
| After a failed destroy, the Hetzner pass's fallback removes the app's hostnames from OpsCrew's shared rules (`removeRulesOfRun`) | Hetzner with a Cloudflare domain and `OPSCREW_E2E_SKIP_DESTROY=1` (which skips destroy, so the fallback runs), or when destroy fails | [x] 2026-10-19 (both of OpsCrew's rules held only the run's hostname, so they and the run's two rulesets were deleted) |
| The Zero Trust organization and one-time PIN login stay after both apps' destroys | own server step 7b, Portainer step 9b | [x] 2026-10-18 (own server and Portainer) |
| The leak search finds no token in the Cloudflare plans (CLI output; MCP in Portainer) or any version of `.opscrew/cloudflare.json` | own server step 8, Portainer step 12 | [x] 2026-10-18 (own server and Portainer) |

## Image builders (feature 012)

The Hetzner pass checks these with `OPSCREW_E2E_BUILDS=1` and `OPSCREW_E2E_APP` set to
`nextjs-postgres`, `go-api` or `rust-api` (see [e2e.md](e2e.md#the-builders)). Tick each one per app once it has passed live. All three passed on 2026-10-19, with signing, and again after the end-of-feature review's fixes (T1218).

| Check | `nextjs-postgres` (generated Dockerfile) | `go-api` (Buildpacks) | `rust-api` (Railpack) |
|---|---|---|---|
| `app.build.builder` is the expected one, the strategy is `rolling`, and the build job ran the builder's steps | [x] | [x] | [x] |
| pack ran with the pinned builder and run images (`repo:tag@sha256:…`) | — | [x] | — |
| The app container's user is not root (`docker exec … id -u`) | [x] | [x] | [x] |
| The provenance (guide's command) names the repository and commit and holds no GitHub event data; the SBOM lists packages | [x] | [x] | [x] |
| No known secret in the provenance or SBOM | [x] | [x] | [x] |
| A merged change deploys under 20 requests per second with no failed request | [x] | [x] | [x] |
| The change's deploy restarts none of `db`, `cache`, `proxy` and `caddy` (those the plan has; each container's `StartedAt`) | [x] 2026-10-19 (db, proxy, caddy) | [x] 2026-10-19 (proxy, caddy) | [x] 2026-10-19 (proxy, caddy) |
| A release whose health route answers 500: no failed request, the run fails with the builder hint, the previous version still answers | [x] | [x] | [x] |
| After the image retention job, GHCR still has every blob of the first and the running image (the `build-<commit>` images deleted) | [x] | [x] | [x] |
| With `OPSCREW_E2E_SIGN=1`: `cosign verify` passes for the first and the running image after the later prunes (cosign v3 may store signatures as OCI referrers) | [x] | [x] | [x] |

Not covered by any live test:

- **Image retention on a package owned by an organization** (the `/orgs` endpoints of the
  retention job): the throwaway repository is owned by a user. Unit tests only.
- **kamal-proxy's `--target-timeout 300s`** letting a 60-second request through: no example has a
  slow route.
- **Railpack with a secret build value that is empty at `prepare`**: no example has a secret build
  value.
- **The `recreate` strategy** (servers under 1 GiB) and its rollback: unit tests only; every live
  server had more memory.
- **Rails, Laravel, Spring Boot and .NET on a real server**: only the local Docker pass builds and
  starts them. The framework matrix on Hetzner (19 apps) last ran on 2026-10-14, before 012's
  builders.
- **DigitalOcean with kamal-proxy, and an arm64 server's build**: no live run (no DigitalOcean
  token; every Hetzner run used x86).
- **A request in flight while the old copy drains**: no example has a slow route.
- **Dependabot's first runs after the deploy-setup pull request** (T1214): checked by the lead in
  the throwaway repository's Actions after the pass on 2026-10-19 (all four succeeded); no test
  asserts it.

## Components (feature 013)

The Hetzner pass checks these with `OPSCREW_E2E_COMPONENTS=1` and `OPSCREW_E2E_APP` set to each
example below (see [e2e.md](e2e.md#the-components)); "—" where the example has nothing to check.
Tick each one once it has passed live.

| Check | `node-bullmq` | `express-mysql` | `node-mongo` | `s3-uploads` on R2 | `s3-uploads` on Hetzner | `rabbitmq-worker` | `kafka-app` | `meili-search` (+ OpenSearch) | `clickhouse-events` |
|---|---|---|---|---|---|---|---|---|---|
| `opscrew status` shows every component running | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Every container of the app and the edge has its memory limit, no swap beyond it | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| No port published but the edge's Caddy, the app on the edge's network, no service port answers from outside | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Nothing restarted or met its limit, after the first deploy and after the reboot | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| Each `/srv/data/<app>/<service>` holds data and belongs to its service's user | [x] | [x] | [x] | — | — | [x] | — (named volume) | [x] | [x] |
| Each mounted settings file readable by its service, writable only by its owner | [x] (crontab) | [x] | — | — | — | [x] | — | — | [x] |
| The settings are honoured | — | [x] `@@innodb_buffer_pool_size` | — | — | — | — | — | — | [x] `max_server_memory_usage` |
| The kernel setting in `/etc/sysctl.d/90-opscrew.conf` and in use, also after the reboot | — | — | — | — | — | — | — | [x] `vm.max_map_count` | — |
| A queued job is consumed within 30 seconds (SC-1302) | [x] | — | — | — | — | [x] | [x] | — | — |
| The cron job runs within a minute of its schedule (SC-1302) | [x] | — | — | — | — | — | — | — | — |
| A value written through the app survives a deploy and a reboot (SC-1303) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| `opscrew drift` passes after the reboot | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| The leak search finds nothing (SC-1306) | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| The teardown deletes the bucket (`--delete-data`); the key stays the user's | — | — | — | [x] | [x] | — | — | — | — |

Your own server with two apps (steps 6b–7b) and Portainer (step 7b):

| Check | Passed live |
|---|---|
| Own server: a second app on the same server, Garage's bucket written and read back, both apps' components checked on the server, one Caddy serving both | [x] |
| Own server: a change to each app under 20 requests per second each, with no failed request (SC-1305) | [x] |
| Own server: the first app's destroy causes no failed request to the second; the edge and the `deploy` user stay | [x] |
| Own server: the second app's destroy with `--undo-host` removes the edge, `/srv/edge` and the `deploy` user | [x] |
| Portainer: the second app's stacks (MongoDB) within their limits, no port published, the data kept across a restart | [x] |
| Portainer: OpenSearch added to `plan.yaml` refused for its kernel setting before any change | [x] |

Not covered by any live test:

- **NATS, SQLite, MariaDB, Redpanda, Typesense, Elasticsearch and Neo4j on a real server**, and
  `celery-worker` and `flask-sqlite`: only the local Docker pass (and, for the engines, the engines
  check) starts them. OpenSearch runs live only as the service added to `meili-search`.
- **DigitalOcean Spaces**, and any component on DigitalOcean: no DigitalOcean token.
- **Garage in a Portainer**, and MongoDB as a replica set (its one-shot `-init`): the local Docker
  pass only.
- **A browser upload from the app's own domain** through the bucket's CORS rule: `s3-uploads`
  uploads its presigned URL from the server, not from a browser.
- **`opscrew destroy` without `--delete-data` keeping the bucket** (FR-1319): unit tests only; the
  live teardown always deletes it.
- **The sum of the limits against the server's memory** (SC-1304): design's sizing, unit tests only;
  the live checks look at each container's limit.
- **Retarget's refusal for an app with MySQL, MongoDB, a broker, an engine or SQLite**: unit tests
  only.

## SecOps and TLS (feature 014)

The passes are in [e2e.md](e2e.md#origin-tls-the-recovery-copy-and-the-deeper-checks). None has
run live yet; tick each check once it has passed. Every pass ends with the leak search and the
zone check after the teardown.

| Check | Where | Passed live |
|---|---|---|
| The site works through Cloudflare with origin TLS; the record's origin certificate covers exactly the app's hostnames and each origin pull setting is on with the app's client certificate | Hetzner `proxied`, `live`; own server step 8; Portainer 5b | [ ] |
| From the server, `openssl s_client` to 127.0.0.1:443 without the client certificate is refused (Caddy: the alert; nginx: HTTP 400), the issuer is Cloudflare's Origin CA, an unknown hostname is refused | Hetzner `proxied`, `live` (Caddy); own server step 8 (nginx, under the web filter); Portainer 5b | [ ] |
| The origin check reaches 127.0.0.1:443 under OpsCrew's web filter (else the edge-network fallback runs and a finding asks for it in `secure`; research "Spike results" 14) | own server step 8 | [ ] |
| `secure --deep` within 5 minutes, no high finding from testssl.sh, ssh-audit's policy passing apart from the noise (T1418), Lynis's hardening index | Hetzner `proxied` (Caddy); own server step 5 (nginx) | [ ] |
| `secure --deep` in a Portainer: only testssl.sh, Lynis and ssh-audit skipped with their reason | Portainer 5b | [ ] |
| Origin protection turned on for an app already live, with no failed request under 20 requests per second (SC-1408); the permission gap recorded before (FR-1405) | Hetzner `live` | [ ] |
| CAA records at the app's DNS-only hostname (Caddy: `letsencrypt.org`, `sectigo.com`; nginx: `letsencrypt.org`), none added at the apex, none left after destroy | Hetzner `dns-only`; own server steps 2, 6, 10 | [ ] |
| The zone's minimum TLS raised to 1.2 only when every proxied record is OpsCrew's, otherwise unchanged | every Hetzner pass | [ ] |
| The recovery copy: a fresh clone, `secrets restore --key-file`, nothing to apply, nothing regenerated, the data intact, within 5 minutes (SC-1402) | Hetzner `recovery` | [ ] |
| certbot's first certificate during the first deploy (Let's Encrypt), for two apps on one nginx edge | own server steps 2, 6 | [ ] |
| An addition served on nginx, with OpsCrew's headers kept | own server step 3 | [ ] |
| A forced certbot renewal under load: no failed request, the new certificate served (FR-1441) | own server step 4 | [ ] |
| Another proxy refused while two apps share the edge | own server step 6 | [ ] |
| A switch to Caddy and back with one app left, each within the stated interruption (15 seconds at most for a proxied hostname) | own server step 9 | [ ] |
| A Portainer redeploy under load shows a pause, not an error (T1416) | Portainer 5b | [ ] |
| Destroy revokes the origin certificate and removes the client certificate and the origin pull settings; nothing else in the zone changes (records, other certificates, the minimum TLS) | every Hetzner pass (the zone check after the teardown); own server step 10; the cleanup of every own-server and Portainer run | [ ] |
| The leak search (SC-1406): no generated key, client key or age identity in the run's outputs, commits, pull requests, audit entries, saved plans, reports, record, state or folder copy | every pass | [ ] |

Not covered by any live test:

- **Renewing an origin certificate** (fewer than 30 days left) and revoking the superseded one: it
  is valid for 15 years, so no run gets there; unit tests only.
- **A hostname leaving Cloudflare's proxy in two runs** (proxied to DNS only) on a server: no pass
  makes that switch; unit tests only.
- **Two apps on one server, one DNS-only and one proxied**, as quickstart.md has it: the host plan
  refuses mixed access modes on one server, so the nginx pass runs them one after the other.
- **Valkey's password** and the deeper check's "files unchanged": the local Docker pass only.
- **`opscrew secrets rotate`**, a backup recipient, and the copy changed on another computer
  (`SECRETS_COPY_CHANGED_ELSEWHERE`): unit tests only.
- **The `vercel.json` translation on a real server**: the local Docker pass only.
- **DigitalOcean with origin TLS**: no DigitalOcean token.
