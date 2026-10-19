import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { DeployPlanSchema, type Retarget, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

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
