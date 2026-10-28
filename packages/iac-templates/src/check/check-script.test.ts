import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CheckConfig,
  type CheckEnvironment,
  type CheckIo,
  run,
  type ServerReach,
  sshDf,
} from "../../check/check.mjs";
import { readCheckScript } from "../../scripts/gen-modules";

const REPOSITORY = "example-org/example-app";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SERVER_HOST = "203.0.113.10";
const START = new Date("2026-10-28T12:00:00.000Z");

/** The test's secrets, made at run time so no secret-shaped literal is committed. */
const SECRETS = {
  token: fakeSecret("github-token", "check"),
  sshKey: fakeSecret("private-key-pem", "check"),
  webhook: `https://hooks.example.com/opscrew/${fakeSecret("generic-password", "webhook")}`,
  ntfyToken: fakeSecret("generic-password", "ntfy"),
  inBody: fakeSecret("stripe-live-key", "body"),
};

const REACH: ServerReach = {
  host: SERVER_HOST,
  port: 2222,
  user: "deploy",
  knownHosts: `[${SERVER_HOST}]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`,
};

const PROD: CheckEnvironment = {
  key: "example-app/prod",
  hosts: [{ hostname: "example.com", healthPath: "/health" }],
  server: { id: "hetzner-example-app", secret: "OPSCREW_CHECK_SERVER", via: "github" },
};

function config(o: Partial<CheckConfig> = {}): CheckConfig {
  return {
    version: 1,
    intervalMinutes: 15,
    thresholds: {
      diskWarn: 85,
      diskHigh: 95,
      certDays: 14,
      tries: 3,
      retrySeconds: 30,
      timeoutSeconds: 10,
    },
    public: true,
    environments: [PROD],
    ...o,
  };
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason?: string;
  created_at: string;
  labels: string[];
  comments: string[];
}

/** What a checked host answers: a status, a status with a body, no answer in time, or an error. */
type HostReply =
  | number
  | { status: number; body: string; headers?: Record<string, string> }
  | "timeout"
  | { code: string };

/** A repository on a fake GitHub, the checked hosts, the servers' disks and the webhook. */
class World {
  issues: FakeIssue[] = [];
  labels = new Set<string>();
  hasIssues = true;
  issuesGone = false;
  private = false;
  lastCommit = "2026-10-20T12:00:00.000Z";
  failCreate = false;
  hosts = new Map<string, HostReply[]>();
  certDays = new Map<string, number | Error>();
  disks = new Map<string, string | Error>();
  localDisk = "";
  posts: { headers: Record<string, string>; body: string }[] = [];
  logs: string[] = [];
  summaries: string[] = [];
  sleeps: number[] = [];
  sshCalls: { server: ServerReach; key: string }[] = [];
  hostRequests: string[] = [];
  clock = START;
  config = config();

  constructor() {
    // A pull request with the label and a marker is never taken for an issue.
    this.issues.push({
      number: 1,
      title: "A pull request",
      body: "<!-- opscrew-check:example-app/prod/https/example.com -->",
      state: "open",
      created_at: START.toISOString(),
      labels: ["opscrew-check"],
      comments: [],
    });
  }

  /** Each host answers `replies` in turn, the last one again and again. */
  answer(hostname: string, ...replies: HostReply[]): void {
    this.hosts.set(hostname, replies);
  }

  open(): FakeIssue[] {
    return this.issues.filter((issue) => issue.state === "open" && issue.number !== 1);
  }

  later(minutes: number): void {
    this.clock = new Date(this.clock.getTime() + minutes * 60_000);
  }

  io(argv: string[] = []): CheckIo {
    return {
      config: this.config,
      argv,
      fetch: (async (input: string | URL, init?: RequestInit) =>
        this.fetch(String(input), init ?? {})) as typeof fetch,
      tlsDaysLeft: async (hostname) => {
        const days = this.certDays.get(hostname) ?? 60;
        if (days instanceof Error) throw days;
        return days;
      },
      ssh: async (server, key) => {
        this.sshCalls.push({ server, key });
        const disk = this.disks.get(server.host) ?? df(40);
        if (disk instanceof Error) throw disk;
        return disk;
      },
      df: async () => this.localDisk,
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.clock = new Date(this.clock.getTime() + ms);
      },
      now: () => this.clock,
      log: (line) => this.logs.push(line),
      summary: async (text) => {
        this.summaries.push(text);
      },
    };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    if (url === SECRETS.webhook) {
      this.posts.push({ headers, body: String(init.body) });
      return new Response(null, { status: 200 });
    }
    if (url.startsWith(API)) {
      expect(headers.authorization).toBe(`Bearer ${SECRETS.token}`);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      return this.github(init.method ?? "GET", url.slice(API.length), body);
    }
    const { hostname } = new URL(url);
    this.hostRequests.push(url);
    const queue = this.hosts.get(hostname) ?? [200];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as HostReply;
    if (reply === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (typeof reply === "object" && "code" in reply) {
      // Node's own message names the address; only the code may reach any text.
      const cause = Object.assign(new Error(`connect ${reply.code} ${SERVER_HOST}:443`), {
        code: reply.code,
      });
      throw new TypeError("fetch failed", { cause });
    }
    if (typeof reply === "number") return new Response("ok", { status: reply });
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }

  private github(method: string, path: string, body: Record<string, unknown>): Response {
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const issue = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    if (method === "GET" && path === "") {
      return json({ has_issues: this.hasIssues, private: this.private, default_branch: "main" });
    }
    if (method === "GET" && path === "/commits/main") {
      return json({ commit: { committer: { date: this.lastCommit } } });
    }
    if (method === "POST" && path === "/labels") {
      if (this.labels.has(String(body.name))) return json({ message: "exists" }, 422);
      this.labels.add(String(body.name));
      return json({}, 201);
    }
    if (method === "GET" && path === "/issues?labels=opscrew-check&state=open&per_page=100") {
      if (this.issuesGone) return json({ message: "Issues are disabled" }, 410);
      return json(
        this.issues
          .filter((i) => i.state === "open")
          .map((i) => ({ ...i, ...(i.number === 1 ? { pull_request: {} } : {}) })),
      );
    }
    if (method === "POST" && path === "/issues") {
      if (this.failCreate) return json({ message: "boom" }, 500);
      const created: FakeIssue = {
        number: this.issues.length + 1,
        title: String(body.title),
        body: String(body.body),
        state: "open",
        created_at: this.clock.toISOString(),
        labels: body.labels as string[],
        comments: [],
      };
      this.issues.push(created);
      return json({ number: created.number }, 201);
    }
    const found = this.issues.find((i) => i.number === Number(issue?.[1]));
    if (found !== undefined && method === "POST" && issue?.[2] !== undefined) {
      found.comments.push(String(body.body));
      return json({}, 201);
    }
    if (found !== undefined && method === "PATCH") {
      Object.assign(found, body);
      return json({});
    }
    throw new Error(`The fake GitHub has no ${method} ${path}.`);
  }

  /** Every text a person can read: issues, comments, webhook posts, the summary and the log. */
  texts(): string[] {
    return [
      ...this.issues.flatMap((issue) => [issue.title, issue.body, ...issue.comments]),
      ...this.posts.map((post) => `${JSON.stringify(post.headers)} ${post.body}`),
      ...this.summaries,
      ...this.logs.filter((line) => !line.startsWith("::add-mask::")),
    ];
  }
}

function env(o: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_TOKEN: SECRETS.token,
    GITHUB_REPOSITORY: REPOSITORY,
    OPSCREW_CHECK_PAUSED: "",
    OPSCREW_CHECK_SSH_KEY: SECRETS.sshKey,
    OPSCREW_CHECK_SERVER: JSON.stringify(REACH),
    OPSCREW_CHECK_WEBHOOK: SECRETS.webhook,
    ...o,
  };
}

/** `df -P -B1 /` output for a 40 GB disk `percent` full. */
function df(percent: number): string {
  const total = 40_000_000_000;
  const used = (total * percent) / 100;
  return [
    "Filesystem     1-blocks        Used   Available Capacity Mounted on",
    `/dev/sda1   ${total} ${used} ${total - used}      ${percent}% /`,
    "",
  ].join("\n");
}

function webhookConfig(webhook: CheckConfig["webhook"]): CheckConfig {
  return config({ webhook });
}

describe("check.mjs", () => {
  it("opens one issue when the app goes down, comments only on a change, and closes it with how long it lasted", async () => {
    const world = new World();
    expect(await run(env(), world.io())).toBe(0);
    expect(world.open()).toEqual([]);
    expect(world.labels.has("opscrew-check")).toBe(true);

    world.answer("example.com", 503);
    world.later(15);
    expect(await run(env(), world.io())).toBe(0);
    expect(world.sleeps).toEqual([30_000, 30_000]);
    expect(world.open()).toHaveLength(1);
    const [down] = world.open();
    expect(down?.title).toBe("OpsCrew check: example-app (prod) answers HTTP 503 on example.com");
    expect(down?.labels).toEqual(["opscrew-check"]);
    expect(down?.body).toContain("<!-- opscrew-check:example-app/prod/https/example.com -->");
    expect(down?.body).toContain(
      "https://example.com/health failed 3 tries, 30 seconds apart. The last try got HTTP 503.",
    );
    expect(down?.body).toContain("Since 2026-10-28 12:16 UTC.");

    // Still down the same way: nothing new.
    world.later(15);
    expect(await run(env(), world.io())).toBe(0);
    expect(world.open()).toHaveLength(1);
    expect(down?.comments).toEqual([]);

    // What fails changes (the connection is refused now): one comment and the new title. The
    // certificate failing too opens an issue of its own.
    world.answer("example.com", { code: "ECONNREFUSED" });
    world.certDays.set("example.com", 10);
    world.later(15);
    expect(await run(env(), world.io())).toBe(0);
    expect(down?.comments).toHaveLength(1);
    expect(down?.comments[0]).toContain("What fails changed.");
    expect(down?.comments[0]).toContain("The last try got the error ECONNREFUSED.");
    expect(down?.title).toBe("OpsCrew check: example-app (prod) does not answer on example.com");
    expect(world.open().map((issue) => issue.title)).toEqual([
      "OpsCrew check: example-app (prod) does not answer on example.com",
      "OpsCrew check: example-app (prod) certificate expires within 14 days on example.com",
    ]);

    world.answer("example.com", 200);
    world.certDays.set("example.com", 89);
    world.later(15);
    expect(await run(env(), world.io())).toBe(0);
    expect(world.open()).toEqual([]);
    expect(down?.state_reason).toBe("completed");
    // Opened at 12:16 and closed at 13:03: each failing run waits a minute between its tries.
    expect(down?.comments.at(-1)).toBe("Resolved after 47 minutes.");
  });

  it("opens nothing for one slow answer", async () => {
    const world = new World();
    world.answer("example.com", "timeout", 200);
    expect(await run(env(), world.io())).toBe(0);
    expect(world.sleeps).toEqual([30_000]);
    expect(world.open()).toEqual([]);
    expect(world.logs).toContain(
      "https://example.com/health: no answer within 10 seconds (try 1 of 3)",
    );
  });

  it("reports a certificate with 10 days left, and leaves it alone while the host can't be reached", async () => {
    const world = new World();
    world.certDays.set("example.com", 10);
    await run(env(), world.io());
    const [issue] = world.open();
    expect(issue?.title).toBe(
      "OpsCrew check: example-app (prod) certificate expires within 14 days on example.com",
    );
    expect(issue?.body).toContain("The certificate of example.com expires in 10 days.");
    expect(issue?.body).toContain("renewal is failing");

    world.certDays.set(
      "example.com",
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    );
    await run(env(), world.io());
    expect(world.open()).toEqual([issue]);
    expect(issue?.comments).toEqual([]);
  });

  it("reports a disk at 86% as a warning, then at 96% as high, over SSH with the check key", async () => {
    const world = new World();
    world.disks.set(SERVER_HOST, df(86));
    await run(env(), world.io());
    expect(world.sshCalls).toEqual([{ server: REACH, key: SECRETS.sshKey }]);
    const [issue] = world.open();
    expect(issue?.title).toBe(
      "OpsCrew check: example-app (prod) disk over 85% full on hetzner-example-app",
    );
    expect(issue?.body).toContain(
      "The disk of the server hetzner-example-app is 86% full: 5.6 GB free of 40.0 GB.",
    );
    expect(issue?.body).toContain("Old container images and logs usually fill it.");

    world.disks.set(SERVER_HOST, df(96));
    await run(env(), world.io());
    expect(issue?.title).toBe(
      "OpsCrew check: example-app (prod) disk over 95% full on hetzner-example-app",
    );
    expect(issue?.comments).toEqual([
      expect.stringContaining("is 96% full: 1.6 GB free of 40.0 GB."),
    ]);
  });

  it("skips paused and destroyed environments and closes their issues with the reason", async () => {
    const world = new World();
    world.config = config({
      environments: [
        PROD,
        {
          key: "example-app/staging",
          hosts: [{ hostname: "staging.example.com", healthPath: "/health" }],
        },
      ],
    });
    world.answer("example.com", 503);
    world.answer("staging.example.com", 503);
    await run(env(), world.io());
    expect(world.open()).toHaveLength(2);
    world.hostRequests = [];
    world.sshCalls = [];

    const paused = JSON.stringify({
      "example-app/prod": { reason: "retarget", since: START.toISOString() },
      "example-app/staging": { reason: "destroyed", since: START.toISOString() },
    });
    expect(await run(env({ OPSCREW_CHECK_PAUSED: paused }), world.io())).toBe(0);
    expect(world.hostRequests).toEqual([]);
    expect(world.sshCalls).toEqual([]);
    expect(world.open()).toEqual([]);
    const [prod, staging] = world.issues.slice(1);
    expect(prod?.state_reason).toBe("not_planned");
    expect(prod?.comments).toEqual([
      expect.stringContaining("OpsCrew is moving this app to another server"),
    ]);
    expect(staging?.comments).toEqual([
      expect.stringContaining("This environment was destroyed (`opscrew destroy`)"),
    ]);
  });

  it("closes an open issue whose key check.json no longer lists", async () => {
    const world = new World();
    world.config = config({
      environments: [
        PROD,
        { key: "docs/prod", hosts: [{ hostname: "docs.example.com", healthPath: "/" }] },
      ],
    });
    world.answer("docs.example.com", 500);
    await run(env(), world.io());
    expect(world.open()).toHaveLength(1);

    world.config = config();
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    expect(world.issues[1]?.comments).toEqual([
      "Closed: the check no longer checks this, as opscrew/check/check.json does not list it any more.",
    ]);
  });

  it("warns about GitHub's 60-day rule from day 50 in a public repository, and closes the warning after a newer commit", async () => {
    const world = new World();
    world.lastCommit = new Date(START.getTime() - 49 * 86_400_000).toISOString();
    await run(env(), world.io());
    expect(world.open()).toEqual([]);

    world.lastCommit = new Date(START.getTime() - 50 * 86_400_000).toISOString();
    await run(env(), world.io());
    const [issue] = world.open();
    expect(issue?.title).toBe(
      "OpsCrew check: GitHub turns this check off after 60 days without activity",
    );
    expect(issue?.body).toContain("<!-- opscrew-check:inactivity -->");
    expect(issue?.body).toContain("the last commit on main is 50 days old");
    expect(issue?.body).toContain("push any commit to main");
    expect(issue?.body).toContain('select "Enable workflow"');

    world.lastCommit = START.toISOString();
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    expect(issue?.state_reason).toBe("completed");
  });

  it("never warns about inactivity in a private repository", async () => {
    const world = new World();
    world.private = true;
    world.lastCommit = new Date(START.getTime() - 80 * 86_400_000).toISOString();
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
  });

  it.each([
    [
      "has_issues false",
      (world: World) => {
        world.hasIssues = false;
      },
    ],
    [
      "410 Gone",
      (world: World) => {
        world.issuesGone = true;
      },
    ],
  ])(
    "posts the webhook, writes the job summary and exits 1 when issues are off (%s)",
    async (_, off) => {
      const world = new World();
      world.config = webhookConfig("slack");
      off(world);
      world.answer("example.com", 502);
      expect(await run(env(), world.io())).toBe(1);
      expect(world.issues).toHaveLength(1);
      expect(world.posts).toHaveLength(1);
      expect(JSON.parse(world.posts[0]?.body ?? "").text).toContain(
        "OpsCrew check: example-app (prod) answers HTTP 502 on example.com",
      );
      expect(world.summaries.join("")).toContain("Issues are turned off in this repository");
      expect(world.summaries.join("")).toContain(
        "- example-app/prod/https/example.com: failed: https://example.com/health failed 3 tries",
      );
    },
  );

  describe("webhooks", () => {
    /** A health path long enough to pass every webhook's limit. */
    const LONG = `/${"a".repeat(5000)}`;

    function longWorld(webhook: CheckConfig["webhook"]): World {
      const world = new World();
      world.config = config({
        webhook,
        environments: [
          { key: "example-app/prod", hosts: [{ hostname: "example.com", healthPath: LONG }] },
        ],
      });
      world.answer("example.com", 500);
      return world;
    }

    it("posts Slack's text, cut at 4,000 characters, when an issue opens and closes", async () => {
      const world = longWorld("slack");
      await run(env(), world.io());
      world.answer("example.com", 200);
      world.later(5);
      await run(env(), world.io());
      const [opened, closed] = world.posts.map((post) => JSON.parse(post.body));
      expect(Object.keys(opened)).toEqual(["text"]);
      expect(opened.text).toHaveLength(4000);
      expect(opened.text.startsWith("OpsCrew check: example-app (prod) answers HTTP 500")).toBe(
        true,
      );
      expect(world.posts[0]?.headers["content-type"]).toBe("application/json");
      expect(closed.text).toBe(
        `OpsCrew check: resolved, example-app (prod), HTTPS on example.com\nResolved after 5 minutes.\nIssue #2 in ${REPOSITORY}.`,
      );
    });

    it("posts Discord's content, cut at 2,000 characters, with no mentions", async () => {
      const world = longWorld("discord");
      await run(env(), world.io());
      const body = JSON.parse(world.posts[0]?.body ?? "");
      expect(body.allowed_mentions).toEqual({ parse: [] });
      expect(body.content).toHaveLength(2000);
    });

    it("posts ntfy's body, cut at 4,096 bytes, with its title, priority and token", async () => {
      const world = longWorld("ntfy");
      await run(env({ OPSCREW_CHECK_NTFY_TOKEN: SECRETS.ntfyToken }), world.io());
      world.answer("example.com", 200);
      await run(env(), world.io());
      const [opened, closed] = world.posts;
      expect(Buffer.byteLength(opened?.body ?? "")).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(opened?.body ?? "")).toBeGreaterThan(4090);
      expect(opened?.headers).toEqual({
        title: "OpsCrew check: example-app (prod) answers HTTP 500 on example.com",
        priority: "4",
        authorization: `Bearer ${SECRETS.ntfyToken}`,
      });
      expect(closed?.headers).toEqual({
        title: "OpsCrew check: resolved, example-app (prod), HTTPS on example.com",
        priority: "3",
      });
    });

    it("says when a webhook fails, without its address", async () => {
      const world = new World();
      world.config = webhookConfig("slack");
      world.answer("example.com", 500);
      const io = world.io();
      const fetch = io.fetch;
      io.fetch = (async (input: string | URL, init?: RequestInit) =>
        String(input) === SECRETS.webhook
          ? new Response(null, { status: 404 })
          : fetch(input, init)) as typeof fetch;
      expect(await run(env(), io)).toBe(1);
      expect(world.logs).toContain("::error::The slack webhook failed (HTTP 404).");
      expect(world.texts().join("\n")).not.toContain(SECRETS.webhook);
    });
  });

  it("never lets a response's body or headers, an address or a secret reach any text, and masks the secrets", async () => {
    const world = new World();
    world.config = webhookConfig("ntfy");
    world.answer("example.com", {
      status: 500,
      body: `{"error":"db down","dsn":"${SECRETS.inBody}"}`,
      headers: { "x-debug": SECRETS.inBody },
    });
    world.disks.set(SERVER_HOST, df(97));
    await run(env({ OPSCREW_CHECK_NTFY_TOKEN: SECRETS.ntfyToken }), world.io());
    world.answer("example.com", { code: "ECONNREFUSED" });
    world.disks.set(SERVER_HOST, new Error(`ssh: connect to host ${SERVER_HOST} port 2222`));
    await run(env({ OPSCREW_CHECK_NTFY_TOKEN: SECRETS.ntfyToken }), world.io());
    expect(world.open()).toHaveLength(2);

    const texts = world.texts().join("\n");
    for (const value of [
      SECRETS.inBody,
      SECRETS.sshKey,
      SECRETS.webhook,
      SECRETS.token,
      SERVER_HOST,
      "db down",
    ]) {
      expect(texts).not.toContain(value);
    }
    // Only ntfy's own header carries its token.
    expect(texts.replaceAll(`"authorization":"Bearer ${SECRETS.ntfyToken}"`, "")).not.toContain(
      SECRETS.ntfyToken,
    );
    const masks = world.logs.filter((line) => line.startsWith("::add-mask::"));
    expect(masks).toContain(`::add-mask::${SECRETS.webhook}`);
    expect(masks).toContain(`::add-mask::${SECRETS.ntfyToken}`);
    expect(masks).toContain(`::add-mask::${SERVER_HOST}`);
    expect(masks).toContain(`::add-mask::${REACH.knownHosts}`);
    expect(masks).toContain(`::add-mask::${JSON.stringify(REACH)}`);
    for (const line of SECRETS.sshKey.split("\n").filter((l) => l.trim() !== "")) {
      expect(masks).toContain(`::add-mask::${line.trim()}`);
    }
  });

  describe("--only disk:<server id>", () => {
    const OWN: CheckEnvironment = {
      key: "example-app/prod",
      hosts: [{ hostname: "example.com", healthPath: "/health" }],
      server: { id: "own-example-app", via: "own-runner" },
    };

    it("checks only that server's disk, locally on its own runner, and manages only its key", async () => {
      const world = new World();
      world.config = config({ environments: [OWN] });
      world.answer("example.com", 503);
      await run(env(), world.io());
      // The main job leaves the disk of a server with its own runner to that runner's job.
      expect(world.sshCalls).toEqual([]);
      expect(world.open().map((issue) => issue.title)).toEqual([
        "OpsCrew check: example-app (prod) answers HTTP 503 on example.com",
      ]);
      world.hostRequests = [];

      world.answer("example.com", 200);
      world.localDisk = df(90);
      world.lastCommit = "2026-01-01T00:00:00.000Z";
      expect(await run(env(), world.io(["--only", "disk:own-example-app"]))).toBe(0);
      expect(world.hostRequests).toEqual([]);
      expect(world.open().map((issue) => issue.title)).toEqual([
        "OpsCrew check: example-app (prod) answers HTTP 503 on example.com",
        "OpsCrew check: example-app (prod) disk over 85% full on own-example-app",
      ]);
    });

    it("reads the disk of a runner machine's server over SSH", async () => {
      const world = new World();
      world.config = config({
        environments: [
          {
            ...PROD,
            server: { id: "own-example-app", secret: "OPSCREW_CHECK_SERVER", via: "runner-host" },
          },
        ],
      });
      world.disks.set(SERVER_HOST, df(99));
      await run(env(), world.io(["--only", "disk:own-example-app"]));
      expect(world.sshCalls).toEqual([{ server: REACH, key: SECRETS.sshKey }]);
      expect(world.open()).toHaveLength(1);
    });

    it("refuses a server check.json doesn't list", async () => {
      const world = new World();
      expect(await run(env(), world.io(["--only", "disk:other"]))).toBe(1);
      expect(world.logs.at(-1)).toContain("--only takes disk:<server id>");
    });
  });

  it("exits 1 when GitHub's API fails, naming only the status", async () => {
    const world = new World();
    world.failCreate = true;
    world.answer("example.com", 500);
    expect(await run(env(), world.io())).toBe(1);
    expect(world.logs).toContain("::error::GitHub's API answered HTTP 500 to POST /issues.");
  });

  it("skips a server whose secret is missing, and says which", async () => {
    const world = new World();
    await run(env({ OPSCREW_CHECK_SERVER: undefined }), world.io());
    expect(world.sshCalls).toEqual([]);
    expect(world.logs).toContainEqual(
      expect.stringContaining("the secret OPSCREW_CHECK_SERVER is missing"),
    );
  });
});

describe("check.mjs as the main module", () => {
  it("reads check.json next to it and runs with the real side effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-check-main-"));
    try {
      await writeFile(join(dir, "check.mjs"), readCheckScript());
      await writeFile(join(dir, "check.json"), JSON.stringify(config()));
      // Without GitHub's variables it stops before any request.
      const result = spawnSync(process.execPath, ["check.mjs"], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(
        "::error::GITHUB_TOKEN and GITHUB_REPOSITORY must be set: run the check in GitHub Actions.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("sshDf", () => {
  let dir: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("runs ssh with the key and known hosts in 0600 files under RUNNER_TEMP, removed afterwards", async () => {
    dir = await mkdtemp(join(tmpdir(), "opscrew-sshdf-"));
    const bin = join(dir, "bin");
    const temp = join(dir, "runner-temp");
    const record = join(dir, "record");
    await mkdir(bin);
    await mkdir(temp);
    // A stand-in for ssh: it records its arguments and the key files' modes, then prints a df table.
    await writeFile(
      join(bin, "ssh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${record}'`,
        `stat -c '%a' "$2" >> '${record}'`,
        `for a in "$@"; do case "$a" in UserKnownHostsFile=*) stat -c '%a' "\${a#UserKnownHostsFile=}" >> '${record}'; cat "\${a#UserKnownHostsFile=}" >> '${record}';; esac; done`,
        `echo 'Filesystem 1-blocks Used Available Capacity Mounted on'`,
        `echo '/dev/sda1 100 40 60 40% /'`,
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("RUNNER_TEMP", temp);

    expect(await sshDf(REACH, SECRETS.sshKey)).toContain("/dev/sda1 100 40 60 40% /");
    const lines = (await readFile(record, "utf8")).trim().split("\n");
    const keyFile = lines[1] ?? "";
    expect(keyFile.startsWith(join(temp, "opscrew-check-"))).toBe(true);
    expect(lines.slice(0, 15)).toEqual([
      "-i",
      keyFile,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${join(keyFile, "..", "known_hosts")}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-p",
      "2222",
      `deploy@${SERVER_HOST}`,
    ]);
    expect(lines.slice(15)).toEqual(["df", "600", "600", REACH.knownHosts]);
    expect(await readdir(temp)).toEqual([]);
  });
});
