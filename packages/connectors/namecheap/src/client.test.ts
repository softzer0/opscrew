import { inspect } from "node:util";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import {
  ADDRESS_ROUTES,
  API_KEY,
  CLIENT_IP,
  fakeNamecheap,
  fixture,
  makeClient,
  noSleep,
} from "./__fixtures__/fake-namecheap";
import {
  isClearRejection,
  NAMECHEAP_API,
  NAMECHEAP_SANDBOX_API,
  NamecheapClient,
  namecheapDate,
  splitDomain,
} from "./client";
import { normalizePhone } from "./contacts";
import { NAMECHEAP_DASHBOARD_URLS } from "./errors";

/** Everything a thrown value exposes: message, hint, JSON, inspect output (with its cause). */
function exposed(error: unknown): string {
  const e = error as Record<string, unknown>;
  return [
    String(error),
    String(e.message),
    String(e.hint),
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
  ].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

const errorXml = (command: string, number: string, text: string) =>
  `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response"><Errors><Error Number="${number}">${text}</Error></Errors><RequestedCommand>namecheap.${command}</RequestedCommand></ApiResponse>`;

describe("helpers", () => {
  it("splits a registrable domain into SLD (first label) and TLD (the rest)", () => {
    expect(splitDomain("Example.co.UK.")).toEqual({ sld: "example", tld: "co.uk" });
    expect(splitDomain("shopapp.com")).toEqual({ sld: "shopapp", tld: "com" });
    expect(() => splitDomain("localhost")).toThrow(/not a valid domain/);
    expect(() => splitDomain("bad_name.com")).toThrow(OpsCrewError);
  });

  it("turns Namecheap's MM/DD/YYYY dates into ISO", () => {
    expect(namecheapDate("10/13/2027")).toBe("2027-10-13T00:00:00.000Z");
    expect(namecheapDate("2027-10-13")).toBeUndefined();
    expect(namecheapDate(undefined)).toBeUndefined();
  });

  it("normalises address-book phone numbers to +CCC.NNNN", () => {
    expect(normalizePhone("1.5555550100")).toBe("+1.5555550100");
    expect(normalizePhone("+44.20 7946 0000")).toBe("+44.2079460000");
    expect(normalizePhone("0049.301234567")).toBe("+49.301234567");
    expect(normalizePhone("5555550100")).toBeUndefined();
  });

  it("treats only refusals before charging as clear purchase rejections", () => {
    expect(isClearRejection([{ number: "3019166", text: "Domain not available" }])).toBe(true);
    expect(isClearRejection([{ number: "2515610", text: "Prices do not match" }])).toBe(true);
    expect(isClearRejection([{ number: "1011150", text: "Invalid request IP" }])).toBe(true);
    expect(isClearRejection([{ number: "3031900", text: "Unknown response" }])).toBe(false);
    expect(isClearRejection([{ number: "5050900", text: "Unknown error" }])).toBe(false);
    expect(isClearRejection([{ text: "Something odd" }])).toBe(false);
    expect(isClearRejection([])).toBe(false);
    // Text never overrides a provider-side number.
    expect(isClearRejection([{ number: "3028166", text: "Insufficient funds" }])).toBe(false);
    expect(isClearRejection([{ number: "500000", text: "Too many requests" }])).toBe(false);
    expect(isClearRejection([{ text: "Too many requests" }])).toBe(true);
    expect(isClearRejection([{ number: "2011410", text: "Too many requests" }])).toBe(true);
    // 2528166 "order creation failed" is clear only for a balance reason.
    expect(isClearRejection([{ number: "2528166", text: "Order creation failed" }])).toBe(false);
    expect(
      isClearRejection([{ number: "2528166", text: "Order creation failed: insufficient funds" }]),
    ).toBe(true);
  });
});

describe("NamecheapClient requests", () => {
  it("POSTs a form with the global parameters to the production endpoint", async () => {
    const { fetch, calls } = fakeNamecheap({ "users.getBalances": fixture("users-getBalances") });
    const balance = await makeClient(fetch).getBalances();
    expect(balance).toEqual({ available: 64.2, currency: "USD", fundsRequiredForAutoRenew: 0 });
    const call = calls[0];
    expect(call?.url).toBe(NAMECHEAP_API);
    expect(call?.method).toBe("POST");
    expect(call?.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call?.params ?? [])).toEqual({
      ApiUser: "opscrew-sandbox",
      ApiKey: API_KEY,
      UserName: "opscrew-sandbox",
      ClientIp: CLIENT_IP,
      Command: "namecheap.users.getBalances",
    });
    expect(call?.url).not.toContain(API_KEY);
  });

  it("uses the sandbox endpoint and a separate user name when asked", async () => {
    const { fetch, calls } = fakeNamecheap({ "users.getBalances": fixture("users-getBalances") });
    const client = makeClient(fetch, { sandbox: true, userName: "other-user" });
    await client.getBalances();
    expect(calls[0]?.url).toBe(NAMECHEAP_SANDBOX_API);
    expect(calls[0]?.params.get("UserName")).toBe("other-user");
    expect(client.dashboard.apiAccess).toContain("sandbox.namecheap.com");
  });

  it("reads its own public IPv4 from Cloudflare's trace page by default, once per client", async () => {
    const { fetch, calls } = fakeNamecheap({ "users.getBalances": fixture("users-getBalances") });
    const traced: (RequestInit | undefined)[] = [];
    const client = new NamecheapClient({
      apiUser: "opscrew-sandbox",
      apiKey: API_KEY,
      fetch: async (input, init) => {
        if (String(input) !== TRACE_URL) return fetch(input, init);
        traced.push(init);
        return new Response("fl=1\nh=www.cloudflare.com\nip=198.51.100.23\nts=1\n");
      },
      sleep: noSleep,
    });
    await client.getBalances();
    await client.getBalances();
    expect(traced).toHaveLength(1);
    expect(traced[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls.map((c) => c.params.get("ClientIp"))).toEqual(["198.51.100.23", "198.51.100.23"]);
  });

  it("says to set NAMECHEAP_CLIENT_IP when the trace page gives no IPv4 address", async () => {
    for (const trace of [
      () => new Response("ip=2001:db8::1\n"),
      () => new Response("nothing here"),
      () => new Response("ip=198.51.100.7\n", { status: 500 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const { fetch, calls } = fakeNamecheap({});
      const client = new NamecheapClient({
        apiUser: "u",
        apiKey: API_KEY,
        fetch: async (input, init) => (String(input) === TRACE_URL ? trace() : fetch(input, init)),
      });
      const error = await failure(client.getBalances());
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toMatch(/IPv4/);
      expect(error.hint).toContain("Set NAMECHEAP_CLIENT_IP to");
      expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.apiAccess);
      expect(`${error.message} ${error.hint}`).not.toMatch(/NAMECHEAP_CLIENT_IP:/);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a malformed ClientIp with a plain fix", async () => {
    const { fetch } = fakeNamecheap({});
    const bad = makeClient(fetch, { clientIp: "300.1.1.1" });
    const error = await failure(bad.getBalances());
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("Set NAMECHEAP_CLIENT_IP to");
  });

  it("needs the API user and key", async () => {
    const { fetch } = fakeNamecheap({});
    const error = await failure(makeClient(fetch, { apiKey: "" }).getBalances());
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.hint).toContain("NAMECHEAP_API_KEY");
  });

  it("retries read-only calls on network errors and 5xx answers", async () => {
    const { fetch, of } = fakeNamecheap({
      "users.getBalances": [
        new TypeError("fetch failed"),
        { status: 503, body: "<html>busy</html>" },
        fixture("users-getBalances"),
      ],
    });
    const sleep = vi.fn(noSleep);
    expect((await makeClient(fetch, { sleep }).getBalances()).available).toBe(64.2);
    expect(of("users.getBalances")).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives every request a timeout and retries a read that never answers", async () => {
    const { fetch, of } = fakeNamecheap({
      "users.getBalances": [{ hang: true }, fixture("users-getBalances")],
    });
    const sleep = vi.fn(noSleep);
    const client = makeClient(fetch, { sleep, timeoutMs: 5 });
    expect((await client.getBalances()).available).toBe(64.2);
    expect(of("users.getBalances")).toHaveLength(2);

    const hanging = fakeNamecheap({ "users.getBalances": { hang: true } });
    const error = await failure(makeClient(hanging.fetch, { timeoutMs: 5 }).getBalances());
    expect(error.message).toMatch(/Could not reach the Namecheap API .*\(the request timed out\)/);
    expect(hanging.of("users.getBalances")).toHaveLength(3);
  });

  it("gives up on an unreachable API with a plain message", async () => {
    const { fetch, of } = fakeNamecheap({ "users.getBalances": new TypeError("fetch failed") });
    const error = await failure(makeClient(fetch).getBalances());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/Could not reach the Namecheap API/);
    expect(of("users.getBalances")).toHaveLength(3);
  });

  it("rejects unreadable XML and unexpected answers", async () => {
    const { fetch } = fakeNamecheap({ "users.getBalances": "<ApiResponse><broken></ApiResponse>" });
    expect((await failure(makeClient(fetch).getBalances())).message).toMatch(/unreadable answer/);
    const odd = fakeNamecheap({
      "users.getBalances": fixture("users-getBalances").replace('AvailableBalance="64.20"', ""),
    });
    expect((await failure(makeClient(odd.fetch).getBalances())).message).toMatch(
      /unexpected answer/,
    );
  });
});

describe("NamecheapClient errors", () => {
  it("names the IPv4 to whitelist when the IP is not allowed", async () => {
    const { fetch } = fakeNamecheap({ "users.getBalances": fixture("error-ip-not-whitelisted") });
    const error = await failure(makeClient(fetch).getBalances());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain(CLIENT_IP);
    expect(error.hint).toContain(
      `Add ${CLIENT_IP} to the API whitelist at ${NAMECHEAP_DASHBOARD_URLS.apiAccess}`,
    );
  });

  it("explains API access and Namecheap's eligibility rule", async () => {
    const { fetch } = fakeNamecheap({ "users.getBalances": fixture("error-api-key") });
    const error = await failure(makeClient(fetch).getBalances());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toMatch(/API access is not enabled/);
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.apiAccess);
    expect(error.hint).toMatch(/20 domains.*\$50.*\$50 spent in the last 2 years/);
  });

  it("explains the rate limit", async () => {
    const { fetch } = fakeNamecheap({ "domains.check": fixture("error-rate-limit") });
    const error = await failure(makeClient(fetch).checkDomains(["shopapp.com"]));
    expect(error.message).toMatch(/50 calls a minute, 700 an hour, 8000 a day/);
  });

  it("never shows the API key, even when Namecheap echoes it", async () => {
    const echo = errorXml("users.getBalances", "1011102", `API Key ${API_KEY} is invalid`);
    const other = errorXml("users.getBalances", "4022312", `Balance unavailable for ${API_KEY}`);
    for (const route of [echo, other, new TypeError("fetch failed"), "not xml"]) {
      const { fetch } = fakeNamecheap({ "users.getBalances": route });
      const error = await failure(makeClient(fetch).getBalances());
      expect(exposed(error)).not.toContain(API_KEY);
    }
    const client = makeClient(fakeNamecheap({}).fetch);
    expect(JSON.stringify(client)).not.toContain(API_KEY);
    expect(inspect(client, { depth: 5, showHidden: true })).not.toContain(API_KEY);
  });
});

describe("NamecheapClient commands", () => {
  it("checks domains in batches of 50", async () => {
    const { fetch, of } = fakeNamecheap({ "domains.check": fixture("domains-check") });
    const client = makeClient(fetch);
    const results = await client.checkDomains(["shopapp.com", "Taken.com.", "us.xyz"]);
    expect(results).toEqual([
      { domain: "shopapp.com", available: true, premium: false },
      { domain: "taken.com", available: false, premium: false },
      { domain: "us.xyz", available: true, premium: true },
    ]);
    expect(of("domains.check")[0]?.params.get("DomainList")).toBe("shopapp.com,taken.com,us.xyz");
    await client.checkDomains(Array.from({ length: 120 }, (_, i) => `name${i}.com`));
    const sizes = of("domains.check")
      .slice(1)
      .map((c) => c.params.get("DomainList")?.split(",").length);
    expect(sizes).toEqual([50, 50, 20]);
  });

  it("reads per-year prices with the additional cost", async () => {
    const { fetch, calls } = fakeNamecheap({
      "users.getPricing": fixture("users-getPricing-register-com"),
    });
    const prices = await makeClient(fetch).getPricing("REGISTER", "com");
    expect(prices).toEqual([
      {
        years: 1,
        price: 10.28,
        perYear: true,
        additionalCost: 0.2,
        additionalCostPerYear: true,
        currency: "USD",
      },
      {
        years: 2,
        price: 12.13,
        perYear: true,
        additionalCost: 0.2,
        additionalCostPerYear: true,
        currency: "USD",
      },
    ]);
    expect(Object.fromEntries(calls[0]?.params ?? [])).toMatchObject({
      ProductType: "DOMAIN",
      ProductCategory: "DOMAINS",
      ActionName: "REGISTER",
      ProductName: "COM",
    });
    const renew = await makeClient(fetch).getPricing("RENEW", "com");
    expect(renew).toEqual([]);
  });

  it("summarises the default address masked", async () => {
    const { fetch, of } = fakeNamecheap(ADDRESS_ROUTES);
    expect(await makeClient(fetch).contactSummary()).toBe("T*** P***, US");
    expect(of("users.address.getInfo").map((c) => c.params.get("AddressId"))).toEqual([
      "101",
      "102",
    ]);
  });

  it("stops plainly without a default address", async () => {
    const { fetch } = fakeNamecheap({
      "users.address.getList": fixture("users-address-getList"),
      "users.address.getInfo:101": fixture("users-address-getInfo-101"),
      "users.address.getInfo:102": fixture("users-address-getInfo-101"),
    });
    const error = await failure(makeClient(fetch).contactSummary());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/no default address/);
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.addressBook);
    const empty = fakeNamecheap({
      "users.address.getList": fixture("users-address-getList").replace(
        /<AddressGetListResult>[\s\S]*<\/AddressGetListResult>/,
        "<AddressGetListResult />",
      ),
    });
    expect((await failure(makeClient(empty.fetch).contactSummary())).message).toMatch(
      /no default address/,
    );
  });

  it("names missing address fields without their values", async () => {
    const incomplete = fixture("users-address-getInfo-102")
      .replace("<City>Testville</City>", "<City></City>")
      .replace("<Phone>1.5555550100</Phone>", "");
    const { fetch } = fakeNamecheap({ ...ADDRESS_ROUTES, "users.address.getInfo:102": incomplete });
    const error = await failure(makeClient(fetch).contactSummary());
    expect(error.message).toContain("missing: city, phone");
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.addressBook);
    expect(exposed(error)).not.toMatch(/Person|1 Test Street|test@example\.invalid/);
  });

  it("lists the account's domains with ISO dates, across pages", async () => {
    const { fetch } = fakeNamecheap({ "domains.getList": fixture("domains-getList") });
    const domains = await makeClient(fetch).listDomains("shopapp");
    expect(domains[0]).toEqual({
      domain: "shopapp.com",
      createdAt: "2026-10-13T00:00:00.000Z",
      expiresAt: "2027-10-13T00:00:00.000Z",
      expired: false,
      locked: false,
      autoRenew: false,
      privacy: true,
      usesNamecheapDns: true,
    });
    expect(domains[1]).toMatchObject({ domain: "shopapp.net", locked: true, privacy: false });

    const row = (i: number) =>
      `<Domain ID="${i}" Name="d${i}.com" User="u" Created="01/02/2026" Expires="01/02/2027" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" IsPremium="false" IsOurDNS="true" />`;
    const page = (from: number, count: number) =>
      fixture("domains-getList-empty").replace(
        "<DomainGetListResult />",
        `<DomainGetListResult>${Array.from({ length: count }, (_, i) => row(from + i)).join("")}</DomainGetListResult>`,
      );
    const paged = fakeNamecheap({
      "domains.getList": [
        page(0, 100).replace("<TotalItems>0</TotalItems>", "<TotalItems>130</TotalItems>"),
        page(100, 30).replace("<TotalItems>0</TotalItems>", "<TotalItems>130</TotalItems>"),
      ],
    });
    const all = await makeClient(paged.fetch).listDomains();
    expect(all).toHaveLength(130);
    expect(paged.of("domains.getList").map((c) => c.params.get("Page"))).toEqual(["1", "2"]);
    const empty = fakeNamecheap({ "domains.getList": fixture("domains-getList-empty") });
    expect(await makeClient(empty.fetch).listDomains("nothing.com")).toEqual([]);
  });

  it("reads and sets nameservers with SLD and TLD", async () => {
    const { fetch, of } = fakeNamecheap({
      "domains.dns.getList": fixture("domains-dns-getList"),
      "domains.dns.setCustom": fixture("domains-dns-setCustom"),
    });
    const client = makeClient(fetch);
    expect(await client.getDnsList("shopapp.co.uk")).toEqual({
      usesNamecheapDns: true,
      nameservers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
    });
    expect(of("domains.dns.getList")[0]?.params.get("SLD")).toBe("shopapp");
    expect(of("domains.dns.getList")[0]?.params.get("TLD")).toBe("co.uk");
    await client.setCustomNameservers("shopapp.com", [
      "Ada.NS.cloudflare.com.",
      "bob.ns.cloudflare.com",
    ]);
    expect(Object.fromEntries(of("domains.dns.setCustom")[0]?.params ?? [])).toMatchObject({
      SLD: "shopapp",
      TLD: "com",
      Nameservers: "ada.ns.cloudflare.com,bob.ns.cloudflare.com",
    });
    await expect(client.setCustomNameservers("shopapp.com", ["one.example"])).rejects.toThrow(
      /at least two/,
    );
    const notUpdated = fakeNamecheap({
      "domains.dns.setCustom": fixture("domains-dns-setCustom").replace(
        'Updated="true"',
        'Updated="false"',
      ),
    });
    await expect(
      makeClient(notUpdated.fetch).setCustomNameservers("shopapp.com", ["a.ns.x", "b.ns.x"]),
    ).rejects.toThrow(/did not set the nameservers/);
  });

  it("sends a nameserver change once after a 5xx, a lost connection or a timeout", async () => {
    for (const route of [
      { status: 502, body: "<html>bad gateway</html>" },
      new TypeError("fetch failed"),
      { hang: true as const },
    ]) {
      const { fetch, of } = fakeNamecheap({ "domains.dns.setCustom": route });
      const sleep = vi.fn(noSleep);
      const error = await failure(
        makeClient(fetch, { sleep, timeoutMs: 5 }).setCustomNameservers("shopapp.com", [
          "a.ns.cloudflare.com",
          "b.ns.cloudflare.com",
        ]),
      );
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.hint).toContain("may still have reached Namecheap");
      expect(of("domains.dns.setCustom")).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("sends a rate-limited nameserver change again (Namecheap did not take it)", async () => {
    const { fetch, of } = fakeNamecheap({
      "domains.dns.setCustom": [
        { status: 429, body: "<html>slow down</html>" },
        fixture("domains-dns-setCustom"),
      ],
    });
    await makeClient(fetch).setCustomNameservers("shopapp.com", ["a.ns.x", "b.ns.x"]);
    expect(of("domains.dns.setCustom")).toHaveLength(2);
  });

  it("reads host records, and nothing when Namecheap does not host the DNS", async () => {
    const { fetch } = fakeNamecheap({ "domains.dns.getHosts": fixture("domains-dns-getHosts") });
    const list = await makeClient(fetch).getHosts("shopapp.com");
    expect(list?.emailType).toBe("MX");
    expect(list?.hosts).toHaveLength(6);
    expect(list?.hosts[2]).toEqual({
      name: "@",
      type: "MX",
      address: "mx1.example.net.",
      mxPref: 10,
      ttl: 1800,
    });
    const notOurs = fakeNamecheap({
      "domains.dns.getHosts": fixture("domains-dns-getHosts-error-notourdns"),
    });
    expect(await makeClient(notOurs.fetch).getHosts("shopapp.com")).toBeUndefined();
    const flagged = fakeNamecheap({
      "domains.dns.getHosts": fixture("domains-dns-getHosts").replace(
        'IsUsingOurDNS="true"',
        'IsUsingOurDNS="false"',
      ),
    });
    expect(await makeClient(flagged.fetch).getHosts("shopapp.com")).toBeUndefined();
  });
});

describe("NamecheapClient.createDomain", () => {
  const routes = (create: Parameters<typeof fakeNamecheap>[0][string]) =>
    fakeNamecheap({ ...ADDRESS_ROUTES, "domains.create": create });

  it("sends the default address as all four contacts, privacy, and no nameservers", async () => {
    const { fetch, of } = routes(fixture("domains-create"));
    const result = await makeClient(fetch).createDomain({
      domain: "ShopApp.com",
      years: 2,
      privacy: true,
    });
    expect(result).toEqual({
      domain: "shopapp.com",
      registered: true,
      nonRealTime: false,
      chargedAmount: 10.48,
      orderId: "22158",
      privacy: true,
    });
    const params = Object.fromEntries(of("domains.create")[0]?.params ?? []);
    expect(params).toMatchObject({ DomainName: "shopapp.com", Years: "2" });
    for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
      expect(params).toMatchObject({
        [`${role}FirstName`]: "Test",
        [`${role}LastName`]: "Person",
        [`${role}Address1`]: "1 Test Street",
        [`${role}Address2`]: "Suite Fake",
        [`${role}City`]: "Testville",
        [`${role}StateProvince`]: "Teststate",
        [`${role}PostalCode`]: "00001-0000",
        [`${role}Country`]: "US",
        [`${role}Phone`]: "+1.5555550100",
        [`${role}EmailAddress`]: "test@example.invalid",
        [`${role}OrganizationName`]: "Fake Org Invalid",
      });
      expect(params[`${role}Fax`]).toBeUndefined();
    }
    expect(params.AddFreeWhoisguard).toBe("yes");
    expect(params.WGEnabled).toBe("yes");
    expect(params.Nameservers).toBeUndefined();
    expect(Object.keys(params).some((k) => k.endsWith("Zip"))).toBe(false);
  });

  it("turns privacy off when asked and reports non-real-time registrations", async () => {
    const { fetch, of } = routes(fixture("domains-create-nonrealtime"));
    const result = await makeClient(fetch).createDomain({
      domain: "shopapp.com",
      years: 1,
      privacy: false,
    });
    expect(result).toMatchObject({ registered: false, nonRealTime: true });
    expect(of("domains.create")[0]?.params.get("AddFreeWhoisguard")).toBe("no");
  });

  it.each([
    ["a network error", new TypeError("fetch failed"), /the connection failed/],
    ["a 502", { status: 502, body: "<html>Bad gateway</html>" }, /HTTP 502/],
    ["a 429 without XML", { status: 429, body: "" }, /HTTP 429/],
    ["unreadable XML", "<ApiResponse Status=", /readable answer/],
    ["an unexpected answer", fixture("domains-create").replace("Registered=", "X="), /unexpected/],
    ["a provider error", fixture("domains-create-error-provider"), /Namecheap error 3031900\)/],
    [
      "a provider number with balance text",
      errorXml("domains.create", "3028166", "Insufficient funds"),
      /Namecheap error 3028166\)/,
    ],
    [
      "2528166 without a balance reason",
      errorXml("domains.create", "2528166", "Order creation failed"),
      /Namecheap error 2528166\)/,
    ],
    [
      "a rate limit with a provider-side number",
      fixture("error-rate-limit").replaceAll("domains.check", "domains.create"),
      /Namecheap error 500000\)/,
    ],
  ] as const)("is never retried and may still have started after %s", async (_, route, why) => {
    const { fetch, of } = routes(route);
    const sleep = vi.fn(noSleep);
    const error = await failure(
      makeClient(fetch, { sleep }).createDomain({ domain: "shopapp.com", years: 1, privacy: true }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/may still have started/);
    expect(error.message).toMatch(why);
    // Namecheap's free text is left out (it could echo parts of the contact).
    expect(error.message).not.toMatch(/Unknown response|Insufficient|Order creation|Too many/);
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.domainList);
    expect(of("domains.create")).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("says a purchase that timed out may have started and never sends it again", async () => {
    const { fetch, of } = routes({ hang: true });
    const sleep = vi.fn(noSleep);
    const error = await failure(
      makeClient(fetch, { sleep, timeoutMs: 5 }).createDomain({
        domain: "shopapp.com",
        years: 1,
        privacy: true,
      }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Namecheap gave no clear answer while registering shopapp.com (the request timed out). The purchase may still have started; check its status before trying again.",
    );
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.domainList);
    expect(of("domains.create")).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  /** Codes the purchase flow (agents `buy.ts`) treats as "nothing was bought". */
  const REJECTED_CODES = [
    "CREDENTIALS_MISSING",
    "CREDENTIALS_INVALID",
    "INVALID_INPUT",
    "PHASE_PRECONDITION",
  ];

  it.each([
    [
      "domains-create-error-unavailable",
      fixture("domains-create-error-unavailable"),
      /not available/,
    ],
    ["domains-create-error-prices", fixture("domains-create-error-prices"), /price changed/],
    ["domains-create-error-phone", fixture("domains-create-error-phone"), /rejected the phone/],
    ["domains-create-error-balance", fixture("domains-create-error-balance"), /balance is too low/],
    ["an unmapped validation error", errorXml("domains.create", "2011999", "Odd"), /error 2011999/],
    ["Years invalid (2015167)", errorXml("domains.create", "2015167", "Years"), /error 2015167/],
    [
      "a rate limit without a number",
      fixture("error-rate-limit").replace(' Number="500000"', ""),
      /rate limit/,
    ],
    [
      "a rate limit with a user-side number",
      errorXml("domains.create", "2011410", "Too many requests"),
      /rate limit/,
    ],
    ["the IP whitelist", fixture("error-ip-not-whitelisted"), /not on the account's API whitelist/],
    ["the API key", fixture("error-api-key"), /refused the API credentials/],
  ])("reports %s as a clear rejection: nothing was bought", async (_, route, text) => {
    const { fetch, of } = routes(route);
    const error = await failure(
      makeClient(fetch).createDomain({ domain: "shopapp.com", years: 1, privacy: true }),
    );
    expect(REJECTED_CODES).toContain(error.code);
    expect(error.message).toMatch(text);
    expect(error.message).toMatch(/Nothing was bought\.$/);
    expect(error.message).not.toMatch(/may still have started/);
    expect(of("domains.create")).toHaveLength(1);
  });

  it("does not send the order when the default address is unusable", async () => {
    const { fetch, of } = fakeNamecheap({
      ...ADDRESS_ROUTES,
      "users.address.getInfo:102": fixture("users-address-getInfo-102").replace(
        "<Phone>1.5555550100</Phone>",
        "<Phone>5555550100</Phone>",
      ),
      "domains.create": fixture("domains-create"),
    });
    const error = await failure(
      makeClient(fetch).createDomain({ domain: "shopapp.com", years: 1, privacy: true }),
    );
    expect(error.message).toMatch(/phone number .* not in the international format/);
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.addressBook);
    expect(of("domains.create")).toHaveLength(0);
  });

  it("rejects invalid years before any request", async () => {
    const { fetch, calls } = routes(fixture("domains-create"));
    const error = await failure(
      makeClient(fetch).createDomain({ domain: "shopapp.com", years: 11, privacy: true }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});
