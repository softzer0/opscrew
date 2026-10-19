// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan, ImageBuilder, RuntimeLanguage } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { ACTIONS, IMAGES, type PinArch, TOOLS, toolDownloadUrl } from "../pins";
import {
  jobYaml,
  NIGHTLY,
  serverPlan,
  withBuild,
  withPlan,
  withProcesses,
} from "./__fixtures__/plans";
import { DEPLOY_SECRETS, renderWorkflow } from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type BuildJob = {
  "runs-on": string;
  permissions: Record<string, string>;
  outputs: Record<string, string>;
  steps: Step[];
};

const ctx = testContext();
const BUILDERS: readonly ImageBuilder[] = [
  "generated-dockerfile",
  "own-dockerfile",
  "buildpacks",
  "railpack",
];

function rendered(plan: DeployPlan): string {
  return renderWorkflow(plan, ctx).content;
}
function buildJob(plan: DeployPlan): BuildJob {
  return parse(rendered(plan)).jobs.build;
}
function planFor(builder: ImageBuilder, language: RuntimeLanguage = "go"): DeployPlan {
  return withBuild(serverPlan(), builder, { language });
}
const step = (job: BuildJob, id: string) => job.steps.find((s) => s.id === id || s.name === id);
/** `owner/name@<sha>` of a pin in ACTIONS (without the ` # vX` comment). */
const action = (key: keyof typeof ACTIONS) => ACTIONS[key].split(" #")[0];

describe("the build job", () => {
  it.each(BUILDERS)("matches the snapshot for %s", (builder) => {
    const plan = planFor(builder, builder === "railpack" ? "ruby" : "go");
    expect(jobYaml(rendered(plan), "build")).toMatchSnapshot();
  });

  it("builds as before with a Dockerfile when the plan has no builder yet", () => {
    const plain = buildJob(serverPlan());
    expect(plain).toEqual(buildJob(planFor("own-dockerfile")));
    expect(plain).toEqual(buildJob(planFor("generated-dockerfile")));
  });

  it.each(BUILDERS)(
    "%s: provenance without the GitHub event payload, from a job that checks out the code",
    (builder) => {
      const job = buildJob(planFor(builder));
      expect(job.steps[0]?.uses).toBe(action("checkout"));
      const buildx = job.steps.find((s) => s.uses === action("setupBuildx"));
      expect(buildx?.with?.["driver-opts"]).toBe("provenance-add-gha=false");
      const push = step(job, "push");
      expect(push?.uses).toBe(action("buildPush"));
      expect(job.steps.indexOf(buildx as Step)).toBeLessThan(job.steps.indexOf(push as Step));
    },
  );

  it.each(BUILDERS)(
    "%s: the final image has a mode=max provenance, an SBOM and the GHA cache",
    (builder) => {
      const push = step(buildJob(planFor(builder)), "push");
      expect(push?.with).toMatchObject({
        push: true,
        tags: "${{ steps.image.outputs.image }}",
        provenance: "mode=max",
        sbom: true,
      });
      expect(push?.with?.["cache-from"]).toMatch(/^type=gha\b/);
      expect(push?.with?.["cache-to"]).toMatch(/^type=gha,mode=(max|min)\b/);
    },
  );

  it.each(BUILDERS)("%s: the deploy gets the final index digest", (builder) => {
    const job = buildJob(planFor(builder));
    expect(job.outputs).toEqual({
      image: "${{ steps.final.outputs.ref }}",
      tag: "${{ steps.image.outputs.image }}",
    });
    const final = step(job, "final");
    expect(final?.env).toEqual({
      NAME: "${{ steps.image.outputs.name }}",
      DIGEST: "${{ steps.push.outputs.digest }}",
    });
    expect(final?.run).toContain('ref="$NAME@$DIGEST"');
    expect(final?.run).toContain("@sha256:[0-9a-f]{64}$");
    expect(final?.run).toContain('echo "ref=$ref" >> "$GITHUB_OUTPUT"');
    const deploy = parse(rendered(planFor(builder))).jobs.deploy.steps as Step[];
    expect(deploy.find((s) => s.id === "start")?.env?.IMAGE).toBe(
      "${{ needs.build.outputs.image }}",
    );
  });

  it.each(BUILDERS)("%s: Trivy scans the final digest after the registry logout", (builder) => {
    const job = buildJob(planFor(builder));
    const scan = job.steps.find((s) => s.name?.startsWith("Scan"));
    expect(job.steps.indexOf(scan as Step)).toBe(job.steps.length - 1);
    expect(scan?.env?.IMAGE).toBe("${{ steps.final.outputs.ref }}");
    const script = scan?.run ?? "";
    const at = (text: string) => script.indexOf(text);
    expect(at('docker pull --quiet "$IMAGE"')).toBeGreaterThan(-1);
    expect(at('docker pull --quiet "$IMAGE"')).toBeLessThan(at("docker logout ghcr.io"));
    expect(at("docker logout ghcr.io")).toBeLessThan(at(IMAGES.trivy.ref));
    expect(script).toContain("--exit-code 0");
    const off = buildJob({
      ...planFor(builder),
      security: { ...serverPlan().security, imageScan: false },
    });
    expect(off.steps.some((s) => s.name?.startsWith("Scan"))).toBe(false);
  });

  it("takes every action, image and tool from pins.ts", () => {
    const pinned = new Set(Object.keys(ACTIONS).map((k) => action(k as keyof typeof ACTIONS)));
    for (const builder of BUILDERS) {
      const content = rendered(planFor(builder));
      const doc = parse(content);
      for (const j of Object.values<{ steps: Step[] }>(doc.jobs)) {
        for (const s of j.steps) if (s.uses) expect(pinned).toContain(s.uses);
      }
      for (const line of content.split("\n").filter((l) => /\buses: /.test(l))) {
        expect(Object.values(ACTIONS).some((pin) => line.endsWith(`uses: ${pin}`))).toBe(true);
      }
    }
    const buildpacks = rendered(planFor("buildpacks"));
    expect(buildpacks).toContain(`--builder ${IMAGES.paketoBuilder.ref}`);
    expect(buildpacks).toContain(`--run-image ${IMAGES.paketoRun.ref}`);
    expect(buildpacks).toContain(TOOLS.pack.sha256.amd64);
    const railpack = rendered(planFor("railpack"));
    expect(railpack).toContain(`BUILDKIT_SYNTAX=${IMAGES.railpackFrontend.ref}`);
    expect(railpack).toContain(TOOLS.railpack.sha256.amd64);
  });

  it("builds a Dockerfile with the plan's context and file", () => {
    const plan = planFor("own-dockerfile");
    const custom = {
      ...plan,
      app: { ...plan.app, buildContext: "apps/web", dockerfile: "apps/web/Dockerfile.prod" },
    };
    const push = step(buildJob(custom), "push");
    expect(push?.name).toBe("Build and push the image");
    expect(push?.with).toMatchObject({
      context: "apps/web",
      file: "apps/web/Dockerfile.prod",
      "cache-from": "type=gha",
      "cache-to": "type=gha,mode=max",
    });
  });
});

describe("an own Dockerfile with cron jobs", () => {
  const cron = withProcesses(planFor("own-dockerfile"), { cron: [NIGHTLY] });

  it("matches the snapshot", () => {
    expect(jobYaml(rendered(cron), "build")).toMatchSnapshot();
  });

  it("builds build-<sha> from the Dockerfile with its build values, then seals it", () => {
    const job = buildJob(cron);
    const names = job.steps.map((s) => s.id ?? s.name);
    expect(names.indexOf("own")).toBeLessThan(names.indexOf("Write the seal Dockerfile"));
    expect(names.indexOf("Write the seal Dockerfile")).toBeLessThan(names.indexOf("push"));
    const own = step(job, "own");
    expect(own?.uses).toBe(action("buildPush"));
    expect(own?.with).toEqual({
      context: ".",
      file: "Dockerfile",
      "build-args": `\${{ secrets.${DEPLOY_SECRETS.buildEnv} }}`,
      secrets: `\${{ secrets.${DEPLOY_SECRETS.buildSecrets} }}`,
      push: true,
      tags: "${{ steps.image.outputs.name }}:build-${{ github.sha }}",
      provenance: false,
      "cache-from": "type=gha",
      "cache-to": "type=gha,mode=max",
    });
    expect(step(job, "push")?.name).toBe("Seal and push the image");
    expect(step(job, "Write the seal Dockerfile")?.env?.BASE).toContain(
      "${{ steps.own.outputs.digest }}",
    );
  });

  it("deletes the intermediate image after the deploy, as for Buildpacks and Railpack", () => {
    const keepAll = (p: DeployPlan) => withPlan(p, { imageRetention: { enabled: false } });
    const prune = (p: DeployPlan) => parse(rendered(keepAll(p))).jobs.prune;
    expect(prune(cron)?.steps[0]?.name).toBe("Delete the intermediate build images");
    expect(prune(planFor("own-dockerfile"))).toBeUndefined();
  });

  it("builds as before when no cron job is enabled", () => {
    const off = withProcesses(planFor("own-dockerfile"), {
      cron: [{ ...NIGHTLY, enabled: false }],
    });
    expect(buildJob(off)).toEqual(buildJob(planFor("own-dockerfile")));
    // OpsCrew's own Dockerfile gets supercronic in its runtime stage instead of a seal.
    const generated = withProcesses(planFor("generated-dockerfile"), { cron: [NIGHTLY] });
    expect(buildJob(generated)).toEqual(buildJob(planFor("generated-dockerfile")));
  });
});

describe("build values", () => {
  /** Evaluates `${{ secrets.NAME }}` the way GitHub does, with `values`. */
  function evaluated(content: string, values: Record<string, string>): Step[] {
    const doc = parse(content);
    const fill = (text: string) =>
      text.replace(/\$\{\{ secrets\.(\w+) \}\}/g, (_, name: string) => values[name] ?? "");
    return (doc.jobs.build.steps as Step[]).map((s) => ({
      ...s,
      ...(s.with === undefined
        ? {}
        : {
            with: Object.fromEntries(
              Object.entries(s.with).map(([k, v]) => [k, typeof v === "string" ? fill(v) : v]),
            ),
          }),
      ...(s.env === undefined
        ? {}
        : { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v)])) }),
    }));
  }

  const token = fakeSecret("github-token");
  const values = {
    [DEPLOY_SECRETS.buildEnv]: "NEXT_PUBLIC_SITE=https://shop.example.com\n",
    [DEPLOY_SECRETS.buildSecrets]: `NPM_TOKEN=${token}\n`,
  };

  it.each(BUILDERS)(
    "%s: no secret name or value reaches build-args, and only the secret mounts get them",
    (builder) => {
      const content = rendered(planFor(builder));
      const steps = evaluated(content, values);
      for (const s of steps) {
        const args = String(s.with?.["build-args"] ?? "");
        expect(args).not.toContain("NPM_TOKEN");
        expect(args).not.toContain(token);
        expect(args).not.toContain(DEPLOY_SECRETS.buildSecrets);
        expect(s.run ?? "").not.toContain(token);
      }
      for (const line of content.split("\n")) {
        if (line.includes(`secrets.${DEPLOY_SECRETS.buildSecrets}`)) {
          expect(line).toMatch(/^\s+(secrets: |BUILD_SECRETS: |\$\{\{)/);
        }
      }
    },
  );

  it("Dockerfile builds: non-secret values become build args, secret ones BuildKit secrets", () => {
    const push = evaluated(rendered(planFor("generated-dockerfile")), values).find(
      (s) => s.id === "push",
    );
    expect(push?.with?.["build-args"]).toBe(values[DEPLOY_SECRETS.buildEnv]);
    expect(push?.with?.secrets).toBe(values[DEPLOY_SECRETS.buildSecrets]);
  });

  it("Buildpacks gets the non-secret values with --env and never reads the secret ones", () => {
    const pack = step(buildJob(planFor("buildpacks")), "pack");
    expect(pack?.env?.BUILD_ENV).toBe(`\${{ secrets.${DEPLOY_SECRETS.buildEnv} }}`);
    expect(JSON.stringify(pack)).not.toContain(DEPLOY_SECRETS.buildSecrets);
  });

  it("Railpack lists every build value's name in its plan and reads the values as secrets", () => {
    const steps = evaluated(rendered(planFor("railpack")), values);
    const build = steps.find((s) => s.id === "railpack");
    expect(build?.with?.secrets).toContain(values[DEPLOY_SECRETS.buildEnv]);
    expect(build?.with?.secrets).toContain(values[DEPLOY_SECRETS.buildSecrets]);
    expect(build?.with?.["build-args"]).toBe(
      `BUILDKIT_SYNTAX=${IMAGES.railpackFrontend.ref}\nsecrets-hash=\${{ steps.prepare.outputs.hash }}\n`,
    );
    const prepare = step(buildJob(planFor("railpack")), "prepare");
    expect(prepare?.env).toEqual({
      BUILD_ENV: `\${{ secrets.${DEPLOY_SECRETS.buildEnv} }}`,
      BUILD_SECRETS: `\${{ secrets.${DEPLOY_SECRETS.buildSecrets} }}`,
    });
  });
});

describe("Buildpacks", () => {
  const job = buildJob(planFor("buildpacks"));

  it("installs the pinned pack after checking OpsCrew's checksum, builds build-<sha> with --env settings and seals it", () => {
    const names = job.steps.map((s) => s.id ?? s.name ?? s.uses);
    const install = names.indexOf(`Install pack ${TOOLS.pack.version}`);
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(names.indexOf("pack"));
    expect(names.indexOf("pack")).toBeLessThan(names.indexOf("Write the seal Dockerfile"));
    expect(names.indexOf("Write the seal Dockerfile")).toBeLessThan(names.indexOf("push"));
    const download = job.steps[install]?.run ?? "";
    expect(download).toContain(toolDownloadUrl("pack", "amd64"));
    expect(download).toContain(`echo "${TOOLS.pack.sha256.amd64}  `);
    expect(download.indexOf("sha256sum -c -")).toBeLessThan(download.indexOf("sudo install"));
    // Not the setup action, which checks pack against a checksum from the same release.
    expect(JSON.stringify(job)).not.toContain("setup-pack");
    const script = step(job, "pack")?.run ?? "";
    expect(script).toContain("settings=(--env BP_GO_VERSION=1.26)");
    expect(script).toContain('pack build "$NAME:build-$GITHUB_SHA"');
    expect(script).toContain('--publish --cache-image "$NAME:buildcache"');
    expect(script).not.toContain("project.toml");
    const seal = step(job, "push");
    expect(seal?.name).toBe("Seal and push the image");
    expect(seal?.with).toMatchObject({
      context: ".",
      file: "${{ runner.temp }}/seal/Dockerfile",
      "cache-from": "type=gha,scope=seal",
      "cache-to": "type=gha,mode=min,scope=seal",
    });
    expect(seal?.with?.["build-args"]).toBeUndefined();
  });

  it.each([
    ["java", "25", "BP_JVM_VERSION=25"],
    ["dotnet", "10.0", "BP_DOTNET_FRAMEWORK_VERSION=10.0"],
    ["ruby", "3.4.10", "BP_MRI_VERSION=3.4.10"],
    ["python", "3.14", "BP_CPYTHON_VERSION=3.14"],
  ] as const)("passes the %s version %s explicitly", (language, version, setting) => {
    const plan = withBuild(serverPlan(), "buildpacks", { language, version });
    expect(step(buildJob(plan), "pack")?.run).toContain(`settings=(--env ${setting})`);
  });

  it("removes the secret files .dockerignore lists from the checkout before pack builds", () => {
    const names = job.steps.map((s) => s.id ?? s.name ?? s.uses);
    const remove = names.indexOf("Keep secret files out of the Buildpacks build");
    expect(remove).toBeGreaterThan(0);
    expect(remove).toBeLessThan(names.indexOf("pack"));
    const script = job.steps[remove]?.run ?? "";
    for (const name of [".env", ".env.*", "*.pem", "*.key"]) expect(script).toContain(`'${name}'`);
    expect(script).toContain("! -name '.env.example'");
    expect(script).toContain("-name node_modules -o -name .git");
    // Only the Buildpacks build: BuildKit reads .dockerignore itself.
    for (const builder of ["generated-dockerfile", "own-dockerfile", "railpack"] as const) {
      expect(rendered(planFor(builder))).not.toContain("Buildpacks does not read .dockerignore");
    }
  });

  it("installs the arm64 pack on the arm64 runner", () => {
    const plan = withBuild(testPlan({ provider: "own", arch: "arm64" }), "buildpacks");
    const install = buildJob(plan).steps.find((s) => s.name?.startsWith("Install pack"))?.run;
    expect(install).toContain(toolDownloadUrl("pack", "arm64"));
    expect(install).toContain(TOOLS.pack.sha256.arm64);
  });
});

describe("Railpack", () => {
  it("installs the pinned CLI after checking its checksum, then plans and builds build-<sha>", () => {
    const job = buildJob(planFor("railpack"));
    const install = job.steps.find((s) => s.name === `Install Railpack ${TOOLS.railpack.version}`);
    const script = install?.run ?? "";
    expect(script).toContain(
      `https://github.com/railwayapp/railpack/releases/download/v${TOOLS.railpack.version}/railpack-v${TOOLS.railpack.version}-x86_64-unknown-linux-musl.tar.gz`,
    );
    expect(script).toContain(`echo "${TOOLS.railpack.sha256.amd64}  `);
    expect(script.indexOf("sha256sum -c -")).toBeLessThan(script.indexOf("sudo install"));
    const prepare = step(job, "prepare")?.run ?? "";
    expect(prepare).toContain('railpack prepare "." --plan-out "$RUNNER_TEMP/railpack-plan.json"');
    const build = step(job, "railpack");
    expect(build?.with).toMatchObject({
      context: ".",
      file: "${{ runner.temp }}/railpack-plan.json",
      push: true,
      tags: "${{ steps.image.outputs.name }}:build-${{ github.sha }}",
      provenance: false,
      "cache-from": "type=gha,scope=railpack",
      "cache-to": "type=gha,mode=min,scope=railpack",
    });
  });

  it.each([
    ["node", "24", "RAILPACK_NODE_VERSION=24"],
    ["python", "3.14", "RAILPACK_PYTHON_VERSION=3.14"],
    ["go", "1.26", "RAILPACK_GO_VERSION=1.26"],
    ["ruby", "4.0.7", "RAILPACK_RUBY_VERSION=4.0.7"],
    ["java", "25", "RAILPACK_JDK_VERSION=25"],
    ["dotnet", "10.0", "RAILPACK_DOTNET_VERSION=10.0"],
    ["rust", "1.98", "RAILPACK_RUST_VERSION=1.98"],
  ] as const)("hands Railpack the recorded %s version %s", (language, version, setting) => {
    const job = buildJob(withBuild(serverPlan(), "railpack", { language, version }));
    expect(step(job, "prepare")?.run).toContain(`values=(--env ${setting})`);
    // Railpack's frontend reads every value of its plan as a BuildKit secret.
    expect(String(step(job, "railpack")?.with?.secrets).split("\n")[0]).toBe(setting);
  });

  it("has no version setting to hand Railpack for PHP, which reads composer.json itself", () => {
    for (const language of ["php", "other"] as const) {
      const job = buildJob(withBuild(serverPlan(), "railpack", { language }));
      expect(step(job, "prepare")?.run).toContain("values=()");
      expect(String(step(job, "railpack")?.with?.secrets)).not.toContain("RAILPACK_");
    }
  });

  it("installs the arm64 CLI on the arm64 runner", () => {
    const plan = withBuild(testPlan({ provider: "own", arch: "arm64" }), "railpack");
    const job = buildJob(plan);
    expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
    const install = job.steps.find((s) => s.name?.startsWith("Install Railpack"))?.run ?? "";
    expect(install).toContain("-arm64-unknown-linux-musl.tar.gz");
    expect(install).toContain(TOOLS.railpack.sha256.arm64);
  });
});

function bashWorks(): boolean {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

describe.skipIf(!bashWorks())("the build scripts in bash", { timeout: 30_000 }, () => {
  let work = "";
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-build-")).replaceAll("\\", "/");
    mkdirSync(join(work, "tmp"));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const DIGEST = `sha256:${"c".repeat(64)}`;
  function bash(script: string, env: Record<string, string>) {
    const result = spawnSync("bash", ["-c", script], {
      // Never OpsCrew's own checkout: the pack step moves `.git` out of its build context.
      cwd: work,
      env: {
        ...process.env,
        RUNNER_TEMP: `${work}/tmp`,
        GITHUB_OUTPUT: `${work}/output`,
        GITHUB_SHA: "f".repeat(40),
        ...env,
      },
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
  const output = () =>
    existsSync(join(work, "output")) ? readFileSync(join(work, "output"), "utf8") : "";

  // pack writes report.toml into the folder only when it exists (R8), and logs its arguments.
  const FAKE_PACK = [
    "pack() {",
    '  printf "%s\\n" "$@" > "$RUNNER_TEMP/pack-args"',
    '  local dir="${@: -1}"',
    '  [[ -d "$dir" ]] || { echo "report written as a file" > "$dir"; return 0; }',
    `  printf '[image]\\n  tags = ["x"]\\n  digest = "${DIGEST}"\\n  manifest-size = 1\\n' > "$dir/report.toml"`,
    "}",
  ].join("\n");

  it("reads pack's digest from report.toml and passes each build value with --env", () => {
    const script = step(buildJob(planFor("buildpacks")), "pack")?.run ?? "";
    const result = bash(`${FAKE_PACK}\n${script}`, {
      NAME: "ghcr.io/acme/shop",
      BUILD_ENV: "NEXT_PUBLIC_SITE=https://shop.example.com\n# a comment\n\nA=b c\n",
    });
    expect(result.status, result.output).toBe(0);
    expect(output()).toBe(`digest=${DIGEST}\n`);
    const args = readFileSync(join(work, "tmp", "pack-args"), "utf8").split("\n");
    expect(args.slice(0, 2)).toEqual(["build", `ghcr.io/acme/shop:build-${"f".repeat(40)}`]);
    const envs = args.flatMap((a, i) => (a === "--env" ? [args[i + 1]] : []));
    expect(envs).toEqual([
      "BP_GO_VERSION=1.26",
      "NEXT_PUBLIC_SITE=https://shop.example.com",
      "A=b c",
    ]);
  });

  it("removes secret files from the Buildpacks build context, naming each and never its content", () => {
    const secretValue = fakeSecret("github-token");
    const files = {
      ".env": `TOKEN=${secretValue}\n`,
      ".env.production": "A=1\n",
      "apps/api/.env.local": "A=1\n",
      "certs/server.pem": "pem\n",
      "id.key": "key\n",
      ".env.example": "TOKEN=\n",
      "apps/api/.env.example": "A=\n",
      "node_modules/pkg/.env": "A=1\n",
      ".git/hooks/x.key": "x\n",
      "src/app.js": "app\n",
      "config.keys": "not a key file\n",
    };
    const run = (context: string) => {
      const repo = join(work, "repo");
      rmSync(repo, { recursive: true, force: true });
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      const plan = {
        ...planFor("buildpacks"),
        app: { ...planFor("buildpacks").app, buildContext: context },
      };
      const script = step(buildJob(plan), "Keep secret files out of the Buildpacks build")?.run;
      const result = bash(`cd "${repo}"\n${script}`, {});
      const left = Object.keys(files).filter((path) => existsSync(join(repo, path)));
      return { ...result, left };
    };

    const root = run(".");
    expect(root.status, root.output).toBe(0);
    expect(root.left.sort()).toEqual(
      [
        ".env.example",
        "apps/api/.env.example",
        "node_modules/pkg/.env",
        ".git/hooks/x.key",
        "src/app.js",
        "config.keys",
      ].sort(),
    );
    expect(root.output.trim().split("\n").sort()).toEqual(
      [".env", ".env.production", "apps/api/.env.local", "certs/server.pem", "id.key"]
        .map((path) => `removed ${path} from the build: Buildpacks does not read .dockerignore`)
        .sort(),
    );
    expect(root.output).not.toContain(secretValue);

    // An app folder as the context: only that folder is touched.
    const folder = run("apps/api");
    expect(folder.status, folder.output).toBe(0);
    expect(folder.output.trim()).toBe(
      "removed apps/api/.env.local from the build: Buildpacks does not read .dockerignore",
    );
    expect(folder.left).toContain(".env");
  });

  /**
   * Runs the pack step in a checkout (`work/repo`, with `.git` and an app folder) for the build
   * `context`, with a fake pack that records whether `.git` is in its `--path` and at the
   * checkout's root while it runs, then exits with `code`.
   */
  function packWithGit(context: string, code: number) {
    const repo = join(work, "repo");
    for (const dir of [".git/objects", "apps/api"]) mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, ".git/objects/blob"), "a committed file\n");
    const fakePack = [
      "pack() {",
      "  local path; path=\"$(printf '%s\\n' \"$@\" | sed -n '/^--path$/{n;p;}')\"",
      '  { [[ -e "$path/.git" ]] && echo "context: .git" || echo "context: none"',
      '    [[ -e .git ]] && echo "root: .git" || echo "root: none"; } > "$RUNNER_TEMP/pack-saw"',
      `  [[ ${code} -eq 0 ]] || return ${code}`,
      `  printf '[image]\\n  digest = "${DIGEST}"\\n' > "\${@: -1}/report.toml"`,
      "}",
    ].join("\n");
    const plan = {
      ...planFor("buildpacks"),
      app: { ...planFor("buildpacks").app, buildContext: context },
    };
    const script = step(buildJob(plan), "pack")?.run ?? "";
    const result = bash(`cd "${repo}"\n${fakePack}\n${script}`, { NAME: "ghcr.io/acme/shop" });
    return {
      ...result,
      saw: readFileSync(join(work, "tmp", "pack-saw"), "utf8"),
      restored: existsSync(join(repo, ".git/objects/blob")),
      leftInTemp: existsSync(join(work, "tmp", "opscrew-git")),
    };
  }

  it("keeps .git out of a Buildpacks build of the checkout's root and restores it after pack", () => {
    const root = packWithGit(".", 0);
    expect(root.status, root.output).toBe(0);
    expect(root.saw).toBe("context: none\nroot: none\n");
    expect(root.restored).toBe(true);
    expect(root.leftInTemp).toBe(false);
    expect(output()).toBe(`digest=${DIGEST}\n`);
  });

  it("restores .git when pack fails", () => {
    const failed = packWithGit(".", 3);
    expect(failed.status).toBe(3);
    expect(failed.saw).toBe("context: none\nroot: none\n");
    expect(failed.restored).toBe(true);
    expect(failed.leftInTemp).toBe(false);
  });

  it("leaves .git in place for an app folder, which does not contain it", () => {
    const folder = packWithGit("apps/api", 0);
    expect(folder.status, folder.output).toBe(0);
    expect(folder.saw).toBe("context: none\nroot: .git\n");
    expect(folder.restored).toBe(true);
  });

  it("stops when pack reports no digest", () => {
    const script = step(buildJob(planFor("buildpacks")), "pack")?.run ?? "";
    const noDigest = 'pack() { printf \'[image]\\n  tags = ["x"]\\n\' > "${@: -1}/report.toml"; }';
    const result = bash(`${noDigest}\n${script}`, { NAME: "ghcr.io/acme/shop" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::pack did not report the digest");
    expect(output()).toBe("");
  });

  const sealOf = (plan: DeployPlan) => {
    const seal = step(buildJob(plan), "Write the seal Dockerfile");
    const base = `ghcr.io/acme/shop:build-${"f".repeat(40)}@${DIGEST}`;
    expect(seal?.env?.BASE).toMatch(
      /^\$\{\{ steps\.image\.outputs\.name \}\}:build-\$\{\{ github\.sha \}\}@\$\{\{ steps\.\w+\.outputs\.digest \}\}$/,
    );
    const result = bash(seal?.run ?? "", { BASE: base });
    expect(result.status, result.output).toBe(0);
    return readFileSync(join(work, "tmp", "seal", "Dockerfile"), "utf8");
  };

  it("seals a Buildpacks image with FROM <build-sha>@<digest> only", () => {
    expect(sealOf(planFor("buildpacks"))).toBe(
      `FROM ghcr.io/acme/shop:build-${"f".repeat(40)}@${DIGEST}\n`,
    );
  });

  it.each([
    ["ruby", "tmp log storage db", []],
    [
      "php",
      "storage bootstrap/cache database",
      [
        // FrankenPHP's file capability cannot be granted under cap_drop ALL and no-new-privileges.
        'RUN bin="$(command -v frankenphp)" && cp "$bin" "$bin.new" && mv "$bin.new" "$bin"',
        // Laravel's storage link, made while the web root is still writable (it stays root's).
        "RUN if [ -d /app/public ]; then ln -sfn ../storage/app/public /app/public/storage; fi",
      ],
    ],
  ] as const)(
    "seals a Railpack %s image as uid 10001, owning its writable folders",
    (language, dirs, extra) => {
      const folders = dirs
        .split(" ")
        .map((d) => `/app/${d}`)
        .join(" ");
      expect(sealOf(planFor("railpack", language))).toBe(
        [
          `FROM ghcr.io/acme/shop:build-${"f".repeat(40)}@${DIGEST}`,
          `RUN mkdir -p ${folders} && chown -R 10001:10001 ${folders}`,
          ...extra,
          "USER 10001:10001",
          "",
        ].join("\n"),
      );
    },
  );

  it("seals other Railpack images as uid 10001 without a chown", () => {
    expect(sealOf(planFor("railpack", "rust"))).toBe(
      `FROM ghcr.io/acme/shop:build-${"f".repeat(40)}@${DIGEST}\nUSER 10001:10001\n`,
    );
  });

  const supercronic = (arch: PinArch) =>
    `ADD --checksum=sha256:${TOOLS.supercronic.sha256[arch]} --chmod=755 ${toolDownloadUrl("supercronic", arch)} /usr/local/bin/supercronic`;

  it.each(["own-dockerfile", "buildpacks", "railpack"] as const)(
    "%s: the seal adds supercronic when the plan has cron jobs",
    (builder) => {
      const seal = sealOf(withProcesses(planFor(builder, "ruby"), { cron: [NIGHTLY] }));
      expect(seal).toMatchSnapshot();
      const lines = seal.split("\n");
      expect(lines.filter((line) => line.startsWith("ADD "))).toEqual([supercronic("amd64")]);
      // The image keeps its user: Railpack's seal sets it last, the others never change it.
      expect(lines.filter((line) => line.startsWith("USER "))).toEqual(
        builder === "railpack" ? ["USER 10001:10001"] : [],
      );
      if (builder === "railpack") {
        expect(lines.indexOf(supercronic("amd64"))).toBeLessThan(lines.indexOf("USER 10001:10001"));
      }
    },
  );

  it("seals with the arm64 supercronic on an arm64 server", () => {
    const arm = withProcesses(
      withBuild(testPlan({ provider: "own", arch: "arm64" }), "buildpacks"),
      { cron: [NIGHTLY] },
    );
    expect(sealOf(arm)).toContain(supercronic("arm64"));
  });

  it("retries railpack prepare only on its temporary-failure exit code and hashes the non-secret values", () => {
    const script = step(buildJob(planFor("railpack")), "prepare")?.run ?? "";
    const fake = [
      'railpack() { echo "$@" >> "$RUNNER_TEMP/calls"; n=$(( $(wc -l < "$RUNNER_TEMP/calls") )); [[ $n -ge ${OK_AT:-1} ]] && return 0; return ${FAIL_CODE:-75}; }',
      "sleep() { :; }",
    ].join("\n");
    const token = fakeSecret("github-token");
    const env = { BUILD_ENV: "A=1\n", BUILD_SECRETS: `NPM_TOKEN=${token}\n` };
    const retried = bash(`${fake}\n${script}`, { ...env, OK_AT: "2" });
    expect(retried.status, retried.output).toBe(0);
    const calls = readFileSync(join(work, "tmp", "calls"), "utf8")
      .trim()
      .split("\n");
    expect(calls).toHaveLength(2);
    // Railpack gets the secret's name only; its value reaches the build as a BuildKit secret.
    expect(calls[0]).toMatch(/--env A=1 --env NPM_TOKEN=$/);
    expect(calls.join("\n")).not.toContain(token);
    const hash = spawnSync("bash", ["-c", "printf '%s' 'A=1\n' | sha256sum | cut -d ' ' -f 1"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(output()).toBe(`hash=${hash}\n`);

    rmSync(join(work, "tmp", "calls"));
    writeFileSync(join(work, "output"), "");
    const failed = bash(`${fake}\n${script}`, { ...env, OK_AT: "9", FAIL_CODE: "1" });
    expect(failed.status).toBe(1);
    expect(failed.output).toContain("::error::Railpack could not plan the build (exit code 1)");
    expect(
      readFileSync(join(work, "tmp", "calls"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });
});
