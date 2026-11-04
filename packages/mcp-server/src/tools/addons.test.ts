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
import { MONITORING_STATUS_COMMAND, recordServerAddress } from "@opscrew/agents";
import {
  euCatalog,
  FakeAddonServer,
  forbiddenFetch,
  freshFacts,
  ScriptedRunner,
  SERVER_IPV4,
  testKeyMaker,
  testPlan,
} from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { monitoringOf, readArtifact, writeArtifact } from "@opscrew/plan-schema";
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

const NOW = new Date("2026-10-11T12:00:00.000Z");
const GIB = 1024 ** 3;

/**
 * The monitoring stack's answer on the app's server: its containers up, the app's figures 20
 * seconds old and its last log line a minute old, and the disk.
 */
function stackShell(host: string): RemoteExec {
  const seconds = NOW.getTime() / 1000;
  const labels = { app: "shop", env: "prod", server: "app" };
  const stdout = [
    "==opscrew-monitoring:containers",
    "opscrew-monitoring-prometheus-1|running|Up 2 hours (healthy)",
    "opscrew-monitoring-grafana-1|running|Up 2 hours (healthy)",
    "==opscrew-monitoring:memory",
    "opscrew-monitoring-grafana-1|210MiB / 416MiB",
    "==opscrew-monitoring:figures",
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [{ metric: labels, value: [seconds, `${seconds - 20}`] }],
      },
    }),
    "==opscrew-monitoring:logs",
    JSON.stringify({
      status: "success",
      data: { resultType: "matrix", result: [{ metric: labels, values: [[seconds - 60, "12"]] }] },
    }),
    "==opscrew-monitoring:disk",
    "1048576\t/v/prometheus",
    "2048\t/v/loki",
    "",
  ].join("\n");
  return {
    host,
    run: async (command) =>
      command === MONITORING_STATUS_COMMAND
        ? { exitCode: 0, stdout, stderr: "" }
        : { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" },
  };
}

/** The add-on tools on a deployed Hetzner app, with a client that can show dialogs (or not). */
async function connect(
  options: {
    env?: Record<string, string>;
    dialogs?: boolean;
    deployRemote?: (host: string) => RemoteExec;
  } = {},
) {
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
    clock: { now: () => NOW },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  // Monitoring's reads: every server has 2 CPUs, 3.7 GiB, 40 MB of logs a day, 5 containers and
  // 30 GiB free; the network's keys from `keys`.
  const keys = testKeyMaker("mcp-monitoring");
  const figures = [2, 3_900_000, 40_000_000, 5, 30 * GIB].join("\n");
  registerAddonTools(server, deps, {
    services: {
      deployRemote: options.deployRemote ?? host.shell,
      applyHost: host.apply,
      monitoring: {
        remote: async (name) => ({
          host: name,
          run: async () => ({ exitCode: 0, stdout: `${figures}\n`, stderr: "" }),
        }),
        host: {
          inspect: async () => freshFacts(),
          apply: async () => {
            throw new Error("nothing is applied");
          },
        },
        keys,
        catalogFor: async () => euCatalog(),
      },
    },
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
    keys,
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
    for (const name of ["opscrew_addon_enable", "opscrew_addon_disable"]) {
      expect(byName.get(name)?._meta?.["anthropic/requiresUserInteraction"], name).toBe(true);
    }
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
    const disabled = await h.call("opscrew_addon_disable", { addon: "grafana-cloud" });
    expect(disabled.isError).toBe(true);
    expect(textOf(disabled)).toContain("npx opscrew addon disable grafana-cloud");
    expect(h.host.applies).toEqual([]);
  });

  it("Beszel's agent mode without OPSCREW_BESZEL_TOKEN: says to set it or use the terminal, changing nothing", async () => {
    const h = await connect();
    const result = await h.call("opscrew_addon_enable", {
      addon: "beszel",
      mode: "agent",
      hubUrl: "https://beszel.example.com",
      hubKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("which OpsCrew never takes through this chat");
    expect(textOf(result)).toContain(
      "set OPSCREW_BESZEL_TOKEN in the MCP server's environment and restart it",
    );
    expect(textOf(result)).toContain("`npx opscrew addon enable beszel` in a terminal");
    expect(h.elicited).toEqual([]);
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

describe("the add-on tools with monitoring", () => {
  it("take monitoring's on, newServer, metricsDays and logsDays on enable", async () => {
    const h = await connect();
    const { tools } = await h.client.listTools();
    const enable = tools.find((tool) => tool.name === "opscrew_addon_enable");
    expect(Object.keys(enable?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["on", "newServer", "metricsDays", "logsDays"]),
    );
    expect(JSON.stringify(enable?.inputSchema.properties?.addon)).toContain("monitoring");
  });

  it("enable and disable only write the plan, with no dialog, and send provision to the terminal", async () => {
    // A client without dialogs: nothing here needs an approval, as in the CLI.
    const h = await connect({ dialogs: false });
    const enabled = await h.call("opscrew_addon_enable", {
      addon: "monitoring",
      metricsDays: 30,
      logsDays: 14,
    });
    expect(enabled.isError, textOf(enabled)).toBeFalsy();
    const monitoring = monitoringOf(await h.plan());
    expect(monitoring?.where).toEqual({ kind: "server", server: "monitoring" });
    expect(monitoring?.retention).toMatchObject({ metricsDays: 30, logsDays: 14 });
    expect(h.host.applies).toEqual([]);
    const text = textOf(enabled);
    expect(text).toContain("The monitoring stack runs on a server of its own.");
    expect(text).toContain(
      "Nothing changed on any server, account or repository yet. Ask the user to run `npx opscrew provision` in a terminal to set it up",
    );
    expect(text).toContain("Self-hosted monitoring: Prometheus ");
    expect(text).toContain("`npx opscrew addon open monitoring` in a terminal");
    expect(dataOf(enabled)).toMatchObject({ applied: false, hostApplied: false, approvals: [] });

    const disabled = await h.call("opscrew_addon_disable", { addon: "monitoring" });
    expect(disabled.isError, textOf(disabled)).toBeFalsy();
    expect(monitoringOf(await h.plan())).toBeUndefined();
    expect(textOf(disabled)).toContain(
      "Ask the user to run `npx opscrew provision` in a terminal to remove what monitoring installed",
    );
    expect(h.host.applies).toEqual([]);

    // No answer holds the server's public address or one of the network's private keys.
    const answers = JSON.stringify(h.outputs);
    expect(answers).not.toContain(SERVER_IPV4);
    expect(h.keys.made.length).toBeGreaterThan(0);
    for (const pair of h.keys.made) expect(answers).not.toContain(pair.privateKey);
  });

  it("an agents' refusal reaches the answer, and nothing changes", async () => {
    const h = await connect();
    const result = await h.call("opscrew_addon_enable", {
      addon: "monitoring",
      on: "app",
      newServer: true,
    });
    expect(result.isError).toBe(true);
    expect(monitoringOf(await h.plan())).toBeUndefined();
  });

  it("status reads the stack, read-only: each server's last data, the disk and the retention", async () => {
    const h = await connect({ deployRemote: stackShell });
    const on = await h.call("opscrew_addon_enable", { addon: "monitoring", on: "app" });
    expect(on.isError, textOf(on)).toBeFalsy();
    expect(monitoringOf(await h.plan())?.where).toEqual({ kind: "app" });
    const before = await readFile(path.join(h.paths.root, "opscrew", "plan.yaml"), "utf8");

    const status = await h.call("opscrew_addon_status");
    expect(status.isError, textOf(status)).toBeFalsy();
    const text = textOf(status);
    expect(text).toContain("run on the app's server");
    expect(text).toContain(
      "  opscrew-monitoring-grafana-1: running, healthy, memory 210MiB / 416MiB",
    );
    expect(text).toContain("  Disk: figures 1.0 GB, logs 2.0 MB.");
    expect(text).toMatch(/ {2}Kept: figures 15 days \(at most \d+ GB\), logs 7 days\./);
    expect(text).toContain(
      "  server app of shop (prod): figures 20 seconds ago, last log line 1 minute ago",
    );
    expect(dataOf(status).monitoring.reading.servers).toEqual([
      expect.objectContaining({ app: "shop", env: "prod", server: "app", silent: false }),
    ]);
    expect(await readFile(path.join(h.paths.root, "opscrew", "plan.yaml"), "utf8")).toBe(before);
    expect(h.elicited).toEqual([]);
    expect(JSON.stringify(h.outputs)).not.toContain(SERVER_IPV4);
  });
});
