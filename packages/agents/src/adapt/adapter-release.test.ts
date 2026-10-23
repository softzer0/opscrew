import { describe, expect, it } from "vitest";
import { fakeNpmRegistry } from "./__fixtures__/npm-registry";
import { adapterRelease } from "./adapter-release";

describe("adapterRelease", () => {
  it("pins the newest release whose peer range allows the app's framework (spike result 6)", async () => {
    const registry = fakeNpmRegistry();
    expect(await adapterRelease(registry.fetch, "@astrojs/cloudflare", "astro", [7, 4, 1])).toEqual(
      { ok: true, version: "14.4.2" },
    );
    // astro 7.3 gets 14.3, with the newest release and the upgrade it needs named.
    expect(await adapterRelease(registry.fetch, "@astrojs/cloudflare", "astro", [7, 3, 8])).toEqual(
      { ok: true, version: "14.3.1", newer: { version: "14.4.2", range: "^7.4.0" } },
    );
    expect(registry.urls).toEqual([
      "https://registry.npmjs.org/@astrojs%2fcloudflare",
      "https://registry.npmjs.org/@astrojs%2fcloudflare",
    ]);
  });

  it("skips prereleases, deprecated releases and releases past latest", async () => {
    const registry = fakeNpmRegistry({
      "@astrojs/cloudflare": {
        latest: "14.3.0",
        versions: {
          "14.3.0": { peers: { astro: "^7.0.0" } },
          "14.4.0": { peers: { astro: "^7.0.0" }, deprecated: "Broken." },
          "14.5.0-beta.2": { peers: { astro: "^7.0.0" } },
          "15.0.0": { peers: { astro: "^7.0.0" } },
        },
      },
    });
    expect(await adapterRelease(registry.fetch, "@astrojs/cloudflare", "astro", [7, 4, 0])).toEqual(
      { ok: true, version: "14.3.0" },
    );
  });

  it("names the upgrade when no release supports the app's framework", async () => {
    const registry = fakeNpmRegistry();
    const release = await adapterRelease(registry.fetch, "@astrojs/cloudflare", "astro", [5, 2, 0]);
    expect(release).toEqual({
      ok: false,
      reason:
        "No release of @astrojs/cloudflare supports astro 5.2.0: its newest, 14.4.2, needs astro ^7.4.0. Upgrade astro, then run `opscrew adapt` again.",
    });
  });

  it("never picks an old release without a peer on the framework over the upgrade it needs", async () => {
    const registry = fakeNpmRegistry({
      "@astrojs/cloudflare": {
        latest: "14.4.2",
        versions: {
          "1.0.0": {},
          "14.4.2": { peers: { astro: "^7.4.0" } },
        },
      },
    });
    expect(
      await adapterRelease(registry.fetch, "@astrojs/cloudflare", "astro", [7, 3, 8]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Upgrade astro") });
    // With no release declaring one, the newest release is the one.
    const undeclared = fakeNpmRegistry({
      "@astrojs/cloudflare": { latest: "2.0.0", versions: { "1.0.0": {}, "2.0.0": {} } },
    });
    expect(
      await adapterRelease(undeclared.fetch, "@astrojs/cloudflare", "astro", [7, 3, 8]),
    ).toEqual({ ok: true, version: "2.0.0" });
  });

  it("says why when the registry cannot be read", async () => {
    const missing = await adapterRelease(
      fakeNpmRegistry({}).fetch,
      "@astrojs/cloudflare",
      "astro",
      [7, 3, 8],
    );
    expect(missing).toEqual({
      ok: false,
      reason:
        "OpsCrew could not read the releases of @astrojs/cloudflare from the npm registry (it answered HTTP 404).",
    });
    const offline = await adapterRelease(
      async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
      "@astrojs/cloudflare",
      "astro",
      [7, 3, 8],
    );
    expect(offline).toMatchObject({
      ok: false,
      reason: expect.stringContaining("(getaddrinfo ENOTFOUND registry.npmjs.org)"),
    });
  });
});
