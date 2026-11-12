// `opscrew destroy` on Contabo, whose firewall its connector applies (ADR 0029, D8): the firewall
// the state wanted is deleted after the teardown's apply, which cancels the server.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureStatePassphrase } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeFirewalls,
  FakeServers,
  fakeCloudflare,
  fakeWantedFirewall,
  HOST_KEY,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

const SERVER_ID = "202611001";
const CONTABO = "registry.opentofu.org/contabo/contabo";
const RESOURCES: ResourceChange[] = [
  ["terraform_data", "firewall", "terraform.io/builtin/terraform"],
  ["contabo_tag_assignment", "app", CONTABO],
  ["contabo_tag", "app", CONTABO],
  ["contabo_secret", "deploy", CONTABO],
  ["contabo_instance", "this", CONTABO],
].map(([type = "", name = "", provider = ""]) => ({
  address: `module.server.${type}.${name}`,
  type,
  name,
  provider,
  action: "delete" as const,
}));

/** The provider's servers: a shutdown is recorded, and the read-back answers the cancel date. */
class CancellingServers extends FakeServers {
  override async powerOff(serverId?: string): Promise<void> {
    this.events.push(`power-off:${serverId}`);
  }
}

/** A deployed app on Contabo, without OpsCrew's data snapshot to offer. */
function contaboPlan(): DeployPlan {
  const plan = testPlan({ deployed: true, provider: "contabo", postgres: false });
  return { ...plan, target: { ...cloudTarget(plan.target), backups: false } };
}

async function setup() {
  const plan = contaboPlan();
  const project = await createProject(plan);
  const events: string[] = [];
  const engine = new ScriptedDestroyEngine(
    {
      resources: RESOURCES,
      wantedFirewalls: { server: fakeWantedFirewall("contabo", SERVER_ID) },
    },
    events,
  );
  const firewalls = new FakeFirewalls((call) => events.push(call));
  firewalls.seed(fakeWantedFirewall("contabo", SERVER_ID));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      CLOUDFLARE_API_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler(() => true),
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new CancellingServers(events, "contabo"),
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(events),
    sleep: async () => undefined,
    firewalls: { contabo: firewalls },
  };
  return { deps, engine, events, firewalls, services };
}

describe.skipIf(!findExecutable("git"))("runDestroy on Contabo and its firewall", () => {
  it("deletes the server's firewall after the apply that cancels the server, says and audits it", async () => {
    const s = await setup();
    await runDestroy(s.deps, { services: s.services });
    const teardown = s.events.filter(
      (event) => !event.startsWith("plan:") && !event.startsWith("secret:"),
    );
    expect(teardown).toEqual([`power-off:${SERVER_ID}`, "apply:destroy", "remove shop-firewall"]);
    expect(s.firewalls.firewalls.size).toBe(0);
    expect(s.deps.reporter.text()).toContain("success: Deleted Contabo's firewall shop-firewall.");
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "delete firewall",
        target: "contabo firewall shop-firewall",
      }),
    );
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });

  it("finishes the teardown when the firewall cannot be deleted, and says where to delete it", async () => {
    const s = await setup();
    s.firewalls.removeError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 503.");
    await runDestroy(s.deps, { services: s.services });
    expect(s.deps.reporter.text()).toContain(
      "warn: OpsCrew could not delete Contabo's firewall shop-firewall: Contabo answered 503. No server of this app needs it any more; delete it in the Contabo Customer Control Panel.",
    );
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });
});
