import type {
  ComputeCatalog,
  ComputeLocation,
  ComputeOffer,
  CredentialCheck,
  ProviderExtras,
  VpsConnector,
} from "@opscrew/contracts";
import { z } from "zod";

/**
 * What inspection found out about a server the user owns, as design needs it. The caller inspects
 * the server (over SSH, through the host adapter) and passes these in; nothing here connects.
 */
export const OwnServerFactsSchema = z.strictObject({
  /** CPU architecture; the app image is built for it. */
  arch: z.enum(["amd64", "arm64"]),
  /** Number of CPUs. */
  vcpus: z.int().positive(),
  /** Total memory in GB (0 when inspection could not read it; design then warns). */
  memoryGb: z.number().nonnegative(),
  /** Free disk space on `/` in GB; 0 for a full disk (design then warns). */
  diskFreeGb: z.number().nonnegative(),
  /** Operating system for display, for example `Ubuntu 24.04`. */
  os: z.string().min(1).max(100).optional(),
});
/** What inspection found out about a server the user owns (see {@link OwnServerFactsSchema}). */
export type OwnServerFacts = z.infer<typeof OwnServerFactsSchema>;

/** How OpsCrew logs in to a server the user owns, without its address. */
export interface OwnServerLogin {
  /** The admin login: root or a user with passwordless sudo. */
  user: string;
  /** SSH port. */
  port: number;
  /** True when the SSH agent holds the key. */
  agent: boolean;
  /** Path to the private key when the agent is not used. */
  keyPath?: string;
}

/** Options of {@link ownServerConnector}. */
export interface OwnServerConnectorOptions {
  /** The inspected server; without it the catalogue is empty. Validated. */
  facts?: OwnServerFacts;
  /** How OpsCrew logs in; without it `verifyCredentials` says the server is not set up yet. */
  login?: OwnServerLogin;
  now?: () => Date;
}

/** Location id and server type of the only option on a server the user owns. */
export const OWN_SERVER_ID = "own";

/** The key a login uses, in words: `the key in your SSH agent` or `the key <path>`. */
export function sshKeyWords(login: Pick<OwnServerLogin, "agent" | "keyPath">): string {
  return login.agent || login.keyPath === undefined
    ? "the key in your SSH agent"
    : `the key ${login.keyPath}`;
}

/**
 * The connector of a server the user already owns (`own`). There is no provider API and no token:
 * `verifyCredentials` describes the SSH login (it does not connect; provision checks the
 * connection and the host key), `catalog()` offers the inspected server as the single, unpriced
 * option, and `servers` is undefined (OpsCrew never creates, snapshots or deletes the server).
 */
export function ownServerConnector(options: OwnServerConnectorOptions = {}): VpsConnector {
  const facts = options.facts === undefined ? undefined : OwnServerFactsSchema.parse(options.facts);
  const now = options.now ?? (() => new Date());
  const { login } = options;
  return {
    id: "own",
    displayName: "Your own server",
    credentials: {
      envVars: [],
      description:
        "No API token. OpsCrew connects to your server over SSH with your key (a key file or the SSH agent); it never asks for or stores a password or passphrase.",
      scopes: [],
      createUrl: "",
    },
    configured: true,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (login === undefined) {
        return {
          ok: false,
          message:
            "OpsCrew does not know how to reach your server yet. Run `opscrew interview` and give the server's address, SSH port, user and key.",
        };
      }
      return {
        ok: true,
        identity: `${login.user}, SSH port ${login.port}`,
        message: `No API token is needed: OpsCrew connects to your server over SSH as ${login.user} on port ${login.port} with ${sshKeyWords(login)}. \`opscrew provision\` checks the connection and asks you to confirm the server's host key.`,
      };
    },
    catalog: () => ownServerCatalog(facts, now),
    servers: undefined,
  };
}

function ownServerCatalog(facts: OwnServerFacts | undefined, now: () => Date): ComputeCatalog {
  const location: ComputeLocation = { id: OWN_SERVER_ID, name: "Your server", country: "" };
  return {
    provider: "own",
    async listLocations() {
      return [location];
    },
    async listOffers(where?: string): Promise<ComputeOffer[]> {
      if (facts === undefined || (where !== undefined && where !== OWN_SERVER_ID)) return [];
      return [
        {
          provider: "own",
          id: OWN_SERVER_ID,
          ...(facts.os !== undefined ? { description: facts.os } : {}),
          vcpus: facts.vcpus,
          memoryGb: facts.memoryGb,
          diskGb: facts.diskFreeGb,
          cpuType: "shared",
          architecture: facts.arch === "arm64" ? "arm" : "x86",
          location: OWN_SERVER_ID,
          monthly: { amount: 0, currency: "EUR" },
          pricesIncludeVat: false,
          deprecated: false,
          available: true,
          source: "live",
          asOf: now().toISOString(),
        },
      ];
    },
    async extras(): Promise<ProviderExtras> {
      return { pricesIncludeVat: false, source: "live", asOf: now().toISOString() };
    },
  };
}
