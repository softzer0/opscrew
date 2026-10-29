# Changelog

What changed in each release of OpsCrew: the `opscrew` CLI on npm and the Claude Code plugin, which
installs the same version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until 1.0, a release can change the files OpsCrew writes and the commands' flags.

## [0.1.2] - 2026-10-29

### Added

- `opscrew logs` shows your app's latest log lines wherever it runs: on a server, in your Portainer,
  on this computer, or a server-rendered site on Cloudflare. `--follow` keeps showing new lines
  until Ctrl+C, and `--service`, `--since` and `--tail` choose which lines. Secrets are masked
  before a line is shown. See [Your app's logs and resource figures](docs/guide/logs-and-status.md).
- `opscrew status` shows how the app is doing right now: the server's load, memory and disk, and
  each container's CPU, memory, restarts and uptime. It flags a container near its memory limit, a
  disk past 85% and a restart since the last deploy, with what to do. On Cloudflare it shows the
  Worker's requests, errors and CPU time of the last day.
- A scheduled check in GitHub Actions, on by default for prod, checks that your app answers, that
  its certificate is valid and that its server's disk has room. When something fails it opens a
  GitHub issue, and it can post to Slack, Discord or ntfy; when the app recovers it closes the issue
  and says how long the problem lasted. `design` shows its Actions minutes a month, and `destroy`
  and `retarget` pause it. See [Alerts: the scheduled check](docs/guide/alerts.md).
- Two add-ons for a server OpsCrew deploys to, each turned on with `opscrew addon enable` after a
  plan you approve, and removed with `opscrew addon disable`:
  - [Beszel](docs/guide/beszel.md): charts and history of the server and its containers.
    `opscrew addon open beszel` opens its dashboard through an SSH tunnel;
  - [Grafana Cloud](docs/guide/grafana-cloud.md): your app's log lines and the server's metrics,
    sent to your own free Grafana Cloud stack by Grafana Alloy, with the app's secrets masked
    before they leave the server.

  Both see Docker only through OpsCrew's read-only proxy.
- The Claude Code plugin reads the logs (`opscrew_logs`), shows the figures and open alerts in
  `opscrew_status`, and turns the add-ons on and off. Its new `/opscrew:opscrew-troubleshoot`
  skill finds out why your app is failing or slow. See
  [the plugin's guide](docs/guide/claude-code-plugin.md).

### Changed

- With the scheduled check on, the GitHub token needs Issues: Read and Variables: Read and write. For
  a server-rendered site's past requests in `opscrew logs`, the Cloudflare token needs Workers
  Observability: Read. See [Security](docs/guide/security.md).
- Hints that pointed to `docker compose logs` on the server now name `opscrew logs`.

### Fixed

- On Debian, Ubuntu and other Linux systems where `sh` is dash, `provision` of an environment on
  this computer could not log in to GitHub Container Registry to pull the app's image. Docker got no
  token, though the token was right.

## [0.1.1] - 2026-10-24

### Added

- Host a site on Cloudflare, with no server: static sites from Workers static assets, and
  server-rendered Astro, Next.js (through OpenNext), Nuxt and SvelteKit apps as a Worker. `adapt`
  adds the Cloudflare adapter when the app does not use it yet. See
  [Host your site on Cloudflare](docs/guide/cloudflare-hosting.md).
- Publish a static site on GitHub Pages, on your domain. See
  [Publish your site on GitHub Pages](docs/guide/github-pages.md).
- `provision`, `verify`, `status`, `drift`, `secure`, `promote` and `destroy` work for both, with
  environments, from the CLI, the MCP server and the Claude Code plugin.
- On Cloudflare, `promote --version` refuses to roll back to a version from before one of the app's
  secrets changed, and names the secrets. If their old values are still safe,
  `--allow-old-secrets <name>` rolls back anyway, after an approval that names them.
- `app add` takes a site that has no manifest, such as a Hugo site.

### Changed

- A push runs an app's deploy workflow only when something the app deploys changes: its folder,
  the paths in `app.sharedPaths`, the workflow itself and the OpsCrew files the deploy reads. See
  [When a push deploys your app](docs/guide/when-deploys-run.md).
- Running `design` again keeps the plan's own settings, such as the app's name, the workflow's path
  and the Worker's name. Where you changed a value `analyze` found (the port or the health path, for
  example), design keeps yours and says what analyze found.
- An app in a folder takes its environment variables from its own folder, the workspace packages
  it uses and the committed env files at the repository root.
- `provision` commits only OpsCrew's own files to its deploy-setup branch, and says how to get back
  to the branch you were on.
- The CLI no longer installs the Claude Agent SDK (about 300 MB). The first AI step asks before
  downloading it once (`--yes` agrees); commands without AI never need it.
- The Claude Code plugin installs OpsCrew from a pinned lockfile instead of running `npx`: about
  35 MB.

### Fixed

- The provider lock files (`.terraform.lock.hcl`) go into the deploy-setup pull request instead of
  staying uncommitted.
- A Cloudflare deploy retries for up to 2 minutes when Cloudflare cannot find the Worker version it
  has just uploaded yet.
- `provision` on Cloudflare raises the zone's minimum TLS version to 1.2 when every proxied hostname
  in the zone is OpsCrew's, as it does for apps on a server. Other OpsCrew apps' Worker domains now
  count as OpsCrew's.
- A rollback with `--allow-old-secrets` no longer fails on Cloudflare's short answer: OpsCrew reads
  the latest deployment back to confirm it.
- On Windows, OpsCrew can start npm, npx, pnpm and yarn, which failed with `EINVAL`.

## [0.1.0] - 2026-10-23

The first release. OpsCrew takes an app from its GitHub repository to a hardened production
deployment on your own account:

- `scan` checks a repository for leaked secrets, exposed Supabase and Firebase data and risky
  config, free and without AI.
- `init`, `analyze`, `interview`, `design`, `adapt`, `provision`, `verify` and `secure` take the app
  from its code to a live, checked deployment. Every infrastructure change waits for your approval
  of its exact plan.
- Targets: Hetzner Cloud, DigitalOcean, [a server you already have](docs/guide/own-server.md),
  [a Portainer you already run](docs/guide/portainer-target.md) and
  [your own computer](docs/guide/localhost.md), with OpenTofu or Terraform.
- [Environments](docs/guide/environments.md) such as dev, staging and prod, and
  [self-hosted runners](docs/guide/runners.md).
- [Several apps in one repository](docs/guide/several-apps.md), and several apps in one
  [Cloudflare zone](docs/guide/cloudflare.md).
- Domains: `domain buy` and `domain connect`, through Cloudflare, Porkbun, Namecheap or GoDaddy.
- [Components](docs/guide/components.md) next to the app: databases, object storage, message
  brokers, search engines, workers and cron jobs.
- `destroy`, `retarget`, `status` and `drift` after the first deploy.
- The MCP server (`opscrew mcp`) and the Claude Code plugin.

[0.1.2]: https://github.com/softzer0/opscrew/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/softzer0/opscrew/compare/0dfc0e91...v0.1.1
[0.1.0]: https://github.com/softzer0/opscrew/tree/0dfc0e91
