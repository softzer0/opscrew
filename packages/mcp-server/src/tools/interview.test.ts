import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { forbiddenFetch, ScriptedRunner, testPlan } from "@opscrew/agents/testing";
import type { CommandRunner, FetchLike } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { createOpscrewMcpServer } from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function connect(
  env: Record<string, string>,
  io: { fetch?: FetchLike; runner?: CommandRunner } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-interview-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0" } }),
  );
  const server = createOpscrewMcpServer({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), ...env },
    fetch: io.fetch ?? forbiddenFetch,
    runner: io.runner ?? new ScriptedRunner(),
    cwd: root,
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { call, root };
}

async function questions(env: Record<string, string>) {
  const { call } = await connect(env);
  const result = await call("opscrew_interview_questions");
  const data = result.structuredContent as {
    questions: { id: string; default?: unknown }[];
    inferred: Record<string, unknown>;
  };
  return { result, data };
}

describe("opscrew_interview_questions provider default", () => {
  it("defaults to DigitalOcean when only DIGITALOCEAN_TOKEN is set", async () => {
    const token = fakeSecret("digitalocean-token");
    const { result, data } = await questions({ DIGITALOCEAN_TOKEN: token });
    expect(data.questions.find((q) => q.id === "provider")?.default).toBe("digitalocean");
    expect(data.inferred.provider).toBe("digitalocean");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("defaults to Hetzner when no provider token is set", async () => {
    const { data } = await questions({});
    expect(data.questions.find((q) => q.id === "provider")?.default).toBe("hetzner");
    expect(data.inferred.provider).toBe("hetzner");
  });
});

const ANSWERS = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  region: "eu-central",
  uptime: "best-effort",
  dataCriticality: "none",
};

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

describe("opscrew_interview_questions signing and deploy-tags defaults", () => {
  it("come from plan.yaml when it exists, so a rerun keeps the user's settings there", async () => {
    const { call, root } = await connect({});
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, provider: "hetzner" },
    });
    expect(saved.isError).toBeFalsy();
    const defaults = async () => {
      const result = await call("opscrew_interview_questions");
      const data = result.structuredContent as { questions: { id: string; default?: unknown }[] };
      return Object.fromEntries(data.questions.map((q) => [q.id, q.default]));
    };
    expect(await defaults()).toMatchObject({ signImages: false, deployTags: "off" });

    // Design wrote the plan after the answers; the user then turned both on in plan.yaml.
    const { files } = resolveProjectPaths(root, { env: {} });
    const { answeredAt } = await readArtifact("requirements", files.requirements);
    const minutesAfter = (minutes: number) =>
      new Date(Date.parse(answeredAt) + minutes * 60_000).toISOString();
    const plan = testPlan();
    const edited = {
      ...plan,
      updatedAt: minutesAfter(1),
      supplyChain: { sign: true },
      cicd: { ...plan.cicd, deployTags: { enabled: true, release: true } },
    };
    await writeArtifact("plan", files.plan, edited);
    expect(await defaults()).toMatchObject({ signImages: true, deployTags: "tag-and-release" });
    // Answers newer than the plan win, as at the next design.
    await writeArtifact("plan", files.plan, { ...edited, updatedAt: minutesAfter(-1) });
    expect(await defaults()).toMatchObject({ signImages: false, deployTags: "off" });
  });
});

describe("the interview tools and the app's components", () => {
  it("ask for a worker's command no convention gives, and save the flat answer", async () => {
    const { call, root } = await connect({});
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop", dependencies: { express: "^5.0.0", bullmq: "^5.0.0" } }),
    );
    const listed = await call("opscrew_interview_questions");
    const data = listed.structuredContent as { componentQuestions: { id: string }[] };
    expect(data.componentQuestions.map((q) => q.id)).toEqual(["workerCommands.bullmq"]);
    expect(textOf(listed)).toContain(
      "Which command starts the worker bullmq? (answer id: workerCommands.bullmq)",
    );
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, "workerCommands.bullmq": "node dist/worker.js" },
    });
    expect(saved.isError).toBeFalsy();
    const { files } = resolveProjectPaths(root, { env: {} });
    const requirements = await readArtifact("requirements", files.requirements);
    expect(requirements.workerCommands).toEqual({ bullmq: "node dist/worker.js" });
  });

  it("ask to keep the app's storage or create a bucket, and save Garage chosen on Hetzner", async () => {
    const { call, root } = await connect({});
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "shop",
        dependencies: { express: "^5.0.0", "@aws-sdk/client-s3": "^3" },
      }),
    );
    const listed = await call("opscrew_interview_questions");
    const data = listed.structuredContent as { componentQuestions: { id: string }[] };
    expect(data.componentQuestions.map((q) => q.id)).toEqual([
      "keepExternalServices.s3",
      "objectStorage",
    ]);
    const text = textOf(listed);
    expect(text).toContain(
      "Keep the storage the app uses now for its files? (answer id: keepExternalServices.s3)",
    );
    // Before the target is known, every storage with where it is offered.
    expect(text).toContain(
      "garage = Garage on your server $0.00/month plus 64 MB of the server's memory, with the files on that server only (on the app's server: on a cloud server only if you choose it)",
    );
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, "keepExternalServices.s3": false, objectStorage: "garage" },
    });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("- Object storage: a new bucket in Garage on your server");
    const { files } = resolveProjectPaths(root, { env: {} });
    const requirements = await readArtifact("requirements", files.requirements);
    expect(requirements.keepExternalServices).toEqual({ s3: false });
    expect(requirements.objectStorage).toBe("garage");
    // Asked again, the provider may change in the same answers: still every storage, and the
    // earlier choice as the default.
    const again = await call("opscrew_interview_questions");
    const where = (
      again.structuredContent as {
        componentQuestions: { id: string; options?: unknown[]; default?: unknown }[];
      }
    ).componentQuestions.find((q) => q.id === "objectStorage");
    expect(where?.options).toHaveLength(4);
    expect(where?.default).toBe("garage");
  });
});

describe("opscrew_save_requirements provider summary", () => {
  it("reports DigitalOcean when no provider is given and only DIGITALOCEAN_TOKEN is set", async () => {
    const token = fakeSecret("digitalocean-token");
    const { call } = await connect({ DIGITALOCEAN_TOKEN: token });
    const saved = await call("opscrew_save_requirements", { answers: ANSWERS });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("- Cloud provider: DigitalOcean");
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it("reports Hetzner Cloud when the provider answer is hetzner", async () => {
    const { call } = await connect({ DIGITALOCEAN_TOKEN: fakeSecret("digitalocean-token") });
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, provider: "hetzner" },
    });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("- Cloud provider: Hetzner Cloud");
  });
});

describe("the signing question and the repository's visibility", () => {
  /** A repository whose origin is github.com/acme/shop, a token, and GitHub's answer. */
  function onGitHub(answer: { private: boolean } | "unavailable") {
    const token = fakeSecret("github-pat");
    const urls: string[] = [];
    const fetch: FetchLike = async (input) => {
      urls.push(String(input));
      if (answer === "unavailable") return new Response("unavailable", { status: 503 });
      return Response.json({ default_branch: "main", private: answer.private });
    };
    const runner = new ScriptedRunner((_command, args) =>
      args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "not answered in this test" },
    );
    return { token, urls, io: { fetch, runner } };
  }

  async function signingHelp(answer: { private: boolean } | "unavailable") {
    const setup = onGitHub(answer);
    const { call } = await connect({ GITHUB_TOKEN: setup.token }, setup.io);
    const result = await call("opscrew_interview_questions");
    const data = result.structuredContent as { questions: { id: string; help?: string }[] };
    expect(JSON.stringify(result)).not.toContain(setup.token);
    return { help: data.questions.find((q) => q.id === "signImages")?.help ?? "", setup, call };
  }

  it("says a private repository's name becomes public, in the question and when saved", async () => {
    const { help, setup, call } = await signingHelp({ private: true });
    expect(help).toContain("Your repository is private, but once images are signed");
    expect(setup.urls).toEqual(["https://api.github.com/repos/acme/shop"]);
    const saved = await call("opscrew_save_requirements", {
      answers: { ...ANSWERS, provider: "hetzner", signImages: true },
    });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain("Your repository is private, but once images are signed");
    expect(JSON.stringify(saved)).not.toContain(setup.token);
  });

  it("gives no warning for a public repository", async () => {
    const { help } = await signingHelp({ private: false });
    expect(help).not.toContain("public log");
  });

  it("warns conditionally when GitHub cannot say", async () => {
    const { help } = await signingHelp("unavailable");
    expect(help).toContain("If your repository is private, its name");
  });
});
