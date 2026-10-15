import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { PortainerApiError, type PortainerClient, type PortainerEnvironment } from "./client";
import {
  atLeast,
  type EnvironmentKind,
  findings as finding,
  MIN_COMPOSE_VERSION,
  MIN_PORTAINER_VERSION,
  type PortainerEnvironmentFacts,
  type PortainerFacts,
  type PortainerFinding,
  type PortainerStackFacts,
} from "./facts";
import { OpsCrewNameSchema } from "./names";

const OptionsSchema = z.strictObject({
  environmentId: z.int().positive().optional(),
  names: z.array(OpsCrewNameSchema).max(16),
});

/** Stops inspecting after a rejected token: every further call would be refused too. */
class TokenRejected extends Error {}

/**
 * Reads, without changing anything, what OpsCrew needs to know about the user's Portainer
 * (research R1–R4, R6): version and Compose, the token's user and role, the environments, and for
 * the chosen environment its architecture, the stacks with OpsCrew's `names` (env keys only), the
 * registry entries usable there and, for an administrator, the Compose projects with those names
 * and the published host ports. A rejected token and refused reads (401, 403) become findings;
 * an unreachable Portainer or a changed certificate throws.
 */
export async function inspectPortainer(
  client: PortainerClient,
  opts: { environmentId?: number; names: readonly string[] },
): Promise<PortainerFacts> {
  const parsed = OptionsSchema.safeParse({ ...opts, names: [...(opts?.names ?? [])] });
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `inspectPortainer needs a positive environment id and OpsCrew's stack names (opscrew-<app>…): ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const { environmentId } = parsed.data;
  const names = new Set(parsed.data.names.map((name) => name.toLowerCase()));
  const found: PortainerFinding[] = [];

  /** 401 stops the inspection with a finding; 403 is a finding naming the access. */
  async function read<T>(produce: () => Promise<T>, access: string): Promise<T | undefined> {
    try {
      return await produce();
    } catch (error) {
      if (error instanceof PortainerApiError && error.status === 401) {
        found.push(finding.tokenRejected());
        throw new TokenRejected();
      }
      if (error instanceof PortainerApiError && error.status === 403) {
        found.push(finding.accessDenied(access));
        return undefined;
      }
      throw error;
    }
  }
  /** Reads that are fine to miss (the planner explains what that means). */
  async function optional<T>(produce: () => Promise<T>): Promise<T | undefined> {
    try {
      return await produce();
    } catch (error) {
      if (error instanceof PortainerApiError && error.status === 403) return undefined;
      if (error instanceof PortainerApiError && error.status === 401) {
        found.push(finding.tokenRejected());
        throw new TokenRejected();
      }
      throw error;
    }
  }

  // Unauthenticated: an unreachable Portainer or a changed certificate stops here.
  const status = await client.systemStatus();
  const facts: PortainerFacts = {
    version: status.version,
    environments: [],
    stacks: [],
    findings: found,
  };
  try {
    await inspectInto(facts);
  } catch (error) {
    if (!(error instanceof TokenRejected)) throw error;
  }
  return facts;

  async function inspectInto(out: PortainerFacts): Promise<void> {
    const version = await read(() => client.systemVersion(), "read Portainer's version");
    if (version !== undefined) {
      out.version = version.version;
      if (version.edition !== undefined) out.edition = version.edition;
      if (version.composeVersion !== undefined) out.composeVersion = version.composeVersion;
      if (version.dockerVersion !== undefined) out.dockerVersion = version.dockerVersion;
    }
    if (!atLeast(out.version, MIN_PORTAINER_VERSION)) {
      found.push(finding.portainerVersion(out.version));
    }
    if (version !== undefined) {
      if (out.composeVersion === undefined) {
        found.push(finding.composeVersionUnknown());
      } else if (!atLeast(out.composeVersion, MIN_COMPOSE_VERSION)) {
        found.push(finding.composeVersion(out.composeVersion.replace(/^v/, "")));
      }
    }
    const user = await read(() => client.currentUser(), "read which user the token belongs to");
    if (user !== undefined) out.user = user;
    const environments = await read(() => client.listEnvironments(), "list the environments");
    out.environments = (environments ?? []).map(environmentFacts);
    if (environmentId === undefined) return;

    const env = out.environments.find((item) => item.id === environmentId);
    if (env === undefined) {
      if (environments !== undefined) found.push(finding.environmentMissing(environmentId));
      return;
    }
    out.environment = { id: env.id, name: env.name };
    const kind = unsupportedKind(env);
    if (kind !== undefined) {
      found.push(finding.environmentType(env.name, kind));
      return;
    }
    if (env.status === "down") {
      found.push(finding.environmentDown(env.name));
      return;
    }
    const info = await read(() => client.dockerInfo(env.id), "use the environment");
    if (info !== undefined) {
      if (info.swarmActive) {
        found.push(finding.environmentType(env.name, "a Docker Swarm"));
        return;
      }
      const arch = architecture(info.architecture);
      if (arch === undefined) {
        found.push(finding.architecture(env.name, info.architecture ?? "an unknown architecture"));
      } else {
        out.environment.arch = arch;
      }
      if (info.serverVersion !== undefined) out.environment.dockerVersion = info.serverVersion;
    }

    const stacks = await read(() => client.listStacks(env.id), "manage stacks on the environment");
    for (const stack of stacks ?? []) {
      if (!names.has(stack.name.toLowerCase())) continue;
      const item: PortainerStackFacts = { ...stack };
      const file = await optional(() => client.getStackFile(stack.id)).catch((error: unknown) => {
        if (error instanceof PortainerApiError) return undefined;
        throw error;
      });
      if (file !== undefined) {
        item.file = file;
        item.fileSha256 = createHash("sha256").update(file, "utf8").digest("hex");
      }
      out.stacks.push(item);
    }

    const registries = await optional(() => client.listEnvironmentRegistries(env.id));
    if (registries !== undefined) out.registries = registries;
    const volumes = await optional(() => client.listVolumes(env.id));
    if (volumes !== undefined) {
      // OpsCrew's projects' volumes, and any volume named like them (`opscrew-<app>_…`) whatever
      // its label says, so a teardown can refuse one that is not the app stack's.
      const prefixes = [...names].map((name) => `${name}_`);
      out.volumes = volumes.filter(
        (volume) =>
          (volume.project !== undefined && names.has(volume.project.toLowerCase())) ||
          prefixes.some((prefix) => volume.name.startsWith(prefix)),
      );
    }

    if (out.user?.role !== "admin") return;
    const entries = await read(
      () => client.listRegistries(),
      "list the registries (administrators only)",
    );
    if (entries !== undefined) out.registryEntries = entries;
    const containers = await read(
      () => client.listContainers(env.id),
      "list the environment's containers",
    );
    if (containers !== undefined) {
      const projects = new Map<string, number>();
      const ports = new Map<string, { port: number; project?: string }>();
      for (const container of containers) {
        const project = container.project?.toLowerCase();
        if (project !== undefined && names.has(project)) {
          projects.set(project, (projects.get(project) ?? 0) + 1);
        }
        if (!container.running) continue;
        for (const port of container.publishedPorts) {
          ports.set(`${port}/${container.project ?? ""}`, {
            port,
            ...(container.project !== undefined && { project: container.project }),
          });
        }
      }
      out.projects = [...projects]
        .map(([name, count]) => ({ name, containers: count }))
        .sort((a, b) => a.name.localeCompare(b.name));
      out.publishedPorts = [...ports.values()].sort(
        (a, b) => a.port - b.port || (a.project ?? "").localeCompare(b.project ?? ""),
      );
    }
  }
}

function environmentFacts(env: PortainerEnvironment): PortainerEnvironmentFacts {
  return {
    id: env.id,
    name: env.name,
    kind: environmentKind(env.type),
    type: env.type,
    ...(env.swarm !== undefined && { swarm: env.swarm }),
    status: env.status === 1 ? "up" : env.status === 2 ? "down" : "unknown",
  };
}

/**
 * What kind of environment Portainer's raw environment type is (1 Docker, 2 an agent on Docker,
 * 3 ACI, 4 and 7 Edge, 5 and 6 Kubernetes; anything else `unknown`). Swarm is not a type: see the
 * environment's `swarm` snapshot flag and Docker's `info`.
 */
export function environmentKind(type: number): EnvironmentKind {
  switch (type) {
    case 1:
      return "docker";
    case 2:
      return "docker-agent";
    case 3:
      return "azure";
    case 4:
    case 7:
      return "edge";
    case 5:
    case 6:
      return "kubernetes";
    default:
      return "unknown";
  }
}

/** Plain-English kind of an environment OpsCrew refuses, or `undefined` for a Docker host. */
function unsupportedKind(env: PortainerEnvironmentFacts): string | undefined {
  switch (env.kind) {
    case "docker":
    case "docker-agent":
      return env.swarm === true ? "a Docker Swarm" : undefined;
    case "edge":
      return "an Edge agent environment";
    case "kubernetes":
      return "a Kubernetes cluster";
    case "azure":
      return "an Azure Container Instances environment";
    default:
      return `an environment of a type OpsCrew does not know (${env.type})`;
  }
}

function architecture(text: string | undefined): "amd64" | "arm64" | undefined {
  switch (text?.toLowerCase()) {
    case "x86_64":
    case "amd64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return undefined;
  }
}
