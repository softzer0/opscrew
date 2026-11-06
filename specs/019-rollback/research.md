# Research: rollback (019)

Research from 2026-10-31. Two parts:
- A Sonnet agent read only official documentation: Kamal, Vercel, Heroku, Render, Fly.io,
  Cloudflare Workers, GitHub Pages, GitHub Container Registry and GitHub Actions.
- A Sonnet agent mapped what OpsCrew already has, with file and line.

"Unconfirmed" marks a fact no fetched official page stated. Sections R1–R4 are findings; R5 holds
the lead's decisions, which the spec builds on. The plan phase adds its own sections below.

## R1. How other tools roll back

**Kamal.** Source: https://kamal-deploy.org/docs/commands/rollback/
- `kamal rollback <version>` stops the current container and starts one from the target version's
  image: "Nothing needs to be downloaded from the registry". No rebuild.
- The versions are the old containers still on the hosts (`kamal app containers -q`). "By default,
  old containers are pruned after 3 days when you run `kamal deploy`."
- Unconfirmed: what the next deploy does after a rollback.

**Vercel.** Source: https://vercel.com/docs/instant-rollback
- Instant Rollback points the production domains back at an earlier production deployment, with
  no rebuild. Environment variables changed since then are not applied.
- Pro plans can choose any earlier production deployment; Hobby only the one before.
- "After a rollback, Vercel turns off auto-assignment of production domains. This means new
  pushes to your production branch won't replace the rolled-back deployment." "Undo Rollback"
  (or `vercel promote`) turns it back on.

**Heroku.** Source: https://devcenter.heroku.com/articles/releases
- `heroku rollback [vN]` makes a new release that "copies the compiled slug or OCI image and config
  vars" of the target. No rebuild.
- Artifacts of releases older than 30 days and outside the latest 20 are destroyed, and can't be
  rolled back to.
- Add-ons are not reverted: "It's your responsibility to reconcile these resources after rolling
  back." Heroku calls a rollback "a temporary fix" and prefers `git revert` and a new deploy.

**Render.** Source: https://render.com/docs/rollbacks
- A rollback is a new deploy "using the target deploy's build artifact", with no rebuild. Only a
  fixed number of recent artifacts is kept; the number is unconfirmed.
- A rollback from the dashboard turns autodeploy off, and the user turns it on again after the fix.
  A rollback through the API does not, which is a trap.
- "A tag may resolve to a newer image… a digest always points to the same image." A rollback to an
  image that is gone fails.

**Fly.io.** Source: https://docs.fly.io/flyctl/deploy
- `fly deploy --image` deploys a prebuilt image. Unconfirmed: a rollback command, its retention,
  and what auto-deploy does after it.

**Data.** No tool reverts the database. Heroku and Cloudflare say so outright, Vercel reminds the
user of databases in its dialog, and Render says disks "cannot be rolled back".

## R2. The targets' own version history

**Cloudflare Workers.** Sources:
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/

What they say:
- A rollback can go to any of "the 100 most recently published versions". `wrangler rollback`
  makes a new deployment of the chosen version at 100% of traffic.
- A version holds code, static assets, bindings and compatibility settings; KV, R2, D1 and Durable
  Object data are not versioned.
- Cloudflare blocks a rollback across a Durable Object migration, or to a version bound to an R2
  bucket, KV namespace or queue that no longer exists.
- OpsCrew already uses this: `promote --version` on a Worker (`agents/src/promote/site.ts`,
  `rollBackWorker`) deploys an earlier version at 100%. It asks for `--allow-old-secrets` when
  secrets changed since that version.

**GitHub Pages** (`actions/deploy-pages`). Sources: https://github.com/actions/deploy-pages and the
Actions artifact docs.
- The documentation shows no way to deploy an earlier site artifact again without a build.
  Artifacts are kept for the repository's retention, which the user can shorten; the default
  number of days is unconfirmed on the fetched pages.
- OpsCrew's `promote --version` on Pages (`site.ts`, `rollBackPages`) re-runs that version's
  workflow run. That builds the site again from the run's commit.

**GitHub Actions re-runs.** Source:
https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs
- "Workflow runs can be re-run for up to 30 days." A re-run uses the original `GITHUB_SHA` and
  `GITHUB_REF`, so it rebuilds that commit; a base image or a dependency may have changed since.

**GitHub Container Registry.** Sources:
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package

What they say:
- No automatic deletion is documented, only deletion by the owner. That is an absence, not a
  promise.
- An image can be pulled by its digest.
- A deleted version can be restored for 30 days.

## R3. What OpsCrew has to build on (code map, 2026-10-31)

**Images.**
- The deploy workflow pushes `<name>:<commit SHA>` for prod and `<commit>-<env>` for other
  environments (`iac-templates/src/workflow/build.ts`, `environmentTag`).
- The `record` step outputs the digest reference `name@sha256:…`, and every deploy uses that
  reference. There is no `latest` tag.
- After a healthy deploy, `labelJob` (`workflow/jobs.ts`) tags the digest `opscrew-<env>`, and
  tags the image it replaced `opscrew-<env>-previous`. Both are overwritten by the next deploy.
- Retention (`workflow/retention.ts`, on by default with `keep: 10`, `plan-schema/src/plan.ts`)
  deletes older commit-tagged images of the environment. It never deletes the running or previous
  image, an image any environment's label names, or the user's own tags.
- Nothing on the server prunes images.

**The server's record.**
- `/srv/apps/<app>/.env` holds one line, `APP_IMAGE=<digest reference>` (`workflow/switch.ts`).
- Each deploy first copies it to `.env.previous`, and the processes to `.processes.previous`
  (`workflow/index.ts`, `SAVE_PREVIOUS`).
- The automatic switch back (`rollbackCommands`, `switch.ts`) reads `.env.previous`, switches the
  app and restores the workers that ran before. It never runs the release command.
- This computer (`agents/src/localhost/apply.ts`) does the same with local images
  (`opscrew-local/*`), which are not in the registry.

**promote** (`agents/src/promote/**`):
- **The image.** It deploys an existing image by digest, with no build: `chooseImage`, then
  `checkProvenance` (built by a push to the builder branch of this repository) and `checkPlatform`.
- **Readiness.** The target must be provisioned with nothing pending, and its services must still
  exist (`requireReady`, `requireRollbackServices`).
- **The approval.** It is of kind `promote`, bound to `promotionHash`. `--yes` never grants it;
  scripts give `--approve <hash>`.
- **The run.** It dispatches the workflow with `digest` and `tag` inputs and follows the run.
  The workflow's `verify` job checks provenance again (and the cosign signature when signing is
  on). It records the result in `promotion.json`, with the one before.
- **Its limits:**
  - `--digest` accepts only the source's image or the target's `opscrew-<env>-previous`.
  - It refuses an environment that deploys from a branch (`promote/run.ts`), which is the default
    prod. That environment's workflow has `workflow_dispatch` with no inputs, and a build job
    instead of `verify` (`workflow/shared.ts`).
  - A promoted deploy runs the release command of the image it deploys
    (`switchCommands`, `switch.ts`). For a rollback, that would run the old version's migrations
    against the newer schema.

**Portainer.**
- The deploy commits `compose.yaml` with the digest image onto an orphan deploy branch, one commit
  per version (`workflow/portainer.ts`), so the branch holds the whole history.
- Its failure rollback commits the previous tree on top.

**History and status.**
- `plan.yaml`'s `deployment` holds no list of versions.
- Branch-following environments keep no record of their versions on this computer.
- `opscrew status` shows containers and their state on servers, but not the running image or
  version. Only sites show versions (`status/site.ts`).

**Runners.**
- A deploy with no build still needs the registry: GitHub-hosted, the server's own runner or this
  computer's.
- The `verify` job runs on GitHub-hosted `ubuntu-latest`.
- With public SSH closed, only the server's or this computer's runner reaches the servers.

**Split placement (018).**
- The app's image runs only on the app's server, which is where the switch and the switch back
  happen. Services on other servers run pinned catalogue images and are not part of an app
  rollback.
- A paused move (`OPSCREW_DEPLOY_PAUSED`) skips deploys.

## R4. Gaps found while writing the failed-deploy guide

1. **A failed copy's logs are lost.** `docker rm -f "$new"` in `switchApp` (`switch.ts`) removes
   the copy that failed its health check together with its logs.
2. **The worker hint shows the wrong lines.** When a worker fails, the hint (`processFailed`,
   `switch.ts`) says to run `docker compose logs <service>`. After the switch back has restarted
   the old version's workers, that shows the old version's lines.
3. **Half-applied migrations get no advice.** A failed release command points to `release.log`
   (`releaseFailed`, `switch.ts`), but nothing says what to do about a migration that stopped
   halfway.

## R5. Lead decisions for the spec

1. **Redeploy an image by its digest, never rebuild,** through the path `promote` already has:
   dispatch with a digest, provenance and platform checks, the `verify` job, and an approval bound
   to a hash.
   - Every server environment's workflow, branch-following too, accepts a rollback dispatch:
     inputs `digest` and `rollback`, no build.
   - Sites keep their own history: Workers through versions, Pages by re-running the run, which
     rebuilds and is labelled as such.
2. **The versions offered** are this environment's images still in the registry, newest first:
   its commit-tagged versions within retention, each with commit, message and time. The default is
   the one before the current (`opscrew-<env>-previous`).
   - Only an image whose provenance checks out is offered.
   - An image that is gone stops with a plain message that names the oldest version still there.
3. **A rollback never runs a release command.** The switch is the same as a deploy otherwise:
   health check, check from outside, and the automatic switch back on failure.
   - It says before it switches that the data and schema stay as they are, and that the earlier
     version must work with them.
4. **After a rollback, deploys of that environment pause,** as on Vercel and Render, so the next
   push doesn't silently undo it. `status` shows the pause, and one command resumes deploys.
   - The pause reuses the job-level `if:` on a repository variable that 018 built for moves.
     GitHub reads it when the run is created (018's live run); the rollback also waits until no
     deploy of the environment runs.
5. **This computer:** goes back to the previous local image (`.env.previous`), when that image is
   still there.
6. **Recovery gaps (R4):**
   - keep a failed copy's last log lines on the server where `opscrew logs` shows them;
   - point the worker hint at those lines;
   - make the release command's failure message say what to do about a migration that stopped
     halfway.
7. **`status` shows the running version** on servers: commit, short digest and time.

## R6. Spikes (T1901, 2026-10-31)

On the private throwaway repository, then local Docker. Everything created was removed afterwards.

### S3. The job graph on real runs

A workflow with plan.md 1.'s jobs, the three inputs, `on: push`, and the pause `contains(vars.SPIKE_DEPLOY_PAUSED, '"app/prod"')`. It added `sign` (`needs: build`), `prune` (`needs: [build, deploy]`, no `if:`) and a job printing each expression.

| Case | paused | build, sign | verify | deploy | prune | label |
|---|---|---|---|---|---|---|
| 1. push | skip | ran | skip | ran (build's image) | **skip** | ran |
| 2. push, paused | ran | ran | skip | skip | skip | skip |
| 3. dispatch `rollback=true` + digest | skip | skip | ran | ran (verify's image) | skip | ran |
| 4. dispatch, no inputs | skip | ran | skip | ran | **skip** | ran |
| 5. as 3., paused | skip | skip | ran | ran | skip | ran |

Nothing was cancelled, and every run concluded `success`.

**What the expressions saw:**
- **On a push:** `inputs` is `{}`, so `!inputs.rollback` is true. No fallback is needed.
- **A boolean from the API:** `gh workflow run -f rollback=true`, REST `"true"` and REST JSON `true` all gave `inputs.rollback` the boolean `true`, and `github.event.inputs.rollback` the string `"true"`. Without inputs: `false` and `"false"`.
  - So `inputs.rollback == 'true'` is false on a rollback.
  - `!github.event.inputs.rollback` is false on every dispatch.
- **One need skipped:** `deploy`'s condition worked with either need skipped.

**Finding:** the implicit `success()` skips a job when any job upstream was skipped, even indirectly. `prune` was skipped on every push, because `deploy` needs `verify`. With `${{ !cancelled() && needs.build.result == 'success' && needs.deploy.result == 'success' }}` it ran in cases 1 and 4 only.

**Working `if:` texts:**
- **paused:** `${{ !inputs.rollback && contains(vars.X, '"app/prod"') }}`
- **build:** `${{ !inputs.rollback }}`
- **verify:** `${{ inputs.rollback }}`
- **deploy:** `${{ !cancelled() && (needs.build.result == 'success' || needs.verify.result == 'success') && (inputs.rollback || !contains(vars.X, '"app/prod"')) }}`
- **label:** `${{ !cancelled() && needs.deploy.result == 'success' }}`

The image output `needs.build.outputs.image || needs.verify.outputs.image` was right, and so was the mode `inputs.rollback && 'rollback' || 'deploy'`.

### S1. A dispatch on a branch that isn't the default

- **S3's workflow,** only on its branch, after its first push run: a dispatch with `--ref` got 204 and ran.
- **A dispatch-only file** on a second branch, never run: `HTTP 404: Not Found (https://api.github.com/repos/<owner>/<repo>/actions/workflows/spike-019-s1.yml)`. The REST dispatch got 404 too.
- **The same with a push trigger** whose branch filter didn't match: also 404. GitHub knows a workflow once it has run on that branch, or once its file is on the default branch.
- **The file on both branches:** one commit on `main`, reverted by a second. The dispatch got 204 and used the branch's version of the file.
- **After the revert:** a dispatch on the branch still worked.

### S2. GHCR's tag list

`GITHUB_TOKEN` (`packages: write`) pushed three private versions, `spike-1` to `spike-3`.

**The pull token** came back 200 for every token; anonymous got 401.

**`tags/list`:**
- **Classic `read:packages` token:** 200.
- **Fine-grained token,** and **`gh auth token`** (`repo`, `workflow`, no `read:packages`): 403 `DENIED`, "The token provided does not match expected scopes."
- **`GITHUB_TOKEN`:** 200.

**Paging:**
- `?n=1` gave one tag and `Link: </v2/<owner>/<repo>/spike-019/tags/list?last=spike-1&n=1>; rel="next"`, a relative path.
- The last page had no `Link`. Without `n`, all came back with no `Link`.
- The order was lexical.
- A deleted package gave 404 `NAME_UNKNOWN`.

**The Packages REST API** (`…/versions`) answered the same way: 200 for the classic token (9 versions, since each push added two untagged manifests) and `GITHUB_TOKEN`, 403 for the other two.

### S4. Re-runs

The first run had `vars.SPIKE_S4` = `A`. It was then set to `B`, and the run re-run with `gh run rerun`.
- **Attempt 2** printed `B`, and the jobs gated on `${{ github.run_attempt > 1 }}` and `${{ vars.SPIKE_S4 == 'B' }}` ran.
- **`${{ github.run_attempt > 1 || vars.SPIKE_S4 != 'B' }}`** ran on both.

A re-run reads `vars` again, so a paused environment blocks re-runs. The Pages exemption is needed, and it works.

### S5. Compose's `release` service

Docker 29.9.2, Compose 5.6.1:
- **Nothing changed:** `up -d` restarted the exited `release`, which printed `ran` again.
- **Only its environment changed:** `release` was recreated and ran. `app` was untouched.
- **The wrapper with `skip`:** `release` exited 0 silently, and `app` started after it.
- **Back to `run`,** with `app` changed: `release` ran, then `app` started.

### Corrections for plan.md

1. **1.:** `tag` and `prune` need the `if:` from S3's finding, or they skip on every push. The same holds for any job that needs `deploy` without its own `if:`.
2. **Technical Context:** drop the `github.event.inputs` fallback. Never compare `inputs.rollback` with `'true'`.
3. **3.:**
   - Only a classic `read:packages` token reads the tag list from this computer. "Else the user's token" usually gets 403, so the hint should name `OPSCREW_GHCR_READ_TOKEN`.
   - Paging follows the relative `Link`.
4. **10., S1:** an environment with a version to roll back to has already run its workflow on its branch, so the dispatch works. A 404 means it never ran there, and "push to <branch> once" is the fix, not a merge into the default branch.
5. **5., Portainer:**
   - The switch works.
   - Every `up -d` restarts `release`, with the value written in the stack file, even when nothing changed. That predates 019.

## R7. Logins for Kafka, Redpanda and OpenSearch (2026-11-01)

The founder added these logins to 019 on 2026-11-01 ([roadmap](../roadmap.md)). A Sonnet agent
read 14 official pages for the pinned versions: Kafka 4.3.1 (`apache/kafka`), Redpanda v26.2.5 and
OpenSearch 3.9.0. It also mapped the code. "Unconfirmed" marks a fact no fetched page stated.

### Kafka

Sources:
- [SASL authentication](https://kafka.apache.org/43/security/authentication-using-sasl/)
- [the Docker image](https://raw.githubusercontent.com/apache/kafka/trunk/docs/getting-started/docker.md)
- its [`launch`](https://raw.githubusercontent.com/apache/kafka/4.3/docker/jvm/launch) script
- its [`configure`](https://raw.githubusercontent.com/apache/kafka/4.3/docker/resources/common-scripts/configure) script

**Where users live**
- In KRaft, SCRAM credentials are stored in the metadata log.
- `kafka-storage.sh format --add-scram 'SCRAM-SHA-256=[name=…,password=…]'` creates users at format time.
- `kafka-configs.sh --bootstrap-server … --alter --add-config 'SCRAM-SHA-512=[password=…]' --entity-type users --entity-name …` creates or updates them later.
- Credentials for inter-broker traffic must exist before the broker starts.

**Settings**
- Broker: `listeners=SASL_PLAINTEXT://…`, `sasl.enabled.mechanisms`, and, for inter-broker logins, `listener.name.<listener>.<mechanism>.sasl.jaas.config` with `ScramLoginModule`.
- Client: `security.protocol`, `sasl.mechanism`, `sasl.jaas.config`.

**The image**
- Environment variables map to properties: `.` becomes `_`, `_` becomes `__`, `-` becomes `___`, and the name gets the prefix `KAFKA_`.
- Its start script formats storage itself, with no way to add `--add-scram`. It carries on when storage is already formatted.

**Today** (`catalog/entries.ts`)
- Listeners: `PLAINTEXT://:9092` and `CONTROLLER://localhost:9093`.
- The health check is `kafka-broker-api-versions.sh` against `localhost:9092`, with no login.
- `auth: "internal-only"`, `secrets: []`.

### Redpanda

Sources:
- [authentication](https://docs.redpanda.com/current/manage/security/authentication/)
- [production deployment](https://docs.redpanda.com/current/deploy/deployment-option/self-hosted/manual/production/production-deployment/)
- [cluster properties](https://docs.redpanda.com/current/reference/properties/cluster-properties/)

**The order**
- Enabling authorization without a superuser can lock you out. The documented order: set `superusers`, create a SCRAM user, then enable SASL, then ACLs.

**Ways to create the first user**
- `RP_BOOTSTRAP_USER=user:password[:mechanism]` creates one user on the first start only.
- `.bootstrap.yaml` next to `redpanda.yaml` is read on the first start only. Whether it takes `enable_sasl` is unconfirmed.

**Turning SASL on**
- `enable_sasl: true` is a cluster property. It needs no restart and turns authorization on too.
- The alternative is per-listener `authentication_method: sasl` plus `kafka_enable_authorization`, with a restart. Use one of the two, never both.
- Superusers skip ACLs.

**Unconfirmed**
- Whether the admin API (port 9644, used by the health check and by `rpk`) stays open while `admin_api_require_auth` is off.

**Today**
- `redpanda start … --kafka-addr 0.0.0.0:9092`, no environment, `secrets: []`.

### OpenSearch

Sources:
- [TLS](https://docs.opensearch.org/latest/security/configuration/tls/)
- [generating certificates](https://docs.opensearch.org/latest/security/configuration/generate-certificates/)
- [securityadmin](https://docs.opensearch.org/latest/security/configuration/security-admin/)
- [Docker](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/)

**TLS**
- "TLS is optional for the REST layer and mandatory for the transport layer." `plugins.security.ssl.http.enabled` defaults to `false`.
- The transport needs `pemcert_filepath`, `pemkey_filepath` (a PKCS#8 key) and `pemtrustedcas_filepath`, under the `config` folder.

**Certificate names**
- `plugins.security.nodes_dn` lists the node certificates.
- `plugins.security.authcz.admin_dn` lists the admin certificates. A node certificate can't be one.
- The guide turns off `enforce_hostname_verification`.
- It generates a CA, a node and an admin certificate with `openssl genrsa`, `pkcs8 -topk8 -nocrypt`, `req` and `x509 -req`.

**The admin user and the security index**
- Since 2.12 the demo setup needs `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, which must pass a strength check.
- The demo setup installs public certificates and default users, so it is never used.
- `securityadmin.sh` writes the security index from `config/opensearch-security/`. Its page lists HTTP TLS as a prerequisite.

**Unconfirmed**
- Whether 3.9.0 starts with security on, HTTP TLS off, its own certificates and no demo setup.
- How the admin password gets in: `internal_users.yml` with a bcrypt hash from the plugin's `tools/hash.sh`, plus `allow_default_init_securityindex`.

**Clients**
- opensearch-js takes the login in the URL (`http://user:password@host:9200`).
- opensearch-py and the Elasticsearch clients: unconfirmed.

**Today**
- `DISABLE_SECURITY_PLUGIN=true`, `DISABLE_INSTALL_DEMO_CONFIG=true`, the variable `OPENSEARCH_URL` (detection also reads `OPENSEARCH_NODE`).
- The `ELASTICSEARCH` entry is the model to follow: its `PASSWORD` secret is in the URL as `http://elastic:<password>@host:9200`.

### Apps

- No environment-variable convention exists for Kafka logins (kafkajs, librdkafka, sarama, franz-go).
- Spring Boot binds `spring.kafka.properties[…]`. Whether `SPRING_KAFKA_PROPERTIES_SASL_MECHANISM` reaches the dotted key is unconfirmed.
- `packages/detect` reads manifests and variable names, not source, so it can't see a client's SASL settings today.

### What the code assumes (code map)

`auth: "internal-only"` is fixed per kind, and these places read it:
- the design line `noLoginLine` (`design/placement.ts`);
- the device-grant refusal (`vpn/grants.ts`, `plan-schema/src/placement.ts`);
- `design/plan.ts`, whether a variable is secret;
- the network runbook;
- the login checks in `secure/services.ts` and `secure/portainer.ts`;
- `secops/src/hardening/services.ts`;
- the guide pages `split-placement.md` and `search-and-analytics.md`.

Other limits:
- A service's generated values reach the server only as its `<name>.env` (a GitHub secret per service with secrets, `provision/secrets.ts`).
- Config files are mounted from the runtime folder and hold no secrets.
- `GeneratedSecret.format` is `hex32` or `garage-key-id`.

### The lead's first reading, for the spike to confirm

**Kafka and Redpanda: opt-in per service**
- An app's client sends a login only when its code is configured to, so turning it on is the user's choice.
- When on, the app gets these variables (OpsCrew's names; no standard exists):
  - `KAFKA_SASL_MECHANISM` (`SCRAM-SHA-512`)
  - `KAFKA_SASL_USERNAME`
  - `KAFKA_SASL_PASSWORD`
  - `KAFKA_SECURITY_PROTOCOL` (`SASL_PLAINTEXT`)

**Users made after the start, so an existing broker can turn it on too**
- Kafka keeps a PLAINTEXT listener on loopback for its own traffic and the health check. Only the clients' listener asks for SASL, and the user is added through the loopback listener with `kafka-configs.sh`. That needs no format-time trick and no inter-broker login.
- Redpanda gets its user, `superusers` and `enable_sasl` through `rpk` on the admin API, in that order. The admin API isn't published.

**OpenSearch: default on**
- The security plugin runs with HTTP TLS off, and the login is in `OPENSEARCH_URL`, as Elasticsearch's is.
- An app that reads that variable needs no change.
- Certificates are made on the server for the traffic between nodes and never leave it.
- Turning the plugin on for an engine that already holds data must keep its indexes.

## R8. Logins: the spike with real containers (2026-11-01)

An Opus agent ran the pinned images locally: `apache/kafka` 4.3.1, Redpanda v26.2.5 and OpenSearch 3.9.0. It also ran opensearch-js 3.9.0 and opensearch-py 3.2.0. R7's reading holds, with the corrections below. Every setup below was run on a new volume, on a volume with today's data, and again after a restart.

### Kafka

**Listeners and settings**
- The clients' listener can't be called `SASL_PLAINTEXT`. The image's `configure` script then demands `KAFKA_OPTS` and exits under `nounset`. So it is named `CLIENT` and mapped to `SASL_PLAINTEXT`.
- The broker needs a JAAS entry for that listener, even for SCRAM: `KAFKA_LISTENER_NAME_CLIENT_SCRAM___SHA___512_SASL_JAAS_CONFIG=org.apache.kafka.common.security.scram.ScramLoginModule required;`. No file is needed.
- `KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512` is required; the default, GSSAPI, fails.
- The loopback listener `PLAINTEXT://localhost:9094` must be advertised. Inter-broker traffic uses it by default, through the listener named `PLAINTEXT`.
- `/proc/net/tcp6` shows 9093 and 9094 on 127.0.0.1 only.

**The user**
- `kafka-configs.sh --bootstrap-server localhost:9094 --alter --add-config "SCRAM-SHA-512=[password=…]" --entity-type users --entity-name app` creates the user. It takes about 4 s.
- Re-running it is harmless.
- A new password replaces the old one at once.
- The user survives a restart.
- The password variable must not start with `KAFKA_`, or the image turns it into a server property. `SASL_PASSWORD` works.
- Hex passwords are safe inside `[password=…]`.
- Whatever writes the password must strip CR and newline. On Windows, `openssl` added a CR that ended up in the stored password.

**Results**
- A client with no login gets no clear error, only a timeout (`Timed out waiting for a node assignment`). The guide must say so.
- A wrong password gets a clear `SaslAuthenticationException`.
- With the login, it produced and consumed.
- Existing data is kept, and going back to today's settings on the same volume works.

### Redpanda

**Turning the login on**
- Start without SASL, then run through `rpk` on the admin API:
  1. `rpk security user create app -p … --mechanism SCRAM-SHA-512`;
  2. `rpk cluster config set superusers '["app"]'`;
  3. `rpk cluster config set enable_sasl true`.
- These need no restart. They work on a new cluster and on one with data.
- `create` fails when the user exists. `update` needs `--new-password` and fails when the user doesn't exist, so the step is `create || update`.

**The admin API is open to every container on the network** (the image binds it to `0.0.0.0:9644`).
- `rpk cluster config set admin_api_require_auth true`, run as the superuser, closes it:
  - users and config return 403;
  - `/v1/status/ready` still answers without a login, so the health check is unchanged;
  - `rpk` then logs in with `RPK_USER`, `RPK_PASS` and `RPK_SASL_MECHANISM` from the container's environment.
- After that, changing the password needs the old one as the admin login.

**Other open ports**
- Schema Registry (8081) kept accepting writes without a login after `enable_sasl`.
- RPC (33145) listens on every interface.
- `--rpc-addr 127.0.0.1:33145 --schema-registry-addr 127.0.0.1:8081 --pandaproxy-addr 127.0.0.1:8082` closes them. Only 9092 and 9644 are then reachable.

**Memory:** 279 MiB, unchanged.

**Not needed:** `RP_BOOTSTRAP_USER` and `.bootstrap.yaml`. They act only on a cluster's first start.

### OpenSearch

**Certificates**
- The transport layer needs TLS even on one node: "No SSL configuration found".
- The image has no `openssl`, but it has the JDK's `keytool`.
- One self-signed key and certificate, which also trusts itself, is enough. It needs no CA, no admin certificate, no `nodes_dn` and no hostname setting. It takes about 2 s:

  ```
  k="keytool -keystore config/node.p12 -storepass changeit"
  $k -genkeypair -alias node -keyalg RSA -keysize 2048 -dname CN=opensearch -validity 36500
  $k -exportcert -alias node -rfc | $k -importcert -noprompt -alias trusted
  ```

- With `plugins.security.ssl.transport.keystore_filepath` and `truststore_filepath` set to `node.p12`, `changeit` needs no setting.

**The admin user**
- `plugins.security.allow_default_init_securityindex=true` creates the security index from `config/opensearch-security/` on the first start, so no admin certificate is needed.
- `OPENSEARCH_INITIAL_ADMIN_PASSWORD` is used only by the demo installer. With the demo setup off, the image's own `internal_users.yml` lets in `admin:admin`, so OpsCrew always replaces that file.
- `plugins/opensearch-security/tools/hash.sh -env OPENSEARCH_PASSWORD` prints a bcrypt hash in about 1.5 s. The file then holds only `admin`, with that hash, `reserved: false` and `backend_roles: ["admin"]`.
- The file is read only when the index is first created. A later change goes through `PUT _plugins/_security/api/account`, which `reserved: false` allows.

**Results**
- No login and a wrong password both get 401.
- `http://admin:<password>@host:9200` gets 200.
- The health check `curl -fsS -u "admin:$OPENSEARCH_PASSWORD" 'localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s'` passes.
- Memory is the same with security on and off: about 955 MiB of 1 GiB.
- Time to healthy is 49 s on the first start with security and 44 s on a restart. Both fit the 90 s start period.
- Existing data is kept, and turning security off again works.
- opensearch-js 3.9.0 and opensearch-py 3.2.0 both take the login inside the URL.

**Not yet tested:** recreating the container (a new self-signed certificate) after the security index exists.

### A login without a window

- Adding the login with `docker exec` after the health check passes leaves a gap, in which an app that starts can't log in.
- Instead, the container adds its own login: a background loop retries until the login exists, then the image's normal start runs. The health check passes only once the login exists.
- This needs no deploy step, runs again harmlessly at every start, and works on brokers that already hold data.

**Kafka's command and check**
- Command:

  ```
  (until kafka-configs.sh --bootstrap-server localhost:9094 --alter --add-config "SCRAM-SHA-512=[password=$SASL_PASSWORD]" --entity-type users --entity-name app; do sleep 2; done) & exec /etc/kafka/docker/run
  ```

- Health check: `kafka-configs.sh --describe` for user `app` shows `SCRAM-SHA-512`.
- Healthy in 10 s. Java stays PID 1.

**Redpanda's command and check**
- Command: `sh -c` with a `login()` function that runs `create || update`, then `superusers`, `enable_sasl` and `admin_api_require_auth`, retried in the background, then `exec /entrypoint.sh redpanda start …`.
- Health check: `ready`, and `admin_api_require_auth` is `true`.
- Healthy in 9 s.

**OpenSearch's command**
- Command: `bash -c`, which makes the keystore if it is missing, writes `internal_users.yml` from `hash.sh`, then runs `exec ./opensearch-docker-entrypoint.sh opensearch`.
- The login exists before port 9200 opens.
- The certificate and the hash stay inside the container.

## R9. Rolling back the database (2026-11-06, the follow-up)

The founder asked on 2026-11-06 for a rollback that undoes the database too, in the same release
as 023. A snapshot before every release is the default, on for every environment except prod.
Down migrations are a choice the user is offered where the app's tool has them. Three Sonnet
agents read only official documentation (each tool's docs or repository; postgresql.org,
dev.mysql.com, mariadb.com, mongodb.com; kamal-proxy's source) and the code. "Unverified" marks a
fact no fetched official page stated; T1933's and T1935's Docker tests check each one against real containers.

### What the code has (code map)

- **Pins** (`iac-templates/src/pins.ts`): `postgres:17-alpine`, `mysql:8.4`, `mariadb:12.3`,
  `mongo:8.0`, `basecamp/kamal-proxy:v0.10.2`.
- **Logins** (`iac-templates/src/catalog/entries.ts`):
  - PostgreSQL: `POSTGRES_USER=app`, database `app`; the initdb user is a superuser.
  - MySQL and MariaDB: database and user `app`, granted `app.*` only; root has its own generated
    password (`MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD`).
  - MongoDB: root user `app` in `admin`, database `app`, standalone by default (an optional
    one-member replica set `rs0`).
  - Each service's env file holds its own passwords, and the services are reached by their Compose
    service name.
- **023's PostgreSQL copy** (`agents/src/retarget/sides/postgres.ts`):
  - `pg_dump -Fc` of the live database;
  - `DROP DATABASE IF EXISTS app WITH (FORCE)` and `CREATE DATABASE app OWNER app`, run from
    database `postgres`;
  - `pg_restore --no-owner --single-transaction`;
  - the password only in a `.pgpass` file. It runs through the Docker API, not the start script.
- **The start script** (`iac-templates/src/workflow/switch.ts` `switchCommands`):
  - `MODE` is `deploy` or `rollback`;
  - the release command runs in a one-off of the new image before the switch, skipped in
    `rollback`;
  - the `recreate` path holds requests with `kamal-proxy pause <app> --drain-timeout <n>s
    --max-pause 90s` and resumes them, with an EXIT trap, since a pause survives kamal-proxy's
    restarts. 90 s stays under Cloudflare's 100 s.
- **Portainer** runs the release command as the stack's one-off `release` service
  (`OPSCREW_RELEASE` `run` or `skip`). OpsCrew has no shell there, and the rollback commits the
  earlier tree.

### Dump and restore per database

| Database | Dump, while the app writes | Consistent? | Exact restore |
|---|---|---|---|
| PostgreSQL 17 | `pg_dump -Fc` | Yes: "consistent backups even if the database is being used concurrently" | Drop with `FORCE` and create, then `pg_restore --no-owner --single-transaction`. `--clean --if-exists` drops only the objects in the dump, so tables a newer migration added would stay |
| MySQL 8.4 | `mysqldump --single-transaction --routines --events --triggers --no-tablespaces app` (the pinned image carries `mysqldump` 8.4.13, checked 2026-11-06) | InnoDB only. Concurrent DDL can break it (unverified) | `DROP DATABASE`, `CREATE DATABASE`, load. The password via `MYSQL_PWD` or a defaults file, never the command line |
| MariaDB 12.3 | `mariadb-dump`, with the same flags. `mysqldump` is "removed from the mariadb Docker Official Image" (the pinned image has only `mariadb-dump`, checked 2026-11-06) | InnoDB only | As MySQL, with the `mariadb` client |
| MongoDB 8.0 | `mongodump --db=app --archive --gzip` | Standalone: "will not reflect a single moment in time"; `--oplog` needs a replica set and a whole-instance dump | Drop the database first, then `mongorestore --nsInclude='app.*'`. `--drop` keeps collections that aren't in the dump. The pinned `mongo:8.0` carries `mongodump` and `mongorestore` (checked 2026-11-06) |

The app's own files (a SQLite database, uploads) have no safe copy while the app writes: the copy
needs SQLite's backup API, and no pinned image carries the `sqlite3` tool. kamal-proxy's `pause`
holds new requests and answers 504 once `--max-pause` runs out; `stop` answers 503 at once.

### Down migrations per tool

Every tool below runs inside the app's image already: OpsCrew's release command uses it. The down
step must run in the newer image, the only one that holds the newer migrations and their down
steps.

| Tool | Records | Read with | Goes down with |
|---|---|---|---|
| Rails | the version (one per database since T1942) | `bin/rails db:version` ("Current version: …"); since T1942 a `bin/rails runner` one-liner naming each database.yml entry | `bin/rails db:migrate VERSION=<v>` (v stays applied) |
| Django | the last applied migration of each app | `python manage.py showmigrations --plan` (`[X]` lines, in order) | `python manage.py migrate <app> <name> --noinput` for each app, `zero` for one with none |
| Alembic | the revision | `alembic current` | `alembic downgrade <rev>` (`base` for none) |
| Flask-Migrate | the revision | `flask db current` | `flask db downgrade <rev>` |
| Knex | the count of applied migrations | `knex migrate:list` ("Found N Completed Migration file/files.") | `knex migrate:down`, once per migration (it undoes the newest) |
| Sequelize | the count | `sequelize-cli db:migrate:status` (`up` lines; unverified) | `sequelize-cli db:migrate:undo`, once per migration |
| TypeORM | the count | `typeorm migration:show -d <source>` (`[X]` lines; unverified) | `typeorm migration:revert -d <source>`, once per migration |
| Laravel | the count | `php artisan migrate:status` (`Ran` rows) | `php artisan migrate:rollback --step=<n> --force` |

Failures:
- An irreversible migration raises when the tool reaches it: Rails `IrreversibleMigration`, a
  Django `RunPython` without a reverse, an Alembic `downgrade()` left empty or raising. The later
  ones are undone already by then, so the run stops partway.
- On PostgreSQL each step runs in its own transaction. MySQL's DDL commits on its own.

Not offered in this release:
- **No down migrations:** Prisma Migrate (its documented route is a hand-made SQL file),
  Drizzle Kit, Medusa (per module).
- **No command that prints the current state:** Payload, AdonisJS (both batch-based).
- **Their CLI or a second database isn't in the image:** EF Core (`dotnet ef` needs the SDK),
  Diesel, SQLx, SeaORM (`cargo run`), Atlas (a dev database).
- **Not verified against a real container yet:** goose, golang-migrate, Doctrine, Sequel, Ecto,
  MikroORM, Kysely, node-pg-migrate, db-migrate, Hanami, Masonite, Aerich, Tortoise, Piccolo,
  Yoyo, Flask-DB. Each can join later as one row of the table.
- **Several heads** (T1935's review, T1943): Alembic with several heads prints several revisions.
  The deploy records nothing for such a version, with a warning that says why, so its rollback
  doesn't offer down migrations; since T1943 such a project deploys with `alembic upgrade heads`.
- **Several Rails databases, supported since T1942** (founder, 2026-11-06): `db:version` prints
  each database's own name (`shop_production_queue`) while `db:migrate:<name>` takes the
  `config/database.yml` entry's (`queue`). So the detected status is
  `bin/rails runner "ActiveRecord::Base.configurations.configs_for(env_name: Rails.env).each { |c| ActiveRecord::Base.establish_connection(c); puts 'database: ' + c.name, 'Current version: ' + ActiveRecord::Base.connection_pool.with_connection { |x| x.schema_version }.to_s }"`,
  public API since Rails 6.1 (the internal pool helpers exist only from 7.2), checked on Rails 7.1.6
  and 8.1.0. Several databases record
  `database=<entry> <v>` lines and go down with `db:migrate:<entry> VERSION=<v>`, checked on Rails
  8.1.0 with PostgreSQL entries `primary` and `queue`.

### The real outputs (T1935's Docker test, 2026-11-06)

Seen through `docker compose run -T` (no terminal). Every tool matched the table above; none needed
a parsing change.

| Tool | Status output |
|---|---|
| Rails 8.1.0 | `database: <name>`, then `Current version: <v>` (`0` before any migration), one pair per database; needs `SECRET_KEY_BASE` in production |
| Django 6.1.2 | `[X]  <app>.<name>` applied, `[ ]  <app>.<name>` pending, in plan order |
| Alembic 1.20.0 | `<rev> (head)`, nothing before any migration; its logs on stderr |
| Flask-Migrate 4.1.0 | as Alembic; Flask's ".env files" tip on stderr |
| Knex 3.3.0 | `Found N Completed Migration file/files.` and the names, or `No Completed Migration files Found.`; pending files after |
| sequelize-cli 6.6.3 | a `Sequelize CLI [...]` header, config and environment lines, then `up <file>` / `down <file>` |
| TypeORM 1.1.2 | `[X] <id> <name>` applied, `[ ] <name>` pending; exits 0 with pending migrations |
| Laravel 13 (PHP 8.5) | a `Migration name … Batch / Status` heading, then `… [<batch>] Ran` or `… Pending` rows; before any migration `ERROR  Migration table not found.` and exit 1 |
