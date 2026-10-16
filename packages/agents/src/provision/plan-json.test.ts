import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeEngine, planJsonFor, testPlan } from "../testing";
import { planAndApply } from "./plan-apply";
import { maskBySensitivity, maskSensitivePlanJson, SENSITIVE_VALUE } from "./plan-json";

const SECRET = fakeSecret("cloudflare-token", "plan-json");
const PASSWORD = fakeSecret("generic-password", "plan-json");

/** A `show -json` plan with the same secret in every place a plan can hold one. */
function secretPlanJson() {
  const base = planJsonFor();
  return {
    ...base,
    planned_values: {
      outputs: {
        tunnel_token: { sensitive: true, value: SECRET },
        url: { sensitive: false, value: "https://shop.example.com" },
      },
      root_module: {
        ...base.planned_values.root_module,
        child_modules: [
          ...base.planned_values.root_module.child_modules,
          {
            address: "module.access",
            resources: [
              {
                address: "module.access.cloudflare_zero_trust_access_service_token.ssh[0]",
                mode: "managed",
                type: "cloudflare_zero_trust_access_service_token",
                name: "ssh",
                values: {
                  name: "OpsCrew deploy (shop)",
                  client_secret: SECRET,
                  tags: ["a", PASSWORD],
                },
                sensitive_values: { client_secret: true, tags: [false, true] },
              },
            ],
          },
        ],
      },
    },
    resource_changes: [
      ...base.resource_changes,
      {
        address: "module.access.cloudflare_zero_trust_access_service_token.ssh[0]",
        change: {
          actions: ["update"],
          before: { name: "old", client_secret: SECRET, nested: { password: PASSWORD } },
          after: {
            name: "OpsCrew deploy (shop)",
            client_secret: SECRET,
            nested: { password: PASSWORD },
          },
          before_sensitive: { client_secret: true, nested: { password: true } },
          after_sensitive: { client_secret: true, nested: { password: true } },
          after_unknown: {},
        },
      },
    ],
    resource_drift: [
      {
        address: "module.tunnel.data.cloudflare_zero_trust_tunnel_cloudflared_token.this",
        change: {
          actions: ["update"],
          before: { token: SECRET },
          after: { token: SECRET },
          before_sensitive: { token: true },
          after_sensitive: { token: true },
        },
      },
    ],
    output_changes: {
      tunnel_token: {
        actions: ["update"],
        before: SECRET,
        after: SECRET,
        before_sensitive: true,
        after_sensitive: true,
      },
    },
    variables: { db_password: { value: PASSWORD }, app_name: { value: "shop" } },
    configuration: {
      root_module: {
        variables: {
          db_password: { sensitive: true, default: PASSWORD },
          app_name: { description: "App name" },
        },
      },
    },
    prior_state: {
      values: {
        outputs: { tunnel_token: { sensitive: true, value: SECRET } },
        root_module: { resources: [{ values: { client_secret: SECRET } }] },
      },
    },
  };
}

describe("maskSensitivePlanJson", () => {
  it("drops the prior state and masks every sensitive value, keeping the rest", () => {
    const masked = maskSensitivePlanJson(secretPlanJson()) as Record<string, unknown>;
    const text = JSON.stringify(masked);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASSWORD);
    expect(masked).not.toHaveProperty("prior_state");
    expect(text).toContain(SENSITIVE_VALUE);
    // Non-sensitive values stay for policies and summaries.
    expect(text).toContain("https://shop.example.com");
    expect(text).toContain("OpsCrew deploy (shop)");
    expect(text).toContain("hcloud_firewall");
    expect(maskSensitivePlanJson(masked)).toEqual(masked);
  });

  it("follows nested sensitivity marks", () => {
    expect(maskBySensitivity({ a: 1, b: [1, { c: 2 }] }, { b: [false, { c: true }] })).toEqual({
      a: 1,
      b: [1, { c: SENSITIVE_VALUE }],
    });
    expect(maskBySensitivity(null, true)).toBeNull();
  });

  it("is what the --plan-only sidecar and the policies see", async () => {
    const deps = await createTestPhaseDeps();
    const engine = new FakeEngine({ planJson: secretPlanJson() });
    const result = await planAndApply(deps, {
      engine,
      dir: join(deps.paths.root, "opscrew/infra/prod"),
      env: {},
      deployPlan: testPlan(),
      files: [],
      planOnly: true,
    });
    const sidecars = (await readdir(deps.paths.files.plansDir)).filter((f) =>
      f.endsWith(".tfplan.json"),
    );
    expect(sidecars).toHaveLength(1);
    const text = await readFile(join(deps.paths.files.plansDir, sidecars[0] as string), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("prior_state");
    expect(text).toContain(SENSITIVE_VALUE);
    expect(JSON.stringify(result.plan?.planJson)).not.toContain(SECRET);
    // Policies still run on the (non-sensitive) firewall rules.
    expect(result.plan?.policy.some((p) => p.policyId === "firewall-attached")).toBe(true);
    expect(`${deps.reporter.text()}`).not.toContain(SECRET);
  });
});

describe("a Cloudflare Tunnel's connections", () => {
  // A documentation address (RFC 5737): the public address of a host running the connector.
  const ORIGIN_IP = "198.51.100.23";
  const TUNNEL = "cloudflare_zero_trust_tunnel_cloudflared";
  const tunnel = (connections: unknown) => ({
    name: "opscrew-shop",
    connections,
    status: "healthy",
  });
  const connected = [{ colo_name: "fra08", origin_ip: ORIGIN_IP, client_version: "2026.9.0" }];

  it("are always masked, before and after, in resource changes, drift and planned values", () => {
    const plan = {
      format_version: "1.2",
      resource_changes: [
        {
          address: `module.tunnel.${TUNNEL}.this`,
          type: TUNNEL,
          change: {
            actions: ["update"],
            before: tunnel(connected),
            after: tunnel(connected),
            before_sensitive: { connections: [{}] },
            after_sensitive: {},
          },
        },
      ],
      resource_drift: [
        {
          address: `module.tunnel.${TUNNEL}.this`,
          type: TUNNEL,
          change: { before: tunnel([]), after: tunnel(connected) },
        },
      ],
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.tunnel",
              resources: [
                {
                  address: `module.tunnel.${TUNNEL}.this`,
                  type: TUNNEL,
                  values: tunnel(connected),
                },
              ],
            },
          ],
        },
      },
    };
    const masked = maskSensitivePlanJson(plan) as typeof plan;
    expect(JSON.stringify(masked)).not.toContain(ORIGIN_IP);
    const change = masked.resource_changes[0]?.change;
    expect(change?.before).toEqual(tunnel(SENSITIVE_VALUE));
    expect(change?.after).toEqual(tunnel(SENSITIVE_VALUE));
    expect(masked.resource_drift[0]?.change.before).toEqual(tunnel(SENSITIVE_VALUE));
    expect(masked.resource_drift[0]?.change.after).toEqual(tunnel(SENSITIVE_VALUE));
    expect(masked.planned_values.root_module.child_modules[0]?.resources[0]?.values).toEqual(
      tunnel(SENSITIVE_VALUE),
    );
    // Idempotent; other resource types keep an attribute of that name.
    expect(maskSensitivePlanJson(masked)).toEqual(masked);
    const other = {
      resource_changes: [
        { type: "cloudflare_dns_record", change: { after: { connections: "x" } } },
      ],
    };
    expect(maskSensitivePlanJson(other)).toEqual(other);
  });

  it("stay null where a tunnel is created or deleted", () => {
    const plan = {
      resource_changes: [
        { type: TUNNEL, change: { actions: ["delete"], before: tunnel(connected), after: null } },
        { type: TUNNEL, change: { actions: ["create"], before: null, after: tunnel(null) } },
      ],
    };
    const masked = maskSensitivePlanJson(plan) as typeof plan;
    expect(masked.resource_changes[0]?.change).toMatchObject({
      before: tunnel(SENSITIVE_VALUE),
      after: null,
    });
    expect(masked.resource_changes[1]?.change.after).toEqual(tunnel(null));
  });
});
