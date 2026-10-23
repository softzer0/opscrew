---
description: "Tasks for 016-serverless-targets"
---

# Tasks: Server-less targets: Cloudflare Workers with static assets and GitHub Pages

**Input**: `specs/016-serverless-targets/`:
- spec.md, plan.md, research.md (R1–R3 and the open items 1–13), data-model.md;
- contracts/targets.md, quickstart.md;

plus `docs/adr/0019-serverless-targets.md`, and features 000–015.

**Numbering**: T1601–T1699.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- **Fixtures** never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with `materializeFixture()`.
- **No network:** no test touches the network, a real cloud, a real GitHub or a model. Tests that need Docker, `tofu`, `terraform` or `node` tools skip with a clear message when the tool is absent.
- **No leaks:** no Cloudflare token, deploy token, app secret or generated value appears in a plan, IaC state, a workflow file, the generated wrangler config, a log, an audit entry, a report, a snapshot or an MCP response (SC-1602). Every task's tests include a leak check for the values it handles.
- **Approvals:** every change goes through its plan, approved by its hash:
  - the Worker's shell, its custom domains and every DNS record: `iac-apply`;
  - the `www` redirect rule: `cloudflare-apply`;
  - the GitHub Pages site: `pages-apply` (new, T1601a);
  - promotions and rollbacks: `promote`.

  Deploy secrets go through `github-secrets`.
- **Servers are untouched:** a server target's rendered output and behaviour stay byte-identical (snapshots).
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** write long files with the Write or Edit tool, not shell heredocs (Windows Defender blocks some).
- **Neutral examples only:** `example.com`, `docs.example.com`, `example-app`.

## Phase 1: Foundation

- [ ] T1601a Contracts: the two targets, the site block, their checks, `onServer` and `withTargetDefaults`, and the `pages-apply` approval kind, in `packages/plan-schema/**`, `packages/contracts/**`, `packages/core/src/approvals.ts`, and every reader and writer of the changed types
  - Owns: those paths (+ the generated JSON schema, tests and fixtures); the `switch`/`if` sites on `target.provider` across packages, for a branch where the meaning is clear or a plain refusal only
  - Reads: data-model.md "Plan targets", "The site block", "The Pages plan"; contracts/targets.md "plan-schema"; plan.md "1."; ADR 0019
  - Depends: —
  - Accept:
    - **`CloudflareWorkersTargetSchema`:**
      - `provider: "cloudflare-workers"` and `mode: "workers-assets"`;
      - `worker`: the Worker name rules, "lower case, digits, `-`, up to 63" (`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`). It is required: design writes `app.name`, which is already `<app>-<env>` for another environment;
      - `render`: `"static"` or `"ssr"`;
      - `notFound`: `"single-page-application"`, `"404-page"` or `"none"`;
      - `workersDev`: boolean, default `false`; `previewUrls`: boolean, default `false`;
      - `site`.
    - **`GithubPagesTargetSchema`:** `provider: "github-pages"`, `mode: "pages-workflow"`, `site`.
    - **`SiteSchema`**, with data-model.md's rules quoted in the messages:
      - `tool`: `"node"`, `"hugo"` or `"none"`;
      - `packageManager` (`"npm"`, `"pnpm"`, `"yarn"`, `"bun"`): "Required with `node`, refused otherwise";
      - `nodeVersion` (a version such as `24` or `22.12`): with `node` only;
      - `command` (a command line): "Required with `node` and `hugo`, refused with `none`";
      - `outputDir`: a repository path;
      - `entry` (a repository path): "Cloudflare with `render: "ssr"` only, and required there".
    - **The unions:** `DeployTargetSchema` and `DeployProviderSchema` gain both. Neither joins `VpsProviderId`.
    - **The plan's rules for both** (`checkServerlessTarget`, next to `checkLocalhostTarget`). Each refusal names why and the fix:
      - `dns.provider` is `cloudflare`, with a domain;
      - Cloudflare: `dns.proxied` is `true` (a custom domain is always behind Cloudflare);
      - GitHub Pages:
        - `dns.proxied` is `false` ("Cloudflare's proxy stops GitHub from issuing and renewing the site's certificate");
        - `security.wafCustomRules` is `false` (the hostnames are DNS-only, so Cloudflare's WAF never sees their traffic);
      - no `services`, `processes.workers`, `processes.cron` or `storage` (SQLite or a bucket); each message names the part that needs a server;
      - no `app.releaseCommand`, no `portainer`, and `supplyChain.sign` false (no image);
      - no `retarget` ("moving to and from server-less targets comes with retarget anywhere").
    - **`onServer` becomes a positive list:** true only for `hetzner`, `digitalocean` and `own`. A `server` or `host` runner is refused with both targets, and `local` stays refused (localhost only).
    - **`withTargetDefaults`** fills the image for the cloud targets only, by a positive test.
    - **`pages-apply`:**
      - in contracts' `ApprovalKind`, and in core's `APPROVAL_KINDS` with `satisfies`;
      - hash-bound, with its texts in `HASH_BOUND` (`noHash`, `notApproved` with the `--approve <hash>` hint, `destroyNotApproved`), as a destroying kind;
      - never granted by `--yes`.
    - **Every `switch` on `target.provider`** compiles with `satisfies never`.
      - Each gets a branch where the meaning is clear: no price, no region, no server type, no image architecture, no host plan.
      - Otherwise it gets a plain refusal naming what's missing ("not available for Cloudflare hosting yet"). The later tasks replace those.
      - Retarget refuses both targets.
    - **Tests:**
      - each refusal with its message;
      - round-trips of a static Cloudflare plan, an SSR Cloudflare plan and a GitHub Pages plan;
      - `onServer` for every provider;
      - `pages-apply`'s texts, and that `--yes` never grants it.
  - Verify: `pnpm turbo run typecheck test --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [ ] T1601b [P] Pins: the actions and tools the new workflows run, in `packages/iac-templates/src/pins.ts`, `packages/iac-templates/scripts/**`
  - Owns: those paths (+ tests)
  - Reads: research.md R1 "Deploy", R2 "Deploy"; plan.md "Technical Context"
  - Depends: —
  - Accept:
    - **`ACTIONS` gains,** each as `owner/repo@<40-hex commit> # vX.Y.Z` like the existing entries:
      - `wranglerAction` (`cloudflare/wrangler-action`, v4);
      - `setupNode` (`actions/setup-node`), `setupBun` (`oven-sh/setup-bun`);
      - `uploadArtifact` and `downloadArtifact` (`actions/upload-artifact`, `actions/download-artifact`);
      - `configurePages` (v5), `uploadPagesArtifact` (v4) and `deployPages` (v4).
    - **Tools:**
      - `wrangler`: the npm version given to the action's `wranglerVersion`;
      - `hugo`: the extended `linux-amd64` release, with its URL and SHA-256 from the release's checksums file.
    - **`update-pins.mjs`** learns each one the way it learns today's: a tag resolved to its commit, npm's latest for Wrangler, Hugo's checksums file. Run it once and commit the real values.
    - **Tests:** the format checks the existing pins have, and `update-pins.mjs` parsing a fake release and checksums file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: medium

## Phase 2: Spike (lead)

- [ ] T1602 The spike (lead): research.md's open items 1–13, in the e2e Cloudflare zone and the throwaway repositories (GitHub Pages on the public one, `OPSCREW_E2E_GITHUB_REPO_C`). The results go into research.md as "Spike results", one line per item: what was run, and what was seen. They decide the open details of T1603–T1609, and any finding that changes a design goes back into plan.md before wave 2.
  - The e2e Cloudflare token needs the Workers permissions first (item 3 names them). That token edit is the founder's.

## Phase 3: Packages (parallel)

- [ ] T1603 [P] [US1] [US2] [US4] The Cloudflare connector: Workers versions, deployments, custom domains, the token's Workers permissions, and the redirect phase in the shared rules, in `packages/connectors/cloudflare/**`
  - Owns: that path (+ tests and fakes)
  - Reads: contracts/targets.md "The Cloudflare connector"; research.md R1 and "Spike results" 1–3, 9, 10, 12; plan.md "4."
  - Depends: T1601a, T1602
  - Accept:
    - **The methods in the contract,** zod-checked:
      - `listWorkerVersions`, which carries each version's message (`opscrew <run id> <sha256>`, item 9);
      - `listWorkerDeployments`;
      - `deployWorkerVersion` (100%);
      - `listWorkerCustomDomains`;
      - `workersPermissions`, and `deleteWorker` if the spike shows destroy needs it outside IaC.

      A 404 for a Worker is `undefined`.
    - **The permission list** (shown by `init` and the guide) gains the Workers permissions the spike found. Each is marked "only for Cloudflare hosting", and the deploy token's permissions are listed separately.
    - **The shared rules adapter** (011) takes the Single Redirect phase (`http_request_dynamic_redirect`) for one app's `www` → domain rule, as item 12 settles. Its ownership, drift and destroy work as they do for the other phases.
    - **Errors:** a 403 names the missing permission and never prints the token.
    - **Tests:** the fake covers every endpoint: a 404, a 403, two versions with messages, and the redirect rule's create, drift and delete.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare` and `pnpm lint`
  - Effort: high

- [ ] T1604 [P] [US3] [US4] The GitHub connector: Pages, its health, its deployments, re-running a run, and the Pages permission, in `packages/connectors/github/**`
  - Owns: that path (+ tests and fakes)
  - Reads: contracts/targets.md "The GitHub connector"; research.md R2 and "Spike results" 7, 13; plan.md "5."
  - Depends: T1601a, T1602
  - Accept:
    - **The methods in the contract,** zod-checked:
      - `getPages` (`undefined` on 404), `createPages` (`build_type: "workflow"`), `updatePages` (`cname`, with `null` removing it, and `https_enforced`), `deletePages`;
      - `pagesHealth`, `latestPagesDeployment`, `rerunWorkflowRun`. Earlier Pages runs come from the existing `listWorkflowRuns`;
      - `pagesAllowed(owner, repo)`: whether the repository's plan allows Pages, as item 13 settles.
    - **`GITHUB_TOKEN_PERMISSIONS`** gains Pages (Read and write), marked as needed only for GitHub Pages, plus anything else the spike found these calls need. It lists only what the code calls.
    - **Errors:** a 403 names the missing permission. A 422 when enabling Pages on a private repository without a plan for it says what GitHub needs.
    - **Tests:** the fake covers every endpoint: Pages absent, Pages on from a branch (`legacy`), the certificate pending and issued, a re-run, a 403 and a 422.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github` and `pnpm lint`
  - Effort: high

- [ ] T1605 [P] [US1] [US3] IaC: the `cloudflare-workers` module, its root, and the `cloudflare-dns` module's GitHub Pages mode, in `packages/iac-templates/modules/cloudflare-workers/**` (new), `packages/iac-templates/modules/cloudflare-dns/**`, `packages/iac-templates/src/infra/**`
  - Owns: those paths (+ tests, snapshots); `packages/iac-templates/src/index.ts` for the new exports only
  - Reads: data-model.md "DNS records for GitHub Pages"; research.md R1 "IaC", R2 "Custom domain" and "Spike results" 1, 2, 7; plan.md "6."
  - Depends: T1601a, T1602
  - Accept:
    - **The `cloudflare-workers` module:**
      - `cloudflare_workers_script` with a placeholder ES module that answers "not deployed yet". It has `keep_assets` and `keep_bindings`, and `lifecycle.ignore_changes` on what Wrangler owns, as spike item 1 settled. A later apply leaves the deployed code and assets alone.
      - The `workers.dev` address and preview URLs follow `workersDev` and `previewUrls`, through the resource the spike found.
      - One `cloudflare_workers_custom_domain` per hostname (the domain, and `www` when on).
      - No `secret_text` or other secret binding anywhere (a test greps the module).
      - It validates under `tofu` and `terraform`.
    - **The root:** `rootModule` builds a root for `cloudflare-workers`, and one for `github-pages` with only the DNS module. Server roots are byte-identical (snapshots).
    - **The `cloudflare-dns` module's GitHub Pages mode,** all records DNS-only:
      - the apex: four A records 185.199.108.153–185.199.111.153 and four AAAA records 2606:50c0:8000::153–2606:50c0:8003::153;
      - a subdomain: a CNAME to `<owner>.github.io`;
      - `www` when on: a CNAME to `<owner>.github.io`;
      - the verification TXT record `_github-pages-challenge-<owner>.<domain>`, with its value as an input (not a secret), in a small root of its own that `rootModule` returns next to the site's. Destroying the site's root then keeps it, and only `--delete-verification` destroys that root (T1610b);
      - CAA allowing `letsencrypt.org` when OpsCrew manages CAA (014).
    - **Tests:** snapshots of both roots and the Pages mode for an apex and a subdomain; both engines validate; no secret in any rendered file.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

- [ ] T1606 [P] [US1] [US2] [US3] [US5] The deploy workflows for both targets, and the generated wrangler config, `_headers` and the SSR headers wrapper, in `packages/iac-templates/src/workflow/{cloudflare-workers,github-pages}.ts` (new), `packages/iac-templates/src/serverless/**` (new), and the dispatch in `packages/iac-templates/src/workflow/index.ts` and `packages/iac-templates/src/render.ts`
  - Owns: those paths (+ tests, snapshots); `packages/iac-templates/src/index.ts` for the new exports only
  - Reads: data-model.md "The site block", "Generated files"; plan.md "7."; research.md R1 "Deploy", "Operations", R2 "Deploy" and "Spike results" 4, 5, 6, 9, 11
  - Depends: T1601a, T1601b, T1602
  - Accept:
    - **The build job** (both targets, no image):
      1. checkout;
      2. the site's tool: Node with `setupNode` at `site.nodeVersion` (and `setupBun` for Bun, or the pinned pnpm or Yarn installed as the generated Dockerfiles do), Hugo from its pinned tarball with the checksum checked, or nothing for `none`;
      3. the install with the lockfile, and `site.command` in `app.buildContext`, with the app's `env` names as environment variables from GitHub secrets;
      4. **a limit check** before any upload: over 20,000 files (Cloudflare's free plan) or 1 GB (GitHub Pages) fails with the limit named;
      5. the output (`site.outputDir`, plus the `site.entry` bundle for SSR) uploaded as an artifact, with the build's SHA-256: the SHA-256 of a manifest of the sorted lines `<sha256>  <path>`, one per output file.
    - **`renderCloudflareWorkersWorkflow`:**
      - **A following environment** (on `push` to its branch): the build job, then the deploy job.
        1. Wrangler through `wranglerAction` with `wranglerVersion`, with the deploy token and the account id from GitHub secrets.
        2. `_headers` is written into the output.
        3. `wrangler versions upload` with the committed config and the message `opscrew <run id> <sha256>`.
        4. For SSR, the app's `env` values put on that version from GitHub secrets, in the order spike item 9 settled (`wrangler versions secret bulk` or another), never deploying a version of its own.
        5. `wrangler versions deploy <id>@100`.
        6. A check of the answer on the domain. On failure, the version that ran before is activated again and the job fails.
      - **A promoted environment:** no build job. `workflow_dispatch` takes `run` and `sha256`; the deploy job downloads that run's artifact with `downloadArtifact` (`run-id`, `actions: read`), refuses it unless its SHA-256 matches, then deploys as above.
      - The deploy job's concurrency is `opscrew-deploy-<app>-<env>`, never cancelling, as for servers.
    - **`renderGithubPagesWorkflow`:** the build job, then `configurePages`, `uploadPagesArtifact` and `deployPages` in the `github-pages` environment with `pages: write` and `id-token: write`, and a check of the answer once the certificate exists (a pending certificate is a warning, not a failure).
    - **Generated files (`src/serverless/`):**
      - `renderWranglerConfig(plan)`: `opscrew/cloudflare/wrangler.jsonc` (an environment's own path under `opscrew/environments/<env>/`), with the name, the compatibility date, `assets.directory`, `assets.not_found_handling`, `main` and `run_worker_first` for SSR, `workers_dev` and `preview_urls`. No secret, no account id;
      - `renderHeadersFile(plan)`: `_headers` with OpsCrew's security headers for every path. The site's own `_headers` is merged, its rules kept and placed first;
      - for SSR, `renderHeadersEntry(plan)`: the wrapper module around the adapter's entry that adds the same headers to the Worker's responses, as spike item 5 settled.
    - **`renderDeployment`** dispatches to them. Server targets render byte-identically (snapshots).
    - **Tests:**
      - snapshots: static and SSR on Cloudflare, a promoted Cloudflare environment, GitHub Pages, each with Node and npm, pnpm and Hugo;
      - the generated config parsed as JSONC;
      - the `_headers` merge;
      - no secret value in any rendered file;
      - `actionlint` passes on the workflows where installed.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

## Phase 4: The agents

- [ ] T1607 [US1] [US2] [US3] Design, the interview, the profiles, detection, `init`, and the provision seam, in `packages/agents/src/{design,interview,providers,init}/**`, `packages/agents/src/serverless/index.ts` (new), the dispatch in `packages/agents/src/provision/run.ts`, and the detection of adapters in `packages/detect/**`
  - Owns: those paths (+ tests); the provision dispatch lines only in `provision/run.ts`
  - Reads: spec FR-1602, FR-1610, SC-1606, US1–US3 scenarios 1–2; data-model.md "Plan targets", "The site block"; research.md R1 "Limits", "Frameworks", R2 "Plans", "Limits and terms" and "Spike results" 6, 8, 13; plan.md "8."
  - Depends: T1601a, T1603, T1604
  - Accept:
    - **Detection** (`packages/detect`):
      - the Cloudflare adapters: `@astrojs/cloudflare`, `@opennextjs/cloudflare`, Nitro's `cloudflare_module` preset, `@sveltejs/adapter-cloudflare`;
      - their entry paths, as spike item 6 found;
      - Hugo (`hugo.toml`, `config.toml` with `content/`), a static site with no build (an `index.html` at the root and no package.json), the package manager and Node version;
      - the site's own `_headers`, `_redirects` and `404.html`;
      - long-running server needs the facts already show (WebSockets held open, background work).
    - **Design** offers each target only where it fits (FR-1602, SC-1606), with the reason in one sentence otherwise:
      - **Cloudflare:** static apps, and SSR apps with a supported adapter or one `adapt` can add (T1611). Priced from the providers' published plans with the source named: free, and the paid plan when the interview's expected traffic is above 100,000 requests a day for SSR. It lists the limits (requests a day, 10 ms CPU on the free plan, 20,000 files).
      - **GitHub Pages:** static apps in a public repository, or a private one where `pagesAllowed` says yes. It is free, and it lists 1 GB, a soft 100 GB a month, no headers, no SSR and GitHub's terms (no commercial use).
      - **Neither:** apps with services, workers, cron, SQLite or a bucket, naming the part.
      - **Secrets:** design warns about a secret whose name has a public prefix (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `NUXT_PUBLIC_`). For GitHub Pages, when the app reads any secret, it says the site gets no runtime secrets and anything given to the build ends up in the published files (FR-1605).
      - **A domain whose DNS isn't on Cloudflare:** design offers `domain connect`, as it does for servers.
      - `targetFor` and `optionToPlan` write the target, the `site` block, `worker = app.name`, the `notFound` default (SPA for a single-page app, `404-page` when the site has a `404.html`), and the `dns` rules T1601a checks.
    - **The interview's provider question** offers "Cloudflare (no server)" and "GitHub Pages (no server)" where they fit.
    - **Profiles** next to Portainer's and localhost's, outside `VPS_PROVIDERS` and `vpsConnector`.
    - **`init`:** when either target is in use, it checks the Cloudflare token's Workers permissions (`workersPermissions`), the deploy token, and the GitHub token's Pages permission, naming what's missing and where to add it (FR-1610).
    - **The provision seam:** `serverless/index.ts` exports `provisionCloudflareWorkers` and `provisionGithubPages`, each refusing with "not available yet" until T1608 and T1609. `provision/run.ts` dispatches to them before `requireDockerfile`.
    - **Tests:** design for static-vite, astro-ssr (with and without the adapter), a Hugo fixture and an app with Postgres (refused, with its reason); a private repository without Pages; `init`'s missing permissions.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/detect --concurrency=2` and `pnpm lint`
  - Effort: high

- [ ] T1608 [P] [US1] [US2] Provision for Cloudflare, in `packages/agents/src/serverless/cloudflare/**` (new), `packages/agents/src/serverless/shared.ts` (new)
  - Owns: those paths (+ tests, fakes in `packages/agents/src/testing/serverless.ts` (new)); `provisionCloudflareWorkers` in `serverless/index.ts`
  - Reads: spec US1, US2, FR-1603–FR-1607; plan.md "9."; research.md "Spike results" 1–3, 5, 10, 12; T1605's and T1606's reports
  - Depends: T1603, T1605, T1606, T1607
  - Accept:
    - **The order:**
      1. the token check;
      2. the Worker name: unique in the account (refused when a Worker of that name exists and isn't in this app's state);
      3. a DNS record already at a hostname, refused with its name, as for servers;
      4. the IaC plan (the Worker's shell and custom domains, `iac-apply`);
      5. the `www` redirect rule (`cloudflare-apply`), when `www` is on;
      6. the shared WAF rules as spike item 10 settled;
      7. the deploy secrets (`github-secrets`): the deploy token, the account id, and the app's values;
      8. the generated files and the workflow in the deploy-setup pull request;
      9. the record (`deploymentRecord`).

      Origin TLS, Authenticated Origin Pulls, the host plan and the edge are skipped: there is no origin.
    - **No Dockerfile is needed**, and no image is built or pushed.
    - **An existing deployment:** a second run shows no change. A changed setting (`notFound`, `workersDev`) shows a config change in the pull request and, where IaC owns it, in the plan.
    - **Tests** (fakes: engine, Cloudflare, GitHub):
      - a static and an SSR app end to end, with every approval's hash checked;
      - an existing Worker of another app refused;
      - `www` with its redirect;
      - no secret value in the plan, state, generated files, logs or audit entries.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [ ] T1609 [P] [US3] Provision for GitHub Pages, in `packages/agents/src/serverless/pages/**` (new)
  - Owns: that path (+ tests, fakes in `packages/agents/src/testing/pages.ts` (new)); `provisionGithubPages` in `serverless/index.ts`
  - Reads: spec US3, FR-1603, FR-1606; data-model.md "The Pages plan", "DNS records for GitHub Pages"; research.md R2 and "Spike results" 7, 13; plan.md "9."
  - Depends: T1604, T1605, T1606, T1607
  - Accept:
    - **The checks first:**
      - the repository is public, or `pagesAllowed` says yes;
      - no proxied record and no other record at the hostnames;
      - a CAA record on the domain that doesn't allow Let's Encrypt is refused, naming the record;
      - Pages already on from a branch is shown as a change to the workflow source.
    - **The Pages plan** (`pages-apply`): the steps from the site GitHub reports to `enabled` with `build_type: "workflow"` and `cname` (data-model.md). Its hash covers the canonical JSON of the steps. It is checked by core's safety policy before the approval, as the other typed adapters' plans are, and each change is an audit entry. Applying re-reads the site and refuses if it changed since the plan.
    - **The takeover-safe order:**
      1. the Pages plan (the site, and `cname`);
      2. the IaC plans (`iac-apply`, one per root) for the DNS records and for the verification record;
      3. the workflow pull request.
    - **The verification record:** its value comes as spike item 13 settled, from the API, or else pasted by the user from the page OpsCrew names (an interactive prompt or `--pages-verification <value>`). OpsCrew then prints the one manual step: Verify, with the exact page.
    - **HTTPS:** once `pagesHealth` reports the certificate, `https_enforced` is set through a Pages plan (`pages-apply`), in this run or a later `provision`. Until then, the run says it's pending, when to look again, and to run `opscrew provision` then.
    - **Tests:**
      - an apex and a subdomain end to end;
      - Pages on from a branch;
      - a private repository without Pages refused;
      - a CAA record refused;
      - the order checked on the fakes' call log;
      - every approval's hash.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [ ] T1610a [P] [US4] `verify`, `status`, `drift` and `secure` for both targets, in `packages/agents/src/{verify,status,drift,secure}/**`
  - Owns: those paths (+ tests); the new branches only
  - Reads: spec US4 scenarios 1–3, 5, FR-1608; data-model.md "The running version"; plan.md "10."
  - Depends: T1608, T1609
  - Accept:
    - **verify,** per hostname: DNS, the certificate, an answer, and OpsCrew's headers (Cloudflare; on SSR, also on a server-rendered path). It changes nothing. On GitHub Pages it reports a pending certificate, or an issued one with HTTPS not yet enforced, and then names `opscrew provision`.
    - **status:**
      - **Cloudflare:** the version running and the one before (read, never stored), when each was deployed, the run each came from, the custom domains' state, and the rollback command for the one before.
      - **GitHub Pages:** the site, its certificate state, HTTPS, the last Pages run and the one before.
    - **drift:** the Worker's settings and custom domains against the plan and the IaC state; the Pages settings (`build_type`, `cname`, HTTPS) against the plan; the redirect rule. Each difference says how `provision` puts it back.
    - **secure:** the headers on Cloudflare. On GitHub Pages, the finding "GitHub Pages cannot set security headers", with what it means and that Cloudflare can.
    - **Server targets are unchanged** (the existing tests pass untouched).
    - **Tests:** each command on both targets with fakes, and a drifted custom domain and Pages `cname`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

- [ ] T1610b [P] [US4] [US5] `destroy`, `promote` (promotion and rollback), retarget's refusal, and environments for both targets, in `packages/agents/src/{destroy,promote,environments,retarget}/**`
  - Owns: those paths (+ tests); the new branches only
  - Reads: spec US4 scenarios 4, 6, US5, FR-1608, FR-1609, FR-1611, SC-1604, SC-1605; contracts/targets.md "CLI and MCP"; plan.md "10."
  - Depends: T1608, T1609
  - Accept:
    - **destroy:**
      - **Cloudflare:** the redirect rule, then the custom domains and the Worker by IaC (its secrets go with the Worker), then the GitHub secrets.
      - **GitHub Pages:**
        1. a Pages plan (`pages-apply` with `allowDestroy`): `https_enforced` off and `cname` removed;
        2. the DNS records removed at once by IaC;
        3. Pages deleted.

        The verification record's root stays unless `deleteVerification` is set. No DNS record points at GitHub while no site claims the domain (SC-1605).
      - Both need the typed app name, as today.
    - **promote:**
      - **A Cloudflare promotion** (`deploySource.from: promote`): the source's running version → its run id and SHA-256 from the version's message → the `promote` approval, whose hash covers the target plan hash, both environments, the run id and the SHA-256 → `dispatchWorkflow` with `run` and `sha256`. A version without OpsCrew's message, or an expired artifact, is refused with what to do.
      - **A rollback, any environment:** `version`. On Cloudflare it activates that version of the environment's own Worker through `deployWorkerVersion`. On GitHub Pages it re-runs that run with `rerunWorkflowRun`. Both need a `promote` approval over the target plan hash and the id.
      - **Refused:** `digest` on these targets, `version` on server targets, and promotion on GitHub Pages (each environment builds its own).
    - **retarget:** refused to and from both targets (FR-1611).
    - **Environments:**
      - a server-less app's environments use prod's target;
      - Cloudflare: each environment has its own Worker and hostname;
      - GitHub Pages: only prod (one site per repository), with the reason;
      - a localhost environment beside a server-less prod is refused, naming the framework's own dev server.
    - **Tests:**
      - destroy's order on the fakes' call log, for both targets, with and without `deleteVerification`;
      - a promotion's hash covering the four values;
      - rollbacks on both targets;
      - each refusal.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [ ] T1611 [P] [US2] Adapt playbooks for the SSR adapters, in `packages/agents/src/adapt/**`
  - Owns: that path (+ tests)
  - Reads: spec US2 scenario 2; research.md R1 "Frameworks" and "Spike results" 6; plan.md "11."
  - Depends: T1607
  - Accept:
    - **For an SSR app on the Cloudflare target without its adapter,** `adapt` proposes in its pull request:
      - Astro: `@astrojs/cloudflare` and `adapter: cloudflare()`;
      - Next.js: `@opennextjs/cloudflare` and its config;
      - Nuxt: the `cloudflare_module` preset;
      - SvelteKit: `@sveltejs/adapter-cloudflare`.

      Each is pinned to the version the spike built, with the package manager's lockfile updated by the package manager in the user's checkout, as `adapt` does today.
    - **Static apps** need no change, beyond a note when the output directory is unusual.
    - **No adapter is proposed** for a framework outside the four.
    - **Tests:** the four playbooks against `examples/astro-ssr`, `examples/nuxt-ssr`, `examples/sveltekit-ssr` and a Next.js fixture (snapshots of the proposed diffs).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

## Phase 5: Surfaces, the Docker pass and live tests

- [ ] T1612a [P] The CLI, MCP and the plugin, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`
  - Owns: those paths (+ tests)
  - Reads: contracts/targets.md "CLI and MCP"; plan.md "12."; quickstart.md
  - Depends: T1610a, T1610b, T1611
  - Accept:
    - **The CLI:**
      - `--target cloudflare-workers|github-pages` on `interview` and `env add`;
      - `promote --version <id>`;
      - `destroy --delete-verification`;
      - `provision --pages-verification <value>` if T1609 needs it.

      `status` prints the running version and the rollback command. The interview's next step for these targets names the deploy token.
    - **MCP:**
      - the same inputs on the matching tools;
      - the interview tool's provider help lists every target, localhost included (an existing gap);
      - `pages-apply` is never granted without the user, like the other hash-bound kinds.
    - **The plugin's deploy skill** learns both targets. `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [ ] T1612b [P] The guide, the README and the runbook, in `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1612; contracts/targets.md; research.md R1, R2 and "Spike results"; quickstart.md
  - Depends: T1610a, T1610b
  - Accept:
    - **`docs/guide/cloudflare-hosting.md`:**
      - when to choose it, with static and SSR;
      - the free plan's limits and the paid plan's price, with the source;
      - the deploy token and how to create it;
      - deploys, rollbacks and promotion (the build copied by its SHA-256, the artifact's 90 days);
      - `www`, headers, previews off, and destroy.
    - **`docs/guide/github-pages.md`:**
      - when to choose it, and the plans and public sites;
      - GitHub's terms (no commercial use), no headers, no SSR, the limits;
      - DNS-only, and why;
      - the takeover-safe order;
      - the manual Verify step with its page, HTTPS once the certificate is issued;
      - rollbacks by re-run, and destroy with the verification record kept.
    - **The index and the README's target list** name both. The runbook for these targets covers status, rollback and destroy.
    - No "before X" framing.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: high

- [ ] T1613 [P] The Docker pass, in `packages/cli/test/e2e/**`, `examples/**`
  - Owns: those paths
  - Reads: plan.md "13."; quickstart.md "1."–"3."; research.md "Spike results" 5, 6
  - Depends: T1606, T1611
  - Accept:
    - **With `OPSCREW_DOCKER_TESTS=1`:**
      - **static examples** (static-vite, angular-static, and a new Hugo example): each builds in a container with the generated workflow's build steps, and the output is served from a container with the generated `_headers` applied by `wrangler dev`. OpsCrew's headers are checked on a page and on the 404 or SPA fallback;
      - **SSR:** `examples/astro-ssr` with its adapter builds its bundle, and runs under `wrangler dev` in a container with the generated headers wrapper. A server-rendered page answers with the headers, and a secret given to `wrangler dev` reaches the page without appearing in any output.
    - Every container, image and volume is removed by label afterwards.
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm turbo run test --filter=opscrew -- test/e2e/<the new file>` and `pnpm lint`
  - Effort: high

- [ ] T1614 Live tests, in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md; plan.md "14."
  - Depends: T1612a, T1612b, T1613
  - Accept:
    - **Cloudflare** (`OPSCREW_E2E_CLOUDFLARE_HOSTING=1`), in the e2e zone with `e2e-` hostnames:
      - a static example: provision, deploy, verify (headers), a change, a rollback within a minute (SC-1604), destroy leaving nothing. The time from `provision` to the first answer is logged, and over 10 minutes fails (SC-1601);
      - an SSR example: rendered per request, its secret reaching the app, and the leak search over every output (SC-1602);
      - staging promoted to prod: prod runs staging's build, with the same SHA-256.
    - **GitHub Pages** (`OPSCREW_E2E_GITHUB_PAGES=1`), on the public throwaway repository `OPSCREW_E2E_GITHUB_REPO_C`:
      - Pages on, the custom domain, the certificate, HTTPS enforced;
      - destroy in the takeover-safe order, with no record left pointing at GitHub (SC-1605).

      The certificate wait has a long, logged timeout.
    - **Leftover checks:** the helper scripts learn Workers, custom domains and Pages sites.
    - **The docs:** `docs/e2e.md` sections, and the coverage page's rows as "Not run yet".
  - Verify: `pnpm turbo run typecheck --filter=opscrew` and `pnpm lint`
  - Effort: high

- [ ] T1615 Live runs (lead), after T1614: the passes in `docs/e2e.md`, with the results in `docs/e2e-coverage.md` (its Live results and the status at a glance).

## End-of-feature simplify pass (after T1615)

- [ ] T1616 The end-of-feature simplify pass (lead): duplication across 016's changes, and the items collected during the waves.

## Dependencies

{T1601a, T1601b} with T1602 (lead) alongside → {T1603, T1604, T1605, T1606} → T1607 → {T1608, T1609, T1611} → {T1610a, T1610b} → {T1612a, T1612b, T1613} → T1614 → T1615 → T1616.

**User stories:**
- **US1** (static on Cloudflare): T1601a, T1601b, T1603, T1605, T1606, T1607, T1608, T1613.
- **US2** (SSR on Cloudflare): T1603, T1606, T1607, T1608, T1611, T1613.
- **US3** (GitHub Pages): T1604, T1605, T1606, T1607, T1609.
- **US4** (day-2): T1603, T1604, T1610a, T1610b.
- **US5** (promotion on Cloudflare): T1606, T1610b.

## Parallel waves

1. T1601a, T1601b (and T1602, the lead's spike, once T1601b's pins exist).
2. T1603, T1604, T1605, T1606. Their Owns are disjoint: the Cloudflare connector; the GitHub connector; the modules and `infra/`; the workflows and `serverless/` with the two dispatch lines.
3. T1607.
4. T1608, T1609, T1611: `serverless/cloudflare/`, `serverless/pages/`, `adapt/`. Each fills only its own export in `serverless/index.ts`.
5. T1610a, T1610b: the read-only day-2 commands; destroy, promote, environments and retarget.
6. T1612a, T1612b, T1613.
7. T1614, then T1615, then T1616.

## Implementation strategy

- **MVP:** US1, a static site on Cloudflare: T1601a–T1608 without the SSR parts, then T1610b's destroy.
- **Then:** US2 (SSR), then US3 (GitHub Pages), then US4 and US5.

Each wave is merged, gated and pushed before the next starts.
