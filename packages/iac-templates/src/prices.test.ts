import { describe, expect, it } from "vitest";
import { STORAGE_PRICES } from "./index";

const GIB_IN_GB = 1.073741824;
const price = (
  provider: keyof typeof STORAGE_PRICES,
  storageGb: number,
  egressGbPerMonth: number,
) => STORAGE_PRICES[provider].monthlyPrice({ storageGb, egressGbPerMonth });

describe("STORAGE_PRICES", () => {
  it("prices each provider for 10 GB stored and 50 GB out, with its source and date", () => {
    expect(price("r2", 10, 50)).toMatchObject({ amount: 0, currency: "USD" });
    expect(price("digitalocean", 10, 50)).toMatchObject({ amount: 5, currency: "USD" });
    expect(price("hetzner", 10, 50)).toMatchObject({ amount: 6.49, currency: "EUR" });
    expect(price("garage", 10, 50)).toMatchObject({ amount: 0 });
    for (const provider of Object.keys(STORAGE_PRICES) as (keyof typeof STORAGE_PRICES)[]) {
      const { source, checkedOn } = price(provider, 10, 50);
      expect(source, provider).toMatch(/^https:\/\//);
      expect(checkedOn, provider).toBe("2026-10-19");
    }
  });

  it("R2: storage after 10 GB-months, by the started GB-month; egress is free", () => {
    expect(price("r2", 0, 0).amount).toBe(0);
    expect(price("r2", 10, 0).amount).toBe(0);
    expect(price("r2", 11, 0).amount).toBeCloseTo(0.015);
    expect(price("r2", 10.1, 0).amount).toBeCloseTo(0.015);
    expect(price("r2", 110, 0).amount).toBeCloseTo(1.5);
    expect(price("r2", 10, 9_000).amount).toBe(0);
    expect(price("r2", 10, 50).note).toBeUndefined();
  });

  it("R2: operations estimated from use, billed by the started million after the free tier", () => {
    // 1,000 Class A per GB stored: the free million lasts up to 1,000 GB.
    expect(price("r2", 1_000, 0).amount).toBeCloseTo(0.015 * 990);
    expect(price("r2", 1_001, 0).amount).toBeCloseTo(0.015 * 991 + 4.5);
    // 1,000 Class B per GB out: the free 10 million last up to 10,000 GB.
    expect(price("r2", 10, 10_000).amount).toBe(0);
    expect(price("r2", 10, 10_001).amount).toBeCloseTo(0.36);
    expect(price("r2", 10, 11_001).amount).toBeCloseTo(0.72);
  });

  it("Spaces: USD 5 with 250 GiB stored and 1,024 GiB out, then per GiB", () => {
    expect(price("digitalocean", 0, 0).amount).toBe(5);
    expect(price("digitalocean", 250 * GIB_IN_GB, 1_024 * GIB_IN_GB).amount).toBeCloseTo(5);
    expect(price("digitalocean", 251 * GIB_IN_GB, 0).amount).toBeCloseTo(5.02);
    expect(price("digitalocean", 0, 1_025 * GIB_IN_GB).amount).toBeCloseTo(5.01);
    expect(price("digitalocean", 350 * GIB_IN_GB, 1_124 * GIB_IN_GB).amount).toBeCloseTo(8);
    // 250 GB is less than 250 GiB.
    expect(price("digitalocean", 260, 0).amount).toBe(5);
    expect(price("digitalocean", 10, 50).note).toMatch(/per account/);
  });

  it("Hetzner: EUR 6.49 per account with 1 TB-month stored and 1.116 TB out, then per TB", () => {
    expect(price("hetzner", 0, 0).amount).toBe(6.49);
    expect(price("hetzner", 1_000, 1_116).amount).toBeCloseTo(6.49);
    expect(price("hetzner", 2_000, 0).amount).toBeCloseTo(6.49 + 6.26);
    expect(price("hetzner", 1_100, 0).amount).toBeCloseTo(6.49 + 0.626);
    expect(price("hetzner", 0, 2_116).amount).toBeCloseTo(7.49);
    expect(price("hetzner", 0, 1_216).amount).toBeCloseTo(6.59);
    expect(price("hetzner", 3_000, 3_116).amount).toBeCloseTo(6.49 + 2 * 6.26 + 2);
    expect(price("hetzner", 10, 50).note).toMatch(/per account/);
  });

  it("Garage: free, on the server's own disk", () => {
    expect(price("garage", 5_000, 50_000).amount).toBe(0);
    expect(price("garage", 10, 50).note).toMatch(/server's own disk/);
  });
});
