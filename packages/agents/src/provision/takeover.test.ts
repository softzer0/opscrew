// 026 plan 4.3 and 4.4: provision takes over a server the infrastructure state lost (FR-2607,
// SC-2605) and reads credentials that come as a set. Hetzner keeps its own definition; DigitalOcean's
// stands in for a provider like Contabo: four credentials, cancelled at the end of the term.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  AppServer,
  CloudProviderDefinition,
  PlanSummary,
  ServerSnapshotApi,
  VpsConnector,
} from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  DIGITALOCEAN_CREATE,
  FakeEngine,
  type FakeEngineScenario,
  FakeGitHub,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
  writeFakeState,
} from "../testing";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { previewDeploymentFiles } from "./render";
import { runProvision } from "./run";
import { applyMarkerFile } from "./takeover";
import type { ProvisionServices } from "./types";

const { SET } = vi.hoisted(() => ({ SET: ["SET_ID", "SET_SECRET", "SET_USER", "SET_PASS"] }));

vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const base = actual.cloudProvider("digitalocean");
  const set: CloudProviderDefinition = {
    ...base,
    credentials: { ...base.credentials, envVars: SET, mode: "all" },
    offering: { ...base.offering, removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 } },
    connector: (deps): VpsConnector => ({
      id: "digitalocean",
      displayName: base.displayName,
      credentials: {
        envVars: [...SET],
        description: "The four API credentials; they reach the whole account.",
        scopes: [],
        createUrl: "https://set.example/api",
      },
      configured: SET.every((name) => (deps.env[name] ?? "").trim() !== ""),
      servers: undefined,
      catalog: () => {
        throw new Error("no catalogue in this test");
      },
      verifyCredentials: async () => ({ ok: true, message: "The API credentials work." }),
    }),
  };
  const CLOUD_PROVIDERS = actual.CLOUD_PROVIDERS.map((p) => (p.id === set.id ? set : p));
  return {
    ...actual,
    CLOUD_PROVIDERS,
    cloudProvider: (id: string) =>
      CLOUD_PROVIDERS.find((p) => p.id === id) ?? actual.cloudProvider(id),
  };
});

const SERVER = "module.server.hcloud_server.this";

/** The provider's server API as a fake: `servers` is what it has, `lookups` what was asked. */
function fakeServers(servers: AppServer[] = []) {
  const lookups: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("not used by provision");
  };
  const api: ServerSnapshotApi = {
    findAppServers: async (app) => {
      lookups.push(app);
      return servers;
    },
    snapshotServer: unexpected,
    listSnapshots: unexpected,
    deleteSnapshot: unexpected,
    rebuild: unexpected,
    powerOff: unexpected,
    powerOn: unexpected,
  };
  return { api, servers, lookups };
}

/** A fake engine whose state lists `inState`. */
class StateEngine extends FakeEngine {
  inState: string[] = [];
  override readonly stateResources = async () => [...this.inState];
}

/**
 * An engine like the real one for a lost server: a plan creates the Hetzner server unless the
 * root module imports it, then plans the import instead.
 */
class LostServerEngine extends StateEngine {
  /** The plans made, by what each creates. */
  readonly creates: string[][] = [];
  /** The plans made, by the server id each imports (`undefined`: none). */
  readonly imported: (string | undefined)[] = [];
  /** The state has outputs before this run applies anything (a deployment that exists). */
  deployed = false;

  override async output(): Promise<Record<string, unknown>> {
    return this.deployed ? this.outputs : super.output();
  }

  override async plan(
    dir: string,
    planFile: string,
    options?: Parameters<FakeEngine["plan"]>[2],
  ): Promise<PlanSummary> {
    const main = await readFile(join(dir, "main.tf"), "utf8");
    const id = /import \{\n {2}to = module\.server\.hcloud_server\.this\n {2}id = "(\w+)"/.exec(
      main,
    )?.[1];
    const create = [
      "module.server.hcloud_ssh_key.deploy",
      "module.server.hcloud_firewall.this",
      ...(id === undefined ? [SERVER] : []),
    ].filter((address) => !this.inState.includes(address));
    const json = planJsonFor();
    const [server] = json.resource_changes;
    Object.assign(this.scenario, {
      changes: create.map((address) => ({
        address,
        type: address.split(".")[2] as string,
        name: address.split(".")[3] as string,
        provider: "registry.opentofu.org/hetznercloud/hcloud",
        action: "create" as const,
      })),
      planJson:
        id === undefined
          ? json
          : {
              ...json,
              resource_changes: [
                { ...server, change: { ...server?.change, actions: ["no-op"], importing: { id } } },
              ],
            },
    } satisfies FakeEngineScenario);
    this.creates.push(create);
    this.imported.push(id);
    return super.plan(dir, planFile, options);
  }
}

async function setup(
  o: {
    plan?: ReturnType<typeof testPlan>;
    engine?: FakeEngine;
    servers?: ServerSnapshotApi;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const project = await createProject(o.plan ?? testPlan({ userSecret: false }));
  const engine = o.engine ?? new LostServerEngine();
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew"), ...o.env },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: {
      configured: true,
      verify: async () => ({ ok: true, message: "ok" }),
      ...(o.servers !== undefined ? { servers: o.servers } : {}),
    },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  };
  const main = () => readFile(join(project.root, "opscrew/infra/prod/main.tf"), "utf8");
  return { ...project, deps, engine, handler, services, main };
}

/** The marker an apply that stopped left, creating `servers`. */
async function writeMarker(paths: { stateDir: string }, servers: string[]): Promise<void> {
  const marker = { planHash: "a".repeat(64), startedAt: "2026-10-11T10:00:00.000Z", servers };
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(applyMarkerFile(paths), JSON.stringify(marker));
}

const applyRequest = (handler: ScriptedApprovalHandler) =>
  handler.requests.filter((r) => r.kind === "iac-apply").at(-1);

describe.skipIf(!findExecutable("git"))("provision takes over a server the state lost", () => {
  it("SC-2605: a create that timed out, then a second provision, buys no second server", async () => {
    const provider = fakeServers();
    const engine = new LostServerEngine({
      applyOk: false,
      applyLog: "Error: timeout while waiting for the server to be created",
    });
    const run = await setup({ engine, servers: provider.api });
    const marker = applyMarkerFile(run.deps.paths);

    // The first provision: nothing applied here before, so nothing is looked up; its apply stops.
    await expect(runProvision(run.deps, { services: run.services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
    });
    expect(provider.lookups).toEqual([]);
    expect(engine.creates[0]).toContain(SERVER);
    // The marker of the stopped apply names the server it was creating.
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ servers: [SERVER] });

    // The server exists at the provider, untagged; the state has its key and firewall only.
    provider.servers.push({ id: "4711", name: "shop", status: "running", nameOnly: true });
    engine.inState = ["module.server.hcloud_ssh_key.deploy", "module.server.hcloud_firewall.this"];
    await writeFakeState(run.deps.paths);
    engine.scenario.applyOk = true;

    const result = await runProvision(run.deps, { services: run.services });
    expect(provider.lookups).toEqual(["shop"]);
    // The second plan imports the server instead of creating one.
    expect(engine.imported[1]).toBe("4711");
    expect(engine.creates[1]).toEqual([]);
    const apply = applyRequest(run.handler);
    expect(apply?.title).toContain(
      "(0 to create, 0 to update, 0 to delete, 0 to replace, 1 to import)",
    );
    expect(apply?.details).toContain(`← import  ${SERVER} (id 4711)`);
    expect(apply?.details).toContain(
      "Hetzner Cloud has the server shop (id 4711, running) without OpsCrew's tag, which the infrastructure state lacks: OpsCrew's last provision of prod stopped while creating it. The plan takes it over with an import instead of buying another server",
    );
    expect(result.applied).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // The state holds the server now: the committed main.tf is the plain render, so drift's
    // comparison of the generated files finds nothing.
    expect(await run.main()).not.toContain("import {");
    expect(
      await run.git(run.root, "show", `${DEPLOY_SETUP_BRANCH}:opscrew/infra/prod/main.tf`),
    ).not.toContain("import {");
    const preview = await previewDeploymentFiles(run.deps, {
      services: run.services,
      foreignRecords: "report",
      createDeployKey: false,
    });
    expect(preview.changed).toEqual([]);
    expect(preview.created).toEqual([]);
  });

  it("takes over a tagged server the state lacks without an earlier stop", async () => {
    const provider = fakeServers([{ id: "512", name: "shop", status: "off" }]);
    const run = await setup({ servers: provider.api });
    await writeFakeState(run.deps.paths);
    await runProvision(run.deps, { services: run.services });
    expect((run.engine as LostServerEngine).imported).toEqual(["512"]);
    expect(run.deps.reporter.text()).toContain(
      "Hetzner Cloud has the server shop (id 512, off), which the infrastructure state lacks: an earlier apply created it but stopped before recording it.",
    );
  });

  it("names a saved plan's taken-over server in its approval (`--approve <hash>`)", async () => {
    const provider = fakeServers([{ id: "512", name: "shop", status: "running" }]);
    const engine = new LostServerEngine();
    const run = await setup({ engine, servers: provider.api });
    await writeFakeState(run.deps.paths);
    const saved = await runProvision(run.deps, { services: run.services, planOnly: true });
    expect(await run.main()).toContain(`import {\n  to = ${SERVER}\n  id = "512"\n}`);

    await runProvision(run.deps, {
      services: run.services,
      approveHashes: [saved.planHash as string],
    });
    expect(engine.calls.filter((call) => call === "plan")).toHaveLength(1);
    expect(applyRequest(run.handler)?.details).toContain(
      "Hetzner Cloud has the server shop (id 512), which the infrastructure state lacks: an earlier apply created it but stopped before recording it. The plan takes it over with an import instead of buying another server",
    );
    expect(await run.main()).not.toContain("import {");
  });

  it("clears the marker on a run with nothing to change", async () => {
    const engine = new LostServerEngine();
    engine.inState = [
      "module.server.hcloud_ssh_key.deploy",
      "module.server.hcloud_firewall.this",
      SERVER,
    ];
    engine.deployed = true;
    const run = await setup({ engine, servers: fakeServers().api });
    await writeFakeState(run.deps.paths);
    await writeMarker(run.deps.paths, [SERVER]);
    await runProvision(run.deps, { services: run.services });
    expect(engine.calls).not.toContain("apply");
    expect(existsSync(applyMarkerFile(run.deps.paths))).toBe(false);
  });

  it("refuses an untagged server at an address the stopped apply was not creating", async () => {
    const provider = fakeServers([{ id: "4711", name: "shop", status: "running", nameOnly: true }]);
    const engine = new LostServerEngine();
    engine.inState = ["module.server.hcloud_ssh_key.deploy", "module.server.hcloud_firewall.this"];
    const run = await setup({ engine, servers: provider.api });
    await writeFakeState(run.deps.paths);
    // The apply that stopped created no server (its DNS records, say).
    await writeMarker(run.deps.paths, []);
    await expect(runProvision(run.deps, { services: run.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "Hetzner Cloud has a server named shop (id 4711) without OpsCrew's tag, which the infrastructure state lacks. OpsCrew takes such a server over only when its last provision of prod stopped while creating it, and it did not",
      ),
      hint: "Rename the server in the Hetzner Cloud Console if it is not the app's, or remove it there if it is a leftover; then run `opscrew provision` again.",
    });
    expect(engine.calls).not.toContain("plan");
  });

  it("stops before planning when the provider's servers cannot be listed", async () => {
    const provider = fakeServers();
    provider.api.findAppServers = async () => {
      throw new OpsCrewError("PROVIDER_ERROR", "Hetzner Cloud did not answer (503).");
    };
    const run = await setup({ servers: provider.api });
    await writeFakeState(run.deps.paths);
    await expect(runProvision(run.deps, { services: run.services })).rejects.toMatchObject({
      message: "Hetzner Cloud did not answer (503).",
    });
    expect(run.engine.calls).not.toContain("plan");
  });

  it("stops before planning at an untagged server when OpsCrew's last provision did not stop", async () => {
    const provider = fakeServers([{ id: "4711", name: "shop", status: "running", nameOnly: true }]);
    const run = await setup({ servers: provider.api });
    await writeFakeState(run.deps.paths);
    const error = await runProvision(run.deps, { services: run.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "Hetzner Cloud has a server named shop (id 4711) without OpsCrew's tag, which the infrastructure state lacks.",
      ),
      hint: "Rename the server in the Hetzner Cloud Console if it is not the app's, or remove it there if it is a leftover; then run `opscrew provision` again.",
    });
    expect((error as Error).message).toContain("no server was bought");
    expect(run.engine.calls).not.toContain("plan");
  });

  it("stops when several servers have the app's name", async () => {
    const provider = fakeServers([
      { id: "1", name: "shop", status: "running" },
      { id: "2", name: "shop", status: "running" },
    ]);
    const run = await setup({ servers: provider.api });
    await writeFakeState(run.deps.paths);
    await expect(runProvision(run.deps, { services: run.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "Hetzner Cloud has 2 servers named shop (ids 1 and 2) that the infrastructure state lacks",
      ),
    });
    expect(run.engine.calls).not.toContain("plan");
  });

  it("never takes over a cancelled server: the plan buys a new one, for another term", async () => {
    const provider = fakeServers([
      { id: "77", name: "shop", status: "running", cancelledUntil: "2026-12-31T00:00:00Z" },
    ]);
    const run = await setup({
      plan: testPlan({ provider: "digitalocean", userSecret: false }),
      engine: new StateEngine({
        changes: DIGITALOCEAN_CREATE,
        planJson: planJsonFor({ provider: "digitalocean" }),
      }),
      servers: provider.api,
    });
    await writeFakeState(run.deps.paths);
    await runProvision(run.deps, { services: run.services });
    const note =
      "DigitalOcean has the Droplet shop (id 77), which the infrastructure state lacks, cancelled until 2026-12-31. OpsCrew cannot take back a cancelled Droplet, so the plan buys a new one, for another term of at least 1 month.";
    expect(run.deps.reporter.text()).toContain(note);
    expect(applyRequest(run.handler)?.details).toContain(note);
    expect(await run.main()).not.toContain("import {");
  });

  it("looks nothing up and says nothing when the state has every server", async () => {
    const provider = fakeServers([{ id: "4711", name: "shop", status: "running" }]);
    const engine = new LostServerEngine();
    engine.inState = [SERVER];
    const run = await setup({ engine, servers: provider.api });
    await writeFakeState(run.deps.paths);
    await runProvision(run.deps, { services: run.services });
    expect(provider.lookups).toEqual([]);
    expect(await run.main()).not.toContain("import {");
    expect(run.deps.reporter.text()).not.toContain("infrastructure state lacks");
  });
});

describe.skipIf(!findExecutable("git"))("provision with credentials as a set", () => {
  it("names the missing ones and stops before anything is called", async () => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean", userSecret: false }),
      env: { SET_ID: "a", SET_SECRET: "b", SET_USER: "c", SET_PASS: undefined },
    });
    const { provider: _fake, ...services } = run.services;
    await expect(runProvision(run.deps, { services })).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message:
        "DigitalOcean needs all of SET_ID, SET_SECRET, SET_USER and SET_PASS: SET_PASS is not set.",
      hint: "The four API credentials; they reach the whole account. Create them at https://set.example/api",
    });
    expect(run.engine.calls).toEqual([]);
  });

  it("names every variable of the set when the provider refuses the apply (403)", async () => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean", userSecret: false }),
      engine: new StateEngine({
        changes: DIGITALOCEAN_CREATE,
        planJson: planJsonFor({ provider: "digitalocean" }),
        applyOk: false,
        applyLog:
          'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 403 (request "r3") You are not authorized to perform this operation',
      }),
    });
    const error = await runProvision(run.deps, { services: run.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as OpsCrewError).hint).toContain(
      "DigitalOcean refused the request, so its API credentials probably lack a permission OpsCrew needs. Create new ones at https://set.example/api, set SET_ID, SET_SECRET, SET_USER and SET_PASS to them, then run `opscrew provision` again.",
    );
  });
});
