/**
 * What the local Docker pass (`docker.test.ts`) needs to build an image the way the deploy
 * workflow does: the Buildpacks and Railpack settings read from the workflow OpsCrew renders for
 * the plan, and the pinned pack and Railpack release archives (`toolDownloadUrl`), checked against
 * `pins.ts`.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PinArch,
  type RenderContext,
  renderWorkflow,
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
  const buildArgs = steps.find((step) => step.id === "railpack")?.with?.["build-args"];
  return {
    builder: "railpack",
    frontend: read(String(buildArgs ?? ""), /BUILDKIT_SYNTAX=(\S+)/, "the Railpack frontend"),
    sealLines,
  };
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
