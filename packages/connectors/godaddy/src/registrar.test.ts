import type { RegistrationQuote, RegistrationRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { errorText, type FakeRoute, fakeFetch, gdError, usd } from "./__fixtures__/fake-fetch";
import { GODADDY_DASHBOARD_URLS, GoDaddyClient, GoDaddyRegistrar } from "./index";

const TOKEN = fakeSecret("godaddy-token");
const PROFILE = "44444444-4444-4444-8444-444444444444";
const QUOTE_TOKEN = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-13T10:00:00.000Z");
const KEY = "purchase-key-0123456789abcdef";

function setup(
  routes: Record<string, FakeRoute | FakeRoute[]>,
  options: ConstructorParameters<typeof GoDaddyRegistrar>[1] = {},
) {
  const fake = fakeFetch(routes);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const client = new GoDaddyClient({ token: TOKEN, fetch: fake.fetch, sleep });
  const registrar = new GoDaddyRegistrar(client, {
    now: () => NOW,
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
    pollIntervalMs: 1000,
    pollTimeoutMs: 3000,
    sleep,
    ...options,
  });
  return { ...fake, registrar, sleeps };
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    return error as OpsCrewError;
  }
  throw new Error("expected a rejection");
}

const domainBody = (overrides: Record<string, unknown> = {}) => ({
  domain: "example.com",
  status: "ACTIVE",
  expiresAt: "2027-10-13T10:02:10Z",
  createdAt: "2026-10-13T10:02:10Z",
  autoRenew: true,
  privacy: false,
  transferLock: true,
  nameServers: ["NS01.DOMAINCONTROL.COM.", "ns02.domaincontrol.com"],
  ...overrides,
});

const quoteBody = (overrides: Record<string, unknown> = {}) => ({
  domain: "example.com",
  available: true,
  quoteToken: QUOTE_TOKEN,
  expiresAt: "2026-10-13T10:10:00Z",
  price: usd(3098),
  renewalPrice: usd(4598),
  period: 2,
  inventory: "REGISTRY",
  requiredAgreements: [
    {
      agreementType: "API_DPA",
      title: "API Domain Purchase Agreement",
      url: "https://example.invalid/dpa",
    },
    { agreementType: "DNPA", title: "Domain Name Privacy Agreement" },
  ],
  resolved: { contactSource: "PROFILE", profileId: PROFILE, autoRenew: true, privacy: true },
  ...overrides,
});

const approvedQuote: RegistrationQuote = {
  price: { amount: 30.98, currency: "USD" },
  renewal: { amount: 22.99, currency: "USD" },
  token: QUOTE_TOKEN,
  agreements: [
    "API_DPA: API Domain Purchase Agreement (https://example.invalid/dpa)",
    "DNPA: Domain Name Privacy Agreement",
  ],
  expiresAt: "2026-10-13T10:10:00.000Z",
};

const request = (overrides: Partial<RegistrationRequest> = {}): RegistrationRequest => ({
  domain: "example.com",
  years: 2,
  autoRenew: true,
  privacy: true,
  quote: approvedQuote,
  idempotencyKey: KEY,
  ...overrides,
});

const accepted = {
  status: 202,
  body: {
    registrationId: "reg-1",
    operationId: "op-1",
    domain: "example.com",
    period: 2,
    status: "CONFIRMED",
  },
};
const operation = (status: string, extra: Record<string, unknown> = {}) => ({
  body: { operationId: "op-1", type: "REGISTER", domain: "example.com", status, ...extra },
});

describe("GoDaddyRegistrar basics", () => {
  it("declares what GoDaddy's v3 API supports", () => {
    const { registrar } = setup({});
    expect(registrar.id).toBe("godaddy");
    expect(registrar.capabilities).toEqual({
      purchase: true,
      chooseYears: true,
      nameservers: true,
      records: true,
      dnssec: false,
      autoRenew: false,
    });
  });

  it("exports dashboard links for hints", () => {
    expect(GODADDY_DASHBOARD_URLS.portfolio).toMatch(/^https:\/\/dcc\.godaddy\.com/);
    expect(GODADDY_DASHBOARD_URLS.apiAccess).toMatch(/^https:\/\/developer\.godaddy\.com/);
    expect(GODADDY_DASHBOARD_URLS.contactProfiles).toMatch(/^https:\/\//);
  });
});

describe("check and suggest", () => {
  it("maps prices in minor units, premium names and taken names", async () => {
    const { registrar } = setup({
      "POST /v3/domains/check-availability": {
        body: {
          items: [
            {
              domain: "example.com",
              available: true,
              inventory: "REGISTRY",
              prices: [
                { term: "YEAR", period: 2, price: usd(3098), renewalPrice: usd(4598) },
                { term: "YEAR", period: 1, price: usd(1199), renewalPrice: usd(2299) },
              ],
            },
            {
              domain: "premium.com",
              available: true,
              inventory: "PREMIUM",
              prices: [{ term: "YEAR", period: 1, price: usd(250000) }],
            },
            { domain: "taken.com", available: false },
            {
              domain: "example.us",
              error: { name: "UNSUPPORTED_TLD", correlationId: "x", message: "no" },
            },
          ],
        },
      },
    });
    const checks = await registrar.check(["Example.com", "premium.com", "taken.com", "example.us"]);
    expect(checks[0]).toEqual({
      domain: "example.com",
      registrable: true,
      tier: "standard",
      firstYear: { amount: 11.99, currency: "USD" },
      renewal: { amount: 22.99, currency: "USD" },
    });
    expect(checks[1]).toMatchObject({ domain: "premium.com", registrable: false, tier: "premium" });
    expect(checks[1]?.reason).toMatch(/premium/);
    expect(checks[1]?.reason).toContain("opscrew domain connect");
    expect(checks[2]).toMatchObject({ registrable: false });
    expect(checks[2]?.reason).toMatch(/already registered/);
    expect(checks[3]?.reason).toMatch(/extension/);
  });

  it("derives a yearly price when only longer terms are listed", async () => {
    const { registrar } = setup({
      "POST /v3/domains/check-availability": {
        body: {
          items: [
            {
              domain: "example.com",
              available: true,
              prices: [
                {
                  term: "YEAR",
                  period: 2,
                  price: usd(3098),
                  firstTermPrice: usd(799),
                  renewalPrice: usd(4598),
                },
              ],
            },
          ],
        },
      },
    });
    const [check] = await registrar.check(["example.com"]);
    expect(check?.firstYear).toEqual({ amount: 7.99, currency: "USD" });
    expect(check?.renewal).toEqual({ amount: 22.99, currency: "USD" });
  });

  it("refuses prices in currencies OpsCrew cannot show", async () => {
    const { registrar } = setup({
      "POST /v3/domains/check-availability": {
        body: {
          items: [
            {
              domain: "example.com",
              available: true,
              prices: [{ term: "YEAR", period: 1, price: { currencyCode: "GBP", value: 999 } }],
            },
          ],
        },
      },
    });
    const [check] = await registrar.check(["example.com"]);
    expect(check?.registrable).toBe(false);
    expect(check?.reason).toContain("GBP");
  });

  it("checks in batches of at most 25", async () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ domain: `n${i}.com`, available: false }));
    const { registrar, calls } = setup({
      "POST /v3/domains/check-availability": [
        { body: { items: items(25) } },
        { body: { items: items(5) } },
      ],
    });
    const names = Array.from({ length: 30 }, (_, i) => `n${i}.com`);
    const checks = await registrar.check(names);
    expect(checks).toHaveLength(30);
    expect(calls.map((c) => (c.body as { domains: string[] }).domains.length)).toEqual([25, 5]);
  });

  it("matches results by domain name only, never by position", async () => {
    const { registrar } = setup({
      "POST /v3/domains/check-availability": {
        body: {
          items: [
            {
              domain: "free.com",
              available: true,
              prices: [{ term: "YEAR", period: 1, price: usd(1199) }],
            },
          ],
        },
      },
    });
    const checks = await registrar.check(["taken.com", "free.com"]);
    expect(checks.map((c) => [c.domain, c.registrable])).toEqual([
      ["taken.com", false],
      ["free.com", true],
    ]);
    expect(checks[0]?.reason).toMatch(/did not return a result/);
  });

  it("suggests available names from GoDaddy's suggestion endpoint", async () => {
    const { registrar, calls } = setup({
      "GET /v3/domains/suggestions": {
        body: {
          items: [
            {
              domain: "sunrisebakery.shop",
              inventory: "REGISTRY",
              prices: [{ term: "YEAR", period: 1, price: usd(299), renewalPrice: usd(599) }],
            },
          ],
        },
      },
    });
    const suggestions = await registrar.suggest("sunrise bakery");
    expect(suggestions).toEqual([
      {
        domain: "sunrisebakery.shop",
        registrable: true,
        tier: "standard",
        firstYear: { amount: 2.99, currency: "USD" },
        renewal: { amount: 5.99, currency: "USD" },
      },
    ]);
    expect(calls[0]?.path).toBe("/v3/domains/suggestions?query=sunrise+bakery&pageSize=20");
  });
});

describe("quote", () => {
  it("returns the locked price, a per-year renewal, the token and the agreements", async () => {
    const { registrar, calls } = setup(
      { "POST /v3/domains/registration-quotes": { body: quoteBody() } },
      { profileId: PROFILE },
    );
    const quote = await registrar.quote("Example.com", 2);
    expect(quote).toEqual(approvedQuote);
    expect(calls[0]?.body).toEqual({ domain: "example.com", period: 2, profileId: PROFILE });
    expect(calls[0]?.body).not.toHaveProperty("profile");
  });

  it("omits the profile id when none is configured", async () => {
    const { registrar, calls } = setup({
      "POST /v3/domains/registration-quotes": { body: quoteBody() },
    });
    await registrar.quote("example.com", 2);
    expect(calls[0]?.body).toEqual({ domain: "example.com", period: 2 });
  });

  it("stops when the name cannot be registered", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registration-quotes": {
        body: { domain: "example.com", available: false },
      },
    });
    const error = await rejection(registrar.quote("example.com", 1));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/cannot register example\.com/);
  });

  it("stops for premium names and quotes with extra fees", async () => {
    for (const extra of [
      { inventory: "REGISTRY_PREMIUM" },
      { fees: [{ type: "ONE_TIME_PREMIUM_DOMAIN_PURCHASE", fee: usd(100000) }] },
    ]) {
      const { registrar } = setup({
        "POST /v3/domains/registration-quotes": { body: quoteBody(extra) },
      });
      const error = await rejection(registrar.quote("example.com", 2));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toMatch(/premium/);
      expect(error.hint).toContain("opscrew domain connect");
    }
  });

  it("refuses invalid years without calling GoDaddy", async () => {
    const { registrar, calls } = setup({});
    expect((await rejection(registrar.quote("example.com", 11))).code).toBe("INVALID_INPUT");
    expect((await rejection(registrar.quote("example.com", 1.5))).code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("describes the contact without contact data", async () => {
    const { registrar } = setup(
      {
        "POST /v3/domains/registration-quotes": {
          body: quoteBody({
            resolved: { contactSource: "PROFILE", registrantSummary: "Test Person, Berlin" },
          }),
        },
      },
      { profileId: PROFILE },
    );
    expect(await registrar.contactSummary()).toContain(PROFILE);
    await registrar.quote("example.com", 2);
    const summary = await registrar.contactSummary();
    expect(summary).toContain(PROFILE);
    expect(summary).not.toContain("Test Person");
  });
});

describe("register", () => {
  it("needs the approved quote's token", async () => {
    const { registrar, calls } = setup({});
    const { token: _token, ...noToken } = approvedQuote;
    for (const quote of [undefined, noToken]) {
      const error = await rejection(registrar.register(request({ quote })));
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an expired quote without calling GoDaddy", async () => {
    const { registrar, calls } = setup({});
    const error = await rejection(
      registrar.register(
        request({ quote: { ...approvedQuote, expiresAt: "2026-10-13T09:59:59Z" } }),
      ),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/expired/);
    expect(error.hint).toMatch(/new quote/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an idempotency key GoDaddy would not accept", async () => {
    const { registrar, calls } = setup({});
    const error = await rejection(registrar.register(request({ idempotencyKey: "short" })));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("buys with the quote, consent and key, then polls until completed", async () => {
    const { registrar, calls, sleeps } = setup(
      {
        "POST /v3/domains/registrations": accepted,
        "GET /v3/domains/operations/op-1": [operation("EXECUTING"), operation("COMPLETED")],
      },
      { profileId: PROFILE },
    );
    const status = await registrar.register(request());
    expect(status).toMatchObject({ domain: "example.com", state: "succeeded" });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.headers["Idempotency-Key"]).toBe(KEY);
    expect(post?.body).toEqual({
      domain: "example.com",
      period: 2,
      quoteToken: QUOTE_TOKEN,
      profileId: PROFILE,
      consent: { agreementTypes: ["API_DPA", "DNPA"], agreedAt: NOW.toISOString() },
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("uses a fresh UUID when the request carries no key", async () => {
    const { registrar, calls } = setup({
      "POST /v3/domains/registrations": {
        ...accepted,
        body: { ...accepted.body, status: "COMPLETED" },
      },
    });
    const { idempotencyKey: _key, ...rest } = request();
    const status = await registrar.register(rest);
    expect(status.state).toBe("succeeded");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("mentions the dashboard when auto-renew or privacy differ from the profile", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registration-quotes": {
        body: quoteBody({
          resolved: { contactSource: "PROFILE", autoRenew: false, privacy: true },
        }),
      },
      "POST /v3/domains/registrations": {
        ...accepted,
        body: { ...accepted.body, status: "COMPLETED" },
      },
    });
    const quote = await registrar.quote("example.com", 2);
    const status = await registrar.register(request({ quote }));
    expect(status.state).toBe("succeeded");
    expect(status.message).toMatch(/auto-renew/i);
    expect(status.message).toContain(GODADDY_DASHBOARD_URLS.portfolio);
  });

  it("reports a failed registration with GoDaddy's reason", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registrations": accepted,
      "GET /v3/domains/operations/op-1": operation("FAILED", {
        error: gdError("PAYMENT_DECLINED", { message: "card of Test Person declined" }),
      }),
    });
    const status = await registrar.register(request());
    expect(status.state).toBe("failed");
    expect(status.message).toContain("PAYMENT_DECLINED");
    expect(status.message).not.toContain("Test Person");
  });

  it("returns in_progress when the registration is still running at the timeout", async () => {
    const { registrar, sleeps } = setup({
      "POST /v3/domains/registrations": accepted,
      "GET /v3/domains/operations/op-1": operation("EXECUTING"),
    });
    const status = await registrar.register(request());
    expect(status.state).toBe("in_progress");
    expect(status.message).toMatch(/opscrew domain status/);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("returns in_progress when polling fails after GoDaddy accepted the purchase", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registrations": accepted,
      "GET /v3/domains/operations/op-1": { status: 500, body: gdError("INTERNAL") },
    });
    const status = await registrar.register(request());
    expect(status.state).toBe("in_progress");
  });

  it("polls the registration when no operation id is returned", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registrations": {
        status: 202,
        body: { registrationId: "reg-1", domain: "example.com", status: "CONFIRMED" },
      },
      "GET /v3/domains/registrations/reg-1": {
        body: { domain: "example.com", status: "COMPLETED" },
      },
    });
    expect((await registrar.register(request())).state).toBe("succeeded");
  });

  it("passes ambiguous answers on as 'may still have started' and never retries", async () => {
    const { registrar, calls } = setup({
      "POST /v3/domains/registrations": { status: 503, text: "" },
    });
    const error = await rejection(registrar.register(request()));
    expect(error.message).toMatch(/may still have started/);
    expect(calls).toHaveLength(1);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("tracks a pending registration it started", async () => {
    const { registrar } = setup({
      "POST /v3/domains/registrations": accepted,
      "GET /v3/domains/operations/op-1": [
        operation("EXECUTING"),
        operation("EXECUTING"),
        operation("EXECUTING"),
        operation("COMPLETED"),
      ],
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
    });
    expect((await registrar.register(request())).state).toBe("in_progress");
    expect(await registrar.registrationStatus("example.com")).toMatchObject({ state: "succeeded" });
  });
});

describe("registration status and domain details", () => {
  it("reports a domain in the account as registered", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { body: domainBody() },
    });
    expect(await registrar.registrationStatus("example.com")).toEqual({
      domain: "example.com",
      state: "succeeded",
    });
  });

  it("finds a pending registration among pending domains", async () => {
    const { registrar, calls } = setup({
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
      "GET /v3/domains/domain-names?": [
        {
          body: {
            items: [domainBody({ domain: "other.com", status: "PENDING_REGISTRATION" })],
            links: [{ rel: "next", href: "/v3/domains/domain-names?pageToken=p2" }],
          },
        },
        { body: { items: [domainBody({ status: "PENDING_REGISTRATION" })], links: [] } },
      ],
    });
    expect(await registrar.registrationStatus("example.com")).toMatchObject({
      state: "in_progress",
    });
    expect(calls[1]?.path).toContain("lifecycleGroups=PENDING");
    expect(calls[2]?.path).toContain("pageToken=p2");
  });

  it("returns undefined when there is no registration", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
      "GET /v3/domains/domain-names?": { body: { items: [], links: [] } },
    });
    expect(await registrar.registrationStatus("example.com")).toBeUndefined();
  });

  it("maps domain details", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { body: domainBody() },
    });
    expect(await registrar.getDomain("example.com")).toEqual({
      domain: "example.com",
      registrar: "godaddy",
      createdAt: "2026-10-13T10:02:10.000Z",
      expiresAt: "2027-10-13T10:02:10.000Z",
      autoRenew: true,
      locked: true,
      privacy: false,
    });
    expect(await registrar.ownsDomain("example.com")).toBe(true);
  });

  it("treats cancelled, deleted, transferred and repossessed domains as not held", async () => {
    for (const status of [
      "CANCELLED",
      "CANCELLED_REDEEMABLE",
      "DELETED_REDEEMABLE",
      "TRANSFERRED",
      "TRANSFERRED_OUT",
      "REPOSSESSED",
    ]) {
      const { registrar } = setup({
        "GET /v3/domains/domain-names/example.com": { body: domainBody({ status }) },
        "GET /v3/domains/domain-names?": { body: { items: [], links: [] } },
      });
      expect(await registrar.getDomain("example.com")).toBeUndefined();
      expect(await registrar.ownsDomain("example.com")).toBe(false);
      expect(await registrar.registrationStatus("example.com")).toBeUndefined();
    }
  });

  it("treats held statuses as registered", async () => {
    for (const status of ["ACTIVE", "LOCKED", "PARKED", "EXPIRED", "PENDING_TRANSFER"]) {
      const { registrar } = setup({
        "GET /v3/domains/domain-names/example.com": { body: domainBody({ status }) },
      });
      expect(await registrar.ownsDomain("example.com")).toBe(true);
      expect((await registrar.registrationStatus("example.com"))?.state).toBe("succeeded");
    }
  });

  it("reports a domain still being set up as in progress, not owned", async () => {
    const { registrar, calls } = setup({
      "GET /v3/domains/domain-names/example.com": {
        body: domainBody({ status: "PENDING_REGISTRATION" }),
      },
    });
    expect(await registrar.registrationStatus("example.com")).toMatchObject({
      state: "in_progress",
    });
    expect(await registrar.getDomain("example.com")).toBeUndefined();
    expect(await registrar.ownsDomain("example.com")).toBe(false);
    expect(calls.every((c) => !c.path.includes("lifecycleGroups"))).toBe(true);
  });

  it("never reports an unknown status as registered", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { body: domainBody({ status: "SUSPENDED" }) },
    });
    const status = await registrar.registrationStatus("example.com");
    expect(status?.state).toBe("in_progress");
    expect(status?.message).toContain("SUSPENDED");
    expect(await registrar.ownsDomain("example.com")).toBe(false);
  });

  it("refuses to guess when the pending list is longer than it searches", async () => {
    const { registrar, calls } = setup({
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
      "GET /v3/domains/domain-names?": {
        body: {
          items: [domainBody({ domain: "other.com", status: "PENDING_REGISTRATION" })],
          links: [{ rel: "next", href: "/v3/domains/domain-names?pageToken=more" }],
        },
      },
    });
    const error = await rejection(registrar.registrationStatus("example.com"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/could not confirm whether example\.com has a pending/);
    expect(calls).toHaveLength(11);
  });

  it("sends auto-renew changes to the dashboard", async () => {
    const { registrar, calls } = setup({});
    const error = await rejection(registrar.setAutoRenew("example.com", true));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain(GODADDY_DASHBOARD_URLS.portfolio);
    expect(calls).toHaveLength(0);
  });
});

describe("nameservers", () => {
  it("reads nameservers in lower case without trailing dots", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { body: domainBody() },
    });
    expect(await registrar.getNameservers("example.com")).toEqual([
      "ns01.domaincontrol.com",
      "ns02.domaincontrol.com",
    ]);
  });

  it("says plainly when the domain is not in the account", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
    });
    const error = await rejection(registrar.getNameservers("example.com"));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/not in this GoDaddy account/);
  });

  it("refuses fewer than 2 or more than 13 nameservers", async () => {
    const { registrar, calls } = setup({});
    const many = Array.from({ length: 14 }, (_, i) => `ns${i}.example.net`);
    for (const list of [["ns1.example.net"], many, ["ns1.example.net", "not a host"]]) {
      expect((await rejection(registrar.setNameservers("example.com", list))).code).toBe(
        "INVALID_INPUT",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("sets nameservers and waits for the operation", async () => {
    const { registrar, calls } = setup({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 202,
        body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "CONFIRMED" },
      },
      "GET /v3/domains/operations/ns-op": [
        { body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "EXECUTING" } },
        { body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "COMPLETED" } },
      ],
    });
    await registrar.setNameservers("example.com", [
      "Ada.NS.Cloudflare.com.",
      "bob.ns.cloudflare.com",
    ]);
    expect(calls[0]?.body).toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("55555555-5555-4555-8555-555555555555");
    expect(calls).toHaveLength(3);
  });

  it("fails when GoDaddy reports the nameserver change failed", async () => {
    const { registrar } = setup({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 202,
        body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "CONFIRMED" },
      },
      "GET /v3/domains/operations/ns-op": {
        body: {
          operationId: "ns-op",
          type: "UPDATE_NAMESERVERS",
          status: "FAILED",
          error: gdError("INVALID_NAMESERVER"),
        },
      },
    });
    const error = await rejection(
      registrar.setNameservers("example.com", ["a.example.net", "b.example.net"]),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("INVALID_NAMESERVER");
  });

  it("keeps waiting when a status read fails while polling", async () => {
    const { registrar, calls } = setup({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 202,
        body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "CONFIRMED" },
      },
      "GET /v3/domains/operations/ns-op": [
        { status: 500, body: gdError("INTERNAL") },
        { error: new Error(`socket closed ${TOKEN}`) },
        { body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "COMPLETED" } },
      ],
    });
    await registrar.setNameservers("example.com", ["a.example.net", "b.example.net"]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("returns after the bounded wait when GoDaddy is still applying the change", async () => {
    const { registrar, calls, sleeps } = setup({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 202,
        body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "CONFIRMED" },
      },
      "GET /v3/domains/operations/ns-op": {
        body: { operationId: "ns-op", type: "UPDATE_NAMESERVERS", status: "EXECUTING" },
      },
    });
    await expect(
      registrar.setNameservers("example.com", ["a.example.net", "b.example.net"]),
    ).resolves.toBeUndefined();
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });
});

describe("listRecords", () => {
  it("returns undefined when the domain does not use GoDaddy's nameservers", async () => {
    const { registrar, calls } = setup({
      "GET /v3/domains/domain-names/example.com": {
        body: domainBody({ nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] }),
      },
    });
    expect(await registrar.listRecords("example.com")).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("reads every page and names records in full", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names/example.com": { body: domainBody() },
      "GET /v3/domains/zones/example.com/dns-records?page=1": {
        body: {
          items: [
            { name: "@", type: "A", data: "192.0.2.1", ttl: 600 },
            { name: "WWW", type: "CNAME", data: "@", ttl: 3600 },
            { name: "@", type: "MX", data: "mail.example.com", ttl: 3600, priority: 10 },
            { name: "@", type: "TXT", data: "v=spf1 -all", ttl: 3600 },
          ],
          links: [
            {
              rel: "next",
              href: "https://api.godaddy.com/v3/domains/zones/example.com/dns-records?page=2",
            },
          ],
        },
      },
      "GET /v3/domains/zones/example.com/dns-records?page=2": {
        body: {
          items: [
            {
              name: "@",
              type: "SRV",
              data: "sip.example.com",
              ttl: 3600,
              priority: 5,
              weight: 10,
              port: 5060,
              service: "_sip",
              protocol: "_tcp",
            },
            { name: "@", type: "CAA", data: "letsencrypt.org", ttl: 3600, flag: 0, tag: "issue" },
            { name: "mail.example.com.", type: "A", data: "192.0.2.2", ttl: 600 },
          ],
          links: [],
        },
      },
    });
    expect(await registrar.listRecords("example.com")).toEqual([
      { type: "A", name: "example.com", content: "192.0.2.1", ttl: 600 },
      { type: "CNAME", name: "www.example.com", content: "example.com", ttl: 3600 },
      { type: "MX", name: "example.com", content: "mail.example.com", ttl: 3600, priority: 10 },
      { type: "TXT", name: "example.com", content: "v=spf1 -all", ttl: 3600 },
      {
        type: "SRV",
        name: "_sip._tcp.example.com",
        content: "10 5060 sip.example.com",
        ttl: 3600,
        priority: 5,
      },
      { type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"', ttl: 3600 },
      { type: "A", name: "mail.example.com", content: "192.0.2.2", ttl: 600 },
    ]);
  });
});

describe("accountCheck", () => {
  it("confirms the token and names the contact source", async () => {
    const { registrar } = setup(
      {
        "GET /v3/domains/domain-names?": { body: { items: [], links: [] } },
        "GET /v3/domains/check-availability": {
          body: { domain: "opscrew-access-check.com", available: true },
        },
      },
      { profileId: PROFILE },
    );
    const check = await registrar.accountCheck();
    expect(check.ok).toBe(true);
    expect(check.message).toContain(PROFILE);
  });

  it("explains an invalid token", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names?": { status: 401, body: gdError("UNAUTHORIZED") },
    });
    const check = await registrar.accountCheck();
    expect(check.ok).toBe(false);
    expect(check.fix).toContain("https://developer.godaddy.com");
    expect(JSON.stringify(check)).not.toContain(TOKEN);
  });

  it("explains GoDaddy's access rules when availability checks are refused", async () => {
    const { registrar } = setup({
      "GET /v3/domains/domain-names?": { body: { items: [], links: [] } },
      "GET /v3/domains/check-availability": { status: 403, body: gdError("ACCESS_DENIED") },
    });
    const check = await registrar.accountCheck();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/restricts/);
    expect(check.fix).toMatch(/opscrew domain connect/);
  });
});
