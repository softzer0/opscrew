import path from "node:path";
import { hostKeyFingerprint, type RunnerGitHubApi, type RunnerHostServices } from "@opscrew/agents";
import {
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  freshFacts,
  HOST_KEY,
  readyRemote,
  testPlan,
} from "@opscrew/agents/testing";
import type { CommandOptions, CommandResult } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  provisionServices,
} from "../ui/__fixtures__/deploy";
import { inEnvironment, planFile } from "../ui/__fixtures__/environments";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";
import { sshLogin } from "./runner";

/** The machine's address on the user's network. */
const MACHINE = "192.168.1.30";
const FINGERPRINT = hostKeyFingerprint(HOST_KEY.split(" ")[1] as string);

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** GitHub's runner API for a private repository; nothing reaches GitHub. */
class FakeRunnerGitHub implements RunnerGitHubApi {
  async runnerRegistrationToken() {
    return fakeSecret("hcloud-token", "runner-registration");
  }
  async runnerRemoveToken() {
    return fakeSecret("hcloud-token", "runner-remove");
  }
  async listRunners() {
    return [];
  }
  async deleteRunner() {}
  async repositoryVisibility() {
    return "private" as const;
  }
  async forkPrApprovalPolicy() {
    return "all_external_contributors" as const;
  }
  async setForkPrApprovalPolicy() {}
}

/** `DeployRunner`, with `ssh-keyscan` finding nothing when the machine is `off`. */
class MachineRunner extends DeployRunner {
  off = false;
  override async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    if (this.off && path.basename(command).startsWith("ssh-keyscan")) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    return super.run(command, args, options);
  }
}

/** A machine OpsCrew set up before: its deploy user, created by OpsCrew. */
function setUpFacts() {
  const fresh = freshFacts({
    user: "ana",
    addresses: [{ interface: "eth0", family: "ipv4", address: MACHINE, public: false }],
  });
  return {
    ...fresh,
    deployUser: { groups: ["deploy", "docker"], keys: [] },
    record: {
      schemaVersion: 1 as const,
      apps: [],
      opscrewVersion: "0.0.0-test",
      changes: [
        {
          step: "deploy-user" as const,
          purpose: "setup" as const,
          at: "2026-10-22T12:00:00.000Z",
          previous: { existed: false },
        },
      ],
    },
  };
}

/** The runner machine, its host adapter (`inspect` and `apply` as plain functions) and GitHub. */
function machineFakes() {
  const host = new FakeHostServer(
    freshFacts({
      user: "ana",
      addresses: [{ interface: "eth0", family: "ipv4", address: MACHINE, public: false }],
    }),
  );
  const machine: RunnerHostServices = {
    host: {
      inspect: (remote) => host.inspect(remote),
      apply: (remote, plan, options) => host.apply(remote, plan, options),
    },
    remote: (login) => readyRemote(login.host),
  };
  return { host, machine, github: new FakeRunnerGitHub(), runner: new MachineRunner() };
}

type Fakes = ReturnType<typeof machineFakes>;

/** A non-interactive context on `project` with the machine's fakes. */
function context(p: DeployProject, fakes: Fakes, interactive = false) {
  const ctx = projectContext(p, { interactive, services: { runner: fakes.runner } });
  withServices(ctx, { runnerHost: { machine: fakes.machine, github: fakes.github } });
  return ctx;
}

/** The hash after `label` in `text`. */
function hashAfter(text: string, label: string): string {
  const hash = new RegExp(`${label}:?\\s+([0-9a-f]{64})`).exec(text)?.[1];
  if (hash === undefined) throw new Error(`No ${label} in:\n${text}`);
  return hash;
}

/** Adds the machine "home" in a script: the plan, then its hash approved. */
async function addHome(p: DeployProject, fakes: Fakes): Promise<string> {
  const first = context(p, fakes);
  const ssh = ["--ssh", `ana@${MACHINE}`, "--host-key", FINGERPRINT];
  expect(await run(first, "runner", "host", "add", "home", ...ssh)).toBe(1);
  const hash = hashAfter(first.output, "Host plan hash");
  const second = context(p, fakes);
  expect(await run(second, "runner", "host", "add", "home", "--approve", hash), second.errors).toBe(
    0,
  );
  return hash;
}

describe("--ssh", () => {
  it("takes user@host and user@host:port, an IPv6 address in brackets", () => {
    expect(sshLogin(`ana@${MACHINE}`)).toEqual({ user: "ana", host: MACHINE });
    expect(sshLogin("ana@build-box.lan:2222")).toEqual({
      user: "ana",
      host: "build-box.lan",
      port: 2222,
    });
    expect(sshLogin("root@[fd00::30]:22")).toEqual({ user: "root", host: "[fd00::30]", port: 22 });
  });

  it("refuses another shape without repeating the address", () => {
    for (const login of [MACHINE, "ana@fd00::30", `ana@${MACHINE}:0`, `ana@${MACHINE}:70000`]) {
      const error = (() => {
        try {
          sshLogin(login);
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error, login).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).message).not.toContain(MACHINE);
    }
  });
});

describe.skipIf(GIT === undefined)("opscrew runner host", () => {
  it("add: in a script shows the host plan, and applies it only by its hash", async () => {
    project = await deployProject();
    const fakes = machineFakes();
    const first = context(project, fakes);
    const ssh = ["--ssh", `ana@${MACHINE}`, "--host-key", FINGERPRINT];
    expect(await run(first, "runner", "host", "add", "home", ...ssh)).toBe(1);
    expect(first.output).toContain("Docker");
    const hash = hashAfter(first.output, "Host plan hash");
    expect(first.errors).toContain(`opscrew runner host add home --approve ${hash}`);
    expect(fakes.host.applies).toEqual([]);

    // A hash that is not the machine's current plan is refused, and nothing changes.
    const stale = context(project, fakes);
    const old = ["runner", "host", "add", "home", "--approve", "0".repeat(64)];
    expect(await run(stale, ...old)).toBe(1);
    expect(stale.errors).toContain("is no longer the one you approved");
    expect(fakes.host.applies).toEqual([]);

    const second = context(project, fakes);
    const approve = ["runner", "host", "add", "home", "--approve", hash];
    expect(await run(second, ...approve), second.errors).toBe(0);
    expect(fakes.host.applies.map((a) => a.options.approvedHash)).toEqual([hash]);
    expect(second.output).toContain("opscrew env set <env> --runner host --runner-host home");

    const list = context(project, fakes);
    expect(await run(list, "runner", "host", "list"), list.errors).toBe(0);
    const lines = list.output.trim().split("\n");
    expect(lines[0]).toMatch(/^Machine\s+CPU\s+Docker\s+Environments$/);
    expect(lines[1]).toMatch(/^home\s+amd64\s+yes\s+none$/);
    expect(list.output).not.toContain(MACHINE);
  });

  it("add: needs --ssh unless it approves the recorded machine's plan", async () => {
    project = await deployProject();
    const ctx = context(project, machineFakes());
    expect(await run(ctx, "runner", "host", "add", "home")).toBe(2);
    expect(ctx.errors).toContain("`opscrew runner host add home --ssh <user@host[:port]>`");
    const bad = context(project, machineFakes());
    expect(await run(bad, "runner", "host", "add", "home", "--approve", "abc")).toBe(2);
    expect(bad.errors).toContain(
      "--approve expects the 64-character SHA-256 plan hash that OpsCrew printed.",
    );
  });

  it("remove: in a script needs --approve with the plan's hash and --confirm with the name", async () => {
    project = await deployProject();
    const fakes = machineFakes();
    await addHome(project, fakes);
    fakes.host.facts = setUpFacts();

    const bare = context(project, fakes);
    expect(await run(bare, "runner", "host", "remove", "home")).toBe(1);
    expect(bare.errors).toContain("needs home typed to confirm: add --confirm home");
    const hash = hashAfter(bare.output, "Host plan hash");

    const wrong = context(project, fakes);
    expect(await run(wrong, "runner", "host", "remove", "home", "--confirm", "hom")).toBe(1);
    expect(wrong.errors).toContain("does not match the runner machine's name");

    const unhashed = context(project, fakes);
    expect(await run(unhashed, "runner", "host", "remove", "home", "--confirm", "home")).toBe(1);
    expect(unhashed.errors).toContain(`only together with --approve and that plan's hash ${hash}`);
    expect(fakes.host.applies.map((a) => a.plan.purpose)).toEqual(["setup"]);

    const ok = context(project, fakes);
    const args = ["runner", "host", "remove", "home", "--approve", hash, "--confirm", "home"];
    expect(await run(ok, ...args), ok.errors).toBe(0);
    expect(fakes.host.applies.map((a) => a.plan.purpose)).toEqual(["setup", "undo"]);
    expect(ok.output).toContain("Removed the runner machine home");
    const list = context(project, fakes);
    await run(list, "runner", "host", "list");
    expect(list.output).toContain("This computer knows no runner machine for this project.");
  });

  it("remove: in a terminal asks for the machine's name typed back", async () => {
    project = await deployProject();
    const fakes = machineFakes();
    await addHome(project, fakes);
    fakes.host.facts = setUpFacts();
    const typed: string[] = [];
    const ctx = context(project, fakes, true);
    withServices(ctx, {
      approvalHandler: {
        request: async (request) => {
          typed.push(request.confirmPhrase ?? "");
          return {
            approved: true,
            approver: "test",
            decidedAt: "2026-10-22T12:00:00.000Z",
            confirmation: "home",
          };
        },
      },
    });
    expect(await run(ctx, "runner", "host", "remove", "home"), ctx.errors).toBe(0);
    expect(typed).toEqual(["home"]);
    expect(fakes.host.applies.map((a) => a.plan.purpose)).toEqual(["setup", "undo"]);
  });

  it("remove: forgets a machine OpsCrew cannot reach with --confirm alone", async () => {
    project = await deployProject();
    const fakes = machineFakes();
    await addHome(project, fakes);
    fakes.runner.off = true;
    const bare = context(project, fakes);
    expect(await run(bare, "runner", "host", "remove", "home")).toBe(1);
    expect(bare.errors).toContain(
      "needs home typed to confirm: add --confirm home, or run the command in a terminal",
    );
    const ok = context(project, fakes);
    expect(await run(ok, "runner", "host", "remove", "home", "--confirm", "home"), ok.errors).toBe(
      0,
    );
    expect(ok.errors).toContain("Forgot the runner machine home, which OpsCrew could not reach");
    expect(fakes.host.applies.map((a) => a.plan.purpose)).toEqual(["setup"]);
  });

  it("env set and env list: an environment's deploy job and build on the runner machine", async () => {
    project = await deployProject();
    const fakes = machineFakes();
    await addHome(project, fakes);
    await writeArtifact(
      "plan",
      planFile(project.root, "staging"),
      inEnvironment(testPlan({ userSecret: false }), "staging"),
    );
    const ctx = context(project, fakes);
    const args = ["--runner", "host", "--runner-host", "home", "--build", "runner"];
    expect(await run(ctx, "env", "set", "staging", ...args), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      "The staging environment's deploy job runs on the runner machine home, which also builds its image.",
    );
    expect(ctx.output).toContain("run `opscrew provision --env staging`");
    const plan = await readArtifact("plan", planFile(project.root, "staging"));
    expect(plan.environment).toMatchObject({
      runner: "host",
      runnerHost: { name: "home", arch: "amd64" },
      build: "runner",
    });

    const list = context(project, fakes);
    expect(await run(list, "env", "list"), list.errors).toBe(0);
    expect(list.output).toMatch(/staging\s+hetzner\s+each push\s+the runner machine home\s+no/);

    const alone = context(project, fakes);
    expect(await run(alone, "env", "set", "staging", "--build", "github")).toBe(2);
    expect(alone.errors).toContain("--runner-host and --build go with --runner.");
  });

  it("provision --plan-only prints the runner machine's host plan hash with the others", async () => {
    project = await deployProject(
      DeployPlanSchema.parse({
        ...testPlan({ userSecret: false }),
        environment: { runner: "host", runnerHost: { name: "home", arch: "amd64" } },
      }),
    );
    const fakes = machineFakes();
    await addHome(project, fakes);
    const ctx = context(project, fakes);
    withServices(ctx, {
      provision: provisionServices(new FakeEngine(), new FakeGitHub(), {
        runnerMachine: fakes.machine,
        runnerGitHub: fakes.github,
      }),
    });
    expect(await run(ctx, "provision", "--plan-only", "--yes"), ctx.errors).toBe(0);
    const infra = hashAfter(ctx.output, "infrastructure");
    const machine = hashAfter(ctx.output, "host plan for a runner machine");
    expect(ctx.output).toContain(
      `    opscrew provision --approve ${infra} --approve ${machine} --yes\n`,
    );
    expect(fakes.host.applies.map((a) => a.plan.purpose)).toEqual(["setup"]);
  });

  it("provision applies the runner machine's host plan approved alone, as --plan-only prints it", async () => {
    project = await deployProject(
      DeployPlanSchema.parse({
        ...testPlan({ deployed: true, userSecret: false }),
        environment: { runner: "host", runnerHost: { name: "home", arch: "amd64" } },
      }),
    );
    const fakes = machineFakes();
    await addHome(project, fakes);
    const services = () =>
      provisionServices(new FakeEngine({ changes: [] }), new FakeGitHub(), {
        runnerMachine: fakes.machine,
        runnerGitHub: fakes.github,
      });
    const planned = context(project, fakes);
    withServices(planned, { provision: services() });
    expect(await run(planned, "provision", "--plan-only", "--yes"), planned.errors).toBe(0);
    // The infrastructure needs no change: the runner machine's host plan is the only one.
    const hash = hashAfter(planned.output, "Plan hash \\(SHA-256\\)");
    expect(planned.output).toContain(`    opscrew provision --approve ${hash} --yes\n`);

    const approved = context(project, fakes);
    withServices(approved, { provision: services() });
    expect(await run(approved, "provision", "--approve", hash, "--yes"), approved.errors).toBe(0);
    expect(fakes.host.applies.map((a) => a.options.approvedHash).at(-1)).toBe(hash);
    expect(fakes.host.applies).toHaveLength(2);
  });
});
