/**
 * Release commands of Node.js apps. The Node.js server image keeps everything the build stage
 * installed (development dependencies included), so a CLI declared as a devDependency runs there;
 * whether another image can run the command is decided when the plan is made.
 */
import { basenameRel, dirnameRel, isWithin, joinRel } from "../paths";
import {
  ANALYZE_AGAIN,
  atStartup,
  cleanPath,
  inFolder,
  leftOut,
  parseJsonc,
  type ReleaseContext,
  type ReleaseDetection,
} from "./context";

/** True when an app-relative folder holds a file whose name matches. */
function folderHas(ctx: ReleaseContext, folder: string, name: RegExp): boolean {
  const prefix = folder === "." ? "" : `${folder}/`;
  return ctx.rel.some((file) => file.startsWith(prefix) && name.test(file.slice(prefix.length)));
}

/** First quoted string a config assigns to `key` (`out: "./drizzle"`, `"out": "drizzle"`). */
function configString(text: string | undefined, key: string): string | undefined {
  return new RegExp(`["']?\\b${key}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(text ?? "")?.[1];
}

const TS_FILE = /\.[cm]?ts$/;

/**
 * Redwood: `yarn rw prisma migrate deploy` from the project root (the folder of the `redwood.toml`
 * holding the app folder, with `api/db/migrations/`), for an app with `@redwoodjs/*` dependencies.
 */
function redwood(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.unit?.dependencies.some((dep) => dep.name.startsWith("@redwoodjs/"))) return undefined;
  const toml = ctx.files
    .filter((file) => basenameRel(file) === "redwood.toml")
    .filter((file) => isWithin(dirnameRel(file), ctx.appDir))
    .sort((a, b) => b.length - a.length)[0];
  if (toml === undefined) return undefined;
  const root = dirnameRel(toml);
  const migrations = `${joinRel(root, "api/db/migrations")}/`;
  if (!ctx.files.some((file) => file.startsWith(migrations) && file.endsWith("/migration.sql"))) {
    return undefined;
  }
  return { command: inFolder(root, "yarn rw prisma migrate deploy") };
}

/**
 * KeystoneJS 6: Prisma migrations in `migrations/`, applied before `keystone start` (which applies
 * none): `npx prisma migrate deploy` when the app depends on `prisma` itself, else through the
 * Prisma bundled with Keystone, `npx keystone prisma migrate deploy` (with pnpm, the bundled
 * `prisma` binary is not linked where `npx prisma` would find it).
 */
function keystone(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.npm("@keystone-6/core") || !ctx.has(/^migrations\/[^/]+\/migration\.sql$/)) {
    return undefined;
  }
  return {
    command: ctx.at(
      ".",
      ctx.npm("prisma") ? "npx prisma migrate deploy" : "npx keystone prisma migrate deploy",
    ),
  };
}

/** Prisma: `npx prisma migrate deploy` with `prisma/migrations/` and the Prisma CLI. */
function prisma(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.has(/^prisma\/migrations\//)) return undefined;
  if (ctx.npm("prisma")) return { command: ctx.at(".", "npx prisma migrate deploy") };
  if (ctx.npm("@prisma/client")) {
    return leftOut(
      `OpsCrew found Prisma migrations in prisma/migrations, but the Prisma CLI (the \`prisma\` package) is not a dependency of the app, so deploys could not run \`npx prisma migrate deploy\`. Add \`prisma\` to the app's devDependencies and ${ANALYZE_AGAIN}`,
    );
  }
  return undefined;
}

/** Payload: `npx payload migrate` with migrations in `src/migrations/`, unless `prodMigrations`. */
async function payload(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("payload")) return undefined;
  const migrations = ctx.matching(/^(?:src\/)?migrations\/(?!index\.)[^/]+\.[cm]?[jt]s$/);
  if (migrations.length === 0) return undefined;
  const config = ctx.matching(/^(?:src\/)?payload\.config\.[cm]?[jt]s$/)[0];
  if (config && /\bprodMigrations\s*:/.test((await ctx.read(config)) ?? "")) {
    return atStartup(
      "The Payload config passes the migrations as `prodMigrations`, so Payload applies them when the app starts in production",
    );
  }
  return { command: ctx.at(".", "npx payload migrate") };
}

/** Medusa 2: `npx medusa db:migrate --execute-safe-links` (no prompt); Medusa 1 gets a note. */
function medusa(ctx: ReleaseContext): ReleaseDetection | undefined {
  const dep = ctx.dependency("npm", "@medusajs/medusa");
  if (dep === undefined || !ctx.has(/^medusa-config\.[cm]?[jt]s$/)) return undefined;
  if (/^\D*1(?:\.|$)/.test(dep.version ?? "")) {
    return leftOut(
      "This is a Medusa 1 app. OpsCrew plans database migrations only for Medusa 2 (`npx medusa db:migrate`), so deploys run none. Set `app.releaseCommand` in opscrew/plan.yaml to the command that applies your Medusa 1 migrations, or run them yourself before each deploy that changes the schema.",
    );
  }
  return { command: ctx.at(".", "npx medusa db:migrate --execute-safe-links") };
}

/** AdonisJS Lucid: `node ace migration:run --force`, from the build output when the app is built. */
function adonis(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.npm("@adonisjs/lucid") || !ctx.has(/^database\/migrations\/[^/]+\.[cm]?[jt]s$/)) {
    return undefined;
  }
  if (!ctx.exists("ace.js") && !ctx.exists("ace")) return undefined;
  const built = /\bace\s+build\b/.test(ctx.scripts.build ?? "");
  return { command: ctx.at(built ? "build" : ".", "node ace migration:run --force") };
}

/** Drizzle: `npx drizzle-kit migrate` from the config's folder, with SQL files in its `out` folder. */
async function drizzle(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("drizzle-kit")) return undefined;
  const config = ctx.matching(/(?:^|\/)drizzle\.config\.(?:[cm]?[jt]s|json)$/)[0];
  if (config === undefined) return undefined;
  const dir = dirnameRel(config);
  const out = configString(await ctx.read(config), "out") ?? "drizzle";
  const folder = cleanPath(dir === "." ? out : `${dir}/${out}`);
  if (!folderHas(ctx, folder, /\.sql$/)) return undefined;
  return { command: ctx.at(dir, "npx drizzle-kit migrate") };
}

/** compilerOptions of tsconfig.build.json over tsconfig.json (app folder). */
async function compilerOptions(ctx: ReleaseContext): Promise<Record<string, unknown>> {
  const options: Record<string, unknown> = {};
  for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
    const data = parseJsonc(await ctx.read(name)) as
      | { compilerOptions?: Record<string, unknown> }
      | undefined;
    Object.assign(options, data?.compilerOptions ?? {});
  }
  return options;
}

/**
 * Where the build writes a TypeScript file (app-relative), from `outDir` and `rootDir` of the
 * tsconfig, or, without `rootDir`, from the built entry point the start command runs
 * (`node dist/main` means `src` is the root, `node dist/src/main` the app folder).
 */
async function compiledPath(ctx: ReleaseContext, source: string): Promise<string | undefined> {
  const options = await compilerOptions(ctx);
  if (typeof options.outDir !== "string") return undefined;
  const outDir = cleanPath(options.outDir);
  let rootDir = typeof options.rootDir === "string" ? cleanPath(options.rootDir) : undefined;
  if (rootDir === undefined) {
    const entries = [
      ctx.startCommand,
      ctx.scripts["start:prod"],
      ctx.scripts["start:production"],
      ctx.scripts.start,
      ctx.unit?.packageJson?.main,
    ].join(" ");
    const out = outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s/"'])${out}/src/`).test(entries)) rootDir = ".";
    else if (source.startsWith("src/") && new RegExp(`(?:^|[\\s/"'])${out}/`).test(entries)) {
      rootDir = "src";
    }
  }
  if (rootDir === undefined) return undefined;
  const prefix = rootDir === "." ? "" : `${rootDir}/`;
  if (!source.startsWith(prefix)) return undefined;
  const js = source
    .slice(prefix.length)
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs")
    .replace(/\.ts$/, ".js");
  return outDir === "." ? js : `${outDir}/${js}`;
}

/** The TypeORM data source: from a script's `-d`/`--dataSource`, else a conventional file name. */
async function typeormDataSource(ctx: ReleaseContext): Promise<string | undefined> {
  for (const script of Object.values(ctx.scripts)) {
    if (!/\btypeorm/.test(script)) continue;
    const path = /(?:^|\s)(?:-d|--dataSource|--data-source)(?:=|\s+)["']?([^\s"';&|]+)/.exec(
      script,
    )?.[1];
    if (path) {
      const clean = cleanPath(path);
      // A compiled data source lives in the build output, which the repository does not hold.
      if (!TS_FILE.test(clean) || ctx.exists(clean)) return clean;
    }
  }
  const candidates = ctx
    .matching(/(?:^|\/)(?:data-?source|typeorm[.-](?:config|data-?source)|ormconfig)\.[cm]?[jt]s$/i)
    .filter((file) => !/\.d\.[cm]?ts$/.test(file));
  return ctx.firstMatching(candidates, /\bnew\s+DataSource\s*\(/, 20);
}

/**
 * TypeORM: `npx typeorm migration:run -d <data source>` with generated migrations
 * (`<13-digit timestamp>-<Name>.ts`). A TypeScript data source runs as the compiled file in the
 * build output when the build is known, else through `typeorm-ts-node-commonjs` (or `-esm`) when
 * ts-node is a dependency, else it is left out with the reason. `migrationsRun: true` in the data
 * source means TypeORM migrates when the app starts.
 */
async function typeorm(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("typeorm") || !ctx.has(/(?:^|\/)migrations?\/\d{13}-[\w.-]+\.[cm]?[jt]s$/)) {
    return undefined;
  }
  const source = await typeormDataSource(ctx);
  if (source === undefined) {
    return leftOut(
      `OpsCrew found TypeORM migrations but not the data source file that \`typeorm migration:run -d <file>\` needs, so deploys run no migrations. Add a \`migrate\` script to package.json (for example \`typeorm migration:run -d dist/data-source.js\`) and ${ANALYZE_AGAIN}`,
    );
  }
  const sourceText = (await ctx.read(source)) ?? "";
  if (/\bmigrationsRun\s*:\s*true\b/.test(sourceText)) {
    return atStartup(
      `The TypeORM data source in ${source} sets \`migrationsRun: true\`, so TypeORM applies them when the app starts`,
    );
  }
  if (!TS_FILE.test(source))
    return { command: ctx.at(".", `npx typeorm migration:run -d ${source}`) };
  const tsNode = async () => {
    const pkg = parseJsonc(await ctx.read("package.json")) as { type?: unknown } | undefined;
    const bin = pkg?.type === "module" ? "typeorm-ts-node-esm" : "typeorm-ts-node-commonjs";
    return { command: ctx.at(".", `npx ${bin} migration:run -d ${source}`) };
  };
  const compiled = ctx.scripts.build ? await compiledPath(ctx, source) : undefined;
  if (compiled && !listsOnlyTsMigrations(sourceText)) {
    return { command: ctx.at(".", `npx typeorm migration:run -d ${compiled}`) };
  }
  if (ctx.npm("ts-node")) return tsNode();
  if (compiled) {
    return leftOut(
      `OpsCrew found TypeORM migrations, but the data source ${source} lists them as \`.ts\` files, which the compiled data source (${compiled}) cannot load without ts-node, and ts-node is not a dependency. List the migrations so the compiled file finds the compiled ones (for example \`__dirname + "/migrations/*.{ts,js}"\`) or add ts-node, then ${ANALYZE_AGAIN}`,
    );
  }
  return leftOut(
    `OpsCrew found TypeORM migrations, but the data source ${source} is TypeScript: OpsCrew could not tell where the build writes the compiled file (set \`outDir\` and \`rootDir\` in tsconfig.json), and ts-node is not a dependency to run it directly. Add a \`migrate\` script to package.json (for example \`typeorm migration:run -d dist/data-source.js\`) and ${ANALYZE_AGAIN}`,
  );
}

/**
 * True when a data source lists its migrations only as literal `.ts` paths or globs (no
 * `__dirname`, no `{ts,js}` alternative), which its compiled copy cannot load.
 */
function listsOnlyTsMigrations(text: string): boolean {
  const list = /\bmigrations\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  if (list === undefined || /__dirname|import\.meta/.test(list)) return false;
  const paths = [...list.matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1] ?? "");
  return (
    paths.length > 0 && paths.every((path) => /\.[cm]?ts$/.test(path) && !/\{[^}]*js/.test(path))
  );
}

/**
 * MikroORM: `npx mikro-orm migration:up` with `Migration<14 digits>` files and `@mikro-orm/cli`.
 * TypeScript migrations run in production only when the config's `migrations.path` points at the
 * compiled ones (in `dist/` or `build/`) or a TypeScript loader (tsx, ts-node) is installed.
 */
async function mikroOrm(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  const uses = ctx.unit?.dependencies.some((dep) => dep.name.startsWith("@mikro-orm/"));
  const migrations = ctx.matching(/(?:^|\/)Migration\d{14}(?:_\w+)?\.[cm]?[jt]s$/);
  if (!uses || migrations.length === 0) return undefined;
  const command = "npx mikro-orm migration:up";
  if (!ctx.npm("@mikro-orm/cli")) {
    return leftOut(
      `OpsCrew found MikroORM migrations, but \`@mikro-orm/cli\` is not a dependency of the app, so deploys could not run \`${command}\`. Add \`@mikro-orm/cli\` to the app's dependencies and ${ANALYZE_AGAIN}`,
    );
  }
  if (migrations.every((file) => TS_FILE.test(file)) && !ctx.npm("tsx") && !ctx.npm("ts-node")) {
    const config = ctx.matching(/(?:^|\/)mikro-orm\.config\.[cm]?[jt]s$/)[0];
    const path = /\bmigrations\s*:\s*\{[^}]*?\bpath\s*:\s*["'`]([^"'`]+)["'`]/.exec(
      (config ? await ctx.read(config) : undefined) ?? "",
    )?.[1];
    if (path === undefined || !/(?:^|\/)(?:dist|build)(?:\/|$)/.test(cleanPath(path))) {
      return leftOut(
        `OpsCrew found MikroORM migrations written in TypeScript, but the MikroORM config does not point \`migrations.path\` at the compiled migrations (for example \`dist/migrations\`) and no TypeScript loader (tsx or ts-node) is installed, so deploys could not run \`${command}\`. Set \`migrations.path\` to the compiled folder (keeping \`pathTs\` for the TypeScript one) and ${ANALYZE_AGAIN}`,
      );
    }
  }
  return { command: ctx.at(".", command) };
}

/** Kysely (kysely-ctl): `npx kysely migrate:latest` with a config and its migrations folder. */
// unverified: the `migrate:latest` subcommand (kysely-ctl's README only says it mirrors Knex's
// CLI); the config locations (`kysely.config.ts` at the root or in `.config/`) are documented.
async function kysely(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("kysely-ctl")) return undefined;
  const config = ctx.matching(/^(?:\.config\/)?kysely\.config\.[cm]?[jt]s$/)[0];
  if (config === undefined) return undefined;
  const folder = cleanPath(configString(await ctx.read(config), "migrationFolder") ?? "migrations");
  if (!folderHas(ctx, folder, /^[^/]+\.[cm]?[jt]s$/)) return undefined;
  return { command: ctx.at(".", "npx kysely migrate:latest") };
}

/**
 * Knex (and Objection, which migrates through Knex): `npx knex migrate:latest` from the folder of
 * the knexfile, with migrations in its `directory` (`./migrations` by default). A TypeScript
 * knexfile needs ts-node, which the Knex CLI loads by itself.
 */
async function knex(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("knex")) return undefined;
  const knexfile = ctx.matching(/(?:^|\/)knexfile\.[cm]?[jt]s$/)[0];
  if (knexfile === undefined) return undefined;
  const dir = dirnameRel(knexfile);
  const text = await ctx.read(knexfile);
  const configured = /\bmigrations\s*:\s*\{[^}]*?\bdirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(
    text ?? "",
  )?.[1];
  const folder = cleanPath(joinRel(dir, configured ?? "migrations"));
  const prefix = folder === "." ? "" : `${folder}/`;
  let migrations = ctx.rel.filter(
    (file) => file.startsWith(prefix) && /^[^/]+\.[cm]?[jt]s$/.test(file.slice(prefix.length)),
  );
  if (migrations.length === 0) {
    migrations = ctx.matching(/(?:^|\/)migrations\/\d{8,}_[\w.-]+\.[cm]?[jt]s$/);
  }
  if (migrations.length === 0) return undefined;
  const command = "npx knex migrate:latest";
  const typescript = TS_FILE.test(knexfile)
    ? `the knexfile ${knexfile} is TypeScript`
    : migrations.some((file) => TS_FILE.test(file))
      ? "the migrations are TypeScript"
      : undefined;
  if (typescript && !ctx.npm("ts-node")) {
    return leftOut(
      `OpsCrew found Knex migrations, but ${typescript} and ts-node, which the Knex CLI uses to load it, is not a dependency, so deploys could not run \`${command}\`. Add ts-node to the app's devDependencies and ${ANALYZE_AGAIN}`,
    );
  }
  return { command: ctx.at(dir, command) };
}

/** True when the app has sequelize-cli style migrations (`<14 digits>-name.js`). */
async function hasSequelizeMigrations(ctx: ReleaseContext): Promise<boolean> {
  const rc = await ctx.read(".sequelizerc");
  const args = /["']migrations-path["']\s*:\s*path\.(?:resolve|join)\(([^)]*)\)/.exec(
    rc ?? "",
  )?.[1];
  const configured = args
    ?.split(",")
    .map((arg) => /^\s*["'`]([^"'`]+)["'`]\s*$/.exec(arg)?.[1])
    .filter((part): part is string => part !== undefined)
    .join("/");
  const migration = /^\d{14}-[\w.-]+\.[cm]?js$/;
  return configured
    ? folderHas(ctx, cleanPath(configured), migration)
    : ctx.rel.some(
        (file) => /(?:^|\/)migrations$/.test(dirnameRel(file)) && migration.test(basenameRel(file)),
      );
}

/** Sequelize: `npx sequelize-cli db:migrate` with `<14 digits>-name.js` migrations. */
async function sequelize(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("sequelize-cli") || !(await hasSequelizeMigrations(ctx))) return undefined;
  return { command: ctx.at(".", "npx sequelize-cli db:migrate") };
}

/**
 * The note for Sequelize migrations without `sequelize-cli`, used only when no other tool claimed
 * the migrations (db-migrate names its files the same way).
 */
async function sequelizeWithoutCli(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("sequelize") || ctx.npm("sequelize-cli")) return undefined;
  if (!(await hasSequelizeMigrations(ctx))) return undefined;
  return leftOut(
    `OpsCrew found Sequelize migrations, but \`sequelize-cli\` is not a dependency of the app, so deploys could not run \`npx sequelize-cli db:migrate\`. Add \`sequelize-cli\` to the app's devDependencies and ${ANALYZE_AGAIN}`,
  );
}

/**
 * node-pg-migrate: `npx node-pg-migrate up` with timestamped files in `migrations/`. Migrations
 * only in TypeScript need a loader: ts-node (`--tsconfig tsconfig.json`) or tsx (`--import tsx`).
 */
// unverified: loading TypeScript migrations through `NODE_OPTIONS="--import tsx"`.
function nodePgMigrate(ctx: ReleaseContext): ReleaseDetection | undefined {
  const migrations = ctx.matching(/^migrations\/\d{13,}[_-][^/]+\.(?:[cm]?[jt]s|sql)$/);
  if (!ctx.npm("node-pg-migrate") || migrations.length === 0) return undefined;
  if (!migrations.every((file) => TS_FILE.test(file))) {
    return { command: ctx.at(".", "npx node-pg-migrate up") };
  }
  if (ctx.npm("ts-node")) {
    const tsconfig = ctx.exists("tsconfig.json") ? " --tsconfig tsconfig.json" : "";
    return { command: ctx.at(".", `npx node-pg-migrate up${tsconfig}`) };
  }
  if (ctx.npm("tsx")) {
    return { command: ctx.at(".", 'NODE_OPTIONS="--import tsx" npx node-pg-migrate up') };
  }
  return leftOut(
    `OpsCrew found node-pg-migrate migrations written in TypeScript, but neither ts-node nor tsx is a dependency to load them, so deploys could not run \`npx node-pg-migrate up\`. Add ts-node or tsx to the app's devDependencies and ${ANALYZE_AGAIN}`,
  );
}

/** db-migrate: `npx db-migrate up` (with `-e` for a production entry in database.json). */
async function dbMigrate(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.npm("db-migrate") || !ctx.has(/^migrations\/\d{14}-[\w.-]+\.[cm]?js$/)) return undefined;
  const config = parseJsonc(await ctx.read("database.json"));
  const env =
    config && typeof config === "object"
      ? ["production", "prod"].find((name) => name in config)
      : undefined;
  return { command: ctx.at(".", env ? `npx db-migrate up -e ${env}` : "npx db-migrate up") };
}

/**
 * Node.js release commands, in order: Strapi (migrates at startup, a note), Redwood, KeystoneJS,
 * Prisma, Payload, Medusa, AdonisJS Lucid, Drizzle, TypeORM, MikroORM, Kysely, Knex/Objection,
 * db-migrate, Sequelize and node-pg-migrate. Each applies only when the app has migrations for it.
 */
export async function nodeRelease(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (ctx.npm("@strapi/strapi")) {
    return atStartup(
      "Strapi updates the database schema and runs the migrations in database/migrations itself when it starts",
    );
  }
  const detectors: ((
    ctx: ReleaseContext,
  ) => ReleaseDetection | undefined | Promise<ReleaseDetection | undefined>)[] = [
    redwood,
    keystone,
    prisma,
    payload,
    medusa,
    adonis,
    drizzle,
    typeorm,
    mikroOrm,
    kysely,
    knex,
    dbMigrate,
    sequelize,
    nodePgMigrate,
    sequelizeWithoutCli,
  ];
  for (const detect of detectors) {
    const found = await detect(ctx);
    if (found) return found;
  }
  return undefined;
}
