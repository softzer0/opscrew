import { existsSync } from "node:fs";
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
  fakeSharedCloudflare,
  forbiddenFetch,
  freshFacts,
  OWN_IPV4,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  preparedServerFacts,
  TUNNEL_ID,
} from "@opscrew/agents/testing";
import type { RemoteExec, ResourceChange } from "@opscrew/contracts";
import {
  findExecutable,
  NodeCommandRunner,
  OpsCrewError,
  resolveProjectPaths,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultScanners } from "@opscrew/secops";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { type DeployToolOptions, registerDeployTools } from "./deploy";
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
  /** Outputs of the fake engine's state (a tunnel's id and token). */
  outputs?: Record<string, unknown>;
  /** Replaces `runProvision` behind the deploy tools. */
  runProvision?: DeployToolOptions["runProvision"];
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
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
  });
  const github = new FakeGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    sharedCloudflare: fakeSharedCloudflare(),
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
  registerDeployTools(server, deps, {
    provisionServices: services,
    ...(options.runProvision === undefined ? {} : { runProvision: options.runProvision }),
  });
  registerPortainerTools(server, deps, { services });
  registerDriftTool(server, deps, { services });

  const client = new Client(
    { name: "opscrew-test-client", version: "0.0.0" },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const elicited: ElicitRequestFormParams[] = [];
  // The user's answers, which a test may change between calls.
  const user = { answer: options.elicit };
  if (options.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as ElicitRequestFormParams;
      elicited.push(params);
      return (user.answer ?? approveAll)(params);
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
    set answer(answer: Answer) {
      user.answer = answer;
    },
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

  it("with a Cloudflare domain: three plans, three dialogs (Cloudflare, infrastructure, host), no price", async () => {
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan({ cloudflare: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      changes: PUBLIC_CHANGES,
    });
    const planned = await h.call("opscrew_plan");
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const { planHash, hostPlanHash, cloudflarePlanHash } = dataOf(planned) as {
      planHash: string;
      hostPlanHash: string;
      cloudflarePlanHash: string;
    };
    for (const hash of [planHash, hostPlanHash, cloudflarePlanHash]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set([planHash, hostPlanHash, cloudflarePlanHash]).size).toBe(3);
    const text = textOf(planned);
    // The Cloudflare plan comes first, with its text and hash, as in the terminal.
    expect(text).toContain("Cloudflare plan for example.com");
    expect(text).toContain(`Cloudflare plan hash: ${cloudflarePlanHash}`);
    expect(text.indexOf("Cloudflare plan for")).toBeLessThan(text.indexOf("Host plan for"));
    expect(text).toContain(
      `planHash ${planHash} and hostPlanHash ${hostPlanHash} and cloudflarePlanHash ${cloudflarePlanHash}`,
    );
    expect(dataOf(planned).applyCommand).toBe(
      `opscrew provision --approve ${cloudflarePlanHash} --approve ${planHash} --approve ${hostPlanHash}`,
    );
    expect(text).not.toMatch(/€|live prices/i);
    expect(dataOf(planned)).not.toHaveProperty("cost");
    expect(existsSync(h.paths.files.cloudflareRecord)).toBe(false);

    const applied = await h.call("opscrew_apply", { planHash, hostPlanHash, cloudflarePlanHash });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    const kinds = (dataOf(applied).approvals as { kind: string }[])
      .map((d) => d.kind)
      .filter((kind) => kind.endsWith("-apply"));
    expect(kinds).toEqual(["cloudflare-apply", "iac-apply", "host-apply"]);
    expect(h.elicited[0]?.message).toContain(`Cloudflare plan hash: ${cloudflarePlanHash}`);
    expect(textOf(applied)).toContain(`Applied the Cloudflare plan ${cloudflarePlanHash}`);
    expect(dataOf(applied).cloudflarePlanHash).toBe(cloudflarePlanHash);
    expect(existsSync(h.paths.files.cloudflareRecord)).toBe(true);
    expect(h.engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual([planHash]);
    expect(h.host.applies.map((a) => a.options.approvedHash)).toEqual([hostPlanHash]);
    expectNoAddress(h);
  });

  describe("the Cloudflare plan of OpsCrew's shared rules", () => {
    const planWithCloudflare = async (elicit?: Answer, changes = PUBLIC_CHANGES) => {
      const h = await connect({
        ...(elicit === undefined ? {} : { elicit }),
        plan: shopPlan({ cloudflare: true }),
        login: { hostKey: ED25519_FINGERPRINT },
        changes,
      });
      const planned = await h.call("opscrew_plan");
      expect(planned.isError, textOf(planned)).toBeFalsy();
      const hashes = dataOf(planned) as {
        planHash: string;
        hostPlanHash: string;
        cloudflarePlanHash: string;
      };
      return { h, hashes };
    };

    /** Nothing was applied anywhere: Cloudflare, the infrastructure or the server. */
    const expectNothingApplied = (h: Awaited<ReturnType<typeof connect>>) => {
      expect(existsSync(h.paths.files.cloudflareRecord)).toBe(false);
      expect(h.engine.applied).toEqual([]);
      expect(h.host.applies).toEqual([]);
    };

    it("is refused before any dialog when opscrew_apply was given another hash", async () => {
      const { h, hashes } = await planWithCloudflare(approveAll);
      const applied = await h.call("opscrew_apply", {
        ...hashes,
        cloudflarePlanHash: "0".repeat(64),
      });
      expect(applied.isError).toBe(true);
      expect(textOf(applied)).toContain("The Cloudflare plan was not approved");
      expect(h.elicited.some((e) => e.message.includes("Cloudflare plan"))).toBe(false);
      expectNothingApplied(h);
    });

    it("given alone while the infrastructure changes, the infrastructure plan gets its own dialog after it", async () => {
      /** The infrastructure plan's dialog: it shows the plan and its hash. */
      const infrastructure = (message: string) =>
        !message.includes("Cloudflare plan") && message.includes("Plan hash:");
      const declineInfra: Answer = (params) =>
        infrastructure(params.message) ? { action: "decline" } : approveAll(params);
      const declined = await planWithCloudflare(declineInfra);
      const refused = await declined.h.call("opscrew_apply", {
        cloudflarePlanHash: declined.hashes.cloudflarePlanHash,
      });
      expect(refused.isError).toBe(true);
      const messages = declined.h.elicited.map((e) => e.message);
      const cloudflare = messages.findIndex((m) => m.includes("Cloudflare plan hash:"));
      const infra = messages.findIndex((m) => infrastructure(m));
      expect(cloudflare).toBeGreaterThanOrEqual(0);
      expect(infra).toBeGreaterThan(cloudflare);
      expect(existsSync(declined.h.paths.files.cloudflareRecord)).toBe(true);
      expect(declined.h.engine.applied).toEqual([]);

      const { h, hashes } = await planWithCloudflare(approveAll);
      const applied = await h.call("opscrew_apply", {
        cloudflarePlanHash: hashes.cloudflarePlanHash,
      });
      expect(applied.isError, textOf(applied)).toBeFalsy();
      const shown = h.elicited.map((e) => e.message).find((m) => infrastructure(m));
      const hash = /Plan hash: ([0-9a-f]{64})/.exec(shown ?? "")?.[1];
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(h.engine.applied.map((a) => a.approval.approvedPlanHash)).toEqual([hash]);
    });

    it("after the zone the app left was changed, a refused new zone's plan says what is applied", async () => {
      const left = "1".repeat(64);
      const h = await connect({
        elicit: approveAll,
        plan: shopPlan({ cloudflare: true }),
        login: { hostKey: ED25519_FINGERPRINT },
        // The removal from the zone the app left, then the new zone's plan opscrew_plan never showed.
        runProvision: async (phase) => {
          const request = (planHash: string) =>
            phase.approvals.request({
              kind: "cloudflare-apply",
              title:
                "Apply the Cloudflare plan to OpsCrew's shared Cloudflare resources (1 change)",
              details: `Cloudflare plan hash: ${planHash}`,
              planHash,
            });
          expect((await request(left)).approved).toBe(true);
          const refused = await request("2".repeat(64));
          throw new OpsCrewError(
            "APPROVAL_REFUSED",
            `The Cloudflare plan was not approved (${refused.reason}). Nothing in Cloudflare was changed.`,
          );
        },
      });
      const applied = await h.call("opscrew_apply", { cloudflarePlanHash: left });
      expect(applied.isError).toBe(true);
      const text = textOf(applied);
      expect(text).toContain("The Cloudflare plan for the zone the app left is applied.");
      expect(text).not.toContain("Nothing in Cloudflare was changed");
      expect(text).toContain("Call opscrew_plan again");
    });

    it("is refused before any dialog when opscrew_apply was not given its hash", async () => {
      const { h, hashes } = await planWithCloudflare(approveAll);
      const { planHash, hostPlanHash } = hashes;
      const applied = await h.call("opscrew_apply", { planHash, hostPlanHash });
      expect(applied.isError).toBe(true);
      expect(textOf(applied)).toContain("The Cloudflare plan was not approved");
      expect(textOf(applied)).toContain("cloudflarePlanHash");
      expect(h.elicited.some((e) => e.message.includes("Cloudflare plan"))).toBe(false);
      expectNothingApplied(h);
    });

    it("is refused when the client cannot show a dialog, with the terminal command", async () => {
      const { h, hashes } = await planWithCloudflare();
      const applied = await h.call("opscrew_apply", hashes);
      expect(applied.isError).toBe(true);
      expect(textOf(applied)).toContain("cannot show OpsCrew's approval dialog");
      expect(textOf(applied)).toContain(
        `opscrew provision --approve ${hashes.cloudflarePlanHash} --approve ${hashes.planHash} --approve ${hashes.hostPlanHash}`,
      );
      expectNothingApplied(h);
    });

    it("declined in its dialog changes nothing anywhere", async () => {
      const decline: Answer = (params) =>
        params.message.includes("Cloudflare plan") ? { action: "decline" } : approveAll(params);
      const { h, hashes } = await planWithCloudflare(decline);
      const applied = await h.call("opscrew_apply", hashes);
      expect(applied.isError).toBe(true);
      expect(textOf(applied)).toContain("The Cloudflare plan was not approved");
      expect(textOf(applied)).toContain("Nothing was applied");
      expectNothingApplied(h);
    });

    it("returned alone and deleting OpsCrew's rule, it needs only its hash and the app's name typed in its dialog", async () => {
      // No infrastructure change (the DNS record exists): the Cloudflare plan and the host plan.
      const { h, hashes } = await planWithCloudflare(approveAll, []);
      const { hostPlanHash, cloudflarePlanHash } = hashes;
      const first = await h.call("opscrew_apply", { planHash: hostPlanHash, cloudflarePlanHash });
      expect(first.isError, textOf(first)).toBeFalsy();
      // The user merges the deploy pull request.
      const git = new NodeCommandRunner();
      for (const args of [
        ["checkout", "main"],
        ["merge", "--ff-only", "opscrew/deploy-setup"],
        ["push", "origin", "main"],
      ]) {
        expect((await git.run("git", ["-C", h.root, ...args])).exitCode).toBe(0);
      }
      // The app stops blocking probes: its hostname leaves OpsCrew's rule, the only app in it.
      const planFile = path.join(h.root, "opscrew", "plan.yaml");
      const plan = await readArtifact("plan", planFile);
      await writeArtifact("plan", planFile, {
        ...plan,
        security: { ...plan.security, wafCustomRules: false },
      });
      const planned = await h.call("opscrew_plan");
      expect(planned.isError, textOf(planned)).toBeFalsy();
      const again = dataOf(planned);
      expect(again.cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
      // Only the Cloudflare plan changes something now.
      expect(again.planHash).toBeUndefined();
      expect(again.hostPlanHash).toBeUndefined();
      expect(textOf(planned)).toContain(
        `call opscrew_apply with cloudflarePlanHash ${again.cloudflarePlanHash}:`,
      );
      expect(again.applyCommand).toBe(`opscrew provision --approve ${again.cloudflarePlanHash}`);
      expect(textOf(planned)).toContain('the user must type "shop" to approve it.');
      const args = { cloudflarePlanHash: again.cloudflarePlanHash };
      const recorded = () => readFile(h.paths.files.cloudflareRecord, "utf8");
      const before = await recorded();
      expect(before).toContain("opscrew-block-probes");

      // A wrong name in the dialog refuses it; OpsCrew's rule stays.
      h.answer = (params) =>
        "confirmation" in params.requestedSchema.properties
          ? { action: "accept", content: { confirmation: "shopx" } }
          : approveAll(params);
      const wrong = await h.call("opscrew_apply", args);
      expect(wrong.isError).toBe(true);
      expect(textOf(wrong)).toContain("The Cloudflare plan was not approved");
      const dialog = h.elicited.at(-1);
      expect(dialog?.message).toContain(`Cloudflare plan hash: ${again.cloudflarePlanHash}`);
      expect(dialog?.requestedSchema.properties).toHaveProperty("confirmation");
      expect(String(dialog?.requestedSchema.properties.confirmation?.title)).toContain('"shop"');
      expect(await recorded()).toBe(before);

      // Typed right, OpsCrew's rule leaves the zone.
      h.answer = approveAll;
      const applied = await h.call("opscrew_apply", args);
      expect(applied.isError, textOf(applied)).toBeFalsy();
      expect(textOf(applied)).toContain(`Applied the Cloudflare plan ${again.cloudflarePlanHash}`);
      expect(textOf(applied)).toContain("The infrastructure needed no change.");
      expect(h.engine.applied).toEqual([]);
      const record = JSON.parse(await recorded()) as { hostnames: Record<string, string[]> };
      expect(record.hostnames["opscrew-block-probes"] ?? []).toEqual([]);
    });
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
    const { planHash, hostPlanHash, cloudflarePlanHash } = dataOf(planned) as {
      planHash: string;
      hostPlanHash: string;
      cloudflarePlanHash: string;
    };
    const applied = await h.call("opscrew_apply", { planHash, hostPlanHash, cloudflarePlanHash });
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

  it("Portainer on a subdomain: the Cloudflare plan is approved in its own dialog first", async () => {
    const tunnelToken = `eyJ${fakeSecret("cloudflare-token", "portainer-tunnel")}`;
    const h = await connect({
      elicit: approveAll,
      plan: shopPlan({ cloudflare: true, deployed: true }),
      login: { hostKey: ED25519_FINGERPRINT },
      facts: preparedServerFacts,
      changes: PUBLIC_CHANGES,
      outputs: {
        tunnel_id: TUNNEL_ID,
        tunnel_token: tunnelToken,
        portainer_url: "https://portainer.example.com",
      },
    });
    const enabled = await h.call("opscrew_portainer_enable", {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
    });
    expect(enabled.isError, textOf(enabled)).toBeFalsy();
    const cloudflarePlanHash = dataOf(enabled).cloudflarePlanHash as string;
    expect(cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.elicited[0]?.message).toContain(`Cloudflare plan hash: ${cloudflarePlanHash}`);
    expect(textOf(enabled)).toContain(`Applied the Cloudflare plan ${cloudflarePlanHash}`);
    expect(JSON.stringify([h.outputs, h.elicited])).not.toContain(tunnelToken);
    expectNoAddress(h);
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
