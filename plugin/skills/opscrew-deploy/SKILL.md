---
name: opscrew-deploy
description: Take the user's app from this repository to a hardened production deployment on their own cloud with OpsCrew (scan, analyze, interview, design, prepare the code, then provision). Use when the user wants to deploy, host, launch or "put online" their app, or move it off Lovable, Bolt, Replit or v0 hosting.
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
   One question is where to run the app: Hetzner Cloud or DigitalOcean (Droplets). Its default is
   the provider whose API token is already set (`HCLOUD_TOKEN` or `DIGITALOCEAN_TOKEN`), otherwise
   Hetzner Cloud; let the user choose.
4. **Design.** Call `opscrew_design_options`. Present each option with its monthly cost, whether it
   fits the budget and its trade-offs; say which one OpsCrew recommends and why. When prices are
   marked as static estimates, say so. After the user chooses, call `opscrew_select_design`.
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
8. **Check.** After the first deploy finishes, call `opscrew_verify` and `opscrew_secure` and walk
   the user through anything that failed. Point them to `opscrew/RUNBOOK.md` for day-to-day
   operations.

## Before you start and later

- **Preflight.** On a fresh machine or clone, call `opscrew_init_check` first and help the user fix
  every item marked ✗ (tools to install, tokens to create). `npx opscrew init --fix` also adds
  `.opscrew/` to `.gitignore`.
- **Drift.** When the user asks whether anything changed, or after they worked in the Hetzner Cloud,
  DigitalOcean or Cloudflare console, call `opscrew_drift`. It reports changes made outside OpsCrew (attribute
  names only), changes not applied yet and edited generated files, and changes nothing. To undo
  drift the user runs `npx opscrew provision`; to keep a console change, `opscrew/plan.yaml` must
  be updated to match first.
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
  are still published, the domain must wait until they are removed, and the user runs connect a
  second time. Never ask the user for tokens, API keys or contact details (name, address, email,
  phone): registrars use the account's own contact, and OpsCrew never collects one.
- **Monorepos.** When the repository has several apps, `opscrew_interview_questions` asks which one
  to deploy (`appDir`); ask the user, never guess.
- **Tearing down.** There is no tool for it on purpose. Tell the user to run `npx opscrew destroy`
  in their own terminal: it offers a snapshot first (the database is deleted with the server), asks
  them to type the server name and removes the deploy secrets from GitHub.
- **Moving to another provider.** Moving a live app between Hetzner Cloud and DigitalOcean is
  terminal-only on purpose; there is no tool for it, and you must not try to perform its steps
  yourself. Tell the user to run `npx opscrew retarget --to <provider>` (`hetzner` or
  `digitalocean`) in their own terminal. It creates the new server next to the old one and
  deploys the app there, then copies the database in a short maintenance window (it shows the
  expected downtime first) and switches DNS to the new server. After checking the app, the user
  runs `npx opscrew retarget --finish` to delete the old server (it offers a snapshot and asks
  them to type the app name). `npx opscrew retarget --abort` restores the old deployment, but only
  before the DNS switch. Both servers are billed until the move is finished. `opscrew_status` (or
  `npx opscrew status`) shows where a move stands; while it is in progress, design, provision and
  drift stop with the commands to continue, finish or abort it, so pass those on to the user.

If a tool returns an error, read its message and hint to the user and suggest the next step; do not
work around OpsCrew's checks.
