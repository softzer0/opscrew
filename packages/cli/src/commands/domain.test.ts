import { existsSync } from "node:fs";
import path from "node:path";
import type { ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buyable,
  CF_TOKEN,
  type DomainTestProject,
  domainTestProject,
} from "../ui/__fixtures__/domain";
import { CANCEL, run } from "../ui/__fixtures__/harness";
import type { UiPrompts } from "../ui/prompts";
import { DomainApprovalHandler, parseMaxPriceFlag } from "./domain";

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

    t.cf.checkError = new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare rejected the request made with ${CF_TOKEN}.`,
    );
    expect(await run(ctx, "domain", "buy", "shopapp.com", "--max-price", "20")).toBe(2);
    expect(await run(ctx, "domain", "search", "shopapp.com")).toBe(2);
    expect(ctx.errors).toContain("Cloudflare rejected the request");
    expect(ctx.output + ctx.errors).not.toContain(CF_TOKEN);
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

  it("lists the four subcommands in help", async () => {
    const t = await setup();
    const ctx = t.context();
    expect(await run(ctx, "domain", "--help")).toBe(0);
    for (const name of ["search", "buy", "status", "auto-renew"]) {
      expect(ctx.output).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(await run(ctx, "domain", "buy", "--help")).toBe(0);
    expect(ctx.output).toContain("--max-price <amount>");
    expect(ctx.output).toContain("--forget-pending-purchase");
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
