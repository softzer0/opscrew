# Research: Environments, local runs and runners (015)

Consolidated on 2026-10-21 from four notes. Three are Sonnet research on official sources only:
`.tools/scratch/015-environments.md`, `015-runners.md` and `015-localhost.md`. The fourth is a Haiku
code map, `015-codemap.md`. Each item gives the decision, the facts behind it, and what else was
considered. The open items for the spike (T1502) are at the end.

## R1. GitHub environments by plan

**Decision:**
- OpsCrew checks what the repository supports, never assuming: it creates the environment, reads
  it back, and compares the protection rules it asked for with those GitHub shows.
- Where environments work, each environment's deploy secrets live in a GitHub environment of the
  same name.
- Elsewhere they are repository secrets named `OPSCREW_<ENV>_<NAME>`. Prod keeps today's
  unprefixed names in both cases.
- Required reviewers are set only where the read-back shows them enforced. Without them, the
  approval is OpsCrew's own (R2), and the guide says plainly what that protects against.

**Facts:**
- GitHub's environments page: "Users with GitHub Free plans can only configure environments for public repositories." The REST page is stricter: "Private or internal repositories require GitHub Pro, GitHub Team, or GitHub Enterprise for environments, environment secrets, and deployment branches", and "On GitHub Free, Pro, or Team, other protection rules, such as wait timers and required reviewers, work only in public repositories". So for a private repository:

  | Feature | Free | Pro / Team | Enterprise |
  |---|---|---|---|
  | Environments, environment secrets and variables | no | yes | yes |
  | Deployment branch and tag policies | no | yes | yes |
  | Required reviewers, wait timer, custom rules | no | no (one sentence, to confirm) | yes |

  Public repositories get everything on every plan. If a repository turns private on Free, its rules and environment secrets are ignored.
- **API:**
  - `PUT /repos/{o}/{r}/environments/{name}` takes `wait_timer`, `prevent_self_review`, `reviewers` (up to 6) and `deployment_branch_policy`.
  - Branch and tag policies go through `.../deployment-branch-policies` and need `custom_branch_policies: true`.
  - Environment secrets: `.../environments/{name}/secrets/public-key`, then a `PUT` with the libsodium sealed box, as for repository secrets.
  - Environment variables: `POST` and `PATCH`.
- **Fine-grained token permissions:**
  - **Administration: write**: environments and branch policies;
  - **Environments: write**: environment secrets and variables;
  - **Deployments: read**: history.
- **Precedence:** "the secret at the lowest level takes precedence", so an environment secret wins over a repository secret of the same name.
- **Limits:** 100 secrets per environment and per repository, 48 KB each. No documented limit on environments per repository.
- **Waiting:** a job waiting for reviewers fails after 30 days. Prevent-self-review blocks the person who started the run, even when they are a reviewer.

**Alternatives:**
- **Always use GitHub environments:** fails silently on Free private repositories, which is most of the audience.
- **Always prefixed repository secrets:** loses GitHub's own protection where the user pays for it.

## R2. Promotion of the same image

**Decision:**
- Each environment's deploy is a workflow of its own (R6).
- The environment that follows main builds the image and deploys it on each push.
- `opscrew promote --to <env>` reads the digest the source environment runs, from its GHCR label tag (below). It checks the image's provenance: the repository, the workflow and the commit in the buildx provenance in the image index, plus the cosign signature when the app signs images (feature 012).
- It then shows the target's plan, and dispatches the target's workflow with the digest as input, after a new hash-bound approval kind, `promote`. That approval binds the target plan's hash, the digest and both environment names.
- The deploy job deploys `image@sha256:…`. Nothing is rebuilt.
- **Retention labels:** each environment's deploy tags its digest `opscrew-<env>`, and the one before it `opscrew-<env>-previous`. These tags are only labels; the deploy references the digest. Retention never deletes a version that carries an `opscrew-` environment tag.

**Facts:**
- A tag is a pointer to a digest. Adding a tag to an existing manifest (`docker buildx imagetools create --tag`) keeps the digest, so provenance and signatures, which are bound to the digest, stay valid. This is general OCI behaviour, and the spike confirms it.
- `workflow_dispatch` runs only if the workflow file is on the default branch. Input types include `string` and `choice`.
- Concurrency is any string: one group per environment with `cancel-in-progress: false` serialises its deploys (FR-1523).
- Feature 012's research: GitHub artifact attestations on private repositories may need Enterprise. That's why provenance comes from buildx's own in-toto provenance in the image (mode=max, already produced), and the signature from cosign, when the user opted in.

**Alternatives:**
- **A `needs` chain in one run** (staging, then prod behind reviewers): exact, but one run holds a 30-day approval window, and it cannot "promote later" or roll back.
- **Retagging as the deploy reference** (`:prod`): a moved tag would change what runs. Rejected.
- **Rebuilding per environment:** not the same image. Rejected (spec).

## R3. Self-hosted runners

**Decision:**
- **The server's runner** is a persistent repository-level runner, installed by a new host plan step `github-runner`.
  - It is the pinned runner version, checked by the SHA-256 in the release body, and runs as the existing `deploy` user.
  - It has the label `opscrew-<app>-<env>`, with auto-update left on.
  - A registration token is fetched by the CLI while the plan is applied and passed over SSH's stdin. It is never written to a plan, a log or the server's disk, beyond what `config.sh` itself keeps.
  - Teardown runs `config.sh remove` with a fresh remove token, falling back to `DELETE …/runners/{id}`.
- **The local runner:** `opscrew runner start --env <env>` registers an ephemeral runner on the user's computer. It runs one session in the foreground, as the user, and unregisters at stop.
- **Public repositories:** refused, unless the repository's fork-PR approval policy is `all_external_contributors`. OpsCrew sets that only through its own approved change.

**Facts:**
- **Tokens:** registration and remove tokens (`POST /repos/{o}/{r}/actions/runners/registration-token`, `…/remove-token`) last one hour. Fine-grained: **Administration: write**; listing needs read.
- **Personal repositories:** repository-level runners work there, but only the owner may add them.
- **JIT runners** (`generate-jitconfig`) run one job. Each job would need a fresh config, so a supervisor would have to hold an Administration-write token on the server. That's worse than a persistent runner (decision above).
- **The runner app:** v2.338.0 (2026-10-06), from `github.com/actions/runner/releases/download/v{V}/actions-runner-{os}-{arch}-{V}.tar.gz`. The SHA-256 of each asset sits in the release body between `BEGIN SHA <asset>` and `END SHA` comments.
- **Platforms:** Linux x64/arm64, Windows x64, macOS x64/arm64.
- **Service and dependencies:** `svc.sh install <user>` creates a systemd service. `bin/installdependencies.sh` needs root once.
- **Updates:** auto-update is on by default. With it off, a runner must update within 30 days of any release, or GitHub sends it no jobs.
- **Network:** outbound HTTPS 443 only. The essential domains are `github.com`, `api.github.com` and `*.actions.githubusercontent.com`; the rest are in the notes. No inbound port is listed.
- **Security:**
  - GitHub says self-hosted runners "should almost never be used for public repositories".
  - A persistent runner keeps `_work`, caches, images and anything written outside the workspace between jobs.
  - Docker group membership is root-equivalent; Docker says only trusted users should control the daemon. The deploy user already runs `docker compose` today, so a runner as `deploy` adds no privilege. Today anyone who can push to the default branch can already change the workflow and run code as `deploy` over SSH.
- **Fork-PR approval API:** `PUT /repos/{o}/{r}/actions/permissions/fork-pr-contributor-approval`, with `approval_policy` set to `all_external_contributors`, needs Administration: write.
- **Cost and limits:** self-hosted minutes are free. A $0.002/min charge for private repositories was announced, then postponed with no date; re-check before release. 1,500 registrations per 5 minutes per repository.
- **On Windows,** container actions need Linux, so the local runner's jobs use `run:` steps only, with `shell: bash`.

**Alternatives:**
- **JIT or ephemeral runners on the server:** above.
- **A runner in a container with the Docker socket:** the same root exposure, plus an unofficial image (`ghcr.io/actions/actions-runner` has no stated use outside ARC).
- **Rootless Docker for the runner:** it could not manage the root daemon's stacks.

## R4. The localhost target

**Decision:**
- **The target:** a new provider `localhost`.
- **Running the deploy:**
  - The production switch scripts run on the user's computer with the host's POSIX shell: `sh` on macOS and Linux; on Windows, Git for Windows' bash, which OpsCrew's git use already needs.
  - The scripts' root folders become variables (on a server `/srv/apps`, `/srv/edge`; on localhost a folder under the user's OpsCrew home).
  - The data folders become named volumes.
- **The edge** binds to 127.0.0.1, on 443 when free, else 8443, and on 80, else 8080.
- **Hostnames:** `<app>.localhost`, and `<env>.<app>.localhost` beside other environments.
- **Certificates:** both proxies use OpsCrew's local certificate authority. Its key is 0600 in `~/.opscrew/local-ca/` and its leaf certificates come from the existing P-256 and DER code in core.
- **Trust:** `opscrew localhost trust` runs the OS command, and `untrust` removes it.
- **The image:**
  - When the computer's architecture matches production's, it is the production image from GHCR by digest, byte-identical.
  - Otherwise it is built locally for the computer, with `docker build`, for Dockerfile apps. A Buildpacks or Railpack app on a different architecture runs the production image under emulation, with a warning.
- **Approval:** the localhost stack is a local plan (containers, networks, volumes, certificates), approved with the existing `host-apply` kind.

**Facts:**
- **Licence:** Docker Desktop is free for personal and open-source use, and for companies with fewer than 250 employees AND under US$10M revenue. Governments always pay. Docker Engine is free, and Colima, Rancher Desktop and Podman are free alternatives.
- **Memory:** the Desktop VM defaults to 50% of host memory. On WSL2 it is set in `.wslconfig`. Containers' memory limits are cgroup limits inside the VM, so their sum must fit (a check).
- **Hostnames:** RFC 6761 says resolvers SHOULD map `*.localhost` to loopback. Browsers do. Other tools on Windows may not, so OpsCrew's own checks connect to 127.0.0.1 with the Host header and SNI.
- **Caddy's own local CA** lives in its data volume, and Caddy "is not guaranteed" to install it into the host's trust stores from a container. One OpsCrew CA for both proxies avoids that, and gives nginx certificates too.
- **Trust:**
  - macOS: `security add-trusted-cert`;
  - Windows: `certutil -user -addstore Root`, per user, with a confirmation dialog and no admin;
  - Linux: the NSS database for browsers, plus the system store with sudo.
- **Ports:** 80 may be taken on Windows (IIS, HTTP.sys); macOS ports below 1024 had a privileged helper up to Docker Desktop 4.88.
- **Emulation:** Apple silicon runs amd64 images under QEMU, or under Rosetta when enabled (off by default). The official database images are multi-arch, so only the app's image is amd64.
- **Restarts:** `restart: unless-stopped` brings containers back when Docker starts. Docker Desktop on Windows starts only after login.

**Alternatives:**
- **Running the scripts in a helper container with the Docker socket:** bind-mount paths would be resolved on the daemon's host, not in the helper, so the edge's relative mounts would break.
- **Re-implementing the switch in TypeScript for localhost:** no longer the same deploy logic.
- **Caddy's `tls internal`:** no certificates for nginx, and the root sits in a volume.
- **mkcert:** a new tool to fetch, for what core already does.

## R5. CI on macOS and Windows

**Decision:**
- **OpsCrew's own CI** runs the localhost integration with real Docker on `ubuntu-latest`.
- **macOS:** a Colima smoke job on `macos-15-intel`, non-blocking at first, since Intel images have a shelf life. `macos-latest` (arm64) and `windows-latest` run the localhost unit and command tests with Docker faked.
- **Windows with real Docker** is checked by hand on the founder's computer.
- **Apple silicon with real Docker** is listed as not tested live.

**Facts:**
- **macOS labels:** `macos-15-intel` and `macos-26-intel` are x64. `macos-latest`, `-14`, `-15` and `-26` are arm64 M1, which has no nested virtualisation, so Colima cannot start a VM there. `macos-13` is no longer listed.
- **Windows runners:** they run Windows containers only, so no Linux containers (to confirm).
- **ubuntu-latest** has Docker Engine.

## R6. The code map (what the feature touches)

**Decision:**
- **Plans:** every environment has a full `plan.yaml` of its own: prod's at `opscrew/plan.yaml`, any other at `opscrew/environments/<env>/plan.yaml`.
- **Paths:**
  - `resolveProjectPaths(root, { environment })` returns that environment's files. For prod they are today's paths.
  - For any other environment: its plan, runbook, security report, runtime files and recovery copy go under `opscrew/environments/<env>/`. Its state and records go under `.opscrew/environments/<env>/`, and its generated values and deploy key under `<project home>/environments/<env>/`.
  - Its infrastructure root is `opscrew/infra/<env>`, and its state file `<env>.tfstate`.
- **Shared parts:** the app's build, components, port and health route are copied from prod's plan by `design`. `provision` refuses when an environment's copy differs, and says to run `opscrew design --env <env>`.
- **App name:** each environment's `app.name` is `<app>-<env>` (prod keeps `<app>`), so two environments can share a server, a Portainer and a zone.
- **Why it fits the code:** nearly every per-deployment file already goes through `paths.files`, so most phases need no change beyond the paths. The ~200 provider branches in agents gain `localhost` only where it differs.

**Facts (from the code map):**
- **Paths:** `core/src/paths.ts` `resolveProjectPaths` builds every file from `artefactsDir`, `stateDir` and `projectHomeDir`.
- **Hard-coded prod:**
  - `agents/src/shared/engine.ts` `stateFile()` hard-codes `prod.tfstate`;
  - `plan.infra.dir` defaults to `opscrew/infra/prod`;
  - the deploy job names `environment: production` (`iac-templates/src/workflow/shared.ts`), but OpsCrew never fills it;
  - the deploy job's `runs-on` is the default `ubuntu-latest`.
- **Approval kinds:** `contracts/src/safety.ts` and `core/src/approvals.ts`. The hash-bound ones are `iac-apply`, `host-apply`, `stack-apply` and `cloudflare-apply`.
- **Host plan steps:** `connectors/ssh-host/src/types.ts` `HOST_STEP_IDS`, in the order set by `plan.ts` `planHost`. A `github-runner` step fits after `app-record`.
- **The local Docker pass** (`cli/test/e2e/edge-support.ts`) already runs the rendered edge commands with `sh` on this Windows computer: 127.0.0.1 ports, a local CA, probes with a Host header. It is the model for the localhost target.

**Alternatives:**
- **One `plan.yaml` with an `environments:` overlay,** and a merged view at read time: less duplication, but every read and write of the plan would go through a merge layer (about 20 writers). Rejected as the larger change.

## Open items for the spike (T1502)

1. **GitHub environments on a Free private repository** (the throwaway repository):
   - what `PUT environments/x` returns;
   - whether environment secrets reach a job;
   - what a job that names an environment does there.

   On a public repository: what the read-back shows for reviewers.
2. **Retagging:** `imagetools create --tag` keeps the digest, and the provenance and cosign signature still verify afterwards. And can the GITHUB_TOKEN with `packages: write` add the tag?
3. **Promotion dispatch:** `workflow_dispatch` with `environment` and `digest` inputs, started by the CLI through the GitHub connector, with concurrency per environment.
4. **The runner, end to end on a throwaway Hetzner server:**
   - download and checksum;
   - `installdependencies.sh` on Ubuntu 24.04;
   - `config.sh --unattended` with a token from the API (fine-grained Administration write);
   - `svc.sh install deploy`, then a job running `docker compose` as `deploy`;
   - with inbound SSH from everywhere but the test's own address blocked, the job still runs;
   - removal.
5. **The fork-PR approval PUT** with a fine-grained token.
6. **Localhost on this Windows computer** (Docker Desktop, WSL2):
   - the switch scripts under Git Bash with variable roots;
   - bind mounts of the edge's files from the user's OpsCrew home;
   - named volumes for data;
   - 127.0.0.1 ports 443 and 8443;
   - `certutil -user -addstore Root` and the browser seeing no warning;
   - whether `app.localhost` resolves for curl and Node (or only through the Host header);
   - the sum of memory limits against `docker info`.
7. **Localhost on Linux** in a GitHub `ubuntu-latest` job: the same scripts, with ports 443/80 (root daemon).
8. **`macos-15-intel` with Colima:** whether it exists and starts, how long it takes, and the memory left. Confirm `windows-latest` cannot run Linux containers.
9. **The local runner on Windows:** `run.cmd` as the user, a `run:` step with `shell: bash` running `docker compose` against Docker Desktop, and the runner unregistering when stopped.
10. **The local CA's leaf certificates** in both proxies, with SNI for `<app>.localhost` and `<env>.<app>.localhost`.
