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
