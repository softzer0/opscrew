/** Advise's 14 days from the self-hosted stack (US3, US4), on Prometheus answers as recorded. */
import { readFile } from "node:fs/promises";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoredPlan, networked, senderPlan, splitPlan } from "../network/__fixtures__/plans";
import type { NetworkHostFacts } from "../network/allocate";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps, type TestPhaseDeps } from "../testing";
import { readHistory } from "./history";
import type { ServerHistory } from "./types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
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
const PROMETHEUS = "docker exec opscrew-monitoring-prometheus-1 wget -q -O - ";

type Figure =
  | "figures"
  | "days"
  | "cpuP95"
  | "memoryP95"
  | "loadOverCpus"
  | "diskFullInDays"
  | "containerP95"
  | "containerMax"
  | "containerLimit"
  | "restarts"
  | "oomKills";

/** The queries of research R5 (S2), as written, for one app and environment; then status's. */
function settledQueries(app: string, env: string): Record<Figure, string> {
  const SEL = `app="${app}",env="${env}"`;
  const BY = "app, env, server";
  return {
    // Each server's newest figures, as `opscrew status` asks: every app's.
    figures: "max by (app, env, server) (timestamp(node_load1))",
    days: `max by (${BY}) ((time() - min_over_time(timestamp(node_memory_MemTotal_bytes{${SEL}})[14d:1h])) / 86400)`,
    cpuP95: `quantile_over_time(0.95, (1 - avg by (${BY}) (rate(node_cpu_seconds_total{${SEL},mode="idle"}[5m])))[14d:5m])`,
    memoryP95: `quantile_over_time(0.95, (1 - max by (${BY}) (node_memory_MemAvailable_bytes{${SEL}}) / max by (${BY}) (node_memory_MemTotal_bytes{${SEL}}))[14d:5m])`,
    loadOverCpus: `avg_over_time((max by (${BY}) (node_load15{${SEL}}) > bool on (${BY}) count by (${BY}) (node_cpu_seconds_total{${SEL},mode="idle"}))[14d:5m])`,
    diskFullInDays: `max by (${BY}) (node_filesystem_avail_bytes{${SEL},mountpoint="/"}) / max by (${BY}) (-deriv(node_filesystem_avail_bytes{${SEL},mountpoint="/"}[7d]) > 0) / 86400`,
    containerP95: `quantile_over_time(0.95, (max by (${BY}, service) (container_memory_working_set_bytes{${SEL}}))[14d:5m])`,
    containerMax: `max by (${BY}, service) (max_over_time(container_memory_working_set_bytes{${SEL}}[14d]))`,
    containerLimit: `max by (${BY}, service) (container_spec_memory_limit_bytes{${SEL}} > 0)`,
    restarts: `sum by (${BY}, service) (changes(container_start_time_seconds{${SEL}}[14d]))`,
    oomKills: `sum by (${BY}, service) (increase(container_oom_events_total{${SEL}}[14d]))`,
  };
}

interface Answer {
  status: string;
  data: { resultType: string; result: { metric: Record<string, string>; value: unknown[] }[] };
}

/** Prometheus's answers recorded for the spike's figures (`shop`, prod: app, data, monitoring). */
async function recorded(): Promise<Record<Figure, Answer>> {
  return JSON.parse(
    await readFile(new URL("./__fixtures__/prometheus-history.json", import.meta.url), "utf8"),
  );
}

/** `answer` without the series of `server`, as Prometheus answers once its figures stopped. */
function without(answer: Answer, server: string): Answer {
  return {
    ...answer,
    data: { ...answer.data, result: answer.data.result.filter((s) => s.metric.server !== server) },
  };
}

/**
 * The stack's server as a shell: runs the command's `echo`s, `true` and Prometheus's `wget`s,
 * answering each settled query of `app`/`env` with its answer (raw text as is; none: wget failed).
 * Any other command part fails the test. Every other host is out of reach.
 */
function fakeStack(
  stackHost: string,
  labels: { app: string; env: string },
  answers: Partial<Record<Figure, Answer | string>>,
) {
  const commands: { host: string; command: string; timeoutMs?: number }[] = [];
  const byQuery = new Map(
    Object.entries(settledQueries(labels.app, labels.env)).map(([figure, q]) => [q, figure]),
  );
  const shell = (command: string): string =>
    command
      .split("; ")
      .map((part) => {
        if (part === "echo") return "\n";
        if (part === "true") return "";
        const echo = /^echo '([^']*)'$/.exec(part);
        if (echo !== null) return `${echo[1]}\n`;
        const url = new RegExp(
          `^${PROMETHEUS}'http://127\\.0\\.0\\.1:9090/api/v1/query\\?query=([^']*)'$`,
        ).exec(part);
        if (url === null) throw new Error(`unexpected command part: ${part}`);
        const figure = byQuery.get(decodeURIComponent(url[1] as string)) as Figure | undefined;
        if (figure === undefined) throw new Error(`not a settled query: ${url[1]}`);
        const answer = answers[figure];
        if (answer === undefined) return "";
        if (typeof answer === "string") return answer;
        return JSON.stringify({
          ...answer,
          data: {
            ...answer.data,
            result: answer.data.result.map((s) =>
              s.metric.app === "shop" && s.metric.env === "prod"
                ? { ...s, metric: { ...s.metric, ...labels } }
                : s,
            ),
          },
        });
      })
      .join("");
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command, options): Promise<CommandResult> {
      commands.push({
        host,
        command,
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (host === stackHost) return { exitCode: 0, stdout: shell(command), stderr: "" };
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
  const allocated = networked(plan, facts).plan;
  return DeployPlanSchema.parse({
    ...allocated,
    deployment: {
      ...allocated.deployment,
      lastApplyAt: "2026-10-20T09:00:00.000Z",
      firstDeployAt: "2026-10-20T09:30:00.000Z",
    },
  });
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
