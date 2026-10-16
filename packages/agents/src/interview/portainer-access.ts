import {
  type PortainerEnvironment as AdapterEnvironment,
  environmentKind as adapterKind,
  type DockerInfo,
  dockerArchitecture,
  fetchCertificateFingerprint,
  PortainerApiError,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEndpoint,
  portainerClient,
} from "@opscrew/connector-portainer";
import { OpsCrewError, type Redactor } from "@opscrew/core";
import { PORTAINER_TOKEN_VAR } from "../providers";
import type { PortainerAccess, PortainerEnvironment } from "./portainer";

/** Collaborators of {@link createPortainerAccess}; tests replace them with fakes. */
export interface PortainerAccessOptions {
  /** The Portainer client registers the token with it, so it never reaches the output. */
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

/** The interview's kind for an environment, from the adapter's kind (and Docker's Swarm mode). */
function environmentKind(
  env: Pick<AdapterEnvironment, "type" | "swarm">,
  info: Pick<DockerInfo, "swarmActive"> | undefined,
): PortainerEnvironment["kind"] {
  switch (adapterKind(env.type)) {
    case "docker":
    case "docker-agent":
      return env.swarm === true || info?.swarmActive === true ? "swarm" : "docker";
    case "edge":
      return "edge";
    case "kubernetes":
      return "kubernetes";
    default:
      return "other";
  }
}

/** Docker's architecture as OpsCrew builds images for it; `other` for one it does not. */
function architecture(text: string | undefined): PortainerEnvironment["arch"] {
  const name = text?.trim();
  return name === undefined || name === "" ? undefined : (dockerArchitecture(name) ?? "other");
}

/** A name the interview can show on one line (Portainer allows almost anything). */
function oneLine(name: string, id: number): string {
  const text = name.replace(/[\0\r\n]+/g, " ").trim();
  return text === "" ? `environment ${id}` : text;
}

/**
 * The default {@link PortainerAccess}, through `@opscrew/connector-portainer`: the certificate's
 * fingerprint read without trusting it (shown to the user before any token is sent), and the
 * environments listed with the certificate pinned. Each environment's kind follows the adapter's
 * `environmentKind` (`docker-agent` is a Docker host; a Swarm snapshot or Docker's Swarm mode is
 * `swarm`), and its architecture comes from Docker's `info` (only for a Docker host that is up).
 * A rejected token stops with its own plain message; other failures pass the adapter's error on.
 * The interview hides Portainer's address before it calls these.
 */
export function createPortainerAccess(options: PortainerAccessOptions): PortainerAccess {
  const makeClient = options.client ?? portainerClient;
  return {
    fetchCertificateFingerprint:
      options.fetchCertificateFingerprint ?? ((url) => fetchCertificateFingerprint(url)),
    async listEnvironments(url, token, certFingerprint) {
      const client = makeClient(
        { url, ...(certFingerprint !== undefined ? { certFingerprint } : {}) },
        token,
        { redactor: options.redactor },
      );
      const environments = await client.listEnvironments().catch((error: unknown) => {
        if (error instanceof PortainerApiError && error.status === 401) {
          throw new OpsCrewError(
            "CREDENTIALS_INVALID",
            "Portainer rejected the access token (HTTP 401), so OpsCrew saved nothing.",
            {
              hint: `Create an access token in Portainer (your user menu → My account → Access tokens) for a user who may manage stacks on the environment, set ${PORTAINER_TOKEN_VAR} to it and answer again.`,
              cause: error,
            },
          );
        }
        throw error;
      });
      return Promise.all(
        environments.map(async (env): Promise<PortainerEnvironment> => {
          const up = env.status === 1;
          const kind = adapterKind(env.type);
          const dockerHost = (kind === "docker" || kind === "docker-agent") && env.swarm !== true;
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
