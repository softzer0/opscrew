import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PhaseDeps } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withServices } from "../deps";
import { inEnvironment, withEnvironments } from "../ui/__fixtures__/environments";
import { auditText, projectContext, run, type TempProject } from "../ui/__fixtures__/harness";

/** Each call of a restore, and the answer a test gives instead of the real agent's. */
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
    restoreServerSnapshot: faked("restoreServerSnapshot"),
    restoreSnapshot: faked("restoreSnapshot"),
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

const HASH = "c".repeat(64);
const OTHER = "d".repeat(64);

const ID = "20261106T190000Z";

/** A data restore, as `restoreSnapshot` asks it: destroy-grade, the app's name, its hash. */
const RESTORE: ApprovalRequest = {
  kind: "remote-exec",
  title: `Restore the snapshot ${ID} of staging on the app's server`,
  details: `What is lost: everything written to db since 2026-11-06 19:00 UTC.\nRestore hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging",
};

const RESTORED = {
  id: ID,
  where: "on the app's server",
  services: [{ name: "db", server: "app" }],
  saved: { app: "20261107T080000Z" },
};

/** A whole-server restore, as `restoreServerSnapshot` asks it: destroy-grade, bound to its hash. */
const REBUILD: ApprovalRequest = {
  kind: "remote-exec",
  title: "Rebuild the server shop-staging of staging from the snapshot 9001",
  details: `Everything written on it since is lost for good.\nRestore hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging",
};

const REBUILT = {
  id: "9001",
  where: "at Hetzner Cloud (server shop-staging)",
  server: { provider: "hetzner", id: "4711", name: "shop-staging" },
  checked: true,
};

/** An answer that asks `request` and reports the decision, as the agent does. */
function asking(request: ApprovalRequest, decisions: (string | undefined)[], result: unknown) {
  return async (deps: PhaseDeps) => {
    const decision = await deps.approvals.request(request);
    decisions.push(decision.approved ? "approved" : decision.reason);
    if (!decision.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The server shop-staging was not rebuilt: ${decision.reason}. Nothing was changed.`,
      );
    }
    return result;
  };
}

/** The last call's deps and arguments. */
function lastCall(name: string) {
  const call = fake.calls.filter((each) => each.name === name).at(-1);
  if (call === undefined) throw new Error(`${name} was not called`);
  return call;
}

describe("opscrew restore: the flags, checked before any work", () => {
  it.each([
    [["--server", "9001", "--approve", "abc"], "--approve expects the 64-character SHA-256"],
    [["--server", "9001", "--yes"], "unknown option '--yes'"],
    [[ID, "--yes"], "unknown option '--yes'"],
    [["--server", "9001", "--only", "db"], "--server takes no --only: the provider rebuilds"],
    [
      ["--server", "9001", "--allow-other-version", "--from", "offsite"],
      "--server takes no --allow-other-version, --from",
    ],
    [[ID, "--key", "age.txt"], "--key goes only with --from offsite"],
    [[ID, "--from", "bucket"], "Allowed choices are offsite."],
    [[ID, "--from", "offsite", "--key", "missing-key.txt"], "could not read the key file"],
  ])("refuses %j", async (flags, message) => {
    const ctx = await setup();
    expect(await run(ctx, "restore", ...flags, "--env", "staging")).toBe(2);
    expect(ctx.errors).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it("prints its help with every flag", async () => {
    const ctx = await setup();
    expect(await run(ctx, "restore", "--help")).toBe(0);
    for (const flag of [
      "<id>",
      "--only <service>",
      "--allow-other-version",
      "--from <where>",
      "--key <file>",
      "--server",
      "--confirm <name>",
      "--approve <hash>",
      "--app <key>",
      "--env <name>",
    ]) {
      expect(ctx.output).toContain(flag);
    }
  });
});

describe("opscrew restore <id>", () => {
  it("passes --only, --allow-other-version, --from offsite and the key file's text", async () => {
    const ctx = await setup();
    const identity = `AGE-SECRET-KEY-1${"F".repeat(58)}`;
    await writeFile(path.join(project?.root ?? "", "age.txt"), `${identity}\n`);
    fake.answers.restoreSnapshot = async () => RESTORED;
    expect(
      await run(
        ctx,
        "restore",
        ` ${ID} `,
        "--env",
        "staging",
        "--only",
        " db ",
        "--allow-other-version",
        "--from",
        "offsite",
        "--key",
        "age.txt",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("restoreSnapshot").args).toEqual([
      ID,
      { only: "db", allowOtherVersion: true, from: "offsite", identity: `${identity}\n` },
    ]);
    expect(lastCall("restoreSnapshot").deps.paths.environment).toBe("staging");
    expect(ctx.output).toContain("run `opscrew verify --env staging` to check the app.");
    expect(ctx.output).not.toContain(identity);
  });

  it("passes the machines' fakes, and nothing else by default", async () => {
    const ctx = await setup();
    const docker = () => {
      throw new Error("not used");
    };
    withServices(ctx, { snapshot: { docker } });
    fake.answers.restoreSnapshot = async () => RESTORED;
    expect(await run(ctx, "restore", ID, "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall("restoreSnapshot").args).toEqual([ID, { services: { docker } }]);
  });

  it("restores in a script only with --confirm <app> and --approve <hash>, showing what is lost", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.restoreSnapshot = asking(RESTORE, decisions, RESTORED);
    const base = ["restore", ID, "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output).toContain("What is lost: everything written to db since");
    expect(ctx.output).toContain(`✓ ${RESTORE.title} (confirmed with --confirm shop-staging)`);
    expect(await run(ctx, ...base)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop-staging")).toBe(1);
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(decisions).toEqual([
      "approved",
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
    ]);
  });

  it("keeps the key file's text out of every output, error and audit entry", async () => {
    const identity = `AGE-SECRET-KEY-1${"G".repeat(58)}`;
    const ctx = await setup();
    await writeFile(path.join(project?.root ?? "", "age.txt"), identity);
    fake.answers.restoreSnapshot = async (deps) => {
      deps.reporter.info(`Decrypting with ${identity}`);
      throw new OpsCrewError("SECRETS_KEY_REJECTED", `The key ${identity} does not open it.`);
    };
    expect(
      await run(ctx, "restore", ID, "--env", "staging", "--from", "offsite", "--key", "age.txt"),
    ).toBe(2);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(identity);
    expect(await auditText(project as TempProject)).not.toContain(identity);
  });
});

describe("opscrew restore --server", () => {
  it("rebuilds in a script only with --confirm <server name> and --approve <hash>", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.restoreServerSnapshot = asking(REBUILD, decisions, REBUILT);
    const base = ["restore", "--server", " 9001 ", "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(lastCall("restoreServerSnapshot").args).toEqual(["9001", {}]);
    expect(ctx.output).toContain(`Restore hash: ${HASH}`);
    expect(ctx.output).toContain(`✓ ${REBUILD.title} (confirmed with --confirm shop-staging)`);
    expect(await run(ctx, ...base, "--confirm", "shop-staging")).toBe(1);
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop-staging", "--approve", OTHER)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop", "--approve", HASH)).toBe(1);
    expect(decisions).toEqual([
      "approved",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging",
    ]);
  });

  it("asks a terminal, which types the name", async () => {
    const ctx = await setup({ interactive: true });
    let asked: ApprovalRequest | undefined;
    withServices(ctx, {
      approvalHandler: {
        request: async (request) => {
          asked = request;
          return {
            approved: true,
            approver: "test",
            decidedAt: "2026-10-11T12:00:00.000Z",
            ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
          };
        },
      },
    });
    fake.answers.restoreServerSnapshot = asking(REBUILD, [], REBUILT);
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging"), ctx.errors).toBe(0);
    expect(asked?.confirmPhrase).toBe("shop-staging");
  });

  it("says to verify when this computer could not check the app", async () => {
    const ctx = await setup();
    fake.answers.restoreServerSnapshot = async () => ({ ...REBUILT, checked: false });
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("run `opscrew verify --env staging` to check the app.");
  });

  it("never shows a secret the agent's text holds", async () => {
    const token = fakeSecret("hcloud-token");
    const ctx = await setup({ env: { HCLOUD_TOKEN: token } });
    fake.answers.restoreServerSnapshot = async (deps) => {
      await deps.approvals.request({ ...REBUILD, details: `Read with ${token}` });
      throw new OpsCrewError("PROVIDER_ERROR", `Hetzner said ${token}.`);
    };
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging")).toBe(2);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(token);
    expect(await auditText(project as TempProject)).not.toContain(token);
  });
});
