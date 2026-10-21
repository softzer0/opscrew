/**
 * Portainer's redeploy under load (T1416's check, research.md "Spike results" 16), on Docker:
 * `examples/hono-api` is designed by the real CLI for a Portainer (a fake one answers the
 * interview) with the stack behind the user's own proxy (`portainer.web: proxy`), and its stack
 * template (`renderPortainerStack`) is filled in as the deploy workflow fills it (the image by
 * digest and its version) and committed to the deploy branch of a local Git server. A local
 * Portainer CE (`IMAGES.portainer`) deploys it through OpsCrew's Portainer client
 * (`createGitStack`, with its webhook), pulling the app's image from a local registry. The app is
 * a stand-in (the pinned Caddy answering with its version), pushed three times.
 *
 * Under a request loop through the stack's Caddy, two webhook redeploys, each to a new image,
 * give no failed request; each new version is live at `/.well-known/opscrew-version`; and Caddy's
 * container is the same before and after (only the app and the one-shot `stamp` change).
 *
 * The registry and Portainer publish on 127.0.0.1 only, and the Git server on no port (Portainer
 * reaches it on the test network). Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a
 * running Docker daemon and git; it pulls the images it needs. The stack, its containers,
 * networks and volumes, the helpers, the network and the app's images are removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PortainerAccess } from "@opscrew/agents";
import { PORTAINER_URL } from "@opscrew/agents/testing";
import { portainerClient } from "@opscrew/connector-portainer";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  IMAGES,
  PORTAINER_COMPOSE_FILE,
  PORTAINER_DEPLOY_BRANCH,
  PORTAINER_IMAGE_PLACEHOLDER,
  PORTAINER_VERSION_PLACEHOLDER,
  portainerImageVersion,
  portainerStackName,
  renderPortainerStack,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { GIT, git, type TempProject } from "../../src/ui/__fixtures__/harness";
import { docker, dockerSkipReason, LABEL, TEN_MINUTES, TWO_MINUTES } from "./docker-support";
import {
  designedPlan,
  dockerOk,
  freePort,
  hasImage,
  httpGet,
  renderContext,
  requestLoop,
  standInScript,
  tempDir,
  unique,
  until,
} from "./edge-support";

const SKIP = dockerSkipReason() ?? (GIT === undefined ? "git is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping Portainer's redeploy under load: ${SKIP}.`);

/** The registry's image (Distribution 3), pinned for this test only. */
const REGISTRY =
  "registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8";

/** Portainer's certificate, as the fake one shows it to the interview. */
const PORTAINER_CERT = `SHA256:${"AB:".repeat(31)}AB`;

/** A Portainer with one Docker environment, for the interview only. */
const PORTAINER_ACCESS: PortainerAccess = {
  fetchCertificateFingerprint: async () => PORTAINER_CERT,
  listEnvironments: async () => [{ id: 1, name: "local", kind: "docker", up: true, arch: "amd64" }],
};

/**
 * A Git server for smart HTTP: `git http-backend` behind Node's HTTP server, serving the bare
 * repositories in `/srv/git` to clones (no pushes).
 */
const GIT_SERVER = String.raw`
const http = require("node:http");
const { spawn } = require("node:child_process");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://git");
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: "/srv/git",
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"] || "",
    GIT_PROTOCOL: req.headers["git-protocol"] || "",
  };
  if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"];
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  const cgi = spawn("git", ["http-backend"], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on("data", (chunk) => {
    if (sent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    let status = 200;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const at = line.indexOf(":");
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    sent = true;
    res.write(head.subarray(end + 4));
  });
  cgi.stdout.on("end", () => res.end());
  cgi.stderr.pipe(process.stderr);
}).listen(8000);
`;

describe.skipIf(SKIP !== undefined)("Portainer's redeploy under load (014, T1416)", () => {
  const network = unique("portainer-net");
  const registry = unique("registry");
  const gitServer = unique("git");
  const portainer = unique("portainer");
  const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
  let work = "";
  let project: TempProject | undefined;
  let plan: DeployPlan;
  let stack = "";
  let registryPort = 0;
  let portainerUrl = "";
  let caddyPort = 0;
  let token = "";
  let jwt = "";
  let environmentId = 0;
  let stackId: number | undefined;
  let webhook = "";
  const repo = { bare: "", clone: "" };
  /** Whether the registry's image was here before this test pulled it. */
  let hadRegistry = true;
  const images = new Set<string>();
  /** Each version pushed: its image by digest and the version Caddy serves. */
  const versions: { image: string; version: string; body: string }[] = [];

  /** Portainer's API with the administrator's session (only the setup uses it). */
  async function admin(method: string, route: string, body?: unknown) {
    const response = await fetch(`${portainerUrl}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(jwt !== "" ? { authorization: `Bearer ${jwt}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Portainer ${method} ${route}: ${response.status} ${text}`);
    return text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
  }

  /**
   * Builds the stand-in app answering `body` (`standInScript`), pushes it, and returns it by
   * digest.
   */
  async function pushVersion(body: string) {
    const tag = `127.0.0.1:${registryPort}/opscrew-test/app:${body}`;
    const server = standInScript(body, plan.app.port);
    const built = await runner.run("docker", ["build", "-q", "--label", LABEL, "-t", tag, "-"], {
      input: `FROM ${IMAGES.nodeAlpine.ref}\nUSER node\nCMD ["node", "-e", ${JSON.stringify(server)}]\n`,
      timeoutMs: TEN_MINUTES,
    });
    expect(built.exitCode, built.stderr).toBe(0);
    images.add(tag);
    await dockerOk(["push", "-q", tag], `pushing ${tag}`, TEN_MINUTES);
    const manifest = await fetch(
      `http://127.0.0.1:${registryPort}/v2/opscrew-test/app/manifests/${body}`,
      {
        method: "HEAD",
        headers: {
          accept: [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
          ].join(", "),
        },
      },
    );
    const digest = manifest.headers.get("docker-content-digest") ?? "";
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The workflow's version: the image's digest, as for a GHCR image.
    const version = portainerImageVersion(`ghcr.io/acme/shop@${digest}`);
    const image = `127.0.0.1:${registryPort}/opscrew-test/app@${digest}`;
    versions.push({ image, version, body });
    return versions.at(-1) as (typeof versions)[number];
  }

  /**
   * The stack file the deploy workflow writes to the deploy branch for `image`, with Caddy's port
   * on 127.0.0.1 here, committed and pushed to the Git server.
   */
  async function commitStack(at: (typeof versions)[number]): Promise<void> {
    const template = renderPortainerStack(plan, renderContext()).content;
    const filled = template
      .replaceAll(PORTAINER_IMAGE_PLACEHOLDER, at.image)
      .replaceAll(PORTAINER_VERSION_PLACEHOLDER, at.version);
    const doc = parse(filled) as { services: { caddy: { ports?: string[] } } };
    doc.services.caddy.ports = [`127.0.0.1:${caddyPort}:80`];
    await writeFile(
      path.join(repo.clone, PORTAINER_COMPOSE_FILE),
      stringify(doc, { lineWidth: 0 }),
    );
    const env = project?.env ?? {};
    await git(env, repo.clone, "add", "-A");
    await git(env, repo.clone, "commit", "-q", "-m", `Deploy ${at.version}`);
    await git(env, repo.clone, "push", "-q", "origin", PORTAINER_DEPLOY_BRANCH);
  }

  /** The id of the stack's running `service` container. */
  async function containerOf(service: string): Promise<string> {
    const listed = await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${stack}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ]);
    return listed.stdout.trim();
  }

  /** The version the stack's Caddy serves, or undefined. */
  async function liveVersion(): Promise<string | undefined> {
    const response = await fetch(`http://127.0.0.1:${caddyPort}/.well-known/opscrew-version`);
    return response.ok ? (await response.text()).trim() : undefined;
  }

  beforeAll(async () => {
    work = await tempDir("opscrew-portainer-pass-");
    const designed = await designedPlan(
      "hono-api",
      {
        provider: "portainer",
        "portainer.url": PORTAINER_URL,
        "portainer.environment": "local",
        "portainer.redeploy": "updater",
        "portainer.web": "proxy",
        "portainer.port": 8080,
      },
      {
        services: { portainerAccess: PORTAINER_ACCESS },
        interview: ["--portainer-cert", PORTAINER_CERT],
        // The interview needs a token to list the fake Portainer's environments.
        env: { PORTAINER_API_KEY: fakeSecret("generic-password", "portainer-redeploy") },
      },
    );
    project = designed.project;
    plan = designed.plan;
    expect(plan.target).toMatchObject({ provider: "portainer", web: { mode: "proxy" } });
    stack = portainerStackName(plan);

    await dockerOk(["network", "create", "--label", LABEL, network], "creating the network");
    hadRegistry = await hasImage(REGISTRY);
    registryPort = await freePort();
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        registry,
        "--label",
        LABEL,
        "-p",
        `127.0.0.1:${registryPort}:5000`,
        REGISTRY,
      ],
      "starting the registry",
      TEN_MINUTES,
    );
    // The Git server: a bare repository with the deploy branch, served over smart HTTP.
    const gitDir = path.join(work, "git");
    repo.bare = path.join(gitDir, "app.git");
    repo.clone = path.join(work, "clone");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(work, "git-server.js"), GIT_SERVER);
    const env = project.env;
    await git(env, work, "init", "-q", "--bare", "-b", PORTAINER_DEPLOY_BRANCH, repo.bare);
    await git(env, work, "init", "-q", "-b", PORTAINER_DEPLOY_BRANCH, repo.clone);
    await git(env, repo.clone, "remote", "add", "origin", repo.bare);
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        gitServer,
        "--label",
        LABEL,
        "--network",
        network,
        "--network-alias",
        "git",
        "-v",
        `${gitDir}:/srv/git:ro`,
        "-v",
        `${path.join(work, "git-server.js")}:/srv/git-server.js:ro`,
        IMAGES.nodeAlpine.ref,
        "sh",
        "-c",
        // Alpine's git-daemon package holds `git http-backend`.
        "apk add --no-cache git git-daemon > /dev/null && exec node /srv/git-server.js",
      ],
      "starting the Git server",
      TEN_MINUTES,
    );
    // Portainer CE on this computer's Docker.
    const portainerPort = await freePort();
    portainerUrl = `http://127.0.0.1:${portainerPort}`;
    const password = fakeSecret("generic-password", "portainer-admin");
    await writeFile(path.join(work, "admin-password"), password);
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        portainer,
        "--label",
        LABEL,
        "--network",
        network,
        "-p",
        `127.0.0.1:${portainerPort}:9000`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${path.join(work, "admin-password")}:/run/opscrew/admin-password:ro`,
        IMAGES.portainer.ref,
        "-H",
        "unix:///var/run/docker.sock",
        "--admin-password-file",
        "/run/opscrew/admin-password",
      ],
      "starting Portainer",
      TEN_MINUTES,
    );
    await until("Portainer answering", async () =>
      (await fetch(`${portainerUrl}/api/system/status`).catch(() => undefined))?.ok
        ? true
        : undefined,
    );
    jwt = String((await admin("POST", "/api/auth", { username: "admin", password }))?.jwt ?? "");
    const created = await admin("POST", "/api/users/1/tokens", {
      password,
      description: "opscrew-test",
    });
    token = String(created?.rawAPIKey ?? "");
    expect(token).not.toBe("");
    // Started with `-H`, Portainer adds this computer's Docker as its environment.
    environmentId = await until("Portainer's local environment", async () => {
      const list = (await admin("GET", "/api/endpoints")) as unknown as { Id: number }[];
      return list[0]?.Id;
    });

    caddyPort = await freePort();
    await commitStack(await pushVersion("v1"));
    webhook = randomUUID();
    const client = portainerClient({ url: portainerUrl }, token);
    const deployed = await client.createGitStack(environmentId, {
      name: stack,
      repositoryUrl: "http://git:8000/app.git",
      referenceName: `refs/heads/${PORTAINER_DEPLOY_BRANCH}`,
      composeFile: PORTAINER_COMPOSE_FILE,
      webhookId: webhook,
      env: [],
    });
    stackId = deployed.id;
    await until(
      "the first version live",
      async () => ((await liveVersion()) === versions[0]?.version ? true : undefined),
      TWO_MINUTES,
    );
  }, TEN_MINUTES);

  afterAll(async () => {
    if (stackId !== undefined && token !== "") {
      await portainerClient({ url: portainerUrl }, token)
        .removeStack(stackId, environmentId)
        .catch(() => undefined);
    }
    // Whatever the stack left, by its Compose project's label.
    const label = `label=com.docker.compose.project=${stack}`;
    const left = (await docker(["ps", "-aq", "--filter", label])).stdout
      .split(/\s+/)
      .filter(Boolean);
    if (left.length > 0) await docker(["rm", "-f", "-v", ...left]);
    for (const kind of ["network", "volume"] as const) {
      const ids = (await docker([kind, "ls", "-q", "--filter", label])).stdout
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length > 0) await docker([kind, "rm", ...ids]);
    }
    for (const name of [portainer, gitServer, registry]) await docker(["rm", "-f", "-v", name]);
    await docker(["network", "rm", network]);
    for (const image of images) await docker(["image", "rm", image]);
    for (const at of versions) await docker(["image", "rm", at.image]);
    if (!hadRegistry) await docker(["image", "rm", REGISTRY]);
    await project?.cleanup();
  }, TEN_MINUTES);

  it(
    "redeploys twice through the webhook under a request loop with no failed request, and keeps Caddy",
    async () => {
      const caddy = await containerOf("caddy");
      expect(caddy).not.toBe("");
      // Caddy holds a request up to 30 seconds while the app restarts: a pause, not an error.
      const loop = requestLoop(
        () => httpGet(caddyPort, "shop.example.com", "/", 35_000),
        (answer) => answer.status === 200,
      );
      for (const body of ["v2", "v3"]) {
        const next = await pushVersion(body);
        await commitStack(next);
        const hook = await fetch(`${portainerUrl}/api/stacks/webhooks/${webhook}`, {
          method: "POST",
        });
        expect(hook.status, await hook.text()).toBeLessThan(300);
        await until(
          `${body} live`,
          async () => ((await liveVersion()) === next.version ? true : undefined),
          TWO_MINUTES,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const result = await loop.stop();
      console.info(
        `Two redeploys in Portainer: ${result.requests} requests, ${result.failures.length} failed, the slowest took ${(result.slowestMs / 1000).toFixed(1)} s.`,
      );
      expect(result.failures, `${result.requests} requests`).toEqual([]);
      expect(await containerOf("caddy")).toBe(caddy);
      const app = await fetch(`http://127.0.0.1:${caddyPort}/`);
      expect(await app.text()).toBe("v3");
    },
    TEN_MINUTES,
  );
});
