import { describe, expect, it } from "vitest";
import { DATA_HOST, splitWorld } from "../status/__fixtures__/split";
import { testPlan } from "../testing";
import { serverChecks } from "./servers";

/** Each check as `id: status`. */
function statuses(checks: { id: string; status: string }[]): string[] {
  return checks.map((check) => `${check.id}: ${check.status}`);
}

describe("verify's checks of an app on two servers", () => {
  it("passes when every server answers, every link is up and every port is published", async () => {
    const w = await splitWorld();
    const checks = await serverChecks(w.deps, w.plan, {
      remote: w.remote,
      network: w.network,
      flag: "",
    });
    expect(statuses(checks)).toEqual([
      "server-app-reachable: pass",
      "server-data-reachable: pass",
      "server-data-db-published: pass",
      "link-app-data: pass",
      "link-data-app: pass",
    ]);
    expect(checks.find((c) => c.id === "link-app-data")?.message).toBe(
      "The private link from server app to server data is up (last handshake 5 seconds ago, round trip 0.8 ms).",
    );
  });

  it("names the server and the next step for each failure", async () => {
    const w = await splitWorld();
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.ports = "db|0.0.0.0:5432->5432/tcp\n";
    w.handshakes.app = { data: 400 };
    const checks = await serverChecks(w.deps, w.plan, {
      remote: w.remote,
      network: w.network,
      flag: " --env prod",
    });
    const published = checks.find((c) => c.id === "server-data-db-published");
    expect(published).toMatchObject({
      status: "fail",
      message: `PostgreSQL (db) on server data is not published on its private address ${w.prefix}.2:5432, so the app can't reach it.`,
      remediation:
        "Run `opscrew provision --env prod` to fix it, then `opscrew verify --env prod` again.",
    });
    const link = checks.find((c) => c.id === "link-app-data");
    expect(link).toMatchObject({
      status: "fail",
      message:
        "The private link from server app to server data is down (last handshake 6 minutes ago, round trip 0.8 ms).",
    });
    expect(link?.remediation).toContain("WireGuard's UDP port 51820");
  });

  it("fails a server it cannot reach once, without its links", async () => {
    const w = await splitWorld();
    w.offline.add(DATA_HOST);
    const checks = await serverChecks(w.deps, w.plan, {
      remote: w.remote,
      network: w.network,
      flag: "",
    });
    expect(statuses(checks)).toEqual([
      "server-app-reachable: pass",
      "server-data-reachable: fail",
      "link-app-data: pass",
    ]);
    expect(checks[1]?.message).toMatch(/^OpsCrew could not read server data over SSH\. /);
    expect(checks[1]?.remediation).toContain("Check that server data is on");
  });

  it("warns when a server's login cannot become root to read the network", async () => {
    const w = await splitWorld();
    const data = w.servers[DATA_HOST];
    if (data !== undefined) data.privilege = "none";
    const checks = await serverChecks(w.deps, w.plan, {
      remote: w.remote,
      network: w.network,
      flag: "",
    });
    expect(checks.find((c) => c.id === "link-data-app")).toMatchObject({
      status: "warn",
      message:
        "OpsCrew can't read the private network on server data without root (give its login passwordless sudo).",
    });
  });

  it("checks nothing for a plan without a private network", async () => {
    const w = await splitWorld();
    expect(await serverChecks(w.deps, testPlan({ deployed: true }), { flag: "" })).toEqual([]);
    expect(w.commands).toEqual([]);
  });
});
