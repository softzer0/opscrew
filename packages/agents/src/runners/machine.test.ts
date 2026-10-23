import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError, sha256Hex, tfstateFile } from "@opscrew/core";
import { DEPLOY_SECRETS, TOOLS } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy";
import type { DestroyServices } from "../destroy/types";
import { environmentPaths } from "../environments/paths";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { ensureStatePassphrase, hostKeyFingerprint, hostPlanFile } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeEngine,
  FakeGitHub,
  FakeRunnerGitHub,
  FakeRunnerMachine,
  FakeServers,
  fakeCloudflare,
  fakeSharedCloudflare,
  HOST_KEY,
  listedRunner,
  MACHINE_IPV4,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { FakeCloudRunnerHost } from "./__fixtures__/cloud-host";
import {
  addRunnerHost,
  applyMachineRunner,
  applyRunnerHost,
  listRunnerHosts,
  type RunnerHostServices,
  readRunnerHost,
  removeMachineRunners,
  removeRunnerHost,
  runnerHostAddresses,
  setRunnerHost,
} from "./machine";

/** The fingerprint of the host key the fake `ssh-keyscan` answers with (a public key). */
const FINGERPRINT = hostKeyFingerprint(HOST_KEY.split(" ")[1] as string);

/** A runner name on GitHub: 8 hex of the SHA-256 of the machine's address, then the app's. */
const nameOf = (suffix: string) => `${sha256Hex(MACHINE_IPV4).slice(0, 8)}-${suffix}`;

/** `plan` in the environment `name` (prod without one), its deploy job on the runner machine "home". */
function onMachine(
  plan: DeployPlan,
  name?: string,
  o: { build?: "runner"; arch?: "amd64" | "arm64" } = {},
): DeployPlan {
  const suffix = name === undefined ? "" : `-${name}`;
  return DeployPlanSchema.parse({
    ...plan,
    environment: {
      ...(name === undefined ? {} : { name }),
      runner: "host",
      runnerHost: { name: "home", arch: o.arch ?? "amd64" },
      ...(o.build !== undefined ? { build: o.build } : {}),
    },
    app: { ...plan.app, name: `${plan.app.name}${suffix}` },
    infra: { ...plan.infra, dir: `opscrew/infra/${name ?? "prod"}` },
    cicd: { ...plan.cicd, workflowPath: `.github/workflows/opscrew-deploy${suffix}.yml` },
  });
}

/** A Hetzner project with the runner machine faked and the GitHub runner API faked. */
async function machineProject(
  o: { plan?: DeployPlan; answer?: (r: ApprovalRequest) => boolean; arch?: "amd64" | "arm64" } = {},
) {
  const project = await createProject(o.plan ?? testPlan({ userSecret: false }));
  const env = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: "hcloud-test-token-not-a-real-value",
  };
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const runner = projectRunner();
  const deps = (environment?: string) =>
    createTestPhaseDeps({
      root: project.root,
      env,
      runner,
      approvalHandler: handler,
      ...(environment === undefined ? {} : { environment }),
    });
  const machine = new FakeRunnerMachine(o.arch !== undefined ? { arch: o.arch } : {});
  const runnerGitHub = new FakeRunnerGitHub();
  const runnerMachine: RunnerHostServices = {
    host: machine,
    remote: (connection) => readyRemote(connection.host),
  };
  const github = new FakeGitHub();
  const services = (engine = new FakeEngine()): ProvisionServices => ({
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    runnerHost: new FakeCloudRunnerHost(),
    runnerGitHub,
    runnerMachine,
  });
  const prod = await deps();
  return {
    ...project,
    prod,
    deps,
    handler,
    runner,
    machine,
    runnerGitHub,
    runnerMachine,
    github,
    services,
  };
}

type MachineProject = Awaited<ReturnType<typeof machineProject>>;

/** `opscrew runner host add home` and its apply, approved by the plan's hash. */
async function addHome(s: MachineProject) {
  const added = await addRunnerHost(s.prod, {
    name: "home",
    ssh: { user: "ana", host: MACHINE_IPV4 },
    hostKey: FINGERPRINT,
    services: s.runnerMachine,
  });
  await applyRunnerHost(s.prod, {
    name: "home",
    approvedHash: added.hash,
    services: s.runnerMachine,
  });
  return added;
}

/** The user merges the deploy pull request's branch this clone is on, and goes back to main. */
async function mergeDeploySetup(s: MachineProject): Promise<void> {
  const branch = await s.git(s.root, "branch", "--show-current");
  await s.git(s.root, "checkout", "-q", "main");
  await s.git(s.root, "merge", "-q", "--ff-only", branch);
}

/** The OpsCrewError `promise` stops with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Every file under `dir`, read as text, outside `skip`. */
async function allFiles(dir: string, skip: readonly string[] = []): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry === ".git" || skip.includes(entry)) continue;
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) out.push(await allFiles(path, skip));
    else out.push(await readFile(path, "utf8"));
  }
  return out.join("\n");
}

/**
 * What must never hold a token or the machine's address: the repository's files (the plans, the
 * saved host plans and every committed file), its history, the audit log and the pull requests.
 * OpsCrew's home folder holds the machine's record, so it is left out.
 */
async function committedAndAudited(s: MachineProject): Promise<string> {
  return [
    await allFiles(s.root, [".home-opscrew"]),
    await s.git(s.root, "log", "--all", "-p", "--format=%B"),
    JSON.stringify(s.prod.audit.entries),
    ...s.github.pulls.map((pull) => `${pull.title}\n${pull.body}`),
  ].join("\n");
}

describe.skipIf(!findExecutable("git"))("a runner machine", () => {
  it("is added over SSH with its host key pinned, planned, and set up only by its plan's hash", async () => {
    const s = await machineProject();
    const added = await addRunnerHost(s.prod, {
      name: "home",
      ssh: { user: "ana", host: MACHINE_IPV4 },
      hostKey: FINGERPRINT,
      services: s.runnerMachine,
    });
    expect(added.plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
    ]);
    expect(added.hash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing is asked or changed yet; the plan names no address.
    expect(s.handler.requests).toEqual([]);
    expect(s.machine.applies).toEqual([]);
    expect(JSON.stringify(added.plan)).not.toContain(MACHINE_IPV4);
    // The record, in the project's home folder: the login, the pinned key, its CPU and Docker.
    const record = await readRunnerHost(s.prod.paths, "home");
    expect(record).toEqual({
      schemaVersion: 1,
      name: "home",
      login: { host: MACHINE_IPV4, port: 22, user: "ana", agent: true, hostKey: FINGERPRINT },
      arch: "amd64",
      docker: false,
      environments: [],
    });
    const file = join(s.prod.paths.homeDir, "projects", s.prod.paths.projectId, "runner-hosts");
    expect(await readdir(file)).toEqual(["home.json", "home.known_hosts"]);

    // Another plan than the one shown is refused, and nothing changes.
    const stale = await applyRunnerHost(s.prod, {
      name: "home",
      approvedHash: "0".repeat(64),
      services: s.runnerMachine,
    }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect(s.machine.applies).toEqual([]);

    await applyRunnerHost(s.prod, {
      name: "home",
      approvedHash: added.hash,
      services: s.runnerMachine,
    });
    expect(s.handler.requests.map((r) => [r.kind, r.planHash])).toEqual([
      ["host-apply", added.hash],
    ]);
    expect(s.handler.requests[0]?.title).toBe(
      "Set up the runner machine home: Docker and the deploy user",
    );
    expect(s.machine.applies.map((a) => a.options.approvedHash)).toEqual([added.hash]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.docker).toBe(true);
    // The audit names the machine, never its address.
    expect(JSON.stringify(s.prod.audit.entries)).not.toContain(MACHINE_IPV4);
    expect(s.prod.audit.entries.map((e) => e.target)).toContain("runner machine home");

    // Added again: nothing left to change.
    const again = await addRunnerHost(s.prod, {
      name: "home",
      ssh: { user: "ana", host: MACHINE_IPV4 },
      services: s.runnerMachine,
    });
    expect(again.plan.steps.every((step) => step.state === "in-place")).toBe(true);
    expect(await listRunnerHosts(s.prod)).toEqual([
      { name: "home", arch: "amd64", docker: true, environments: [] },
    ]);
  });

  it("refuses a name that is not one, a login it cannot use, and a machine this computer does not know", async () => {
    const s = await machineProject();
    const add = (input: Partial<Parameters<typeof addRunnerHost>[1]>) =>
      failure(
        addRunnerHost(s.prod, {
          name: "home",
          ssh: { user: "ana", host: MACHINE_IPV4 },
          hostKey: FINGERPRINT,
          services: s.runnerMachine,
          ...input,
        }),
      );
    expect(await add({ name: "Home Box" })).toMatchObject({ code: "INVALID_INPUT" });
    // The name is never the address, nor its first DNS label: hiding the address keeps the name.
    for (const host of ["nas", "NAS.lan."]) {
      const named = await add({ name: "nas", ssh: { user: "ana", host } });
      expect(named, host).toMatchObject({ code: "INVALID_INPUT" });
      expect(named.message).toContain("never its address");
    }
    expect(await readRunnerHost(s.prod.paths, "nas")).toBeUndefined();
    const key = await add({ keyFile: "-----BEGIN OPENSSH PRIVATE KEY-----" });
    expect(key).toMatchObject({ code: "INVALID_INPUT" });
    expect(`${key.message} ${key.hint}`).not.toContain("BEGIN");
    // First contact without a terminal needs the fingerprint, and records nothing.
    const first = await add({ hostKey: undefined });
    expect(first).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(first.hint).toContain(`--host-key ${FINGERPRINT}`);
    expect(await readRunnerHost(s.prod.paths, "home")).toBeUndefined();
    const unknown = await applyRunnerHost(s.prod, {
      name: "home",
      approvedHash: "0".repeat(64),
    }).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ code: "PHASE_PRECONDITION" });
  });

  it("is not set up where another repository's runner has a folder, and changes nothing", async () => {
    const s = await machineProject();
    await addHome(s);
    s.machine.facts = {
      ...s.machine.facts,
      runners: [
        {
          app: "shop",
          registered: true,
          active: true,
          unitCurrent: true,
          version: TOOLS.githubRunner.version,
          label: "opscrew-shop-prod",
          repositoryUrl: "https://github.com/someone/shop",
        },
      ],
    };
    const applies = s.machine.applies.length;
    const error = await failure(
      applyMachineRunner(s.prod, {
        plan: onMachine(testPlan({ userSecret: false })),
        services: s.services(),
        phase: "provision",
        command: "opscrew provision",
      }),
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toContain("another repository (https://github.com/someone/shop)");
    expect(s.machine.applies).toHaveLength(applies);
    expect(s.runnerGitHub.tokens).toEqual([]);
  });

  it("runs two environments' runners; provision adds each by the machine's plan hash, each with its own token, and no token or address reaches a plan or committed file", async () => {
    const prodPlan = onMachine(testPlan({ userSecret: false }));
    const s = await machineProject({ plan: prodPlan });
    await addHome(s);
    s.handler.requests.length = 0;

    const prodResult = await runProvision(s.prod, { services: s.services() });
    const requests = () => s.handler.requests.map((r) => r.kind);
    expect(requests()).toEqual([
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    const prodApproval = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(prodApproval?.title).toBe(
      "Install the GitHub Actions runner of shop on the runner machine home, run as deploy",
    );
    expect(prodApproval?.planHash).toBe(prodResult.runnerHostPlanHashes?.[0]);
    expect(prodApproval?.details).toContain(
      "a registration token fetched while this plan is applied",
    );
    const prodApply = s.machine.applies.at(-1);
    expect(prodApply?.options.approvedHash).toBe(prodResult.runnerHostPlanHashes?.[0]);
    expect(prodApply?.plan.steps.find((step) => step.id === "github-runner")?.params).toMatchObject(
      {
        app: "shop",
        user: "deploy",
        label: "opscrew-shop-prod",
        name: nameOf("shop-prod"),
        repositoryUrl: "https://github.com/acme/shop",
        asset: "linux-x64",
      },
    );
    // The deploy job reaches the server over SSH from the machine: the connection secrets are stored.
    for (const name of [DEPLOY_SECRETS.host, DEPLOY_SECRETS.sshKey, DEPLOY_SECRETS.knownHosts]) {
      expect(s.github.secrets.has(name)).toBe(true);
    }
    expect(
      await readFile(join(s.root, ".github", "workflows", "opscrew-deploy.yml"), "utf8"),
    ).toContain("opscrew-shop-prod");
    // The approval is recorded with the deployment.
    expect(
      (await readArtifact("plan", s.prod.paths.files.plan)).approvals.map((a) => a.planHash),
    ).toContain(prodResult.runnerHostPlanHashes?.[0]);

    // staging on the same machine, beside prod.
    await mergeDeploySetup(s);
    const staging = await s.deps("staging");
    await writeArtifact("plan", staging.paths.files.plan, onMachine(prodPlan, "staging"));
    s.handler.requests.length = 0;
    const stagingResult = await runProvision(staging, { services: s.services() });
    expect(stagingResult.runnerHostPlanHashes?.[0]).not.toBe(prodResult.runnerHostPlanHashes?.[0]);
    const stagingApply = s.machine.applies.at(-1);
    expect(stagingApply?.options.approvedHash).toBe(stagingResult.runnerHostPlanHashes?.[0]);
    // Docker and the deploy user are there already; prod's runner is left as it is.
    expect(
      stagingApply?.plan.steps.map((step) => [step.id, step.state, step.params.app ?? null]),
    ).toEqual([
      ["docker", "in-place", null],
      ["deploy-user", "in-place", null],
      ["github-runner", "change", "shop-staging"],
    ]);
    expect(s.machine.facts.runners.map((runner) => runner.label).sort()).toEqual([
      "opscrew-shop-prod",
      "opscrew-shop-staging",
    ]);
    // Each runner got its own registration token, fetched while its plan was applied.
    const tokens = s.machine.applies.flatMap((apply) => apply.tokens);
    expect(tokens.map((t) => t.kind)).toEqual(["registration", "registration"]);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(2);
    expect(tokens.map((t) => t.token)).toEqual(s.runnerGitHub.tokens);

    expect(await listRunnerHosts(s.prod)).toEqual([
      { name: "home", arch: "amd64", docker: true, environments: ["prod", "staging"] },
    ]);
    const kept = await committedAndAudited(s);
    for (const { token } of tokens) expect(kept).not.toContain(token);
    expect(kept).not.toContain(MACHINE_IPV4);
    expect(s.prod.reporter.text() + staging.reporter.text()).not.toContain(tokens[0]?.token);

    // A plan-only run shows the machine's plan and changes nothing.
    const applies = s.machine.applies.length;
    const planned = await runProvision(staging, { services: s.services(), planOnly: true });
    expect(planned.runnerHostPlanHashes).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(s.machine.applies).toHaveLength(applies);
    // Its plan's heading names the machine.
    expect(staging.reporter.text()).toContain("Host plan for the runner machine home: ");

    // The machine is not removed while an environment uses it.
    const refused = await failure(
      removeRunnerHost(s.prod, { name: "home", services: s.runnerMachine }),
    );
    expect(refused).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(refused.message).toBe(
      "The runner machine home runs the deploy jobs of prod and staging, so OpsCrew does not remove it. Nothing was changed.",
    );
    expect(s.machine.applies).toHaveLength(applies);
    expect((await readRunnerHost(s.prod.paths, "home"))?.environments).toEqual(["prod", "staging"]);

    // staging goes back to GitHub's machines: its provision removes its runner from the machine,
    // by that machine's plan hash, and leaves prod's.
    await mergeDeploySetup(s);
    await writeArtifact(
      "plan",
      staging.paths.files.plan,
      DeployPlanSchema.parse({
        ...onMachine(prodPlan, "staging"),
        environment: { name: "staging", runner: "github" },
      }),
    );
    s.handler.requests.length = 0;
    const switched = await runProvision(staging, { services: s.services() });
    const removal = s.machine.applies.at(-1);
    expect(s.machine.applies).toHaveLength(applies + 1);
    expect(removal?.plan.steps).toEqual([
      expect.objectContaining({
        id: "github-runner",
        state: "change",
        params: expect.objectContaining({ app: "shop-staging", remove: true }),
      }),
    ]);
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request?.title).toBe(
      "Remove the GitHub Actions runner of shop-staging from the runner machine home",
    );
    expect(switched.runnerHostPlanHashes).toEqual([request?.planHash]);
    expect(removal?.options.approvedHash).toBe(request?.planHash);
    expect(removal?.tokens.map((t) => t.kind)).toEqual(["remove"]);
    expect(s.machine.facts.runners.map((runner) => runner.app)).toEqual(["shop"]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.environments).toEqual(["prod"]);
    expect(await committedAndAudited(s)).not.toContain(removal?.tokens[0]?.token);

    // Removed: the next provision has nothing to take off the machine, and asks nothing for it.
    await mergeDeploySetup(s);
    s.handler.requests.length = 0;
    const again = await runProvision(staging, { services: s.services() });
    expect(again.runnerHostPlanHashes).toBeUndefined();
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("host-apply");
    expect(s.machine.applies).toHaveLength(applies + 1);
  });

  it("refuses a machine that is the environment's own server, before any change", async () => {
    const prodPlan = onMachine(testPlan({ userSecret: false }));
    const s = await machineProject({ plan: prodPlan });
    await addHome(s);
    await mkdir(s.prod.paths.stateDir, { recursive: true });
    await writeFile(
      join(s.prod.paths.stateDir, "server.json"),
      `${JSON.stringify({ schemaVersion: 1, deployment: { ipv4: MACHINE_IPV4 } })}\n`,
    );
    const engine = new FakeEngine();
    const error = await failure(runProvision(s.prod, { services: s.services(engine) }));
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.message).toBe(
      "The runner machine home is the prod environment's own server, so a runner there would be the server's runner.",
    );
    expect(error.hint).toContain("--runner server");
    expect(engine.applied).toEqual([]);
  });

  it("refuses a machine whose CPU is not the one the plan records, before any change and at its inspection", async () => {
    // Recorded as arm64 when added, but the plan says amd64: stopped before anything changes.
    const s = await machineProject({
      plan: onMachine(testPlan({ userSecret: false })),
      arch: "arm64",
    });
    await addHome(s);
    const engine = new FakeEngine();
    const early = await failure(runProvision(s.prod, { services: s.services(engine) }));
    expect(early).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The runner machine home is arm64, but opscrew/plan.yaml records it as amd64. Nothing was changed.",
    });
    expect(early.hint).toContain("`opscrew env set prod --runner host --runner-host home`");
    expect(engine.applied).toEqual([]);

    // The machine's CPU changed since it was added: its inspection stops, and the record learns it.
    const t = await machineProject();
    await addHome(t);
    t.machine.facts = { ...t.machine.facts, arch: "arm64" };
    const applies = t.machine.applies.length;
    const late = await failure(
      applyMachineRunner(t.prod, {
        plan: onMachine(testPlan({ userSecret: false })),
        services: t.services(),
        phase: "provision",
        command: "opscrew provision",
      }),
    );
    expect(late.code).toBe("PHASE_PRECONDITION");
    expect(t.machine.applies).toHaveLength(applies);
    expect((await readRunnerHost(t.prod.paths, "home"))?.arch).toBe("arm64");
  });

  it("an install on a machine it cannot reach stops, naming how to move the environment off it", async () => {
    const s = await machineProject();
    await addHome(s);
    unreachableMachine(s);
    const error = await failure(
      applyMachineRunner(s.prod, {
        plan: onMachine(testPlan({ userSecret: false })),
        services: s.services(),
        phase: "provision",
        command: "opscrew provision",
      }),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.hint).toContain("`opscrew env set prod --runner github`");
    expect(error.hint).toContain("`opscrew runner host remove home`");
  });

  it("a switch off a machine it cannot reach goes on: the registration goes at GitHub, the record forgets the runner, and its folder stays", async () => {
    const prodPlan = onMachine(testPlan({ userSecret: false }));
    const s = await machineProject({ plan: prodPlan });
    await addHome(s);
    await runProvision(s.prod, { services: s.services() });
    await mergeDeploySetup(s);
    const deployed = await readArtifact("plan", s.prod.paths.files.plan);
    await writeArtifact(
      "plan",
      s.prod.paths.files.plan,
      DeployPlanSchema.parse({ ...deployed, environment: { runner: "github" } }),
    );
    unreachableMachine(s);
    s.runnerGitHub.runners = [
      listedRunner(3, nameOf("shop-prod"), "opscrew-shop-prod"),
      listedRunner(4, "0123abcd-shop-prod", "opscrew-shop-prod"),
    ];
    const applies = s.machine.applies.length;
    const result = await runProvision(s.prod, { services: s.services() });
    expect(result.runnerHostPlanHashes).toBeUndefined();
    expect(s.machine.applies).toHaveLength(applies);
    expect(s.runnerGitHub.runners.map((runner) => runner.id)).toEqual([4]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.environments).toEqual([]);
    expect(s.prod.reporter.text()).toContain(
      "OpsCrew could not reach the runner machine home over SSH, so it deleted the registration of the runner of shop at GitHub and no longer counts that runner there. The runner's folder /srv/runners/shop and its service stay on the machine",
    );
    // Provision went on: the deploy secrets and the pull request follow.
    expect(s.handler.requests.map((r) => r.kind)).toContain("pull-request");
  });
});

/** The runner machine stops answering over SSH (switched off for good, or wiped). */
function unreachableMachine(s: { runnerMachine: RunnerHostServices }): void {
  s.runnerMachine.remote = (connection) => ({
    host: connection.host,
    run: async () => ({
      exitCode: 255,
      stdout: "",
      stderr: `ssh: connect to host ${connection.host} port 22: Connection timed out`,
    }),
  });
}

/**
 * prod and staging deployed with their deploy jobs on the runner machine "home", both runners
 * installed there, and the deps and destroy services of `destroy`'s environment.
 */
async function bothOnMachine(destroy: "prod" | "staging") {
  const deployed = testPlan({ deployed: true, userSecret: false, postgres: false });
  const prodPlan = onMachine(deployed);
  const stagingPlan = onMachine(deployed, "staging");
  const s = await machineProject({ plan: prodPlan });
  await addHome(s);
  const staging = await s.deps("staging");
  await writeArtifact("plan", environmentPaths(s.prod.paths, "staging").files.plan, stagingPlan);
  for (const [deps, plan] of [
    [s.prod, prodPlan],
    [staging, stagingPlan],
  ] as const) {
    await applyMachineRunner(deps, {
      plan,
      services: s.services(),
      phase: "provision",
      command: "opscrew provision",
    });
  }
  const deps = destroy === "prod" ? s.prod : staging;
  await ensureStatePassphrase(deps.paths);
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), '{"version":4,"resources":[]}\n');
  await mkdir(join(s.root, destroy === "prod" ? prodPlan.infra.dir : stagingPlan.infra.dir), {
    recursive: true,
  });
  await mkdir(deps.paths.stateDir, { recursive: true });
  await writeFile(
    join(deps.paths.stateDir, "server.json"),
    `${JSON.stringify({ schemaVersion: 1, deployment: { ipv4: SERVER_IPV4 } })}\n`,
  );
  const services: DestroyServices = {
    engine: async () => new ScriptedDestroyEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers(),
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(),
    sleep: async () => undefined,
    runnerGitHub: s.runnerGitHub,
    runnerMachine: s.runnerMachine,
  };
  return { ...s, deps, services };
}

describe.skipIf(!findExecutable("git"))("destroying an environment on a runner machine", () => {
  it("removes only its runner from the machine, approved by that plan's hash, and leaves the other environment's", async () => {
    const s = await bothOnMachine("staging");
    s.handler.requests.length = 0;
    const applies = s.machine.applies.length;
    await runDestroy(s.deps, { services: s.services, snapshot: false });
    const removal = s.machine.applies[applies];
    expect(s.machine.applies).toHaveLength(applies + 1);
    expect(removal?.plan.steps).toEqual([
      expect.objectContaining({
        id: "github-runner",
        state: "change",
        params: expect.objectContaining({ app: "shop-staging", remove: true }),
      }),
    ]);
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request?.title).toBe(
      "Remove the GitHub Actions runner of shop-staging from the runner machine home",
    );
    expect(removal?.options.approvedHash).toBe(request?.planHash);
    expect(removal?.tokens.map((t) => t.kind)).toEqual(["remove"]);
    expect(s.machine.facts.runners.map((runner) => runner.app)).toEqual(["shop"]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.environments).toEqual(["prod"]);
    // The machine's setup stays for prod.
    expect(s.machine.facts.deployUser).not.toBeNull();
    // Its approval is recorded with the teardown.
    expect(
      (await readArtifact("plan", s.deps.paths.files.plan)).approvals.map((a) => a.planHash),
    ).toContain(request?.planHash);
  });

  it("deletes the registration GitHub kept, by its exact name, and only that one", async () => {
    const s = await bothOnMachine("staging");
    s.machine.keepsRegistration = true;
    s.runnerGitHub.runners = [
      listedRunner(3, nameOf("shop-staging"), "opscrew-shop-staging"),
      listedRunner(4, "0123abcd-shop-staging", "opscrew-shop-staging"),
      listedRunner(5, nameOf("shop-prod"), "opscrew-shop-prod"),
    ];
    await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(s.runnerGitHub.runners.map((runner) => runner.id)).toEqual([4, 5]);
    expect(s.deps.reporter.text()).toContain(
      "GitHub still listed the runner of shop-staging on the runner machine home, so OpsCrew removed its registration through GitHub's API.",
    );
  });

  it("changes nothing on the machine when the teardown is not confirmed", async () => {
    const s = await bothOnMachine("staging");
    const applies = s.machine.applies.length;
    const error = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async () => false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(s.machine.applies).toHaveLength(applies);
    expect(s.machine.facts.runners).toHaveLength(2);
  });

  it("then the machine is taken back by its own command, with the typed name, removing the runners left and the deploy user", async () => {
    const s = await bothOnMachine("staging");
    await runDestroy(s.deps, { services: s.services, snapshot: false });
    // prod goes back to GitHub's machines (its runner stays until the machine is removed).
    const prodPlan = await readArtifact("plan", s.prod.paths.files.plan);
    await writeArtifact(
      "plan",
      s.prod.paths.files.plan,
      DeployPlanSchema.parse({ ...prodPlan, environment: { runner: "github" } }),
    );
    s.handler.requests.length = 0;
    await removeRunnerHost(s.prod, {
      name: "home",
      services: s.runnerMachine,
      runnerGitHub: s.runnerGitHub,
    });
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request).toMatchObject({
      title: "Take back what OpsCrew set up on the runner machine home",
      allowDestroy: true,
      confirmPhrase: "home",
    });
    const undo = s.machine.applies.at(-1);
    expect(undo?.plan.purpose).toBe("undo");
    expect(undo?.options.approvedHash).toBe(request?.planHash);
    expect(undo?.tokens.map((t) => t.kind)).toEqual(["remove"]);
    expect(s.machine.facts.runners).toEqual([]);
    expect(s.machine.facts.deployUser).toBeNull();
    expect(await readRunnerHost(s.prod.paths, "home")).toBeUndefined();
    expect(await listRunnerHosts(s.prod)).toEqual([]);
  });

  it("goes ahead when the machine cannot be reached: only the environment's registration goes, by its exact name, and its folder stays", async () => {
    const s = await bothOnMachine("staging");
    unreachableMachine(s);
    s.runnerGitHub.runners = [
      listedRunner(3, nameOf("shop-staging"), "opscrew-shop-staging"),
      listedRunner(4, "0123abcd-shop-staging", "opscrew-shop-staging"),
      listedRunner(5, nameOf("shop-prod"), "opscrew-shop-prod"),
    ];
    const applies = s.machine.applies.length;
    await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(s.machine.applies).toHaveLength(applies);
    expect(s.runnerGitHub.runners.map((runner) => runner.id)).toEqual([4, 5]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.environments).toEqual(["prod"]);
    expect(s.deps.reporter.text()).toContain(
      "The runner's folder /srv/runners/shop-staging and its service stay on the machine",
    );
    expect((await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt).toBe(
      "2026-10-11T12:00:00.000Z",
    );
  });

  it("forgets a machine that cannot be reached once its name is typed, deleting only its runners' registrations", async () => {
    const s = await bothOnMachine("staging");
    // Both environments move off the machine, which is gone for good.
    for (const deps of [s.prod, s.deps]) {
      const plan = await readArtifact("plan", deps.paths.files.plan);
      const { runnerHost: _host, ...environment } = plan.environment ?? {};
      await writeArtifact(
        "plan",
        deps.paths.files.plan,
        DeployPlanSchema.parse({ ...plan, environment: { ...environment, runner: "github" } }),
      );
    }
    unreachableMachine(s);
    s.runnerGitHub.runners = [
      listedRunner(3, nameOf("shop-staging"), "opscrew-shop-staging"),
      listedRunner(4, "0123abcd-shop-staging", "opscrew-shop-staging"),
      listedRunner(5, nameOf("shop-prod"), "opscrew-shop-prod"),
    ];
    s.handler.requests.length = 0;
    const applies = s.machine.applies.length;
    await removeRunnerHost(s.prod, {
      name: "home",
      services: s.runnerMachine,
      runnerGitHub: s.runnerGitHub,
    });
    expect(s.handler.requests).toEqual([
      expect.objectContaining({
        kind: "github-settings",
        title:
          "Forget the runner machine home, which OpsCrew cannot reach, and delete its runners at GitHub",
        confirmPhrase: "home",
      }),
    ]);
    expect(s.machine.applies).toHaveLength(applies);
    expect(s.runnerGitHub.runners.map((runner) => runner.id)).toEqual([4]);
    expect(await readRunnerHost(s.prod.paths, "home")).toBeUndefined();
    expect(s.prod.reporter.text()).toContain(
      "OpsCrew's runner folders in /srv/runners, their services and the deploy user stay on the machine",
    );
  });

  it("without the machine's record on this computer, changes nothing there and says what to remove", async () => {
    const s = await bothOnMachine("staging");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeFile(
      join(s.prod.paths.homeDir, "projects", s.prod.paths.projectId, "runner-hosts", "home.json"),
      "",
    );
    // A damaged record stops, before anything.
    await expect(
      removeMachineRunners(s.deps, {
        plan,
        services: s.services,
        phase: "provision",
        command: "opscrew destroy",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    const elsewhere = await machineProject();
    const applies = elsewhere.machine.applies.length;
    expect(
      await removeMachineRunners(elsewhere.prod, {
        plan,
        services: { runnerMachine: elsewhere.runnerMachine },
        phase: "provision",
        command: "opscrew destroy --env staging",
      }),
    ).toEqual([]);
    expect(elsewhere.machine.applies).toHaveLength(applies);
    expect(elsewhere.prod.reporter.text()).toContain(
      "This computer has no record of the runner machine home, so OpsCrew cannot remove the runner of shop-staging from it.",
    );
  });
});

/** The address this computer reaches the runner machine from, as the machine sees it. */
const CLIENT = "203.0.113.7";

/** A network that holds {@link CLIENT}. */
const NETWORK = "203.0.113.0/24";

/** Each step of `plan` as `[id, state]`. */
const outline = (plan: { steps: readonly { id: string; state: string }[] }) =>
  plan.steps.map((step) => [step.id, step.state]);

/** The runner machine has nft, and OpsCrew reaches it from {@link CLIENT}. */
function withNft(s: MachineProject): void {
  s.machine.facts = {
    ...s.machine.facts,
    sshFirewall: { ...s.machine.facts.sshFirewall, nft: true },
    sshClient: { address: CLIENT, port: 22 },
  };
}

/** `opscrew runner host add home` with `harden`, and its apply. */
async function addHardened(
  s: MachineProject,
  harden: NonNullable<Parameters<typeof addRunnerHost>[1]["harden"]>,
  services: RunnerHostServices = s.runnerMachine,
) {
  const added = await addRunnerHost(s.prod, {
    name: "home",
    ssh: { user: "ana", host: MACHINE_IPV4 },
    hostKey: FINGERPRINT,
    harden,
    services,
  });
  await applyRunnerHost(s.prod, { name: "home", approvedHash: added.hash, services });
  return added;
}

/** The users the SSH login checks logged in as (new connections, ControlMaster=no). */
function loginChecks(s: MachineProject): string[] {
  return s.runner.calls
    .filter((call) => call.command === "ssh" && call.args.includes("ControlMaster=no"))
    .map((call) => call.args.find((arg) => arg.endsWith(`@${MACHINE_IPV4}`)) ?? "");
}

describe.skipIf(!findExecutable("git"))("a runner machine's hardening (FR-1536)", () => {
  it("is off by default: the plan has no SSH or firewall step", async () => {
    const s = await machineProject();
    withNft(s);
    const added = await addHome(s);
    expect(outline(added.plan)).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
    ]);
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toBeUndefined();
    expect(s.handler.requests[0]?.details).toContain(
      "OpsCrew hardens its SSH and firewall only when you ask: it may be your desktop.",
    );
  });

  it("hardens SSH when asked, with its automatic undo, checked by a new login as the admin alone", async () => {
    const s = await machineProject();
    // No login check injected: the machine's own, through the project's SSH.
    const services: RunnerHostServices = { host: s.machine, remote: s.runnerMachine.remote };
    const added = await addHardened(s, { on: ["ssh"] }, services);
    expect(outline(added.plan)).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
      ["sshd", "change"],
    ]);
    expect(added.plan.steps[2]?.reason).toContain("unless a new login as ana works afterwards");
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toEqual({ ssh: true });
    const request = s.handler.requests[0];
    expect(request?.title).toBe(
      "Set up the runner machine home: Docker, the deploy user, SSH hardening",
    );
    expect(request?.details).toContain(
      "The change of its SSH settings undoes itself on the machine unless a new login as ana works afterwards.",
    );
    expect(s.machine.applies[0]?.logins).toEqual([true]);
    // deploy has no SSH key on a runner machine: only the admin login is checked.
    expect(loginChecks(s)).toEqual([`ana@${MACHINE_IPV4}`]);
  });

  it("adds the SSH firewall for the named sources; its plans hold them only in the gitignored .opscrew/, never in a committed file or pull request", async () => {
    const prodPlan = onMachine(testPlan({ userSecret: false }));
    const s = await machineProject({ plan: prodPlan });
    withNft(s);
    const added = await addHardened(s, { on: ["ssh", "firewall"], sshFrom: [NETWORK] });
    expect(outline(added.plan)).toEqual([
      ["docker", "change"],
      ["deploy-user", "change"],
      ["sshd", "change"],
      ["ssh-firewall", "change"],
    ]);
    expect(added.plan.steps[3]?.params).toMatchObject({ sources: NETWORK, from: CLIENT });
    expect(s.handler.requests[0]?.title).toBe(
      "Set up the runner machine home: Docker, the deploy user, SSH hardening and an SSH firewall",
    );
    expect(s.handler.requests[0]?.details).toContain(
      "The change of its SSH settings and SSH firewall undoes itself on the machine unless a new login as ana works afterwards.",
    );
    expect(s.machine.applies[0]?.logins).toEqual([true, true]);
    expect(await listRunnerHosts(s.prod)).toEqual([
      {
        name: "home",
        arch: "amd64",
        docker: true,
        harden: { ssh: true, firewall: { sshFrom: [NETWORK] } },
        environments: ["prod"],
      },
    ]);
    // The MCP server hides the sources, as it hides the machine's address.
    expect(await runnerHostAddresses(s.prod.paths)).toEqual({
      machines: [MACHINE_IPV4, `ana@${MACHINE_IPV4}`],
      sources: [NETWORK, "203.0.113.0"],
    });

    // Provision's plan for the machine keeps the hardening beside the runner.
    s.handler.requests.length = 0;
    const result = await runProvision(s.prod, { services: s.services() });
    const install = s.machine.applies.at(-1);
    expect(install?.options.approvedHash).toBe(result.runnerHostPlanHashes?.[0]);
    expect(install?.plan.steps.map((step) => step.id)).toEqual([
      "docker",
      "deploy-user",
      "sshd",
      "ssh-firewall",
      "github-runner",
    ]);

    // The saved plans hold the sources, in .opscrew/, which git ignores.
    for (const hash of [added.hash, result.runnerHostPlanHashes?.[0] as string]) {
      const file = hostPlanFile(s.prod.paths, hash);
      expect(relative(s.root, file).split(sep)[0]).toBe(".opscrew");
      expect(await readFile(file, "utf8")).toContain(NETWORK);
      expect(await s.git(s.root, "check-ignore", file)).not.toBe("");
    }
    const kept = [
      await allFiles(s.root, [".home-opscrew", ".opscrew"]),
      await s.git(s.root, "log", "--all", "-p", "--format=%B"),
      ...s.github.pulls.map((pull) => `${pull.title}\n${pull.body}`),
    ].join("\n");
    for (const address of ["203.0.113.", MACHINE_IPV4]) expect(kept).not.toContain(address);

    // A runner-only removal leaves the hardening as it is.
    const removed = await removeMachineRunners(s.prod, {
      plan: prodPlan,
      services: s.services(),
      phase: "provision",
      command: "opscrew destroy",
    });
    expect(removed.map((outcome) => outline(outcome.plan))).toEqual([
      [["github-runner", "change"]],
    ]);
  });

  it("set turns one part off, and the plan removes only that part", async () => {
    const s = await machineProject();
    withNft(s);
    await addHardened(s, { on: ["ssh", "firewall"], sshFrom: [CLIENT] });
    expect(s.machine.facts.sshFirewall.table).not.toBeNull();

    const off = await setRunnerHost(s.prod, {
      name: "home",
      harden: { off: ["firewall"] },
      services: s.runnerMachine,
    });
    const firewall = off.plan.steps.find((step) => step.id === "ssh-firewall");
    expect(firewall).toMatchObject({ state: "change", params: { remove: true } });
    expect(off.plan.steps.find((step) => step.id === "sshd")?.params.remove).toBeUndefined();
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toEqual({ ssh: true });
    await applyRunnerHost(s.prod, {
      name: "home",
      approvedHash: off.hash,
      services: s.runnerMachine,
    });
    expect(s.machine.facts.sshFirewall.table).toBeNull();
    expect((await listRunnerHosts(s.prod))[0]?.harden).toEqual({ ssh: true });

    const none = await setRunnerHost(s.prod, {
      name: "home",
      harden: { off: ["ssh"] },
      services: s.runnerMachine,
    });
    expect(none.plan.steps.find((step) => step.id === "sshd")).toMatchObject({
      state: "change",
      params: { remove: true },
    });
    expect(none.plan.steps.some((step) => step.id === "ssh-firewall")).toBe(false);
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toBeUndefined();
    expect((await listRunnerHosts(s.prod))[0]?.harden).toBeUndefined();
  });

  it("refuses the firewall without sources, sources without it, a part both on and off, and a source that is no address, before connecting", async () => {
    const s = await machineProject();
    withNft(s);
    const add = (harden: NonNullable<Parameters<typeof addRunnerHost>[1]["harden"]>) =>
      failure(
        addRunnerHost(s.prod, {
          name: "home",
          ssh: { user: "ana", host: MACHINE_IPV4 },
          hostKey: FINGERPRINT,
          harden,
          services: s.runnerMachine,
        }),
      );
    const bare = await add({ on: ["firewall"] });
    expect(bare).toMatchObject({ code: "INVALID_INPUT" });
    expect(bare.message).toContain("OpsCrew never guesses them");
    expect(bare.hint).toContain("--ssh-from");
    expect(await add({ on: ["ssh"], sshFrom: [CLIENT] })).toMatchObject({
      message: "--ssh-from goes with --harden firewall.",
    });
    expect(await add({ on: ["ssh"], off: ["ssh"] })).toMatchObject({
      message: "--harden and --no-harden both name ssh.",
    });
    const special = ["::1", "::ffff:203.0.113.7", "fe80::1%eth0"];
    for (const source of [
      "home",
      "203.0.113.0/0",
      "203.0.113.0/33",
      "203.0.113.0/24/1",
      ...special,
    ]) {
      const bad = await add({ on: ["firewall"], sshFrom: [source] });
      expect(bad.message, source).toContain("is not an address or network");
    }
    const many = Array.from({ length: 33 }, (_, i) => `203.0.113.${i + 1}`);
    expect(await add({ on: ["firewall"], sshFrom: many })).toMatchObject({
      code: "INVALID_INPUT",
      message: "The SSH firewall takes at most 32 sources, and --ssh-from names 33.",
    });
    expect(s.machine.inspections).toBe(0);
    expect(await readRunnerHost(s.prod.paths, "home")).toBeUndefined();

    await addHome(s);
    const set = await failure(
      setRunnerHost(s.prod, {
        name: "home",
        harden: { on: ["firewall"] },
        services: s.runnerMachine,
      }),
    );
    expect(set).toMatchObject({ code: "INVALID_INPUT" });
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toBeUndefined();
  });

  it("refuses a firewall that would lock OpsCrew out, and the record keeps the earlier hardening", async () => {
    const s = await machineProject();
    withNft(s);
    await addHardened(s, { on: ["ssh"] });
    const applies = s.machine.applies.length;
    const error = await failure(
      setRunnerHost(s.prod, {
        name: "home",
        harden: { on: ["firewall"], sshFrom: ["198.51.100.0/24"] },
        services: s.runnerMachine,
      }),
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toContain(`OpsCrew connects to this machine from ${CLIENT}`);
    // The fix is to run set again, the command that planned it.
    expect(error.hint).toContain("then run opscrew runner host set home again");
    expect(error.hint).not.toContain("runner host add");
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toEqual({ ssh: true });
    expect(s.machine.applies).toHaveLength(applies);
  });

  it("is taken off with the machine, checked by a new admin login", async () => {
    const s = await machineProject();
    withNft(s);
    await addHardened(s, { on: ["ssh", "firewall"], sshFrom: [CLIENT] });
    s.handler.requests.length = 0;
    await removeRunnerHost(s.prod, { name: "home", services: s.runnerMachine });
    const undo = s.machine.applies.at(-1);
    expect(undo?.plan.purpose).toBe("undo");
    expect(undo?.plan.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining(["ssh-firewall", "sshd"]),
    );
    expect(undo?.logins).toEqual([true, true]);
    const details = s.handler.requests[0]?.details;
    expect(details).toContain("It also takes off OpsCrew's SSH hardening and SSH firewall.");
    // Removing the firewall has no automatic undo; the SSH settings' removal has.
    expect(details).toContain(
      "The change of its SSH settings undoes itself on the machine unless a new login as ana works afterwards.",
    );
    expect(s.machine.facts.sshFirewall.table).toBeNull();
  });

  it("names only the hardening on the machine when it is taken back", async () => {
    const s = await machineProject();
    await addHardened(s, { on: ["ssh"] });
    s.handler.requests.length = 0;
    await removeRunnerHost(s.prod, { name: "home", services: s.runnerMachine });
    const details = s.handler.requests[0]?.details;
    expect(details).toContain("It also takes off OpsCrew's SSH hardening.");
    expect(details).not.toContain("SSH firewall");
  });

  it("stores a network given with host bits in the form nft prints it", async () => {
    const s = await machineProject();
    withNft(s);
    await addHardened(s, { on: ["firewall"], sshFrom: ["203.0.113.7/24", " 203.0.113.0/24 "] });
    expect((await readRunnerHost(s.prod.paths, "home"))?.harden).toEqual({
      firewall: { sshFrom: [NETWORK] },
    });
    expect((await runnerHostAddresses(s.prod.paths)).sources).toEqual([NETWORK, "203.0.113.0"]);
  });
});
