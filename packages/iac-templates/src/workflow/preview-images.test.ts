import { describe, expect, it } from "vitest";
import { previewPlan } from "./__fixtures__/previews";
import { previewImagesScript } from "./preview-images";

interface Version {
  id: number;
  digest: string;
  tags: string[];
  created: string;
}
type PreviewPrunable = (
  versions: Version[],
  children: Record<string, string[]>,
  open: number[],
  number: number,
  running: string | null,
) => number[];
type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Runs the program's text with fakes; returns `previewPrunable` and `main`. */
function load(fakes: { env?: Record<string, string>; fetch?: Fetch; log?: string[] } = {}) {
  const process = { env: fakes.env ?? {}, exitCode: undefined as number | undefined };
  const console = { log: (line: string) => fakes.log?.push(line) };
  const setTimeout = (resolve: () => void) => resolve();
  const factory = new Function(
    "process",
    "fetch",
    "console",
    "setTimeout",
    `${previewImagesScript(previewPlan())}\nreturn { previewPrunable, main };`,
  );
  const loaded = factory(process, fakes.fetch, console, setTimeout) as {
    previewPrunable: PreviewPrunable;
    main: () => Promise<void>;
  };
  return { ...loaded, process };
}

const commit = (n: number) => n.toString(16).padStart(40, "0");
const digest = (prefix: string, fill = "0") => `sha256:${prefix.padEnd(64, fill)}`;
let nextId = 1;
const version = (d: string, tags: string[]): Version => ({
  id: nextId++,
  digest: d,
  tags,
  created: "2026-11-01T00:00:00Z",
});
/** A pushed image: the tagged index and its two untagged children. */
function push(prefix: string, tags: string[]) {
  const index = version(digest(prefix), tags);
  const image = version(digest(prefix, "1"), []);
  const attestation = version(digest(prefix, "2"), []);
  return {
    index,
    versions: [index, image, attestation],
    children: { [index.digest]: [image.digest, attestation.digest] },
  };
}
const ids = (versions: Version[]) => versions.map((v) => v.id).sort((a, b) => a - b);

describe("previewPrunable", () => {
  const { previewPrunable } = load();
  const pr = (n: number, c: number) => `pr-${n}-${commit(c)}`;
  const prod = push("a", [commit(1), "opscrew-prod"]);
  const closed = push("b", [pr(5, 1)]);
  const closedBuild = version(digest("b3"), [`build-${pr(5, 1)}`]);
  const older = push("c", [pr(7, 1)]);
  const running = push("d", [pr(7, 2)]);
  const ownBuild = version(digest("d3"), [`build-${pr(7, 2)}`]);
  const other = push("e", [pr(9, 1)]);
  const all = [prod, closed, older, running, other];
  const versions = [...all.flatMap((p) => p.versions), closedBuild, ownBuild];
  const children = Object.assign({}, ...all.map((p) => p.children));
  const select = (open: number[], number: number, run: string | null, list = children) =>
    previewPrunable(versions, list, open, number, run).sort((a, b) => a - b);

  it("deletes closed pull requests' images and this one's but the running, with their children", () => {
    expect(select([7, 9], 7, running.index.digest)).toEqual(
      ids([...closed.versions, closedBuild, ...older.versions, ownBuild]),
    );
  });

  it("keeps this pull request's images, but its intermediates, while no running image is known", () => {
    expect(select([7, 9], 7, null)).toEqual(ids([...closed.versions, closedBuild, ownBuild]));
  });

  it("deletes every image of a closed pull request on its removal", () => {
    expect(select([9], 7, null)).toEqual(
      ids([...closed.versions, closedBuild, ...older.versions, ...running.versions, ownBuild]),
    );
  });

  it("never deletes another tag, a mixed version, nor what a kept version lists", () => {
    const mixed = version(digest("f"), [pr(5, 3), "latest"]);
    const lookalike = version(digest("f1"), ["pr-5-abc"]);
    const lists = { ...children, [prod.index.digest]: [closed.index.digest] };
    const deleted = previewPrunable([...versions, mixed, lookalike], lists, [7, 9], 7, null);
    expect(deleted.sort((a, b) => a - b)).toEqual(ids([closedBuild, ownBuild]));
  });
});

describe("the preview images program", () => {
  const RUNNING = `ghcr.io/acme/shop@${digest("d")}`;
  const base = "https://api.github.com/users/acme/packages/container/shop/versions";

  /** A fake GitHub API and registry for `versions`, with `open` pull requests. */
  function github(versions: Version[], children: Record<string, string[]>, open: number[]) {
    const calls: string[] = [];
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fetch: Fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "https://api.github.com/users/acme") return ok({ type: "User" });
      if (url === `${base}?per_page=100&page=1`) {
        return ok(
          versions.map((v) => ({
            id: v.id,
            name: v.digest,
            created_at: v.created,
            metadata: { container: { tags: v.tags } },
          })),
        );
      }
      if (url === "https://api.github.com/repos/acme/shop/pulls?state=open&per_page=100&page=1") {
        return ok(open.map((number) => ({ number })));
      }
      if (url.startsWith("https://ghcr.io/token?")) return ok({ token: "registry-placeholder" });
      const manifest = /\/manifests\/(sha256:[0-9a-f]{64})$/.exec(url);
      if (manifest) {
        return ok({ manifests: (children[manifest[1] ?? ""] ?? []).map((d) => ({ digest: d })) });
      }
      if (method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    return { fetch, calls };
  }
  const env = (extra: Record<string, string> = {}) => ({
    TOKEN: "token-placeholder",
    GITHUB_REPOSITORY: "Acme/Shop",
    GITHUB_ACTOR: "octocat",
    NUMBER: "7",
    RUNNING,
    ...extra,
  });

  it("reads the versions before the open pull requests, then deletes what it selects", async () => {
    const closed = push("b", [`pr-5-${commit(1)}`]);
    const running = push("d", [`pr-7-${commit(2)}`]);
    const versions = [...closed.versions, ...running.versions];
    const api = github(versions, { ...closed.children, ...running.children }, [7]);
    const log: string[] = [];
    const program = load({ env: env(), fetch: api.fetch, log });
    await program.main();
    expect(program.process.exitCode).toBeUndefined();
    const versionsAt = api.calls.indexOf(`GET ${base}?per_page=100&page=1`);
    const pullsAt = api.calls.findIndex((c) => c.includes("/pulls?state=open"));
    expect(versionsAt).toBeGreaterThanOrEqual(0);
    expect(pullsAt).toBeGreaterThan(versionsAt);
    expect(api.calls.filter((c) => c.startsWith("DELETE")).sort()).toEqual(
      closed.versions.map((v) => `DELETE ${base}/${v.id}`).sort(),
    );
    expect(log).toContain(`Deleted ${closed.index.digest} (pr-5-${commit(1)})`);
  });

  it.each([
    ["no pull request number", { NUMBER: "" }],
    ["a number that is not one", { NUMBER: "7;" }],
    ["a running image that is not a digest", { RUNNING: "ghcr.io/acme/shop:latest" }],
  ])("deletes nothing with %s", async (_, extra) => {
    const api = github([], {}, []);
    const log: string[] = [];
    const program = load({ env: env(extra), fetch: api.fetch, log });
    await program.main();
    expect(program.process.exitCode).toBe(1);
    expect(api.calls).toEqual([]);
    expect(log).toEqual([
      "::error::OpsCrew could not tell which pull request or image this run is about, so it deleted no image.",
    ]);
  });
});
