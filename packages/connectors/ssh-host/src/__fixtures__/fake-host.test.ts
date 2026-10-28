import { describe, expect, it } from "vitest";
import { FakeHost } from "./fake-host";

/** A script the fake answers by its header: `inspect` prints the server's facts, line by line. */
const INSPECT = "sh -c '# opscrew-host: inspect'";

describe("FakeHost's streaming options", () => {
  it("replays its answer through onLine line by line", async () => {
    const host = new FakeHost();
    const lines: string[] = [];
    const answer = await host.run(INSPECT, {
      onLine: (stream, line) => lines.push(`${stream} ${line}`),
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toBe(
      answer.stdout
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `stdout ${line}`)
        .join("\n"),
    );
  });

  it("refuses to run once its signal is stopped", async () => {
    const host = new FakeHost();
    const stop = new AbortController();
    stop.abort();
    await expect(host.run(INSPECT, { signal: stop.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(host.calls).toEqual([]);
  });
});
