import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDetails } from "../index";
import { makeTree, removeTree } from "../test-helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The release command, note and down migrations detection gives the app in `files`. */
async function releaseOf(files: Record<string, string>) {
  const root = await makeTree(files, "release-py");
  roots.push(root);
  const detection = await detectProjectDetails(root);
  const { build } = detection.facts;
  return { command: build.releaseCommand, note: build.releaseNote, migrations: build.migrations };
}

const FASTAPI = "from fastapi import FastAPI\napp = FastAPI()\n";

describe("Python release commands", () => {
  it("upgrades Alembic in a SQLModel app", async () => {
    const app = {
      "requirements.txt": "fastapi\nuvicorn\nsqlmodel\nalembic\npsycopg[binary]\n",
      "main.py": FASTAPI,
    };
    expect(
      await releaseOf({
        ...app,
        "alembic.ini": "[alembic]\nscript_location = migrations\n",
        "migrations/env.py": "from sqlmodel import SQLModel\n",
        "migrations/versions/0001_init.py": "revision = '0001'\n",
      }),
    ).toEqual({
      command: "alembic upgrade head",
      note: undefined,
      migrations: {
        tool: "alembic",
        status: "alembic current",
        down: "alembic downgrade {version}",
      },
    });
    expect(await releaseOf(app)).toEqual({ command: undefined, note: undefined });
  });

  describe("Alembic migrations with several heads", () => {
    /** A migration file in Alembic's generated form (`typed` adds Alembic 1.13's annotations). */
    const revision = (id: string, down: string, typed = false) =>
      typed
        ? `"""Revision ID: ${id}"""\nrevision: str = "${id}"\ndown_revision: Union[str, Sequence[str], None] = ${down}\nbranch_labels = None\n`
        : `"""Revision ID: ${id}\nRevises: \n"""\nrevision = '${id}'\ndown_revision = ${down}\n`;
    const base = { "a1_init.py": revision("a1", "None"), "b2_users.py": revision("b2", "'a1'") };
    const twoHeads = { ...base, "c3_posts.py": revision("c3", '"a1"', true) };
    const merged = {
      ...twoHeads,
      "d4_merge.py": `revision = "d4"\ndown_revision = (\n    "b2",\n    "c3",\n)\n`,
    };
    const NOTE =
      "This app's Alembic migrations have several heads (branches of migrations), so OpsCrew runs `CMD`. Down migrations aren't offered for it yet: a rollback can restore a snapshot or keep the database.";

    const alembic = (versions: Record<string, string>) =>
      releaseOf({
        "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\nalembic\n",
        "main.py": FASTAPI,
        "db/alembic.ini": "[alembic]\nscript_location = migrations\n",
        "db/migrations/env.py": "",
        ...Object.fromEntries(
          Object.entries(versions).map(([name, text]) => [`db/migrations/versions/${name}`, text]),
        ),
      });
    const flask = (versions: Record<string, string>) =>
      releaseOf({
        "requirements.txt": "Flask\nFlask-Migrate\ngunicorn\n",
        "run.py": "from flask import Flask\napp = Flask(__name__)\n",
        Procfile: "web: gunicorn run:app\n",
        "migrations/env.py": "",
        ...Object.fromEntries(
          Object.entries(versions).map(([name, text]) => [`migrations/versions/${name}`, text]),
        ),
      });

    it("Alembic: one head keeps upgrade head, several run upgrade heads with a note", async () => {
      const oneHead = {
        command: "cd db && alembic upgrade head",
        note: undefined,
        migrations: {
          tool: "alembic",
          status: "cd db && alembic current",
          down: "cd db && alembic downgrade {version}",
        },
      };
      expect(await alembic(base)).toEqual(oneHead);
      expect(await alembic(twoHeads)).toEqual({
        command: "cd db && alembic upgrade heads",
        note: { atStartup: false, text: NOTE.replace("CMD", "alembic upgrade heads") },
        migrations: undefined,
      });
      expect(await alembic(merged)).toEqual(oneHead);
    });

    it("Alembic: reads the folders version_locations names", async () => {
      const modules = (ini: string, files: Record<string, string>) =>
        releaseOf({
          "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\nalembic\n",
          "main.py": FASTAPI,
          "db/alembic.ini": `[alembic]\nscript_location = migrations\n${ini}`,
          "db/migrations/env.py": "",
          ...files,
        });
      const billing = {
        "db/billing/b1_init.py": revision("b1", "None"),
        "db/billing/b2_invoices.py": revision("b2", "'b1'"),
      };
      const twoBases = await modules(
        "version_path_separator = ;\nversion_locations = %(here)s/billing;shop\n",
        { ...billing, "db/shop/s1_init.py": revision("s1", "None", true) },
      );
      expect(twoBases).toEqual({
        command: "cd db && alembic upgrade heads",
        note: { atStartup: false, text: NOTE.replace("CMD", "alembic upgrade heads") },
        migrations: undefined,
      });
      const oneFolder = await modules("version_locations = %(here)s/billing\n", billing);
      expect(oneFolder.command).toBe("cd db && alembic upgrade head");
      expect(oneFolder.note).toBeUndefined();
      expect(oneFolder.migrations?.tool).toBe("alembic");
    });

    it("Flask-Migrate: several heads run flask db upgrade heads with the same FLASK_APP", async () => {
      const oneHead = {
        command: "FLASK_APP=run:app flask db upgrade",
        note: undefined,
        migrations: {
          tool: "flask-migrate",
          status: "FLASK_APP=run:app flask db current",
          down: "FLASK_APP=run:app flask db downgrade {version}",
        },
      };
      expect(await flask(base)).toEqual(oneHead);
      const command = "FLASK_APP=run:app flask db upgrade heads";
      expect(await flask(twoHeads)).toEqual({
        command,
        note: { atStartup: false, text: NOTE.replace("CMD", command) },
        migrations: undefined,
      });
      expect(await flask(merged)).toEqual(oneHead);
    });
  });

  it("leaves out a tool the image would not install, saying why", async () => {
    const found = await releaseOf({
      "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\n",
      "requirements-dev.txt": "alembic\npytest\n",
      "main.py": FASTAPI,
      "alembic.ini": "[alembic]\n",
    });
    expect(found.command).toBeUndefined();
    expect(found.note?.atStartup).toBe(false);
    expect(found.note?.text).toContain("alembic is only a development dependency");
    expect(found.note?.text).toContain("app.releaseCommand");
  });

  it("migrates Masonite apps with databases/migrations", async () => {
    const app = {
      "requirements.txt": "masonite>=4,<5\nmasonite-orm\n",
      craft: "#!/usr/bin/env python\n",
      "wsgi.py": "application = None\n",
    };
    expect(
      await releaseOf({
        ...app,
        "databases/migrations/2024_01_01_000000_create_users_table.py": "class X: pass\n",
      }),
    ).toMatchObject({ command: "python craft migrate --force", migrations: undefined });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("upgrades Aerich apps configured in pyproject.toml", async () => {
    const pyproject = [
      "[project]",
      'name = "api"',
      'dependencies = ["fastapi", "tortoise-orm", "aerich"]',
      "",
      "[tool.aerich]",
      'tortoise_orm = "app.db.TORTOISE_ORM"',
      'location = "./migrations"',
      'src_folder = "./."',
      "",
    ].join("\n");
    const app = { "pyproject.toml": pyproject, "app/main.py": FASTAPI };
    expect(
      await releaseOf({
        ...app,
        "migrations/models/0_20240101000000_init.py": "async def upgrade(db): ...\n",
      }),
    ).toMatchObject({ command: "aerich upgrade", migrations: undefined });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("runs Tortoise ORM's own migrations when pyproject.toml configures them", async () => {
    const pyproject = (tool: string) =>
      `[project]\nname = "api"\ndependencies = ["fastapi", "tortoise-orm"]\n${tool}`;
    const migration = { "app/migrations/0001_initial.py": "class Migration: ...\n" };
    expect(
      await releaseOf({
        "pyproject.toml": pyproject(
          '\n[tool.tortoise]\napps = { models = { models = ["app.models"] } }\n',
        ),
        "app/main.py": FASTAPI,
        ...migration,
      }),
    ).toMatchObject({ command: "tortoise migrate", migrations: undefined });
    expect(
      (await releaseOf({ "pyproject.toml": pyproject(""), "app/main.py": FASTAPI, ...migration }))
        .command,
    ).toBeUndefined();
  });

  it("runs Piccolo migrations forwards from the folder holding piccolo_conf.py", async () => {
    const app = {
      "requirements.txt": "piccolo[postgres]\nstarlette\nuvicorn\n",
      "piccolo_conf.py": "DB = None\n",
      "home/piccolo_app.py": "APP_CONFIG = None\n",
    };
    expect(
      await releaseOf({
        ...app,
        "home/piccolo_migrations/home_2024_01_01t00_00_00_000000.py": "ID = '1'\n",
      }),
    ).toMatchObject({ command: "piccolo migrations forwards all", migrations: undefined });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("applies Yoyo migrations in batch mode with a postgresql:// URL and their folder", async () => {
    const app = { "requirements.txt": "flask\nyoyo-migrations\npsycopg2\n", "app.py": FASTAPI };
    const migration = { "migrations/0001.create-users.sql": "CREATE TABLE users (id int);\n" };
    const database = `"$(printf %s "$DATABASE_URL" | sed 's#^postgres://#postgresql://#')"`;
    expect(
      await releaseOf({ ...app, ...migration, "yoyo.ini": "[DEFAULT]\nsources = migrations\n" }),
    ).toMatchObject({
      command: `yoyo apply --batch --database ${database} migrations`,
      migrations: undefined,
    });
    expect(
      await releaseOf({
        ...app,
        "db/yoyo.ini": "[DEFAULT]\nsources = %(here)s/steps\ndatabase = postgresql:///app\n",
        "db/steps/0001.create-users.sql": "CREATE TABLE users (id int);\n",
      }),
    ).toMatchObject({
      command: `cd db && yoyo apply --batch --database ${database} steps`,
      migrations: undefined,
    });
    // Without yoyo.ini: a migrations folder of Python steps that import yoyo.
    expect(
      await releaseOf({
        ...app,
        "migrations/0001_users.py": "from yoyo import step\nsteps = [step('CREATE TABLE a()')]\n",
      }),
    ).toMatchObject({
      command: `yoyo apply --batch --database ${database} migrations`,
      migrations: undefined,
    });
    expect((await releaseOf({ ...app, ...migration })).command).toBeUndefined();
  });

  it("the Yoyo URL rewrite works in POSIX sh", async () => {
    const { execFileSync } = await import("node:child_process");
    const database = `"$(printf %s "$DATABASE_URL" | sed 's#^postgres://#postgresql://#')"`;
    let output: string;
    try {
      output = execFileSync("sh", ["-c", `printf '%s\\n' ${database}`], {
        env: { ...process.env, DATABASE_URL: "postgres://app@db:5432/app" },
        encoding: "utf8",
      });
    } catch {
      return; // No POSIX shell here; the string itself is checked above.
    }
    expect(output.trim()).toBe("postgresql://app@db:5432/app");
  });

  it("migrates peewee-migrate apps with numbered migrations", async () => {
    const app = { "requirements.txt": "flask\npeewee\npeewee-migrate\n", "app.py": FASTAPI };
    expect(
      await releaseOf({
        ...app,
        "migrations/001_initial.py": "def migrate(m, d, fake=False): ...\n",
      }),
    ).toMatchObject({
      command: 'pw_migrate migrate --database "$DATABASE_URL" --directory migrations',
      migrations: undefined,
    });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("runs a tool from the app folder of a repository", async () => {
    const pyproject =
      '[project]\nname = "api"\ndependencies = ["fastapi", "tortoise-orm", "aerich"]\n\n[tool.aerich]\ntortoise_orm = "db.TORTOISE_ORM"\n';
    const found = await releaseOf({
      "backend/pyproject.toml": pyproject,
      "backend/main.py": FASTAPI,
      "backend/migrations/models/0_20240101000000_init.py": "",
      "frontend/index.html": "<html></html>",
    });
    expect(found.command).toBe("cd backend && aerich upgrade");
  });
});
