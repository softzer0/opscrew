---
description: "Tasks for 027-shared-hosting"
---

# Tasks: Shared hosting accounts (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed

**Input**: `specs/027-shared-hosting/` (spec.md, plan.md, research.md R1–R11) + features
000–026; ADR 0030.

**Numbering**: T2701–T2799.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Live account rule:** no implementer touches the founder's cPanel account or any real panel. Only
the lead's spikes and live passes do, with every object named `e2e-…`. Fakes replay the answers
research R10 and R11 record, failures included.

**Byte-identical rule (FR-2714):** no task changes what OpsCrew generates for the other targets:
every existing `__snapshots__` file and test expectation stays as it is, unless the task's Accept
names the change.

## Phase 1: Contract and packages (lead)

- [x] T2701 The contract, ADR 0030, constitution 1.10.0 and the packages (lead)
  - Owns: `packages/contracts/src/**`, `docs/adr/0030-*.md`, `.specify/memory/constitution.md`, `packages/connectors/{cpanel,plesk,directadmin,sftp}/*` (package files and `src/index.ts`), `packages/iac-templates/src/hosting/index.ts` and its placeholder modules, `packages/iac-templates/src/index.ts`, the consumers' `package.json`, `pnpm-lock.yaml`
  - Accept:
    - `packages/contracts/src/hosting.ts` as plan 1 says (`HostingPanel`, `HostingFacts`, `HostingPanelKind`, `HostingOperation`, `PanelStep`, `HostingCronJob`, `HostingCertificate`), exported from the root; `ApprovalKind` gains `hosting-apply`.
    - Skeletons of `@opscrew/connector-{cpanel,plesk,directadmin,sftp}`; `iac-templates/src/hosting/index.ts` re-exporting `./agent`, `./workflow` and `./env-php` (placeholders); agents and cli depend on the four connectors; the lockfile regenerated.
    - ADR 0030 accepted. Constitution 1.10.0: principle I names the hosting adapter; the provider order and the CI/CD bullet name hosting accounts and the release signing key.
  - Verify: `pnpm check`
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [x] T2702 [P] [US1] The `hosting` target in the plan, and a plain refusal everywhere else
  - Owns: `packages/plan-schema/src/**`, `schemas/**`; in `packages/{agents,iac-templates,secops,cli,mcp-server}/src/**`, only the branches the new union member needs (never `packages/iac-templates/src/hosting/**`)
  - Reads: plan 1; research R8; ADR 0019, ADR 0030; `plan-schema/src/plan.ts` (`DeployTargetSchema`, `GithubPagesTargetSchema`, `SiteSchema`, the `dns` block), `plan-schema/src/enums.ts`, `plan-schema/src/placement.ts`
  - Depends: T2701
  - Accept:
    - **`HostingTargetSchema`** (strict), per plan 1:
      - `provider: "hosting"`, `panel` (`cpanel`, `plesk`, `directadmin`, `sftp`), `app` (`static`, `php`, `node`, `python`);
      - `webRoot`: a relative path without `..` (`.` allowed);
      - `site?: SiteSchema`;
      - `php?` (`{ version: "X.Y", via: "account" | "multiphp" | "handler" }`);
      - `database?` (`{ engine: "mariadb" | "mysql", name }`, the name `[a-z0-9_]` without the account's prefix);
      - `cron` (`{ schedule, command }[]`, default `[]`);
      - `runtime?` (`{ interpreter: "nodejs" | "python", version, startup }`);
      - `docroot` (`direct` | `link`, default `direct`).
    - **Refinements**, each with a plain message:
      - `sftp` refuses `database`, `cron`, `runtime`, the `node` and `python` apps, and `php.via` other than `account`;
      - `static` refuses `php`, `database` and `runtime`;
      - `node` and `python` need `runtime`;
      - the plan needs `dns.domain` with a hosting target (it is the hostname).
    - **Guards and names:** `HostingPanelSchema`, `isHostingTarget`, `isHostingProvider`; `onServer` stays a positive list, and a test proves it refuses `hosting`; `TARGET_NAMES` gains "a hosting account".
    - `DeployTargetSchema` gains the target; `schemas/plan.schema.json` and `requirements.schema.json` are regenerated.
    - Every exhaustive `switch` or `Record` over `target.provider` elsewhere compiles with a branch that refuses plainly: "<what> isn't available for a hosting account." Nothing changes for other targets.
  - Verify: `pnpm check`
  - Effort: xhigh

- [x] T2703 [P] [US1] [US4] cPanel's connector
  - Owns: `packages/connectors/cpanel/src/**`
  - Reads: plan 1, 7; research R1, R10, R11; `packages/contracts/src/hosting.ts`; `packages/connectors/portainer/src/` (client, errors, fakes)
  - Depends: T2701
  - Accept:
    - **The client:**
      - UAPI (`/execute/<Module>/<function>`) and API2 (`/json-api/cpanel` with `cpanel_jsonapi_apiversion=2`), `Authorization: cpanel <user>:<token>`;
      - an injected `fetch`, a timeout, and every answer validated with zod;
      - failures (an `OpsCrewError` `PROVIDER_ERROR` with the panel's reason): a UAPI `status: 0`; an API2 `event.result: 0`, a `data[].result: 0` or an `error`, since R10 saw `event.result: 1` alongside "Invalid filename";
      - the token is registered with the redactor and is in no error, log line or message.
    - **`CpanelPanel implements HostingPanel`** (every operation supported):
      - **`inspect()`:**
        - `Variables::get_server_information` (`docroots_in_public_html_only`, the shared address);
        - `DomainInfo::domains_data`, `Quota::get_quota_info`, `Mysql::get_restrictions`;
        - `Features::list_features` (the selectors, `multiphp`, `passengerapps`);
        - `PassengerApps`' limit, and `LangPHP::php_get_installed_versions` where `multiphp` is on.
      - **Hostnames:** `SubDomain::addsubdomain` (`dir` relative to home) for a name under one of the account's domains, otherwise API2 `AddonDomain::addaddondomain`; removal (`SubDomain::delsubdomain`, `AddonDomain::deladdondomain`); `DomainInfo::single_domain_data`.
      - **Databases:**
        - `Mysql::create_database`, `create_user` and `set_privileges_on_database` (ALL PRIVILEGES);
        - `delete_user`, `delete_database` and `list_databases`;
        - a removal is followed by a list; a database still or again listed is made and removed once more (R10's reappearing database).
      - **Cron:** API2 `Cron::add_line` (answers its `linekey`), `listcron` (without the trailing `{count}` entry), `remove_line`.
      - **Files:**
        - `writeFile` uploads to a temporary name (`Fileman::upload_files`, `permissions`), then renames it to the target with `fileop rename`. An existing target is removed first with `fileop unlink`, since `rename` refuses an existing name (R10); that is the one non-atomic case, used only for files the agent doesn't read while running. Requests always go to fresh names.
        - `uploadTar` uploads, unpacks (`fileop extract`) and removes the tar;
        - `readFile` (`get_file_content`) answers `undefined` for a missing file;
        - `remove` is `fileop unlink`, recursive for a folder (as the spikes' cleanup).
      - **Certificates:**
        - `SSL::installed_hosts`, `get_autossl_problems`, `is_autossl_check_in_progress`, `start_autossl_check`;
        - `removeCertificate(id)` is `SSL::delete_cert`, then `delete_key` when no other certificate uses the key.
      - **PHP:** `LangPHP::php_set_vhost_versions`, refused plainly where `multiphp` is off.
    - **Fakes,** exported from the package root for agents' tests, replaying R10's and R11's answer shapes, failures included.
    - **Tests:** each call's success and failure, the reappearing database, the temporary-name write, and the token's absence from every error.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cpanel && pnpm lint`
  - Effort: xhigh

- [x] T2704 [P] [US1] [US2] [US4] The agent
  - Owns: `packages/iac-templates/src/hosting/{agent,env-php}*.ts`, `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/__snapshots__/{agent,env-php}*`, `packages/iac-templates/src/hosting/__fixtures__/**`
  - Reads: plan 2, 3, 5, 6; research R4, R10, R11; ADR 0028 (D7, D11), ADR 0030; `connectors/ssh-host/src/shell.ts` (quoting), `iac-templates/src/workflow/snapshot-script.ts`, `detect/src/release/native.ts`
  - Depends: T2701
  - Accept:
    - **`AGENT_SH`** is the agent, a constant the same for every app: `#!/bin/bash`, `set -eu`, its body in `main() { …; }; main "$@"; exit`.
    - **`renderAgentSettings(settings)`** renders `settings.sh`, one quoted assignment per line with no secret, each field checked against its expected form (a plain `INVALID_INPUT` naming the field otherwise):
      - the app, environment, hostname and repository (`owner/name`);
      - the web root, the health path and the app kind;
      - the PHP CLI path and the handler (empty unless `handler`);
      - the release command, the shared paths and the number kept;
      - snapshots on or off, and the database's name.
      - Nothing from the repository, the panel or a request is ever evaluated as code.
    - **The first run** generates `keys/github` (`ssh-keygen -t ed25519 -N ''`) and writes `state/report` (key=value):
      - the public key;
      - `-v` and `-m` of `/usr/local/bin/php`, each `/opt/alt/php*/usr/bin/php` and each `/opt/cpanel/ea-php*/root/usr/bin/php` present;
      - `git`, `openssl`, `flock`, `mysqldump`, `tar` and `curl` found or not;
      - GitHub over SSH on 22 and on `ssh.github.com:443` ("Permission denied (publickey)" counts as reachable).
    - **Each run** follows plan 3's steps 2 to 10, under `flock -n`:
      - `git` with `GIT_SSH_COMMAND` (the key, `IdentitiesOnly=yes`, `-F /dev/null`, `UserKnownHostsFile=keys/known_hosts`);
      - the signature checked with `openssl dgst -sha256 -verify keys/release.pub -signature` over `<tree id> <run id> <attempt> <env>` (no newline). A test vector made with a fixed ECDSA P-256 test key (generated in the test) is shared with T2705.
      - `(run id, attempt)` must exceed `state/last`, which is written before the attempt.
    - **The `.htaccess`** is composed by the agent per plan 5:
      - OpsCrew's block first, then the panel's and the selector's blocks carried byte for byte from the running release's served folder, then the app's own file;
      - `.user.ini`, `php.ini` and `.well-known/` are carried too;
      - the HTTPS redirect is added once `curl` verifies a certificate on the hostname, and the running release's block is updated in place (written to a temporary file, then `mv`);
      - the `php_value` lines go inside the three `IfModule` wrappers, and the prepend setting also goes into `.user.ini`.
    - **Requests:**
      - `requests/*.req`, key=value, are read with a strict key and value check and never sourced;
      - one is carried out once, before `expires` (UTC epoch seconds), when `sha256sum` matches its name; the answer goes to `state/<name>.result` (`done`, or `refused` with a reason);
      - **kinds:** `rollback` (to a kept release; with `restore=yes`, the current database is dumped first, then the target's dump restored), `env` (`shared/.env.next` renamed into place, Laravel's config cache when present, the restart), `snapshot` and `restore` (into and from `dumps/`).
    - **Modes** per plan 5; Laravel's cached config is 0600. `state/agent.log` is trimmed to 1,000 lines.
    - **`renderEnvPhp(names)`** (`env-php.ts`): valid PHP 7.0; it loads the 0600 values file into `getenv()`, `$_ENV` and `$_SERVER`, and answers 500 without output when the file is missing.
    - **Tests** run the agent with `bash`, `git`, `openssl` and `ssh-keygen` in a temporary folder, skipping with a clear message where one is missing; `flock` cases skip where it is missing.
      - Setup: a local bare repository is the release remote (the SSH options are bypassed by a test-only setting); `curl` and `php` are stubs on `PATH`.
      - Cases:
        - the first run's report;
        - a good release (the switch, the restart file, the purge file made and removed, the status);
        - a bad signature, and an old signed release pushed again (refused, nothing switched);
        - a failing release command (the running release untouched);
        - a failing check (switched back);
        - each request kind, and an expired or altered request;
        - the panel's `.htaccess` block carried byte for byte;
        - a run with nothing new;
        - pruning;
        - a held lock.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

- [x] T2705 [P] [US1] The deploy workflow for a panel account
  - Owns: `packages/iac-templates/src/hosting/workflow*.ts`, `packages/iac-templates/src/hosting/__snapshots__/workflow*`
  - Reads: plan 4; ADR 0023, ADR 0026 (D4), ADR 0030; `iac-templates/src/workflow/{github-pages,build,pause,jobs,shared}.ts`, `iac-templates/src/pins.ts`
  - Depends: T2701
  - Accept:
    - **`renderHostingWorkflow(input)`** renders `.github/workflows/opscrew-<env>.yml`:
      - push to the deploy branch, and `workflow_dispatch`;
      - the deploy pause's job-level `if:` (ADR 0023);
      - `environment: <env>`;
      - jobs build → publish → wait, with `contents: write` only on publish.
    - **Build** per plan 4:
      - PHP: Composer with `--ignore-platform-req='ext-*'` in the pinned `php:<version>-cli` image, Composer pinned; the asset build when `package.json` has a `build` script;
      - a static site's `site` build, whose output is the release;
      - a Node.js app's build without `node_modules`.
    - **Publish:**
      - the tree goes into an orphan commit through a temporary index with `git add --force`, without `.git`, `.github`, `node_modules` and `opscrew/`;
      - the trailer is `OpsCrew-Release: <run id> <attempt> <env> <base64 signature>`, signed with `openssl dgst -sha256 -sign` and the key from `OPSCREW_RELEASE_SIGNING_KEY` written to a 0600 temporary file, never echoed. T2704's test vector verifies it.
      - a shallow fetch of the previous `opscrew/release/<env>` (its absence is fine), then a force-push.
    - **Wait:** per plan 4, with its failure text.
    - Actions pinned by commit SHA as the other workflows are.
    - **Tests:**
      - snapshots per kind of app;
      - a test whose fixture's `.gitignore` ignores `vendor/` and `dist/`, which the commit still contains;
      - a `php-plain-mysql`-shaped app (`ext-pdo_mysql`) whose build passes the platform check.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: high

- [x] T2706 [P] [US1] GitHub: deploy keys and GitHub's host keys
  - Owns: `packages/connectors/github/src/deploy-keys*.ts`, and the methods it adds to `packages/connectors/github/src/{github,connector,index}.ts`
  - Reads: plan 2, 6; `connectors/github/src/github.ts`
  - Depends: T2701
  - Accept:
    - **Deploy keys:**
      - `addDeployKey(owner, repo, title, publicKey)` is always `read_only: true` and answers the key's id;
      - an existing key with that title and key is reported, not duplicated;
      - GitHub's 422 "key is already in use" becomes a plain message that a deploy key serves one repository only;
      - `listDeployKeys` and `removeDeployKey(id)`.
    - `githubSshHostKeys()` reads `ssh_keys` from `/meta`, validated, and answers known-hosts lines for `github.com` and `[ssh.github.com]:443`.
    - The release branch is removed with the existing `deleteBranch`.
    - `fetch` fakes for each call and failure.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-github && pnpm lint`
  - Effort: medium

- [x] T2707 [P] [US7] Plesk's connector
  - Owns: `packages/connectors/plesk/src/**`
  - Reads: plan 1, 7; research R2; `packages/contracts/src/hosting.ts`; Plesk's REST and XML API references (official pages only)
  - Depends: T2701
  - Accept:
    - **The client:** the REST API (`/api/v2/`, port 8443) with an API key (`X-API-Key`) or a customer's basic auth, and the XML API only where REST lacks a call; an injected `fetch`, zod, plain errors, credentials kept out of every error.
    - **`PleskPanel implements HostingPanel`:**
      - its `operations` hold only what a customer's API documents;
      - every other operation's `panelStep` names the Plesk screen and the exact value (the agent's scheduled task, for example);
      - code comments cite the official page each call comes from.
    - **Fakes** from the documented answer shapes, exported for agents' tests; a test per call and per panel step.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-plesk && pnpm lint`
  - Effort: high

- [x] T2708 [P] [US7] DirectAdmin's connector
  - Owns: `packages/connectors/directadmin/src/**`
  - Reads: plan 1, 7; research R3; `packages/contracts/src/hosting.ts`; DirectAdmin's API reference (official pages only)
  - Depends: T2701
  - Accept:
    - **The client:** the JSON API (`/api/…`, port 2222) and the legacy `CMD_API_*` calls (`?json=yes`) with basic auth and a login key; an injected `fetch`, zod, plain errors, the key kept out of every error.
    - **`DirectAdminPanel implements HostingPanel`** from the documented calls: `CMD_API_SUBDOMAINS`, `/api/db-manage` and `/api/db-show`, `CMD_API_CRON_JOBS`, the file manager's upload and extract, `CMD_API_SSL`. The rest are panel steps.
    - **Fakes** exported for agents' tests; a test per call and per panel step.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-directadmin && pnpm lint`
  - Effort: high

- [x] T2709 [P] [US8] OpenLiteSpeed's container spike, research R12 and ADR 0031 (lead)
  - Owns: research R12, `docs/adr/0031-*.md`
  - Accept:
    - R7's container questions are answered in R12:
      - the configuration files' syntax under `openlitespeed -t`;
      - TLS 1.2 and 1.3 only;
      - headers per context;
      - a catch-all virtual host refusing unknown names;
      - a WebSocket across a graceful restart;
      - the admin listener removed;
      - LSCache in front of a backend that sends no cache headers, and its purge;
      - the image's tags, digest, architectures and licence.
    - ADR 0031 records the third proxy.
  - Verify: `pnpm lint`
  - Effort: lead

## Phase 3: Wave 2 (parallel)

- [x] T2710 [US1] [US5] What the app needs, the interview and design for a hosting account
  - Owns: `packages/detect/src/php-needs*.ts` (and its export in `packages/detect/src/index.ts`), `packages/agents/src/interview/**`, `packages/agents/src/design/**`, `packages/agents/src/hosting/{facts,fit,record,panels}*.ts`
  - Reads: plan 1, 5, 10; spec US1 (scenarios 1–3), US5 (scenario 2), edge cases; research R10, R11; `agents/src/interview/{serverless,own-server}.ts`, `agents/src/design/{serverless,own,own-servers}.ts`, `detect/src/{runtime-versions,frameworks,services}.ts`
  - Depends: T2702, T2703, T2707, T2708
  - Accept:
    - **detect** gives the PHP constraint and the `ext-*` requirements of `composer.json` and of every package in `composer.lock`, deduplicated; the extensions every PHP 8 build has (`json`, `ctype`, `filter`, `hash`, `pcre`, `spl`, `standard`, …) count as present.
    - **`panels.ts`:**
      - builds the panel's connector from `OPSCREW_HOSTING_URL`, `OPSCREW_HOSTING_USER` and `OPSCREW_HOSTING_TOKEN`;
      - finds the panel kind from the answer on 2083, 8443 or 2222 (injected `fetch`);
      - gives the account's `HostingFiles`: the panel itself when `writeFile` is in its `operations`, otherwise the SFTP connector when `OPSCREW_SFTP_*` are set (it is T2714's; until it merges, the file steps are panel steps);
      - `record.ts` reads and writes `.opscrew/hosting.json` (address, user, panel, every object made with its key), which T2711 extends.
    - **The interview:**
      - offers "a hosting account" when the hosting variables are set, or `OPSCREW_SFTP_HOST`, `OPSCREW_SFTP_USER` and `OPSCREW_SFTP_KEY` (a key file's path);
      - asks for the hostname among the names `inspect()` allows (a subdomain of one of the account's domains, or an addon domain), written as `dns.domain`;
      - for SFTP, reads the host key with `ssh-keyscan`, has it confirmed, and asks for the folder and the path PHP sees for it.
    - **Design** fills the target (plan 1):
      - `app`, `webRoot`, `site`, `database` when the app uses MySQL or MariaDB, `cron` from the app's scheduled commands, `runtime`;
      - `docroot` from `inspect()`'s `documentRoots` (`anywhere` → `direct`, otherwise `link`).
    - **Design refuses**, each time with the reason and a server target named:
      - workers, queues and Redis;
      - WebSockets from PHP;
      - services that only run in containers;
      - PostgreSQL where the account has none;
      - a Node.js or Python app where the account has no selector or no app slot left;
      - an app larger than the quota left.
    - **Design's text** shows:
      - the account's facts and the web server from the main domain's `Server` header;
      - "No price: you already pay for this account.";
      - that the PHP version and extensions are checked when OpsCrew sets the account up.
    - **Tests** with each connector's fakes: each refusal, each panel's detection, and the SFTP interview.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/detect && pnpm lint`
  - Effort: xhigh

- [x] T2712 [P] [US8] OpenLiteSpeed's configuration and checks
  - Owns: `packages/iac-templates/src/edge/**`, `packages/iac-templates/src/pins.ts`, `EdgeSchema` in `packages/plan-schema/src/plan.ts` and the generated schemas, and the `openlitespeed` entry (a plain "not yet" refusal) of each exhaustive `Record<EdgeProxy, …>`: `iac-templates/src/workflow/switch.ts`, `agents/src/retarget/server-ops.ts`, `cli/test/live/tls-support.ts`
  - Reads: plan 11; research R9, R12; ADR 0017, ADR 0031; `iac-templates/src/edge/{nginx,nginx-validate}*.ts`
  - Depends: T2702, T2709
  - Accept:
    - `openlitespeed` joins `EdgeSchema` and `EDGE_PROXIES`, from `litespeedtech/openlitespeed` pinned by digest (R12), with `init: true` and OpsCrew's loop as its command (ADR 0031 D1).
    - **Its configuration** (R12, ADR 0031 D4–D7): a vhost per app with its `extprocessor`, `/` context and `websocket` entry; a listener map; the headers Caddy and nginx send, `showVersionNumber 2`, set error pages, `X-Forwarded-For` reset; TLS 1.2 and 1.3 with the ciphers in every `vhssl`; a catch-all vhost answering 403 behind a placeholder certificate; `disableWebAdmin 1`; the cache off, each app's `storagePath` its own; `connTimeout 300`; the error log in a file.
    - **Commands:** the check (ADR 0031 D2: `/tmp/lshttpd` made, every named certificate and key checked by OpsCrew, `openlitespeed -t` refusing exit 2), the graceful restart, and the cache purge (the app's cache files removed); `edgeMemoryMb` and `vercel-routing.ts` gain it.
    - **Tests:**
      - snapshots;
      - a Docker test (`OPSCREW_DOCKER_TESTS=1`) as `nginx-validate.test.ts` does: unknown names refused, the HTTPS redirect, HSTS, TLS 1.2/1.3 only, a WebSocket;
      - Caddy's and nginx's output unchanged.
  - Verify: `pnpm check`
  - Effort: xhigh

## Phase 4: Wave 3

- [x] T2711 [US1] [US4] The hosting plans, requests and provision
  - Owns: `packages/agents/src/hosting/{plan,apply,provision,php,requests,dns}*.ts`, `packages/agents/src/hosting/record*.ts` (extending T2710's), the hosting branch in `packages/agents/src/provision/run.ts` and in `packages/iac-templates/src/workflow/index.ts`, `hosting.json` in `packages/agents/src/secrets/files.ts`'s state files, the hosting mode of the `cloudflare-dns` module and its renderer in `packages/iac-templates`
  - Reads: plan 2–6; ADR 0011, ADR 0030; research R10, R11; `agents/src/serverless/pages/{plan,provision,step}.ts`, `connectors/ssh-host/src/{plan,apply,hash}.ts`, `agents/src/provision/{run,secrets}.ts`, the `cloudflare-dns` module's GitHub Pages mode
  - Depends: T2702–T2706, T2710
  - Accept:
    - **Plans A and B** (plan 2):
      - zod schemas of fixed step kinds, hashed as SHA-256 of canonical JSON, saved under `.opscrew/plans/hosting-<env>-{agent,app}.json`;
      - approved with `hosting-apply`; each apply recomputes the hash and refuses a mismatch with `PLAN_HASH_MISMATCH`.
    - **Plan A:**
      - the app's folder with `AGENT_SH`, `settings.sh`, `keys/release.pub` and `keys/known_hosts`, then the agent's cron line;
      - waits up to 3 minutes for `state/report`; a misfit stops with the reason and what to do, the agent recorded.
      - The signing key pair (ECDSA P-256) is generated at that apply (injected randomness). The private half goes only to the GitHub environment secret in plan B's apply and is never written locally; a lost key means a new pair through provision.
    - **Plan B:** every step plan 2 lists, built from the facts and the report, with the PHP choice in plan 5's order (Plesk's and DirectAdmin's version as a panel step) and the stop text of its step 4. The app's cron lines are rendered as plan 5 says, with a test.
    - **The document root** per plan 5: `direct`, or `link` made before the hostname inside `public_html` (restricted cPanel), or replacing the panel's own empty root after `addHostname` answers it (DirectAdmin; refused when that folder holds anything but the panel's default page).
    - **Files** through the account's `HostingFiles` (T2710's `panels.ts`), never the panel directly.
    - **Values:** the environment file is listed by its keys and a digest of the user's values; the database password is generated at apply and written only into `shared/.env` (or the values file) and `shared/mysql.cnf`, 0600.
    - **Requests** (`requests.ts`, used by T2713, T2717 and T2718):
      - written as key=value under a temporary name, renamed to `requests/<sha256>.req`, with the approved hash and `expires` in UTC epoch seconds;
      - then waited for in `state/<sha256>.result`, up to 3 minutes; a timeout says the agent's cron line may be missing.
      - A provision run again whose only change is the values writes `shared/.env.next` and an `env` request.
    - **The record** in `.opscrew/hosting.json` lists every object made, with the panel's key for it; it joins the recovery copy. A provision run again changes only what differs, and never anything not recorded.
    - **A hostname that exists** stops plan B before any step. **Panel steps** stop provision after listing them; a run after the user did them continues.
    - **The DNS record** when the domain is on Cloudflare: an A record to the account's address, DNS only, through the `cloudflare-dns` module and the IaC approval.
    - **GitHub:** the deploy key (`github-settings`), the signing key (`github-secrets`), and `renderHostingWorkflow` in the provision pull request for a panel target.
    - **Tests:**
      - a whole provision with the cPanel fakes, and a second run;
      - a hash mismatch;
      - a report misfit;
      - each of the three PHP choices and the stop;
      - an existing hostname;
      - the `public_html` document root;
      - a values-only change;
      - the same provision with the Plesk and DirectAdmin fakes, including the pause for panel steps (SC-2705);
      - the token absent from every output, plan file and audit entry.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

## Phase 5: Wave 4 (parallel)

- [x] T2713 [US2] [US6] Rollback, destroy, status and logs on a hosting account
  - Owns: `packages/agents/src/hosting/{rollback,destroy,status,logs}*.ts`, the hosting dispatch in `packages/agents/src/{rollback,destroy,status}/run.ts` and `packages/agents/src/logs/{read,targets}.ts`
  - Reads: plan 6; ADR 0023, ADR 0028, ADR 0030; `agents/src/rollback/{run,database,versions}.ts`, `agents/src/destroy/{common,own,serverless}.ts`
  - Depends: T2711
  - Accept:
    - **Rollback** per plan 6:
      - the default target from `state/status` (ADR 0023 D4);
      - the database choice: restore the dump filed under the target (ADR 0028 D7), or keep the database;
      - a `promote` approval bound to the plan's hash, both release ids and the choice (`allowDestroy` and the typed hostname for a restore);
      - the request, then the deploy pause set.
    - **Destroy** per plan 6, in its order, with `allowDestroy` and the typed hostname; only recorded objects are removed. The final dump is an offer.
    - **Status:** the running release, the last attempt and its reason, the certificate, the quota left, and the Apache note.
    - **Logs:** the last 200 lines of `state/agent.log`, redacted.
    - **Tests** with the cPanel fakes for each flow and refusal, and rollback and destroy with the Plesk and DirectAdmin fakes (SC-2705).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2715 [P] [US1] [US9] CLI and MCP for hosting accounts
  - Owns: `packages/cli/src/**`, `packages/mcp-server/src/**`
  - Reads: plan 12; `cli/src/approval.ts`; the commands' hints research R8 lists
  - Depends: T2711
  - Accept:
    - `hosting-apply` joins `APPROVE_BY_HASH_KINDS` and takes `--approve <hash>`, never `--yes`; provision's two approvals are named in its output.
    - The commands that need a server say plainly that they don't apply to a hosting account, and what to use instead: container logs, monitoring, previews, runners, add-ons, the VPN, and retarget to or from one.
    - `opscrew init` checks the hosting and SFTP variables and the `sftp` and `ssh-keyscan` binaries.
    - The MCP tools describe and accept the hosting target.
    - Tests for each refusal and the approvals.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: high

- [x] T2716 [P] [US8] OpenLiteSpeed's reach
  - Owns: the files research R9 lists for the proxy choice outside `packages/iac-templates/src/edge/**`:
    - the deploy's switch (`iac-templates/src/workflow/switch.ts`) and the CI check (`edge-check.ts`);
    - the additions check (`agents/src/provision/additions.ts`) and the additions rules (`packages/secops/src/proxy-rules/**`);
    - retarget's server operations and localhost's destroy;
    - certificates and their renewal loop, CAA issuers;
    - status's and secure's certificate checks (`agents/src/status/certificates.ts`, `agents/src/secure/settings.ts`, `secops/src/hardening/tls.ts`);
    - own-server inspection and teardown (`packages/connectors/ssh-host/src/{inspect,steps}.ts`);
    - previews' and Portainer's refusals.
  - Reads: plan 11; research R9, R12; ADR 0017, ADR 0031; 014's nginx tasks as the model
  - Depends: T2712
  - Accept:
    - Every place nginx reaches, OpenLiteSpeed reaches too:
      - the check before every change and the graceful restart, also after every switch that moves a backend (ADR 0031 D3);
      - certificates: origin certificates, and its own renewals through certbot's webroot;
      - the cache purge on every deploy and rollback;
      - the additions file checked by OpsCrew's rules and by `openlitespeed -t`;
      - the switch between proxies, localhost, retarget, status, secure, own-server inspection and teardown.
    - Previews and Portainer refuse it plainly.
    - From T2712's Docker test: the pull certificate OpsCrew makes for Cloudflare's authenticated origin pulls (`selfSignedClientCertificate` in `packages/core`, joining your Owns for this) carries `keyCertSign`, which OpenLiteSpeed's TLS library needs (Caddy and nginx accept it either way); the visitor's address behind Cloudflare's proxy through `useIpInProxyHeader` trusting only Cloudflare's ranges, proved in the Docker test; `renderEdgeSite` and `otherProxy` handle OpenLiteSpeed; the CI check starts kamal-proxy, since `openlitespeed -t` needs it to resolve.
    - Caddy's and nginx's output and tests unchanged; tests mirroring nginx's for each place.
  - Verify: lint, typecheck, and the test files the change touches (the lead runs the full gate at merge)
  - Effort: xhigh

## Phase 6: Wave 5 (parallel)

- [x] T2714 [US3] SFTP-only hosts
  - Owns: `packages/connectors/sftp/src/**`, `packages/agents/src/hosting/sftp*.ts`, `packages/iac-templates/src/hosting/sftp*.ts`, `packages/iac-templates/src/hosting/__snapshots__/sftp*`, and the SFTP branch in `packages/agents/src/hosting/{provision,rollback,destroy,status}.ts` and `packages/iac-templates/src/workflow/index.ts`
  - Reads: plan 10; ADR 0011, ADR 0030 (D6); `agents/src/addons/status.ts` (running `ssh` through the runner), `connectors/ssh-host/src/shell.ts`
  - Depends: T2711, T2713
  - Accept:
    - **The connector** implements `HostingFiles` (for SFTP-only hosts, and for Plesk when the user gives SFTP access):
      - runs `sftp -b <batch file>` through the injected runner, with `-o BatchMode=yes` and the record's known-hosts file;
      - every path in a batch file is quoted, and one with a newline is refused;
      - operations: `mkdir` (each level), `put`, `ln -s`, `rename`, `rm`, `ls`, `get` (a small file).
    - **Provision**, rollback, status and destroy per plan 10, as hosting plans and `promote` approvals:
      - the CI key gets the `restrict` option where the host keeps `authorized_keys`, otherwise it is a panel step;
      - the plan says what the key can reach, and names the hostname, its document root, the database and the certificate as the user's.
    - **`renderSftpWorkflow`** per plan 10, writing `state/status` over SFTP.
    - **Tests:**
      - batch rendering and quoting;
      - each flow with a fake runner;
      - a Docker test (`OPSCREW_DOCKER_TESTS=1`) against an OpenSSH SFTP-only container: an upload and an atomic switch, where a reader never sees `current` missing.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-sftp --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

- [x] T2718 [P] [US6] Verify, secure, drift and snapshots on a hosting account
  - Owns: `packages/agents/src/hosting/{verify,secure,drift,snapshot}*.ts`, the hosting dispatch in `packages/agents/src/{verify,secure,drift,snapshot}/run.ts`, `packages/secops/src/hardening/php*.ts`
  - Reads: plan 9; spec US1 (scenario 6), US6; ADR 0030
  - Depends: T2713
  - Accept:
    - Verify, secure and drift per plan 9, for panel and SFTP targets. Drift uses the record, the committed `agent.sh` and `<env>.sh`, and the reappearing-database check.
    - PHP's supported versions are a dated table in secops.
    - `snapshot` and `restore` go through requests (T2711's `requests.ts`); the guide's text says to download from the panel; a restore is approved like a destroy.
    - Tests with the cPanel fakes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/secops && pnpm lint`
  - Effort: xhigh

- [x] T2720 [P] [US9] The plugin's skills and the MCP tools' text
  - Owns: `plugin/**`, the hosting and OpenLiteSpeed text in `packages/mcp-server/src/**`
  - Depends: T2715, T2716
  - Accept: the skills offer hosting accounts and OpenLiteSpeed where they offer targets and proxies; the plugin validates.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: medium

## Phase 7: Wave 6 (parallel)

- [x] T2717 [US5] Node.js and Python apps through CloudLinux's selector
  - Owns: `packages/agents/src/hosting/apps*.ts`, the `app` request and the selector's part of the agent (`packages/iac-templates/src/hosting/agent*`, `packages/iac-templates/src/hosting/agent/**`), the app steps in `packages/agents/src/hosting/{provision,destroy}.ts`
  - Reads: plan 8; research R4, R10; T2704's agent
  - Depends: T2711, T2713, T2714
  - Accept:
    - **At provision**, an `app` request makes the agent run `/usr/sbin/cloudlinux-selector create --json --interpreter nodejs|python --version … --app-root ~/opscrew/<app>-<env>/current --app-uri / --app-mode production --domain <hostname> --startup-file …`.
    - **On each release:** the `node_modules` link and the Passenger block are carried; `install-modules` runs before the switch when the lockfile changed; then `tmp/restart.txt`.
    - **At destroy:** the selector's `destroy`, its empty `~/nodevenv/<app root>`, and its section in `~/.cl.selector/htaccess_cache` (the file's other sections untouched).
    - **Tests:** the agent's runs with a stubbed `cloudlinux-selector`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: high

- [x] T2719 [P] [US9] The guide
  - Owns: `docs/guide/{hosting-accounts,cpanel,plesk,directadmin,sftp}.md`, the hosting and OpenLiteSpeed parts of `docs/guide/{index,reverse-proxy,retarget,logs-and-status,snapshots}.md`, `README.md`'s target list
  - Reads: plan; spec; ADR 0030, ADR 0031; research R10, R11
  - Depends: T2713, T2714, T2716, T2718
  - Accept:
    - `hosting-accounts.md`:
      - what fits;
      - how a deploy works (the agent, its cron line, the release branch, about a minute);
      - what a cPanel token reaches;
      - the PHP version, and why OpsCrew never changes the account's;
      - LiteSpeed's PHP restart reaching the account's other sites, and Apache's 120 s;
      - snapshots kept on the account;
      - what deleting OpsCrew leaves.
    - A page per panel and for SFTP, each with the variables to set; OpenLiteSpeed's section on `reverse-proxy.md`.
    - True facts only, written for users.
  - Verify: `pnpm lint`
  - Effort: medium

## Phase 8: Wave 7

- [x] T2721 The live test files and `docs/e2e.md`
  - Owns: `packages/cli/test/live/{cpanel,cpanel-support,sftp-host,own-openlitespeed}*.ts`, `docs/e2e.md`
  - Reads: plan 13; `packages/cli/test/live/{harness,contabo,contabo-support,own-nginx}.ts`; ADR 0030
  - Depends: T2713, T2714, T2716, T2717, T2718
  - Accept:
    - **The cPanel pass** (`OPSCREW_E2E_CPANEL=1` and `OPSCREW_E2E_CPANEL_{URL,USER,TOKEN,DOMAIN}`, mapped to `OPSCREW_HOSTING_*`):
      - SC-2701 for `examples/php-plain-mysql`, `examples/static-vite` and `examples/hono-api` on `e2e-…` subdomains of the test domain;
      - the first request after each switch and rollback checked (SC-2703);
      - an inventory before and after, compared field by field (SC-2702): domains, databases, users, cron, keys, tokens, the home folder's top level, `~/.cl.selector`, certificates and keys;
      - a scan of every output for the token (SC-2704).
      - `examples/laravel-app` runs only with `OPSCREW_E2E_CPANEL_LARAVEL=1`; otherwise its refusal message is checked.
      - The cleanup removes only `e2e-…` objects and the certificates AutoSSL issued for them.
    - **The SFTP pass** (`OPSCREW_E2E_SFTP=1`) sets up a Hetzner server as an SFTP-only host (a chrooted account, Apache with PHP-FPM serving its folder), then deploys, switches, rolls back and destroys.
    - **The OpenLiteSpeed pass** (`OPSCREW_E2E_OPENLITESPEED=1`) repeats `own-nginx.test.ts` with the third proxy.
    - `docs/e2e.md` says how to run each.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 8b: The snapshot default (founder, 2026-11-12)

- [x] T2728 The snapshot before each release: on in every environment but previews
  - Owns: `snapshotsOn` and its tests in `packages/plan-schema/src/**`; the snapshot expectations and snapshots of `packages/iac-templates/src/{workflow,portainer-target}/**` that change with it; `packages/agents/src/rollback/**` comments and tests naming the default; `packages/cli/src/commands/rollback.ts`'s help text; `packages/cli/test/live/{rollback,snapshots}.test.ts`; `docs/guide/{databases,environments,rollback,snapshots,when-a-deploy-fails}.md`
  - Reads: ADR 0028 (D7 and its 2026-11-12 amendment); `plan-schema/src/plan.ts` (`snapshotsOn`, `deploy.snapshots`, `CloudTargetSchema.backups`)
  - Depends: T2702
  - Accept:
    - `snapshotsOn(plan)`, when `deploy.snapshots` is absent: true in every environment, prod included whatever the provider's backups; previews always false; `deploy.snapshots` true or false still decides when set. Everything else in `snapshotsOn` (what gets copied, the targets it applies to) stays.
    - A shared helper gives the same default to hosting targets (T2711's agent settings use it).
    - Rollback's default database choice is unchanged (prod keeps its database; elsewhere the snapshot when there is one); its comments and the CLI's help say "when the environment takes snapshots".
    - Every snapshot and expectation that changes shows only the release snapshot step appearing for prod plans; nothing else in any generated file moves.
    - The guide's pages say the new default.
  - Verify: `pnpm check` (the gate's order: lint, typecheck, ssh-host alone, the rest, iac-engine last)
  - Effort: high

- [x] T2729 ClickHouse and Neo4j in the snapshot before each release by default
  - Owns: `deploy.snapshotStop`'s default and its tests in `packages/plan-schema/src/**`; `packages/agents/src/{rollback,design}/**` texts naming what a release snapshot copies; `packages/iac-templates/src/{workflow,portainer-target}/**` snapshot scripts and the expectations that change; `docs/guide/{databases,snapshots,rollback}.md`
  - Reads: ADR 0028 and its 2026-11-12 amendments; `plan-schema/src/plan.ts` (`ONLINE_SNAPSHOT_KINDS`, `deploy.snapshotStop`, `snapshotsOn`), `iac-templates/src/workflow/snapshot-script.ts`
  - Depends: T2728
  - Accept:
    - When `deploy.snapshotStop` is absent, the snapshot before each release copies the plan's enabled ClickHouse and Neo4j services, each stopped while copied, as a named stop-only service is today; `deploy.snapshotStop` set (also `[]`) decides.
    - Design's text says such a service stops for a moment on each deploy while it is copied, and how to turn that off.
    - A rollback that restores the snapshot restores them with the rest.
    - Expectations and snapshots change only by those services appearing in the release snapshot; nothing else moves.
    - The guide's pages say so.
  - Verify: the full gate (lint, typecheck, ssh-host alone, the rest, iac-engine last)
  - Effort: high

- [x] T2730 A rollback that names the app's queues
  - Owns: `packages/agents/src/rollback/**`, `packages/cli/src/commands/rollback.ts`, `packages/mcp-server/src/**` (the rollback tool's input), `docs/guide/rollback.md`
  - Reads: ADR 0023, ADR 0028 and its 2026-11-12 amendments; `agents/src/rollback/{run,database}.ts`, `agents/src/design/background-jobs.ts`
  - Depends: T2728, T2729
  - Accept:
    - The app's queues are its enabled RabbitMQ, NATS, Kafka and Redpanda services, and a Valkey, Redis or Dragonfly service the app uses for background jobs (design's background-jobs reading).
    - When a rollback restores the snapshot and the snapshot holds a queue, the approval's text says that restoring it puts back the jobs as they were before the release (jobs queued since are lost, jobs run since can run again) and offers to keep it as it is; `--keep-queues` (and the MCP tool's input) keeps every queue without asking. A kept queue isn't restored.
    - For every queue not restored (kept, not in the snapshot, or the database kept), the text says jobs the newer version queued may fail on the older one, and retry or fail.
    - The rollback's hash binds the choice; a script without a TTY and without `--keep-queues` restores what the snapshot holds, as today, after the same text.
    - Tests for each case, with a fake runner.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: high

## Phase 8c: Fixes from the live passes (lead, 2026-11-13)

- [x] T2731 cPanel: the account's parked domains (research R13)
  - Owns: `packages/connectors/cpanel/src/**`, `packages/cli/test/live/cpanel-support.ts`, `packages/cli/test/live/cpanel-support.test.ts`
  - Reads: research R1, R10, R13; `connectors/cpanel/src/{panel,fake}.ts`
  - Accept:
    - The connector reads the account's domains with one `DomainInfo::domains_data` call without `format`: the main domain, addon domains and subdomains with their document roots, and each parked domain by name with the main domain's document root. A hostname under a parked domain is added as a subdomain of it; a parked domain is never removed, as today.
    - `fakeCpanel` answers `domains_data` as cPanel does: with `format=list`, without parked domains; without `format`, `main_domain` as an object, `addon_domains` and `sub_domains` as arrays of objects, `parked_domains` as names.
    - The cPanel pass's inventory and cleanup list parked domains too, so step 0 accepts a parked `OPSCREW_E2E_CPANEL_DOMAIN` and the inventory after compares them.
    - Tests for each, with the fake.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cpanel && pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/cpanel-support.test.ts && pnpm lint`
  - Effort: medium

- [x] T2732 The account's web server from the first of its domains that answers (research R13)
  - Owns: `packages/agents/src/hosting/facts.ts`, `packages/agents/src/hosting/facts.test.ts`, `packages/agents/src/hosting/__fixtures__/**`
  - Reads: research R10, R11, R13; `agents/src/hosting/{facts,php,provision,status}.ts`
  - Accept:
    - `readHostingAccount` reads the `Server` header of the main domain first, then of the account's addon, parked and subdomains in that order, at most 5 domains in all, and keeps the first that names a web server, with the domain it came from.
    - Design's line names that domain (`LiteSpeed, from <domain>'s Server header`); when none answers, it says the account's domains don't name it.
    - Tests: a main domain that doesn't resolve and a parked domain that answers `LiteSpeed`; none answering; the 5-domain limit.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/hosting && pnpm lint`
  - Effort: medium

- [x] T2733 The deploy workflow's wait for the release, whatever headers follow (research R13)
  - Owns: `packages/iac-templates/src/hosting/workflow.ts`, `packages/iac-templates/src/hosting/workflow.test.ts`, `packages/iac-templates/src/hosting/__snapshots__/workflow.test.ts.snap`
  - Reads: research R13; `iac-templates/src/hosting/workflow.ts` (the step "Wait for the account to switch to the release")
  - Accept:
    - The step reads the `X-OpsCrew-Release` header without a pipeline that can fail when a reader stops early: under `bash -e` with `set -uo pipefail` it keeps asking until the release is served or its attempts run out, however many header lines follow the release's.
    - A test runs the step's script with bash, `-e` and `pipefail` against answers where the header comes first among many headers, last, and missing (a fake `curl` on `PATH` is enough), on Linux (the Hosting agent workflow runs `src/hosting`).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting/workflow && pnpm lint`
  - Effort: medium

- [x] T2734 The agent leaves no read-only file, so destroy can remove its folder (research R13)
  - Owns: `packages/iac-templates/src/hosting/agent/**`
  - Reads: research R10, R13; `iac-templates/src/hosting/agent/script.ts`; `agents/src/hosting/destroy.ts` (the folder step)
  - Accept:
    - After each fetch (and anything else the agent runs that writes read-only files: git's objects and packs, a key it makes), the agent makes them writable by the account's user (`chmod -R u+w` of what it wrote, never wider), so a panel's file removal, which skips read-only files, removes its folder.
    - A Linux test: after the agent's first deploy and a second release, no file under the app's folder lacks the owner's write bit (`find ! -perm -u+w` finds nothing).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting/agent && pnpm lint`
  - Effort: medium

- [x] T2735 The deploy job passes only when the agent's health check would (research R13)
  - Owns: `packages/iac-templates/src/hosting/workflow.ts`, `packages/iac-templates/src/hosting/workflow.test.ts`, `packages/iac-templates/src/hosting/__snapshots__/workflow.test.ts.snap`, `packages/cli/test/live/cpanel.test.ts`, `packages/cli/test/live/cpanel-support.ts`, `packages/cli/test/live/cpanel-support.test.ts`
  - Reads: research R13; `iac-templates/src/hosting/workflow.ts` (the wait step), `iac-templates/src/hosting/agent/script.ts` (the health check)
  - Accept:
    - The wait step counts the release as served only when the answer is 2xx or 3xx and carries its `X-OpsCrew-Release`, as the agent's health check does; a 5xx with the header is another try. Tests with a fake `curl`, under `bash -e` and `pipefail`.
    - The cPanel pass waits (up to 3 minutes) for `opscrew status` to name the first deploy's release and logs how long it took; its cleanup also removes a certificate new since the run started, installed nowhere, whose every name is one of the run's hostnames (or `www.` of one) or the wildcard of the account's domain, with its key when no other certificate uses it. A unit test for the certificate rule.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=opscrew && npx vitest run --root packages/iac-templates src/hosting/workflow && npx vitest run --root packages/cli test/live/cpanel-support.test.ts && pnpm lint`
  - Effort: medium

- [x] T2736 A PHP app's paths reach its index.php, as on a server (research R13)
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/sftp-workflow.ts`, `packages/iac-templates/src/hosting/sftp-workflow.test.ts`, `packages/iac-templates/src/hosting/__snapshots__/sftp-workflow.test.ts.snap`, `docs/guide/hosting-accounts.md`, `docs/guide/sftp.md`
  - Reads: research R4, R13; `iac-templates/src/hosting/agent/script.ts` (`htaccess_block`, `compose`), `iac-templates/src/hosting/sftp-workflow.ts` (its `.htaccess` block)
  - Accept:
    - When the release's served folder has `index.php` and the app's own `.htaccess` there has no `RewriteRule`, OpsCrew's `.htaccess` block (the agent's and the SFTP workflow's) ends with `RewriteCond %{REQUEST_FILENAME} !-f`, `RewriteCond %{REQUEST_FILENAME} !-d`, `RewriteRule ^ index.php [L]`, after its own rules. An app whose `.htaccess` rewrites (Laravel, WordPress) keeps its own routing; a static site gets none. The block rewritten in place when HTTPS is forced keeps the same choice.
    - Tests: a plain PHP release gets the fallback; one with its own rewriting `.htaccess` and a static site don't (agent on Linux, SFTP workflow's rendering).
    - The guide's hosting and SFTP pages say it in one sentence each.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting && pnpm lint`
  - Effort: medium

- [x] T2737 The app's kept folders outlive each release on a hosting account (research R13)
  - Owns: `packages/agents/src/hosting/**`, `packages/iac-templates/src/hosting/sftp-workflow.ts`, `packages/iac-templates/src/hosting/sftp-workflow.test.ts`, `packages/iac-templates/src/hosting/__snapshots__/sftp-workflow.test.ts.snap`, `docs/guide/hosting-accounts.md`, `docs/guide/sftp.md`
  - Reads: research R13; plan 5 (the release's shared paths); `agents/src/hosting/provision-plans.ts` (`sharedPaths`), `iac-templates/src/hosting/agent/script.ts` (`link_shared`), `iac-templates/src/hosting/sftp-workflow.ts`, `plan-schema` (`storage.files`, `storage.sqlite`)
  - Accept:
    - On a panel account the agent's shared paths are `.env` (Laravel, Node.js and Python apps, as now), Laravel's `storage`, and the plan's kept folders (`storage.files.dir`, `storage.sqlite.dir`), each once; `link_shared` already moves a folder into `shared/` on the first release and links it in each later one.
    - On an SFTP host the deploy workflow does the same for those kept folders before the switch: on the first deploy the release's folder (or an empty one) becomes `shared/<dir>` (sftp `rename`), and each release gets `<dir>` as a symbolic link to `shared/<dir>` (sftp `symlink`, relative like the agent's). A rollback's release keeps its link.
    - Tests for both (a second release sees what the first wrote in the kept folder), and the guide's two pages name the kept folders among what `shared/` holds.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=@opscrew/iac-templates && npx vitest run --root packages/agents src/hosting && npx vitest run --root packages/iac-templates src/hosting && pnpm lint`
  - Effort: high

- [x] T2738 The cPanel pass names AutoSSL's challenge records of its hostnames, and leaves them (research R13)
  - Owns: `packages/cli/test/live/cpanel-support.ts`, `packages/cli/test/live/cpanel-support.test.ts`, `docs/e2e.md`
  - Reads: research R10, R11, R13; `cli/test/live/cpanel-support.ts` (the inventory's `zone`, `inventoryProblems`)
  - Accept:
    - A TXT record new since the inventory before, named `_acme-challenge.<run hostname>` or `_acme-challenge.www.<run hostname>`, is an observation, not a problem: the pass never edits the founder's zone. The run's end lists such records for removal by hand (cPanel's Zone Editor). A unit test.
    - docs/e2e.md's cleanup, interrupted-run and "what it leaves" text name them.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/cpanel-support.test.ts && pnpm lint`
  - Effort: medium

- [x] T2739 A kept folder the release doesn't ship starts empty in shared/ (from T2737)
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/agent.ts`
  - Reads: T2737; `iac-templates/src/hosting/agent/script.ts` (`link_shared`), `iac-templates/src/hosting/sftp-workflow.ts` (its kept folders)
  - Accept:
    - When neither `shared/<path>` nor the release's `<path>` exists, `link_shared` makes `shared/<path>` an empty folder (0755, as the SFTP workflow does) before linking, so the link never points nowhere; `.env` is always in `shared/` already. A Linux test with a kept folder the release lacks: the app can write through the link, and a second release sees it.
    - `sharedPaths`' TSDoc names the plan's kept folders.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting/agent && pnpm lint`
  - Effort: medium

- [x] T2740 cPanel: an empty file reads as empty (research R13)
  - Owns: `packages/connectors/cpanel/src/**`
  - Reads: research R13; `connectors/cpanel/src/{panel,fake}.ts` (`readFile`, `get_file_content`)
  - Accept:
    - `readFile` answers `""` for a file cPanel gives `content: null` (an empty file); a missing file still answers `undefined`.
    - `fakeCpanel` answers `content: null` for an empty file, as cPanel does. Tests for both.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cpanel && pnpm lint`
  - Effort: medium

- [x] T2741 The selector's "operation was performed" counts as installed; the agent's health check decides (research R13)
  - Owns: `packages/iac-templates/src/hosting/agent/**`
  - Reads: research R13; `iac-templates/src/hosting/agent/script.ts` (the selector's install before the switch, the switch back and reinstall)
  - Accept:
    - When `cloudlinux-selector install-modules` answers an error whose text says "The operation was performed" (its own availability check failed), the agent logs that answer as a note and goes on to switch and run its health check, which keeps the release or switches back and reinstalls the running release's packages, as for any failed release. Any other error still fails the release before the switch.
    - Linux tests with the fake selector: that answer on a first release deploys it; on a later release whose health check fails, the switch back reinstalls the running release's packages; another error still fails before the switch.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting/agent && pnpm lint`
  - Effort: medium

- [x] T2742 The deploy job asks the app's health path, as the agent's health check does (research R13; lead)
  - Owns: `packages/iac-templates/src/hosting/workflow.ts`, its test and snapshot
  - Accept: the wait step's URL is `https://<hostname><plan.app.healthPath>`.

- [x] T2743 A certificate counts as OpsCrew's only when it names nothing but the hostname (research R13)
  - Owns: `packages/connectors/cpanel/src/**`, `packages/connectors/directadmin/src/**`, `packages/agents/src/hosting/**`
  - Reads: research R13; `contracts/src/hosting.ts` (`HostingCertificate.names`, added by the lead), `agents/src/hosting/{provision,destroy}.ts`, the connectors' `certificate()`
  - Accept:
    - cPanel's and DirectAdmin's `certificate()` give `names`, the installed certificate's names as the panel lists them.
    - Provision records the certificate only when `names` is given and every name is the hostname or `www.` of it (case-insensitive); a wildcard, a certificate naming other hosts, or one without `names` is never recorded, so destroy never removes it. Destroy's plan text stays as it is for a recorded one.
    - Tests: the hostname's own certificate is recorded; the domain's wildcard and a shared certificate aren't (fakes); the connectors give `names`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/connector-cpanel --filter=@opscrew/connector-directadmin --filter=@opscrew/contracts && npx vitest run --root packages/agents src/hosting && pnpm lint`
  - Effort: medium

- [x] T2744 Node.js and Python apps: the selector keeps one fixed folder, Passenger follows the release (research R14)
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/agent.ts`, `packages/agents/src/hosting/**`, `docs/guide/hosting-accounts.md`
  - Reads: research R10, R11, R14; T2717 and T2741 (the selector's install, the switch back and reinstall); `iac-templates/src/hosting/agent/script.ts` (`app_root`, `selector_*`, `compose`, `link_shared`, the selector's create/set/destroy); `agents/src/hosting/{destroy,provision-plans,apply}.ts` (their text about the selector and `~/nodevenv`)
  - Accept:
    - The selector's app is registered at a real folder `opscrew/<app>-<env>/app/` the agent makes (never a link, never under `releases/`, never pruned), and every selector command (`create`, `install-modules`, `set`, `destroy`) is given that folder.
    - Each release's `.htaccess` carries the selector's Passenger block with `PassengerAppRoot` set to that release's own absolute folder (every other line byte for byte), so the switch of `current`, a rollback and a switch back run that release's code.
    - Before `install-modules` the release's package files (`package.json` and `package-lock.json`, or the requirements file) are put into `app/`; each release gets `node_modules` (Node.js) linked to the same environment the selector made for `app/`; a failed release's switch back reinstalls the running release's packages from its own files, as now; T2741's note stays.
    - Destroy runs the selector's `destroy` on `app/`, then removes the folder; its plan text names `app/`.
    - Linux tests with the fake selector (it resolves `--app-root` like the real one, R14): a first and a second release each run their own code (each `.htaccess` names its own root), a rollback runs the first again, destroy finds the app; the fake's registry keys by the resolved folder.
    - The guide's hosting page says in one sentence where the selector's app lives.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/iac-templates src/hosting/agent && npx vitest run --root packages/agents src/hosting && pnpm lint`
  - Effort: xhigh

- [x] T2745 Each Node.js release links node_modules to the selector's environment (research R14)
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/agent-apps.test.ts`, `packages/iac-templates/src/hosting/__fixtures__/shims/cloudlinux-selector.sh`
  - Reads: research R14 (its last paragraph); `iac-templates/src/hosting/agent/script.ts` (the node_modules link, the carried Passenger block)
  - Accept:
    - Each Node.js release that ships no `node_modules` gets `node_modules` linked, by its full path, to `<env>/lib/node_modules`, where `<env>` is the folder two levels above the `PassengerNodejs` binary the selector's block names (the running release's carried block); the old `app/node_modules` rule goes. A release whose block names no `PassengerNodejs` gets no link.
    - The fake selector makes no `node_modules` link in the app's root (as the real one, R14) and installs packages into `<env>/lib/node_modules`. A Linux test: an ES-module app imports a package installed through the selector, in a first and a second release.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/hosting/agent && pnpm lint`
  - Effort: medium

- [x] T2746 A Node.js or Python app runs the new release from the first answer after each switch (research R14)
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/agent.ts`, `packages/iac-templates/src/hosting/agent-apps.test.ts`, `packages/iac-templates/src/hosting/__fixtures__/shims/cloudlinux-selector.sh`, `packages/agents/src/hosting/**`, `docs/guide/hosting-accounts.md`
  - Reads: research R14 (its last paragraphs); `iac-templates/src/hosting/agent/script.ts` (`app_create`, `own_passenger`, `own_running`, `switch_to`, `end_processes`, `touch_restart`)
  - Accept:
    - The selector's block stays as the selector writes it: `PassengerAppRoot` is the registered `app/`; the agent no longer rewrites it (`own_passenger`/`own_running` go). The app is created with `--startup-file current/<startup>` and `app/current` is a link to `../current`, made before `create`, so Node runs the current release's startup file through the link.
    - Right after every switch of a Node.js or Python app (deploy, rollback, switch back) the agent touches `app/tmp/restart.txt` and ends the app's processes (the account user's processes whose command line or working folder names the app's folder, never the agent), before the health check; destroy ends them too, after the selector's destroy, so no process outlives the app (R14: 15 left `lsnode` processes filled the account's 100). PHP and static sites are unchanged.
    - The fake selector writes the startup file it is given into its block; Linux tests: the block names `app/` and `current/<startup>` through a deploy, a rollback and a switch back; `app/tmp/restart.txt` is newer than each switch; the stand-in process in the old release ends. Plan B's and destroy's text and the guide say how the app is started.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/iac-templates src/hosting/agent && npx vitest run --root packages/agents src/hosting && pnpm lint`
  - Effort: high

## Phase 9: Live passes and release (lead)

- [ ] T2722 The cPanel live pass (lead): `docs/e2e-coverage.md` row and results.
- [ ] T2723 The SFTP live pass (lead).
- [ ] T2724 The OpenLiteSpeed live pass (lead).
- [ ] T2725 Simplify across the feature's code (lead).
- [ ] T2726 `CLAUDE.md`'s package list, and the roadmap: 027 done (lead).
- [ ] T2727 The release, following `docs/releasing.md` (lead).
