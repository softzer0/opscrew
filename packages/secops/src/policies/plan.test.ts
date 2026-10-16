import type { PolicyResult } from "@opscrew/contracts";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { blockingPolicyFailures, evaluatePlanPolicies, plannedResources } from "./index";

const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22"];
const CF_V6 = ["2400:cb00::/32"];

function deployPlan(overrides: { proxied?: boolean; backups?: boolean; dns?: boolean } = {}) {
  const dns = overrides.dns ?? true;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: overrides.backups ?? true,
    },
    services: { postgres: true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 7.09, currency: "EUR" },
      breakdown: [
        { item: "server", monthly: { amount: 6.59, currency: "EUR" } },
        { item: "ipv4", monthly: { amount: 0.5, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: dns
      ? {
          provider: "cloudflare",
          domain: "shop.example.com",
          zone: "example.com",
          proxied: overrides.proxied ?? true,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
  });
}

interface Opts {
  firewallIds?: "known" | "unknown" | "none";
  sshKeys?: boolean;
  deleteProtection?: boolean;
  backups?: boolean;
  webSources?: string[];
  extraRules?: Record<string, unknown>[];
  proxiedRecord?: boolean;
  withFirewall?: boolean;
}

/** A hand-written `show -json` document shaped like the OpsCrew root module. */
function planJson(o: Opts = {}) {
  const web = o.webSources ?? [...CF_V4, ...CF_V6];
  const server = {
    address: "module.server.hcloud_server.this",
    mode: "managed",
    type: "hcloud_server",
    name: "this",
    values: {
      name: "shop",
      server_type: "cx23",
      location: "nbg1",
      backups: o.backups ?? true,
      delete_protection: o.deleteProtection ?? true,
      rebuild_protection: o.deleteProtection ?? true,
      ...(o.firewallIds === "known" ? { firewall_ids: [123] } : {}),
      ...(o.sshKeys === false ? { ssh_keys: [] } : {}),
    },
  };
  const firewall = {
    address: "module.server.hcloud_firewall.this",
    mode: "managed",
    type: "hcloud_firewall",
    name: "this",
    values: {
      name: "shop-fw",
      rule: [
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"] },
        { direction: "in", protocol: "tcp", port: "80", source_ips: web },
        { direction: "in", protocol: "tcp", port: "443", source_ips: web },
        { direction: "in", protocol: "udp", port: "443", source_ips: web },
        { direction: "in", protocol: "icmp", port: null, source_ips: ["0.0.0.0/0", "::/0"] },
        ...(o.extraRules ?? []),
      ],
    },
  };
  const record = {
    address: "module.dns.cloudflare_dns_record.a",
    mode: "managed",
    type: "cloudflare_dns_record",
    name: "a",
    values: { name: "shop.example.com", type: "A", proxied: o.proxiedRecord ?? true, ttl: 1 },
  };
  const unknown: Record<string, unknown> = { id: true, ipv4_address: true };
  if ((o.firewallIds ?? "unknown") === "unknown") unknown.firewall_ids = true;
  if (o.sshKeys !== false) unknown.ssh_keys = [true];
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources: o.withFirewall === false ? [server] : [server, firewall],
          },
          {
            address: "module.dns",
            resources: [
              record,
              { address: "data.x.y", mode: "data", type: "x", name: "y", values: {} },
            ],
          },
        ],
      },
    },
    resource_changes: [
      {
        address: "module.server.hcloud_server.this",
        change: { actions: ["create"], after_unknown: unknown },
      },
    ],
  };
}

const failed = (results: ReturnType<typeof evaluatePlanPolicies>) =>
  results
    .filter((r) => !r.passed)
    .map((r) => r.policyId)
    .sort();

describe("plannedResources", () => {
  it("walks child modules, skips data sources and merges after_unknown", () => {
    const resources = plannedResources(planJson());
    expect(resources.map((r) => r.type)).toEqual([
      "hcloud_server",
      "hcloud_firewall",
      "cloudflare_dns_record",
    ]);
    expect(resources[0]?.unknown.firewall_ids).toBe(true);
  });

  it("tolerates garbage", () => {
    expect(plannedResources(undefined)).toEqual([]);
    expect(plannedResources({ planned_values: { root_module: { resources: "x" } } })).toEqual([]);
  });
});

describe("evaluatePlanPolicies", () => {
  it("passes the plan OpsCrew renders (firewall id still unknown at plan time)", () => {
    const results = evaluatePlanPolicies(planJson(), deployPlan());
    expect(failed(results)).toEqual([]);
    expect(results.map((r) => r.policyId)).toEqual(
      expect.arrayContaining([
        "firewall-attached",
        "ssh-keys-set",
        "delete-protection",
        "backups-for-critical-data",
        "no-open-admin-ports",
        "origin-cloudflare-only",
        "dns-proxied",
      ]),
    );
    expect(blockingPolicyFailures(results)).toEqual([]);
  });

  it("flags SSH open to the internet when the plan limits it to specific ranges", () => {
    const plan = deployPlan();
    const limited = {
      ...plan,
      security: { ...plan.security, sshAllowedCidrs: ["203.0.113.0/24"] },
    };
    expect(failed(evaluatePlanPolicies(planJson(), limited))).toEqual(["ssh-not-public"]);
    expect(evaluatePlanPolicies(planJson(), plan).map((r) => r.policyId)).toContain(
      "ssh-not-public",
    );
  });

  it("accepts a known firewall id on updates", () => {
    expect(failed(evaluatePlanPolicies(planJson({ firewallIds: "known" }), deployPlan()))).toEqual(
      [],
    );
  });

  it("fails a server without firewall, ssh keys or protection", () => {
    const results = evaluatePlanPolicies(
      planJson({
        firewallIds: "none",
        sshKeys: false,
        deleteProtection: false,
        withFirewall: false,
      }),
      deployPlan(),
    );
    expect(failed(results)).toEqual([
      "delete-protection",
      "firewall-attached",
      "firewall-attached",
      "ssh-keys-set",
    ]);
    expect(blockingPolicyFailures(results).map((r) => r.policyId)).toContain("ssh-keys-set");
  });

  it("blocks databases open to the internet (critical)", () => {
    const results = evaluatePlanPolicies(
      planJson({
        extraRules: [{ direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] }],
      }),
      deployPlan(),
    );
    const open = results.find((r) => r.policyId === "no-open-admin-ports");
    expect(open).toMatchObject({ passed: false, severity: "critical" });
    expect(open?.message).toContain("tcp/5432");
  });

  it("flags port ranges and any-port rules", () => {
    const results = evaluatePlanPolicies(
      planJson({
        extraRules: [{ direction: "in", protocol: "tcp", port: "1-65535", source_ips: ["::/0"] }],
      }),
      deployPlan(),
    );
    expect(failed(results)).toEqual(["no-open-admin-ports"]);
  });

  it("requires Cloudflare-only web ports when proxied", () => {
    const results = evaluatePlanPolicies(
      planJson({ webSources: ["0.0.0.0/0", "::/0"] }),
      deployPlan(),
    );
    expect(failed(results)).toEqual(["origin-cloudflare-only"]);
    expect(blockingPolicyFailures(results)).toEqual([]);
  });

  it("does not require Cloudflare-only web ports without a proxied domain", () => {
    const results = evaluatePlanPolicies(
      planJson({ webSources: ["0.0.0.0/0", "::/0"] }),
      deployPlan({ dns: false }),
    );
    expect(results.some((r) => r.policyId === "origin-cloudflare-only")).toBe(false);
    expect(failed(results)).toEqual([]);
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

  it("flags an unproxied app record", () => {
    expect(failed(evaluatePlanPolicies(planJson({ proxiedRecord: false }), deployPlan()))).toEqual([
      "dns-proxied",
    ]);
  });

  // The safety gate's exact results (ids, severities, messages, resources): any change to them
  // must show up here.
  it("reports every Hetzner check with its exact result when all pass and when all fail", () => {
    expect(evaluatePlanPolicies(planJson(), deployPlan())).toMatchSnapshot("all pass");
    const plan = deployPlan();
    const limited = {
      ...plan,
      security: { ...plan.security, sshAllowedCidrs: ["203.0.113.0/24"] },
    };
    const failing = evaluatePlanPolicies(
      planJson({
        firewallIds: "none",
        sshKeys: false,
        deleteProtection: false,
        backups: false,
        webSources: ["0.0.0.0/0", "::/0"],
        extraRules: [{ direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] }],
        proxiedRecord: false,
      }),
      limited,
    );
    expect(failing.every((r) => !r.passed)).toBe(true);
    expect(failing).toMatchSnapshot("all fail");
    // Without any firewall: compared as a set, its place in the list is not part of the gate.
    const bySubject = (a: PolicyResult, b: PolicyResult) =>
      `${a.policyId}|${a.resource ?? ""}`.localeCompare(`${b.policyId}|${b.resource ?? ""}`);
    const unprotected = evaluatePlanPolicies(
      planJson({ firewallIds: "none", withFirewall: false }),
      deployPlan(),
    );
    expect(unprotected.sort(bySubject)).toMatchSnapshot("no firewall");
  });
});

describe("evaluatePlanPolicies on a Portainer target", () => {
  const portainer = (redeploy: "updater" | "cloudflare") =>
    DeployPlanSchema.parse({
      ...deployPlan(),
      target: {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy,
        web: { mode: "tunnel" },
      },
    });

  /** `show -json` of a Portainer root: only Cloudflare Tunnels, their routes and Access. */
  function tunnelPlanJson() {
    const resource = (module: string, type: string, name: string, values = {}) => ({
      address: `module.${module}.${type}.${name}`,
      mode: "managed",
      type,
      name,
      values,
    });
    return {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.tunnel",
              resources: [
                resource("tunnel", "cloudflare_zero_trust_tunnel_cloudflared", "this", {
                  name: "opscrew-shop",
                }),
                resource("tunnel", "cloudflare_dns_record", "route", {
                  name: "shop.example.com",
                  type: "CNAME",
                  proxied: true,
                }),
              ],
            },
            {
              address: "module.access",
              resources: [
                resource("access", "cloudflare_zero_trust_access_application", "ssh", {
                  domain: "portainer-shop.example.com",
                }),
              ],
            },
          ],
        },
      },
      resource_changes: [],
    };
  }

  it("evaluates a Portainer root like any tunnel and Access root, without refusing it", () => {
    for (const mode of ["updater", "cloudflare"] as const) {
      const results = evaluatePlanPolicies(tunnelPlanJson(), portainer(mode));
      expect(blockingPolicyFailures(results)).toEqual([]);
      // No server, firewall or backups policy applies: there is no server.
      expect(results.map((r) => r.policyId)).not.toContain("firewall-attached");
      expect(results.map((r) => r.policyId)).not.toContain("backups-for-critical-data");
    }
  });

  it("still fails a plan that would create an unprotected server, whatever the target says", () => {
    const results = evaluatePlanPolicies(
      planJson({ withFirewall: false, firewallIds: "none" }),
      portainer("updater"),
    );
    expect(failed(results)).toContain("firewall-attached");
  });
});
