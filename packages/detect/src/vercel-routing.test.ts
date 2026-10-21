import { readFile } from "node:fs/promises";
import { sha256Hex } from "@opscrew/core";
import { PlatformRoutingSchema, type ProjectFacts } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";
import { vercelRouting } from "./vercel-routing";

const FIXTURES = new URL("./__fixtures__/vercel-routing/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

const CONDITION = "it has a `has` or `missing` condition, which OpsCrew does not translate yet";

describe("vercelRouting", () => {
  it("reads a Vite SPA's catch-all rewrite, with the file's hash", async () => {
    const text = await fixture("vite-spa.json");
    expect(vercelRouting(text)).toEqual({
      source: "vercel.json",
      sha256: sha256Hex(text),
      redirects: [],
      rewrites: [{ index: 0, source: "/(.*)", destination: "/index.html" }],
      headers: [],
      unsupported: [],
    });
  });

  it("reads a static site's redirects, headers, cleanUrls and trailingSlash", async () => {
    const routing = vercelRouting(await fixture("static-site.json"));
    expect(routing).toMatchObject({
      redirects: [
        { index: 0, source: "/old-blog/:slug", destination: "/blog/:slug", statusCode: 308 },
        { index: 1, source: "/beta", destination: "/", statusCode: 307 },
        {
          index: 2,
          source: "^/articles/(\\d{4})/(.+)$",
          destination: "/posts/$1/$2",
          statusCode: 301,
        },
        {
          index: 4,
          source: "/docs/:path*",
          destination: "https://docs.example.com/:path*",
          statusCode: 302,
        },
        { index: 5, source: "/pricing", destination: "/plans", statusCode: 308 },
      ],
      rewrites: [],
      headers: [
        {
          index: 0,
          source: "/assets/(.*)",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
        {
          index: 2,
          source: "/:path((?!api/).*)",
          headers: [{ key: "X-Frame-Options", value: "DENY" }],
        },
      ],
      cleanUrls: true,
      trailingSlash: false,
      unsupported: [
        { property: "redirects", index: 3, reason: CONDITION },
        { property: "headers", index: 1, reason: CONDITION },
      ],
    });
    expect(PlatformRoutingSchema.parse(routing)).toEqual(routing);
  });

  it("lists the routes property as not translated", async () => {
    const routing = vercelRouting(await fixture("routes.json"));
    expect(routing).toMatchObject({ redirects: [], rewrites: [], headers: [] });
    expect(routing?.unsupported).toEqual([
      {
        property: "routes",
        reason:
          "`routes` uses Vercel's PCRE form, which OpsCrew does not translate yet; write these rules as `redirects`, `rewrites` and `headers` instead",
      },
    ]);
  });

  it("lists malformed rules with the reason and keeps the valid ones", async () => {
    const routing = vercelRouting(await fixture("malformed.json"));
    expect(routing?.redirects).toEqual([
      { index: 6, source: "/ok", destination: "/fine", statusCode: 303 },
    ]);
    expect(routing?.rewrites).toEqual([]);
    expect(routing?.headers).toEqual([]);
    expect(routing?.cleanUrls).toBeUndefined();
    expect(routing?.unsupported).toEqual([
      { property: "redirects", index: 0, reason: "it is not an object" },
      {
        property: "redirects",
        index: 1,
        reason: "it sets both `statusCode` and `permanent`, which Vercel does not allow",
      },
      {
        property: "redirects",
        index: 2,
        reason: "its `statusCode` must be 301, 302, 303, 307 or 308",
      },
      { property: "redirects", index: 3, reason: "it has no `destination`" },
      {
        property: "redirects",
        index: 4,
        reason: "its `source` must start with `/` (a path pattern) or `^` (a regular expression)",
      },
      { property: "redirects", index: 5, reason: "its `permanent` must be true or false" },
      { property: "rewrites", reason: "it must be a list of rules" },
      {
        property: "headers",
        index: 0,
        reason: "its `headers` must be a list of `{ key, value }` pairs",
      },
      {
        property: "headers",
        index: 1,
        reason: "its `headers` must be a list of `{ key, value }` pairs",
      },
      { property: "cleanUrls", reason: "it must be true or false" },
    ]);
    expect(PlatformRoutingSchema.parse(routing)).toEqual(routing);
  });

  it("sets nothing when the file has no routing rules or is not JSON", () => {
    expect(vercelRouting(undefined)).toBeUndefined();
    expect(vercelRouting("{ not json")).toBeUndefined();
    expect(vercelRouting(JSON.stringify({ crons: [] }))).toBeUndefined();
    expect(vercelRouting(JSON.stringify({ redirects: [], headers: [] }))).toBeUndefined();
  });
});

describe("detect", () => {
  const roots: string[] = [];
  async function detect(files: Record<string, string>): Promise<ProjectFacts> {
    const root = await makeTree(files, "vercel-routing");
    roots.push(root);
    return detectProject(root);
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removeTree));
  });

  it("records platformRouting from vercel.json next to its crons", async () => {
    const vercelJson = await fixture("static-site.json");
    const facts = await detect({
      "package.json": JSON.stringify({ name: "site", dependencies: { next: "^15" } }),
      "vercel.json": vercelJson,
    });
    expect(facts.platformRouting).toEqual(vercelRouting(vercelJson));
    expect(facts.platformRouting?.sha256).toBe(sha256Hex(vercelJson));
    expect(facts.cronJobs).toHaveLength(1);
  });

  it("leaves platformRouting out without routing rules", async () => {
    const facts = await detect({
      "package.json": JSON.stringify({ name: "site", dependencies: { next: "^15" } }),
      "vercel.json": JSON.stringify({ crons: [{ path: "/api/cron", schedule: "0 8 * * *" }] }),
    });
    expect(facts.platformRouting).toBeUndefined();
    expect("platformRouting" in facts).toBe(false);
  });
});
