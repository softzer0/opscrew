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

- [ ] T2503 [P] [US1] The catalog's rotation recipes
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

- [ ] T2504 [P] [US1] The server's `rotate.sh`
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

- [ ] T2506 [US1] Rotating services on servers
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

- [ ] T2507 [P] [US1] Portainer and this computer
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

- [ ] T2509 [P] [US4] App secrets
  - Owns: `packages/agents/src/rotate/app*.ts`, `packages/agents/src/shared/app-env.ts` (+ tests)
  - Depends: T2506
  - Accept: plan 6: Laravel's `APP_PREVIOUS_KEYS` and Better Auth's `BETTER_AUTH_SECRETS` keep the old value (`--drop-previous` drops it); the others need the typed app name after the consequence line; `CRON_SECRET` with both sides; Cloudflare-hosted sites through their GitHub secret and a deploy.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [ ] T2510 [P] [US5] The private network, devices and their logins
  - Owns: `packages/agents/src/rotate/network*.ts`, `packages/agents/src/vpn/**`, `packages/agents/src/network/**`, `packages/connectors/ssh-host/src/network.ts` (+ tests)
  - Depends: T2506
  - Accept: plan 7: `network` (servers' keys in one `wg syncconf` change per server, every device named and its new config written), `device:<name>`, `grant:<device>/<service>` (a new password shown once).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/connector-ssh-host && pnpm lint`
  - Effort: high

- [ ] T2511 [P] [US8] The Cloudflare tokens, the state passphrase and the add-ons
  - Owns: `packages/agents/src/rotate/infra*.ts`, `packages/agents/src/rotate/addons*.ts`, `packages/agents/src/shared/engine.ts`, `packages/agents/src/shared/secret-files.ts`, `packages/agents/src/secrets/**` (+ tests)
  - Depends: T2502, T2506
  - Accept: plan 8 and 10: `access-token` and `tunnel-token` by an approved `-replace` plan, then their copies (own servers in tunnel mode: `module.access`, the Tunnel; Portainer with `redeploy: "cloudflare"`: `module.access` (the webhook's token) and `module.portainer_tunnel`, found by T2505's review); `state-passphrase` by the fallback apply, then the file, and every engine call from then on (`shared/engine.ts`, drift, status, destroy) passing `stateKeyName` of the state file as the key's `name` (T2502); `monitoring`, `portainer`, `beszel`; `recovery-key` (today's code moved, `opscrew secrets rotate` removed); and the deploy key's object at the provider (`hcloud_ssh_key.deploy`, `digitalocean_ssh_key.deploy`) replaced in the deploy-key rotation's own approved plan once the new key proved itself, so the next provision plans no replacement (T2508's review; the server keeps its keys: `ssh_keys` is in `ignore_changes`).
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: xhigh

## Phase 5: Wave 4

- [x] T2512 [P] [US6] The user's tokens
  - Owns: `packages/agents/src/rotate/tokens*.ts` (+ tests)
  - Depends: T2505
  - Accept: plan 9: expiry or first-seen per token, `opscrew rotate <token>` checks the new one's permissions, replaces every copy, records the date and names the page to delete the old one.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - Effort: high

- [ ] T2513 [P] [US7] Ages in advise and the check
  - Owns: `packages/agents/src/advise/**`, `packages/iac-templates/src/check/**`, `packages/iac-templates/check/**` (+ tests)
  - Depends: T2505
  - Accept: plan 11: advise's rule at `credentials.maxAgeDays`; the check with `check.credentials` opens an issue for an old credential, reading only the committed record.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: medium

- [ ] T2514 [P] [US1] Restores after a rotation
  - Owns: `packages/agents/src/snapshot/**`, `packages/agents/src/rollback/database*.ts`, `packages/iac-templates/src/workflow/snapshots.ts` (the `about.json` generation only) (+ tests)
  - Depends: T2503, T2506
  - Accept: plan 12: each snapshot records the generations; a restore of an older one sets the current values with the old as the login (MySQL and MariaDB: root first, since their app-password commands log in as root); the earlier generations kept while a snapshot needs them.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - Effort: high

## Phase 6: Surfaces

- [ ] T2515 [US2] The CLI, MCP, the plugin and the guide
  - Owns: `packages/cli/src/commands/rotate*.ts`, `packages/cli/src/commands/secrets.ts`, `packages/cli/src/commands/index.ts`, `packages/mcp-server/src/tools/**`, `plugin/skills/**`, `docs/guide/credential-rotation.md`, `docs/guide/secrets-recovery.md`, `README.md` (its guide list) (+ tests)
  - Depends: T2506–T2514
  - Accept: plan 13; the listing never records a token (`credentialInventory` without `recordTokens`); `github-secrets` joins the kinds `--approve <hash>` grants (`APPROVE_BY_HASH_KINDS`, T2512); the CLI's help and errors in plain English; `--json` for the list; the MCP tool read-only; the guide page with every name, mode, window and consequence, the command-line note of R10, and where the old values live until done.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && node plugin/validate.mjs && pnpm lint`
  - Effort: high

## Phase 7: Finish (lead)

- [ ] T2516 Live (lead): plan 14's passes; results on `docs/e2e-coverage.md`.
- [ ] T2517 Simplify (lead): a review of the feature's diff for reuse and simplicity, then its tasks.
- [ ] T2518 The release 0.2.6 (lead): `docs/releasing.md`, with 013's US8 (founder, 2026-11-08). The changelog says that existing deployments recreate MySQL, MariaDB, Valkey, Redis, Dragonfly, Kafka, Redpanda, OpenSearch and Elasticsearch once at their next deploy (their start commands changed, T2503).

## Dependencies

T2501 → {T2502, T2503, T2504, T2505} → {T2506 (after T2503–T2505), T2507, T2508} →
{T2509, T2510, T2511, T2514} (after T2506) and {T2512, T2513} (after T2505) → T2515 → T2516 →
T2517 → T2518.
