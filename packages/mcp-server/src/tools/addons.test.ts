import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CallToolResult,
  type ElicitRequestFormParams,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { recordServerAddress } from "@opscrew/agents";
import {
  FakeAddonServer,
  forbiddenFetch,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerAddonTools } from "./addons";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Approves every plan in its dialog, typing any name asked for (the user). */
function approveAll(params: ElicitRequestFormParams): ElicitResult {
  const props = params.requestedSchema.properties;
  if ("confirmation" in props) {
    const phrase = /Type "([^"]+)"/.exec(String(props.confirmation?.title))?.[1] ?? "";
    return { action: "accept", content: { confirmation: phrase } };
  }
  return { action: "accept", content: { approve: true } };
}

const GRAFANA = {
  metricsUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push",
  metricsUser: "1234567",
  logsUrl: "https://logs-prod-012.grafana.net/loki/api/v1/push",
  logsUser: "7654321",
};

/** The add-on tools on a deployed Hetzner app, with a client that can show dialogs (or not). */
async function connect(options: { env?: Record<string, string>; dialogs?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-addons-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, "opscrew", "plan.yaml");
  await writeArtifact("plan", planFile, testPlan({ deployed: true, userSecret: false }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), ...options.env };
  const paths = resolveProjectPaths(dir, { env });
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  const host = new FakeAddonServer();
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerAddonTools(server, deps, {
    services: { deployRemote: host.shell, applyHost: host.apply },
  });
  const dialogs = options.dialogs ?? true;
  const client = new Client(
    { name: "opscrew-test", version: "0.0.0" },
    dialogs ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicited: ElicitRequestFormParams[] = [];
  if (dialogs) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as ElicitRequestFormParams;
      elicited.push(params);
      return approveAll(params);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const outputs: CallToolResult[] = [];
  return {
    client,
    host,
    paths,
    elicited,
    outputs,
    plan: () => readArtifact("plan", planFile),
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

describe("the add-on tools", () => {
  it("take no token as an input, and status is read-only", async () => {
    const h = await connect();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const enable = byName.get("opscrew_addon_enable");
    expect(
      Object.keys(enable?.inputSchema.properties ?? {}).filter((key) =>
        /token|password/i.test(key),
      ),
    ).toEqual([]);
    expect(enable?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("opscrew_addon_status")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("opscrew_addon_disable")?.annotations?.destructiveHint).toBe(true);
  });

  it("Grafana Cloud without OPSCREW_GRAFANA_CLOUD_TOKEN: says to set it or use the terminal, changing nothing", async () => {
    const h = await connect();
    const result = await h.call("opscrew_addon_enable", { addon: "grafana-cloud", ...GRAFANA });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("which OpsCrew never takes through this chat");
    expect(textOf(result)).toContain(
      "set OPSCREW_GRAFANA_CLOUD_TOKEN in the MCP server's environment and restart it",
    );
    expect(textOf(result)).toContain("`npx opscrew addon enable grafana-cloud` in a terminal");
    expect(h.elicited).toEqual([]);
    expect(h.host.applies).toEqual([]);
  });

  it("Grafana Cloud: the host plan is approved in a dialog, and the token never reaches a result", async () => {
    const token = `glc_${randomBytes(32).toString("hex")}`;
    const h = await connect({ env: { OPSCREW_GRAFANA_CLOUD_TOKEN: token } });
    const result = await h.call("opscrew_addon_enable", { addon: "grafana-cloud", ...GRAFANA });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(h.elicited).toHaveLength(1);
    expect(h.elicited[0]?.message).toContain("Grafana Alloy");
    expect(h.host.applies).toHaveLength(1);
    expect(h.host.applies[0]?.options.secrets?.grafanaCloudToken).toBe(token);
    expect(dataOf(result).hostPlanHashes).toEqual([h.host.applies[0]?.options.approvedHash]);
    expect(textOf(result)).toContain("Grafana Cloud: Grafana Alloy");
    expect((await h.plan()).observability?.grafanaCloud?.enabled).toBe(true);
    expect(JSON.stringify([h.outputs, h.elicited])).not.toContain(token);
  });

  it("refuses to change anything when the client cannot show dialogs", async () => {
    const h = await connect({ dialogs: false });
    const result = await h.call("opscrew_addon_enable", { addon: "beszel" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("npx opscrew addon enable beszel");
    expect(h.host.applies).toEqual([]);
  });

  it("Beszel's hub: disable keeps its history and sends deleting it to the terminal", async () => {
    const h = await connect();
    const enabled = await h.call("opscrew_addon_enable", { addon: "beszel" });
    expect(enabled.isError, textOf(enabled)).toBeFalsy();
    expect(textOf(enabled)).toContain("npx opscrew addon open beszel");

    const status = await h.call("opscrew_addon_status");
    expect(status.isError, textOf(status)).toBeFalsy();
    expect(textOf(status)).toContain("opscrew-beszel-agent-1: running, memory 6.5MiB / 64MiB");

    const disabled = await h.call("opscrew_addon_disable", { addon: "beszel" });
    expect(disabled.isError, textOf(disabled)).toBeFalsy();
    const teardown = h.host.applies.at(-1);
    expect(teardown?.plan.deleteData).not.toBe(true);
    // No dialog asked for the app's name: nothing was deleted.
    expect(
      h.elicited.every((params) => !("confirmation" in params.requestedSchema.properties)),
    ).toBe(true);
    expect(dataOf(disabled).keptHistory).toBe(true);
    expect(textOf(disabled)).toContain(
      "Beszel's history stays on the server. Deleting it needs the app's name typed by the user: ask them to run `npx opscrew addon disable beszel` in a terminal.",
    );
    // Beszel's generated secrets never reach a result.
    const secrets = await readFile(h.paths.files.beszelSecrets, "utf8");
    const { password, token } = JSON.parse(secrets) as { password: string; token: string };
    expect(JSON.stringify([h.outputs, h.elicited])).not.toContain(password);
    expect(JSON.stringify([h.outputs, h.elicited])).not.toContain(token);
  });
});
