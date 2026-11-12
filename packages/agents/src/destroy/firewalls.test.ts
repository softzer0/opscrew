// `opscrew destroy` on Contabo, whose firewall its connector applies (ADR 0029, D8) and whose
// server its connector cancels (D10): after the shutdown, the server is cancelled through the
// connector, taken out of the state, and the rest of the teardown planned again and applied; the
// firewall the state wanted is deleted after that apply, and also when Cloudflare refused only the
// tunnel of Portainer's subdomain in it (error 1022).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppServer, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureStatePassphrase } from "../shared";
import {
  BUSY_TUNNEL_LOG,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import { TUNNEL_RESOURCE_TYPE } from "../shared/tunnel-connections";
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

  // Contabo lists a cancelled instance with the day its contract ends.
  override async findAppServers(app: string): Promise<AppServer[]> {
    return (await super.findAppServers(app)).map((server) =>
      this.cancelled.includes(server.id) ? { ...server, cancelledUntil: this.cancelDate } : server,
    );
  }
}

/**
 * A deployed app on Contabo, without OpsCrew's data snapshot to offer; with `tunnel`, Portainer on
 * a subdomain, whose tunnel's connector runs on the server.
 */
function contaboPlan(tunnel: boolean): DeployPlan {
  const plan = testPlan({
    deployed: true,
    provider: "contabo",
    postgres: false,
    ...(tunnel ? { domain: "shop.example.com" } : {}),
  });
  return {
    ...plan,
    target: { ...cloudTarget(plan.target), backups: false },
    ...(tunnel
      ? {
          dns: { ...plan.dns, zone: "example.com" },
          portainer: {
            enabled: true,
            version: "2.45.2",
            access: "subdomain" as const,
            hostname: "portainer.example.com",
            allowedEmails: ["owner@example.com"],
          },
        }
      : {}),
  };
}

/**
 * With `tunnel`, the teardown's first apply cancels the server and deletes everything but the
 * tunnel, which Cloudflare refuses (1022) while its connections outlast the server; the state then
 * has no outputs any more.
 */
async function setup(tunnel = false) {
  const plan = contaboPlan(tunnel);
  const project = await createProject(plan);
  const events: string[] = [];
  const engine = new ScriptedDestroyEngine(
    {
      resources: [...RESOURCES, ...(tunnel ? tunnelDeletes() : [])],
      wantedFirewalls: { server: fakeWantedFirewall("contabo", SERVER_ID) },
    },
    events,
  );
  if (tunnel) {
    // The plan JSON names the tunnel's id and account, as tofu writes it.
    const plan = engine.plan.bind(engine);
    engine.plan = async (dir, planFile, options) => {
      const summary = await plan(dir, planFile, options);
      const json = summary.planJson as { resource_changes: { address: string }[] };
      const tunnel = tunnelDeletePlanJson(summary.changes).resource_changes;
      const resourceChanges = json.resource_changes.map(
        (entry) =>
          tunnel.find((t) => t.address === entry.address && t.type === TUNNEL_RESOURCE_TYPE) ??
          entry,
      );
      return { ...summary, planJson: { ...json, resource_changes: resourceChanges } };
    };
    let busy = true;
    const apply = engine.apply.bind(engine);
    engine.apply = async (dir, planFile, approval) => {
      if (!busy) return apply(dir, planFile, approval);
      busy = false;
      events.push("apply:destroy");
      engine.script.resources = tunnelDeletes().filter((c) => c.type === TUNNEL_RESOURCE_TYPE);
      engine.script.wantedFirewalls = undefined;
      return { ok: false, outputs: {}, log: BUSY_TUNNEL_LOG };
    };
  }
  const firewalls = new FakeFirewalls((call) => events.push(call));
  firewalls.seed(fakeWantedFirewall("contabo", SERVER_ID));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      CLOUDFLARE_API_TOKEN: tunnel ? fakeSecret("cloudflare-token", "destroy-contabo") : undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler(() => true),
    ...(tunnel
      ? { fetch: fakeTunnelApi({ events, connectorRunning: () => false, closeAfter: 1 }).fetch }
      : {}),
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  const servers = new CancellingServers(events, "contabo");
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers,
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(events),
    sleep: async () => undefined,
    firewalls: { contabo: firewalls },
  };
  return { deps, engine, events, firewalls, servers, services };
}

describe.skipIf(!findExecutable("git"))("runDestroy on Contabo's server and firewall", () => {
  it("cancels the server through the connector after its shutdown, takes it out of the state and applies the rest planned again", async () => {
    const s = await setup();
    await runDestroy(s.deps, { services: s.services });
    const teardown = s.events.filter((event) => !event.startsWith("secret:"));
    expect(teardown).toEqual([
      // The preview, then the teardown plan the user approves.
      "plan:destroy",
      "plan:destroy",
      `power-off:${SERVER_ID}`,
      `cancel:${SERVER_ID}`,
      "state-rm:module.server.contabo_instance.this",
      "plan:destroy",
      "apply:destroy",
      "remove shop-firewall",
    ]);
    // The approved plan listed the server's deletion; the plan applied is it without that.
    const [, approved, again] = s.engine.planFiles;
    expect(s.engine.applied.map((a) => a.planFile)).toEqual([again]);
    expect(again).toBe(approved?.replace(/.tfplan$/, "-rest.tfplan"));
    const audit = s.deps.audit.entries;
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "cancelled server",
        target: `contabo server ${SERVER_ID}`,
        detail: "contract ends 2026-12-11",
      }),
    );
    expect(audit).toContainEqual(expect.objectContaining({ kind: "iac", action: "plan again" }));
    expect(s.deps.reporter.text()).toContain(
      `success: Cancelled the Contabo server ${SERVER_ID}: its contract ends on 2026-12-11.`,
    );
    // The end date is still read back after the apply.
    expect(s.deps.reporter.text()).toContain(
      "info: The Contabo server shop is cancelled: its contract ends on 11 December 2026",
    );
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });

  it("stops before the state is touched when the cancel fails: nothing is deleted", async () => {
    const s = await setup();
    s.servers.cancelError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 400.");
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: `OpsCrew could not cancel the Contabo server ${SERVER_ID}: Contabo answered HTTP 400. Nothing more was applied, and the infrastructure state is unchanged.`,
    });
    expect(s.events.filter((event) => !event.startsWith("plan:"))).toEqual([
      `power-off:${SERVER_ID}`,
      `cancel:${SERVER_ID}`,
    ]);
    expect(s.engine.calls).not.toContain("state-rm");
    expect(s.engine.applied).toEqual([]);
    expect(s.firewalls.firewalls.size).toBe(1);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeUndefined();
  });

  it("deletes the server's firewall after the apply that cancels the server, says and audits it", async () => {
    const s = await setup();
    await runDestroy(s.deps, { services: s.services });
    const teardown = s.events.filter(
      (event) => !event.startsWith("plan:") && !event.startsWith("secret:"),
    );
    expect(teardown).toEqual([
      `power-off:${SERVER_ID}`,
      `cancel:${SERVER_ID}`,
      "state-rm:module.server.contabo_instance.this",
      "apply:destroy",
      "remove shop-firewall",
    ]);
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

  it("deletes the firewall in the same run when Cloudflare refused only the tunnel, once the server is gone", async () => {
    const s = await setup(true);
    await runDestroy(s.deps, { services: s.services });
    const teardown = s.events.filter((event) =>
      ["power-off", "cancel", "state-rm", "apply:", "remove", "poll"].some((kind) =>
        event.startsWith(kind),
      ),
    );
    expect(teardown).toEqual([
      `power-off:${SERVER_ID}`,
      `cancel:${SERVER_ID}`,
      "state-rm:module.server.contabo_instance.this",
      "apply:destroy",
      "remove shop-firewall",
      "poll",
      "poll",
      "apply:destroy",
    ]);
    expect(s.firewalls.firewalls.size).toBe(0);
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
});
