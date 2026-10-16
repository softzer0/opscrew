import { inspect } from "node:util";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { isPorkbunSandboxKey, PORKBUN_DASHBOARD_URL, PorkbunClient } from "./index";
import { availability, err, type FakeRoute, fakePorkbun, ok } from "./test-helpers";

const API_KEY = fakeSecret("porkbun-api-key");
const SECRET = fakeSecret("porkbun-secret-key");

function client(routes: Record<string, FakeRoute | FakeRoute[]>, sleeps: number[] = []) {
  const fake = fakePorkbun(routes);
  const porkbun = new PorkbunClient({
    apiKey: API_KEY,
    secretApiKey: SECRET,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    randomUUID: () => "write-key-1",
  });
  return { porkbun, calls: fake.calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    const text = `${(error as Error).message} ${(error as OpsCrewError).hint ?? ""} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
    return error as OpsCrewError;
  }
  throw new Error("expected a failure");
}

describe("isPorkbunSandboxKey", () => {
  it("recognises sandbox keys by their prefix", () => {
    const sandboxKey = `pk1_sb_${API_KEY.slice(4)}`;
    expect(isPorkbunSandboxKey(sandboxKey)).toBe(true);
    expect(isPorkbunSandboxKey(API_KEY)).toBe(false);
    const porkbun = new PorkbunClient({ apiKey: sandboxKey, secretApiKey: SECRET });
    expect(porkbun.sandbox).toBe(true);
    expect(new PorkbunClient({ apiKey: API_KEY, secretApiKey: SECRET }).sandbox).toBe(false);
  });
});

describe("PorkbunClient requests", () => {
  it("authenticates with headers and never puts the keys in the body", async () => {
    const { porkbun, calls } = client({
      "POST /ping": ok({ credentialsValid: true, account: "alice", scopes: ["full"], yourIp: "x" }),
    });
    const ping = await porkbun.ping();
    expect(ping).toEqual({ account: "alice", scopes: ["full"], scopesReported: true, yourIp: "x" });
    const call = calls[0];
    expect(call?.url).toBe("https://api.porkbun.com/api/json/v3/ping");
    expect(call?.headers["X-API-Key"]).toBe(API_KEY);
    expect(call?.headers["X-Secret-API-Key"]).toBe(SECRET);
    expect(call?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.stringify(call?.body)).not.toContain(API_KEY);
    expect(JSON.stringify(call?.body)).not.toContain(SECRET);
    expect(call?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("stops before any request when the keys are missing", async () => {
    const fake = fakePorkbun({});
    const porkbun = new PorkbunClient({ apiKey: "", secretApiKey: "", fetch: fake.fetch });
    const error = await failure(porkbun.ping());
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.hint).toContain("PORKBUN_API_KEY");
    expect(error.hint).not.toMatch(/PORKBUN_[A-Z_]+:/);
    expect(fake.calls).toHaveLength(0);
  });

  it("checks a domain and reads its prices", async () => {
    const { porkbun, calls } = client({
      "POST /domain/checkDomain": ok({
        domains: { "shopapp.dev": availability({ minDuration: 2 }) },
      }),
    });
    const { results } = await porkbun.checkDomains(["ShopApp.DEV."]);
    expect(calls[0]?.body).toEqual({ domains: ["shopapp.dev"] });
    expect(results).toEqual([
      {
        domain: "shopapp.dev",
        available: true,
        premium: false,
        inYourAccount: false,
        idnLanguageRequired: false,
        priceCents: 973,
        renewalCents: 1037,
        minYears: 2,
      },
    ]);
  });

  it("checks in batches of at most 25, lower case and without duplicates", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `name${i}.com`);
    const answered = (list: string[]) =>
      Object.fromEntries(list.map((d) => [d, availability({ avail: "no" })]));
    const { porkbun, calls } = client({
      "POST /domain/checkDomain": [
        ok({ checked: 25, domains: answered(names.slice(0, 25)), unresolved: [], invalid: [] }),
        ok({
          checked: 4,
          domains: answered(names.slice(25, 29)),
          unresolved: ["name29.com"],
          invalid: [{ domain: "shopapp.notatld", reason: "Invalid domain" }],
        }),
      ],
    });
    const result = await porkbun.checkDomains([
      ...names.map((n) => n.toUpperCase()),
      "name0.com",
      "shopapp.notatld",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body?.domains).toHaveLength(25);
    expect(calls[1]?.body?.domains).toEqual([...names.slice(25), "shopapp.notatld"]);
    expect(calls[0]?.path).toBe("/domain/checkDomain");
    expect(result.results).toHaveLength(29);
    expect(result.results[0]).toMatchObject({ domain: "name0.com", available: false });
    expect(result.unresolved).toEqual(["name29.com"]);
    expect(result.invalid).toEqual([{ domain: "shopapp.notatld", reason: "Invalid domain" }]);
  });

  it("waits for Retry-After and retries a read after a rate limit", async () => {
    const { porkbun, calls, sleeps } = client({
      "POST /domain/getNs/example.com": [
        {
          ...err(429, "RATE_LIMIT_EXCEEDED", "Rate limit exceeded."),
          headers: { "Retry-After": "3" },
        },
        ok({ ns: ["Curitiba.ns.porkbun.com.", "fortaleza.ns.porkbun.com"] }),
      ],
    });
    expect(await porkbun.getNs("example.com")).toEqual([
      "curitiba.ns.porkbun.com",
      "fortaleza.ns.porkbun.com",
    ]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it("bounds the wait and gives up on a read after two retries", async () => {
    const limited = {
      ...err(429, "RATE_LIMIT_EXCEEDED", "Rate limit exceeded."),
      headers: { "Retry-After": "3600" },
    };
    const { porkbun, calls, sleeps } = client({ "POST /domain/getNs/example.com": limited });
    const error = await failure(porkbun.getNs("example.com"));
    expect(calls).toHaveLength(3);
    expect(sleeps.every((ms) => ms <= 30_000)).toBe(true);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("rate");
    expect(error.hint).toContain("minute");
  });

  it("retries a read Porkbun marks as retryable, and a network failure", async () => {
    const { porkbun, calls } = client({
      "POST /dns/getDnssecRecords/example.com": [
        err(500, "DNSSEC_INFO_UNAVAILABLE", "Registry did not answer.", {
          next_action: { type: "retry", hint: "Retry.", retryable: true },
        }),
        { error: new TypeError("fetch failed") },
        ok({ records: [] }),
      ],
    });
    expect(await porkbun.getDnssecRecords("example.com")).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("explains a missing key permission with Porkbun's hint and request id", async () => {
    const { porkbun } = client({
      "POST /domain/updateNs/example.com": err(
        403,
        "INSUFFICIENT_SCOPE",
        "This API key does not have the domains permission.",
        {
          requiredScope: "domains",
          keyScopes: ["read", "dns"],
          next_action: {
            type: "enable_setting",
            hint: "Add the domains permission to this key.",
            url: "https://porkbun.com/account/api",
            retryable: false,
          },
        },
      ),
    });
    const error = await failure(porkbun.updateNs("example.com", ["a.ns.cloudflare.com"]));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("domains");
    expect(error.message).toContain("req-err-1");
    expect(error.hint).toContain("https://porkbun.com/account/api");
    expect(error.hint).toContain("Add the domains permission to this key.");
  });

  it("names invalid keys plainly and never echoes them", async () => {
    const { porkbun } = client({
      "POST /ping": err(400, "INVALID_API_KEYS_001", `Invalid API key ${API_KEY} / ${SECRET}.`),
    });
    const error = await failure(porkbun.ping());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Porkbun did not accept the API keys");
    expect(error.hint).toContain("PORKBUN_SECRET_API_KEY");
  });

  it("treats scopes missing from /ping as unknown, not full access", async () => {
    const { porkbun } = client({ "POST /ping": ok({ credentialsValid: true }) });
    expect(await porkbun.ping()).toEqual({ scopes: [], scopesReported: false });
  });

  it("scrubs both keys from Porkbun's message and hint on an unknown error", async () => {
    const { porkbun } = client({
      "POST /domain/getNs/example.com": err(400, "SOMETHING_NEW", `Bad keys ${API_KEY} ${SECRET}`, {
        next_action: {
          type: "fix_request",
          hint: `Resend with ${API_KEY} and ${SECRET}.`,
          url: `https://porkbun.com/account/api?k=${SECRET}`,
        },
      }),
    });
    const error = await failure(porkbun.getNs("example.com"));
    expect(error.message).toContain("[redacted]");
    expect(error.hint).toContain("[redacted]");
  });

  it("explains domains without API access", async () => {
    const { porkbun } = client({
      "POST /dns/retrieve/example.com": err(400, "API_ACCESS_DISABLED", "API access disabled.", {
        account: "alice",
        next_action: { type: "enable_setting", hint: "Opt the domain in to API access." },
      }),
    });
    const error = await failure(porkbun.retrieveRecords("example.com"));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("API access");
    expect(error.message).toContain("example.com");
    expect(error.hint).toContain(PORKBUN_DASHBOARD_URL);
    expect(error.hint).toContain("Opt the domain in to API access.");
  });

  it("reports an unexpected answer plainly", async () => {
    const { porkbun } = client({ "POST /domain/getNs/example.com": ok({ ns: "nope" }) });
    const error = await failure(porkbun.getNs("example.com"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("unexpected");
  });

  it("refuses names that are not domains before calling Porkbun", async () => {
    const { porkbun, calls } = client({});
    const error = await failure(porkbun.getNs("not a domain/../x"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("PorkbunClient.createDomain", () => {
  const options = { costCents: 973, idempotencyKey: "purchase-key-1", whoisPrivacy: true };

  it("sends the cost in cents, the terms, privacy and an idempotency key", async () => {
    const { porkbun, calls } = client({
      "POST /domain/create/shopapp.dev": ok({
        domain: "shopapp.dev",
        cost: 973,
        orderId: 12345678,
        balance: 4027,
      }),
    });
    const created = await porkbun.createDomain("ShopApp.dev", options);
    expect(created).toEqual({
      domain: "shopapp.dev",
      costCents: 973,
      orderId: "12345678",
      balanceCents: 4027,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("purchase-key-1");
    expect(calls[0]?.body).toEqual({ cost: 973, agreeToTerms: "yes", whoisPrivacy: true });
  });

  it("previews with a dry run, without the purchase's idempotency key", async () => {
    const { porkbun, calls } = client({
      "POST /domain/create/shopapp.dev": ok({
        dryRun: true,
        wouldSucceed: false,
        operation: "registration",
        domain: "shopapp.dev",
        duration: 1,
        cost: 973,
        balance: 500,
        sufficientFunds: false,
        shortfall: 473,
        message: "Not enough credit.",
      }),
    });
    const preview = await porkbun.previewDomain("shopapp.dev");
    expect(preview).toEqual({
      domain: "shopapp.dev",
      costCents: 973,
      years: 1,
      wouldSucceed: false,
      balanceCents: 500,
      sufficientFunds: false,
      shortfallCents: 473,
      message: "Not enough credit.",
    });
    expect(calls[0]?.headers["Idempotency-Key"]).toBeUndefined();
    expect(calls[0]?.body).toEqual({ cost: 0, agreeToTerms: "yes", dryRun: true });
  });

  it("refuses a purchase without an idempotency key or with a bad cost", async () => {
    const { porkbun, calls } = client({});
    const noKey = await failure(
      porkbun.createDomain("shopapp.dev", { costCents: 973, idempotencyKey: "" }),
    );
    expect(noKey.code).toBe("INVALID_INPUT");
    const badCost = await failure(
      porkbun.createDomain("shopapp.dev", { costCents: 9.73, idempotencyKey: "k" }),
    );
    expect(badCost.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  const rejections: [string, FakeRoute, string, string][] = [
    [
      "insufficient funds",
      err(400, "INSUFFICIENT_FUNDS", "Not enough credit.", {
        cost: 973,
        balance: 500,
        shortfall: 473,
        next_action: {
          type: "add_funds",
          hint: "Add credit.",
          url: "https://porkbun.com/account/credit",
        },
      }),
      "PHASE_PRECONDITION",
      "$5.00",
    ],
    [
      "the monthly spend limit",
      err(400, "MONTHLY_SPEND_LIMIT_EXCEEDED", "Monthly limit.", { limitSource: "default" }),
      "PHASE_PRECONDITION",
      "monthly",
    ],
    ["an order over $100", err(400, "ORDER_TOO_LARGE", "Too large."), "PHASE_PRECONDITION", "$100"],
    [
      "a changed price",
      err(400, "COST_MISMATCH", "Cost must be 1099."),
      "PHASE_PRECONDITION",
      "price",
    ],
    [
      "a key without the purchase permission",
      err(403, "INSUFFICIENT_SCOPE", "Missing scope.", {
        requiredScope: "purchase",
        keyScopes: ["read"],
      }),
      "CREDENTIALS_INVALID",
      "purchase",
    ],
    [
      "API access turned off",
      err(403, "API_ACCESS_DISABLED", "API access disabled."),
      "PHASE_PRECONDITION",
      "API access",
    ],
    [
      "a rate limit",
      {
        ...err(429, "RATE_LIMIT_EXCEEDED", "Rate limit exceeded.", {
          next_action: { type: "wait_and_retry", retryable: true },
        }),
        headers: { "Retry-After": "1" },
      },
      "PHASE_PRECONDITION",
      "rate limit",
    ],
  ];

  for (const [name, route, code, text] of rejections) {
    it(`reports ${name} as a clear rejection (nothing bought, not retried)`, async () => {
      const { porkbun, calls, sleeps } = client({ "POST /domain/create/shopapp.dev": route });
      const error = await failure(porkbun.createDomain("shopapp.dev", options));
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
      expect(error.message).toContain("Nothing was bought");
      expect(error.message).not.toContain("may still");
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });
  }

  it("scrubs both keys from a purchase rejection and from an ambiguous answer", async () => {
    const echo = {
      next_action: { type: "fix_request", hint: `Keys ${API_KEY} ${SECRET}`, url: SECRET },
    };
    const rejected = client({
      "POST /domain/create/shopapp.dev": err(
        400,
        "COST_MISMATCH",
        `Cost wrong for ${API_KEY}/${SECRET}`,
        echo,
      ),
    });
    const rejection = await failure(rejected.porkbun.createDomain("shopapp.dev", options));
    expect(rejection.message).toContain("Nothing was bought");
    expect(rejection.hint).toContain("[redacted]");
    const unclear = client({
      "POST /domain/create/shopapp.dev": err(409, `CODE_${SECRET}`, `In flight ${API_KEY}`, echo),
    });
    const ambiguous = await failure(unclear.porkbun.createDomain("shopapp.dev", options));
    expect(ambiguous.message).toContain("may still have started");
  });

  it("states the balance and the shortfall for insufficient funds", async () => {
    const { porkbun } = client({ "POST /domain/create/shopapp.dev": rejections[0]?.[1] ?? {} });
    const error = await failure(porkbun.createDomain("shopapp.dev", options));
    expect(error.message).toContain("$9.73");
    expect(error.message).toContain("$4.73");
    expect(error.hint).toContain("https://porkbun.com/account/credit");
  });

  const ambiguous: [string, FakeRoute][] = [
    ["a network failure", { error: new TypeError("fetch failed") }],
    ["a timeout", { error: new DOMException("The operation timed out.", "TimeoutError") }],
    ["a server error", err(500, "ORDER_FAILED", "Internal error.")],
    ["a bare 502", { status: 502, text: "<html>Bad gateway</html>" }],
    ["an unreadable success", { status: 200, text: "not json" }],
    ["a success without an order", ok({ domain: "shopapp.dev" })],
    ["an idempotency key in use", err(409, "IDEMPOTENCY_KEY_IN_USE", "In flight.")],
    ["an idempotency key mismatch", err(409, "IDEMPOTENCY_KEY_MISMATCH", "Different body.")],
    ["an unknown error code", err(400, "SOMETHING_NEW", "Unknown.")],
    ["a 4xx without a Porkbun answer", { status: 403, text: "Forbidden" }],
  ];

  for (const [name, route] of ambiguous) {
    it(`reports ${name} as ambiguous (may still have started), never retried`, async () => {
      const { porkbun, calls, sleeps } = client({ "POST /domain/create/shopapp.dev": route });
      const error = await failure(porkbun.createDomain("shopapp.dev", options));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("may still have started");
      expect(error.message).not.toContain("Nothing was bought");
      expect(error.hint).toContain(PORKBUN_DASHBOARD_URL);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });
  }
});

describe("PorkbunClient domains", () => {
  it("reads one domain and treats DOMAIN_NOT_FOUND as absent", async () => {
    const { porkbun, calls } = client({
      "GET /domain/get/example.com": ok({
        domain: {
          domain: "Example.com",
          status: "ACTIVE",
          tld: "com",
          createDate: "2024-01-02 03:04:05",
          expireDate: "2027-01-02 03:04:05",
          securityLock: "1",
          whoisPrivacy: 1,
          autoRenew: 0,
          apiAccess: 1,
        },
      }),
      "GET /domain/get/absent.com": err(404, "DOMAIN_NOT_FOUND", "Not in account.", {
        account: "alice",
      }),
      "GET /domain/get/broken.com": err(404, "SOMETHING_ELSE", "Not here."),
    });
    expect(await porkbun.getDomain("example.com")).toEqual({
      domain: "example.com",
      status: "ACTIVE",
      createdAt: "2024-01-02T03:04:05.000Z",
      expiresAt: "2027-01-02T03:04:05.000Z",
      autoRenew: false,
      locked: true,
      whoisPrivacy: true,
      apiAccess: true,
    });
    expect(calls[0]?.headers["X-API-Key"]).toBe(API_KEY);
    expect(calls[0]?.body).toBeUndefined();
    expect(await porkbun.getDomain("absent.com")).toBeUndefined();
    const error = await failure(porkbun.getDomain("broken.com"));
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("updates auto-renew with an idempotency key and reports a per-domain failure", async () => {
    const { porkbun, calls } = client({
      "POST /domain/updateAutoRenew/example.com": ok({
        results: { "example.com": { status: "SUCCESS", message: "ok" } },
      }),
      "POST /domain/updateAutoRenew/other.com": ok({
        results: { "other.com": { status: "ERROR", message: "Domain is locked." } },
      }),
    });
    await porkbun.updateAutoRenew("example.com", true);
    expect(calls[0]?.body).toEqual({ status: "on" });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("write-key-1");
    const error = await failure(porkbun.updateAutoRenew("other.com", false));
    expect(error.message).toContain("Domain is locked");
  });

  it("sets nameservers, reads records and the TLD requirements", async () => {
    const { porkbun, calls } = client({
      "POST /domain/updateNs/example.com": ok(),
      "POST /dns/retrieve/example.com": ok({
        records: [
          {
            id: "1",
            name: "example.com",
            type: "MX",
            content: "mail.example.com",
            ttl: "600",
            prio: "10",
          },
          {
            id: "2",
            name: "www.example.com",
            type: "A",
            content: "1.2.3.4",
            ttl: "300",
            prio: null,
          },
        ],
      }),
      "GET /domain/getRegistrationRequirements/us": ok({
        tld: "us",
        apiRegisterable: false,
        registrationDurationYears: 1,
        notApiRegisterableReason: "Needs nexus data.",
      }),
    });
    await porkbun.updateNs("example.com", ["A.NS.Cloudflare.com.", "b.ns.cloudflare.com"]);
    expect(calls[0]?.body).toEqual({ ns: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("write-key-1");
    expect(await porkbun.retrieveRecords("example.com")).toEqual([
      { id: "1", name: "example.com", type: "MX", content: "mail.example.com", ttl: 600, prio: 10 },
      { id: "2", name: "www.example.com", type: "A", content: "1.2.3.4", ttl: 300 },
    ]);
    expect(await porkbun.registrationRequirements(".US")).toEqual({
      tld: "us",
      apiRegisterable: false,
      termYears: 1,
      reason: "Needs nexus data.",
    });
  });

  it("refuses an empty nameserver list", async () => {
    const { porkbun, calls } = client({});
    const error = await failure(porkbun.updateNs("example.com", []));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("reads, creates and deletes DS records", async () => {
    const { porkbun, calls } = client({
      "POST /dns/getDnssecRecords/example.com": ok({
        records: {
          "2371": { keyTag: "2371", alg: "13", digestType: "2", digest: "ABCDEF" },
          "999": { keyTag: "999", alg: "8", pubKey: "only key data" },
        },
      }),
      "POST /dns/createDnssecRecord/example.com": ok(),
      "POST /dns/deleteDnssecRecord/example.com/2371": ok(),
    });
    expect(await porkbun.getDnssecRecords("example.com")).toEqual([
      { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ABCDEF" },
    ]);
    await porkbun.createDnssecRecord("example.com", {
      keyTag: 2371,
      algorithm: 13,
      digestType: 2,
      digest: "abcdef",
    });
    expect(calls[1]?.body).toEqual({
      keyTag: "2371",
      alg: "13",
      digestType: "2",
      digest: "abcdef",
    });
    expect(calls[1]?.headers["Idempotency-Key"]).toBe("write-key-1");
    await porkbun.deleteDnssecRecord("example.com", 2371);
    expect(calls[2]?.path).toBe("/dns/deleteDnssecRecord/example.com/2371");
  });

  it("reads the account balance", async () => {
    const { porkbun, calls } = client({
      "GET /account/balance": ok({ balance: 4027, display: "$40.27" }),
    });
    expect(await porkbun.balance()).toBe(4027);
    expect(calls[0]?.method).toBe("GET");
  });
});
