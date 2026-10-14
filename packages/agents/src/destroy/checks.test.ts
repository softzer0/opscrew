import type { ResourceChange } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { cloudTarget } from "../providers";
import { HOST_KEY, testPlan } from "../provision/__fixtures__/fakes";
import {
  DROPLET_ADDRESS,
  deployedResources,
  SERVER_ADDRESS,
  serverAttributes,
  unprotectPlan,
} from "./__fixtures__/fakes";
import {
  assertModulePrefix,
  dataWarning,
  deletesServer,
  deletesUnconfirmedServer,
  deletionPlanIsBounded,
  deletionPlanProblems,
  destroyPlanProblems,
  removeHostKeys,
  serverIdsInPlan,
  unprotectPlanProblems,
} from "./checks";

const HCLOUD_PROVIDER = "registry.opentofu.org/hetznercloud/hcloud";

/** A change at `address` (type and name from its last two parts). */
function at(address: string, action: ResourceChange["action"] = "delete"): ResourceChange {
  const parts = address.split(".");
  return {
    address,
    type: parts[parts.length - 2] as string,
    name: parts[parts.length - 1] as string,
    provider: HCLOUD_PROVIDER,
    action,
  };
}

/** The old server's resources during a move, renamed to `module.server_previous`. */
const PREVIOUS = [
  at("module.server_previous.hcloud_ssh_key.deploy"),
  at("module.server_previous.hcloud_firewall.this"),
  at("module.server_previous.hcloud_server.this"),
];

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
    const plan = {
      ...base,
      target: { ...cloudTarget(base.target), provider: "digitalocean" as const },
    };
    expect(dataWarning(plan, true)).toBe(
      "Deleting the Droplet also deletes the PostgreSQL database and any files the app stored on the Droplet. DigitalOcean keeps the Droplet's automatic backups until they expire, four weeks after they were taken; only a snapshot keeps a copy for longer.",
    );
    expect(dataWarning(plan, false)).toBeUndefined();
    const noBackups = { ...plan, target: { ...plan.target, backups: false } };
    expect(dataWarning(noBackups, true)).toBe(
      "Deleting the Droplet also deletes the PostgreSQL database and any files the app stored on the Droplet. Only a snapshot keeps a copy.",
    );
  });

  it("words the warning for an explicit target (the old server during a move), not plan.target", () => {
    const base = testPlan();
    const plan = {
      ...base,
      target: { ...cloudTarget(base.target), provider: "digitalocean" as const },
    };
    const old = { provider: "hetzner" as const, backups: false };
    expect(dataWarning(plan, true, old)).toBe(
      "Deleting the server also deletes the PostgreSQL database and any files the app stored on the server. Only a snapshot keeps a copy.",
    );
  });
});

describe("deletionPlanProblems (prefix-bounded deletions of a move)", () => {
  const prefix = "module.server_previous.";
  const confirmed = new Set(PREVIOUS.map((c) => c.address));

  it("accepts a plan that only deletes confirmed resources under the prefix", () => {
    const problems = deletionPlanProblems(PREVIOUS, { prefix, confirmed });
    expect(problems).toEqual({ notDeletes: [], outsidePrefix: [], unconfirmed: [] });
    expect(deletionPlanIsBounded(problems)).toBe(true);
    // before the confirmation (the preview) only the prefix and the action are checked
    expect(deletionPlanIsBounded(deletionPlanProblems(PREVIOUS, { prefix }))).toBe(true);
  });

  it("refuses anything that is not a delete, even under the prefix", () => {
    const changes = [
      ...PREVIOUS.slice(0, 2),
      at("module.server_previous.hcloud_server.this", "update"),
      at("module.server_previous.hcloud_firewall.extra", "create"),
      at("module.server_previous.hcloud_server.other", "replace"),
    ];
    const problems = deletionPlanProblems(changes, { prefix });
    expect(problems.notDeletes).toEqual([
      "update module.server_previous.hcloud_server.this",
      "create module.server_previous.hcloud_firewall.extra",
      "replace module.server_previous.hcloud_server.other",
    ]);
    expect(problems.outsidePrefix).toEqual([]);
    expect(deletionPlanIsBounded(problems)).toBe(false);
  });

  it("refuses deletes outside the prefix: the new server, DNS, a look-alike module", () => {
    const changes = [
      ...PREVIOUS,
      at("module.server.hcloud_server.this"),
      at("module.dns.cloudflare_dns_record.a"),
      at("module.server_previous_x.hcloud_server.this"),
      at("hcloud_server.loose", "update"),
    ];
    const problems = deletionPlanProblems(changes, { prefix, confirmed });
    expect(problems.outsidePrefix).toEqual([
      "delete module.server.hcloud_server.this",
      "delete module.dns.cloudflare_dns_record.a",
      "delete module.server_previous_x.hcloud_server.this",
      "update hcloud_server.loose",
    ]);
    expect(problems.unconfirmed).toEqual([]);
    expect(deletionPlanIsBounded(problems)).toBe(false);
  });

  it("refuses deletes under the prefix that were not in the confirmed preview", () => {
    const volume = at("module.server_previous.hcloud_volume.data");
    expect(deletionPlanProblems([...PREVIOUS, volume], { prefix, confirmed })).toEqual({
      notDeletes: [],
      outsidePrefix: [],
      unconfirmed: ["module.server_previous.hcloud_volume.data"],
    });
  });

  it("bounds an abort to module.server. and leaves module.server_previous alone", () => {
    const fresh = deployedResources();
    const abort = deletionPlanProblems([...fresh, PREVIOUS[2] as ResourceChange], {
      prefix: "module.server.",
    });
    expect(abort.outsidePrefix).toEqual(["delete module.server_previous.hcloud_server.this"]);
    expect(deletionPlanIsBounded(deletionPlanProblems(fresh, { prefix: "module.server." }))).toBe(
      true,
    );
  });

  it("without a prefix checks the whole root (opscrew destroy)", () => {
    const all = deployedResources({ dns: true });
    const confirmedAll = new Set(all.map((c) => c.address));
    expect(deletionPlanIsBounded(deletionPlanProblems(all, { confirmed: confirmedAll }))).toBe(
      true,
    );
    expect(deletionPlanProblems([firewallCreate]).notDeletes).toEqual([
      "create module.server.hcloud_firewall.this",
    ]);
  });
});

describe("module address prefixes", () => {
  const invalid = ["module.server", "", "module.", "module.server.x.", "server.", "module.a b."];

  it("accepts exactly one module with its trailing dot", () => {
    expect(() => assertModulePrefix("module.server.")).not.toThrow();
    expect(() => assertModulePrefix("module.server_previous.")).not.toThrow();
    for (const prefix of invalid) {
      expect(() => assertModulePrefix(prefix)).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
    }
  });

  it("refuses an invalid prefix in every bounded check, even with no changes", () => {
    const { changes, planJson } = unprotectPlan();
    for (const prefix of ["module.server", ""]) {
      expect(() => deletionPlanProblems(PREVIOUS, { prefix })).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
      expect(() => deletionPlanProblems([], { prefix })).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
      expect(() => unprotectPlanProblems(changes, planJson, { prefix })).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
      expect(() => unprotectPlanProblems([], {}, { prefix })).toThrow(
        expect.objectContaining({ code: "INTERNAL" }),
      );
    }
  });

  it("module.server. and module.server_previous. never match each other", () => {
    const current = [at("module.server.hcloud_server.x")];
    const previous = [at("module.server_previous.x")];
    expect(deletionPlanProblems(previous, { prefix: "module.server." }).outsidePrefix).toEqual([
      "delete module.server_previous.x",
    ]);
    expect(
      deletionPlanProblems(current, { prefix: "module.server_previous." }).outsidePrefix,
    ).toEqual(["delete module.server.hcloud_server.x"]);
    expect(deletionPlanIsBounded(deletionPlanProblems(current, { prefix: "module.server." }))).toBe(
      true,
    );
  });
});

describe("deletesUnconfirmedServer", () => {
  const plan = (id: string | undefined) => ({
    changes: PREVIOUS,
    planJson: {
      resource_changes: [
        {
          address: "module.server_previous.hcloud_server.this",
          type: "hcloud_server",
          change: { actions: ["delete"], before: id === undefined ? {} : { id }, after: null },
        },
      ],
    },
  });

  it("accepts the confirmed server, whatever module it lives in", () => {
    expect(serverIdsInPlan(plan("4711").planJson, "hetzner")).toEqual(["4711"]);
    expect(deletesUnconfirmedServer(plan("4711"), "hetzner", ["4711"])).toBe(false);
  });

  it("refuses another server, or one the plan no longer names", () => {
    expect(deletesUnconfirmedServer(plan("4712"), "hetzner", ["4711"])).toBe(true);
    expect(deletesUnconfirmedServer(plan(undefined), "hetzner", ["4711"])).toBe(true);
  });

  it("has nothing to compare when the preview named no id or no server is deleted", () => {
    expect(deletesUnconfirmedServer(plan("4712"), "hetzner", [])).toBe(false);
    expect(deletesUnconfirmedServer({ changes: PREVIOUS.slice(0, 2) }, "hetzner", ["4711"])).toBe(
      false,
    );
  });
});

describe("unprotectPlanProblems with a prefix (previous_delete_protection)", () => {
  /** The protection-lifting plan with the server at `address`. */
  const movedTo = (address: string) => {
    const { changes, planJson } = unprotectPlan();
    return {
      changes: changes.map((c) => ({ ...c, address })),
      planJson: {
        ...planJson,
        resource_changes: planJson.resource_changes.map((rc) => ({ ...rc, address })),
      },
    };
  };

  it("accepts lifting the old server's protection under the prefix", () => {
    const { changes, planJson } = movedTo("module.server_previous.hcloud_server.this");
    expect(unprotectPlanProblems(changes, planJson, { prefix: "module.server_previous." })).toEqual(
      [],
    );
  });

  it("refuses a protection change of a server outside the prefix", () => {
    const { changes, planJson } = movedTo(SERVER_ADDRESS);
    expect(unprotectPlanProblems(changes, planJson, { prefix: "module.server_previous." })).toEqual(
      [`update ${SERVER_ADDRESS}`],
    );
    // without a prefix (opscrew destroy) the same plan is fine
    expect(unprotectPlanProblems(changes, planJson)).toEqual([]);
  });
});
