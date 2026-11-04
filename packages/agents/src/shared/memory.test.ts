import { CRON_ROUTE_MEMORY_MB } from "@opscrew/iac-templates";
import {
  ADDON_MEMORY_DEFAULTS,
  type DeployPlan,
  type MonitoringSettings,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownPlan, testPlan } from "../testing";
import { appMemoryLimits, appMemoryMb, memoryHeadroom, monitoringLimits } from "./memory";

describe("appMemoryMb", () => {
  it("adds the web process, enabled workers times their copies, enabled services and cron", () => {
    const plan = { ...ownPlan(), services: [] };
    const web = plan.app.memoryMb;
    const worker = {
      name: "worker",
      command: "node worker.js",
      source: "user" as const,
      count: 2,
      single: false,
      stopGraceSeconds: 30,
      memoryMb: 256,
      enabled: true,
    };
    const job = {
      name: "cleanup",
      schedule: "*/15 * * * *",
      command: "node cleanup.js",
      enabled: true,
    };
    const valkey = {
      name: "cache",
      kind: "valkey" as const,
      version: "8",
      memoryMb: 128,
      enabled: true,
      options: { mode: "cache" as const },
      reason: "The app uses Redis.",
      licence: "BSD-3-Clause",
    };
    expect(appMemoryMb(plan)).toBe(web);
    const workers = [worker, { ...worker, name: "off", enabled: false }];
    expect(appMemoryMb({ ...plan, processes: { workers, cron: [] } })).toBe(web + 2 * 256);
    expect(appMemoryMb({ ...plan, services: [valkey, { ...valkey, enabled: false }] })).toBe(
      web + 128,
    );
    // A command job runs the app's code in the cron container, with the web process's limit.
    expect(appMemoryMb({ ...plan, processes: { workers: [], cron: [job] } })).toBe(2 * web);
    const off = { ...job, enabled: false };
    expect(appMemoryMb({ ...plan, processes: { workers: [], cron: [off] } })).toBe(web);
    // Route jobs only: supercronic and the probe.
    const route = { name: "report", schedule: "0 * * * *", route: "/api/report", enabled: true };
    const routes = { ...plan, processes: { workers: [], cron: [route, off] } };
    expect(appMemoryMb(routes)).toBe(web + CRON_ROUTE_MEMORY_MB);
    expect(appMemoryLimits(routes)).toEqual([
      { name: "the app", memoryMb: web },
      { name: "cron", memoryMb: CRON_ROUTE_MEMORY_MB },
    ]);
    expect(appMemoryMb({ ...plan, processes: { workers: [], cron: [route, job] } })).toBe(2 * web);
  });
});

describe("the self-hosted monitoring's containers", () => {
  const plan = testPlan();
  const monitoring = (where: MonitoringSettings["where"]): DeployPlan["observability"] => ({
    monitoring: {
      enabled: true,
      where,
      versions: { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" },
      retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 23 },
      memoryMb: { ...ADDON_MEMORY_DEFAULTS.monitoring },
    },
  });
  const alloy = { name: "Grafana Alloy", memoryMb: 288 };
  const stack = [
    { name: "Prometheus", memoryMb: 192 },
    { name: "Loki", memoryMb: 384 },
    { name: "Grafana", memoryMb: 416 },
    { name: "the monitoring front", memoryMb: 96 },
  ];

  it("counts Alloy on every monitored server, and the stack on its server", () => {
    const own = { ...plan, observability: monitoring({ kind: "server", server: "monitoring" }) };
    expect(appMemoryLimits(own)).toEqual([
      { name: "the app", memoryMb: 512 },
      { name: "db", memoryMb: 512 },
      alloy,
    ]);
    expect(monitoringLimits(own, "monitoring")).toEqual([alloy, ...stack]);
    expect(monitoringLimits(own, "data")).toEqual([alloy]);
    // The stack's limits total 1,088 MB; with the monitoring server's own Alloy and proxy 1,376.
    const total = (limits: { memoryMb: number }[]) => limits.reduce((s, l) => s + l.memoryMb, 0);
    expect(total(stack)).toBe(1088);
    expect(total(monitoringLimits(own, "monitoring"))).toBe(1376);

    const onApp = { ...plan, observability: monitoring({ kind: "app" }) };
    expect(appMemoryLimits(onApp).slice(2)).toEqual([alloy, ...stack]);
    // A sender's stack is the owner's: only Alloy here.
    const sender = {
      ...plan,
      observability: monitoring({
        kind: "shared",
        owner: { plan: "opscrew/plan.yaml", server: "monitoring" },
      }),
    };
    expect(appMemoryLimits(sender).slice(2)).toEqual([alloy]);
    expect(monitoringLimits({ ...plan, observability: undefined }, "app")).toEqual([]);
  });

  it("counts one Alloy, at monitoring's limits, when Grafana Cloud uses it too", () => {
    const observability = {
      ...monitoring({ kind: "server", server: "monitoring" }),
      grafanaCloud: {
        enabled: true,
        version: "1.21.3",
        metrics: { url: "https://prometheus.example.net/api/prom/push", user: "123" },
        logs: { url: "https://logs.example.net/loki/api/v1/push", user: "456" },
        logSampling: 100,
        memoryMb: { alloy: 192, proxy: 32 },
      },
    };
    expect(appMemoryLimits({ ...plan, observability }).slice(2)).toEqual([alloy]);
    const { monitoring: _off, ...grafanaOnly } = observability;
    expect(appMemoryLimits({ ...plan, observability: grafanaOnly }).slice(2)).toEqual([
      { name: "Grafana Alloy", memoryMb: 224 },
    ]);
  });
});

describe("memoryHeadroom", () => {
  it("leaves the system's 384 MB and the edge's 128 MB, then measures what is free", () => {
    // 2048 − 384 = 1664 usable; 1024 + 128 used leaves 512, about 31%.
    expect(memoryHeadroom(2048, 1024, 128)).toEqual({ free: 512 / 1664, fits: true, low: false });
    // 1664 − 1400 − 128 = 136 free, about 8%: it fits, but with little room.
    expect(memoryHeadroom(2048, 1400, 128)).toMatchObject({ fits: true, low: true });
    expect(memoryHeadroom(2048, 1600, 128)).toMatchObject({ fits: false, low: true });
    expect(memoryHeadroom(256, 0, 128)).toMatchObject({ fits: false });
  });
});
