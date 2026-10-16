import type { FetchLike } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { lookupPublicAddresses } from "./public-dns";

type Answer = { name: string; type: number; data: string };

/** Cloudflare's DNS over HTTPS: `zone[name][type]` answers, NXDOMAIN for names not in it. */
function doh(zone: Record<string, Partial<Record<"A" | "AAAA", Answer[]>>>) {
  const queries: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe("https://cloudflare-dns.com/dns-query");
    expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") as "A" | "AAAA";
    queries.push(`${name} ${type}`);
    const records = zone[name];
    if (records === undefined) return Response.json({ Status: 3 });
    return Response.json({ Status: 0, Answer: records[type] ?? [] });
  };
  return { fetch, queries };
}

describe("lookupPublicAddresses", () => {
  it("returns the A and AAAA addresses, following the CNAME chain in the answer", async () => {
    const edge = "shop.example.com.cdn.cloudflare.net.";
    const { fetch } = doh({
      "shop.example.com": {
        A: [
          { name: "shop.example.com.", type: 5, data: edge },
          { name: edge, type: 1, data: "104.21.32.1" },
          { name: edge, type: 1, data: "172.67.1.1" },
        ],
        AAAA: [
          { name: "shop.example.com.", type: 5, data: edge },
          { name: edge, type: 28, data: "2606:4700:3030::6815:2001" },
        ],
      },
    });
    expect(await lookupPublicAddresses(fetch, "Shop.Example.com.")).toEqual({
      state: "found",
      ipv4: ["104.21.32.1", "172.67.1.1"],
      ipv6: ["2606:4700:3030::6815:2001"],
    });
  });

  it("asks the same resolver for a CNAME target the answer does not resolve", async () => {
    const { fetch, queries } = doh({
      "shop.example.com": {
        A: [{ name: "shop.example.com.", type: 5, data: "home.dyn.example.net." }],
        AAAA: [{ name: "shop.example.com.", type: 5, data: "home.dyn.example.net." }],
      },
      "home.dyn.example.net": {
        A: [{ name: "home.dyn.example.net.", type: 1, data: "192.0.2.7" }],
      },
    });
    expect(await lookupPublicAddresses(fetch, "shop.example.com")).toEqual({
      state: "found",
      ipv4: ["192.0.2.7"],
      ipv6: [],
    });
    expect(queries).toEqual([
      "shop.example.com A",
      "home.dyn.example.net A",
      "shop.example.com AAAA",
      "home.dyn.example.net AAAA",
    ]);
  });

  it("a record without an address (a CNAME loop or a dangling target) is found with no addresses", async () => {
    const { fetch, queries } = doh({
      "shop.example.com": {
        A: [{ name: "shop.example.com.", type: 5, data: "loop.example.net." }],
      },
      "loop.example.net": {
        A: [{ name: "loop.example.net.", type: 5, data: "shop.example.com." }],
      },
    });
    expect(await lookupPublicAddresses(fetch, "shop.example.com")).toEqual({
      state: "found",
      ipv4: [],
      ipv6: [],
    });
    expect(queries.length).toBeLessThanOrEqual(4);
  });

  it("NXDOMAIN or an empty answer is missing; a failed or unreadable lookup is unknown", async () => {
    expect(await lookupPublicAddresses(doh({}).fetch, "shop.example.com")).toEqual({
      state: "missing",
    });
    expect(
      await lookupPublicAddresses(doh({ "shop.example.com": {} }).fetch, "shop.example.com"),
    ).toEqual({ state: "missing" });
    const failing: FetchLike = async () => {
      throw new Error("offline");
    };
    expect((await lookupPublicAddresses(failing, "shop.example.com")).state).toBe("unknown");
    const servfail: FetchLike = async () => Response.json({ Status: 2 });
    expect((await lookupPublicAddresses(servfail, "shop.example.com")).state).toBe("unknown");
    const garbage: FetchLike = async () => new Response("<html>");
    expect((await lookupPublicAddresses(garbage, "shop.example.com")).state).toBe("unknown");
  });

  it("drops answers that are not addresses of the asked type", async () => {
    const { fetch } = doh({
      "shop.example.com": {
        A: [
          { name: "shop.example.com.", type: 1, data: "not-an-address" },
          { name: "shop.example.com.", type: 1, data: "2001:db8::1" },
          { name: "shop.example.com.", type: 1, data: "192.0.2.9" },
        ],
      },
    });
    expect(await lookupPublicAddresses(fetch, "shop.example.com")).toEqual({
      state: "found",
      ipv4: ["192.0.2.9"],
      ipv6: [],
    });
  });
});
