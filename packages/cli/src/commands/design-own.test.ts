import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ED25519_FINGERPRINT, FakeHostServer, freshFacts, OWN_IPV4 } from "@opscrew/agents/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
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

/** An analysed example whose interview chose the user's own server. */
async function setup(
  options: { interactive?: boolean; prompts?: ScriptedPrompts; memoryGb?: number } = {},
) {
  project = await tempProject("nextjs-postgres");
  const host = new FakeHostServer(freshFacts({ memoryGb: options.memoryGb ?? 4 }));
  const home = await fakeHome(project);
  const context = () => {
    const ctx = projectContext(project as TempProject, {
      interactive: options.interactive ?? false,
      services: {
        runner: new OwnRunner(),
        ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
      },
    });
    withServices(ctx, { provision: { own: ownServices(host, home) } });
    return ctx;
  };
  const prep = context();
  expect(await run(prep, "analyze", "--no-ai")).toBe(0);
  const answers = path.join(project.dir, "answers.yaml");
  await writeFile(answers, JSON.stringify(ANSWERS));
  expect(await run(prep, "interview", "--answers", answers), prep.errors).toBe(0);
  return { context, host };
}

describe("opscrew design on a server the user owns", () => {
  it("connects with --host-key, inspects the server and plans it without a price", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "design", "--host-key", ED25519_FINGERPRINT), ctx.errors).toBe(0);
    expect(s.host.inspections).toBe(1);
    expect(ctx.output).toContain("Chose the recommended option, own-server.");
    const text = `${ctx.output}${ctx.errors}`;
    expect(text).not.toMatch(/€|\$\d|EUR\b.*per month|prices live from|Prices:/);
    expect(text).toContain("backups are your responsibility");
    const plan = await readArtifact(
      "plan",
      path.join((project as TempProject).root, "opscrew", "plan.yaml"),
    );
    expect(plan.target).toMatchObject({ provider: "own", arch: "amd64", access: "public" });
    expect(JSON.stringify(plan)).not.toContain(OWN_IPV4);
  });

  it("stops before design when nobody can confirm the host key on the first connection", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "design")).toBe(1);
    expect(ctx.errors).toContain(`--host-key ${ED25519_FINGERPRINT}`);
    expect(s.host.inspections).toBe(0);
  });

  it("shows the option table without a price or a budget column value in a terminal", async () => {
    const prompts = new ScriptedPrompts(["own-server"]);
    const s = await setup({ interactive: true, prompts, memoryGb: 1 });
    const ctx = s.context();
    expect(await run(ctx, "design", "--host-key", ED25519_FINGERPRINT), ctx.errors).toBe(0);
    const choice = prompts.calls.find((call) => call.kind === "select");
    expect(choice?.options?.[0]?.label).toBe(
      "Your server: no server price (you already pay for it)",
    );
    expect(ctx.output).toContain("no server price");
    expect(ctx.output).not.toContain("Prices:");
    expect(ctx.output).not.toContain("Your budget:");
    // A server smaller than the app needs is named, with what to do.
    expect(`${ctx.output}${ctx.errors}`).toMatch(/GB of memory/);
  });
});
