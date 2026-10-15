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
  edition?: string;
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

/** Plain-English findings; never a secret or Portainer's address. */
export const findings = {
  tokenRejected: (): PortainerFinding => ({
    code: "token-rejected",
    message: "Portainer rejected the access token (HTTP 401).",
    hint: "Create an access token in Portainer (your user menu → My account → Access tokens) for a user who may manage stacks on the environment, set it as PORTAINER_API_KEY and run the command again.",
  }),
  accessDenied: (what: string): PortainerFinding => ({
    code: "access-denied",
    message: `Portainer refused (HTTP 403): the token's user may not ${what}.`,
    hint: "In Portainer, give the token's user access to the environment (Environments → the environment → Manage access), or use an administrator's token, then run the command again.",
  }),
  portainerVersion: (version: string): PortainerFinding => ({
    code: "portainer-version",
    message: `Portainer ${version} is older than ${MIN_PORTAINER_VERSION}, the oldest version OpsCrew supports.`,
    hint: "Update Portainer to the current LTS release (2.45 or newer), then run the command again.",
  }),
  composeVersion: (version: string): PortainerFinding => ({
    code: "compose-version",
    message: `Portainer deploys stacks with Docker Compose ${version}; OpsCrew needs ${MIN_COMPOSE_VERSION} or newer (for inline configuration).`,
    hint: "Update Portainer (newer releases bundle a newer Compose), then run the command again.",
  }),
  composeVersionUnknown: (): PortainerFinding => ({
    code: "compose-version",
    message: `OpsCrew could not read the Compose version Portainer deploys stacks with, so it cannot check that it is ${MIN_COMPOSE_VERSION} or newer.`,
    hint: "Update Portainer to the current LTS release (it reports its Compose version), then run the command again.",
  }),
  environmentMissing: (id: number): PortainerFinding => ({
    code: "environment-missing",
    message: `The token's user cannot see environment ${id} in Portainer.`,
    hint: "Pick an environment the user may use, or in Portainer give the user access to it (Environments → the environment → Manage access); then run `opscrew interview` again.",
  }),
  environmentType: (name: string, kind: string): PortainerFinding => ({
    code: "environment-type",
    message: `Environment "${name}" is ${kind}; OpsCrew deploys only to a single Docker host for now.`,
    hint: "Pick a single Docker host environment (Docker Standalone, directly or through the Portainer agent), then run `opscrew interview` again.",
  }),
  environmentDown: (name: string): PortainerFinding => ({
    code: "environment-down",
    message: `Portainer reports environment "${name}" as down.`,
    hint: "Check that Docker and (if used) the Portainer agent run on that host, then run the command again.",
  }),
  architecture: (name: string, arch: string): PortainerFinding => ({
    code: "architecture",
    message: `Environment "${name}" runs on ${arch}; OpsCrew builds images for amd64 and arm64 only.`,
    hint: "Pick an environment on a 64-bit Intel/AMD or ARM host.",
  }),
} as const;
