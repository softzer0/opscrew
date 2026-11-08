// Feature 025 (T2519): rotating the self-hosted monitoring's credentials through its host plans
// (US8, FR-2511): Grafana's admin password and OpsCrew's monitoring login to Postgres.
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoredPlan, networked, senderPlan } from "../network/__fixtures__/plans";
import { keepMonitoringValues, monitoringValues } from "../provision/secrets";
import { randomPassword, recordOwnServer, updateServerAddresses } from "../shared";
import { DATA_IPV4, gitRemote } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  OWN_IPV4,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
} from "../testing";
import { rotateMonitoring } from "./addons-monitoring";
import { credentialsRecordFile } from "./record";
import { readPendingRotation } from "./values-pending";

const NOW = new Date("2026-11-08T10:00:00.000Z");

/** The shared monitoring server: its owner's network on wg-opscrew0. */
const SHARED = { monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] } };

/** A server OpsCrew created (root through Docker), running containers of `projects`. */
function cloudFacts(projects: readonly string[]): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    containers: projects.map((project) => ({
      name: `${project}-main-1`,
      project,
      ports: "",
      running: true,
    })),
  });
}

/** One host plan a server got, with what was sent on apply and how far the rotation had got. */
interface Applied {
  host: string;
  plan: HostPlan;
  options: ApplyOptions;
  step: string | undefined;
}

/**
 * `plan` deployed: its servers recorded (the app's server the user's own with `own`, reached with
 * its admin login), the app running on each.
 */
async function world(
  given: DeployPlan,
  o: {
    environment?: string;
    own?: boolean;
    kept: { grafanaAdminPassword?: string; postgresPassword?: string };
    answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  },
) {
  const plan: DeployPlan = {
    ...given,
    deployment: { ...given.deployment, lastApplyAt: DEPLOYED_AT },
  };
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: gitRemote(),
    clock: { now: () => NOW },
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
    servers: { data: { ipv4: DATA_IPV4 } },
  }));
  if (o.own === true) {
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
    });
  }
  await keepMonitoringValues(deps, () => o.kept);
  const app = plan.app.name;
  const facts: Record<string, HostFacts> = {
    [SERVER_IPV4]: cloudFacts(["opscrew-edge", app]),
    [OWN_IPV4]: freshFacts(),
    [DATA_IPV4]: cloudFacts([app]),
  };
  const applies: Applied[] = [];
  const services = {
    remote: (host: string): RemoteExec => readyRemote(host),
    serverHost: {
      inspect: async (remote: RemoteExec) => facts[remote.host] ?? cloudFacts([]),
      apply: async (remote: RemoteExec, applied: HostPlan, options: ApplyOptions) => {
        if (options.approvedHash !== hostPlanHash(applied))
          throw new Error("host plan hash mismatch");
        const step = (await readPendingRotation(deps))?.step;
        applies.push({ host: remote.host, plan: applied, options, step });
        const changed = applied.steps.filter((s) => s.state === "change").map((s) => s.id);
        return { applied: changed, skipped: [] } as ApplyResult;
      },
    },
  };
  return {
    deps,
    plan,
    handler,
    applies,
    run: () => rotateMonitoring(deps, plan, { services }),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Each applied plan as `<its step> on <server>`, in order. */
const appliedSteps = (w: World) =>
  w.applies.map((a) => `${a.plan.steps.map((s) => s.id).join("+")} on ${a.host}`);

/** Everything OpsCrew showed, audited or asked. */
const everythingShown = (w: World) =>
  [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.applies.map((a) => a.plan)),
  ].join("\n");

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const kept = () => ({
  grafanaAdminPassword: randomPassword(32),
  postgresPassword: randomPassword(32),
});

describe("opscrew rotate monitoring", () => {
  it("changes the login on Postgres's server, then Alloy there, then Grafana's password with the stack's plan, each approved by its hash", async () => {
    const old = kept();
    const w = await world(networked(monitoredPlan({ on: "app" })).plan, { kept: old });
    const result = await w.run();

    expect(appliedSteps(w)).toEqual([
      `grant on ${DATA_IPV4}`,
      `alloy on ${DATA_IPV4}`,
      `monitoring on ${SERVER_IPV4}`,
    ]);
    const requests = w.handler.requests.filter((r) => r.kind === "host-apply");
    expect(requests.map((r) => r.planHash)).toEqual(result.hostPlanHashes);
    expect(w.applies.map((a) => a.options.approvedHash)).toEqual(result.hostPlanHashes);
    // Every step writes its secret even where the rest is in place: its check never skips it.
    for (const apply of w.applies) expect(apply.plan.steps[0]?.params.rewrite).toBe(true);
    // Begun once the first plan was approved, before its apply: it only goes forward from there.
    expect(w.applies.map((a) => a.step)).toEqual(["switched", "switched", "switched"]);

    const now = await monitoringValues(w.deps);
    expect(now?.grafanaAdminPassword).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(now?.postgresPassword).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(now?.grafanaAdminPassword).not.toBe(old.grafanaAdminPassword);
    expect(now?.postgresPassword).not.toBe(old.postgresPassword);
    // The new values go to the servers only on apply.
    expect(w.applies.map((a) => a.options.secrets)).toEqual([
      { monitoringPostgresPassword: now?.postgresPassword },
      { monitoringPostgresPassword: now?.postgresPassword },
      { grafanaAdminPassword: now?.grafanaAdminPassword },
    ]);

    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.prod?.monitoring).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expect(await readPendingRotation(w.deps)).toBeUndefined();
    expect(result.copy.changed).toBe(false);
    expect(w.deps.reporter.text()).toContain("Sign in to Grafana with the new password");
    const shown = everythingShown(w);
    for (const value of [...Object.values(old), now?.grafanaAdminPassword, now?.postgresPassword]) {
      expect(shown).not.toContain(value);
    }
  });

  it("keeps the new values beside the old when a plan is refused, and goes on with the same ones", async () => {
    const old = kept();
    let refuse = true;
    const w = await world(networked(monitoredPlan({ on: "app" })).plan, {
      kept: old,
      answer: (request) => !(refuse && request.title.includes("Alloy")),
    });
    await failure(w.run());
    expect(appliedSteps(w)).toEqual([`grant on ${DATA_IPV4}`]);
    // Nothing kept here yet: the old values stay this computer's, the new ones in the rotation.
    expect(await monitoringValues(w.deps)).toEqual(old);
    const pending = await readPendingRotation(w.deps);
    // The login has the new password: the rotation only goes forward.
    expect(pending).toMatchObject({ names: ["monitoring"], step: "switched" });
    const next = pending?.services.monitoring?.postgresPassword?.new;

    refuse = false;
    await w.run();
    expect(w.applies.slice(1).map((a) => a.options.secrets?.monitoringPostgresPassword)).toEqual([
      next,
      next,
      undefined,
    ]);
    expect((await monitoringValues(w.deps))?.postgresPassword).toBe(next);
  });

  it("begins nothing when the first plan is refused: the rotation stays only planned", async () => {
    const old = kept();
    let approve = false;
    const w = await world(networked(monitoredPlan({ on: "app" })).plan, {
      kept: old,
      answer: () => approve,
    });
    await failure(w.run());
    expect(w.applies).toHaveLength(0);
    expect(await monitoringValues(w.deps)).toEqual(old);
    const pending = await readPendingRotation(w.deps);
    expect(pending).toMatchObject({ names: ["monitoring"], step: "planned" });

    approve = true;
    await w.run();
    expect(w.applies[0]?.options.secrets?.monitoringPostgresPassword).toBe(
      pending?.services.monitoring?.postgresPassword?.new,
    );
    expect(await readPendingRotation(w.deps)).toBeUndefined();
  });

  it("rotates Grafana's password on the user's own server as root, with what inspection found there", async () => {
    const old = kept();
    const plan = networked(monitoredPlan({ on: "app", app: "own-tunnel" }), {
      app: { udpPortsInUse: [], wireguardInterfaces: [] },
    }).plan;
    const w = await world(plan, { own: true, kept: old });
    await w.run();
    expect(appliedSteps(w)).toEqual([
      `grant on ${DATA_IPV4}`,
      `alloy on ${DATA_IPV4}`,
      `monitoring on ${OWN_IPV4}`,
    ]);
    const stack = w.applies[2]?.plan.steps[0];
    expect(stack?.params).toMatchObject({ runAs: "root", rewrite: true });
    expect(w.applies[2]?.options.secrets).toEqual({
      grafanaAdminPassword: (await monitoringValues(w.deps))?.grafanaAdminPassword,
    });
  });

  it("rotates only its own login to Postgres on an environment that sends to another's stack, naming the owner's command for Grafana", async () => {
    const pg = randomPassword(32);
    const w = await world(networked(senderPlan(), SHARED).plan, {
      environment: "staging",
      kept: { postgresPassword: pg },
    });
    await w.run();
    expect(appliedSteps(w)).toEqual([`grant on ${DATA_IPV4}`, `alloy on ${DATA_IPV4}`]);
    expect(w.deps.reporter.text()).toContain(
      "Grafana's admin password is opscrew/plan.yaml's: `opscrew rotate monitoring` rotates it.",
    );
    const now = await monitoringValues(w.deps);
    expect(now?.postgresPassword).not.toBe(pg);
    expect(now?.grafanaAdminPassword).toBeUndefined();
  });

  it("is refused on an environment that sends to another's stack without Postgres, naming where to run it", async () => {
    const { servers: _data, ...sender } = senderPlan();
    const services = sender.services.filter((s) => s.kind !== "postgres");
    const plan = networked({ ...sender, services }, SHARED).plan;
    const w = await world(plan, { environment: "staging", kept: {} });
    const error = await failure(w.run());
    expect(error.message).toContain("Grafana's admin password is that environment's");
    expect(error.hint).toBe("Run `opscrew rotate monitoring`.");
    expect(w.applies).toHaveLength(0);
    expect(await readPendingRotation(w.deps)).toBeUndefined();
  });
});
