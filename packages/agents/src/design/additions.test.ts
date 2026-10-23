import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "@opscrew/detect";
import { additionsPath, EDGE_PROXIES, type EdgeProxy, siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { scanProxyAdditions } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { portainerPlan, testPlan } from "../testing";
import { vercelAdditions } from "./additions";

/** detect's `vercel.json` fixtures (T1417a). */
const FIXTURES = new URL("../../../detect/src/__fixtures__/vercel-routing/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A repository with `vercel.json`, and the facts detect reads from it. */
async function repo(vercelJson: string) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-vercel-"));
  roots.push(root);
  await writeFile(join(root, "vercel.json"), vercelJson);
  return { root, facts: await detectProject(root) };
}

function plan(proxy: EdgeProxy): DeployPlan {
  const base = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({ ...base, target: { ...base.target, edge: proxy } });
}

const SKIPPED_ROUTES =
  "Not translated from vercel.json: routes, because `routes` uses Vercel's PCRE form, which OpsCrew does not translate yet; write these rules as `redirects`, `rewrites` and `headers` instead.";

describe.each(["caddy", "nginx"] as const)("vercelAdditions on %s", (proxy) => {
  const file = additionsPath(plan(proxy));
  const label = EDGE_PROXIES[proxy].label;

  it.each(["vite-spa.json", "static-site.json", "malformed.json"])(
    "writes %s's rules once, with the file's hash, and they pass OpsCrew's additions rules",
    async (name) => {
      const { root, facts } = await repo(await fixture(name));
      const p = plan(proxy);
      const result = await vercelAdditions(root, p, facts);
      expect(result.warnings).toEqual([]);
      expect(result.lines[0]).toBe(
        `Wrote ${file}: vercel.json's routing rules for ${label}, in Vercel's order. The file is yours to edit from now on.`,
      );
      const text = await readFile(join(root, file), "utf8");
      expect(text.split("\n")[0]).toBe(
        `# Translated by OpsCrew from vercel.json (SHA-256 ${facts.platformRouting?.sha256}) for ${label}.`,
      );
      const ctx = { proxy, hostnames: siteHosts(p), upstream: EDGE_PROXIES[proxy].upstream };
      expect(scanProxyAdditions(text, ctx)).toEqual([]);
      // Every rule detect left out is listed with its reason.
      for (const entry of facts.platformRouting?.unsupported ?? []) {
        const rule =
          entry.index === undefined ? entry.property : `${entry.property}[${entry.index}]`;
        expect(result.lines).toContain(
          `Not translated from vercel.json: ${rule}, because ${entry.reason}.`,
        );
      }
    },
  );

  it("writes nothing when no rule can be translated, and says why", async () => {
    const { root, facts } = await repo(await fixture("routes.json"));
    const result = await vercelAdditions(root, plan(proxy), facts);
    expect(result).toEqual({
      lines: [
        `None of vercel.json's routing rules can be written for ${label}, so OpsCrew wrote no ${file}.`,
        SKIPPED_ROUTES,
      ],
      warnings: [],
    });
    await expect(readFile(join(root, file), "utf8")).rejects.toThrow();
  });

  it("never overwrites the file, and says when vercel.json changed since its translation", async () => {
    const original = await fixture("vite-spa.json");
    const { root, facts } = await repo(original);
    await vercelAdditions(root, plan(proxy), facts);
    const written = await readFile(join(root, file), "utf8");

    // The same vercel.json, also with a BOM (detect hashes the text without it): nothing to say.
    expect(await vercelAdditions(root, plan(proxy), facts)).toEqual({ lines: [], warnings: [] });
    await writeFile(join(root, "vercel.json"), `${String.fromCharCode(0xfeff)}${original}`);
    expect(await vercelAdditions(root, plan(proxy), facts)).toEqual({ lines: [], warnings: [] });

    await writeFile(join(root, "vercel.json"), original.replace("/index.html", "/app.html"));
    expect(await vercelAdditions(root, plan(proxy), facts)).toEqual({
      lines: [],
      warnings: [
        `vercel.json has changed since OpsCrew translated its routing rules into ${file}, and OpsCrew does not change that file. Update it by hand, or delete it and run \`opscrew design\` again to translate the new rules.`,
      ],
    });
    expect(await readFile(join(root, file), "utf8")).toBe(written);
  });

  it("leaves the user's own additions alone", async () => {
    const { root, facts } = await repo(await fixture("static-site.json"));
    const own = "# mine\n";
    await vercelAdditions(root, plan(proxy), facts);
    await writeFile(join(root, file), own);
    expect(await vercelAdditions(root, plan(proxy), facts)).toEqual({ lines: [], warnings: [] });
    expect(await readFile(join(root, file), "utf8")).toBe(own);
  });
});

describe("vercelAdditions", () => {
  it("writes nothing for a Portainer stack, which has no server edge", async () => {
    const { root, facts } = await repo(await fixture("vite-spa.json"));
    expect(await vercelAdditions(root, portainerPlan(), facts)).toEqual({
      lines: [],
      warnings: [],
    });
  });

  it("writes nothing without routing rules", async () => {
    const { root, facts } = await repo("{}");
    expect(facts.platformRouting).toBeUndefined();
    expect(await vercelAdditions(root, plan("caddy"), facts)).toEqual({ lines: [], warnings: [] });
  });
});
