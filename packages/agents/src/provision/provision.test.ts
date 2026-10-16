import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderRunbook } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readServerAddresses } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  DIGITALOCEAN_CREATE,
  FakeEngine,
  type FakeEngineScenario,
  FakeGitHub,
  fakeCloudflare,
  HOST_KEY,
  heldRulesetsOutput,
  movingPlan,
  opscrewRecord,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
  writeFakeState,
} from "../testing";
import { findSavedPlan } from "./plan-apply";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { deploymentRenderContext, previewDeploymentFiles } from "./render";
import { ADDRESS_MAY_BE_PUBLIC_NOTE, runProvision } from "./run";
import type { ProvisionServices } from "./types";

const STRIPE = fakeSecret("stripe-live-key");
/** The pull request the first run opened, while it is still open. */
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const HCLOUD = fakeSecret("hcloud-token");

interface SetupOptions {
  plan?: ReturnType<typeof testPlan>;
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  engine?: FakeEngine;
  services?: ProvisionServices;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

async function setup(options: SetupOptions = {}) {
  const project = await createProject(options.plan ?? testPlan());
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const engine = options.engine ?? new FakeEngine();
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    OPSCREW_APP_ENV_FILE: "production.env",
    ...options.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    ...options.services,
  };
  return { ...project, deps, engine, github, handler, services };
}

/** Every user-visible or persisted text a run produced. */
function everythingPrinted(deps: Awaited<ReturnType<typeof setup>>["deps"]) {
  return `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
}

describe.skipIf(!findExecutable("git"))("runProvision", () => {
  it("renders, plans, applies, waits, stores secrets, commits, pushes and opens a pull request", async () => {
    const { deps, engine, github, handler, services, root, bare, git } = await setup();
    const result = await runProvision(deps, { services });

    expect(handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.initOptions?.backendConfig?.path).toBe(
      join(deps.paths.files.tfstateDir, "prod.tfstate"),
    );
    expect(engine.initOptions?.env?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(result).toMatchObject({
      applied: true,
      branch: DEPLOY_SETUP_BRANCH,
      prUrl: "https://github.com/acme/shop/pull/7",
    });

    for (const file of [
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/modules/hetzner-vps/main.tf",
      "opscrew/runtime/compose.yaml",
      "opscrew/runtime/Caddyfile",
      ".github/workflows/opscrew-deploy.yml",
    ]) {
      await expect(readFile(join(root, file), "utf8")).resolves.toContain("OpsCrew");
    }

    const plan = await readArtifact("plan", deps.paths.files.plan);
    // No URL either: without a domain it would be the server's IP address.
    expect(plan.deployment).toEqual({
      lastPlanHash: result.planHash,
      lastApplyAt: "2026-10-11T12:00:00.000Z",
      lastCompletedPhase: "provision",
    });
    // The server's address is in OpsCrew's local state only, never in the repository or the PR.
    expect((await readServerAddresses(deps.paths)).deployment).toEqual({
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
    });
    const published = `${await git(root, "show", "HEAD")}\n${github.pulls[0]?.body}`;
    expect(published).toContain("opscrew/plan.yaml");
    expect(published).not.toContain(SERVER_IPV4);
    expect(published).not.toContain(SERVER_IPV6);
    expect(github.pulls[0]?.body).toContain("deploys the app to the server.");
    expect(plan.approvals).toEqual([
      expect.objectContaining({ planHash: result.planHash, kind: "iac-apply" }),
    ]);

    expect([...github.secrets.keys()].sort()).toEqual([
      "OPSCREW_APP_ENV",
      "OPSCREW_BUILD_ENV",
      "OPSCREW_DB_ENV",
      "OPSCREW_HOST",
      "OPSCREW_SSH_KNOWN_HOSTS",
      "OPSCREW_SSH_PRIVATE_KEY",
    ]);
    expect(github.secrets.get("OPSCREW_HOST")).toBe(SERVER_IPV4);
    expect(github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(`${SERVER_IPV4} ${HOST_KEY}\n`);
    expect(github.secrets.get("OPSCREW_APP_ENV")).toContain(`STRIPE_SECRET_KEY=${STRIPE}`);
    expect(github.secrets.get("OPSCREW_SSH_PRIVATE_KEY")).toContain("OPENSSH PRIVATE KEY");
    await expect(readFile(deps.paths.files.knownHosts, "utf8")).resolves.toContain(HOST_KEY);

    expect(github.pulls).toEqual([
      expect.objectContaining({ head: DEPLOY_SETUP_BRANCH, base: "main" }),
    ]);
    expect(github.pulls[0]?.body).toContain("Opened by OpsCrew");
    expect(await git(bare, "branch", "--list", DEPLOY_SETUP_BRANCH)).toContain(DEPLOY_SETUP_BRANCH);
    const committed = await git(root, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain("opscrew/plan.yaml");
    expect(committed).toContain(".github/workflows/opscrew-deploy.yml");
    expect(github.pulls[0]?.body).toContain("the deploy secrets are stored in GitHub Actions");
    expect(deps.audit.entries.find((e) => e.kind === "iac")?.phase).toBe("provision");

    expect((await deps.state.read()).phases.provision?.status).toBe("ok");

    // No secret value ever reaches the reporter or the audit log
    const printed = everythingPrinted(deps);
    const secretValue = (secret: string, name: string) =>
      new RegExp(`${name}=(\\S+)`).exec(github.secrets.get(secret) ?? "")?.[1] as string;
    const dbPassword = secretValue("OPSCREW_DB_ENV", "POSTGRES_PASSWORD");
    const sessionSecret = secretValue("OPSCREW_APP_ENV", "SESSION_SECRET");
    expect(dbPassword).toHaveLength(32);
    expect(sessionSecret).toHaveLength(32);
    const keyLines = (github.secrets.get("OPSCREW_SSH_PRIVATE_KEY") as string)
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("-----"));
    for (const value of [STRIPE, HCLOUD, dbPassword, sessionSecret, ...keyLines]) {
      expect(printed).not.toContain(value);
    }
    expect(
      deps.audit.entries.filter((e) => e.kind === "secret-set").map((e) => e.action),
    ).toContain("set secret OPSCREW_APP_ENV");
  });

  it("a new deployment after opscrew destroy no longer records the teardown", async () => {
    const plan = testPlan();
    const { deps, services } = await setup({
      plan: {
        ...plan,
        deployment: { ...plan.deployment, destroyedAt: "2026-10-10T10:00:00.000Z" },
      },
    });
    await runProvision(deps, { services });
    const after = await readArtifact("plan", deps.paths.files.plan);
    expect(after.deployment.destroyedAt).toBeUndefined();
    expect((await readServerAddresses(deps.paths)).deployment?.ipv4).toBe(SERVER_IPV4);
  });

  it("keeps the app's defaults and fills host lists with the address only in the deploy secrets", async () => {
    const base = testPlan();
    const plan = {
      ...base,
      app: {
        ...base.app,
        env: [
          { name: "CSRF_TRUSTED_ORIGINS", secret: false, source: "derived" as const },
          { name: "DATABASE_URL", secret: true, source: "derived" as const },
          {
            name: "DJANGO_ALLOWED_HOSTS",
            secret: false,
            source: "derived" as const,
            optional: true,
          },
          { name: "DJANGO_DEBUG", secret: false, source: "user" as const, optional: true },
          { name: "DJANGO_SECRET_KEY", secret: true, source: "generated" as const },
        ],
      },
    };
    const { deps, github, services, root, git } = await setup({ plan });
    await writeFile(join(root, "production.env"), "");
    await runProvision(deps, { services });

    const appEnv = github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain(`DJANGO_ALLOWED_HOSTS=${SERVER_IPV4}\n`);
    expect(appEnv).toContain(`CSRF_TRUSTED_ORIGINS=http://${SERVER_IPV4}\n`);
    expect(appEnv).not.toContain("DJANGO_DEBUG");
    expect(deps.reporter.text()).toContain(
      "DJANGO_DEBUG has no production value, so the app uses the default in its code.",
    );
    // The address is in the deploy secrets only: not in the plan, the commit or the pull request.
    const published = `${await git(root, "show", "HEAD")}\n${github.pulls[0]?.body}`;
    expect(published).not.toContain(SERVER_IPV4);
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
    const secretKey = /DJANGO_SECRET_KEY=(\S+)/.exec(appEnv)?.[1] as string;
    expect(everythingPrinted(deps)).not.toContain(secretKey);
  });

  it("fills host lists with the domain when the plan has one", async () => {
    const base = testPlan({ domain: "example.com", www: true });
    const plan = {
      ...base,
      app: {
        ...base.app,
        env: [
          ...base.app.env,
          { name: "ALLOWED_HOSTS", secret: false, source: "derived" as const },
        ],
      },
    };
    const { deps, github, services } = await setup({
      plan,
      services: { cloudflare: fakeCloudflare() },
    });
    await runProvision(deps, { services });
    const appEnv = github.secrets.get("OPSCREW_APP_ENV") ?? "";
    expect(appEnv).toContain("ALLOWED_HOSTS=example.com,www.example.com\n");
    expect(appEnv).not.toContain(SERVER_IPV4);
  });

  it("stops before planning when a name is too deep for the zone Cloudflare names", async () => {
    // Hand-edited: www. on a domain one level below the zone, which is not known until now.
    const plan = testPlan({ domain: "shop.example.com", www: true });
    const engine = new FakeEngine();
    const { deps, github, services } = await setup({
      plan,
      engine,
      services: { cloudflare: fakeCloudflare() },
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining(
        "opscrew/plan.yaml cannot be provisioned in the Cloudflare zone example.com: dns.www can be true only when the domain is example.com itself while Cloudflare serves it: Cloudflare's free certificate covers only example.com and *.example.com, so www.shop.example.com would fail HTTPS at Cloudflare's edge",
      ),
    });
    expect(engine.calls).toEqual([]);
    expect(engine.applied).toEqual([]);
    expect(github.secrets.size).toBe(0);
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("clears the teardown record before a new apply starts, even when the apply fails", async () => {
    const plan = testPlan();
    const engine = new FakeEngine({ applyOk: false });
    const { deps, services } = await setup({
      engine,
      plan: {
        ...plan,
        deployment: { ...plan.deployment, destroyedAt: "2026-10-10T10:00:00.000Z" },
      },
    });
    const apply = engine.apply.bind(engine);
    const seen: (string | undefined)[] = [];
    engine.apply = async (...args: Parameters<FakeEngine["apply"]>) => {
      seen.push((await readArtifact("plan", deps.paths.files.plan)).deployment.destroyedAt);
      return apply(...args);
    };
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
    });
    expect(seen).toEqual([undefined]);
    expect((await readArtifact("plan", deps.paths.files.plan)).deployment.destroyedAt).toBe(
      undefined,
    );
  });

  it("keeps the teardown record when nothing is applied (--plan-only)", async () => {
    const plan = testPlan();
    const { deps, services } = await setup({
      plan: {
        ...plan,
        deployment: { ...plan.deployment, destroyedAt: "2026-10-10T10:00:00.000Z" },
      },
    });
    await runProvision(deps, { services, planOnly: true });
    expect((await readArtifact("plan", deps.paths.files.plan)).deployment.destroyedAt).toBe(
      "2026-10-10T10:00:00.000Z",
    );
  });

  it("keeps the database password and reuses key and host pin when run again", async () => {
    const { deps, github, services, handler } = await setup();
    await runProvision(deps, { services });
    const firstDb = github.secrets.get("OPSCREW_DB_ENV");
    const firstKey = github.secrets.get("OPSCREW_SSH_PRIVATE_KEY");
    handler.requests.length = 0;

    // The first run's pull request is still open: the second run adds to it.
    github.openPulls.set(DEPLOY_SETUP_BRANCH, {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
    });
    const second = await runProvision(deps, { services });
    expect(github.secrets.get("OPSCREW_DB_ENV")).toBe(firstDb);
    expect(github.secrets.get("OPSCREW_SSH_PRIVATE_KEY")).toBe(firstKey);
    // files are unchanged, so no repo-write; the fake engine plans the same changes again
    expect(handler.requests.map((r) => r.kind)).not.toContain("repo-write");
    expect(handler.requests.map((r) => r.kind)).not.toContain("remote-exec");
    expect(second.branch).toBe(DEPLOY_SETUP_BRANCH);
    expect(second.prUrl).toBe("https://github.com/acme/shop/pull/7");
    expect(github.pulls).toHaveLength(1);
  });

  describe("a deploy branch left on GitHub by an earlier run", () => {
    const OPEN = { number: 4, url: "https://github.com/acme/shop/pull/4" };

    it("opens the pull request from a new branch when the earlier one was merged or closed", async () => {
      const { deps, services, github, git, root, bare } = await setup();
      const main = await git(root, "rev-parse", "main");
      await git(root, "push", "-q", "origin", `main:refs/heads/${DEPLOY_SETUP_BRANCH}`);
      await git(root, "branch", DEPLOY_SETUP_BRANCH);

      const result = await runProvision(deps, { services });

      const branch = `${DEPLOY_SETUP_BRANCH}-2`;
      expect(result.branch).toBe(branch);
      expect(result.prUrl).toBe("https://github.com/acme/shop/pull/7");
      expect(github.pulls).toEqual([expect.objectContaining({ head: branch, base: "main" })]);
      expect(await git(bare, "rev-parse", branch)).toBe(await git(root, "rev-parse", "HEAD"));
      // The old branch is never touched, on GitHub or here.
      expect(await git(bare, "rev-parse", DEPLOY_SETUP_BRANCH)).toBe(main);
      expect(await git(root, "rev-parse", DEPLOY_SETUP_BRANCH)).toBe(main);
      expect(deps.reporter.text()).toContain(
        `${DEPLOY_SETUP_BRANCH} is already on GitHub from an earlier run, and no pull request from it is open`,
      );
    });

    it("stops before changing anything when its open pull request has commits this clone lacks", async () => {
      const { deps, services, github, git, root, engine, handler } = await setup();
      await git(root, "push", "-q", "origin", `main:refs/heads/${DEPLOY_SETUP_BRANCH}`);
      github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN);

      const error = await runProvision(deps, { services }).catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(OPEN.url),
        hint: expect.stringContaining("Merge or close it"),
      });
      expect(handler.requests).toEqual([]);
      expect(engine.calls).toEqual([]);
      expect(existsSync(join(root, "opscrew", "infra", "prod", "main.tf"))).toBe(false);
      expect(github.pulls).toEqual([]);
      expect((await deps.state.read()).phases.provision?.status).toBe("failed");
    });

    it("stops before any apply when a second run starts from another branch than the open PR's", async () => {
      const { deps, services, github, git, root, engine, handler } = await setup();
      await git(root, "add", "opscrew/plan.yaml");
      await git(root, "commit", "-q", "-m", "plan");
      await runProvision(deps, { services });
      github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN);
      await git(root, "checkout", "-q", "main");
      const calls = engine.calls.length;
      handler.requests.length = 0;

      const error = await runProvision(deps, { services }).catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining(`but this clone is on main, so OpsCrew did not change`),
        hint: expect.stringContaining(
          `Run \`git checkout ${DEPLOY_SETUP_BRANCH}\`, then run \`opscrew provision\` again.`,
        ),
      });
      expect((error as Error).message).toContain(OPEN.url);
      expect(engine.calls).toHaveLength(calls);
      expect(handler.requests).toEqual([]);
      expect(await git(root, "branch", "--show-current")).toBe("main");
      // No generated file was written on main.
      expect(await git(root, "status", "--porcelain")).not.toMatch(/ (?:opscrew|\.github)\//);
    });

    it("never commits on a stale local branch whose pull request was merged", async () => {
      const { deps, services, github, git, root, bare } = await setup();
      const first = await runProvision(deps, { services });
      expect(first.branch).toBe(DEPLOY_SETUP_BRANCH);
      // GitHub merged the pull request and deleted its branch; this clone pulled main.
      const merged = await git(root, "rev-parse", DEPLOY_SETUP_BRANCH);
      await git(bare, "update-ref", "refs/heads/main", merged);
      await git(bare, "update-ref", "-d", `refs/heads/${DEPLOY_SETUP_BRANCH}`);
      await git(root, "checkout", "-q", "main");
      await git(root, "merge", "-q", "--ff-only", DEPLOY_SETUP_BRANCH);

      const second = await runProvision(deps, { services });

      const branch = `${DEPLOY_SETUP_BRANCH}-2`;
      expect(second.branch).toBe(branch);
      expect(await git(root, "branch", "--show-current")).toBe(branch);
      expect(await git(root, "rev-parse", DEPLOY_SETUP_BRANCH)).toBe(merged);
      expect(await git(bare, "rev-parse", branch)).toBe(await git(root, "rev-parse", "HEAD"));
      expect(github.pulls.map((p) => p.head)).toEqual([DEPLOY_SETUP_BRANCH, branch]);
      expect(deps.reporter.text()).toContain(
        `${DEPLOY_SETUP_BRANCH} is only in this clone, from an earlier run, and you are not on it`,
      );
    });

    it("without a push, commits on a new branch rather than on a stale local one", async () => {
      const { deps, services, git, root } = await setup();
      await git(root, "branch", DEPLOY_SETUP_BRANCH);

      const result = await runProvision(deps, { services, push: false });

      expect(result.branch).toBe(`${DEPLOY_SETUP_BRANCH}-2`);
      expect(await git(root, "rev-parse", DEPLOY_SETUP_BRANCH)).toBe(
        await git(root, "rev-parse", "main"),
      );
    });

    it("does not reach origin with --plan-only or --no-push", async () => {
      const { deps, services, github, git, root } = await setup();
      await git(root, "push", "-q", "origin", `main:refs/heads/${DEPLOY_SETUP_BRANCH}`);
      github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN);

      await runProvision(deps, { services, planOnly: true });
      expect(github.lookups).toEqual([]);
      const result = await runProvision(deps, { services, push: false });
      expect(github.lookups).toEqual([]);
      expect(result.branch).toBe(DEPLOY_SETUP_BRANCH);
    });
  });

  describe("the deploy branch starts from the latest main", () => {
    /** The user's `opscrew adapt` branch, squash-merged on GitHub; this clone is still on it. */
    async function squashMergedAdapt(project: Awaited<ReturnType<typeof setup>>) {
      const { git, root } = project;
      await git(root, "push", "-q", "origin", "main");
      await git(root, "checkout", "-q", "-b", "opscrew/prepare-deploy");
      await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\nUSER node\nEXPOSE 3000\n");
      await git(root, "commit", "-q", "-am", "chore(opscrew): prepare the app for deployment");
      const squash = await git(
        root,
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "main",
        "-m",
        "Adapt (#1)",
      );
      await git(root, "push", "-q", "origin", `${squash}:refs/heads/main`);
      return squash;
    }

    it("stops on the adapt branch after a squash merge, then branches from the updated main", async () => {
      const project = await setup();
      const { deps, services, github, git, root, bare, engine, handler } = project;
      const squash = await squashMergedAdapt(project);

      const error = await runProvision(deps, { services }).catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "This clone is on opscrew/prepare-deploy, but the deployment files go on a new branch from the latest main, so OpsCrew did not change anything.",
        hint: "Run `git checkout main && git pull`, then run `opscrew provision` again.",
      });
      expect(engine.calls).toEqual([]);
      expect(handler.requests).toEqual([]);
      expect(existsSync(join(root, "opscrew", "infra", "prod", "main.tf"))).toBe(false);
      expect(await git(root, "branch", "--show-current")).toBe("opscrew/prepare-deploy");
      expect(github.pulls).toEqual([]);

      await git(root, "checkout", "-q", "main");
      await git(root, "pull", "-q", "--ff-only", bare, "main");
      const result = await runProvision(deps, { services });

      expect(result.branch).toBe(DEPLOY_SETUP_BRANCH);
      expect(await git(root, "rev-parse", `${DEPLOY_SETUP_BRANCH}^`)).toBe(squash);
      // The pull request holds the deployment files only, not the merged adapt changes again.
      const changed = await git(bare, "diff", "--name-only", "main", DEPLOY_SETUP_BRANCH);
      expect(changed).toContain("opscrew/plan.yaml");
      expect(changed).not.toContain("Dockerfile");
      expect(github.pulls).toEqual([
        expect.objectContaining({ head: DEPLOY_SETUP_BRANCH, base: "main" }),
      ]);
    });

    it("stops on a main that is behind GitHub", async () => {
      const { deps, services, git, root, engine, handler } = await setup();
      await git(root, "push", "-q", "origin", "main");
      const ahead = await git(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "upstream");
      await git(root, "push", "-q", "origin", `${ahead}:refs/heads/main`);

      await expect(runProvision(deps, { services })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "This clone's main is behind GitHub, and the deployment files go on a new branch from the latest main, so OpsCrew did not change anything.",
        hint: "Run `git pull`, then run `opscrew provision` again.",
      });
      expect(engine.calls).toEqual([]);
      expect(handler.requests).toEqual([]);
    });

    it("without a push, stops on another branch than main before anything is applied", async () => {
      const { deps, services, git, root, engine, handler } = await setup();
      await git(root, "checkout", "-q", "-b", "feature");

      await expect(runProvision(deps, { services, push: false })).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("This clone is on feature, but the deployment files"),
      });
      expect(engine.calls).toEqual([]);
      expect(handler.requests).toEqual([]);
    });
  });

  it("says once that the address may already be public when the plan turns the proxy on", async () => {
    const { deps, services, github, git, root, bare } = await setup({
      services: { cloudflare: fakeCloudflare() },
    });
    await git(root, "push", "-q", "origin", "main");
    await runProvision(deps, { services });
    expect(deps.reporter.text()).not.toContain(ADDRESS_MAY_BE_PUBLIC_NOTE);
    // Merged; the user then edits the plan to serve the app on a proxied domain.
    await git(bare, "update-ref", "refs/heads/main", await git(root, "rev-parse", "HEAD"));
    await git(root, "checkout", "-q", "main");
    await git(root, "pull", "-q", "--ff-only", bare, "main");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      dns: {
        ...plan.dns,
        provider: "cloudflare",
        domain: "shop.example.com",
        proxied: true,
      },
      security: { ...plan.security, httpAllowedFrom: "cloudflare" },
    });
    const printed = deps.reporter.text().length;

    await runProvision(deps, { services });
    expect(deps.reporter.text().slice(printed).split(ADDRESS_MAY_BE_PUBLIC_NOTE)).toHaveLength(2);

    // The committed files now have the proxy: a later run says nothing.
    github.openPulls.set(`${DEPLOY_SETUP_BRANCH}-2`, OPEN_PULL);
    const again = deps.reporter.text().length;
    await runProvision(deps, { services });
    expect(deps.reporter.text().slice(again)).not.toContain(ADDRESS_MAY_BE_PUBLIC_NOTE);
  });

  it("renders with the known address, as verify does, unless the plan hides it", async () => {
    const { deps } = await setup();
    const input = {
      requirements: undefined,
      github: { owner: "acme", repo: "shop" },
      deployPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey opscrew",
      cloudflare: undefined,
      server: { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 },
    };
    const open = testPlan();
    const shown = deploymentRenderContext(deps, { ...input, plan: open });
    expect(shown).toMatchObject({ serverIpv4: SERVER_IPV4, serverIpv6: SERVER_IPV6 });
    expect(renderRunbook(open, shown).content).toContain(SERVER_IPV4);

    const proxied = testPlan({ domain: "shop.example.com" });
    const hidden = deploymentRenderContext(deps, { ...input, plan: proxied });
    expect(hidden.serverIpv4).toBeUndefined();
    expect(hidden.serverIpv6).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain(SERVER_IPV4);
  });

  it("--plan-only saves the plan; --approve applies exactly that plan or refuses", async () => {
    const { deps, engine, services, github } = await setup({
      answer: (request) => request.kind !== "iac-apply" || request.planHash === approved,
    });
    let approved = "";
    const planned = await runProvision(deps, { services, planOnly: true });
    expect(planned.applied).toBe(false);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.calls).toEqual(["init", "validate", "plan"]);
    expect(github.secrets.size).toBe(0);
    expect(deps.reporter.text()).toContain(`Saved the plan (hash ${planned.planHash})`);
    const saved = await findSavedPlan(deps.paths.files.plansDir, planned.planHash as string);
    expect(saved?.planHash).toBe(planned.planHash);

    await expect(
      runProvision(deps, { services, approveHashes: ["0".repeat(64)] }),
    ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });

    approved = planned.planHash as string;
    const applied = await runProvision(deps, { services, approveHashes: [approved] });
    expect(applied).toMatchObject({ applied: true, planHash: approved });
    expect(engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(engine.applied[0]?.planFile).toBe(saved?.planFile);
  });

  it("stops before doing anything while a move to another provider is in progress", async () => {
    const { deps, engine, handler, services, github, root } = await setup({ plan: movingPlan() });
    const before = await readFile(join(root, "opscrew", "plan.yaml"), "utf8");
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "A move to DigitalOcean is in progress.",
      hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
    });
    expect(engine.calls).toEqual([]);
    expect(handler.requests).toEqual([]);
    expect(github.secrets.size).toBe(0);
    expect(deps.reporter.lines).toEqual([]);
    expect(await readFile(join(root, "opscrew", "plan.yaml"), "utf8")).toBe(before);
    expect((await deps.state.read()).phases.provision).toBeUndefined();
    await expect(runProvision(deps, { services, planOnly: true })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
    expect(engine.calls).toEqual([]);
  });

  it("stops before approval when a security policy fails", async () => {
    const engine = new FakeEngine({ planJson: planJsonFor({ openDatabasePort: true }) });
    const { deps, handler, services } = await setup({ engine });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("security"),
    });
    expect(handler.requests.map((r) => r.kind)).toEqual(["repo-write"]);
    expect(engine.calls).not.toContain("apply");
    expect((await deps.state.read()).phases.provision?.status).toBe("failed");
  });

  it("requires the typed server name to approve a plan that destroys something", async () => {
    const replace = {
      address: "module.server.hcloud_server.this",
      type: "hcloud_server",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "replace" as const,
    };
    const wrong = await setup({
      engine: new FakeEngine({ changes: [replace] }),
      answer: (request) =>
        request.kind === "iac-apply" ? { approved: true, confirmation: "yes" } : true,
    });
    await expect(runProvision(wrong.deps, { services: wrong.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(wrong.engine.calls).not.toContain("apply");
    const asked = wrong.handler.requests.find((r) => r.kind === "iac-apply");
    expect(asked).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });

    const right = await setup({ engine: new FakeEngine({ changes: [replace] }) });
    await runProvision(right.deps, { services: right.services });
    expect(right.engine.applied[0]?.approval).toMatchObject({ allowDestroy: true });
  });

  it("explains which token is missing and where to create it", async () => {
    const { deps, services } = await setup({ env: { HCLOUD_TOKEN: undefined } });
    const { provider: _ignored, ...withoutProvider } = services;
    await expect(runProvision(deps, { services: withoutProvider })).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining("HCLOUD_TOKEN"),
      hint: expect.stringContaining("https://console.hetzner.cloud/"),
    });
  });

  it("refuses when the Dockerfile is not committed", async () => {
    const { deps, services, git, root } = await setup();
    await git(root, "rm", "-q", "Dockerfile");
    await git(root, "commit", "-q", "-m", "drop dockerfile");
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("opscrew adapt"),
    });
  });

  it("does not manage Cloudflare rule phases the zone already uses", async () => {
    const { deps, services, root } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
      services: { cloudflare: fakeCloudflare({ configRules: true, wafRules: true }) },
    });
    await runProvision(deps, { services });
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ manage_config_rule: false, manage_waf_rules: false });
    expect(deps.reporter.text()).toContain("already has its own configuration rules");
    expect(deps.reporter.text()).toContain("already has its own WAF custom rules");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.dns.zone).toBe("example.com");
  });

  it("never publishes the server's address behind Cloudflare's proxy", async () => {
    const { deps, services, root, git, github } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({
        planJson: planJsonFor({ proxied: true }),
        outputs: {
          server_ipv4: SERVER_IPV4,
          server_ipv6: SERVER_IPV6,
          server_id: "4711",
          server_name: "shop",
          url: "https://shop.example.com",
        },
      }),
      services: { cloudflare: fakeCloudflare() },
    });
    const result = await runProvision(deps, { services });
    expect(result.prUrl).toBe("https://github.com/acme/shop/pull/7");

    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.url).toBe("https://shop.example.com");
    // Every committed file, the commit and the pull request: no address anywhere.
    const tracked = (await git(root, "ls-files")).split("\n").filter((path) => path !== "");
    expect(tracked).toContain("opscrew/plan.yaml");
    const contents = await Promise.all(tracked.map((path) => readFile(join(root, path), "utf8")));
    const published = [
      ...contents,
      await git(root, "show", "HEAD"),
      github.pulls[0]?.title ?? "",
      github.pulls[0]?.body ?? "",
    ].join("\n");
    expect(published).not.toContain(SERVER_IPV4);
    expect(published).not.toContain(SERVER_IPV6);
    expect(github.pulls[0]?.body).toContain("deploys the app to shop.example.com.");
    // Kept locally (gitignored), and shown in this terminal where the user needs it.
    expect((await readServerAddresses(deps.paths)).deployment).toEqual({
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
    });
    expect(tracked.some((path) => path.startsWith(".opscrew/"))).toBe(false);
    expect(deps.reporter.text()).toContain(`The server at ${SERVER_IPV4} is ready.`);
  });

  it("keeps managing its own Cloudflare rules and records when run again", async () => {
    const cloudflare = fakeCloudflare();
    const { deps, services, root, handler, github } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({
        planJson: planJsonFor({ proxied: true }),
        // The state's outputs after the first apply: the ids of the rulesets it created.
        outputs: {
          server_ipv4: SERVER_IPV4,
          server_ipv6: SERVER_IPV6,
          server_id: "4711",
          server_name: "shop",
          url: "https://shop.example.com",
          cloudflare_rulesets: heldRulesetsOutput(),
        },
      }),
      services: { cloudflare },
    });
    await runProvision(deps, { services });
    await writeFakeState(deps.paths);
    const tfvarsFile = join(root, "opscrew/infra/prod/terraform.tfvars.json");
    const first = await readFile(tfvarsFile, "utf8");
    expect(JSON.parse(first)).toMatchObject({ manage_config_rule: true, manage_waf_rules: true });

    // What the first apply created in the zone
    cloudflare.state.config = "opscrew";
    cloudflare.state.waf = "opscrew";
    cloudflare.state.records.push(
      opscrewRecord("shop.example.com", "A", SERVER_IPV4),
      opscrewRecord("shop.example.com", "AAAA", SERVER_IPV6),
    );
    handler.requests.length = 0;
    // The first run's pull request is still open, so the second run adds to it.
    github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
    await runProvision(deps, { services });

    expect(await readFile(tfvarsFile, "utf8")).toBe(first);
    expect(handler.requests.map((r) => r.kind)).not.toContain("repo-write");
    expect(deps.reporter.text()).not.toContain("already has its own");
    expect(deps.reporter.text()).not.toContain("Another OpsCrew deployment");
  });

  it("leaves OpsCrew's rulesets of another deployment alone in a new project and says how to free them", async () => {
    const { deps, services, root } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
      services: { cloudflare: fakeCloudflare({ configRules: "opscrew", wafRules: "opscrew" }) },
    });
    await runProvision(deps, { services });
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ manage_config_rule: false, manage_waf_rules: false });
    const text = deps.reporter.text();
    expect(text).toContain(
      "Another OpsCrew deployment (or one whose state is gone) holds the example.com zone's configuration rules",
    );
    expect(text).toContain("DELETE /zones/zone-123/rulesets/rs-http_request_firewall_custom");
  });

  it("leaves an empty rule phase it did not create alone and explains what to do", async () => {
    const { deps, services, root } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      engine: new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
      services: {
        cloudflare: fakeCloudflare({ configRules: "user-empty", wafRules: "user-empty" }),
      },
    });
    await runProvision(deps, { services });
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars).toMatchObject({ manage_config_rule: false, manage_waf_rules: false });
    const text = deps.reporter.text();
    expect(text).toContain("empty configuration ruleset");
    expect(text).toContain('set SSL/TLS to "Full (strict)"');
    expect(text).toContain("empty WAF custom ruleset");
    expect(text).toContain("delete");
  });

  it("stops before creating anything when the hostname has DNS records OpsCrew did not create", async () => {
    const foreign = { ttl: 1, proxied: false };
    const cloudflare = fakeCloudflare({
      records: [
        { ...foreign, id: "r1", type: "A", name: "shop.example.com", content: "198.51.100.7" },
        { ...foreign, id: "r2", type: "TXT", name: "shop.example.com", content: "v=spf1 -all" },
        {
          ...foreign,
          id: "r3",
          type: "CNAME",
          name: "www.shop.example.com",
          content: "old-host.example.net",
        },
        opscrewRecord("shop.example.com", "AAAA", "2001:db8::99"),
      ],
    });
    const { deps, services, engine, handler } = await setup({
      plan: testPlan({ domain: "shop.example.com", www: true }),
      services: { cloudflare },
    });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("another hostname"),
    });
    const message = (error as Error).message;
    expect(message).toContain("A shop.example.com 198.51.100.7");
    expect(message).toContain("CNAME www.shop.example.com old-host.example.net");
    expect(message).not.toContain("TXT");
    expect(message).not.toContain("2001:db8::99");
    expect(cloudflare.listed).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect(engine.calls).toEqual([]);
    expect(handler.requests).toEqual([]);
  });

  it("accepts records that already point at the deployed server", async () => {
    const { deps, services } = await setup({
      plan: testPlan({ domain: "shop.example.com", deployed: true }),
      engine: new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
      services: {
        cloudflare: fakeCloudflare({
          records: [
            { id: "r1", type: "A", name: "shop.example.com", content: SERVER_IPV4, ttl: 1 },
            { id: "r2", type: "AAAA", name: "shop.example.com", content: "2001:DB8::1", ttl: 1 },
          ],
        }),
      },
    });
    await expect(runProvision(deps, { services })).resolves.toMatchObject({ applied: true });
  });

  it("explains the token permissions when Cloudflare refuses to list DNS records", async () => {
    const { deps, services } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      services: {
        cloudflare: fakeCloudflare({
          listError: new OpsCrewError(
            "CREDENTIALS_INVALID",
            "Cloudflare refused the request to list DNS records: Authentication error.",
          ),
        }),
      },
    });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("DNS → Edit"),
    });
  });

  it("stops when the Cloudflare zone is not visible to the token", async () => {
    const { deps, services } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      services: { cloudflare: fakeCloudflare({ zone: false }) },
    });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("DNS → Edit"),
    });
  });

  it("keeps the commit local when the push is refused", async () => {
    const { deps, services, github, git, root, bare } = await setup({
      answer: (request) => request.kind !== "git-push",
    });
    const result = await runProvision(deps, { services });
    expect(result.prUrl).toBeUndefined();
    expect(github.pulls).toEqual([]);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(DEPLOY_SETUP_BRANCH);
    expect(await git(bare, "branch", "--list", DEPLOY_SETUP_BRANCH)).toBe("");
    expect(deps.reporter.text()).toContain("Not pushed");
  });

  it("refuses to continue when the server's host key changed", async () => {
    const { deps, services, github, handler } = await setup({
      answer: (request) => request.kind !== "remote-exec",
    });
    await mkdir(deps.paths.projectHomeDir, { recursive: true });
    await writeFile(
      deps.paths.files.knownHosts,
      `${SERVER_IPV4} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldKeyOldKeyOldKeyOldKeyOldKey\n`,
    );
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("host key"),
    });
    expect(handler.requests.map((r) => r.kind)).toContain("remote-exec");
    expect(github.secrets.size).toBe(0);
  });

  it("previews the files provision would write without touching the repository", async () => {
    const { deps, services, root, git } = await setup({
      plan: testPlan({ domain: "shop.example.com" }),
      services: { cloudflare: fakeCloudflare() },
    });
    const status = () => git(root, "status", "--porcelain", "--", ".", ":!.home-opscrew");
    const before = await status();
    const preview = await previewDeploymentFiles(deps, { services });
    expect(preview.created).toContain("opscrew/infra/prod/main.tf");
    expect(preview.created).toContain(".github/workflows/opscrew-deploy.yml");
    expect(preview.changed).toEqual([]);
    expect(preview.plan.dns.zone).toBe("example.com");
    expect(await status()).toBe(before);
    expect((await deps.state.read()).phases.provision).toBeUndefined();

    await runProvision(deps, { services });
    const after = await previewDeploymentFiles(deps, { services });
    expect(after.created).toEqual([]);
    expect(after.unchanged).toContain("opscrew/runtime/Caddyfile");
  });

  it("reports a failed apply with the engine's message", async () => {
    const { deps, services } = await setup({ engine: new FakeEngine({ applyOk: false }) });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("server type unavailable"),
      hint: expect.stringContaining("opscrew design"),
    });
  });

  it("after a failed apply that replaced the server, records the new server's address", async () => {
    // The apply replaced the server, then failed: the state's outputs name the new server.
    const replaced = { ipv4: "198.51.100.40", ipv6: "2001:db8:40::1" };
    const engine = new FakeEngine({
      applyOk: false,
      outputs: { server_ipv4: replaced.ipv4, server_ipv6: replaced.ipv6, server_id: "4790" },
    });
    const { deps, services } = await setup({ engine, plan: testPlan({ deployed: true }) });
    expect((await readServerAddresses(deps.paths)).deployment?.ipv4).toBe(SERVER_IPV4);
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("server type unavailable"),
      hint: expect.stringContaining("opscrew design"),
    });
    expect(engine.calls.at(-1)).toBe("output");
    expect((await readServerAddresses(deps.paths)).deployment).toEqual(replaced);
  });

  it("keeps the failed apply's own error when the outputs cannot be read after it", async () => {
    const engine = new FakeEngine({ applyOk: false });
    engine.output = async () => {
      throw new Error("Error acquiring the state lock");
    };
    const { deps, services } = await setup({ engine, plan: testPlan({ deployed: true }) });
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ENGINE_FAILED",
      message: expect.stringContaining("server type unavailable"),
    });
    expect((await readServerAddresses(deps.paths)).deployment).toEqual({
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
    });
  });

  it("names the exact SSH command when the first-boot setup times out", async () => {
    let clock = 0;
    const { deps, services } = await setup({
      services: {
        remote: (host) => ({
          host,
          run: async () => ({ exitCode: 0, stdout: "waiting\n", stderr: "" }),
        }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    const hint = (error as OpsCrewError).hint ?? "";
    expect(hint).toContain(`deploy@${SERVER_IPV4} cloud-init status --long`);
    expect(hint).toContain(`-i "${deps.paths.files.deployKey}"`);
    expect(hint).toContain(`UserKnownHostsFile="${deps.paths.files.knownHosts}"`);
  });

  it("tells the user to store the deploy secrets when this run skipped them", async () => {
    const { deps, services, github } = await setup();
    await runProvision(deps, { services, secrets: false });
    expect(github.secrets.size).toBe(0);
    const body = github.pulls[0]?.body ?? "";
    expect(body).not.toContain("the deploy secrets are stored");
    expect(body).toContain("run `opscrew provision` in a terminal");
    expect(deps.reporter.text()).toContain("opscrew provision");
  });
});

describe.skipIf(!findExecutable("git"))("runProvision on DigitalOcean", () => {
  const DO_TOKEN = fakeSecret("digitalocean-token", "provision");
  const DO_TOKEN_PAGE = "https://cloud.digitalocean.com/account/api/tokens";
  const env = {
    HCLOUD_TOKEN: undefined,
    DIGITALOCEAN_TOKEN: DO_TOKEN,
    DIGITALOCEAN_ACCESS_TOKEN: undefined,
  };
  const engine = (scenario: FakeEngineScenario = {}) =>
    new FakeEngine({
      changes: DIGITALOCEAN_CREATE,
      planJson: planJsonFor({ provider: "digitalocean" }),
      ...scenario,
    });

  /**
   * DigitalOcean's account endpoint (an active account unless `account` overrides fields, or an
   * HTTP error with `status`); records the requests.
   */
  function accountApi(options: { account?: Record<string, unknown>; status?: number } = {}) {
    const calls: { url: string; authorized: boolean }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorized: headers.get("authorization") === `Bearer ${DO_TOKEN}`,
      });
      if (options.status !== undefined) {
        return new Response(
          JSON.stringify({
            id: "forbidden",
            message: "You are not authorized to perform this operation",
          }),
          { status: options.status, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          account: {
            droplet_limit: 25,
            email: "owner@example.com",
            uuid: "00000000-0000-4000-8000-000000000001",
            email_verified: true,
            status: "active",
            status_message: "",
            team: { uuid: "00000000-0000-4000-8000-000000000002", name: "Shop Team" },
            ...options.account,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return { fetch, calls };
  }

  it("points a locked account to the account page, not the token page", async () => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean" }),
      engine: engine(),
      env,
      fetch: accountApi({ account: { status: "locked", status_message: "Billing issue" } }).fetch,
    });
    const { provider: _fake, ...services } = run.services;
    const error = await runProvision(run.deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    const { message, hint } = error as OpsCrewError;
    expect(message).toContain("The DigitalOcean API token works, but the account cannot be used");
    expect(message).toContain("locked");
    expect(hint).toBe(
      "Resolve this on your DigitalOcean account page (https://cloud.digitalocean.com/account), then try again.",
    );
    expect(hint).not.toContain(DO_TOKEN_PAGE);
    expect(hint).not.toContain("droplet:create");
    expect(run.engine.calls).toEqual([]);
  });

  it("names the provider once and lists the scopes once when the token lacks a scope (403)", async () => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean" }),
      engine: engine(),
      env,
      fetch: accountApi({ status: 403 }).fetch,
    });
    const { provider: _fake, ...services } = run.services;
    const error = await runProvision(run.deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    const { message, hint = "" } = error as OpsCrewError;
    expect(message).toMatch(/^DigitalOcean refused/);
    expect(message).not.toContain("DigitalOcean: ");
    const shown = `${message} ${hint}`;
    expect(shown.split("droplet:create").length - 1).toBe(1);
    expect(shown).toContain(DO_TOKEN_PAGE);
    expect(hint).not.toContain("The token needs");
    expect(run.engine.calls).toEqual([]);
  });

  it("provisions a DigitalOcean plan end to end and names the provider", async () => {
    const api = accountApi();
    const run = await setup({
      plan: testPlan({ provider: "digitalocean" }),
      engine: engine(),
      env,
      fetch: api.fetch,
    });
    // The real credential check through the DigitalOcean connector (no fake `provider`).
    const { provider: _fake, ...services } = run.services;
    const result = await runProvision(run.deps, { services });

    expect(api.calls).toEqual([
      { url: "https://api.digitalocean.com/v2/account", authorized: true },
    ]);
    expect(run.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    const apply = run.handler.requests.find((r) => r.kind === "iac-apply");
    expect(apply?.title).toContain("Apply the infrastructure plan on DigitalOcean (4 to create");
    expect(apply?.details).toContain("module.server.digitalocean_droplet.this");
    expect(apply?.details).toContain("module.server.digitalocean_firewall.this");
    // USD prices exclude sales tax; "VAT" is only for Hetzner's EUR prices.
    expect(apply?.details).toContain("$8.41 per month (price list of 2026-06-15, excl. tax)");
    expect(apply?.details).not.toContain("VAT");
    expect(run.engine.calls).toEqual(["init", "validate", "plan", "apply"]);
    expect(run.engine.applied[0]?.approval.approvedPlanHash).toBe(result.planHash);
    expect(result).toMatchObject({ applied: true, prUrl: "https://github.com/acme/shop/pull/7" });

    await expect(readFile(join(run.root, "opscrew/infra/prod/main.tf"), "utf8")).resolves.toContain(
      "digitalocean",
    );
    expect(existsSync(join(run.root, "opscrew/infra/modules/digitalocean-droplet/main.tf"))).toBe(
      true,
    );
    expect(existsSync(join(run.root, "opscrew/infra/modules/hetzner-vps"))).toBe(false);

    const plan = await readArtifact("plan", run.deps.paths.files.plan);
    expect(plan.target.provider).toBe("digitalocean");
    expect(plan.deployment).toMatchObject({
      lastPlanHash: result.planHash,
      lastCompletedPhase: "provision",
    });
    expect((await readServerAddresses(run.deps.paths)).deployment).toEqual({
      ipv4: SERVER_IPV4,
      ipv6: SERVER_IPV6,
    });
    expect(run.github.secrets.get("OPSCREW_HOST")).toBe(SERVER_IPV4);
    expect(run.github.pulls[0]?.body).toContain("infrastructure code for the DigitalOcean Droplet");

    const text = run.deps.reporter.text();
    expect(text).toContain("Checking your DigitalOcean, Cloudflare and GitHub access");
    expect(text).not.toContain("Hetzner");
    // SC-404: the token never reaches the reporter, the audit log or the deploy secrets
    const printed = `${everythingPrinted(run.deps)}\n${JSON.stringify([...run.github.secrets])}`;
    expect(printed).not.toContain(DO_TOKEN);
  });

  it("names the variable, the token page and the scopes when the token is missing", async () => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean" }),
      engine: engine(),
      env: { ...env, DIGITALOCEAN_TOKEN: undefined },
    });
    const { provider: _fake, ...services } = run.services;
    const error = await runProvision(run.deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      message: expect.stringContaining("DIGITALOCEAN_TOKEN"),
      hint: expect.stringContaining(DO_TOKEN_PAGE),
    });
    expect((error as OpsCrewError).hint).toContain("droplet:create");
    expect(run.engine.calls).toEqual([]);
  });

  const failures: [string, string, string[]][] = [
    [
      "a size unavailable in the region",
      'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "r1") Size is not available in this region.',
      ["DigitalOcean cannot create a s-1vcpu-2gb Droplet in fra1", "opscrew design"],
    ],
    [
      "the Droplet limit",
      'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "r2") You have reached your droplet limit. Please contact support.',
      [
        "DigitalOcean account reached its Droplet limit",
        "on your account page (https://cloud.digitalocean.com/account)",
      ],
    ],
    [
      "a missing scope",
      'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 403 (request "r3") You are not authorized to perform this operation',
      [DO_TOKEN_PAGE, "droplet:create", "firewall:create", "set DIGITALOCEAN_TOKEN to it"],
    ],
  ];

  it.each(failures)("explains a failed apply caused by %s", async (_name, log, expected) => {
    const run = await setup({
      plan: testPlan({ provider: "digitalocean" }),
      engine: engine({ applyOk: false, applyLog: log }),
      env,
    });
    const error = await runProvision(run.deps, { services: run.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    const hint = (error as OpsCrewError).hint ?? "";
    for (const text of expected) expect(hint).toContain(text);
    expect(hint).not.toContain("Hetzner");
    expect(everythingPrinted(run.deps)).not.toContain(DO_TOKEN);
    expect((await run.deps.state.read()).phases.provision?.status).toBe("failed");
  });
});

describe.skipIf(!findExecutable("git"))("runProvision apply hints on both providers", () => {
  const providers = [
    { provider: "hetzner", tokenVar: "HCLOUD_TOKEN", api: "api.hetzner.cloud/v1/servers" },
    {
      provider: "digitalocean",
      tokenVar: "DIGITALOCEAN_TOKEN",
      api: "api.digitalocean.com/v2/droplets",
    },
  ] as const;

  async function hintFor(provider: (typeof providers)[number]["provider"], log: string) {
    const changes = provider === "digitalocean" ? { changes: DIGITALOCEAN_CREATE } : {};
    const { deps, services } = await setup({
      plan: testPlan({ provider }),
      engine: new FakeEngine({
        ...changes,
        planJson: planJsonFor({ provider }),
        applyOk: false,
        applyLog: log,
      }),
    });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    return (error as OpsCrewError).hint ?? "";
  }

  it.each(providers)("blames the Cloudflare token for a Cloudflare 403 ($provider)", async (p) => {
    const hint = await hintFor(
      p.provider,
      'Error: failed to make http request: POST "https://api.cloudflare.com/client/v4/zones/zone-123/dns_records": 403 Forbidden {"errors":[{"code":10000,"message":"Authentication error"}]}\n\n  with module.dns.cloudflare_dns_record.a',
    );
    expect(hint).toContain("CLOUDFLARE_API_TOKEN");
    expect(hint).toContain("Zone → DNS → Edit");
    expect(hint).not.toContain(p.tokenVar);
  });

  it.each(providers)(
    "blames the token of the API whose error block holds the 403 ($provider)",
    async (p) => {
      const resource =
        p.provider === "digitalocean" ? "digitalocean_droplet.this" : "hcloud_server.this";
      const providerBlock = [
        "╷",
        `│ Error: POST https://${p.api}: 422 Size is not available in this region.`,
        "│ ",
        `│   with module.server.${resource},`,
        `│   on ../modules/server/main.tf line 20, in resource "${resource.split(".")[0]}" "this":`,
        `│   20: resource "${resource.split(".")[0]}" "this" {`,
        "│ ",
        "╵",
      ];
      const cloudflareBlock = [
        "╷",
        '│ Error: failed to make http request: POST "https://api.cloudflare.com/client/v4/zones/zone-123/dns_records": 403 Forbidden',
        "│ ",
        "│   with module.dns.cloudflare_dns_record.a,",
        '│   on ../modules/cloudflare-dns/main.tf line 5, in resource "cloudflare_dns_record" "a":',
        '│    5: resource "cloudflare_dns_record" "a" {',
        "│ ",
        "╵",
      ];
      const cloudflareFirst = await hintFor(
        p.provider,
        [...cloudflareBlock, ...providerBlock].join("\n"),
      );
      expect(cloudflareFirst).toContain("CLOUDFLARE_API_TOKEN");
      expect(cloudflareFirst).not.toContain(p.tokenVar);
      const providerFirst = await hintFor(
        p.provider,
        [...providerBlock, ...cloudflareBlock].join("\n"),
      );
      expect(providerFirst).toContain("CLOUDFLARE_API_TOKEN");
      expect(providerFirst).not.toContain(p.tokenVar);

      // A 403 in the provider's block is the provider token's, even with a Cloudflare error nearby.
      const providerRefused = await hintFor(
        p.provider,
        [
          ...providerBlock.map((line) =>
            line.replace("422 Size is not available in this region.", "403 Forbidden"),
          ),
          ...cloudflareBlock.map((line) => line.replace("403 Forbidden", "400 Bad Request")),
        ].join("\n"),
      );
      expect(providerRefused).toContain(`set ${p.tokenVar} to it`);
      expect(providerRefused).not.toContain("CLOUDFLARE_API_TOKEN");
    },
  );

  it.each(providers)(
    "treats a 503 as an outage, not an unavailable size ($provider)",
    async (p) => {
      const hint = await hintFor(
        p.provider,
        `Error: POST https://${p.api}: 503 Service Unavailable (service_unavailable)`,
      );
      expect(hint).not.toContain("opscrew design");
      expect(hint).not.toContain(p.tokenVar);
      expect(hint).toContain("Fix the cause shown above");
    },
  );
});

describe.skipIf(!findExecutable("git"))("runProvision apply hints on Hetzner", () => {
  it("explains an exhausted server limit with the Hetzner console", async () => {
    const { deps, services } = await setup({
      engine: new FakeEngine({
        applyOk: false,
        applyLog: "Error: server limit reached for this project (resource_limit_exceeded)",
      }),
    });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    const hint = (error as OpsCrewError).hint ?? "";
    expect(hint).toContain("Hetzner Cloud account reached its server limit");
    expect(hint).toContain("https://console.hetzner.cloud/");
  });

  it("asks for a Read & Write token when the Hetzner token is read-only", async () => {
    const { deps, services } = await setup({
      engine: new FakeEngine({
        applyOk: false,
        applyLog: "Error: only allowed to perform GET requests (token_readonly)",
      }),
    });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    const hint = (error as OpsCrewError).hint ?? "";
    expect(hint).toContain("Read & Write permission");
    expect(hint).toContain("set HCLOUD_TOKEN to it");
  });

  it("keeps naming the server type for an unavailable Hetzner type", async () => {
    const { deps, services } = await setup({ engine: new FakeEngine({ applyOk: false }) });
    const error = await runProvision(deps, { services }).catch((e: unknown) => e);
    expect((error as OpsCrewError).hint).toContain(
      "Hetzner Cloud cannot create a cx23 server in nbg1 right now",
    );
  });
});
