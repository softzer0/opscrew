/** Advise's 14 days from the self-hosted stack (US3, US4), on Prometheus answers as recorded. */
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoredPlan, networked, senderPlan, splitPlan } from "../network/__fixtures__/plans";
import type { NetworkHostFacts } from "../network/allocate";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps, type TestPhaseDeps } from "../testing";
import { deployed as applied, NOW, recordedHistory as recorded } from "./__fixtures__/environment";
import {
  type Answer,
  type Figure,
  prometheusOutput,
  settledQueries,
} from "./__fixtures__/prometheus";
import { readHistory } from "./history";
import type { ServerHistory } from "./types";

/** Public addresses: none may appear in any output. */
const IPS = {
  app: "203.0.113.10",
  data: "203.0.113.20",
  monitoring: "203.0.113.30",
  stagingApp: "203.0.113.11",
  stagingData: "203.0.113.21",
};
const SHARED_FACTS: Record<string, NetworkHostFacts> = {
  monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
};

/** `answer` without the series of `server`, as Prometheus answers once its figures stopped. */
function without(answer: Answer, server: string): Answer {
  return {
    ...answer,
    data: { ...answer.data, result: answer.data.result.filter((s) => s.metric.server !== server) },
  };
}

/**
 * The stack's server as a shell, answering each settled query of `app`/`env` with its answer in
 * `answers` (`prometheusOutput`). Every other host is out of reach.
 */
function fakeStack(
  stackHost: string,
  labels: { app: string; env: string },
  answers: Partial<Record<Figure, Answer | string>>,
) {
  const commands: { host: string; command: string; timeoutMs?: number }[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command, options): Promise<CommandResult> {
      commands.push({
        host,
        command,
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (host === stackHost) {
        return { exitCode: 0, stdout: prometheusOutput(command, answers, labels), stderr: "" };
      }
      return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
    },
  });
  return { remote, commands };
}

/** `plan` on its private network, deployed. */
function deployed(
  plan: Omit<DeployPlan, "network">,
  facts: Record<string, NetworkHostFacts> = {},
): DeployPlan {
  return applied(networked(plan, facts).plan);
}

/** Prod owning its monitoring server, and staging sending to it, in one repository. */
async function repository() {
  const prod = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const owner = deployed(monitoredPlan());
  await writeArtifact("plan", prod.paths.files.plan, owner);
  await updateServerAddresses(prod.paths, (current) => ({
    ...current,
    deployment: { ipv4: IPS.app },
    servers: { data: { ipv4: IPS.data }, monitoring: { ipv4: IPS.monitoring } },
  }));
  const staging = await createTestPhaseDeps({
    clock: { now: () => NOW },
    root: prod.paths.root,
    environment: "staging",
  });
  const sender = deployed(senderPlan(), SHARED_FACTS);
  await writeArtifact("plan", staging.paths.files.plan, sender);
  await updateServerAddresses(staging.paths, (current) => ({
    ...current,
    deployment: { ipv4: IPS.stagingApp },
    servers: { data: { ipv4: IPS.stagingData } },
  }));
  return { prod, owner, staging, sender };
}

/** No public address in what `deps` printed and audited, nor in `more`. */
function expectNoLeak(deps: TestPhaseDeps, ...more: unknown[]) {
  const said = [deps.reporter.text(), JSON.stringify(deps.audit.entries), JSON.stringify(more)];
  for (const ip of Object.values(IPS)) expect(said.join("\n")).not.toContain(ip);
}

const PROD = { app: "shop", env: "prod" };

/** The spike's figures as advise reads them (memory in bytes). */
const APP: ServerHistory = {
  days: 14,
  cpuP95: 0.85,
  memoryP95: 0.9,
  loadOverCpus: 0.08333333333333333,
  diskFullInDays: 16,
  containers: [
    {
      service: "web",
      memoryP95: 471859200,
      memoryMax: 524288000,
      limit: 805306368,
      restarts: 0,
      oomKills: 0,
    },
    {
      service: "worker",
      memoryP95: 201326592,
      memoryMax: 267386880,
      limit: 268435456,
      restarts: 0,
      oomKills: 3,
    },
  ],
};
const DATA: ServerHistory = {
  days: 5,
  cpuP95: 0.12,
  memoryP95: 0.35,
  loadOverCpus: 0,
  containers: [
    {
      service: "db",
      memoryP95: 268435456,
      memoryMax: 314572800,
      limit: 536870912,
      restarts: 4,
      oomKills: 0,
    },
  ],
};
/** Its CPU p95 answered `NaN`: no figure. */
const MONITORING: ServerHistory = {
  days: 14,
  memoryP95: 0.5,
  loadOverCpus: 0,
  containers: [
    {
      service: "prometheus",
      memoryP95: 67108864,
      memoryMax: 100663296,
      limit: 201326592,
      restarts: 0,
      oomKills: 0,
    },
  ],
};

describe("readHistory", () => {
  it("is undefined without self-hosted monitoring, and reads nothing", async () => {
    const r = await repository();
    const stack = fakeStack(IPS.monitoring, PROD, await recorded());
    const off = deployed(splitPlan());
    expect(await readHistory(r.prod, off, { remote: stack.remote })).toBeUndefined();
    expect(stack.commands).toEqual([]);
    expect(r.prod.audit.entries).toEqual([]);
  });

  it("reads each server's 14 days with the settled queries, in one read-only command", async () => {
    const r = await repository();
    const stack = fakeStack(IPS.monitoring, PROD, await recorded());
    const history = await readHistory(r.prod, r.owner, { remote: stack.remote });
    expect(stack.commands).toHaveLength(1);
    expect(stack.commands[0]?.host).toBe(IPS.monitoring);
    for (const query of Object.values(settledQueries("shop", "prod"))) {
      expect(stack.commands[0]?.command).toContain(encodeURIComponent(query));
    }
    expect(history).toEqual({ app: APP, data: DATA, monitoring: MONITORING });
    expect(r.prod.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        target: "server monitoring",
        decision: "allow",
      }),
    ]);
    expectNoLeak(r.prod, history);
  });

  it("a sender reads its own servers' figures on its owner's stack, with the owner's login", async () => {
    const r = await repository();
    const staging = { app: "shop-staging", env: "staging" };
    const answers = await recorded();
    // The newest figures of every app: the owner's own app server 10 minutes old, first.
    const newest = (labels: Record<string, string>, ago: number) => ({
      metric: labels,
      value: [NOW.getTime() / 1000, String(NOW.getTime() / 1000 - ago)],
    });
    const figures = JSON.stringify({
      ...answers.figures,
      data: {
        ...answers.figures.data,
        result: [
          newest({ app: "shop", env: "prod", server: "app" }, 600),
          newest({ ...staging, server: "app" }, 20),
          newest({ ...staging, server: "data" }, 15),
        ],
      },
    });
    const stack = fakeStack(IPS.monitoring, staging, { ...answers, figures });
    const history = await readHistory(r.staging, r.sender, { remote: stack.remote });
    expect(stack.commands.map((c) => c.host)).toEqual([IPS.monitoring]);
    expect(stack.commands[0]?.command).toContain(
      encodeURIComponent('app="shop-staging",env="staging"'),
    );
    // One history per server of this environment; the stack's own server is not one of them.
    expect(history).toEqual({ app: APP, data: DATA });
    expectNoLeak(r.staging, history);
  });

  it("lists each query that failed as not read, and reads the rest", async () => {
    const r = await repository();
    const answers = await recorded();
    const stack = fakeStack(IPS.monitoring, PROD, {
      ...answers,
      figures: undefined,
      cpuP95: JSON.stringify({
        status: "error",
        errorType: "timeout",
        error: "query timed out in expression evaluation",
      }),
      containerLimit: undefined,
      restarts: "not json",
    });
    const history = await readHistory(r.prod, r.owner, { remote: stack.remote });
    const strip = ({ cpuP95: _c, containers, ...rest }: ServerHistory): ServerHistory => ({
      ...rest,
      containers: containers.map(({ limit: _l, restarts: _r, ...c }) => c),
      notRead: [
        "whether its figures still arrive: Prometheus did not answer the query",
        "its CPU p95: Prometheus did not answer the query",
        "its containers' memory limits: Prometheus did not answer the query",
        "its containers' restarts: Prometheus did not answer the query",
      ],
    });
    // An answer without a server's series is no figure, not a failure: data's disk isn't filling.
    expect(history).toEqual({ app: strip(APP), data: strip(DATA), monitoring: strip(MONITORING) });
    expectNoLeak(r.prod, history);
  });

  it("lists a server whose figures stopped, without its limits and disk; one without figures has 0 days", async () => {
    const r = await repository();
    const answers = await recorded();
    // app's newest figures are 20 minutes old (its limits and disk still answered: a clock apart);
    // data's are past Prometheus's 5-minute look-back, so its limits are gone too.
    const figures = {
      ...answers.figures,
      data: {
        ...answers.figures.data,
        result: answers.figures.data.result.flatMap((s) =>
          s.metric.server === "data"
            ? []
            : s.metric.server === "app"
              ? [{ ...s, value: [NOW.getTime() / 1000, String(NOW.getTime() / 1000 - 1200)] }]
              : [s],
        ),
      },
    };
    const stopped = {
      ...answers,
      figures,
      containerLimit: without(answers.containerLimit, "data"),
    };
    const silent = Object.fromEntries(
      Object.entries(stopped).map(([figure, answer]) => [figure, without(answer, "monitoring")]),
    );
    const stack = fakeStack(IPS.monitoring, PROD, silent);
    const history = await readHistory(r.prod, r.owner, { remote: stack.remote });
    const { diskFullInDays: _d, ...app } = APP;
    const noLimits = (containers: ServerHistory["containers"]) =>
      containers.map(({ limit: _l, ...c }) => c);
    expect(history).toEqual({
      app: {
        ...app,
        containers: noLimits(app.containers),
        notRead: ["its figures stopped at 2026-11-04T11:40:00.000Z"],
      },
      data: {
        ...DATA,
        containers: noLimits(DATA.containers),
        notRead: ["its figures: none arrived in the last 5 minutes"],
      },
      monitoring: {
        days: 0,
        containers: [],
        notRead: ["its figures: none arrived in the last 5 minutes"],
      },
    });
    expectNoLeak(r.prod, history);
  });

  it("fails plainly, without an address, when the stack's server is out of reach", async () => {
    const r = await repository();
    const down = fakeStack(IPS.data, PROD, await recorded());
    const error = await readHistory(r.prod, r.owner, { remote: down.remote }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("COMMAND_FAILED");
    expect((error as OpsCrewError).message).toContain("server monitoring");
    expect(r.prod.audit.entries).toEqual([]);
    expectNoLeak(r.prod, (error as OpsCrewError).message, (error as OpsCrewError).hint);
  });
});
