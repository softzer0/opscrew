# Live end-to-end test

`packages/cli/test/live/live.test.ts` runs the whole OpsCrew flow against real services, once for
each cloud provider whose token is set (Hetzner Cloud, DigitalOcean, or both, one after the other):

1. It force-pushes `examples/nextjs-postgres` to the `main` branch of a throwaway GitHub repository.
2. It runs `analyze --no-ai`, then `interview --answers` (with the provider and
   `OPSCREW_E2E_REGION`) and `design`.
3. It runs `adapt --no-ai --yes` and merges that pull request through the GitHub API.
4. It runs `provision --plan-only --yes` and then `provision --approve <hash> --yes`, which creates a real server (or Droplet).
5. It merges the deployment pull request and waits for the `opscrew-deploy.yml` workflow to succeed.
6. It runs `verify`, `secure` and `drift` (which must report no differences).
7. It tears everything down with `opscrew destroy --confirm`.

When both `OPSCREW_E2E_HCLOUD_TOKEN` and `OPSCREW_E2E_DIGITALOCEAN_TOKEN` are set, a third pass
tests `opscrew retarget`: it deploys on Hetzner Cloud, writes a row into the app's database over
SSH, moves the deployment to DigitalOcean non-interactively (each plan approved by the hash the
previous run printed, `--allow-downtime`, and `--dns-switched` without a Cloudflare domain), reads
the row back on the new server (SC-501), finishes the move (`--finish --confirm <name>`) and tears
everything down. If the move stops half-way, the cleanup deletes what is left on both providers
through their APIs.

The test is skipped unless its environment variables are set, so normal runs and CI never start it.

## Setup

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_HCLOUD_TOKEN` | Runs the Hetzner Cloud pass. API token (Read & Write); use a separate, empty project. |
| `OPSCREW_E2E_DIGITALOCEAN_TOKEN` | Runs the DigitalOcean pass. Personal access token with the custom scopes listed in `specs/004-digitalocean/research.md` (or Full Access); use a separate team or an account with nothing else in it. |
| `OPSCREW_E2E_REGION` | Optional interview region, default `eu-central` (Nuremberg/Falkenstein on Hetzner, Frankfurt/Amsterdam on DigitalOcean). |
| `OPSCREW_E2E_GITHUB_REPO` | `owner/name` of a **throwaway** repository. The test force-pushes its `main` branch. |
| `OPSCREW_E2E_GITHUB_TOKEN` | Fine-grained token for that repository only. It needs Contents, Pull requests, Secrets, Actions and Workflows (read and write), plus Metadata (read). |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN` | Optional. A Cloudflare token limited to one zone, with Zone Read, DNS Edit, Config Rules Edit and Zone WAF Edit. |
| `OPSCREW_E2E_DOMAIN` | Optional, used together with the Cloudflare token: a hostname in that zone, for example `e2e.example.com`. |

Requirements:

- `git`
- OpenTofu or Terraform (version 1.6 or newer)
- `ssh` and `ssh-keyscan`
- Node.js 22+

Run it:

```bash
pnpm --filter opscrew build
OPSCREW_E2E_HCLOUD_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  pnpm --filter opscrew exec vitest run test/live
# DigitalOcean instead (set both tokens to run both passes, one after the other)
OPSCREW_E2E_DIGITALOCEAN_TOKEN=… OPSCREW_E2E_GITHUB_REPO=you/opscrew-e2e OPSCREW_E2E_GITHUB_TOKEN=… \
  pnpm --filter opscrew exec vitest run test/live
```

The DigitalOcean pass also confirms the facts `specs/004-digitalocean/research.md` marks as
"confirm live" (image slug, Droplet network fields, snapshot listing, pagination).

The test sets `CI=1`, so every command runs non-interactively:

- `--yes` approves writing files, storing deploy secrets, pushing and opening pull requests.
- `--approve <hash>` applies exactly the plan the first provision run printed.

## Cost and cleanup

Each pass runs the server of the recommended design (budget 20 EUR on Hetzner, 25 USD on DigitalOcean) for about 15–30 minutes. At the providers' hourly or per-second prices that is a few cents per pass. GitHub Actions minutes for the build are free for public repositories and minimal otherwise.

Teardown runs in a `finally` block, so it happens even after a failure:

1. It runs `opscrew destroy --confirm <name> --no-snapshot`, the same command a user runs. On
   Hetzner it lifts delete protection first; on DigitalOcean (no delete protection) it goes
   straight to the destroy plan. Each plan is approved by its hash; then the deploy secrets are
   removed.
2. It asserts that nothing OpsCrew created for the app remains (SC-301, SC-401): on Hetzner no
   server, firewall or SSH key labelled `managed-by=opscrew,app=<name>`; on DigitalOcean no
   Droplet tagged `opscrew-app:<name>`, no firewall `<name>-firewall`, no SSH key `<name>-deploy`
   and no `opscrew-app:<name>` tag.
3. If `opscrew destroy` failed, it falls back to applying a destroy plan with the engine directly
   (lifting protection first on Hetzner), then to deleting those resources through the provider
   API, and asserts again that nothing is left. The shared `managed-by:opscrew` DigitalOcean tag
   is never deleted.

Some things are not removed:

- **Cloudflare DNS records:** the IaC destroy removes them, but the API fallback does not. Check the zone if a run failed.
- **GitHub repository state:** the pushed container image (GHCR package), merged branches and Actions secrets stay in the throwaway repository. The next run overwrites them.
