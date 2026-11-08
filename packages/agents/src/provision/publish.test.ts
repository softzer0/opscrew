import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
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
import { DEPLOY_SETUP_BRANCH, publishDeploySetup, type RecoveryCopy } from "./publish";

const COPY_FILES = [".gitattributes", "opscrew/.sops.yaml", "opscrew/secrets.sops.json"];
const OPEN = { number: 7, url: "https://github.com/acme/shop/pull/7" };

/** A provisioned project (git, plan, OpsCrew's local files) whose sops is the fake. */
async function provisioned() {
  const project = await createProject();
  const keys = await mkdtemp(join(tmpdir(), "opscrew-publish-keys-"));
  const sops = new FakeSops();
  /** Which approvals the user refuses, and whether git cannot diff the branch against its base. */
  const world = { deny: (_request: { kind: string; title: string }) => false, failDiff: false };
  const handler = new ScriptedApprovalHandler((request) => !world.deny(request));
  const inner = sops.runner(projectRunner());
  const runner: CommandRunner = {
    run: (command, args, options) =>
      world.failDiff && args.some((arg) => arg.endsWith("...HEAD"))
        ? Promise.resolve({ exitCode: 128, stdout: "", stderr: "fatal: no merge base" })
        : inner.run(command, args, options),
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { OPSCREW_HOME: join(project.root, ".home-opscrew"), OPSCREW_SOPS_BIN: FAKE_SOPS },
    runner,
    approvalHandler: handler,
  });
  await writeLocal(deps, provisionedFiles());
  const github = new FakeGitHub();
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const workflowPath = plan.cicd.workflowPath;
  const publish = (
    options: { keyOut?: string; paths?: string[]; recoveryCopy?: RecoveryCopy } = {},
  ) =>
    publishDeploySetup(deps, {
      git: gitClient(deps),
      github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      plan,
      paths: options.paths ?? ["opscrew/plan.yaml"],
      push: true,
      ...(options.keyOut !== undefined ? { recovery: { keyOut: async () => options.keyOut } } : {}),
      ...(options.recoveryCopy !== undefined ? { recoveryCopy: options.recoveryCopy } : {}),
    });
  /** Writes the deploy workflow (`content`), which the first setup adds. */
  const writeWorkflow = async (content = "name: deploy\n") => {
    await mkdir(join(project.root, ".github", "workflows"), { recursive: true });
    await writeFile(join(project.root, workflowPath), content);
  };
  /** The first setup's run: the plan and the deploy workflow. */
  const firstSetup = async (options: { keyOut?: string } = {}) => {
    await writeWorkflow();
    return publish({ ...options, paths: ["opscrew/plan.yaml", workflowPath] });
  };
  /** The files of the last commit. */
  const committed = async () =>
    (await project.git(project.root, "show", "--name-only", "--format=", "HEAD")).split("\n");
  /** Merges the deploy branch into main, as merging its pull request does, and leaves it. */
  const merge = async () => {
    await project.git(project.root, "checkout", "-q", "main");
    await project.git(project.root, "merge", "-q", DEPLOY_SETUP_BRANCH);
    await project.git(project.root, "branch", "-q", "-D", DEPLOY_SETUP_BRANCH);
    github.pulls.length = 0;
  };
  /**
   * After the first setup is merged, a run that adds the runbook opens its pull request on
   * `-2` (the merged branch is still on GitHub), which then stays open.
   */
  const openRunbookPull = async () => {
    await firstSetup();
    await merge();
    await writeFile(join(project.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    const { branch } = await publish({ paths: ["opscrew/RUNBOOK.md"] });
    expect(branch).toBe(`${DEPLOY_SETUP_BRANCH}-2`);
    expect(github.pulls.map((pull) => pull.title)).toEqual([
      "OpsCrew: the runbook and reports for shop",
    ]);
    github.openPulls.set(branch, OPEN);
    return branch;
  };
  /** A further run on the open pull request's branch that adds `opscrew/.sops.yaml`. */
  const addSopsConfig = () =>
    publish({
      paths: ["opscrew/RUNBOOK.md"],
      recoveryCopy: {
        files: [{ path: "opscrew/.sops.yaml", content: "creation_rules: []\n", kind: "doc" }],
      },
    });
  return {
    ...project,
    deps,
    keys,
    sops,
    handler,
    github,
    plan,
    world,
    workflowPath,
    publish,
    writeWorkflow,
    firstSetup,
    committed,
    merge,
    openRunbookPull,
    addSopsConfig,
  };
}

type Provisioned = Awaited<ReturnType<typeof provisioned>>;

/** The first setup's title, body and commit message. */
async function expectFirstSetup(p: Provisioned) {
  expect(p.github.pulls[0]?.title).toBe("OpsCrew: deployment infrastructure for shop");
  expect(p.github.pulls[0]?.body).toContain(
    "This pull request adds the deployment setup that OpsCrew generated from `opscrew/plan.yaml` for **shop**",
  );
  expect(await p.git(p.root, "log", "-1", "--format=%s")).toBe(
    "chore(opscrew): deployment infrastructure for shop",
  );
}

describe.skipIf(!findExecutable("git"))("publishDeploySetup's pull request text", () => {
  it("the first setup keeps its title, body and commit message", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await expectFirstSetup(p);
  });

  it("is the first setup's when main has the plan already, as `opscrew adapt` commits it", async () => {
    const p = await provisioned();
    await p.git(p.root, "add", "opscrew/plan.yaml");
    await p.git(p.root, "commit", "-q", "-m", "adapt");
    await p.firstSetup();
    expect(await p.committed()).toEqual([p.workflowPath]);
    await expectFirstSetup(p);
  });

  it("a run that adds only the recovery copy's keys says so, never the first setup's text", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    await writeFile(join(p.root, ".gitattributes"), "* text=auto\n");
    await p.git(p.root, "add", ".gitattributes");
    await p.git(p.root, "commit", "-q", "-m", "attributes");
    await p.publish({
      recoveryCopy: {
        files: [
          { path: "opscrew/.sops.yaml", content: "creation_rules: []\n", kind: "doc" },
          {
            path: ".gitattributes",
            content: "* text=auto\nopscrew/secrets.sops.json -text\nopscrew/.sops.yaml -text\n",
            kind: "doc",
          },
        ],
      },
    });
    expect((await p.committed()).sort()).toEqual([".gitattributes", "opscrew/.sops.yaml"]);
    const pull = p.github.pulls[0];
    expect(pull?.title).toBe("OpsCrew: the recovery copy's keys for shop");
    expect(pull?.body).toContain("- `opscrew/.sops.yaml`: the keys that open the recovery copy");
    expect(pull?.body).toContain("- `.gitattributes`: keeps the recovery copy's line endings");
    expect(pull?.body).not.toContain("adds the deployment setup");
    expect(pull?.body).not.toContain("infrastructure code");
    expect(pull?.body).not.toContain("Review checklist");
    expect(await p.git(p.root, "log", "-1", "--format=%s")).toBe(
      "chore(opscrew): the recovery copy's keys for shop",
    );
  });

  it("a second run with an open pull request pushes to it and updates its title and body", async () => {
    const p = await provisioned();
    const branch = await p.openRunbookPull();

    const published = await p.addSopsConfig();
    expect(published).toMatchObject({ branch, pushed: true, prUrl: OPEN.url });
    // No new branch and no new pull request: the open one has both runs' files.
    expect(p.github.pulls).toHaveLength(1);
    expect(await p.git(p.root, "branch", "--list", `${DEPLOY_SETUP_BRANCH}*`)).toBe(`* ${branch}`);
    expect(await p.git(p.bare, "show", "--name-only", "--format=", branch)).toBe(
      "opscrew/.sops.yaml",
    );
    expect(p.github.pullUpdates).toHaveLength(1);
    const update = p.github.pullUpdates[0];
    expect(update?.number).toBe(7);
    expect(update?.title).toBe("OpsCrew: update the deployment of shop");
    expect(update?.body).toContain("- `opscrew/.sops.yaml`: the keys that open the recovery copy");
    expect(update?.body).toContain("- The runbook and reports: `opscrew/RUNBOOK.md`");
    expect(p.handler.requests.at(-1)).toMatchObject({
      kind: "pull-request",
      title: `Update the open pull request ${OPEN.url} to "OpsCrew: update the deployment of shop"`,
    });
    expect(p.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "git",
        action: "pull-request-update",
        target: OPEN.url,
        decision: "approved",
      }),
    );
    expect(await p.git(p.root, "log", "-1", "--format=%s")).toBe(
      "chore(opscrew): the recovery copy's keys for shop",
    );
  });

  it("lists the user's own files on the branch as other files, never as OpsCrew's", async () => {
    const p = await provisioned();
    await p.openRunbookPull();
    await mkdir(join(p.root, ".github", "workflows"), { recursive: true });
    await writeFile(join(p.root, ".github", "workflows", "ci.yml"), "name: ci\n");
    await writeFile(join(p.root, "README.md"), "# Shop\n");
    await p.git(p.root, "add", ".github/workflows/ci.yml", "README.md");
    await p.git(p.root, "commit", "-q", "-m", "user's own");

    await p.addSopsConfig();
    const body = p.github.pullUpdates[0]?.body;
    expect(body).toContain("- Other files: `.github/workflows/ci.yml`, `README.md`.");
    expect(body).toContain("- The runbook and reports: `opscrew/RUNBOOK.md`.");
    expect(body).not.toContain("The deploy workflow");
    expect(body).not.toContain("Review checklist");
  });

  it("lists at most 20 files a group, so a large change keeps the body small", async () => {
    const p = await provisioned();
    await p.openRunbookPull();
    await mkdir(join(p.root, "notes"), { recursive: true });
    const notes = Array.from({ length: 30 }, (_, i) => `notes/${String(i).padStart(2, "0")}.txt`);
    for (const note of notes) await writeFile(join(p.root, note), `${note}\n`);
    await p.git(p.root, "add", "notes");
    await p.git(p.root, "commit", "-q", "-m", "notes");

    await p.addSopsConfig();
    const body = p.github.pullUpdates[0]?.body ?? "";
    expect(body).toContain(
      `- Other files: ${notes
        .slice(0, 20)
        .map((note) => `\`${note}\``)
        .join(", ")} and 10 more.`,
    );
    expect(body).not.toContain("notes/20.txt");
    expect(body.length).toBeLessThan(10_000);
  });

  it("keeps the open pull request's title and body when the update is refused", async () => {
    const p = await provisioned();
    await p.openRunbookPull();
    p.world.deny = (request) => request.title.startsWith("Update the open pull request");

    const published = await p.addSopsConfig();
    expect(published).toMatchObject({ pushed: true, prUrl: OPEN.url });
    expect(p.github.pullUpdates).toEqual([]);
    expect(p.deps.reporter.text()).toContain(
      `Pushed to the open pull request ${OPEN.url}; its title and body stay as they were.`,
    );
    expect(p.deps.audit.entries.map((entry) => entry.action)).not.toContain("pull-request-update");
  });

  it("an open first setup keeps its recovery copy line when a later run updates it", async () => {
    const p = await provisioned();
    await p.firstSetup({ keyOut: join(p.keys, "age-key.txt") });
    p.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN);
    await writeFile(join(p.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    await p.publish({ paths: ["opscrew/plan.yaml", p.workflowPath, "opscrew/RUNBOOK.md"] });
    expect(await p.committed()).toEqual(["opscrew/RUNBOOK.md"]);
    const update = p.github.pullUpdates[0];
    expect(update?.title).toBe("OpsCrew: deployment infrastructure for shop");
    expect(update?.body).toContain(
      "- `opscrew/secrets.sops.json`: the encrypted recovery copy of what OpsCrew keeps on your computer for this app",
    );
  });

  it("a later run lists what it changes by group, with the pinned-actions check for a workflow", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    await mkdir(join(p.root, "opscrew/infra/prod"), { recursive: true });
    await writeFile(join(p.root, "opscrew/infra/prod/main.tf"), "terraform {}\n");
    await mkdir(join(p.root, "opscrew/runtime"), { recursive: true });
    await writeFile(join(p.root, "opscrew/runtime/compose.yaml"), "services: {}\n");
    await writeFile(join(p.root, "opscrew/RUNBOOK.md"), "# Runbook\n");
    await p.writeWorkflow("name: deploy v2\n");
    await p.publish({
      paths: [
        "opscrew/infra/prod/main.tf",
        "opscrew/runtime/compose.yaml",
        "opscrew/RUNBOOK.md",
        p.workflowPath,
      ],
    });
    const pull = p.github.pulls[0];
    expect(pull?.title).toBe("OpsCrew: update the deployment of shop");
    expect(pull?.body).toContain("This pull request updates the deployment of **shop**");
    expect(pull?.body).toContain(
      "- The infrastructure code (works with OpenTofu and Terraform): `opscrew/infra/prod/main.tf`.",
    );
    expect(pull?.body).toContain(
      "- The runtime the app runs with: `opscrew/runtime/compose.yaml`.",
    );
    expect(pull?.body).toContain("- The runbook and reports: `opscrew/RUNBOOK.md`.");
    expect(pull?.body).toContain(`- The deploy workflow: \`${p.workflowPath}\`.`);
    expect(pull?.body).toContain(
      "Nothing else is needed before merging: the deploy secrets are stored in GitHub Actions.",
    );
    expect(pull?.body).toContain(
      "Review checklist:\n- [ ] The workflow only uses pinned, first-party actions.",
    );
    expect(pull?.body).not.toContain("firewall");
    expect(await p.git(p.root, "log", "-1", "--format=%s")).toBe(
      "chore(opscrew): update the deployment of shop",
    );
  });

  it("describes the branch against main as last fetched from GitHub, not a stale local main", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    // This clone fetched main with the first setup, but its own main is still behind it.
    await p.git(p.root, "update-ref", "refs/remotes/origin/main", "main");
    await p.git(p.root, "checkout", "-q", "-b", `${DEPLOY_SETUP_BRANCH}-2`);
    await p.git(p.root, "branch", "-q", "-f", "main", "main~1");
    await writeFile(join(p.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    await p.publish({ paths: ["opscrew/plan.yaml", p.workflowPath, "opscrew/RUNBOOK.md"] });
    expect(p.github.pulls[0]?.title).toBe("OpsCrew: the runbook and reports for shop");
    expect(p.github.pulls[0]?.body).not.toContain(p.workflowPath);
  });

  it("when git cannot diff the branch, a new pull request says what this commit changes", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    p.world.failDiff = true;
    await writeFile(join(p.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    const published = await p.publish({ paths: ["opscrew/RUNBOOK.md"] });
    expect(published).toMatchObject({ pushed: true, prUrl: OPEN.url });
    expect(p.github.pulls[0]?.title).toBe("OpsCrew: the runbook and reports for shop");
    expect(p.deps.reporter.text()).toContain(
      `OpsCrew could not tell what ${DEPLOY_SETUP_BRANCH}-2 changes since it left main (git diff failed: fatal: no merge base).`,
    );
  });

  it("when git cannot diff the branch, an open pull request keeps its title and body", async () => {
    const p = await provisioned();
    await p.openRunbookPull();
    p.world.failDiff = true;
    const published = await p.addSopsConfig();
    expect(published).toMatchObject({ pushed: true, prUrl: OPEN.url });
    expect(p.github.pullUpdates).toEqual([]);
    expect(p.deps.reporter.text()).toContain(
      `Pushed to the open pull request ${OPEN.url}; its title and body stay as they were.`,
    );
  });
});

describe.skipIf(!findExecutable("git"))("publishDeploySetup and the plan's records", () => {
  /** What `opscrew verify` and `opscrew provision` record after the first deploy. */
  const record = (p: Provisioned) =>
    writeArtifact("plan", p.deps.paths.files.plan, {
      ...p.plan,
      updatedAt: "2026-11-08T10:00:00.000Z",
      deployment: {
        ...p.plan.deployment,
        firstDeployAt: "2026-11-08T09:00:00.000Z",
        lastApplyAt: "2026-11-08T08:00:00.000Z",
      },
    });

  it("opens no pull request when only the plan's records changed; they go with the next change", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    const head = await p.git(p.root, "rev-parse", "HEAD");
    await record(p);

    const published = await p.publish();
    expect(published).toMatchObject({ published: false, pushed: false, branch: "main" });
    expect(p.github.pulls).toEqual([]);
    expect(await p.git(p.root, "rev-parse", "HEAD")).toBe(head);
    expect(await p.git(p.root, "diff", "--cached", "--name-only")).toBe("");
    expect(p.deps.reporter.text()).toContain(
      "Only the plan's records changed (such as when the app was first deployed), so OpsCrew opened no pull request: opscrew/plan.yaml goes with the next change.",
    );
    // This computer keeps the record, so verify and status read it as before.
    const onDisk = await readArtifact("plan", p.deps.paths.files.plan);
    expect(onDisk.deployment.firstDeployAt).toBe("2026-11-08T09:00:00.000Z");

    // The next change takes the plan file with it.
    await writeFile(join(p.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    await p.publish({ paths: ["opscrew/plan.yaml", "opscrew/RUNBOOK.md"] });
    expect((await p.committed()).sort()).toEqual(["opscrew/RUNBOOK.md", "opscrew/plan.yaml"]);
    expect(p.github.pulls[0]?.body).toContain("- `opscrew/plan.yaml`: the deployment plan");
  });

  it("still pushes an earlier commit whose push was refused", async () => {
    const p = await provisioned();
    p.world.deny = (request) => request.kind === "git-push";
    await p.firstSetup();
    expect(p.github.pulls).toEqual([]);
    p.world.deny = () => false;
    await record(p);

    const published = await p.publish();
    expect(published).toMatchObject({ branch: DEPLOY_SETUP_BRANCH, pushed: true });
    // The refused commit goes out with the records' own.
    expect(
      (await p.git(p.bare, "log", "-2", "--format=%s", DEPLOY_SETUP_BRANCH)).split("\n"),
    ).toEqual([
      "chore(opscrew): the deployment plan for shop",
      "chore(opscrew): deployment infrastructure for shop",
    ]);
    expect(p.github.pulls.map((pull) => pull.title)).toEqual([
      "OpsCrew: deployment infrastructure for shop",
    ]);
  });

  it("opens one when the plan changed beyond its records", async () => {
    const p = await provisioned();
    await p.firstSetup();
    await p.merge();
    await writeArtifact("plan", p.deps.paths.files.plan, {
      ...p.plan,
      app: { ...p.plan.app, port: 8080 },
    });
    await p.publish();
    expect(await p.committed()).toEqual(["opscrew/plan.yaml"]);
    expect(p.github.pulls[0]?.title).toBe("OpsCrew: the deployment plan for shop");
  });
});

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

describe.skipIf(!findExecutable("git"))("publishDeploySetup and the user's checkout", () => {
  it("commits only OpsCrew's paths, keeps the user's changes, and says how to get back", async () => {
    const p = await provisioned();
    await writeFile(join(p.root, "notes.txt"), "staged draft\n");
    await p.git(p.root, "add", "notes.txt");
    await writeFile(join(p.root, "Dockerfile"), "FROM node:24-alpine\nUSER node\n");

    await p.publish();
    expect(await p.committed()).toEqual(["opscrew/plan.yaml"]);
    const pushed = await p.git(p.bare, "show", "--name-only", "--format=", DEPLOY_SETUP_BRANCH);
    expect(pushed).toBe("opscrew/plan.yaml");
    // The user's staged file stays staged and their edit stays in the working tree.
    expect(await p.git(p.root, "diff", "--cached", "--name-only")).toBe("notes.txt");
    expect(await p.git(p.root, "diff", "--name-only")).toBe("Dockerfile");
    expect(await p.git(p.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(DEPLOY_SETUP_BRANCH);
    expect(p.deps.reporter.text()).toContain(
      `Your checkout is on ${DEPLOY_SETUP_BRANCH}, where these files are. After the pull request is merged, run \`git switch main && git pull\` before you commit anything else.`,
    );
  });

  it("commits nothing when only the user's own changes are staged", async () => {
    const p = await provisioned();
    await p.publish();
    await p.git(p.root, "checkout", "-q", "main");
    await p.git(p.root, "merge", "-q", DEPLOY_SETUP_BRANCH);
    const before = await p.git(p.root, "rev-parse", "HEAD");
    await writeFile(join(p.root, "notes.txt"), "staged draft\n");
    await p.git(p.root, "add", "notes.txt");
    p.github.pulls.length = 0;
    const published = await p.publish();
    expect(published.published).toBe(false);
    expect(await p.git(p.root, "rev-parse", "HEAD")).toBe(before);
    expect(await p.git(p.root, "diff", "--cached", "--name-only")).toBe("notes.txt");
  });
});

describe.skipIf(!findExecutable("git"))("publishDeploySetup and the provider lock files", () => {
  const roots = ["opscrew/infra/prod", "opscrew/infra/prod-storage"];
  const lock = (root: string) => `${root}/.terraform.lock.hcl`;

  it("commits each initialised folder's lock file beside its IaC, and a changed one again", async () => {
    const p = await provisioned();
    for (const root of roots) {
      await mkdir(join(p.root, root), { recursive: true });
      await writeFile(join(p.root, root, "main.tf"), "terraform {}\n");
      await writeFile(join(p.root, lock(root)), "# lock v1\n");
    }
    // A folder OpsCrew has not initialised yet has no lock file to commit.
    await mkdir(join(p.root, "opscrew/infra/staging"), { recursive: true });
    await writeFile(join(p.root, "opscrew/infra/staging/main.tf"), "terraform {}\n");
    const paths = [...roots, "opscrew/infra/staging"].map((root) => `${root}/main.tf`);
    await p.publish({ paths });
    expect((await p.committed()).filter(Boolean).sort()).toEqual(
      [...paths, ...roots.map(lock)].sort(),
    );
    const push = p.handler.requests.find((r) => r.kind === "git-push");
    for (const root of roots) expect(push?.details).toContain(`  ${lock(root)}`);

    // A later provision whose init changed one lock file commits that change.
    await p.git(p.root, "checkout", "-q", "main");
    await p.git(p.root, "merge", "-q", DEPLOY_SETUP_BRANCH);
    await p.git(p.root, "branch", "-q", "-D", DEPLOY_SETUP_BRANCH);
    p.github.pulls.length = 0;
    await writeFile(join(p.root, lock("opscrew/infra/prod")), "# lock v2\n");
    await p.publish({ paths });
    expect((await p.committed()).filter(Boolean)).toEqual([lock("opscrew/infra/prod")]);
  });
});
