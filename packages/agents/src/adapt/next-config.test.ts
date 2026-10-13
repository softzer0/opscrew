import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isNextConfigPath,
  nextBasePath,
  type StandaloneEdit,
  standaloneConfigEdit,
} from "./next-config";

describe("nextBasePath", () => {
  it("reads a literal basePath from the shapes OpsCrew edits", () => {
    expect(nextBasePath("next.config.js", "module.exports = {basePath: '/docs'}\n")).toEqual({
      kind: "literal",
      value: "/docs",
    });
    expect(
      nextBasePath(
        "next.config.ts",
        'const nextConfig: NextConfig = {\r\n  output: "standalone",\r\n  basePath: "/app",\r\n};\r\nexport default nextConfig;\r\n',
      ),
    ).toEqual({ kind: "literal", value: "/app" });
  });

  it("is none without a top-level basePath, or with an empty one", () => {
    expect(nextBasePath("next.config.mjs", "export default {};\n")).toEqual({ kind: "none" });
    expect(nextBasePath("next.config.mjs", 'export default { basePath: "" };\n')).toEqual({
      kind: "none",
    });
    expect(
      nextBasePath(
        "next.config.mjs",
        "/* basePath */\nexport default { images: { basePath: 1 } };\n",
      ),
    ).toEqual({ kind: "none" });
  });

  it("is unknown when the value or the config cannot be read with certainty", () => {
    for (const content of [
      "export default { basePath: process.env.BASE_PATH };\n",
      "const basePath = '/x';\nexport default { basePath };\n",
      "export default () => ({ basePath: '/x' });\n",
      "const base = { basePath: '/x' };\nexport default { ...base };\n",
    ]) {
      expect(nextBasePath("next.config.mjs", content)).toEqual({ kind: "unknown" });
    }
  });
});

const edit = (path: string, content: string | undefined, tracingRoot?: string) =>
  standaloneConfigEdit({ path, content, ...(tracingRoot === undefined ? {} : { tracingRoot }) });

function written(result: StandaloneEdit): string {
  if (result.action !== "write") throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  return result.content;
}

/** Fails when `node --check` rejects the file (syntax only; nothing is executed). */
async function expectValidSyntax(name: string, content: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-next-config-"));
  const file = join(dir, name);
  await writeFile(file, content);
  expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
}

describe("isNextConfigPath", () => {
  it("matches the Next.js config file names in any folder", () => {
    for (const path of ["next.config.js", "next.config.mjs", "apps/web/next.config.ts"]) {
      expect(isNextConfigPath(path)).toBe(true);
    }
    expect(isNextConfigPath("apps/web/next.config.cjs")).toBe(true);
    expect(isNextConfigPath("settings.py")).toBe(false);
    expect(isNextConfigPath("my-next.config.js")).toBe(false);
  });
});

describe("standaloneConfigEdit: shapes OpsCrew edits", () => {
  it("create-next-app JavaScript (JSDoc type, empty object, export default)", async () => {
    const before =
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n";
    const result = edit("next.config.mjs", before);
    expect(result).toMatchObject({ action: "write", created: false });
    const after = written(result);
    expect(after).toBe(
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  output: \"standalone\",\n};\n\nexport default nextConfig;\n",
    );
    await expectValidSyntax("next.config.mjs", after);
  });

  it("create-next-app TypeScript (NextConfig annotation, placeholder comment)", () => {
    const before = [
      'import type { NextConfig } from "next";',
      "",
      "const nextConfig: NextConfig = {",
      "  /* config options here */",
      "};",
      "",
      "export default nextConfig;",
      "",
    ].join("\n");
    expect(written(edit("next.config.ts", before))).toBe(
      [
        'import type { NextConfig } from "next";',
        "",
        "const nextConfig: NextConfig = {",
        '  output: "standalone",',
        "  /* config options here */",
        "};",
        "",
        "export default nextConfig;",
        "",
      ].join("\n"),
    );
  });

  it("TypeScript with `satisfies NextConfig`", () => {
    const before =
      "const config = {\n  reactStrictMode: true,\n} satisfies NextConfig;\nexport default config;\n";
    expect(written(edit("next.config.ts", before))).toBe(
      'const config = {\n  output: "standalone",\n  reactStrictMode: true,\n} satisfies NextConfig;\nexport default config;\n',
    );
  });

  it("CommonJS: const nextConfig with module.exports = nextConfig", async () => {
    const before =
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  reactStrictMode: true,\n}\n\nmodule.exports = nextConfig\n";
    const after = written(edit("next.config.js", before));
    expect(after).toBe(
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  output: \"standalone\",\n  reactStrictMode: true,\n}\n\nmodule.exports = nextConfig\n",
    );
    await expectValidSyntax("next.config.cjs", after);
  });

  it("CommonJS: module.exports = { … } with four-space indentation", async () => {
    const before =
      'module.exports = {\n    images: {\n        remotePatterns: [{ hostname: "cdn.example.com" }],\n    },\n};\n';
    const after = written(edit("next.config.cjs", before));
    expect(after).toBe(
      'module.exports = {\n    output: "standalone",\n    images: {\n        remotePatterns: [{ hostname: "cdn.example.com" }],\n    },\n};\n',
    );
    await expectValidSyntax("next.config.cjs", after);
  });

  it("ESM: export default { … }", async () => {
    const before = "export default {\n\tpoweredByHeader: false,\n};\n";
    const after = written(edit("next.config.mjs", before));
    expect(after).toBe(
      'export default {\n\toutput: "standalone",\n\tpoweredByHeader: false,\n};\n',
    );
    await expectValidSyntax("next.config.mjs", after);
  });

  it("a one-line object keeps its style, including single quotes", () => {
    expect(
      written(
        edit(
          "next.config.mjs",
          "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n",
        ),
      ),
    ).toBe(
      'const nextConfig = { output: "standalone", reactStrictMode: true };\nexport default nextConfig;\n',
    );
    expect(written(edit("next.config.js", "module.exports = {basePath: '/docs'}\n"))).toBe(
      "module.exports = {output: 'standalone', basePath: '/docs'}\n",
    );
  });

  it("ignores nested keys, strings and comments that look like code", async () => {
    const before = [
      "const nextConfig = { // keep this comment",
      "  experimental: { output: 1 },",
      '  async headers() { return [{ source: "/{path}", headers: [{ key: "x", value: "}" }] }]; },',
      "  /* output: 'export' */",
      "};",
      "export default nextConfig;",
      "",
    ].join("\n");
    const after = written(edit("next.config.mjs", before));
    expect(after.split("\n").slice(0, 3)).toEqual([
      "const nextConfig = { // keep this comment",
      '  output: "standalone",',
      "  experimental: { output: 1 },",
    ]);
    await expectValidSyntax("next.config.mjs", after);
  });

  it("keeps CRLF line endings", () => {
    const before =
      "const nextConfig = {\r\n  reactStrictMode: true,\r\n};\r\nexport default nextConfig;\r\n";
    expect(written(edit("next.config.mjs", before))).toBe(
      'const nextConfig = {\r\n  output: "standalone",\r\n  reactStrictMode: true,\r\n};\r\nexport default nextConfig;\r\n',
    );
  });
});

describe("standaloneConfigEdit: no config file", () => {
  it("creates next.config.mjs with standalone output", async () => {
    const result = edit("next.config.mjs", undefined);
    expect(result).toMatchObject({ action: "write", created: true });
    const content = written(result);
    expect(content).toBe(
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  output: \"standalone\",\n};\n\nexport default nextConfig;\n",
    );
    await expectValidSyntax("next.config.mjs", content);
  });

  it("creates it with outputFileTracingRoot for an app in a monorepo folder", async () => {
    const content = written(edit("apps/web/next.config.mjs", undefined, "../../"));
    expect(content).toBe(
      [
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "/** @type {import('next').NextConfig} */",
        "const nextConfig = {",
        '  output: "standalone",',
        '  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../"),',
        "};",
        "",
        "export default nextConfig;",
        "",
      ].join("\n"),
    );
    await expectValidSyntax("next.config.mjs", content);
  });

  it("only creates the ESM .mjs file", () => {
    expect(edit("next.config.ts", undefined)).toMatchObject({ action: "manual" });
    expect(edit("next.config.js", undefined)).toMatchObject({ action: "manual" });
  });
});

describe("standaloneConfigEdit: monorepo apps", () => {
  it("ESM: adds the path and url imports and outputFileTracingRoot", async () => {
    const before =
      "/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n";
    const after = written(edit("apps/web/next.config.mjs", before, "../../"));
    expect(after).toBe(
      [
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        "/** @type {import('next').NextConfig} */",
        "const nextConfig = {",
        '  output: "standalone",',
        '  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../"),',
        "};",
        "",
        "export default nextConfig;",
        "",
      ].join("\n"),
    );
    await expectValidSyntax("next.config.mjs", after);
  });

  it("ESM: reuses existing path and url imports", async () => {
    const before = [
      'import path from "path";',
      "import { fileURLToPath } from 'node:url';",
      "export default {",
      '  basePath: "/app",',
      "};",
      "",
    ].join("\n");
    const after = written(edit("web/next.config.mjs", before, "../"));
    expect(after).toBe(
      [
        'import path from "path";',
        "import { fileURLToPath } from 'node:url';",
        "export default {",
        '  output: "standalone",',
        '  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../"),',
        '  basePath: "/app",',
        "};",
        "",
      ].join("\n"),
    );
    await expectValidSyntax("next.config.mjs", after);
  });

  it("CommonJS: uses __dirname without new bindings", async () => {
    const after = written(edit("apps/web/next.config.js", "module.exports = {};\n", "../../"));
    expect(after).toBe(
      'module.exports = {\n  output: "standalone",\n  outputFileTracingRoot: require("node:path").join(__dirname, "../../"),\n};\n',
    );
    await expectValidSyntax("next.config.cjs", after);
  });

  it("adds only what is missing", () => {
    const standalone = 'module.exports = {\n  output: "standalone",\n};\n';
    expect(written(edit("apps/web/next.config.js", standalone, "../../"))).toBe(
      'module.exports = {\n  outputFileTracingRoot: require("node:path").join(__dirname, "../../"),\n  output: "standalone",\n};\n',
    );
    const traced = 'module.exports = {\n  outputFileTracingRoot: "/repo",\n};\n';
    expect(written(edit("apps/web/next.config.js", traced, "../../"))).toBe(
      'module.exports = {\n  output: "standalone",\n  outputFileTracingRoot: "/repo",\n};\n',
    );
  });

  it("leaves TypeScript configs and taken names to the agent", () => {
    const ts = "const nextConfig: NextConfig = {};\nexport default nextConfig;\n";
    expect(edit("apps/web/next.config.ts", ts, "../../")).toMatchObject({
      action: "manual",
      reason: expect.stringContaining("outputFileTracingRoot"),
    });
    const taken = 'const path = "/x";\nexport default { basePath: path };\n';
    expect(edit("apps/web/next.config.mjs", taken, "../../")).toMatchObject({ action: "manual" });
  });
});

describe("standaloneConfigEdit: left alone", () => {
  it("does nothing when the config already has what is needed", () => {
    expect(edit("next.config.mjs", "export default { output: 'standalone' };\n")).toMatchObject({
      action: "none",
      reason: expect.stringContaining("already"),
    });
  });

  it("explains a different output mode", () => {
    const result = edit("next.config.mjs", 'export default {\n  output: "export",\n};\n');
    expect(result).toMatchObject({ action: "manual" });
    expect(result.action === "manual" && result.reason).toMatch(/sets output to "export"/);
  });

  it("explains an output set from an expression", () => {
    const result = edit("next.config.js", "module.exports = { output: process.env.MODE };\n");
    expect(result).toMatchObject({ action: "manual", reason: expect.stringContaining("output") });
  });

  const unsafe: Record<string, [string, string]> = {
    "a wrapped export": [
      "next.config.mjs",
      "const nextConfig = {};\nexport default withBundleAnalyzer(nextConfig);\n",
    ],
    "a function config": [
      "next.config.js",
      "module.exports = (phase) => ({ reactStrictMode: true });\n",
    ],
    "a spread": ["next.config.mjs", "export default { ...base, reactStrictMode: true };\n"],
    "a computed key": ["next.config.mjs", 'export default { ["output"]: "export" };\n'],
    "a getter": ["next.config.mjs", 'export default { get output() { return "export"; } };\n'],
    "a shorthand output": [
      "next.config.mjs",
      'const output = "export";\nexport default { output };\n',
    ],
    "a regular expression": [
      "next.config.js",
      "module.exports = { webpack(config) { config.module.rules.push({ test: /\\.svg$/ }); return config; } };\n",
    ],
    "a template literal with a substitution": [
      "next.config.mjs",
      "export default { basePath: `$" + "{process.env.BASE}` };\n",
    ],
    "a later mutation": [
      "next.config.mjs",
      'const nextConfig = {};\nnextConfig.output = "export";\nexport default nextConfig;\n',
    ],
    "two exports": [
      "next.config.js",
      "module.exports = {};\nmodule.exports.reactStrictMode = true;\n",
    ],
    "ESM syntax in a .cjs file": ["next.config.cjs", "export default {};\n"],
    "CommonJS in a .mjs file": ["next.config.mjs", "module.exports = {};\n"],
    "code after the object on the same line": [
      "next.config.mjs",
      "const nextConfig = {}, other = 1;\nexport default nextConfig;\n",
    ],
    "an unterminated object": ["next.config.mjs", "export default {\n  reactStrictMode: true,\n"],
    "an empty file": ["next.config.mjs", ""],
  };
  for (const [name, [path, content]] of Object.entries(unsafe)) {
    it(`does not edit ${name}`, () => {
      const result = edit(path, content);
      expect(result.action).toBe("manual");
      expect(result.action === "manual" && result.reason.length).toBeGreaterThan(10);
    });
  }
});
