import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { resolveCatalog } from "./run";

/** Contabo's four credentials, set. */
const CONTABO_ENV = {
  CNTB_OAUTH2_CLIENT_ID: "opscrew",
  CNTB_OAUTH2_CLIENT_SECRET: "client-word",
  CNTB_OAUTH2_USER: "me",
  CNTB_OAUTH2_PASS: "pass-word",
};

/** Contabo's login and its list of instances, which its credential check reads. */
async function contaboApi(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/protocol/openid-connect/token")) {
    return Response.json({ access_token: "access", expires_in: 300 });
  }
  if (url.includes("/v1/compute/instances")) return Response.json({ data: [] });
  return new Response("not found", { status: 404 });
}

describe("resolveCatalog", () => {
  it("says a provider without a price API prices from its dated list, credentials set or not", async () => {
    for (const env of [{}, CONTABO_ENV]) {
      const deps = await createTestPhaseDeps({ env, fetch: contaboApi });
      const resolved = await resolveCatalog(deps, "contabo", "EU");
      expect(resolved.isStatic).toBe(true);
      expect(resolved.warning).toMatch(
        /^Contabo has no price API, so prices come from Contabo's published price list dated \d{4}-\d{2}-\d{2} and are estimates/,
      );
      expect((await resolved.catalog.listOffers("EU")).map((offer) => offer.id)).toContain("V153");
    }
  });

  it("says wrong credentials of a provider without a price API, and prices from its list", async () => {
    const refused = async () => Response.json({ error: "invalid_grant" }, { status: 401 });
    const deps = await createTestPhaseDeps({ env: CONTABO_ENV, fetch: refused });
    const resolved = await resolveCatalog(deps, "contabo", "EU");
    expect(resolved.isStatic).toBe(true);
    expect(resolved.warning).toMatch(/^The Contabo token could not be used/);
  });
});
