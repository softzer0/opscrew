---
description: "Tasks for 015-environments-runners"
---

# Tasks: Environments, local runs and runners

**Input**: `specs/015-environments-runners/`:
- spec.md, plan.md, research.md (R1–R6 and the open items), data-model.md;
- contracts/{environments,runners,localhost}.md, quickstart.md;

plus `docs/adr/0018-environments-localhost-runners.md`, and features 000–014.

**Numbering**: T1501–T1599.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- **Fixtures** never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with `materializeFixture()`. A key or a certificate in a fixture is generated at test time, never committed.
- **No network:** no test touches the network, a real cloud, a real GitHub or a model. Tests that need Docker, `sh` or `openssl` skip with a clear message when the tool is absent.
- **No leaks:** no runner token, local CA key, deploy secret or generated value appears in a plan, a log, an audit entry, a report, a snapshot, an MCP response or infrastructure state (SC-1506). Every task's tests include a leak check for the values it handles.
- **Approvals:** every change goes through its plan, approved by its hash: the localhost stack and the runner as `host-apply`, a promotion as `promote`. GitHub settings go through their approval kind, `github-settings` (SC-1508).
- **Prod is untouched:** a server's rendered output and prod's paths stay byte-identical where this feature does not mean to change them (snapshots).
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** write long files with the Write or Edit tool, not shell heredocs (Windows Defender blocks some).

## Phase 1: Foundation

- [X] T1501a Contracts: the `environment` block, the `localhost` target, the approval kinds `promote` and `github-settings`, `ResolveProjectPathsOptions.environment`, in `packages/plan-schema/**`, `packages/contracts/**`, `packages/core/src/approvals.ts`, `packages/core/src/paths.ts` (the option type only), and every reader and writer of the changed types
  - Owns: those paths (+ the generated JSON schema, tests and fixtures); the `switch`/`if` sites on `target.provider` across packages, for the `localhost` branch or a plain refusal only
  - Reads: data-model.md "Environment", "Localhost target", "Approval kinds"; contracts/environments.md "Paths"; plan.md "1."; research.md R6; ADR 0018
  - Depends: —
  - Accept:
    - **`plan.environment`** (`name`, `deploySource`, `runner`, `secrets`), with the rules quoted from data-model.md:
      - `name` matches `^[a-z][a-z0-9-]{0,15}$`, never `prod`;
      - `deploySource.source` never names the environment itself;
      - `runner: server` only with a cloud or own-server target, `runner: local` only with localhost.

      Absent means prod.
    - **The localhost target** joins `DeployTargetSchema` and `DeployProviderSchema` (not `VpsProviderId`): `{ provider: "localhost", mode: "local-compose", arch, ports: { https: 443|8443, http: 80|8080 }, image: "registry"|"local-build", edge }`. With it, `dns.provider` is `none`.
    - **Approval kinds:**
      - `promote` is hash-bound, with its refusal texts and `--approve <hash>` hint in `HASH_BOUND`, and never in the `--yes` set;
      - `github-settings` is not hash-bound, granted by `--yes` like `github-secrets`.

      Both are in contracts' `ApprovalKind`, and in core's `APPROVAL_KINDS` with `satisfies`.
    - **`ResolveProjectPathsOptions.environment?: string`** and `ProjectPaths.environment`: only the types. The layout is T1503's; until then `environment` other than prod throws `INVALID_INPUT` "not supported yet".
    - **Every `switch` on `target.provider`** compiles with `satisfies never`. Each gets a `localhost` branch where the meaning is clear (no price, no region, no server type), or a plain refusal naming the feature. Retarget refuses localhost.
    - **Tests:** the schema rules (each refusal with its message), round-trips of a plan with an environment and with a localhost target, and the approval kinds' texts.
  - Verify: `pnpm turbo run typecheck test --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1501b [P] Pins: the runner, and the local CA in core crypto, in `packages/iac-templates/src/pins.ts`, `packages/iac-templates/scripts/**`, `packages/core/src/crypto/**`
  - Owns: those paths (+ tests); `packages/core/src/index.ts` for the new exports only
  - Reads: contracts/runners.md "The pin"; contracts/localhost.md "Local CA"; research.md R3, R4; plan.md "2."
  - Depends: —
  - Accept:
    - **`TOOLS.githubRunner`:** the version 2.338.0, with a URL and SHA-256 for `linux-x64`, `linux-arm64`, `win-x64`, `osx-x64` and `osx-arm64`.
      - `update-pins.mjs` reads them from the release body's `BEGIN SHA <asset>` and `END SHA <asset>` markers, and refuses a release whose body lacks one.
      - Run it once and commit the real values.
    - **`localCaCertificate` and `signedLeafCertificate`,** as contracts/localhost.md says:
      - the CA: CA:TRUE with pathlen 0, keyCertSign and cRLSign;
      - the leaf: SAN DNS names, digitalSignature and serverAuth, issued by the CA's subject, with an authority key identifier.
    - **Tests:**
      - `node:crypto`'s `X509Certificate` checks the issuer, the SANs and `checkIssued`;
      - `openssl verify -CAfile` passes where `openssl` is installed;
      - a leaf for `a.localhost` and `staging.a.localhost`;
      - no private key in any output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/core` and `pnpm lint`
  - Effort: high

## Phase 2: Spike (lead)

- [ ] T1502 The spike (lead), research.md's open items 1–10, run alongside wave 1 on the throwaway repository, a throwaway Hetzner server, this Windows computer and a throwaway CI workflow. The results go into research.md as "Spike results", one line per item: what was run, and what was seen. They decide the open details of T1504–T1511, and any finding that changes a design goes back into plan.md before wave 2.

## Phase 3: Packages (parallel)

- [ ] T1503 [P] [US2] Paths per environment, in `packages/core/src/paths.ts`, `packages/core/src/environments.ts` (new)
  - Owns: those paths (+ tests); `packages/core/src/index.ts` for the new exports only
  - Reads: data-model.md "Paths per environment"; contracts/environments.md "Paths"; plan.md "4."
  - Depends: T1501a
  - Accept:
    - **`resolveProjectPaths(root, { environment })`:**
      - prod, or no environment, gives today's paths exactly (a snapshot of every field);
      - any other environment gives its own artefacts, state and project-home folders, per data-model.md;
      - `files.shared` holds the paths every environment shares.
    - **`environmentsOf(root, fs)`:** `prod` when `opscrew/plan.yaml` exists, then every `opscrew/environments/*/plan.yaml`, in order of their deploy source (each after its source). It is zod-checked when reading.
    - **`tfstateFile(paths)`:** `<env>.tfstate`, and `prod.tfstate` for prod.
    - **Tests:** prod unchanged; two environments; an unknown name (`INVALID_INPUT` with the list); Windows and POSIX paths.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core` and `pnpm lint`
  - Effort: high

- [ ] T1504 [P] [US2] [US3] [US4] The GitHub connector: environments, environment secrets, runners, the fork-PR policy, dispatch, GHCR tags and provenance, in `packages/connectors/github/**`
  - Owns: that path (+ tests and fakes)
  - Reads: contracts/environments.md "GitHub connector"; contracts/runners.md "GitHub connector"; research.md R1–R3 and "Spike results"; plan.md "5."
  - Depends: T1501a, T1502
  - Accept:
    - **Every call in both contracts,** zod-checked:
      - `putEnvironment`, `getEnvironment`, `deleteEnvironment`, `environmentCapability`;
      - `environmentPublicKey`, `setEnvironmentSecret` (sealed locally), `deleteEnvironmentSecret`;
      - `runnerRegistrationToken` and `runnerRemoveToken`, each registered with the redactor on receipt;
      - `listRunners`, `deleteRunner`;
      - `repositoryVisibility`, `forkPrApprovalPolicy`, `setForkPrApprovalPolicy`;
      - `dispatchWorkflow`, which finds the run it started;
      - `taggedDigest`;
      - `imageProvenance`, which reads the image index, its attestation manifest and the in-toto SLSA provenance from GHCR's registry API with the user's token.
    - **`environmentCapability`** reports exactly what GitHub enforced on read-back. Spike item 1 sets what a Free private repository returns.
    - **Errors:** a 403 on the runner or environment endpoints names the missing permission (Administration or Environments), and never prints the token.
    - **Tests:** the fake GitHub covers every endpoint: a Free private repository's environment coming back without rules, a 404, a 403, and a dispatch whose run appears after a delay.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github` and `pnpm lint`
  - Effort: high

- [ ] T1505 [P] [US2] [US3] [US4] Workflows per environment, in `packages/iac-templates/src/workflow/{index,shared,jobs,retention,build,portainer}.ts`
  - Owns: those files (+ tests, snapshots); `packages/iac-templates/src/index.ts` for the new exports only
  - Reads: plan.md "6."; data-model.md "Deploy secrets per environment", "Promotion"; research.md R2 and "Spike results" 2–3
  - Depends: T1501a, T1502
  - Accept:
    - **The workflow's file and triggers:**
      - prod's file stays `opscrew-deploy.yml`, and any other environment's is `opscrew-deploy-<env>.yml`;
      - an environment with `deploySource.from: main` keeps today's build and deploy on `push`;
      - a promoted one has `workflow_dispatch` with a `digest` input, a verify job on `ubuntu-latest` and a deploy job that needs it, and no build job.
    - **The deploy job:**
      - `environment:` only when `plan.environment.secrets` is `environment`;
      - the secret names per data-model.md;
      - `runs-on: [self-hosted, opscrew-<app>-<env>]` for a server or local runner, else as today;
      - concurrency `opscrew-deploy-<app>-<env>`, never cancelling.
    - **The verify job** checks the digest's provenance (this repository, the default branch) with the pinned tools already in 012's supply-chain jobs. When `supplyChain.sign` is on, it also verifies the cosign signature.
    - **After a healthy deploy,** it tags `opscrew-<env>` and `opscrew-<env>-previous` with a tag-only `imagetools create`. **Retention** keeps every version carrying an `opscrew-` environment tag, besides today's rules.
    - **Prod is unchanged:** a prod-only plan renders exactly today's workflow (the snapshot is unchanged, apart from the label tags, which are new).
    - **Tests:** snapshots for prod only; staging following main with prod promoted; a server runner; prefixed secrets; and retention keeping the label-tagged versions (the retention script against a fake package list).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

- [ ] T1506 [P] [US1] Localhost templates: Compose, the edge with the local CA, and the scripts' root folders, in `packages/iac-templates/src/{edge,runtime}/**`, `packages/iac-templates/src/workflow/switch.ts`
  - Owns: those paths (+ tests, snapshots)
  - Reads: contracts/localhost.md "The script roots", "Localhost Compose and edge"; plan.md "7."; research.md R4 and "Spike results" 6, 7, 10
  - Depends: T1501a, T1502
  - Accept:
    - **The script roots:** every switch, edge and rollback script starts with the `APPS_DIR` and `EDGE_DIR` defaults, and builds every path from them. A server's rendered scripts are otherwise byte-identical (the snapshots change only by those two lines).
    - **`renderCompose` and the edge for a localhost target:**
      - named volumes for data;
      - `127.0.0.1` ports;
      - the leaf certificate paths for Caddy and nginx;
      - no ACME, certbot, origin TLS or web filter, and the catch-all kept.
    - **The localhost edge files** (the sites and the leaf certificate's place in the edge's TLS folder) come from exported render functions, which the local flow (T1510) uses to write them. The GitHub workflow files are T1505's and don't change here.
    - **Tests:** snapshots for both proxies, two localhost environments on one edge, server output unchanged, and the scripts run with `sh` against a temporary root.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

- [ ] T1507 [P] [US4] [US1] The `github-runner` host step, and the local executor, in `packages/connectors/ssh-host/**`
  - Owns: that path (+ tests, fake host)
  - Reads: contracts/runners.md "The host step"; contracts/localhost.md "Local executor"; plan.md "8."; research.md R3 and "Spike results" 4, 6
  - Depends: T1501a, T1501b, T1502
  - Accept:
    - **The step `github-runner`,** after `app-record`: the install of plan.md "8." step by step, as `deploy` except for `installdependencies.sh` and `svc.sh`.
      - The plan names the version, the checksum, the user, the label and the folder, never a token.
      - `applyHostPlan` takes a `runnerToken` callback, called only when the step runs. The token goes on stdin and is unset after use.
    - **Teardown and undo** stop and uninstall the service, remove it with a remove token on stdin, and delete the folder.
    - **Inspect** reports whether the service is active, and the version.
    - **`localExec`:** a `RemoteExec` running a script with `shell -s` through the injected runner, with `OPSCREW_APPS_DIR` and `OPSCREW_EDGE_DIR` set.
    - **Tests:**
      - the fake host and the step's script snapshot;
      - the token absent from the plan, its hash, the fake host's logs and the audit entries;
      - teardown;
      - `localExec` with a fake runner.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host` and `pnpm lint`
  - Effort: high

## Phase 4: The agents

- [ ] T1508a [US2] Environments in agents: `env add/list/remove`, design per environment, the environment choice, and the shared-parts check, in `packages/agents/src/{environments,shared,design,interview}/**`, and every phase's paths
  - Owns: `packages/agents/src/environments/**` (new); the design and interview changes; the phases' path resolution (an `environment` in their inputs); tests
  - Reads: contracts/environments.md "The environment choice", "Commands"; data-model.md "Environment"; plan.md "9."; spec US2, FR-1510–FR-1513, FR-1515–FR-1516
  - Depends: T1503
  - Accept:
    - **`resolveEnvironment`:** the only environment by default. With several, an interactive run asks; a script gets `PHASE_PRECONDITION` with the names and `--env`.
    - **`addEnvironment`** asks only the environment's own questions:
      - the target (localhost, a cloud provider, the user's server, a Portainer);
      - the size, the hostname (`<env>.<domain>` by default), the deploy source and the runner.

      It writes the environment's requirements, designs it, and shows its monthly cost.
    - **Design for an environment** copies the shared parts from prod's plan, sets `app.name` to `<app>-<env>`, derives the hostnames, and writes `plan.environment`.
    - **`listEnvironments`** gives each environment's name, target, source, runner and deployed state. **`removeEnvironment`** refuses while the environment is deployed, and removes its files.
    - **`sharedPartsDiffer(prodPlan, envPlan)`** runs in provision's preflight: `PHASE_PRECONDITION` naming the fields, with the hint `opscrew design --env <env>`.
    - **Every phase** (provision, destroy, drift, status, verify, secure, retarget, secrets) resolves its paths through the environment.
    - **Tests:** an existing prod app is unchanged, with nothing to apply; adding staging; two environments on one own server; the shared-parts refusal; the choice in scripts.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [ ] T1508b [P] [US2] Secrets and destroy per environment, in `packages/agents/src/provision/secrets.ts`, `packages/agents/src/destroy/**` (+ the GitHub settings change)
  - Owns: those paths (+ tests)
  - Reads: data-model.md "Deploy secrets per environment"; plan.md "9."; research.md R1 and "Spike results" 1; FR-1514, FR-1515
  - Depends: T1508a, T1504
  - Accept:
    - **The capability check** runs once per environment, and its answer is written to `plan.environment.secrets`.
    - **`environment`:** the GitHub environment is created (or updated) under a `github-settings` approval, and the secrets go into it.
    - **`prefixed`:** `OPSCREW_<ENV>_*` repository secrets. Prod keeps today's names.
    - **A change of capability** shows the move of the secrets as a planned change.
    - **Destroying an environment** removes only its secrets and its GitHub environment (`github-settings`), and keeps every other environment's.
    - **Tests:** both kinds, the move, destroy keeping the others, and no secret value in any output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: high

- [ ] T1509 [P] [US3] `opscrew promote`, in `packages/agents/src/promote/**` (new)
  - Owns: that path (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/environments.md "Promotion"; data-model.md "Promotion"; plan.md "10."; spec US3, FR-1517–FR-1523
  - Depends: T1508a, T1504, T1505
  - Accept:
    - **`promote(deps, { target, digest?, approveHash? })`** follows the contract's five steps.
    - **The `promote` approval's hash** is SHA-256 of the canonical `{ target, source, digest, targetPlanHash }`. It is never granted by `--yes`.
    - **Refusals,** each in plain English: no deployed source; a digest that is neither the source's nor the target's previous one; a provenance mismatch (another repository, another ref); a failed signature when signing is on; pending changes in the target; a missing workflow on the default branch.
    - **After a successful run,** the digest is recorded in the target's state. A rollback works the same way.
    - **Tests:** the fake GitHub's tags, provenance and dispatch; each refusal; a rollback; the approval hash changing with any of its four parts.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [ ] T1510 [P] [US1] Localhost in agents: the provider, the preflight, the local plan, the deploy, the local CA and trust, verify/status/drift/destroy, in `packages/agents/src/localhost/**` (new), `packages/agents/src/providers/**` (the profile), and the localhost branches in provision, verify, status, drift and destroy
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/localhost.md "Agents"; plan.md "11."; research.md R4 and "Spike results" 6, 7, 10; spec US1, FR-1501–FR-1509
  - Depends: T1508a, T1506, T1507
  - Accept:
    - **`localPreflight`** runs each check of the contract. Every problem stops before any change, with its fix. The notes (the licence, the architecture) are given once.
    - **`planLocal` and `applyLocal`:** the local plan, hashed, approved as `host-apply`, and applied through `localExec`.
    - **The image:** the production digest from GHCR when the architecture matches; otherwise `docker build` for Dockerfile apps, or the production image under emulation with a warning.
    - **The local CA** is made on first use in `~/.opscrew/local-ca/` with the key at 0600. Leaf certificates go to each localhost hostname. **`localTrust`** shows the command first, and runs it only when the user agrees.
    - **verify, status, drift and destroy for localhost** go through 127.0.0.1 with the Host header and SNI. Destroy removes only OpsCrew's containers, networks and folders, and the volumes only with `--delete-data`.
    - **Tests:** a fake runner for Docker and the shell; each preflight problem; the plan hash; trust per OS (the command only); destroy; no CA key in any output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [ ] T1511 [US4] [US5] Runners in agents: the server's runner in provision, the local runner, status and secure, in `packages/agents/src/runners/**` (new), and the host-plan wiring in provision for `runner: server`
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/runners.md "Agents"; plan.md "12."; research.md R3 and "Spike results" 4, 5, 9; spec US4, US5, FR-1524–FR-1530
  - Depends: T1508b, T1510, T1507, T1504
  - Accept:
    - **`planServerRunner`** checks the repository's visibility and, for a public one, the fork-PR policy (setting it is a `github-settings` change). It adds the `github-runner` step to the host plan, and at apply fetches the registration token through the connector for the step.
    - **`startLocalRunner`** downloads and checks the pinned asset for this computer, configures it `--ephemeral` with the label, runs it in the foreground, and removes itself through the API on exit or a signal.
    - **`runnerStatus`** in `status` and `secure`:
      - offline is a warning;
      - more than 21 days behind GitHub's latest release is a warning;
      - a public repository whose fork-PR policy isn't `all_external_contributors` is high.
    - **Destroy, or a switch back to `runner: github`,** unregisters and removes the runner.
    - **Tests:** a public repository refused, and allowed after the policy change; the token reaching only the step; the local runner's start, stop and signal; the status findings.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: high

## Phase 5: Surfaces, the Docker pass and live tests

- [ ] T1512 [P] Surfaces and the guide, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ tests)
  - Reads: contracts/environments.md "Commands"; plan.md "13."; quickstart.md
  - Depends: T1508b, T1509, T1510, T1511
  - Accept:
    - **The CLI:**
      - `--env` on provision, destroy, drift, status, verify, secure, retarget, secrets and promote;
      - `env add|list|remove`, `promote`, `localhost trust|untrust`, `runner start`.
    - **MCP:**
      - an `environment` input on the matching tools;
      - `opscrew_env_add`, `opscrew_env_list` and `opscrew_env_remove`;
      - `opscrew_promote`, with the approval dialog. The `promote` approval is never granted without the user.
    - **The guide:** new pages `environments.md`, `localhost.md` (with Docker Desktop's licence note and the trust command per OS) and `runners.md`. Environment sections where pages need them. The runbook per environment.
    - **The plugin's deploy skill** learns environments and promotion. `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server --filter=@opscrew/iac-templates`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [ ] T1513 [P] The localhost Docker pass, and OpsCrew's own CI workflow, in `packages/cli/test/e2e/**`, `examples/**`, `.github/workflows/localhost.yml` (new)
  - Owns: those paths
  - Reads: quickstart.md "1." and "6."; research.md R5 and "Spike results" 7, 8
  - Depends: T1510, T1512
  - Accept:
    - **The Docker pass** (`OPSCREW_DOCKER_TESTS=1`): quickstart "1." with the real CLI on this computer, plus a second localhost environment beside the first.
      - The site answers through the local CA (trusted only inside the test, with `NODE_EXTRA_CA_CERTS`).
      - The rendered stack's differences from a server's are exactly research R4's list (SC-1502).
      - Destroy leaves nothing, checked by label.
    - **`.github/workflows/localhost.yml`:**
      - `ubuntu-latest` runs the Docker pass;
      - `macos-15-intel` runs Colima, then the Docker pass, with `continue-on-error`;
      - `windows-latest` and `macos-latest` run the localhost unit tests;
      - the workflow is `workflow_dispatch` only, so it never runs on its own (macOS minutes cost more). The founder may change that.
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm turbo run test --filter=opscrew -- test/e2e/<the new file>` and `pnpm lint`
  - Effort: high

- [ ] T1514 Live tests, in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md "2."–"5."; plan.md "15."
  - Depends: T1512
  - Accept:
    - **Hetzner environments and promotion** (`OPSCREW_E2E_ENVIRONMENTS=1`), quickstart "2." and "3.":
      - prod's plan hash and site stay unchanged under load;
      - prod runs staging's exact digest;
      - a rollback;
      - staging's destroy leaves prod working.
    - **The server's runner** (`OPSCREW_E2E_RUNNER=1`): quickstart "4.", with the firewall refusing SSH from GitHub's address ranges during the deploy.
    - **The Free private repository case** is recorded as found (prefixed secrets, or GitHub environments).
    - **The leak search** covers the runner token, every environment's generated values, and the local CA key.
    - **The docs:** `docs/e2e.md` sections, and the coverage page's rows as "Not run yet".
  - Verify: `pnpm turbo run typecheck --filter=opscrew` and `pnpm lint`
  - Effort: high

- [ ] T1515 Live runs (lead): the passes in `docs/e2e.md`. The results go in `docs/e2e.md` and `docs/e2e-coverage.md`. Windows localhost runs by hand on the founder's computer.

## End-of-feature simplify pass (after T1515)

- [ ] T1516 The end-of-feature simplify pass: duplication across 015's changes, and the items collected during the waves
  - Owns: any 015 file the sweep simplifies (outside `packages/cli/test/live/**` and `docs/e2e*.md`)
  - Accept: the items collected below during the waves; a duplication sweep over 015's change (merged, and what was left and why); no behaviour change
  - Verify: `pnpm lint`, `node plugin/validate.mjs`, `pnpm turbo run typecheck test --concurrency=2`
  - Effort: high

## Dependencies

{T1501a, T1501b} with T1502 (lead) alongside → {T1503, T1504, T1505, T1506, T1507} → T1508a →
{T1508b, T1509, T1510} → T1511 → {T1512, then T1513} → T1514 → T1515 → T1516.

**User stories:**
- **US1:** T1501a, T1501b, T1506, T1507, T1510, T1513.
- **US2:** T1501a, T1503, T1504, T1505, T1508a, T1508b.
- **US3:** T1504, T1505, T1509.
- **US4:** T1501b, T1504, T1505, T1507, T1511.
- **US5:** T1511, T1512.

## Parallel waves

1. T1501a, T1501b (and T1502, the lead's spike).
2. T1503, T1504, T1505, T1506, T1507. Their Owns are disjoint: core paths; the GitHub connector; the workflow files except `switch.ts`; the edge, runtime and `switch.ts`; ssh-host.
3. T1508a.
4. T1508b, T1509, T1510: provision secrets with destroy; promote/; localhost/ with its branches.
5. T1511.
6. T1512, then T1513.
7. T1514, then T1515, then T1516.

## Implementation strategy

- **MVP:** US1 (localhost) and US2 (environments). That is T1501a–T1503, T1506–T1508b, T1510, and the matching parts of T1512.
- **Then:** US3 (promotion).
- **Then:** US4 and US5 (runners).

Each wave is merged, gated and pushed before the next starts.
