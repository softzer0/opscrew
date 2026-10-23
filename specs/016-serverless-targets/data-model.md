# Data model: Server-less targets

## Plan targets (`plan.target`)

**Cloudflare Workers with static assets**

| Field | Type | Rule |
|---|---|---|
| `provider` | `"cloudflare-workers"` | |
| `mode` | `"workers-assets"` | |
| `worker` | string (Worker name rules: lower case, digits, `-`, up to 63) | Defaults to the app's name. Unique in the account. Another environment is `<app>-<env>`. |
| `render` | `"static"` or `"ssr"` | `ssr` only with a supported adapter (detected or added by `adapt`). |
| `notFound` | `"single-page-application"`, `"404-page"` or `"none"` | Defaults: SPA for a single-page app, `404-page` for a static site with a `404.html`. |
| `workersDev` | boolean, default `false` | The `workers.dev` address. |
| `previewUrls` | boolean, default `false` | Version URLs. Per-PR previews are feature 020. |

| `site` | the site block below | |

**GitHub Pages**

| Field | Type | Rule |
|---|---|---|
| `provider` | `"github-pages"` | |
| `mode` | `"pages-workflow"` | |
| `site` | the site block below | `entry` refused |

**The site block (`target.site`)**: how the deploy job builds the site, set by design from detection. It is in `app.buildContext`.

| Field | Type | Rule |
|---|---|---|
| `tool` | `"node"`, `"hugo"` or `"none"` | `none`: the files are in the repository as they are. |
| `packageManager` | `"npm"`, `"pnpm"`, `"yarn"` or `"bun"` | Required with `node`, refused otherwise. |
| `nodeVersion` | a version such as `24` or `22.12` | With `node`: as the app declares it, else OpsCrew's default. |
| `command` | a command line | The build command. Required with `node` and `hugo`, refused with `none`. |
| `outputDir` | a repository path | The folder of static files that is uploaded. |
| `entry` | a repository path | Cloudflare with `render: "ssr"` only, and required there: the Worker module the adapter builds. |
| `compatibilityFlags` | Cloudflare compatibility flags (`^[a-z0-9_]+# Data model: Server-less targets

## Plan targets (`plan.target`)

**Cloudflare Workers with static assets**

| Field | Type | Rule |
|---|---|---|
| `provider` | `"cloudflare-workers"` | |
| `mode` | `"workers-assets"` | |
| `worker` | string (Worker name rules: lower case, digits, `-`, up to 63) | Defaults to the app's name. Unique in the account. Another environment is `<app>-<env>`. |
| `render` | `"static"` or `"ssr"` | `ssr` only with a supported adapter (detected or added by `adapt`). |
| `notFound` | `"single-page-application"`, `"404-page"` or `"none"` | Defaults: SPA for a single-page app, `404-page` for a static site with a `404.html`. |
| `workersDev` | boolean, default `false` | The `workers.dev` address. |
| `previewUrls` | boolean, default `false` | Version URLs. Per-PR previews are feature 020. |

| `site` | the site block below | |

**GitHub Pages**

| Field | Type | Rule |
|---|---|---|
| `provider` | `"github-pages"` | |
| `mode` | `"pages-workflow"` | |
| `site` | the site block below | `entry` refused |

**The site block (`target.site`)**: how the deploy job builds the site, set by design from detection. It is in `app.buildContext`.

| Field | Type | Rule |
|---|---|---|
| `tool` | `"node"`, `"hugo"` or `"none"` | `none`: the files are in the repository as they are. |
| `packageManager` | `"npm"`, `"pnpm"`, `"yarn"` or `"bun"` | Required with `node`, refused otherwise. |
| `nodeVersion` | a version such as `24` or `22.12` | With `node`: as the app declares it, else OpsCrew's default. |
| `command` | a command line | The build command. Required with `node` and `hugo`, refused with `none`. |
| `outputDir` | a repository path | The folder of static files that is uploaded. |
), default `[]` | Cloudflare with `render: "ssr"` only: what the adapter needs (`nodejs_compat` for Nuxt; `nodejs_compat` and `global_fetch_strictly_public` for Next.js through OpenNext). |

The app's `env` entries reach the build job as environment variables from GitHub secrets. On Cloudflare with SSR, they also reach the Worker with `wrangler secret bulk`. Design warns when a secret's name has a framework's public prefix (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `NUXT_PUBLIC_`): its value ends up in the published files.

**Plan-wide rules for both** (checked next to localhost's):
- `dns.provider` is `cloudflare`, with a domain.
- **No server parts:** no `services`, no processes beyond `web`, no cron, no `storage.sqlite`, and no server-only `security` settings.
- **The runner:** `environment.runner` is `github`, or `local` for a localhost environment only.
- **GitHub Pages only:**
  - `dns.proxied` is `false`;
  - the app is static;
  - one Pages environment per repository.
- **Retarget:** refused.

**Fixes:**
- `onServer` is true only for the cloud and own targets;
- `withTargetDefaults` leaves the new targets alone.

## The running version (read, never stored)

The deploy job runs in GitHub Actions and never writes `plan.yaml`, so OpsCrew reads the running version from the provider each time:

| Fact | Target | Read from |
|---|---|---|
| The version running, and the one before | Cloudflare | the Worker's deployments (the latest at 100%, then the one before it) |
| The build a version came from | Cloudflare | the version's message, `opscrew <run id> <sha256>`, written by the deploy job |
| The run that published the site, and the successful one before | GitHub Pages | the Pages deployments and the Pages workflow's runs |

`status` shows them and the rollback command for the one before. A promotion reads the source environment's running version for its run id and build SHA-256.

## The Pages plan (`pages-apply`)

| Field | Rule |
|---|---|
| `enabled` | Pages with `build_type: "workflow"`. |
| `cname` | The app's domain. It is set before the DNS records exist, set again once GitHub sees the records valid (so GitHub requests its certificate), and cleared only after the records are deleted. While a DNS record points at GitHub, this site claims the domain. |
| `httpsEnforced` | Set once GitHub reports the certificate. |

The Pages plan is the change from the site GitHub reports to these fields, in steps (create, set `cname`, enforce HTTPS, or the reverse on destroy). Its SHA-256 hash covers the canonical JSON of the steps; the new hash-bound approval kind `pages-apply` approves it, and a plan that deletes the site needs `allowDestroy`. Applying re-reads the site and refuses when it no longer matches what was planned.

## DNS records for GitHub Pages (IaC)

| Name | Records |
|---|---|
| The apex | A 185.199.108-111.153 and AAAA 2606:50c0:8000-8003::153, DNS-only |
| A subdomain | CNAME `<owner>.github.io`, DNS-only |
| `www` (when on) | CNAME `<owner>.github.io`, DNS-only |
| `_github-pages-challenge-<owner>.<domain>` | TXT from GitHub's verification page; kept on destroy unless asked |

## Generated files (in the repository)

| File | Target | Content |
|---|---|---|
| `opscrew/cloudflare/wrangler.jsonc` | Cloudflare | Name, compatibility date, assets directory, main entry (SSR), `not_found_handling`, `run_worker_first` (SSR), `workers_dev`, `preview_urls` |
| `<output>/_headers` (written at build) | Cloudflare | OpsCrew's security headers for static responses |
| `opscrew/cloudflare/headers-entry.js` | Cloudflare SSR | A wrapper that sets the same headers on the Worker's responses (as the spike settles) |
| `.github/workflows/opscrew-deploy*.yml` | both | The build and deploy jobs |

## Apps in a repository (US6)

The repository's first app has no key and keeps today's paths and names. A further app has a key (`app.key`, the same rules as an environment name: `^[a-z][a-z0-9-]{0,15}$`, never `prod` or `production`). Its environments nest inside it.

| Item | First app (prod / `<env>`) | Further app `<key>` (prod / `<env>`) |
|---|---|---|
| Artefacts folder | `opscrew/` / `opscrew/environments/<env>/` | `opscrew/apps/<key>/` / `opscrew/apps/<key>/environments/<env>/` |
| Local state | `.opscrew/` / `.opscrew/environments/<env>/` | `.opscrew/apps/<key>/` / `.opscrew/apps/<key>/environments/<env>/` |
| User-level files | `~/.opscrew/projects/<id>/` / `…/environments/<env>/` | `~/.opscrew/projects/<id>/apps/<key>/` / `…/apps/<key>/environments/<env>/` |
| `architecture.json`, `ARCHITECTURE.md` | `opscrew/` (shared by its environments) | `opscrew/apps/<key>/` (shared by its environments) |
| `SECURITY_SCAN.md`, `scan.json` | `opscrew/`, `.opscrew/` | the same files: one scan of the repository |
| `infra.dir` | `opscrew/infra/prod` / `opscrew/infra/<env>` | `opscrew/infra/<key>` / `opscrew/infra/<key>-<env>` |
| Workflow file | `opscrew-deploy.yml` / `opscrew-deploy-<env>.yml` | `opscrew-deploy-<key>.yml` / `opscrew-deploy-<key>-<env>.yml` |
| Workflow name | `OpsCrew deploy` / `OpsCrew deploy (<env>)` | `OpsCrew deploy <key>` / `OpsCrew deploy <key> (<env>)` |
| Deploy secret prefix | `OPSCREW_` / `OPSCREW_<ENV>_` | `OPSCREW_<KEY>_` / `OPSCREW_<KEY>_<ENV>_` |
| GitHub environment | `production` / `<env>` | `<key>-production` / `<key>-<env>` |
| GHCR image | `ghcr.io/<owner>/<repo>` | `ghcr.io/<owner>/<repo>/<key>` |
| Branches OpsCrew opens | `opscrew/prepare-deploy`, `opscrew/deploy-setup` | `opscrew/prepare-deploy-<key>`, `opscrew/deploy-setup-<key>` |
| Concurrency group | `opscrew-deploy` / `opscrew-deploy-<app.name>` | `opscrew-deploy-<app.name>` |
| `app.name` (resource names) | from detection / `<app>-<env>` | `<key>` by default / `<key>-<env>` |
| `dependabot.yml` | one file for the repository, covering every app's folders | the same |

**Uniqueness:** OpsCrew derives every name above for every app and environment in the repository. `app add` and `env add` refuse a key or a name whose derived names equal existing ones, naming the clash; for example, a further app `docs` beside a first app's environment `docs` gives the same secret prefix. `appsOf(root)` lists the first app (when `opscrew/plan.yaml` or `opscrew/requirements.yaml` exists), then every `opscrew/apps/*/`.
