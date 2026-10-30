/**
 * A device's own login to a database (the `grant` step, ADR 0022): the fixed statements of
 * research R6a, run through `docker compose -p <app> exec -T <service> <client>` as the deploy
 * user. The engine's own administrator signs in from the container's environment (Postgres's
 * `app` over the container's trusted socket; MySQL's and MariaDB's root through an option file
 * on a pipe; MongoDB's root user from `process.env`), so no administrator password is on a
 * command line or passes through OpsCrew. The login's password arrives on the step's standard
 * input and reaches the client inside the container on its standard input, in the statements.
 *
 * Every statement here is fixed text around the validated login name; the password goes between a
 * statement's two halves, so it is never part of a plan or a script.
 */
import { z } from "zod";
import { ServiceNameSchema } from "./types";

/** The databases whose device logins a host step makes (the Redis-protocol kinds declare theirs). */
export const GRANT_KINDS = ["postgres", "mysql", "mariadb", "mongodb"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];
export type GrantAccess = "read-only" | "full";

/** Logins the engines or OpsCrew already use, never a device's: removing one would break the app. */
const RESERVED_LOGINS = new Set(["app", "root", "postgres", "admin", "healthcheck", "mysql"]);

/**
 * The `grant` step's parameters (contracts/split-placement.md "ssh-host"): the service, its kind,
 * the device's login, its access, and whether the login goes. The passwords are never among
 * them.
 */
export const GrantParamsSchema = z.strictObject({
  service: ServiceNameSchema,
  kind: z.enum(GRANT_KINDS),
  login: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, {
      message: "must be lower-case letters, digits, dashes and underscores, at most 32",
    })
    .refine((login) => !RESERVED_LOGINS.has(login), {
      message: "must not be a login the database or the app already uses",
    }),
  access: z.enum(["read-only", "full"]),
  remove: z.boolean(),
});
export type GrantParams = z.infer<typeof GrantParamsSchema>;

/** What the step sends each kind's client: fixed statements around the login's name. */
export interface GrantEngine {
  title: string;
  /** The client, after `docker compose -p "$PROJECT" exec -T "$SERVICE"`; it reads stdin. */
  client: string;
  /** For MySQL and MariaDB: the bash line that signs in as root from the container's environment. */
  rootClient?: string;
  /** Sent first to every client call (MongoDB's sign-in as root, Postgres's quiet warnings). */
  prelude: string;
  /** Prints `opscrew-read`, then `opscrew-login=<state>` when the login exists. */
  state: string;
  /** The state each access gives. */
  want: string;
  /** The statement that makes the login, in two halves around its password. */
  create: [string, string];
  /** The statement that sets an existing login's password, in two halves around it. */
  update: [string, string];
  /** The statements that give the login its access (after it is made or updated). */
  access: string;
  /** The statements that remove the login. */
  drop: string;
}

/** MySQL's and MariaDB's database-level privileges, in the order the state lists them. */
const MYSQL_PRIVILEGES = [
  "Select",
  "Insert",
  "Update",
  "Delete",
  "Create",
  "Drop",
  "References",
  "Index",
  "Alter",
  "Create_tmp_table",
  "Lock_tables",
  "Create_view",
  "Show_view",
  "Create_routine",
  "Alter_routine",
  "Execute",
  "Event",
  "Trigger",
] as const;

function postgres(login: string, access: GrantAccess): GrantEngine {
  const role = `"${login}"`;
  const name = `'${login}'`;
  const member = (of: string) => `pg_has_role(r.oid, '${of}', 'MEMBER')`;
  return {
    title: "PostgreSQL",
    // The image trusts its own socket, where `app` (the superuser) signs in without a password.
    client: "psql -X -q -t -A -v ON_ERROR_STOP=1 -U app -d app",
    prelude: "SET client_min_messages = error;",
    // Full access is all the data, never `app`'s superuser rights (they reach the server itself).
    state: `SELECT 'opscrew-read'; SELECT 'opscrew-login=' || CASE WHEN NOT r.rolcanlogin OR r.rolsuper OR ${member("app")} OR NOT ${member("pg_read_all_data")} THEN 'other' WHEN ${member("pg_write_all_data")} THEN 'full' ELSE 'read-only' END FROM pg_roles r WHERE r.rolname = ${name};`,
    want: access,
    create: [`CREATE ROLE ${role} WITH LOGIN PASSWORD '`, "';"],
    update: [`ALTER ROLE ${role} WITH LOGIN PASSWORD '`, "';"],
    access:
      access === "read-only"
        ? `REVOKE pg_write_all_data FROM ${role}; GRANT pg_read_all_data TO ${role};`
        : `GRANT pg_read_all_data, pg_write_all_data TO ${role};`,
    drop: `REASSIGN OWNED BY ${role} TO app; DROP OWNED BY ${role}; DROP ROLE ${role};`,
  };
}

function mysql(kind: "mysql" | "mariadb", login: string, access: GrantAccess): GrantEngine {
  const user = `'${login}'@'%'`;
  const binary = kind === "mysql" ? "mysql" : "mariadb";
  const rootPassword = kind === "mysql" ? "MYSQL_ROOT_PASSWORD" : "MARIADB_ROOT_PASSWORD";
  const privileges = MYSQL_PRIVILEGES.map((name) => `d.${name}_priv`).join(", ");
  // A grant on app.* first, so the revoke always has one to take back.
  const reset = `GRANT SELECT ON app.* TO ${user}; REVOKE ALL PRIVILEGES ON app.* FROM ${user};`;
  return {
    title: kind === "mysql" ? "MySQL" : "MariaDB",
    client: 'bash -c "$ROOT_CLIENT"',
    // The root password goes from the container's environment into an option file on a pipe.
    rootClient: `${binary} --defaults-extra-file=<(printf '[client]\\nuser=root\\npassword=%s\\n' "$${rootPassword}") -N -B`,
    prelude: "",
    state: `SELECT 'opscrew-read'; SELECT CONCAT('opscrew-login=', IFNULL(CONCAT(${privileges}), 'none')) FROM mysql.user u LEFT JOIN mysql.db d ON d.User = u.User AND d.Host = u.Host AND d.Db = 'app' WHERE u.User = '${login}' AND u.Host = '%';`,
    want: MYSQL_PRIVILEGES.map((name) =>
      access === "full" || name === "Select" || name === "Show_view" ? "Y" : "N",
    ).join(""),
    create: [`CREATE USER ${user} IDENTIFIED BY '`, "';"],
    update: [`ALTER USER ${user} IDENTIFIED BY '`, "';"],
    access:
      access === "read-only"
        ? `${reset} GRANT SELECT, SHOW VIEW ON app.* TO ${user};`
        : `${reset} GRANT ALL PRIVILEGES ON app.* TO ${user};`,
    drop: `DROP USER IF EXISTS ${user};`,
  };
}

function mongodb(login: string, access: GrantAccess): GrantEngine {
  const roles =
    access === "read-only"
      ? '[{ role: "read", db: "app" }]'
      : '[{ role: "readWrite", db: "app" }, { role: "dbAdmin", db: "app" }]';
  return {
    title: "MongoDB",
    client: "mongosh --quiet --norc",
    prelude:
      'const a = db.getSiblingDB("admin"); a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);',
    // The markers are built when the script runs, so a source line mongosh echoes never matches.
    state: `const u = a.getUser("${login}"); print("opscrew-" + "read"); if (u !== null) print("opscrew-" + "login=" + (u.roles.map((r) => r.db + "." + r.role).sort().join(",") || "none"));`,
    want: access === "read-only" ? "app.read" : "app.dbAdmin,app.readWrite",
    create: [`a.createUser({ user: "${login}", pwd: "`, `", roles: ${roles} });`],
    update: [`a.updateUser("${login}", { pwd: "`, `", roles: ${roles} });`],
    access: "",
    drop: `a.dropUser("${login}");`,
  };
}

/** The statements of `params`' kind for its login and access. */
export function grantEngine(params: GrantParams): GrantEngine {
  switch (params.kind) {
    case "postgres":
      return postgres(params.login, params.access);
    case "mysql":
    case "mariadb":
      return mysql(params.kind, params.login, params.access);
    case "mongodb":
      return mongodb(params.login, params.access);
  }
}
