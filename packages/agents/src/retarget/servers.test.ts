import { describe, expect, it } from "vitest";
import { readServerAddresses, recordOwnServer, setAsideOldConnection } from "../shared";
import { createTestPhaseDeps, OWN_IPV4 } from "../testing";
import { assertDistinctServers, recordMoveServers, sameAddress } from "./servers";

describe("the move's two servers", () => {
  it("share an address when their IPv6 addresses are the same written differently", () => {
    const from = { ipv4: "203.0.113.10", ipv6: "2001:db8:0:0::1" };
    const next = { ipv4: "198.51.100.7", ipv6: "2001:DB8::1" };
    expect(sameAddress(from, next)).toBe(true);
    expect(() => assertDistinctServers({ from, next }, "opscrew retarget")).toThrow(
      expect.objectContaining({ code: "PHASE_PRECONDITION" }),
    );
    expect(sameAddress(from, { ipv4: "198.51.100.7" })).toBe(false);
  });

  it("keeps the set-aside logins when the move's addresses are written", async () => {
    const { paths } = await createTestPhaseDeps();
    const oldOwn = { host: OWN_IPV4, port: 22, user: "root", agent: true, reachable: true };
    await recordOwnServer(paths, oldOwn);
    await setAsideOldConnection(paths, "own");
    const from = { ipv4: "198.51.100.10" };
    await recordMoveServers({ paths }, { from });
    await recordMoveServers({ paths }, { from, next: { ipv4: "198.51.100.20" } });
    expect((await readServerAddresses(paths)).retarget).toEqual({
      from,
      next: { ipv4: "198.51.100.20" },
      fromOwn: { ...oldOwn },
    });
  });
});
