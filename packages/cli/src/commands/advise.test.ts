/**
 * `opscrew advise` (US1, US2, US4): the proposals grouped by urgency with their figures, prices and
 * commands, `--json`, `--apply` and the refusals; never a token or the server's address. The
 * server, GitHub and the clock are fakes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProposalSchema, recordServerAddress } from "@opscrew/agents";
import { makeRequirements, ScriptedRunner, SERVER_IPV4, testPlan } from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { main } from "../program";
import { createTestContext } from "../test-context";

const argv = (...args: string[]) => ["node", "opscrew", ...args];
const GITHUB_TOKEN = fakeSecret("github-token", "advise");
const MB = 1024 ** 2;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-advise-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
 * A deployed Hetzner cx23 without backups, important data in the interview; its server answers
 * the figures command and fails every other command with ssh's message naming its address.
 */
async function deployedProject(plan?: DeployPlan) {
  const env = { OPSCREW_HOME: path.join(dir, "home"), GITHUB_TOKEN };
  const paths = resolveProjectPaths(dir, { env });
  const base = testPlan({ deployed: true, userSecret: false });
  await writeArtifact(
    "plan",
    paths.files.plan,
    plan ??
      DeployPlanSchema.parse({
        ...base,
        target: { ...base.target, backups: false },
        deployment: { ...base.deployment, firstDeployAt: "2026-10-11T11:30:00.000Z" },
      }),
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
  // GitHub: no alert, the token expires in 3 days, and the pull requests fail with an answer that
  // quotes the token (it reaches the output only through the error's message, redacted).
  const github = fakeFetch(
    {
      "/user": {
        body: {},
        headers: { "github-authentication-token-expiration": "2026-10-14 12:00:00 UTC" },
      },
      "/repos/acme/shop/dependabot/alerts": { body: [] },
      "/repos/acme/shop/pulls": {
        status: 500,
        body: { message: `Server error for the token ${GITHUB_TOKEN}` },
      },
      "/": { status: 404, body: { message: "Not Found" } },
    },
    { base: "https://api.github.com" },
  );
  const ctx = withServices(createTestContext({ cwd: dir, env }), {
    clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
    // The repository's GitHub remote.
    runner: new ScriptedRunner((_command, args) =>
      args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "" },
    ),
    fetch: github.fetch,
    provision: { remote },
  });
  return { ctx, paths };
}

/** Neither the token nor the server's address in anything advise printed. */
function expectNoLeak(text: string) {
  expect(text).not.toContain(GITHUB_TOKEN);
  expect(text).not.toContain(SERVER_IPV4);
}

describe("opscrew advise", () => {
  it("lists the proposals by urgency, each with its figures, price and command", async () => {
    const { ctx } = await deployedProject();
    expect(await main(argv("advise"), ctx), ctx.errors).toBe(0);
    const out = ctx.output;
    expect(out).toContain("Advise's proposals, the most urgent first:");
    // The token about to expire is now; the short server soon; backups when convenient.
    const now = out.indexOf("\nNow:\n");
    const soon = out.indexOf("\nSoon:\n");
    const later = out.indexOf("\nWhen convenient:\n");
    expect(now).toBeGreaterThan(0);
    expect(soon).toBeGreaterThan(now);
    expect(later).toBeGreaterThan(soon);
    expect(out.slice(now, soon)).toContain("[upkeep.env.github-token]");
    const larger = out.slice(soon, later);
    expect(larger).toContain("[size.app.larger]");
    expect(larger).toMatch(/ \(9\d(\.\d)?% of 4 GB, one reading\)\n/);
    expect(larger).toMatch(
      /Price: €\d+\.\d\d → €\d+\.\d\d a month \(static prices dated \d{4}-\d\d-\d\d\)/,
    );
    expect(larger).toContain("Apply: opscrew advise --apply size.app.larger\n");
    expect(out.slice(later)).toContain("Apply: opscrew advise --apply reliability.app.backups\n");
    expect(out).toContain("Checked: the plan, ");
    expect(out).toContain("\nCouldn't read:\n");
    // GitHub's answer that quoted the token is listed, the token masked.
    expect(out).toContain(
      "  - Dependabot's open pull requests: GitHub could not list the open pull requests",
    );
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "These figures are one reading. `opscrew addon enable monitoring` gives two weeks of figures, so advise can also propose smaller servers.",
    );
    expectNoLeak(out + ctx.errors);
  });

  it("--json prints the report, each proposal as ProposalSchema has it", async () => {
    const { ctx } = await deployedProject();
    expect(await main(argv("advise", "--json"), ctx), ctx.errors).toBe(0);
    const report = JSON.parse(ctx.output) as {
      proposals: unknown[];
      basis: Record<string, unknown>;
      checked: string[];
      notRead: string[];
    };
    expect(report.proposals.length).toBeGreaterThan(0);
    for (const proposal of report.proposals)
      expect(ProposalSchema.parse(proposal)).toEqual(proposal);
    expect(report.basis).toEqual({ app: { kind: "one-reading", at: "2026-10-11T12:00:00.000Z" } });
    expect(report.checked).toContain("the plan");
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("--apply writes a plan proposal into the plan and says to run provision", async () => {
    const { ctx, paths } = await deployedProject();
    expect(await main(argv("advise", "--apply", "reliability.app.backups"), ctx), ctx.errors).toBe(
      0,
    );
    expect(ctx.output).toContain("Changed opscrew/plan.yaml: target.backups from off to on.");
    expect(ctx.output).toContain("Run `opscrew provision`");
    const plan = await readArtifact("plan", paths.files.plan);
    expect(plan.target).toMatchObject({ backups: true, serverType: "cx23" });
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("--apply prints the command, or what to do by hand, and changes nothing", async () => {
    const { ctx, paths } = await deployedProject();
    const before = await readFile(paths.files.plan, "utf8");
    expect(await main(argv("advise", "--apply", "security.app.host-checks"), ctx)).toBe(0);
    expect(ctx.output).toContain(
      "Advise changed nothing: another command applies this one. Run:\n  opscrew secure\n",
    );
    expect(await main(argv("advise", "--apply", "upkeep.env.github-token"), ctx)).toBe(0);
    expect(ctx.output).toContain(
      "Advise changed nothing: this one is done by hand.\n  Create a new token with the same permissions",
    );
    expect(await readFile(paths.files.plan, "utf8")).toBe(before);
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("refuses an id that isn't among the proposals, naming the current ones", async () => {
    const { ctx, paths } = await deployedProject();
    const before = await readFile(paths.files.plan, "utf8");
    expect(await main(argv("advise", "--apply", "size.app.smaller"), ctx)).not.toBe(0);
    expect(ctx.errors).toContain('"size.app.smaller" is not among advise\'s proposals');
    expect(ctx.errors).toContain("reliability.app.backups");
    expect(ctx.errors).toContain("Nothing was changed.");
    expect(await readFile(paths.files.plan, "utf8")).toBe(before);
    expectNoLeak(ctx.output + ctx.errors);
  });

  it("refuses --json with --apply, and an environment that isn't provisioned", async () => {
    const { ctx } = await deployedProject();
    expect(await main(argv("advise", "--json", "--apply", "x"), ctx)).not.toBe(0);
    expect(ctx.errors).toContain(
      "--json lists the proposals; it doesn't go with --apply. Nothing was changed.",
    );
    const fresh = await deployedProject(testPlan({ userSecret: false }));
    expect(await main(argv("advise"), fresh.ctx)).not.toBe(0);
    expect(fresh.ctx.errors).toContain("is not provisioned, so advise has nothing to read");
    expect(fresh.ctx.errors).toContain("opscrew provision");
  });

  it("has help text with its options", async () => {
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("advise", "--help"), ctx)).toBe(0);
    for (const option of ["--apply <id>", "--json", "--app <key>", "--env <name>"]) {
      expect(ctx.output).toContain(option);
    }
    expect(ctx.output).toContain("changes nothing");
  });
});
