# OpsCrew

**The ops crew you didn't hire.**

From a GitHub repo to a hardened production deployment on your own cloud. Any cloud. You keep the infrastructure code.

> Status: alpha. Tested live on Hetzner Cloud, on a server you already own and on an existing Portainer. DigitalOcean is tested against a fake only so far. Not published on npm yet; expect breaking changes before 1.0.

## Quickstart

You need Node.js 22.9+, git, OpenTofu or Terraform, a GitHub repository with your app, and an API token for Hetzner Cloud (`HCLOUD_TOKEN`) or DigitalOcean (`DIGITALOCEAN_TOKEN`). For a custom domain, add a Cloudflare token (`CLOUDFLARE_API_TOKEN`) and a domain whose DNS is on Cloudflare. A GitHub token (`GITHUB_TOKEN`, or a logged-in `gh`) lets OpsCrew open pull requests and set the deploy secrets. A model (`ANTHROPIC_API_KEY`) is optional: pass `--no-ai` to `analyze` and `adapt` to run without one.

Run these in your app's repository, in order:

1. `npx opscrew init` checks the tools and tokens and offers to add `.opscrew/` to `.gitignore`. Free.
2. `npx opscrew analyze` finds the frameworks, services and environment variables. Free with `--no-ai`; with a model it costs a few cents.
3. `npx opscrew interview` asks about traffic, budget, region, provider and your domain. Free.
4. `npx opscrew design` proposes architectures with their estimated monthly cloud cost; you pick one. Free.
5. `npx opscrew adapt` opens a pull request that prepares the app for a container: the Dockerfile, `.dockerignore` and `.env.example`, plus the code changes the plan needs (for Next.js OpsCrew makes them itself: standalone output and the `/api/health` route). Free with `--no-ai`, which lists any change left for you; for other stacks the health route is one of them, and deploys fail their health check until it exists. The Code-change agent makes those changes for you and costs model usage. Merge the pull request, then `git checkout main && git pull`.
6. `npx opscrew provision` shows the infrastructure plan and creates the server only after you approve that exact plan. From here your cloud bills you (the estimate from step 4). It opens a second pull request with the deploy workflow; merging it runs the first deploy.
7. `npx opscrew verify` checks that the app is up, healthy and served over TLS, and `npx opscrew secure` checks the server's hardening and writes the security report. Free.

`npx opscrew destroy` deletes the deployment's infrastructure; it asks you to type the server name first and can take a snapshot. `npx opscrew scan` checks the repository for leaked secrets and risky config at any time, free.

Until 0.1.0 is published to npm, run OpsCrew from a clone instead of `npx opscrew`:

```bash
git clone https://github.com/softzer0/opscrew.git && cd opscrew
pnpm install && pnpm --filter opscrew build
node packages/cli/dist/opscrew.js --cwd /path/to/your/app init   # then analyze, interview, ...
```

## What OpsCrew does

OpsCrew is an open-source crew of AI agents that does the DevOps and SecOps work for your app:

1. **Scan** your repo for leaked secrets, exposed Supabase/Firebase data and risky config (free, no AI needed).
2. **Analyze** how your app is built and **interview** you about traffic, budget and regions.
3. **Design** a deployment that fits your budget and **open a pull request** with the code changes it needs (Dockerfile, health check, config).
4. **Provision** the infrastructure on your own account. You approve every change before it is applied.
5. **Wire up** your domain, TLS and CI/CD, **harden** the server and **verify** the result.

Everything OpsCrew produces is a plain file in your repo: infrastructure code, workflows, reports, a runbook. Delete OpsCrew and your deployment keeps working.

Supported clouds: Hetzner Cloud and DigitalOcean (Droplets), with optional Cloudflare DNS. The interview asks which one to use. AWS, Google Cloud, Azure and Contabo follow.

Already have a server, or want a web UI for your containers? See [Deploy to a server you already have](docs/guide/own-server.md) and [Portainer](docs/guide/portainer.md).
Already run Portainer, for example on a NAS? See [Deploy to a Portainer you already run](docs/guide/portainer-target.md).
Several apps under one domain? See [Your domain on Cloudflare, and several apps in one zone](docs/guide/cloudflare.md).

Changed your mind about the provider later? `npx opscrew retarget --to <provider>` moves a live app between Hetzner Cloud and DigitalOcean with its data: it builds the new server next to the old one, copies the database in a short maintenance window, switches DNS, and deletes the old server only when you run `opscrew retarget --finish`.

No domain yet? `npx opscrew domain buy <domain>` buys one at cost after you confirm the price, through Cloudflare, Porkbun, Namecheap or GoDaddy. Already own one? `npx opscrew domain connect <domain>` moves its DNS to Cloudflare. See [Buying or connecting a domain](docs/guide/domains.md).

## Development

Requirements: the tools from the Quickstart, plus pnpm 10+.

```bash
pnpm install
pnpm check                     # lint + typecheck + test
node scripts/pack-smoke.mjs    # build, pack the CLI and run the tarball with npx in an empty folder
```

Specifications live in `specs/` and the project constitution in `.specify/memory/constitution.md`.

## License

Apache-2.0 (see `LICENSE`), except `ee/`, which is under FSL-1.1-ALv2 and converts to Apache-2.0 after two years. Anything primarily useful to individual developers stays outside `ee/` and stays free.

OpsCrew uses Claude by Anthropic. Powered by Claude.
