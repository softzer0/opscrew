import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recordOwnServer, recordServerAddress } from "@opscrew/agents";
import {
  FakeDocker,
  FakeKeptFiles,
  type FakeLogLine,
  forbiddenFetch,
  OWN_IPV4,
  ownPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { MAX_LOG_BYTES, MAX_LOG_LINES, registerLogsTool } from "./logs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The `n`th line of the web process, at 11:00 plus `n` milliseconds on the test day. */
function line(n: number, text: string): FakeLogLine {
  const ms = String(n).padStart(9, "0");
  return { time: `2026-10-11T11:00:00.${ms}Z`, stream: "stdout", text };
}

/**
 * `opscrew_logs` with `args`, on a deployed Hetzner app whose web process logged `lines`; with
 * `own`, on the user's own server whose host key was never confirmed (every connection recorded);
 * `files` are the server's files that the fixed reads of a kept file (`test -e`, `cat`) return.
 */
async function call(
  lines: FakeLogLine[],
  args: Record<string, unknown> = {},
  options: { own?: boolean; files?: Record<string, string> } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-logs-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, "opscrew", "plan.yaml");
  const env = { OPSCREW_HOME: path.join(dir, "home") };
  const paths = resolveProjectPaths(dir, { env });
  const connected: string[] = [];
  if (options.own === true) {
    await writeArtifact("plan", planFile, ownPlan({ deployed: true }));
    // The interview recorded the login, but no host key was confirmed yet.
    await recordOwnServer(paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
    });
  } else {
    await writeArtifact("plan", planFile, testPlan({ deployed: true }));
    await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  }
  const docker = new FakeDocker([{ name: "shop-app-1", project: "shop", service: "app", lines }]);
  const shell = new FakeKeptFiles(options.files, (host) => docker.remote(host));
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerLogsTool(server, deps, {
    services: {
      remote: (host) => {
        connected.push(host);
        return shell.remote(host);
      },
      own: {
        remote: (connection) => {
          connected.push(connection.host);
          return docker.remote(connection.host);
        },
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
    name: "opscrew_logs",
    arguments: args,
  })) as CallToolResult;
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return {
    result,
    text,
    data: result.structuredContent as { lines: { text: string }[]; truncated: boolean },
    docker,
    client,
    connected,
  };
}

describe("opscrew_logs", () => {
  it("is read-only, and returns the latest lines with how far back they go, never following", async () => {
    const { result, text, data, docker } = await call([
      line(1, "listening on 3000"),
      line(2, "GET /api/health 200"),
    ]);
    expect(result.isError).toBeFalsy();
    expect(text).toBe(
      [
        "The oldest line here is from 2026-10-11 11:00 UTC. Each deploy starts new containers, and each keeps up to 30 MB of logs.",
        "2026-10-11T11:00:00.000000001Z app listening on 3000",
        "2026-10-11T11:00:00.000000002Z app GET /api/health 200",
      ].join("\n"),
    );
    expect(data.truncated).toBe(false);
    expect(docker.commands.some((command) => command.includes("--follow"))).toBe(false);
    expect(docker.following).toBe(0);
  });

  it("keeps the newest lines within 64 KiB, with truncated: true", async () => {
    const lines = Array.from({ length: 400 }, (_, n) => line(n, `${n} ${"x".repeat(300)}`));
    const { text, data } = await call(lines, { tail: 400 });
    expect(data.truncated).toBe(true);
    const bytes = data.lines.reduce((sum, l) => sum + Buffer.byteLength(`${l.text}\n`), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(data.lines.length).toBeLessThan(400);
    expect(data.lines.at(-1)?.text).toMatch(/^399 /);
    expect(text).toContain("Only the newest");
  });

  it("never returns more than 500 lines: a bigger tail reads 500 and says it was cut", async () => {
    const lines = Array.from({ length: 700 }, (_, n) => line(n, `line ${n}`));
    const { data, docker } = await call(lines, { tail: 700 });
    expect(data.lines).toHaveLength(MAX_LOG_LINES);
    expect(data.lines.at(-1)?.text).toBe("line 699");
    expect(data.truncated).toBe(true);
    expect(docker.commands).toContain("docker logs --timestamps --tail 500 shop-app-1");
  });

  it("masks a secret the app printed, in the text and the data", async () => {
    const token = fakeSecret("github-pat", "mcp-logs");
    const { text, result } = await call([line(1, `calling GitHub with ${token}`)]);
    expect(text).toContain("calling GitHub with ");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("a large tail with a few lines is not truncated", async () => {
    const { data } = await call([line(1, "a"), line(2, "b")], { tail: 5000 });
    expect(data.lines).toHaveLength(2);
    expect(data.truncated).toBe(false);
  });

  it("is listed as read-only", async () => {
    const { client } = await call([]);
    const { tools } = await client.listTools();
    const tool = tools.find((one) => one.name === "opscrew_logs");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("never connects to an own server whose host key was not confirmed, sending the user to the terminal", async () => {
    const { result, text, connected } = await call([line(1, "x")], {}, { own: true });
    expect(result.isError).toBe(true);
    expect(text).toContain("npx opscrew logs");
    expect(text).toContain("Nothing was read.");
    expect(connected).toEqual([]);
    expect(text).not.toContain(OWN_IPV4);
  });

  it("refuses an unknown part with the names there are", async () => {
    const { result, text } = await call([line(1, "x")], { service: "nope" });
    expect(result.isError).toBe(true);
    expect(text).toContain('The app has no part named "nope".');
  });

  it("with failed: true, returns the failed copy's kept lines, masked, without Docker", async () => {
    const token = fakeSecret("github-pat", "mcp-logs-failed");
    const digest = `sha256:${createHash("sha256").update("mcp failed copy").digest("hex")}`;
    const kept = "/srv/apps/shop/.failed-deploy";
    const { result, text, data, docker } = await call(
      [line(1, "the running version")],
      { failed: true },
      {
        files: {
          [`${kept}/about`]: `image=ghcr.io/example-org/shop@${digest}\ntime=2026-10-31T09:15:00Z\nfailed=health\n`,
          [`${kept}/app.log`]: `2026-10-31T09:14:59.000000002Z crashed with ${token}\n`,
        },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(text.split("\n")[0]).toBe(
      `Lines of the copy of ${digest.slice(0, 19)} that failed its health check at 2026-10-31 09:15 UTC; OpsCrew removed it. \`opscrew logs\` shows the version running now.`,
    );
    expect(data.lines).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^crashed with /) }),
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(SERVER_IPV4);
    expect(docker.commands).toEqual([]);
  });

  it("with failed: true, says so when none are kept", async () => {
    const { result, data, text } = await call([line(1, "x")], { failed: true });
    expect(result.isError).toBeFalsy();
    expect(text).toContain("No failed deploy's lines are kept on the server");
    expect(data.lines).toEqual([]);
  });
});
