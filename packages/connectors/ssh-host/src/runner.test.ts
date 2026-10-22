import { chmodSync, rmSync } from "node:fs";
import { canonicalJson } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  planFor,
  provision,
  RUNNER_ARCHIVE,
  runnerDesired,
  runnerToken,
  SHOP_PROJECT,
  tunnelDesired,
} from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { hostPlanHash } from "./hash";
import { inspectHost, inspectScript } from "./inspect";
import { parseRunners, splitSections } from "./parse";
import { planHost, planTeardown, planUndo } from "./plan";
import { stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

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

describe("the github-runner step", () => {
  it("comes after app-record and before the tunnel connector, and names the version, checksum, user, label and folder", async () => {
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
    expect(step.reason).toContain("actions-runner-linux-x64-2.338.0.tar.gz");
    expect(step.reason).toContain(`SHA-256 ${runner.sha256}`);
    expect(step.reason).toContain("/srv/runners/shop as deploy");
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

  it("registers the runner with a token fetched only when the step runs, and is in place afterwards", async () => {
    const fake = new FakeHost();
    const registration = runnerToken("registration");
    const fetched = tokens({ registration });
    const { result } = await provision(fake, desiredFor(fake, { runner: runnerDesired() }), {
      runnerToken: fetched.fetch,
    });
    expect(result.applied).toContain("github-runner");
    expect(fetched.calls).toEqual(["registration"]);
    expect(fake.runnerLog).toEqual([`${REGISTERED} 2.338.0 from ${runnerDesired().url}`]);
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
    {
      what: "a changed repository",
      change: { url: "https://github.com/acme/old-shop" },
      why: "it is registered with https://github.com/acme/old-shop, not https://github.com/acme/shop",
    },
    { what: "a stopped service", change: { active: false }, why: "its service is not running" },
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
          `The runner on this server is not the planned one (${why}), so OpsCrew installs it again over its folder, registers it again in its place and restarts its service. Downloads `,
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
  it("teardown removes it first, with a remove token, then the app", async () => {
    const fake = new FakeHost();
    const registration = await withRunner(fake);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(plan.steps[0]).toEqual({
      id: "github-runner",
      title: 'Remove the GitHub Actions runner of "shop"',
      state: "change",
      scope: "app",
      reason:
        "Stops and removes its service, unregisters it from GitHub with a remove token fetched while this plan is applied (never part of this plan), and deletes /srv/runners/shop.",
      params: { app: "shop", remove: true },
    });
    const remove = runnerToken("remove");
    const fetched = tokens({ remove });
    const result = await applyApproved(fake, plan, {
      command: "opscrew destroy",
      runnerToken: fetched.fetch,
    });
    expect(result.applied[0]).toBe("github-runner");
    expect(result.stillRegistered).toBeUndefined();
    expect(fetched.calls).toEqual(["remove"]);
    expect(fake.runners.size).toBe(0);
    expect(fake.runnerLog.at(-1)).toBe("unregister shop");
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
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    const result = await applyApproved(fake, plan, {
      command: "opscrew destroy",
      runnerToken: tokens().fetch,
    });
    expect(result.stillRegistered).toEqual(["shop"]);
    expect(fake.runners.size).toBe(0);
  });

  it("teardown of another app leaves the runner alone", async () => {
    const fake = new FakeHost();
    await withRunner(fake);
    const plan = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "blog", projectId: "blog-1" },
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
    expect(runnerStepOf(plan).reason).toMatch(/^The deploy job runs on GitHub's machines again\. /);
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
      url: "https://github.com/acme/old",
    });
    await applyApproved(
      fake,
      planTeardown(
        await inspectHost(fake),
        { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
        "opscrew destroy",
      ),
      { command: "opscrew destroy", runnerToken: tokens().fetch },
    );
    const plan = planUndo(await inspectHost(fake), "opscrew destroy --undo-host");
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
    "reads the unit from .service and the version from the runner's binary, run as deploy (real shell)",
    () => {
      const h = new ShellHarness();
      try {
        h.stub("runuser", 'while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"');
        h.stub("timeout", 'shift\nexec "$@"', { log: false });
        h.stub(
          "systemctl",
          '[ "$1 $2" = "is-active actions.runner.acme-shop.home-shop-prod.service" ] && echo active && exit 0\necho inactive\nexit 3',
        );
        h.write("/srv/runners/shop/.runner", "{}\n");
        h.write("/srv/runners/shop/.service", "actions.runner.acme-shop.home-shop-prod.service\n");
        h.write("/srv/runners/shop/bin/Runner.Listener", "#!/bin/sh\necho 2.338.0\n");
        chmodSync(h.native("/srv/runners/shop/bin/Runner.Listener"), 0o755);
        h.write(
          "/srv/runners/shop/.opscrew-runner",
          "label=opscrew-shop-prod\nurl=https://github.com/acme/shop\n",
        );
        h.write("/srv/runners/blog/config.sh", "#!/bin/sh\n");
        h.write("/srv/runners/Bad Name/.runner", "{}\n");
        const sections = splitSections(h.run(inspectScript()).stdout.replaceAll(h.root, ""));
        expect(parseRunners(sections.get("runners")?.text ?? "")).toEqual([
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
        ]);
        expect(h.calls()).toContain(
          `runuser -u deploy -- timeout 30 ${h.root}/srv/runners/shop/bin/Runner.Listener --version`,
        );
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
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    return { setup, remove: stepScripts(teardown, runnerStepOf(teardown)) };
  }

  it("match their snapshot", async () => {
    const { setup, remove } = await scriptsOf();
    expect(setup.runnerToken).toBe("registration");
    expect(remove.runnerToken).toBe("remove");
    expect(setup.apply).toMatchSnapshot("setup apply");
    expect(remove.apply).toMatchSnapshot("remove apply");
  });

  describe.skipIf(!BASH_AVAILABLE)(
    "in a real shell (the runner and system commands stubbed)",
    () => {
      const CONFIG_ARGS =
        "--unattended --url https://github.com/acme/shop --name home-shop-prod --labels opscrew-shop-prod --work _work --replace";
      const CONFIG_LINE = `config.sh ${CONFIG_ARGS}`;

      /**
       * The harness with stubs for the runner's archive: `tar` lays out a `config.sh` and
       * `bin/installdependencies.sh` that log how they were called, and `config.sh` writes a
       * `svc.sh` that installs and starts a pretend service.
       */
      function harness(): ShellHarness {
        const h = new ShellHarness();
        const log = `${h.root}/state/runner.log`;
        h.write("/state/archive", RUNNER_ARCHIVE);
        h.stub(
          "curl",
          'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncat "$S/archive" > "$out"',
        );
        h.stub("runuser", 'while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"');
        h.stub("systemctl", '[ "$1" = is-active ] && [ -f "$S/active" ]');
        h.stub("timeout", 'shift\nexec "$@"', { log: false });
        // The version the runner reports (it may update itself).
        h.write("/state/version", "2.338.0\n");
        h.write("/state/layout/bin/Runner.Listener", `#!/bin/sh\ncat '${h.root}/state/version'\n`);
        h.write(
          "/state/layout/bin/installdependencies.sh",
          `#!/bin/sh
# Busy once when $S/apt-busy exists (another apt run holds the lock).
if [ -f '${h.root}/state/apt-busy' ]; then rm -f '${h.root}/state/apt-busy'; echo "installdependencies busy" >> '${log}'; exit 1; fi
echo "installdependencies token=\${RUNNER_TOKEN:-unset}\${ACTIONS_RUNNER_INPUT_TOKEN:-}" >> '${log}'
`,
        );
        h.write(
          "/state/layout/config.sh",
          `#!/bin/sh
echo "config.sh $* input=\${ACTIONS_RUNNER_INPUT_TOKEN:+set}" >> '${log}'
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" > '${h.root}/state/config-token'
if [ "$1" = remove ]; then [ ! -f '${h.root}/state/remove-fails' ] || exit 1; rm -f .runner; exit 0; fi
echo '{}' > .runner
cat > svc.sh <<'EOF'
#!/bin/sh
echo "svc.sh $* token=\${RUNNER_TOKEN:-unset}" >> '${log}'
case "$1" in
  install) echo actions.runner.acme-shop.home-shop-prod.service > .service ;;
  start) touch '${h.root}/state/active' ;;
  stop) rm -f '${h.root}/state/active' ;;
  uninstall) rm -f .service ;;
esac
EOF
chmod +x svc.sh
`,
        );
        h.stub(
          "tar",
          'while [ $# -gt 0 ]; do [ "$1" = -C ] && dir=$2; shift; done\ncp -R "$S/layout/." "$dir/"\nchmod +x "$dir/config.sh" "$dir/bin/installdependencies.sh" "$dir/bin/Runner.Listener"',
        );
        return h;
      }

      it("checks the archive, gives the token to config.sh alone, and starts the service as deploy", async () => {
        const { setup, remove } = await scriptsOf();
        const h = harness();
        try {
          const token = runnerToken("registration");
          // A fresh server's apt jobs hold the lock at first: the step waits for it.
          h.write("/state/apt-busy", "");
          const run = h.run(setup.apply, `${token}\n`);
          expect(run.status, run.stderr).toBe(0);
          expect(`${run.stdout}${run.stderr}`).not.toContain(token);
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            "installdependencies busy",
            "installdependencies token=unset",
            `${CONFIG_LINE} input=set`,
            "svc.sh install deploy token=unset",
            "svc.sh start token=unset",
          ]);
          expect(h.calls()).toContain("sleep 5");
          // The token reaches config.sh only in its environment: no command line carries it.
          expect(h.read("/state/config-token")).toBe(token);
          const calls = h.calls();
          expect(calls.join("\n")).not.toContain(token);
          expect(h.read("/state/runner.log")).not.toContain(token);
          expect(calls).toContain(`runuser -u deploy -- ./config.sh ${CONFIG_ARGS}`);
          expect(calls.some((call) => /^runuser -u deploy -- tar -xzf \S+ -C /.test(call))).toBe(
            true,
          );
          expect(h.read("/srv/runners/shop/.opscrew-runner")).toBe(
            "label=opscrew-shop-prod\nurl=https://github.com/acme/shop\n",
          );
          expect(h.run(setup.verify).status).toBe(0);
          expect(h.run(setup.check).stdout).toContain("state=in-place");
          // A newer version (updated by itself) is fine; an older one, another label or another
          // repository, or a stopped service is not.
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
          rmSync(h.native("/state/active"));
          expect(h.run(setup.check).stdout).toContain("state=change");

          // Installed again over its folder: its service goes first, then it registers again.
          h.write("/state/runner.log", "");
          expect(h.run(setup.apply, `${token}\n`).status).toBe(0);
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            "svc.sh stop token=unset",
            "svc.sh uninstall token=unset",
            "installdependencies token=unset",
            `${CONFIG_LINE} input=set`,
            "svc.sh install deploy token=unset",
            "svc.sh start token=unset",
          ]);
          expect(h.run(setup.verify).status).toBe(0);

          const removal = runnerToken("remove");
          h.write("/state/runner.log", "");
          h.clearCalls();
          const removed = h.run(remove.apply, `${removal}\n`);
          expect(removed.status, removed.stderr).toBe(0);
          expect(removed.stdout).toBe("runner.unregistered=true\n");
          expect((h.read("/state/runner.log") ?? "").trim().split("\n")).toEqual([
            "svc.sh stop token=unset",
            "svc.sh uninstall token=unset",
            "config.sh remove input=set",
          ]);
          expect(h.read("/state/config-token")).toBe(removal);
          expect(h.calls()).toContain("runuser -u deploy -- ./config.sh remove");
          expect(h.calls().join("\n")).not.toContain(removal);
          expect(h.exists("/srv/runners")).toBe(false);
          expect(h.exists("/srv/opscrew")).toBe(false);
          expect(h.run(remove.verify).status).toBe(0);
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
            expect(h.exists("/srv/runners")).toBe(false);
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
          expect(h.calls().some((call) => call.includes(" tar "))).toBe(false);

          const empty = h.run(setup.apply, "");
          expect(empty.status).not.toBe(0);
          expect(empty.stderr).toContain(
            "No registration token arrived on standard input, so OpsCrew did not change the runner.",
          );
        } finally {
          h.dispose();
        }
      });
    },
  );
});
