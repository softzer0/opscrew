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
| `cname` | The app's domain. It is set before the DNS records exist and cleared before they are deleted. |
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
