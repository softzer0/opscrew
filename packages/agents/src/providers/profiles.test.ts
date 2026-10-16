import { RegionSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  PORTAINER_TOKEN_VAR,
  planProvider,
  providerFromTokens,
  providerProfile,
  requestedProvider,
  requestedRegion,
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

  it("links each provider's account page", () => {
    expect(providerProfile("hetzner").accountUrl).toBe("https://console.hetzner.cloud/");
    expect(providerProfile("digitalocean").accountUrl).toBe(
      "https://cloud.digitalocean.com/account",
    );
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

  it("describes a server the user owns: no token, regions, delete protection or backups", () => {
    const own = providerProfile("own");
    expect(own).toMatchObject({
      id: "own",
      displayName: "Your own server",
      serverNoun: "server",
      tokenVars: [],
      deleteProtection: false,
      providerBackups: false,
      backupsOutliveServer: false,
      backupPercent: 0,
      locationNames: {},
      regionNotes: {},
      mirroredAttributes: {},
    });
    for (const region of RegionSchema.options) expect(own.regionLocations[region]).toEqual([]);
    expect(own.unavailable.test("out of stock")).toBe(false);
    expect(own.serverLimit.test("server limit")).toBe(false);
    expect(providerProfile("hetzner").providerBackups).toBe(true);
    expect(providerProfile("digitalocean").providerBackups).toBe(true);
    // Token-based provider lists never include it.
    expect(VPS_PROVIDERS).not.toContain("own");
    expect(providerFromTokens({ HCLOUD_TOKEN: "x" })).toBe("hetzner");
  });

  it("describes an existing Portainer: its token, no catalogue, no price, no host changes", () => {
    const portainer = providerProfile("portainer");
    expect(portainer).toEqual({
      id: "portainer",
      displayName: "My existing Portainer",
      tokenVars: [PORTAINER_TOKEN_VAR],
    });
    expect(PORTAINER_TOKEN_VAR).toBe("PORTAINER_API_KEY");
    // Not a server provider: never inferred from tokens, never in the cloud provider list.
    expect(VPS_PROVIDERS).not.toContain("portainer");
    expect(providerFromTokens({ PORTAINER_API_KEY: "x" })).toBeUndefined();
    expect(providerFromTokens({ PORTAINER_API_KEY: "x", HCLOUD_TOKEN: "y" })).toBe("hetzner");
  });

  it("refuses an unknown provider id instead of using another provider", () => {
    expect(() => providerProfile("aws" as never)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining('"aws"') }),
    );
  });

  it("reads the region for cloud providers only", () => {
    expect(requestedRegion({ region: "us-east" })).toBe("us-east");
    expect(requestedRegion({ provider: "digitalocean", region: "eu-north" })).toBe("eu-north");
    expect(requestedRegion({ provider: "own", region: "eu-central" })).toBeUndefined();
    expect(requestedRegion({ provider: "own" })).toBeUndefined();
    expect(() => requestedRegion({ provider: "hetzner" })).toThrow(
      expect.objectContaining({
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("Hetzner Cloud"),
      }),
    );
  });
});
