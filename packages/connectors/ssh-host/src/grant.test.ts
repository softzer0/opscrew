import { canonicalJson } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  provision,
  SH_AVAILABLE,
  shSyntax,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { HostApplyError } from "./apply";
import { GRANT_KINDS, type GrantParams, GrantParamsSchema, grantEngine } from "./grant";
import { inspectHost } from "./inspect";
import { planGrant } from "./plan";
import { dockerRootCommand } from "./privilege";
import { asDeployUser, asRoot, pipedScript } from "./shell";
import { stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;
const COMMAND = "opscrew vpn grant";

/** A login's password, made at runtime (never committed): 32 hex digits. */
function password(seed = "laptop"): string {
  return fakeSecret("namecheap-api-key", `grant-${seed}`);
}

function grant(overrides: Partial<GrantParams> = {}): GrantParams {
  return {
    service: "db",
    kind: "postgres",
    login: "laptop",
    access: "read-only",
    remove: false,
    ...overrides,
  };
}

function scriptsOf(params: GrantParams) {
  const step: HostStep = { id: "grant", title: "Grant", state: "change", scope: "app", params };
  const plan: HostPlan = {
    schemaVersion: 1,
    purpose: "setup",
    app: "shop",
    steps: [step],
    findings: [],
  };
  return stepScripts(plan, step);
}

describe("the grant step's parameters", () => {
  it("refuse a login the database or the app already uses, a bad name, kind or service", () => {
    for (const params of [
      grant({ login: "app" }),
      grant({ login: "root" }),
      grant({ login: "postgres" }),
      grant({ login: "Laptop" }),
      grant({ login: "lap'top" }),
      grant({ login: "a".repeat(33) }),
      { ...grant(), kind: "valkey" },
      grant({ service: "db;rm" }),
    ]) {
      expect(GrantParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false);
    }
    expect(GrantParamsSchema.safeParse(grant({ login: "work-laptop_2" })).success).toBe(true);
  });
});

// Each statement runs through a real shell, slow on Windows under a parallel test run.
describe("the grant step's statements (research R6a)", { timeout: 120_000 }, () => {
  it("make a read-only and a full login for each kind, and remove it", () => {
    const pg = grantEngine(grant());
    expect(pg.create).toEqual([`CREATE ROLE "laptop" WITH LOGIN PASSWORD '`, "';"]);
    expect(pg.access).toBe(
      `REVOKE pg_write_all_data FROM "laptop"; GRANT pg_read_all_data TO "laptop";`,
    );
    // Full access is all the data, never the app's login: `app` is the superuser.
    const pgFull = grantEngine(grant({ access: "full" }));
    expect(pgFull.access).toBe(`GRANT pg_read_all_data, pg_write_all_data TO "laptop";`);
    expect(`${pgFull.access} ${pgFull.state}`).not.toMatch(/GRANT app|SET role/);
    expect(pgFull.state).toContain("r.rolsuper OR pg_has_role(r.oid, 'app', 'MEMBER')");
    expect(pg.drop).toBe(
      `REASSIGN OWNED BY "laptop" TO app; DROP OWNED BY "laptop"; DROP ROLE "laptop";`,
    );

    for (const kind of ["mysql", "mariadb"] as const) {
      const engine = grantEngine(grant({ kind }));
      expect(engine.create).toEqual([`CREATE USER 'laptop'@'%' IDENTIFIED BY '`, "';"]);
      expect(engine.access).toContain("GRANT SELECT, SHOW VIEW ON app.* TO 'laptop'@'%';");
      expect(grantEngine(grant({ kind, access: "full" })).access).toContain(
        "GRANT ALL PRIVILEGES ON app.* TO 'laptop'@'%';",
      );
      expect(engine.drop).toBe("DROP USER IF EXISTS 'laptop'@'%';");
      expect(engine.want).toBe("YNNNNNNNNNNNYNNNNN");
      expect(grantEngine(grant({ kind, access: "full" })).want).toBe("Y".repeat(18));
    }
    // As root, signed in from the container's own environment through an option file on a pipe.
    expect(grantEngine(grant({ kind: "mysql" })).rootClient).toBe(
      `mysql --defaults-extra-file=<(printf '[client]\\nuser=root\\npassword=%s\\n' "$MYSQL_ROOT_PASSWORD") -N -B`,
    );
    expect(grantEngine(grant({ kind: "mariadb" })).rootClient).toContain(
      '"$MARIADB_ROOT_PASSWORD"',
    );

    const mongo = grantEngine(grant({ kind: "mongodb" }));
    // Its markers are built at runtime: an echoed source line never holds them.
    expect(mongo.state).not.toMatch(/opscrew-(read|login=)/);
    expect(mongo.state).toContain(`print("opscrew-" + "read")`);
    expect(mongo.prelude).toContain(
      "a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)",
    );
    expect(mongo.create.join("<password>")).toBe(
      `a.createUser({ user: "laptop", pwd: "<password>", roles: [{ role: "read", db: "app" }] });`,
    );
    expect(grantEngine(grant({ kind: "mongodb", access: "full" })).update.join("<password>")).toBe(
      `a.updateUser("laptop", { pwd: "<password>", roles: [{ role: "readWrite", db: "app" }, { role: "dbAdmin", db: "app" }] });`,
    );
    expect(mongo.drop).toBe(`a.dropUser("laptop");`);
  });

  it("match their snapshot for every kind and access, and its removal", () => {
    const all: Record<string, string> = {};
    for (const kind of GRANT_KINDS) {
      for (const params of [
        grant({ kind }),
        grant({ kind, access: "full" }),
        grant({ kind, remove: true }),
      ]) {
        const name = `${kind} ${params.remove ? "removal" : params.access}`;
        const scripts = scriptsOf(params);
        all[`${name} check`] = scripts.check;
        all[`${name} apply`] = scripts.apply;
        all[`${name} verify`] = scripts.verify;
      }
    }
    expect(all).toMatchSnapshot();
    for (const [name, script] of Object.entries(all)) {
      for (const command of [
        script,
        asRoot("sudo", asDeployUser(script)),
        pipedScript(asDeployUser(script), `${password()}\n`),
      ]) {
        const syntax = shSyntax(command);
        if (syntax !== undefined) expect(syntax.ok, `${name}: ${syntax.stderr}`).toBe(true);
      }
    }
  });

  it("take the password only from stdin, as the deploy user, and need it unless the login goes", () => {
    const scripts = scriptsOf(grant());
    expect(scripts.secrets).toEqual({ names: ["grantPassword"], required: true });
    expect(scripts.asDeploy).toBe(true);
    // The password variable goes only through builtins: read, case, and printf into the client.
    const uses = scripts.apply.split("\n").filter((line) => /\$pw\b/.test(line));
    expect(uses.map((line) => line.trim())).toEqual([
      'case "$pw" in',
      `if ! { printf '%s\\n' "$PRELUDE"; printf '%s%s%s\\n' "$pre" "$pw" "$post"; printf '%s\\n' "$ACCESS"; } | client >/dev/null; then`,
    ]);
    expect(scriptsOf(grant({ remove: true })).secrets).toBeUndefined();
  });
});

describe.skipIf(!SH_AVAILABLE)("the grant step in a real shell (docker stubbed)", () => {
  /**
   * `docker compose -p <project> exec -T <service> <client>`: logs its arguments (the harness),
   * keeps what reached its stdin, and answers a state query from `$S/state` (the login's
   * `opscrew-login=` line, absent when there is none).
   */
  const DOCKER = `stdin=$(cat)
printf '%s\\n---\\n' "$stdin" >> "$S/stdin"
[ ! -e "$S/down" ] || { echo 'service "db" is not running' >&2; exit 1; }
case "$stdin" in
  *opscrew-*) echo opscrew-read; cat "$S/state" 2>/dev/null ;;
esac
exit 0`;

  function harness(state?: string): ShellHarness {
    const h = new ShellHarness();
    h.stub("docker", DOCKER);
    if (state !== undefined) h.write("/state/state", `opscrew-login=${state}\n`);
    return h;
  }
  const sent = (h: ShellHarness) => (h.read("/state/stdin") ?? "").split("\n---\n").filter(Boolean);

  it("makes a missing login with the password in the statements on the client's stdin, never in its arguments", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(grant());
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const pw = password();
      const run = h.run(scripts.apply, `${pw}\n`);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const client =
        "docker compose -p shop exec -T db psql -X -q -t -A -v ON_ERROR_STOP=1 -U app -d app";
      expect(h.calls()).toEqual([client, client, client]);
      const statements = sent(h).at(-1);
      expect(statements).toBe(
        [
          "SET client_min_messages = error;",
          `CREATE ROLE "laptop" WITH LOGIN PASSWORD '${pw}';`,
          `REVOKE pg_write_all_data FROM "laptop"; GRANT pg_read_all_data TO "laptop";`,
        ].join("\n"),
      );
      expect(h.calls().join("\n")).not.toContain(pw);
      // Once the engine says the login is read-only, the step is in place.
      h.write("/state/state", "opscrew-login=read-only\n");
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
      expect(h.run(scriptsOf(grant({ access: "full" })).check).stdout).toContain("state=change");
    } finally {
      h.dispose();
    }
  });

  it("updates an existing login's password and access, as root from the container's environment for MySQL", () => {
    const h = harness("YNNNNNNNNNNNYNNNNN");
    try {
      const scripts = scriptsOf(grant({ kind: "mysql", access: "full" }));
      const pw = password("mysql");
      expect(h.run(scripts.apply, `${pw}\n`).status).toBe(0);
      // The root password's variable reaches the container unexpanded: its bash fills it in.
      expect(h.calls()[0]).toBe(
        `docker compose -p shop exec -T db bash -c mysql --defaults-extra-file=<(printf '[client]\\nuser=root\\npassword=%s\\n' "$MYSQL_ROOT_PASSWORD") -N -B`,
      );
      expect(sent(h).at(-1)).toContain(`ALTER USER 'laptop'@'%' IDENTIFIED BY '${pw}';`);
      expect(sent(h).at(-1)).toContain("GRANT ALL PRIVILEGES ON app.* TO 'laptop'@'%';");
    } finally {
      h.dispose();
    }
  });

  it("removes only a login that exists, and needs no password for it", () => {
    const h = harness("app.read");
    try {
      const scripts = scriptsOf(grant({ kind: "mongodb", remove: true }));
      expect(h.run(scripts.check).stdout).toContain("state=change");
      expect(h.run(scripts.apply).status).toBe(0);
      expect(sent(h).at(-1)).toContain(`a.dropUser("laptop");`);
      h.run(`rm -f '${h.root}/state/state'`);
      expect(h.run(scripts.verify).status).toBe(0);
      const before = sent(h).length;
      expect(h.run(scripts.apply).status).toBe(0);
      // Only the state was read: nothing to drop.
      expect(sent(h)).toHaveLength(before + 1);
    } finally {
      h.dispose();
    }
  });

  it("stops before any change without a password, and when the engine cannot be read", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(grant());
      const none = h.run(scripts.apply, "");
      expect(none.status).not.toBe(0);
      expect(none.stderr).toContain("The login's password did not arrive on standard input");
      expect(h.calls()).toEqual([]);

      h.write("/state/down", "");
      const down = h.run(scripts.apply, `${password()}\n`);
      expect(down.status).not.toBe(0);
      expect(down.stderr).toContain("OpsCrew could not read the logins of db (PostgreSQL)");
      expect(sent(h)).toHaveLength(1);
      expect(h.run(scripts.check).stdout).toContain("state=change");
      // A removal never counts a login as gone when the engine was not read.
      expect(h.run(scriptsOf(grant({ remove: true })).verify).status).not.toBe(0);
    } finally {
      h.dispose();
    }
  });
});

describe("planning and applying a grant", () => {
  it("is one step, planned as a change, without the password in the plan", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const plan = planGrant(await inspectHost(fake), { app: "shop", grant: grant() }, COMMAND);
    expect(plan.findings).toEqual([]);
    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: "grant",
        state: "change",
        scope: "app",
        title: `Give the login "laptop" read-only access to db (PostgreSQL)`,
        params: grant(),
      }),
    ]);
    expect(
      planGrant(await inspectHost(fake), { app: "shop", grant: grant({ remove: true }) }, COMMAND)
        .steps[0]?.title,
    ).toBe(`Remove the login "laptop" from db (PostgreSQL)`);
    const facts = await inspectHost(fake);
    expect(() =>
      planGrant(facts, { app: "shop", grant: grant({ login: "app" }) }, COMMAND),
    ).toThrow(
      /The device's database login is not valid \(login: must not be a login the database or the app already uses\)/,
    );
  });

  it("sends the password on stdin only, runs as deploy, and leaves it out of errors", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const pw = password();
    const plan = planGrant(await inspectHost(fake), { app: "shop", grant: grant() }, COMMAND);
    expect(canonicalJson(plan)).not.toContain(pw);
    const start = fake.calls.length;
    await applyApproved(fake, plan, { command: COMMAND, secrets: { grantPassword: pw } });
    const calls = fake.calls.slice(start).filter((call) => call.name.startsWith("grant."));
    expect(calls.map((call) => call.name)).toEqual(["grant.check", "grant.apply", "grant.verify"]);
    for (const call of calls) {
      expect(call.asUser).toBe("deploy");
      expect(call.command).not.toContain(pw);
    }
    expect(calls[1]?.input).toBe(`${pw}\n`);
    expect(fake.databaseLogins.get("shop/db/laptop")).toBe("read-only");
    expect(fake.grantLog).toEqual(["create shop/db/laptop"]);

    // Applied again: in place, nothing sent.
    await applyApproved(fake, plan, { command: COMMAND, secrets: { grantPassword: pw } });
    expect(fake.grantLog).toHaveLength(1);

    // A failing apply that echoes its stdin: the error shows no password.
    const full = planGrant(
      await inspectHost(fake),
      { app: "shop", grant: grant({ access: "full" }) },
      COMMAND,
    );
    fake.echoStdinOn = "grant.apply";
    const error = await applyApproved(fake, full, {
      command: COMMAND,
      secrets: { grantPassword: pw },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostApplyError);
    expect(String((error as Error).message)).not.toContain(pw);
    expect(String((error as Error).message)).toContain("[REDACTED");
  });

  it("is refused without the password, or with one that is not letters and digits", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const plan = planGrant(await inspectHost(fake), { app: "shop", grant: grant() }, COMMAND);
    await expect(applyApproved(fake, plan, { command: COMMAND })).rejects.toThrow(
      "Applying this plan needs the password of the device's database login, and none was supplied.",
    );
    await expect(
      applyApproved(fake, plan, { command: COMMAND, secrets: { grantPassword: "short'one" } }),
    ).rejects.toThrow("The database login's password must be 16 to 128 letters and digits.");
    expect(fake.grantLog).toEqual([]);
  });

  it("runs through Docker as deploy on a server OpsCrew created", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    const pw = password("cloud");
    const plan = planGrant(
      await inspectHost(fake, { rootImage: IMAGE }),
      { app: "shop", grant: grant({ kind: "mariadb" }) },
      COMMAND,
    );
    await applyApproved(fake, plan, {
      command: COMMAND,
      secrets: { grantPassword: pw },
      rootImage: IMAGE,
    });
    const apply = fake.calls.find((call) => call.name === "grant.apply");
    expect(apply?.command).toBe(dockerRootCommand(IMAGE));
    expect(apply?.asUser).toBe("deploy");
    expect(apply?.input).toBe(`${pw}\n`);
    expect(fake.databaseLogins.get("shop/db/laptop")).toBe("YNNNNNNNNNNNYNNNNN");
  });
});
