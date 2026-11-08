// Feature 025 (T2510): the private network's keys, the devices' and their logins (US5, FR-2508).
import { existsSync } from "node:fs";
import { readFile, stat, utimes } from "node:fs/promises";
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
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  type Network,
  networkInterface,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { deployed } from "../monitoring/__fixtures__/world";
import { allocateNetwork } from "../network";
import {
  monitoredPlan,
  networked as networkedPlan,
  senderPlan,
  splitPlan,
  withNetwork,
} from "../network/__fixtures__/plans";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { PlanRefusedError } from "../shared/approvals";
import { readValidJson } from "../shared/files";
import { serverAddressesFile, updateServerAddresses } from "../shared/server-record";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  ScriptedApprovalHandler,
  testKeyMaker,
  testKeyPair,
  testPlan,
} from "../testing";
import { deviceConfigFile } from "../vpn/devices";
import type { VpnServices } from "../vpn/servers";
import { rotateDevice, rotateNetwork } from "./network";
import { rotateGrant } from "./network-grant";
import { credentialsRecordFile } from "./record";
import type { RotateServicesOptions } from "./server";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const APP_IPV4 = "203.0.113.10";
const DATA_IPV4 = "203.0.113.30";
const MONITORING_IPV4 = "203.0.113.40";
/** A device login's password made by an earlier `vpn grant`. */
const OLD_GRANT = fakeSecret("generic-password", "laptop-db");

type Grant = Network["grants"][number];

/** The first three numbers of the network's range: `10.20x.y`. */
function prefixOf(plan: Pick<DeployPlan, "network">): string {
  return (plan.network?.range ?? "").split(".").slice(0, 3).join(".");
}

/**
 * `base` deployed on its network, with the devices laptop (`.100`) and phone (`.101`), `grants`
 * and `extra`, and the servers' private keys.
 */
function networked(
  base: Omit<DeployPlan, "network">,
  grants: Grant[] = [],
  extra: Partial<Network> = {},
) {
  const deployed = { ...base, deployment: { ...base.deployment, lastApplyAt: DEPLOYED_AT } };
  const { network, privateKeys } = allocateNetwork(deployed, {}, testKeyMaker("server"));
  const prefix = prefixOf({ network });
  const devices = ["laptop", "phone"].map((name, i) => ({
    name,
    address: `${prefix}.${100 + i}`,
    publicKey: testKeyPair(name).publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  }));
  return {
    plan: withNetwork(deployed, { ...network, devices, grants, ...extra }),
    privateKeys,
  };
}

/**
 * The private network's facts of a server whose interface `iface` holds `publicKey`, if any, with
 * the peers' keys `peers`.
 */
function networkFacts(
  iface: string,
  publicKey: string | undefined,
  peers: readonly string[],
): HostFacts["network"] {
  return {
    dropIn: null,
    interfaces:
      publicKey === undefined
        ? []
        : [
            {
              name: iface,
              config: "0".repeat(64),
              publicKey,
              enabled: true,
              active: true,
              addresses: [],
              peers: [...peers],
            },
          ],
    filterUnit: null,
    filters: [],
  };
}

interface Apply {
  server: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/**
 * A deployed project with `plan` (in `environment`, default prod; with `owner`, prod's plan that owns
 * the monitoring server `plan` sends to), the servers' addresses and private keys on this computer,
 * and fake hosts: each server's interface holds the key its member names and the others' and the
 * devices' as peers, until an apply of its `network` step gives it the step's.
 */
async function world(o: {
  plan: DeployPlan;
  privateKeys: Record<string, string>;
  answer?: (request: { kind: string; title: string }) => boolean;
  held?: Record<string, string | undefined>;
  grants?: Record<string, string>;
  environment?: string;
  owner?: DeployPlan;
}) {
  /** The servers whose next apply fails, as a lost connection would. */
  const failNext = new Set<string>();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    clock: { now: () => NOW },
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  if (o.owner !== undefined) {
    const prod = await createTestPhaseDeps({ root: deps.paths.root, env: deps.env });
    await writeArtifact("plan", prod.paths.files.plan, o.owner);
    await updateServerAddresses(prod.paths, (current) => ({
      ...current,
      deployment: { ipv4: "203.0.113.20" },
      servers: { data: { ipv4: "203.0.113.21" }, monitoring: { ipv4: MONITORING_IPV4 } },
    }));
  }
  await writeArtifact("plan", deps.paths.files.plan, o.plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: APP_IPV4 },
    ...((o.plan.servers ?? []).length > 0 ? { servers: { data: { ipv4: DATA_IPV4 } } } : {}),
  }));
  await recordGeneratedEntries(deps, "network", o.privateKeys);
  if (o.grants !== undefined) await recordGeneratedEntries(deps, "grants", o.grants);
  const held: Record<string, string | undefined> = Object.fromEntries(
    (o.plan.network?.members ?? []).map((m) => [m.name, m.publicKey]),
  );
  Object.assign(held, o.held);
  const members = o.plan.network?.members ?? [];
  const peers: Record<string, string[]> = Object.fromEntries(
    members.map((m) => [
      m.name,
      [
        ...members.filter((other) => other.name !== m.name).map((other) => other.publicKey),
        ...(o.plan.network?.devices ?? []).map((d) => d.publicKey),
      ],
    ]),
  );
  const applies: Apply[] = [];
  const keys = testKeyMaker("rotated");
  const services: VpnServices = {
    remote: async (server) => ({
      host: server,
      run: async () => {
        throw new Error("the fake host adapter does the work");
      },
    }),
    host: {
      async inspect(remote) {
        const member = members.find((m) => m.name === remote.host);
        const iface = member === undefined ? "wg-opscrew0" : networkInterface(member);
        return HostFactsSchema.parse({
          ...freshFacts({ user: "deploy", privilege: "docker" }),
          wireguardInterfaces: [...new Set(["wg-opscrew0", iface])],
          network: networkFacts(iface, held[remote.host], peers[remote.host] ?? []),
        });
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        if (failNext.delete(remote.host)) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `Server ${remote.host} did not answer over SSH.`,
          );
        }
        applies.push({ server: remote.host, plan, options });
        const network = plan.steps.find((s) => s.id === "network" && s.state === "change");
        if (network !== undefined) {
          held[remote.host] = String(network.params.publicKey);
          peers[remote.host] = peersOf(plan).map((p) => p.publicKey);
        }
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
    keys,
  };
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  const generated = async () =>
    (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const record = async () =>
    (await readArtifact("credentials", credentialsRecordFile(deps.paths))).environments[
      deps.paths.environment
    ] ?? {};
  /** The servers' rotation's options, for a Valkey's login: unused by the others. */
  const servers = {
    github: {
      api: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error("no GitHub call is expected");
          },
        },
      ) as RotateServicesOptions["github"]["api"],
      owner: "acme",
      repo: "shop",
    },
  };
  return {
    deps,
    handler,
    applies,
    held,
    failNext,
    keys,
    services,
    servers,
    plan,
    generated,
    record,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** The peers of the `network` step in a host plan. */
function peersOf(plan: HostPlan): { name: string; publicKey: string }[] {
  const step = plan.steps.find((s) => s.id === "network");
  return JSON.parse(String(step?.params.peers));
}

/** Every text OpsCrew showed, audited, asked, planned or committed (never a host's own input). */
async function everything(w: World, result: unknown): Promise<string> {
  return [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.applies.map((a) => a.plan)),
    await readFile(w.deps.paths.files.plan, "utf8"),
    await readFile(serverAddressesFile(w.deps.paths), "utf8"),
    JSON.stringify(result),
  ].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("opscrew rotate network", () => {
  it("gives every server a new key in one change of its host plan, writes each device's new configuration and records it", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys });

    const result = await rotateNetwork(w.deps, plan, { qr: true, services: w.services });

    // The rotation's plan by its hash first, then each server's host plan by its own, app first.
    expect(w.handler.requests.map((r) => r.kind)).toEqual([
      "remote-exec",
      "host-apply",
      "host-apply",
    ]);
    const shown = w.handler.requests[0];
    expect(shown?.planHash).toBe(result.hash);
    expect(shown?.details).toContain(`Rotation hash: ${result.hash}`);
    for (const name of [
      "server app",
      "server data",
      "laptop",
      "phone",
      "wg syncconf",
      "all of them before any is applied",
    ]) {
      expect(shown?.details).toContain(name);
    }
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data"]);
    expect(result.hostPlanHashes).toEqual(w.applies.map((a) => hostPlanHash(a.plan)));

    const [app, data, laptop, phone] = w.keys.made;
    const after = await w.plan();
    expect(after.network?.members.map((m) => m.publicKey)).toEqual([
      app?.publicKey,
      data?.publicKey,
    ]);
    // Each device keeps its address and the day it was added; its key is new.
    expect(after.network?.devices).toEqual(
      plan.network?.devices.map((d, i) => ({ ...d, publicKey: [laptop, phone][i]?.publicKey })),
    );
    // Each server gets its own new key with the others' new public keys, in the one step.
    expect(w.applies.map((a) => a.options.secrets)).toEqual([
      { wireguardKey: app?.privateKey },
      { wireguardKey: data?.privateKey },
    ]);
    const appPeers = peersOf(w.applies[0]?.plan as HostPlan).map((p) => p.publicKey);
    expect(appPeers.sort()).toEqual(
      [data?.publicKey, laptop?.publicKey, phone?.publicKey].sort() as string[],
    );
    expect((await w.generated()).network).toEqual({
      app: app?.privateKey,
      data: data?.privateKey,
    });

    // The devices' new configurations, only the user's to read, with the servers' new keys.
    expect(result.devices.map((d) => d.device)).toEqual(["laptop", "phone"]);
    for (const [i, device] of result.devices.entries()) {
      expect(device.file).toBe(deviceConfigFile(w.deps.paths, device.device));
      const text = await readFile(device.file, "utf8");
      expect(text).toContain(`PrivateKey = ${[laptop, phone][i]?.privateKey}`);
      expect(text).toContain(`PublicKey = ${app?.publicKey}`);
      expect(text).toContain(`PublicKey = ${data?.publicKey}`);
      expect(device.qr).toBe(text);
      if (process.platform !== "win32") expect((await stat(device.file)).mode & 0o777).toBe(0o600);
    }

    const record = await w.record();
    for (const name of ["network", "device:laptop", "device:phone"]) {
      expect(record[name]).toEqual({ rotatedAt: NOW.toISOString(), generation: 2 });
    }

    // No private key, old or new, in anything shown, audited, asked, planned or committed.
    const text = await everything(w, { ...result, devices: result.devices.map((d) => d.file) });
    for (const key of [...Object.values(privateKeys), ...w.keys.made.map((k) => k.privateKey)]) {
      expect(text).not.toContain(key);
    }
  });

  it("changes nothing when its plan is not approved", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys, answer: () => false });

    const error = await rotateNetwork(w.deps, plan, { services: w.services }).catch((e) => e);

    expect(error).toBeInstanceOf(PlanRefusedError);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["remote-exec"]);
    expect(w.applies).toEqual([]);
    expect((await w.plan()).network).toEqual(plan.network);
    expect((await w.generated()).network).toEqual(privateKeys);
    expect(existsSync(deviceConfigFile(w.deps.paths, "laptop"))).toBe(false);
    expect(existsSync(credentialsRecordFile(w.deps.paths))).toBe(false);
  });

  it("applies no server's host plan when one of them is not approved", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({
      plan,
      privateKeys,
      answer: (request) =>
        !(request.kind === "host-apply" && request.title.includes("server data")),
    });

    const error = await failure(rotateNetwork(w.deps, plan, { services: w.services }));

    // Both plans shown, the second refused: neither applied.
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("applied none of the servers' host plans");
    expect(error.message).toContain("nothing on them was changed");
    expect(w.handler.requests.map((r) => r.kind)).toEqual([
      "remote-exec",
      "host-apply",
      "host-apply",
    ]);
    expect(w.applies).toEqual([]);
    expect(existsSync(credentialsRecordFile(w.deps.paths))).toBe(false);
  });

  it("goes on with the same keys after a server's apply failed", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys });
    w.failNext.add("data");

    const error = await failure(rotateNetwork(w.deps, plan, { services: w.services }));
    expect(error.code).toBe("COMMAND_FAILED");
    // Every approval first, then the applies back to back: the app's server's went through.
    expect(w.handler.requests.map((r) => r.kind)).toEqual([
      "remote-exec",
      "host-apply",
      "host-apply",
    ]);
    expect(w.applies.map((a) => a.server)).toEqual(["app"]);
    expect(existsSync(credentialsRecordFile(w.deps.paths))).toBe(false);
    const made = [...w.keys.made];
    const written = await readFile(deviceConfigFile(w.deps.paths, "laptop"), "utf8");

    const result = await rotateNetwork(w.deps, await w.plan(), { qr: true, services: w.services });

    // No new rotation: the host plans again, with the keys made the first time, and data's key
    // passed since it holds the old one.
    expect(result.hash).toBeUndefined();
    expect(w.keys.made).toEqual(made);
    expect(w.handler.requests.map((r) => r.kind).slice(3)).toEqual(["host-apply", "host-apply"]);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "app", "data"]);
    expect(w.applies[1]?.options.secrets).toEqual({});
    expect(w.applies[2]?.options.secrets).toEqual({ wireguardKey: made[1]?.privateKey });
    expect(await readFile(deviceConfigFile(w.deps.paths, "laptop"), "utf8")).toBe(written);
    expect(result.devices[0]?.qr).toBe(written);
    expect(w.deps.reporter.text()).toContain(
      "Server data does not have the key the plan names yet",
    );
    expect(w.deps.reporter.text()).toContain("written when the rotation began");
    expect((await w.record()).network).toEqual({ rotatedAt: NOW.toISOString(), generation: 2 });
  });

  it("brings a server back in line without recording a rotation when no device file is newer than the last one", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys });
    await rotateNetwork(w.deps, plan, { services: w.services });
    const rotated = await w.plan();
    // Data's interface on another key, and the devices' files older than the rotation recorded.
    w.held.data = testKeyPair("elsewhere").publicKey;
    const past = new Date("2026-01-01T00:00:00.000Z");
    for (const device of ["laptop", "phone"]) {
      await utimes(deviceConfigFile(w.deps.paths, device), past, past);
    }
    const requests = w.handler.requests.length;

    const result = await rotateNetwork(w.deps, rotated, { services: w.services });

    expect(result.hash).toBeUndefined();
    expect(result.devices).toEqual([]);
    expect(w.handler.requests.slice(requests).map((r) => r.kind)).not.toContain("remote-exec");
    expect(w.applies.at(-1)?.server).toBe("data");
    expect(w.keys.made).toHaveLength(4);
    expect((await w.record()).network?.generation).toBe(2);
    const text = w.deps.reporter.text();
    expect(text).toContain("back in line with the plan's keys; no key was rotated");
    expect(text.split("its old one no longer works")).toHaveLength(2);
  });

  it("gives the monitoring server another environment owns its new key on its own interface, last", async () => {
    const { plan, privateKeys } = networkedPlan(deployed(senderPlan()), {
      monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
    });
    const owner = networkedPlan(deployed(monitoredPlan())).plan;
    const w = await world({ plan, privateKeys, environment: "staging", owner });

    const result = await rotateNetwork(w.deps, plan, { services: w.services });

    const shown = w.handler.requests[0];
    expect(shown?.details).toContain("server monitoring of opscrew/plan.yaml");
    expect(w.handler.requests.map((r) => r.kind)).toEqual([
      "remote-exec",
      "host-apply",
      "host-apply",
      "host-apply",
    ]);
    expect(w.handler.requests[3]?.title).toMatch(/server monitoring /);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data", "monitoring"]);
    const made = w.keys.made[2];
    const last = w.applies[2];
    const step = last?.plan.steps.find((s) => s.id === "network");
    expect(step?.params.interface).toBe("wg-opscrew1");
    expect(step?.params.publicKey).toBe(made?.publicKey);
    expect(last?.options.secrets).toEqual({ wireguardKey: made?.privateKey });
    expect((await w.generated()).network?.monitoring).toBe(made?.privateKey);
    expect(result.hostPlanHashes).toHaveLength(3);
  });

  it("refuses before any change while public SSH is closed", async () => {
    const { plan, privateKeys } = networked(splitPlan(), [], { publicSsh: false });
    const w = await world({ plan, privateKeys });

    const error = await failure(rotateNetwork(w.deps, plan, { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew secure --open-public-ssh");
    expect(w.handler.requests).toEqual([]);
    expect(w.keys.made).toEqual([]);
  });

  it("refuses before any change when a server has no private network yet", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys, held: { data: undefined } });

    const error = await failure(rotateNetwork(w.deps, plan, { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("server data");
    expect(error.hint).toContain("opscrew provision");
    expect(w.handler.requests).toEqual([]);
    expect(w.keys.made).toEqual([]);
  });

  it("refuses an app without a private network", async () => {
    const { network: _none, ...plan } = testPlan();
    const w = await world({ plan: plan as DeployPlan, privateKeys: {} });

    const error = await failure(
      rotateNetwork(w.deps, plan as DeployPlan, { services: w.services }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("opscrew rotate");
  });
});

describe("opscrew rotate device:<name>", () => {
  it("gives the device a new key pair and configuration, its old peer removed on every server", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys });

    const result = await rotateDevice(w.deps, plan, "laptop", { services: w.services });

    const [pair] = w.keys.made;
    expect(w.keys.made).toHaveLength(1);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data"]);
    for (const apply of w.applies) {
      const laptops = peersOf(apply.plan).filter((p) => p.name === "laptop");
      expect(laptops.map((p) => p.publicKey)).toEqual([pair?.publicKey]);
    }
    expect(await readFile(result.file, "utf8")).toContain(`PrivateKey = ${pair?.privateKey}`);
    const record = await w.record();
    expect(record["device:laptop"]).toEqual({ rotatedAt: NOW.toISOString(), generation: 2 });
    expect(record["device:phone"]).toBeUndefined();
    expect(record.network).toBeUndefined();
  });

  it("names its own command for a refused host plan, then finishes with the same key and records it", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    let refuseData = true;
    const w = await world({
      plan,
      privateKeys,
      answer: (request) =>
        !(refuseData && request.kind === "host-apply" && request.title.includes("server data")),
    });

    const error = await failure(rotateDevice(w.deps, plan, "laptop", { services: w.services }));
    expect(error.hint).toContain("opscrew rotate device:laptop --approve");
    expect(error.hint).not.toContain("vpn add");
    expect(w.applies.map((a) => a.server)).toEqual(["app"]);
    expect(existsSync(credentialsRecordFile(w.deps.paths))).toBe(false);

    refuseData = false;
    const result = await rotateDevice(w.deps, await w.plan(), "laptop", { services: w.services });

    // The key made the first time: data takes it now.
    expect(w.keys.made).toHaveLength(1);
    expect(result.written).toBe(false);
    const laptops = peersOf(w.applies.at(-1)?.plan as HostPlan).filter((p) => p.name === "laptop");
    expect(w.applies.at(-1)?.server).toBe("data");
    expect(laptops.map((p) => p.publicKey)).toEqual([w.keys.made[0]?.publicKey]);
    expect((await w.record())["device:laptop"]).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expect(result.copy).toEqual({ changed: false });
  });

  it("refuses a device that is not on the network, before any change", async () => {
    const { plan, privateKeys } = networked(splitPlan());
    const w = await world({ plan, privateKeys });

    const error = await failure(rotateDevice(w.deps, plan, "tablet", { services: w.services }));

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("tablet");
    expect(w.keys.made).toEqual([]);
    expect(w.handler.requests).toEqual([]);
  });
});

describe("opscrew rotate grant:<device>/<service>", () => {
  const grant: Grant = { device: "laptop", service: "db", access: "read-only" };

  it("gives the device's login a new password through the grant's host plan, shown once", async () => {
    const { plan, privateKeys } = networked(splitPlan(), [grant]);
    const w = await world({ plan, privateKeys, grants: { "laptop/db": OLD_GRANT } });

    const result = await rotateGrant(w.deps, plan, "laptop", "db", {
      services: w.services,
      servers: w.servers,
    });

    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
    expect(w.handler.requests[0]?.title).toContain("new password");
    expect(w.applies.map((a) => a.server)).toEqual(["data"]);
    expect(w.applies[0]?.plan.steps.map((s) => [s.id, s.state])).toEqual([["grant", "change"]]);
    const password = result.connection?.password as string;
    expect(password).not.toBe(OLD_GRANT);
    expect(w.applies[0]?.options.secrets).toEqual({ grantPassword: password });
    expect((await w.generated()).grants).toEqual({ "laptop/db": password });
    expect(result).toMatchObject({ device: "laptop", service: "db", access: "read-only" });
    expect(result.connection?.client).toContain("psql");
    expect((await w.record())["grant:laptop/db"]).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });

    expect(result.hash).toBe(hostPlanHash(w.applies[0]?.plan as HostPlan));
    const text = await everything(w, { ...result, connection: undefined });
    expect(text).not.toContain(password);
    expect(text).not.toContain(OLD_GRANT);
  });

  it("keeps the old password when the grant's host plan is not approved", async () => {
    const { plan, privateKeys } = networked(splitPlan(), [grant]);
    const w = await world({
      plan,
      privateKeys,
      grants: { "laptop/db": OLD_GRANT },
      answer: () => false,
    });

    const error = await failure(
      rotateGrant(w.deps, plan, "laptop", "db", { services: w.services, servers: w.servers }),
    );

    expect(error.hint).toContain("opscrew rotate grant:laptop/db --approve");
    expect(w.applies).toEqual([]);
    expect((await w.generated()).grants).toEqual({ "laptop/db": OLD_GRANT });
    expect(existsSync(credentialsRecordFile(w.deps.paths))).toBe(false);
  });

  it("refuses a device without that login, before any change", async () => {
    const { plan, privateKeys } = networked(splitPlan(), [grant]);
    const w = await world({ plan, privateKeys });

    const error = await failure(
      rotateGrant(w.deps, plan, "phone", "db", { services: w.services, servers: w.servers }),
    );

    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("phone");
    expect(w.handler.requests).toEqual([]);
  });
});
