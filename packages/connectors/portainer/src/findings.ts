/**
 * Blocking findings: what OpsCrew found, in plain English, and what to do. Never a secret or
 * Portainer's address.
 */
import { plural } from "@opscrew/core";
import { PORTAINER_TOKEN_STEPS } from "./client";
import { MIN_COMPOSE_VERSION, MIN_PORTAINER_VERSION, type PortainerFinding } from "./facts";

export const findings = {
  tokenRejected: (): PortainerFinding => ({
    code: "token-rejected",
    message: "Portainer rejected the access token (HTTP 401).",
    hint: `${PORTAINER_TOKEN_STEPS}, set PORTAINER_API_KEY to it, then run the command again.`,
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
  stackNameTaken: (name: string, id: number): PortainerFinding => ({
    code: "stack-name-taken",
    message: `Portainer already has a stack named "${name}" (id ${id}) that OpsCrew did not create.`,
    hint: "OpsCrew never changes a stack it did not create. Choose another app name in `opscrew interview`, or remove or rename that stack in Portainer yourself, then run the command again.",
  }),
  projectNameTaken: (name: string, containers: number): PortainerFinding => ({
    code: "project-name-taken",
    message: `${plural(containers, "container")} on the environment belong${containers === 1 ? "s" : ""} to a Compose project named "${name}" that was started outside Portainer; a new stack with that name would take ${containers === 1 ? "it" : "them"} over.`,
    hint: `Choose another app name in \`opscrew interview\`, or stop that project yourself (docker compose -p ${name} down), then run the command again.`,
  }),
  registryNameTaken: (name: string, id: number): PortainerFinding => ({
    code: "registry-name-taken",
    message: `Portainer already has a registry entry named "${name}" (id ${id}) that OpsCrew did not add.`,
    hint: "OpsCrew never changes a registry entry it did not add. Rename or remove that entry in Portainer (Registries), or choose another app name, then run the command again.",
  }),
  /** `user` and `env`: the token's user and the environment, as Portainer names them. */
  registryMissing: (user: string, env: string): PortainerFinding => ({
    code: "registry-missing",
    message: `The app's image is private, and Portainer has no ghcr.io registry entry that ${user} may use on environment "${env}"; only an administrator can add one.`,
    hint: [
      "Do one of these once, then run `opscrew provision` again:",
      `1) As a Portainer administrator: Registries → Add registry → Custom registry; name it (for example ghcr), Registry URL ghcr.io, turn on Authentication, user name: your GitHub user name, password: a GitHub classic token with only the read:packages scope (https://github.com/settings/tokens/new?scopes=read:packages). Then open environment "${env}" → Registries, choose Manage access next to the entry and add ${user}.`,
      "2) Or make the image public: on GitHub open the package (your profile or organisation → Packages → the package) → Package settings → Change visibility → Public.",
    ].join(" "),
  }),
  portsTaken: (envName: string, taken: { port: number; project?: string }[]): PortainerFinding => {
    const ports = [...new Set(taken.map((item) => item.port))].sort((a, b) => a - b);
    const owners = [...new Set(taken.map((item) => item.project ?? "a container outside Compose"))];
    return {
      code: "ports-taken",
      message: `Host port${ports.length === 1 ? "" : "s"} ${ports.join(", ")} ${ports.length === 1 ? "is" : "are"} already in use on environment "${envName}" (by ${owners.join(", ")}), and the app stack needs ${ports.length === 1 ? "it" : "them"}.`,
      hint: "Free the ports, or choose the Cloudflare Tunnel or your own reverse proxy (with another port) in `opscrew interview`, then run the command again.",
    };
  },
} as const;
