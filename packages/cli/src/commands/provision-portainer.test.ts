import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { CliExit } from "../exit";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import {
  fakePortainerProvision,
  PORTAINER_HOST,
  portainerTestPlan,
  recordPortainer,
} from "../ui/__fixtures__/portainer";
import { type InfraFlags, runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const INFRA = "ab".repeat(32);

async function portainerProject(plan = portainerTestPlan()): Promise<TempProject> {
  project = await tempProject();
  await writeProjectPlan(project, plan);
  await recordPortainer(project);
  return project;
}

/** Runs `provision` with `flags` and the fake phase; returns the exit code (0 when it finished). */
async function provision(
  ctx: ReturnType<typeof projectContext>,
  flags: InfraFlags,
  fake: ReturnType<typeof fakePortainerProvision>,
): Promise<number> {
  try {
    await runInfraCommand(ctx, "provision", flags, fake.run);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    throw error;
  }
}

/**
 * The hashes printed by a `--plan-only` run: labelled when there are several plans, else the one
 * plan hash (here always the stack plan: the fake saves no infrastructure plan).
 */
function printed(output: string): { infra?: string; stack?: string } {
  const infra = /infrastructure \(Cloudflare\):\s+([0-9a-f]{64})/.exec(output)?.[1];
  const stack =
    /stack plan for your Portainer:\s+([0-9a-f]{64})/.exec(output)?.[1] ??
    /Plan hash \(SHA-256\):\s+([0-9a-f]{64})/.exec(output)?.[1];
  return { ...(infra ? { infra } : {}), ...(stack ? { stack } : {}) };
}

describe("opscrew provision for the user's Portainer", () => {
  it("--plan-only prints the infrastructure and the stack plan, each with its hash, and one command", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakePortainerProvision({ infraHash: INFRA });
    expect(await provision(ctx, { planOnly: true, yes: true }, fake), ctx.errors).toBe(0);
    const { infra, stack } = printed(ctx.output);
    expect(infra).toBe(INFRA);
    expect(stack).toBeDefined();
    expect(ctx.output).toContain(`opscrew provision --approve ${INFRA} --approve ${stack} --yes`);
    expect(ctx.output).not.toContain("three runs");
    expect(fake.options[0]).toMatchObject({ planOnly: true });
  });

  it("applies the stack plan only for its hash given with --approve; --yes never grants it", async () => {
    const p = await portainerProject();
    const planCtx = projectContext(p);
    const fake = fakePortainerProvision();
    expect(await provision(planCtx, { planOnly: true }, fake)).toBe(0);
    const { stack } = printed(planCtx.output);
    if (stack === undefined) throw new Error(planCtx.output);

    const yesOnly = projectContext(p);
    expect(await provision(yesOnly, { yes: true }, fake)).toBe(1);
    expect(fake.decisions.at(-1)).toMatchObject({ kind: "stack-apply", approved: false });

    const other = projectContext(p);
    expect(await provision(other, { approve: [INFRA], yes: true }, fake)).toBe(1);
    expect(other.errors).toContain("stack plan's hash does not match");

    const approved = projectContext(p);
    expect(await provision(approved, { approve: [INFRA, stack], yes: true }, fake)).toBe(0);
    expect(fake.decisions.at(-1)).toMatchObject({ kind: "stack-apply", approved: true });
    expect(fake.options.at(-1)).toMatchObject({ approveHashes: [INFRA, stack] });
    expect(approved.output).toContain(`Applied the stack plan ${stack} to your Portainer.`);
    expect(approved.output).toContain("opscrew verify");
    expect(approved.output).toContain("back up the app's data volumes yourself");
    for (const ctx of [planCtx, yesOnly, other, approved]) {
      expect(`${ctx.output}${ctx.errors}`).not.toContain(PORTAINER_HOST);
    }
  });

  it("says when Portainer already matches the stack plan", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakePortainerProvision({ changes: 0 });
    expect(await provision(ctx, {}, fake)).toBe(0);
    expect(ctx.output).toMatch(
      /already matches the stack plan [0-9a-f]{64}; nothing in it changed/,
    );

    const planOnly = projectContext(p);
    expect(await provision(planOnly, { planOnly: true }, fake)).toBe(0);
    expect(planOnly.output).toContain("Cloudflare and your Portainer already match the plans");
  });

  it("explains the three runs a script needs when the stack plan waits for the tunnel's token", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakePortainerProvision({ infraHash: INFRA, tunnelFirst: true });
    expect(await provision(ctx, { planOnly: true }, fake)).toBe(0);
    expect(ctx.output).not.toContain("stack plan for your Portainer:");
    expect(ctx.output).toContain(`opscrew provision --approve ${INFRA}`);
    expect(ctx.output).toContain("three runs");
    expect(ctx.output).toContain("opscrew provision --approve <stack plan hash>");
  });

  it("passes --public-image, --private-image and --replace-token to the phase and repeats them", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakePortainerProvision();
    expect(
      await provision(
        ctx,
        { planOnly: true, publicImage: true, replaceToken: ["repository", "registry"] },
        fake,
      ),
    ).toBe(0);
    expect(fake.options[0]).toMatchObject({
      publicImage: true,
      replaceTokens: { repository: true, registry: true },
    });
    const { stack } = printed(ctx.output);
    expect(ctx.output).toContain(
      `opscrew provision --approve ${stack} --public-image --replace-token repository --replace-token registry`,
    );

    const back = projectContext(p);
    expect(await provision(back, { planOnly: true, privateImage: true }, fake)).toBe(0);
    expect(fake.options[1]).toMatchObject({ publicImage: false });
    expect(fake.options[1]).not.toHaveProperty("replaceTokens");
    expect(back.output).toContain("--private-image");

    // Without either flag the remembered choice applies: nothing is passed.
    const plain = projectContext(p);
    expect(await provision(plain, { planOnly: true }, fake)).toBe(0);
    expect(fake.options[2]).not.toHaveProperty("publicImage");
  });

  it("refuses --public-image together with --private-image before anything runs", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakePortainerProvision();
    expect(await provision(ctx, { publicImage: true, privateImage: true }, fake)).toBe(2);
    expect(ctx.errors).toContain("Use either --public-image or --private-image.");
    expect(fake.options).toEqual([]);
  });

  it("offers the flags on the command line and checks --replace-token's value", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    expect(await run(ctx, "provision", "--replace-token", "password")).toBe(2);
    expect(ctx.errors).toContain("repository, registry");
    const help = new Command();
    const { register } = await import("./provision");
    register(help, ctx);
    const options = help.commands
      .find((command) => command.name() === "provision")
      ?.options.map((option) => option.long);
    expect(options).toEqual(
      expect.arrayContaining(["--public-image", "--private-image", "--replace-token"]),
    );
  });
});
