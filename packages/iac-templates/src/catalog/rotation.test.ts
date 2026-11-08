// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in expected values, not JavaScript templates.
import { spawnSync } from "node:child_process";
import {
  type DeployPlan,
  type SelfHostedServiceKind,
  SelfHostedServiceKindSchema,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { shWorks } from "../workflow/__fixtures__/sh";
import { GARAGE_STORAGE, withPlacement, withServices } from "./__fixtures__/plans";
import { appVariables, renderContext, SERVICE_SPECS, serviceSpec } from "./index";
import type { RotationCommand, RotationStep, SecretRotation, ServiceContext } from "./types";

/** The container's own copy of the app's current password, and of MySQL's and MariaDB's root's. */
const PASSWORD_FILE = "/tmp/opscrew-password";
const ROOT_FILE = "/tmp/opscrew-root-password";

/** A start's write of `file` from the env's `variable`, only when the container has none. */
const keep = (variable: string, file = PASSWORD_FILE) =>
  `{ [ -f ${file} ] || (umask 077 && printf %s "$${variable}" > ${file}); }`;

/** A rotation's rewrite of `file` with the new value. */
const newFile = (file = PASSWORD_FILE) =>
  `(umask 077 && printf %s "$OPSCREW_NEW" > ${file}.new) && mv -f ${file}.new ${file}`;

/** MySQL's or MariaDB's `client` as `user` over the socket, with the password `login`. */
const asUser = (client: string, user: string, login: string) =>
  `${client} --defaults-extra-file=<(printf '[client]\\npassword=%s\\n' ${login}) -u${user}`;
const asRoot = (client: string, login: string) => asUser(client, "root", login);

/** `change` unless `done` passes (its output dropped): run again, the step changes nothing. */
const unlessDone = (done: string, change: string) => `{ ${done} > /dev/null 2>&1 || ${change}; }`;

/** The context of the plan's first service, where no secret may be asked for. */
function strict(plan: DeployPlan, name = plan.services[0]?.name as string): ServiceContext {
  const service = plan.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return renderContext(plan, service);
}

/** The context of one service of `kind` (with `fields`) in an otherwise empty plan. */
function only(kind: SelfHostedServiceKind, fields: Record<string, unknown> = {}): ServiceContext {
  return strict(
    withServices([{ kind, ...fields }], kind === "garage" ? { storage: GARAGE_STORAGE } : {}),
  );
}

/** `kind`'s rotation of `secret`. */
function rotationOf(kind: SelfHostedServiceKind, secret: string): SecretRotation {
  const found = serviceSpec(kind).rotation.secrets.find((r) => r.secrets.includes(secret));
  if (found === undefined) throw new Error(`${kind} does not rotate ${secret}`);
  return found;
}

/** Whether `step` is a plain command, not a conditional one. */
function isCommand(step: RotationStep): step is RotationCommand {
  return Array.isArray(step);
}

/** The script of a step that is a shell command (`sh -c` or `bash -c`). */
function script(step: RotationStep | undefined): string {
  if (step === undefined || !isCommand(step)) throw new Error("not a command");
  expect(["sh", "bash"]).toContain(step[0]);
  expect(step[1]).toBe("-c");
  expect(step).toHaveLength(3);
  return step[2] ?? "";
}

/** Every command of `steps`, a conditional step's checks too. */
function commandsOf(steps: RotationStep[]): RotationCommand[] {
  return steps.flatMap((step) =>
    isCommand(step) ? [step] : [...(step.when ?? []), ...(step.unless ?? []), step.run],
  );
}

/** Every command of every recipe, for the checks every one must pass. */
function everyCommand(): { kind: string; command: RotationCommand }[] {
  const plan = withPlacement(
    withServices(
      [
        ...SelfHostedServiceKindSchema.options
          .filter((kind) => kind !== "kafka" && kind !== "redpanda")
          .map((kind) => ({ kind, name: kind })),
        { kind: "kafka", options: { login: true } },
        { kind: "redpanda", options: { login: true } },
      ],
      { storage: GARAGE_STORAGE },
    ),
    {
      devices: ["laptop"],
      grants: ["valkey", "redis", "dragonfly"].map((service) => ({
        device: "laptop",
        service,
        access: "full" as const,
      })),
    },
  );
  return plan.services.flatMap((service) => {
    const ctx = strict(plan, service.name);
    const { rotation } = serviceSpec(service.kind);
    return [
      ...rotation.secrets.flatMap((r) =>
        commandsOf([...r.begin(ctx), ...r.finish(ctx), ...(r.undo?.(ctx) ?? [])]),
      ),
      ...(rotation.grant === undefined
        ? []
        : [...rotation.grant.begin("laptop"), ...rotation.grant.finish("laptop")]),
    ].map((command) => ({ kind: service.kind, command }));
  });
}

describe("the catalog's rotation recipes", () => {
  it("rotate every generated secret of every kind, each in exactly one entry", () => {
    for (const spec of SERVICE_SPECS) {
      const names = spec.rotation.secrets.flatMap((r) => r.secrets);
      expect(names.toSorted(), spec.kind).toEqual(spec.secrets.map((s) => s.name).toSorted());
    }
  });

  it("rotate each secret as research R10 found it", () => {
    const modes = Object.fromEntries(
      SERVICE_SPECS.map((spec) => [
        spec.kind,
        Object.fromEntries(
          spec.rotation.secrets.map((r) => [
            r.secrets.join("+"),
            `${r.mode}${r.recreate ? " recreate" : ""}${r.closesConnections ? " closes" : ""}`,
          ]),
        ),
      ]),
    );
    expect(modes).toEqual({
      postgres: { password: "swap" },
      valkey: { password: "dual" },
      redis: { password: "dual" },
      dragonfly: { password: "dual" },
      mysql: { password: "dual", "root-password": "dual" },
      mariadb: { password: "swap", "root-password": "dual" },
      mongodb: { password: "swap" },
      rabbitmq: { password: "swap" },
      nats: { token: "swap closes" },
      kafka: { password: "swap" },
      redpanda: { password: "swap" },
      garage: { "key-id+secret-key": "dual recreate", "rpc-secret": "restart recreate" },
      opensearch: { password: "swap" },
      elasticsearch: { password: "swap" },
      meilisearch: { "master-key": "restart recreate" },
      typesense: { "api-key": "restart recreate" },
      clickhouse: { password: "swap" },
      neo4j: { password: "swap" },
    });
  });

  it("say how long a swap, a restart and a recreate take, and a restart runs nothing", () => {
    for (const spec of SERVICE_SPECS) {
      const ctx = strict(
        withServices(
          [{ kind: spec.kind }],
          spec.kind === "garage" ? { storage: GARAGE_STORAGE } : {},
        ),
      );
      for (const r of spec.rotation.secrets) {
        const where = `${spec.kind} ${r.secrets.join("+")}`;
        if (r.mode === "dual" && !r.recreate) expect(r.seconds, where).toBeUndefined();
        else expect(r.seconds, where).toBeGreaterThan(0);
        if (r.mode === "restart") {
          expect(r.recreate, where).toBe(true);
          expect(r.begin(ctx), where).toEqual([]);
          expect(r.finish(ctx), where).toEqual([]);
        }
        if (r.mode === "swap") expect(r.finish(ctx), where).toEqual([]);
      }
    }
  });

  it("put no value in any command, and read none from the container's env: only OPSCREW_OLD, OPSCREW_NEW and its files", () => {
    // A value would come from the context's secretRef, which throws here (renderContext).
    const commands = everyCommand();
    expect(commands).toHaveLength(43);
    for (const { kind, command } of commands) {
      const text = command.join(" ");
      for (const [, name] of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        expect(["OPSCREW_OLD", "OPSCREW_NEW", "h"], `${kind}: ${name}`).toContain(name);
      }
    }
  });

  it("read no value from the container's env in a health check: a rotation would make it stale", () => {
    const plan = withServices(
      [
        ...SelfHostedServiceKindSchema.options
          .filter((kind) => kind !== "kafka" && kind !== "redpanda")
          .map((kind) => ({ kind, name: kind })),
        { kind: "kafka", options: { login: true } },
        { kind: "redpanda", options: { login: true } },
      ],
      { storage: GARAGE_STORAGE },
    );
    for (const service of plan.services) {
      const spec = serviceSpec(service.kind);
      const ctx = { ...strict(plan, service.name), secretRef: () => "<value>" };
      const holders = Object.entries(spec.environment(ctx))
        .filter(([, value]) => value.includes("<value>"))
        .map(([name]) => name);
      const check = spec.healthcheck(ctx).test.join(" ");
      for (const name of holders) expect(check, service.kind).not.toContain(`$${name}`);
    }
  });

  it.skipIf(!shWorks())("are commands every shell parses", () => {
    // One script per line, checked at once on stdin (too long for one argument on Windows): a
    // failure names its line.
    const scripts = everyCommand()
      .filter(({ command }) => command[0] === "sh" || command[0] === "bash")
      .map(({ command }) => command[2] ?? "");
    expect(scripts).toHaveLength(33);
    const parsed = spawnSync("bash", ["-n"], {
      input: `${scripts.join("\n")}\n`,
      encoding: "utf8",
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });
});

describe("the databases' recipes", () => {
  it("PostgreSQL: the app's own role over the container's socket, the statement on stdin", () => {
    const r = rotationOf("postgres", "password");
    expect(r.recreate).toBe(false);
    const [begin, ...more] = r.begin(only("postgres"));
    expect(more).toEqual([]);
    expect(script(begin)).toBe(
      `printf "ALTER ROLE app PASSWORD '%s';\\n" "$OPSCREW_NEW" | psql -X -q -v ON_ERROR_STOP=1 -U app -d app`,
    );
  });

  it("MySQL and MariaDB: root's password in a file of the container, from the env at its first start", () => {
    for (const [kind, variable, server] of [
      ["mysql", "MYSQL_ROOT_PASSWORD", "mysqld"],
      ["mariadb", "MARIADB_ROOT_PASSWORD", "mariadbd"],
    ] as const) {
      expect(serviceSpec(kind).command?.(only(kind)), kind).toEqual([
        "sh",
        "-c",
        `{ [ -f ${ROOT_FILE} ] || (umask 077 && printf %s "$${variable}" > ${ROOT_FILE}); } && exec docker-entrypoint.sh ${server}`,
      ]);
    }
  });

  it("MySQL: as root on stdin, the app's password retained then discarded, and retained once", () => {
    const ctx = only("mysql");
    const app = rotationOf("mysql", "password");
    const root = asRoot("mysql", `"$(cat ${ROOT_FILE})"`);
    // Run again once the new password logs in, `RETAIN CURRENT PASSWORD` would keep the new one
    // and drop the old: the check skips it.
    expect(app.begin(ctx).map(script)).toEqual([
      unlessDone(
        `${asUser("mysql", "app", '"$OPSCREW_NEW"')} -e 'SELECT 1'`,
        `printf "ALTER USER 'app'@'%%' IDENTIFIED BY '%s' RETAIN CURRENT PASSWORD;\\n" "$OPSCREW_NEW" | ${root}`,
      ),
    ]);
    expect(app.finish(ctx).map(script)).toEqual([
      `printf "ALTER USER 'app'@'%%' DISCARD OLD PASSWORD;\\n" | ${root}`,
    ]);
    expect(app.begin(ctx)[0]).toEqual(["bash", "-c", expect.any(String)]);
  });

  it("MySQL: root's two accounts, logged in with the old password (unless the new one does), then the new", () => {
    const ctx = only("mysql");
    const root = rotationOf("mysql", "root-password");
    expect(root.begin(ctx).map(script)).toEqual([
      unlessDone(
        `${asRoot("mysql", '"$OPSCREW_NEW"')} -e 'SELECT 1'`,
        `printf "ALTER USER 'root'@'localhost' IDENTIFIED BY '%s' RETAIN CURRENT PASSWORD; ALTER USER 'root'@'%%' IDENTIFIED BY '%s' RETAIN CURRENT PASSWORD;\\n" "$OPSCREW_NEW" "$OPSCREW_NEW" | ${asRoot("mysql", '"$OPSCREW_OLD"')}`,
      ),
      newFile(ROOT_FILE),
    ]);
    expect(root.finish(ctx).map(script)).toEqual([
      `printf "ALTER USER 'root'@'localhost' DISCARD OLD PASSWORD; ALTER USER 'root'@'%%' DISCARD OLD PASSWORD;\\n" | ${asRoot("mysql", '"$OPSCREW_NEW"')}`,
    ]);
  });

  it("MySQL: undone by their own commands, the old password the only one again, safe to run again", () => {
    const ctx = only("mysql");
    const asFile = asRoot("mysql", `"$(cat ${ROOT_FILE})"`);
    // Swapped, `begin` would skip (the old password logs in, retained) and `finish` discard it.
    expect(rotationOf("mysql", "password").undo?.(ctx).map(script)).toEqual([
      `printf "ALTER USER 'app'@'%%' IDENTIFIED BY '%s'; ALTER USER 'app'@'%%' DISCARD OLD PASSWORD;\\n" "$OPSCREW_OLD" | ${asFile}`,
    ]);
    // Root's file first, then its change logged in with the old password, which logs in before
    // `finish` wherever the rotation stopped and also run again (the file's would not, once the
    // change ran and the file still held the new one).
    expect(rotationOf("mysql", "root-password").undo?.(ctx).map(script)).toEqual([
      `(umask 077 && printf %s "$OPSCREW_OLD" > ${ROOT_FILE}.new) && mv -f ${ROOT_FILE}.new ${ROOT_FILE}`,
      `printf "ALTER USER 'root'@'localhost' IDENTIFIED BY '%s'; ALTER USER 'root'@'%%' IDENTIFIED BY '%s'; ALTER USER 'root'@'localhost' DISCARD OLD PASSWORD; ALTER USER 'root'@'%%' DISCARD OLD PASSWORD;\\n" "$OPSCREW_OLD" "$OPSCREW_OLD" | ${asRoot("mysql", '"$OPSCREW_OLD"')}`,
    ]);
  });

  it("MariaDB: as root on stdin with no RETAIN (a syntax error there), root's two accounts", () => {
    const ctx = only("mariadb");
    // Setting the password it has already changes nothing: no check needed.
    expect(rotationOf("mariadb", "password").begin(ctx).map(script)).toEqual([
      `printf "ALTER USER 'app'@'%%' IDENTIFIED BY '%s';\\n" "$OPSCREW_NEW" | ${asRoot("mariadb", `"$(cat ${ROOT_FILE})"`)}`,
    ]);
    const root = rotationOf("mariadb", "root-password");
    expect(root.begin(ctx).map(script)).toEqual([
      unlessDone(
        `${asRoot("mariadb", '"$OPSCREW_NEW"')} -e 'SELECT 1'`,
        `printf "ALTER USER 'root'@'localhost' IDENTIFIED BY '%s'; ALTER USER 'root'@'%%' IDENTIFIED BY '%s';\\n" "$OPSCREW_NEW" "$OPSCREW_NEW" | ${asRoot("mariadb", '"$OPSCREW_OLD"')}`,
      ),
      newFile(ROOT_FILE),
    ]);
    expect(root.finish(ctx)).toEqual([]);
    for (const command of [...root.begin(ctx), ...rotationOf("mariadb", "password").begin(ctx)]) {
      expect(JSON.stringify(command)).not.toContain("RETAIN");
    }
  });

  it("MongoDB: the root password's file from the env at the first start, which the setup steps read", () => {
    const mongodb = serviceSpec("mongodb");
    const plain = only("mongodb");
    expect(mongodb.command?.(plain)).toEqual([
      "bash",
      "-c",
      `set -e; ${keep("MONGO_INITDB_ROOT_PASSWORD")}; exec docker-entrypoint.sh mongod --wiredTigerCacheSizeGB 0.25 --bind_ip_all`,
    ]);
    const set = only("mongodb", { options: { replicaSet: true } });
    expect(mongodb.command?.(set)?.[2]).toMatch(
      new RegExp(
        `^set -e; ${literally(keep("MONGO_INITDB_ROOT_PASSWORD"))}; \\[ -f /data/configdb/keyfile \\] \\|\\| `,
      ),
    );
    const [step] = mongodb.init?.(set) ?? [];
    for (const command of [step?.check, step?.run]) {
      expect(command?.[2]).toMatch(
        /^mongosh --quiet -u "\$MONGO_INITDB_ROOT_USERNAME" -p "\$\(cat \/tmp\/opscrew-password\)" --authenticationDatabase admin --eval /,
      );
    }
  });

  it("MongoDB: changeUserPassword in admin as its root user (unless the new one logs in), the new value from the env", () => {
    const login = (value: string) =>
      `mongosh --quiet -u app -p "${value}" --authenticationDatabase admin admin`;
    expect(rotationOf("mongodb", "password").begin(only("mongodb")).map(script)).toEqual([
      `${unlessDone(`${login("$OPSCREW_NEW")} --eval 'db.runCommand({ ping: 1 }).ok'`, `${login("$OPSCREW_OLD")} --eval 'db.changeUserPassword("app", process.env.OPSCREW_NEW)'`)} && ${newFile()}`,
    ]);
  });

  it("Neo4j: ALTER USER in system through cypher-shell, the statement on stdin, unless the new one logs in", () => {
    const shell = (value: string) => `cypher-shell -u neo4j -p "${value}" -d system --format plain`;
    expect(rotationOf("neo4j", "password").begin(only("neo4j")).map(script)).toEqual([
      unlessDone(
        `printf 'RETURN 1;\\n' | ${shell("$OPSCREW_NEW")}`,
        `printf "ALTER USER neo4j SET PASSWORD '%s' CHANGE NOT REQUIRED;\\n" "$OPSCREW_NEW" | ${shell("$OPSCREW_OLD")}`,
      ),
    ]);
  });

  it("ClickHouse: the app's user in a users.d file of its own, rewritten while it runs", () => {
    const clickhouse = serviceSpec("clickhouse");
    const ctx = only("clickhouse");
    const file = "/etc/clickhouse-server/users.d/opscrew-app.xml";
    const write = (variable: string, to: string) =>
      `(umask 077 && h=$(printf %s "$${variable}" | sha256sum | cut -d " " -f 1) && printf '<clickhouse><users><default remove="remove"></default><app><profile>default</profile><networks><ip>::/0</ip></networks><password_sha256_hex>%s</password_sha256_hex><quota>default</quota><access_management>0</access_management></app></users></clickhouse>\\n' "$h" > ${to} && chown clickhouse:clickhouse ${to})`;
    // The container writes it from its env at its first start only, and the image's entrypoint
    // then leaves the users alone (it would write the app's user from the env at every start).
    expect(clickhouse.command?.(ctx)).toEqual([
      "bash",
      "-c",
      `[ -f ${file} ] || ${write("CLICKHOUSE_PASSWORD", file)} && CLICKHOUSE_SKIP_USER_SETUP=1 exec /entrypoint.sh`,
    ]);
    expect(clickhouse.entrypoint).toBeUndefined();
    // Its env and the app's address stay as they were.
    const named = { ...ctx, secretRef: (name: string) => `<${name}>` };
    expect(clickhouse.environment(named)).toEqual({
      CLICKHOUSE_DB: "app",
      CLICKHOUSE_USER: "app",
      CLICKHOUSE_PASSWORD: "<password>",
    });
    expect(appVariables(named)).toEqual({
      CLICKHOUSE_URL: "http://app:<password>@clickhouse:8123/app",
      CLICKHOUSE_USER: "app",
      CLICKHOUSE_PASSWORD: "<password>",
    });
    // The mounted users.d file keeps only the low-memory profile.
    const [, users] = clickhouse.configFiles?.(ctx) ?? [];
    expect(users?.target).toBe("/etc/clickhouse-server/users.d/opscrew.xml");
    expect(users?.content).not.toContain("<app>");
    const r = rotationOf("clickhouse", "password");
    expect(r.recreate).toBe(false);
    expect(r.begin(ctx).map(script)).toEqual([
      `${write("OPSCREW_NEW", `${file}.tmp`)} && mv -f ${file}.tmp ${file} && for i in $(seq 40); do CLICKHOUSE_PASSWORD="$OPSCREW_NEW" clickhouse-client -u app -q 'SELECT 1' > /dev/null 2>&1 && exit 0; sleep 0.25; done; exit 1`,
    ]);
  });
});

describe("the caches', brokers' and object storage's recipes", () => {
  it("Valkey, Redis and Dragonfly: the ACL file and the password's file from the env at the first start only, read by the health check", () => {
    for (const [kind, variable, start] of [
      ["valkey", "VALKEY_PASSWORD", "exec docker-entrypoint.sh valkey-server --aclfile"],
      ["redis", "REDIS_PASSWORD", "exec docker-entrypoint.sh redis-server --aclfile"],
      ["dragonfly", "DFLY_requirepass", "unset DFLY_requirepass && exec entrypoint.sh dragonfly"],
    ] as const) {
      const spec = serviceSpec(kind);
      const ctx = only(kind);
      const [shell, flag, wrapper] = spec.command?.(ctx) ?? [];
      expect([shell, flag], kind).toEqual(["sh", "-c"]);
      expect(wrapper, kind).toMatch(
        new RegExp(
          `^umask 077 && \\{ \\[ -f /tmp/opscrew-users\\.acl \\] \\|\\| \\{ .* \\} > /tmp/opscrew-users\\.acl && chown \\w+:\\w+ /tmp/opscrew-users\\.acl; \\}; \\} && ${literally(keep(variable))} && ${literally(start)} `,
        ),
      );
      // The server never sees the env's password but through its ACL file.
      expect(wrapper, kind).not.toContain("'requirepass");
      expect(spec.healthcheck(ctx).test, kind).toEqual([
        "CMD-SHELL",
        `REDISCLI_AUTH="$(cat ${PASSWORD_FILE})" ${kind === "valkey" ? "valkey-cli" : "redis-cli"} ping | grep -q PONG`,
      ]);
    }
  });

  it("Valkey, Redis and Dragonfly: the new password beside the old (unless it logs in), then the old dropped (unless it no longer does), each saved", () => {
    for (const [kind, cli] of [
      ["valkey", "valkey-cli"],
      ["redis", "redis-cli"],
      ["dragonfly", "redis-cli"],
    ] as const) {
      const ctx = only(kind);
      const r = rotationOf(kind, "password");
      const logsIn = (value: string) =>
        `[ "$(printf 'AUTH %s %s\\n' default "${value}" | ${cli})" = OK ]`;
      expect(r.begin(ctx).map(script), kind).toEqual([
        `${unlessDone(logsIn("$OPSCREW_NEW"), `[ "$(printf 'ACL SETUSER default >%s\\nACL SAVE\\n' "$OPSCREW_NEW" | REDISCLI_AUTH="$OPSCREW_OLD" ${cli} | grep -cx OK)" = 2 ]`)} && ${newFile()}`,
      ]);
      expect(r.finish(ctx).map(script), kind).toEqual([
        unlessDone(
          `! ${logsIn("$OPSCREW_OLD")}`,
          `[ "$(printf 'ACL SETUSER default <%s\\nACL SAVE\\n' "$OPSCREW_OLD" | REDISCLI_AUTH="$OPSCREW_NEW" ${cli} | grep -cx OK)" = 2 ]`,
        ),
      ]);
    }
  });

  it("Valkey, Redis and Dragonfly: a device's login, as the app's user with its current password", () => {
    for (const [kind, cli] of [
      ["valkey", "valkey-cli"],
      ["redis", "redis-cli"],
      ["dragonfly", "redis-cli"],
    ] as const) {
      const grant = serviceSpec(kind).rotation.grant;
      const login = `REDISCLI_AUTH="$(cat ${PASSWORD_FILE})"`;
      // Adding a password it holds already changes nothing; its old one is dropped only while it
      // still logs in.
      expect(grant?.begin("laptop").map(script), kind).toEqual([
        `[ "$(printf 'ACL SETUSER laptop >%s\\nACL SAVE\\n' "$OPSCREW_NEW" | ${login} ${cli} | grep -cx OK)" = 2 ]`,
      ]);
      expect(grant?.finish("laptop").map(script), kind).toEqual([
        unlessDone(
          `! [ "$(printf 'AUTH %s %s\\n' laptop "$OPSCREW_OLD" | ${cli})" = OK ]`,
          `[ "$(printf 'ACL SETUSER laptop <%s\\nACL SAVE\\n' "$OPSCREW_OLD" | ${login} ${cli} | grep -cx OK)" = 2 ]`,
        ),
      ]);
      // A device's name goes into the command, so only a valid one does.
      expect(() => grant?.begin("x' y")).toThrow();
    }
    for (const spec of SERVICE_SPECS) {
      if (!["valkey", "redis", "dragonfly"].includes(spec.kind)) {
        expect(spec.rotation.grant, spec.kind).toBeUndefined();
      }
    }
  });

  it("RabbitMQ: rabbitmqctl change_password", () => {
    expect(rotationOf("rabbitmq", "password").begin(only("rabbitmq")).map(script)).toEqual([
      'rabbitmqctl change_password app "$OPSCREW_NEW"',
    ]);
  });

  it("NATS: the token in an included file the container writes, rewritten and reloaded", () => {
    const nats = serviceSpec("nats");
    const ctx = only("nats");
    const file = "/etc/nats/opscrew-token.conf";
    const [conf] = nats.configFiles?.(ctx) ?? [];
    // The included file defines NATS_TOKEN, which wins over the env's of the same name.
    expect(conf?.content).toMatch(
      /\ninclude \.\/opscrew-token\.conf\nauthorization \{\n {2}token: \$NATS_TOKEN\n\}\n/,
    );
    expect(nats.command?.(ctx)).toEqual([
      "sh",
      "-c",
      `[ -f ${file} ] || (umask 077 && printf 'NATS_TOKEN: "%s"\\n' "$NATS_TOKEN" > ${file}) && exec nats-server --config /etc/nats/nats-server.conf`,
    ]);
    expect(nats.environment({ ...ctx, secretRef: (name) => `<${name}>` })).toEqual({
      NATS_TOKEN: "<token>",
    });
    const r = rotationOf("nats", "token");
    expect(r.closesConnections).toBe(true);
    expect(r.recreate).toBe(false);
    expect(r.begin(ctx).map(script)).toEqual([
      `(umask 077 && printf 'NATS_TOKEN: "%s"\\n' "$OPSCREW_NEW" > ${file}.new) && mv -f ${file}.new ${file} && nats-server --signal reload=1`,
    ]);
  });

  it("Kafka and Redpanda: the login's password in a file of the container, which the start and rpk read", () => {
    const configs =
      "KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9094";
    const kafka = only("kafka", { options: { login: true } });
    expect(serviceSpec("kafka").command?.(kafka)).toEqual([
      "sh",
      "-c",
      `${keep("SASL_PASSWORD")}; (until ${configs} --alter --add-config "SCRAM-SHA-512=[password=$(cat ${PASSWORD_FILE})]" --entity-type users --entity-name app; do sleep 2; done) & exec /etc/kafka/docker/run`,
    ]);
    const redpanda = only("redpanda", { options: { login: true } });
    const [start] = serviceSpec("redpanda").command?.(redpanda) ?? [];
    expect(start).toMatch(
      new RegExp(
        `^${literally(`${keep("RPK_PASS")}; export RPK_PASS="$(cat ${PASSWORD_FILE})"; login() { { rpk security user create app -p "$RPK_PASS"`)}`,
      ),
    );
    expect(serviceSpec("redpanda").healthcheck(redpanda).test[1]).toContain(
      `RPK_PASS="$(cat ${PASSWORD_FILE})" rpk cluster config get admin_api_require_auth`,
    );
  });

  it("Kafka and Redpanda: their tools with the login, nothing without it", () => {
    const kafka = rotationOf("kafka", "password");
    expect(kafka.begin(only("kafka", { options: { login: true } })).map(script)).toEqual([
      `KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9094 --alter --add-config "SCRAM-SHA-512=[password=$OPSCREW_NEW]" --entity-type users --entity-name app && ${newFile()}`,
    ]);
    const redpanda = rotationOf("redpanda", "password");
    expect(redpanda.recreate).toBe(false);
    // Kafka's sets the password on the loopback listener, which asks for no login: run again, it
    // sets the same. Redpanda's logs in with the old one, unless the new one does already.
    expect(redpanda.begin(only("redpanda", { options: { login: true } })).map(script)).toEqual([
      `${unlessDone('RPK_PASS="$OPSCREW_NEW" rpk security user list', 'RPK_PASS="$OPSCREW_OLD" rpk security user update app --new-password "$OPSCREW_NEW" --mechanism SCRAM-SHA-512')} && ${newFile()}`,
    ]);
    for (const kind of ["kafka", "redpanda"] as const) {
      const r = rotationOf(kind, "password");
      expect(r.begin(only(kind)), kind).toEqual([]);
      expect(r.finish(only(kind)), kind).toEqual([]);
    }
  });

  it("Garage: the old key renamed, the new one made by its start from the env, the old deleted", () => {
    const ctx = only("garage");
    const key = rotationOf("garage", "key-id");
    expect(key.secrets).toEqual(["key-id", "secret-key"]);
    const info = (name: string) => ["/garage", "key", "info", name];
    // Its image has no shell: the key is named, never given, and each step checks the names first.
    // The rename only while no key has the old one's new name (run again after the recreate, it
    // would rename the new key).
    expect(key.begin(ctx)).toEqual([
      {
        unless: [info("opscrew-previous")],
        run: ["/garage", "key", "rename", "default access key", "opscrew-previous"],
      },
    ]);
    // The old key goes only while the start made a new one: a start from an env still naming the
    // old key makes none, and Garage would refuse to start without its key.
    expect(key.finish(ctx)).toEqual([
      {
        when: [info("opscrew-previous"), info("default access key")],
        run: ["/garage", "key", "delete", "--yes", "opscrew-previous"],
      },
    ]);
    expect(rotationOf("garage", "rpc-secret").mode).toBe("restart");
  });

  it("Garage: its key's own undo, wherever the rotation stopped, never deleting the key in use", () => {
    const key = rotationOf("garage", "key-id");
    const info = (name: string) => ["/garage", "key", "info", name];
    // Only once the old key is renamed: the new key deleted if the start made it, the name back.
    expect(key.undo?.(only("garage"))).toEqual([
      {
        when: [info("opscrew-previous"), info("default access key")],
        run: ["/garage", "key", "delete", "--yes", "default access key"],
      },
      {
        when: [info("opscrew-previous")],
        run: ["/garage", "key", "rename", "opscrew-previous", "default access key"],
      },
    ]);
    // Every other secret but MySQL's (their own undo, in the MySQL tests) is undone by its own
    // begin and finish with the two values swapped.
    const own = [key, rotationOf("mysql", "password"), rotationOf("mysql", "root-password")];
    for (const spec of SERVICE_SPECS) {
      for (const r of spec.rotation.secrets) {
        if (!own.includes(r)) {
          expect(r.undo, `${spec.kind} ${r.secrets.join("+")}`).toBeUndefined();
        }
      }
    }
  });

  it("Garage: refuses its key where the app makes its own buckets, which a new key can't reach", () => {
    const ctx = strict(withServices([{ kind: "garage" }]));
    expect(() => rotationOf("garage", "key-id").begin(ctx)).toThrow(
      /makes its own buckets with that key/,
    );
    expect(rotationOf("garage", "rpc-secret").begin(ctx)).toEqual([]);
  });
});

describe("the search engines' recipes", () => {
  it("OpenSearch and Elasticsearch: the password's file from the env at the first start, read by the health check", () => {
    const health = (user: string) => [
      "CMD-SHELL",
      `printf 'user = "${user}:%s"\\n' "$(cat ${PASSWORD_FILE})" | curl -fsS -K - 'localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s' > /dev/null`,
    ];
    const opensearch = serviceSpec("opensearch");
    expect(opensearch.healthcheck(only("opensearch")).test).toEqual(health("admin"));
    const [, , script] = opensearch.command?.(only("opensearch")) ?? [];
    expect(script).toContain(
      `; ${keep("OPENSEARCH_PASSWORD")}; h=$(OPENSEARCH_PASSWORD="$(cat ${PASSWORD_FILE})" plugins/opensearch-security/tools/hash.sh -env OPENSEARCH_PASSWORD); `,
    );
    const elasticsearch = serviceSpec("elasticsearch");
    expect(elasticsearch.healthcheck(only("elasticsearch")).test).toEqual(health("elastic"));
    expect(elasticsearch.command?.(only("elasticsearch"))).toEqual([
      "sh",
      "-c",
      `${keep("ELASTIC_PASSWORD")} && exec /usr/local/bin/docker-entrypoint.sh eswrapper`,
    ]);
  });

  /**
   * curl logged in as `user` with `value`, from a config on a pipe, waiting out a passing 503
   * (Elasticsearch's security index made at the first change).
   */
  const curlAs = (user: string, value: string) =>
    `curl -fsS --retry 5 --retry-delay 2 -o /dev/null --config <(printf 'user = "${user}:%s"\\n' "${value}")`;

  it("OpenSearch: the account API as admin (unless the new password logs in), the login and body never on a command line", () => {
    expect(rotationOf("opensearch", "password").begin(only("opensearch")).map(script)).toEqual([
      `${unlessDone(`${curlAs("admin", "$OPSCREW_NEW")} http://localhost:9200/`, `printf '{"current_password":"%s","password":"%s"}' "$OPSCREW_OLD" "$OPSCREW_NEW" | ${curlAs("admin", "$OPSCREW_OLD")} -X PUT -H 'Content-Type: application/json' --data-binary @- http://localhost:9200/_plugins/_security/api/account`)} && ${newFile()}`,
    ]);
  });

  it("Elasticsearch: the _password API as elastic (unless the new password logs in)", () => {
    expect(
      rotationOf("elasticsearch", "password").begin(only("elasticsearch")).map(script),
    ).toEqual([
      `${unlessDone(`${curlAs("elastic", "$OPSCREW_NEW")} http://localhost:9200/`, `printf '{"password":"%s"}' "$OPSCREW_NEW" | ${curlAs("elastic", "$OPSCREW_OLD")} -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:9200/_security/user/elastic/_password`)} && ${newFile()}`,
    ]);
  });
});

/** `text` as a regular expression that matches it literally. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}
