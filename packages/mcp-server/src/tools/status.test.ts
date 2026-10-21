import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type OwnServerServices, recordOwnServer, recordServerAddress } from "@opscrew/agents";
import {
  forbiddenFetch,
  OWN_IPV4,
  ownPlan,
  ScriptedRunner,
  SERVER_IPV4,
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

describe("opscrew_status: the app's components (FR-1331)", () => {
  /** A deployed Hetzner plan with a worker, after a deploy `opscrew verify` saw. */
  function deployedPlan() {
    const base = testPlan({ deployed: true, userSecret: false });
    return DeployPlanSchema.parse({
      ...base,
      deployment: { ...base.deployment, lastDeployAt: "2026-10-12T09:00:00.000Z" },
      processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
    });
  }

  async function call(plan: ReturnType<typeof deployedPlan>, stdout: string, exitCode = 0) {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-status-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeArtifact("plan", path.join(dir, "opscrew", "plan.yaml"), plan);
    const env = { OPSCREW_HOME: path.join(dir, "home") };
    await recordServerAddress(resolveProjectPaths(dir, { env }), { ipv4: SERVER_IPV4 });
    const hosts: string[] = [];
    const remote = (host: string): RemoteExec => {
      hosts.push(host);
      return { host, run: async () => ({ exitCode, stdout, stderr: "" }) };
    };
    const deps = resolveMcpDeps({
      version: "0.0.0-test",
      env,
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
      cwd: dir,
    });
    const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
    registerStatusTool(server, deps, { services: { remote } });
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
    expect(hosts).toEqual([SERVER_IPV4]);
    expect(text).toContain(
      [
        "Components:",
        "  The web process (app): running",
        "  The worker (worker): stopped",
        "  PostgreSQL (db): running",
      ].join("\n"),
    );
    expect(text).not.toContain(SERVER_IPV4);
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
        deployment: { ...base.deployment, lastDeployAt: "2026-10-14T12:00:00.000Z" },
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
      deployment: { ...base.deployment, lastDeployAt: "2026-10-12T09:00:00.000Z" },
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
