import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningStdioServer, startStdioServer } from "./stdio";

let running: RunningStdioServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Collects newline-delimited JSON-RPC messages written to `stream`. */
function messages(stream: PassThrough) {
  const received: Array<Record<string, unknown>> = [];
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) received.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  return {
    received,
    async waitFor(id: number) {
      for (let i = 0; i < 200; i++) {
        const found = received.find((m) => m.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No response with id ${id}`);
    },
  };
}

describe("startStdioServer", () => {
  it("speaks MCP over the given streams and logs only to stderr", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-stdio-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const errText: string[] = [];
    stderr.on("data", (chunk: Buffer) => errText.push(chunk.toString("utf8")));
    const out = messages(stdout);

    running = await startStdioServer({
      version: "0.0.0-test",
      stdin,
      stdout,
      stderr,
      cwd: dir,
      env: { OPSCREW_HOME: path.join(dir, ".home") },
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
    });

    const send = (message: unknown) => stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    const init = (await out.waitFor(1)) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("opscrew");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = (await out.waitFor(2)) as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["opscrew_scan", "opscrew_status"]));

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "opscrew_status", arguments: {} },
    });
    const status = (await out.waitFor(3)) as {
      result: { isError?: boolean; structuredContent: { nextStep: string } };
    };
    expect(status.result.isError).toBeFalsy();
    expect(status.result.structuredContent.nextStep).toContain("opscrew_scan");

    // Every line on stdout is a JSON-RPC message; diagnostics went to stderr.
    expect(out.received.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(errText.join("")).toContain("OpsCrew MCP server 0.0.0-test ready");
  });
});
