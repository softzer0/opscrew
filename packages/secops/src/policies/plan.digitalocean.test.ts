import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { blockingPolicyFailures, evaluatePlanPolicies, plannedResources } from "./index";

const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22"];
const CF_V6 = ["2400:cb00::/32"];
const WORLD = ["0.0.0.0/0", "::/0"];

function deployPlan(
  overrides: { backups?: boolean; proxied?: boolean; sshAllowedCidrs?: string[] } = {},
) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "digitalocean",
      mode: "vps-compose",
      location: "fra1",
      serverType: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      backups: overrides.backups ?? true,
    },
    services: [
      {
        name: "db",
        kind: "postgres",
        version: "17",
        memoryMb: 512,
        enabled: true,
        options: {},
        reason: "The app uses PostgreSQL.",
        licence: "PostgreSQL",
      },
    ],
    externalServices: [],
    cost: {
      monthly: { amount: 28.8, currency: "USD" },
      breakdown: [{ item: "server", monthly: { amount: 28.8, currency: "USD" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-12T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: {
      provider: "cloudflare",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: overrides.proxied ?? true,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: overrides.sshAllowedCidrs ? { sshAllowedCidrs: overrides.sshAllowedCidrs } : {},
  });
}

interface Opts {
  /** How the firewall names the Droplet: config reference only (first plan), known id, or not. */
  attach?: "reference" | "known-id" | "none";
  withFirewall?: boolean;
  sshKeys?: boolean;
  backups?: boolean;
  sshSources?: string[];
  webSources?: string[];
  extraRules?: Record<string, unknown>[];
}

/** A `show -json` document shaped like the OpsCrew DigitalOcean root module (module `server`). */
function planJson(o: Opts = {}) {
  const attach = o.attach ?? "reference";
  const web = o.webSources ?? [...CF_V4, ...CF_V6];
  const droplet = {
    address: "module.server.digitalocean_droplet.this",
    mode: "managed",
    type: "digitalocean_droplet",
    name: "this",
    values: {
      name: "shop",
      region: "fra1",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      backups: o.backups ?? true,
      monitoring: true,
      ipv6: true,
      ...(attach === "known-id" ? { id: "512345678" } : {}),
      ...(o.sshKeys === false ? { ssh_keys: [] } : {}),
    },
  };
  const firewall = {
    address: "module.server.digitalocean_firewall.this",
    mode: "managed",
    type: "digitalocean_firewall",
    name: "this",
    values: {
      name: "shop-fw",
      ...(attach === "known-id" ? { droplet_ids: [512345678] } : {}),
      inbound_rule: [
        { protocol: "tcp", port_range: "22", source_addresses: o.sshSources ?? WORLD },
        { protocol: "tcp", port_range: "80", source_addresses: web },
        { protocol: "tcp", port_range: "443", source_addresses: web },
        { protocol: "udp", port_range: "443", source_addresses: web },
        { protocol: "icmp", port_range: "", source_addresses: WORLD },
        ...(o.extraRules ?? []),
      ],
      outbound_rule: [
        { protocol: "tcp", port_range: "all", destination_addresses: WORLD },
        { protocol: "udp", port_range: "all", destination_addresses: WORLD },
      ],
    },
  };
  const sshKey = {
    address: "module.server.digitalocean_ssh_key.deploy",
    mode: "managed",
    type: "digitalocean_ssh_key",
    name: "deploy",
    values: { name: "shop-deploy" },
  };
  const tags = ["opscrew", "opscrew-shop"].map((tag, index) => ({
    address: `module.server.digitalocean_tag.this[${index}]`,
    mode: "managed",
    type: "digitalocean_tag",
    name: "this",
    index,
    values: { name: tag },
  }));
  const dropletUnknown: Record<string, unknown> = { id: true, ipv4_address: true, urn: true };
  if (o.sshKeys !== false) dropletUnknown.ssh_keys = [true];
  const firewallUnknown: Record<string, unknown> = { id: true };
  if (attach === "reference") firewallUnknown.droplet_ids = true;
  const firewallConfig = {
    address: "digitalocean_firewall.this",
    mode: "managed",
    type: "digitalocean_firewall",
    name: "this",
    expressions: {
      name: { references: ["var.name"] },
      ...(attach === "reference"
        ? {
            droplet_ids: {
              references: ["digitalocean_droplet.this.id", "digitalocean_droplet.this"],
            },
          }
        : {}),
    },
  };
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources:
              o.withFirewall === false
                ? [droplet, sshKey, ...tags]
                : [droplet, firewall, sshKey, ...tags],
          },
        ],
      },
    },
    resource_changes: [
      {
        address: "module.server.digitalocean_droplet.this",
        change: { actions: ["create"], after_unknown: dropletUnknown },
      },
      {
        address: "module.server.digitalocean_firewall.this",
        change: { actions: ["create"], after_unknown: firewallUnknown },
      },
    ],
    configuration: {
      root_module: {
        module_calls: {
          server: {
            source: "./modules/do-server",
            module: {
              resources: [
                {
                  address: "digitalocean_droplet.this",
                  mode: "managed",
                  type: "digitalocean_droplet",
                  name: "this",
                  expressions: { ssh_keys: { references: ["digitalocean_ssh_key.deploy.id"] } },
                },
                ...(o.withFirewall === false ? [] : [firewallConfig]),
              ],
            },
          },
        },
      },
    },
  };
}

const failed = (results: ReturnType<typeof evaluatePlanPolicies>) =>
  results
    .filter((r) => !r.passed)
    .map((r) => r.policyId)
    .sort();

describe("evaluatePlanPolicies (DigitalOcean)", () => {
  it("reads every resource of the DigitalOcean root", () => {
    expect(plannedResources(planJson()).map((r) => r.address)).toEqual([
      "module.server.digitalocean_droplet.this",
      "module.server.digitalocean_firewall.this",
      "module.server.digitalocean_ssh_key.deploy",
      "module.server.digitalocean_tag.this[0]",
      "module.server.digitalocean_tag.this[1]",
    ]);
  });

  it("passes the plan OpsCrew renders (firewall attached through a configuration reference)", () => {
    const results = evaluatePlanPolicies(planJson(), deployPlan());
    expect(failed(results)).toEqual([]);
    expect(results.map((r) => r.policyId).sort()).toEqual(
      [
        "backups-for-critical-data",
        "firewall-attached",
        "no-open-admin-ports",
        "origin-cloudflare-only",
        "ssh-keys-set",
        "ssh-not-public",
      ].sort(),
    );
    const attached = results.find((r) => r.policyId === "firewall-attached");
    expect(attached).toMatchObject({
      passed: true,
      resource: "module.server.digitalocean_droplet.this",
    });
  });

  it("accepts a known Droplet id in the firewall's droplet_ids", () => {
    expect(failed(evaluatePlanPolicies(planJson({ attach: "known-id" }), deployPlan()))).toEqual(
      [],
    );
  });

  it("fails a firewall that does not list the Droplet", () => {
    const results = evaluatePlanPolicies(planJson({ attach: "none" }), deployPlan());
    expect(failed(results)).toEqual(["firewall-attached"]);
    expect(blockingPolicyFailures(results).map((r) => r.policyId)).toEqual(["firewall-attached"]);
  });

  it("fails a plan without any firewall or SSH key", () => {
    const results = evaluatePlanPolicies(
      planJson({ withFirewall: false, sshKeys: false }),
      deployPlan(),
    );
    expect(failed(results)).toEqual(["firewall-attached", "firewall-attached", "ssh-keys-set"]);
    expect(results.find((r) => r.policyId === "ssh-keys-set")?.message).toContain("DigitalOcean");
  });

  it("fails SSH open to the world unless the plan allows it", () => {
    const restricted = deployPlan({ sshAllowedCidrs: ["198.51.100.7/32"] });
    const results = evaluatePlanPolicies(planJson(), restricted);
    expect(failed(results)).toEqual(["ssh-not-public"]);
    expect(blockingPolicyFailures(results)).toHaveLength(1);
    expect(
      failed(evaluatePlanPolicies(planJson({ sshSources: ["198.51.100.7/32"] }), restricted)),
    ).toEqual([]);
    expect(
      failed(evaluatePlanPolicies(planJson(), deployPlan({ sshAllowedCidrs: WORLD }))),
    ).toEqual([]);
  });

  it("blocks databases and all-port rules open to the internet (critical)", () => {
    const results = evaluatePlanPolicies(
      planJson({
        extraRules: [
          { protocol: "tcp", port_range: "5432", source_addresses: ["0.0.0.0/0"] },
          { protocol: "udp", port_range: "all", source_addresses: ["::/0"] },
        ],
      }),
      deployPlan(),
    );
    const open = results.find((r) => r.policyId === "no-open-admin-ports");
    expect(open).toMatchObject({ passed: false, severity: "critical" });
    expect(open?.message).toContain("tcp/5432");
    expect(open?.message).toContain("udp/any");
  });

  it("requires Cloudflare-only web ports when proxied", () => {
    const results = evaluatePlanPolicies(planJson({ webSources: WORLD }), deployPlan());
    expect(failed(results)).toEqual(["origin-cloudflare-only"]);
  });

  it("enforces backups the plan asked for", () => {
    expect(
      failed(evaluatePlanPolicies(planJson({ backups: false }), deployPlan({ backups: true }))),
    ).toEqual(["backups-for-critical-data"]);
    expect(
      evaluatePlanPolicies(planJson({ backups: false }), deployPlan({ backups: false })).some(
        (r) => r.policyId === "backups-for-critical-data",
      ),
    ).toBe(false);
  });

  // The safety gate's exact results (ids, severities, messages, resources): any change to them
  // must show up here.
  it("reports every DigitalOcean check with its exact result when all pass and when all fail", () => {
    expect(evaluatePlanPolicies(planJson(), deployPlan())).toMatchSnapshot("all pass");
    const failing = evaluatePlanPolicies(
      planJson({
        attach: "none",
        sshKeys: false,
        backups: false,
        webSources: WORLD,
        extraRules: [{ protocol: "tcp", port_range: "5432", source_addresses: ["0.0.0.0/0"] }],
      }),
      deployPlan({ sshAllowedCidrs: ["198.51.100.7/32"] }),
    );
    expect(failing.every((r) => !r.passed)).toBe(true);
    expect(failing).toMatchSnapshot("all fail");
    expect(evaluatePlanPolicies(planJson({ withFirewall: false }), deployPlan())).toMatchSnapshot(
      "no firewall",
    );
  });
});
