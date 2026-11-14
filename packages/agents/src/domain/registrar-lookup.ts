import type { Registrar } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { errorText } from "./common";
import { type OtherRegistrarId, REGISTRAR_NAMES } from "./registrars";
import type { ResolvedDomainServices } from "./services";

/** One configured registrar account's answer: whether it holds the domain, or why it can't tell. */
export interface RegistrarAnswer {
  id: OtherRegistrarId;
  registrar?: Registrar;
  owns: boolean;
  /** Why the account could not be checked (made safe to show). */
  error?: string;
}

/** Where a domain is registered, as the switch to another Cloudflare account needs to know. */
export type DomainRegistrar =
  /** A Porkbun, Namecheap or GoDaddy account OpsCrew has credentials for. */
  | { kind: "api"; registrarId: OtherRegistrarId; registrar: Registrar }
  /** Cloudflare Registrar, in the Cloudflare account given. */
  | { kind: "cloudflare" }
  /** Any other registrar, or another account: the user changes the nameservers there. */
  | { kind: "other" };

type LookupServices = Pick<
  ResolvedDomainServices,
  "configuredRegistrars" | "otherRegistrar" | "registrar"
>;

/** The configured registrars other than Cloudflare. */
export function otherConfiguredRegistrars(
  services: Pick<ResolvedDomainServices, "configuredRegistrars">,
): OtherRegistrarId[] {
  return services
    .configuredRegistrars()
    .filter((id): id is OtherRegistrarId => id !== "cloudflare");
}

/** Asks each of `ids` (in parallel) whether its account holds `domain`. */
export async function askRegistrars(
  deps: PhaseDeps,
  services: Pick<ResolvedDomainServices, "otherRegistrar">,
  domain: string,
  ids: readonly OtherRegistrarId[],
): Promise<RegistrarAnswer[]> {
  const names = ids.map((id) => REGISTRAR_NAMES[id]);
  deps.reporter.step(
    `Looking for ${domain} in your ${listText(names)} account${ids.length === 1 ? "" : "s"}…`,
  );
  return Promise.all(
    ids.map(async (id): Promise<RegistrarAnswer> => {
      try {
        const registrar = services.otherRegistrar(id);
        if (registrar.ownsDomain === undefined) {
          return { id, registrar, owns: false, error: "its API cannot list domains" };
        }
        return { id, registrar, owns: await registrar.ownsDomain(domain) };
      } catch (error) {
        return { id, owns: false, error: errorText(deps, error) };
      }
    }),
  );
}

/**
 * Where `domain` is registered: the one configured Porkbun, Namecheap or GoDaddy account that
 * holds it (`api`); else Cloudflare Registrar in `cloudflareAccount` (an account id); else another
 * registrar (`other`). Not finding it is never an error; a registrar account that cannot be
 * checked (when Cloudflare does not hold the domain either), or two accounts that both hold it,
 * stop the run before any change.
 */
export async function findDomainRegistrar(
  deps: PhaseDeps,
  services: LookupServices,
  domain: string,
  cloudflareAccount: string,
): Promise<DomainRegistrar> {
  const ids = otherConfiguredRegistrars(services);
  const answers = ids.length === 0 ? [] : await askRegistrars(deps, services, domain, ids);
  const owners = answers.filter(
    (a): a is RegistrarAnswer & { registrar: Registrar } => a.owns && a.registrar !== undefined,
  );
  const [owner] = owners;
  if (owners.length === 1 && owner !== undefined) {
    return { kind: "api", registrarId: owner.id, registrar: owner.registrar };
  }
  if (owners.length > 1) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${domain} is in more than one of your registrar accounts (${listText(owners.map((o) => REGISTRAR_NAMES[o.id]))}), so OpsCrew does not know which one holds it. Nothing was changed.`,
      {
        hint: "Unset the API credentials of the registrar that no longer holds it, then run the command again.",
      },
    );
  }
  if ((await services.registrar(cloudflareAccount).getDomain(domain)) !== undefined) {
    return { kind: "cloudflare" };
  }
  const failed = answers.flatMap((a) =>
    a.error === undefined ? [] : [`${REGISTRAR_NAMES[a.id]} could not be checked (${a.error})`],
  );
  if (failed.length > 0) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew could not tell where ${domain} is registered: ${listText(failed)}. Nothing was changed.`,
      { hint: "Check those credentials and the internet connection, then run the command again." },
    );
  }
  return { kind: "other" };
}
