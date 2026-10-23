import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApplyOptions,
  ApplyResult,
  HostPlan,
  HostStep,
  RunnerFact,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError, sha256Hex } from "@opscrew/core";
import { TOOLS } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy";
import { runDrift } from "../drift";
import {
  ED25519_FINGERPRINT,
  OWN_IPV4,
  type OwnProject,
  ownProject,
  published,
} from "../drift/__fixtures__/own-project";
import { runProvision } from "../provision/run";
import {
  createTestPhaseDeps,
  FakeHostServer,
  FakeRunnerGitHub,
  listedRunner,
  ownPlan,
} from "../testing";
import { applyRunnerSettings, checkRunnerRepository } from "./github";
import { planServerRunner, runnerTokens } from "./server";

/** `plan` with its deploy job on the server's runner (`environment.runner: server`). */
function onServerRunner(plan: DeployPlan, name?: string): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name: name === undefined ? plan.app.name : `${plan.app.name}-${name}` },
    environment: { ...(name !== undefined ? { name } : {}), runner: "server" },
  });
}

/** The server's login host, of which the runner's name holds 8 hex of the SHA-256. */
const HOST_HASH = sha256Hex(OWN_IPV4).slice(0, 8);
const PROD_NAME = `${HOST_HASH}-shop-prod`;
const SERVER = { arch: "amd64" as const, host: OWN_IPV4 };

const repository = (api = new FakeRunnerGitHub()) => ({ api, owner: "acme", repo: "shop" });

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

describe("planServerRunner", () => {
  it("plans no runner for a deploy job on GitHub's machines, and asks GitHub nothing", async () => {
    const api = new FakeRunnerGitHub();
    expect(await planServerRunner(repository(api), ownPlan(), SERVER)).toEqual({});
    expect(api.calls).toEqual([]);
  });

  it("gives the github-runner step: the pin for the server's CPU, the label and the name", async () => {
    const api = new FakeRunnerGitHub();
    const { step, settings, refusal } = await planServerRunner(
      repository(api),
      onServerRunner(ownPlan()),
      SERVER,
    );
    const pin = TOOLS.githubRunner;
    expect(step).toEqual({
      label: "opscrew-shop-prod",
      name: `${HOST_HASH}-shop-prod`,
      repositoryUrl: "https://github.com/acme/shop",
      version: pin.version,
      url: pin.assets["linux-x64"].url,
      sha256: pin.assets["linux-x64"].sha256,
      asset: "linux-x64",
    });
    expect(settings).toBeUndefined();
    expect(refusal).toBeUndefined();
    // A private repository: no fork-PR policy to read (GitHub refuses it there).
    expect(api.calls).toEqual(["visibility acme/shop"]);

    const staging = await planServerRunner(
      repository(),
      onServerRunner(ownPlan({ arch: "arm64" }), "staging"),
      { arch: "arm64", host: OWN_IPV4 },
    );
    // Another server of the environment gets another name; neither names the server.
    const other = await planServerRunner(repository(), onServerRunner(ownPlan()), {
      arch: "amd64",
      host: "198.51.100.7",
    });
    expect(other.step?.name).toMatch(/^[0-9a-f]{8}-shop-prod$/);
    expect(other.step?.name).not.toBe(PROD_NAME);
    expect(JSON.stringify([step, other.step])).not.toMatch(/203.0.113|198.51.100/);
    expect(staging.step).toMatchObject({
      label: "opscrew-shop-staging",
      name: `${HOST_HASH}-shop-staging`,
      asset: "linux-arm64",
      sha256: pin.assets["linux-arm64"].sha256,
    });
  });

  it("refuses a public repository whose outside contributors' runs need no approval, with the change that allows it", async () => {
    const api = new FakeRunnerGitHub();
    api.visibility = "public";
    const planned = await planServerRunner(repository(api), onServerRunner(ownPlan()), SERVER);
    expect(planned.settings).toEqual({
      repository: "acme/shop",
      forkPrApproval: { from: "first_time_contributors", to: "all_external_contributors" },
    });
    expect(planned.refusal).toContain("GitHub says self-hosted runners should almost never");
    expect(planned.refusal).toContain("first_time_contributors");

    api.policy = "all_external_contributors";
    expect(await checkRunnerRepository(repository(api))).toEqual({});
  });
});

describe("applyRunnerSettings", () => {
  const check = {
    settings: {
      repository: "acme/shop",
      forkPrApproval: {
        from: "first_time_contributors" as const,
        to: "all_external_contributors" as const,
      },
    },
    refusal: "acme/shop is public.",
  };
  const run = { phase: "provision" as const, command: "opscrew provision" };

  it("changes the policy only after its github-settings approval, and audits it", async () => {
    const api = new FakeRunnerGitHub();
    const requests: ApprovalRequest[] = [];
    const deps = await createTestPhaseDeps({
      approvalHandler: {
        request: async (request) => {
          requests.push(request);
          return { approved: false, approver: "test", decidedAt: "2026-10-11T12:00:00.000Z" };
        },
      },
    });
    const refused = await expectError(
      applyRunnerSettings(deps, repository(api), check, run),
      "APPROVAL_REFUSED",
    );
    expect(refused.message).toBe("acme/shop is public. Nothing was changed.");
    expect(requests.map((r) => r.kind)).toEqual(["github-settings"]);
    expect(api.calls).toEqual([]);

    const approving = await createTestPhaseDeps();
    await applyRunnerSettings(approving, repository(api), check, run);
    expect(api.calls).toEqual(["set-fork-pr-policy acme/shop all_external_contributors"]);
    expect(approving.audit.entries.map((e) => e.action)).toContain(
      "set the fork pull request approval policy to all_external_contributors",
    );
  });

  it("asks nothing and changes nothing in a plan-only run", async () => {
    const api = new FakeRunnerGitHub();
    const deps = await createTestPhaseDeps();
    await applyRunnerSettings(deps, repository(api), check, { ...run, planOnly: true });
    expect(api.calls).toEqual([]);
    expect(deps.reporter.text()).toContain("a plan-only run changes nothing at GitHub");
  });
});

describe("runnerTokens", () => {
  it("fetches a token only when called, and redacts it", async () => {
    const api = new FakeRunnerGitHub();
    const deps = await createTestPhaseDeps();
    const tokens = runnerTokens(deps, async () => repository(api));
    expect(api.calls).toEqual([]);
    const token = await tokens("registration");
    expect(api.calls).toEqual(["registration-token acme/shop"]);
    expect(deps.redactor.redact(`token ${token}`)).not.toContain(token);
    await tokens("remove");
    expect(api.calls.at(-1)).toBe("remove-token acme/shop");
  });
});

/**
 * The host adapter over a fake server that runs the `github-runner` step as the real one does: it
 * asks for the runner's token only then, keeps the runner installed, and reports a registration
 * GitHub kept after a removal when `keepsRegistration`.
 */
class RunnerHost extends FakeHostServer {
  readonly tokens: string[] = [];
  keepsRegistration = false;

  override async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions) {
    const step = plan.steps.find((s: HostStep) => s.id === "github-runner" && s.state === "change");
    const removes = step?.params.remove === true;
    if (step !== undefined) {
      if (options.runnerToken === undefined) throw new Error("no runner token callback");
      this.tokens.push(await options.runnerToken(removes ? "remove" : "registration"));
    }
    const result: ApplyResult = await super.apply(remote, plan, options);
    if (step === undefined) return result;
    const app = String(step.params.app);
    const others = this.facts.runners.filter((runner) => runner.app !== app);
    const installed: RunnerFact = {
      app,
      registered: true,
      active: true,
      unitCurrent: true,
      version: String(step.params.version),
      label: String(step.params.label),
      repositoryUrl: String(step.params.repositoryUrl),
    };
    this.facts = { ...this.facts, runners: removes ? others : [...others, installed] };
    return removes && this.keepsRegistration ? { ...result, stillRegistered: [app] } : result;
  }
}

/** An own-server project whose deploy job runs on the server's runner. */
async function runnerProject(answer?: (request: ApprovalRequest) => boolean) {
  const s = await ownProject({
    plan: onServerRunner(ownPlan()),
    ...(answer !== undefined ? { answer } : {}),
  });
  const host = new RunnerHost(s.host.facts);
  const github = new FakeRunnerGitHub();
  s.services = { ...s.services, own: { ...s.services.own, host }, runnerGitHub: github };
  return Object.assign(s, { runnerHost: host, runnerGitHub: github });
}

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

/** Every place a token must never reach: output, audit, approvals, files and the published repo. */
async function everywhere(s: OwnProject): Promise<string> {
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    await allFiles(s.root),
    await published(s),
  ].join("\n");
}

const provision = (s: OwnProject) =>
  runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });

describe.skipIf(!findExecutable("git"))("the server's runner in provision and destroy", () => {
  it("installs the runner with the host plan; its token reaches only the step", async () => {
    const s = await runnerProject();
    const result = await provision(s);
    expect(s.handler.requests.map((r) => r.kind)).toContain("host-apply");
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-settings");
    const apply = s.runnerHost.applies.at(-1);
    expect(apply?.options.approvedHash).toBe(result.hostPlanHash);
    const step = apply?.plan.steps.find((item) => item.id === "github-runner");
    expect(step).toMatchObject({
      state: "change",
      params: { label: "opscrew-shop-prod", name: PROD_NAME, user: "deploy" },
    });
    expect(step?.reason).toContain("a registration token fetched while this plan is applied");
    // One registration token, fetched while the plan was applied, for the step only.
    expect(s.runnerGitHub.calls.filter((c) => c.includes("token"))).toEqual([
      "registration-token acme/shop",
    ]);
    const [token] = s.runnerHost.tokens;
    expect(token).toBe(s.runnerGitHub.tokens[0]);
    expect(await everywhere(s)).not.toContain(token as string);
  });

  it("drift sees the installed runner as OpsCrew set it up, not as one to remove", async () => {
    const s = await runnerProject();
    await provision(s);
    const report = await runDrift(s.deps, { services: s.services });
    expect(report.host?.differences.filter((d) => d.area === "github-runner")).toEqual([]);
    // A runner that is gone is a difference provision puts back.
    s.runnerHost.facts = { ...s.runnerHost.facts, runners: [] };
    const gone = await runDrift(s.deps, { services: s.services });
    expect(gone.host?.differences.find((d) => d.area === "github-runner")).toMatchObject({
      restoredByProvision: true,
    });
  });

  it("refuses a public repository until the fork-PR policy change is approved", async () => {
    let settings = false;
    const s = await runnerProject((request) => request.kind !== "github-settings" || settings);
    s.runnerGitHub.visibility = "public";
    const refused = await expectError(provision(s), "APPROVAL_REFUSED");
    expect(refused.message).toContain("should almost never serve a public repository");
    expect(refused.message).toContain("Nothing was changed.");
    expect(s.runnerGitHub.calls).not.toContain(
      "set-fork-pr-policy acme/shop all_external_contributors",
    );
    expect(s.runnerHost.applies).toHaveLength(0);
    expect(s.engine.applies).toHaveLength(0);

    settings = true;
    s.handler.requests.length = 0;
    await provision(s);
    expect(s.handler.requests[0]?.kind).toBe("github-settings");
    expect(s.runnerGitHub.policy).toBe("all_external_contributors");
    expect(
      s.runnerHost.applies.at(-1)?.plan.steps.find((step) => step.id === "github-runner")?.state,
    ).toBe("change");
  });

  it("removes the runner after a switch back to GitHub's machines, and only this environment's registration", async () => {
    const s = await runnerProject();
    await provision(s);
    s.engine.changes = [];
    s.runnerHost.keepsRegistration = true;
    s.runnerGitHub.runners = [
      listedRunner(7, PROD_NAME, "opscrew-shop-prod", { status: "offline" }),
      listedRunner(8, `${HOST_HASH}-shop-staging`, "opscrew-shop-staging"),
    ];
    // The user merges the pull request, goes back to main and sets the runner to GitHub's.
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
    await s.git(s.root, "push", "-q", "origin", "main");
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...(await readArtifact("plan", s.deps.paths.files.plan)),
      environment: { deploySource: { from: "main" }, runner: "github" },
    });
    await provision(s);
    const step = s.runnerHost.applies
      .at(-1)
      ?.plan.steps.find((item) => item.id === "github-runner");
    expect(step?.params).toMatchObject({ app: "shop", remove: true });
    expect(s.runnerGitHub.calls).toContain("remove-token acme/shop");
    expect(s.runnerGitHub.calls).toContain("delete acme/shop 7");
    expect(s.runnerGitHub.runners.map((r) => r.id)).toEqual([8]);
    expect(await everywhere(s)).not.toContain(s.runnerHost.tokens.at(-1) as string);
  });

  it("destroy unregisters and removes the runner, deleting a kept registration through the API", async () => {
    const s = await runnerProject();
    await provision(s);
    s.engine.changes = [];
    s.runnerHost.keepsRegistration = true;
    s.runnerGitHub.runners = [listedRunner(7, PROD_NAME, "opscrew-shop-prod")];
    await runDestroy(s.deps, {
      services: {
        engine: s.services.engine,
        github: s.github,
        cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
        ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
        ...(s.services.own !== undefined ? { own: s.services.own } : {}),
        runnerGitHub: s.runnerGitHub,
      },
    });
    const teardown = s.runnerHost.applies.at(-1);
    expect(teardown?.plan.purpose).toBe("teardown");
    expect(teardown?.plan.steps.find((step) => step.id === "github-runner")?.params).toMatchObject({
      app: "shop",
      remove: true,
    });
    expect(s.runnerGitHub.calls).toContain("remove-token acme/shop");
    expect(s.runnerGitHub.runners).toEqual([]);
  });
});
