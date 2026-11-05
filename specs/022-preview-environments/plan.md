# Implementation Plan: Preview environments per pull request

**Branch**: `main` | **Date**: 2026-11-05 | **Spec**: `specs/022-preview-environments/spec.md`
**Research**: `specs/022-preview-environments/research.md` (R1–R5)
**Data model**: [data-model.md](data-model.md) | **Contract**: [contracts/opscrew-preview.md](contracts/opscrew-preview.md)

The founder gave the go-ahead on 2026-11-05. A cross-artefact review (2026-11-05) and the spike
(R5) shaped this version.

## Summary

A preview environment is an environment with `previews` set. `opscrew env add preview --previews`
designs it; `opscrew provision --env preview` creates its server and a proxied wildcard record on
the previews' own domain (IaC plan; section 11), installs the preview recipe (host plan), both approved by hash, the host plan with the
typed confirmation that covers deleting previews' data, and commits the rendered recipe (without
values) in the deploy-setup pull request. A new workflow, `opscrew-preview[-<app key>].yml`, builds
each same-repository pull request on GitHub's machines and calls the server's `opscrew-preview`
command through a key restricted to it; the command checks every request against the recipe and
starts, updates or removes the app `<app>-pr-<n>` (`<app>` is the preview environment's app name,
`shop-preview`).

- **The recipe** is rendered by OpsCrew at provision, never on the server: `settings.env`, a
  `template/` folder (every file a deploy uploads to an app's folder today, rendered for a
  placeholder app, plus the seed script and the env templates) and the `opscrew-preview` script.
  The only per-preview inputs are the pull request number (digits), the image digest (checked
  against the recipe's image name) and the commit (hex); generated values are made on the server
  in the format each needs.
- **Two keys:** the environment's deploy key (unrestricted, stays on the user's computer, used by
  provision and `opscrew preview …`) and the preview key (`restrict,command="…/opscrew-preview"`,
  the only key in GitHub).
- **Prod's secrets out of reach:** provision refuses while another environment's deploy secrets are
  repository secrets in a repository where GitHub can keep them apart; where it can't (GitHub Free,
  private), it says so before the approval (research R1.2).
- **Cleanup:** `down` on close or merge; a cron line of the deploy user runs `opscrew-preview gc`
  hourly for idle previews; each preview run deletes the images of pull requests no longer open, and
  every deploy workflow's image cleanup deletes `pr-*` images older than 31 days (R5).
- **Surfaces:** `env add --previews`, `opscrew preview list|logs|destroy`, `destroy --env preview`,
  the MCP tool `opscrew_preview_list`, the plugin's skill, a guide page.

## Technical Context

- **Stack:** the same as 000–021. **No new npm dependency, no new image, no new IaC module.** The
  wildcard is the existing `cloudflare-dns` module called with `domain = "*.<base>"`, `proxied =
  false`, `www = false` and no CAA issuers.
- **No change in `@opscrew/contracts`.** Approval kinds stay the same: the IaC plan is `iac-apply`,
  the recipe a `host-apply` plan marked as deleting data, so the existing gate already requires
  `allowDestroy` and the typed `<app>-<env>`.
- **`plan-schema`** gains `environment.previews` and the architecture's `facts.build.seedCommand`; a
  preview environment's plan has `dns.zone` but no `dns.domain` (its base lives in
  `previews.domain`), so no hostname check, site, verify or runbook ever aims at prod's name.
  `core/paths` gains the preview key's path.
- **The script** is POSIX `sh` with `docker`, `flock`, `date`, `od` and `base64` (coreutils, on
  every Ubuntu and Debian image OpsCrew supports); no `jq`. `settings.env` holds only values
  OpsCrew validated with zod before rendering, each of `[a-z0-9._/-]` or digits, so sourcing it is
  safe.
- **The spike (T2201, R5):** one GitHub environment serves every pull request (each keeps its own
  "View deployment"); `deployment: false` is valid; a pull request's `GITHUB_TOKEN` pushes and
  deletes its images; a fine-grained personal token can't use the packages API at all.
- **Tests:** zod and refinements; the script under `sh` with shims for `docker`, `kamal-proxy` and
  `flock` (as `iac-templates`' sh-based tests do), every row of the contract; the placeholder
  rendering against a direct rendering; the workflow rendered and checked with `actionlint` when
  present; the host plan with the facts fixtures and the sshd Docker harness; the agents with fakes;
  a Docker-gated run of the script on a real Docker (`OPSCREW_DOCKER_TESTS=1`); a gated live pass
  (T2213).

## Constitution Check

- **I (safety gate):** amended (1.7.0, ADR 0026) to allow a standing approval: the recipe's host
  plan names every bound and is approved by hash with `allowDestroy` and the typed `<app>-<env>`;
  the bounds are enforced on the server by the forced command, so a pull request that edits the
  workflow can't exceed them; each action CI takes under it is recorded on the server
  (`previews.log`) and in the pull request (the comment and its deployment). Provision refuses
  while a pull request could read another environment's secrets and GitHub can prevent it
  (FR-2202). Every other change (the server, the record, the recipe, a change of the recipe or the
  values, destroying the environment) goes through the usual plan and approval.
- **II (user owns everything):** the workflow, the plan and the rendered recipe (without values)
  are plain files in the repository (`opscrew/environments/<env>/previews/`); the server's copy is
  the same files; deleting OpsCrew leaves both working.
- **III (dual engine):** the existing module; one more call in the preview environment's root.
- **IV (secrets):** the preview values are written by the host plan at apply (never in the plan,
  the repository, GitHub, logs or comments); generated values never leave the server; the preview
  key is the only secret in GitHub and can do only what the recipe allows; the registry token sent
  to the server comes from a job that may only read packages; comments carry no log lines.
- **V (deterministic first):** no model; detection of seed commands is code.
- **VI (contracts first):** the schema in wave 1 (T2202); waves 2 on depend on it.
- **VII (test first):** every row of the contract has a test; a live pass.
- **VIII (typed adapters):** the server changes through the host adapter (`planAddon`), DNS through
  the IaC engine, GitHub through the connector; the workflow's own steps are rendered by OpsCrew.
- **IX (plain language):** the host plan states the bounds in words; the comment says what happened
  and what to do.
- **X (simplicity):** one server per app, one wildcard, one script; no new service, image or daemon
  (cron, not a container); no login in front of previews; no forks.

## Project Structure

```text
packages/plan-schema/src/          environment.previews, refinements, facts.build.seedCommand (T2202)
packages/core/src/paths.ts         the preview key's path (T2202)
packages/detect/src/seed*.ts       seed commands (T2203)
packages/iac-templates/src/previews/   the recipe renderer and the opscrew-preview script (T2204)
packages/iac-templates/src/runtime/    the seed service in a preview's Compose file (T2204)
packages/iac-templates/src/workflow/preview*.ts, build.ts, retention.ts   the preview workflow,
                                   preview build tags, pr-* images older than 31 days (T2205)
packages/iac-templates/src/infra/  the preview root's wildcard record (T2205)
packages/connectors/ssh-host/src/  planAddon("previews"), the preview key line, facts (T2206)
packages/agents/src/environments/, design/, analyze/   env add --previews, sizing, seed (T2208)
packages/agents/src/provision/, shared/app-env.ts, previews/setup.ts   provisioning previews (T2209)
packages/agents/src/previews/ (list, logs, destroy), destroy/, promote/, rollback/, retarget/,
  addons/, move/, status/, verify/, drift/, secure/, advise/   commands and refusals (T2210)
packages/cli/src/commands/, packages/mcp-server/src/, plugin/skills/   surfaces (T2211)
docs/guide/previews.md             the guide page (T2212)
packages/cli/test/live/previews*.ts   the live pass (T2213)
docs/adr/0026-preview-environments.md, .specify/memory/constitution.md   (lead, T2201)
```

## Design

### 1. Schema (T2202)

`environment.previews` (absent for every other environment):
- `cap` (1–20, default 3), `lifetimeDays` (1–30, default 7);
- `domain`: the base name, default the app's prod hostname; previews are `pr-<n>.<domain>`;
- `seed`: a command, or `null` for none (absent: the detected one, set by design).

Refinements on a plan with `previews` (data-model.md): target `hetzner`, `digitalocean` or `own`;
`runner: github` and `build` github; `deploySource.from: main`; no `servers`; the add-ons, the
check, monitoring, signing and deploy tags off; `dns.provider: cloudflare` with `zone`, no
`domain`, `proxied: false`, `www: false`; `app.name` at most 31 characters, so
`<app.name>-pr-999999` fits the app-name pattern. Another environment can't be promoted from a
preview environment. The plan schema's "a Cloudflare plan has a domain" rule gains this one
exception.

`facts.build.seedCommand` and `seedNote` in the architecture (written by detection), next to the
release command.
`core/paths`: `previewKey` (`~/.opscrew/projects/<id>/environments/<env>/preview_key[.pub]`).

### 2. The spike and the ADR (T2201, lead)

Done (R5): S1 (one GitHub environment shared by pull requests keeps each one's "View deployment";
`deployment: false` is valid) and S2 (`GITHUB_TOKEN` pushes and deletes a pull request's images; a
fine-grained personal token can't use the packages API, so OpsCrew never deletes images with the
user's token). The restricted key from a runner is already proven by the check's key, and a
certificate under a DNS-only wildcard is plain DNS (the live pass shows it). ADR 0026 is accepted
and the constitution amended (1.7.0).

### 3. The recipe and `opscrew-preview` (T2204)

`renderPreviewRecipe(plan, { repository, imageName, env })` returns files by path under the
recipe's folder `/srv/apps/<app>/` (data-model.md), where `env` is the env templates T2209 builds:
- `settings.env`: `APP`, `CAP`, `LIFETIME_DAYS`, `IMAGE_NAME`, `BASE`, `SEED` (`1`/`0`).
- `template/`: what a preview's folder gets, rendered from a copy of the plan whose `app.name` is
  `<app>-pr-<token>` and whose hostname is `pr-<token>.<base>`:
  - every file a deploy uploads to an app's folder today (`renderRuntimeFiles`: the Compose file,
    service files, crontab, the edge's Compose file and the app's site, with
    `header X-Robots-Tag "noindex"` added to the site), the start script (`switchCommands`) and the
    rollback script (`rollbackCommands`);
  - with a seed, a `seed` service in the Compose file, rendered like `release` (same image, env and
    user, `sh -c` around the command) and only ever run, never started (`renderCompose` gains the
    option);
  - `env/app.env` and `env/<service>.env`: `env`'s templates.
- `bin/opscrew-preview`: the script of the contract.

**Placeholders.** The renderers take a valid plan, so the number's token is a fixed lower-case word
of at most 6 letters that is valid in app names and hostnames; the recipe turns it into `@N@`.
Generated values are `@SECRET:<name>:<format>@` with the format each needs: `hex32`, `hex64`,
`b64k32` (`base64:` and 32 random bytes in base64, Laravel's key) and `gk` (Garage's `GK` and 12
bytes in hex). A test renders the recipe, fills it with 42 and fixed values, and compares it with a
direct rendering of the plan as `<app>-pr-42` with those values: they must be equal.

**The script** reads its request from `SSH_ORIGINAL_COMMAND` when set (the preview key), else from
its arguments (the deploy key and cron). Behaviour, per the contract:
- `up` takes the recipe lock only to count previews and create a new preview's folder; each preview
  has its own lock for the rest (`up`, `down` and `gc` of the same preview). The edge keeps its own
  lock.
- Each `up` fills `template/` into `/srv/apps/<app>-pr-<n>/` again (so a recipe change reaches the
  preview at its next update): `@N@` from the checked number, each `@SECRET…@` from the preview's
  `secrets.env` (0600), generating and appending a value only the first time its name is seen. The
  app's env files are `values.env` (the user's preview values) followed by the filled templates, as
  `assembleAppEnv` orders them.
- The registry login goes into the preview's `.docker` folder, which the start script uses, from
  the token on stdin, and is removed when `up` ends.
- Then `start.sh <image>` (its output to `up.log`); on a failed update the rollback script puts the
  previous image back. The seed runs after a successful start while `.seeded` is absent, and
  `.seeded` is written when it succeeds, so a creation cancelled before its seed still seeds at the
  next `up`.
- `down` removes the route, the site, the Compose project with its volumes and the folder, in an
  order that can be repeated. `gc` runs `down` for previews whose `.preview` update time is older
  than `LIFETIME_DAYS`. `list` prints one line per preview. `logs <n>` (never through the preview
  key) prints the last lines of the preview's containers.
- Every `up`, `down` and `gc` appends one line to `/srv/apps/<app>/previews.log`: the time, the
  request without its arguments' values beyond the number, and the result.

The script is rendered from TypeScript (one template string with the settings' names as constants),
tested under `sh` with shims for `docker`, `kamal-proxy` and `flock` covering each row of the
contract, plus a Docker-gated test that runs `up`, an update, `list`, `down` on a real Docker with a
tiny image and the edge.

### 4. The workflow, the builds and the wildcard (T2205)

`renderPreviewWorkflow(plan, ctx)` writes `.github/workflows/opscrew-preview[-<app key>].yml`:
- `on: pull_request` with `types: [opened, synchronize, reopened, ready_for_review, closed]` and the
  app's `paths:` (as push deploys); `permissions: contents: read` at the top; concurrency
  `opscrew-preview[-<app key>]-${{ github.event.pull_request.number }}` with `cancel-in-progress:
  true`.
- Every job runs only when `github.event.pull_request.head.repo.full_name == github.repository &&
  github.actor != 'dependabot[bot]'`; a `skipped` job for the others writes the reason to
  `$GITHUB_STEP_SUMMARY` (its token can't comment).
- `build` (not closed, not draft; `packages: write`): the app's builder job (`build.ts`, which gains
  a preview mode) on `ubuntu-latest`, building the merge commit GitHub checks out; final tag
  `pr-<n>-<github.sha>`, intermediate `build-pr-<n>-<github.sha>`, cache `buildcache-<env>`; no
  signing, tags or labels.
- `deploy` (`contents: read`, `packages: read`): in the preview environment's GitHub environment
  with `url: https://pr-<n>.<base>`; writes the preview key and known hosts; `printf '%s'
  "$GITHUB_TOKEN" | ssh … "up <n> <image digest> <head commit>"` (the head commit,
  `github.event.pull_request.head.sha`, for people); checks `https://pr-<n>.<base><healthPath>`
  with retries for up to 3 minutes (the first certificate). Its outputs: the contract's state and
  detail.
- `report` (always after `deploy`; `pull-requests: write`, `packages: write`): updates the comment
  from `deploy`'s outputs; deletes the images of pull requests no longer open and this pull
  request's versions other than the one now running (`pull-requests: read` to list open ones).
- `remove` (closed; `packages: write`, `pull-requests: write`, `deployments: write`): in the GitHub
  environment with `deployment: false`; `ssh … "down <n>"`; deletes the pull request's image
  versions; marks the pull request's deployments `inactive`; updates the comment.
- The comment is found by a hidden marker (`<!-- opscrew-preview:<app> -->`) and edited in place;
  its text comes from the contract's state and detail, never from container output.

Every deploy workflow's `prune` (`retention.ts`) also deletes `pr-*` and `build-pr-*` versions
created more than 31 days ago, retention on or off: none belongs to a running preview (R5).

The infra renderer gives the preview environment's root the server as usual and the `dns` module
with `domain = "*.${var.preview_domain}"`, `proxied = false`, `www = false` and `caa_issuers = []`.

### 5. The host plan (T2206)

`planAddon("previews", { app, runAs, facts, repository, enable: { files, publicKey }, … })` in
`connectors/ssh-host`:
- writes the recipe's files to `/srv/apps/<app>/` (each within a size cap, the script `0755`), and
  `values.env` (0600) from `previewValues` supplied at apply, never in the plan or its hash input
  (the plan lists the values' names only); with `secretsChanged` the step rewrites it even when the
  facts show the recipe in place (as `planAddon`'s other kinds do);
- installs `previewKeyLine(publicKey, repository, app)` (data-model.md; the line with the same
  comment replaced); `deployKeyStep`'s reconciliation keeps such lines and `inspectHost` leaves
  them out of the deploy keys it reports, as both do for the check's;
- adds the cron line to the deploy user's crontab (minute from the app name, never 0); on the
  user's own server the root plan installs `cron` when absent;
- is a destroying plan (`deleteData`), so its approval needs `allowDestroy` and the typed name;
- off (`disable`): `down` for every preview the facts list, then the recipe folder, the key line
  and the cron line;
- `inspectHost` facts list each preview app's previews (`/srv/apps/<app>-pr-<n>`).

### 6. Designing previews (T2208)

`opscrew env add <name> --previews` (default name `preview`): the target (the prod provider by
default, the smallest type that fits; or `own` with an inspected server that runs no app), the cap
or the size (the other computed: each preview's memory is the sum of the memory limits the runtime
renders for the app and its on-server services, plus the edge's and the system's share `sizeFor`
already reserves), the base domain (refusing an app without a Cloudflare zone and a record already
at `*.<base>` read through the Cloudflare connector, and saying so when the base is the zone apex),
the seed (the detected `facts.build.seedCommand`, confirmed; `--seed <cmd>` or `--no-seed`), the lifetime,
and the values file `.env.<name>` (offered as `env add` offers env files; prod's `.env` never).
Requirements for the environment default to `dataCriticality: none` and `uptime: best-effort`, so
backups and uptime proposals don't apply. Design shows the server's monthly cost and the budget
warning as for any environment. `env remove` of a preview environment deletes its preview workflow
and its committed recipe too. Detection writes the seed command into the facts, as it does the release command.

### 7. Provisioning previews (T2209)

`opscrew provision --env <preview>`:
1. **The secrets check first:** any environment of any app in the repository whose deploy secrets
   a pull request could read (repository secrets, or a GitHub environment without its branch rule),
   in a repository where GitHub enforces branch rules on environments (the probe of 015), is
   refused before any change (once a repository has previews, every app's environments, prod-only
   ones included, place their secrets in branch-limited GitHub environments): "a pull request
   could read <env>'s deploy key; run `opscrew provision [--app <key>] --env <env>` first, which
   moves its secrets into a GitHub environment only its branch can use". Where GitHub enforces none (Free, private), the host plan's text says that any
   workflow, a pull request's included, can read every secret of the repository.
2. The IaC plan (server, firewall, wildcard), `iac-apply` by hash.
3. The server's own host plans as for any environment, then the previews host plan
   (`planAddon("previews")`), `host-apply` by hash, with `allowDestroy` and the typed
   `<app>-<env>`; its text states the standing approval: "GitHub Actions will create, update and
   delete previews of same-repository pull requests within these bounds without asking again; each
   preview's data is deleted when it ends", then every bound and the values' names.
4. **The env templates:** `assembleAppEnv` (`shared/app-env.ts`) gains a value source that yields
   the `@SECRET:<name>:<format>@` placeholders instead of generated values, and keeps the user's own
   values apart (they go to `values.env` at apply). The rendered recipe is committed, without
   values, in `opscrew/environments/<env>/previews/`.
5. **The GitHub side:** the preview key's private half, the server's address and known hosts as the
   environment's secrets (`OPSCREW_<ENV>_HOST`, `…_SSH_PRIVATE_KEY`, `…_SSH_KNOWN_HOSTS`), placed as
   015 places them, with no branch rule on its GitHub environment; no app or service env secrets;
   build values as for any named environment. The preview workflow and the recipe go into the
   deploy-setup pull request; no push-deploy workflow, scheduled check, Dependabot entry or
   monitoring for this environment.
6. No first deploy: previews come from pull requests. The summary says what happens next.

A later `provision --env preview` re-renders the recipe; an unchanged recipe and unchanged values
(compared by a digest kept locally) are in place; a changed one is a new host plan to approve.

### 8. Commands and refusals (T2210)

- `opscrew preview list` (read-only; runs `opscrew-preview list` with the deploy key), `logs <n>`,
  `destroy <n>` (typed `pr-<n>`, `--confirm pr-<n>` in scripts; audited as `remote-exec`).
- `opscrew destroy --env <preview>`: on a server OpsCrew created, the IaC destroy removes the server
  and the record; on the user's own server, `planAddon("previews", { disable })` and the usual
  own-server removal; then the GitHub secrets and environment (existing). It says that the images
  of previews still running are deleted by the deploy workflows' image cleanup within 31 days.
- `promote` (to or from), `rollback`, `retarget`, `addon enable` and `move` refuse a preview
  environment with a plain message; `status --env preview` shows the server and the previews (no
  app health check); `verify --env preview` checks the server and each preview's address; `drift`
  compares the preview root and the recipe as provision renders them; `secure` and `advise` work on
  the server as on any.

### 9. Surfaces (T2211), the guide (T2212)

CLI: `env add --previews [--cap n | --size type] [--lifetime days] [--domain name] [--seed cmd |
--no-seed]`; `opscrew preview list|logs|destroy`. MCP: `opscrew_preview_list` (read-only, with
`environment` and `app`). The deploy skill gains a previews section (when to suggest them, what the
comment says). Guide `docs/guide/previews.md`, linked from `environments.md`, `index.md` and the
README's feature list.

### 10. The live pass (T2213)

Gated on `OPSCREW_E2E_PREVIEWS=1` with the Hetzner, Cloudflare and GitHub variables, on the
throwaway repository: set up previews for the example with Postgres and a seed (cap 1, lifetime 1
day); open pull request A: address, seeded rows, noindex header, its "View deployment"; push: new
commit served, passwords kept; open B: the cap comment; close A: everything gone (containers,
volumes, site, route, images, the deployment inactive); push to B: its preview; the restricted
key's refusals from a runner; a fork-like skip is unit-tested only; `preview destroy`, then
`destroy --env preview`; prod unchanged throughout (SC-2205); a leak search over comments, logs
and the audit log (SC-2204).

## Order

T2201 (lead, done with the documents) → wave 1 {T2202, T2203, T2206} → wave 2 {T2204, T2205, T2208}
→ wave 3 {T2209, T2210} → wave 4 {T2211, T2212} → T2213 → T2214 (live runs, lead) → T2215
(simplify, lead) → T2216 (release, lead). Within a wave, export lines in a package's `index.ts`
that two tasks add are merged by the lead.

## Complexity Tracking

| Item | Why it's needed | Simpler alternative rejected because |
|---|---|---|
| A forced-command script on the server | A pull request runs its own workflow file, so only the server can hold the bounds of a standing approval (R1.1, R1.6). | Bounds checked in the workflow can be edited by the pull request. |
| Two keys for one server | The unrestricted key must never be in GitHub. | One key in GitHub would give every pull request root on the preview server (docker group). |
| A proxied wildcard on a domain of the previews' own (section 11) | No Cloudflare token in a pull request's job (R1.4), and no certificate that names a preview (R6). | Per-preview records need a zone-wide token in CI; DNS-only names each get a public certificate, which publishes them. |
| Templates with placeholders | Per-preview files must come from the approved recipe, not from the request. | Rendering on the server would need OpsCrew's renderer there. |
| A GitHub environment with no branch rule | Each pull request keeps its own "View deployment" (R5, S1). | Prefixed repository secrets alone work, but the pull request then has only the comment's link. |

## 11. Addresses nobody can guess (US8, research R6; added 2026-11-05)

No new dependency.

- **Plan (T2222):** a preview plan's `dns` is proxied (`proxied: true`), with `previews.domain`
  equal to `dns.zone` (a zone of its own) and `security.httpAllowedFrom: cloudflare`; the
  `proxied: false` refinement goes. Plans without previews are unchanged.
- **The server and the recipe (T2223):** the preview root's `dns` module makes `*.<zone>` proxied;
  each preview's Caddy site is `pr-<n>-<random>.<zone>` with `tls <origin.pem> <origin.key>` from
  `/srv/edge/tls/<app>/` (no automatic HTTPS); the script draws the random part (10 of `[a-z0-9]`
  from `/dev/urandom`) when it creates a preview, keeps it in `.preview`, and answers `running
  pr-<n>-<random>.<zone>`; `list` shows it. The workflow takes the address from `up`'s detail for
  the comment, the health check and the deployment URL.
- **The certificate (T2224, T2225):** provision makes an Origin CA certificate for `*.<zone>` and
  `<zone>` with the existing origin-TLS code (key made locally, kept in the environment's
  generated values); the previews host plan takes the certificate and key at apply
  (`previewTls`, never in the plan, part of `secretsChanged`) and writes them to
  `/srv/edge/tls/<app>/` (key 0600); off removes them.
- **Design (T2225):** `env add --previews` asks for the preview domain (a script passes
  `--domain`), refuses the app's own zone and a zone with other A, AAAA or CNAME records, and
  points to `opscrew domain buy`; `env add <env>` suggests `<env>-<random>.<zone>` (10 random
  characters, injected randomness) when the app's DNS is proxied and the name one level below the
  zone, otherwise says the name would be public and suggests the plain one.
- **Surfaces (T2226):** the CLI's flags and prompts, the guide's previews page (addresses), the
  environments page (hidden addresses), the skill, and the live pass on a preview zone.

## 12. Two opt-ins (US9, US10, research R7; added 2026-11-05 after 0.2.3)

No new dependency. Constitution 1.8.0 changes principle I's standing-approval bullet. The rest
of the Constitution Check above stands. The default stays a server and a domain of their own.

**A. On another environment's server (`previews.server.environment`).**
- **Plan (T2229):** `previews.server: { environment: <name> }`, which needs `target.provider: own`.
  OpsCrew neither creates nor deletes that server; `arch` and `edge` are the host's, and `access`
  is `public`. The server's address and logins are never copied into the preview environment's
  state: every reader takes them from the host environment.
- **The root:** unchanged. An own target's root is DNS only, and its wildcard points at
  `server_ipv4` and `server_ipv6`, which the CLI supplies as `TF_VAR_*`, never in tfvars. On a shared
  server provision supplies the host's addresses: the `server_ipv4` and `server_ipv6` outputs of
  its root on a server OpsCrew created, or its `.opscrew` `server.json` on the user's own.
- **Agents (T2232):**
  - **One helper** resolves the host's paths, plan and logins for every reach of the preview
    server: the host plan, preview commands, `verify`, `drift`, `status`, the GitHub secrets
    `HOST` and `KNOWN_HOSTS`. It uses the deploy login as `runAs: "login"` on a server OpsCrew
    created, and the recorded admin login as root on the user's own.
  - **`env add`** offers each eligible, provisioned environment and checks the R7.3 refusals.
    Inspection's apps must be the host environment's only.
  - **Design** fits the cap into the memory the host's server has left, prices no server, and makes
    the host environment's sizing and `advise` count the previews.
  - **Provision** skips the server, its base and the edge switch, and the approval names the host
    and repeats the warning.
  - **Refusals:** `destroy` and `retarget` of the host environment, and a proxy switch on its
    server. `destroy --env preview` removes the previews, the recipe and the wildcard, and never
    the server.
  - **Assumptions to check:** "a server OpsCrew creates holds only this app" (the edge switch,
    clean-up steps, disk and container checks in `verify`, `secure` and `status`) must hold or
    refuse on a host server with previews.

**B. Under the app's zone (`previews.domain` below `dns.zone`).**
- **Plan (T2229):** `previews.domain` equals `dns.zone` (a zone of its own) or is a name below it
  (the app's zone). The second is what makes the root hold an advanced pack. There is no new field.
- **Cloudflare (T2230):** read-only connector calls, each checked with zod: the pack quota
  (`advanced.allocated`, `used`), Total TLS (`enabled`), and the zone's packs (id, type, hosts,
  status).
- **The root (T2231):** below the zone, a `cloudflare_certificate_pack` named `previews`, with
  `type = "advanced"`, `hosts = [<zone>, "*.<domain>"]`, `certificate_authority = "lets_encrypt"`,
  `validation_method = "txt"`, `validity_days = 90` and `lifecycle { create_before_destroy =
  true }`. Its id is an output.
- **Agents (T2233):**
  - **`env add`:** a domain below the app's zone asks for the confirmation (`--app-zone` in a
    script) and refuses before any change, with the dashboard steps for each:
    - without ACM;
    - with Total TLS on;
    - with records at or below the domain;
    - with a domain that is an app or environment hostname, or a parent of one.
  - **Provision:** the same checks before the plan. After apply, it polls the pack (read-only)
    until `active`, for up to 10 minutes; otherwise it says previews answer once Cloudflare issues
    it, and that `verify` shows it.
  - **The Origin CA names and the rules:** they already follow `previews.domain` (`*.<domain>` and
    `<domain>`, `ends_with(http.host, ".<domain>")`); they sit in the app's zone beside the app's
    own rules through the shared plan.
  - **`verify` and `drift`:** the pack active and Total TLS off.
  - **`destroy`:** says that ACM stays on.
- **Surfaces (T2234):**
  - **CLI:** the `--share-server <env>` and `--app-zone` flags, with their prompts.
  - **The guide:** the previews page gets a "Fewer servers or one domain" section (both opt-ins,
    their risks, the refusals, ACM, cookies, how to undo each), and the environments page links to
    it.
  - **The skill.**
  - **The live pass:** `OPSCREW_E2E_PREVIEWS_SHARED=1` runs previews on a dev environment's
    Hetzner server, and B's refusal on a zone without ACM.
