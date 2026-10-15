import { createHash } from "node:crypto";
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
  type PortainerAccess,
  type PortainerEnvironment,
  type ProvisionOptions,
  type ProvisionResult,
  type runProvision,
  stackPlanFile,
} from "@opscrew/agents";
import { ScriptedRunner } from "@opscrew/agents/testing";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerDeployTools } from "./deploy";
import { registerDesignTools } from "./design";
import { registerInterviewTools } from "./interview";

const HOST = "nas-portainer.home.arpa";
const PORTAINER_URL = `https://${HOST}:9443`;
const FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "3C").join(":")}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const ANSWERS = {
  provider: "portainer",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  uptime: "standard",
  dataCriticality: "important",
  domain: "shop.example.com",
  dnsProvider: "cloudflare",
  "portainer.url": PORTAINER_URL,
  "portainer.environment": "nas",
  "portainer.redeploy": "updater",
  "portainer.web": "tunnel",
};

type Answer = (params: ElicitRequestFormParams) => ElicitResult;
const trust: Answer = (params) => {
  const field = "trust" in params.requestedSchema.properties ? "trust" : "approve";
  const accepted: ElicitResult = { action: "accept", content: { [field]: true } };
  return accepted;
};

/** A Portainer with one Docker environment; records whether the token was sent. */
function fakeAccess() {
  const listed: { token: string; cert?: string }[] = [];
  const environments: PortainerEnvironment[] = [
    { id: 3, name: "nas", kind: "docker", up: true, arch: "arm64" },
  ];
  const access: PortainerAccess = {
    fetchCertificateFingerprint: async () => FINGERPRINT,
    listEnvironments: async (_url, token, cert) => {
      listed.push({ token, ...(cert === undefined ? {} : { cert }) });
      return environments;
    },
  };
  return { access, listed };
}

/**
 * A fake `runProvision` for the user's Portainer: `planOnly` saves a stack plan and describes it;
 * otherwise it asks for that plan's `stack-apply` approval, as provision does.
 */
function fakeProvision() {
  const calls: ProvisionOptions[] = [];
  const run: typeof runProvision = async (deps, options = {}) => {
    calls.push(options);
    const text = `${JSON.stringify({ changes: [{ id: "app-stack", state: "change" }] })}\n`;
    const hash = createHash("sha256").update(text).digest("hex");
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    await writeFile(stackPlanFile(deps.paths, hash), text);
    deps.reporter.info(`Stack plan for your Portainer: 1 to change.\nStack plan hash: ${hash}`);
    if (options.planOnly === true) {
      return { stackPlanHash: hash, applied: false, outputs: {} } satisfies ProvisionResult;
    }
    const decision = await deps.approvals.request({
      kind: "stack-apply",
      title: "Apply the stack plan to your Portainer (1 change)",
      details: `Stack plan hash: ${hash}`,
      planHash: hash,
    });
    if (!decision.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The stack plan was not approved (${decision.reason ?? ""}). Nothing in Portainer was changed.`,
      );
    }
    return { stackPlanHash: hash, stackApplied: true, applied: false, outputs: {} };
  };
  return { run, calls };
}

async function connect(options: { elicit?: Answer; token?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-portainer-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
  const token = options.token ?? fakeSecret("generic-password", "portainer-token");
  const env: Record<string, string | undefined> = {
    OPSCREW_HOME: path.join(dir, "home"),
    PORTAINER_API_KEY: token,
  };
  const forbiddenFetch: FetchLike = async (input) => {
    throw new Error(`Unexpected network call in a test: ${String(input)}`);
  };
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    clock: { now: () => new Date("2026-10-15T12:00:00.000Z") },
    cwd: root,
    tmpDir: dir,
  });
  const { access, listed } = fakeAccess();
  const provision = fakeProvision();
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerInterviewTools(server, deps, { portainerAccess: access });
  registerDesignTools(server, deps);
  registerDeployTools(server, deps, { runProvision: provision.run });
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
    env,
    token,
    listed,
    provision,
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

describe("the MCP tools for the user's existing Portainer", () => {
  it("returns the Portainer questions, never the saved address", async () => {
    const h = await connect({ elicit: trust });
    const first = await h.call("opscrew_interview_questions");
    const data = first.structuredContent as { portainerQuestions: { id: string }[] };
    expect(data.portainerQuestions.map((q) => q.id)).toEqual([
      "portainer.url",
      "portainer.environment",
      "portainer.redeploy",
      "portainer.web",
      "portainer.port",
    ]);
    expect(textOf(first)).toContain("PORTAINER_API_KEY");
    expect(textOf(first)).toContain("never confirm it or pass a fingerprint yourself");

    expect((await h.call("opscrew_save_requirements", { answers: ANSWERS })).isError).toBeFalsy();
    const again = await h.call("opscrew_interview_questions");
    expect(JSON.stringify(again)).not.toContain(HOST);
    expect(textOf(again)).toContain("leave portainer.url out to keep it");
  });

  it("has the user confirm the certificate in a dialog, then lists the environments", async () => {
    const h = await connect({ elicit: trust });
    const saved = await h.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(h.elicited).toHaveLength(1);
    expect(h.elicited[0]?.message).toContain(FINGERPRINT);
    expect(h.elicited[0]?.message).not.toContain(HOST);
    expect(h.elicited[0]?.message).toContain("cannot confirm this for you");
    expect(h.listed).toEqual([{ token: h.token, cert: FINGERPRINT }]);
    expect(textOf(saved)).toContain('the user\'s existing Portainer, environment "nas"');
    for (const output of h.outputs) {
      expect(JSON.stringify(output)).not.toContain(HOST);
      expect(JSON.stringify(output)).not.toContain(h.token);
    }
    const local = JSON.parse(
      await readFile(
        path.join(resolveProjectPaths(h.root, { env: h.env }).stateDir, "server.json"),
        "utf8",
      ),
    );
    expect(local.portainer).toMatchObject({ certFingerprint: FINGERPRINT, environmentId: 3 });
  });

  it("never takes a fingerprint from the tool input and trusts nothing without the dialog", async () => {
    const declined = await connect({ elicit: () => ({ action: "decline" }) });
    const refused = await declined.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(refused.isError).toBe(true);
    expect(declined.listed).toEqual([]);
    expect(textOf(refused)).toContain("npx opscrew interview");

    const noDialogs = await connect();
    const blocked = await noDialogs.call("opscrew_save_requirements", {
      answers: { ...ANSWERS, "portainer.certFingerprint": FINGERPRINT },
    });
    expect(blocked.isError).toBe(true);
    expect(noDialogs.listed).toEqual([]);

    const plain = await connect();
    const noDialog = await plain.call("opscrew_save_requirements", { answers: ANSWERS });
    expect(noDialog.isError).toBe(true);
    expect(plain.listed).toEqual([]);
    expect(textOf(noDialog)).toContain("cannot show the confirmation dialog");
    expect(textOf(noDialog)).toContain("npx opscrew interview");
    expect(JSON.stringify(noDialog)).not.toContain(HOST);
  });

  it("designs without a price or sizes, then plans and applies the stack plan after a dialog", async () => {
    const h = await connect({ elicit: trust });
    expect((await h.call("opscrew_save_requirements", { answers: ANSWERS })).isError).toBeFalsy();
    const options = await h.call("opscrew_design_options");
    expect(options.isError, textOf(options)).toBeFalsy();
    const text = textOf(options);
    expect(text).toContain("no server price");
    for (const absent of ["€", "fits the budget", "prices live from", "vCPU", "GB RAM"]) {
      expect(text).not.toContain(absent);
    }
    const data = options.structuredContent as {
      options: { id: string; cost?: unknown; target: Record<string, unknown> }[];
    };
    expect(data.options[0]?.cost).toBeUndefined();
    expect(data.options[0]?.target).not.toHaveProperty("vcpus");
    expect(data.options[0]?.target).not.toHaveProperty("memoryGb");
    const chosen = await h.call("opscrew_select_design", { optionId: data.options[0]?.id });
    expect(chosen.isError, textOf(chosen)).toBeFalsy();
    expect((chosen.structuredContent as { plan: unknown }).plan).not.toHaveProperty("cost");

    const planned = await h.call("opscrew_plan", { publicImage: true });
    expect(planned.isError, textOf(planned)).toBeFalsy();
    const { stackPlanHash } = planned.structuredContent as { stackPlanHash: string };
    expect(stackPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.provision.calls[0]).toMatchObject({ planOnly: true, publicImage: true });
    expect(textOf(planned)).toContain(
      `opscrew provision --approve ${stackPlanHash} --public-image`,
    );
    expect(textOf(planned)).toContain("Stack plan for your Portainer");

    const before = h.elicited.length;
    const applied = await h.call("opscrew_apply", { planHash: stackPlanHash, publicImage: true });
    expect(applied.isError, textOf(applied)).toBeFalsy();
    expect(h.elicited.length).toBe(before + 1);
    expect(h.elicited.at(-1)?.message).toContain("Apply the stack plan to your Portainer");
    expect(h.provision.calls[1]).toMatchObject({
      approvePlanHashes: [stackPlanHash],
      publicImage: true,
    });
    expect(h.provision.calls[1]).not.toHaveProperty("approvePlanHash");
    expect(textOf(applied)).toContain("Set up the app's stacks in the user's Portainer");
    expect(textOf(applied)).toContain("backups of the app's data volumes are the user's");
    for (const output of h.outputs) expect(JSON.stringify(output)).not.toContain(HOST);
  });

  it("changes nothing when the user declines the stack plan's dialog", async () => {
    let dialogs = 0;
    const h = await connect({
      elicit: (params) => {
        dialogs += 1;
        // Trust the certificate (the first dialog), decline everything after it.
        return dialogs === 1 ? trust(params) : { action: "decline" };
      },
    });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const options = await h.call("opscrew_design_options");
    const id = (options.structuredContent as { options: { id: string }[] }).options[0]?.id;
    await h.call("opscrew_select_design", { optionId: id });
    const planned = await h.call("opscrew_plan");
    const { stackPlanHash } = planned.structuredContent as { stackPlanHash: string };
    const refused = await h.call("opscrew_apply", { planHash: stackPlanHash });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("declined the stack plan");
    expect(textOf(refused)).toContain("nothing in the user's Portainer was changed");
  });

  it("refuses a stack plan hash nothing saved", async () => {
    const h = await connect({ elicit: trust });
    await h.call("opscrew_save_requirements", { answers: ANSWERS });
    const options = await h.call("opscrew_design_options");
    const id = (options.structuredContent as { options: { id: string }[] }).options[0]?.id;
    await h.call("opscrew_select_design", { optionId: id });
    const planned = await h.call("opscrew_plan");
    const { stackPlanHash } = planned.structuredContent as { stackPlanHash: string };
    const wrong = await h.call("opscrew_apply", {
      planHash: stackPlanHash,
      stackPlanHash: "ef".repeat(32),
    });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain("No saved stack plan has the hash");
  });
});
