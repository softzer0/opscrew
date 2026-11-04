---
description: "Tasks for 020-self-hosted-monitoring"
---

# Tasks: Self-hosted monitoring

**Input**: `specs/020-self-hosted-monitoring/`:
- spec.md, plan.md, research.md (R1–R6, and R7 from T2001), data-model.md;
- contracts/monitoring.md;

plus `docs/adr/0024-self-hosted-monitoring.md`, and features 000–019 (017's add-ons and 018's
network above all).

**Numbering**: T2001–T2099.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify / Effort`.

**Rules for every task:**
- **Fixtures** never contain secret-shaped literals. Use `fakeSecret()`, or `{{FAKE:…}}` with
  `materializeFixture()`. WireGuard keys in tests come from the injected key maker, never copied.
- **No network:**
  - Hetzner, DigitalOcean, GitHub and the servers are fakes.
  - Host steps are rendered and parsed, and run in bash against fakes where the step tests already
    do.
  - Tests that need bash or Docker skip with a clear message when it is absent.
- **No leaks:** none of these may appear in an approval's text, the output, an audit entry, a
  committed or generated file, a host plan's text, a snapshot or an MCP answer (SC-2008):
  - Grafana's admin password, or the Postgres monitoring password;
  - a WireGuard private key;
  - an app secret, a value of `app.env`, or a token;
  - a server's public address.

  Every task's tests include a leak check for the values it handles.
- **Approvals:** the monitoring server through the IaC plan (`iac-apply`). Every server's change
  through a host plan (`host-apply`), by its hash. The repository's files through the deploy-setup
  pull request. Deleting the server or the stack's data needs `allowDestroy` and the typed name. No
  new approval kind, and no change in `@opscrew/contracts`.
- **Unchanged without monitoring:** a plan without `observability.monitoring` renders every file
  byte-identical to today's, Grafana Cloud's included (snapshots).
- **Refusals** come before any change, are in plain words, and end "Nothing was changed." with what
  to do next. User-facing text never names a feature number.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** write long files with the Write or Edit tool, not shell heredocs (Windows
  Defender blocks some).
- **Neutral examples only:** `example.com`, `example-app`, and `203.0.113.0/24` for public
  addresses.

## Phase 1: Foundation

- [x] T2001 The spike and the ADR (lead): research.md R7, and `docs/adr/0024-self-hosted-monitoring.md` from Proposed to its final text.
  - **The spike** (plan.md Technical Context, S1–S7), on local Docker with the pinned Alloy and the
    candidate Prometheus, Loki, Grafana and Caddy images.
  - **The results:** one line per question in research.md "R7": what was run, and what was seen.
  - **They settle:**
    - cAdvisor inside Alloy through the read-only proxy, or a separate container (S1);
    - the memory defaults and the smallest server (S2);
    - Grafana's password file, `schemaVersion` and phone-home (S3);
    - Loki's config (S4);
    - Caddy's metrics listener (S5);
    - the images' architectures (S6);
    - two destinations in one Alloy, and the WAL while the stack is down (S7).

    A finding that changes a design goes into plan.md before wave 1.
  - **The ADR** records D1–D6 as the lead decides them.

- [x] T2002 The contract: `observability.monitoring`, the outside member, rules, helpers and the stubs, in `packages/plan-schema/**` and the stub modules
  - Owns:
    - `packages/plan-schema/**` (+ tests, fixtures, and the generated `schemas/plan.schema.json`);
    - the stubs, with their exports and nothing else: `packages/iac-templates/src/monitoring/index.ts`,
      `packages/agents/src/monitoring/index.ts`, `packages/agents/src/provision/monitoring.ts`, and
      their export lines in `packages/iac-templates/src/index.ts` and `packages/agents/src/index.ts`.
  - Reads: plan.md "1."; data-model.md "The plan"; contracts/monitoring.md "plan-schema"; research.md R7 (S2)
  - Depends: T2001
  - Accept:
    - `MonitoringSchema`, `MonitoringWhereSchema` and the constants as the contract says, in
      `ObservabilitySchema`, with `ADDON_MEMORY_DEFAULTS.monitoring` from S2.
    - **Each rule of data-model.md** has a test that fails without it, with its plain message:
      - not on a server target;
      - `kind: "server"` naming a missing server, or one with services, or one that isn't a member;
      - `kind: "shared"` without its outside member;
      - an outside member without `kind: "shared"`;
      - `versions.alloy` differing from `grafanaCloud.version`.
    - 018's member rule admits the outside member only then.
    - `monitoringOf`, `monitoringServerName` and `isOutsideMember`, tested.
    - Every existing fixture plan parses, and its output is unchanged.
    - The JSON schema is regenerated.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema && pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

- [x] T2003 [P] Pins: Prometheus, Loki and Grafana by digest, Alloy to 1.21.3, in `packages/iac-templates/src/pins.ts`
  - Owns: `packages/iac-templates/src/{pins.ts,pins.test.ts,pin-snapshots.ts,pin-snapshots.test.ts}`, `packages/iac-templates/scripts/update-pins.mjs`, `packages/iac-templates/src/__snapshots__/**` (updated by the test run only)
  - Reads: plan.md "3."; research.md R1, R7 (S6)
  - Depends: T2001
  - Accept:
    - `IMAGES.prometheus`, `IMAGES.loki` and `IMAGES.grafana`, each `repo:tag@sha256:<index
      digest>` with amd64 and arm64 in its index, read with `update-pins.mjs`;
    - `IMAGES.alloy` at 1.21.3;
    - `update-pins.mjs` refreshes the three;
    - the pin tests pass.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: medium

## Phase 2: Wave 1 (parallel)

- [x] T2004 [P] [US1] [US3] [US6] The stack's files, in `packages/iac-templates/src/monitoring/`
  - Owns: `packages/iac-templates/src/monitoring/**` except `dashboards/` (+ tests, snapshots)
  - Reads: plan.md "4."; data-model.md "On the servers"; contracts/monitoring.md "T2004"; research.md R3, R4, R7 (S2–S5); `addons/proxy.ts`, `addons/compose.ts`, `runtime/services.ts` (`hardened`)
  - Depends: T2002, T2003
  - Accept:
    - **`renderMonitoringStack(input)`** returns the files of plan.md 4., snapshot-tested for:
      - a monitoring server on one network;
      - one shared by two networks;
      - `kind: "app"` with and without devices.
    - **Prometheus:** the receiver flag, and both retention flags from the settings.
    - **Loki:** the config from S4, with `retention_period` from `logsDays`.
    - **Grafana:**
      - the two provisioned data sources (`editable: false`);
      - the dashboard provider (`allowUiUpdates: false`) over T2005's files;
      - the hardening variables;
      - the password file as S3 settles.
    - **Publishing:**
      - Grafana on `127.0.0.1`, and on each private address only with devices;
      - the front on each private address at `MONITORING_PUSH_PORT`;
      - nothing else published.
    - **The front's Caddyfile:**
      - `admin off`;
      - the two `POST` paths routed;
      - everything else 403;
      - a body cap.
    - **Every service:** `hardened()`, with its limit from `memoryMb` and its volume.
    - **Every file's header** names the plan and the regenerating command.
    - No secret value in any file: the password is only a file path.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2005 [P] [US2] The six dashboards and their queries, in `packages/iac-templates/src/monitoring/dashboards/`
  - Owns: `packages/iac-templates/src/monitoring/dashboards/**` (+ tests, snapshots)
  - Reads: plan.md "5."; data-model.md "The labels every series carries"; contracts/monitoring.md "T2005"; research.md R4, R7 (S3, S5)
  - Depends: T2002
  - Accept:
    - `renderDashboards({ caddy })` gives servers, containers, http, caddy, postgres and logs, with
      the panels of plan.md 5., stable uids and the `app`, `env` and `server` variables.
    - With `caddy: false`, http and caddy hold one text panel saying they need Caddy, the default
      edge.
    - `DASHBOARD_QUERIES` lists every panel's query, its dashboard, its title and its data source.
    - **Tests:**
      - the JSON parses;
      - uids are unique;
      - each panel's data source is `opscrew-prometheus` or `opscrew-loki`;
      - every label in every query is in `MONITORING_LABELS` or is a metric's own (an allow-list in
        the test).
    - Snapshots of the six files.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2006 [P] [US1] Alloy on any server, with two destinations, in `packages/iac-templates/src/addons/`
  - Owns: `packages/iac-templates/src/addons/{alloy.ts,index.ts,proxy.ts,compose.ts}` (+ tests, `__snapshots__/**`, `__fixtures__/**`)
  - Reads: plan.md "6."; data-model.md "The labels"; contracts/monitoring.md "T2006"; research.md R2, R7 (S1, S5, S7); 017's plan.md "6."
  - Depends: T2002, T2003
  - Accept:
    - **`renderAlloyConfig(plan, server, destinations)` and `renderAlloyCompose`** as plan.md 6.:
      - sources per server;
      - cAdvisor on the cgroups only, named through `discovery.docker` limited to the app's and
        OpsCrew's projects (research R7, S1), with the proxy's allow-list unchanged;
      - the Caddy scrape on the edge's server;
      - the Postgres exporter on Postgres's server, its data source from a secret file;
      - the `app`, `env` and `server` labels on everything;
      - masking unchanged;
      - fan-out after masking, with sampling only on Grafana Cloud's branch;
      - the stack's writers to the given address, with the queue and retry settings of plan.md 6.;
      - Caddy's `server` label as `caddy_server`, its metrics handler dropped;
      - every scrape at 15 s, and Alloy's HTTP server on `127.0.0.1`.
    - **Snapshots:**
      - monitoring only on the app's server;
      - monitoring on an extra server with Postgres;
      - both destinations on the app's server.
    - **The Grafana Cloud-only output** is byte-identical to today's (the existing snapshots,
      unchanged).
    - No secret value in any file.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: xhigh

- [x] T2007 [P] [US1] [US2] Caddy's figures and the masking file on every server, in `packages/iac-templates/src/edge/` and `packages/iac-templates/src/workflow/`
  - Owns: `packages/iac-templates/src/edge/index.ts`, `packages/iac-templates/src/workflow/{index.ts,servers.ts}` (+ their tests, `__snapshots__/**`, `__fixtures__/**`)
  - Reads: plan.md "7."; research.md R4, R7 (S5); 017's plan.md "6." (the masking file)
  - Depends: T2002
  - Accept:
    - **Always (every plan with a Caddy edge, plan.md 7.):**
      - the Caddyfile gets `metrics { per_host }` and the `http://:<CADDY_METRICS_PORT>` site with
        only `metrics`;
      - the port isn't published;
      - `observe_catchall_hosts` is off;
      - `EDGE_VERSION` is raised.
    - **The masking file:**
      - with monitoring on, the deploy job writes it on the app's server, and the extra servers'
        upload step writes it on each extra server;
      - each from the values that server receives;
      - readable only by the deploy user (`0600`, as 017 writes it), never in the repository.
    - **Without monitoring,** every workflow's snapshots are unchanged (Grafana Cloud-only plans
      too); the edge's change for every plan, as above.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates`
  - Effort: high

- [x] T2008 [P] [US1] [US3] [US7] The host adapter: the `monitoring` step, `alloy` on any server, `grant`'s `monitor`, in `packages/connectors/ssh-host/**`
  - Owns: `packages/connectors/ssh-host/**` (+ tests, fixtures, snapshots)
  - Reads: plan.md "8."; data-model.md "On the servers", "The host record"; contracts/monitoring.md "ssh-host"; research.md R7 (S3); 018's `grant.ts`
  - Depends: T2002
  - Accept:
    - **`monitoring` step,** as plan.md 8.:
      - check, apply, verify and removal;
      - Grafana's password from stdin into a `root:root 0640` file (research R7, S3);
      - volumes removed only with `removeData`;
      - the host record's owner;
      - ownership conflicts refused as `addonTaken` refuses them.
    - **`alloy` step:** `server` and destinations in its params; the Postgres password from stdin,
      written as the whole data source into a file only the deploy user reads (`0600`). Today's Grafana Cloud plan text is unchanged.
    - **`grant`'s `monitor`,** Postgres only:
      - creates or updates `opscrew_monitor` with `pg_monitor`;
      - its check reads the login and the role;
      - other kinds refused.
    - **Facts:** the stack's containers and file hashes, and Alloy's destinations, parsed with zod.
    - **Secrets:** neither secret appears in a plan's text, its hash input, the record or a log
      (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: xhigh

## Phase 3: Wave 2 (parallel)

- [x] T2009 [US1] [US4] [US5] [US6] [US7] Turning it on and off: settings, sizing, the estimate, the repository's server, in `packages/agents/src/monitoring/`
  - Owns:
    - `packages/agents/src/monitoring/**` except `status.ts` (+ tests, `__fixtures__/**`);
    - `packages/agents/src/shared/memory.ts`;
    - `packages/agents/src/design/{servers.ts,kept-edits.ts,sizing.ts,placement-edits.ts,placement.ts,own-servers.ts}` `serverMemoryText` in `design/components.ts`, and passing the monitoring settings through `design/{options.ts,run.ts}` to the sizing (+ tests; the last six added at the lead's decision during the task: keeping monitoring across a re-design, and sizing for the stack);
    - in `packages/agents/src/addons/run.ts`, only the dispatch of `monitoring` to
      `monitoringEnable` and `monitoringDisable`.
  - Reads: plan.md "9."; spec US1, US4–US7; data-model.md; research.md R3, R7 (S2); `addons/estimate.ts`, `design/servers.ts`, `network/allocate.ts`, 013's app list
  - Depends: T2002, T2003
  - Accept:
    - **`monitoringEnable`:**
      - refuses each case of plan.md 9. before any change, each with its message, and an
        unsupported target;
      - adds the `monitoring` server sized and priced through 018's code (a Hetzner fixture gives
        the smallest type that fits);
      - creates the network when absent;
      - with an existing repository server, uses `shared` unless `--new-server`;
      - for `shared`, copies the owner's `versions` and `retention` into the sender's plan, and
        design refuses a sender whose copies differ from its owner's, naming the owner's plan;
      - `--on app` checks 4 GB and the fit;
      - one of the user's own servers, set as the monitoring server in the plan, is checked against
        its facts' memory instead of sized.
    - **The estimate:**
      - series and log volume per server, summed across senders;
      - `metricsMaxGb`;
      - the 80% refusal;
      - tested on fixtures with known figures.
    - **The summary text** has every item of FR-2001, the licence sentence, and, for `shared`,
      that devices of every network see every environment.
    - **`monitoringDisable`:** refuses while senders exist, naming them; otherwise removes the
      settings and the server entry.
    - **Design:** keeps the settings and the server across a re-design, refuses a service placed on
      the monitoring server, and sizes the server for the stack, not for services.
    - **`appMemoryLimits`:** counts Alloy on every monitored server, and the stack on its server.
    - **Nothing is written** to any server, account or repository: only the plan (the fakes see no
      call).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2010 [P] [US3] [US5] The network: the monitoring member's filter rules and the outside member, in `packages/agents/src/network/`
  - Owns: `packages/agents/src/network/**` (+ tests, `__fixtures__/**`)
  - Reads: plan.md "10."; data-model.md "A sender"; 018's plan.md "7.", research R5a; `shared/server-record.ts`
  - Depends: T2002
  - Accept:
    - **`networkFilterRules`:**
      - no published port on any server admits the monitoring server's address;
      - on the stack's server, the push port admits the network's other servers only, and
        Grafana's port admits the devices only;
      - tested on one network and on a shared server's two.
    - **The outside member:**
      - allocation: address, port from the monitoring server's facts, a key with its private half
        in the sender's generated values;
      - the endpoint from the owner's server record, never in the plan;
      - `networkSteps(plan, owner.server, facts)` with `otherInterfaces`;
      - `readNetwork` lists it;
      - the removal params when it leaves.
    - **A plan without monitoring** gives the same rules and steps as today (existing tests,
      unchanged).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

## Phase 4: Wave 3 (parallel)

- [x] T2011 [US1] [US4] [US5] [US7] Provision: the host plans per server, the secrets, the shared server, in `packages/agents/src/provision/monitoring.ts`
  - Owns: `packages/agents/src/provision/monitoring.ts` (+ test), and in `packages/agents/src/provision/{run.ts,secrets.ts}` only the calls into it and the two generated values (+ their tests); `packages/agents/src/testing/**` for the fakes it needs; in `packages/agents/src/move/{app-env.ts,window.ts}` only the masking file's lines (+ tests); in `packages/connectors/ssh-host/**` a public planner for removing one network interface (`planNetworkRemoval`), and the add-on and grant planners' in-place checks from inspection facts (+ tests); `registerAppSecrets` in `packages/agents/src/shared/app-secrets.ts`; in `packages/agents/src/addons/run.ts` the Grafana Cloud path when monitoring is on; `serverForNetwork`'s export in `provision/servers.ts`
  - Reads: plan.md "11."; spec US1, US4, US5, US7; data-model.md "Secrets kept apart"; 018's `provision/network.ts`, `provision/servers.ts`
  - Depends: T2004, T2006, T2007, T2008, T2009, T2010
  - Notes from wave 1:
    - T2010's review: drop the outside member when a sender's owner changes (`allocateNetwork`
      keeps a member by name only, with the old server's port and key); never pass Grafana's or
      the front's port in the filter's `published` list (the schema refuses a duplicate port).
    - T2010: for a sender, the monitoring server's `network` and `network-filter` steps come from
      `networkSteps(plan, owner.server, facts)`; turning off or leaving uses `networkRemovalSteps`,
      planned through a small new ssh-host planner for one interface (`planNetworkRemoval`: today
      the removal steps exist only inside `planTeardown`/`planUndo`). Reach the owner's plan,
      login and record through `monitoringOwner(paths, plan)` from `network/`.
    - T2008: the `monitoring` step always runs as root (pass `rootImage` and the facts; `runAs`
      only picks the folder). Plan it with the owner's app name, a sender re-rendering it too:
      only the recorded owner may change or remove the stack. `grant`'s `monitor` reads
      `monitoringPostgresPassword`; the login is the exported `MONITOR_LOGIN`. Generate the Postgres
      password as 16–128 letters and digits, Grafana's as 16–128 letters, digits, `-` and `_`.
    - T2007: `maskFileScript` now returns a script with monitoring on and no Grafana Cloud, so a move
      rewrites `mask.re` for those plans too. Update `writeMask`'s comment in `move/app-env.ts` and
      the move window's text in `move/window.ts` (it lists the rewrite only with Grafana Cloud): gate
      it on `maskFileScript(plan) !== ""`.
    - T2006: with monitoring on, Alloy's Compose file names `opscrew-edge`, `<app>_internal` and
      `opscrew-monitoring-push` as external networks: they must exist before the `alloy` host plan
      runs (a fresh extra server before its first deploy too). Pick Postgres per server as T2006
      does: the first enabled Postgres whose `server` is that server.
    - T2006: `renderAddon(plan, "grafana-cloud")` ignores monitoring; call `renderAlloyConfig` and
      `renderAlloyCompose` with both destinations. The proxy's Caddyfile is `renderProxyCaddyfile`.
  - Accept:
    - **The order of plan.md 11.,** each host plan shown and approved by its hash, tested on:
      - a cloud monitoring server;
      - `--on app`;
      - a `shared` sender (the monitoring server's network, filter and stack host plans run over
        the owner's login);
      - an extra server with Postgres.
    - **The stack's input** is built from every plan in the repository that sends to it.
    - **Grafana's and Postgres's passwords:** generated once, kept, and passed only on apply. A
      second provision reuses them.
    - **Turning off:**
      - the removal host plans in reverse;
      - Alloy reverts to Grafana Cloud only where it is on;
      - the stack's data is removed only after the typed confirmation;
      - the server goes through the existing typed-name deletion.
    - **The deploy-setup pull request** carries T2007's changed files.
    - **The summary** names `opscrew addon open monitoring`.
    - **A plan without monitoring:** provision's calls and approvals are the same as today
      (existing tests, unchanged).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: xhigh

- [x] T2012 [P] [US3] [US6] Status, open, verify, secure and drift, in `packages/agents/src/{monitoring/status.ts,addons/status.ts,status,verify,secure,drift}`
  - Owns: `packages/agents/src/monitoring/status.ts` (+ test); in `packages/agents/src/addons/status.ts` the monitoring branches; the monitoring parts of `packages/agents/src/{status,verify,secure,drift}/**` (+ tests, fixtures, snapshots)
  - Reads: plan.md "12."; spec US3, US6; 017's `addons/status.ts` (`ADDON_CONTAINERS_COMMAND`, `addonOpen`)
  - Depends: T2004, T2008, T2009, T2010
  - Accept:
    - **`monitoringStatus`:**
      - fixed commands, project names checked, audited as `remote-exec`, answers parsed with zod;
      - containers and memory;
      - each server's last figures and last log line;
      - the volumes' sizes;
      - the silent flag after 5 minutes, with what to check.
    - **`addon status` and `status`** show it. `status`'s line is one per monitored environment.
    - **`addonOpen` for monitoring:** the private address with `thisDevice`, the tunnel otherwise,
      the US3 #5 refusal, and where the password is.
    - **`verify`:** containers healthy and data recent.
    - **`secure`:** the public ports and the private publishing with the filter in place.
    - **`drift`:** the `monitoring` and `alloy` steps per server.
    - Fakes only. No address or password in any output (leak test).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 5: Wave 4 (parallel)

- [x] T2013 [P] [US7] Destroy and retarget, in `packages/agents/src/{destroy,retarget}/`
  - Owns: the monitoring parts of `packages/agents/src/{destroy,retarget}/**` (+ tests, fixtures); in `packages/agents/src/provision/monitoring.ts` `leaveMonitoringServer`'s export and `leave()` skipping an owner with no deployment (added at the lead's decision)
  - Reads: plan.md "13."; spec US5 #4, US7; 018's `destroy/servers.ts`
  - Depends: T2011
  - Accept:
    - **The owner:** destroy refuses while senders exist, naming them. Otherwise it removes the
      stack, Alloy everywhere and the server, with its typed name.
    - **A sender:** destroy removes its Alloy, then on the monitoring server that network's
      interface and filter, and re-renders the stack without its address, each by its hash.
    - **Own servers:** only what was there before stays.
    - **`retarget`** refuses with monitoring on, with the commands to turn it off.
    - Plans without monitoring destroy and retarget as today (existing tests, unchanged).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

- [x] T2014 [P] [US1] [US3] [US6] [US8] The CLI, MCP and the plugin's skill
  - Owns: `packages/cli/src/commands/{addon.ts,status.ts}` (+ tests), `packages/mcp-server/src/tools/addons.ts` (+ test, fixtures), `plugin/skills/opscrew-troubleshoot/**`
  - Reads: plan.md "14."; contracts/monitoring.md "CLI and MCP"; spec US8
  - Depends: T2011, T2012
  - Accept:
    - **The CLI:**
      - `addon enable monitoring [--on app|server] [--new-server] [--metrics-days <n>] [--logs-days <n>]`
        (the two retention options passed to `monitoringEnable`, from T2009), `addon disable monitoring` and
        `addon open monitoring [--port]`, with help text;
      - `addon status`'s section and `status`'s line;
      - the next-step line after enable says to run `opscrew provision`.
    - **MCP:** the three add-on tools accept `monitoring` with the CLI's approvals; status is
      read-only; no answer holds a password or address (leak test).
    - **The skill:** opening the dashboards, what each shows, and that the data stays on the user's
      server.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

- [x] T2015 [P] [US2] [US3] [US6] [US7] The guide and the runbook
  - Owns: `docs/guide/monitoring.md`, `docs/guide/index.md`, the links in `docs/guide/{logs-and-status,beszel,grafana-cloud,private-network}.md`, `packages/iac-templates/src/runbook/observability.ts` (+ test, snapshots)
  - Reads: spec.md; plan.md; the other guide pages for tone
  - Depends: T2009, T2012
  - Accept:
    - **`monitoring.md`,** written for users:
      - (from T2006) an app with no domain yet has no HTTP figures: Caddy serves it for any host,
        so the HTTP and Caddy dashboards fill once it has its domain;
      - (from T2006's S7) with Grafana Cloud on too, a monitoring server down for hours delays
        Grafana Cloud's logs once the agent's queue fills;
      - what runs, and where;
      - the price;
      - turning it on (both placements and the shared server);
      - opening Grafana (device or tunnel) and the password;
      - the six dashboards;
      - retention and disk;
      - status;
      - turning it off;
      - the licences;
      - what it doesn't do (alerts stay with the scheduled check).
    - The index and the four pages link to it.
    - The runbook gains a monitoring section, rendered only with monitoring on (snapshot); other
      runbooks are unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: medium

- [x] T2021 [P] [US3] [US5] `opscrew vpn add` and `vpn remove` on a sender update the monitoring server, in `packages/agents/src/vpn/`
  - Owns: the monitoring parts of `packages/agents/src/vpn/**` (+ tests, fixtures)
  - Reads: spec US3 ("Other devices added with `opscrew vpn add` reach the same private address"), US5 #5; plan.md "10.", "11."; 018's `vpn/`; T2010's `monitoringOwner` and `networkSteps(plan, owner.server, facts)`
  - Depends: T2011
  - Accept:
    - On a sender (`where.kind: "shared"`), `vpn add` and `vpn remove` also plan the monitoring
      server's `network` and `network-filter` host plans for that network's interface, over the
      owner's login, each shown and approved by its hash, so the device reaches Grafana at once
      (found at T2010: today only the sender's own servers learn of the device).
    - Its output says the device sees every environment's dashboards on that server.
    - A plan without monitoring, and the owner's plan, behave as today (existing tests unchanged).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents`
  - Effort: high

## Phase 6: Wave 5 (parallel)

- [x] T2016 [P] The Docker pass (`OPSCREW_DOCKER_TESTS=1`), in `packages/cli/test/e2e/monitoring.test.ts` (+ support)
  - Owns: `packages/cli/test/e2e/monitoring.test.ts`, `packages/cli/test/e2e/monitoring-support.ts`, and fixture apps under `packages/cli/test/e2e/__fixtures__/monitoring/**`
  - Reads: plan.md "15."; spec SC-2003–SC-2005; 018's `network.test.ts` for the harness
  - Depends: T2004, T2005, T2006, T2007
  - Accept: every assertion of plan.md 15.'s Docker pass:
    - every query in `DASHBOARD_QUERIES` answers with data within 2 minutes;
    - a known value and a token-shaped value logged by the app are stored masked;
    - limits are held;
    - the front gives 403 for anything else;
    - Grafana's data sources, dashboards, login from the file, and sign-up off;
    - figures kept through a 2-minute stop of the stack.

    It cleans up its containers, volumes and images (targeted removal only).
  - Notes from T2005: `caddy_http_request_errors_total` exists only after a handler error, so the
    pass causes one (a 502 from a stopped upstream). Docker Desktop gave no `node_filesystem_*`
    series in the spike: check the servers dashboard's two disk panels, and if they can only be empty
    on Docker Desktop, say so in the test and leave them to the live pass.
  - Verify: `OPSCREW_DOCKER_TESTS=1 pnpm --filter opscrew exec vitest run test/e2e/monitoring.test.ts`
  - Effort: xhigh

- [x] T2017 [P] The live tests (gated on `OPSCREW_E2E_MONITORING=1` and the Hetzner token), in `packages/cli/test/live/monitoring.test.ts` (+ support), `docs/e2e.md`, `docs/e2e-coverage.md`
  - Owns: those paths
  - Reads: plan.md "15."; spec's Independent Tests; 018's `split.test.ts`
  - Depends: T2013, T2014
  - Accept:
    - the live pass of plan.md 15.;
    - each step recorded as the coverage page records them ("N of M steps");
    - cleanup that deletes every server even when a step fails;
    - `docs/e2e.md` says how to run it.
  - Check at merge of T2011 and T2014 (written into the guide before they merged, by T2015): `docs/guide/monitoring.md`'s note that Alloy starts at the provision after a new app's first deploy, the CLI flags (`--on server` included), the "From Claude Code" text, and the runbook's typed confirmation for the stack's data.
  - Verify: `pnpm turbo run typecheck --filter=opscrew` (the live run is T2018's)
  - Effort: high

## Phase 7: Live, simplify, release (lead)

- [ ] T2018 The live runs (lead): T2017's pass, then `docs/e2e-coverage.md` updated per run. Findings become tasks.
- [ ] T2019 The simplify pass (lead): `/simplify` (or reviewers by area) over the whole feature's diff; real findings become tasks.
  - Noted at merge: `catalogs()` in `monitoring/enable.ts` repeats design's private `extraCatalogs`; `pinnedVersion` in `monitoring/settings.ts` repeats the one in `addons/settings.ts` (T2009).
  - Noted at merge: `vpn/monitoring.ts` repeats provision's private `currentOwner`/`joinedOn` lookup and `otherServer(owner)` wording (T2021).
  - Noted at merge: destroy's owner refusal repeats `monitoringDisable`'s wording and command list (T2013). `MonitoringStackInput.networks[].servers`/`devices` are still unused by the stack (T2004; `hasDevices` already removed at T2021).
  - Noted at merge: `runAddonChange`'s preflight calls the `shell` closure twice on a server OpsCrew created (T2011).
  - Noted at merge: `postgresOn` from `addons/alloy.ts` is copied in `provision/monitoring.ts` (T2011). 018's "Waiting for server X at <ip>" lines print public addresses (outside 020; consider masking).
  - Noted at merge: `drift/monitoring.ts` has its own `monitoringStackInput`; switch it to T2011's export. `monitoringDrift` inspects each server a second time, apart from `serversDrift` (T2012).
  - Noted at merge: `monitoringOwner` (T2010) reads an owner's paths back from `owner.plan`; any similar code in T2009, T2011 or T2012 should use it.
  - Noted at merge: `escapeRegExp` is a private one-liner in `addons/alloy.ts`, `docker/stacks.ts` and `edge/vercel-routing.ts` (T2006).
  - Noted at merge: `pinnedTag` in `workflow/__fixtures__/plans.ts` and `imageVersion` in `cli/test/e2e/monitoring-support.ts` repeat `pinnedVersion`'s tag slicing (T2007, T2016); the Docker pass repeats `grant.ts`'s monitor-login SQL because `grantEngine` isn't exported (T2016).
  - Noted at merge: the add-on project names (`opscrew-beszel`, `opscrew-monitoring`) are plain strings in `addons/alloy.ts` (T2006).
  - Noted at merge: `GO_MEMORY_SHARE` is defined in both `monitoring/compose.ts` and `addons/alloy.ts`; `MonitoringStackInput.networks[].servers`/`devices` are unused by the stack (T2004).
### From the simplify pass (three reviewers by area, 2026-11-04)

Every task keeps behaviour: plans without monitoring render byte-identical files (the edge
excepted), the 017 plan texts stay, and no test loses what it proves. Rejected by the lead:
`planNetworkRemoval`'s input shape and dropping its plan-time owner check (refusing before the
approval is safer); exporting `grantEngine` for the Docker pass's one SQL line.

- [x] T2022 A change of secrets only reaches the server (correctness, found by the ssh-host reviewer), in `packages/connectors/ssh-host/**` and the callers in `packages/agents/src/{provision/monitoring.ts,addons/run.ts}`
  - Owns: `packages/connectors/ssh-host/src/{steps,plan,types,apply}.ts` (+ tests, fixtures, snapshots); in agents `provision/monitoring.ts` and `addons/run.ts` only the places that pass `secretsChanged` or a grant's in-place (+ tests); `packages/agents/src/testing/addons.ts`'s comparison; `packages/agents/src/vpn/grants.ts` for a device's regenerated password (018 had the same flaw)
  - Reads: `apply.ts` `runStep` (a check printing `state=in-place` skips the apply); `MONITOR_HELPERS`' `files_ok` (secret files only `-s`); `grantScripts`' check (the login's attributes only); T2011's notes
  - Depends: none
  - Accept:
    - A step param bound into the plan's hash (`rewrite: true`) makes its check print
      `state=change`, so the apply runs; the planners set it when a secret changed: the `alloy`
      step with `secretsChanged` (a new Grafana Cloud token or Postgres monitoring password), the
      `beszel` step with a new token, and `grant`'s `monitor` when the password wasn't kept.
    - Real-shell tests: an in-place step with a new secret applies and writes it (the token file,
      the data source, the login's password); without `rewrite` an unchanged step stays in place.
    - 017's Grafana Cloud token rotation through `addon enable grafana-cloud` now reaches the
      server (it had the same flaw); its plan text gains only the new param when a token is given.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents`
  - Effort: high

- [x] T2023 [P] Simplify the templates and the plan schema, in `packages/iac-templates/**`, `packages/plan-schema/**`, and the regex escape helper
  - Owns: `packages/iac-templates/src/{monitoring,addons,edge,workflow,runbook}/**` and `scripts/update-pins-lib.ts` (+ tests, snapshots, fixtures), except `MonitoringStackInput`'s shape (T2025); `packages/plan-schema/src/{plan.ts,monitoring.test.ts}` (+ the generated schema); `packages/core/src/{text.ts,redact.ts}` (+ tests); `packages/iac-templates/src/docker/stacks.ts`, `edge/vercel-routing.ts` and agents `shared/server-address.ts` only for the escape helper
  - Accept (the iac-templates reviewer's findings 2, 3, 4 for iac-templates' own tests, 5, 6, 7, 8, 9, 10, and its notes):
    - the stack's snapshots: every file for one case, `compose.yaml` only for the other three;
    - `goMemLimit(mb)` in `addons/compose.ts`, used by the stack and Alloy (`GO_MEMORY_SHARE` once);
    - the tests' monitored plans from `addons/__fixtures__/plans.ts` (`monitoredPlan`, `MONITORING`);
      `pinnedTag` and the workflow fixture's version copies gone;
    - in `addons/alloy.ts`: `environmentName`, `listText`, an exported `postgresOn` (by
      `servicesOn`), one `appLabels`, the Alloy project name built once, `BESZEL_PROJECT` exported
      from `beszel.ts` and used;
    - the dashboards' shared variable fields, one `DATASOURCES` used by provisioning, uids built
      once; dead exports `MONITORING_DIR` and `MONITORING_LABELS` (into the test) removed, the
      contract updated by the lead;
    - plan-schema: the never-alone "not on the private network" rule and its test removed; tests
      that restate constants or repeat a snapshot removed;
    - one exported `escapeRegExp` in `@opscrew/core` (`text.ts`), used by redact, alloy, docker
      stacks, vercel routing, update-pins-lib and agents' server-address (not `adapt/health/text.ts`,
      which also escapes `/`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/core --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents`
  - Effort: high

- [x] T2024 [P] Simplify agents' monitoring settings, enable, status and the generated values, in `packages/agents/src/**`
  - Owns: `packages/agents/src/{monitoring/{enable,settings,estimate,status}.ts,addons/{settings,status}.ts,design/{run,servers}.ts,shared/app-secrets.ts,provision/secrets.ts,secure/{monitoring,servers}.ts,verify/monitoring.ts,index.ts,monitoring/index.ts}` (+ tests); not `provision/monitoring.ts`, `addons/run.ts`, `drift/`, `vpn/`, `destroy/`, `network/` (T2022, T2025)
  - Accept (the agents reviewer's findings 4, 5, 6, 10, 11, 12, 13 except `repository.ts`, 14 for the source, 17 except destroy):
    - one `changeGenerated` for the generated values (`GeneratedFileSchema` gains `monitoring`);
    - enable's stack-only design and stack literal built once each, `roomOf` reused, the
      summary's room built once; `extraCatalogs` exported from design and used;
    - `STACK_SERVICES` and `stoppedServices`, `memberName` and `environmentServers` shared;
    - dead exports removed (the root's `./provision/monitoring`, the unused monitoring and status
      exports); `pinnedVersion` exported from `addons/settings.ts` and used; `serverCostItem`
      inlined; the small items; `MONITORING_VERSIONS` (the pinned versions) exported from
      `monitoring/settings.ts` for the tests.
    - If `addons/run.ts`'s `enableFlags` or `shell` items need that file, leave them to T2025.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server`
  - Effort: high

- [x] T2025 The stack's input, the owner helpers and drift's copies (after T2022, T2023, T2024), across iac-templates and agents
  - Owns: `packages/iac-templates/src/monitoring/{index,compose}.ts` (the input's shape) and its tests; agents `network/owner.ts` (+ test), `network/__fixtures__/plans.ts`, `provision/monitoring.ts` (+ test), `drift/monitoring.ts`, `vpn/monitoring.ts`, `destroy/monitoring.ts`, `monitoring/{disable,repository,estimate}.ts`, `monitoring/{shared,monitoring}.test.ts`, `addons/run.ts`; `packages/cli/test/e2e/monitoring.test.ts` (its input call); `monitoring/enable.ts` for `enableFlags` and the owner wording; `monitoring/status.test.ts`'s call sites of the stack input
  - Accept (iac-templates finding 1; agents findings 1, 2, 3, 7, 8, 9, 13's `repository.ts`, 15, 17's destroy item):
    - `renderMonitoringStack(plan, addresses)`: the stack reads `monitoringOf(plan)`; the
      `servers`/`devices` builders go; drift uses provision's builder and `monitoringAlloy`;
    - `otherServer`, `currentOwner`, `joinedOn` exported from `network/owner.ts` and used by
      provision, vpn and drift, with one owner wording;
    - one sender refusal helper for disable and destroy; one `enableFlags`; `shell` resolved once;
    - `postgresOn` imported from iac-templates in provision and the estimate (a second
      Postgres's server now counts its 40 series); `monitoringSenders` gone;
    - the `networked(plan, facts?)` test fixture added to `network/__fixtures__/plans.ts` for T2027.
    - from T2022's review: the Postgres monitoring password is made once per run in memory and
      saved only after the last step that uses it (Alloy) is applied, so a refused or failed step
      leaves nothing saved and the re-run plans the same `rewrite` hashes; tests for the refusal of
      Alloy after the grant and for a lost password reaching both (`provision/secrets.ts`'s
      `monitoringPassword` is in this task's Owns for that).
    - from T2024: drift calls `stoppedServices` from `monitoring/status.ts`; the owner wording at
      `enable.ts` (~486) uses the shared one (`enable.ts` is in this task's Owns for that line).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents && pnpm turbo run typecheck --filter=opscrew`
  - Effort: high

- [x] T2026 [P] Simplify the host adapter's tests and source (after T2022), in `packages/connectors/ssh-host/**`
  - Owns: `packages/connectors/ssh-host/**`
  - Accept (the ssh-host reviewer's findings 1, 2, 5–14): the monitor grant cases folded into
    `grant.test.ts`; the copied test helpers moved to `__fixtures__/helpers.ts`; the fake's recreate
    copy and the test of it gone; one `scriptsFor` helper; `AddonVariant` computing destinations;
    one `ALLOY_SECRET_FILES`; `files_ok` no longer opening the data source (the host file only); the
    destinations normalised in the schema; the grant tuple, the parent-cleanup fragment and the
    small items. Plan texts unchanged (017's snapshots).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host`
  - Effort: high

- [ ] T2027 [P] The tests' shared fixtures (after T2025), in agents and the CLI's test harnesses
  - Owns: agents `{vpn,retarget,destroy,provision}/monitoring.test.ts`, `monitoring/status.test.ts`; `packages/cli/test/{e2e,live}/monitoring*.ts`; the hand-built owner wording at `monitoring/enable.ts` (~328), to use `otherServer` (found at T2025)
  - Accept (agents findings 14 for the Docker pass, 16, and the `opscrew-alloy` note): one
    `networked(plan, facts?)` fixture (added by T2025) used by the five tests; `MONITORING_VERSIONS`
    for the pins; `catalog()`/`deployed` shared; the Docker pass's `imageVersion` gone; the live
    test's `opscrew-alloy` from `ADDON_PROJECTS.alloy`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm turbo run typecheck --filter=opscrew`
  - Effort: medium

- [ ] T2020 The release (lead): `docs/releasing.md`, from the changelog to the plugin bump and the docs site sync. A patch version (0.2.1): plans without monitoring render byte-identical, so no project has to be redone. Only a minor version (0.3.0) if the feature ends up changing files that existing projects must redo (`docs/releasing.md` 1.).

## Dependencies

T2001 → {T2002, T2003} → {T2004, T2005, T2006, T2007, T2008} → {T2009, T2010} → {T2011, T2012} →
{T2013, T2014, T2015, T2021} → {T2016, T2017} → T2018 → T2019 → T2020.

T2005 needs only T2002, and T2016 needs only wave 1, so either can start early when a slot is free.

**User stories:**
- **US1** (a monitoring server): T2002, T2004, T2006, T2007, T2008, T2009, T2011, T2014.
- **US2** (dashboards): T2005, T2007, T2015, T2016.
- **US3** (private access): T2004, T2008, T2010, T2012, T2014, T2021.
- **US4** (on the app's server): T2009, T2011.
- **US5** (one server for the repository): T2002, T2009, T2010, T2011, T2013, T2021.
- **US6** (retention, disk, status): T2004, T2009, T2012, T2014.
- **US7** (off, destroy): T2008, T2009, T2011, T2013.
- **US8** (Claude Code): T2014.

## Parallel waves

0. T2001 (the lead's spike and ADR), then T2002 and T2003.
1. T2004, T2005, T2006, T2007, T2008. Their Owns are disjoint:
   - `monitoring/` without `dashboards/`;
   - `monitoring/dashboards/`;
   - `addons/`;
   - `edge/index.ts` and `workflow/`;
   - the ssh-host connector.
2. T2009, T2010: `monitoring/` with design's sizing and `shared/memory.ts`; `network/`.
3. T2011, T2012: provision; status, verify, secure and drift.
4. T2013, T2014, T2015, T2021: destroy and retarget; CLI, MCP and the skill; the guide and the runbook;
   `vpn add`/`remove` on a sender.
5. T2016, T2017: the Docker pass; the live tests.
6. T2018, then T2019, then T2020 (lead).

## Implementation strategy

- **MVP:** US1–US3 on a separate monitoring server for one environment: T2002–T2012 without the
  shared parts, then T2014.
- **Then:** US6 (status and retention), US7 (off and destroy), US4 (on the app's server), US5 (the
  shared server), US8.

Each wave is merged, gated and pushed before the next starts.
