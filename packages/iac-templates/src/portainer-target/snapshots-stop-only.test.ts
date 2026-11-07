// A Portainer plan whose releases take snapshots (`snapshotsOn`) but whose only data is a
// stop-only service: Portainer stops no service (D3), so its stack takes none.
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { portainerTestPlan } from "./__fixtures__/plans";
import { portainerSnapshotParts, portainerStackVolumes, renderPortainerStack } from "./index";

// What `snapshotsOn` answers for such a plan once a stop-only service in `deploy.snapshotStop`
// counts (T2417); main's still needs a database.
vi.mock("@opscrew/plan-schema", async (original) => ({
  ...(await original<typeof import("@opscrew/plan-schema")>()),
  snapshotsOn: () => true,
}));

const base = portainerTestPlan({ releaseCommand: "npm run migrate" });
const plan = DeployPlanSchema.parse({
  ...base,
  services: [
    {
      name: "mq",
      kind: "rabbitmq",
      version: "4.3",
      memoryMb: 512,
      enabled: true,
      options: {},
      reason: "Events.",
      licence: "MPL-2.0",
    },
  ],
});

describe("snapshots before each release with only a stop-only service", () => {
  it("renders no snapshot service and no snapshots volume", () => {
    expect(portainerSnapshotParts(plan)).toEqual([]);
    const stack = parse(renderPortainerStack(plan, testContext()).content) as {
      services: Record<string, { depends_on?: Record<string, unknown>; volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(stack.services).filter((name) => name.startsWith("snapshot"))).toEqual([]);
    expect(stack.services.release?.depends_on).not.toHaveProperty("snapshot");
    expect(stack.services.stamp?.volumes).toEqual(["version:/version"]);
    expect(stack.volumes).not.toHaveProperty("snapshots");
    expect(portainerStackVolumes(plan).some((volume) => volume.includes("snapshot"))).toBe(false);
  });
});
