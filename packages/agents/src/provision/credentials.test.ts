import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID } from "@opscrew/connector-cloudflare/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, fakeCloudflare, portainerPlan, testPlan } from "../testing";
import { setupCloudflare } from "./credentials";

describe("setupCloudflare", () => {
  it("reads the zone's account for OpsCrew's shared rules, and says so when it cannot tell", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan({ domain: "shop.example.com" });
    const named = await setupCloudflare(deps, plan, { cloudflare: fakeCloudflare() });
    expect(named).toMatchObject({ zoneId: FAKE_ZONE_ID, accountId: FAKE_ACCOUNT_ID });

    const base = fakeCloudflare();
    const unnamed = {
      ...base,
      findZone: async () => ({
        id: FAKE_ZONE_ID,
        name: "example.com",
        status: "active",
        nameServers: [],
      }),
      listAccounts: async () => [
        { id: "a", name: "a" },
        { id: "b", name: "b" },
      ],
    };
    await expect(setupCloudflare(deps, plan, { cloudflare: unnamed })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      message:
        "Cloudflare did not say which account holds example.com, and the token sees several accounts, so OpsCrew cannot tell which account OpsCrew's shared Cloudflare rules belong to.",
    });
  });
});

describe("setupCloudflare for the user's Portainer", () => {
  const userRecord = (name: string) => ({
    id: `user-${name}`,
    type: "A",
    name,
    content: "198.51.100.20",
    ttl: 1,
    proxied: false,
  });

  async function setup(
    plan: DeployPlan,
    options: {
      records?: ReturnType<typeof userRecord>[];
      accounts?: string[];
      zoneAccount?: string;
    } = {},
  ) {
    const deps = await createTestPhaseDeps();
    const base = fakeCloudflare({ records: options.records ?? [] });
    const cloudflare = {
      ...base,
      findZone: async () => ({
        id: FAKE_ZONE_ID,
        name: "example.com",
        status: "active",
        nameServers: [],
        ...(options.zoneAccount !== undefined ? { accountId: options.zoneAccount } : {}),
      }),
      listAccounts: async () => (options.accounts ?? ["acc-1"]).map((id) => ({ id, name: id })),
    };
    const setupResult = setupCloudflare(deps, plan, { cloudflare });
    return { deps, cloudflare, result: setupResult };
  }

  it("needs no Cloudflare at all without a tunnel (proxy or Caddy with the updater)", async () => {
    for (const web of [{ mode: "proxy", port: 8080 }, { mode: "caddy" }] as const) {
      const { result, cloudflare } = await setup(portainerPlan({ web }));
      expect(await result).toBeUndefined();
      expect(cloudflare.listed).toEqual([]);
    }
  });

  it("tunnel mode: checks the app's hostnames and reads the account", async () => {
    const { result, cloudflare } = await setup(portainerPlan({ www: true }));
    expect(await result).toEqual({
      zoneId: FAKE_ZONE_ID,
      zoneName: "example.com",
      accountId: "acc-1",
    });
    expect(cloudflare.listed).toEqual(["shop.example.com", "www.shop.example.com"]);
  });

  it("tunnel mode: stops on a record at the app's hostname OpsCrew did not create", async () => {
    const { result } = await setup(portainerPlan(), { records: [userRecord("shop.example.com")] });
    await expect(result).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("A shop.example.com"),
    });
  });

  it("proxy or Caddy with the Cloudflare redeploy: the user's own record at the domain is expected", async () => {
    for (const web of [{ mode: "proxy", port: 8080 }, { mode: "caddy" }] as const) {
      const { result, cloudflare } = await setup(portainerPlan({ web, redeploy: "cloudflare" }), {
        records: [userRecord("shop.example.com")],
      });
      expect(await result).toMatchObject({ zoneId: FAKE_ZONE_ID, accountId: "acc-1" });
      // Only the webhook's hostname is OpsCrew's.
      expect(cloudflare.listed).toEqual(["portainer-shop.example.com"]);
    }
  });

  it("stops on a record at the webhook's hostname OpsCrew did not create", async () => {
    const { result } = await setup(portainerPlan({ redeploy: "cloudflare" }), {
      records: [userRecord("portainer-shop.example.com")],
    });
    await expect(result).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("portainer-shop.example.com"),
    });
  });

  it("uses the zone's account when Cloudflare names it, and names the tunnel permissions otherwise", async () => {
    const named = await setup(portainerPlan(), { zoneAccount: "acc-zone", accounts: [] });
    expect(await named.result).toMatchObject({ accountId: "acc-zone" });
    const unknown = await setup(portainerPlan(), { accounts: ["a", "b"] });
    const error = await unknown.result.then(
      () => undefined,
      (e: unknown) => e as { code: string; hint: string },
    );
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(error?.hint).toContain("Cloudflare Tunnel");
  });
});
