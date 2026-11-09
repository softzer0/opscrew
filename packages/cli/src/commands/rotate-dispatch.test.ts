// Feature 025 (T2515): each name of `opscrew rotate` reaches its target's rotation, through the
// fakes the agents tests use; a deploy key's provider copy, `--all`, `--qr`, a grant's password and
// a rotation on this computer that GitHub doesn't deploy.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VpnServices } from "@opscrew/agents";
import {
  FAKE_SOPS,
  FakeEngine,
  FakeGitHub,
  FakeSops,
  freshFacts,
  portainerPlan,
  sitePlan,
  testKeyMaker,
  testPlan,
} from "@opscrew/agents/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  RemoteExec,
} from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { CliServices } from "../deps";
import { DeployRunner, deployProject } from "../ui/__fixtures__/deploy";
import { localPlan, withEnvironments } from "../ui/__fixtures__/environments";
import { GIT, projectContext, run, type TempProject } from "../ui/__fixtures__/harness";
import { rotationApprovals } from "./rotate";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const NOW = new Date("2026-11-09T12:00:00.000Z");
const HASH = "ab".repeat(32);
const DB_PASSWORD = fakeSecret("generic-password", "cli-dispatch-db");
const SESSION_SECRET = fakeSecret("generic-password", "cli-dispatch-session");

/** Approves every request that reaches it and records it. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: NOW.toISOString() };
  }
}

/** GitHub's fake whose runs, started to put new values in place, pass. */
class RunsPass extends FakeGitHub {
  async waitForWorkflowRun(_owner: string, _repo: string, options: { runId: number }) {
    return {
      id: options.runId,
      status: "completed" as const,
      conclusion: "success",
      htmlUrl: `https://github.com/acme/shop/actions/runs/${options.runId}`,
      headSha: "abc1234def",
    };
  }
}

/** A git project for `plan` with the database's password and the session secret kept here. */
async function setup(plan: DeployPlan) {
  const p = await deployProject(plan);
  project = p;
  p.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
  const paths = resolveProjectPaths(p.root, { env: p.env });
  await mkdir(paths.projectHomeDir, { recursive: true });
  await writeFile(
    path.join(paths.projectHomeDir, "generated_values.json"),
    `${JSON.stringify({ dbPassword: DB_PASSWORD, env: { SESSION_SECRET } })}\n`,
  );
  return { p, paths };
}

/** A run's context: a script, GitHub faked, `approvals` (default: every one given). */
function context(
  p: TempProject,
  options: { approvals?: ApprovalHandler; services?: CliServices } = {},
) {
  const github = new RunsPass();
  const ctx = projectContext(p, {
    services: {
      runner: new FakeSops().runner(new DeployRunner()),
      clock: { now: () => NOW },
      approvalHandler: options.approvals ?? new ApproveAll(),
      provision: { github },
      rotate: { github },
      ...options.services,
    },
  });
  return { ctx, github };
}

/**
 * The servers of a deployed app on its own private network, as `opscrew vpn` reaches them: the host
 * adapter's inspection and apply, the key maker and WireGuard's read.
 */
function vpnServices() {
  const keys = testKeyMaker("device");
  const applies: HostPlan[] = [];
  const vpn: VpnServices = {
    remote: async (server): Promise<RemoteExec> => ({
      host: server,
      run: async () => ({ exitCode: 0, stdout: "docker\n", stderr: "" }),
    }),
    host: {
      inspect: async () => freshFacts({ user: "deploy", privilege: "docker" }),
      async apply(_remote: RemoteExec, plan: HostPlan, o: ApplyOptions): Promise<ApplyResult> {
        if (o.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push(plan);
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
    keys,
    readWireGuard: async () => [],
  };
  return { vpn, keys, applies };
}

describe("a deploy key's copy at the provider", () => {
  // `replaceDeployKeyObject`'s request: an infrastructure plan that replaces a resource.
  const replacement: ApprovalRequest = {
    kind: "iac-apply",
    title: "Replace the deploy key's copy at the provider for prod",
    details: "~ hcloud_ssh_key.deploy (replace)",
    planHash: HASH,
    allowDestroy: true,
    confirmPhrase: "shop",
  };

  it("is approved in a script only with --confirm <app> and --approve <hash>", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const { ctx } = context(p);
    const handler = (confirm: string | undefined, hashes: string[]) =>
      rotationApprovals(ctx, { hashes, confirm, yes: false })(refuseAll(), { now: () => NOW });
    const without = await handler(undefined, [HASH]).request(replacement);
    expect(without.approved).toBe(false);
    expect(without.reason).toContain("add --confirm shop");
    expect((await handler("shop", []).request(replacement)).approved).toBe(false);
    expect((await handler("shop", [HASH]).request(replacement)).approved).toBe(true);
    // The request was shown first, so the user sees what is replaced.
    expect(ctx.output).toContain("Replace the deploy key's copy at the provider for prod");
  });

  it("takes --confirm with deploy-key", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const { ctx } = context(p, { approvals: refuseAll() });
    await run(ctx, "rotate", "deploy-key", "--confirm", "shop");
    expect(ctx.errors).not.toContain("--confirm goes only");
  });
});

/** A handler that refuses everything (a script without the flags a request needs). */
function refuseAll(): ApprovalHandler {
  return {
    request: async () => ({ approved: false, approver: "test", decidedAt: NOW.toISOString() }),
  };
}

describe.skipIf(GIT === undefined)("opscrew rotate's dispatch", () => {
  it("services on a server reach the server's rotation, over SSH", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const hosts: string[] = [];
    const remote = (host: string): RemoteExec => ({
      host,
      run: async () => {
        hosts.push(host);
        return { exitCode: 1, stdout: "", stderr: "the fake server stops here" };
      },
    });
    const github = new RunsPass();
    const { ctx } = context(p, { services: { provision: { github, remote } } });
    expect(await run(ctx, "rotate", "db")).not.toBe(0);
    expect(hosts.length).toBeGreaterThan(0);
  });

  it("services in Portainer reach the Portainer rotation", async () => {
    const { p } = await setup(portainerPlan());
    const { ctx } = context(p);
    expect(await run(ctx, "rotate", "db")).not.toBe(0);
    expect(ctx.errors).toContain("OpsCrew does not know how to reach your Portainer");
  });

  it("services on this computer reach its rotation, with no GitHub repository", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const dev = resolveProjectPaths(project.root, { env: project.env, environment: "dev" });
    await mkdir(dev.projectHomeDir, { recursive: true });
    await writeFile(
      path.join(dev.projectHomeDir, "generated_values.json"),
      `${JSON.stringify({ dbPassword: DB_PASSWORD })}\n`,
    );
    const ctx = projectContext(project, { services: { approvalHandler: new ApproveAll() } });
    expect(await run(ctx, "rotate", "db", "--env", "dev")).not.toBe(0);
    // The rotation on this computer reads the app's folder, and asks no GitHub repository.
    expect(ctx.errors).toContain("db.env in the app's folder on this computer");
    expect(ctx.errors).not.toContain("GitHub");
  });

  it("--drop-previous names the previous values through dropPreviousNames", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const { ctx } = context(p);
    expect(await run(ctx, "rotate", "app", "--drop-previous")).not.toBe(0);
    expect(ctx.errors).toContain("keeps no previous value of APP_KEY and BETTER_AUTH_SECRET");
  });

  it("--all rotates the app's own secrets in one plan, typed name once, and lists no app:*", async () => {
    const base = sitePlan({ render: "ssr", deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [
          { name: "SESSION_SECRET", secret: true, source: "generated" },
          { name: "CRON_SECRET", secret: true, source: "generated" },
        ],
      },
    });
    const { p, paths } = await setup(plan);
    await writeFile(
      path.join(paths.projectHomeDir, "generated_values.json"),
      `${JSON.stringify({ env: { SESSION_SECRET, CRON_SECRET: fakeSecret("generic-password", "cli-cron") } })}\n`,
    );
    const approvals = new ApproveAll();
    const refused = context(p, { approvals }).ctx;
    expect(await run(refused, "rotate", "--all")).toBe(1);
    expect(refused.errors).toContain("add --confirm example-app");
    const hash = /Rotation hash: ([0-9a-f]{64})/.exec(refused.output)?.[1] as string;
    expect(hash, refused.output).toMatch(/^[0-9a-f]{64}$/);
    // One plan for both secrets, with the typed name once.
    expect(refused.output).toContain("app:SESSION_SECRET");
    expect(refused.output).toContain("app:CRON_SECRET");

    const { ctx, github } = context(p, { approvals });
    expect(
      await run(ctx, "rotate", "--all", "--confirm", "example-app", "--approve", hash),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output.match(/confirmed with --confirm example-app/g)).toHaveLength(1);
    expect(github.dispatches).toHaveLength(1);
    // Nothing is left to rotate one by one: no app:* is named after the plan.
    expect(ctx.output).not.toContain("Next:");
  });

  it("device:<name> --qr draws the new configuration as a QR code, never its key", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const { vpn, keys } = vpnServices();
    const added = context(p, { services: { vpn } }).ctx;
    expect(await run(added, "vpn", "add", "laptop"), added.errors).toBe(0);

    const { ctx } = context(p, { services: { vpn } });
    expect(await run(ctx, "rotate", "device:laptop", "--qr"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("Scan it in the WireGuard app");
    expect(ctx.output).toMatch(/[▀▄█]{10}/);
    for (const pair of keys.made) expect(ctx.output).not.toContain(pair.privateKey);
  });

  it("grant:<device>/<service> shows the new password once", async () => {
    const { p } = await setup(testPlan({ deployed: true, userSecret: false }));
    const { vpn } = vpnServices();
    const added = context(p, { services: { vpn } }).ctx;
    expect(await run(added, "vpn", "add", "laptop"), added.errors).toBe(0);
    const granted = context(p, { services: { vpn } }).ctx;
    expect(await run(granted, "vpn", "grant", "laptop", "db"), granted.errors).toBe(0);
    const old = /Password: (\S+)/.exec(granted.output)?.[1] as string;

    const { ctx } = context(p, { services: { vpn } });
    expect(await run(ctx, "rotate", "grant:laptop/db"), ctx.errors).toBe(0);
    expect(ctx.output.split("Password: ")).toHaveLength(2);
    const fresh = /Password: (\S+)/.exec(ctx.output)?.[1] as string;
    expect(fresh).toMatch(/^[A-Za-z0-9]{16,}$/);
    expect(fresh).not.toBe(old);
  });

  it("on this computer without a repository, writes the record and says to commit it", async () => {
    project = await withEnvironments({ dev: localPlan("dev") });
    const paths = resolveProjectPaths(project.root, { env: project.env, environment: "dev" });
    await mkdir(path.dirname(paths.files.statePassphrase), { recursive: true });
    await writeFile(paths.files.statePassphrase, `${fakeSecret("generic-password", "cli-pass")}\n`);
    const ctx = projectContext(project, {
      services: {
        approvalHandler: new ApproveAll(),
        provision: { engine: async () => new FakeEngine() },
      },
    });
    expect(await run(ctx, "rotate", "state-passphrase", "--env", "dev"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("commit opscrew/credentials.yaml");
    expect(
      await readFile(path.join(project.root, "opscrew", "credentials.yaml"), "utf8"),
    ).toContain("state-passphrase:");
  });
});
