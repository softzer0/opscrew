// Feature 025 (T2511): `opscrew rotate recovery-key`, which took over `opscrew secrets rotate`.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, findExecutable } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeSops } from "../secrets/__fixtures__/fake-sops";
import {
  provisionedFiles,
  recoveryWorld,
  writeLocal,
  writeRepositoryFiles,
} from "../secrets/__fixtures__/world";
import { refreshRecoveryCopy } from "../secrets/copy";
import { COPY_PATH } from "../secrets/files";
import { SOPS_CONFIG_PATH } from "../secrets/store";
import { gitClient } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import {
  createProject,
  FakeGitHub,
  projectRunner,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { publishRotatedKey } from "./addons";
import { credentialsRecordFile } from "./record";

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
    // The rotation is recorded, committed with the copy, and the copy holds its generation, so
    // another computer's provision asks for a restore with the new key first.
    const record = await readArtifact("credentials", credentialsRecordFile(r.deps.paths));
    expect(record.environments.prod?.["recovery-key"]).toMatchObject({ generation: 2 });
    expect(pull?.body).toContain(
      "- `opscrew/credentials.yaml`: when the key was rotated (no value).",
    );
    const recordCommitted = await r.project.git(
      r.project.root,
      "show",
      "opscrew/deploy-setup:opscrew/credentials.yaml",
    );
    expect(recordCommitted).toContain("recovery-key:");
    const generated = JSON.parse(await readFile(generatedValuesFile(r.deps), "utf8"));
    expect(generated.generations).toEqual({ "recovery-key": 2 });
  });

  it("leaves the record and the generations as they were when no new key was made", async () => {
    const r = await rotatable();
    const generated = await readFile(generatedValuesFile(r.deps), "utf8");
    // A key is never written over a file, so this run makes none.
    const keyOut = join(r.keys, "taken.txt");
    await writeFile(keyOut, "the user's own file\n");
    const error = await publishRotatedKey(r.deps, {
      git: r.git,
      github: r.github,
      plan: testPlan(),
      keyOut,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(await exists(credentialsRecordFile(r.deps.paths))).toBe(false);
    expect(await readFile(generatedValuesFile(r.deps), "utf8")).toBe(generated);
    expect(r.github.api.pulls).toEqual([]);
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
