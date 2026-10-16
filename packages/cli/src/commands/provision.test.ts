import { readFile } from "node:fs/promises";
import path from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  FakeEngine,
  FakeGitHub,
  planJsonFor,
  provisionServices,
  SERVER_IPV4,
  testPlan,
} from "../ui/__fixtures__/deploy";
import { GIT, git, projectContext, run, ScriptedPrompts } from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything and records the requests (the scripted human). */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: true,
      approver: "test",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
    };
  }
}

interface Setup {
  engine?: FakeEngine;
  interactive?: boolean;
  approvals?: ApprovalHandler;
  prompts?: ScriptedPrompts;
}

/** A non-interactive context (the real `--approve`/`--yes` handler) with deploy fakes attached. */
function context(p: DeployProject, options: Setup = {}) {
  const engine = options.engine ?? new FakeEngine();
  const github = new FakeGitHub();
  const runner = new DeployRunner();
  const ctx = projectContext(p, {
    interactive: options.interactive ?? false,
    services: {
      runner,
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
      ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    },
  });
  withServices(ctx, { provision: provisionServices(engine, github) });
  return { ctx, engine, github, runner };
}

/** The 64-character hash printed on its own line after "Plan hash (SHA-256):". */
function printedHash(output: string): string {
  const match = /Plan hash \(SHA-256\):\s+([0-9a-f]{64})\s/.exec(output);
  if (match?.[1] === undefined) throw new Error(`No plan hash in:\n${output}`);
  return match[1];
}

describe.skipIf(GIT === undefined)("opscrew provision", () => {
  it("--plan-only --yes prints the hash; --approve <hash> --yes applies exactly that plan", async () => {
    project = await deployProject();
    const first = context(project);
    expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);

    expect(first.engine.calls).toEqual(["init", "validate", "plan"]);
    const hash = printedHash(first.ctx.output);
    expect(first.ctx.output).toContain(`    opscrew provision --approve ${hash} --yes\n`);
    expect(first.github.secrets.size).toBe(0);
    await expect(
      readFile(path.join(project.root, "opscrew/infra/prod/main.tf"), "utf8"),
    ).resolves.toContain("OpsCrew");

    const second = context(project);
    expect(await run(second.ctx, "provision", "--approve", hash, "--yes")).toBe(0);

    // The saved plan is applied as is: no new plan, the approval bound to the reviewed hash.
    expect(second.engine.calls).toEqual(["apply"]);
    expect(second.engine.applied[0]?.approval).toMatchObject({ approvedPlanHash: hash });
    const plan = await readArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"));
    expect(plan.deployment).toMatchObject({ lastPlanHash: hash });
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect((await readServerAddresses(paths)).deployment?.ipv4).toBe(SERVER_IPV4);
    expect(await readFile(paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
    expect(plan.approvals).toEqual([
      expect.objectContaining({ planHash: hash, approver: "--yes flag", kind: "iac-apply" }),
    ]);
    expect([...second.github.secrets.keys()]).toContain("OPSCREW_SSH_PRIVATE_KEY");
    expect(second.github.pulls).toEqual([
      expect.objectContaining({ head: "opscrew/deploy-setup", base: "main" }),
    ]);
    expect(
      await git(project.env, project.bare, "branch", "--list", "opscrew/deploy-setup"),
    ).toContain("opscrew/deploy-setup");
    expect(second.ctx.output).toContain(`Created or updated the server at ${SERVER_IPV4}.`);
    expect(second.ctx.output).toContain("https://github.com/acme/shop/pull/7");
    expect(second.ctx.output).toContain("`opscrew verify`");
    expect(second.ctx.output).toContain("`opscrew secure`");
    const approvals = await readFile(
      path.join(project.root, ".opscrew", "approvals.jsonl"),
      "utf8",
    );
    expect(approvals).toContain(hash);
  });

  it("refuses a hash that matches no saved plan and exits 1 without applying", async () => {
    project = await deployProject();
    const first = context(project);
    expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);

    const second = context(project);
    const wrong = "0".repeat(64);
    expect(await run(second.ctx, "provision", "--approve", wrong, "--yes")).toBe(1);
    expect(second.ctx.errors).toContain(`No saved plan has the hash ${wrong}.`);
    expect(second.ctx.errors).toContain("opscrew provision --plan-only");
    expect(second.engine.calls).not.toContain("apply");
    expect(second.github.secrets.size).toBe(0);
  });

  it("exits 2 for a malformed hash, conflicting flags or an unknown engine", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--approve", "abc123")).toBe(2);
    expect(ctx.errors).toContain("--approve expects the 64-character SHA-256 plan hash");
    expect(await run(ctx, "provision", "--plan-only", "--approve", "a".repeat(64))).toBe(2);
    expect(ctx.errors).toContain("Use either --plan-only or --approve <hash>.");
    expect(await run(ctx, "provision", "--engine", "pulumi")).toBe(2);
    expect(ctx.errors).toContain("pulumi");
    expect(engine.calls).toEqual([]);
  });

  it("needs --approve <hash> for the apply even with --yes", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--yes")).toBe(1);
    expect(engine.calls).not.toContain("apply");
    expect(ctx.errors).toContain("The infrastructure plan was not approved");
    expect(ctx.errors).toMatch(/opscrew provision --approve [0-9a-f]{64}/);
  });

  it("explains --yes when a non-interactive run cannot write the files", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--plan-only")).toBe(1);
    expect(ctx.errors).toContain("Nothing was written and nothing was created.");
    expect(ctx.errors).toContain("add --yes");
    expect(ctx.errors).toContain(
      "a plan that deletes or replaces resources also needs --confirm <app name> (opscrew provision --approve <hash> --confirm <app name>), other destroys and changed host keys need an interactive terminal.",
    );
    expect(engine.calls).toEqual([]);
  });

  it("stops with exit 1 when a security policy fails", async () => {
    project = await deployProject();
    const engine = new FakeEngine({ planJson: planJsonFor({ openDatabasePort: true }) });
    const { ctx } = context(project, { engine });
    expect(await run(ctx, "provision", "--plan-only", "--yes")).toBe(1);
    expect(ctx.errors).toMatch(/The plan fails 1 security policy/);
    expect(ctx.output).not.toContain("Plan hash (SHA-256):");
  });

  it("asks for production values in an interactive terminal without printing them", async () => {
    project = await deployProject(testPlan({ userSecret: true }));
    const stripe = fakeSecret("stripe-live-key");
    const approvals = new ApproveAll();
    const prompts = new ScriptedPrompts([stripe]);
    const { ctx, engine, github } = context(project, { interactive: true, approvals, prompts });
    expect(await run(ctx, "provision")).toBe(0);

    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(prompts.calls.map((c) => c.message)).toEqual([
      "Production value for STRIPE_SECRET_KEY (leave empty to skip)",
    ]);
    expect(github.secrets.get("OPSCREW_APP_ENV")).toContain(`STRIPE_SECRET_KEY=${stripe}`);
    expect(approvals.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(stripe);
  });

  describe("a plan that removes something (needs the app's name)", () => {
    /** A plan that replaces the server: its `iac-apply` asks for the app's name "shop". */
    const removal = () =>
      new FakeEngine({
        changes: [
          {
            address: "module.server.hcloud_server.this",
            type: "hcloud_server",
            name: "this",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "replace",
          },
        ],
      });

    async function planned(): Promise<string> {
      project = await deployProject();
      const first = context(project, { engine: removal() });
      expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);
      const hash = printedHash(first.ctx.output);
      expect(first.ctx.output).toContain(
        `    opscrew provision --approve ${hash} --yes --confirm shop\n`,
      );
      expect(first.ctx.output).toContain(
        "This plan deletes or replaces resources, so applying it also needs the app's name: type it when the command asks in a terminal, or keep --confirm shop in the command above in a script.",
      );
      return hash;
    }

    it("--approve <hash> --confirm <app> applies exactly that plan in a script", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      expect(
        await run(second.ctx, "provision", "--approve", hash, "--confirm", "shop", "--yes"),
      ).toBe(0);
      expect(second.engine.calls).toEqual(["apply"]);
      expect(second.engine.applied[0]?.approval).toMatchObject({
        approvedPlanHash: hash,
        allowDestroy: true,
      });
      expect(second.ctx.output).toContain("(confirmed with --confirm shop)");
    });

    it("stops before anything runs when --confirm is not the app's name", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      expect(
        await run(second.ctx, "provision", "--approve", hash, "--confirm", "shopp", "--yes"),
      ).toBe(1);
      expect(second.ctx.errors).toContain(
        "--confirm shopp does not match the app's name, so nothing was changed.",
      );
      expect(second.ctx.errors).toContain("opscrew provision --approve <hash> … --confirm shop");
      expect(second.engine.calls).toEqual([]);
    });

    it("refuses a script without --confirm, naming the flag; --yes never approves it", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      expect(await run(second.ctx, "provision", "--approve", hash, "--yes")).toBe(1);
      expect(second.ctx.errors).toContain("add --confirm shop");
      expect(second.ctx.errors).toContain(
        `To apply it later without prompts, run: opscrew provision --approve ${hash} --confirm shop`,
      );
      expect(second.engine.calls).not.toContain("apply");
    });

    it("refuses --confirm when the plan's hash is not listed in --approve", async () => {
      project = await deployProject();
      const { ctx, engine } = context(project, { engine: removal() });
      expect(await run(ctx, "provision", "--confirm", "shop", "--yes")).toBe(1);
      expect(ctx.errors).toContain("only together with --approve and that plan's hash");
      expect(engine.calls).not.toContain("apply");
    });

    it("still asks for the typed name in a terminal", async () => {
      project = await deployProject();
      const approvals = new ApproveAll();
      const { ctx, engine } = context(project, {
        engine: removal(),
        interactive: true,
        approvals,
      });
      expect(await run(ctx, "provision")).toBe(0);
      expect(engine.calls).toContain("apply");
      expect(approvals.requests.find((r) => r.kind === "iac-apply")).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "shop",
      });
    });
  });

  it("shows the options in --help", async () => {
    project = await deployProject();
    const { ctx } = context(project);
    expect(await run(ctx, "provision", "--help")).toBe(0);
    for (const option of [
      "--plan-only",
      "--approve <hash>",
      "--engine <name>",
      "--no-push",
      "--yes",
      "--confirm <name>",
    ]) {
      expect(ctx.output).toContain(option);
    }
  });
});
