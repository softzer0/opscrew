import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  fakeCloudflare,
  projectRunner,
  testPlan,
} from "../provision/__fixtures__/fakes";
import { ensureStatePassphrase } from "../shared";
import {
  BUSY_TUNNEL_LOG,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import { TUNNEL_RESOURCE_TYPE } from "../shared/tunnel-connections";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import {
  deployedResources,
  FakeDestroyGitHub,
  FakeServers,
  ScriptedDestroyEngine,
} from "./__fixtures__/fakes";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

/**
 * A DigitalOcean deployment with Portainer on a subdomain: its destroy plan deletes the Droplet
 * and the tunnel (with its record and Access). The first apply can fail with Cloudflare's 1022
 * after deleting everything else, as when the connector's connections outlast the Droplet.
 */
async function deployed() {
  const events: string[] = [];
  const base = testPlan({ provider: "digitalocean", domain: "shop.example.com", deployed: true });
  const plan = {
    ...base,
    dns: { ...base.dns, zone: "example.com" },
    portainer: {
      enabled: true,
      version: "2.45.2",
      access: "subdomain" as const,
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    },
  };
  const project = await createProject(plan);
  const engine = new ScriptedDestroyEngine(
    { resources: [...deployedResources({ provider: "digitalocean" }), ...tunnelDeletes()] },
    events,
  );
  // The plan JSON names the tunnel's id and account, as tofu writes it.
  const innerPlan = engine.plan.bind(engine);
  engine.plan = async (dir, planFile, options) => {
    const summary = await innerPlan(dir, planFile, options);
    return options?.destroy
      ? { ...summary, planJson: tunnelDeletePlanJson(summary.changes) }
      : summary;
  };
  // The first apply: everything but the tunnel is deleted, then Cloudflare refuses it (1022).
  let busy = true;
  const innerApply = engine.apply.bind(engine);
  engine.apply = async (dir, planFile, approval) => {
    if (!busy) return innerApply(dir, planFile, approval);
    busy = false;
    events.push("apply:destroy");
    engine.script.resources = tunnelDeletes().filter((c) => c.type === TUNNEL_RESOURCE_TYPE);
    return { ok: false, outputs: {}, log: BUSY_TUNNEL_LOG };
  };
  const handler = new ScriptedApprovalHandler((request: ApprovalRequest) => {
    events.push(`approval:${request.kind}`);
    return true;
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: undefined,
    DIGITALOCEAN_TOKEN: fakeSecret("digitalocean-token"),
    CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token", "destroy-cloud"),
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };
  const api = fakeTunnelApi({ events, connectorRunning: () => false });
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    fetch: api.fetch,
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await writeFile(
    join(project.root, plan.infra.dir, "variables.tf"),
    'variable "app_name" {\n  type = string\n}\n',
  );
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers(events, "digitalocean"),
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(events),
    sleep: async () => undefined,
  };
  return { ...project, deps, engine, events, services };
}

describe.skipIf(!findExecutable("git"))(
  "opscrew destroy on DigitalOcean with Portainer's tunnel",
  () => {
    it("a 1022 says the Droplet is deleted and the tunnel is not; the rerun waits and deletes the tunnel", async () => {
      const s = await deployed();
      const error = (await runDestroy(s.deps, { services: s.services, snapshot: false }).catch(
        (e: unknown) => e,
      )) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. The Droplet is deleted; the Cloudflare Tunnel is still there.",
      );
      expect(error.hint).toBe(
        "Run `opscrew destroy` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.",
      );
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeUndefined();
      // The first apply did not wait: the connector went with the Droplet in that same apply.
      expect(s.events).not.toContain("poll");

      s.events.length = 0;
      const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
      const order = s.events.filter((e) =>
        ["approval:iac-apply", "poll", "apply:destroy"].includes(e),
      );
      expect(order).toEqual(["approval:iac-apply", "poll", "apply:destroy"]);
      expect(result.destroyed.map((c) => c.type)).toEqual([TUNNEL_RESOURCE_TYPE]);
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeDefined();
    });
  },
);
