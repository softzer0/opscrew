import { serviceOf } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, makeRequirements, nextPostgresFacts, staticSpaFacts } from "../testing";
import { regionLocations, sizeFor } from "./sizing";

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
