import { exists } from "@opscrew/core";
import { PORTAINER_PORT, portainerHostname } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { portainerPasswordFile } from "../provision/own";
import { readServerAddresses } from "../shared";
import { readOwnServerRecord } from "../shared/own-server";
import { dashboardOnNetwork } from "../vpn/dashboards";
import { PORTAINER_LOCAL_URL } from "./settings";

/** What `opscrew portainer status` shows. Never the password itself. */
export interface PortainerStatus {
  enabled: boolean;
  /** The pinned Portainer CE version (when enabled). */
  version?: string;
  /** `local`: only through an SSH tunnel; `subdomain`: also behind Cloudflare Access. */
  access?: "local" | "subdomain";
  /** `https://<subdomain>` behind Cloudflare Access (subdomain opt-in only). */
  url?: string;
  /** Allowed email addresses for the subdomain. */
  allowedEmails?: string[];
  /** The address to open once the SSH tunnel runs. */
  localUrl: string;
  /** The SSH tunnel command; absent when this computer does not know the server's address. */
  tunnelCommand?: string;
  /**
   * Where Portainer answers on the app's private network when this computer is a device on it
   * (`device`) and Portainer is published there; then no SSH tunnel is needed.
   */
  privateUrl?: string;
  /** This computer's device on the app's private network, with `privateUrl`. */
  device?: string;
  /** Where the admin password is kept on this computer (`~/.opscrew/projects/<id>/portainer_password`). */
  passwordFile: string;
  /** False when the password file is not on this computer (for example another machine enabled it). */
  passwordFileExists: boolean;
}

/** Quotes a path for a copy-pasteable shell command. */
function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * The SSH tunnel command that makes Portainer (127.0.0.1:9443 on the server) reachable on this
 * computer: as the deploy user with the project's deploy key and pinned host key, on the server's
 * SSH port (`-p` only when it is not 22).
 */
function portainerTunnelCommand(
  deps: Pick<PhaseDeps, "paths">,
  server: { host: string; port: number },
): string {
  const port = server.port === 22 ? "" : `-p ${server.port} `;
  const { deployKey, knownHosts } = deps.paths.files;
  return `ssh ${port}-i ${quotePath(deployKey)} -o UserKnownHostsFile=${quotePath(knownHosts)} -N -L ${PORTAINER_PORT}:127.0.0.1:${PORTAINER_PORT} deploy@${server.host}`;
}

/** The server SSH reaches from this computer: the own server's login address, else the deployment's. */
export async function serverEndpoint(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<{ host: string; port: number } | undefined> {
  if (plan.target.provider === "own") {
    const own = await readOwnServerRecord(deps.paths).catch(() => undefined);
    return own === undefined ? undefined : { host: own.host, port: own.port };
  }
  const address = (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  return address === undefined ? undefined : { host: address.ipv4, port: 22 };
}

/** {@link PortainerStatus} for a plan, read from this computer only (nothing is contacted). */
export async function portainerStatusOf(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<PortainerStatus> {
  const passwordFile = portainerPasswordFile(deps.paths);
  const passwordFileExists = await exists(passwordFile);
  const portainer = plan.portainer?.enabled ? plan.portainer : undefined;
  if (portainer === undefined) {
    return { enabled: false, localUrl: PORTAINER_LOCAL_URL, passwordFile, passwordFileExists };
  }
  const server = await serverEndpoint(deps, plan);
  const hostname = portainerHostname(plan);
  const onNetwork = await dashboardOnNetwork(deps, plan, "portainer");
  return {
    enabled: true,
    version: portainer.version,
    access: portainer.access,
    ...(hostname !== undefined ? { url: `https://${hostname}` } : {}),
    ...(portainer.allowedEmails !== undefined
      ? { allowedEmails: [...portainer.allowedEmails] }
      : {}),
    localUrl: PORTAINER_LOCAL_URL,
    ...(server !== undefined ? { tunnelCommand: portainerTunnelCommand(deps, server) } : {}),
    ...(onNetwork !== undefined
      ? { privateUrl: `https://${onNetwork.address}:${onNetwork.port}`, device: onNetwork.device }
      : {}),
    passwordFile,
    passwordFileExists,
  };
}

/** Plain-English lines for a {@link PortainerStatus}: how to open Portainer, never the password. */
export function describePortainerStatus(status: PortainerStatus): string {
  if (!status.enabled) {
    return "Portainer is off for this project. Turn it on with `opscrew portainer enable`.";
  }
  const lines =
    status.privateUrl !== undefined
      ? [
          `Portainer CE ${status.version} listens on the server itself and, for your devices, on the app's private network.`,
          `This computer is device ${status.device}: with its WireGuard tunnel on, open ${status.privateUrl} (Portainer uses a self-signed certificate) and log in as admin. No SSH tunnel is needed.`,
        ]
      : [
          `Portainer CE ${status.version} listens only on the server itself (127.0.0.1:${PORTAINER_PORT}).`,
          "To open it, start this SSH tunnel and keep it running:",
          `  ${status.tunnelCommand ?? "(the server's address is not known on this computer; run `opscrew provision` here first)"}`,
          `Then open ${status.localUrl} (Portainer uses a self-signed certificate) and log in as admin.`,
        ];
  lines.push(
    status.passwordFileExists
      ? `The admin password is in ${status.passwordFile} (on this computer only).`
      : `The admin password would be in ${status.passwordFile}, which is not on this computer: copy it from the computer that turned Portainer on.`,
  );
  if (status.url !== undefined) {
    lines.push(
      `It is also served on ${status.url} behind Cloudflare Access, for ${(status.allowedEmails ?? []).join(", ")} (a one-time PIN goes to that address; Portainer's own login still applies).`,
    );
  }
  return lines.join("\n");
}

/**
 * `opscrew portainer status`: read-only. Prints the version, the access mode, the SSH tunnel
 * command (with the server's SSH port) and the local URL, or, when this computer is a device on
 * the app's private network, Portainer's address there, and the password file's path, never the
 * password.
 */
export async function portainerStatus(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
): Promise<PortainerStatus> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const status = await portainerStatusOf(deps, plan);
  deps.reporter.info(describePortainerStatus(status));
  return status;
}
