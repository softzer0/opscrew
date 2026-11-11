import { fileURLToPath } from "node:url";
import { CLOUD_PROVIDER_CONTRACT_VERSION } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { definition } from "./index";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];

describe("Hetzner's cloud provider definition", () => {
  it("has the contract's version and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "hetzner",
      displayName: "Hetzner Cloud",
      name: "Hetzner",
      serverNoun: "server",
    });
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
    expect(definition.credentials.mode).toBe("any");
    expect(definition.offering).toMatchObject({
      snapshots: { kind: "per-gb" },
      serverSnapshotsOutliveServer: true,
      resize: true,
      removal: { kind: "delete" },
    });
  });

  it("maps every OpsCrew region to named locations with coordinates", () => {
    const { locations, locationNames, coordinates } = definition.regions;
    expect(Object.keys(locations).sort()).toEqual([...REGIONS].sort());
    for (const region of REGIONS) {
      const list = locations[region] ?? [];
      expect(list.length, region).toBeGreaterThan(0);
      for (const location of list) {
        expect(locationNames[location], location).toBeTruthy();
        expect(coordinates[location], location).toHaveLength(2);
      }
    }
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments } = definition.terraform;
    const labels = ["labels", '{ "managed-by" = "opscrew", app = var.app_name }'];
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["backups", "var.backups"],
      ["delete_protection", "var.delete_protection"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
      labels,
    ]);
    expect(moduleArguments({ prefix: "worker_", extra: "worker" })).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-worker"'],
      ["location", "var.worker_location"],
      ["server_type", "var.worker_server_type"],
      ["image", "var.worker_image"],
      ["backups", "var.worker_backups"],
      ["delete_protection", "var.worker_delete_protection"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      labels,
    ]);
    expect(moduleArguments({ prefix: "previous_" })).toEqual([
      ["name", "var.app_name"],
      ["location", "var.previous_location"],
      ["server_type", "var.previous_server_type"],
      ["image", "var.previous_image"],
      ["backups", "var.previous_backups"],
      ["delete_protection", "var.previous_delete_protection"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
      labels,
    ]);
  });

  it("recognises a Hetzner Cloud token with its rule", () => {
    const token = fakeSecret("hcloud-token");
    const [rule] = definition.credentials.tokenRules;
    expect(rule?.id).toBe("hcloud-token");
    const matches = [...`HCLOUD_TOKEN=${token}\n`.matchAll(rule?.pattern ?? /(?!)/g)];
    expect(matches.map((match) => match[rule?.group ?? 0])).toEqual([token]);
  });

  it("embeds the current module, without the shared cloud-init", () => {
    expect(definition.terraform.module.name).toBe("hetzner-vps");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files)).not.toContain("cloud-init.yaml.tftpl");
  });
});
