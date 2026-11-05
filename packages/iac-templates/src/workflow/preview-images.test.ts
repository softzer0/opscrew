import { describe, expect, it } from "vitest";
import { previewPlan } from "../previews/__fixtures__/plans";
import {
  commit,
  digest,
  type FakeProcess,
  ids,
  load,
  push,
  registry,
  type Version,
  version,
} from "./__fixtures__/registry";
import { previewImagesScript } from "./preview-images";

type PreviewPrunable = (
  versions: Version[],
  children: Record<string, string[]>,
  open: number[],
  number: number,
  running: string | null,
) => number[];

const program = (fakes: Parameters<typeof load>[2] = {}) =>
  load<PreviewPrunable>(previewImagesScript(previewPlan()), "previewPrunable", fakes);

describe("previewPrunable", () => {
  const previewPrunable = program().select;
  const pr = (n: number, c: number) => `pr-${n}-${commit(c)}`;
  const prod = push("a", 0, [commit(1), "opscrew-prod"]);
  const closed = push("b", 0, [pr(5, 1)]);
  const closedBuild = version(digest("b3"), [`build-${pr(5, 1)}`]);
  const older = push("c", 0, [pr(7, 1)]);
  const running = push("d", 0, [pr(7, 2)]);
  const ownBuild = version(digest("d3"), [`build-${pr(7, 2)}`]);
  const other = push("e", 0, [pr(9, 1)]);
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

  const env = (extra: Record<string, string> = {}) => ({
    TOKEN: "token-placeholder",
    GITHUB_REPOSITORY: "Acme/Shop",
    GITHUB_ACTOR: "octocat",
    NUMBER: "7",
    RUNNING,
    ...extra,
  });

  it("reads the versions before the open pull requests, then deletes what it selects", async () => {
    const closed = push("b", 0, [`pr-5-${commit(1)}`]);
    const running = push("d", 0, [`pr-7-${commit(2)}`]);
    const api = registry({ pushes: [closed, running], open: [7] });
    const log: string[] = [];
    const process: FakeProcess = { env: env() };
    await program({ process, fetch: api.fetch, log }).main();
    expect(process.exitCode).toBeUndefined();
    const versionsAt = api.calls.indexOf(`GET ${base}?per_page=100&page=1`);
    const pullsAt = api.calls.findIndex((c) => c.includes("/pulls?state=open"));
    expect(versionsAt).toBeGreaterThanOrEqual(0);
    expect(pullsAt).toBeGreaterThan(versionsAt);
    expect(api.deleted().sort()).toEqual(
      closed.versions.map((v) => `DELETE ${base}/${v.id}`).sort(),
    );
    expect(log).toContain(`Deleted ${closed.index.digest} (pr-5-${commit(1)})`);
  });

  it.each([
    ["no pull request number", { NUMBER: "" }],
    ["a number that is not one", { NUMBER: "7;" }],
    ["a running image that is not a digest", { RUNNING: "ghcr.io/acme/shop:latest" }],
  ])("deletes nothing with %s", async (_, extra) => {
    const api = registry({ pushes: [] });
    const log: string[] = [];
    const process: FakeProcess = { env: env(extra) };
    await program({ process, fetch: api.fetch, log }).main();
    expect(process.exitCode).toBe(1);
    expect(api.calls).toEqual([]);
    expect(log).toEqual([
      "::error::OpsCrew could not tell which pull request or image this run is about, so it deleted no image.",
    ]);
  });
});
