import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, type Move } from "@opscrew/plan-schema";
import { selfHostedServices } from "../../design/sizing";
import { allocateNetwork, type NetworkHostFacts } from "../../network";
import { splitPlan, withNetwork } from "../../network/__fixtures__/plans";
import type { ProvisionServices } from "../../provision/types";
import { dotenvLine } from "../../shared";
import { generatedValuesFile } from "../../shared/app-secrets";
import { updateServerAddresses } from "../../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  ScriptedApprovalHandler,
  ScriptedRunner,
  SERVER_IPV4,
  testKeyMaker,
} from "../../testing";

/** The app's server and the extra server `data`. */
export const APP_HOST = SERVER_IPV4;
export const DATA_HOST = "203.0.113.30";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const broken = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr });

/** One server's Compose project of the app `shop`, as the move's commands see and change it. */
export class FakeServer implements RemoteExec {
  readonly calls: string[] = [];
  /** The project's running services. */
  readonly running = new Set<string>();
  /** `app.env` (the app's server). */
  env: string | undefined;
  /** What each database service holds, by its name. */
  readonly data = new Map<string, string>();
  /** The move's dump file. */
  dump: string | undefined;
  /** The services whose old copy was deleted (container and data folder). */
  readonly deleted: string[] = [];
  /** The `app.env` each rewrite of Grafana Alloy's masking file was made from. */
  readonly masks: (string | undefined)[] = [];
  /** Commands that match it fail. */
  fail: RegExp | undefined;

  constructor(readonly host: string) {}

  async run(command: string, options: RemoteRunOptions = {}): Promise<CommandResult> {
    this.calls.push(command);
    if (this.fail?.test(command)) return broken("something broke");
    const match = (re: RegExp) => re.exec(command)?.[1] ?? undefined;
    if (command.endsWith("docker compose ps --status running --services")) {
      return ok([...this.running].map((name) => `${name}\n`).join(""));
    }
    if (command === "cat /srv/apps/shop/app.env") {
      return this.env === undefined ? broken("No such file or directory") : ok(this.env);
    }
    if (command.includes("cat > /srv/apps/shop/app.env.opscrew")) {
      this.env = options.input;
      return ok();
    }
    if (command === "bash -s" && options.input?.includes("/srv/apps/shop/mask.re")) {
      this.masks.push(this.env);
      return ok();
    }
    const stopped = match(/docker compose stop (.+)$/);
    if (stopped !== undefined) {
      for (const name of stopped.split(" ")) this.running.delete(name);
      return ok();
    }
    const started = match(/docker compose up -d (.+)$/);
    if (started !== undefined) {
      for (const name of started.split(" ")) this.running.add(name);
      return ok();
    }
    const measured = match(/exec -T (\S+) psql .*pg_database_size/);
    if (measured !== undefined) return ok(`${(this.data.get(measured) ?? "").length}\n`);
    const dumped = match(/exec -T (\S+) pg_dump/);
    if (dumped !== undefined) {
      this.dump = this.data.get(dumped);
      return ok();
    }
    if (command.includes("pg_restore --list")) {
      if (this.dump === undefined) return broken("pg_restore: error: could not open input file");
      return ok(`${sha256(this.dump)}  /srv/apps/shop/opscrew-move.dump\n`);
    }
    const emptied = match(/exec -T (\S+) psql .*DROP DATABASE/);
    if (emptied !== undefined) {
      this.data.set(emptied, "");
      return ok();
    }
    const restored = match(/exec -T (\S+) pg_restore -U app/);
    if (restored !== undefined) {
      this.data.set(restored, this.dump ?? "");
      return ok();
    }
    if (/^rm -f \S+opscrew-move\.dump$/.test(command)) {
      this.dump = undefined;
      return ok();
    }
    if (command.includes("wget")) {
      return this.running.has("app") ? ok() : broken("wget: can't connect to remote host");
    }
    const removed = match(/com\.docker\.compose\.service=(\S+)\)/);
    if (removed !== undefined && command.endsWith(`-rf /d/${removed}`)) {
      this.running.delete(removed);
      this.data.delete(removed);
      this.deleted.push(removed);
      return ok();
    }
    throw new Error(`Unexpected command on ${this.host}: ${command}`);
  }
}

/** What {@link moveWorld} sets up. */
export interface MoveWorldOptions {
  /** The moving service: Postgres `db` (copied) or Valkey `cache` (starts empty). */
  service?: "db" | "cache";
  step?: Move["step"];
  /** `data` is the user's own server, answering SSH on this port. */
  dataPort?: number;
  /** Grafana Cloud is on (Grafana Alloy masks the app's settings in its logs). */
  grafana?: boolean;
}

/**
 * A deployed `shop` on its Hetzner server (`app`) and the extra server `data`, on their private
 * network with the scheduled check on, while `service` moves from `app` to `data` at `step`:
 * - the app's server runs the app and the old copy (Postgres's holds rows), with the app's
 *   settings pointing at it, as provision stored them in `OPSCREW_APP_ENV`;
 * - `data` runs the new copy, empty, as the deploy started it (none at `started`);
 * - the generated passwords on this computer, both addresses in its server record;
 * - fakes for both servers' shells, `scp` (git is real), GitHub and the clock of the health wait.
 */
export async function moveWorld(o: MoveWorldOptions = {}) {
  const service = o.service ?? "db";
  const own = o.dataPort !== undefined;
  const split = splitPlan({ data: own ? "own" : "cloud" });
  const base = {
    ...split,
    services: selfHostedServices({ postgres: true, redis: service === "cache" }).map((s) =>
      s.name === service ? { ...s, server: "data" } : s,
    ),
  };
  const facts: Record<string, NetworkHostFacts> = own
    ? { data: { udpPortsInUse: [], wireguardInterfaces: [] } }
    : {};
  const { network } = allocateNetwork(base, facts, testKeyMaker());
  const step = o.step ?? "started";
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...withNetwork(base, network),
    observability: {
      check: { enabled: true },
      ...(o.grafana === true
        ? {
            grafanaCloud: {
              enabled: true,
              version: "1.21.2",
              metrics: { url: "https://prometheus.example.grafana.net/api/prom/push", user: "1" },
              logs: { url: "https://logs.example.grafana.net/loki/api/v1/push", user: "2" },
            },
          }
        : {}),
    },
    deployment: {
      lastApplyAt: "2026-10-12T08:00:00.000Z",
      firstDeployAt: "2026-10-12T09:00:00.000Z",
      placement: { db: "app", ...(service === "cache" ? { cache: "app" } : {}) },
    },
    move: { service, from: "app", to: "data", step, copy: service === "db" ? "dump" : "empty" },
  });
  const project = await createProject(plan);

  const servers = { app: new FakeServer(APP_HOST), data: new FakeServer(DATA_HOST) };
  const byHost = new Map<string, FakeServer>([
    [APP_HOST, servers.app],
    [DATA_HOST, servers.data],
  ]);
  const scp = { fail: false };
  const git = new NodeCommandRunner();
  const runner = new ScriptedRunner(async (command, args, options) => {
    if (command !== "scp") return git.run(command, args, options);
    const [source, target] = args.slice(-2).map((arg) => byHost.get(/^deploy@([^:]+):/.exec(arg)?.[1] ?? ""));
    if (scp.fail || source === undefined || target === undefined) {
      return broken("scp: Connection closed");
    }
    target.dump = source.dump;
    return ok();
  });
  /** What the user answers to every approval, and types when a name is asked (default: it). */
  const answers: { approve: boolean; typed?: string } = { approve: true };
  const handler = new ScriptedApprovalHandler(() =>
    answers.typed === undefined
      ? answers.approve
      : { approved: answers.approve, confirmation: answers.typed },
  );
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner,
    approvalHandler: handler,
  });
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    ...(own
      ? { ownServers: { data: { host: DATA_HOST, port: o.dataPort, user: "admin", agent: true } } }
      : { servers: { data: { ipv4: DATA_HOST } } }),
  }));
  const passwords = { db: randomBytes(16).toString("hex"), cache: randomBytes(16).toString("hex") };
  const file = generatedValuesFile(deps);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ dbPassword: passwords.db, services: { cache: { password: passwords.cache } } }),
  );

  const dataAddress = plan.network?.members.find((m) => m.name === "data")?.address ?? "";
  const settings = (host: string) =>
    `${[
      dotenvLine("DATABASE_URL", `postgresql://app:${passwords.db}@${service === "db" ? host : "db"}:5432/app`),
      ...(service === "cache"
        ? [dotenvLine("REDIS_URL", `redis://:${passwords.cache}@${host}:6379`)]
        : []),
      dotenvLine("SESSION_SECRET", "kept-as-it-is"),
    ].join("\n")}\n`;
  const env = { before: settings(service), after: settings(dataAddress) };

  servers.app.running.add("app").add("db");
  if (service === "cache") servers.app.running.add("cache");
  servers.app.data.set("db", "rows of the shop");
  // The deploy writes app.env from the secret with a final newline of its own.
  servers.app.env = `${env.before}\n`;
  if (step !== "started") servers.data.running.add(service);
  servers.data.data.set(service, "");

  const github = new FakeGitHub();
  github.secrets.set("OPSCREW_APP_ENV", env.before);
  let clock = 0;
  const services: ProvisionServices = {
    github,
    remote: (host) => {
      const server = byHost.get(host);
      if (server === undefined) throw new Error(`No fake server at ${host}`);
      return server;
    },
    sleep: async () => undefined,
    now: () => {
      clock += 10_000;
      return clock;
    },
  };
  return {
    ...project,
    deps,
    plan,
    servers,
    scp,
    github,
    handler,
    answers,
    services,
    env,
    passwords,
    dataAddress,
  };
}
