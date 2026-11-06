import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, LAN_IPV4, OWN_IPV4 } from "../testing";
import {
  type OwnServerConnectionInput,
  type PortainerConnectionInput,
  readOldOwnServer,
  readServerAddresses,
  recordOwnServer,
  recordPortainerConnection,
  restoreOldConnection,
  setAsideOldConnection,
  updateServerAddresses,
} from "./server-record";

const OLD_OWN: OwnServerConnectionInput = {
  host: OWN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
};
const NEW_OWN: OwnServerConnectionInput = {
  host: LAN_IPV4,
  port: 2222,
  user: "admin",
  agent: true,
  reachable: true,
};
const PORTAINER: PortainerConnectionInput = {
  url: "https://portainer.example.com:9443",
  environmentId: 2,
  environmentName: "home",
  created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }], volumes: ["shop_db_data"] },
};
const OLD_ADDRESS = { ipv4: "198.51.100.10" };

async function paths() {
  return (await createTestPhaseDeps()).paths;
}

describe("a move's connections in server.json", () => {
  it("sets the old own server's login aside at the start, so `own` can take the new one", async () => {
    const p = await paths();
    await recordOwnServer(p, OLD_OWN);
    await updateServerAddresses(p, (current) => ({ ...current, retarget: { from: OLD_ADDRESS } }));

    await setAsideOldConnection(p, "own");
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.retarget).toEqual({ from: OLD_ADDRESS, fromOwn: { ...OLD_OWN } });
    expect(await readOldOwnServer(p)).toEqual(OLD_OWN);

    // The new side's login goes to the usual slot; a second set-aside changes nothing.
    await recordOwnServer(p, NEW_OWN);
    await setAsideOldConnection(p, "own");
    expect((await readServerAddresses(p)).own).toEqual(NEW_OWN);
    expect(await readOldOwnServer(p)).toEqual(OLD_OWN);
  });

  it("sets the old Portainer connection aside with what OpsCrew created there", async () => {
    const p = await paths();
    await recordPortainerConnection(p, PORTAINER);
    await setAsideOldConnection(p, "portainer");
    const record = await readServerAddresses(p);
    expect(record.portainer).toBeUndefined();
    expect(record.retarget?.fromPortainer?.created.stacks).toEqual(PORTAINER.created?.stacks);
  });

  it.each([
    ["own", "the server your app is moving from"],
    ["portainer", "the Portainer your app is moving from"],
  ] as const)(
    "stops when the old %s connection is not on this computer, changing nothing",
    async (from, what) => {
      const p = await paths();
      await updateServerAddresses(p, (current) => ({
        ...current,
        retarget: { from: OLD_ADDRESS },
      }));
      const before = await readServerAddresses(p);
      const error = await setAsideOldConnection(p, from).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(what),
      });
      expect((error as Error).message).toMatch(/Nothing was changed\.$/);
      expect(await readServerAddresses(p)).toEqual(before);
    },
  );

  it("sets nothing aside for a cloud server, whose address the move records itself", async () => {
    const p = await paths();
    await recordOwnServer(p, NEW_OWN);
    await setAsideOldConnection(p, "hetzner");
    const record = await readServerAddresses(p);
    expect(record.own).toEqual(NEW_OWN);
    expect(record.retarget).toBeUndefined();
  });

  it("puts the old login back on abort and forgets the new side's", async () => {
    const p = await paths();
    await recordOwnServer(p, OLD_OWN);
    await setAsideOldConnection(p, "own");
    await recordOwnServer(p, NEW_OWN);

    await restoreOldConnection(p, { from: "own", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toEqual(OLD_OWN);
    expect(record.retarget?.fromOwn).toBeUndefined();

    // Again (an interrupted abort): the restored login stays.
    await restoreOldConnection(p, { from: "own", to: "own" });
    expect((await readServerAddresses(p)).own).toEqual(OLD_OWN);
  });

  it("forgets the new own server's login when the move came from a cloud server", async () => {
    const p = await paths();
    await setAsideOldConnection(p, "digitalocean");
    await recordOwnServer(p, NEW_OWN);
    await updateServerAddresses(p, (current) => ({ ...current, retarget: { from: OLD_ADDRESS } }));
    await restoreOldConnection(p, { from: "digitalocean", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.retarget).toEqual({ from: OLD_ADDRESS });
  });

  it("puts the old Portainer back in place of a new own server", async () => {
    const p = await paths();
    await recordPortainerConnection(p, PORTAINER);
    await setAsideOldConnection(p, "portainer");
    await recordOwnServer(p, NEW_OWN);
    await restoreOldConnection(p, { from: "portainer", to: "own" });
    const record = await readServerAddresses(p);
    expect(record.own).toBeUndefined();
    expect(record.portainer?.environmentId).toBe(2);
    expect(record.retarget?.fromPortainer).toBeUndefined();
  });
});
