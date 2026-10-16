import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureStatePassphrase } from "../shared";
import {
  BUSY_TUNNEL_LOG,
  FAKE_TUNNEL,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import { TUNNEL_RESOURCE_TYPE } from "../shared/tunnel-connections";
import {
  createProject,
  createTestPhaseDeps,
  deployedResources,
  FakeDestroyGitHub,
  FakeServers,
  fakeCloudflare,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  testPlan,
} from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

/** The second tunnel a destroy plan may delete (synthetic id, same account as the app's). */
const SECOND_TUNNEL_ID = "0b5e8c1d-2f3a-4b5c-8d9e-aabbccddeeff";
const SECOND_TUNNEL_CHANGE: ResourceChange = {
  address: `module.portainer_tunnel.${TUNNEL_RESOURCE_TYPE}.this`,
  type: TUNNEL_RESOURCE_TYPE,
  name: "this",
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action: "delete",
};

/** The plan JSON with the second tunnel's own id (the fixture gives every tunnel the app's). */
function withSecondTunnelId(planJson: ReturnType<typeof tunnelDeletePlanJson>) {
  return {
    ...planJson,
    resource_changes: planJson.resource_changes.map((entry) =>
      entry.address === SECOND_TUNNEL_CHANGE.address
        ? {
            ...entry,
            change: {
              ...entry.change,
              before: { id: SECOND_TUNNEL_ID, account_id: FAKE_TUNNEL.accountId, name: "webhook" },
            },
          }
        : entry,
    ),
  };
}

/**
 * A DigitalOcean deployment with Portainer on a subdomain: its destroy plan deletes the Droplet
 * and the tunnel (with its record and Access). The first apply can fail with Cloudflare's 1022
 * after deleting everything else, as when the connector's connections outlast the Droplet.
 */
async function deployed(
  o: {
    /** Polls that still report connections after the Droplet is gone. */
    closeAfter?: number;
    /** The connections never close. */
    never?: boolean;
    /** Refuse the second `iac-apply` approval (the tunnel-only plan). */
    refuseTunnelPlan?: boolean;
    /** What the plan for what is left deletes besides the tunnel. */
    alsoLeft?: ResourceChange[];
    /** The destroy plan also deletes a second tunnel, `module.portainer_tunnel` (its own id). */
    secondTunnel?: boolean;
  } = {},
) {
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
    {
      resources: [
        ...deployedResources({ provider: "digitalocean" }),
        ...tunnelDeletes(),
        ...(o.secondTunnel === true ? [SECOND_TUNNEL_CHANGE] : []),
      ],
    },
    events,
  );
  // The plan JSON names each tunnel's id and account, as tofu writes it.
  const innerPlan = engine.plan.bind(engine);
  engine.plan = async (dir, planFile, options) => {
    const summary = await innerPlan(dir, planFile, options);
    return options?.destroy
      ? { ...summary, planJson: withSecondTunnelId(tunnelDeletePlanJson(summary.changes)) }
      : summary;
  };
  // The first apply: everything but the tunnel is deleted, then Cloudflare refuses it (1022).
  let busy = true;
  const innerApply = engine.apply.bind(engine);
  engine.apply = async (dir, planFile, approval) => {
    if (!busy) return innerApply(dir, planFile, approval);
    busy = false;
    events.push("apply:destroy");
    engine.script.resources = [
      ...tunnelDeletes().filter((c) => c.type === TUNNEL_RESOURCE_TYPE),
      ...(o.alsoLeft ?? []),
    ];
    return { ok: false, outputs: {}, log: BUSY_TUNNEL_LOG };
  };
  let iacApprovals = 0;
  const handler = new ScriptedApprovalHandler((request: ApprovalRequest) => {
    events.push(`approval:${request.kind}`);
    if (request.kind === "iac-apply") iacApprovals++;
    return !(o.refuseTunnelPlan === true && request.kind === "iac-apply" && iacApprovals === 2);
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
  const api = fakeTunnelApi({
    events,
    connectorRunning: () => false,
    ...(o.closeAfter !== undefined ? { closeAfter: o.closeAfter } : {}),
    ...(o.never !== undefined ? { never: o.never } : {}),
  });
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
  return { ...project, deps, engine, events, services, handler, api };
}

/** The events from the first (refused) apply on, without the preview's and cleanup's. */
function afterFirstApply(events: readonly string[]): string[] {
  const from = events.indexOf("apply:destroy");
  return events
    .slice(from)
    .filter((e) => ["approval:iac-apply", "poll", "plan:destroy", "apply:destroy"].includes(e));
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))(
  "opscrew destroy on DigitalOcean with Portainer's tunnel",
  () => {
    it("a 1022 after the Droplet is deleted: the same run waits, shows the tunnel-only plan and finishes", async () => {
      const s = await deployed({ closeAfter: 2 });
      const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
      expect(afterFirstApply(s.events)).toEqual([
        "apply:destroy",
        "poll",
        "poll",
        "poll",
        "plan:destroy",
        "approval:iac-apply",
        "apply:destroy",
      ]);
      // The tunnel-only plan has its own approval: allowDestroy and the typed app name.
      const requests = s.handler.requests.filter((r) => r.kind === "iac-apply");
      expect(requests).toHaveLength(2);
      const tunnelOnly = requests[1];
      expect(tunnelOnly).toMatchObject({
        title: "Delete the Cloudflare Tunnel of shop (1 resource to delete)",
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      expect(tunnelOnly?.planHash).not.toBe(requests[0]?.planHash);
      expect(tunnelOnly?.details).toContain(
        "  - delete  module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
      );
      expect(tunnelOnly?.details).toContain(
        "The Droplet is deleted already; Cloudflare reports no active connections for the tunnel now, so this plan deletes what is left.",
      );
      expect(tunnelOnly?.details).toContain(`Plan hash: ${tunnelOnly?.planHash}`);
      expect(s.engine.applied.at(-1)?.approval).toEqual({
        approvedPlanHash: tunnelOnly?.planHash,
        allowDestroy: true,
      });
      expect(result.destroyed.map((c) => c.type)).toContain("digitalocean_droplet");
      expect(result.destroyed.map((c) => c.type)).toContain(TUNNEL_RESOURCE_TYPE);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.deployment.destroyedAt).toBeDefined();
      expect(plan.approvals.slice(-2).map((a) => a.planHash)).toEqual(
        requests.map((r) => r.planHash),
      );
      const text = s.deps.reporter.text();
      expect(text).toContain(
        "The Droplet is deleted, but Cloudflare refused to delete the app's Cloudflare Tunnel while it still had active connections (they can outlast the Droplet for a few minutes). OpsCrew waits until they close, then shows the plan that deletes the tunnel.",
      );
      expect(text).not.toContain("1022");
      // What the second approval covers is printed, too (the typed name may approve it in the CLI).
      expect(text).toContain(
        "The plan for what is left deletes these resources:\n  - delete  module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
      );
    });

    it("connections that never close: the plain message, and the rerun waits and deletes the tunnel", async () => {
      const s = await deployed({ never: true });
      const error = await failure(runDestroy(s.deps, { services: s.services, snapshot: false }));
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
      // It waited after the Droplet was gone, and planned nothing more.
      expect(afterFirstApply(s.events).slice(0, 2)).toEqual(["apply:destroy", "poll"]);
      expect(afterFirstApply(s.events)).not.toContain("plan:destroy");
      expect(s.handler.requests.filter((r) => r.kind === "iac-apply")).toHaveLength(1);

      s.events.length = 0;
      s.deps.fetch = fakeTunnelApi({ events: s.events, connectorRunning: () => false }).fetch;
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

    it("a 1022 with two tunnels in the plan: it waits for each, and stops plainly while the second stays connected", async () => {
      const s = await deployed({ secondTunnel: true });
      // The app's tunnel has closed; the one in front of Portainer's webhook keeps its connection.
      const read: string[] = [];
      s.deps.fetch = async (url) => {
        const id = /\/cfd_tunnel\/([^/?]+)/.exec(String(url))?.[1] ?? "";
        read.push(id);
        s.events.push("poll");
        const active = id === SECOND_TUNNEL_ID;
        return Response.json({
          success: true,
          errors: [],
          result: {
            id,
            status: active ? "healthy" : "down",
            connections: active ? [{ id: "conn-1", colo_name: "fra" }] : [],
          },
        });
      };
      const error = await failure(runDestroy(s.deps, { services: s.services, snapshot: false }));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. The Droplet is deleted; the Cloudflare Tunnel is still there.",
      );
      expect(error.hint).toBe(
        "Run `opscrew destroy` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.",
      );
      // Both tunnels were read, the app's first; the second until the wait gave up.
      expect(read[0]).toBe(FAKE_TUNNEL.tunnelId);
      expect(new Set(read)).toEqual(new Set([FAKE_TUNNEL.tunnelId, SECOND_TUNNEL_ID]));
      expect(read.filter((id) => id === SECOND_TUNNEL_ID).length).toBeGreaterThan(1);
      // Nothing more was planned, approved or applied.
      expect(afterFirstApply(s.events)).not.toContain("plan:destroy");
      expect(s.events.filter((e) => e === "apply:destroy")).toHaveLength(1);
      expect(s.handler.requests.filter((r) => r.kind === "iac-apply")).toHaveLength(1);
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeUndefined();
    });

    it("a refused tunnel-only plan deletes nothing more and says how to finish", async () => {
      const s = await deployed({ refuseTunnelPlan: true });
      const error = await failure(runDestroy(s.deps, { services: s.services, snapshot: false }));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toBe(
        "The deletion of the app's Cloudflare Tunnel was not approved. The Droplet is deleted; the Cloudflare Tunnel is still there.",
      );
      expect(error.hint).toBe(
        "Run `opscrew destroy` again and type shop when you are ready (in a script: `opscrew destroy --confirm shop`); it deletes what is left.",
      );
      // One apply only (the Droplet's); the tunnel-only plan was shown and not applied.
      expect(s.events.filter((e) => e === "apply:destroy")).toHaveLength(1);
      expect(afterFirstApply(s.events)).toEqual([
        "apply:destroy",
        "poll",
        "plan:destroy",
        "approval:iac-apply",
      ]);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.deployment.destroyedAt).toBeUndefined();
      // The refused plan is discarded, so it can never be applied later.
      const tunnelOnly = s.handler.requests.filter((r) => r.kind === "iac-apply")[1];
      expect(tunnelOnly).toBeDefined();
      expect(existsSync(s.engine.planFiles.at(-1) as string)).toBe(false);
    });

    /** Runs a destroy whose plan for what is left also has `alsoLeft`: the guard must stop it. */
    async function guarded(alsoLeft: ResourceChange[]) {
      const s = await deployed({ alsoLeft });
      const error = await failure(runDestroy(s.deps, { services: s.services, snapshot: false }));
      expect(error.code).toBe("PHASE_PRECONDITION");
      // Planned, never shown for approval, never applied; the plan file is gone.
      expect(afterFirstApply(s.events)).toEqual(["apply:destroy", "poll", "plan:destroy"]);
      expect(s.events.filter((e) => e === "apply:destroy")).toHaveLength(1);
      expect(s.handler.requests.filter((r) => r.kind === "iac-apply")).toHaveLength(1);
      expect(existsSync(s.engine.planFiles.at(-1) as string)).toBe(false);
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeUndefined();
      expect(s.deps.reporter.text()).not.toContain(
        "The plan for what is left deletes these resources:",
      );
      return error;
    }

    it("the plan for what is left may not delete an address that was not confirmed", async () => {
      const error = await guarded([
        {
          address: "module.extra.cloudflare_dns_record.other",
          type: "cloudflare_dns_record",
          name: "other",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "delete",
        },
      ]);
      expect(error.message).toBe(
        [
          "The plan for what is left would do more than delete what you confirmed, so OpsCrew stopped before applying it. The Droplet is deleted; the Cloudflare Tunnel is still there.",
          "  delete module.extra.cloudflare_dns_record.other",
        ].join("\n"),
      );
    });

    it("the plan for what is left may not delete a Droplet, and claims nothing about it", async () => {
      const droplets = deployedResources({ provider: "digitalocean" }).filter(
        (c) => c.type === "digitalocean_droplet",
      );
      expect(droplets).toHaveLength(1);
      const error = await guarded(droplets);
      expect(error.message).toBe(
        [
          "The plan for what is left would do more than delete what you confirmed, so OpsCrew stopped before applying it.",
          `  delete ${droplets[0]?.address} (a Droplet: this plan may delete only what is left of the tunnel)`,
        ].join("\n"),
      );
      expect(error.message).not.toContain("is deleted");
    });
  },
);
