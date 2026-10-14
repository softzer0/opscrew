# Live end-to-end test

`packages/cli/test/live/live.test.ts` runs the whole OpsCrew flow against real services, once for
each cloud provider whose token is set (Hetzner Cloud, DigitalOcean, or both, one after the other):

1. It force-pushes the app (`examples/nextjs-postgres` by default, see
   [Choosing the app](#choosing-the-app)) to the `main` branch of a throwaway GitHub repository,
   then closes its open pull requests and deletes every other branch, so an earlier run never
   changes this one.
2. It runs `analyze --no-ai`, then `interview --answers` (with the provider and
   `OPSCREW_E2E_REGION`) and `design`.
3. It runs `adapt --no-ai --yes` and merges that pull request through the GitHub API.
4. It runs `provision --plan-only --yes` and then `provision --approve <hash> --yes`, which creates a real server (or Droplet).
5. It merges the deployment pull request and waits for the `opscrew-deploy.yml` workflow to succeed.
6. It runs `verify`, checks that the app answers 200 on the health path from `opscrew/plan.yaml`,
   then runs `secure` and `drift` (which must report no differences).
7. It tears everything down with `opscrew destroy --confirm`.

When both `OPSCREW_E2E_HCLOUD_TOKEN` and `OPSCREW_E2E_DIGITALOCEAN_TOKEN` are set, a third pass
tests `opscrew retarget`: it deploys on Hetzner Cloud, writes a row into the app's database over
SSH, moves the deployment to DigitalOcean non-interactively (each plan approved by the hash the
previous run printed, `--allow-downtime`, and `--dns-switched` without a Cloudflare domain), reads
the row back on the new server (SC-501), finishes the move (`--finish --confirm <name>`) and tears
everything down. If the move stops half-way, the cleanup deletes what is left on both providers
through their APIs. The move reads its row from the app's Postgres service, so it runs only with
the default app.

The test is skipped unless its environment variables are set, so normal runs and CI never start it.

## Setup

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_HCLOUD_TOKEN` | Runs the Hetzner Cloud pass. API token (Read & Write); use a separate, empty project. |
| `OPSCREW_E2E_DIGITALOCEAN_TOKEN` | Runs the DigitalOcean pass. Personal access token with the custom scopes listed in `specs/004-digitalocean/research.md` (or Full Access); use a separate team or an account with nothing else in it. |
| `OPSCREW_E2E_APP` | Optional, the app to deploy: a folder name under `examples/` (default `nextjs-postgres`) or `github:<owner>/<repo>@<commit>`. See [Choosing the app](#choosing-the-app). |
| `OPSCREW_E2E_AI` | Optional, `1` runs `analyze` and `adapt` with a model instead of `--no-ai` (needs `ANTHROPIC_API_KEY`; costs model usage). Use it for apps whose health route only the Code-change agent can add. |
| `OPSCREW_E2E_APP_ENV` | Optional path to a file of production values (`NAME=value` lines) for the variables the app needs that OpsCrew cannot derive or generate (for example an API key or mail settings); without it the test supplies none, and `provision` stops if the app requires any. Use stand-in values, never real secrets. |
| `OPSCREW_E2E_REGION` | Optional interview region, default `eu-central` (Nuremberg/Falkenstein on Hetzner, Frankfurt/Amsterdam on DigitalOcean). |
| `OPSCREW_E2E_GITHUB_REPO` | `owner/name` of a **throwaway** repository. The test force-pushes its `main` branch. |
| `OPSCREW_E2E_GITHUB_TOKEN` | Fine-grained token for that repository only. It needs Contents, Pull requests, Secrets, Actions and Workflows (read and write), plus Metadata (read). |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Optional. A Cloudflare token limited to one zone, with Zone Read, DNS Edit, Config Rules Edit and Zone WAF Edit. |
| `OPSCREW_E2E_DOMAIN` | Optional, used together with the Cloudflare token: a hostname in that zone, for example `e2e.example.com`. |

Requirements:

- `git`
- OpenTofu or Terraform (version 1.6 or newer)
- `ssh` and `ssh-keyscan`
- Node.js 22+

Run it:

```bash
pnpm --filter opscrew build
OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  pnpm --filter opscrew exec vitest run test/live
# DigitalOcean instead (set both tokens to run both passes, one after the other)
OPSCREW_E2E_DIGITALOCEAN_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  pnpm --filter opscrew exec vitest run test/live
```

### Choosing the app

`OPSCREW_E2E_APP` picks what the test deploys. Without it the test deploys
`examples/nextjs-postgres`, exactly as before.

- `OPSCREW_E2E_APP=fastapi-redis` deploys `examples/fastapi-redis` (any folder under `examples/`).
- `OPSCREW_E2E_APP=github:<owner>/<repo>@<commit>` deploys a public GitHub repository at exactly
  that commit. The commit must be the full 40-character SHA (branches, tags and short SHAs can
  move). The test fetches only that commit (`git fetch --depth 1`, no token), drops the source's
  `.git` and commits the files into the throwaway repository. It never pushes or writes to the
  source repository.

The value is checked before any GitHub or cloud call: an unknown example or a ref that is not a
full commit SHA stops the test with a plain message. The test title, the commit message in the
throwaway repository (`e2e: examples/<name>` or `e2e: github:<owner>/<repo>@<sha>`) and the
`OpsCrew E2E:` log lines name the app. The test takes the health path from the plan OpsCrew wrote
(`opscrew/plan.yaml`), not from a framework default.

To run the framework matrix, run one app after another (each pass creates and destroys its own
server; the throwaway repository is reset before each one):

```bash
pnpm --filter opscrew build
cd packages/cli
export OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=…
for app in nextjs-postgres fastapi-redis static-vite \
  "github:softzer0/slog_cvrp_app@<40-character commit SHA>"; do
  echo "=== $app"
  OPSCREW_E2E_APP="$app" npx vitest run test/live/live.test.ts || echo "FAILED: $app"
done
```

The DigitalOcean pass also confirms the facts `specs/004-digitalocean/research.md` marks as
"confirm live" (image slug, Droplet network fields, snapshot listing, pagination).

The test sets `CI=1`, so every command runs non-interactively:

- `--yes` approves writing files, storing deploy secrets, pushing and opening pull requests.
- `--approve <hash>` applies exactly the plan the first provision run printed.

## Cost and cleanup

Each pass runs the server of the recommended design (budget 20 EUR on Hetzner, 25 USD on DigitalOcean) for about 15–30 minutes. At the providers' hourly or per-second prices that is a few cents per pass. GitHub Actions minutes for the build are free for public repositories and minimal otherwise.

Teardown runs in a `finally` block, so it happens even after a failure:

1. It runs `opscrew destroy --confirm <name> --no-snapshot`, the same command a user runs. On
   Hetzner it lifts delete protection first; on DigitalOcean (no delete protection) it goes
   straight to the destroy plan. Each plan is approved by its hash; then the deploy secrets are
   removed.
2. It asserts that nothing OpsCrew created for the app remains (SC-301, SC-401): on Hetzner no
   server, firewall or SSH key labelled `managed-by=opscrew,app=<name>`; on DigitalOcean no
   Droplet tagged `opscrew-app:<name>`, no firewall `<name>-firewall`, no SSH key `<name>-deploy`
   and no `opscrew-app:<name>` tag.
3. If `opscrew destroy` failed, it falls back to applying a destroy plan with the engine directly
   (lifting protection first on Hetzner), then to deleting those resources through the provider
   API, and asserts again that nothing is left. The shared `managed-by:opscrew` DigitalOcean tag
   is never deleted.

Some things are not removed:

- **Cloudflare DNS records:** the IaC destroy removes them, but the API fallback does not. Check the zone if a run failed.
- **GitHub repository state:** the pushed container image (GHCR package), the Actions secrets and
  the pull requests stay in the throwaway repository (GitHub cannot delete pull requests; the next
  run closes open ones, deletes the branches and overwrites the rest). Delete and recreate the
  repository for a completely clean slate.

## Domain purchase (Cloudflare registrar sandbox)

`packages/cli/test/live/domain.test.ts` checks `opscrew domain search` and `opscrew domain buy`
against Cloudflare's registrar sandbox, which only simulates purchases (.com and .net). It runs
when these are set:

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN` | A Cloudflare token with Registrar access for the account. |
| `OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID` | The account id to use. |

The test sets `OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1`, which sends every registrar call to the
sandbox and skips the zone and DNSSEC setup (the sandbox does not cover zones), so no real domain
is bought and no zone is created. It checks that a script cannot buy without `--confirm`, buys a
random `.com` with `--confirm` and `--max-price`, and confirms through the API that the sandbox
registration succeeded. It runs in a planned project (analyze, interview and design on
`examples/nextjs-postgres`), so it also checks that `opscrew/plan.yaml` records the purchase
(`dns.registration`), that `opscrew domain status` shows it and that `opscrew domain auto-renew off
--confirm <domain>` works. Response shapes and states are exercised along the way; the token
permission name and multi-year billing still need a check against the real API.

The sandbox has no Express Mode: it ignores the account's default registrant contact and wants the
contact sent with each purchase. In sandbox mode OpsCrew therefore sends a made-up contact
(an `example.com` address, a fictional 555-01xx number); real purchases never send one and use the
account's own contact. The real purchase of `opscrew.dev` (Live results, 2026-10-14) covers the
purchase path against the real API.

## Domain purchases at Porkbun and Namecheap (registrar sandboxes)

`packages/cli/test/live/registrars.test.ts` buys through Porkbun's and Namecheap's test systems,
so no real domain is bought. Each pass runs when its variables are set, together with the
Cloudflare pair above (the Cloudflare token is only used to resolve the account: registrar
sandboxes get stand-in Cloudflare zones, because the sandbox domains do not exist).

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_PORKBUN_API_KEY` | A Porkbun **sandbox** API key (starts with `pk1_sb_`; the test refuses live keys). |
| `OPSCREW_E2E_PORKBUN_SECRET_KEY` | Its secret key (`sk1_sb_…`). |
| `OPSCREW_E2E_NAMECHEAP_API_USER` | The API user of an account at sandbox.namecheap.com (API access enabled, this computer's IPv4 whitelisted, some sandbox funds and a default address in the address book). |
| `OPSCREW_E2E_NAMECHEAP_API_KEY` | Its sandbox API key. |
| `OPSCREW_E2E_NAMECHEAP_USERNAME` | Optional; defaults to the API user. |
| `OPSCREW_E2E_NAMECHEAP_CLIENT_IP` | Optional; the whitelisted IPv4 (detected through Cloudflare's trace page when unset). |

The Porkbun pass resets the sandbox (fresh test credit), checks a random `.com` with
`opscrew domain search --registrar porkbun`, checks that a script cannot buy without `--confirm`,
buys it with `--confirm` and `--max-price`, and confirms through the API that the domain is
registered and its nameservers point at the stand-in zone. It then checks that the plan records
Porkbun, that `domain status` and `domain auto-renew off` work, adds and removes a DS record through
the adapter, registers a second sandbox domain and moves it with `opscrew domain connect`.

The Namecheap pass sets `NAMECHEAP_SANDBOX=1`, checks the balance, buys a random `.com` (the
registration uses the sandbox account's default address, in memory only), confirms the
registration and the nameservers through the API, and checks that `domain auto-renew` points to
Namecheap's dashboard (Namecheap has no API for it). It then registers a second sandbox domain
through the adapter (quote, then register), moves it with `opscrew domain connect --registrar
namecheap`, and confirms through the API that its nameservers point at the stand-in zone.

GoDaddy has no public test system for its v3 API, so its adapter is only tested with fakes.

## Live results

| Date | Pass | Outcome | Findings and fixes |
|---|---|---|---|
| 2026-10-13 | `opscrew init`, `domain search --registrar namecheap` (real Hetzner, Cloudflare, Namecheap; read-only) | Passed | An account-owned Cloudflare token is handled; a domain in the user's own Namecheap account was called "registered by someone else" (fixed, T803) |
| 2026-10-13 | `domain connect poasjet.com --registrar namecheap --records-file …` (real Namecheap and Cloudflare) | Passed | Zone active within minutes; a null MX was given a misleading reason (fixed, T803) |
| 2026-10-13 | Hetzner, run 1 | Failed at the deploy workflow | The Next.js image needed `output: "standalone"`, a change only the Code-change agent made (fixed, T802); teardown left nothing |
| 2026-10-13 | Hetzner, run 2 | Failed at `adapt` | The first run's `opscrew/prepare-deploy` branch was still on GitHub (product fix T808, test reset T809); the health route stayed a manual change without a model (fixed, T808) |
| 2026-10-13 | Hetzner, run 3 | Test error | The test read the first run's failed workflow before the new run existed (test waits for the merge commit's run); the image built and pushed for real |
| 2026-10-13 | Hetzner, runs 4–5 | Failed at `drift` | Deployed, verified and secured; drift reported the firewall's `apply_to`, which Hetzner mirrors from the server (fixed, T812; every provider's read-only values, T813) |
| 2026-10-13 | Hetzner, run 6 | Test error | GitHub refused the merge while it was still computing mergeability (the test waits for it) |
| 2026-10-13 | Hetzner, run 7 | **Passed** | Full flow in 6½ minutes: analyze → interview → design → adapt PR → provision → deploy workflow → verify → secure → drift clean → destroy; nothing left behind (SC-801) |
| 2026-10-13 | Hetzner + Cloudflare domain (`e2e.poasjet.com`, proxied) | **Passed** | Full flow in 9 minutes including a manual look: the founder opened https://e2e.poasjet.com (valid certificate, served through Cloudflare); `verify`, `secure` and `drift` clean; teardown removed the server, firewall, SSH key, DNS records and OpsCrew's rule sets, leaving the zone's own records (SC-802). The server address never appeared in committed files or pull requests (T814) |
| 2026-10-14 | `domain search` on the real Cloudflare Registrar | Passed after a fix | The client sent `query=` where the live API expects `q=` (fixed) |
| 2026-10-14 | Cloudflare Registrar sandbox purchase | Stopped correctly | Before the fix, every purchase stopped at the status check: the live API answers "No workflow found for <domain>" / "Domain not found" with code 10000 (fixed, matched exactly); then the sandbox refused the purchase: it ignores the account's default registrant contact and wants the contact sent with each purchase, which OpsCrew never does; OpsCrew said "Nothing was bought" |
| 2026-10-14 | Porkbun sandbox (buy, nameservers, DS records, `domain connect`) | **Passed** | A fresh sandbox domain has no nameservers, so `connect` takes the records from a BIND file (test updated) |
| 2026-10-14 | Namecheap sandbox purchase | Stopped correctly | The sandbox account's default address has only a name and email; OpsCrew named the missing fields and bought nothing (account setup) |
| 2026-10-14 | AI path (`analyze`, `adapt` with a model on examples/fastapi-redis) | `analyze` passed ($0.0034); `adapt` failed | The tool policy blocked the SDK's `StructuredOutput` tool, so the Code-change agent could not return its report after editing `main.py` correctly ($0.10) (T818) |
| 2026-10-14 | **Real purchase: `opscrew domain buy opscrew.dev`** (interactive, PowerShell on Windows) | **Passed** | Bought at Cloudflare for $8.20 after the founder typed the domain; zone active with Cloudflare nameservers delegated, DNSSEC on (zone signed; the registry's DS record follows from Cloudflare Registrar), auto-renew and WHOIS privacy on |
| 2026-10-14 | Cloudflare Registrar sandbox purchase, rerun | **Passed** | OpsCrew now sends a made-up contact to the sandbox only (fixed); bought with `--confirm` and `--max-price`, recorded in the plan, `domain status` and `domain auto-renew off` worked |
| 2026-10-14 | Namecheap sandbox purchase, rerun | **Passed** | After the founder completed the sandbox default address: bought with it, nameservers on the stand-in zone, `domain connect` of a second domain |
| 2026-10-14 | Framework matrix, local Docker pass (13 examples, `OPSCREW_DOCKER_TESTS=1`) | **Passed** after fixes | Every static site would have crash-looped under the production hardening (`caddy` carries a file capability refused under `cap_drop: ALL`, T827); NestJS started with a compiling `nest start` (T828); no SSR framework's health route was found, SvelteKit and Astro had no start command, React Router framework mode was taken for a static site and Astro listened on localhost only (T828); Django answered 400 to every host (T829); the two-app monorepo's lockfile was a stub (fixed) |
| 2026-10-14 | Framework matrix on Hetzner without a model: Express, Fastify, Hono, NestJS, Next.js, Vite, Angular, Nuxt, SvelteKit, React Router, Astro | **Passed** (11 apps) | Each deployed, answered its planned health path, passed `verify`, `secure` and `drift`, and was torn down. Test fixes on the way: older runs' pull requests may name a reused server address (now a warning, not a failure), OpsCrew rightly opened `opscrew/deploy-setup-2` when the previous branch was still on GitHub, and a stopped runner loop kept running as an orphan on Windows and collided with its restart (one run discarded, nothing left on Hetzner) |
| 2026-10-14 | Django + Postgres on Hetzner | Failed, then **passed** | The health route answered 200 but `/` returned 500: OpsCrew never ran migrations, so the tables did not exist. Deploys now run the app's release command first (T830); the rerun applied the migrations and `/` answered 200 |
| 2026-10-14 | FastAPI + Redis on Hetzner **with a model** (`OPSCREW_E2E_AI=1`) | **Passed** | The Code-change agent added a `/health` route to `main.py` that touches neither Redis nor any dependency; deploy, `verify`, `secure` and `drift` clean |
| 2026-10-14 | `softzer0/slog_cvrp_app` (Flask + SQLAlchemy + Celery) on Hetzner with a model | Stopped at provision, then at the app's own image build | First run: OpsCrew warned that the Celery worker is not deployed yet (T826) and planned `FLASK_APP=app/project/__init__.py flask db migrate` (T830), then stopped for missing values: the app reads `DATABASE_URI` and a Redis-backed `CELERY_BROKER_URI`, uses Redis only through `flask-redis` and Celery, and loads `FLASK_*` settings by prefix. After T832 (rerun with stand-in values for its Mapbox key and mail settings): Postgres and Redis planned, `DATABASE_URI`, `CELERY_BROKER_URI` and `FLASK_REDIS_URL` derived, `FLASK_SECRET_KEY` generated, the server provisioned; the deploy workflow then failed in the repository's own root `Dockerfile`, which OpsCrew keeps as it is: its unpinned `python:slim-bullseye` base now brings a Python the early-2023 pins cannot build for, and its `CMD` starts an `app.py` that does not exist. Checking a found Dockerfile and offering a builder instead belongs to feature 009; the Celery worker to 010. Nothing was left on Hetzner |
| 2026-10-14 | Breadth round, local Docker pass (17 examples) | **Passed** (58 checks) | The four new ORM examples ran their release commands against Postgres and answered 200 on `/`, which writes a row: `alembic upgrade head` (SQLModel), `npx drizzle-kit migrate`, `npx typeorm migration:run -d dist/data-source.js`, `npx knex migrate:latest` (T833); `fastapi-redis`, `express-drizzle` and `koa-knex` got their health routes without a model (T834) |
| 2026-10-14 | Breadth round on Hetzner without a model: FastAPI + SQLModel/Alembic, Express + Drizzle, NestJS + TypeORM, Koa + Knex, FastAPI + Redis | **Passed** (5 apps) | Each deploy ran the app's migrations on the server before switching, `/` answered 200 with the tables in place, and `verify`, `secure` and `drift` were clean; FastAPI + Redis, which needed a model for its health route before, now deploys with none. `DATABASE_URL` now uses `postgresql://`, which SQLAlchemy accepts |
