# Quickstart: validating environments, local runs and runners (015)

Each scenario proves one user story end to end. The live scenarios are the gated tests of T1514;
the local ones are the Docker pass of T1513.

## Prerequisites

- **Docker:** Docker Desktop on this computer, or Docker Engine on Linux.
- **Git for Windows** on Windows.
- **The e2e variables** in `.env.e2e`: the Hetzner token, the throwaway GitHub repository with its token, and the Cloudflare token and domain. The GitHub token needs **Administration: write** and **Environments: write** for the environment and runner scenarios.
- **Build the CLI:** `pnpm --filter opscrew build`.

## 1. Localhost (User Story 1)

```bash
opscrew init && opscrew analyze --no-ai
opscrew interview --answers <answers with provider localhost>
opscrew design
opscrew provision --plan-only     # the local plan and its hash
opscrew provision --approve <hash>
opscrew localhost trust           # optional; shows the command first
opscrew verify && opscrew status && opscrew drift
opscrew destroy --confirm <app>   # data volumes stay without --delete-data
```

**Expect:**
- the app answers at `https://<app>.localhost` (or `:8443`), and only on 127.0.0.1;
- the preflight lists memory, ports and Docker's licence;
- the rendered stack differs from a server's only by research R4's list (SC-1502);
- destroy leaves no OpsCrew container or network.

## 2. Environments (User Story 2)

On an app already in prod:

```bash
opscrew env add staging --target hetzner --from main
opscrew provision --env staging   # its own plans and approvals
opscrew env list
opscrew destroy --env staging --confirm staging
```

**Expect:**
- prod's plan hash is the same before and after each step;
- 20 requests per second to prod see no failure;
- staging answers on `staging.<domain>`;
- its secrets are in a GitHub environment or prefixed, as the capability check said;
- after destroy, nothing of staging is left, and prod still answers.

## 3. Promotion (User Story 3)

With staging following main and prod promoted from staging:

```bash
opscrew env set prod --from staging && opscrew provision --env prod   # prod's workflow becomes the promoted one
git commit --allow-empty -m change && git push        # staging deploys
opscrew promote --to prod                             # shows the digest and provenance
opscrew promote --to prod --approve <hash>
opscrew promote --to prod --digest <previous digest>  # rollback
```

**Expect:**
- prod runs exactly staging's digest (SC-1503);
- the approval's hash covers the digest;
- a tampered digest or a foreign provenance is refused;
- retention keeps both environments' running and previous images.

## 4. The server's runner (User Story 4)

```bash
opscrew env add …            # or on prod: set environment.runner to server in its plan
opscrew provision            # the host plan shows github-runner
```

Then push a change while the server's firewall refuses SSH from everywhere but the test's own
address.

**Expect:**
- the deploy job runs on the runner, and the change goes live;
- `status` shows the runner online;
- destroy unregisters it, and GitHub lists no runner afterwards;
- the leak search finds no registration token.

## 5. The whole pipeline locally (User Story 5)

```bash
opscrew runner start --env dev   # foreground; Ctrl+C stops it
git commit --allow-empty -m local && git push
```

**Expect:**
- the deploy job runs on this computer and deploys to the local stack;
- the new version answers locally within 10 minutes (SC-1507);
- after stopping, GitHub lists no runner.

## 6. CI (FR-1531)

OpsCrew's own workflow:
- `ubuntu-latest` passes scenario 1 with real Docker;
- `macos-15-intel` with Colima passes scenario 1 (non-blocking);
- `windows-latest` and `macos-latest` pass the localhost unit tests.

The coverage page lists Apple silicon Docker as not tested live.
