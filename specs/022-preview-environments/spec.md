# Feature Specification: Preview environments per pull request

**Feature Branch**: `main` (feature directory `specs/022-preview-environments`)
**Created**: 2026-11-05
**Status**: Draft
**Input**: The roadmap's "022 Preview environments per pull request" (founder, 2026-10-23).
- A short-lived environment per pull request: created when it opens, updated on each push,
  destroyed on close or merge, at `pr-<n>.<domain>`.
- Previews run as extra apps on one shared, small preview server; each has its own empty or seeded
  databases (never prod's data) and its own secrets; secrets never go to a fork's pull request; a
  cap on how many run at once, and automatic cleanup.
- The approval model: a standing approval of the preview recipe, approved once by hash; CI creates
  each preview within it, and anything outside it stops. An ADR extends constitution I.
- Research: [research.md](research.md). R3 holds the lead's decisions this spec builds on.

## Why

A change is easiest to judge running: a reviewer clicks a link and sees the new page, with its own
data, before anything is merged. Today an OpsCrew app has prod, and maybe staging, both following a
branch: a pull request's code runs nowhere until it is merged. Teams on Heroku, Render or Vercel
are used to a preview per pull request; users leaving those hosts lose it when they move to their
own servers.

Doing it safely is the hard part. A preview is created by CI, without the user at a terminal, so
the usual "plan, approve, apply" can't run for each one. And a pull request's job runs the pull
request's own workflow file, so anything the job can reach, the pull request's author can reach.
OpsCrew answers both with one standing approval of a preview recipe, enforced on the preview server
itself.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Set up previews once (Priority: P1)

The user runs `opscrew env add preview --previews`. OpsCrew asks only what previews need, then
designs them and shows their monthly cost before anything is created:
- **Where they run:** a small server of their own, on the same provider as prod by default, or a
  server the user already has with a public address and nothing else on it.
- **How many at once:** the cap, 3 by default. The server's size follows from the memory each
  preview needs (the app and its services), or the user picks the size and the cap follows.
- **Their addresses:** `pr-<n>.<app's hostname>` by default, or under another name in a Cloudflare
  zone the user has (`--domain`).
- **Their data:** the seed command OpsCrew found (for example `php artisan db:seed --force`), to
  confirm, another command, or none.
- **The app's own values for previews:** from `.env.preview` (test keys), never from prod's `.env`.
- **How long an idle preview lives:** 7 days without a push by default.

Then `opscrew provision --env preview` shows the plans: the server and one wildcard DNS record, and
the preview recipe on the server. The user approves them by their hashes, as any plan, and types
`<app>-preview` to confirm that every preview's own data is deleted, without asking again, when its
pull request closes or it is idle too long. The deploy-setup pull request adds the preview workflow.

**Why this priority**: nothing else works without it, and it is the approval the whole feature
rests on.

**Independent Test**: on the example app with a domain, `opscrew env add preview --previews` then
`opscrew provision --env preview`: the server exists, `*.<hostname>` points at it (DNS only), the
recipe and the restricted key are on it, the workflow is in the deploy-setup pull request, and
prod's plan, state and site are unchanged.

**Acceptance Scenarios**:

1. **Given** an app deployed with a domain on Cloudflare, **When** the user runs
   `opscrew env add preview --previews`, **Then** OpsCrew designs a preview environment, asking
   only the questions above, and shows the monthly cost of its server against the budget.
2. **Given** that design, **When** the user runs `opscrew provision --env preview`, **Then** they
   see an IaC plan (the server and `*.<hostname>`, not proxied) and a host plan (the edge, the
   recipe with every bound in plain words, the `opscrew-preview` command, its restricted key and the
   cleanup timer), each approved by its hash, with the typed confirmation `<app>-preview`.
3. **Then** the pull request's job gets only the restricted key, the server's address and its host
   key, in GitHub environment `preview`; the preview server's unrestricted key never leaves the
   user's computer.
4. **Then** the preview workflow arrives in the deploy-setup pull request, as every workflow does.
5. **Given** an app without a domain on Cloudflare, or a zone that already has a wildcard record at
   that name, **Then** it refuses before any change and says what to do.
6. **Given** `--target own` naming a server another environment or app runs on, **Then** it
   refuses: a pull request's code would run beside it.

---

### User Story 2 - Each pull request gets its preview automatically (Priority: P1)

A teammate opens a pull request that changes the app. Without anyone running anything, GitHub
Actions builds the image, starts the preview, and a comment on the pull request gives its address:
`https://pr-42.shop.example.com`. Each push updates it. When the pull request is merged or closed,
the preview, its data and its images are removed, and the comment says so.

**Why this priority**: it is the feature.

**Independent Test**: on the throwaway repository with previews set up, open a pull request that
changes the app: within the deploy's usual time the comment holds the address and the address
serves the pull request's code; push again and it serves the new commit; close it and the address
stops answering, the preview's containers, volumes and images are gone.

**Acceptance Scenarios**:

1. **Given** previews set up, **When** a pull request from a branch of the same repository is
   opened, reopened, marked ready for review, or pushed to, and it changes the app's files,
   **Then** the workflow builds `ghcr.io/…:pr-<n>-<sha>` on GitHub's machines and starts or updates
   preview `<n>` through `opscrew-preview`.
2. **Then** one comment on the pull request, kept up to date, holds the address, the commit it
   runs, and its state (starting, running, failed with why, removed).
3. **Given** a running preview, **When** the pull request is closed or merged, **Then** the preview's
   containers, volumes, site and route are removed and its images deleted from GitHub Container
   Registry.
4. **Given** pushes in quick succession, **Then** the newest wins: the run in progress for that pull
   request is cancelled.
5. **Given** a draft pull request, **Then** no preview until it is marked ready for review.
6. **Given** a pull request that changes none of the app's files, **Then** no preview, by the same
   path rules as push deploys.

---

### User Story 3 - Nothing outside what was approved (Priority: P1)

The user approved a recipe: one server, a cap, the image name, the hostnames, the services each
preview runs. Whatever a pull request does, even one that edits the preview workflow, it can't go
beyond that, and it can't reach prod.

**Why this priority**: it is the condition for a standing approval at all (constitution I).

**Independent Test**: from a pull request's job, call the restricted key with a request outside the
recipe (another image name, a shell command, a preview beyond the cap, a hostname not in the
pattern): each is refused by the server, and nothing changes there.

**Acceptance Scenarios**:

1. **Given** a pull request from a fork, or from Dependabot, **Then** no preview is made and the
   job's summary says why; the workflow never uses `pull_request_target`.
2. **Given** the restricted key, **When** it is used for anything but `opscrew-preview up`, `down`
   or `list` with valid arguments, **Then** the server refuses it; it opens no terminal and
   forwards nothing.
3. **Given** `up` with an image outside the app's own image name, a pull request number that isn't
   a number, or a preview beyond the cap, **Then** the server refuses before any change.
4. **Then** the services, memory limits, hostname and values of a preview come only from the
   approved recipe on the server, never from the request.
5. **Given** another environment's deploy secrets are repository secrets in a repository where
   GitHub enforces branch rules on environments, **When** the user runs `opscrew provision --env
   preview`, **Then** it refuses before any change and says to provision that environment first,
   which moves its secrets into a GitHub environment only its branch can use. Where GitHub enforces
   none (a Free private repository), the plan says that any workflow, a pull request's included, can
   read every secret of the repository.

---

### User Story 4 - Its own data (Priority: P2)

Each preview runs its own copies of the app's databases and other services, empty, then the
release command, then the seed command once, when the preview is created. Its generated passwords
are made on the preview server and stay there. Nothing in a preview reads or changes prod's data.

**Why this priority**: a preview with prod's data is a leak; one with no data is often useless.

**Independent Test**: the example app with Postgres and a seed: a new preview's database holds the
seed's rows, a second preview's database is separate, and prod's database is never connected to.

**Acceptance Scenarios**:

1. **Given** an app with Postgres and Redis, **When** preview 42 starts, **Then** it runs its own
   Postgres and Redis containers, with their own volumes and passwords, on its own network.
2. **Then** the release command runs before the app starts, on every update; the seed command only
   at creation.
3. **Given** the seed fails, **Then** the preview still starts, and the comment says the seed failed
   and how to see its log.
4. **Then** the app's own values come from the recipe (`.env.preview`); services that live elsewhere
   (a bucket, a hosted database) are whatever `.env.preview` names.

---

### User Story 5 - A cap, and cleanup without anyone (Priority: P2)

The preview server never runs more previews than the cap, and nothing lingers: an idle preview is
removed after its lifetime, and images of closed pull requests are deleted.

**Why this priority**: a small fixed server only works if it never fills up.

**Independent Test**: with a cap of 1, open two pull requests: the second gets the cap comment;
close the first, push to the second: it gets its preview. Set the lifetime short: the idle preview
is removed by the server's timer and the comment says so on the next run.

**Acceptance Scenarios**:

1. **Given** the cap reached, **When** another pull request opens, **Then** its comment says the cap
   is reached, how to free a place, and nothing running is stopped.
2. **Given** a preview with no update for its lifetime, **Then** the server removes it, and its
   next push brings it back.
3. **Given** a pull request closed while its workflow didn't run to the end, **Then** the next
   preview run deletes the images of pull requests no longer open, and the server's timer removes
   the preview after its lifetime.

---

### User Story 6 - From the user's computer (Priority: P2)

The user sees and manages previews without SSH: `opscrew preview list` (each preview: pull request,
address, commit, age, memory), `opscrew preview logs <n>`, `opscrew preview destroy <n>`. Changing
the recipe (cap, size, seed, values) is `opscrew design --env preview` then `opscrew provision
--env preview`, approved by hash. `opscrew destroy --env preview` removes the server, the wildcard
record and every preview, with the typed confirmation.

**Independent Test**: list, read a preview's logs, destroy one, then destroy the environment: the
server, the record, the GitHub secrets and the GitHub environment are gone, and prod is unchanged.

**Acceptance Scenarios**:

1. **Given** previews running, **When** the user runs `opscrew preview list`, **Then** it lists
   them from the server, read-only.
2. **When** the user runs `opscrew preview destroy 42`, **Then** after confirming, preview 42 is
   removed as if its pull request closed.
3. **Given** a recipe change approved, **Then** each running preview takes it at its next update.
4. **When** the user runs `opscrew destroy --env preview --confirm <app>-preview`, **Then** the
   server, the wildcard record, every preview, the environment's GitHub secrets and its GitHub
   environment are removed.

---

### User Story 7 - In Claude Code (Priority: P3)

The plugin's skill knows previews: how to set them up, what the comment means, and how to list
them. The MCP server offers `opscrew_preview_list`, read-only.

### Edge Cases

- **The app on the zone's apex:** the wildcard is `*.<zone>`, so every name without its own record
  reaches the preview server, which answers none of them. Setup says so and offers `--domain`.
- **Prod behind Cloudflare's proxy:** previews are DNS only; their addresses would be two labels
  below the zone, which the free certificate doesn't cover. The preview server's address is public;
  it holds nothing of prod's.
- **Let's Encrypt's limit** of 50 new certificates a week per registered domain: Caddy falls back
  to ZeroSSL; the guide says a team opening more previews than that a week should use another base
  name's domain.
- **Several apps in one repository:** each app has its own preview environment and server in this
  version; a pull request touching two apps gets two previews.
- **Split placement (018):** a preview runs every service on the preview server.
- **Self-hosted runners:** previews always build and deploy on GitHub's machines; `--runner` and
  `--build` other than `github` are refused for previews.
- **Monitoring, alerts, Beszel, Grafana Cloud, image signing and deploy tags:** not for previews.
- **Promote, rollback and retarget:** refused for the preview environment, with a plain message.
- **A pull request that adds a service:** it previews without it until the recipe is changed; the
  comment says the preview runs the recipe's services.
- **The release command or the health check fails:** the preview isn't routed; the comment says
  which step failed and to run `opscrew preview logs <n>`.
- **The preview server unreachable:** the job fails with a plain message in the comment; nothing
  else changes.
- **A pull request reopened after its preview was removed:** it is created again, empty and seeded.
- **A closed pull request's run cancelled mid-way:** `down` is safe to repeat; the timer finishes
  what is left.
- **The recipe changed while previews run:** each takes it at its next update; a service the recipe
  no longer has is removed with its data, covered by the standing confirmation.

## Requirements *(mandatory)*

### Functional Requirements

**Setting up**
- **FR-2201**: `opscrew env add <name> --previews` MUST design a preview environment (one per app):
  its target (Hetzner or DigitalOcean server, or the user's own server with a public address), its
  size and cap, its hostname base, its seed command, its lifetime, and the values file
  `.env.<name>`; and show the server's monthly cost against the budget.
- **FR-2202**: It MUST refuse a server any other environment or app runs on, Portainer, this
  computer, Cloudflare's hosting and GitHub Pages, an app without a Cloudflare zone, and a zone with
  a wildcard record at the chosen name, before any change.
- **FR-2203**: The size and cap MUST follow from the memory each preview needs (the app and the
  services the recipe runs) plus the edge; the user sets one and design computes the other.
- **FR-2204**: The seed command MUST default to the detected one (Prisma, Rails, Laravel, Knex,
  Sequelize, AdonisJS, and a `db:seed` or `seed` script), confirmed by the user; none when nothing
  is found.

**The standing approval**
- **FR-2205**: `opscrew provision --env <preview>` MUST create the server and one DNS-only wildcard
  record through the IaC plan, and install the recipe, the `opscrew-preview` command, its
  restricted key and the cleanup timer through a host plan; each approved by its hash, with the
  typed confirmation `<app>-<env>` that previews' data is deleted without asking again. The
  rendered recipe, without values, MUST be committed in the deploy-setup pull request.
- **FR-2206**: The recipe MUST hold every bound: the cap, the lifetime, the hostname pattern, the
  image name allowed, every file of a preview (Compose definition with services, memory limits and
  networks, edge site, start and rollback scripts, env templates), the seed command, and the app's
  preview values; the host plan MUST show them in plain words (the values by name only).
- **FR-2207**: The restricted key MUST be installed as `restrict,command="…opscrew-preview"`;
  `opscrew-preview` MUST accept through it only `up <n> <image digest> <commit>`, `down <n>` and
  `list`, check each argument strictly, and refuse anything else before any change.
- **FR-2208**: `up` MUST refuse an image outside the recipe's image name or not pinned by digest, a
  new preview beyond the cap, and MUST take services, limits, hostname and values only from the
  recipe.
- **FR-2209**: The pull request's job MUST get only the restricted key, the address and the host
  key (in the GitHub environment of the preview environment); the unrestricted key stays local.
  Provision MUST refuse while another environment's deploy secrets are repository secrets in a
  repository where GitHub enforces branch rules on environments; where it enforces none, the plan
  MUST say that any workflow can read every secret of the repository.
- **FR-2210**: The constitution's principle I MUST gain the standing approval (ADR 0026, version
  1.7.0): bounds named in an approved plan, enforced on the target, each action under it recorded,
  reaching no other environment's servers or data, nor its secrets where the code host can keep
  them apart.

**The workflow**
- **FR-2211**: The preview workflow MUST run on `pull_request` (opened, synchronize, reopened,
  ready_for_review, closed), never `pull_request_target`; skip forks, Dependabot and drafts; use the
  app's path rules; and run one concurrency group per pull request, cancelling the run in progress.
- **FR-2212**: It MUST build on GitHub's machines with the app's builder, push
  `ghcr.io/<owner>/<repo>[/<app>]:pr-<n>-<sha>`, and call `up` with the image's digest and the head
  commit; the server pulls with the short-lived token of a job that may only read packages, passed
  on stdin.
- **FR-2213**: On close or merge it MUST call `down`, delete the pull request's image versions and
  mark its deployments inactive; every run MUST also delete the images of pull requests no longer
  open; and every deploy workflow's image cleanup MUST delete `pr-*` images older than 31 days.
- **FR-2214**: It MUST keep one comment on the pull request with the address, the commit, and the
  state, saying plainly why a preview failed, hit the cap, or was removed; never a secret or a log
  line. A skipped fork or Dependabot run (whose token can't comment) says why in its job summary.

**On the server**
- **FR-2215**: Each preview MUST be its own app `<app>-pr-<n>`: its Compose project, folder,
  networks, volumes, Caddy site and route on the shared edge, with `X-Robots-Tag: noindex`.
- **FR-2216**: Each preview's generated values MUST be made on the server, in the format each needs,
  kept for its updates, and never leave it.
- **FR-2217**: `up` MUST apply the current recipe and run the release command on every update, and
  the seed command until it has succeeded once; a failed seed leaves the preview up and says so.
- **FR-2218**: A timer MUST remove previews idle longer than the lifetime; `down` MUST be safe to
  repeat and finish a half-done removal; every `up`, `down` and removal by the timer MUST be
  recorded in a log on the server.

**Commands**
- **FR-2219**: `opscrew preview list`, `logs <n>` and `destroy <n>` MUST work over the user's own
  key; `list` and `logs` read-only, `destroy` after a confirmation.
- **FR-2220**: `opscrew destroy --env <preview>` MUST remove every preview, the server, the record,
  the GitHub secrets and the GitHub environment OpsCrew created, with the typed confirmation.
- **FR-2221**: `promote`, `rollback` and `retarget` MUST refuse the preview environment plainly;
  `status`, `verify`, `secure`, `drift` and `advise` work on its server as on any.
- **FR-2222**: The MCP server MUST offer `opscrew_preview_list`, read-only; the plugin's skill
  covers previews.
- **FR-2223**: The guide MUST gain a previews page: setup, the standing approval and its bounds,
  what pull requests get one, data, the cap and cleanup, the commands, and what previews don't do.

### Key Entities

- **Preview environment:** an environment with `previews` set; one per app.
- **Preview recipe:** the bounds on the server (cap, lifetime, hostname pattern, image name,
  Compose definition, seed command, values), from the approved host plan.
- **Preview:** one pull request's app `<app>-pr-<n>`: its image digest, commit, creation and last
  update times, state.

## Success Criteria *(mandatory)*

- **SC-2201**: Live: a pull request on the throwaway repository gets a working address in its
  comment, updates on push and is fully removed on close (no container, volume, site, route or
  image left).
- **SC-2202**: Every request outside the recipe through the restricted key is refused with nothing
  changed (tests over `opscrew-preview`, and live from a runner).
- **SC-2203**: A fork's pull request never gets a preview and its job never sees a secret.
- **SC-2204**: No secret, generated password or log line appears in a comment, a workflow log or
  the audit log.
- **SC-2205**: Setting up previews leaves prod's plan, state, site and secrets unchanged.

## Assumptions

The lead's defaults, for the founder to change:
- **Automatic for every same-repository pull request** that changes the app; drafts wait until they
  are ready for review. No label needed.
- **Cap 3, lifetime 7 days.**
- **Addresses `pr-<n>.<app's hostname>`, DNS only,** with Let's Encrypt certificates on the preview
  server.
- **Previews are public** (with `noindex`): anyone with the address can open them.
- **One preview server per app.**

## Out of scope

- Previews for pull requests from forks.
- A login in front of previews.
- Previews on Cloudflare's hosting, GitHub Pages, Portainer or this computer.
- Previews of several apps wired to each other.
- Copies of prod's data, or of any other environment's.
- Several apps' previews sharing one server.
