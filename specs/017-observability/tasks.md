---
description: "Tasks for 017-observability"
---

# Tasks: Observability, light and free: logs, resource figures, alerts, and two opt-in add-ons

**Input**: `specs/017-observability/`:
- spec.md, plan.md, research.md (R1–R8 and the open items 1–8), data-model.md;
- contracts/observability.md, quickstart.md;

plus `docs/adr/0021-observability.md`, and features 000–016.

**Numbering**: T1701–T1799.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`.

**Rules for every task:**
- **Fixtures** never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with `materializeFixture()`.
- **No network:** no test touches the network, a real cloud, a real GitHub, a real Grafana Cloud or a model. Tests that need Docker, `ssh` or other tools skip with a clear message when the tool is absent.
- **No leaks:** none of these values may appear in a plan, a host plan's text, a committed or generated file, a log, an audit entry, a report, a snapshot, an issue's or webhook's text, or an MCP response (SC-1704):
  - an app secret;
  - the check key;
  - a webhook address;
  - Beszel's password or token;
  - the Grafana Cloud token;
  - a server's address, in anything committed.

  Every task's tests include a leak check for the values it handles.
- **Reading changes nothing:** `logs`, `status` and the MCP tools only read. On servers they run only fixed commands built from checked parts (FR-1703). Each read is audited as `remote-exec`, without the address.
- **Approvals:** every change goes through its plan, approved by its hash:
  - the check key, Beszel and Alloy on a server: `host-apply`;
  - a Beszel dashboard at a hostname: also `iac-apply` and the shared `cloudflare-apply`.

  Other changes use their existing kinds:
  - the check's files: `pull-request` in the deploy-setup pull request;
  - its secrets: `github-secrets`;
  - the pause variable: `github-settings`.

  No new approval kind.
- **Untouched unless turned on:** a plan with no `observability` block renders byte-identical files (snapshots). That covers servers, Portainer and the server-less targets.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** write long files with the Write or Edit tool, not shell heredocs (Windows Defender blocks some).
- **Neutral examples only:** `example.com`, `example-app`, and `203.0.113.0/24` for addresses.

## Phase 1: Foundation

- [X] T1701a Contracts: `plan.observability`, `RemoteExec`'s streaming options, the new paths and recovery-copy entries, `registerAppSecrets`, and the empty modules the agents waves fill, in `packages/plan-schema/**`, `packages/contracts/**`, `packages/core/src/paths.ts`, `packages/agents/src/{shared/remote.ts,shared/app-secrets.ts,secrets/files.ts,provision/secrets.ts,logs/index.ts,check/index.ts,addons/index.ts,index.ts}`, and the `RemoteExec` fakes
  - Owns: those paths (+ the generated JSON schema, tests and fixtures). In `provision/secrets.ts`, only the lines that register the app's values. In `agents/src/index.ts`, only the three new export lines. The `RemoteExec` fakes are `connectors/ssh-host/src/__fixtures__/fake-host.ts` and any other test double of `RemoteExec`, for the new options only.
  - Reads: data-model.md "The plan block", "Secrets kept apart"; contracts/observability.md "plan-schema", "contracts"; plan.md "1."; ADR 0021
  - Depends: —
  - Accept:
    - **`ObservabilitySchema`** on `DeployPlanSchema` as `observability`, optional so plans without it stay byte-identical, with data-model.md's rules quoted in the messages:
      - **`check`:**
        - `enabled` (optional boolean);
        - `intervalMinutes`, one of `5, 10, 15, 20, 30, 60`;
        - `webhook`, one of `"slack"`, `"discord"`, `"ntfy"`.
      - **`beszel`:**
        - `enabled` (default `false`) and `version` (`PinnedVersionSchema`);
        - `mode`, `"hub"` or `"agent"`, default `"hub"`;
        - `access`, `"local"` or `"subdomain"`, default `"local"`. It is "`hub` mode only".
        - `hostname` and `allowedEmails`: "With `subdomain` only, and required there", checked as `PortainerSchema` checks them;
        - `hubUrl` (`https://` URL) and `hubKey` (`ssh-ed25519 …`): "`agent` mode only, and required there";
        - `memoryMb { hub, agent, proxy }`, positive integers. The defaults are the plan's starting limits, 128, 64 and 32, until the spike settles them.
      - **`grafanaCloud`:**
        - `enabled` (default `false`) and `version`;
        - `metrics { url, user }` and `logs { url, user }`: `https://` URLs and numeric user ids, required when enabled;
        - `logSampling`, an integer 1–100, default 100;
        - `memoryMb { alloy, proxy }`, defaulting to 192 and 32.
    - **The plan's rules** (next to the target checks). Each refusal names why and the fix:
      - `beszel.enabled` or `grafanaCloud.enabled` unless `onServer(plan)`: "Beszel and Grafana Cloud run on a server OpsCrew deploys to (a cloud server or your own)";
      - `check.enabled` on localhost: "GitHub can't reach your computer".
      - The "first app's prod plan only" rule for `intervalMinutes` and `webhook` needs the plan's place, so it is agents' check (T1710). Here the fields are accepted everywhere.
    - **`RemoteExec.run`'s options** gain `onLine?: (stream: "stdout" | "stderr", line: string) => void` and `signal?: AbortSignal`.
      - `SshRemoteExec` passes them to `CommandRunner.run`.
      - Every fake accepts them: it replays its scripted output through `onLine` line by line when given, and honours `signal`.
    - **New paths** in `core/src/paths.ts`:
      - the check key, `~/.opscrew/projects/<id>/check_key`;
      - Beszel's secrets file;
      - the Grafana Cloud token file;

      each beside `deployKey`. Each is added to the recovery copy's `HOME_FILES` (`agents/src/secrets/files.ts`), and `isCopyPath` accepts it.
    - **`registerAppSecrets(deps, plan)`** (`agents/src/shared/app-secrets.ts`) registers exactly what provision registers today: the app's and build values except host lists and fixed production words, and the services' generated secrets. `provision/secrets.ts` calls it. Provision's tests pass unchanged.
    - **`agents/src/{logs,check,addons}/index.ts`** exist with `export {}`, and agents' root index exports them. The parallel tasks then fill them without touching the root index.
    - **ADR 0021's Consequences** match what was built.
    - **Tests:**
      - each refusal with its message;
      - round-trips of a plan with all three blocks;
      - the defaults;
      - streaming through `SshRemoteExec` with a scripted runner, and a stop through `signal`;
      - `registerAppSecrets` against provision's existing cases;
      - the recovery copy accepting the new paths.
  - Verify: `pnpm turbo run typecheck test --concurrency=2` and `pnpm lint`
  - Effort: high

- [X] T1701b [P] Pins and module seams: Beszel's and Alloy's images, and the empty `check` and `addons` modules in iac-templates, in `packages/iac-templates/src/pins.ts`, `packages/iac-templates/scripts/**`, `packages/iac-templates/src/{check,addons}/index.ts`, `packages/iac-templates/src/index.ts`
  - Owns: those paths (+ tests). In `src/index.ts`, only the two new export lines.
  - Reads: research.md R6, R7; plan.md "2."
  - Depends: —
  - Accept:
    - **`IMAGES` gains** `beszel` (`henrygd/beszel:0.21.x`), `beszelAgent` (`henrygd/beszel-agent:0.21.x`) and `alloy` (`grafana/alloy:v1.21.x`), each `name:tag@sha256:<digest>` like the existing entries. `update-pins.mjs` refreshes them the way it refreshes the other images. Run it once and commit the real digests.
    - **`src/check/index.ts` and `src/addons/index.ts`** exist with `export {}`, and `src/index.ts` exports them.
    - **Tests:**
      - the format checks the existing images have;
      - the snapshot guard (T1601c) still finds no pinned value in any snapshot.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: medium

## Phase 2: Spike (lead)

- [ ] T1702 The spike (lead): research.md's open items 1–8.
  - **Where:**
    - an e2e cloud server (`OPSCREW_E2E_HCLOUD_TOKEN`);
    - the private throwaway repository (`OPSCREW_E2E_GITHUB_REPO`) and the public one (`OPSCREW_E2E_GITHUB_REPO_C`);
    - the e2e Cloudflare account, with an SSR Worker;
    - a Grafana Cloud free stack, the founder's account, created for the e2e runs.
  - **The results** go into research.md as "Spike results", one line per item: what was run, and what was seen.
  - They settle:
    - the open details of T1703–T1708;
    - the add-ons' memory defaults (T1701a's starting values);
    - `ubuntu-slim`.

    Any finding that changes a design goes back into plan.md before wave 2.
  - **The founder's part:**
    - the Grafana Cloud account;
    - the extra permissions on the e2e Cloudflare token (item 6 names them);
    - the e2e GitHub token's Issues, Actions and Variables permissions.

## Phase 3: Packages (parallel)

- [ ] T1703 [P] [US1] [US2] The Cloudflare connector: Workers logs, the tail, analytics, and their permissions, in `packages/connectors/cloudflare/**`
  - Owns: that path (+ tests and fakes)
  - Reads: contracts/observability.md "Cloudflare"; research.md R2 and "Spike results" 6; plan.md "4."
  - Depends: T1701a, T1702
  - Accept:
    - **The methods in the contract,** zod-checked:
      - **`workersLogs`:** the telemetry query, `view: "events"`, filtered on the Worker's name. Each event maps to `{ time, level, message, status?, outcome?, error? }` as spike result 6 locates the fields.
      - **`workersTail`:** creates the tail, reads its WebSocket with Node's global `WebSocket`, and calls `onEvent` per message. It deletes the tail when `signal` aborts, and also when the socket closes.
      - **`workersAnalytics`:** one GraphQL query on `workersInvocationsAdaptive` for the Worker since the given time: requests, errors, `cpuTimeP50` and `cpuTimeP99` in ms.
      - **`observabilityPermissions`:** names each missing permission.
      - **The allowance:** if the query's answer says the day's ingestion stopped (spike result 6), `workersLogs` returns that with the events.
    - **The permission list:** `CLOUDFLARE_OBSERVABILITY_PERMISSIONS` holds Workers Tail Read, the Workers Observability permission spike result 6 names, and Account Analytics Read. Each is marked "only for logs and status on Cloudflare hosting".
    - **A WebSocket is injectable,** like `fetch`, so tests never open one.
    - **Errors:**
      - a 403 names the missing permission and never prints the token;
      - a tail refused because 10 clients already follow the Worker says so.
    - **Tests:** the fake covers each endpoint:
      - events with a console line and an exception;
      - an empty answer;
      - a tail that sends two messages, then stops on abort and deletes itself;
      - the analytics answer;
      - a 403.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare` and `pnpm lint`
  - Effort: high

- [ ] T1704 [P] [US2] [US3] The GitHub connector: the check workflow's state, open issues by label, repository variables, `hasIssues`, included minutes, and the permissions, in `packages/connectors/github/**`, and agents' GitHub fake
  - Owns: that path (+ tests and fakes). In agents, only the new methods in `FakeGitHub` (`agents/src/testing/deploy.ts`) and in the `Pick<GitHubClient, …>` of `agents/src/provision/types.ts`, so wave 3 finds them ready.
  - Reads: contracts/observability.md "GitHub"; research.md R3, R4 and "Spike results" 5; plan.md "4."
  - Depends: T1701a, T1702
  - Accept:
    - **The methods in the contract,** zod-checked:
      - **`checkWorkflowState`:** the REST `state`. A 404 is `"missing"`.
      - **`openIssues`:** paged, with pull requests skipped.
      - **`getRepoVariable`** (`undefined` on 404), **`setRepoVariable`** (create, or update when it exists) and **`deleteRepoVariable`** (a 404 is fine).
      - **`includedMinutes`:** from the account's or organization's plan when readable: 2,000 on Free, 3,000 on Pro and Team, 50,000 on Enterprise. Otherwise `undefined`.
      - **`getRepo`** gains `hasIssues`.
    - **`GITHUB_TOKEN_PERMISSIONS`** gains Issues (Read) and Variables (Read and write). Each is marked "only with the scheduled check", with Actions (Read) for the check's state if the list lacks it. It lists only what the code calls, as spike result 5 confirms.
    - **Errors:** a 403 names the missing permission.
    - **Tests:** the fake covers each endpoint:
      - a workflow active, off for inactivity, and missing;
      - issues mixed with a pull request over two pages;
      - a variable created, updated and deleted;
      - the plans;
      - a 403.
    - **Agents' `FakeGitHub`** implements every new method, with state a test can set and read: the workflow's state, open issues, and variables. The provision `Pick` names them.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github` and `pnpm lint`
  - Effort: medium

- [ ] T1705 [P] [US1] [US2] The Portainer connector: container logs, stats, inspect, and the host's totals, in `packages/connectors/portainer/**`
  - Owns: that path (+ tests and fakes)
  - Reads: contracts/observability.md "Portainer"; research.md R1 and "Spike results" 7; plan.md "4."
  - Depends: T1701a, T1702
  - Accept:
    - **`containerLogs`** reads `…/docker/containers/{id}/logs?stdout=1&stderr=1&timestamps=1&tail=N[&since=S]`.
      - It demultiplexes Docker's framing: an 8-byte header, the stream type in byte 0, and a big-endian uint32 size in bytes 4–7.
      - It passes a TTY container's raw stream as `stdout`.
      - It splits lines, and keeps a line cut across two frames whole.
    - **`containerStats`** reads `stream=false` without `one-shot` (with it, `precpu_stats` is empty: spike result 7), so `precpu_stats` is filled.
      - CPU % = `(cpu delta / system delta) × online_cpus × 100`.
      - Memory is `usage − inactive_file` on cgroup v2, or `usage − cache` on v1, against `memory_stats.limit`. A limit equal to the host's memory counts as no limit.
    - **`containerInspect`** keeps only `RestartCount`, `State.StartedAt` and `HostConfig.Memory`. Its zod schema strips everything else, so `Config.Env` never leaves the connector.
    - **`dockerInfo`** gains `cpus` (`NCPU`) and `memoryBytes` (`MemTotal`).
    - **Follow:** none here. Portainer buffers `follow=1` for about 40 s (spike result 7), so agents poll. `since` takes `<seconds>.<nanoseconds>`, so agents can ask for lines after the last one they have.
    - **Errors:** a 403 says the token's user can't read that container, and what Portainer role it needs. A standard user's token sees only that user's stacks (spike result 7), and the message says so.
    - **Tests:**
      - frames for both streams, a frame split mid-line, and a TTY stream;
      - cgroup v1 and v2 stats;
      - an inspect answer holding `Config.Env` with a fake secret, which never appears in the result;
      - a 403.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-portainer` and `pnpm lint`
  - Effort: high

- [ ] T1706 [P] [US3] [US4] [US5] The host adapter: the `check-key`, `beszel` and `alloy` steps, their planner and teardown, and their secrets on stdin, in `packages/connectors/ssh-host/**`
  - Owns: that path (+ tests and fixtures)
  - Reads: contracts/observability.md "ssh-host"; research.md R3 "Reaching a server's disk", R5, R6, R7 and "Spike results" 1, 2, 4; plan.md "4."; how `planPortainer` and the `portainer` step work today
  - Depends: T1701a, T1702
  - Accept:
    - **`check-key`:**
      - Adds one line, `restrict,command="df -P -B1 /" <public key> opscrew-check`, to the deploy user's `authorized_keys`. On an own server, that is the user OpsCrew deploys as.
      - Idempotent: it replaces a line with the same comment.
      - Teardown removes only that line.
      - The plan text shows the public key's fingerprint, never the key file.
    - **`beszel` and `alloy`:**
      - Write the files T1708 renders under `opscrew/addons/<name>` (cloud server: `/home/deploy/opscrew/addons/<name>`; own server: `/srv/opscrew/addons/<name>`), as the `portainer` step writes Portainer's.
      - Write the secrets from `ApplyOptions.secrets` to root-only files there (mode 0600, then owned as the container needs).
      - Run `docker compose up -d`, and check the containers are running.
      - **Teardown:** `docker compose down`, the files, the secrets and the volumes removed, so nothing of it stays (SC-1706). With `keepData`, Beszel's `beszel_data` volume stays. A teardown that deletes a volume is a destroying host plan (`allowDestroy` with the typed app name), as Portainer's data deletion is.
    - **`planAddon(kind, …)`** plans a setup and its undo. `planTeardown` gains the add-ons when present.
    - **One of each per server:** the host record names the app that turned each add-on on. Planning it for another app is a plain refusal naming that app (data-model.md).
    - **`ApplyOptions.secrets`** gains `beszelPassword`, `beszelToken` and `grafanaCloudToken`, sent only on stdin and checked by name, as `tunnelToken` is.
    - **The Compose text cap (16 KiB)** holds for the add-on files, or is raised for them with the reason in a comment.
    - **Tests with `FakeHost`:**
      - each step's commands;
      - re-applying changes nothing;
      - teardown with and without `keepData`;
      - another app refused;
      - the secrets on stdin and nowhere in the plan text or the audit.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host` and `pnpm lint`
  - Effort: high

- [ ] T1707 [P] [US3] The scheduled check: `check.mjs`, its generated copy, and `renderCheck` (the workflow and `check.json`), in `packages/iac-templates/check/**` (new), `packages/iac-templates/src/check/**`, `packages/iac-templates/src/generated/check.ts` (new), `packages/iac-templates/scripts/gen-modules.ts`
  - Owns: those paths (+ tests, snapshots, and the package's `gen:modules` script line if it needs one)
  - Reads: spec US3, FR-1702, FR-1705–FR-1710, SC-1702, SC-1703, SC-1705; data-model.md "The check's files", "Alerts (GitHub issues)"; contracts/observability.md "iac-templates"; research.md R3, R4 and "Spike results" 4, 5; plan.md "5."
  - Depends: T1701a, T1701b, T1702
  - Accept:
    - **`packages/iac-templates/check/check.mjs`:** one readable ES module with no dependencies, for Node ≥ 20. It exports `run(env, io)`, where `io` holds `fetch`, `tlsDaysLeft`, `ssh`, `df`, `sleep`, `now` and `log`. When it is the main module, it calls `run` with the real ones.
      - **HTTPS:** each host's `https://<hostname><healthPath>`, with `timeoutSeconds`. Any status below 400 passes. A failure is retried `tries` times, `retrySeconds` apart, before it counts. The hosts are checked concurrently.
      - **Certificates:** the days left from `tls.connect` with `servername`. Below `certDays`, it fails as `certificate`.
      - **Disk:**
        - `via: "github"` and `"runner-host"`: `ssh -i <key file> -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<file> -p <port> <user>@<host> df`. The key and known hosts come from the environment secrets and go into files with mode 0600 in `RUNNER_TEMP`, removed at the end.
        - `"own-runner"`: `df -P -B1 /` locally.
        - Thresholds: `diskWarn` and `diskHigh`.
      - **Issues** (data-model.md "Alerts"):
        - the label is created first, and a 422 for an existing one is ignored;
        - the open issues are read once;
        - one issue per failing key;
        - a comment only when the failure's text changes;
        - closed with "Resolved after <duration>" and `state_reason: completed`;
        - an open issue whose key is no longer in `check.json` is closed as "no longer checked".
      - **The pause:** `OPSCREW_CHECK_PAUSED` (JSON; empty or absent is nothing paused). A paused environment is skipped, and its open issues are closed with the reason.
      - **Inactivity:** in a public repository (from the event payload), it reads the default branch's last commit date. From 50 days on, it opens the `inactivity` issue with how to keep the check running (any commit, and how to turn it on again). It closes the issue when a newer commit appears.
      - **The webhook:** posts the same text when an issue opens or closes.
        - Slack: `{"text"}`, cut at 4,000 characters.
        - Discord: `{"content", "allowed_mentions": {"parse": []}}`, cut at 2,000.
        - ntfy: the body cut at 4,096 bytes, with `Title`, `Priority` 4 on opening and 3 on closing, and `Authorization: Bearer` when `OPSCREW_CHECK_NTFY_TOKEN` is set.
        - The address is never printed.
      - **Issues off** (410, or `has_issues` false): it posts the webhook, writes the job summary and exits 1.
      - **What goes into issue and webhook text:**
        - only fixed sentences, names, hostnames, status codes, Node error codes, days and disk figures;
        - never a response body or header;
        - never an address or a secret (`::add-mask::` for each secret value at start).
      - **`--only disk:<server id>`** runs just that server's disk check, for the jobs on self-hosted runners. Each job manages only its own keys.
    - **The generated copy:** `gen-modules.ts` (or a sibling script it calls) embeds `check.mjs` as `src/generated/check.ts`, so the bundled CLI carries it. A test fails when the copy is stale.
    - **`renderCheck({ plans, repo })`** returns `.github/workflows/opscrew-check.yml`, `opscrew/check/check.json` and `opscrew/check/check.mjs`. It renders from every plan whose `observability.check.enabled` is true, and nothing when none is.
      - **The schedule:**
        - the interval from the first app's prod plan, or 15 for a public repository and 60 for a private one;
        - the minute offset is `1 + (hash(owner/repo) mod (interval − 1))`, then every interval, all below 60, never `:00`;
        - plus `workflow_dispatch`.
      - **The workflow:**
        - `permissions: { contents: read, issues: write }`;
        - workflow-level `concurrency: opscrew-check` without cancelling;
        - the job guard `if: github.repository == '<owner>/<repo>'`.
      - **The `check` job:**
        - on `ubuntu-slim` or `ubuntu-latest` as spike result 5 settles;
        - `timeout-minutes: 5`;
        - `actions/checkout` (pinned) with a sparse checkout of `opscrew/check`;
        - `node opscrew/check/check.mjs`.
        - Its `env:` maps `GITHUB_TOKEN`, `OPSCREW_CHECK_PAUSED: ${{ vars.OPSCREW_CHECK_PAUSED }}`, `OPSCREW_CHECK_SSH_KEY`, each environment's `<prefix>CHECK_SERVER` (`deploySecretPrefix`), and the webhook secrets when `webhook` is set.
      - **One job per server deployed from its own runner or a runner host:**
        - `runs-on` the deploy job's labels (`runnerLabel`);
        - `actions/setup-node` (pinned), then `--only disk:<id>`;
        - job-level `concurrency: opscrew-check-disk-<id>`.
      - **`check.json`:**
        - as data-model.md shows;
        - for each environment: its hostnames (with `www` when the plan serves it), and the health path (the plan's `healthPath`, or `/` for the server-less targets);
        - the server block only for the cloud and own targets, deduplicated by server id;
        - never an address.
    - **Tests:**
      - **The script, in Vitest with fakes:**
        - up, then down (one issue, then nothing on a repeat, a comment when another check also fails, closed with the duration);
        - one slow answer opening nothing;
        - a certificate with 10 days;
        - a disk at 86% and at 96%;
        - paused and destroyed environments;
        - inactivity at day 50 in a public repository and never in a private one;
        - issues off (exit 1, webhook posted);
        - each webhook's body and limit;
        - a response body holding a fake secret never reaching any text;
        - no address in any text.
      - **The renderer:**
        - snapshots for a public repository with one cloud environment;
        - a private one with a server runner, a Portainer environment and a Cloudflare app;
        - the cron minute never 0;
        - nothing rendered with the check off;
        - no address in any file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: xhigh

- [ ] T1708 [P] [US4] [US5] The add-on renderers (the Docker proxy, Beszel, Alloy), the masking file in the deploy job, and the Workers Logs guard, in `packages/iac-templates/src/addons/**`, `packages/iac-templates/src/workflow/**`, `packages/iac-templates/src/serverless/wrangler.ts`, and Beszel's hostname in `packages/iac-templates/modules/cloudflare-access/**`, `packages/iac-templates/src/infra/tunnel.ts`, `packages/iac-templates/src/generated/modules.ts`
  - Owns: those paths (+ tests, snapshots). In `serverless/wrangler.ts`, its test only, unless the guard finds a gap. `src/generated/modules.ts` only as `gen:modules` regenerates it.
  - Reads: spec US4, US5, FR-1702, FR-1711–FR-1714; contracts/observability.md "iac-templates"; research.md R5, R6, R7 and "Spike results" 1–3; plan.md "6."
  - Depends: T1701a, T1701b, T1702
  - Accept:
    - **`renderAddon(plan, "beszel" | "grafana-cloud")`** returns `compose.yaml`, the proxy's `Caddyfile`, and `config.yml` (Beszel's hub) or `config.alloy`.
    - **The Docker proxy** (`IMAGES.caddy`):
      - It listens on `unix//run/opscrew-docker-ro/docker.sock`, in a volume shared only with the add-on.
      - It passes only `GET` (and `HEAD`) on the add-on's allow-list, with an optional `/v1.NN` prefix, to `unix//var/run/docker.sock`:
        - **Beszel:** `/_ping`, `/version`, `/info`, `/containers/json` and `/containers/{id}/stats`;
        - **Alloy:** those, plus `/networks`, `/containers/{id}/logs` and `/containers/{id}/json` (spike result 3).
      - Everything else answers 403. `admin off`, `auto_https off`, `persist_config off`.
      - `flush_interval -1`.
      - The container runs with:
        - `read_only: true`, `cap_drop: [ALL]` with `cap_add: [NET_BIND_SERVICE]` (the binary carries that file capability), and `security_opt: [no-new-privileges:true]`;
        - `tmpfs: [/data, /config]` and `network_mode: none`;
        - `mem_limit` from the plan, and the logging limits every OpsCrew container has (spike result 1).
      - Research.md's "Spike results" item 1 has the working Caddyfile.
    - **Beszel:**
      - **Hub mode:**
        - **The hub:**
          - `127.0.0.1:8090:8090`, the `beszel_data` volume, `read_only` with `tmpfs: [/tmp]`, `cap_drop: [ALL]` and `no-new-privileges`;
          - `USER_EMAIL` and `USER_PASSWORD` from a root-only env file, with `CONTAINER_DETAILS=false` and `DISABLE_SSH=true`. `AUTO_LOGIN` is never set.
          - **Its key:** the host step (T1706) writes OpsCrew's generated Ed25519 key to `beszel_data/id_ed25519` before the first start.
        - **`config.yml`:** `systems: [{ name: <server>, host: localhost, port: 45876, token: <48 hex>, users: [<email>] }]` (spike result 2).
        - **The agent:**
          - `network_mode: host`, `read_only`, `cap_drop: [ALL]` and a `beszel_agent_data` volume at `/var/lib/beszel-agent` (`DATA_DIR`, so its fingerprint survives);
          - `HUB_URL=http://127.0.0.1:8090`, `TOKEN` and `KEY` from the env file, `DISABLE_SSH=true`, `DOCKER_IMAGE_CHECK=false` and `DOCKER_HOST=unix:///run/opscrew-docker-ro/docker.sock`.
      - **Agent mode:** only the agent and the proxy, with `HUB_URL` the plan's `hubUrl` and `KEY` its `hubKey`.
    - **Alloy:**
      - **The container:**
        - `run --storage.path=/var/lib/opscrew-alloy --disable-reporting /etc/alloy/config.alloy`, with a volume at `/var/lib/opscrew-alloy` (the image's own folder belongs to another user);
        - `read_only` with `tmpfs: [/tmp]`, `cap_drop: [ALL]` and `no-new-privileges`;
        - `/` and `/sys` mounted read-only under `/host`;
        - its own bridge network, never the host's, so its local API (which shows the masking values) stays inside the container;
        - `GOMEMLIMIT` at 80% of the limit (spike result 3).
      - **`config.alloy`:**
        - `discovery.docker` through the proxy's socket, kept to the app's Compose project;
        - labels `app`, `env` and `service`;
        - `loki.source.docker`;
        - `loki.process` with:
          - a `stage.replace` per pattern in core's `TOKEN_PATTERNS`, each checked to be RE2-compatible in a test;
          - the known values: `local.file` on `/srv/apps/<app>/mask.re` with `is_secret = true` and `poll_frequency = "10s"`, into `stage.replace { expression = convert.nonsensitive(local.file.mask.content) }`;
          - `stage.sampling` when `logSampling` is below 100;
        - then `loki.secretfilter` (spike result 3);
        - `loki.write` to `logs.url`, basic auth with `logs.user` and the token from a root-only file read by `local.file` with `is_secret`;
        - `prometheus.exporter.unix` with its own `/proc`, `rootfs_path = "/host/root"` and `sysfs_path = "/host/sys"`, `set_collectors` cpu, loadavg, meminfo and filesystem, and `filesystem { mount_points_exclude = "^/.+" }`;
        - `prometheus.relabel` keeping the allow-list, and dropping the CPU modes nice, irq, softirq and guest;
        - `prometheus.remote_write` to `metrics.url` with `metrics.user`.
      - **Nothing privileged:** no `privileged`, no Docker socket, no writable host mount.
    - **Beszel at a hostname** (`access: "subdomain"`): `cloudflare-access` gains Beszel's Access application and policy (the listed emails, after a one-time PIN), as Portainer's, behind optional variables that default to none; `infra/tunnel.ts` routes the hostname to the hub's local port. A plan without it renders byte-identical HCL. Both engines validate the module.
    - **The masking file:** when `grafanaCloud.enabled`, the deploy job writes `/srv/apps/<app>/mask.re` (root-only) in place from `app.env`'s values, after writing `app.env`.
      - It holds one escaped RE2 alternation, and no value shorter than 8 characters (as `Redactor.addLiteral`).
      - With no values, it holds `[^\s\S]`, which never matches.
      - Server workflows without it stay byte-identical.
    - **The Workers Logs guard (FR-1714):** a test that the generated Wrangler config keeps `observability.enabled: true`, with no `head_sampling_rate` below 1 and no `invocation_logs = false`.
    - **Tests:**
      - snapshots of each add-on in each mode;
      - the Caddyfile's allow-list as a table test (each allowed path passes, and `POST`, `exec`, `archive`, `export`, `images` and `volumes` are refused);
      - `config.alloy` with and without sampling;
      - no secret value in any rendered file;
      - an untouched server workflow without the add-on.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: high

## Phase 4: Agents (parallel)

- [ ] T1709a [P] [US1] `readLogs` for every target, in `packages/agents/src/logs/**`
  - Owns: that path (+ tests; fakes in `packages/agents/src/testing/logs.ts` (new))
  - Reads: spec US1, FR-1701–FR-1703, SC-1701; data-model.md "Log lines"; contracts/observability.md "Agents and surfaces"; research.md R1, R2 and "Spike results" 6–8; plan.md "7."; T1703's and T1705's reports
  - Depends: T1701a, T1703, T1705
  - Accept:
    - **`readLogs(deps, plan, { service?, since?, tail?, follow? })`** returns an async iterable of `LogLine`. It calls `registerAppSecrets` first.
    - **Targets:**
      - **Cloud and own servers:** over the same access `status` uses, the fixed command `docker logs --timestamps --tail <n> [--since <unix>] [--follow] <container>`.
        - The container is found by the Compose labels of the app's project and the service name.
        - Names are checked against `status/components.ts`'s pattern before they reach the command.
        - `--follow` streams through `onLine` and stops on `signal`. The remote command is wrapped so it ends when ssh goes, because without a terminal a quiet `docker logs --follow` outlives the CLI (spike result 8): `docker logs --follow … & p=$!; while kill -0 $PPID 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p`.
      - **Portainer:** `containerLogs`. `--follow` polls every 2 seconds with `since` just after the last line's nanosecond timestamp (spike result 7). When the token's user can't see the app's containers, it says that a standard user's token sees only that user's stacks.
      - **localhost:** `docker logs` through `deps.runner` with `onLine`.
      - **Cloudflare, SSR:** `workersLogs` for the past, and `workersTail` for `--follow`.
      - **Cloudflare static, and GitHub Pages:** one sentence ("<host> keeps no request logs for this site: its files are served without running any code"), then the last deploy runs with their result and link.
    - **Services:**
      - the web process, each worker, each cron job and each service by its plan name, and `edge`;
      - the edge's lines are named as the server's shared proxy;
      - an unknown name is refused with the list of names.
    - **Bounds:** default `tail` 200, and `since` parses `30s`, `15m`, `2h` or `3d`.
    - **The first line** says how far back the lines go: the oldest line's time, then "each deploy starts new containers, and each keeps up to 30 MB of logs". On Cloudflare it gives the dated allowance from `prices.ts` instead (research R2), and says that lines past it are missing. When T1703 can tell the day's allowance was reached (spike result 6), it says so plainly.
    - **Errors:**
      - a server that doesn't answer over SSH says so and suggests `verify`;
      - a missing Cloudflare permission names it.
    - **Every read is audited** as `remote-exec` without the address.
    - **Tests:**
      - each target with fakes;
      - follow over a scripted SSH stream, stopped by abort;
      - an unknown service;
      - a line holding a registered secret value, and a token-shaped value, both masked in the output;
      - no command built from an unchecked name.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: xhigh

- [ ] T1709b [P] [US2] Resource figures and the check's state in `status`, in `packages/agents/src/status/**`, and the disk thresholds' export in `packages/secops/src/hardening/checks.ts`
  - Owns: those paths (+ tests). In secops, only the export of the two thresholds (and its index line).
  - Reads: spec US2, FR-1704, FR-1708; data-model.md "Reading figures"; research.md R1, R2; plan.md "7."; T1703's, T1704's and T1705's reports
  - Depends: T1701a, T1703, T1704, T1705
  - Accept:
    - **`readResources(deps, plan)`** returns a `ResourceReading`:
      - **Servers:** one fixed command. Its output is parsed with zod, and anything else in it is ignored.
        - `nproc`, `cat /proc/loadavg`, `free -b` and `df -P -B1 /`;
        - `docker stats --no-stream --format '{{json .}}'` for the app's project containers;
        - `docker inspect --format` with only `.Name`, `.RestartCount`, `.State.StartedAt` and `.HostConfig.Memory`.
      - **Portainer:** `containerStats`, `containerInspect` and `dockerInfo`. `unavailable` names the host's disk. Containers the token's user can't see are named as not visible to that user, never as absent (spike result 7).
      - **localhost:** the same Docker figures through `deps.runner`, and `docker info` for the totals.
      - **Cloudflare:** `workersAnalytics` for the last 24 hours, against 100,000 requests a day and 10 ms of CPU time. It notes that requests served from the site's files aren't counted.
      - **GitHub Pages:** none, and `unavailable` says so. The latest build stays as today.
    - **Flags,** each with its meaning and what to do:
      - memory at 90% or more of a limit;
      - the disk at 85% (warning) and 95% (high), from secops' exported thresholds;
      - a restart since the last deploy.
    - **The check's state:** `checkWorkflowState` for `opscrew-check.yml`, and `openIssues(…, "opscrew-check")`.
      - **Off for inactivity:** says GitHub turned it off after 60 days without activity, and gives the Actions page and `gh workflow enable opscrew-check.yml`.
      - **Missing while a plan has the check on:** says to merge the deploy-setup pull request.
      - **Open alerts:** listed with their links.
    - **`componentStatusReport`'s lines** gain the figures. The function returns the reading, for the CLI and MCP.
    - **Tests:**
      - the server command's parse, with a container at 95% of its limit and a disk at 90%;
      - Portainer with the disk unavailable;
      - Cloudflare's figures;
      - the check off for inactivity;
      - no `Config.Env` value anywhere in the reading.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops` and `pnpm lint`
  - Effort: high

- [ ] T1710 [P] [US3] The check in agents: settings, cost, provision's check key, secrets and files, the pause, and `init`'s permission checks, in `packages/agents/src/check/**`, `packages/agents/src/{design,provision,retarget,destroy,init}/**`
  - Owns: those paths (+ tests). Not `design/components.ts` (T1711). Not `provision/secrets.ts`'s registering lines (T1701a).
  - Reads: spec US3, FR-1705–FR-1710, FR-1714; data-model.md "The plan block", "Secrets kept apart", "The check's files", "Alerts"; research.md R3, R4; plan.md "8."; T1704's, T1706's and T1707's reports
  - Depends: T1701a, T1704, T1706, T1707
  - Accept:
    - **Settings** (`check/`):
      - the "first app's prod plan only" rule for `intervalMinutes` and `webhook`, refused elsewhere with the file to edit;
      - the defaults (`enabled` on for prod and off elsewhere, set by design; the interval by visibility).
    - **Design:**
      - the check per environment, with the interval and the minutes a month: `(60 / interval) × 24 × 31` for the hosted job, against `includedMinutes`, or 2,000 with "GitHub Free's" when unknown. In a public repository: "free".
      - **Where design steps in:**
        - it warns when an interval the user set passes 750 minutes a month on a private repository on GitHub Free (or an unknown plan);
        - it says when issues are off;
        - it names the targets without a disk check (Portainer, Cloudflare, GitHub Pages);
        - it says localhost gets no check.
    - **Provision,** when the environment has the check on:
      - **The check key:** generated once (Ed25519), and added by the `check-key` host step on cloud and own servers (`host-apply`). The check is one per repository, so the key lives at the first app's prod `paths.files.checkKey` (`~/.opscrew/projects/<id>/check_key`), whatever app or environment is provisioned (T1701a's report).
      - **The secrets** (`github-secrets`), each set as a repository secret:
        - `OPSCREW_CHECK_SSH_KEY`;
        - `<prefix>CHECK_SERVER`, holding the host, port, user and known-hosts line;
        - `OPSCREW_CHECK_WEBHOOK` (and `OPSCREW_CHECK_NTFY_TOKEN`, optional), asked like an app secret and never echoed.
      - **The files:** `renderCheck`'s files, re-rendered from every app's and environment's plan, go into the deploy-setup pull request.
      - **The pause:** after a healthy deploy, the environment's entry in `OPSCREW_CHECK_PAUSED` is removed (`github-settings`).
    - **Retarget:** adds `{ reason: "retarget" }` when its window opens, and removes it at `--finish`.
    - **Destroy:** adds `{ reason: "destroyed" }`, and removes the check key line in its teardown.
    - **Variable updates** read, change one entry, and write back.
    - **`init`:**
      - with Cloudflare hosting in use, it checks `observabilityPermissions` (FR-1714);
      - with the check on, it checks the GitHub token's Issues, Actions and Variables permissions;
      - each missing permission is named, with where to add it.
    - **Tests:**
      - design's figures for public, private Free, and private Pro;
      - the interval rule;
      - provision's order (host step, secrets, files);
      - re-provision rendering the same files;
      - the pause set and cleared by each flow;
      - `init`'s messages;
      - no address in the pull request's files.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

- [ ] T1711 [P] [US4] [US5] The add-ons in agents: enable, disable, status and open, for Beszel and Grafana Cloud, and their memory in design, in `packages/agents/src/addons/**`, `packages/agents/src/design/components.ts`, `packages/agents/src/shared/memory.ts`, and `packages/agents/src/portainer/**` for exports only
  - Owns: those paths (+ tests; fakes in `packages/agents/src/testing/addons.ts` (new))
  - Reads: spec US4, US5, FR-1711–FR-1713; data-model.md "The plan block", "Secrets kept apart"; contracts/observability.md; research.md R5–R7 and "Spike results" 1–3; plan.md "9."; how `agents/src/portainer/run.ts` enables, disables and reports Portainer; T1706's and T1708's reports
  - Depends: T1701a, T1706, T1708
  - Accept:
    - **`addonEnable(deps, plan, kind, options)`** follows `portainerEnable`'s flow:
      - the plan's block written;
      - the host plan (`planAddon`) shown with each container's memory limit and its share of the monthly price (`memoryText`'s way);
      - approved by hash (`host-apply`);
      - the secrets on stdin;
      - the result recorded.

      It is refused off the cloud and own targets, and for a second app on the same server, each with the reason.
    - **Beszel:**
      - **Hub mode:** generates a password (24+ characters) and a token into Beszel's secrets file.
      - **Agent mode:** takes `--hub-url`, the hub's public key, and the token (from `OPSCREW_BESZEL_TOKEN`, or asked, never echoed).
      - **`subdomain`:** reuses Portainer's tunnel and Access path (`iac-apply`, `cloudflare-apply`), with the hub's local port as the route. It refuses without `allowedEmails`, and never makes the dashboard public. It also refuses a hostname that Portainer's web UI already uses on the server, since both go through one tunnel (T1701a's review).
      - **`addonOpen`:** runs `ssh -N -L 8090:127.0.0.1:8090` as Portainer's status command builds it, until stopped. It prints the local address and where the password is.
    - **Grafana Cloud:**
      - asks for the metrics URL and user and the logs URL and user (or takes flags), and the token from `OPSCREW_GRAFANA_CLOUD_TOKEN` or asked;
      - names the scopes, `metrics:write` and `logs:write` only, and where to create the token;
      - **before the host plan, the estimate:**
        - series from the allow-list and the server's CPUs, filesystems and interfaces (host facts);
        - logs as 30 × the bytes of `docker logs --since 24h` for the app's containers, a fixed read;
        - both against 10,000 series and 50 GB a month. Past either, it offers a `logSampling` that fits.
    - **`addonDisable`:** the teardown plan (`host-apply`). It removes everything the add-on added, its data included, after the typed app name (`allowDestroy`); `--keep-data` keeps Beszel's dashboard history and needs no typed name (spec US4 #5). The local secrets file is removed.
    - **`addonStatus`:** whether each add-on is on, its containers' state and memory, and how to open it.
    - **Memory:** `appMemoryLimits` and design's memory line count enabled add-ons.
    - **Tests:**
      - enable, re-enable (no change) and disable for each kind and mode;
      - refusals;
      - the estimate over and under the free tier;
      - the secrets never in the plan, the host plan's text, a report or the audit;
      - design's memory line with an add-on.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents` and `pnpm lint`
  - Effort: high

## Phase 5: Surfaces and the Docker pass (parallel)

- [ ] T1712a [P] [US1] [US2] [US4] [US5] [US6] The CLI, MCP and the plugin, in `packages/cli/src/**`, `packages/mcp-server/src/**`, `plugin/**`
  - Owns: those paths (+ tests)
  - Reads: spec US6, FR-1715; contracts/observability.md "Agents and surfaces"; plan.md "10."; quickstart.md; the reports of T1709a–T1711
  - Depends: T1709a, T1709b, T1710, T1711
  - Accept:
    - **`opscrew logs`:**
      - `--follow`, `--service <name>`, `--since <duration>`, `--tail <lines>`, and `--app` and `--env` through `addEnvOption` and `chooseEnvironment`;
      - output through `ctx.stdout` (redacted);
      - Ctrl-C stops a follow cleanly.
    - **`opscrew addon <enable|disable|status|open> <beszel|grafana-cloud>`** with `--mode`, `--hub-url`, `--access`, `--hostname`, `--allow-email` (repeatable), `--keep-data`, `--confirm <app>`, and the Grafana flags T1711 defines. Approvals work as `portainer`'s.
    - **`status`** prints the figures with their flags, and the check's state and open alerts.
    - **`ALL_COMMANDS`** has 25 entries, and `program.test.ts` lists both new names.
    - **MCP:**
      - **`opscrew_logs`** (`readOnlyHint: true`): at most 500 lines and 64 KiB, `truncated: true` past either, no follow, redacted through `runTool`;
      - **`opscrew_status`'s structured data** gains `resources` and `check`;
      - **`opscrew_addon_status`** (read-only), **`opscrew_addon_enable`** and **`opscrew_addon_disable`**, as `opscrew_portainer_status`, `_enable` and `_disable` are. Hash-bound approvals are never granted without the user.
    - **The plugin:**
      - **`plugin/skills/opscrew-troubleshoot/SKILL.md`:** for "why is it failing", "it's slow" and "how much does it use". It reads `opscrew_status` first, then `opscrew_logs` with a short `since` for the failing service. It explains the flags, and never asks for more than 500 lines.
      - `node plugin/validate.mjs` passes.
    - **Tests:**
      - each command's flags;
      - a follow stopped by abort;
      - MCP's bounds and redaction with a fake secret in the lines;
      - the command count.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`, `node plugin/validate.mjs` and `pnpm lint`
  - Effort: high

- [ ] T1712b [P] The guide, the README and the runbook, in `docs/guide/**`, `README.md`, `packages/iac-templates/src/runbook/**`
  - Owns: those paths (+ tests)
  - Reads: spec FR-1716 and the edge cases; research.md and its "Spike results"; quickstart.md; the reports of T1707–T1711
  - Depends: T1709a, T1709b, T1710, T1711
  - Accept:
    - **`logs-and-status.md`:**
      - `logs` on each target, its flags, how far back lines go, and masking;
      - the figures and flags in `status`;
      - what each target can't give: the host's disk on Portainer, and request logs on GitHub Pages and on a static site on Cloudflare;
      - Cloudflare's allowance, dated.
    - **`alerts.md`:**
      - what the check checks, and where it runs (the check key, and the runner jobs);
      - the issues and the webhook (how to set Slack, Discord or ntfy);
      - the interval and its cost against each plan;
      - GitHub's 60-day rule and how to turn the check on again;
      - planned outages, forks, and issues off;
      - what it can't do: minute-level alerting, the user's computer, and Portainer's disk.
    - **`beszel.md`:**
      - hub and agent modes, opening it, and the subdomain behind Access;
      - the read-only proxy and what Beszel can't see (container settings and logs);
      - memory, Beszel's own alerts, and turning it off.
    - **`grafana-cloud.md`:**
      - the account and the token's two scopes;
      - what is sent, and the masking;
      - the estimate and the free tier;
      - that Alloy can read the containers' settings, the app's environment included, on the server;
      - no container metrics;
      - turning it off, and the data that stays in Grafana Cloud.
    - **The index and the README** link them. `security.md`'s token lists gain T1703's and T1704's permissions.
    - **The runbook** gains:
      - the check (what an `opscrew-check` issue means, how to pause it);
      - `logs`;
      - each add-on when on.
    - No "before X" framing.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates` and `pnpm lint`
  - Effort: high

- [ ] T1713 [P] [US3] [US4] [US5] The Docker pass, in `packages/cli/test/e2e/**`, `examples/**`
  - Owns: those paths
  - Reads: plan.md "11."; research.md "Spike results" 1–4
  - Depends: T1706, T1707, T1708
  - Accept:
    - **With `OPSCREW_DOCKER_TESTS=1`:**
      - **The proxy:** in front of the test host's Docker, the rendered Caddyfile answers each allowed `GET`. It refuses `POST /containers/{id}/stop`, `POST /containers/{id}/exec`, `GET /containers/{id}/archive`, `GET /containers/{id}/export` and `GET /images/json` with 403, and the container stays running.
      - **Beszel:** the rendered hub mode starts. The agent connects through the proxy, the hub's API lists the system and its containers, and each container stays within its `mem_limit` after 2 minutes.
      - **Alloy:** the rendered config, pointed at a local Loki and a Prometheus receiver in containers.
        - A line with a fake secret from an example container arrives masked, labelled app, env and service.
        - The allow-listed series arrive, and nothing else does.
      - **The check key:** an `sshd` container with the forced-command line answers `df` output to `ssh … rm -rf /tmp/x` and to `ssh … bash`, and refuses a port forward.
    - Every container, image, volume and network is removed by label afterwards.
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm turbo run test --filter=opscrew -- test/e2e/<the new file>` and `pnpm lint`
  - Effort: high

## Phase 6: Live

- [ ] T1714 Live tests, in `packages/cli/test/live/**`, `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: quickstart.md; plan.md "12."
  - Depends: T1712a, T1712b, T1713
  - Accept:
    - **Observability on a cloud server** (`OPSCREW_E2E_OBSERVABILITY=1`, the private throwaway repository):
      - **`logs`:** the latest lines within 10 seconds, and `--follow` showing a request's line within 10 seconds of the request (SC-1701).
      - **`status`:** the figures.
      - **The check, with the workflow run by dispatch:**
        - the app stopped opens one issue, and a second run adds nothing;
        - the app started closes it with the duration (SC-1702);
        - a file filling the disk past 85% opens the disk issue (SC-1703);
        - the webhook to an ntfy topic (`OPSCREW_E2E_NTFY_TOPIC`) receives both.
      - **Retarget's pause:** the window's run opens no issue.
      - **The billed minutes** of a passing run, logged against SC-1705.
    - **Add-ons** (`OPSCREW_E2E_ADDONS=1`):
      - **Beszel** in hub mode: enabled, its API answering through the tunnel, its memory logged, disabled leaving nothing (SC-1706).
      - **Grafana Cloud,** when `OPSCREW_E2E_GRAFANA_CLOUD_*` (metrics and logs URLs and users, the write token, and a read token for the test's queries) are present:
        - the app's lines and the server's CPU, memory and disk queried back within 5 minutes;
        - the series under 1,000 (SC-1707);
        - disabled leaving nothing.
    - **The other targets (SC-1701):** the existing own-server (`OPSCREW_E2E_OWN_SERVER`), Portainer (`OPSCREW_E2E_PORTAINER`) and localhost (`OPSCREW_E2E_LOCAL_RUNNER`) passes each gain a step: `logs` shows the latest lines within 10 seconds, `logs --follow` a request's line within 10 seconds, and `status` the figures (the host's disk named as not available on Portainer).
    - **Cloudflare** (`OPSCREW_E2E_CLOUDFLARE_HOSTING=1`, the SSR example): `logs` and `logs --follow` showing a request, and `status`'s figures.
    - **The leak search:** a seeded secret, printed by the example app, searched in every output (SC-1704):
      - the terminal;
      - MCP's `opscrew_logs`;
      - the issues and the ntfy posts;
      - the Grafana Cloud lines;
      - the audit log.
    - **Leftover checks:** the helper scripts learn the check key line, the add-on folders and containers, the `opscrew-check` issues and label, and the variable.
    - **The docs:** `docs/e2e.md` sections, and the coverage page's rows as "Not run yet".
  - Verify: `pnpm turbo run typecheck --filter=opscrew` and `pnpm lint`
  - Effort: high

- [ ] T1715 Live runs (lead), after T1714: the passes in `docs/e2e.md`, with the results in `docs/e2e-coverage.md` (its Live results and the status at a glance).

## End-of-feature simplify pass (after T1715)

- [ ] T1716 The end-of-feature simplify pass (lead): duplication across 017's changes, and the items collected during the waves.
  - Portainer's drift still registers the app's values itself. Move it to `registerAppSecrets` (T1701a).
  - `shared/app-secrets.ts` imports `generatedValuesFile` from `provision/secrets.ts`, which imports it back (a harmless cycle, T1701a's report). Move `generatedValuesFile` into `shared/`, and have Portainer's drift use `app-secrets.ts`'s `GeneratedValuesSchema` instead of its own copy (T1701a's review).
  - The fixed read commands now live in `status/components.ts`, `HOST_CHECKS`, `inspect.ts`, the figures and the logs. Decide whether one table of allowed read commands is smaller than five.

## Dependencies

{T1701a, T1701b}, with T1702 (lead) once T1701b's pins exist → {T1703, T1704, T1705, T1706, T1707, T1708} → {T1709a, T1709b, T1710, T1711} → {T1712a, T1712b, T1713} → T1714 → T1715 → T1716.

**User stories:**
- **US1** (logs): T1701a, T1703, T1705, T1709a, T1712a.
- **US2** (figures): T1703, T1704, T1705, T1709b, T1712a.
- **US3** (the scheduled check): T1704, T1706, T1707, T1710, T1713.
- **US4** (Beszel): T1701b, T1706, T1708, T1711, T1713.
- **US5** (Grafana Cloud): T1701b, T1706, T1708, T1711, T1713.
- **US6** (Claude Code): T1712a.

## Parallel waves

1. T1701a, T1701b. Their Owns are disjoint: plan-schema, contracts, core's paths and agents' seams; iac-templates' pins and module seams. Then T1702, the lead's spike.
2. T1703, T1704, T1705, T1706, T1707, T1708. Their Owns are disjoint:
   - three connectors (the GitHub one with agents' `FakeGitHub` methods) and the host adapter;
   - iac-templates' `check/` with `generated/check.ts` and `gen-modules.ts`;
   - iac-templates' `addons/`, `workflow/` and the Wrangler test.
3. T1709a, T1709b, T1710, T1711. Their Owns are disjoint:
   - `logs/`;
   - `status/`;
   - `check/` with design (except `components.ts`), provision, retarget, destroy and init;
   - `addons/` with `design/components.ts`, `shared/memory.ts` and Portainer's exports.
4. T1712a, T1712b, T1713.
5. T1714, then T1715, then T1716.

## Implementation strategy

- **MVP:** US1 and US2, logs and figures in the terminal. T1701a, T1703, T1705, then T1709a, T1709b and their CLI part.
- **Then:** US3 (the check), then US6 (Claude Code), then US4 and US5 (the add-ons).

Each wave is merged, gated and pushed before the next starts.
