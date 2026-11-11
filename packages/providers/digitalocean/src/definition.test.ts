import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { definition } from "./index";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];

describe("DigitalOcean's definition", () => {
  it("has every part of contract version 1", () => {
    expect(definition.contractVersion).toBe(1);
    expect(definition.id).toBe("digitalocean");
    expect(definition.displayName).toBe("DigitalOcean");
    expect(definition.name).toBe("DigitalOcean");
    expect(definition.serverNoun).toBe("Droplet");
    expect(definition.credentials).toMatchObject({
      envVars: ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"],
      mode: "any",
      envPrefixes: ["DIGITALOCEAN"],
    });
    expect(definition.offering).toMatchObject({
      snapshots: { kind: "per-gb" },
      serverSnapshotsOutliveServer: true,
      resize: true,
      removal: { kind: "delete" },
    });
    expect(definition.terraform.serverResourceType).toBe("digitalocean_droplet");
    expect(definition.terraform.firewallResourceType).toBe("digitalocean_firewall");
    expect(definition.terraform.module.name).toBe("digitalocean-droplet");
    expect(definition.texts.design.livePricesVar).toBe("DIGITALOCEAN_TOKEN");
    expect(definition.texts.destroy.storageConsole).toBe(
      "the DigitalOcean control panel (Spaces Object Storage)",
    );
    expect(definition.texts.init.scopeNote).toContain("cannot report which scopes");
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("maps every one of OpsCrew's regions to named locations with coordinates", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    for (const region of REGIONS) {
      const list = locations[region] ?? [];
      expect(list.length).toBeGreaterThan(0);
      for (const location of list) {
        expect(locationNames[location]).toBeTruthy();
        expect(coordinates[location]).toHaveLength(2);
      }
    }
    for (const region of Object.keys(notes)) expect(REGIONS).toContain(region);
  });

  it("renders the app's Droplet's module arguments with its own tag", () => {
    expect(definition.terraform.moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["region", "var.location"],
      ["size", "var.server_type"],
      ["image", "var.image"],
      ["backups", "var.backups"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["app_tag", '"opscrew-app:${var.app_name}"'],
      ["shared_tags", '["managed-by:opscrew"]'],
    ]);
  });

  it("renders a previous Droplet's arguments with the previous_ prefix", () => {
    const args = definition.terraform.moduleArguments({ prefix: "previous_" });
    expect(args).toContainEqual(["region", "var.previous_location"]);
    expect(args).toContainEqual(["size", "var.previous_server_type"]);
    expect(args).toContainEqual(["backups", "var.previous_backups"]);
    expect(args).toContainEqual(["http_allowed_cidrs", "var.http_allowed_cidrs"]);
  });

  it("renders an extra Droplet without web CIDRs, with or without the shared app tag", () => {
    const own = definition.terraform.moduleArguments({ prefix: "db_", extra: "db" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    expect(own[0]).toEqual(["name", '"${var.app_name}-db"']);
    expect(own).toContainEqual(["region", "var.db_location"]);
    expect(own.map(([name]) => name)).not.toContain("http_allowed_cidrs");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    expect(own).toContainEqual(["app_tag", '"opscrew-app:${var.app_name}"']);

    const shared = definition.terraform.moduleArguments({
      prefix: "db_",
      extra: "db",
      appTag: "digitalocean_tag.app.name",
    });
    expect(shared.map(([name]) => name)).not.toContain("app_tag");
    expect(shared.at(-1)).toEqual([
      "shared_tags",
      '[digitalocean_tag.app.name, "managed-by:opscrew"]',
    ]);
    expect(definition.terraform.extraShared.appTag).toBe("digitalocean_tag.app.name");
  });

  it("recognises a DigitalOcean token", () => {
    const [rule] = definition.credentials.tokenRules;
    expect(rule?.id).toBe("digitalocean-token");
    const sample = fakeSecret("digitalocean-token");
    const matches = [...`DIGITALOCEAN_TOKEN=${sample}\n`.matchAll(rule?.pattern ?? /(?!)/g)];
    expect(matches.map((match) => match[0])).toEqual([sample]);
  });

  it("holds the module as generated from module/, without the shared cloud-init", () => {
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files)).not.toContain("cloud-init.yaml.tftpl");
  });
});
