import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  allocateNetwork,
  type OwnServerServices,
  recordOwnServer,
  recordServerAddress,
} from "@opscrew/agents";
import {
  FakeGitHub,
  forbiddenFetch,
  OWN_IPV4,
  ownPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testKeyMaker,
  testKeyPair,
  testPlan,
} from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { DeployPlanSchema, type Retarget, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { createOpscrewMcpServer } from "../server";
import { registerStatusTool } from "./status";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type AbortStep = NonNullable<Retarget["abort"]>["step"];

/** A DigitalOcean plan in the middle of a move from Hetzner Cloud, at `step`. */
function movingPlan(step: Retarget["step"], abort?: AbortStep) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: {
      provider: "digitalocean",
      mode: "vps-compose",
      location: "fra1",
      serverType: "s-1vcpu-2gb",
      backups: false,
    },
    services: [
      {
        name: "db",
        kind: "postgres",
        version: "17",
        memoryMb: 512,
        enabled: true,
        options: {},
        reason: "The app uses PostgreSQL.",
        licence: "PostgreSQL",
      },
    ],
    externalServices: [],
    cost: {
      monthly: { amount: 12, currency: "USD" },
      breakdown: [{ item: "server", monthly: { amount: 12, currency: "USD" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    retarget: {
      from: {
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cpx22",
          backups: false,
        },
      },
      step,
      ...(abort !== undefined ? { abort: { step: abort } } : {}),
      startedAt: "2026-10-12T09:00:00.000Z",
    },
  });
}

async function status(step: Retarget["step"], abort?: AbortStep) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "opscrew"), { recursive: true });
  await writeArtifact("plan", path.join(dir, "opscrew", "plan.yaml"), movingPlan(step, abort));
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home") },
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const result = (await client.callTool({
    name: "opscrew_status",
    arguments: {},
  })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { text, data: result.structuredContent };
}

const MIB = 1024 ** 2;

/** A stats line as `docker stats --format '{{json .}}'` prints it. */
function stats(name: string, cpu: string, memory: string): string {
  return JSON.stringify({ CPUPerc: cpu, MemUsage: memory, Name: name, MemPerc: "1.00%" });
}

/**
 * The server figures command's output: 2 CPUs, a disk 90% full, the web process at 95% of its
 * 512 MB limit and a worker that restarted twice.
 */
const FIGURES = [
  "==opscrew-figures:cpus",
  "2",
  "==opscrew-figures:load",
  "0.52 0.40 0.31 1/123 4567",
  "==opscrew-figures:memory",
  "               total        used        free      shared  buff/cache   available",
  "Mem:      4000000000  1500000000   500000000     1000000  2000000000  2400000000",
  "==opscrew-figures:disk",
  "Filesystem        1-blocks        Used   Available Capacity Mounted on",
  "/dev/sda1      40000000000 36000000000  4000000000      90% /",
  "==opscrew-figures:stats",
  stats("shop-app-1", "3.25%", "486.4MiB / 512MiB"),
  stats("shop-worker-1", "0.10%", "40MiB / 3.725GiB"),
  "==opscrew-figures:inspect",
  JSON.stringify({
    name: "/shop-app-1",
    restarts: 0,
    startedAt: "2026-10-11T09:59:59Z",
    memoryLimit: 512 * MIB,
  }),
  JSON.stringify({
    name: "/shop-worker-1",
    restarts: 2,
    startedAt: "2026-10-11T11:30:00Z",
    memoryLimit: 0,
  }),
  "",
].join("\n");

describe("opscrew_status: the app's components (FR-1331)", () => {
  /** A deployed Hetzner plan with a worker, after a deploy `opscrew verify` saw. */
  function deployedPlan() {
    const base = testPlan({ deployed: true, userSecret: false });
    return DeployPlanSchema.parse({
      ...base,
      deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
      processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
    });
  }

  /**
   * `opscrew_status` on `plan`, deployed at {@link SERVER_IPV4} with the project's deploy key: the
   * deploy user's shell answers the figures command with {@link FIGURES} and anything else with
   * `stdout`, both exiting with `exitCode`; `github` is the GitHub of `acme/shop`.
   */
  async function call(
    plan: ReturnType<typeof deployedPlan>,
    stdout: string,
    exitCode = 0,
    github?: FakeGitHub,
  ) {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeArtifact("plan", path.join(dir, "opscrew", "plan.yaml"), plan);
    const env = { OPSCREW_HOME: path.join(dir, "home") };
    const paths = resolveProjectPaths(dir, { env });
    await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
    await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
    await writeFile(paths.files.deployKey, "placeholder for the deploy key file\n");
    const hosts: string[] = [];
    const remote = (host: string): RemoteExec => {
      hosts.push(host);
      return {
        host,
        run: async (command) => ({
          exitCode,
          stdout: command.startsWith("export LC_ALL=C") ? FIGURES : stdout,
          stderr: "",
        }),
      };
    };
    // The repository's GitHub remote, for the scheduled check's state.
    const runner = new ScriptedRunner((_command, args) =>
      args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    const deps = resolveMcpDeps({
      version: "0.0.0-test",
      env,
      fetch: forbiddenFetch,
      runner,
      cwd: dir,
      clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    });
    const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
    registerStatusTool(server, deps, {
      services: { remote, ...(github === undefined ? {} : { github }) },
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = (await client.callTool({
      name: "opscrew_status",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    return { text, data: result.structuredContent, hosts };
  }

  it("lists each component and whether it runs, read over SSH, without the server's address", async () => {
    const { text, data, hosts } = await call(
      deployedPlan(),
      "shop-app-1|running\nshop-worker-1|exited\nshop-db-1|running\n",
    );
    // The components, then the figures.
    expect(hosts).toEqual([SERVER_IPV4, SERVER_IPV4]);
    expect(text).toContain(
      [
        "Components:",
        "  The web process (app): running",
        "  The worker (worker): stopped",
        "  PostgreSQL (db): running",
      ].join("\n"),
    );
    expect(text).not.toContain(SERVER_IPV4);
    // The resource figures, read now, with their flags.
    expect(text).toContain(
      [
        "Resources (read now):",
        "  Server: load 0.52, 0.40, 0.31 (1, 5 and 15 minutes) on 2 CPUs; memory 1.5 GB used of 3.7 GB; disk 33.5 GB used, 3.7 GB free of 37.3 GB (90% full)",
        "  The web process (app): CPU 3.3%, memory 486 MB of 512 MB (95%), 0 restarts, started 2 hours ago",
        "  The worker (worker): CPU 0.1%, memory 40 MB (no limit), 2 restarts, started 30 minutes ago",
      ].join("\n"),
    );
    expect(text).toContain("  Warning: The server's disk is 90% full (3.7 GB free).");
    expect(data).toMatchObject({
      resources: {
        server: { cpus: 2, disk: { freeBytes: 4_000_000_000 } },
        containers: [
          { service: "app", restarts: 0, memory: { limitBytes: 512 * MIB } },
          { service: "worker", restarts: 2 },
        ],
      },
    });
    expect((data as { resources: { flags: unknown[] } }).resources.flags).toHaveLength(3);
    expect(data).toMatchObject({
      components: {
        components: [
          { service: "app", running: 1 },
          { service: "worker", containers: 1, running: 0 },
          { service: "db", running: 1 },
        ],
        others: [],
      },
    });
  });

  it("adds the scheduled check's state and open alerts, as text and data", async () => {
    const github = new FakeGitHub();
    github.workflowStates.set("opscrew-check.yml", "disabled_inactivity");
    github.issues.set("opscrew-check", [
      {
        number: 12,
        title: "shop (prod) is down: https://shop.example.com",
        url: "https://github.com/acme/shop/issues/12",
        body: "",
        createdAt: "2026-10-11T11:00:00Z",
      },
    ]);
    const plan = DeployPlanSchema.parse({
      ...deployedPlan(),
      observability: { check: { enabled: true } },
    });
    const { text, data } = await call(plan, "shop-app-1|running\n", 0, github);
    expect(text).toContain("State: off. GitHub turned it off after 60 days without activity");
    expect(text).toContain(
      "    #12 shop (prod) is down: https://shop.example.com: https://github.com/acme/shop/issues/12",
    );
    expect(data).toMatchObject({
      check: {
        workflow: "disabled_inactivity",
        alerts: [{ number: 12, url: "https://github.com/acme/shop/issues/12" }],
      },
    });
  });

  it("a server it cannot read is a note; before a deploy was seen, nothing is read", async () => {
    const failed = await call(deployedPlan(), "", 255);
    expect(failed.text).toContain("Components (from opscrew/plan.yaml):");
    expect(failed.text).toContain("OpsCrew could not check whether they run.");

    const fresh = await call(testPlan({ deployed: true, userSecret: false }), "");
    expect(fresh.hosts).toEqual([]);
    expect(fresh.text).toContain(
      "Components (from opscrew/plan.yaml):\n  The web process (app)\n  PostgreSQL (db)",
    );
  });
});

describe("opscrew_status on a server the user owns", () => {
  it("never connects before the host key was confirmed, and sends the user to the terminal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-own-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const base = ownPlan({ deployed: true });
    await writeArtifact(
      "plan",
      path.join(dir, "opscrew", "plan.yaml"),
      DeployPlanSchema.parse({
        ...base,
        deployment: { ...base.deployment, firstDeployAt: "2026-10-14T12:00:00.000Z" },
      }),
    );
    const env = { OPSCREW_HOME: path.join(dir, "home") };
    // The interview recorded the login, but no host key was confirmed yet.
    await recordOwnServer(resolveProjectPaths(dir, { env }), {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
    });
    const used: string[] = [];
    const runner = new ScriptedRunner();
    const deps = resolveMcpDeps({
      version: "0.0.0-test",
      env,
      fetch: forbiddenFetch,
      runner,
      cwd: dir,
    });
    const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
    registerStatusTool(server, deps, {
      services: {
        own: {
          remote: () => {
            used.push("ssh");
            throw new Error("no SSH in this test");
          },
          host: {
            inspect: async () => {
              used.push("inspect");
              throw new Error("no inspection in this test");
            },
          } as unknown as NonNullable<OwnServerServices["host"]>,
        },
      },
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = (await client.callTool({
      name: "opscrew_status",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Components (from opscrew/plan.yaml):");
    expect(text).toContain("OpsCrew could not check whether they run.");
    expect(text).toContain("Ask the user to run `npx opscrew status` in a terminal");
    expect(text).not.toContain(OWN_IPV4);
    expect(used).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});

describe("opscrew_status during a move", () => {
  it.each(["started", "renamed"] as const)("bills only the current server at %s", async (step) => {
    const { text } = await status(step);
    expect(text).toContain("only the current server is billed");
    expect(text).not.toContain("Both servers are billed");
  });

  it.each(["created", "deployed", "migrated"] as const)(
    "bills both servers at %s",
    async (step) => {
      const { text } = await status(step);
      expect(text).toContain("Both servers are billed until the move is finished or aborted.");
    },
  );

  it("after the switch, names finish as what ends the double bill", async () => {
    const { text } = await status("switched");
    expect(text).toContain(
      "Both servers are billed until `opscrew retarget --finish` deletes the old one.",
    );
  });

  it("while an abort deletes the new server, says to finish the abort", async () => {
    const { text, data } = await status("deployed", "started");
    expect(text).toContain("(being aborted, last abort step: started)");
    expect(text).toContain("Both servers are billed until the abort deletes the new one.");
    expect(text).toContain("Next: A move to DigitalOcean is being aborted.");
    expect(text).toContain("`opscrew retarget --abort` to finish the abort");
    expect(text).not.toContain("to continue it");
    expect(data).toMatchObject({ move: { step: "deployed", abortStep: "started" } });
  });

  it.each(["new-removed", "secrets-restored"] as const)(
    "bills only the previous server once the abort deleted the new one (%s)",
    async (abort) => {
      const { text } = await status("deployed", abort);
      expect(text).toContain("only the previous server is billed");
      expect(text).not.toContain("Both servers are billed");
      expect(text).toContain("`opscrew retarget --abort` to finish the abort");
    },
  );
});

describe("opscrew_status: the proxy, the certificates and the recovery copy (FR-1462)", () => {
  it("shows the proxy, each certificate's expiry and the copy's state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const base = testPlan({ deployed: true, domain: "shop.example.com", userSecret: false });
    await writeArtifact("plan", path.join(dir, "opscrew", "plan.yaml"), {
      ...base,
      dns: { ...base.dns, proxied: false },
      deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
    });
    const deps = resolveMcpDeps({
      version: "0.0.0-test",
      env: { OPSCREW_HOME: path.join(dir, "home") },
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
      clock: { now: () => new Date("2026-10-21T12:00:00.000Z") },
      cwd: dir,
    });
    const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
    registerStatusTool(server, deps, {
      tlsConnect: async () => ({
        subjectAltNames: ["shop.example.com"],
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-12-30T00:00:00.000Z",
        issuer: "Let's Encrypt",
      }),
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = (await client.callTool({
      name: "opscrew_status",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain(
      [
        "Proxy: Caddy",
        "Certificates:",
        "  shop.example.com (from Let's Encrypt): expires 2026-12-30 (69 days left)",
        "Secrets copy: none yet (`opscrew provision` makes it).",
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({
      tls: expect.arrayContaining(["Proxy: Caddy"]),
    });
  });
});

describe("opscrew_status: the private network (FR-1821)", () => {
  it("returns each server, each link, the devices by name and address, and the grants; never a key", async () => {
    const base = testPlan({ deployed: true, userSecret: false });
    const plan = DeployPlanSchema.parse({
      ...base,
      deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
    });
    const keys = testKeyMaker();
    const { network } = allocateNetwork(plan, {}, keys);
    const prefix = network.range.split(".").slice(0, 3).join(".");
    const laptop = testKeyPair("laptop");
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeArtifact(
      "plan",
      path.join(dir, "opscrew", "plan.yaml"),
      DeployPlanSchema.parse({
        ...plan,
        network: {
          ...network,
          devices: [
            {
              name: "laptop",
              address: `${prefix}.100`,
              publicKey: laptop.publicKey,
              addedAt: "2026-10-12T10:00:00.000Z",
            },
          ],
          grants: [{ device: "laptop", service: "db", access: "read-only" }],
        },
      }),
    );
    const env = { OPSCREW_HOME: path.join(dir, "home") };
    await recordServerAddress(resolveProjectPaths(dir, { env }), { ipv4: SERVER_IPV4 });
    const now = new Date("2026-10-12T12:00:00.000Z");
    const shell =
      (stdout: string) =>
      (host: string): RemoteExec => ({
        host,
        run: async () => ({ exitCode: 0, stdout, stderr: "" }),
      });
    const deps = resolveMcpDeps({
      version: "0.0.0-test",
      env,
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
      cwd: dir,
      clock: { now: () => now },
    });
    const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
    registerStatusTool(server, deps, {
      services: { remote: shell("shop-app-1|running\nshop-db-1|running\n") },
      // The login becomes root through Docker; the laptop's last handshake was a minute ago.
      network: {
        remote: async (host) => shell("docker\n")(host),
        readWireGuard: async () => [
          {
            publicKey: laptop.publicKey,
            latestHandshake: new Date(now.getTime() - 60_000),
            allowedIps: [`${prefix}.100/32`],
          },
        ],
      },
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const result = (await client.callTool({
      name: "opscrew_status",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      servers: [expect.objectContaining({ name: "app" })],
      links: [expect.objectContaining({ from: "app", to: "laptop", kind: "device", up: true })],
      devices: [{ name: "laptop", address: `${prefix}.100` }],
      grants: [{ device: "laptop", service: "db", access: "read-only" }],
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain(`Private network (${network.range}):`);
    const everything = JSON.stringify(result);
    for (const key of [laptop.privateKey, ...keys.made.map((pair) => pair.privateKey)]) {
      expect(everything).not.toContain(key);
    }
  });
});
