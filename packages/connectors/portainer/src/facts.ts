import type {
  PortainerUser,
  RegistryEntry,
  RegistrySummary,
  StackDetails,
  VolumeSummary,
} from "./client";

/** The oldest Portainer OpsCrew supports (research R1). */
export const MIN_PORTAINER_VERSION = "2.45";
/** The oldest Compose that supports inline `configs` (research R1, R7). */
export const MIN_COMPOSE_VERSION = "2.23";

/** Why OpsCrew cannot go on; every finding blocks the plan. */
export type PortainerFindingCode =
  | "token-rejected"
  | "access-denied"
  | "portainer-version"
  | "compose-version"
  | "environment-missing"
  | "environment-type"
  | "environment-down"
  | "architecture"
  | "stack-name-taken"
  | "project-name-taken"
  | "registry-name-taken"
  | "registry-missing"
  | "ports-taken"
  | "record-mismatch";

/** A blocking finding: what was found, in plain English, and what to do. */
export interface PortainerFinding {
  code: PortainerFindingCode;
  message: string;
  hint: string;
}

/** What kind of environment Portainer reports (only `docker` and `docker-agent` are supported). */
export type EnvironmentKind =
  | "docker"
  | "docker-agent"
  | "azure"
  | "edge"
  | "kubernetes"
  | "unknown";

/** An environment the token's user may see. */
export interface PortainerEnvironmentFacts {
  id: number;
  name: string;
  kind: EnvironmentKind;
  /** Portainer's raw environment type. */
  type: number;
  swarm?: boolean;
  status: "up" | "down" | "unknown";
}

/** A stack with one of OpsCrew's names on the chosen environment (env keys only, never values). */
export interface PortainerStackFacts extends StackDetails {
  /** The stack file Portainer holds (OpsCrew's stacks hold no secrets: values are `${VARS}`). */
  file?: string;
  /** SHA-256 (hex) of `file`. */
  fileSha256?: string;
}

/** The read-only inspection result (data-model "Portainer facts"). */
export interface PortainerFacts {
  version: string;
  composeVersion?: string;
  dockerVersion?: string;
  /** The token's user; absent when the token was rejected. */
  user?: PortainerUser;
  environments: PortainerEnvironmentFacts[];
  /** The chosen environment, when one was inspected. */
  environment?: {
    id: number;
    name: string;
    arch?: "amd64" | "arm64";
    dockerVersion?: string;
  };
  /** Stacks with OpsCrew's names on the chosen environment. */
  stacks: PortainerStackFacts[];
  /** Registry entries the token's user may use on the environment (absent when unreadable). */
  registries?: RegistrySummary[];
  /** Administrators only: every registry entry, with the environments it is granted on. */
  registryEntries?: RegistryEntry[];
  /** Administrators only: Compose projects with OpsCrew's names and how many containers they have. */
  projects?: { name: string; containers: number }[];
  /** Administrators only: host ports published by running containers, with their project. */
  publishedPorts?: { port: number; project?: string }[];
  /**
   * Volumes of OpsCrew's projects, or named like them (`opscrew-<app>_…`), that the token's user
   * can see, with their Compose project label (absent when unreadable).
   */
  volumes?: VolumeSummary[];
  /** Blocking findings that do not depend on what is planned. */
  findings: PortainerFinding[];
}

/** `major.minor[.patch]` of a version such as `2.45.2`, `v2.39.1` or `2.46.0-rc1`. */
export function parseVersion(text: string | undefined): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text?.trim() ?? "");
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** True when `version` is at least `minimum` (unparseable versions are not). */
export function atLeast(version: string | undefined, minimum: string): boolean {
  const have = parseVersion(version);
  const want = parseVersion(minimum);
  if (have === undefined || want === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  }
  return true;
}
