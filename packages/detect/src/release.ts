import { findDependency, type Unit } from "./manifests";
import { basenameRel, depthOf, dirnameRel, isWithin, relativeTo } from "./paths";

/** What {@link detectReleaseCommand} looks at. */
export interface ReleaseInputs {
  /** Repo-relative directory of the app (`.` for the root). */
  appDir: string;
  /** Repo-relative files of the repository that detection may look at. */
  files: readonly string[];
  /** Text of the app folder's `Procfile`, when there is one. */
  procfile: string | undefined;
  /** Text of the app folder's `.flaskenv`, when there is one. */
  flaskenv?: string | undefined;
  /** The detected start command (repository-root form), when there is one. */
  startCommand?: string | undefined;
  /** The app's manifest unit (its dependencies). */
  unit: Unit | undefined;
  /** Frameworks detected for the app. */
  frameworks: ReadonlySet<string>;
  /** Which package ecosystem builds the app. */
  ecosystem: "js" | "python" | "none";
}

/** `cd <dir> && <command>`, or the command alone at the repository root. */
function inFolder(dir: string, command: string): string {
  return dir === "." ? command : `cd ${dir} && ${command}`;
}

/** The shallowest file of `files` named `name`, ties broken by path. */
function shallowest(files: readonly string[], name: string): string | undefined {
  return files
    .filter((file) => basenameRel(file) === name)
    .sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1))[0];
}

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

/**
 * The command that prepares the database before each new version takes traffic, run from the
 * repository root like the start command: the Procfile `release:` line first (the Heroku
 * convention), else the framework's own migration command when the app has migrations:
 * Django `python manage.py migrate --noinput` (from the folder holding `manage.py`), Flask-Migrate
 * `flask db upgrade` (with a `migrations/` folder), Flask-DB `flask db migrate` (with a `db/`
 * folder), both naming the app with `FLASK_APP` when Flask would not find it by itself, Alembic
 * `alembic upgrade head` (from the folder holding `alembic.ini`) and Prisma
 * `npx prisma migrate deploy` (with `prisma/migrations/` and the `prisma` CLI as a dependency).
 * Whether the app's image can run it is decided when the plan is made. Undefined when none applies.
 */
export function detectReleaseCommand(inputs: ReleaseInputs): string | undefined {
  const { appDir, unit, frameworks, ecosystem } = inputs;
  const procfileRelease = /^release:[ \t]*(\S.*)$/m.exec(inputs.procfile ?? "")?.[1]?.trim();
  if (procfileRelease) return inFolder(appDir, procfileRelease);

  const appFiles = inputs.files.filter((file) => isWithin(appDir, file));
  const relative = appFiles.map((file) => relativeTo(appDir, file));
  const has = (pattern: RegExp) => relative.some((file) => pattern.test(file));
  const pypi = (name: string) => unit !== undefined && findDependency(unit, "pypi", name);

  if (ecosystem === "python") {
    const manage = frameworks.has("django") ? shallowest(appFiles, "manage.py") : undefined;
    if (manage) return inFolder(dirnameRel(manage), "python manage.py migrate --noinput");
    const flask = () => flaskApp(inputs.flaskenv, inputs.startCommand);
    if (pypi("flask-migrate") && has(/(?:^|\/)migrations\/env\.py$/)) {
      return inFolder(appDir, flaskDb("upgrade", flask()));
    }
    if (pypi("flask-db") && has(/(?:^|\/)db\/(?:alembic\.ini|env\.py)$/)) {
      return inFolder(appDir, flaskDb("migrate", flask()));
    }
    const alembicIni = pypi("alembic") ? shallowest(appFiles, "alembic.ini") : undefined;
    if (alembicIni) return inFolder(dirnameRel(alembicIni), "alembic upgrade head");
  }

  if (
    ecosystem === "js" &&
    unit !== undefined &&
    findDependency(unit, "npm", "prisma") &&
    has(/^prisma\/migrations\//)
  ) {
    return inFolder(appDir, "npx prisma migrate deploy");
  }
  return undefined;
}
