import { readFile, stat } from "node:fs/promises";
import { deviceConfigFile, type VpnServices } from "@opscrew/agents";
import { freshFacts, testKeyMaker, testPlan } from "@opscrew/agents/testing";
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
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import {
  auditText,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** The harness's clock. */
const NOW = new Date("2026-10-11T12:00:00.000Z");

/** Approves every request that reaches it and records it. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: NOW.toISOString() };
  }
}

/**
 * A deployed single-server app (Postgres `db` next to it) with fake servers: the host adapter's
 * inspection and apply, the key maker and WireGuard's read. `approvals` replaces the CLI's own
 * handler (none: the `--approve <hash>` handler of a script).
 */
async function setup(options: { approvals?: ApprovalHandler; interactive?: boolean } = {}) {
  project = await tempProject();
  await writeProjectPlan(project, testPlan({ deployed: true, userSecret: false }));
  const applies: { server: string; plan: HostPlan; options: ApplyOptions }[] = [];
  const keys = testKeyMaker("device");
  const vpn: VpnServices = {
    // The login becomes root through Docker (the privilege probe's answer); the fake host
    // adapter does the rest.
    remote: async (server): Promise<RemoteExec> => ({
      host: server,
      run: async () => ({ exitCode: 0, stdout: "docker\n", stderr: "" }),
    }),
    host: {
      inspect: async () => freshFacts({ user: "deploy", privilege: "docker" }),
      async apply(remote: RemoteExec, plan: HostPlan, o: ApplyOptions): Promise<ApplyResult> {
        if (o.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ server: remote.host, plan, options: o });
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
    keys,
    // Every device's last handshake on the app's server was 5 seconds ago.
    readWireGuard: async () =>
      keys.made.map((pair) => ({
        publicKey: pair.publicKey,
        latestHandshake: new Date(NOW.getTime() - 5_000),
        allowedIps: [],
      })),
  };
  const ctx = projectContext(project, {
    interactive: options.interactive ?? false,
    services: {
      vpn,
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
    },
  });
  const paths = resolveProjectPaths(project.root, { env: ctx.env });
  return { ctx, paths, applies, keys, project };
}

describe("opscrew vpn", () => {
  it("lists its commands, each with --app, --env and --approve", async () => {
    const { ctx } = await setup();
    expect(await run(ctx, "vpn", "--help")).toBe(0);
    for (const name of ["add", "remove", "list", "grant", "revoke"]) {
      expect(ctx.output).toContain(name);
    }
    expect(await run(ctx, "vpn", "grant", "--help")).toBe(0);
    expect(ctx.output).toContain("--app <key>");
    expect(ctx.output).toContain("--env <name>");
    expect(ctx.output).toContain("--approve <hash>");
    expect(ctx.output).toContain("--yes-full-access");
  });

  it("adds a device, writes its configuration and draws it as a QR code without printing its key", async () => {
    const approvals = new ApproveAll();
    const { ctx, paths, applies, keys, project } = await setup({ approvals });
    expect(await run(ctx, "vpn", "add", "laptop", "--qr", "--this-computer"), ctx.errors).toBe(0);

    const plan = await readArtifact("plan", paths.files.plan);
    expect(plan.network?.devices.map((d) => d.name)).toEqual(["laptop"]);
    const device = plan.network?.devices[0]?.publicKey;
    const privateKey = keys.made.find((pair) => pair.publicKey === device)?.privateKey as string;
    const file = deviceConfigFile(paths, "laptop");
    expect(await readFile(file, "utf8")).toContain(`PrivateKey = ${privateKey}`);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(approvals.requests.map((r) => r.kind)).toEqual(["host-apply"]);
    expect(applies.map((a) => a.server)).toEqual(["app"]);
    // The QR code is drawn; the key itself is never printed, audited or written to the plan.
    expect(ctx.output).toContain("Scan it in the WireGuard app");
    expect(ctx.output).toMatch(/[▀▄█]{10}/);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(privateKey);
    expect(await auditText(project)).not.toContain(privateKey);
    expect(await readFile(paths.files.plan, "utf8")).not.toContain(privateKey);
  });

  it("stops at the host plan in a script and applies it with --approve <hash>", async () => {
    const { ctx, applies } = await setup();
    expect(await run(ctx, "vpn", "add", "laptop")).toBe(1);
    const hash = /--approve ([0-9a-f]{64})/.exec(ctx.errors)?.[1];
    expect(hash, ctx.errors).toBeDefined();
    expect(ctx.errors).toContain(`opscrew vpn add laptop --approve ${hash}`);
    expect(applies).toEqual([]);

    expect(await run(ctx, "vpn", "add", "laptop", "--approve", hash as string)).toBe(0);
    expect(applies.map((a) => hostPlanHash(a.plan))).toEqual([hash]);
  });

  it("refuses an --approve value that is not a plan hash before anything runs", async () => {
    const { ctx, applies } = await setup();
    expect(await run(ctx, "vpn", "add", "laptop", "--approve", "abc")).toBe(2);
    expect(ctx.errors).toContain("64-character SHA-256 plan hash");
    expect(applies).toEqual([]);
  });

  it("lists the devices with their last handshake", async () => {
    const { ctx } = await setup({ approvals: new ApproveAll() });
    expect(await run(ctx, "vpn", "add", "laptop")).toBe(0);
    expect(await run(ctx, "vpn", "list")).toBe(0);
    expect(ctx.output).toMatch(/laptop \(10\.\d+\.\d+\.100\)/);
    expect(ctx.output).toContain("server app: up, last handshake 5 seconds ago");
  });

  it("prints a grant's password once, unredacted, and keeps it out of the audit log", async () => {
    const { ctx, project } = await setup({ approvals: new ApproveAll() });
    expect(await run(ctx, "vpn", "add", "laptop")).toBe(0);
    expect(await run(ctx, "vpn", "grant", "laptop", "db"), ctx.errors).toBe(0);
    expect(ctx.output).toMatch(/psql "postgresql:\/\/laptop@10\.\d+\.\d+\.\d+:5432\/app"/);
    const password = /Password: (\S+)/.exec(ctx.output)?.[1] as string;
    expect(password).toMatch(/^[A-Za-z0-9]{16,}$/);
    expect(ctx.output.split("Password: ")).toHaveLength(2);
    expect(ctx.output).toContain(`postgresql://laptop:${password}@`);
    expect(await auditText(project)).not.toContain(password);

    expect(await run(ctx, "vpn", "revoke", "laptop", "db"), ctx.errors).toBe(0);
    expect(await run(ctx, "vpn", "remove", "laptop"), ctx.errors).toBe(0);
  });

  it("refuses full access in a script without --yes-full-access", async () => {
    const { ctx } = await setup({ approvals: new ApproveAll() });
    expect(await run(ctx, "vpn", "add", "laptop")).toBe(0);
    expect(await run(ctx, "vpn", "grant", "laptop", "db", "--full")).toBe(1);
    expect(ctx.errors).toContain("--yes-full-access");
    expect(ctx.output).not.toContain("Password:");
  });
});
