# Data model: Environments, local runs and runners (015)

## Environment (in each `plan.yaml`)

`plan.environment`. When absent, or present without a `name`, the plan is prod's: prod can carry its own `deploySource`, `runner` and `secrets`, but its name is never written (T1501a):

| Field | Type | Rule |
|---|---|---|
| `name` | `^[a-z][a-z0-9-]{0,15}$`, not a name Windows reserves (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, which Git for Windows cannot check out), and not `production`, `storage`, `storage-*`, or a name with `service` as one of its hyphen-separated parts, optional | Never `prod`; absent for prod. Unique per app (the folder name). A named environment's `app.name` ends with `-<name>`. |
| `deploySource` | `{ from: "main" }` or `{ from: "promote", source: <env> }` | `source` names an existing environment of the app, never the environment itself, and the sources form no cycle. Prod's own default is `{ from: "main" }` while it is the only environment. |
| `cicd.branch` (each environment's own) | a branch the repository has | With `deploySource.from: main`, the branch whose pushes build and deploy this environment. Two environments never follow the same branch. Design sets prod's to the repository's default branch; `env add|set --branch` sets another environment's (FR-1537). |
| `runner` | `github`, `server`, `local` or `host` | `server` only for cloud and own-server targets, `local` only for localhost, `host` (a runner machine) only for cloud and own-server targets. Default `github`. |
| `runnerHost` | `{ name, arch }` | Required with `runner: host`, absent otherwise. `name` names a runner machine of the project; no address. |
| `build` | `github` or `runner` | `runner` only with `runner: local` or `host`, and only for an environment that follows main. The runner's `arch` must equal the target's. Default `github`. |
| `secrets` | `environment` or `prefixed` | Written by provision after the capability check (R1). Prod's names stay unprefixed in both cases. |

**Derived per environment:**
- `app.name` is `<app>` for prod and `<app>-<env>` for the others.
- The hostnames are the environment's own:
  - its `dns.domain`, for example `staging.<domain>`;
  - for localhost, `<app>.localhost`, or `<env>.<app>.localhost` when the app has another localhost environment.

**Shared parts**, copied from prod's plan by design and compared by provision:
- `app.build`, `app.port`, `app.healthPath`, `app.releaseCommand`, `app.processes`;
- `services`, `storage.sqlite`, `externalServices`;
- `supplyChain.sign`, since the source environment signs and the promoted one verifies.

Everything else is the environment's own.

## Localhost target (`plan.target`)

| Field | Type | Rule |
|---|---|---|
| `provider` | `"localhost"` | |
| `mode` | `"local-compose"` | |
| `arch` | `amd64` or `arm64` | The computer's, read at design. |
| `ports` | `{ https: 443 \| 8443, http: 80 \| 8080 }` | Probed at design and checked again at provision. |
| `image` | `registry` or `local-build` | `registry` when `arch` matches production's builds; `local-build` only for apps built from a Dockerfile. Otherwise `registry` under emulation, with a warning. |
| `edge` | `caddy` or `nginx` | As on servers (014). |

No location, server type, price or DNS record.

## Paths per environment

| | Prod | Any other environment `<env>` |
|---|---|---|
| Plan, runbook, security report, runtime files, recovery copy | `opscrew/` (today) | `opscrew/environments/<env>/` |
| Requirements | `opscrew/requirements.yaml` | the same, plus `opscrew/environments/<env>/requirements.yaml` with only the answers that differ |
| State, approvals, saved plans, records | `.opscrew/` (today) | `.opscrew/environments/<env>/` |
| Infrastructure state | `.opscrew/tfstate/prod.tfstate` | `.opscrew/environments/<env>/tfstate/<env>.tfstate` |
| Infrastructure root | `opscrew/infra/prod` | `opscrew/infra/<env>` |
| Generated values, deploy key, known hosts, state passphrase | `<project home>/` | `<project home>/environments/<env>/` |
| Workflow | `.github/workflows/opscrew-deploy.yml` | `.github/workflows/opscrew-deploy-<env>.yml` |

Shared by every environment: `architecture.json`, `ARCHITECTURE.md`, the scan report and
`opscrew/proxy/` (the additions).

## Deploy secrets per environment

| `secrets` | Where | Names |
|---|---|---|
| `environment` | the GitHub environment `<env>` (prod: `production`) | prod: today's names (`OPSCREW_HOST`, …); others: `OPSCREW_<ENV>_HOST`, … as below, so a missing secret never falls back to prod's repository secret of the same name |
| `prefixed` | repository secrets | prod: today's names; others: `OPSCREW_<ENV>_HOST`, … (`<ENV>` upper-cased, `-` as `_`) |

## Promotion

| Field | Rule |
|---|---|
| `source`, `target` | environments of the app; the target's `deploySource.source` is `source` |
| `digest` | `sha256:<64 hex>`: the source's `opscrew-<source>` tag, or a rollback digest (the target's `opscrew-<target>-previous`) |
| `provenance` | the build run named by the image's SLSA v1 provenance (`runDetails.builder.id`); that run must be in this repository, on the default branch, with `head_sha` matching the image's commit tag |
| `signature` | checked when the app signs images |
| `targetPlanHash` | the target's plan hash with no pending change |
| approval | kind `promote`, `planHash` = SHA-256 of the canonical `{ target, source, digest, targetPlanHash }` |

**Commit tags per environment** (T1515's live run, 2026-10-22): prod's build tags `<commit>`; a named environment's build tags `<commit>-<env>`. Two environments that both follow main build the same commit separately, and a shared `<commit>` tag would move to the later build, leaving the other untagged (retention then deleted it) and failing promotion's commit-tag check.

GHCR label tags after a healthy deploy: `opscrew-<env>` (running) and `opscrew-<env>-previous`.
Retention keeps every version with an `opscrew-<env>` or `opscrew-<env>-previous` tag, and the newest `keep` commit versions of each environment (by its tag form), never fewer for one environment because another builds more.

## Self-hosted runner

| Field | Server runner | Local runner |
|---|---|---|
| Where | `/srv/runners/<app>` on the server (`<app>` is the environment's app name, `<app>-<env>` outside prod) | `<OpsCrew home>/runners/<app>-<env>` on the computer |
| User | `deploy` | the user |
| Lifetime | persistent, a systemd service | one session in the foreground (`--ephemeral`) |
| Label | `opscrew-<app>-<env>` | `opscrew-<app>-<env>` |
| Name | `<8 hex of sha256(host)>-<app>-<env>`, so GitHub never sees the address | `<computer>-<app>-<env>` |
| Registered by | the host plan step, with a token fetched at apply | `opscrew runner start`, with a token fetched at start |
| Removed by | teardown (`config.sh remove`, else `DELETE /runners/{id}`) | stop (the API) |
| Allowed | private repositories, or public ones whose fork-PR policy is `all_external_contributors` | the same |

## Runner machine (FR-1532)

| Item | Rule |
|---|---|
| Record | `<project home>/runner-hosts/<name>.json`: the SSH login (user, address, port), the key file, the pinned host key, `arch`, and whether Docker is installed. Never committed. |
| Name | `^[a-z][a-z0-9-]{0,31}$`, unique in the project |
| Host plan | the deploy user, the runner prerequisites (as on own servers), Docker (the deploy job's edge check uses it), and one `github-runner` step per environment that uses it. No edge, app, firewall or SSH hardening steps. |
| Runner per environment | as the server runner: `/srv/runners/<app>` as `deploy`'s user service, label `opscrew-<app>-<env>`, name `<8 hex of sha256(host)>-<app>-<env>` |
| Hardening (FR-1536) | off by default. `harden.ssh: true` adds the own server's `sshd` step; `harden.firewall: { sshFrom: [CIDR, …] }` adds the `ssh-firewall` step, an nftables table `inet opscrew` that accepts port 22 only from `sshFrom` and leaves every other port and rule alone. `sshFrom` has no default: a guess at this computer's address could lock the user out when it changes. |
| Another repository's runner folder | refused, never replaced |
| Removal | refused while an environment uses the machine |

## Local certificate authority

| Item | Where | Rule |
|---|---|---|
| Key | `~/.opscrew/local-ca/ca.key` | P-256, 0600, never committed, copied or printed |
| Certificate | `~/.opscrew/local-ca/ca.pem` | CA:TRUE, keyCertSign, CN `OpsCrew local CA (<computer>)`, 10 years |
| Leaf per localhost hostname | the edge's TLS folder for the app | P-256, SAN DNS, serverAuth, 1 year, renewed by provision with fewer than 30 days left |
| Trusted | a flag in `~/.opscrew/local-ca/trust.json` | written by `localhost trust`, cleared by `untrust` |

## Approval kinds (added)

| Kind | Hash-bound | `--yes` grants | Used for |
|---|---|---|---|
| `promote` | yes | never | a promotion or rollback deploy |
| `github-settings` | no | yes, like `github-secrets` | creating or deleting a GitHub environment, its rules, the fork-PR policy |
