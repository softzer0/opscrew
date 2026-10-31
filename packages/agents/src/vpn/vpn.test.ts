import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, type Network, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork, type WireGuardPeerState } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import {
  readServerAddresses,
  type ServerAddresses,
  serverAddressesFile,
  updateServerAddresses,
} from "../shared/server-record";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  ownPlan,
  ScriptedApprovalHandler,
  testKeyMaker,
  testKeyPair,
  testPlan,
} from "../testing";
import { dashboardOnNetwork } from "./dashboards";
import { deviceConfigFile, vpnAdd, vpnRemove } from "./devices";
import { vpnList } from "./list";
import type { VpnServices } from "./servers";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const APP_IPV4 = "203.0.113.10";
const DATA_IPV4 = "203.0.113.30";

/** What inspection reads on a server OpsCrew created: a fresh Ubuntu, root only through Docker. */
function cloudFacts(): HostFacts {
  return HostFactsSchema.parse(freshFacts({ user: "deploy", privilege: "docker" }));
}

/** The split plan (`db` on server `data`) on its network, with `devices`, and the servers' keys. */
function networked(devices: Network["devices"] = [], extra: Partial<Network> = {}) {
  const split = splitPlan();
  const base = { ...split, deployment: { ...split.deployment, lastApplyAt: DEPLOYED_AT } };
  const { network, privateKeys } = allocateNetwork(base, {}, testKeyMaker("server"));
  return { plan: withNetwork(base, { ...network, devices, ...extra }), privateKeys };
}

/** A device on `plan`'s network at `.<host>`, its key from `seed`. */
function device(plan: Pick<DeployPlan, "network">, name: string) {
  return (host: number, seed = name) => ({
    name,
    address: `${networkPrefix(plan)}.${host}`,
    publicKey: testKeyPair(seed).publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  });
}

/** The first three numbers of the network's range: `10.20x.y`. */
function networkPrefix(plan: Pick<DeployPlan, "network">): string {
  return (plan.network?.range ?? "").split(".").slice(0, 3).join(".");
}

/** The split plan's range (it depends only on the app and environment). */
const SPLIT = networked().plan;
const PREFIX = networkPrefix(SPLIT);
const laptop = device(SPLIT, "laptop");

interface Apply {
  server: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/**
 * A deployed project with `plan`, the servers' addresses on this computer, the servers' keys with
 * the generated values, and fake shells and host adapters per server (by name).
 */
async function world(o: {
  plan: DeployPlan;
  privateKeys?: Record<string, string>;
  record?: Partial<ServerAddresses>;
  answer?: () => boolean;
}) {
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({ approvalHandler: handler, clock: { now: () => NOW } });
  await writeArtifact("plan", deps.paths.files.plan, o.plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: APP_IPV4 },
    ...((o.plan.servers ?? []).length > 0 ? { servers: { data: { ipv4: DATA_IPV4 } } } : {}),
    ...o.record,
  }));
  if (o.privateKeys !== undefined) await recordGeneratedEntries(deps, "network", o.privateKeys);
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
        return cloudFacts();
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

type World = Awaited<ReturnType<typeof world>>;

/** The peers of the `network` step in a host plan. */
function peersOf(plan: HostPlan): { name: string; publicKey: string; allowedIp: string }[] {
  const step = plan.steps.find((s) => s.id === "network");
  return JSON.parse(String(step?.params.peers));
}

/** Every text OpsCrew showed, audited, asked, saved or committed. */
async function everything(w: World, result: unknown): Promise<string> {
  const plans = w.deps.paths.files.plansDir;
  const saved = existsSync(plans)
    ? await Promise.all((await readdir(plans)).map((name) => readFile(join(plans, name), "utf8")))
    : [];
  return [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.applies),
    ...saved,
    await readFile(w.deps.paths.files.plan, "utf8"),
    await readFile(serverAddressesFile(w.deps.paths), "utf8"),
    (await readFile(generatedValuesFile(w.deps), "utf8").catch(() => "")) as string,
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

describe("opscrew vpn add", () => {
  it("adds the device to every server by its own host plan, writes its configuration (0600) and sets this computer", async () => {
    const { plan, privateKeys } = networked();
    const w = await world({ plan, privateKeys });

    const result = await vpnAdd(w.deps, "laptop", {
      thisComputer: true,
      qr: true,
      services: w.services,
    });

    const pair = w.keys.made[0];
    if (pair === undefined) throw new Error("no key was made");
    // One host plan per server with a public address, `app` first, each approved by its hash.
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply", "host-apply"]);
    expect(w.handler.requests[0]?.title).toMatch(/server app /);
    expect(w.handler.requests[1]?.title).toMatch(/server data /);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data"]);
    expect(result.hostPlanHashes).toEqual(w.applies.map((a) => hostPlanHash(a.plan)));
    expect(w.inspected).toEqual([
      { server: "app", rootImage: IMAGES.caddy.ref },
      { server: "data", rootImage: IMAGES.caddy.ref },
    ]);
    for (const apply of w.applies) {
      expect(peersOf(apply.plan)).toContainEqual({
        name: "laptop",
        publicKey: pair.publicKey,
        allowedIp: `${PREFIX}.100/32`,
      });
      expect(apply.options.secrets).toEqual({ wireguardKey: privateKeys[apply.server] });
    }

    // The plan: the device's public key and address, and the two approvals.
    const after = await w.plan();
    expect(after.network?.devices).toEqual([
      {
        name: "laptop",
        address: `${PREFIX}.100`,
        publicKey: pair.publicKey,
        addedAt: NOW.toISOString(),
      },
    ]);
    expect(after.approvals.map((a) => a.kind)).toEqual(["host-apply", "host-apply"]);
    expect((await readServerAddresses(w.deps.paths)).thisDevice).toBe("laptop");

    // The configuration: written once, only the user can read it, a peer for each server.
    const file = deviceConfigFile(w.deps.paths, "laptop");
    expect(file).toBe(join(w.deps.paths.projectHomeDir, "vpn", "prod-laptop.conf"));
    expect(result).toMatchObject({
      device: "laptop",
      address: `${PREFIX}.100`,
      file,
      written: true,
      applied: true,
    });
    const config = await readFile(file, "utf8");
    expect(config).toContain(`PrivateKey = ${pair.privateKey}`);
    expect(config).toContain(`Address = ${PREFIX}.100/32`);
    expect(config).toContain(`Endpoint = ${APP_IPV4}:51820`);
    expect(config).toContain(`Endpoint = ${DATA_IPV4}:51820`);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(result.qr).toBe(config);

    // The private key is in that file and the QR text only.
    const { qr: _qr, ...rest } = result;
    expect(await everything(w, rest)).not.toContain(pair.privateKey);
    expect(w.deps.reporter.text()).toContain(file);
    expect(w.deps.reporter.text()).toContain(`app ${PREFIX}.1, data ${PREFIX}.2`);
  });

  it("returns the configuration's text only with --qr, and leaves this computer's device alone without --this-computer", async () => {
    const { plan, privateKeys } = networked();
    const w = await world({ plan, privateKeys });
    const result = await vpnAdd(w.deps, "phone", { services: w.services });
    expect(result.qr).toBeUndefined();
    expect(result.written).toBe(true);
    expect((await readServerAddresses(w.deps.paths)).thisDevice).toBeUndefined();
    expect(await everything(w, result)).not.toContain(w.keys.made[0]?.privateKey);
  });

  it("writes the configuration before the plan: a failed write leaves the plan without the device", async () => {
    const { plan, privateKeys } = networked();
    const w = await world({ plan, privateKeys });
    const before = await readFile(w.deps.paths.files.plan, "utf8");
    // A folder where the file goes: the write fails.
    await mkdir(deviceConfigFile(w.deps.paths, "laptop"), { recursive: true });

    await expect(vpnAdd(w.deps, "laptop", { services: w.services })).rejects.toThrow();

    expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
    expect(w.applies).toEqual([]);
  });

  it("after the first device, says how the dashboards go on the private address", async () => {
    const { plan, privateKeys } = networked();
    const portainer = { enabled: true, version: "2.45.2", access: "local" } as const;
    const w = await world({ plan: { ...plan, portainer }, privateKeys });

    await vpnAdd(w.deps, "laptop", { services: w.services });
    const said =
      "Portainer's web UI goes on the app's server's private address for your devices once applied again: run `opscrew portainer enable`.";
    expect(w.deps.reporter.text()).toContain(said);

    w.deps.reporter.lines.length = 0;
    await vpnAdd(w.deps, "phone", { services: w.services });
    expect(w.deps.reporter.text()).not.toContain("Portainer's web UI");
  });

  it("gives a single-server app its network: the range, the app's member and its key, kept with the generated values", async () => {
    const w = await world({ plan: testPlan({ deployed: true }) });

    const result = await vpnAdd(w.deps, "laptop", { services: w.services });

    const [server, pair] = w.keys.made;
    const after = await w.plan();
    const prefix = networkPrefix(after);
    expect(after.network).toMatchObject({
      members: [{ name: "app", address: `${prefix}.1`, port: 51820, publicKey: server?.publicKey }],
      devices: [{ name: "laptop", address: `${prefix}.100`, publicKey: pair?.publicKey }],
      publicSsh: true,
    });
    const generated = await readValidJson(generatedValuesFile(w.deps), GeneratedValuesSchema);
    expect(generated?.network).toEqual({ app: server?.privateKey });
    expect(w.applies.map((a) => a.server)).toEqual(["app"]);
    expect(w.applies[0]?.options.secrets).toEqual({ wireguardKey: server?.privateKey });
    expect(result.written).toBe(true);
    // The cloud firewall opens WireGuard's port only through the infrastructure plan.
    expect(w.deps.reporter.text()).toContain("UDP 51820");
    expect(w.deps.reporter.text()).toContain("`opscrew provision`");
  });

  it("refuses an app whose only server has no public address, before any change", async () => {
    const plan = ownPlan({ access: "tunnel", deployed: true });
    const w = await world({
      plan,
      record: { own: { host: "192.0.2.5", port: 22, user: "root", agent: true, reachable: false } },
    });
    const before = await readFile(w.deps.paths.files.plan, "utf8");

    const error = await failure(vpnAdd(w.deps, "laptop", { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("no public address");
    expect(error.message).toContain("Nothing was changed.");
    expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
    expect(w.inspected).toEqual([]);
    expect(w.keys.made).toEqual([]);
    expect(existsSync(deviceConfigFile(w.deps.paths, "laptop"))).toBe(false);
  });

  it("refuses a device's name it can't use and an app that isn't deployed", async () => {
    const { plan, privateKeys } = networked();
    const w = await world({ plan, privateKeys });
    expect((await failure(vpnAdd(w.deps, "Laptop", { services: w.services }))).code).toBe(
      "INVALID_INPUT",
    );
    const fresh = await world({ plan: testPlan() });
    const error = await failure(vpnAdd(fresh.deps, "laptop", { services: fresh.services }));
    expect(error.message).toContain("has no servers yet");
    expect(fresh.keys.made).toEqual([]);
  });

  it("a refused host plan keeps the device and its key: --approve with the shown hash finishes it without a new key", async () => {
    const { plan, privateKeys } = networked();
    let answers = 0;
    const w = await world({ plan, privateKeys, answer: () => answers++ > 0 });

    const error = await failure(
      vpnAdd(w.deps, "laptop", { thisComputer: true, qr: true, services: w.services }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    const refused = w.handler.requests[0]?.planHash;
    expect(error.hint).toBe(
      `To apply it later without prompts, run: opscrew vpn add laptop --this-computer --approve ${refused}`,
    );
    const file = deviceConfigFile(w.deps.paths, "laptop");
    const config = await readFile(file, "utf8");
    expect((await w.plan()).network?.devices.map((d) => d.name)).toEqual(["laptop"]);
    expect((await readServerAddresses(w.deps.paths)).thisDevice).toBeUndefined();

    const again = await vpnAdd(w.deps, "laptop", { thisComputer: true, services: w.services });

    expect(w.keys.made).toHaveLength(1);
    expect(again.written).toBe(false);
    expect(again.hostPlanHashes[0]).toBe(refused);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data"]);
    expect(await readFile(file, "utf8")).toBe(config);
    expect((await readServerAddresses(w.deps.paths)).thisDevice).toBe("laptop");
    expect(w.deps.reporter.text()).toContain("--again");
  });

  it("--again makes a new key and configuration for the device at its address", async () => {
    const { plan, privateKeys } = networked([laptop(100, "old-laptop")]);
    const w = await world({ plan, privateKeys });

    const result = await vpnAdd(w.deps, "laptop", { again: true, services: w.services });

    const pair = w.keys.made[0];
    expect(result).toMatchObject({ written: true, address: `${PREFIX}.100` });
    const devices = (await w.plan()).network?.devices;
    expect(devices).toEqual([
      { ...laptop(100), publicKey: pair?.publicKey, addedAt: "2026-10-30T10:00:00.000Z" },
    ]);
    for (const apply of w.applies) {
      const peers = peersOf(apply.plan).filter((p) => p.name === "laptop");
      expect(peers.map((p) => p.publicKey)).toEqual([pair?.publicKey]);
    }
    expect(await readFile(result.file, "utf8")).toContain(`PrivateKey = ${pair?.privateKey}`);
  });

  it("--again refuses this computer's device while public SSH is closed, before any change", async () => {
    const { plan, privateKeys } = networked([laptop(100)], { publicSsh: false });
    const w = await world({ plan, privateKeys, record: { thisDevice: "laptop" } });

    const error = await failure(vpnAdd(w.deps, "laptop", { again: true, services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew secure --open-public-ssh");
    expect(w.keys.made).toEqual([]);
    expect(w.inspected).toEqual([]);
  });
});

describe("opscrew vpn remove", () => {
  it("takes the device off every server by each one's host plan, then out of the plan and this computer's record", async () => {
    const { plan, privateKeys } = networked([laptop(100), device(SPLIT, "phone")(101)]);
    const w = await world({ plan, privateKeys, record: { thisDevice: "laptop" } });

    const result = await vpnRemove(w.deps, "laptop", { services: w.services });

    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply", "host-apply"]);
    expect(w.applies.map((a) => a.server)).toEqual(["app", "data"]);
    for (const apply of w.applies) {
      expect(peersOf(apply.plan).map((p) => p.name)).not.toContain("laptop");
      expect(peersOf(apply.plan).map((p) => p.name)).toContain("phone");
    }
    expect(result.hostPlanHashes).toEqual(w.applies.map((a) => hostPlanHash(a.plan)));
    const after = await w.plan();
    expect(after.network?.devices.map((d) => d.name)).toEqual(["phone"]);
    expect(after.approvals.map((a) => a.kind)).toEqual(["host-apply", "host-apply"]);
    expect((await readServerAddresses(w.deps.paths)).thisDevice).toBeUndefined();
  });

  it("a refused host plan leaves the device in the plan", async () => {
    const { plan, privateKeys } = networked([laptop(100)]);
    const w = await world({ plan, privateKeys, answer: () => false });
    const error = await failure(vpnRemove(w.deps, "laptop", { services: w.services }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toContain("opscrew vpn remove laptop --approve ");
    expect((await w.plan()).network?.devices.map((d) => d.name)).toEqual(["laptop"]);
  });

  it("refuses to cut this computer off while public SSH is closed, a device with access to a database, and an unknown device", async () => {
    const closed = networked([laptop(100)], { publicSsh: false });
    const w = await world({ ...closed, record: { thisDevice: "laptop" } });
    const cut = await failure(vpnRemove(w.deps, "laptop", { services: w.services }));
    expect(cut.message).toContain("cut this computer off");
    expect(cut.hint).toContain("opscrew secure --open-public-ssh");
    expect(w.inspected).toEqual([]);

    const granted = networked([laptop(100)], {
      grants: [{ device: "laptop", service: "db", access: "read-only" }],
    });
    const g = await world(granted);
    const access = await failure(vpnRemove(g.deps, "laptop", { services: g.services }));
    expect(access.hint).toContain("opscrew vpn revoke laptop db");
    expect(g.inspected).toEqual([]);

    const unknown = await failure(vpnRemove(g.deps, "tablet", { services: g.services }));
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.hint).toContain("laptop");
  });
});

describe("opscrew vpn list", () => {
  it("lists each device with its address and last handshake per server, and the servers a configuration lacks", async () => {
    const { plan } = networked([laptop(100), device(SPLIT, "phone")(101)]);
    const w = await world({ plan, record: { thisDevice: "laptop" } });
    const remote = async (server: string): Promise<RemoteExec> => ({
      host: server,
      async run(command): Promise<CommandResult> {
        if (!command.startsWith("ping ")) return { exitCode: 0, stdout: "docker\n", stderr: "" };
        return { exitCode: 1, stdout: "3 packets transmitted, 0 received", stderr: "" };
      },
    });
    const handshakes: Record<string, WireGuardPeerState[]> = {
      app: [
        {
          publicKey: testKeyPair("laptop").publicKey,
          latestHandshake: new Date(NOW.getTime() - 10_000),
          allowedIps: [],
        },
      ],
      data: [],
    };
    const readWireGuard = async (r: RemoteExec) => handshakes[r.host] ?? [];

    const result = await vpnList(w.deps, { services: { remote, readWireGuard } });

    expect(result.devices).toEqual([
      {
        name: "laptop",
        address: `${PREFIX}.100`,
        addedAt: "2026-10-30T10:00:00.000Z",
        thisComputer: true,
        links: [
          { server: "app", up: true, handshakeAgeSeconds: 10 },
          { server: "data", up: false },
        ],
        missing: ["data"],
      },
      {
        name: "phone",
        address: `${PREFIX}.101`,
        addedAt: "2026-10-30T10:00:00.000Z",
        thisComputer: false,
        links: [
          { server: "app", up: false },
          { server: "data", up: false },
        ],
        missing: [],
      },
    ]);
    const text = w.deps.reporter.text();
    expect(text).toContain(`laptop (${PREFIX}.100), this computer`);
    expect(text).toContain("server app: up, last handshake 10 seconds ago");
    expect(text).toContain("server data: down, no handshake yet");
    expect(text).toContain("opscrew vpn add laptop --again");
    expect(text).not.toContain("opscrew vpn add phone --again");
  });

  it("says when the network has no devices", async () => {
    const w = await world({ plan: testPlan({ deployed: true }) });
    expect(await vpnList(w.deps)).toEqual({ devices: [] });
    expect(w.deps.reporter.text()).toContain("opscrew vpn add <name>");
  });
});

describe("dashboardOnNetwork", () => {
  /** `plan` with Portainer on and the device laptop on its network, this computer being laptop. */
  async function portainerFor(plan: DeployPlan, own: boolean) {
    const { network: _none, ...base } = plan;
    const { network } = allocateNetwork(
      base,
      own ? { app: { udpPortsInUse: [], wireguardInterfaces: [] } } : {},
      testKeyMaker(),
    );
    const prefix = networkPrefix({ network });
    const full = withNetwork(
      { ...base, portainer: { enabled: true, version: "2.45.2", access: "local" } },
      { ...network, devices: [device({ network }, "laptop")(100)] },
    );
    const w = await world({ plan: full, record: { thisDevice: "laptop" } });
    return { found: await dashboardOnNetwork(w.deps, full, "portainer"), prefix };
  }

  it("points this computer's device to the private address of a server OpsCrew created", async () => {
    const { found, prefix } = await portainerFor(testPlan({ deployed: true }), false);
    expect(found).toEqual({ device: "laptop", address: `${prefix}.1`, port: 9443 });
  });

  it("keeps the SSH tunnel on the user's own server, with a public address or behind a tunnel", async () => {
    for (const access of ["public", "tunnel"] as const) {
      const { found } = await portainerFor(ownPlan({ access, deployed: true }), true);
      expect(found).toBeUndefined();
    }
  });
});
