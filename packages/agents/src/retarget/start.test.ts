import type { DesignOption } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { targetOf } from "./start";

/** A design option on `provider`, as design builds them. */
function option(provider: DesignOption["target"]["provider"]): DesignOption {
  return {
    id: `${provider}-option`,
    title: "An option",
    summary: "A server for the app.",
    target: {
      provider,
      location: "nbg1",
      serverType: "cpx22",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 80,
      cpuType: "shared",
      architecture: "x86",
    },
    services: [],
    externalServices: [],
    backups: true,
    cost: {
      monthly: { amount: 7.99, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 7.99, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    fitsBudget: true,
    recommended: true,
    tradeoffs: [],
  };
}

describe("targetOf: the new target of a move", () => {
  it("is the chosen server, with the provider's default image and the old proxy", () => {
    expect(targetOf(option("hetzner"), "nginx")).toEqual({
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cpx22",
      image: "ubuntu-24.04",
      backups: true,
      edge: "nginx",
    });
  });

  it.each([
    ["cloudflare-workers", "Cloudflare hosting"],
    ["github-pages", "GitHub Pages"],
  ] as const)("refuses moving onto %s", (provider, name) => {
    expect(() => targetOf(option(provider), "caddy")).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message: `Moving an app to or from ${name} is not available yet: moving to and from server-less targets comes with retarget anywhere.`,
      }),
    );
  });
});
