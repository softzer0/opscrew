import { describe, expect, it } from "vitest";
import {
  addonLeftoverCommand,
  addonLeftovers,
  billedMinutes,
  figureProblems,
  fillBytes,
  GRAFANA_CLOUD_VARIABLES,
  issueKey,
  logLines,
  lokiQueryUrl,
  lokiStreams,
  memoryUsage,
  monthlyRuns,
  ntfyMessages,
  ntfyPollUrl,
  observabilitySettings,
  prometheusQueryUrl,
  promVector,
  REQUEST_PREFIX,
  requestLogFiles,
  requestPath,
  resolvedAfter,
  SEEDED_VARIABLE,
  statusFigures,
} from "./observability-support";

const TOPIC = "opscrew-e2e-topic-0123456789";
const CHECK = {
  OPSCREW_E2E_OBSERVABILITY: "1",
  OPSCREW_E2E_CLOUDFLARE_TOKEN: "cf",
  OPSCREW_E2E_DOMAIN: "e2e.example.com",
  OPSCREW_E2E_NTFY_TOPIC: TOPIC,
};
const GRAFANA = Object.fromEntries(
  GRAFANA_CLOUD_VARIABLES.map((name) => [name, name.endsWith("URL") ? "https://x/push" : "1"]),
);

describe("observabilitySettings", () => {
  it("is a note to log when neither gate is set", () => {
    expect(observabilitySettings("nextjs-postgres", {})).toEqual(expect.any(String));
  });

  it("runs only with the example its request log is written for", () => {
    expect(observabilitySettings("go-api", CHECK)).toEqual({
      skip: expect.stringContaining("OPSCREW_E2E_APP=nextjs-postgres"),
    });
    expect(observabilitySettings(undefined, { OPSCREW_E2E_ADDONS: "1" })).toEqual({
      skip: expect.any(String),
    });
  });

  it("needs the Cloudflare zone and a long ntfy topic for the check", () => {
    const { OPSCREW_E2E_DOMAIN: _, ...noDomain } = CHECK;
    expect(observabilitySettings("nextjs-postgres", noDomain)).toEqual({
      skip: expect.stringContaining("OPSCREW_E2E_DOMAIN"),
    });
    const { OPSCREW_E2E_NTFY_TOPIC: __, ...noTopic } = CHECK;
    expect(observabilitySettings("nextjs-postgres", noTopic)).toEqual({
      skip: expect.stringContaining("OPSCREW_E2E_NTFY_TOPIC"),
    });
    for (const topic of ["short", "with space in it 123", "a/b-0123456789abcdef"]) {
      expect(
        observabilitySettings("nextjs-postgres", { ...CHECK, OPSCREW_E2E_NTFY_TOPIC: topic }),
        topic,
      ).toEqual({ skip: expect.stringContaining("OPSCREW_E2E_NTFY_TOPIC") });
    }
    expect(observabilitySettings("nextjs-postgres", CHECK)).toEqual({
      check: true,
      ntfyTopic: TOPIC,
      addons: false,
    });
  });

  it("runs the add-ons alone without the zone, and Grafana Cloud only with all its variables", () => {
    expect(observabilitySettings("nextjs-postgres", { OPSCREW_E2E_ADDONS: "1" })).toEqual({
      check: false,
      ntfyTopic: "",
      addons: true,
    });
    const { OPSCREW_E2E_GRAFANA_CLOUD_READ_TOKEN: _, ...partial } = GRAFANA;
    expect(
      observabilitySettings("nextjs-postgres", { OPSCREW_E2E_ADDONS: "1", ...partial }),
    ).toEqual({ skip: expect.stringContaining("OPSCREW_E2E_GRAFANA_CLOUD_READ_TOKEN") });
    const full = observabilitySettings("nextjs-postgres", {
      ...CHECK,
      OPSCREW_E2E_ADDONS: "1",
      ...GRAFANA,
    });
    expect(full).toMatchObject({ check: true, addons: true, grafana: { metricsUser: "1" } });
    // Without the add-ons' gate, Grafana Cloud's variables change nothing.
    expect(observabilitySettings("nextjs-postgres", { ...CHECK, ...partial })).toEqual({
      check: true,
      ntfyTopic: TOPIC,
      addons: false,
    });
  });
});

describe("the request log", () => {
  it("is a Next.js proxy that logs only the test's own requests", () => {
    const files = requestLogFiles("nextjs-postgres") ?? {};
    expect(Object.keys(files)).toEqual(["proxy.ts"]);
    expect(files["proxy.ts"]).toContain("export function proxy(");
    expect(files["proxy.ts"]).toContain(REQUEST_PREFIX);
    expect(files["proxy.ts"]).not.toContain("process.env");
    expect(requestLogFiles("go-api")).toBeUndefined();
  });

  it("prints the seeded secret only on its own requests in the seeded variant", () => {
    const text = requestLogFiles("nextjs-postgres", true)?.["proxy.ts"] ?? "";
    expect(text).toContain(`process.env.${SEEDED_VARIABLE}`);
    expect(text).toContain("-seeded-");
  });

  it("makes paths of its own, one per request", () => {
    const a = requestPath("follow");
    expect(a.startsWith(`${REQUEST_PREFIX}follow-`)).toBe(true);
    expect(requestPath("seeded").startsWith(`${REQUEST_PREFIX}seeded-`)).toBe(true);
    expect(requestPath("follow")).not.toBe(a);
  });

  it("counts the lines of `opscrew logs`, not its first line", () => {
    const output = [
      "The oldest line here is from 2026-10-28 10:00 UTC. Each deploy starts new containers.",
      "2026-10-28T10:00:01.123456789Z app opscrew-e2e request GET /opscrew-e2e-follow-1",
      "2026-10-28T10:00:02Z edge something",
      "→ Reading the lines",
    ].join("\n");
    expect(logLines(output)).toHaveLength(2);
  });
});

describe("statusFigures", () => {
  const server = [
    "Components:",
    "  web: running",
    "",
    "Resources (read now):",
    "  Server: load 0.12, 0.10, 0.05 (1, 5 and 15 minutes) on 2 CPUs; memory 1.2 GB used of 3.7 GB; disk 9.1 GB used, 28.0 GB free of 38.1 GB (25% full)",
    "  Web process: CPU 0.3%, memory 120 MB of 512 MB (23%), 0 restarts, started 5 minutes ago",
    "  Postgres: CPU 0.1%, memory 40 MB of 256 MB (16%), 0 restarts, started 5 minutes ago",
    "  Warning: The server's disk is 87% full (5 GB free). When it is full, …",
    "",
    "Scheduled check (.github/workflows/opscrew-check.yml, read from GitHub now):",
    "  State: on",
  ].join("\n");

  it("reads the server's line, each part's line and the flags", () => {
    const figures = statusFigures(server);
    expect(figures?.server).toContain("load 0.12");
    expect(figures?.parts).toHaveLength(2);
    expect(figures?.flags).toEqual([expect.stringContaining("disk is 87% full")]);
    expect(figureProblems(figures, "server")).toEqual([]);
  });

  it("names what a target's figures miss", () => {
    expect(figureProblems(undefined, "server")).toEqual([
      expect.stringContaining("no resource figures"),
    ]);
    const portainer = statusFigures(
      [
        "Resources (read now):",
        "  Server: 2 CPUs; memory 3.7 GB",
        "  Web process: CPU 0.3%, memory 120 MB of 512 MB (23%), 0 restarts, started 1 hour ago",
        "  Not available: the host's disk (Portainer's API does not give it)",
      ].join("\n"),
    );
    expect(figureProblems(portainer, "portainer")).toEqual([]);
    expect(figureProblems(portainer, "server")).toEqual([
      expect.stringContaining("load"),
      expect.stringContaining("memory used"),
      expect.stringContaining("disk"),
    ]);
    expect(figureProblems(portainer, "local")).toEqual([]);
    const worker = statusFigures(
      [
        "Resources (read now):",
        "  The Worker (last 24 hours): 12 requests (0% of Workers Free's 100,000 a day), 0 errors; CPU time …",
        "  Requests served from the site's files run no code, so they are not counted.",
      ].join("\n"),
    );
    expect(figureProblems(worker, "worker")).toEqual([]);
    expect(figureProblems(worker, "portainer")).toEqual([
      expect.stringContaining("no part"),
      expect.stringContaining("host's disk"),
    ]);
  });
});

describe("the disk fill", () => {
  const df = [
    "Filesystem     1-blocks        Used   Available Capacity Mounted on",
    "/dev/sda1   40000000000 10000000000 28000000000      27% /",
  ].join("\n");

  it("is what takes the disk to the percentage the check reads (used of used and free)", () => {
    const bytes = fillBytes(df, 87);
    expect(bytes).toBe(Math.ceil(0.87 * 38_000_000_000) - 10_000_000_000);
    const used = 10_000_000_000 + bytes;
    expect(Math.ceil((used * 100) / 38_000_000_000)).toBe(87);
    expect(fillBytes(df, 20)).toBe(0);
    expect(() => fillBytes("nothing", 87)).toThrow(/df/);
  });
});

describe("ntfy", () => {
  it("polls the topic since a time and keeps only its messages", () => {
    expect(ntfyPollUrl(TOPIC, 1_700_000_000)).toBe(
      `https://ntfy.sh/${TOPIC}/json?poll=1&since=1700000000`,
    );
    const body = [
      JSON.stringify({ id: "a", time: 1, event: "open", topic: TOPIC }),
      JSON.stringify({
        id: "b",
        time: 2,
        event: "message",
        title: "OpsCrew check: x",
        message: "y",
      }),
      JSON.stringify({ id: "c", time: 3, event: "message", message: "no title" }),
      "",
    ].join("\n");
    expect(ntfyMessages(body)).toEqual([
      { time: 2, title: "OpsCrew check: x", message: "y" },
      { time: 3, title: "", message: "no title" },
    ]);
  });
});

describe("the check's issues", () => {
  it("reads an issue's key and how long it lasted", () => {
    expect(issueKey("<!-- opscrew-check:app/prod/https/e2e.example.com -->\nThe app …")).toBe(
      "app/prod/https/e2e.example.com",
    );
    expect(issueKey(null)).toBeUndefined();
    expect(resolvedAfter(["What fails changed.", "Resolved after 4 minutes."])).toBe("4 minutes");
    expect(resolvedAfter(["Closed while the check is paused."])).toBeUndefined();
  });

  it("bills each job by the started minute and projects a month at the interval", () => {
    expect(
      billedMinutes([
        { startedAt: "2026-10-28T10:00:00Z", completedAt: "2026-10-28T10:00:20Z" },
        { startedAt: "2026-10-28T10:00:00Z", completedAt: "2026-10-28T10:01:01Z" },
        { startedAt: "2026-10-28T10:00:00Z", completedAt: "2026-10-28T10:00:00Z" },
      ]),
    ).toBe(1 + 2 + 1);
    expect(monthlyRuns(60)).toBe(720);
    expect(monthlyRuns(15)).toBe(2880);
  });
});

describe("Grafana Cloud's queries", () => {
  it("queries the stack where it receives", () => {
    const loki = new URL(
      lokiQueryUrl("https://logs-prod-012.grafana.net/loki/api/v1/push", '{app="a"}', 1_000),
    );
    expect(loki.origin + loki.pathname).toBe(
      "https://logs-prod-012.grafana.net/loki/api/v1/query_range",
    );
    expect(loki.searchParams.get("query")).toBe('{app="a"}');
    expect(loki.searchParams.get("start")).toBe("1000000000");
    const prom = new URL(
      prometheusQueryUrl("https://prometheus-prod-24.grafana.net/api/prom/push", "count(up)"),
    );
    expect(prom.origin + prom.pathname).toBe(
      "https://prometheus-prod-24.grafana.net/api/prom/api/v1/query",
    );
    expect(prom.searchParams.get("query")).toBe("count(up)");
  });

  it("reads their answers", () => {
    expect(
      lokiStreams({
        data: {
          result: [
            {
              stream: { app: "a", env: "prod", service: "web" },
              values: [
                ["1", "x"],
                ["2", "y"],
              ],
            },
          ],
        },
      }),
    ).toEqual([{ labels: { app: "a", env: "prod", service: "web" }, lines: ["x", "y"] }]);
    expect(lokiStreams({ status: "error" })).toEqual([]);
    expect(
      promVector({ data: { result: [{ metric: { __name__: "node_load1" }, value: [1, "3"] }] } }),
    ).toEqual([{ metric: { __name__: "node_load1" }, value: 3 }]);
  });
});

describe("the add-ons", () => {
  it("lists what is left of an add-on, by kind, never the names", () => {
    const command = addonLeftoverCommand("opscrew-beszel", ["/home/deploy/opscrew/addons/beszel"]);
    expect(command).toContain("label=com.docker.compose.project=opscrew-beszel");
    expect(command).toContain("/home/deploy/opscrew/addons/beszel");
    expect(addonLeftovers("")).toEqual([]);
    expect(
      addonLeftovers(
        "container abc\ncontainer def\nvolume v1\npath /home/deploy/opscrew/addons/beszel\n",
      ),
    ).toEqual(["2 containers", "1 volume", "/home/deploy/opscrew/addons/beszel"]);
  });

  it("reads Docker's memory use against the limit", () => {
    expect(memoryUsage("12.5MiB / 128MiB")).toEqual({
      usedBytes: 12.5 * 1024 ** 2,
      limitBytes: 128 * 1024 ** 2,
    });
    expect(memoryUsage("1.2GiB / 2GiB")?.limitBytes).toBe(2 * 1024 ** 3);
    expect(memoryUsage("12kB / 1MB")).toEqual({ usedBytes: 12_000, limitBytes: 1_000_000 });
    expect(memoryUsage("nothing")).toBeUndefined();
  });
});
