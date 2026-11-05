# Research: preview environments per pull request (022)

Research from 2026-11-05. Three parts:
- A Sonnet agent read only official sources: GitHub's Actions, environments, deployments and
  packages documentation, Cloudflare's DNS, SSL, Origin CA, API token, Tunnel and Workers pages,
  Let's Encrypt's rate limits, Caddy's documentation, OpenSSH's `sshd(8)`, the preview docs of
  Render, Heroku and Dokploy, and the seed docs of nine frameworks.
- A Haiku agent mapped what OpsCrew already has, with file and line; the lead checked the claims
  the design rests on (the check key's forced command, CAA issuers, image retention, host plans on
  servers OpsCrew creates).
- R4 lists what the spike (T2201) settles before the code depends on it.

"Unconfirmed" marks a fact no fetched official page stated. R1–R2 are findings; R3 holds the lead's
decisions, which the spec builds on.

## R1. Outside facts

### R1.1 Pull requests in GitHub Actions

- `pull_request` runs on `opened`, `synchronize` and `reopened` by default; `closed`,
  `ready_for_review` and others need `types:`. A merge is `closed` with
  `github.event.pull_request.merged`. The job checks out `refs/pull/N/merge`; the head commit is
  `github.event.pull_request.head.sha`.
  https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- **Forks:** "secrets are not passed to the runner when a workflow is triggered from a forked
  repository", and `GITHUB_TOKEN` is read-only (same page). Private repositories can opt in to
  "Send write tokens to workflows from pull requests" and "Send secrets to workflows from pull
  requests"; approval for fork runs can be required from first-time contributors or all outside
  contributors.
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- **`pull_request_target`** runs the base branch's workflow with secrets and a write token, even for
  a fork; checking out the pull request's code there is the "pwn request" GitHub warns against: such
  workflows "must not explicitly check out untrusted code".
  https://docs.github.com/en/actions/reference/security/secure-use,
  https://securitylab.github.com/research/github-actions-preventing-pwn-requests/
- **Dependabot's pull requests** run as if from a fork: a read-only token and only Dependabot
  secrets.
  https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions
- **The workflow file of a same-repository pull request is the pull request's own** (it runs from
  the merge ref), so anyone who can push a branch can change what the job does with the secrets it
  can read. (Follows from the two pages above; GitHub's secure-use page says the same of untrusted
  input.)
- **Concurrency:** one running job per group; `cancel-in-progress: true` cancels the running one.
  `schedule` runs only on the default branch and is turned off after 60 days without activity in a
  public repository.
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

### R1.2 Environments and deployments

- An environment's branch rule is matched against the run's `GITHUB_REF`; a rule for
  `refs/pull/*/merge` lets `pull_request` runs deploy there. So a pull request's job can't use an
  environment restricted to `main`: prod's secrets stay out of its reach where GitHub enforces
  branch rules. Naming a missing environment in a workflow creates it with no rules.
  https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments,
  https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Deployment statuses take `environment_url`; a transient deployment set `inactive` shows as
  destroyed. `auto_inactive` (default true) marks earlier deployments of the same environment
  inactive. The workflow `permissions:` key has `deployments`. Deleting an environment needs admin
  access; `GITHUB_TOKEN` has no administration permission. Whether one shared environment name
  across pull requests hides an earlier pull request's "View deployment": Unconfirmed (R4).
  https://docs.github.com/en/rest/deployments/deployments, https://docs.github.com/en/rest/deployments/statuses

### R1.3 GitHub Container Registry

- A workflow's `GITHUB_TOKEN` can delete package versions when the repository has admin on the
  package, which it has by default for a package its workflow published.
  https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package
- A fork's read-only token can't push (follows from R1.1). Pushing from a same-repository pull
  request with `packages: write`: Unconfirmed on the page (R4).

### R1.4 Cloudflare

- **Wildcard records:** all plans can create and proxy them; an explicit record at a name always
  wins over the wildcard; `*` only as the first label.
  https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
- **Universal SSL** covers the zone apex and first-level names only; `pr-1.shop.example.com` behind
  the proxy needs Advanced Certificate Manager (a paid add-on; price not on the page).
  https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/ OpsCrew
  already knows this rule (`cloudflareEdgeCoverage`, R2.5).
- **API tokens** are scoped by zone; nothing scopes one to single records or a name pattern.
  https://developers.cloudflare.com/fundamentals/api/reference/permissions/ A token in a pull
  request's job that can add `pr-12` could rewrite prod's records too.
- **Workers preview URLs** (`wrangler versions upload --preview-alias`) use "that Worker version's
  existing configuration and resources instead of creating a separate environment": prod's bindings
  (and so its data), and its secrets (Unconfirmed for secrets). Aliases can't be deleted one by one;
  the newest 1000 are kept. They are public unless Cloudflare Access protects them.
  https://developers.cloudflare.com/workers/configuration/previews/

### R1.5 Certificates

- **Let's Encrypt:** 50 new certificates per registered domain per 7 days (shared by every account
  and every name under the domain), 5 for the same set of names per 7 days, 300 new orders per
  account per 3 hours. Renewals through ARI are exempt from every limit.
  https://letsencrypt.org/docs/rate-limits/
- **Caddy** gets a certificate for each site name it serves; its on-demand mode (for names it
  doesn't know in advance) must be restricted with an `ask` endpoint. A wildcard certificate from
  Let's Encrypt needs the DNS challenge, so DNS credentials on the server.
  https://caddyserver.com/docs/automatic-https#on-demand-tls
- OpsCrew's Caddy falls back to ZeroSSL, whose CAA name is `sectigo.com`, already in the CAA records
  OpsCrew writes (R2.5).

### R1.6 OpenSSH forced commands

- `command="…"` in `authorized_keys` runs that command whatever the client asked; the client's
  request is passed in `SSH_ORIGINAL_COMMAND`, which is untrusted text the command must check itself.
  `restrict` turns off forwarding, terminals and `~/.ssh/rc`. https://man.openbsd.org/sshd.8

### R1.7 How others do previews

- **Heroku review apps:** created on each pull request (or by hand); a public repository's fork pull
  requests are not created automatically "for security and billing reasons"; destroyed on close or
  merge, and optionally after 1, 2, 5, 14 or 30 days without a deploy; a `postdeploy` script seeds
  once at creation; production data is never copied.
  https://devcenter.heroku.com/articles/github-integration-review-apps
- **Render:** by label or title by default, or for every pull request with a skip label; deleted on
  close or merge; previews copy the base service's settings, database addresses included (Render
  says to point them at a test database); `X-Robots-Tag: noindex`. https://render.com/docs/service-previews
- **Dokploy:** off by default; a limit of 3 previews per application (adjustable); a wildcard domain
  pointing at the server; it advises against previews on public repositories, since outsiders can
  start builds on your server. https://docs.dokploy.com/docs/core/applications/preview-deployments
- Railway's and Coolify's pages returned 404 and weren't retried.

### R1.8 Seeds

| Tool | Command | What shows the project has seeds |
|---|---|---|
| Prisma | `prisma db seed` | `migrations.seed` in `prisma.config.ts` (`package.json`'s `prisma.seed` in older versions: Unconfirmed) |
| Rails | `bin/rails db:seed` | `db/seeds.rb` |
| Laravel | `php artisan db:seed --force` | `database/seeders/DatabaseSeeder.php` |
| Knex | `knex seed:run` | a `seeds/` folder, or `seeds.directory` in the knexfile |
| Sequelize | `sequelize-cli db:seed:all` | a `seeders/` folder, or `seeders-path` in `.sequelizerc` |
| AdonisJS | `node ace db:seed` | `database/seeders/` |
| Django | `manage.py loaddata <fixture>` | fixtures exist, but no command names which ones: no default |
| Drizzle | the project's own script calling `drizzle-seed` | only the dependency: no default |

Sources: https://docs.prisma.io/docs/orm/prisma-migrate/workflows/seeding,
https://guides.rubyonrails.org/active_record_migrations.html, https://laravel.com/docs/12.x/seeding,
https://knexjs.org/guide/migrations.html#seed-files,
https://sequelize.org/docs/v6/other-topics/migrations/, https://lucid.adonisjs.com/docs/seeders,
https://docs.djangoproject.com/en/stable/howto/initial-data/, https://orm.drizzle.team/docs/seed-overview

## R2. What OpsCrew has to build on (code map, 2026-11-05)

### R2.1 Push deploys

- The deploy workflow is rendered by `renderWorkflow` (`packages/iac-templates/src/workflow/index.ts`)
  with jobs `build` (`build.ts`, `packages: write`, buildx with SBOM and provenance), `deploy`
  (`jobs.ts`, in the environment's GitHub environment), `sign`, `tag`, `label` and `prune`. It
  triggers on `push` with path filters and `workflow_dispatch`; no generated workflow uses
  `pull_request` today.
- The deploy job logs in as `deploy@<host>` with `OPSCREW_SSH_PRIVATE_KEY` and pinned known hosts,
  pipes `OPSCREW_APP_ENV` and `OPSCREW_SERVICE_<NAME>_ENV` over stdin into 0600 files in
  `/srv/apps/<app>`, then runs the switch commands (`switch.ts`): `docker compose pull`, the release
  command (`docker compose run --rm --no-deps -T release`), `docker compose up -d --wait`,
  `kamal-proxy deploy <app> --host <domain>`, and a health check from outside.
- Secrets per environment: `OPSCREW_<ENV>_…` (`deploySecretName`), in the environment's GitHub
  environment where GitHub supports it, prefixed repository secrets elsewhere
  (`checkSecretsPlacement`, `provision/secrets.ts`).

### R2.2 Keys and the deploy user

- The deploy key is Ed25519 (`ensureDeployKey`, `agents/src/shared/ssh-keys.ts`), kept in
  `~/.opscrew/projects/<id>/[environments/<env>/]deploy_key` and copied to `OPSCREW_SSH_PRIVATE_KEY`.
  Its `authorized_keys` line has no options.
- `deploy` has no sudo but is in the `docker` group (root-equivalent, `ssh-host/src/privilege.ts`).
- **A precedent for a restricted key:** the scheduled check's key is
  `restrict,command="df -P -B1 /"` (`checkKeyLine`, `connectors/ssh-host/src/constants.ts`),
  installed on servers OpsCrew creates through a host plan (`check/host.ts`, `planAddon`).
- Servers OpsCrew creates get host plans approved by hash too (`serverHostPlans`, monitoring's and
  the check's host plans in `provision/run.ts`).

### R2.3 Several apps on one server

- The shared edge in `/srv/edge` (Compose project `opscrew-edge`): Caddy in front of kamal-proxy,
  one site file per app (`/srv/edge/sites/<app>.caddy`), one kamal-proxy route per app, the edge
  file replaced only by a newer version stamp (`edgeCommands`, `switch.ts`). Removing an app
  removes its site, its route and its TLS folder (`ssh-host/src/steps.ts`).
- Each app has its Compose project `<app>`, its folder `/srv/apps/<app>`, its `internal` network
  and the external `opscrew-edge` network. An environment's app name is `<app>-<env>`; a hostname
  another app or environment uses is refused (`requireOwnHostnames`).

### R2.4 Environments

- `EnvironmentSchema` (`plan-schema/src/plan.ts`): `name`, `deploySource` (`main` or
  `promote`), `runner`, `runnerHost`, `build`, `secrets`. Files under
  `opscrew/environments/<env>/`, `.opscrew/environments/<env>/` and
  `~/.opscrew/projects/<id>/environments/<env>/`; workflow `opscrew-deploy-<env>.yml`; GitHub
  environment `<env>` (`<app>-<env>` with several apps).
- Name rules: `ENVIRONMENT_NAME_PATTERN` (`core/src/paths.ts`), at most 16 characters.
- `opscrew destroy --env <env>` asks for `allowDestroy` with the typed name `<app>-<env>`, then
  deletes the environment's GitHub secrets, and its GitHub environment when OpsCrew created it.
- Self-hosted runners on a public repository are refused unless fork runs need approval from every
  outside contributor (`checkRunnerRepository`, `agents/src/runners/github.ts`).

### R2.5 DNS and TLS

- App records come from the `cloudflare-dns` Terraform module: `A`, optional `AAAA` and `www`,
  proxied by default (`dns.proxied`), and CAA (`letsencrypt.org`, `sectigo.com` for Caddy) on a
  DNS-only name below the apex (`caaIssuers`, `iac-templates/src/infra/cloudflare.ts`). No wildcard
  record or certificate exists anywhere.
- Behind the proxy, the origin uses a Cloudflare Origin CA certificate (014); DNS-only, Caddy gets
  Let's Encrypt certificates.
- `cloudflareEdgeCoverage` (`plan-schema/src/plan.ts`) already refuses proxied names two labels
  below the zone.

### R2.6 Images

- `ghcr.io/<owner>/<repo>[/<app key>]`, tagged `<sha>` (prod) or `<sha>-<env>`; labels
  `opscrew-<env>` and `opscrew-<env>-previous`.
- Retention (`workflow/retention.ts`) deletes only its own environment's tags and keeps every tag
  it doesn't know, so it would never delete a pull request's image: previews need their own
  cleanup.

### R2.7 Prices, budget, seeds

- Live catalogues with dated static fallbacks (Hetzner, DigitalOcean); `budgetMonthly` in
  `requirements.yaml`; design shows each option's monthly cost and warns above the budget; advise
  flags servers above it.
- Release commands are detected for about 35 tools (`detect/src/release.ts`); seed scripts are
  excluded from them; no seed command is detected today.

## R3. Lead decisions for the spec

1. **Previews are an environment of their own,** `preview` by default, set up with
   `opscrew env add preview --previews` and provisioned with `opscrew provision --env preview`. It
   reuses 015's files, secrets placement, destroy and checks. What makes it different: it has no
   branch of its own, and its server runs one app per open pull request, `<app>-pr-<n>`.
2. **One preview server, its own.** A small server OpsCrew creates (Hetzner, DigitalOcean), or a
   server of the user's with a public address that no other environment runs on. Never prod's or
   any other environment's server, because a pull request's code runs there. Not on Portainer (a
   Portainer token can do anything in Portainer, so nothing would bound a pull request's job), this
   computer, or Cloudflare's hosting and GitHub Pages (R1.4: a Workers preview runs with prod's
   bindings, and the token a job needs is account-wide). Those stay on the roadmap as later work.
3. **The standing approval is the preview recipe, enforced on the server.** `provision --env
   preview` writes a recipe on the preview server: the cap, the lifetime, the hostname pattern, the
   image name allowed, the services each preview runs and their memory, the seed command, and the
   preview values. Its host plan is approved by hash like any other, with the typed confirmation
   that each preview's own data is deleted when its pull request closes. The key the pull request's
   job uses is restricted to one command, `opscrew-preview`, which checks every request against
   the recipe (R1.6, as the check's key does with `df`). So a pull request that changes the
   workflow still can't step outside what was approved (R1.1). A new ADR (0026) and constitution
   1.7.0 add this standing approval to principle I.
4. **Two keys.** The pull request's job gets only the restricted key. The unrestricted deploy key
   for the preview server stays on the user's computer, for provision and the user's own commands,
   and never goes to GitHub.
5. **Same-repository pull requests only.** The workflow uses `pull_request`, never
   `pull_request_target`, and skips forks and Dependabot, which get no secrets (R1.1). Drafts wait
   until they are ready for review. Builds always run on GitHub's machines, never on a self-hosted
   runner.
6. **Hostnames: `pr-<n>.<app's hostname>`, DNS only.** One wildcard record, `*.<app's hostname>`,
   not proxied, points at the preview server; it is created once with the recipe's IaC plan, so the
   pull request's job holds no Cloudflare token (R1.4: a token can't be limited to some names). Each
   preview's Caddy site names its own host, so Caddy gets its certificate from Let's Encrypt
   directly (ZeroSSL as fallback). Behind the proxy, these names would be two labels below the zone
   for any app not on the apex, which Universal SSL doesn't cover (R1.4). The user can name another
   base (`--domain`). A zone that already has a wildcard at that name is refused. Previews send
   `X-Robots-Tag: noindex`.
7. **Each preview's data is its own.** Each runs its own containers of the app's on-server services
   (databases, caches, brokers), empty, then the release command, then a seed command once, when
   the preview is created: the detected one (R1.8) after the user confirms it, a command the user
   names, or none. Generated passwords are made on the preview server and never leave it. The app's
   own values come from `.env.preview` (test keys, never prod's `.env`), written to the server by
   the approved host plan, never stored in GitHub. Services that live elsewhere (buckets, hosted
   databases) use what `.env.preview` names; prod's are never offered.
8. **The cap and the lifetime are enforced on the server.** Default cap 3 (Dokploy's default),
   sized from the memory each preview needs; the server's size follows from it, priced at design
   and counted in the budget. When the cap is reached, a new pull request gets a comment saying so,
   and nothing running is stopped to make room. A preview not updated for 7 days is removed by a
   timer on the server; the pull request's comment says it, and a new push brings it back.
9. **Lifecycle:** opened, reopened, ready for review or pushed → build `ghcr.io/…:pr-<n>-<sha>`, then
   `opscrew-preview up`; closed or merged → `opscrew-preview down`, and the workflow deletes the
   pull request's images. One concurrency group per pull request, cancelling the run in progress.
   A sticky comment on the pull request holds the address and state.
10. **What a pull request can't change:** the services a preview runs come from the recipe. A pull
    request that adds a service previews without it until the user runs `design` and `provision` for
    `preview` again (an approval, as any change of the recipe).
11. **Local commands** for the user: `opscrew preview list`, `opscrew preview destroy <n>` and
    `opscrew preview logs <n>`, over the user's own key. `opscrew destroy --env preview` removes
    the server, the wildcard record and every preview.
12. **Not here:** previews for forks; protecting previews with a login; previews for Cloudflare's
    hosting, GitHub Pages, Portainer and this computer; several apps' previews wired to each other;
    copies of prod's data.
13. **Added after the cross-artefact review (2026-11-05):**
    - A pull request can read repository secrets (R1.1), and a prod-only app keeps its deploy key
      there (R2.1). So provision refuses previews while another environment's secrets are
      repository secrets where GitHub can keep them in a branch-limited environment, and says so
      plainly where it can't (Free, private).
    - The preview environment's plan has no hostname of its own (`dns.domain` absent); its base
      lives in `previews.domain`, so nothing aims at prod's name.
    - The recipe lives in the environment's own app folder, `/srv/apps/<app>/` (the deploy user
      can't create folders directly under `/srv` on a server OpsCrew creates), and its rendered
      files, without values, are committed in the repository.
    - Each `up` applies the current recipe; generated values are made in the format each needs
      (Laravel's key is base64), kept per preview; the seed runs until it has succeeded once.
    - Every request is logged on the server; the token sent there comes from a job that may only
      read packages.

## R4. Spike questions (T2201, before the code depends on them)

- S1: two pull requests whose jobs use one GitHub environment `preview`: does the second hide the
  first's "View deployment", and does `environment: { name, deployment: false }` exist?
- S2: a same-repository pull request's job pushing to GHCR with `packages: write`, and deleting its
  own versions with `GITHUB_TOKEN`.
- Not in the spike: the restricted key from a GitHub-hosted runner is already proven by the
  check's key (R2.2), and the script's side is covered by Docker tests; a certificate under a
  DNS-only wildcard is plain DNS, shown by the live pass.

## R5. The spike (T2201, 2026-11-05)

On the private throwaway repository, two pull requests (#668, #669) from branches of the repository,
each with a workflow whose job used one GitHub environment `spike-preview` with
`url: https://pr-<n>.example.com`, and a second job with `deployment: false`.

- **S1, one environment for every pull request:** each pull request got its own deployment (GitHub
  keys them by the head branch). After #669 deployed, #668's deployment stayed `success` with its own
  URL, never marked `inactive`: GitHub only marks older deployments of the same branch inactive. So
  every pull request keeps its own "View deployment" with one shared environment.
  `environment: { name, deployment: false }` is valid: that job ran with the environment and created
  no deployment.
- **S2, GHCR from a pull request's job:** with `permissions: packages: write`, `GITHUB_TOKEN` logged
  in, pushed `ghcr.io/<owner>/<repo>:pr-<n>-spike` into the repository's existing package, listed
  the package's versions (`GET /users/<owner>/packages/container/<repo>/versions`, 200) and deleted
  the version with that tag (`DELETE …/versions/<id>`, 204). Nothing else was touched.
- **A fine-grained personal token can't use the packages API:** the e2e token got 403 "Resource not
  accessible by personal access token" on the same list call. So OpsCrew can't delete a preview's
  images with the user's token (OpsCrew asks for fine-grained tokens); only a workflow's
  `GITHUB_TOKEN` can.
- **Cleanup:** both pull requests closed unmerged, both branches and the environment deleted, the two
  pushed versions deleted; the two deployment records stay as the deleted environment's history.

**What changes in the design:**
- The deploy job uses the preview environment with its `url`; the `remove` job uses it with
  `deployment: false` and marks the pull request's deployments `inactive`, so its "View
  deployment" goes when the preview goes.
- No connector calls for package versions (T2207 dropped). Images left when no preview workflow runs
  again (pull requests still open when the user destroys previews) are deleted by every deploy
  workflow's image cleanup, which deletes `pr-*` versions older than 31 days: no preview lives
  longer than 30 days without an update, so none of them is still in use.

## R6. Hidden addresses (founder, 2026-11-05)

The founder asked, after reading that `pr-42.shop.example.com` can be guessed: names nobody can
guess, for previews and for the other environments, and no password for now (a password can break
what calls the app: webhooks, OAuth callbacks, API and mobile clients; it goes on the roadmap as a
later option).

**What makes a name hidden.** Every certificate a public CA issues is published in Certificate
Transparency logs (searchable within minutes), so a random name with its own Let's Encrypt
certificate is found anyway. Behind Cloudflare's proxy the name is never in a certificate:
visitors get Cloudflare's free Universal SSL certificate, which names the zone and `*.<zone>`
only (R1.4), and the server holds a Cloudflare Origin CA certificate, from a private CA that
publishes nothing (R2.5). So a random name one level below a zone, proxied, stays unknown unless
someone shares the link. Leaks remain possible (chats, referrer headers to third-party scripts,
browser sync, passive DNS, and on a public repository the pull request's comment itself): this is
"anyone with the link" protection, said so in the guide.

Lead decisions (superseding R3.6 for previews):
1. **Previews on a domain of their own,** a Cloudflare zone used only for previews (for example
   `shop-previews.dev`, about $10 a year; `opscrew domain buy` can buy one): one proxied wildcard
   `*.<zone>` to the preview server, one Origin CA certificate for `*.<zone>` on it, made at
   provision with the user's Cloudflare token and installed by the previews host plan (its key never
   in a plan). The zone must hold no other web records, and can't be the app's own zone. No Let's
   Encrypt certificate per preview, so no weekly limit; the server's address stays hidden, and its
   web ports accept only Cloudflare.
2. **Each preview's name is `pr-<n>-<random>.<zone>`:** the pull request's number first, so people
   tell previews apart, then 10 random lower-case letters and digits the preview server draws from
   `/dev/urandom` when it creates the preview and keeps for its updates. `up` answers the name;
   the workflow's comment, health check and deployment URL use it.
3. **Other environments (dev, staging, a custom one):** `env add` suggests `<env>-<random>.<zone>`
   (10 random characters) instead of `<env>.<zone>` when the app's DNS goes through Cloudflare's
   proxy (the default) with a name one level below the zone; the user can keep the suggestion,
   type another name, or pass `--hostname`. Where the name would get its own public certificate
   (DNS only, or a name two levels deep), `env add` says it would be visible and suggests the plain
   name. Prod is unchanged.
4. **No password** in this feature (roadmap, later).

## R7. Two opt-ins (founder, 2026-11-05, after 0.2.3)

After reading the previews page, the founder asked whether previews could sit where dev or
staging already run, and under the app's own domain. Both are now opt-ins, built as a follow-up
to 022 and released together with 023. A domain and a server of their own stay the default,
because only that setup keeps previews fully apart.

### R7.1 Outside facts (Cloudflare, official docs, 2026-11-05)

- **Advanced Certificate Manager (ACM)** is a paid add-on for each zone, bought in the dashboard.
  The docs give no price, and no documented API turns it on
  (developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/). A pack is DV only
  and holds up to 50 hosts. A wildcard in a pack covers one level, and the docs' example pairs
  `*.example.com` with `*.staging.example.com`.
- **Ordering a pack:** `POST /zones/{zone_id}/ssl/certificate_packs/order` with `type: advanced`,
  `hosts` (1 to 50, which MUST include the zone apex), `certificate_authority` (`google`,
  `lets_encrypt` or `ssl_com`), `validation_method` (`txt`, `http` or `email`) and
  `validity_days` (14, 30, 90 or 365). The token needs Zone → SSL and Certificates → Edit, which
  OpsCrew's token already has for origin protection. Packs list with
  `GET .../ssl/certificate_packs?status=all` and are deleted with `DELETE .../certificate_packs/{id}`.
  The docs state no issuance time; the statuses include `pending_validation`,
  `pending_issuance` and `active`.
- **Quota:** `GET /zones/{zone_id}/ssl/certificate_packs/quota` returns `advanced: { allocated,
  used }` (Read is enough). The docs don't say that `allocated: 0` means no ACM, but it is the only
  read-only sign. Checked live on 2026-11-05 on a Free zone without ACM: `allocated: 0, used: 0`;
  Total TLS answered `{ enabled: false }`; the pack list paged with `result_info`, and showed the
  Universal SSL packs (`universal`, `active` and `backup_issued`).
- **Terraform / OpenTofu** (`cloudflare_certificate_pack`, provider v5; OpsCrew pins `~> 5.27`):
  `zone_id`, `type = "advanced"`, `certificate_authority`, `validation_method`, `validity_days` and
  `hosts`. A pack can't be updated in place, so any change makes a new one; to avoid a gap, the new
  pack is created before the old one is removed. The docs say nothing about waiting for issuance.
- **Total TLS** issues a certificate for each proxied hostname that Universal SSL doesn't cover.
  It needs ACM. A certificate for an exact name beats a wildcard
  (developers.cloudflare.com/ssl/reference/certificate-and-hostname-priority/), and every public
  certificate is published in Certificate Transparency logs. So with Total TLS on, a preview name
  could get its own published certificate. The docs don't say whether this happens for names a
  wildcard record serves.
- **Certificate Transparency** publishes the names a certificate holds. A pack for
  `*.previews.example.com` publishes only the wildcard and the apex, never a preview's name.

### R7.2 What OpsCrew has to build on

- Several apps on one server are 013's (R2.3): the shared edge, one Compose project and folder per
  app, `otherActiveApps` in the ssh-host connector. The previews' host plan already runs as the
  deploy login on a server OpsCrew created (`runAs: "login"`) and as root on the user's own server.
- The previews' Origin CA names and the rules' wildcard condition already come from
  `previews.domain` (`previewZoneNames`, `hostCondition`), so a domain below a zone mostly needs
  the checks to allow it.
- An own target's root has DNS only; a preview root on another environment's server needs the same
  shape, with the addresses of that environment's server.

### R7.3 Lead decisions

1. **On another environment's server (opt-in A).** `opscrew env add preview --previews
   --share-server <env>`, or a choice in "Where should previews run?", followed by a confirmation
   that defaults to no. The warning, shown at `env add` and again in the host plan's approval, says
   that anyone who can push a branch then runs code on `<env>`'s server, beside its data and
   secrets: if that code escaped its container, it could reach them. So use it only when `<env>`
   holds test data and test keys.
   - **What it shares:** previews run on `<env>`'s app server as extra apps, as on their own
     server. The preview environment has no server of its own. Its root holds only the proxied
     wildcard (to that server's public addresses, read at provision), plus the pack below when
     there is one. Every SSH connection goes the way `<env>`'s own does: its deploy login and pinned
     host key, and its recorded admin login on a server of the user's.
   - **Refused** (each with a plain reason):
     - prod, or any server prod runs on;
     - a server that runs apps other than `<env>`'s;
     - a server that takes no public SSH (closed public SSH, a tunnel), because GitHub's machines
       reach previews over SSH;
     - a server whose edge isn't Caddy;
     - a preview environment, Portainer, this computer, or a site;
     - `<env>` not yet provisioned;
     - a cap that doesn't fit the memory the server has left after `<env>`'s own needs.
   - **Cost:** no server of its own, so none in the budget. `<env>`'s design and `advise` count the
     previews' memory in its server's needs.
   - **The host environment:** `destroy --env <env>` and `retarget --env <env>` refuse while
     previews run on its server, and so does a switch of its server's proxy. `destroy --env
     preview` removes the previews, the recipe and the wildcard, and never the server.
   - **Constitution I** forbids a standing approval from reaching another environment's servers.
     It becomes an opt-in the user makes for one named environment, never prod's, after being told
     what the approval can then reach (1.8.0, ADR 0026 D4).
2. **Under the app's own domain (opt-in B).** The preview domain may be a name below the app's
   Cloudflare zone, for example `previews.example.com`, so that previews are
   `pr-<n>-<random>.previews.example.com`. To stay hidden behind the proxy, such names need an
   advanced certificate pack for `*.previews.example.com`.
   - **Opt-in:** interactively, a confirmation that defaults to no; in a script, `--app-zone` with
     `--domain`.
   - **Checks, before any change:**
     - ACM is on (`advanced.allocated` > 0);
     - Total TLS is off (a per-name certificate would publish each preview's name);
     - no record sits at the domain or below it;
     - the domain is no hostname of the app or an environment, nor a parent of one.

     A failed check is refused, with the dashboard steps.
   - **The pack:** made in the preview root by `cloudflare_certificate_pack`, approved by hash with
     the rest: `hosts = [<zone>, "*.<domain>"]`, Let's Encrypt, `txt` validation, 90 days, created
     before an old one is removed. Provision waits up to 10 minutes for it to become active, and
     says so when it isn't yet. `verify` and `drift` check the pack and Total TLS.
   - **Cookies:** the confirmation and the guide say that a cookie the app sets for the whole
     domain (`Domain=example.com`) reaches previews, where a pull request's code can read it, and
     that previews can set such cookies too.
   - **Destroy** removes the pack. ACM itself stays on, and the user turns it off in the dashboard.
   - **Price:** ACM's price is shown in Cloudflare's dashboard. OpsCrew names no figure and adds
     none to the budget, because the user turns ACM on there before OpsCrew uses it.
3. **Live:** A runs on a dev environment on Hetzner. B needs ACM on a zone, a monthly cost the
   founder decides on. Until then, B's live check is the refusal on a zone without ACM.
