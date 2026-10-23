import { rm, writeFile } from "node:fs/promises";
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
import { listRunnerHosts, type RunnerHostServices } from "@opscrew/agents";
import {
  createProject,
  FakeRunnerMachine,
  forbiddenFetch,
  freshFacts,
  MACHINE_IPV4,
  projectRunner,
  readyRemote,
} from "@opscrew/agents/testing";
import type { CommandRunner } from "@opscrew/contracts";
import { findExecutable, resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerRunnerHostTools } from "./runners";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
// biome-ignore lint/suspicious/noExplicitAny: structured content is loosely typed JSON.
const dataOf = (result: CallToolResult) => result.structuredContent as Record<string, any>;

type Answer = (params: ElicitRequestFormParams) => ElicitResult;

/** Approves every dialog, typing the phrase a dialog asks for. */
const approveAll: Answer = (params) => {
  const phrase = /type "([^"]+)" exactly/i.exec(params.message)?.[1];
  const content: Record<string, string | boolean> =
    phrase === undefined ? { approve: true } : { confirmation: phrase };
  return { action: "accept", content };
};

/** A machine OpsCrew set up before: its deploy user, created by OpsCrew. */
function setUpFacts() {
  const fresh = freshFacts({
    user: "ana",
    addresses: [{ interface: "eth0", family: "ipv4", address: MACHINE_IPV4, public: false }],
  });
  return {
    ...fresh,
    deployUser: { groups: ["deploy", "docker"], keys: [] },
    record: {
      schemaVersion: 1 as const,
      apps: [],
      opscrewVersion: "0.0.0-test",
      changes: [
        {
          step: "deploy-user" as const,
          purpose: "setup" as const,
          at: "2026-10-22T12:00:00.000Z",
          previous: { existed: false },
        },
      ],
    },
  };
}

/** A git project and an MCP client; `elicit` answers its dialogs (none: no dialogs). */
async function connect(options: { elicit?: Answer } = {}) {
  const project = await createProject();
  cleanups.push(() => rm(project.root, { recursive: true, force: true, maxRetries: 3 }));
  cleanups.push(() => rm(project.bare, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(project.root, "..", `${path.basename(project.root)}-home`);
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const env = { OPSCREW_HOME: home };
  // `off`: the machine stops answering SSH (ssh-keyscan finds nothing).
  const network = { off: false };
  const scripted = projectRunner();
  const runner: CommandRunner = {
    run: async (command, args, o) =>
      network.off && path.basename(command).replace(/\.exe$/i, "") === "ssh-keyscan"
        ? { exitCode: 1, stdout: "", stderr: "" }
        : scripted.run(command, args, o),
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner,
    clock: { now: () => new Date("2026-10-22T12:00:00.000Z") },
    cwd: project.root,
  });
  const host = new FakeRunnerMachine();
  const machine: RunnerHostServices = {
    host,
    remote: (login) => readyRemote(login.host),
    verifyLogin: async () => true,
  };
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerRunnerHostTools(server, deps, { machine });
  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.elicit === undefined ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  const elicited: string[] = [];
  const answer = options.elicit;
  if (answer !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as ElicitRequestFormParams;
      elicited.push(params.message);
      return answer(params);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    root: project.root,
    paths: resolveProjectPaths(project.root, { env }),
    client,
    host,
    network,
    elicited,
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
  };
}

const HOME = { name: "home", user: "ana", host: MACHINE_IPV4 };

/** The runner machines this computer records for the project, by name. */
async function known(h: { paths: Parameters<typeof listRunnerHosts>[0]["paths"] }) {
  return (await listRunnerHosts(h)).map((machine) => machine.name);
}

describe.skipIf(!findExecutable("git"))("the runner machine tools", () => {
  it("lists add, set, remove and list; add, set and remove ask the user on every call", async () => {
    const h = await connect();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("opscrew_runner_host_list")?.annotations?.readOnlyHint).toBe(true);
    for (const name of [
      "opscrew_runner_host_add",
      "opscrew_runner_host_set",
      "opscrew_runner_host_remove",
    ]) {
      expect(byName.get(name)?._meta, name).toMatchObject({
        "anthropic/requiresUserInteraction": true,
      });
    }
    expect(byName.get("opscrew_runner_host_remove")?.annotations?.destructiveHint).toBe(true);
    // Nobody passes a host key for the user: it is confirmed in a dialog.
    expect(
      Object.keys(byName.get("opscrew_runner_host_add")?.inputSchema.properties ?? {}).sort(),
    ).toEqual(["harden", "host", "keyFile", "name", "port", "projectDir", "sshFrom", "user"]);
    expect(
      Object.keys(byName.get("opscrew_runner_host_set")?.inputSchema.properties ?? {}).sort(),
    ).toEqual(["harden", "name", "noHarden", "projectDir", "sshFrom"]);
  });

  it("sets a machine up once the user confirms its host key and approves its host plan", async () => {
    const h = await connect({ elicit: approveAll });
    const empty = await h.call("opscrew_runner_host_list");
    expect(textOf(empty)).toContain("This computer knows no runner machine for this project.");

    const added = await h.call("opscrew_runner_host_add", HOME);
    expect(added.isError, textOf(added)).toBeFalsy();
    // First the host key, then the host plan with its hash.
    expect(h.elicited[0]).toContain("Trust the SSH host key of the runner machine home");
    expect(h.elicited[1]).toContain("Set up the runner machine home: Docker and the deploy user");
    const hash = dataOf(added).hostPlanHash as string;
    expect(h.elicited[1]).toContain(hash);
    expect(h.host.applies.map((a) => a.options.approvedHash)).toEqual([hash]);
    expect(textOf(added)).toContain(`Set up the runner machine home (host plan ${hash}).`);
    expect(textOf(added)).toContain('runner "host", runnerHost "home"');

    const listed = await h.call("opscrew_runner_host_list");
    expect(textOf(listed)).toContain(
      "- home: amd64, Docker installed, no hardening chosen, no environment's deploy job",
    );
    expect(JSON.stringify(listed)).not.toContain(MACHINE_IPV4);
  });

  it("never shows a recorded machine's address in a reply", async () => {
    const h = await connect({ elicit: approveAll });
    expect((await h.call("opscrew_runner_host_add", HOME)).isError).toBeFalsy();
    // A damaged record of another machine does not stop this one's address from being hidden.
    await writeFile(path.join(h.paths.projectHomeDir, "runner-hosts", "broken.json"), "{");
    h.network.off = true;
    const unreachable = await h.call("opscrew_runner_host_add", HOME);
    expect(unreachable.isError).toBe(true);
    expect(textOf(unreachable)).toContain("OpsCrew could not reach SSH on the runner machine home");
    expect(textOf(unreachable)).toContain("your runner machine");
    expect(JSON.stringify(unreachable)).not.toContain(MACHINE_IPV4);
  });

  it("changes nothing when the user declines the host plan, and offers no --approve", async () => {
    const decline: Answer = (params) =>
      params.message.includes("Set up the runner machine")
        ? { action: "decline" }
        : approveAll(params);
    const h = await connect({ elicit: decline });
    const refused = await h.call("opscrew_runner_host_add", HOME);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("Nothing on the runner machine home was changed.");
    expect(textOf(refused)).toContain(
      "Call opscrew_runner_host_add again only when the user asks, or ask them to run `npx opscrew runner host add home --ssh <user@host[:port]>`",
    );
    expect(JSON.stringify(refused)).not.toContain("--approve");
    expect(h.host.applies).toEqual([]);
  });

  it("refuses without dialogs, naming the terminal command without the address", async () => {
    const h = await connect();
    const refused = await h.call("opscrew_runner_host_add", HOME);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(
      "`npx opscrew runner host add home --ssh <user@host[:port]>`",
    );
    expect(textOf(refused)).not.toContain(MACHINE_IPV4);
    expect(await known(h)).toEqual([]);
  });

  it("removes a machine only once the user typed its name in the dialog", async () => {
    const wrong: Answer = (params) =>
      params.message.includes("Take back")
        ? { action: "accept", content: { confirmation: "hom" } }
        : approveAll(params);
    const h = await connect({ elicit: wrong });
    expect((await h.call("opscrew_runner_host_add", HOME)).isError).toBeFalsy();
    h.host.facts = setUpFacts();
    const refused = await h.call("opscrew_runner_host_remove", { name: "home" });
    expect(refused.isError).toBe(true);
    const dialog = h.elicited.find((message) => message.includes("Take back"));
    expect(dialog).toContain('To approve, type "home" exactly.');
    expect(JSON.stringify(refused)).not.toContain("--approve");
    expect(textOf(refused)).toContain(
      "Call opscrew_runner_host_remove again only when the user asks",
    );
    expect(await known(h)).toEqual(["home"]);

    const ok = await connect({ elicit: approveAll });
    expect((await ok.call("opscrew_runner_host_add", HOME)).isError).toBeFalsy();
    ok.host.facts = setUpFacts();
    const removed = await ok.call("opscrew_runner_host_remove", { name: "home" });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect(ok.host.applies.at(-1)?.plan.purpose).toBe("undo");
    expect(textOf(removed)).toContain("OpsCrew no longer keeps the runner machine home");
    expect(await known(ok)).toEqual([]);
  });
});

/** The address OpsCrew reaches the machine from, which the SSH firewall lets in. */
const CLIENT = "203.0.113.7";

describe.skipIf(!findExecutable("git"))("a runner machine's hardening through MCP", () => {
  /** The machine has nft, and OpsCrew reaches it from {@link CLIENT}. */
  function withNft(h: Awaited<ReturnType<typeof connect>>): void {
    h.host.facts = {
      ...h.host.facts,
      sshFirewall: { ...h.host.facts.sshFirewall, nft: true },
      sshClient: { address: CLIENT, port: 22 },
    };
  }

  it("adds SSH hardening and the SSH firewall through the host plan's dialog, and hides the sources in replies", async () => {
    const h = await connect({ elicit: approveAll });
    withNft(h);
    const added = await h.call("opscrew_runner_host_add", {
      ...HOME,
      harden: ["ssh", "firewall"],
      sshFrom: [CLIENT],
    });
    expect(added.isError, textOf(added)).toBeFalsy();
    const dialog = h.elicited[1];
    expect(dialog).toContain(
      "Set up the runner machine home: Docker, the deploy user, SSH hardening and an SSH firewall",
    );
    // The user sees the sources in their own dialog; the replies never name them.
    expect(dialog).toContain(`SSH firewall: port 22 only from ${CLIENT}`);
    const plan = h.host.applies[0]?.plan;
    expect(plan?.steps.map((step) => step.id)).toEqual([
      "docker",
      "deploy-user",
      "sshd",
      "ssh-firewall",
    ]);
    expect(JSON.stringify(added)).not.toContain(CLIENT);
    expect(JSON.stringify(added)).toContain("your address");

    const listed = await h.call("opscrew_runner_host_list");
    expect(textOf(listed)).toContain(
      "- home: amd64, Docker installed, hardening chosen: SSH and SSH firewall",
    );
    expect(dataOf(listed).machines[0].hardened).toEqual(["ssh", "firewall"]);
    expect(JSON.stringify(listed)).not.toContain(CLIENT);
  });

  it("set turns one part off through the host plan's dialog, removing only that part", async () => {
    const h = await connect({ elicit: approveAll });
    withNft(h);
    const both = { ...HOME, harden: ["ssh", "firewall"], sshFrom: [CLIENT] };
    expect((await h.call("opscrew_runner_host_add", both)).isError).toBeFalsy();
    // OpsCrew's table is on the machine now.
    h.host.facts = {
      ...h.host.facts,
      sshFirewall: { ...h.host.facts.sshFirewall, table: "table inet opscrew {}" },
    };
    const set = await h.call("opscrew_runner_host_set", { name: "home", noHarden: ["firewall"] });
    expect(set.isError, textOf(set)).toBeFalsy();
    const removal = h.host.applies.at(-1)?.plan.steps.find((step) => step.id === "ssh-firewall");
    expect(removal?.params.remove).toBe(true);
    expect(h.elicited.at(-1)).toContain("Remove OpsCrew's SSH firewall");
    expect(textOf(set)).toContain("Hardening chosen: SSH.");
    expect((await listRunnerHosts(h))[0]?.harden).toEqual({ ssh: true });
  });

  it("stores a network given with host bits as nft prints it, and hides it in replies", async () => {
    const h = await connect({ elicit: approveAll });
    withNft(h);
    const added = await h.call("opscrew_runner_host_add", {
      ...HOME,
      harden: ["firewall"],
      sshFrom: ["203.0.113.7/24"],
    });
    expect(added.isError, textOf(added)).toBeFalsy();
    expect((await listRunnerHosts(h))[0]?.harden).toEqual({
      firewall: { sshFrom: ["203.0.113.0/24"] },
    });
    expect(h.elicited[1]).toContain("SSH firewall: port 22 only from 203.0.113.0/24");
    for (const source of ["203.0.113.0/24", "203.0.113.7/24"]) {
      expect(JSON.stringify(added)).not.toContain(source);
    }
  });

  it("set names set in its plan and hints", async () => {
    const h = await connect({ elicit: approveAll });
    withNft(h);
    expect((await h.call("opscrew_runner_host_add", HOME)).isError).toBeFalsy();
    const locked = await h.call("opscrew_runner_host_set", {
      name: "home",
      harden: ["firewall"],
      sshFrom: ["198.51.100.0/24"],
    });
    expect(locked.isError).toBe(true);
    expect(textOf(locked)).toContain("then run opscrew runner host set home again");
  });

  it("refuses the firewall without sources plainly, before any dialog", async () => {
    const h = await connect({ elicit: approveAll });
    const refused = await h.call("opscrew_runner_host_add", { ...HOME, harden: ["firewall"] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("OpsCrew never guesses them");
    expect(h.elicited).toEqual([]);
    expect(await known(h)).toEqual([]);
    const nothing = await h.call("opscrew_runner_host_set", { name: "home" });
    expect(textOf(nothing)).toContain("Name what to change: harden or noHarden.");
  });
});
