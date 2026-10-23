import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, findExecutable, NodeCommandRunner, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { deploySecretNames, deploySecretPlaces } from "../provision/secrets";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  ScriptedApprovalHandler,
  ScriptedRunner,
} from "../testing";
import { FakeComputer, localPlan } from "./__fixtures__/computer";
import { destroyLocalhost } from "./destroy";

/** A repository secret of the user's own, which OpsCrew never touches. */
const USER_SECRET = "USER_DEPLOY_TOKEN";

/** dev on this computer, its deploy job on the local runner, its secrets in its GitHub environment. */
function devOnLocalRunner(): DeployPlan {
  const plan = localPlan({ environment: "dev", image: "registry" });
  return DeployPlanSchema.parse({
    ...plan,
    environment: { name: "dev", runner: "local", secrets: "environment" },
    deployment: { ...plan.deployment, lastApplyAt: "2026-10-20T10:00:00.000Z" },
  });
}

/**
 * dev deployed on the fake computer in a git project of `acme/shop`, its deploy secrets at the
 * fake GitHub (and one of the user's own). `record`: the provision stored them and wrote the
 * secrets record, with the GitHub environment dev it created.
 */
async function deployedDev(record: boolean) {
  const plan = devOnLocalRunner();
  const repo = await createProject(localPlan({ image: "registry" }));
  const computer = new FakeComputer().deployed("shop-dev");
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
    environment: "dev",
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const github = new FakeGitHub();
  github.secrets.set(USER_SECRET, "theirs");
  github.environments.set("dev", new Map());
  for (const place of deploySecretPlaces(plan, "dev")) {
    if (place.environment === undefined) github.secrets.set(place.name, "stored");
    else github.environments.get(place.environment)?.set(place.name, "stored");
  }
  if (record) {
    await mkdir(dirname(deps.paths.files.deploySecrets), { recursive: true });
    await writeFile(
      deps.paths.files.deploySecrets,
      `${JSON.stringify({
        host: "localhost",
        repo: "acme/shop",
        names: deploySecretNames(plan),
        environment: "dev",
        createdEnvironment: true,
      })}\n`,
    );
  }
  const destroy = () => destroyLocalhost(deps, plan, { services: { github } }, computer.services());
  return { deps, plan, github, handler, destroy };
}

describe.skipIf(!findExecutable("git"))("destroy on this computer with the local runner", () => {
  it("removes the recorded deploy secrets and the GitHub environment OpsCrew created", async () => {
    const s = await deployedDev(true);
    const result = await s.destroy();

    expect(s.github.environments.has("dev")).toBe(false);
    expect([...s.github.secrets.keys()]).toEqual([USER_SECRET]);
    expect(result.secretsRemoved.sort()).toEqual(deploySecretNames(s.plan).sort());
    expect(result.remaining.join("\n")).not.toContain("deploy secrets");
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["host-apply", "github-secrets"]);
    expect(s.handler.requests[1]?.title).toBe(
      "Remove the deploy secrets from acme/shop, with the GitHub environment dev OpsCrew created",
    );
    expect(s.deps.reporter.text()).toContain("Deleted the GitHub environment dev of acme/shop");
    expect(await exists(s.deps.paths.files.deploySecrets)).toBe(false);
  });

  it("touches nothing at GitHub without a secrets record", async () => {
    const s = await deployedDev(false);
    const before = [...s.github.secrets.keys()].sort();
    const result = await s.destroy();

    expect(result.secretsRemoved).toEqual([]);
    expect([...s.github.secrets.keys()].sort()).toEqual(before);
    expect(s.github.environments.get("dev")?.size).toBeGreaterThan(0);
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
  });

  it("says what is left and how to finish when GitHub fails", async () => {
    const s = await deployedDev(true);
    const token = fakeSecret("github-token");
    s.deps.redactor.addLiteral(token);
    s.github.deleteEnvironment = async () => {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `GitHub refused to delete the environment dev (Must have admin rights ${token}).`,
        { hint: "The token needs Administration: Read and write." },
      );
    };
    const error = await s.destroy().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    const failure = error as OpsCrewError;
    expect(failure.message).toContain(
      "The app is removed from this computer, and the deploy secrets outside it are removed, but deleting the GitHub environment dev failed:",
    );
    expect(failure.message).not.toContain(token);
    expect(failure.hint).toBe(
      "The token needs Administration: Read and write. Then run `opscrew destroy` again to finish the cleanup.",
    );
    expect(s.github.environments.has("dev")).toBe(true);
  });
});
