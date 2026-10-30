import { describe, expect, it } from "vitest";
import { testKeyMaker } from "../testing";
import { splitPlan, withNetwork } from "./__fixtures__/plans";
import { allocateNetwork } from "./allocate";
import { serverNetworkInputs } from "./inputs";

/** The split app with a laptop granted Postgres and Portainer on, on the app's own server. */
function plan() {
  const keys = testKeyMaker();
  const base = {
    ...splitPlan(),
    portainer: { enabled: true, version: "2.33.1", access: "local" as const },
  };
  const network = allocateNetwork(base, {}, keys).network;
  const prefix = network.range.split(".").slice(0, 3).join(".");
  return withNetwork(base, {
    ...network,
    devices: [
      {
        name: "laptop",
        address: `${prefix}.100`,
        publicKey: keys().publicKey,
        addedAt: "2026-10-30T10:00:00.000Z",
      },
    ],
    grants: [{ device: "laptop", service: "db", access: "read-only" }],
  });
}

describe("serverNetworkInputs", () => {
  it("publishes the dashboards on the app's server for the devices only where it hosts the app alone", () => {
    const alone = serverNetworkInputs(plan(), "app", true);
    expect(alone.dashboardsOnNetwork).toBe(true);
    expect(alone.published.some((entry) => entry.dashboard === true)).toBe(true);
    // The dashboards' ports are not the services' local ports.
    expect(alone.localPorts).toEqual([]);
    const shared = serverNetworkInputs(plan(), "app", false);
    expect(shared.dashboardsOnNetwork).toBe(false);
    expect(shared.published).toEqual([]);
  });

  it("gives an extra server its services' ports, never dashboards", () => {
    const data = serverNetworkInputs(plan(), "data", true);
    expect(data.dashboardsOnNetwork).toBe(false);
    expect(data.published.map((entry) => [entry.service, entry.port])).toEqual([["db", 5432]]);
    expect(data.localPorts).toEqual([5432]);
  });
});
