/**
 * Release commands of stacks OpsCrew cannot build an image for yet (Ruby, PHP, Go, Rust, Elixir,
 * .NET, Java). They are recorded now so the builders that come next can run them; the image check
 * leaves them out of the plan until then. Gemfile and composer.json dependencies come from the
 * parsed manifests; go.mod, Cargo.toml, mix.exs, *.csproj, pom.xml and build.gradle are matched as
 * text, because detection does not parse them.
 */
import { parse as parseToml } from "smol-toml";
import { basenameRel, dirnameRel } from "../paths";
import {
  atStartup,
  byDepth,
  cleanPath,
  type ReleaseContext,
  type ReleaseDetection,
} from "./context";

/** App-relative files with these extensions, outside tests and vendored code, shallowest first. */
function sourceFiles(ctx: ReleaseContext, extension: RegExp, skip?: RegExp): string[] {
  return ctx.rel
    .filter((file) => extension.test(file) && !(skip?.test(file) ?? false))
    .sort(byDepth);
}

/** The folder (app-relative) holding the most files that match, shallowest on ties. */
function folderOf(files: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(dirnameRel(file), (counts.get(dirnameRel(file)) ?? 0) + 1);
  return [...counts.entries()].sort(([a, x], [b, y]) => y - x || byDepth(a, b))[0]?.[0];
}

/** Rails, Hanami and Sequel (Gemfile). */
function ruby(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.exists("Gemfile")) return undefined;
  const gem = (name: string) => ctx.dependency("gem", name) !== undefined;
  if (gem("rails") && ctx.has(/^db\/migrate\/\d+_\w+\.rb$/)) {
    return {
      command: ctx.at(
        ".",
        ctx.exists("bin/rails") ? "bin/rails db:migrate" : "bundle exec rails db:migrate",
      ),
    };
  }
  // unverified: the `hanami db migrate` command (Hanami's guide documents the
  // `config/db/migrate` folder; the command is on a separate CLI page).
  if (gem("hanami") && ctx.has(/^config\/db\/migrate\/\d+_\w+\.rb$/)) {
    return { command: ctx.at(".", "bundle exec hanami db migrate") };
  }
  if (gem("sequel")) {
    const dir = folderOf(ctx.matching(/^(?:db\/)?migrat(?:e|ions)\/\d+_\w+\.rb$/));
    if (dir) return { command: ctx.at(".", `bundle exec sequel -m ${dir} "$DATABASE_URL"`) };
  }
  return undefined;
}

/** Laravel and Symfony with Doctrine Migrations (composer.json). */
function php(ctx: ReleaseContext): ReleaseDetection | undefined {
  if (!ctx.exists("composer.json")) return undefined;
  const composer = (name: string) => ctx.dependency("composer", name) !== undefined;
  if (
    composer("laravel/framework") &&
    ctx.exists("artisan") &&
    ctx.has(/^database\/migrations\/[^/]+\.php$/)
  ) {
    return { command: ctx.at(".", "php artisan migrate --force") };
  }
  if (
    composer("doctrine/doctrine-migrations-bundle") &&
    ctx.exists("bin/console") &&
    ctx.has(/^(?:migrations|src\/Migrations)\/Version\w*\.php$/)
  ) {
    return {
      command: ctx.at(".", "php bin/console doctrine:migrations:migrate --no-interaction"),
    };
  }
  return undefined;
}

/**
 * Go (go.mod): GORM `AutoMigrate`, `goose.Up` or golang-migrate's `Up()` in the code migrate at
 * startup; else goose `goose -dir <dir> postgres "$DATABASE_URL" up` (SQL files annotated
 * `-- +goose Up`) or golang-migrate `migrate -path <dir> -database "$DATABASE_URL" up`
 * (`<n>_<name>.up.sql` files).
 */
async function go(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.exists("go.mod")) return undefined;
  const goMod = (await ctx.read("go.mod")) ?? "";
  const code = sourceFiles(ctx, /\.go$/, /_test\.go$/);
  if (goMod.includes("gorm.io/gorm") && (await ctx.firstMatching(code, /\.AutoMigrate\s*\(/))) {
    return atStartup("The app calls GORM's `AutoMigrate` when it starts, which updates the tables");
  }
  if (await ctx.firstMatching(code, /\bgoose\.Up(?:Context)?\s*\(/)) {
    return atStartup("The app runs its goose migrations (`goose.Up`) when it starts");
  }
  if (
    goMod.includes("golang-migrate/migrate") &&
    (await ctx.firstMatching(code, /\bmigrate\.New\w*\s*\([\s\S]*\.Up\s*\(\s*\)/))
  ) {
    return atStartup("The app runs its golang-migrate migrations (`Up()`) when it starts");
  }
  const sql = sourceFiles(ctx, /\.sql$/);
  const goose = await ctx.firstMatching(sql, /^\s*--\s*\+goose\s+Up\b/im, 200);
  if (goose) {
    return {
      command: ctx.at(".", `goose -dir ${dirnameRel(goose)} postgres "$DATABASE_URL" up`),
    };
  }
  const dir = folderOf(sql.filter((file) => /^\d+_[\w.-]+\.up\.sql$/.test(basenameRel(file))));
  if (dir) return { command: ctx.at(".", `migrate -path ${dir} -database "$DATABASE_URL" up`) };
  return undefined;
}

/**
 * Rust (Cargo.toml): `sqlx::migrate!` or SeaORM's `Migrator::up` in the code migrate at startup;
 * else SeaORM `sea-orm-cli migrate up` (a `migration` crate), Diesel `diesel migration run`
 * (`<dir>/<name>/up.sql`) or sqlx `sqlx migrate run` (SQL files in `migrations/`).
 */
async function rust(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.exists("Cargo.toml")) return undefined;
  const cargo = (await ctx.read("Cargo.toml")) ?? "";
  const code = sourceFiles(ctx, /\.rs$/, /^migration\//);
  if (/\bsqlx\b/.test(cargo) && (await ctx.firstMatching(code, /\bsqlx::migrate!\s*\(/))) {
    return atStartup(
      "The app embeds its migrations with `sqlx::migrate!` and applies them when it starts",
    );
  }
  if (ctx.has(/^migration\/src\/m\d{8}_\d{6}_\w+\.rs$/)) {
    if (await ctx.firstMatching(code, /\bMigrator::up\s*\(/)) {
      return atStartup("The app runs its SeaORM migrations (`Migrator::up`) when it starts");
    }
    return { command: ctx.at(".", "sea-orm-cli migrate up") };
  }
  if (/\bdiesel\b/.test(cargo)) {
    let dir = "migrations";
    try {
      const config = parseToml((await ctx.read("diesel.toml")) ?? "") as {
        migrations_directory?: { dir?: unknown };
      };
      const configured = config.migrations_directory?.dir;
      if (typeof configured === "string") dir = cleanPath(configured);
    } catch {
      // An unreadable diesel.toml leaves the default folder.
    }
    if (
      ctx.rel.some(
        (file) => file.startsWith(`${dir}/`) && /^[^/]+\/up\.sql$/.test(file.slice(dir.length + 1)),
      )
    ) {
      const option = dir === "migrations" ? "" : ` --migration-dir ${dir}`;
      return { command: ctx.at(".", `diesel migration run${option}`) };
    }
  }
  if (/\bsqlx\b/.test(cargo) && ctx.has(/^migrations\/\d+_[^/]+\.sql$/)) {
    return { command: ctx.at(".", "sqlx migrate run") };
  }
  return undefined;
}

/**
 * Phoenix/Ecto (mix.exs): `Ecto.Migrator` in the application's children migrates at startup; else
 * the release module (`bin/<app> eval "<App>.Release.migrate"`) or `mix ecto.migrate`.
 */
async function elixir(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  if (!ctx.exists("mix.exs") || !ctx.has(/^priv\/repo\/migrations\/[^/]+\.exs$/)) return undefined;
  const mix = (await ctx.read("mix.exs")) ?? "";
  if (!/:ecto_sql\b|:ecto\b/.test(mix)) return undefined;
  const lib = sourceFiles(ctx, /^lib\/.+\.ex$/);
  const application = lib.filter((file) => basenameRel(file) === "application.ex");
  if (await ctx.firstMatching(application, /\bEcto\.Migrator\b/)) {
    return atStartup(
      "The app starts `Ecto.Migrator` with its application, which runs the migrations",
    );
  }
  const app = /\bapp:\s*:(\w+)/.exec(mix)?.[1];
  for (const file of lib.filter((name) => basenameRel(name) === "release.ex")) {
    const text = (await ctx.read(file)) ?? "";
    const module = /\bdefmodule\s+([\w.]+\.Release)\s+do\b/.exec(text)?.[1];
    if (app && module && /\bdef\s+migrate\b/.test(text)) {
      return { command: ctx.at(".", `bin/${app} eval "${module}.migrate"`) };
    }
  }
  return { command: ctx.at(".", "mix ecto.migrate") };
}

/**
 * EF Core (*.csproj referencing Microsoft.EntityFrameworkCore, with a model snapshot):
 * `Database.Migrate()` in the code migrates at startup; else `dotnet ef database update` from the
 * project folder that holds the migrations (needs the .NET SDK and the dotnet-ef tool, or a
 * migration bundle, where it runs).
 */
async function dotnet(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  const snapshot = ctx.matching(/(?:^|\/)Migrations\/\w+ModelSnapshot\.cs$/)[0];
  if (snapshot === undefined) return undefined;
  const projects = ctx.matching(/(?:^|\/)[^/]+\.csproj$/);
  const project = projects
    .filter((file) => {
      const dir = dirnameRel(file);
      return dir === "." || snapshot.startsWith(`${dir}/`);
    })
    .sort((a, b) => byDepth(b, a))[0];
  if (project === undefined) return undefined;
  if (!/Microsoft\.EntityFrameworkCore/.test((await ctx.read(project)) ?? "")) return undefined;
  const code = sourceFiles(ctx, /\.cs$/, /(?:^|\/)(?:Migrations|bin|obj)\//);
  if (await ctx.firstMatching(code, /\.Database\.Migrate(?:Async)?\s*\(/)) {
    return atStartup("The app calls EF Core's `Database.Migrate()` when it starts");
  }
  return { command: ctx.at(dirnameRel(project), "dotnet ef database update") };
}

/** Spring Boot with Flyway or Liquibase: Spring Boot runs them at startup (a note). */
async function spring(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  const build = ["pom.xml", "build.gradle", "build.gradle.kts"].find((name) => ctx.exists(name));
  if (build === undefined) return undefined;
  const text = (await ctx.read(build)) ?? "";
  if (!/spring-boot|org\.springframework\.boot/.test(text)) return undefined;
  if (
    /flyway/i.test(text) &&
    ctx.has(/^src\/main\/resources\/db\/migration\/V[^/]+__[^/]+\.sql$/)
  ) {
    return atStartup("Spring Boot runs the app's Flyway migrations when it starts");
  }
  if (/liquibase/i.test(text) && ctx.has(/^src\/main\/resources\/db\/changelog\//)) {
    return atStartup("Spring Boot runs the app's Liquibase changelog when it starts");
  }
  return undefined;
}

/** Atlas (any stack): `atlas migrate apply` with the folder holding `atlas.sum`. */
function atlas(ctx: ReleaseContext): ReleaseDetection | undefined {
  const sum = ctx.matching(/(?:^|\/)atlas\.sum$/)[0];
  if (sum === undefined) return undefined;
  const dir = dirnameRel(sum);
  const option = dir === "migrations" ? "" : ` --dir file://${dir}`;
  return { command: ctx.at(".", `atlas migrate apply --url "$DATABASE_URL"${option}`) };
}

/** Release commands of the stacks above, in order: Ruby, PHP, Go, Rust, Elixir, .NET, Java. */
export async function nativeRelease(ctx: ReleaseContext): Promise<ReleaseDetection | undefined> {
  return (
    ruby(ctx) ??
    php(ctx) ??
    (await go(ctx)) ??
    (await rust(ctx)) ??
    (await elixir(ctx)) ??
    (await dotnet(ctx)) ??
    (await spring(ctx))
  );
}

/** Tools any stack may use (Atlas), tried last. */
export function anyStackRelease(ctx: ReleaseContext): ReleaseDetection | undefined {
  return atlas(ctx);
}
