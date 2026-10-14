/**
 * Release commands of Python apps. Python images install only the app's main dependencies, so a
 * migration tool declared only for development gets a note instead of a command.
 */
import { parse as parseToml } from "smol-toml";
import { cleanPath, type ReleaseContext, type ReleaseDetection, shallowest } from "./context";

/** A WSGI target such as `run:app` or `myproject:create_app()` (never `0.0.0.0:8000`). */
const WSGI_TARGET = /^[A-Za-z_][\w.]*:[A-Za-z_]\w*(?:\(.*\))?$/;

/** Targets Flask finds by itself (`app.py` or `wsgi.py` with an `app` object). */
const DISCOVERED_TARGETS = new Set(["app", "app:app", "wsgi", "wsgi:app"]);

/**
 * The Flask app for `flask db …`: `FLASK_APP` from a committed `.flaskenv`, else the target the
 * start command gives gunicorn. Undefined when Flask finds the app by itself or nothing says.
 */
function flaskApp(flaskenv: string | undefined, startCommand: string | undefined) {
  const fromEnv = /^[ \t]*(?:export[ \t]+)?FLASK_APP[ \t]*=[ \t]*["']?([^"'\s#]+)/m.exec(
    flaskenv ?? "",
  )?.[1];
  const fromStart = /\bgunicorn\b(.*)$/
    .exec(startCommand ?? "")?.[1]
    ?.split(/\s+/)
    .find((token) => WSGI_TARGET.test(token.replace(/^["']|["']$/g, "")))
    ?.replace(/^["']|["']$/g, "");
  const target = fromEnv ?? fromStart;
  return target === undefined || DISCOVERED_TARGETS.has(target) ? undefined : target;
}

/** `FLASK_APP=<target> flask db <action>`, quoting the target when the shell needs it. */
function flaskDb(action: string, target: string | undefined): string {
  if (target === undefined) return `flask db ${action}`;
  const value = /^[\w./:-]+$/.test(target) ? target : `'${target.replace(/'/g, `'\\''`)}'`;
  return `FLASK_APP=${value} flask db ${action}`;
}

/** Inputs only the Python detectors use. */
export interface PythonReleaseInputs {
  flaskenv: string | undefined;
  frameworks: ReadonlySet<string>;
}

/**
 * `command` run from `dir` (app-relative), or a note when `pkg` is only a development dependency
 * (the image would not install the tool).
 */
function pythonTool(
  ctx: ReleaseContext,
  tool: string,
  pkg: string,
  dir: string,
  command: string,
): ReleaseDetection {
  if (ctx.dependency("pypi", pkg)?.dev) {
    return {
      note: {
        atStartup: false,
        text: `OpsCrew found ${tool} migrations, but ${pkg} is only a development dependency, so the app's image does not install it and deploys could not run \`${command}\`. Add ${pkg} to the app's main dependencies (requirements.txt, or the main dependency list in pyproject.toml) and run \`opscrew analyze\` again, or set \`app.releaseCommand\` in opscrew/plan.yaml yourself.`,
      },
    };
  }
  return { command: ctx.at(dir, command) };
}

/** Values of a simple INI file (`key = value`, any section; later sections win). */
function iniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match?.[1] && !/^[#;]/.test(line.trim())) values.set(match[1], match[2] ?? "");
  }
  return values;
}

/** True for a Python migration module (not `__init__.py`) directly in `dir` (app-relative). */
function hasPythonModules(ctx: ReleaseContext, dir: string): boolean {
  const prefix = dir === "." ? "" : `${dir}/`;
  return ctx.rel.some(
    (file) =>
      file.startsWith(prefix) &&
      !file.slice(prefix.length).includes("/") &&
      file.endsWith(".py") &&
      !file.endsWith("__init__.py"),
  );
}

/**
 * `$DATABASE_URL` for Yoyo, which documents `postgresql://` URLs only: a `postgres://` scheme is
 * rewritten in plain POSIX sh (Python images run the command with `sh -c`).
 */
const YOYO_DATABASE = `"$(printf %s "$DATABASE_URL" | sed 's#^postgres://#postgresql://#')"`;

/** A path the shell takes as one word without quoting. */
const PLAIN_WORD = /^[\w./-]+$/;

/**
 * Yoyo's migration folders and where to run it from: the `sources` of the shallowest yoyo.ini
 * (relative to its folder, `%(here)s` meaning that folder), else a `migrations` folder whose Python
 * steps import yoyo (from the app folder). Undefined when neither holds migrations.
 */
async function yoyoSources(
  ctx: ReleaseContext,
): Promise<{ dir: string; sources: string[] } | undefined> {
  const ini = shallowest(ctx.rel, "yoyo.ini");
  if (ini) {
    const dir = ctx.dirOf(ini);
    const written = (iniValues((await ctx.read(ini)) ?? "").get("sources") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((source) => source.replace(/^%\(here\)s(?:\/|$)/, "") || ".");
    const sources = written.filter((source) => {
      const folder = cleanPath(dir === "." ? source : `${dir}/${source}`);
      return PLAIN_WORD.test(source) && ctx.rel.some((file) => file.startsWith(`${folder}/`));
    });
    return sources.length > 0 ? { dir, sources } : undefined;
  }
  const steps = ctx.matching(/(?:^|\/)migrations\/[^/]+\.py$/);
  const step = await ctx.firstMatching(steps, /^\s*from\s+yoyo\s+import\b/m, 50);
  return step && PLAIN_WORD.test(ctx.dirOf(step))
    ? { dir: ".", sources: [ctx.dirOf(step)] }
    : undefined;
}

async function pyprojectTool(ctx: ReleaseContext): Promise<Record<string, unknown> | undefined> {
  const text = await ctx.read("pyproject.toml");
  if (text === undefined) return undefined;
  try {
    const data = parseToml(text) as { tool?: Record<string, unknown> };
    return data.tool;
  } catch {
    return undefined;
  }
}

/**
 * Python release commands, in order: Django `python manage.py migrate --noinput` (from the folder
 * holding `manage.py`), Flask-Migrate `flask db upgrade` (with `migrations/env.py`), Flask-DB
 * `flask db migrate` (with `db/alembic.ini` or `db/env.py`), Alembic `alembic upgrade head` (from
 * the folder holding `alembic.ini`; SQLModel apps use Alembic too), Masonite
 * `python craft migrate --force` (with `databases/migrations/`), Aerich `aerich upgrade` (with
 * `[tool.aerich]` in pyproject.toml and migrations in its `location`, `./migrations` by default),
 * Tortoise ORM's own `tortoise migrate` (with `[tool.tortoise]` and a `migrations` package),
 * Piccolo `piccolo migrations forwards all` (from the folder holding `piccolo_conf.py`, with a
 * `piccolo_migrations` folder), Yoyo `yoyo apply --batch --database <DATABASE_URL as
 * postgresql://> <sources>` (from the folder holding `yoyo.ini`, with its `sources`) and peewee-migrate
 * `pw_migrate migrate --database "$DATABASE_URL" --directory <dir>` (numbered `001_*.py` files in a
 * `migrations` folder).
 */
export async function pythonRelease(
  ctx: ReleaseContext,
  inputs: PythonReleaseInputs,
): Promise<ReleaseDetection | undefined> {
  const pypi = (name: string) => ctx.dependency("pypi", name) !== undefined;
  const manage = inputs.frameworks.has("django") ? shallowest(ctx.rel, "manage.py") : undefined;
  if (manage) return { command: ctx.at(ctx.dirOf(manage), "python manage.py migrate --noinput") };
  const flask = () => flaskApp(inputs.flaskenv, ctx.startCommand);
  if (pypi("flask-migrate") && ctx.has(/(?:^|\/)migrations\/env\.py$/)) {
    return pythonTool(ctx, "Flask-Migrate", "Flask-Migrate", ".", flaskDb("upgrade", flask()));
  }
  if (pypi("flask-db") && ctx.has(/(?:^|\/)db\/(?:alembic\.ini|env\.py)$/)) {
    return pythonTool(ctx, "Flask-DB", "Flask-DB", ".", flaskDb("migrate", flask()));
  }
  const alembicIni = pypi("alembic") ? shallowest(ctx.rel, "alembic.ini") : undefined;
  if (alembicIni) {
    return pythonTool(ctx, "Alembic", "alembic", ctx.dirOf(alembicIni), "alembic upgrade head");
  }

  // unverified in Masonite's docs: `python craft migrate --force` (the `--force` flag, which skips
  // the production prompt, is in masonite-orm's MigrateCommand source).
  if (pypi("masonite") && ctx.exists("craft") && hasPythonModules(ctx, "databases/migrations")) {
    return pythonTool(ctx, "Masonite", "masonite", ".", "python craft migrate --force");
  }

  const tool = pypi("aerich") || pypi("tortoise-orm") ? await pyprojectTool(ctx) : undefined;
  const aerich = tool?.aerich as { location?: unknown } | undefined;
  if (pypi("aerich") && aerich !== undefined) {
    const location = cleanPath(
      typeof aerich.location === "string" ? aerich.location : "migrations",
    );
    const prefix = location === "." ? "" : `${location}/`;
    if (ctx.rel.some((file) => file.startsWith(prefix) && /\/\d+_[^/]*\.py$/.test(`/${file}`))) {
      return pythonTool(ctx, "Aerich", "aerich", ".", "aerich upgrade");
    }
  }
  // Tortoise's docs list `[tool.tortoise]` in pyproject.toml as a config source of the `tortoise`
  // CLI (besides `-c/--config`), so the command runs from the folder holding pyproject.toml.
  if (
    pypi("tortoise-orm") &&
    tool?.tortoise !== undefined &&
    ctx.rel.some(
      (file) => /(?:^|\/)migrations\/[^/]+\.py$/.test(file) && !/__init__\.py$/.test(file),
    )
  ) {
    return pythonTool(ctx, "Tortoise ORM", "tortoise-orm", ".", "tortoise migrate");
  }

  const piccoloConf = pypi("piccolo") ? shallowest(ctx.rel, "piccolo_conf.py") : undefined;
  if (piccoloConf && ctx.has(/(?:^|\/)piccolo_migrations\/(?!__init__\.py$)[^/]+\.py$/)) {
    return pythonTool(
      ctx,
      "Piccolo",
      "piccolo",
      ctx.dirOf(piccoloConf),
      "piccolo migrations forwards all",
    );
  }

  if (pypi("yoyo-migrations")) {
    const yoyo = await yoyoSources(ctx);
    if (yoyo) {
      return pythonTool(
        ctx,
        "Yoyo",
        "yoyo-migrations",
        yoyo.dir,
        `yoyo apply --batch --database ${YOYO_DATABASE} ${yoyo.sources.join(" ")}`,
      );
    }
  }

  // unverified: that `--database` takes a URL (peewee-migrate's docs give no format); the default
  // `migrations` folder is documented.
  if (pypi("peewee-migrate")) {
    const migration = ctx.matching(/(?:^|\/)migrations\/\d{3}_\w+\.py$/)[0];
    if (migration) {
      return pythonTool(
        ctx,
        "peewee-migrate",
        "peewee-migrate",
        ".",
        `pw_migrate migrate --database "$DATABASE_URL" --directory ${ctx.dirOf(migration)}`,
      );
    }
  }
  return undefined;
}
