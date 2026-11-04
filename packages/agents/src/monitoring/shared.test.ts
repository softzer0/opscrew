/** The repository's monitoring server, shared by several environments. */
import { readFile } from "node:fs/promises";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  isOutsideMember,
  monitoringOf,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { designPlacement } from "../design/placement";
import { readPlanWithEdits } from "../design/placement-edits";
import { inEnvironment } from "../promote/__fixtures__/world";
import { updateServerAddresses } from "../shared/server-record";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  MemoryCatalog,
  makeRequirements,
  offer,
  type TestPhaseDeps,
  testKeyMaker,
  testPlan,
} from "../testing";
import { monitoringDisable } from "./disable";
import { type MonitoringServices, monitoringEnable } from "./enable";
import { figuresCommand } from "./estimate";
import { monitoringSenders, repositoryMonitoring, requireOwnerCopies } from "./repository";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const GIB = 1024 ** 3;
const ADDRESSES = { prod: "203.0.113.10", staging: "203.0.113.11", qa: "203.0.113.12" };
const MONITORING_IPV4 = "203.0.113.40";

function catalog(): MemoryCatalog {
  return new MemoryCatalog([
    offer({ id: "cx11", vcpus: 1, memoryGb: 1, diskGb: 20, price: 2.49 }),
    offer({ id: "cx21", vcpus: 1, memoryGb: 2, diskGb: 30, price: 3.29 }),
    offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
  ]);
}

/**
 * Every server reads the same but for its app's log bytes of a day (`logBytes`, by app name; 40 MB
 * otherwise); the owner's monitoring server already has one interface.
 */
class FakeServers {
  readonly reads: string[] = [];
  readonly inspected: string[] = [];
  readonly applied: unknown[] = [];
  readonly logBytes: Record<string, number> = {};
  readonly facts: Record<string, HostFacts> = {
    "shop/monitoring": HostFactsSchema.parse({
      ...freshFacts({ user: "deploy", privilege: "docker" }),
      wireguardInterfaces: ["wg-opscrew0"],
      udpPortsInUse: [51820],
    }),
  };
  readonly keys = testKeyMaker("shared");

  services(): MonitoringServices {
    return {
      remote: async (server, plan) => ({
        host: `${plan.app.name}/${server}`,
        run: async (command) => {
          if (command !== figuresCommand(plan.app.name))
            throw new Error(`not answered: ${command}`);
          this.reads.push(`${plan.app.name}/${server}`);
          const logs = this.logBytes[plan.app.name] ?? 40_000_000;
          return { exitCode: 0, stdout: `2\n3900000\n${logs}\n5\n${30 * GIB}\n`, stderr: "" };
        },
      }),
      host: {
        inspect: async (remote) => {
          this.inspected.push(remote.host);
          return this.facts[remote.host] ?? HostFactsSchema.parse(freshFacts());
        },
        apply: async (...call) => {
          this.applied.push(call);
          throw new Error("nothing is applied");
        },
      },
      keys: this.keys,
      catalogFor: async () => catalog(),
    };
  }
}

const deployed = (plan: DeployPlan): DeployPlan => ({
  ...plan,
  deployment: { ...plan.deployment, lastApplyAt: DEPLOYED_AT },
});

/** The environment `name` of the repository at `root` (prod's plan the first app's), deployed. */
async function environment(
  root: string | undefined,
  name: keyof typeof ADDRESSES,
): Promise<{ deps: TestPhaseDeps; plan: DeployPlan }> {
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    ...(root === undefined ? {} : { root }),
    ...(name === "prod" ? {} : { environment: name }),
  });
  const plan = deployed(name === "prod" ? testPlan() : inEnvironment(testPlan(), name));
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: ADDRESSES[name] },
  }));
  return { deps, plan };
}

/** Prod with its monitoring server (as provision leaves its address), and staging beside it. */
async function repository() {
  const servers = new FakeServers();
  const prod = await environment(undefined, "prod");
  const owner = await monitoringEnable(prod.deps, prod.plan, { services: servers.services() });
  await updateServerAddresses(prod.deps.paths, (current) => ({
    ...current,
    servers: { monitoring: { ipv4: MONITORING_IPV4 } },
  }));
  const staging = await environment(prod.deps.paths.root, "staging");
  servers.reads.length = 0;
  return { servers, prod: { ...prod, plan: owner.plan }, staging };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("the repository's monitoring server", () => {
  it("is offered by default: no new server, the owner's settings copied, its facts passed to the network", async () => {
    const { servers, prod, staging } = await repository();
    expect(await repositoryMonitoring(staging.deps)).toEqual({
      plan: "opscrew/plan.yaml",
      server: "monitoring",
    });
    const ownerFile = await readFile(prod.deps.paths.files.plan, "utf8");

    const { plan: after, summary } = await monitoringEnable(staging.deps, staging.plan, {
      services: servers.services(),
    });

    const owner = monitoringOf(prod.plan);
    const sender = monitoringOf(after);
    expect(sender?.where).toEqual({
      kind: "shared",
      owner: { plan: "opscrew/plan.yaml", server: "monitoring" },
    });
    expect(sender?.versions).toEqual(owner?.versions);
    expect(sender?.retention).toEqual(owner?.retention);
    // No server of its own: the owner's joins this environment's network.
    expect(after.servers).toBeUndefined();
    expect(after.cost).toEqual(staging.plan.cost);
    // The monitoring server was inspected through its owner's record: it joins this environment's
    // network as its outside member, on the port after the one its other interface uses.
    expect(servers.inspected).toEqual(["shop/monitoring"]);
    const outside = after.network?.members.filter((m) => isOutsideMember(after, m));
    expect(outside).toEqual([expect.objectContaining({ name: "monitoring", port: 51821 })]);
    expect(after.network?.members.map((m) => m.name)).toEqual(["app", "monitoring"]);
    // The estimate reads every sending environment's servers: the owner's and this one.
    expect(servers.reads).toEqual(["shop/app", "shop-staging/app"]);
    expect(summary).toContain(
      "This environment sends its figures and logs to the repository's monitoring server, server monitoring of opscrew/plan.yaml, which already keeps every environment's; no new server. Server monitoring: Hetzner cx21",
    );
    expect(summary).toContain(
      "A device on any of server monitoring of opscrew/plan.yaml's private networks sees every environment's dashboards, this one's too.",
    );
    expect(summary).toContain("(392 series");
    expect(summary).toContain(
      "Only opscrew/environments/staging/plan.yaml changed: run `opscrew provision --env staging`",
    );
    // Only staging's plan changed (the cap they need together is the owner's); nothing applied.
    expect(await readFile(prod.deps.paths.files.plan, "utf8")).toBe(ownerFile);
    expect(servers.applied).toEqual([]);
    for (const text of [summary, JSON.stringify(staging.deps.audit.entries)]) {
      for (const address of [...Object.values(ADDRESSES), MONITORING_IPV4]) {
        expect(text).not.toContain(address);
      }
    }
    expect(await monitoringSenders(staging.deps, prod.plan)).toEqual([
      "opscrew/environments/staging/plan.yaml",
    ]);
  });

  it("lowers the owner's figures cap when a sender's logs need it, in both plans", async () => {
    const { servers, prod, staging } = await repository();
    expect(monitoringOf(prod.plan)?.retention.metricsMaxGb).toBe(23);
    // Staging logs 2 GiB a day: 3.5 GiB over 7 days at a quarter leaves 80% of 26.4 GB.
    servers.logBytes["shop-staging"] = 2 * GIB;
    const { plan: after, summary } = await monitoringEnable(staging.deps, staging.plan, {
      services: servers.services(),
    });
    const owner = await readArtifact("plan", prod.deps.paths.files.plan);
    expect(monitoringOf(owner)?.retention).toEqual({
      metricsDays: 15,
      logsDays: 7,
      metricsMaxGb: 21,
    });
    expect(monitoringOf(after)?.retention).toEqual(monitoringOf(owner)?.retention);
    // Nothing else of the owner's plan changed.
    const { updatedAt: _a, observability: _o, ...ownerRest } = owner;
    const { updatedAt: _b, observability: _p, ...before } = prod.plan;
    expect(ownerRest).toEqual(before);
    expect(summary).toContain(
      "Every environment that sends to server monitoring of opscrew/plan.yaml keeps the same settings, so opscrew/plan.yaml gets them too: figures 15 days (at most 21 GB) and logs 7 days.",
    );
    expect(summary).toContain(
      "Only opscrew/environments/staging/plan.yaml and opscrew/plan.yaml changed: run `opscrew provision --env staging`",
    );
    // Design takes the copies as equal.
    await expect(requireOwnerCopies(staging.deps, after)).resolves.toBeUndefined();
  });

  it("refuses a retention of its own for a sender: the owner's plan keeps it", async () => {
    const { servers, staging } = await repository();
    const before = await readFile(staging.deps.paths.files.plan, "utf8");
    const error = await failure(
      monitoringEnable(staging.deps, staging.plan, {
        logsDays: 3,
        services: servers.services(),
      }),
    );
    expect(error.message).toBe(
      "This environment sends to the repository's monitoring server, which keeps every environment's figures and logs as long as opscrew/plan.yaml says, so `--logs-days` can't be set here. Nothing was changed.",
    );
    expect(await readFile(staging.deps.paths.files.plan, "utf8")).toBe(before);
    expect(servers.reads).toEqual([]);
  });

  it("makes a server of its own with --new-server", async () => {
    const { servers, staging } = await repository();
    const { plan: after } = await monitoringEnable(staging.deps, staging.plan, {
      newServer: true,
      services: servers.services(),
    });
    expect(monitoringOf(after)?.where).toEqual({ kind: "server", server: "monitoring" });
    expect(after.servers?.map((s) => s.name)).toEqual(["monitoring"]);
    expect(servers.inspected).toEqual([]);
  });

  it("sums every sender into the estimate, and refuses when they pass 80% of the owner's disk", async () => {
    const { servers, staging, prod } = await repository();
    await monitoringEnable(staging.deps, staging.plan, { services: servers.services() });
    const qa = await environment(prod.deps.paths.root, "qa");
    servers.reads.length = 0;
    // qa's app logs 20 GiB a day: with the others' it passes 80% of cx21's 30 GB.
    servers.logBytes["shop-qa"] = 20 * GIB;
    const error = await failure(
      monitoringEnable(qa.deps, qa.plan, { services: servers.services() }),
    );
    expect(servers.reads).toEqual(["shop/app", "shop-staging/app", "shop-qa/app"]);
    expect(error.message).toContain(
      "of the 30.0 GB disk on server monitoring of opscrew/plan.yaml",
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    // The retention is the owner's: its plan's field, never this command's flags.
    expect(error.hint).toContain("in observability.monitoring of opscrew/plan.yaml");
    expect(error.hint).not.toContain("--logs-days");
    expect(monitoringOf(await readArtifact("plan", qa.deps.paths.files.plan))).toBeUndefined();
  });

  it("can't be turned off by its owner while others send to it, naming them", async () => {
    const { servers, staging, prod } = await repository();
    const { plan: sender } = await monitoringEnable(staging.deps, staging.plan, {
      services: servers.services(),
    });
    const error = await failure(monitoringDisable(prod.deps, prod.plan));
    expect(error.message).toBe(
      "Other environments send their figures and logs to this environment's monitoring: opscrew/environments/staging/plan.yaml. Nothing was changed.",
    );
    expect(error.hint).toContain("`opscrew addon disable monitoring --env staging`");
    // The sender turns it off: its settings and the outside member go.
    const off = await monitoringDisable(staging.deps, sender);
    expect(off.plan.observability).toBeUndefined();
    expect(off.plan.network?.members.map((m) => m.name)).toEqual(["app"]);
    expect(off.summary).toContain("takes server monitoring off this environment's private network");
    // Then the owner can.
    const owner = await monitoringDisable(prod.deps, prod.plan);
    expect(owner.plan.servers).toBeUndefined();
  });
});

describe("design and a sender's copies", () => {
  /** Staging, sending to prod's monitoring server, with `edit` applied to its plan file. */
  async function sender(edit: (plan: DeployPlan) => DeployPlan = (plan) => plan) {
    const { servers, staging } = await repository();
    const { plan } = await monitoringEnable(staging.deps, staging.plan, {
      services: servers.services(),
    });
    await writeArtifact("plan", staging.deps.paths.files.plan, edit(plan));
    return { deps: staging.deps, plan: edit(plan) };
  }

  /** Design's placement over the plan file as it is. */
  async function redesign(deps: TestPhaseDeps) {
    const read = await readPlanWithEdits(deps.paths.files.plan);
    if (read === undefined) throw new Error("no plan");
    return designPlacement(deps, {
      plan: read.plan,
      edits: read.edits,
      previous: read.plan,
      requirements: makeRequirements(),
      chosen: {} as DesignOption,
      edgeMb: 128,
      catalogFor: async () => catalog(),
    });
  }

  it("keeps a sender's plan whole across a re-design", async () => {
    const { deps, plan } = await sender();
    const read = await readPlanWithEdits(deps.paths.files.plan);
    // Read apart from its network, the monitoring would refuse itself: it waits with the placement.
    expect(read?.plan.observability?.monitoring).toBeUndefined();
    expect(read?.edits.monitoring).toEqual(monitoringOf(plan));
    const { plan: designed } = await redesign(deps);
    expect(designed).toEqual(plan);
    expect(designed.deployment.lastApplyAt).toBe(DEPLOYED_AT);
  });

  it("refuses a sender whose copies differ from its owner's, naming the owner's plan", async () => {
    const { deps } = await sender((plan) =>
      DeployPlanSchema.parse({
        ...plan,
        observability: {
          monitoring: {
            ...monitoringOf(plan),
            retention: { ...monitoringOf(plan)?.retention, logsDays: 3 },
          },
        },
      }),
    );
    const error = await failure(redesign(deps));
    expect(error.message).toBe(
      "This environment sends to the monitoring server of opscrew/plan.yaml, so its observability.monitoring versions and retention must be that plan's, which the stack runs with, and retention.logsDays is 7 there. plan.yaml was not changed.",
    );
    expect(error.hint).toContain("`opscrew addon enable monitoring --env staging` again");
    await expect(
      requireOwnerCopies(deps, await readArtifact("plan", deps.paths.files.plan)),
    ).rejects.toThrow(/retention\.logsDays is 7 there/);
  });
});
