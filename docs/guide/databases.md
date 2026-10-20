# Databases

When your app uses PostgreSQL, MySQL, MariaDB, MongoDB or SQLite, OpsCrew runs the database next to
it on the same server, with a memory limit, a generated password and a data folder that every
deploy keeps. It costs nothing beyond the server memory it takes, which design shows with its
share of the server's price (see [Components](components.md)).

## What OpsCrew runs

| Database | Version | Memory limit (lowest) | Smallest server | Licence |
|---|---|---|---|---|
| PostgreSQL | 17 | 512 MB (256 MB) | 1 GB | PostgreSQL licence |
| MySQL | 8.4, the long-term release | 512 MB (384 MB) | 1 GB | GPL 2.0 |
| MariaDB | 12.3, the long-term release | 384 MB (256 MB) | 1 GB | GPL 2.0 |
| MongoDB | 8.0 | 512 MB (384 MB) | 1 GB | SSPL |

OpsCrew picks the database from the client library your app uses (`pg`, `mysql2`, `mongoose`,
`pymongo` …). MariaDB runs only when your app asks for MariaDB itself (for example Laravel's
`DB_CONNECTION=mariadb`); a MySQL app gets MySQL, since some of its data types do not load in
MariaDB. The GPL and the SSPL put no conditions on your app's own code when you run the database
for it; they are about sharing or offering the database software itself.

Each database runs from its official image, pinned by digest. Dependabot proposes newer releases
of the same major version in your repository, never a new major one: moving to a new major version
can need a data migration, so that choice is yours.

## What your app receives

| Database | Variables | Address |
|---|---|---|
| PostgreSQL | `DATABASE_URL` | `postgresql://app:<password>@db:5432/app` |
| MySQL | `DATABASE_URL` | `mysql://app:<password>@mysql:3306/app` |
| MariaDB | `DATABASE_URL` | `mysql://app:<password>@mariadb:3306/app` |
| MongoDB | `MONGODB_URI`, `DATABASE_URL` | `mongodb://app:<password>@mongodb:27017/app?authSource=admin` |

When your app reads its own variable for the address (for example `MYSQL_URL`), that one gets the
address too. OpsCrew generates each password, keeps it on the computer that ran
`npx opscrew provision` (never in your repository) and hands it to the server through your
repository's encrypted deploy secrets. The database listens only on the app's own network: no
port is open to the internet, or to other apps on the server.

## Settings for small servers

- **MySQL** gets a buffer pool of its memory limit minus about 400 MB for everything else (at least
  128 MB), the performance schema off and at most 50 connections, in a settings file next to
  `opscrew/runtime/compose.yaml`. A larger memory limit gives it a larger buffer pool.
- **MongoDB** gets a cache of half its memory limit (at least 0.25 GB), set explicitly, because
  MongoDB may not see the container's limit on its own.
  - **A replica set of one member**, which Prisma and multi-document transactions need. OpsCrew
    turns it on for a Prisma app; for transactions without Prisma, set
    `options: { replicaSet: true }` on the service in `opscrew/plan.yaml`. The deploy sets it up
    the first time, and the address then names it.
  - **On x86 servers, MongoDB needs a CPU with AVX.** Some older servers you may already have lack
    it, and MongoDB would crash at start, so on a server you own `npx opscrew provision` checks the
    CPU first and stops with a plain message when AVX is missing.
- **PostgreSQL and MariaDB** run with their image's defaults.

## Where the data is

On a server, each database keeps its files in `/srv/data/<app>/<name>`, for example
`/srv/data/shop/db` for PostgreSQL. The folder belongs to your app alone, so several apps on one
server never share one. In your Portainer, the data is in the named volumes of the app's stack.

Deploys never recreate a database container unless its own settings or image changed.
`npx opscrew destroy` keeps the data unless you add `--delete-data` and type the app's name.

## A database you already host elsewhere

When your app already uses a hosted database (a `mongodb+srv://` address from MongoDB Atlas,
PlanetScale, Neon …), the interview asks whether to keep it or let OpsCrew run one on the server.
If you keep it, OpsCrew runs nothing for it: set its address in your app's production environment,
as before.

## Backups

On Hetzner Cloud and DigitalOcean, the provider's server backups cover the database folders. They
copy a running server, so they are crash-consistent only: the database recovers from them as after
a power cut, and the last seconds of writes can be missing. For a copy you can restore anywhere,
dump the database from the app's folder on the server, for example:

```bash
cd /srv/apps/shop
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
docker compose exec -T mysql sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" app' > backup.sql
docker compose exec -T mongodb sh -c 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' > backup.archive
```

On a server you already have, and in your Portainer, backups are yours: OpsCrew cannot turn them
on there.

## SQLite

A SQLite database is a file inside your app, so OpsCrew does not run a database for it. Instead:

- **The database's folder is a persistent volume.** `storage.sqlite.dir` in `opscrew/plan.yaml`
  names the folder, relative to your app (for example `storage` for Rails 8). It is mounted from
  the Docker volume `<app>_sqlite`, which every deploy keeps, together with SQLite's `-wal` and
  `-shm` files.
- **The folder must hold only the database**, or the volume would hide your other files from the
  app. Laravel's `database/database.sqlite` (next to the migrations) moves to `storage/database`,
  and a Prisma database inside `prisma/` (next to the schema) moves to `data`, with the app's
  variable (`DB_DATABASE`, `DATABASE_URL`) pointed at the new place. For a database anywhere else
  next to your code, such as Django's `db.sqlite3` beside `manage.py`, design stops and asks you to
  move it into a folder of its own, for example `data/app.sqlite3`.
- **Where the folder is in the image:** under the app's folder there: `/workspace` with
  Buildpacks, `/app` with Railpack and with OpsCrew's Dockerfile (`/app/<folder>` for a Node.js app
  in a subfolder of the repository), and the last `WORKDIR` of your own Dockerfile.
- **Deploys stop the old version before the new one starts**, so two copies never write to the
  database at once (`deploy.strategy: recreate`). The site is down for a few seconds during each
  deploy.

### Who owns the database folder

Docker gives a new volume the owner of the folder in the image. OpsCrew's Dockerfile, and the step
OpsCrew adds to Buildpacks and Railpack images, make that folder the app's own user's, so the app
can write its database. With **your own Dockerfile**, that is up to the Dockerfile: a folder it
copies as root (`COPY` without `--chown`) stays owned by root, and an app that runs as another user
cannot write to it. Give the folder to the app's user before the `USER` line, for example:

```dockerfile
RUN mkdir -p /app/storage && chown app:app /app/storage
USER app
```

### Changing the image's user later

The volume keeps the owner it got when it was created. When the image later runs as another user,
the app cannot write its database until the volume's owner changes too:

- **When you change the builder** (`app.build.builder` in `opscrew/plan.yaml`), the image's user
  changes with it: Buildpacks runs apps as `1002:1001`, Railpack as `10001:10001`, OpsCrew's
  Dockerfile as `1000:1000` (Node.js) or `10001:10001` (Python). `npx opscrew design` warns you and
  prints the command for your app.
- **When you change `USER` in your own Dockerfile**, OpsCrew does not notice. Change the owner
  yourself before you deploy the new image.

When you change the builder, `npx opscrew design` prints the exact command for your app, with the
edge's Caddy image as OpsCrew pins it (the image is already on the server and has `chown`). It has
this form, with the new user's numbers:

```bash
docker run --rm --user 0 --entrypoint chown -v <app>_sqlite:/d <the edge's Caddy image> -R <uid>:<gid> /d
```

After a change of `USER` in your own Dockerfile, use the same form with that user's numbers and the
image named in the `caddy` service of `/srv/edge/compose.yaml` on the server. In your Portainer,
design names a one-off container to run instead: the pinned Caddy image, user `0`, entrypoint
`chown`, command `-R <uid>:<gid> /d`, with the stack's volume `<stack>_sqlite` mounted at `/d`.
