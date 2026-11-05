/**
 * An environment for advise's run and apply tests: a project on disk with its plan, the servers'
 * recorded addresses and the deploy key; the servers as shells by address (the figures command,
 * `secure`'s host checks and the monitoring stack's Prometheus); GitHub's reads; git's remote.
 * No network and no real server.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
  DependabotAlerts,
  DependabotPull,
  IssueDates,
} from "@opscrew/connector-github";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Requirements,
  writeArtifact,
} from "@opscrew/plan-schema";
import { HOST_CHECKS } from "@opscrew/secops";
import { updateServerAddresses } from "../../shared/server-record";
import {
  createTestPhaseDeps,
  makeRequirements,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../../testing";
import type { AdviseGitHub, ReadingsOptions } from "../readings";
import { type Answer, type Figure, prometheusOutput } from "./prometheus";

export { recordedHistory } from "./prometheus";

/** When advise reads (the recorded Prometheus answers are of this moment). */
export const NOW = new Date("2026-11-04T12:00:00.000Z");

/** Public addresses: none may appear in any output. */
export const IPS = {
  app: "203.0.113.10",
  data: "203.0.113.20",
  stagingApp: "203.0.113.11",
  docsApp: "203.0.113.12",
};

/** The repository's GitHub remote. */
export const REMOTE = "https://github.com/example/example-app.git";

/** `secure`'s host checks answered as on a healthy server, by check id. */
const HEALTHY: Record<string, string> = {
  "setup-finished": "yes",
  "ssh-hardening":
    "PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n",
  fail2ban: "active",
  "unattended-upgrades": "enabled",
  ufw: "",
  "listening-ports": "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n",
  "disk-usage": "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 40 12 28 30% /\n",
  "reboot-required": "no",
  "security-updates": "0",
};

/** One server as a shell. */
export interface FakeHost {
  /** The figures command's output; absent: ssh can't reach the server for it (exit code 255). */
  figures?: string;
  /** Host checks answered otherwise (by id); an `Error` is thrown by the shell. */
  checks?: Record<string, string | Error>;
  /** The monitoring stack's recorded answers (`shop`, prod), when the stack runs here. */
  prometheus?: Partial<Record<Figure, Answer | string>>;
}

/**
 * The servers by address: each answers the figures command, `secure`'s host checks (healthy unless
 * `checks` say) and Prometheus's queries; any other command exits 1. An address not in `hosts` is
 * out of reach, with ssh's message naming it.
 */
export function fakeServers(hosts: Record<string, FakeHost>) {
  const commands: { host: string; command: string }[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command): Promise<CommandResult> {
      commands.push({ host, command });
      const fake = hosts[host];
      const down = {
        exitCode: 255,
        stdout: "",
        stderr: `ssh: connect to host ${host} port 22: Connection timed out`,
      };
      if (fake === undefined) return down;
      if (command.includes("==opscrew-figures:")) {
        return fake.figures === undefined ? down : { exitCode: 0, stdout: fake.figures, stderr: "" };
      }
      if (command.includes("==opscrew-monitoring:") && fake.prometheus !== undefined) {
        return { exitCode: 0, stdout: prometheusOutput(command, fake.prometheus), stderr: "" };
      }
      const check = HOST_CHECKS.find((c) => c.command === command);
      if (check !== undefined) {
        const answer = fake.checks?.[check.id] ?? HEALTHY[check.id] ?? "";
        if (answer instanceof Error) throw answer;
        return { exitCode: check.id === "ufw" && answer !== "" ? 1 : 0, stdout: answer, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  });
  return { remote, commands };
}

/** GitHub's reads with their answers (an `Error` is thrown); every call is recorded. */
export class FakeAdviseGitHub implements AdviseGitHub {
  readonly calls: string[] = [];
  constructor(
    private readonly answers: {
      alerts?: DependabotAlerts | Error;
      pulls?: DependabotPull[] | Error;
      expiry?: string | Error;
      issues?: IssueDates[] | Error;
    } = {},
  ) {}
  private answer<T>(call: string, value: T | Error): Promise<T> {
    this.calls.push(call);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
  dependabotAlerts(owner: string, repo: string): Promise<DependabotAlerts> {
    const alerts = this.answers.alerts ?? { state: "on", alerts: [] };
    return this.answer(`dependabotAlerts ${owner}/${repo}`, alerts);
  }
  dependabotPulls(owner: string, repo: string): Promise<DependabotPull[]> {
    return this.answer(`dependabotPulls ${owner}/${repo}`, this.answers.pulls ?? []);
  }
  issuesSince(owner: string, repo: string, label: string, since: string): Promise<IssueDates[]> {
    const call = `issuesSince ${owner}/${repo} ${label} ${since}`;
    return this.answer(call, this.answers.issues ?? []);
  }
  tokenExpiry(): Promise<string | undefined> {
    return this.answer("tokenExpiry", this.answers.expiry);
  }
}

/** git answering only `remote get-url origin`, with {@link REMOTE}. */
export function gitRunner(): ScriptedRunner {
  return new ScriptedRunner((command, args) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: `${REMOTE}\n`, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "" },
  );
}

/** `plan` as provision leaves it: applied, and its app deployed once. */
export function deployed(plan: Omit<DeployPlan, "network"> | DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    deployment: {
      ...plan.deployment,
      lastApplyAt: "2026-10-20T09:00:00.000Z",
      firstDeployAt: "2026-10-20T09:30:00.000Z",
    },
  });
}

/** `plan` as the plan of the environment `name` (its app's name ends with it). */
export function inEnvironment(plan: DeployPlan, name: string): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name: `${plan.app.name}-${name}` },
    environment: { name },
  });
}

/** What {@link project} writes. */
export interface ProjectInit {
  plan: DeployPlan;
  /** The app's server's address and the extra servers', by name. */
  addresses?: { app?: string; servers?: Record<string, string> };
  /** The interview's answers (prod's); none: not answered. */
  requirements?: Requirements;
  /** The committed `terraform.tfvars.json`: what provision last rendered. */
  tfvars?: Record<string, unknown>;
  root?: string;
  environment?: string;
  app?: string;
  env?: Record<string, string>;
}

/** A project on disk at {@link NOW}, with what `init` says, and git's remote. */
export async function project(init: ProjectInit): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    runner: gitRunner(),
    ...(init.root === undefined ? {} : { root: init.root }),
    ...(init.environment === undefined ? {} : { environment: init.environment }),
    ...(init.app === undefined ? {} : { app: init.app }),
  });
  if (init.env !== undefined) Object.assign(deps.env, init.env);
  await writeArtifact("plan", deps.paths.files.plan, init.plan);
  if (init.requirements !== undefined) {
    await writeArtifact("requirements", deps.paths.files.shared.requirementsBase, init.requirements);
  }
  const { app, servers } = init.addresses ?? {};
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    ...(app === undefined ? {} : { deployment: { ipv4: app } }),
    ...(servers === undefined
      ? {}
      : {
          servers: Object.fromEntries(
            Object.entries(servers).map(([name, ipv4]) => [name, { ipv4 }]),
          ),
        }),
  }));
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  if (init.tfvars !== undefined) {
    const file = join(deps.paths.root, init.plan.infra.dir, "terraform.tfvars.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(init.tfvars, null, 2)}\n`);
  }
  return deps;
}

/** What {@link scenario} sets up. */
export interface ScenarioInit {
  plan: DeployPlan;
  /** The app's server, at `IPS.app`. */
  host: FakeHost;
  /** GitHub's reads; `null`: no token (default: no alert, no pull request, no expiry). */
  github?: FakeAdviseGitHub | null;
  /** The Cloudflare token's check (default: none set). */
  cloudflare?: ReadingsOptions["cloudflare"];
  /** The rest of the project (default: the app's server's address and the interview's answers). */
  init?: Partial<Omit<ProjectInit, "plan">>;
}

/** A scenario: the project, its plan, advise's options, the servers' shells and GitHub. */
export interface Scenario {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  options: ReadingsOptions;
  servers: ReturnType<typeof fakeServers>;
  github: FakeAdviseGitHub | null;
}

/**
 * `plan`'s project on disk, its app's server as `host`, the interview answered (important data),
 * with GitHub and Cloudflare as `o` says.
 */
export async function scenario(o: ScenarioInit): Promise<Scenario> {
  const deps = await project({
    plan: o.plan,
    addresses: { app: IPS.app },
    requirements: makeRequirements({ dataCriticality: "important" }),
    ...o.init,
  });
  const servers = fakeServers({ [IPS.app]: o.host });
  const github = o.github === undefined ? new FakeAdviseGitHub() : o.github;
  const options: ReadingsOptions = {
    services: { remote: servers.remote },
    github,
    cloudflare: o.cloudflare ?? null,
  };
  return { deps, plan: o.plan, options, servers, github };
}

/** Every file under `root` with its content, to show that nothing was written. */
export async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return files;
}
