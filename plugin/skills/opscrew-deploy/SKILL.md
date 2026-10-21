---
name: opscrew-deploy
description: Take the user's app from this repository to a hardened production deployment on their own cloud, a server they already have or a Portainer they already run (on a NAS or any Docker host) with OpsCrew (scan, analyze, interview, design, prepare the code, then provision), and turn Portainer on or off. Use when the user wants to deploy, host, launch or "put online" their app, deploy to their own server, home server, NAS or Portainer, or move it off Lovable, Bolt, Replit or v0 hosting.
---

# Deploy this app with OpsCrew

OpsCrew gives you deterministic, safe tools through its MCP server (`opscrew_*`). You do the
reasoning and talk to the user; OpsCrew does detection, pricing, rendering and anything that touches
infrastructure. Follow these steps in order and keep the user informed in plain English.

## Rules (always)

- Never run `tofu`, `terraform`, `hcloud`, `doctl`, `aws`, `gcloud`, `az`, `ssh` or `curl` yourself
  for this flow. Infrastructure changes happen only through OpsCrew, after the user approves a plan.
- Never ask the user to paste tokens, passwords or `.env` values into this chat, and never print
  them. Secrets are entered in the user's own terminal by `opscrew provision`.
- Do not edit files under `opscrew/`, `.opscrew/` or `.github/workflows/opscrew-deploy.yml`; OpsCrew
  writes and validates those.
- Tell the user what each step will do and what it costs before doing it.

## Steps

1. **Scan.** Call `opscrew_scan`. Summarise critical and high findings in plain English and offer to
   fix them first (see the `opscrew-scan` skill). Do not continue to deployment while a live secret
   is committed in the repository unless the user explicitly accepts the risk.
2. **Understand the app.** Call `opscrew_detect` and describe the stack back to the user in two or
   three sentences (framework, database, where it came from). Correct obvious misunderstandings by
   asking the user.
3. **Interview.** Call `opscrew_interview_questions`. Ask the user every returned question (use the
   question's options when it has them), then call `opscrew_save_requirements` with the answers.
   One question is where to run the app: Hetzner Cloud, DigitalOcean (Droplets) or a server the
   user already has (`own`: a rented server elsewhere, a company machine or a home server). Its
   default is the provider whose API token is already set (`HCLOUD_TOKEN` or
   `DIGITALOCEAN_TOKEN`), otherwise Hetzner Cloud; let the user choose. For `own`, also ask the
   returned server questions and pass them with the `server.` answer ids they return (address,
   SSH port, user, key, whether the internet reaches the server and how the site is served):
   - the key is a path to the private key file, or `agent` for the SSH agent (which also covers a
     key with a passphrase). Never ask for a password, a passphrase or the key itself.
   - the address stays on the user's computer (`.opscrew/server.json`); tool results say "your
     server" instead. Never write the address into a file, a commit or a pull request.
   - how visitors reach the server, in plain words: (a) through a Cloudflare Tunnel, the default
     behind Cloudflare's proxy and the only way for a server the internet cannot reach (no web
     ports open; needs Cloudflare Zero Trust, free); (b) directly behind Cloudflare's proxy with a
     filter that lets only Cloudflare reach ports 80/443, for a server with a public address (if
     the filter cannot load, Docker and the site stay down rather than open); (c) directly with DNS
     only, open to everyone on 80/443 and without Cloudflare's protection. Recommend (a) unless the
     user has a reason against it. Both Cloudflare ways need a domain on the user's Cloudflare
     account.

   These questions are about what runs next to the app:
   - `workerCommands.<name>`: a background-job library OpsCrew found has no conventional start
     command (BullMQ, asynq, river). Ask the user for the command that starts that worker from the
     app's code (for example `node dist/worker.js`); never guess one.
   - `keepExternalServices.<kind>`: the app already uses a hosted service (a hosted MongoDB,
     PlanetScale, Upstash, Neon and the like). Ask whether to keep it or let OpsCrew run one on the
     server, and pass on what running it there adds (its memory on the server, and its data on the
     server's disk). Without an answer, OpsCrew keeps the hosted one.
   - `keepExternalServices.s3` and `objectStorage`: the app stores files through an S3 client.
     Ask whether to keep the storage it uses now (named when it is a known host such as Amazon S3,
     Cloudflare R2 or Supabase Storage) or let OpsCrew create a bucket (`false`), and if so where,
     from the `objectStorage` choices with their prices. Each choice says where it is offered:
     offer only those that fit the provider the user picks. Garage keeps the files on the app's
     server; on a cloud server it is offered only as the user's choice, so say that the files then
     live only on that server. Never replace the app's storage unasked: without an answer OpsCrew
     keeps it and plans no bucket. An answer never moves a bucket the plan already has; moving it
     is a change of `storage.objectStorage.provider` in `opscrew/plan.yaml`, and the user moves
     the files.

   For `portainer` (a Portainer the user already runs, often on a NAS such as Synology, Unraid or
   TrueNAS), ask the returned `portainer.` questions instead: Portainer's HTTPS address, the
   environment, how new versions reach Portainer and how visitors reach the app.
   - The access token comes only from `PORTAINER_API_KEY` in the MCP server's environment. Never
     ask for it, a Portainer password or any other token in the chat; tell the user to create the
     token in Portainer (My account → Access tokens) and set it in their shell.
   - When OpsCrew connects the first time (or the certificate changed), the user confirms
     Portainer's certificate fingerprint in a dialog. Never confirm it for them and never pass a
     fingerprint yourself. If the client cannot show the dialog, ask them to run
     `npx opscrew interview` in a terminal once, then continue.
   - The address stays on the user's computer; tool results say "your Portainer" instead. Never
     write it into a file, a commit or a pull request.
   - New versions: `updater` (recommended: a tiny updater stack asks Portainer once a minute over
     the local network; nothing opened to the internet) or `cloudflare` (GitHub Actions calls
     Portainer through Cloudflare Access at once; needs the domain on Cloudflare and Zero Trust).
   - Visitors: `tunnel` (recommended with a domain on Cloudflare; no port opened), `proxy` (the
     user's own reverse proxy on a host port they choose; OpsCrew prints the DNS record and the
     route to set up and does not manage the certificate) or `caddy` (Caddy on ports 80 and 443,
     only when they are free; OpsCrew prints the DNS record to create).
4. **Design.** Call `opscrew_design_options`. Present each option with its monthly cost, whether it
   fits the budget and its trade-offs; say which one OpsCrew recommends and why. When prices are
   marked as static estimates, say so. After the user chooses, call `opscrew_select_design`.
   - **Components.** Both tools list what runs next to the web process: workers (with their command
     and number of copies), cron jobs (in UTC), the services OpsCrew runs as containers (databases,
     Valkey, or Redis 8 or Dragonfly when the app needs one, brokers, search and analytics
     engines, each with its version and memory limit), SQLite
     on a persistent volume, and object storage with each option's monthly price. Each option shows
     every component's memory limit and its share of the server's monthly price. Pass on the
     licence sentences in plain words (MongoDB's SSPL, MySQL's GPL, Redpanda's BSL and so on): they
     restrict offering that software as a service, not running it for the user's own app. The
     user changes counts, memory, versions or the storage provider, or turns a component off, in
     `opscrew/plan.yaml`; then call `opscrew_select_design` again (it keeps those edits and checks
     that everything fits the server).
   - **Builder and deploys.** `opscrew_select_design` returns who builds the image (OpsCrew's
     Dockerfile for Node and Python, Buildpacks for Go, Java, .NET and Ruby, Railpack for Bun
     projects and the rest, or the repository's own Dockerfile), how deploys switch, and the signing, deploy tag
     and image retention settings, each with its reason; pass them on. Deploys have no downtime: the
     new version gets traffic only once its health check passes. Servers under 1 GB and Portainer
     restart the app instead, with a short gap. Tell the user that migrations must keep working
     with the version still running. They change these settings in `opscrew/plan.yaml` (the
     builder needs `app.build.chosen: user`); then call `opscrew_select_design` again.
   - **The reverse proxy.** The server's proxy is Caddy (the default) or nginx with certbot, set as
     `target.edge` in `opscrew/plan.yaml`; both give visitors the same TLS and headers. Every app on
     one server uses the same proxy, so OpsCrew refuses a different one while other OpsCrew apps are
     there; with one app the switch is planned, with a short interruption it states. The user's own
     rules for the app go in `opscrew/proxy/additions.caddy` or `.nginx`; OpsCrew checks them before
     they go live and refuses unsafe ones. For an app leaving Vercel, design writes the
     `vercel.json` routing rules it can translate into that file and lists the ones it left out:
     pass that list on. A Portainer stack always uses Caddy and does not use additions yet.
   - **Currencies.** When the user's budget is in another currency than the provider's prices,
     OpsCrew converts with a fixed approximate rate. If the user wants exact numbers, search the
     web for today's exchange rate, recalculate the monthly costs with it and say which rate and
     date you used.
   - **Own server.** OpsCrew connects over SSH and inspects the server read-only first. The first
     time, the user confirms the server's SSH host key in a dialog: tell them to compare the
     fingerprint with the one on the server itself (`ssh-keygen -lf
     /etc/ssh/ssh_host_ed25519_key.pub` in their provider's web console), never approve it for
     them. If the client cannot show the dialog, ask them to run `npx opscrew design` in a
     terminal once. There is one option and no price (they already pay for the server); pass on
     every warning (too little memory or disk, a tunnel without a Cloudflare domain) and say that
     OpsCrew cannot turn on backups there, so backups are their responsibility.
   - **Existing Portainer.** There is one option, without a price or sizes: the app and its
     components as stacks in the chosen environment, built for its architecture, with the data in
     named volumes. Say that OpsCrew does not change the host (its firewall, SSH and Portainer's
     own security stay theirs), that it checks nothing about the host's memory or disk, and that
     backups of the app's data are their responsibility. OpenSearch and Elasticsearch need a
     kernel setting on the Docker host (`vm.max_map_count`), which a stack cannot make, so OpsCrew
     does not run them in Portainer: design keeps the app's own (for example a hosted one), and a
     plan that asks for one stops before any change, saying how to make the setting and run the
     engine by hand next to Portainer.
5. **Prepare the code.** Read `opscrew/plan.yaml` (`codeChanges`). Apply the pending changes by
   following the `opscrew-adapt` skill. Show the user the diff and let them commit it (or commit it
   for them only after they say so). The changes must be merged into the deploy branch before the
   first deploy.
6. **Preview the infrastructure (optional).** Call `opscrew_render` and `opscrew_plan` to show which
   files OpsCrew will add and exactly which cloud resources it will create, with cost and policy
   checks.
7. **Provision.** Prefer the user's own terminal, because it is the only place where they can type
   production values (API keys for their app) directly into OpsCrew:

   ```bash
   npx opscrew provision
   ```

   It checks the token of their cloud provider (Hetzner Cloud or DigitalOcean), plus their
   Cloudflare and GitHub tokens, shows the plan and asks for approval, creates the server, stores
   the deploy secrets in GitHub and opens a pull request with the infrastructure and deploy
   workflow. Merging that pull request deploys the app.

   If the user wants to approve from here instead, call `opscrew_plan`, show them the plan, cost
   and policy results, then call `opscrew_apply` with the plan hash. OpsCrew asks the user in a
   dialog (a destroying plan needs them to type the server name); never claim approval yourself.
   Unless `OPSCREW_APP_ENV_FILE` is set, the deploy secrets still have to be stored by running
   `npx opscrew provision` in their terminal afterwards (it resumes without changing the server).

   **The recovery copy of the app's secrets.** The first provision that generates secrets makes an
   encrypted copy of them, of the deploy key and of the infrastructure state, committed as
   `opscrew/secrets.sops.json` with OpsCrew's pull request. Only the user's age key opens it. In a
   terminal OpsCrew asks for the user's own age key or where to write a new one. Through
   `opscrew_apply`, ask the user for a full path outside the repository (for example in their home
   folder) and pass it as `keyOut`: OpsCrew writes the new key there once and never returns it.
   Tell the user to move it into their password manager and delete the file. Never read that file,
   and never ask for the key itself. Without `keyOut` no copy is made yet, and the result says so.
   Through the tools, a public repository's copy is never committed: OpsCrew writes only the
   folder copy, if one is set, and says to run `npx opscrew provision` (or `secrets rotate`) in a
   terminal, which asks.

   **Origin protection.** For hostnames behind Cloudflare's proxy, OpsCrew serves a Cloudflare
   origin certificate and requires a client certificate only the user's zone sends, so only
   Cloudflare acting for their zone reaches the server. Its changes are in the Cloudflare plan.
   It needs **Zone → SSL and Certificates → Edit** and **Zone → Zone Settings → Edit** on the
   Cloudflare token; without them the site keeps its current protection and the result names the
   missing permission.

   **Workers and cron jobs** need nothing extra: the deploy starts the services first, then the
   new web version, then the workers and the cron jobs with the same image. When a new worker does
   not stay up, the deploy puts the app back on the previous version and names the worker and
   `docker compose logs <worker>`.

   **The storage key.** When the plan keeps the app's files in a bucket on Cloudflare R2,
   DigitalOcean Spaces or Hetzner Object Storage, the bucket has a plan of its own:
   `opscrew_plan` returns it as `storagePlanHash`, with its changes and monthly price. Show it to
   the user and pass `storagePlanHash` to `opscrew_apply` with the other hashes; it is approved in
   its own dialog, never with another plan. In the user's Portainer, the stack plan follows once
   the bucket exists, in a dialog after that apply. The app also needs a key the user creates in
   the provider's console: OpsCrew never creates one (Spaces' and Hetzner's before the bucket,
   R2's after it, as a token limited to the bucket). It comes only from the user's own terminal:
   `npx opscrew provision` shows the console steps and asks for it there once, or the user sets
   `OPSCREW_STORAGE_ACCESS_KEY_ID` and `OPSCREW_STORAGE_SECRET_ACCESS_KEY` in the MCP server's
   environment. When a tool stops because the key is missing, pass on its steps. OpsCrew keeps the
   key on the user's computer like a provider token, never in the repository or in infrastructure
   state. Never ask for the key in the chat. R2 also needs the Cloudflare token's
   **Account → Workers R2 Storage → Edit** permission. Garage, on the user's own server or
   Portainer, needs no key from them: OpsCrew generates it.

   **The Cloudflare plan comes first.** When the app's domain is on Cloudflare, `opscrew_plan` also
   returns a Cloudflare plan with its own hash (`cloudflarePlanHash`), approved on its own before
   the infrastructure plan. It lists what OpsCrew changes in its two shared rules in the zone (the
   probe block for paths like `/.env` and the strict TLS rule, each listing the hostnames of every
   OpsCrew app in the zone) and, when Cloudflare Access is used, in the account's Zero Trust
   organization and one-time PIN login. Show it to the user and say that the zone's other rules
   stay exactly as they are. Pass `cloudflarePlanHash` to `opscrew_apply` with the other hashes
   (only it when `opscrew_plan` returned nothing else); without it, the Cloudflare plan is refused.
   When the plan removes OpsCrew's rule (the last app's hostnames leave it), the dialog asks the
   user to type the app's name. In a terminal script the Cloudflare plan's hash is one more
   `--approve <hash>`, and `--yes` never approves it. When the plan stops because a hostname is
   already in OpsCrew's rule for another app, pass on its explanation: OpsCrew never takes a
   hostname from another app.

   **On the user's own server** there are two plans besides the Cloudflare plan, each approved on
   its own: the Cloudflare infrastructure (DNS records, or the tunnel and Cloudflare Access in
   tunnel mode) and the host plan, which lists every change OpsCrew would make on the server (Docker 28 or newer from
   Docker's repository, a `deploy` user, SSH hardening, the ufw firewall, fail2ban, automatic
   security updates, the shared folders `/srv/edge`, `/srv/apps` and `/srv/data`, the app's own
   `/srv/apps/<app>` and `/srv/data/<app>` and its record in `/etc/opscrew/apps/<app>.json`, and
   `vm.max_map_count` when a search engine needs it) and marks what is already in place. Several
   OpsCrew apps can share one server: each has its own folders, and all sit behind one shared edge
   (Caddy and kamal-proxy in `/srv/edge`), which goes with the last app; the host plan shows which
   parts are shared and which are the app's own. Show both plans to the user. `opscrew_plan` returns `planHash` and `hostPlanHash`; pass both to `opscrew_apply`
   (only `planHash` when it returned only a host plan). In a terminal the user runs
   `npx opscrew provision`, or in scripts `npx opscrew provision --plan-only` and then
   `--approve <infrastructure hash> --approve <host plan hash>`; `--yes` never approves either.
   When other users on the server log in with a password and have no SSH key, OpsCrew stops until
   the user chooses: ask them whether to turn password logins off anyway (`off`) or keep them
   (`keep`), never choose for them, and pass their answer as `passwordLogins` to both `opscrew_plan`
   and `opscrew_apply` (in a terminal: `--password-logins off|keep`). The host plan then shows the
   choice in the dialog they approve.
   OpsCrew stops and changes nothing when the server already runs a web server on ports 80/443,
   uses another firewall, has Docker from Snap, Podman or the distribution's package, or when
   another OpsCrew app on the server already uses the app's name or one of its hostnames; pass on
   its explanation. Tunnel mode and Portainer's subdomain need
   Cloudflare Zero Trust turned on for the account (free plan, https://one.dash.cloudflare.com/).

   **In the user's existing Portainer** there are up to two plans besides the Cloudflare plan, each
   approved on its own: the Cloudflare infrastructure (the tunnel, and Access in front of
   Portainer's webhook in `cloudflare` mode) and the stack plan, which lists every change in Portainer (the app's stack,
   the updater or connector stack, the registry entry and the repository access) and marks what is
   already in place. `opscrew_plan` returns `planHash` and `stackPlanHash`; pass both to
   `opscrew_apply` (when it returned only a stack plan, pass its `stackPlanHash` as `planHash`).
   With the Cloudflare Tunnel (web `tunnel`) or Cloudflare redeploys (redeploy `cloudflare`)
   OpsCrew creates a tunnel, and the first stack plan needs its token, which exists only after the
   Cloudflare plan is applied; so that stack plan is shown in its own dialog after the Cloudflare
   apply. In a terminal: `npx opscrew provision`; in scripts `--plan-only`, then `--approve <hash>`
   for each plan (with a new tunnel in either mode that takes three runs); `--yes` never approves
   either.
   - A private image needs a read-only registry token in `OPSCREW_GHCR_READ_TOKEN` and a private
     repository a read-only repository token in `OPSCREW_REPO_READ_TOKEN`, both in the user's
     shell. If the image is public, pass `publicImage: true` (`--public-image`) only when the user
     says so; `publicImage: false` (`--private-image`) switches back. After the user rotated one
     of those tokens, pass `replaceTokens` (`--replace-token repository|registry`) once.
   - With a limited (non-admin) Portainer token and a private image, OpsCrew stops before any
     change and shows one-time steps (an administrator adds a `ghcr.io` registry entry, or the
     image is made public); pass them on and plan again afterwards.
   - For `proxy` and `caddy` OpsCrew creates no DNS record: pass on the record it prints. Switching
     how visitors reach the app takes the site down until DNS or the proxy points at the new route.
   - OpsCrew changes nothing it did not create: other stacks, volumes, registry entries and
     Portainer's own settings stay as they are.
8. **Check.** After the first deploy finishes, call `opscrew_verify` and `opscrew_secure` and walk
   the user through anything that failed. Point them to `opscrew/RUNBOOK.md` for day-to-day
   operations. For an app in the user's Portainer behind their own reverse proxy, ask where the
   proxy serves it and pass that address as `url` to `opscrew_verify` (`--url` in a terminal).

   **The deeper check**, only when the user asks for it: `opscrew_secure` with `deep: true`
   (`npx opscrew secure --deep`) also runs Lynis on the server and ssh-audit and testssl.sh in
   Docker on the user's computer, read-only, in a few minutes. Present each tool's findings by
   severity, and the known noise apart with its reason. Without Docker the two outside audits are
   skipped with how to enable them; in a Portainer only testssl.sh runs. A fix OpsCrew can make (an
   SSH setting) happens only through its approved plans, never by itself.

## Before you start and later

- **Preflight.** On a fresh machine or clone, call `opscrew_init_check` first and help the user fix
  every item marked ✗ (tools to install, tokens to create). `npx opscrew init --fix` also adds
  `.opscrew/` to `.gitignore`.
- **Drift.** When the user asks whether anything changed, or after they worked in the Hetzner Cloud,
  DigitalOcean or Cloudflare console (or on their own server over SSH, or in Portainer), call
  `opscrew_drift`. It reports changes made outside OpsCrew (attribute names only; on their own
  server also its SSH, firewall, deploy user and runtime files; in their Portainer the app's stack
  file, environment keys, redeploy setting, registry entry and deploy branch, never a value),
  changes not applied yet and edited generated files, and changes nothing. Once the app was
  deployed on a server it also names a component of the plan with no container there, a
  container the plan no longer has and a stopped one. To undo
  drift the user runs `npx opscrew provision`; to keep a console change, `opscrew/plan.yaml` must
  be updated to match first.
- **Status.** `opscrew_status` shows the server's proxy, each certificate OpsCrew manages with its
  expiry (pass on any warning: fewer than 30 days left, or a failed renewal with its reason), and
  the recovery copy's state. It lists the app's components (web process, workers, cron jobs,
  services) and, once the app was deployed, whether each runs: read over SSH on a server, or
  through Portainer's API (with `PORTAINER_API_KEY`) in the user's Portainer. On the user's own
  server it reads them only after the SSH host key was confirmed once; otherwise ask the user to
  run `npx opscrew status` in a terminal.
- **The recovery copy.** `opscrew_secrets_status` shows when the copy was last updated, how many
  keys open it and whether it is behind. On a new computer, `opscrew_secrets_restore` rebuilds
  OpsCrew's files from it with the key file the user names (`keyFile`, a full path; never read it
  yourself). When files differ, it writes nothing and lists them by name: ask the user which side
  to keep and call it again with `onConflict`. `opscrew_secrets_rotate` makes a new key, written
  only to the `keyOut` file the user names, and proposes the re-encrypted copy in a pull request
  (dialogs approve each step); older commits stay readable with the old key.
  `opscrew_secrets_folder` sets a folder the copy is also written to, or stops it with `null`.
  In a terminal: `npx opscrew secrets status|restore|rotate|folder`.
- **Getting a domain.** When the user has no domain yet, call `opscrew_domain_check` with a name
  or a domain. It checks availability live and returns the first-year and renewal prices with
  their currency, and a plain reason for names that cannot be bought through the API (taken,
  premium, extensions sold only in a registrar's dashboard). It asks Cloudflare Registrar by
  default; pass `registrar` (`porkbun`, `namecheap` or `godaddy`) to ask another registrar, or
  `compare: true` to list the prices of every registrar that is set up side by side, cheapest
  renewal first (sorted by price only, never by anything else). Each registrar is set up with
  environment variables in the user's own shell or `.env`:
  - Cloudflare uses `CLOUDFLARE_API_TOKEN` with the optional Registrar permission.
  - Porkbun uses `PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY`; a domain the user already has
    at Porkbun also needs API access turned on for it in Porkbun's dashboard.
  - Namecheap uses `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY`, and optionally
    `NAMECHEAP_USERNAME` and `NAMECHEAP_CLIENT_IP`. The machine's public IPv4 address must be on
    the API whitelist in Namecheap's dashboard, and Namecheap only enables API access for accounts
    with 20 domains, a $50 balance or $50 spent.
  - GoDaddy uses `GODADDY_API_TOKEN`, and optionally `GODADDY_PROFILE_ID` for a saved contact
    profile.

  Buying and connecting are terminal-only on purpose; there is no tool for either. To buy, tell the
  user to run `npx opscrew domain buy <domain>` in their own terminal (add `--registrar <id>` to
  buy at Porkbun, Namecheap or GoDaddy): it shows the price and asks them to type the domain to
  confirm (scripts need `--confirm` and `--max-price`). Afterwards OpsCrew creates the Cloudflare
  zone and sets the domain in `opscrew/plan.yaml`; at Cloudflare it also turns on DNSSEC and
  leaves auto-renew on, and a domain bought elsewhere still gets its DNS moved to Cloudflare (its
  nameservers are switched). When the user already owns a domain, tell them to run
  `npx opscrew domain connect <domain>`: it copies the current DNS records into a new Cloudflare
  zone first, shows them for approval, then switches the nameservers. If old DNSSEC (DS) records
  are still published, OpsCrew removes them through the registrar's API after approval (or the
  user removes them in the registrar's dashboard when the API cannot), and the nameserver switch
  happens on a later `npx opscrew domain connect <domain>` run, at least 24 hours after they are
  gone (the run says when). When the user removes them by hand it can take up to three runs. Never
  ask the user for tokens, API keys or contact details (name, address, email,
  phone): registrars use the account's own contact, and OpsCrew never collects one.
- **Monorepos.** When the repository has several apps, `opscrew_interview_questions` asks which one
  to deploy (`appDir`); ask the user, never guess.
- **Tearing down.** There is no tool for it on purpose. Tell the user to run `npx opscrew destroy`
  in their own terminal: it offers a snapshot first (the database is deleted with the server), asks
  them to type the server name and removes the deploy secrets from GitHub. The app's bucket stays,
  with its files, unless they add `--delete-data`. On their own server it
  never deletes or reinstalls the server: it removes the app and its Cloudflare records after they
  type the app's name, keeps the app's data unless they add `--delete-data`, and reverses
  OpsCrew's own changes to the server only with `--undo-host` (a separate plan they approve).
  There are no snapshots there: backups are their responsibility. In their existing Portainer it
  removes only what OpsCrew created (the app's stacks, its registry entry, the deploy secrets and
  the Cloudflare resources) after they type the app's name, never Portainer itself or another
  stack, and keeps the app's data volumes unless they add `--delete-data`. On every target it
  also removes the app's hostnames from OpsCrew's shared Cloudflare rules (deleting a rule only
  when no other OpsCrew app is in it), and the account's Zero Trust organization and one-time PIN
  login stay for the other apps.
- **Portainer.** A web UI for the containers, off by default, on any server OpsCrew deploys to.
  `opscrew_portainer_enable` installs it (listening only on the server itself, reached through an
  SSH tunnel; an admin password generated on the user's computer) after the user approves the plan
  in a dialog; `subdomain` and `allowEmails` opt in to a subdomain behind Cloudflare Access.
  `opscrew_portainer_status` tells where the password file is; never read that file or print the
  password. To open Portainer the user runs `npx opscrew portainer status` in a terminal and
  starts the SSH tunnel it prints. Warn them that Portainer controls Docker, which is the same as
  root on the server, so they should keep it local unless they need the subdomain.
  `opscrew_portainer_disable` removes it and always keeps its data (users and settings). Deleting
  that data stays in the terminal: the user runs `npx opscrew portainer disable --delete-data`
  and types the app's name; the tool refuses to do it.
- **Moving to another provider.** Moving a live app to another cloud provider is terminal-only
  on purpose; there is no tool for it, and you must not try to perform its steps yourself. Tell
  the user to run `npx opscrew retarget --to <provider>` (`npx opscrew retarget --help` lists the
  providers) in their own terminal. Moving to or from a server they own, or a Portainer, is not
  supported yet. It creates the new server next to the old one and
  deploys the app there, then copies the database in a short maintenance window (it shows the
  expected downtime first) and switches DNS to the new server. After checking the app, the user
  runs `npx opscrew retarget --finish` to delete the old server (it offers a snapshot and asks
  them to type the app name). `npx opscrew retarget --abort` restores the old deployment, but only
  before the DNS switch. Both servers are billed until the move is finished. `opscrew_status` (or
  `npx opscrew status`) shows where a move stands; while it is in progress, design, provision and
  drift stop with the commands to continue, finish or abort it, so pass those on to the user.

If a tool returns an error, read its message and hint to the user and suggest the next step; do not
work around OpsCrew's checks.
