import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PhaseDeps,
  recordServerAddress,
  type SnapshotEntry,
  type SnapshotSettingChange,
} from "@opscrew/agents";
import { SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import type { ApprovalRequest, CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withServices } from "../deps";
import { inEnvironment, withEnvironments } from "../ui/__fixtures__/environments";
import { auditText, projectContext, run, type TempProject } from "../ui/__fixtures__/harness";

/** Each call of a snapshot command, and the answer a test gives instead of the real agent's. */
const fake = vi.hoisted(() => ({
  calls: [] as { name: string; deps: PhaseDeps; args: unknown[] }[],
  answers: {} as Record<
    string,
    ((deps: PhaseDeps, ...args: unknown[]) => Promise<unknown>) | undefined
  >,
}));

vi.mock("@opscrew/agents", async (importOriginal) => {
  const agents = await importOriginal<typeof import("@opscrew/agents")>();
  const faked = <K extends keyof typeof agents>(name: K) =>
    ((deps: PhaseDeps, ...args: unknown[]) => {
      fake.calls.push({ name, deps, args });
      const answer = fake.answers[name];
      return answer === undefined
        ? (agents[name] as (...all: unknown[]) => unknown)(deps, ...args)
        : answer(deps, ...args);
    }) as (typeof agents)[K];
  return {
    ...agents,
    takeSnapshot: faked("takeSnapshot"),
    takeServerSnapshot: faked("takeServerSnapshot"),
    listSnapshots: faked("listSnapshots"),
    deleteSnapshot: faked("deleteSnapshot"),
    snapshotScheduleOn: faked("snapshotScheduleOn"),
    snapshotScheduleOff: faked("snapshotScheduleOff"),
    snapshotOffsiteOn: faked("snapshotOffsiteOn"),
    snapshotOffsiteOff: faked("snapshotOffsiteOff"),
  };
});

let project: TempProject | undefined;
beforeEach(() => {
  fake.calls.length = 0;
  fake.answers = {};
});
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** A project with prod deployed on Hetzner and staging beside it, and a script's context. */
async function setup(options: { interactive?: boolean; env?: Record<string, string> } = {}) {
  project = await withEnvironments({
    staging: inEnvironment(testPlan({ deployed: true }), "staging"),
  });
  Object.assign(project.env, options.env);
  return projectContext(project, { interactive: options.interactive ?? false });
}

/** The snapshot `20261106T190000Z` of staging on the app's server, with its database. */
function entry(extra: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: "20261106T190000Z",
    kind: "manual",
    taken: "2026-11-06T19:00:00.000Z",
    version: `sha256:${"ab".repeat(32)}`,
    size: 2048,
    services: [{ name: "db", kind: "postgres", server: "app", state: "copied", size: 2048 }],
    where: "on the app's server",
    offsite: false,
    ...extra,
  };
}

/** A stop for a copy, as `takeSnapshot` asks it: a maintenance window. */
const STOP: ApprovalRequest = {
  kind: "remote-exec",
  title: "Maintenance window: stop kafka of staging, one at a time, for its copy in a snapshot",
  details: "The snapshot of staging copies: kafka",
};

/** A snapshot's deletion, as `deleteSnapshot` asks it: destroy-grade, its id typed. */
const DELETION: ApprovalRequest = {
  kind: "remote-exec",
  title: "Delete the snapshot 20261106T190000Z of staging on the app's server",
  details: "Its copies of db are deleted for good.",
  allowDestroy: true,
  confirmPhrase: "20261106T190000Z",
};

/** The last call's deps and arguments. */
function lastCall(name: string) {
  const call = fake.calls.filter((each) => each.name === name).at(-1);
  if (call === undefined) throw new Error(`${name} was not called`);
  return call;
}

/** An answer that asks `request` and reports the decision, as an agent would. */
function asking(request: ApprovalRequest, decisions: (string | undefined)[], result: unknown) {
  return async (deps: PhaseDeps) => {
    const decision = await deps.approvals.request(request);
    decisions.push(decision.approved ? "approved" : decision.reason);
    if (!decision.approved) {
      throw new OpsCrewError("APPROVAL_REFUSED", "Nothing was stopped. No snapshot was taken.", {
        hint: "Run `opscrew snapshot --env staging` again and approve it.",
      });
    }
    return result;
  };
}

const TAKEN = { id: "20261106T190000Z", where: "on the app's server", services: [] };

describe("opscrew snapshot: the flags, checked before any work", () => {
  it.each([
    [["--stop"], "--stop and --server-name go only with --server"],
    [["--server-name", "data"], "--stop and --server-name go only with --server"],
    [["--server", "--skip", "db"], "--skip goes only with a snapshot of the data"],
    [["schedule", "off", "--every", "daily"], "`opscrew snapshot schedule off` takes no --every"],
    [["schedule", "off", "--keep", "3", "--stop", "kafka"], "takes no --keep, --stop"],
    [
      ["schedule", "off", "--keep", "3"],
      "Run `opscrew snapshot schedule off --env staging` alone.",
    ],
    [["schedule", "on", "--keep", "0"], "Give a whole number from 1 up."],
    [["schedule", "on", "--keep", "two"], "Give a whole number from 1 up."],
    [["schedule", "sometimes"], "Allowed choices are on, off."],
    [["offsite", "on"], "`opscrew snapshot offsite on` needs --to"],
    [["offsite", "on", "--to", "s3"], "Allowed choices are r2, hetzner, digitalocean."],
    [["offsite", "off", "--to", "r2", "--days", "30"], "takes no --to, --days"],
    [["offsite", "on", "--to", "r2", "--days", "1.5"], "Give a whole number from 1 up."],
    [
      ["delete", "20261106T190000Z", "--confirm", "20261105T190000Z"],
      "--confirm 20261105T190000Z does not match the snapshot's id",
    ],
    [["delete", "20261106T190000Z", "--yes"], "unknown option '--yes'"],
    [["--yes"], "unknown option '--yes'"],
  ])("refuses %j", async (flags, message) => {
    const ctx = await setup();
    expect(await run(ctx, "snapshot", ...flags, "--env", "staging")).not.toBe(0);
    expect(ctx.errors).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it("prints its help with every flag and subcommand", async () => {
    const ctx = await setup();
    expect(await run(ctx, "snapshot", "--help")).toBe(0);
    for (const text of [
      "--skip <service>",
      "--allow-downtime",
      "--server",
      "--stop",
      "--server-name <name>",
      "--app <key>",
      "--env <name>",
      "list [options]",
      "delete [options] <id>",
      "schedule [options] <on|off>",
      "offsite [options] <on|off>",
      "opscrew restore <id>",
    ]) {
      expect(ctx.output).toContain(text);
    }
    const top = await setup();
    expect(await run(top, "--help")).toBe(0);
    expect(top.output).toMatch(/snapshot \[options\]\s+Take a snapshot/);
  });
});

describe("opscrew snapshot", () => {
  it("takes a data snapshot with --skip, then says how to list and restore it", async () => {
    const ctx = await setup();
    fake.answers.takeSnapshot = async () => TAKEN;
    expect(
      await run(ctx, "snapshot", "--env", "staging", "--skip", " kafka ", "--skip", "search"),
      ctx.errors,
    ).toBe(0);
    const call = lastCall("takeSnapshot");
    expect(call.deps.paths.environment).toBe("staging");
    expect(call.args).toEqual([{ skip: ["kafka", "search"] }]);
    expect(ctx.output).toContain(
      "`opscrew snapshot list --env staging` lists it; `opscrew restore 20261106T190000Z --env staging` puts its data back",
    );
  });

  it("passes the machines' fakes to the agent", async () => {
    const ctx = await setup();
    const remote = (host: string): RemoteExec => ({
      host,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    withServices(ctx, { snapshot: { remote } });
    fake.answers.takeSnapshot = async () => TAKEN;
    expect(await run(ctx, "snapshot", "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall("takeSnapshot").args).toEqual([{ services: { remote } }]);
  });

  it("approves a stop for the copy in a script only with --allow-downtime", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.takeSnapshot = asking(STOP, decisions, TAKEN);
    expect(await run(ctx, "snapshot", "--env", "staging", "--allow-downtime"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(`✓ ${STOP.title} (allowed with --allow-downtime)`);
    expect(await run(ctx, "snapshot", "--env", "staging")).toBe(1);
    expect(decisions[0]).toBe("approved");
    expect(decisions[1]).toContain("needs a human approval and this run is not interactive");
    expect(ctx.errors).toContain(
      "This run is not interactive: add --allow-downtime to approve the stop the summary names.",
    );
  });

  it("asks a terminal to approve the stop, and --allow-downtime does not skip the question", async () => {
    const ctx = await setup({ interactive: true });
    let asked: ApprovalRequest | undefined;
    withServices(ctx, {
      approvalHandler: {
        request: async (request) => {
          asked = request;
          return { approved: true, approver: "test", decidedAt: "2026-10-11T12:00:00.000Z" };
        },
      },
    });
    fake.answers.takeSnapshot = asking(STOP, [], TAKEN);
    expect(await run(ctx, "snapshot", "--env", "staging", "--allow-downtime"), ctx.errors).toBe(0);
    expect(asked?.title).toBe(STOP.title);
  });

  it("takes a whole-server snapshot with --server, --stop and --server-name", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    const window = {
      ...STOP,
      title: "Maintenance window: shut down the server shop-staging-data of staging for a snapshot",
    };
    fake.answers.takeServerSnapshot = asking(window, decisions, {
      id: "9001",
      where: "at Hetzner Cloud (server shop-staging-data)",
      server: { provider: "hetzner", id: "4711", name: "shop-staging-data" },
    });
    expect(
      await run(
        ctx,
        "snapshot",
        "--env",
        "staging",
        "--server",
        "--stop",
        "--server-name",
        " data ",
        "--allow-downtime",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("takeServerSnapshot").args).toEqual([{ serverName: "data", stop: true }]);
    expect(decisions).toEqual(["approved"]);
    expect(ctx.output).toContain(
      "`opscrew restore --server 9001 --env staging` rebuilds the server from it",
    );
    expect(fake.calls.map((call) => call.name)).toEqual(["takeServerSnapshot"]);
  });

  it.each([
    ["PHASE_PRECONDITION", 1],
    ["APPROVAL_REFUSED", 1],
    ["INVALID_INPUT", 2],
    ["COMMAND_FAILED", 2],
  ] as const)("exits %s with %i, saying what to do next", async (code, exit) => {
    const ctx = await setup();
    fake.answers.takeSnapshot = async () => {
      throw new OpsCrewError(code, "It stopped. No snapshot was taken.", {
        hint: "Free some disk, then try again.",
      });
    };
    expect(await run(ctx, "snapshot", "--env", "staging")).toBe(exit);
    expect(ctx.errors).toContain("It stopped. No snapshot was taken.");
    expect(ctx.errors).toContain("Free some disk, then try again.");
  });
});

describe("opscrew snapshot list", () => {
  it("prints one line per snapshot", async () => {
    const ctx = await setup();
    fake.answers.listSnapshots = async () => [entry()];
    expect(await run(ctx, "snapshot", "list", "--env", "staging"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      "20261106T190000Z: by hand, 2026-11-06 19:00 UTC, version sha256:abababababab",
    );
    expect(ctx.output).toContain("db, on the app's server");
  });

  it("gives the key file's text to the agent with --key, and never shows it", async () => {
    const ctx = await setup();
    const identity = `AGE-SECRET-KEY-1${"H".repeat(58)}`;
    await writeFile(path.join(project?.root ?? "", "age.txt"), `# a key\n${identity}\n`);
    fake.answers.listSnapshots = async (deps) => {
      deps.reporter.warn(`Read the bucket with ${identity}`);
      return [entry({ where: "in the off-server bucket shop-staging-backups" })];
    };
    expect(await run(ctx, "snapshot", "list", "--env", "staging", "--key", "age.txt")).toBe(0);
    expect(lastCall("listSnapshots").args).toEqual([{ identity: `# a key\n${identity}\n` }]);
    expect(ctx.output).toContain("in the off-server bucket shop-staging-backups");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(identity);
    expect(await run(ctx, "snapshot", "list", "--env", "staging", "--key", "nope.txt")).toBe(2);
    expect(ctx.errors).toContain("could not read the key file");
  });

  it("prints only the JSON with --json, the same entries", async () => {
    const ctx = await setup();
    fake.answers.listSnapshots = async (deps) => {
      deps.reporter.step("Reading the snapshots");
      deps.reporter.warn(
        "1 snapshot record on the app's server could not be read, so it is not listed.",
      );
      return [entry({ offsite: true })];
    };
    expect(await run(ctx, "snapshot", "list", "--env", "staging", "--json"), ctx.errors).toBe(0);
    expect(JSON.parse(ctx.output)).toEqual({ snapshots: [entry({ offsite: true })] });
    expect(ctx.errors).toContain("could not be read");
  });

  it("reads the server's snapshots through the fakes, with the real agent", async () => {
    const ctx = await setup();
    const paths = resolveProjectPaths(project?.root ?? "", {
      env: project?.env ?? {},
      environment: "staging",
    });
    await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
    const about = {
      id: "20261106T190000Z",
      kind: "manual",
      taken: "2026-11-06T19:00:00Z",
      version: "",
      services: [{ name: "db", kind: "postgres", file: "db.dump", size: 2048 }],
    };
    const commands: string[] = [];
    const remote = (host: string): RemoteExec => ({
      host,
      run: async (command): Promise<CommandResult> => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(about)}\noffsite 20261106T190000Z\n`,
          stderr: "",
        };
      },
    });
    withServices(ctx, { snapshot: { remote, serverSnapshots: () => undefined } });
    expect(await run(ctx, "snapshot", "list", "--env", "staging", "--json"), ctx.errors).toBe(0);
    const { snapshots } = JSON.parse(ctx.output) as { snapshots: SnapshotEntry[] };
    expect(snapshots).toEqual([
      expect.objectContaining({
        id: "20261106T190000Z",
        where: "on the app's server",
        offsite: true,
      }),
    ]);
    expect(commands).toHaveLength(1);
    expect(ctx.errors).toContain("set HCLOUD_TOKEN");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(SERVER_IPV4);
  });
});

describe("opscrew snapshot delete", () => {
  it("approves the deletion in a script only with --confirm <id>, never --yes", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.deleteSnapshot = asking(DELETION, decisions, {
      id: "20261106T190000Z",
      where: "on the app's server",
      outcome: "deleted",
    });
    expect(
      await run(
        ctx,
        "snapshot",
        "delete",
        " 20261106T190000Z ",
        "--env",
        "staging",
        "--confirm",
        "20261106T190000Z",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("deleteSnapshot").args).toEqual(["20261106T190000Z", {}]);
    expect(ctx.output).toContain(`✓ ${DELETION.title} (confirmed with --confirm 20261106T190000Z)`);
    expect(await run(ctx, "snapshot", "delete", "20261106T190000Z", "--env", "staging")).toBe(1);
    expect(decisions).toEqual([
      "approved",
      "deleting a snapshot needs 20261106T190000Z typed to confirm: add --confirm 20261106T190000Z, or run the command in a terminal",
    ]);
  });

  it("asks a terminal for the id", async () => {
    const ctx = await setup({ interactive: true });
    let asked: ApprovalRequest | undefined;
    withServices(ctx, {
      approvalHandler: {
        request: async (request) => {
          asked = request;
          return {
            approved: false,
            approver: "test",
            decidedAt: "2026-10-11T12:00:00.000Z",
            reason: "declined",
          };
        },
      },
    });
    const decisions: (string | undefined)[] = [];
    fake.answers.deleteSnapshot = asking(DELETION, decisions, undefined);
    expect(await run(ctx, "snapshot", "delete", "20261106T190000Z", "--env", "staging")).toBe(1);
    expect(asked?.confirmPhrase).toBe("20261106T190000Z");
  });
});

describe("opscrew snapshot schedule and offsite", () => {
  const change = (lines: string[]): SnapshotSettingChange => ({
    plan: testPlan(),
    changed: true,
    lines,
  });

  it("turns the schedule on with its flags and prints what changed", async () => {
    const ctx = await setup();
    fake.answers.snapshotScheduleOn = async () =>
      change([
        "Scheduled snapshots of staging: daily, the last 7 kept.",
        "Run `opscrew provision --env staging` to set them up.",
      ]);
    expect(
      await run(
        ctx,
        "snapshot",
        "schedule",
        "on",
        "--env",
        "staging",
        "--every",
        " daily ",
        "--keep",
        "7",
        "--stop",
        "kafka",
        "--stop",
        "search",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("snapshotScheduleOn").args).toEqual([
      { every: "daily", keep: 7, stop: ["kafka", "search"] },
    ]);
    expect(ctx.output).toBe(
      "Scheduled snapshots of staging: daily, the last 7 kept.\nRun `opscrew provision --env staging` to set them up.\n",
    );
  });

  it("turns the schedule off", async () => {
    const ctx = await setup();
    fake.answers.snapshotScheduleOff = async () =>
      change(["Scheduled snapshots of staging are off."]);
    expect(await run(ctx, "snapshot", "schedule", "off", "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall("snapshotScheduleOff").args).toEqual([]);
    expect(ctx.output).toContain("Scheduled snapshots of staging are off.");
  });

  it("turns the off-server copy on with its flags, and off", async () => {
    const ctx = await setup();
    fake.answers.snapshotOffsiteOn = async () => change(["The copies go to shop-staging-backups."]);
    fake.answers.snapshotOffsiteOff = async () => change(["No new copy is uploaded."]);
    expect(
      await run(
        ctx,
        "snapshot",
        "offsite",
        "on",
        "--env",
        "staging",
        "--to",
        "hetzner",
        "--region",
        " fsn1 ",
        "--days",
        "30",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("snapshotOffsiteOn").args).toEqual([
      { to: "hetzner", region: "fsn1", days: 30 },
    ]);
    expect(await run(ctx, "snapshot", "offsite", "off", "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall("snapshotOffsiteOff").args).toEqual([]);
    expect(ctx.output).toContain(
      "The copies go to shop-staging-backups.\nNo new copy is uploaded.\n",
    );
  });

  it("writes the real plan's schedule through the agent", async () => {
    const ctx = await setup();
    expect(
      await run(ctx, "snapshot", "schedule", "on", "--env", "staging", "--every", "6h"),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output).toContain("provision");
    expect(lastCall("snapshotScheduleOn").deps.paths.environment).toBe("staging");
  });
});

describe("opscrew snapshot never shows a secret", () => {
  it("masks a token in the agent's output and errors, and keeps it out of the audit log", async () => {
    const token = fakeSecret("hcloud-token");
    const ctx = await setup({ env: { HCLOUD_TOKEN: token } });
    fake.answers.listSnapshots = async () => [entry({ where: `on the app's server ${token}` })];
    expect(await run(ctx, "snapshot", "list", "--env", "staging"), ctx.errors).toBe(0);
    expect(await run(ctx, "snapshot", "list", "--env", "staging", "--json"), ctx.errors).toBe(0);
    fake.answers.takeSnapshot = async (deps) => {
      deps.reporter.info(`The snapshot of staging copies db, read with ${token}`);
      throw new OpsCrewError("COMMAND_FAILED", `The server said ${token}.`);
    };
    expect(await run(ctx, "snapshot", "--env", "staging")).toBe(2);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(token);
    expect(await auditText(project as TempProject)).not.toContain(token);
  });
});
