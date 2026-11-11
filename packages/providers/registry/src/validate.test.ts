import { OpsCrewError } from "@opscrew/core";
import { definition as hetzner } from "@opscrew/provider-hetzner";
import { describe, expect, it } from "vitest";
import { validateCloudProvider } from "./validate";

const { credentials, regions, terraform } = hetzner;
const { resizeOffline: _resizeOffline, ...withoutResize } = hetzner.texts;

/** The message `validateCloudProvider` throws for `candidate`. */
function failure(candidate: unknown): string {
  try {
    validateCloudProvider(candidate);
  } catch (error) {
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INTERNAL");
    return (error as OpsCrewError).message;
  }
  throw new Error("the definition passed validation");
}

describe("validateCloudProvider", () => {
  it("returns a valid definition itself", () => {
    expect(validateCloudProvider(hetzner)).toBe(hetzner);
  });

  it("accepts the optional branches a provider such as Contabo uses", () => {
    const { livePricesVar: _livePricesVar, ...design } = hetzner.texts.design;
    const contabo = {
      ...hetzner,
      credentials: { ...credentials, mode: "all", tokenRules: [] },
      offering: {
        ...hetzner.offering,
        snapshots: { kind: "included" },
        removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
        resize: false,
      },
      texts: { ...withoutResize, design },
    };
    expect(validateCloudProvider(contabo)).toBe(contabo);
  });

  it("wants the resize downtime exactly when the provider resizes in place", () => {
    expect(failure({ ...hetzner, texts: withoutResize })).toContain(
      "texts.resizeOffline: is needed exactly when offering.resize is true",
    );
    expect(failure({ ...hetzner, offering: { ...hetzner.offering, resize: false } })).toContain(
      "texts.resizeOffline: is needed exactly when offering.resize is true",
    );
  });

  it("refuses another contract version", () => {
    const message = failure({ ...hetzner, contractVersion: 2 });
    expect(message).toContain('The cloud provider definition "hetzner" is not valid');
    expect(message).toContain("contractVersion");
  });

  it("names a missing part", () => {
    const { texts: _texts, ...rest } = hetzner;
    expect(failure(rest)).toContain("texts:");
  });

  it("names a missing field within a part", () => {
    const { apiPattern: _apiPattern, ...rest } = credentials;
    expect(failure({ ...hetzner, credentials: rest })).toContain("credentials.apiPattern:");
  });

  it("names a definition without an id", () => {
    const { id: _id, ...rest } = hetzner;
    const message = failure(rest);
    expect(message).toContain("A cloud provider definition without an id is not valid");
    expect(message).toContain("id:");
  });

  it("wants functions as functions", () => {
    expect(failure({ ...hetzner, connector: "hetzner" })).toContain(
      "connector: must be a function",
    );
  });

  it("wants regular expressions as RegExps", () => {
    const offering = { ...hetzner.offering, unavailable: "out of stock" };
    expect(failure({ ...hetzner, offering })).toContain("offering.unavailable:");
  });

  it("refuses a region OpsCrew does not have", () => {
    const locations = { ...regions.locations, "mars-north": ["nbg1"] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations:");
    expect(message).toContain("mars-north");
  });

  it("wants every OpsCrew region mapped", () => {
    const { "us-west": _usWest, ...locations } = regions.locations;
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations.us-west: maps no location");
  });

  it("refuses a region mapped to no location", () => {
    const locations = { ...regions.locations, "us-west": [] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locations.us-west: maps no location");
  });

  it("wants token patterns global", () => {
    const [rule] = credentials.tokenRules;
    const tokenRules = [{ ...rule, pattern: new RegExp(rule?.pattern.source ?? "") }];
    const message = failure({ ...hetzner, credentials: { ...credentials, tokenRules } });
    expect(message).toContain(
      "credentials.tokenRules.0.pattern: must be a global regular expression",
    );
  });

  it("wants a name and coordinates for every location it maps", () => {
    const locations = { ...regions.locations, "eu-central": ["nbg1", "xyz1"] };
    const message = failure({ ...hetzner, regions: { ...regions, locations } });
    expect(message).toContain("regions.locationNames.xyz1: names no location xyz1");
    expect(message).toContain("regions.coordinates.xyz1: has no coordinates for xyz1");
  });

  it("wants module files", () => {
    const module = { ...terraform.module, files: {} };
    const message = failure({ ...hetzner, terraform: { ...terraform, module } });
    expect(message).toContain("terraform.module.files: has no files");
  });

  it("refuses a module's own cloud-init", () => {
    const files = { ...terraform.module.files, "cloud-init.yaml.tftpl": "#cloud-config\n" };
    const module = { ...terraform.module, files };
    const message = failure({ ...hetzner, terraform: { ...terraform, module } });
    expect(message).toContain("terraform.module.files.cloud-init.yaml.tftpl:");
  });

  it("wants at least one credential variable", () => {
    const message = failure({ ...hetzner, credentials: { ...credentials, envVars: [] } });
    expect(message).toContain("credentials.envVars:");
  });
});
