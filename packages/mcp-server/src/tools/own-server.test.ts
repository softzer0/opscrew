import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  type OwnServerConnectionInput,
  type OwnServerServices,
  type ProvisionServices,
  portainerPasswordFile,
  readOwnServer,
  recordOwnServer,
} from "@opscrew/agents";
import {
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  forbiddenFetch,
  freshFacts,
  OWN_IPV4,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  preparedServerFacts,
} from "@opscrew/agents/testing";
import type { RemoteExec, ResourceChange } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { writeArtifact } from "@opscrew/plan-schema";
import { defaultScanners } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerDeployTools } from "./deploy";
import { registerDesignTools } from "./design";
import { registerDriftTool } from "./drift";
import { registerInterviewTools } from "./interview";
import { registerPortainerTools } from "./portainer";

type HostFacts = FakeHostServer["facts"];

const adminShell: RemoteExec = {
  host: OWN_IPV4,
  run: async (command) => ({ exitCode: command === "true" ? 0 : 1, stdout: "", stderr: "" }),
};

/** The `shop` app on the user's own server without Postgres; its domain DNS-only on Cloudflare. */
const shopPlan = (o: { deployed?: boolean; portainer?: boolean; cloudflare?: boolean } = {}) =>
  ownPlan({
    postgres: false,
    domain: o.cloudflare ? "shop.example.com" : null,
    proxied: false,
    ...(o.portainer ? { portainer: "local" } : {}),
    ...(o.deployed ? { deployed: true } : {}),
  });

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

type Answer = (params: ElicitRequestFormParams) => ElicitResult;

const approveAll: Answer = (params) => {
  const props = params.requestedSchema.properties;
  if ("confirmation" in props) {
    const phrase = /Type "([^"]+)"/.exec(String(props.confirmation?.title))?.[1] ?? "";
    const typed: ElicitResult = { action: "accept", content: { confirmation: phrase } };
    return typed;
  }
  const approved: ElicitResult = { action: "accept", content: { approve: true } };
  return approved;
};

interface Options {
  elicit?: Answer;
  plan?: ReturnType<typeof ownPlan>;
  /** Record the login (with this pinned key, or none). */
  login?: Partial<OwnServerConnectionInput> | false;
  facts?: (projectId: string) => HostFacts;
  /** Resource changes the fake engine plans (Cloudflare's DNS record for a domain). */
  changes?: ResourceChange[];
}

async function connect(options: Options = {}) {
  const root = await tempDir("opscrew-mcp-own-");
  const bare = await tempDir("opscrew-mcp-own-remote-");
  const home = await tempDir("opscrew-mcp-own-home-");
  const runner = new NodeCommandRunner();
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(path.join(root, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
  await writeFile(path.join(root, ".gitignore"), ".opscrew/\n.env\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "init");
  if (options.plan !== undefined) {
    await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), options.plan);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    OPSCREW_APP_ENV_FILE: undefined,
    HCLOUD_TOKEN: undefined,
    DIGITALOCEAN_TOKEN: undefined,
    OPSCREW_HOME: home,
  };
  const paths = resolveProjectPaths(root, { env });
  if (options.login !== false) {
    await recordOwnServer(paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      ...options.login,
    } as OwnServerConnectionInput);
  }
  const host = new FakeHostServer(options.facts?.(paths.projectId) ?? freshFacts());
  const keyHome = path.join(home, "user");
  await mkdir(keyHome, { recursive: true });
  const own: OwnServerServices = {
    host,
    remote: () => adminShell,
    verifyLogin: async () => true,
    homeDir: keyHome,
  };
  const engine = new FakeEngine({
    changes: options.changes ?? [],
    planJson: { format_version: "1.2", planned_values: { root_module: {} } },
  });
  const github = new FakeGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own,
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: ownRunner(),
    clock: { now: () => new Date("2026-10-14T12:00:00.000Z") },
    cwd: root,
    scanners: () => defaultScanners({ includeExternal: false }),
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerInterviewTools(server, deps);
  registerDesignTools(server, deps, { own });
  registerDeployTools(server, deps, { provisionServices: services });
  registerPortainerTools(server, deps, { services });
  registerDriftTool(server, deps, { services });

  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicited: ElicitRequestFormParams[] = [];
  const answer = options.elicit;
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as ElicitRequestFormParams;
      elicited.push(params);
      return answer(params);
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
    root,
    paths,
    host,
    engine,
    elicited,
    outputs,
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

/** No tool result (what the model sees) names the server's address. */
function expectNoAddress(h: { outputs: CallToolResult[] }) {
  expect(JSON.stringify(h.outputs)).not.toContain(OWN_IPV4);
}

const ANSWERS = {
  provider: "own",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  uptime: "standard",
  dataCriticality: "important",
  "server.host": OWN_IPV4,
  "server.port": 22,
  "server.user": "root",
  "server.key": "agent",
  "server.reachable": true,
};

describe.skipIf(!findExecutable("git"))("MCP tools on a server the user owns", () => {
  it("the interview offers the server questions and keeps the address out of every result", async () => {
    const h = await connect({ login: false });
    const questions = await h.call("opscrew_interview_questions");
    expect(textOf(questions)).toContain("What is your server's address?");
    expect(dataOf(questions).serverQuestions.map((q: { id: string }) => q.id)).toEqual(
      expect.arrayContaining([
        "server.host",
        "server.port",
        "server.user",
        "server.key",
        "server.reachable",
      ]),
    );
    const saved = await h.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(textOf(saved)).toContain("a server the user already has");
    expect((await readOwnServer(h.paths))?.host).toBe(OWN_IPV4);
    // Asked again, the saved address is a default, shown as "your server".
    const again = await h.call("opscrew_interview_questions");
    expect(textOf(again)).toContain("leave server.host out");
    expectNoAddress(h);
  });

  it("design asks the user to confirm the host key in a dialog, then offers the server without a price", async () => {
    const h = await connect({ elicit: approveAll, login: false });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const result = await h.call("opscrew_design_options");
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(h.elicited).toHaveLength(1);
    expect(h.elicited[0]?.message).toContain(ED25519_FINGERPRINT);
    expect((await readOwnServer(h.paths))?.hostKey).toBe(ED25519_FINGERPRINT);
    const text = textOf(result);
    expect(text).toContain("no server price");
    expect(text).not.toMatch(/€|EUR\/month|prices live from|dated price list/);
    expect(dataOf(result).options[0]).not.toHaveProperty("cost");
    expect(dataOf(result).options[0].price).toContain("already pays");

    const selected = await h.call("opscrew_select_design", { optionId: "own-server" });
    expect(selected.isError, textOf(selected)).toBeFalsy();
    expect(textOf(selected)).toContain("no server price");
    expect(dataOf(selected).plan).not.toHaveProperty("cost");
    expect(dataOf(selected).chosen).not.toHaveProperty("cost");
    expect(JSON.stringify(dataOf(selected))).not.toMatch(/"amount"/);
    expect(h.host.inspections).toBe(2);
    expectNoAddress(h);
  });

  it("design refuses to trust a new host key when the client cannot show a dialog", async () => {
    const h = await connect({ login: false });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const result = await h.call("opscrew_design_options");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("npx opscrew design");
    expect(h.host.inspections).toBe(0);
    expect((await readOwnServer(h.paths))?.hostKey).toBeUndefined();
    // A user who declines in the dialog pins nothing either.
    const declined = await connect({ elicit: () => ({ action: "decline" }), login: false });
    await declined.call("opscrew_save_requirements", { answers: ANSWERS });
    const refused = await declined.call("opscrew_design_options");
    expect(refused.isError).toBe(true);
    expect((await readOwnServer(declined.paths))?.hostKey).toBeUndefined();
  });

  it("opscrew_plan returns the host plan's hash; opscrew_apply applies it only after the user's dialog", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan(),
      login: { hostKey: ED25519_FINGERPRINT },
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const hostHash = dataOf(planned).hostPlanHash as string;
    expect(hostHash).toMatch(/^[0-9a-f]{64}$/);
    expect(textOf(planned)).toContain("Host plan for your server");
    expect(textOf(planned)).toContain(`opscrew provision --approve ${hostHash}`);
    expect(h.host.applies).toEqual([]);

    const applied = await h.call("opscrew_apply", { planHash: hostHash });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(h.host.applies).toHaveLength(1);
    expect(h.host.applies[0]?.options.approvedHash).toBe(hostHash);
    const kinds = h.elicited.map((e) => e.message);
    expect(kinds.some((m) => m.includes("Apply the host plan to your server"))).toBe(true);
    expect(textOf(applied)).toContain("backups are your responsibility");
    expectNoAddress(h);
  });

  it("with a Cloudflare domain: two plans, two dialogs (infrastructure, then host), no price", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan({ cloudflare: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      changes: PUBLIC_CHANGES,
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const { planHash, hostPlanHash } = dataOf(planned) as {
      planHash: string;
      hostPlanHash: string;
    };
    expect(planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash).not.toBe(hostPlanHash);
    const text = textOf(planned);
    expect(text).toContain(`planHash ${planHash} and hostPlanHash ${hostPlanHash}`);
    expect(text).not.toMatch(/€|live prices/i);
    expect(dataOf(planned)).not.toHaveProperty("cost");

    const applied = await h.call("opscrew_apply", { planHash, hostPlanHash });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    const kinds = (dataOf(applied).approvals as { kind: string }[])
      .map((d) => d.kind)
      .filter((kind) => kind === "iac-apply" || kind === "host-apply");
    expect(kinds).toEqual(["iac-apply", "host-apply"]);
    expect(h.engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual([planHash]);
    expect(h.host.applies.map((a) => a.options.approvedHash)).toEqual([hostPlanHash]);
    expectNoAddress(h);
  });

  it("declining the host dialog after Cloudflare was applied leaves the server untouched and says so", async () => {
    const decline: Answer = (params) =>
      params.message.includes("host plan") ? { action: "decline" } : approveAll(params);
    const h = await connect({
      elicit: decline,
      plan: shopPlan({ cloudflare: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      changes: PUBLIC_CHANGES,
    });
    const planned = await h.call("opscrew_plan");
    const { planHash, hostPlanHash } = dataOf(planned) as {
      planHash: string;
      hostPlanHash: string;
    };
    const applied = await h.call("opscrew_apply", { planHash, hostPlanHash });
    expect(applied.isError).toBe(true);
    expect(h.engine.applied).toHaveLength(1);
    expect(h.host.applies).toEqual([]);
    expect(textOf(applied)).toContain(
      "The Cloudflare changes are applied; nothing on the user's server was changed.",
    );
  });

  it("passwordLogins is the user's choice for a server with password-only users, as in the CLI", async () => {
    const withPasswords = () => {
      const facts = freshFacts();
      facts.loginUsers = [
        { name: "root", uid: 0, password: false, keys: true },
        { name: "alice", uid: 1000, password: true, keys: false },
      ];
      return facts;
    };
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan(),
      login: { hostKey: ED25519_FINGERPRINT },
      facts: withPasswords,
    });
    const blocked = await h.call("opscrew_plan");
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain("password");

    const planned = await h.call("opscrew_plan", { passwordLogins: "keep" });
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const hostPlanHash = dataOf(planned).hostPlanHash as string;
    expect(textOf(planned)).toContain(`--password-logins keep`);

    const applied = await h.call("opscrew_apply", {
      planHash: hostPlanHash,
      passwordLogins: "keep",
    });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    const sshd = h.host.applies[0]?.plan.steps.find((step) => step.id === "sshd");
    expect(sshd?.params.disablePasswords).toBe(false);
    // The dialog the user approved showed the choice.
    expect(h.elicited.some((e) => e.message.includes("password logins left as they are"))).toBe(
      true,
    );
  });

  it("a declined host plan changes nothing on the server", async () => {
    const decline: Answer = (params) =>
      params.message.includes("host plan") ? { action: "decline" } : approveAll(params);
    const h = await connect({
      elicit: decline,
      plan: shopPlan(),
      login: { hostKey: ED25519_FINGERPRINT },
    });
    const planned = await h.call("opscrew_plan");
    const hostHash = dataOf(planned).hostPlanHash as string;
    const applied = await h.call("opscrew_apply", { planHash: hostHash });
    expect(applied.isError).toBe(true);
    expect(h.host.applies).toEqual([]);
  });

  it("Portainer: status shows no password and no address; enable needs the user's dialog", async () => {
    const h = await connect({
      plan: shopPlan({ deployed: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      facts: preparedServerFacts,
    });
    const refused = await h.call("opscrew_portainer_enable");
    expect(refused.isError).toBe(true);
    // No plan exists yet when it stops, so the refusal names none.
    expect(textOf(refused)).toBe(
      "This MCP client cannot show OpsCrew's approval dialog (MCP elicitation), so OpsCrew changes nothing. Nothing was changed.\n\nNext step: Ask the user to run `npx opscrew portainer enable` in a terminal in the project directory; it shows each plan before it asks.",
    );
    expect(h.host.applies).toEqual([]);

    const ok = await connect({
      elicit: approveAll,
      plan: shopPlan({ deployed: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      facts: preparedServerFacts,
    });
    const enabled = await ok.call("opscrew_portainer_enable");
    expect(enabled.isError, textOf(enabled)).toBeFalsy();
    expect(ok.host.applies).toHaveLength(1);
    const password = (await readFile(portainerPasswordFile(ok.paths), "utf8")).trim();
    expect(ok.host.applies[0]?.options.secrets?.portainerPassword).toBe(password);
    const status = await ok.call("opscrew_portainer_status");
    expect(textOf(status)).toContain("npx opscrew portainer status");
    expect(textOf(status)).toContain("https://localhost:9443");
    expect(JSON.stringify(ok.outputs)).not.toContain(password);
    expectNoAddress(ok);
  });

  it("Portainer: disable refuses deleteData and points to the terminal, deleting nothing", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan({ deployed: true, portainer: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      facts: preparedServerFacts,
    });
    const refused = await h.call("opscrew_portainer_disable", { deleteData: true });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("npx opscrew portainer disable --delete-data");
    expect(h.elicited).toEqual([]);
    expect(h.host.applies).toEqual([]);
    expect(h.engine.applied).toEqual([]);
  });

  describe("opscrew_drift", () => {
    /** A project deployed through the MCP tools (plan, then apply after the user's dialog). */
    async function deployed(elicit: Answer = approveAll) {
      const h = await connect({
        elicit,
        plan: shopPlan(),
        login: { hostKey: ED25519_FINGERPRINT },
        facts: preparedServerFacts,
      });
      const planned = await h.call("opscrew_plan");
      expect(planned.isError, textOf(planned)).toBeFalsy();
      const applied = await h.call("opscrew_apply", { planHash: dataOf(planned).hostPlanHash });
      expect(applied.isError, textOf(applied)).toBeFalsy();
      return h;
    }

    /** Forgets the confirmed host key, as on a computer that never connected to the server. */
    async function unpin(h: Awaited<ReturnType<typeof connect>>) {
      const own = await readOwnServer(h.paths);
      if (own === undefined) throw new Error("no recorded login");
      const { hostKey: _pinned, ...login } = own;
      await recordOwnServer(h.paths, login as OwnServerConnectionInput);
    }

    it("reports how the server differs from OpsCrew's setup, without its address, and changes nothing", async () => {
      const h = await deployed();
      const applies = h.host.applies.length;
      const inspections = h.host.inspections;
      const sshd = h.host.facts.sshd as NonNullable<HostFacts["sshd"]>;
      h.host.facts = { ...h.host.facts, sshd: { ...sshd, permitRootLogin: "yes" } };

      const result = await h.call("opscrew_drift");
      expect(result.isError, textOf(result)).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("Your server differs from what OpsCrew set up");
      expect(text).toContain("PermitRootLogin is yes");
      const data = dataOf(result);
      expect(data.clean).toBe(false);
      expect(data.host.differences.some((d: { area: string }) => d.area === "sshd")).toBe(true);
      expect(h.host.inspections).toBe(inspections + 1);
      expect(h.host.applies).toHaveLength(applies);
      expectNoAddress(h);
      expect(JSON.stringify(result)).not.toMatch(/root@|ssh -p/);
    });

    it("an unconfirmed host key the user declines in the dialog is refused; the model cannot supply one", async () => {
      const declineKey: Answer = (params) =>
        params.message.includes("host key") ? { action: "decline" } : approveAll(params);
      const h = await deployed(declineKey);
      const inspections = h.host.inspections;
      await unpin(h);

      const refused = await h.call("opscrew_drift");
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("did not confirm the server's host key");
      expect(h.elicited.at(-1)?.message).toContain(ED25519_FINGERPRINT);
      // A host key named by the model is not an input: the dialog still decides.
      const supplied = await h.call("opscrew_drift", { hostKey: ED25519_FINGERPRINT });
      expect(supplied.isError).toBe(true);
      expect(h.host.inspections).toBe(inspections);
      expect((await readOwnServer(h.paths))?.hostKey).toBeUndefined();
      expectNoAddress(h);
    });

    it("an unconfirmed host key the user confirms in the dialog is pinned and the server checked", async () => {
      const ok = await deployed();
      await unpin(ok);
      const before = ok.elicited.length;
      const confirmed = await ok.call("opscrew_drift");
      expect(confirmed.isError, textOf(confirmed)).toBeFalsy();
      expect(ok.elicited.slice(before).map((e) => e.message)).toEqual([
        expect.stringContaining(ED25519_FINGERPRINT),
      ]);
      expect((await readOwnServer(ok.paths))?.hostKey).toBe(ED25519_FINGERPRINT);
      expectNoAddress(ok);
    });

    it("refuses an unconfirmed host key when the client cannot show a dialog", async () => {
      const h = await connect({ plan: shopPlan({ deployed: true }), facts: preparedServerFacts });
      const result = await h.call("opscrew_drift");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("npx opscrew drift");
      expect(h.host.inspections).toBe(0);
      expect((await readOwnServer(h.paths))?.hostKey).toBeUndefined();
      expectNoAddress(h);
    });
  });
});
