import { readFile } from "node:fs/promises";
import path from "node:path";
import { allocateNetwork } from "@opscrew/agents";
import { SERVER_IPV4, testKeyMaker, testPlan } from "@opscrew/agents/testing";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { type CliServices, withServices } from "../deps";
import { DeployRunner, fakeServer, writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Outside view: 22/80/443 answer, everything else is closed unless listed in `open`. */
function ports(open: number[] = []): TcpConnect {
  return async (_host, port) => [22, 80, 443, ...open].includes(port);
}

async function setup(plan: DeployPlan | undefined, secure: CliServices["secure"] = {}) {
  project = await tempProject();
  if (plan !== undefined) {
    await writeProjectPlan(project, plan);
  }
  const ctx = projectContext(project, { services: { runner: new DeployRunner() } });
  withServices(ctx, {
    secure: { remote: fakeServer(), tcpConnect: ports(), scanners: [], offline: true, ...secure },
  });
  return { ctx, root: project.root };
}

const deployed = () => testPlan({ deployed: true, httpAllowedFrom: "any", userSecret: false });

describe("opscrew secure", () => {
  it("writes the report and exits 0 for a hardened server", async () => {
    const { ctx, root } = await setup(deployed());
    expect(await run(ctx, "secure")).toBe(0);

    const report = await readFile(path.join(root, "opscrew", "SECURITY_REPORT.md"), "utf8");
    expect(report).toContain("# OpsCrew security report: shop");
    expect(report).toContain("**No problems found.**");
    expect(ctx.output).toContain(`Checking the server's hardening over SSH (${SERVER_IPV4})`);
    expect(ctx.output).toContain("`opscrew verify`");
    const state = await new ProjectStateStore(
      resolveProjectPaths(root, { env: ctx.env }).files.state,
    ).read();
    expect(state.phases.secure?.status).toBe("ok");
  });

  it("exits 1 when a database port is reachable from the internet", async () => {
    const { ctx, root } = await setup(deployed(), { tcpConnect: ports([5432]) });
    expect(await run(ctx, "secure")).toBe(1);
    expect(`${ctx.output}${ctx.errors}`).toContain("5432");
    expect(ctx.output).toContain("fix the problems listed in opscrew/SECURITY_REPORT.md");
    const report = await readFile(path.join(root, "opscrew", "SECURITY_REPORT.md"), "utf8");
    expect(report).toContain("Port 5432 (PostgreSQL) is reachable from the internet.");
  });

  it("exits 1 when SSH password login is enabled", async () => {
    const { ctx } = await setup(deployed(), { remote: fakeServer({ passwordAuth: true }) });
    expect(await run(ctx, "secure")).toBe(1);
  });

  it("--deep adds the deeper checks to the report; without it the report has none", async () => {
    // No Docker on this computer: ssh-audit and testssl.sh are skipped with how to enable them.
    const docker = { run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }) };
    const { ctx, root } = await setup(deployed(), { docker });
    await run(ctx, "secure", "--deep");
    const report = await readFile(path.join(root, "opscrew", "SECURITY_REPORT.md"), "utf8");
    expect(report).toContain("## Deeper checks");
    expect(report).toContain("ssh-audit");

    expect(await run(ctx, "secure")).toBe(0);
    const plain = await readFile(path.join(root, "opscrew", "SECURITY_REPORT.md"), "utf8");
    expect(plain).not.toContain("## Deeper checks");
  });

  it("refuses to close public SSH, before any change, while a condition is missing", async () => {
    const plan = deployed();
    const { network } = allocateNetwork(plan, {}, testKeyMaker());
    const { ctx, root } = await setup(DeployPlanSchema.parse({ ...plan, network }));
    const planFile = path.join(root, "opscrew", "plan.yaml");
    const before = await readFile(planFile, "utf8");
    expect(await run(ctx, "secure", "--close-public-ssh")).toBe(1);
    expect(ctx.errors).toContain("OpsCrew can't close public SSH yet");
    expect(ctx.errors).toContain("--runner server");
    expect(ctx.errors).toContain("opscrew vpn add <name> --this-computer");
    expect(await readFile(planFile, "utf8")).toBe(before);
  });

  it("takes one of --close-public-ssh and --open-public-ssh, without --deep", async () => {
    const { ctx } = await setup(deployed());
    expect(await run(ctx, "secure", "--close-public-ssh", "--open-public-ssh")).toBe(2);
    expect(ctx.errors).toContain("Use either --close-public-ssh or --open-public-ssh.");
    expect(await run(ctx, "secure", "--close-public-ssh", "--deep")).toBe(2);
    expect(await run(ctx, "secure", "--approve", "a".repeat(64))).toBe(2);
    expect(ctx.errors).toContain("--approve and --yes go with --close-public-ssh");
  });

  it("exits 1 when there is no plan yet (an earlier step has not run)", async () => {
    const { ctx } = await setup(undefined);
    expect(await run(ctx, "secure")).toBe(1);
    expect(ctx.errors).toContain("plan.yaml");
  });
});
