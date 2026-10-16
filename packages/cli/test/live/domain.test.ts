/**
 * Live domain purchase in Cloudflare's registrar sandbox (simulated purchases, .com and .net only).
 * Skipped unless OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN and OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID are
 * set; see docs/e2e.md. It never buys a real domain: OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1 sends
 * every registrar call to the sandbox and skips the zone and DNSSEC setup.
 */
import { join } from "node:path";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_API, minutes } from "./cloud";
import { plannedProject } from "./harness";

const E2E = {
  token: process.env.OPSCREW_E2E_CLOUDFLARE_REGISTRAR_TOKEN,
  account: process.env.OPSCREW_E2E_CLOUDFLARE_ACCOUNT_ID,
};

interface SearchRow {
  domain: string;
  registrable: boolean;
  firstYear?: { amount: number; currency: string };
}

describe.skipIf(!(E2E.token && E2E.account))("live domain purchase (Cloudflare sandbox)", () => {
  it("checks, buys and confirms a .com without buying a real domain", {
    timeout: minutes(15),
  }, async () => {
    // A planned project (no domain yet), so the purchase is recorded in opscrew/plan.yaml.
    const { repo, opscrew } = await plannedProject({
      CLOUDFLARE_API_TOKEN: E2E.token,
      OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX: "1",
    });

    const name = `opscrew-e2e-${Date.now().toString(36)}`;
    const search = await opscrew(
      "domain",
      "search",
      name,
      "--account",
      E2E.account as string,
      "--json",
    );
    expect(search.exitCode, search.output).toBe(0);
    const parsed = JSON.parse(search.stdout) as { results: SearchRow[] };
    const domain = `${name}.com`;
    // Suggestions may not include the exact name; the purchase checks it live anyway. The sandbox
    // only simulates charges, so a generous bound keeps the test independent of the quote.
    const row = parsed.results.find((r) => r.domain === domain);
    if (row !== undefined) expect(row.registrable, `${domain} is available`).toBe(true);
    const maxPrice = row?.firstYear ? `${row.firstYear.amount}${row.firstYear.currency}` : "100USD";

    // Without --confirm a script must not buy.
    const refused = await opscrew("domain", "buy", domain, "--account", E2E.account as string);
    expect(refused.exitCode, refused.output).toBe(1);
    expect(refused.output).toContain("--confirm");

    const bought = await opscrew(
      "domain",
      "buy",
      domain,
      "--account",
      E2E.account as string,
      "--confirm",
      domain,
      "--max-price",
      maxPrice,
      "--yes",
    );
    expect(bought.exitCode, bought.output).toBe(0);
    expect(bought.output).toContain("sandbox");
    expect(bought.output).not.toContain(E2E.token as string);

    const status = await fetch(
      `${CLOUDFLARE_API}/accounts/${E2E.account}/registrar-sandbox/registrations/${domain}/registration-status`,
      { headers: { Authorization: `Bearer ${E2E.token}` } },
    );
    const body = (await status.json()) as { result?: { state?: string; status?: string } };
    expect(body.result?.state ?? body.result?.status, JSON.stringify(body)).toBe("succeeded");

    // SC-603: the plan records the purchase; status and auto-renew work on it.
    const planFile = join(repo, "opscrew/plan.yaml");
    const plan = await readArtifact("plan", planFile);
    expect(plan.dns.domain).toBe(domain);
    expect(plan.dns.registration).toMatchObject({ registrar: "cloudflare", autoRenew: true });
    const shown = await opscrew("domain", "status", "--account", E2E.account as string);
    expect(shown.exitCode, shown.output).toBe(0);
    expect(shown.output).toContain(domain);
    const off = await opscrew(
      "domain",
      "auto-renew",
      "off",
      "--account",
      E2E.account as string,
      "--confirm",
      domain,
    );
    expect(off.exitCode, off.output).toBe(0);
    expect((await readArtifact("plan", planFile)).dns.registration?.autoRenew).toBe(false);
  });
});
