# Live end-to-end test

`packages/cli/test/live/live.test.ts` runs the whole OpsCrew flow against real services:

1. It force-pushes `examples/nextjs-postgres` to the `main` branch of a throwaway GitHub repository.
2. It runs `analyze --no-ai`, then `interview --answers` and `design`.
3. It runs `adapt --no-ai --yes` and merges that pull request through the GitHub API.
4. It runs `provision --plan-only --yes` and then `provision --approve <hash> --yes`, which creates a real Hetzner server.
5. It merges the deployment pull request and waits for the `opscrew-deploy.yml` workflow to succeed.
6. It runs `verify` and `secure`.
7. It tears everything down with `opscrew destroy --confirm`.

The test is skipped unless its environment variables are set, so normal runs and CI never start it.

## Setup

| Variable | What it is |
|---|---|
| `OPSCREW_E2E_HCLOUD_TOKEN` | Hetzner Cloud API token (Read & Write). Use a separate, empty project. |
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
```

The test sets `CI=1`, so every command runs non-interactively:

- `--yes` approves writing files, storing deploy secrets, pushing and opening pull requests.
- `--approve <hash>` applies exactly the plan the first provision run printed.

## Cost and cleanup

The test runs the smallest x86 server that fits the recommended design, for about 15–30 minutes. At Hetzner's hourly prices that is a few cents. GitHub Actions minutes for the build are free for public repositories and minimal otherwise.

Teardown runs in a `finally` block, so it happens even after a failure:

1. It runs `opscrew destroy --confirm <name> --no-snapshot`, the same command a user runs. It lifts
   delete protection and applies the destroy plan, each plan approved by its hash, then removes
   the deploy secrets.
2. It asserts that no server, firewall or SSH key labelled `managed-by=opscrew,app=<name>`
   remains (SC-301).
3. If `opscrew destroy` failed, it falls back to lifting protection and applying a destroy plan
   with the engine directly, then to deleting the labelled resources through the Hetzner API, and
   asserts again that nothing is left.

Some things are not removed:

- **Cloudflare DNS records:** the IaC destroy removes them, but the API fallback does not. Check the zone if a run failed.
- **GitHub repository state:** the pushed container image (GHCR package), merged branches and Actions secrets stay in the throwaway repository. The next run overwrites them.
