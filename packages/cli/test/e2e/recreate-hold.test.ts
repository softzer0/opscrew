/**
 * A server's recreate under load (T1416b, research.md "Spike results" 18), on Docker. The rollback
 * script OpsCrew renders for a `recreate` plan runs with sh on this computer, the script on its
 * stdin as over SSH, with /srv mapped to a temporary folder. Its switch is the deploy's own: pause
 * the app's service on kamal-proxy, replace the container, deploy the new copy to kamal-proxy,
 * resume, and resume again in the EXIT trap. It runs against:
 * - the pinned kamal-proxy as the edge's Compose file renders it, without the front proxy, with its
 *   HTTP port published on 127.0.0.1;
 * - a stand-in app built on the pinned Python image, whose health path (`/up`) is separate from
 *   `/`, because kamal-proxy answers a paused service's health path itself.
 *
 * The first switch registers the service, although its pause fails. Three recreates under a
 * request loop give no failed request. A switch to a version that fails its health check leaves
 * the service running, not paused.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon, and a POSIX sh.
 * The two Compose projects, their volumes, the network and the stand-in images are removed
 * afterwards, by their Compose project and by name.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { deploymentFiles } from "@opscrew/agents";
import { NodeCommandRunner } from "@opscrew/core";
import { EDGE_PROJECT, IMAGES, renderEdgeCompose, siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { TempProject } from "../../src/ui/__fixtures__/harness";
import { docker, dockerSkipReason, LABEL, TEN_MINUTES, TWO_MINUTES } from "./docker-support";
import {
  designedPlan,
  dockerOk,
  freePort,
  httpGet,
  renderContext,
  requestLoop,
  SH,
  tempDir,
  unique,
} from "./edge-support";

const SKIP = dockerSkipReason() ?? (SH === undefined ? "no POSIX sh on this computer" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the recreate under load: ${SKIP}.`);

/** The stand-in app's health path; `/` serves the traffic. */
const HEALTH_PATH = "/up";

/**
 * The stand-in app (Python): `VERSION` on every path, except a 503 on {@link HEALTH_PATH} when
 * `BROKEN=1`; a prompt exit on SIGTERM (as PID 1 it would ignore it).
 */
const STAND_IN = [
  "import os, signal, sys",
  "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
  "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))",
  "class App(BaseHTTPRequestHandler):",
  "    def do_GET(self):",
  "        body = os.environ['VERSION'].encode()",
  `        broken = self.path == ${JSON.stringify(HEALTH_PATH)} and os.environ.get('BROKEN') == '1'`,
  "        self.send_response(503 if broken else 200)",
  "        self.send_header('Content-Length', str(len(body)))",
  "        self.end_headers()",
  "        self.wfile.write(body)",
  "    def log_message(self, *args):",
  "        pass",
  "ThreadingHTTPServer(('', int(os.environ['PORT'])), App).serve_forever()",
].join("\n");

describe.skipIf(SKIP !== undefined)("a server's recreate under load (014, T1416b)", () => {
  const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
  const network = unique("recreate-net");
  const edgeProject = unique("recreate-edge");
  /** The app's name, its Compose project and its kamal-proxy service. */
  const app = `rc-${randomBytes(4).toString("hex")}`;
  const images = {
    v1: `${unique("recreate")}:v1`,
    v2: `${unique("recreate")}:v2`,
    broken: `${unique("recreate")}:broken`,
  };
  let work = "";
  let project: TempProject | undefined;
  let plan: DeployPlan;
  let script = "";
  let proxyPort = 0;
  let host = "localhost";
  const built = new Set<string>();

  const appDir = () => path.join(work, "srv", "apps", app);
  const edgeFile = () => path.join(work, "srv", "edge", "compose.yaml");

  /** `kamal-proxy <args>` in the edge's kamal-proxy. */
  function kamalProxy(...args: string[]) {
    return docker([
      "compose",
      "-p",
      edgeProject,
      "-f",
      edgeFile(),
      "exec",
      "-T",
      "kamal-proxy",
      "kamal-proxy",
      ...args,
    ]);
  }

  /** kamal-proxy's line for the app in `kamal-proxy list`. */
  async function serviceLine(): Promise<string> {
    const listed = await kamalProxy("list");
    expect(listed.exitCode, listed.stderr).toBe(0);
    return listed.stdout.split("\n").find((line) => line.includes(app)) ?? "";
  }

  /** GET `/` through kamal-proxy: the status, the body and how long it took. */
  function get(timeoutMs = 95_000): Promise<{ status: number; body: string; ms: number }> {
    const sent = Date.now();
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/", headers: { host }, agent: false },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body, ms: Date.now() - sent }),
          );
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error("timed out")));
      request.on("error", reject);
      request.end();
    });
  }

  /**
   * Runs the rendered rollback script from `from` to `to`, as the workflow does after a failed
   * deploy of `from`: `.env` names `from`, `.env.previous` names `to`.
   */
  async function recreate(from: string, to: string) {
    await writeFile(path.join(appDir(), ".env"), `APP_IMAGE=${from}\n`);
    await writeFile(path.join(appDir(), ".env.previous"), `APP_IMAGE=${to}\n`);
    return runner.run(SH ?? "sh", ["-s", "--", from], {
      input: script,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      timeoutMs: TEN_MINUTES,
    });
  }

  /** {@link recreate} that must print `restored` alone on stdout, its output contract. */
  async function restored(from: string, to: string): Promise<void> {
    const result = await recreate(from, to);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("restored");
  }

  beforeAll(async () => {
    work = await tempDir("opscrew-recreate-");
    const designed = await designedPlan(
      "hono-api",
      {},
      {
        edit: (p) =>
          DeployPlanSchema.parse({
            ...p,
            app: { ...p.app, name: app, healthPath: HEALTH_PATH },
            deploy: { ...p.deploy, strategy: "recreate" },
          }),
      },
    );
    project = designed.project;
    plan = designed.plan;
    expect(plan.deploy).toMatchObject({ strategy: "recreate", drainSeconds: 30 });
    host = siteHosts(plan)[0] ?? "localhost";

    // The rollback script, as the workflow sends it over SSH.
    const files = deploymentFiles(plan, renderContext());
    const workflow = files.find((file) => file.path === plan.cicd.workflowPath)?.content ?? "";
    const jobs = (
      parse(workflow) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> }
    ).jobs;
    const step = Object.values(jobs)
      .flatMap((job) => job.steps ?? [])
      .find((s) => s.name?.startsWith("Roll back"));
    const remote = /<<'REMOTE'\n([\s\S]*?)\nREMOTE\n/.exec(step?.run ?? "")?.[1];
    expect(remote, "the rollback's server script").toBeDefined();
    const srv = `${work.replaceAll("\\", "/")}/srv/`;
    script = `${(remote ?? "").replaceAll("/srv/", srv).replaceAll(`-p ${EDGE_PROJECT} `, `-p ${edgeProject} `)}\n`;
    expect(script).toContain(`kamal-proxy pause ${app} --drain-timeout 30s --max-pause 90s`);
    expect(script).toContain(`-p ${edgeProject} -f ${srv}edge/compose.yaml`);

    // The stand-in app's images.
    for (const [version, tag] of Object.entries(images)) {
      const env = version === "broken" ? "VERSION=broken BROKEN=1" : `VERSION=${version}`;
      const dockerfile = `FROM ${IMAGES.python.ref}\nENV ${env}\nCMD ["python", "-c", ${JSON.stringify(STAND_IN)}]\n`;
      const result = await runner.run("docker", ["build", "-q", "--label", LABEL, "-t", tag, "-"], {
        input: dockerfile,
        timeoutMs: TEN_MINUTES,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      built.add(tag);
    }

    // The edge: kamal-proxy as OpsCrew renders it, on the test's network.
    await dockerOk(["network", "create", "--label", LABEL, network], "creating the network");
    proxyPort = await freePort();
    const edge = parse(renderEdgeCompose(plan).content) as {
      services: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
    const kamal = edge.services["kamal-proxy"];
    expect(kamal?.image).toBe(IMAGES.kamalProxy.ref);
    const localEdge = {
      services: {
        "kamal-proxy": { ...kamal, labels: [LABEL], ports: [`127.0.0.1:${proxyPort}:80`] },
      },
      networks: { [EDGE_PROJECT]: { external: true, name: network } },
      volumes: { "kamal-proxy-config": {} },
    };
    await mkdir(path.dirname(edgeFile()), { recursive: true });
    await writeFile(edgeFile(), stringify(localEdge, { lineWidth: 0 }));
    await dockerOk(
      ["compose", "-p", edgeProject, "-f", edgeFile(), "up", "-d", "--wait"],
      "starting kamal-proxy",
      TWO_MINUTES,
    );

    // The app's folder: a Compose file with the app on the edge's network.
    await mkdir(appDir(), { recursive: true });
    const appCompose = {
      services: {
        app: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose's variable, set by the script.
          image: "${APP_IMAGE}",
          labels: [LABEL],
          environment: { PORT: String(plan.app.port) },
          networks: [EDGE_PROJECT],
        },
      },
      networks: { [EDGE_PROJECT]: { external: true, name: network } },
    };
    await writeFile(path.join(appDir(), "compose.yaml"), stringify(appCompose, { lineWidth: 0 }));
  }, TEN_MINUTES);

  afterAll(async () => {
    for (const name of [app, edgeProject]) {
      const label = `label=com.docker.compose.project=${name}`;
      const left = (await docker(["ps", "-aq", "--filter", label])).stdout
        .split(/\s+/)
        .filter(Boolean);
      if (left.length > 0) await docker(["rm", "-f", "-v", ...left]);
      const volumes = (await docker(["volume", "ls", "-q", "--filter", label])).stdout
        .split(/\s+/)
        .filter(Boolean);
      if (volumes.length > 0) await docker(["volume", "rm", ...volumes]);
    }
    await docker(["network", "rm", network]);
    for (const tag of built) await docker(["image", "rm", tag]);
    await project?.cleanup();
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, TEN_MINUTES);

  it(
    "registers the first version, although kamal-proxy has no service to pause yet",
    async () => {
      await restored("none", images.v1);
      expect(await serviceLine()).toMatch(/running/i);
      expect(await get()).toMatchObject({ status: 200, body: "v1" });
    },
    TEN_MINUTES,
  );

  it(
    "recreates the app three times under a request loop with no failed request",
    async () => {
      const loop = requestLoop(
        () => httpGet(proxyPort, host, "/", 95_000),
        (answer) => answer.status === 200,
      );
      await restored(images.v1, images.v2);
      await restored(images.v2, images.v1);
      await restored(images.v1, images.v2);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const result = await loop.stop();
      console.info(
        `Three recreates on kamal-proxy: ${result.requests} requests, ${result.failures.length} failed, the longest hold took ${(result.slowestMs / 1000).toFixed(1)} s.`,
      );
      expect(result.failures, `${result.requests} requests`).toEqual([]);
      // kamal-proxy held requests (2.5 to 2.7 s here). Without the pause the slowest request took
      // 1.1 s, so a pause that failed silently fails this check.
      expect(result.slowestMs, "no hold").toBeGreaterThan(1_500);
      expect(await get()).toMatchObject({ status: 200, body: "v2" });
    },
    TEN_MINUTES,
  );

  it(
    "lifts the pause after a switch whose health check fails",
    async () => {
      const result = await recreate(images.v2, images.broken);
      expect(result.exitCode).toBe(1);
      // Nothing on stdout: the workflow then says it could not restore the previous version.
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("The previous version did not pass its health check either");
      const line = await serviceLine();
      expect(line).toMatch(/running/i);
      expect(line).not.toMatch(/paused/i);
      // Not held: kamal-proxy answers at once (its copy is gone, so with an error).
      const answer = await get();
      expect(answer.ms, JSON.stringify(answer)).toBeLessThan(5_000);
    },
    TEN_MINUTES,
  );
});
