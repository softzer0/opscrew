# Research: Server-less targets

Research of 2026-10-23 (Sonnet for the hosts, Haiku for the code map), from official sources: developers.cloudflare.com, Cloudflare's provider docs, docs.github.com and GitHub's REST docs. Items marked **open** are for the spike (T1602).

## R1. Cloudflare: Workers with static assets

**Decision:** Workers with static assets, deployed by `wrangler` from GitHub Actions. Terraform/OpenTofu owns the Worker's shell and its custom domains.

**Rationale:**
- Cloudflare's Pages docs say "Workers supports most Pages use cases and offers a broader feature set", and the migration guide was updated on 2026-10-12. Pages isn't deprecated, but new work goes to Workers.
- Workers covers static sites and server-side rendering in one product.

**Alternatives considered:**
- **Cloudflare Pages:** it adds domains outside Cloudflare zones, which OpsCrew doesn't need, and Pages Functions for SSR. It's where Cloudflare puts no new work.
- **Uploading assets with Terraform:** the manifest, upload and JWT flow is awkward there.

**The product:**
- Serving: `_headers` and `_redirects` for static responses, and `assets.not_found_handling` (`"single-page-application"`, `"404-page"`). `run_worker_first` sends requests to the Worker first, for SSR.
- `_headers` does not apply to Worker-generated responses: those need headers set in code.
- Static asset requests are free and unlimited. Worker invocations count against the plan.
- Custom domains need the zone on Cloudflare.

**Deploy:**
- `cloudflare/wrangler-action@v4` with Wrangler v4. Pin the action by SHA and `wranglerVersion` (the exact tag is **open**).
- Inputs: `apiToken`, `accountId`, `command`, `secrets`, `wranglerVersion`.
- `wrangler versions upload` creates a version without activating it. `wrangler versions deploy <id>@100` activates it, and `wrangler rollback <id>` goes back to any of the last 100 versions.

**Token:**
- An account-scoped token with **Workers Scripts: Edit**, plus the account id.
- Custom domains may also need **Workers Routes: Edit** and **Zone: Read** (**open**: the minimal set).

**IaC (provider `cloudflare/cloudflare` ~> 5.27, as pinned today):**
- **`cloudflare_workers_script`:** `assets` with its `config`, `content`/`content_file` and `main_module`, `bindings`, `keep_assets`, `keep_bindings`. Its `secret_text` bindings would put values in state, so they are never used. The beta `cloudflare_worker`, `cloudflare_worker_version` and `cloudflare_workers_deployment` resources exist.
- **`cloudflare_workers_custom_domain`:** `account_id`, `hostname`, `service`, `zone_id`. It likely creates the DNS record and the certificate itself, apex included (**open**). Apex and `www` are one resource each, and no conflicting DNS record may exist.
- **Open:**
  - whether a script shell can be created with a placeholder module, the code then owned by wrangler (`lifecycle.ignore_changes`, `keep_assets`, `keep_bindings`), with a later apply not overwriting CI's code;
  - that OpenTofu resolves the provider.

**Limits:**

| | Workers Free | Workers Paid |
|---|---|---|
| Requests | 100,000/day (error 1027 beyond; static asset requests unlimited) | unlimited |
| CPU time per request | 10 ms | 30 s default |
| Workers per account | 100 | 500 |
| Asset files per version | 20,000 | 100,000 |
| Worker size | 64 MiB | 64 MiB |
| Environment variables | 64 | 128 |
| Price | free | about USD 5/month (**open**: confirm from Cloudflare's pricing page for design's price) |

The per-asset size of 25 MiB is **open**.

**Frameworks** (paths **open**, to confirm in the spike's Docker builds):

| Framework | Static path | SSR adapter |
|---|---|---|
| Astro | static output in `dist` | `@astrojs/cloudflare` |
| Vite/React SPA | `dist` with SPA fallback | — |
| Next.js | `output: "export"` (`out`) | OpenNext `@opennextjs/cloudflare` (`.open-next/worker.js`, `.open-next/assets`) |
| Nuxt | `nuxt generate` | Nitro's `cloudflare_module` preset |
| SvelteKit | `adapter-static` | `adapter-cloudflare` |
| Hugo | `public` | — |

**Operations:**
- **Secrets:** `wrangler secret`, from GitHub secrets in the deploy job. Plain variables go in the generated wrangler config.
- **Logs:** `wrangler tail` and Workers Logs.
- **Previews:** preview URLs (`preview_urls`) and `workers_dev` can each be turned off.

## R2. GitHub Pages

**Decision:**
- GitHub Pages for static apps, published from the repository's own workflow.
- Configured through the typed GitHub connector (the REST API), with DNS on Cloudflare as DNS-only records through the IaC plan.

**Rationale:** it's free on public repositories, built into the user's GitHub, and everything except domain verification is available by API.

**Alternatives considered:**
- **Terraform's `github_repository` `pages` block:** its docs could not be read and `https_enforced` is unconfirmed; the typed connector also avoids a new provider.
- **Branch publishing:** the workflow source fits OpsCrew's build.

**Plans:**
- Free personal accounts get Pages for public repositories only. Pro and Team add private ones, but the site is still public; only Enterprise Cloud restricts access.
- Free organizations on private repositories: **open**.

**Deploy:**
- `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4`, `actions/deploy-pages@v4`, pinned by SHA.
- Permissions: `pages: write`, `id-token: write`, `contents: read`.
- The `github-pages` environment is protected to the default branch.
- The artifact must be under 10 GB with no links, and the site under 1 GB. Deploys time out after 10 minutes.

**API:**
- `POST /repos/{o}/{r}/pages` with `build_type: "workflow"`. Whether it works without `source` is **open**.
- `PUT` with `cname` (null removes it) and `https_enforced`. `DELETE` turns the site off.
- The fine-grained permission ("Pages: write", perhaps Administration) is **open**.

**Custom domain:**
- **Records:**
  - a subdomain: a CNAME to `<owner>.github.io`;
  - the apex: A records 185.199.108-111.153 and AAAA 2606:50c0:8000-8003::153;
  - `www`: a CNAME, with GitHub's own redirect.
- **Takeover-safe order:** set `cname` at GitHub before the DNS records exist, and remove the records right after the custom domain is removed or Pages is off.
- **No Cloudflare proxy:** it blocks GitHub's certificate issuance and renewal.
- **CAA** must allow `letsencrypt.org`.
- **HTTPS:** the certificate comes after GitHub's DNS check, and "Enforce HTTPS" can take up to 24 hours to become available.

**Verification:** a TXT record `_github-pages-challenge-<owner>.<domain>`, then a Verify click in the owner's settings. That click has **no API**.

**Limits and terms:**
- A 1 GB site and a soft 100 GB of traffic per month.
- Prohibited: hosting a business, e-commerce or commercial SaaS, and sensitive transactions.
- No custom response headers. A `404.html` SPA fallback works, with status 404. No previews.

**Rollback:** re-run an earlier successful run of the workflow (**open**: confirm it republishes that run's build).

## R3. Code map: where the targets plug in

- **Schema:**
  - one member each in `DeployTargetSchema`, and the provider ids in `DeployProviderSchema`;
  - checks next to `checkLocalhostTarget`;
  - **fix** `onServer` (plan.ts ~506) and `withTargetDefaults` (~1011), which today treat any unknown provider as a server.
- **Design:** options next to `priceLocalhost` and `pricePortainer` (`design/run.ts` ~580), `targetFor` and `optionToPlan`, the interview's provider question, and profiles next to Portainer's and localhost's (not in `VPS_PROVIDERS` or `vpsConnector`).
- **Provision:**
  - a branch in `provision/run.ts` ~283-301, with flows modelled on `portainer-flow.ts`;
  - `requireDockerfile` skipped for these targets;
  - `renderDeployment` dispatching to new renderers.
- **Workflow:**
  - renderers next to `renderPortainerWorkflow`;
  - a build job without an image, the deploy job through `deployJob`;
  - `deploySecretNamesFor`.
- **IaC:**
  - a new module and root in `infra/index.ts` `rootModule`;
  - the Cloudflare provider pin in `hcl.ts`;
  - new pins in `pins.ts` (only cloudflared is pinned among Cloudflare's tools today).
- **Connectors:**
  - Cloudflare: no Workers code today; the permissions list and the init checks;
  - GitHub: no Pages code today.
- **Day-2:** branches in verify, status, drift, secure, destroy and environments; refusals in retarget.
- **Surfaces:**
  - the CLI's interview, destroy and init;
  - the MCP interview help, which also omits localhost today;
  - the guide.
- **Branch sites:** about 134 places in agents switch on `portainer` or `localhost`.

## Open items for the spike (T1602)
1. A Worker shell from OpenTofu and Terraform with a placeholder module, then a `wrangler deploy` from a workflow. Does a later apply leave CI's code and assets alone?
2. Does `cloudflare_workers_custom_domain` create the DNS record and certificate itself, for a subdomain and the apex? How long until HTTPS answers?
3. The minimal token permissions, for both the IaC and the deploy.
4. The exact pins: `wrangler-action`'s SHA and Wrangler's version.
5. SSR headers: does a generated wrapper entry around the adapter's Worker work for Astro's adapter?
6. The build output paths of the SSR adapters (Astro, OpenNext, Nuxt, SvelteKit) in the Docker pass.
7. GitHub Pages:
   - enabling it by API with `build_type: "workflow"` and no `source`;
   - the token permission;
   - setting `cname`, then DNS, then the certificate, then `https_enforced`;
   - the verification record;
   - a re-run as a rollback.
8. Workers' paid plan price, from Cloudflare's pricing page, for design.
9. Secrets with versions: whether `wrangler versions secret bulk` (or another order) puts the app's secrets on the uploaded version before `versions deploy`, without a version of its own being deployed. Version messages: `wrangler versions upload --message` and its length limit (the message `opscrew <run id> <sha256>` is about 85 characters), and reading it back from the versions API, for promotion.
10. Whether the zone's shared WAF custom rules (011) apply to a Worker's custom domain unchanged. If they do, provision keeps the shared-rules step for Cloudflare; if not, design sets `security.wafCustomRules: false` and says why.
11. Downloading another run's artifact in a deploy job (`actions/download-artifact` with `run-id` and the job's token), for promotion.
12. Single Redirect rules (`http_request_dynamic_redirect`) through 011's shared-rules adapter, for `www` to the domain on Cloudflare: the phase, the Free plan's limit, and whether the adapter takes a third phase as it is.
13. How OpsCrew tells, before any change, whether a private repository's owner has a plan that allows GitHub Pages (the user's or the organization's `plan`, or GitHub's answer to enabling Pages), and whether the verification record's value is readable by API or only on the settings page.

## Spike results (T1602, 2026-10-23)

Run in the e2e Cloudflare zone, on a hostname two levels below it, and in the private throwaway repository. Everything was removed afterwards. Items 5–7 and 13 follow.

1. **The Worker shell:** OpenTofu and Terraform 1.16.5 both resolve `cloudflare/cloudflare` 5.28.1 and validate it.
   - OpenTofu created the script with a placeholder module (answering 503), the `workers.dev` toggle and a custom domain in 6 s. `wrangler versions upload` and `versions deploy` then replaced the code and added assets.
   - **`cloudflare_workers_script` needs `lifecycle { ignore_changes = all }`:**
     - With a narrower list, the source map Wrangler uploads (`files`) showed as drift.
     - Any update to the script made Terraform upload a new version (re-sending the code it had read back) and activate it at 100%, with no OpsCrew message on it, so promotion could no longer trace its build.
   - So Terraform creates the shell once and never updates it. The Worker's settings (`observability`, `workers_dev`, `preview_urls`) live in the Wrangler config. A rename needs `replace_triggered_by`.
   - With `ignore_changes = all`, a later plan after a deploy shows no changes.
2. **Custom domains:**
   - `cloudflare_workers_custom_domain` creates its DNS record itself (proxied, read-only), and public DNS answers A and AAAA.
   - Its certificate was valid 153 s after creation, for a hostname two levels below the zone, which Universal SSL doesn't cover.
   - Destroy removes the record.
   - The apex was not tried live: the e2e zone's apex is a real domain. Cloudflare's docs show the apex as an example.
   - A resolver that looked the name up before the record existed keeps a cached "no such name". Live tests therefore wait for the record through DNS over HTTPS, then probe with `--resolve`.
3. **Permissions:**
   - **Cloudflare:** Account → Workers Scripts → Edit is the only permission needed, both for the IaC (the script, the `workers.dev` toggle, custom domains with their DNS records) and for the deploy (`versions upload` with assets and secrets, `versions deploy`, the deployments API for a rollback, reading versions). Wrangler needs nothing else when `CLOUDFLARE_ACCOUNT_ID` is set. The deploy token can therefore also attach custom domains in the account's zones; Cloudflare offers nothing narrower, and the guide says so.
   - **GitHub:** creating, updating and deleting a Pages site, and its health, need **Pages: write and Administration: write** (`x-accepted-github-permissions: pages=write,administration=write`). Reading needs Pages: read.
   - A fine-grained token's `GET /user` has no `plan` without the account permission Plan: read.
4. **Pins:** T1601b. Newer majors of the three Pages actions exist, so T1601c moves to them.
8. **Prices:**
   - **Workers Paid:** a minimum of USD 5 a month per account. It includes 10 million requests (then USD 0.30 per million) and 30 million CPU-ms (then USD 0.02 per million).
   - **Static asset requests** are free and unlimited.
   - **Free:** 100,000 requests a day and 10 ms CPU per request.
   - **Files per version:** 20,000 (Free) or 100,000 (Paid), at most 25 MiB each.
   - Sources: developers.cloudflare.com/workers/platform/pricing and /limits.
9. **Secrets and version messages:**
   - `wrangler versions upload --message "opscrew <run id> <sha256>" --secrets-file <file>` puts the secrets on the uploaded version, as `secret_text` bindings, without a version of their own. `versions deploy <id>@100 -y` then activates it.
   - The message reads back as `annotations["workers/message"]` in both the versions list and a single version (at most 1,000 bytes).
   - `POST …/workers/scripts/<name>/deployments` (`strategy: "percentage"`, one version at 100) rolled back to an earlier version, answering in 1.6 s.
   - In GitHub Actions, `versions deploy` 3.5 s after the upload failed with code 100146 ("version could not be found"). The deploy job therefore waits until `GET …/versions/<id>` answers (2 s in the run that followed).
   - `_headers` applied to static files and the 404 page, not to responses the Worker made.
10. **Shared WAF rules:** a zone WAF custom rule blocked a path on the Worker's custom domain (403) and left the rest (200). Provision keeps 011's shared WAF rule for Cloudflare hosting.
11. **Promotion:**
    - A second workflow run downloaded the first run's artifact (`actions/download-artifact` v8.0.2 with `run-id`, `github-token` and `actions: read`).
    - It matched its SHA-256 (the SHA-256 of the sorted `sha256sum` lines over the files) and deployed it, so the site served exactly that build, with no rebuild.
    - The whole path ran with the pinned `cloudflare/wrangler-action` v4.1.3, the version id taken from its `command-output`.
12. **`www`:**
    - A Single Redirect rule on the Free plan (phase `http_request_dynamic_redirect`, at most 10 rules) sent a second custom domain of the Worker to the first with a 301, keeping the path and the query: `wildcard_replace(http.request.full_uri, "https://<from>/*", "https://<to>/${1}")` with `preserve_query_string`. It runs before the Worker.
    - So `www` is a custom domain of the Worker too, which gives it its DNS record and certificate, and one shared OpsCrew rule lists every app's `www` hostname with the generic target `wildcard_replace(http.request.full_uri, "https://www.*", "https://${1}")` (to confirm in the live run).
    - Deleting a ruleset answers 204 with no body.
5. **SSR headers:**
   - A wrapper module imports the adapter's default export and re-exports everything else (`export *`, then `...worker`). Its `fetch` copies the response and adds OpsCrew's headers where the app set none.
   - With `wrangler dev`, server-rendered pages, endpoints and the Worker's 404s carried them, and a secret given to the Worker reached the page.
   - The same file worked for Nuxt (its `scheduled` handler survived) and Next.js (its Durable Object classes were re-exported).
   - Static files never reach the Worker while `run_worker_first` is off, so they need `_headers` too. Turning it on would make every static request a billed Worker call.
   - **So the Worker gets the wrapper and the static files get `_headers`.** Two `/*` blocks in `_headers` don't combine: the second replaces the first. OpsCrew merges its headers into the site's own `/*` block.
6. **SSR builds** (`node:24` containers, Wrangler 4.152.0):

   | Framework and adapter | Static files | Worker entry | Compatibility flags | Notes |
   |---|---|---|---|---|
   | Astro, `@astrojs/cloudflare` 14.4.2 | `dist/client` | `dist/server/entry.mjs` | none | Needs astro ^7.4.0 (an app on 7.3 needs adapter 14.3 or an upgrade), and `wrangler` in the project. Its own `dist/server/wrangler.json` adds `SESSION` (a KV namespace created at deploy) and `IMAGES`; OpsCrew's generated config leaves them out, and the app ran without them. |
   | Nuxt, Nitro `cloudflare_module` (nitropack 2.13.5) | `.output/public` | `.output/server/index.mjs` | `nodejs_compat` | Exports `scheduled`, `email`, `queue`, `tail` and `trace` on the default object. |
   | SvelteKit, `@sveltejs/adapter-cloudflare` 8.0.1 | `.svelte-kit/cloudflare` | `.svelte-kit/cloudflare/_worker.js` | none | Builds for Cloudflare Pages unless the build sees a Wrangler config with `main` and `assets`, or `WORKERS_CI=1`; that Pages output fails `wrangler deploy`. The entry sits inside the assets folder, excluded by the adapter's `.assetsignore`. The site's own `_headers` goes in the project root. |
   | Next.js 16.4.2, `@opennextjs/cloudflare` 1.20.13 | `.open-next/assets` | `.open-next/worker.js` (1.0 MB gzipped) | `nodejs_compat`, `global_fetch_strictly_public` | Needs `open-next.config.ts` and a Wrangler config to build (or `--skipWranglerConfigCheck`). `opennextjs-cloudflare migrate` waits two minutes for a browser login, so OpsCrew writes both files itself. Next.js 16's default `cacheComponents` and `partialPrefetching` make every server-rendered request hang on Workers; they must be off. |

   - Build times with dependencies installed: 2–17 s.
   - The artifact upload must keep hidden files (`.assetsignore`).
   - npm 11.19 skips install scripts by default (esbuild, workerd); the builds and `wrangler dev` worked anyway.
7. **GitHub Pages** (the public throwaway repository; the certificate, HTTPS, rollback and destroy steps follow):
   - **Turning Pages on:** `POST /repos/{o}/{r}/pages` with only `build_type: "workflow"` and no `source` answered 201. GitHub created the `github-pages` environment itself, its branch policy allowing `main`.
   - **The custom domain:** `PUT …/pages` with `cname` answered 204 before any DNS record existed, so the takeover-safe order works. `https_enforced` then reads false until the certificate exists.
   - **The workflow:** checkout, a build, `actions/configure-pages` v6, `actions/upload-pages-artifact` v5 (with `include-hidden-files: true`, a `.well-known` file kept) and `actions/deploy-pages` v5. With `pages: write`, `id-token: write` and `contents: read`, it published in 39 s.
   - **DNS:** a DNS-only CNAME to `<owner>.github.io` was created at Cloudflare.
   - **The certificate:** `GET …/pages/health` answered 202 while GitHub was still checking.
13. **Private repositories and verification:**
    - On a Free account, enabling Pages on a private repository answers 422 "Your current plan does not support GitHub Pages for this repository", and nothing changes. A fine-grained token's `GET /user` has no `plan` unless it holds Plan: read.
    - So `pagesAllowed` answers "yes" for a public repository, the plan where it can read it, and "unknown" otherwise. Design then offers GitHub Pages with that caveat, and the Pages plan's first step reports GitHub's refusal plainly, with nothing changed.
    - The verification record's value appears only on the owner's settings page (GitHub's docs and REST reference have no endpoint for it), so the user pastes it.
