/**
 * The app's servers for `status`, `logs`, `verify` and `secure` (feature 018, FR-1811): a shell on
 * each server by name, the ports the app's containers publish there, and the private network's
 * links, all read-only.
 */
import { probePrivilege } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { publishedOnNetwork, shellQuote } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type NetworkLink, type ReadNetworkServices, readNetwork } from "../network";
import type { ProvisionServices } from "../provision/types";
import type { ServerLogin, serverRemote } from "../shared/server-address";
import { loginShell } from "../shared/servers";
import { CONTAINER_NAME } from "./components";

/** A shell on one of the app's servers ({@link serverShell}). */
export interface ServerShell {
  /** The login's own shell. */
  remote: RemoteExec;
  login: ServerLogin;
  /**
   * True on a server the user owns whose login reaches Docker only through passwordless sudo (the
   * host adapter's probe says `sudo`), for commands that add `sudo -n` themselves.
   */
  sudo: boolean;
  /** The shell that reaches Docker: `remote`, each command run through `sudo -n` when `sudo`. */
  docker: RemoteExec;
}

/**
 * A shell on the server `name` (`app` or an extra server) with its login: `serverRemote`, or
 * `services.remote` at the login's host (tests). On a server the user owns, the host adapter's
 * probe says once whether its login reaches Docker through passwordless sudo; a server OpsCrew
 * created is reached as `deploy`, which is in the docker group.
 */
export async function serverShell(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: Pick<ProvisionServices, "remote"> = {},
  options: Parameters<typeof serverRemote>[3] = {},
): Promise<ServerShell> {
  const { remote, login } = await loginShell(deps, plan, name, services, options);
  const sudo = login.own && (await probePrivilege(remote)) === "sudo";
  const docker: RemoteExec = !sudo
    ? remote
    : {
        host: remote.host,
        run: (command, runOptions) =>
          remote.run(`sudo -n sh -c ${shellQuote(command)}`, runOptions),
      };
  return { remote, login, sudo, docker };
}

/** A host port one of the app's running containers publishes. */
export interface PublishedPort {
  /** Its Compose service. */
  service: string;
  /** The host address it is published on: `10.200.4.2`, `0.0.0.0`, `::`. */
  address: string;
  port: number;
}

/** A TCP port mapping in `docker ps`'s Ports: `<address>:<host port>-><container port>/tcp`. */
const PORT_MAPPING = /([^\s,]+):(\d+)->\d+\/tcp/g;

/**
 * The host ports the app's running containers publish on a server (`docker ps` as the login,
 * read-only), by Compose service.
 * @throws OpsCrewError `COMMAND_FAILED` when the command fails.
 */
export async function readPublishedPorts(
  remote: RemoteExec,
  app: string,
): Promise<PublishedPort[]> {
  const result = await remote.run(
    `docker ps --filter label=com.docker.compose.project=${app} --filter label=com.docker.compose.oneoff=False --format '{{.Label "com.docker.compose.service"}}|{{.Ports}}'`,
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the ports the app's containers publish (exit code ${result.exitCode}).`,
      { hint: "Check that the server is on and reachable over SSH, then try again." },
    );
  }
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const [service = "", ports = ""] = line.trim().split("|");
    if (!CONTAINER_NAME.test(service)) return [];
    return [...ports.matchAll(PORT_MAPPING)].map((match) => ({
      service,
      address: match[1] ?? "",
      port: Number(match[2]),
    }));
  });
}

/** True when `published` holds `expected`: its service on that address and port. */
export function isPublished(
  published: readonly PublishedPort[],
  expected: Readonly<PublishedPort>,
): boolean {
  return published.some(
    (p) =>
      p.service === expected.service && p.port === expected.port && p.address === expected.address,
  );
}

/** What the server `server` should publish on its private address and does not (`published`). */
export function unpublishedOnNetwork(
  plan: DeployPlan,
  server: string,
  published: readonly PublishedPort[],
): ReturnType<typeof publishedOnNetwork> {
  return publishedOnNetwork(plan, server).filter((expected) => !isPublished(published, expected));
}

/**
 * The private network's links (`readNetwork`) through the logins' shells, as {@link serverShell}'s;
 * `network` replaces the WireGuard read in tests.
 */
export function readLinks(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote"> = {},
  network: ReadNetworkServices = {},
): Promise<NetworkLink[]> {
  return readNetwork(deps, plan, {
    remote: async (server) => (await loginShell(deps, plan, server, services)).remote,
    ...network,
  });
}
