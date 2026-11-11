import type {
  ComputeCatalog,
  CredentialCheck,
  CredentialRequirement,
  ProviderConnectorDeps,
  VpsConnector,
} from "@opscrew/contracts";
import { errorText, listText, Redactor } from "@opscrew/core";
import { StaticContaboCatalog } from "./catalog";
import {
  CONTABO_CREDENTIALS_HINT,
  CONTABO_CREDENTIALS_URL,
  CONTABO_ENV,
  ContaboClient,
  readContaboCredentials,
} from "./client";
import { contaboServerApi } from "./servers";

/** Credentials OpsCrew needs for Contabo: all four of the account's API credentials. */
export const CONTABO_CREDENTIALS: CredentialRequirement = {
  envVars: Object.values(CONTABO_ENV),
  description:
    "Contabo's API credentials: the client id and client secret, the API user (the account's login email) and the API password, all from the Customer Control Panel (Account → Security). Contabo has no scoped keys: they reach the whole account, so keep them only where OpsCrew runs.",
  scopes: [],
  createUrl: CONTABO_CREDENTIALS_URL,
};

/** The Contabo connector. */
export interface ContaboConnector extends VpsConnector {
  readonly id: "contabo";
}

/**
 * Creates the Contabo connector: credential check, the dated static catalogue (Contabo has no
 * price API) and the server API. The four credentials are read from `CNTB_OAUTH2_*` and
 * registered with the redactor as they are read; without all four, nothing calls Contabo.
 */
export function contaboConnector(deps: ProviderConnectorDeps): ContaboConnector {
  const redactor = deps.redactor ?? new Redactor();
  const { credentials, missing } = readContaboCredentials(deps.env, redactor);
  const now = deps.now ?? (() => new Date());
  const client =
    credentials === undefined
      ? undefined
      : new ContaboClient({
          credentials,
          redactor,
          ...(deps.fetch && { fetch: deps.fetch }),
          ...(deps.version && { version: deps.version }),
          ...(deps.sleep && { sleep: deps.sleep }),
          now: () => now().getTime(),
        });
  let catalog: ComputeCatalog | undefined;

  return {
    id: "contabo",
    displayName: "Contabo",
    credentials: CONTABO_CREDENTIALS,
    configured: client !== undefined,
    servers: client === undefined ? undefined : contaboServerApi(client),
    catalog: () => {
      catalog ??= new StaticContaboCatalog();
      return catalog;
    },
    async verifyCredentials(): Promise<CredentialCheck> {
      if (client === undefined) {
        const verb = missing.length === 1 ? "is" : "are";
        return {
          ok: false,
          message: `${listText(missing)} ${verb} not set: Contabo needs all four. ${CONTABO_CREDENTIALS_HINT}`,
        };
      }
      try {
        await client.verify();
        return { ok: true, message: "The Contabo API credentials work." };
      } catch (error) {
        const message = errorText(error, "Could not check the Contabo API credentials.");
        return { ok: false, message: redactor.redact(message) };
      }
    },
  };
}
