import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  FAKE_ACCOUNT_ID,
  FAKE_ZONE_ID,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
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

  it("reads the account for the off-server copies' bucket on R2 without a tunnel", async () => {
    const plan = DeployPlanSchema.parse({
      ...portainerPlan({ web: { mode: "proxy", port: 8080 } }),
      snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
    });
    const { result } = await setup(plan);
    expect(await result).toMatchObject({ zoneId: FAKE_ZONE_ID, accountId: "acc-1" });
    // At Hetzner the copies need no Cloudflare account.
    const hetzner = DeployPlanSchema.parse({
      ...plan,
      snapshots: { offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" } },
    });
    expect(await (await setup(hetzner)).result).toBeUndefined();
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

describe("setupCloudflare with two Cloudflare accounts", () => {
  const TOKEN_A = fakeSecret("cloudflare-token", "account-a");
  const TOKEN_B = fakeSecret("cloudflare-token", "account-b");
  const IP_RANGES = { ipv4: ["173.245.48.0/20"], ipv6: ["2400:cb00::/32"] };

  /** example.com active in Old and pending in New; one token per account. */
  function accounts() {
    const fake = fakeCloudflareAccounts({
      accounts: [
        { name: "Old", token: TOKEN_A },
        { name: "New", token: TOKEN_B },
      ],
      zones: [
        { name: "example.com", account: "Old" },
        { name: "example.com", account: "New", status: "pending" },
      ],
    });
    /** The calls setupCloudflare makes, through `token`'s client (the edge ranges need no token). */
    const api = (token: string) => {
      const client = new CloudflareClient({ token, fetch: fake.fetch, sleep: async () => {} });
      return {
        verifyToken: () => client.verifyToken(),
        findZone: (name: string, options?: { accountId?: string }) =>
          client.findZone(name, options),
        listDnsRecords: (zoneId: string, filter?: { name?: string }) =>
          client.listDnsRecords(zoneId, filter),
        listAccounts: () => client.listAccounts(),
        getIpRanges: async () => IP_RANGES,
      };
    };
    return { fake, api };
  }

  it("looks the zone up in the account it is given, with that account's token", async () => {
    const { fake, api } = accounts();
    const deps = await createTestPhaseDeps();
    const plan = testPlan({ domain: "shop.example.com" });
    const b = fake.account("New");
    const setup = await setupCloudflare(
      deps,
      plan,
      { cloudflare: api(TOKEN_B) },
      { accountId: b.id },
    );
    expect(setup).toMatchObject({
      zoneId: fake.zone("example.com", "New").id,
      zoneName: "example.com",
      accountId: b.id,
    });
    // Every zone read named B's account; nothing was written.
    const zoneCalls = fake.calls.filter((call) => call.path.startsWith("/zones"));
    expect(zoneCalls.length).toBeGreaterThan(0);
    for (const call of zoneCalls) {
      expect(call.path.includes(`account.id=${b.id}`) || call.accountId === b.id).toBe(true);
    }
    expect(fake.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(fake.calls.every((call) => call.status === 200)).toBe(true);
    const seen = JSON.stringify([setup, fake.calls, deps.reporter.text(), deps.audit.entries]);
    expect(seen).not.toContain(TOKEN_A);
    expect(seen).not.toContain(TOKEN_B);

    // Without the account, the old account's token finds its own zone, as before.
    const old = await setupCloudflare(deps, plan, { cloudflare: api(TOKEN_A) });
    expect(old).toMatchObject({
      zoneId: fake.zone("example.com", "Old").id,
      accountId: fake.account("Old").id,
    });
  });

  it("takes the account it is given when Cloudflare names none with the zone", async () => {
    const { fake, api } = accounts();
    const deps = await createTestPhaseDeps();
    const b = fake.account("New");
    const zone = fake.zone("example.com", "New");
    const unnamed = {
      ...api(TOKEN_B),
      findZone: async () => ({
        id: zone.id,
        name: zone.name,
        status: "pending",
        nameServers: zone.nameServers,
      }),
      listAccounts: async () => [
        { id: b.id, name: "New" },
        { id: fake.account("Old").id, name: "Old" },
      ],
    };
    const setup = await setupCloudflare(
      deps,
      testPlan({ domain: "shop.example.com" }),
      { cloudflare: unnamed },
      { accountId: b.id },
    );
    expect(setup).toMatchObject({ zoneId: zone.id, accountId: b.id });
  });

  it("refuses a zone that moved to another account before any change", async () => {
    const { fake, api } = accounts();
    fake.activate(fake.zone("example.com", "New"));
    const deps = await createTestPhaseDeps();
    const error = await setupCloudflare(deps, testPlan({ domain: "shop.example.com" }), {
      cloudflare: api(TOKEN_A),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "example.com moved to another Cloudflare account: set CLOUDFLARE_API_TOKEN to that account's token, then run the command again. Nothing was changed.",
    });
    // Only the token check and the zone lookups (the hostname, then its parent) were made.
    expect(fake.calls.map((call) => call.path.split("?")[0])).toEqual([
      "/user/tokens/verify",
      "/zones",
      "/zones",
    ]);
    expect(JSON.stringify([error, fake.calls, deps.reporter.text()])).not.toContain(TOKEN_A);

    // The new account's token finds the zone active there.
    const setup = await setupCloudflare(
      deps,
      testPlan({ domain: "shop.example.com" }),
      { cloudflare: api(TOKEN_B) },
      { accountId: fake.account("New").id },
    );
    expect(setup?.zoneId).toBe(fake.zone("example.com", "New").id);
  });
});
