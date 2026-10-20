import { CRON_ROUTE_MEMORY_MB } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { ownPlan } from "../testing";
import { appMemoryLimits, appMemoryMb, memoryHeadroom } from "./memory";

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

describe("memoryHeadroom", () => {
  it("leaves the system's 384 MB and the edge's 128 MB, then measures what is free", () => {
    // 2048 − 384 = 1664 usable; 1024 + 128 used leaves 512, about 31%.
    expect(memoryHeadroom(2048, 1024)).toEqual({ free: 512 / 1664, fits: true, low: false });
    // 1664 − 1400 − 128 = 136 free, about 8%: it fits, but with little room.
    expect(memoryHeadroom(2048, 1400)).toMatchObject({ fits: true, low: true });
    expect(memoryHeadroom(2048, 1600)).toMatchObject({ fits: false, low: true });
    expect(memoryHeadroom(256, 0)).toMatchObject({ fits: false });
  });
});
