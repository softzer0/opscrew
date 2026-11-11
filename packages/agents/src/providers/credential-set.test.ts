// A provider whose credentials are a set (`credentials.mode: "all"`, as Contabo's four): here
// DigitalOcean's definition with four variables instead of its token.
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  credentialVars,
  providerCredentials,
  providerFromTokens,
  providerProfile,
} from "./profiles";

const { SET } = vi.hoisted(() => ({ SET: ["SET_ID", "SET_SECRET", "SET_USER", "SET_PASS"] }));

vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const base = actual.cloudProvider("digitalocean");
  const set: CloudProviderDefinition = {
    ...base,
    credentials: { ...base.credentials, envVars: SET, mode: "all" },
  };
  const CLOUD_PROVIDERS = actual.CLOUD_PROVIDERS.map((p) => (p.id === set.id ? set : p));
  return {
    ...actual,
    CLOUD_PROVIDERS,
    cloudProvider: (id: string) =>
      CLOUD_PROVIDERS.find((p) => p.id === id) ?? actual.cloudProvider(id),
  };
});

const all = Object.fromEntries(SET.map((name) => [name, "x"]));

describe("credentials as a set", () => {
  it("reads every variable of the set and names the missing ones", () => {
    const profile = providerProfile("digitalocean");
    expect(profile.tokenMode).toBe("all");
    expect(providerCredentials(profile, {})).toEqual({ missing: SET });
    expect(providerCredentials(profile, { SET_ID: "x", SET_USER: " ", SET_PASS: "y" })).toEqual({
      missing: ["SET_SECRET", "SET_USER"],
    });
    expect(providerCredentials(profile, all)).toEqual({ set: SET, missing: [] });
  });

  it("treats the provider as configured only when all are set", () => {
    const { SET_PASS: _pass, ...three } = all;
    expect(providerFromTokens(three)).toBeUndefined();
    expect(providerFromTokens(all)).toBe("digitalocean");
    expect(providerFromTokens({ ...all, HCLOUD_TOKEN: "h" })).toBeUndefined();
    expect(providerFromTokens({ ...three, HCLOUD_TOKEN: "h" })).toBe("hetzner");
  });

  it("keeps a single token's reading: the first variable set, else the first named", () => {
    const hetzner = providerProfile("hetzner");
    expect(hetzner.tokenMode).toBe("any");
    expect(providerCredentials(hetzner, {})).toEqual({ missing: ["HCLOUD_TOKEN"] });
    expect(credentialVars(["A", "B"], "any", { B: "b" })).toEqual({ set: ["B"], missing: [] });
    expect(credentialVars(["A", "B"], "any", {})).toEqual({ missing: ["A"] });
  });
});
