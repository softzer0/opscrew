/**
 * End-to-end flow on DigitalOcean (T411, FR-409, SC-404): `examples/nextjs-postgres` is driven
 * through the real CLI program in-process with fakes and no network: `analyze --no-ai` →
 * `interview --answers` (provider `digitalocean`, a USD budget) → `design` (DigitalOcean's dated
 * static price list, no token) → `adapt --no-ai --no-push` → `provision` (fake engine returning
 * DigitalOcean resource changes, fake credential check, GitHub, Cloudflare and SSH). The last check
 * searches every output and every written file for the seeded DigitalOcean token.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, RequirementsSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DeployRunner,
  DIGITALOCEAN_CREATE,
  digitalOceanPlanJsonFor,
  FakeEngine,
  FakeGitHub,
  provisionServices,
  SERVER_IPV4,
  SERVER_IPV6,
} from "../../src/ui/__fixtures__/deploy";
import {
  EXAMPLES_DIR,
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import { withDeployServices } from "../../src/ui/deploy-services";
import { findLeaks, listFiles, plantedSecrets, ScriptedApprovals, snapshotFiles } from "./support";

const EXAMPLE = "nextjs-postgres";
const ANSWERS = {
  provider: "digitalocean",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "30 USD",
  region: "eu-central",
  uptime: "standard",
  dataCriticality: "critical",
  domain: "app.example.com",
  dnsProvider: "cloudflare",
};
const STEP_TIMEOUT = 120_000;

async function readPlan(root: string): Promise<DeployPlan> {
  const text = await readFile(path.join(root, "opscrew", "plan.yaml"), "utf8");
  return DeployPlanSchema.parse(parse(text));
}

describe.skipIf(GIT === undefined)(`example ${EXAMPLE} on DigitalOcean`, () => {
  /** Seeded at runtime; only `provision` sees it (design uses the static price list). */
  const TOKEN = fakeSecret("digitalocean-token", "e2e");
  let project: TempProject;
  let inputs: Map<string, string>;
  let bare: string;
  const runtime = new FakeAgentRuntime();
  const approvals = new ScriptedApprovals([
    "repo-write",
    "iac-apply",
    "github-secrets",
    "git-push",
    "pull-request",
  ]);
  const outputs = new Map<string, string>();

  /** Runs `opscrew <args>` offline; `deploy` attaches the provision fakes and the token. */
  async function opscrew(args: string[], deploy?: { engine: FakeEngine; github: FakeGitHub }) {
    const scoped: TempProject =
      deploy === undefined
        ? project
        : { ...project, env: { ...project.env, DIGITALOCEAN_TOKEN: TOKEN } };
    const ctx = projectContext(scoped, {
      services: {
        runtime,
        approvalHandler: approvals,
        ...(deploy === undefined ? {} : { runner: new DeployRunner() }),
      },
    });
    if (deploy !== undefined) {
      withDeployServices(ctx, { provision: provisionServices(deploy.engine, deploy.github) });
    }
    const code = await run(ctx, ...args);
    outputs.set(`${args.join(" ")} (stdout)`, ctx.output);
    outputs.set(`${args.join(" ")} (stderr)`, ctx.errors);
    expect(ctx.fetchUrls, `${args.join(" ")} fetched`).toEqual([]);
    return { code, ctx, text: ctx.output + ctx.errors };
  }

  beforeAll(async () => {
    project = await tempProject(EXAMPLE);
    inputs = await snapshotFiles(project.root);
    // `origin` is a GitHub URL (provision reads owner and name from it); pushes land in `bare`.
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
    "analyze, interview with provider digitalocean and design plan a Droplet",
    async () => {
      expect((await opscrew(["analyze", "--no-ai"])).code).toBe(0);

      const answersFile = path.join(project.dir, "answers.yaml");
      await writeFile(answersFile, `${JSON.stringify(ANSWERS, null, 2)}\n`);
      expect((await opscrew(["interview", "--answers", answersFile])).code).toBe(0);
      const requirements = RequirementsSchema.parse(
        parse(await readFile(path.join(project.root, "opscrew", "requirements.yaml"), "utf8")),
      );
      expect(requirements.provider).toBe("digitalocean");
      expect(requirements.budgetMonthly).toEqual({ amount: 30, currency: "USD" });

      // No token: DigitalOcean's dated static price list, offered as DigitalOcean options.
      const design = await opscrew(["design"]);
      expect(design.code, design.text).toBe(0);
      expect(design.text).toContain("DIGITALOCEAN_TOKEN is not set");
      const chosen = /Chose the recommended option, ([a-z0-9-]+)\./.exec(design.ctx.output)?.[1];
      expect(chosen).toMatch(/^digitalocean-/);
      expect(design.text).not.toMatch(/\(hetzner-[a-z0-9-]+\)/);

      const plan = await readPlan(project.root);
      expect(plan.target.provider).toBe("digitalocean");
      expect(plan.target.image).toBe("ubuntu-24-04-x64");
      expect(plan.target.location).toBe("fra1");
      expect(plan.target.backups).toBe(true);
      expect(plan.cost.monthly.currency).toBe("USD");
      expect(plan.dns).toMatchObject({ provider: "cloudflare", domain: ANSWERS.domain });
    },
    STEP_TIMEOUT,
  );

  it(
    "adapt --no-ai --no-push commits the templated files",
    async () => {
      const { code, text } = await opscrew(["adapt", "--no-ai", "--no-push"]);
      expect(code, text).toBe(0);
      expect(await git(project.env, project.root, "branch", "--show-current")).toBe(
        "opscrew/prepare-deploy",
      );
      expect(existsSync(path.join(project.root, "Dockerfile"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "provision renders the DigitalOcean root module, applies the approved plan and records the outputs",
    async () => {
      const before = await readPlan(project.root);
      const engine = new FakeEngine({
        planJson: digitalOceanPlanJsonFor(before),
        changes: DIGITALOCEAN_CREATE,
      });
      const github = new FakeGitHub();
      const { code, text } = await opscrew(["provision"], { engine, github });
      expect(code, text).toBe(0);

      expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
      expect(text).toContain("Checking your DigitalOcean, Cloudflare and GitHub access");
      const apply = approvals.requests.find((request) => request.kind === "iac-apply");
      expect(apply?.title).toContain("DigitalOcean");
      expect(apply?.details).toContain("module.server.digitalocean_droplet.this");
      expect(apply?.details).toContain("module.server.digitalocean_firewall.this");
      expect(apply?.details).not.toContain("hcloud_");

      // The root module calls the vendored DigitalOcean module; no Hetzner module is vendored.
      const infra = path.join(project.root, "opscrew", "infra");
      const main = await readFile(path.join(infra, "prod", "main.tf"), "utf8");
      expect(main).toMatch(/source\s*=\s*"\.\.\/modules\/digitalocean-droplet"/);
      expect(main).not.toContain("hetzner");
      expect(existsSync(path.join(infra, "modules", "digitalocean-droplet", "main.tf"))).toBe(true);
      expect(existsSync(path.join(infra, "modules", "hetzner-vps"))).toBe(false);
      for (const file of await listFiles(path.join(infra, "prod"))) {
        expect(await readFile(file, "utf8"), file).not.toContain("delete_protection");
      }

      // The apply is recorded in plan.yaml exactly as on Hetzner; the server's address (and the
      // URL on it) only in OpsCrew's local state.
      const plan = await readPlan(project.root);
      expect(plan.target.provider).toBe("digitalocean");
      expect(plan.deployment).toMatchObject({
        lastPlanHash: engine.applied[0]?.approval.approvedPlanHash,
      });
      expect(plan.deployment.url).toBeUndefined();
      const paths = resolveProjectPaths(project.root, { env: project.env });
      expect((await readServerAddresses(paths)).deployment).toEqual({
        ipv4: SERVER_IPV4,
        ipv6: SERVER_IPV6,
      });
      expect(await readFile(paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
      expect(plan.approvals).toEqual([
        expect.objectContaining({
          kind: "iac-apply",
          planHash: engine.applied[0]?.approval.approvedPlanHash,
        }),
      ]);
      expect([...github.secrets.keys()]).toContain("OPSCREW_SSH_PRIVATE_KEY");
      expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
      expect(text).toContain(`Created or updated the server at ${SERVER_IPV4}.`);
    },
    STEP_TIMEOUT,
  );

  it(
    "never shows or writes the DigitalOcean token or a planted secret",
    async () => {
      outputs.set(
        "approval requests",
        JSON.stringify(approvals.requests.map(({ title, details }) => ({ title, details }))),
      );
      const secrets = [TOKEN, ...(await plantedSecrets(path.join(EXAMPLES_DIR, EXAMPLE)))];
      const leaks = await findLeaks({ secrets, texts: outputs, dir: project.dir, inputs });
      expect(leaks).toEqual([]);
    },
    STEP_TIMEOUT,
  );
});
