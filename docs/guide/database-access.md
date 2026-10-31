# Your production database from your device

Sometimes you want to look at production data yourself, with `psql`, DBeaver or `redis-cli`. OpsCrew
can give one of your [devices](private-network.md) access to one database or cache, over the app's
private network:

- **off by default,** per device and per service;
- **with a login of its own,** never the app's: the app's password never reaches your device;
- **read-only** (recommended) **or full;**
- **listed** in `npx opscrew status` and `npx opscrew secure`, and removed with one command.

It covers Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis and Dragonfly. Kafka, Redpanda,
OpenSearch and the other brokers and engines can't be granted: OpsCrew refuses with the reason.

## Before you start

- The device is on the app's private network (`npx opscrew vpn add laptop --this-computer`, see
  [your devices on the private network](private-network.md)), with its tunnel on.
- The service runs on a server the internet reaches: one OpsCrew created, a server of its own (see
  [split placement](split-placement.md)), or a server you already have with a public address. A
  service on a server of yours reached only through a Cloudflare Tunnel can't be granted.

## Grant read-only access

```bash
npx opscrew vpn grant laptop db
```

`db` is the service's name in `opscrew/plan.yaml`. OpsCrew:

1. generates the login's password and keeps it on this computer, with OpsCrew's other generated
   values (and in the [recovery copy](secrets-recovery.md));
2. creates a login named after the device (`laptop`) that can read but not write, through a host
   plan on the service's server that you approve by its hash;
3. lets that device, and only it, reach the service's port on the server's private address;
4. prints the connection details, once.

For Postgres it looks like this (the address and port are your service's):

```text
psql "postgresql://laptop@10.200.4.2:5432/app"
```

with the password to paste when it asks, and a full URL for DBeaver or another client. MySQL and
MariaDB get a `mysql -h … -P … -u laptop -p app` line, MongoDB a `mongosh` line, and Valkey, Redis
and Dragonfly a `redis-cli -h … -p … --user laptop --askpass` line.

The details are shown only then. The password stays in `generated_values.json` in this project's
OpsCrew folder on this computer, readable only by you.

**When the grant takes effect:**

- **Postgres, MySQL, MariaDB and MongoDB:** right after the host plan, when the service already
  answers on the private network.
- **Valkey, Redis and Dragonfly:** their logins live in the service's settings (only the password's
  SHA-256 is stored, in GitHub). OpsCrew says to run `npx opscrew provision`, and the login works
  from the next deploy.
- **A service that didn't answer on the private network yet** (it only served the app on its own
  server): OpsCrew says to run `npx opscrew provision`; the grant works once its deploy has run.

## What read-only allows

| Service | Read-only | Refused |
|---|---|---|
| Postgres | Reading every table, also tables made later | Writes, and creating tables |
| MySQL, MariaDB | `SELECT` and `SHOW VIEW` on the app's database | Writes, and other databases |
| MongoDB | Reading the app's database | Writes, and other databases |
| Valkey, Redis, Dragonfly | Read commands, `KEYS` and `SCAN` | Writes, and admin commands such as `CONFIG`, `FLUSHALL` and `SHUTDOWN` |

## Full access

```bash
npx opscrew vpn grant laptop db --full
```

Full access lets the device change and delete the app's production data, and so can anyone who
holds the device. OpsCrew says so and asks you to confirm. In a script, where nobody can answer,
add `--yes-full-access` to confirm it on the command line. Read-only access is enough to look at the
data.

Full access is all of the app's data, never control of the server:

- **Postgres:** reading and writing every table, but no schema changes and none of the app's
  superuser rights (a superuser could run programs on the server);
- **MySQL and MariaDB:** every right on the app's database, as the app has, and nothing outside it;
- **MongoDB:** reading and writing the app's database, and its indexes;
- **Valkey, Redis and Dragonfly:** every command except the admin ones (no `CONFIG`, `MODULE`,
  `SHUTDOWN`, `REPLICAOF` or `ACL`).

Running `vpn grant` again with or without `--full` changes the grant's kind and keeps its password.

## Who has access

`npx opscrew status` lists each grant under the private network, by device, service and kind of
access, and `npx opscrew secure` reports them too:

```text
  Access: device laptop to PostgreSQL (db), read-only
```

## Revoke it

```bash
npx opscrew vpn revoke laptop db
```

removes the login (through a host plan you approve, or from the next deploy for Valkey, Redis and
Dragonfly, after `npx opscrew provision`) and the rule that lets the device reach the service. When no
device needs the service any more, it stops answering on the private network, unless the app needs
it there. Revoke a device's grants before you remove the device: `vpn remove` refuses while it
still has a login.

## What can go wrong

- **The connection times out:** check the tunnel (`npx opscrew vpn list`), and that the grant has
  taken effect (above). `npx opscrew status` warns when a service isn't on its private address yet,
  and says to run `npx opscrew provision`.
- **"permission denied" or `NOPERM`:** the login is read-only and the command writes. Use
  `--full` only if you really need to change data.
- **The password is lost:** it is in `generated_values.json` on the computer that granted access, and
  in the recovery copy. `vpn grant` run again there prints the connection details again, with the
  same password.
- **A device's name is already a login of the service** (such as `app` or `root`): add the device
  again under another name and grant that one.
