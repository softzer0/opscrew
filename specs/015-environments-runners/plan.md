# Implementation Plan: Environments, local runs and runners

**Branch**: `main` | **Date**: 2026-10-21 | **Spec**: `specs/015-environments-runners/spec.md` |
**Research**: `specs/015-environments-runners/research.md` (R1–R6, the open items for the spike)

## Summary

**Localhost as a target.** A new provider, `localhost`, runs the app's production stack in the
user's own Docker:
- **The stack:** the same Compose project, components, memory limits and edge (Caddy or nginx with
  kamal-proxy).
- **The deploy:** the production switch scripts run with the computer's POSIX shell, their root
  folders set to a folder under the user's OpsCrew home.
- **The address:** the edge listens on 127.0.0.1, at `https://<app>.localhost` (and
  `<env>.<app>.localhost`), with certificates from an OpsCrew local certificate authority.
- **Approval:** the stack is a local plan, approved by its hash like a host plan.

**Environments.** Every environment is a full plan of its own:
- **Files:** prod's stays at `opscrew/plan.yaml`, and any other lives at
  `opscrew/environments/<env>/plan.yaml`.
- **Paths:** `resolveProjectPaths(root, { environment })` gives each environment its own state,
  records, saved plans, infrastructure root, generated values and deploy key. Prod keeps today's
  paths.
- **Shared parts:** the app's build, components, port and health route are copied from prod's plan
  by `design`, and `provision` refuses an environment whose copy differs.
- **Selection:** every deployment command takes `--env`, and every MCP tool an `environment`
  input.

**Promotion.** The environment that follows main builds and deploys on each push.
`opscrew promote --to <env>`:
1. reads the digest the source environment runs, from its GHCR label tag;
2. checks the image's provenance, and its signature when signed;
3. shows the target's plan;
4. after a new hash-bound approval kind, `promote` (the plan's hash, the digest and both
   environments), dispatches the target's workflow with the digest.

Retention keeps every version labelled with an environment.

**Runners.** Per environment, the deploy job runs on GitHub's machines (as today), on the
server's runner, or on the local runner:
- **The server's runner:** a host plan step, `github-runner`. It is persistent, runs as `deploy`,
  and carries the label `opscrew-<app>-<env>`. It is registered with a token fetched only while
  the plan is applied.
- **The local runner:** `opscrew runner start` registers an ephemeral runner for one session, as
  the user.
- **Public repositories:** both are refused, unless outside contributors' runs need approval.

**GitHub environments where the plan supports them.** OpsCrew checks what the repository allows:
- where environments work, the deploy secrets live in a GitHub environment of that name;
- elsewhere they are prefixed repository secrets, and the approval is OpsCrew's own, said plainly.

## Technical Context

- **Stack:** the same as 000–014. **No new npm dependency.**
  - The local certificate authority and its leaf certificates come from core's P-256 keys and DER
    writer (014), extended to sign with an issuer key.
  - Provenance is read from GHCR's registry API by the GitHub connector: the image index, its
    attestation manifest and the in-toto layer.
- **External tools, pinned:**
  - **The GitHub Actions runner v2.338.0** (MIT): per-asset SHA-256 from the release body. `update-pins.mjs` parses it.
  - **No new image:**
    - the localhost edge reuses the pinned Caddy, nginx-unprivileged and kamal-proxy images;
    - the local build uses the user's Docker.
- **GitHub API calls** (R1, R3), through the typed GitHub connector:
  - environments: put, get, delete;
  - environment secrets and their public key;
  - registration and remove tokens, the list of runners, deleting a runner;
  - the fork-PR approval policy: get, put;
  - `workflow_dispatch` with inputs;
  - GHCR manifests and tags.
- **The token's permissions** (fine-grained), only when the features are used:
  - **Administration: write**: environments, runners, the fork-PR policy;
  - **Environments: write**: environment secrets;
  - **Deployments: read.**
- **To verify in the spike** (T1502, research's open items 1–10):
  - GitHub environments on a Free private repository;
  - retagging, with provenance kept;
  - the dispatch;
  - the runner end to end on a throwaway server;
  - localhost on this Windows computer and on Linux CI;
  - macOS Intel with Colima;
  - the local runner on Windows;
  - the local CA in both proxies.
- **Tests:**
  - fakes and snapshots, as before;
  - the Docker pass (T1513): the localhost target end to end on this computer, through the CLI;
  - OpsCrew's own CI workflow: the localhost integration on `ubuntu-latest`, and a Colima smoke
    job on `macos-15-intel`;
  - gated live tests (T1514): staging and prod on Hetzner with a promotion, and the server's
    runner.

## Constitution Check

- **I (safety gate):**
  - **The localhost stack** is a local plan (containers, networks, volumes, the certificate),
    shown and applied after a `host-apply` approval bound to its hash, like a server's host plan.
  - **The server's runner** is a host plan step, approved by the host plan's hash. Its removal is
    a teardown step.
  - **A promotion** is a deploy to a live environment, so it needs a new hash-bound kind,
    `promote`. Its hash covers the target plan's hash, the digest, and the source and target
    environment. `--yes` never grants it, and scripts name the hash. The dispatch is sent only
    after it.
  - **GitHub repository settings** (an environment, its protection rules, the fork-PR policy) are
    a new approval kind, `github-settings`. It shows exactly what changes, and `--yes` grants it
    in scripts like `github-secrets`.
  - **The environment's secrets** keep `github-secrets`.
  - **Each environment's infrastructure** keeps its own `iac-apply` plans, `cloudflare-apply` and
    `stack-apply`.
  - **Destroy** of one environment needs `allowDestroy` and the typed environment name. Other
    environments are untouched.
- **II (user owns everything):**
  - Every environment's plan is a plain, complete file in the repository, and each workflow is a
    file.
  - The local CA is the user's: a file in their OpsCrew folder, removable with `untrust`.
  - The runner is GitHub's own application, which the user can remove with GitHub's own steps.
  - A user who stops using OpsCrew keeps the workflows; promotion is then a `workflow_dispatch`
    they can run by hand.
- **III (dual engine):** each environment's infrastructure root is `opscrew/infra/<env>`, with
  modules shared as today, in the common dialect. Nothing new in HCL.
- **IV (secrets):**
  - **The runner's tokens** are fetched at apply time, passed over SSH's stdin (or kept in
    memory, for the local runner), registered with the redactor, and never written to a plan, a
    log, the audit log, the state or a file. The runner's own credentials, which `config.sh`
    writes on the server for its service, are GitHub's and stay on the server, as the deploy key
    does today.
  - **The local CA's key** is 0600 under `~/.opscrew/local-ca/`. It is never committed, never in
    the recovery copy (it can be made again), and never printed.
  - **Each environment** has its own generated values and deploy key. Its recovery copy covers
    exactly its own files.
- **V (deterministic first):** environment resolution, the shared-parts check, the promotion
  checks, the local preflight and the runner plan are all deterministic. No model is involved.
- **VI (contracts first):** one serial task (T1501a) changes the contracts, recorded in ADR 0018:
  - the `environment` block in `plan.yaml`;
  - the `localhost` target;
  - the approval kinds `promote` and `github-settings`;
  - `ResolveProjectPathsOptions.environment`.
- **VIII (typed adapters):**
  - GitHub changes go through the typed GitHub connector.
  - The runner goes through the host adapter.
  - The localhost deploy goes through a local executor: the same `RemoteExec` interface the host
    adapter uses over SSH, running the same rendered scripts on the user's computer. No ad-hoc
    command reaches Docker.
- **IX (plain language):**
  - Docker Desktop's licence terms and the free alternatives;
  - which secret store applies and why;
  - what OpsCrew's own approval protects, and what it does not;
  - the runner's privilege (the same as today's deploy);
  - that a public repository is refused, and why;
  - that the local image differs on another architecture.
- **X (simplicity):**
  - No new npm dependency and no new image.
  - Full plans per environment instead of a merge layer (R6).
  - Persistent server runners instead of JIT supervisors (R3).
  - One local CA for both proxies (R4).
  - The production scripts reused on localhost.

## Project Structure

| Package | Change |
|---|---|
| `packages/plan-schema`, `packages/contracts`, `packages/core` (approvals, paths types) | the `environment` block; the `localhost` target; the approval kinds `promote` and `github-settings`; `ResolveProjectPathsOptions.environment`; every reader and writer of the changed types (T1501a) |
| `docs/adr/0018-environments-localhost-runners.md` | the ADR (lead, committed) |
| `packages/iac-templates` (pins, `scripts/update-pins.mjs`), `packages/core` (crypto) | the runner's pin per OS and architecture with its SHA-256; the local CA certificate and leaf certificates signed by it (T1501b) |
| — | the spike (T1502, lead) |
| `packages/core` (paths) | the paths per environment; listing an app's environments from its files (T1503) |
| `packages/connectors/github` | environments, environment secrets, runners, the fork-PR policy, `workflow_dispatch` with inputs, GHCR manifests, provenance and tags; the capability check (T1504) |
| `packages/iac-templates` (workflow: index, shared, jobs, retention, build, portainer) | a workflow per environment; the deploy from a digest input; the secret names per environment; `runs-on` per runner choice; concurrency per environment; the environment label tags and retention by them (T1505) |
| `packages/iac-templates` (edge, runtime, `workflow/switch.ts`) | the localhost Compose and edge: 127.0.0.1 ports, named volumes for data, local CA leaf certificates for both proxies; the switch scripts with variable root folders (T1506) |
| `packages/connectors/ssh-host` | the `github-runner` host step and its teardown (T1507) |
| `packages/agents` (shared, design, init, interview, the phases' environment plumbing) | `env add/list/remove`; design per environment (shared parts copied, app name, hostnames, cost); `--env` resolution; the shared-parts check (T1508a) |
| `packages/agents` (provision secrets, destroy) | secrets per environment: GitHub environment or prefixed; the capability check and the `github-settings` approval; destroy per environment (T1508b) |
| `packages/agents/src/promote` (new) | `opscrew promote`: source digest, provenance, the target plan, the `promote` approval, the dispatch, the wait (T1509) |
| `packages/agents` (providers/localhost, provision/localhost, verify, status, drift, destroy for localhost), `packages/connectors/ssh-host` (a local `RemoteExec`) | the localhost provider: preflight, the local plan, the local deploy, the local CA and trust, verify/status/drift/destroy (T1510) |
| `packages/agents/src/runners` (new), the host-plan wiring in provision | the server's runner (registration at apply, the public-repository rule, the fork-PR policy change), the local runner, status and secure (T1511) |
| `packages/cli`, `packages/mcp-server`, `plugin`, `docs/guide`, `packages/iac-templates/src/runbook` | `--env` everywhere; `env`, `promote`, `localhost trust/untrust`, `runner start/stop`; MCP inputs; the guide pages; the runbook per environment (T1512) |
| `packages/cli/test/e2e`, `.github/workflows` (OpsCrew's own CI) | the localhost Docker pass; the CI workflow (ubuntu, macos-15-intel with Colima, fakes on Windows and Apple silicon) (T1513) |
| `packages/cli/test/live`, `docs/e2e*.md` | live tests (T1514), then the live runs (T1515, lead) |

## Design

### 1. Contracts and plan (T1501a, serial, lead-reviewed)

- **`plan.environment`:**
  - `name`: `^[a-z][a-z0-9-]{0,15}$`; absent means prod.
  - `deploySource`: `{ from: "main" }`, or `{ from: "promote", source: <env> }`.
  - `runner`: `github`, `server` or `local`.
  - `secrets`: `environment` or `prefixed`, written by provision after the capability check.
- **The localhost target:** `{ provider: "localhost", mode: "local-compose", arch, ports: { https, http }, image: "registry" | "local-build" }`.
  - `localhost` joins `DeployProviderSchema`, not `VpsProviderId`: it is no cloud server.
  - Its hostname is derived (`<app>.localhost`, or `<env>.<app>.localhost`), with `dns.provider: none`.
- **`app.name` per environment:** `<app>` for prod, `<app>-<env>` for the others. This lets two environments share a server, a Portainer and a zone, as two apps do.
- **Approval kinds:**
  - `promote`: hash-bound, never granted by `--yes`, with its refusal texts in `HASH_BOUND`;
  - `github-settings`: granted interactively, or by `--yes` like `github-secrets`.
- **Paths:** `ResolveProjectPathsOptions.environment` (the type here, the layout in T1503).
- **Readers and writers:** every `switch` on `target.provider` gets its `localhost` branch, or a refusal where localhost doesn't apply. That's retarget, Portainer-only code and cloud-only pricing.

### 2. Pins and the local CA (T1501b)

- **The runner pin:** `TOOLS.githubRunner` with the version and a SHA-256 per `linux-x64`, `linux-arm64`, `win-x64`, `osx-x64` and `osx-arm64`. `update-pins.mjs` reads them from the release body's `BEGIN SHA` markers.
- **Core crypto:**
  - `localCaCertificate(key, { commonName, days })`: CA:TRUE, keyCertSign.
  - `signedLeafCertificate({ caKey, caCertificate, key, hostnames, days })`: SAN DNS names and serverAuth.
  - Tests check them with `node:crypto`'s `X509Certificate`, and with `openssl verify` where it is installed.

### 3. The spike (T1502, lead)

Research's open items 1–10, run mostly in parallel with wave 1. The results go into research.md
as "Spike results", one line per item. Items 6 and 9 run on this Windows computer, 7 and 8 in a
throwaway CI workflow, and 1–5 on the throwaway repository and a throwaway Hetzner server.

### 4. Paths per environment (T1503)

- **Prod:** today's paths, unchanged.
- **Any other environment:**
  - `opscrew/environments/<env>/`: `plan.yaml`, `RUNBOOK.md`, `SECURITY_REPORT.md`, the runtime folder and `secrets.sops.json`;
  - `.opscrew/environments/<env>/`: state, approvals, saved plans, `tfstate/`, `cloudflare.json` and `server.json`;
  - `<project home>/environments/<env>/`: generated values, the deploy key, `known_hosts` and the state passphrase.
- **Shared, at today's paths:** `architecture.json`, `ARCHITECTURE.md`, the scan report, `opscrew/proxy/` (additions) and `requirements.yaml`. An environment's own answers live in `opscrew/environments/<env>/requirements.yaml`, and only the answers that differ.
- **The state file:** `stateFile()` becomes `<env>.tfstate`, `prod.tfstate` for prod as today.
- **Listing:** `environmentsOf(root)`: prod, plus every `opscrew/environments/*/plan.yaml`.

### 5. The GitHub connector (T1504)

- **Environments:** `putEnvironment`, `getEnvironment`, `deleteEnvironment`.
  - `environmentCapability(repo)`: create the environment, read it back, compare the rules. It returns `{ environments, branchPolicies, reviewers }`.
- **Environment secrets:**
  - the public key, put and delete, with the same sealed box as repository secrets;
  - **environment variables:** put and delete, for the deployed digest where useful.
- **Runners:**
  - `runnerRegistrationToken`, `runnerRemoveToken`, `listRunners`, `deleteRunner`;
  - the tokens are redacted on receipt.
- **The fork-PR policy:** get and put, through `forkPrApprovalPolicy` and `setForkPrApprovalPolicy`.
- **Dispatch:** `dispatchWorkflow(path, ref, inputs)`, and finding the run it started.
- **GHCR:**
  - `imageManifest(ref)`;
  - `imageProvenance(digest)`: the attestation manifest's in-toto SLSA provenance, giving the repository, the workflow, the ref and the commit;
  - `taggedDigest(tag)`.
- **Tests:** fakes for every endpoint, including a Free private repository's environment that comes back with no rules.

### 6. Workflows per environment (T1505)

- **One workflow file per environment:** `opscrew-deploy.yml` for prod, as today, and `opscrew-deploy-<env>.yml` for the others.
  - **An environment that follows main:** `push` on `cicd.branch`, then build, deploy, and its after-deploy jobs.
  - **A promoted one:** `workflow_dispatch` only, with a `digest` input, then a verify job and a deploy job. It has no build job.
- **The deploy job:**
  - `environment: <name>` only where GitHub environments are in use;
  - its secrets are the environment's names, or the `OPSCREW_<ENV>_*` names;
  - `runs-on` per the runner choice: `ubuntu-latest`, or `[self-hosted, opscrew-<app>-<env>]`;
  - `concurrency: opscrew-deploy-<app>-<env>`, with `cancel-in-progress: false`.
- **The verify job** (promoted environments) runs on GitHub's machines. It reads the build run from the image's provenance and checks, through the API with the job's token, that the run is this repository's, on the default branch, at the image's commit. When the app signs images (012), it checks the cosign signature too. Then the deploy job runs `needs: verify`.
- **After a healthy deploy,** the deploy job tags the digest `opscrew-<env>` and the previous one `opscrew-<env>-previous`, with `packages: write`, through a tag-only `imagetools create`. Retention never deletes a version that carries an `opscrew-` environment tag.

### 7. Localhost templates (T1506)

- **`renderCompose` for localhost:**
  - data mounts become named volumes, as the local Docker pass does today;
  - published ports are `127.0.0.1:<port>`;
  - no `opscrew-edge` network setting beyond what the edge needs.
- **The edge for localhost:**
  - **Caddy:** `tls <cert> <key>` for each local hostname, and `auto_https disable_redirects` replaced by an explicit redirect.
  - **nginx:** a `server` block per hostname with the leaf certificate.
  - **Both:** listen on the chosen ports. No ACME, no certbot, no origin TLS, no web filter.
- **The switch scripts:** `APPS_DIR` and `EDGE_DIR` become script variables, `/srv/apps` and `/srv/edge` on a server. Every path in the scripts is built from them. The server's rendered output stays byte-identical (snapshot).

### 8. The server's runner as a host step (T1507)

- **`github-runner`** comes after `app-record`. It:
  1. makes `/srv/opscrew/runner/<app>-<env>`, owned by `deploy`;
  2. downloads the pinned tarball and checks it;
  3. extracts it as `deploy`;
  4. runs `installdependencies.sh` (root);
  5. runs `config.sh --unattended --url <repo> --token <stdin> --name <host>-<app>-<env> --labels opscrew-<app>-<env> --work _work` as `deploy`;
  6. runs `svc.sh install deploy`, then `svc.sh start`.
- **The registration token** reaches the script only on stdin, read into a variable that is unset afterwards. It is never in the plan: the plan says "a registration token fetched at apply".
- **Inspect** reads the service's state and the runner's version.
- **Teardown:** `svc.sh stop` and `uninstall`, then `config.sh remove --token <stdin>`, then the folder is removed.
- **Tests:** a fake host, the script snapshot, and the token absent from the plan, its hash and every log.

### 9. Agents: environments (T1508a, T1508b)

- **T1508a:**
  - **`env add <name>`** asks only the environment's own questions (target, size, hostname, deploy source, runner). It writes `opscrew/environments/<name>/requirements.yaml` and runs design for it.
  - **Design per environment:** the shared parts are copied from prod's plan, with `app.name` set and the hostnames derived, and the cost shown.
  - **`env list`** shows each environment: its target, its source, its runner and whether it is deployed.
  - **`env remove`** refuses while the environment is deployed; destroy comes first.
  - **`--env` resolution:** the only environment by default. With several, an interactive run asks and a script fails with the list.
  - **The shared-parts check** runs in provision's preflight.
  - **The phases** get their paths through the resolved environment.
- **T1508b:**
  - **Secrets per environment:** the capability check, then a GitHub environment (with its creation under `github-settings`), or prefixed repository secrets.
  - **Destroy per environment** removes its secrets and its GitHub environment (`github-settings`), and keeps every other environment's.
  - **A changed GitHub plan** moves the secrets, as a planned change.

### 10. Agents: promote (T1509)

`opscrew promote --to <env> [--digest <sha256>]`:
1. **The source:** the `deploySource.source` environment. Its digest is the `opscrew-<source>` tag, or the given digest for a rollback, which must be a version labelled `opscrew-<target>-previous` or `opscrew-<source>`.
2. **The provenance:** the image's SLSA v1 provenance names its build run (`runDetails.builder.id`). That run must belong to this repository and, per its API record, have run on the default branch at the commit the image is tagged with. The signature is checked when the app signs images (spike result 2).
3. **The target's plan:** its pending changes must be none, or the user is sent to `provision --env <target>` first.
4. **The `promote` approval:** its hash is `sha256(canonical{ target, source, digest, targetPlanHash })`.
5. **The dispatch,** then waiting for the run, then recording the digest in the target's state.

Refusals: no deployed source, a failed provenance check, a target with pending infrastructure, or a
deploy of the target already running (it waits instead).

### 11. Agents: localhost (T1510)

- **The provider profile** `localhost`: no token, no API, no price.
- **The preflight:**
  - Docker running (`docker info`), Compose v2.23 or newer;
  - memory: the sum of limits against `MemTotal`;
  - the ports free (probe 443/80, else 8443/8080);
  - on Windows, Git for Windows' bash found;
  - Docker Desktop's licence note, once.
- **The local executor:** a `RemoteExec` that runs the rendered scripts with the local shell, with `APPS_DIR`/`EDGE_DIR` set to `<OpsCrew home>/local/srv/…`, through the injected runner.
- **The local plan:** the containers, volumes and networks to create, and the certificate to issue. It is hashed and approved as `host-apply`.
- **The image:** the production digest from GHCR when the architecture matches. Otherwise a local `docker build` for Dockerfile apps, or the production image under emulation with a warning.
- **The local CA:** made on first use in `~/.opscrew/local-ca/`. `localhost trust|untrust` runs the OS command, after showing it:
  - macOS: `security add-trusted-cert` into the login keychain;
  - Windows: `certutil -user -addstore Root`;
  - Linux: the NSS database, plus the system store with sudo when asked.
- **verify, status, drift and destroy for localhost:** the same checks through 127.0.0.1, with the Host header and SNI. `destroy` removes OpsCrew's containers, networks and folders, and the volumes only with `--delete-data`.

### 12. Agents: runners (T1511)

- **`runner: server`** adds the `github-runner` step to the host plan. Before that, provision checks:
  - the repository's visibility;
  - for a public one, the fork-PR policy. Setting it to `all_external_contributors` is a `github-settings` change.

  At apply, it fetches the registration token through the connector and gives it to the step.
- **`runner: local`:** `opscrew runner start --env <env>` downloads the pinned runner for this computer, then:
  1. checks it;
  2. fetches a registration token;
  3. configures `--ephemeral` with the label `opscrew-<app>-<env>`;
  4. runs it in the foreground.

  On exit it removes itself through the API. The runner folder lives in the user's OpsCrew home.
- **Status and secure:** online or offline; the version against the pin and GitHub's latest (from `listRunners`); the repository's visibility. A public repository with a runner is a high finding.

### 13. Surfaces and guide (T1512)

- **The CLI:**
  - `--env <name>` on provision, destroy, drift, status, verify, secure, retarget, secrets and promote;
  - `opscrew env add|list|remove`;
  - `opscrew promote`;
  - `opscrew localhost trust|untrust`;
  - `opscrew runner start`.
- **MCP:** an `environment` input on every deployment tool, and `opscrew_promote` with the approval dialog.
- **The guide:** new pages `environments.md`, `localhost.md` and `runners.md`. Each page that needs it gets an environment section (own server, Portainer, Cloudflare, secrets recovery, zero-downtime).
- **The runbook** is per environment.
- **The plugin:** the deploy skill learns environments and promotion.

### 14. The Docker pass and CI (T1513)

- **The Docker pass** (`OPSCREW_DOCKER_TESTS=1`): `opscrew design` and `provision` for localhost with the real CLI on this computer. Then:
  - the site answers at `https://<app>.localhost:<port>` through the local CA;
  - a second environment answers beside it;
  - destroy leaves nothing.
- **The CI workflow** in OpsCrew's repository:
  - **ubuntu-latest:** the same pass;
  - **macos-15-intel:** Colima, the same pass, non-blocking;
  - **windows-latest and macos-latest:** the localhost unit and command tests with Docker faked.

### 15. Live tests and runs (T1514, T1515)

- **Hetzner, environments and promotion:**
  1. staging is added to a prod app, provisioned and deployed;
  2. prod's plan hash and site stay unchanged throughout, under load;
  3. promote to prod;
  4. prod runs the identical digest;
  5. a rollback by promotion;
  6. destroy staging, and prod keeps working.
- **The server's runner:** on prod. Then the deploy succeeds with the firewall refusing SSH from GitHub's address ranges. Then removal.
- **The Free private repository case:** prefixed secrets and OpsCrew's approval.
- **Leak search:** the runner token, every environment's generated values, and the local CA key.

## Order

1. **Wave 1:** T1501a (contracts) and T1501b (pins, the local CA). The spike T1502 runs alongside.
2. **Wave 2:** T1503 (paths), T1504 (GitHub connector), T1505 (workflows), T1506 (localhost templates) and T1507 (runner step). Their Owns are disjoint.
3. **Wave 3:** T1508a (environments in agents).
4. **Wave 4:** T1508b (secrets and destroy per environment), T1509 (promote) and T1510 (localhost): provision secrets, promote/, and the localhost files.
5. **Wave 5:** T1511 (runners), after T1508b and T1510, which share the provision wiring.
6. **Wave 6:** T1512 (surfaces and guide), then T1513 (the Docker pass and CI).
7. **Wave 7:** T1514 (live tests), then T1515 (live runs, lead), then T1516 (the simplify pass).

## Complexity Tracking

| Choice | Why it is needed | The simpler option, and why not |
|---|---|---|
| A full plan per environment, with copied shared parts and a check | Every phase keeps reading one complete plan; the files stay readable | One plan with an overlay: a merge layer behind about 20 writers (R6) |
| A new approval kind, `promote` | A promotion deploys to a live environment and must be bound to the image as well as the plan | Reusing `iac-apply`: it binds no image digest |
| A local executor running the server's scripts on the user's computer | The localhost deploy must be the production deploy, not a copy of it | A TypeScript re-implementation, or a helper container whose bind mounts would not resolve (R4) |
| A persistent server runner | A one-job runner would need an Administration-write token on the server | JIT or ephemeral runners (R3) |
