import { edgeMemoryMb } from "@opscrew/iac-templates";
import { serviceOf } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, makeRequirements, nextPostgresFacts, staticSpaFacts } from "../testing";
import { designComponents } from "./components";
import {
  containersText,
  ownServerMemory,
  regionLocations,
  sizeFor,
  smallServerWarnings,
} from "./sizing";

const CADDY_EDGE = edgeMemoryMb("caddy");

describe("smallServerWarnings", () => {
  const { services } = designComponents({
    facts: makeFacts({
      services: [
        { kind: "opensearch", evidence: ["dependency:@opensearch-project/opensearch"] },
        { kind: "meilisearch", evidence: ["dependency:meilisearch"] },
      ],
    }),
    requirements: makeRequirements(),
  }).components;

  it("warns below each engine's smallest server, naming it and what to do", () => {
    expect(smallServerWarnings(services, 2048)).toEqual([
      "OpenSearch (opensearch) runs comfortably only on a server with at least 4 GB of memory, and yours has 2 GB, so it may slow down or stop when memory runs out. Add memory to the server, or turn the service off in opscrew/plan.yaml (enabled: false) and give the app a hosted OpenSearch's address instead.",
    ]);
    expect(smallServerWarnings(services, 1024)).toHaveLength(2);
  });

  it("says nothing at or near the smallest server, or for a service turned off", () => {
    // A "4 GB" server reports a little less.
    expect(smallServerWarnings(services, 3900)).toEqual([]);
    expect(
      smallServerWarnings(
        services.map((service) => ({ ...service, enabled: false })),
        1024,
      ),
    ).toEqual([]);
  });
});

describe("ownServerMemory", () => {
  const blog = { name: "blog", memoryMb: 1024, tunnel: false };

  it("fits this app next to the other apps' recorded limits, the edge and the system", () => {
    // 4096 MB - 384 (system) - 128 (edge) - 1024 (blog) leaves 2560 MB, 1536 of them still free.
    expect(ownServerMemory(4096, 1024, [blog], CADDY_EDGE)).toBeUndefined();
    expect(ownServerMemory(4096, 2560, [], CADDY_EDGE)).toBeUndefined();
  });

  it("refuses limits that do not fit, saying how much the other apps take", () => {
    const result = ownServerMemory(
      2048,
      1024,
      [blog, { name: "news", memoryMb: 256, tunnel: false }],
      CADDY_EDGE,
    );
    expect(result?.refused?.message).toBe(
      'Your server has 2048 MB of memory. After 384 MB for the system and 128 MB for OpsCrew\'s edge, the other OpsCrew apps on it take 1280 MB of memory limits ("blog" 1024 MB and "news" 256 MB), which leaves 256 MB, and this app\'s containers have 1024 MB of memory limits. Nothing was written.',
    );
    expect(result?.refused?.hint).toBe(
      "Lower the memory limits in opscrew/plan.yaml (app.memoryMb, and those of the workers and services), add memory to the server, or remove an app from it, then run `opscrew design` again.",
    );
    // Alone on a server too small for its limits.
    expect(ownServerMemory(1024, 640, [], CADDY_EDGE)?.refused?.message).toBe(
      "Your server has 1024 MB of memory. After 384 MB for the system and 128 MB for OpsCrew's edge, 512 MB are left, and this app's containers have 640 MB of memory limits. Nothing was written.",
    );
  });

  it("warns below 15% free, with how much the other apps take", () => {
    // 4096 - 384 = 3712 MB usable; 1024 + 2048 + 128 leaves 512 MB, 13.8% of it.
    expect(ownServerMemory(4096, 2048, [blog], CADDY_EDGE)?.warning).toBe(
      'Your server keeps only 14% of its memory free after the memory limits of this app (2048 MB) and of the other OpsCrew app on it (1024 MB: "blog" 1024 MB), OpsCrew\'s edge and the system, so a container that grows can make the server run out of memory. Lower a memory limit in opscrew/plan.yaml, or add memory to the server.',
    );
  });

  it("counts the tunnel connector of each other tunnelled app (the edge's figure holds one)", () => {
    // 2048 - 384 - 128 leaves 1536 MB; blog's 1024 MB and its connector's 32 leave 480 MB.
    const tunnelled = { name: "blog", memoryMb: 1024, tunnel: true };
    expect(ownServerMemory(2048, 480, [tunnelled], CADDY_EDGE)?.refused).toBeUndefined();
    expect(ownServerMemory(2048, 512, [tunnelled], CADDY_EDGE)?.refused?.message).toBe(
      "Your server has 2048 MB of memory. After 384 MB for the system and 128 MB for OpsCrew's edge, the other OpsCrew app on it takes 1056 MB of memory limits (\"blog\" 1024 MB and 32 MB for its tunnel connector), which leaves 480 MB, and this app's containers have 512 MB of memory limits. Nothing was written.",
    );
  });

  it("checks nothing when inspection could not read the server's memory", () => {
    expect(ownServerMemory(0, 1024, [blog], CADDY_EDGE)).toBeUndefined();
  });

  it("names an extra server, whose services there run with no edge of this app", () => {
    const refused = ownServerMemory(1024, 768, [], 0, "home");
    expect(refused?.refused).toEqual({
      message:
        "Server home has 1024 MB of memory. After 384 MB for the system, 640 MB are left, and this app's services there have 768 MB of memory limits. plan.yaml was not changed.",
      hint: "Lower the memory limits of the services on server home in opscrew/plan.yaml, add memory to the server, or place fewer services on it, then run `opscrew design` again.",
    });
    expect(ownServerMemory(1024, 600, [], 0, "home")?.warning).toBe(
      "Server home keeps only 6% of its memory free after the memory limits of this app (600 MB) and the system, so a container that grows can make the server run out of memory. Lower a memory limit in opscrew/plan.yaml, or add memory to the server.",
    );
  });

  it("counts the nginx edge's memory when the server runs nginx", () => {
    // 1024 - 384 - 192 leaves 448 MB.
    expect(ownServerMemory(1024, 448, [], edgeMemoryMb("nginx"))?.refused).toBeUndefined();
    expect(ownServerMemory(1024, 480, [], edgeMemoryMb("nginx"))?.refused?.message).toBe(
      "Your server has 1024 MB of memory. After 384 MB for the system and 192 MB for OpsCrew's edge, 448 MB are left, and this app's containers have 480 MB of memory limits. Nothing was written.",
    );
  });
});

describe("regionLocations", () => {
  it("maps regions to Hetzner locations in preference order", () => {
    expect(regionLocations("eu-central")).toEqual(["nbg1", "fsn1"]);
    expect(regionLocations("eu-north")).toEqual(["hel1"]);
    expect(regionLocations("us-east")).toEqual(["ash"]);
    expect(regionLocations("us-west")).toEqual(["hil"]);
    expect(regionLocations("ap-southeast")).toEqual(["sin"]);
  });

  it("returns a copy", () => {
    regionLocations("eu-central").push("hel1");
    expect(regionLocations("eu-central")).toEqual(["nbg1", "fsn1"]);
  });
});

describe("sizeFor", () => {
  it.each([
    ["<1k", 1, 2],
    ["1k-10k", 2, 4],
    ["10k-100k", 4, 8],
    [">100k", 8, 16],
  ] as const)("sizes a plain app for %s users", (users, vcpus, memoryGb) => {
    const sizing = sizeFor(makeFacts(), makeRequirements({ expectedMonthlyUsers: users }));
    expect(sizing).toMatchObject({ vcpus, memoryGb, diskGb: 40 });
    expect(sizing.services).toEqual([]);
  });

  it("halves memory for static sites with a 1 GB minimum", () => {
    expect(sizeFor(staticSpaFacts(), makeRequirements())).toMatchObject({
      vcpus: 1,
      memoryGb: 1,
      diskGb: 40,
    });
    expect(
      sizeFor(staticSpaFacts(), makeRequirements({ expectedMonthlyUsers: "10k-100k" })),
    ).toMatchObject({ vcpus: 4, memoryGb: 4 });
  });

  it.each([
    ["<1k", 2, 4],
    ["1k-10k", 4, 8],
    ["10k-100k", 6, 16],
    [">100k", 10, 24],
  ] as const)("adds self-hosted Postgres for %s users", (users, vcpus, memoryGb) => {
    const sizing = sizeFor(nextPostgresFacts(), makeRequirements({ expectedMonthlyUsers: users }));
    expect(sizing).toMatchObject({ vcpus, memoryGb, diskGb: 60 });
    expect(serviceOf(sizing, "postgres")).toBeDefined();
    expect(sizing.externalServices).toEqual([]);
  });

  it("adds 0.5 GB for self-hosted Redis", () => {
    const facts = makeFacts({ services: [{ kind: "redis", evidence: ["dependency:ioredis"] }] });
    const sizing = sizeFor(facts, makeRequirements({ expectedMonthlyUsers: "1k-10k" }));
    expect(sizing).toMatchObject({ vcpus: 2, memoryGb: 4.5, diskGb: 40 });
    expect(sizing.services.map((s) => s.kind)).toEqual(["valkey"]);
  });

  it("adds the same for Redis 8 and Dragonfly, and gives Dragonfly 2 vCPUs and its smallest server", () => {
    const sized = (...evidence: string[]) =>
      sizeFor(makeFacts({ services: [{ kind: "redis", evidence }] }), makeRequirements());
    expect(sized("dependency:redis-om", "redis-modules:redis-om")).toMatchObject({
      vcpus: 1,
      memoryGb: 2.5,
    });
    const dragonfly = sized("dependency:ioredis", "compose-image:dragonfly");
    expect(dragonfly.services.map((s) => s.kind)).toEqual(["dragonfly"]);
    expect(dragonfly).toMatchObject({ vcpus: 2, memoryGb: 2.5 });
    expect(containersText(dragonfly)).toBe("the app and Dragonfly");
  });

  it("keeps an external database when the user asked for it", () => {
    const facts = nextPostgresFacts({
      services: [
        { kind: "postgres", evidence: ["dependency:pg"] },
        { kind: "supabase", evidence: ["dependency:@supabase/supabase-js"] },
        { kind: "redis", evidence: ["env:REDIS_URL"] },
        { kind: "stripe", evidence: ["dependency:stripe"] },
        { kind: "websocket", evidence: ["dependency:ws"] },
      ],
    });
    const kept = sizeFor(
      facts,
      makeRequirements({ keepExternalServices: { supabase: true, redis: true } }),
    );
    expect(kept.services).toEqual([]);
    expect(kept).toMatchObject({ vcpus: 1, memoryGb: 2, diskGb: 40 });
    expect(kept.externalServices).toEqual(["postgres", "redis", "supabase", "stripe"]);

    // Supabase is kept unless the interview says otherwise.
    expect(sizeFor(facts, makeRequirements()).externalServices).toContain("supabase");
    const selfHosted = sizeFor(
      facts,
      makeRequirements({ keepExternalServices: { supabase: false } }),
    );
    expect(selfHosted.services.map((s) => s.kind)).toEqual(["postgres", "valkey"]);
    // A self-hosted Postgres replaces the external database providers.
    expect(selfHosted.externalServices).toEqual(["stripe"]);
  });

  it("holds the containers' memory limits, the edge and the system, and each service's smallest server (FR-1325)", () => {
    // Kafka (1 GB) and the app (512 MB) with 512 MB for the edge and the system: 2 GB, which is
    // also Kafka's smallest server.
    const kafka = makeFacts({ services: [{ kind: "kafka", evidence: ["dependency:kafkajs"] }] });
    const sizing = sizeFor(kafka, makeRequirements({ expectedMonthlyUsers: "<1k" }));
    expect(sizing.limitsMb).toBe(512 + 1024);
    expect(sizing.memoryGb).toBe(2);
    // A worker and cron add their limits: 512 + 2 × 256 + 512 (cron) + 1024 + 512 = 3 GB.
    const components = {
      ...sizing.components,
      processes: {
        workers: [
          {
            name: "worker",
            command: "node worker.js",
            source: "user" as const,
            count: 2,
            single: false,
            stopGraceSeconds: 30,
            memoryMb: 256,
            enabled: true,
          },
        ],
        cron: [{ name: "nightly", schedule: "@daily", command: "node nightly.js", enabled: true }],
      },
    };
    const busy = sizeFor(kafka, makeRequirements(), components);
    expect(busy.limitsMb).toBe(512 + 512 + 512 + 1024);
    expect(busy.memoryGb).toBe(3);
    // The nginx edge's 192 MB: 2560 + 192 + 384 = 3136 MB.
    const nginx = sizeFor(kafka, makeRequirements(), components, "nginx");
    expect(nginx).toMatchObject({ edge: "nginx", edgeMb: 192, memoryGb: 3136 / 1024 });
    expect(busy.edgeMb).toBe(128);
    // Redpanda's smallest server is 2 GB, above what its limits need on a static site.
    const redpanda = sizeFor(staticSpaFacts(), makeRequirements(), {
      ...sizing.components,
      services: sizing.components.services.map((s) => ({
        ...s,
        kind: "redpanda" as const,
        memoryMb: 1024,
        options: {},
      })),
    });
    expect(redpanda.memoryGb).toBe(2);
  });

  it("keeps postgres external when postgres itself is kept", () => {
    const sizing = sizeFor(
      nextPostgresFacts(),
      makeRequirements({ keepExternalServices: { postgres: true } }),
    );
    expect(serviceOf(sizing, "postgres")).toBeUndefined();
    expect(sizing.externalServices).toEqual(["postgres"]);
  });
});
