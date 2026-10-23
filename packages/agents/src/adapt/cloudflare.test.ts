import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandOptions, CommandRunner } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import { TOOLS } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import { createTestPhaseDeps, makeRequirements, type TestPhaseDeps } from "../testing";
import { fakeNpmRegistry } from "./__fixtures__/npm-registry";
import { FakeGitHub, GIT, git, testEnv } from "./__fixtures__/repo";
import { runAdapt } from "./run";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const NEXT_FIXTURE = fileURLToPath(new URL("./__fixtures__/next-ssr/", import.meta.url));

/** The lockfile each package manager stand-in writes. */
const LOCKFILES: Record<string, string> = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml" };

/**
 * Real git for `git`; every other command is a package manager, recorded, which rewrites its
 * lockfile in the folder it runs in (no install, no network).
 */
class PackageManagerRunner implements CommandRunner {
  readonly #git = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly installs: { tool: string; args: string[]; cwd?: string }[] = [];
  async run(command: string, args: readonly string[], options?: CommandOptions) {
    const tool = basename(command).replace(/\.(?:cmd|exe)$/i, "");
    if (tool === "git") return this.#git.run(command, args, options);
    this.installs.push({ tool, args: [...args], ...(options?.cwd ? { cwd: options.cwd } : {}) });
    const lockfile = LOCKFILES[tool];
    if (options?.cwd !== undefined && lockfile !== undefined) {
      await writeFile(join(options.cwd, lockfile), `updated by ${tool} ${args.join(" ")}\n`);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

interface AdaptedApp {
  root: string;
  deps: TestPhaseDeps;
  runner: PackageManagerRunner;
  github: FakeGitHub;
  registry: ReturnType<typeof fakeNpmRegistry>;
  /** The adapt commit's diff of the app's files (not opscrew/), for the snapshots. */
  diff: string;
}

/**
 * `source` committed in a temp git repository with `files`, analysed, designed for Cloudflare's
 * hosting on example.com, and adapted with no model: pushed to a local bare origin, with the pull
 * request opened through a fake GitHub.
 */
async function adaptApp(
  source: string,
  files: Record<string, string> = {},
  registry = fakeNpmRegistry(),
): Promise<AdaptedApp> {
  const home = await mkdtemp(join(tmpdir(), "opscrew-adapt-cloudflare-"));
  const root = join(home, "app");
  await materializeFixture(source, root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  // Stand-ins for the package managers, found on PATH like the real ones.
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const tool of Object.keys(LOCKFILES)) {
    await writeFile(join(bin, tool), "", { mode: 0o755 });
    await writeFile(join(bin, `${tool}.cmd`), "", { mode: 0o755 });
  }
  const base = testEnv(home);
  // One PATH key (Windows spells it Path), with the stand-ins first.
  const path = Object.entries(base).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(base).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  env.PATH = `${bin}${delimiter}${path}`;
  await writeFile(env.GIT_CONFIG_GLOBAL as string, "");
  await git(env, root, "init", "-b", "main");
  await git(env, root, "config", "user.name", "OpsCrew Test");
  await git(env, root, "config", "user.email", "test@example.invalid");
  await git(env, root, "config", "commit.gpgsign", "false");
  await git(env, root, "config", "core.autocrlf", "false");
  await git(env, root, "add", "-A");
  await git(env, root, "commit", "-m", "initial");
  const bare = join(home, "origin.git").replace(/\\/g, "/");
  await git(env, home, "init", "--bare", "-b", "main", bare);
  await git(env, root, "remote", "add", "origin", "https://github.com/acme/site.git");
  await git(env, root, "config", `url.${bare}.pushInsteadOf`, "https://github.com/acme/site.git");

  const runner = new PackageManagerRunner();
  const deps = await createTestPhaseDeps({ root, env, runner, fetch: registry.fetch });
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: await detectProject(root),
    summary: "A server-rendered site.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "cloudflare-workers",
      domain: "example.com",
      dnsProvider: "cloudflare",
    }),
  );
  await runDesign(deps);
  const github = new FakeGitHub();
  await runAdapt(deps, { github, ai: false });
  const diff = (await git(env, root, "show", "--format=", "HEAD", "--", ".", ":(exclude)opscrew"))
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n")
    .replaceAll(TOOLS.wrangler.version, "<wrangler pin>");
  return { root, deps, runner, github, registry, diff };
}

const statuses = async (app: AdaptedApp) =>
  Object.fromEntries(
    (await readArtifact("plan", app.deps.paths.files.plan)).codeChanges.map((c) => [
      c.id,
      c.status,
    ]),
  );

describe.skipIf(GIT === undefined)("adapt on Cloudflare's hosting (the SSR adapters)", () => {
  it("adds @astrojs/cloudflare 14.3 to astro-ssr on astro 7.3, wrangler, and adapter: cloudflare()", async () => {
    const secret = fakeSecret("stripe-live-key", "astro-ssr");
    const app = await adaptApp(join(EXAMPLES, "astro-ssr"), {
      "package-lock.json": '{ "lockfileVersion": 3 }\n',
      ".env": `API_KEY=${secret}\n`,
    });
    expect(await statuses(app)).toEqual({ "cloudflare-adapter": "applied" });
    expect(app.registry.urls).toEqual(["https://registry.npmjs.org/@astrojs%2fcloudflare"]);
    // The package manager updated the lockfile in the checkout, without running any scripts.
    expect(app.runner.installs).toEqual([
      {
        tool: "npm",
        args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd: app.root,
      },
    ]);
    const pkg = JSON.parse(await readFile(join(app.root, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "@astrojs/cloudflare": "14.3.1", astro: "7.3.8" });
    expect(pkg.devDependencies).toEqual({ wrangler: TOOLS.wrangler.version });
    expect(app.diff).toMatchSnapshot();

    const body = app.github.created[0]?.body ?? "";
    expect(body).toContain("This pull request prepares the app for Cloudflare hosting.");
    expect(body).toContain(
      "**Build configuration** in `astro.config.mjs` (applied by OpsCrew): Build the app with Astro's Cloudflare adapter (@astrojs/cloudflare)",
    );
    expect(body).toContain("(14.4.2 needs astro ^7.4.0: upgrade astro to move to it)");
    expect(body).toContain("npm updated package-lock.json.");
    expect(body).toContain(
      "- [ ] The site builds: `npm run build` writes `dist/client`, which Cloudflare hosting publishes.",
    );
    expect(body).not.toContain("docker build");
    // No leak: the app's own secret stays in its gitignored .env.
    const commit = await git(app.deps.env, app.root, "show", "HEAD");
    for (const text of [body, commit, app.deps.reporter.text(), app.diff]) {
      expect(text).not.toContain(secret);
    }
  });

  it("writes open-next.config.ts for Next.js and turns cacheComponents and partialPrefetching off", async () => {
    const app = await adaptApp(NEXT_FIXTURE, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(await statuses(app)).toEqual({
      "cloudflare-adapter": "applied",
      "next-workers-options": "applied",
    });
    expect(app.registry.urls).toEqual(["https://registry.npmjs.org/@opennextjs%2fcloudflare"]);
    expect(app.runner.installs.map((install) => [install.tool, ...install.args])).toEqual([
      ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
    ]);
    expect(await readFile(join(app.root, "open-next.config.ts"), "utf8")).toBe(
      'import { defineCloudflareConfig } from "@opennextjs/cloudflare";\n\nexport default defineCloudflareConfig();\n',
    );
    const pkg = JSON.parse(await readFile(join(app.root, "package.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBe(TOOLS.wrangler.version);
    const gitignore = await readFile(join(app.root, ".gitignore"), "utf8");
    expect(gitignore.match(/^\.open-next\/$/gm)).toEqual([".open-next/"]);
    // OpsCrew never runs `opennextjs-cloudflare migrate`, which waits for a browser login.
    expect(JSON.stringify(app.runner.installs)).not.toContain("migrate");
    expect(app.diff).toMatchSnapshot();
  });

  it("sets Nitro's cloudflare_module preset for nuxt-ssr, with no new package", async () => {
    const app = await adaptApp(join(EXAMPLES, "nuxt-ssr"));
    expect(await statuses(app)).toEqual({ "cloudflare-adapter": "applied" });
    expect(app.registry.urls).toEqual([]);
    expect(app.runner.installs).toEqual([]);
    expect(app.diff).toMatchSnapshot();
  });

  it("replaces sveltekit-ssr's Node adapter with @sveltejs/adapter-cloudflare in vite.config.ts", async () => {
    const app = await adaptApp(join(EXAMPLES, "sveltekit-ssr"));
    expect(await statuses(app)).toEqual({ "cloudflare-adapter": "applied" });
    expect(app.registry.urls).toEqual([
      "https://registry.npmjs.org/@sveltejs%2fadapter-cloudflare",
    ]);
    // No lockfile in the app, so nothing to update.
    expect(app.runner.installs).toEqual([]);
    const pkg = JSON.parse(await readFile(join(app.root, "package.json"), "utf8"));
    expect(pkg.devDependencies["@sveltejs/adapter-cloudflare"]).toBe("8.0.1");
    expect(pkg.devDependencies.wrangler).toBe(TOOLS.wrangler.version);
    expect(pkg.devDependencies["@sveltejs/adapter-node"]).toBeUndefined();
    expect(app.diff).toMatchSnapshot();
  });

  it("leaves the adapter to the user, with its playbook, when the registry cannot be read", async () => {
    const app = await adaptApp(join(EXAMPLES, "astro-ssr"), {}, fakeNpmRegistry({}));
    expect(await statuses(app)).toEqual({ "cloudflare-adapter": "pending" });
    expect(await readFile(join(app.root, "astro.config.mjs"), "utf8")).toContain("@astrojs/node");
    expect(app.runner.installs).toEqual([]);
    const text = app.deps.reporter.text();
    expect(text).toContain("1 change still to make by hand:");
    expect(text).toContain(
      "In the Astro config, import it with `import cloudflare from '@astrojs/cloudflare';` and set `adapter: cloudflare()`",
    );
    expect(text).toContain(
      "(OpsCrew could not read the releases of @astrojs/cloudflare from the npm registry (it answered HTTP 404).)",
    );
    // Not the container playbooks' steps.
    expect(text).not.toContain("standalone");
    expect(app.github.created[0]?.body).toContain("(to do)");
  });

  it("changes nothing in a static app, and proposes no adapter", async () => {
    const app = await adaptApp(join(EXAMPLES, "static-vite"));
    expect(await statuses(app)).toEqual({});
    expect(app.registry.urls).toEqual([]);
    expect(app.runner.installs).toEqual([]);
    expect(app.diff).toBe("");
    // Only OpsCrew's own files are in the pull request.
    expect(app.github.created[0]?.body).toContain("No code changes were needed.");
    expect(app.deps.reporter.text()).not.toContain("not where a");
  });

  it("notes a static site's unusual output folder", async () => {
    const app = await adaptApp(join(EXAMPLES, "static-vite"), {
      "vite.config.js":
        'import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()], build: { outDir: "site" } });\n',
    });
    expect(app.deps.reporter.text()).toContain(
      "Cloudflare hosting publishes site (target.site.outputDir in opscrew/plan.yaml), which is not where a Vite build writes by default: check that the app's build writes there.",
    );
  });
});
