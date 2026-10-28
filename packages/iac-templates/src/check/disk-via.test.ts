import { describe, expect, it } from "vitest";
import { testPlan } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { inEnvironment } from "../workflow/__fixtures__/plans";
import { checkDiskVia } from "./index";

describe("checkDiskVia", () => {
  it("reads a server's disk where its deploys run", () => {
    expect(checkDiskVia(testPlan({ domain: "example.com" }))).toBe("github");
    expect(checkDiskVia(testPlan({ provider: "own", domain: "example.com" }))).toBe("github");
    const server = testPlan({ provider: "own", domain: "example.com" });
    expect(checkDiskVia(inEnvironment(server, { runner: "server" }))).toBe("own-runner");
    const host = { name: "builder", arch: "amd64" } as const;
    expect(checkDiskVia(inEnvironment(server, { runner: "host", runnerHost: host }))).toBe(
      "runner-host",
    );
  });

  it("reads none behind the tunnel without the server's own runner", () => {
    const tunnel = testPlan({ provider: "own", access: "tunnel", domain: "example.com" });
    expect(checkDiskVia(tunnel)).toBeUndefined();
    expect(checkDiskVia(inEnvironment(tunnel, { runner: "server" }))).toBe("own-runner");
  });

  it("reads none without a server of the app's", () => {
    for (const plan of [portainerTestPlan({ domain: "example.com" }), ssrPlan(), pagesPlan()]) {
      expect(checkDiskVia(plan)).toBeUndefined();
    }
  });
});
