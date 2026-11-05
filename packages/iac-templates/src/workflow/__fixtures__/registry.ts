import { expect } from "vitest";
import { MANIFEST_ACCEPT } from "../../registry";

/** A package version, as the image programs read it. */
export interface Version {
  id: number;
  digest: string;
  tags: string[];
  created: string;
}
export type FakeProcess = { env: Record<string, string>; exitCode?: number };
export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** `hour` hours into October 2026, in milliseconds. */
export const at = (hour: number) => Date.UTC(2026, 9, 1) + hour * 3_600_000;
/** November 2026: after every version the tests make, so none of them is recent. */
export const LATER = Date.UTC(2026, 10, 1);

/**
 * Runs `script` (an image program) with fakes, its clock (`Date.now()`) at `now` (default
 * {@link LATER}); returns its pure selection (the function named `select`) and `main`.
 */
export function load<Select>(
  script: string,
  select: string,
  fakes: { process?: FakeProcess; fetch?: Fetch; log?: string[]; now?: number } = {},
) {
  const console = { log: (line: string) => fakes.log?.push(line) };
  const now = fakes.now ?? LATER;
  const FakeDate = class extends Date {
    static override now() {
      return now;
    }
  };
  // The workflow runs this text with Node.js; here it gets fake globals instead. Its waits pass
  // at once.
  const setTimeout = (resolve: () => void) => resolve();
  const factory = new Function(
    "process",
    "fetch",
    "console",
    "Date",
    "setTimeout",
    `${script.replace(/main\(\);\s*$/, "")}\nreturn { select: ${select}, main };`,
  );
  return factory(fakes.process, fakes.fetch, console, FakeDate, setTimeout) as {
    select: Select;
    main: () => Promise<void>;
  };
}

export const commit = (n: number) => n.toString(16).padStart(40, "0");
/** A digest starting with `prefix`, filled with `fill`. */
export const digest = (prefix: string, fill = "0") => `sha256:${prefix.padEnd(64, fill)}`;
let nextId = 1;
/** A package version created `hour` hours into October 2026 (ids grow in listing order). */
export const version = (d: string, tags: string[], hour = 0): Version => ({
  id: nextId++,
  digest: d,
  tags,
  created: new Date(at(hour)).toISOString(),
});
/**
 * A sealed push of commit `hour`: the tagged index plus its two untagged children (the platform
 * image and the attestation manifest), as GHCR lists them.
 */
export function push(c: string, hour: number, tags: string[] = [commit(hour)]) {
  const index = version(digest(c, "0"), tags, hour);
  const image = version(digest(c, "1"), [], hour);
  const attestation = version(digest(c, "2"), [], hour);
  return {
    index,
    image,
    attestation,
    versions: [index, image, attestation],
    children: { [index.digest]: [image.digest, attestation.digest] },
  };
}

export function ids(versions: Version[]) {
  return versions.map((v) => v.id).sort((a, b) => a - b);
}

/** The repository's workflows, as GitHub lists them: prod's and staging's OpsCrew deploy ones. */
const WORKFLOWS = [
  { name: "OpsCrew deploy", state: "active" },
  { name: "OpsCrew deploy (staging)", state: "active" },
  { name: "CI", state: "active" },
];

/** A fake GitHub API and registry for `pushes` of package `acme/<pkg>` (default `acme/shop`). */
export function registry(o: {
  /** The package's name: the repository's, or a further app's `<repo>/<key>`. */
  pkg?: string;
  type?: "User" | "Organization";
  pushes: { versions: Version[]; children: Record<string, string[]> }[];
  failManifest?: boolean;
  /** How many manifest reads answer 404 first, as when another environment's deploy deletes. */
  goneManifests?: number;
  failDelete?: number[];
  goneDelete?: number[];
  /** The repository's workflows (default {@link WORKFLOWS}). */
  workflows?: { name: string; state: string }[];
  /** The numbers of the repository's open pull requests (default none). */
  open?: number[];
}) {
  const calls: string[] = [];
  const listed = o.pushes.flatMap((p) => p.versions);
  const children: Record<string, string[]> = Object.assign({}, ...o.pushes.map((p) => p.children));
  const owner = o.type === "Organization" ? "orgs" : "users";
  const pkg = o.pkg ?? "shop";
  const fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const notFound = { ok: false, status: 404, json: async () => ({}) };
    if (url === "https://api.github.com/repos/acme/shop/actions/workflows?per_page=100&page=1") {
      expect(init.headers?.Authorization).toBe("Bearer token-placeholder");
      return ok({ workflows: o.workflows ?? WORKFLOWS });
    }
    if (url === "https://api.github.com/repos/acme/shop/pulls?state=open&per_page=100&page=1") {
      expect(init.headers?.Authorization).toBe("Bearer token-placeholder");
      return ok((o.open ?? []).map((number) => ({ number })));
    }
    if (url === "https://api.github.com/users/acme") return ok({ type: o.type ?? "User" });
    const base = `https://api.github.com/${owner}/acme/packages/container/${encodeURIComponent(pkg)}/versions`;
    const page = new RegExp(`^${base}\\?per_page=100&page=(\\d+)$`).exec(url);
    if (page) {
      expect(init.headers?.Authorization).toBe("Bearer token-placeholder");
      const n = Number(page[1]);
      return ok(
        listed.slice((n - 1) * 100, n * 100).map((v) => ({
          id: v.id,
          name: v.digest,
          created_at: v.created,
          metadata: { package_type: "container", container: { tags: v.tags } },
        })),
      );
    }
    if (url.startsWith("https://ghcr.io/token?")) {
      expect(url).toBe(`https://ghcr.io/token?service=ghcr.io&scope=repository:acme/${pkg}:pull`);
      expect(init.headers?.Authorization).toBe(
        `Basic ${Buffer.from("octocat:token-placeholder").toString("base64")}`,
      );
      return ok({ token: "registry-placeholder" });
    }
    const manifest = new RegExp(
      `^https://ghcr\\.io/v2/acme/${pkg}/manifests/(sha256:[0-9a-f]{64})$`,
    ).exec(url);
    if (manifest) {
      if (o.failManifest) return { ok: false, status: 500, json: async () => ({}) };
      if ((o.goneManifests ?? 0) > 0) {
        o.goneManifests = (o.goneManifests ?? 0) - 1;
        return notFound;
      }
      expect(init.headers?.Authorization).toBe("Bearer registry-placeholder");
      // The same manifest types OpsCrew's own registry lookups ask for.
      expect(init.headers?.Accept).toBe(MANIFEST_ACCEPT);
      const list = children[manifest[1] ?? ""];
      return ok(
        list === undefined ? { layers: [] } : { manifests: list.map((d) => ({ digest: d })) },
      );
    }
    const del = new RegExp(`^${base}/(\\d+)$`).exec(url);
    if (del && method === "DELETE") {
      const id = Number(del[1]);
      if (o.goneDelete?.includes(id)) return notFound;
      return o.failDelete?.includes(id)
        ? { ok: false, status: 403, json: async () => ({}) }
        : { ok: true, status: 204, json: async () => ({}) };
    }
    return notFound;
  };
  return { fetch, calls, deleted: () => calls.filter((c) => c.startsWith("DELETE")) };
}
