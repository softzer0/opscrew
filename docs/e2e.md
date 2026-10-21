# Live end-to-end test

What has run live so far, and what has not, is tracked in [e2e-coverage.md](e2e-coverage.md).

**One live test per Cloudflare zone at a time.** OpsCrew keeps one shared rule per kind in a
zone, listing the hostnames of every OpsCrew app there (see
[the guide](guide/cloudflare.md)). The live tests compare those rules, and the zone's rules
OpsCrew did not create, with exactly what they expect after each provision and destroy, so the
apps or seeded rules of another run in the same zone would look like a change and fail it. Run
the live test files one after another, never two at once against the same `OPSCREW_E2E_DOMAIN`
zone.

`packages/cli/test/live/live.test.ts` runs the whole OpsCrew flow against real services, once for
each cloud provider whose token is set (Hetzner Cloud, DigitalOcean, or both, one after the other):

1. It force-pushes the app (`examples/nextjs-postgres` by default, see
   [Choosing the app](#choosing-the-app)) to the `main` branch of a throwaway GitHub repository,
   then closes its open pull requests and deletes every other branch, so an earlier run never
   changes this one.
2. It runs `analyze --no-ai`, then `interview --answers` (with the provider and
   `OPSCREW_E2E_REGION`) and `design`.
3. It runs `adapt --no-ai --yes` and merges that pull request through the GitHub API.
4. It runs `provision --plan-only --yes` and then `provision --approve <hash> … --yes` with every
   hash it printed (with a Cloudflare domain, the Cloudflare plan of OpsCrew's shared rules comes
   before the infrastructure plan), which creates a real server (or Droplet). With a Cloudflare
   domain, the app's hostnames must then be in both of OpsCrew's shared rules, found by their
   `ref` (`opscrew-block-probes` and `opscrew-strict-tls`).
5. It merges the deployment pull request and waits for the `opscrew-deploy.yml` workflow to succeed.
6. It runs `verify`, checks that the app answers 200 on the health path from `opscrew/plan.yaml`,
   then runs `secure` and `drift` (which must report no differences).
7. It tears everything down with `opscrew destroy --confirm`. With a Cloudflare domain, none of
   OpsCrew's shared rules may list the app's hostnames afterwards (other apps' hostnames there are
   not the test's); when destroy failed, the fallback removes them first (see
   [Cost and cleanup](#cost-and-cleanup)). No DNS record on the app's hostnames (its domain, and
   `www.` when it serves that too) may be left in the zone either; a failure names each record by
   its type and "the app's domain" or "the app's www. name".

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
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Optional. A Cloudflare token limited to one zone, with Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit, SSL and Certificates Edit and Zone Settings Edit. |
| `OPSCREW_E2E_DOMAIN` | Optional, used together with the Cloudflare token: a hostname in that zone, for example `e2e.example.com`. It names the zone only: each run serves the app on its own hostname, `e2e-<run id>.<zone>`, because Let's Encrypt issues at most 5 certificates per week for the same names and every run's fresh server asks for one. |
| `OPSCREW_E2E_BUILDS` | Optional, `1` runs [the builder checks](#the-builders) in the Hetzner pass (with `nextjs-postgres`, `go-api` or `rust-api`): about 20–40 minutes and four deploys per app. Off by default. |
| `OPSCREW_E2E_GHCR_READ_TOKEN` | Needed with `OPSCREW_E2E_BUILDS=1`: a GitHub **classic** token with only `read:packages`, for the user that owns the throwaway repository. The test reads the image's SBOM, provenance and blobs with it. |
| `OPSCREW_E2E_SIGN` | Optional, `1` turns image signing on for the builder checks; it matters only together with `OPSCREW_E2E_BUILDS=1`. Off by default; read [Signing](#signing) first. |
| `OPSCREW_E2E_SKIP_DESTROY` | Optional, `1` makes the Hetzner pass skip `opscrew destroy` and clean up with the fallback a failed destroy gets (see [Cost and cleanup](#cost-and-cleanup)). Off by default. |
| `OPSCREW_E2E_COMPONENTS` | Optional, `1` runs [the component checks](#the-components) in the Hetzner pass (with one of the component examples): about 20 minutes, two deploys and a reboot per app. Off by default. |
| `OPSCREW_E2E_STORAGE` | With `OPSCREW_E2E_COMPONENTS=1` and `OPSCREW_E2E_APP=s3-uploads`: where the bucket goes, `r2` (the default) or `hetzner`. |
| `OPSCREW_E2E_R2` | `1` once R2 is turned on for the Cloudflare account and `OPSCREW_E2E_CLOUDFLARE_TOKEN` also has Account → Workers R2 Storage → Edit. Without it the R2 pass is skipped with a message. |
| `OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID`, `OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY` | For `OPSCREW_E2E_STORAGE=hetzner`: S3 credentials from the Hetzner Console of the throwaway project (Security → S3 credentials). Without them the Hetzner Object Storage pass is skipped with a message. The test never deletes them. |

Requirements:

- `git`
- OpenTofu or Terraform (version 1.6 or newer)
- `ssh` and `ssh-keyscan`
- Node.js 22.9+

Every test run keeps its temporary files in one `opscrew-test-run-*` folder that it removes at the end; set `OPSCREW_TEST_TMP` to a folder on a drive with space (outside any Git checkout) to put that folder there instead of the system temp folder.

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

### The builders

With `OPSCREW_E2E_BUILDS=1` and `OPSCREW_E2E_APP` set to one of the three builder examples, the
Hetzner pass also checks feature 012 after the first deploy and before the teardown
(`packages/cli/test/live/builder-checks.ts`). They are off by default because they cost about 20 to
40 minutes and four deploy workflow runs per app (see below). Without the variable the pass runs as
before (one deploy, no GHCR token or Buildx needed) and logs one line naming it; with it but
another app, it logs that the checks cover only these three.

| App | Builder OpsCrew must choose |
|---|---|
| `nextjs-postgres` (the default app) | `generated-dockerfile` |
| `go-api` | `buildpacks` |
| `rust-api` | `railpack` |

Other apps, and the DigitalOcean pass, run as before. Before any GitHub or cloud call the test stops
with a plain message when `OPSCREW_E2E_GHCR_READ_TOKEN` is missing, when `docker buildx version`
fails, or, with `OPSCREW_E2E_SIGN=1`, when `cosign version` fails. The checks, in order:

1. **The builder.** `app.build.builder` in `opscrew/plan.yaml` is the expected one,
   `deploy.strategy` is `rolling`, and `supplyChain.sign` matches `OPSCREW_E2E_SIGN`. The first
   deploy run's "Build the image" job has the builder's own steps, all succeeded: "Build and push
   the image" for the generated Dockerfile; "Install pack <version>", "Build the image with Buildpacks" and
   "Seal and push the image" for Buildpacks; "Plan the Railpack build", "Build the image with
   Railpack" and "Seal and push the image" for Railpack. For Buildpacks the job's log must name
   the pinned builder and run images as `repo:tag@sha256:…`, exactly as in OpsCrew's pin table.
2. **Non-root.** On the server, as `deploy`, `docker exec <container> id -u` for every running
   `app` container: none may print `0`.
3. **The attestations.** The test reads the deployed image (the digest in `/srv/apps/<app>/.env`
   on the server) with the guide's commands, `docker buildx imagetools inspect <image> --format
   '{{json .Provenance}}'` and `--format '{{json .SBOM}}'`, logged in to `ghcr.io` with
   `OPSCREW_E2E_GHCR_READ_TOKEN`. The login is written into a Docker configuration folder of the
   test's own (`DOCKER_CONFIG`), never into your Docker configuration or the computer's credential
   store, and deleted at the end. The provenance must name the repository
   (`github.com/<owner>/<repo>`) and the deployed commit and hold none of GitHub's event data
   (`github_event_payload`, `head_commit`, `pusher`); the SBOM must list packages.
4. **The leak search** over the provenance and SBOM JSON: none of the GitHub, Hetzner, Cloudflare
   and GHCR tokens, the deploy key, the state passphrase, the values OpsCrew generated for the app
   (database password, app secrets) or the `OPSCREW_E2E_APP_ENV` values of 8 characters or more.
   Only labels are printed.
5. **A change under load.** The test sends a steady 20 requests per second to the app's health
   route (through the domain when there is one, otherwise the server's address) from this
   computer, without waiting for answers, each with a 10-second timeout. Meanwhile it merges a
   pull request adding `opscrew-e2e-change.txt` and waits for that deploy run. Every non-2xx answer
   and connection error is logged with the time its request was sent; there must be none, and the
   server must run a new image afterwards. The deploy must not restart any of the plan's services
   (`db`, `cache`) nor the shared edge's `kamal-proxy` and `caddy` (Compose project
   `opscrew-edge`): each container's `StartedAt` is the same before and after.
6. **A broken release.** Under the same load, the test merges a commit that makes the health route
   answer 500 (none of the examples has a switch for that, so the copy in the throwaway repository
   is edited: Next.js's `app/api/health/route.ts` that `adapt` wrote, `main.go`, `src/main.rs`).
   No request may fail, the deploy run must fail, an error line of its "Deploy to the server" job
   must say the new version did not pass its health check and name `app.build.builder: <builder>`,
   the server must still run the previous image, and the health route must answer 200. Then a
   third pull request puts the route back and deploys normally.
7. **The image retention job.** The last deploy's "Delete old images" job must have succeeded
   (for Buildpacks and Railpack it deletes the `build-<commit>` images, which share their layers
   with the deployed ones). Then, for the first deployed image and the running one, the test asks
   GHCR for every blob (the config and layers of every manifest of the image index, the
   attestations among them) through the registry API, as a pull on a computer with none of the
   layers would. None may be missing. It does not run `docker pull`: Docker would reuse layers
   this computer already has (the Node and Debian base layers), so a pull could not prove that
   GHCR kept them.
8. **Signing** (only with `OPSCREW_E2E_SIGN=1`, see below): `cosign verify` with the guide's
   certificate identity (the deploy workflow on the deploy branch) for the first deployed image
   and the running one, after the image retention jobs of the later deploys. Without the
   variable the test logs
   "not checked: image signing".

The test also logs what it does not check, on every run; the list, with everything else no live
test covers, is on the [coverage page](e2e-coverage.md#image-builders-feature-012).

Run the three apps one after another (each pass creates and destroys its own server):

```bash
pnpm --filter opscrew build
cd packages/cli
export OPSCREW_E2E_BUILDS=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_GHCR_READ_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… \
  OPSCREW_E2E_DOMAIN=e2e.example.com
for app in nextjs-postgres go-api rust-api; do
  echo "=== $app"
  OPSCREW_E2E_APP="$app" npx vitest run test/live/live.test.ts || echo "FAILED: $app"
done
```

Requirements on top of the pass's own: Docker with Buildx on this computer (for `docker buildx
imagetools`; the daemon pulls nothing), and cosign with `OPSCREW_E2E_SIGN=1`. A pass runs four
deploy workflow runs instead of one (the first deploy, the change, the broken release and the
restore; the broken one waits a minute for its health check), so it takes about 20 to 40 minutes
and more GitHub Actions minutes; the server cost stays at a few cents. The three extra pull
requests and their branches (`e2e/change`, `e2e/broken`, `e2e/restore`) stay in the throwaway
repository like the others (the branches are deleted at the end), and so do the images in its
GHCR package.

#### Signing

`OPSCREW_E2E_SIGN=1` matters only together with `OPSCREW_E2E_BUILDS=1`; on its own it changes
nothing. With both, it answers "sign images" in the interview, so the deploy workflow signs each
image with cosign's keyless signing. **Keyless signing publishes the throwaway repository's name
and the path of its deploy workflow in Sigstore's public transparency log (Rekor), even when the
repository is private, and entries there cannot be deleted.** Turn it on only with the agreement of
the repository's owner. It is off by default, and the signing check is then skipped with a plain
note.

The test sets `CI=1`, so every command runs non-interactively:

- `--yes` approves writing files, storing deploy secrets, pushing and opening pull requests.
- `--approve <hash>` applies exactly the plan the first provision run printed.

### The components

With `OPSCREW_E2E_COMPONENTS=1` and `OPSCREW_E2E_APP` set to one of the component examples, the
Hetzner pass also checks feature 013 after the first deploy and before the teardown
(`packages/cli/test/live/component-checks.ts`). Each example is one pass on a server of its own
(one app per server on Hetzner), so the set below is the smallest that covers the live set of
SC-1301. With the variable but another app, the pass logs that the checks cover only these.

| App | What it covers |
|---|---|
| `node-bullmq` | a worker (Procfile) and a cron job (`vercel.json`), with Valkey as a queue |
| `express-mysql` | MySQL, and its `my.cnf` honoured |
| `node-mongo` | MongoDB, with its two data folders |
| `s3-uploads` | object storage: the bucket on Cloudflare R2 (`OPSCREW_E2E_STORAGE=r2`) or on Hetzner Object Storage (`hetzner`), one pass each |
| `rabbitmq-worker` | RabbitMQ and a worker |
| `kafka-app` | Kafka (a named volume) and a worker |
| `meili-search` | part 2's search engine, Meilisearch, and OpenSearch added in `plan.yaml` (as a user adds a service there), for the kernel setting `vm.max_map_count` it needs |
| `clickhouse-events` | part 2's analytics engine, ClickHouse, and its `server.xml` honoured |

The pass makes the plan edits a user would before the first provision: for `s3-uploads` the
bucket's provider and a name of the run's own (`opscrew-e2e-<run id>`: bucket names at Hetzner are
shared by all its customers); for `meili-search` the OpenSearch service. Then `design` runs again.
The checks, in order:

1. **On the server**, as `deploy` (it runs Docker; it has no `sudo`):
   - `opscrew status` shows every component of the plan running;
   - every container of the app's Compose project and of the shared edge (`opscrew-edge`) has a
     memory limit, and no swap beyond it;
   - no container publishes a port but the edge's Caddy, and the app's containers are on the
     edge's network: Caddy reaches the app through kamal-proxy;
   - every component and the edge run, none restarted and none met its limit;
   - each data folder `/srv/data/<app>/<service>` holds data and belongs to the user its service
     runs as (the owner of its main process). The folder is read as root in a throwaway container
     of the edge's pinned Caddy image, without a network and read-only, since a service's folder
     may be its own user's only. Named volumes (Kafka, OpenSearch, SQLite) are Docker's;
   - each settings file mounted next to `compose.yaml` (`services/<service>/…`, `crontab`) is
     readable by its service's user and writable by nobody else, and MySQL's
     `@@innodb_buffer_pool_size` and ClickHouse's `max_server_memory_usage` are the values in
     OpsCrew's files;
   - with a kernel setting (`meili-search`): `/etc/sysctl.d/90-opscrew.conf` on the host sets it,
     and the kernel uses at least that.
2. **From this computer:** neither the app's port nor any service's port answers on the server's
   IPv4 address, nor on its IPv6 address when this computer has an IPv6 route (the same check as
   for [your own server](#your-own-server)); without one the pass logs "IPv6 not probed: no route
   from this computer".
3. **The worker and cron** (SC-1302): a job queued through the app (`POST /jobs/<id>`) is consumed
   within 30 seconds (`GET /jobs/<id>`). Every cron job of the examples runs each minute (the pass
   checks that its schedule is `* * * * *`), so supercronic's first successful run since the cron
   container started must come within a minute of the first full minute after both that start
   and the time the app answered its health route (both in the server's time), and the app must
   count it (`GET /cron`).
4. **Data:** a value written through the app (`PUT /data`, into its database, bucket or broker) is
   read back (`GET /data`), after a merged change's deploy, and after a reboot of the server
   through Hetzner's API. After the reboot, checks 1–3 run again and `opscrew drift` passes.
5. **The leak search:** none of the GitHub, Hetzner and Cloudflare tokens, the bucket's key, the
   deploy key, the state passphrase, the values OpsCrew generated for the app (the services'
   passwords) or the `OPSCREW_E2E_APP_ENV` values of 8 characters or more is in any CLI output of
   the run up to the teardown, any commit (every branch, contents and messages), a pull request of
   the run or the audit log, and, after the reboot, in no `docker logs` of the containers of the
   app's Compose project and of the edge (for those, only the container's name and how many known
   values matched are printed, never the log). Only labels are printed. The server's address is
   searched as in every Hetzner pass (commits and pull requests).

**The bucket.** OpsCrew never creates storage keys:
- **Hetzner Object Storage:** the pass gives OpsCrew your key from
  `OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID` and `OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY` as
  `OPSCREW_STORAGE_ACCESS_KEY_ID` and `OPSCREW_STORAGE_SECRET_ACCESS_KEY`, the variables of the
  guide for scripts. The key stays yours: the test never deletes it.
- **R2:** the guide's key, limited to the bucket, can only be made by hand once the bucket exists,
  which an unattended run cannot do. So the pass gives OpsCrew the S3 credentials of
  `OPSCREW_E2E_CLOUDFLARE_TOKEN` itself: the token's id, and the SHA-256 of its value, which is how
  Cloudflare turns an API token with an R2 permission into S3 credentials. They reach every bucket
  of the account, so use the throwaway account. Before any GitHub or cloud change the pass checks
  that the token lists the account's R2 buckets; when it does not, the pass is skipped, saying why.

The teardown runs `opscrew destroy --confirm <app> --no-snapshot --delete-data`, so the bucket goes
too. It touches only the run's own bucket: when the plan names another bucket, the teardown logs
"the plan's bucket is not this run's, left alone" and neither empties, deletes nor checks it.
Before the destroy, the test deletes the one object the app wrote, because R2 deletes only an empty
bucket and OpsCrew never deletes your files itself (Hetzner's bucket has `force_destroy`). When
destroy fails, the fallback also destroys the `storage` root with the engine (its
`prevent_destroy` lifted, the key in the engine's environment), and for R2 deletes a bucket still
there through Cloudflare's API. Then the bucket must be gone: at R2 by the API, at Hetzner by an
unsigned request (a missing bucket answers 404, a private one 403); otherwise the run fails naming
the bucket, which you then delete in the provider's console.

Run the passes one after another (each creates and destroys its own server):

```bash
pnpm --filter opscrew build
cd packages/cli
export OPSCREW_E2E_COMPONENTS=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com
for app in node-bullmq express-mysql node-mongo rabbitmq-worker kafka-app meili-search \
  clickhouse-events; do
  echo "=== $app"
  OPSCREW_E2E_APP="$app" npx vitest run test/live/live.test.ts || echo "FAILED: $app"
done
# The bucket: on R2 (once R2 is on), then on Hetzner Object Storage.
OPSCREW_E2E_APP=s3-uploads OPSCREW_E2E_R2=1 npx vitest run test/live/live.test.ts
OPSCREW_E2E_APP=s3-uploads OPSCREW_E2E_STORAGE=hetzner OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID=… \
  OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY=… npx vitest run test/live/live.test.ts
```

**Expected time and cost** (not measured yet). Each pass takes about 20 minutes: the usual flow
(about 7), the checks, a second deploy and a reboot. The nine passes take about three hours. Each
server is the recommended one for a budget of 20 EUR, a cx23 (4 GB, EUR 5.49 a month) unless a
component needs more; Hetzner bills by the started hour, so a pass costs about one cent of server
time (Hetzner's price table, 2026-10-14), plus GitHub Actions minutes for two builds (free for
public repositories). R2 is within its free tier. Hetzner Object Storage bills its base of EUR 6.49
a month for every hour in which a bucket exists, so its pass adds about one cent more, unless the
account pays that base already.

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
   merged), `provision --plan-only` then `provision --approve <Cloudflare plan> --approve
   <infrastructure> --approve <host plan>`, merge of the deploy pull request and its workflow run,
   then the domain answers from the server itself (not proxied), `verify`, `secure` (no failed
   check) and `drift` pass and root still logs in with its key. The step measures the time from
   the start of `init` to the passing `verify` (SC-901) and logs it; when that takes 20 minutes or
   more, the run fails at the end (step 8), after the later steps.

   Before the first provision the test snapshots the zone's WAF custom rules and configuration
   rules and the account's Zero Trust organization and one-time PIN login, then seeds one rule of
   the user's own in each (added through the Cloudflare API as a user would: to the zone's
   existing rule list, or as a new list only when the zone has none). Both match only
   `opscrew-e2e-seeded.e2e-<run id>.<zone>`, a name that does not exist: a `block` in the WAF
   custom rules and Automatic HTTPS Rewrites in the configuration rules, both available on the
   Free plan. After this provision and every later provision and destroy (steps 5, 6, 6b, 7, 7b):
   - the zone's rules OpsCrew did not create, the seeded ones among them, are byte-identical (each
     whole rule as Cloudflare returns it, apart from the `version` and `last_updated` it changes on
     its own) and in the same order;
   - OpsCrew's two rules, found by their `ref` (`opscrew-block-probes` and `opscrew-strict-tls`),
     list exactly what they listed before the run plus the hostnames of this run's apps that are
     not destroyed: in DNS-only and proxy mode an app is in both rules, through the tunnel only in
     the probe block. A rule that listed nothing before the run must be gone once no app of the
     run is left;
   - the Zero Trust organization and every one-time PIN login seen so far are still there.
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
   one, the new setup, with its own `--approve` hashes (the app's hostnames leave OpsCrew's
   strict-TLS rule, which a tunnel app does not need). Then: ufw is active and lists only SSH
   rules, the domain answers through the tunnel, 80/443 stay closed, `verify` and `drift` pass, and
   the SSH hostname (`ssh-<app>.<zone>`) refuses a request without the service token. The deploy
   workflow on `main` names that hostname and `cloudflared access ssh`; a merged change then
   deploys, and sshd's journal on the server shows every `deploy` login of that run coming from
   `127.0.0.1` or `::1` (the tunnel connector), not from GitHub's runners.

   6b. **A second app on the same server** (feature 013): `examples/s3-uploads`, B, from its own
   throwaway repository (`OPSCREW_E2E_GITHUB_REPO_B`) and project folder, on the first app's server
   with root's same key and the same pinned host key, served on `e2e-<run id>-b.<zone>`, also
   directly below the zone. Its files go to Garage, the bucket design offers on a server you own,
   so this covers object storage without a key of yours. In tunnel mode: `init --fix`, `analyze`,
   interview and `design --host-key`, `adapt`, provision, deploy, `verify`. Then both apps'
   `https://<hostname>/.env` answer Cloudflare's block page (HTTP 403 with `cf-ray`, and "you have
   been blocked", error 1020 or "access denied" in the page), both apps' hostnames are in OpsCrew's
   probe block (neither in the strict-TLS rule: both use the tunnel), and the two apps share the
   account's Zero Trust organization. On the server, as root, for each app the checks of
   [the components](#the-components) (step 1 there, without `opscrew status`): limits, no published port but the edge's
   Caddy, the apps on the edge's network, nothing restarted, the data folders (Postgres's and
   Garage's) and the settings files (`garage.toml`); one Caddy of the shared edge serves both. A
   value written through B into Garage is read back.

   6c. **A change to each app under load** (SC-1305): while the test sends 20 requests per second
   to each app's health route (40 in all, as for [the builders](#the-builders)), it merges a change
   to the first app and waits for its deploy, then one to the second. No request to either app may
   fail. B's value is still in Garage afterwards.
7. **Destroying the first app** under the same load on the second: `destroy --confirm <app>`
   (without `--undo-host`, the second app still uses the host's setup) causes no failed request to
   the second app. No DNS record, tunnel, Access application, policy or service token of the first
   app is left in Cloudflare, no container of it is left on the server, the shared edge (Caddy and
   kamal-proxy) still runs and the `deploy` user stays. The second app still answers through its
   tunnel with its value in Garage, its `/.env` is still blocked, its SSH hostname still refuses a
   request without the service token, and OpsCrew's probe block lists only its hostnames of this
   run.

   7b. **Destroying the second app** with `--undo-host`, then again with `--approve <undo host plan
   hash>`: nothing of it is left in Cloudflare, no container of it or of the edge is left, `/srv/edge`
   is gone, no `deploy` user is left and root still logs in with its key. OpsCrew's shared rules are
   gone (unless they listed other apps' hostnames before the run, which then stay), the seeded rules
   are byte-identical, and the Zero Trust organization and one-time PIN login are still there.
8. Nothing leaked: the server's addresses (IPv4, IPv6 and their `/64` prefixes), the private keys,
   the state passphrases, the values OpsCrew generated for both apps (Postgres's password, Garage's
   key), the tunnel tokens, the Access service tokens, the Portainer password and
   the `OPSCREW_E2E_APP_ENV` values (those of 8 characters or more) are in no commit (any branch,
   messages and contents) and no pull request of the run, in both apps' repositories; no secret is
   in any CLI output (the Cloudflare plans among it) or OpsCrew's audit logs; and the CLI shows a
   server's address only in the Portainer tunnel command (`deploy@<address>`) and in "your server
   at <address>" messages (host key and reachability). Those mentions are cut out of a line before
   the rest of it is searched. Every version of `.opscrew/cloudflare.json` the run saw (after each
   CLI run, both apps) must hold only the zone's id, hostnames and phases, and no known value. When
   the tunnel or service-token secrets could not be read, or no CLI output showed a Cloudflare plan,
   or no `.opscrew/cloudflare.json` was written, the run fails with a finding that says so.

Each step logs what it waits for. The steps stop at the first failure (a timeout too), but the
cleanup always runs:

- It deletes the throwaway server and its SSH key: everything labelled with the run's id, and
  nothing else, then reports any server or key still listed under that label.
- It removes what this run created in Cloudflare for each app, also after a finished `destroy`
  (which should have left nothing): DNS records on the app's hostname, `www.`, `ssh-<app>.` and
  `portainer.`, the tunnel `opscrew-<app>`, and the Access applications and policies and the
  service token named after the app. Anything that existed before the run is skipped.
- It cleans up the zone's WAF custom rules and configuration rules: it deletes the rules it
  seeded, and OpsCrew's rules (found by `ref`, never by name) that list only this run's hostnames,
  each logged. An OpsCrew rule that lists this run's hostnames next to other hostnames is reported
  and left as it is (the cleanup never edits a rule). A rule list the run created (the zone had
  none of that kind before the run) is deleted when a fresh read finds nothing left in it; a rule
  that appeared there meanwhile is reported and the list kept.
- It resets the throwaway repositories: closes every open pull request and deletes every branch
  except `main`.

Everything the test prints goes through a scrubber that masks the server's addresses and every
secret it knows.

If a run was interrupted (the process killed, so the cleanup never ran): in the Hetzner project,
delete the server and SSH key labelled `managed-by=opscrew-e2e`; in Cloudflare, delete the DNS
records on the run's hostnames `e2e-<run id>.<zone>` and `e2e-<run id>-b.<zone>` (the id is the
server's `run=<id>` label) and on `www.`, `portainer.` and `ssh-<app>.`, the tunnels
`opscrew-<app>`, the Access applications `OpsCrew SSH (<app>)`, the Access policies and service
tokens `OpsCrew deploy (<app>)`, the rules described "OpsCrew E2E: a rule of the user's own, seeded
by run <run id>" in Security → WAF → Custom rules and Rules → Configuration Rules, and the run's
hostnames from OpsCrew's rules there ("OpsCrew: block probes for secrets and admin panels" and
"OpsCrew: verify the origin certificate (Full (strict) TLS)"; delete a rule that lists nothing
else).

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_OWN_SERVER` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write), used only by the test to create and delete the throwaway server. Use a separate, empty project. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | The throwaway repository and its token, as above. The token must cover `OPSCREW_E2E_GITHUB_REPO_B` too, with the same permissions (a fine-grained token can list several repositories). |
| `OPSCREW_E2E_GITHUB_REPO_B` | `owner/name` of a second **throwaway** repository, for the second app, `examples/s3-uploads` (steps 6b to 7b). The test force-pushes its `main` branch like the first one's. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | A Cloudflare token for the zone with Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit, SSL and Certificates Edit and Zone Settings Edit, plus the account permissions tunnel mode needs: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit, Access: Organizations, Identity Providers, and Groups Edit (the test also reads the Zero Trust organization and login methods with it, and seeds and removes its own rules). Cloudflare Zero Trust must be turned on for the account. |
| `OPSCREW_E2E_DOMAIN` | A hostname one level below that zone, for example `e2e.example.com`, or the zone itself. It names the zone only: each run uses its own hostname `e2e-<run id>.<zone>` (see step 1) and owns its records while it runs. |
| `OPSCREW_E2E_REGION` | Optional, where the server runs, with OpsCrew's own Hetzner locations for the region: `eu-central` (default; Nuremberg, then Falkenstein), `eu-north` (Helsinki), `us-east`, `us-west` or `ap-southeast`. |
| `OPSCREW_E2E_OWN_SERVER_TYPE` | Optional, a Hetzner server type to use instead of the cheapest x86 one, for example `cx23`. |
| `OPSCREW_E2E_APP`, `OPSCREW_E2E_APP_ENV` | Optional, as above, but only examples under `examples/` (default `nextjs-postgres`), and not `s3-uploads`, the second app's. |

Requirements: the built CLI, `git`, OpenTofu or Terraform, `ssh`, `ssh-keygen` and `ssh-keyscan`,
Node.js 22.9+, and outgoing SSH (port 22) from the test computer. Run only this file, never together
with the other live tests (they share the throwaway repository and the zone):

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_OWN_SERVER=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_REPO_B=you/opscrew-e2e-b \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/own-server.test.ts
```

A full run took about 36 minutes with the second app on a server of its own (measured on
2026-10-18); with both apps on one server (feature 013) it is expected to take about 45 minutes, not
measured yet: one server's Docker installation instead of two, but two more deploys under load in
step 6c. The server is the smallest x86 type (a cx23, 4 GB, EUR 5.49 a month in Hetzner's price
table of 2026-10-14), billed by the started hour, so a run costs about one cent of server time,
plus GitHub Actions minutes for the builds (free for public repositories). Left behind on purpose:
the GitHub Actions secrets and the container images in the throwaway repositories (as above), the
zone's rules that existed before the run (OpsCrew's shared rules too, when they listed other apps'
hostnames), and the Zero Trust organization and one-time PIN login if OpsCrew created them (OpsCrew never deletes them: other apps may use them).

## Your existing Portainer

`packages/cli/test/live/portainer-target.test.ts` runs the flow for a Portainer the user already
runs (feature 010) on a real Portainer CE 2.45.2 that OpsCrew did not install.
`OPSCREW_E2E_PORTAINER_STEPS` chooses the steps:

- `core` (the default, about 21 minutes with the second app, measured on 2026-10-18; about 24 with
  feature 013's checks of the second app, not measured yet): steps 1, 1b, 2a, 2, 3, 7b, 8, 9, 9b
  and 12. Step 8 then removes an updater + tunnel setup (one tunnel, no Access application), and
  step 12 searches what this pass produced; the bare short host name is searched only when step 11
  ran and gave it to OpsCrew.
- `full` (about 1 to 1½ hours): every step and check below.
- A comma-separated list of steps, such as `11,12`: those steps and every step they need (see
  [Running chosen steps](#running-chosen-steps)).

The test prints the steps it takes at the start. The other steps are reported as skipped; any
other value skips the whole test and names the variable.

1. **The user's Portainer.** It creates a throwaway Hetzner Cloud server through the Hetzner API
   (Ubuntu 24.04, the cheapest x86 type near `OPSCREW_E2E_REGION`, labels `managed-by=opscrew-e2e`
   and `run=<id>`) with an SSH key generated for this run and its own firewall: SSH, 80 and 443
   from anywhere, Portainer's port 9443 and the `proxy` port 8080 only from the test computer's
   public IPv4 address (read from `https://1.1.1.1/cdn-cgi/trace`). It installs Docker
   (get.docker.com) and starts `portainer/portainer-ce:2.45.2` publishing only 9443. Then, as the
   user would: it reads the fingerprint with the user guide's `openssl` command on the server and
   checks that it is the one OpsCrew reads from the test computer, creates the administrator with
   the one-time setup token from `docker logs portainer`, adds the local Docker environment
   (`POST /api/endpoints`; a fresh install has none), creates an administrator's access token, a
   standard user (role 2) with access to the environment and that user's token, a decoy Compose
   project started outside Portainer (`e2e-decoy-compose`) and a decoy Portainer stack
   (`e2e-decoy-stack`). With a short-lived stack of its own it records whether a bare `NAME:`
   entry stays unset when the stack has no value for it, whether a bare entry takes a value from
   the stack's environment, and whether stopping a stack removes its containers. OpsCrew never gets
   the Hetzner token, an SSH login or a Portainer password: only `PORTAINER_API_KEY`.

   1b. With `OPSCREW_E2E_PORTAINER_MANUAL_MINUTES`, a pause for the guide's steps a person checks
   (see the variables below); without it, nothing.
2. **updater + tunnel** (the defaults).

   2a. **Preparing the project**: `init --fix`, `analyze --no-ai`,
   `interview --answers <file> --portainer-cert SHA256:…`, `init` again, `design`,
   `adapt --no-ai --yes` (pull request merged), then the snapshot, the seeded rules and the checks
   after every later provision and destroy as for [your own server](#your-own-server) (step 2).
   The differences: the snapshot also keeps every zone ruleset (the cleanup compares them), and an
   app in a Portainer is only in OpsCrew's probe block, and only with the tunnel (OpsCrew sets no
   strict TLS there).

   2. With the standard user's token and a private image
   `provision --plan-only` must stop before any change with the registry steps (FR-1018); the
   test then does the guide's step 1 through the API (a Custom `ghcr.io` registry entry granted to
   that user on the environment), the same token must get past that check, and the entry is
   removed again. With the administrator's token the three script runs follow: `--plan-only`
   prints the Cloudflare plan's hash (the app's hostnames into OpsCrew's probe block) and one
   infrastructure hash and says that three runs are needed,
   `provision --approve <Cloudflare plan hash> --approve <infrastructure hash> --yes` applies them,
   creates the `opscrew-deploy`
   branch (a root commit holding only `compose.yaml`, made with the fine-grained token) and stops at
   the stack plan printing its hash, `provision --yes` alone must not apply the stack plan, and
   `provision --approve <stack plan hash> --yes` applies exactly that hash; neither of the last
   two runs writes the branch again (it already holds exactly the placeholder). Then: the record in
   `.opscrew/server.json`, the app stack's `GitConfig`, `AutoUpdate` and `DeploymentStatus` (their
   shapes are logged, never their values), the deploy pull request merged and its run, the site
   through the tunnel with the new version in `X-OpsCrew-Image`, `GET /api/stacks/{id}/file`
   returning the deployed file, the volumes' `com.docker.compose.project` label, GHCR's answers for
   the registry login (the owner as user name, another user name, a wrong token), `verify`,
   `secure`, `drift`, and a re-run of `provision --plan-only` with nothing to apply.
3. **Redeploys** (research R5): a direct webhook call and two minutes of the updater's calls on an
   unchanged branch must not redeploy the app's stack (the same containers, and the same
   `UpdateDate`, `UpdatedBy`, number of `DeploymentStatus` entries and `GitConfig.ConfigHash`,
   compared but never printed); a merged change must be live within 5
   minutes of the deploy workflow writing it to `opscrew-deploy`.

   3b. **The rollback**: a deliberately failing change (a Dockerfile whose last `CMD` exits) must
   fail its run, roll back (the branch's newest commit is "Roll back to the previous version" with
   the previous image) and the site must serve the previous version again; a revert then deploys
   normally. The failing run waits about ten minutes for its health check.
4. **An apply through MCP**: `opscrew mcp` with `opscrew_plan` and then `opscrew_apply` (against
   the real provision), both with `replaceTokens: ["registry"]` and the stack plan's hash as
   `planHash`. The test's MCP client approves the stack plan's dialog as the user would and never
   types a name. Afterwards the registry entry must still be granted to the environment.
5. **caddy**: the switch (the tunnel is removed with `--confirm <app>`; the app's stack keeps its
   `Id` and `CreationDate` and its `UpdateDate` or variables change, so it was updated in place,
   not created again), the DNS record OpsCrew prints is created by the test (DNS only, to the server), the
   deploy, the site with a Let's Encrypt certificate and without Cloudflare, `verify`, `drift`.
6. **proxy** on port 8080: the test removes its DNS record first (the user points the domain at
   their own proxy), then the switch, the deploy (GitHub cannot reach the app, so the run only
   notes it), the site on `http://<server>:8080`, `verify --url http://<server>:8080`, `drift`.
7. **Cloudflare redeploys** with the tunnel: the three runs again (same stack hash on the second
   and third run), the deploy through Access (the workflow's "Ask Portainer to deploy the new
   version" step succeeds), the updater stack gone and the connector stack running, Portainer's
   hostname `portainer-<app>.<zone>` refusing a request without the service token and answering
   404 outside `/api/stacks/webhooks/` with it, `verify`, `secure`, `drift`, a re-run with nothing
   to apply, and `provision --replace-token registry` (plus `repository` for a private repository)
   after which the registry entry must still be granted to the environment.

   7b. **A second app**: a second set of stacks in the same Portainer, from its own throwaway
   repository (`OPSCREW_E2E_GITHUB_REPO_B`) and project folder. It is `examples/node-mongo`, so
   its stacks, registry entry and tunnel never start with the first app's names, served on
   `e2e-<run id>-b.<zone>` with the updater and the Cloudflare Tunnel (web mode `tunnel`), with the
   administrator's token and the full `OPSCREW_E2E_CLOUDFLARE_TOKEN`: `init --fix`, `analyze`,
   interview, `design`, `adapt`, provision (each plan approved by its hash), deploy, `verify`. Then
   its site answers through its tunnel, its `/.env` answers Cloudflare's block page (as for your
   own server, step 6b), and so does the first app's when that one runs with the tunnel at that
   point (in the core pass and after step 7 it does), OpsCrew's probe block lists both apps'
   hostnames, and the decoys are unchanged. **Components in stacks** (feature 013), as root on the
   server: every container of the second app's stacks has a memory limit and no swap beyond it, none
   publishes a port, and the web process and MongoDB run without a restart; a value written through
   the app into MongoDB is read back after `docker restart` of the app stack's containers. **The
   host-setting refusal:** with OpenSearch added to its `plan.yaml` by hand (it needs the Docker
   host's `vm.max_map_count`, which OpsCrew never changes in a Portainer), `provision --plan-only`
   must exit with an error that names that setting, with no container on the host changed (the
   same containers, started at the same time); the plan is put back afterwards, and `git status
   --porcelain` in the second app's project is then empty.
8. `destroy --confirm <app>` in tunnel + Cloudflare mode (two tunnels; in the core pass updater +
   tunnel, one tunnel), with the full `OPSCREW_E2E_CLOUDFLARE_TOKEN`: no stack of the app, no
   registry entry of OpsCrew, no DNS record, tunnel, Access application, policy or service token of
   the app; the data volumes kept; the deploy secrets, the webhook and value-key files and the
   saved stack plans removed; the `opscrew-deploy` branch deleted on GitHub (destroy says
   "Deleted the branch opscrew-deploy" and does not list it under "What remains"); Portainer's
   users, environments, registries (apart from the second app's own entry while it is set up),
   other stacks and settings as before the run; the decoys unchanged. With the second app: it
   still answers through its tunnel, its `/.env` is still blocked, and OpsCrew's probe block lists
   only its hostnames of this run. (Every zone ruleset that existed before the run is also compared
   by the cleanup.)
9. `destroy --confirm <app> --delete-data`: the recorded volumes are gone, nothing else changed;
   it deletes data only, so GitHub is left alone (the branch stays absent, the Actions secrets as
   they were). OpsCrew's record is now empty, which steps 10 and 11 need after step 2: while the
   record lists anything, OpsCrew refuses another Portainer address.

   9b. **Destroying the second app** (`destroy --confirm <app> --delete-data`): no stack of it is
   left, nothing of it in Cloudflare, OpsCrew's shared rules are gone (unless they listed other
   apps' hostnames before the run, which then stay), the seeded rules are byte-identical, the Zero
   Trust organization and one-time PIN login are still there, and Portainer (now with no OpsCrew
   registry entry left) and the decoys are as before the run.
10. **A loopback Portainer address**, as a setup of its own: through an SSH tunnel on the test
    computer's port 9443 the interview uses `https://localhost:9443` (web mode `proxy`, the
    updater, no Cloudflare). Provision must create `opscrew-deploy` anew ("Created the branch",
    not "Replaced"): an orphan commit holding only the placeholder `compose.yaml`. The test then
    merges the deploy pull request (or, when provision opened none, runs the deploy workflow on
    `main`), waits until the workflow moved the branch off the placeholder, and checks that the
    updater calls Portainer through `host.docker.internal`, the site on port 8080 serves the new
    version, and none of the updater's calls fail or redeploy an unchanged branch. Then
    `destroy --confirm <app> --delete-data` (the branch is deleted again), with Portainer and the
    decoys as before.
11. **A short Portainer host name**, as a setup of its own: with a DNS preload in the CLI's Node
    process (`NODE_OPTIONS=--import=…`, which resolves only that name to the tunnel) the CLI runs
    interview, design, provision, `secure`, `drift` and `verify --url` with Portainer at a short
    host name (`nas` and a random part, or `OPSCREW_E2E_PORTAINER_SHORT_HOST`). Containers on the
    server cannot resolve that name, so this setup is not deployed: the branch holds only the placeholder, no
    app answers, and the exits of `secure`, `drift` and `verify` are only recorded. Then
    `destroy --confirm <app> --delete-data` (the branch is deleted), with Portainer and the
    decoys as before.
12. Nothing leaked: no token (`PORTAINER_API_KEY` of both users, `OPSCREW_GHCR_READ_TOKEN`,
    `OPSCREW_REPO_READ_TOKEN`, GitHub, Cloudflare, Hetzner), password, session, setup token,
    webhook id, value key, tunnel token, service token, state passphrase, app secret, server
    address or Portainer address in any commit of any branch (including `opscrew-deploy`, whose
    history the test fetches into `refs/e2e/deploy-*` before each destroy deletes it on GitHub),
    pull request, file in the repository, CLI output (stdout and stderr, the Cloudflare plans
    among it), MCP result or dialog, saved plan (`.opscrew/plans/`, also the stack plans destroy
    removes), the audit log or (secrets only) `.opscrew/server.json`, for both apps. Every version
    of `.opscrew/cloudflare.json` the run saw must hold only the zone's id, hostnames and phases,
    and no known value; when step 2 or 7 ran, a run that showed no Cloudflare plan or wrote no such
    record fails with a finding. The bare short host name counts in what OpsCrew printed or saved
    (the app's own files and history may use it as a word); its URL forms count everywhere.

After every step from 2 on that changes the setup, the decoy Compose project's and the decoy stack's containers, volumes,
stack file and environment must be exactly as they were. Facts the run observes (versions, shapes,
the R5 result, the bare-variable and stop results, GHCR's answers, timings) are logged as
`observed:` lines and repeated as `run log:` lines in step 12; copy them into
[Live results](#live-results). Problems that should not stop the run (for example a timing over
target or a missing secret) are `finding:` lines and fail step 12.

The cleanup always runs: it deletes the server, its SSH key and its firewall (everything labelled
with the run's id, and nothing else), removes what the run created in Cloudflare for each app (DNS
records on `e2e-<run id>.<zone>`, `e2e-<run id>-b.<zone>`, `www.` and `portainer-<app>.<zone>`,
the tunnels `opscrew-<app>` and `opscrew-<app>-portainer`, the Access application `OpsCrew
Portainer webhook (<app>)`, the policy and service token `OpsCrew deploy (<app>)`), cleans up the
zone's rules as for [your own server](#your-own-server) (the seeded rules, OpsCrew's rules that
list only this run's hostnames, a rule list the run created once it is empty), then reports any
zone ruleset that existed before the run and has other rules now (it never restores one), and
resets the throwaway repositories. If a run was interrupted, delete those by hand (the run id is
the server's `run=<id>` label), as described for your own server.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_PORTAINER` | `1` runs this test. |
| `OPSCREW_E2E_PORTAINER_STEPS` | Optional, `core` (the default), `full` or a list of steps such as `11,12`: which steps run (see above and [Running chosen steps](#running-chosen-steps)). |
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write), used only by the test for the server, its key and firewall. Use a separate, empty project. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | The throwaway repository and its fine-grained token, as above (Contents, Pull requests, Secrets, Actions and Workflows read and write, Metadata read). The token must cover `OPSCREW_E2E_GITHUB_REPO_B` too, with the same permissions. |
| `OPSCREW_E2E_GITHUB_REPO_B` | `owner/name` of a second **throwaway** repository of the same owner, for the second app, `examples/node-mongo` (steps 7b and 9b). |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | As for [your own server](#your-own-server) (the zone permissions and the account's Tunnel and Access permissions; the test reads the Zero Trust pieces and seeds its own rules with it). Cloudflare Zero Trust must be turned on. |
| `OPSCREW_E2E_DOMAIN` | As for your own server: names the zone; each run uses `e2e-<run id>.<zone>` (and `e2e-<run id>-b.<zone>` for the second app). |
| `OPSCREW_E2E_GHCR_READ_TOKEN` | A GitHub **classic** token with only `read:packages` (<https://github.com/settings/tokens/new?scopes=read:packages>), for the user that owns the throwaway repositories. OpsCrew gets it as `OPSCREW_GHCR_READ_TOKEN` and puts it into Portainer's registry entries. |
| `OPSCREW_E2E_REPO_READ_TOKEN` | Only when a throwaway repository is private: a fine-grained token for it with Contents read-only, covering the second repository too when that one is private. OpsCrew gets it as `OPSCREW_REPO_READ_TOKEN`; Portainer reads the deploy branch with it. |
| `OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN` | Optional, to narrow the guide's Cloudflare list for the tunnel-only `updater` setup: a token with fewer permissions that OpsCrew uses in steps 2–4 (the test's own calls and the second app still use `OPSCREW_E2E_CLOUDFLARE_TOKEN`). Start with Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit and Zone → Config Rules → Edit (OpsCrew's shared rules: the probe block, and reading the configuration rules) and Account → Cloudflare Tunnel → Edit; when a step fails because a permission is missing, OpsCrew names it: add it and run again. Record the list that passed in [Live results](#live-results). |
| `OPSCREW_E2E_PORTAINER_SHORT_HOST` | Optional, the short host name of step 11 (default `nas` and five random letters or digits, so no word in the app or an encoded value matches it by chance). `portainer` is refused: OpsCrew's own text uses that word, so the check could not tell a leak from it. |
| `OPSCREW_E2E_PORTAINER_MANUAL_MINUTES` | Optional, for example `20`: after step 1 the test writes Portainer's address and the administrator's login to a file in its temporary folder (never printed) and waits up to that many minutes until you delete the file. Use the time to check the guide's steps the test cannot: the certificate's SHA-256 fingerprint in a browser's padlock (the file names the fingerprint OpsCrew pins), and in Portainer's UI Registries → Add registry → Custom registry and the environment's Registries → Manage access. Look only: do not save, add or change anything (the run compares Portainer and the decoys with how they were, taken again after the pause). Only the test computer can reach Portainer. |
| `OPSCREW_E2E_REGION` | Optional, as for your own server. |
| `OPSCREW_E2E_PORTAINER_SERVER_TYPE` | Optional, a Hetzner server type instead of the cheapest x86 one. |
| `OPSCREW_E2E_APP`, `OPSCREW_E2E_APP_ENV` | Optional, as for your own server (only examples, and not `node-mongo`, the second app's; the default `nextjs-postgres` has the Postgres volume the `--delete-data` step checks). |

Requirements: the built CLI, `git`, OpenTofu or Terraform, `ssh`, `ssh-keygen` and `ssh-keyscan`,
Node.js 22.9+, outgoing SSH (22), HTTPS to the server's port 9443 and HTTP to its port 8080 from
the test computer, and the test computer's port 9443 free (the SSH tunnel of steps 10 and 11). Run only this
file, never together with the other live tests (they share the throwaway repository and the zone):

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_PORTAINER=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_REPO_B=you/opscrew-e2e-b \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  OPSCREW_E2E_GHCR_READ_TOKEN=… npx vitest run test/live/portainer-target.test.ts
```

That runs the core pass. For the full one, add `OPSCREW_E2E_PORTAINER_STEPS=full` to the same
command.

### Running chosen steps

To check one step again (for example after a fix), give `OPSCREW_E2E_PORTAINER_STEPS` the steps as
a comma-separated list. The test adds every step they need and runs them on a fresh throwaway
server, which it deletes at the end like every run (a server is never kept between runs). Steps 1,
1b and 12 always run: the server with Portainer, the optional pause and the leak search.

| Step | Needs |
|---|---|
| 1, 1b, 12 | (always taken) |
| 2a | 1 |
| 2, 10, 11 | 2a |
| 3, 3b, 4, 5, 6, 7, 7b, 8 | 2 |
| 9 | 8 |
| 9b | 7b, 8 |

When the list takes step 2 together with step 10 or 11, it also takes steps 8 and 9: they empty
OpsCrew's record, and while the record lists anything OpsCrew refuses another Portainer address.
Step 7b always takes step 9b (and so step 8): the second app is destroyed after the first one.
Steps run in their usual order. Examples:

- `OPSCREW_E2E_PORTAINER_STEPS=11,12` runs steps 1, 1b, 2a, 11 and 12 (about 15 minutes): the short
  host name on a freshly prepared project, then the leak search.
- `OPSCREW_E2E_PORTAINER_STEPS=3b` runs steps 1, 1b, 2a, 2, 3b and 12: the rollback after the first
  deploy.
- `OPSCREW_E2E_PORTAINER_STEPS=2,10` runs steps 1, 1b, 2a, 2, 8, 9, 10 and 12.
- `OPSCREW_E2E_PORTAINER_STEPS=7b` runs steps 1, 1b, 2a, 2, 7b, 8, 9b and 12: the second app next
  to the first one's updater + tunnel setup, then both destroys.

An unknown step skips the whole test and names the variable.

The full pass takes about an hour (runs 9 and 10 on 2026-10-16: about ten deploy workflow runs,
one of which waits ten minutes for its failing health check before it rolls back, plus Docker's
installation); the core pass about 21 minutes with the second app (2026-10-18). The server is the
smallest x86 type, billed by the hour, so a run costs a few cents of server time, plus GitHub
Actions minutes for the builds (free for public repositories). Left behind on purpose, as for your
own server: the GitHub Actions secrets of other targets and the container images in the throwaway
repositories, the zone's rules that existed before the run, and the Zero Trust organization and
one-time PIN login if OpsCrew created them.

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

1. It runs `opscrew destroy --confirm <name> --no-snapshot`, the same command a user runs, with
   `--delete-data` when the app has a bucket at a provider (see [the components](#the-components)).
   On Hetzner it lifts delete protection first; on DigitalOcean (no delete protection) it goes
   straight to the destroy plan. Each plan is approved by its hash; then the deploy secrets are
   removed.
2. It asserts that nothing OpsCrew created for the app remains (SC-301, SC-401): on Hetzner no
   server, firewall or SSH key labelled `managed-by=opscrew,app=<name>`; on DigitalOcean no
   Droplet tagged `opscrew-app:<name>`, no firewall `<name>-firewall`, no SSH key `<name>-deploy`
   and no `opscrew-app:<name>` tag.
3. If `opscrew destroy` failed, it falls back to applying a destroy plan with the engine directly
   (lifting protection first on Hetzner), then to deleting those resources through the provider
   API, and asserts again that nothing is left. The shared `managed-by:opscrew` DigitalOcean tag
   is never deleted. A bucket is destroyed with its own `storage` root, and through R2's API when
   that fails; then no bucket of the app may be left.

That fallback normally runs only when destroy fails. To test it on purpose, set
`OPSCREW_E2E_SKIP_DESTROY=1` (off by default; the Hetzner pass only): the pass logs that it skips
`opscrew destroy` and goes straight to step 3. The engine's destroy plan removes the server, its
firewall and SSH key and the DNS records; the Hetzner API then deletes anything labelled
`managed-by=opscrew,app=<name>` that is left; with a Cloudflare domain, OpsCrew's shared rules that
list only the app's hostnames are deleted (`removeRulesOfRun`, see below), and when the engine's
destroy failed, the DNS records left on the run's own hostname are deleted too. The same leftover checks
as after a destroy must then pass: no labelled server, firewall or SSH key, no shared rule
listing the app's hostnames, no DNS record on them and no bucket. The fallback also deletes the
repository's deploy secrets that OpsCrew's record (`deploy_secrets.json` in the project's folder)
names, since they hold a storage key too. Every cleanup step and check runs even when an earlier
one fails, and the throwaway repository is reset last; the run then fails once, listing every
problem (after the error that stopped the run, when there was one), and the run's temporary
folder is removed.

Some things are not removed:

- **The app's hostnames in OpsCrew's shared rules:** `opscrew destroy` removes them. When destroy
  failed, the fallback deletes OpsCrew's rules that list only the app's hostnames (and a rule list
  this run created, once it is empty), as the own-server cleanup does, and the run then checks that
  no shared rule lists them. A rule that lists them next to other apps' hostnames is reported and
  left as it is, and that check fails: remove the app's hostnames from that rule in the Cloudflare
  dashboard (Security → WAF → Custom rules or Rules → Configuration Rules), or the next run stops
  before any change because they are already in OpsCrew's shared rule.
- **The bucket's key:** the S3 credentials you created for Hetzner Object Storage stay yours; the
  test never deletes them (OpsCrew never creates or deletes storage keys). R2's are those of the
  Cloudflare token, which stays as it is.
- **GitHub repository state:** the pushed container image (GHCR package), the Actions secrets
  OpsCrew's record does not name, and the pull requests stay in the throwaway repository (GitHub cannot delete pull requests; the next
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
| 2026-10-15 | Your existing Portainer, core pass, run 1 (a throwaway Hetzner server with Portainer CE 2.45.2, Compose v2.40.3, Docker 29.9.1; `e2e.opscrew.dev`) | Steps 1–3 and the leak search **passed**; step 8 failed on a test check; step 9 not reached | 14½ minutes. Setup, the limited token's registry steps (FR-1018), the three script runs (same stack plan hash on runs 2 and 3), the first deploy, `verify`, `secure`, `drift`; a merged change was live 32 s after the workflow wrote it; R5 confirmed (neither a webhook call nor the updater redeploys an unchanged branch). Findings: `opscrew init` failed its "Cloud provider token" check for a Portainer target (fixed, T1013); step 8's check matched the workflow file `opscrew-deploy.yml` in "What remains" although destroy had deleted the branch (test fixed, T1013). A bare `NAME:` with no value reaches the container as an empty value, as the guide says. Everything the run created at Hetzner, Cloudflare and GitHub was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 1 (after T1013) | Steps 1–2, step 3's self-deploying change and the leak search **passed**; stopped at step 3's rollback check | 26 minutes until the stop (step 3 alone 17, including the workflow's 10-minute health wait). `opscrew init` now checks your Portainer (T1013); a merged change was live 52 s after the workflow wrote it; R5 confirmed again. The deliberately failing change was rolled back: the workflow wrote the previous version back to `opscrew-deploy` and failed the run with "OpsCrew wrote the previous version back", as designed (the rollback step always fails the job, as on servers); the test expected that step to succeed (test fixed to read the step's message). Steps 4–11 not reached. Everything the run created at Hetzner, Cloudflare and GitHub was removed (the test's cleanup also deleted a zone ruleset the run had created). |
| 2026-10-16 | Your existing Portainer, full pass, run 2 | Stopped in step 2 (a test timing error) | 5 minutes. Provision's second script run created `opscrew-deploy` and stopped at the stack plan as designed, but the test read the branch through GitHub's Branches API right after it, which can briefly lag a ref just created through the Git Data API, and saw no branch (test now reads the ref and waits briefly). The leak search's "no value for portainer-webhook" followed from the early stop. Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 3 | Steps 1–2 and step 3's self-deploying change **passed**; stopped at the rollback check (a test permission error) | 26 minutes. The deliberately failing change was rolled back again (the deploy job's log: "OpsCrew wrote the previous version back"), but the test read the job's annotations, which need a Checks permission the test token does not have (HTTP 403); it now reads the deploy job's log, which the token's Actions permission covers (checked against this run). Steps 4–11 not reached. Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 4 | Steps 1–4 **passed** (the rollback check and the MCP apply included); stopped in step 5 | 36 minutes. A failing change rolled back (read from the deploy job's log); an MCP `opscrew_plan`/`opscrew_apply` replaced the registry token. Step 5 (the switch from the tunnel to Caddy): `opscrew drift` reported the removed Cloudflare setup as still in the state, and the leak check found the server's IPv4 (Portainer's address) in the saved removal plan `.opscrew/plans/…-removal.tfplan.json` (a local, gitignored file; nothing reached GitHub). Both fixed in T1014. Steps 6–11 not reached; the test's cleanup removed everything. |
| 2026-10-16 | Your existing Portainer, full pass, run 5 (after T1014) | Steps 1–5 **passed**; stopped in step 6 | 39 minutes. Step 5 now passes: the switch from the tunnel to Caddy (the removal plan saved without any address, drift clean after the removal, the app stack updated in place, certificates on 80/443). Step 6 (your own proxy): `verify --url` passed every check on the route but failed the domain's DNS, certificate and redirect checks, which in that mode are the user's (fixed, T1015: warnings). Steps 7–11 not reached; everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 6 (after T1015) | Steps 1–4 passed; step 5 failed | 45 minutes. The switch to Caddy applied the Caddy stack before the A record existed (the test creates it afterwards, and in a switch it cannot exist earlier); Caddy asked Let's Encrypt at once and the negative answer stayed cached, so the deploy's health check met a TLS alert for 10 minutes and the workflow rolled back (correctly). Run 5 had passed only by timing. Fixed in T1016: in caddy mode provision waits for the record before it starts Caddy. Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 7 (after T1016) | Steps 1–6 **passed**; stopped in step 7's `verify` | 44 minutes. Caddy now waits for its record and passes; your own proxy passes. Step 7 (Cloudflare redeploys with the tunnel): the three script runs worked (same stack plan hash), the deploy workflow reached Portainer's webhook through Access (cloudflared → Portainer with `no_tls_verify`), Portainer's hostname refused a request without the service token (401) and answered 404 outside `/api/stacks/webhooks/`. Then `verify` from the test computer found no record for the domain: step 6's `verify` had made Windows cache "no such name" (up to 15 minutes) and step 7 ran 4 minutes later. Fixed in T1017 (the test waits for the local resolver; `verify` explains a stale local answer). Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 8 (after T1017) | Steps 1–6 and most of 7 **passed** again; stopped waiting for this computer's DNS | 60 minutes. Step 7's deploy through Access and the site through public DNS passed, but this computer's resolver still had no answer for the domain after 16 minutes (a cache beyond Windows, likely the router's or ISP's, keeps the negative answer from step 6 for up to 30 minutes). Fixed in T1018: `verify` checks the site as the world sees it when this computer's DNS is stale. Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 9 (after T1018) | **Steps 1–11 passed**; the leak check (step 12) found two items | 58 minutes. Every step ran live for the first time: a failing change rolled back (the stack healthy again), an MCP apply ran the real provision (4 dialogs) and kept the registry grant, provision waited for Caddy's record and updated the stack in place, `verify` worked through the public DNS answer while this computer's was stale, destroy kept and then deleted the data (3 volumes) and the deploy branch, the updater reached a loopback Portainer through `host.docker.internal`, and the short host setup provisioned. Leak check: `verify --url` printed the route's IP in step 10 (Portainer at `localhost`, so the address was not registered) and the short host appears in `.opscrew/server.json` (by design; the test now allows it). Fixed in T1019. Everything the run created was removed. |
| 2026-10-16 | Your existing Portainer, full pass, run 10 (after T1019) | **Steps 1–11 passed**; the leak check's only item was a chance match | 59 minutes. Every step passed again, with `verify --url` keeping the route's address out of the output and `.opscrew/server.json` allowed to hold the short host. The leak check found no known value anywhere (commits, pull requests, files, CLI output, MCP results, the audit log); its one item was the 3-letter short host `nas` once inside an OpenTofu plan file, which is encrypted (AES-GCM, base64), so the match was chance, not a leak. The check now skips encrypted plan files and still searches every plain one; it reruns with steps 11 and 12 after the simplification (T1032). Nothing was left on Hetzner or Cloudflare |
| 2026-10-17 | Your own server (`OPSCREW_E2E_OWN_SERVER=1`), after the simplification (T1020–T1033) | **Passed** (8 live steps) | 22 minutes, on the shared live harness (T1031). Nothing was left on Hetzner, Cloudflare or GitHub (checked by the lead after the run: no servers, firewalls or keys; no `e2e-*` records, tunnels or Access apps; only `main`) |
| 2026-10-17 | Hetzner full flow (`live.test.ts`) with the Cloudflare domain, after the simplification | **Passed** (DigitalOcean and the retarget skipped: no DigitalOcean token) | 7 minutes; the deploy workflow succeeded. Nothing was left on Hetzner or Cloudflare; two branches (`opscrew/deploy-setup`, `opscrew/prepare-deploy`) stayed in the throwaway repository, which the next run's reset removed |
| 2026-10-17 | Your existing Portainer, `OPSCREW_E2E_PORTAINER_STEPS=2,3,11` (the core steps and the short host), after the simplification | **Passed** (steps 1, 1b, 2a, 2, 3, 8, 9, 11 and 12; the other six skipped as chosen) | 16 minutes, the first run with chosen steps (T1031). The leak search, now with step 11's random short host and encrypted plan files skipped, found nothing. Nothing was left on Hetzner, Cloudflare (records, tunnels, Access apps, service tokens) or GitHub |
| 2026-10-17 | Hetzner full flow (`live.test.ts`) with the Cloudflare domain, with OpsCrew's shared Cloudflare rules (feature 011, T1108) | **Passed** (DigitalOcean and the retarget skipped: no DigitalOcean token) | 7 minutes. The zone had no WAF custom or configuration rule lists before the run: the Cloudflare plan created both with OpsCrew's rule, the app's hostnames were in the probe block and the strict TLS rule after provision, and destroy deleted OpsCrew's rules and both rule lists. Nothing was left on Hetzner, Cloudflare (no rule lists, no `e2e-*` records) or GitHub (only `main`), checked by the lead after the run |
| 2026-10-18 | Your own server (`OPSCREW_E2E_OWN_SERVER=1`) with a second app in the same zone and account (feature 011, T1108) | **Passed** (all 10 steps, 6b and 7b included) | 36 minutes. A user rule seeded in each phase stayed byte-identical after every provision and destroy. OpsCrew's shared rules listed exactly the live apps' hostnames each time (the strict TLS rule went when the first app moved to the tunnel). Both apps were blocked on `/.env`; after the first app's destroy the second kept answering through its tunnel, stayed blocked and still refused a request without the service token. After the second app's destroy OpsCrew's rules were gone, and the Zero Trust organization and one-time PIN login stayed. The leak search found nothing. Nothing was left on Hetzner, Cloudflare (no rule lists, records, tunnels, Access apps or service tokens) or GitHub (only `main` in both repositories), checked by the lead |
| 2026-10-18 | Your existing Portainer, core pass with a second app (feature 011, T1108) | Steps 1, 1b, 2a, 2, 3 and 12 **passed**; **stopped in step 7b** | 14 minutes. The second app's Cloudflare plan was right (its hostname in OpsCrew's probe block), but its stack apply stopped: Portainer refused its ghcr.io registry entry, "Another registry with the same URL and credentials already exists". Portainer allows one entry per registry URL and login user name, and OpsCrew logged every app's entry in as `opscrew`. Fixed in T1109 (each entry's user name is its own name; GHCR checks only the token). Steps 8, 9 and 9b did not run. Nothing was left on Hetzner, Cloudflare or GitHub, checked by the lead |
| 2026-10-18 | Your existing Portainer, core pass with a second app, after T1109 | **Passed** (steps 1, 1b, 2a, 2, 3, 7b, 8, 9, 9b and 12) | 21 minutes. The second app got its own ghcr.io entry, its own stacks and its own tunnel in the same Portainer, and its hostname in OpsCrew's probe block next to the first app's. Both were blocked on `/.env`. The first app's destroys left the second working and protected; the second app's destroy removed OpsCrew's rules, and the seeded rules, the Zero Trust organization and one-time PIN login, Portainer and the decoys stayed. The leak search found nothing. Nothing was left on Hetzner, Cloudflare (no rule lists, records, tunnels, Access apps or service tokens) or GitHub (only `main` in both repositories), checked by the lead |
| 2026-10-18 | Hetzner full flow (`live.test.ts`) with the Cloudflare domain, after 011's simplification (T1110–T1113, T1114) | **Passed** (DigitalOcean and the retarget skipped: no DigitalOcean token) | 7 minutes; the app's hostnames in OpsCrew's shared rules after provision, gone after destroy |
| 2026-10-18 | Your own server with a second app, after 011's simplification (T1114), run 1 | Steps 1–6 **passed**; **stopped in step 6b** | 28 minutes. GitHub reported the second app's deploy run as completed with success while the run's "Deploy to the server" job stayed listed as in progress, every one of its steps (the health check included) already succeeded. The test read the job at once and stopped. Fixed in the harness: such a job counts by its steps when the run succeeded (a skipped or failed job still stops the run). Nothing was left |
| 2026-10-18 | Your own server with a second app, after 011's simplification (T1114), run 2 | **Passed** (all 10 steps) | 36 minutes. The leak search found nothing |
| 2026-10-18 | Your existing Portainer, core pass with a second app, after 011's simplification (T1114) | **Passed** (steps 1, 1b, 2a, 2, 3, 7b, 8, 9, 9b and 12) | 21 minutes. The leak search found nothing. Nothing was left on Hetzner, Cloudflare (no rule lists, records, tunnels, Access apps or service tokens) or GitHub (only `main` in both repositories) after all three passes, checked by the lead |
| 2026-10-18 | Hetzner builder checks (feature 012, T1211) with signing, `go-api` (Buildpacks), runs 1–3 | Stopped each time before the end | Run 1: the builder preflight stopped before anything was created, because cosign was not installed (v3.1.3 added to `.tools/bin`, checksum checked). Run 2: provision stopped because a Buildpacks app has no committed Dockerfile. Fixed: Buildpacks and Railpack need none. Run 3: deployed with Buildpacks (uid 1002, provenance and SBOM right, no secret in them). A merged change deployed under load with 4,791 requests and 0 failed, but the test's load generator sent 16.75 requests per second instead of 20, because Windows' timer fires late. It now sends by schedule. Nothing was left |
| 2026-10-19 | Hetzner builder checks with signing, `go-api` (Buildpacks) | **Passed** | 23 minutes. Built with Buildpacks, the pinned builder and run images. Runs as uid 1002. The provenance names the repository and the commit, with no event data, and the SBOM lists 172 packages. None of the 13 known secret values was in either. A merged change deployed under 20 requests per second: 5,185 requests, 0 failed. A broken release: 5,196 requests, 0 failed; the run failed with the builder hint and the previous version kept answering. After the image retention job GHCR still had every blob of the first and the running image. cosign verified both after the prunes |
| 2026-10-19 | Hetzner builder checks with signing, `rust-api` (Railpack) | **Passed** | 25 minutes. Built with Railpack and sealed. Runs as uid 10001. The SBOM lists 87 packages, and no secret was in it or the provenance. A merged change: 5,610 requests, 0 failed. A broken release: 5,586 requests, 0 failed, with the builder hint, and the previous version kept answering. Retention and cosign as for `go-api` |
| 2026-10-19 | Hetzner builder checks with signing, `nextjs-postgres` (generated Dockerfile), run 1 | **Stopped at the first deploy** | 12 minutes. Cloudflare answered 525 for the whole health check. Let's Encrypt allows 5 certificates per week for the same names, and refused a sixth for `e2e.opscrew.dev`: the Hetzner pass still used that fixed hostname, while the own-server and Portainer passes already used one per run (T923). Fixed: the Hetzner pass serves each run on `e2e-<run id>.<zone>` too. The deploy's certificate hint also counts Cloudflare's 525 and 526 behind the proxy now; it used to cover only unproxied domains. Also seen in every run so far: Dependabot's first `github_actions` and `docker_compose` runs failed, because the adapt pull request added `dependabot.yml` before the workflow and `opscrew/runtime` existed. Fixed in T1214: the file comes with provision's deploy-setup pull request. Nothing was left |
| 2026-10-19 | Hetzner builder checks with signing, `nextjs-postgres`, run 2 | **Passed** | 19 minutes. Built from the generated Dockerfile. Runs as uid 1000. The SBOM lists 302 packages, and none of the 14 known secret values was in it or the provenance. A merged change: 3,548 requests, 0 failed. A broken release: 4,776 requests, 0 failed, with the builder hint. Retention and cosign as above |
| 2026-10-19 | Hetzner with the Cloudflare domain and `OPSCREW_E2E_SKIP_DESTROY=1` (the fallback after a failed destroy), run 1 | Fallback **passed**; **stopped at the leftover check** | 8 minutes. The fallback removed this run's hostname from OpsCrew's shared rules. Both rules listed only it, so they went, with the two rulesets the run had created. The test's own teardown then failed. Its unprotect step added a second `delete_protection` to the root's server module, which has set `delete_protection = var.delete_protection` since T303, so OpenTofu refused the root ("Attribute redefined"). The API fallback removed the server, but the run's A and AAAA records stayed, and the lead deleted them. Fixed: the step now sets that line to `false` and says so when the line is missing. After a failed teardown the records left on the run's own hostname are deleted |
| 2026-10-19 | Hetzner with the Cloudflare domain and `OPSCREW_E2E_SKIP_DESTROY=1`, run 2 | **Passed** | 6 minutes. The fallback removed the run's rules and rulesets. The teardown removed the server and the records |
| 2026-10-19 | Your own server with a second app (012: kamal-proxy's switch, pins and builds on a server OpsCrew does not own) | **Passed** (all 10 steps) | 40 minutes. A merged change deployed through the tunnel and Access. The second app kept working after the first app's destroy. The leak search found nothing |
| 2026-10-19 | Your existing Portainer, core pass with a second app, with `OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN` | **Passed** (steps 1, 2a, 2, 3, 7b, 8, 9, 9b and 12) | 24 minutes. The narrower tunnel token handled the updater + tunnel setup: three provision runs, the deploy, `verify`, `secure`, `drift`, and a merged change deploying by itself. The full token took over at step 8, for removing the tunnel. Its permissions were exactly the starting list above (confirmed by the owner; the API cannot read them back): Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit, Zone → Config Rules → Edit and Account → Cloudflare Tunnel → Edit, the guide's list for tunnel mode. The leak search found nothing. After all the passes nothing was left on Hetzner, Cloudflare (no records, rule lists, tunnels, Access applications, policies or service tokens) or GitHub (only `main` in both repositories), checked by the lead |
| 2026-10-18 | Local Docker pass (`OPSCREW_DOCKER_TESTS=1`, T1208): all 25 examples (26 builds) built with their chosen builder and started | 23 of 26 builds **passed** every check | OpsCrew's Dockerfile for the 19 Node and Python examples, Buildpacks for Go, Spring Boot and .NET, Railpack for Rust: each ran as non-root and answered on its health route. Three failed. `laravel-app` on Railpack could not write to `public`, and FrankenPHP's file capability failed under `cap_drop: ALL`. `rails-api` needs `RAILS_ENV=production` and a `SECRET_KEY_BASE`. `react-router-ssr` failed the dev-dependency check, because npm keeps `typescript` as a peer of a production package. All three fixed in T1213 |
| 2026-10-19 | Local Docker pass for `laravel-app`, `rails-api` and `react-router-ssr` after T1213 | **Passed** | `laravel-app` with Railpack runs as uid 10001; `rails-api` with Buildpacks as uid 1002; `react-router-ssr` from OpsCrew's Dockerfile as uid 1000. Each answered 200 on its health route, and its Compose health check passed. `laravel-app` passed again after the review's change (`public` stays root's, and the seal makes the storage link) |
| 2026-10-19 | Hetzner with the Cloudflare domain, after T1214 (Dependabot's configuration comes with the deploy-setup pull request) | **Passed** | 8 minutes. After the deploy-setup pull request was merged, Dependabot's first runs all succeeded: `github_actions`, `docker_compose` (`/opscrew/runtime` and its subfolders), `docker` and `npm_and_yarn`. Before T1214 the first two failed in every run. Checked by the lead in the throwaway repository's Actions; no test asserts it. Nothing was left |
| 2026-10-19 | Hetzner builder checks with signing after the end-of-feature review's fixes (T1218): `go-api`, `rust-api`, `nextjs-postgres` | **Passed** (all three) | 21, 21 and 18 minutes. Every check passed again. The builders: Buildpacks, with pack checked against OpsCrew's checksum, the secret files removed and `.git` moved out of the build; Railpack, given `RAILPACK_RUST_VERSION`; and the generated Dockerfile. The apps ran as uids 1002, 10001 and 1000. The attestations held no secret (SBOMs of 172, 87 and 302 packages). Under load, the merged change and the broken release failed no request: 5,592 and 4,792 for `go-api`, 4,379 and 5,597 for `rust-api`, 3,545 and 4,772 for `nextjs-postgres`. The hint, retention and cosign checks passed as before. New: the change's deploy restarted none of `proxy` and `caddy`, nor `db` for `nextjs-postgres`. Dependabot's first runs all succeeded (Go modules, Cargo, npm, Docker, Compose, Actions). Nothing was left |
| 2026-10-19 | Local Docker pass after the review's fixes (T1218): `rails-api`, `laravel-app`, `spring-boot-api`, `dotnet-api`, `django-postgres`, `fastapi-sqlmodel`, `static-vite`, `nestjs-api`, `lovable-supabase` | **Passed** (58 checks, 15 skipped: the Node- and Prisma-only checks for other stacks) | Each built with its builder, answered its health route, ran as non-root and passed its Compose health check. The image's files (`docker export`), history and configuration held none of the known values, including one planted in a local `.env`. T1217, T1219 and T1220 had passed `nextjs-postgres`, `go-api`, `rust-api`, `monorepo-two-apps` and `express-api` the same way earlier that day. The lead removed what the pass created, by id; Docker's images and build cache matched their state before the pass |
| 2026-10-20 | Hetzner component checks (feature 013, T1315), `node-bullmq` | Failed twice, then **passed** | 16 minutes. Both failures were the test's: the owner check read the user of `/proc/<pid>`, which is root for a process that dropped to its own user and for the `tini` that Valkey's Alpine image runs, and the cron delay after the first deploy was timed from the checks' start (both fixed). One reboot left SSH unanswered for 10 minutes; on the rerun, a watcher saw the server back within 2 minutes. The queued job was consumed in 0.1 s, cron ran at its due minute after the reboot, the value was kept through a merged deploy and a reboot, and the leak search across 13 values (the containers' logs included) found nothing |
| 2026-10-20 | Hetzner component checks: `express-mysql`, `kafka-app`, `meili-search` with OpenSearch, `clickhouse-events` | **Passed** | 12–15 minutes each. MySQL's `innodb_buffer_pool_size` and ClickHouse's `max_server_memory_usage` matched OpsCrew's files, `vm.max_map_count` held after the reboot, and Kafka's job was consumed in 0.1 s |
| 2026-10-20 | Hetzner component checks: `node-mongo` and `rabbitmq-worker` | Failed, then **passed** after two test fixes | MongoDB's `configdb` stays empty outside a config server, so each service now needs data in one of its folders. After a reboot the RabbitMQ worker restarted 5 times until the broker answered, because Docker starts every container at once; the app's own processes may now restart after a reboot, but services may not |
| 2026-10-20 | `s3-uploads` with Cloudflare R2 | **Passed** | 14 minutes. The bucket came through its own approved plan; the app's file was read back after a deploy and a reboot; the teardown emptied and deleted the bucket |
| 2026-10-20 | `s3-uploads` with Hetzner Object Storage, runs 1–2 | Failed | Run 1: drift reported the bucket's CORS rule and tags as changed. The `aws` provider's schema (19.6 MB) was cut off at the runner's 16 MB limit, and Hetzner returns `{}` for no tags and `0` for an unset CORS max age (fixed, T1315a). Run 2: the create failed reading the new bucket back, because a Hetzner node did not know it yet (T1315b). A test bucket of the lead's was also still listed minutes after `tofu destroy`, and a second delete answered 204 (T1315b). Each run left nothing |
| 2026-10-20 | Your own server with two apps (feature 013, steps 6b–7b) | **Passed** (11 tests) | 48 minutes. `s3-uploads` with Garage ran next to `nextjs-postgres` on one server behind one edge, each app with its own tunnel. A change to each under 20 requests per second to each: 4,824 requests per site, 0 failed. The first app was destroyed under load on the second, and the edge and the `deploy` user went with the last app |
| 2026-10-20 | Your existing Portainer, core pass with `node-mongo` as the second app | Failed once (a test check), then **passed** (10 tests) | 23 minutes. The MongoDB stack stayed within its limits, published no port, and kept its data across a restart. OpenSearch added to `plan.yaml` was refused for `vm.max_map_count` before any change |
| 2026-10-20 | `s3-uploads` with Hetzner Object Storage, runs 3–5 (after T1315a–T1315c) | Run 3 failed, run 4 failed, run 5 **passed** | Run 3: the late bucket never reached the state, so the rerun's create got "name taken" for our own bucket, and the teardown left it (deleted by the lead). T1315c now imports a bucket this project tried to create, and refuses one it did not. Run 4: drift after the reboot failed, and the test did not print why (it does now); it did not recur. Run 5: 18 minutes; the bucket came through its own approved plan; drift was clean after the first deploy and after the reboot; the value was kept through both; the leak search across 14 values found nothing; the teardown deleted the bucket and checked it was gone |
| 2026-10-20 | After the end-of-feature simplify pass (T1318): `node-bullmq` and your own server with two apps | **Passed** (both) | 16 and 44 minutes. Route-only cron ran within its new 64 MB limit (the job was consumed in 0.1 s; cron ran at its due minute). Garage now starts with its own `--default-bucket`, and served `s3-uploads` next to `nextjs-postgres` behind one edge. A change to each under load: 4,816 and 3,191 requests per site, 0 failed. The cron delay after the reboot read "-60 s", because the test reads that the app answered a few seconds late; it now allows for that |
