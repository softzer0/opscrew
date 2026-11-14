import { type CostEstimate, type PlanService, PlanServiceSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { euCatalog, MemoryCatalog, offer } from "../testing";
import {
  type CloudServerInput,
  type DesignedServer,
  designCloudServer,
  extraServerNeed,
  sizeExtraServer,
  totalCost,
  totalLine,
  withoutServerCost,
} from "./servers";
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

describe("an extra server with add-ons' containers", () => {
  const stack = [
    { name: "Grafana Alloy", memoryMb: 288 },
    { name: "Prometheus", memoryMb: 192 },
    { name: "Loki", memoryMb: 384 },
    { name: "Grafana", memoryMb: 416 },
    { name: "the monitoring front", memoryMb: 96 },
  ];
  const small = new MemoryCatalog([
    offer({ id: "cx11", vcpus: 1, memoryGb: 1, diskGb: 20, price: 2, location: "fsn1" }),
    offer({ id: "cx21", vcpus: 1, memoryGb: 2, diskGb: 30, price: 3, location: "fsn1" }),
  ]);

  it("is sized for them as for its services, and names them", async () => {
    // The stack and Alloy, 1,376 MB, and the system's 384 MB need the 2 GB type.
    expect(extraServerNeed([], stack)).toEqual({ memoryMb: 1760, vcpus: 1 });
    expect(extraServerNeed([db], [{ name: "Grafana Alloy", memoryMb: 288 }])).toEqual({
      memoryMb: 1184,
      vcpus: 1,
    });
    const input: CloudServerInput = {
      name: "monitoring",
      target: undefined,
      services: [],
      addons: stack,
      app,
      region: undefined,
      backups: false,
      catalogFor: async () => small,
    };
    const designed = await designCloudServer(input);
    expect(designed.server.target.serverType).toBe("cx21");
    expect(designed.diskGb).toBe(30);
    // Without them the 1 GB type would do.
    expect((await designCloudServer({ ...input, addons: [] })).server.target.serverType).toBe(
      "cx11",
    );
    const error = await designCloudServer({ ...input, target: { serverType: "cx11" } }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message:
        "Server monitoring is a cx11 (1 vCPU, 1 GB memory), but Grafana Alloy, Prometheus, Loki, Grafana and the monitoring front on it need 1.7 GB of memory with the system's share. plan.yaml was not changed.",
    });
  });
});

describe("a deployed extra server's type", () => {
  const input: CloudServerInput = {
    name: "data",
    target: undefined,
    services: [db],
    app,
    region: "eu-central",
    backups: false,
    catalogFor: async () => euCatalog(),
  };

  it("is kept rather than one with a smaller disk there, priced as it is", async () => {
    const kept = await designCloudServer({
      ...input,
      deployed: { location: "fsn1", serverType: "cx33" },
    });
    const named = await designCloudServer({ ...input, target: { serverType: "cx33" } });
    expect(kept.server.target.serverType).toBe("cx33");
    expect(kept.cost).toEqual(named.cost);
    expect(kept.warnings).toEqual([
      "Server data could use cx13 now, but OpsCrew keeps cx33: Hetzner Cloud can't make a server's disk smaller.",
    ]);
    // Elsewhere it would be a new server, so it is sized as usual.
    const elsewhere = await designCloudServer({
      ...input,
      deployed: { location: "nbg1", serverType: "cx33" },
    });
    expect(elsewhere.server.target.serverType).toBe("cx13");
  });

  it("grows to a type with a larger disk", async () => {
    const grown = await designCloudServer({
      ...input,
      services: [{ ...db, memoryMb: 6 * 1024 }],
      deployed: { location: "fsn1", serverType: "cx13" },
    });
    expect(grown.server.target.serverType).toBe("cx33");
    expect(grown.warnings.join("\n")).not.toContain("OpsCrew keeps");
  });

  it("refuses a kept type too small for its services, naming one with as much disk", async () => {
    const catalog = new MemoryCatalog(
      [
        { id: "cx13", vcpus: 2, memoryGb: 4, diskGb: 40, price: 4.19 },
        { id: "big", vcpus: 1, memoryGb: 1, diskGb: 160, price: 3 },
        { id: "cx43", vcpus: 8, memoryGb: 16, diskGb: 160, price: 15.99 },
      ].map((init) => offer({ ...init, location: "fsn1" })),
    );
    const error = await designCloudServer({
      ...input,
      services: [{ ...db, memoryMb: 2048 }],
      catalogFor: async () => catalog,
      deployed: { location: "fsn1", serverType: "big" },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "Server data is a big (1 vCPU, 1 GB memory, 160 GB disk), but db on it need 2.4 GB of memory with the system's share, and it can't become a cx13: Hetzner Cloud can't make a server's disk smaller. plan.yaml was not changed.",
      hint: "Choose a type with at least 160 GB of disk for server data, such as cx43, in servers[].target.serverType, then run `opscrew design` again.",
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
    // A server leaving the plan takes its line with it.
    expect(withoutServerCost(total, "db")).toEqual({
      ...total,
      breakdown: appCost.breakdown,
      monthly: appCost.monthly,
    });
    expect(withoutServerCost(total, "data")).toBe(total);
  });
});

describe("totalCost and totalLine with Contabo's Auto Backup", () => {
  const cost = (amount: number): CostEstimate => ({
    monthly: { amount, currency: "EUR" },
    breakdown: [{ item: "Server V153 (EU)", monthly: { amount, currency: "EUR" } }],
    pricesIncludeVat: false,
    source: "static",
    asOf: "2026-11-11T00:00:00.000Z",
  });
  /** A designed server `name` on Contabo with `backups`. */
  const contabo = (name: string, backups: boolean): DesignedServer => ({
    server: {
      name,
      target: {
        provider: "contabo",
        mode: "vps-compose",
        location: "EU",
        serverType: "V153",
        backups,
      },
    },
    services: [],
    vcpus: 4,
    memoryGb: 8,
    cost: cost(5.5),
    warnings: [],
  });
  const ORDER_PAGE =
    "Contabo's automated backups are not in this total: they are priced on Contabo's order page.";

  it("never names backups in a line whose price leaves them out, and says so in the total", () => {
    const total = totalCost(cost(5.5), [contabo("db", true)]);
    expect(total.breakdown.at(-1)?.item).toBe("Server db (V153 in EU)");
    expect(totalLine(total, [contabo("db", true)], contabo("app", false))).toBe(
      `Monthly total for the app's 2 servers: €11.00 (estimate as of 2026-11-11). ${ORDER_PAGE}`,
    );
    expect(totalLine(total, [contabo("db", false)], contabo("app", true))).toContain(ORDER_PAGE);
    expect(totalLine(total, [contabo("db", false)], contabo("app", false))).not.toContain(
      "order page",
    );
  });
});
