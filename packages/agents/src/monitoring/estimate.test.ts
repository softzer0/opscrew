import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  estimateDisk,
  figuresCommand,
  fittingDays,
  readFigures,
  type ServerLoad,
  serverSeries,
} from "./estimate";

const GIB = 1024 ** 3;

describe("serverSeries", () => {
  it("counts research R7's series: a 2-vCPU server with 8 containers, the edge and Postgres sends about 180", () => {
    // 5 × 2 + 7 for the server, 5 × 8 + 2 for the containers and the network, 80 for one host,
    // 40 for Postgres.
    expect(serverSeries({ cpus: 2, containers: 8, hostnames: 1, postgres: true })).toBe(179);
    expect(serverSeries({ cpus: 2, containers: 8 })).toBe(59);
    expect(serverSeries({ cpus: 4, containers: 3, hostnames: 2 })).toBe(20 + 7 + 15 + 2 + 160);
  });
});

describe("estimateDisk", () => {
  it("keeps 15-second samples at 2 bytes over the figures' days plus 3 hours of WAL at 10 bytes", () => {
    // R7: the 2-vCPU server above, about 30 MB over 15 days.
    const estimate = estimateDisk(
      [{ series: 179, logBytes24h: 0 }],
      { metricsDays: 15, logsDays: 7 },
      40,
    );
    const samples = 179 / 15;
    const bytes = samples * 86_400 * 15 * 2 + samples * 3 * 3600 * 10;
    expect(estimate.series).toBe(179);
    expect(estimate.figuresGb).toBeCloseTo(bytes / GIB, 10);
    expect(estimate.figuresGb * GIB).toBeGreaterThan(30e6);
    expect(estimate.figuresGb * GIB).toBeLessThan(33e6);
    expect(estimate.logsGb).toBe(0);
    expect(estimate.metricsMaxGb).toBe(32);
    expect(estimate.fits).toBe(true);
  });

  it("keeps logs at a quarter of a day's text over their days, summed across servers, and caps figures at 80% of the disk left", () => {
    const loads: ServerLoad[] = [
      { series: 200, logBytes24h: 2 * GIB },
      { series: 100, logBytes24h: 2 * GIB },
    ];
    const estimate = estimateDisk(loads, { metricsDays: 15, logsDays: 7 }, 40);
    // 4 GiB a day, 7 days, a quarter: 7 GiB.
    expect(estimate.logsGb).toBe(7);
    expect(estimate.series).toBe(300);
    // 80% of the 33 GB left after the logs.
    expect(estimate.metricsMaxGb).toBe(26);
    expect(estimate.fits).toBe(true);
  });

  it("refuses past 80% of the disk, and finds the longest retention that fits", () => {
    const loads: ServerLoad[] = [{ series: 200, logBytes24h: 20 * GIB }];
    const retention = { metricsDays: 15, logsDays: 7 };
    // 20 GiB a day for 7 days at a quarter: 35 GiB, past 32 of 40.
    const estimate = estimateDisk(loads, retention, 40);
    expect(estimate.fits).toBe(false);
    expect(fittingDays(loads, retention, 40, "logsDays")).toBe(6);
    // Figures are not what fills it.
    expect(fittingDays(loads, retention, 40, "metricsDays")).toBeUndefined();
    expect(estimateDisk(loads, { ...retention, logsDays: 6 }, 40).fits).toBe(true);
    // Prometheus's cap is never below 1 GB.
    expect(estimate.metricsMaxGb).toBe(4);
    expect(estimateDisk(loads, retention, 30).metricsMaxGb).toBe(1);
  });
});

describe("readFigures", () => {
  it("reads the CPUs, memory, the app's logs of a day, the running containers and the free disk, audited without the address", async () => {
    const deps = await createTestPhaseDeps();
    const commands: string[] = [];
    const remote: RemoteExec = {
      host: "203.0.113.10",
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: `2\n3900000\n40000000\n7\n${30 * GIB}\n`, stderr: "" };
      },
    };
    const figures = await readFigures(deps, remote, "shop", "data");
    expect(figures).toEqual({
      cpus: 2,
      memoryMb: 3809,
      containers: 7,
      logBytes24h: 40_000_000,
      diskFreeGb: 30,
    });
    expect(commands).toEqual([figuresCommand("shop")]);
    expect(commands[0]).toContain("com.docker.compose.project=shop");
    expect(commands[0]).toContain("docker ps -q | wc -l");
    const entries = deps.audit.entries;
    expect(entries).toEqual([
      expect.objectContaining({ kind: "remote-exec", target: "server data", decision: "allow" }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("203.0.113.10");
    expect(() => figuresCommand("shop; rm -rf /")).toThrow();
  });

  it("stops in plain words when the read fails or answers something else", async () => {
    const deps = await createTestPhaseDeps();
    const answer = (stdout: string, exitCode = 0): RemoteExec => ({
      host: "203.0.113.10",
      run: async () => ({ exitCode, stdout, stderr: "" }),
    });
    for (const remote of [answer("2\n3900000\n", 0), answer("", 255), answer("a\nb\nc\nd\ne\n")]) {
      const error = await readFigures(deps, remote, "shop", "app").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).message).toMatch(/the app's server.*Nothing was changed\.$/);
    }
    expect(deps.audit.entries).toEqual([]);
  });
});
