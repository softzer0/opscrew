import { inspect } from "node:util";
import type { Registrar, RegistrationRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_ROUTES,
  CLIENT_IP,
  CONTACT_VALUES,
  fakeNamecheap,
  fixture,
  makeClient,
  type Route,
} from "./__fixtures__/fake-namecheap";
import { NAMECHEAP_DASHBOARD_URLS, NamecheapRegistrar, priceFor } from "./index";

function setup(extra: Record<string, Route | Route[]> = {}) {
  const fake = fakeNamecheap({
    "domains.check": fixture("domains-check"),
    "users.getPricing:REGISTER": fixture("users-getPricing-register-com"),
    "users.getPricing:RENEW": fixture("users-getPricing-renew-com"),
    "users.getBalances": fixture("users-getBalances"),
    "domains.getList": fixture("domains-getList"),
    "domains.dns.getList": fixture("domains-dns-getList"),
    "domains.dns.setCustom": fixture("domains-dns-setCustom"),
    "domains.dns.getHosts": fixture("domains-dns-getHosts"),
    "domains.create": fixture("domains-create"),
    ...ADDRESS_ROUTES,
    ...extra,
  });
  const registrar = new NamecheapRegistrar(makeClient(fake.fetch)) satisfies Registrar;
  return { registrar, ...fake };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const QUOTE_1Y = { price: { amount: 10.48, currency: "USD" as const } };
const request = (overrides: Partial<RegistrationRequest> = {}): RegistrationRequest => ({
  domain: "shopapp.com",
  years: 1,
  autoRenew: true,
  privacy: true,
  quote: QUOTE_1Y,
  ...overrides,
});

describe("NamecheapRegistrar", () => {
  it("declares its id and capabilities", () => {
    const { registrar } = setup();
    expect(registrar.id).toBe("namecheap");
    expect(registrar.capabilities).toEqual({
      purchase: true,
      chooseYears: true,
      nameservers: true,
      records: true,
      dnssec: false,
      autoRenew: false,
    });
    expect("listDsRecords" in registrar).toBe(false);
  });

  it("totals prices per year with Namecheap's additional cost", () => {
    const row = {
      years: 2,
      price: 12.13,
      perYear: true,
      additionalCost: 0.2,
      additionalCostPerYear: true,
      currency: "USD",
    };
    expect(priceFor([row], 2)).toEqual({ amount: 24.66, currency: "USD" });
    expect(priceFor([{ ...row, perYear: false, additionalCostPerYear: false }], 2)).toEqual({
      amount: 12.33,
      currency: "USD",
    });
    expect(priceFor([row], 3)).toBeUndefined();
    expect(priceFor([{ ...row, currency: "EUR" }], 2)).toBeUndefined();
  });

  it("checks availability with first-year and renewal prices", async () => {
    const withUk = fixture("domains-check").replace(
      "</CommandResponse>",
      '<DomainCheckResult Domain="shopapp.co.uk" Available="true" ErrorNo="0" Description="" IsPremiumName="false" /></CommandResponse>',
    );
    const { registrar, of } = setup({ "domains.check": withUk });
    const checks = await registrar.check(["shopapp.com", "taken.com", "us.xyz", "shopapp.co.uk"]);
    expect(checks[0]).toEqual({
      domain: "shopapp.com",
      registrable: true,
      tier: "standard",
      firstYear: { amount: 10.48, currency: "USD" },
      renewal: { amount: 14.18, currency: "USD" },
    });
    expect(checks[1]).toMatchObject({ domain: "taken.com", registrable: false });
    expect(checks[1]?.reason).toMatch(/already registered/);
    expect(checks[2]).toMatchObject({ domain: "us.xyz", registrable: false, tier: "premium" });
    expect(checks[2]?.reason).toContain("`opscrew domain connect us.xyz`");
    expect(checks[3]).toMatchObject({ domain: "shopapp.co.uk", registrable: false });
    expect(checks[3]?.reason).toMatch(/extended attributes/);
    expect(of("domains.check")).toHaveLength(1);
    expect(of("users.getPricing").map((c) => c.params.get("ProductName"))).toEqual(["COM", "COM"]);
  });

  it("suggests by checking the query or a few common extensions", async () => {
    const { registrar, of } = setup();
    await registrar.suggest("Shop App!");
    expect(of("domains.check")[0]?.params.get("DomainList")).toBe(
      "shopapp.com,shopapp.net,shopapp.org,shopapp.io,shopapp.dev,shopapp.app,shopapp.co",
    );
    await registrar.suggest("shopapp.com");
    expect(of("domains.check")[1]?.params.get("DomainList")).toBe("shopapp.com");
    expect(await registrar.suggest("!!!")).toEqual([]);
  });

  it("quotes the price for the chosen years and the renewal price", async () => {
    const { registrar } = setup();
    expect(await registrar.quote("shopapp.com", 2)).toEqual({
      price: { amount: 24.66, currency: "USD" },
      renewal: { amount: 14.18, currency: "USD" },
    });
  });

  it("stops quoting premium, taken and extended-attribute domains", async () => {
    const { registrar, calls } = setup();
    const premium = await failure(registrar.quote("us.xyz", 1));
    expect(premium.code).toBe("PHASE_PRECONDITION");
    expect(premium.hint).toContain(NAMECHEAP_DASHBOARD_URLS.domainList);
    expect(premium.hint).toContain("`opscrew domain connect us.xyz`");
    expect((await failure(registrar.quote("taken.com", 1))).message).toMatch(/already registered/);
    const before = calls.length;
    const us = await failure(registrar.quote("shopapp.us", 1));
    expect(us.hint).toMatch(/extended attributes/);
    expect(us.hint).toContain("`opscrew domain connect shopapp.us`");
    expect(calls.length).toBe(before);
    expect((await failure(registrar.quote("shopapp.com", 0))).code).toBe("INVALID_INPUT");
  });

  it("returns the masked contact summary only", async () => {
    const { registrar } = setup();
    expect(await registrar.contactSummary()).toBe("T*** P***, US");
  });

  it("needs the approved quote to buy", async () => {
    const { registrar, of } = setup();
    const { quote: _, ...withoutQuote } = request();
    const error = await failure(registrar.register(withoutQuote));
    expect(error.code).toBe("INVALID_INPUT");
    expect(of("domains.create")).toHaveLength(0);
  });

  it("stops before buying when the price rose or the balance is too low", async () => {
    const { registrar, of } = setup();
    const raised = await failure(
      registrar.register(request({ quote: { price: { amount: 9.99, currency: "USD" } } })),
    );
    expect(raised.message).toMatch(/changed from \$9\.99 to \$10\.48.*Nothing was bought/);
    const poor = setup({
      "users.getBalances": fixture("users-getBalances").replace(/"64\.20"/g, '"5.00"'),
    });
    const low = await failure(poor.registrar.register(request()));
    expect(low.message).toMatch(/balance \(\$5\.00\) is lower than the price.*\(\$10\.48\)/);
    expect(low.message).toMatch(/Nothing was bought/);
    expect(of("domains.create")).toHaveLength(0);
    expect(poor.of("domains.create")).toHaveLength(0);
  });

  it("buys once and points at the dashboard for auto-renew", async () => {
    const { registrar, of } = setup();
    const status = await registrar.register(request({ autoRenew: true }));
    expect(status.state).toBe("succeeded");
    expect(status.domain).toBe("shopapp.com");
    expect(status.message).toMatch(/Auto-renew for shopapp\.com is off/);
    expect(status.message).toContain(NAMECHEAP_DASHBOARD_URLS.domainList);
    expect(of("domains.create")).toHaveLength(1);
    expect(of("domains.create")[0]?.params.get("Nameservers")).toBeNull();
    const same = setup();
    expect((await same.registrar.register(request({ autoRenew: false }))).message).toBeUndefined();
  });

  it("reports a non-real-time registration as pending", async () => {
    const { registrar } = setup({ "domains.create": fixture("domains-create-nonrealtime") });
    const status = await registrar.register(request());
    expect(status.state).toBe("pending");
    expect(status.message).toMatch(/still registering/);
  });

  it("passes on clear rejections and ambiguous answers from the purchase", async () => {
    const rejected = setup({ "domains.create": fixture("domains-create-error-unavailable") });
    const clear = await failure(rejected.registrar.register(request()));
    expect(clear.message).toMatch(/Nothing was bought/);
    const unclear = setup({ "domains.create": { status: 500, body: "" } });
    const maybe = await failure(unclear.registrar.register(request()));
    expect(maybe.message).toMatch(/may still have started/);
    expect(unclear.of("domains.create")).toHaveLength(1);
  });

  it("reads registrations, details and ownership from the domain list", async () => {
    const { registrar, of } = setup();
    expect(await registrar.registrationStatus("ShopApp.com")).toEqual({
      domain: "shopapp.com",
      state: "succeeded",
    });
    expect(of("domains.getList")[0]?.params.get("SearchTerm")).toBe("shopapp.com");
    expect(await registrar.registrationStatus("other.com")).toBeUndefined();
    expect(await registrar.getDomain("shopapp.net")).toEqual({
      domain: "shopapp.net",
      registrar: "namecheap",
      createdAt: "2025-04-28T00:00:00.000Z",
      expiresAt: "2027-04-28T00:00:00.000Z",
      autoRenew: true,
      locked: true,
      privacy: false,
    });
    expect(await registrar.getDomain("other.com")).toBeUndefined();
    expect(await registrar.ownsDomain("shopapp.com")).toBe(true);
    expect(await registrar.ownsDomain("other.com")).toBe(false);
  });

  it("cannot change auto-renew through the API", async () => {
    const { registrar, calls } = setup();
    const error = await failure(registrar.setAutoRenew("shopapp.com", true));
    expect(error.message).toMatch(/does not let OpsCrew change auto-renew/);
    expect(error.hint).toContain(NAMECHEAP_DASHBOARD_URLS.domainList);
    expect(calls).toHaveLength(0);
  });

  it("reads and sets nameservers", async () => {
    const { registrar, of } = setup();
    expect(await registrar.getNameservers("shopapp.com")).toEqual([
      "dns1.registrar-servers.com",
      "dns2.registrar-servers.com",
    ]);
    await registrar.setNameservers("shopapp.com", [
      "ada.ns.cloudflare.com",
      "bob.ns.cloudflare.com",
    ]);
    expect(of("domains.dns.setCustom")[0]?.params.get("Nameservers")).toBe(
      "ada.ns.cloudflare.com,bob.ns.cloudflare.com",
    );
  });

  it("maps host records to FQDNs and keeps registrar-only types", async () => {
    const { registrar } = setup();
    expect(await registrar.listRecords("shopapp.com")).toEqual([
      { type: "A", name: "shopapp.com", content: "192.0.2.10", ttl: 1800 },
      { type: "CNAME", name: "www.shopapp.com", content: "shopapp.com", ttl: 1800 },
      { type: "MX", name: "shopapp.com", content: "mx1.example.net", ttl: 1800, priority: 10 },
      { type: "TXT", name: "shopapp.com", content: "v=spf1 include:example.net ~all", ttl: 1799 },
      { type: "URL301", name: "blog.shopapp.com", content: "https://example.org/blog", ttl: 1800 },
      { type: "ALIAS", name: "api.shopapp.com", content: "lb.example.net", ttl: 300 },
    ]);
    const elsewhere = setup({
      "domains.dns.getHosts": fixture("domains-dns-getHosts-error-notourdns"),
    });
    expect(await elsewhere.registrar.listRecords("shopapp.com")).toBeUndefined();
  });

  describe("mail Namecheap routes itself", () => {
    const hostsWith = (emailType: string, withMx: boolean) => {
      let xml = fixture("domains-dns-getHosts").replace(
        'EmailType="MX"',
        `EmailType="${emailType}"`,
      );
      if (!withMx) xml = xml.replace(/\s*<host [^>]*Type="MX"[^>]*\/>/, "");
      return setup({ "domains.dns.getHosts": xml }).registrar;
    };
    const pseudo = (records: { type: string }[] | undefined) =>
      records?.filter((r) => r.type === "EMAIL-FORWARDING") ?? [];

    it.each([
      ["FWD", "Namecheap email forwarding"],
      ["OX", "Namecheap Private Email"],
      ["GMAIL", "Namecheap mail service (GMAIL)"],
    ])("adds one EMAIL-FORWARDING pseudo-record for %s", async (type, kind) => {
      const records = await hostsWith(type, false).listRecords("shopapp.com");
      expect(pseudo(records)).toEqual([
        {
          type: "EMAIL-FORWARDING",
          name: "shopapp.com",
          content: `${kind} (not a DNS record; set mail up again at your mail provider or with Cloudflare Email Routing)`,
        },
      ]);
      expect(records?.some((r) => r.type === "MX")).toBe(false);
    });

    it("adds nothing for MX records in the host list or MXE records", async () => {
      expect(pseudo(await hostsWith("MX", true).listRecords("shopapp.com"))).toEqual([]);
      expect(pseudo(await hostsWith("GMAIL", true).listRecords("shopapp.com"))).toEqual([]);
      const mxe = fixture("domains-dns-getHosts")
        .replace('EmailType="MX"', 'EmailType="MXE"')
        .replace(/Type="MX" Address="mx1\.example\.net\."/, 'Type="MXE" Address="192.0.2.25"');
      const records = await setup({ "domains.dns.getHosts": mxe }).registrar.listRecords(
        "shopapp.com",
      );
      expect(pseudo(records)).toEqual([]);
      expect(records).toContainEqual({
        type: "MXE",
        name: "shopapp.com",
        content: "192.0.2.25",
        ttl: 1800,
      });
    });
  });

  it("checks the account: API access, whitelisted IP and balance", async () => {
    const { registrar } = setup();
    const ok = await registrar.accountCheck();
    expect(ok).toMatchObject({ ok: true, balance: { amount: 64.2, currency: "USD" } });
    expect(ok.message).toContain(CLIENT_IP);
    const blocked = setup({ "users.getBalances": fixture("error-ip-not-whitelisted") });
    const failed = await blocked.registrar.accountCheck();
    expect(failed.ok).toBe(false);
    expect(failed.fix).toContain(
      `Add ${CLIENT_IP} to the API whitelist at ${NAMECHEAP_DASHBOARD_URLS.apiAccess}`,
    );
    const noAccess = setup({ "users.getBalances": fixture("error-api-key") });
    expect((await noAccess.registrar.accountCheck()).fix).toMatch(/20 domains/);
  });
});

describe("contact data never leaks (SC-702)", () => {
  /** Every string a value exposes: JSON, inspect (hidden fields, causes) and String(). */
  const exposed = (value: unknown) =>
    [
      String(value),
      JSON.stringify(value) ?? "",
      inspect(value, { depth: 10, showHidden: true, getters: true }),
    ].join("\n");

  const assertClean = (value: unknown) => {
    const text = exposed(value);
    for (const v of CONTACT_VALUES) expect(text).not.toContain(v);
    expect(text).not.toMatch(/\bTest\b/);
  };

  const failurePaths: [string, Record<string, Route | Route[]>][] = [
    ["invalid phone", { "domains.create": fixture("domains-create-error-phone") }],
    ["insufficient balance", { "domains.create": fixture("domains-create-error-balance") }],
    ["price mismatch", { "domains.create": fixture("domains-create-error-prices") }],
    ["not available", { "domains.create": fixture("domains-create-error-unavailable") }],
    ["provider error", { "domains.create": fixture("domains-create-error-provider") }],
    [
      "provider error echoing contacts",
      {
        "domains.create": fixture("domains-create-error-provider").replace(
          "Unknown response from provider",
          "Unknown response for Test Person, 1 Test Street, Testville, test@example.invalid, +1.5555550100",
        ),
      },
    ],
    [
      "unknown clear error echoing contacts",
      {
        "domains.create": fixture("domains-create-error-provider")
          .replace("3031900", "2011999")
          .replace("Unknown response from provider", "Bad contact Test Person 00001-0000"),
      },
    ],
    ["network error", { "domains.create": new TypeError("fetch failed") }],
    ["server error", { "domains.create": { status: 502, body: "Test Person" } }],
    ["unreadable answer", { "domains.create": "<ApiResponse" }],
    [
      "incomplete address",
      {
        "users.address.getInfo:102": fixture("users-address-getInfo-102").replace(
          "<EmailAddress>test@example.invalid</EmailAddress>",
          "<EmailAddress> </EmailAddress>",
        ),
      },
    ],
    [
      "bad phone in the address",
      {
        "users.address.getInfo:102": fixture("users-address-getInfo-102").replace(
          "<Phone>1.5555550100</Phone>",
          "<Phone>5555550100</Phone>",
        ),
      },
    ],
  ];

  it.each(failurePaths)("keeps contact values out of the %s error", async (_, routes) => {
    const { registrar } = setup(routes);
    const error = await failure(registrar.register(request()));
    assertClean(error);
    assertClean(error.message);
    assertClean(error.hint);
  });

  it("keeps contact values out of return values; only the create body carries them", async () => {
    const { registrar, of, calls } = setup();
    const results: unknown[] = [
      await registrar.contactSummary(),
      await registrar.quote("shopapp.com", 1),
      await registrar.register(request()),
      await registrar.registrationStatus("shopapp.com"),
      await registrar.getDomain("shopapp.com"),
      await registrar.accountCheck(),
      await registrar.check(["shopapp.com"]),
      registrar,
    ];
    for (const result of results) assertClean(result);
    const create = of("domains.create")[0];
    expect(create?.body).toContain(encodeURIComponent("test@example.invalid"));
    expect(create?.params.get("RegistrantLastName")).toBe("Person");
    for (const call of calls.filter((c) => c.command !== "domains.create")) {
      for (const v of CONTACT_VALUES) expect(call.body).not.toContain(encodeURIComponent(v));
    }
  });
});
