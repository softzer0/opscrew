import { createHash } from "node:crypto";
import type {
  PhaseDeps,
  RollbackOptions,
  RollbackResult,
  RollbackServices,
  VersionView,
} from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inEnvironment, withEnvironments } from "../ui/__fixtures__/environments";
import { projectContext, run, type TempProject } from "../ui/__fixtures__/harness";

/** Each call of `rollback`, and the answer a test gives instead of the real agent's. */
const fake = vi.hoisted(() => ({
  calls: [] as { deps: PhaseDeps; options: RollbackOptions }[],
  answer: undefined as ((options: RollbackOptions) => Promise<RollbackResult>) | undefined,
}));

vi.mock("@opscrew/agents", async (importOriginal) => {
  const agents = await importOriginal<typeof import("@opscrew/agents")>();
  return {
    ...agents,
    rollback: (deps: PhaseDeps, options: RollbackOptions) => {
      fake.calls.push({ deps, options });
      return fake.answer === undefined ? agents.rollback(deps, options) : fake.answer(options);
    },
  };
});

let project: TempProject | undefined;
beforeEach(() => {
  fake.calls.length = 0;
  fake.answer = undefined;
});
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** A generated `sha256:…` digest and a 40-digit commit for `seed`. */
function digestOf(seed: string): string {
  return `sha256:${createHash("sha256").update(`digest:${seed}`).digest("hex")}`;
}
function commitOf(seed: string): string {
  return createHash("sha1").update(`commit:${seed}`).digest("hex");
}

/** A server's version built at minute `minute` of 2026-10-20 10:00 UTC. */
function version(seed: string, minute: number, extra: Partial<VersionView> = {}): VersionView {
  return {
    digest: digestOf(seed),
    commit: commitOf(seed),
    message: `Release ${seed}`,
    builtAt: new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString(),
    ...extra,
  };
}

/** A project with prod deployed (and these environments beside it), and a test context for it. */
async function setup(
  options: { plans?: Parameters<typeof withEnvironments>[0]; env?: Record<string, string> } = {},
) {
  project = await withEnvironments(options.plans ?? {});
  Object.assign(project.env, options.env);
  return projectContext(project);
}

const HASH = "a".repeat(64);

describe("opscrew rollback: the flags, checked before any work", () => {
  it.each([
    [["--approve", "abc"], "--approve expects the 64-character SHA-256 rollback hash"],
    [["--yes"], "--yes goes only with --resume: no flag grants a rollback"],
    [["--deploy"], "--deploy goes only with --resume"],
    [["--list", "--to", "1a2b3c4"], "--list stands alone"],
    [["--list", "--resume"], "--list stands alone"],
    [["--list", "--approve", HASH], "--list stands alone"],
    [["--resume", "--to", "1a2b3c4"], "--resume takes no --to, --approve or --allow-old-secrets"],
    [["--resume", "--approve", HASH], "--resume takes no --to, --approve or --allow-old-secrets"],
  ])("refuses %j with exit code 2", async (flags, message) => {
    const ctx = await setup();
    expect(await run(ctx, "rollback", ...flags)).toBe(2);
    expect(ctx.errors).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it("names the app and environment given in the refusal's hint", async () => {
    const ctx = await setup();
    expect(await run(ctx, "rollback", "--env", "prod", "--yes")).toBe(2);
    expect(ctx.errors).toContain("`opscrew rollback --env prod`");
  });

  it("prints its help with every flag", async () => {
    const ctx = await setup();
    expect(await run(ctx, "rollback", "--help")).toBe(0);
    for (const flag of [
      "--to <commit|digest|version>",
      "--list",
      "--resume",
      "--deploy",
      "--yes",
      "--approve <hash>",
      "--allow-old-secrets <names>",
      "--app <key>",
      "--env <name>",
    ]) {
      expect(ctx.output).toContain(flag);
    }
    const caveat = ctx.output.indexOf("The database stays as it is");
    expect(caveat).toBeGreaterThan(ctx.output.indexOf("Usage:"));
    expect(caveat).toBeLessThan(ctx.output.indexOf("Options:"));
    const top = await setup();
    expect(await run(top, "--help")).toBe(0);
    expect(top.output).toMatch(/rollback \[options\]\s+Put an environment back/);
    expect(top.output).not.toContain("The database stays as it is");
  });
});

describe("opscrew rollback --list", () => {
  it("shows the versions newest first, with the marks, the pause and how many are left out", async () => {
    const ctx = await setup();
    const running = version("3", 30, { marks: ["running"] });
    const previous = version("2", 20, { marks: ["previous"] });
    const first = version("1", 10);
    fake.answer = async () => ({
      kind: "list",
      versions: [running, previous, first],
      paused: {
        reason: "rollback",
        since: "2026-10-20T11:00:00.000Z",
        image: previous.digest as string,
        commit: previous.commit as string,
      },
      leftOut: [
        { commit: "a".repeat(40), reason: "it is built for another CPU" },
        { commit: "b".repeat(40), reason: "the registry no longer has it" },
      ],
    });
    expect(await run(ctx, "rollback", "--list"), ctx.errors).toBe(0);
    expect(fake.calls[0]?.options.list).toBe(true);
    const out = ctx.output;
    const at = (v: VersionView) => out.indexOf((v.commit as string).slice(0, 7));
    expect(at(running)).toBeGreaterThan(0);
    expect(at(running)).toBeLessThan(at(previous));
    expect(at(previous)).toBeLessThan(at(first));
    expect(out).toMatch(
      /sha256:[0-9a-f]{12}\s+[0-9a-f]{7}\s+2026-10-20 10:30 UTC\s+running\s+Release 3/,
    );
    expect(out).toContain("previous");
    expect(out).toContain(
      `Deploys of prod are paused since 2026-10-20 11:00 UTC: \`opscrew rollback\` pinned it to ${(previous.commit as string).slice(0, 7)} (${(previous.digest as string).slice(0, 19)}).`,
    );
    expect(out).toContain("`opscrew rollback --resume`");
    expect(out).toContain(
      "Not offered (prod):\n  aaaaaaa: it is built for another CPU\n  bbbbbbb: the registry no longer has it",
    );
    expect(out).toContain("`opscrew rollback --to <commit or digest>`");
  });

  it("says when there are no versions", async () => {
    const ctx = await setup();
    fake.answer = async () => ({ kind: "list", versions: [], leftOut: [] });
    expect(await run(ctx, "rollback", "--list")).toBe(0);
    expect(ctx.output).toContain("No versions of prod were found to roll back to.");
  });

  it("names a site's versions by their id, and --to takes one", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "list",
      versions: [
        {
          version: "202",
          commit: commitOf("b"),
          builtAt: "2026-10-23T09:00:00Z",
          marks: ["running"],
        },
        {
          version: "201",
          commit: commitOf("a"),
          builtAt: "2026-10-22T09:00:00Z",
          marks: ["previous"],
        },
      ],
      leftOut: [],
    });
    expect(await run(ctx, "rollback", "--list")).toBe(0);
    expect(ctx.output).toMatch(/202\s+[0-9a-f]{7}\s+2026-10-23 09:00 UTC\s+running/);
    expect(ctx.output).toContain("`opscrew rollback --to <version>`");
  });

  it("names a site's pinned version whole", async () => {
    const ctx = await setup();
    const worker = "cccccccc-3333-4333-8333-333333333333";
    fake.answer = async () => ({
      kind: "list",
      versions: [],
      paused: {
        reason: "rollback",
        since: "2026-10-20T11:00:00.000Z",
        image: worker,
        commit: commitOf("a"),
      },
      leftOut: [],
    });
    expect(await run(ctx, "rollback", "--list")).toBe(0);
    expect(ctx.output).toContain(
      `\`opscrew rollback\` pinned it to ${commitOf("a").slice(0, 7)} (${worker}).`,
    );
  });

  it("names a move's pause and the command that ends it", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "list",
      versions: [version("1", 10, { marks: ["running"] })],
      paused: { reason: "move", since: "2026-10-20T11:00:00.000Z" },
      leftOut: [],
    });
    expect(await run(ctx, "rollback", "--list")).toBe(0);
    expect(ctx.output).toContain(
      "Deploys of prod are paused since 2026-10-20 11:00 UTC for a move's maintenance window: `opscrew provision` ends it.",
    );
  });
});

describe("opscrew rollback", () => {
  it("passes the flags and the attached services, then prints only the next step", async () => {
    const now = () => 0;
    const services: RollbackServices = { localhost: { arch: "x64" }, now, sleep: async () => {} };
    project = await withEnvironments({});
    const ctx = projectContext(project, { services: { rollback: services } });
    const target = version("2", 20);
    fake.answer = async () => ({
      kind: "rolled-back",
      status: "deployed",
      target,
      from: version("3", 30),
      runUrl: "https://github.com/example-org/example-app/actions/runs/301",
      paused: true,
      how: "image",
    });
    expect(
      await run(ctx, "rollback", "--to", " 1a2b3c4 ", "--approve", ` ${HASH} `),
      ctx.errors,
    ).toBe(0);
    const [call] = fake.calls;
    expect(call?.options).toEqual({ to: "1a2b3c4", approveHash: HASH, services });
    expect(call?.deps.paths.environment).toBe("prod");
    // The agent's reporter says what runs now and how to resume; the CLI adds only the next step.
    expect(ctx.output).not.toContain("Release 2");
    expect(ctx.output).toContain("run `opscrew verify` to check the live site.");
  });

  it("splits --allow-old-secrets", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "rolled-back",
      status: "deployed",
      target: { version: "v-1", builtAt: "2026-10-23T10:00:00Z" },
      paused: false,
      how: "worker",
    });
    expect(
      await run(ctx, "rollback", "--to", "v-1", "--allow-old-secrets", "STRIPE_SECRET_KEY,OTHER"),
      ctx.errors,
    ).toBe(0);
    expect(fake.calls[0]?.options.allowOldSecrets).toEqual(["STRIPE_SECRET_KEY", "OTHER"]);
  });

  it("exits 0 for a run waiting for a reviewer, with no verify step yet", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "rolled-back",
      status: "waiting",
      target: version("2", 20),
      runUrl: "https://github.com/example-org/example-app/actions/runs/302",
      paused: true,
      how: "image",
    });
    expect(await run(ctx, "rollback")).toBe(0);
    expect(ctx.output).not.toContain("opscrew verify");
  });

  it("acts on the environment --env names", async () => {
    const prod = testPlan({ deployed: true });
    const ctx = await setup({ plans: { staging: inEnvironment(prod, "staging") } });
    fake.answer = async () => ({ kind: "list", versions: [], leftOut: [] });
    expect(await run(ctx, "rollback", "--env", "staging", "--list"), ctx.errors).toBe(0);
    expect(fake.calls[0]?.deps.paths.environment).toBe("staging");
    expect(ctx.output).toContain("No versions of staging were found");
  });

  it("refuses with exit code 1 through the real agent when nothing is provisioned", async () => {
    project = await withEnvironments({}, testPlan());
    const ctx = projectContext(project);
    expect(await run(ctx, "rollback")).toBe(1);
    expect(ctx.errors).toContain("is not provisioned, so there is nothing to roll back");
    expect(ctx.errors).toContain("Nothing was changed.");
  });

  it.each([
    ["PHASE_PRECONDITION", 1],
    ["PLAN_NOT_APPROVED", 1],
    ["APPROVAL_REFUSED", 1],
    ["COMMAND_FAILED", 2],
  ] as const)("exits %s with %i", async (code, exit) => {
    const ctx = await setup();
    fake.answer = async () => {
      throw new OpsCrewError(code, "It stopped. Nothing was changed.");
    };
    expect(await run(ctx, "rollback")).toBe(exit);
  });

  it("never prints a secret the agent's text holds", async () => {
    const token = fakeSecret("github-token");
    const ctx = await setup({ env: { GITHUB_TOKEN: token } });
    fake.answer = async () => ({
      kind: "rolled-back",
      status: "deployed",
      target: version("2", 20, { message: `Release ${token}` }),
      paused: true,
      how: "image",
    });
    expect(await run(ctx, "rollback")).toBe(0);
    fake.answer = async () => {
      throw new OpsCrewError("PHASE_PRECONDITION", `GitHub said ${token}. Nothing was changed.`);
    };
    expect(await run(ctx, "rollback")).toBe(1);
    expect(ctx.output).not.toContain(token);
    expect(ctx.errors).not.toContain(token);
  });
});

describe("opscrew rollback --resume", () => {
  it("passes --deploy and --yes, then prints the verify step", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "resumed",
      wasPaused: true,
      deployed: {
        status: "deployed",
        runUrl: "https://github.com/example-org/example-app/actions/runs/303",
        commit: commitOf("4"),
      },
    });
    expect(await run(ctx, "rollback", "--resume", "--deploy", "--yes"), ctx.errors).toBe(0);
    expect(fake.calls[0]?.options).toEqual({ resume: true, deploy: true });
    expect(ctx.output).not.toContain("actions/runs/303");
    expect(ctx.output).toContain("run `opscrew verify`");
  });

  it("lets --yes grant the resume's GitHub settings approval in a script", async () => {
    const ctx = await setup();
    fake.answer = async () => {
      const [call] = fake.calls;
      const decision = await call?.deps.approvals.request({
        kind: "github-settings",
        title: "Resume the deploys of prod",
        details: "",
      });
      expect(decision?.approved).toBe(true);
      return { kind: "resumed", wasPaused: true };
    };
    expect(await run(ctx, "rollback", "--resume", "--yes"), ctx.errors).toBe(0);
  });

  it("gives no verify step while the deploy run waits for a reviewer", async () => {
    const ctx = await setup();
    fake.answer = async () => ({
      kind: "resumed",
      wasPaused: true,
      deployed: {
        status: "waiting",
        runUrl: "https://github.com/example-org/example-app/actions/runs/304",
        commit: commitOf("5"),
      },
    });
    expect(await run(ctx, "rollback", "--resume", "--deploy"), ctx.errors).toBe(0);
    expect(ctx.output).not.toContain("opscrew verify");
  });
});
