# Research: Retarget (2026-10-13)

## `moved` blocks for module calls (verified with real binaries)

Experiment with OpenTofu and Terraform from `.tools/bin` (built-in `terraform_data`, local state):
module `server` (source `../a`) applied; then configurations A–C.

| Step | Configuration | OpenTofu and Terraform |
|---|---|---|
| A | `moved { from = module.server, to = module.server_previous }` + `module "server_previous"` (same source), no `module "server"` | `Plan: 0 to add, 0 to change, 0 to destroy`; `show -json` lists the resource at the new address with `previous_address` = old address and action `no-op`; apply renames it in the state |
| A again | same | `No changes` (the `from` address is gone from the state; the block is a no-op) |
| — | `moved` block **and** a new `module "server"` in the same configuration | **Error: Moved object still exists** — a move cannot free an address the same configuration declares |
| B | `module "server_previous"` + new `module "server"` (other source), no `moved` block | `1 to add` |
| C | `module "server"` only | `1 to destroy` (the removed module's resources) |

Consequences:
- Renaming the live server's module and creating the new server are two separate plans: first
  a moves-only plan (layout `rename`), then the plan that adds the new server (layout `both`).
  The reverse (abort) is the same: destroy the new module, then a moves-only plan back.
- `moved` blocks are rendered only in the moves-only layouts.
- A moves-only plan has no resource changes. The engine must report moves (`previous_address`)
  and the apply step must still apply it (today `planAndApply` treats "no changes" as up to date
  and `parsePlanJson` drops `no-op`).
- Terraform requires ≥ 1.1 for module moves (https://developer.hashicorp.com/terraform/language/modules/develop/refactoring);
  OpenTofu ≥ 1.6 supports them (verified above); both are below OpsCrew's ≥ 1.6 floor.
- Destroying a removed module's resources uses the root provider configuration, so the old
  provider's `provider` block and `required_providers` entry stay rendered until the old server
  is gone (OpsCrew keeps both providers rendered for the whole retarget).

## GitHub workflow dispatch (https://docs.github.com/en/rest/actions/workflows)

- `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` with `{ ref }`
  (`workflow_id` may be the file name `opscrew-deploy.yml`). Fine-grained token: Actions write
  (already in OpsCrew's GitHub token permissions). The workflow has `workflow_dispatch: {}`.
- Response: current docs show 200 with `{ workflow_run_id, run_url, html_url }`; older behaviour
  was 204 without a body. The client accepts both and, without an id, finds the run with
  `GET .../workflows/{id}/runs?event=workflow_dispatch&branch=<ref>&created=>=<ISO time>`
  (https://docs.github.com/en/rest/actions/workflow-runs).

## What has to move (from the code)

- Compose services: `app` (no volumes), `db` (`postgres:17-alpine`, bind mount
  `/srv/data/postgres`), `cache` (`valkey`, a cache: not moved), `caddy` (certificates are issued
  again on the new server). So only the Postgres database moves.
- Postgres user and database are `app`/`app`; the password lives in
  `<projectHome>/generated_values.json` and reaches the server through the `OPSCREW_DB_ENV` GitHub
  secret, so the new server gets the same credentials and the dump restores as is.
- Transfer: `pg_dump -Fc` into a file in `/srv/app` on the old server (owned by `deploy`,
  `umask 077`), `scp -3` from the old to the new server through this computer (OpenSSH; no new
  streaming API needed, any size), `pg_restore --clean --if-exists --no-owner` on the new
  server, then delete both files.
- Health of the new server before the DNS switch: the deploy workflow's health check uses the
  domain (it would reach the old server), so OpsCrew checks the new server over SSH:
  `docker compose exec -T caddy wget -q -O /dev/null -T 5 http://app:<port><healthPath>`
  (`caddy:2-alpine` ships busybox `wget`).
- Caddy on the new server cannot get a certificate before DNS points at it; OpsCrew stops Caddy
  there after the deploy and starts it after the switch, so the ACME client starts fresh.
