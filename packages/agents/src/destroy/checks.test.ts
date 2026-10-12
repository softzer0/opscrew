import type { ResourceChange } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { HOST_KEY, testPlan } from "../provision/__fixtures__/fakes";
import {
  deployedResources,
  SERVER_ADDRESS,
  serverAttributes,
  unprotectPlan,
} from "./__fixtures__/fakes";
import {
  dataWarning,
  deletesServer,
  destroyPlanProblems,
  removeHostKeys,
  unprotectPlanProblems,
} from "./checks";

const firewallCreate: ResourceChange = {
  address: "module.server.hcloud_firewall.this",
  type: "hcloud_firewall",
  name: "this",
  provider: "registry.opentofu.org/hetznercloud/hcloud",
  action: "create",
};

function serverPlan(before: Record<string, unknown>, after: Record<string, unknown>, unknown = {}) {
  return {
    resource_changes: [
      {
        address: SERVER_ADDRESS,
        change: { actions: ["update"], before, after, after_unknown: unknown },
      },
    ],
  };
}

describe("unprotectPlanProblems", () => {
  it("accepts a plan that only turns the server's protection off", () => {
    const { changes, planJson } = unprotectPlan();
    expect(unprotectPlanProblems(changes, planJson)).toEqual([]);
  });

  it("names other server attributes that would change, never their values", () => {
    const { changes, planJson } = unprotectPlan({ server_type: "cx53", labels: { app: "x" } });
    const problems = unprotectPlanProblems(changes, planJson);
    expect(problems).toEqual([`update ${SERVER_ADDRESS} (labels, server_type)`]);
    expect(problems.join("\n")).not.toContain("cx53");
  });

  it("counts a value only known after apply as a change, since it cannot be shown unchanged", () => {
    const { changes } = unprotectPlan();
    const before = serverAttributes({ status: "running" });
    const after = serverAttributes({ delete_protection: false, rebuild_protection: false });
    const planJson = serverPlan(before, after, { status: true });
    expect(unprotectPlanProblems(changes, planJson)).toEqual([
      "update module.server.hcloud_server.this (status)",
    ]);
  });

  it("ignores null-versus-missing values", () => {
    const { changes } = unprotectPlan();
    const before = serverAttributes({ placement_group_id: null });
    const after = serverAttributes({ delete_protection: false, rebuild_protection: false });
    expect(unprotectPlanProblems(changes, serverPlan(before, after))).toEqual([]);
  });

  it("compares nested values regardless of key order", () => {
    const { changes } = unprotectPlan();
    const before = serverAttributes({ labels: { app: "shop", "managed-by": "opscrew" } });
    const after = serverAttributes({
      delete_protection: false,
      rebuild_protection: false,
      labels: { "managed-by": "opscrew", app: "shop" },
    });
    expect(unprotectPlanProblems(changes, serverPlan(before, after))).toEqual([]);
  });

  it("refuses any change that is not an update of an hcloud_server", () => {
    const { changes, planJson } = unprotectPlan();
    const problems = unprotectPlanProblems(
      [...changes, firewallCreate, { ...changes[0], action: "replace" } as ResourceChange],
      planJson,
    );
    expect(problems).toEqual([
      "create module.server.hcloud_firewall.this",
      `replace ${SERVER_ADDRESS}`,
    ]);
  });

  it("fails closed when the plan JSON does not say what changes", () => {
    const { changes } = unprotectPlan();
    expect(unprotectPlanProblems(changes, { resource_changes: [] })).toEqual([
      `update ${SERVER_ADDRESS} (OpsCrew could not tell which settings change)`,
    ]);
    expect(unprotectPlanProblems(changes, "not json")).toHaveLength(1);
  });

  it("refuses a protection change that does not turn delete protection off", () => {
    const { changes } = unprotectPlan();
    const before = serverAttributes({ delete_protection: false, rebuild_protection: false });
    const after = serverAttributes({ delete_protection: true, rebuild_protection: true });
    expect(unprotectPlanProblems(changes, serverPlan(before, after))).toEqual([
      `update ${SERVER_ADDRESS} (does not turn delete protection off)`,
    ]);
  });
});

describe("destroyPlanProblems and deletesServer", () => {
  it("accepts deletes only and spots the server", () => {
    expect(destroyPlanProblems(deployedResources())).toEqual([]);
    expect(deletesServer(deployedResources())).toBe(true);
    expect(deletesServer(deployedResources({ server: false }))).toBe(false);
    expect(destroyPlanProblems([firewallCreate])).toEqual([
      "create module.server.hcloud_firewall.this",
    ]);
  });
});

describe("removeHostKeys", () => {
  it("removes the server's lines and keeps other hosts and comments", () => {
    const text = [
      "# OpsCrew known hosts",
      `198.51.100.7 ${HOST_KEY}`,
      `203.0.113.10 ${HOST_KEY}`,
      `[203.0.113.10]:22 ${HOST_KEY}`,
      `[203.0.113.10]:2222 ${HOST_KEY}`,
      `2001:DB8::1,203.0.113.99 ${HOST_KEY}`,
      `@cert-authority 203.0.113.10 ${HOST_KEY}`,
      "",
    ].join("\r\n");
    const result = removeHostKeys(text, ["203.0.113.10", "2001:db8::1"]);
    expect(result.removed).toBe(4);
    expect(result.text).toBe(
      [
        "# OpsCrew known hosts",
        `198.51.100.7 ${HOST_KEY}`,
        `[203.0.113.10]:2222 ${HOST_KEY}`,
        "",
      ].join("\n"),
    );
  });

  it("returns an empty file when only the server was pinned", () => {
    expect(removeHostKeys(`203.0.113.10 ${HOST_KEY}\n`, ["203.0.113.10"])).toEqual({
      text: "",
      removed: 1,
    });
  });
});

describe("dataWarning", () => {
  it("names the database and backups only when the server is deleted", () => {
    const plan = testPlan();
    expect(dataWarning(plan, true)).toBe(
      "Deleting the server also deletes the PostgreSQL database, any files the app stored on the server and Hetzner's automatic backups of the server. Only a snapshot keeps a copy.",
    );
    expect(dataWarning(plan, false)).toBeUndefined();
    const plain = { ...testPlan({ postgres: false }), target: { ...plan.target, backups: false } };
    expect(dataWarning(plain, true)).toBe(
      "Deleting the server also deletes any files the app stored on the server. Only a snapshot keeps a copy.",
    );
  });
});
