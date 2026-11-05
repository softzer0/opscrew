/**
 * The command that fills a new, empty database with an app's seed data (preview environments run
 * it once, when a preview is created), run from the repository root like the release command.
 */
import { parseJson, type ReadText, type Unit } from "./manifests";
import { dirnameRel, joinRel } from "./paths";
import { cleanPath, ReleaseContext } from "./release/context";

/** What {@link detectSeed} found: a command, or a note saying why there is none. */
export interface SeedDetection {
  /** The seed command, run from the repository root like the release command. */
  command?: string;
  /** Why no seed command was found, in plain English that says what to do next. */
  note?: string;
}

/** What {@link detectSeed} looks at. */
export interface SeedInputs {
  /** Repo-relative directory of the app (`.` for the root). */
  appDir: string;
  /** Repo-relative files of the repository that detection may look at. */
  files: readonly string[];
  /** The app's manifest unit (its dependencies and package.json scripts). */
  unit: Unit | undefined;
  /** Frameworks detected for the app. */
  frameworks: ReadonlySet<string>;
  /** Reads a repo-relative file of `files`; none when absent. */
  read?: ReadText;
  /** `<pm> run <script>` for the app in repository-root form (Node.js apps). */
  runScript?: (script: string) => string;
}

/** Package scripts that seed the app's database, in order of preference. */
const SEED_SCRIPTS = ["db:seed", "seed"] as const;

/** How a note about a missing seed command ends. */
const SET_ONE =
  "To seed each preview's database, add a `db:seed` script to package.json and run `opscrew analyze` again, or give the command when you set up previews (`--seed <command>`).";

/** True when an app-relative folder holds a file directly whose name matches. */
function folderHas(ctx: ReleaseContext, folder: string, name: RegExp): boolean {
  const prefix = folder === "." ? "" : `${folder}/`;
  return ctx.rel.some((file) => file.startsWith(prefix) && name.test(file.slice(prefix.length)));
}

const SCRIPT_FILE = /^[^/]+\.[cm]?[jt]s$/;

/** Prisma: `migrations.seed` in `prisma.config.ts`, or `prisma.seed` in package.json. */
async function prisma(ctx: ReleaseContext): Promise<string | undefined> {
  if (!ctx.npm("prisma")) return undefined;
  const config = await ctx.read("prisma.config.ts");
  const inConfig = /\bmigrations\s*:\s*\{[^}]*?\bseed\s*:/.test(config ?? "");
  const manifest = parseJson(await ctx.read("package.json")) as
    | { prisma?: { seed?: unknown } }
    | undefined;
  const inManifest = typeof manifest?.prisma?.seed === "string";
  return inConfig || inManifest ? ctx.at(".", "npx prisma db seed") : undefined;
}

/** Rails: `bin/rails db:seed` with `db/seeds.rb`. */
function rails(ctx: ReleaseContext): string | undefined {
  if (ctx.dependency("gem", "rails") === undefined || !ctx.exists("db/seeds.rb")) return undefined;
  return ctx.at(".", ctx.exists("bin/rails") ? "bin/rails db:seed" : "bundle exec rails db:seed");
}

/** Laravel: `php artisan db:seed --force` with `database/seeders/DatabaseSeeder.php`. */
function laravel(ctx: ReleaseContext): string | undefined {
  if (
    ctx.dependency("composer", "laravel/framework") === undefined ||
    !ctx.exists("artisan") ||
    !ctx.exists("database/seeders/DatabaseSeeder.php")
  ) {
    return undefined;
  }
  return ctx.at(".", "php artisan db:seed --force");
}

/** Knex: `npx knex seed:run` from the knexfile's folder, with seeds in its `seeds.directory`. */
async function knex(ctx: ReleaseContext): Promise<string | undefined> {
  if (!ctx.npm("knex")) return undefined;
  const knexfile = ctx.matching(/(?:^|\/)knexfile\.[cm]?[jt]s$/)[0];
  if (knexfile === undefined) return undefined;
  const dir = dirnameRel(knexfile);
  const configured = /\bseeds\s*:\s*\{[^}]*?\bdirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(
    (await ctx.read(knexfile)) ?? "",
  )?.[1];
  const folder = cleanPath(joinRel(dir, configured ?? "seeds"));
  return folderHas(ctx, folder, SCRIPT_FILE) ? ctx.at(dir, "npx knex seed:run") : undefined;
}

/** Sequelize: `npx sequelize-cli db:seed:all` with seeders in `seeders-path` or `seeders/`. */
async function sequelize(ctx: ReleaseContext): Promise<string | undefined> {
  if (!ctx.npm("sequelize-cli")) return undefined;
  const args = /["']seeders-path["']\s*:\s*path\.(?:resolve|join)\(([^)]*)\)/.exec(
    (await ctx.read(".sequelizerc")) ?? "",
  )?.[1];
  const configured = args
    ?.split(",")
    .map((arg) => /^\s*["'`]([^"'`]+)["'`]\s*$/.exec(arg)?.[1])
    .filter((part): part is string => part !== undefined)
    .join("/");
  const folder = configured ? cleanPath(configured) : "seeders";
  return folderHas(ctx, folder, SCRIPT_FILE)
    ? ctx.at(".", "npx sequelize-cli db:seed:all")
    : undefined;
}

/** AdonisJS Lucid: `node ace db:seed` with `database/seeders/`, from the build output when built. */
function adonis(ctx: ReleaseContext): string | undefined {
  if (!ctx.npm("@adonisjs/lucid") || !folderHas(ctx, "database/seeders", SCRIPT_FILE)) {
    return undefined;
  }
  if (!ctx.exists("ace.js") && !ctx.exists("ace")) return undefined;
  const built = /\bace\s+build\b/.test(ctx.scripts.build ?? "");
  return ctx.at(built ? "build" : ".", "node ace db:seed");
}

/**
 * Finds the command that seeds the app's database. In order: a package.json script named `db:seed`
 * or `seed` (run with the project's package manager); then Prisma, Rails, Laravel, Knex,
 * Sequelize and AdonisJS, each only when the app has seeds for it. Django (its fixtures have to be
 * named) and Drizzle (no seed command of its own) get a note instead of a command.
 */
export async function detectSeed(inputs: SeedInputs): Promise<SeedDetection> {
  const ctx = new ReleaseContext(
    inputs.appDir,
    inputs.files,
    inputs.unit,
    inputs.read ?? (async () => undefined),
    undefined,
  );
  if (inputs.runScript) {
    const script = SEED_SCRIPTS.find((name) => (ctx.scripts[name] ?? "").trim() !== "");
    if (script) return { command: inputs.runScript(script) };
  }
  const command =
    (await prisma(ctx)) ??
    rails(ctx) ??
    laravel(ctx) ??
    (await knex(ctx)) ??
    (await sequelize(ctx)) ??
    adonis(ctx);
  if (command) return { command };
  if (inputs.frameworks.has("django")) {
    return {
      note: "OpsCrew found no seed command for this Django app: `manage.py loaddata` needs the names of the fixtures to load. To seed each preview's database, give the command when you set up previews (`--seed <command>`), for example `python manage.py loaddata <fixture>`.",
    };
  }
  if (ctx.npm("drizzle-orm")) {
    return { note: `OpsCrew found no seed command: Drizzle has none of its own. ${SET_ONE}` };
  }
  return {};
}
