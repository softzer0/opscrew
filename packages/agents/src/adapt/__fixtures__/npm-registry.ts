import type { FetchLike } from "@opscrew/contracts";

/** One release in a fake package document: its peer dependencies, and whether it is deprecated. */
export interface FakeRelease {
  peers?: Record<string, string>;
  deprecated?: string;
}

/** Package name → its latest tag and releases. */
export type FakePackages = Record<string, { latest: string; versions: Record<string, FakeRelease> }>;

/**
 * The adapters as the npm registry lists them, shaped like spike result 6: `@astrojs/cloudflare`
 * 14.4 needs astro ^7.4.0, so an app on 7.3 gets 14.3.
 */
export const ADAPTER_PACKAGES: FakePackages = {
  "@astrojs/cloudflare": {
    latest: "14.4.2",
    versions: {
      "13.2.0": { peers: { astro: "^6.0.0" } },
      "14.3.0": { peers: { astro: "^7.0.0" } },
      "14.3.1": { peers: { astro: "^7.0.0" } },
      "14.4.0": { peers: { astro: "^7.4.0" }, deprecated: "Use 14.4.2." },
      "14.4.2": { peers: { astro: "^7.4.0" } },
      "15.0.0-beta.1": { peers: { astro: "^8.0.0-beta.0" } },
    },
  },
  "@opennextjs/cloudflare": {
    latest: "1.20.13",
    versions: {
      "1.19.0": { peers: { next: ">=15.5.0 <17", wrangler: "^4.40.0" } },
      "1.20.13": { peers: { next: ">=15.5.0 <17", wrangler: "^4.50.0" } },
    },
  },
  "@sveltejs/adapter-cloudflare": {
    latest: "8.0.1",
    versions: {
      "7.2.4": { peers: { "@sveltejs/kit": "^2.0.0", wrangler: "^4.0.0" } },
      "8.0.1": { peers: { "@sveltejs/kit": "^3.0.0", wrangler: "^4.0.0" } },
    },
  },
};

/**
 * A fake npm registry answering the abbreviated package document for `packages`, recording each
 * URL asked for; any other URL is a test failure (no test reaches the network).
 */
export function fakeNpmRegistry(packages: FakePackages = ADAPTER_PACKAGES): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    urls.push(url);
    const prefix = "https://registry.npmjs.org/";
    if (!url.startsWith(prefix)) throw new Error(`Unexpected network call in a test: ${url}`);
    const name = decodeURIComponent(url.slice(prefix.length));
    const found = packages[name];
    if (found === undefined) return new Response('{"error":"Not found"}', { status: 404 });
    const versions = Object.fromEntries(
      Object.entries(found.versions).map(([version, release]) => [
        version,
        {
          name,
          version,
          ...(release.peers === undefined ? {} : { peerDependencies: release.peers }),
          ...(release.deprecated === undefined ? {} : { deprecated: release.deprecated }),
          dist: { tarball: `${prefix}${name}/-/${version}.tgz` },
        },
      ]),
    );
    return new Response(JSON.stringify({ name, "dist-tags": { latest: found.latest }, versions }), {
      headers: { "content-type": "application/vnd.npm.install-v1+json" },
    });
  };
  return { fetch, urls };
}
