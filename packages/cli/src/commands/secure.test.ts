import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeployRunner,
  fakeServer,
  SERVER_IPV4,
  testPlan,
  writeProjectPlan,
} from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { type DeployServices, withDeployServices } from "../ui/deploy-services";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Outside view: 22/80/443 answer, everything else is closed unless listed in `open`. */
function ports(open: number[] = []): TcpConnect {
  return async (_host, port) => [22, 80, 443, ...open].includes(port);
}

async function setup(plan: DeployPlan | undefined, secure: DeployServices["secure"] = {}) {
  project = await tempProject();
  if (plan !== undefined) {
    await writeProjectPlan(project, plan);
  }
  const ctx = projectContext(project, { services: { runner: new DeployRunner() } });
  withDeployServices(ctx, {
    secure: { remote: fakeServer(), tcpConnect: ports(), scanners: [], offline: true, ...secure },
  });
  return { ctx, root: project.root };
}

const deployed = () => testPlan({ deployed: true, httpAllowedFrom: "any" });

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

  it("exits 1 when there is no plan yet (an earlier step has not run)", async () => {
    const { ctx } = await setup(undefined);
    expect(await run(ctx, "secure")).toBe(1);
    expect(ctx.errors).toContain("plan.yaml");
  });
});
