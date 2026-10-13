import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { buyable, domainProject, TOKEN, visibleText } from "./__fixtures__/fakes";
import { searchDomains } from "./search";

describe("searchDomains", () => {
  it("checks suggestions live and lists what can be bought first, cheapest first", async () => {
    const project = await domainProject();
    const { cf } = project;
    cf.suggestions = [
      { domain: "shopapp.io", registrable: true },
      { domain: "shopapp.net", registrable: true },
      { domain: "shopapp.co.uk", registrable: true },
      { domain: "shopapp.ai", registrable: true },
      { domain: "shop-app.com", registrable: true },
      { domain: "shopapp.com", registrable: true },
    ];
    cf.checks.set("shopapp.com", buyable("shopapp.com", 10.44));
    cf.checks.set("shopapp.net", buyable("shopapp.net", 11.84, 12.14));
    cf.checks.set("shop-app.com", buyable("shop-app.com", 10.44));
    cf.checks.set("shopapp.io", {
      domain: "shopapp.io",
      registrable: false,
      tier: "premium",
      reason: "premium name, buy it in the Cloudflare dashboard",
    });
    cf.checks.set("shopapp.co.uk", buyable("shopapp.co.uk", 6.5));
    cf.checks.set("shopapp.ai", {
      domain: "shopapp.ai",
      registrable: false,
      reason: "this extension is sold only in the Cloudflare dashboard",
    });
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: " ShopApp.com ", services });

    // the exact name is checked first, every name only once, in one live check
    expect(cf.events).toEqual([
      "accounts",
      "suggest shopapp.com",
      "check shopapp.com,shopapp.io,shopapp.net,shopapp.co.uk,shopapp.ai,shop-app.com",
      // each extension of a buyable name is looked up once
      "extension com",
      "extension net",
      "extension uk",
    ]);
    expect(result.account).toEqual({ id: "acc-1", name: "Shop" });
    expect(result.results.map((r) => [r.domain, r.registrable])).toEqual([
      ["shop-app.com", true],
      ["shopapp.com", true],
      ["shopapp.net", true],
      ["shopapp.io", false],
      ["shopapp.co.uk", false],
      ["shopapp.ai", false],
    ]);
    const reasons = Object.fromEntries(result.results.map((r) => [r.domain, r.reason]));
    expect(reasons["shopapp.io"]).toContain("Cloudflare dashboard");
    expect(reasons["shopapp.co.uk"]).toContain("extra registrant details");
    expect(reasons["shopapp.ai"]).toContain("Cloudflare dashboard");
    expect(result.results[2]).toMatchObject({
      firstYear: { amount: 11.84 },
      renewal: { amount: 12.14 },
    });
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("marks names the live check did not confirm, premium names and internationalized names", async () => {
    const project = await domainProject();
    const { cf } = project;
    cf.suggestions = [
      { domain: "shopapp.dev", registrable: true },
      { domain: "shopapp.app", registrable: true },
      { domain: "xn--shpapp-wxa.com", registrable: true },
    ];
    cf.checks.set("shopapp.app", { ...buyable("shopapp.app", 900), tier: "premium" });
    cf.checks.set("xn--shpapp-wxa.com", buyable("xn--shpapp-wxa.com"));
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "shopapp", services });

    expect(result.results.every((r) => !r.registrable)).toBe(true);
    const reasons = Object.fromEntries(result.results.map((r) => [r.domain, r.reason]));
    expect(reasons["shopapp.dev"]).toContain("live check");
    expect(reasons["shopapp.app"]).toContain("premium");
    expect(reasons["xn--shpapp-wxa.com"]).toContain("internationalized");
  });

  it("uses Cloudflare's extension lookup for contact extensions, with a fallback list", async () => {
    const project = await domainProject();
    const { cf } = project;
    cf.contactTlds.add("eu");
    cf.failures.extension = (call) =>
      call === 2
        ? new OpsCrewError("PROVIDER_ERROR", "Could not reach the Cloudflare API.")
        : undefined;
    cf.suggestions = ["shopapp.eu", "shopapp.us", "shopapp.dev"].map((domain) => ({
      domain,
      registrable: true,
    }));
    for (const s of cf.suggestions) cf.checks.set(s.domain, buyable(s.domain));
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "shopapp", services });

    // .eu from the lookup, .us from the fallback list (its lookup failed), .dev buyable
    expect(result.results.map((r) => [r.domain, r.registrable])).toEqual([
      ["shopapp.dev", true],
      ["shopapp.eu", false],
      ["shopapp.us", false],
    ]);
  });

  it("returns nothing when there are no suggestions for a keyword", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "shopapp", services });

    expect(result.results).toEqual([]);
    expect(project.cf.count("check")).toBe(0);
  });

  it("checks at most 20 names", async () => {
    const project = await domainProject();
    project.cf.suggestions = Array.from({ length: 30 }, (_, i) => ({
      domain: `shopapp${i}.com`,
      registrable: true,
    }));
    const { deps, services } = await project.run();

    const result = await searchDomains(deps, { query: "shopapp", services });

    expect(result.results).toHaveLength(20);
  });

  it("needs a token, one account (or --account) and a plain query", async () => {
    const project = await domainProject();
    const noToken = await project.run({ token: null });
    await expect(
      searchDomains(noToken.deps, { query: "shopapp", services: noToken.services }),
    ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING" });

    const { deps, services } = await project.run();
    for (const query of ["", "bücher", "shop/app", "-shop"]) {
      await expect(searchDomains(deps, { query, services }), query).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }

    project.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const error = await searchDomains(deps, { query: "shopapp", services }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain("Shop (acc-1), Personal (acc-2)");

    const byName = await searchDomains(deps, { query: "shopapp", account: "personal", services });
    expect(byName.account.id).toBe("acc-2");

    project.cf.accounts = [];
    await expect(searchDomains(deps, { query: "shopapp", services })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
  });
});
