import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDetails } from "../index";
import { makeTree, removeTree } from "../test-helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The release command and note detection gives the app in `files`. */
async function releaseOf(files: Record<string, string>) {
  const root = await makeTree(files, "release-native");
  roots.push(root);
  const detection = await detectProjectDetails(root);
  return { command: detection.facts.build.releaseCommand, note: detection.facts.build.releaseNote };
}

/** Expects a note about migrations the app runs when it starts, containing `text`. */
async function expectStartup(files: Record<string, string>, text: string) {
  const found = await releaseOf(files);
  expect(found.command).toBeUndefined();
  expect(found.note?.atStartup).toBe(true);
  expect(found.note?.text).toContain(text);
  expect(found.note?.text).toContain("app.releaseCommand");
}

const NONE = { command: undefined, note: undefined };

describe("Ruby release commands", () => {
  const rails = {
    Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 8.0.2"\ngem "pg"\n',
    "config/application.rb": "module Shop\n  class Application < Rails::Application\n  end\nend\n",
    "bin/rails": "#!/usr/bin/env ruby\n",
  };

  it("Rails: bin/rails db:migrate with db/migrate", async () => {
    expect(
      await releaseOf({
        ...rails,
        "db/migrate/20240101000000_create_users.rb": "class CreateUsers; end\n",
      }),
    ).toEqual({ command: "bin/rails db:migrate", note: undefined });
    expect(await releaseOf(rails)).toEqual(NONE);
  });

  it("Hanami: hanami db migrate with config/db/migrate", async () => {
    const hanami = {
      Gemfile: 'gem "hanami", "~> 2.2"\ngem "hanami-db"\ngem "pg"\n',
      "config/app.rb": "",
    };
    expect(
      await releaseOf({
        ...hanami,
        "config/db/migrate/20240101000000_create_books.rb": "ROM::SQL.migration do\nend\n",
      }),
    ).toMatchObject({ command: "bundle exec hanami db migrate" });
    expect(await releaseOf(hanami)).toEqual(NONE);
  });

  it("Sequel: sequel -m with the migrations folder", async () => {
    const sinatra = { Gemfile: 'gem "sinatra"\ngem "sequel"\ngem "pg"\n', "app.rb": "" };
    expect(
      await releaseOf({
        ...sinatra,
        "db/migrations/001_create_users.rb": "Sequel.migration do\nend\n",
      }),
    ).toMatchObject({ command: 'bundle exec sequel -m db/migrations "$DATABASE_URL"' });
    expect(await releaseOf(sinatra)).toEqual(NONE);
  });
});

describe("PHP release commands", () => {
  it("Laravel: artisan migrate --force", async () => {
    const laravel = {
      "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^12.0" } }),
      artisan: "#!/usr/bin/env php\n",
    };
    expect(
      await releaseOf({
        ...laravel,
        "database/migrations/0001_01_01_000000_create_users_table.php": "<?php\n",
      }),
    ).toMatchObject({ command: "php artisan migrate --force" });
    expect(await releaseOf(laravel)).toEqual(NONE);
  });

  it("Symfony: doctrine:migrations:migrate without interaction", async () => {
    const symfony = {
      "composer.json": JSON.stringify({
        require: {
          "symfony/framework-bundle": "7.3.*",
          "doctrine/doctrine-migrations-bundle": "^3.4",
        },
      }),
      "bin/console": "#!/usr/bin/env php\n",
    };
    expect(
      await releaseOf({ ...symfony, "migrations/Version20240101000000.php": "<?php\n" }),
    ).toMatchObject({ command: "php bin/console doctrine:migrations:migrate --no-interaction" });
    expect(await releaseOf(symfony)).toEqual(NONE);
  });
});

describe("Go release commands", () => {
  const goMod = (requires: string) =>
    `module example.com/api\n\ngo 1.24\n\nrequire (\n${requires}\n)\n`;
  const main = "package main\n\nfunc main() {}\n";

  it("goose: -dir with the annotated SQL files", async () => {
    const app = { "go.mod": goMod("\tgithub.com/pressly/goose/v3 v3.24.0"), "main.go": main };
    expect(
      await releaseOf({
        ...app,
        "db/migrations/20240101000000_init.sql":
          "-- +goose Up\nCREATE TABLE a();\n-- +goose Down\nDROP TABLE a;\n",
      }),
    ).toMatchObject({ command: 'goose -dir db/migrations postgres "$DATABASE_URL" up' });
    expect(await releaseOf(app)).toEqual(NONE);
  });

  it("golang-migrate: -path with the .up.sql files", async () => {
    const app = { "go.mod": goMod("\tgithub.com/jackc/pgx/v5 v5.7.0"), "main.go": main };
    expect(
      await releaseOf({
        ...app,
        "migrations/000001_init.up.sql": "CREATE TABLE a();",
        "migrations/000001_init.down.sql": "DROP TABLE a;",
      }),
    ).toMatchObject({ command: 'migrate -path migrations -database "$DATABASE_URL" up' });
    expect(await releaseOf(app)).toEqual(NONE);
  });

  it("GORM AutoMigrate and goose.Up at startup: a note", async () => {
    await expectStartup(
      {
        "go.mod": goMod("\tgorm.io/gorm v1.30.0"),
        "main.go": "package main\n\nfunc main() {\n\tdb.AutoMigrate(&User{})\n}\n",
      },
      "AutoMigrate",
    );
    await expectStartup(
      {
        "go.mod": goMod("\tgithub.com/pressly/goose/v3 v3.24.0"),
        "main.go": 'package main\n\nfunc main() {\n\tgoose.Up(db, "migrations")\n}\n',
        "migrations/00001_init.sql": "-- +goose Up\nCREATE TABLE a();\n",
      },
      "goose.Up",
    );
    // GORM without AutoMigrate: nothing to say.
    expect(await releaseOf({ "go.mod": goMod("\tgorm.io/gorm v1.30.0"), "main.go": main })).toEqual(
      NONE,
    );
  });

  it("Atlas: migrate apply with the folder holding atlas.sum", async () => {
    const app = {
      "go.mod": goMod("\tariga.io/atlas v0.36.0"),
      "main.go": main,
      "atlas.hcl": "env {}\n",
    };
    expect(
      await releaseOf({
        ...app,
        "migrations/20240101000000.sql": "CREATE TABLE a();",
        "migrations/atlas.sum": "h1:x\n",
      }),
    ).toMatchObject({ command: 'atlas migrate apply --url "$DATABASE_URL"' });
    expect(
      await releaseOf({
        ...app,
        "db/migrations/20240101000000.sql": "",
        "db/migrations/atlas.sum": "h1:x\n",
      }),
    ).toMatchObject({
      command: 'atlas migrate apply --url "$DATABASE_URL" --dir file://db/migrations',
    });
    expect(await releaseOf(app)).toEqual(NONE);
  });
});

describe("Rust release commands", () => {
  const cargo = (deps: string) =>
    `[package]\nname = "api"\nversion = "0.1.0"\n\n[dependencies]\n${deps}\n`;
  const main = "fn main() {}\n";

  it("Diesel: migration run with up.sql folders", async () => {
    const app = {
      "Cargo.toml": cargo('diesel = { version = "2", features = ["postgres"] }'),
      "src/main.rs": main,
    };
    expect(
      await releaseOf({
        ...app,
        "diesel.toml": '[print_schema]\nfile = "src/schema.rs"\n',
        "migrations/2024-01-01-000000_create_posts/up.sql": "CREATE TABLE posts();",
        "migrations/2024-01-01-000000_create_posts/down.sql": "DROP TABLE posts;",
      }),
    ).toMatchObject({ command: "diesel migration run" });
    expect(await releaseOf(app)).toEqual(NONE);
  });

  it("sqlx: migrate run, or a note when the code embeds sqlx::migrate!", async () => {
    const app = {
      "Cargo.toml": cargo('sqlx = { version = "0.8", features = ["postgres"] }'),
      "src/main.rs": main,
    };
    const migration = { "migrations/20240101000000_init.sql": "CREATE TABLE a();" };
    expect(await releaseOf({ ...app, ...migration })).toMatchObject({
      command: "sqlx migrate run",
    });
    await expectStartup(
      {
        ...app,
        ...migration,
        "src/main.rs": 'fn main() { sqlx::migrate!("./migrations").run(&pool); }\n',
      },
      "sqlx::migrate!",
    );
    expect(await releaseOf(app)).toEqual(NONE);
  });

  it("SeaORM: the migration crate, or a note when the app runs Migrator::up", async () => {
    const app = { "Cargo.toml": cargo('sea-orm = "1"'), "src/main.rs": main };
    const crate = {
      "migration/Cargo.toml": '[package]\nname = "migration"\n',
      "migration/src/lib.rs": "pub struct Migrator;\n",
      "migration/src/m20220101_000001_create_table.rs": "",
    };
    expect(await releaseOf({ ...app, ...crate })).toMatchObject({
      command: "sea-orm-cli migrate up",
    });
    await expectStartup(
      { ...app, ...crate, "src/main.rs": "async fn main() { Migrator::up(&db, None).await; }\n" },
      "Migrator::up",
    );
    expect(await releaseOf(app)).toEqual(NONE);
  });
});

describe("Elixir, .NET and Java release commands", () => {
  const mix =
    'defmodule MyApp.MixProject do\n  def project, do: [app: :my_app, version: "0.1.0"]\n  defp deps, do: [{:phoenix, "~> 1.8"}, {:ecto_sql, "~> 3.13"}]\nend\n';
  const migration = { "priv/repo/migrations/20240101000000_create_users.exs": "" };

  it("Phoenix: the release module, else mix ecto.migrate (mix.exs matched as text)", async () => {
    const release = "defmodule MyApp.Release do\n  def migrate do\n    load_app()\n  end\nend\n";
    expect(
      await releaseOf({ "mix.exs": mix, ...migration, "lib/my_app/release.ex": release }),
    ).toMatchObject({ command: 'bin/my_app eval "MyApp.Release.migrate"' });
    expect(await releaseOf({ "mix.exs": mix, ...migration })).toMatchObject({
      command: "mix ecto.migrate",
    });
    await expectStartup(
      {
        "mix.exs": mix,
        ...migration,
        "lib/my_app/application.ex": "children = [MyApp.Repo, {Ecto.Migrator, repos: repos()}]\n",
      },
      "Ecto.Migrator",
    );
    expect(await releaseOf({ "mix.exs": mix })).toEqual(NONE);
  });

  it("EF Core: dotnet ef database update from the project folder (csproj matched as text)", async () => {
    const api = {
      "Api/Api.csproj":
        '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <ItemGroup>\n    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.0" />\n  </ItemGroup>\n</Project>\n',
      "Api/Program.cs": "var app = builder.Build();\napp.Run();\n",
    };
    const snapshot = {
      "Api/Migrations/AppDbContextModelSnapshot.cs": "partial class AppDbContextModelSnapshot {}",
    };
    expect(await releaseOf({ ...api, ...snapshot })).toMatchObject({
      command: "cd Api && dotnet ef database update",
    });
    await expectStartup(
      { ...api, ...snapshot, "Api/Program.cs": "db.Database.Migrate();\napp.Run();\n" },
      "Database.Migrate()",
    );
    expect(await releaseOf(api)).toEqual(NONE);
  });

  it("Spring Boot with Flyway or Liquibase migrates at startup: a note", async () => {
    const pom = (dependency: string) =>
      `<project>\n  <parent><artifactId>spring-boot-starter-parent</artifactId></parent>\n  <dependencies>\n    <dependency><artifactId>${dependency}</artifactId></dependency>\n  </dependencies>\n</project>\n`;
    await expectStartup(
      {
        "pom.xml": pom("flyway-core"),
        "src/main/resources/db/migration/V1__init.sql": "CREATE TABLE a();",
      },
      "Flyway",
    );
    await expectStartup(
      {
        "build.gradle.kts":
          'plugins { id("org.springframework.boot") version "3.5.0" }\ndependencies { implementation("org.liquibase:liquibase-core") }\n',
        "src/main/resources/db/changelog/db.changelog-master.yaml": "databaseChangeLog: []\n",
      },
      "Liquibase",
    );
    expect(await releaseOf({ "pom.xml": pom("flyway-core") })).toEqual(NONE);
  });
});
