# Publish your site on GitHub Pages

GitHub Pages publishes a static site from your repository's own workflow, on your domain, at no
cost. OpsCrew sets it up: the Pages site, its custom domain, the DNS records on Cloudflare and the
workflow, each change after you approve its plan by its hash.

GitHub Pages has more limits than [Cloudflare's hosting](cloudflare-hosting.md): no security
headers, no server-side rendering, no runtime secrets and no commercial use. It suits open-source
projects and documentation.

## When to choose it

- **The site is static:** Astro, Hugo, a Vite or React single-page app, a Next.js static export,
  Nuxt's `nuxt generate` or SvelteKit's static adapter. A server-rendered app needs
  [Cloudflare's hosting](cloudflare-hosting.md) or a server.
- **The repository is public**, on any GitHub plan. A private repository works only on GitHub Pro,
  Team or Enterprise, and the site is public even then. On GitHub's free plan, GitHub refuses Pages
  for a private repository.
- **The site is not a business:** see [GitHub's terms](#githubs-terms-and-limits).
- **Your domain's DNS is on Cloudflare:** `npx opscrew domain connect <domain>` moves it there (see
  [Buying or connecting a domain](domains.md)).

Design does not offer GitHub Pages, and says why, when the app needs a server (a database, cache,
queue, worker, cron job or SQLite of its own), or renders on the server. When the build is given
secrets, design warns that they end up in the published site.

For a private repository, OpsCrew reads the owner's GitHub plan when the GitHub token holds the
optional Plan: Read permission. Without it, design offers GitHub Pages with a caveat, and if GitHub
refuses, `npx opscrew provision` stops at its first step with nothing changed.

## GitHub's terms and limits

As OpsCrew read them on 2026-10-23 from
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
and [GitHub's terms for Pages](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#pages):

- **No commercial use:** GitHub's terms do not allow GitHub Pages for running a business,
  e-commerce or a commercial SaaS, or for sensitive transactions such as passwords or payments.
- **A site of at most 1 GB.** The workflow checks the built site first and stops with the limit
  named.
- **A soft limit of 100 GB of traffic a month.**
- **Deploys time out after 10 minutes.**
- **No custom response headers.** OpsCrew cannot add its security headers (HSTS,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), and GitHub ignores a `_headers`
  or `_redirects` file. `npx opscrew secure` reports this and says what it means.
- **No server-side rendering and no runtime secrets.** Your app's variables reach only the build,
  and whatever the build puts into the site is public: anyone can read it.
- **No fallback for a single-page app:** a path that is no file gets the site's `404.html`, with the
  status 404.
- **No previews.** One site per repository, so an app on GitHub Pages has prod only.

## DNS only, and why

The site's DNS records on Cloudflare are DNS-only (the grey cloud):
- the apex's A and AAAA records to GitHub Pages' addresses, or a subdomain's CNAME to
  `<owner>.github.io`;
- with `www` (only at the apex), a CNAME for `www`; GitHub redirects between the two itself.

Cloudflare's proxy would stop GitHub from issuing and renewing the site's certificate, so OpsCrew
refuses it for these hostnames. That also means Cloudflare's WAF, and OpsCrew's probe block, never
see the site's traffic.

A CAA record that lets only other certificate authorities issue certificates for the domain would
keep GitHub from Let's Encrypt. `provision` stops before any change and names it.

## The tokens

- **GitHub:** your `GITHUB_TOKEN` also needs **Pages: Read and write** and **Administration: Read
  and write** (GitHub accepts nothing narrower for changing a Pages site), and optionally **Plan:
  Read**. See [The GitHub token](security.md#the-github-token).
- **Cloudflare:** your `CLOUDFLARE_API_TOKEN` with the zone permissions in
  [The Cloudflare token](security.md#the-cloudflare-token), for the DNS records.

## Step by step

1. `npx opscrew interview`: choose **GitHub Pages (no server)**. In scripts, answer
   `provider: github-pages` with your `domain` and `dnsProvider: cloudflare`.
2. `npx opscrew design` shows the option, free, with the limits above.
3. `npx opscrew provision` checks the tokens, the repository's plan, the hostnames and CAA records,
   and asks for the value of GitHub's verification record (see
   [Verify your domain](#verify-your-domain)). Then, in this order, each after its own approval:
   - the **Pages plan**: GitHub Pages turned on, published by the workflow, with your custom
     domain. GitHub Pages already turned on by hand (from a branch) shows as a change to the
     workflow source;
   - the **infrastructure plan** for the site's DNS records, and one for GitHub's verification
     record;
   - the app's values for its build, stored in GitHub, by name;
   - the pull request with the workflow. Merging it publishes the site.
4. Click **Verify** in your GitHub settings (below).
5. `npx opscrew verify` checks each hostname's DNS, certificate and answer, and GitHub's HTTPS, and
   writes `opscrew/RUNBOOK.md`.

In scripts, `npx opscrew provision --plan-only --pages-verification <value> --yes` prints the
plans' hashes (without the value, a run with no terminal stops before any change and says where to
find it), and `npx opscrew provision --pages-verification <value> --approve <hash> … --yes`
applies exactly those plans.

### The takeover-safe order

A DNS record that points at GitHub while no Pages site claims the domain would let anyone's GitHub
Pages site take the domain over. So OpsCrew always sets the custom domain at GitHub before its DNS
records exist, and on removal deletes the records first, while the site still claims the domain.

## Verify your domain

GitHub's domain verification makes the domain usable only by your account's Pages sites, so no one
else can claim it. It has one step GitHub offers no API for, so it is yours:

1. Open <https://github.com/settings/pages> (for a repository an organization owns,
   `https://github.com/organizations/<owner>/settings/pages`), click **Add a domain**, enter your
   domain and copy the TXT record's value GitHub shows. Leave **Verify** for later.
2. Give the value to `npx opscrew provision` when it asks (`--pages-verification <value>` in
   scripts). OpsCrew creates the record `_github-pages-challenge-<owner>.<domain>` on Cloudflare.
3. Once the record resolves, usually within minutes, click **Verify** next to the domain on that
   page. `provision` prints this step with the exact page.

## HTTPS

GitHub serves the site over HTTP at once, and issues its certificate after it has checked the DNS
records, which GitHub says can take up to 24 hours. GitHub's DNS check took about an hour in
OpsCrew's tests, and the certificate came only once OpsCrew saved the domain again (below). Until
then, `npx opscrew verify` and `npx opscrew status` say that the certificate is pending and when to
look again, and the workflow's own check is only a warning.

Run `npx opscrew provision` again once GitHub has checked the DNS records: GitHub requests the
certificate only when the domain is saved with valid records, so OpsCrew saves it again (removing it
and setting it straight back, about a second apart; a verified domain cannot be taken in that
second). Once the certificate is issued, the next `provision` enforces HTTPS through a Pages plan,
and GitHub redirects `http://` to `https://`. `verify` never changes anything itself.

## How a deploy works

1. You push to the deploy branch (a push deploys when it changes a path the site's build reads:
   [When a push deploys your app](when-deploys-run.md)), or run the workflow by hand.
2. GitHub Actions builds the site, checks it against the 1 GB, and hands it to GitHub Pages with
   GitHub's own Pages actions, pinned by their commits.
3. The deploy job publishes it in the `github-pages` environment, then checks that the site answers.

## Rolling back

```bash
npx opscrew status                                  # the last Pages run, the one before, and the rollback command
npx opscrew promote --to prod --version <run id>    # re-runs that earlier run
```

`promote --version` shows the run with the approval's hash and re-runs it only after your approval.
GitHub builds the site again from that run's commit and publishes it, and OpsCrew follows the run
to its end. GitHub re-runs only runs from the last 30 days; for an older version, revert the commit
and push. In scripts, add `--approve <hash>`; `--yes` never approves a rollback.

`promote` without `--version` is refused: GitHub Pages has only prod, which builds its own site;
roll back with `--version <run id>`.

## Day 2

- `npx opscrew verify` checks the site and writes the runbook.
- `npx opscrew status` shows the Pages site, its certificate, HTTPS and the last runs.
- `npx opscrew drift` compares the Pages site, its DNS records and the verification record with
  what OpsCrew set up. It changes nothing; `npx opscrew provision` puts them back.
- `npx opscrew secure` reports the missing headers.

## Removing the site

```bash
npx opscrew destroy                        # asks you to type the app's name
npx opscrew destroy --delete-verification  # also deletes GitHub's verification record
```

`destroy` lists what it changes and asks you to type the app's name (`--confirm <app>` in scripts).
Then, in the takeover-safe order, each step after its own approval:
1. the site's DNS records are deleted, while the Pages site still claims the domain;
2. the custom domain is removed, GitHub Pages is turned off and its `github-pages` environment is
   deleted;
3. the app's values for its build are removed from GitHub.

GitHub's verification record stays, so the domain stays verified for your account. Add
`--delete-verification` to delete it too, in the same run or later on its own. The files in your
repository stay.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md) offers GitHub Pages in the interview, and every plan
and rollback waits for your approval in a dialog. The Verify click stays yours.
