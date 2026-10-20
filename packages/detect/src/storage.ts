/**
 * The app's persistent storage: SQLite database files and their folder, and the S3 client with
 * the variables it reads.
 */
import type { ProjectFacts } from "@opscrew/plan-schema";
import { ENV_LINE, envFileValue } from "./connections";
import { isClientExposed } from "./env";
import type { Dependency } from "./manifests";
import { basenameRel, dirnameRel, isWithin, joinRel, relativeTo, uniqueSorted } from "./paths";
import { cleanPath } from "./release/context";
import type { DetectedService } from "./services";
import { prismaProvider } from "./services";
import {
  type AppSources,
  isAppCodeFile,
  isRuntimeCodeFile,
  type SourceSignals,
  SQLITE_URL,
} from "./sources";

/** What storage detection reads about the app. */
export interface StorageContext extends AppSources {
  /** The texts of the committed env files. */
  envTexts: readonly string[];
  /** Laravel's `DB_CONNECTION`, from the committed env files. */
  dbConnection: string | undefined;
  /** A dependency or config shows a server database: Postgres, MySQL or MariaDB. */
  serverDatabase: boolean;
}

/** `path` (relative to `base`, both relative to the app) cleaned, or undefined outside the app. */
function appPath(base: string, path: string): string | undefined {
  const file = path.replace(/^file:/, "");
  if (/^(?:\/|[A-Za-z]:)/.test(file)) return undefined;
  const clean = cleanPath(joinRel(base, file));
  return clean === "." || clean.split("/").includes("..") ? undefined : clean;
}

/** The deepest folder holding all of `paths`. */
function commonDir(paths: readonly string[]): string {
  const dirs = paths.map((path) => dirnameRel(path).split("/"));
  const first = dirs[0] ?? ["."];
  let length = 0;
  while (length < first.length && dirs.every((dir) => dir[length] === first[length])) length++;
  return length === 0 ? "." : first.slice(0, length).join("/");
}

/** `BASE_DIR / "data" / "db.sqlite3"` and `os.path.join(BASE_DIR, "data", "db.sqlite3")`. */
const DJANGO_JOINED_PATHS = [
  /\bBASE_DIR((?:\s*\/\s*["'][\w.-]+["'])+)/g,
  /\bos\.path\.join\(\s*BASE_DIR((?:\s*,\s*["'][\w.-]+["'])+)\s*\)/g,
];

/** The `.sqlite3` databases of the `production` section of Rails' `config/database.yml`. */
function railsProductionDatabases(text: string): string[] {
  const section = /^production:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m.exec(text)?.[1];
  return [...(section ?? "").matchAll(/^\s+database:\s*["']?([^"'\s#]+\.sqlite3)\b/gm)].map(
    (match) => match[1] as string,
  );
}

/**
 * The SQLite database files the app writes, relative to the app, and their common folder: Rails'
 * production databases (four with Rails 8), the `.sqlite3` file Django's settings name, Laravel's
 * `database/database.sqlite` for `DB_CONNECTION=sqlite`, a Prisma `file:` URL (in the schema or
 * the committed env files, relative to the schema), better-sqlite3 or Drizzle file names in the
 * code, Python's `sqlite3.connect` in the code the running app uses, and SQLAlchemy `sqlite:///`
 * URLs in the committed env files and in that code (there only without a server database, see
 * {@link StorageContext.serverDatabase}). Flask-SQLAlchemy 3 opens a relative SQLAlchemy path in
 * the app's `instance/` folder (`app.instance_path`), plain SQLAlchemy in the working folder, the
 * app's. Undefined when none is found.
 */
export async function detectSqlite(ctx: StorageContext): Promise<ProjectFacts["sqlite"]> {
  const paths = new Set<string>();
  const add = (base: string, path: string) => {
    const clean = appPath(base, path);
    if (clean) paths.add(clean);
  };
  const inApp = (file: string) => isWithin(ctx.appDir, file);

  const databaseYml = await ctx.read(joinRel(ctx.appDir, "config/database.yml"));
  for (const path of railsProductionDatabases(databaseYml ?? "")) add(".", path);

  for (const [file, text] of ctx.settingsTexts) {
    if (!inApp(file) || !text.includes("django.db.backends.sqlite3")) continue;
    // Paths joined to BASE_DIR (the app folder) first, then plain literals in what is left.
    let rest = text;
    for (const pattern of DJANGO_JOINED_PATHS) {
      rest = rest.replace(pattern, (_whole, parts: string) => {
        const path = [...parts.matchAll(/["']([\w.-]+)["']/g)].map((m) => m[1]).join("/");
        if (path.endsWith(".sqlite3")) add(".", path);
        return "";
      });
    }
    for (const match of rest.matchAll(/["']([\w./-]+\.sqlite3)["']/g)) {
      if (!match[1]?.startsWith("django.db.")) add(".", match[1] as string);
    }
  }

  if (ctx.frameworks.has("laravel") && ctx.dbConnection === "sqlite") {
    add(".", "database/database.sqlite");
  }

  for (const file of ctx.files.filter((f) => f.endsWith(".prisma") && inApp(f))) {
    const schema = (await ctx.read(file)) ?? "";
    if (prismaProvider(schema) !== "sqlite") continue;
    const base = dirnameRel(relativeTo(ctx.appDir, file));
    const literal = /\burl\s*=\s*"(file:[^"]+)"/.exec(schema)?.[1];
    const variable = /\burl\s*=\s*env\(\s*"(\w+)"\s*\)/.exec(schema)?.[1];
    const fromEnv = variable
      ? ctx.envTexts.map((text) => envFileValue(text, variable)).find((v) => v?.startsWith("file:"))
      : undefined;
    const url = literal ?? fromEnv;
    if (url) add(base, url);
  }

  const flaskSqlalchemy = ctx.dependencies.some(
    (dep) => dep.ecosystem === "pypi" && dep.name === "flask-sqlalchemy",
  );
  const urlBase = flaskSqlalchemy ? "instance" : ".";
  for (const [file, found] of ctx.signals) {
    if (!inApp(file)) continue;
    const rel = relativeTo(ctx.appDir, file);
    if (isAppCodeFile(rel) || /^drizzle\.config\.[cm]?[jt]s$/.test(basenameRel(rel))) {
      for (const path of found.sqliteFiles) add(".", path);
    }
    // Python's: only from the code the running app uses, and a SQLAlchemy URL only without a
    // server database (it is then a fallback, such as a local default).
    if (!rel.endsWith(".py") || !isRuntimeCodeFile(rel)) continue;
    for (const path of found.sqliteConnects) add(".", path);
    if (!ctx.serverDatabase) for (const path of found.sqliteUrls) add(urlBase, path);
  }
  for (const line of ctx.envTexts.flatMap((text) => text.split(/\r?\n/))) {
    const value = ENV_LINE.exec(line)?.[2] ?? "";
    for (const match of value.matchAll(SQLITE_URL)) add(urlBase, match[1] as string);
  }

  if (paths.size === 0) return undefined;
  const sorted = uniqueSorted(paths);
  return { paths: sorted, dir: commonDir(sorted) };
}

/** S3 clients, the most specific first: the one named in the facts. */
const S3_CLIENTS = [
  "django-storages",
  "league/flysystem-aws-s3-v3",
  "async-aws/s3",
  "@aws-sdk/client-s3",
  "boto3",
  "aws-sdk-s3",
  "github.com/aws/aws-sdk-go-v2/service/s3",
  "software.amazon.awssdk:s3",
  "com.amazonaws:aws-java-sdk-s3",
  "AWSSDK.S3",
];

/** Packages that sign upload URLs for browsers. */
const PRESIGNERS = new Set(["@aws-sdk/s3-request-presigner", "@aws-sdk/s3-presigned-post"]);

/** A bucket's name (`S3_BUCKET`, `AWS_STORAGE_BUCKET_NAME`). */
const BUCKET_VARIABLE = /(?:^|_)BUCKET(?:_NAME)?$/;
/** An S3 endpoint (`AWS_ENDPOINT_URL_S3`, `AWS_S3_ENDPOINT_URL`, `MINIO_ENDPOINT`). */
const ENDPOINT_VARIABLE =
  /^(?:AWS|S3|MINIO|R2|SPACES|DO_SPACES|STORAGE|OBJECT_STORAGE)_(?:\w+_)?ENDPOINT(?:_URL)?(?:_S3)?$/;
/** Switches (`AWS_USE_PATH_STYLE_ENDPOINT`) and other vendors' storage. */
const NOT_S3_VARIABLE = /(?:^|_)(?:USE|ENABLE|DISABLE|FORCE|FIREBASE|GCS|GCP|GOOGLE|AZURE)(?:_|$)/;

/**
 * The app's S3 client (the `s3` service's, most specific first), whether it hands out presigned
 * upload URLs (a presigner package, or `generate_presigned_url`-like calls in the code), and the
 * variables it reads its bucket and endpoint from. Undefined without the `s3` service.
 */
export function detectObjectStorage(
  services: readonly DetectedService[],
  dependencies: readonly Dependency[],
  signals: ReadonlyMap<string, SourceSignals>,
  envNames: readonly string[],
): ProjectFacts["objectStorage"] {
  const s3 = services.find((service) => service.kind === "s3");
  if (!s3) return undefined;
  const clients = s3.evidence.flatMap((e) => (e.startsWith("dependency:") ? [e.slice(11)] : []));
  const client = S3_CLIENTS.find((name) => clients.includes(name)) ?? clients[0];
  if (client === undefined) return undefined;
  const presignedUploads =
    dependencies.some((dep) => dep.ecosystem === "npm" && PRESIGNERS.has(dep.name)) ||
    [...signals].some(
      ([file, found]) => found.markers.includes("presigned-upload") && isRuntimeCodeFile(file),
    );
  const variables = envNames.filter(
    (name) =>
      (BUCKET_VARIABLE.test(name) || ENDPOINT_VARIABLE.test(name)) &&
      !NOT_S3_VARIABLE.test(name) &&
      !isClientExposed(name),
  );
  return { client, presignedUploads, variables };
}
