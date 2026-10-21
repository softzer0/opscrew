import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { gitClient } from "../shared";
import {
  createProject,
  FakeGitHub,
  projectRunner,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { FakeSops } from "./__fixtures__/fake-sops";
import {
  provisionedFiles,
  recoveryWorld,
  writeLocal,
  writeRepositoryFiles,
} from "./__fixtures__/world";
import { refreshRecoveryCopy } from "./copy";
import { COPY_PATH } from "./files";
import { publishRotatedKey } from "./publish";
import { SOPS_CONFIG_PATH } from "./store";

/** A git project with its first recovery copy committed on main, and approvals `answer` gives. */
async function rotatable(answer: (kind: string) => boolean = () => true) {
  const project = await createProject();
  const sops = new FakeSops();
  const approvalHandler = new ScriptedApprovalHandler((request) => answer(request.kind));
  const world = await recoveryWorld({
    root: project.root,
    sops,
    runner: sops.runner(projectRunner()),
    approvalHandler,
  });
  await writeLocal(world.deps, provisionedFiles());
  const first = await refreshRecoveryCopy(
    world.deps,
    { app: { name: "shop" } },
    { repositoryPrivate: async () => true, keyOut: async () => join(world.keys, "first.txt") },
  );
  if (!first.changed) throw new Error("expected the first copy");
  await writeRepositoryFiles(project.root, first.repositoryFiles);
  await project.git(project.root, "add", "opscrew", ".gitattributes");
  await project.git(project.root, "commit", "-m", "copy");
  const github = { api: new FakeGitHub(), owner: "acme", repo: "shop", defaultBranch: "main" };
  return { ...world, project, github, approvalHandler, git: gitClient(world.deps) };
}

describe.skipIf(findExecutable("git") === undefined)("publishRotatedKey", () => {
  it("commits the copy on the deploy branch and opens its own pull request", async () => {
    const r = await rotatable();
    const keyOut = join(r.keys, "new.txt");
    const result = await publishRotatedKey(r.deps, {
      git: r.git,
      github: r.github,
      plan: testPlan(),
      keyOut,
      backup: null,
    });
    expect(result).toMatchObject({ branch: "opscrew/deploy-setup", pushed: true });
    expect(result.handover.path).toBe(keyOut);
    const [pull] = r.github.api.pulls;
    expect(pull?.title).toBe("Rotate the recovery copy's key");
    expect(pull?.body).toContain(`\`${COPY_PATH}\`: the copy, encrypted again to the new key.`);
    expect(pull?.body).toContain("The backup key is dropped.");
    expect(pull?.body).toContain("Older commits of opscrew/secrets.sops.json can still be opened");
    const log = await r.project.git(
      r.project.root,
      "log",
      "-1",
      "--format=%s",
      "opscrew/deploy-setup",
    );
    expect(log).toBe("chore(opscrew): rotate the recovery copy's key for shop");
    const committed = await r.project.git(
      r.project.root,
      "show",
      `opscrew/deploy-setup:${SOPS_CONFIG_PATH}`,
    );
    const identity = (await readFile(keyOut, "utf8")).split("\n")[2] as string;
    expect(committed).toContain("age1");
    expect(JSON.stringify([result, r.github.api.pulls, r.approvalHandler.requests])).not.toContain(
      identity,
    );
  });

  it("without an approved push keeps the commit local and says how to finish", async () => {
    const r = await rotatable((kind) => kind !== "git-push");
    const result = await publishRotatedKey(r.deps, {
      git: r.git,
      github: r.github,
      plan: testPlan(),
      keyOut: join(r.keys, "new.txt"),
    });
    expect(result.pushed).toBe(false);
    expect(r.github.api.pulls).toEqual([]);
    expect(r.deps.reporter.lines.map((m) => m.message).join("\n")).toContain(
      "Not pushed. The commit stays on the local branch opscrew/deploy-setup; push it yourself and open a pull request into main.",
    );
  });
});
