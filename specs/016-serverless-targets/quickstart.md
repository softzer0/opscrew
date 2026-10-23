# Quickstart: validating server-less targets

**Prerequisites:**
- A domain on Cloudflare.
- A Cloudflare token with the zone permissions OpsCrew already uses, plus Workers Scripts: Edit (and whatever the spike adds), with the account id.
- A GitHub token that can change the repository's Pages settings.
- For GitHub Pages, a public repository.

## 1. A static site on Cloudflare (US1, SC-1601)
```bash
npx opscrew analyze && npx opscrew interview   # choose "Cloudflare (no server)"
npx opscrew design && npx opscrew provision      # approve the IaC plan by its hash
# merge the deploy-setup pull request
npx opscrew verify
```
**Expect:**
- the site at `https://<domain>` with OpsCrew's security headers;
- `status` showing the running version;
- under 10 minutes from `provision`, and no cost.

## 2. A server-rendered app on Cloudflare (US2, SC-1602)
Use an Astro app with SSR. Run `adapt` first if it doesn't use `@astrojs/cloudflare` yet, and add an app secret in `.env`.

**Expect:**
- a page rendered per request;
- the secret available to the app;
- the secret nowhere in the run's outputs, files, plans, state or audit entries.

## 3. A static site on GitHub Pages (US3, SC-1603)
Use a public repository and choose "GitHub Pages (no server)".

**Expect:**
- the plan showing Pages with the workflow source, the custom domain, and the DNS-only records with the verification record;
- the site at `https://<domain>` once GitHub's certificate is issued, with HTTPS enforced after it;
- OpsCrew printing the one manual Verify step.

## 4. Day-2 (US4, SC-1604, SC-1605)
```bash
npx opscrew status && npx opscrew drift && npx opscrew secure
npx opscrew promote --to prod --version <previous>     # a rollback, with the id status shows
npx opscrew destroy --confirm <app>
```
**Expect:**
- the rollback answering within a minute;
- destroy leaving nothing at Cloudflare or GitHub, apart from the verification record unless `--delete-verification`.

## 5. Promotion on Cloudflare (US5)
Add staging (`env add staging --target cloudflare-workers --from main`), then `env set prod --from staging`, then provision both.

**Expect:**
- a merged change deploys staging;
- `promote --to prod` makes prod run staging's exact build (the same SHA-256), with no new build;
- GitHub Pages environments refuse promotion, with the reason.
