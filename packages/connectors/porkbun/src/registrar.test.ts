import type { Registrar, RegistrationQuote } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { PORKBUN_DASHBOARD_URL, PorkbunClient, PorkbunRegistrar } from "./index";
import { availability, err, type FakeRoute, fakePorkbun, noSleep, ok } from "./test-helpers";

const API_KEY = fakeSecret("porkbun-api-key");
const SECRET = fakeSecret("porkbun-secret-key");

/** A fake clock: `now` reads it, the registrar's `sleep` advances it and records the wait. */
function fakeClock(start = 1_000_000) {
  const clock = { time: start, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
}

function setup(
  routes: Record<string, FakeRoute | FakeRoute[]>,
  apiKey = API_KEY,
  time = fakeClock(),
) {
  const fake = fakePorkbun(routes);
  const client = new PorkbunClient({
    apiKey,
    secretApiKey: SECRET,
    fetch: fake.fetch,
    sleep: noSleep,
    randomUUID: () => "write-key",
  });
  let n = 0;
  const registrar = new PorkbunRegistrar(client, {
    randomUUID: () => `uuid-${++n}`,
    now: time.now,
    sleep: time.sleep,
  });
  return { registrar, calls: fake.calls, clock: time.clock };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    const e = error as OpsCrewError;
    const text = `${e.message} ${e.hint ?? ""} ${JSON.stringify(e)}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
    return e;
  }
  throw new Error("expected a failure");
}

const usd = (amount: number) => ({ amount, currency: "USD" as const });
const comRequirements = ok({ tld: "dev", apiRegisterable: true, registrationDurationYears: 1 });

describe("PorkbunRegistrar", () => {
  it("implements the Registrar contract with Porkbun's capabilities", () => {
    const { registrar } = setup({});
    const contract: Registrar = registrar satisfies Registrar;
    expect(contract.id).toBe("porkbun");
    expect(registrar.capabilities).toEqual({
      purchase: true,
      chooseYears: false,
      nameservers: true,
      records: true,
      dnssec: true,
      autoRenew: true,
    });
  });

  it("checks names live: available, premium, taken, unresolved and not via the API", async () => {
    const { registrar, calls } = setup({
      "POST /domain/checkDomain": [
        ok({
          domains: {
            "shopapp.dev": availability(),
            "rich.dev": availability({ premium: "yes", price: "1200.00" }),
            "taken.dev": availability({ avail: "no" }),
            "mine.dev": availability({ avail: "no", inYourAccount: true }),
            "shopapp.us": availability(),
          },
          unresolved: ["slow.dev"],
          invalid: [{ domain: "shopapp.notatld", reason: "Invalid domain name." }],
        }),
        ok({ domains: {}, unresolved: ["slow.dev"], invalid: [] }),
      ],
      "GET /domain/getRegistrationRequirements/dev": comRequirements,
      "GET /domain/getRegistrationRequirements/us": ok({
        tld: "us",
        apiRegisterable: false,
        notApiRegisterableReason: "The .us registry needs nexus information.",
      }),
    });
    const results = await registrar.check([
      "shopapp.dev",
      "rich.dev",
      "taken.dev",
      "mine.dev",
      "shopapp.us",
      "slow.dev",
      "shopapp.notatld",
    ]);
    const by = Object.fromEntries(results.map((r) => [r.domain, r]));
    expect(by["shopapp.dev"]).toEqual({
      domain: "shopapp.dev",
      registrable: true,
      tier: "standard",
      firstYear: usd(9.73),
      renewal: usd(10.37),
    });
    expect(by["rich.dev"]).toMatchObject({ registrable: false, tier: "premium" });
    expect(by["rich.dev"]?.reason).toContain("opscrew domain connect");
    expect(by["taken.dev"]?.reason).toContain("someone else");
    expect(by["mine.dev"]?.reason).toContain("already in your Porkbun account");
    expect(by["shopapp.us"]).toMatchObject({ registrable: false });
    expect(by["shopapp.us"]?.reason).toContain("nexus");
    expect(by["slow.dev"]).toMatchObject({ registrable: false });
    expect(by["slow.dev"]?.reason).toContain("try again");
    expect(by["shopapp.notatld"]?.reason).toContain("Invalid domain name");
    // The unresolved name is checked once more; requirements are fetched once per extension.
    expect(calls.filter((c) => c.path === "/domain/checkDomain")).toHaveLength(2);
    expect(calls.filter((c) => c.path.includes("Requirements/dev"))).toHaveLength(1);
  });

  it("answers names that are not domains without asking Porkbun", async () => {
    const { registrar, calls } = setup({});
    expect(await registrar.check(["not a domain"])).toEqual([
      { domain: "not a domain", registrable: false, reason: "This is not a domain name." },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("suggests by checking a domain, or a name under common extensions", async () => {
    const { registrar, calls } = setup({
      "POST /domain/checkDomain": ok({ domains: { "shopapp.dev": availability() } }),
      "GET /domain/getRegistrationRequirements/": comRequirements,
    });
    await registrar.suggest("ShopApp.dev");
    expect(calls[0]?.body?.domains).toEqual(["shopapp.dev"]);
    await registrar.suggest("Shop App");
    const checks = calls.filter((c) => c.path === "/domain/checkDomain");
    const names = checks[1]?.body?.domains as string[];
    expect(names).toContain("shopapp.com");
    expect(names.length).toBeLessThanOrEqual(10);
    const before = calls.length;
    expect(await registrar.suggest("!!!")).toEqual([]);
    expect(calls).toHaveLength(before);
  });

  describe("quote", () => {
    it("returns the exact price of the minimum term and the renewal", async () => {
      const { registrar, calls } = setup({
        "POST /domain/checkDomain/shopapp.dev": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": ok({
          dryRun: true,
          wouldSucceed: true,
          domain: "shopapp.dev",
          duration: 1,
          cost: 973,
          sufficientFunds: true,
        }),
      });
      const quote = await registrar.quote("ShopApp.dev", 1);
      expect(quote).toEqual({ price: usd(9.73), renewal: usd(10.37) });
      const dryRun = calls.find((c) => c.path === "/domain/create/shopapp.dev");
      expect(dryRun?.body).toMatchObject({ dryRun: true, cost: 0 });
      expect(dryRun?.headers["Idempotency-Key"]).toBeUndefined();
    });

    it("refuses more years than the registry minimum", async () => {
      const { registrar } = setup({
        "POST /domain/checkDomain/shopapp.dev": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
      });
      const error = await failure(registrar.quote("shopapp.dev", 2));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("1 year");
      expect(error.message).toContain("minimum");
    });

    it("quotes the whole minimum term of a two-year extension", async () => {
      const { registrar } = setup({
        "POST /domain/checkDomain/shopapp.ai": ok({
          response: availability({ price: "70.00", minDuration: 2 }),
        }),
        "GET /domain/getRegistrationRequirements/ai": ok({
          tld: "ai",
          apiRegisterable: true,
          registrationDurationYears: 2,
        }),
        "POST /domain/create/shopapp.ai": ok({
          dryRun: true,
          wouldSucceed: true,
          domain: "shopapp.ai",
          duration: 2,
          cost: 14000,
        }),
      });
      expect((await failure(registrar.quote("shopapp.ai", 1))).message).toContain("2 years");
      expect((await registrar.quote("shopapp.ai", 2)).price).toEqual(usd(140));
    });

    it("refuses invalid years before calling Porkbun", async () => {
      const { registrar, calls } = setup({});
      expect((await failure(registrar.quote("shopapp.dev", 0))).code).toBe("INVALID_INPUT");
      expect(calls).toHaveLength(0);
    });

    it("refuses premium, taken and website-only names plainly", async () => {
      const { registrar } = setup({
        "POST /domain/checkDomain/rich.dev": ok({ response: availability({ premium: "yes" }) }),
        "POST /domain/checkDomain/taken.dev": ok({ response: availability({ avail: "no" }) }),
        "POST /domain/checkDomain/shopapp.us": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "GET /domain/getRegistrationRequirements/us": ok({
          tld: "us",
          apiRegisterable: false,
          notApiRegisterableReason: "The .us registry needs nexus information.",
        }),
      });
      const premium = await failure(registrar.quote("rich.dev", 1));
      expect(premium.code).toBe("PHASE_PRECONDITION");
      expect(premium.message).toContain("premium");
      expect(premium.hint).toContain("opscrew domain connect rich.dev");
      const taken = await failure(registrar.quote("taken.dev", 1));
      expect(taken.message).toContain("not available");
      const us = await failure(registrar.quote("shopapp.us", 1));
      expect(us.message).toContain("nexus");
      expect(us.hint).toContain("opscrew domain connect shopapp.us");
    });

    it("stops before the approval when the credit or the spend limit does not cover it", async () => {
      const { registrar } = setup({
        "POST /domain/checkDomain/shopapp.dev": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": ok({
          dryRun: true,
          wouldSucceed: false,
          domain: "shopapp.dev",
          cost: 973,
          balance: 100,
          sufficientFunds: false,
          shortfall: 873,
        }),
      });
      const error = await failure(registrar.quote("shopapp.dev", 1));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("$9.73");
      expect(error.message).toContain("$1.00");
      expect(error.hint).toContain("https://porkbun.com/account/credit");
    });
  });

  describe("register", () => {
    const quote: RegistrationQuote = { price: usd(9.73), renewal: usd(10.37) };
    const request = {
      domain: "ShopApp.dev",
      years: 1,
      autoRenew: true,
      privacy: true,
      quote,
      idempotencyKey: "purchase-record-key",
    };

    it("requires an approved USD quote and sends nothing without one", async () => {
      const { registrar, calls } = setup({});
      const { quote: _q, ...withoutQuote } = request;
      const missing = await failure(registrar.register(withoutQuote));
      expect(missing.code).toBe("INVALID_INPUT");
      expect(missing.message).toContain("quote");
      const euro = await failure(
        registrar.register({ ...request, quote: { price: { amount: 9, currency: "EUR" } } }),
      );
      expect(euro.code).toBe("INVALID_INPUT");
      expect(calls).toHaveLength(0);
    });

    it("refuses years other than the registry minimum and sends nothing", async () => {
      const { registrar, calls } = setup({
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
      });
      const two = await failure(registrar.register({ ...request, years: 2 }));
      expect(two.code).toBe("INVALID_INPUT");
      expect(two.message).toContain("1 year");
      const half = await failure(registrar.register({ ...request, years: 0.5 }));
      expect(half.code).toBe("INVALID_INPUT");
      expect(calls.some((c) => c.path.startsWith("/domain/create"))).toBe(false);
    });

    it("waits out Porkbun's one-create-per-second limit after a fresh quote", async () => {
      const { registrar, calls, clock } = setup({
        "POST /domain/checkDomain/shopapp.dev": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": [
          ok({ dryRun: true, wouldSucceed: true, domain: "shopapp.dev", duration: 1, cost: 973 }),
          ok({ domain: "shopapp.dev", cost: 973, orderId: 1 }),
        ],
        "POST /domain/updateAutoRenew/shopapp.dev": ok({
          results: { "shopapp.dev": { status: "SUCCESS" } },
        }),
      });
      const fresh = await registrar.quote("shopapp.dev", 1);
      clock.time += 300;
      await registrar.register({ ...request, quote: fresh });
      expect(clock.sleeps).toEqual([700]);
      expect(calls.filter((c) => c.path === "/domain/create/shopapp.dev")).toHaveLength(2);
    });

    it("does not wait when a second has passed since the quote", async () => {
      const { registrar, clock } = setup({
        "POST /domain/checkDomain/shopapp.dev": ok({ response: availability() }),
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": [
          ok({ dryRun: true, wouldSucceed: true, domain: "shopapp.dev", duration: 1, cost: 973 }),
          ok({ domain: "shopapp.dev", cost: 973, orderId: 1 }),
        ],
        "POST /domain/updateAutoRenew/shopapp.dev": ok({
          results: { "shopapp.dev": { status: "SUCCESS" } },
        }),
      });
      const fresh = await registrar.quote("shopapp.dev", 1);
      clock.time += 1500;
      await registrar.register({ ...request, quote: fresh });
      expect(clock.sleeps).toEqual([]);
    });

    it("buys once with the quoted cost and the purchase key, then sets auto-renew", async () => {
      const { registrar, calls } = setup({
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": ok({ domain: "shopapp.dev", cost: 973, orderId: 1 }),
        "POST /domain/updateAutoRenew/shopapp.dev": ok({
          results: { "shopapp.dev": { status: "SUCCESS" } },
        }),
      });
      const status = await registrar.register(request);
      expect(status).toEqual({ domain: "shopapp.dev", state: "succeeded" });
      const create = calls.filter((c) => c.path === "/domain/create/shopapp.dev");
      expect(create).toHaveLength(1);
      expect(create[0]?.body).toEqual({ cost: 973, agreeToTerms: "yes", whoisPrivacy: true });
      expect(create[0]?.headers["Idempotency-Key"]).toBe("purchase-record-key");
      expect(calls.find((c) => c.path.startsWith("/domain/updateAutoRenew"))?.body).toEqual({
        status: "on",
      });
    });

    it("uses a fresh idempotency key when the request has none", async () => {
      const { registrar, calls } = setup({
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": ok({ domain: "shopapp.dev", cost: 973, orderId: 1 }),
        "POST /domain/updateAutoRenew/shopapp.dev": ok({
          results: { "shopapp.dev": { status: "SUCCESS" } },
        }),
      });
      const { idempotencyKey: _k, ...rest } = request;
      await registrar.register({ ...rest, privacy: false, autoRenew: false });
      const create = calls.find((c) => c.path === "/domain/create/shopapp.dev");
      expect(create?.headers["Idempotency-Key"]).toBe("uuid-1");
      expect(create?.body?.whoisPrivacy).toBe(false);
      expect(calls.find((c) => c.path.startsWith("/domain/updateAutoRenew"))?.body).toEqual({
        status: "off",
      });
    });

    it("keeps a successful purchase successful when auto-renew cannot be set", async () => {
      const { registrar } = setup({
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": ok({ domain: "shopapp.dev", cost: 973, orderId: 1 }),
        "POST /domain/updateAutoRenew/shopapp.dev": err(403, "INSUFFICIENT_SCOPE", "No scope.", {
          requiredScope: "domains",
        }),
      });
      const status = await registrar.register(request);
      expect(status.state).toBe("succeeded");
      expect(status.message).toContain("auto-renew");
      expect(status.message).toContain(PORKBUN_DASHBOARD_URL);
    });

    it("passes ambiguous answers on as 'may still have started'", async () => {
      const { registrar, calls } = setup({
        "GET /domain/getRegistrationRequirements/dev": comRequirements,
        "POST /domain/create/shopapp.dev": err(500, "ORDER_FAILED", "Oops."),
      });
      const error = await failure(registrar.register(request));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("may still have started");
      expect(calls.filter((c) => c.path.startsWith("/domain/create"))).toHaveLength(1);
    });
  });

  it("reports the registration status from the account's domains", async () => {
    const { registrar } = setup({
      "GET /domain/get/shopapp.dev": ok({ domain: { domain: "shopapp.dev", autoRenew: 1 } }),
      "GET /domain/get/absent.dev": err(404, "DOMAIN_NOT_FOUND", "Not found."),
    });
    expect(await registrar.registrationStatus("ShopApp.dev")).toEqual({
      domain: "shopapp.dev",
      state: "succeeded",
    });
    expect(await registrar.registrationStatus("absent.dev")).toBeUndefined();
    expect(await registrar.ownsDomain("shopapp.dev")).toBe(true);
    expect(await registrar.ownsDomain("absent.dev")).toBe(false);
  });

  it("maps domain details and changes auto-renew", async () => {
    const { registrar, calls } = setup({
      "GET /domain/get/shopapp.dev": [
        ok({
          domain: {
            domain: "shopapp.dev",
            createDate: "2026-10-13 10:00:00",
            expireDate: "2027-10-13 10:00:00",
            autoRenew: 0,
            securityLock: 1,
            whoisPrivacy: 1,
          },
        }),
        ok({ domain: { domain: "shopapp.dev", autoRenew: 1 } }),
      ],
      "POST /domain/updateAutoRenew/shopapp.dev": ok({
        results: { "shopapp.dev": { status: "SUCCESS" } },
      }),
    });
    expect(await registrar.getDomain("shopapp.dev")).toEqual({
      domain: "shopapp.dev",
      registrar: "porkbun",
      createdAt: "2026-10-13T10:00:00.000Z",
      expiresAt: "2027-10-13T10:00:00.000Z",
      autoRenew: false,
      locked: true,
      privacy: true,
    });
    const updated = await registrar.setAutoRenew("shopapp.dev", true);
    expect(updated).toMatchObject({ registrar: "porkbun", autoRenew: true });
    expect(calls.find((c) => c.path.startsWith("/domain/updateAutoRenew"))?.body).toEqual({
      status: "on",
    });
  });

  it("reads and sets nameservers", async () => {
    const { registrar, calls } = setup({
      "POST /domain/getNs/shopapp.dev": ok({ ns: ["A.NS.PORKBUN.COM"] }),
      "POST /domain/updateNs/shopapp.dev": ok(),
    });
    expect(await registrar.getNameservers("shopapp.dev")).toEqual(["a.ns.porkbun.com"]);
    await registrar.setNameservers("shopapp.dev", [
      "ada.ns.cloudflare.com",
      "bob.ns.cloudflare.com",
    ]);
    expect(calls[1]?.body).toEqual({ ns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
  });

  it("lists records only when Porkbun hosts the DNS, as FQDNs with priorities", async () => {
    const { registrar, calls } = setup({
      "POST /domain/getNs/shopapp.dev": ok({
        ns: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"],
      }),
      "POST /domain/getNs/elsewhere.dev": ok({ ns: ["ns1.example-dns.net"] }),
      "POST /dns/retrieve/shopapp.dev": ok({
        records: [
          {
            id: "1",
            name: "shopapp.dev",
            type: "MX",
            content: "mx.mail.dev",
            ttl: "600",
            prio: "10",
          },
          { id: "2", name: "WWW.shopapp.dev.", type: "CNAME", content: "shopapp.dev", ttl: "600" },
          {
            id: "3",
            name: "shopapp.dev",
            type: "TXT",
            content: "v=spf1 -all",
            ttl: "600",
            prio: "0",
          },
          {
            id: "4",
            name: "_sip._tcp.shopapp.dev",
            type: "SRV",
            content: "5 5060 sip.shopapp.dev",
            ttl: "600",
            prio: "20",
          },
        ],
      }),
    });
    expect(await registrar.listRecords("shopapp.dev")).toEqual([
      { type: "MX", name: "shopapp.dev", content: "mx.mail.dev", ttl: 600, priority: 10 },
      { type: "CNAME", name: "www.shopapp.dev", content: "shopapp.dev", ttl: 600 },
      { type: "TXT", name: "shopapp.dev", content: "v=spf1 -all", ttl: 600 },
      {
        type: "SRV",
        name: "_sip._tcp.shopapp.dev",
        content: "5 5060 sip.shopapp.dev",
        ttl: 600,
        priority: 20,
      },
    ]);
    expect(await registrar.listRecords("elsewhere.dev")).toBeUndefined();
    expect(calls.some((c) => c.path === "/dns/retrieve/elsewhere.dev")).toBe(false);
  });

  it("lists, adds and removes DS records", async () => {
    const { registrar, calls } = setup({
      "POST /dns/getDnssecRecords/shopapp.dev": ok({
        records: { "2371": { keyTag: "2371", alg: "13", digestType: "2", digest: "AB12" } },
      }),
      "POST /dns/createDnssecRecord/shopapp.dev": ok(),
      "POST /dns/deleteDnssecRecord/shopapp.dev/2371": ok(),
    });
    const ds = { keyTag: 2371, algorithm: 13, digestType: 2, digest: "AB12" };
    expect(await registrar.listDsRecords("shopapp.dev")).toEqual([ds]);
    await registrar.addDsRecord("shopapp.dev", ds);
    await registrar.removeDsRecord("shopapp.dev", 2371);
    expect(calls.map((c) => c.path)).toEqual([
      "/dns/getDnssecRecords/shopapp.dev",
      "/dns/createDnssecRecord/shopapp.dev",
      "/dns/deleteDnssecRecord/shopapp.dev/2371",
    ]);
  });

  describe("accountCheck", () => {
    it("lists what full access allows, with the balance", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, account: "alice", scopes: ["full"] }),
        "GET /account/balance": ok({ balance: 4027 }),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(true);
      expect(check.message).toContain("alice");
      expect(check.message).toContain("buying domains");
      expect(check.message).toContain("nameservers");
      expect(check.fix).toBeUndefined();
      expect(check.balance).toEqual(usd(40.27));
    });

    it("needs only purchase and domains beyond read (never dns)", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, scopes: ["read", "purchase", "domains"] }),
        "GET /account/balance": ok({ balance: 0 }),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(true);
      expect(check.fix).toBeUndefined();
      expect(check.message).not.toContain("do not allow");
    });

    it("names missing permissions plainly and where to change them; without domains it is not ok", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, account: "alice", scopes: ["read", "dns"] }),
        "GET /account/balance": err(500, "X", "down"),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(false);
      expect(check.message).toContain("purchase");
      expect(check.message).toContain("domains");
      expect(check.message).toContain(
        "OpsCrew needs the domains permission to point a domain at Cloudflare.",
      );
      expect(check.fix).toContain("https://porkbun.com/account/api");
      expect(check.fix).toContain("purchase");
      expect(check.fix).not.toContain("dns");
      expect(check.balance).toBeUndefined();
    });

    it("is not ok without the domains permission, naming it in the fix", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, scopes: ["read", "purchase"] }),
        "GET /account/balance": ok({ balance: 500 }),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(false);
      expect(check.message).toContain(
        "They do not allow changing nameservers, auto-renew and DNSSEC (the domains permission).",
      );
      expect(check.fix).toBe(
        "Give the key the domains permission at https://porkbun.com/account/api (the gear icon next to the key), or create a key that has it.",
      );
    });

    it("stays ok without only the purchase permission, with the fix", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, scopes: ["read", "domains"] }),
        "GET /account/balance": ok({ balance: 500 }),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(true);
      expect(check.message).toContain(
        "They do not allow buying domains (the purchase permission).",
      );
      expect(check.message).not.toContain("OpsCrew needs the domains permission");
      expect(check.fix).toContain("Give the key the purchase permission");
      expect(check.balance).toEqual(usd(5));
    });

    it("says when Porkbun does not report the key's permissions", async () => {
      const { registrar } = setup({
        "POST /ping": ok({ credentialsValid: true, account: "alice" }),
        "GET /account/balance": ok({ balance: 0 }),
      });
      const check = await registrar.accountCheck();
      expect(check.message).toContain("did not say which permissions");
      expect(check.fix).toContain("https://porkbun.com/account/api");
    });

    it("says so for sandbox keys", async () => {
      const { registrar } = setup(
        {
          "POST /ping": ok({ credentialsValid: true, account: "alice", scopes: ["full"] }),
          "GET /account/balance": ok({ balance: 100000 }),
        },
        `pk1_sb_${API_KEY.slice(4)}`,
      );
      expect((await registrar.accountCheck()).message).toContain("sandbox");
    });

    it("reports keys Porkbun does not accept as not ok", async () => {
      const { registrar } = setup({
        "POST /ping": err(400, "INVALID_API_KEYS_001", "Invalid API key."),
      });
      const check = await registrar.accountCheck();
      expect(check.ok).toBe(false);
      expect(check.fix).toContain("PORKBUN_API_KEY");
      expect(`${check.message} ${check.fix}`).not.toContain(API_KEY);
    });
  });
});
