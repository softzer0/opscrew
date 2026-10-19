import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { IMAGES, TOOLS } from "@opscrew/iac-templates";
import { type AppBuild, type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts } from "../testing";
import {
  createTestRepo,
  FakeGitHub,
  GIT,
  makePlan,
  nextChanges,
  nextFacts,
} from "./__fixtures__/repo";
import { runtimeVersionFile } from "./build-files";
import { runAdapt } from "./run";

const DIGEST = `sha256:${"ab".repeat(32)}`;

function build(builder: AppBuild["builder"], runtime: AppBuild["runtime"]): AppBuild {
  return {
    builder,
    chosen: builder === "generated-dockerfile" ? "auto" : "user",
    reason: "The reason.",
    runtime,
    probe: "bash",
  };
}

function withBuild(plan: DeployPlan, appBuild: AppBuild, dockerfile?: string): DeployPlan {
  return {
    ...plan,
    app: { ...plan.app, build: appBuild, ...(dockerfile === undefined ? {} : { dockerfile }) },
  };
}

/** A registry that knows the digest of every image it is asked about, recording the requests. */
function fakeRegistry(): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(null, { headers: { "docker-content-digest": DIGEST } });
    },
  };
}

async function temp(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-build-files-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const node24 = build("generated-dockerfile", { language: "node", version: "24" });

describe("runtimeVersionFile", () => {
  it("adds the language's version file with the recorded version", async () => {
    const plan = (b: AppBuild) => withBuild(makePlan([]), b);
    const root = await temp();
    expect(await runtimeVersionFile(root, nextFacts(), plan(node24))).toEqual({
      path: ".nvmrc",
      content: "24\n",
      kind: "docker",
    });
    const python = build("generated-dockerfile", { language: "python", version: "3.13" });
    expect((await runtimeVersionFile(root, nextFacts(), plan(python)))?.path).toBe(
      ".python-version",
    );
    const ruby = build("buildpacks", { language: "ruby", version: "3.4" });
    expect(await runtimeVersionFile(root, nextFacts(), plan(ruby))).toMatchObject({
      path: ".ruby-version",
      content: "3.4\n",
    });
    const rust = build("railpack", { language: "rust", version: "1.98" });
    expect(await runtimeVersionFile(root, nextFacts(), plan(rust))).toMatchObject({
      path: "rust-toolchain.toml",
      content: '[toolchain]\nchannel = "1.98"\n',
    });
    // Go declares its version in go.mod; `other` has none; a plan without a builder records none.
    const go = build("buildpacks", { language: "go", version: "1.26" });
    expect(await runtimeVersionFile(root, nextFacts(), plan(go))).toBeUndefined();
    expect(
      await runtimeVersionFile(root, nextFacts(), plan(build("railpack", { language: "other" }))),
    ).toBeUndefined();
    expect(await runtimeVersionFile(root, nextFacts(), makePlan([]))).toBeUndefined();
  });

  it("adds none when the app's folder or the repository root already has one", async () => {
    const plan = withBuild(makePlan([]), node24);
    const inFolder = makeFacts({ appDir: "apps/web" });
    expect((await runtimeVersionFile(await temp(), inFolder, plan))?.path).toBe("apps/web/.nvmrc");
    for (const file of [".nvmrc", ".node-version", "apps/web/.node-version"]) {
      expect(await runtimeVersionFile(await temp({ [file]: "22\n" }), inFolder, plan)).toBe(
        undefined,
      );
    }
  });
});

describe.skipIf(GIT === undefined)("runAdapt with the plan's builder", () => {
  async function adapt(
    plan: (base: DeployPlan) => DeployPlan,
    options: Parameters<typeof createTestRepo>[0] = {},
  ) {
    const repo = await createTestRepo(options);
    const base = await readArtifact("plan", repo.deps.paths.files.plan);
    await writeArtifact("plan", repo.deps.paths.files.plan, plan(base));
    const result = await runAdapt(repo.deps, { ai: false, push: false, github: new FakeGitHub() });
    return { repo, result, read: (path: string) => readFile(join(repo.root, path), "utf8") };
  }

  it("writes no Dockerfile when another builder builds the image", async () => {
    const railpack = build("railpack", { language: "node", version: "24" });
    const { result, repo } = await adapt((plan) => withBuild(plan, railpack));
    expect(result.createdFiles).not.toContain("Dockerfile");
    expect(result.createdFiles).toEqual(
      expect.arrayContaining([".dockerignore", ".env.example", ".nvmrc"]),
    );
    expect(result.changes.find((change) => change.id === "dockerfile")?.status).toBe("skipped");
    expect(result.notes.dockerfile).toBe(
      "Railpack builds the image from the code, so the app needs no Dockerfile.",
    );
    expect(repo.deps.reporter.text()).not.toContain("Code-change agent or to you");
  });

  it("gives a Go app built by Railpack its .dockerignore and .env.example, and says so in the pull request", async () => {
    const go = makeFacts({
      name: "shop",
      languages: ["go"],
      packageManager: "none",
      envVars: [
        { name: "API_TOKEN", files: ["main.go"], clientExposed: false, secretLikely: true },
      ],
    });
    const changes = nextChanges().filter((change) =>
      ["dockerignore", "env-example"].includes(change.kind),
    );
    const repo = await createTestRepo({ facts: go, changes });
    const base = await readArtifact("plan", repo.deps.paths.files.plan);
    const railpack = build("railpack", { language: "go", version: "1.26" });
    await writeArtifact("plan", repo.deps.paths.files.plan, withBuild(base, railpack));
    const github = new FakeGitHub();
    const result = await runAdapt(repo.deps, { ai: false, github });

    expect(result.createdFiles).toEqual([".dockerignore", ".env.example"]);
    expect(result.changes.map((change) => change.status)).toEqual(["applied", "applied"]);
    expect(repo.deps.reporter.text()).not.toContain("no container template");
    const body = github.created[0]?.body ?? "";
    expect(body).toContain(
      "Railpack builds the image from the code, so the app needs no Dockerfile.",
    );
    expect(body).toContain("- [ ] The image is built with Railpack in the deploy workflow");
    expect(body).not.toContain("docker build");
  });

  it("pins a declared non-default Node version by the digest the registry reports", async () => {
    const registry = fakeRegistry();
    const node20 = build("generated-dockerfile", { language: "node", version: "20" });
    const { result, read } = await adapt((plan) => withBuild(plan, node20), {
      depsOptions: { fetch: registry.fetch },
    });
    expect(result.createdFiles).toContain("Dockerfile");
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toContain(`FROM node:20-alpine@${DIGEST} AS`);
    expect(dockerfile).not.toContain("pinned by tag only");
    expect(registry.urls).toEqual([
      "https://registry-1.docker.io/v2/library/node/manifests/20-alpine",
    ]);
    expect(await read(".nvmrc")).toBe("20\n");
  });

  it("offline, pins that image by tag only and says so", async () => {
    const node20 = build("generated-dockerfile", { language: "node", version: "20" });
    // The test deps' fetch fails every request, as offline.
    const { result, read, repo } = await adapt((plan) => withBuild(plan, node20));
    expect(result.createdFiles).toContain("Dockerfile");
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toMatch(/^FROM node:20-alpine AS/m);
    expect(dockerfile).toContain("node:20-alpine is pinned by tag only");
    expect(repo.deps.reporter.text()).toContain(
      "OpsCrew could not look up the digest of node:20-alpine",
    );
    expect(repo.deps.reporter.text()).toContain("so the Dockerfile pins it by tag only");
  });

  it("looks nothing up for the runtime image OpsCrew pins", async () => {
    const registry = fakeRegistry();
    const { read } = await adapt((plan) => withBuild(plan, node24), {
      depsOptions: { fetch: registry.fetch },
    });
    expect(registry.urls).toEqual([]);
    expect(await read("Dockerfile")).toContain(`FROM ${IMAGES.nodeAlpine.ref} AS`);
  });

  it("adds supercronic to the image only when the plan has an enabled cron job", async () => {
    const job = { name: "cleanup", schedule: "@daily", command: "node cleanup.js", enabled: true };
    const withCron = (plan: DeployPlan, enabled: boolean): DeployPlan => ({
      ...withBuild(plan, node24),
      processes: { workers: [], cron: [{ ...job, enabled }] },
    });
    const on = await adapt((plan) => withCron(plan, true));
    // amd64, the server's architecture.
    expect(await on.read("Dockerfile")).toContain(
      `ADD --checksum=sha256:${TOOLS.supercronic.sha256.amd64} `,
    );
    const off = await adapt((plan) => withCron(plan, false));
    expect(await off.read("Dockerfile")).not.toContain("supercronic");
  });

  it("checks the user's own Dockerfile against the baseline and lists each finding with its fix", async () => {
    const own = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n';
    const yours = build("own-dockerfile", { language: "node", version: "22" });
    const { result, read, repo } = await adapt(
      (plan) => withBuild(plan, yours, "docker/Dockerfile"),
      {
        files: { "docker/Dockerfile": own },
      },
    );
    expect(await read("docker/Dockerfile")).toBe(own);
    expect(result.createdFiles).not.toContain("Dockerfile");
    expect(result.notes.dockerfile).toBe(
      "The image is built with your own Dockerfile (docker/Dockerfile), so OpsCrew wrote none.",
    );
    const text = repo.deps.reporter.text();
    expect(text).toContain(
      "docker/Dockerfile misses OpsCrew's image baseline in 2 places; OpsCrew does not change your Dockerfile:",
    );
    expect(text).toContain(
      "- line 1: Base image is not pinned by digest. Fix: Add the image's digest",
    );
    expect(text).toContain("- line 1: Container runs as root. Fix: Create an unprivileged user");
  });

  it("says when the user's own Dockerfile meets the baseline", async () => {
    const own = `FROM node:22-alpine@${DIGEST}\nUSER node\nCMD ["node", "server.js"]\n`;
    const yours = build("own-dockerfile", { language: "node", version: "22" });
    const { repo } = await adapt((plan) => withBuild(plan, yours), { files: { Dockerfile: own } });
    expect(repo.deps.reporter.text()).toContain("Dockerfile meets OpsCrew's image baseline");
  });

  it("stops before changing anything when the user's own Dockerfile is not where the plan says", async () => {
    const repo = await createTestRepo({ changes: nextChanges() });
    const base = await readArtifact("plan", repo.deps.paths.files.plan);
    const yours = build("own-dockerfile", { language: "node", version: "22" });
    await writeArtifact(
      "plan",
      repo.deps.paths.files.plan,
      withBuild(base, yours, "Dockerfile.prod"),
    );
    await expect(runAdapt(repo.deps, { ai: false, push: false })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "your own Dockerfile at Dockerfile.prod, which does not exist",
      ),
      hint: expect.stringContaining("Set app.dockerfile in opscrew/plan.yaml"),
    });
  });
});
