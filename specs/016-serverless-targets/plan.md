# Implementation Plan: Server-less targets: Cloudflare Workers with static assets and GitHub Pages

**Branch**: `main` | **Date**: 2026-10-23 | **Spec**: `specs/016-serverless-targets/spec.md`
**Research**: `specs/016-serverless-targets/research.md` (R1–R3, open items for the spike)

## Summary

Two new targets for apps that need no server of their own.

**Cloudflare Workers with static assets** (`provider: "cloudflare-workers"`)
- **Static apps:** the site's files are served by Cloudflare at no cost.
- **Server-rendered apps:** apps with a supported adapter (Astro, Next.js through OpenNext, Nuxt, SvelteKit) run their code as a Worker at Cloudflare's edge.
- **Infrastructure:** OpenTofu or Terraform creates the Worker's shell and one custom domain per hostname, through an IaC plan approved by hash. The plan has no code and no secrets.
- **Deploys:** GitHub Actions builds the app and `wrangler` uploads a version and activates it. The app's secrets go from GitHub secrets to the Worker with `wrangler secret`.
- **Rollback:** activates an earlier version of the environment's own Worker by its id, with no build.
- **Promotion:** a version id belongs to one Worker, and each environment has its own. So promotion copies the source's exact build: the target's workflow downloads the build artifact of the run named in the source's running version, checks its SHA-256, and uploads it to the target's Worker. No new build, as with image digests on servers.

**GitHub Pages** (`provider: "github-pages"`)
- Static apps only.
- **The Pages site** (workflow source, custom domain, HTTPS) is a typed GitHub change (a Pages plan), approved by its hash with a new hash-bound kind, `pages-apply`, as `cloudflare-apply` and `stack-apply` are for their adapters.
- **DNS:** the records are DNS-only, through the IaC plan, in a takeover-safe order. The custom domain is set at GitHub before its records exist, and its records are removed right after it goes.
- **The workflow** publishes with GitHub's three Pages actions, pinned.

**Neither target** has a server, a host plan, an edge, components or a self-hosted server runner. Design offers each only where it fits, says why otherwise, and shows the cost and the limits.

## Technical Context

- **Stack:** the same as 000–015.
  - **No new npm dependency** in OpsCrew.
  - Wrangler runs only in the user's GitHub Actions, through Cloudflare's pinned action.
- **External tools, pinned in `pins.ts`:**
  - `cloudflare/wrangler-action` by SHA, and Wrangler's version (R1);
  - `actions/configure-pages`, `actions/upload-pages-artifact` and `actions/deploy-pages` by SHA (R2);
  - `update-pins.mjs` learns them.
- **Providers:** the Cloudflare provider stays `cloudflare/cloudflare ~> 5.27`. There is no GitHub Terraform provider: Pages goes through the typed GitHub connector.
- **API calls:**
  - **Cloudflare (typed connector):**
    - read the Worker's versions and deployments;
    - activate a version;
    - read the custom domains;
    - check the token's Workers permissions.
  - **GitHub (typed connector):**
    - Pages: get, create, update and delete;
    - its health and certificate state;
    - the latest Pages deployment;
    - workflow runs, to re-run one for a rollback.
- **Token permissions, only when the target is used:**
  - **Cloudflare:** account-scoped Workers Scripts: Edit (plus whatever the spike finds for custom domains), and the account id.
  - **GitHub:** Pages: write (to confirm in the spike).
- **To verify in the spike** (T1602): research's open items 1–13.
- **Tests:**
  - fakes for the new connector methods, and snapshots of the new module and workflows;
  - the Docker pass (T1613): the examples built locally for both targets (static output and the SSR bundles), served by `wrangler dev` or a static server in a container;
  - gated live tests (T1614): a static example and an SSR example on Cloudflare in the e2e zone, and a static example on GitHub Pages in the public throwaway repository.

## Constitution Check

- **I (safety gate):**
  - **The Worker's shell and its custom domains:** an `iac-apply` plan approved by hash.
  - **GitHub Pages' settings:** a Pages plan through the typed GitHub connector, checked by core's safety policy and approved by its hash (`pages-apply`, new and hash-bound). Constitution 1.6.0 names the GitHub Pages adapter among those that refuse a plan whose hash differs. Its DNS records go through the `iac-apply` plan.
  - **A rollback on Cloudflare:** activates a version of the environment's own Worker by id, after the `promote` approval. Its hash covers the target plan's hash and the version id.
  - **A promotion on Cloudflare:** dispatches the target's workflow with the source's run id and build SHA-256, after the `promote` approval. Its hash covers the target plan's hash, both environments, the run id and the SHA-256.
  - **Destroy:** needs `allowDestroy` and the typed app name, in the takeover-safe order for Pages.
  - **The deploy itself** runs in the user's GitHub Actions from the reviewed workflow file, as for servers.
- **II (user owns everything):**
  - The generated wrangler config, the module and the workflows are plain files in the repository.
  - A user who stops using OpsCrew keeps a working deploy: `wrangler deploy` with the committed config, or the Pages workflow.
- **III (dual engine):** the new module uses only resources both engines resolve from the same provider. The spike runs both.
- **IV (secrets):**
  - The Worker's secrets go from GitHub secrets to Cloudflare with `wrangler secret` in the deploy job.
  - Never in Terraform: no `secret_text` bindings, so nothing in state. Never in a plan, the wrangler config, a log or an audit entry.
  - The Cloudflare token for the deploy is a GitHub secret.
  - GitHub Pages takes no runtime secrets.
- **V (deterministic first):** target fit, framework and adapter detection, prices and limits are all deterministic.
- **VI (contracts first):** one serial task (T1601a) changes the contracts, recorded in ADR 0019:
  - the two targets;
  - their checks;
  - the site block;
  - the `onServer` and `withTargetDefaults` fixes.
- **VIII (typed adapters):**
  - Cloudflare's versions and the activation go through the typed Cloudflare connector, or the user's workflow.
  - Pages' settings go through the typed GitHub connector.
  - No ad-hoc calls.
- **IX (plain language):**
  - GitHub's terms (no commercial use) and its missing headers;
  - Cloudflare's free-plan limits for SSR, and the paid plan's price;
  - the one manual verification click;
  - why GitHub Pages hostnames stay DNS-only.
- **X (simplicity):**
  - One module, two workflow renderers, two flows. No new npm dependency.
  - GitHub Pages without a Terraform provider.
  - Wrangler only in CI.

## Project Structure

```text
packages/plan-schema/src/        the two targets, their checks, onServer/withTargetDefaults
packages/contracts/src/          the connectors' new method types (ADR 0019)
packages/iac-templates/
  modules/cloudflare-workers/    Worker shell (placeholder module), custom domains
  src/infra/                     the new roots; Pages' DNS records through cloudflare-dns
  src/workflow/                  cloudflare-workers.ts, github-pages.ts renderers; build job without an image
  src/serverless/                the generated wrangler config, _headers, the SSR headers wrapper
  src/pins.ts                    wrangler-action, wrangler, the three Pages actions
packages/connectors/cloudflare/  Workers versions/deployments/custom domains, permission checks
packages/connectors/github/      Pages: get/create/update/delete, health, deployments, re-run
packages/agents/src/
  design/, interview/, providers/  the options, the question, the profiles
  serverless/                    provision for both targets, shared helpers
  verify/, status/, drift/, secure/, destroy/, promote/, environments/  the target branches
  adapt/playbooks/               the SSR adapters
packages/cli, packages/mcp-server, plugin/   flags, interview help (also localhost), texts
docs/guide/                      cloudflare-hosting.md, github-pages.md, index.md
```

## Design

### 1. Contracts and plan (T1601a, serial, lead-reviewed)
- **`CloudflareWorkersTargetSchema`:** `provider: "cloudflare-workers"`, `mode: "workers-assets"`, `worker` (the Worker's name, defaulting to `<app>`), `render: "static" | "ssr"`, `notFound: "single-page-application" | "404-page" | "none"`, `workersDev: false`, `previewUrls: false`.
- **`GithubPagesTargetSchema`:** `provider: "github-pages"`, `mode: "pages-workflow"`.
- **Checks:**
  - Cloudflare DNS with a domain;
  - no components, processes, SQLite or `security` server settings;
  - the runner GitHub-hosted, or local for a localhost environment;
  - GitHub Pages: no proxy (`dns.proxied` false) and render static;
  - retarget refused.
- **Fixes:**
  - `onServer` becomes a positive list of the server targets (cloud, own);
  - `withTargetDefaults` skips the new targets.
- **The site block** (`target.site`, both targets): the build tool, the package manager, the Node version, the build command, the output folder and, for SSR, the Worker entry (data-model.md).
- **The running version** is read from Cloudflare's deployments or GitHub's Pages runs, never stored in the plan: CI's deploys don't write `plan.yaml`.
- **Approval kinds:** one new hash-bound kind, `pages-apply`, which may also allow deleting (the Pages site on destroy), with its refusal texts in `HASH_BOUND`. Rollbacks and promotions on both targets use `promote`.
- **ADR:** 0019.

### 2. Pins (T1601b)
The pins listed under Technical Context, checked against their release sources by `update-pins.mjs`.

### 3. The spike (T1602, lead)
Research's open items 1–13, in the e2e zone and the throwaway repositories. Each result goes into `research.md` "Spike results" before T1605, T1606, T1608 and T1609 start.

### 4. The Cloudflare connector (T1603)
- **New methods:**
  - list a Worker's versions and deployments;
  - activate a version (100%);
  - read custom domains;
  - delete a Worker.
- Every answer is validated with zod.
- **The token check:** `init` and `provision` name each missing permission.

### 5. The GitHub connector (T1604)
- **Pages:** get, create (workflow), update (`cname`, `https_enforced`) and delete.
- **State:** the Pages health check, for the certificate state; the latest Pages deployment.
- **Runs:** re-run a workflow run.
- Every answer is validated with zod.

### 6. IaC (T1605)
- **The `cloudflare-workers` module:**
  - `cloudflare_workers_script` with a placeholder ES module ("not deployed yet": OpsCrew's first deploy replaces it), `keep_assets` and `keep_bindings`, and `lifecycle.ignore_changes` on the code (as the spike settles);
  - `cloudflare_workers_custom_domain` per hostname.
  - Both engines validate it.
- **Roots:** a new root per target in `infra/index.ts`.
- **GitHub Pages' DNS records:** `cloudflare-dns` gets a GitHub Pages mode:
  - the apex's A and AAAA records, or a subdomain's CNAME, and the `www` CNAME, all DNS-only;
  - the verification TXT record;
  - CAA allowing `letsencrypt.org` when the zone has CAA.

### 7. Workflows (T1606)
- **`renderCloudflareWorkersWorkflow`:**
  - **the build job:** checkout, the framework's install and build, and the output (static dir, or the adapter's bundle) uploaded as an artifact;
  - **the deploy job:**
    - `wrangler versions upload` with the committed wrangler config, its message naming the run id and the build's SHA-256 (`opscrew <run id> <sha256>`);
    - `wrangler secret bulk` from GitHub secrets;
    - `wrangler versions deploy <id>@100`;
    - a check of the answer on the domain;
    - on failure, the previous version activated again.
  - **A promoted environment's workflow** has no build job. Its `workflow_dispatch` takes `run` and `sha256`: the deploy job downloads that run's build artifact, refuses it unless its SHA-256 matches, then uploads and activates it as above.
  - The build artifact is kept for the repository's artifact retention (90 days by default). An older build cannot be promoted, and the message says to deploy the source again.
- **`renderGithubPagesWorkflow`:** the build job, configure-pages, upload-pages-artifact, then deploy-pages in the `github-pages` environment, and a check of the answer.
- **Generated files:**
  - the wrangler config (name, compatibility date, assets directory, main entry for SSR, `not_found_handling`, `run_worker_first` for SSR, `workers_dev`, `preview_urls`);
  - `_headers` with OpsCrew's security headers;
  - for SSR, a wrapper entry that sets those headers on the Worker's responses (as the spike settles).

### 8. Agents: design and interview (T1607)
- **The interview:** the provider question offers Cloudflare (no server) and GitHub Pages (no server), each where it fits.
- **Design:**
  - the options, with prices from the providers' published plans: Cloudflare free, and its paid plan when the expected traffic needs it; GitHub Pages free;
  - the limits;
  - the reasons a target isn't offered;
  - `targetFor` and `optionToPlan` branches.
- **Profiles:** next to Portainer's and localhost's.
- **Detection:** the framework's adapter (`@astrojs/cloudflare`, `@opennextjs/cloudflare`, the Nitro preset, `@sveltejs/adapter-cloudflare`), or the static output directory.

### 9. Agents: provision (T1608 Cloudflare, T1609 GitHub Pages)
- **Cloudflare:**
  - the token check;
  - the IaC plan (the Worker's shell and custom domains);
  - deploy secrets (`github-secrets`): a separate deploy token holding only the Workers permissions the spike finds (never OpsCrew's own Cloudflare token, which can edit DNS), the account id, and the app's own values;
  - `www`: a Single Redirect rule to the domain through 011's shared zone rules (`cloudflare-apply`), so static requests never invoke the Worker;
  - the generated files and the deploy-setup pull request;
  - the record.
  - `requireDockerfile` is skipped.
- **GitHub Pages:**
  - the repository's plan check (public, or a plan GitHub allows);
  - the Pages plan (`pages-apply`): Pages with the workflow source and `cname`;
  - then the IaC plan for the DNS records and the verification record;
  - the workflow pull request;
  - once `pagesHealth` reports the DNS valid, the custom domain saved again (`cname` null, then set, about a second apart): GitHub requests the certificate only when the domain is saved with valid DNS (spike result 7);
  - `https_enforced` set once GitHub reports the certificate, through a Pages plan in this run or a later `provision` (`verify` stays read-only and says when to run it);
  - the manual Verify step printed with its page.

### 10. Agents: day-2 (T1610)
- **verify:** per hostname, DNS, the certificate, an answer, and the headers (Cloudflare).
- **status:** the version running and the previous one (Cloudflare); the Pages site and its certificate state.
- **drift:** the Worker's settings and custom domains against the plan; the Pages settings against the plan.
- **secure:** the headers on Cloudflare; the "GitHub Pages cannot set headers" finding.
- **destroy:**
  - Cloudflare: the custom domains, then the Worker, by IaC; its secrets go with it.
  - GitHub Pages: the DNS records removed first, while the site still claims the domain, then `cname` null, then Pages deleted, then its `github-pages` environment. The verification record stays unless `--delete-verification`.
- **promote:**
  - Cloudflare: the source's running version names its run and build SHA-256; the target's workflow is dispatched with them after the `promote` approval. A rollback is `promote --to <env> --version <id>`, an earlier version of the environment's own Worker, activated through the connector.
  - GitHub Pages: promotion refused, with the reason. A rollback is `promote --to <env> --version <run id>`: a re-run of that earlier successful Pages run, after the `promote` approval (its hash covers the target plan hash and the run id).
- **retarget:** refused.
- **environments:** each environment gets its own Worker, or its own Pages site. GitHub Pages allows one site per repository, so a second GitHub Pages environment in the same repository is refused.

### 11. Adapt (T1611)
Playbooks for the SSR adapters: add the adapter and the framework's setting in a pull request, as for every code change. Static apps need no change beyond the output directory.

### 12. Surfaces (T1612)
- **The CLI:** `--target cloudflare-workers|github-pages`, `promote --version`, and `destroy --delete-verification`.
- **The MCP:** the inputs, and the interview help, which also lists localhost.
- **The plugin:** the skill text.
- **The guide:** `cloudflare-hosting.md`, `github-pages.md` and the index.

### 13. The Docker pass (T1613)
Every static example builds to its output, and is served from a container with the generated `_headers` checked. One SSR example (Astro with its adapter) builds its bundle, and runs under `wrangler dev` in a container.

### 14. Live tests and runs (T1614, T1615)
- **Cloudflare:** a static example and an SSR example in the e2e zone: deploy, verify, a change, a rollback, destroy. Plus a promotion between two environments.
- **GitHub Pages:** a static example in the public throwaway repository: Pages on, the custom domain, the certificate, HTTPS enforced, destroy in the takeover-safe order.
- **The leak search** over everything.

## Order

T1601a → T1601b → T1602 (spike) → {T1603, T1604, T1605, T1606} in parallel → T1607 → {T1608, T1609} → T1610 → T1611 → T1612 → T1613 → T1614 → T1615 → T1616.

## Complexity Tracking

None. No principle is bent:
- GitHub Pages gets one hash-bound approval kind of its own, as each typed adapter has, plus the IaC plan;
- Cloudflare's code deploy happens in the reviewed workflow, as servers' deploys do.
