/**
 * The release of a framework's Cloudflare adapter that `opscrew adapt` pins: the newest one on the
 * npm registry whose peer dependency on the framework allows the app's version (research.md
 * "Spike results" 6: `@astrojs/cloudflare` 14.4 needs astro ^7.4.0, so an app on 7.3 gets 14.3).
 */
import type { FetchLike } from "@opscrew/contracts";
import { z } from "zod";
import {
  compareVersions,
  isPrerelease,
  parseVersion,
  satisfiesRange,
  type Version,
  versionText,
} from "./npm-range";

/** The npm registry adapt reads adapter releases from. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The registry's abbreviated package document, as far as adapt reads it. */
const PackumentSchema = z.object({
  "dist-tags": z.object({ latest: z.string() }),
  versions: z.record(
    z.string(),
    z.object({
      peerDependencies: z.record(z.string(), z.string()).optional(),
      deprecated: z.string().optional(),
    }),
  ),
});

/** The adapter release adapt pins, or why there is none. */
export type AdapterRelease =
  | {
      ok: true;
      version: string;
      /** The newest release, when it needs a newer framework than the app's: its version and range. */
      newer?: { version: string; range: string };
    }
  | { ok: false; reason: string };

/**
 * The newest release of `adapter` (not a prerelease, not deprecated, not past `latest`) whose peer
 * dependency on `framework` allows `version`, read through `fetch` from {@link NPM_REGISTRY}; the
 * newest release when none declares such a peer. With `newer` when the newest release needs a
 * newer framework. A failed lookup or no fitting release is `ok: false` with the reason in a
 * sentence.
 */
export async function adapterRelease(
  fetch: FetchLike,
  adapter: string,
  framework: string,
  version: Version,
): Promise<AdapterRelease> {
  const url = `${NPM_REGISTRY}/${adapter.replace("/", "%2f")}`;
  let document: z.infer<typeof PackumentSchema>;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`it answered HTTP ${response.status}`);
    const parsed = PackumentSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("its answer was not a package document");
    document = parsed.data;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `OpsCrew could not read the releases of ${adapter} from the npm registry (${why}).`,
    };
  }
  const latest = parseVersion(document["dist-tags"].latest);
  const releases = Object.entries(document.versions)
    .filter(([name, release]) => !isPrerelease(name) && release.deprecated === undefined)
    .map(([name, release]) => ({
      name,
      parts: parseVersion(name),
      range: release.peerDependencies?.[framework],
    }))
    .filter(
      (release): release is typeof release & { parts: Version } =>
        release.parts !== undefined &&
        (latest === undefined || compareVersions(release.parts, latest) <= 0),
    )
    .sort((a, b) => compareVersions(b.parts, a.parts));
  // A release with no peer on the framework says nothing about it: it counts only when no release
  // declares one, so an old release without one is never picked over the upgrade it would need.
  const declaring = releases.filter(
    (release): release is typeof release & { range: string } => release.range !== undefined,
  );
  const newest = declaring[0];
  if (newest === undefined) {
    const only = releases[0];
    return only === undefined
      ? { ok: false, reason: `The npm registry lists no release of ${adapter}.` }
      : { ok: true, version: only.name };
  }
  const fits = declaring.find((release) => satisfiesRange(release.range, version) === true);
  if (fits === undefined) {
    return {
      ok: false,
      reason: `No release of ${adapter} supports ${framework} ${versionText(version)}: its newest, ${newest.name}, needs ${framework} ${newest.range}. Upgrade ${framework}, then run \`opscrew adapt\` again.`,
    };
  }
  return {
    ok: true,
    version: fits.name,
    ...(newest === fits ? {} : { newer: { version: newest.name, range: newest.range } }),
  };
}
