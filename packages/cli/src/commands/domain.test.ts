import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buyable,
  DEFAULT_NAMESERVERS,
  type FakeRegistrar,
  OLD_DS,
  TOKEN,
  testPlan,
  ZONE_DS,
  ZONE_NAMESERVERS,
} from "@opscrew/agents/testing";
import type { ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DomainTestProject, domainTestProject } from "../ui/__fixtures__/domain";
import { CANCEL, run } from "../ui/__fixtures__/harness";
import type { UiPrompts } from "../ui/prompts";
import { DomainApprovalHandler, localAndUtc, parseMaxPriceFlag, pathArg } from "./domain";

/** The zone's DS record as a registrar holds it (without the zone-file line). */
const { ds: _line, ...ZONE_DS_RECORD } = ZONE_DS;

let current: DomainTestProject | undefined;
afterEach(async () => {
  await current?.project.cleanup();
  current = undefined;
});

async function setup(): Promise<DomainTestProject> {
  current = await domainTestProject();
  return current;
}

/** Requirements that name the domain bought through Cloudflare. */
async function writeRequirements(t: DomainTestProject, domain: string): Promise<void> {
  const requirements: Requirements = {
    schemaVersion: 1,
    answeredAt: "2026-10-01T09:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 20, currency: "EUR" },
    provider: "hetzner",
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    domain,
    dnsProvider: "cloudflare",
    keepExternalServices: [],
  };
  await writeArtifact(
    "requirements",
    path.join(t.project.root, "opscrew", "requirements.yaml"),
    requirements,
  );
}

describe("opscrew domain search", () => {
  it("prints a table, cheapest available first, with the reason for names it cannot buy", async () => {
    const t = await setup();
    t.cf.suggestions = [
      { domain: "shopapp.io", registrable: true },
      { domain: "shopapp.net", registrable: true },
      { domain: "shop-app.com", registrable: true },
    ];
    t.cf.checks.set("shopapp.net", buyable("shopapp.net", 11.84, 12.14));
    t.cf.checks.set("shop-app.com", buyable("shop-app.com", 9.77));
    t.cf.checks.set("shopapp.io", {
      domain: "shopapp.io",
      registrable: false,
      tier: "premium",
      reason: "premium name, buy it in the Cloudflare dashboard",
    });
    const ctx = t.context();

    expect(await run(ctx, "domain", "search", "shopapp.com")).toBe(0);
    const lines = ctx.output.split("\n");
    const table = lines.filter((l) => /^ {2}\S/.test(l));
    expect(table[0]).toMatch(/^ {2}DOMAIN\s+AVAILABLE\s+FIRST YEAR\s+RENEWAL\s+NOTE$/);
    expect(table.slice(1).map((l) => l.trim().split(/\s+/)[0])).toEqual([
      "shop-app.com",
      "shopapp.com",
      "shopapp.net",
      "shopapp.io",
    ]);
    expect(ctx.output).toMatch(/shopapp\.net\s+yes\s+\$11\.84\s+\$12\.14/);
    expect(ctx.output).toMatch(/shopapp\.io\s+no\s+-\s+-\s+premium name, buy it in the Cloudflare/);
    expect(ctx.output).toContain("Next: run `opscrew domain buy shop-app.com`");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("prints JSON with --json and nothing else on stdout", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "search", "shopapp.com", "--json")).toBe(0);
    const parsed = JSON.parse(ctx.output) as { account: { id: string }; results: unknown[] };
    expect(parsed.account.id).toBe("acc-1");
    expect(parsed.results).toEqual([expect.objectContaining({ domain: "shopapp.com" })]);
  });

  it("asks which account to use in a terminal; scripts need --account", async () => {
    const t = await setup();
    t.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const ctx = t.context({ interactive: true, answers: ["acc-2"] });
    expect(await run(ctx, "domain", "search", "shopapp.com")).toBe(0);
    expect(ctx.prompts.calls[0]).toMatchObject({ kind: "select" });
    expect(ctx.output).toContain("on the Cloudflare account Personal");
    // the account list is read once
    expect(t.cf.events.filter((e) => e === "accounts")).toHaveLength(1);

    const script = t.context();
    expect(await run(script, "domain", "search", "shopapp.com")).toBe(2);
    expect(script.errors).toContain("--account");
    expect(await run(script, "domain", "search", "shopapp.com", "--account", "Personal")).toBe(0);
  });
});

describe("opscrew domain buy in a terminal", () => {
  it("shows the price and buys only after the domain is typed (any case)", async () => {
    const t = await setup();
    const ctx = t.context({ interactive: true, answers: ["ShopApp.com"] });

    expect(await run(ctx, "domain", "buy", "shopapp.com")).toBe(0);
    expect(ctx.prompts.calls).toEqual([
      expect.objectContaining({ kind: "text", message: expect.stringContaining("shopapp.com") }),
    ]);
    expect(ctx.prompts.calls[0]?.message).toContain("to buy it");
    expect(ctx.output).toContain("Buy shopapp.com for $10.44 (1 year)");
    expect(ctx.output).toContain("cannot be refunded");
    expect(t.cf.registerCalls).toEqual([
      {
        accountId: "acc-1",
        request: { domain: "shopapp.com", years: 1, autoRenew: true, privacy: true },
      },
    ]);
    expect(ctx.output).toContain("Next: Run `opscrew interview`");
  });

  it("buys nothing when the typed name is wrong or the prompt is cancelled (exit 1)", async () => {
    const t = await setup();
    const wrong = t.context({ interactive: true, answers: ["shopapp.net"] });
    expect(await run(wrong, "domain", "buy", "shopapp.com")).toBe(1);
    expect(wrong.errors).toContain("nothing was bought");
    expect(wrong.errors).toContain("type shopapp.com exactly");

    const cancel = t.context({ interactive: true, answers: [CANCEL] });
    expect(await run(cancel, "domain", "buy", "shopapp.com")).toBe(1);
    expect(cancel.errors).toContain("nothing was bought");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("asks for the typed domain even when --confirm is given without --max-price", async () => {
    const t = await setup();
    const ctx = t.context({ interactive: true, answers: ["no"] });
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--confirm", "shopapp.com")).toBe(1);
    expect(ctx.prompts.calls).toHaveLength(1);
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("passes --years and --no-auto-renew", async () => {
    const t = await setup();
    const ctx = t.context({ interactive: true, answers: ["shopapp.com"] });
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--years", "2", "--no-auto-renew")).toBe(
      0,
    );
    expect(t.cf.registerCalls[0]?.request).toEqual({
      domain: "shopapp.com",
      years: 2,
      autoRenew: false,
      privacy: true,
    });
  });
});

describe("opscrew domain buy in scripts", () => {
  it("refuses without --confirm and --max-price and prints the exact command (exit 1)", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "shopapp.com")).toBe(1);
    expect(ctx.errors).toContain(
      "opscrew domain buy shopapp.com --confirm shopapp.com --max-price 10.44USD",
    );
    expect(ctx.errors).toContain("Nothing was bought.");

    expect(await run(ctx, "domain", "buy", "shopapp.com", "--max-price", "12USD")).toBe(1);
    expect(ctx.errors).toContain(
      "`opscrew domain buy shopapp.com --confirm shopapp.com --max-price 12USD`",
    );
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("quotes --account in the command it prints, as connect and auto-renew do", async () => {
    const t = await setup();
    t.cf.accounts = [
      { id: "acc-1", name: "Shop Team" },
      { id: "acc-2", name: "Personal" },
    ];
    const buy = t.context();
    const args = ["domain", "buy", "shopapp.com", "--account", "Shop Team", "--max-price", "12USD"];
    expect(await run(buy, ...args)).toBe(1);
    expect(buy.errors).toContain(
      "`opscrew domain buy shopapp.com --account 'Shop Team' --confirm shopapp.com --max-price 12USD`",
    );
    expect(t.cf.registerCalls).toEqual([]);

    await writeRequirements(t, "shopapp.com");
    t.cf.own("shopapp.com", { autoRenew: false });
    const renew = t.context();
    expect(await run(renew, "domain", "auto-renew", "on", "--account", "Shop Team")).toBe(1);
    expect(renew.errors).toContain(
      "`opscrew domain auto-renew on --account 'Shop Team' --confirm shopapp.com`",
    );
    expect(t.cf.autoRenewCalls).toEqual([]);
  });

  it("buys with --confirm and --max-price at or above the price", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(
      await run(
        ctx,
        "domain",
        "buy",
        "shopapp.com",
        "--confirm",
        "SHOPAPP.COM",
        "--max-price",
        "10.44 usd",
      ),
    ).toBe(0);
    expect(t.cf.registerCalls).toHaveLength(1);
    expect(ctx.output).toContain("(confirmed with --confirm shopapp.com)");
    expect(ctx.output).toContain("shopapp.com is yours");
    expect(ctx.output).toContain("Next: Run `opscrew interview`");
  });

  it("sets up a domain already on the account with --confirm alone, buying nothing", async () => {
    const t = await setup();
    t.cf.own("shopapp.com");
    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--yes")).toBe(1);
    expect(ctx.errors).toContain("run `opscrew domain buy shopapp.com --confirm shopapp.com`, or");

    expect(await run(ctx, "domain", "buy", "shopapp.com", "--confirm", "shopapp.com")).toBe(0);
    expect(ctx.output).toContain("Set up shopapp.com for this project");
    expect(t.cf.zones.has("shopapp.com")).toBe(true);
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("never buys with --yes", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--yes")).toBe(1);
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--yes", "--max-price", "20")).toBe(1);
    expect(ctx.errors).toContain("--confirm shopapp.com --max-price 20");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("refuses a --confirm that names another domain (exit 1)", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(
      await run(
        ctx,
        "domain",
        "buy",
        "shopapp.com",
        "--confirm",
        "shopapp.net",
        "--max-price",
        "20",
      ),
    ).toBe(1);
    expect(ctx.errors).toContain("--confirm does not match shopapp.com");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("stops when the price is above --max-price or in another currency (exit 1)", async () => {
    const t = await setup();
    const ctx = t.context();
    const buy = (max: string) =>
      run(ctx, "domain", "buy", "shopapp.com", "--confirm", "shopapp.com", "--max-price", max);
    expect(await buy("10.43")).toBe(1);
    expect(ctx.errors).toContain("more than your maximum");
    expect(await buy("20EUR")).toBe(1);
    expect(ctx.errors).toContain("quotes shopapp.com in USD");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("rejects a --max-price it cannot read (exit 2)", async () => {
    const t = await setup();
    const ctx = t.context();
    for (const max of ["cheap", "12,50", "-3", "0", "12.50 GBP"]) {
      expect(
        await run(
          ctx,
          "domain",
          "buy",
          "shopapp.com",
          "--confirm",
          "shopapp.com",
          "--max-price",
          max,
        ),
        max,
      ).toBe(2);
    }
    expect(ctx.errors).toContain("is not a price OpsCrew understands");
    expect(ctx.errors).toContain("USD or EUR");
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("--forget-pending-purchase clears an uncertain purchase note only with the typed domain", async () => {
    const t = await setup();
    await t.writePurchaseRecord({
      domain: "shopapp.com",
      accountId: "acc-1",
      requestedAt: "2026-10-11T11:00:00.000Z",
      outcome: "uncertain",
    });
    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "shopapp.com")).toBe(1);
    expect(ctx.errors).toContain("--forget-pending-purchase");

    expect(
      await run(ctx, "domain", "buy", "shopapp.com", "--forget-pending-purchase", "--yes"),
    ).toBe(1);
    expect(ctx.errors).toContain("--forget-pending-purchase --confirm shopapp.com");
    expect(existsSync(t.recordFile)).toBe(true);

    expect(
      await run(
        ctx,
        "domain",
        "buy",
        "shopapp.com",
        "--forget-pending-purchase",
        "--confirm",
        "shopapp.com",
      ),
    ).toBe(0);
    expect(ctx.output).toContain("(confirmed with --confirm shopapp.com)");
    expect(existsSync(t.recordFile)).toBe(false);
    // forgetting ends the run: buying is a separate run with its own approval
    expect(t.cf.registerCalls).toEqual([]);
    expect(ctx.output).toContain("Next: Run `opscrew domain buy shopapp.com` (without --forget");
  });
});

describe("opscrew domain status and auto-renew", () => {
  it("status shows the registration of the project's domain", async () => {
    const t = await setup();
    await writeRequirements(t, "shopapp.com");
    t.cf.own("shopapp.com");
    t.cf.zones.set("shopapp.com", { id: "zone-1", name: "shopapp.com" });
    t.cf.dnssec.add("zone-1");
    const ctx = t.context();
    expect(await run(ctx, "domain", "status")).toBe(0);
    expect(ctx.output).toMatch(/^shopapp\.com$/m);
    expect(ctx.output).toMatch(/Registrar\s+Cloudflare/);
    expect(ctx.output).toMatch(/Expires\s+2027-01-02/);
    expect(ctx.output).toMatch(/Auto-renew\s+on/);
    expect(ctx.output).toMatch(/Transfer lock\s+on/);
    expect(ctx.output).toMatch(/WHOIS privacy\s+on/);
    expect(ctx.output).toMatch(/DNSSEC\s+on/);
    expect(ctx.output).toContain("opscrew domain auto-renew off");
  });

  it("status without a domain says how to get one", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "status")).toBe(0);
    expect(ctx.output).toContain("opscrew domain search <name>");
  });

  it("auto-renew off needs the typed domain in a terminal", async () => {
    const t = await setup();
    await writeRequirements(t, "shopapp.com");
    t.cf.own("shopapp.com");
    const wrong = t.context({ interactive: true, answers: ["shop"] });
    expect(await run(wrong, "domain", "auto-renew", "off")).toBe(1);
    expect(t.cf.autoRenewCalls).toEqual([]);

    const ctx = t.context({ interactive: true, answers: ["shopapp.com"] });
    expect(await run(ctx, "domain", "auto-renew", "off")).toBe(0);
    expect(ctx.output).toContain("Turn auto-renew off for shopapp.com");
    expect(ctx.prompts.calls[0]?.message).toContain("Type shopapp.com to approve");
    expect(t.cf.autoRenewCalls).toEqual([{ domain: "shopapp.com", on: false }]);
    expect(ctx.output).toContain("opscrew domain auto-renew on");
  });

  it("auto-renew in a script needs --confirm <domain>", async () => {
    const t = await setup();
    await writeRequirements(t, "shopapp.com");
    t.cf.own("shopapp.com", { autoRenew: false });
    const ctx = t.context();
    expect(await run(ctx, "domain", "auto-renew", "on")).toBe(1);
    expect(ctx.errors).toContain("`opscrew domain auto-renew on --confirm shopapp.com`");
    expect(t.cf.autoRenewCalls).toEqual([]);

    expect(await run(ctx, "domain", "auto-renew", "on", "--confirm", "shopapp.com")).toBe(0);
    expect(t.cf.autoRenewCalls).toEqual([{ domain: "shopapp.com", on: true }]);
  });

  it("rejects a state other than on or off (exit 2)", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "auto-renew", "maybe")).toBe(2);
    expect(t.cf.autoRenewCalls).toEqual([]);
  });

  it("auto-renew without a project domain stops with a hint (exit 1)", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "auto-renew", "off", "--confirm", "shopapp.com")).toBe(1);
    expect(ctx.errors).toContain("This project has no domain yet.");
  });
});

describe("opscrew domain exit codes and output", () => {
  it("exits 2 without a token, for a bad domain and for a Cloudflare error, never printing the token", async () => {
    const t = await setup();
    const noToken = t.context({ token: null });
    expect(await run(noToken, "domain", "search", "shopapp")).toBe(2);
    expect(noToken.errors).toContain("CLOUDFLARE_API_TOKEN");

    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "https://shopapp.com/x")).toBe(2);
    expect(ctx.errors).toContain("is not a valid domain name");

    t.cf.failures.check = () =>
      new OpsCrewError("PROVIDER_ERROR", `Cloudflare rejected the request made with ${TOKEN}.`);
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--max-price", "20")).toBe(2);
    expect(await run(ctx, "domain", "search", "shopapp.com")).toBe(2);
    expect(ctx.errors).toContain("Cloudflare rejected the request");
    expect(ctx.output + ctx.errors).not.toContain(TOKEN);
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("exits 1 when a domain cannot be bought (premium, needs the dashboard)", async () => {
    const t = await setup();
    t.cf.checks.set("shopapp.io", {
      domain: "shopapp.io",
      registrable: false,
      tier: "premium",
      reason: "premium name",
    });
    const ctx = t.context({ interactive: true });
    expect(await run(ctx, "domain", "buy", "shopapp.io")).toBe(1);
    expect(ctx.errors).toContain("OpsCrew cannot buy shopapp.io");
    expect(ctx.errors).toContain("opscrew domain search shopapp");
    expect(await run(ctx, "domain", "buy", "shopapp.us")).toBe(1);
    expect(ctx.errors).toContain("extra registrant details");
    expect(ctx.prompts.calls).toEqual([]);
  });

  it("lists the five subcommands and the registrar options in help", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "--help")).toBe(0);
    for (const name of ["search", "buy", "connect", "status", "auto-renew"]) {
      expect(ctx.output).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(await run(ctx, "domain", "buy", "--help")).toBe(0);
    expect(ctx.output).toContain("--max-price <amount>");
    expect(ctx.output).toContain("--forget-pending-purchase");
    expect(ctx.output).toContain("--registrar <id>");
    expect(await run(ctx, "domain", "search", "--help")).toBe(0);
    expect(ctx.output).toContain("--registrar <id>");
    expect(ctx.output).toContain("--compare");
    expect(await run(ctx, "domain", "connect", "--help")).toBe(0);
    for (const option of [
      "--registrar <id>",
      "--records-file <path>",
      "--account <id or name>",
      "--confirm <domain>",
      "--yes",
      "--json",
    ]) {
      expect(ctx.output).toContain(option);
    }
    for (const sub of ["status", "auto-renew"]) {
      expect(await run(ctx, "domain", sub, "--help")).toBe(0);
      expect(ctx.output).toContain("--registrar <id>");
    }
    // never a colon right after an environment variable name
    expect(ctx.output).not.toMatch(/\b[A-Z][A-Z0-9_]{2,}:/);
  });
});

describe("opscrew domain search at other registrars", () => {
  it("--registrar searches that registrar only, without a Cloudflare token", async () => {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.checks.set("shopapp.dev", buyable("shopapp.dev", 9.73, 10.81));
    porkbun.checks.set("shopapp.com", buyable("shopapp.com", 11.08));
    const ctx = t.context({ token: null });

    expect(await run(ctx, "domain", "search", "shopapp.dev", "--registrar", "Porkbun")).toBe(0);
    expect(ctx.output).toContain('Domains for "shopapp.dev" at Porkbun, checked just now:');
    expect(ctx.output).toMatch(/^ {2}DOMAIN\s+AVAILABLE\s+FIRST YEAR\s+RENEWAL\s+NOTE$/m);
    expect(ctx.output).toMatch(/shopapp\.dev\s+yes\s+\$9\.73\s+\$10\.81/);
    expect(ctx.output).toMatch(/shopapp\.net\s+no\s+-\s+-\s+Porkbun did not confirm it/);
    expect(ctx.output).toContain("Next: run `opscrew domain buy shopapp.dev --registrar porkbun`");
    expect(t.cf.events).not.toContain("accounts");
    expect(t.cf.events.filter((e) => e.startsWith("check"))).toEqual([]);
  });

  it("--registrar --json prints the registrar and its results", async () => {
    const t = await setup();
    t.other("porkbun").checks.set("shopapp.dev", buyable("shopapp.dev", 9.73, 10.81));
    const ctx = t.context();
    expect(
      await run(ctx, "domain", "search", "shopapp.dev", "--registrar", "porkbun", "--json"),
    ).toBe(0);
    const parsed = JSON.parse(ctx.output) as {
      registrar: string;
      results: { domain: string; registrable: boolean }[];
    };
    expect(parsed.registrar).toBe("porkbun");
    expect(parsed.results[0]).toMatchObject({ domain: "shopapp.dev", registrable: true });
  });

  it("--compare lists each registrar's prices in the order given, without ranking words", async () => {
    const t = await setup();
    t.other("porkbun").checks.set("shopapp.com", buyable("shopapp.com", 9.73, 10.81));
    t.other("namecheap").checks.set("shopapp.com", {
      domain: "shopapp.com",
      registrable: false,
      reason: "already registered",
    });
    const ctx = t.context();

    expect(await run(ctx, "domain", "search", "shopapp.com", "--compare")).toBe(0);
    const lines = ctx.output.split("\n");
    const block = lines.slice(lines.indexOf("shopapp.com"));
    expect(block[1]).toMatch(/^ {2}REGISTRAR\s+FIRST YEAR\s+RENEWAL\s+NOTE$/);
    expect(block.slice(2, 5).map((l) => l.trim().split(/\s+/)[0])).toEqual([
      "Cloudflare",
      "Porkbun",
      "Namecheap",
    ]);
    expect(ctx.output).toMatch(/Cloudflare\s+\$10\.44\s+\$10\.44/);
    expect(ctx.output).toMatch(/Porkbun\s+\$9\.73\s+\$10\.81/);
    expect(ctx.output).toMatch(/Namecheap\s+-\s+-\s+already registered/);
    expect(ctx.output).toContain("--registrar <id>");
    expect(ctx.output.toLowerCase()).not.toMatch(/cheapest|best|recommend|deal|affiliate|ref=/);
    expect(t.cf.registerCalls).toEqual([]);
  });

  it("--compare --json prints the comparison", async () => {
    const t = await setup();
    t.other("porkbun").checks.set("shopapp.com", buyable("shopapp.com", 9.73, 10.81));
    const ctx = t.context();
    expect(await run(ctx, "domain", "search", "shopapp.com", "--compare", "--json")).toBe(0);
    const parsed = JSON.parse(ctx.output) as {
      comparison: { domain: string; offers: { registrar: string }[] }[];
    };
    expect(parsed.comparison).toHaveLength(1);
    expect(parsed.comparison[0]?.offers.map((o) => o.registrar)).toEqual(["cloudflare", "porkbun"]);
  });

  it("--compare with --registrar and an unknown registrar are usage errors (exit 2)", async () => {
    const t = await setup();
    t.other("porkbun");
    const ctx = t.context();
    expect(
      await run(ctx, "domain", "search", "shopapp", "--compare", "--registrar", "porkbun"),
    ).toBe(2);
    expect(ctx.errors).toContain("cannot be used with");
    expect(await run(ctx, "domain", "search", "shopapp", "--registrar", "gandi")).toBe(2);
    expect(ctx.errors).toContain('OpsCrew does not know the registrar "gandi"');
    expect(ctx.errors).toContain("cloudflare, porkbun, namecheap, godaddy");
    expect(t.cf.events).toEqual([]);
  });
});

describe("opscrew domain buy --registrar", () => {
  it("buys at Porkbun with --confirm and --max-price, then shows the registrar and nameservers", async () => {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.checks.set("shopapp.dev", buyable("shopapp.dev", 9.73, 10.81));
    const ctx = t.context();
    expect(
      await run(
        ctx,
        "domain",
        "buy",
        "shopapp.dev",
        "--registrar",
        "porkbun",
        "--confirm",
        "shopapp.dev",
        "--max-price",
        "10USD",
      ),
    ).toBe(0);
    expect(ctx.output).toContain("Buy shopapp.dev at Porkbun for $9.73");
    expect(ctx.output).toContain("(confirmed with --confirm shopapp.dev)");
    expect(porkbun.registerCalls).toHaveLength(1);
    expect(t.cf.registerCalls).toEqual([]);
    expect(ctx.output).toMatch(/^ {2}Registrar\s+Porkbun$/m);
    expect(ctx.output).toMatch(
      /^ {2}Nameservers\s+kim\.ns\.cloudflare\.com, lee\.ns\.cloudflare\.com$/m,
    );
    expect(t.cf.events).toContain(
      "porkbun setNameservers shopapp.dev kim.ns.cloudflare.com,lee.ns.cloudflare.com",
    );
    expect(t.cf.events).toContain("porkbun addDsRecord shopapp.dev 2371");
    expect(ctx.output).toContain("Cloudflare activates the zone for shopapp.dev");
  });

  it("never buys at another registrar with --yes; the hint names the registrar", async () => {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.checks.set("shopapp.dev", buyable("shopapp.dev", 9.73, 10.81));
    const ctx = t.context();
    expect(await run(ctx, "domain", "buy", "shopapp.dev", "--registrar", "porkbun", "--yes")).toBe(
      1,
    );
    expect(ctx.errors).toContain(
      "opscrew domain buy shopapp.dev --registrar porkbun --confirm shopapp.dev --max-price 9.73USD",
    );
    expect(
      await run(
        ctx,
        "domain",
        "buy",
        "shopapp.dev",
        "--registrar",
        "porkbun",
        "--yes",
        "--max-price",
        "20",
      ),
    ).toBe(1);
    expect(ctx.errors).toContain(
      "`opscrew domain buy shopapp.dev --registrar porkbun --confirm shopapp.dev --max-price 20`",
    );
    expect(porkbun.registerCalls).toEqual([]);
  });
});

describe("opscrew domain status and auto-renew --registrar", () => {
  it("status reads the registration from the given registrar", async () => {
    const t = await setup();
    await writeRequirements(t, "shopapp.dev");
    t.other("porkbun").own("shopapp.dev", { autoRenew: false });
    const ctx = t.context({ token: null });
    expect(await run(ctx, "domain", "status", "--registrar", "porkbun")).toBe(0);
    expect(ctx.output).toMatch(/^shopapp\.dev$/m);
    expect(ctx.output).toMatch(/Registrar\s+Porkbun/);
    expect(ctx.output).toMatch(/Auto-renew\s+off/);
    expect(t.cf.events).not.toContain("accounts");
  });

  it("status and auto-renew of a domain the plan records at Porkbun never ask for a Cloudflare account", async () => {
    const t = await setup();
    t.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const plan = testPlan({ domain: "shopapp.dev", userSecret: false });
    await writeArtifact("plan", path.join(t.project.root, "opscrew", "plan.yaml"), {
      ...plan,
      dns: {
        ...plan.dns,
        zone: "shopapp.dev",
        registration: { registrar: "porkbun", autoRenew: true, privacy: true, dnssec: true },
      },
    });
    const porkbun = t.other("porkbun");
    porkbun.own("shopapp.dev");
    const ctx = t.context({ interactive: true });
    expect(await run(ctx, "domain", "status")).toBe(0);
    expect(ctx.prompts.calls).toEqual([]);
    expect(ctx.output).toMatch(/Registrar\s+Porkbun/);
    expect(t.cf.events).not.toContain("accounts");

    const renew = t.context({ interactive: true, answers: ["shopapp.dev"] });
    expect(await run(renew, "domain", "auto-renew", "off")).toBe(0);
    expect(renew.prompts.calls.map((c) => c.kind)).toEqual(["text"]);
    expect(porkbun.autoRenewCalls).toEqual([{ domain: "shopapp.dev", on: false }]);
    expect(t.cf.events).not.toContain("accounts");
  });

  it("status of a Cloudflare domain still asks which of several accounts, once the agents need it", async () => {
    const t = await setup();
    t.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    await writeRequirements(t, "shopapp.com");
    t.cf.own("shopapp.com");
    const ctx = t.context({ interactive: true, answers: ["acc-1"] });
    expect(await run(ctx, "domain", "status")).toBe(0);
    expect(ctx.prompts.calls).toEqual([expect.objectContaining({ kind: "select" })]);
    expect(ctx.output).toMatch(/Registrar\s+Cloudflare/);

    const script = t.context();
    expect(await run(script, "domain", "status")).toBe(2);
    expect(script.errors).toContain("--account");
  });

  it("auto-renew at Porkbun needs the typed domain; the hint keeps --registrar", async () => {
    const t = await setup();
    await writeRequirements(t, "shopapp.dev");
    const porkbun = t.other("porkbun");
    porkbun.own("shopapp.dev");
    const ctx = t.context();
    expect(await run(ctx, "domain", "auto-renew", "off", "--registrar", "porkbun")).toBe(1);
    expect(ctx.errors).toContain(
      "`opscrew domain auto-renew off --registrar porkbun --confirm shopapp.dev`",
    );
    expect(porkbun.autoRenewCalls).toEqual([]);
    expect(
      await run(
        ctx,
        "domain",
        "auto-renew",
        "off",
        "--registrar",
        "porkbun",
        "--confirm",
        "shopapp.dev",
      ),
    ).toBe(0);
    expect(porkbun.autoRenewCalls).toEqual([{ domain: "shopapp.dev", on: false }]);
    expect(t.cf.autoRenewCalls).toEqual([]);
  });
});

describe("opscrew domain connect", () => {
  const DOMAIN = "example.com";
  const MX = { type: "MX", name: DOMAIN, content: "mx1.mail.example.net", priority: 10 };
  const TXT = { type: "TXT", name: DOMAIN, content: "v=spf1 include:_spf.mail.example.net ~all" };

  /** A domain at Porkbun whose DNS Porkbun serves (MX and TXT). */
  async function atPorkbun(): Promise<{ t: DomainTestProject; porkbun: FakeRegistrar }> {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.own(DOMAIN);
    porkbun.records.set(DOMAIN, [{ ...MX }, { ...TXT }]);
    return { t, porkbun };
  }

  /** The domain already points at its active Cloudflare zone. */
  async function connected(): Promise<{ t: DomainTestProject; porkbun: FakeRegistrar }> {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.own(DOMAIN);
    porkbun.nameservers.set(DOMAIN, [...ZONE_NAMESERVERS]);
    t.cf.zones.set(DOMAIN, {
      id: "zone-1",
      name: DOMAIN,
      status: "active",
      nameServers: [...ZONE_NAMESERVERS],
    });
    return { t, porkbun };
  }

  it("copies the records, then switches the nameservers with --confirm (connected, exit 0)", async () => {
    const { t, porkbun } = await atPorkbun();
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--confirm", DOMAIN)).toBe(0);
    expect(ctx.output).toContain("Move the DNS of example.com to Cloudflare");
    expect(ctx.output).toContain("(confirmed with --confirm example.com)");
    expect(ctx.output).toContain(
      "example.com is connected: its DNS is on Cloudflare and its nameservers at Porkbun point at it.",
    );
    // one success message: the summary
    expect(ctx.output).not.toContain("now uses Cloudflare DNS");
    expect(ctx.output).toMatch(/^ {2}Registrar\s+Porkbun$/m);
    expect(ctx.output).toMatch(/^ {2}Records copied\s+2$/m);
    expect(ctx.output).toMatch(
      /^ {2}Nameservers\s+kim\.ns\.cloudflare\.com, lee\.ns\.cloudflare\.com$/m,
    );
    expect(ctx.output).toContain("Cloudflare activates the zone for example.com");
    const copy = t.cf.events.indexOf(`createRecords zone-${DOMAIN} MX,TXT`);
    const switched = t.cf.events.findIndex((e) => e.startsWith("porkbun setNameservers"));
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(switched).toBeGreaterThan(copy);
    expect(porkbun.nameservers.get(DOMAIN)).toEqual([...ZONE_NAMESERVERS]);
  });

  it("--yes alone never approves the switch without a terminal (exit 1, with the exact command)", async () => {
    const { t, porkbun } = await atPorkbun();
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--yes")).toBe(1);
    expect(ctx.errors).toContain("`opscrew domain connect example.com --confirm example.com`");
    expect(ctx.errors).toContain("This run is not interactive");
    // the exact command is shown once
    expect(ctx.errors.split("--confirm example.com`")).toHaveLength(2);
    expect(t.cf.zones.has(DOMAIN)).toBe(false);
    expect(porkbun.nameservers.get(DOMAIN)).toEqual([...DEFAULT_NAMESERVERS.porkbun]);
  });

  it("--confirm answers both typed approvals of one run (scan zone, then copy and switch)", async () => {
    const t = await setup();
    const porkbun = t.other("porkbun");
    porkbun.own(DOMAIN);
    porkbun.nameservers.set(DOMAIN, ["ns1.dns-host.example.net", "ns2.dns-host.example.net"]);
    t.zones.scans.set(DOMAIN, [{ ...MX }]);
    const ctx = t.context({ interactive: true });
    expect(await run(ctx, "domain", "connect", DOMAIN, "--confirm", DOMAIN)).toBe(0);
    expect(ctx.prompts.calls).toEqual([]);
    expect(ctx.output).toContain("Create a Cloudflare zone for example.com to scan");
    expect(ctx.output).toContain("Move the DNS of example.com to Cloudflare");
    expect(ctx.output.split("(confirmed with --confirm example.com)")).toHaveLength(3);
    expect(ctx.output).toMatch(/^ {2}Records copied\s+1$/m);
    expect(porkbun.nameservers.get(DOMAIN)).toEqual([...ZONE_NAMESERVERS]);
  });

  it("passes --records-file, --registrar and --account; the refusal shows only the exact command", async () => {
    const t = await setup();
    t.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Personal" },
    ];
    const porkbun = t.other("porkbun");
    porkbun.own(DOMAIN);
    await writeFile(
      path.join(t.project.root, "zone.txt"),
      [
        "$ORIGIN example.com.",
        "@ 300 IN A 192.0.2.10",
        "@ 300 IN MX 10 mx1.mail.example.net.",
        "",
      ].join("\n"),
    );
    const args = [
      "domain",
      "connect",
      DOMAIN,
      "--registrar",
      "porkbun",
      "--records-file",
      "zone.txt",
      "--account",
      "acc-2",
    ];
    const refused = t.context();
    expect(await run(refused, ...args, "--yes")).toBe(1);
    expect(refused.errors).toBe(
      [
        "✗ example.com was not moved to Cloudflare; OpsCrew changed nothing.",
        "  This run is not interactive, so OpsCrew needs the domain typed again: run `opscrew domain connect example.com --registrar porkbun --records-file zone.txt --account acc-2 --confirm example.com`, or run the command in a terminal.",
        "",
      ].join("\n"),
    );
    expect(refused.output + refused.errors).not.toContain(
      "opscrew domain connect example.com --confirm example.com",
    );
    expect(t.cf.zones.has(DOMAIN)).toBe(false);

    const ctx = t.context();
    expect(await run(ctx, ...args, "--confirm", DOMAIN)).toBe(0);
    expect(ctx.output).toContain("zone.txt");
    expect(ctx.output).toContain("Cloudflare account: Personal (acc-2)");
    expect(ctx.output).toMatch(/^ {2}Records copied\s+2$/m);
    expect(t.cf.events).toContain(`createRecords zone-${DOMAIN} A,MX`);
  });

  it("waits for old DNSSEC records: says when to run again with the run's flags, in local time and UTC (exit 0)", async () => {
    const { t, porkbun } = await atPorkbun();
    porkbun.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const flags = ["--registrar", "porkbun", "--account", "acc-1"];
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, ...flags, "--confirm", DOMAIN)).toBe(0);
    expect(t.cf.events).toContain("porkbun removeDsRecord example.com 4012");
    expect(t.cf.events.some((e) => e.startsWith("porkbun setNameservers"))).toBe(false);
    expect(ctx.output).toContain(
      "example.com is not switched yet: OpsCrew waits until resolvers have forgotten its old DNSSEC records, at ",
    );
    expect(ctx.output).toMatch(/^ {2}Records copied\s+2$/m);
    // The command to run again is shown once (the agents' next step, with the run's flags).
    const summary = ctx.output.slice(ctx.output.indexOf("example.com is not switched yet"));
    expect(summary.split("again after")).toHaveLength(2);
    expect(ctx.output).toContain(
      "Run `opscrew domain connect example.com --registrar porkbun --account acc-1` again after ",
    );

    // The next run still waits, for the same time: its JSON gives the exact moment.
    const again = t.context();
    expect(await run(again, "domain", "connect", DOMAIN, ...flags, "--json")).toBe(0);
    const { outcome, waitUntil } = JSON.parse(again.output) as {
      outcome: string;
      waitUntil: string;
    };
    expect(outcome).toBe("waiting-for-ds");
    const utc = new Date(waitUntil).toISOString().slice(0, 16).replace("T", " ");
    expect(ctx.output).toContain(
      `forgotten its old DNSSEC records, at ${localAndUtc(waitUntil)}; see the next steps.`,
    );
    expect(localAndUtc(waitUntil)).toMatch(
      new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d local time \\(${utc} UTC\\)$`),
    );
  });

  it("asks for the typed domain in a terminal: the domain approves, anything else changes nothing", async () => {
    const typed = await atPorkbun();
    const ok = typed.t.context({ interactive: true, answers: [DOMAIN] });
    expect(await run(ok, "domain", "connect", DOMAIN)).toBe(0);
    expect(ok.prompts.calls).toEqual([
      expect.objectContaining({
        kind: "text",
        message: "Type example.com to approve (anything else cancels)",
      }),
    ]);
    expect(typed.porkbun.nameservers.get(DOMAIN)).toEqual([...ZONE_NAMESERVERS]);
    await typed.t.project.cleanup();

    for (const answer of ["example.net", CANCEL]) {
      const { t, porkbun } = await atPorkbun();
      const ctx = t.context({ interactive: true, answers: [answer] });
      expect(await run(ctx, "domain", "connect", DOMAIN), String(answer)).toBe(1);
      expect(ctx.errors).toContain(
        "example.com was not moved to Cloudflare; OpsCrew changed nothing.",
      );
      expect(t.cf.zones.has(DOMAIN)).toBe(false);
      expect(t.cf.events.some((e) => e.startsWith("porkbun setNameservers"))).toBe(false);
      expect(porkbun.nameservers.get(DOMAIN)).toEqual([...DEFAULT_NAMESERVERS.porkbun]);
      await t.project.cleanup();
    }
  });

  it("refuses a --confirm that names another domain (exit 1)", async () => {
    const { t, porkbun } = await atPorkbun();
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--confirm", "other.com")).toBe(1);
    expect(ctx.errors).toContain(
      "--confirm does not match example.com. To approve it, run `opscrew domain connect example.com --confirm example.com`.",
    );
    expect(t.cf.zones.has(DOMAIN)).toBe(false);
    expect(t.cf.events.some((e) => e.startsWith("porkbun setNameservers"))).toBe(false);
    expect(porkbun.nameservers.get(DOMAIN)).toEqual([...DEFAULT_NAMESERVERS.porkbun]);
  });

  it("--json prints the result object only", async () => {
    const { t, porkbun } = await atPorkbun();
    porkbun.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--confirm", DOMAIN, "--json")).toBe(0);
    const parsed = JSON.parse(ctx.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      outcome: "waiting-for-ds",
      domain: DOMAIN,
      registrar: "porkbun",
      copied: 2,
      waitUntil: expect.any(String),
      next: expect.any(Array),
    });
    expect(ctx.errors).toContain("(confirmed with --confirm example.com)");
  });

  it("turns DNSSEC on for a connected domain with --confirm (dnssec-published, exit 0)", async () => {
    const { t, porkbun } = await connected();
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--confirm", DOMAIN)).toBe(0);
    expect(ctx.output).toContain("Turn on DNSSEC for example.com");
    expect(ctx.output).toContain("example.com is connected and DNSSEC is published.");
    expect(ctx.output).toMatch(/^ {2}DNSSEC\s+on$/m);
    expect(porkbun.dsRecords.get(DOMAIN)).toEqual([ZONE_DS_RECORD]);
  });

  it("already connected: nothing to switch (exit 0)", async () => {
    const { t, porkbun } = await connected();
    porkbun.dsRecords.set(DOMAIN, [{ ...ZONE_DS_RECORD }]);
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN)).toBe(0);
    expect(ctx.output).toContain(
      "example.com is already connected: its nameservers point at its Cloudflare zone, so nothing was switched.",
    );
    expect(ctx.output).toMatch(/^ {2}Records copied\s+0$/m);
    expect(t.cf.events.some((e) => e.startsWith("porkbun setNameservers"))).toBe(false);
  });

  it("refuses Cloudflare as the registrar and needs a Cloudflare token (exit 2)", async () => {
    const { t } = await atPorkbun();
    const ctx = t.context();
    expect(await run(ctx, "domain", "connect", DOMAIN, "--registrar", "cloudflare")).toBe(2);
    expect(ctx.errors).toContain("nothing to connect");
    const noToken = t.context({ token: null });
    expect(await run(noToken, "domain", "connect", DOMAIN, "--confirm", DOMAIN)).toBe(2);
    expect(noToken.errors).toContain("CLOUDFLARE_API_TOKEN");
  });
});

describe("DomainApprovalHandler", () => {
  const purchase: ApprovalRequest = {
    kind: "domain-purchase",
    title: "Buy shopapp.com for $10.44 (1 year)",
    details: "Domain purchases cannot be refunded.",
    confirmPhrase: "shopapp.com",
  };
  const prompts = (answer: unknown): UiPrompts => ({
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(async () => answer as string),
    confirm: vi.fn(),
    password: vi.fn(),
    isCancel: (value: unknown): value is symbol => value === CANCEL,
  });
  // A base handler that approves everything, as `--yes` or a careless fake would.
  const approveAll: ApprovalHandler = {
    request: vi.fn(async () => ({ approved: true, approver: "--yes flag", decidedAt: "now" })),
  };

  it("never lets the base handler (or --yes) decide a purchase or a domain setting", async () => {
    for (const request of [purchase, { ...purchase, kind: "domain-settings" as const }]) {
      const handler = new DomainApprovalHandler(approveAll, {
        interactive: false,
        priceBound: true,
        prompts: prompts("shopapp.com"),
        print: () => {},
      });
      expect((await handler.request(request)).approved).toBe(false);
    }
    expect(approveAll.request).not.toHaveBeenCalled();
    const other = new DomainApprovalHandler(approveAll, {
      interactive: false,
      priceBound: false,
      prompts: prompts(""),
      print: () => {},
    });
    expect((await other.request({ kind: "repo-write", title: "w", details: "" })).approved).toBe(
      true,
    );
  });

  it("approves a purchase with --confirm only together with a price bound", async () => {
    const base = { request: vi.fn() };
    const make = (priceBound: boolean, interactive = false) =>
      new DomainApprovalHandler(base, {
        interactive,
        confirm: "ShopApp.com.",
        priceBound,
        prompts: prompts("nope"),
        print: () => {},
      });
    expect(await make(true).request(purchase)).toMatchObject({
      approved: true,
      confirmation: "shopapp.com",
    });
    expect((await make(false).request(purchase)).approved).toBe(false);
    expect((await make(false, true).request(purchase)).approved).toBe(false);
    expect((await make(false).request({ ...purchase, kind: "domain-settings" })).approved).toBe(
      true,
    );
    expect(base.request).not.toHaveBeenCalled();
  });

  it("returns the canonical phrase so the approval gate accepts a typed name in another case", async () => {
    const handler = new DomainApprovalHandler(approveAll, {
      interactive: true,
      priceBound: false,
      prompts: prompts("  SHOPAPP.com "),
      print: () => {},
    });
    expect(await handler.request(purchase)).toMatchObject({
      approved: true,
      approver: "typed domain name",
      confirmation: "shopapp.com",
    });
  });
});

describe("pathArg and localAndUtc", () => {
  it("prints paths with / and single-quotes anything a shell would change", () => {
    expect(pathArg("zone.txt")).toBe("zone.txt");
    expect(pathArg("dns\\zones\\example.com.txt")).toBe("dns/zones/example.com.txt");
    expect(pathArg("my zones/example.txt")).toBe("'my zones/example.txt'");
    expect(pathArg("zones/$HOME.txt")).toBe("'zones/$HOME.txt'");
    expect(pathArg("it's.txt")).toBe("'it'\\''s.txt'");
  });

  it("shows a time in the local time zone and in UTC", () => {
    const iso = "2026-10-12T13:05:00.000Z";
    const local = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const shown = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
    expect(localAndUtc(iso)).toBe(`${shown} local time (2026-10-12 13:05 UTC)`);
  });
});

describe("parseMaxPriceFlag", () => {
  it("reads an amount with an optional currency", () => {
    expect(parseMaxPriceFlag("12.50")).toEqual({ amount: 12.5 });
    expect(parseMaxPriceFlag("12.50USD")).toEqual({ amount: 12.5, currency: "USD" });
    expect(parseMaxPriceFlag(" 12.50 eur ")).toEqual({ amount: 12.5, currency: "EUR" });
    expect(parseMaxPriceFlag("9")).toEqual({ amount: 9 });
  });

  it("rejects anything else with INVALID_INPUT", () => {
    for (const value of ["", "abc", "12,50", "-1", "0", "12.50 GBP", "USD12", "12.50 US"]) {
      expect(() => parseMaxPriceFlag(value), value).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });
});
