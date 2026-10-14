import { afterEach, describe, expect, it } from "vitest";
import { detectProjectDetails } from "../index";
import { makeTree, removeTree } from "../test-helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

/** The release command and note detection gives the app in `files`. */
async function releaseOf(files: Record<string, string>, appDir?: string) {
  const root = await makeTree(files, "release-node");
  roots.push(root);
  const detection = await detectProjectDetails(root, appDir === undefined ? {} : { appDir });
  return { command: detection.facts.build.releaseCommand, note: detection.facts.build.releaseNote };
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  type?: string;
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

const DRIZZLE_CONFIG =
  'import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./src/db/schema.ts", out: "./drizzle" });\n';

describe("package.json migrate scripts", () => {
  const drizzle = {
    "drizzle.config.ts": DRIZZLE_CONFIG,
    "drizzle/0000_init.sql": "CREATE TABLE users (id serial);",
  };
  const deps = {
    dependencies: { "drizzle-orm": "^0.44" },
    devDependencies: { "drizzle-kit": "^0.31" },
  };

  it("prefers an explicit migrate script over the guessed command, in order", async () => {
    expect(
      await releaseOf({
        ...server({
          ...deps,
          scripts: { "db:migrate": "drizzle-kit migrate", migrate: "node m.js" },
        }),
        ...drizzle,
      }),
    ).toMatchObject({ command: "npm run migrate" });
    expect(
      await releaseOf({
        ...server({
          ...deps,
          scripts: { "migrate:prod": "x", "migrate:deploy": "drizzle-kit migrate" },
        }),
        ...drizzle,
      }),
    ).toMatchObject({ command: "npm run migrate:deploy" });
  });

  it("skips scripts that generate, reset or push a schema", async () => {
    expect(
      await releaseOf({
        ...server({
          ...deps,
          scripts: { migrate: "prisma migrate dev", "db:migrate": "drizzle-kit push" },
        }),
        ...drizzle,
      }),
    ).toMatchObject({ command: "npx drizzle-kit migrate" });
  });

  it("runs the script with the app's package manager and keeps the Procfile first", async () => {
    const files = {
      ...server({ scripts: { "db:migrate": "node scripts/migrate.js" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    };
    expect(await releaseOf(files)).toMatchObject({ command: "pnpm run db:migrate" });
    expect(await releaseOf({ ...files, Procfile: "release: node seed.js\n" })).toMatchObject({
      command: "node seed.js",
    });
  });

  it("runs a monorepo member's script through the workspace", async () => {
    const found = await releaseOf({
      "package.json": JSON.stringify({ name: "repo", private: true, workspaces: ["apps/*"] }),
      "package-lock.json": "{}",
      "apps/api/package.json": JSON.stringify({
        name: "api",
        scripts: { start: "node server.js", migrate: "knex migrate:latest" },
        dependencies: { express: "^5", knex: "^3" },
      }),
      "apps/api/server.js": "require('express')().listen(3000)",
    });
    expect(found.command).toBe("npm run migrate --workspace=apps/api");
  });

  /** Detection for an Express app with these scripts and no migration tool of its own. */
  async function withScripts(scripts: Record<string, string>) {
    return releaseOf(server({ scripts }));
  }

  /** Expects every script in `scripts` named in a warning note, and no command from them. */
  async function expectRejected(scripts: Record<string, string>, ...fragments: string[]) {
    const found = await withScripts(scripts);
    expect(found.command).toBeUndefined();
    expect(found.note?.atStartup).toBe(false);
    for (const name of Object.keys(scripts).filter((n) => n.includes("migrat"))) {
      expect(found.note?.text).toContain(`\`${name}\``);
    }
    for (const fragment of fragments) expect(found.note?.text).toContain(fragment);
    expect(found.note?.text).toContain("Deploys run no migrations.");
  }

  it("never plans a script that drops or resets data", async () => {
    await expectRejected(
      {
        migrate: "prisma migrate reset --force",
        "db:migrate": "drizzle-kit drop",
        "migrate:deploy": "knex migrate:fresh",
        "migrate:prod": "prisma db push --force-reset",
      },
      "migrate reset",
      "drizzle-kit drop",
    );
  });

  it("never plans a script that rolls back, undoes or reverts migrations", async () => {
    await expectRejected(
      {
        migrate: "knex migrate:rollback --all",
        "db:migrate": "sequelize-cli db:migrate:undo:all",
        "migrate:deploy": "typeorm migration:revert -d dist/data-source.js",
        "migrate:prod": "node-pg-migrate down",
      },
      "migrate:rollback",
      "migration:revert",
    );
  });

  it("never plans a script that syncs or pushes a schema", async () => {
    await expectRejected(
      { migrate: "typeorm schema:sync -d dist/ds.js", "db:migrate": "prisma db push" },
      "schema:sync",
      "db push",
    );
  });

  it("never plans a script that seeds", async () => {
    await expectRejected(
      { migrate: "sequelize-cli db:migrate && sequelize-cli db:seed:all" },
      "db:seed",
    );
  });

  it("judges the scripts a migrate script runs", async () => {
    await expectRejected({ migrate: "npm run db:reset && npm run db:push" }, "`db:reset`");
    await expectRejected(
      { migrate: "pnpm run prepare-db", "prepare-db": "prisma migrate reset --force" },
      "`prepare-db`",
    );
    // A delegated script that only applies migrations is fine.
    expect(
      await withScripts({ migrate: "yarn run apply", apply: "knex migrate:latest" }),
    ).toMatchObject({ command: "npm run migrate" });
  });

  it("skips a script that only starts a migration CLI and uses the tool's own command", async () => {
    const found = await releaseOf({
      ...server({
        dependencies: { "node-pg-migrate": "^8", pg: "^8" },
        scripts: { migrate: "node-pg-migrate" },
      }),
      "migrations/1700000000000_init.js": "exports.up = () => {};",
    });
    expect(found.command).toBe("npx node-pg-migrate up");
    expect(found.note?.text).toContain("only starts `node-pg-migrate`");
    expect(found.note?.text).toContain("Deploys run the detected migration command instead.");
  });
});

describe("Node.js migration tools", () => {
  it("Drizzle: migrates with the out folder of drizzle.config", async () => {
    const app = server({
      devDependencies: { "drizzle-kit": "^0.31" },
      dependencies: { "drizzle-orm": "^0.44" },
    });
    expect(
      await releaseOf({
        ...app,
        "drizzle.config.ts": DRIZZLE_CONFIG,
        "drizzle/0000_init.sql": "CREATE TABLE a();",
        "drizzle/meta/_journal.json": "{}",
      }),
    ).toMatchObject({ command: "npx drizzle-kit migrate" });
    expect(
      await releaseOf({
        ...app,
        "drizzle.config.js":
          'module.exports = { out: "./src/db/migrations", dialect: "postgresql" };',
        "src/db/migrations/0000_init.sql": "CREATE TABLE a();",
      }),
    ).toMatchObject({ command: "npx drizzle-kit migrate" });
    // `drizzle-kit push` apps have a config but no migrations.
    expect(
      (await releaseOf({ ...app, "drizzle.config.ts": DRIZZLE_CONFIG })).command,
    ).toBeUndefined();
  });

  const nest = (extra: Manifest = {}) => ({
    "package.json": JSON.stringify({
      name: "api",
      ...extra,
      scripts: { build: "nest build", "start:prod": "node dist/main", ...extra.scripts },
      dependencies: { "@nestjs/core": "^11", typeorm: "^0.3", pg: "^8", ...extra.dependencies },
      devDependencies: { "@nestjs/cli": "^11", typescript: "^5", ...extra.devDependencies },
    }),
    "package-lock.json": "{}",
    "src/main.ts": "async function bootstrap() {}\nbootstrap();\n",
    "src/data-source.ts":
      'import { DataSource } from "typeorm";\nexport default new DataSource({ type: "postgres", migrations: ["dist/migrations/*.js"] });\n',
    "src/migrations/1700000000000-Init.ts": "export class Init1700000000000 {}\n",
    "tsconfig.json":
      '{\n  // Nest defaults\n  "compilerOptions": { "outDir": "./dist", "baseUrl": "./", },\n}\n',
  });

  it("TypeORM: runs the compiled data source of a built TypeScript app", async () => {
    expect(await releaseOf(nest())).toMatchObject({
      command: "npx typeorm migration:run -d dist/data-source.js",
    });
    expect(
      await releaseOf({
        ...nest({ scripts: { "start:prod": "node build/server.js" } }),
        "tsconfig.json": '{ "compilerOptions": { "outDir": "build", "rootDir": "./src" } }',
      }),
    ).toMatchObject({ command: "npx typeorm migration:run -d build/data-source.js" });
  });

  it("TypeORM: falls back to ts-node, else says why it left the command out", async () => {
    const unbuilt = (extra: Manifest) => {
      const files = nest({ ...extra, scripts: { build: "", "start:prod": "" } });
      const pkg = JSON.parse(files["package.json"] as string);
      pkg.scripts = { start: "ts-node src/main.ts" };
      return { ...files, "package.json": JSON.stringify(pkg) };
    };
    expect(await releaseOf(unbuilt({ devDependencies: { "ts-node": "^10" } }))).toMatchObject({
      command: "npx typeorm-ts-node-commonjs migration:run -d src/data-source.ts",
    });
    expect(
      await releaseOf(unbuilt({ type: "module", devDependencies: { "ts-node": "^10" } })),
    ).toMatchObject({ command: "npx typeorm-ts-node-esm migration:run -d src/data-source.ts" });
    const leftOut = await releaseOf(unbuilt({}));
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("src/data-source.ts is TypeScript");
  });

  it("TypeORM: runs a JavaScript data source as it is", async () => {
    expect(
      await releaseOf({
        ...server({ dependencies: { typeorm: "^0.3" } }),
        "data-source.js":
          "const { DataSource } = require('typeorm');\nmodule.exports = new DataSource({});\n",
        "migrations/1700000000000-Init.js": "module.exports = class Init {};\n",
      }),
    ).toMatchObject({ command: "npx typeorm migration:run -d data-source.js" });
  });

  it("TypeORM: a compiled data source listing .ts migrations needs ts-node", async () => {
    const files = nest();
    const tsGlob = {
      "src/data-source.ts":
        'import { DataSource } from "typeorm";\nexport default new DataSource({ type: "postgres", migrations: ["src/migrations/*.ts"] });\n',
    };
    const leftOut = await releaseOf({ ...files, ...tsGlob });
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("as `.ts` files");
    const withTsNode = nest({ devDependencies: { "ts-node": "^10" } });
    expect(await releaseOf({ ...withTsNode, ...tsGlob })).toMatchObject({
      command: "npx typeorm-ts-node-commonjs migration:run -d src/data-source.ts",
    });
    // `__dirname` globs (or a `{ts,js}` alternative) find the compiled migrations.
    expect(
      await releaseOf({
        ...files,
        "src/data-source.ts":
          'export default new DataSource({ migrations: [__dirname + "/migrations/*.{ts,js}"] });\n',
      }),
    ).toMatchObject({ command: "npx typeorm migration:run -d dist/data-source.js" });
  });

  it("TypeORM: notes migrationsRun and needs migrations", async () => {
    const files = nest();
    const startup = await releaseOf({
      ...files,
      "src/data-source.ts": `${files["src/data-source.ts"]}// migrationsRun: true\nexport const options = { migrationsRun: true };\n`,
    });
    expect(startup.command).toBeUndefined();
    expect(startup.note?.atStartup).toBe(true);
    expect(startup.note?.text).toContain("migrationsRun: true");
    const { "src/migrations/1700000000000-Init.ts": _, ...noMigrations } = files;
    expect(await releaseOf(noMigrations)).toEqual({ command: undefined, note: undefined });
  });

  it("Sequelize without its CLI leaves same-named migrations to db-migrate", async () => {
    const migration = { "migrations/20240101000000-init.js": "exports.up = () => {};" };
    expect(
      await releaseOf({
        ...server({
          dependencies: { sequelize: "^6", "db-migrate": "^0.11", "db-migrate-pg": "^1" },
        }),
        ...migration,
      }),
    ).toEqual({ command: "npx db-migrate up", note: undefined });
    const alone = await releaseOf({
      ...server({ dependencies: { sequelize: "^6" } }),
      ...migration,
    });
    expect(alone.command).toBeUndefined();
    expect(alone.note?.text).toContain("sequelize-cli");
  });

  it("Sequelize: runs sequelize-cli with migrations, also from .sequelizerc paths", async () => {
    const app = server({
      dependencies: { sequelize: "^6", pg: "^8" },
      devDependencies: { "sequelize-cli": "^6" },
    });
    expect(
      await releaseOf({
        ...app,
        "migrations/20240101000000-create-user.js": "module.exports = {};",
      }),
    ).toMatchObject({ command: "npx sequelize-cli db:migrate" });
    expect(
      await releaseOf({
        ...app,
        ".sequelizerc":
          "const path = require('path');\nmodule.exports = { 'migrations-path': path.resolve('db', 'migrate') };\n",
        "db/migrate/20240101000000-create-user.js": "module.exports = {};",
      }),
    ).toMatchObject({ command: "npx sequelize-cli db:migrate" });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("Knex and Objection: migrate:latest from the knexfile's folder", async () => {
    const app = server({ dependencies: { knex: "^3", pg: "^8" } });
    expect(
      await releaseOf({
        ...app,
        "knexfile.js": "module.exports = { client: 'pg' };",
        "migrations/20240101000000_init.js": "exports.up = () => {};",
      }),
    ).toMatchObject({ command: "npx knex migrate:latest" });
    expect(
      await releaseOf({
        ...server({ dependencies: { knex: "^3", objection: "^3", pg: "^8" } }),
        "knexfile.js":
          "module.exports = { production: { client: 'pg', migrations: { directory: './db/migrations' } } };",
        "db/migrations/init.js": "exports.up = () => {};",
      }),
    ).toMatchObject({ command: "npx knex migrate:latest" });
    expect(
      (await releaseOf({ ...app, "knexfile.js": "module.exports = {};" })).command,
    ).toBeUndefined();
  });

  it("Knex: TypeScript migrations need ts-node even with a JavaScript knexfile", async () => {
    const files = (dev: Record<string, string>) => ({
      ...server({ dependencies: { knex: "^3" }, devDependencies: dev }),
      "knexfile.js": "module.exports = { client: 'pg' };",
      "migrations/20240101000000_init.ts": "export async function up() {}",
    });
    const leftOut = await releaseOf(files({}));
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("the migrations are TypeScript");
    expect(await releaseOf(files({ "ts-node": "^10" }))).toMatchObject({
      command: "npx knex migrate:latest",
    });
  });

  it("Knex: a TypeScript knexfile needs ts-node", async () => {
    const files = (dev: Record<string, string>) => ({
      ...server({ dependencies: { knex: "^3" }, devDependencies: dev }),
      "knexfile.ts": "export default { client: 'pg' };",
      "migrations/20240101000000_init.ts": "export async function up() {}",
    });
    expect(await releaseOf(files({ "ts-node": "^10" }))).toMatchObject({
      command: "npx knex migrate:latest",
    });
    const leftOut = await releaseOf(files({ tsx: "^4" }));
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("ts-node");
  });

  it("MikroORM: migration:up with the CLI package", async () => {
    const deps = {
      "@mikro-orm/core": "^6",
      "@mikro-orm/postgresql": "^6",
      "@mikro-orm/migrations": "^6",
    };
    const migration = { "migrations/Migration20240101000000.js": "exports.M = class {};" };
    expect(
      await releaseOf({
        ...server({ dependencies: deps, devDependencies: { "@mikro-orm/cli": "^6" } }),
        ...migration,
      }),
    ).toMatchObject({ command: "npx mikro-orm migration:up" });
    expect(
      (await releaseOf({ ...server({ dependencies: deps }), ...migration })).note?.text,
    ).toContain("@mikro-orm/cli");
    expect(
      (await releaseOf(server({ dependencies: deps, devDependencies: { "@mikro-orm/cli": "^6" } })))
        .command,
    ).toBeUndefined();
  });

  it("MikroORM: TypeScript migrations need compiled ones or a TypeScript loader", async () => {
    const deps = { "@mikro-orm/core": "^6", "@mikro-orm/migrations": "^6" };
    const app = (dev: Record<string, string>, config: string) => ({
      ...server({ dependencies: deps, devDependencies: { "@mikro-orm/cli": "^6", ...dev } }),
      "src/mikro-orm.config.ts": config,
      "src/migrations/Migration20240101000000.ts": "export class M {}",
    });
    const pathTsOnly = "export default { migrations: { pathTs: './src/migrations' } };";
    const leftOut = await releaseOf(app({}, pathTsOnly));
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("migrations.path");
    expect(
      await releaseOf(
        app(
          {},
          "export default { migrations: { path: './dist/migrations', pathTs: './src/migrations' } };",
        ),
      ),
    ).toMatchObject({ command: "npx mikro-orm migration:up" });
    expect(await releaseOf(app({ tsx: "^4" }, pathTsOnly))).toMatchObject({
      command: "npx mikro-orm migration:up",
    });
  });

  it("Kysely: kysely-ctl migrate:latest with its config", async () => {
    const app = {
      ...server({ dependencies: { kysely: "^0.28" }, devDependencies: { "kysely-ctl": "^0.13" } }),
      "kysely.config.ts":
        'import { defineConfig } from "kysely-ctl";\nexport default defineConfig({});\n',
    };
    expect(
      await releaseOf({
        ...app,
        "migrations/1700000000000_init.ts": "export async function up() {}",
      }),
    ).toMatchObject({ command: "npx kysely migrate:latest" });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("node-pg-migrate: TypeScript migrations need ts-node or tsx", async () => {
    const files = (dev: Record<string, string>) => ({
      ...server({ dependencies: { "node-pg-migrate": "^8", pg: "^8" }, devDependencies: dev }),
      "tsconfig.json": "{}",
      "migrations/1700000000000_init.ts": "export async function up() {}",
    });
    expect(await releaseOf(files({ "ts-node": "^10" }))).toMatchObject({
      command: "npx node-pg-migrate up --tsconfig tsconfig.json",
    });
    expect(await releaseOf(files({ tsx: "^4" }))).toMatchObject({
      command: 'NODE_OPTIONS="--import tsx" npx node-pg-migrate up',
    });
    const leftOut = await releaseOf(files({}));
    expect(leftOut.command).toBeUndefined();
    expect(leftOut.note?.text).toContain("neither ts-node nor tsx");
  });

  it("node-pg-migrate: up with timestamped migrations", async () => {
    const app = server({ dependencies: { "node-pg-migrate": "^8", pg: "^8" } });
    expect(
      await releaseOf({ ...app, "migrations/1700000000000_init.js": "exports.up = () => {};" }),
    ).toMatchObject({ command: "npx node-pg-migrate up" });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("db-migrate: up, in the production environment of database.json", async () => {
    const app = server({ dependencies: { "db-migrate": "^0.11", "db-migrate-pg": "^1" } });
    const migration = { "migrations/20240101000000-init.js": "exports.up = () => {};" };
    expect(await releaseOf({ ...app, ...migration })).toMatchObject({
      command: "npx db-migrate up",
    });
    expect(
      await releaseOf({
        ...app,
        ...migration,
        "database.json": '{ "dev": { "driver": "pg" }, "prod": { "driver": "pg" } }',
      }),
    ).toMatchObject({ command: "npx db-migrate up -e prod" });
    expect((await releaseOf(app)).command).toBeUndefined();
  });

  it("AdonisJS Lucid: migration:run --force, from the build output of a built app", async () => {
    const adonis = (scripts: Record<string, string>) => ({
      "package.json": JSON.stringify({
        name: "web",
        scripts: { start: "node bin/server.js", ...scripts },
        dependencies: { "@adonisjs/core": "^6", "@adonisjs/lucid": "^21", pg: "^8" },
      }),
      "ace.js": "import 'ts-node-maintained/register/esm'\n",
      "bin/server.js": "",
    });
    const migration = {
      "database/migrations/1700000000000_create_users_table.ts": "export default class {}",
    };
    expect(await releaseOf({ ...adonis({ build: "node ace build" }), ...migration })).toMatchObject(
      {
        command: "cd build && node ace migration:run --force",
      },
    );
    expect(await releaseOf({ ...adonis({}), ...migration })).toMatchObject({
      command: "node ace migration:run --force",
    });
    expect((await releaseOf(adonis({ build: "node ace build" }))).command).toBeUndefined();
  });

  it("Payload: payload migrate, unless the config runs prodMigrations", async () => {
    const payload = {
      "package.json": JSON.stringify({
        name: "cms",
        scripts: { build: "next build", start: "next start" },
        dependencies: { payload: "^3", next: "^15", "@payloadcms/db-postgres": "^3" },
      }),
      "src/payload.config.ts": "export default buildConfig({ db: postgresAdapter({}) });",
    };
    const migrations = {
      "src/migrations/20240101_000000.ts": "export async function up() {}",
      "src/migrations/index.ts": "export const migrations = [];",
    };
    expect(await releaseOf({ ...payload, ...migrations })).toMatchObject({
      command: "npx payload migrate",
    });
    const startup = await releaseOf({
      ...payload,
      ...migrations,
      "src/payload.config.ts":
        "import { migrations } from './migrations';\nexport default buildConfig({ db: postgresAdapter({ prodMigrations: migrations }) });",
    });
    expect(startup.command).toBeUndefined();
    expect(startup.note?.atStartup).toBe(true);
    expect((await releaseOf(payload)).command).toBeUndefined();
  });

  it("Medusa: db:migrate for Medusa 2, a note for Medusa 1", async () => {
    const medusa = (version: string) => ({
      "package.json": JSON.stringify({
        name: "store",
        scripts: { build: "medusa build", start: "medusa start" },
        dependencies: { "@medusajs/medusa": version, "@medusajs/framework": version },
      }),
    });
    expect(
      await releaseOf({
        ...medusa("2.8.0"),
        "medusa-config.ts": "module.exports = defineConfig({});",
      }),
    ).toMatchObject({ command: "npx medusa db:migrate --execute-safe-links" });
    const v1 = await releaseOf({
      ...medusa("^1.20.0"),
      "medusa-config.js": "module.exports = {};",
    });
    expect(v1.command).toBeUndefined();
    expect(v1.note?.text).toContain("Medusa 1");
    expect((await releaseOf(medusa("2.8.0"))).command).toBeUndefined();
  });

  it("KeystoneJS: deploys its Prisma migrations, through Keystone's Prisma unless prisma is a dependency", async () => {
    const keystone = (dependencies: Record<string, string>) => ({
      "package.json": JSON.stringify({
        name: "cms",
        scripts: { build: "keystone build", start: "keystone start" },
        dependencies: { "@keystone-6/core": "^6", ...dependencies },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "keystone.ts": "export default config({ db: { provider: 'postgresql' } });",
    });
    const migration = { "migrations/20240101000000_init/migration.sql": "CREATE TABLE a();" };
    expect(await releaseOf({ ...keystone({}), ...migration })).toEqual({
      command: "npx keystone prisma migrate deploy",
      note: undefined,
    });
    expect(await releaseOf({ ...keystone({ prisma: "^6" }), ...migration })).toEqual({
      command: "npx prisma migrate deploy",
      note: undefined,
    });
    expect((await releaseOf(keystone({}))).command).toBeUndefined();
  });

  it("Redwood: only for a Redwood app inside the redwood.toml folder", async () => {
    const legacy = {
      "legacy/redwood.toml": "[web]\n",
      "legacy/api/db/migrations/20240101000000_init/migration.sql": "CREATE TABLE a();",
    };
    expect(await releaseOf({ ...server({ dependencies: { pg: "^8" } }), ...legacy })).toEqual({
      command: undefined,
      note: undefined,
    });
    // Even with Redwood packages, a redwood.toml outside the app's folder chain is not its own.
    expect(
      (await releaseOf({ ...server({ dependencies: { "@redwoodjs/api": "8.0.0" } }), ...legacy }))
        .command,
    ).toBeUndefined();
  });

  it("Redwood: rw prisma migrate deploy from the project root", async () => {
    const redwood = {
      "package.json": JSON.stringify({
        private: true,
        workspaces: { packages: ["api", "web"] },
        devDependencies: { "@redwoodjs/core": "8.0.0" },
      }),
      "yarn.lock": "",
      "redwood.toml": "[web]\n  port = 8910\n[api]\n  port = 8911\n",
      "api/package.json": JSON.stringify({
        name: "api",
        dependencies: { "@redwoodjs/api": "8.0.0", "@redwoodjs/graphql-server": "8.0.0" },
      }),
      "api/db/schema.prisma": 'datasource db {\n  provider = "postgresql"\n}\n',
      "web/package.json": JSON.stringify({
        name: "web",
        dependencies: { "@redwoodjs/web": "8.0.0", react: "^18" },
      }),
    };
    // Detection deploys the api side by default.
    expect(
      await releaseOf({
        ...redwood,
        "api/db/migrations/20240101000000_init/migration.sql": "CREATE TABLE a();",
      }),
    ).toMatchObject({ command: "yarn rw prisma migrate deploy" });
    expect((await releaseOf(redwood)).command).toBeUndefined();
  });

  it("Strapi migrates at startup: a note, no command", async () => {
    const found = await releaseOf({
      "package.json": JSON.stringify({
        name: "cms",
        scripts: { build: "strapi build", start: "strapi start" },
        dependencies: { "@strapi/strapi": "^5", pg: "^8" },
      }),
    });
    expect(found.command).toBeUndefined();
    expect(found.note?.atStartup).toBe(true);
    expect(found.note?.text).toContain("Strapi");
  });

  it("Prisma: says why when the Prisma CLI is missing", async () => {
    const found = await releaseOf({
      ...server({ dependencies: { "@prisma/client": "^6" } }),
      "prisma/migrations/0001_init/migration.sql": "CREATE TABLE a();",
    });
    expect(found.command).toBeUndefined();
    expect(found.note?.text).toContain("Add `prisma`");
  });
});
