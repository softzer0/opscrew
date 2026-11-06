// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Migrations,
  type MigrationTool,
} from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPlan } from "../__fixtures__/plans";
import { migrationDown, migrationRecord, schemaRecordPath } from "./migrations";

/** The digests of the earlier and the later version. */
const A = "a".repeat(64);
const B = "b".repeat(64);
const image = (hex: string) => `ghcr.io/acme/shop@sha256:${hex}`;

/** `shop` on PostgreSQL with a release command and its tool's commands, as detection writes them. */
function withMigrations(releaseCommand: string, migrations: Migrations): DeployPlan {
  const plan = testPlan();
  return DeployPlanSchema.parse({ ...plan, app: { ...plan.app, releaseCommand, migrations } });
}

/** Each tool's plan; Django and Knex run from a folder, Flask-Migrate with a quoted `FLASK_APP`. */
const PLANS: Record<MigrationTool, DeployPlan> = {
  rails: withMigrations("bin/rails db:migrate", {
    tool: "rails",
    status: "bin/rails db:version",
    down: "bin/rails db:migrate VERSION={version}",
  }),
  django: withMigrations("cd web && python manage.py migrate --noinput", {
    tool: "django",
    status: "cd web && python manage.py showmigrations --plan",
    down: "cd web && python manage.py migrate {app} {name} --noinput",
  }),
  alembic: withMigrations("alembic upgrade head", {
    tool: "alembic",
    status: "alembic current",
    down: "alembic downgrade {version}",
  }),
  "flask-migrate": withMigrations("FLASK_APP='shop:create_app()' flask db upgrade", {
    tool: "flask-migrate",
    status: "FLASK_APP='shop:create_app()' flask db current",
    down: "FLASK_APP='shop:create_app()' flask db downgrade {version}",
  }),
  knex: withMigrations("cd api && npx knex migrate:latest", {
    tool: "knex",
    status: "cd api && npx knex migrate:list",
    down: "cd api && npx knex migrate:down",
  }),
  sequelize: withMigrations("npx sequelize-cli db:migrate", {
    tool: "sequelize",
    status: "npx sequelize-cli db:migrate:status",
    down: "npx sequelize-cli db:migrate:undo",
  }),
  typeorm: withMigrations("npx typeorm migration:run -d dist/data-source.js", {
    tool: "typeorm",
    status: "npx typeorm migration:show -d dist/data-source.js",
    down: "npx typeorm migration:revert -d dist/data-source.js",
  }),
  laravel: withMigrations("php artisan migrate --force", {
    tool: "laravel",
    status: "php artisan migrate:status",
    down: "php artisan migrate:rollback --step={count} --force",
  }),
};

/**
 * Each tool's status output as the tools print it in a container without a terminal (checked on
 * Docker by migrations.docker.test.ts), and the record OpsCrew writes from it.
 */
const STATUS: [string, MigrationTool, string, string][] = [
  [
    "Rails",
    "rails",
    "\ndatabase: app\nCurrent version: 20261106000000\n\n",
    "version=20261106000000\n",
  ],
  ["Rails before any migration", "rails", "\ndatabase: app\nCurrent version: 0\n\n", "version=0\n"],
  ["Alembic", "alembic", "7c9d1e2f3a4b (head)\n", "version=7c9d1e2f3a4b\n"],
  ["Alembic before any migration", "alembic", "", "version=base\n"],
  ["Flask-Migrate", "flask-migrate", "8a7b6c5d4e3f (head)\n", "version=8a7b6c5d4e3f\n"],
  [
    "Django",
    "django",
    [
      "[X]  contenttypes.0001_initial",
      "[X]  auth.0001_initial",
      "[X]  contenttypes.0002_remove_content_type_name",
      "[X]  auth.0002_alter_permission_name_max_length",
      "[X]  visits.0001_initial",
      "[X]  sessions.0001_initial",
      "[X]  visits.0002_visit_note",
      "[ ]  visits.0003_visit_tags",
      "",
    ].join("\n"),
    [
      "app=contenttypes 0002_remove_content_type_name",
      "app=auth 0002_alter_permission_name_max_length",
      "app=sessions 0001_initial",
      "app=visits 0002_visit_note",
      "",
    ].join("\n"),
  ],
  [
    "Knex",
    "knex",
    "Found 2 Completed Migration file/files.\n20261014073237_create_visits.js\n20261106000000_add_note_to_visits.js\nNo Pending Migration files Found.\n\n",
    "count=2\n",
  ],
  [
    "Knex before any migration",
    "knex",
    "No Completed Migration files Found.\nFound 1 Pending Migration file/files.\n20261014073237_create_visits.js\n\n",
    "count=0\n",
  ],
  [
    "sequelize-cli",
    "sequelize",
    '\nSequelize CLI [Node: 24.22.1, CLI: 6.6.3, ORM: 6.37.7]\n\nLoaded configuration file "config/config.json".\nUsing environment "production".\nup 20261101000000-create-visits.js\nup 20261106000000-add-note-to-visits.js\ndown 20261107000000-add-tags.js\n',
    "count=2\n",
  ],
  [
    "TypeORM",
    "typeorm",
    "[X] 1 CreateVisits1791963402636\n[X] 2 AddNoteToVisits1791963402637\n[ ] AddTags1791963402638\n",
    "count=2\n",
  ],
  [
    "Laravel",
    "laravel",
    [
      "",
      "  Migration name .............................................. Batch / Status  ",
      "  0001_01_01_000000_create_users_table ............................... [1] Ran  ",
      "  0001_01_01_000001_create_cache_table ............................... [1] Ran  ",
      "  0001_01_01_000002_create_jobs_table ................................ [1] Ran  ",
      "  2026_11_06_000000_add_note_to_users_table .......................... [2] Ran  ",
      "  2026_11_07_000000_add_tags_to_users_table .......................... Pending  ",
      "",
    ].join("\n"),
    "count=4\n",
  ],
];

/**
 * The fake `docker`: logs each call with the image the Compose file would run (`APP_IMAGE`), then
 * runs the last argument, the one-off's `sh -c` script, in $WORK/container with the fake tools.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $* | APP_IMAGE=$APP_IMAGE" >> "$WORK/docker.log"',
  'for last in "$@"; do :; done',
  'tools="$(cd "$WORK/tools" && pwd)"',
  'cd "$WORK/container" && PATH="$tools:$PATH" exec sh -c "$last"',
].join("\n");

/**
 * Every migration tool (`npx`, `python`, `alembic`, `flask`, `php`, `bin/rails`): logs its words,
 * `FLASK_APP` and its folder in $WORK/tools.log; prints $WORK/status.out when the test wrote one,
 * else a row of the database, as a migration's output can; prints another row on stderr; exits
 * TOOL_FAIL (default 0).
 */
const FAKE_TOOL = [
  "#!/bin/sh",
  'echo "$(basename "$0") $*${FLASK_APP:+ FLASK_APP=$FLASK_APP} in .${PWD#"$(cd "$WORK/container" && pwd)"}" >> "$WORK/tools.log"',
  'if [ -f "$WORK/status.out" ]; then cat "$WORK/status.out"; else echo "migrated $SECRET_ROW"; fi',
  'echo "the tool read $SECRET_ROW" >&2',
  'exit "${TOOL_FAIL:-0}"',
].join("\n");

const SECRET_ROW = "row-value-from-the-database";

function shWorks(): boolean {
  try {
    return spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

let work = "";
const at = (name: string) => `${work}/app/${name}`;
const read = (name: string) => (existsSync(at(name)) ? readFileSync(at(name), "utf8") : undefined);
const lines = (file: string) =>
  existsSync(`${work}/${file}`)
    ? readFileSync(`${work}/${file}`, "utf8").split("\n").filter(Boolean)
    : [];
const records = () => (existsSync(at(".schema")) ? readdirSync(at(".schema")).sort() : []);
const mode = (name: string) => (statSync(at(name)).mode & 0o777).toString(8);
const windows = process.platform === "win32";

function write(file: string, content: string, executable = false): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) spawnSync("chmod", ["755", file]);
}

/** Runs `script` as the workflow does: piped to `sh -s` with `image` as `$1`, the fakes first. */
function run(script: readonly string[], ref: string, env: Record<string, string> = {}) {
  const result = spawnSync(
    "sh",
    ["-c", 'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh -s -- "$@"', "sh", ref],
    {
      input: `${script.join("\n")}\n`,
      env: { ...process.env, WORK: work, SECRET_ROW, ...env },
      encoding: "utf8",
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The deploy's lines after the release command: the record, as `switchCommands` places it. */
function deploy(plan: DeployPlan, ref = image(B), env: Record<string, string> = {}) {
  const script = [
    "set -eu",
    'cd "$WORK/app"',
    'export APP_IMAGE="$1"',
    "if true; then",
    ...migrationRecord(plan).map((line) => `  ${line}`),
    "fi",
    "echo deployed",
  ];
  return run(script, ref, env);
}

/**
 * The rollback from B to A's database step, as `switchCommands` runs the down migrations: in a
 * subshell inside an `if` condition, with `$target` and `$running`, `APP_IMAGE` the earlier
 * version's and `.env` naming the running one.
 */
function rollback(plan: DeployPlan, env: Record<string, string> = {}) {
  write(at(".env"), `APP_IMAGE=${image(B)}\n`);
  const script = [
    "set -eu",
    'cd "$WORK/app"',
    'export APP_IMAGE="$1"',
    `target=${A}`,
    `running=${B}`,
    "if ! (",
    ...migrationDown(plan).map((line) => `        ${line}`),
    "      ); then echo 'the step failed'; exit 1; fi",
    "echo 'the step finished'",
  ];
  return run(script, image(A), env);
}

/** The records of A, the version rolled back to, and B, the running one; `undefined` leaves one out. */
function recorded(was: string | undefined, now: string | undefined): void {
  if (was !== undefined) write(at(schemaRecordPath(A)), was);
  if (now !== undefined) write(at(schemaRecordPath(B)), now);
}

describe.skipIf(!shWorks())("the migrations' record and down step", { timeout: 60_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-migrations-")).replaceAll("\\", "/");
    write(`${work}/bin/docker`, `${FAKE_DOCKER}\n`, true);
    for (const tool of ["npx", "python", "alembic", "flask", "php"]) {
      write(`${work}/tools/${tool}`, `${FAKE_TOOL}\n`, true);
    }
    write(`${work}/container/bin/rails`, `${FAKE_TOOL}\n`, true);
    mkdirSync(`${work}/container/web`, { recursive: true });
    mkdirSync(`${work}/container/api`, { recursive: true });
    // The release command just wrote its output there.
    write(at("release.log"), "the release command's output\n");
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe("at a deploy", () => {
    it.each(STATUS)("records %s's real status output", (_name, tool, output, record) => {
      write(`${work}/status.out`, output);
      const result = deploy(PLANS[tool]);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toBe("deployed\n");
      expect(read(schemaRecordPath(B))).toBe(record);
      const status = PLANS[tool].app.migrations?.status ?? "";
      expect(lines("docker.log")).toEqual([
        `docker compose run --rm --no-deps -T release sh -c ${status} | APP_IMAGE=${image(B)}`,
      ]);
    });

    it("keeps the tool's errors in release.log, after the release command's output, and prints nothing of them", () => {
      write(`${work}/status.out`, "Found 1 Completed Migration file/files.\n");
      const result = deploy(PLANS.knex);
      expect(result.output).toBe("deployed\n");
      expect(lines("tools.log")).toEqual(["npx knex migrate:list in ./api"]);
      expect(read("release.log")).toBe(
        `the release command's output\nthe tool read ${SECRET_ROW}\n`,
      );
      if (!windows) {
        expect(mode(".schema")).toBe("700");
        expect(mode(schemaRecordPath(B))).toBe("600");
      }
    });

    it("keeps the newest 20 records", () => {
      const old = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(64, "0"));
      old.forEach((hex, i) => {
        write(at(schemaRecordPath(hex)), "count=1\n");
        const time = 1_790_000_000 + i * 60;
        utimesSync(at(schemaRecordPath(hex)), time, time);
      });
      write(`${work}/status.out`, "Found 2 Completed Migration file/files.\n");
      expect(deploy(PLANS.knex).status).toBe(0);
      expect(records()).toEqual([...old.slice(6), B].sort());
    });

    it("rewrites the record of a version deployed again", () => {
      write(at(schemaRecordPath(B)), "count=1\n");
      write(`${work}/status.out`, "Found 2 Completed Migration file/files.\n");
      expect(deploy(PLANS.knex).status).toBe(0);
      expect(read(schemaRecordPath(B))).toBe("count=2\n");
    });

    it.each([
      ["the status command fails", { TOOL_FAIL: "1" }, "Found 2 Completed Migration file/files.\n"],
      ["its output is unknown", {}, `Error: ${SECRET_ROW}\n`],
    ])("only warns, with no record, when %s", (_name, env, output) => {
      write(at(schemaRecordPath(B)), "count=1\n");
      write(`${work}/status.out`, output);
      const result = deploy(PLANS.knex, image(B), env);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(
        "::warning::OpsCrew could not record which database migrations this version has (app.migrations.status in opscrew/plan.yaml failed, or printed nothing OpsCrew can read), so a rollback from this version can't migrate the database down.",
      );
      expect(result.output).toMatch(
        /The command's errors are on the server in \S+\/app\/release\.log \(opscrew\/RUNBOOK\.md has the SSH command\)\.\n/,
      );
      expect(result.output).toMatch(/deployed\n$/);
      expect(result.output).not.toContain(SECRET_ROW);
      expect(records()).toEqual([]);
    });

    it("records nothing for an image built on this computer, which has no digest", () => {
      const result = deploy(PLANS.knex, "opscrew-local/shop:0123456789ab");
      expect(result.output).toBe("deployed\n");
      expect(lines("docker.log")).toEqual([]);
      expect(existsSync(at(".schema"))).toBe(false);
    });
  });

  describe("at a rollback", () => {
    it.each<[string, MigrationTool, string, string, string[]]>([
      [
        "Rails to the earlier version",
        "rails",
        "version=20261101000000\n",
        "version=20261106000000\n",
        ["rails db:migrate VERSION=20261101000000 in ."],
      ],
      [
        "Rails to before any migration",
        "rails",
        "version=0\n",
        "version=20261106000000\n",
        ["rails db:migrate VERSION=0 in ."],
      ],
      [
        "Alembic to before any migration",
        "alembic",
        "version=base\n",
        "version=7c9d1e2f3a4b\n",
        ["alembic downgrade base in ."],
      ],
      [
        "Flask-Migrate with its FLASK_APP",
        "flask-migrate",
        "version=3f1c2b4a5d6e\n",
        "version=8a7b6c5d4e3f\n",
        ["flask db downgrade 3f1c2b4a5d6e FLASK_APP=shop:create_app() in ."],
      ],
      [
        "Knex once per migration, each from its folder",
        "knex",
        "count=1\n",
        "count=3\n",
        ["npx knex migrate:down in ./api", "npx knex migrate:down in ./api"],
      ],
      [
        "sequelize-cli once",
        "sequelize",
        "count=1\n",
        "count=2\n",
        ["npx sequelize-cli db:migrate:undo in ."],
      ],
      [
        "TypeORM down to none",
        "typeorm",
        "count=0\n",
        "count=2\n",
        [
          "npx typeorm migration:revert -d dist/data-source.js in .",
          "npx typeorm migration:revert -d dist/data-source.js in .",
        ],
      ],
      [
        "Laravel with --step",
        "laravel",
        "count=3\n",
        "count=5\n",
        ["php artisan migrate:rollback --step=2 --force in ."],
      ],
      [
        "Django per app, newest first, zero for an app the earlier version lacks",
        "django",
        "app=contenttypes 0002_remove_content_type_name\napp=visits 0001_initial\n",
        "app=contenttypes 0002_remove_content_type_name\napp=sessions 0001_initial\napp=visits 0002_visit_note\n",
        [
          "python manage.py migrate visits 0001_initial --noinput in ./web",
          "python manage.py migrate sessions zero --noinput in ./web",
        ],
      ],
    ])("migrates %s, in one one-off of the running image", (_name, tool, was, now, calls) => {
      recorded(was, now);
      const result = rollback(PLANS[tool]);
      expect(result.status, result.output).toBe(0);
      expect(lines("tools.log")).toEqual(calls);
      const docker = lines("docker.log");
      expect(docker).toHaveLength(1);
      expect(docker[0]).toMatch(/^docker compose run --rm --no-deps -T release sh -c /);
      expect(docker[0]).toMatch(new RegExp(`\\| APP_IMAGE=${image(B).replace(/[.]/g, "\\.")}$`));
      expect(result.output).toBe(
        `OpsCrew migrated the database down with ${tool} to the migrations of the version rolled back to.\nthe step finished\n`,
      );
      expect(read("release.log")).toContain(`migrated ${SECRET_ROW}`);
      expect(read("release.log")).toContain(`the tool read ${SECRET_ROW}`);
      if (!windows) expect(mode("release.log")).toBe("600");
    });

    it.each<[MigrationTool, string, string]>([
      ["rails", "version=20261101000000\n", "version=20261101000000\n"],
      ["knex", "count=2\n", "count=2\n"],
      ["laravel", "count=3\n", "count=3\n"],
      [
        "django",
        "app=contenttypes 0002_remove_content_type_name\napp=visits 0001_initial\n",
        "app=visits 0001_initial\napp=contenttypes 0002_remove_content_type_name\n",
      ],
    ])("has nothing to do for %s when the records match", (tool, was, now) => {
      recorded(was, now);
      const result = rollback(PLANS[tool]);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(
        "The database already has the migrations of the version rolled back to: there is nothing to migrate down.",
      );
      expect(lines("docker.log")).toEqual([]);
    });

    it.each<[string, MigrationTool, string | undefined, string | undefined, string]>([
      [
        "the earlier version's record is missing",
        "rails",
        undefined,
        "version=20261106000000\n",
        "::error::The server holds no record of the migrations of the version running now or of the version rolled back to (in .schema), so OpsCrew can't tell which to undo and nothing was migrated down.",
      ],
      [
        "the running version's record is missing",
        "knex",
        "count=1\n",
        undefined,
        "::error::The server holds no record of the migrations",
      ],
      [
        "the count grew going back",
        "knex",
        "count=3\n",
        "count=2\n",
        "::error::The version rolled back to has more migrations applied than the version running now (their records in .schema on the server), so migrating down can't reach its schema and nothing was migrated down.",
      ],
      ["Laravel's count grew", "laravel", "count=5\n", "count=4\n", "has more migrations applied"],
      [
        "a version would run a command",
        "rails",
        "version=$(touch pwned)\n",
        "version=20261106000000\n",
        "::error::A migration record in .schema on the server holds a value OpsCrew won't put in a command, so nothing was migrated down.",
      ],
      [
        "a version is empty",
        "alembic",
        "version=\n",
        "version=7c9d1e2f3a4b\n",
        "holds a value OpsCrew won't put in a command",
      ],
      [
        "the record holds two versions",
        "alembic",
        "version=1a2b3c\nversion=4d5e6f\n",
        "version=7c9d1e2f3a4b\n",
        "holds a value OpsCrew won't put in a command",
      ],
      [
        "a count is not a number",
        "sequelize",
        "count=1\n",
        "count=2;x\n",
        "holds a value OpsCrew won't put in a command",
      ],
      [
        "a Django migration would run a command",
        "django",
        "app=visits 0001_initial;touch pwned\n",
        "app=visits 0002_visit_note\n",
        "holds a value OpsCrew won't put in a command",
      ],
      [
        "a Django line has no migration",
        "django",
        "app=visits 0001_initial\n",
        "app=visits\n",
        "holds a value OpsCrew won't put in a command",
      ],
    ])("changes nothing when %s", (_name, tool, was, now, message) => {
      recorded(was, now);
      const result = rollback(PLANS[tool]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).toMatch(/the step failed\n$/);
      expect(lines("docker.log")).toEqual([]);
      expect(lines("tools.log")).toEqual([]);
      expect(existsSync(`${work}/app/pwned`)).toBe(false);
      expect(existsSync(`${work}/container/pwned`)).toBe(false);
    });

    it("fails when the down migrations fail, naming their log and printing none of it", () => {
      recorded("count=1\n", "count=2\n");
      const result = rollback(PLANS.knex, { TOOL_FAIL: "1" });
      expect(result.status).toBe(1);
      expect(result.output).toMatch(
        /^::error::The down migrations with knex failed\. Their output stays on the server in \S+\/app\/release\.log \(it can quote data from the database, so it is not printed here; opscrew\/RUNBOOK\.md has the SSH command\)\.\nthe step failed\n$/,
      );
      expect(read("release.log")).toContain(`the tool read ${SECRET_ROW}`);
    });

    it("fails without app.migrations", () => {
      const plain = testPlan();
      expect(migrationRecord(plain)).toEqual([]);
      const result = rollback(plain);
      expect(result.status).toBe(1);
      expect(result.output).toContain("::error::Down migrations aren't available for this app.");
    });
  });
});
