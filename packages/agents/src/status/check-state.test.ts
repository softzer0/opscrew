import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordServerAddress } from "../shared";
import { createTestPhaseDeps, FakeGitHub, ScriptedRunner, SERVER_IPV4, testPlan } from "../testing";
import { checkStateReport } from "./check-state";
import { componentStatusReport } from "./run";

/** `base` with the scheduled check on. */
function withCheck(base: DeployPlan = testPlan({ deployed: true })): DeployPlan {
  return DeployPlanSchema.parse({ ...base, observability: { check: { enabled: true } } });
}

/** Phase deps in a repository whose origin is github.com/acme/shop. */
async function inRepository() {
  const runner = new ScriptedRunner((command, args) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" },
  );
  return createTestPhaseDeps({ runner });
}

/** The scripted runner of {@link inRepository}'s deps. */
function runnerOf(deps: { runner: unknown }): ScriptedRunner {
  return deps.runner as ScriptedRunner;
}

const ACTIONS = "https://github.com/acme/shop/actions/workflows/opscrew-check.yml";

describe("the scheduled check's state", () => {
  it("off for inactivity: says why, with the Actions page and gh workflow enable", async () => {
    const deps = await inRepository();
    const github = new FakeGitHub();
    github.workflowStates.set("opscrew-check.yml", "disabled_inactivity");

    const { lines, check } = await checkStateReport(deps, withCheck(), github);

    expect(lines).toEqual([
      "Scheduled check (.github/workflows/opscrew-check.yml, read from GitHub now):",
      `  State: off. GitHub turned it off after 60 days without activity in the repository, so nothing checks the app now. Turn it on again on the Actions page, ${ACTIONS} ("Enable workflow"), or with \`gh workflow enable opscrew-check.yml\`. A commit within every 60 days keeps it on.`,
      "  Open alerts: none",
    ]);
    expect(check).toEqual({ workflow: "disabled_inactivity", alerts: [] });
  });

  it("missing while the plan has it on: says to merge the deploy-setup pull request", async () => {
    const deps = await inRepository();
    const { lines } = await checkStateReport(deps, withCheck(), new FakeGitHub());
    expect(lines[1]).toBe(
      "  State: not set up yet. Merge OpsCrew's deploy-setup pull request: it adds the check.",
    );
  });

  it("lists the open alerts with their links", async () => {
    const deps = await inRepository();
    const github = new FakeGitHub();
    github.workflowStates.set("opscrew-check.yml", "active");
    github.issues.set("opscrew-check", [
      {
        number: 12,
        title: "OpsCrew check: shop (prod) does not answer on shop.example.com",
        url: "https://github.com/acme/shop/issues/12",
        body: "<!-- opscrew-check:shop/prod/https/shop.example.com -->",
        createdAt: "2026-10-11T11:00:00Z",
      },
    ]);

    const { lines, check } = await checkStateReport(deps, withCheck(), github);

    expect(lines.slice(1)).toEqual([
      "  State: on",
      "  Open alerts:",
      "    #12 OpsCrew check: shop (prod) does not answer on shop.example.com: https://github.com/acme/shop/issues/12",
    ]);
    // The issue's body stays out of the state.
    expect(check?.alerts).toEqual([
      {
        number: 12,
        title: "OpsCrew check: shop (prod) does not answer on shop.example.com",
        url: "https://github.com/acme/shop/issues/12",
        createdAt: "2026-10-11T11:00:00Z",
      },
    ]);
  });

  it("reads nothing when the plan has the check off; says so without a GitHub token", async () => {
    const deps = await inRepository();
    expect(await checkStateReport(deps, testPlan({ deployed: true }), null)).toEqual({ lines: [] });
    expect(runnerOf(deps).calls).toEqual([]);

    const { lines, check } = await checkStateReport(deps, withCheck(), null);
    expect(lines[1]).toContain("no GitHub token is available");
    expect(check).toBeUndefined();
  });

  it("componentStatusReport ends with it and returns it", async () => {
    const deps = await inRepository();
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const github = new FakeGitHub();
    github.workflowStates.set("opscrew-check.yml", "active");
    const plan = withCheck(
      DeployPlanSchema.parse({
        ...testPlan({ deployed: true }),
        deployment: {
          ...testPlan({ deployed: true }).deployment,
          firstDeployAt: "2026-10-10T09:00:00.000Z",
        },
      }),
    );
    const remote = (host: string): RemoteExec => ({
      host,
      run: async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const report = await componentStatusReport(deps, plan, { services: { remote, github } });

    expect(report.lines.slice(-4)).toEqual([
      "",
      "Scheduled check (.github/workflows/opscrew-check.yml, read from GitHub now):",
      "  State: on",
      "  Open alerts: none",
    ]);
    expect(report.check).toEqual({ workflow: "active", alerts: [] });
  });
});
