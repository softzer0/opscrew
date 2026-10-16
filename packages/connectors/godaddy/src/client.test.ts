import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { errorText, fakeFetch, gdError, noSleep, usd } from "./__fixtures__/fixtures";
import { GoDaddyClient } from "./client";

const TOKEN = fakeSecret("godaddy-token");
const KEY = "opscrew-key-0123456789abcdef";

function client(routes: Parameters<typeof fakeFetch>[0], sleeps: number[] = []) {
  const fake = fakeFetch(routes);
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { ...fake, client: new GoDaddyClient({ token: TOKEN, fetch: fake.fetch, sleep }) };
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

const registration = (status: string) => ({
  registrationId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  domain: "example.com",
  period: 1,
  price: usd(1199),
  status,
  consent: {
    agreementTypes: ["API_DPA"],
    agreedAt: "2026-10-13T10:00:00Z",
    agreedBy: { type: "DIRECT", principal: "shopper-1", ip: "192.0.2.10" },
  },
});

describe("GoDaddyClient requests", () => {
  it("checks a batch with a bearer token against the v3 API", async () => {
    const { client: gd, calls } = client({
      "POST /v3/domains/check-availability": {
        body: { items: [{ domain: "example.com", available: true, prices: [] }] },
      },
    });
    const items = await gd.checkAvailability(["example.com"]);
    expect(items[0]).toMatchObject({ domain: "example.com", available: true });
    expect(calls[0]?.url).toBe("https://api.godaddy.com/v3/domains/check-availability");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toEqual({ domains: ["example.com"] });
  });

  it("refuses more than 25 domains in one check", async () => {
    const { client: gd, calls } = client({});
    const names = Array.from({ length: 26 }, (_, i) => `n${i}.com`);
    const error = await rejection(gd.checkAvailability(names));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("uses a custom base URL", async () => {
    const fake = fakeFetch(
      { "GET /v3/domains/domain-names?": { body: { items: [], links: [] } } },
      "https://api.ote-godaddy.com",
    );
    const gd = new GoDaddyClient({
      token: TOKEN,
      fetch: fake.fetch,
      sleep: noSleep,
      baseUrl: "https://api.ote-godaddy.com/",
    });
    await gd.listDomains({ pageSize: 1 });
    expect(fake.calls[0]?.url).toBe(
      "https://api.ote-godaddy.com/v3/domains/domain-names?pageSize=1",
    );
  });

  it("explains an invalid token without showing it", async () => {
    const { client: gd } = client({
      "GET /v3/domains/domain-names": { status: 401, body: gdError("UNAUTHORIZED") },
    });
    const error = await rejection(gd.listDomains());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toMatch(/token/i);
    expect(error.hint).toContain("https://developer.godaddy.com");
    expect(error.hint).toContain("GODADDY_API_TOKEN");
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("explains GoDaddy's API access rules on 403", async () => {
    const { client: gd } = client({
      "POST /v3/domains/check-availability": { status: 403, body: gdError("ACCESS_DENIED") },
    });
    const error = await rejection(gd.checkAvailability(["example.com"]));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toMatch(/restricts/i);
    expect(error.hint).toMatch(/opscrew domain connect/);
  });

  it("waits for Retry-After and retries a rate-limited read once", async () => {
    const sleeps: number[] = [];
    const { client: gd, calls } = client(
      {
        "GET /v3/domains/domain-names/example.com": [
          { status: 429, body: gdError("TOO_MANY_REQUESTS"), headers: { "retry-after": "7" } },
          {
            body: {
              domain: "example.com",
              status: "ACTIVE",
              expiresAt: "2027-10-13T00:00:00Z",
              createdAt: "2026-10-13T00:00:00Z",
              autoRenew: true,
              privacy: false,
            },
          },
        ],
      },
      sleeps,
    );
    const domain = await gd.getDomain("example.com");
    expect(domain?.status).toBe("ACTIVE");
    expect(sleeps).toEqual([7000]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after one rate-limit retry", async () => {
    const sleeps: number[] = [];
    const { client: gd, calls } = client(
      { "GET /v3/domains/domain-names/example.com": { status: 429, body: gdError("TOO_MANY") } },
      sleeps,
    );
    const error = await rejection(gd.getDomain("example.com"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/too many requests/i);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("reports an unreachable API without leaking the token from the cause", async () => {
    const { client: gd } = client({
      "GET /v3/domains/domain-names": { error: new Error(`socket closed for Bearer ${TOKEN}`) },
    });
    const error = await rejection(gd.listDomains());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/could not reach/i);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("gives up on a request that never answers", async () => {
    const fake = fakeFetch({ "GET /v3/domains/domain-names": { hang: true } });
    const gd = new GoDaddyClient({ token: TOKEN, fetch: fake.fetch, sleep: noSleep, timeoutMs: 5 });
    const error = await rejection(gd.listDomains());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("The GoDaddy API did not answer within");
    expect(fake.calls).toHaveLength(1);
  });

  it("says a purchase that timed out may have started", async () => {
    const fake = fakeFetch({ "POST /v3/domains/registrations": { hang: true } });
    const gd = new GoDaddyClient({ token: TOKEN, fetch: fake.fetch, sleep: noSleep, timeoutMs: 5 });
    const error = await rejection(
      gd.registerDomain({
        domain: "example.com",
        period: 1,
        quoteToken: "q",
        agreementTypes: ["API_DPA"],
        agreedAt: "2026-10-13T10:00:00Z",
        idempotencyKey: KEY,
      }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("The purchase may still have started");
    expect(fake.calls).toHaveLength(1);
  });

  it("returns undefined for a domain the account does not hold", async () => {
    const { client: gd } = client({
      "GET /v3/domains/domain-names/example.com": { status: 404, body: gdError("NOT_FOUND") },
    });
    expect(await gd.getDomain("Example.COM.")).toBeUndefined();
  });

  it("rejects an unexpected answer", async () => {
    const { client: gd } = client({
      "GET /v3/domains/domain-names/example.com": { body: { domain: 42 } },
    });
    const error = await rejection(gd.getDomain("example.com"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/unexpected answer/i);
  });

  it("lists domains with paging and lifecycle filters", async () => {
    const { client: gd, calls } = client({
      "GET /v3/domains/domain-names": {
        body: {
          items: [],
          links: [
            {
              rel: "next",
              href: "/v3/domains/domain-names?lifecycleGroups=PENDING&pageSize=50&pageToken=abc%3D",
            },
          ],
        },
      },
    });
    const page = await gd.listDomains({ pageSize: 50, lifecycleGroups: ["PENDING"] });
    expect(page.nextPageToken).toBe("abc=");
    expect(calls[0]?.path).toBe("/v3/domains/domain-names?pageSize=50&lifecycleGroups=PENDING");
  });

  it("lists DNS records page by page", async () => {
    const { client: gd, calls } = client({
      "GET /v3/domains/zones/example.com/dns-records": {
        body: {
          items: [{ name: "@", type: "A", data: "192.0.2.1", ttl: 600 }],
          totalPages: 2,
          links: [{ rel: "next", href: "https://api.godaddy.com/v3/domains/zones/x?page=3" }],
        },
      },
    });
    const page = await gd.listDnsRecords("example.com", 2);
    expect(page?.items).toHaveLength(1);
    expect(page?.hasNext).toBe(true);
    expect(calls[0]?.path).toBe("/v3/domains/zones/example.com/dns-records?page=2&pageSize=100");
  });

  it("returns undefined records for a zone GoDaddy does not host", async () => {
    const { client: gd } = client({
      "GET /v3/domains/zones/example.com/dns-records": { status: 404, body: gdError("NOT_FOUND") },
    });
    expect(await gd.listDnsRecords("example.com", 1)).toBeUndefined();
  });
});

describe("GoDaddyClient quotes", () => {
  it("never keeps the registrant summary or contact data", async () => {
    const { client: gd, calls } = client({
      "POST /v3/domains/registration-quotes": {
        body: {
          domain: "example.com",
          available: true,
          quoteToken: "33333333-3333-4333-8333-333333333333",
          expiresAt: "2026-10-13T10:10:00Z",
          price: usd(1199),
          period: 1,
          requiredAgreements: [{ agreementType: "API_DPA", title: "Domain Purchase Agreement" }],
          resolved: {
            contactSource: "PROFILE",
            profileId: "44444444-4444-4444-8444-444444444444",
            registrantSummary: "Test Person, test.person@example.invalid",
            autoRenew: true,
            privacy: false,
          },
        },
      },
    });
    const quote = await gd.quoteRegistration({ domain: "example.com", period: 1 });
    expect(JSON.stringify(quote)).not.toContain("Test Person");
    expect(JSON.stringify(quote)).not.toContain("example.invalid");
    expect(quote.resolved?.contactSource).toBe("PROFILE");
    expect(calls[0]?.body).toEqual({ domain: "example.com", period: 1 });
  });

  it("stops plainly when contacts are missing, without echoing contact data", async () => {
    const { client: gd } = client({
      "POST /v3/domains/registration-quotes": {
        status: 422,
        body: gdError("MISSING_CONTACT", {
          message: "registrant email test.person@example.invalid is not verified",
          details: [
            {
              field: "/profile/contacts/registrant/email",
              value: "test.person@example.invalid",
              issue: "CONTACT_INCOMPLETE",
            },
          ],
        }),
      },
    });
    const error = await rejection(gd.quoteRegistration({ domain: "example.com", period: 1 }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/contact/i);
    expect(error.hint).toContain("GODADDY_PROFILE_ID");
    expect(errorText(error)).not.toContain("example.invalid");
    expect(errorText(error)).not.toContain("GODADDY_PROFILE_ID:");
  });

  it("explains an extension GoDaddy's API does not sell", async () => {
    const { client: gd } = client({
      "POST /v3/domains/registration-quotes": { status: 422, body: gdError("UNSUPPORTED_TLD") },
    });
    const error = await rejection(gd.quoteRegistration({ domain: "example.us", period: 1 }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/extension/i);
  });
});

describe("GoDaddyClient registrations", () => {
  const input = {
    domain: "example.com",
    period: 2,
    quoteToken: "33333333-3333-4333-8333-333333333333",
    agreementTypes: ["API_DPA"],
    agreedAt: "2026-10-13T10:00:00.000Z",
    idempotencyKey: KEY,
    profileId: "44444444-4444-4444-8444-444444444444",
  };

  it("sends the quote token, consent, profile id and idempotency key, never contacts", async () => {
    const { client: gd, calls } = client({
      "POST /v3/domains/registrations": { status: 202, body: registration("CONFIRMED") },
    });
    const result = await gd.registerDomain(input);
    expect(result.status).toBe("CONFIRMED");
    expect(result.operationId).toBe("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(result)).not.toContain("192.0.2.10");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe(KEY);
    expect(calls[0]?.body).toEqual({
      domain: "example.com",
      period: 2,
      quoteToken: input.quoteToken,
      profileId: input.profileId,
      consent: { agreementTypes: ["API_DPA"], agreedAt: input.agreedAt },
    });
    expect(calls[0]?.body).not.toHaveProperty("profile");
  });

  it.each([
    ["a server error", { status: 500, body: gdError("INTERNAL") }],
    ["a gateway timeout", { status: 504, text: "<html>timeout</html>" }],
    ["a rate limit", { status: 429, body: gdError("TOO_MANY_REQUESTS") }],
    ["an idempotency conflict", { status: 409, body: gdError("IDEMPOTENCY_CONFLICT") }],
    ["a consumed quote", { status: 409, body: gdError("quote_consumed") }],
    ["an unreadable 4xx", { status: 400, text: "bad" }],
    ["an unreadable 202", { status: 202, text: "{" }],
    ["a 202 without a status", { status: 202, body: { domain: "example.com" } }],
    ["a network error", { error: new Error(`reset ${TOKEN}`) }],
    ["an existing domain", { status: 409, body: gdError("domain_already_exists") }],
    [
      "a consumed and expired quote",
      {
        status: 409,
        body: gdError("quote_expired", { details: [{ issue: "quote_consumed" }] }),
      },
    ],
    [
      "a 422 naming an idempotency clash",
      { status: 422, body: gdError("INVALID", { details: [{ issue: "IDEMPOTENCY_KEY_REUSED" }] }) },
    ],
  ])("treats %s as ambiguous and never retries", async (_label, route) => {
    const { client: gd, calls } = client({ "POST /v3/domains/registrations": route });
    const error = await rejection(gd.registerDomain(input));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/may still have started/);
    expect(error.hint).toMatch(/opscrew domain status/);
    expect(calls).toHaveLength(1);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it.each([
    ["a business rule", 422, "quote_mismatch", /no longer matches the quote/],
    ["a malformed request", 400, "MISSING_FIELD", /MISSING_FIELD/],
    ["an expired quote", 409, "quote_expired", /quote expired/],
  ])("reports %s as a clear rejection where nothing was bought", async (_l, status, name, text) => {
    const { client: gd, calls } = client({
      "POST /v3/domains/registrations": { status, body: gdError(name) },
    });
    const error = await rejection(gd.registerDomain(input));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(text);
    expect(error.message).toMatch(/Nothing was bought/);
    expect(calls).toHaveLength(1);
  });

  it("reports a contact problem at purchase as a clear stop about the profile", async () => {
    const { client: gd, calls } = client({
      "POST /v3/domains/registrations": {
        status: 422,
        body: gdError("INELIGIBLE_CONTACT", {
          message: "Test Person at test.person@example.invalid is not eligible",
          details: [{ field: "/profileId", issue: "CONTACT_INVALID", value: "Test Person" }],
        }),
      },
    });
    const error = await rejection(gd.registerDomain(input));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/Nothing was bought/);
    expect(error.hint).toContain("GODADDY_PROFILE_ID");
    expect(errorText(error)).not.toContain("Test Person");
    expect(errorText(error)).not.toContain("example.invalid");
    expect(calls).toHaveLength(1);
  });

  it("reports 401 and 403 as clear rejections", async () => {
    for (const status of [401, 403]) {
      const { client: gd } = client({
        "POST /v3/domains/registrations": { status, body: gdError("DENIED") },
      });
      const error = await rejection(gd.registerDomain(input));
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.message).toMatch(/Nothing was bought/);
    }
  });

  it("reads a registration and an operation", async () => {
    const { client: gd } = client({
      "GET /v3/domains/registrations/1111": { body: registration("EXECUTING") },
      "GET /v3/domains/operations/2222": {
        body: {
          operationId: "2222",
          type: "REGISTER",
          status: "FAILED",
          error: gdError("REGISTRY_ERROR"),
        },
      },
    });
    expect((await gd.getRegistration("1111")).status).toBe("EXECUTING");
    const operation = await gd.getOperation("2222");
    expect(operation.status).toBe("FAILED");
    expect(operation.error?.name).toBe("REGISTRY_ERROR");
  });
});

describe("GoDaddyClient nameservers", () => {
  it("sends the nameservers as a list with an idempotency key, once", async () => {
    const { client: gd, calls } = client({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 202,
        body: { operationId: "op-1", type: "UPDATE_NAMESERVERS", status: "CONFIRMED" },
      },
    });
    const operation = await gd.updateNameservers(
      "example.com",
      ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      KEY,
    );
    expect(operation.operationId).toBe("op-1");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(calls[0]?.headers["Idempotency-Key"]).toBe(KEY);
  });

  it("says a failed connection may still have changed the nameservers", async () => {
    const { client: gd, calls } = client({
      "PUT /v3/domains/domain-names/example.com/nameservers": { status: 502, text: "" },
    });
    const error = await rejection(
      gd.updateNameservers("example.com", ["a.example.net", "b.example.net"], KEY),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/may still/);
    expect(calls).toHaveLength(1);
  });

  it("never retries a rate-limited nameserver change", async () => {
    const sleeps: number[] = [];
    const { client: gd, calls } = client(
      {
        "PUT /v3/domains/domain-names/example.com/nameservers": {
          status: 429,
          body: gdError("TOO_MANY_REQUESTS"),
          headers: { "retry-after": "1" },
        },
      },
      sleeps,
    );
    const error = await rejection(
      gd.updateNameservers("example.com", ["a.example.net", "b.example.net"], KEY),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/may still have been applied/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("reports a missing domain plainly", async () => {
    const { client: gd } = client({
      "PUT /v3/domains/domain-names/example.com/nameservers": {
        status: 404,
        body: gdError("NOT_FOUND"),
      },
    });
    const error = await rejection(
      gd.updateNameservers("example.com", ["a.example.net", "b.example.net"], KEY),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/not in this GoDaddy account/);
  });
});
