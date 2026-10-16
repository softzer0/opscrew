import { rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  buyable,
  domainProject,
  domainTestPlan,
  TOKEN,
  testRequirements,
  usd,
  visibleText,
} from "./__fixtures__/fakes";
import { buyDomain } from "./buy";
import { SANDBOX_ZONES } from "./services";
import type { BuyDomainResult, DomainSetUpResult } from "./types";

const DOMAIN = "shopapp.com";

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function recordFile(deps: { paths: { projectHomeDir: string } }): string {
  return join(deps.paths.projectHomeDir, "domain-purchase.json");
}

async function readRecord(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

/** Narrows a result to a set-up domain (fails the test on any other outcome). */
function setUp(result: BuyDomainResult): DomainSetUpResult {
  if (result.outcome !== "set-up")
    throw new Error(`expected a set-up domain, got ${result.outcome}`);
  return result;
}

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A record an earlier run wrote right before `register` (no outcome yet). */
const earlierRecord = (requestedAt: string, extra: Record<string, unknown> = {}) => ({
  domain: DOMAIN,
  accountId: "acc-1",
  requestedAt,
  years: 1,
  autoRenew: true,
  total: usd(10.44),
  ...extra,
});

describe("buyDomain: the purchase", () => {
  it("checks, asks with the typed domain, buys once, waits, sets the domain up and records it", async () => {
    const project = await domainProject({
      plan: domainTestPlan(),
      requirements: testRequirements(),
    });
    const { cf } = project;
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: "ShopApp.com", services }));

    // SC-601: the approval (typed domain) comes before the one and only purchase
    expect(cf.events).toEqual([
      "accounts",
      `status ${DOMAIN}`,
      `getDomain ${DOMAIN}`,
      "extension com",
      `check ${DOMAIN}`,
      "approval domain-purchase",
      `check ${DOMAIN}`,
      `status ${DOMAIN}`,
      `register ${DOMAIN}`,
      `status ${DOMAIN}`,
      `status ${DOMAIN}`,
      `createZone acc-1 ${DOMAIN}`,
      `dnssecEnabled zone-${DOMAIN}`,
      `enableDnssec zone-${DOMAIN}`,
      `getDomain ${DOMAIN}`,
    ]);
    expect(cf.registerCalls).toEqual([
      {
        accountId: "acc-1",
        request: { domain: DOMAIN, years: 1, autoRenew: true, privacy: true },
      },
    ]);
    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "domain-purchase",
      title: "Buy shopapp.com for $10.44 (1 year)",
      confirmPhrase: DOMAIN,
    });
    for (const line of [
      "Years: 1",
      "First year: $10.44",
      "Renewal: $10.44 per year",
      "Charged now: $10.44",
      "Auto-renew: on",
      "up to 30 days before the domain expires",
      "WHOIS privacy: on",
      "DNSSEC: on",
      "Cloudflare zone: created for shopapp.com in this account",
      "Cloudflare account: Shop (acc-1)",
      "default contact is used",
      "After the purchase, OpsCrew records the domain in the project files:",
      "opscrew/requirements.yaml: domain shopapp.com, dnsProvider cloudflare.",
      // item 9: the proxy and port changes are named, with when they take effect
      "dns.proxied becomes true",
      "security.httpAllowedFrom becomes cloudflare",
      "takes effect on the next `opscrew dns` or `opscrew provision`",
      "Domain purchases cannot be refunded.",
    ]) {
      expect(approval?.details).toContain(line);
    }

    expect(result).toMatchObject({
      zoneId: `zone-${DOMAIN}`,
      total: usd(10.44),
      alreadyRegistered: false,
      recorded: { plan: true, requirements: true },
      domain: { domain: DOMAIN, autoRenew: true, expiresAt: "2027-10-11T12:00:05Z" },
    });
    expect(result.next.join("\n")).toContain("opscrew provision");
    // a token limited to the zones that existed before does not cover the new zone
    expect(result.next).toHaveLength(1);
    expect(result.next[0]).toContain(
      "If your Cloudflare token is limited to specific zones, first add the zone shopapp.com to it at https://dash.cloudflare.com/profile/api-tokens",
    );
    expect(result.next[0]).toContain("Zone → DNS → Edit");
    expect(deps.reporter.text()).toContain("DNSSEC on.");
    expect(cf.dnssec.has(`zone-${DOMAIN}`)).toBe(true);
    expect(cf.autoRenewCalls).toEqual([]);

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toEqual({
      provider: "cloudflare",
      domain: DOMAIN,
      zone: DOMAIN,
      proxied: true,
      www: false,
      registration: {
        registrar: "cloudflare",
        registeredAt: "2026-10-11T12:00:05.000Z",
        expiresAt: "2027-10-11T12:00:05.000Z",
        autoRenew: true,
        privacy: true,
        dnssec: true,
      },
    });
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    expect(requirements).toMatchObject({ domain: DOMAIN, dnsProvider: "cloudflare" });
    expect(await exists(recordFile(deps))).toBe(false);

    // audited: the decision (domain and price), the purchase and the result; never the token
    const audit = deps.audit.entries;
    expect(audit.find((e) => e.kind === "approval")).toMatchObject({
      action: "domain-purchase",
      decision: "approved",
      detail: expect.stringContaining("Buy shopapp.com for $10.44"),
    });
    expect(audit.find((e) => e.action === "register domain")).toMatchObject({
      kind: "provider-call",
      target: DOMAIN,
      detail: expect.stringContaining("$10.44"),
    });
    expect(audit.find((e) => e.action === "domain purchase")?.detail).toContain(
      "bought (approved price $10.44)",
    );
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("bounds several years by years × the higher price and keeps auto-renew off when asked", async () => {
    const project = await domainProject();
    project.cf.checks.set(DOMAIN, buyable(DOMAIN, 10.44, 12.5));
    const { deps, handler, services } = await project.run();

    const result = setUp(
      await buyDomain(deps, { domain: DOMAIN, years: 2, autoRenew: false, services }),
    );

    expect(handler.requests[0]?.title).toBe("Buy shopapp.com for at most $25.00 (2 years)");
    expect(handler.requests[0]?.details).toContain(
      "Charged now: at most $25.00 (2 × $12.50, the higher of the first-year and renewal prices",
    );
    expect(handler.requests[0]?.details).toContain("Auto-renew: off");
    expect(project.cf.registerCalls[0]?.request).toEqual({
      domain: DOMAIN,
      years: 2,
      autoRenew: false,
      privacy: true,
    });
    expect(result.total).toEqual(usd(25));
    expect(result.domain.autoRenew).toBe(false);
    // no project files: nothing recorded, the next step starts the project
    expect(result.recorded).toEqual({ plan: false, requirements: false });
    expect(result.next.join("\n")).toContain("opscrew interview");
  });

  it("polls a registration Cloudflare answered with in_progress until it explicitly succeeded", async () => {
    const project = await domainProject();
    project.cf.firstState = "in_progress";
    project.cf.progress = ["in_progress", "pending", "succeeded"];
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    expect(project.cf.count("status")).toBe(2 + 3);
    expect(project.cf.registerCalls).toHaveLength(1);
    expect(project.cf.dnssec.size).toBe(1);
  });

  it("reuses the account's zone and skips DNSSEC when it is already on", async () => {
    const project = await domainProject();
    project.cf.zones.set(DOMAIN, { id: "zone-existing", name: DOMAIN });
    project.cf.dnssec.add("zone-existing");
    const { deps, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(result.zoneId).toBe("zone-existing");
    expect(project.cf.count("findZone")).toBe(0);
    expect(project.cf.count("enableDnssec")).toBe(0);
    expect(deps.audit.entries.some((e) => e.action === "enable DNSSEC")).toBe(false);
  });

  it("never claims DNSSEC with the registrar sandbox's stand-in zones, and still records the domain", async () => {
    const project = await domainProject({ plan: domainTestPlan() });
    const { deps, services } = await project.run();

    const result = setUp(
      await buyDomain(deps, { domain: DOMAIN, services: { ...services, zones: SANDBOX_ZONES } }),
    );

    expect(result.zoneId).toBe("sandbox");
    expect(project.cf.count("createZone")).toBe(0);
    expect(project.cf.count("enableDnssec")).toBe(0);
    expect(project.cf.registerCalls).toHaveLength(1);
    expect(deps.reporter.text()).not.toContain("DNSSEC on");
    expect(deps.reporter.text()).toContain("DNSSEC skipped");
    expect(deps.audit.entries.some((e) => e.action === "enable DNSSEC")).toBe(false);
    expect(deps.audit.entries.find((e) => e.action === "domain purchase")?.detail).toContain(
      "DNSSEC skipped",
    );
    expect(result.recorded.plan).toBe(true);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      zone: DOMAIN,
      registration: { registrar: "cloudflare", dnssec: false },
    });
  });

  it("records the registration in a plan written after the purchase on the next setup run", async () => {
    const project = await domainProject();
    const first = await project.run();
    setUp(await buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    const { deps, handler, services } = await project.run();
    await writeArtifact("plan", deps.paths.files.plan, domainTestPlan({ domain: DOMAIN }));

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(result.alreadyRegistered).toBe(true);
    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    expect(project.cf.registerCalls).toHaveLength(1);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      zone: DOMAIN,
      registration: { registrar: "cloudflare", autoRenew: true, dnssec: true },
    });
  });

  it("points a deployed app's next step at opscrew dns", async () => {
    const project = await domainProject({ plan: domainTestPlan({ deployed: true }) });
    const { deps, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(result.next.join("\n")).toContain("`opscrew dns`");
  });
});

describe("buyDomain: approval and price bound (SC-601)", () => {
  it("buys nothing when the purchase is refused", async () => {
    const plan = domainTestPlan();
    const project = await domainProject({ plan });
    const { deps, services } = await project.run({ answer: () => false });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("nothing was bought");
    expect(project.cf.count("register")).toBe(0);
    expect(await exists(recordFile(deps))).toBe(false);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
    expect(deps.audit.entries.find((e) => e.kind === "approval")).toMatchObject({
      action: "domain-purchase",
      decision: "refused",
    });
  });

  it("buys nothing when the typed name does not match the domain", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run({
      answer: () => ({ approved: true, confirmation: "shopapp.co" }),
    });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toContain("type shopapp.com exactly");
    expect(project.cf.count("register")).toBe(0);
  });

  it("stops before asking when the price is above --max-price, naming the currency", async () => {
    const project = await domainProject();
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, maxPrice: 10, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("10.44 USD");
    expect(error.message).toContain("maximum of 10.00 USD");
    expect(error.hint).toContain("--max-price to at least 10.44USD");
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("register")).toBe(0);

    const years = await caught(
      buyDomain(deps, { domain: DOMAIN, years: 2, maxPrice: { amount: 20.87 }, services }),
    );
    expect(years.message).toContain("up to 20.88 USD");
    expect(project.cf.count("register")).toBe(0);
  });

  it("stops when --max-price is in another currency than Cloudflare's quote", async () => {
    const project = await domainProject();
    const { deps, handler, services } = await project.run();

    const error = await caught(
      buyDomain(deps, { domain: DOMAIN, maxPrice: { amount: 50, currency: "EUR" }, services }),
    );

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("in USD");
    expect(error.message).toContain("50.00 EUR");
    expect(error.hint).toContain("--max-price 10.44USD");
    expect(handler.requests).toEqual([]);

    await buyDomain(deps, {
      domain: DOMAIN,
      maxPrice: { amount: 10.44, currency: "USD" },
      services,
    });
    expect(project.cf.registerCalls).toHaveLength(1);
  });

  it("refuses a run without a terminal and without --max-price, naming the exact command", async () => {
    const project = await domainProject();
    const { deps, handler, services } = await project.run({ interactive: false });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("10.44 USD");
    expect(error.hint).toContain(
      "`opscrew domain buy shopapp.com --confirm shopapp.com --max-price 10.44USD`",
    );
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("register")).toBe(0);

    project.cf.checks.set(DOMAIN, buyable(DOMAIN, 10.44, 12.5));
    const again = await caught(
      buyDomain(deps, { domain: DOMAIN, years: 2, autoRenew: false, account: "acc-1", services }),
    );
    expect(again.hint).toContain(
      "`opscrew domain buy shopapp.com --years 2 --no-auto-renew --account acc-1 --confirm shopapp.com --max-price 25.00USD`",
    );
  });

  it("buys in a run without a terminal when the price is within --max-price and the name is confirmed", async () => {
    const project = await domainProject();
    const { deps, handler, services } = await project.run({ interactive: false });

    await buyDomain(deps, { domain: DOMAIN, maxPrice: 10.44, services });

    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-purchase"]);
    expect(project.cf.registerCalls).toHaveLength(1);
  });

  it("stops when the price went up after the approval", async () => {
    const project = await domainProject();
    project.cf.checkOverride = (domain, call) =>
      call === 2 ? buyable(domain, 11.5, 10.44) : undefined;
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(handler.requests).toHaveLength(1);
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("11.50 USD");
    expect(error.message).toContain("Nothing was bought");
    expect(project.cf.count("register")).toBe(0);
    expect(await exists(recordFile(deps))).toBe(false);
  });

  it("stops when the renewal price went up after the approval", async () => {
    const project = await domainProject();
    project.cf.checkOverride = (domain, call) =>
      call === 2 ? buyable(domain, 10.44, 15) : undefined;
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(project.cf.count("register")).toBe(0);
  });

  it("stops when someone else took the name after the approval", async () => {
    const project = await domainProject();
    project.cf.checkOverride = (domain, call) =>
      call === 2 ? { domain, registrable: false, reason: "already registered" } : undefined;
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("already registered");
    expect(project.cf.count("register")).toBe(0);
  });

  it("does not buy when another run started a purchase while the user was deciding", async () => {
    const project = await domainProject();
    let file = "";
    const { deps, services } = await project.run({
      answer: () => {
        // another OpsCrew run writes its purchase record in the meantime
        writeFileSync(file, JSON.stringify(earlierRecord("2026-10-11T12:00:00.000Z")));
        return true;
      },
    });
    file = recordFile(deps);
    await mkdir(dirname(file), { recursive: true });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Another OpsCrew run");
    expect(project.cf.count("register")).toBe(0);
  });
});

describe("buyDomain: names OpsCrew cannot buy", () => {
  const cases = [
    {
      name: "premium names",
      check: {
        domain: DOMAIN,
        registrable: false,
        tier: "premium" as const,
        reason: "premium name, buy it in the Cloudflare dashboard",
      },
      expected: "premium",
    },
    {
      name: "premium names the check calls registrable",
      check: { ...buyable(DOMAIN, 2500), tier: "premium" as const },
      expected: "premium",
    },
    {
      name: "taken names",
      check: { domain: DOMAIN, registrable: false, reason: "the domain is already registered" },
      expected: "already registered",
    },
    {
      name: "extensions sold only in the dashboard",
      check: {
        domain: DOMAIN,
        registrable: false,
        reason: "this extension is sold only in the Cloudflare dashboard",
      },
      expected: "only in the Cloudflare dashboard",
    },
    {
      name: "names without a price",
      check: { domain: DOMAIN, registrable: true, tier: "standard" as const },
      expected: "did not return a price",
    },
  ];
  for (const { name, check, expected } of cases) {
    it(`stops before asking for ${name}`, async () => {
      const project = await domainProject();
      project.cf.checks.set(DOMAIN, check);
      const { deps, handler, services } = await project.run();

      const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(expected);
      expect(error.message).toContain("Nothing was bought");
      expect(error.hint).toContain("opscrew domain search shopapp");
      expect(handler.requests).toEqual([]);
      expect(project.cf.count("register")).toBe(0);
    });
  }

  it("sends extensions that need extra registrant data to the dashboard, per Cloudflare's lookup", async () => {
    for (const domain of ["shopapp.us", "shopapp.co.uk", "shopapp.eu"]) {
      const project = await domainProject();
      project.cf.contactTlds.add("eu");
      project.cf.checks.set(domain, buyable(domain));
      const { deps, handler, services } = await project.run();

      const error = await caught(buyDomain(deps, { domain, services }));

      expect(error.code, domain).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("extra registrant details");
      expect(project.cf.count("extension")).toBe(1);
      expect(project.cf.count("check")).toBe(0);
      expect(handler.requests).toEqual([]);
      expect(project.cf.count("register")).toBe(0);
    }
  });

  it("follows the lookup over the fallback list, and falls back when the lookup fails", async () => {
    const lookedUp = await domainProject();
    lookedUp.cf.contactTlds.delete("ca");
    lookedUp.cf.checks.set("shopapp.ca", buyable("shopapp.ca"));
    const one = await lookedUp.run();
    await buyDomain(one.deps, { domain: "shopapp.ca", services: one.services });
    expect(lookedUp.cf.registerCalls).toHaveLength(1);

    for (const failure of ["throws", "unknown"] as const) {
      const project = await domainProject();
      if (failure === "throws") {
        project.cf.failures.extension = () => new OpsCrewError("PROVIDER_ERROR", "boom");
      } else {
        project.cf.unknownTlds.add("us");
      }
      project.cf.checks.set("shopapp.us", buyable("shopapp.us"));
      const run = await project.run();
      const error = await caught(
        buyDomain(run.deps, { domain: "shopapp.us", services: run.services }),
      );
      expect(error.message, failure).toContain("extra registrant details");
      expect(project.cf.count("register")).toBe(0);
    }
  });

  it("rejects invalid input before calling Cloudflare", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run();
    for (const options of [
      { domain: "bücher.com" },
      { domain: "xn--bcher-kva.com" },
      { domain: "https://shopapp.com/" },
      { domain: "shopapp" },
      { domain: DOMAIN, years: 0 },
      { domain: DOMAIN, years: 11 },
      { domain: DOMAIN, years: 1.5 },
      { domain: DOMAIN, maxPrice: -1 },
      { domain: DOMAIN, maxPrice: Number.NaN },
      { domain: DOMAIN, maxPrice: { amount: 5, currency: "GBP" as "USD" } },
    ]) {
      const error = await caught(buyDomain(deps, { ...options, services }));
      expect(error.code, JSON.stringify(options)).toBe("INVALID_INPUT");
    }
    expect(project.cf.events).toEqual([]);
  });

  it("needs the Cloudflare token", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run({ token: null });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("Set CLOUDFLARE_API_TOKEN to");
    expect(error.message).not.toMatch(/CLOUDFLARE_API_TOKEN:/);
    expect(project.cf.events).toEqual([]);
  });

  it("stops before buying while a move to another provider is in progress", async () => {
    const project = await domainProject({ plan: domainTestPlan({ moving: true }) });
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(project.cf.events).toEqual([]);
  });
});

describe("buyDomain: accounts", () => {
  it("asks which account to use when the token sees several", async () => {
    const project = await domainProject();
    project.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("Shop (acc-1), Personal (acc-2)");
    expect(error.hint).toContain("--account");
    expect(project.cf.count("check")).toBe(0);

    await buyDomain(deps, { domain: DOMAIN, account: "acc-2", services });
    expect(project.cf.registerCalls.map((c) => c.accountId)).toEqual(["acc-2"]);
    expect(project.cf.events).toContain(`createZone acc-2 ${DOMAIN}`);

    const unknown = await caught(
      buyDomain(deps, { domain: "other.com", account: "nope", services }),
    );
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.message).toContain('"nope"');
  });
});

describe("buyDomain: never twice (SC-602)", () => {
  it("keeps a fresh record Cloudflare does not show (a crash right before or during the request)", async () => {
    const project = await domainProject();
    const file = await project.writeRecord(earlierRecord("2026-10-11T11:55:00.000Z"));

    const rerun = await project.run();
    const error = await caught(buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Cloudflare shows no purchase of shopapp.com yet");
    expect(error.message).not.toMatch(/nothing was bought/i);
    expect(error.hint).toContain("Wait a few minutes");
    expect(project.cf.count("register")).toBe(0);
    expect(project.cf.count("check")).toBe(0);
    expect(rerun.handler.requests).toEqual([]);
    expect(await exists(file)).toBe(true);
  });

  it("clears a record without an outcome after 30 minutes when both reads confirm there is none", async () => {
    const project = await domainProject();
    const file = await project.writeRecord(earlierRecord("2026-10-11T11:30:00.000Z"));

    // a read that fails is not a confirmation: the record stays
    project.cf.failures.getDomain = () => new OpsCrewError("PROVIDER_ERROR", "Could not reach");
    const failing = await project.run();
    await caught(buyDomain(failing.deps, { domain: DOMAIN, services: failing.services }));
    expect(await exists(file)).toBe(true);
    project.cf.failures = {};

    const rerun = await project.run();
    const error = await caught(buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "Cloudflare shows no purchase of shopapp.com, 30 minutes after",
    );
    expect(error.message).not.toMatch(/nothing was bought/i);
    expect(project.cf.count("register")).toBe(0);
    expect(await exists(file)).toBe(false);

    // the next run may buy again, with a new approval
    const next = await project.run();
    await buyDomain(next.deps, { domain: DOMAIN, services: next.services });
    expect(next.handler.requests.map((r) => r.kind)).toEqual(["domain-purchase"]);
    expect(project.cf.registerCalls).toHaveLength(1);
  });

  it("continues, not repeats, a purchase whose answer was lost", async () => {
    const project = await domainProject({ plan: domainTestPlan() });
    project.cf.loseRegisterResponse = true;
    const first = await project.run();

    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("cannot tell whether the purchase started");
    expect(await readRecord(recordFile(first.deps))).toMatchObject({ outcome: "uncertain" });

    project.cf.loseRegisterResponse = false;
    const rerun = await project.run();
    const result = setUp(await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));

    expect(project.cf.registerCalls).toHaveLength(1);
    expect(rerun.handler.requests).toEqual([]);
    expect(result.total).toEqual(usd(10.44));
    expect(result.alreadyRegistered).toBe(false);
    expect(await exists(recordFile(rerun.deps))).toBe(false);
    const plan = await readArtifact("plan", rerun.deps.paths.files.plan);
    expect(plan.dns.registration?.autoRenew).toBe(true);
  });

  it("never clears an uncertain record by itself, only when the user forgets it after checking", async () => {
    const project = await domainProject();
    project.cf.failures.register = () =>
      new OpsCrewError(
        "PROVIDER_ERROR",
        "Cloudflare gave no clear answer while starting the registration of shopapp.com (HTTP 502). The registration may still have started; check its status before trying again.",
      );
    const first = await project.run();
    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(project.cf.count("register")).toBe(1);
    const file = recordFile(first.deps);
    expect(await readRecord(file)).toMatchObject({ outcome: "uncertain" });
    project.cf.failures = {};

    // hours later Cloudflare still shows nothing: the record stays and the user is told what to do
    const later = await project.run({ now: "2026-10-11T18:00:00.000Z" });
    const stuck = await caught(buyDomain(later.deps, { domain: DOMAIN, services: later.services }));
    expect(stuck.code).toBe("PHASE_PRECONDITION");
    expect(stuck.message).toContain("Cloudflare shows no purchase of shopapp.com");
    expect(stuck.message).toContain("may still appear");
    expect(stuck.message).not.toMatch(/nothing was bought/i);
    expect(stuck.hint).toContain("dash.cloudflare.com");
    expect(stuck.hint).toContain("--forget-pending-purchase");
    // forgetting only clears the note; buying is the run after it
    expect(stuck.hint).toContain(
      "(that run buys nothing), then run `opscrew domain buy shopapp.com`",
    );
    expect(stuck.hint).not.toMatch(/note and buy/);
    expect(await exists(file)).toBe(true);
    expect(project.cf.count("register")).toBe(1);

    // refusing to forget changes nothing
    const refused = await project.run({ answer: () => false });
    const kept = await caught(
      buyDomain(refused.deps, {
        domain: DOMAIN,
        forgetPendingPurchase: true,
        services: refused.services,
      }),
    );
    expect(kept.code).toBe("APPROVAL_REFUSED");
    expect(await exists(file)).toBe(true);

    // a wrong typed domain does not forget it either
    const mistyped = await project.run({
      answer: () => ({ approved: true, confirmation: "shopapp.co" }),
    });
    await caught(
      buyDomain(mistyped.deps, {
        domain: DOMAIN,
        forgetPendingPurchase: true,
        services: mistyped.services,
      }),
    );
    expect(await exists(file)).toBe(true);

    // forgetting needs the typed domain, after the user was told to check the dashboard, and
    // ends the run: nothing is checked, approved or bought in it
    const forget = await project.run();
    const checksBefore = project.cf.count("check");
    const result = await buyDomain(forget.deps, {
      domain: DOMAIN,
      forgetPendingPurchase: true,
      services: forget.services,
    });
    expect(result).toEqual({
      outcome: "forgotten",
      forgotten: DOMAIN,
      next: [expect.stringContaining("Run `opscrew domain buy shopapp.com`")],
    });
    expect(forget.handler.requests).toHaveLength(1);
    expect(forget.handler.requests[0]).toMatchObject({
      kind: "domain-settings",
      title: "Forget the unfinished purchase of shopapp.com",
      confirmPhrase: DOMAIN,
    });
    expect(forget.handler.requests[0]?.details).toContain("got no clear answer");
    expect(forget.handler.requests[0]?.details).toContain("dash.cloudflare.com");
    expect(forget.deps.reporter.text()).toContain("Check the Cloudflare dashboard");
    expect(project.cf.count("check")).toBe(checksBefore);
    expect(project.cf.count("register")).toBe(1);
    expect(await exists(file)).toBe(false);

    // buying again is a separate run, with its own price check and typed approval
    const buy = await project.run();
    setUp(await buyDomain(buy.deps, { domain: DOMAIN, services: buy.services }));
    expect(buy.handler.requests.map((r) => r.kind)).toEqual(["domain-purchase"]);
    expect(project.cf.count("register")).toBe(2);
  });

  it("refuses to forget a purchase Cloudflare shows, or one that does not exist", async () => {
    const project = await domainProject();
    project.cf.loseRegisterResponse = true;
    const first = await project.run();
    await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    project.cf.loseRegisterResponse = false;

    const rerun = await project.run();
    const error = await caught(
      buyDomain(rerun.deps, {
        domain: DOMAIN,
        forgetPendingPurchase: true,
        services: rerun.services,
      }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Cloudflare shows a purchase of shopapp.com");
    expect(rerun.handler.requests).toEqual([]);
    expect(await exists(recordFile(rerun.deps))).toBe(true);

    const empty = await domainProject();
    const run = await empty.run();
    const nothing = await caught(
      buyDomain(run.deps, { domain: DOMAIN, forgetPendingPurchase: true, services: run.services }),
    );
    expect(nothing.code).toBe("PHASE_PRECONDITION");
    expect(empty.cf.events).toEqual([]);
  });

  it("forgets a note about another domain in one run and buys the requested one in the next", async () => {
    const project = await domainProject();
    const file = await project.writeRecord({
      ...earlierRecord("2026-10-11T11:59:00.000Z"),
      domain: "other.com",
    });
    const { deps, handler, services } = await project.run();

    const blocked = await caught(buyDomain(deps, { domain: DOMAIN, services }));
    expect(blocked.hint).toContain("opscrew domain buy shopapp.com --forget-pending-purchase");
    expect(blocked.hint).toContain(
      "(that run buys nothing), then run `opscrew domain buy shopapp.com` to buy shopapp.com",
    );
    expect(blocked.hint).not.toMatch(/about it and buy/);

    const result = await buyDomain(deps, { domain: DOMAIN, forgetPendingPurchase: true, services });
    expect(result).toMatchObject({ outcome: "forgotten", forgotten: "other.com" });
    expect(result.next.join("\n")).toContain("Run `opscrew domain buy shopapp.com`");
    expect(handler.requests.map((r) => [r.kind, r.confirmPhrase])).toEqual([
      ["domain-settings", "other.com"],
    ]);
    expect(project.cf.count("check")).toBe(0);
    expect(project.cf.count("register")).toBe(0);
    expect(await exists(file)).toBe(false);

    const next = await project.run();
    setUp(await buyDomain(next.deps, { domain: DOMAIN, services: next.services }));
    expect(project.cf.registerCalls.map((c) => c.request.domain)).toEqual([DOMAIN]);
  });

  it("says so when marking the purchase note as uncertain fails, and never makes it clearable", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run();
    const home = deps.paths.projectHomeDir;
    project.cf.failures.register = () => {
      // the purchase note cannot be rewritten: its directory is replaced by a file
      rmSync(home, { recursive: true, force: true });
      writeFileSync(home, "");
      return new OpsCrewError(
        "PROVIDER_ERROR",
        "Cloudflare gave no clear answer while starting the registration of shopapp.com (HTTP 502).",
      );
    };

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Cloudflare did not confirm the purchase of shopapp.com");
    expect(error.message).toContain("HTTP 502");
    expect(error.message).toContain(
      "OpsCrew could not mark its purchase note as uncertain; do not delete it until the Cloudflare dashboard shows what happened.",
    );
    expect(project.cf.count("register")).toBe(1);
  });

  it("clears the record when Cloudflare clearly refused the purchase and has no registration", async () => {
    for (const code of ["PHASE_PRECONDITION", "CREDENTIALS_INVALID"] as const) {
      const project = await domainProject();
      project.cf.failures.register = () =>
        new OpsCrewError(
          code,
          "Cloudflare refused to register shopapp.com: The account has no default registrant contact.",
          { hint: "Fix it at https://dash.cloudflare.com (Domain Registration)." },
        );
      const { deps, services } = await project.run();

      const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

      expect(error.code).toBe(code);
      expect(error.message).toContain("no default registrant contact");
      expect(error.message).toContain("Nothing was bought");
      expect(error.hint).toBe("Fix it at https://dash.cloudflare.com (Domain Registration).");
      expect(project.cf.count("status")).toBe(3);
      expect(await exists(recordFile(deps))).toBe(false);
    }
  });

  it("keeps the record after a clear refusal when the status cannot be confirmed", async () => {
    const project = await domainProject();
    project.cf.failures.register = () => new OpsCrewError("PHASE_PRECONDITION", "refused");
    project.cf.failures.status = (call) =>
      call > 2
        ? new OpsCrewError("PROVIDER_ERROR", "Cloudflare could not read the status")
        : undefined;
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).not.toMatch(/nothing was bought/i);
    expect(await exists(recordFile(deps))).toBe(true);
  });

  it("continues after an interruption while waiting", async () => {
    const project = await domainProject();
    project.cf.failures.sleep = (call) => (call === 1 ? new Error("interrupted") : undefined);
    const first = await project.run();

    await expect(
      buyDomain(first.deps, { domain: DOMAIN, services: first.services }),
    ).rejects.toThrow("interrupted");
    expect(await exists(recordFile(first.deps))).toBe(true);

    const rerun = await project.run();
    const result = setUp(await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));
    expect(project.cf.registerCalls).toHaveLength(1);
    expect(result.domain.domain).toBe(DOMAIN);
    expect(await exists(recordFile(rerun.deps))).toBe(false);
  });

  it("finishes the setup on the next run when it failed after the purchase", async () => {
    const project = await domainProject({ plan: domainTestPlan() });
    project.cf.failures.enableDnssec = (call) =>
      call === 1
        ? new OpsCrewError("PROVIDER_ERROR", "Cloudflare could not turn on DNSSEC.")
        : undefined;
    const first = await project.run();

    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    expect(error.message).toContain("shopapp.com is registered, but OpsCrew could not finish");
    expect(error.hint).toContain("it does not buy the domain again");
    expect(await exists(recordFile(first.deps))).toBe(true);

    const rerun = await project.run();
    const result = setUp(await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));
    expect(project.cf.registerCalls).toHaveLength(1);
    expect(rerun.handler.requests).toEqual([]);
    expect(result.zoneId).toBe(`zone-${DOMAIN}`);
    const plan = await readArtifact("plan", rerun.deps.paths.files.plan);
    expect(plan.dns.registration?.dnssec).toBe(true);
  });

  it("stops without buying when the registration status or the domain details cannot be read", async () => {
    for (const operation of ["status", "getDomain"] as const) {
      const project = await domainProject();
      project.cf.failures[operation] = () =>
        new OpsCrewError("PROVIDER_ERROR", "Cloudflare could not read the registration.");
      const { deps, handler, services } = await project.run();

      const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

      expect(error.code, operation).toBe("PROVIDER_ERROR");
      expect(handler.requests).toEqual([]);
      expect(project.cf.count("register")).toBe(0);
    }
  });

  it("stops when a record names another domain", async () => {
    const project = await domainProject();
    await project.writeRecord({
      ...earlierRecord("2026-10-10T08:00:00.000Z"),
      domain: "other.com",
    });
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("other.com");
    expect(error.hint).toContain("opscrew domain buy other.com");
    expect(project.cf.count("register")).toBe(0);
    expect(project.cf.count("check")).toBe(0);
  });

  it("stops when the record cannot be read", async () => {
    const project = await domainProject();
    const { deps, services } = await project.run();
    const file = recordFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ not json");

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(project.cf.count("register")).toBe(0);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("continues a recorded purchase on the recorded account and refuses another --account", async () => {
    const project = await domainProject();
    project.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    project.cf.loseRegisterResponse = true;
    const first = await project.run();
    await caught(
      buyDomain(first.deps, { domain: DOMAIN, account: "acc-2", services: first.services }),
    );
    project.cf.loseRegisterResponse = false;

    const rerun = await project.run();
    const wrong = await caught(
      buyDomain(rerun.deps, { domain: DOMAIN, account: "acc-1", services: rerun.services }),
    );
    expect(wrong.code).toBe("PHASE_PRECONDITION");
    expect(wrong.hint).toContain("--account acc-2");

    await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services });
    expect(project.cf.registerCalls.map((c) => c.accountId)).toEqual(["acc-2"]);
  });
});

describe("buyDomain: a domain the account already has", () => {
  it("never buys it, and changes nothing before a domain-settings approval listing every change", async () => {
    const plan = domainTestPlan();
    const project = await domainProject({ plan, requirements: testRequirements() });
    project.cf.own(DOMAIN, { autoRenew: false });
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(result.alreadyRegistered).toBe(true);
    expect(project.cf.count("register")).toBe(0);
    expect(project.cf.count("check")).toBe(0);
    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    const [approval] = handler.requests;
    expect(approval?.title).toBe("Set up shopapp.com for this project");
    // typed in a terminal, `--confirm shopapp.com` in scripts; `--yes` never grants it
    expect(approval?.confirmPhrase).toBe(DOMAIN);
    for (const line of [
      "already registered on your Cloudflare account Shop (acc-1), so nothing is bought",
      "Cloudflare zone: created for shopapp.com in this account if it does not exist there yet",
      "DNSSEC: turned on for the zone unless it is already on",
      "opscrew/plan.yaml: the app is served at shopapp.com through Cloudflare",
      "dns.proxied becomes true",
      "opscrew/requirements.yaml: domain shopapp.com, dnsProvider cloudflare.",
    ]) {
      expect(approval?.details).toContain(line);
    }
    expect(approval?.details).not.toContain("Auto-renew");
    // the approval comes before every change
    const approvalAt = project.cf.events.indexOf("approval domain-settings");
    expect(approvalAt).toBeLessThan(project.cf.events.indexOf(`createZone acc-1 ${DOMAIN}`));
    // auto-renew is left alone unless asked for
    expect(project.cf.autoRenewCalls).toEqual([]);
    expect(result.domain.autoRenew).toBe(false);
    const updated = await readArtifact("plan", deps.paths.files.plan);
    expect(updated.dns.registration).toMatchObject({ autoRenew: false, dnssec: true });
  });

  it("changes nothing when the setup is refused or the domain is not typed exactly", async () => {
    const plan = domainTestPlan();
    const requirements = testRequirements();
    const project = await domainProject({ plan, requirements });
    project.cf.own(DOMAIN, { autoRenew: false });
    const answers = [() => false, () => ({ approved: true, confirmation: "shopapp.co" })];
    for (const answer of answers) {
      const { deps, services } = await project.run({ answer });

      const error = await caught(buyDomain(deps, { domain: DOMAIN, autoRenew: true, services }));

      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("OpsCrew changed nothing");
      for (const operation of ["createZone", "enableDnssec", "setAutoRenew", "register"] as const) {
        expect(project.cf.count(operation), operation).toBe(0);
      }
      expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
      expect(await readArtifact("requirements", deps.paths.files.requirements)).toEqual(
        requirements,
      );
    }
  });

  it("includes an asked-for auto-renew change and another domain's replacement in the one approval", async () => {
    const project = await domainProject({ plan: domainTestPlan({ domain: "old.example.com" }) });
    project.cf.own(DOMAIN, { autoRenew: false });
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, autoRenew: true, services }));

    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    expect(handler.requests[0]?.details).toContain("Auto-renew: off → on");
    expect(handler.requests[0]?.details).toContain("This replaces old.example.com");
    expect(project.cf.autoRenewCalls).toEqual([{ domain: DOMAIN, on: true }]);
    expect(result.domain.autoRenew).toBe(true);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.domain).toBe(DOMAIN);
  });

  it("finds a registration only the domain details show (getDomain) and does not buy", async () => {
    const project = await domainProject();
    project.cf.own(DOMAIN);
    project.cf.registrations.delete(DOMAIN);
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    expect(project.cf.count("register")).toBe(0);
  });

  it("waits for a purchase under way on the account without a local record", async () => {
    const project = await domainProject();
    const first = await project.run();
    project.cf.progress = [];
    await first.services.registrar?.("acc-1").register({
      domain: DOMAIN,
      years: 1,
      autoRenew: true,
      privacy: true,
    });
    project.cf.progress = ["in_progress", "succeeded"];

    const rerun = await project.run();
    const result = setUp(await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));

    expect(project.cf.registerCalls).toHaveLength(1);
    expect(rerun.handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    expect(result.alreadyRegistered).toBe(true);
  });
});

describe("buyDomain: registrations that do not succeed", () => {
  it("stops on action_required, keeps the record and continues once resolved", async () => {
    const project = await domainProject();
    project.cf.progress = ["action_required"];
    project.cf.messages.action_required = `Verify the email address owner@shopapp.example or call +1 415 555 0100 (token ${TOKEN}).`;
    const first = await project.run();

    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Cloudflare needs you to act");
    expect(error.message).toContain("Verify the email address [email]");
    expect(error.message).toContain("Nothing is charged until the purchase succeeds");
    expect(error.hint).toContain("never sends a second one");
    const seen = visibleText(first.deps, error);
    for (const secret of [TOKEN, "owner@shopapp.example", "415 555 0100"]) {
      expect(seen).not.toContain(secret);
    }
    expect(first.deps.audit.entries.at(-1)?.detail).toBe("Cloudflare reported action_required");
    expect(await exists(recordFile(first.deps))).toBe(true);

    project.cf.progress = ["succeeded"];
    const rerun = await project.run();
    await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services });
    expect(project.cf.registerCalls).toHaveLength(1);
  });

  it("stops on blocked and keeps the record", async () => {
    const project = await domainProject();
    project.cf.progress = ["blocked"];
    project.cf.messages.blocked = "The account has reached the domain limit.";
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "Cloudflare blocked the purchase of shopapp.com: The account has reached the domain limit.",
    );
    expect(await exists(recordFile(deps))).toBe(true);
  });

  it("stops on failed, clears the record and never buys the same domain again", async () => {
    const project = await domainProject();
    project.cf.progress = ["failed"];
    project.cf.messages.failed = "Payment declined.";
    const first = await project.run();

    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("failed: Payment declined.");
    expect(error.message).toContain("Nothing is charged");
    expect(await exists(recordFile(first.deps))).toBe(false);

    const rerun = await project.run();
    const again = await caught(buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services }));
    expect(again.code).toBe("PROVIDER_ERROR");
    expect(rerun.handler.requests).toEqual([]);
    expect(project.cf.registerCalls).toHaveLength(1);
  });

  it("stops after about ten minutes, saying it may still complete, and the next run finishes", async () => {
    const project = await domainProject();
    project.cf.progress = ["in_progress"];
    const first = await project.run();

    const error = await caught(buyDomain(first.deps, { domain: DOMAIN, services: first.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("It may still complete");
    expect(project.cf.time).toBeGreaterThanOrEqual(10 * 60_000);
    expect(project.cf.time).toBeLessThan(11 * 60_000);
    expect(await exists(recordFile(first.deps))).toBe(true);

    project.cf.progress = ["succeeded"];
    const rerun = await project.run();
    await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services });
    expect(project.cf.registerCalls).toHaveLength(1);
    expect(await exists(recordFile(rerun.deps))).toBe(false);
  });

  it("stops after repeated status errors while waiting and keeps the record", async () => {
    const project = await domainProject();
    project.cf.failures.status = (call) =>
      call > 2
        ? new OpsCrewError("PROVIDER_ERROR", "Could not reach the Cloudflare API.")
        : undefined;
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, services }));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("may still complete");
    expect(project.cf.count("status")).toBe(2 + 3);
    expect(await exists(recordFile(deps))).toBe(true);
  });
});

describe("buyDomain: recording the domain in the project", () => {
  it("replaces another domain in the plan after an approval", async () => {
    const project = await domainProject({
      plan: domainTestPlan({ domain: "old.example.com" }),
      requirements: testRequirements("old.example.com"),
    });
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-purchase", "repo-write"]);
    expect(handler.requests[0]?.details).toContain(
      "The project uses old.example.com today; after the purchase OpsCrew asks before it records shopapp.com instead",
    );
    expect(handler.requests[1]?.title).toBe(
      "Use shopapp.com instead of old.example.com in opscrew/plan.yaml",
    );
    expect(result.recorded).toEqual({ plan: true, requirements: true });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({ provider: "cloudflare", domain: DOMAIN, zone: DOMAIN });
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    expect(requirements.domain).toBe(DOMAIN);
  });

  it("keeps the plan's domain when the switch is refused; the domain stays bought", async () => {
    const plan = domainTestPlan({ domain: "old.example.com" });
    const requirements = testRequirements("old.example.com");
    const project = await domainProject({ plan, requirements });
    const { deps, services } = await project.run({ answer: (r) => r.kind === "domain-purchase" });

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, services }));

    expect(project.cf.registerCalls).toHaveLength(1);
    expect(result.recorded).toEqual({ plan: false, requirements: false });
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(plan);
    expect(await readArtifact("requirements", deps.paths.files.requirements)).toEqual(requirements);
    expect(deps.reporter.text()).toContain("The plan still uses old.example.com");
    expect(deps.reporter.text()).toContain("stays bought");
    expect(result.next.join("\n")).toContain("opscrew dns --domain shopapp.com");
    expect(await exists(recordFile(deps))).toBe(false);
  });

  it("keeps a hostname inside the bought domain and records the zone", async () => {
    const project = await domainProject({ plan: domainTestPlan({ domain: "app.shopapp.com" }) });
    const { deps, handler, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-purchase"]);
    expect(handler.requests[0]?.details).not.toContain("dns.proxied becomes true");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: "app.shopapp.com",
      zone: DOMAIN,
      registration: { registrar: "cloudflare", dnssec: true },
    });
  });
});
