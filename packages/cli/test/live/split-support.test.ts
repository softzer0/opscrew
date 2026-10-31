/** Offline checks of the split placement live test's pure helpers (`split-support.ts`). No network. */
import { sep } from "node:path";
import { projectIdFor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  containerProjectId,
  devicePrivateKey,
  estimatedRoundTrip,
  firewallKeys,
  grantConnection,
  linkState,
  longestOutage,
  pauseReadAt,
  pauseVariableWith,
  pauseVariableWithout,
  placeService,
  windowMinutes,
  withinFactor,
} from "./split-support";

const PLAN = `# OpsCrew's plan
app:
  name: shop
services:
  - name: db
    kind: postgres
    memoryMb: 512
  - name: cache
    kind: valkey
    memoryMb: 128
`;

describe("the split placement live test's helpers", () => {
  it("places a service on an extra server as a user edits plan.yaml, comments kept", () => {
    const placed = placeService(PLAN, "db", "data", { name: "data" });
    expect(placed.startsWith("# OpsCrew's plan")).toBe(true);
    const plan = parse(placed) as {
      servers: { name: string }[];
      services: { name: string; server?: string }[];
    };
    expect(plan.servers).toEqual([{ name: "data" }]);
    expect(plan.services.find((s) => s.name === "db")?.server).toBe("data");
    expect(plan.services.find((s) => s.name === "cache")?.server).toBeUndefined();
  });

  it("adds the server's target when given, and never a second entry for it", () => {
    const target = { provider: "digitalocean", location: "fra1" };
    const once = placeService(PLAN, "db", "data", { name: "data", target });
    const twice = placeService(once, "db", "data", { name: "data", target });
    expect((parse(twice) as { servers: unknown[] }).servers).toEqual([{ name: "data", target }]);
  });

  it("moves a service back to the app's server, leaving servers as they are", () => {
    const back = placeService(placeService(PLAN, "db", "data", { name: "data" }), "db", undefined);
    const plan = parse(back) as { servers: unknown[]; services: { server?: string }[] };
    expect(plan.services.every((s) => s.server === undefined)).toBe(true);
    expect(plan.servers).toEqual([{ name: "data" }]);
  });

  it("stops on a service the plan does not have", () => {
    expect(() => placeService(PLAN, "queue", "data")).toThrow(/no service queue/);
  });

  it("reads a link's state and round trip from opscrew status", () => {
    const output = [
      "Private network (10.200.7.0/24):",
      "  app to data: up, last handshake 12 seconds ago, round trip 0.6 ms",
      "  Device laptop (10.200.7.100): last handshake with server app 5 seconds ago",
    ].join("\n");
    expect(linkState(output, "app", "data")).toEqual({ up: true, roundTripMs: 0.6 });
    expect(linkState("  app to data: down, no handshake yet", "app", "data")).toEqual({
      up: false,
    });
    expect(linkState(output, "data", "app")).toBeUndefined();
  });

  it("reads design's estimated delay and the maintenance window's minutes", () => {
    const design =
      "Each query from the app to server data waits about 1 ms (an estimate: 1 ms plus 1 ms per 50 km between Nuremberg and Nuremberg, 0 km apart), so a page that makes 20 queries in a row takes about 20 ms longer.\nMoving db (PostgreSQL) from the app's server to server data needs a maintenance window of about 3 minutes for the database's 7.6 MB: …";
    expect(estimatedRoundTrip(design)).toBe(1);
    expect(windowMinutes(design)).toBe(3);
    expect(windowMinutes("Maintenance window: stop shop … (about 4 minutes of downtime)")).toBe(4);
    expect(estimatedRoundTrip("nothing")).toBeUndefined();
    expect(windowMinutes("nothing")).toBeUndefined();
  });

  it("reads the connection details vpn grant prints once", () => {
    const output = [
      "Device desk's read-only login to db, shown only now (with the device's WireGuard tunnel on):",
      '  psql "host=10.200.7.2 port=5432 user=desk dbname=app"',
      "  Password: s3cr3t-Value_1",
      "  URL for DBeaver and other graphical clients: postgresql://desk:s3cr3t-Value_1@10.200.7.2:5432/app",
    ].join("\n");
    expect(grantConnection(output)).toEqual({
      password: "s3cr3t-Value_1",
      url: "postgresql://desk:s3cr3t-Value_1@10.200.7.2:5432/app",
    });
    expect(grantConnection("no grant here")).toBeUndefined();
  });

  it("reads the device's private key from its configuration", () => {
    const conf = "[Interface]\nPrivateKey = abcDEF123+/=\nAddress = 10.200.7.100/32\n";
    expect(devicePrivateKey(conf)).toBe("abcDEF123+/=");
    expect(devicePrivateKey("[Interface]\n")).toBeUndefined();
  });

  it("names the project folder the CLI uses for the repository in the device container", () => {
    expect(containerProjectId("/work/repo")).toMatch(/^repo-[0-9a-f]{12}$/);
  });

  it.runIf(sep === "/")("matches the CLI's own project id on a POSIX computer", () => {
    expect(containerProjectId("/work/repo")).toBe(projectIdFor("/work/repo"));
  });

  it("measures the longest time the app did not answer", () => {
    expect(longestOutage([])).toBe(0);
    expect(
      longestOutage([
        { at: 0, ok: true },
        { at: 1_000, ok: false },
        { at: 4_000, ok: false },
        { at: 6_000, ok: true },
        { at: 7_000, ok: false },
        { at: 8_000, ok: true },
      ]),
    ).toBe(5_000);
    // Still down at the last sample: counted to it.
    expect(
      longestOutage([
        { at: 0, ok: true },
        { at: 2_000, ok: false },
        { at: 9_000, ok: false },
      ]),
    ).toBe(7_000);
  });

  it("lists a firewall's inbound rules by protocol and port, Hetzner's and DigitalOcean's", () => {
    expect(
      firewallKeys([
        { direction: "in", protocol: "tcp", port: "22" },
        { direction: "in", protocol: "icmp", port: null },
        { direction: "in", protocol: "udp", port: "51820" },
        { direction: "out", protocol: "tcp", port: "80" },
      ]),
    ).toEqual(["icmp", "tcp/22", "udp/51820"]);
    expect(
      firewallKeys([
        { protocol: "icmp", ports: "0" },
        { protocol: "udp", ports: "51820" },
      ]),
    ).toEqual(["icmp", "udp/51820"]);
  });

  it("says when GitHub read the deploy pause from the deploy job's conclusion", () => {
    expect(pauseReadAt("skipped")).toBe("when the job started");
    expect(pauseReadAt("success")).toBe("when the run was created");
    expect(pauseReadAt("failure")).toBeUndefined();
    expect(pauseReadAt(null)).toBeUndefined();
  });

  it("writes and removes the run's own entry of the deploy pause variable", () => {
    const now = new Date("2026-10-31T10:00:00Z");
    const set = pauseVariableWith(undefined, "shop/prod", now);
    expect(JSON.parse(set)).toEqual({
      "shop/prod": { reason: "e2e", since: "2026-10-31T10:00:00.000Z" },
    });
    // The workflow's condition looks for the key with its quotes.
    expect(set.includes('"shop/prod"')).toBe(true);
    const both = pauseVariableWith(
      JSON.stringify({ "other/prod": { reason: "move" } }),
      "shop/prod",
      now,
    );
    expect(JSON.parse(pauseVariableWithout(both, "shop/prod") as string)).toEqual({
      "other/prod": { reason: "move" },
    });
    expect(pauseVariableWithout(set, "shop/prod")).toBeUndefined();
    expect(pauseVariableWithout("not json", "shop/prod")).toBe("not json");
  });

  it("compares an estimate with a measurement within a factor", () => {
    expect(withinFactor(2, 1.2, 2)).toBe(true);
    expect(withinFactor(2, 0.5, 2)).toBe(false);
    expect(withinFactor(6, 13, 2)).toBe(false);
    expect(withinFactor(6, 0, 2)).toBe(false);
  });
});
