import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { refreshRecoveryCopy } from "@opscrew/agents";
import {
  createTestPhaseDeps,
  FAKE_SOPS,
  FakeGitHub,
  FakeSops,
  ScriptedRunner,
  testPlan,
} from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { generateAgeIdentity, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { type DeployProject, DeployRunner, deployProject } from "../ui/__fixtures__/deploy";
import { inEnvironment, withEnvironments } from "../ui/__fixtures__/environments";
import {
  auditText,
  CANCEL,
  GIT,
  git,
  projectContext,
  run,
  ScriptedPrompts,
} from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything (the scripted human). */
class ApproveAll implements ApprovalHandler {
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: true, approver: "test", decidedAt: "2026-10-21T12:00:00.000Z" };
  }
}

const DB_PASSWORD = fakeSecret("generic-password", "cli-recovery-db");
const DEPLOY_KEY = fakeSecret("private-key-pem", "cli-recovery-deploy-key");

/** What provision leaves in OpsCrew's folder for the project. */
async function writeHomeFiles(p: DeployProject, values = { dbPassword: DB_PASSWORD }) {
  const home = resolveProjectPaths(p.root, { env: p.env }).projectHomeDir;
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "generated_values.json"), `${JSON.stringify(values)}\n`);
  await writeFile(path.join(home, "deploy_key"), `${DEPLOY_KEY}\n`);
  return home;
}

/** The key line of a key file OpsCrew wrote. */
async function identityIn(file: string): Promise<string> {
  const line = (await readFile(file, "utf8"))
    .split("\n")
    .find((text) => text.startsWith("AGE-SECRET-KEY-1"));
  if (line === undefined) throw new Error(`no age key in ${file}`);
  return line;
}

/**
 * A git project whose first recovery copy is made (the key in `keyFile`, the copy and
 * `opscrew/.sops.yaml` in the working tree), with a fake sops shared by every run.
 */
async function withCopy() {
  project = await deployProject();
  project.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
  const sops = new FakeSops();
  await writeHomeFiles(project);
  const keyFile = path.join(project.dir, "age-key.txt");
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: project.env,
    runner: sops.runner(new ScriptedRunner()),
  });
  const first = await refreshRecoveryCopy(
    deps,
    { app: { name: "shop" } },
    { repositoryPrivate: async () => true, keyOut: async () => keyFile },
  );
  if (!first.changed) throw new Error("expected the first copy");
  for (const file of first.repositoryFiles) {
    await mkdir(path.dirname(path.join(project.root, file.path)), { recursive: true });
    await writeFile(path.join(project.root, file.path), file.content);
  }
  return { project, sops, keyFile, identity: await identityIn(keyFile) };
}

function context(
  p: DeployProject,
  sops: FakeSops,
  options: { interactive?: boolean; prompts?: ScriptedPrompts; approvals?: ApprovalHandler } = {},
) {
  const github = new FakeGitHub();
  const ctx = projectContext(p, {
    interactive: options.interactive ?? false,
    services: {
      runner: sops.runner(new DeployRunner()),
      approvalHandler: options.approvals ?? new ApproveAll(),
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
    },
  });
  withServices(ctx, { provision: { github } });
  return { ctx, github };
}

describe.skipIf(GIT === undefined)("opscrew secrets", () => {
  it("status shows the copy's update, its keys, whether it is behind and the folder", async () => {
    const { project, sops } = await withCopy();
    const { ctx } = context(project, sops);
    expect(await run(ctx, "secrets", "status")).toBe(0);
    expect(ctx.output).toContain(
      "Recovery copy (opscrew/secrets.sops.json), last updated 2026-10-21 10:00 UTC: 1 key can open it.",
    );
    expect(ctx.output).toContain("Up to date with the files on this computer.");
    expect(ctx.output).toContain("Folder copy: none.");

    await writeHomeFiles(project, { dbPassword: fakeSecret("generic-password", "cli-changed") });
    const later = context(project, sops).ctx;
    expect(await run(later, "secrets", "status")).toBe(0);
    expect(later.output).toContain("Behind: files on this computer changed");
  });

  it("folder sets and clears the folder copy, outside the repository only", async () => {
    const { project, sops } = await withCopy();
    const folder = path.join(project.dir, "backup");
    const set = context(project, sops).ctx;
    expect(await run(set, "secrets", "folder", folder)).toBe(0);
    expect(set.output).toContain(`OpsCrew writes the recovery copy to ${folder} as well`);
    const status = context(project, sops).ctx;
    expect(await run(status, "secrets", "status")).toBe(0);
    expect(status.output).toContain(`Folder copy: written to ${folder} as well.`);

    const inside = context(project, sops).ctx;
    expect(await run(inside, "secrets", "folder", path.join(project.root, "copies"))).toBe(2);
    expect(inside.errors).toContain("inside the repository");
    const neither = context(project, sops).ctx;
    expect(await run(neither, "secrets", "folder")).toBe(2);
    expect(neither.errors).toContain("Give either a folder or --none.");
    const cleared = context(project, sops).ctx;
    expect(await run(cleared, "secrets", "folder", "--none")).toBe(0);
    expect(cleared.output).toContain("no longer writes a folder copy");
  });

  it("restore --key-file rebuilds a lost home without printing the key or a value", async () => {
    const { project, sops, keyFile, identity } = await withCopy();
    const home = resolveProjectPaths(project.root, { env: project.env }).projectHomeDir;
    await rm(home, { recursive: true, force: true });
    const { ctx } = context(project, sops);
    expect(await run(ctx, "secrets", "restore", "--key-file", keyFile), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      "Restored 2 files from the recovery copy: home/deploy_key and home/generated_values.json.",
    );
    expect(await readFile(path.join(home, "generated_values.json"), "utf8")).toContain(DB_PASSWORD);
    const said = `${ctx.output}${ctx.errors}`;
    for (const secret of [identity, DB_PASSWORD, DEPLOY_KEY]) expect(said).not.toContain(secret);
  });

  it("restore asks for the key with a hidden prompt in a terminal, and only there", async () => {
    const { project, sops, identity } = await withCopy();
    const prompts = new ScriptedPrompts([identity]);
    const asked = context(project, sops, { interactive: true, prompts }).ctx;
    expect(await run(asked, "secrets", "restore"), asked.errors).toBe(0);
    expect(prompts.calls).toEqual([expect.objectContaining({ kind: "password" })]);
    expect(asked.output).toContain("nothing was written");
    expect(`${asked.output}${asked.errors}`).not.toContain(identity);

    const script = context(project, sops).ctx;
    expect(await run(script, "secrets", "restore")).toBe(2);
    expect(script.errors).toContain("pass the key file with `--key-file <path>`");
  });

  it("restore stops on differing files, names them without values, and --use-copy decides", async () => {
    const { project, sops, keyFile } = await withCopy();
    const changed = fakeSecret("generic-password", "cli-local");
    const home = await writeHomeFiles(project, { dbPassword: changed });
    const stopped = context(project, sops).ctx;
    expect(await run(stopped, "secrets", "restore", "--key-file", keyFile)).toBe(1);
    expect(stopped.errors).toContain(
      "These files on this computer differ from the recovery copy: home/generated_values.json. The generated values that differ: dbPassword. OpsCrew wrote nothing.",
    );
    expect(`${stopped.output}${stopped.errors}`).not.toContain(changed);
    expect(await readFile(path.join(home, "generated_values.json"), "utf8")).toContain(changed);

    const used = context(project, sops).ctx;
    expect(await run(used, "secrets", "restore", "--key-file", keyFile, "--use-copy")).toBe(0);
    expect(await readFile(path.join(home, "generated_values.json"), "utf8")).toContain(DB_PASSWORD);
  });

  it("restore with a wrong key changes nothing", async () => {
    const { project, sops } = await withCopy();
    const other = path.join(project.dir, "other-key.txt");
    await writeFile(other, `${generateAgeIdentity().identity}\n`);
    const home = resolveProjectPaths(project.root, { env: project.env }).projectHomeDir;
    await rm(path.join(home, "deploy_key"));
    const { ctx } = context(project, sops);
    expect(await run(ctx, "secrets", "restore", "--key-file", other)).toBe(2);
    expect(ctx.errors).toContain("key");
    await expect(stat(path.join(home, "deploy_key"))).rejects.toThrow();
  });

  it("rotate writes a new key only to --key-out and proposes the copy in a pull request", async () => {
    const { project, sops, identity } = await withCopy();
    await git(project.env, project.root, "add", "opscrew");
    await git(project.env, project.root, "commit", "-q", "-m", "copy");
    const keyOut = path.join(project.dir, "new-key.txt");
    const { ctx, github } = context(project, sops);
    expect(await run(ctx, "secrets", "rotate", "--key-out", keyOut), ctx.errors).toBe(0);

    const fresh = await identityIn(keyOut);
    expect(fresh).not.toBe(identity);
    expect(ctx.output).toContain(`OpsCrew wrote your new age key to ${keyOut}.`);
    expect(ctx.output).toContain("Older commits of opscrew/secrets.sops.json can still be opened");
    expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
    expect(ctx.output).toContain("Pull request: https://github.com/acme/shop/pull/7");
    const committed = await git(
      project.env,
      project.root,
      "show",
      "opscrew/deploy-setup:opscrew/.sops.yaml",
    );
    expect(committed).toContain("age1");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(fresh);
    const audit = await auditText(project);
    expect(audit).toContain('"action":"pull-request"');
    expect(audit).not.toContain(fresh);
  });

  it("rotate with the push refused keeps the commit local and says how to finish", async () => {
    const { project, sops } = await withCopy();
    await git(project.env, project.root, "add", "opscrew");
    await git(project.env, project.root, "commit", "-q", "-m", "copy");
    const keyOut = path.join(project.dir, "new-key.txt");
    const approvals: ApprovalHandler = {
      request: async (request) => ({
        approved: request.kind !== "git-push",
        approver: "test",
        decidedAt: "2026-10-21T12:00:00.000Z",
      }),
    };
    const { ctx, github } = context(project, sops, { approvals });
    expect(await run(ctx, "secrets", "rotate", "--key-out", keyOut), ctx.errors).toBe(0);
    expect(github.pulls).toEqual([]);
    expect(ctx.errors).toContain(
      "Not pushed. The commit stays on the local branch opscrew/deploy-setup; push it yourself",
    );
    expect(await git(project.env, project.root, "log", "-1", "--format=%s")).toBe(
      "chore(opscrew): rotate the recovery copy's key for shop",
    );
    const fresh = await identityIn(keyOut);
    expect(`${ctx.output}${ctx.errors}${await auditText(project)}`).not.toContain(fresh);
  });

  it("rotate asks for the key file in a terminal and refuses a script without --key-out", async () => {
    const { project, sops } = await withCopy();
    const script = context(project, sops).ctx;
    expect(await run(script, "secrets", "rotate")).toBe(2);
    expect(script.errors).toContain("OpsCrew never prints a key");

    const cancel = context(project, sops, {
      interactive: true,
      prompts: new ScriptedPrompts([CANCEL]),
    }).ctx;
    expect(await run(cancel, "secrets", "rotate")).toBe(1);
    expect(cancel.errors).toContain("You cancelled the key rotation, so nothing was written.");

    const keyOut = path.join(project.dir, "asked-key.txt");
    const prompts = new ScriptedPrompts([keyOut]);
    const asked = context(project, sops, { interactive: true, prompts }).ctx;
    expect(await run(asked, "secrets", "rotate", "--no-backup"), asked.errors).toBe(0);
    expect(prompts.calls[0]?.message).toContain("Where should OpsCrew write your new age key");
    expect(`${asked.output}${asked.errors}`).not.toContain(await identityIn(keyOut));
  });

  it("names the environment in the commands its hints suggest", async () => {
    const staged = await withEnvironments({ staging: inEnvironment(testPlan(), "staging") });
    try {
      const restore = projectContext(staged);
      expect(await run(restore, "secrets", "restore", "--env", "staging")).toBe(2);
      expect(restore.errors).toContain("`opscrew secrets restore --env staging` in a terminal");
      const rotate = projectContext(staged);
      expect(await run(rotate, "secrets", "rotate", "--env", "staging")).toBe(2);
      expect(rotate.errors).toContain("`opscrew secrets rotate --env staging` in a terminal");
      const folder = projectContext(staged);
      expect(await run(folder, "secrets", "folder", "--env", "staging")).toBe(2);
      expect(folder.errors).toContain("`opscrew secrets folder --env staging --none`");
    } finally {
      await staged.cleanup();
    }
  });
});
