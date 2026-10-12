import type { ResourceChange } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { HOST_KEY, testPlan } from "../provision/__fixtures__/fakes";
import {
  DROPLET_ADDRESS,
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
  serverIdsInPlan,
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

  it("stays Hetzner-only: a Droplet update is never a protection lift", () => {
    // DigitalOcean has no delete protection, so destroy never builds this plan for a Droplet.
    const droplet: ResourceChange = {
      address: DROPLET_ADDRESS,
      type: "digitalocean_droplet",
      name: "this",
      provider: "registry.opentofu.org/digitalocean/digitalocean",
      action: "update",
    };
    expect(unprotectPlanProblems([droplet], { resource_changes: [] })).toEqual([
      `update ${DROPLET_ADDRESS}`,
    ]);
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
    expect(deletesServer(deployedResources(), "hetzner")).toBe(true);
    expect(deletesServer(deployedResources({ server: false }), "hetzner")).toBe(false);
    expect(destroyPlanProblems([firewallCreate])).toEqual([
      "create module.server.hcloud_firewall.this",
    ]);
  });

  it("spots the server by the provider's resource type", () => {
    const droplet = deployedResources({ provider: "digitalocean" });
    expect(destroyPlanProblems(droplet)).toEqual([]);
    expect(deletesServer(droplet, "digitalocean")).toBe(true);
    expect(deletesServer(droplet, "hetzner")).toBe(false);
    expect(deletesServer(deployedResources(), "digitalocean")).toBe(false);
    expect(
      deletesServer(deployedResources({ provider: "digitalocean", server: false }), "digitalocean"),
    ).toBe(false);
  });
});

describe("serverIdsInPlan", () => {
  const deleted = (type: string, before: unknown, actions = ["delete"]) => ({
    address: `module.server.${type}.this`,
    type,
    change: { actions, before, after: null },
  });

  it("reads the id of the server the destroy plan deletes, as a string", () => {
    const planJson = {
      resource_changes: [
        deleted("digitalocean_firewall", { id: "fw-1" }),
        deleted("digitalocean_droplet", { id: "3164444", name: "shop" }),
      ],
    };
    expect(serverIdsInPlan(planJson, "digitalocean")).toEqual(["3164444"]);
    expect(serverIdsInPlan(planJson, "hetzner")).toEqual([]);
    const numeric = { resource_changes: [deleted("hcloud_server", { id: 4711 })] };
    expect(serverIdsInPlan(numeric, "hetzner")).toEqual(["4711"]);
    const replaced = {
      resource_changes: [deleted("hcloud_server", { id: "4711" }, ["create", "delete"])],
    };
    expect(serverIdsInPlan(replaced, "hetzner")).toEqual(["4711"]);
  });

  it("returns nothing when the plan JSON does not say, and every id when there are several", () => {
    expect(serverIdsInPlan({ resource_changes: [] }, "hetzner")).toEqual([]);
    expect(serverIdsInPlan("not json", "hetzner")).toEqual([]);
    expect(
      serverIdsInPlan({ resource_changes: [deleted("hcloud_server", {})] }, "hetzner"),
    ).toEqual([]);
    expect(
      serverIdsInPlan({ resource_changes: [deleted("hcloud_server", { id: "" })] }, "hetzner"),
    ).toEqual([]);
    const updated = {
      resource_changes: [deleted("hcloud_server", { id: "4711" }, ["update"])],
    };
    expect(serverIdsInPlan(updated, "hetzner")).toEqual([]);
    const two = {
      resource_changes: [
        deleted("hcloud_server", { id: "4711" }),
        deleted("hcloud_server", { id: "4712" }),
        deleted("hcloud_server", { id: "4711" }),
      ],
    };
    expect(serverIdsInPlan(two, "hetzner")).toEqual(["4711", "4712"]);
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

  it("on DigitalOcean, says the database goes with the Droplet and the backups stay a while", () => {
    const base = testPlan();
    const plan = { ...base, target: { ...base.target, provider: "digitalocean" as const } };
    expect(dataWarning(plan, true)).toBe(
      "Deleting the Droplet also deletes the PostgreSQL database and any files the app stored on the Droplet. DigitalOcean keeps the Droplet's automatic backups until they expire, four weeks after they were taken; only a snapshot keeps a copy for longer.",
    );
    expect(dataWarning(plan, false)).toBeUndefined();
    const noBackups = { ...plan, target: { ...plan.target, backups: false } };
    expect(dataWarning(noBackups, true)).toBe(
      "Deleting the Droplet also deletes the PostgreSQL database and any files the app stored on the Droplet. Only a snapshot keeps a copy.",
    );
  });
});
