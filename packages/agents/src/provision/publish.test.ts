import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FAKE_SOPS, FakeSops } from "../secrets/__fixtures__/fake-sops";
import { provisionedFiles, VALUES, writeLocal } from "../secrets/__fixtures__/world";
import { gitClient } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  projectRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { DEPLOY_SETUP_BRANCH, publishDeploySetup } from "./publish";

const COPY_FILES = [".gitattributes", "opscrew/.sops.yaml", "opscrew/secrets.sops.json"];

/** A provisioned project (git, plan, OpsCrew's local files) whose sops is the fake. */
async function provisioned() {
  const project = await createProject();
  const keys = await mkdtemp(join(tmpdir(), "opscrew-publish-keys-"));
  const sops = new FakeSops();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { OPSCREW_HOME: join(project.root, ".home-opscrew"), OPSCREW_SOPS_BIN: FAKE_SOPS },
    runner: sops.runner(projectRunner()),
    approvalHandler: handler,
  });
  await writeLocal(deps, provisionedFiles());
  const github = new FakeGitHub();
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const publish = (options: { keyOut?: string; paths?: string[] } = {}) =>
    publishDeploySetup(deps, {
      git: gitClient(deps),
      github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      plan,
      paths: options.paths ?? ["opscrew/plan.yaml"],
      push: true,
      ...(options.keyOut !== undefined ? { recovery: { keyOut: async () => options.keyOut } } : {}),
    });
  /** The files of the last commit. */
  const committed = async () =>
    (await project.git(project.root, "show", "--name-only", "--format=", "HEAD")).split("\n");
  return { ...project, deps, keys, sops, handler, github, publish, committed };
}

describe.skipIf(!findExecutable("git"))("publishDeploySetup and the recovery copy", () => {
  it("commits the copy, .sops.yaml and .gitattributes with the deployment files when the copy changed", async () => {
    const p = await provisioned();
    const keyOut = join(p.keys, "age-key.txt");
    const published = await p.publish({ keyOut });
    expect(published).toMatchObject({ branch: DEPLOY_SETUP_BRANCH, pushed: true });
    expect((await p.committed()).sort()).toEqual([...COPY_FILES, "opscrew/plan.yaml"].sort());

    const push = p.handler.requests.find((r) => r.kind === "git-push");
    for (const file of COPY_FILES) expect(push?.details).toContain(`  ${file}`);
    expect(p.github.pulls[0]?.body).toContain(
      "- `opscrew/secrets.sops.json`: the encrypted recovery copy of what OpsCrew keeps on your computer for this app",
    );
    expect(p.deps.reporter.text()).toContain(`OpsCrew wrote your new age key to ${keyOut}.`);

    // Only the key file holds the key; nothing shown, audited or committed has it or a value.
    const identity = (await readFile(keyOut, "utf8")).split("\n")[2] as string;
    const committedText = (
      await Promise.all(COPY_FILES.map((file) => readFile(join(p.root, file), "utf8")))
    ).join("\n");
    const shown = [
      p.deps.reporter.text(),
      JSON.stringify(p.deps.audit.entries),
      JSON.stringify(p.handler.requests),
      JSON.stringify(p.github.pulls),
      committedText,
    ].join("\n");
    for (const secret of [identity, ...Object.values(VALUES)]) expect(shown).not.toContain(secret);

    // Nothing changed since: the next commit has no copy, and no key is asked for.
    await p.git(p.root, "checkout", "-q", "main");
    await p.git(p.root, "merge", "-q", DEPLOY_SETUP_BRANCH);
    await p.git(p.root, "branch", "-q", "-D", DEPLOY_SETUP_BRANCH);
    p.github.pulls.length = 0;
    await writeFile(join(p.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    await p.publish({ paths: ["opscrew/RUNBOOK.md"] });
    expect(await p.committed()).toEqual(["opscrew/RUNBOOK.md"]);
    expect(p.github.pulls[0]?.body).not.toContain("opscrew/secrets.sops.json");
    expect(p.sops.calls).toHaveLength(1);
  });

  it("without a file for the first key: the deployment files go out alone, with a warning", async () => {
    const p = await provisioned();
    await p.publish();
    expect(await p.committed()).toEqual(["opscrew/plan.yaml"]);
    expect(p.deps.reporter.lines).toContainEqual({
      level: "warn",
      message: expect.stringContaining(
        "OpsCrew has made no encrypted recovery copy of this app's secrets yet",
      ),
    });
    expect(p.sops.calls).toEqual([]);
  });

  it("stops before committing anything when another computer updated the copy", async () => {
    const p = await provisioned();
    await writeFile(join(p.root, "opscrew", "secrets.sops.json"), "{}\n");
    const before = await p.git(p.root, "rev-parse", "HEAD");
    await expect(p.publish({ keyOut: join(p.keys, "age-key.txt") })).rejects.toMatchObject({
      code: "SECRETS_COPY_CHANGED_ELSEWHERE",
    });
    expect(await p.git(p.root, "rev-parse", "HEAD")).toBe(before);
    expect(p.github.pulls).toEqual([]);
  });
});
