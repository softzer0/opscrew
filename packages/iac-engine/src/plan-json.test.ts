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
