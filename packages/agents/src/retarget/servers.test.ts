import { describe, expect, it } from "vitest";
import { assertDistinctServers, sameAddress } from "./servers";

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
});
