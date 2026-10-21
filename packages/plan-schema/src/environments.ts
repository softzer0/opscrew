import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  ENVIRONMENT_NAME_MESSAGE,
  ENVIRONMENT_NAME_PATTERN,
  OpsCrewError,
  type ProjectPaths,
  type ResolveProjectPathsOptions,
  resolveProjectPaths,
} from "@opscrew/core";
import { ArtifactError, readOptionalArtifact } from "./io";

/**
 * The app's environments: `prod` when `opscrew/plan.yaml` exists, then each
 * `opscrew/environments/<name>/plan.yaml`, every one after the environment it is promoted from
 * (prod first, otherwise by name). Each plan is validated when read.
 * @throws ArtifactError for an invalid plan, a prod plan that names itself, or a plan whose name
 * is not its folder's.
 * @throws OpsCrewError `INVALID_INPUT` for a folder that is not an environment's name, an
 * environment promoted from one that does not exist, or environments promoted in a cycle.
 */
export async function environmentsOf(root: string): Promise<string[]> {
  const paths = resolveProjectPaths(root);
  const sources = new Map<string, string | undefined>();
  const prod = await readOptionalArtifact("plan", paths.files.plan);
  if (prod?.environment?.name !== undefined) {
    throw new ArtifactError({
      code: "ARTIFACT_INVALID",
      file: paths.files.plan,
      issues: [
        { path: "environment.name", message: "must be absent: opscrew/plan.yaml is prod's plan" },
      ],
      hint: "Remove environment.name, or move the plan to opscrew/environments/<name>/plan.yaml.",
    });
  }
  if (prod !== undefined) sources.set("prod", sourceOf(prod.environment?.deploySource));

  for (const name of await folderNames(path.join(paths.artefactsDir, "environments"))) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || name === "prod") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `opscrew/environments/${name} is not an environment's folder: an environment's name ${ENVIRONMENT_NAME_MESSAGE}, and never "prod".`,
        { hint: "Rename the folder after its environment, or remove it." },
      );
    }
    const file = path.join(paths.artefactsDir, "environments", name, "plan.yaml");
    const plan = await readOptionalArtifact("plan", file);
    if (plan === undefined) continue;
    if (plan.environment?.name !== name) {
      throw new ArtifactError({
        code: "ARTIFACT_INVALID",
        file,
        issues: [{ path: "environment.name", message: `must be "${name}", the folder's name` }],
        hint: "Fix environment.name, or move the plan to the folder of its environment.",
      });
    }
    sources.set(name, sourceOf(plan.environment.deploySource));
  }

  for (const [name, source] of sources) {
    if (source !== undefined && !sources.has(source)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The environment "${name}" is promoted from "${source}", which does not exist.`,
        {
          hint: `Add "${source}" with \`opscrew env add ${source}\`, or deploy "${name}" from main.`,
        },
      );
    }
  }
  return inSourceOrder(sources);
}

/**
 * {@link resolveProjectPaths} for an environment of the app, checked against
 * {@link environmentsOf}: an unknown name is `INVALID_INPUT` with the list of names.
 */
export async function resolveEnvironmentPaths(
  root: string,
  environment: string,
  options: Omit<ResolveProjectPathsOptions, "environment"> = {},
): Promise<ProjectPaths> {
  const names = await environmentsOf(root);
  if (!names.includes(environment)) {
    const known = names.length === 0 ? "none yet" : names.map((name) => `"${name}"`).join(", ");
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app has no environment "${environment}". Its environments: ${known}.`,
      { hint: "Run `opscrew env list` to see the app's environments." },
    );
  }
  return resolveProjectPaths(root, { ...options, environment });
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
