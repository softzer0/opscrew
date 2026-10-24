# Host your site on Cloudflare, with no server

Many apps never need a server: a static site, a single-page app that talks to services by URL, or
a server-rendered front end. OpsCrew can host them on Cloudflare (Workers with static assets).
Cloudflare serves the site's files from its edge on your domain, and runs the server-rendered
pages as a Worker. There is no server to rent, patch or pay for.

Nothing changes at Cloudflare or GitHub until you approve the exact plan. OpsCrew shows it with its
SHA-256 hash first, as for every other target.

## When to choose it

- **Static sites:** Astro, Hugo, a Vite or React single-page app, a Next.js static export, Nuxt's
  `nuxt generate` or SvelteKit's static adapter. Static files cost nothing on every plan.
- **Server-rendered apps** with a Cloudflare adapter OpsCrew sets up:
  - Astro (`@astrojs/cloudflare`);
  - Next.js through OpenNext (`@opennextjs/cloudflare`);
  - Nuxt (Nitro's `cloudflare_module` preset);
  - SvelteKit (`@sveltejs/adapter-cloudflare`).

  When the app does not use its adapter yet, `npx opscrew adapt` adds it in a pull request. For
  Next.js it also turns off `cacheComponents` and `partialPrefetching`: with them on, every
  server-rendered request hangs on Workers.

Design does not offer Cloudflare's hosting, and says why, when the app needs a server:
- a database, cache, queue, worker, cron job or SQLite of its own;
- a bucket OpsCrew would create;
- a process that keeps running, such as WebSockets held open or background work;
- server rendering with a framework that has no adapter in the list above.

Services the app reaches by URL, such as a hosted database or an API, keep working. Choose a
[server target](own-server.md) for everything else.

Your domain's DNS must be on Cloudflare: `npx opscrew domain connect <domain>` moves it there (see
[Buying or connecting a domain](domains.md)).

## What it costs

Cloudflare's published Workers plans, as OpsCrew read them on 2026-10-23 from
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/):

| | Workers Free | Workers Paid |
|---|---|---|
| Price | free | at least USD 5 a month per account |
| Included | | 10 million requests a month (then USD 0.30 per million) and 30 million CPU-ms (then USD 0.02 per million) |
| Requests for static files | free and unlimited | free and unlimited |
| Requests to the Worker (server rendering) | 100,000 a day; past them it answers with an error until the next day | as included above |
| CPU time per request | 10 ms | 30 s by default |
| Files per version | 20,000, each at most 25 MiB | 100,000, each at most 25 MiB |

A static site stays on Workers Free whatever its traffic. For a server-rendered app, design offers
Workers Free unless the interview's expected traffic is above 100,000 users a month; then it shows
Workers Paid and its price. The workflow checks the built site against the files per version of the
chosen plan (20,000, or 100,000 on Workers Paid) first, and stops with the limit named.

## The tokens

OpsCrew uses two Cloudflare tokens, and never stores either in your repository:

| Variable | What it does | What to give it |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | OpsCrew's own token on your computer: it creates the Worker and its custom domains, and OpsCrew's rules in your zone | The zone permissions in [The Cloudflare token](security.md#the-cloudflare-token), plus Account → Workers Scripts → Edit, and Zone → Single Redirect → Edit when the site has `www` |
| `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN` | The deploy token: `npx opscrew provision` stores it as a GitHub secret, and the deploy workflow uploads each version with it | Only Account → Workers Scripts → Edit, for the account that holds your domain |

To create the deploy token:

1. Open <https://dash.cloudflare.com/profile/api-tokens> and choose **Create Token** → **Create
   Custom Token**.
2. Under **Permissions**, choose **Account** → **Workers Scripts** → **Edit**.
3. Under **Account Resources**, include the account that holds your domain.
4. Create the token and set `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN` to it in your shell.

The deploy token must be a token of its own: OpsCrew refuses to store `CLOUDFLARE_API_TOKEN` in
GitHub, because that token can edit your DNS. Workers Scripts → Edit is the narrowest permission
Cloudflare offers for deploys, and it also lets the token attach custom domains to Workers in the
account's zones. Keep it only in GitHub's secrets.

`npx opscrew init` and `npx opscrew provision` check both tokens before any change and name each
missing permission.

## Step by step

1. `npx opscrew interview`: choose **Cloudflare (no server)**. In scripts, answer
   `provider: cloudflare-workers` with your `domain` and `dnsProvider: cloudflare`.
2. `npx opscrew design` shows the option with its price and its limits.
3. `npx opscrew adapt`, for a server-rendered app without its adapter: merge its pull request.
4. `npx opscrew provision` checks the tokens, the Worker's name in your account and the DNS records
   at your hostnames (an existing record there is refused, with its name). Then it shows:
   - the **infrastructure plan**: the Worker and a custom domain for each hostname, with no code
     and no secret;
   - the **Cloudflare plan** for OpsCrew's rules in your zone (see [`www`](#www));
   - the deploy secrets it stores in GitHub, by name.

   Then it opens the deploy-setup pull request with the workflow and the Worker's settings.
   Merging it runs the first deploy.
5. `npx opscrew verify` checks each hostname's DNS, certificate and answer, and OpsCrew's security
   headers, and writes `opscrew/RUNBOOK.md`.

In scripts, `npx opscrew provision --plan-only --yes` prints the plans' hashes, and
`npx opscrew provision --approve <hash> --approve <hash> --yes` applies exactly those plans.

Until the first deploy, the Worker answers "Not deployed yet", and `verify` says to merge the pull
request.

## What OpsCrew creates

- **The Worker** `<app>` (`<app>-<env>` for another [environment](environments.md)), and a custom
  domain for each hostname. Cloudflare creates each custom domain's DNS record and certificate
  itself. OpenTofu or Terraform creates the Worker once and never changes its code: the deploy
  workflow uploads it.
- **The Worker's settings** in `opscrew/cloudflare/wrangler.jsonc`, a plain file in your repository:
  - the static files folder;
  - what a path that is no file gets (`target.notFound` in `opscrew/plan.yaml`): the app itself for
    a single-page app (`single-page-application`), the site's own 404 page (`404-page`), or the
    Worker (`none`, for server rendering);
  - preview URLs and the `workers.dev` address, both off.
- **For server rendering**, `opscrew/cloudflare/headers-entry.js`, a small wrapper around the
  adapter's Worker that adds OpsCrew's security headers to its answers.
- **The deploy workflow** in `.github/workflows/`, with Cloudflare's own `wrangler-action` pinned by
  its commit.
- **The deploy secrets** in GitHub: `OPSCREW_CLOUDFLARE_API_TOKEN` (the deploy token),
  `OPSCREW_CLOUDFLARE_ACCOUNT_ID`, and one `OPSCREW_ENV_<NAME>` for each of your app's variables.

## How a deploy works

1. You push to the deploy branch, or run the workflow by hand.
2. GitHub Actions builds the site and checks it against the files per version. For server
   rendering, Wrangler then bundles the Worker with its packages. The build is kept as the
   artifact `opscrew-site`, and its SHA-256 is recorded.
3. The deploy job adds OpsCrew's security headers to the site's `_headers` file, then uploads the
   build as a new version of the Worker. The version's message, `opscrew <run id> <sha256>`, names
   the run and the build. For server rendering, your app's variables go with the version as its
   secrets, from GitHub's secrets: never through a file, a plan or the infrastructure's state.
4. It activates the new version for all traffic and checks that the site answers. When either
   fails, it activates the version that ran before again, and the run fails.

The versions before stay at Cloudflare, so a rollback needs no build.

## Rolling back

```bash
npx opscrew status                                  # the version running, the one before, and the rollback command
npx opscrew promote --to prod --version <id>        # activates that version again
```

`status` reads the Worker's deployments from Cloudflare each time: the version running and the one
before, when each was deployed, the run that built each, and the custom domains' state.
`promote --version` shows the version with the approval's hash and activates it only after your
approval. Cloudflare then serves it for all traffic within a minute, with no build. In scripts, add
`--approve <hash>`; `--yes` never approves a rollback.

### After a secret changed

A version keeps the secret values it was uploaded with. When one of your app's secrets changed
since the version you roll back to was active, Cloudflare refuses to activate it, and so does
OpsCrew: it names the secrets, and nothing changes. If you changed a secret because it leaked,
don't go back to that version: deploy a new one, which gets the current values.

If the old values are still safe, roll back with the secrets the refusal named:

```bash
npx opscrew promote --to prod --version <id> --allow-old-secrets STRIPE_SECRET_KEY
```

The approval then names those secrets and says the version runs with their old values, and its
hash covers them. Only then does OpsCrew ask Cloudflare to activate the version anyway. It still
refuses when Cloudflare names a secret you didn't list.

You can also revert the bad commit and push it: the workflow deploys the reverted code.

## Environments and promotion

Every environment of the app runs on Cloudflare too, each with its own Worker and hostname (see
[dev, staging and prod](environments.md)):

```bash
npx opscrew env add staging --target cloudflare-workers --from main
npx opscrew env set prod --from staging
npx opscrew provision --env staging && npx opscrew provision --env prod
npx opscrew promote --to prod
```

A version belongs to one Worker, so promotion copies the exact build instead:

1. `promote` reads the version staging's Worker runs, and the run and SHA-256 its message names.
2. It checks that GitHub still keeps that build's artifact. GitHub keeps artifacts for the
   repository's artifact retention, 90 days by default. For an older build, `promote` stops before
   any change and says to deploy staging again.
3. It shows the build, both environments and prod's plan hash with the approval's hash. Only after
   your approval does it start prod's workflow with the run and the SHA-256.
4. Prod's workflow checks that the run built the site from a push in this repository (never a
   fork's pull request), downloads the build, and refuses it unless its SHA-256 matches. Then it
   uploads and activates it as above. Nothing is rebuilt.

A required reviewer on prod's GitHub environment still has to approve the run in GitHub.

A copy on your own computer is the framework's own dev or preview server: OpsCrew offers no
[localhost](localhost.md) environment for a site.

## `www`

With `www` on, `www.<domain>` is a custom domain of the Worker too, so it gets its DNS record and
its certificate. OpsCrew's rule **"OpsCrew: redirect www to the domain"** in your zone
(**Rules → Redirect Rules**) sends it to the domain with a 301, keeping the path and the query. It
runs before the Worker, so a request to `www` never costs a Worker request. One rule serves every
OpsCrew app in the zone (Cloudflare's free plan allows 10 such rules per zone). See
[Your domain on Cloudflare](cloudflare.md) for how OpsCrew shares its rules between apps.

## Security headers and your own rules

Every answer carries OpsCrew's security headers: HSTS, `X-Content-Type-Options`,
`X-Frame-Options` and `Referrer-Policy`.
- **Static files:** the headers go into the site's `_headers` file at each deploy, inside the site's
  own `/*` rule when it has one. A header the site sets itself, or removes with `! Name`, stays the
  site's. The site's own `_headers` and `_redirects` rules are kept.
- **Server-rendered answers:** Cloudflare does not apply `_headers` to answers the Worker makes, so
  the wrapper adds the headers where the app set none.

Static files never reach the Worker, so they cost no Worker request. OpsCrew's probe block in your
zone also protects the site's hostnames (see [Your domain on Cloudflare](cloudflare.md)).

## Previews

Cloudflare's preview URLs and the `workers.dev` address are off, so the site answers only on your
domain. To turn either on, set `target.previewUrls` or `target.workersDev` to `true` in
`opscrew/plan.yaml` and run `npx opscrew provision`: its pull request updates the Worker's settings.

## Day 2

- `npx opscrew verify` checks the site and writes the runbook.
- `npx opscrew status` shows the versions and the custom domains.
- `npx opscrew drift` compares the Worker, its settings, its custom domains and OpsCrew's rules in
  your zone with what OpsCrew set up. It changes nothing; `npx opscrew provision` puts them back.
- `npx opscrew secure` checks the headers and writes `opscrew/SECURITY_REPORT.md`.
- The Worker's logs are in the Cloudflare dashboard: **Workers & Pages** → the Worker → **Logs**.
- `npx opscrew retarget` does not move a site to or from a server yet: remove it with `destroy` and
  set it up on the new target.

## Removing the site

```bash
npx opscrew destroy                 # asks you to type the app's name
npx opscrew destroy --confirm <app> # in scripts
```

`destroy` lists what it deletes and asks you to type the app's name. Then, each step after its own
approval and only after the step before succeeded:
1. the app's hostnames leave OpsCrew's rules in your zone (the `www` redirect and the probe block);
   other OpsCrew apps keep theirs;
2. the Worker's custom domains and the Worker are deleted, its secrets with it;
3. the deploy secrets in GitHub are removed.

Running it again continues with what is left. The files in your repository stay, and so does the
deploy token: OpsCrew never deletes tokens, so delete it at
<https://dash.cloudflare.com/profile/api-tokens> if no other app uses it.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) offers Cloudflare's hosting in the interview, and every
plan, rollback and promotion waits for your approval in a dialog.
