import { Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { providerProfile, VPS_PROVIDERS, vpsConnector } from "../providers";
import { forbiddenFetch } from "../testing";
import { DELAY_WARNING_MS, estimateHop, hopDelay, PAGE_QUERIES } from "./delay";

const fsn1 = { provider: "hetzner", location: "fsn1" } as const;

describe("the delay estimate", () => {
  it("knows every location of both providers and of their price lists", async () => {
    for (const provider of VPS_PROVIDERS) {
      const profile = providerProfile(provider);
      // The provider's dated static price list: every location a server can be priced in.
      const catalog = vpsConnector(provider, {
        env: {},
        fetch: forbiddenFetch,
        redactor: new Redactor(),
        version: "0.0.0-test",
      }).catalog();
      const offered = (await catalog.listOffers()).map((offer) => offer.location);
      expect(offered.length).toBeGreaterThan(0);
      const locations = new Set([
        ...offered,
        ...Object.keys(profile.locationNames),
        ...Object.values(profile.regionLocations).flat(),
      ]);
      for (const location of locations) {
        expect(estimateHop(fsn1, { provider, location }), `${provider} ${location}`).toBeDefined();
      }
    }
  });

  it("is 2 ms plus 1 ms per 50 km of great-circle distance, as calibrated on fsn1 to hel1", () => {
    expect(estimateHop(fsn1, fsn1)).toEqual({ roundTripMs: 2, distanceKm: 0 });
    const hel1 = estimateHop(fsn1, { provider: "hetzner", location: "hel1" });
    expect(hel1?.distanceKm).toBeGreaterThan(1300);
    expect(hel1?.distanceKm).toBeLessThan(1360);
    // About 28 ms estimated; the real-server pass measured 36 ms (within a factor of two).
    expect(hel1?.roundTripMs).toBeGreaterThan(28);
    expect(hel1?.roundTripMs).toBeLessThan(30);
    const nbg1 = estimateHop(fsn1, { provider: "hetzner", location: "nbg1" });
    expect(nbg1?.roundTripMs).toBeGreaterThan(4.5);
    expect(nbg1?.roundTripMs).toBeLessThan(5);
  });

  it("labels the same location's hop as an estimate, with what it adds to a page, and no warning", () => {
    const delay = hopDelay(fsn1, "db", fsn1, ["db"]);
    expect(delay.text).toBe(
      `Each query from the app to db on server db waits about 2 ms (an estimate: 2 ms plus 1 ms per 50 km between fsn1 and fsn1, 0 km apart), so a page that makes ${PAGE_QUERIES} queries in a row takes about 40 ms longer.`,
    );
    expect(delay.pageMs).toBe(40);
    expect(delay.warning).toBeUndefined();
  });

  it(`warns above ${DELAY_WARNING_MS} ms, saying what would shorten it`, () => {
    const far = hopDelay(fsn1, "db", { provider: "hetzner", location: "hel1" }, ["db", "cache"]);
    expect(far.text).toContain(
      "Each query from the app to db and cache on server db waits about 29 ms",
    );
    expect(far.text).toContain("1,334 km apart");
    expect(far.pageMs).toBe(574);
    expect(far.warning).toBe(
      "Each query from the app to db and cache on server db waits about 29 ms, so a page that makes 20 queries in a row takes about 574 ms longer, which users notice. To shorten it, put server db in fsn1 with the app's server (about 2 ms a query), or keep db and cache on the app's server.",
    );
    // Another provider in another city: Frankfurt is about 265 km from Falkenstein.
    const other = hopDelay(fsn1, "db", { provider: "digitalocean", location: "fra1" }, ["db"]);
    expect(other.estimate?.roundTripMs).toBeGreaterThan(DELAY_WARNING_MS);
    expect(other.warning).toBeDefined();
    // Falkenstein to Nuremberg stays just under the threshold.
    expect(hopDelay(fsn1, "db", { provider: "hetzner", location: "nbg1" }, ["db"]).warning).toBe(
      undefined,
    );
  });

  it("says `opscrew status` measures a hop to or from a server the user owns", () => {
    const own = hopDelay(fsn1, "home", { provider: "own" }, ["db"]);
    expect(own).toEqual({
      text: "OpsCrew cannot estimate the delay of each query from the app to db on server home: it does not know your own server's location. `opscrew status` measures it once the servers are linked.",
    });
    const fromOwn = hopDelay({ provider: "own" }, "db", fsn1, ["db"]);
    expect(fromOwn.estimate).toBeUndefined();
    expect(fromOwn.text).toContain("`opscrew status` measures it");
  });
});
