import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { RunnerInfo } from "@opscrew/connector-github";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_SECRETS } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy";
import { cloudRunnerDrift } from "../drift/host";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { serverAddressesFile } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeEngine,
  FakeGitHub,
  FakeServers,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
  writeFakeState,
} from "../testing";
import { FakeCloudRunnerHost } from "./__fixtures__/cloud-host";
import { FakeRunnerGitHub, listedRunner } from "./__fixtures__/github";
import { applyCloudRunner, checkCloudRunner } from "./cloud";
import { planServerRunner } from "./server";

const HCLOUD = fakeSecret("hcloud-token");
const STRIPE = fakeSecret("stripe-live-key");
/** The runner's name on GitHub: 8 hex of the SHA-256 of the server's address, then the app's. */
const NAME = `${sha256Hex(SERVER_IPV4).slice(0, 8)}-shop-prod`;

/** `plan` with its deploy job on the server's runner, or back on GitHub's machines. */
function onRunner(plan: DeployPlan, runner: "server" | "github" = "server"): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, environment: { ...plan.environment, runner } });
}

/** A project on a Hetzner server OpsCrew creates, with the runner's host adapter and GitHub faked. */
async function cloudProject(
  o: { plan?: DeployPlan; answer?: (r: ApprovalRequest) => boolean } = {},
) {
  const project = await createProject(o.plan ?? onRunner(testPlan()));
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const engine = new FakeEngine();
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const host = new FakeCloudRunnerHost();
  const runnerGitHub = new FakeRunnerGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    runnerHost: host,
    runnerGitHub,
  };
  return { ...project, deps, engine, github, handler, services, host, runnerGitHub };
}

type CloudProject = Awaited<ReturnType<typeof cloudProject>>;

const provision = (s: CloudProject) => runProvision(s.deps, { services: s.services });

/** Every file under `dir`, read as text. */
async function allFiles(dir: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) out.push(await allFiles(path));
    else out.push(await readFile(path, "utf8"));
  }
  return out.join("\n");
}

/** Every place a token must never reach: output, audit, approvals, files and pull requests. */
async function everywhere(s: CloudProject): Promise<string> {
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    await allFiles(s.root),
    await s.git(s.root, "log", "--all", "--format=%B"),
    ...s.github.pulls.map((pull) => `${pull.title}\n${pull.body}`),
  ].join("\n");
}

/** The user merges the deploy pull request and sets the plan's runner. */
async function mergeAndSetRunner(s: CloudProject, runner: "server" | "github"): Promise<void> {
  await s.git(s.root, "checkout", "-q", "main");
  await s.git(s.root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
  await s.git(s.root, "push", "-q", "origin", "main");
  await writeArtifact("plan", s.deps.paths.files.plan, onRunner(await readPlan(s), runner));
}

const readPlan = (s: CloudProject) => readArtifact("plan", s.deps.paths.files.plan);

describe("planServerRunner on a server OpsCrew creates", () => {
  it("gives the github-runner step, as on a server you own", async () => {
    const api = new FakeRunnerGitHub();
    const planned = await planServerRunner(
      { api, owner: "acme", repo: "shop" },
      onRunner(testPlan()),
      { arch: "amd64", host: SERVER_IPV4 },
    );
    expect(planned.step).toMatchObject({ name: NAME, label: "opscrew-shop-prod" });
    expect(planned.refusal).toBeUndefined();
  });
});

describe.skipIf(!findExecutable("git"))("the server's runner on a server OpsCrew creates", () => {
  it("installs it with a host plan of only its step, approved by its hash and applied as deploy; its token reaches only the step", async () => {
    const s = await cloudProject();
    const result = await provision(s);
    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request?.title).toBe("Install the GitHub Actions runner on the server, run as deploy");
    expect(request?.planHash).toBe(result.hostPlanHash);
    expect(request?.details).toContain("a registration token fetched while this plan is applied");
    const [apply] = s.host.applies;
    expect(s.host.applies).toHaveLength(1);
    // Over the deploy user's shell at the server's address, with the hash the user approved.
    expect(apply?.remote.host).toBe(SERVER_IPV4);
    expect(apply?.options.approvedHash).toBe(result.hostPlanHash);
    expect(apply?.plan.steps.map((step) => step.id)).toEqual(["github-runner"]);
    expect(apply?.plan.steps[0]).toMatchObject({
      state: "change",
      params: { runAs: "login", user: "deploy", label: "opscrew-shop-prod", name: NAME },
    });
    expect(result).toMatchObject({ applied: true, hostApplied: true });
    // One registration token, fetched while the plan was applied, for the step only.
    expect(s.runnerGitHub.calls.filter((call) => call.includes("token"))).toEqual([
      "registration-token acme/shop",
    ]);
    const [token] = s.host.tokens;
    expect(token).toBe(s.runnerGitHub.tokens[0]);
    expect(await everywhere(s)).not.toContain(token as string);
    // The approval is recorded with the deployment, and the plan kept by its hash.
    const plan = await readPlan(s);
    expect(plan.approvals.filter((a) => a.kind === "host-apply").map((a) => a.planHash)).toEqual([
      result.hostPlanHash,
    ]);
    await expect(
      readFile(join(s.deps.paths.files.plansDir, `host-${result.hostPlanHash}.json`), "utf8"),
    ).resolves.toContain('"runAs": "login"');
    expect(
      await readFile(join(s.root, ".github", "workflows", "opscrew-deploy.yml"), "utf8"),
    ).toContain("opscrew-shop-prod");
  });

  it("asks nothing more once the runner is in place", async () => {
    const s = await cloudProject();
    await provision(s);
    await mergeAndSetRunner(s, "server");
    s.handler.requests.length = 0;
    const again = await provision(s);
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("host-apply");
    expect(s.host.applies).toHaveLength(1);
    expect(again.hostApplied).toBe(false);
    expect(s.deps.reporter.text()).toContain(
      "The server's runner is installed and running as planned; nothing on the server changes.",
    );
  });

  it("a plan-only run shows the runner's host plan of an existing server and changes nothing", async () => {
    const s = await cloudProject();
    await provision(s);
    await mergeAndSetRunner(s, "server");
    s.host.facts = { ...s.host.facts, runners: [] };
    s.handler.requests.length = 0;
    const tokens = s.runnerGitHub.tokens.length;
    const result = await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(result.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.deps.reporter.text()).toContain(
      `Saved the host plan (hash ${result.hostPlanHash}); nothing on the server was changed.`,
    );
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("host-apply");
    expect(s.host.applies).toHaveLength(1);
    expect(s.runnerGitHub.tokens).toHaveLength(tokens);
  });

  it("refuses a public repository before anything is created, until the fork-PR policy change is approved", async () => {
    let settings = false;
    const s = await cloudProject({ answer: (r) => r.kind !== "github-settings" || settings });
    s.runnerGitHub.visibility = "public";
    const refused = await provision(s).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OpsCrewError);
    expect((refused as OpsCrewError).code).toBe("APPROVAL_REFUSED");
    expect((refused as OpsCrewError).message).toContain(
      "should almost never serve a public repository",
    );
    expect(s.engine.applied).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
    expect(s.runnerGitHub.calls).not.toContain(
      "set-fork-pr-policy acme/shop all_external_contributors",
    );

    settings = true;
    s.handler.requests.length = 0;
    await provision(s);
    expect(s.handler.requests[0]?.kind).toBe("github-settings");
    expect(s.runnerGitHub.policy).toBe("all_external_contributors");
    expect(s.host.applies.at(-1)?.plan.steps[0]?.state).toBe("change");
  });

  it("removes it over SSH as deploy after a switch back to GitHub's machines, made on another computer, and only this server's registration", async () => {
    const s = await cloudProject();
    await provision(s);
    s.host.keepsRegistration = true;
    s.runnerGitHub.runners = [
      listedRunner(7, NAME, "opscrew-shop-prod", { status: "offline" }),
      listedRunner(8, "0123abcd-shop-prod", "opscrew-shop-prod"),
    ];
    await mergeAndSetRunner(s, "github");
    // Another computer: none of this one's saved plans; what deploy finds on the server decides.
    await rm(s.deps.paths.files.plansDir, { recursive: true, force: true });
    s.handler.requests.length = 0;
    const result = await provision(s);
    const removal = s.host.applies.at(-1);
    expect(removal?.plan.steps).toEqual([
      expect.objectContaining({
        id: "github-runner",
        state: "change",
        params: { app: "shop", remove: true, runAs: "login" },
      }),
    ]);
    expect(s.handler.requests.find((r) => r.kind === "host-apply")?.title).toBe(
      "Remove the GitHub Actions runner from the server",
    );
    expect(removal?.options.approvedHash).toBe(result.hostPlanHash);
    expect(s.runnerGitHub.calls).toContain("remove-token acme/shop");
    // GitHub kept the registration: this server's goes through the API, the other server's stays.
    expect(s.runnerGitHub.calls).toContain("delete acme/shop 7");
    expect(s.runnerGitHub.runners.map((r) => r.id)).toEqual([8]);
    expect(s.host.facts.runners).toEqual([]);
    expect(await everywhere(s)).not.toContain(s.host.tokens.at(-1) as string);

    // Removed: the next run finds no runner there, and shows and asks nothing.
    s.handler.requests.length = 0;
    const next = await applyCloudRunner(s.deps, {
      plan: await readPlan(s),
      services: s.services,
      phase: "provision",
      command: "opscrew provision",
    });
    expect(next).toBeUndefined();
    expect(s.handler.requests).toEqual([]);
  });

  it("on GitHub's machines with no runner on the server, reads it as deploy and shows, asks and changes nothing", async () => {
    const s = await cloudProject({ plan: testPlan() });
    const result = await provision(s);
    expect(s.host.inspections).toBe(1);
    expect(s.host.applies).toEqual([]);
    expect(s.runnerGitHub.calls).toEqual([]);
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("host-apply");
    expect(result.hostPlanHash).toBeUndefined();
    expect(
      (await readdir(s.deps.paths.files.plansDir)).filter((f) => f.startsWith("host-")),
    ).toEqual([]);
  });

  it("stops before any change on a server created before its first boot prepared the runner, naming the commands that give it a new server", async () => {
    // A server set up on GitHub's machines by an older OpsCrew, then switched to its own runner.
    const s = await cloudProject({ plan: testPlan() });
    await provision(s);
    await mergeAndSetRunner(s, "server");
    s.host.facts = { ...s.host.facts, prepared: false };
    s.handler.requests.length = 0;
    const applied = s.engine.applied.length;
    const error = await provision(s).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    const { code, message, hint } = error as OpsCrewError;
    expect(code).toBe("PHASE_PRECONDITION");
    expect(message).toBe(
      "This server was created before OpsCrew prepared its servers for a self-hosted runner: its first boot did not make /srv/runners for deploy or let deploy's services run without a login, and deploy has no root to do that now. Nothing was changed.",
    );
    expect(hint).toBe(
      "Give the environment a new server: run `opscrew destroy` (it deletes the server and its data, after a snapshot when the server holds data), then `opscrew provision`. Or move the app to a new server at the other provider with `opscrew retarget --to digitalocean`, which moves its Postgres and Valkey with it. To keep this server, set environment.runner to github in opscrew/plan.yaml.",
    );
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.applied).toHaveLength(applied);
    expect(s.host.applies).toEqual([]);
    expect(s.runnerGitHub.calls).toEqual([]);

    // Beside another environment, each one's commands name it, prod's too.
    const staging = DeployPlanSchema.parse({
      ...testPlan(),
      app: { ...testPlan().app, name: "shop-staging" },
      environment: { name: "staging", runner: "server" },
    });
    await writeArtifact(
      "plan",
      join(s.root, "opscrew", "environments", "staging", "plan.yaml"),
      staging,
    );
    const prod = (await provision(s).catch((e: unknown) => e)) as OpsCrewError;
    expect(prod.hint).toContain("run `opscrew destroy --env prod` (it deletes the server");
    const run = { phase: "provision" as const, command: "opscrew provision", planOnly: false };
    const named = (await checkCloudRunner(s.deps, staging, s.services, run).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(named.hint).toContain(
      "run `opscrew destroy --env staging` (it deletes the server and its data, after a snapshot when the server holds data), then `opscrew provision --env staging`",
    );
    expect(named.hint).toContain("`opscrew retarget --to digitalocean --env staging`");
    expect(named.hint).toContain("opscrew/environments/staging/plan.yaml");
  });

  it("drift reads the runner as provision does, and a missing runner is a difference provision fixes", async () => {
    const s = await cloudProject();
    await provision(s);
    const notes: string[] = [];
    expect(await cloudRunnerDrift(s.deps, await readPlan(s), s.services, notes)).toEqual([]);
    expect(notes).toEqual([]);
    // No GitHub call: the repository comes from the git remote.
    expect(s.runnerGitHub.calls.filter((call) => !call.includes("token"))).toEqual([
      "visibility acme/shop",
    ]);

    const installed = s.host.facts;
    s.host.facts = { ...installed, runners: [] };
    const gone = await cloudRunnerDrift(s.deps, await readPlan(s), s.services, notes);
    expect(gone).toEqual([
      expect.objectContaining({ area: "github-runner", restoredByProvision: true }),
    ]);

    // On GitHub's machines drift does not read the server's runner.
    const inspections = s.host.inspections;
    expect(
      await cloudRunnerDrift(s.deps, onRunner(await readPlan(s), "github"), s.services, notes),
    ).toBeUndefined();
    expect(s.host.inspections).toBe(inspections);
  });

  /**
   * A provisioned project ready for `opscrew destroy`, with GitHub listing this server's runner
   * (7) and another server's of the environment (9), and the destroy's services, whose engine,
   * servers, secrets and runner deletions all go to `events`.
   */
  async function destroyable(o: { answer?: (r: ApprovalRequest) => boolean } = {}) {
    const s = await cloudProject(o);
    await provision(s);
    await writeFakeState(s.deps.paths);
    const events: string[] = [];
    // GitHub's runner API, recording deletions among the engine's steps.
    const runnerGitHub = new (class extends FakeRunnerGitHub {
      override async deleteRunner(owner: string, repo: string, id: number) {
        events.push(`runner:delete ${id}`);
        return super.deleteRunner(owner, repo, id);
      }
    })();
    const other: RunnerInfo = listedRunner(9, "0123abcd-shop-prod", "opscrew-shop-prod");
    runnerGitHub.runners = [listedRunner(7, NAME, "opscrew-shop-prod"), other];
    const github = new FakeDestroyGitHub(events);
    for (const name of Object.values(DEPLOY_SECRETS)) github.secrets.set(name, "stored");
    const services = {
      engine: async () => new ScriptedDestroyEngine({}, events),
      provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
      servers: new FakeServers(events),
      github,
      sleep: async () => undefined,
      runnerGitHub,
    };
    return { ...s, events, runnerGitHub, other, destroy: () => runDestroy(s.deps, { services }) };
  }

  it("destroy deletes this server's registration through GitHub's API before the server", async () => {
    const { events, runnerGitHub, other, deps, destroy } = await destroyable();
    await destroy();
    expect(events.indexOf("runner:delete 7")).toBeGreaterThan(-1);
    expect(events.indexOf("runner:delete 7")).toBeLessThan(events.indexOf("apply:destroy"));
    expect(runnerGitHub.runners).toEqual([other]);
    expect(deps.audit.entries.map((e) => e.action)).toContain(
      `delete the self-hosted runner ${NAME}`,
    );
  });

  it("deletes no registration when the destroy is not approved", async () => {
    let refuse = false;
    const s = await destroyable({ answer: (r) => !(refuse && r.allowDestroy === true) });
    refuse = true;
    const error = await s.destroy().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(s.events.filter((event) => event.startsWith("runner:"))).toEqual([]);
    expect(s.events).not.toContain("apply:destroy");
    expect(s.runnerGitHub.runners.map((r) => r.id)).toEqual([7, 9]);
  });

  it("deletes none by its label alone when this computer does not know the server's address, and says which to remove", async () => {
    const s = await destroyable();
    await rm(serverAddressesFile(s.deps.paths));
    await s.destroy();
    expect(s.events.filter((event) => event.startsWith("runner:"))).toEqual([]);
    expect(s.runnerGitHub.runners.map((r) => r.id)).toEqual([7, 9]);
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew does not know the server's address on this computer, so it cannot tell which registration at GitHub is this server's runner and deletes none. Once the server is gone, remove the offline runner with the label opscrew-shop-prod under the repository's Settings → Actions → Runners.",
    );
  });

  it("stops before anything is deleted when GitHub's runner API cannot be reached", async () => {
    const s = await cloudProject();
    await provision(s);
    await writeFakeState(s.deps.paths);
    const engine = new ScriptedDestroyEngine();
    // No GitHub token: none in the environment, and no `gh` login.
    const runner = projectRunner();
    const withoutGh = new ScriptedRunner((command, args, options) =>
      /(^|[\\/])gh(\.exe)?$/i.test(command)
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "not logged in" })
        : runner.run(command, args, options),
    );
    const error = await runDestroy(
      {
        ...s.deps,
        env: { ...s.deps.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
        runner: withoutGh,
      },
      {
        services: {
          engine: async () => engine,
          provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
          servers: new FakeServers(),
          github: new FakeDestroyGitHub(),
          sleep: async () => undefined,
        },
      },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as OpsCrewError).message).toContain("no GitHub token was found");
    expect(engine.applied).toEqual([]);
  });
});
