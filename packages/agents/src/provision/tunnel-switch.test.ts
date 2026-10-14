import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyOptions, HostPlan } from "@opscrew/connector-ssh-host";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PortainerServices } from "../portainer";
import { recordOwnServer } from "../shared";
import { deleteTunnelIn, fakeTunnelApi, ORIGIN_IP } from "../shared/__fixtures__/tunnel";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { createProject, FakeGitHub } from "./__fixtures__/fakes";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakeZeroTrust,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  publicOutputs,
  TUNNEL_ID,
  tunnelOutputs,
} from "./__fixtures__/own";
import { runProvision } from "./run";

/**
 * An own server that served the app through the tunnel (its connector runs; the state holds the
 * tunnel) and whose plan now serves it directly. `events` lists approvals, host applies, polls of
 * Cloudflare's tunnel API and engine applies in order.
 */
async function switchToPublic(o: { closeAfter?: number; never?: boolean } = {}) {
  const events: string[] = [];
  const project = await createProject(ownPlan({ access: "public" }));
  const token = `eyJ${fakeSecret("cloudflare-token", "switch-back")}`;
  const engine = deleteTunnelIn(
    new OwnEngine(
      PUBLIC_CHANGES,
      publicOutputs(),
      tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-secret-x" }),
    ),
    events,
    (options, summary) => options?.destroy === true && summary.changes.length > 0,
  );
  const facts = structuredClone(freshFacts());
  facts.tunnel = {
    installed: true,
    composeSha256: "0".repeat(64),
    running: true,
    secretFile: true,
    dataVolume: false,
    tunnelId: TUNNEL_ID,
  };
  const host = new FakeHostServer(HostFactsSchema.parse(facts));
  let answer = (_request: ApprovalRequest): boolean => true;
  const handler = new ScriptedApprovalHandler((request) => {
    events.push(`approve:${request.kind}`);
    return answer(request);
  });
  const home = await mkdtemp(join(tmpdir(), "opscrew-switch-home-"));
  const apiToken = fakeSecret("cloudflare-token", "switch-api");
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: apiToken,
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const api = fakeTunnelApi({
    events,
    connectorRunning: () => host.facts.tunnel.running,
    ...(o.closeAfter !== undefined ? { closeAfter: o.closeAfter } : {}),
    ...(o.never !== undefined ? { never: o.never } : {}),
  });
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
    fetch: api.fetch,
  });
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
    hostKey: ED25519_FINGERPRINT,
  });
  // The last run applied tunnel mode: its state is on this computer.
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
  const adapter = {
    inspect: (remote: RemoteExec) => host.inspect(remote),
    apply: async (remote: RemoteExec, plan: HostPlan, options: ApplyOptions) => {
      events.push("host");
      return host.apply(remote, plan, options);
    },
  };
  const services: PortainerServices = {
    engine: async () => engine,
    github: new FakeGitHub(),
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host: adapter, zeroTrust: fakeZeroTrust(), homeDir: home },
    accessLoginMethods: { oneTimePin: async () => undefined },
  };
  return {
    ...project,
    deps,
    engine,
    host,
    handler,
    services,
    events,
    apiToken,
    answer: (next: (request: ApprovalRequest) => boolean) => {
      answer = next;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const SWITCHED =
  "Your server is switched to serving the app directly on its public address already (its Cloudflare Tunnel connector is removed); the current setup's Cloudflare resources are still there, so the app is unreachable until the switch finishes.";

describe.skipIf(!findExecutable("git"))(
  "switching an own server from the tunnel to serving directly",
  () => {
    it("approves the removal and the host plan first, removes the connector, waits, then removes the tunnel", async () => {
      const s = await switchToPublic({ closeAfter: 1 });
      await runProvision(s.deps, { services: s.services });
      expect(s.events.slice(0, 7)).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host",
        "poll",
        "poll",
        "iac-apply",
        "approve:repo-write",
      ]);
      // Then the new setup's plan; its host plan finds the server prepared already.
      expect(s.events.slice(7, 9)).toEqual(["approve:iac-apply", "iac-apply"]);
      expect(s.events.filter((e) => e === "host")).toHaveLength(1);
      expect(s.host.facts.tunnel.running).toBe(false);
      const connector = s.host.applies[0]?.plan.steps.find(
        (step) => step.id === "tunnel-connector",
      );
      expect(connector?.state).toBe("change");
      expect(connector?.params.remove).toBe(true);
      expect(s.engine.applies.map((a) => a.destroy)).toEqual([true, false]);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.approvals.map((a) => a.kind)).toEqual(["iac-apply", "host-apply", "iac-apply"]);
      expect(plan.deployment.lastApplyAt).toBeDefined();
      const printed = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
      expect(printed).not.toContain(ORIGIN_IP);
      expect(printed).not.toContain(s.apiToken);
    });

    it("connections that never close: stops before the removal, and a rerun continues", async () => {
      const s = await switchToPublic({ never: true });
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        `Cloudflare still reports active connections for the app's Cloudflare Tunnel after 3 minutes, so OpsCrew stopped before deleting it. Nothing in Cloudflare was deleted. ${SWITCHED}`,
      );
      expect(error.hint).toBe(
        "Run `opscrew provision` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.",
      );
      expect(s.engine.applies).toHaveLength(0);
      expect(s.events).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host",
        ...Array.from({ length: 37 }, () => "poll"),
      ]);

      s.events.length = 0;
      s.deps.fetch = fakeTunnelApi({ events: s.events, connectorRunning: () => false }).fetch;
      await runProvision(s.deps, { services: s.services });
      // The server has the change already: no host approval; the removal, then the new setup.
      expect(s.events.slice(0, 3)).toEqual(["approve:iac-apply", "poll", "iac-apply"]);
      expect(s.events.filter((e) => e === "host")).toHaveLength(0);
      expect(s.engine.applies.map((a) => a.destroy)).toEqual([true, false]);
    });

    it("turns Cloudflare's error 1022 into the plain message", async () => {
      const s = await switchToPublic();
      s.engine.busy();
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        `Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. ${SWITCHED}`,
      );
    });

    it("a refused host plan changes nothing on the server or in Cloudflare", async () => {
      const s = await switchToPublic();
      s.answer((request) => request.kind !== "host-apply");
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toBe(
        "The host plan was not approved. Nothing on your server was changed and nothing in Cloudflare was deleted.",
      );
      expect(s.events).toEqual(["approve:iac-apply", "approve:host-apply"]);
      expect(s.host.facts.tunnel.running).toBe(true);
    });

    it("--plan-only shows the removal and the host plan; approving both applies the host plan first", async () => {
      const s = await switchToPublic();
      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(planned.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.events).toEqual([]);
      expect(s.deps.reporter.text()).toContain(
        `After this removal and the host plan are applied (\`opscrew provision --approve ${planned.planHash} --approve ${planned.hostPlanHash}\`, typing the app name to confirm; the host plan goes first, because Cloudflare deletes the tunnel only after its connector on your server has stopped), run \`opscrew provision\` again for the plan of the new setup.`,
      );

      await runProvision(s.deps, {
        services: s.services,
        approvePlanHashes: [planned.planHash as string, planned.hostPlanHash as string],
      });
      expect(s.events.slice(0, 5)).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host",
        "poll",
        "iac-apply",
      ]);
      expect(s.host.applies[0]?.options.approvedHash).toBe(planned.hostPlanHash);
      expect(s.engine.applies[0]?.planFile.endsWith("-removal.tfplan")).toBe(true);
    });
  },
);
