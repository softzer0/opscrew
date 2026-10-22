import { canonicalJson } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost, type FakeRunner } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  planFor,
  provision,
  removeApp,
  runnerDesired,
  runnerToken,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
} from "./__fixtures__/helpers";
import { SSHD_DROP_IN } from "./constants";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planHost, planRunnerHost, planTeardown, planUndo } from "./plan";
import { stepScripts } from "./steps";
import type { ApplyResult, DesiredRunnerHost, HostPlan, HostStep } from "./types";

const ADD = "opscrew runner host add home";
const REMOVE = "opscrew runner host remove home";

/** The runner of the environment `env` of "shop" (its app `shop-<env>`) on the runner machine. */
function envRunner(env: string): DesiredRunnerHost["runners"][number] {
  return {
    app: `shop-${env}`,
    runner: runnerDesired({ label: `opscrew-shop-${env}`, name: `home-shop-${env}` }),
  };
}

/** A machine the user owns, reached as "ana" with passwordless sudo (a desktop), without Docker. */
function machine(): FakeHost {
  return new FakeHost({ login: "ana" });
}

async function machinePlan(
  fake: FakeHost,
  runners: DesiredRunnerHost["runners"] = [],
  command = ADD,
): Promise<HostPlan> {
  return planRunnerHost(
    await inspectHost(fake),
    { repositoryUrl: SHOP_REPOSITORY, runners },
    command,
  );
}

/** A `runnerToken` callback that hands out a new token on each call and remembers them. */
function tokens() {
  const handed: { kind: "registration" | "remove"; token: string }[] = [];
  const fetch = async (kind: "registration" | "remove") => {
    const token = runnerToken(`${kind}-${handed.length}`);
    handed.push({ kind, token });
    return token;
  };
  return { handed, fetch };
}

/** The machine with the runners of staging and preview, as applied from its host plan. */
async function withTwoRunners(fake: FakeHost) {
  const plan = await machinePlan(fake, [envRunner("staging"), envRunner("preview")]);
  return applyApproved(fake, plan, { command: ADD, runnerToken: tokens().fetch });
}

/** Each step as `[id, state, app]` (`app` null for the machine's own steps). */
const outline = (plan: HostPlan) =>
  plan.steps.map((step) => [step.id, step.state, step.params.app ?? null]);

/** The steps whose scripts ran on the fake, by their script's first word, in order. */
const stepsRun = (fake: FakeHost) => [
  ...new Set(
    fake
      .names()
      .filter((name) => /\.(check|apply|verify)$/.test(name))
      .map((name) => name.split(".")[0]),
  ),
];

/** Another repository's runner in a folder of the machine. */
const THEIRS: FakeRunner = {
  registered: true,
  active: true,
  version: "2.338.0",
  label: "opscrew-shop-staging",
  url: "https://github.com/someone/shop",
};

const theirFinding = (app: string, command: string, url = THEIRS.url) => ({
  code: "runner-other-repository",
  message: `The runner folder /srv/runners/${app} holds the GitHub Actions runner of another repository (${url}), and OpsCrew never replaces or removes another repository's runner.`,
  hint: `Remove that runner in its own project first (with opscrew destroy there, or by setting its environment's runner back to github). If it was this project's runner before the repository was renamed or transferred, unregister it in the old repository's settings (Settings, Actions, Runners), then run "sudo rm -rf /srv/runners/${app}" there. Then run ${command} again.`,
});

describe("a runner machine's host plan", () => {
  it("holds Docker, the deploy user and one runner per environment, and nothing that hardens the machine", async () => {
    const fake = machine();
    const plan = await machinePlan(fake, [envRunner("staging"), envRunner("preview")]);
    expect(plan).toMatchObject({ schemaVersion: 1, purpose: "setup", app: "", findings: [] });
    expect(plan.otherApps).toBeUndefined();
    expect(outline(plan)).toEqual([
      ["docker", "change", null],
      ["deploy-user", "change", null],
      ["github-runner", "change", "shop-preview"],
      ["github-runner", "change", "shop-staging"],
    ]);
    const staging = plan.steps[3] as HostStep;
    expect(staging.params).toEqual({
      app: "shop-staging",
      user: "deploy",
      ...envRunner("staging").runner,
    });
    expect(staging.title).toBe(
      'Install the GitHub Actions runner 2.338.0 for "shop-staging", run as deploy, with the label opscrew-shop-staging',
    );
    // Each runner step is its own app's, though the plan is no one app's.
    for (const step of plan.steps) expect(() => stepScripts(plan, step)).not.toThrow();

    const fetched = tokens();
    const result = await applyApproved(fake, plan, { command: ADD, runnerToken: fetched.fetch });
    expect(result).toEqual({
      applied: ["docker", "deploy-user", "github-runner", "github-runner"],
      skipped: [],
    });
    expect(fetched.handed.map((item) => item.kind)).toEqual(["registration", "registration"]);
    expect(fake.runnerLog).toEqual([
      `register ${SHOP_REPOSITORY} home-shop-preview opscrew-shop-preview 2.338.0 from ${runnerDesired().url}`,
      `register ${SHOP_REPOSITORY} home-shop-staging opscrew-shop-staging 2.338.0 from ${runnerDesired().url}`,
    ]);
    expect(stepsRun(fake)).toEqual(["docker", "deploy-user", "github-runner"]);
    expect(fake.packages.has("docker-ce")).toBe(true);
    expect(fake.users.get("deploy")?.groups).toContain("docker");
    expect(fake.runnerPrepared).toBe(true);
    // No firewall, SSH, app record or edge: the machine may be the user's desktop.
    expect(fake.ufwActive).toBe(false);
    expect(fake.ufwRules).toEqual([]);
    expect(
      [...fake.files.keys()].filter((path) => /^\/etc\/(ssh|opscrew\/apps)\//.test(path)),
    ).toEqual([]);
    expect(fake.files.has("/var/lib/opscrew-ready")).toBe(false);
    expect(JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}")).toMatchObject({
      apps: [],
    });

    const again = tokens();
    const next = await machinePlan(fake, [envRunner("preview"), envRunner("staging")]);
    expect(next.steps.map((step) => step.state)).toEqual([
      "in-place",
      "in-place",
      "in-place",
      "in-place",
    ]);
    await applyApproved(fake, next, { command: ADD, runnerToken: again.fetch });
    expect(again.handed).toEqual([]);
  });

  it("is only Docker and the deploy user while no environment uses the machine", async () => {
    const fake = machine();
    expect(outline(await machinePlan(fake))).toEqual([
      ["docker", "change", null],
      ["deploy-user", "change", null],
    ]);
  });

  it.each([
    {
      what: "runs a system OpsCrew does not support",
      fake: () => new FakeHost({ os: "linuxmint-22", login: "ana" }),
      finding: "This server runs Linux Mint 22, which OpsCrew does not support.",
    },
    {
      what: "has no passwordless sudo",
      fake: () => new FakeHost({ login: "ana", sudo: "password" }),
      finding:
        "The login ana needs a password for sudo, and OpsCrew never asks for or stores passwords.",
    },
  ])("plans nothing, with the plain finding, on a machine that $what", async (item) => {
    const fake = item.fake();
    const plan = await machinePlan(fake, [envRunner("staging")]);
    expect(plan.findings.map((finding) => finding.message)).toEqual([item.finding]);
    expect(plan.steps).toEqual([]);
    await expect(
      applyApproved(fake, plan, { command: ADD, runnerToken: tokens().fetch }),
    ).rejects.toThrow(`OpsCrew cannot change this server yet: ${item.finding}`);
  });

  it("refuses input that is not a runner machine's", async () => {
    const facts = await inspectHost(machine());
    const plan = (desired: DesiredRunnerHost) => () => planRunnerHost(facts, desired, ADD);
    expect(
      plan({
        repositoryUrl: SHOP_REPOSITORY,
        runners: [envRunner("staging"), envRunner("staging")],
      }),
    ).toThrow("The runner machine's settings are not valid (runners: must name each app once).");
    const elsewhere = {
      app: "shop-staging",
      runner: runnerDesired({ repositoryUrl: "https://github.com/acme/blog" }),
    };
    expect(plan({ repositoryUrl: SHOP_REPOSITORY, runners: [elsewhere] })).toThrow(
      "The runner machine's settings are not valid (runners: must be the project's repository).",
    );
    // A server's runner too is the project's repository's.
    const desired = desiredFor(machine(), { runner: elsewhere.runner });
    expect(() => planHost(facts, desired, "opscrew provision")).toThrow(
      "The settings for this server are not valid (runner: must be the project's repository).",
    );
  });
});

describe("removing one environment's runner from a runner machine", () => {
  it("is a plan of that runner's removal alone, and the last one takes deploy's lingering and /srv/runners along", async () => {
    const fake = machine();
    await withTwoRunners(fake);
    const destroy = "opscrew destroy --env staging";
    const removal = await machinePlan(fake, [{ app: "shop-staging" }], destroy);
    expect(removal.findings).toEqual([]);
    expect(removal.steps).toEqual([
      {
        id: "github-runner",
        title: 'Remove the GitHub Actions runner of "shop-staging"',
        state: "change",
        scope: "app",
        reason:
          "The deploy job no longer runs on this server's runner. As deploy, stops and disables its service opscrew-runner-shop-staging.service, unregisters it from GitHub with a remove token fetched while this plan is applied (never part of this plan), and deletes /srv/runners/shop-staging.",
        // The host record says /srv/runners was not there before OpsCrew.
        params: { app: "shop-staging", remove: true, removeParent: true },
      },
    ]);
    // A removal never installs anything, even when Docker went meanwhile.
    fake.packages.delete("docker-ce");
    expect(await machinePlan(fake, [{ app: "shop-staging" }], destroy)).toEqual(removal);

    fake.calls.length = 0;
    const fetched = tokens();
    const result = await applyApproved(fake, removal, {
      command: destroy,
      runnerToken: fetched.fetch,
    });
    expect(result).toEqual({ applied: ["github-runner"], skipped: [] });
    expect(fetched.handed.map((item) => item.kind)).toEqual(["remove"]);
    expect(stepsRun(fake)).toEqual(["github-runner"]);
    expect(fake.runnerLog.at(-1)).toBe("unregister shop-staging");
    expect([...fake.runners.keys()]).toEqual(["shop-preview"]);
    // The other environment's runner still runs: deploy keeps lingering, /srv/runners stays.
    expect(fake.runnerPrepared).toBe(true);
    expect(fake.dirs.has("/srv/runners")).toBe(true);
    // Gone already: nothing to plan.
    expect((await machinePlan(fake, [{ app: "shop-staging" }], destroy)).steps).toEqual([]);

    await applyApproved(fake, await machinePlan(fake, [{ app: "shop-preview" }]), {
      runnerToken: tokens().fetch,
    });
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerPrepared).toBe(false);
    expect(fake.dirs.has("/srv/runners")).toBe(false);
  });
});

describe("a runner folder of another repository", () => {
  it("is never replaced on a runner machine", async () => {
    const fake = machine();
    fake.runners.set("shop-staging", { ...THEIRS });
    const plan = await machinePlan(fake, [envRunner("staging")]);
    expect(plan.steps.find((step) => step.id === "github-runner")).toMatchObject({
      state: "blocked",
      reason: "/srv/runners/shop-staging holds the runner of another repository.",
    });
    expect(plan.findings).toEqual([theirFinding("shop-staging", ADD)]);
    await expect(
      applyApproved(fake, plan, { command: ADD, runnerToken: tokens().fetch }),
    ).rejects.toThrow("OpsCrew cannot change this server yet");
    expect(fake.names()).not.toContain("github-runner.apply");
    expect(fake.runners.get("shop-staging")).toEqual(THEIRS);
  });

  it("is never removed from a runner machine", async () => {
    const fake = machine();
    fake.runners.set("shop-staging", { ...THEIRS });
    const plan = await machinePlan(fake, [{ app: "shop-staging" }]);
    expect(outline(plan)).toEqual([["github-runner", "blocked", "shop-staging"]]);
    expect(plan.findings).toEqual([theirFinding("shop-staging", ADD)]);
    await expect(
      applyApproved(fake, plan, { command: ADD, runnerToken: tokens().fetch }),
    ).rejects.toThrow("OpsCrew cannot change this server yet");
    expect(fake.runners.get("shop-staging")).toEqual(THEIRS);
  });

  it("is never replaced on a server you own either", async () => {
    const fake = new FakeHost();
    fake.runners.set("shop", { ...THEIRS, label: "opscrew-shop-prod" });
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    expect(plan.steps.find((step) => step.id === "github-runner")).toMatchObject({
      state: "blocked",
      reason: "/srv/runners/shop holds the runner of another repository.",
    });
    expect(plan.findings).toEqual([theirFinding("shop", "opscrew provision")]);
    await expect(applyApproved(fake, plan, { runnerToken: tokens().fetch })).rejects.toThrow(
      "OpsCrew cannot change this server yet",
    );
    expect(fake.names()).not.toContain("docker.apply");
  });

  it("is never removed from a server you own, when its app goes back to GitHub's machines or at its teardown", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const theirs = { ...THEIRS, label: "opscrew-shop-prod" };
    fake.runners.set("shop", theirs);
    const back = await planFor(fake, desiredFor(fake));
    expect(back.steps.find((step) => step.id === "github-runner")).toMatchObject({
      state: "blocked",
      params: { app: "shop", remove: true },
    });
    expect(back.findings).toEqual([theirFinding("shop", "opscrew provision")]);
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(teardown.steps[0]).toMatchObject({ id: "github-runner", state: "blocked" });
    expect(teardown.findings).toEqual([theirFinding("shop", "opscrew destroy")]);
    await expect(
      applyApproved(fake, teardown, { command: "opscrew destroy", runnerToken: tokens().fetch }),
    ).rejects.toThrow("OpsCrew cannot change this server yet");
    expect(fake.runners.get("shop")).toEqual(theirs);
  });

  it("is this repository's when its URL differs only in case (GitHub's names ignore case)", async () => {
    const fake = machine();
    await withTwoRunners(fake);
    const staging = fake.runners.get("shop-staging");
    if (staging) staging.url = "https://github.com/ACME/Shop";
    const removal = await machinePlan(fake, [{ app: "shop-staging" }]);
    expect(removal.findings).toEqual([]);
    expect(outline(removal)).toEqual([["github-runner", "change", "shop-staging"]]);
  });

  it("does not count when the folder names no repository (an install that stopped part-way): it is installed over", async () => {
    const fake = machine();
    fake.runners.set("shop-staging", {
      registered: false,
      active: false,
      version: "-",
      label: "-",
      url: "-",
    });
    const plan = await machinePlan(fake, [envRunner("staging")]);
    expect(plan.findings).toEqual([]);
    expect(outline(plan).at(-1)).toEqual(["github-runner", "change", "shop-staging"]);
  });
});

describe("a runner machine's teardown", () => {
  it("removes OpsCrew's runners, deploy's lingering, /srv/runners and the deploy user it made, then its records; Docker stays", async () => {
    const fake = machine();
    await withTwoRunners(fake);
    const plan = planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, REMOVE);
    expect(plan).toMatchObject({ schemaVersion: 1, purpose: "undo", app: "", findings: [] });
    expect(outline(plan)).toEqual([
      ["github-runner", "change", "shop-preview"],
      ["github-runner", "change", "shop-staging"],
      ["deploy-user", "change", null],
      ["docker", "in-place", null],
      ["app-record", "change", null],
    ]);
    expect(plan.steps[0]?.params).toEqual({
      app: "shop-preview",
      remove: true,
      removeParent: true,
    });

    fake.calls.length = 0;
    const fetched = tokens();
    const result = await applyApproved(fake, plan, { command: REMOVE, runnerToken: fetched.fetch });
    expect(result).toEqual({
      applied: ["github-runner", "github-runner", "deploy-user", "app-record"],
      skipped: ["docker"],
    });
    expect(fetched.handed.map((item) => item.kind)).toEqual(["remove", "remove"]);
    expect(fake.runnerLog.slice(-2)).toEqual([
      "unregister shop-preview",
      "unregister shop-staging",
    ]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerPrepared).toBe(false);
    expect(fake.dirs.has("/srv/runners")).toBe(false);
    expect(fake.users.has("deploy")).toBe(false);
    expect([...fake.files.keys()].filter((path) => path.startsWith("/etc/opscrew/"))).toEqual([]);
    // As on a server you own, Docker stays: other software may use it.
    expect(fake.packages.has("docker-ce")).toBe(true);
  });

  it("is refused while another repository's runner is on the machine, and changes nothing", async () => {
    const fake = machine();
    await withTwoRunners(fake);
    fake.runners.set("blog-prod", { ...THEIRS, label: "opscrew-blog-prod" });
    const plan = planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, REMOVE);
    expect(plan.findings).toEqual([theirFinding("blog-prod", REMOVE)]);
    expect(plan.steps.find((step) => step.params.app === "blog-prod")).toMatchObject({
      state: "blocked",
      reason: "/srv/runners/blog-prod holds the runner of another repository.",
    });
    fake.calls.length = 0;
    await expect(
      applyApproved(fake, plan, { command: REMOVE, runnerToken: tokens().fetch }),
    ).rejects.toThrow("OpsCrew cannot change this server yet");
    expect(fake.names()).toEqual([]);
    expect(fake.runners.size).toBe(3);
    expect(fake.users.has("deploy")).toBe(true);
  });

  it("refuses a repository that is not a GitHub repository's URL", async () => {
    const facts = await inspectHost(machine());
    expect(() => planUndo(facts, { repositoryUrl: "acme/shop" }, REMOVE)).toThrow(
      "The project's repository is not valid (repositoryUrl: must be https://github.com/<owner>/<repo>).",
    );
  });
});

describe("a host that is one project's own server and another project's runner machine", () => {
  const BLOG = "https://github.com/someone/blog";

  /** Project A's app "shop" with its server's runner, then project B's runner "blog-staging". */
  async function shared(): Promise<FakeHost> {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { runner: runnerDesired() }), {
      runnerToken: tokens().fetch,
    });
    const blog = {
      app: "blog-staging",
      runner: runnerDesired({
        repositoryUrl: BLOG,
        label: "opscrew-blog-staging",
        name: "home-blog-staging",
      }),
    };
    const plan = planRunnerHost(
      await inspectHost(fake),
      { repositoryUrl: BLOG, runners: [blog] },
      ADD,
    );
    expect(plan.findings).toEqual([]);
    await applyApproved(fake, plan, { command: ADD, runnerToken: tokens().fetch });
    expect([...fake.runners.keys()].sort()).toEqual(["blog-staging", "shop"]);
    return fake;
  }

  /** B's runner still runs there, as the deploy user, who still lingers. */
  function blogStays(fake: FakeHost): void {
    expect(fake.runners.get("blog-staging")).toMatchObject({ url: BLOG, active: true });
    expect(fake.users.has("deploy")).toBe(true);
    expect(fake.runnerPrepared).toBe(true);
  }

  const teardownOf = async (fake: FakeHost) =>
    planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );

  it("A's runner going back to GitHub's machines, A's teardown and A's undo leave B's runner and the deploy user", async () => {
    const fake = await shared();
    const back = await planFor(fake, desiredFor(fake));
    expect(back.findings).toEqual([]);
    expect(
      back.steps.filter((step) => step.id === "github-runner").map((step) => step.params.app),
    ).toEqual(["shop"]);
    await applyApproved(fake, back, { runnerToken: tokens().fetch });
    expect([...fake.runners.keys()]).toEqual(["blog-staging"]);
    blogStays(fake);

    const teardown = await teardownOf(fake);
    expect(teardown.findings).toEqual([]);
    expect(teardown.steps.map((step) => step.id)).not.toContain("github-runner");
    await applyApproved(fake, teardown, { command: "opscrew destroy" });
    blogStays(fake);

    // Undoing A's host changes would remove the deploy user B's runner runs as.
    const undoing = "opscrew destroy --undo-host";
    const undo = planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, undoing);
    expect(undo.findings).toEqual([theirFinding("blog-staging", undoing, BLOG)]);
    expect(undo.steps.find((step) => step.params.app === "blog-staging")?.state).toBe("blocked");
    fake.calls.length = 0;
    await expect(
      applyApproved(fake, undo, { command: undoing, runnerToken: tokens().fetch }),
    ).rejects.toThrow("OpsCrew cannot change this server yet");
    expect(fake.names()).toEqual([]);
    blogStays(fake);
  });

  it("A's teardown with its runner still there removes A's runner alone", async () => {
    const fake = await shared();
    const teardown = await teardownOf(fake);
    expect(teardown.findings).toEqual([]);
    expect(teardown.steps[0]).toMatchObject({
      id: "github-runner",
      state: "change",
      params: { app: "shop", remove: true },
    });
    await applyApproved(fake, teardown, {
      command: "opscrew destroy",
      runnerToken: tokens().fetch,
    });
    expect([...fake.runners.keys()]).toEqual(["blog-staging"]);
    blogStays(fake);
  });
});

describe("a teardown or undo whose project's repository is unknown (no GitHub remote)", () => {
  const note = (app: string, command: string) =>
    `This project has no GitHub remote named origin, so OpsCrew cannot tell which repository the runner in /srv/runners/${app} belongs to, and leaves it there. Remove it under the repository's Settings → Actions → Runners and delete /srv/runners/${app}, or add the origin remote and run ${command} again.`;

  it("leaves every runner, named, and the deploy user it runs as; the rest goes as before", async () => {
    const fake = new FakeHost();
    await provision(fake, desiredFor(fake, { runner: runnerDesired() }), {
      runnerToken: tokens().fetch,
    });
    const destroy = "opscrew destroy";
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      destroy,
    );
    expect(teardown.findings).toEqual([]);
    expect(teardown.steps[0]).toEqual({
      id: "github-runner",
      title: 'Leave the GitHub Actions runner of "shop" on this server',
      state: "in-place",
      scope: "app",
      reason: note("shop", destroy),
      params: { app: "shop", keep: true },
    });
    const fetched = tokens();
    const torn = await applyApproved(fake, teardown, {
      command: destroy,
      runnerToken: fetched.fetch,
    });
    expect(torn.skipped).toContain("github-runner");
    expect(fake.files.has("/etc/opscrew/apps/shop.json")).toBe(false);

    const undoing = "opscrew destroy --undo-host";
    const undo = planUndo(await inspectHost(fake), {}, undoing);
    expect(undo.findings).toEqual([]);
    expect(
      undo.steps.filter((step) => step.params.keep === true).map((step) => [step.id, step.reason]),
    ).toEqual([
      ["github-runner", note("shop", undoing)],
      ["deploy-user", 'The runner of "shop" runs as deploy, so the user stays while it is there.'],
      [
        "app-record",
        "OpsCrew's records stay on the server until the runner is gone; add the origin remote and run opscrew destroy --undo-host again to finish.",
      ],
    ]);
    const kept = await applyApproved(fake, undo, { command: undoing, runnerToken: fetched.fetch });
    expect(kept.applied).not.toContain("app-record");
    // No runner was touched, and no token fetched; the rest of OpsCrew's changes are undone, and
    // its records stay for what is left.
    expect(fetched.handed).toEqual([]);
    expect([...fake.runners.keys()]).toEqual(["shop"]);
    expect(fake.users.has("deploy")).toBe(true);
    expect(fake.runnerPrepared).toBe(true);
    expect(fake.files.has(SSHD_DROP_IN)).toBe(false);
    // The record still holds what OpsCrew set up for them; what was undone has left it.
    const record = JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}") as {
      changes: { step: string; purpose: string }[];
    };
    const setup = record.changes.filter((entry) => entry.purpose === "setup").map((e) => e.step);
    expect(setup).toEqual(expect.arrayContaining(["deploy-user", "github-runner"]));
    expect(setup).not.toContain("sshd");

    // With the origin remote set, a second undo finishes the job.
    const again = planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, undoing);
    expect(again.findings).toEqual([]);
    expect(again.steps.filter((step) => step.state === "change").map((step) => step.id)).toEqual([
      "github-runner",
      "deploy-user",
      "app-record",
    ]);
    await applyApproved(fake, again, { command: undoing, runnerToken: fetched.fetch });
    expect(fetched.handed.map((item) => item.kind)).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerPrepared).toBe(false);
    expect(fake.users.has("deploy")).toBe(false);
    expect([...fake.files.keys()].filter((path) => path.startsWith("/etc/opscrew/"))).toEqual([]);
  });

  it("is the undo it was when no runner is on the server", async () => {
    const fake = new FakeHost();
    await provision(fake);
    await removeApp(fake);
    const facts = await inspectHost(fake);
    const undoing = "opscrew destroy --undo-host";
    expect(planUndo(facts, {}, undoing)).toEqual(
      planUndo(facts, { repositoryUrl: SHOP_REPOSITORY }, undoing),
    );
  });
});

describe("the runner tokens on a runner machine", () => {
  it("stay out of every plan, its hash, the commands, the files, the results and the runners' log", async () => {
    const fake = machine();
    const fetched = tokens();
    const plans: HostPlan[] = [];
    const results: ApplyResult[] = [];
    const run = async (plan: HostPlan, command: string) => {
      plans.push(plan);
      results.push(await applyApproved(fake, plan, { command, runnerToken: fetched.fetch }));
    };
    await run(await machinePlan(fake, [envRunner("staging"), envRunner("preview")]), ADD);
    await run(await machinePlan(fake, [{ app: "shop-staging" }]), "opscrew destroy --env staging");
    await run(
      planUndo(await inspectHost(fake), { repositoryUrl: SHOP_REPOSITORY }, REMOVE),
      REMOVE,
    );
    expect(fetched.handed.map((item) => item.kind)).toEqual([
      "registration",
      "registration",
      "remove",
      "remove",
    ]);
    const all = fetched.handed.map((item) => item.token);
    expect(new Set(all).size).toBe(4);
    for (const token of all) {
      for (const plan of plans) {
        expect(JSON.stringify(plan)).not.toContain(token);
        expect(canonicalJson(plan)).not.toContain(token);
        expect(hostPlanHash(plan)).not.toContain(token);
      }
      expect(JSON.stringify(results)).not.toContain(token);
      for (const call of fake.calls) {
        expect(call.command).not.toContain(token);
        expect(JSON.stringify(call.params)).not.toContain(token);
      }
      for (const [path, content] of fake.files) expect(`${path} ${content}`).not.toContain(token);
      expect(fake.runnerLog.join("\n")).not.toContain(token);
    }
    // Each token reached one runner step's apply, alone, on stdin; no other call got stdin.
    expect(
      fake.calls.filter((call) => call.input !== undefined).map((call) => [call.name, call.input]),
    ).toEqual(
      fetched.handed.map(({ kind, token }) => [
        kind === "registration" ? "github-runner.apply" : "github-runner.remove.apply",
        `${token}\n`,
      ]),
    );
  });
});
