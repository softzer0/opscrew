import { RegionSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  planProvider,
  providerFromTokens,
  providerProfile,
  requestedProvider,
  VPS_PROVIDERS,
} from "./profiles";

describe("provider profiles", () => {
  it("maps every region to at least one named location for every provider", () => {
    for (const id of VPS_PROVIDERS) {
      const profile = providerProfile(id);
      expect(profile.id).toBe(id);
      for (const region of RegionSchema.options) {
        const locations = profile.regionLocations[region];
        expect(locations.length, `${id} ${region}`).toBeGreaterThan(0);
        for (const location of locations) {
          expect(profile.locationNames[location], `${id} ${location}`).toBeDefined();
        }
      }
    }
  });

  it("explains a region served from outside it", () => {
    const digitalocean = providerProfile("digitalocean");
    expect(digitalocean.regionLocations["eu-north"]).toEqual(["ams3"]);
    expect(digitalocean.regionNotes["eu-north"]).toContain("Amsterdam");
    expect(providerProfile("hetzner").regionNotes).toEqual({});
  });

  it("records which providers protect servers against deletion", () => {
    expect(providerProfile("hetzner").deleteProtection).toBe(true);
    expect(providerProfile("digitalocean").deleteProtection).toBe(false);
  });

  it("recognises each provider's unavailable-size and server-limit errors", () => {
    const hetzner = providerProfile("hetzner");
    expect(hetzner.unavailable.test("Error: server type cpx22 out of stock")).toBe(true);
    expect(hetzner.unavailable.test("service unavailable")).toBe(false);
    const digitalocean = providerProfile("digitalocean");
    expect(digitalocean.unavailable.test("422 Size is not available in this region.")).toBe(true);
    expect(digitalocean.serverLimit.test("You have reached your droplet limit")).toBe(true);
    expect(digitalocean.unavailable.test("POST /v2/droplets: 503 Service Unavailable")).toBe(false);
    expect(digitalocean.unavailable.test("503 Service Temporarily Unavailable")).toBe(false);
    expect(digitalocean.serverLimit.test("You have exceeded the rate limit")).toBe(false);
  });
});

describe("provider choice", () => {
  it("reads the plan's provider", () => {
    expect(planProvider({ target: { provider: "digitalocean" } } as never)).toBe("digitalocean");
  });

  it("treats requirements without a provider as Hetzner", () => {
    expect(requestedProvider(undefined)).toBe("hetzner");
    expect(requestedProvider({})).toBe("hetzner");
    expect(requestedProvider({ provider: "digitalocean" })).toBe("digitalocean");
  });

  it("picks the provider whose token is set only when exactly one is", () => {
    expect(providerFromTokens({})).toBeUndefined();
    expect(providerFromTokens({ HCLOUD_TOKEN: "x" })).toBe("hetzner");
    expect(providerFromTokens({ DIGITALOCEAN_ACCESS_TOKEN: "x" })).toBe("digitalocean");
    expect(providerFromTokens({ HCLOUD_TOKEN: "x", DIGITALOCEAN_TOKEN: "y" })).toBeUndefined();
    expect(providerFromTokens({ DIGITALOCEAN_TOKEN: "  " })).toBeUndefined();
  });
});
