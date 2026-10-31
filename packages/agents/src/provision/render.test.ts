import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { hostPlanFile, keepServerSetup } from "../shared/host-plan";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps, testKeyMaker, testPlan } from "../testing";
import { deploymentFiles, deploymentRenderContext } from "./render";

/** The render input of a server app with no Cloudflare and no known server. */
const inputFor = (plan: DeployPlan) => ({
  plan,
  requirements: undefined,
  github: { owner: "acme", repo: "shop" },
  deployPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey opscrew",
  cloudflare: undefined,
});

/** The push filter of the deploy workflow provision renders for `plan`. */
async function pushFilter(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const files = deploymentFiles(plan, await deploymentRenderContext(deps, inputFor(plan)));
  const flow = files.find((file) => file.path === plan.cicd.workflowPath);
  return (parse(flow?.content ?? "") as { on: { push: { paths: string[] } } }).on.push.paths;
}

describe("deploymentRenderContext and an extra server the user owns", () => {
  it("deploys over the network on the port sshd listens on once public SSH is closed", async () => {
    const base = splitPlan({ data: "own" });
    const { network } = allocateNetwork(
      base,
      { data: { udpPortsInUse: [], wireguardInterfaces: [] } },
      testKeyMaker(),
    );
    const prefix = network.range.split(".").slice(0, 3).join(".");
    const deps = await createTestPhaseDeps();
    // The login goes through a router that forwards 2222 to sshd's 22, as data's last setup found.
    await updateServerAddresses(deps.paths, (current) => ({
      ...current,
      ownServers: { data: { host: "192.0.2.20", port: 2222, user: "admin", agent: true } },
    }));
    const setup: HostPlan = {
      schemaVersion: 1,
      purpose: "setup",
      app: base.app.name,
      steps: [
        {
          id: "ufw",
          title: "Firewall",
          state: "in-place",
          scope: "shared",
          params: { sshPorts: "22" },
        },
      ],
      findings: [],
    };
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    await writeFile(hostPlanFile(deps.paths, hostPlanHash(setup)), JSON.stringify(setup));
    await keepServerSetup(deps, "data", hostPlanHash(setup));
    /** The deploy's step for server data, as provision renders it. */
    const dataStep = async (plan: DeployPlan) => {
      const ctx = await deploymentRenderContext(deps, inputFor(plan));
      const flow = deploymentFiles(plan, ctx).find((f) => f.path === plan.cicd.workflowPath);
      const content = flow?.content ?? "";
      const start = content.indexOf("name: Update the services on the server data");
      return {
        ports: ctx.serverSshPorts,
        step: content.slice(start, content.indexOf("scp", start)),
      };
    };

    const closed = await dataStep(
      DeployPlanSchema.parse({
        ...base,
        environment: { ...base.environment, runner: "server" },
        security: { ...base.security, sshAllowedCidrs: [] },
        network: { ...network, publicSsh: false },
      }),
    );
    expect(closed.ports).toEqual({ data: 22 });
    expect(closed.step).toContain(`HOST: ${prefix}.2`);
    expect(closed.step).not.toContain("Port=");

    // With public SSH open, the deploy keeps the login's port.
    const open = await dataStep(withNetwork(base, network));
    expect(open.ports).toEqual({ data: 2222 });
    expect(open.step).toContain("-o Port=2222");
  });
});

describe("deploymentRenderContext and the repository's other apps", () => {
  it("leaves another app's folder out of the push filter of an app at the repository root", async () => {
    const deps = await createTestPhaseDeps();
    // The repository's first app, at its root (no requirements or facts name another folder).
    const plan = testPlan();
    expect(plan.app.buildContext).toBe(".");
    expect((await deploymentRenderContext(deps, inputFor(plan))).otherAppDirs).toBeUndefined();
    expect(await pushFilter(deps, plan)).not.toContain("!sites/docs/**");

    await writeArtifact("app", join(deps.paths.root, "opscrew", "apps", "docs", "app.yaml"), {
      schemaVersion: 1,
      dir: "sites/docs",
    });
    expect((await deploymentRenderContext(deps, inputFor(plan))).otherAppDirs).toEqual([
      "sites/docs",
    ]);
    const filter = await pushFilter(deps, plan);
    expect(filter.slice(0, 4)).toEqual([
      "**",
      "!opscrew/**",
      "!.github/workflows/opscrew-deploy*.yml",
      "!sites/docs/**",
    ]);

    // The further app's render names neither its own folder nor the root, which holds it.
    const docs = await createTestPhaseDeps({ root: deps.paths.root, env: deps.env, app: "docs" });
    expect((await deploymentRenderContext(docs, inputFor(plan))).otherAppDirs).toBeUndefined();
  });
});
