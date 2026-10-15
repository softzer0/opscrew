import type { PortainerAccess, PortainerEnvironment } from "@opscrew/agents";
import {
  type PortainerEnvironment as AdapterEnvironment,
  type DockerInfo,
  fetchCertificateFingerprint,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEndpoint,
  portainerClient,
} from "@opscrew/connector-portainer";
import type { Redactor } from "@opscrew/core";

/** Host names that mean "this computer"; never registered with the redactor (too common). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Registers Portainer's address (the URL, its origin and, unless it is this computer, its host
 * name) with `redactor`, so no output, tool result or audit entry shows it. Invalid addresses are
 * ignored (the interview refuses them with its own message).
 */
export function hidePortainerAddress(redactor: Pick<Redactor, "addLiteral">, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  redactor.addLiteral(url, "portainer-address");
  redactor.addLiteral(parsed.origin, "portainer-address");
  if (!LOOPBACK.has(parsed.hostname)) {
    redactor.addLiteral(parsed.host, "portainer-address");
    redactor.addLiteral(parsed.hostname, "portainer-address");
  }
}

/** The names under which Portainer's address could appear in text (for replacing them). */
export function portainerAddressNames(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const names = [url, parsed.origin];
  if (!LOOPBACK.has(parsed.hostname)) names.push(parsed.host, parsed.hostname);
  return [...new Set(names.filter((name) => name.trim() !== ""))];
}

/** Collaborators of {@link createPortainerAccess}; tests replace them with fakes. */
export interface PortainerAccessOptions {
  /** Registers the address and the token, so they never reach the output. */
  redactor: Redactor;
  /** The Portainer client (default: the pinned `portainerClient` of the adapter). */
  client?: (
    endpoint: PortainerEndpoint,
    token: string,
    deps: PortainerClientDeps,
  ) => Pick<PortainerClient, "listEnvironments" | "dockerInfo">;
  /** Reads the certificate's fingerprint without trusting it (default: the adapter's). */
  fetchCertificateFingerprint?: (url: string) => Promise<string>;
}

/** The interview's kind for an environment the adapter lists (raw type and Swarm flag). */
function environmentKind(
  env: Pick<AdapterEnvironment, "type" | "swarm">,
  info: Pick<DockerInfo, "swarmActive"> | undefined,
): PortainerEnvironment["kind"] {
  switch (env.type) {
    // 1 Docker, 2 an agent on Docker ("docker-agent"): both are a Docker host, unless Swarm.
    case 1:
    case 2:
      return env.swarm === true || info?.swarmActive === true ? "swarm" : "docker";
    case 4:
    case 7:
      return "edge";
    case 5:
    case 6:
      return "kubernetes";
    default:
      return "other";
  }
}

/** Docker's architecture name as OpsCrew builds images for it. */
function architecture(text: string | undefined): PortainerEnvironment["arch"] {
  switch (text?.trim().toLowerCase()) {
    case undefined:
    case "":
      return undefined;
    case "x86_64":
    case "amd64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return "other";
  }
}

/** A name the interview can show on one line (Portainer allows almost anything). */
function oneLine(name: string, id: number): string {
  const text = name.replace(/[\0\r\n]+/g, " ").trim();
  return text === "" ? `environment ${id}` : text;
}

/**
 * The interview's access to the user's Portainer, through `@opscrew/connector-portainer`: the
 * certificate's fingerprint read without trusting it (shown to the user before any token is sent),
 * and the environments listed with the certificate pinned. Each environment's kind follows the
 * adapter's (`docker-agent` is a Docker host; a Swarm snapshot or Docker's Swarm mode is `swarm`),
 * and its architecture comes from Docker's `info` (only for a Docker host that is up). Portainer's
 * address is registered with the redactor before anything is sent.
 */
export function createPortainerAccess(options: PortainerAccessOptions): PortainerAccess {
  const makeClient = options.client ?? portainerClient;
  const fingerprint =
    options.fetchCertificateFingerprint ?? ((url) => fetchCertificateFingerprint(url));
  return {
    async fetchCertificateFingerprint(url) {
      hidePortainerAddress(options.redactor, url);
      return fingerprint(url);
    },
    async listEnvironments(url, token, certFingerprint) {
      hidePortainerAddress(options.redactor, url);
      const client = makeClient(
        { url, ...(certFingerprint !== undefined ? { certFingerprint } : {}) },
        token,
        { redactor: options.redactor },
      );
      const environments = await client.listEnvironments();
      return Promise.all(
        environments.map(async (env): Promise<PortainerEnvironment> => {
          const up = env.status === 1;
          const dockerHost = (env.type === 1 || env.type === 2) && env.swarm !== true;
          // Docker's info is read only from a Docker host that is up; a failure leaves the
          // architecture unknown, and the interview says so for that environment only.
          const info =
            dockerHost && up ? await client.dockerInfo(env.id).catch(() => undefined) : undefined;
          const arch = architecture(info?.architecture);
          return {
            id: env.id,
            name: oneLine(env.name, env.id),
            kind: environmentKind(env, info),
            up,
            ...(arch !== undefined ? { arch } : {}),
          };
        }),
      );
    },
  };
}
