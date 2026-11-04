/**
 * `opscrew vpn add` and `vpn remove` on an environment that sends to another environment's
 * monitoring server (feature 020): that server's interface for this network learns of the device.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork, type NetworkHostFacts } from "../network";
import { monitoredPlan, senderPlan, splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { recordGeneratedEntries } from "../shared/app-secrets";
import { updateServerAddresses } from "../shared/server-record";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  ScriptedApprovalHandler,
  testKeyMaker,
} from "../testing";
import { deviceConfigFile, vpnAdd, vpnRemove } from "./devices";
import type { VpnServices } from "./servers";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const PROD_IPV4 = "203.0.113.10";
const PROD_DATA_IPV4 = "203.0.113.30";
const MONITORING_IPV4 = "203.0.113.40";
const STAGING_IPV4 = "203.0.113.50";
const STAGING_DATA_IPV4 = "203.0.113.51";
const PUBLIC = [PROD_IPV4, PROD_DATA_IPV4, MONITORING_IPV4, STAGING_IPV4, STAGING_DATA_IPV4];

/** The monitoring server holds prod's network on wg-opscrew0. */
const MONITORING_HOST: NetworkHostFacts = {
  udpPortsInUse: [51820],
  wireguardInterfaces: ["wg-opscrew0"],
};

/** What inspection reads on a server OpsCrew created, with its WireGuard interfaces. */
function cloudFacts(wireguardInterfaces: string[] = []): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    wireguardInterfaces,
  });
}

/** `plan` deployed, on its private network, with the keys allocation made. */
function networked(plan: Omit<DeployPlan, "network">, facts: Record<string, NetworkHostFacts>) {
  const deployed = { ...plan, deployment: { ...plan.deployment, lastApplyAt: DEPLOYED_AT } };
  const made = allocateNetwork(deployed, facts, testKeyMaker(plan.app.name));
  return { plan: withNetwork(deployed, made.network), privateKeys: made.privateKeys };
}

/** The member `name` of `plan`'s network. */
const memberOf = (plan: DeployPlan, name: string) =>
  plan.network?.members.find((m) => m.name === name) as NonNullable<
    DeployPlan["network"]
  >["members"][number];

interface Apply {
  server: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/**
 * A repository whose prod owns the monitoring server (`monitoring`) and whose `environment` is
 * `plan`, with each environment's servers' addresses and keys on this computer, and fake shells and
 * host adapters per server name. The monitoring server has the interfaces `monitoringInterfaces`.
 */
async function repository(o: {
  plan: DeployPlan;
  privateKeys: Record<string, string>;
  environment?: string;
  owner?: DeployPlan | null;
  monitoringInterfaces?: string[];
}) {
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    clock: { now: () => NOW },
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  const prod =
    o.environment === undefined
      ? deps
      : await createTestPhaseDeps({ root: deps.paths.root, env: deps.env });
  const owner = o.owner === undefined ? ownerPlan().plan : o.owner;
  if (owner !== null && prod !== deps) await writeArtifact("plan", prod.paths.files.plan, owner);
  await updateServerAddresses(prod.paths, (current) => ({
    ...current,
    deployment: { ipv4: PROD_IPV4 },
    servers: { data: { ipv4: PROD_DATA_IPV4 }, monitoring: { ipv4: MONITORING_IPV4 } },
  }));
  await writeArtifact("plan", deps.paths.files.plan, o.plan);
  if (prod !== deps) {
    await updateServerAddresses(deps.paths, (current) => ({
      ...current,
      deployment: { ipv4: STAGING_IPV4 },
      servers: { data: { ipv4: STAGING_DATA_IPV4 } },
    }));
  }
  await recordGeneratedEntries(deps, "network", o.privateKeys);
  const applies: Apply[] = [];
  const inspected: { server: string; rootImage?: string }[] = [];
  const keys = testKeyMaker("device");
  const services: VpnServices = {
    remote: async (server) => ({
      host: server,
      run: async () => {
        throw new Error("the fake host adapter does the work");
      },
    }),
    host: {
      async inspect(remote, options) {
        inspected.push({ server: remote.host, ...options });
        return cloudFacts(
          remote.host === "monitoring"
            ? (o.monitoringInterfaces ?? ["wg-opscrew0", "wg-opscrew1"])
            : [],
        );
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ server: remote.host, plan, options });
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
    keys,
  };
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  return { deps, handler, applies, inspected, keys, services, plan };
}

type Repository = Awaited<ReturnType<typeof repository>>;

/** Prod: the split plan with a monitoring server of its own. */
function ownerPlan() {
  return networked(monitoredPlan(), {});
}

/** Staging: sends to prod's monitoring server, on its own interface there (wg-opscrew1). */
function staging() {
  return networked(senderPlan(), { monitoring: MONITORING_HOST });
}

/** The `network` step's params of a host plan. */
function networkStep(plan: HostPlan | undefined) {
  const params = plan?.steps.find((s) => s.id === "network")?.params ?? {};
  return {
    interface: params.interface,
    peers: JSON.parse(String(params.peers)) as { name: string }[],
  };
}

/** The `network-filter` step's rules of a host plan: `port=source,source …`. */
const filterRules = (plan: HostPlan | undefined) =>
  String(plan?.steps.find((s) => s.id === "network-filter")?.params.rules);

/**
 * No private key in what OpsCrew showed, audited or asked, the result or the host plans, and no
 * public address in the first three (a host plan's peers name their endpoints).
 */
function expectNoLeak(r: Repository, result: unknown, keys: readonly string[]): void {
  const shown = [
    r.deps.reporter.text(),
    JSON.stringify(r.deps.audit.entries),
    JSON.stringify(r.handler.requests),
    JSON.stringify(result),
  ].join("\n");
  const plans = JSON.stringify(r.applies.map((a) => a.plan));
  for (const key of keys) {
    expect(shown).not.toContain(key);
    expect(plans).not.toContain(key);
  }
  for (const address of PUBLIC) expect(shown).not.toContain(address);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("opscrew vpn on an environment that sends to another environment's monitoring server", () => {
  it("vpn add also gives the monitoring server's interface for this network the device, over its owner's login, approved by its hash", async () => {
    const { plan, privateKeys } = staging();
    const r = await repository({ plan, privateKeys, environment: "staging" });

    const result = await vpnAdd(r.deps, "laptop", { services: r.services });

    const pair = r.keys.made[0];
    if (pair === undefined) throw new Error("no key was made");
    // Staging's servers, then the monitoring server, each shown and approved by its own hash.
    expect(r.handler.requests.map((q) => q.kind)).toEqual([
      "host-apply",
      "host-apply",
      "host-apply",
    ]);
    expect(r.handler.requests[2]?.title).toMatch(/server monitoring /);
    expect(r.applies.map((a) => [a.server, a.plan.app])).toEqual([
      ["app", "shop-staging"],
      ["data", "shop-staging"],
      ["monitoring", "shop-staging"],
    ]);
    expect(result.hostPlanHashes).toEqual(r.applies.map((a) => hostPlanHash(a.plan)));
    // The monitoring server was reached with prod's login: the deploy user, root through Docker.
    expect(r.inspected.at(-1)).toEqual({ server: "monitoring", rootImage: IMAGES.caddy.ref });

    // Its interface for staging's network: the device is a peer, and Grafana admits it.
    const [, , monitoring] = r.applies;
    const device = (await r.plan()).network?.devices.find((d) => d.name === "laptop");
    const self = memberOf(plan, "monitoring");
    expect(monitoring?.plan.steps.map((s) => s.id)).toEqual(["network", "network-filter"]);
    const step = networkStep(monitoring?.plan);
    expect(step.interface).toBe("wg-opscrew1");
    expect(step.peers).toContainEqual({
      name: "laptop",
      publicKey: pair.publicKey,
      allowedIp: `${device?.address}/32`,
    });
    expect(filterRules(monitoring?.plan)).toContain(
      `${MONITORING_GRAFANA_PORT}=${device?.address}`,
    );
    expect(filterRules(monitoring?.plan)).toContain(`${MONITORING_PUSH_PORT}=`);
    // Its key is staging's, from staging's generated values, passed only on apply.
    expect(monitoring?.options.secrets).toEqual({ wireguardKey: privateKeys.monitoring });

    // The device's configuration has the monitoring server as a peer.
    const config = await readFile(deviceConfigFile(r.deps.paths, "laptop"), "utf8");
    expect(config).toContain(`AllowedIPs = ${self.address}/32`);

    // The output says where Grafana is, and that it shows every environment.
    expect(r.deps.reporter.text()).toContain(
      `Device laptop also reaches Grafana on server monitoring of opscrew/plan.yaml, at http://${self.address}:${MONITORING_GRAFANA_PORT}: it sees the dashboards of every environment there, as Grafana has one login for all of them.`,
    );
    expect((await r.plan()).approvals.map((a) => a.kind)).toEqual([
      "host-apply",
      "host-apply",
      "host-apply",
    ]);

    expectNoLeak(r, result, [pair.privateKey, ...Object.values(privateKeys)]);
  });

  it("vpn remove also takes the device off the monitoring server's interface for this network", async () => {
    const base = staging();
    const r = await repository({ ...base, environment: "staging" });
    await vpnAdd(r.deps, "laptop", { services: r.services });
    const added = r.applies.length;
    r.deps.reporter.lines.length = 0;

    const result = await vpnRemove(r.deps, "laptop", { services: r.services });

    const removed = r.applies.slice(added);
    expect(removed.map((a) => a.server)).toEqual(["app", "data", "monitoring"]);
    expect(result.hostPlanHashes).toEqual(removed.map((a) => hostPlanHash(a.plan)));
    const monitoring = removed[2];
    expect(networkStep(monitoring?.plan).peers.map((p) => p.name)).not.toContain("laptop");
    expect(filterRules(monitoring?.plan)).toContain(`${MONITORING_GRAFANA_PORT}=`);
    expect(filterRules(monitoring?.plan)).not.toMatch(new RegExp(`${MONITORING_GRAFANA_PORT}=\\d`));
    expect((await r.plan()).network?.devices).toEqual([]);

    expectNoLeak(r, result, Object.values(base.privateKeys));
  });

  it("leaves the monitoring server alone until provision has joined it, as before monitoring", async () => {
    const { plan, privateKeys } = staging();
    const r = await repository({
      plan,
      privateKeys,
      environment: "staging",
      monitoringInterfaces: ["wg-opscrew0"],
    });

    await vpnAdd(r.deps, "laptop", { services: r.services });

    expect(r.applies.map((a) => a.server)).toEqual(["app", "data"]);
    expect(r.deps.reporter.text()).not.toContain("Grafana");
  });

  it("refuses before any change when the owner's plan no longer runs the monitoring server", async () => {
    const { plan, privateKeys } = staging();
    const r = await repository({ plan, privateKeys, environment: "staging", owner: null });
    const before = await readFile(r.deps.paths.files.plan, "utf8");

    const error = await failure(vpnAdd(r.deps, "laptop", { services: r.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "This environment sends to server monitoring of opscrew/plan.yaml, but that plan is gone. Nothing was changed.",
    );
    expect(r.applies).toEqual([]);
    expect(r.keys.made).toEqual([]);
    expect(await readFile(r.deps.paths.files.plan, "utf8")).toBe(before);
    expect(existsSync(deviceConfigFile(r.deps.paths, "laptop"))).toBe(false);

    const removal = await failure(vpnRemove(r.deps, "laptop", { services: r.services }));
    expect(removal.code).toBe("INVALID_INPUT");
  });

  it("refuses vpn remove before any change when the owner's plan no longer runs the monitoring server", async () => {
    const base = staging();
    const r = await repository({ ...base, environment: "staging" });
    await vpnAdd(r.deps, "laptop", { services: r.services });
    const added = r.applies.length;
    // Prod turned monitoring off: its plan has no monitoring server any more.
    const prod = await createTestPhaseDeps({ root: r.deps.paths.root, env: r.deps.env });
    await writeArtifact("plan", prod.paths.files.plan, networked(splitPlan(), {}).plan);
    const before = await readFile(r.deps.paths.files.plan, "utf8");

    const error = await failure(vpnRemove(r.deps, "laptop", { services: r.services }));

    expect(error.message).toBe(
      "This environment sends to server monitoring of opscrew/plan.yaml, but that plan no longer runs it as its monitoring server. Nothing was changed.",
    );
    expect(r.applies).toHaveLength(added);
    expect(await readFile(r.deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("on the owner's plan, changes its own monitoring server as one of its servers, as before", async () => {
    const { plan, privateKeys } = ownerPlan();
    const r = await repository({ plan, privateKeys });

    await vpnAdd(r.deps, "laptop", { services: r.services });

    expect(r.applies.map((a) => [a.server, a.plan.app])).toEqual([
      ["app", "shop"],
      ["data", "shop"],
      ["monitoring", "shop"],
    ]);
    expect(networkStep(r.applies[2]?.plan).interface).toBe("wg-opscrew0");
    expect(r.deps.reporter.text()).not.toContain("every environment");
  });
});
