# ADR 0028: A rollback undoes the database, by snapshot or down migrations

**Status**: Accepted (2026-11-06, feature 019's follow-up, shipped with 023). The founder asked for
it on 2026-11-06 and chose the snapshot as the default, on for every environment except prod, with
down migrations offered as an option; the rest of the design is the lead's.

## Context

ADR 0023's rollback changes only the image: the data and the schema stay, and the release command
never runs, so the earlier version must work with the newer schema. That holds when every release
adds first and removes later. Most apps on dev and staging don't follow that rule, so their
rollback fails exactly after a release that changed the database.

Research R9 (019's research.md) found that down migrations exist for most migration tools but not
for Prisma or Drizzle, often stop partway at an irreversible step, and lose data anyway. A logical
dump works for every tool and can't stop halfway, but loses what was written since.

## Decision

- **D7: a snapshot is a logical dump per database, on the server,** taken before every release
  while the running version serves (PostgreSQL `pg_dump -Fc`, MySQL `mysqldump`, MariaDB
  `mariadb-dump`, MongoDB `mongodump`, each in the service's pinned image). It is filed under the
  outgoing version's digest, and the last 3 versions are kept (`deploy.keepSnapshots`). On by
  default for every environment except prod and previews (`deploy.snapshots`).
- **D8: four databases now.** The app's own files (SQLite, uploads), a database on another server
  and Portainer come with 024's snapshot commands.
- **D9: down migrations for eight tools:** Rails, Django, Alembic, Flask-Migrate, Knex,
  Sequelize, TypeORM and Laravel. Every deploy records the tool's migration state after the
  release command; a rollback runs the newer image's down command to the earlier state. Other
  tools join as rows of one table.
- **D10: the server enforces the approval.** `opscrew rollback` asks how to treat the database,
  approves a restore or down migration like a destroy (`allowDestroy`, the typed name), then writes
  a one-time approval file on the server naming the target digest and the choice, valid for 30
  minutes. The start script changes data only with it, so a hand-made workflow dispatch can't.
- **D11: the current database is saved before any restore or down migration.** A failure puts it
  back and the running version serves again; a later rollback forward can restore it.
- **D12: a database rollback holds requests and recreates,** whatever the deploy strategy, so the
  newer version never writes to a database being replaced.

## Consequences

- Every server deploy workflow's script changes once: users run `opscrew provision`.
- Deploys on environments with snapshots take as long as the dump, and the server keeps up to 3
  dumps of each database. Too little free space skips the snapshot with a warning.
- The release command still never runs on a rollback.
