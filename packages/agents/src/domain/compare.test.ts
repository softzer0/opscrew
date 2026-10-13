import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { buyable, domainProject, TOKEN, visibleText } from "./__fixtures__/fakes";
import { searchDomains } from "./search";

const DOMAIN = "shopapp.com";

/** Cloudflare, Porkbun, Namecheap and GoDaddy with shopapp.com at different prices. */
async function fourRegistrars() {
  const project = await domainProject();
  const { cf } = project;
  cf.checks.set(DOMAIN, buyable(DOMAIN, 10.44, 10.44));
  const pb = project.other("porkbun");
  pb.checks.set(DOMAIN, buyable(DOMAIN, 11.08, 11.08));
  const nc = project.other("namecheap");
  nc.checks.set(DOMAIN, buyable(DOMAIN, 6.49, 15.98));
  const gd = project.other("godaddy");
  gd.checks.set(DOMAIN, buyable(DOMAIN, 0.99, 22.99));
  return { project, cf, pb, nc, gd };
}

describe("searchDomains --compare", () => {
  it("checks the name at every configured registrar and sorts by renewal, then first-year price", async () => {
    const { project, pb, nc, gd } = await fourRegistrars();
    pb.checks.set(DOMAIN, buyable(DOMAIN, 9.0, 10.44));
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "ShopApp.com", compare: true, services });

    expect(result.comparison).toHaveLength(1);
    const [entry] = result.comparison ?? [];
    expect(entry?.domain).toBe(DOMAIN);
    expect(entry?.offers.map((o) => [o.registrar, o.renewal?.amount, o.firstYear?.amount])).toEqual(
      [
        ["porkbun", 10.44, 9.0],
        ["cloudflare", 10.44, 10.44],
        ["namecheap", 15.98, 6.49],
        ["godaddy", 22.99, 0.99],
      ],
    );
    // each registrar checked the exact name once
    for (const fake of [pb, nc, gd]) expect(fake.count("check")).toBe(1);
    expect(project.cf.events).toContain(`check ${DOMAIN}`);
    // no ranking beyond price, no referral data: offers carry only the check and the registrar
    for (const offer of entry?.offers ?? []) {
      expect(Object.keys(offer).sort()).toEqual(
        ["domain", "firstYear", "registrable", "registrar", "renewal", "tier"].sort(),
      );
    }
    expect(result.account).toEqual({ id: "acc-1", name: "Shop" });
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("never compares prices across currencies: other currencies follow, sorted, with a note", async () => {
    const { project, nc, gd } = await fourRegistrars();
    const eur = (amount: number) => ({ amount, currency: "EUR" as const });
    // cheaper in number, but in euros: not compared with the dollar prices
    nc.checks.set(DOMAIN, { ...buyable(DOMAIN), firstYear: eur(3.5), renewal: eur(4.5) });
    gd.checks.set(DOMAIN, { ...buyable(DOMAIN), firstYear: eur(2.0), renewal: eur(9.0) });
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: DOMAIN, compare: true, services });

    const offers = result.comparison?.[0]?.offers ?? [];
    expect(offers.map((o) => [o.registrar, o.renewal?.currency, o.renewal?.amount])).toEqual([
      ["cloudflare", "USD", 10.44],
      ["porkbun", "USD", 11.08],
      ["namecheap", "EUR", 4.5],
      ["godaddy", "EUR", 9.0],
    ]);
    expect(offers[0]?.note).toBeUndefined();
    expect(offers[1]?.note).toBeUndefined();
    expect(offers[2]?.note).toBe("priced in EUR; not compared with USD prices");
    expect(offers[3]?.note).toBe("priced in EUR; not compared with USD prices");
  });

  it("gives a failing registrar's offer a plain reason without failing the comparison", async () => {
    const { project, gd, nc } = await fourRegistrars();
    gd.failures.check = () =>
      new OpsCrewError("CREDENTIALS_INVALID", "GoDaddy refused the token.", {
        hint: "Create a new token at https://developer.godaddy.com/keys.",
      });
    nc.checks.delete(DOMAIN);
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: DOMAIN, compare: true, services });

    const offers = result.comparison?.[0]?.offers ?? [];
    expect(offers.map((o) => [o.registrar, o.registrable])).toEqual([
      ["cloudflare", true],
      ["porkbun", true],
      ["namecheap", false],
      ["godaddy", false],
    ]);
    const reasons = Object.fromEntries(offers.map((o) => [o.registrar, o.reason]));
    expect(reasons.godaddy).toContain("GoDaddy could not check it: GoDaddy refused the token");
    expect(reasons.godaddy).toContain("developer.godaddy.com");
    expect(reasons.namecheap).toContain("Namecheap did not confirm it");
  });

  it("checks a keyword under a modest list of extensions at every registrar", async () => {
    const { project, pb, nc, gd } = await fourRegistrars();
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "shopapp", compare: true, services });

    const domains = result.comparison?.map((c) => c.domain) ?? [];
    expect(domains[0]).toBe("shopapp.com");
    expect(domains.length).toBeGreaterThan(3);
    expect(domains.length).toBeLessThanOrEqual(10);
    expect(domains.every((d) => d.startsWith("shopapp."))).toBe(true);
    for (const fake of [pb, nc, gd]) expect(fake.count("check")).toBe(1);
    // names a registrar did not answer for are listed with a reason, not dropped
    expect(result.comparison?.[1]?.offers.every((o) => !o.registrable)).toBe(true);
  });

  it("gives Cloudflare's offers a reason when the account is ambiguous, and still compares the rest", async () => {
    const { project } = await fourRegistrars();
    project.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: DOMAIN, compare: true, services });

    const offers = result.comparison?.[0]?.offers ?? [];
    const cloudflare = offers.find((o) => o.registrar === "cloudflare");
    expect(cloudflare?.registrable).toBe(false);
    expect(cloudflare?.reason).toContain("--account");
    expect(offers.filter((o) => o.registrable)).toHaveLength(3);
    expect(result.account).toBeUndefined();
  });

  it("stops plainly when no registrar is set up", async () => {
    const project = await domainProject();
    const { deps } = await project.run({ token: null });

    await expect(
      searchDomains(deps, { query: DOMAIN, compare: true, services: { registrars: {} } }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
  });
});

describe("searchDomains --registrar", () => {
  it("searches at that registrar without a Cloudflare account", async () => {
    const project = await domainProject();
    const pb = project.other("porkbun");
    pb.checks.set(DOMAIN, buyable(DOMAIN, 11.08, 12.5));
    pb.checks.set("shopapp.net", buyable("shopapp.net", 12.52, 13.0));
    pb.checks.set("shopapp.dev", {
      domain: "shopapp.dev",
      registrable: true,
      tier: "premium",
      firstYear: { amount: 900, currency: "USD" },
    });
    pb.checks.set("shopapp.io", {
      domain: "shopapp.io",
      registrable: false,
      reason: "This domain is already registered by someone else.",
    });
    const { deps, services } = await project.run({ token: null });

    const result = await searchDomains(deps, { query: DOMAIN, registrar: "porkbun", services });

    expect(project.cf.events).not.toContain("accounts");
    expect(result.registrar).toBe("porkbun");
    expect(result.account).toBeUndefined();
    expect(pb.count("check")).toBe(1);
    const buyableNames = result.results.filter((r) => r.registrable).map((r) => r.domain);
    expect(buyableNames).toEqual(["shopapp.com", "shopapp.net"]);
    const reasons = Object.fromEntries(result.results.map((r) => [r.domain, r.reason]));
    expect(reasons["shopapp.dev"]).toContain("premium");
    expect(reasons["shopapp.dev"]).toContain("Porkbun");
    expect(reasons["shopapp.io"]).toContain("already registered");
  });

  it("stops when that registrar is not set up", async () => {
    const project = await domainProject();
    project.other("porkbun");
    const { deps, services } = await project.run();

    await expect(
      searchDomains(deps, { query: DOMAIN, registrar: "godaddy", services }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });
  });
});
