/**
 * What the local Docker pass (`docker.test.ts`) needs to build an image the way the deploy
 * workflow does: the Buildpacks and Railpack settings read from the workflow OpsCrew renders for
 * the plan, the removal of the secret files before a Buildpacks build, and the pinned pack and
 * Railpack release archives (`toolDownloadUrl`), checked against `pins.ts`.
 */
import { createHash } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PinArch,
  type RenderContext,
  renderWorkflow,
  SECRET_FILE_PATTERNS,
  TOOLS,
  toolDownloadUrl,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { parse } from "yaml";

/** What the workflow's build job runs for a Buildpacks or Railpack plan. */
export type WorkflowBuild =
  | {
      builder: "buildpacks";
      /** `pack build` options: `--builder`, `--run-image` and the runtime version (`--env`). */
      packOptions: string[];
      /** The seal Dockerfile's lines after its `FROM`. */
      sealLines: string[];
    }
  | {
      builder: "railpack";
      /** The Railpack frontend the build names as `BUILDKIT_SYNTAX`. */
      frontend: string;
      /** `NAME=value` settings `railpack prepare` gets as `--env` (the runtime version). */
      prepareEnv: string[];
      /** `NAME=value` secrets the build step passes besides the build values (the same version). */
      secrets: string[];
      /** The seal Dockerfile's lines after its `FROM`: the `chown` and the `USER`. */
      sealLines: string[];
    };

interface Step {
  id?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
}

/** The build job reads nothing from the context but the SSH port (default 22). */
const CONTEXT: RenderContext = {
  opscrewVersion: "0.0.0-test",
  github: { owner: "opscrew-test", repo: "app" },
  deploySshPublicKey: "",
};

/** `match`'s first group in `text`, or an error saying the workflow changed. */
function read(text: string, match: RegExp, what: string): string {
  const found = match.exec(text)?.[1];
  if (found === undefined) {
    throw new Error(
      `The deploy workflow's build job no longer shows ${what}; update workflowBuild in packages/cli/test/e2e/builders.ts.`,
    );
  }
  return found;
}

/**
 * The Buildpacks or Railpack steps of the deploy workflow OpsCrew renders for `plan`, so the
 * local pass builds with the same builder images, runtime version and seal as CI.
 */
export function workflowBuild(plan: DeployPlan): WorkflowBuild {
  const workflow = parse(renderWorkflow(plan, CONTEXT).content) as {
    jobs: { build: { steps: Step[] } };
  };
  const steps = workflow.jobs.build.steps;
  const script = (match: (step: Step) => boolean) => steps.find(match)?.run ?? "";
  // printf '%s\n' "FROM $BASE" 'line' 'line' > "$RUNNER_TEMP/seal/Dockerfile"
  const sealed = read(
    script((step) => step.name === "Write the seal Dockerfile"),
    /"FROM \$BASE"((?: '[^']*')*) >/,
    "the seal Dockerfile",
  );
  const sealLines = [...sealed.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
  if (plan.app.build?.builder === "buildpacks") {
    const pack = script((step) => step.id === "pack");
    const settings = read(pack, /^settings=\((.*)\)$/m, "the Buildpacks settings");
    return {
      builder: "buildpacks",
      packOptions: [
        ...["--builder", read(pack, /--builder (\S+)/, "the Buildpacks builder")],
        ...["--run-image", read(pack, /--run-image (\S+)/, "the Buildpacks run image")],
        ...settings.split(/\s+/).filter((word) => word !== ""),
      ],
      sealLines,
    };
  }
  const railpack = steps.find((step) => step.id === "railpack")?.with;
  const values = read(
    script((step) => step.id === "prepare"),
    /^values=\((.*)\)$/m,
    "the Railpack prepare settings",
  );
  return {
    builder: "railpack",
    frontend: read(
      String(railpack?.["build-args"] ?? ""),
      /BUILDKIT_SYNTAX=(\S+)/,
      "the Railpack frontend",
    ),
    prepareEnv: values.split(/\s+/).filter((word) => word !== "" && word !== "--env"),
    // The build values come from GitHub secrets (`${{ secrets.… }}`); the rest are literal.
    secrets: String(railpack?.secrets ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("${{")),
    sealLines,
  };
}

/** A `.dockerignore` name pattern (`*` within a name) as a regular expression. */
function namePattern(pattern: string): RegExp {
  const name = pattern.replace(/^!/, "").replace(/^\*\*\//, "");
  return new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);
}

/**
 * The workflow's "Keep secret files out of the Buildpacks build" step: removes the files that
 * {@link SECRET_FILE_PATTERNS} names (except the `!` ones, `.env.example`) below `dir`, outside
 * `node_modules` and `.git`, since pack does not read `.dockerignore`. Returns their paths
 * relative to `dir`, sorted.
 */
export async function removeSecretFiles(dir: string): Promise<string[]> {
  const secret = SECRET_FILE_PATTERNS.filter((p) => !p.startsWith("!")).map(namePattern);
  const kept = SECRET_FILE_PATTERNS.filter((p) => p.startsWith("!")).map(namePattern);
  const removed: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") await visit(full);
      } else if (
        entry.isFile() &&
        secret.some((p) => p.test(entry.name)) &&
        !kept.some((p) => p.test(entry.name))
      ) {
        await rm(full);
        removed.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  await visit(dir);
  return removed.sort();
}

/**
 * Downloads the pinned release archive of `tool` for `arch` into `dir` and checks it against the
 * SHA-256 in `pins.ts`, as the workflow does. Returns the archive's path.
 */
export async function toolArchive(
  tool: "pack" | "railpack",
  arch: PinArch,
  dir: string,
): Promise<string> {
  const { sha256 } = TOOLS[tool];
  const url = toolDownloadUrl(tool, arch);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== sha256[arch]) {
    throw new Error(`${url} has SHA-256 ${actual}, but pins.ts pins ${sha256[arch]}.`);
  }
  const file = path.join(dir, `${tool}-${arch}.tgz`);
  await writeFile(file, body);
  return file;
}
