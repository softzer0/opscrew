import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SiteDetection } from "@opscrew/detect";
import { describe, expect, it } from "vitest";
import { fakeNpmRegistry } from "./__fixtures__/npm-registry";
import { cloudflareAdapterEdit, nextWorkersOptionsEdit } from "./cloudflare-adapter";
import { CLOUDFLARE_PLAYBOOKS } from "./playbooks";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-adapter-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** A server-rendered site whose Cloudflare adapter for `framework` is missing. */
function ssrSite(
  framework: "astro" | "next" | "nuxt" | "sveltekit",
  config?: string,
  dir = ".",
): SiteDetection {
  return {
    dir,
    tool: "node",
    packageManager: "npm",
    render: "ssr",
    framework,
    ...(config === undefined ? {} : { config }),
    adapter: { framework, name: "", installed: false, entry: "", compatibilityFlags: [] },
    spa: false,
    serverNeeds: [],
  };
}

const ASTRO_PACKAGE = `${JSON.stringify({ dependencies: { astro: "^7.4.1" } }, null, 2)}\n`;

describe("cloudflareAdapterEdit", () => {
  it("adds adapter: cloudflare() to an Astro config with no adapter, and its import", async () => {
    const root = await project({
      "package.json": ASTRO_PACKAGE,
      "astro.config.mjs":
        "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  output: 'server',\n});\n",
    });
    const edit = await cloudflareAdapterEdit(
      root,
      ssrSite("astro", "astro.config.mjs"),
      fakeNpmRegistry().fetch,
    );
    expect(edit).toMatchObject({ action: "write", path: "astro.config.mjs", packageJson: true });
    if (edit.action !== "write") return;
    expect(edit.files[0]?.content).toBe(
      "import cloudflare from '@astrojs/cloudflare';\nimport { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  adapter: cloudflare(),\n  output: 'server',\n});\n",
    );
    // astro ^7.4.1 allows the newest release, so no upgrade is named.
    expect(edit.note).toContain(
      "added @astrojs/cloudflare 14.4.2, its newest release for astro 7.4.1, wrangler",
    );
    expect(edit.note).not.toContain("upgrade");
  });

  it("keeps CRLF line endings and a package.json's tab indentation", async () => {
    const root = await project({
      "web/package.json": '{\n\t"dependencies": {\n\t\t"astro": "7.4.1"\n\t}\n}\n',
      "web/astro.config.mjs":
        "import { defineConfig } from 'astro/config';\r\nimport node from '@astrojs/node';\r\n\r\nexport default defineConfig({\r\n  adapter: node({ mode: 'standalone' }),\r\n});\r\n",
    });
    const edit = await cloudflareAdapterEdit(
      root,
      ssrSite("astro", "web/astro.config.mjs", "web"),
      fakeNpmRegistry().fetch,
    );
    if (edit.action !== "write") throw new Error(JSON.stringify(edit));
    expect(edit.files.map((file) => file.path)).toEqual([
      "web/astro.config.mjs",
      "web/package.json",
    ]);
    expect(edit.files[0]?.content).toBe(
      "import { defineConfig } from 'astro/config';\r\nimport cloudflare from '@astrojs/cloudflare';\r\n\r\nexport default defineConfig({\r\n  adapter: cloudflare(),\r\n});\r\n",
    );
    expect(edit.files[1]?.content).toBe(
      '{\n\t"dependencies": {\n\t\t"@astrojs/cloudflare": "14.4.2",\n\t\t"astro": "7.4.1"\n\t},\n\t"devDependencies": {\n\t\t"wrangler": "' +
        edit.files[1]?.content.match(/"wrangler": "([^"]+)"/)?.[1] +
        '"\n\t}\n}\n',
    );
  });

  it("leaves unusual configs to the Code-change agent or the user, naming the release to pin", async () => {
    const cases: [SiteDetection, Record<string, string>, string][] = [
      [
        ssrSite("astro", "astro.config.mjs"),
        {
          "package.json": ASTRO_PACKAGE,
          "astro.config.mjs":
            "import vercel from '@astrojs/vercel';\nconst adapter = vercel();\nexport default { adapter, integrations: [vercel] };\n",
        },
        "astro.config.mjs does not call vercel(…) exactly once, so OpsCrew did not replace @astrojs/vercel. Add @astrojs/cloudflare 14.4.2, its newest release for astro 7.4.1.",
      ],
      [
        ssrSite("astro", "astro.config.mjs"),
        { "package.json": ASTRO_PACKAGE, "astro.config.mjs": "export default config;\n" },
        "astro.config.mjs does not call defineConfig({ … }) with a plain object. Add @astrojs/cloudflare 14.4.2, its newest release for astro 7.4.1.",
      ],
      [
        ssrSite("nuxt", "nuxt.config.ts"),
        {
          "nuxt.config.ts":
            "export default defineNuxtConfig({ nitro: { compressPublicAssets: true } })\n",
        },
        'nuxt.config.ts already has a nitro block; set nitro.preset to "cloudflare_module" in it.',
      ],
      [
        ssrSite("sveltekit"),
        { "package.json": '{ "devDependencies": { "@sveltejs/kit": "^3.0.0" } }\n' },
        "OpsCrew found no SvelteKit config for the app. Add @sveltejs/adapter-cloudflare 8.0.1, its newest release for @sveltejs/kit 3.0.0.",
      ],
      [
        ssrSite("next"),
        { "package.json": '{ "dependencies": { "next": "latest" } }\n' },
        'package.json gives next as "latest", so OpsCrew cannot tell which release of @opennextjs/cloudflare supports it.',
      ],
    ];
    for (const [site, files, reason] of cases) {
      const root = await project(files);
      expect(await cloudflareAdapterEdit(root, site, fakeNpmRegistry().fetch)).toEqual({
        action: "manual",
        reason,
      });
    }
  });

  it("ignores .open-next/ for Next.js once, creating the .gitignore when missing", async () => {
    const pkg = '{ "dependencies": { "next": "16.4.2" } }\n';
    const paths = async (files: Record<string, string>) => {
      const edit = await cloudflareAdapterEdit(
        await project(files),
        ssrSite("next"),
        fakeNpmRegistry().fetch,
      );
      if (edit.action !== "write") throw new Error(JSON.stringify(edit));
      return edit;
    };
    const missing = await paths({ "package.json": pkg });
    expect(missing.files.find((file) => file.path === ".gitignore")).toEqual({
      path: ".gitignore",
      content: ".open-next/\n",
      created: true,
    });
    const appended = await paths({ "package.json": pkg, ".gitignore": "node_modules/\r\n.next" });
    expect(appended.files.find((file) => file.path === ".gitignore")?.content).toBe(
      "node_modules/\r\n.next\r\n.open-next/\r\n",
    );
    const ignored = await paths({
      "package.json": pkg,
      ".gitignore": "node_modules\n/.open-next\n",
    });
    expect(ignored.files.map((file) => file.path)).toEqual(["package.json", "open-next.config.ts"]);
    expect(ignored.note).not.toContain(".gitignore");
  });

  it("proposes no adapter for a framework outside the four", async () => {
    const root = await project({ "package.json": "{}" });
    const site: SiteDetection = { ...ssrSite("astro"), framework: "react-router" };
    delete site.adapter;
    const registry = fakeNpmRegistry();
    expect(await cloudflareAdapterEdit(root, site, registry.fetch)).toEqual({
      action: "manual",
      reason: "OpsCrew found no Cloudflare adapter for the app.",
    });
    expect(registry.urls).toEqual([]);
  });

  it("has a playbook for each of the four adapters", () => {
    expect(Object.keys(CLOUDFLARE_PLAYBOOKS).sort()).toEqual([
      "astro",
      "next",
      "nuxt",
      "sveltekit",
    ]);
    expect(CLOUDFLARE_PLAYBOOKS.next.steps["build-config"]).toContain(
      "Never run `opennextjs-cloudflare migrate`",
    );
  });

  it("names only installs that run no package's scripts", () => {
    for (const playbook of Object.values(CLOUDFLARE_PLAYBOOKS)) {
      const text = [...playbook.guidance, ...Object.values(playbook.steps)].join("\n");
      expect(playbook.guidance.join("\n"), playbook.id).toContain("--ignore-scripts");
      const installs = text.match(/\b(?:npm|pnpm|yarn|bun) install\b[^`]*/g) ?? [];
      expect(installs.length, playbook.id).toBeGreaterThan(0);
      for (const install of installs) {
        expect(install, playbook.id).toMatch(/--ignore-scripts|--mode update-lockfile/);
      }
    }
  });
});

describe("nextWorkersOptionsEdit", () => {
  it("turns off only the options the config turns on", async () => {
    const root = await project({
      "next.config.mjs":
        "export default {\n  cacheComponents: true,\n  reactStrictMode: true,\n};\n",
    });
    expect(
      await nextWorkersOptionsEdit(root, "next.config.mjs", [
        "cacheComponents",
        "partialPrefetching",
      ]),
    ).toEqual({
      action: "write",
      files: [
        {
          path: "next.config.mjs",
          content: "export default {\n  cacheComponents: false,\n  reactStrictMode: true,\n};\n",
          created: false,
        },
      ],
      path: "next.config.mjs",
      packageJson: false,
      note: "OpsCrew set cacheComponents: false in next.config.mjs, so server-rendered requests do not hang on Cloudflare's Workers.",
    });
    const off = await project({
      "next.config.mjs": "export default { cacheComponents: false };\n",
    });
    expect(await nextWorkersOptionsEdit(off, "next.config.mjs", ["cacheComponents"])).toEqual({
      action: "none",
      reason: "next.config.mjs does not turn on cacheComponents.",
    });
  });
});
