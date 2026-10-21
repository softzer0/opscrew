/**
 * Support for feature 014's Docker pass (`edge.test.ts` and the files next to it): an example's
 * plan designed by the real CLI, the shared edge OpsCrew renders for it run on this computer with
 * the deploy's own commands, Pebble as the ACME server, a stand-in app behind kamal-proxy, a local
 * CA standing in for Cloudflare's Origin CA, and HTTPS probes and request loops from this computer.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type tls from "node:tls";
import { deploymentFiles } from "@opscrew/agents";
import type { CommandResult } from "@opscrew/contracts";
import { buildCsr, findExecutable, generateP256, NodeCommandRunner } from "@opscrew/core";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import {
  EDGE_PROJECT,
  EDGE_PROXIES,
  type EdgeProxy,
  edgeProxy,
  IMAGES,
  type RuntimeContext,
  siteHosts,
} from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { parse, stringify } from "yaml";
import type { CliServices } from "../../src/deps";
import {
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import {
  type ComposeProject,
  compose,
  composeOk,
  docker,
  LABEL,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
} from "./docker-support";
import { BASE_ANSWERS, readPlan, ScriptedApprovals } from "./support";

/** OpenSSL on this computer, for the local CA (the origin TLS scenario skips without it). */
export const OPENSSL = findExecutable("openssl");

/** A POSIX shell on this computer (Git Bash on Windows), where the deploy's commands run here. */
export const SH = findExecutable("sh");

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });

/** The environment of the commands run here: Git Bash leaves container paths alone. */
const ENV = { ...process.env, MSYS_NO_PATHCONV: "1" };

/** Fails with the end of a command's output when it exited non-zero or timed out. */
function checked(result: CommandResult, what: string): string {
  if (result.exitCode !== 0 || result.timedOut) {
    const failure = result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`;
    throw new Error(`${what} ${failure}:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
  }
  return result.stdout;
}

/** Runs `command args` on this computer; fails with the end of its output on a non-zero exit. */
async function runOk(command: string, args: string[], what: string): Promise<string> {
  return checked(await runner.run(command, args, { env: ENV, timeoutMs: TWO_MINUTES }), what);
}

/** Runs `script` with {@link SH} on this computer (`input` on its stdin). */
export function shell(script: string, timeoutMs = TWO_MINUTES, input?: string) {
  if (SH === undefined) throw new Error("No POSIX shell on this computer.");
  return runner.run(SH, ["-c", script], {
    env: ENV,
    timeoutMs,
    ...(input === undefined ? {} : { input }),
  });
}

/** `docker <args>`; fails with the end of its output when it exits non-zero. */
export async function dockerOk(args: string[], what: string, timeoutMs = TWO_MINUTES) {
  return checked(await docker(args, timeoutMs), what).trim();
}

/** Whether this computer's Docker has the image `ref` (a test removes the helpers it pulled). */
export async function hasImage(ref: string): Promise<boolean> {
  return (await docker(["image", "inspect", ref])).exitCode === 0;
}

/** A free TCP port on 127.0.0.1, where a test publishes a container's port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no free port")),
      );
    });
  });
}

/** Waits until `check` gives a value (not undefined), trying every `everyMs` for at most `ms`. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 60_000,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) {
      throw new Error(`${what} did not happen within ${ms / 1000} s${last ? ` (${last})` : ""}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** A folder for a test, which the test removes. */
export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** A unique name for a container, network or volume of a test. */
export function unique(prefix: string): string {
  return `opscrew-test-${prefix}-${randomBytes(4).toString("hex")}`;
}

/**
 * `examples/<example>` designed by the real CLI, offline and without a model (`analyze --no-ai` →
 * `interview --answers` → `design`), with `answers` over {@link BASE_ANSWERS} (a Hetzner server by
 * default), then `edit` applied to `opscrew/plan.yaml` as a user would. `services` are the CLI's
 * services for the interview (a fake Portainer); `interview` its extra flags.
 */
export async function designedPlan(
  example: string,
  answers: Record<string, unknown>,
  o: {
    edit?: (plan: DeployPlan) => DeployPlan;
    services?: CliServices;
    interview?: string[];
    env?: Record<string, string>;
  } = {},
): Promise<{ project: TempProject; plan: DeployPlan }> {
  const project = await tempProject(example);
  const { env, root, dir } = project;
  Object.assign(env, o.env);
  await git(env, root, "init", "-q", "-b", "main");
  await git(env, root, "add", "-A");
  await git(env, root, "commit", "-q", "-m", "initial import");
  const runtime = new FakeAgentRuntime();
  const approvals = new ScriptedApprovals();
  const opscrew = async (...args: string[]) => {
    const ctx = projectContext(project, {
      services: { runtime, approvalHandler: approvals, ...o.services },
    });
    const code = await run(ctx, ...args);
    if (code !== 0) {
      throw new Error(
        `\`opscrew ${args.join(" ")}\` exited with ${code}:\n${tail(ctx.output + ctx.errors)}`,
      );
    }
  };
  const file = path.join(dir, "answers.yaml");
  await writeFile(file, `${JSON.stringify({ ...BASE_ANSWERS, ...answers }, null, 2)}\n`);
  await opscrew("analyze", "--no-ai");
  await opscrew("interview", "--answers", file, ...(o.interview ?? []));
  await opscrew("design");
  if (o.edit !== undefined) {
    const planFile = path.join(root, "opscrew", "plan.yaml");
    await writeArtifact("plan", planFile, DeployPlanSchema.parse(o.edit(await readPlan(root))));
  }
  return { project, plan: await readPlan(root) };
}

/** The plan as a user edits it: the app's name, the proxy and the hostnames. */
export function withSite(
  plan: DeployPlan,
  o: { edge?: EdgeProxy; name?: string; domain?: string; www?: boolean; proxied?: boolean },
): DeployPlan {
  if (plan.target.provider === "portainer") throw new Error("Not a server target.");
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name: o.name ?? plan.app.name },
    target: { ...plan.target, edge: o.edge ?? plan.target.edge },
    dns: {
      ...plan.dns,
      domain: o.domain ?? plan.dns.domain,
      www: o.www ?? plan.dns.www,
      proxied: o.proxied ?? plan.dns.proxied,
    },
  });
}

/** What provision renders an app's files with besides the plan (none of it a secret). */
export function renderContext(
  o: Pick<RuntimeContext, "originTls" | "additions"> = {},
): RuntimeContext & { acmeEmail: string } {
  return {
    opscrewVersion: "0.0.0-test",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "",
    acmeEmail: "ops@example.com",
    cloudflare: { zoneId: "0123456789abcdef0123456789abcdef" },
    ...o,
  };
}

/** Pebble, Let's Encrypt's test ACME server, on a test network as `pebble` ("Spike results" 13). */
export interface Pebble {
  container: string;
  /** The root of Pebble's own HTTPS certificate, which Caddy is told to trust. */
  root: string;
}

/** certbot's flags for Pebble: its directory, without checking Pebble's own certificate. */
const PEBBLE_CERTBOT_FLAGS = "--server https://pebble:14000/dir --no-verify-ssl";

/** Starts Pebble on `network`, validating every challenge (`PEBBLE_VA_ALWAYS_VALID=1`). */
export async function startPebble(network: string, dir: string): Promise<Pebble> {
  const container = unique("pebble");
  await dockerOk(
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      LABEL,
      "--network",
      network,
      "--network-alias",
      "pebble",
      "-e",
      "PEBBLE_VA_ALWAYS_VALID=1",
      // Pebble refuses 5% of nonces by default, which certbot does not retry.
      "-e",
      "PEBBLE_WFE_NONCEREJECT=0",
      IMAGES.pebble.ref,
    ],
    "starting Pebble",
  );
  // The image has no shell: its test CA is copied out.
  const root = path.join(dir, "pebble.minica.pem");
  await dockerOk(["cp", `${container}:/test/certs/pebble.minica.pem`, root], "copying Pebble's CA");
  return { container, root };
}

/** The text the stand-in app sends first on a WebSocket. */
export const WEBSOCKET_HELLO = "hello over a websocket";

/**
 * The stand-in app (Node.js, `node -e`): 200 with `body` on every path, a WebSocket upgrade
 * answered with 101 and one text frame ({@link WEBSOCKET_HELLO}), and a prompt exit on SIGTERM.
 */
export function standInScript(body: string, port: number): string {
  return [
    'const crypto = require("node:crypto");',
    'process.on("SIGTERM", () => process.exit(0));',
    `const server = require("node:http").createServer((q, s) => s.end(${JSON.stringify(body)}));`,
    'server.on("upgrade", (req, socket) => {',
    '  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");',
    '  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");',
    `  const text = Buffer.from(${JSON.stringify(WEBSOCKET_HELLO)});`,
    "  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));",
    "});",
    `server.listen(${port});`,
  ].join("\n");
}

/** Starts the stand-in app ({@link standInScript}) as the container `name` on `network`. */
export async function startStandIn(network: string, name: string, port: number, body: string) {
  await dockerOk(
    [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      LABEL,
      "--network",
      network,
      "--user",
      "node",
      IMAGES.nodeAlpine.ref,
      "node",
      "-e",
      standInScript(body, port),
    ],
    `starting the stand-in app ${name}`,
  );
}

/**
 * Opens a WebSocket to `wss://<host>/` through 127.0.0.1:`port` and returns the first text it
 * receives.
 */
export function websocketHello(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port,
      servername: host,
      path: "/",
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
      rejectUnauthorized: false,
      agent: false,
      timeout: 10_000,
    });
    request.on("upgrade", (_response, socket, head) => {
      let data = head;
      const check = () => {
        if (!data.includes(WEBSOCKET_HELLO)) return;
        socket.destroy();
        resolve(WEBSOCKET_HELLO);
      };
      socket.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        check();
      });
      check();
    });
    request.on("response", (response) =>
      reject(new Error(`no upgrade: HTTP ${response.statusCode}`)),
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** The app's origin TLS on the server, as the deploy leaves it in `/srv/edge/tls/<app>`. */
export interface OriginFiles {
  certificate: string;
  key: string;
  /** The client certificate Cloudflare presents (public). */
  pull: string;
}

/** What one app's deploy brings to the edge. */
export interface EdgeDeploy {
  plan: DeployPlan;
  origin?: OriginFiles;
  /** The user's additions for the plan's proxy. */
  additions?: string;
}

/**
 * The deploy's commands for the shared edge, taken from the deploy workflow OpsCrew renders for
 * the plan (its server script, `switchCommands`). certbot's are there only on nginx.
 */
function deployCommands(workflow: string) {
  const find = (pattern: RegExp) => pattern.exec(workflow)?.[1];
  const up = find(/if ! (edge up -d --wait --remove-orphans) \|\| ! /);
  const reload = find(/--remove-orphans \|\| ! (edge exec -T [^\n]*? < \/dev\/null); then/);
  if (up === undefined || reload === undefined) {
    throw new Error("The rendered deploy workflow does not start and reload the edge.");
  }
  return {
    up,
    reload,
    /** certbot's volumes given to the deploy user. */
    chown: find(
      /^\s*(edge run --rm --no-deps -T --user 0:0 --cap-add CHOWN [^\n]*< \/dev\/null)$/m,
    ),
    /** Whether certbot already has the app's certificate (exit 0). */
    hasCertificate: find(
      /if (edge run --rm --no-deps -T --entrypoint test certbot [^\n]*? < \/dev\/null); then/,
    ),
    /** certbot's `certonly`, without its `< /dev/null`. */
    certonly: find(
      /out="\$\((edge run --rm --no-deps -T --entrypoint certbot certbot certonly [^\n]*?) < \/dev\/null 2>&1\)"/,
    ),
    /** The renewal setting written into certbot's renewal file. */
    renewBefore: find(
      /^\s*(edge run --rm --no-deps -T --entrypoint sh certbot -c [^\n]*< \/dev\/null)$/m,
    ),
  };
}

/** A command {@link deployCommands} found, or an error naming `what`. */
function required(command: string | undefined, what: string): string {
  if (command === undefined) throw new Error(`The rendered deploy workflow has no ${what}.`);
  return command;
}

/**
 * OpsCrew's shared edge (`/srv/edge` on a server) in a folder of this computer, as one Compose
 * project. Its Compose file is the one OpsCrew renders, adapted only where this computer differs:
 * the external network `opscrew-edge` is the test's network, the proxy publishes its HTTP and
 * HTTPS ports on 127.0.0.1 at `ports` (without HTTP/3), and Caddy uses Pebble as its ACME server.
 * {@link LocalEdge.deploy} runs the deploy's own edge commands (`edge …`, see
 * {@link deployCommands}) with {@link SH}, with certbot pointed at Pebble.
 */
export class LocalEdge {
  readonly project: ComposeProject;

  constructor(
    readonly dir: string,
    readonly network: string,
    readonly ports: { http: number; https: number },
    readonly pebble: Pebble,
  ) {
    this.project = { name: unique("edge"), file: path.join(dir, "compose.yaml") };
  }

  /** Runs `script` (POSIX sh) with the deploy's `edge` function for this project. */
  edgeShell(script: string, timeoutMs = TEN_MINUTES) {
    const file = this.project.file.replaceAll("\\", "/");
    return shell(
      `edge() { docker compose -p ${this.project.name} -f '${file}' "$@"; }\n${script}`,
      timeoutMs,
    );
  }

  /** {@link edgeShell} that fails with the script's output when it exits non-zero. */
  async edgeOk(script: string, what: string, timeoutMs = TEN_MINUTES): Promise<string> {
    return checked(await this.edgeShell(script, timeoutMs), what);
  }

  /** `docker compose <args>` on the edge's project; fails with its output on a non-zero exit. */
  compose(args: string[], what: string, timeoutMs = TWO_MINUTES) {
    return composeOk(this.project, what, args, timeoutMs);
  }

  /** The id of the running container of the edge's `service`, if any. */
  async containerId(service: string): Promise<string | undefined> {
    const listed = await compose(this.project, ["ps", "-q", service]);
    return listed.stdout.trim() || undefined;
  }

  /** The rendered edge Compose file adapted to this computer (see {@link LocalEdge}). */
  #localCompose(content: string, proxy: EdgeProxy): string {
    const doc = parse(content) as {
      services: Record<string, { ports?: string[]; volumes?: string[] }>;
      networks: Record<string, Record<string, unknown>>;
      configs: Record<string, { content: string }>;
    };
    doc.networks[EDGE_PROJECT] = { external: true, name: this.network };
    const front = doc.services[proxy];
    if (front === undefined) throw new Error(`The rendered edge has no ${proxy} service.`);
    const inner = proxy === "nginx" ? { http: 8080, https: 8443 } : { http: 80, https: 443 };
    front.ports = [
      `127.0.0.1:${this.ports.http}:${inner.http}`,
      `127.0.0.1:${this.ports.https}:${inner.https}`,
    ];
    const main = doc.configs.caddyfile;
    if (proxy === "caddy" && main !== undefined) {
      main.content = `{\n\tacme_ca https://pebble:14000/dir\n\tacme_ca_root /test/pebble.minica.pem\n}\n${main.content}`;
      front.volumes = [...(front.volumes ?? []), "./pebble.minica.pem:/test/pebble.minica.pem:ro"];
    }
    return stringify(doc, { lineWidth: 0 });
  }

  /**
   * One app's deploy on the edge, as `switchCommands` does it (without the lock and the rollback):
   * the edge's Compose file, on nginx the deploy user's `.env` and certbot's volumes; the app's
   * origin TLS files, its site (on nginx the one before the first certificate until certbot has
   * one) and its additions; `up -d --wait --remove-orphans` and the reload; then on nginx certbot's
   * `certonly` against Pebble, the renewal setting, the HTTPS site and the reload.
   */
  async deploy(app: EdgeDeploy): Promise<void> {
    const { plan } = app;
    const proxy = edgeProxy(plan);
    const ctx = renderContext({
      ...(app.origin !== undefined ? { originTls: { hostnames: siteHosts(plan) } } : {}),
      ...(app.additions !== undefined ? { additions: true } : {}),
    });
    const files = new Map(
      deploymentFiles(plan, ctx, app.origin ? { ORIGIN_PULL_CERT: app.origin.pull } : {}).map(
        (file) => [file.path, file.content],
      ),
    );
    const rendered = (file: string) => {
      const content = files.get(file);
      if (content === undefined) throw new Error(`OpsCrew rendered no ${file}.`);
      return content;
    };
    const commands = deployCommands(rendered(plan.cicd.workflowPath));
    const name = plan.app.name;
    const { site: ext } = EDGE_PROXIES[proxy];
    await mkdir(path.join(this.dir, "sites"), { recursive: true });
    await mkdir(path.join(this.dir, "tls"), { recursive: true });
    await writeFile(path.join(this.dir, "pebble.minica.pem"), await readFile(this.pebble.root));
    await writeFile(
      this.project.file,
      this.#localCompose(rendered("opscrew/runtime/edge/compose.yaml"), proxy),
    );
    if (proxy === "nginx") {
      await this.edgeOk(
        `printf 'OPSCREW_DEPLOY_UID=%s\\nOPSCREW_DEPLOY_GID=%s\\n' "$(id -u)" "$(id -g)" > '${this.dir.replaceAll("\\", "/")}/.env'`,
        "writing the deploy user to the edge's .env",
      );
    }
    const tlsDir = path.join(this.dir, "tls", name);
    await rm(tlsDir, { recursive: true, force: true });
    if (app.origin !== undefined) {
      await mkdir(tlsDir, { recursive: true });
      await writeFile(path.join(tlsDir, "origin.pem"), app.origin.certificate);
      await writeFile(path.join(tlsDir, "origin.key"), app.origin.key);
      await writeFile(path.join(tlsDir, "pull.pem"), rendered("opscrew/runtime/edge/tls/pull.pem"));
    }
    const certbot = files.has(`opscrew/runtime/edge/sites/${name}.http.conf`);
    if (proxy === "nginx") {
      await this.edgeOk(
        required(commands.chown, "chown of certbot's volumes"),
        "giving certbot's volumes to the deploy user",
      );
    }
    const site = path.join(this.dir, "sites", `${name}.${ext}`);
    const first =
      certbot &&
      (await this.edgeShell(required(commands.hasCertificate, "certificate check"))).exitCode !== 0;
    await writeFile(
      site,
      rendered(`opscrew/runtime/edge/sites/${name}.${first ? "http.conf" : ext}`),
    );
    const additions = path.join(this.dir, "sites", `${name}.additions`);
    if (app.additions !== undefined) await writeFile(additions, app.additions);
    else await rm(additions, { force: true });
    await this.edgeOk(`${commands.up} && ${commands.reload}`, "starting the edge and reloading it");
    if (certbot) {
      const certonly = required(commands.certonly, "certbot certonly");
      await this.edgeOk(
        `${certonly.replace(" --deploy-hook ", ` ${PEBBLE_CERTBOT_FLAGS} --deploy-hook `)} < /dev/null`,
        "certbot's certonly",
      );
      await this.edgeOk(
        required(commands.renewBefore, "renewal setting"),
        "certbot's renewal setting",
      );
      await writeFile(site, rendered(`opscrew/runtime/edge/sites/${name}.conf`));
      await this.edgeOk(commands.reload, "reloading nginx with the HTTPS site");
    }
  }

  /** The deploy's reload of the plan's proxy, which keeps the running configuration on an error. */
  reload(plan: DeployPlan) {
    const files = deploymentFiles(plan, renderContext());
    const workflow = files.find((file) => file.path === plan.cicd.workflowPath)?.content ?? "";
    return this.edgeShell(deployCommands(workflow).reload);
  }

  /**
   * Hands the app to the edge's kamal-proxy at `target` (`<container>:<port>`), as the deploy
   * hands each new copy, with the plan's hostnames and health path.
   */
  async route(plan: DeployPlan, target: string): Promise<void> {
    const [domain, ...others] = siteHosts(plan);
    await this.compose(
      [
        "exec",
        "-T",
        "kamal-proxy",
        "kamal-proxy",
        "deploy",
        plan.app.name,
        "--target",
        target,
        ...(domain === undefined
          ? []
          : others.length === 0
            ? ["--host", domain]
            : ["--host", [domain, ...others].join(","), "--canonical-host", domain]),
        "--health-check-path",
        plan.app.healthPath,
      ],
      `routing ${plan.app.name} on kamal-proxy`,
    );
  }

  /**
   * Removes the edge's containers and volumes (also those of a proxy it switched from, which its
   * Compose file no longer names), and its folder.
   */
  async remove(): Promise<void> {
    await compose(this.project, ["down", "-v", "--remove-orphans"]);
    const label = `label=com.docker.compose.project=${this.project.name}`;
    const volumes = (await docker(["volume", "ls", "-q", "--filter", label])).stdout.split(/\s+/);
    for (const volume of volumes.filter(Boolean)) await docker(["volume", "rm", volume]);
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** What a visitor got over HTTPS: the status, the headers, the body and the certificate served. */
export interface HttpsAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  certificate: tls.PeerCertificate;
  protocol: string | null;
}

/** Options of {@link httpsGet}: the path, the client certificate and the TLS versions offered. */
export interface HttpsOptions {
  path?: string;
  cert?: string;
  key?: string;
  minVersion?: tls.SecureVersion;
  maxVersion?: tls.SecureVersion;
}

/** GET `https://<host><path>` through 127.0.0.1:`port`, without checking the certificate. */
export function httpsGet(port: number, host: string, o: HttpsOptions = {}): Promise<HttpsAnswer> {
  return new Promise((resolve, reject) => {
    const old = o.maxVersion === "TLSv1" || o.maxVersion === "TLSv1.1";
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        servername: host,
        path: o.path ?? "/",
        headers: { host },
        rejectUnauthorized: false,
        agent: false,
        timeout: 10_000,
        ...(o.cert !== undefined ? { cert: o.cert, key: o.key } : {}),
        ...(o.minVersion !== undefined ? { minVersion: o.minVersion } : {}),
        ...(o.maxVersion !== undefined ? { maxVersion: o.maxVersion } : {}),
        // This computer's OpenSSL offers TLS 1.0 and 1.1 only at security level 0.
        ...(old ? { ciphers: "DEFAULT:@SECLEVEL=0" } : {}),
      },
      (response) => {
        const socket = response.socket as tls.TLSSocket;
        const certificate = socket.getPeerCertificate();
        const protocol = socket.getProtocol();
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            certificate,
            protocol,
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** GET `http://<host><path>` through 127.0.0.1:`port`: the status and headers. */
export function httpGet(
  port: number,
  host: string,
  urlPath = "/",
  timeoutMs = 10_000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        headers: { host },
        agent: false,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** What a {@link requestLoop} saw. */
export interface LoopResult {
  requests: number;
  failures: string[];
  /** The longest time from the last good request before a failure to the next good one. */
  longestOutageMs: number;
  /** The longest a single request took (a pause visitors see). */
  slowestMs: number;
}

/**
 * Sends `request` again and again, one after the other, until stopped. A request fails when it
 * throws or `ok` refuses its answer.
 */
export function requestLoop<T>(
  request: () => Promise<T>,
  ok: (answer: T) => boolean,
): { stop(): Promise<LoopResult> } {
  let running = true;
  let requests = 0;
  const failures: string[] = [];
  let lastGood = Date.now();
  let outageFrom: number | undefined;
  let longestOutageMs = 0;
  let slowestMs = 0;
  const loop = (async () => {
    while (running) {
      requests++;
      let failure: string | undefined;
      const sent = Date.now();
      try {
        const answer = await request();
        if (!ok(answer)) failure = `unexpected answer ${JSON.stringify(answer).slice(0, 200)}`;
      } catch (error) {
        failure = (error as Error).message;
      }
      const now = Date.now();
      slowestMs = Math.max(slowestMs, now - sent);
      if (failure === undefined) {
        if (outageFrom !== undefined) longestOutageMs = Math.max(longestOutageMs, now - outageFrom);
        outageFrom = undefined;
        lastGood = now;
      } else {
        failures.push(`${new Date(now).toISOString()} ${failure}`);
        outageFrom ??= lastGood;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      if (outageFrom !== undefined) {
        longestOutageMs = Math.max(longestOutageMs, Date.now() - outageFrom);
      }
      return { requests, failures, longestOutageMs, slowestMs };
    },
  };
}

/** A local certificate authority standing in for Cloudflare's Origin CA (OpenSSL, made now). */
export class LocalCa {
  private constructor(readonly dir: string) {}

  /** A new CA in `dir`, valid for two days. */
  static async create(dir: string): Promise<LocalCa> {
    if (OPENSSL === undefined) throw new Error("OpenSSL is not installed.");
    await mkdir(dir, { recursive: true });
    await runOk(
      OPENSSL,
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/O=OpsCrew test/CN=Local Origin CA",
        "-keyout",
        path.join(dir, "ca.key"),
        "-out",
        path.join(dir, "ca.pem"),
      ],
      "creating the local CA",
    );
    return new LocalCa(dir);
  }

  /**
   * An origin certificate from OpsCrew's own certificate request for `hostnames` (`buildCsr`,
   * which provision sends Cloudflare), signed for 15 years with the request's hostnames.
   */
  async originCertificate(
    hostnames: readonly string[],
  ): Promise<{ certificate: string; key: string }> {
    if (OPENSSL === undefined) throw new Error("OpenSSL is not installed.");
    const key = generateP256().privateKey;
    const csr = path.join(this.dir, `${hostnames[0]}.csr`);
    const out = path.join(this.dir, `${hostnames[0]}.pem`);
    await writeFile(csr, buildCsr({ key, hostnames }));
    await runOk(
      OPENSSL,
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        path.join(this.dir, "ca.pem"),
        "-CAkey",
        path.join(this.dir, "ca.key"),
        "-CAcreateserial",
        "-days",
        "5475",
        "-copy_extensions",
        "copyall",
        "-out",
        out,
      ],
      "signing the origin certificate",
    );
    return { certificate: await readFile(out, "utf8"), key };
  }
}
