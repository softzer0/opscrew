import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sinceAfter } from "@opscrew/connector-portainer";
import type { FetchLike, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { generatedValuesFile } from "../provision/secrets";
import { recordOwnServer, recordPortainerConnection, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakeCertificate,
  freshFacts,
  OWN_IPV4,
  ownPlan,
  ownRunner,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  ScriptedRunner,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import {
  FakeDocker,
  type FakeLogContainer,
  type FakeLogLine,
  fakeContainerId,
  fakePortainerLogs,
} from "../testing/logs";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import type { LogLine, LogRead } from "./lines";
import { readLogs } from "./read";

/** The test clock's time (`createTestPhaseDeps`), in Unix seconds. */
const NOW_SECONDS = Date.parse("2026-10-11T12:00:00.000Z") / 1000;

/** A line logged at 11:mm:ss (UTC) on the test clock's day, with nanoseconds. */
function at(minute: number, text: string, stream: "stdout" | "stderr" = "stdout"): FakeLogLine {
  const mm = String(minute).padStart(2, "0");
  return { time: `2026-10-11T11:${mm}:00.000000123Z`, stream, text };
}

function container(
  name: string,
  project: string,
  service: string,
  lines: FakeLogLine[] = [],
): FakeLogContainer {
  return { name, project, service, lines };
}

/** A Hetzner plan with a worker (2 copies), two cron jobs and Postgres, deployed. */
function componentPlan(base: DeployPlan = testPlan({ deployed: true })): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    processes: {
      workers: [{ name: "worker", command: "node worker.js", source: "procfile", count: 2 }],
      cron: [
        { name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" },
        { name: "report", schedule: "0 4 * * *", command: "node report.js" },
      ],
    },
  });
}

/** Every line of `read`, until it ends. */
async function collect(read: LogRead): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for await (const line of read) lines.push(line);
  return lines;
}

/** A server OpsCrew created, at {@link SERVER_IPV4}, with `docker` as its Docker. */
async function cloudServer(docker: FakeDocker) {
  const deps = await createTestPhaseDeps();
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  const hosts: string[] = [];
  const remote = (host: string): RemoteExec => {
    hosts.push(host);
    return docker.remote(host);
  };
  return { deps, hosts, services: { remote } };
}

const LIST_APP =
  "docker ps -a --filter label=com.docker.compose.project=shop --filter label=com.docker.compose.service=app --filter label=com.docker.compose.oneoff=False --format '{{.Names}}'";

describe("readLogs on a server OpsCrew created", () => {
  it("reads the web process's latest lines as deploy, oldest first, with how far back they go", async () => {
    const docker = new FakeDocker([
      container("shop-app-1", "shop", "app", [
        at(0, "listening on 3000"),
        at(1, "GET /api/health 200"),
        at(2, "slow query", "stderr"),
      ]),
      container("blog-app-1", "blog", "app", [at(1, "another app")]),
    ]);
    const { deps, hosts, services } = await cloudServer(docker);

    const read = await readLogs(deps, componentPlan(), { services });

    expect(read.first).toBe(
      "The oldest line here is from 2026-10-11 11:00 UTC. Each deploy starts new containers, and each keeps up to 30 MB of logs.",
    );
    expect(await collect(read)).toEqual([
      { time: at(0, "").time, service: "app", stream: "stdout", text: "listening on 3000" },
      { time: at(1, "").time, service: "app", stream: "stdout", text: "GET /api/health 200" },
      { time: at(2, "").time, service: "app", stream: "stderr", text: "slow query" },
    ]);
    expect(hosts).toEqual([SERVER_IPV4]);
    expect(docker.commands).toEqual([LIST_APP, "docker logs --timestamps --tail 200 shop-app-1"]);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        action: "read the app's logs (read-only)",
        target: "server",
        detail: "app",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(SERVER_IPV4);
  });

  it("merges a worker's copies by time, and --tail keeps the latest lines of all", async () => {
    const docker = new FakeDocker([
      container("shop-worker-1", "shop", "worker", [at(0, "a0"), at(2, "a2"), at(4, "a4")]),
      container("shop-worker-2", "shop", "worker", [at(1, "b1"), at(3, "b3")]),
    ]);
    const { deps, services } = await cloudServer(docker);

    const read = await readLogs(deps, componentPlan(), { services, service: "worker", tail: 3 });

    expect((await collect(read)).map((line) => `${line.service} ${line.text}`)).toEqual([
      "worker a2",
      "worker b3",
      "worker a4",
    ]);
    expect(read.first).toContain("from 2026-10-11 11:02 UTC");
    expect(docker.commands.slice(1)).toEqual([
      "docker logs --timestamps --tail 3 shop-worker-1",
      "docker logs --timestamps --tail 3 shop-worker-2",
    ]);
  });

  it("asks Docker for the lines since --since, and says when there are none", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app", [at(0, "old")])]);
    const { deps, services } = await cloudServer(docker);

    const read = await readLogs(deps, componentPlan(), { services, since: "15m" });

    expect(docker.commands.at(-1)).toBe(
      `docker logs --timestamps --tail 200 --since ${NOW_SECONDS - 900} shop-app-1`,
    );
    expect(await collect(read)).toEqual([]);
    expect(read.first).toBe(
      "No lines in the last 15m. Each deploy starts new containers, and each keeps up to 30 MB of logs.",
    );
  });

  it("reads the edge as the server's shared proxy, and a cron job from the jobs' container", async () => {
    const docker = new FakeDocker([
      container("opscrew-edge-caddy-1", "opscrew-edge", "caddy", [at(0, "GET / 200")]),
      container("shop-cron-1", "shop", "cron", [at(1, "job.position=0 done")]),
    ]);
    const { deps, services } = await cloudServer(docker);
    const plan = componentPlan();

    const edge = await readLogs(deps, plan, { services, service: "edge" });
    expect(await collect(edge)).toEqual([
      expect.objectContaining({ service: "edge", text: "GET / 200" }),
    ]);
    expect(edge.first).toContain(
      "The edge is the server's shared proxy (Caddy), in front of every OpsCrew app on the server",
    );
    expect(docker.commands[0]).toContain(
      "--filter label=com.docker.compose.project=opscrew-edge --filter label=com.docker.compose.service=caddy",
    );

    const cron = await readLogs(deps, plan, { services, service: "cleanup" });
    expect(await collect(cron)).toEqual([
      expect.objectContaining({ service: "cleanup", text: "job.position=0 done" }),
    ]);
    expect(cron.first).toContain("The cron jobs run in one container (cron)");
  });

  it("refuses an unknown service with the names it takes, before connecting", async () => {
    const docker = new FakeDocker();
    const { deps, hosts, services } = await cloudServer(docker);

    const error = await readLogs(deps, componentPlan(), {
      services,
      service: "payments",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
    expect((error as OpsCrewError).message).toBe(
      'The app has no part named "payments". --service takes app, worker, cron, db, cleanup, report and edge.',
    );
    expect(hosts).toEqual([]);
    expect(docker.commands).toEqual([]);
  });

  it("masks a registered secret value and a token-shaped value in the lines", async () => {
    const session = "session-value-not-shaped-like-a-token-0001";
    const token = fakeSecret("github-token", "logs");
    const docker = new FakeDocker([
      container("shop-app-1", "shop", "app", [
        at(0, `session ${session} started`),
        at(1, `token ${token} used`, "stderr"),
      ]),
    ]);
    const { deps, services } = await cloudServer(docker);
    const file = generatedValuesFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ env: { SESSION_SECRET: session } })}\n`);

    const lines = await collect(await readLogs(deps, componentPlan(), { services }));

    const text = JSON.stringify(lines);
    expect(text).not.toContain(session);
    expect(text).not.toContain(token);
    expect(lines.map((line) => line.text)).toEqual([
      expect.stringMatching(/^session \[REDACTED[^\]]*\] started$/),
      expect.stringMatching(/^token \[REDACTED[^\]]*\] used$/),
    ]);
  });

  it("builds no command from a container name Docker would not give", async () => {
    const docker = new FakeDocker([
      container("shop-app-1;reboot", "shop", "app", [at(0, "x")]),
      container("$(reboot)", "shop", "app", [at(0, "x")]),
      container("-v", "shop", "app", [at(0, "x")]),
      container("shop-app-1", "shop", "app", [at(1, "kept")]),
    ]);
    const { deps, services } = await cloudServer(docker);

    const lines = await collect(await readLogs(deps, componentPlan(), { services }));

    expect(lines.map((line) => line.text)).toEqual(["kept"]);
    expect(docker.commands).toEqual([LIST_APP, "docker logs --timestamps --tail 200 shop-app-1"]);
  });

  it("says so, and suggests verify, when the server does not answer over SSH", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app")]);
    docker.unreachable = true;
    const { deps, services } = await cloudServer(docker);

    const error = await readLogs(deps, componentPlan(), { services }).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "COMMAND_FAILED",
      message: "The server did not answer over SSH, so OpsCrew could not read the app's logs.",
    });
    expect((error as OpsCrewError).hint).toContain("`opscrew verify`");
    expect(JSON.stringify(error)).not.toContain(SERVER_IPV4);
  });

  it("quotes Docker's own words when it fails, never a line the container logged", async () => {
    const token = fakeSecret("github-token", "logs-failure");
    const docker = new FakeDocker([container("shop-app-1", "shop", "app")]);
    docker.logsFailure = {
      exitCode: 1,
      stdout: "",
      stderr: `${at(0, "").time} token ${token}\nError response from daemon: container is dead\n`,
    };
    const { deps, services } = await cloudServer(docker);

    const error = await readLogs(deps, componentPlan(), { services }).catch((e: unknown) => e);

    expect((error as OpsCrewError).message).toBe(
      "Docker on the server could not read the app's logs (exit code 1): Error response from daemon: container is dead.",
    );
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("names a part without a container", async () => {
    const docker = new FakeDocker([]);
    const { deps, services } = await cloudServer(docker);

    await expect(readLogs(deps, componentPlan(), { services, service: "db" })).rejects.toThrow(
      "There is no container of PostgreSQL (db) on the server, so it has no lines.",
    );
  });

  it("follows new lines over SSH inside the wrapper, from just after the last line, until aborted", async () => {
    const docker = new FakeDocker([
      container("shop-app-1", "shop", "app", [at(0, "first"), at(1, "second")]),
    ]);
    const { deps, services } = await cloudServer(docker);
    const controller = new AbortController();

    const read = await readLogs(deps, componentPlan(), {
      services,
      follow: true,
      signal: controller.signal,
    });
    const seen: string[] = [];
    for await (const line of read) {
      seen.push(line.text);
      if (seen.length === 2) {
        // A request after the follow started: it streams through `onLine`.
        setTimeout(() => docker.log("shop-app-1", at(5, "GET /new 200")), 10);
      }
      if (seen.length === 3) controller.abort();
    }

    expect(seen).toEqual(["first", "second", "GET /new 200"]);
    expect(docker.commands.at(-1)).toBe(
      `docker logs --timestamps --tail 200 --since ${sinceAfter(at(1, "").time)} --follow shop-app-1 & p=$!; while kill -0 $PPID 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p`,
    );
    expect(docker.following).toBe(0);
    expect(deps.audit.entries.at(-1)).toMatchObject({ detail: "app, following" });
  });

  it("stops following when the caller stops reading", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app", [at(0, "only")])]);
    const { deps, services } = await cloudServer(docker);
    const read = await readLogs(deps, componentPlan(), { services, follow: true });
    for await (const line of read) {
      setTimeout(() => docker.log("shop-app-1", at(1, `after ${line.text}`)), 10);
      if (line.text !== "only") break;
    }
    expect(docker.following).toBe(0);
  });
});

describe("readLogs on a server the user owns", () => {
  async function ownServer(docker: FakeDocker, privilege: "root" | "sudo") {
    const deps = await createTestPhaseDeps({ runner: ownRunner(), interactive: false });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: privilege === "root" ? "root" : "alice",
      agent: true,
      reachable: true,
    });
    const host = new FakeHostServer(
      freshFacts(privilege === "root" ? {} : { user: "alice", privilege: "sudo" }),
    );
    const services = { own: { host, remote: () => docker.remote(OWN_IPV4) } };
    return { deps, host, services };
  }

  it("reads through status's connection, as root through sudo for a sudo login", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app", [at(0, "hello")])]);
    const { deps, host, services } = await ownServer(docker, "sudo");

    const read = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
    });

    expect(await collect(read)).toEqual([expect.objectContaining({ text: "hello" })]);
    expect(host.inspections).toBe(1);
    expect(docker.commands).toEqual([
      "true",
      `sudo -n ${LIST_APP}`,
      "sudo -n docker logs --timestamps --tail 200 shop-app-1",
    ]);
    expect(deps.audit.entries.map((entry) => [entry.action, entry.target])).toEqual([
      ["inspect host (read-only)", "own server"],
      ["read the app's logs (read-only)", "own server"],
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(OWN_IPV4);
  });

  it("follows as root, the wrapper watching the login shell's parent", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app", [at(0, "hello")])]);
    const { deps, services } = await ownServer(docker, "sudo");
    const controller = new AbortController();
    const read = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
      follow: true,
      signal: controller.signal,
    });
    const seen: string[] = [];
    for await (const line of read) {
      seen.push(line.text);
      if (seen.length === 1) setTimeout(() => docker.log("shop-app-1", at(1, "next")), 10);
      if (seen.length === 2) controller.abort();
    }
    expect(seen).toEqual(["hello", "next"]);
    expect(docker.commands.at(-1)).toBe(
      `sudo -n sh -c 'docker logs --timestamps --tail 200 --since ${sinceAfter(at(0, "").time)} --follow shop-app-1 & p=$!; while kill -0 "$0" 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p' "$PPID"`,
    );
  });

  it("reads as the root login itself, without sudo", async () => {
    const docker = new FakeDocker([container("shop-app-1", "shop", "app", [at(0, "hello")])]);
    const { deps, services } = await ownServer(docker, "root");
    await collect(
      await readLogs(deps, ownPlan({ deployed: true }), { services, hostKey: ED25519_FINGERPRINT }),
    );
    expect(docker.commands.slice(1)).toEqual([
      LIST_APP,
      "docker logs --timestamps --tail 200 shop-app-1",
    ]);
  });

  it("says so, and suggests verify, when the server does not answer over SSH", async () => {
    const docker = new FakeDocker();
    docker.unreachable = true;
    const { deps, services } = await ownServer(docker, "root");
    const error = await readLogs(deps, ownPlan({ deployed: true }), {
      services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect((error as OpsCrewError).message).toContain("could not reach SSH on your server");
    expect((error as OpsCrewError).hint).toContain("`opscrew verify`");
  });
});

describe("readLogs in the user's Portainer", () => {
  async function portainer(docker: FakeDocker, options: { visible?: boolean } = {}) {
    const deps = await createTestPhaseDeps({
      env: { OPSCREW_HOME: join(await mkdtemp(join(tmpdir(), "opscrew-logs-")), "home") },
    });
    deps.env.PORTAINER_API_KEY = fakeSecret("generic-password", "portainer-token");
    await recordPortainerConnection(deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: fakeCertificate().fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
    });
    const fake = fakePortainerLogs(docker, options);
    return { deps, fake };
  }

  it("reads the app stack's container through Portainer's API", async () => {
    const docker = new FakeDocker([
      container("opscrew-shop-app-1", "opscrew-shop", "app", [at(0, "a"), at(1, "b", "stderr")]),
      container("media-app-1", "media", "app", [at(0, "not the app's")]),
    ]);
    const { deps, fake } = await portainer(docker);

    const read = await readLogs(deps, portainerPlan({ deployed: true }), {
      services: { portainer: { client: fake.client } },
    });

    expect(await collect(read)).toEqual([
      expect.objectContaining({ service: "app", stream: "stdout", text: "a" }),
      expect.objectContaining({ service: "app", stream: "stderr", text: "b" }),
    ]);
    expect(fake.calls).toEqual([
      { environmentId: 3, containerId: fakeContainerId("opscrew-shop-app-1"), tail: 200 },
    ]);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "remote-exec", target: "portainer" }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PORTAINER_HOST);
  });

  it("follows by asking every 2 seconds for the lines just after the last one", async () => {
    const docker = new FakeDocker([
      container("opscrew-shop-app-1", "opscrew-shop", "app", [at(0, "a")]),
    ]);
    const { deps, fake } = await portainer(docker);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 2) docker.log("opscrew-shop-app-1", at(3, "new"));
      if (sleeps.length === 4) controller.abort();
    };

    const read = await readLogs(deps, portainerPlan({ deployed: true }), {
      services: { portainer: { client: fake.client }, sleep },
      follow: true,
      signal: controller.signal,
    });

    expect((await collect(read)).map((line) => line.text)).toEqual(["a", "new"]);
    expect(sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(fake.calls.map((call) => call.since)).toEqual([
      undefined,
      sinceAfter(at(0, "").time),
      sinceAfter(at(0, "").time),
      sinceAfter(at(3, "").time),
    ]);
  });

  it("reads the stack's Caddy as the edge, and says a stack without one has no edge", async () => {
    const docker = new FakeDocker([
      container("opscrew-shop-caddy-1", "opscrew-shop", "caddy", [at(0, "GET / 200")]),
    ]);
    const { deps, fake } = await portainer(docker);
    const services = { portainer: { client: fake.client } };

    const caddy = await readLogs(deps, portainerPlan({ deployed: true, web: { mode: "caddy" } }), {
      services,
      service: "edge",
    });
    expect(caddy.first).toContain("The edge is the Caddy in the app's stack");
    expect(await collect(caddy)).toEqual([expect.objectContaining({ text: "GET / 200" })]);

    const tunnel = await readLogs(deps, portainerPlan({ deployed: true }), {
      services,
      service: "edge",
    }).catch((e: unknown) => e);
    expect(tunnel).toMatchObject({ code: "INVALID_INPUT" });
    expect((tunnel as OpsCrewError).message).toBe(
      "The app's stack in your Portainer has no Caddy (its web mode is tunnel), so it has no edge lines. --service takes app and db.",
    );
  });

  it("says that a standard user's token sees only that user's stacks", async () => {
    const docker = new FakeDocker([container("opscrew-shop-app-1", "opscrew-shop", "app")]);
    const { deps, fake } = await portainer(docker, { visible: false });

    const error = await readLogs(deps, portainerPlan({ deployed: true }), {
      services: { portainer: { client: fake.client } },
    }).catch((e: unknown) => e);

    expect((error as OpsCrewError).message).toContain(
      "a standard user's token sees only that user's own stacks",
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("readLogs on this computer", () => {
  it("reads and follows the app's container through local Docker", async () => {
    const docker = new FakeDocker([
      container("opscrew-shop-app-1", "opscrew-shop", "app", [at(0, "local")]),
    ]);
    const deps = await createTestPhaseDeps({ runner: docker.runner() });
    const controller = new AbortController();

    const read = await readLogs(deps, localPlan(), { follow: true, signal: controller.signal });
    const seen: string[] = [];
    for await (const line of read) {
      seen.push(line.text);
      if (seen.length === 1) setTimeout(() => docker.log("opscrew-shop-app-1", at(1, "more")), 10);
      if (seen.length === 2) controller.abort();
    }

    expect(seen).toEqual(["local", "more"]);
    expect(docker.commands).toEqual([
      "docker ps -a --filter label=com.docker.compose.project=opscrew-shop --filter label=com.docker.compose.service=app --filter label=com.docker.compose.oneoff=False --format {{.Names}}",
      "docker logs --timestamps --tail 200 opscrew-shop-app-1",
      `docker logs --timestamps --tail 200 --since ${sinceAfter(at(0, "").time)} --follow opscrew-shop-app-1`,
    ]);
    expect(docker.following).toBe(0);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "remote-exec", target: "this computer" }),
    ]);
  });

  it("reads the edge as this computer's shared proxy", async () => {
    const docker = new FakeDocker([
      container("opscrew-edge-caddy-1", "opscrew-edge", "caddy", [at(0, "GET / 200")]),
    ]);
    const deps = await createTestPhaseDeps({ runner: docker.runner() });
    const read = await readLogs(deps, localPlan(), { service: "edge" });
    expect(read.first).toContain("this computer's shared proxy (Caddy)");
    expect(await collect(read)).toEqual([expect.objectContaining({ text: "GET / 200" })]);
  });
});

describe("readLogs on the server-less targets", () => {
  /** A project whose `origin` is `example-org/example-app`, with GitHub's runs of its workflow. */
  async function site(plan: DeployPlan) {
    const runner = new ScriptedRunner((command, args) =>
      command === "git" && args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/example-org/example-app.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "unexpected command" },
    );
    const asked: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search}`);
      if (!/\/actions\/workflows\/[^/]+\/runs$/.test(url.pathname)) {
        return new Response("not found", { status: 404 });
      }
      const run = (id: number, conclusion: string | null, day: number) => ({
        id,
        status: conclusion === null ? "in_progress" : "completed",
        conclusion,
        html_url: `https://github.com/example-org/example-app/actions/runs/${id}`,
        head_sha: String(id).repeat(40).slice(0, 40),
        created_at: `2026-10-${day}T09:00:00Z`,
      });
      return Response.json({
        workflow_runs: [run(303, null, 23), run(302, "failure", 22), run(301, "success", 21)],
      });
    };
    const deps = await createTestPhaseDeps({ runner, fetch });
    deps.env.GITHUB_TOKEN = fakeSecret("github-token", "logs-site");
    await writeArtifact("plan", deps.paths.files.plan, plan);
    return { deps, asked };
  }

  it("on GitHub Pages, says it keeps no request logs and shows the last deploy runs", async () => {
    const { deps, asked } = await site(pagesTestPlan());

    const read = await readLogs(deps, pagesTestPlan());

    expect(read.first).toBe(
      "GitHub Pages keeps no request logs for this site: its files are served without running any code.",
    );
    expect(await collect(read)).toEqual([
      {
        time: "2026-10-21T09:00:00Z",
        service: "deploy",
        stream: "stdout",
        text: "Succeeded, commit 3013013: https://github.com/example-org/example-app/actions/runs/301",
      },
      expect.objectContaining({
        text: "Failed, commit 3023023: https://github.com/example-org/example-app/actions/runs/302",
      }),
      expect.objectContaining({
        text: "Not finished (in progress), commit 3033033: https://github.com/example-org/example-app/actions/runs/303",
      }),
    ]);
    expect(asked).toEqual([expect.stringMatching(/\/runs\?per_page=10$/)]);
  });

  it("on Cloudflare, a static site has the same sentence and its deploy runs", async () => {
    const plan = sitePlan();
    const { deps } = await site(plan);
    const read = await readLogs(deps, plan);
    expect(read.first).toBe(
      "Cloudflare keeps no request logs for this site: its files are served without running any code.",
    );
    expect(await collect(read)).toHaveLength(3);
  });
});

describe("readLogs' bounds", () => {
  it("refuses a --since or --tail it does not take, before connecting", async () => {
    const docker = new FakeDocker();
    const { deps, hosts, services } = await cloudServer(docker);
    for (const options of [{ since: "1w" }, { since: "15" }, { tail: 0 }, { tail: 2.5 }]) {
      await expect(readLogs(deps, componentPlan(), { services, ...options })).rejects.toMatchObject(
        { code: "INVALID_INPUT" },
      );
    }
    expect(hosts).toEqual([]);
  });
});
