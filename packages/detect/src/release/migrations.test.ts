import { MigrationsSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDetails } from "../index";
import { makeTree, removeTree } from "../test-helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The release command and down-migration commands detection gives the app in `files`. */
async function migrationsOf(files: Record<string, string>) {
  const root = await makeTree(files, "release-down");
  roots.push(root);
  const { build } = (await detectProjectDetails(root)).facts;
  if (build.migrations !== undefined) {
    expect(MigrationsSchema.parse(build.migrations)).toEqual(build.migrations);
  }
  return { command: build.releaseCommand, migrations: build.migrations };
}

/** An Express server with extra dependencies (`dev` for devDependencies) and scripts. */
function server(
  dependencies: Record<string, string>,
  dev: Record<string, string> = {},
  scripts: Record<string, string> = {},
): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "api",
      scripts: { start: "node server.js", ...scripts },
      dependencies: { express: "^5", ...dependencies },
      devDependencies: dev,
    }),
    "package-lock.json": "{}",
    "server.js": "require('express')().listen(process.env.PORT)",
  };
}

const DJANGO = {
  "requirements.txt": "Django==5.1\npsycopg[binary]\n",
  "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
  "mysite/settings.py": "WSGI_APPLICATION = 'mysite.wsgi.application'\n",
  "mysite/wsgi.py": "application = get_wsgi_application()\n",
};

const FLASK_APP = "from flask import Flask\napp = Flask(__name__)\n";

const RAILS = {
  Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 8.0.2"\ngem "pg"\n',
  "config/application.rb": "module Shop\n  class Application < Rails::Application\n  end\nend\n",
  "db/migrate/20240101000000_create_users.rb":
    "class CreateUsers < ActiveRecord::Migration[8.0]\nend\n",
};

describe("down migrations of the release command's tool", () => {
  it("Rails: db:version and db:migrate VERSION through bundle exec without bin/rails", async () => {
    expect((await migrationsOf(RAILS)).migrations).toEqual({
      tool: "rails",
      status: "bundle exec rails db:version",
      down: "bundle exec rails db:migrate VERSION={version}",
    });
  });

  it("Django: showmigrations --plan and migrate per app, from the folder of manage.py", async () => {
    expect(await migrationsOf(DJANGO)).toEqual({
      command: "python manage.py migrate --noinput",
      migrations: {
        tool: "django",
        status: "python manage.py showmigrations --plan",
        down: "python manage.py migrate {app} {name} --noinput",
      },
    });
    const inSrc = Object.fromEntries(
      Object.entries(DJANGO).map(([path, text]) =>
        path === "requirements.txt" ? [path, text] : [`src/${path}`, text],
      ),
    );
    expect((await migrationsOf(inSrc)).migrations).toEqual({
      tool: "django",
      status: "cd src && python manage.py showmigrations --plan",
      down: "cd src && python manage.py migrate {app} {name} --noinput",
    });
  });

  it("Alembic: current and downgrade, from the folder of alembic.ini", async () => {
    const found = await migrationsOf({
      "requirements.txt": "fastapi\nuvicorn\nsqlmodel\nalembic\n",
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      "db/alembic.ini": "[alembic]\n",
    });
    expect(found.migrations).toEqual({
      tool: "alembic",
      status: "cd db && alembic current",
      down: "cd db && alembic downgrade {version}",
    });
  });

  it("Flask-Migrate: db current and db downgrade with the release command's FLASK_APP", async () => {
    const app = {
      "requirements.txt": "Flask\nFlask-Migrate\ngunicorn\n",
      "run.py": FLASK_APP,
      "migrations/env.py": "",
    };
    expect(await migrationsOf({ ...app, Procfile: "web: gunicorn run:app\n" })).toEqual({
      command: "FLASK_APP=run:app flask db upgrade",
      migrations: {
        tool: "flask-migrate",
        status: "FLASK_APP=run:app flask db current",
        down: "FLASK_APP=run:app flask db downgrade {version}",
      },
    });
    expect(
      (await migrationsOf({ ...app, Procfile: "web: gunicorn 'run:create_app()'\n" })).migrations,
    ).toEqual({
      tool: "flask-migrate",
      status: "FLASK_APP='run:create_app()' flask db current",
      down: "FLASK_APP='run:create_app()' flask db downgrade {version}",
    });
    const found = await migrationsOf({
      "requirements.txt": "Flask\nFlask-Migrate\n",
      "app.py": FLASK_APP,
      "migrations/env.py": "",
    });
    expect(found.migrations).toEqual({
      tool: "flask-migrate",
      status: "flask db current",
      down: "flask db downgrade {version}",
    });
  });

  it("Knex: migrate:list and migrate:down, from the knexfile's folder", async () => {
    const app = server({ knex: "^3", pg: "^8" });
    expect(
      await migrationsOf({
        ...app,
        "knexfile.js": "module.exports = { client: 'pg' };",
        "migrations/20240101000000_init.js": "exports.up = () => {};",
      }),
    ).toEqual({
      command: "npx knex migrate:latest",
      migrations: {
        tool: "knex",
        status: "npx knex migrate:list",
        down: "npx knex migrate:down",
      },
    });
    expect(
      (
        await migrationsOf({
          ...app,
          "db/knexfile.js": "module.exports = { client: 'pg' };",
          "db/migrations/20240101000000_init.js": "exports.up = () => {};",
        })
      ).migrations,
    ).toEqual({
      tool: "knex",
      status: "cd db && npx knex migrate:list",
      down: "cd db && npx knex migrate:down",
    });
  });

  it("Sequelize: db:migrate:status and db:migrate:undo", async () => {
    expect(
      await migrationsOf({
        ...server({ sequelize: "^6", pg: "^8" }, { "sequelize-cli": "^6" }),
        "migrations/20240101000000-create-user.js": "module.exports = {};",
      }),
    ).toEqual({
      command: "npx sequelize-cli db:migrate",
      migrations: {
        tool: "sequelize",
        status: "npx sequelize-cli db:migrate:status",
        down: "npx sequelize-cli db:migrate:undo",
      },
    });
  });

  it("TypeORM: migration:show and migration:revert with the release command's binary and data source", async () => {
    const nest = (scripts: Record<string, string>, dev: Record<string, string> = {}) => ({
      "package.json": JSON.stringify({
        name: "api",
        scripts,
        dependencies: { "@nestjs/core": "^11", typeorm: "^0.3", pg: "^8" },
        devDependencies: { "@nestjs/cli": "^11", typescript: "^5", ...dev },
      }),
      "package-lock.json": "{}",
      "src/main.ts": "async function bootstrap() {}\nbootstrap();\n",
      "src/data-source.ts":
        'import { DataSource } from "typeorm";\nexport default new DataSource({ type: "postgres", migrations: ["dist/migrations/*.js"] });\n',
      "src/migrations/1700000000000-Init.ts": "export class Init1700000000000 {}\n",
      "tsconfig.json": '{ "compilerOptions": { "outDir": "./dist" } }',
    });
    expect(
      await migrationsOf(nest({ build: "nest build", "start:prod": "node dist/main" })),
    ).toEqual({
      command: "npx typeorm migration:run -d dist/data-source.js",
      migrations: {
        tool: "typeorm",
        status: "npx typeorm migration:show -d dist/data-source.js",
        down: "npx typeorm migration:revert -d dist/data-source.js",
      },
    });
    expect(
      (await migrationsOf(nest({ start: "ts-node src/main.ts" }, { "ts-node": "^10" }))).migrations,
    ).toEqual({
      tool: "typeorm",
      status: "npx typeorm-ts-node-commonjs migration:show -d src/data-source.ts",
      down: "npx typeorm-ts-node-commonjs migration:revert -d src/data-source.ts",
    });
  });

  it("Laravel: migrate:status and migrate:rollback --step", async () => {
    expect(
      await migrationsOf({
        "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^12.0" } }),
        artisan: "#!/usr/bin/env php\n",
        "database/migrations/0001_01_01_000000_create_users_table.php": "<?php\n",
      }),
    ).toEqual({
      command: "php artisan migrate --force",
      migrations: {
        tool: "laravel",
        status: "php artisan migrate:status",
        down: "php artisan migrate:rollback --step={count} --force",
      },
    });
  });

  it("gives none when a tool's command is left out of the plan", async () => {
    expect(
      await migrationsOf({
        "requirements.txt": "fastapi\nuvicorn\n",
        "requirements-dev.txt": "alembic\n",
        "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
        "alembic.ini": "[alembic]\n",
      }),
    ).toEqual({ command: undefined, migrations: undefined });
  });
});

describe("tools without down migrations in a rollback", () => {
  it.each([
    [
      "Prisma",
      {
        ...server({ "@prisma/client": "^6" }, { prisma: "^6" }),
        "prisma/schema.prisma": 'datasource db { provider = "postgresql" }\n',
        "prisma/migrations/20240101000000_init/migration.sql": "CREATE TABLE a (id int);\n",
      },
    ],
    [
      "Flask-DB",
      {
        "requirements.txt": "Flask\nFlask-DB\n",
        "app.py": FLASK_APP,
        "db/env.py": "",
      },
    ],
    [
      "a package.json migrate script running Knex",
      {
        ...server({ knex: "^3", pg: "^8" }, {}, { migrate: "knex migrate:latest" }),
        "knexfile.js": "module.exports = { client: 'pg' };",
        "migrations/20240101000000_init.js": "exports.up = () => {};",
      },
    ],
    [
      "a Procfile release line running Django",
      { ...DJANGO, Procfile: "release: python manage.py migrate\n" },
    ],
  ])("%s: a release command without migrations", async (_name, files) => {
    const found = await migrationsOf(files);
    expect(found.command).toBeDefined();
    expect(found.migrations).toBeUndefined();
  });
});
