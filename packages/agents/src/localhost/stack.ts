/**
 * The local stack's files (contracts/localhost.md "Localhost Compose and edge"): what provision
 * writes into the repository for the localhost target, and what the deploy copies into the app's
 * folder on this computer, as the workflow's upload does on a server. Also what those Compose files
 * run: their containers, networks, volumes and memory limits.
 */
import { join } from "node:path";
import { exists, type ProjectPaths, readTextIfExists } from "@opscrew/core";
import {
  EDGE_PROJECT,
  EDGE_PROXIES,
  edgeProxy,
  type LocalhostSite,
  type RenderedFile,
  type RuntimeContext,
  renderCompose,
  renderEdgeCompose,
  renderEdgeSite,
  renderRuntimeFiles,
  renderWorkflow,
  runtimeDir,
} from "@opscrew/iac-templates";
import type { DeployPlan, LocalhostDeployTarget } from "@opscrew/plan-schema";
import { parse } from "yaml";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { DeploymentPreview } from "../provision/render";
import { diffRenderedFiles } from "../shared";
import { composeProject, localRoots } from "./services";
import { localSite } from "./site";

/**
 * The render context of a localhost plan: the app's hostname on this computer (the scripts route
 * it, the site serves it) and the user's own additions to the proxy. Nothing else of a server's
 * context applies, and the image name comes from the repository at deploy time.
 */
export async function localRenderContext(
  deps: Pick<PhaseDeps, "paths" | "version">,
  plan: DeployPlan,
  site: LocalhostSite,
): Promise<RuntimeContext> {
  const additions = await exists(join(deps.paths.root, EDGE_PROXIES[edgeProxy(plan)].additions));
  return {
    opscrewVersion: deps.version,
    github: { owner: "", repo: "" },
    deploySshPublicKey: "",
    projectId: deps.paths.projectId,
    localhost: site,
    ...(additions ? { additions: true } : {}),
  };
}

/**
 * The repository files of a localhost plan: its Compose file, the edge's Compose file and the
 * app's site, and with the local runner (`environment.runner: local`) its deploy workflow, which
 * takes the app's hostname from `ctx.localhost` too.
 */
export function localStackFiles(plan: DeployPlan, ctx: RuntimeContext): RenderedFile[] {
  return [
    renderCompose(plan),
    ...renderRuntimeFiles(plan, ctx),
    ...renderEdgeSite(plan, ctx),
    ...(plan.environment?.runner === "local" ? [renderWorkflow(plan, ctx)] : []),
  ];
}

/**
 * The files `opscrew provision` would write for an app on this computer, compared with the
 * repository, without writing anything.
 */
export async function previewLocalStack(
  deps: Pick<PhaseDeps, "paths" | "version">,
  plan: DeployPlan,
): Promise<DeploymentPreview> {
  const files = localStackFiles(
    plan,
    await localRenderContext(deps, plan, await localSite(deps.paths, plan)),
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  return {
    plan,
    files: files.map((file) => ({ path: file.path, kind: file.kind })),
    created: diff.created.map((file) => file.path),
    changed: diff.changed.map((file) => file.path),
    unchanged: diff.unchanged.map((file) => file.path),
  };
}

/** One file the deploy copies into the app's folder: its path there, and its repository path. */
interface StackUpload {
  path: string;
  from: string;
}

/**
 * What the deploy copies into the app's folder from the repository, as the workflow's upload does:
 * every runtime file at its place under the runtime folder, and the user's additions as
 * `additions.<proxy>`.
 */
export function stackUploads(plan: DeployPlan, ctx: RuntimeContext): StackUpload[] {
  const dir = `${runtimeDir(plan)}/`;
  const runtime = localStackFiles(plan, ctx)
    .filter((file) => file.path.startsWith(dir))
    .map((file) => ({ path: file.path.slice(dir.length), from: file.path }));
  const proxy = edgeProxy(plan);
  return [
    ...runtime,
    ...(ctx.additions === true
      ? [{ path: `additions.${proxy}`, from: EDGE_PROXIES[proxy].additions }]
      : []),
  ];
}

/** The uploads' contents as the repository has them; a missing one is a bug of the flow. */
export async function uploadContents(
  paths: Pick<ProjectPaths, "root">,
  uploads: readonly StackUpload[],
): Promise<{ path: string; content: string }[]> {
  return Promise.all(
    uploads.map(async (upload) => {
      const content = await readTextIfExists(join(paths.root, upload.from));
      if (content === undefined) throw new Error(`${upload.from} was not written.`);
      return { path: upload.path, content: content.replaceAll("\r\n", "\n") };
    }),
  );
}

/** The parts of a Compose file the local stack reads. */
const ComposeSchema = z.looseObject({
  services: z.record(
    z.string(),
    z.looseObject({
      profiles: z.array(z.string()).optional(),
      mem_limit: z.string().optional(),
      ports: z.array(z.string()).optional(),
      deploy: z.looseObject({ replicas: z.number().optional() }).optional(),
    }),
  ),
  networks: z
    .record(z.string(), z.looseObject({ external: z.boolean().optional() }).nullable())
    .optional(),
  volumes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The ports OpsCrew's edge on this computer publishes on 127.0.0.1, from its Compose file in the
 * edge's folder; `undefined` when it has none, or it is not one OpsCrew wrote.
 */
export async function edgePorts(
  paths: Pick<ProjectPaths, "homeDir">,
): Promise<LocalhostDeployTarget["ports"] | undefined> {
  const text = await readTextIfExists(join(localRoots(paths).edge, "compose.yaml"));
  if (text === undefined) return undefined;
  const compose = ComposeSchema.safeParse(parse(text));
  if (!compose.success) return undefined;
  for (const service of Object.values(compose.data.services)) {
    // `127.0.0.1:<port>:<container port>`, the container's port being the proxy's own.
    const published = (container: readonly number[]) =>
      (service.ports ?? [])
        .map((port) => /^127\.0\.0\.1:(\d+):(\d+)$/.exec(port))
        .find((match) => match !== null && container.includes(Number(match[2])))?.[1];
    const https = Number(published([443, 8443]));
    const http = Number(published([80, 8080]));
    if ((https === 443 || https === 8443) && (http === 80 || http === 8080)) {
      return { https, http };
    }
  }
  return undefined;
}

/** What one Compose project of the stack runs. */
interface ComposeParts {
  project: string;
  /** The services that run as containers (not the `release` one-off), with their memory in MB. */
  services: { name: string; memoryMb: number }[];
  /** Its own networks (`<project>_<name>`); external ones, such as the edge's, not. */
  networks: string[];
  /** Its named volumes (`<project>_<name>`). */
  volumes: string[];
}

/** The parts of the Compose file `content` of `project`. */
function composeParts(project: string, content: string): ComposeParts {
  const compose = ComposeSchema.parse(parse(content));
  return {
    project,
    services: Object.entries(compose.services)
      .filter(([, service]) => service.profiles === undefined)
      .map(([name, service]) => ({
        name,
        memoryMb: Number.parseInt(service.mem_limit ?? "0", 10) * (service.deploy?.replicas ?? 1),
      })),
    networks: Object.entries(compose.networks ?? {})
      .filter(([, network]) => network?.external !== true)
      .map(([name]) => `${project}_${name}`),
    volumes: Object.keys(compose.volumes ?? {}).map((name) => `${project}_${name}`),
  };
}

/**
 * The sum of the stack's memory limits in MB: every container of the app's Compose project (a
 * worker's copies each) and of the edge's, as the plan renders them.
 */
export function stackMemoryMb(plan: DeployPlan): number {
  const sum = (project: string, content: string) =>
    composeParts(project, content).services.reduce((total, service) => total + service.memoryMb, 0);
  return (
    sum(composeProject(plan), renderCompose(plan).content) +
    sum(EDGE_PROJECT, renderEdgeCompose(plan).content)
  );
}

/** The app's Compose project and the edge's, from the uploads (`compose.yaml`, `edge/compose.yaml`). */
export function stackParts(
  plan: DeployPlan,
  uploads: readonly { path: string; content: string }[],
): { app: ComposeParts; edge: ComposeParts } {
  const file = (path: string) => {
    const found = uploads.find((upload) => upload.path === path);
    if (found === undefined) throw new Error(`The local stack has no ${path}.`);
    return found.content;
  };
  return {
    app: composeParts(composeProject(plan), file("compose.yaml")),
    edge: composeParts(EDGE_PROJECT, file("edge/compose.yaml")),
  };
}
