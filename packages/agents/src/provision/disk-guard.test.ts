import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeCatalog, FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import type { CloudProvider, DeployPlan } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  euCatalog,
  FakeEngine,
  FakeGitHub,
  MemoryCatalog,
  offer,
  projectRunner,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { requireNoSmallerDisk } from "./disk-guard";
import { runProvision } from "./run";

const APPLIED = { lastApplyAt: "2026-10-11T12:30:00.000Z", lastPlanHash: "a".repeat(64) };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A deployed plan (Hetzner, nbg1) whose app server is `serverType`, with extra `servers`. */
function deployedPlan(
  serverType: string,
  servers: DeployPlan["servers"] = undefined,
  provider: CloudProvider = "hetzner",
): DeployPlan {
  const plan = testPlan({ provider });
  return {
    ...plan,
    target: { ...plan.target, serverType },
    deployment: APPLIED,
    ...(servers !== undefined ? { servers } : {}),
  } as DeployPlan;
}

function extra(
  name: string,
  location: string,
  serverType: string,
): NonNullable<DeployPlan["servers"]>[number] {
  return {
    name,
    target: { provider: "hetzner", mode: "vps-compose", location, serverType, backups: false },
  };
}

/** A project root whose committed `terraform.tfvars.json` holds `tfvars` (the last render). */
async function rootWith(plan: DeployPlan, tfvars: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-disk-guard-"));
  roots.push(root);
  await mkdir(join(root, plan.infra.dir), { recursive: true });
  await writeFile(join(root, plan.infra.dir, "terraform.tfvars.json"), JSON.stringify(tfvars));
  return root;
}

/** The catalogue fake, recording each provider and location asked for. */
function catalogs(catalog: ComputeCatalog = euCatalog()) {
  const asked: string[] = [];
  return {
    asked,
    catalogFor: async (provider: CloudProvider, location: string) => {
      asked.push(`${provider} ${location}`);
      return catalog;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("requireNoSmallerDisk", () => {
  it("refuses the app's server moving to a type with a smaller disk, before any change", async () => {
    const plan = deployedPlan("cx23");
    const root = await rootWith(plan, { location: "nbg1", server_type: "cx33" });
    const { catalogFor } = catalogs();

    const error = await refusal(
      requireNoSmallerDisk({ root, plan, catalogFor, command: "opscrew provision" }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "Server app can't move from cx33 (80 GB disk) to cx23 (40 GB): Hetzner Cloud can't make a server's disk smaller, and the attempt would leave the server switched off. Set its serverType back to cx33, or pick a type with at least 80 GB of disk. Nothing was changed.",
    );
    expect(error.hint).toContain("opscrew provision");
  });

  it("refuses an extra server's smaller disk and names every one", async () => {
    const plan = deployedPlan("cx23", [extra("db", "nbg1", "cx33"), extra("jobs", "nbg1", "cx23")]);
    const root = await rootWith(plan, {
      location: "nbg1",
      server_type: "cx33",
      db_location: "nbg1",
      db_server_type: "cx43",
      jobs_location: "nbg1",
      jobs_server_type: "cx23",
    });
    const error = await refusal(
      requireNoSmallerDisk({ root, plan, ...catalogs(), command: "opscrew provision" }),
    );
    expect(error.message).toContain("Server app can't move from cx33 (80 GB disk) to cx23 (40 GB)");
    expect(error.message).toContain("Server db can't move from cx43 (160 GB disk) to cx33 (80 GB)");
    expect(error.message).not.toContain("jobs");
    expect(error.message.endsWith("Nothing was changed.")).toBe(true);
  });

  it("says a DigitalOcean Droplet", async () => {
    const plan = deployedPlan("s-1vcpu-2gb", undefined, "digitalocean");
    const root = await rootWith(plan, { location: "fra1", server_type: "s-2vcpu-4gb" });
    const droplet = (id: string, diskGb: number, price: number) =>
      offer({
        id,
        vcpus: 2,
        memoryGb: 4,
        diskGb,
        price,
        provider: "digitalocean",
        location: "fra1",
      });
    const catalog = new MemoryCatalog(
      [droplet("s-1vcpu-2gb", 50, 12), droplet("s-2vcpu-4gb", 80, 24)],
      undefined,
      "digitalocean",
    );
    const { asked, catalogFor } = catalogs(catalog);
    const error = await refusal(
      requireNoSmallerDisk({ root, plan, catalogFor, command: "opscrew provision" }),
    );
    expect(error.message).toBe(
      "Server app can't move from s-2vcpu-4gb (80 GB disk) to s-1vcpu-2gb (50 GB): DigitalOcean can't make a Droplet's disk smaller. Set its serverType back to s-2vcpu-4gb, or pick a type with at least 80 GB of disk. Nothing was changed.",
    );
    expect(asked).toEqual(["digitalocean fra1"]);
  });

  it("still refuses when the current type is no longer sold where the server runs", async () => {
    const plan = deployedPlan("cx23");
    const root = await rootWith(plan, { location: "nbg1", server_type: "cx33" });
    // cx33 is sold only in fsn1 now; its disk is still the type's own.
    const catalog = new MemoryCatalog([
      offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
      offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49, location: "fsn1" }),
    ]);
    const error = await refusal(
      requireNoSmallerDisk({ root, plan, ...catalogs(catalog), command: "opscrew provision" }),
    );
    expect(error.message).toContain("Server app can't move from cx33 (80 GB disk) to cx23 (40 GB)");
  });

  it("lets a larger disk and the same disk through", async () => {
    // cx23 → cx33 grows the disk; cx33 (80 GB) → cpx22 (80 GB) keeps it.
    const plan = deployedPlan("cx33", [extra("db", "nbg1", "cpx22")]);
    const root = await rootWith(plan, {
      location: "nbg1",
      server_type: "cx23",
      db_location: "nbg1",
      db_server_type: "cx33",
    });
    await expect(
      requireNoSmallerDisk({ root, plan, ...catalogs(), command: "opscrew provision" }),
    ).resolves.toEqual([]);
  });

  it("warns, and lets through, a type the catalogue doesn't know", async () => {
    const plan = deployedPlan("cx99");
    const root = await rootWith(plan, { location: "nbg1", server_type: "cx33" });
    const warnings = await requireNoSmallerDisk({
      root,
      plan,
      ...catalogs(),
      command: "opscrew provision",
    });
    expect(warnings).toEqual([
      "Hetzner Cloud's catalogue doesn't list cx99, so OpsCrew couldn't check that server app's new type has at least the disk of cx33. Hetzner Cloud can't make a server's disk smaller, and the attempt would leave the server switched off: check the type before you approve.",
    ]);
  });

  it("lets a new server and a replaced one (another location) through without the catalogue", async () => {
    const plan = deployedPlan("cx23", [extra("db", "nbg1", "cx23")]);
    // The app's server moves to another location (a new server); db is not deployed yet.
    const root = await rootWith(plan, { location: "fsn1", server_type: "cx33" });
    const { asked, catalogFor } = catalogs();
    await expect(
      requireNoSmallerDisk({ root, plan, catalogFor, command: "opscrew provision" }),
    ).resolves.toEqual([]);
    expect(asked).toEqual([]);
  });

  it("checks nothing before the servers exist", async () => {
    const plan = { ...deployedPlan("cx23"), deployment: { lastPlanHash: "b".repeat(64) } };
    const root = await rootWith(plan, { location: "nbg1", server_type: "cx33" });
    const { asked, catalogFor } = catalogs();
    await expect(
      requireNoSmallerDisk({ root, plan, catalogFor, command: "opscrew provision" }),
    ).resolves.toEqual([]);
    expect(asked).toEqual([]);
  });
});

const HCLOUD = fakeSecret("hcloud-token");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake Hetzner API with cx23 (40 GB) and cx33 (80 GB) in nbg1. */
const hetznerApi: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${HCLOUD}`) {
    return json({ error: { message: "bad token" } }, 401);
  }
  if (url.pathname === "/v1/locations") {
    return json({ locations: [{ id: 1, name: "nbg1", country: "DE", city: "Nuremberg" }] });
  }
  if (url.pathname === "/v1/server_types") {
    const price = (net: string) => ({ net, gross: net });
    const type = (id: number, name: string, cores: number, memory: number, disk: number) => ({
      id,
      name,
      cores,
      memory,
      disk,
      cpu_type: "shared",
      architecture: "x86",
      deprecated: false,
      prices: [{ location: "nbg1", price_hourly: price("0.01"), price_monthly: price("5.4900") }],
      locations: [{ id: 1, name: "nbg1", available: true }],
    });
    return json({
      server_types: [type(1, "cx23", 2, 4, 40), type(2, "cx33", 4, 8, 80)],
      meta: { pagination: { page: 1, per_page: 50, next_page: null } },
    });
  }
  return json({ error: { message: "not found" } }, 404);
};

describe.skipIf(!findExecutable("git"))("provision with a smaller disk", () => {
  it("stops before the IaC engine, any approval or any file, and leaks no token", async () => {
    const plan = deployedPlan("cx23");
    const project = await createProject(plan);
    roots.push(project.root, project.bare);
    const tfvarsFile = join(project.root, plan.infra.dir, "terraform.tfvars.json");
    const tfvars = `${JSON.stringify({ location: "nbg1", server_type: "cx33" })}\n`;
    await mkdir(join(project.root, plan.infra.dir), { recursive: true });
    await writeFile(tfvarsFile, tfvars);
    const engine = new FakeEngine();
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await createTestPhaseDeps({
      root: project.root,
      env: {
        ...process.env,
        OPSCREW_HOME: join(project.root, ".home-opscrew"),
        HCLOUD_TOKEN: HCLOUD,
      },
      runner: projectRunner(),
      approvalHandler: handler,
      fetch: hetznerApi,
    });
    deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
    let engineAsked = false;

    const error = await refusal(
      runProvision(deps, {
        services: {
          engine: async () => {
            engineAsked = true;
            return engine;
          },
          provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
          github: new FakeGitHub(),
        },
      }),
    );
    expect(error.message).toContain(
      "Server app can't move from cx33 (80 GB disk) to cx23 (40 GB): Hetzner Cloud can't make a server's disk smaller",
    );
    expect(error.message.endsWith("Nothing was changed.")).toBe(true);
    expect(engineAsked).toBe(false);
    expect(engine.calls).toEqual([]);
    expect(handler.requests).toEqual([]);
    await expect(readFile(tfvarsFile, "utf8")).resolves.toBe(tfvars);
    await expect(readFile(join(project.root, plan.infra.dir, "main.tf"), "utf8")).rejects.toThrow();
    const printed = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}\n${error.message}\n${error.hint}`;
    expect(printed).not.toContain(HCLOUD);
  });
});
