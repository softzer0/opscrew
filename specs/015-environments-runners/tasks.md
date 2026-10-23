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

- [X] T1502 The spike (lead), research.md's open items 1–10, run alongside wave 1 on the throwaway repository, a throwaway Hetzner server, this Windows computer and a throwaway CI workflow. The results go into research.md as "Spike results", one line per item: what was run, and what was seen. They decide the open details of T1504–T1511, and any finding that changes a design goes back into plan.md before wave 2.

## Phase 3: Packages (parallel)

- [X] T1503 [P] [US2] Paths per environment, in `packages/core/src/paths.ts`, `packages/core/src/environments.ts` (new)
  - Owns: those paths (+ tests); `packages/core/src/index.ts` for the new exports only; `packages/plan-schema/src/environments.ts` (new), its tests and `index.ts` export, and `plan.ts` for the shared name rule (moved there by the lead, 2026-10-22, since core has no YAML parser)
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

- [X] T1504 [P] [US2] [US3] [US4] The GitHub connector: environments, environment secrets, runners, the fork-PR policy, dispatch, GHCR tags and provenance, in `packages/connectors/github/**`
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

- [X] T1505 [P] [US2] [US3] [US4] Workflows per environment, in `packages/iac-templates/src/workflow/{index,shared,jobs,retention,build,portainer}.ts`
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

- [X] T1506 [P] [US1] Localhost templates: Compose, the edge with the local CA, and the scripts' root folders, in `packages/iac-templates/src/{edge,runtime}/**`, `packages/iac-templates/src/workflow/switch.ts`
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

- [X] T1507 [P] [US4] [US1] The `github-runner` host step, and the local executor, in `packages/connectors/ssh-host/**`
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

- [X] T1506b [US2] The runtime folder and Portainer's deploy branch per environment, in `packages/iac-templates/src/**` (the paths only)
  - Owns: every `opscrew/runtime/…` path and Portainer's deploy branch name in `packages/iac-templates/src/**` (+ tests, snapshots)
  - Reads: data-model.md "Paths per environment"; T1505's and T1506's reports
  - Depends: T1505, T1506
  - Accept:
    - **One helper, `runtimeDir(plan)`:** `opscrew/runtime` for prod, and `opscrew/environments/<env>/runtime` for a named environment. Every renderer and every workflow step that names a runtime file uses it: the workflow's uploads, `edge-check.ts`, `switch.ts` and the runtime and edge renderers.
    - **Portainer's deploy branch:** `opscrew-deploy` for prod, `opscrew-deploy-<env>` for a named environment (`portainer-target/stack.ts` and every reader).
    - **Package root exports for T1510:** `switchCommands`, `rollbackCommands`, `EdgeFiles`, `APPS_DIR`, and T1506's localhost helpers (`localhostHostname`, `localhostTlsUpload`, `LocalhostSite`).
    - **The lock where `flock` is missing** (Git for Windows, macOS): the scripts take the edge's lock only when `command -v flock` finds it. T1510 serialises local deploys with its own lock.
    - **`image: local-build`:** the localhost switch doesn't pull the app's locally built image (for example `pull_policy: never` on that service, or a pull that skips it), with a test that `docker compose pull` doesn't fail on it.
    - **The localhost health check** in the workflow probes HTTPS through the local CA: `https://<host>:<https port><path>`, with `--resolve` to 127.0.0.1 and `--cacert "$OPSCREW_LOCAL_CA_FILE"`. The plain HTTP port answers with a redirect, which `curl -f` would count as healthy (T1505).
    - **The local runner's deploy and its leaf certificate:** the localhost start script swaps in `local.pem.new` and `local.key.new` only when they exist, and keeps the leaf already in the edge's TLS folder otherwise. A workflow deploy on the local runner brings no new leaf; `opscrew provision` issues it. The local job's edge check validates with that existing leaf (T1506's rebase report).
    - **Settings files on localhost** (MySQL, Valkey and others) are inline Compose configs, as the local Docker pass's `localServerCompose` does. Files bind-mounted from Windows are world-writable, and MySQL ignores such files.
    - **Prod's rendered output is byte-identical** (snapshots).
    - **Tests:** two environments' rendered files never share a path; a Portainer staging stack points at its own branch.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --concurrency=2` and `pnpm lint`
  - Effort: medium

## Phase 4: The agents

- [X] T1508a [US2] Environments in agents: `env add/list/remove`, design per environment, the environment choice, and the shared-parts check, in `packages/agents/src/{environments,shared,design,interview}/**`, and every phase's paths
  - Owns: `packages/agents/src/environments/**` (new); the design and interview changes; the phases' path resolution (`shared/phase-deps.ts`, `shared/engine.ts`, and an `environment` in their inputs); provision's preflight and the dependabot rendering; tests. Not T1508c's files.
  - Reads: contracts/environments.md "The environment choice", "Commands"; data-model.md "Environment"; plan.md "9."; spec US2, FR-1510–FR-1513, FR-1515–FR-1516
  - Depends: T1503, T1506b
  - Accept:
    - **`resolveEnvironment`:** the only environment by default. With several, an interactive run asks; a script gets `PHASE_PRECONDITION` with the names and `--env`.
    - **`addEnvironment`** asks only the environment's own questions:
      - the target (localhost, a cloud provider, the user's server, a Portainer);
      - the size, the hostname (`<env>.<domain>` by default), the deploy source and the runner.

      It writes the environment's requirements, designs it, and shows its monthly cost.
    - **Design for an environment** copies the shared parts from prod's plan, sets `app.name` to `<app>-<env>`, derives the hostnames, and writes `plan.environment`.
    - **The deploy source:** `--from` defaults to `main`, and adding an environment never changes another's plan. **`setDeploySource(root, environment, from)`** changes one environment's `deploySource` (an existing source, never itself, no cycle). That environment's next provision shows and applies the workflow change.
    - **The target's connection:** for an own server or a Portainer, prod's connection is offered as the default answer (without prod's `created` list), and the interview's follow-ups are asked for another one. The recovery copy is per environment (`opscrew/environments/<env>/secrets.sops.json`). A hostname another environment uses is refused.
    - **Localhost** is offered as a target; its design comes with T1510.
    - **The origin-TLS client certificate per environment:** `provision/origin-tls.ts`'s `pullPemFile(plan, values)` uses iac-templates' `originPullPem(plan)`, called from `provision/render.ts`. `clientCertificateWarning` names the environment's file, given the plan by `status/certificates.ts`, `verify/run.ts` and `secure/settings.ts`. Prod's files and messages are unchanged. Those files are in T1508a's Owns for this change (T1508c's report).
    - **`listEnvironments`** gives each environment's name, target, source, runner and deployed state. **`removeEnvironment`** refuses while the environment is deployed, and removes its files.
    - **`supplyChain.sign` is a shared part** too, copied and compared like the others. The promoted environment's verify job checks the signature by its own plan, while the source's workflow is what signs (T1505's review).
    - **One `dependabot.yml` for every environment:** provision renders it with every environment's runtime folder (from `environmentsOf`), so prod's and staging's provisions write the same file (T1506b). iac-templates' `renderDependabot` takes the environments' names for this, with prod-only output unchanged: `packages/iac-templates/src/dependabot/**` is in T1508a's Owns for this change.
    - **`sharedPartsDiffer(prodPlan, envPlan)`** runs in provision's preflight: `PHASE_PRECONDITION` naming the fields, with the hint `opscrew design --env <env>`.
    - **Every phase** (provision, destroy, drift, status, verify, secure, retarget, secrets) resolves its paths through the environment. Agents' `stateFile()` (`shared/engine.ts`) uses core's `tfstateFile(paths)`, since today it hard-codes `prod.tfstate` (T1503's review).
    - **Tests:** an existing prod app is unchanged, with nothing to apply; adding staging; two environments on one own server; the shared-parts refusal; the choice in scripts.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1508c [P] [US2] Per-environment names for Portainer and origin TLS, in `packages/connectors/portainer/src/**` and agents' Portainer and origin-TLS files, and the storage names in core's name rule
  - Owns: `packages/connectors/portainer/src/**`; agents' `provision/{deploy-branch,stack-plan,types,portainer-flow,origin-tls}.ts`, `drift/portainer.ts`, `drift/__fixtures__/portainer-project.ts`, `shared/portainer-stacks.ts`, `destroy/portainer.ts`; `packages/core/src/paths.ts`; their tests
  - Reads: data-model.md "Paths per environment"; iac-templates' `portainerDeployBranch`, `portainerStackTemplatePath`, `originPullPem`, `storageRootDir` (T1506b)
  - Depends: T1503, T1506b
  - Accept:
    - **Portainer's stack Git ref per environment:** `packages/connectors/portainer` (`names.ts` `DEPLOY_BRANCH` and `DEPLOY_REFERENCE`, and `plan.ts`'s `branch: z.literal(DEPLOY_BRANCH)`) takes the environment's deploy branch from iac-templates' `portainerDeployBranch(plan)`, as do agents' `provision/deploy-branch.ts`, `provision/stack-plan.ts`, `provision/types.ts` and `provision/portainer-flow.ts`. Otherwise a staging stack would follow prod's branch while its workflow writes `opscrew-deploy-staging` (T1506b's review).
    - **The storage names:** iac-templates' `storageRootDir(plan)` is `opscrew/infra/storage-<env>` outside prod, and agents' storage callers need no change. Since an environment's infrastructure root is `opscrew/infra/<env>`, the name rule refuses `storage` and names starting with `storage-`: core's `ENVIRONMENT_NAME_PATTERN` and `ENVIRONMENT_NAME_MESSAGE` in `packages/core/src/paths.ts`, with a test (T1506b).
    - **Agents use the per-environment helpers** `portainerStackTemplatePath(plan)` and `portainerDeployBranch(plan)`, instead of the prod-only `PORTAINER_STACK_TEMPLATE_PATH` and agents' own `DEPLOY_BRANCH` (in `drift/portainer.ts`, `shared/portainer-stacks.ts`, `destroy/portainer.ts`) (T1506b). `originPullPem(plan)` moved to T1508a, since its callers are in T1508a's files.
    - **plan-schema's tests** of the name rule's message and pattern, and the generated `schemas/plan.schema.json`, follow the new rule. They are in T1508c's Owns for this change.
    - **Tests:** a staging Portainer stack follows `opscrew-deploy-staging` in its plan, apply and drift; prod's stack plan and its hash are unchanged; the names `storage` and `storage-x` are refused.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-portainer --filter=@opscrew/core --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1508b [P] [US2] Secrets and destroy per environment, in `packages/agents/src/provision/secrets.ts`, `packages/agents/src/destroy/**` (+ the GitHub settings change)
  - Owns: those paths (+ tests); iac-templates' `src/workflow/shared.ts` (`deploySecretName`) and the tests and snapshots it changes
  - Reads: data-model.md "Deploy secrets per environment"; plan.md "9."; research.md R1 and "Spike results" 1; FR-1514, FR-1515
  - Depends: T1508a, T1504
  - Accept:
    - **The capability check** runs at each environment's own provision, once the app has more than one environment, and its answer is written to that plan's `environment.secrets`. A prod-only app is unchanged: no probe, no settings change. Each provision places and moves only its own environment's secrets.
    - **A named environment's names are always `OPSCREW_<ENV>_*`**, in its GitHub environment or as repository secrets: `deploySecretName` drops today's names for `environment: environment`. GitHub falls back from an environment secret to a repository secret of the same name, so a missing staging secret would otherwise resolve to prod's (the lead, wave 4).
    - **`environment`:** the GitHub environment is created (or updated) under a `github-settings` approval, and the secrets go into it.
    - **`prefixed`:** `OPSCREW_<ENV>_*` repository secrets. Prod keeps today's names.
    - **The secret list per environment** comes from iac-templates' `deploySecretNamesFor(plan)` (T1505). A self-hosted environment has no host, SSH key or known-hosts secret.
    - **Build values** (`OPSCREW_BUILD_ENV`, `OPSCREW_BUILD_SECRETS`) are always repository secrets: `OPSCREW_<ENV>_BUILD_*` for a named environment, even when its other secrets live in a GitHub environment, since the build job runs in none (T1505).
    - **Moving prod's secrets into the `production` environment** happens at prod's own provision. It deletes prod's old repository secrets of the same names. Otherwise a missing environment secret would fall back to them (T1505).
    - **A change of capability** shows the move of the secrets as a planned change.
    - **Destroying an environment** removes only its secrets and its GitHub environment (`github-settings`), and keeps every other environment's. It deletes the GitHub environment only when OpsCrew created it (recorded at creation); in one the user made, it deletes only OpsCrew's own secrets (T1508b's review).
    - **Destroy's text names the environment's own files:** Portainer's "What remains" lists `plan.cicd.workflowPath` (`opscrew-deploy-<env>.yml`), not prod's workflow file (T1508c).
    - **Lead decisions (T1508b's report):**
      - the name rule also refuses `production` (prod's GitHub environment) and any name with `service` as one of its hyphen-separated parts, whose prefixed names would equal a service's env-file secret (`OPSCREW_SERVICE_APP_ENV`). Core's `paths.ts` and plan-schema's name tests and schema are in T1508b's Owns for this;
      - `--no-secrets` after a move warns, as a missing secret does;
      - `--plan-only` makes no GitHub change: it uses the recorded placement, or `prefixed` with a note.
    - **Tests:** both kinds, the move, destroy keeping the others, and no secret value in any output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1509 [P] [US3] `opscrew promote`, in `packages/agents/src/promote/**` (new)
  - Owns: that path (+ tests); `packages/agents/src/index.ts` for the new exports only; the GitHub connector's `fileSha` and `workflowRun` (`packages/connectors/github/src/{github,connector}.ts` and their tests); iac-templates' verify job in `src/workflow/jobs.ts` (the run's event and head repository) and the snapshots it changes
  - Reads: contracts/environments.md "Promotion"; data-model.md "Promotion"; plan.md "10."; spec US3, FR-1517–FR-1523
  - Depends: T1508a, T1504, T1505
  - Accept:
    - **`promote(deps, { target, digest?, approveHash? })`** follows the contract's five steps.
    - **The `promote` approval's hash** is SHA-256 of the canonical `{ target, source, digest, targetPlanHash }`. It is never granted by `--yes`.
    - **Refusals,** each in plain English: no deployed source; a digest that is neither the source's nor the target's previous one; a provenance mismatch (another repository, another ref); a failed signature when signing is on; pending changes in the target; a missing workflow on the default branch.
    - **After a successful run,** the digest is recorded in the target's state. A rollback works the same way.
    - **Lead decisions (T1509's report):**
      - the signature is checked by the target workflow's verify job before its deploy job, and the approval says so;
      - the target's workflow on the default branch must equal the rendered one (the connector's `fileSha` against the git blob hash), checked before the approval;
      - every difference drift reports that provision would apply counts as pending: files changed or missing, the host plan, Cloudflare rules, the Portainer stack;
      - the build run must be a `push` run whose head repository is this one, in promote and in the verify job;
      - "Nothing was deployed" only for a definite refusal; otherwise the run may have started, with the Actions link;
      - a builder id that is not a run URL is never printed as given;
      - the result has no `deployed` field, since a failed run throws.
    - **Tests:** the fake GitHub's tags, provenance and dispatch; each refusal; a rollback; the approval hash changing with any of its four parts.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1508d [US3] Required reviewers and the branch rule where GitHub enforces them (FR-1521), in `packages/agents/src/provision/secrets.ts`, `packages/agents/src/promote/**` and the GitHub connector
  - Owns: those paths (+ tests); `packages/connectors/github/src/{github,connector}.ts` for the branch rule's calls (+ tests)
  - Reads: spec FR-1514 and FR-1521; research.md "Spike results" 1 (the public repository); data-model.md "Approval kinds"
  - Depends: T1508b, T1509
  - Accept:
    - **Where the capability check reports `reviewers`:** an environment that is promoted to is offered required reviewers. An interactive run asks, defaulting to the repository's owner. A script keeps none and says how to add them. The rule is set under a `github-settings` approval.
    - **Where it reports `branchPolicies`:** every environment OpsCrew created gets the branch rule "the default branch only", under the same approval.
    - **Never in a user's own environment:** OpsCrew changes no rule of an environment the user made, and says so.
    - **Elsewhere,** OpsCrew says plainly once that its own approval guards against mistakes, not against someone with write access.
    - **`promote` with required reviewers:** a run waiting for a reviewer is reported as waiting, with its URL. It is never a timeout or a failure, and the digest is recorded only after the run succeeds.
    - **Tests:** the offer and its approval, a refusal, a user's own environment left alone, the branch rule, a promotion waiting for a reviewer, and Free private repositories (no rules) unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-github --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1510 [P] [US1] Localhost in agents: the provider, the preflight, the local plan, the deploy, the local CA and trust, verify/status/drift/destroy, in `packages/agents/src/localhost/**` (new), `packages/agents/src/providers/**` (the profile), and the localhost branches in provision, verify, status, drift and destroy
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/localhost.md "Agents"; plan.md "11."; research.md R4 and "Spike results" 6, 7, 10; spec US1, FR-1501–FR-1509
  - Depends: T1508a, T1506, T1507
  - Accept:
    - **`localPreflight`** runs each check of the contract. Every problem stops before any change, with its fix. The notes (the licence, the architecture) are given once.
    - **Interview and design for localhost** (`localhostNotSupported` goes, in `interview/answers.ts` and design):
      - the architecture from the computer and the ports probed, both injected;
      - `image` as data-model.md's table says;
      - no DNS;
      - the hostnames `<app>.localhost`, or `<env>.<app>.localhost` beside another localhost environment.

      The design and interview files' localhost branches are in T1510's Owns (T1508a's report).
    - **Components that need a host kernel setting** (the search engines' `vm.max_map_count` through the privileged sysctl service) are refused on localhost with a plain message, as on Portainer (T1506).
    - **Rendering a local-runner workflow** passes the environment's localhost hostname in the render context (`ctx.localhost`). The scripts need it for kamal-proxy's `--host` (T1506's rebase report).
    - **Local deploys are serialised** with a lock in the user's OpsCrew home, since the scripts' `flock` is missing on Git for Windows and macOS (T1506).
    - **`planLocal` and `applyLocal`:** the local plan, hashed, approved as `host-apply`, and applied through `localExec`.
    - **The image:** the production digest from GHCR when the architecture matches; otherwise `docker build` for Dockerfile apps, or the production image under emulation with a warning.
    - **The local CA** is made on first use in `~/.opscrew/local-ca/` with the key at 0600. Leaf certificates go to each localhost hostname. **`localTrust`** shows the command first, and runs it only when the user agrees.
    - **verify, status, drift and destroy for localhost** go through 127.0.0.1 with the Host header and SNI. Destroy removes only OpsCrew's containers, networks and folders, and the volumes only with `--delete-data`.
    - **Tests:** a fake runner for Docker and the shell; each preflight problem; the plan hash; trust per OS (the command only); destroy; no CA key in any output.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1510b [US1] `opscrew init` for a localhost-only user, in `packages/agents/src/init/**`
  - Owns: that path (+ tests)
  - Reads: quickstart.md "1."; spec US1
  - Depends: T1510
  - Accept:
    - **`init` passes with Docker and no cloud token,** for a user who deploys only to this computer (T1513's Docker pass found it exits 1). A missing cloud token is a note that names localhost, a server the user already has, and the cloud providers, never a failure.
    - **Docker's absence** is a note too, unless the project already targets localhost.
    - **The GitHub token** is a note, not a failure, while the project has no target yet or targets localhost without the local runner; it stays a failure for every target that deploys through GitHub Actions (the lead, after the Docker pass on main, 2026-10-22).
    - **Tests:** no cloud token with Docker; no cloud token and no Docker; an existing check unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: medium

- [X] T1511 [US4] [US5] Runners in agents: the server's runner in provision, the local runner, status and secure, in `packages/agents/src/runners/**` (new), and the host-plan wiring in provision for `runner: server`
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/runners.md "Agents"; plan.md "12."; research.md R3 and "Spike results" 4, 5, 9; spec US4, US5, FR-1524–FR-1530
  - Depends: T1508b, T1510, T1507, T1504
  - Accept:
    - **`planServerRunner`** checks the repository's visibility and, for a public one, the fork-PR policy (setting it is a `github-settings` change). It adds the `github-runner` step to the host plan, and at apply fetches the registration token through the connector for the step.
    - **`startLocalRunner`** downloads and checks the pinned asset for this computer, configures it `--ephemeral` with the label, runs it in the foreground, and removes itself through the API on exit or a signal. Its environment (the runner's `.env`) sets `OPSCREW_APPS_DIR`, `OPSCREW_EDGE_DIR` and `OPSCREW_LOCAL_CA_FILE` for the deploy job (T1505).
    - **`runner: local` with `image: local-build` is refused** plainly: the workflow deploys the image CI built, which `pull_policy: never` would never pull. Use `image: registry`, or provision from the computer without the runner (T1506b).
    - **The local runner's workflow and secrets** (T1510's report):
      - provision commits and pushes the rendered workflow, and stores the environment's deploy secrets, as for the other runners;
      - the local runner's deploys take OpsCrew's local deploy lock, the same lock `applyLocal` takes. If that needs the job's script to take it, change only the local runner's branch of iac-templates' workflow (in T1511's Owns for this); prod and every server stay byte-identical;
      - iac-templates' `buildArch` builds for the localhost target's CPU. That iac-templates file and the snapshots it changes are in T1511's Owns for this change.
    - **`runnerStatus`** in `status` and `secure`:
      - offline is a warning;
      - more than 21 days behind GitHub's latest release is a warning;
      - a public repository whose fork-PR policy isn't `all_external_contributors` is high.
    - **Destroy, or a switch back to `runner: github`,** unregisters and removes the runner. When `config.sh remove` failed or found no registration, `applyHostPlan`'s `ApplyResult.stillRegistered` lists the app, and the flow deletes its registration through the API (`deleteRunner`), as T1507's step doesn't stop on it.
    - **Tests:** a public repository refused, and allowed after the policy change; the token reaching only the step; the local runner's start, stop and signal; the status findings.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1511b [US4] The server's runner on cloud servers: the root parts in cloud-init, and the runner as deploy's user service, in `packages/iac-templates/shared/cloud-init.yaml.tftpl` (and its renderer), `packages/connectors/ssh-host/src/**` (the runner step) and agents' runner wiring
  - Owns: the cloud-init template, its rendering and the snapshots it changes; ssh-host's runner step, facts and plan (+ tests); agents' `runners/**` and the cloud provision, drift, status and destroy call sites for the cloud runner (+ tests)
  - Reads: plan.md "8." (with its cloud part); spec FR-1524–FR-1528; T1511's `runners/` code
  - Depends: T1511
  - Accept:
    - **Cloud-init on every cloud server**, whatever the runner choice:
      - the runner's OS packages, the ones `installdependencies.sh` installs on the pinned images;
      - `/srv/runners` owned by `deploy`;
      - `loginctl enable-linger deploy`.

      Choosing a runner later never changes `user_data`. Existing servers' `user_data` changes once, since OpsCrew is unreleased.
    - **The runner is deploy's systemd user service** on cloud and own servers alike. The step runs as `deploy`:
      - the download, checked by SHA-256, and the extraction;
      - `config.sh`, with the token from stdin through `ACTIONS_RUNNER_INPUT_TOKEN`;
      - the user unit `opscrew-runner-<app>.service` with `Restart=always`, started with `systemctl --user enable --now` and `XDG_RUNTIME_DIR` set.

      No `svc.sh`, and no `installdependencies.sh` at apply. On own servers the host plan's root part installs the packages and enables linger.
    - **On cloud targets**, `runner: server` is a host plan with only the `github-runner` step, inspected and applied over SSH as `deploy` with the deploy key and the recorded host key, and approved as `host-apply`. T1511's refusal goes.
    - **Teardown and switching back** stop and disable the unit, run `config.sh remove` as deploy, and remove the folder. Destroying a cloud server unregisters its runner before the server is deleted.
    - **Tests:**
      - the cloud-init snapshot, the same with and without a runner;
      - the step as deploy, with no root command;
      - a cloud provision with `runner: server` that plans, approves and applies the step;
      - teardown;
      - the token absent from every plan, hash, log and file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1517a [US6] The runner machine and builds on self-hosted runners in the plan, in `packages/plan-schema/src/**`
  - Owns: plan-schema (+ tests and the generated schemas)
  - Reads: data-model.md "Environment" and "Runner machine"; plan.md "16."; spec US6, FR-1532–FR-1535
  - Depends: T1511
  - Accept:
    - **`environment.runner`** gains `host`. **`environment.runnerHost: { name, arch }`** is required with it and absent otherwise; `name` follows data-model.md's rule. **`environment.build`** is `github` (the default) or `runner`.
    - **The rules,** each with a plain message:
      - `host` only for cloud and own-server targets;
      - `build: runner` only with `runner: local` or `host`, and only for an environment that follows main;
      - the runner's architecture (`runnerHost.arch`, or the localhost target's for `local`) equals the target's.
    - **Prod-only and existing plans are unchanged:** the defaults are never written.
    - **Tests:** each rule, and an existing plan's bytes unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema` and `pnpm lint`
  - Effort: high

- [X] T1517b [US6] The runner machine's host plan, in `packages/connectors/ssh-host/src/**`
  - Owns: ssh-host (+ tests)
  - Reads: data-model.md "Runner machine"; plan.md "8." and "16."
  - Depends: T1511b, T1517a
  - Accept:
    - **A runner machine's host plan:** the deploy user, the runner's prerequisites, Docker (always: the deploy job's edge check runs `docker compose` there; T1517c), and one `github-runner` step per environment. No edge, app-record, firewall, SSH or web-filter step.
    - **Ownership:** the runner step refuses a folder whose `.opscrew-runner` names another repository, on runner machines and own servers alike, instead of replacing it.
    - **Removal:** an environment's runner comes off on its own. The machine's teardown removes OpsCrew's runners and the deploy user if OpsCrew created it, as an own server's undo does. Docker stays, as there: removing it could stop containers the user started since (T1517b).
    - **Tests:** a fake host for each, and the token absent from every plan, hash and log.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host` and `pnpm lint`
  - Effort: xhigh

- [X] T1517c [P] [US6] The workflow for runner machines and builds on self-hosted runners, in `packages/iac-templates/src/workflow/**`
  - Owns: those paths (+ tests and snapshots)
  - Reads: contracts/runners.md "Runner machines"; plan.md "16."
  - Depends: T1517a
  - Accept:
    - **`runner: host`:** the deploy job runs on `[self-hosted, opscrew-<app>-<env>]` with the SSH deploy steps a GitHub-hosted job uses. `deploySecretNamesFor` includes the connection secrets for it.
    - **`build: runner`:** the build job runs on the environment's self-hosted label, with Buildx (pinned), provenance, SBOM and the optional signing as on GitHub's machines.
    - **A runner machine deploys over SSH**, unlike the server's and the local runner, which deploy on their own machine. `selfHosted(plan)` (`workflow/shared.ts`) counts every runner but `github` as deploying in place; split the two cases. `buildArch` uses plan-schema's `targetArch` (T1517a).
    - **Prod and every existing environment** render byte-identically.
    - **Lead additions (T1517c's reports and review):** a Buildpacks or Railpack build on a non-Linux local runner runs the pinned Linux CLIs in a pinned Linux image with Docker's socket; the steps run under bash 3.2 and Git Bash; the local runner's build uses its own `DOCKER_CONFIG`, never the user's login; real-shell tests get 60 s.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: high

- [X] T1517d [US6] Runner machines in agents, in `packages/agents/src/runners/**` and the provision, destroy, design, status and secure wiring
  - Owns: those paths (+ tests); `packages/agents/src/index.ts` for the new exports only
  - Reads: contracts/runners.md "Runner machines"; plan.md "16."; spec US6
  - Depends: T1517a, T1517b, T1517c, T1508b
  - Accept:
    - **`addRunnerHost`, `applyRunnerHost`, `removeRunnerHost` and `listRunnerHosts`** follow the contract:
      - inspect over SSH, pinning the host key at first contact as for an own server;
      - ssh-host's `planRunnerHost` for the machine's setup and one environment's add or removal, and `planUndo(facts, { repositoryUrl }, command)` for the machine's teardown (T1517b);
      - the host plan approved by its hash as `host-apply`;
      - the record in the project's home folder;
      - removal refused while an environment uses the machine.
    - **Design and `env add|set`:** `runner: host` with `runnerHost`, and `build: runner`. On a local runner that isn't Linux, the workflow runs the pinned Linux `pack` and `railpack` inside a pinned Linux container with Docker's socket, so every builder works there (the founder, 2026-10-22; T1517c). `env add`'s target question offers "This computer" once (today `interview/questions.ts` and `environments/add.ts` both add it; T1512b's review). An architecture mismatch is refused, naming the server types that match. A runner machine that is the environment's own server is refused, pointing to `runner: server`.
    - **Provision and destroy** of an environment with `runner: host` add and remove its `github-runner` step on the machine's host plan, approved by that plan's hash. Its deploy secrets include the SSH connection secrets, as for a GitHub-hosted job.
    - **`env add` with an own server** inspects it as the interview does, before design, rather than only recording it (T1512a's report).
    - **`planWhere`** gives `--env prod` when the app has several environments, through agents' `environmentFlag(root, name)` (T1512a builds it), as the CLI's commands do (T1512a's report).
    - **`status` and `secure`** report the machine's runners through `runnerStatus`. Its wording (`runners/status.ts`) names the runner machine for `runner: host`, not "the server's runner" (T1517a's report).
    - **Tests:** add, apply and remove a machine; two environments on one machine; destroy removing only one environment's runner; the refusals; no token or address in any plan or committed file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1517e [US6] Runner machines in the CLI, MCP and the guide
  - Owns: `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, `docs/guide/runners.md` and `docs/guide/environments.md` (+ tests)
  - Reads: contracts/runners.md "Runner machines"; plan.md "16."
  - Depends: T1517d, T1512a, T1512b
  - Accept:
    - **The CLI:** `opscrew runner host add <name> --ssh <user@host[:port]> [--key <file>]`, `runner host remove <name>` and `runner host list`, plus `env add|set --runner host --runner-host <name> [--build runner]`.
    - **MCP:** matching tools, with the host plan's approval dialog. `opscrew_plan` and `opscrew_apply` handle a localhost environment's local plan and its hash (T1512a's report).
    - **From T1517d's report:**
      - `--host-key <fingerprint>` on `runner host add` and `env add`, for runs without a terminal;
      - the env table shows each environment's runner machine;
      - `runner host remove` asks for the machine's name typed back, or `--confirm <name>` in scripts;
      - drift's and verify's rendered hints get `--env prod` beside other environments: the CLI and MCP pass the environment flag (agents' `environmentFlag`), or `VerifyCheckContext` carries it.
    - **The guide:** `runners.md` explains runner machines and builds on your own hardware: the architecture rule, why the production server never builds, and that 016's private network will let them reach servers without public SSH.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [X] T1517f [US6] Opt-in hardening for runner machines in ssh-host: the `sshd` step and an isolated `ssh-firewall` step (FR-1536)
  - Owns: `packages/connectors/ssh-host/src/**` (+ tests)
  - Reads: spec FR-1536; data-model.md "Runner machine" (Hardening); plan.md "16."
  - Depends: T1517b
  - Accept:
    - **`planRunnerHost`** takes `harden?: { ssh?: true; firewall?: { sshFrom: string[] } }`. Without it, the plan is byte-identical to today's.
    - **`harden.ssh`** adds the own server's `sshd` step, with its revert timer. It is refused (a blocking finding) when OpsCrew's own login would stop working: a password login, or root.
    - **`harden.firewall`** adds a new `ssh-firewall` step: an nftables table `inet opscrew` with an input chain that accepts port 22 from `sshFrom` (IPv4 and IPv6) and drops other port-22 traffic. It changes no other port, rule, table or default policy.
      - The plan says which source it is applied from, and the step checks that the connection's own source address is among `sshFrom`, refusing otherwise so it can't lock OpsCrew out.
      - It needs `nft`; without it, a plain finding.
    - **Undo** deletes the table, or restores the recorded SSH settings. Turning a part off removes only that part.
    - **Tests:** a fake host for each part; the lockout refusals; undo; a plan with no hardening unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host` and `pnpm lint`
  - Effort: high

- [X] T1517g [US6] Opt-in hardening for runner machines in agents, the CLI, MCP and the guide (FR-1536)
  - Owns: agents' `runners/**` (the machine record and its host plan); `packages/cli/src/**` and `packages/mcp-server/src/**` for the flags; `docs/guide/runners.md` (+ tests)
  - Reads: spec FR-1536; data-model.md "Runner machine"; plan.md "16."
  - Depends: T1517f
  - Accept:
    - **The record** stores `harden`, and the machine's host plan includes it.
    - **CLI:** `runner host add|set <name> --harden ssh|firewall` (either or both) `[--ssh-from <cidr> …]`, and `--no-harden ssh|firewall` to turn one off. `--harden firewall` without `--ssh-from` is refused with a plain message.
    - **MCP:** the matching inputs, through the host plan's approval dialog.
    - **The guide** (`runners.md`): hardening is optional and off by default; what each part does; the firewall touches only port 22 in OpsCrew's own table; the lockout safeguards; how to undo.
    - **From T1517f's report:** pass `harden` and `hostKeyType` (the pinned host key's type) on every `planRunnerHost` call except runner-only removals; a runner machine's login check covers only the admin login (deploy has no SSH key there); a firewall plan holds the user's addresses, so runner machines' saved plans stay local and are never committed.
    - **Tests:** add with each part, set to turn one off, the refusal without sources, and `runner host list` showing what is hardened.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1518 [US2] Branch detection and `--branch` for environments (FR-1537)
  - Owns: agents' `environments/**` and `interview/**` (the proposal, `--branch`, the checks), `promote/**` (the source's branch); iac-templates' verify job in `src/workflow/**` (its branch check) with its snapshots; the CLI's `env` command and MCP's environment tools; `docs/guide/environments.md` (+ tests)
  - Reads: spec FR-1517 and FR-1537; data-model.md "Environment" (`cicd.branch`); contracts/environments.md "Promotion"
  - Depends: T1515a
  - Accept:
    - **Detection:** `env add` and the interview read the remote branches through the existing git client (no new dependency), and match the common names in FR-1537.
    - **The proposal:** when a match is found, an interactive run shows both setups and preselects promotion. In a script, nothing is guessed: the flags decide, and a note names the matching branches.
    - **`--branch <name>`** on `env add` and `env set` sets that environment's `cicd.branch`. A branch the repository doesn't have is refused, and so is a branch another environment already follows, naming both.
    - **Promotion's provenance check** (agents' `promote` and the workflow's verify job) requires the build run's `head_branch` to equal the source environment's own `cicd.branch`, not always the default branch. The target's workflow is still dispatched on the default branch, where it lives. Prod's rendered workflow is byte-identical.
    - **The guide** (`environments.md`): both setups, the trade-off (each branch builds its own image, against one image promoted unchanged), `--branch`, and the duplicate-branch refusal.
    - **Tests:** detection with matching and non-matching names; the proposal interactively and in a script; `--branch` with an unknown branch and a duplicate; promotion from an environment on its own branch passes, and a run on another branch is refused.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates --filter=opscrew --filter=@opscrew/mcp-server --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1519 [US2] Each environment's own app values, and what environments share (FR-1538)
  - Owns: agents' `provision/secrets.ts` (`buildAppEnvironment`'s file choice) with its tests; `docs/guide/environments.md`; `docs/guide/secrets.md` if it says where provision reads values
  - Reads: spec FR-1538; data-model.md "Shared parts"
  - Depends: T1518 (the same files)
  - Accept:
    - **The file:** an interactive provision of an environment other than prod offers values from `.env.<env>` only (`<env>` is the environment's name); prod keeps `.env`. Without `.env.<env>`, it says so once and asks each value with nothing offered. A script reads `OPSCREW_APP_ENV_FILE` as today.
    - **The guide:** "What every environment shares" says the environments share the app's definition (build, port, health route, release command, processes, which components and external services it uses, signing), and that each runs its own copies: its own containers, databases and their data and passwords, buckets, secrets and deploy key, on its own server by default. Where the app's own values come from per environment (`.env.<env>`, never prod's `.env`), and that an external service should get its own connection value per environment.
    - **Tests:** staging's interactive provision with `.env` and `.env.staging` offers only `.env.staging`'s values; without `.env.staging`, nothing is offered; prod still reads `.env`; a script still reads `OPSCREW_APP_ENV_FILE`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: medium

- [X] T1520 [US2] The shared parts follow the image (FR-1539)
  - Owns: agents' `environments/shared-parts.ts`, `design/run.ts` (`sharedPartsSource` and its callers), `provision/run.ts` and `localhost/provision.ts` (the preflight's call), `promote/**` (the readiness check); the CLI's and MCP's texts only where they name prod's plan as the source; `docs/guide/environments.md` (+ tests)
  - Reads: spec FR-1517, FR-1537 and FR-1539; data-model.md "Shared parts"; contracts/environments.md "Promotion"
  - Depends: T1518 and T1519 (the same files)
  - Accept:
    - **The source of the shared parts:** an environment that builds (`deploySource.from: main`, prod included) takes them from its own design. A promoted environment's `design --env <env>` copies them from its source environment's plan (not prod's). Its error when the source has no plan yet names the source.
    - **Provision's preflight** compares a promoted environment's shared parts with its source's, and checks nothing for one that builds. Its hint names `design --env <env>` and the source.
    - **Removal after the promotion:** when a promoted environment has a service its source no longer has, its design keeps the service while the environment's deployed digest (its deployment record) differs from the source's, and says why; once they are equal, design removes it, and provision's existing confirmation before data is deleted applies.
    - **Promote's readiness check,** before the approval is shown: every service of the source exists in the target with the same settings, and every other shared part is equal. Otherwise it stops (`PHASE_PRECONDITION`), naming each difference and the two commands (`design --env <target>`, then `provision --env <target>`). Extra services in the target are allowed.
    - **The guide** (`environments.md`): replace "defined once in prod's plan". A new service starts where the code first runs, with an example (Redis added on dev, then staging, then prod, each with its own approved plan), and a service removed in dev stays in staging and prod until their next promotion.
    - **Tests:** dev gains Redis while prod has none; staging's promotion is refused until its design and provision, then passes; prod is refused the same way; dev drops a service: staging keeps it until it runs dev's image, then its design removes it; the branches setup (every environment builds) checks nothing between environments.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [X] T1521 [US5] A localhost environment with the local runner runs its own image (FR-1540)
  - Owns: agents' `localhost/image.ts` (`imageSource`, `resolveLocalImage`) and `localhost/provision.ts` with their tests; `docs/guide/runners.md` "The local runner" and `docs/guide/localhost.md` where they say which image runs (+ tests)
  - Reads: spec FR-1539 and FR-1540; data-model.md "Localhost target"
  - Depends: T1520 (its `sharedPartsSource` uses `imageSource`'s rule)
  - Accept:
    - **The source:** `imageSource` returns `undefined` (the environment itself) for a localhost environment that follows a branch (`deploySource.from: main`) with `environment.runner: local`. Its shared parts then come from its own design, through T1520's use of the same rule.
    - **The first provision:** without its own `opscrew-<env>` image yet, `resolveLocalImage` starts the stack from a local build when `planBuildsLocally`, else from prod's `opscrew-prod` image when prod has one (with the emulation note when the CPU differs), else stops (`PHASE_PRECONDITION`, nothing changed) saying to set `target.image: local-build` or deploy prod first. Each case says which image it starts and that the first push replaces it with the environment's own.
    - **Later provisions** run the environment's own labelled image.
    - **Unchanged:** a localhost environment without the local runner runs prod's image, or its source's when promoted, as today; `target.image: local-build` always builds.
    - **The guide:** which image a localhost environment runs, in both cases, in plain words.
    - **Tests:** the first provision with each fallback (local build, prod's image, the refusal), a later provision with the environment's own image, and the unchanged cases.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1522 [US3] Promote checks the image's CPU (FR-1540, T1521's review)
  - Owns: agents' `promote/**` (the check and its tests); `docs/guide/environments.md` (one sentence in the promotion section)
  - Reads: spec FR-1540; contracts/environments.md "Promotion"; plan-schema's `targetArch`
  - Depends: T1521
  - Accept:
    - **The check:** before the approval (with the other checks, before drift), promote reads the platforms of the image it would deploy (its manifest, or each manifest of an index) from GHCR, as it already reads the image, and refuses (`PHASE_PRECONDITION`, nothing changed) when none matches the target's CPU (`targetArch(plan.target)`). The message names both CPUs and the fix: build for the target's CPU (a source environment on a server of that CPU, or the GitHub-hosted build).
    - **No guess:** when the platforms cannot be read, promote stops the same way it does for an unreadable image today; it never deploys an image of unknown CPU.
    - **Rollbacks** get the same check.
    - **The guide:** one sentence: promote refuses an image built for another CPU than the target's, for example a dev on Apple silicon promoted to an x86 server.
    - **Tests:** an arm64-only image to an amd64 target is refused; a matching single image passes; an index with both passes; an unreadable manifest stops.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1523 [US5] Destroying a localhost environment removes its GitHub secrets (found by T1515's local runner pass)
  - Owns: agents' `localhost/destroy.ts` with its tests; `packages/cli/test/live/local-runner.test.ts` (step 6's check)
  - Reads: `destroy/common.ts` (`removeDeploySecrets`, as `destroy/own.ts` and `destroy/portainer.ts` call it); `provision/secrets.ts` (the secrets record)
  - Depends: T1521
  - Accept:
    - **The removal:** when provision wrote GitHub secrets for the localhost environment (its secrets record names them: the deploy secrets in its GitHub environment, and its build values as repository secrets), `destroy --env <env>` removes them and the GitHub environment OpsCrew created, through `removeDeploySecrets` under the destroy's typed confirmation, as on the other targets. Its result lists them (`secretsRemoved`).
    - **Unchanged:** a localhost environment whose provision wrote no secrets (no local runner) touches nothing at GitHub; secrets OpsCrew did not write stay.
    - **The live test:** step 6 also checks that none of dev's secrets and no GitHub environment `dev` is left (the environment helpers' `expectSecretsGone`).
    - **Tests:** destroy of a local-runner localhost environment removes its recorded secrets and the GitHub environment; one without a record touches nothing at GitHub; a GitHub failure says what is left and how to finish, as `removeDeploySecrets` does elsewhere.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --concurrency=2` and `pnpm lint`
  - Effort: medium

## Phase 5: Surfaces, the Docker pass and live tests

- [X] T1512a [P] The CLI, MCP and the plugin, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`, and agents' message text
  - Owns: those paths (+ tests); the agents files named below, for their text only
  - Reads: contracts/environments.md "Commands", contracts/runners.md, contracts/localhost.md; plan.md "13."; quickstart.md
  - Depends: T1508b, T1509, T1510, T1511
  - Accept:
    - **The CLI:**
      - `--env` on design, provision, destroy, drift, status, verify, secure, retarget and secrets, and `--to` on promote;
      - `env add|set|list|remove`, `promote`, `localhost trust|untrust`, `runner start`.
    - **MCP:**
      - an `environment` input on the matching tools;
      - `opscrew_env_add`, `opscrew_env_set`, `opscrew_env_list` and `opscrew_env_remove`;
      - `opscrew_promote`, with the approval dialog. The `promote` approval is never granted without the user.
    - **Messages that name a command** for a named environment include `--env <env>`: the Portainer template error, the edge-check hint and similar (T1506b's review).
    - **Agents' text that names prod's branch or runtime folder** says the environment's own: `provision/publish.ts`, `verify/portainer.ts`, `secure/portainer.ts`, `drift/render.ts`, and `destroy/types.ts`'s doc comment. Use `portainerDeployBranch(plan)` and `runtimeDir(plan)`. Those agents files are in T1512a's Owns for this change (T1508c's report).
    - **Runners in the CLI** (T1511's report): `runner start` awaits `startLocalRunner`'s `finished` in the foreground and stops it on Ctrl+C; `status` and `secure` show `runnerStatusLines`.
    - **Localhost in the CLI** (T1510's report):
      - `--plan-only` prints `localPlanHash`;
      - `destroy --confirm <app>` covers the local teardown, through `savedLocalPlanPurpose`;
      - `localhost trust|untrust` call `localTrust`;
      - `opscrew dns` says plainly that a localhost environment has no DNS, instead of "not supported yet".
    - **More of the same** (T1508a's report):
      - with `--env`, the recovery status passes `copyPath(deps.paths)` to `recoveryStatusLines`;
      - the deploy-setup pull request's body lists the environment's runtime folder and plan file, not `opscrew/runtime/` and `opscrew/plan.yaml`;
      - the "state is not on this computer" hints name the environment's state folder, not `.opscrew/tfstate`.
    - **The plugin's deploy skill** learns environments and promotion. `node plugin/validate.mjs` passes.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server --filter=@opscrew/agents`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [X] T1512b [P] The guide, the README and the runbook, in `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`, and the token permission list
  - Owns: those paths (+ tests); `GITHUB_TOKEN_PERMISSIONS` in `packages/connectors/github/src/github.ts` (+ its test)
  - Reads: contracts/environments.md, contracts/runners.md, contracts/localhost.md; plan.md "8." (with its cloud part) and "13."; quickstart.md; research.md "Spike results"
  - Depends: T1508b, T1509, T1510, T1511
  - Accept:
    - **The guide:** new pages `environments.md`, `localhost.md` (with Docker Desktop's licence note and the trust command per OS) and `runners.md`. `environments.md` says plainly that on a Free private repository GitHub environments hold secrets but have no branch rules, wait timers or reviewers, so any workflow naming the environment can read them and OpsCrew's approval is the only gate (spike result 1). It also says that without image signing, promotion's provenance check is a consistency check: anyone who can push to the GHCR package could forge it. Signing (`supplyChain.sign`) is the real gate (T1505's review). Environment sections where pages need them. The runbook per environment.
    - **The token templates:** `GITHUB_TOKEN_PERMISSIONS` (shown by `init` and the guide) lists Administration (Read and write) and Environments (Read and write), the ones OpsCrew's calls use (no deployments or variables endpoint is called; T1512b's review). Each is marked as needed only for environments or self-hosted runners. `OPSCREW_GHCR_READ_TOKEN` (classic, `read:packages`) is named for `promote`, since GitHub's container registry may not accept fine-grained tokens (T1504).
      The list names only what OpsCrew's code calls: check the connector before listing a permission (Variables, for example, only if some call uses it). Listing or reading an environment also needs Actions: Read (spike result).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/connector-github` and `pnpm lint`
  - Effort: high

- [X] T1513 [P] The localhost Docker pass, and OpsCrew's own CI workflow, in `packages/cli/test/e2e/**`, `examples/**`, `.github/workflows/localhost.yml` (new)
  - Owns: those paths
  - Reads: quickstart.md "1." and "6."; research.md R5 and "Spike results" 7, 8
  - Depends: T1510, T1511b, T1512a, T1517c
  - Accept:
    - **The Docker pass** (`OPSCREW_DOCKER_TESTS=1`): quickstart "1." with the real CLI on this computer, plus a second localhost environment beside the first.
      - The site answers through the local CA (trusted only inside the test, with `NODE_EXTRA_CA_CERTS`).
      - The rendered stack's differences from a server's are exactly FR-1504's list (SC-1502).
      - Destroy leaves nothing, checked by label.
    - **A Buildpacks or Railpack build on the local runner off Linux** (the CLIs in a container with Docker's socket, T1517c) runs in the macOS job, and by hand on Windows in T1515.
    - **`.github/workflows/localhost.yml`:**
      - `ubuntu-latest` runs the Docker pass;
      - `macos-15-intel` runs Colima, then the Docker pass, with `continue-on-error`;
      - `windows-latest` and `macos-latest` run the localhost unit tests;
      - it runs on pushes to `main` and on pull requests that touch the localhost code (agents' `localhost/`, iac-templates' edge and runtime, ssh-host's `localExec`, core's local CA, `examples/`), weekly on a schedule, and by hand. OpsCrew's repository is public, so GitHub-hosted runners, macOS included, cost nothing (the founder, 2026-10-22: not manual-only).
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm turbo run test --filter=opscrew -- test/e2e/<the new file>` and `pnpm lint`
  - Effort: high

- [ ] T1513b [US1] The localhost CI's first run on GitHub: fix what it found on macOS and Windows
  - Owns: `packages/agents/src/localhost/**`, `packages/cli/test/e2e/**`, `.github/workflows/localhost.yml` (+ tests)
  - Reads: the CI run (`gh run view 39790397663 --repo softzer0/opscrew --log`); quickstart.md "1."; research.md "Spike results" 8
  - Depends: T1513
  - Accept:
    - **Linux** passed all 7 Docker-pass tests in CI; it stays green.
    - **Windows unit tests:** `localhost/trust.test.ts` builds the macOS command with the host's path separators. Each OS's trust command is built with that OS's path rules (`path.posix` for macOS and Linux, `path.win32` for Windows), whichever computer renders it.
    - **Intel macOS with Colima:** `provision --approve` exits 2 after the local plan, and later tests fail from it (ECONNREFUSED, timeouts). The off-Linux Buildpacks build fails too. Find each cause from the log and fix it in OpsCrew's code or the job, so the macOS job passes, or say plainly what Colima on GitHub's Intel runner cannot do.
  - Verify: the unit tests on this computer; `OPSCREW_DOCKER_TESTS=1` for the localhost pass here; and a new CI run on GitHub (the lead pushes)
  - Effort: high

- [X] T1514 Live tests, in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md "2."–"5."; plan.md "15."
  - Depends: T1512a, T1512b, T1513
  - Accept:
    - **Hetzner environments and promotion** (`OPSCREW_E2E_ENVIRONMENTS=1`), quickstart "2." and "3.":
      - prod's plan hash and site stay unchanged under load;
      - prod runs staging's exact digest;
      - a rollback;
      - staging's destroy leaves prod working.
    - **The server's runner** (`OPSCREW_E2E_RUNNER=1`): quickstart "4.", with the firewall refusing SSH from GitHub's address ranges during the deploy.
    - **The Free private repository case** is recorded as found: GitHub environments with secrets but no rules (spike result 1).
    - **The public repository** `OPSCREW_E2E_GITHUB_REPO_C` (throwaway, the founder, 2026-10-22) covers the path with every environment rule: provision creates the environment with its branch rule, and destroy removes it. No self-hosted runner is ever registered there: a runner for a public repository is checked only as far as the refusal and the fork-PR policy change, as a plan, never applied.
    - **A runner machine** (`OPSCREW_E2E_RUNNER_HOST=1`): a throwaway Hetzner server set up as a runner machine, building the image and deploying to a cloud target, with the target refusing SSH from GitHub's address ranges.
    - **The leak search** covers the runner token, every environment's generated values, and the local CA key.
    - **The docs:** `docs/e2e.md` sections, and the coverage page's rows as "Not run yet".
  - Verify: `pnpm turbo run typecheck --filter=opscrew` and `pnpm lint`
  - Effort: high

- [X] T1515a [US3] Commit tags per environment, found by the live run (T1515)
  - Owns: iac-templates' `src/workflow/**` (the build's tags, the verify job's commit-tag check, retention) with its tests and snapshots; agents' `promote/**` (the commit-tag check); any reader of the commit tag (search for it)
  - Reads: data-model.md "Promotion"; research.md R2; the live run's finding below
  - Depends: T1509, T1505
  - Accept:
    - **The finding:** prod and staging both followed main, so one push built the same commit twice into one package. The later push took the `<commit>` tag; the other image was left untagged; prod's retention deleted it; staging's label and retention jobs then failed ("not found", HTTP 404). Promotion's check (the image tagged with the run's commit is this digest) would also fail for the untagged one.
    - **Tags:** prod's build tags `<commit>` as today; a named environment's build tags `<commit>-<env>`. Prod's workflow renders byte-identically.
    - **The verify job and `promote`** check the source environment's own commit tag form.
    - **Retention** keeps every environment's label tags and the newest `keep` commit versions of each environment by its tag form, and never deletes another environment's fresh build.
    - **Tests:** two environments following main build the same commit: both keep their own tagged digests; retention keeps both; promotion from either passes its commit-tag check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents --concurrency=2` and `pnpm lint`
  - Effort: xhigh

- [ ] T1515 Live runs (lead), after T1520, T1521 and T1523: the passes in `docs/e2e.md`. They include spike items 4 (the server's runner end to end) and 9 (the local runner on Windows), with the real code. The results go in `docs/e2e-coverage.md` (its Live results and the status at a glance). Windows localhost runs by hand on the founder's computer.
  - The founder accepted Cloudflare's brief 520s for a zone's other hostnames while a new hostname's Authenticated Origin Pulls setting deploys (seen in 1 of 3 runs; documented in `docs/guide/origin-protection.md`, 2026-10-23). The environments test's load check accepts only HTTP 520–527 answers sent within 3 s of a `deployed` `hostname_association` entry in the account's audit log (the entries name no zone), and logs each with its distance from the rollout; any other failure still fails the step.

## End-of-feature simplify pass (after T1515)

- [ ] T1516 The end-of-feature simplify pass: duplication across 015's changes, and the items collected during the waves
  - Owns: any 015 file the sweep simplifies (outside `packages/cli/test/live/**` and `docs/e2e*.md`)
  - Accept: the items collected below during the waves; a duplication sweep over 015's change (merged, and what was left and why); no behaviour change
  - Items collected during the waves:
    - `waitForWorkflowRun`'s search branch (no run id given) is dead once `dispatchWorkflow` always returns a run id: make `runId` required and drop the search, `since`, `floorToSecond` and `CLOCK_SKEW_ALLOWANCE_MS` (T1504's review).
    - `retarget/steps.ts`: the `runId !== undefined` check is always true now; drop it (T1504).
    - `provision/origin-tls.ts`: when GitHub accepted the dispatch but no run appeared in time, the warning still says "could not start the deploy workflow"; say it was accepted, and where to look (T1504).
    - Remove iac-templates' `PORTAINER_STACK_TEMPLATE_PATH` and `ORIGIN_PULL_PEM` once only their own tests use them (T1508c). The connector's `DEPLOY_BRANCH` and `DEPLOY_REFERENCE` stay for the Portainer live test.
    - The generic error helpers `reasonOf`, `codeOf` and `hintOf` live in `retarget/` and are imported by promote: move them to `shared/` (T1509's review).
    - Localhost's `shellWord` duplicates the unexported `shellQuote` helpers; and its runbook (`localhost/runbook.ts`) belongs beside `renderRunbook` in iac-templates (T1510).
    - Core's `signedLeafCertificate` takes a `commonName` option, so a long localhost hostname needs no extra short SAN name (`<16 hex>.localhost`) (T1510).
    - A runner machine's host plan is headed "Host plan for your server" (ssh-host); name the runner machine there instead of the MCP text adding a line above it (T1517e).
    - Export `FakeRunnerMachine` and `FakeRunnerGitHub` from `@opscrew/agents/testing`, and drop the CLI's and MCP's own small copies (T1517e).
    - `env set --from X --runner Y` sets the runner before the source; check both in agents before writing either, so a refused source saves nothing (T1517e).
    - Image retention keeps the label tags of the app's existing environments only, not every `opscrew-*` tag: a removed environment's labels, or a stray tag such as the spike's `opscrew-spike`, would otherwise pin versions forever (the lead, 2026-10-22).
    - The runbook's `workflowName` and plan-file path rebuild what `workflow/shared.ts` builds inline (`workflowStart`): export one helper (T1512b).
    - iac-templates' `workflow/shared.ts` comment on concurrency says no queued deploy is cancelled; GitHub keeps only the newest waiting run (T1512b's review).
    - Agents' `stateFile(paths)` (`shared/engine.ts`) is only an alias of core's `tfstateFile`: import `tfstateFile` directly and drop it (T1508a).
    - Verify fetches the repository's default branch on every run; only a promoted plan needs it (`verify/run.ts:230`), so fetch it only then (T1518's re-review).
    - The CLI's provision next steps test `base !== undefined`, which every producer sets (`cli/src/commands/provision.ts:472`): drop it (T1518's re-review).
    - Design's first `sharedPartsSource` call has no target yet for a new localhost environment: assume `{ provider: "localhost", image: "registry" }` when `requirements.provider` is localhost, so the fields derived from the components start from prod's plan too (T1520's re-review).
    - `sharedPartsSource` reads the source plan again after `imageSource` read it: have `imageSource` return the plan (T1520's re-review).
    - A rollback looks its digest up in both the promotion record and its `previous`, so a rollback to the image before the last promotion from another computer is still checked (T1520's re-review).
    - Design's derived `app.env` entries (service URLs) can name a service the copied shared parts leave out, for example `REDIS_URL` when the code uses Redis and the source's plan has none yet (T1520's re-review).
    - `promote/run.ts`'s `registryCredential` duplicates `ghcrReadCredential` (T1520's review).
    - The emulation note's sentence is in `localhost/image.ts`, `localhost/preflight.ts:187` and `localhost/design.ts:162`: one shared `emulationNote` (T1521's review).
    - A promoted localhost environment with `target.image: local-build` builds the code here but copies its source's shared parts: refuse local-build for a promoted environment, or say why it is allowed (T1521).
    - The connector's `imagePlatforms` has no Docker manifest list case in its tests, and its config blob's digest check is untested (T1522's review).
    - Promote reads GHCR's index twice (`imageProvenance`, then `imagePlatforms`): two extra requests per promote. Its single-manifest branch never runs from promote, since provenance needs an index (T1522's review).
    - `destroy/common.ts`'s hint when the `github-secrets` approval is refused mentions "the pinned host key", which a localhost destroy has none of (T1523).
    - Check live which answer GitHub's dispatch gives (a 204, as the spike saw, or the documented 200 with `workflow_run_id`), and drop the path that never happens (T1504).
  - Verify: `pnpm lint`, `node plugin/validate.mjs`, `pnpm turbo run typecheck test --concurrency=2`
  - Effort: high

## Open after 015

- A derived service URL in `app.env` (`DATABASE_URL`, `REDIS_URL`, …) can stay after a promoted environment's copied shared parts drop its service, when the code still uses the service: derive the URLs only for the services the written plan has, or take the source's entries (T1516, item 19; the lead decides when it is picked up).
- Promote reads GHCR's index twice (`imageProvenance`, then `imagePlatforms`): one connector method returning both would save a token request and an index read per promote (T1516, item 25).
- GitHub's answer to a workflow dispatch (a 204, as the spike saw, or the documented 200 with `workflow_run_id`) was not recorded live; both paths stay until a live run logs it (T1516, item 27).

## Dependencies

{T1501a, T1501b} with T1502 (lead) alongside → {T1503, T1504, T1505, T1506, T1507} → {T1508a, T1508c} →
{T1508b, T1509, T1510} → T1511 → {T1511b, T1512a, T1512b, T1517a} → {T1517b, T1517c} → T1517d → T1517e → T1513 → T1514 → T1515 → T1516.

**User stories:**
- **US1:** T1501a, T1501b, T1506, T1507, T1510, T1513.
- **US2:** T1501a, T1503, T1504, T1505, T1508a, T1508b, T1508c.
- **US3:** T1504, T1505, T1509.
- **US4:** T1501b, T1504, T1505, T1507, T1511, T1511b.
- **US5:** T1511, T1512a, T1512b.
- **US6:** T1517a–T1517e.

## Parallel waves

1. T1501a, T1501b (and T1502, the lead's spike).
2. T1503, T1504, T1505, T1506, T1507. Their Owns are disjoint: core paths; the GitHub connector; the workflow files except `switch.ts`; the edge, runtime and `switch.ts`; ssh-host.
   Then T1506b: the runtime folder and Portainer's branch per environment, across iac-templates.
3. T1508a, T1508c: environments, design and the phases' paths; the Portainer and origin-TLS names.
4. T1508b, T1509, T1510: provision secrets with destroy; promote/; localhost/ with its branches.
5. T1511, then T1511b (the runner on cloud servers).
6. T1511b, T1512a, T1512b and T1517a together (T1512a edits only agents' message text; T1511b the runner wiring; T1517a plan-schema).
7. T1517b and T1517c, then T1517d, then T1517e, then T1513.
8. T1514, then T1515, then T1516.

## Implementation strategy

- **MVP:** US1 (localhost) and US2 (environments). That is T1501a–T1503, T1506–T1508b, T1510, and the matching parts of T1512a and T1512b.
- **Then:** US3 (promotion).
- **Then:** US4 and US5 (runners).

Each wave is merged, gated and pushed before the next starts.
