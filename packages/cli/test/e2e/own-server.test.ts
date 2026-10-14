/**
 * End-to-end flow on a server the user already owns (feature 009): `examples/nextjs-postgres` is
 * driven through the real CLI program in-process with fakes and no network: `analyze --no-ai` →
 * `interview --answers` (provider `own` with the server's SSH login) → `design --host-key` (the
 * server is inspected by a fake host adapter; no price) → `adapt --no-ai --no-push` →
 * `provision --plan-only` (two plans: Cloudflare DNS and the host plan) → `provision --approve
 * <infra> --approve <host>`. The last checks search every output, every written file, the commit
 * messages and the pull request for the server's address and the example's planted secrets.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readOwnServer } from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, RequirementsSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FakeEngine, FakeGitHub } from "../../src/ui/__fixtures__/deploy";
import {
  EXAMPLES_DIR,
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import {
  FakeHost,
  fakeHome,
  OWN_FINGERPRINT,
  OWN_IPV4,
  OWN_PUBLIC_CHANGES,
  OwnRunner,
  ownProvisionServices,
  ownServices,
} from "../../src/ui/__fixtures__/own";
import { withDeployServices } from "../../src/ui/deploy-services";
import { findLeaks, listFiles, plantedSecrets, ScriptedApprovals, snapshotFiles } from "./support";

const EXAMPLE = "nextjs-postgres";
const ANSWERS = {
  provider: "own",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "30 EUR",
  uptime: "standard",
  dataCriticality: "critical",
  domain: "app.example.com",
  dnsProvider: "cloudflare",
  "server.host": OWN_IPV4,
  "server.port": 22,
  "server.user": "root",
  "server.key": "agent",
  "server.reachable": true,
  "server.serve": "proxy",
};
const STEP_TIMEOUT = 120_000;

async function readPlan(root: string): Promise<DeployPlan> {
  const text = await readFile(path.join(root, "opscrew", "plan.yaml"), "utf8");
  return DeployPlanSchema.parse(parse(text));
}

/** The labelled hashes a `--plan-only` run on an own server prints. */
function printedHashes(output: string): { infra: string; host: string } {
  const infra = /infrastructure \(Cloudflare\):\s+([0-9a-f]{64})/.exec(output)?.[1];
  const host = /host plan for your server:\s+([0-9a-f]{64})/.exec(output)?.[1];
  if (infra === undefined || host === undefined) throw new Error(`No plan hashes in:\n${output}`);
  return { infra, host };
}

describe.skipIf(GIT === undefined)(`example ${EXAMPLE} on a server the user owns`, () => {
  let project: TempProject;
  let inputs: Map<string, string>;
  let bare: string;
  let host: FakeHost;
  let home: string;
  const runtime = new FakeAgentRuntime();
  // `--yes` covers the repository steps; the two plans are approved only by their hashes.
  const outputs = new Map<string, string>();
  const engine = new FakeEngine({ changes: OWN_PUBLIC_CHANGES, planJson: {} });
  const github = new FakeGitHub();

  /** Runs `opscrew <args>` offline with the own-server fakes attached. */
  async function opscrew(args: string[], approvals?: ScriptedApprovals) {
    const ctx = projectContext(project, {
      services: {
        runtime,
        runner: new OwnRunner(),
        ...(approvals === undefined ? {} : { approvalHandler: approvals }),
      },
    });
    withDeployServices(ctx, {
      provision: ownProvisionServices(engine, github, ownServices(host, home)),
    });
    const code = await run(ctx, ...args);
    outputs.set(`${args.join(" ")} (stdout)`, ctx.output);
    outputs.set(`${args.join(" ")} (stderr)`, ctx.errors);
    expect(ctx.fetchUrls, `${args.join(" ")} fetched`).toEqual([]);
    return { code, ctx, text: ctx.output + ctx.errors };
  }

  beforeAll(async () => {
    project = await tempProject(EXAMPLE);
    inputs = await snapshotFiles(project.root);
    host = new FakeHost();
    home = await fakeHome(project);
    const { env, root, dir } = project;
    await git(env, root, "init", "-q", "-b", "main");
    await git(env, root, "add", "-A");
    await git(env, root, "commit", "-q", "-m", "initial import");
    bare = path.join(dir, "origin.git");
    await git(env, dir, "init", "-q", "--bare", "-b", "main", bare);
    await git(env, root, "remote", "add", "origin", "https://github.com/acme/nextjs-postgres.git");
    await git(env, root, "remote", "set-url", "--push", "origin", bare);
  }, STEP_TIMEOUT);

  afterAll(async () => {
    await project?.cleanup();
  });

  it(
    "interview records the server locally; design inspects it and plans it without a price",
    async () => {
      expect((await opscrew(["analyze", "--no-ai"])).code).toBe(0);
      const answersFile = path.join(project.dir, "answers.yaml");
      await writeFile(answersFile, `${JSON.stringify(ANSWERS, null, 2)}\n`);
      const interview = await opscrew(["interview", "--answers", answersFile]);
      expect(interview.code, interview.text).toBe(0);
      const requirementsFile = path.join(project.root, "opscrew", "requirements.yaml");
      const requirements = RequirementsSchema.parse(
        parse(await readFile(requirementsFile, "utf8")),
      );
      expect(requirements.provider).toBe("own");
      expect(await readFile(requirementsFile, "utf8")).not.toContain(OWN_IPV4);

      const design = await opscrew(["design", "--host-key", OWN_FINGERPRINT]);
      expect(design.code, design.text).toBe(0);
      expect(host.inspections).toBe(1);
      expect(design.ctx.output).toContain("Chose the recommended option, own-server.");
      expect(design.text).not.toMatch(/Prices:|€\d/);
      const paths = resolveProjectPaths(project.root, { env: project.env });
      expect((await readOwnServer(paths))?.hostKey).toBe(OWN_FINGERPRINT);

      const plan = await readPlan(project.root);
      expect(plan.target).toMatchObject({ provider: "own", arch: "amd64", access: "public" });
      expect(plan.dns).toMatchObject({ provider: "cloudflare", domain: ANSWERS.domain });
    },
    STEP_TIMEOUT,
  );

  it(
    "adapt --no-ai --no-push commits the templated files",
    async () => {
      const { code, text } = await opscrew(
        ["adapt", "--no-ai", "--no-push"],
        new ScriptedApprovals(["repo-write"]),
      );
      expect(code, text).toBe(0);
      expect(existsSync(path.join(project.root, "Dockerfile"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "provision --plan-only shows both plans; --approve with both hashes prepares the server",
    async () => {
      const { env, root } = project;
      await git(env, root, "checkout", "-q", "main");
      await git(env, root, "merge", "-q", "--ff-only", "opscrew/prepare-deploy");
      await git(env, root, "push", "-q", "origin", "main");

      const planned = await opscrew(["provision", "--plan-only", "--yes"]);
      expect(planned.code, planned.text).toBe(0);
      expect(host.applies).toEqual([]);
      const { infra, host: hostHash } = printedHashes(planned.ctx.output);

      // Only the infrastructure hash: Cloudflare is applied, the server is not touched.
      const half = await opscrew(["provision", "--approve", infra, "--yes"]);
      expect(half.code).toBe(1);
      expect(host.applies).toEqual([]);
      expect(half.text).toContain(`--approve ${hostHash}`);
      expect(engine.applied).toHaveLength(1);

      // The DNS record exists now, so planning again finds nothing to change in Cloudflare; the
      // host plan's hash alone finishes the run.
      engine.scenario.changes = [];
      const applied = await opscrew(["provision", "--approve", hostHash, "--yes"]);
      expect(applied.code, applied.text).toBe(0);
      expect(host.applies).toHaveLength(1);
      expect(host.applies[0]?.options.approvedHash).toBe(hostHash);
      // Served directly behind Cloudflare's proxy: the host plan has the (IPv4) web filter.
      expect(host.applies[0]?.plan.steps.find((step) => step.id === "web-filter")).toMatchObject({
        state: "change",
        params: { ipv4: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+\/\d+/) },
      });
      expect(engine.applied).toHaveLength(1);

      const plan = await readPlan(project.root);
      expect(plan.approvals.map((a) => a.kind)).toEqual(["iac-apply", "host-apply"]);
      expect([...github.secrets.keys()]).toContain("OPSCREW_SSH_PRIVATE_KEY");
      expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
    },
    STEP_TIMEOUT,
  );

  it(
    "never puts the server's address in committed files, commit messages or the pull request",
    async () => {
      const { env, root } = project;
      const branch = "opscrew/deploy-setup";
      const files = (await git(env, root, "ls-tree", "-r", "--name-only", branch))
        .split("\n")
        .filter((file) => file !== "");
      for (const file of files) {
        const content = await git(env, root, "show", `${branch}:${file}`);
        expect(content, file).not.toContain(OWN_IPV4);
      }
      expect(await git(env, root, "log", "--format=%B", branch)).not.toContain(OWN_IPV4);
      expect(JSON.stringify(github.pulls)).not.toContain(OWN_IPV4);
      const tfvars = path.join(root, "opscrew", "infra", "prod", "terraform.tfvars.json");
      expect(await readFile(tfvars, "utf8")).not.toContain("server_ipv4");
      for (const file of await listFiles(path.join(root, "opscrew"))) {
        expect(await readFile(file, "utf8"), file).not.toContain(OWN_IPV4);
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "never shows or writes a planted secret",
    async () => {
      const secrets = await plantedSecrets(path.join(EXAMPLES_DIR, EXAMPLE));
      const leaks = await findLeaks({ secrets, texts: outputs, dir: project.dir, inputs });
      expect(leaks).toEqual([]);
      // Nothing the commands printed repeats the server's address either.
      for (const [label, text] of outputs) expect(text, label).not.toContain(OWN_IPV4);
    },
    STEP_TIMEOUT,
  );
});
