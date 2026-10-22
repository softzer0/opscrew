/**
 * The localhost Docker pass (T1513, quickstart "1."): `examples/express-mysql` (Express on MySQL)
 * driven through the real CLI program in-process, offline and without a model, onto this
 * computer's Docker: `init` → `analyze --no-ai` → `interview --answers` (provider localhost) →
 * `design` → `adapt --no-ai --no-push` (the Dockerfile the local build needs) → `provision
 * --plan-only` → `provision --approve <hash>` → `localhost trust` (a script only prints it) →
 * `verify`, `status`, `drift`. Then a second localhost environment beside the first (`env add dev
 * --target localhost`, provisioned the same way), and the teardowns.
 *
 * It checks that:
 * - the site answers at `https://<app>.localhost[:port]` (and `dev.<app>.localhost`) through
 *   127.0.0.1 with the hostname as Host header and SNI (Windows and macOS resolve no `*.localhost`
 *   for Node), trusted only inside the test: a child Node process gets OpsCrew's local CA in
 *   `NODE_EXTRA_CA_CERTS`, and without it the certificate is refused. The computer's trust store is
 *   never changed;
 * - every port the stack publishes is on 127.0.0.1;
 * - the rendered stack differs from a server's only by FR-1504's list (SC-1502,
 *   `localhost-stack.ts`);
 * - destroy leaves nothing, checked by Compose's labels: the data volumes stay without
 *   `--delete-data` and go with it.
 *
 * It pulls and builds images, so it runs only with OPSCREW_DOCKER_TESTS=1 and a running daemon
 * with Linux containers. It refuses to start when this computer already runs OpsCrew's edge or an
 * OpsCrew app of the example's name, which its teardown would remove. Afterwards it removes what
 * it created, by Compose's labels and by name: the containers, networks and volumes, the images it
 * built or pulled (never one Docker already had) and its temp folder. It never prunes.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { caFiles } from "@opscrew/agents";
import type { CommandOptions, CommandResult, CommandRunner } from "@opscrew/contracts";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { EDGE_PROJECT } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import {
  docker,
  dockerSkipReason,
  imageIds,
  projectContainers,
  removeNewImages,
  TEN_MINUTES,
  tail,
} from "./docker-support";
import {
  compareStacks,
  comparisonText,
  localStack,
  onServer,
  serverStack,
} from "./localhost-stack";
import {
  BASE_ANSWERS,
  initRepoWithBareOrigin,
  networkCalls,
  readPlan,
  ScriptedApprovals,
} from "./support";

const EXAMPLE = "express-mysql";
/** The app's name design takes from its package.json. */
const APP = "express-mysql-demo";
const DEV = `${APP}-dev`;
/** The Compose projects the pass creates: the apps' and OpsCrew's shared edge. */
const PROJECTS = [`opscrew-${APP}`, `opscrew-${DEV}`, EDGE_PROJECT];
const VERSION = "9.9.9-test";

const SKIP = dockerSkipReason() ?? (GIT === undefined ? "git is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the localhost Docker pass: ${SKIP}.`);

/**
 * Runs every program for real (Docker, git, the shell) except the GitHub CLI, which reports "not
 * found": the user's `gh` login never reaches the test, and nothing of the local flow needs GitHub.
 */
class NoGitHubCliRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    if (/^gh(?:\.exe)?$/i.test(path.basename(command))) {
      return Promise.resolve({ exitCode: 127, stdout: "", stderr: "not found" });
    }
    return this.#node.run(command, args, options);
  }
}

/** Says how long `what` took, so the pass's output shows its timings. */
async function timed<T>(what: string, step: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await step();
  } finally {
    console.info(`[localhost pass] ${what}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
}

/** `docker <args>`, its output split into names or ids; fails when Docker does. */
async function dockerList(args: string[]): Promise<string[]> {
  const result = await docker(args);
  if (result.exitCode !== 0) throw new Error(`docker ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.split(/\s+/).filter((word) => word !== "");
}

/** The containers, networks and volumes Compose labelled with `project`. */
async function labelled(project: string) {
  const filter = ["--filter", `label=com.docker.compose.project=${project}`];
  return {
    containers: await dockerList(["ps", "-a", "--format", "{{.Names}}", ...filter]),
    networks: await dockerList(["network", "ls", "--format", "{{.Name}}", ...filter]),
    volumes: await dockerList(["volume", "ls", "--format", "{{.Name}}", ...filter]),
  };
}

/** Whether Docker has a network named exactly `name`, and the containers on it. */
async function network(name: string): Promise<{ exists: boolean; containers: number }> {
  const inspected = await docker(["network", "inspect", name, "--format", "{{len .Containers}}"]);
  return inspected.exitCode === 0
    ? { exists: true, containers: Number(inspected.stdout.trim()) }
    : { exists: false, containers: 0 };
}

/** What a request to the local stack got, from a child Node process. */
type Probe = { status: number; names: string } | { error: string };

/** The child's script: one HTTPS GET to 127.0.0.1 with the hostname as Host header and SNI. */
const PROBE = `
const https = require("node:https");
const { port, hostname, path } = JSON.parse(process.env.LOCAL_PROBE);
const host = port === 443 ? hostname : hostname + ":" + port;
https
  .get({ host: "127.0.0.1", port, path, servername: hostname, headers: { Host: host }, agent: false, timeout: 15000 }, (res) => {
    const names = res.socket.getPeerCertificate().subjectaltname ?? "";
    res.resume();
    res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, names })));
  })
  .on("timeout", function () { this.destroy(new Error("timed out")); })
  .on("error", (error) => console.log(JSON.stringify({ error: error.code ?? error.message })));
`;

/**
 * GETs `path` from `https://<hostname>:<port>` through 127.0.0.1 in a child Node process, which
 * trusts OpsCrew's local CA only when `ca` (its certificate file) is given, through
 * `NODE_EXTRA_CA_CERTS`. Nothing else on this computer trusts it.
 */
async function probe(
  site: { hostname: string; port: number },
  path: string,
  ca: string | undefined,
): Promise<Probe> {
  const { NODE_EXTRA_CA_CERTS: _ignored, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", PROBE], {
    env: {
      ...env,
      LOCAL_PROBE: JSON.stringify({ ...site, path }),
      ...(ca === undefined ? {} : { NODE_EXTRA_CA_CERTS: ca }),
    },
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim()) as Probe;
}

/** {@link probe} with the CA, tried for up to a minute until the site answers. */
async function answers(site: { hostname: string; port: number }, path: string, ca: string) {
  let last: Probe = { error: "not tried" };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await probe(site, path, ca);
    if ("status" in last && last.status < 400) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return last;
}

/** The images the stack's Compose files and the app's Dockerfile name, for the cleanup. */
async function stackImages(root: string, plan: DeployPlan): Promise<string[]> {
  const refs: string[] = [];
  for (const file of ["compose.yaml", "edge/compose.yaml"]) {
    const text = await readFile(path.join(root, "opscrew", "runtime", file), "utf8").catch(
      () => "",
    );
    for (const [, ref] of text.matchAll(/^\s+image: (\S+)$/gm)) {
      if (ref !== undefined && !ref.includes("$")) refs.push(ref);
    }
  }
  const dockerfile = await readFile(path.join(root, plan.app.dockerfile), "utf8").catch(() => "");
  for (const [, ref] of dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)) {
    if (ref !== undefined && !ref.includes("$") && ref.includes(":")) refs.push(ref);
  }
  return refs;
}

describe.skipIf(SKIP !== undefined)("the localhost target with real Docker", () => {
  let project: TempProject;
  let images: Set<string>;
  let edgeNetworkBefore = false;
  let ca = "";
  let prod: DeployPlan;
  const refs = new Set([`opscrew-local/${APP}`, `opscrew-local/${DEV}`]);
  const adaptApprovals = new ScriptedApprovals();

  /** Runs `opscrew <args>` with real Docker and git, offline: its exit code and output. */
  async function cli(...args: string[]): Promise<{ code: number; output: string }> {
    const ctx = projectContext(project, {
      services: {
        runner: new NoGitHubCliRunner(),
        // The trust commands name this folder; a script only prints them.
        localhost: { homedir: path.join(project.dir, "user-home") },
        ...(args[0] === "adapt" ? { approvalHandler: adaptApprovals } : {}),
      },
    });
    const code = await timed(`opscrew ${args.join(" ")}`, () => run(ctx, ...args));
    expect(networkCalls(args, ctx.fetchUrls), `opscrew ${args.join(" ")} fetched`).toEqual([]);
    return { code, output: ctx.output + ctx.errors };
  }

  /** {@link cli}, failing with the output when the command fails. */
  async function opscrew(...args: string[]): Promise<string> {
    const { code, output } = await cli(...args);
    if (code !== 0) {
      throw new Error(`\`opscrew ${args.join(" ")}\` exited with ${code}:\n${tail(output, 80)}`);
    }
    return output;
  }

  /** The 64-digit hash `--plan-only` printed for the local plan. */
  function planHash(output: string): string {
    const hash = /--approve ([0-9a-f]{64})/.exec(output)?.[1];
    if (hash === undefined) throw new Error(`No local plan hash in:\n${tail(output, 80)}`);
    return hash;
  }

  /** Plans and applies the environment's local stack, as a script does. */
  async function provision(env: string[]): Promise<{ plan: string; apply: string }> {
    const plan = await opscrew("provision", ...env, "--plan-only", "--yes");
    const apply = await opscrew("provision", ...env, "--approve", planHash(plan), "--yes");
    return { plan, apply };
  }

  beforeAll(async () => {
    for (const name of PROJECTS) {
      const found = await labelled(name);
      if (found.containers.length > 0 || found.volumes.length > 0) {
        throw new Error(
          `Docker on this computer already has OpsCrew's Compose project ${name} (${[...found.containers, ...found.volumes].join(", ")}), which this pass would remove. Remove it with \`opscrew destroy\` in its project, then run the pass again.`,
        );
      }
    }
    const edge = await network(EDGE_PROJECT);
    if (edge.containers > 0) {
      throw new Error(
        `Docker's network ${EDGE_PROJECT} has containers on it, which this pass's teardown would cut off. Stop them, then run the pass again.`,
      );
    }
    edgeNetworkBefore = edge.exists;
    images = await imageIds();
    project = await tempProject(EXAMPLE);
    await initRepoWithBareOrigin(project, `https://github.com/acme/${EXAMPLE}.git`);
    ca = caFiles(resolveProjectPaths(project.root, { env: project.env })).certificate;
  }, TEN_MINUTES);

  afterAll(async () => {
    if (project === undefined) return;
    for (const name of PROJECTS) {
      const left = await labelled(name);
      if (left.containers.length > 0) await docker(["rm", "-f", ...left.containers]);
      for (const net of left.networks) await docker(["network", "rm", net]);
      if (left.volumes.length > 0) await docker(["volume", "rm", "-f", ...left.volumes]);
    }
    const edge = await network(EDGE_PROJECT);
    // The deploy creates the edge's network without a label; put back the one Docker had.
    if (edge.exists && edge.containers === 0 && !edgeNetworkBefore) {
      await docker(["network", "rm", EDGE_PROJECT]);
    }
    if (!edge.exists && edgeNetworkBefore) await docker(["network", "create", EDGE_PROJECT]);
    if (prod !== undefined) for (const ref of await stackImages(project.root, prod)) refs.add(ref);
    await removeNewImages(images, refs);
    await project.cleanup();
  }, TEN_MINUTES);

  it("`opscrew init` passes on a computer with Docker and no cloud token", async () => {
    const init = await cli("init", "--offline", "--fix");
    // As the user would: the .gitignore lines init added are committed before `adapt`.
    await git(project.env, project.root, "commit", "-q", "-am", "opscrew init");
    expect(init.code, tail(init.output, 40)).toBe(0);
  });

  it(
    "plans the app for this computer and runs it there after the local plan's approval",
    async () => {
      await opscrew("analyze", "--no-ai");
      const answersFile = path.join(project.dir, "answers.yaml");
      await writeFile(
        answersFile,
        `${JSON.stringify({ ...BASE_ANSWERS, provider: "localhost" })}\n`,
      );
      await opscrew("interview", "--answers", answersFile);
      await opscrew("design");
      await opscrew("adapt", "--no-ai", "--no-push");
      prod = await readPlan(project.root);
      expect(prod.target).toMatchObject({ provider: "localhost", image: "local-build" });
      expect(prod.dns.provider).toBe("none");

      const { plan, apply } = await provision([]);
      // The preflight (with Docker Desktop's licence once, when it is this computer's Docker) and
      // the local plan, which states how the stack differs from a server's.
      expect(plan).toContain("Checking this computer: Docker, its memory, the ports and the shell");
      const desktop = /docker desktop/i.test(
        (await docker(["info", "--format", "{{.OperatingSystem}}"])).stdout,
      );
      expect(plan.includes("fewer than 250 employees"), "the licence note").toBe(desktop);
      expect(plan).toMatch(
        new RegExp(
          `Local plan for opscrew-${APP} at https://${APP}\\.localhost(:8443)? \\(on 127\\.0\\.0\\.1 only\\)`,
        ),
      );
      expect(plan).toContain(
        "Unlike a server's: no SSH, hardening, firewall, DNS records or Cloudflare",
      );
      expect(apply).toContain(`The app runs on this computer at https://${APP}.localhost`);
      prod = await readPlan(project.root);

      const containers = [
        ...(await projectContainers(`opscrew-${APP}`)),
        ...(await projectContainers(EDGE_PROJECT)),
      ];
      expect(containers.map((c) => c.service).sort()).toEqual(
        ["app", "caddy", "kamal-proxy", "mysql"].sort(),
      );
      for (const container of containers) {
        expect(container.running, container.name).toBe(true);
        for (const port of container.ports) {
          expect(port, `${container.name} publishes ${port}`).toMatch(/^127\.0\.0\.1:\d+$/);
        }
      }
    },
    TEN_MINUTES * 2,
  );

  it("answers at https://<app>.localhost through 127.0.0.1, trusted only with the local CA", async () => {
    if (prod.target.provider !== "localhost") throw new Error("not a localhost plan");
    const site = { hostname: `${APP}.localhost`, port: prod.target.ports.https };
    const trusted = await answers(site, prod.app.healthPath, ca);
    expect(trusted).toEqual({ status: 200, names: `DNS:${site.hostname}` });
    const untrusted = await probe(site, prod.app.healthPath, undefined);
    expect(untrusted).toMatchObject({ error: expect.stringMatching(/CERT|SIGNATURE|ISSUER/) });
  });

  it(
    "`localhost trust` in a script only shows the command; verify, status and drift pass",
    async () => {
      const trust = await opscrew("localhost", "trust");
      expect(trust).toMatch(/certutil|security add-trusted-cert/);
      await opscrew("verify");
      await opscrew("status");
      await opscrew("drift");
    },
    TEN_MINUTES,
  );

  it("differs from the server's stack only by FR-1504's list (SC-1502)", async () => {
    const hostname = `${APP}.localhost`;
    const comparison = compareStacks(
      serverStack(onServer(prod), VERSION),
      await localStack(project.root, prod, { hostname }),
      hostname,
    );
    console.info(
      `[localhost pass] the local stack against a server's:\n${comparisonText(comparison)}`,
    );
    expect(comparison.unlisted, comparisonText(comparison)).toEqual([]);
  });

  it(
    "runs a second environment beside the first, at dev.<app>.localhost",
    async () => {
      await opscrew("env", "add", "dev", "--target", "localhost");
      const dev = await readArtifact(
        "plan",
        path.join(project.root, "opscrew", "environments", "dev", "plan.yaml"),
      );
      expect(dev.app.name).toBe(DEV);
      expect(dev.target).toMatchObject({
        provider: "localhost",
        ports: prod.target.provider === "localhost" ? prod.target.ports : {},
      });
      const { apply } = await provision(["--env", "dev"]);
      expect(apply).toContain(`https://dev.${APP}.localhost`);

      const port = dev.target.provider === "localhost" ? dev.target.ports.https : 0;
      for (const hostname of [`dev.${APP}.localhost`, `${APP}.localhost`]) {
        expect(await answers({ hostname, port }, prod.app.healthPath, ca), hostname).toEqual({
          status: 200,
          names: `DNS:${hostname}`,
        });
      }
      expect((await labelled(`opscrew-${DEV}`)).volumes.length).toBeGreaterThan(0);
      await opscrew("verify", "--env", "dev");
      await opscrew("status", "--env", "prod");
    },
    TEN_MINUTES * 2,
  );

  it(
    "destroy removes everything it created, the data volumes only with --delete-data",
    async () => {
      if (prod.target.provider !== "localhost") throw new Error("not a localhost plan");
      const port = prod.target.ports.https;
      const devVolumes = (await labelled(`opscrew-${DEV}`)).volumes;
      const destroyDev = await opscrew("destroy", "--env", "dev", "--confirm", DEV);
      expect(destroyDev).toContain("--delete-data");
      expect(await labelled(`opscrew-${DEV}`)).toEqual({
        containers: [],
        networks: [],
        volumes: devVolumes,
      });
      // prod still answers on the edge it shares.
      expect(
        await answers({ hostname: `${APP}.localhost`, port }, prod.app.healthPath, ca),
      ).toEqual({ status: 200, names: `DNS:${APP}.localhost` });

      await opscrew("destroy", "--env", "prod", "--confirm", APP, "--delete-data");
      for (const name of [`opscrew-${APP}`, EDGE_PROJECT]) {
        expect(await labelled(name), name).toEqual({ containers: [], networks: [], volumes: [] });
      }
      expect((await network(EDGE_PROJECT)).exists).toBe(false);

      // A later --delete-data run removes the volumes the first teardown kept.
      await opscrew("destroy", "--env", "dev", "--confirm", DEV, "--delete-data");
      expect(await labelled(`opscrew-${DEV}`)).toEqual({
        containers: [],
        networks: [],
        volumes: [],
      });
      // And OpsCrew's folders for the stack on this computer.
      const srv = path.join(
        resolveProjectPaths(project.root, { env: project.env }).homeDir,
        "local",
        "srv",
      );
      for (const folder of ["edge", `apps/${APP}`, `apps/${DEV}`]) {
        expect(existsSync(path.join(srv, folder)), folder).toBe(false);
      }
    },
    TEN_MINUTES,
  );
});
