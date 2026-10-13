import type { DomainCheck } from "@opscrew/contracts";
import type { PhaseDeps } from "../context";
import {
  cents,
  contactExtensionReason,
  contactExtensionsNeeded,
  isDomainName,
  normaliseCheck,
  parseQuery,
  requireCloudflareToken,
  resolveAccount,
  tldOf,
} from "./common";
import { resolveDomainServices } from "./services";
import type { SearchDomainsOptions, SearchDomainsResult } from "./types";

/** Names checked live per search (the Cloudflare check takes up to 20 at once). */
const MAX_CHECKED = 20;

/**
 * `opscrew domain search`: suggestions for a name (the name itself first when it is a full
 * domain), each checked live. Registrable names come first, cheapest first year first; names
 * OpsCrew cannot buy (premium, taken, needs the dashboard …) follow with a plain reason.
 */
export async function searchDomains(
  deps: PhaseDeps,
  options: SearchDomainsOptions,
): Promise<SearchDomainsResult> {
  const query = parseQuery(options.query);
  requireCloudflareToken(deps);
  const services = resolveDomainServices(deps, options.services);
  const account = resolveAccount(await services.accounts(), options.account, options.accountOption);
  const registrar = services.registrar(account.id);

  const suggestions = await registrar.suggest(query);
  const names: string[] = [];
  for (const name of [
    ...(isDomainName(query) ? [query] : []),
    ...suggestions.map((s) => s.domain.trim().toLowerCase()),
  ]) {
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  const checked = names.slice(0, MAX_CHECKED);
  if (checked.length === 0) return { account, results: [] };

  const live = new Map(
    (await registrar.check(checked)).map((c) => [c.domain.trim().toLowerCase(), c] as const),
  );
  const normalised = checked.map((name) =>
    normaliseCheck(
      live.get(name) ?? {
        domain: name,
        registrable: false,
        reason: "Cloudflare did not confirm it in a live check; search again in a minute",
      },
    ),
  );
  // Extensions that need registrant data OpsCrew does not collect are bought in the dashboard.
  const contact = await contactExtensionsNeeded(
    services,
    account.id,
    normalised.filter((c) => c.registrable).map((c) => tldOf(c.domain)),
  );
  const results = normalised.map((c): DomainCheck => {
    const tld = tldOf(c.domain);
    return c.registrable && contact.get(tld) === true
      ? { ...c, registrable: false, reason: contactExtensionReason(tld) }
      : c;
  });
  return { account, results: sortChecks(results) };
}

/** Registrable first, by first-year price then name; the rest keep their order. */
function sortChecks(checks: DomainCheck[]): DomainCheck[] {
  const price = (c: DomainCheck) => cents(c.firstYear?.amount ?? Number.POSITIVE_INFINITY);
  const buyable = checks
    .filter((c) => c.registrable)
    .sort((a, b) => price(a) - price(b) || (a.domain < b.domain ? -1 : 1));
  return [...buyable, ...checks.filter((c) => !c.registrable)];
}
