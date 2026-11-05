/**
 * `opscrew advise --apply <id>` (US2): on a fresh reading, a plan proposal writes only its field
 * and says to run provision; the others give their command or what to do. Fakes only.
 */
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { networked, splitPlan } from "../network/__fixtures__/plans";
import { makeRequirements, type TestPhaseDeps, testPlan } from "../testing";
import {
  deployed,
  FakeAdviseGitHub,
  type FakeHost,
  fakeServers,
  figuresOutput,
  IPS,
  inEnvironment,
  NOW,
  type ProjectInit,
  project,
  tree,
} from "./__fixtures__/environment";
import { type AppliedProposal, applyProposal } from "./apply";
import type { RunAdviseOptions } from "./run";

/** The example on one Hetzner cx23 in nbg1, deployed, without backups and with a worker. */
function basePlan(): DeployPlan {
  const base = testPlan();
  return deployed(
    DeployPlanSchema.parse({
      ...base,
      target: { ...base.target, backups: false },
      processes: { workers: [{ name: "jobs", command: "node jobs.js", source: "user" }] },
    }),
  );
}

/** The server short of memory, its worker at its limit; a reboot pending. */
const SHORT: FakeHost = {
  figures: figuresOutput("shop", {
    memory: 0.92,
    containers: [
      { service: "app", usedMb: 120, limitMb: 512 },
      { service: "jobs", usedMb: 250, limitMb: 256 },
    ],
  }),
  checks: { "reboot-required": "yes" },
};

/** The same server with room: only the worker at its limit. */
const ROOMY: FakeHost = {
  figures: figuresOutput("shop", {
    memory: 0.4,
    containers: [
      { service: "app", usedMb: 120, limitMb: 512 },
      { service: "jobs", usedMb: 250, limitMb: 256 },
    ],
  }),
};

interface Setup {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  options: RunAdviseOptions;
  servers: ReturnType<typeof fakeServers>;
}

async function setup(o: { host?: FakeHost; init?: Partial<ProjectInit> } = {}): Promise<Setup> {
  const plan = o.init?.plan ?? basePlan();
  const deps = await project({
    plan,
    addresses: { app: IPS.app },
    requirements: makeRequirements({ dataCriticality: "important" }),
    ...o.init,
  });
  const servers = fakeServers({ [IPS.app]: o.host ?? SHORT });
  const options: RunAdviseOptions = {
    services: { remote: servers.remote },
    github: new FakeAdviseGitHub({ alerts: { state: "off" } }),
    cloudflare: null,
  };
  return { deps, plan, options, servers };
}

/** `apply`'s written plan and summary; fails the test for a command or a manual step. */
function written(applied: AppliedProposal): { plan: DeployPlan; summary: string } {
  if (!("plan" in applied)) throw new Error(`not a plan change: ${JSON.stringify(applied)}`);
  return applied;
}

/** The plan on disk equals `expected`, apart from `updatedAt` (now). */
async function expectPlanOnDisk(deps: TestPhaseDeps, expected: DeployPlan) {
  const onDisk = await readArtifact("plan", deps.paths.files.plan);
  expect(onDisk).toEqual({ ...expected, updatedAt: NOW.toISOString() });
}

describe("applyProposal: a plan proposal", () => {
  it("writes only the server's type and says to run provision, with the new price", async () => {
    const s = await setup();
    const applied = written(await applyProposal(s.deps, s.plan, "size.app.larger", s.options));
    const expected = { ...s.plan, target: { ...s.plan.target, serverType: "cx33" } } as DeployPlan;
    expect(applied.plan).toEqual(expected);
    await expectPlanOnDisk(s.deps, expected);
    expect(applied.summary).toMatch(
      /^Changed opscrew\/plan\.yaml: target\.serverType from cx23 to cx33\.\nServer app's monthly price goes from €\d+\.\d\d to €\d+\.\d\d a month \(static prices dated \d{4}-\d{2}-\d{2}\)\.\nRun `opscrew provision`: it shows the change and applies it once you approve its hash\.$/,
    );
  });

  it("writes only a worker's memory limit", async () => {
    const s = await setup({ host: ROOMY });
    const applied = written(await applyProposal(s.deps, s.plan, "size.app.jobs-limit", s.options));
    const [jobs] = s.plan.processes.workers;
    const expected = {
      ...s.plan,
      processes: { ...s.plan.processes, workers: [{ ...jobs, memoryMb: 384 }] },
    } as DeployPlan;
    await expectPlanOnDisk(s.deps, expected);
    expect(applied.summary).toContain(
      "processes.workers[].memoryMb of worker jobs from 256 MB to 384 MB.",
    );
    expect(applied.summary).toContain("The monthly price doesn't change.");
  });

  it("turns backups on, priced", async () => {
    const s = await setup({ host: ROOMY });
    const applied = written(
      await applyProposal(s.deps, s.plan, "reliability.app.backups", s.options),
    );
    await expectPlanOnDisk(s.deps, {
      ...s.plan,
      target: { ...s.plan.target, backups: true },
    } as DeployPlan);
    expect(applied.summary).toContain("target.backups from off to on.");
    expect(applied.summary).toMatch(/Server app's monthly price goes from €/);
  });

  it("turns the scheduled check on", async () => {
    const s = await setup({ host: ROOMY });
    const applied = written(
      await applyProposal(s.deps, s.plan, "reliability.env.check", s.options),
    );
    await expectPlanOnDisk(
      s.deps,
      DeployPlanSchema.parse({
        ...s.plan,
        observability: { check: { enabled: true } },
      }),
    );
    expect(applied.summary).toContain("observability.check.enabled from off to on.");
  });

  it("names the environment in the provision it asks for", async () => {
    const prod = await setup();
    const plan = inEnvironment(basePlan(), "staging");
    const staging = await project({
      plan,
      root: prod.deps.paths.root,
      environment: "staging",
      addresses: { app: IPS.stagingApp },
      requirements: makeRequirements({ dataCriticality: "important" }),
    });
    const servers = fakeServers({ [IPS.stagingApp]: SHORT });
    const applied = written(
      await applyProposal(staging, plan, "size.app.larger", {
        ...prod.options,
        services: { remote: servers.remote },
      }),
    );
    expect(applied.summary).toContain("Changed opscrew/environments/staging/plan.yaml:");
    expect(applied.summary).toContain("Run `opscrew provision --env staging`:");
    // Prod's plan is as it was.
    expect(await readArtifact("plan", prod.deps.paths.files.plan)).toEqual(prod.plan);
  });
});

describe("applyProposal: an extra server", () => {
  /**
   * Postgres (`db`, 512 MB) on server `data` without backups, the app's server with them; both
   * reachable, `data` as `dataHost`.
   */
  async function split(dataHost: FakeHost): Promise<Setup> {
    const base = networked(splitPlan()).plan;
    const plan = deployed({
      ...base,
      servers: base.servers?.map((s) => ({
        ...s,
        target: { ...s.target, backups: false },
      })) as DeployPlan["servers"],
      services: base.services.map((s) => (s.name === "db" ? { ...s, memoryMb: 512 } : s)),
    });
    const deps = await project({
      plan,
      addresses: { app: IPS.app, servers: { data: IPS.data } },
      requirements: makeRequirements({ dataCriticality: "important" }),
    });
    const servers = fakeServers({
      [IPS.app]: { figures: figuresOutput("shop") },
      [IPS.data]: dataHost,
    });
    const options: RunAdviseOptions = {
      services: { remote: servers.remote },
      github: new FakeAdviseGitHub({ alerts: { state: "off" } }),
      cloudflare: null,
    };
    return { deps, plan, options, servers };
  }

  const quiet: FakeHost = {
    figures: figuresOutput("shop", { containers: [{ service: "db", usedMb: 300, limitMb: 512 }] }),
  };

  it("turns on backups of server data only", async () => {
    const s = await split(quiet);
    const applied = written(
      await applyProposal(s.deps, s.plan, "reliability.data.backups", s.options),
    );
    const expected = {
      ...s.plan,
      servers: s.plan.servers?.map((server) => ({
        ...server,
        target: { ...server.target, backups: true },
      })),
    } as DeployPlan;
    await expectPlanOnDisk(s.deps, expected);
    expect(applied.plan.target).toEqual(s.plan.target);
    expect(applied.summary).toContain(
      "Changed opscrew/plan.yaml: servers[].target.backups of server data from off to on.",
    );
    expect(applied.summary).toMatch(/Server data's monthly price goes from €/);
  });

  it("raises the memory limit of a service on server data only", async () => {
    const s = await split({
      figures: figuresOutput("shop", {
        containers: [{ service: "db", usedMb: 500, limitMb: 512 }],
      }),
    });
    const applied = written(await applyProposal(s.deps, s.plan, "size.data.db-limit", s.options));
    await expectPlanOnDisk(s.deps, {
      ...s.plan,
      services: s.plan.services.map((service) =>
        service.name === "db" ? { ...service, memoryMb: 768 } : service,
      ),
    });
    expect(applied.summary).toContain("services[].memoryMb of db from 512 MB to 768 MB.");
  });
});

describe("applyProposal: other proposals", () => {
  it("returns a command proposal's command and changes nothing", async () => {
    const s = await setup({
      init: { plan: deployed({ ...basePlan(), app: { ...basePlan().app, memoryMb: 512 } }) },
      host: { ...SHORT, checks: { "unattended-upgrades": "disabled" } },
    });
    const before = await tree(s.deps.paths.root);
    expect(await applyProposal(s.deps, s.plan, "security.app.host-checks", s.options)).toEqual({
      command: "opscrew secure",
    });
    expect(await tree(s.deps.paths.root)).toEqual(before);
  });

  it("returns what to do by hand for a manual one", async () => {
    const s = await setup();
    const before = await tree(s.deps.paths.root);
    expect(await applyProposal(s.deps, s.plan, "security.app.reboot", s.options)).toEqual({
      manual: expect.stringContaining("Reboot server app during a quiet moment"),
    });
    expect(await tree(s.deps.paths.root)).toEqual(before);
  });

  it("says to run provision for a proposal the plan already holds", async () => {
    const base = basePlan();
    const plan = deployed({
      ...base,
      target: { ...base.target, serverType: "cx33" },
    } as DeployPlan);
    const s = await setup({
      init: { plan, tfvars: { location: "nbg1", server_type: "cx23", backups: false } },
    });
    expect(await applyProposal(s.deps, plan, "size.app.larger", s.options)).toEqual({
      command: "opscrew provision",
    });
  });
});

describe("applyProposal: refusals", () => {
  /** The refusal of `applyProposal`, with the plan file untouched. */
  async function refused(s: Setup, id: string): Promise<OpsCrewError> {
    const before = await tree(s.deps.paths.root);
    const error = await applyProposal(s.deps, s.plan, id, s.options).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(await tree(s.deps.paths.root)).toEqual(before);
    return error as OpsCrewError;
  }

  it("refuses an unknown id before any change, naming the current ones", async () => {
    const s = await setup();
    const error = await refused(s, "size.app.huge");
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      '"size.app.huge" is not among advise\'s proposals on a fresh reading (the figures may have changed since the list was shown). The current ones are size.app.larger, security.app.reboot, security.env.dependabot-off, reliability.app.backups, reliability.env.check. Nothing was changed.',
    );
    expect(error.hint).toBe(
      "Run `opscrew advise` to see them, then `opscrew advise --apply <id>` with one of their ids.",
    );
  });

  it("refuses a proposal that no longer stands on a fresh reading", async () => {
    // Listed while the server was short; the server has room now.
    const s = await setup({ host: ROOMY });
    const error = await refused(s, "size.app.larger");
    expect(error.message).toContain('"size.app.larger" is not among');
    expect(error.message).toContain("The current ones are size.app.jobs-limit,");
  });

  it("refuses a plan change while a move is in progress", async () => {
    const plan = DeployPlanSchema.parse({
      ...basePlan(),
      retarget: {
        from: { target: basePlan().target },
        step: "renamed",
        startedAt: "2026-11-01T09:00:00.000Z",
      },
    });
    const s = await setup({ init: { plan } });
    const error = await refused(s, "size.app.larger");
    expect(error.message).toContain("The current ones are moving.env.retarget");
  });

  it("refuses an environment that isn't provisioned", async () => {
    const plan = testPlan();
    const s = await setup({ init: { plan } });
    const error = await refused(s, "size.app.larger");
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Nothing was changed.");
  });

  it("keeps the server's address and the tokens out of the summary and the refusal", async () => {
    const token = fakeSecret("github-token");
    const s = await setup({ init: { env: { GITHUB_TOKEN: token } } });
    const applied = written(await applyProposal(s.deps, s.plan, "size.app.larger", s.options));
    const error = await applyProposal(s.deps, applied.plan, "nothing.here", s.options).then(
      () => undefined,
      (e: unknown) => e as OpsCrewError,
    );
    const said = [applied.summary, error?.message, error?.hint, s.deps.reporter.text()].join("\n");
    for (const value of [IPS.app, token]) expect(said).not.toContain(value);
  });
});
