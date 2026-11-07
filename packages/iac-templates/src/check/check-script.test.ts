import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_COMMAND,
  type CheckConfig,
  type CheckEnvironment,
  type CheckIo,
  run,
  type ServerEntry,
  type ServerReach,
  scheduledFailed,
  scheduledLog,
  sshRead,
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

/** The app server's entry in the server secret's list. */
const APP_ENTRY: ServerEntry = { id: "app", ...REACH };

/** An extra server's entry, at its private address. */
const DATA_ENTRY: ServerEntry = {
  id: "data",
  host: "10.200.4.2",
  port: 22,
  user: "deploy",
  knownHosts:
    "10.200.4.2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDATADATADATADATADATADATADATADATADATADATADATA",
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
  /** A pull request, which GitHub lists with the issues. */
  pullRequest?: boolean;
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
  pagesRead: number[] = [];
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
      pullRequest: true,
    });
  }

  /** Each host answers `replies` in turn, the last one again and again. */
  answer(hostname: string, ...replies: HostReply[]): void {
    this.hosts.set(hostname, replies);
  }

  open(): FakeIssue[] {
    return this.issues.filter((issue) => issue.state === "open" && !issue.pullRequest);
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
      local: async () => this.localDisk,
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
    const list = /^\/issues\?labels=opscrew-check&state=open&per_page=100&page=(\d+)$/.exec(path);
    if (method === "GET" && list !== null) {
      if (this.issuesGone) return json({ message: "Issues are disabled" }, 410);
      const page = Number(list[1]);
      this.pagesRead.push(page);
      return json(
        this.issues
          .filter((i) => i.state === "open")
          .slice((page - 1) * 100, page * 100)
          .map(({ pullRequest, ...i }) => ({ ...i, ...(pullRequest ? { pull_request: {} } : {}) })),
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
    OPSCREW_CHECK_SERVER: JSON.stringify([APP_ENTRY]),
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
    // CHECK_COMMAND's line after df's, which an older OpsCrew's key (only df) never prints.
    "scheduled",
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
    expect(world.sshCalls).toEqual([{ server: APP_ENTRY, key: SECRETS.sshKey }]);
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
    expect(masks).toContain(`::add-mask::${JSON.stringify([APP_ENTRY])}`);
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
      expect(world.sshCalls).toEqual([{ server: APP_ENTRY, key: SECRETS.sshKey }]);
      expect(world.open()).toHaveLength(1);
    });

    it("reads an extra server's disk from the app server's runner, by its entry in the list", async () => {
      const world = new World();
      world.config = config({
        environments: [
          {
            ...OWN,
            extraServers: [
              {
                id: "hetzner-example-app-data",
                name: "data",
                secret: "OPSCREW_CHECK_SERVER",
                via: "runner-host",
              },
            ],
          },
        ],
      });
      world.disks.set(DATA_ENTRY.host, df(96));
      world.localDisk = df(10);
      const secret = JSON.stringify([DATA_ENTRY]);
      expect(
        await run(
          env({ OPSCREW_CHECK_SERVER: secret }),
          world.io(["--only", "disk:hetzner-example-app-data"]),
        ),
      ).toBe(0);
      expect(world.sshCalls).toEqual([{ server: DATA_ENTRY, key: SECRETS.sshKey }]);
      expect(world.open().map((issue) => issue.title)).toEqual([
        "OpsCrew check: example-app (prod) disk over 95% full on hetzner-example-app-data",
      ]);
      const masks = world.logs.filter((line) => line.startsWith("::add-mask::"));
      expect(masks).toContain(`::add-mask::${DATA_ENTRY.host}`);
      expect(masks).toContain(`::add-mask::${DATA_ENTRY.knownHosts}`);
    });

    it("refuses a server check.json doesn't list", async () => {
      const world = new World();
      expect(await run(env(), world.io(["--only", "disk:other"]))).toBe(1);
      expect(world.logs.at(-1)).toContain("--only takes disk:<server id>");
    });
  });

  it("reads every page of open issues, and opens no duplicate of an issue past the first 100", async () => {
    const world = new World();
    // 160 other open items with the label: pull requests, and issues without a marker.
    for (let n = 2; n <= 161; n++) {
      world.issues.push({
        number: n,
        title: `Something else ${n}`,
        body: "Not the check's.",
        state: "open",
        created_at: START.toISOString(),
        labels: ["opscrew-check"],
        comments: [],
        pullRequest: n % 2 === 0,
      });
    }
    world.answer("example.com", 503);
    await run(env(), world.io());
    expect(world.pagesRead).toEqual([1, 2]);
    const opened = world.issues.filter((issue) => issue.body.includes("opscrew-check:"));
    expect(opened.map((issue) => issue.number)).toEqual([1, 162]);

    // The check's issue is now the 162nd open item, on the second page.
    world.pagesRead = [];
    world.later(15);
    await run(env(), world.io());
    expect(world.pagesRead).toEqual([1, 2]);
    expect(world.issues).toHaveLength(162);
    expect(world.issues[161]?.comments).toEqual([]);

    world.answer("example.com", 200);
    await run(env(), world.io());
    expect(world.issues[161]?.state_reason).toBe("completed");
  });

  it("reads one page when it holds fewer than 100", async () => {
    const world = new World();
    await run(env(), world.io());
    expect(world.pagesRead).toEqual([1]);
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

  it("skips a server the secret's list has no entry for, and a secret that is no list", async () => {
    for (const secret of [JSON.stringify([DATA_ENTRY]), JSON.stringify(REACH)]) {
      const world = new World();
      await run(env({ OPSCREW_CHECK_SERVER: secret }), world.io());
      expect(world.sshCalls).toEqual([]);
      expect(world.logs).toContainEqual(
        expect.stringContaining(
          "the secret OPSCREW_CHECK_SERVER is missing, has no entry for the server app or is not in the form OpsCrew writes",
        ),
      );
    }
  });
});

/**
 * The lines CHECK_COMMAND prints about `app`'s scheduled snapshots, after `df`'s, for a log of
 * `lines` (the real shell's are checked against {@link scheduledLog} below).
 */
function scheduled(app: string, at: Date, lines: readonly string[], running = false): string {
  const { id, after } = scheduledLog(lines);
  return [
    `scheduled ${app} at ${Math.floor(at.getTime() / 1000)}`,
    ...(id === undefined ? [] : [`scheduled ${app} id ${id}`]),
    `scheduled ${app} after ${after.length}`,
    ...(running ? [`scheduled ${app} running`] : []),
    "",
  ].join("\n");
}

describe("scheduled snapshots", () => {
  const ID = "20261028T030000Z";
  const RAN = new Date("2026-10-28T03:04:00.000Z");
  const SCHEDULED: CheckEnvironment = {
    ...PROD,
    snapshots: { app: "example-app", servers: ["hetzner-example-app"] },
  };
  const KEY = "example-app/prod/snapshot/hetzner-example-app";

  it("reads a log's last id and the lines after it, and fails unless nothing follows the id", () => {
    const failed = (lines: string[]) => {
      const { id, after } = scheduledLog(lines);
      return scheduledFailed({ ...(id === undefined ? {} : { id }), after: after.length });
    };
    expect(scheduledLog(["web was left out of the scheduled snapshot", ID])).toEqual({
      id: ID,
      after: [],
    });
    expect(failed(["web was left out of the scheduled snapshot", ID])).toBe(false);
    expect(failed([ID, "  ", ""])).toBe(false);
    expect(scheduledLog(["web was left out", "", "OpsCrew took no snapshot."])).toEqual({
      after: ["web was left out", "OpsCrew took no snapshot."],
    });
    expect(failed(["web was left out", "OpsCrew took no snapshot."])).toBe(true);
    expect(failed([])).toBe(true);
    expect(scheduledLog([ID, "the upload failed", "  exit 1 "])).toEqual({
      id: ID,
      after: ["the upload failed", "  exit 1 "],
    });
    expect(failed([ID, "the upload failed"])).toBe(true);
    // An older run's id further up: the last id counts.
    expect(failed(["20261021T030000Z", "failed", ID])).toBe(false);
  });

  it("opens an issue for a failed scheduled snapshot, changes it when only the copy off the server fails, and closes it once one succeeds", async () => {
    const world = new World();
    world.config = config({ environments: [SCHEDULED] });
    world.disks.set(SERVER_HOST, `${df(40)}${scheduled("example-app", RAN, ["no space"])}`);
    expect(await run(env(), world.io())).toBe(0);
    // One read for the disk and the snapshot.
    expect(world.sshCalls).toHaveLength(1);
    const [issue] = world.open();
    expect(issue?.title).toBe(
      "OpsCrew check: example-app (prod) scheduled snapshot failed on hetzner-example-app",
    );
    expect(issue?.body).toContain(`<!-- opscrew-check:${KEY} -->`);
    expect(issue?.body).toContain(
      "The last scheduled snapshot of example-app on the server hetzner-example-app failed, at 2026-10-28 03:04 UTC: OpsCrew took no snapshot.",
    );
    expect(issue?.body).toContain("run `npx opscrew status` in this repository");

    world.disks.set(
      SERVER_HOST,
      `${df(40)}${scheduled("example-app", RAN, [ID, "the upload failed"])}`,
    );
    await run(env(), world.io());
    expect(issue?.title).toBe(
      "OpsCrew check: example-app (prod) scheduled snapshot's off-server copy failed on hetzner-example-app",
    );
    expect(issue?.comments).toEqual([
      expect.stringContaining(
        `The scheduled snapshot ${ID} of example-app, due at 2026-10-28 03:00 UTC, was taken on the server hetzner-example-app, but its copy off the server failed, at 2026-10-28 03:04 UTC.`,
      ),
    ]);

    // While one is being taken, the issue stays as it is.
    world.disks.set(SERVER_HOST, `${df(40)}${scheduled("example-app", RAN, [], true)}`);
    await run(env(), world.io());
    expect(world.open()).toEqual([issue]);
    expect(world.summaries.at(-1)).toContain(`- ${KEY}: not checked (see the log)`);

    world.disks.set(SERVER_HOST, `${df(40)}${scheduled("example-app", RAN, [ID])}`);
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    expect(issue?.state_reason).toBe("completed");
    expect(world.summaries.at(-1)).toContain(`- ${KEY}: passed`);
  });

  it("reads only its app's lines, and counts a server without its log as not checked", async () => {
    const world = new World();
    world.config = config({ environments: [SCHEDULED] });
    world.disks.set(SERVER_HOST, `${df(40)}${scheduled("example-app-admin", RAN, ["failed"])}`);
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    expect(world.logs).toContain(
      "hetzner-example-app: no scheduled snapshot of example-app is recorded there yet.",
    );
    expect(world.summaries.at(-1)).toContain(`- ${KEY}: not checked (see the log)`);
    expect(world.summaries.at(-1)).toContain("- example-app/prod/disk/hetzner-example-app: passed");
  });

  it("says why a server whose check key predates the snapshot check is not checked", async () => {
    const world = new World();
    world.config = config({ environments: [SCHEDULED] });
    // An older OpsCrew's key line runs only df.
    world.disks.set(SERVER_HOST, df(40).replace("scheduled\n", ""));
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    expect(world.logs).toContain(
      "::warning::The server hetzner-example-app was set up before the scheduled check read snapshots: its check key reads only the disk, so its scheduled snapshots are not checked. `npx opscrew provision` gives the app's server and the servers you own the new key line; another server OpsCrew created gets it when it is created again.",
    );
    expect(world.summaries.at(-1)).toContain(`- ${KEY}: not checked (see the log)`);
    expect(world.summaries.at(-1)).toContain("- example-app/prod/disk/hetzner-example-app: passed");
  });

  it("reads a server once for its disk and every environment's snapshots on it, extra servers included", async () => {
    const world = new World();
    const data = {
      id: "hetzner-example-app-data",
      name: "data",
      secret: "OPSCREW_CHECK_SERVER",
      via: "github",
    } as const;
    world.config = config({
      environments: [
        {
          ...PROD,
          extraServers: [data],
          snapshots: { app: "example-app", servers: ["hetzner-example-app", data.id] },
        },
        // Staging on the same server: prod checks its disk, staging only its snapshots.
        {
          key: "example-app/staging",
          hosts: [{ hostname: "staging.example.com", healthPath: "/health" }],
          snapshots: { app: "example-app-staging", servers: ["hetzner-example-app"] },
        },
      ],
    });
    world.disks.set(
      SERVER_HOST,
      `${df(40)}${scheduled("example-app", RAN, [ID])}${scheduled("example-app-staging", RAN, ["failed"])}`,
    );
    world.disks.set(DATA_ENTRY.host, `${df(40)}${scheduled("example-app", RAN, ["failed"])}`);
    await run(env({ OPSCREW_CHECK_SERVER: JSON.stringify([APP_ENTRY, DATA_ENTRY]) }), world.io());
    expect(world.sshCalls.map((call) => call.server)).toEqual([APP_ENTRY, DATA_ENTRY]);
    expect(world.open().map((issue) => issue.title)).toEqual([
      "OpsCrew check: example-app (prod) scheduled snapshot failed on hetzner-example-app-data",
      "OpsCrew check: example-app (staging) scheduled snapshot failed on hetzner-example-app",
    ]);
  });

  it("checks the snapshots of a server with its own runner in that runner's job only", async () => {
    const world = new World();
    world.config = config({
      environments: [
        {
          ...PROD,
          server: { id: "own-example-app", via: "own-runner" },
          snapshots: { app: "example-app", servers: ["own-example-app"] },
        },
      ],
    });
    world.localDisk = `${df(40)}${scheduled("example-app", RAN, ["failed"])}`;
    await run(env(), world.io());
    expect(world.open()).toEqual([]);
    await run(env(), world.io(["--only", "disk:own-example-app"]));
    expect(world.open().map((issue) => issue.title)).toEqual([
      "OpsCrew check: example-app (prod) scheduled snapshot failed on own-example-app",
    ]);
  });

  it("never lets what the log says reach any text", async () => {
    const world = new World();
    world.config = webhookConfig("slack");
    world.config.environments = [SCHEDULED];
    const said = `upload to https://${SERVER_HOST}/bucket failed: ${SECRETS.inBody}`;
    world.disks.set(SERVER_HOST, `${df(40)}${scheduled("example-app", RAN, [ID, said])}`);
    await run(env(), world.io());
    expect(world.open()).toHaveLength(1);
    expect(world.posts).toHaveLength(1);
    const texts = world.texts().join("\n");
    for (const value of [SECRETS.inBody, SERVER_HOST, "upload to", "bucket"]) {
      expect(texts).not.toContain(value);
    }
  });
});

/** True when `program` runs in sh here. */
function inShell(program: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${program}`]).status === 0;
}

describe.skipIf(!inShell("stat") || !inShell("tail"))("CHECK_COMMAND in a real shell", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("prints df, then each app's log time, last id, the number of lines after it and whether a snapshot is being taken, never the log's text, and the check reads them", async () => {
    expect(CHECK_COMMAND).not.toContain('"');
    // The id line `snapshot.sh` prints once the snapshot is taken.
    const ID_LINE = "20261028T030000Z";
    const secret = SECRETS.inBody;
    dir = await mkdtemp(join(tmpdir(), "opscrew-check-command-"));
    const write = async (path: string, text: string) => {
      await mkdir(join(dir as string, path, ".."), { recursive: true });
      await writeFile(join(dir as string, path), text);
    };
    const logs: Record<string, string[]> = {
      // Taken: an older run's id further up, and lines with shell characters before the last id.
      "example-app": [
        "20261021T030000Z",
        ...Array.from({ length: 60 }, (_, n) => `line ${n} * $HOME`),
        ID_LINE,
        "",
      ],
      // Taken, but its copy off the server failed.
      shop: ["web was left out", ID_LINE, `upload failed: ${secret}`, "  ", "exit 1"],
      // Not taken, and one being taken now.
      blog: ["web was left out", `failed: ${secret}`],
    };
    for (const [app, lines] of Object.entries(logs)) {
      await write(`apps/${app}/.snapshots/scheduled.log`, `${lines.join("\n")}\n`);
    }
    await mkdir(join(dir, "apps/blog/.snapshots/20261028T030000Z.partial"), { recursive: true });
    await write("apps/Odd name/.snapshots/scheduled.log", "failed\n");
    await mkdir(join(dir, "apps/no-log"), { recursive: true });
    // A stand-in for flock: the start lock is held.
    await write("bin/flock", "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", join(dir, "bin/flock")]);
    // The folder as the shell names it.
    const root = spawnSync("sh", ["-c", 'cd "$1" && pwd', "sh", dir], {
      encoding: "utf8",
    }).stdout.trim();
    const command = `PATH=${root}/bin:$PATH; ${CHECK_COMMAND.replaceAll("/srv/apps", `${root}/apps`)}`;
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout.split("\n");
    expect(out[0]).toMatch(/^Filesystem/);
    expect(out).toContain("scheduled");
    // Only folders with OpsCrew's app names are read, and nothing a log says is printed.
    for (const text of ["Odd", "line ", "left out", "failed", "exit", secret]) {
      expect(result.stdout).not.toContain(text);
    }
    // Each app's lines are what scheduledLog reads of its log.
    for (const [app, lines] of Object.entries(logs)) {
      const printed = out.filter((line) => line.startsWith(`scheduled ${app} `));
      expect(printed[0]).toMatch(new RegExp(`^scheduled ${app} at \\d+$`));
      const expected = scheduled(app, new Date(0), lines, app === "blog").split("\n");
      expect(printed.slice(1)).toEqual(expected.slice(1, -1));
    }
    expect(out).toContain("scheduled shop after 2");

    // The check reads that answer: the disk, a success, a failed copy and a snapshot being taken.
    const world = new World();
    const on = (key: string, app: string, hostname: string): CheckEnvironment => ({
      key,
      hosts: [{ hostname, healthPath: "/" }],
      snapshots: { app, servers: ["hetzner-example-app"] },
    });
    world.config = config({
      environments: [
        { ...PROD, snapshots: { app: "example-app", servers: ["hetzner-example-app"] } },
        on("shop/prod", "shop", "shop.example.com"),
        on("blog/prod", "blog", "blog.example.com"),
      ],
    });
    world.disks.set(SERVER_HOST, result.stdout);
    await run(env(), world.io());
    const summary = world.summaries.at(-1) ?? "";
    expect(summary).toContain("- example-app/prod/disk/hetzner-example-app: passed");
    expect(summary).toContain("- example-app/prod/snapshot/hetzner-example-app: passed");
    expect(summary).toContain(
      `- shop/prod/snapshot/hetzner-example-app: failed: The scheduled snapshot ${ID_LINE} of shop`,
    );
    expect(summary).toContain(
      "- blog/prod/snapshot/hetzner-example-app: not checked (see the log)",
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

describe.skipIf(process.platform === "win32")("sshRead", () => {
  let dir: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("runs ssh with the key and known hosts in 0600 files under RUNNER_TEMP, removed afterwards", async () => {
    dir = await mkdtemp(join(tmpdir(), "opscrew-sshread-"));
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

    expect(await sshRead(REACH, SECRETS.sshKey)).toContain("/dev/sda1 100 40 60 40% /");
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
