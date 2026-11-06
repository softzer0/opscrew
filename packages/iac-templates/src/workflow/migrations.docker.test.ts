/**
 * The down migrations of each of the eight tools against a real database (research R9, plan.md
 * 12.7). For each tool, an app with two migrations: the example where one exists (`koa-knex`,
 * `django-postgres`, `fastapi-sqlmodel`, `nestjs-typeorm`, `laravel-app`), a small fixture for
 * Rails, Sequelize and Flask-Migrate, and a second migration in `__fixtures__/migrations/<tool>-v2`
 * (Django's also installs the sessions app, which the first version lacks). Version 1's image is
 * a small one built for the test, version 2's adds the second migration. As OpsCrew's Compose
 * project renders them (PostgreSQL `db`, or SQLite in a volume for Laravel, as its example has it;
 * the one-off `release`), with the start script's lines:
 * 1. each version's deploy runs its release command, then `migrationRecord`, which records the
 *    tool's real status output under the version's digest;
 * 2. `migrationDown`, as the rollback from version 2 to 1 runs it, brings the database back to
 *    version 1's schema exactly, and the tool's status, recorded again, is version 1's.
 * No script prints the database's password or the app's secrets.
 *
 * It builds images and pulls base images, so it runs only with OPSCREW_DOCKER_TESTS=1. The tools
 * run one at a time; each removes its project with its volumes and the images it built, and the
 * run removes the base images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Migrations,
  type MigrationTool,
} from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { serviceSpec } from "../catalog";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { IMAGES } from "../pins";
import { renderCompose } from "../runtime";
import { migrationDown, migrationRecord, schemaRecordPath } from "./migrations";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (info.status !== 0 || info.stdout.trim() !== "linux") {
    return "no Docker engine for Linux containers is running";
  }
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return compose.status === 0 ? undefined : "docker compose is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the down migrations on Docker: ${reason}`);

/** The run's id, in every project's and image's name. */
const RUN = randomBytes(3).toString("hex");

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./__fixtures__/migrations/", import.meta.url));

/** The test images' bases besides the pinned Node and Python ones. */
const RUBY =
  "ruby:3.4-slim@sha256:3e76621a6e7771cacf9fff99c0399baae41fc56fe58547bc846ff72c6a27c527";
const COMPOSER =
  "composer:2@sha256:8de2184c6de224f4689e8f80ed5f5edaf0030b6b8b7839a22a2bcb6722ac87d0";

const NODE_IMAGE = [
  `FROM ${IMAGES.nodeAlpine.ref}`,
  "WORKDIR /app",
  "COPY package.json ./",
  "RUN npm install --omit=dev --no-audit --no-fund",
  "COPY . .",
];

const PYTHON_IMAGE = [
  `FROM ${IMAGES.python.ref}`,
  "ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore",
  "WORKDIR /app",
  "COPY requirements.txt ./",
  "RUN pip install --no-cache-dir -r requirements.txt",
  "COPY . .",
];

const TSC = "RUN npx tsc -p tsconfig.build.json";

/** One tool's app and what its two versions record. */
interface Case {
  tool: MigrationTool;
  /** The app's folder, the context of version 1's image. */
  app: string;
  /** Version 1's Dockerfile. */
  image: string[];
  /** What version 2's image runs after its files are in (TypeORM compiles them). */
  rebuild?: string;
  /** Writes the files version 2 changes besides its migration into its context `dir`. */
  patch?: (dir: string) => void;
  releaseCommand: string;
  migrations: Migrations;
  /** PostgreSQL `db`, or SQLite in the volume at /data. */
  database: "postgres" | "sqlite";
  /** The app's variables besides `DATABASE_URL`. */
  env: Record<string, string>;
  /** Version 1's and version 2's records. */
  records: [string, string];
  /** The `<table>.<column>` that version 2's migration adds. */
  added: string[];
}

/** An example's `migrations`, as detection finds them (its `expected.json`). */
function detected(example: string): Migrations {
  const expected = JSON.parse(readFileSync(join(EXAMPLES, example, "expected.json"), "utf8"));
  return expected.facts.migrations;
}

const secret = () => randomBytes(16).toString("hex");

const CASES: Case[] = [
  {
    tool: "knex",
    app: join(EXAMPLES, "koa-knex"),
    image: NODE_IMAGE,
    releaseCommand: "npx knex migrate:latest",
    migrations: detected("koa-knex"),
    database: "postgres",
    env: {},
    records: ["count=1\n", "count=2\n"],
    added: ["visits.note"],
  },
  {
    tool: "django",
    app: join(EXAMPLES, "django-postgres"),
    image: PYTHON_IMAGE,
    patch: (dir) => {
      const settings = readFileSync(join(EXAMPLES, "django-postgres/mysite/settings.py"), "utf8");
      const app = '    "django.contrib.contenttypes",\n';
      if (!settings.includes(app)) throw new Error("django-postgres lists no contenttypes app.");
      mkdirSync(join(dir, "mysite"), { recursive: true });
      writeFileSync(
        join(dir, "mysite/settings.py"),
        settings.replace(app, `${app}    "django.contrib.sessions",\n`),
      );
    },
    releaseCommand: "python manage.py migrate --noinput",
    migrations: detected("django-postgres"),
    database: "postgres",
    env: { DJANGO_SECRET_KEY: secret() },
    records: [
      "app=contenttypes 0002_remove_content_type_name\napp=visits 0001_initial\n",
      "app=contenttypes 0002_remove_content_type_name\napp=sessions 0001_initial\napp=visits 0002_visit_note\n",
    ],
    added: ["django_session.session_key", "visits_visit.note"],
  },
  {
    tool: "alembic",
    app: join(EXAMPLES, "fastapi-sqlmodel"),
    image: PYTHON_IMAGE,
    releaseCommand: "alembic upgrade head",
    migrations: detected("fastapi-sqlmodel"),
    database: "postgres",
    env: {},
    records: ["version=e1b6e5756be1\n", "version=7c9d1e2f3a4b\n"],
    added: ["visit.note"],
  },
  {
    tool: "typeorm",
    app: join(EXAMPLES, "nestjs-typeorm"),
    image: [
      `FROM ${IMAGES.nodeAlpine.ref}`,
      "WORKDIR /app",
      "COPY package.json ./",
      "RUN npm install --omit=dev --no-audit --no-fund && npm install --no-save --no-audit --no-fund typescript@6.0.3 @types/node@22.20.5",
      "COPY . .",
      TSC,
    ],
    rebuild: TSC,
    releaseCommand: "npx typeorm migration:run -d dist/data-source.js",
    migrations: detected("nestjs-typeorm"),
    database: "postgres",
    env: {},
    records: ["count=1\n", "count=2\n"],
    added: ["visits.note"],
  },
  {
    tool: "laravel",
    app: join(EXAMPLES, "laravel-app"),
    image: [
      `FROM ${COMPOSER}`,
      "WORKDIR /app",
      "COPY composer.json composer.lock ./",
      "RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --prefer-dist",
      "COPY . .",
      "RUN composer dump-autoload --no-dev --optimize --no-interaction",
    ],
    releaseCommand: "php artisan migrate --force",
    migrations: detected("laravel-app"),
    database: "sqlite",
    env: {
      APP_ENV: "production",
      DB_CONNECTION: "sqlite",
      DB_DATABASE: "/data/database.sqlite",
    },
    records: ["count=3\n", "count=4\n"],
    added: ["users.note"],
  },
  {
    tool: "rails",
    app: join(FIXTURES, "rails"),
    image: [
      `FROM ${RUBY}`,
      "RUN gem install --no-document --minimal-deps railties:8.1.0 activerecord:8.1.0 pg:1.6.2",
      "WORKDIR /app",
      "COPY . .",
      "RUN chmod 755 bin/rails",
      "ENV RAILS_ENV=production",
    ],
    releaseCommand: "bin/rails db:migrate",
    migrations: {
      tool: "rails",
      status: "bin/rails db:version",
      down: "bin/rails db:migrate VERSION={version}",
    },
    database: "postgres",
    env: { SECRET_KEY_BASE: secret() },
    records: ["version=20261101000000\n", "version=20261106000000\n"],
    added: ["visits.note"],
  },
  {
    tool: "sequelize",
    app: join(FIXTURES, "sequelize"),
    image: NODE_IMAGE,
    releaseCommand: "npx sequelize-cli db:migrate",
    migrations: {
      tool: "sequelize",
      status: "npx sequelize-cli db:migrate:status",
      down: "npx sequelize-cli db:migrate:undo",
    },
    database: "postgres",
    env: { NODE_ENV: "production" },
    records: ["count=1\n", "count=2\n"],
    added: ["visits.note"],
  },
  {
    tool: "flask-migrate",
    app: join(FIXTURES, "flask-migrate"),
    image: PYTHON_IMAGE,
    releaseCommand: "FLASK_APP='shop:create_app()' flask db upgrade",
    migrations: {
      tool: "flask-migrate",
      status: "FLASK_APP='shop:create_app()' flask db current",
      down: "FLASK_APP='shop:create_app()' flask db downgrade {version}",
    },
    database: "postgres",
    env: {},
    records: ["version=3f1c2b4a5d6e\n", "version=8a7b6c5d4e3f\n"],
    added: ["visits.note"],
  },
];

/** The digests the scripts see: version 1, version 2, and version 1's status recorded again. */
const HEX = { v1: "a".repeat(64), v2: "b".repeat(64), again: "c".repeat(64) };

/** `shop` in staging on this computer with the case's database, release command and tool. */
function casePlan(c: Case): DeployPlan {
  const plan = onThisComputer(testPlan({ postgres: c.database === "postgres" }), {
    environment: "staging",
  });
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, releaseCommand: c.releaseCommand, migrations: c.migrations },
  });
}

function docker(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const result = spawnSync("docker", args, {
    ...o,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`.slice(
        -6000,
      ),
    );
  }
  return result.stdout.trim();
}

/** Copies the fixture folder `from` to `to`, a `.fixture` suffix left out of each file's name. */
function copyFixture(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  for (const entry of readdirSync(to, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".fixture")) {
      const path = join(entry.parentPath, entry.name);
      renameSync(path, path.slice(0, -".fixture".length));
    }
  }
}

/**
 * One tool's Compose project in its app folder, with the database's password; `image` is the one
 * the Compose file runs unless a call names another.
 */
class Project {
  readonly name: string;
  readonly password = secret();
  constructor(
    readonly dir: string,
    tool: string,
    readonly image: string,
  ) {
    this.name = `opscrew-migrations-${RUN}-${tool}`;
  }

  /** The environment of every docker call and script: the project, and no path conversion. */
  env(image = this.image): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.name,
      APP_IMAGE: image,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
    };
  }

  compose(args: string[], image = this.image): string {
    return docker(["compose", ...args], { cwd: this.dir, env: this.env(image) });
  }

  /**
   * Runs the start script's `lines` as the workflow does, piped to `sh -s` with version `hex`'s
   * GHCR reference as `$1`; the Compose file runs `image`, the local image that stands for it.
   */
  script(lines: string[], hex: string, image: string) {
    const result = spawnSync("sh", ["-s", "--", `ghcr.io/acme/shop@sha256:${hex}`], {
      input: `${["set -eu", `cd '${this.dir.replaceAll("\\", "/")}'`, ...lines].join("\n")}\n`,
      env: { ...this.env(), IMAGE: image },
      encoding: "utf8",
      timeout: 900_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
}

/** Writes the case's Compose file (its `release` one-off and its database alone) and env files. */
function writeApp(dir: string, plan: DeployPlan, c: Case, password: string): void {
  mkdirSync(dir, { recursive: true });
  const rendered = parse(renderCompose(plan).content);
  const release = { ...rendered.services.release };
  const services: Record<string, unknown> = { release };
  let volumes: Record<string, unknown> = {};
  let url = "";
  if (c.database === "postgres") {
    const db = { ...rendered.services.db };
    delete db.depends_on;
    services.db = db;
    const used = new Set((db.volumes as string[]).map((mount) => mount.split(":")[0] ?? ""));
    volumes = Object.fromEntries(
      Object.entries(rendered.volumes ?? {}).filter(([key]) => used.has(key)),
    );
    const [service] = plan.services;
    if (service === undefined) throw new Error("The plan has no database.");
    const env = serviceSpec(service.kind).environment({
      plan,
      service,
      secretRef: () => password,
    });
    writeFileSync(
      join(dir, "db.env"),
      Object.entries(env)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
    url = `postgres://app:${password}@db:5432/app`;
  } else {
    release.volumes = ["data:/data"];
    volumes.data = {};
  }
  writeFileSync(
    join(dir, "compose.yaml"),
    stringify({
      services,
      networks: { internal: {} },
      volumes,
      ...(rendered.configs === undefined ? {} : { configs: rendered.configs }),
    }),
  );
  writeFileSync(
    join(dir, "app.env"),
    Object.entries({ ...(url === "" ? {} : { DATABASE_URL: url }), ...c.env })
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}

/** The database's `<table>.<column>` names, sorted. */
function columns(project: Project, c: Case): string[] {
  const out =
    c.database === "postgres"
      ? project.compose([
          "exec",
          "-T",
          "db",
          "sh",
          "-c",
          `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -t -A -h 127.0.0.1 -U app -d app -c "SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public'"`,
        ])
      : project.compose([
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--entrypoint",
          "php",
          "release",
          "-r",
          `$db = new PDO("sqlite:/data/database.sqlite"); foreach ($db->query("SELECT m.name || '.' || p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'") as $row) { echo $row[0], PHP_EOL; }`,
        ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** The record's lines, sorted: Django's follow the order the migrations ran in. */
const recordLines = (text: string | undefined) => (text ?? "").split("\n").filter(Boolean).sort();

/** Whether the local Docker has `ref`. */
function hasImage(ref: string): boolean {
  return spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" }).status === 0;
}

/** The base images this run pulled, removed at the end. */
const BASES = [IMAGES.nodeAlpine.ref, IMAGES.python.ref, IMAGES.postgres.ref, RUBY, COMPOSER];
const pulled = reason === undefined ? BASES.filter((ref) => !hasImage(ref)) : [];

afterAll(() => {
  for (const ref of pulled) spawnSync("docker", ["image", "rm", ref], { stdio: "ignore" });
});

describe.skipIf(reason !== undefined)(
  "the down migrations on Docker",
  { timeout: 1_800_000 },
  () => {
    for (const c of CASES) {
      it(`${c.tool}: records the real status output and migrates down to the first migration`, () => {
        const plan = casePlan(c);
        const root = mkdtempSync(join(tmpdir(), "opscrew-migrations-docker-"));
        const v1 = `opscrew-migrations-${RUN}-${c.tool}:v1`;
        const v2 = `opscrew-migrations-${RUN}-${c.tool}:v2`;
        const project = new Project(join(root, "apps", plan.app.name), c.tool, v1);
        try {
          writeFileSync(join(root, "Dockerfile.v1"), `${c.image.join("\n")}\n`);
          docker(["build", "-q", "-t", v1, "-f", join(root, "Dockerfile.v1"), c.app]);
          const second = join(root, "v2");
          copyFixture(join(FIXTURES, `${c.tool}-v2`), second);
          c.patch?.(second);
          const v2File = [
            `FROM ${v1}`,
            "COPY . .",
            ...(c.rebuild === undefined ? [] : [c.rebuild]),
          ];
          writeFileSync(join(root, "Dockerfile.v2"), `${v2File.join("\n")}\n`);
          docker(["build", "-q", "-t", v2, "-f", join(root, "Dockerfile.v2"), second]);

          writeApp(project.dir, plan, c, project.password);
          if (c.database === "postgres") {
            project.compose(["up", "-d", "--wait", "--wait-timeout", "300", "db"]);
          } else {
            project.compose([
              "run",
              "--rm",
              "--no-deps",
              "-T",
              "--entrypoint",
              "sh",
              "release",
              "-c",
              "touch /data/database.sqlite",
            ]);
          }

          /** A deploy's release command and record, `$1` naming `hex`. */
          const deploy = (hex: string, image: string) =>
            project.script(
              [
                'export APP_IMAGE="$IMAGE"',
                "(umask 077; docker compose run --rm --no-deps -T release < /dev/null > release.log 2>&1) || { cat release.log; exit 1; }",
                ...migrationRecord(plan),
                "echo deployed",
              ],
              hex,
              image,
            );
          const record = (hex: string) => {
            try {
              return readFileSync(join(project.dir, schemaRecordPath(hex)), "utf8");
            } catch {
              return undefined;
            }
          };

          const first = deploy(HEX.v1, v1);
          expect(first.status, first.output).toBe(0);
          expect(first.output, first.output).toBe("deployed\n");
          expect(recordLines(record(HEX.v1))).toEqual(recordLines(c.records[0]));
          const before = columns(project, c);
          for (const column of c.added) expect(before).not.toContain(column);

          const next = deploy(HEX.v2, v2);
          expect(next.status, next.output).toBe(0);
          expect(next.output, next.output).toBe("deployed\n");
          expect(recordLines(record(HEX.v2))).toEqual(recordLines(c.records[1]));
          const after = columns(project, c);
          for (const column of c.added) expect(after).toContain(column);

          // The rollback from version 2 to 1: `.env` names version 2, which still runs.
          writeFileSync(join(project.dir, ".env"), `APP_IMAGE=${v2}\n`);
          const down = project.script(
            [
              'export APP_IMAGE="$IMAGE"',
              `target=${HEX.v1}`,
              `running=${HEX.v2}`,
              "if ! (",
              ...migrationDown(plan).map((line) => `        ${line}`),
              "      ); then echo 'the step failed'; exit 1; fi",
            ],
            HEX.v1,
            v1,
          );
          expect(
            down.status,
            `${down.output}\n${readFileSync(join(project.dir, "release.log"), "utf8")}`,
          ).toBe(0);
          expect(down.output).toBe(
            `OpsCrew migrated the database down with ${c.tool} to the migrations of the version rolled back to.\n`,
          );
          expect(columns(project, c)).toEqual(before);

          // The tool's own state went back too: version 1's status records as it did.
          const again = project.script(
            ['export APP_IMAGE="$IMAGE"', ...migrationRecord(plan), "echo recorded"],
            HEX.again,
            v1,
          );
          expect(again.output).toBe("recorded\n");
          expect(record(HEX.again)).toBe(record(HEX.v1));

          const secrets = [project.password, ...Object.values(c.env)].filter((v) => v.length >= 32);
          for (const text of [first.output, next.output, down.output, again.output]) {
            for (const value of secrets) expect(text).not.toContain(value);
          }
        } finally {
          // With the release profile: Laravel's project has no other service.
          spawnSync(
            "docker",
            [
              "compose",
              "--profile",
              "release",
              "down",
              "--volumes",
              "--remove-orphans",
              "--timeout",
              "5",
            ],
            {
              cwd: project.dir,
              env: project.env(),
              stdio: "ignore",
            },
          );
          spawnSync("docker", ["image", "rm", "-f", v2, v1], { stdio: "ignore" });
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  },
);
