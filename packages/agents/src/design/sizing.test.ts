import { describe, expect, it } from "vitest";
import {
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
} from "./__fixtures__/catalog";
import { regionLocations, sizeFor } from "./index";

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
    expect(sizing.services).toEqual({ postgres: false, redis: false });
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
    expect(sizing.services.postgres).toBe(true);
    expect(sizing.externalServices).toEqual([]);
  });

  it("adds 0.5 GB for self-hosted Redis", () => {
    const facts = makeFacts({ services: [{ kind: "redis", evidence: ["dependency:ioredis"] }] });
    const sizing = sizeFor(facts, makeRequirements({ expectedMonthlyUsers: "1k-10k" }));
    expect(sizing).toMatchObject({ vcpus: 2, memoryGb: 4.5, diskGb: 40 });
    expect(sizing.services).toEqual({ postgres: false, redis: true });
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
    const kept = sizeFor(facts, makeRequirements({ keepExternalServices: ["supabase", "redis"] }));
    expect(kept.services).toEqual({ postgres: false, redis: false });
    expect(kept).toMatchObject({ vcpus: 1, memoryGb: 2, diskGb: 40 });
    expect(kept.externalServices).toEqual(["postgres", "redis", "supabase", "stripe"]);

    const selfHosted = sizeFor(facts, makeRequirements());
    expect(selfHosted.services).toEqual({ postgres: true, redis: true });
    // A self-hosted Postgres replaces the external database providers.
    expect(selfHosted.externalServices).toEqual(["stripe"]);
  });

  it("keeps postgres external when postgres itself is kept", () => {
    const sizing = sizeFor(
      nextPostgresFacts(),
      makeRequirements({ keepExternalServices: ["postgres"] }),
    );
    expect(sizing.services.postgres).toBe(false);
    expect(sizing.externalServices).toEqual(["postgres"]);
  });
});
