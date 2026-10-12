import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { vpsConnector } from "./connector";

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
});
