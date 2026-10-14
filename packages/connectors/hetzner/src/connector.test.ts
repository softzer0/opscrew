import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeFetch, fakeSleep, fixture } from "./__fixtures__/fake-fetch";
import { HetznerCatalog, StaticHetznerCatalog } from "./catalog";
import { hetznerConnector } from "./connector";

const token = fakeSecret("hcloud-token");
const ctx = { phase: "design" as const, projectRoot: "/tmp/project" };

function connector(routes: Parameters<typeof fakeFetch>[0], env = { HCLOUD_TOKEN: token }) {
  const fake = fakeFetch(routes);
  return {
    connector: hetznerConnector({ env, fetch: fake.fetch, sleep: fakeSleep().sleep }),
    calls: fake.calls,
  };
}

describe("hetznerConnector", () => {
  it("describes the least-privilege credential", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("hetzner");
    expect(c.credentials).toMatchObject({
      envVars: ["HCLOUD_TOKEN"],
      scopes: ["Read & Write"],
      createUrl: "https://console.hetzner.cloud/",
    });
  });

  it("verifies credentials by listing one location", async () => {
    const { connector: c, calls } = connector({
      "/locations": { body: fixture("locations.json") },
    });
    expect(await c.verifyCredentials()).toMatchObject({ ok: true });
    expect(calls[0]?.url.searchParams.get("per_page")).toBe("1");
  });

  it("reports an invalid token without leaking it", async () => {
    const { connector: c } = connector({
      "/locations": {
        status: 401,
        body: { error: { code: "unauthorized", message: `token ${token} is invalid` } },
      },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("Hetzner rejected the API token");
    expect(check.message).not.toContain(token);
    expect(check.message).toContain("[REDACTED");
  });

  it("reports a missing token and falls back to the static catalogue", async () => {
    const { connector: c, calls } = connector({}, {} as { HCLOUD_TOKEN: string });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("HCLOUD_TOKEN");
    expect(c.client).toBeUndefined();
    expect(c.catalog()).toBeInstanceOf(StaticHetznerCatalog);
    const tool = c.tools().find((t) => t.name === "hetzner_list_offers");
    const result = await tool?.handler({ location: "nbg1" }, ctx);
    expect(result?.isError).toBeUndefined();
    expect(result?.text).toContain("2026-10-14");
    expect(result?.text).toContain('"cx23"');
    expect(calls).toHaveLength(0);
  });

  it("exposes two read-only tools that return redacted text", async () => {
    const { connector: c } = connector({
      "/server_types?page=1": { body: fixture("server-types-page1.json") },
      "/server_types?page=2": { body: fixture("server-types-page2.json") },
      "/locations": {
        body: {
          locations: [
            {
              id: 9,
              name: "nbg1",
              description: `leaked ${token}`,
              country: "DE",
              network_zone: "eu-central",
            },
          ],
          meta: { pagination: { page: 1, per_page: 50, next_page: null } },
        },
      },
    });
    expect(c.catalog()).toBeInstanceOf(HetznerCatalog);
    const tools = c.tools();
    expect(tools.map((t) => t.name)).toEqual(["hetzner_list_locations", "hetzner_list_offers"]);
    expect(tools.every((t) => t.mutates === false)).toBe(true);

    const [listLocations, listOffers] = tools;
    const locations = await listLocations?.handler(listLocations.inputSchema.parse({}), ctx);
    expect(locations?.text).toContain("nbg1");
    expect(locations?.text).not.toContain(token);
    expect(locations?.text).toContain("[REDACTED");

    const offers = await listOffers?.handler(
      listOffers.inputSchema.parse({ location: "fsn1" }),
      ctx,
    );
    expect(offers?.text).toContain("Live data");
    expect(offers?.text).toContain('"cx23"');
    expect(offers?.text).not.toContain('"nbg1"');
  });

  it("returns redacted tool errors", async () => {
    const redactor = new Redactor();
    const fake = fakeFetch({
      "/locations": { status: 403, body: { error: { code: "forbidden", message: `no ${token}` } } },
    });
    const c = hetznerConnector({
      env: { HCLOUD_TOKEN: token },
      fetch: fake.fetch,
      sleep: fakeSleep().sleep,
      redactor,
    });
    const tool = c.tools()[0];
    const result = await tool?.handler({}, ctx);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("HTTP 403");
    expect(result?.text).not.toContain(token);
    // The shared redactor learned the token too.
    expect(redactor.redact(token)).not.toContain(token);
  });
});
