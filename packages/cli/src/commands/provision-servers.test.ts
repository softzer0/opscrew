import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { allocateNetwork, type RunProvisionOptions } from "@opscrew/agents";
import { testKeyMaker, testPlan } from "@opscrew/agents/testing";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { withServices } from "../deps";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { type InfraFlags, runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** The deployed app with Postgres (`db`) moved to the Hetzner server `data`, switched there. */
function switchedPlan(): DeployPlan {
  const base = testPlan({ deployed: true, userSecret: false });
  const split = {
    ...base,
    servers: [
      {
        name: "data",
        target: {
          provider: "hetzner" as const,
          mode: "vps-compose" as const,
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
      },
    ],
    services: base.services.map((s) => (s.name === "db" ? { ...s, server: "data" } : s)),
  };
  const { network } = allocateNetwork(split, {}, testKeyMaker());
  return DeployPlanSchema.parse({
    ...split,
    network,
    move: { service: "db", from: "app", to: "data", step: "switched", copy: "dump" },
  });
}

async function setup(plan: DeployPlan) {
  project = await tempProject();
  const planFile = await writeProjectPlan(project, plan);
  return { ctx: projectContext(project), planFile, root: project.root };
}

/**
 * The deploy user's shell on the app's server, where the old copy of `db` stays: the app's
 * settings (the new copy's address is not in them, so nothing points at the old one) and every
 * other command succeeding, each recorded.
 */
function oldServerShell() {
  const commands: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: command.startsWith("cat ") ? "PORT=3000\n" : "", stderr: "" };
    },
  });
  return { remote, commands };
}

/** The switched plan with the old server's shell and the database's generated password. */
async function switched() {
  const s = await setup(switchedPlan());
  const paths = resolveProjectPaths(s.root, { env: s.ctx.env });
  await mkdir(paths.projectHomeDir, { recursive: true });
  await writeFile(
    path.join(paths.projectHomeDir, "generated_values.json"),
    JSON.stringify({ dbPassword: randomBytes(12).toString("hex") }),
  );
  const shell = oldServerShell();
  withServices(s.ctx, { provision: { remote: shell.remote } });
  return { ...s, paths, shell };
}

describe("opscrew provision --finish-move in a script", () => {
  it("deletes the old copy with --confirm <service> and clears the move", async () => {
    const { ctx, paths, shell } = await switched();
    expect(await run(ctx, "provision", "--finish-move", "--confirm", "db"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("(confirmed with --confirm db)");
    expect(shell.commands.at(-1)).toMatch(/docker rm -f .* -rf \/d\/db$/);
    const plan = await readArtifact("plan", paths.files.plan);
    expect(plan.move).toBeUndefined();
    expect(plan.deployment.placement).toEqual({ db: "data" });
    const approvals = (await readFile(paths.files.approvals, "utf8")).trim().split("\n");
    expect(approvals.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        approved: true,
        approver: "--approve and --confirm flags",
        allowDestroy: true,
      }),
    );
  });

  it("deletes nothing without --confirm", async () => {
    const { ctx, planFile, shell } = await switched();
    const before = await readFile(planFile, "utf8");
    expect(await run(ctx, "provision", "--finish-move")).toBe(1);
    expect(ctx.errors).toContain("add --confirm db");
    expect(shell.commands.some((command) => command.includes("rm -f"))).toBe(false);
    expect(await readFile(planFile, "utf8")).toBe(before);
  });
});

describe("opscrew provision --allow-downtime in a script", () => {
  it("approves a move's window, and still refuses a deletion or a plan --approve does not name", async () => {
    const { ctx } = await setup(switchedPlan());
    const hash = "a".repeat(64);
    const decisions: Record<string, boolean> = {};
    await runInfraCommand(
      ctx,
      "provision",
      { approve: [hash], allowDowntime: true },
      async (deps) => {
        const ask = async (name: string, request: ApprovalRequest) => {
          decisions[name] = (await deps.approvals.request(request)).approved;
        };
        await ask("window", {
          kind: "remote-exec",
          title: "Maintenance window: stop shop and move db from the app's server to server data",
          details: "…",
        });
        await ask("deletion", {
          kind: "iac-apply",
          title: "Delete server data",
          details: "…",
          planHash: hash,
          allowDestroy: true,
          confirmPhrase: "shop-data",
        });
        await ask("other plan", {
          kind: "iac-apply",
          title: "Apply the plan",
          details: "…",
          planHash: "b".repeat(64),
        });
        await ask("named plan", {
          kind: "iac-apply",
          title: "Apply",
          details: "…",
          planHash: hash,
        });
        return { applied: false, outputs: {} };
      },
    );
    expect(decisions).toEqual({
      window: true,
      deletion: false,
      "other plan": false,
      "named plan": true,
    });
    expect(ctx.output).toContain("(allowed with --allow-downtime)");
  });
});

describe("opscrew provision --finish-move", () => {
  it("only deletes a moved service's old copy: without a move there is nothing to delete", async () => {
    const { ctx } = await setup(testPlan({ deployed: true, userSecret: false }));
    expect(await run(ctx, "provision", "--finish-move")).toBe(1);
    expect(ctx.errors).toContain("No service is moving between the app's servers");
  });

  it("refuses --plan-only, --approve and --allow-downtime, which it has no use for", async () => {
    const { ctx } = await setup(switchedPlan());
    expect(await run(ctx, "provision", "--finish-move", "--plan-only")).toBe(2);
    expect(ctx.errors).toContain("so it does not go with --plan-only.");
    const hash = "a".repeat(64);
    expect(await run(ctx, "provision", "--finish-move", "--approve", hash)).toBe(2);
    expect(await run(ctx, "provision", "--finish-move", "--allow-downtime")).toBe(2);
  });

  it("checks --confirm against the moved service's name before anything runs", async () => {
    const { ctx, planFile } = await setup(switchedPlan());
    const before = await readFile(planFile, "utf8");
    expect(await run(ctx, "provision", "--finish-move", "--confirm", "shop")).toBe(1);
    expect(ctx.errors).toContain("--confirm shop does not match the moved service's name");
    expect(ctx.errors).toContain("opscrew provision --finish-move --confirm db");
    expect(await readFile(planFile, "utf8")).toBe(before);
  });

  it("documents --finish-move and --allow-downtime in its help", async () => {
    const { ctx } = await setup(switchedPlan());
    expect(await run(ctx, "provision", "--help")).toBe(0);
    expect(ctx.output).toContain("--finish-move");
    expect(ctx.output).toContain("--allow-downtime");
  });
});

describe("opscrew provision --confirm in a script, without --approve", () => {
  const LIFT = "1".repeat(64);
  const DELETION = "2".repeat(64);
  const lift: ApprovalRequest = {
    kind: "iac-apply",
    title: "Lift delete protection on shop-data",
    details: `update module.server_data.hcloud_server.this\nPlan hash: ${LIFT}`,
    planHash: LIFT,
  };
  const deletion: ApprovalRequest = {
    kind: "iac-apply",
    title: "Apply the infrastructure plan",
    details: "…",
    planHash: DELETION,
    allowDestroy: true,
    confirmPhrase: "shop-data",
  };

  /** The app without its extra server `data`, and the saved plan that deletes it. */
  async function removal() {
    const s = await setup(testPlan({ deployed: true, userSecret: false }));
    const paths = resolveProjectPaths(s.root, { env: s.ctx.env });
    await mkdir(paths.files.plansDir, { recursive: true });
    const deletes = (address: string, type: string) => ({
      address,
      type,
      name: "this",
      provider: "hcloud",
      action: "delete",
    });
    await writeFile(
      path.join(paths.files.plansDir, "2026-10-31T08-00-00-000Z.tfplan.json"),
      JSON.stringify({
        planHash: DELETION,
        planFile: path.join(paths.files.plansDir, "2026-10-31T08-00-00-000Z.tfplan"),
        dir: "infra",
        engine: { name: "tofu", version: "1.10.0", binary: "tofu" },
        createdAt: "2026-10-31T08:00:00.000Z",
        changes: [
          deletes("module.server_data.hcloud_server.this", "hcloud_server"),
          deletes("module.server_data.hcloud_firewall.this", "hcloud_firewall"),
        ],
        counts: { create: 0, update: 0, delete: 2, replace: 0 },
        hasDestroy: true,
        policy: [],
        planJson: {},
      }),
    );
    return { ...s, paths };
  }

  /** Runs provision with `flags` on a phase that asks for the lift and the deletion. */
  async function provision(ctx: CliContext, flags: InfraFlags) {
    const decisions: Record<string, boolean> = {};
    let options: RunProvisionOptions = {};
    await runInfraCommand(ctx, "provision", flags, async (deps, given) => {
      options = given;
      decisions.lift = (await deps.approvals.request(lift)).approved;
      decisions.deletion = (await deps.approvals.request(deletion)).approved;
      return { applied: false, outputs: {}, planHash: DELETION };
    });
    return { decisions, options };
  }

  it("lifts the protection its names cover, then only plans and prints the --approve command", async () => {
    const { ctx, paths } = await removal();
    const { decisions, options } = await provision(ctx, { confirm: ["shop-data"] });
    expect(options).toMatchObject({ planOnly: true, liftConfirmedBy: ["shop-data"] });
    // The names approve the lift; the deletion still needs its hash.
    expect(decisions).toEqual({ lift: true, deletion: false });
    // The lift is shown, its hash too, before it is granted.
    const shown = ctx.output.indexOf(`Plan hash: ${LIFT}`);
    expect(shown).toBeGreaterThan(-1);
    expect(ctx.output.indexOf("update module.server_data.hcloud_server.this")).toBeLessThan(shown);
    expect(
      ctx.output.indexOf(
        "Lift delete protection on shop-data (confirmed with --confirm shop-data)",
      ),
    ).toBeGreaterThan(shown);
    expect(ctx.output).toContain(`opscrew provision --approve ${DELETION} --confirm shop-data`);
    const approvals = (await readFile(paths.files.approvals, "utf8")).trim().split("\n");
    expect(approvals.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ planHash: LIFT, approved: true, approver: "--confirm flags" }),
    );
  });

  it("refuses the lift outside that run: with --approve, which runs without it, or with --plan-only", async () => {
    for (const flags of [
      { confirm: ["shop-data"], approve: [DELETION] },
      { confirm: ["shop-data"], planOnly: true },
    ]) {
      const { ctx } = await removal();
      const { decisions, options } = await provision(ctx, flags);
      expect(options.liftConfirmedBy).toBeUndefined();
      expect(decisions.lift).toBe(false);
      await project?.cleanup();
    }
  });

  it("leaves the lift to the prompt in a terminal", async () => {
    project = await tempProject();
    await writeProjectPlan(project, testPlan({ deployed: true, userSecret: false }));
    const ctx = projectContext(project, { interactive: true });
    let options: RunProvisionOptions = {};
    await runInfraCommand(ctx, "provision", { confirm: ["shop-data"] }, async (_deps, given) => {
      options = given;
      return { applied: false, outputs: {} };
    });
    expect(options.planOnly).toBeUndefined();
    expect(options.liftConfirmedBy).toBeUndefined();
  });
});

describe("opscrew provision --plan-only with several servers", () => {
  it("prints each server's host plan hash in the --approve command", async () => {
    const { ctx, root } = await setup(switchedPlan());
    const paths = resolveProjectPaths(root, { env: ctx.env });
    const hashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    await mkdir(paths.files.plansDir, { recursive: true });
    // Two plans change something; the third is in place and needs no approval.
    for (const [i, hash] of hashes.entries()) {
      const state = i < 2 ? "change" : "ok";
      await writeFile(
        path.join(paths.files.plansDir, `host-${hash}.json`),
        JSON.stringify({ steps: [{ state }] }),
      );
    }
    await runInfraCommand(ctx, "provision", { planOnly: true }, async () => ({
      applied: false,
      outputs: {},
      serverHostPlanHashes: hashes,
    }));
    expect(ctx.output).toContain(`host plan for one of the app's servers:  ${hashes[0]}`);
    expect(ctx.output).toContain(`host plan for one of the app's servers:  ${hashes[1]}`);
    expect(ctx.output).not.toContain(hashes[2]);
    expect(ctx.output).toContain(`opscrew provision --approve ${hashes[0]} --approve ${hashes[1]}`);
  });
});
