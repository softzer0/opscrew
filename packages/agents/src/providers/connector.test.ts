import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { vpsConnector } from "./connector";
import { ownServerConnector } from "./own";

const noFetch = async (): Promise<Response> => {
  throw new Error("no network in tests");
};

function deps(env: Record<string, string | undefined>) {
  return { env, fetch: noFetch, redactor: new Redactor(), version: "0.0.0-test" };
}

describe("vpsConnector", () => {
  it("builds the connector of the requested provider from its token", () => {
    const token = fakeSecret("digitalocean-token");
    const digitalocean = vpsConnector("digitalocean", deps({ DIGITALOCEAN_TOKEN: token }));
    expect(digitalocean.id).toBe("digitalocean");
    expect(digitalocean.configured).toBe(true);
    expect(digitalocean.servers).toBeDefined();

    const hetzner = vpsConnector("hetzner", deps({ DIGITALOCEAN_TOKEN: token }));
    expect(hetzner.id).toBe("hetzner");
    expect(hetzner.configured).toBe(false);
    expect(hetzner.servers).toBeUndefined();
  });

  it("registers the token with the phase's redactor", () => {
    const token = fakeSecret("hcloud-token");
    const d = deps({ HCLOUD_TOKEN: token });
    vpsConnector("hetzner", d);
    expect(d.redactor.redact(`token ${token}`)).not.toContain(token);
  });

  it("uses the dated static catalogue without a token", () => {
    expect(vpsConnector("digitalocean", deps({})).catalog().provider).toBe("digitalocean");
    expect(vpsConnector("hetzner", deps({})).catalog().provider).toBe("hetzner");
  });

  it("never falls back to Hetzner for an own server or an unknown provider", async () => {
    const d = deps({ HCLOUD_TOKEN: fakeSecret("hcloud-token") });
    const own = vpsConnector("own", d);
    expect(own.id).toBe("own");
    expect(own.catalog().provider).toBe("own");
    expect(() => vpsConnector("aws" as never, d)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining('"aws"') }),
    );
  });
});

describe("a server the user owns", () => {
  const now = () => new Date("2026-10-14T10:00:00.000Z");
  const facts = {
    arch: "arm64",
    vcpus: 4,
    memoryGb: 8,
    diskFreeGb: 50,
    os: "Ubuntu 24.04",
  } as const;
  const noFetchAtAll = async (): Promise<Response> => {
    throw new Error("the own-server connector must never use the network");
  };

  it("needs no token, has no server API and describes the SSH login without connecting", async () => {
    const connector = vpsConnector(
      "own",
      { ...deps({}), fetch: noFetchAtAll },
      { ownLogin: { user: "admin", port: 2222, agent: true } },
    );
    expect(connector.configured).toBe(true);
    expect(connector.servers).toBeUndefined();
    expect(connector.credentials.envVars).toEqual([]);
    expect(connector.credentials.description).toMatch(/never asks for or stores a password/);
    const check = await connector.verifyCredentials();
    expect(check.ok).toBe(true);
    expect(check.message).toContain("as admin on port 2222 with the key in your SSH agent");
    expect(check.message).toContain("confirm the server's host key");

    const withKey = ownServerConnector({
      login: { user: "root", port: 22, agent: false, keyPath: "~/.ssh/id_ed25519" },
    });
    expect((await withKey.verifyCredentials()).message).toContain("the key ~/.ssh/id_ed25519");
    const unknown = await ownServerConnector().verifyCredentials();
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toMatch(/opscrew interview/);
  });

  it("offers the inspected server as the single, unpriced option", async () => {
    const catalog = vpsConnector("own", deps({}), { ownServer: facts, now }).catalog();
    expect(catalog.provider).toBe("own");
    expect(await catalog.listLocations()).toHaveLength(1);
    const offers = await catalog.listOffers();
    expect(offers).toEqual([
      {
        provider: "own",
        id: "own",
        description: "Ubuntu 24.04",
        vcpus: 4,
        memoryGb: 8,
        diskGb: 50,
        cpuType: "shared",
        architecture: "arm",
        location: "own",
        monthly: { amount: 0, currency: "EUR" },
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "live",
        asOf: "2026-10-14T10:00:00.000Z",
      },
    ]);
    expect(await catalog.listOffers("own")).toHaveLength(1);
    expect(await catalog.listOffers("nbg1")).toEqual([]);
    expect(await catalog.extras("own")).toMatchObject({ source: "live" });
    const amd64 = ownServerConnector({ facts: { ...facts, arch: "amd64" } });
    const [offer] = await amd64.catalog().listOffers();
    expect(offer).toMatchObject({ architecture: "x86", monthly: { amount: 0, currency: "EUR" } });
  });

  it("has an empty catalogue before the server is inspected and validates the facts", async () => {
    expect(await ownServerConnector().catalog().listOffers()).toEqual([]);
    expect(() => ownServerConnector({ facts: { ...facts, memoryGb: -1 } })).toThrow();
    expect(() => ownServerConnector({ facts: { ...facts, vcpus: 0 } })).toThrow();
    // A full disk is a fact design warns about, not invalid input.
    const full = ownServerConnector({ facts: { ...facts, diskFreeGb: 0 } });
    expect((await full.catalog().listOffers())[0]?.diskGb).toBe(0);
    expect(() => ownServerConnector({ facts: { ...facts, arch: "riscv" } as never })).toThrow();
  });
});
