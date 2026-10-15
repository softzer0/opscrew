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
- Node.js 22.9+

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

## Your own server

`packages/cli/test/live/own-server.test.ts` runs the flow for a server the user already has
(feature 009) on a real server that OpsCrew did not create:

1. It creates a throwaway Hetzner Cloud server directly through the Hetzner API (Ubuntu 24.04, the
   cheapest x86 type offered near `OPSCREW_E2E_REGION`, labels `managed-by=opscrew-e2e` and
   `run=<id>`), with an SSH key generated for this run in a temporary folder (never in the
   repository, never printed). It waits for SSH and cloud-init and checks the host key fingerprint
   on the server itself. OpsCrew never gets the Hetzner token: to OpsCrew this is the user's own
   server, reached as `root` with that key.
   Each run serves the app on its own hostname, `e2e-<run id>.<zone>`, where the zone is
   `OPSCREW_E2E_DOMAIN` without its first label when it has more than two labels
   (`e2e.example.com` gives `e2e-<run id>.example.com`), or `OPSCREW_E2E_DOMAIN` itself when it is
   already the zone apex. Every run's fresh server asks Let's Encrypt for a certificate, and
   Let's Encrypt issues at most 5 certificates per 7 days for the same set of names, so a fixed
   hostname stops working after a few runs a week. The name stays one level below the zone because
   Cloudflare's free edge certificate covers only `<zone>` and `*.<zone>`; the run stops with an
   error when the hostname is not directly below the zone Cloudflare reports.
2. **DNS only**: `init --fix` first, as a user would (before the interview only the cloud provider
   token check may fail, with its hint that a server you already have needs no token; the
   `.gitignore` lines it adds are committed to `main`), `analyze --no-ai`, `interview --answers`
   (own server, `root`, the key's path, `server.serve: dns-only`), `init` again (now everything
   passes), `design --host-key <fingerprint>`, `adapt --no-ai --yes` (pull request
   merged), `provision --plan-only` then `provision --approve <infrastructure> --approve <host plan>`,
   merge of the deploy pull request and its workflow run, then the domain answers from the server
   itself (not proxied), `verify`, `secure` (no failed check) and `drift` pass and root still logs
   in with its key. The step measures the time from the start of `init` to the passing `verify`
   (SC-901) and logs it; when that takes 20 minutes or more, the run fails at the end (step 8), after
   the later steps.
3. `provision --plan-only` again: nothing to apply.
4. `portainer enable` (plan, then `--approve`): ports 9443, 9000 and 8000 do not answer on the
   server's addresses; through the SSH tunnel command `portainer status` prints, Portainer answers,
   the admin account exists and logs in with the password from OpsCrew's password file.
5. **The Cloudflare-only filter** (`server.serve: proxy`, interview and design again, provision,
   deploy): Portainer stays on, the domain answers through Cloudflare, ports 80 and 443 do not
   answer on the server's IPv4 address (nor on its IPv6 address, which is probed only when the
   test computer has an IPv6 route; the test says so when it has none), `ss -ltnuH` on the server
   shows no IPv6 or every-address listener on 80/443, `verify` passes. The server then reboots:
   while it starts, the test keeps probing its own addresses (none may answer) until the site
   answers through Cloudflare again; on the server `opscrew-web-filter.service` is active and
   became active no later than `docker.service`; then `drift` must be clean.
6. **The tunnel** (`server.serve: tunnel`): the switch runs as two applies. The first one removes
   the old DNS records, so it is approved with its hash and the app's name, both taken from the
   command `--plan-only` prints (`provision --approve <removal hash> --confirm <app>`); the second
   one, the new setup, with its own `--approve` hashes. Then: ufw is active and lists only SSH
   rules, the domain answers through the tunnel, 80/443 stay closed, `verify` and `drift` pass, and
   the SSH hostname (`ssh-<app>.<zone>`) refuses a request without the service token. The deploy
   workflow on `main` names that hostname and `cloudflared access ssh`; a merged change then
   deploys, and sshd's journal on the server shows every `deploy` login of that run coming from
   `127.0.0.1` or `::1` (the tunnel connector), not from GitHub's runners.
7. `destroy --confirm <app> --undo-host`, then again with `--approve <undo host plan hash>`: no DNS
   record, tunnel, Access application, policy or service token of the app is left in Cloudflare,
   no container of the app and no `deploy` user are left on the server, and root still logs in
   with its key.
8. Nothing leaked: the server's addresses (IPv4, IPv6 and its `/64` prefix), the private keys,
   the state passphrase, the tunnel token, the Access service token, the Portainer password and
   the `OPSCREW_E2E_APP_ENV` values (those of 8 characters or more) are in no commit (any branch,
   messages and contents) and no pull request of the run; no secret is in any CLI output or
   OpsCrew's audit log; and the CLI shows the server's address only in the Portainer tunnel command
   (`deploy@<address>`) and in "your server at <address>" messages (host key and reachability).
   Those mentions are cut out of a line before the rest of it is searched. When the tunnel or
   service-token secrets could not be read, the run fails with a finding that says so.

Each step logs what it waits for. The steps stop at the first failure (a timeout too), but the
cleanup always runs:

- It deletes the throwaway server and its SSH key: everything labelled with the run's id, and
  nothing else, then reports any server or key still listed under that label.
- It removes what this run created in Cloudflare for the app, also after a finished `destroy`
  (which should have left nothing): DNS records on the run's hostname, `www.`, `ssh-<app>.` and
  `portainer.`, the tunnel `opscrew-<app>`, the Access applications and policies and the service
  token named after the app, and the zone's OpsCrew rulesets (configuration and WAF rules) that
  this run created, those whose rules name only the run's hostnames. Anything that existed before
  the run is skipped, including rulesets of other apps or earlier runs.
- It resets the throwaway repository: closes every open pull request and deletes every branch
  except `main`.

Everything the test prints goes through a scrubber that masks the server's addresses and every
secret it knows.

If a run was interrupted (the process killed, so the cleanup never ran): in the Hetzner project,
delete the servers and SSH keys labelled `managed-by=opscrew-e2e`; in Cloudflare, delete the DNS
records on the run's hostname `e2e-<run id>.<zone>` (the id is the server's `run=<id>` label) and
on `www.`, `portainer.` and `ssh-<app>.`, the tunnel `opscrew-<app>`, the Access applications `OpsCrew SSH (<app>)`, the Access policy and service token `OpsCrew deploy (<app>)`, and the zone's
OpsCrew rulesets whose rules name only that run's hostnames.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_OWN_SERVER` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write), used only by the test to create and delete the throwaway server. Use a separate, empty project. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | The throwaway repository and its token, as above. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | A Cloudflare token for the zone with Zone Read, DNS Edit, Config Rules Edit and Zone WAF Edit, plus the account permissions tunnel mode needs: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit, Access: Organizations, Identity Providers, and Groups Edit. Cloudflare Zero Trust must be turned on for the account. |
| `OPSCREW_E2E_DOMAIN` | A hostname one level below that zone, for example `e2e.example.com`, or the zone itself. It names the zone only: each run uses its own hostname `e2e-<run id>.<zone>` (see step 1) and owns its records while it runs. |
| `OPSCREW_E2E_REGION` | Optional, where the server runs: `eu-central` (default; Nuremberg, then Falkenstein, then Helsinki), `us-east`, `us-west` or `ap-southeast`. |
| `OPSCREW_E2E_OWN_SERVER_TYPE` | Optional, a Hetzner server type to use instead of the cheapest x86 one, for example `cx23`. |
| `OPSCREW_E2E_APP`, `OPSCREW_E2E_APP_ENV` | Optional, as above, but only examples under `examples/` (default `nextjs-postgres`). |

Requirements: the built CLI, `git`, OpenTofu or Terraform, `ssh`, `ssh-keygen` and `ssh-keyscan`,
Node.js 22.9+, and outgoing SSH (port 22) from the test computer. Run only this file, never together
with the other live tests (they share the throwaway repository):

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_OWN_SERVER=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/own-server.test.ts
```

A full run takes about 26 minutes (measured on the passing runs; it includes five deploy workflow
runs, Docker's installation on the server and a reboot). The server is the smallest x86 type, billed by the hour at Hetzner, so a run
costs about one or two cents of server time, plus GitHub Actions minutes for the builds (free for
public repositories). Left behind on purpose: the GitHub Actions secrets and the container image
in the throwaway repository (as above), the zone's rulesets that existed before the run, and the
Zero Trust organization if OpsCrew created it (other apps may use them).

## Price tables

Before each release, check that the dated price tables OpsCrew falls back to without a token still
match the providers. `packages/connectors/hetzner/src/static-prices.live.test.ts` and
`packages/connectors/digitalocean/src/static-prices.live.test.ts` read the live catalogue with the
same tokens (read-only calls, nothing is created or billed) and fail with a list of every
difference: prices to the cent, server types or sizes and locations or regions missing on either
side, and Hetzner's IPv4 price and backup percentage. Without the token each live check is
skipped. When one fails, update the table and its `STATIC_PRICES_AS_OF` from the live values. The
DigitalOcean API has no backup or traffic prices, so check `BACKUP_PERCENT` and
`TRAFFIC_PER_TB_USD` by hand against https://www.digitalocean.com/pricing/droplets.

```bash
OPSCREW_E2E_HCLOUD_TOKEN=… pnpm --filter @opscrew/connector-hetzner exec vitest run src/static-prices.live.test.ts
OPSCREW_E2E_DIGITALOCEAN_TOKEN=… pnpm --filter @opscrew/connector-digitalocean exec vitest run src/static-prices.live.test.ts
```

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
| 2026-10-14 | `softzer0/slog_cvrp_app` (Flask + SQLAlchemy + Celery) on Hetzner with a model | Stopped at provision, then at the app's own image build | First run: OpsCrew warned that the Celery worker is not deployed yet (T826) and planned `FLASK_APP=app/project/__init__.py flask db migrate` (T830), then stopped for missing values: the app reads `DATABASE_URI` and a Redis-backed `CELERY_BROKER_URI`, uses Redis only through `flask-redis` and Celery, and loads `FLASK_*` settings by prefix. After T832 (rerun with stand-in values for its Mapbox key and mail settings): Postgres and Redis planned, `DATABASE_URI`, `CELERY_BROKER_URI` and `FLASK_REDIS_URL` derived, `FLASK_SECRET_KEY` generated, the server provisioned; the deploy workflow then failed in the repository's own root `Dockerfile`, which OpsCrew keeps as it is: its unpinned `python:slim-bullseye` base now brings a Python the early-2023 pins cannot build for, and its `CMD` starts an `app.py` that does not exist. Checking a found Dockerfile and offering a builder instead belongs to feature 012; the Celery worker to 013. Nothing was left on Hetzner |
| 2026-10-14 | Breadth round, local Docker pass (17 examples) | **Passed** (58 checks) | The four new ORM examples ran their release commands against Postgres and answered 200 on `/`, which writes a row: `alembic upgrade head` (SQLModel), `npx drizzle-kit migrate`, `npx typeorm migration:run -d dist/data-source.js`, `npx knex migrate:latest` (T833); `fastapi-redis`, `express-drizzle` and `koa-knex` got their health routes without a model (T834) |
| 2026-10-14 | Breadth round on Hetzner without a model: FastAPI + SQLModel/Alembic, Express + Drizzle, NestJS + TypeORM, Koa + Knex, FastAPI + Redis | **Passed** (5 apps) | Each deploy ran the app's migrations on the server before switching, `/` answered 200 with the tables in place, and `verify`, `secure` and `drift` were clean; FastAPI + Redis, which needed a model for its health route before, now deploys with none. `DATABASE_URL` now uses `postgresql://`, which SQLAlchemy accepts |
| 2026-10-14 | Own server (`OPSCREW_E2E_OWN_SERVER=1`: a throwaway Hetzner server treated as the user's, `e2e.opscrew.dev`), run 1 | Stopped at `design` | Git for Windows' `ssh` (an MSYS program) received the 10,852-character inspection command cut at 8,186 characters, so nothing ran ("could not read the server's state"). Fixed: long commands reach the server over stdin through a short bootstrap (T917). |
| 2026-10-14 | Own server, runs 2–3 | Stopped at provision (run 2: OpenTofu not on the test's PATH), then at Portainer | The DNS-only deploy, `verify`, `secure`, `drift` and a re-run without changes passed. `portainer status --json` hid the password file's path as a secret, and the leak check failed without naming the leak. Fixed: keys that name where a secret is (`…File`, `…Path`) are not redacted; the leak check logs each finding (T918). |
| 2026-10-14 | Own server, run 4 | Stopped at provision | The zone still held OpsCrew's rulesets from run 3, which stopped before `destroy`; the new project planned to create them again and Cloudflare refused. Fixed: OpsCrew rulesets that this project's state does not hold are skipped with a plain warning (also for a second app in one zone); the test's cleanup removes rulesets the run created (T919). |
| 2026-10-14 | Own server, run 5 | Stopped at the tunnel | Everything before it passed: DNS only, re-run, Portainer through the SSH tunnel, the Cloudflare-only filter with a reboot, the switch to the tunnel with `--confirm`. In tunnel mode `http://` was not redirected to HTTPS, and `verify` and `secure` printed the server's address in the terminal. Fixed: Caddy redirects on Cloudflare's `Cf-Visitor`; the texts say "your server" (T920). |
| 2026-10-14 | Own server, run 6 | Stopped at `destroy --undo-host` | Everything before teardown passed, including a merged change deployed through the Access-protected SSH hostname and the leak check. `destroy` deleted the Cloudflare resources before the tunnel connector, and Cloudflare refused to delete a tunnel with active connections (code 1022). Fixed: the connector goes first, then OpsCrew waits until Cloudflare reports no connections (T921). |
| 2026-10-15 | Own server, runs 7–8 (run 8 on the final T921 code) | **Passed** (8 live steps, 22 tests, about 26 minutes each) | DNS only (deploy, `verify`, `secure`, `drift`; a re-run without changes); Portainer (closed from outside, the admin through the printed SSH tunnel); the Cloudflare-only filter (80/443 closed on the server's addresses, nothing listening on IPv6, the filter back before Docker after a reboot, drift clean); the tunnel (only SSH open, HTTP redirected to HTTPS, a merged change deployed through Access, Access refusing a request without the service token); `destroy --undo-host` (app, DNS, tunnel and Access gone, root still logs in with its key); no address or secret in commits, pull requests, CLI output or the audit log. The throwaway server and every Cloudflare resource of each run were removed. The test machine has no IPv6 route, so the outside IPv6 probes were skipped; the server-side listener check covered IPv6. |
| 2026-10-15 | Own server, run 9 (after T922) | Stopped at the first deploy | Provision passed; the deploy's health check got only TLS handshake errors because Let's Encrypt allows 5 certificates per week for the same names and every earlier run's fresh server had asked for one for `e2e.opscrew.dev`. Fixed (T923): each run serves the app on its own hostname (`e2e-<run id>.<zone>`), and the deploy workflow now says when the server has no certificate yet and why. |
| 2026-10-15 | Own server, run 10 (final code: T922–T923) | **Passed** (8 live steps, 23 tests) | Same coverage as runs 7–8, on a per-run hostname; everything the run created at Hetzner and Cloudflare was removed. |
| 2026-10-15 | Own server, run 11 (the converged code: everything through T965) | **Passed** (8 live steps, 25 tests, about 26 minutes) | Now starting with `opscrew init` as a user would; the time from `init` to a verified DNS-only deploy was within SC-901's 20 minutes (a longer run records a finding that fails the test; the exact figure appears in the run log only when a step fails, and every step passed). `destroy --undo-host` was approved with its own typed name, separately from the teardown. Everything the run created at Hetzner and Cloudflare was removed. |
