import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDetails } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The seed detection and release command for the app in `files`. */
async function detectionOf(files: Record<string, string>, appDir?: string) {
  const root = await makeTree(files, "seed");
  roots.push(root);
  return detectProjectDetails(root, appDir === undefined ? {} : { appDir });
}

async function seedOf(files: Record<string, string>, appDir?: string) {
  const { seedCommand, seedNote } = (await detectionOf(files, appDir)).facts.build;
  return { command: seedCommand, note: seedNote };
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  prisma?: { seed: string };
}

/** An Express server with the given extra manifest fields. */
function server(manifest: Manifest): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "api",
      ...manifest,
      scripts: { start: "node server.js", ...manifest.scripts },
      dependencies: { express: "^5", ...manifest.dependencies },
    }),
    "package-lock.json": "{}",
    "server.js": "require('express')().listen(process.env.PORT)",
  };
}

describe("detectSeed", () => {
  it("prefers a db:seed or seed script, run with the project's package manager", async () => {
    expect(await seedOf(server({ scripts: { seed: "node seed.js" } }))).toEqual({
      command: "npm run seed",
    });
    expect(
      await seedOf(server({ scripts: { seed: "node a.js", "db:seed": "node b.js" } })),
    ).toEqual({ command: "npm run db:seed" });
  });

  it("keeps seed scripts out of the release command", async () => {
    const detection = await detectionOf(
      server({ scripts: { migrate: "node m.js && npm run seed", seed: "node s.js" } }),
    );
    expect(detection.facts.build.releaseCommand).toBeUndefined();
    expect(detection.facts.build.seedCommand).toBe("npm run seed");
  });

  it("Prisma: migrations.seed in prisma.config.ts, or prisma.seed in package.json", async () => {
    const deps = { devDependencies: { prisma: "^7" } };
    expect(
      await seedOf({
        ...server(deps),
        "prisma.config.ts":
          'export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" } });\n',
      }),
    ).toEqual({ command: "npx prisma db seed" });
    expect(await seedOf(server({ ...deps, prisma: { seed: "node prisma/seed.js" } }))).toEqual({
      command: "npx prisma db seed",
    });
    expect(
      await seedOf({
        ...server(deps),
        "prisma.config.ts": 'export default defineConfig({ migrations: { path: "m" } });\n',
      }),
    ).toEqual({});
  });

  it("Rails: bin/rails db:seed with db/seeds.rb", async () => {
    const rails = {
      Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 8.0.2"\ngem "pg"\n',
      "config/application.rb":
        "module Shop\n  class Application < Rails::Application\n  end\nend\n",
      "bin/rails": "#!/usr/bin/env ruby\n",
    };
    expect(await seedOf({ ...rails, "db/seeds.rb": "User.create!\n" })).toEqual({
      command: "bin/rails db:seed",
    });
    expect(await seedOf(rails)).toEqual({});
  });

  it("Laravel: php artisan db:seed --force with DatabaseSeeder.php", async () => {
    const laravel = {
      "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^12.0" } }),
      artisan: "#!/usr/bin/env php\n",
    };
    expect(await seedOf({ ...laravel, "database/seeders/DatabaseSeeder.php": "<?php\n" })).toEqual({
      command: "php artisan db:seed --force",
    });
    expect(await seedOf(laravel)).toEqual({});
  });

  it("Knex: npx knex seed:run with a seeds folder or seeds.directory", async () => {
    const deps = { dependencies: { knex: "^3", pg: "^8" } };
    expect(
      await seedOf({
        ...server(deps),
        "knexfile.js": "module.exports = { client: 'pg' };\n",
        "seeds/01_users.js": "exports.seed = async () => {};\n",
      }),
    ).toEqual({ command: "npx knex seed:run" });
    expect(
      await seedOf({
        ...server(deps),
        "db/knexfile.js": "module.exports = { client: 'pg', seeds: { directory: './data' } };\n",
        "db/data/01_users.js": "exports.seed = async () => {};\n",
      }),
    ).toEqual({ command: "cd db && npx knex seed:run" });
    expect(
      await seedOf({ ...server(deps), "knexfile.js": "module.exports = { client: 'pg' };\n" }),
    ).toEqual({});
  });

  it("Sequelize: npx sequelize-cli db:seed:all with seeders/ or seeders-path", async () => {
    const deps = { dependencies: { sequelize: "^6" }, devDependencies: { "sequelize-cli": "^6" } };
    expect(
      await seedOf({ ...server(deps), "seeders/20240101000000-demo.js": "module.exports = {};\n" }),
    ).toEqual({ command: "npx sequelize-cli db:seed:all" });
    expect(
      await seedOf({
        ...server(deps),
        ".sequelizerc":
          "const path = require('path');\nmodule.exports = { 'seeders-path': path.resolve('db', 'seeds') };\n",
        "db/seeds/20240101000000-demo.js": "module.exports = {};\n",
      }),
    ).toEqual({ command: "npx sequelize-cli db:seed:all" });
    expect(await seedOf(server(deps))).toEqual({});
  });

  it("AdonisJS: node ace db:seed with database/seeders, from the build output when built", async () => {
    const adonis = (build?: string) => ({
      ...server({
        dependencies: { "@adonisjs/core": "^6", "@adonisjs/lucid": "^21" },
        ...(build ? { scripts: { build } } : {}),
      }),
      "ace.js": "import 'ts-node-maintained/register/esm'\n",
      "database/seeders/main_seeder.ts": "export default class {}\n",
    });
    expect(await seedOf(adonis())).toEqual({ command: "node ace db:seed" });
    expect(await seedOf(adonis("node ace build"))).toEqual({
      command: "cd build && node ace db:seed",
    });
  });

  it("Django and Drizzle: no command, a note saying to set one", async () => {
    const django = await seedOf({
      "requirements.txt": "django==5.2\n",
      "manage.py": "import django\n",
      "shop/settings.py": "INSTALLED_APPS = []\n",
      "shop/wsgi.py": "from django.core.wsgi import get_wsgi_application\n",
    });
    expect(django.command).toBeUndefined();
    expect(django.note).toMatch(/Django.*--seed <command>/);

    const drizzle = await seedOf(
      server({
        dependencies: { "drizzle-orm": "^0.44" },
        devDependencies: { "drizzle-kit": "^0.31" },
      }),
    );
    expect(drizzle.command).toBeUndefined();
    expect(drizzle.note).toMatch(/Drizzle.*`db:seed` script/);
  });

  it("finds nothing for an app without seeds", async () => {
    expect(await seedOf(server({}))).toEqual({});
  });

  it("an app in a folder gets cd <dir> && …, like its release command", async () => {
    const fixture = fileURLToPath(new URL("./seed/__fixtures__/rails-in-folder/", import.meta.url));
    const detection = await detectProjectDetails(fixture, { appDir: "apps/shop" });
    expect(detection.facts.build.seedCommand).toBe("cd apps/shop && bin/rails db:seed");
  });
});
