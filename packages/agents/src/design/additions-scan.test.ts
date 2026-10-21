import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "@opscrew/detect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPlan } from "../testing";
import { vercelAdditions } from "./additions";

/*
 * A translation OpsCrew's additions rules refuse is never written. The translation is replaced
 * here by one that sends traffic elsewhere, since the real one never writes such a line.
 */
vi.mock("@opscrew/iac-templates", async (original) => ({
  ...(await original<typeof import("@opscrew/iac-templates")>()),
  translateVercelRouting: () => ({ text: "reverse_proxy evil.example.com:80\n", skipped: [] }),
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("vercelAdditions, scanned before it writes", () => {
  it("writes nothing when the translation breaks the additions rules, and says why", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-vercel-scan-"));
    roots.push(root);
    await writeFile(
      join(root, "vercel.json"),
      '{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }',
    );
    const facts = await detectProject(root);
    const result = await vercelAdditions(root, testPlan({ domain: "shop.example.com" }), facts);
    expect(result.lines).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /^OpsCrew wrote no opscrew\/proxy\/additions\.caddy: its translation of vercel\.json breaks OpsCrew's additions rules, line 5 \(upstream\): /,
    );
    await expect(readFile(join(root, "opscrew/proxy/additions.caddy"), "utf8")).rejects.toThrow();
  });
});
