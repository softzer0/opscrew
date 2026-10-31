import type { ResourceChange } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { freshFacts, testKeyMaker, testPlan, withOtherApp } from "../testing";
import { dashboardsOnNetwork } from "./own";
import { deploySecretNames } from "./secrets";
import {
  extraServerOutputs,
  removalConfirmPhrase,
  removalNotes,
  removedCloudServers,
  requireDesignedPlacement,
  withPlacement,
} from "./servers";

/** `db` on the Hetzner server `data`, on the network, with a laptop and Portainer on. */
function split(options: { devices?: boolean } = {}): DeployPlan {
  const keys = testKeyMaker("servers");
  const base = { ...splitPlan(), portainer: { enabled: true, version: "2.45.2", access: "local" } };
  const { network } = allocateNetwork(base, {}, keys);
  const prefix = network.range.split(".").slice(0, 3).join(".");
  return withNetwork(base as Omit<DeployPlan, "network">, {
    ...network,
    devices: options.devices
      ? [
          {
            name: "laptop",
            address: `${prefix}.100`,
            publicKey: keys().publicKey,
            addedAt: "2026-10-30T10:00:00.000Z",
          },
        ]
      : [],
  });
}

const change = (address: string, action: ResourceChange["action"]): ResourceChange => ({
  address,
  type: address.split(".").at(-2) ?? "",
  name: "this",
  provider: "hcloud",
  action,
});

describe("removalConfirmPhrase", () => {
  const plan = testPlan();

  it("is the app's name for a plan that deletes no extra server", () => {
    expect(
      removalConfirmPhrase(plan, {
        changes: [change("module.server.hcloud_server.this", "replace")],
      }),
    ).toBe("shop");
  });

  it("is the removed server's name at its provider, with the app's name when more goes", () => {
    const removed = change("module.server_data.hcloud_server.this", "delete");
    expect(removalConfirmPhrase(plan, { changes: [removed] })).toBe("shop-data");
    expect(
      removalConfirmPhrase(plan, {
        changes: [removed, change("module.server.hcloud_server.this", "replace")],
      }),
    ).toBe("shop shop-data");
  });

  it("counts the deploy key and tag a provider's last extra server shares as part of its removal", () => {
    const shared = [
      change("module.server_cache.digitalocean_droplet.this", "delete"),
      change("digitalocean_ssh_key.deploy", "delete"),
      change("digitalocean_tag.app", "delete"),
    ];
    expect(removalConfirmPhrase(plan, { changes: shared })).toBe("shop-cache");
    // Without a server removed, deleting them is something else.
    expect(removalConfirmPhrase(plan, { changes: shared.slice(1) })).toBe("shop");
  });

  it("names nothing of a server the plan still lists", () => {
    const kept = split();
    const replaced = change("module.server_data.hcloud_server.this", "delete");
    expect(removalConfirmPhrase(kept, { changes: [replaced] })).toBe("shop");
    expect(removalNotes(kept, { changes: [replaced] })).toEqual([]);
  });
});

describe("extra servers in the state", () => {
  const outputs = {
    extra_servers: {
      data: { ipv4: "203.0.113.30", ipv6: "2001:db8::30", id: "1", name: "shop-data" },
      cache: { ipv4: "203.0.113.31", ipv6: "", id: "2", name: "shop-cache" },
    },
  };

  it("reads each server's addresses from the output", () => {
    expect(extraServerOutputs(outputs)).toEqual({
      data: { ipv4: "203.0.113.30", ipv6: "2001:db8::30" },
      cache: { ipv4: "203.0.113.31" },
    });
    expect(extraServerOutputs({ extra_servers: "nonsense" })).toEqual({});
  });

  it("finds the cloud servers the plan no longer lists", () => {
    expect(removedCloudServers(split(), outputs)).toEqual(["cache"]);
    expect(removedCloudServers(testPlan(), undefined)).toEqual([]);
  });
});

describe("withPlacement", () => {
  const deployed = (plan: DeployPlan, deployment: Record<string, unknown>) =>
    DeployPlanSchema.parse({
      ...plan,
      deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z", ...deployment },
    });
  const succeeded = { firstDeployAt: "2026-10-12T09:00:00.000Z" };

  it("records where each enabled service runs once the deployment exists", () => {
    expect(withPlacement(deployed(split(), {})).deployment.placement).toEqual({ db: "data" });
  });

  it("leaves the plan as it is before the deployment exists, during a move and without extra servers", () => {
    const before = split();
    expect(withPlacement(before)).toBe(before);
    const single = deployed(testPlan(), succeeded);
    expect(withPlacement(single)).toBe(single);
    const recorded = deployed(split(), { ...succeeded, placement: { db: "data" } });
    expect(withPlacement(recorded)).toBe(recorded);
    const moving = DeployPlanSchema.parse({
      ...deployed(split(), { ...succeeded, placement: { db: "app" } }),
      move: { service: "db", from: "app", to: "data", step: "started", copy: "dump" },
    });
    expect(withPlacement(moving)).toBe(moving);
  });
});

describe("requireDesignedPlacement", () => {
  const live = (placement: Record<string, string> | undefined, extra: object = {}) =>
    DeployPlanSchema.parse({
      ...split(),
      deployment: {
        lastApplyAt: "2026-10-12T08:00:00.000Z",
        ...(placement === undefined ? {} : { placement }),
      },
      ...extra,
    });

  it("lets a service stay where it runs, and anything go anywhere before the first deployment", () => {
    expect(() => requireDesignedPlacement(live({ db: "data" }), "opscrew provision")).not.toThrow();
    expect(() => requireDesignedPlacement(split(), "opscrew provision")).not.toThrow();
  });

  it("refuses a live service placed elsewhere without design's move, and lets the move through", () => {
    expect(() => requireDesignedPlacement(live({ db: "app" }), "opscrew provision")).toThrow(
      "opscrew/plan.yaml places db on server data, but it runs on the app's server",
    );
    // Without a placement on record, a deployed app's services run on the app's server.
    expect(() => requireDesignedPlacement(live(undefined), "opscrew provision")).toThrow(
      /places db on server data/,
    );
    const moving = live(
      { db: "app" },
      { move: { service: "db", from: "app", to: "data", step: "started", copy: "dump" } },
    );
    expect(() => requireDesignedPlacement(moving, "opscrew provision")).not.toThrow();
  });
});

describe("dashboardsOnNetwork", () => {
  it("puts the dashboards on the private address only with devices and the app alone on its server", () => {
    expect(dashboardsOnNetwork(split())).toBe(false);
    const plan = split({ devices: true });
    expect(dashboardsOnNetwork(plan)).toBe(true);
    expect(dashboardsOnNetwork(plan, freshFacts())).toBe(true);
    expect(dashboardsOnNetwork(plan, withOtherApp())).toBe(false);
  });
});

describe("the extra servers' deploy secrets", () => {
  it("are among the deploy secrets of the plan, which destroy deletes", () => {
    expect(deploySecretNames(split())).toEqual(
      expect.arrayContaining(["OPSCREW_SERVER_DATA_HOST", "OPSCREW_SERVER_DATA_KNOWN_HOSTS"]),
    );
    expect(deploySecretNames(testPlan()).filter((name) => name.includes("SERVER_"))).toEqual([]);
  });
});
