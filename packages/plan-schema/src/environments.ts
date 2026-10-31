import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  APP_KEY_MESSAGE,
  APP_KEY_PATTERN,
  ENVIRONMENT_NAME_MESSAGE,
  ENVIRONMENT_NAME_PATTERN,
  OpsCrewError,
  type ProjectPaths,
  type ResolveProjectPathsOptions,
  resolveProjectPaths,
} from "@opscrew/core";
import { z } from "zod";
import { AppKeySchema, type AppRecord } from "./apps";
import { ArtifactError, readArtifactFields, readOptionalArtifact } from "./io";
import { cleanRepoPath, EnvironmentSchema } from "./plan";

/**
 * The fields of a plan that place it, all {@link environmentsOf} reads: its app's key and its
 * environment. The rest of the plan is the readers' own to check, so a plan the user is editing
 * (a service placed on a new server before design adds the network) still names its environment.
 */
const PlanPlaceSchema = z.looseObject({
  app: z.looseObject({ key: AppKeySchema.optional() }),
  environment: z
    .looseObject({
      name: EnvironmentSchema.shape.name,
      deploySource: EnvironmentSchema.shape.deploySource,
    })
    .optional(),
});

type PlanPlace = z.output<typeof PlanPlaceSchema>;

/** An app of the repository: a further app's key (none for the first app) and its folder. */
export interface RepositoryApp {
  key?: string;
  /** The app's folder in the repository, `.` for the repository's root. */
  dir: string;
}

/**
 * The repository's apps: the first app, always, at the requirements' `appDir`, else the analysed
 * facts' `appDir`, else `.`; then every further app by key, from its record
 * `opscrew/apps/<key>/app.yaml`. Each file is validated when read.
 * @throws ArtifactError for an invalid file, or a further app's folder with no record.
 * @throws OpsCrewError `INVALID_INPUT` for a folder in `opscrew/apps` that is not an app's key.
 */
export async function appsOf(root: string): Promise<RepositoryApp[]> {
  const paths = resolveProjectPaths(root);
  const requirements = await readOptionalArtifact("requirements", paths.files.requirements);
  const dir = requirements?.appDir ?? (await analysedAppDir(paths)) ?? ".";
  const further = await furtherApps(root);
  return [{ dir }, ...further.map(({ key, record }) => ({ key, dir: record.dir }))];
}

/**
 * The folders of the repository's apps ({@link appsOf}) other than the one `paths` belong to
 * (`paths.app`, absent for the first app), which an app built from the repository root leaves
 * out of its deploy workflow's push filter. A folder that is the app's own or holds it (the
 * repository root, `site` for an app in `site/admin`) is never one of them: leaving it out would
 * leave out the app's own files.
 */
export async function otherAppDirs(paths: Pick<ProjectPaths, "root" | "app">): Promise<string[]> {
  const apps = (await appsOf(paths.root)).map((app) => ({ ...app, dir: cleanRepoPath(app.dir) }));
  const own = apps.find((app) => app.key === paths.app)?.dir ?? ".";
  const holdsOwn = (dir: string) => dir === "." || own === dir || own.startsWith(`${dir}/`);
  return apps.filter((app) => app.key !== paths.app && !holdsOwn(app.dir)).map((app) => app.dir);
}

/** The folder of the app `opscrew/architecture.json` describes, when it exists. */
async function analysedAppDir(paths: ProjectPaths): Promise<string | undefined> {
  return (await readOptionalArtifact("architecture", paths.files.architecture))?.facts.appDir;
}

/** Every further app's key and record, by key. */
async function furtherApps(root: string): Promise<{ key: string; record: AppRecord }[]> {
  const appsDir = path.join(resolveProjectPaths(root).artefactsDir, "apps");
  const apps: { key: string; record: AppRecord }[] = [];
  for (const key of await folderNames(appsDir)) {
    if (!APP_KEY_PATTERN.test(key)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `opscrew/apps/${key} is not an app's folder: an app's key ${APP_KEY_MESSAGE}.`,
        { hint: "Rename the folder after its app's key, or remove it." },
      );
    }
    const file = path.join(appsDir, key, "app.yaml");
    const hint = `Add the app again with \`opscrew app add ${key} --dir <folder>\`, or remove opscrew/apps/${key}.`;
    let record: AppRecord | undefined;
    try {
      record = await readOptionalArtifact("app", file);
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      throw new ArtifactError({ code: "ARTIFACT_INVALID", file, issues: error.issues, hint });
    }
    if (record === undefined) {
      throw new ArtifactError({
        code: "ARTIFACT_MISSING",
        file,
        hint,
        message: `opscrew/apps/${key} has no app.yaml, the record of the app's folder in the repository. ${hint}`,
      });
    }
    apps.push({ key, record });
  }
  return apps;
}

/**
 * The environments of the repository's first app, or of the further app `app`: `prod` when its
 * `plan.yaml` exists, then each `environments/<name>/plan.yaml` in its folder (`opscrew/`, or
 * `opscrew/apps/<key>/`), every one after the environment it is promoted from (prod first,
 * otherwise by name). Of each plan only the fields that place it are read and checked (its app's
 * key and its environment): the rest is left to the commands that read the plan.
 * @throws ArtifactError for an invalid plan, a prod plan that names itself, a plan whose name is
 * not its folder's, or a plan whose `app.key` is not its app's.
 * @throws OpsCrewError `INVALID_INPUT` for an app the repository does not have (listing its apps),
 * a folder that is not an environment's name, an environment promoted from one that does not
 * exist, or environments promoted in a cycle.
 */
export async function environmentsOf(root: string, app?: string): Promise<string[]> {
  if (app !== undefined) await requireApp(root, app);
  const paths = resolveProjectPaths(root, app === undefined ? {} : { app });
  const folder = app === undefined ? "opscrew" : `opscrew/apps/${app}`;
  const appFlag = app === undefined ? "" : ` --app ${app}`;
  const sources = new Map<string, string | undefined>();
  const prod = await readArtifactFields("plan", paths.files.plan, PlanPlaceSchema);
  if (prod?.environment?.name !== undefined) {
    throw new ArtifactError({
      code: "ARTIFACT_INVALID",
      file: paths.files.plan,
      issues: [
        {
          path: "environment.name",
          message: `must be absent: ${folder}/plan.yaml is prod's plan`,
        },
      ],
      hint: `Remove environment.name, or move the plan to ${folder}/environments/<name>/plan.yaml.`,
    });
  }
  if (prod !== undefined) {
    checkKey(prod, paths.files.plan, app);
    sources.set("prod", sourceOf(prod.environment?.deploySource));
  }

  for (const name of await folderNames(path.join(paths.artefactsDir, "environments"))) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || name === "prod") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${folder}/environments/${name} is not an environment's folder: an environment's name ${ENVIRONMENT_NAME_MESSAGE}, and never "prod".`,
        { hint: "Rename the folder after its environment, or remove it." },
      );
    }
    const file = path.join(paths.artefactsDir, "environments", name, "plan.yaml");
    const plan = await readArtifactFields("plan", file, PlanPlaceSchema);
    if (plan === undefined) continue;
    if (plan.environment?.name !== name) {
      throw new ArtifactError({
        code: "ARTIFACT_INVALID",
        file,
        issues: [{ path: "environment.name", message: `must be "${name}", the folder's name` }],
        hint: "Fix environment.name, or move the plan to the folder of its environment.",
      });
    }
    checkKey(plan, file, app);
    sources.set(name, sourceOf(plan.environment.deploySource));
  }

  for (const [name, source] of sources) {
    if (source !== undefined && !sources.has(source)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The environment "${name}" is promoted from "${source}", which does not exist.`,
        {
          hint: `Add "${source}" with \`opscrew env add ${source}${appFlag}\`, or deploy "${name}" from main.`,
        },
      );
    }
  }
  return inSourceOrder(sources);
}

/**
 * {@link resolveProjectPaths} for an environment of the first app or of the further app
 * `options.app`, checked against {@link environmentsOf}: an unknown name is `INVALID_INPUT` with
 * the list of names.
 */
export async function resolveEnvironmentPaths(
  root: string,
  environment: string,
  options: Omit<ResolveProjectPathsOptions, "environment"> = {},
): Promise<ProjectPaths> {
  const { app } = options;
  const names = await environmentsOf(root, app);
  if (!names.includes(environment)) {
    const known = names.length === 0 ? "none yet" : names.map((name) => `"${name}"`).join(", ");
    const which = app === undefined ? "The app" : `The app ${app}`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${which} has no environment "${environment}". Its environments: ${known}.`,
      {
        hint: `Run \`opscrew env list${app === undefined ? "" : ` --app ${app}`}\` to see the app's environments.`,
      },
    );
  }
  return resolveProjectPaths(root, { ...options, environment });
}

/** Refuses `app`, a key the repository has no further app of, listing its apps. */
async function requireApp(root: string, app: string): Promise<void> {
  const keys = (await furtherApps(root)).map(({ key }) => key);
  if (keys.includes(app)) return;
  const known = keys.length === 0 ? "none yet" : keys.map((key) => `"${key}"`).join(", ");
  throw new OpsCrewError(
    "INVALID_INPUT",
    `The repository has no app "${app}". Its further apps: ${known}.`,
    {
      hint: "Run `opscrew app list` to see the repository's apps, or add this one with `opscrew app add <key> --dir <folder>`.",
    },
  );
}

/** Refuses a plan whose `app.key` is not the key of the app whose folder holds it. */
function checkKey(plan: PlanPlace, file: string, app: string | undefined): void {
  if (plan.app.key === app) return;
  throw new ArtifactError({
    code: "ARTIFACT_INVALID",
    file,
    issues: [
      {
        path: "app.key",
        message:
          app === undefined
            ? "must be absent: the plan is in the repository's first app's folder (opscrew/)"
            : `must be "${app}", the key of the app's folder (opscrew/apps/${app})`,
      },
    ],
    hint:
      app === undefined
        ? "Remove app.key, or move the plan to the folder of its app (opscrew/apps/<key>/)."
        : `Set app.key to "${app}", or move the plan to the folder of its app.`,
  });
}

type DeploySource = { from: "main" } | { from: "promote"; source: string } | undefined;

function sourceOf(deploySource: DeploySource): string | undefined {
  return deploySource?.from === "promote" ? deploySource.source : undefined;
}

/** The names of the folders in `dir`, by name; none when `dir` does not exist or is a file. */
async function folderNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Every environment after its source; of those ready, prod first, then by name. */
function inSourceOrder(sources: Map<string, string | undefined>): string[] {
  const order: string[] = [];
  const left = [...sources.keys()].sort((a, b) =>
    a === "prod" ? -1 : b === "prod" ? 1 : a < b ? -1 : 1,
  );
  while (left.length > 0) {
    const index = left.findIndex((name) => {
      const source = sources.get(name);
      return source === undefined || order.includes(source);
    });
    if (index === -1) throw cycleError(sources, left[0] as string);
    order.push(...left.splice(index, 1));
  }
  return order;
}

/** The cycle reached from `start` by following each environment's source, named in order. */
function cycleError(sources: Map<string, string | undefined>, start: string): OpsCrewError {
  const chain = [start];
  let next = sources.get(start) as string;
  while (!chain.includes(next)) {
    chain.push(next);
    next = sources.get(next) as string;
  }
  const cycle = [...chain.slice(chain.indexOf(next)), next];
  return new OpsCrewError(
    "INVALID_INPUT",
    `The environments ${cycle.map((name) => `"${name}"`).join(" → ")} are promoted in a cycle: each must come after its source.`,
    { hint: `Deploy "${next}" from main (environment.deploySource.from: main).` },
  );
}
