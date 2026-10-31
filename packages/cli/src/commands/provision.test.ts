import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import {
  FAKE_SOPS,
  FakeEngine,
  FakeGitHub,
  FakeSops,
  fakeSharedCloudflare,
  planJsonFor,
  SERVER_IPV4,
  testPlan,
} from "@opscrew/agents/testing";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  provisionServices,
} from "../ui/__fixtures__/deploy";
import {
  auditText,
  CANCEL,
  GIT,
  git,
  projectContext,
  run,
  ScriptedPrompts,
} from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything and records the requests (the scripted human). */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: true,
      approver: "test",
      decidedAt: "2026-10-11T12:00:00.000Z",
      ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
    };
  }
}

interface Setup {
  engine?: FakeEngine;
  interactive?: boolean;
  approvals?: ApprovalHandler;
  prompts?: ScriptedPrompts;
  /** The Cloudflare zone of OpsCrew's shared rules, kept between runs. */
  zone?: FakeZone;
  /** Answers `OPSCREW_SOPS_BIN=fake-sops` for the recovery copy. */
  sops?: FakeSops;
  /** GitHub, kept between runs (its pull requests). */
  github?: FakeGitHub;
}

/** A non-interactive context (the real `--approve`/`--yes` handler) with deploy fakes attached. */
function context(p: DeployProject, options: Setup = {}) {
  const engine = options.engine ?? new FakeEngine();
  const github = options.github ?? new FakeGitHub();
  const runner = new DeployRunner();
  const ctx = projectContext(p, {
    interactive: options.interactive ?? false,
    services: {
      runner: options.sops === undefined ? runner : options.sops.runner(runner),
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
      ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    },
  });
  withServices(ctx, {
    provision: provisionServices(
      engine,
      github,
      options.zone === undefined ? {} : { sharedCloudflare: fakeSharedCloudflare(options.zone) },
    ),
  });
  return { ctx, engine, github, runner };
}

/** The 64-character hash printed on its own line after "Plan hash (SHA-256):". */
function printedHash(output: string): string {
  const match = /Plan hash \(SHA-256\):\s+([0-9a-f]{64})\s/.exec(output);
  if (match?.[1] === undefined) throw new Error(`No plan hash in:\n${output}`);
  return match[1];
}

describe.skipIf(GIT === undefined)("opscrew provision", () => {
  it("--plan-only lists the bucket's plan with its own hash, in the --approve command", async () => {
    const base = testPlan({ userSecret: false });
    project = await deployProject(
      DeployPlanSchema.parse({
        ...base,
        storage: {
          objectStorage: {
            provider: "hetzner",
            bucket: "shop-uploads",
            region: "fsn1",
            expected: { storageGb: 10, egressGbPerMonth: 50 },
            price: { monthly: 6.49, currency: "EUR", source: "test", checkedOn: "2026-10-19" },
          },
        },
      }),
    );
    // A non-interactive run reads the bucket's key from the environment.
    project.env.OPSCREW_STORAGE_ACCESS_KEY_ID = fakeSecret("aws-access-key-id", "cli");
    project.env.OPSCREW_STORAGE_SECRET_ACCESS_KEY = fakeSecret("aws-secret-access-key", "cli");
    const { ctx } = context(project);
    expect(await run(ctx, "provision", "--plan-only", "--yes"), ctx.errors).toBe(0);
    const bucket = /bucket \(object storage\):\s+([0-9a-f]{64})/.exec(ctx.output)?.[1];
    const infrastructure = /infrastructure:\s+([0-9a-f]{64})/.exec(ctx.output)?.[1];
    expect(bucket).toBeDefined();
    expect(infrastructure).toBeDefined();
    expect(ctx.output).toContain(
      `    opscrew provision --approve ${bucket} --approve ${infrastructure} --yes\n`,
    );
    expect(ctx.output).not.toContain(project.env.OPSCREW_STORAGE_SECRET_ACCESS_KEY);
  });

  it("--plan-only lists the scheduled check key's host plan on a server that exists", async () => {
    const base = testPlan({ domain: "shop.example.com", deployed: true, userSecret: false });
    project = await deployProject(
      DeployPlanSchema.parse({ ...base, observability: { check: { enabled: true } } }),
    );
    // The server exists: the infrastructure plan only updates its firewall.
    const engine = new FakeEngine({
      planJson: planJsonFor({ proxied: true }),
      changes: [
        {
          address: "module.server.hcloud_firewall.this",
          type: "hcloud_firewall",
          name: "this",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "update",
        },
      ],
    });
    const { ctx } = context(project, { engine });
    expect(await run(ctx, "provision", "--plan-only", "--yes"), ctx.errors).toBe(0);
    const key = /host plan for the scheduled check's key:\s+([0-9a-f]{64})/.exec(ctx.output)?.[1];
    expect(key).toBeDefined();
    expect(ctx.output).toMatch(
      new RegExp(`    opscrew provision (--approve [0-9a-f]{64} )*--approve ${key}`),
    );
  });

  it("--plan-only --yes prints the hash; --approve <hash> --yes applies exactly that plan", async () => {
    project = await deployProject();
    const first = context(project);
    expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);

    expect(first.engine.calls).toEqual(["init", "validate", "plan"]);
    const hash = printedHash(first.ctx.output);
    expect(first.ctx.output).toContain(`    opscrew provision --approve ${hash} --yes\n`);
    expect(first.github.secrets.size).toBe(0);
    await expect(
      readFile(path.join(project.root, "opscrew/infra/prod/main.tf"), "utf8"),
    ).resolves.toContain("OpsCrew");

    const second = context(project);
    expect(await run(second.ctx, "provision", "--approve", hash, "--yes")).toBe(0);

    // The saved plan is applied as is: no new plan, the approval bound to the reviewed hash.
    expect(second.engine.calls).toEqual(["apply"]);
    expect(second.engine.applied[0]?.approval).toMatchObject({ approvedPlanHash: hash });
    const plan = await readArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"));
    expect(plan.deployment).toMatchObject({ lastPlanHash: hash });
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect((await readServerAddresses(paths)).deployment?.ipv4).toBe(SERVER_IPV4);
    expect(await readFile(paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
    expect(plan.approvals).toEqual([
      expect.objectContaining({ planHash: hash, approver: "--yes flag", kind: "iac-apply" }),
    ]);
    expect([...second.github.secrets.keys()]).toContain("OPSCREW_SSH_PRIVATE_KEY");
    expect(second.github.pulls).toEqual([
      expect.objectContaining({ head: "opscrew/deploy-setup", base: "main" }),
    ]);
    expect(
      await git(project.env, project.bare, "branch", "--list", "opscrew/deploy-setup"),
    ).toContain("opscrew/deploy-setup");
    expect(second.ctx.output).toContain(`Created or updated the server at ${SERVER_IPV4}.`);
    expect(second.ctx.output).toContain("https://github.com/acme/shop/pull/7");
    expect(second.ctx.output).toContain("`opscrew verify`");
    expect(second.ctx.output).toContain("`opscrew secure`");
    const approvals = await readFile(
      path.join(project.root, ".opscrew", "approvals.jsonl"),
      "utf8",
    );
    expect(approvals).toContain(hash);
  });

  it("says plainly when the deployment files did not change, and still shows an open pull request", async () => {
    project = await deployProject();
    const first = context(project);
    expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);
    const hash = printedHash(first.ctx.output);
    const github = new FakeGitHub();
    expect(
      await run(context(project, { github }).ctx, "provision", "--approve", hash, "--yes"),
    ).toBe(0);
    expect(github.pulls).toHaveLength(1);
    const pull = { number: 7, url: "https://github.com/acme/shop/pull/7" };
    github.openPulls.set("opscrew/deploy-setup", pull);
    const nothingToChange = () =>
      context(project as DeployProject, { github, engine: new FakeEngine({ changes: [] }) });
    const unchanged =
      "The deployment files did not change, so OpsCrew committed nothing and opened no pull request.";

    // Again with nothing to change, while the pull request is open.
    const open = nothingToChange();
    expect(await run(open.ctx, "provision", "--yes"), open.ctx.errors).toBe(0);
    expect(open.ctx.output).toContain(
      `The deployment files did not change, so OpsCrew committed nothing. The pull request from earlier is still open: ${pull.url}`,
    );
    expect(open.ctx.output).not.toContain("opened no pull request");
    expect(open.ctx.output).toContain("when the deploy run in GitHub Actions has finished");
    expect(github.pulls).toHaveLength(1);

    // Merged on GitHub (its branch deleted there) and pulled into main: nothing to deploy.
    const merged = await git(project.env, project.root, "rev-parse", "opscrew/deploy-setup");
    await git(project.env, project.bare, "update-ref", "refs/heads/main", merged);
    await git(project.env, project.bare, "update-ref", "-d", "refs/heads/opscrew/deploy-setup");
    github.openPulls.delete("opscrew/deploy-setup");

    // Still on opscrew/deploy-setup: no merge note for it, and how to switch back.
    const stale = nothingToChange();
    expect(await run(stale.ctx, "provision", "--yes"), stale.ctx.errors).toBe(0);
    expect(stale.ctx.output).toContain(
      "The deployment files did not change and are already on main on GitHub, so OpsCrew committed nothing and opened no pull request. Your deploy pull request is merged: switch to main and pull (`git switch main && git pull`).",
    );
    expect(stale.ctx.output).not.toContain("Merging opscrew/deploy-setup into main");
    expect(stale.ctx.output).toContain("run `opscrew verify` to check the live site");
    expect(github.pulls).toHaveLength(1);
    expect(await git(project.env, project.bare, "branch", "--list", "opscrew/deploy-setup")).toBe(
      "",
    );

    await git(project.env, project.root, "checkout", "-q", "main");
    await git(project.env, project.root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
    const none = nothingToChange();
    expect(await run(none.ctx, "provision", "--yes"), none.ctx.errors).toBe(0);
    expect(none.ctx.output).toContain(unchanged);
    expect(none.ctx.output).toContain(
      "run `opscrew verify` to check the live site and write opscrew/RUNBOOK.md.",
    );
    for (const stale of ["when the deploy run", "still open", "committed on", "Merging", "merge"]) {
      expect(none.ctx.output).not.toContain(stale);
    }
    expect(github.pulls).toHaveLength(1);
  });

  it("after a refused push, the next step is pushing the branch", async () => {
    project = await deployProject();
    const approveAll = new ApproveAll();
    const refusePush: ApprovalHandler = {
      request: async (request) =>
        request.kind === "git-push"
          ? { approved: false, approver: "test", decidedAt: "2026-10-11T12:00:00.000Z" }
          : approveAll.request(request),
    };
    const { ctx } = context(project, { approvals: refusePush });
    expect(await run(ctx, "provision"), ctx.errors).toBe(0);
    expect(ctx.errors).toContain("Not pushed.");
    expect(ctx.output).toContain(
      "push opscrew/deploy-setup (`git push -u origin opscrew/deploy-setup`) and open a pull request into main; merging it deploys the app.",
    );
    expect(ctx.output).not.toContain("did not change");
  });

  it("refuses a hash that matches no saved plan and exits 1 without applying", async () => {
    project = await deployProject();
    const first = context(project);
    expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);

    const second = context(project);
    const wrong = "0".repeat(64);
    expect(await run(second.ctx, "provision", "--approve", wrong, "--yes")).toBe(1);
    expect(second.ctx.errors).toContain(`No saved plan has the hash ${wrong}.`);
    expect(second.ctx.errors).toContain("opscrew provision --plan-only");
    expect(second.engine.calls).not.toContain("apply");
    expect(second.github.secrets.size).toBe(0);
  });

  it("exits 2 for a malformed hash, conflicting flags or an unknown engine", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--approve", "abc123")).toBe(2);
    expect(ctx.errors).toContain("--approve expects the 64-character SHA-256 plan hash");
    expect(await run(ctx, "provision", "--plan-only", "--approve", "a".repeat(64))).toBe(2);
    expect(ctx.errors).toContain("Use either --plan-only or --approve <hash>.");
    expect(await run(ctx, "provision", "--engine", "pulumi")).toBe(2);
    expect(ctx.errors).toContain("pulumi");
    expect(engine.calls).toEqual([]);
  });

  it("needs --approve <hash> for the apply even with --yes", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--yes")).toBe(1);
    expect(engine.calls).not.toContain("apply");
    expect(ctx.errors).toContain("The infrastructure plan was not approved");
    expect(ctx.errors).toMatch(/opscrew provision --approve [0-9a-f]{64}/);
  });

  it("explains --yes when a non-interactive run cannot write the files", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "provision", "--plan-only")).toBe(1);
    expect(ctx.errors).toContain("Nothing was written and nothing was created.");
    expect(ctx.errors).toContain("add --yes");
    expect(ctx.errors).toContain(
      "a plan that deletes or replaces resources also needs --confirm <app name> (opscrew provision --approve <hash> --confirm <app name>), a move's maintenance window --allow-downtime, other destroys and changed host keys need an interactive terminal.",
    );
    expect(engine.calls).toEqual([]);
  });

  it("stops with exit 1 when a security policy fails", async () => {
    project = await deployProject();
    const engine = new FakeEngine({ planJson: planJsonFor({ openDatabasePort: true }) });
    const { ctx } = context(project, { engine });
    expect(await run(ctx, "provision", "--plan-only", "--yes")).toBe(1);
    expect(ctx.errors).toMatch(/The plan fails 1 security policy/);
    expect(ctx.output).not.toContain("Plan hash (SHA-256):");
  });

  it("asks for the scheduled check's webhook address with hidden input, and stores it as a secret", async () => {
    const base = testPlan({ userSecret: false });
    project = await deployProject(
      DeployPlanSchema.parse({
        ...base,
        observability: { check: { enabled: true, webhook: "ntfy" } },
      }),
    );
    const webhook = `https://ntfy.example.com/opscrew-${fakeSecret("generic-password", "ntfy")}`;
    // The webhook's address; then no age key of the user's own, and no file for a new one yet.
    const prompts = new ScriptedPrompts([webhook, "", CANCEL]);
    const { ctx, github } = context(project, {
      interactive: true,
      approvals: new ApproveAll(),
      prompts,
    });
    expect(await run(ctx, "provision"), ctx.errors).toBe(0);
    expect(prompts.calls[0]).toEqual({
      kind: "password",
      message: "Address of the ntfy webhook for the scheduled check (stored as a GitHub secret)",
    });
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(webhook);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(webhook);
  });

  it("asks for production values in an interactive terminal without printing them", async () => {
    project = await deployProject(testPlan({ userSecret: true }));
    const stripe = fakeSecret("stripe-live-key");
    const approvals = new ApproveAll();
    // No age key of the user's own, and no file for a new one yet: no recovery copy this time.
    const prompts = new ScriptedPrompts([stripe, "", CANCEL]);
    const { ctx, engine, github } = context(project, { interactive: true, approvals, prompts });
    expect(await run(ctx, "provision")).toBe(0);

    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(prompts.calls.map((c) => c.message)).toEqual([
      "Production value for STRIPE_SECRET_KEY (leave empty to skip)",
      expect.stringContaining("Do you already have an age key for it?"),
      expect.stringContaining("Where should OpsCrew write your new age key"),
    ]);
    expect(ctx.errors).toContain("OpsCrew has made no encrypted recovery copy");
    expect(github.secrets.get("OPSCREW_APP_ENV")).toContain(`STRIPE_SECRET_KEY=${stripe}`);
    expect(approvals.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(stripe);
  });

  describe("the recovery copy's first age key", () => {
    /** The key line of a key file OpsCrew wrote, failing the test when there is none. */
    async function identityIn(file: string): Promise<string> {
      const line = (await readFile(file, "utf8"))
        .split("\n")
        .find((text) => text.startsWith("AGE-SECRET-KEY-1"));
      if (line === undefined) throw new Error(`no age key in ${file}`);
      return line;
    }

    it("--key-out writes the new key to that file only, never prints it, and commits the copy", async () => {
      project = await deployProject();
      project.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
      const sops = new FakeSops();
      const keyFile = path.join(project.dir, "age-key.txt");
      // Without --key-out the plan-only run says the apply needs one; with it, the command repeats it.
      const bare = context(project, { sops });
      expect(await run(bare.ctx, "provision", "--plan-only", "--yes")).toBe(0);
      expect(bare.ctx.output).toContain("in a script, add --key-out <file outside the repository>");
      const first = context(project, { sops });
      expect(await run(first.ctx, "provision", "--plan-only", "--yes", "--key-out", keyFile)).toBe(
        0,
      );
      const hash = printedHash(first.ctx.output);
      expect(first.ctx.output).toContain(
        `    opscrew provision --approve ${hash} --yes --key-out ${keyFile.replaceAll("\\", "/")}\n`,
      );
      expect(first.ctx.output).not.toContain("in a script, add --key-out");
      const second = context(project, { sops });
      const code = await run(
        second.ctx,
        "provision",
        "--approve",
        hash,
        "--yes",
        "--key-out",
        keyFile,
      );
      expect(code, second.ctx.errors).toBe(0);

      const identity = await identityIn(keyFile);
      if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
      const said = `${second.ctx.output}${second.ctx.errors}`;
      expect(said).toContain(`OpsCrew wrote your new age key to ${keyFile}.`);
      expect(said).not.toContain(identity);
      const committed = await git(
        project.env,
        project.root,
        "show",
        "opscrew/deploy-setup:opscrew/secrets.sops.json",
      );
      expect(committed).toContain("ENC[AES256_GCM");
      expect(committed).not.toContain(identity);
      expect(await auditText(project)).not.toContain(identity);
    });

    it("asks for the key file's path in a terminal and offers a backup key", async () => {
      project = await deployProject();
      project.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
      const keyFile = path.join(project.dir, "asked-key.txt");
      const prompts = new ScriptedPrompts(["", keyFile, ""]);
      const { ctx } = context(project, {
        interactive: true,
        approvals: new ApproveAll(),
        prompts,
        sops: new FakeSops(),
      });
      expect(await run(ctx, "provision"), ctx.errors).toBe(0);
      expect(prompts.calls.map((call) => call.message)).toEqual([
        expect.stringContaining("Do you already have an age key for it?"),
        expect.stringContaining("Where should OpsCrew write your new age key"),
        expect.stringContaining("Add a second, offline backup key"),
      ]);
      expect(`${ctx.output}${ctx.errors}`).not.toContain(await identityIn(keyFile));
    });
  });

  describe("a plan that removes something (needs the app's name)", () => {
    /** A plan that replaces the server: its `iac-apply` asks for the app's name "shop". */
    const removal = () =>
      new FakeEngine({
        changes: [
          {
            address: "module.server.hcloud_server.this",
            type: "hcloud_server",
            name: "this",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "replace",
          },
        ],
      });

    async function planned(): Promise<string> {
      project = await deployProject();
      const first = context(project, { engine: removal() });
      expect(await run(first.ctx, "provision", "--plan-only", "--yes")).toBe(0);
      const hash = printedHash(first.ctx.output);
      expect(first.ctx.output).toContain(
        `    opscrew provision --approve ${hash} --yes --confirm shop\n`,
      );
      expect(first.ctx.output).toContain(
        'This plan deletes or replaces resources, so applying it also needs "shop" typed: type it when the command asks in a terminal, or keep --confirm shop in the command above in a script.',
      );
      return hash;
    }

    it("a Cloudflare plan that deletes OpsCrew's rule prints --confirm <app> in the --approve command", async () => {
      project = await deployProject(testPlan({ domain: "shop.example.com" }));
      const zone = new FakeZone();
      // Deployed once: the app's hostname is in OpsCrew's rules.
      const first = context(project, { approvals: new ApproveAll(), zone });
      // (The run stops later, at the production values this test does not give.)
      await run(first.ctx, "provision");
      expect(zone.opscrewRule("http_request_firewall_custom")).toBeDefined();
      // The app stops blocking probes: its hostname leaves OpsCrew's rule, the only app in it.
      const file = path.join(project.root, "opscrew", "plan.yaml");
      const plan = await readArtifact("plan", file);
      await writeArtifact("plan", file, {
        ...plan,
        security: { ...plan.security, wafCustomRules: false },
      });

      const second = context(project, { zone });
      expect(await run(second.ctx, "provision", "--plan-only", "--yes"), second.ctx.errors).toBe(0);
      const hash = /Cloudflare plan:\s+([0-9a-f]{64})/.exec(second.ctx.output)?.[1];
      expect(hash).toBeDefined();
      expect(second.ctx.output).toMatch(
        new RegExp(
          `    opscrew provision --approve ${hash}( --approve [0-9a-f]{64})? --yes --confirm shop\n`,
        ),
      );
      expect(second.ctx.output).toContain("keep --confirm shop in the command above in a script.");
      const printed = /\n {4}opscrew (provision --approve [^\n]*)\n/.exec(second.ctx.output)?.[1];
      const args = (printed ?? "").split(" ");

      // A wrong name stops before anything runs: OpsCrew's rule stays.
      const wrong = context(project, { zone });
      const misnamed = args.map((arg) => (arg === "shop" ? "shopx" : arg));
      expect(await run(wrong.ctx, ...misnamed)).toBe(1);
      expect(wrong.ctx.errors).toContain("--confirm shopx does not match the app's name");
      expect(wrong.ctx.errors).toContain("--confirm shop");
      expect(zone.opscrewRule("http_request_firewall_custom")).toBeDefined();

      // The printed command deletes it (the run stops later, at the production values).
      const third = context(project, { zone });
      await run(third.ctx, ...args);
      expect(third.ctx.output).toContain("(confirmed with --confirm shop)");
      expect(zone.opscrewRule("http_request_firewall_custom")).toBeUndefined();
    });

    it("--approve <hash> --confirm <app> applies exactly that plan in a script", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      // The confirmation decides on the run's clock, never the computer's.
      withServices(second.ctx, { clock: { now: () => new Date("2030-01-02T03:04:05.000Z") } });
      expect(
        await run(second.ctx, "provision", "--approve", hash, "--confirm", "shop", "--yes"),
      ).toBe(0);
      expect(second.engine.calls).toEqual(["apply"]);
      expect(second.engine.applied[0]?.approval).toMatchObject({
        approvedPlanHash: hash,
        allowDestroy: true,
      });
      expect(second.ctx.output).toContain("(confirmed with --confirm shop)");
      const paths = resolveProjectPaths((project as DeployProject).root, {
        env: (project as DeployProject).env,
      });
      const confirmed = (await readFile(paths.files.approvals, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { approver: string; decidedAt: string })
        .filter((record) => record.approver === "--approve and --confirm flags");
      expect(confirmed).toEqual([
        expect.objectContaining({ decidedAt: "2030-01-02T03:04:05.000Z" }),
      ]);
    });

    it("takes one --confirm per extra server the plan deletes, and the app's name for the rest", async () => {
      /** Server `db` left `servers`: its module is deleted, and the app's server is replaced. */
      const dropped = () =>
        new FakeEngine({
          changes: [
            ...["hcloud_server", "hcloud_firewall"].map((type) => ({
              address: `module.server_db.${type}.this`,
              type,
              name: "this",
              provider: "registry.opentofu.org/hetznercloud/hcloud",
              action: "delete" as const,
            })),
            {
              address: "module.server.hcloud_server.this",
              type: "hcloud_server",
              name: "this",
              provider: "registry.opentofu.org/hetznercloud/hcloud",
              action: "replace",
            },
          ],
        });
      project = await deployProject();
      const first = context(project, { engine: dropped() });
      expect(await run(first.ctx, "provision", "--plan-only", "--yes"), first.ctx.errors).toBe(0);
      const hash = printedHash(first.ctx.output);
      expect(first.ctx.output).toContain(
        `    opscrew provision --approve ${hash} --yes --confirm shop --confirm shop-db\n`,
      );
      expect(first.ctx.output).toContain(
        'applying it also needs "shop shop-db" typed: type it when the command asks in a terminal, or keep --confirm shop --confirm shop-db in the command above in a script.',
      );

      // Without --confirm, the refusal names every flag to add.
      const approve = ["provision", "--approve", hash, "--yes"];
      const bare = context(project, { engine: dropped() });
      expect(await run(bare.ctx, ...approve)).toBe(1);
      expect(bare.ctx.errors).toContain(
        `To apply it later without prompts, run: opscrew provision --approve ${hash} --confirm shop --confirm shop-db`,
      );

      // The server's own name alone is not enough: the app's server is replaced too.
      const partial = context(project, { engine: dropped() });
      expect(await run(partial.ctx, ...approve, "--confirm", "shop-db")).toBe(1);
      expect(partial.ctx.errors).toContain(
        "needs shop shop-db typed to confirm: add --confirm shop",
      );
      expect(partial.engine.calls).not.toContain("apply");

      // A value that names neither the app nor an extra server stops before anything runs.
      const wrong = context(project, { engine: dropped() });
      expect(await run(wrong.ctx, ...approve, "--confirm", "shop", "--confirm", "db")).toBe(1);
      expect(wrong.ctx.errors).toContain("--confirm db does not match the app's name");
      expect(wrong.engine.calls).toEqual([]);

      const second = context(project, { engine: dropped() });
      expect(
        await run(second.ctx, ...approve, "--confirm", "shop", "--confirm", "shop-db"),
        second.ctx.errors,
      ).toBe(0);
      expect(second.engine.calls).toEqual(["apply"]);
      expect(second.ctx.output).toContain("(confirmed with --confirm shop --confirm shop-db)");
    });

    it("stops before anything runs when --confirm is not the app's name", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      expect(
        await run(second.ctx, "provision", "--approve", hash, "--confirm", "shopp", "--yes"),
      ).toBe(1);
      expect(second.ctx.errors).toContain(
        "--confirm shopp does not match the app's name, so nothing was changed.",
      );
      expect(second.ctx.errors).toContain("opscrew provision --approve <hash> … --confirm shop");
      expect(second.engine.calls).toEqual([]);
    });

    it("refuses a script without --confirm, naming the flag; --yes never approves it", async () => {
      const hash = await planned();
      const second = context(project as DeployProject, { engine: removal() });
      expect(await run(second.ctx, "provision", "--approve", hash, "--yes")).toBe(1);
      expect(second.ctx.errors).toContain("add --confirm shop");
      expect(second.ctx.errors).toContain(
        `To apply it later without prompts, run: opscrew provision --approve ${hash} --confirm shop`,
      );
      expect(second.engine.calls).not.toContain("apply");
    });

    it("only plans with --confirm and no --approve in a script, and prints the command that applies", async () => {
      project = await deployProject();
      const { ctx, engine } = context(project, { engine: removal() });
      expect(await run(ctx, "provision", "--confirm", "shop", "--yes"), ctx.errors).toBe(0);
      expect(ctx.output).toMatch(/opscrew provision --approve [0-9a-f]{64}.* --confirm shop/);
      expect(engine.calls).not.toContain("apply");
    });

    it("still asks for the typed name in a terminal", async () => {
      project = await deployProject();
      const approvals = new ApproveAll();
      const { ctx, engine } = context(project, {
        engine: removal(),
        interactive: true,
        approvals,
        prompts: new ScriptedPrompts(["", CANCEL]),
      });
      expect(await run(ctx, "provision")).toBe(0);
      expect(engine.calls).toContain("apply");
      expect(approvals.requests.find((r) => r.kind === "iac-apply")).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "shop",
      });
    });
  });

  it("shows the options in --help", async () => {
    project = await deployProject();
    const { ctx } = context(project);
    expect(await run(ctx, "provision", "--help")).toBe(0);
    for (const option of [
      "--plan-only",
      "--approve <hash>",
      "--engine <name>",
      "--no-push",
      "--yes",
      "--confirm <name>",
    ]) {
      expect(ctx.output).toContain(option);
    }
  });
});
