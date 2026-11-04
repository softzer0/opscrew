/** Offline checks of the monitoring live test's pure helpers (`monitoring-support.ts`). No network. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  grafanaAdminPassword,
  httpStatus,
  planServers,
  secretEnvValues,
  withoutData,
} from "./monitoring-support";

describe("planServers", () => {
  it("lists the app's server, then each extra server, under prod by default", () => {
    expect(
      planServers({
        app: { name: "shop" } as never,
        servers: [{ name: "data" }, { name: "monitoring" }] as never,
        services: [{ name: "db", enabled: true, server: "data" }] as never,
      }),
    ).toEqual([
      { app: "shop", env: "prod", server: "app", logs: true },
      { app: "shop", env: "prod", server: "data", logs: true },
      // The monitoring server runs none of the app's containers, so it sends figures only.
      { app: "shop", env: "prod", server: "monitoring", logs: false },
    ]);
  });

  it("labels a named environment's servers with its name", () => {
    expect(
      planServers({
        app: { name: "shop-staging" } as never,
        environment: { name: "staging" } as never,
      }),
    ).toEqual([{ app: "shop-staging", env: "staging", server: "app", logs: true }]);
  });
});

describe("withoutData", () => {
  const expected = [
    { app: "shop", env: "prod", server: "app", logs: true },
    { app: "shop", env: "prod", server: "monitoring", logs: false },
    { app: "shop-staging", env: "staging", server: "app", logs: true },
  ];
  const at = "2026-11-04T10:00:00.000Z";

  it("names what each server lacks: figures, a log line where the app runs, or flagged silent", () => {
    const status = {
      addons: [],
      monitoring: {
        reading: {
          servers: [
            {
              app: "shop",
              env: "prod",
              server: "app",
              lastFigures: at,
              lastLog: at,
              silent: false,
            },
            // No log line: none expected from the monitoring server.
            { app: "shop", env: "prod", server: "monitoring", lastFigures: at, silent: false },
            { app: "shop-staging", env: "staging", server: "app", lastLog: at, silent: true },
          ],
        },
      },
    };
    expect(withoutData(JSON.stringify(status), expected)).toEqual([
      "shop-staging/staging/app (no figures, silent)",
    ]);
    const noLog = { ...status.monitoring.reading.servers[0], lastLog: undefined };
    expect(
      withoutData(
        JSON.stringify({ monitoring: { reading: { servers: [noLog] } } }),
        expected.slice(0, 1),
      ),
    ).toEqual(["shop/prod/app (no log line)"]);
  });

  it("names a server the stack doesn't list, and every server without a reading", () => {
    const one = {
      monitoring: {
        reading: {
          servers: [
            {
              app: "shop",
              env: "prod",
              server: "app",
              lastFigures: at,
              lastLog: at,
              silent: false,
            },
          ],
        },
      },
    };
    expect(withoutData(JSON.stringify(one), expected.slice(0, 2))).toEqual([
      "shop/prod/monitoring (not listed)",
    ]);
    expect(withoutData(JSON.stringify({ addons: [], monitoring: {} }), expected)).toHaveLength(3);
    expect(withoutData(JSON.stringify({ addons: [] }), expected)).toHaveLength(3);
  });

  it("throws on output that isn't the status", () => {
    expect(() => withoutData("not json", expected)).toThrow();
  });
});

describe("httpStatus", () => {
  it("reads the status on the last line", () => {
    expect(httpStatus("200")).toBe(200);
    expect(httpStatus("starting\n403\n")).toBe(403);
  });

  it("is undefined when nothing answered", () => {
    expect(httpStatus("000")).toBeUndefined();
    expect(httpStatus("0\n")).toBeUndefined();
    expect(httpStatus("")).toBeUndefined();
    expect(httpStatus("curl: (28) timed out")).toBeUndefined();
  });
});

describe("grafanaAdminPassword", () => {
  it("reads monitoring.grafanaAdminPassword, and throws without it", () => {
    const password = randomBytes(16).toString("hex");
    expect(grafanaAdminPassword({ env: {}, monitoring: { grafanaAdminPassword: password } })).toBe(
      password,
    );
    expect(() => grafanaAdminPassword({ env: {} })).toThrow();
  });
});

describe("secretEnvValues", () => {
  it("gives the values of 8 characters or more whose names the plan marks secret", () => {
    const key = randomBytes(16).toString("hex");
    const quoted = `${randomBytes(8).toString("hex")} with a space`;
    const text = [
      `SESSION_KEY=${key}`,
      `QUOTED_SECRET='${quoted}'`,
      "SHORT_SECRET=abc",
      "NODE_ENV=production",
      "",
    ].join("\n");
    const env = [
      { name: "SESSION_KEY", secret: true, source: "generated" },
      { name: "QUOTED_SECRET", secret: true, source: "user" },
      { name: "SHORT_SECRET", secret: true, source: "user" },
      { name: "NODE_ENV", secret: false, source: "derived" },
    ];
    expect(secretEnvValues(text, { app: { env } as never })).toEqual([
      { name: "SESSION_KEY", value: key },
      { name: "QUOTED_SECRET", value: quoted },
    ]);
  });
});
