import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { canonicalJson, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  desiredFor,
  planFor,
  provision,
  RUNNER_ARCHIVE,
  runnerDesired,
  runnerToken,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  tunnelDesired,
} from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { hostPlanHash } from "./hash";
import { inspectHost, inspectRunners, inspectRunnersScript, inspectScript } from "./inspect";
import { parseRunners, splitSections } from "./parse";
import { planHost, planRunner, planTeardown, planUndo } from "./plan";
import { stepScripts } from "./steps";
import type { DesiredRunner, HostPlan, HostStep } from "./types";

/** A `runnerToken` callback that hands out `tokens` by kind and records each call. */
function tokens(values: { registration?: string; remove?: string } = {}) {
  const calls: string[] = [];
  const fetch = async (kind: "registration" | "remove") => {
    calls.push(kind);
    return (kind === "registration" ? values.registration : values.remove) ?? runnerToken(kind);
  };
  return { calls, fetch };
}

function runnerStepOf(plan: HostPlan, app = "shop"): HostStep {
  const step = plan.steps.find((item) => item.id === "github-runner" && item.params.app === app);
  if (step === undefined) throw new Error("no github-runner step");
  return step;
}

function setRegistered(fake: FakeHost, registered: boolean): void {
  const runner = fake.runners.get("shop");
  if (runner) runner.registered = registered;
}

/** The start of the fake's log line for the runner's registration. */
const REGISTERED = "register https://github.com/acme/shop home-shop-prod opscrew-shop-prod";

/** Sets the app up on the fake with its runner; returns the registration token it used. */
async function withRunner(fake: FakeHost) {
  const registration = runnerToken("registration");
  await provision(fake, desiredFor(fake, { runner: runnerDesired() }), {
    runnerToken: tokens({ registration }).fetch,
  });
  return registration;
}

/** The runner's calls on the fake, in order. */
function runnerCalls(fake: FakeHost) {
  return fake.calls.filter((call) => call.name.startsWith("github-runner"));
}

describe("the github-runner step", () => {
  it("comes after app-record and before the tunnel connector, and names the version, checksum, user, label, folder and service", async () => {
    const fake = new FakeHost();
    const runner = runnerDesired();
    const plan = await planFor(fake, tunnelDesired(fake, { runner }));
    const ids = plan.steps.map((step) => step.id);
    expect(ids.slice(ids.indexOf("app-record"))).toEqual([
      "app-record",
      "github-runner",
      "tunnel-connector",
    ]);
    const step = runnerStepOf(plan);
    expect(step).toMatchObject({ state: "change", scope: "app" });
    expect(step.params).toEqual({ app: "shop", user: "deploy", ...runner });
    expect(step.title).toBe(
      'Install the GitHub Actions runner 2.338.0 for "shop", run as deploy, with the label opscrew-shop-prod',
    );
    expect(step.reason).toContain(
      "As root, installs the runner's system libraries (those GitHub's installdependencies.sh picks for this release) and lets deploy's services run without a login (loginctl enable-linger deploy). Then, as deploy, it downloads actions-runner-linux-x64-2.338.0.tar.gz",
    );
    expect(step.reason).toContain(`SHA-256 ${runner.sha256}`);
    expect(step.reason).toContain("extracts it to /srv/runners/shop,");
    expect(step.reason).toContain("deploy's systemd user service opscrew-runner-shop.service");
    expect(step.reason).toContain(
      "a registration token fetched while this plan is applied (never part of this plan)",
    );
  });

  it("refuses an archive for another architecture", async () => {
    const fake = new FakeHost({ arch: "arm64" });
    await expect(planFor(fake, desiredFor(fake, { runner: runnerDesired() }))).rejects.toThrow(
      "The runner's archive is for linux-x64, but this server is arm64.",
    );
    const plan = await planFor(
      fake,
      desiredFor(fake, { runner: runnerDesired({ asset: "linux-arm64" }) }),
    );
    expect(stepScripts(plan, runnerStepOf(plan)).apply).toContain(
      "ARCHIVE_URL='https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-arm64-2.338.0.tar.gz'",
    );
  });

  it("downloads the pin's URL, and refuses one of another version or asset", async () => {
    const fake = new FakeHost();
    const other = runnerDesired({ version: "2.337.0" }).url;
    await expect(
      planFor(fake, desiredFor(fake, { runner: runnerDesired({ url: other }) })),
    ).rejects.toThrow("The runner's archive URL is not the one of version 2.338.0 for linux-x64.");
    await expect(
      planFor(
        fake,
        desiredFor(fake, { runner: runnerDesired({ url: "https://example.com/r.tgz" }) }),
      ),
    ).rejects.toThrow("runner.url: must be a release archive of github.com/actions/runner");
  });

  it("is blocked with the rest on a server OpsCrew cannot work on", async () => {
    const fake = new FakeHost({ os: "ubuntu-20.04" });
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    expect(plan.steps.find((step) => step.id === "github-runner")?.state).toBe("blocked");
  });

  it("prepares the server as root, then registers the runner as deploy with a token fetched only when the step runs, and is in place afterwards", async () => {
    const fake = new FakeHost();
    const registration = runnerToken("registration");
    const fetched = tokens({ registration });
    const { result } = await provision(fake, desiredFor(fake, { runner: runnerDesired() }), {
      runnerToken: fetched.fetch,
    });
    expect(result.applied).toContain("github-runner");
    expect(fetched.calls).toEqual(["registration"]);
    expect(fake.runnerLog).toEqual([`${REGISTERED} 2.338.0 from ${runnerDesired().url}`]);
    // The root part as root; every runner command as deploy, through runuser.
    expect(runnerCalls(fake).map((call) => [call.name, call.asUser ?? "root"])).toEqual([
      ["github-runner.check", "deploy"],
      ["github-runner.root.apply", "root"],
      ["github-runner.apply", "deploy"],
      ["github-runner.verify", "deploy"],
    ]);
    expect(fake.calls.find((call) => call.name === "github-runner.apply")?.command).toMatch(
      /^sh -c 'runuser -u deploy -- sh -c '\\''# opscrew-host: github-runner\.apply\n/,
    );
    expect(fake.runnerPrepared).toBe(true);
    // Only the step's apply got stdin, and that is the token alone.
    const apply = fake.calls.find((call) => call.name === "github-runner.apply");
    expect(apply?.input).toBe(`${registration}\n`);

    const facts = await inspectHost(fake);
    expect(facts.runners).toEqual([
      {
        app: "shop",
        registered: true,
        active: true,
        version: "2.338.0",
        label: "opscrew-shop-prod",
        repositoryUrl: "https://github.com/acme/shop",
      },
    ]);
    const again = tokens();
    const next = planHost(
      facts,
      desiredFor(fake, { runner: runnerDesired() }),
      "opscrew provision",
    );
    expect(runnerStepOf(next)).toMatchObject({
      state: "in-place",
      reason: "Already registered and running (version 2.338.0).",
    });
    await applyApproved(fake, next, { runnerToken: again.fetch });
    expect(again.calls).toEqual([]);
  });

  it("stays in place on a newer version the runner updated itself to", async () => {
    const fake = new FakeHost();
    await withRunner(fake);
    const runner = fake.runners.get("shop");
    if (runner) runner.version = "2.340.1";
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    expect(runnerStepOf(plan).state).toBe("in-place");
  });

  it.each([
    {
      what: "an older version",
      change: { version: "2.337.0" },
      why: "it is at 2.337.0, older than 2.338.0",
    },
    {
      what: "a changed label",
      change: { label: "opscrew-shop-staging" },
      why: "it has the label opscrew-shop-staging, not opscrew-shop-prod",
    },
    { what: "a stopped service", change: { active: false }, why: "its service is not running" },
    // Another repository's runner is never installed over: see runner-host.test.ts.
  ])(
    "installs it again over its folder for $what, with a token fetched only then",
    async ({ change, why }) => {
      const fake = new FakeHost();
      await withRunner(fake);
      const runner = fake.runners.get("shop");
      if (runner) Object.assign(runner, change);
      const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
      expect(runnerStepOf(plan).state).toBe("change");
      expect(
        runnerStepOf(plan).reason?.startsWith(
          `The runner on this server is not the planned one (${why}), so OpsCrew installs it again over its folder, registers it again in its place and restarts its service. As root, installs `,
        ),
      ).toBe(true);
      const fetched = tokens();
      await applyApproved(fake, plan, { runnerToken: fetched.fetch });
      expect(fetched.calls).toEqual(["registration"]);
      expect(fake.runnerLog).toEqual([
        `${REGISTERED} 2.338.0 from ${runnerDesired().url}`,
        `${REGISTERED} 2.338.0 from ${runnerDesired().url}`,
      ]);
      const after = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
      expect(runnerStepOf(after).state).toBe("in-place");
    },
  );

  it("keeps the token out of the plan, its hash, the fake host's commands, output, files and the host record", async () => {
    const fake = new FakeHost();
    const registration = runnerToken("registration");
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    const result = await applyApproved(fake, plan, {
      runnerToken: tokens({ registration }).fetch,
    });
    expect(JSON.stringify(plan)).not.toContain(registration);
    expect(canonicalJson(plan)).not.toContain(registration);
    expect(hostPlanHash(plan)).not.toContain(registration);
    // What callers write to the audit log: the plan's hash and the steps applied.
    expect(JSON.stringify({ hash: hostPlanHash(plan), ...result })).not.toContain(registration);
    for (const call of fake.calls) {
      expect(call.command).not.toContain(registration);
      expect(JSON.stringify(call.params)).not.toContain(registration);
      if (call.name !== "github-runner.apply") expect(call.input ?? "").not.toContain(registration);
    }
    for (const [path, content] of fake.files) {
      expect(`${path} ${content}`).not.toContain(registration);
    }
    expect(fake.runnerLog.join("\n")).not.toContain(registration);
    const record = fake.files.get("/etc/opscrew/host.json") ?? "";
    expect(record).toContain('"step":"github-runner"');
  });

  it("registers the token with the redactor before the script runs", async () => {
    const fake = new FakeHost();
    const registration = runnerToken("registration");
    fake.echoStdinOn = "github-runner.apply";
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    const error = await applyApproved(fake, plan, {
      runnerToken: tokens({ registration }).fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const { message, hint, cause } = error as Error & { hint?: string };
    expect(`${message} ${hint}`).toContain("[REDACTED:runner-token]");
    expect(`${message} ${hint}`).not.toContain(registration);
    expect(cause).toBeUndefined();
  });

  it("refuses before any change without a way to fetch the token, or with one that does not look like a token", async () => {
    const fake = new FakeHost();
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    await expect(applyApproved(fake, plan)).rejects.toThrow(
      "Applying this plan needs a GitHub runner token, and no way to fetch one was supplied.",
    );
    expect(fake.names()).not.toContain("docker.apply");

    const bad = "not a token; rm -rf /";
    await expect(
      applyApproved(fake, plan, { runnerToken: tokens({ registration: bad }).fetch }),
    ).rejects.toThrow(
      "The runner registration token from GitHub does not look like one, so OpsCrew did not send it to the server.",
    );
    expect(fake.names()).not.toContain("github-runner.apply");
  });
});

describe("removing the runner", () => {
  it("teardown removes it first, as deploy with a remove token, then its root parts with the last runner, then the app", async () => {
    const fake = new FakeHost();
    const registration = await withRunner(fake);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(plan.steps[0]).toEqual({
      id: "github-runner",
      title: 'Remove the GitHub Actions runner of "shop"',
      state: "change",
      scope: "app",
      reason:
        "As deploy, stops and disables its service opscrew-runner-shop.service, unregisters it from GitHub with a remove token fetched while this plan is applied (never part of this plan), and deletes /srv/runners/shop.",
      // The host record says /srv/runners was not there before OpsCrew: it goes with the runner.
      params: { app: "shop", remove: true, removeParent: true },
    });
    expect(fake.dirs.has("/srv/runners")).toBe(true);
    const remove = runnerToken("remove");
    const fetched = tokens({ remove });
    fake.calls.length = 0;
    const result = await applyApproved(fake, plan, {
      command: "opscrew destroy",
      runnerToken: fetched.fetch,
    });
    expect(result.applied[0]).toBe("github-runner");
    expect(result.stillRegistered).toBeUndefined();
    expect(fetched.calls).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerLog.at(-1)).toBe("unregister shop");
    expect(runnerCalls(fake).map((call) => [call.name, call.asUser ?? "root"])).toEqual([
      ["github-runner.remove.check", "deploy"],
      ["github-runner.remove.apply", "deploy"],
      ["github-runner.remove.root.apply", "root"],
      ["github-runner.remove.verify", "deploy"],
    ]);
    expect(fake.runnerPrepared).toBe(false);
    expect(fake.dirs.has("/srv/runners")).toBe(false);
    const call = fake.calls.find((item) => item.name === "github-runner.remove.apply");
    expect(call?.input).toBe(`${remove}\n`);
    // Each token reached only its own step's apply, on stdin.
    const carriers = ["github-runner.apply", "github-runner.remove.apply"];
    for (const item of fake.calls) {
      const stdin = carriers.includes(item.name) ? "" : (item.input ?? "");
      expect(`${item.command} ${stdin}`).not.toMatch(new RegExp(`${remove}|${registration}`));
    }
  });

  it.each([
    { what: "never registered", arrange: (fake: FakeHost) => setRegistered(fake, false) },
    {
      what: "GitHub did not unregister",
      arrange: (fake: FakeHost) => {
        fake.unregisterFails = true;
      },
    },
  ])("says which runner is still registered on GitHub when it $what", async ({ arrange }) => {
    const fake = new FakeHost();
    await withRunner(fake);
    arrange(fake);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    const result = await applyApproved(fake, plan, {
      command: "opscrew destroy",
      runnerToken: tokens().fetch,
    });
    expect(result.stillRegistered).toEqual(["shop"]);
    expect(fake.runners.size).toBe(0);
  });

  it("keeps a /srv/runners of deploy's that was there before OpsCrew, and records it so", async () => {
    const fake = new FakeHost();
    fake.dirs.set("/srv/runners", { owner: "deploy", group: "deploy", mode: "750", entries: 0 });
    await withRunner(fake);
    const record = JSON.parse(fake.files.get("/etc/opscrew/host.json") ?? "{}") as {
      changes: { step: string; previous: Record<string, unknown> }[];
    };
    expect(record.changes.find((entry) => entry.step === "github-runner")?.previous).toEqual({
      installed: false,
      runners: "present",
    });
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(runnerStepOf(plan).params).toEqual({ app: "shop", remove: true, removeParent: false });
    await applyApproved(fake, plan, { command: "opscrew destroy", runnerToken: tokens().fetch });
    expect(fake.runners.size).toBe(0);
    expect(fake.dirs.has("/srv/runners")).toBe(true);
    // deploy's lingering was OpsCrew's: it goes with the last runner all the same.
    expect(fake.runnerPrepared).toBe(false);
  });

  it("never takes over a /srv/runners that is another user's folder", async () => {
    const fake = new FakeHost();
    fake.dirs.set("/srv/runners", { owner: "root", group: "root", mode: "755", entries: 2 });
    const owner = "its owner is root";
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    expect(runnerStepOf(plan)).toMatchObject({
      state: "blocked",
      reason: "/srv/runners is not the deploy user's folder.",
    });
    expect(plan.findings).toContainEqual({
      code: "runners-dir-taken",
      message: `/srv/runners already exists on this server and is not the deploy user's folder (${owner}), so OpsCrew does not take it over for the GitHub Actions runner.`,
      hint: "Move or rename it if nothing on the server uses it, or set environment.runner to github in the plan, then run opscrew provision again.",
    });
    await expect(applyApproved(fake, plan, { runnerToken: tokens().fetch })).rejects.toThrow(
      "OpsCrew cannot change this server yet",
    );
    expect(fake.names()).not.toContain("github-runner.root.apply");
  });

  it("teardown of another app leaves the runner alone", async () => {
    const fake = new FakeHost();
    await withRunner(fake);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "blog", projectId: "blog-1", repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(plan.steps.map((step) => step.id)).not.toContain("github-runner");
  });

  it("a setup plan without the runner removes the one the app has (back to GitHub's machines)", async () => {
    const fake = new FakeHost();
    await withRunner(fake);
    const plan = await planFor(fake, desiredFor(fake));
    expect(runnerStepOf(plan)).toMatchObject({
      title: 'Remove the GitHub Actions runner of "shop"',
      state: "change",
      params: { app: "shop", remove: true },
    });
    expect(runnerStepOf(plan).reason).toMatch(
      /^The deploy job no longer runs on this server's runner\. /,
    );
    const fetched = tokens();
    await applyApproved(fake, plan, { runnerToken: fetched.fetch });
    expect(fetched.calls).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    // Without a runner and none on the server, there is no step.
    const after = await planFor(fake, desiredFor(fake));
    expect(after.steps.map((step) => step.id)).not.toContain("github-runner");
  });

  it("undo removes a runner left behind, after the tunnel connectors and before the shared folders", async () => {
    const fake = new FakeHost();
    await withRunner(fake);
    // An app removed while its runner could not be: its folder is still there.
    fake.runners.set("old", {
      registered: true,
      active: false,
      version: "2.337.0",
      label: "opscrew-old-prod",
      // This project's: an undo never removes another repository's runner.
      url: SHOP_REPOSITORY,
    });
    await applyApproved(
      fake,
      planTeardown(
        await inspectHost(fake),
        { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
        "opscrew destroy",
      ),
      { command: "opscrew destroy", runnerToken: tokens().fetch },
    );
    expect(fake.runnerPrepared).toBe(true);
    const plan = planUndo(
      await inspectHost(fake),
      { repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy --undo-host",
    );
    const ids = plan.steps.map((step) => step.id);
    expect(ids.indexOf("github-runner")).toBeLessThan(ids.indexOf("runtime-dirs"));
    expect(runnerStepOf(plan, "old")).toMatchObject({
      scope: "shared",
      params: { app: "old", remove: true },
    });
    const fetched = tokens();
    await applyApproved(fake, plan, {
      command: "opscrew destroy --undo-host",
      runnerToken: fetched.fetch,
    });
    expect(fetched.calls).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerPrepared).toBe(false);
  });
});

describe("the runner on a server OpsCrew created", () => {
  /** Inspects the cloud server as deploy and plans its runner (`null`: none, so its removal). */
  async function cloudPlan(fake: FakeHost, runner: DesiredRunner | null = runnerDesired()) {
    return planRunner(await inspectRunners(fake), {
      app: "shop",
      ...(runner !== null ? { runner } : {}),
    });
  }

  it("is a plan of only the github-runner step, run as deploy, planned from what deploy reads", async () => {
    const fake = cloudServer();
    expect(await inspectRunners(fake)).toEqual({ arch: "amd64", runners: [], prepared: true });
    const plan = await cloudPlan(fake);
    expect(plan).toMatchObject({ schemaVersion: 1, purpose: "setup", app: "shop", findings: [] });
    expect(plan.otherApps).toBeUndefined();
    expect(plan.steps.map((step) => step.id)).toEqual(["github-runner"]);
    const step = runnerStepOf(plan);
    expect(step).toMatchObject({ state: "change", scope: "app" });
    expect(step.params).toEqual({
      app: "shop",
      user: "deploy",
      runAs: "login",
      ...runnerDesired(),
    });
    expect(step.reason).toMatch(
      /^As deploy \(the server's first boot installed the runner's system libraries and lets deploy's services run without a login\), it downloads actions-runner-linux-x64-2\.338\.0\.tar\.gz /,
    );
    expect(step.reason).not.toContain("As root");
    // The same runner scripts as on a server you own, without the root part.
    const own = new FakeHost();
    const ownPlan = await planFor(own, desiredFor(own, { runner: runnerDesired() }));
    const cloud = stepScripts(plan, step);
    const owned = stepScripts(ownPlan, runnerStepOf(ownPlan));
    expect(cloud.check).toBe(owned.check);
    expect(cloud.apply).toBe(owned.apply);
    expect(cloud.verify).toBe(owned.verify);
    expect(cloud.asDeploy).toBe(true);
    expect(cloud.preApply).toBeUndefined();
    expect(owned.preApply).toContain("# opscrew-host: github-runner.root.apply\n");
  });

  it("applies over the deploy login with no root command and no host record, and is in place afterwards", async () => {
    const fake = cloudServer();
    const registration = runnerToken("registration");
    const fetched = tokens({ registration });
    const plan = await cloudPlan(fake);
    const result = await applyApproved(fake, plan, { runnerToken: fetched.fetch });
    expect(result).toEqual({ applied: ["github-runner"], skipped: [] });
    expect(fetched.calls).toEqual(["registration"]);
    expect(fake.runnerLog).toEqual([`${REGISTERED} 2.338.0 from ${runnerDesired().url}`]);
    // No privilege probe, no sudo, no runuser, no record: the login (deploy) runs everything.
    expect(fake.names()).toEqual([
      "runners.inspect",
      "github-runner.check",
      "github-runner.apply",
      "github-runner.verify",
    ]);
    for (const call of fake.calls) {
      expect(call.sudo).toBe(false);
      expect(call.asUser).toBeUndefined();
      expect(call.command.startsWith(`sh -c '# opscrew-host: ${call.name}\n`)).toBe(true);
    }
    expect(fake.files.has("/etc/opscrew/host.json")).toBe(false);
    expect(fake.calls.find((call) => call.name === "github-runner.apply")?.input).toBe(
      `${registration}\n`,
    );
    for (const call of fake.calls) expect(call.command).not.toContain(registration);
    expect(JSON.stringify(plan)).not.toContain(registration);
    expect(hostPlanHash(plan)).not.toContain(registration);

    const facts = await inspectRunners(fake);
    expect(facts.runners).toEqual([
      {
        app: "shop",
        registered: true,
        active: true,
        version: "2.338.0",
        label: "opscrew-shop-prod",
        repositoryUrl: "https://github.com/acme/shop",
      },
    ]);
    const again = planRunner(facts, { app: "shop", runner: runnerDesired() });
    expect(runnerStepOf(again).state).toBe("in-place");
  });

  it("removes it as deploy with a remove token once the plan has none, and leaves the first boot's parts", async () => {
    const fake = cloudServer();
    await applyApproved(fake, await cloudPlan(fake), { runnerToken: tokens().fetch });
    const removal = await cloudPlan(fake, null);
    expect(removal.steps).toEqual([
      expect.objectContaining({
        id: "github-runner",
        state: "change",
        params: { app: "shop", remove: true, runAs: "login" },
      }),
    ]);
    const remove = runnerToken("remove");
    const fetched = tokens({ remove });
    fake.calls.length = 0;
    const result = await applyApproved(fake, removal, { runnerToken: fetched.fetch });
    expect(result.stillRegistered).toBeUndefined();
    expect(fetched.calls).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerLog.at(-1)).toBe("unregister shop");
    expect(fake.names()).toEqual([
      "github-runner.remove.check",
      "github-runner.remove.apply",
      "github-runner.remove.verify",
    ]);
    expect(fake.calls[1]?.input).toBe(`${remove}\n`);
    expect(fake.runnerPrepared).toBe(true);
    // Nothing there and none planned: no step.
    expect((await cloudPlan(fake, null)).steps).toEqual([]);
  });

  it("reads, and stops plainly on, a server whose first boot did not prepare the runner", async () => {
    const fake = cloudServer();
    fake.runnerPrepared = false;
    expect((await inspectRunners(fake)).prepared).toBe(false);
    await expect(
      applyApproved(fake, await cloudPlan(fake), { runnerToken: tokens().fetch }),
    ).rejects.toThrow(
      "/srv/runners is missing or not deploy's, so OpsCrew did not install the runner.",
    );
    expect(fake.runners.size).toBe(0);
  });

  it("refuses input that is not a runner plan's", async () => {
    const fake = cloudServer();
    const facts = await inspectRunners(fake);
    expect(() => planRunner(facts, { app: "Not An App" })).toThrow(OpsCrewError);
    expect(() =>
      planRunner(facts, { app: "shop", runner: runnerDesired({ sha256: "nope" }) }),
    ).toThrow("The runner's plan input is not valid.");
    expect(() =>
      planRunner(
        { arch: "arm64", runners: [], prepared: true },
        { app: "shop", runner: runnerDesired() },
      ),
    ).toThrow("The runner's archive is for linux-x64, but this server is arm64.");
  });
});

describe("inspecting the runners", () => {
  it("parses each runner's line", () => {
    expect(
      parseRunners(
        "shop yes active 2.338.0 opscrew-shop-prod https://github.com/acme/shop\nblog no inactive - - -\nnotes yes failed 2.x Notes ftp://x\n",
      ),
    ).toEqual([
      {
        app: "shop",
        registered: true,
        active: true,
        version: "2.338.0",
        label: "opscrew-shop-prod",
        repositoryUrl: "https://github.com/acme/shop",
      },
      ...["blog", "notes"].map((app) => ({
        app,
        registered: app === "notes",
        active: false,
        version: null,
        label: null,
        repositoryUrl: null,
      })),
    ]);
  });

  it.skipIf(!BASH_AVAILABLE)(
    "reads deploy's user service and the runner's version as deploy: through runuser as root, directly as the deploy login (real shell)",
    () => {
      const h = new ShellHarness();
      try {
        h.stub("runuser", 'while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"');
        h.stub("timeout", 'shift\nexec "$@"', { log: false });
        // `id -u` is the login's uid (in $S/uid), `id -u deploy` deploy's.
        h.stub("id", '[ "$*" = "-u deploy" ] && echo 1000 && exit 0\ncat "$S/uid"', { log: false });
        h.stub(
          "systemctl",
          'echo "$XDG_RUNTIME_DIR" > "$S/xdg"\n[ "$*" = "--user is-active opscrew-runner-shop.service" ] && echo active && exit 0\necho inactive\nexit 3',
        );
        h.write("/srv/runners/shop/.runner", "{}\n");
        h.write("/srv/runners/shop/bin/Runner.Listener", "#!/bin/sh\necho 2.338.0\n");
        chmodSync(h.native("/srv/runners/shop/bin/Runner.Listener"), 0o755);
        h.write(
          "/srv/runners/shop/.opscrew-runner",
          "label=opscrew-shop-prod\nurl=https://github.com/acme/shop\n",
        );
        h.write("/srv/runners/blog/config.sh", "#!/bin/sh\n");
        h.write("/srv/runners/Bad Name/.runner", "{}\n");
        const expected = [
          {
            app: "blog",
            registered: false,
            active: false,
            version: null,
            label: null,
            repositoryUrl: null,
          },
          {
            app: "shop",
            registered: true,
            active: true,
            version: "2.338.0",
            label: "opscrew-shop-prod",
            repositoryUrl: "https://github.com/acme/shop",
          },
        ];
        const runners = (script: string) =>
          parseRunners(
            splitSections(h.run(script).stdout.replaceAll(h.root, "")).get("runners")?.text ?? "",
          );

        h.write("/state/uid", "0\n");
        expect(runners(inspectScript())).toEqual(expected);
        expect(h.calls()).toContain(
          `runuser -u deploy -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active opscrew-runner-shop.service`,
        );
        expect(h.calls()).toContain(
          `runuser -u deploy -- timeout 30 ${h.root}/srv/runners/shop/bin/Runner.Listener --version`,
        );

        h.clearCalls();
        h.write("/state/uid", "1000\n");
        expect(runners(inspectRunnersScript())).toEqual(expected);
        expect(h.calls().some((call) => call.startsWith("runuser"))).toBe(false);
        expect(h.calls()).toContain("systemctl --user is-active opscrew-runner-shop.service");
        expect(h.read("/state/xdg")?.trim()).toBe("/run/user/1000");
        // The first boot's parts: /srv/runners deploy's to write, and deploy lingering.
        const prepared = () =>
          splitSections(h.run(inspectRunnersScript()).stdout).get("runners-prepared")?.exit;
        expect(prepared()).not.toBe(0);
        h.write("/var/lib/systemd/linger/deploy", "");
        expect(prepared()).toBe(0);
      } finally {
        h.dispose();
      }
    },
  );
});

describe("the runner's scripts", () => {
  async function scriptsOf() {
    const fake = new FakeHost();
    const plan = await planFor(fake, desiredFor(fake, { runner: runnerDesired() }));
    const setup = stepScripts(plan, runnerStepOf(plan));
    await withRunner(fake);
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    const removal = runnerStepOf(teardown);
    return {
      setup,
      remove: stepScripts(teardown, removal),
      // The removal on a server whose /srv/runners was there before OpsCrew.
      keep: stepScripts(teardown, {
        ...removal,
        params: { ...removal.params, removeParent: false },
      }),
    };
  }

  it("match their snapshot", async () => {
    const { setup, remove } = await scriptsOf();
    expect(setup.runnerToken).toBe("registration");
    expect(remove.runnerToken).toBe("remove");
    expect(setup.apply).toMatchSnapshot("setup apply");
    expect(setup.preApply).toMatchSnapshot("setup root part");
    expect(remove.apply).toMatchSnapshot("remove apply");
    expect(remove.postApply).toMatchSnapshot("remove root part");
  });

  it("never run GitHub's svc.sh or installdependencies.sh, and keep root out of the runner's own scripts", async () => {
    const { setup, remove } = await scriptsOf();
    // The scripts' commands, without their comments.
    const commands = (script = "") =>
      script
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
    for (const script of [setup.check, setup.apply, setup.verify, remove.apply, remove.verify]) {
      // APT_FUNCTIONS defines apt_get in every script; none of these calls it.
      expect(commands(script)).not.toMatch(
        /svc\.sh|installdependencies|runuser|sudo|loginctl|apt_get /,
      );
    }
    expect(commands(`${setup.preApply}\n${remove.postApply}`)).not.toMatch(
      /svc\.sh|installdependencies/,
    );
  });

  describe.skipIf(!BASH_AVAILABLE)(
    "in a real shell (the runner and system commands stubbed)",
    // Many short shells each: slow where starting a process is (Git for Windows).
    { timeout: 120_000 },
    () => {
      const CONFIG_ARGS =
        "--unattended --url https://github.com/acme/shop --name home-shop-prod --labels opscrew-shop-prod --work _work --replace";
      const CONFIG_LINE = `config.sh ${CONFIG_ARGS}`;
      const UNIT = "/home/deploy/.config/systemd/user/opscrew-runner-shop.service";

      /**
       * The harness as the deploy user on a prepared server (deploy lingers, /srv/runners is
       * deploy's), with stubs for the runner's archive (`tar` lays out a `config.sh` and the
       * listener that log how they were called) and deploy's systemd user manager (`systemctl
       * --user` keeps the unit's state in $S).
       */
      function harness(): ShellHarness {
        const h = new ShellHarness();
        const log = `${h.root}/state/runner.log`;
        h.write("/state/archive", RUNNER_ARCHIVE);
        mkdirSync(h.native("/srv/runners"), { recursive: true });
        h.write("/var/lib/systemd/linger/deploy", "");
        h.stub(
          "curl",
          'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncat "$S/archive" > "$out"',
        );
        h.stub("getent", `echo "deploy:x:1000:1000::${h.root}/home/deploy:/bin/bash"`, {
          log: false,
        });
        h.stub("id", "echo 1000", { log: false });
        h.stub("timeout", 'shift\nexec "$@"', { log: false });
        h.stub(
          "systemctl",
          `[ "$1" = --user ] || exit 1
shift
case "$1" in
  show-environment|daemon-reload) exit 0 ;;
  is-active) [ -f "$S/active" ] ;;
  is-enabled) [ -f "$S/enabled" ] ;;
  enable) touch "$S/enabled"; if [ "$2" = --now ]; then touch "$S/active"; fi ;;
  stop) rm -f "$S/active" ;;
  disable) rm -f "$S/enabled"; if [ "$2" = --now ]; then rm -f "$S/active"; fi ;;
  *) exit 1 ;;
esac`,
        );
        // The version the runner reports (it may update itself).
        h.write("/state/version", "2.338.0\n");
        h.write("/state/layout/bin/Runner.Listener", `#!/bin/sh\ncat '${h.root}/state/version'\n`);
        h.write(
          "/state/layout/config.sh",
          `#!/bin/sh
echo "config.sh $* input=\${ACTIONS_RUNNER_INPUT_TOKEN:+set}" >> '${log}'
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" > '${h.root}/state/config-token'
if [ "$1" = remove ]; then [ ! -f '${h.root}/state/remove-fails' ] || exit 1; rm -f .runner; exit 0; fi
echo '{}' > .runner
`,
        );
        h.stub(
          "tar",
          'while [ $# -gt 0 ]; do [ "$1" = -C ] && dir=$2; shift; done\ncp -R "$S/layout/." "$dir/"\nchmod +x "$dir/config.sh" "$dir/bin/Runner.Listener"',
        );
        return h;
      }

      /** The unit OpsCrew writes for the runner in `dir`. */
      const unitText = (dir: string) =>
        [
          "[Unit]",
          "Description=GitHub Actions runner of shop (OpsCrew)",
          "",
          "[Service]",
          `ExecStart=${dir}/run.sh`,
          `WorkingDirectory=${dir}`,
          "Restart=always",
          "RestartSec=5",
          "KillMode=process",
          "KillSignal=SIGTERM",
          "TimeoutStopSec=5min",
          "",
          "[Install]",
          "WantedBy=default.target",
          "",
        ].join("\n");

      it("checks the archive, gives the token to config.sh alone, and runs it as deploy's user service", async () => {
        const { setup, remove, keep } = await scriptsOf();
        const h = harness();
        try {
          const token = runnerToken("registration");
          const run = h.run(setup.apply, `${token}\n`);
          expect(run.status, run.stderr).toBe(0);
          expect(`${run.stdout}${run.stderr}`).not.toContain(token);
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            `${CONFIG_LINE} input=set`,
          ]);
          // The token reaches config.sh only in its environment: no command line carries it.
          expect(h.read("/state/config-token")).toBe(token);
          const calls = h.calls();
          expect(calls.join("\n")).not.toContain(token);
          expect(h.read("/state/runner.log")).not.toContain(token);
          expect(calls.some((call) => /^tar -xzf \S+ -C \S+\/srv\/runners\/shop$/.test(call))).toBe(
            true,
          );
          expect(calls).toContain("systemctl --user daemon-reload");
          expect(calls).toContain("systemctl --user enable --now opscrew-runner-shop.service");
          expect(calls.some((call) => /^(runuser|sudo|apt-get|loginctl) /.test(call))).toBe(false);
          expect(h.read("/srv/runners/shop/.opscrew-runner")).toBe(
            "label=opscrew-shop-prod\nurl=https://github.com/acme/shop\n",
          );
          expect(h.read(UNIT)).toBe(unitText(h.posix("/srv/runners/shop")));
          expect(h.run(setup.verify).status).toBe(0);
          expect(h.run(setup.check).stdout).toContain("state=in-place");
          // A newer version (updated by itself) is fine; an older one, another label or another
          // repository, a changed unit, or a stopped or disabled service is not.
          h.write("/state/version", "2.339.0\n");
          expect(h.run(setup.check).stdout).toContain("state=in-place");
          h.write("/state/version", "2.337.9\n");
          expect(h.run(setup.check).stdout).toContain("state=change");
          h.write("/state/version", "2.338.0\n");
          const record = h.read("/srv/runners/shop/.opscrew-runner") ?? "";
          for (const other of [
            "label=opscrew-shop-staging\nurl=https://github.com/acme/shop\n",
            "label=opscrew-shop-prod\nurl=https://github.com/acme/old-shop\n",
          ]) {
            h.write("/srv/runners/shop/.opscrew-runner", other);
            expect(h.run(setup.check).stdout).toContain("state=change");
          }
          h.write("/srv/runners/shop/.opscrew-runner", record);
          const unit = h.read(UNIT) ?? "";
          h.write(UNIT, unit.replace("Restart=always", "Restart=no"));
          expect(h.run(setup.check).stdout).toContain("state=change");
          h.write(UNIT, unit);
          for (const state of ["/state/enabled", "/state/active"]) {
            rmSync(h.native(state));
            expect(h.run(setup.check).stdout).toContain("state=change");
            h.write(state, "");
          }
          expect(h.run(setup.check).stdout).toContain("state=in-place");

          // Installed again over its folder: its service stops first, then it registers again.
          h.write("/state/runner.log", "");
          h.clearCalls();
          expect(h.run(setup.apply, `${token}\n`).status).toBe(0);
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            `${CONFIG_LINE} input=set`,
          ]);
          const again = h.calls();
          expect(again.indexOf("systemctl --user stop opscrew-runner-shop.service")).toBeLessThan(
            again.indexOf("systemctl --user enable --now opscrew-runner-shop.service"),
          );
          expect(h.run(setup.verify).status).toBe(0);

          const removal = runnerToken("remove");
          h.write("/state/runner.log", "");
          h.clearCalls();
          const removed = h.run(remove.apply, `${removal}\n`);
          expect(removed.status, removed.stderr).toBe(0);
          expect(removed.stdout).toBe("runner.unregistered=true\n");
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            "config.sh remove input=set",
          ]);
          expect(h.read("/state/config-token")).toBe(removal);
          expect(h.calls()).toContain("systemctl --user disable --now opscrew-runner-shop.service");
          expect(h.calls().join("\n")).not.toContain(removal);
          expect(h.exists("/srv/runners/shop")).toBe(false);
          expect(h.exists(UNIT)).toBe(false);
          expect(h.run(remove.verify).status).toBe(0);
          // deploy leaves the runners' parent; on a server you own, root takes it and deploy's
          // lingering back with the last runner.
          expect(h.exists("/srv/runners")).toBe(true);
          h.stub("loginctl", "exit 0");
          expect(h.run(remove.postApply ?? "").status).toBe(0);
          expect(h.exists("/srv/runners")).toBe(false);
          expect(h.calls()).toContain("loginctl disable-linger deploy");
          // A /srv/runners that was there before OpsCrew stays; deploy's lingering goes all the same.
          mkdirSync(h.native("/srv/runners"));
          h.clearCalls();
          expect(h.run(keep.postApply ?? "").status).toBe(0);
          expect(h.exists("/srv/runners")).toBe(true);
          expect(h.calls()).toContain("loginctl disable-linger deploy");
        } finally {
          h.dispose();
        }
      });

      it("says when the removal unregistered nothing, and still removes the runner", async () => {
        const { setup, remove } = await scriptsOf();
        const h = harness();
        try {
          for (const arrange of [
            () => h.write("/state/remove-fails", ""),
            () => rmSync(h.native("/srv/runners/shop/.runner")),
          ]) {
            expect(h.run(setup.apply, `${runnerToken()}\n`).status).toBe(0);
            arrange();
            const removed = h.run(remove.apply, `${runnerToken("remove")}\n`);
            expect(removed.status, removed.stderr).toBe(0);
            expect(removed.stdout).toBe("runner.unregistered=false\n");
            expect(h.exists("/srv/runners/shop")).toBe(false);
            expect(h.exists(UNIT)).toBe(false);
            rmSync(h.native("/state/remove-fails"), { force: true });
          }
        } finally {
          h.dispose();
        }
      });

      it("installs nothing from an archive that does not match its SHA-256, and needs a token", async () => {
        const { setup } = await scriptsOf();
        const h = harness();
        try {
          h.write("/state/archive", "something else\n");
          const run = h.run(setup.apply, `${runnerToken()}\n`);
          expect(run.status).not.toBe(0);
          expect(run.stderr).toContain(
            "The downloaded runner does not match its pinned SHA-256, so OpsCrew did not install it.",
          );
          expect(h.read("/state/runner.log")).toBeUndefined();
          expect(h.calls().some((call) => call.startsWith("tar "))).toBe(false);

          const empty = h.run(setup.apply, "");
          expect(empty.status).not.toBe(0);
          expect(empty.stderr).toContain(
            "No registration token arrived on standard input, so OpsCrew did not change the runner.",
          );
        } finally {
          h.dispose();
        }
      });

      it("changes nothing on a server root did not prepare (no lingering, no /srv/runners for deploy)", async () => {
        const { setup } = await scriptsOf();
        const h = harness();
        try {
          rmSync(h.native("/var/lib/systemd/linger/deploy"));
          const run = h.run(setup.apply, `${runnerToken()}\n`);
          expect(run.status).not.toBe(0);
          expect(run.stderr).toContain(
            "deploy's services stop when it logs out (it does not linger), so OpsCrew did not install the runner.",
          );
          h.write("/var/lib/systemd/linger/deploy", "");
          rmSync(h.native("/srv/runners"), { recursive: true });
          const missing = h.run(setup.apply, `${runnerToken()}\n`);
          expect(missing.stderr).toContain(
            "/srv/runners is missing or not deploy's, so OpsCrew did not install the runner.",
          );
          expect(h.calls().some((call) => /^(curl|tar|systemctl) /.test(call))).toBe(false);
        } finally {
          h.dispose();
        }
      });

      it("as root on a server you own: installs the libraries this release offers, lets deploy linger and gives it /srv/runners", async () => {
        const { setup } = await scriptsOf();
        const h = harness();
        try {
          rmSync(h.native("/srv/runners"), { recursive: true });
          h.stub("apt-get", "exit 0");
          h.stub("loginctl", "exit 0");
          const offers = (packages: string) =>
            h.stub(
              "apt-cache",
              `[ "$1" = show ] || exit 1\ncase " ${packages} " in *" $2 "*) exit 0 ;; esac\nexit 100`,
              { log: false },
            );
          const installed = () =>
            h
              .calls()
              .filter((call) => call.startsWith("apt-get ") && call.includes(" install "))
              .map((call) => call.slice(call.indexOf(" install ") + " install ".length));
          // Ubuntu 24.04, as on the servers OpsCrew creates.
          offers("libkrb5-3 zlib1g liblttng-ust1t64 libssl3t64 libssl3 libicu74");
          const noble = h.run(setup.preApply ?? "");
          expect(noble.status, noble.stderr).toBe(0);
          expect(installed()).toEqual([
            "curl libkrb5-3 zlib1g liblttng-ust1t64 libssl3t64 libicu74",
          ]);
          expect(h.calls()).toContain("loginctl enable-linger deploy");
          expect(h.exists("/srv/runners")).toBe(true);
          // Debian 12 and Ubuntu 22.04 name them differently.
          h.clearCalls();
          offers("libkrb5-3 zlib1g liblttng-ust1 libssl3 libicu72");
          expect(h.run(setup.preApply ?? "").status).toBe(0);
          expect(installed()).toEqual(["curl libkrb5-3 zlib1g liblttng-ust1 libssl3 libicu72"]);
          // A release with none of a library's candidates stops before installing anything.
          h.clearCalls();
          offers("libkrb5-3 zlib1g");
          const none = h.run(setup.preApply ?? "");
          expect(none.status).not.toBe(0);
          expect(none.stderr).toContain(
            "This server's release offers none of liblttng-ust1t64 liblttng-ust1 liblttng-ust0, which the GitHub Actions runner needs.",
          );
          expect(installed()).toEqual([]);
        } finally {
          h.dispose();
        }
      });
    },
  );
});
