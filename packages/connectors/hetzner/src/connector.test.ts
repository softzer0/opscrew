import { Redactor } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeSleep, fixture, hetznerFetch, param } from "./__fixtures__/fixtures";
import { HetznerCatalog, StaticHetznerCatalog } from "./catalog";
import { hetznerConnector } from "./connector";

const token = fakeSecret("hcloud-token");

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string> = { HCLOUD_TOKEN: token },
  redactor?: Redactor,
) {
  const fake = hetznerFetch(routes);
  return {
    connector: hetznerConnector({
      env,
      fetch: fake.fetch,
      sleep: fakeSleep().sleep,
      ...(redactor ? { redactor } : {}),
    }),
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
    expect(c.catalog()).toBeInstanceOf(HetznerCatalog);
    expect(await c.verifyCredentials()).toMatchObject({ ok: true });
    expect(param(calls[0], "per_page")).toBe("1");
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
    const { connector: c, calls } = connector({}, {});
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("HCLOUD_TOKEN");
    expect(c.client).toBeUndefined();
    expect(c.catalog()).toBeInstanceOf(StaticHetznerCatalog);
    const offers = await c.catalog().listOffers("nbg1");
    expect(offers.map((o) => o.id)).toContain("cx23");
    expect(calls).toHaveLength(0);
  });

  it("registers the token with a shared redactor", async () => {
    const redactor = new Redactor();
    const { connector: c } = connector(
      {
        "/locations": {
          status: 403,
          body: { error: { code: "forbidden", message: `no ${token}` } },
        },
      },
      { HCLOUD_TOKEN: token },
      redactor,
    );
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("HTTP 403");
    expect(check.message).not.toContain(token);
    expect(redactor.redact(token)).not.toContain(token);
  });
});
