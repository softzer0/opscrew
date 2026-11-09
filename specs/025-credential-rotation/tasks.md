---
description: "Tasks for 025-credential-rotation"
---

# Tasks: Credential rotation

**Input**: `specs/025-credential-rotation/` (spec.md, plan.md, research.md R1–R10) + features
000–024 and 013's US8.

**Numbering**: T2501–T2599.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration or the lockfile. No real
secret in any test: `fakeSecret(kind)` and `{{FAKE:<kind>}}` (`@opscrew/core/testing`).

## Phase 1: Contracts (lead)

- [x] T2501 The record and the plan's fields (lead)
  - Owns: `packages/plan-schema/src/**` (+ tests)
  - Accept:
    - `CredentialsRecordSchema` for `opscrew/credentials.yaml`: per environment, per credential name `{ rotatedAt?: IsoDateTime, madeAt?: IsoDateTime, generation: int ≥ 1 }`; never a value; read and written by `readArtifact`/`writeArtifact` like the others.
    - `credentials.maxAgeDays` (default 365, 30–3650) and `check.credentials` (default false) in the plan.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema && pnpm lint`
  - Effort: medium

- [x] T2502 The engine's `replace` (lead contract, then iac-engine)
  - Owns: `packages/contracts/src/iac.ts`, `packages/iac-engine/src/**` (+ tests)
  - Accept:
    - `IacEngine.plan` options gain `replace?: string[]`, passed as `-replace=<address>` to both engines; an address that is not in the configuration fails the plan with the engine's message.
    - `TF_ENCRYPTION` can carry a fallback: `tofuEncryptionEnv(passphrase, { previous })` gives a new key provider and method with the old as `fallback` (research R10), and nothing changes without `previous`.
    - Tests with both engines where installed (skipped with a clear message otherwise), and the `OPSCREW_IT=1` engine test for the fallback: after an apply, the new passphrase alone reads the state.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/contracts --filter=@opscrew/iac-engine && pnpm lint`
  - Effort: high

## Phase 2: Wave 1 (parallel)

- [x] T2503 [P] [US1] The catalog's rotation recipes
  - Owns: `packages/iac-templates/src/catalog/**` (+ tests), `packages/iac-templates/src/docker/rotation*.test.ts`
  - Reads: research R2–R5, R10; plan 2
  - Depends: T2501
  - Accept:
    - `ServiceSpec.rotation`: `mode` (`dual`, `swap`, `restart`), `begin(ctx)`, `finish(ctx)`, `recreate`, for every kind with generated secrets (PostgreSQL, MySQL, MariaDB, MongoDB, Valkey, Redis, Dragonfly, RabbitMQ, NATS, Kafka, Redpanda, Garage (key and RPC secret), OpenSearch, Elasticsearch, Meilisearch, Typesense, ClickHouse, Neo4j), exactly as R10 found them; values only as `OPSCREW_OLD`/`OPSCREW_NEW` in the container's env, never in a line; MySQL and MariaDB through stdin as root (both root accounts when root rotates); `seconds` for `swap` and `restart`.
    - The device logins of Valkey, Redis and Dragonfly (`grant`): `begin` adds the device user's new password, `finish` drops the old.
    - ClickHouse: the app's user moves into OpsCrew's mounted `users.d` file (applied in about 2 s, R10), so a rotation rewrites that file instead of restarting; its env var stays for the first start only.
    - NATS: the token moves into a mounted, included file and a reload (R10); the plan says the old clients are closed.
    - Docker tests (`OPSCREW_DOCKER_TESTS=1`), one per mode at least (PostgreSQL swap, MySQL dual, Valkey dual, ClickHouse restart-free file, Garage key), with a client connected through the change: open connections kept, the old value fails after `begin` (swap) or `finish` (dual). Remove every image and container made.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`, and `OPSCREW_DOCKER_TESTS=1` for the new Docker tests
  - Effort: xhigh

- [x] T2504 [P] [US1] The server's `rotate.sh`
  - Owns: `packages/iac-templates/src/workflow/rotate*.ts` (+ tests), the root export in `packages/iac-templates/src/index.ts`
  - Reads: plan 3; `workflow/snapshots.ts` (the restore's approval file and hold), `workflow/switch.ts` (the switch script)
  - Depends: T2501
  - Accept:
    - `renderRotateScript(plan, steps)`: the script of plan 3 (approval file bound to the hash, the hold, `.previous` env files, `begin`, env files, recreates, the app's switch with the running image and no pull, `finish`, release), reading the new env files and values from stdin, writing nothing secret to its output.
    - Resumable: a state file records the last step; run again, it continues; `--undo` puts the `.previous` files back and recreates the services before `finish`.
    - Refuses while a deploy, move or snapshot runs (their locks), and when the approval file is missing, used or of another hash.
    - Bash tests with a fake docker (as 024's snapshot tests): a full run, a failure at each step, resume, undo.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: xhigh

- [x] T2505 [P] [US2] The inventory and the record
  - Owns: `packages/agents/src/rotate/inventory*.ts`, `packages/agents/src/rotate/record*.ts` (+ tests)
  - Reads: research R1; plan 1
  - Depends: T2501
  - Accept:
    - `credentialInventory(deps, plan)`: every credential of plan 1 with its name, kind, how it rotates (from the catalog's `rotation` once T2503 lands; a placeholder kind map until then), what else changes, its date (the record, else "since the first deploy"); only those the environment has.
    - The record: read, update (`rotatedAt`, `generation` + 1), written with the plan's other artefacts; the user's tokens' first-seen dates in `~/.opscrew/token-dates.json` (SHA-256 fingerprints, 0600).
    - The two-computer guard: provision on a computer whose generated values are older than the record's generation stops, naming `opscrew secrets restore` (the check, as a function provision calls; the call itself is T2506's).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

## Phase 3: Wave 2

- [x] T2506 [US1] Rotating services on servers
  - Owns: `packages/agents/src/rotate/server*.ts`, `packages/agents/src/rotate/plan*.ts`, `packages/agents/src/rotate/values*.ts`, `packages/agents/src/provision/secrets.ts` (+ tests)
  - Depends: T2503, T2504, T2505
  - Accept:
    - Refused, with the next step in plain English, while a rotated service still runs on a start command from before 025 (its container file is missing): a deploy first puts it on the new one (T2503's review).
    - New values generated, old kept (`generated_values.json`, a `pending` entry) until done; every value registered with the redactor before anything prints.
    - The plan (credentials, steps, each one's window or consequence) with its hash; approval (`remote-exec`, `--approve <hash>`); GitHub secrets replaced while deploys are held; `rotate.sh` over SSH with the env files and values on stdin; split placement: each extra server's `rotate.sh begin` before the app server's full run and its `rotate.sh finish` after (T2504), each with its own approval file; refused while a move pauses deploys (`OPSCREW_DEPLOY_PAUSED`); the record and the recovery copy after.
    - Deploys paused through the existing GitHub pause (`withDeploysPaused`, `move/deploys.ts`) before the GitHub secrets are replaced and before any extra server's `begin`, released at the end (the servers' holds cover only their own runs); no undo offered on the extra servers once the app's server's run finished (T2504's review).
    - A failure keeps `pending`, says the step and how to resume or undo; provision records the first-seen date of each user token it uses (`tokenFirstSeen`, never the value), calls T2505's two-computer guard (`assertValuesCurrent`) and keeps `generations` among its kept values (`KEPT_VALUES` in `provision/secrets.ts`), or every provision drops the guard's data.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2507 [P] [US1] Portainer and this computer
  - Owns: `packages/agents/src/rotate/portainer*.ts`, `packages/agents/src/rotate/localhost*.ts`, `packages/connectors/portainer/src/**` (+ tests)
  - Depends: T2503, T2505
  - Accept: plan 4: `begin`/`finish` through Portainer's Docker exec, the values by a stack plan (by fingerprint); this computer through local Docker; the same plan, approval and record as T2506. On this computer, a rotation's hold (`held rotation <hash>`, T2504) gets its own message in `localhost/apply.ts` (which checks `back === "held"` today).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-portainer && pnpm lint`
  - Effort: high

- [x] T2508 [P] [US3] The SSH keys
  - Owns: `packages/agents/src/rotate/keys*.ts`, `packages/agents/src/secrets/files.ts`, `packages/connectors/ssh-host/src/plan.ts` (only `deployKeyStep` taking several keys) (+ tests)
  - Depends: T2505
  - Accept: plan 5 for `deploy-key`, `check-key`, `preview-key`: add first, prove (a dispatched deploy, a check run, the preview server's check), then remove; the preview key in the recovery copy.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host && pnpm lint`
  - Effort: high

## Phase 4: Wave 3

- [x] T2509 [P] [US4] App secrets
  - Owns: `packages/agents/src/rotate/app*.ts`, `packages/agents/src/shared/app-env.ts` (+ tests)
  - Depends: T2506
  - Accept: plan 6: Laravel's `APP_PREVIOUS_KEYS` and Better Auth's `BETTER_AUTH_SECRETS` keep the old value (`--drop-previous` drops it); the others need the typed app name after the consequence line; `CRON_SECRET` with both sides; Cloudflare-hosted sites through their GitHub secret and a deploy.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [x] T2510 [P] [US5] The private network, devices and their logins
  - Owns: `packages/agents/src/rotate/network*.ts`, `packages/agents/src/vpn/**`, `packages/agents/src/network/**`, `packages/connectors/ssh-host/src/network.ts` (+ tests)
  - Depends: T2506
  - Accept: plan 7: `network` (servers' keys in one `wg syncconf` change per server, every device named and its new config written), `device:<name>`, `grant:<device>/<service>` (a new password shown once).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host && pnpm lint`
  - Effort: high

- [x] T2511 [P] [US8] The Cloudflare tokens, the state passphrase and the add-ons
  - Owns: `packages/agents/src/rotate/infra*.ts`, `packages/agents/src/rotate/addons*.ts`, `packages/agents/src/shared/engine.ts`, `packages/agents/src/shared/secret-files.ts`, `packages/agents/src/secrets/**` (+ tests)
  - Depends: T2502, T2506
  - Accept: plan 8 and 10: `access-token` by an approved `-replace` plan and `tunnel-token` by the Tunnel's secret changed in place through the Cloudflare connector (R11, `packages/connectors/cloudflare/src/**` in Owns for that call), then their copies (own servers in tunnel mode: `module.access`, the Tunnel; Portainer with `redeploy: "cloudflare"`: `module.access` (the webhook's token) and `module.portainer_tunnel`, found by T2505's review); `state-passphrase` by the fallback apply of every state the passphrase encrypts (the app's, storage, backups, the Pages verification), then the file, and every engine call from then on (`shared/engine.ts`, drift, status, destroy) passing `stateKeyName` of the state file as the key's `name` (T2502), proved by a real-engine test of two rotations in a row; `portainer` (`monitoring` and `beszel`: T2519); `recovery-key` (today's code moved, `opscrew secrets rotate` removed); and the deploy key's object at the provider (`hcloud_ssh_key.deploy`, `digitalocean_ssh_key.deploy`) replaced in the deploy-key rotation's own approved plan once the new key proved itself, so the next provision plans no replacement (T2508's review; the server keeps its keys: `ssh_keys` is in `ignore_changes`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

- [x] T2519 [P] [US8] Monitoring and Beszel (split from T2511, whose report found they need provision's add-on paths)
  - Owns: `packages/agents/src/rotate/addons-monitoring*.ts`, `packages/agents/src/rotate/addons-beszel*.ts`, `packages/agents/src/provision/monitoring.ts`, `packages/agents/src/addons/**`, the add-on step builders in `packages/connectors/ssh-host/src/**` (+ tests)
  - Depends: T2506
  - Accept: plan 10:
    - `monitoring`: Grafana's admin password through Grafana's API or CLI in its container, then its env, and the monitoring's PostgreSQL login through the PostgreSQL recipe.
    - `beszel`: the hub's password, the agent's token and the hub's key, through provision's add-on host plans, each approved by its hash.
    - Both work even though the values apply only at first start: the running add-on is changed, not just its env.
    - Shared monitoring owned by another environment is rotated from that environment only.
    - The record and the recovery copy are updated as T2506 does.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host && pnpm typecheck && pnpm lint`
  - Effort: high

## Phase 5: Wave 4

- [x] T2512 [P] [US6] The user's tokens
  - Owns: `packages/agents/src/rotate/tokens*.ts` (+ tests)
  - Depends: T2505
  - Accept: plan 9: expiry or first-seen per token, `opscrew rotate <token>` checks the new one's permissions, replaces every copy, records the date and names the page to delete the old one.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [x] T2513 [P] [US7] Ages in advise and the check
  - Owns: `packages/agents/src/advise/**`, `packages/iac-templates/src/check/**`, `packages/iac-templates/check/**` (+ tests)
  - Depends: T2505
  - Accept: plan 11: advise's rule at `credentials.maxAgeDays`; the check with `check.credentials` opens an issue for an old credential, reading only the committed record.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: medium

- [x] T2514 [P] [US1] Restores after a rotation
  - Owns: `packages/agents/src/snapshot/**`, `packages/agents/src/rollback/database*.ts`, `packages/iac-templates/src/workflow/snapshots.ts` (the `about.json` generation only) (+ tests)
  - Depends: T2503, T2506
  - Accept: plan 12, after T2514's review:
    - Only volume copies of the kinds snapshotted by stopping them record a generation. A restore of an older one starts the service without waiting for its health check, then sets the current value with the old one as the login, then waits.
    - The earlier generations are kept while a volume copy or a whole-server snapshot needs them, and forgotten only by the CLI's `snapshot list`.
    - A snapshot is refused while a rotation holds the app (by hand), or skipped with a warning (scheduled).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: high

- [ ] T2520 [US1] Whole-server restores after a rotation (T2514's review)
  - Owns: `packages/agents/src/snapshot/server*.ts`, the smallest export from `packages/agents/src/rotate/server.ts` (+ tests)
  - Depends: T2514
  - Accept: plan 12. After a whole-server snapshot is restored, OpsCrew reads the restored server's `.snapshots/generations`. For each service behind the record, it runs `rotate.sh` from that generation's values to the current ones (root first for MySQL and MariaDB), approved by the restore's own hash or its own, before deploys resume. A test restores a server image taken before a PostgreSQL rotation and checks that the app logs in with the current password.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm typecheck && pnpm lint`
  - Effort: high

## Phase 6: Surfaces

- [x] T2515 [US2] The CLI, MCP, the plugin and the guide
  - Owns: `packages/cli/src/commands/rotate*.ts`, `packages/cli/src/commands/secrets.ts`, `packages/cli/src/commands/index.ts`, `packages/agents/src/index.ts` (the rotations' exports), `packages/agents/src/secrets/index.ts` (the `publishRotatedKey` re-export, removed), `packages/mcp-server/src/tools/**`, `plugin/skills/**`, `docs/guide/credential-rotation.md`, `docs/guide/secrets-recovery.md`, `README.md` (its guide list) (+ tests)
  - Depends: T2506–T2514
  - Accept: plan 13; the listing never records a token (`credentialInventory` without `recordTokens`); `github-secrets` joins the kinds `--approve <hash>` grants (`APPROVE_BY_HASH_KINDS`, T2512); the CLI's help and errors in plain English; `--json` for the list; the MCP tool read-only; the guide page with every name, mode, window and consequence, the command-line note of R10, and where the old values live until done; `opscrew secrets rotate` removed (the CLI command and its test, the MCP hint naming it, the `publishRotatedKey` re-export), since `opscrew rotate recovery-key` replaces it (T2511).
    - Every rotation's entry point is exported and dispatched by name and target: services and app secrets per target (T2506, T2507, T2509: `--drop-previous` through `dropPreviousNames`, `--confirm <app>` for the lossy ones), keys (T2508), network, devices and logins (T2510: `--qr` drawn as a QR code from the config's text), Cloudflare tokens, the passphrase, Portainer and the recovery key (T2511: the tunnel token only in a terminal), user tokens (T2512), monitoring and Beszel (T2519).
    - The guide names the limits:
      - add-on rotations go only forward (no `--undo`);
      - after a retarget into a server or this computer, rotated services count as their first generation until their next rotation, so a rollback of a service copied by stopping it restores through `opscrew restore` (T2514).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs && pnpm lint`
  - Effort: high

## Phase 7: Finish (lead)

- [ ] T2516 Live (lead): plan 14's passes; results on `docs/e2e-coverage.md`. These are things the reviews could check only offline. Each needs a real run:
  - Cloudflare: the Tunnel secret's PATCH on a token-run tunnel, with running connectors staying connected (R11, T2511).
  - A Worker version uploaded with `--secrets-file` doesn't keep a secret dropped from the file (T2509).
  - Portainer passes a stack's Env to a key the compose file names bare (T2509).
  - Grafana 13.3's `reset-admin-password --password-from-stdin` in its read-only container (T2519).
  - Beszel 0.21.1 (T2519):
    - `hub.env` makes a user and a superuser;
    - a superuser can PATCH both;
    - real curl reads the config;
    - config sync updates the agent's token;
    - the hub reads `id_ed25519` at each start.
  - Garage's key re-login after a restore: the restore's start makes the env's key first, and a `finish` whose `when` fails while Garage boots is skipped silently (T2514).
  - Better Auth with both `BETTER_AUTH_SECRET` and `BETTER_AUTH_SECRETS` set (T2509).
- [ ] T2517 Simplify (lead): a review of the feature's diff for reuse and simplicity, then its tasks. Three read-only reviews of `339f69b2..main` (013's US8 and 025) gave T2521–T2530. The guide's corrections the lead makes directly. One schedule shared by `rotate.sh` and the Docker path was left out: the two differ on purpose, and the risk is high for little gain.

## Phase 8: Simplify (T2517's tasks)

Behaviour, hashes and approval texts stay as they are unless a task says otherwise. Each task's Verify adds whole-repo `pnpm typecheck`.

- [x] T2521 Rotation's core: one lifecycle for an unfinished rotation, out of the import cycle
  - Owns:
    - `packages/agents/src/rotate/{values-pending,values,plan,server,portainer-localhost,portainer,localhost,app-site,app-values,addons-monitoring}.ts` (+ tests)
    - `packages/agents/src/shared/{approvals,deploy-pause,app-env,errors}.ts` (+ tests)
    - `packages/agents/src/move/{deploys,app-env}.ts` (+ tests)
    - `packages/agents/src/provision/secrets.ts` (+ test)
    - `packages/agents/src/rollback/database.ts` (the re-export only)
  - Accept:
    - **The cycle:** `APPROVAL_SECONDS` lives in `shared/approvals.ts` (`rollback/database.ts` re-exports it), so `rotate/plan.ts` leaves the cycle.
    - **Shared from `values-pending.ts`:** the unfinished-rotation refusal, the same-names test, forgetting a planned rotation, nothing-to-undo (`PHASE_PRECONDITION` everywhere), the began-elsewhere text, `ADDON_ROTATION_HASH` and `TARGET_WORDS`.
    - **Recording:** `completePendingRotation` records the rotation itself.
    - **Approvals:** one `requestApproval` in `shared/approvals.ts` serves the services paths. `approveRotation` takes the hash it binds.
    - **GitHub secrets:** `deploySecretPlace` and `setSecretAt` in `provision/secrets.ts`, used by `server.ts` and `move/app-env.ts`.
    - **Other shared helpers:**
      - one `requireNoOtherPause` in `move/deploys.ts`;
      - `newSecretValue` shared;
      - `serviceFingerprints` and `pairFingerprint`;
      - `continued()` in `shared/errors.ts`;
      - the small trims (`upperFirst`, one `SWITCH_SECONDS`, required `check`/`locked`, one app-env-with-one-side helper, `startsMatch`).
    - **Two behaviour fixes:**
      - Portainer and this computer refuse a service that isn't running before the approval, as servers do;
      - the rotation's stack apply asserts the bound approval in the store.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: xhigh

- [ ] T2522 The other credentials use T2521's helpers
  - Owns: `packages/agents/src/rotate/{keys,keys-files,keys-servers,network,addons-portainer,tokens,infra,infra-connectors}.ts` (+ tests)
  - Depends: T2521
  - Accept:
    - `requestApproval`, `setSecretAt` (keys' own `SecretPlace` and `secretPlace` go), `requireNoOtherPause` (infra) and `continued()` in these files.
    - Remove the unused `portainerPasswordScript` and `KeyStage`.
    - The type-only cycle `infra.ts` ↔ `infra-connectors.ts` goes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: high

- [x] T2523 The credential list takes each service's mode from the catalog
  - Owns: `packages/agents/src/rotate/inventory.ts` (+ test)
  - Accept:
    - `SERVICE_ROTATION` and its TODO go. The mode is the costliest of `serviceSpec(kind).rotation`'s secrets, so NATS and ClickHouse read as a short swap, as the guide and the approval say.
    - The `recordTokens` option no production caller passes goes. Its tests call `tokenFirstSeen`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: medium

- [x] T2524 One helper for the app's stacks as provision last set them up
  - Owns: `packages/agents/src/provision/portainer-flow.ts`, `packages/agents/src/retarget/sides/portainer.ts`, `packages/agents/src/shared/portainer-stacks.ts`, `packages/agents/src/drift/portainer.ts` (+ tests)
  - Accept:
    - `recordedPortainerStacks` is shared by `portainerStacksFor` and retarget's `stacksOf`, and retarget reuses `connectPortainer`'s inspect. `portainerStacksFor`'s signature stays as it is.
    - It passes no `github` to `offsiteSetup`, so a rotation never makes the recovery copy's first key. It stops as retarget does.
    - One constant for "already set up as planned", and one `heldPreviousValues`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: high

- [ ] T2525 Snapshot restores without repeats
  - Owns: `packages/agents/src/snapshot/{restore,generations,list}.ts` (+ tests)
  - Depends: T2520
  - Accept:
    - `restore.ts`: one audited remote run (`auditOn`) and one `unanswered`.
    - `generations.ts`: one loop for `restoreRelogins` and `rotatedLogins`, `requireNotAhead` inlined, one record-entry reader, and `holdsLogins` private.
    - `list.ts`: the second `copies` check goes.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: medium

- [x] T2526 One refusal for a rotation's deploy pause
  - Owns: `packages/agents/src/shared/deploy-pause.ts` (the new helper), `packages/agents/src/provision/run.ts`, `packages/agents/src/retarget/window.ts`, `packages/agents/src/promote/shared.ts`, `packages/agents/src/rollback/{server,resume}.ts` (+ tests)
  - Depends: T2521
  - Accept: `rotationPauseRefusal` beside `rotationWindowText`, used by every refusal. The messages stay byte for byte as they are, except that a whole-server restore's pause (T2520 marks it) is described as the restore's window, ended by `opscrew restore --server <id>`, never as a rotation begun on another computer.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: medium

- [x] T2527 Small repeats and the analyze cycle
  - Owns:
    - `packages/agents/src/shared/engine.ts`, `packages/agents/src/provision/{storage,monitoring,publish}.ts`, `packages/agents/src/destroy/deletion.ts`, `packages/agents/src/environments/shared-parts.ts`, `packages/agents/src/design/{run,builder}.ts`, `packages/agents/src/addons/run.ts`
    - `packages/agents/src/analyze/{summary,names}.ts` (`names.ts` is new)
    - `packages/connectors/ssh-host/src/plan.ts`
    - (+ tests)
  - Accept:
    - The bucket state paths sit beside `pagesVerificationStateFile`, and `storage.ts` re-exports them.
    - `destroy/deletion.ts` uses the shared `lastLines`.
    - `sharedStorage(own, source)`.
    - One monitoring new-password condition.
    - `addonFiles(plan, kind, facts)`.
    - One constant for publish's repeated warning.
    - `planTunnelToken` builds on `tunnelConnectorStep`.
    - `FRAMEWORK_NAMES` and `frameworkName` move to a leaf `analyze/names.ts`, which ends the `summary.ts` ↔ `builder.ts` cycle.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host && pnpm typecheck && pnpm lint`
  - Effort: medium

- [ ] T2528 `rotate.sh` and the hold checks without repeats
  - Owns: `packages/iac-templates/src/workflow/{rotate,switch,snapshot-script}*.ts`, `packages/iac-templates/src/workflow/index.ts` (`heldCheck` only), `packages/iac-templates/src/index.ts`, their `__snapshots__`
  - Accept:
    - `rotate.ts` imports the catalog's `RotationCommand`, `ConditionalCommand`, `RotationStep` and `RotationMode` instead of copying them.
    - One `heldStop(plan, prefix, end)` in `switch.ts`, used by `heldRefusal` and both places in `rotate.ts`. `rotationHeldStop` loses its `variable` parameter.
    - One constant for the repeated "new values" refusal.
    - The unused root exports (`ConditionalCommand`, `GrantRotation`, `RotationMode`, `ServiceRotation`, `rotateEnvFiles`) go.
    - Optional: the rotation-stop line becomes one shell function in `snapshot.sh`.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates --filter=@opscrew/agents && pnpm typecheck && pnpm lint`
  - Effort: high

- [ ] T2529 The CLI's rotate and approvals without repeats
  - Owns: `packages/cli/src/approval*.ts`, `packages/cli/src/commands/{rotate,restore}*.ts`
  - Accept:
    - **One helper:** `rotationApprovals` and `restoreApprovals` share a `showInScript` option, or one helper, in `approval.ts`. `ScriptedRotationApproval`'s narrow `--yes` stays as it is.
    - **`rotate.ts` builds once:** it builds `remote`, `sleep` and `now` once, and passes `provision` in.
    - **Help text:** the `--undo` help and the `checkFlags` error mention forgetting an add-on rotation that was never approved. In a script, every refusal prints the request's plan lines (windows, steps) before the `--approve <hash>` hint, not only lossy ones, as the guide says (T2516's harness).
  - Verify: `pnpm turbo run typecheck test --filter=opscrew && pnpm typecheck && pnpm lint`
  - Effort: medium

- [x] T2530 The catalog's recipe pieces
  - Owns: `packages/iac-templates/src/catalog/entries.ts`
  - Accept:
    - New `dual()` beside `swap()` and `restart()`.
    - New `rootBegin(client, change)` for MySQL and MariaDB, and a local `mysqlRoot(...)`.
    - `newFile` takes a writer, and NATS and ClickHouse use it.
    - The rendered commands stay byte for byte as they are: `rotation.test.ts` passes unchanged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm typecheck && pnpm lint`
  - Effort: medium

- [ ] T2531 [US3] [US8] Rotations' infrastructure plans in a script (T2516's live pass)
  - Owns: `packages/agents/src/rotate/infra.ts` (`planRotation` and its callers) (+ test), the `--approve` hashes passed into the rotations in `packages/cli/src/commands/rotate.ts` (+ test)
  - Accept:
    - **The problem:** a plan's hash is the hash of its plan file's bytes, and these change with every plan. So a rotation's infrastructure plan, made fresh each run, could never be approved by a script's `--approve <hash>`. This affects the deploy key's copy at the provider, the Access token's `-replace` and the state passphrase's fallback applies.
    - **The fix, as provision does it** (`findSavedPlan`, the plan's sidecar):
      - A refused run saves its plan and sidecar.
      - The next run, given `--approve <hash>` (and `--confirm <app>` where the plan replaces resources), applies that saved plan after checking its file's hash. The engine refuses a stale one.
      - A terminal asks as before.
    - **The test:** a scripted deploy-key rotation on Hetzner finishes in two runs: refused with the hash, then approved.
  - Depends: none. T2522 and T2529 rebase onto it.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=opscrew && pnpm typecheck && pnpm lint`
  - Effort: high

- [ ] T2518 The release 0.2.6 (lead): `docs/releasing.md`, with 013's US8 (founder, 2026-11-08). The changelog says that existing deployments recreate MySQL, MariaDB, Valkey, Redis, Dragonfly, Kafka, Redpanda, OpenSearch and Elasticsearch once at their next deploy (their start commands changed, T2503), and that apps on Portainer or Cloudflare's hosting or GitHub Pages whose `APP_KEY` or `BETTER_AUTH_SECRET` OpsCrew generates get `APP_PREVIOUS_KEYS` or `BETTER_AUTH_SECRETS` named in their committed stack template or deploy workflow at their next provision. It stays unset until a rotation keeps an old key there (T2509).

## Dependencies

T2501 → {T2502, T2503, T2504, T2505} → {T2506 (after T2503–T2505), T2507, T2508} →
{T2509, T2510, T2511, T2514} (after T2506) and {T2512, T2513} (after T2505) → T2515 → T2516 →
T2517 → T2518.
