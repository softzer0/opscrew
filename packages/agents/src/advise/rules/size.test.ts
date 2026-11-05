import { STATIC_PRICES_AS_OF } from "@opscrew/connector-hetzner";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeRequirements, offer, ownPlan, portainerPlan, testPlan } from "../../testing";
import { sitePlan } from "../../testing/serverless";
import type { PriceList, Proposal } from "../types";
import {
  AT,
  container,
  digitaloceanTable,
  GB,
  hetznerTable,
  history,
  ids,
  MB,
  onThisComputer,
  reading,
  readingsOf,
  server,
  texts,
  validated,
  withDataServer,
  withServerType,
  withWorker,
} from "./__fixtures__/rule-readings";
import { sizeRules } from "./size";

/** The deployed example: Hetzner cx23 (2 vCPU, 4 GB, 40 GB) in nbg1, backups on, Postgres `db`. */
const plan = testPlan({ deployed: true });

const sized = validated(sizeRules);

/** The size proposals of the app's server with `past` and `now`, at Hetzner's static prices. */
async function sizeApp(
  past: Parameters<typeof history>[0] | undefined,
  now = reading(),
  appPlan: DeployPlan = plan,
): Promise<Proposal[]> {
  const prices = [await hetznerTable()];
  const app = server(now, past === undefined ? undefined : history(past));
  return sized(readingsOf(appPlan, { servers: { app }, prices }));
}

const byId = (proposals: Proposal[], id: string) => proposals.find((p) => p.id === id);

describe("sizeRules: a container at its limit", () => {
  it("raises a container's limit by 1.5, rounded up to 64 MB, when the server has room", async () => {
    const proposals = await sizeApp({
      memoryP95: 0.5,
      containers: [{ service: "app", memoryMax: 502 * MB, limit: 512 * MB }],
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "size.app.app-limit",
        category: "size",
        urgency: "now",
        server: "app",
        title: "Raise the memory limit of the web process to 768 MB",
        apply: {
          kind: "plan",
          change: { kind: "memory-limit", container: { kind: "web" }, memoryMb: 768 },
        },
      }),
    ]);
    const [limit] = proposals;
    expect(limit?.price).toBeUndefined();
    expect(limit?.reasons[0]).toEqual({
      text: "The memory use of the web process reached its limit",
      figure: "98% of 512 MB",
      basis: { kind: "history", days: 14 },
    });
    // 50% of 4 GB plus 256 MB more.
    expect(limit?.reasons[1]).toMatchObject({ figure: "56% of 4 GB" });
  });

  it("counts a maximum at exactly containerAtLimit of the limit, and not just under it", async () => {
    const at = async (maxMb: number) =>
      sizeApp({ containers: [{ service: "app", memoryMax: maxMb * MB, limit: 1000 * MB }] });
    expect(ids(await at(950))).toEqual(["size.app.app-limit"]);
    expect(await at(949)).toEqual([]);
  });

  it("counts an OOM kill whatever the maximum, and rounds 1.5 times the limit up to 64 MB", async () => {
    const proposals = await sizeApp(
      { containers: [{ service: "jobs", memoryMax: 100 * MB, limit: 300 * MB, oomKills: 3 }] },
      reading(),
      withWorker(plan, "jobs", 300),
    );
    const [limit] = proposals;
    expect(limit).toMatchObject({
      id: "size.app.jobs-limit",
      title: "Raise the memory limit of worker jobs to 512 MB",
      apply: {
        change: {
          kind: "memory-limit",
          container: { kind: "worker", name: "jobs" },
          memoryMb: 512,
        },
      },
    });
    expect(limit?.reasons[0]).toEqual({
      text: "The system stopped worker jobs for lack of memory",
      figure: "3 times",
      basis: { kind: "history", days: 14 },
    });
  });

  it("proposes a larger server that holds the raise when the server has no room for it", async () => {
    const proposals = await sizeApp({
      memoryP95: 0.8,
      containers: [{ service: "app", memoryMax: 510 * MB, limit: 512 * MB }],
    });
    expect(ids(proposals)).toEqual(["size.app.larger"]);
    const [larger] = proposals;
    expect(larger).toMatchObject({
      urgency: "now",
      title: "Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk)",
      apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
    });
    expect(texts(larger)).toContain(
      "The server has no room to raise the limit of the web process to 768 MB",
    );
    // 80% of 4 GB plus 256 MB.
    expect(texts(larger)).toContain("[86.3% of 4 GB]");
  });

  it("has room up to memoryHigh with the raise, and none past it", async () => {
    const limit = async (memoryP95: number) =>
      ids(
        await sizeApp({
          memoryP95,
          containers: [{ service: "app", memoryMax: 510 * MB, limit: 512 * MB }],
        }),
      );
    // 3.12 GB + 0.25 GB of 4 GB is 84.3%; 3.16 GB + 0.25 GB is 85.3%.
    expect(await limit(0.78)).toEqual(["size.app.app-limit"]);
    expect(await limit(0.79)).toEqual(["size.app.larger"]);
  });

  it("counts the raise once per copy of a worker", async () => {
    const worker = (count: number) =>
      sizeApp(
        {
          memoryP95: 0.79,
          containers: [{ service: "jobs", memoryMax: 256 * MB, limit: 256 * MB }],
        },
        reading(),
        withWorker(plan, "jobs", 256, count),
      );
    // 128 MB more for one copy fits; 256 MB for two doesn't.
    expect(ids(await worker(1))).toEqual(["size.app.jobs-limit"]);
    expect(ids(await worker(2))).toEqual(["size.app.larger"]);
  });

  it("gives the room to the first container and a larger server for the next", async () => {
    const proposals = await sizeApp(
      {
        memoryP95: 0.74,
        containers: [
          { service: "app", memoryMax: 512 * MB, limit: 512 * MB },
          { service: "jobs", memoryMax: 512 * MB, limit: 512 * MB },
        ],
      },
      reading(),
      withWorker(plan, "jobs", 512),
    );
    expect(ids(proposals)).toEqual(["size.app.app-limit", "size.app.larger"]);
    expect(texts(byId(proposals, "size.app.larger"))).toContain("the limit of worker jobs");
  });

  it("maps a service on an extra server to its plan entry, and skips OpsCrew's own containers", async () => {
    const twoServers = withDataServer(plan);
    const prices = [await hetznerTable()];
    const data = server(
      reading({
        containers: [
          container("db", { usedMb: 500, limitMb: 512 }),
          container("alloy", { usedMb: 250, limitMb: 256 }),
        ],
      }),
    );
    const app = server(reading({ containers: [container("cron", { usedMb: 500, limitMb: 512 })] }));
    const proposals = sized(readingsOf(twoServers, { servers: { app, data }, prices }));
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "size.data.db-limit",
        server: "data",
        title: "Raise the memory limit of PostgreSQL (db) to 768 MB",
        apply: {
          kind: "plan",
          change: {
            kind: "memory-limit",
            container: { kind: "service", name: "db" },
            memoryMb: 768,
          },
        },
      }),
    ]);
  });

  it("reads one reading without history, and says so", async () => {
    const proposals = await sizeApp(
      undefined,
      reading({
        containers: [
          container("app", { usedMb: 400, limitMb: 512 }),
          container("db", { usedMb: 500, limitMb: 512 }),
        ],
      }),
    );
    expect(ids(proposals)).toEqual(["size.app.db-limit"]);
    expect(proposals[0]?.reasons[0]).toEqual({
      text: "The memory use of PostgreSQL (db) is at its limit",
      figure: "98% of 512 MB",
      basis: { kind: "one-reading", at: AT },
    });
  });
});

describe("sizeRules: a larger server", () => {
  it("moves a server short of memory to the cheapest type that brings it under memoryHigh", async () => {
    const proposals = await sizeApp({ memoryP95: 0.9 });
    expect(proposals).toHaveLength(1);
    const [larger] = proposals;
    expect(larger).toMatchObject({
      id: "size.app.larger",
      category: "size",
      urgency: "soon",
      server: "app",
      title: "Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk)",
      // cx23 and cx33 with the IPv4 address and 20% for backups, from the static table.
      price: { before: 7.09, after: 10.69, currency: "EUR", source: "static" },
      apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
    });
    expect(larger?.price?.asOf).toBe(STATIC_PRICES_AS_OF);
    expect(larger?.reasons.slice(0, 2)).toEqual([
      {
        text: "Memory in use at the 95th percentile is above 85% of the server",
        figure: "90% of 4 GB",
        basis: { kind: "history", days: 14 },
      },
      { text: "On cx33 it would be 45%", basis: { kind: "plan" } },
    ]);
    const why = texts(larger);
    expect(why).toContain("offline one to three minutes");
    expect(why).toContain("addresses stay the same");
    expect(why).toContain(
      "The change is one way: the disk grows from 40 GB to 80 GB, and Hetzner Cloud can't make it smaller again",
    );
  });

  it("is short above memoryHigh, not at it", async () => {
    expect(await sizeApp({ memoryP95: 0.85 })).toEqual([]);
    const [larger] = await sizeApp({ memoryP95: 0.851 });
    expect(larger?.id).toBe("size.app.larger");
    // Above the threshold never reads at it.
    expect(larger?.reasons[0]?.figure).toBe("85.1% of 4 GB");
  });

  it("puts a filling disk into the larger type when there is one", async () => {
    const cpx22 = withServerType(plan, "cpx22");
    // Memory alone takes cx33, whose 80 GB disk is no larger than cpx22's; cx43 holds both.
    const [memory] = await sizeApp({ memoryP95: 0.9 }, reading(), cpx22);
    expect(memory?.apply).toMatchObject({ change: { serverType: "cx33" } });
    const proposals = await sizeApp({ memoryP95: 0.9, diskFullInDays: 5 }, reading(), cpx22);
    expect(ids(proposals)).toEqual(["size.app.larger"]);
    expect(proposals[0]).toMatchObject({
      urgency: "now",
      apply: { change: { serverType: "cx43" } },
    });
    const why = texts(proposals[0]);
    expect(why).toContain(
      "Server app's disk is filling at the pace of the last 7 days [full in 5 days]",
    );
    expect(why).toContain("docker image prune");
  });

  it("adds CPUs when the load passed them for loadHighShare of the period", async () => {
    expect(await sizeApp({ loadOverCpus: 0.249 })).toEqual([]);
    const [larger] = await sizeApp({ loadOverCpus: 0.25 });
    expect(larger).toMatchObject({ id: "size.app.larger", urgency: "soon" });
    expect(larger?.apply).toMatchObject({ change: { serverType: "cx33" } });
    expect(larger?.reasons[0]).toEqual({
      text: "The 15-minute load was above the server's 2 CPUs",
      figure: "25% of the time",
      basis: { kind: "history", days: 14 },
    });
  });

  it("grows on one reading, each reason saying it rests on one", async () => {
    const memory = await sizeApp(undefined, reading({ memory: [3401, 4000] }));
    expect(ids(memory)).toEqual(["size.app.larger"]);
    expect(memory[0]?.reasons.slice(0, 2)).toMatchObject([
      { text: "Memory in use is above 85% of the server", basis: { kind: "one-reading", at: AT } },
      { text: "On cx33 it would be 43%", basis: { kind: "plan" } },
    ]);
    expect(await sizeApp(undefined, reading({ memory: [3400, 4000] }))).toEqual([]);

    const load = await sizeApp(undefined, reading({ load15: 2.5 }));
    expect(load[0]).toMatchObject({ apply: { change: { serverType: "cx33" } } });
    expect(load[0]?.reasons[0]).toEqual({
      text: "The 15-minute load is above the server's 2 CPUs",
      figure: "2.50",
      basis: { kind: "one-reading", at: AT },
    });
    expect(await sizeApp(undefined, reading({ load15: 2 }))).toEqual([]);
  });

  it("prices from live catalogues as live, without a date", async () => {
    const prices = [await hetznerTable("nbg1", "live")];
    const app = server(reading(), history({ memoryP95: 0.9 }));
    const [larger] = sized(readingsOf(plan, { servers: { app }, prices }));
    expect(larger?.price).toEqual({ before: 7.09, after: 10.69, currency: "EUR", source: "live" });
  });

  it("says how long a DigitalOcean resize keeps the app offline", async () => {
    const droplet = testPlan({ deployed: true, provider: "digitalocean" });
    const prices = [await digitaloceanTable()];
    const app = server(reading({ cpus: 1 }), history({ memoryP95: 0.9 }));
    const [larger] = sized(readingsOf(droplet, { servers: { app }, prices }));
    expect(larger).toMatchObject({
      title: "Move server app to s-2vcpu-4gb (2 vCPU, 4 GB memory, 80 GB disk)",
      price: { before: 15.6, after: 31.2, currency: "USD", source: "static" },
    });
    expect(texts(larger)).toContain("about a minute per GB of disk in use");
    expect(texts(larger)).not.toContain("one to three minutes");
  });
});

describe("sizeRules: a smaller server", () => {
  /** A line where only one type keeps the 160 GB disk and is cheaper, plus types to skip. */
  const line: PriceList = {
    provider: "hetzner",
    location: "nbg1",
    offers: [
      offer({ id: "big", vcpus: 8, memoryGb: 16, diskGb: 160, price: 40 }),
      offer({ id: "mid", vcpus: 4, memoryGb: 8, diskGb: 160, price: 24 }),
      offer({ id: "small", vcpus: 2, memoryGb: 4, diskGb: 160, price: 14 }),
      // Skipped: a smaller disk, another architecture, dedicated CPUs, not on sale.
      offer({ id: "tiny", vcpus: 2, memoryGb: 4, diskGb: 80, price: 6 }),
      offer({ id: "arm", vcpus: 4, memoryGb: 8, diskGb: 160, price: 3, architecture: "arm" }),
      offer({ id: "ded", vcpus: 4, memoryGb: 8, diskGb: 160, price: 4, cpuType: "dedicated" }),
      offer({ id: "gone", vcpus: 4, memoryGb: 8, diskGb: 160, price: 2, available: false }),
    ],
    extras: {
      ipv4Monthly: { amount: 0.5, currency: "EUR" },
      backupPercent: 20,
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-09-01T00:00:00.000Z",
    },
  };
  const big = withServerType(plan, "big");
  const shrink = (past?: Parameters<typeof history>[0], now = reading({ cpus: 8 })) =>
    sized(
      readingsOf(big, {
        servers: { app: server(now, past === undefined ? undefined : history(past)) },
        prices: [line],
      }),
    );

  it("proposes the next smaller type that holds the p95 with shrinkHeadroom, keeping the disk", () => {
    const proposals = shrink({ cpuP95: 0.2, memoryP95: 0.25 });
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "size.app.smaller",
        urgency: "when-convenient",
        title: "Move server app to mid (4 vCPU, 8 GB memory, 160 GB disk)",
        // 40 and 24, each with 0.50 for IPv4 and 20% for backups.
        price: {
          before: 48.5,
          after: 29.3,
          currency: "EUR",
          source: "static",
          asOf: "2026-09-01T00:00:00.000Z",
        },
        apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "mid" } },
      }),
    ]);
    const why = texts(proposals[0]);
    expect(why).toContain("The CPUs were in use at the 95th percentile [20% of 8 vCPU]");
    expect(why).toContain("The memory was in use at the 95th percentile [25% of 16 GB]");
    expect(why).toContain("On mid the CPUs would be 40% in use and the memory 50% []");
    expect(why).toContain("The disk stays 160 GB");
    // Even when a type two steps down would hold it too.
    expect(shrink({ cpuP95: 0.1, memoryP95: 0.1 })[0]).toMatchObject({ id: "size.app.smaller" });
    expect(texts(shrink({ cpuP95: 0.1, memoryP95: 0.1 })[0])).toContain("On mid");
  });

  it("keeps a type that holds the plan's memory limits, as design sizes the app's server", () => {
    const quiet = history({ cpuP95: 0.1, memoryP95: 0.1 });
    const withApp = (memoryMb: number) =>
      sized(
        readingsOf(
          { ...big, app: { ...big.app, memoryMb } },
          { servers: { app: server(reading({ cpus: 8 }), quiet) }, prices: [line] },
        ),
      );
    // The web process and Postgres (512 MB), Caddy's 128 MB and the system's 384 MB: 8192 MB is
    // exactly mid's memory; 1 MB more doesn't fit, though the p95 would with room to spare.
    expect(ids(withApp(7168))).toEqual(["size.app.smaller"]);
    expect(withApp(7169)).toEqual([]);
  });

  it("keeps a type that holds an extra server's services, as design sizes it", () => {
    const quiet = history({ cpuP95: 0.1, memoryP95: 0.1 });
    const withDb = (memoryMb: number) => {
      const two = withDataServer(plan, "big");
      const services = two.services.map((s) => (s.name === "db" ? { ...s, memoryMb } : s));
      const data = server(reading({ cpus: 8 }), quiet);
      return sized(readingsOf({ ...two, services }, { servers: { data }, prices: [line] }));
    };
    // Postgres and the system's 384 MB: 8192 MB is exactly mid's memory.
    expect(ids(withDb(7808))).toEqual(["size.data.smaller"]);
    expect(withDb(7809)).toEqual([]);
  });

  it("says it is sized on the figures rather than the interview's users band", () => {
    const readings = readingsOf(big, {
      servers: {
        app: server(reading({ cpus: 8 }), history({ cpuP95: 0.1, memoryP95: 0.1 })),
      },
      prices: [line],
      requirements: makeRequirements({ expectedMonthlyUsers: "1k-10k" }),
    });
    expect(texts(sized(readings)[0])).toContain(
      "Sized on 14 days of figures rather than the expected 1k-10k monthly users",
    );
    expect(texts(shrink({ cpuP95: 0.1, memoryP95: 0.1 })[0])).not.toContain("Sized on");
  });

  it("never shrinks a server on one reading", () => {
    const quiet = reading({ cpus: 8, load15: 0.01, memory: [100, 16000], disk: [5, 160] });
    expect(shrink(undefined, quiet)).toEqual([]);
  });

  it("never shrinks with fewer than minHistoryDaysToShrink days", () => {
    expect(shrink({ days: 6.9, cpuP95: 0.1, memoryP95: 0.1 })).toEqual([]);
    expect(ids(shrink({ days: 7, cpuP95: 0.1, memoryP95: 0.1 }))).toEqual(["size.app.smaller"]);
  });

  it("needs the headroom in the smaller type, exactly at its edge", () => {
    // 30% of 8 vCPU is 60% of mid's 4; a little more is not.
    expect(ids(shrink({ cpuP95: 0.3, memoryP95: 0.1 }))).toEqual(["size.app.smaller"]);
    expect(shrink({ cpuP95: 0.3001, memoryP95: 0.1 })).toEqual([]);
    expect(ids(shrink({ cpuP95: 0.1, memoryP95: 0.3 }))).toEqual(["size.app.smaller"]);
    expect(shrink({ cpuP95: 0.1, memoryP95: 0.3001 })).toEqual([]);
  });

  it("never proposes a smaller disk: at Hetzner a smaller type has one", async () => {
    const quiet = { cpuP95: 0.01, memoryP95: 0.05 };
    expect(await sizeApp(quiet, reading({ cpus: 4 }), withServerType(plan, "cx33"))).toEqual([]);
  });

  it("doesn't shrink a server with a container at its limit or a filling disk", () => {
    const quiet = { cpuP95: 0.1, memoryP95: 0.1 };
    expect(
      ids(
        shrink({
          ...quiet,
          containers: [{ service: "app", memoryMax: 512 * MB, limit: 512 * MB }],
        }),
      ),
    ).toEqual(["size.app.app-limit"]);
    expect(ids(shrink({ ...quiet, diskFullInDays: 20 }))).toEqual(["size.app.disk"]);
    // The load past its 8 CPUs, and no larger type in the line: not smaller, and what it needs.
    const cpus = shrink({ ...quiet, loadOverCpus: 0.3 });
    expect(cpus).toEqual([
      expect.objectContaining({
        id: "size.app.larger",
        urgency: "soon",
        title: "Server app needs more CPUs than its big has",
        apply: { kind: "command", command: "opscrew design" },
      }),
    ]);
    expect(cpus[0]?.price).toBeUndefined();
    const why = texts(cpus[0]);
    expect(why).toContain("The 15-minute load was above the server's 8 CPUs [30% of the time]");
    expect(why).toContain("No larger type in Hetzner Cloud's price list for nbg1 holds it");
    // Short of both: one proposal naming both.
    expect(shrink({ memoryP95: 0.9, loadOverCpus: 0.3 })).toEqual([
      expect.objectContaining({
        id: "size.app.larger",
        title: "Give server app at least 17 GB of memory and 9 CPUs",
      }),
    ]);
  });

  it("gives a server short of memory with no larger type what would fit, without a price", async () => {
    // Killed for memory with no room for a higher limit, on the line's largest type.
    const proposals = shrink({
      memoryP95: 0.84,
      containers: [{ service: "app", memoryMax: 100 * MB, limit: 512 * MB, oomKills: 2 }],
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "size.app.larger",
        urgency: "now",
        title: "Give server app at least 17 GB of memory",
        apply: { kind: "command", command: "opscrew design" },
      }),
    ]);
    expect(proposals[0]?.price).toBeUndefined();
    const why = texts(proposals[0]);
    expect(why).toContain("The system stopped the web process for lack of memory");
    expect(why).toContain("No larger type in Hetzner Cloud's price list for nbg1 holds it");
    // A type the price list doesn't have: the same, from the reading's memory.
    const [unlisted] = await sizeApp({ memoryP95: 0.9 }, reading(), withServerType(plan, "cx22"));
    expect(unlisted).toMatchObject({
      id: "size.app.larger",
      title: "Give server app at least 5 GB of memory",
    });
    expect(unlisted?.price).toBeUndefined();
  });
});

describe("sizeRules: the disk", () => {
  it("says when a filling disk is full and proposes a type with a larger disk, or cleaning up", async () => {
    const [disk] = await sizeApp({ diskFullInDays: 16 });
    expect(disk).toMatchObject({
      id: "size.app.disk",
      urgency: "soon",
      title: "Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk)",
      price: { before: 7.09, after: 10.69 },
      apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
    });
    expect(disk?.reasons[0]).toEqual({
      text: "Server app's disk is filling at the pace of the last 7 days",
      figure: "full in 16 days",
      basis: { kind: "history", days: 14 },
    });
    expect(texts(disk)).toContain("docker image prune");
  });

  it("is soon within diskFullDays and now within diskFullDaysNow", async () => {
    const urgency = async (days: number) =>
      (await sizeApp({ diskFullInDays: days })).map((p) => p.urgency);
    expect(await urgency(30.1)).toEqual([]);
    expect(await urgency(30)).toEqual(["soon"]);
    expect(await urgency(7.1)).toEqual(["soon"]);
    expect(await urgency(7)).toEqual(["now"]);
  });

  it("flags a disk at diskHigh on one reading", async () => {
    const [full] = await sizeApp(undefined, reading({ disk: [34, 40] }));
    expect(full).toMatchObject({ id: "size.app.disk", urgency: "soon" });
    expect(full?.reasons[0]).toEqual({
      text: "Server app's disk is nearly full",
      figure: "85% in use",
      basis: { kind: "one-reading", at: AT },
    });
    expect(await sizeApp(undefined, reading({ disk: [33.9, 40] }))).toEqual([]);
  });

  it("picks a disk that brings the use under diskHigh", async () => {
    // 70 GB in use needs more than cx33's 80 GB: cx43's 160 GB.
    const [disk] = await sizeApp(undefined, reading({ disk: [70, 80], cpus: 4 }), {
      ...withServerType(plan, "cx33"),
    });
    expect(disk?.apply).toMatchObject({ change: { serverType: "cx43" } });
  });
});

describe("sizeRules: targets", () => {
  it("reports a server the user owns short of memory, with what would fit, and no price", () => {
    const own = ownPlan({ deployed: true });
    const app = server(
      reading({
        memory: [3700, 4000],
        disk: [36, 40],
        containers: [container("app", { usedMb: 300, limitMb: 512 })],
      }),
    );
    const proposals = sized(readingsOf(own, { servers: { app }, flags: " --env staging" }));
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "size.app.larger",
        urgency: "soon",
        title: "Give server app at least 5 GB of memory",
        apply: {
          kind: "manual",
          text: "Give server app at least 5 GB of memory, then run `opscrew design --env staging`",
        },
      }),
      expect.objectContaining({
        id: "size.app.disk",
        title: "Free space on server app's disk",
        // It runs on the server, so there is nothing to type here.
        apply: {
          kind: "manual",
          text: "On server app, as the deploy user, run `docker image prune`: it deletes the images no container uses",
        },
      }),
    ]);
    for (const proposal of proposals) expect(proposal.price).toBeUndefined();
    expect(texts(proposals[0])).toContain("[92.5% of 3.9 GB]");
    expect(texts(proposals[0])).toContain("`opscrew design --env staging`");
  });

  it("raises a container's limit on a server the user owns, which is no resize", () => {
    const own = ownPlan({ deployed: true });
    const app = server(reading({ containers: [container("app", { usedMb: 500, limitMb: 512 })] }));
    expect(ids(sized(readingsOf(own, { servers: { app } })))).toEqual(["size.app.app-limit"]);
  });

  it("in a Portainer, raises a limit only, saying the host's memory in use can't be read", () => {
    const app = server({
      takenAt: AT,
      server: { cpus: 4, memory: { totalBytes: 8 * 1024 ** 3 } },
      containers: [container("app", { usedMb: 500, limitMb: 512 })],
      unavailable: [],
      flags: [],
    });
    const proposals = sized(readingsOf(portainerPlan(), { servers: { app } }));
    expect(ids(proposals)).toEqual(["size.app.app-limit"]);
    expect(proposals[0]?.reasons.at(-1)).toEqual({
      text: "OpsCrew can't read the memory in use on this host: check it has 256 MB to spare for the higher limit",
      basis: { kind: "plan" },
    });
  });

  it("on this computer, raises a limit only; short of memory there or in a Portainer, says what would fit", () => {
    const local = onThisComputer(testPlan({ deployed: true }));
    const figures = (memory: { usedBytes?: number; totalBytes: number }, mb?: number) =>
      server({
        takenAt: AT,
        server: { cpus: 4, memory },
        containers: mb === undefined ? [] : [container("app", { usedMb: mb, limitMb: 512 })],
        unavailable: [],
        flags: [],
      });
    const limited = figures({ totalBytes: 8 * GB }, 500);
    expect(ids(sized(readingsOf(local, { servers: { app: limited } })))).toEqual([
      "size.app.app-limit",
    ]);
    // Where the memory in use is readable: 7.5 of 8 GB needs 9 GB to stay under 85%.
    const short = figures({ usedBytes: 7.5 * GB, totalBytes: 8 * GB });
    const cases = [
      [local, "Give Docker on this computer at least 9 GB of memory"],
      [portainerPlan(), "Give the host your Portainer runs on at least 9 GB of memory"],
    ] as const;
    for (const [target, text] of cases) {
      const proposals = sized(readingsOf(target, { servers: { app: short } }));
      expect(proposals).toEqual([
        expect.objectContaining({ id: "size.app.larger", apply: { kind: "manual", text } }),
      ]);
      expect(proposals[0]?.price).toBeUndefined();
    }
  });

  it("proposes nothing for Cloudflare's hosting or GitHub Pages", () => {
    const now = { takenAt: AT, containers: [], unavailable: [], flags: [] };
    expect(sized(readingsOf(sitePlan(), { servers: { app: server(now) } }))).toEqual([]);
  });

  it("puts no server address in a proposal", async () => {
    const proposals = await sizeApp({
      memoryP95: 0.8,
      diskFullInDays: 5,
      containers: [{ service: "app", memoryMax: 510 * MB, limit: 512 * MB }],
    });
    expect(proposals.length).toBeGreaterThan(0);
    expect(JSON.stringify(proposals)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|203\.0\.113|2001:db8/);
  });
});
