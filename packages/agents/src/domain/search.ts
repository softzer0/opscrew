import type { DomainCheck, Registrar, RegistrarId } from "@opscrew/contracts";
import { isUserFacingError, normalizeHostName, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import {
  cents,
  contactExtensionReason,
  contactExtensionsNeeded,
  errorText,
  isDomainName,
  normaliseCheck,
  parseQuery,
  providerText,
  requireCloudflareToken,
  resolveAccount,
  tldOf,
} from "./common";
import { type OtherRegistrarId, parseRegistrarId, REGISTRAR_NAMES } from "./registrars";
import { type ResolvedDomainServices, resolveDomainServices } from "./services";
import type {
  DomainAccount,
  DomainComparison,
  DomainOffer,
  SearchDomainsOptions,
  SearchDomainsResult,
} from "./types";

/** Names checked live per search (the Cloudflare check takes up to 20 at once). */
const MAX_CHECKED = 20;

/** Ownership lookups run at once for the names a search could not offer. */
const OWNERSHIP_CONCURRENCY = 4;

/**
 * Extensions a keyword is checked under at registrars other than Cloudflare and in comparisons
 * (Cloudflare's own search uses its suggestions). Kept short: every name costs a live check.
 */
const KEYWORD_TLDS = ["com", "net", "org", "io", "dev", "app", "co"] as const;

/**
 * `opscrew domain search`: suggestions for a name (the name itself first when it is a full
 * domain), each checked live. Registrable names come first, cheapest first year first; names
 * OpsCrew cannot buy (premium, taken, needs the dashboard …) follow with a plain reason.
 *
 * `registrar` searches at Porkbun, Namecheap or GoDaddy instead (no Cloudflare account needed);
 * `compare` checks the name at every configured registrar and lists the offers side by side.
 * A Cloudflare search always returns the account it searched.
 */
export function searchDomains(
  deps: PhaseDeps,
  options: SearchDomainsOptions & { registrar?: "cloudflare"; compare?: false },
): Promise<SearchDomainsResult & { account: DomainAccount }>;
export function searchDomains(
  deps: PhaseDeps,
  options: SearchDomainsOptions,
): Promise<SearchDomainsResult>;
export async function searchDomains(
  deps: PhaseDeps,
  options: SearchDomainsOptions,
): Promise<SearchDomainsResult> {
  const query = parseQuery(options.query);
  if (options.compare === true) return compareDomains(deps, query, options);
  const registrarId =
    options.registrar === undefined ? "cloudflare" : parseRegistrarId(options.registrar);
  if (registrarId !== "cloudflare") return searchElsewhere(deps, query, registrarId, options);
  requireCloudflareToken(deps);
  const services = resolveDomainServices(deps, options.services);
  const account = resolveAccount(await services.accounts(), options.account, options.accountOption);
  const registrar = services.registrar(account.id);

  const suggestions = await registrar.suggest(query);
  const names: string[] = [];
  for (const name of [
    ...(isDomainName(query) ? [query] : []),
    ...suggestions.map((s) => normalizeHostName(s.domain)),
  ]) {
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  const checked = names.slice(0, MAX_CHECKED);
  if (checked.length === 0) return { account, results: [] };
  const results = await markOwned(
    registrar,
    "cloudflare",
    await cloudflareChecks(services, account, checked, registrar),
  );
  return { account, results: sortChecks(results) };
}

/**
 * Cloudflare's live answers for `names` (in order), made consistent: premium names, names without
 * a price, extensions that need registrant data OpsCrew does not collect and names Cloudflare did
 * not confirm are not registrable, each with a plain reason.
 */
async function cloudflareChecks(
  services: ResolvedDomainServices,
  account: DomainAccount,
  names: readonly string[],
  registrar: Registrar,
): Promise<DomainCheck[]> {
  const normalised = await liveChecks(registrar, "Cloudflare", names);
  // Extensions that need registrant data OpsCrew does not collect are bought in the dashboard.
  const contact = await contactExtensionsNeeded(
    services,
    account.id,
    normalised.filter((c) => c.registrable).map((c) => tldOf(c.domain)),
  );
  return normalised.map((c): DomainCheck => {
    const tld = tldOf(c.domain);
    return c.registrable && contact.get(tld) === true
      ? { ...c, registrable: false, reason: contactExtensionReason(tld) }
      : c;
  });
}

/**
 * The names to check for a query at another registrar or in a comparison: a domain itself (and,
 * unless `exact`, the same name under a few common extensions); a keyword under those extensions.
 */
function candidateNames(query: string, exact: boolean): string[] {
  const domain = isDomainName(query) ? query : undefined;
  if (domain !== undefined && exact) return [domain];
  const label = (domain === undefined ? query : (domain.split(".")[0] ?? ""))
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  const names = domain === undefined ? [] : [domain];
  if (label !== "") {
    for (const tld of KEYWORD_TLDS) {
      const name = `${label}.${tld}`;
      if (isDomainName(name) && !names.includes(name)) names.push(name);
    }
  }
  if (names.length === 0) {
    throw new OpsCrewError("INVALID_INPUT", `"${query}" is not a name OpsCrew can search.`, {
      hint: "Search for a word or a domain, for example `opscrew domain search shopapp`.",
    });
  }
  return names.slice(0, MAX_CHECKED);
}

/**
 * A registrar's live answers for `names`, in order, made consistent (see `normaliseCheck`); names
 * it did not answer for get a plain reason.
 */
async function liveChecks(
  registrar: Registrar,
  registrarName: string,
  names: readonly string[],
): Promise<DomainCheck[]> {
  const live = new Map(
    (await registrar.check(names)).map((c) => [normalizeHostName(c.domain), c] as const),
  );
  return names.map((name) =>
    normaliseCheck(
      live.get(name) ?? {
        domain: name,
        registrable: false,
        reason: `${registrarName} did not confirm it in a live check; search again in a minute`,
      },
      registrarName,
    ),
  );
}

/** One registrar's answers for `names`, in order. */
async function otherChecks(
  services: ResolvedDomainServices,
  registrarId: OtherRegistrarId,
  names: readonly string[],
): Promise<DomainCheck[]> {
  const registrar = services.otherRegistrar(registrarId);
  return markOwned(
    registrar,
    registrarId,
    await liveChecks(registrar, REGISTRAR_NAMES[registrarId], names),
  );
}

/** The reason shown for a name that is already in the user's account at `registrarId`. */
function ownedReason(registrarId: RegistrarId, domain: string): string {
  return registrarId === "cloudflare"
    ? "Already in your Cloudflare account; its DNS is on Cloudflare already."
    : `Already in your ${REGISTRAR_NAMES[registrarId]} account. To use it with OpsCrew, run \`opscrew domain connect ${domain}\`.`;
}

/**
 * Whether the account holds the domain: `ownsDomain` when the registrar has it, else `getDomain`
 * (Cloudflare). Any failure counts as not known to be yours.
 */
async function ownedHere(registrar: Registrar, domain: string): Promise<boolean> {
  try {
    if (registrar.ownsDomain !== undefined) return (await registrar.ownsDomain(domain)) === true;
    return (await registrar.getDomain(domain)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Names the registrar reports not registrable but the account already holds get a reason that
 * says so (and, at another registrar, names `opscrew domain connect`). Only those names are looked
 * up, a few at a time; a failing lookup keeps the registrar's reason. `registrable` never changes.
 */
async function markOwned(
  registrar: Registrar,
  registrarId: RegistrarId,
  checks: readonly DomainCheck[],
): Promise<DomainCheck[]> {
  const out = [...checks];
  const pending = out.flatMap((c, i) => (c.registrable ? [] : [i]));
  const worker = async () => {
    for (let i = pending.shift(); i !== undefined; i = pending.shift()) {
      const check = out[i] as DomainCheck;
      if (await ownedHere(registrar, check.domain)) {
        out[i] = { ...check, reason: ownedReason(registrarId, check.domain) };
      }
    }
  };
  const workers = Math.min(OWNERSHIP_CONCURRENCY, pending.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

/** A search at Porkbun, Namecheap or GoDaddy: no Cloudflare token or account needed. */
async function searchElsewhere(
  deps: PhaseDeps,
  query: string,
  registrarId: OtherRegistrarId,
  options: SearchDomainsOptions,
): Promise<SearchDomainsResult> {
  const services = resolveDomainServices(deps, options.services, { requireCloudflare: false });
  const results = await otherChecks(services, registrarId, candidateNames(query, false));
  return { registrar: registrarId, results: sortChecks(results) };
}

/**
 * `--compare`: the name (or a keyword under a few extensions) checked at every configured
 * registrar in parallel. One registrar failing gives its offers a plain reason; the others still
 * answer. Offers are sorted by price only.
 */
async function compareDomains(
  deps: PhaseDeps,
  query: string,
  options: SearchDomainsOptions,
): Promise<SearchDomainsResult> {
  const services = resolveDomainServices(deps, options.services, { requireCloudflare: false });
  const ids = services.configuredRegistrars();
  if (ids.length === 0) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      "No registrar is set up, so OpsCrew cannot compare prices.",
      {
        hint: "Set CLOUDFLARE_API_TOKEN, or the API keys of Porkbun (PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY), Namecheap (NAMECHEAP_API_USER and NAMECHEAP_API_KEY) or GoDaddy (GODADDY_API_TOKEN), then try again.",
      },
    );
  }
  const names = candidateNames(query, true);
  const answers = await Promise.all(
    ids.map(async (id): Promise<{ checks: DomainCheck[]; account?: DomainAccount }> => {
      try {
        if (id !== "cloudflare") return { checks: await otherChecks(services, id, names) };
        const account = resolveAccount(
          await services.accounts(),
          options.account,
          options.accountOption,
        );
        const registrar = services.registrar(account.id);
        const checks = await cloudflareChecks(services, account, names, registrar);
        return { checks: await markOwned(registrar, "cloudflare", checks), account };
      } catch (error) {
        const hint = isUserFacingError(error) && error.hint ? providerText(deps, error.hint) : "";
        const reason = `${REGISTRAR_NAMES[id]} could not check it: ${errorText(deps, error)}${hint === "" ? "" : `. ${hint}`}`;
        return { checks: names.map((domain) => ({ domain, registrable: false, reason })) };
      }
    }),
  );
  const comparison: DomainComparison[] = names.map((domain, n) => ({
    domain,
    offers: sortOffers(
      ids.map((registrar: RegistrarId, i): DomainOffer => {
        const check = answers[i]?.checks[n] ?? { domain, registrable: false };
        return { ...check, registrar };
      }),
    ),
  }));
  const account = answers.find((a) => a.account !== undefined)?.account;
  return { account, results: [], comparison };
}

/** Compares two numbers that may be infinite. */
function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The currencies an offer's prices are in (renewal first). */
function currenciesOf(offer: DomainOffer): string[] {
  return [offer.renewal?.currency, offer.firstYear?.currency].filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
}

/**
 * By renewal price, then first-year price, and nothing else. Prices are compared only in the
 * currency of the first priced offer (in the configured order): offers priced in another currency
 * follow, sorted among themselves by currency, then price, with a plain note; offers that cannot be
 * bought here (or have no price) come last. Stable, so equal prices keep the configured order.
 */
function sortOffers(offers: DomainOffer[]): DomainOffer[] {
  const buyable = offers.filter((o) => o.registrable);
  const reference = buyable.map(currenciesOf).find((c) => c.length > 0)?.[0];
  const comparable = (o: DomainOffer) => currenciesOf(o).every((c) => c === reference);
  const price = (o: DomainOffer, which: "renewal" | "firstYear") =>
    cents(o[which]?.amount ?? Number.POSITIVE_INFINITY);
  const byPrice = (a: DomainOffer, b: DomainOffer) =>
    compareNumbers(price(a, "renewal"), price(b, "renewal")) ||
    compareNumbers(price(a, "firstYear"), price(b, "firstYear"));
  const order = [...new Set(buyable.flatMap(currenciesOf))];
  const currencyRank = (o: DomainOffer) => order.indexOf(currenciesOf(o)[0] ?? "");
  const others = buyable
    .filter((o) => !comparable(o))
    .sort((a, b) => compareNumbers(currencyRank(a), currencyRank(b)) || byPrice(a, b))
    .map(
      (o): DomainOffer => ({
        ...o,
        note: `priced in ${[...new Set(currenciesOf(o))].join(" and ")}; not compared with ${reference} prices`,
      }),
    );
  return [
    ...buyable.filter(comparable).sort(byPrice),
    ...others,
    ...offers.filter((o) => !o.registrable),
  ];
}

/** Registrable first, by first-year price then name; the rest keep their order. */
function sortChecks(checks: DomainCheck[]): DomainCheck[] {
  const price = (c: DomainCheck) => cents(c.firstYear?.amount ?? Number.POSITIVE_INFINITY);
  const buyable = checks
    .filter((c) => c.registrable)
    .sort((a, b) => price(a) - price(b) || (a.domain < b.domain ? -1 : 1));
  return [...buyable, ...checks.filter((c) => !c.registrable)];
}
