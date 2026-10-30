import { type CostEstimate, type PlanService, PlanServiceSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { euCatalog, MemoryCatalog, offer } from "../testing";
import { designCloudServer, extraServerNeed, sizeExtraServer, totalCost } from "./servers";
import { selfHostedServices } from "./sizing";

const [db, cache] = selfHostedServices({ postgres: true, redis: true }) as [
  PlanService,
  PlanService,
];
const dragonfly = PlanServiceSchema.parse({
  ...cache,
  kind: "dragonfly",
  memoryMb: 512,
  options: { mode: "cache" },
});
const app = {
  provider: "hetzner",
  mode: "vps-compose",
  location: "fsn1",
  serverType: "cx13",
  image: "ubuntu-24.04",
  backups: false,
  edge: "caddy",
} as const;

describe("an extra server's size", () => {
  it("holds its services' limits plus the system's share, and each one's smallest server", () => {
    // Postgres 512 MB + 384 MB for the system, but Postgres wants a 1 GB server.
    expect(extraServerNeed([db])).toEqual({ memoryMb: 1024, vcpus: 1 });
    expect(extraServerNeed([db, cache])).toEqual({ memoryMb: 1024, vcpus: 1 });
    expect(extraServerNeed([{ ...db, memoryMb: 2048 }])).toEqual({ memoryMb: 2432, vcpus: 1 });
    // A service turned off counts for nothing; Dragonfly needs 2 vCPUs.
    expect(extraServerNeed([{ ...db, enabled: false }])).toEqual({ memoryMb: 384, vcpus: 1 });
    expect(extraServerNeed([dragonfly])).toEqual({ memoryMb: 2048, vcpus: 2 });
  });

  it("is the cheapest available x86 type there that holds them", async () => {
    // fsn1: the deprecated, ARM and unavailable traps are skipped; cx13 is the cheapest left.
    expect((await sizeExtraServer(euCatalog(), "fsn1", [db]))?.id).toBe("cx13");
    // nbg1 has no available cx13.
    expect((await sizeExtraServer(euCatalog(), "nbg1", [db]))?.id).toBe("cx23");
    expect((await sizeExtraServer(euCatalog(), "fsn1", [{ ...db, memoryMb: 8 * 1024 }]))?.id).toBe(
      "cx43",
    );
    expect(await sizeExtraServer(euCatalog(), "fsn1", [{ ...db, memoryMb: 64 * 1024 }])).toBe(
      undefined,
    );
  });

  it("refuses a server no type there can hold, saying what it needs", async () => {
    const small = new MemoryCatalog([
      offer({ id: "cx11", vcpus: 1, memoryGb: 2, diskGb: 20, price: 1, location: "fsn1" }),
    ]);
    const error = await designCloudServer({
      name: "cache",
      target: undefined,
      services: [dragonfly],
      app,
      region: "eu-central",
      backups: false,
      catalogFor: async () => small,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "No available x86 Hetzner server in fsn1 has the 2 GB of memory and 2 vCPUs server cache needs for cache and the system. plan.yaml was not changed.",
    });
  });
});

describe("the plan's cost with extra servers", () => {
  it("adds one line per server with its IPv4 address and backups, and the total", async () => {
    const server = await designCloudServer({
      name: "db",
      target: { backups: true },
      services: [db],
      app,
      region: "eu-central",
      backups: false,
      catalogFor: async () => euCatalog(),
    });
    expect(server.server.target).toEqual({
      provider: "hetzner",
      mode: "vps-compose",
      location: "fsn1",
      serverType: "cx13",
      backups: true,
    });
    const appCost: CostEstimate = {
      monthly: { amount: 4.69, currency: "EUR" },
      breakdown: [{ item: "Server cx13 (fsn1)", monthly: { amount: 4.69, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-11T00:00:00.000Z",
    };
    const total = totalCost(appCost, [server]);
    // 4.19 + 0.50 for the IPv4 address + 0.84 (20% backups).
    expect(total.breakdown.at(-1)).toEqual({
      item: "Server db (cx13 in fsn1), with its IPv4 address and backups",
      monthly: { amount: 5.53, currency: "EUR" },
    });
    expect(total.monthly).toEqual({ amount: 10.22, currency: "EUR" });
    // The static price list dates the total.
    expect(total).toMatchObject({ source: "static", asOf: "2026-09-01T00:00:00.000Z" });
    expect(totalCost(appCost, [])).toBe(appCost);
  });
});
