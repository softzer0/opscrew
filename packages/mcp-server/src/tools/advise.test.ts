/**
 * `opscrew_advise` (US9): read only, the advise report as text and structured content, no apply;
 * never a token or the server's address. The server, GitHub and the clock are fakes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProposalSchema, type RunAdviseOptions, recordServerAddress } from "@opscrew/agents";
import {
  forbiddenFetch,
  makeRequirements,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerAdviseTool } from "./advise";

const GITHUB_TOKEN = fakeSecret("github-token", "advise");
const MB = 1024 ** 2;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The figures command's answer: 92% of 4 GB in use, the web process well under its limit. */
const FIGURES = [
  "==opscrew-figures:cpus",
  "2",
  "==opscrew-figures:load",
  "0.30 0.30 0.30 1/123 4567",
  "==opscrew-figures:memory",
  "               total        used        free      shared  buff/cache   available",
  "Mem:      4294967296  3951369912   1000     1000  1000  343597384",
  "==opscrew-figures:disk",
  "Filesystem        1-blocks        Used   Available Capacity Mounted on",
  "/dev/sda1      42949672960 12884901888  30064771072      30% /",
  "==opscrew-figures:stats",
  JSON.stringify({ Name: "shop-app-1", CPUPerc: "1.50%", MemUsage: "120MiB / 512MiB" }),
  "==opscrew-figures:inspect",
  JSON.stringify({
    name: "/shop-app-1",
    restarts: 0,
    startedAt: "2026-10-11T08:00:00Z",
    memoryLimit: 512 * MB,
  }),
  "",
].join("\n");

/**
 * The tool on a deployed Hetzner cx23 without backups (important data in the interview): its
 * server answers the figures command and fails every other with ssh's message naming its address;
 * GitHub's token expiry read fails with a message that quotes the token.
 */
async function connect() {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-advise-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const env = { OPSCREW_HOME: path.join(dir, "home"), GITHUB_TOKEN };
  const paths = resolveProjectPaths(dir, { env });
  const base = testPlan({ deployed: true, userSecret: false });
  await writeArtifact(
    "plan",
    paths.files.plan,
    DeployPlanSchema.parse({ ...base, target: { ...base.target, backups: false } }),
  );
  await writeArtifact(
    "requirements",
    paths.files.shared.requirementsBase,
    makeRequirements({ dataCriticality: "important" }),
  );
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, "placeholder for the deploy key file\n");
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) =>
      command.includes("==opscrew-figures:")
        ? { exitCode: 0, stdout: FIGURES, stderr: "" }
        : {
            exitCode: 255,
            stdout: "",
            stderr: `ssh: connect to host ${host} port 22: Connection timed out`,
          },
  });
  const options: RunAdviseOptions = {
    services: { remote },
    github: {
      dependabotAlerts: async () => ({ state: "on", alerts: [] }),
      dependabotPulls: async () => [],
      issuesSince: async () => [],
      tokenExpiry: async () => {
        throw new OpsCrewError("PROVIDER_ERROR", `GitHub refused the token ${GITHUB_TOKEN}.`);
      },
    },
    cloudflare: null,
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner((_command, args) =>
      args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "" },
    ),
    cwd: dir,
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerAdviseTool(server, deps, options);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return { client, paths };
}

describe("opscrew_advise", () => {
  it("is read only, takes projectDir, app and environment, and has no apply", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "opscrew_advise");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "app",
      "environment",
      "projectDir",
    ]);
    expect(tool?.description).toContain("Applying is a terminal command only");
  });

  it("returns the report as text and structured content, changing nothing", async () => {
    const { client, paths } = await connect();
    const before = await readFile(paths.files.plan, "utf8");
    const result = (await client.callTool({ name: "opscrew_advise" })) as CallToolResult;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Advise's proposals, the most urgent first:");
    expect(text).toContain("[size.app.larger]");
    expect(text).toContain("Apply: opscrew advise --apply reliability.app.backups");
    expect(text).toContain("`opscrew addon enable monitoring` gives two weeks of figures");
    const data = result.structuredContent as {
      proposals: unknown[];
      basis: Record<string, unknown>;
      notRead: string[];
    };
    const ids = data.proposals.map((p) => ProposalSchema.parse(p).id);
    expect(ids).toEqual(expect.arrayContaining(["size.app.larger", "reliability.app.backups"]));
    expect(data.basis).toEqual({ app: { kind: "one-reading", at: "2026-10-11T12:00:00.000Z" } });
    expect(data.notRead.join("\n")).toContain("the GitHub token's expiry");
    expect(await readFile(paths.files.plan, "utf8")).toBe(before);
    // Neither the token GitHub's error quoted nor the address ssh's message named.
    const all = JSON.stringify(result);
    expect(all).not.toContain(GITHUB_TOKEN);
    expect(all).not.toContain(SERVER_IPV4);
  });
});
