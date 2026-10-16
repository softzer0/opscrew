import type { Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { CLOUDFLARE_API, CLOUDFLARE_REGISTRAR_PERMISSIONS, CloudflareClient } from "./client";
import { cloudflareConnector } from "./connector";
import { CloudflareRegistrar } from "./registrar";
import { registrarReasonText } from "./registrar-parse";

const TOKEN = fakeSecret("cloudflare-token");
const ACCOUNT = "acc123";
const REG = `/accounts/${ACCOUNT}/registrar`;
const networkError: FakeReply = { error: new TypeError("fetch failed") };

/** Fake Cloudflare API routed by "METHOD path?query" prefix; each route may be a queue. */
const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: CLOUDFLARE_API });

const ok = (result: unknown, status = 200, extra: Record<string, unknown> = {}) => ({
  status,
  body: { success: true, errors: [], messages: [], result, ...extra },
});
const fail = (status: number, errors: { code?: number | string; message?: string }[]) => ({
  status,
  body: { success: false, errors, messages: [], result: null },
});
const noSleep = async () => {};
const client = (
  routes: Record<string, FakeReply | FakeReply[]>,
  options: { registrarSandbox?: boolean } = {},
) => {
  const fake = fakeFetch(routes);
  return {
    ...fake,
    cf: new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: noSleep, ...options }),
  };
};

/** Asserts a rejected promise is a token-free OpsCrewError and returns it. */
async function plainError(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  const e = error as OpsCrewError;
  expect(`${e.message} ${e.hint ?? ""}`).not.toContain(TOKEN);
  return e;
}

const pricing = (registration: string, renewal: string, currency = "USD") => ({
  currency,
  registration_cost: registration,
  renewal_cost: renewal,
});

describe("CloudflareClient registrar calls", () => {
  it("lists accounts across pages", async () => {
    const { cf, calls } = client({
      "GET /accounts?page=1&per_page=50": ok([{ id: "a1", name: "Mine" }], 200, {
        result_info: { page: 1, total_pages: 2 },
      }),
      "GET /accounts?page=2&per_page=50": ok([{ id: "a2", name: "Team", type: "standard" }], 200, {
        result_info: { page: 2, total_pages: 2 },
      }),
    });
    expect(await cf.listAccounts()).toEqual([
      { id: "a1", name: "Mine" },
      { id: "a2", name: "Team" },
    ]);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("checks domains, parses string prices and maps reasons", async () => {
    const { cf, calls } = client({
      [`POST ${REG}/domain-check`]: ok({
        domains: [
          {
            name: "example-app.com",
            registrable: true,
            tier: "standard",
            pricing: pricing("10.44", "10.44"),
          },
          { name: "taken.com", registrable: false, reason: "domain_unavailable" },
          { name: "gold.com", registrable: false, tier: "premium", reason: "domain_premium" },
          { name: "shop.uk", registrable: false, reason: "extension_not_supported_via_api" },
          { name: "x.zz", registrable: false, reason: "extension_not_supported" },
          { name: "y.gov", registrable: false, reason: "extension_disallows_registration" },
          { name: "odd.com", registrable: false, reason: "something_new" },
        ],
      }),
    });
    const checks = await cf.domainCheck(ACCOUNT, [
      "Example-App.com",
      "taken.com",
      "gold.com",
      "shop.uk",
      "x.zz",
      "y.gov",
      "odd.com",
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        domains: [
          "example-app.com",
          "taken.com",
          "gold.com",
          "shop.uk",
          "x.zz",
          "y.gov",
          "odd.com",
        ],
      },
    });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(checks[0]).toEqual({
      domain: "example-app.com",
      registrable: true,
      tier: "standard",
      firstYear: { amount: 10.44, currency: "USD" },
      renewal: { amount: 10.44, currency: "USD" },
    });
    expect(checks[1]).toEqual({
      domain: "taken.com",
      registrable: false,
      reason: "This domain is already registered by someone else.",
    });
    expect(checks[2]?.tier).toBe("premium");
    expect(checks[2]?.reason).toMatch(/premium.*dashboard/);
    expect(checks[3]?.reason).toMatch(/not through its API.*dash\.cloudflare\.com/);
    expect(checks[4]?.reason).toBe("Cloudflare Registrar does not sell this extension.");
    expect(checks[5]?.reason).toMatch(/does not accept new registrations/);
    expect(checks[6]?.reason).toBe("Cloudflare cannot register this domain (something_new).");
    expect(checks.every((c) => c.registrable || !c.firstYear)).toBe(true);
  });

  it("never offers a domain it cannot price or that is premium", async () => {
    const { cf } = client({
      [`POST ${REG}/domain-check`]: ok({
        domains: [
          { name: "a.com", registrable: true, tier: "premium", pricing: pricing("900.00", "900") },
          { name: "b.com", registrable: true },
          { name: "c.com", registrable: true, pricing: pricing("8.00", "8.00", "JPY") },
          { name: "d.com", registrable: true, pricing: pricing("$9.15", "", "usd") },
        ],
      }),
    });
    const [a, b, c, d] = await cf.domainCheck(ACCOUNT, ["a.com", "b.com", "c.com", "d.com"]);
    expect(a).toMatchObject({ registrable: false, tier: "premium" });
    expect(b).toMatchObject({ registrable: false, reason: expect.stringContaining("price") });
    expect(c).toMatchObject({ registrable: false, reason: expect.stringContaining("JPY") });
    expect(d).toEqual({
      domain: "d.com",
      registrable: true,
      firstYear: { amount: 9.15, currency: "USD" },
    });
  });

  it("splits more than 20 domains into batches and keeps the input order", async () => {
    const domains = Array.from({ length: 45 }, (_, i) => `name${i}.com`);
    const answer = (names: string[]) =>
      ok({
        domains: [...names]
          .reverse()
          .map((name) => ({ name, registrable: true, pricing: pricing("10", "10") })),
      });
    const { cf, calls } = client({
      [`POST ${REG}/domain-check`]: [
        answer(domains.slice(0, 20)),
        answer(domains.slice(20, 40)),
        answer(domains.slice(40)),
      ],
    });
    const checks = await cf.domainCheck(ACCOUNT, [...domains, "NAME0.com"]);
    expect(calls.map((c) => (c.body as { domains: string[] }).domains.length)).toEqual([20, 20, 5]);
    expect(checks.map((c) => c.domain)).toEqual(domains);
    expect(await cf.domainCheck(ACCOUNT, [])).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("uses the registrar sandbox paths when asked", async () => {
    const sandbox = `/accounts/${ACCOUNT}/registrar-sandbox`;
    const { cf, calls } = client(
      {
        [`POST ${sandbox}/domain-check`]: ok({ domains: [] }),
        [`GET ${sandbox}/domain-search?q=my+app`]: ok({ domains: [] }),
        [`GET ${sandbox}/extensions/com`]: ok({}),
        [`POST ${sandbox}/registrations`]: ok({ domain_name: "a.com", state: "pending" }, 202),
        [`GET ${sandbox}/registrations/a.com/registration-status`]: ok({ state: "pending" }),
        [`GET ${sandbox}/registrations/a.com`]: ok({ domain_name: "a.com", auto_renew: true }),
        [`PATCH ${sandbox}/registrations/a.com`]: ok({ domain_name: "a.com", auto_renew: false }),
      },
      { registrarSandbox: true },
    );
    await cf.domainCheck(ACCOUNT, ["a.com"]);
    await cf.domainSearch(ACCOUNT, "my app");
    await cf.getExtension(ACCOUNT, "com");
    await cf.createRegistration(ACCOUNT, {
      domain_name: "a.com",
      years: 1,
      auto_renew: true,
      privacy_mode: "redaction",
    });
    await cf.registrationStatus(ACCOUNT, "a.com");
    await cf.getRegistration(ACCOUNT, "a.com");
    await cf.setAutoRenew(ACCOUNT, "a.com", false);
    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.path.includes("/registrar-sandbox/"))).toBe(true);
    // The sandbox ignores the account's default contact, so a made-up one goes along.
    expect(calls[3]?.body).toMatchObject({
      domain_name: "a.com",
      contacts: {
        registrant: {
          email: expect.stringMatching(/@example\.com$/),
          phone: expect.stringMatching(/^\+1\.\d+$/),
          postal_info: { name: expect.any(String), address: { country_code: "US" } },
        },
      },
    });
  });

  it("searches cached suggestions", async () => {
    const { cf, calls } = client({
      [`GET ${REG}/domain-search?q=coffee+shop`]: ok({
        domains: [
          { name: "coffeeshop.dev", pricing: pricing("12.00", "12.00") },
          { name: "coffee-shop.com", registrable: true, pricing: pricing("10.44", "10.44") },
          { registrable: true },
        ],
      }),
    });
    const suggestions = await cf.domainSearch(ACCOUNT, "coffee shop");
    expect(suggestions.map((s) => s.domain)).toEqual(["coffeeshop.dev", "coffee-shop.com"]);
    expect(suggestions[0]).toMatchObject({ registrable: true, firstYear: { amount: 12 } });
    expect(calls[0]?.method).toBe("GET");
  });

  it("reads whether an extension needs contact extensions", async () => {
    const { cf, calls } = client({
      [`GET ${REG}/extensions/us`]: ok({ contact_extensions: [{ name: "nexus_category" }] }),
      [`GET ${REG}/extensions/com`]: ok({ name: "com", contact_extensions: [] }),
      [`GET ${REG}/extensions/uk`]: ok({ contact_extensions_required: true }),
      [`GET ${REG}/extensions/zz`]: fail(404, [{ code: 10000, message: "not found" }]),
    });
    expect(await cf.getExtension(ACCOUNT, ".US")).toEqual({
      tld: "us",
      contactExtensionsRequired: true,
    });
    expect(await cf.getExtension(ACCOUNT, "com")).toEqual({
      tld: "com",
      contactExtensionsRequired: false,
    });
    expect((await cf.getExtension(ACCOUNT, "uk"))?.contactExtensionsRequired).toBe(true);
    expect(await cf.getExtension(ACCOUNT, "zz")).toBeUndefined();
    expect(calls[0]?.path).toBe(`${REG}/extensions/us`);
  });

  it("starts a registration asynchronously and handles 202 and 201", async () => {
    const { cf, calls } = client({
      [`POST ${REG}/registrations`]: [
        ok({ domain_name: "example-app.com", state: "in_progress", links: { self: "/x" } }, 202),
        ok({ domain_name: "done.com", status: "active", auto_renew: true }, 201),
        ok({ domain_name: "done.com" }, 201),
        ok({ domain_name: "done.com", state: "succeeded" }, 201),
      ],
    });
    const request = {
      domain_name: "Example-App.com",
      years: 2,
      auto_renew: true,
      privacy_mode: "redaction",
    } as const;
    expect(await cf.createRegistration(ACCOUNT, request)).toEqual({
      domain: "example-app.com",
      state: "in_progress",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `${REG}/registrations`,
      body: {
        domain_name: "example-app.com",
        years: 2,
        auto_renew: true,
        privacy_mode: "redaction",
      },
    });
    // A real purchase uses the account's own contact: OpsCrew never sends one.
    expect(calls[0]?.body).not.toHaveProperty("contacts");
    expect(calls[0]?.headers.Prefer).toBe("respond-async");
    const done = { ...request, domain_name: "done.com" };
    // Without an explicit `succeeded` state the registration is only in progress (polling confirms).
    expect(await cf.createRegistration(ACCOUNT, done)).toEqual({
      domain: "done.com",
      state: "in_progress",
    });
    expect(await cf.createRegistration(ACCOUNT, done)).toEqual({
      domain: "done.com",
      state: "in_progress",
    });
    expect(await cf.createRegistration(ACCOUNT, done)).toEqual({
      domain: "done.com",
      state: "succeeded",
    });
  });

  const purchase = {
    domain_name: "a.com",
    years: 1,
    auto_renew: true,
    privacy_mode: "off",
  } as const;

  /** Asserts the error says the purchase may have started and names the status command. */
  async function mayHaveStarted(promise: Promise<unknown>) {
    const error = await plainError(promise);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(
      "The purchase may still have started; check its status before trying again.",
    );
    expect(error.hint).toContain("opscrew domain status");
    expect(error.hint).toContain("dash.cloudflare.com");
    return error;
  }

  it("never retries a registration after a server or network error", async () => {
    const { cf, calls } = client({
      [`POST ${REG}/registrations`]: [fail(502, []), networkError],
    });
    expect((await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase))).message).toContain(
      "HTTP 502",
    );
    expect((await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase))).message).toContain(
      "connection failed",
    );
    expect(calls).toHaveLength(2);
  });

  it("treats every unusable registration answer as possibly started", async () => {
    const { cf, calls } = client({
      [`POST ${REG}/registrations`]: [
        { status: 202, text: "<html>Accepted</html>" },
        ok("nonsense", 201),
        ok({ state: 7 }, 201),
        fail(200, [{ code: 1002, message: "Something odd" }]),
        { status: 202, body: { hello: "world" } },
        fail(429, []),
        fail(429, []),
        fail(429, []),
        fail(429, []),
      ],
    });
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    await mayHaveStarted(cf.createRegistration(ACCOUNT, purchase));
    expect(calls).toHaveLength(9);
  });

  it("marks clear refusals (a Cloudflare error envelope with a 4xx) distinctly, without the token", async () => {
    const { cf } = client({
      [`POST ${REG}/registrations`]: [
        fail(400, [{ code: "domain_unavailable" }]),
        fail(400, [{ code: 1001, message: "No default payment method on file." }]),
        fail(409, [{ code: 1002, message: "A registration for this domain already exists." }]),
        fail(422, [{ code: 1003, message: "The account has no default registrant contact." }]),
        fail(403, [{ code: 10000, message: "Authentication error" }]),
      ],
    });
    const request = {
      domain_name: "a.com",
      years: 1,
      auto_renew: true,
      privacy_mode: "off",
    } as const;
    const taken = await plainError(cf.createRegistration(ACCOUNT, request));
    expect(taken.code).toBe("PHASE_PRECONDITION");
    expect(taken.message).toBe(
      "Cloudflare refused to register a.com: This domain is already registered by someone else.",
    );
    expect(taken.hint).toContain("dash.cloudflare.com");
    const billing = await plainError(cf.createRegistration(ACCOUNT, request));
    expect(billing.code).toBe("PHASE_PRECONDITION");
    expect(billing.message).toContain("No default payment method on file.");
    expect(billing.hint).toMatch(/payment method.*registrant contact/);
    const conflict = await plainError(cf.createRegistration(ACCOUNT, request));
    expect(conflict.code).toBe("PHASE_PRECONDITION");
    expect(conflict.message).toContain("already exists");
    const contact = await plainError(cf.createRegistration(ACCOUNT, request));
    expect(contact.code).toBe("PHASE_PRECONDITION");
    expect(contact.message).toContain("no default registrant contact");
    const denied = await plainError(cf.createRegistration(ACCOUNT, request));
    expect(denied.code).toBe("CREDENTIALS_INVALID");
    expect(denied.hint).toContain("Account → Registrar (edit)");
    expect(denied.hint).toContain("optional");
  });

  it("treats a 4xx without a Cloudflare envelope as possibly started", async () => {
    const { cf } = client({
      [`POST ${REG}/registrations`]: [
        { status: 400, text: "<html>Bad request</html>" },
        { status: 404, body: { hello: "world" } },
        { status: 409, body: { success: true, errors: [], result: null } },
      ],
    });
    for (let i = 0; i < 3; i++) {
      const error = await plainError(cf.createRegistration(ACCOUNT, purchase));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("may still have started");
    }
  });

  it("reads workflow states with Cloudflare's explanation", async () => {
    const status = `GET ${REG}/registrations/a.com/registration-status`;
    const { cf } = client({
      [status]: [
        ok({ domain_name: "a.com", state: "pending" }),
        ok({ domain_name: "a.com", state: "succeeded" }),
        ok({
          domain_name: "a.com",
          state: "action_required",
          error: { code: "contact_verification", message: "Verify the registrant email." },
        }),
        ok({ domain_name: "a.com", state: "blocked", error: { code: "billing" } }),
        ok({ domain_name: "a.com", state: "failed", error: { message: "Registry timeout" } }),
        ok({ domain_name: "a.com", state: "queued" }),
        fail(404, [{ code: 10000, message: "No workflow found for a.com" }]),
      ],
    });
    expect(await cf.registrationStatus(ACCOUNT, "A.com")).toEqual({
      domain: "a.com",
      state: "pending",
    });
    expect(await cf.registrationStatus(ACCOUNT, "a.com")).toEqual({
      domain: "a.com",
      state: "succeeded",
    });
    const action = await cf.registrationStatus(ACCOUNT, "a.com");
    expect(action?.state).toBe("action_required");
    expect(action?.message).toMatch(/Verify the registrant email.*dash\.cloudflare\.com/);
    const blocked = await cf.registrationStatus(ACCOUNT, "a.com");
    expect(blocked?.state).toBe("blocked");
    expect(blocked?.message).toMatch(/blocked the registration of a\.com: error billing/);
    const failed = await cf.registrationStatus(ACCOUNT, "a.com");
    expect(failed).toEqual({
      domain: "a.com",
      state: "failed",
      message: "The registration of a.com failed: Registry timeout.",
    });
    expect(await cf.registrationStatus(ACCOUNT, "a.com")).toMatchObject({
      state: "in_progress",
      message: expect.stringContaining("queued"),
    });
    expect(await cf.registrationStatus(ACCOUNT, "a.com")).toBeUndefined();
  });

  it("fails closed on every 404 that is not the live API's exact not-found answer", async () => {
    const statusPath = `GET ${REG}/registrations/a.com/registration-status`;
    const detailPath = `GET ${REG}/registrations/a.com`;
    const notRegistration = [
      fail(404, [{ code: 10000, message: "Not found" }]),
      fail(404, [{ code: 7003, message: "Could not route to /accounts/acc123/registrar" }]),
      fail(404, [{ code: 7000, message: "No route for that URI" }]),
      fail(404, [{ code: 9109, message: "Domain not found for this account" }]),
      fail(404, [{ message: "Account not found" }]),
      fail(404, [{ message: "Domain not found: missing permission" }]),
      fail(404, [{ message: "Not found" }]),
      fail(404, [{ code: 10404, message: "Registration not found" }]),
      fail(404, [{ code: "registration_not_found" }]),
      fail(404, [{ message: "Domain a.com does not exist" }]),
      fail(404, [{ message: "Domain not found" }]),
      fail(404, [{ message: "No workflow found for a.com" }]),
      fail(404, []),
      { status: 404, text: "Not Found" },
    ];
    const { cf } = client({ [statusPath]: notRegistration, [detailPath]: notRegistration });
    for (let i = 0; i < notRegistration.length; i++) {
      await plainError(cf.registrationStatus(ACCOUNT, "a.com"));
      await plainError(cf.getRegistration(ACCOUNT, "a.com"));
    }
  });

  it("reads the live API's exact not-found answers (code 10000) as no registration, nothing else", async () => {
    // Recorded from the real and sandbox Registrar APIs on 2026-10-14.
    const statusPath = `GET ${REG}/registrations/a.com/registration-status`;
    const detailPath = `GET ${REG}/registrations/a.com`;
    const { cf } = client({
      [statusPath]: [
        fail(404, [{ code: 10000, message: "No workflow found for other.com" }]),
        fail(404, [{ code: 10000, message: "Authentication error" }]),
        fail(404, [{ code: 10000, message: "No workflow found for a.com" }]),
      ],
      [detailPath]: [
        fail(404, [{ code: 10000, message: "Authentication error" }]),
        fail(404, [{ code: 10000, message: "Domain not found" }]),
      ],
    });
    await plainError(cf.registrationStatus(ACCOUNT, "a.com"));
    await plainError(cf.registrationStatus(ACCOUNT, "a.com"));
    expect(await cf.registrationStatus(ACCOUNT, "a.com")).toBeUndefined();
    await plainError(cf.getRegistration(ACCOUNT, "a.com"));
    expect(await cf.getRegistration(ACCOUNT, "a.com")).toBeUndefined();
  });

  it("reads a registration and updates auto-renew", async () => {
    const registration = {
      domain_name: "a.com",
      created_at: "2026-10-13T10:00:00Z",
      expires_at: "2027-10-13T10:00:00Z",
      auto_renew: false,
      locked: true,
      privacy_mode: "redaction",
    };
    const { cf, calls } = client({
      [`GET ${REG}/registrations/a.com`]: ok(registration),
      [`GET ${REG}/registrations/gone.com`]: fail(404, [
        { code: 10000, message: "Domain not found" },
      ]),
      [`PATCH ${REG}/registrations/a.com`]: [ok({ ...registration, auto_renew: true }), ok(null)],
    });
    expect(await cf.getRegistration(ACCOUNT, "a.com")).toEqual({
      domain: "a.com",
      registrar: "cloudflare",
      createdAt: "2026-10-13T10:00:00.000Z",
      expiresAt: "2027-10-13T10:00:00.000Z",
      autoRenew: false,
      locked: true,
      privacy: true,
    });
    expect(await cf.getRegistration(ACCOUNT, "gone.com")).toBeUndefined();
    expect((await cf.setAutoRenew(ACCOUNT, "a.com", true)).autoRenew).toBe(true);
    expect(calls[2]).toMatchObject({ method: "PATCH", body: { auto_renew: true } });
    // An answer without the registration falls back to reading it.
    expect((await cf.setAutoRenew(ACCOUNT, "a.com", false)).domain).toBe("a.com");
    expect(calls.at(-1)?.method).toBe("GET");
  });

  it("creates a zone on the account", async () => {
    const zone = {
      id: "z1",
      name: "a.com",
      status: "pending",
      name_servers: ["x.ns.cloudflare.com"],
    };
    const { cf, calls } = client({ "POST /zones": ok(zone) });
    expect(await cf.createZone(ACCOUNT, "A.com")).toEqual({
      id: "z1",
      name: "a.com",
      status: "pending",
      nameServers: ["x.ns.cloudflare.com"],
    });
    expect(calls[0]?.body).toEqual({ name: "a.com", account: { id: ACCOUNT }, type: "full" });
  });

  it("returns the existing zone when it already exists", async () => {
    const zone = {
      id: "z9",
      name: "a.com",
      status: "active",
      name_servers: [],
      account: { id: ACCOUNT },
    };
    const { cf } = client({
      "POST /zones": fail(400, [{ code: 1061, message: "a.com already exists" }]),
      "GET /zones?name=a.com&per_page=1": ok([zone]),
    });
    expect(await cf.createZone(ACCOUNT, "a.com")).toMatchObject({ id: "z9", status: "active" });
  });

  it("refuses an existing zone in another account or one it cannot see", async () => {
    const { cf } = client({
      "POST /zones": fail(409, [{ message: "Zone already exists" }]),
      "GET /zones?name=a.com&per_page=1": [
        ok([{ id: "z9", name: "a.com", status: "active", account: { id: "other" } }]),
        ok([]),
      ],
    });
    expect((await plainError(cf.createZone(ACCOUNT, "a.com"))).message).toMatch(
      /another Cloudflare account/,
    );
    expect((await plainError(cf.createZone(ACCOUNT, "a.com"))).message).toMatch(/cannot see it/);
  });

  it("explains a missing zone-create permission", async () => {
    const { cf } = client({ "POST /zones": fail(403, [{ message: "Authentication error" }]) });
    const error = await plainError(cf.createZone(ACCOUNT, "a.com"));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Zone → Zone → Edit");
  });

  it("turns on DNSSEC", async () => {
    const { cf, calls } = client({
      "PATCH /zones/z1/dnssec": ok({ status: "pending", ds: "a.com. 3600 IN DS 2371 13 2 ABC" }),
    });
    expect(await cf.enableDnssec("z1")).toEqual({
      status: "pending",
      ds: "a.com. 3600 IN DS 2371 13 2 ABC",
    });
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { status: "active" } });
  });

  it("reads the DNSSEC state of a zone", async () => {
    const { cf, calls } = client({
      "GET /zones/z1/dnssec": [
        ok({ status: "active", ds: "a.com. DS" }),
        ok({ status: "disabled" }),
      ],
      "GET /zones/z2/dnssec": fail(403, [{ message: "Authentication error" }]),
    });
    expect(await cf.getDnssec("z1")).toEqual({ status: "active", ds: "a.com. DS" });
    expect(await cf.getDnssec("z1")).toEqual({ status: "disabled" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/zones/z1/dnssec" });
    expect((await plainError(cf.getDnssec("z2"))).code).toBe("CREDENTIALS_INVALID");
  });

  it("maps a missing registrar permission to a plain hint", async () => {
    const { cf } = client({
      [`POST ${REG}/domain-check`]: fail(403, [{ code: 10000, message: "Authentication error" }]),
      "GET /accounts?page=1&per_page=50": fail(500, [{ message: "boom" }]),
    });
    const error = await plainError(cf.domainCheck(ACCOUNT, ["a.com"]));
    expect(error.message).toBe(
      "Cloudflare refused the request to check whether the domains can be registered: Authentication error.",
    );
    expect(error.hint).toContain(CLOUDFLARE_REGISTRAR_PERMISSIONS[0]);
    expect(error.hint).toContain("for all zones of the account");
    expect((await plainError(cf.listAccounts())).hint).toMatch(/cloudflarestatus/);
  });

  it("blames the token, not registrar billing, when listing accounts is refused", async () => {
    for (const status of [400, 401, 403]) {
      const { cf } = client({
        "GET /accounts?page=1&per_page=50": fail(status, [
          { code: status === 400 ? 6003 : 10000, message: "Invalid request headers" },
        ]),
      });
      const error = await plainError(cf.listAccounts());
      expect(error.code).toBe(status === 400 ? "PROVIDER_ERROR" : "CREDENTIALS_INVALID");
      expect(error.hint).toContain("may be mistyped, expired or revoked");
      expect(error.hint).toContain("https://dash.cloudflare.com/profile/api-tokens");
      expect(error.hint).toContain(CLOUDFLARE_REGISTRAR_PERMISSIONS[0]);
      expect(error.hint).not.toMatch(/payment method|registrant contact|verified email/);
      // never a colon right after the environment variable name
      expect(error.hint).not.toContain("CLOUDFLARE_API_TOKEN:");
    }
  });

  it("points other refused non-registrar calls at the token, and DNSSEC refusals at zone coverage", async () => {
    const { cf } = client({
      "GET /zones/z1/dns_records?page=1&per_page=100": fail(400, [
        { code: 6111, message: "Invalid format for Authorization header" },
      ]),
      "PATCH /zones/z2/dnssec": fail(403, [{ code: 10000, message: "Authentication error" }]),
      "GET /zones/z2/dnssec": fail(403, [{ code: 10000, message: "Authentication error" }]),
    });
    const records = await plainError(cf.listDnsRecords("z1"));
    expect(records.hint).toContain("may be mistyped, expired or revoked");
    expect(records.hint).not.toMatch(/cloudflarestatus|payment method/);
    for (const call of [cf.enableDnssec("z2"), cf.getDnssec("z2")]) {
      const error = await plainError(call);
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("add this zone (or all zones of the account)");
    }
  });

  it("rejects malformed answers plainly", async () => {
    const { cf } = client({ [`POST ${REG}/domain-check`]: ok("nonsense") });
    expect((await plainError(cf.domainCheck(ACCOUNT, ["a.com"]))).message).toMatch(
      /unexpected answer/,
    );
  });
});

describe("CloudflareRegistrar", () => {
  it("implements the Registrar contract", () => {
    const registrar = new CloudflareRegistrar(
      new CloudflareClient({ fetch: fakeFetch({}).fetch }),
      ACCOUNT,
    ) satisfies Registrar;
    expectTypeOf(registrar).toMatchTypeOf<Registrar>();
    expect(registrar.id).toBe("cloudflare");
  });

  it("checks, suggests with a live check, registers and manages a domain", async () => {
    const { cf, calls } = client({
      [`POST ${REG}/domain-check`]: ok({
        domains: [
          { name: "brew.dev", registrable: true, pricing: pricing("12.00", "12.00") },
          { name: "brew.com", registrable: false, reason: "domain_unavailable" },
        ],
      }),
      [`GET ${REG}/domain-search?q=brew`]: ok({
        domains: [{ name: "brew.dev" }, { name: "brew.com" }, { name: "brew.dev" }],
      }),
      [`POST ${REG}/registrations`]: ok({ domain_name: "brew.dev", state: "pending" }, 202),
      [`GET ${REG}/registrations/brew.dev/registration-status`]: ok({ state: "succeeded" }),
      [`GET ${REG}/registrations/brew.dev`]: ok({ domain_name: "brew.dev", auto_renew: true }),
      [`PATCH ${REG}/registrations/brew.dev`]: ok({ domain_name: "brew.dev", auto_renew: false }),
    });
    const registrar = new CloudflareRegistrar(cf, ACCOUNT);
    expect((await registrar.check(["brew.dev"]))[0]?.registrable).toBe(true);
    const suggestions = await registrar.suggest("brew");
    expect(suggestions.map((s) => [s.domain, s.registrable])).toEqual([
      ["brew.dev", true],
      ["brew.com", false],
    ]);
    expect(calls[2]?.body).toEqual({ domains: ["brew.dev", "brew.com"] });
    expect(
      await registrar.register({ domain: "brew.dev", years: 1, autoRenew: true, privacy: true }),
    ).toEqual({ domain: "brew.dev", state: "pending" });
    expect(calls[3]?.body).toEqual({
      domain_name: "brew.dev",
      years: 1,
      auto_renew: true,
      privacy_mode: "redaction",
    });
    await registrar.register({ domain: "brew.dev", years: 3, autoRenew: false, privacy: false });
    expect(calls[4]?.body).toMatchObject({ years: 3, auto_renew: false, privacy_mode: "off" });
    expect(await registrar.registrationStatus("brew.dev")).toEqual({
      domain: "brew.dev",
      state: "succeeded",
    });
    expect(await registrar.getDomain("brew.dev")).toEqual({
      domain: "brew.dev",
      registrar: "cloudflare",
      autoRenew: true,
    });
    expect((await registrar.setAutoRenew("brew.dev", false)).autoRenew).toBe(false);
  });

  it("skips the live check when there are no suggestions and validates years", async () => {
    const { cf, calls } = client({ [`GET ${REG}/domain-search?q=zzz`]: ok({ domains: [] }) });
    const registrar = new CloudflareRegistrar(cf, ACCOUNT);
    expect(await registrar.suggest("zzz")).toEqual([]);
    expect(calls).toHaveLength(1);
    const error = await plainError(
      registrar.register({ domain: "a.com", years: 11, autoRenew: true, privacy: true }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(1);
  });
});

describe("registrar credentials", () => {
  it("lists the optional permissions for buying domains", () => {
    const connector = cloudflareConnector({ env: {}, fetch: fakeFetch({}).fetch });
    const scopes = connector.credentials.scopes.join("\n");
    expect(scopes).toContain("Zone → DNS → Edit");
    expect(scopes).toContain("Account → Registrar (edit) (optional, for buying domains)");
    expect(scopes).toMatch(/Zone → Zone → Edit .*account.*optional/);
    // a token limited to today's zones does not cover a bought domain's zone: say so plainly
    expect(scopes).toMatch(
      /Zone → DNS → Edit.*for all zones of the account.*add that zone to the token right after buying \(optional, for buying domains\)/,
    );
    expect(connector.credentials.description).toMatch(/optional/);
    expect(connector.credentials.description).toContain("cover all zones of the account");
    expect(connector.credentials.description).toContain("add the new domain's zone to the token");
  });

  it("names unknown reason codes", () => {
    expect(registrarReasonText("domain_unavailable")).toMatch(/already registered/);
    expect(registrarReasonText("new_code")).toContain("new_code");
  });
});
