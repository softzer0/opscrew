/**
 * A fake computer for the localhost target's tests: Docker as the runner answers it (`docker info`,
 * Compose's version, the containers, networks and volumes by their Compose labels), the shell
 * that records every script piped to it, and HTTPS through 127.0.0.1. Nothing runs Docker.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalHandler, CommandResult } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { createTestPhaseDeps, ScriptedRunner, testPlan } from "../../testing";
import type { LocalRequestInput, LocalResponse } from "../https";
import type { LocalRegistry } from "../image";
import type { LocalhostServices } from "../services";

/** The shell the fake computer has. */
export const SHELL = "/bin/sh";

/** A digest of the app's image on the fake GHCR. */
export const DIGEST = `sha256:${"ab".repeat(32)}`;

/** One object Docker has, with its Compose project's label. */
interface DockerObject {
  name: string;
  project?: string;
}

/** A container Docker has. */
export interface FakeContainer extends DockerObject {
  service: string;
  running: boolean;
  ports?: string;
}

/** `shop` (PostgreSQL, no secret the user gives) on this computer. */
export function localPlan(
  o: { environment?: string; image?: "registry" | "local-build"; arch?: "amd64" | "arm64" } = {},
): DeployPlan {
  const base = testPlan({ userSecret: false });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: o.environment === undefined ? "shop" : `shop-${o.environment}` },
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: o.arch ?? "amd64",
      ports: { https: 8443, http: 8080 },
      image: o.image ?? "local-build",
      edge: "caddy",
    },
    dns: { provider: "none", proxied: false },
    cost: { ...base.cost, monthly: { amount: 0, currency: "EUR" }, breakdown: [] },
    ...(o.environment === undefined ? {} : { environment: { name: o.environment } }),
  });
}

/** The fake computer: its Docker, its shell's scripts and the stack's HTTPS answers. */
export class FakeComputer {
  /** `docker info`'s answer; `missing` when Docker is not installed, `stopped` when not running. */
  info:
    | { MemTotal: number; OperatingSystem: string; OSType: string; Architecture: string }
    | "missing"
    | "stopped" = {
    MemTotal: 8 * 1024 ** 3,
    OperatingSystem: "Docker Desktop",
    OSType: "linux",
    Architecture: "x86_64",
  };
  compose: string | undefined = "2.38.2";
  /** The daemon of Docker's current context, as `docker context inspect` prints it. */
  dockerHost = "unix:///var/run/docker.sock";
  containers: FakeContainer[] = [];
  networks: DockerObject[] = [];
  volumes: DockerObject[] = [];
  /** Ports something else listens on, on 127.0.0.1. */
  busy = new Set<number>();
  /** Every script the shell ran, in order. */
  readonly scripts: { script: string; input: string }[] = [];
  /** Every other program the runner was asked to start. */
  readonly commands: { command: string; args: string[] }[] = [];
  /** HTTPS and HTTP requests to the stack. */
  readonly requests: LocalRequestInput[] = [];
  /** What a script answers (default: success, a local build's tag for a build). */
  script: (script: string) => CommandResult = (script) =>
    script.includes("docker build")
      ? { exitCode: 0, stdout: "opscrew-local/shop:0123456789ab\n", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
  /** What the stack answers. */
  answer: (input: LocalRequestInput) => LocalResponse = (input) =>
    input.scheme === "http"
      ? { status: 308, location: `https://${input.hostname}:8443/` }
      : input.path.startsWith("/.")
        ? { status: 404 }
        : {
            status: 200,
            certificate: { subjectAltName: `DNS:${input.hostname}`, validTo: "Oct 11 12:00:00 2027 GMT" },
          };
  readonly digests = new Map<string, string>([["opscrew-prod", DIGEST]]);
  /** The GitHub token the registry login sends (made at test time). */
  readonly registryToken = fakeSecret("github-token", "localhost-registry");

  readonly runner = new ScriptedRunner((command, args, options) => this.run(command, args, options?.input));

  /** The localhost services of this computer. */
  services(o: { platform?: NodeJS.Platform; arch?: string } = {}): LocalhostServices {
    const registry: LocalRegistry = {
      image: "ghcr.io/acme/shop",
      taggedDigest: async (tag) => this.digests.get(tag),
      login: async () => ({ username: "acme", token: this.registryToken }),
    };
    return {
      platform: o.platform ?? "linux",
      arch: o.arch ?? "x64",
      portFree: async (port) => !this.busy.has(port),
      which: (name) => (name === "sh" ? SHELL : undefined),
      request: async (input) => {
        this.requests.push(input);
        return this.answer(input);
      },
      computerName: "test-laptop",
      homedir: "/home/me",
      registry,
      sleep: async () => {},
    };
  }

  private project(args: readonly string[]): string | undefined {
    const filter = args[args.indexOf("--filter") + 1] ?? "";
    return /^label=com\.docker\.compose\.project=(.+)$/.exec(filter)?.[1];
  }

  private run(command: string, args: readonly string[], input: string | undefined): CommandResult {
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (command === SHELL) {
      const script = (input ?? "").replace(/^\{\n/, "").replace(/\n\} ; exit \$\?\n[\s\S]*$/, "");
      this.scripts.push({ script, input: input ?? "" });
      return this.script(script);
    }
    if (command !== "docker") {
      this.commands.push({ command, args: [...args] });
      return ok("");
    }
    const [first, second] = args;
    if (first === "info") {
      if (this.info === "missing") throw new OpsCrewError("COMMAND_FAILED", "docker: not found");
      if (this.info === "stopped") return { exitCode: 1, stdout: "", stderr: "Cannot connect" };
      return ok(JSON.stringify(this.info));
    }
    if (this.info === "missing") throw new OpsCrewError("COMMAND_FAILED", "docker: not found");
    if (first === "compose" && second === "version") {
      return this.compose === undefined ? { exitCode: 1, stdout: "", stderr: "" } : ok(`${this.compose}\n`);
    }
    if (first === "context" && second === "inspect") return ok(`${this.dockerHost}\n`);
    const project = this.project(args);
    const named = (objects: DockerObject[]) =>
      objects.filter((o) => project === undefined || o.project === project).map((o) => o.name);
    if (first === "ps") {
      return ok(
        this.containers
          .filter((c) => c.project === project)
          .map((c) => `${c.name}|${c.running ? "running" : "exited"}|${c.service}|False|${c.ports ?? ""}`)
          .join("\n"),
      );
    }
    if (first === "network" && second === "ls") return ok(named(this.networks).join("\n"));
    if (first === "volume" && second === "ls") return ok(named(this.volumes).join("\n"));
    if (first === "inspect") {
      // As OpsCrew's Compose files run them: no privileges, no host namespaces, no new privileges.
      const names = args.slice(3);
      return ok(
        names
          .map((name) => `/${name}|false|${this.network(name)}|private|["no-new-privileges:true"]|`)
          .join("\n"),
      );
    }
    return ok("");
  }

  /** The network mode `docker inspect` reports for a container (`host` when a test says so). */
  network: (container: string) => string = () => "bridge";

  /** The stack as a deploy leaves it: the app's and the edge's containers, networks and volumes. */
  deployed(app = "shop"): this {
    const project = `opscrew-${app}`;
    this.containers.push(
      { name: `${project}-app-1`, project, service: "app", running: true },
      { name: `${project}-db-1`, project, service: "db", running: true },
      {
        name: "opscrew-edge-caddy-1",
        project: "opscrew-edge",
        service: "caddy",
        running: true,
        ports: "127.0.0.1:8080->80/tcp, 127.0.0.1:8443->443/tcp",
      },
      { name: "opscrew-edge-kamal-proxy-1", project: "opscrew-edge", service: "kamal-proxy", running: true },
    );
    this.networks.push({ name: `${project}_internal`, project }, { name: "opscrew-edge" });
    this.volumes.push(
      { name: `${project}_db_data`, project },
      ...["caddy_data", "caddy_config", "kamal-proxy-config"].map((volume) => ({
        name: `opscrew-edge_${volume}`,
        project: "opscrew-edge",
      })),
    );
    return this;
  }
}

/**
 * Phase deps of a fresh project with the localhost plan written (for `o.environment`, beside
 * `o.prod`, prod's plan), and the fake computer. `o.home` shares an OpsCrew home with another
 * project, as two repositories on one computer do.
 */
export async function localProject(
  plan: DeployPlan = localPlan(),
  computer = new FakeComputer(),
  o: {
    environment?: string;
    prod?: DeployPlan;
    home?: string;
    approve?: ApprovalHandler;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-localhost-"));
  await mkdir(join(root, "opscrew"), { recursive: true });
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: o.home ?? join(root, ".home-opscrew") },
    runner: computer.runner,
    ...(o.environment !== undefined ? { environment: o.environment } : {}),
    ...(o.approve !== undefined ? { approvalHandler: o.approve } : {}),
  });
  if (o.prod !== undefined) await writeArtifact("plan", join(root, "opscrew", "plan.yaml"), o.prod);
  await writeArtifact("plan", deps.paths.files.plan, plan);
  return { deps, computer, root };
}
