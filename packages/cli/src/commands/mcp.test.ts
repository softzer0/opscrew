import { PassThrough } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Collects the newline-delimited JSON-RPC messages written to `stream`. */
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
    async waitFor(id: number) {
      for (let i = 0; i < 300; i++) {
        const found = received.find((m) => m.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No response with id ${id}`);
    },
  };
}

describe("opscrew mcp", () => {
  it("serves MCP on the given streams, logs to stderr and stops when stdin closes", async () => {
    project = await tempProject();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = messages(stdout);
    const ctx = projectContext(project);
    withServices(ctx, { mcp: { stdin, stdout } });

    const exit = run(ctx, "mcp");
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
    const init = (await out.waitFor(1)) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(init.result.serverInfo).toMatchObject({ name: "opscrew", version: ctx.version });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = (await out.waitFor(2)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toContain("opscrew_scan");

    stdin.end();
    expect(await exit).toBe(0);
    expect(ctx.output).toBe("");
    expect(ctx.errors).toContain("[opscrew mcp] OpsCrew MCP server");
    expect(ctx.errors).toContain(`(project: ${project.root})`);
    expect(ctx.errors).toContain("server stopped");
  });
});
