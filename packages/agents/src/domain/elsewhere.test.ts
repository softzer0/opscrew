import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  buyable,
  type DomainProject,
  domainProject,
  domainTestPlan,
  TOKEN,
  testRequirements,
  usd,
  visibleText,
  ZONE_NAMESERVERS,
} from "./__fixtures__/fakes";
import { DEFAULT_NAMESERVERS, MASKED_CONTACT, SEEDED_CONTACT } from "./__fixtures__/registrars";
import { buyDomain } from "./buy";
import { registrarLinks } from "./registrars";
import { SANDBOX_NAMESERVERS, SANDBOX_ZONES } from "./services";
import type { BuyDomainResult, DomainSetUpResult } from "./types";

const DOMAIN = "shopapp.com";
const ZONE = `zone-${DOMAIN}`;
const FIRST_KEY = "00000000-0000-4000-8000-000000000001";
const PORKBUN_LINK = registrarLinks("porkbun").domains;
const NAMECHEAP_LINK = registrarLinks("namecheap").domains;
const GODADDY_LINK = registrarLinks("godaddy").domains;

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

/** A project with Porkbun selling shopapp.com for $11.08 (renewal $12.50). */
async function porkbunProject(options: Parameters<typeof domainProject>[0] = {}) {
  const project = await domainProject(options);
  const pb = project.other("porkbun");
  pb.checks.set(DOMAIN, buyable(DOMAIN, 11.08, 12.5));
  pb.account = { ok: true, message: "The Porkbun API keys work.", balance: usd(50) };
  return { project, pb };
}

async function namecheapProject(options: Parameters<typeof domainProject>[0] = {}) {
  const project = await domainProject(options);
  const nc = project.other("namecheap");
  nc.checks.set(DOMAIN, buyable(DOMAIN, 9.58, 14.98));
  nc.account = { ok: true, message: "Namecheap API access works.", balance: usd(40) };
  return { project, nc };
}

async function godaddyProject(options: Parameters<typeof domainProject>[0] = {}) {
  const project = await domainProject(options);
  const gd = project.other("godaddy");
  gd.checks.set(DOMAIN, buyable(DOMAIN, 11.99, 22.99));
  gd.quoteExtras = {
    token: "quote-token-1",
    agreements: ["Domain Name Registration Agreement (https://www.godaddy.com/legal/agreements)"],
    expiresAt: "2026-10-11T12:10:00.000Z",
  };
  gd.firstState = "in_progress";
  gd.progress = ["in_progress", "succeeded"];
  return { project, gd };
}

/** A plan that records shopapp.com at the registrar (OpsCrew set it up there before). */
function planAt(registrar: "porkbun" | "namecheap" | "godaddy"): DeployPlan {
  const plan = domainTestPlan({ domain: DOMAIN });
  return {
    ...plan,
    dns: {
      ...plan.dns,
      zone: DOMAIN,
      registration: { registrar, autoRenew: true, privacy: true, dnssec: false },
    },
  };
}

/** Every value of the seeded contact must stay out of everything a user or the audit log sees. */
function expectNoContact(text: string): void {
  for (const value of Object.values(SEEDED_CONTACT)) expect(text).not.toContain(value);
}

describe("buyDomain at another registrar: the registrar sandbox", () => {
  it("points the domain at the stand-in nameservers and says DNSSEC was skipped, with no step that cannot finish", async () => {
    const { project, pb } = await porkbunProject({ plan: domainTestPlan() });
    const { deps, services } = await project.run();

    const result = setUp(
      await buyDomain(deps, {
        domain: DOMAIN,
        registrar: "porkbun",
        services: { ...services, zones: SANDBOX_ZONES },
      }),
    );

    expect(pb.nameservers.get(DOMAIN)).toEqual(SANDBOX_NAMESERVERS);
    expect(pb.count("addDsRecord")).toBe(0);
    expect(project.cf.count("createZone")).toBe(0);
    const next = result.next.join("\n");
    expect(next).not.toContain("publish the DS record");
    expect(next).not.toContain("Cloudflare activates the zone");
    expect(deps.reporter.text()).toContain("DNSSEC skipped");
    expect(deps.reporter.text()).not.toContain("DNSSEC not published yet");
    const actions = deps.audit.entries.map((e) => e.action);
    expect(actions).not.toContain("enable DNSSEC");
    expect(actions).not.toContain("zone activation check");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toMatchObject({ registrar: "porkbun", dnssec: false });
  });
});

describe("buyDomain at another registrar: the purchase (US1)", () => {
  it("buys at Porkbun once with the approved quote and a key, then zone, nameservers, DS, activation check", async () => {
    const { project, pb } = await porkbunProject({
      plan: domainTestPlan(),
      requirements: testRequirements(),
    });
    const { cf } = project;
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(cf.events).toEqual([
      "accounts",
      `porkbun status ${DOMAIN}`,
      `porkbun getDomain ${DOMAIN}`,
      "porkbun accountCheck",
      `porkbun quote ${DOMAIN} 1`,
      "approval domain-purchase",
      `porkbun status ${DOMAIN}`,
      `porkbun register ${DOMAIN}`,
      `createZone acc-1 ${DOMAIN}`,
      `porkbun getNameservers ${DOMAIN}`,
      `porkbun setNameservers ${DOMAIN} ${ZONE_NAMESERVERS.join(",")}`,
      `dnssecEnabled ${ZONE}`,
      `enableDnssec ${ZONE}`,
      `dsRecord ${ZONE}`,
      `porkbun listDsRecords ${DOMAIN}`,
      `porkbun addDsRecord ${DOMAIN} 2371`,
      `activationCheck ${ZONE}`,
      `porkbun getDomain ${DOMAIN}`,
    ]);
    // the approved quote and one idempotency key, created with the purchase record
    expect(pb.registerCalls).toEqual([
      {
        domain: DOMAIN,
        years: 1,
        autoRenew: true,
        privacy: true,
        quote: { price: usd(11.08), renewal: usd(12.5) },
        idempotencyKey: FIRST_KEY,
      },
    ]);
    expect(pb.dsRecords.get(DOMAIN)).toEqual([
      { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ABCDEF0123" },
    ]);
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);

    const [approval] = handler.requests;
    expect(approval).toMatchObject({
      kind: "domain-purchase",
      title: "Buy shopapp.com at Porkbun for $11.08 (1 year)",
      confirmPhrase: DOMAIN,
    });
    for (const line of [
      "Registrar: Porkbun",
      "Term: the registry minimum (1 year)",
      "Charged now: $11.08",
      "Renewal: $12.50 per year",
      "Auto-renew: on",
      "WHOIS privacy: on",
      "Registrant contact: your Porkbun account's own contact is used",
      "Cloudflare account: Shop (acc-1)",
      "creates a Cloudflare zone for shopapp.com",
      "points the nameservers of shopapp.com at Porkbun to the zone",
      "adds the zone's DS record at Porkbun",
      "opscrew/requirements.yaml: domain shopapp.com, dnsProvider cloudflare.",
      "Domain purchases cannot be refunded.",
    ]) {
      expect(approval?.details).toContain(line);
    }

    expect(result).toMatchObject({
      registrar: "porkbun",
      zoneId: ZONE,
      nameservers: ZONE_NAMESERVERS,
      total: usd(11.08),
      alreadyRegistered: false,
      recorded: { plan: true, requirements: true },
      domain: { domain: DOMAIN, registrar: "porkbun", autoRenew: true },
    });
    expect(result.next.join("\n")).toContain("Cloudflare activates the zone");
    expect(result.next.join("\n")).toContain("opscrew provision");
    expect(deps.reporter.text()).toContain("registered with Porkbun until 2027-10-11");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: DOMAIN,
      zone: DOMAIN,
      registration: { registrar: "porkbun", autoRenew: true, privacy: true, dnssec: true },
    });
    expect(await exists(recordFile(deps))).toBe(false);

    // audited with the registrar name; the approval before the purchase
    const audit = deps.audit.entries;
    expect(audit.find((e) => e.kind === "approval")).toMatchObject({
      action: "domain-purchase",
      decision: "approved",
    });
    for (const action of ["register domain", "set nameservers", "add DS record"]) {
      expect(audit.find((e) => e.action === action)?.detail, action).toContain("Porkbun");
    }
    expect(audit.find((e) => e.action === "domain purchase")?.detail).toContain("Porkbun");
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("checks the Namecheap balance first, shows the masked contact and prints the DS record with the link", async () => {
    const { project, nc } = await namecheapProject({ plan: domainTestPlan() });
    const { deps, handler, services } = await project.run();

    const result = setUp(
      await buyDomain(deps, { domain: DOMAIN, registrar: "namecheap", years: 2, services }),
    );

    const events = project.cf.events;
    expect(events.indexOf("namecheap accountCheck")).toBeLessThan(
      events.indexOf(`namecheap quote ${DOMAIN} 2`),
    );
    expect(events.indexOf("namecheap contactSummary")).toBeLessThan(
      events.indexOf("approval domain-purchase"),
    );
    const [approval] = handler.requests;
    expect(approval?.title).toBe("Buy shopapp.com at Namecheap for $19.16 (2 years)");
    for (const line of [
      "Registrar: Namecheap",
      "Years: 2",
      "Charged now: $19.16",
      "Renewal: $14.98 per year",
      `Registrant contact: ${MASKED_CONTACT}`,
      "Namecheap account balance: $40.00",
      `Namecheap's API cannot publish DNSSEC records, so OpsCrew shows the zone's DS record to add at ${NAMECHEAP_LINK}`,
    ]) {
      expect(approval?.details).toContain(line);
    }
    expect(nc.registerCalls[0]).toMatchObject({ years: 2, quote: { price: usd(19.16) } });
    // DNSSEC cannot be published through Namecheap's API: shown with the link, recorded as off
    expect(events).not.toContain(`namecheap addDsRecord ${DOMAIN} 2371`);
    const shown = `${deps.reporter.text()}\n${result.next.join("\n")}`;
    expect(shown).toContain("key tag 2371, algorithm 13, digest type 2, digest ABCDEF0123");
    expect(shown).toContain(NAMECHEAP_LINK);
    // shown once: as a next step, not also as a warning
    expect(shown.split("key tag 2371")).toHaveLength(2);
    expect(result.next.join("\n")).toContain(
      `Add this DS record for shopapp.com at ${NAMECHEAP_LINK} to turn DNSSEC on: key tag 2371`,
    );
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toMatchObject({ registrar: "namecheap", dnssec: false });
    // auto-renew cannot be set through the API: the account's setting stays, with the link
    expect(nc.autoRenewCalls).toEqual([]);
    expect(result.next.join("\n")).toContain(
      `Turn auto-renew on for shopapp.com at ${NAMECHEAP_LINK}`,
    );
    expect(nc.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
  });

  it("shows GoDaddy's locked price and agreements, sends the quote token and waits for the registration", async () => {
    const { project, gd } = await godaddyProject();
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, registrar: "godaddy", services }));

    const details = handler.requests[0]?.details ?? "";
    expect(details).toContain(
      "Agreements: by typing the domain you accept GoDaddy's Domain Name Registration Agreement (https://www.godaddy.com/legal/agreements).",
    );
    expect(details).toContain("Price valid until: 2026-10-11 12:10 UTC");
    expect(details).toContain("Registrant contact: the GoDaddy account's default contact profile");
    expect(gd.registerCalls[0]?.quote?.token).toBe("quote-token-1");
    expect(gd.registerCalls[0]?.idempotencyKey).toBe(FIRST_KEY);
    expect(gd.count("register")).toBe(1);
    expect(result.domain.registrar).toBe("godaddy");
    expect(deps.reporter.text()).toContain("Waiting for GoDaddy to finish buying shopapp.com");
    expect(result.next.join("\n")).toContain(GODADDY_LINK);
  });

  it("shows a message the registrar returned with a successful purchase, made safe", async () => {
    const { project, pb } = await porkbunProject();
    pb.messages.succeeded = `Bought shopapp.com, but auto-renew could not be turned on. Change it at ${PORKBUN_LINK}.`;
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services });

    expect(deps.reporter.text()).toContain("auto-renew could not be turned on");
  });
});

describe("buyDomain at another registrar: before the approval", () => {
  it("refuses another number of years at Porkbun before calling anything", async () => {
    const { project, pb } = await porkbunProject();
    const { deps, handler, services } = await project.run();

    const error = await caught(
      buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", years: 2, services }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("registry minimum");
    expect(error.hint).toContain("--years");
    expect(project.cf.events).toEqual([]);
    expect(handler.requests).toEqual([]);
    expect(pb.count("register")).toBe(0);
  });

  it("stops with the account check's message and fix when the account cannot buy", async () => {
    const { project, nc } = await namecheapProject();
    nc.account = {
      ok: false,
      message:
        "Namecheap refused the request from 203.0.113.9 because that address is not whitelisted.",
      fix: `Add 203.0.113.9 at ${registrarLinks("namecheap").api}, then try again.`,
    };
    const { deps, handler, services } = await project.run();

    const error = await caught(
      buyDomain(deps, { domain: DOMAIN, registrar: "namecheap", services }),
    );

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("not whitelisted");
    expect(error.message).toContain("Nothing was bought");
    expect(error.hint).toContain("Add 203.0.113.9 at https://");
    expect(nc.count("quote")).toBe(0);
    expect(handler.requests).toEqual([]);
  });

  it("shows the account check's caveat (a key permission) before the quote and goes on", async () => {
    const { project, pb } = await porkbunProject();
    pb.account = {
      ok: true,
      message:
        "The Porkbun API keys work. They do not allow buying domains (the purchase permission)",
      fix: `Give the key the purchase permission at ${registrarLinks("porkbun").api}`,
    };
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services });

    expect(deps.reporter.text()).toContain(
      `warn: The Porkbun API keys work. They do not allow buying domains (the purchase permission). Give the key the purchase permission at ${registrarLinks("porkbun").api}.`,
    );
    expect(pb.count("register")).toBe(1);
  });

  it("stops before the quote when the Porkbun key cannot change nameservers: no approval, nothing bought", async () => {
    const { project, pb } = await porkbunProject();
    pb.account = {
      ok: false,
      message:
        "The Porkbun API keys work. They do not allow changing nameservers, auto-renew and DNSSEC (the domains permission), which OpsCrew needs to point a domain at Cloudflare",
      fix: `Give the key the domains permission at ${registrarLinks("porkbun").api} (the gear icon next to the key), or create a key that has it`,
    };
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("the domains permission");
    expect(error.message).toContain("Nothing was bought");
    expect(error.hint).toContain(
      `Give the key the domains permission at ${registrarLinks("porkbun").api}`,
    );
    expect(pb.count("quote")).toBe(0);
    expect(pb.count("register")).toBe(0);
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("createZone")).toBe(0);
  });

  it("stops before asking when the account balance is lower than the price, naming both", async () => {
    const { project, nc } = await namecheapProject();
    nc.account = { ok: true, message: "Namecheap API access works.", balance: usd(5) };
    const { deps, handler, services } = await project.run();

    const error = await caught(
      buyDomain(deps, { domain: DOMAIN, registrar: "namecheap", services }),
    );

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("5.00 USD");
    expect(error.message).toContain("9.58 USD");
    expect(error.message).toContain("Nothing was bought");
    expect(handler.requests).toEqual([]);
    expect(nc.count("register")).toBe(0);
  });

  it("bounds the quote by --max-price, in the quote's currency", async () => {
    const { project, pb } = await porkbunProject();
    const { deps, handler, services } = await project.run();

    const over = await caught(
      buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", maxPrice: 11, services }),
    );
    expect(over.code).toBe("APPROVAL_REFUSED");
    expect(over.message).toContain("11.08 USD");
    expect(over.message).toContain("maximum of 11.00 USD");
    expect(over.hint).toContain("--max-price to at least 11.08USD");

    const currency = await caught(
      buyDomain(deps, {
        domain: DOMAIN,
        registrar: "porkbun",
        maxPrice: { amount: 20, currency: "EUR" },
        services,
      }),
    );
    expect(currency.code).toBe("APPROVAL_REFUSED");
    expect(currency.message).toContain("Porkbun quotes shopapp.com in USD");
    expect(handler.requests).toEqual([]);
    expect(pb.count("register")).toBe(0);

    await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", maxPrice: 11.08, services });
    expect(pb.registerCalls).toHaveLength(1);
  });

  it("refuses a run without a terminal and without --max-price, naming the exact command", async () => {
    const { project, pb } = await porkbunProject();
    const { deps, handler, services } = await project.run({ interactive: false });

    const error = await caught(
      buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", account: "acc-1", services }),
    );

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toContain(
      "`opscrew domain buy shopapp.com --registrar porkbun --account acc-1 --confirm shopapp.com --max-price 11.08USD`",
    );
    expect(handler.requests).toEqual([]);
    expect(pb.count("register")).toBe(0);

    await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", maxPrice: 11.08, services });
    expect(pb.registerCalls).toHaveLength(1);
  });

  it("stops when the registrar cannot sell the name, saying nothing was bought", async () => {
    const { project, pb } = await porkbunProject();
    pb.checks.set(DOMAIN, { domain: DOMAIN, registrable: false, reason: "taken" });
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("not available at Porkbun");
    expect(error.message).toContain("Nothing was bought");
    expect(handler.requests).toEqual([]);
  });

  it("makes the registrar's refusal hint safe before showing it", async () => {
    const { project, pb } = await porkbunProject();
    pb.failures.quote = () =>
      new OpsCrewError("PHASE_PRECONDITION", "Porkbun cannot sell shopapp.com right now.", {
        hint: `Write to registrar-help@example.invalid or call +1 555 010 4477 (key ${TOKEN}).`,
      });
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.message).toBe("Porkbun cannot sell shopapp.com right now. Nothing was bought.");
    expect(error.hint).toContain("Write to [email] or call [phone]");
    for (const secret of ["registrar-help@example.invalid", "555 010 4477", TOKEN]) {
      expect(error.hint).not.toContain(secret);
    }
    expect(handler.requests).toEqual([]);
  });

  it("still needs the Cloudflare token, because the zone lives there", async () => {
    const { project, pb } = await porkbunProject();
    const { deps, services } = await project.run({ token: null });

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("Cloudflare zone");
    expect(error.message).toContain("Set CLOUDFLARE_API_TOKEN to");
    expect(error.message).not.toMatch(/CLOUDFLARE_API_TOKEN:/);
    expect(project.cf.events).toEqual([]);
    expect(pb.count("register")).toBe(0);
  });

  it("keeps the IDN check for every registrar", async () => {
    const { project } = await porkbunProject();
    const { deps, services } = await project.run();

    const error = await caught(
      buyDomain(deps, { domain: "bücher.com", registrar: "porkbun", services }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(project.cf.events).toEqual([]);
  });
});

describe("buyDomain at another registrar: the typed approval (SC-701)", () => {
  const answers = [
    { name: "refused", run: { answer: () => false } },
    {
      name: "mistyped",
      run: { answer: () => ({ approved: true, confirmation: "shopapp.co" }) },
    },
    { name: "--yes", run: { assumeYes: true } },
  ];
  for (const { name, run } of answers) {
    it(`buys nothing and switches no nameservers when ${name}`, async () => {
      const { project, pb } = await porkbunProject({ plan: domainTestPlan() });
      const { deps, services } = await project.run(run);
      const before = await readArtifact("plan", deps.paths.files.plan);

      const error = await caught(
        buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }),
      );

      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("nothing was bought");
      expect(pb.count("register")).toBe(0);
      expect(pb.count("setNameservers")).toBe(0);
      expect(project.cf.count("createZone")).toBe(0);
      expect(await exists(recordFile(deps))).toBe(false);
      expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);
    });

    it(`sets nothing up for a domain already in the account when ${name}`, async () => {
      const { project, pb } = await porkbunProject({ plan: planAt("porkbun") });
      pb.own(DOMAIN);
      const { deps, services } = await project.run(run);

      const error = await caught(
        buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }),
      );

      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("OpsCrew changed nothing");
      expect(pb.count("setNameservers")).toBe(0);
      expect(pb.count("addDsRecord")).toBe(0);
      expect(project.cf.count("createZone")).toBe(0);
    });
  }

  it("stops when GoDaddy's quote expired while the user was deciding", async () => {
    const { project, gd } = await godaddyProject();
    gd.quoteExtras = { ...gd.quoteExtras, expiresAt: "2026-10-11T11:59:00.000Z" };
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "godaddy", services }));

    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("expired");
    expect(error.message).toContain("Nothing was bought");
    expect(error.hint).toContain("opscrew domain buy shopapp.com --registrar godaddy");
    expect(gd.count("register")).toBe(0);
    expect(await exists(recordFile(deps))).toBe(false);
  });
});

describe("buyDomain at another registrar: never twice", () => {
  it("continues an interrupted wait with the same record and key; one purchase", async () => {
    const { project, gd } = await godaddyProject({ plan: domainTestPlan() });
    project.cf.failures.sleep = (call) => (call === 1 ? new Error("interrupted") : undefined);
    const first = await project.run();

    await expect(
      buyDomain(first.deps, { domain: DOMAIN, registrar: "godaddy", services: first.services }),
    ).rejects.toThrow("interrupted");
    const record = await readRecord(recordFile(first.deps));
    expect(record).toMatchObject({
      domain: DOMAIN,
      registrar: "godaddy",
      idempotencyKey: FIRST_KEY,
      outcome: "accepted",
      total: usd(11.99),
    });

    const rerun = await project.run();
    const result = setUp(
      await buyDomain(rerun.deps, {
        domain: DOMAIN,
        registrar: "godaddy",
        services: rerun.services,
      }),
    );

    expect(gd.registerCalls.map((r) => r.idempotencyKey)).toEqual([FIRST_KEY]);
    expect(rerun.handler.requests).toEqual([]);
    expect(result.total).toEqual(usd(11.99));
    expect(result.alreadyRegistered).toBe(false);
    expect(await exists(recordFile(rerun.deps))).toBe(false);
    const plan = await readArtifact("plan", rerun.deps.paths.files.plan);
    expect(plan.dns.registration?.registrar).toBe("godaddy");
  });

  it("finishes the switch on the next run when it failed after the purchase, reusing the record", async () => {
    const { project, pb } = await porkbunProject({ plan: domainTestPlan() });
    pb.failures.setNameservers = (call) =>
      call === 1
        ? new OpsCrewError("PROVIDER_ERROR", "Porkbun could not update the nameservers.")
        : undefined;
    const first = await project.run();

    const error = await caught(
      buyDomain(first.deps, { domain: DOMAIN, registrar: "porkbun", services: first.services }),
    );
    expect(error.message).toContain("shopapp.com is registered, but OpsCrew could not finish");
    expect(error.hint).toContain("opscrew domain buy shopapp.com --registrar porkbun");
    expect(error.hint).toContain("it does not buy the domain again");
    const kept = await readRecord(recordFile(first.deps));
    expect(kept).toMatchObject({ registrar: "porkbun", idempotencyKey: FIRST_KEY });

    // the zone exists already; the rerun reuses it and does not buy again
    const rerun = await project.run();
    const result = setUp(
      await buyDomain(rerun.deps, {
        domain: DOMAIN,
        registrar: "porkbun",
        services: rerun.services,
      }),
    );
    expect(pb.count("register")).toBe(1);
    expect(rerun.handler.requests).toEqual([]);
    expect(result.zoneId).toBe(ZONE);
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
    expect(await exists(recordFile(rerun.deps))).toBe(false);
  });

  it("clears the record after a clear rejection the registrar confirms, naming the registrar's dashboard", async () => {
    const { project, pb } = await porkbunProject();
    pb.failures.register = () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        "Porkbun refused: the monthly API spending limit is reached.",
        {
          hint: `Raise the limit at ${registrarLinks("porkbun").api}, then try again.`,
        },
      );
    const { deps, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Porkbun did not accept the purchase of shopapp.com");
    expect(error.message).toContain("Nothing was bought");
    expect(error.hint).toContain("Raise the limit");
    expect(await exists(recordFile(deps))).toBe(false);
  });

  it("marks an ambiguous answer uncertain and never clears it by itself; hints name the registrar", async () => {
    const { project, pb } = await porkbunProject();
    pb.failures.register = () =>
      new OpsCrewError("PROVIDER_ERROR", "Porkbun gave no clear answer (HTTP 502).");
    const first = await project.run();

    const error = await caught(
      buyDomain(first.deps, { domain: DOMAIN, registrar: "porkbun", services: first.services }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Porkbun did not confirm the purchase of shopapp.com");
    expect(error.hint).toContain(PORKBUN_LINK);
    expect(error.hint).not.toContain("dash.cloudflare.com");
    const file = recordFile(first.deps);
    expect(await readRecord(file)).toMatchObject({ outcome: "uncertain", registrar: "porkbun" });
    pb.failures = {};

    const later = await project.run({ now: "2026-10-11T18:00:00.000Z" });
    const stuck = await caught(
      buyDomain(later.deps, { domain: DOMAIN, registrar: "porkbun", services: later.services }),
    );
    expect(stuck.message).toContain("Porkbun shows no purchase of shopapp.com");
    expect(stuck.hint).toContain(PORKBUN_LINK);
    expect(stuck.hint).toContain("--forget-pending-purchase");
    expect(await exists(file)).toBe(true);
    expect(pb.count("register")).toBe(1);
  });

  it("never clears an order the registrar accepted but does not list yet; only the user forgets it", async () => {
    const { project, nc } = await namecheapProject();
    nc.firstState = "pending";
    nc.messages.pending =
      "Namecheap accepted the order for shopapp.com and is still registering it.";
    nc.unlisted.add(DOMAIN);
    const first = await project.run();

    const error = await caught(
      buyDomain(first.deps, { domain: DOMAIN, registrar: "namecheap", services: first.services }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Namecheap is still processing the purchase of shopapp.com");
    const file = recordFile(first.deps);
    expect(await readRecord(file)).toMatchObject({ outcome: "accepted", registrar: "namecheap" });

    // six hours later Namecheap still lists nothing: the 30-minute rule does not apply
    const later = await project.run({ now: "2026-10-11T18:00:00.000Z" });
    const stuck = await caught(
      buyDomain(later.deps, { domain: DOMAIN, registrar: "namecheap", services: later.services }),
    );
    expect(stuck.code).toBe("PHASE_PRECONDITION");
    expect(stuck.message).toContain("Namecheap accepted the order for shopapp.com");
    expect(stuck.hint).toContain(NAMECHEAP_LINK);
    expect(stuck.hint).toContain("--forget-pending-purchase");
    expect(await exists(file)).toBe(true);
    expect(later.handler.requests).toEqual([]);
    expect(nc.count("register")).toBe(1);

    // once Namecheap lists it, the next run finishes the setup without buying again
    nc.unlisted.delete(DOMAIN);
    nc.progress = ["succeeded"];
    const listed = await project.run({ now: "2026-10-11T19:00:00.000Z" });
    const result = setUp(
      await buyDomain(listed.deps, {
        domain: DOMAIN,
        registrar: "namecheap",
        services: listed.services,
      }),
    );
    expect(result.alreadyRegistered).toBe(false);
    expect(nc.count("register")).toBe(1);
    expect(await exists(file)).toBe(false);
  });

  it("lets the user forget an accepted order after checking the registrar's dashboard", async () => {
    const { project, nc } = await namecheapProject();
    const file = await project.writeRecord({
      domain: DOMAIN,
      accountId: "acc-1",
      requestedAt: "2026-10-10T08:00:00.000Z",
      years: 1,
      autoRenew: true,
      total: usd(9.58),
      registrar: "namecheap",
      idempotencyKey: FIRST_KEY,
      outcome: "accepted",
    });
    const { deps, handler, services } = await project.run();

    const result = await buyDomain(deps, {
      domain: DOMAIN,
      registrar: "namecheap",
      forgetPendingPurchase: true,
      services,
    });

    expect(result.outcome).toBe("forgotten");
    expect(handler.requests[0]?.details).toContain(NAMECHEAP_LINK);
    expect(handler.requests[0]?.details).toContain("Namecheap accepted the order");
    expect(result.next.join("\n")).toContain(
      "opscrew domain buy shopapp.com --registrar namecheap",
    );
    expect(nc.count("register")).toBe(0);
    expect(await exists(file)).toBe(false);
  });

  it("stops plainly when the record names another registrar or domain", async () => {
    const { project, pb } = await porkbunProject();
    await project.writeRecord({
      domain: DOMAIN,
      accountId: "acc-1",
      requestedAt: "2026-10-10T08:00:00.000Z",
      registrar: "namecheap",
      idempotencyKey: FIRST_KEY,
    });
    const { deps, services } = await project.run();

    for (const registrar of ["porkbun", undefined] as const) {
      const error = await caught(
        buyDomain(deps, { domain: DOMAIN, ...(registrar ? { registrar } : {}), services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("Namecheap");
      expect(error.hint).toContain("opscrew domain buy shopapp.com --registrar namecheap");
    }
    const other = await caught(
      buyDomain(deps, { domain: "other.com", registrar: "porkbun", services }),
    );
    expect(other.message).toContain("shopapp.com");
    expect(other.hint).toContain("opscrew domain buy shopapp.com --registrar namecheap");
    expect(other.hint).toContain(NAMECHEAP_LINK);
    expect(pb.count("register")).toBe(0);
    expect(project.cf.count("check")).toBe(0);
  });
});

describe("buyDomain at another registrar: a domain already in the account", () => {
  it("sets up a domain the plan records at that registrar after one domain-settings approval; nothing bought", async () => {
    const { project, pb } = await porkbunProject({ plan: planAt("porkbun") });
    pb.own(DOMAIN);
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(result.alreadyRegistered).toBe(true);
    expect(pb.count("register")).toBe(0);
    expect(pb.count("quote")).toBe(0);
    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    const details = handler.requests[0]?.details ?? "";
    for (const line of [
      "already registered in your Porkbun account, so nothing is bought",
      "Cloudflare zone: created for shopapp.com",
      "Nameservers: OpsCrew then points the nameservers of shopapp.com at Porkbun",
    ]) {
      expect(details).toContain(line);
    }
    const events = project.cf.events;
    expect(events.indexOf("approval domain-settings")).toBeLessThan(
      events.indexOf(`createZone acc-1 ${DOMAIN}`),
    );
    expect(pb.nameservers.get(DOMAIN)).toEqual(ZONE_NAMESERVERS);
    // The zone is still pending: a DS record now could break DNSSEC validation, so connect adds it
    // once the zone is active.
    expect(details).toContain(
      "DNSSEC: not changed now. The Cloudflare zone of shopapp.com is not active yet",
    );
    expect(pb.count("addDsRecord")).toBe(0);
    expect(project.cf.count("enableDnssec")).toBe(0);
    expect(result.next.join("\n")).toContain(
      "once Cloudflare shows its zone as active, run `opscrew domain connect shopapp.com` to add it",
    );
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toMatchObject({ registrar: "porkbun", dnssec: false });
  });

  it("publishes the DS record of a domain the plan records when its zone is active already", async () => {
    const { project, pb } = await porkbunProject({ plan: planAt("porkbun") });
    pb.own(DOMAIN);
    project.cf.zones.set(DOMAIN, {
      id: ZONE,
      name: DOMAIN,
      status: "active",
      nameServers: [...ZONE_NAMESERVERS],
    });
    const { deps, handler, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(handler.requests[0]?.details).toContain(
      "DNSSEC: OpsCrew turns it on for the zone and adds the zone's DS record at Porkbun",
    );
    expect(project.cf.count("enableDnssec")).toBe(1);
    expect(pb.count("addDsRecord")).toBe(1);
    expect(result.next.join("\n")).not.toContain("opscrew domain connect");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.registration).toMatchObject({ registrar: "porkbun", dnssec: true });
  });

  it("skips nameservers already pointing at the zone and a DS record already published", async () => {
    const { project, pb } = await porkbunProject();
    pb.own(DOMAIN);
    pb.nameservers.set(
      DOMAIN,
      [...ZONE_NAMESERVERS].reverse().map((n) => `${n.toUpperCase()}.`),
    );
    project.cf.zones.set(DOMAIN, {
      id: ZONE,
      name: DOMAIN,
      status: "active",
      nameServers: [...ZONE_NAMESERVERS],
    });
    project.cf.dnssec.add(ZONE);
    pb.dsRecords.set(DOMAIN, [
      { keyTag: 2371, algorithm: 13, digestType: 2, digest: "abcdef0123" },
    ]);
    const { deps, services } = await project.run();

    const result = setUp(await buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(pb.count("setNameservers")).toBe(0);
    expect(pb.count("addDsRecord")).toBe(0);
    expect(project.cf.count("enableDnssec")).toBe(0);
    // an active zone needs no activation check
    expect(project.cf.count("activationCheck")).toBe(0);
    expect(result.zoneId).toBe(ZONE);
    expect(deps.audit.entries.some((e) => e.action === "set nameservers")).toBe(false);
  });

  it("does not count a zone in another Cloudflare account as already pointing at Cloudflare", async () => {
    const { project, pb } = await porkbunProject();
    pb.own(DOMAIN);
    pb.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    project.cf.zones.set(DOMAIN, {
      id: ZONE,
      name: DOMAIN,
      status: "active",
      nameServers: [...ZONE_NAMESERVERS],
      accountId: "another-account",
    });
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.hint).toContain("opscrew domain connect shopapp.com");
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("createZone")).toBe(0);
    expect(pb.count("setNameservers")).toBe(0);
  });

  it("waits for a registration under way in the account instead of buying", async () => {
    const { project, gd } = await godaddyProject({ plan: planAt("godaddy") });
    gd.own(DOMAIN);
    gd.registrations.set(DOMAIN, { domain: DOMAIN, state: "in_progress" });
    // the first status read still answers in_progress, the next one succeeded
    gd.progress = ["in_progress", "succeeded"];
    const { deps, handler, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, registrar: "godaddy", services });

    expect(gd.count("register")).toBe(0);
    expect(handler.requests.map((r) => r.kind)).toEqual(["domain-settings"]);
    expect(deps.reporter.text()).toContain("GoDaddy is already registering shopapp.com");
  });

  it("never switches a domain OpsCrew did not buy whose DNS is not on Cloudflare: connect copies the records first", async () => {
    // no purchase record, no registration in the plan, the registrar's own nameservers
    const { project, pb } = await porkbunProject({ plan: domainTestPlan({ domain: DOMAIN }) });
    pb.own(DOMAIN);
    project.cf.zones.set(DOMAIN, {
      id: ZONE,
      name: DOMAIN,
      status: "pending",
      nameServers: [...ZONE_NAMESERVERS],
    });
    const { deps, handler, services } = await project.run();
    const before = await readArtifact("plan", deps.paths.files.plan);

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "porkbun", services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "shopapp.com is already registered in your Porkbun account, but OpsCrew did not buy it and its DNS is not on Cloudflare yet. Switching its nameservers now would stop the records Porkbun serves (website, email). Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Run `opscrew domain connect shopapp.com`: it copies the records into a Cloudflare zone first and asks before switching.",
    );
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("createZone")).toBe(0);
    expect(pb.count("setNameservers")).toBe(0);
    expect(pb.count("addDsRecord")).toBe(0);
    expect(pb.count("register")).toBe(0);
    expect(pb.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.porkbun);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);

    // a plan recording the domain at another registrar does not count either
    const elsewhere = await porkbunProject({ plan: planAt("namecheap") });
    elsewhere.pb.own(DOMAIN);
    const run = await elsewhere.project.run();
    const again = await caught(
      buyDomain(run.deps, { domain: DOMAIN, registrar: "porkbun", services: run.services }),
    );
    expect(again.hint).toContain("opscrew domain connect shopapp.com");
    expect(run.handler.requests).toEqual([]);
  });

  it("does not wait for a registration under way that OpsCrew did not start, and changes nothing", async () => {
    const { project, gd } = await godaddyProject();
    gd.own(DOMAIN);
    gd.registrations.set(DOMAIN, { domain: DOMAIN, state: "in_progress" });
    gd.progress = ["in_progress", "succeeded"];
    const { deps, handler, services } = await project.run();

    const error = await caught(buyDomain(deps, { domain: DOMAIN, registrar: "godaddy", services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("already registered in your GoDaddy account");
    expect(error.hint).toContain("opscrew domain connect shopapp.com");
    expect(handler.requests).toEqual([]);
    expect(project.cf.count("sleep")).toBe(0);
    expect(gd.count("status")).toBe(1);
    expect(deps.reporter.text()).not.toContain("Waiting for GoDaddy");
    expect(project.cf.count("createZone")).toBe(0);
    expect(gd.count("setNameservers")).toBe(0);
    expect(gd.count("register")).toBe(0);
  });
});

describe("buyDomain at another registrar: what the registrar API cannot do", () => {
  it("prints the nameservers with the dashboard link when the registrar cannot set them", async () => {
    const project: DomainProject = await domainProject();
    const nc = project.other("namecheap", { nameservers: false });
    nc.checks.set(DOMAIN, buyable(DOMAIN, 9.58, 14.98));
    const { deps, handler, services } = await project.run();

    const result = setUp(
      await buyDomain(deps, { domain: DOMAIN, registrar: "namecheap", services }),
    );

    expect(nc.count("setNameservers")).toBe(0);
    expect(handler.requests[0]?.details).toContain(
      `Namecheap's API cannot change nameservers, so OpsCrew shows the zone's nameservers to set at ${NAMECHEAP_LINK}`,
    );
    const shown = `${deps.reporter.text()}\n${result.next.join("\n")}`;
    expect(shown).toContain(`${ZONE_NAMESERVERS[0]} and ${ZONE_NAMESERVERS[1]}`);
    expect(shown).toContain(NAMECHEAP_LINK);
    expect(nc.nameservers.get(DOMAIN)).toEqual(DEFAULT_NAMESERVERS.namecheap);
  });
});

describe("buyDomain at another registrar: contact data (SC-702)", () => {
  it("never shows, logs or audits a contact value, on success or on failure", async () => {
    const { project, nc } = await namecheapProject({ plan: domainTestPlan() });
    const ok = await project.run();
    await buyDomain(ok.deps, { domain: DOMAIN, registrar: "namecheap", services: ok.services });
    expect(nc.relayed).toHaveLength(1);
    expect(ok.handler.requests[0]?.details).toContain(MASKED_CONTACT);
    expectNoContact(visibleText(ok.deps));

    const failing = await namecheapProject();
    failing.nc.failures.register = () =>
      new OpsCrewError("PROVIDER_ERROR", "Namecheap gave no clear answer (HTTP 500).");
    const run = await failing.project.run();
    const error = await caught(
      buyDomain(run.deps, { domain: DOMAIN, registrar: "namecheap", services: run.services }),
    );
    expectNoContact(visibleText(run.deps, error));
    expectNoContact(await readFile(recordFile(run.deps), "utf8"));
  });
});
