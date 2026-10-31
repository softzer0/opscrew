import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { FakeHostServer, freshFacts, OWN_IPV4 } from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { withServices } from "../deps";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { fakeHome, OwnRunner, ownServices } from "../ui/__fixtures__/own";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const ANSWERS = [
  "expectedMonthlyUsers: <1k",
  "budgetMonthly: 30 EUR",
  "region: eu-central",
  "uptime: standard",
  "dataCriticality: important",
  "",
].join("\n");

/** Trusts the extra server's host key at its first connection, as the user does in a terminal. */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-10-11T12:00:00.000Z" };
  }
}

/**
 * A designed cloud app whose Postgres the user then placed on the server `name` with `target`, by
 * hand as the guide shows (`servers` and the service's `server`, no network yet). Returns the
 * option design chose.
 */
async function placed(
  p: TempProject,
  name: string,
  target: Record<string, unknown>,
): Promise<string> {
  await writeFile(path.join(p.dir, "answers.yaml"), ANSWERS);
  const ctx = projectContext(p);
  expect(await run(ctx, "analyze", "--no-ai")).toBe(0);
  expect(await run(ctx, "interview", "--answers", path.join(p.dir, "answers.yaml"))).toBe(0);
  expect(await run(ctx, "design")).toBe(0);
  const option = /Chose the recommended option, ([a-z0-9-]+)\./.exec(ctx.output)?.[1] as string;
  const planFile = resolveProjectPaths(p.root, { env: p.env }).files.plan;
  const raw = parse(await readFile(planFile, "utf8"));
  raw.servers = [{ name, target }];
  for (const service of raw.services) if (service.kind === "postgres") service.server = name;
  await writeFile(planFile, stringify(raw));
  return option;
}

/** A designed cloud app whose Postgres the user placed on `home`, a server of theirs. */
const placedOnOwnServer = (p: TempProject) =>
  placed(p, "home", { provider: "own", mode: "vps-compose", arch: "amd64" });

describe("opscrew design with a service placed by hand on a new cloud server", () => {
  it("reads the edit the guide shows, and adds the server and its private network", async () => {
    project = await tempProject("nextjs-postgres");
    const option = await placed(project, "db", {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    });
    const ctx = projectContext(project);
    expect(await run(ctx, "design", "--option", option), ctx.errors).toBe(0);
    const plan = await readArtifact(
      "plan",
      resolveProjectPaths(project.root, { env: project.env }).files.plan,
    );
    expect(plan.servers?.map((server) => server.name)).toEqual(["db"]);
    expect(plan.services.find((service) => service.kind === "postgres")?.server).toBe("db");
    expect(plan.network?.members.map((member) => member.name)).toEqual(["app", "db"]);
    expect(`${ctx.output}${ctx.errors}`).toContain("Server db");
  });
});

describe("opscrew design with a service on a server of the user's", () => {
  it("asks for that server's address and SSH login once in a terminal", async () => {
    project = await tempProject("nextjs-postgres");
    const option = await placedOnOwnServer(project);
    const prompts = new ScriptedPrompts([OWN_IPV4, "22", "root", "agent"]);
    const host = new FakeHostServer(freshFacts({ memoryGb: 2 }));
    const ctx = projectContext(project, {
      interactive: true,
      services: { runner: new OwnRunner(), prompts, approvalHandler: new ApproveAll() },
    });
    withServices(ctx, { provision: { own: ownServices(host, await fakeHome(project)) } });

    expect(await run(ctx, "design", "--option", option), ctx.errors).toBe(0);
    expect(prompts.calls.map((call) => call.message.split("\n")[0])).toEqual([
      "Server home: What is your server's address?",
      expect.stringMatching(/^Server home: /),
      expect.stringMatching(/^Server home: /),
      expect.stringMatching(/^Server home: /),
    ]);
    expect(host.inspections).toBe(1);
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect((await readServerAddresses(paths)).ownServers?.home).toMatchObject({
      host: OWN_IPV4,
      user: "root",
    });
    // Its address stays on this computer.
    expect(await readFile(paths.files.plan, "utf8")).not.toContain(OWN_IPV4);
  });

  it("stops without a terminal, saying to run design in one", async () => {
    project = await tempProject("nextjs-postgres");
    const option = await placedOnOwnServer(project);
    const ctx = projectContext(project);
    expect(await run(ctx, "design", "--option", option), ctx.errors).toBe(1);
    expect(ctx.errors).toContain("Run `opscrew design` in a terminal");
  });
});
