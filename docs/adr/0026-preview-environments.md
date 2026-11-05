# ADR 0026: Preview environments: a standing approval, enforced on the preview server

**Status**: Accepted (2026-11-05, feature 022), with constitution 1.7.0. The founder set the scope
on 2026-10-23 (the roadmap's "022 Preview environments per pull request") and gave the go-ahead on
2026-11-05; the design is the lead's, settled by the spike (research R5) and a cross-artefact
review.

## Context

A preview per pull request is created by CI, with nobody at a terminal, so constitution I's "plan,
approve by hash, apply" can't run for each preview. And a pull request's job runs the pull
request's own workflow file (research R1.1): whatever the job can reach, the pull request's author
can reach, even if the workflow OpsCrew wrote never does it. A standing approval checked by the
workflow would be no bound at all.

## Decision

- **D1. A preview environment.** Previews are an environment with `previews` set
  (`opscrew env add preview --previews`), so they reuse environments' files, secrets placement,
  design, provision and destroy. Its server runs one app per pull request, `<app>-pr-<n>`, and runs
  nothing else.
- **D2. The standing approval is the recipe's host plan.** `opscrew provision --env preview`
  installs the recipe on the preview server: the cap, the lifetime, the hostname pattern, the image
  name allowed, the Compose definition of a preview, the seed command and the preview values. Its
  host plan is approved by hash with `allowDestroy` and the typed `<app>-<env>`, stating that CI
  will create, update and delete previews within these bounds without asking again, deleting each
  preview's data when it ends. Changing any bound, or the values, is a new plan and a new approval.
  The rendered recipe, without values, is committed in the repository like every other artefact.
- **D3. Enforced on the server, by a forced command.** The only key in GitHub is restricted
  (`restrict,command=".../opscrew-preview"`); the command accepts `up`, `down` and `list` with
  strictly checked arguments and builds every file of a preview from the approved templates and
  random values. Each request is recorded on the server (`previews.log`) and in the pull request
  (its comment and its deployment). A pull request that edits the workflow can still do only what the recipe allows.
  The unrestricted deploy key stays on the user's computer.
- **D4. Nothing of another environment.** The preview server runs no other environment or app; its
  previews have their own databases, generated values (made on the server) and values (from
  `.env.preview`). Provision refuses while another environment's deploy secrets are repository
  secrets in a repository where GitHub can limit environments to a branch, since a pull request can
  read repository secrets; provisioning that environment again moves them. Where GitHub can't (Free,
  private), every workflow can already read every secret, and the plan says so before the approval.
- **D5. Same-repository pull requests only,** through `pull_request`, never `pull_request_target`;
  forks and Dependabot get no preview.
- **D6. One DNS-only wildcard,** `*.<base>`, created once by the IaC plan, so the job holds no
  Cloudflare token; Caddy on the preview server gets each preview's certificate.
- **D7. Cleanup without anyone:** `down` on close or merge, a cron line on the server for idle
  previews, and each run deletes images of pull requests no longer open.

## Consequences

- Constitution I gains a bullet (1.7.0): a standing approval is allowed when an approved plan
  names every bound, the bounds are enforced on the target itself, each action under it is
  recorded, and it reaches no other environment's servers or data, nor its secrets where the code
  host can keep them apart.
- Anyone who can push a branch can run code on the preview server and read the preview values; the
  guide says to give previews test keys only.
- Previews are public (with `noindex`) and DNS only: the preview server's address is visible, and
  it holds nothing of prod's.
- Let's Encrypt's 50 new certificates a week per registered domain bound how many new previews a
  week get a certificate at once; Caddy falls back to ZeroSSL.
- A pull request that needs a new service previews without it until the recipe is changed.

## Alternatives considered

- **An approval per preview:** someone would have to approve each pull request's preview; previews
  would stop being automatic.
- **Bounds checked in the workflow:** the pull request can edit the workflow.
- **`pull_request_target` for forks:** it runs with secrets; building a fork's code there is the
  "pwn request" GitHub warns against.
- **A Cloudflare token in the job for per-preview records:** a token can't be limited to some names,
  so it could rewrite prod's records.
- **Proxied preview names:** names below the app's hostname need Advanced Certificate Manager; first-
  level names (`pr-12-shop`) would need per-preview records, so the token above.
- **Previews beside prod on its server:** a pull request's code would run next to prod's data.
- **Workers preview URLs for sites:** they run with prod's bindings and secrets, and need an
  account-wide token in the job.

## Amendments

- **2026-11-05, hidden addresses (022 research R6).** D6 changed: the one wildcard, `*.<zone>`,
  is proxied, on a Cloudflare zone used only for previews, and the preview server holds one
  Cloudflare Origin CA certificate for it. Each preview is `pr-<n>-<random>.<zone>`, so no public
  certificate names a preview, the server's address stays hidden, and its web ports accept only
  Cloudflare. Let's Encrypt's weekly limit no longer applies.
- **2026-11-05, two opt-ins (022 research R7, constitution 1.8.0).** Both were asked for by the
  founder.
  - **D4 gains an opt-in.** The user may run previews on another environment's app server, one
    environment named in the plan (`previews.server`), never prod's or any server prod runs on.
    They opt in after a warning that anyone who can push a branch then runs code beside that
    environment's data and secrets, and the recipe's approval repeats it.
  - **D6 gains an opt-in.** The preview domain may be a name below the app's own zone. A
    Cloudflare advanced certificate pack for `*.<domain>` (Advanced Certificate Manager, a paid
    add-on) then keeps previews' names out of public certificates, provided Total TLS is off. The
    domain's cookies are shared with previews, and the user is told so.
  - Without either opt-in, nothing changes: previews get a server and a zone of their own.
