import { describe, expect, it } from "vitest";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps } from "../testing";
import { splitPlan } from "./__fixtures__/plans";
import { hasPublicAddress, publicEndpoints } from "./endpoints";

const APP_IP = "203.0.113.10";
const DATA_IP = "203.0.113.20";
const OWN = { host: "box.example.com", port: 22, user: "root", agent: true };

async function depsWith(record: { own?: typeof OWN & { publicIpv4?: string }; data?: boolean }) {
  const deps = await createTestPhaseDeps();
  await updateServerAddresses(deps.paths, () => ({
    schemaVersion: 1,
    deployment: { ipv4: APP_IP },
    ...(record.data === false ? {} : { servers: { data: { ipv4: DATA_IP } } }),
    ...(record.own !== undefined ? { own: record.own } : {}),
  }));
  return deps;
}

describe("publicEndpoints", () => {
  it("lists each server's public address from this computer's server record", async () => {
    const plan = splitPlan();
    expect(await publicEndpoints(await depsWith({}), plan)).toEqual({
      app: APP_IP,
      data: DATA_IP,
    });
  });

  it("takes the public address of the user's own server, else the address OpsCrew logs in at", async () => {
    const plan = splitPlan({ app: "own" });
    const named = await depsWith({ own: { ...OWN, publicIpv4: "203.0.113.30" } });
    expect(await publicEndpoints(named, plan)).toEqual({
      app: "203.0.113.30",
      data: DATA_IP,
    });
    expect(await publicEndpoints(await depsWith({ own: OWN }), plan)).toEqual({
      app: "box.example.com",
      data: DATA_IP,
    });
  });

  it("leaves out the user's own server behind a Cloudflare Tunnel", async () => {
    const plan = splitPlan({ app: "own-tunnel" });
    expect(hasPublicAddress(plan, "app")).toBe(false);
    expect(hasPublicAddress(plan, "data")).toBe(true);
    expect(await publicEndpoints(await depsWith({ own: OWN }), plan)).toEqual({
      data: DATA_IP,
    });
  });

  it("says plainly when a server's address is not on this computer", async () => {
    await expect(
      publicEndpoints(await depsWith({ data: false }), splitPlan()),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew does not know the public address of server data on this computer, so it cannot link the app's servers.",
    });
  });
});
