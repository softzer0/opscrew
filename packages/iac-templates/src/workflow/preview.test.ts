// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax in expected lines, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { ACTIONS } from "../pins";
import { previewPlan } from "../previews/__fixtures__/plans";
import { withBuild } from "./__fixtures__/plans";
import { pushPaths } from "./paths";
import { previewWorkflowPath, renderPreviewWorkflow } from "./preview";

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  shell?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Job {
  name: string;
  needs?: string | string[];
  if?: string;
  "runs-on": string;
  environment?: string | Record<string, unknown>;
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

/** The preview workflow of `plan` (the preview environment with its secrets in a GitHub one). */
const render = (plan = previewPlan({ secrets: "environment" }), ctx = testContext()) =>
  renderPreviewWorkflow(plan, ctx);
const workflow = (plan?: DeployPlan) =>
  parse(render(plan).content) as {
    name: string;
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
/** The step of `job` with this id or name. */
function step(job: Job | undefined, which: string): Step {
  const found = job?.steps.find((s) => s.id === which || s.name === which);
  if (found === undefined) throw new Error(`No step ${which}.`);
  return found;
}

const OWN_PULL =
  "github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'";

describe("renderPreviewWorkflow", () => {
  const flow = workflow();

  it("writes opscrew-preview.yml, a further app's opscrew-preview-<key>.yml", () => {
    expect(render().path).toBe(".github/workflows/opscrew-preview.yml");
    expect(render().kind).toBe("workflow");
    const docs = previewPlan({ key: "docs" });
    expect(render(docs).path).toBe(".github/workflows/opscrew-preview-docs.yml");
    expect(previewWorkflowPath(docs)).toBe(".github/workflows/opscrew-preview-docs.yml");
    expect(workflow(docs).name).toBe("OpsCrew preview docs");
    expect(flow.name).toBe("OpsCrew preview");
  });

  it("runs on pull_request with its types and the app's paths, never pull_request_target", () => {
    expect(Object.keys(flow.on)).toEqual(["pull_request"]);
    const plan = previewPlan({ secrets: "environment" });
    const path = ".github/workflows/opscrew-preview.yml";
    expect(flow.on.pull_request).toEqual({
      types: ["opened", "synchronize", "reopened", "ready_for_review", "closed"],
      paths: pushPaths({ ...plan, cicd: { ...plan.cicd, workflowPath: path } }, ["Dockerfile"], {}),
    });
    expect((flow.on.pull_request as { paths: string[] }).paths).toContain(path);
    expect(render().content).not.toContain("pull_request_target");
    // An app in a folder is filtered to it.
    const folder = DeployPlanSchema.parse({ ...plan, app: { ...plan.app, buildContext: "web" } });
    expect((workflow(folder).on.pull_request as { paths: string[] }).paths).toEqual([
      "web/**",
      "Dockerfile",
      path,
    ]);
  });

  it("reads contents only by default and runs one group per pull request, cancelling the older run", () => {
    expect(flow.permissions).toEqual({ contents: "read" });
    expect(flow.concurrency).toEqual({
      group: "opscrew-preview-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    expect(workflow(previewPlan({ key: "docs" })).concurrency.group).toBe(
      "opscrew-preview-docs-${{ github.event.pull_request.number }}",
    );
  });

  it("has the jobs skipped, build, deploy, report and remove, each with only its permissions", () => {
    expect(Object.keys(flow.jobs)).toEqual(["skipped", "build", "deploy", "report", "remove"]);
    expect(flow.jobs.skipped?.permissions).toEqual({});
    expect(flow.jobs.build?.permissions).toEqual({ contents: "read", packages: "write" });
    expect(flow.jobs.deploy?.permissions).toEqual({ contents: "read", packages: "read" });
    expect(flow.jobs.report?.permissions).toEqual({
      packages: "write",
      "pull-requests": "write",
    });
    expect(flow.jobs.remove?.permissions).toEqual({
      deployments: "write",
      packages: "write",
      "pull-requests": "write",
    });
  });

  it("runs every job only for same-repository pull requests that are not Dependabot's", () => {
    for (const [id, job] of Object.entries(flow.jobs)) {
      if (id === "skipped") {
        expect(job.if).toBe(`\${{ !(${OWN_PULL}) && github.event.action != 'closed' }}`);
        expect(step(job, "Say why there is no preview").run).toContain('>> "$GITHUB_STEP_SUMMARY"');
      } else {
        expect(job.if).toContain(OWN_PULL);
      }
      expect(job["runs-on"]).toBe("ubuntu-latest");
    }
  });

  it("builds, deploys and reports only for open pull requests ready for review; removes on close", () => {
    const ready = `${OWN_PULL} && github.event.action != 'closed' && !github.event.pull_request.draft`;
    expect(flow.jobs.build?.if).toBe(`\${{ ${ready} }}`);
    expect(flow.jobs.deploy?.if).toBe(`\${{ ${ready} }}`);
    expect(flow.jobs.deploy?.needs).toBe("build");
    expect(flow.jobs.report?.if).toBe(`\${{ !cancelled() && ${ready} }}`);
    expect(flow.jobs.report?.needs).toEqual(["build", "deploy"]);
    expect(flow.jobs.remove?.if).toBe(`\${{ ${OWN_PULL} && github.event.action == 'closed' }}`);
  });

  it("deploys in the preview's GitHub environment with its address; removes without a deployment", () => {
    expect(flow.jobs.deploy?.environment).toEqual({
      name: "preview",
      url: "https://pr-${{ github.event.pull_request.number }}.shop.example.com",
    });
    expect(flow.jobs.remove?.environment).toEqual({ name: "preview", deployment: false });
    const inactive = step(flow.jobs.remove, "Mark the pull request's deployments inactive");
    expect(inactive.run).toContain('-f environment=preview -f ref="$HEAD_REF"');
    expect(inactive.run).toContain("-f state=inactive");
    expect(inactive.env?.HEAD_REF).toBe("${{ github.head_ref }}");
    expect(
      workflow(previewPlan({ key: "docs", secrets: "environment" })).jobs.deploy?.environment,
    ).toMatchObject({ name: "docs-preview" });
  });

  it("uses no GitHub environment while its secrets are prefixed repository secrets", () => {
    const jobs = workflow(previewPlan()).jobs;
    expect(jobs.deploy?.environment).toBeUndefined();
    expect(jobs.remove?.environment).toBeUndefined();
    expect(jobs.remove?.steps.map((s) => s.name)).not.toContain(
      "Mark the pull request's deployments inactive",
    );
  });

  it("builds the pull request's image as pr-<n>-<commit>, with no signing, deploy tag or label", () => {
    const build = flow.jobs.build;
    expect(step(build, "image").run).toContain(
      'echo "image=ghcr.io/${repo}:pr-${{ github.event.pull_request.number }}-${GITHUB_SHA}" >> "$GITHUB_OUTPUT"',
    );
    expect(build?.outputs).toEqual({
      image: "${{ steps.final.outputs.ref }}",
      tag: "${{ steps.image.outputs.image }}",
    });
    const pack = workflow(withBuild(previewPlan(), "buildpacks")).jobs.build;
    expect(step(pack, "pack").run).toContain(
      'pack build "$NAME:build-pr-${{ github.event.pull_request.number }}-$GITHUB_SHA"',
    );
    expect(step(pack, "pack").run).toContain('--cache-image "$NAME:buildcache-preview"');
    expect(step(pack, "Write the seal Dockerfile").env?.BASE).toContain(
      ":build-pr-${{ github.event.pull_request.number }}-${{ github.sha }}@",
    );
    for (const id of ["sign", "tag", "label", "prune", "verify", "paused"]) {
      expect(flow.jobs[id]).toBeUndefined();
    }
  });

  it("sends the registry token only from the deploy job, on stdin, with the pinned host key", () => {
    const content = render().content;
    expect(content.match(/REGISTRY_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g)).toHaveLength(1);
    const up = step(flow.jobs.deploy, "up");
    expect(up.env?.REGISTRY_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(up.run).toContain(
      'out="$(printf \'%s\\n\' "$REGISTRY_TOKEN" | ssh "${ssh_opts[@]}" "deploy@${HOST}" "up $NUMBER $IMAGE $COMMIT")" || code=$?',
    );
    expect(up.run).toContain("-o StrictHostKeyChecking=yes");
    expect(up.env).toMatchObject({
      HOST: "${{ secrets.OPSCREW_PREVIEW_HOST }}",
      NUMBER: "${{ github.event.pull_request.number }}",
      COMMIT: "${{ github.event.pull_request.head.sha }}",
      URL: "https://pr-${{ github.event.pull_request.number }}.shop.example.com/api/health",
    });
    const ssh = step(flow.jobs.deploy, "Configure SSH with the pinned host key");
    expect(ssh.env).toEqual({
      SSH_KEY: "${{ secrets.OPSCREW_PREVIEW_SSH_PRIVATE_KEY }}",
      KNOWN_HOSTS: "${{ secrets.OPSCREW_PREVIEW_SSH_KNOWN_HOSTS }}",
    });
    expect(step(flow.jobs.remove, "down").run).toContain(
      'out="$(ssh "${ssh_opts[@]}" "deploy@${HOST}" "down $NUMBER" < /dev/null)" || code=$?',
    );
    const own = render(previewPlan({ provider: "own" }), testContext({ sshPort: 2222 })).content;
    expect(own).toContain("-o ConnectTimeout=20 -o Port=2222)");
  });

  it("pins every action by commit from the pin table", () => {
    const pinned = new Set<string>(Object.values(ACTIONS));
    const uses = [
      ...render(withBuild(previewPlan(), "railpack")).content.matchAll(/uses: (.+)$/gm),
    ];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref] of uses) expect(pinned.has(ref ?? "")).toBe(true);
  });

  it("reads only the preview environment's secrets and the job's token, and holds no value", () => {
    const content = render().content;
    const names = new Set(
      [...content.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map((m) => m[1]),
    );
    expect([...names].sort()).toEqual([
      "GITHUB_TOKEN",
      "OPSCREW_PREVIEW_BUILD_ENV",
      "OPSCREW_PREVIEW_BUILD_SECRETS",
      "OPSCREW_PREVIEW_HOST",
      "OPSCREW_PREVIEW_SSH_KNOWN_HOSTS",
      "OPSCREW_PREVIEW_SSH_PRIVATE_KEY",
    ]);
    expect(content).not.toMatch(/echo "?\$(SSH_KEY|KNOWN_HOSTS|REGISTRY_TOKEN|GH_TOKEN|TOKEN)/);
  });

  it("refuses a plan without previews", () => {
    const plan = previewPlan();
    const { previews: _previews, ...environment } = plan.environment ?? { name: "preview" };
    expect(() =>
      renderPreviewWorkflow({ ...plan, environment } as DeployPlan, testContext()),
    ).toThrow("which has no previews");
  });

  it("matches the snapshot", () => {
    expect(render().content).toMatchSnapshot();
  });
});

/** Runs `script` with bash after `prelude` (fakes), with `env`; returns the run and its outputs. */
async function bash(prelude: string, script: string, env: Record<string, string>) {
  const dir = (await mkdtemp(join(tmpdir(), "opscrew-preview-"))).replaceAll("\\", "/");
  try {
    await writeFile(`${dir}/output`, "");
    const result = await new NodeCommandRunner().run("bash", ["-s"], {
      env: { ...process.env, ...env, FAKE: dir, GITHUB_OUTPUT: `${dir}/output` },
      // On standard input: Git Bash on Windows splits a multi-line `-c` argument wrongly.
      input: `${prelude}\n${script}`,
    });
    const read = async (name: string) => readFile(`${dir}/${name}`, "utf8").catch(() => "");
    const outputs = Object.fromEntries(
      (await read("output"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ) as Record<string, string>;
    return {
      ...result,
      outputs,
      stdin: await read("stdin"),
      args: await read("args"),
      calls: await read("calls"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the deploy job's answer from the preview server", () => {
  const flow = workflow();
  const up = step(flow.jobs.deploy, "up").run ?? "";
  const down = step(flow.jobs.remove, "down").run ?? "";
  const token = fakeSecret("github-token");
  const image = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;
  const commit = "b".repeat(40);
  /** ssh prints FAKE_OUT and exits FAKE_CODE; curl answers FAKE_CURL; sleep only moves the clock. */
  const fakes = [
    'ssh() { cat > "$FAKE/stdin"; printf \'%s\\n\' "$@" > "$FAKE/args"; printf \'%s\' "$FAKE_OUT"; return "$FAKE_CODE"; }',
    'curl() { return "${FAKE_CURL:-0}"; }',
    "sleep() { SECONDS=$((SECONDS + $1)); }",
  ].join("\n");
  const env = (out: string, code: number, extra: Record<string, string> = {}) => ({
    HOST: "203.0.113.10",
    IMAGE: image,
    NUMBER: "42",
    COMMIT: commit,
    URL: "https://pr-42.shop.example.com/api/health",
    REGISTRY_TOKEN: token,
    FAKE_OUT: out,
    FAKE_CODE: String(code),
    ...extra,
  });
  const answer = async (out: string, code: number, extra: Record<string, string> = {}) =>
    (await bash(fakes, up, env(out, code, extra))).outputs;

  const rows: [string, number, string][] = [
    ["running", 0, "pr-42.shop.example.com"],
    ["seed-failed", 5, "pr-42.shop.example.com"],
    ...["request", "number", "image", "commit", "token", "command"].map(
      (detail): [string, number, string] => ["refused", 2, detail],
    ),
    ["cap", 3, "3/3"],
    ...["pull", "release", "start", "health", "edge"].map((detail): [string, number, string] => [
      "failed",
      4,
      detail,
    ]),
    ["busy", 6, "600"],
  ];
  it.each(rows)("reads %s (exit %i, %s) from the last line", async (state, code, detail) => {
    const out = `opscrew-preview: pulling\nsomething else\nopscrew-preview: ${state} ${detail}`;
    expect(await answer(out, code)).toEqual({ state, detail });
  });

  it.each([
    ["a state with another exit code", "opscrew-preview: running pr-42.shop.example.com", 4],
    ["another preview's address", "opscrew-preview: running pr-43.shop.example.com", 0],
    ["a detail outside the contract", "opscrew-preview: failed disk", 4],
    ["a cap that is no count", "opscrew-preview: cap 3/3;id", 3],
    ["text after the answer", "opscrew-preview: running pr-42.shop.example.com\nhello", 0],
    ["a state the contract lacks", "opscrew-preview: exploded 1", 7],
    ["no answer", "", 1],
    ["removed in reply to up", "opscrew-preview: removed 42", 0],
  ])("takes %s as an error", async (_, out, code) => {
    expect(await answer(out, code)).toEqual({ state: "error", detail: "" });
  });

  it("takes SSH's own failure as unreachable", async () => {
    expect(await answer("", 255)).toEqual({ state: "unreachable", detail: "" });
  });

  it("sends the token on stdin only, and shows none of the server's lines", async () => {
    const out =
      "opscrew-preview: step said something private\nopscrew-preview: running pr-42.shop.example.com";
    const run = await bash(fakes, up, env(out, 0));
    expect(run.stdin).toBe(`${token}\n`);
    expect(run.args).toContain(`up 42 ${image} ${commit}`);
    expect(run.args).not.toContain(token);
    expect(run.stdout + run.stderr).not.toContain(token);
    expect(run.stdout + run.stderr).not.toContain("private");
    expect(run.stdout).toContain("The preview server answered: running pr-42.shop.example.com");
  });

  it("is unanswered when the address does not answer within 3 minutes", async () => {
    const out = "opscrew-preview: running pr-42.shop.example.com";
    expect(await answer(out, 0, { FAKE_CURL: "7" })).toEqual({ state: "unanswered", detail: "" });
  });

  it("refuses an image that is not a GHCR digest before calling the server", async () => {
    const run = await bash(fakes, up, env("", 0, { IMAGE: "ghcr.io/acme/shop:latest" }));
    expect(run.exitCode).toBe(1);
    expect(run.args).toBe("");
    expect(run.outputs).toEqual({});
  });

  it("reads removed from down, and nothing else as removed", async () => {
    const run = await bash(fakes, down, env("opscrew-preview: removed 42", 0));
    expect(run.outputs).toEqual({ state: "removed", detail: "42" });
    expect(run.args).toContain("down 42");
    expect(run.stdin).toBe("");
    expect((await bash(fakes, down, env("opscrew-preview: removed 41", 0))).outputs.state).toBe(
      "error",
    );
    expect((await bash(fakes, down, env("opscrew-preview: busy 600", 6))).outputs.state).toBe(
      "busy",
    );
  });
});

describe("the preview's comment", () => {
  const flow = workflow();
  const report = step(flow.jobs.report, "Update the preview's comment");
  const removal = step(flow.jobs.remove, "Update the preview's comment");
  const marker = "<!-- opscrew-preview:shop-preview -->";
  const commit = "c".repeat(40);
  /**
   * gh lists FAKE_IDS for the comments' query and records every other call's arguments (each
   * ended by NUL, each call by the record separator).
   */
  const fakes =
    'gh() { if [[ "$*" == *"--jq"* ]]; then printf \'%s\' "${FAKE_IDS:-}"; else printf \'%s\\0\' "$@" >> "$FAKE/calls"; printf \'\\036\' >> "$FAKE/calls"; fi; }';
  /** The comment `state` and `detail` give, and the call that wrote it. */
  async function comment(
    state: string,
    detail = "",
    o: { ids?: string; commit?: string; script?: string } = {},
  ) {
    const run = await bash(fakes, o.script ?? report.run ?? "", {
      NUMBER: "42",
      COMMIT: o.commit ?? commit,
      STATE: state,
      DETAIL: detail,
      RUN_URL: "https://github.com/acme/shop/actions/runs/7",
      GITHUB_REPOSITORY: "acme/shop",
      FAKE_IDS: o.ids ?? "",
    });
    expect(run.exitCode, run.stderr).toBe(0);
    const call =
      run.calls
        .split("\x1e")
        .filter((c) => c.length > 0)[0]
        ?.split("\0") ?? [];
    const body = call.find((arg) => arg.startsWith("body="))?.slice("body=".length);
    return { call, body };
  }

  it.each([
    ["running", "", "runs at https://pr-42.shop.example.com (commit `cccccccccccc`)."],
    ["seed-failed", "", "its seed command failed"],
    ["refused", "image", "refused the request (the image is not the app's own image"],
    ["refused", "token", "(the registry token was missing or too long)"],
    ["refused", "command", "(the preview key may only start, update, remove and list previews)"],
    ["refused", "number", "(the request did not have the form the recipe accepts)"],
    ["cap", "3/3", "already runs 3 previews, its limit of 3."],
    ["failed", "pull", "failed at pulling the image"],
    ["failed", "release", "failed at the release command"],
    ["failed", "start", "failed at starting the app"],
    ["failed", "health", "failed at the app's health check"],
    ["failed", "edge", "failed at routing the address to the app"],
    ["busy", "600", "busy with another request for more than 10 minutes"],
    ["unreachable", "", "could not reach the preview server over SSH"],
    ["unanswered", "", "did not answer at https://pr-42.shop.example.com within 3 minutes"],
    [
      "build-failed",
      "",
      "the image did not build. The workflow run says why: https://github.com/acme/shop/actions/runs/7",
    ],
    ["removed", "", "The preview was removed with its data"],
    ["remove-failed", "", "after 7 days without a push"],
    ["error", "", "the preview server gave an answer it does not know"],
  ])("says what %s (%s) means, under its marker", async (state, detail, text) => {
    const { body } = await comment(state, detail);
    expect(body?.startsWith(`${marker}\n\n`)).toBe(true);
    expect(body).toContain(text);
  });

  it("names the commands for this app's environment", async () => {
    expect((await comment("failed", "start")).body).toContain(
      "`opscrew preview logs 42 --env preview` shows the app's logs.",
    );
  });

  it.each([
    ["an unknown state", "hacked", "x"],
    ["a cap that is no count", "cap", "3/3`rm`"],
  ])("gives the generic text for %s, never its words", async (_, state, detail) => {
    const { body } = await comment(state, detail);
    expect(body).toContain("the preview server gave an answer it does not know");
    expect(body).not.toContain(detail);
    expect(body).not.toContain(state);
  });

  it("writes no detail but a cap's count, and no commit that is not one", async () => {
    expect((await comment("failed", "disk")).body).toContain("failed at one of its steps");
    expect((await comment("failed", "disk")).body).not.toContain("disk");
    const odd = await comment("running", "", { commit: "$(id)" });
    expect(odd.body).toContain("(commit `unknown`)");
  });

  it("edits the comment it finds by its marker, or creates one", async () => {
    const edited = await comment("running", "", { ids: "17\n23" });
    expect(edited.call.slice(0, 3)).toEqual(["api", "--method", "PATCH"]);
    expect(edited.call).toContain("repos/acme/shop/issues/comments/17");
    const created = await comment("running");
    expect(created.call).toContain("repos/acme/shop/issues/42/comments");
    expect(report.run).toContain(
      `--jq ".[] | select(.user.login == \\"github-actions[bot]\\" and (.body | startswith(\\"${marker}\\"))) | .id"`,
    );
  });

  it("on removal only edits a comment that exists", async () => {
    expect((await comment("removed", "", { script: removal.run ?? "" })).call).toEqual([]);
    const edited = await comment("removed", "", { ids: "17", script: removal.run ?? "" });
    expect(edited.call).toContain("repos/acme/shop/issues/comments/17");
    expect(removal.env?.STATE).toBe(
      "${{ steps.down.outputs.state == 'removed' && 'removed' || 'remove-failed' }}",
    );
  });

  it("takes the report's state from the deploy, or the build's failure", () => {
    expect(report.env?.STATE).toBe(
      "${{ needs.deploy.outputs.state || (needs.build.result == 'failure' && 'build-failed') || 'error' }}",
    );
    expect(report.env?.DETAIL).toBe("${{ needs.deploy.outputs.detail }}");
  });
});

describe("the preview workflow's image cleanup steps", () => {
  const flow = workflow();

  it("deletes after the report the images of closed pull requests and this one's but the running", () => {
    const images = step(flow.jobs.report, "Delete the images of pull requests no longer open");
    expect(images.shell).toBe("node {0}");
    expect(images.env).toEqual({
      TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      NUMBER: "${{ github.event.pull_request.number }}",
      RUNNING:
        "${{ (needs.deploy.outputs.state == 'running' || needs.deploy.outputs.state == 'seed-failed') && needs.build.outputs.image || '' }}",
    });
    expect(images.run).toContain("function previewPrunable(");
    expect(images.run?.trimEnd().endsWith("main();")).toBe(true);
  });

  it("deletes every image of the closed pull request on removal, whatever the server said", () => {
    const images = step(flow.jobs.remove, "Delete the images of pull requests no longer open");
    expect(images.if).toBe("${{ !cancelled() }}");
    expect(images.env).toEqual({
      TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      NUMBER: "${{ github.event.pull_request.number }}",
    });
  });
});

/** actionlint, when this machine has it. */
const actionlint = spawnSync("actionlint", ["-version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!actionlint)("actionlint on the preview workflows (when installed)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "opscrew-actionlint-"));
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds nothing", async () => {
    const flows = {
      "plain.yml": render(),
      "prefixed.yml": render(previewPlan()),
      "buildpacks.yml": render(withBuild(previewPlan(), "buildpacks")),
      "railpack.yml": render(withBuild(previewPlan({ key: "docs" }), "railpack")),
      "own.yml": render(previewPlan({ provider: "own" }), testContext({ sshPort: 2222 })),
    };
    const paths: string[] = [];
    for (const [name, file] of Object.entries(flows)) {
      paths.push(join(".github", "workflows", name));
      await writeFile(join(dir, ".github", "workflows", name), file.content);
    }
    const result = spawnSync("actionlint", ["-no-color", ...paths], { cwd: dir, encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

if (!actionlint) {
  console.warn("Skipped actionlint on the preview workflows: actionlint is not on PATH.");
}
