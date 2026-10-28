# Live end-to-end test

What has run live, the results of every run and what has not run yet are in
[e2e-coverage.md](e2e-coverage.md). This page says how to run each live test and what its steps do.

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
| `OPSCREW_E2E_GITHUB_TOKEN` | Fine-grained token for that repository only. It needs Contents, Pull requests, Secrets, Actions, Workflows, Issues and Variables (read and write), plus Metadata (read). Issues and Variables are for feature 017's scheduled check, which design turns on for prod in every pass: OpsCrew reads its issues and sets its pause variable, and the test's reset closes its issues and deletes its label, variable and workflow (see [Cost and cleanup](#cost-and-cleanup)). |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Optional. A Cloudflare token limited to one zone, with Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit, SSL and Certificates Edit, Zone Settings Edit and Single Redirect Edit. |
| `OPSCREW_E2E_DOMAIN` | Optional, used together with the Cloudflare token: a hostname in that zone, for example `e2e.example.com`. It names the zone only: each run serves the app on its own hostname, `e2e-<run id>.<zone>`, because Let's Encrypt issues at most 5 certificates per week for the same names and every run's fresh server asks for one. |
| `OPSCREW_E2E_BUILDS` | Optional, `1` runs [the builder checks](#the-builders) in the Hetzner pass (with `nextjs-postgres`, `go-api` or `rust-api`): about 20–40 minutes and four deploys per app. Off by default. |
| `OPSCREW_E2E_GHCR_READ_TOKEN` | Needed with `OPSCREW_E2E_BUILDS=1`: a GitHub **classic** token with only `read:packages`, for the user that owns the throwaway repository. The test reads the image's SBOM, provenance and blobs with it. |
| `OPSCREW_E2E_SIGN` | Optional, `1` turns image signing on for the builder checks; it matters only together with `OPSCREW_E2E_BUILDS=1`. Off by default; read [Signing](#signing) first. |
| `OPSCREW_E2E_SKIP_DESTROY` | Optional, `1` makes the Hetzner pass skip `opscrew destroy` and clean up with the fallback a failed destroy gets (see [Cost and cleanup](#cost-and-cleanup)). Off by default. |
| `OPSCREW_E2E_COMPONENTS` | Optional, `1` runs [the component checks](#the-components) in the Hetzner pass (with one of the component examples): about 20 minutes, two deploys and a reboot per app. Off by default. |
| `OPSCREW_E2E_STORAGE` | With `OPSCREW_E2E_COMPONENTS=1` and `OPSCREW_E2E_APP=s3-uploads`: where the bucket goes, `r2` (the default) or `hetzner`. |
| `OPSCREW_E2E_R2` | `1` once R2 is turned on for the Cloudflare account and `OPSCREW_E2E_CLOUDFLARE_TOKEN` also has Account → Workers R2 Storage → Edit. Without it the R2 pass is skipped with a message. |
| `OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID`, `OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY` | For `OPSCREW_E2E_STORAGE=hetzner`: S3 credentials from the Hetzner Console of the throwaway project (Security → S3 credentials). Without them the Hetzner Object Storage pass is skipped with a message. The test never deletes them. |
| `OPSCREW_E2E_TLS` | Optional, one of `proxied`, `live`, `dns-only` or `recovery`: runs that pass of [origin TLS, the recovery copy and the deeper checks](#origin-tls-the-recovery-copy-and-the-deeper-checks) (feature 014) in the Hetzner pass, with the Cloudflare domain. Off by default. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS` | Needed with `OPSCREW_E2E_TLS=live`: a second token for the same zone with only Zone Read, DNS Edit, Config Rules Edit and Zone WAF Edit (no SSL and Certificates, no Zone Settings), so the first deploy goes live without origin protection. |
| `OPSCREW_E2E_OBSERVABILITY`, `OPSCREW_E2E_ADDONS` | Optional, `1` runs feature 017's passes in the Hetzner pass (the default app): logs, status, the scheduled check, and the add-ons. See [Observability](#observability). |

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
   server must run a new image afterwards. One exception, as in a browser: a request whose
   kept-alive connection the server closed before any answer ("other side closed", as nginx does
   with its idle connections when it reloads) is sent again once, logged and counted; it fails only
   if that fails too. Every load check in these tests works this way. The deploy must not restart any of the plan's services
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

### Origin TLS, the recovery copy and the deeper checks

Feature 014 runs in three places: four Hetzner passes of `live.test.ts`, chosen with
`OPSCREW_E2E_TLS` (one per run), [your own server with nginx](#your-own-server-with-nginx), and
step 5b of [your existing Portainer](#your-existing-portainer). Each needs the Cloudflare zone
(`OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN`), and the token needs all six zone
permissions: Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit, **SSL and Certificates Edit**
and **Zone Settings Edit**. The own-server and Portainer tests now read the zone's certificates
before the run even without feature 014's steps, so their token needs the six too.

`packages/cli/test/live/tls-checks.ts` holds the checks. Every Hetzner pass also:

- **makes the recovery copy:** before the first provision it sets a folder copy (`opscrew secrets
  folder`, so a public repository gets a copy too) and gives every provision `--key-out <file>`, a
  file in the test's own temporary folder, outside the repository and OpsCrew's folders;
- **checks the zone's minimum TLS decision:** before the first provision it reads the zone's
  setting and its proxied A, AAAA and CNAME records. When the setting is 1.0, editable, and every
  proxied record carries `Managed by OpsCrew`, the zone must be at 1.2 afterwards and
  `.opscrew/cloudflare.json` must say OpsCrew set it; otherwise the setting must be unchanged. **A
  zone that qualifies stays at TLS 1.2 after the run:** OpsCrew never lowers it, and the test never
  sets it back by hand;
- **ends with the leak search** (SC-1406): none of the tokens, the deploy key, the state passphrase,
  the generated values (the origin certificate's key and the client certificate's key among them,
  not the public certificates), the Portainer bundle built from them, nor the age identity from
  the key file is in any CLI output, commit, pull request or audit entry of the run, any saved plan
  in `.opscrew/plans/` (encrypted ones are skipped), `opscrew/SECURITY_REPORT.md`,
  `opscrew/RUNBOOK.md`, `.opscrew/cloudflare.json`, the state files in `.opscrew/tfstate/` or the
  folder copy. A pass with origin TLS fails with a finding when OpsCrew kept no origin keys;
- **checks the zone after the teardown:** no origin certificate for the run's hostnames that is
  not revoked, no client certificate the run uploaded and no origin pull setting of its hostnames
  still on. After a finished destroy anything left is a problem (the test removes it through
  Cloudflare's API and fails); after a failed destroy that removal is the fallback. Then nothing
  else in the zone may have changed: the DNS records off the run's hostnames (compared whole,
  reported by type and count only), the other origin certificates, the client certificates, and
  the minimum TLS (apart from the raise the plan made).

The passes:

| `OPSCREW_E2E_TLS` | What it checks |
|---|---|
| `proxied` | The usual proxied deploy, then: the site answers through Cloudflare (`cf-ray`); from Cloudflare's side, the record's origin certificate covers exactly the app's hostnames and each hostname's origin pull setting is on with the app's client certificate; from the server, as `deploy`, `opscrew secure`'s own `openssl s_client` checks to 127.0.0.1:443 (refused without the client certificate, the issuer Cloudflare's Origin CA, an unknown hostname refused); `opscrew secure --deep` within 5 minutes (SC-1403), no high or critical finding from testssl.sh (SC-1407), ssh-audit's policy passing apart from the listed noise (T1418), Lynis's hardening index, and secure's own origin checks passing. Needs Docker on this computer. |
| `live` | An app already live (SC-1408): the first provision uses `OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS`, so it records the permission gap (FR-1405) and the site goes live behind Cloudflare without origin protection. Then, as a user who adds the permissions, the pass switches to the full token and provisions and deploys again while it sends 20 requests per second through Cloudflare: no request may fail, and afterwards Cloudflare's side and the check from the server pass as for `proxied`. Before any change it checks that the narrower token really cannot read the zone's origin certificates. |
| `dns-only` | `dns.proxied: false` in `opscrew/plan.yaml` after design: the site answers straight from the server; CAA records at the app's hostname name exactly `letsencrypt.org` and `sectigo.com` (Caddy's), with `Managed by OpsCrew`; the zone's apex has the same CAA records as before; no origin certificate. |
| `recovery` | The default app (`nextjs-postgres`): a row written into its Postgres, then the project's folder (`~/.opscrew/projects/<id>`, under the test's `OPSCREW_HOME`) and the whole checkout (its `.opscrew` with it) deleted, a fresh clone, `opscrew secrets restore --key-file <file>` (from the committed copy, or with `--from` the folder copy when the repository is public), `provision --plan-only` with nothing to apply, `provision`, then the generated values, deploy key and state passphrase as they were, the row still there, and all of it within 5 minutes (SC-1402). The teardown then runs from the fresh clone. |

The origin check from the server (research "Spike results" 14): when the server cannot even
connect to 127.0.0.1:443 under OpsCrew's web filter, the test runs the same check from a throwaway
container of the pinned testssl.sh image (it has openssl) on the edge's network, against the
proxy's own address there, removes the image again when it was not there before, and records a
finding: `opscrew secure` then needs the same fallback. A Portainer stack has no edge network, so
there is no fallback there.

Run the passes one after another (each creates and destroys its own server):

```bash
pnpm --filter opscrew build
cd packages/cli
export OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com
for pass in proxied dns-only recovery; do
  echo "=== $pass"
  OPSCREW_E2E_TLS="$pass" npx vitest run test/live/live.test.ts || echo "FAILED: $pass"
done
OPSCREW_E2E_TLS=live OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS=… npx vitest run test/live/live.test.ts
```

**Expected time and cost** (not measured yet): `proxied` about 15 minutes (the usual 7, then
`secure --deep`), `live` about 20 (two provisions and two deploys, one under load), `dns-only`
about 10, `recovery` about 15. Each uses the recommended cx23 for about a quarter of an hour, about
one cent of server time, plus GitHub Actions minutes. Origin CA certificates, client certificates
and the per-hostname settings cost nothing on the Free plan.

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
   2b. **Logs and figures** (feature 017, SC-1701): as described in
   [the other targets](#the-other-targets). The app's lines come over SSH; `status` must show the
   server's load against its CPUs, its memory used of total, and its disk used and free.
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
   is gone, no `deploy` user is left and root still logs in with its key. No `authorized_keys` on
   the server holds a scheduled check's key line (`… opscrew-check:<owner>/<repo>`), and nothing of
   Beszel or Grafana Alloy is there: no container, volume or network of `opscrew-beszel` or
   `opscrew-alloy`, and no `/srv/opscrew/addons`. OpsCrew's shared rules are
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
- It removes the app's origin TLS (feature 014): it turns off the origin pull setting of each of
  the app's hostnames that is still on, deletes the client certificates that were not in the zone
  before the run, and revokes the origin certificates for the run's hostnames, each logged. After a
  finished `destroy` anything of it left is a problem that fails the run.
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
else). For feature 014's runs also: revoke the origin certificates for those hostnames (SSL/TLS →
Origin Server in the zone's dashboard), and with Cloudflare's API turn off their origin pull
settings (`PUT /zones/<zone id>/origin_tls_client_auth/hostnames` with `"enabled": null` for each
hostname) and delete the client certificates they used (`GET` and `DELETE
/zones/<zone id>/origin_tls_client_auth/hostnames/certificates`). The zone's minimum TLS version
stays as OpsCrew set it.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_OWN_SERVER` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write), used only by the test to create and delete the throwaway server. Use a separate, empty project. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | The throwaway repository and its token, as above. The token must cover `OPSCREW_E2E_GITHUB_REPO_B` too, with the same permissions (a fine-grained token can list several repositories). |
| `OPSCREW_E2E_GITHUB_REPO_B` | `owner/name` of a second **throwaway** repository, for the second app, `examples/s3-uploads` (steps 6b to 7b). The test force-pushes its `main` branch like the first one's. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | A Cloudflare token for the zone with Zone Read, DNS Edit, Config Rules Edit, Zone WAF Edit, SSL and Certificates Edit, Zone Settings Edit and Single Redirect Edit, plus the account permissions tunnel mode needs: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit, Access: Organizations, Identity Providers, and Groups Edit (the test also reads the Zero Trust organization and login methods with it, and seeds and removes its own rules). Cloudflare Zero Trust must be turned on for the account. |
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

## Your own server with nginx

`packages/cli/test/live/own-nginx.test.ts` runs the nginx edge (feature 014) on a throwaway
Hetzner server made as for [your own server](#your-own-server), with the same harness, scrubber and
cleanup. The first app is `OPSCREW_E2E_APP` (default `nextjs-postgres`), the second
`examples/express-api` from `OPSCREW_E2E_GITHUB_REPO_B`, each on its own hostname
(`e2e-<run id>.<zone>`, `e2e-<run id>-b.<zone>`), each with `target.edge: nginx` set in
`opscrew/plan.yaml` after design, as the guide says, and its recovery copy made as in the Hetzner
passes (a folder copy, `--key-out`).

1. The server, outside OpsCrew. Docker must answer on this computer (step 5).
2. **DNS only with nginx:** `init --fix`, analyze, interview (`server.serve: dns-only`), design,
   `target.edge: nginx`, adapt, provision, deploy. certbot gets the first certificate during that
   deploy: the site answers straight from the server with a Let's Encrypt certificate, the edge's
   Compose file says `x-opscrew-edge-proxy: nginx`, and the CAA records at the hostname name only
   `letsencrypt.org`. Then `verify`, `secure` and `drift`.
3. **An addition:** `opscrew/proxy/additions.nginx` with `location = /opscrew-e2e-addition { return
   200 "…"; }` committed, provision and deploy; the path answers with it, and still with OpsCrew's
   `Strict-Transport-Security` and `X-Content-Type-Options` headers.
4. **A forced renewal under load:** while 20 requests per second go to the health route, `certbot
   renew --force-renewal --no-random-sleep-on-renew --cert-name <app>` in the edge's certbot
   container; nginx must serve the new certificate (another serial number) within 3 minutes, and no
   request may fail. This costs one more Let's Encrypt certificate for the run's own names.
5. **`secure --deep` through nginx:** within 5 minutes (a finding otherwise), no high or critical
   finding from testssl.sh (SC-1407), ssh-audit's policy passing apart from the listed noise, and
   Lynis's hardening index.
6. **A second app on the same edge**, DNS only with nginx, set up the same way. Then the first
   app's `target.edge` set to `caddy`, with the addition rewritten in Caddy's syntax as OpsCrew asks,
   must be refused by `provision --plan-only` before any change ("which every OpsCrew app on it
   shares", "Nothing was changed"); the plan and the addition are put back.
7. **The second app's destroy** (without `--undo-host`): nothing of it left in Cloudflare, the first
   app still answers.
8. **Origin TLS on nginx:** interview and design again with `server.serve: proxy` (design keeps
   nginx), provision, deploy; the site answers through Cloudflare; Cloudflare's side and the origin
   check from the server as in the Hetzner `proxied` pass (on nginx a connection without the client
   certificate completes the handshake and gets HTTP 400, which counts as refused); `secure` and
   `drift`.
9. **A switch to Caddy and back**, now that one app is left: for each, the addition rewritten in
   that proxy's syntax and pushed, `target.edge` set, provision (its output must state the switch and its interruption), then the deploy while 20
   requests per second go through Cloudflare. The longest stretch of failed requests must be at
   most 15 seconds ("a few seconds" for a proxied hostname), the edge must then run the new
   proxy, and the addition must answer on it with OpsCrew's headers.
10. **`destroy --undo-host`:** nothing of the app left in Cloudflare, its origin certificate
    revoked, its client certificate and origin pull settings gone, no CAA record at its hostname,
    and root still logs in.
11. **The leak search**, as for your own server (step 8), plus the age identities of both apps'
    key files and, searched for secrets only, both apps' saved plans, reports, records, state files
    and folder copies.

The two apps are never one DNS-only and one proxied at the same time, as quickstart.md has it:
the apps on a server share one access mode, and the host plan refuses a proxied app (which needs
OpsCrew's web filter) next to a DNS-only one. So the pass covers certbot's certificates with two
apps first, and origin TLS on nginx once the second app is gone.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_OWN_NGINX` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_REPO_B`, `OPSCREW_E2E_GITHUB_TOKEN`, `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for [your own server](#your-own-server); the Cloudflare token needs the six zone permissions and none of the account's. |
| `OPSCREW_E2E_REGION`, `OPSCREW_E2E_OWN_SERVER_TYPE`, `OPSCREW_E2E_APP`, `OPSCREW_E2E_APP_ENV` | Optional, as for your own server (not `express-api`, the second app's). |

Requirements: those of your own server, and Docker on this computer. Run only this file:

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_OWN_NGINX=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_REPO_B=you/opscrew-e2e-b OPSCREW_E2E_GITHUB_TOKEN=… \
  OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/own-nginx.test.ts
```

**Expected time and cost** (not measured yet): about 75–90 minutes, with seven deploys (two first
deploys, the addition, origin TLS and two switches; the second app's one more), on the smallest x86
server (about one or two cents of server time), plus GitHub Actions minutes. The cleanup is that of
your own server; if a run was interrupted, delete what it left by hand as described there.

## Your existing Portainer

`packages/cli/test/live/portainer-target.test.ts` runs the flow for a Portainer the user already
runs (feature 010) on a real Portainer CE 2.45.2 that OpsCrew did not install.
`OPSCREW_E2E_PORTAINER_STEPS` chooses the steps:

- `core` (the default, about 21 minutes with the second app, measured on 2026-10-18; about 26 with
  feature 013's checks of the second app and feature 017's step 3c, not measured yet): steps 1,
  1b, 2a, 2, 3, 3c, 7b, 8, 9, 9b and 12. Step 8 then removes an updater + tunnel setup (one tunnel, no Access application), and
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
   through the tunnel serving the new version at `/.well-known/opscrew-version` (a one-shot `stamp`
   service writes it there, so the stack's Caddy never changes between deploys), `GET /api/stacks/{id}/file`
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

   3c. **Logs and figures** (feature 017, SC-1701), as described in
   [the other targets](#the-other-targets): the app's lines come through Portainer's API, and
   `status` must show each container's figures and name the host's disk as not available.
4. **An apply through MCP**: `opscrew mcp` with `opscrew_plan` and then `opscrew_apply` (against
   the real provision), both with `replaceTokens: ["registry"]` and the stack plan's hash as
   `planHash`. The test's MCP client approves the stack plan's dialog as the user would and never
   types a name. Afterwards the registry entry must still be granted to the environment.
5. **caddy**: the switch (the tunnel is removed with `--confirm <app>`; the app's stack keeps its
   `Id` and `CreationDate` and its `UpdateDate` or variables change, so it was updated in place,
   not created again), the DNS record OpsCrew prints is created by the test (DNS only, to the server), the
   deploy, the site with a Let's Encrypt certificate and without Cloudflare, `verify`, `drift`.

   5b. **Caddy behind Cloudflare's proxy** (feature 014), as the guide describes it: the recovery
   copy's folder and `--key-out` set as in the Hetzner passes, `dns.proxied: true` in
   `opscrew/plan.yaml`, the test's records from step 5 switched to proxied, then provision (its
   Cloudflare plan creates the origin certificate, uploads the client certificate and turns on the
   origin pull settings; the stack gets the bundle as a variable) and the deploy, until the site
   answers through Cloudflare with the deployed version. Then: Cloudflare's side and the origin
   check on the Portainer host (as root, `opscrew secure`'s own checks to 127.0.0.1:443, without the
   edge-network fallback) as in the Hetzner `proxied` pass; `opscrew secure --deep`, in which only
   testssl.sh runs (no high or critical finding) and Lynis and ssh-audit are skipped with their
   reason; and a merged change redeployed while 20 requests per second go through Cloudflare: no
   request may fail (T1416: Caddy holds them while Portainer recreates the app). Needs Docker on
   this computer. Steps 6 and later switch away from it; destroy (step 8) must revoke and remove the
   app's certificates and settings, which the cleanup checks.
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
[Live results](e2e-coverage.md#live-results). Problems that should not stop the run (for example a timing over
target or a missing secret) are `finding:` lines and fail step 12.

The cleanup always runs: it deletes the server, its SSH key and its firewall (everything labelled
with the run's id, and nothing else), removes what the run created in Cloudflare for each app (DNS
records on `e2e-<run id>.<zone>`, `e2e-<run id>-b.<zone>`, `www.` and `portainer-<app>.<zone>`,
the tunnels `opscrew-<app>` and `opscrew-<app>-portainer`, the Access application `OpsCrew
Portainer webhook (<app>)`, the policy and service token `OpsCrew deploy (<app>)`) and its origin
TLS (as for your own server: anything a finished destroy left fails the run), cleans up the
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
| `OPSCREW_E2E_CLOUDFLARE_TUNNEL_TOKEN` | Optional, to narrow the guide's Cloudflare list for the tunnel-only `updater` setup: a token with fewer permissions that OpsCrew uses in steps 2–4 (the test's own calls and the second app still use `OPSCREW_E2E_CLOUDFLARE_TOKEN`). Start with Zone → Zone → Read, Zone → DNS → Edit, Zone → Zone WAF → Edit and Zone → Config Rules → Edit (OpsCrew's shared rules: the probe block, and reading the configuration rules) and Account → Cloudflare Tunnel → Edit; when a step fails because a permission is missing, OpsCrew names it: add it and run again. Record the list that passed in [Live results](e2e-coverage.md#live-results). |
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
command; it includes step 5b, which needs Docker on this computer.

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
| 5b | 5 |
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
- `OPSCREW_E2E_PORTAINER_STEPS=5b` runs steps 1, 1b, 2a, 2, 5, 5b and 12 (expected about an hour,
  not measured yet: step 5 waits up to 35 minutes for the public resolver): Caddy with origin TLS
  in the stack, then the leak search. The cleanup removes the app's certificates and settings, as
  step 8 does not run.
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

## Environments and promotion

`packages/cli/test/live/environments.test.ts`, with `OPSCREW_E2E_ENVIRONMENTS=1`, runs
quickstart.md "2." and "3." of feature 015: prod and staging, each on a server OpsCrew creates at
Hetzner, in the Free private throwaway repository `OPSCREW_E2E_GITHUB_REPO`. OpsCrew gets the
Hetzner token here (`HCLOUD_TOKEN`), as a user's run does.

1. **Prod designed.** The example goes to the throwaway repository's `main`, as above. The test
   records the repository's visibility and owner, and the GitHub environments it already has (the
   cleanup never deletes those). Then `init --fix`, `analyze --no-ai`, `interview --answers`
   (Hetzner, the run's own hostname behind Cloudflare) and `design`. `opscrew localhost trust`
   then makes OpsCrew's local CA in the run's own OpsCrew home (a script only prints the trust
   command, so this computer's trust store never changes), so the leak search has a CA key to look
   for.
2. **Prod provisioned and deployed:** `adapt` (pull request merged), `provision` until done, the
   deploy, the site through Cloudflare and `verify --env prod`. The test keeps prod's plan hash, the
   SHA-256 of its canonical plan as `opscrew promote` binds it.
3. **Staging added under load.** While 20 requests per second go to prod's health route, with no
   failed request allowed (but see the exception below the steps): `env add staging --target hetzner --from main`, `provision --env
   staging` until done, and the merge of its deploy-setup pull request, which runs staging's
   workflow and prod's. Prod's plan hash must be the same after `env add` and after staging's
   provision. Then staging answers on its own hostname through Cloudflare (the name design gives,
   one level below the zone), `verify --env staging` passes, and `provision --env prod
   --plan-only` has nothing to approve. The test checks that staging's deploy secrets are where
   OpsCrew's record and plan say (in the GitHub environment `staging`, or as repository secrets
   prefixed `OPSCREW_STAGING_`), and logs what it found as `observed:` lines: the placement and
   the GitHub environment's rules. On a Free private repository it records what it finds there;
   the spike found the environment with its secrets and no rules (research.md "Spike results",
   item 1). `env list` shows both.
4. **Prod promoted from staging:** `env set prod --from staging`, `provision --env prod` until
   done (prod's workflow becomes the promoted one), and the merge of its pull request, which
   deploys staging again. Prod's secrets are checked where its record says. Prod's plan hash is
   taken again here, since `env set` changed prod's plan.
5. **A promotion:** a merged change deploys staging. Staging must then run a newer image than
   prod (read from each server's `.env` over SSH, as `deploy` with OpsCrew's key). `promote --to
   prod` stops at its approval and prints the command with the digest and the promotion's hash;
   the digest must be the one staging runs. `promote --to prod --digest <it> --approve <hash>`
   deploys it, and prod's server must then run exactly that digest (SC-1503). Then the site and
   `verify --env prod`.
6. **A rollback:** `promote --to prod --digest <prod's image before the promotion>`, approved the
   same way, puts prod's previous image back, read on its server.
7. **Staging destroyed under load:** `destroy --env staging --confirm <staging's app name>` with
   no failed request to prod (with the same exception). Nothing of staging is left at Hetzner, none of its deploy secrets is
   left at GitHub, the GitHub environment OpsCrew created for it is gone, and no DNS record is left
   on its hostnames. Prod still answers, `verify --env prod` passes, its plan hash is unchanged
   and provision has nothing to approve for it. `env remove staging --confirm staging` must then refuse, naming `env set prod --from`, since prod is still promoted from staging; after `env set prod --from main` it removes staging's files.
8. **Prod destroyed:** nothing of the app is left at Hetzner or in Cloudflare, and none of prod's
   deploy secrets at GitHub.
9. **Nothing leaked:** no known secret is in any CLI output, commit (every branch), pull request
   of the run, audit entry, or saved plan, state file, report or Cloudflare record of either
   environment. The known secrets are the tokens, both environments' deploy keys, state
   passphrases and generated values, and the local CA's key. No string shaped like a runner
   registration token (29 upper-case letters and digits starting with `A`) is anywhere there
   either, and no server address is in a commit or pull request. Every version of
   `.opscrew/cloudflare.json` holds only the zone's id, hostnames and phases.

The one exception in steps 3 and 7: Cloudflare can answer 520 to 527 to prod for a fraction of a
second while staging's origin pull setting rolls out (docs/guide/origin-protection.md, "Known
limits"; the founder accepted it on 2026-10-23). Such an answer is logged as accepted, with its
distance from the rollout, when it was sent within 3 seconds of a `deployed` entry for a
`hostname_association` in the account's audit log. Any other failure, a timeout included, still
fails the step. `OPSCREW_E2E_CLOUDFLARE_TOKEN` must be able to read the account's audit log for
this; when it cannot, every failure counts.

The steps stop at the first failure; the cleanup always runs:

- `opscrew destroy --env <env>` for each environment provisioned and not destroyed yet (staging
  first), within 10 minutes in all and at most 4 minutes per CLI run. A destroy that fails, or is
  still running when that time is up, is only logged.
- Then, whatever those did, through Hetzner's API: everything labelled
  `managed-by=opscrew,app=<app>` for each environment's app (`<app>` and `<app>-staging`), with
  any server's protection lifted first. Any of it still listed is a problem.
- Through GitHub's API: the runners with this run's labels, the GitHub environments that
  appeared during the run, and the deploy secrets OpsCrew's records name. The repository is then
  reset as above.
- In Cloudflare: the records this run created on its hostnames (prod's and staging's), the
  tunnels and Access objects of each environment's app, the origin TLS of those hostnames, and
  OpsCrew's shared rules that list only them, as for your own server.

If a run was interrupted, delete by hand: the Hetzner servers, firewalls and SSH keys labelled
`managed-by=opscrew` with the app's `app=` label; in the throwaway repository, the GitHub
environment `staging` and the Actions secrets named `OPSCREW_…` (repository and environment);
and in Cloudflare the records on the run's hostnames `e2e-<run id>.<zone>` and staging's
`staging-e2e-<run id>.<zone>` (and `www.`), and those hostnames in OpsCrew's shared rules.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_ENVIRONMENTS` | `1` runs this test (and, with `OPSCREW_E2E_GITHUB_REPO_C`, [the next one](#the-environment-rules-on-a-public-repository)). |
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write); OpsCrew creates both servers with it. Use a separate, empty project. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | The throwaway repository (private, on GitHub Free) and its token. The token also needs **Administration** and **Environments** (Read and write) and **Actions** (Read and write), as research.md "Spike results" lists. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for your own server: staging's hostname is in the same zone. |
| `OPSCREW_E2E_GHCR_READ_TOKEN` | Optional but recommended: the classic `read:packages` token of [the builders](#the-builders). The test gives it to OpsCrew as `OPSCREW_GHCR_READ_TOKEN`, which `promote` reads the image's digest and provenance with ([the guide](guide/environments.md#the-registry-token-for-promote)): GitHub's registry may refuse the fine-grained token. |
| `OPSCREW_E2E_REGION`, `OPSCREW_E2E_APP`, `OPSCREW_E2E_APP_ENV` | Optional, as above (examples only). |

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_ENVIRONMENTS=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/environments.test.ts
```

Not measured yet: about 90 to 120 minutes. It makes six deploy runs, five of them with a build,
plus two promotions. Two of the smallest x86 servers run for about an hour and a half each, a few
cents of server time. The builds use about 45 to 60 minutes of the private repository's GitHub
Actions minutes (GitHub Free has 2,000 a month).

## The environment rules on a public repository

With `OPSCREW_E2E_ENVIRONMENTS=1` and `OPSCREW_E2E_GITHUB_REPO_C` set, the same file also runs
the path where GitHub enforces every environment rule: a **public** throwaway repository (the
founder's, made on 2026-10-22). No domain is used, so this test never touches the zone. Prod is
designed there but never provisioned.

1. The example goes to that repository's `main`. The test stops unless the repository is public,
   and unless its approval policy for workflow runs from forks is something other than "all
   outside contributors" (GitHub's default is first-time contributors), since OpsCrew would then
   not refuse a runner. It records that policy and the repository's GitHub environments. Then
   prod's design (Hetzner, no domain) and `adapt` (pull request merged).
2. **The rules:** `env add staging --target hetzner --from prod` (promoted, so a reviewer is
   offered) and `provision --env staging` until done, which creates staging's server. The GitHub
   environment `staging` must exist with custom branch policies that let only `main` deploy.
   A script has no one to ask, so OpsCrew adds no required reviewer: the provision output must
   say so and name the setting, and the environment must list none. The test logs it as the
   recorded answer; the interactive offer is tried by hand. Staging's deploy secrets must be in
   that environment, and OpsCrew's record must say it created it.
3. **A runner for the public repository:** `env add selfhosted --target hetzner --from prod
   --runner server`, then only `provision --env selfhosted --plan-only`, without `--yes`, so
   nothing at GitHub can be approved in this run. Its output must refuse the runner ("GitHub says
   self-hosted runners should almost never serve a public repository") and say that a plan-only
   run changes nothing at GitHub. The fork policy must be unchanged, and no runner listed. **No
   self-hosted runner is ever registered on this repository**, and no provision of that
   environment is applied. `env remove selfhosted --confirm selfhosted` follows.
4. **Destroy:** `destroy --env staging --confirm <staging's app name>`. Nothing of staging is left
   at Hetzner, its secrets and the GitHub environment OpsCrew created are gone, and the fork
   policy is still the one recorded.
5. **Nothing leaked**, as in step 9 above, without the Cloudflare parts. The repository is
   public, so its commits and pull requests are everyone's to read.

The cleanup is the one above, for staging; it never changes the fork policy.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_GITHUB_REPO_C` | `owner/name` of a **public** throwaway repository. The test force-pushes its `main` branch. `OPSCREW_E2E_GITHUB_TOKEN` must cover it with the same permissions. |
| `OPSCREW_E2E_ENVIRONMENTS`, `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_TOKEN` | As above. |

Not measured yet: about 20 to 30 minutes, with one server for about 20 minutes (about a cent).
No deploy runs: staging's deploy-setup pull request is never merged.

## The server's runner

`packages/cli/test/live/runners.test.ts`, with `OPSCREW_E2E_RUNNER=1`, runs quickstart.md "4.":
prod at Hetzner with its deploy job on the server's own GitHub Actions runner, in the private
throwaway repository `OPSCREW_E2E_GITHUB_REPO`.

1. **Designed:** the example goes to `main`. The test stops there unless the repository is
   private: OpsCrew refuses a runner for a public one, and the test commits this computer's
   address to it. It reads GitHub's Actions address ranges
   (`actions` in `https://api.github.com/meta`) and this computer's public IPv4 address, which
   must be outside them. Prod's design follows (as above). Then, as a user edits
   `opscrew/plan.yaml`, it sets `environment.runner: server`, and sets `security.sshAllowedCidrs`
   to this computer's address alone. The address is masked in everything printed, and the leak
   search leaves it alone (the test put it in the plan itself).
2. **Provisioned:** `adapt`, then `provision` until done. The host plan must name the runner's
   label `opscrew-<app>-prod` and the pinned runner version. GitHub must then list an online
   runner with that label. The test reads the runner's credentials on the server (the private
   parts of `.credentials_rsaparams`, as `deploy`) for the leak search. The app's Hetzner firewall
   must let SSH in from exactly this computer, and from no address in GitHub's Actions ranges.
3. **The first deploy:** the deploy-setup pull request is merged, and its run must succeed. Every
   job that asked for the runner's label must have run on that runner, there must be at least one
   such job, and the build job must not be one of them (the production server's runner never
   builds). The firewall is checked again. Then the site through Cloudflare, `verify`, and
   `status`, which must show the runner online.
4. **A merged change** deploys the same way, under the same firewall, and the site answers.
5. **Destroy:** `destroy --confirm <app> --no-snapshot`. GitHub lists no runner with the label
   afterwards, and nothing of the app is left at Hetzner or in Cloudflare.
6. **Nothing leaked,** as for environments, now with the runner's credentials as well.

The cleanup is the one for environments: `opscrew destroy` if needed (within its 10 minutes),
then always Hetzner's API and GitHub's runners with the run's label, removed through the API.
It then force-pushes `main` back to the example's commit, so this computer's address in
`opscrew/plan.yaml` does not stay on it. The run's pull requests, closed by the reset, still show
the address in their changes; the repository is private, so only its collaborators see them.

If a run was interrupted, delete by hand, besides what the environments test lists: the runners
labelled `opscrew-<app>-prod` under the repository's Settings → Actions → Runners, and this
computer's address on `main` (force-push the example, or let the next run's push replace it).

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_RUNNER` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN`, `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for environments. The repository must stay private: OpsCrew refuses a runner for a public one. |

Requirements as for your own server. This computer's public IPv4 address must stay the same
during the run, since the firewall lets SSH in only from it.

```bash
OPSCREW_E2E_RUNNER=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/runners.test.ts
```

Not measured yet: about 45 to 60 minutes, with one server for under an hour (about a cent). The
two builds run on GitHub's machines (about 10 to 15 Actions minutes); the deploy jobs run on the
server.

## A runner machine

The same file, with `OPSCREW_E2E_RUNNER_HOST=1`: a throwaway Hetzner server becomes a runner
machine of the project (feature 015's runner machines, plan.md "16."). It builds the image
(`build: runner`) and deploys over SSH to prod's server, which OpsCrew creates at Hetzner.

1. **The machine:** the test stops unless the repository is private, as above. It reads GitHub's
   Actions ranges, creates a throwaway server outside
   OpsCrew as the own-server test does (root's login with a key made for this run, its host key
   pinned and checked on the server), and checks that its address and this computer's are
   outside those ranges. Prod is designed as above.
2. **Set up, with the SSH firewall:** `runner host add e2e-runner --ssh root@<address> --key <the
   run's key> --host-key <fingerprint> --harden firewall --ssh-from <this computer>/32`, its host
   plan approved by the hash it printed. `runner host list` must show it, and the machine must have
   the `deploy` user and Docker. OpsCrew's nftables table `inet opscrew` must accept port 22 from
   this computer and drop the rest, `opscrew-ssh-firewall.service` must be enabled, and no revert
   timer may be left pending. The machine is then rebooted, and the same checks pass again. SSH
   hardening (`--harden ssh`) is not part of the pass: the plan refuses it while OpsCrew logs in as
   root, which this machine does.
3. **Prod moves to it:** `env set prod --from main --runner host --runner-host e2e-runner --build
   runner`. `security.sshAllowedCidrs` in `opscrew/plan.yaml` becomes the machine's address and
   this computer's. Then `adapt` and `provision` until done. GitHub must list an online runner
   labelled `opscrew-<app>-prod`. Its credentials on the machine are read for the leak search,
   and prod's firewall must let SSH in from exactly those two addresses and none of GitHub's.
4. **The first deploy:** the build job and the deploy job must both have run on the machine's
   runner. The firewall is checked again, then the site and `verify`.
5. **Teardown:** `destroy --confirm <app> --no-snapshot`, each host plan it stops at approved by
   its hash. GitHub lists no runner with the label, nothing of the app is left at Hetzner or in
   Cloudflare, and the app's runner folder is gone from the machine. Then `runner host remove
   e2e-runner --confirm e2e-runner`, approved the same way, after which `runner host list` no
   longer shows it. OpsCrew's table and the firewall's service must be gone from the machine.
6. **Nothing leaked,** as above. The machine's address may appear in `plan.yaml` only inside the
   SSH source the test planned.

The cleanup is the one above, `main` put back included, plus the deletion of the throwaway
machine, as for your own server. If a run was interrupted, also delete that machine by hand: the
Hetzner server and SSH key labelled `managed-by=opscrew-e2e` and `run=<run id>`.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_RUNNER_HOST` | `1` runs this test. It needs the CLI's `runner host` commands (T1517e). |
| `OPSCREW_E2E_RUNNER_HOST_TYPE` | Optional, a Hetzner server type for the runner machine instead of the cheapest x86 one (it must be x86: prod's server is). |
| The others | As for the server's runner. |

```bash
OPSCREW_E2E_RUNNER_HOST=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/runners.test.ts
```

Not measured yet: about 50 to 70 minutes. Two of the smallest x86 servers run for about an hour
each (a few cents). The build runs on the machine, so it uses almost no GitHub Actions minutes.

## The local runner

`packages/cli/test/live/local-runner.test.ts`, with `OPSCREW_E2E_LOCAL_RUNNER=1`, runs
quickstart.md "5." of feature 015 (SC-1507): dev on this computer, its deploy job on the local
runner, in the private throwaway repository `OPSCREW_E2E_GITHUB_REPO`. The test starts the runner
in-process, with the CLI's deps, and stops it with `stop()`, since on Windows no Ctrl+C can be
sent to another process. No domain is used, so this test never touches the zone, and no server
is created.

1. **Prod designed:** Docker must be running here. The example goes to `main`, and the test stops
   unless the repository is private: a self-hosted runner must never serve a public repository.
   Prod's design follows (Hetzner, no domain); prod is never provisioned.
2. **Dev on this computer:** `env add dev --target localhost --runner local`. The test stops if
   Docker here already has a container or volume of the Compose project `opscrew-<app>-dev` or
   of OpsCrew's edge `opscrew-edge`, which its cleanup would remove. As a user edits the plan, it
   sets dev's `target.image` to `registry` (the runner deploys the image GitHub Actions built), and
   notes Docker's images. Then `adapt` (pull request merged) and `provision --env dev` until done,
   which starts the local stack and opens dev's deploy-setup pull request, left unmerged for now.
   `opscrew localhost trust` then only prints the trust command (a script), and the local CA's key
   joins the leak search.
3. **The runner and the first deploy:** `startLocalRunner` for dev. GitHub must list an online
   runner labelled `opscrew-<app>-dev`. The test reads the private parts of the runner's key in its
   `.credentials_rsaparams` for the leak search, after each registration (each one has a new key;
   on Windows the runner keeps it encrypted for the user, so there is nothing to read). Then dev's
   deploy-setup pull request is merged, and its run must succeed: every job that asked for the
   label ran on that runner, at least one did, and the build job did not (it runs on GitHub's
   machines). The site answers 200 on its health route at `https://<app>.localhost` through
   127.0.0.1, with the hostname as Host header and SNI, trusted only with OpsCrew's local CA;
   without it the certificate is refused. This computer's trust store never changes.
4. **A merged change** (the change file of the other tests) is deployed the same way, on the
   runner. The image in the app's `.env` on this computer must change, and the new version must
   answer within 10 minutes of the change's push (SC-1507).

   4b. **Logs and figures** (feature 017, SC-1701), as described in
   [the other targets](#the-other-targets), with `--env dev`: the lines come from local Docker,
   the request goes to `https://<app>.localhost` as in step 3, and `status` must show each
   container's figures and the CPUs and memory Docker has here.
5. **Stop:** `stop()`, after which the runner's `finished` resolves and GitHub lists no runner
   with the label. The runner's folder in the run's own OpsCrew home stays, with the pinned
   version.
6. **Destroy:** `destroy --env dev --confirm <app>-dev --delete-data`. Docker then lists no
   container, network or volume with the label of either Compose project.
7. **Nothing leaked,** as for environments, without the Cloudflare parts: no token, generated
   value, local CA key or runner key in any output (the runner's own included), commit, pull
   request, audit entry or state file, and no string shaped like a runner token.

The cleanup always stops the runner first. Then, when the test got that far, `opscrew destroy
--env dev --delete-data` if dev was not destroyed yet, and whatever Docker still lists with the
two Compose project labels (never anything else, and never a prune), and the images the run
pulled that Docker did not have before (the app's image from GitHub's registry and the stack's).
Then the cleanup of environments: GitHub's runners with the label, removed through the API, and
`main` put back to the example's commit.

If a run was interrupted, delete by hand: the runner labelled `opscrew-<app>-dev` under the
repository's Settings → Actions → Runners; in Docker, what has the label
`com.docker.compose.project=opscrew-<app>-dev` or `=opscrew-edge`, and the network `opscrew-edge`
if nothing uses it; and any runner process still running from the run's folder.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_LOCAL_RUNNER` | `1` runs this test. |
| `OPSCREW_E2E_HCLOUD_TOKEN`, `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN` | As for environments. The repository must stay private: OpsCrew refuses a runner for a public one. |
| `OPSCREW_E2E_GHCR_READ_TOKEN` | Optional but recommended, as for environments: dev's provision reads the image's digest from GitHub's registry with it. |
| `OPSCREW_E2E_REGION`, `OPSCREW_E2E_APP` | Optional, as above (examples only). |

Requirements: Docker running here with Linux containers, and on Windows Git for Windows' `bash`.
dev's first provision starts from an image built here (the example builds from its Dockerfile),
since dev has no image of its own before its first deploy (FR-1540). Keep `OPSCREW_TEST_TMP` short
on Windows: the runner's work folder is inside it.

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_LOCAL_RUNNER=1 OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_GHCR_READ_TOKEN=… \
  npx vitest run test/live/local-runner.test.ts
```

Not measured yet: about 30 to 45 minutes, with no server. The two builds run on GitHub's machines
(about 10 Actions minutes); the deploy jobs run on this computer.

## Cloudflare's hosting

`packages/cli/test/live/cloudflare-hosting.test.ts`, with `OPSCREW_E2E_CLOUDFLARE_HOSTING=1`, runs
quickstart.md "1.", "2.", "4." and "5." of feature 016 on Cloudflare's hosting (Workers with static
assets), on the run's own hostnames in the e2e zone. No server is created. It deploys two apps,
each in a throwaway repository of its own: `examples/static-vite` in `OPSCREW_E2E_GITHUB_REPO` on
`e2e-<run id>.<zone>`, and `examples/astro-ssr` in `OPSCREW_E2E_GITHUB_REPO_B` on
`e2e-<run id>-b.<zone>`. OpsCrew gets its own Cloudflare token (`CLOUDFLARE_API_TOKEN`) and the
deploy token (`OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`), as a user's run does.

The static site:

1. **Designed:** the example goes to `main` as above, and the test notes the repository's GitHub
   environments. Then `init --fix`, `analyze --no-ai`, `interview --answers`
   (`provider: cloudflare-workers` on the run's hostname) and `design`, which must plan a static
   site with preview URLs and `workers.dev` off. As a user edits the plan, the test turns `dns.www`
   on, so that `www.` is a custom domain too and OpsCrew's redirect rule is covered. The zone's
   rules and records are noted, and a rule of the user's own is seeded in two phases, as for
   [your own server](#your-own-server).
2. **Provisioned and deployed:** `provision` until done, the merge of the deploy-setup pull request
   and its workflow run, then the site's health route through Cloudflare. The time from the start
   of `provision` to that answer is logged; over 10 minutes is a finding that fails the run at the
   end (SC-1601). Then `verify`, and the zone's rules: the user's own unchanged, OpsCrew's listing
   the site's hostnames in the probe block and `www.` in the redirect.
3. **Headers and `www`:** OpsCrew's four headers on `/` and on a path that is no file (the
   single-page app's fallback). `https://www.<host>/opscrew/e2e?q=1` must answer 301 to the same
   path and query on the domain. A second `provision --plan-only --yes` right after the first must
   have nothing to approve, the redirect rule included (Cloudflare may echo defaults in a rule's
   parameters).
4. **A change:** a merged change adds `public/opscrew-e2e-change.txt`, which the site must serve
   within 5 minutes. `status` must then name a new running version and offer the one before as its
   rollback. Cloudflare's deployments must serve the version `status` names, and its message must
   name the run and the build's SHA-256.
5. **A rollback:** `promote --to prod --version <the one before>` stops at its approval (exit 1);
   with `--approve <hash>` it activates that version, and the site must serve the version before
   the change again (the change's file answers 404, or the single-page app). The time from the approved run's start is logged; over a minute is a finding
   (SC-1604).
6. **A Worker rename:** as a user renames the app's Worker, the test sets `target.worker` in
   `opscrew/plan.yaml` to `<worker>-r`. `provision` replaces the Worker (its plan deletes the old
   one, so it also needs the app's name, `--confirm`), and the merge of its pull request deploys the
   new Worker. The account must have no Worker of the new name before (the run stops otherwise,
   as for staging's Worker, so the cleanup only ever deletes Workers the run created). The old
   Worker must be gone, and every custom domain on the site's hostnames must
   belong to the new one.
7. **Promotion:** `env add staging --target cloudflare-workers --from main`, then staging's
   provision and deploy, on its own hostname and Worker. Then `env set prod --from staging` and
   prod's provision, whose pull request (prod's promoted workflow) is merged without a run. A merged
   change deploys staging; `promote --to prod`, approved by its hash, starts prod's workflow with
   staging's run and SHA-256. Prod's running version must name the same SHA-256 as staging's, and
   prod must serve what staging serves.
8. **Destroy:** `destroy --env staging --confirm <app>-staging`, then prod's. Staging's Worker must
   be gone; then nothing of the site may be left in Cloudflare (no Worker of the run, no custom
   domain or record on its hostnames), no deploy secret at GitHub, and the zone's rules must be as
   before the run.

The server-rendered app:

- **S1. Designed:** the example goes to repository B with the Docker pass's page
  `src/pages/secret.astro` (`packages/cli/test/e2e/__fixtures__/astro-secret`), which shows the
  SHA-256 of `STRIPE_SECRET_KEY`, never its value. The production values hold a stand-in for it.
  Then as above, with `adapt --no-ai --yes` (its pull request merged), which adds
  `@astrojs/cloudflare`. The plan must render on the server and list the variable.
- **S2. Provisioned and deployed,** with `verify`. Two requests to `/` 1.5 seconds apart must show
  two render times. OpsCrew's headers must be on `/` (the Worker's answer) and on `/favicon.svg` (a
  static file), and `/secret` must show the SHA-256 of the value.
- **S2b. Logs and figures** (feature 017, SC-1701), as described in
  [the other targets](#the-other-targets): `logs` shows the Worker's recent requests from Workers
  Logs, `logs --follow` the request's line from the Worker's live tail (the Astro app's 404 page
  is rendered by the Worker, so the request runs code), and `status` the Worker's requests, errors
  and CPU time of the last 24 hours.
- **S3. A new value:** the test writes another stand-in, and `provision` must set GitHub's
  `OPSCREW_ENV_STRIPE_SECRET_KEY` again. After a merged change, `/secret` shows the new value's
  SHA-256. Then the rollback of step 5, to the version that ran before the new value (noted
  first), with `promote --version <it>`. Cloudflare may refuse a
  version older than a secret change unless the deployment is forced (T1610b's note): when the
  approved rollback fails, the step fails with OpsCrew's output and says that `deployWorkerVersion`
  then needs Cloudflare's `force`. When it passes, the rolled-back version must serve its own
  (old) secret; anything else is a finding.
- **S4. Destroyed:** nothing of it may be left at Cloudflare or GitHub.

9. **Nothing leaked,** as for environments, over both apps: no token (the deploy token included)
   and no value of the SSR app's secret in any CLI output, commit (every branch of both
   repositories), pull request of the run, audit entry, saved plan, state file, report or
   Cloudflare record (SC-1602).

The steps of each app stop at its first failure; the cleanup always runs. It runs `opscrew
destroy` for each environment not destroyed yet (the SSR app first), within the budget of
[environments](#environments-and-promotion). Then, through the APIs: the GitHub environments that
appeared during the run and the deploy secrets OpsCrew's records name; in Cloudflare, the run's
Workers (under every name they had), the custom domains and records on the run's hostnames,
OpsCrew's shared rules that list only them, and the seeded rules; then both repositories are reset.

If a run was interrupted, delete by hand: in Cloudflare's **Workers & Pages**, the Workers each
plan's `target.worker` names (the example's app name, with `-r` after the rename and `-staging`
for staging), which takes their custom domains with them; the records on the run's hostnames
`e2e-<run id>…` and those hostnames in OpsCrew's shared rules; and in both repositories the Actions
secrets `OPSCREW_CLOUDFLARE_API_TOKEN`, `OPSCREW_CLOUDFLARE_ACCOUNT_ID` and `OPSCREW_ENV_…` (with
staging's prefix too).

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_CLOUDFLARE_HOSTING` | `1` runs this test. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_REPO_B`, `OPSCREW_E2E_GITHUB_TOKEN` | Two throwaway repositories and a token for both, as for environments (staging gets a GitHub environment). |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | As for your own server, plus Account → Workers Scripts → Edit for the zone's account: OpsCrew's own token creates the Workers and their custom domains, and the test lists them (and deletes what a failed destroy left). For step S2b also Account → Workers Observability → Read (`opscrew logs` reads Workers Logs with it). |
| `OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN` | A second token with only Account → Workers Scripts → Edit for the same account: the deploy token OpsCrew stores in GitHub ([the guide](guide/cloudflare-hosting.md#the-tokens)). |
| `OPSCREW_E2E_DOMAIN` | As above. |

Requirements: `git`, OpenTofu or Terraform, Node.js 22.9+ and npm (`adapt` updates the SSR app's
lockfile on this computer).

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_CLOUDFLARE_HOSTING=1 OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e \
  OPSCREW_E2E_GITHUB_REPO_B=you/opscrew-e2e-b OPSCREW_E2E_GITHUB_TOKEN=… \
  OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN=… \
  OPSCREW_E2E_DOMAIN=e2e.example.com npx vitest run test/live/cloudflare-hosting.test.ts
```

Not measured yet: about 90 to 120 minutes, with no server and no cost on Workers Free. It makes
about ten deploy runs, each a few Actions minutes.

## GitHub Pages

`packages/cli/test/live/github-pages.test.ts`, with `OPSCREW_E2E_GITHUB_PAGES=1`, runs quickstart.md
"3." and "4." of feature 016: `examples/hugo-site` on GitHub Pages in the public throwaway
repository `OPSCREW_E2E_GITHUB_REPO_C`, on the run's own hostname `e2e-<run id>.<zone>`. OpsCrew
gets the Cloudflare token for the DNS records.

1. **Designed:** the example goes to `main` as above. The test stops unless the repository is
   public and has no GitHub Pages site yet (turn one off in its Settings → Pages). Then `init
   --fix`, `analyze --no-ai`, `interview --answers` (`provider: github-pages`) and `design`, whose
   hostnames must be DNS-only. The zone's records and rules are noted, and a rule of the user's own
   is seeded, as above.
2. **Provisioned** until done, with `--pages-verification <stand-in>`. GitHub must show the Pages
   site published by the workflow with the custom domain; a DNS-only record of the hostname must
   point at GitHub Pages; the TXT record `_github-pages-challenge-<owner>.<host>` must hold the
   value; and provision must print the Verify step with the settings page. The zone's rules stay as
   before.
3. **Published:** the merge of the deploy-setup pull request and its workflow run; then
   `http://<host>/` must serve the site within 10 minutes.
4. **The certificate:** every 10 minutes (2 after OpsCrew saved the domain again), the test logs
   the certificate's state, whether HTTPS is enforced and GitHub's DNS check, and runs `provision`
   again until done. That saves the domain again once GitHub found the records valid, and enforces
   HTTPS once the certificate is issued. The wait gives up after 3 hours (GitHub documents up to 24;
   OpsCrew's spike saw about 65 minutes before the DNS check passed). Then `https://<host>/` must
   serve the site, `http://<host>/` must answer 301 to it, `verify` must pass and `status` must say
   that HTTPS is enforced.
5. **Destroy in the takeover-safe order:** while `destroy --confirm <app>` runs, the test reads the
   Pages site and then the hostname's records every 2 seconds. No sample may show a record pointing
   at GitHub while the site does not claim the hostname (SC-1605). Afterwards the Pages site and its
   `github-pages` environment must be gone, with no record on the hostname and no deploy secret,
   and the verification record must still hold the value.
6. **`destroy --delete-verification`** removes the verification record too, and nothing of the
   site may be left in the zone.
7. **Nothing leaked:** no token in any CLI output, commit, pull request of the run, audit entry,
   saved plan or state file.

**The Verify click is skipped.** GitHub has no API for it, and the record's value exists only on
the GitHub account's settings page, for a domain added there by hand (research.md "Spike results",
13). The run's hostname is new each run, and GitHub publishes the site and issues its certificate
without the verification, so the test gives provision a stand-in value of letters and digits, and
checks the record and the printed step. The click itself is tried by hand, with a domain added at
<https://github.com/settings/pages> and its real value.

The cleanup: `opscrew destroy` if the site was not destroyed yet; then the GitHub environments that
appeared during the run and the deploy secrets OpsCrew's record names; in Cloudflare the records
on the run's hostname and the verification record's name, and the seeded rules. Only then the
GitHub Pages site the run made (its custom domain first; step 1 refuses a repository that has one
already), after a fresh read of the zone: while a record on the run's hostnames still points at
GitHub, the cleanup keeps the site and names the record, so that no record ever points at GitHub
with no site claiming the hostname. Then the repository is reset.

If a run was interrupted, delete by hand in this order: the records on `e2e-<run id>.<zone>` and
`_github-pages-challenge-<owner>.e2e-<run id>.<zone>`; then in the repository's Settings → Pages the
custom domain, then GitHub Pages itself; then its `github-pages` environment.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_GITHUB_PAGES` | `1` runs this test. |
| `OPSCREW_E2E_GITHUB_REPO_C` | The **public** throwaway repository (the same as [the environment rules](#the-environment-rules-on-a-public-repository)). |
| `OPSCREW_E2E_GITHUB_TOKEN` | As above, with access to repository C, plus **Pages** and **Administration** (Read and write), which GitHub needs to change a Pages site and its health check. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for your own server. |

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_GITHUB_PAGES=1 OPSCREW_E2E_GITHUB_REPO_C=you/opscrew-e2e-public \
  OPSCREW_E2E_GITHUB_TOKEN=… OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com \
  npx vitest run test/live/github-pages.test.ts
```

Not measured yet: mostly GitHub's certificate, about 70 to 100 minutes going by the spike, and
up to 3 hours before the test gives up. No cost: the repository is public.

## Two apps in one repository

`packages/cli/test/live/several-apps.test.ts`, with `OPSCREW_E2E_SEVERAL_APPS=1`, runs US6 of
feature 016 (SC-1607) in `OPSCREW_E2E_GITHUB_REPO`: `examples/static-vite` in `sites/landing` is the
repository's first app, and `examples/hugo-site` in `sites/docs` the second, added as `e2e-docs`.
Both go to Cloudflare's hosting in the e2e zone, on `e2e-<run id>.<zone>` and
`e2e-<run id>-docs.<zone>`.

1. **Designed:** both examples go to `main` in their folders. `init --fix`, `analyze --no-ai --dir
   sites/landing`, `interview --answers` and `design` for the first app; then `app add e2e-docs
   --dir sites/docs`, and the same with `--app e2e-docs`. The plans must name different workflows
   and Workers, and `app list` must show both; the account must have no Worker `e2e-docs` yet.
   A rule of the user's own is seeded, as for [your own server](#your-own-server).
2. **Provisioned and deployed:** each app's `provision` until done and the merge of its pull
   request, with its own workflow's run. Each site must answer on its own hostname with OpsCrew's
   headers, `verify` and `verify --app e2e-docs` must pass, and each app's deploy secrets must be
   where its record says, with no name in common. OpsCrew's shared rules must list both apps'
   hostnames, and the user's own rules stay unchanged, here and after steps 3 and 4.
3. **The second app destroyed:** `destroy --app e2e-docs --env prod --confirm <its name>`. Its
   Worker and the custom domains on its hostname must be gone, and its secrets too; the first app
   must still answer, with its secrets, and pass `verify` (SC-1607).
4. **The first app destroyed:** nothing of either app may be left in Cloudflare, and none of the
   first app's secrets at GitHub.
5. **Nothing leaked,** as above, over both apps' files.

The cleanup is that of [Cloudflare's hosting](#cloudflares-hosting), for both apps (the second
first); delete by hand in the same way.

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_SEVERAL_APPS` | `1` runs this test. |
| `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GITHUB_TOKEN`, `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for [Cloudflare's hosting](#cloudflares-hosting). |

```bash
pnpm --filter opscrew build
cd packages/cli
OPSCREW_E2E_SEVERAL_APPS=1 OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN=… \
  OPSCREW_E2E_DOMAIN=e2e.example.com npx vitest run test/live/several-apps.test.ts
```

Not measured yet: about 30 to 45 minutes, with no server and no cost on Workers Free.

## Observability

Feature 017 (logs, figures, the scheduled check and the two add-ons) runs live in four places:

- **The Hetzner pass of `live.test.ts`** with `OPSCREW_E2E_OBSERVABILITY=1` (logs, status, the
  check, the leak search) and/or `OPSCREW_E2E_ADDONS=1` (Beszel, and Grafana Cloud when its
  variables are set), on a server OpsCrew creates
  (`packages/cli/test/live/observability-checks.ts`). Both run with the default app only.
- **The move** from Hetzner to DigitalOcean (`live.test.ts`, both provider tokens) gains the
  check's pause with `OPSCREW_E2E_OBSERVABILITY=1` and a Cloudflare domain.
- **The other targets' passes** each gain one step of logs and figures: your own server (step 2b),
  your existing Portainer (step 3c), the local runner (step 4b) and the server-rendered app on
  Cloudflare's hosting (step S2b).
- **Windows, by hand** (below).

### The request log and the seeded secret

The examples log nothing per request, so the tests add a file to the copy of
`examples/nextjs-postgres` they push: `proxy.ts`, a Next.js 16 proxy that runs in the app's server
process and logs one line, `opscrew-e2e request <method> <path>`, for each request to a path that
starts with `/opscrew-e2e-` (and nothing for any other request). The other targets' passes add it
when they deploy that example (the default); with another `OPSCREW_E2E_APP` they log that the
request's line is not checked. In the Hetzner pass the line of a request to
`/opscrew-e2e-seeded-<random>` also prints `seeded=<value of SEEDED_SECRET>`: the seeded secret of
the leak search (SC-1704), a random value made for each run and given to OpsCrew as one of the app's
production values. Only the test's own requests print it, so the test chooses when: after Grafana
Cloud's masking file is in place (OpsCrew writes it at the deploy after `addon enable
grafana-cloud`, as the guide says; until then Alloy masks only secret-shaped values).

### The other targets

The step every target's pass takes (SC-1701, US2):

1. `opscrew logs` (with `--env dev` on the local runner) must show at least one line, timed from
   the command's start to its end; over 10 seconds is a finding that fails the run at its end.
2. With the request log: `opscrew logs --follow` is started as a user starts it, and once it shows
   its first line, the test requests `/opscrew-e2e-follow-<random>` from the app's address. The
   request's line must show within 10 seconds of the request; slower, or missed, is a finding, and
   after three requests 30 seconds apart without the line the step fails. Then the test sends
   Ctrl+C (SIGINT): the command must end within 30 seconds with exit code 0 and no error message.
   On Windows no Ctrl+C can be sent to another process, so there the command is stopped and the
   test logs that Ctrl+C is to be checked by hand.
3. `opscrew status` must show the figures ("Resources (read now)"): on a server, the load against
   the CPUs, the memory used of total and the disk used and free, and each part's CPU and memory;
   in a Portainer, each part's figures and the host's disk named as not available; on this
   computer, each part's figures and Docker's CPUs and memory; on Cloudflare, the Worker's
   requests, errors and CPU time of the last 24 hours.

Everything the commands print is kept for each pass's leak search.

### The Hetzner pass

With `OPSCREW_E2E_OBSERVABILITY=1`, the pass edits `opscrew/plan.yaml` after design as a user
would (`observability.check.webhook: ntfy`) and gives OpsCrew the webhook's address in
`OPSCREW_CHECK_WEBHOOK` (`https://ntfy.sh/<OPSCREW_E2E_NTFY_TOPIC>`). After the usual deploy,
verify, secure and drift:

1. **Logs and figures** as above, on the server.
2. **Grafana Cloud on** (with `OPSCREW_E2E_ADDONS=1` and its six variables; quickstart "6."):
   `addon enable grafana-cloud --metrics-url … --metrics-user … --logs-url … --logs-user …
   --plan-only --yes` must show OpsCrew's estimate of series and log volume before the plan; then
   the run with each printed `--approve <hash>` (the token in `OPSCREW_GRAFANA_CLOUD_TOKEN`).
   `addon status --json` must show Alloy's containers running; their memory is logged, and more
   than design showed is a finding (SC-1706). With the read token, the test asks the stack's
   Prometheus for the app's series (`count by (__name__) ({app="<app>"})`) until the server's CPU,
   memory and disk are there (`node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`,
   `node_filesystem_avail_bytes`): later than 5 minutes after enable is a finding (SC-1707). The
   app's series (`count({app="<app>"})`) are logged; 1,000 or more is a finding. Then `provision`
   and the deploy of its pull request, which writes Alloy's masking file. A seeded request's line
   must then reach the stack's Loki (`{app="<app>"} |= "<path>"`), labelled with the app, `prod` and
   its service, with the secret masked (`seeded=<opscrew:…>`); later than 5 minutes after the
   request is a finding.
3. **The seeded line in the terminal and in MCP:** a seeded request, then `opscrew logs --since 15m`
   must show its line with the secret masked (`seeded=[REDACTED:…]`), and so must MCP's
   `opscrew_logs` (through `opscrew mcp`, as the plugin calls it).
4. **The check, run by dispatch** (`workflow_dispatch` on `opscrew-check.yml`, as `gh workflow run`
   does; with `OPSCREW_E2E_OBSERVABILITY=1`, quickstart "3."). The plan must have the check on with
   the ntfy webhook, and the deploy-setup pull request must have put the workflow and
   `opscrew/check/check.json` on `main`. Each dispatched run must succeed (the check exits 0
   whenever it could report).
   - **A passing run:** its jobs' times are logged, with the minutes GitHub bills (each job rounded
     up to a whole minute, and GitHub's own `/timing` figure when it gives one), and the month's
     minutes at the interval in `check.json`; over 750 in a private repository is a finding
     (SC-1705). It opens no issue.
   - **The app stopped** (`docker compose stop` in the app's folder, as `deploy`), once its health
     route fails: one open issue per hostname of the app, each with its key
     (`<app>/prod/https/<hostname>`) and a title and body naming the app, `prod` and the hostname
     (SC-1702); an ntfy post with each issue's title (read back with ntfy's poll API); `opscrew
     status` showing the check on and each open alert. A second run adds nothing: no new issue,
     no new comment.
   - **The app started again** (`docker compose start`), once it answers: a run closes each issue
     as completed with "Resolved after <duration>." (logged), and ntfy gets the "resolved" posts.
   - **The disk past 85%:** a file (`/home/deploy/opscrew-e2e-fill`, made with `fallocate`) takes
     the disk to 87% as the check counts it. `status` must flag the disk, and a run must open the
     disk issue (`<app>/prod/disk/<server id>`), naming the server and its free space (SC-1703),
     with its ntfy post. The issue stays open for destroy (below).
5. **Beszel** (with `OPSCREW_E2E_ADDONS=1`; quickstart "5.", SC-1706): `addon enable beszel` (hub
   mode, local access), plan then approve. Its containers run and their memory is logged (more
   than design showed is a finding); port 8090 does not answer on the server's address. Then
   `opscrew addon open beszel` runs as a user runs it: through its SSH tunnel Beszel's API answers
   on `http://localhost:8090`, logs in as `admin@opscrew.invalid` with the password from
   `beszel_secrets.json`, and shows this server up with its containers, the app's among them;
   Ctrl+C ends the tunnel as above. `addon disable beszel --approve <hash> --confirm <app>`
   (deleting its history) must leave nothing: no container, volume or network of the Compose
   project `opscrew-beszel`, no `/home/deploy/opscrew/addons/beszel`, and no
   `beszel_secrets.json` on this computer.
6. **Grafana Cloud off:** every line the app sent this run is read back for the leak search; then
   `addon disable grafana-cloud` (plan, approve) must leave no container, volume or network of
   `opscrew-alloy`, no `/home/deploy/opscrew/addons/alloy` (nor the empty `addons` folder), no
   masking file (`/srv/apps/<app>/mask.re`) and no token on this computer. `provision` and its
   deploy then take the masking file out of the workflow, and the server must still have none.
7. **The leak search** (SC-1704): the seeded secret, the GitHub, Hetzner and Cloudflare tokens, the
   ntfy topic, Grafana Cloud's two tokens, Beszel's password, token, hub key and session, and the
   values OpsCrew generated must be in none of: every CLI output of the run and the long-running
   commands' outputs (the terminal), MCP's results and standard error, the run's `opscrew-check`
   issues (titles, bodies and comments), the ntfy posts since the run started, the app's lines in
   Grafana Cloud, the commits (every branch), the run's pull requests and the audit log. Only
   labels and places are printed.

Then the usual teardown. After a finished destroy, `OPSCREW_CHECK_PAUSED` must pause the
environment as destroyed, and one more dispatched run must close the open disk issue with "Closed
while the check is paused." (quickstart "4."). Any issue of the run still open after the teardown
is a problem; the repository's reset closes it (see [Cost and cleanup](#cost-and-cleanup)).

### Retarget's pause

In the move from Hetzner to DigitalOcean, with `OPSCREW_E2E_OBSERVABILITY=1` and a Cloudflare
domain: after the switch (before `--finish`), `OPSCREW_CHECK_PAUSED` must pause the environment for
the move. The test stops the app on the new server, and once its health route fails a dispatched
run of the check must open no issue for it (FR-1709). The app is started again, and the move goes
on to `--finish`. The window itself runs inside one `retarget` run, which no test can dispatch the
check during; the variable it sets is the same one this run reads.

### Windows, by hand

When a Windows computer is available for the run (T1712a's review): in a project deployed on a
server, run `npx opscrew logs --follow`, press Ctrl+C, and do the same with `npx opscrew addon open
beszel`. Each must end without an error message. The runner does not detach its children on
Windows, so `ssh.exe` may get the signal first; record what you saw in
[the coverage page](e2e-coverage.md#live-results).

### Variables and running it

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_OBSERVABILITY` | `1` runs logs, status, the check and the leak search in the Hetzner pass, and the pause in the move. Needs `OPSCREW_E2E_CLOUDFLARE_TOKEN` and `OPSCREW_E2E_DOMAIN` (the check checks the app's hostname over HTTPS) and `OPSCREW_E2E_NTFY_TOPIC`. |
| `OPSCREW_E2E_NTFY_TOPIC` | A topic on ntfy.sh, 16 to 64 letters, digits, `-` or `_`. Anyone who knows a topic can read it, so make it random (for example `opscrew-e2e-` and 20 random letters). Nothing to create: ntfy makes it on the first post. |
| `OPSCREW_E2E_ADDONS` | `1` runs Beszel, and Grafana Cloud with the variables below. Port 8090 must be free on this computer (Beszel's tunnel). |
| `OPSCREW_E2E_GRAFANA_CLOUD_METRICS_URL`, `OPSCREW_E2E_GRAFANA_CLOUD_METRICS_USER` | The Grafana Cloud stack's Prometheus `remote_write` URL (`https://prometheus-….grafana.net/api/prom/push`) and its numeric user id, from the stack's details page. |
| `OPSCREW_E2E_GRAFANA_CLOUD_LOGS_URL`, `OPSCREW_E2E_GRAFANA_CLOUD_LOGS_USER` | The stack's Loki push URL (`https://logs-….grafana.net/loki/api/v1/push`) and its numeric user id. |
| `OPSCREW_E2E_GRAFANA_CLOUD_TOKEN` | An access policy token with only `metrics:write` and `logs:write`, the one the guide asks for: OpsCrew gets it. |
| `OPSCREW_E2E_GRAFANA_CLOUD_READ_TOKEN` | A second token with only `metrics:read` and `logs:read`, for the test's queries. OpsCrew never gets it. |

All six Grafana Cloud variables or none: with some missing the pass is skipped and names them.
Use a free stack of its own (the test never deletes what Alloy sent). The pass also needs the
Hetzner pass's own variables, and the GitHub token's Issues and Variables permissions (see
[Setup](#setup)).

```bash
pnpm --filter opscrew build
cd packages/cli
export OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  OPSCREW_E2E_CLOUDFLARE_TOKEN=… OPSCREW_E2E_DOMAIN=e2e.example.com
# Logs, status, the check and the leak search.
OPSCREW_E2E_OBSERVABILITY=1 OPSCREW_E2E_NTFY_TOPIC=opscrew-e2e-… npx vitest run test/live/live.test.ts
# The add-ons (Beszel; Grafana Cloud with its six variables set).
OPSCREW_E2E_ADDONS=1 npx vitest run test/live/live.test.ts
# Or both on one server (the leak search then covers Grafana Cloud's lines too).
OPSCREW_E2E_OBSERVABILITY=1 OPSCREW_E2E_ADDONS=1 OPSCREW_E2E_NTFY_TOPIC=opscrew-e2e-… \
  npx vitest run test/live/live.test.ts
```

The other targets' steps run with their own passes, unchanged.

**If a run was interrupted** (the cleanup never ran): delete the server as for the Hetzner pass,
then in the throwaway repository run any live test once (its reset at the start removes the
check's workflow, issues, label, variable and secrets), or by hand: delete
`.github/workflows/opscrew-check.yml` from `main`, close the issues labelled `opscrew-check` (their
titles name the run's hostname, `e2e-<run id>.<zone>`), and delete the label, the variable
`OPSCREW_CHECK_PAUSED` and the secrets `OPSCREW_CHECK_*` and `…CHECK_SERVER` under Settings →
Secrets and variables → Actions.

**Expected time and cost** (not measured yet):

| Pass | Time | Cost |
|---|---|---|
| `OPSCREW_E2E_OBSERVABILITY=1` | about 35 minutes: the usual 10, then about 20 for the check's six dispatched runs (each a minute or two, the stopped app's with its three tries 30 seconds apart) and the waits, and a run after destroy | a cx23 for under an hour, about one cent of server time; about 10 Actions minutes for the build and the check's runs (`ubuntu-slim`; free in a public repository); ntfy.sh is free |
| `OPSCREW_E2E_ADDONS=1` with Grafana Cloud | about 45 minutes: the usual 10, Beszel about 5, Grafana Cloud about 30 (up to 5 minutes for its figures, two provisions and deploys, up to 5 minutes for the line) | a cx23 for about an hour, one to two cents; two more builds' Actions minutes; Grafana Cloud's free tier |
| Both | about 70 minutes | a cx23 for one or two started hours, about two cents |
| Retarget's pause | about 5 minutes more in the move | nothing more |
| Each other target's step | about 1 to 2 minutes | nothing more |

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
4. With `OPSCREW_E2E_TLS`, the app's origin certificates, client certificate and origin pull
   settings left in the zone are removed through Cloudflare's API (a problem after a finished
   destroy), and nothing else in the zone may have changed (see
   [Origin TLS, the recovery copy and the deeper checks](#origin-tls-the-recovery-copy-and-the-deeper-checks)).
5. With `OPSCREW_E2E_OBSERVABILITY`, destroy's pause of the scheduled check is checked, and any of
   the run's `opscrew-check` issues still open is a problem (see [Observability](#observability)).
6. Every live test resets its throwaway repositories last (the own-server, Portainer and other
   tests too). Besides closing pull requests and deleting branches, the reset removes what
   feature 017's scheduled check leaves, since design turns the check on for prod in every pass: it
   cancels the check's queued and running runs, deletes `.github/workflows/opscrew-check.yml` from
   `main` (a commit with `[skip ci]`, so nothing runs; without it the check would keep checking
   the torn-down app every hour), closes every open issue labelled `opscrew-check`, and deletes the
   label, the repository variable `OPSCREW_CHECK_PAUSED` and the check's secrets
   (`OPSCREW_CHECK_SSH_KEY`, `OPSCREW_CHECK_WEBHOOK`, `OPSCREW_CHECK_NTFY_TOKEN` and each
   `…CHECK_SERVER`). Anything GitHub keeps is a problem that fails the run. The reset at the start
   of a run does the same, so an earlier interrupted run never changes this one.

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
  OpsCrew's record does not name, the closed `opscrew-check` issues and the pull requests stay in
  the throwaway repository (GitHub cannot delete pull requests, and deleting issues needs an admin;
  the next run closes open ones, deletes the branches and overwrites the rest). Delete and recreate
  the repository for a completely clean slate.
- **Feature 017's outside data:** the ntfy posts stay on ntfy.sh for its cache time (12 hours), and
  the lines and metrics Grafana Alloy sent stay in the Grafana Cloud stack for its retention (14
  days on the free plan), labelled with the app's name (`app="<name>"`).

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
account's own contact. The real purchase of `opscrew.dev` ([Live results](e2e-coverage.md#live-results), 2026-10-14) covers the
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
