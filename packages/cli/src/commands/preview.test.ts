/**
 * `opscrew preview list|logs|destroy` (US6) and `verify` of a preview environment: through the
 * preview server's command over a fake deploy shell; never the server's address or a secret.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordServerAddress } from "@opscrew/agents";
import { ScriptedApprovalHandler, SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { servicesOf } from "../deps";
import { withEnvironments } from "../ui/__fixtures__/environments";
import { projectContext, run, type TempProject } from "../ui/__fixtures__/harness";

const HCLOUD_TOKEN = fakeSecret("hcloud-token", "previews");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"ab".repeat(32)}`;
/** Previews 42 (running, created 2026-10-10, updated 2026-10-11) and 7 (failed), cap 3. */
const LIST_OUTPUT = [
  `42 running ${COMMIT} 1791590400 1791676800 ${DIGEST}`,
  `7 failed ${COMMIT} 1791590400 1791590400 ${DIGEST}`,
  "opscrew-preview: listed 2/3",
].join("\n");
const COMMAND = "/srv/apps/shop-preview/bin/opscrew-preview";

/** The preview environment's plan beside prod, as design makes it (previews under shop.example.com). */
function previewPlan(): DeployPlan {
  const base = testPlan({ deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "shop-preview" },
    environment: {
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: "shop.example.com", seed: null },
    },
    infra: { ...base.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
    supplyChain: { ...base.supplyChain, sign: false },
    cicd: {
      ...base.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/**
 * prod and the preview environment, its server's address and deploy key on this computer, and
 * a deploy shell that answers each command with `answer` (the commands are kept).
 */
async function previewProject(
  answer: (command: string) => { exitCode: number; stdout: string; stderr?: string },
  options: { interactive?: boolean; approvals?: ScriptedApprovalHandler } = {},
) {
  project = await withEnvironments({ preview: previewPlan() });
  project.env.HCLOUD_TOKEN = HCLOUD_TOKEN;
  const paths = resolveProjectPaths(project.root, { env: project.env, environment: "preview" });
  await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
  await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, "placeholder\n");
  const commands: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) => {
      commands.push(command);
      return { stderr: "", ...answer(command) };
    },
  });
  const ctx = projectContext(project, {
    interactive: options.interactive ?? false,
    services: {
      provision: { remote },
      verify: {
        remote,
        tlsConnect: async () => {
          throw new Error("no preview runs, so no certificate is read");
        },
      },
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
    },
  });
  return { ctx, commands };
}

/** Neither the server's address nor the token in what the run printed. */
function expectNoLeak(text: string) {
  expect(text).not.toContain(SERVER_IPV4);
  expect(text).not.toContain(HCLOUD_TOKEN);
}

describe("opscrew preview list", () => {
  it("lists the previews from the server, read-only", async () => {
    const { ctx, commands } = await previewProject(() => ({
      exitCode: 0,
      stdout: `${LIST_OUTPUT}\n`,
    }));
    expect(await run(ctx, "preview", "list", "--env", "preview"), ctx.errors).toBe(0);
    expect(commands).toEqual([`${COMMAND} list`]);
    expect(ctx.output).toContain("Previews: 2 of at most 3.");
    expect(ctx.output).toContain(
      "  pr-42: https://pr-42.shop.example.com, running, commit 0123456",
    );
    expect(ctx.output).toContain("  pr-7: https://pr-7.shop.example.com, failed");
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("--json prints only the list", async () => {
    const { ctx } = await previewProject(() => ({ exitCode: 0, stdout: `${LIST_OUTPUT}\n` }));
    expect(await run(ctx, "preview", "list", "--env", "preview", "--json"), ctx.errors).toBe(0);
    const list = JSON.parse(ctx.output) as { count: number; cap: number; previews: unknown[] };
    expect(list).toMatchObject({
      count: 2,
      cap: 3,
      previews: [
        { number: 42, state: "running", address: "https://pr-42.shop.example.com" },
        { number: 7, state: "failed" },
      ],
    });
  });

  it("refuses an environment without previews, and a script that names none of several", async () => {
    const { ctx, commands } = await previewProject(() => ({ exitCode: 0, stdout: LIST_OUTPUT }));
    expect(await run(ctx, "preview", "list", "--env", "prod")).not.toBe(0);
    expect(ctx.errors).toContain("The prod environment has no previews");
    const bare = projectContext(project as TempProject);
    expect(await run(bare, "preview", "list")).not.toBe(0);
    expect(bare.errors).toContain("--env");
    expect(commands).toEqual([]);
  });

  it("says when the server does not answer, without its address", async () => {
    const { ctx } = await previewProject(() => ({
      exitCode: 255,
      stdout: "",
      stderr: `ssh: connect to host ${SERVER_IPV4} port 22: Connection refused`,
    }));
    expect(await run(ctx, "preview", "list", "--env", "preview")).not.toBe(0);
    expect(ctx.errors).toContain("did not answer over SSH");
    expectNoLeak(ctx.output + ctx.errors);
  });
});

describe("opscrew preview logs", () => {
  it("prints a preview's lines, redacted", async () => {
    const { ctx, commands } = await previewProject(() => ({
      exitCode: 0,
      stdout: `web-1 | listening on 3000\nweb-1 | token ${HCLOUD_TOKEN}\nopscrew-preview: listed 2\n`,
    }));
    expect(await run(ctx, "preview", "logs", "42", "--env", "preview"), ctx.errors).toBe(0);
    expect(commands).toEqual([`${COMMAND} logs 42`]);
    expect(ctx.output).toContain("web-1 | listening on 3000");
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("refuses what is not a pull request's number, running nothing", async () => {
    const { ctx, commands } = await previewProject(() => ({ exitCode: 0, stdout: "" }));
    expect(await run(ctx, "preview", "logs", "42;id", "--env", "preview")).not.toBe(0);
    expect(ctx.errors).toContain("is not a pull request number");
    expect(commands).toEqual([]);
  });
});

describe("opscrew preview destroy", () => {
  const removed = (command: string) =>
    command.endsWith("down 42")
      ? { exitCode: 0, stdout: "opscrew-preview: removed 42\n" }
      : { exitCode: 1, stdout: "" };

  it("in a script, removes a preview only with --confirm pr-<n>", async () => {
    const { ctx, commands } = await previewProject(removed);
    expect(await run(ctx, "preview", "destroy", "42", "--env", "preview")).toBe(1);
    expect(ctx.errors).toContain("--confirm pr-42");
    expect(
      await run(ctx, "preview", "destroy", "42", "--env", "preview", "--confirm", "pr-7"),
    ).toBe(1);
    expect(commands).toEqual([]);
    const args = ["preview", "destroy", "42", "--env", "preview", "--confirm", "pr-42"];
    expect(await run(ctx, ...args), ctx.errors).toBe(0);
    expect(commands).toEqual([`${COMMAND} down 42`]);
    expect(ctx.output).toContain("Removed preview pr-42 with its data.");
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("in a terminal, asks for pr-<n> typed, and removes nothing when it is not", async () => {
    const declined = new ScriptedApprovalHandler([false]);
    const no = await previewProject(removed, { interactive: true, approvals: declined });
    expect(await run(no.ctx, "preview", "destroy", "42", "--env", "preview")).toBe(1);
    expect(declined.requests[0]).toMatchObject({
      kind: "remote-exec",
      allowDestroy: true,
      confirmPhrase: "pr-42",
    });
    expect(no.commands).toEqual([]);
    const typed = projectContext(project as TempProject, {
      interactive: true,
      services: {
        provision: servicesOf(no.ctx).provision ?? {},
        approvalHandler: new ScriptedApprovalHandler([true]),
      },
    });
    expect(await run(typed, "preview", "destroy", "42", "--env", "preview"), typed.errors).toBe(0);
    expect(no.commands).toEqual([`${COMMAND} down 42`]);
  });
});

describe("opscrew verify of a preview environment", () => {
  it("checks the server and its previews, and names no runbook", async () => {
    const { ctx } = await previewProject(() => ({
      exitCode: 0,
      stdout: "opscrew-preview: listed 0/3\n",
    }));
    expect(await run(ctx, "verify", "--env", "preview"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("0 previews of at most 3 on the server.");
    expect(ctx.output).not.toContain("RUNBOOK");
    expect(ctx.output).not.toMatch(/read \S+: it explains/);
    expect(ctx.output).toContain("opscrew secure");
    expectNoLeak(ctx.output + ctx.errors);
  });
});
