import { describe, expect, it } from "vitest";
import { dockerFrames } from "./__fixtures__/fake-portainer";
import { containerFigures, logLines, sinceAfter } from "./docker";

const T1 = "2026-10-28T09:00:01.000000001Z";
const T2 = "2026-10-28T09:00:02.500000000Z";
const T3 = "2026-10-28T09:00:03.999999999Z";

describe("logLines", () => {
  it("demultiplexes frames of both streams, in order, with each line's timestamp", () => {
    const body = dockerFrames(
      [1, `${T1} listening on :3000\n`],
      [2, `${T2} warning: slow query\n${T3} \n`],
      [1, `${T3} GET / 200\n`],
    );
    expect(logLines(body)).toEqual([
      { stream: "stdout", time: T1, line: "listening on :3000" },
      { stream: "stderr", time: T2, line: "warning: slow query" },
      { stream: "stderr", time: T3, line: "" },
      { stream: "stdout", time: T3, line: "GET / 200" },
    ]);
  });

  it("keeps a line cut across two frames whole, a split character included", () => {
    const text = Buffer.from(`${T1} hello wörld\n`, "utf8");
    const cut = text.indexOf(0xc3) + 1; // inside "ö"
    const body = dockerFrames(
      [1, text.subarray(0, cut)],
      [2, `${T2} meanwhile\n`],
      [1, text.subarray(cut)],
    );
    expect(logLines(body)).toEqual([
      { stream: "stdout", time: T1, line: "hello wörld" },
      { stream: "stderr", time: T2, line: "meanwhile" },
    ]);
  });

  it("sorts interleaved frames by time, so polling after the last line repeats none", () => {
    const body = dockerFrames(
      [2, `${T2} err two\n`],
      [1, `${T1} out one\n${T3} out three\n`],
      [2, `${T3} err three\n`],
    );
    expect(logLines(body)).toEqual([
      { stream: "stdout", time: T1, line: "out one" },
      { stream: "stderr", time: T2, line: "err two" },
      // Equal times keep the order Docker sent them in.
      { stream: "stdout", time: T3, line: "out three" },
      { stream: "stderr", time: T3, line: "err three" },
    ]);
  });

  it("passes a TTY container's raw stream as stdout without carriage returns", () => {
    const body = Buffer.from(`${T1} one\r\n${T2} two\r\n${T3} last`, "utf8");
    expect(logLines(body)).toEqual([
      { stream: "stdout", time: T1, line: "one" },
      { stream: "stdout", time: T2, line: "two" },
      { stream: "stdout", time: T3, line: "last" },
    ]);
  });

  it("reads an empty answer as no lines", () => {
    expect(logLines(new Uint8Array())).toEqual([]);
  });

  it("refuses a frame cut short, an error frame and a line without a timestamp", () => {
    const whole = dockerFrames([1, `${T1} one\n`]);
    expect(() => logLines(whole.subarray(0, whole.length - 2))).toThrow(/ended inside/);
    expect(() => logLines(dockerFrames([3, "error from daemon in stream"]))).toThrow(
      /error from daemon in stream/,
    );
    expect(() => logLines(dockerFrames([1, "no timestamp\n"]))).toThrow(/timestamp/);
  });
});

describe("sinceAfter", () => {
  const seconds = Date.parse("2026-10-28T09:00:01Z") / 1000;

  it("is the line's time plus one nanosecond, as <seconds>.<nanoseconds>", () => {
    expect(sinceAfter(T1)).toBe(`${seconds}.000000002`);
    expect(sinceAfter("2026-10-28T09:00:01Z")).toBe(`${seconds}.000000001`);
    expect(sinceAfter("2026-10-28T09:00:01.5Z")).toBe(`${seconds}.500000001`);
    expect(sinceAfter("2026-10-28T11:00:01.5+02:00")).toBe(`${seconds}.500000001`);
  });

  it("carries into the next second", () => {
    expect(sinceAfter("2026-10-28T09:00:01.999999999Z")).toBe(`${seconds + 1}.000000000`);
  });

  it("refuses text that is not a Docker timestamp", () => {
    expect(() => sinceAfter("yesterday")).toThrow(/timestamp/);
  });
});

describe("containerFigures", () => {
  const cpu = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_400_000_000 },
      system_cpu_usage: 120_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 116_000_000_000,
      online_cpus: 4,
    },
  };

  it("computes CPU % from the two samples and memory without inactive files (cgroup v2)", () => {
    const figures = containerFigures({
      ...cpu,
      memory_stats: {
        usage: 300_000_000,
        stats: { inactive_file: 100_000_000, anon: 150_000_000 },
      },
    });
    // (0.4e9 / 4e9) × 4 × 100
    expect(figures.cpuPercent).toBeCloseTo(40, 10);
    expect(figures).toEqual({ cpuPercent: figures.cpuPercent, memoryUsedBytes: 200_000_000 });
  });

  it("subtracts the page cache on cgroup v1", () => {
    const figures = containerFigures({
      ...cpu,
      memory_stats: {
        usage: 300_000_000,
        stats: { cache: 120_000_000, inactive_file: 50_000_000, total_inactive_file: 50_000_000 },
      },
    });
    expect(figures).toEqual({ cpuPercent: figures.cpuPercent, memoryUsedBytes: 180_000_000 });
  });

  it("gives 0% without a previous sample (a stopped container)", () => {
    expect(containerFigures({ cpu_stats: {}, precpu_stats: {}, memory_stats: {} })).toEqual({
      cpuPercent: 0,
      memoryUsedBytes: 0,
    });
  });
});
