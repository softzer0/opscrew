// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { MANIFEST_ACCEPT } from "../registry";
import { inEnvironment, jobYaml, serverPlan, withBuild, withPlan } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";
import { retentionScript } from "./retention";

interface Version {
  id: number;
  digest: string;
  tags: string[];
  created: string;
}
type Prunable = (
  versions: Version[],
  children: Record<string, string[]>,
  keep: number | undefined,
  protect: string[],
  recent: number,
) => number[];
type FakeProcess = { env: Record<string, string>; exitCode?: number };
type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** `hour` hours into October 2026, in milliseconds. */
const at = (hour: number) => Date.UTC(2026, 9, 1) + hour * 3_600_000;
/** November 2026: after every version the tests make, so none of them is recent. */
const LATER = Date.UTC(2026, 10, 1);

/**
 * Runs `script` (the step's program) with fakes, its clock (`Date.now()`) at `now` (default
 * {@link LATER}); returns `prunable` and `main`.
 */
function load(
  script: string,
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
    `${script.replace(/main\(\);\s*$/, "")}\nreturn { prunable, main };`,
  );
  return factory(fakes.process, fakes.fetch, console, FakeDate, setTimeout) as {
    prunable: Prunable;
    main: () => Promise<void>;
  };
}

/** `prunable` of `environment`'s program, with no version recent unless `recent` says so. */
function selection(environment: string) {
  const loaded = load(retentionScript(environment)).prunable;
  return (
    versions: Version[],
    children: Record<string, string[]>,
    keep: number | undefined,
    protect: string[],
    recent = LATER,
  ) => loaded(versions, children, keep, protect, recent);
}

const prunable = selection("prod");

const commit = (n: number) => n.toString(16).padStart(40, "0");
/** A digest starting with `prefix`, filled with `fill`. */
const digest = (prefix: string, fill: string) => `sha256:${prefix.padEnd(64, fill)}`;
let nextId = 1;
/** A package version created `hour` hours into October 2026 (ids grow in listing order). */
const version = (d: string, tags: string[], hour: number): Version => ({
  id: nextId++,
  digest: d,
  tags,
  created: new Date(at(hour)).toISOString(),
});
/**
 * A sealed push of commit `hour`: the tagged index plus its two untagged children (the platform
 * image and the attestation manifest), as GHCR lists them.
 */
function push(c: string, hour: number, tags: string[] = [commit(hour)]) {
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

function ids(versions: Version[]) {
  return versions.map((v) => v.id).sort((a, b) => a - b);
}

describe("prunable", () => {
  const pushes = ["a", "b", "c", "d", "e"].map((c, i) => push(c, i + 1));
  const versions = pushes.flatMap((p) => p.versions);
  const children = Object.assign({}, ...pushes.map((p) => p.children));
  const [a, b, c, d, e] = pushes as [
    ReturnType<typeof push>,
    ReturnType<typeof push>,
    ReturnType<typeof push>,
    ReturnType<typeof push>,
    ReturnType<typeof push>,
  ];

  it("keeps the newest images with their untagged children and deletes the older ones with theirs", () => {
    const deleted = prunable(versions, children, 3, [e.index.digest, d.index.digest]);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids([...a.versions, ...b.versions]));
  });

  it("never deletes the running or the previous image, however old", () => {
    const deleted = prunable(versions, children, 2, [e.index.digest, a.index.digest]);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids([...b.versions, ...c.versions]));
  });

  it("orders by creation time, then by id", () => {
    const late = push("f", 1);
    const all = [...versions, ...late.versions];
    const deleted = prunable(all, { ...children, ...late.children }, 5, [e.index.digest]);
    // f was created at the same time as a, but listed later: it is the newer of the two.
    expect(deleted.sort((x, y) => x - y)).toEqual(ids(a.versions));
  });

  it("deletes the intermediate build-<commit> images, and only those, when retention is off", () => {
    const intermediate = version(digest("9", "0"), [`build-${commit(5)}`], 5);
    const orphan = version(digest("8", "0"), [], 1);
    // The signature of an image nothing keeps: with retention on it would go, here it stays.
    const signature = version(digest("6", "3"), [`${digest("5", "5").replace(":", "-")}.sig`], 5);
    const all = [...versions, intermediate, orphan, signature];
    expect(prunable(all, children, undefined, [e.index.digest])).toEqual([intermediate.id]);
    expect(prunable(all, children, 10, [e.index.digest])).toEqual([
      intermediate.id,
      orphan.id,
      signature.id,
    ]);
  });

  it("deletes an intermediate index together with the children only it lists", () => {
    const old = push("9", 4, [`build-${commit(4)}`]);
    const all = [...versions, ...old.versions];
    const shared = {
      ...children,
      ...old.children,
      [e.index.digest]: [...(children[e.index.digest] ?? []), old.image.digest],
    };
    const deleted = prunable(all, shared, undefined, [e.index.digest]);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids([old.index, old.attestation]));
  });

  it("keeps versions with a tag OpsCrew did not push, and what they list", () => {
    const cache = version(digest("7", "0"), ["buildcache"], 1);
    const yours = push("6", 1, ["latest", commit(99)]);
    const all = [...versions, cache, ...yours.versions];
    const deleted = prunable(all, { ...children, ...yours.children }, 2, [e.index.digest]);
    expect(deleted.sort((x, y) => x - y)).toEqual(
      ids([...a.versions, ...b.versions, ...c.versions]),
    );
  });

  it("keeps every version an environment's label tags, however old, with what it lists", () => {
    // prod runs an old image and ran an older one before; another environment's previous one is
    // labelled only (its commit tag moved to a rebuild).
    const prodRuns = push("9", 0, [commit(90), "opscrew-prod"]);
    const prodBefore = push("8", 0, [commit(80), "opscrew-prod-previous"]);
    const labelOnly = push("7", 0, ["opscrew-eu-staging-previous"]);
    const labelled = [prodRuns, prodBefore, labelOnly];
    const all = [...versions, ...labelled.flatMap((p) => p.versions)];
    const listed = Object.assign({}, children, ...labelled.map((p) => p.children));
    expect(
      prunable(all, listed, 2, [e.index.digest, d.index.digest]).sort((x, y) => x - y),
    ).toEqual(ids([...a.versions, ...b.versions, ...c.versions]));
    expect(prunable(all, listed, undefined, [e.index.digest])).toEqual([]);
  });

  it("deletes untagged versions nothing kept lists, such as an old buildcache", () => {
    const stale = version(digest("7", "1"), [], 2);
    const deleted = prunable([...versions, stale], children, 10, [e.index.digest]);
    expect(deleted).toEqual([stale.id]);
  });

  it("keeps a child that a kept index lists too", () => {
    const shared = { ...children, [a.index.digest]: [a.image.digest, e.image.digest] };
    const deleted = prunable(versions, shared, 4, [e.index.digest]);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids([a.index, a.image, a.attestation]));
    const reused = {
      ...children,
      [e.index.digest]: [e.image.digest, e.attestation.digest, a.image.digest],
    };
    expect(prunable(versions, reused, 4, [e.index.digest]).sort((x, y) => x - y)).toEqual(
      ids([a.index, a.attestation]),
    );
  });

  it("never deletes a tagged version that a kept index lists, nor what that one lists", () => {
    const nested = {
      ...children,
      [e.index.digest]: [e.image.digest, e.attestation.digest, a.index.digest],
    };
    expect(prunable(versions, nested, 3, [e.index.digest]).sort((x, y) => x - y)).toEqual(
      ids(b.versions),
    );
    const intermediate = version(digest("9", "0"), [`build-${commit(5)}`], 5);
    const listsIt = { ...children, [e.index.digest]: [e.image.digest, intermediate.digest] };
    expect(prunable([...versions, intermediate], listsIt, undefined, [e.index.digest])).toEqual([]);
    expect(prunable([...versions, intermediate], listsIt, 10, [e.index.digest])).toEqual([
      e.attestation.id,
    ]);
  });

  it("keeps the signatures of kept images and deletes those of deleted ones", () => {
    const sigOf = (p: ReturnType<typeof push>, n: string) => {
      const index = version(digest(n, "3"), [p.index.digest.replace(":", "-")], 6);
      const bundle = version(digest(n, "4"), [], 6);
      return { index, bundle, children: { [index.digest]: [bundle.digest] } };
    };
    const old = sigOf(a, "5");
    const fresh = sigOf(e, "4");
    const legacy = version(digest("3", "3"), [`${b.index.digest.replace(":", "-")}.sig`], 6);
    const all = [...versions, old.index, old.bundle, fresh.index, fresh.bundle, legacy];
    const deleted = prunable(all, { ...children, ...old.children, ...fresh.children }, 3, [
      e.index.digest,
    ]);
    expect(deleted.sort((x, y) => x - y)).toEqual(
      ids([...a.versions, ...b.versions, old.index, old.bundle, legacy]),
    );
  });
});

describe("prunable with two environments that follow main (T1515's live run)", () => {
  // Both build every commit: prod's build tags <commit>, staging's <commit>-staging.
  const prodPrunable = prunable;
  const stagingPrunable = selection("staging");
  const staged = (n: number) => `${commit(n)}-staging`;
  const prod = [1, 2, 3, 4, 5].map((n) => push(`a${n}`, n));
  const staging = [1, 2, 3, 4, 5].map((n) => push(`b${n}`, n, [staged(n)]));
  const both = [...prod, ...staging];
  const versions = both.flatMap((p) => p.versions);
  const children = Object.assign({}, ...both.map((p) => p.children));
  const newest = (pushes: ReturnType<typeof push>[]) => pushes.at(-1)?.index.digest ?? "";

  it("prod's retention keeps every staging image and deletes only prod's older ones", () => {
    const deleted = prodPrunable(versions, children, 2, [newest(prod)]);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids(prod.slice(0, 3).flatMap((p) => p.versions)));
  });

  it("staging's retention keeps every prod image and deletes only staging's older ones", () => {
    const deleted = stagingPrunable(versions, children, 2, [newest(staging)]);
    expect(deleted.sort((x, y) => x - y)).toEqual(
      ids(staging.slice(0, 3).flatMap((p) => p.versions)),
    );
  });

  it("keeps another environment's fresh build, before its deploy labels or protects it", () => {
    // staging pushed commit 6 and has not deployed it; prod's deploy of commit 6 prunes first.
    const fresh = push("b6", 6, [staged(6)]);
    const prodSix = push("a6", 6);
    const all = [...versions, ...fresh.versions, ...prodSix.versions];
    const listed = { ...children, ...fresh.children, ...prodSix.children };
    const deleted = prodPrunable(all, listed, 1, [prodSix.index.digest]);
    expect(deleted).not.toContain(fresh.index.id);
    expect(deleted.sort((x, y) => x - y)).toEqual(ids(prod.flatMap((p) => p.versions)));
  });

  it("never keeps fewer of one environment because another builds more", () => {
    // prod built two commits long ago; staging built five since.
    const old = [push("c1", 0, [commit(80)]), push("c2", 0, [commit(81)])];
    const all = [...old, ...staging];
    const flat = all.flatMap((p) => p.versions);
    const listed = Object.assign({}, ...all.map((p) => p.children));
    expect(prodPrunable(flat, listed, 2, [newest(old)])).toEqual([]);
    expect(stagingPrunable(flat, listed, 2, [newest(staging)]).sort((x, y) => x - y)).toEqual(
      ids(staging.slice(0, 3).flatMap((p) => p.versions)),
    );
  });

  it("deletes only its own environment's intermediate images, with retention on or off", () => {
    const prodBuild = version(digest("9", "0"), [`build-${commit(6)}`], 6);
    const stagingBuild = version(digest("9", "1"), [`build-${commit(6)}-staging`], 6);
    const all = [...versions, prodBuild, stagingBuild];
    for (const keep of [undefined, 10]) {
      expect(prodPrunable(all, children, keep, [newest(prod)])).toEqual([prodBuild.id]);
      expect(stagingPrunable(all, children, keep, [newest(staging)])).toEqual([stagingBuild.id]);
    }
  });

  it("keeps every environment's label tags in each environment's retention", () => {
    const stagingRuns = push("d1", 0, [staged(90), "opscrew-staging"]);
    const prodRuns = push("d2", 0, [commit(91), "opscrew-prod", "opscrew-qa-previous"]);
    const all = [...both, stagingRuns, prodRuns];
    const flat = all.flatMap((p) => p.versions);
    const listed = Object.assign({}, ...all.map((p) => p.children));
    for (const [select, own] of [
      [prodPrunable, prod],
      [stagingPrunable, staging],
    ] as const) {
      const deleted = select(flat, listed, 1, [newest(own)]);
      expect(deleted.sort((x, y) => x - y)).toEqual(
        ids(own.slice(0, 4).flatMap((p) => p.versions)),
      );
    }
  });

  it("keeps every environment's Buildpacks cache in each environment's retention", () => {
    const caches = [
      version(digest("8", "1"), ["buildcache"], 1),
      version(digest("8", "2"), ["buildcache-staging"], 1),
    ];
    for (const [select, own] of [
      [prodPrunable, prod],
      [stagingPrunable, staging],
    ] as const) {
      const deleted = select([...versions, ...caches], children, 2, [newest(own)]);
      expect(deleted.sort((x, y) => x - y)).toEqual(
        ids(own.slice(0, 3).flatMap((p) => p.versions)),
      );
    }
  });

  it("keeps another environment's fresh untagged manifests until the index listing them arrives", () => {
    // staging is pushing commit 6: its platform image and attestation are up, its index not yet.
    const pushing = push("b6", 6, [staged(6)]);
    // An untagged version from an hour ago that nothing lists still goes.
    const orphan = version(digest("7", "3"), [], 5);
    // prod's own intermediate of commit 6 goes at once, with the child only it lists.
    const intermediate = push("96", 6, [`build-${commit(6)}`]);
    const all = [...versions, pushing.image, pushing.attestation, orphan, ...intermediate.versions];
    const listed = { ...children, ...intermediate.children };
    const recent = at(6) - 30 * 60_000;
    const deleted = prodPrunable(all, listed, 2, [newest(prod)], recent);
    expect(deleted.sort((x, y) => x - y)).toEqual(
      ids([...prod.slice(0, 3).flatMap((p) => p.versions), orphan, ...intermediate.versions]),
    );
    // Once they are older than recent and still listed by nothing, they go.
    expect(prodPrunable(all, listed, 2, [newest(prod)], at(7))).toEqual(
      expect.arrayContaining([pushing.image.id, pushing.attestation.id]),
    );
    // With retention off, only what a deleted intermediate lists goes, recent or not.
    expect(
      prodPrunable(all, listed, undefined, [newest(prod)], recent).sort((x, y) => x - y),
    ).toEqual(ids(intermediate.versions));
  });
});

describe("the retention step's program", () => {
  const RUNNING = `ghcr.io/acme/shop@${digest("e", "0")}`;
  const PREVIOUS = `ghcr.io/acme/shop@${digest("d", "0")}`;

  /** A fake GitHub API and registry for `pushes` of package `acme/shop`. */
  function github(o: {
    type?: "User" | "Organization";
    pushes: { versions: Version[]; children: Record<string, string[]> }[];
    failManifest?: boolean;
    /** How many manifest reads answer 404 first, as when another environment's deploy deletes. */
    goneManifests?: number;
    failDelete?: number[];
    goneDelete?: number[];
  }) {
    const calls: string[] = [];
    const listed = o.pushes.flatMap((p) => p.versions);
    const children: Record<string, string[]> = Object.assign(
      {},
      ...o.pushes.map((p) => p.children),
    );
    const owner = o.type === "Organization" ? "orgs" : "users";
    const fetch: Fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      const notFound = { ok: false, status: 404, json: async () => ({}) };
      if (url === "https://api.github.com/users/acme") return ok({ type: o.type ?? "User" });
      const base = `https://api.github.com/${owner}/acme/packages/container/shop/versions`;
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
        expect(url).toBe("https://ghcr.io/token?service=ghcr.io&scope=repository:acme/shop:pull");
        expect(init.headers?.Authorization).toBe(
          `Basic ${Buffer.from("octocat:token-placeholder").toString("base64")}`,
        );
        return ok({ token: "registry-placeholder" });
      }
      const manifest =
        /^https:\/\/ghcr\.io\/v2\/acme\/shop\/manifests\/(sha256:[0-9a-f]{64})$/.exec(url);
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

  const env = (extra: Record<string, string> = {}) => ({
    TOKEN: "token-placeholder",
    GITHUB_REPOSITORY: "Acme/Shop",
    GITHUB_ACTOR: "octocat",
    IMAGE: RUNNING,
    PREVIOUS,
    KEEP: "2",
    ...extra,
  });
  /** The program exactly as the rendered workflow holds it. */
  const program = (plan: DeployPlan) => {
    const steps = parse(renderWorkflow(plan, testContext()).content).jobs.prune.steps as {
      run: string;
    }[];
    return steps[0]?.run ?? "";
  };
  const script = program(serverPlan());
  const staging = inEnvironment(serverPlan(), { name: "staging" });

  /** Runs `main` of prod's program (or `text`), its clock at `now` (default {@link LATER}). */
  async function runMain(
    api: ReturnType<typeof github>,
    extra: Record<string, string> = {},
    o: { text?: string; now?: number } = {},
  ) {
    const process: FakeProcess = { env: env(extra) };
    const log: string[] = [];
    const fakes = {
      process,
      fetch: api.fetch,
      log,
      ...(o.now === undefined ? {} : { now: o.now }),
    };
    await load(o.text ?? script, fakes).main();
    return { exitCode: process.exitCode, log };
  }

  const [a, b, c] = [push("a", 1), push("b", 2), push("c", 3)];
  const pushes = [a, b, c, push("d", 4), push("e", 5)];
  const base = "https://api.github.com/users/acme/packages/container/shop/versions";

  it("is the tested program followed by main(), with the environment's own commit tag", () => {
    expect(script).toBe(`${retentionScript("prod")}\nmain();\n`);
    expect(program(staging)).toBe(`${retentionScript("staging")}\nmain();\n`);
    expect(program(staging)).toContain("/^[0-9a-f]{40}-staging$/");
    expect(program(staging)).toContain("/^build-[0-9a-f]{40}-staging$/");
  });

  it("deletes only staging's older images in staging's workflow, never prod's", async () => {
    // Both environments followed main and built the same commits 1 to 5.
    const staged = [1, 2, 3, 4, 5].map((n) => push(`f${n}`, n, [`${commit(n)}-staging`]));
    const api = github({ pushes: [...pushes, ...staged] });
    const running = staged[4]?.index.digest;
    const result = await runMain(
      api,
      { IMAGE: `ghcr.io/acme/shop@${running}`, PREVIOUS: "" },
      { text: program(staging) },
    );
    expect(result.exitCode).toBeUndefined();
    expect(api.deleted()).toEqual(
      staged.slice(0, 3).flatMap((p) => p.versions.map((v) => `DELETE ${base}/${v.id}`)),
    );
  });

  it("deletes what prunable selects through the user's packages API", async () => {
    const api = github({ pushes });
    const result = await runMain(api);
    expect(result.exitCode).toBeUndefined();
    expect(api.deleted()).toEqual(
      [...a.versions, ...b.versions, ...c.versions].map((v) => `DELETE ${base}/${v.id}`),
    );
    expect(result.log[0]).toBe("The package has 15 image versions; deleting 9.");
    expect(result.log).toContain(`Deleted ${a.index.digest} (${commit(1)})`);
  });

  it("keeps untagged versions from the last 30 minutes, which another environment's push may still list", async () => {
    // Another environment's build pushed its platform manifest a minute ago, its index not yet.
    const pushing = version(digest("6", "4"), [], 10 - 1 / 60);
    const stale = version(digest("6", "5"), [], 10 - 31 / 60);
    const api = github({ pushes: [...pushes, { versions: [pushing, stale], children: {} }] });
    const result = await runMain(api, {}, { now: at(10) });
    expect(result.exitCode).toBeUndefined();
    expect(api.deleted()).toEqual(
      [...a.versions, ...b.versions, ...c.versions, stale].map((v) => `DELETE ${base}/${v.id}`),
    );
  });

  it("never deletes a version an environment's label tags", async () => {
    // The package as GitHub lists it after prod was promoted twice from staging.
    const prodRuns = push("a", 1, [commit(1), "opscrew-prod"]);
    const prodBefore = push("b", 2, [commit(2), "opscrew-prod-previous"]);
    const api = github({ pushes: [prodRuns, prodBefore, c, push("d", 4), push("e", 5)] });
    const result = await runMain(api);
    expect(result.exitCode).toBeUndefined();
    expect(api.deleted()).toEqual(c.versions.map((v) => `DELETE ${base}/${v.id}`));
    expect(result.log[0]).toBe("The package has 15 image versions; deleting 3.");
  });

  it("uses the organization's packages API for an organization", async () => {
    const api = github({ type: "Organization", pushes });
    expect((await runMain(api)).exitCode).toBeUndefined();
    expect(api.deleted()[0]).toMatch(/^DELETE https:\/\/api\.github\.com\/orgs\/acme\//);
  });

  it("reads every page of versions", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      push((10 + i).toString(16), i, [commit(100 + i)]),
    );
    const api = github({ pushes: many });
    const last = many.at(-1)?.index.digest;
    await runMain(api, { IMAGE: `ghcr.io/acme/shop@${last}`, PREVIOUS: "" });
    expect(api.calls.filter((c) => c.includes("per_page=100"))).toHaveLength(2);
    expect(api.deleted()).toHaveLength(38 * 3);
  });

  it("deletes only the intermediate images without KEEP", async () => {
    const intermediate = push("9", 5, [`build-${commit(5)}`]);
    const api = github({ pushes: [...pushes, intermediate] });
    const process: FakeProcess = { env: env() };
    delete process.env.KEEP;
    await load(script, { process, fetch: api.fetch, log: [] }).main();
    expect(api.deleted()).toEqual(intermediate.versions.map((v) => `DELETE ${base}/${v.id}`));
  });

  it.each([
    ["a previous image that is not a digest", { PREVIOUS: "unknown" }],
    ["no running image", { IMAGE: "" }],
  ])("deletes nothing and fails with %s", async (_, extra) => {
    const api = github({ pushes });
    const result = await runMain(api, extra);
    expect(result.exitCode).toBe(1);
    expect(api.calls).toEqual([]);
    expect(result.log).toEqual([
      "::error::OpsCrew could not tell which images the server runs, so it deleted none. The deploy itself succeeded.",
    ]);
  });

  it("deletes nothing when a manifest cannot be read", async () => {
    const api = github({ pushes, failManifest: true });
    const result = await runMain(api);
    expect(result.exitCode).toBe(1);
    expect(api.deleted()).toEqual([]);
    expect(result.log.at(-1)).toContain("could not list the images, so it deleted none");
  });

  it("reads the package again when a version goes while it reads it, then deletes as usual", async () => {
    const api = github({ pushes, goneManifests: 1 });
    const result = await runMain(api);
    expect(result.exitCode).toBeUndefined();
    expect(result.log).toContain(
      "A version went while OpsCrew read the package (HTTP 404); reading it again in 20 s.",
    );
    expect(api.deleted()).toHaveLength(9);
  });

  it("deletes nothing when a 404 stays after three reads", async () => {
    const api = github({ pushes, goneManifests: 1000 });
    const result = await runMain(api);
    expect(result.exitCode).toBe(1);
    expect(api.deleted()).toEqual([]);
    expect(result.log.at(-1)).toContain("could not list the images, so it deleted none");
  });

  it("counts a version another environment's deploy deleted first as deleted", async () => {
    const gone = a.index.id;
    const api = github({ pushes, goneDelete: [gone] });
    const result = await runMain(api);
    expect(result.exitCode).toBeUndefined();
    expect(result.log).toContain(`Already deleted: ${a.index.digest} (${commit(1)})`);
  });

  it("goes on when a deletion fails, and fails the step", async () => {
    const refused = a.index.id;
    const api = github({ pushes, failDelete: [refused] });
    const result = await runMain(api);
    expect(api.deleted()).toHaveLength(9);
    expect(result.exitCode).toBe(1);
    expect(result.log).toContain(
      `::warning::GitHub did not delete ${a.index.digest} (${commit(1)}): HTTP 403.`,
    );
    expect(result.log.at(-1)).toBe(
      "::error::1 image versions were not deleted; the next deploy tries again. The deploy itself succeeded.",
    );
  });
});

describe("the retention job", () => {
  const jobs = (plan: DeployPlan) => parse(renderWorkflow(plan, testContext()).content).jobs;

  it("runs after a healthy deploy, with only packages: write", () => {
    const prune = jobs(serverPlan()).prune;
    expect(prune.needs).toEqual(["build", "deploy"]);
    expect(prune.permissions).toEqual({ packages: "write" });
    expect(prune.steps).toHaveLength(1);
    expect(prune.steps[0].shell).toBe("node {0}");
    expect(prune.steps[0].env).toEqual({
      TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      IMAGE: "${{ needs.build.outputs.image }}",
      PREVIOUS: "${{ needs.deploy.outputs.previous }}",
      KEEP: "10",
    });
    expect(jobYaml(renderWorkflow(serverPlan(), testContext()).content, "prune")).toMatchSnapshot();
  });

  it("keeps the configured number of images", () => {
    const plan = withPlan(serverPlan(), { imageRetention: { keep: 25 } });
    expect(jobs(plan).prune.steps[0].env.KEEP).toBe("25");
  });

  it("when off, runs only to delete Buildpacks' and Railpack's intermediate images", () => {
    const off = withPlan(serverPlan(), { imageRetention: { enabled: false } });
    expect(jobs(off).prune).toBeUndefined();
    expect(Object.keys(jobs(withBuild(off, "own-dockerfile")))).toEqual([
      "build",
      "deploy",
      "label",
    ]);
    for (const builder of ["buildpacks", "railpack"] as const) {
      const prune = jobs(withBuild(off, builder)).prune;
      expect(prune.steps[0].name).toBe("Delete the intermediate build images");
      expect(prune.steps[0].env.KEEP).toBeUndefined();
    }
    const railpack = renderWorkflow(withBuild(off, "railpack"), testContext()).content;
    expect(jobYaml(railpack, "prune")).toMatchSnapshot();
  });
});
