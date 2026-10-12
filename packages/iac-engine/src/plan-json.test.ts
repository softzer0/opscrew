import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fixture } from "./__fixtures__/fake-runner";
import { parsePlanJson } from "./plan-json";

describe("parsePlanJson", () => {
  it("summarises creates and skips reads", () => {
    const parsed = parsePlanJson(fixture("show-create.json"));
    expect(parsed.counts).toEqual({ create: 2, update: 0, delete: 0, replace: 0 });
    expect(parsed.hasDestroy).toBe(false);
    expect(parsed.changes[1]).toEqual({
      address: "module.server.hcloud_server.app",
      type: "hcloud_server",
      name: "app",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "create",
    });
  });

  it("maps update, delete, both replace orders, and skips no-op and read", () => {
    const parsed = parsePlanJson(JSON.parse(fixture("show-mixed.json")));
    expect(parsed.changes.map((c) => [c.address, c.action])).toEqual([
      ["hcloud_firewall.web", "update"],
      ["hcloud_ssh_key.old", "delete"],
      ["hcloud_server.app", "replace"],
      ["hcloud_primary_ip.v4", "replace"],
      ["hcloud_volume.data", "create"],
    ]);
    expect(parsed.counts).toEqual({ create: 1, update: 1, delete: 1, replace: 2 });
    expect(parsed.hasDestroy).toBe(true);
  });

  it("reports nothing for a no-op plan and for a plan without resource_changes", () => {
    expect(parsePlanJson(fixture("show-noop.json"))).toEqual({
      changes: [],
      counts: { create: 0, update: 0, delete: 0, replace: 0 },
      hasDestroy: false,
    });
    expect(parsePlanJson({ format_version: "1.2" }).changes).toEqual([]);
  });

  it("treats forget as a delete so it needs allowDestroy", () => {
    const plan = {
      resource_changes: [
        {
          address: "a.b",
          type: "a",
          name: "b",
          provider_name: "p",
          change: { actions: ["forget"] },
        },
      ],
    };
    expect(parsePlanJson(plan)).toMatchObject({ hasDestroy: true, counts: { delete: 1 } });
  });

  it("rejects malformed input and unknown actions with ENGINE_FAILED", () => {
    expect(() => parsePlanJson("not json")).toThrow(
      expect.objectContaining({ code: "ENGINE_FAILED" }),
    );
    expect(() => parsePlanJson([])).toThrow(expect.objectContaining({ code: "ENGINE_FAILED" }));
    expect(() => parsePlanJson({ resource_changes: [{ address: "x" }] })).toThrow(
      expect.objectContaining({ code: "ENGINE_FAILED" }),
    );
    expect(() =>
      parsePlanJson({
        resource_changes: [
          { address: "a.b", type: "a", name: "b", change: { actions: ["explode"] } },
        ],
      }),
    ).toThrow(/unknown resource action "explode"/);
  });
});

describe("parsePlanJson drift", () => {
  it("maps OpenTofu refresh-only drift: nested changes by top-level key, deletes, managed only", () => {
    const parsed = parsePlanJson(fixture("show-drift-tofu.json"));
    expect(parsed.changes).toEqual([]);
    expect(parsed.hasDestroy).toBe(false);
    expect(parsed.drift).toEqual([
      {
        address: "hcloud_firewall.web",
        type: "hcloud_firewall",
        name: "web",
        provider: "registry.opentofu.org/hetznercloud/hcloud",
        action: "update",
        // `labels` only changed key order, so it is not reported.
        attributes: ["rule"],
      },
      {
        address: "local_file.note",
        type: "local_file",
        name: "note",
        provider: "registry.opentofu.org/hashicorp/local",
        action: "delete",
        attributes: [],
      },
    ]);
  });

  it("maps Terraform drift next to planned changes and never copies values", () => {
    const text = fixture("show-drift-terraform.json");
    const parsed = parsePlanJson(text);
    expect(parsed.changes.map((c) => [c.address, c.action])).toEqual([
      ["module.server.hcloud_server.app", "update"],
    ]);
    expect(parsed.drift).toEqual([
      {
        address: "module.server.hcloud_server.app",
        type: "hcloud_server",
        name: "app",
        provider: "registry.terraform.io/hetznercloud/hcloud",
        action: "update",
        attributes: ["delete_protection", "labels", "user_data"],
      },
      {
        address: "hcloud_ssh_key.deploy",
        type: "hcloud_ssh_key",
        name: "deploy",
        provider: "registry.terraform.io/hetznercloud/hcloud",
        action: "delete",
        attributes: [],
      },
    ]);
    const out = JSON.stringify(parsed);
    for (const value of [
      "sensitive-before-marker",
      "sensitive-after-marker",
      "someone-else",
      "public-key-marker",
      "7654321",
    ]) {
      expect(text).toContain(value);
      expect(out).not.toContain(value);
    }
  });

  it("never copies a secret-shaped sensitive value", () => {
    const before = fakeSecret("hcloud-token", "before");
    const after = fakeSecret("hcloud-token", "after");
    const plan = {
      resource_drift: [
        {
          address: "terraform_data.token",
          mode: "managed",
          type: "terraform_data",
          name: "token",
          provider_name: "terraform.io/builtin/terraform",
          change: {
            actions: ["update"],
            before: { id: "x", input: { token: before } },
            after: { id: "x", input: { token: after } },
            before_sensitive: { input: { token: true } },
            after_sensitive: { input: { token: true } },
          },
        },
      ],
    };
    const parsed = parsePlanJson(plan);
    expect(parsed.drift).toEqual([expect.objectContaining({ attributes: ["input"] })]);
    const out = JSON.stringify(parsed);
    expect(out).not.toContain(before);
    expect(out).not.toContain(after);
  });

  it("reports no drift for clean refresh-only and normal plans", () => {
    expect(parsePlanJson(fixture("show-refresh-clean.json"))).toEqual({
      changes: [],
      counts: { create: 0, update: 0, delete: 0, replace: 0 },
      hasDestroy: false,
    });
    expect(parsePlanJson(fixture("show-noop.json"))).not.toHaveProperty("drift");
    expect(parsePlanJson({ resource_drift: [] })).not.toHaveProperty("drift");
  });

  it("skips no-op entries, treats other actions as update and rejects malformed drift", () => {
    const entry = (actions: string[]) => ({
      address: "a.b",
      mode: "managed",
      type: "a",
      name: "b",
      provider_name: "p",
      change: { actions, before: { x: 1 }, after: { x: 1, y: 2 } },
    });
    expect(parsePlanJson({ resource_drift: [entry(["no-op"])] })).not.toHaveProperty("drift");
    expect(parsePlanJson({ resource_drift: [entry(["delete", "create"])] }).drift).toEqual([
      { address: "a.b", type: "a", name: "b", provider: "p", action: "update", attributes: ["y"] },
    ]);
    expect(() => parsePlanJson({ resource_drift: {} })).toThrow(
      expect.objectContaining({ code: "ENGINE_FAILED" }),
    );
    expect(() => parsePlanJson({ resource_drift: [{ address: "a.b", mode: "managed" }] })).toThrow(
      expect.objectContaining({ code: "ENGINE_FAILED" }),
    );
  });
});
