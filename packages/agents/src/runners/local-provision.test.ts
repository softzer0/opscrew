import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable, NodeCommandRunner, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan } from "../localhost/__fixtures__/computer";
import { runProvision } from "../provision";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  ScriptedApprovalHandler,
  ScriptedRunner,
} from "../testing";

/** Prod on this computer, its deploy job on the local runner. */
function onLocalRunner(image: "registry" | "local-build" = "registry"): DeployPlan {
  return DeployPlanSchema.parse({ ...localPlan({ image }), environment: { runner: "local" } });
}

/** A git project on this computer: real git, the fake computer for everything else. */
async function project(plan: DeployPlan) {
  const repo = await createProject(plan);
  const computer = new FakeComputer();
  const git = new NodeCommandRunner();
  const handler = new ScriptedApprovalHandler();
  const deps = await createTestPhaseDeps({
    root: repo.root,
    env: { ...process.env, OPSCREW_HOME: join(repo.root, ".home-opscrew") },
    runner: new ScriptedRunner((command, args, options) =>
      command === "git"
        ? git.run(command, args, options)
        : computer.runner.run(command, args, options),
    ),
    approvalHandler: handler,
  });
  const github = new FakeGitHub();
  const run = () => runProvision(deps, { services: { localhost: computer.services(), github } });
  return { ...repo, deps, computer, github, handler, run };
}

describe.skipIf(!findExecutable("git"))("provision with the local runner", () => {
  it("writes the workflow for this computer, stores the deploy secrets and opens the pull request", async () => {
    const s = await project(onLocalRunner());
    const result = await s.run();
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(result).toMatchObject({ localApplied: true, published: true, pushed: true });
    expect(result.prUrl).toBe("https://github.com/acme/shop/pull/7");
    const workflow = await readFile(
      join(s.root, ".github", "workflows", "opscrew-deploy.yml"),
      "utf8",
    );
    expect(workflow).toContain("--host shop.localhost");
    expect(workflow).toContain("runs-on: [self-hosted, opscrew-shop-prod]");
    // The runner deploys here: no host, SSH key or known hosts among the secrets.
    expect([...s.github.secrets.keys()].sort()).toEqual([
      "OPSCREW_APP_ENV",
      "OPSCREW_BUILD_ENV",
      "OPSCREW_BUILD_SECRETS",
      "OPSCREW_SERVICE_DB_ENV",
    ]);
    const committed = await s.git(s.root, "ls-tree", "-r", "--name-only", "opscrew/deploy-setup");
    expect(committed.split("\n")).toContain(".github/workflows/opscrew-deploy.yml");
    const body = s.github.pulls[0]?.body ?? "";
    expect(body).toContain("which runs on your own computer");
    expect(body).toContain("while `opscrew runner start --env prod` runs");
    expect(body).not.toContain(s.deps.paths.homeDir);
    expect(s.deps.reporter.text()).toContain("`opscrew runner start --env prod`");
  });

  it("refuses the local runner for an image built on this computer, before any change", async () => {
    const s = await project(onLocalRunner("local-build"));
    const error = await s.run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
    expect((error as OpsCrewError).message).toContain("image: local-build");
    expect(s.handler.requests).toEqual([]);
    expect(s.computer.scripts).toEqual([]);
  });
});
