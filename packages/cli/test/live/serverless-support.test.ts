/** Offline checks of the server-less live tests' pure helpers (`serverless-support.ts`). No network. */
import { describe, expect, it } from "vitest";
import { cloudflareLeft } from "./cloud";
import {
  missingHeaders,
  pagesRemovalBlocker,
  pagesStandIn,
  pointsAtGitHub,
  redirectProblem,
  renderedAt,
  secretDigest,
  servingVersion,
  statusVersions,
  takeoverWindow,
  versionBuild,
} from "./serverless-support";

const SHA = "a".repeat(64);
const HOST = "e2e-abc.example.com";

describe("the server-less live tests' helpers", () => {
  it("names the OpsCrew headers an answer lacks, and a wrong nosniff", () => {
    const all = {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
    };
    expect(missingHeaders(all)).toEqual([]);
    expect(missingHeaders({ ...all, "referrer-policy": undefined })).toEqual(["referrer-policy"]);
    expect(missingHeaders({ ...all, "x-content-type-options": "sniff" })).toEqual([
      "x-content-type-options",
    ]);
    expect(missingHeaders({})).toHaveLength(4);
  });

  it("reads the running version and the rollback's version from opscrew status", () => {
    const output = [
      "Cloudflare hosting, the Worker static-vite-demo (read from Cloudflare now):",
      "  Running: version 2f0c-new, deployed 2026-10-24 10:01 UTC, built by https://github.com/o/r/actions/runs/102",
      "  Before it: version 1e0b-old, deployed 2026-10-24 09:01 UTC, built by https://github.com/o/r/actions/runs/101",
      "  Roll back to it: opscrew promote --to prod --version 1e0b-old",
    ].join("\n");
    expect(statusVersions(output)).toEqual({ running: "2f0c-new", rollback: "1e0b-old" });
    expect(
      statusVersions("  Roll back to it: opscrew promote --app docs --to prod --version 201\r\n"),
    ).toEqual({ rollback: "201" });
    expect(statusVersions("  Running: nothing deployed yet")).toEqual({});
  });

  it("reads the run and the build a version's message names, and nothing else", () => {
    expect(versionBuild(`opscrew 4711 ${SHA}`)).toEqual({ runId: 4711, sha256: SHA });
    expect(versionBuild(` opscrew 4711 ${SHA}\n`)).toEqual({ runId: 4711, sha256: SHA });
    expect(versionBuild(`opscrew rollback ${SHA}`)).toBeUndefined();
    expect(versionBuild("")).toBeUndefined();
  });

  it("picks the version the latest deployment serves", () => {
    expect(
      servingVersion([
        {
          versions: [
            { id: "small", percentage: 10 },
            { id: "big", percentage: 90 },
          ],
        },
        { versions: [{ id: "old", percentage: 100 }] },
      ]),
    ).toBe("big");
    expect(servingVersion([])).toBeUndefined();
  });

  it("reads the SSR example's render time and the secret page's digest", () => {
    expect(renderedAt("<p>Rendered on the server at 2026-10-24T10:00:00.123Z.</p>")).toBe(
      "2026-10-24T10:00:00.123Z",
    );
    expect(renderedAt("<p>Hello</p>")).toBeUndefined();
    expect(secretDigest(`<p>The secret's SHA-256: ${SHA}</p>`)).toBe(SHA);
    expect(secretDigest("<p>The secret's SHA-256: not set</p>")).toBe("not set");
    expect(secretDigest("<p>nothing</p>")).toBeUndefined();
  });

  it("accepts only a 301 to the expected address", () => {
    const to = `https://${HOST}/a/b?q=1`;
    expect(redirectProblem({ status: 301, headers: { location: to } }, to)).toBeUndefined();
    expect(redirectProblem({ status: 302, headers: { location: to } }, to)).toContain("302");
    expect(redirectProblem({ status: 301, headers: {} }, to)).toContain("nowhere");
  });

  it("knows the records that send a name to GitHub Pages", () => {
    expect(pointsAtGitHub({ type: "CNAME", content: "owner.github.io" })).toBe(true);
    expect(pointsAtGitHub({ type: "CNAME", content: "Owner.GitHub.io." })).toBe(true);
    expect(pointsAtGitHub({ type: "A", content: "185.199.110.153" })).toBe(true);
    expect(pointsAtGitHub({ type: "AAAA", content: "2606:50c0:8003::153" })).toBe(true);
    expect(pointsAtGitHub({ type: "A", content: "192.0.2.1" })).toBe(false);
    expect(pointsAtGitHub({ type: "TXT", content: "owner.github.io" })).toBe(false);
  });

  it("finds a record pointing at GitHub while no Pages site claims the name (SC-1605)", () => {
    const cname = { type: "CNAME", name: HOST, content: "owner.github.io" };
    const txt = { type: "TXT", name: `_github-pages-challenge-owner.${HOST}`, content: '"x"' };
    // Claimed: the safe states of a destroy, before and after the records go.
    expect(takeoverWindow(HOST, { cname: HOST }, [cname])).toBeUndefined();
    expect(takeoverWindow(HOST, { cname: null }, [txt])).toBeUndefined();
    expect(takeoverWindow(HOST, undefined, [])).toBeUndefined();
    // The window.
    expect(takeoverWindow(HOST, { cname: null }, [cname])).toContain("did not claim it");
    expect(takeoverWindow(HOST, undefined, [cname, txt])).toContain("GitHub Pages was off");
    expect(takeoverWindow(HOST, { cname: "other.example.com" }, [cname])).toContain(
      "a CNAME record",
    );
  });

  it("keeps a Pages site while a record of the run still points at GitHub", () => {
    const cname = { type: "CNAME", name: HOST, content: "owner.github.io" };
    const other = { type: "CNAME", name: "users-own.example.com", content: "owner.github.io" };
    const txt = { type: "TXT", name: `_github-pages-challenge-owner.${HOST}`, content: '"x"' };
    expect(pagesRemovalBlocker([HOST], [cname, txt])).toContain(`a record on ${HOST}`);
    expect(pagesRemovalBlocker([HOST], [cname, cname])).toBe(
      `kept the GitHub Pages site: a record on ${HOST} still points at GitHub; delete it, then turn Pages off in the repository's Settings → Pages`,
    );
    // Records off the run's hostnames are not the run's; a TXT record points nowhere.
    expect(pagesRemovalBlocker([HOST], [other, txt])).toBeUndefined();
    expect(pagesRemovalBlocker([HOST], [])).toBeUndefined();
  });

  it("counts a site's Workers made in the run and every custom domain on its hostnames as left", () => {
    const empty = { records: [], tunnels: [], apps: [], policies: [], serviceTokens: [] };
    const before = {
      ...empty,
      workers: [{ id: "users-own", name: "users-own" }],
      customDomains: [],
    };
    const now = {
      ...empty,
      workers: [
        { id: "users-own", name: "users-own" },
        { id: "static-vite-demo", name: "static-vite-demo" },
      ],
      customDomains: [{ id: "d-1", name: HOST }],
    };
    expect(cloudflareLeft(now, before)).toMatchObject({
      workers: ["static-vite-demo"],
      customDomains: [HOST],
    });
    expect(cloudflareLeft(before, before)).toMatchObject({ workers: [], customDomains: [] });
  });

  it("makes a stand-in verification value of letters and digits", () => {
    expect(pagesStandIn("mh3k2a-9F00")).toBe("opscrewe2emh3k2a9f00");
    expect(pagesStandIn("abc")).toMatch(/^[A-Za-z0-9]+$/);
  });
});
