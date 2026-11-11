import { OpsCrewError } from "@opscrew/core";
import { FAKE_SECRET_KINDS, type FakeSecretKind, fakeSecret } from "@opscrew/core/testing";
import { type CloudProvider, CloudProviderSchema, DEFAULT_IMAGES } from "@opscrew/plan-schema";
import { definition as contabo } from "@opscrew/provider-contabo";
import { definition as digitalocean } from "@opscrew/provider-digitalocean";
import { definition as hetzner } from "@opscrew/provider-hetzner";
import { describe, expect, it } from "vitest";
import { CLOUD_CREDENTIALS, CLOUD_PROVIDERS, cloudProvider } from "./index";
import { validateCloudProvider } from "./validate";

describe("the registry", () => {
  it("lists the built-in definitions in order, as their packages export them", () => {
    expect(CLOUD_PROVIDERS).toHaveLength(3);
    expect(CLOUD_PROVIDERS[0]).toBe(hetzner);
    expect(CLOUD_PROVIDERS[1]).toBe(digitalocean);
    expect(CLOUD_PROVIDERS[2]).toBe(contabo);
  });

  it("has the ids of plan-schema's cloud providers, in order", () => {
    expect(CLOUD_PROVIDERS.map((provider) => provider.id)).toEqual(CloudProviderSchema.options);
  });

  it("returns a provider's definition itself", () => {
    expect(cloudProvider("hetzner")).toBe(hetzner);
    expect(cloudProvider("digitalocean")).toBe(digitalocean);
    expect(cloudProvider("contabo")).toBe(contabo);
  });

  it("names each provider's credentials: every one of a set, else the first", () => {
    expect(CLOUD_CREDENTIALS).toBe(
      "HCLOUD_TOKEN for Hetzner Cloud, DIGITALOCEAN_TOKEN for DigitalOcean, CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS for Contabo",
    );
  });

  it("refuses an unknown provider, naming the known ones", () => {
    let error: unknown;
    try {
      cloudProvider("linode");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: 'OpsCrew does not create servers on "linode".',
      hint: "Choose one of its cloud providers: hetzner, digitalocean and contabo.",
    });
  });
});

describe.each(CLOUD_PROVIDERS.map((provider) => [provider.id, provider] as const))(
  "%s conforms to the contract",
  (_id, provider) => {
    it("passes validation", () => {
      expect(validateCloudProvider(provider)).toBe(provider);
    });

    it("has plan-schema's default image", () => {
      expect(DEFAULT_IMAGES[provider.id as CloudProvider]).toBe(provider.offering.defaultImage);
    });

    it("gives module arguments for the app's server, an extra server and the previous one", () => {
      for (const call of [
        { prefix: "" },
        { prefix: "data_", extra: "data" },
        { prefix: "previous_" },
      ] as const) {
        const args = provider.terraform.moduleArguments(call);
        expect(args[0]?.[0], JSON.stringify(call)).toBe("name");
      }
    });

    it("has no servers without credentials", () => {
      const connector = provider.connector({ env: {} });
      expect(connector.configured).toBe(false);
      expect(connector.servers).toBeUndefined();
    });

    it("recognises a sample of every token format", () => {
      for (const rule of provider.credentials.tokenRules) {
        // Each rule is named after the fakeSecret kind that samples it.
        expect(FAKE_SECRET_KINDS, rule.id).toContain(rule.id);
        const token = fakeSecret(rule.id as FakeSecretKind);
        const sample = `${provider.credentials.envVars[0]}=${token}\n`;
        const [match] = sample.matchAll(rule.pattern);
        expect(match?.[rule.group ?? 0], rule.id).toBe(token);
      }
    });
  },
);
