import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { createTestPhaseDeps, ownPlan, ScriptedRunner } from "../testing";
import { FakeRunnerGitHub, listedRunner } from "./__fixtures__/github";
import { runnerChecks, runnerStatus, runnerStatusLines } from "./status";

const NOW = "2026-10-22T12:00:00.000Z";

/** GitHub's runner releases: 2.338.0 on 2026-10-06, 2.337.0 on 2026-09-10, a pre-release. */
const RELEASES = [
  {
    tag_name: "v2.339.0-rc1",
    published_at: "2026-10-20T00:00:00Z",
    draft: false,
    prerelease: true,
  },
  { tag_name: "v2.338.0", published_at: "2026-10-06T00:00:00Z", draft: false, prerelease: false },
  { tag_name: "v2.337.0", published_at: "2026-09-10T00:00:00Z", draft: false, prerelease: false },
];

const releases: FetchLike = async (input) => {
  expect(String(input)).toBe("https://api.github.com/repos/actions/runner/releases?per_page=30");
  return new Response(JSON.stringify(RELEASES));
};

function withRunner(plan: DeployPlan, runner: "server" | "local"): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, environment: { ...plan.environment, runner } });
}

const server = withRunner(ownPlan(), "server");
const LABEL = "opscrew-shop-prod";

async function deps(now = NOW) {
  return createTestPhaseDeps({
    fetch: releases,
    clock: { now: () => new Date(now) },
    runner: new ScriptedRunner((_command, args) => ({
      exitCode: 0,
      stdout: args.includes("get-url") ? "https://github.com/acme/shop.git\n" : "",
      stderr: "",
    })),
  });
}

const statusOf = (checks: CheckResult[], id: string) => checks.find((check) => check.id === id);

describe("runnerStatus", () => {
  it("reads the runner by its label, its version against GitHub's releases, and the repository", async () => {
    const api = new FakeRunnerGitHub();
    api.runners = [
      listedRunner(1, "server-shop-staging", "opscrew-shop-staging", { version: "2.300.0" }),
      listedRunner(2, "server-shop-prod", LABEL, { version: "2.338.0" }),
    ];
    const repository = { api, owner: "acme", repo: "shop" };
    expect(await runnerStatus(await deps(), repository, server)).toEqual({
      registered: true,
      online: true,
      version: "2.338.0",
      behind: false,
      latest: "2.338.0",
      visibility: "private",
    });
    // 2.337.0 is fine for 21 days after 2.338.0, then behind.
    api.runners = [listedRunner(2, "server-shop-prod", LABEL, { version: "2.337.0" })];
    expect((await runnerStatus(await deps(), repository, server)).behind).toBe(false);
    expect(
      (await runnerStatus(await deps("2026-10-28T12:00:00.000Z"), repository, server)).behind,
    ).toBe(true);
    api.runners = [];
    expect(await runnerStatus(await deps(), repository, server)).toEqual({
      registered: false,
      visibility: "private",
    });
  });
});

describe("runnerChecks", () => {
  it("is empty for a deploy job on GitHub's machines", async () => {
    const api = new FakeRunnerGitHub();
    expect(await runnerChecks(await deps(), ownPlan(), api)).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("warns about an offline runner and one over 21 days behind a release", async () => {
    const api = new FakeRunnerGitHub();
    api.runners = [
      listedRunner(2, "server-shop-prod", LABEL, { status: "offline", version: "2.337.0" }),
    ];
    const checks = await runnerChecks(await deps("2026-10-28T12:00:00.000Z"), server, api);
    expect(statusOf(checks, "runner-online")).toMatchObject({ status: "warn", severity: "medium" });
    expect(statusOf(checks, "runner-version")).toMatchObject({
      status: "warn",
      severity: "medium",
    });
    expect(statusOf(checks, "runner-version")?.message).toContain("2.337.0");
    expect(statusOf(checks, "runner-public-repository")).toBeUndefined();

    api.runners = [listedRunner(2, "server-shop-prod", LABEL)];
    const healthy = await runnerChecks(await deps(), server, api);
    expect(healthy.map((check) => `${check.id} ${check.status}`)).toEqual(["runner-online pass"]);
  });

  it("fails as high for a public repository whose outside contributors' runs need no approval", async () => {
    const api = new FakeRunnerGitHub();
    api.visibility = "public";
    api.runners = [listedRunner(2, "server-shop-prod", LABEL)];
    const open = await runnerChecks(await deps(), server, api);
    expect(statusOf(open, "runner-public-repository")).toMatchObject({
      status: "fail",
      severity: "high",
    });
    api.policy = "all_external_contributors";
    const approved = await runnerChecks(await deps(), server, api);
    expect(statusOf(approved, "runner-public-repository")?.status).toBe("pass");
  });

  it("passes a local runner that is not running, and warns about a server runner GitHub does not list", async () => {
    const api = new FakeRunnerGitHub();
    const local = withRunner(localPlan({ image: "registry" }), "local");
    const [idle] = await runnerChecks(await deps(), local, api);
    expect(idle).toMatchObject({ id: "runner-online", status: "pass" });
    expect(idle?.message).toContain("opscrew runner start --env prod");
    const [missing] = await runnerChecks(await deps(), server, api);
    expect(missing).toMatchObject({ id: "runner-online", status: "warn" });
    expect(missing?.remediation).toContain("opscrew provision");
  });
});

describe("runnerStatusLines", () => {
  it("shows the runner's state, version and the repository's visibility", async () => {
    const api = new FakeRunnerGitHub();
    api.runners = [listedRunner(2, "server-shop-prod", LABEL, { status: "offline" })];
    expect(await runnerStatusLines(await deps(), server, api)).toEqual([
      "Self-hosted runner (opscrew-shop-prod, on the server):",
      "  offline (check the server, then run `opscrew provision`)",
      "  version 2.338.0 (GitHub's newest: 2.338.0)",
      "  repository: private",
    ]);
    expect(await runnerStatusLines(await deps(), ownPlan(), api)).toEqual([]);
  });
});

describe("a runner on a runner machine", () => {
  const machine = DeployPlanSchema.parse({
    ...ownPlan(),
    environment: { runner: "host", runnerHost: { name: "home", arch: "amd64" } },
  });

  it("is named as the runner machine's in status and secure", async () => {
    const api = new FakeRunnerGitHub();
    api.visibility = "public";
    api.runners = [listedRunner(2, "1a2b3c4d-shop-prod", LABEL, { status: "offline" })];
    expect(await runnerStatusLines(await deps(), machine, api)).toEqual([
      "Self-hosted runner (opscrew-shop-prod, on the runner machine home):",
      "  offline (check the runner machine home, then run `opscrew provision`)",
      "  version 2.338.0 (GitHub's newest: 2.338.0)",
      "  repository: public, and outside contributors' workflow runs need no approval: run `opscrew provision` to require it",
    ]);
    const checks = await runnerChecks(await deps(), machine, api);
    expect(statusOf(checks, "runner-online")).toMatchObject({
      status: "warn",
      message:
        "GitHub lists the runner on the runner machine home as offline, so the environment's deploy jobs wait.",
      remediation:
        "Check that the runner machine home is up, then run `opscrew provision`, which starts it again.",
    });
    expect(statusOf(checks, "runner-public-repository")?.message).toContain(
      "could run its own code on the runner machine home.",
    );
  });

  it("names --env prod in its commands while the app has other environments", async () => {
    const d = await deps();
    await writeArtifact("plan", d.paths.files.plan, machine);
    const staging = resolveProjectPaths(d.paths.root, { env: d.env, environment: "staging" });
    await writeArtifact(
      "plan",
      staging.files.plan,
      DeployPlanSchema.parse({
        ...machine,
        app: { ...machine.app, name: "shop-staging" },
        environment: { ...machine.environment, name: "staging" },
      }),
    );
    const [missing] = await runnerChecks(d, machine, new FakeRunnerGitHub());
    expect(missing?.remediation).toBe(
      "Run `opscrew provision --env prod`, which installs it again.",
    );
  });
});
