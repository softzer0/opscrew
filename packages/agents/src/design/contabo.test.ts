// Design on Contabo, whose Auto Backup OpsCrew turns on (027 T2751): on by default in prod when the
// data matters (T2750), and priced on Contabo's order page only (R15), never in the monthly sum.
import { cloudProvider } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { makeRequirements, nextPostgresFacts } from "../testing";
import { buildDesignOptions } from "./options";

const requirements = makeRequirements({
  provider: "contabo",
  region: "eu-central",
  dataCriticality: "important",
  budgetMonthly: { amount: 50, currency: "EUR" },
});

/** Contabo's dated static catalogue, as design reads it through the registry. */
const catalog = () => cloudProvider("contabo").connector({ env: {} }).catalog();

const ORDER_PAGE =
  "Contabo's automated backups are not in this price: they are priced on Contabo's order page.";

describe("buildDesignOptions on Contabo", () => {
  it("turns Auto Backup on in prod when the data matters, outside the monthly sum, priced on the order page", async () => {
    const [lean] = await buildDesignOptions({
      facts: nextPostgresFacts(),
      requirements,
      catalog: catalog(),
    });
    expect(lean?.target).toMatchObject({ provider: "contabo", serverType: "V153" });
    expect(lean?.backups).toBe(true);
    // The server alone: no backups line, and never one at €0.
    expect(lean?.cost.breakdown).toEqual([
      { item: "Server V153 (EU)", monthly: { amount: 5.5, currency: "EUR" } },
    ]);
    expect(lean?.cost.monthly).toEqual({ amount: 5.5, currency: "EUR" });
    expect(lean?.summary).toContain(
      `Automated backups are on in prod, as the data matters. ${ORDER_PAGE}`,
    );
    expect(lean?.summary).not.toContain("offers no automatic backups");
  });

  it("leaves Auto Backup off outside prod, without the price sentence", async () => {
    const [lean] = await buildDesignOptions({
      facts: nextPostgresFacts(),
      requirements,
      catalog: catalog(),
      environment: "staging",
    });
    expect(lean?.backups).toBe(false);
    expect(lean?.summary).toContain("Automated backups are off in staging");
    expect(lean?.summary).not.toContain(ORDER_PAGE);
    expect(lean?.tradeoffs).toContain(
      "No automated backups outside prod; to turn them on, set target.backups to true in the plan and run `opscrew design` again.",
    );
  });
});
