// Feature 025 (T2506): rotating services' credentials on servers (US1, FR-2501–2505, FR-2512).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type PlanService,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { serviceEnvFiles } from "../provision/secrets";
import type { GitHubApi } from "../provision/types";
import { copyPath } from "../secrets/files";
import { updateServerAddresses } from "../shared";
import { assembleAppEnv } from "../shared/app-env";
import { generatedValuesFile, recordGeneratedEntries } from "../shared/app-secrets";
import {
  DATA_IPV4,
  everythingShown,
  gitRemote,
  splitStagingPlan,
  stagingPlan,
} from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  type TestPhaseDeps,
  testKeyMaker,
  testKeyPair,
} from "../testing";
import { rotateGrant } from "./network-grant";
import { rotationContext } from "./plan";
import { credentialsRecordFile, recordRotation } from "./record";
import { type RotateServicesOptions, rotateDeviceLogin, rotateServices } from "./server";
import { type PendingRotation, pendingRotationFile } from "./values-pending";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const RUN_URL = "https://github.com/acme/shop/actions/runs/7";

/** A value made at run time, as OpsCrew makes one: 32 random bytes as hex. */
const hex = () => randomBytes(32).toString("hex");

/** The wrapper `server.ts` puts around each command: the app's folder, then the deploy user. */
const WRAPPED =
  /^cd '[^']*' \|\| exit 3; if \[ "\$\(id -u\)" = 0 \]; then runuser -u deploy -- sh -c ('(?:[^']|'\\'')*'); else sh -c \1; fi$/s;

/** `'…'` as `shellQuote` writes it, unquoted. */
const unquote = (quoted: string) => quoted.slice(1, -1).replaceAll("'\\''", "'");

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** One run of `rotate.sh` a fake server got. */
interface ScriptRun {
  action: string;
  hash: string;
  /** Its stdin: the env files in base64, then the values. */
  input: string;
  /** The script it ran. */
  script: string;
}

/**
 * A server that runs the app's services, answering the reads of a rotation and playing
 * `rotate.sh`: each run needs its one-time approval of exactly its action and hash; `fail` makes
 * the next run of an action fail (with what the script says); a finished rotation can't be undone.
 */
class FakeServer {
  /** Each command as it ran there, unwrapped. */
  readonly commands: string[] = [];
  readonly runs: ScriptRun[] = [];
  /** The start command of each running service, as Docker holds it. */
  readonly starts = new Map<string, { entrypoint: unknown; cmd: unknown }>();
  /** The app's settings, on the app's server. */
  appEnv: string | undefined;
  /** The next run of an action fails this way. */
  readonly fail = new Map<string, { exitCode: number; stderr: string }>();
  private script = "";
  private approval: string | undefined;
  /** The rotation's state on this server. */
  state: "none" | "begun" | "finished" = "none";

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}

  remote = (host: string): RemoteExec => ({
    host,
    run: async (wrapped, options) => this.handle(wrapped, options?.input ?? ""),
  });

  private handle(wrapped: string, input: string): CommandResult {
    const match = WRAPPED.exec(wrapped);
    if (match?.[1] === undefined) throw new Error(`unexpected command: ${wrapped}`);
    const command = unquote(match[1]);
    this.commands.push(command);
    const starts = /^for s in ([^;\n]*); do/.exec(command);
    if (starts?.[1] !== undefined) {
      const lines = starts[1].split(" ").flatMap((service) => {
        const start = this.starts.get(service);
        if (start === undefined) return [];
        return [
          `entrypoint ${service} ${JSON.stringify(start.entrypoint)}`,
          `cmd ${service} ${JSON.stringify(start.cmd)}`,
        ];
      });
      return ok(`${lines.join("\n")}\n`);
    }
    if (command.includes("cat app.env")) {
      return this.appEnv === undefined ? { exitCode: 4, stdout: "", stderr: "" } : ok(this.appEnv);
    }
    if (command.includes("cat > .rotate/rotate.sh")) {
      this.script = input;
      this.approval = /printf '%s\\n' '([^']*)'/.exec(command)?.[1];
      return ok();
    }
    if (command === "rm -f .rotate/approval") {
      this.approval = undefined;
      return ok();
    }
    const run = /^sh \.rotate\/rotate\.sh (.+)$/.exec(command);
    if (run?.[1] !== undefined) return this.rotate(run[1].split(" "), input);
    throw new Error(`unexpected command: ${command}`);
  }

  private rotate(args: string[], input: string): CommandResult {
    const [first = "", second] = args;
    const action = second === undefined ? "rotate" : first === "--undo" ? "undo" : first;
    const hash = second ?? first;
    const [approved, choice] = (this.approval ?? "").split(" ");
    this.approval = undefined;
    this.runs.push({ action, hash, input, script: this.script });
    this.log.push(`${this.name} ${action}`);
    if (approved !== hash || choice !== action) {
      return { exitCode: 1, stdout: "", stderr: "The one-time approval is for another rotation." };
    }
    const failure = this.fail.get(action);
    if (failure !== undefined) {
      this.fail.delete(action);
      if (action !== "undo") this.state = "begun";
      return { exitCode: failure.exitCode, stdout: "", stderr: failure.stderr };
    }
    if (action === "undo") {
      if (this.state === "finished") {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "This rotation finished, and its old values no longer work, so it can't be undone; nothing was changed.",
        };
      }
      this.state = "none";
      if (this.previousAppEnv !== undefined) this.appEnv = this.previousAppEnv;
      return ok();
    }
    // The app's server writes the app's settings from the first line of its input, as the real
    // script's step 4 does, keeping the old ones until the end.
    if (this.name === APP_SERVER && this.state !== "finished") {
      this.previousAppEnv = this.appEnv;
      this.appEnv = Buffer.from(input.split("\n")[0] ?? "", "base64").toString("utf8");
    }
    this.state = action === "begin" && this.state !== "finished" ? "begun" : "finished";
    return ok();
  }

  private previousAppEnv: string | undefined;
}

/** GitHub's deploy pause, deploy runs and secrets. */
class FakeGitHub {
  /** By `<environment>/<name>` (`/<name>` for a repository secret). */
  readonly secrets = new Map<string, string>();
  variable: string | undefined;
  readonly runs: { status: string; htmlUrl: string }[] = [];
  /** The next set of this secret fails. */
  failSecret: string | undefined;

  constructor(private readonly log: string[]) {}

  async getRepoVariable() {
    return this.variable;
  }
  async setRepoVariable(_owner: string, _repo: string, _name: string, value: string) {
    this.variable = value;
    this.log.push("github pause");
  }
  async deleteRepoVariable() {
    this.variable = undefined;
    this.log.push("github resume");
  }
  async listWorkflowRuns() {
    return this.runs.map((run, i) => ({
      id: i + 1,
      status: run.status,
      conclusion: null,
      htmlUrl: run.htmlUrl,
      headSha: "0".repeat(40),
      createdAt: "2026-11-08T09:00:00Z",
    }));
  }
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.put("", name, value);
  }
  async setEnvironmentSecret(
    _owner: string,
    _repo: string,
    environment: string,
    name: string,
    value: string,
  ) {
    this.put(environment, name, value);
  }
  private put(environment: string, name: string, value: string) {
    if (this.failSecret === name) {
      this.failSecret = undefined;
      throw new OpsCrewError("PROVIDER_ERROR", "GitHub answered 502.");
    }
    this.secrets.set(`${environment}/${name}`, value);
    this.log.push(`github secret ${name}`);
  }
}

/** The generated values OpsCrew keeps for an environment (the part a rotation reads). */
interface Generated {
  dbPassword?: string;
  env: Record<string, string>;
  services: Record<string, Record<string, string>>;
}

/** What a rotation's test works with. */
interface World {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  handler: ScriptedApprovalHandler;
  servers: { app: FakeServer; data: FakeServer };
  github: FakeGitHub;
  /** Everything the servers and GitHub did, in order. */
  log: string[];
  /** The values before the rotation. */
  old: Generated;
  /** The user's own value in the app's settings. */
  dotenv: string;
  run: (names: readonly string[], o?: { undo?: boolean }) => ReturnType<typeof rotateServices>;
}

/** The start command the catalog gives `service`, as Docker holds it once the deploy started it. */
function startOf(plan: DeployPlan, service: PlanService) {
  const spec = serviceSpec(service.kind);
  const ctx = rotationContext(plan, service);
  return {
    entrypoint: spec.entrypoint?.(ctx) ?? ["docker-entrypoint.sh"],
    cmd: spec.command?.(ctx) ?? [service.kind],
  };
}

/** The app's settings with `values`, as provision renders them and the deploy writes them. */
async function appEnvWith(plan: DeployPlan, values: Generated, dotenv: string): Promise<string> {
  return (await assembleAppEnv({ plan, previous: values, dotenvText: dotenv })).appEnv;
}

/**
 * `plan`'s staging environment, deployed: its servers (the app's, and `data`) running each
 * service on the catalog's start command, the app's settings with the values this computer keeps,
 * and GitHub. Approvals answer `answer` (all approved by default).
 */
async function world(
  plan: DeployPlan,
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0],
): Promise<World> {
  const handler = new ScriptedApprovalHandler(answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    environment: "staging",
    approvalHandler: handler,
    runner: gitRemote(),
    clock: { now: () => NOW },
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: SERVER_IPV4 },
    servers: { data: { ipv4: DATA_IPV4 } },
  }));
  const old: Generated = { env: { SESSION_SECRET: hex() }, services: {} };
  for (const service of plan.services) {
    if (service.kind === "postgres") old.dbPassword = hex();
    else {
      old.services[service.name] = Object.fromEntries(
        serviceSpec(service.kind).secrets.map((secret) => [secret.name, hex()]),
      );
    }
  }
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), `${JSON.stringify(old)}\n`);
  const log: string[] = [];
  const servers = { app: new FakeServer("app", log), data: new FakeServer("data", log) };
  for (const service of plan.services) {
    servers[(service.server ?? APP_SERVER) as "app" | "data"].starts.set(
      service.name,
      startOf(plan, service),
    );
  }
  const dotenv = `STRIPE_SECRET_KEY=${hex()}\n`;
  servers.app.appEnv = await appEnvWith(plan, old, dotenv);
  const github = new FakeGitHub(log);
  const byHost: Record<string, FakeServer> = {
    [SERVER_IPV4]: servers.app,
    [DATA_IPV4]: servers.data,
  };
  return {
    deps,
    plan,
    handler,
    servers,
    github,
    log,
    old,
    dotenv,
    run: (names, o = {}) =>
      rotateServices(deps, plan, names, {
        github: { api: github as unknown as GitHubApi, owner: "acme", repo: "shop" },
        remote: (host) => {
          const server = byHost[host];
          if (server === undefined) throw new Error(`no fake server at ${host}`);
          return server.remote(host);
        },
        sleep: async () => {},
        now: () => 0,
        ...o,
      }),
  };
}

/** The generated values on this computer now. */
async function generated(
  w: World,
): Promise<Generated & { history?: unknown; generations?: unknown }> {
  return JSON.parse(await readFile(generatedValuesFile(w.deps), "utf8"));
}

/** The environment's unfinished rotation on this computer, if any. */
async function pending(w: World): Promise<PendingRotation | undefined> {
  const text = await readFile(pendingRotationFile(w.deps), "utf8").catch(() => undefined);
  return text === undefined ? undefined : JSON.parse(text);
}

/** Every old and new value of the pending rotation. */
async function pendingValues(w: World): Promise<string[]> {
  return Object.values((await pending(w))?.services ?? {}).flatMap((secrets) =>
    Object.values(secrets).flatMap((pair) => [pair.old, pair.new]),
  );
}

/** A run's stdin read back: the env files by name (`files`, in order), then the values' lines. */
function readInput(run: ScriptRun, files: readonly string[]) {
  const lines = run.input.replace(/\n$/, "").split("\n");
  return {
    files: Object.fromEntries(
      files.map((file, i) => [file, Buffer.from(lines[i] ?? "", "base64").toString("utf8")]),
    ),
    values: lines.slice(files.length),
  };
}

/** Nothing any output, audit entry, approval, error or server command holds any of `values`. */
function expectNoValue(w: World, values: readonly string[], error?: unknown): void {
  const said = [
    everythingShown(w, error),
    ...Object.values(w.servers).flatMap((server) => server.commands),
    ...Object.values(w.servers).flatMap((server) => server.runs.map((run) => run.script)),
  ].join("\n");
  for (const value of values) expect(said).not.toContain(value);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The secret `name` of staging as GitHub holds it now (a repository secret). */
const secret = (w: World, name: string) => w.github.secrets.get(`/OPSCREW_STAGING_${name}`);

describe("rotateServices on one server", () => {
  it("rotates the database: the plan approved by its hash, GitHub's secrets and rotate.sh with the new values, then the record", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    const result = await w.run(["db"]);

    const fresh = await (async () => {
      const values = await generated(w);
      return { ...w.old, dbPassword: values.dbPassword as string };
    })();
    expect(fresh.dbPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.dbPassword).not.toBe(w.old.dbPassword);
    // GitHub holds the app's settings and the database's env file with the new password, as
    // provision renders them; the deploys were paused around it.
    const appEnv = await appEnvWith(w.plan, fresh, w.dotenv);
    expect(secret(w, "APP_ENV")).toBe(appEnv);
    const dbEnv = serviceEnvFiles(w.plan, {
      values: { app: {}, build: {}, services: { db: { password: fresh.dbPassword } } },
    }).db;
    expect(secret(w, "SERVICE_DB_ENV")).toBe(dbEnv);
    expect(w.log).toEqual([
      "github pause",
      "github secret OPSCREW_STAGING_APP_ENV",
      "github secret OPSCREW_STAGING_SERVICE_DB_ENV",
      "app rotate",
      "github resume",
    ]);
    expect(w.github.variable).toBeUndefined();
    // rotate.sh got the same files and the old and new values on stdin, never on a command line.
    const [run] = w.servers.app.runs;
    expect(run?.hash).toBe(result.hash);
    const input = readInput(run as ScriptRun, ["app.env", "db.env"]);
    expect(input.files).toEqual({ "app.env": appEnv, "db.env": dbEnv });
    expect(input.values).toEqual([w.old.dbPassword, fresh.dbPassword]);
    expect(run?.script).toContain("rotate.sh");

    // The approval: remote-exec, by the hash, naming the swap's window and each step.
    const requests = w.handler.requests.filter((r) => r.kind === "remote-exec");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.planHash).toBe(result.hash);
    expect(requests[0]?.details).toContain("db (PostgreSQL), its password: a short swap");
    expect(requests[0]?.details).toContain(
      "OPSCREW_STAGING_APP_ENV and OPSCREW_STAGING_SERVICE_DB_ENV",
    );
    expect(requests[0]?.details).toContain(`Rotation hash: ${result.hash}`);

    // The record, the values kept and the old one by its generation.
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.staging?.db).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    const after = await generated(w);
    expect(await pending(w)).toBeUndefined();
    expect(after.history).toEqual({ db: { "1": { password: w.old.dbPassword } } });
    expect(after.generations).toEqual({ db: 2 });
    expect(after.env).toEqual(w.old.env);
    expect(result.copy.changed).toBe(false);
    expectNoValue(w, [w.old.dbPassword as string, fresh.dbPassword]);
  });

  it("keeps the earlier generation of each rotation and makes new values every time", async () => {
    const w = await world(
      stagingPlan([
        { kind: "postgres", name: "db" },
        { kind: "valkey", name: "cache" },
      ]),
    );
    const first = await w.run(["cache"]);
    const one = ((await generated(w)).services.cache as Record<string, string>).password;
    w.servers.app.state = "none";
    const second = await w.run(["cache"]);
    expect(second.hash).not.toBe(first.hash);
    const values = await generated(w);
    expect(values.history).toEqual({
      cache: { "1": { password: w.old.services.cache?.password }, "2": { password: one } },
    });
    expect(values.generations).toEqual({ cache: 3 });
    const approval = w.handler.requests.find((r) => r.kind === "remote-exec");
    expect(approval?.details).toContain("cache (Valkey), its password: seamless");
  });

  it("changes only this computer's values of a service that is off", async () => {
    const plan = stagingPlan([
      { kind: "postgres", name: "db" },
      { kind: "valkey", name: "cache" },
    ]);
    const off = {
      ...plan,
      services: plan.services.map((s) => (s.name === "cache" ? { ...s, enabled: false } : s)),
    };
    const w = await world(off);
    await w.run(["cache"]);
    expect(w.log).toEqual([]);
    expect(w.servers.app.commands).toEqual([]);
    const values = await generated(w);
    expect(values.services.cache?.password).not.toBe(w.old.services.cache?.password);
    expect(w.handler.requests[0]?.details).toContain("cache (Valkey) is off");
  });
});

describe("rotateServices with split placement", () => {
  it("runs each extra server's begin before the app's server's run and its finish after, each with its own approval", async () => {
    const w = await world(splitStagingPlan());
    const result = await w.run(["db", "cache"]);
    expect(w.log).toEqual([
      "github pause",
      "github secret OPSCREW_STAGING_APP_ENV",
      "github secret OPSCREW_STAGING_SERVICE_DB_ENV",
      "github secret OPSCREW_STAGING_SERVICE_CACHE_ENV",
      "data begin",
      "app rotate",
      "data finish",
      "github resume",
    ]);
    const fresh = await generated(w);
    const next: Generated = { ...w.old, dbPassword: fresh.dbPassword, services: fresh.services };
    // The extra server's run has no app.env: only the database's env file and its values.
    const [begin, finish] = w.servers.data.runs;
    expect(begin?.hash).toBe(result.hash);
    expect(finish?.hash).toBe(result.hash);
    const services = {
      db: { password: next.dbPassword as string },
      cache: next.services.cache as Record<string, string>,
    };
    const dbEnv = serviceEnvFiles(w.plan, { values: { app: {}, build: {}, services } }).db;
    expect(readInput(begin as ScriptRun, ["db.env"])).toEqual({
      files: { "db.env": dbEnv },
      values: [w.old.dbPassword, next.dbPassword],
    });
    expect(begin?.script).toContain("begin <hash>");
    const app = readInput(w.servers.app.runs[0] as ScriptRun, ["app.env", "cache.env"]);
    expect(app.files["app.env"]).toBe(await appEnvWith(w.plan, next, w.dotenv));
    expect(app.values).toEqual([w.old.services.cache?.password, next.services.cache?.password]);
    const details = w.handler.requests.find((r) => r.kind === "remote-exec")?.details ?? "";
    expect(details).toContain("db (PostgreSQL) on server data, its password: a short swap");
    expect(details).toContain("cache (Valkey) on the app's server, its password: seamless");
    expect(details).toContain("On server data (rotate.sh begin)");
    expect(details).toContain("On server data (rotate.sh finish)");
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(Object.keys(record.environments.staging ?? {}).sort()).toEqual(["cache", "db"]);
    expectNoValue(w, [
      w.old.dbPassword as string,
      w.old.services.cache?.password as string,
      fresh.dbPassword as string,
      fresh.services.cache?.password as string,
    ]);
  });
});

describe("rotateServices when a step fails", () => {
  it("keeps the values when GitHub refuses a secret, changes no server, and goes on when run again", async () => {
    const w = await world(splitStagingPlan());
    w.github.failSecret = "OPSCREW_STAGING_SERVICE_DB_ENV";
    const error = await failure(w.run(["db", "cache"]));
    expect(error.message).toContain("GitHub answered 502.");
    expect(error.message).toContain("No server was changed yet.");
    expect(error.hint).toContain("`opscrew rotate db cache` again");
    expect(error.hint).toContain("`opscrew rotate db cache --undo`");
    expect(w.log.filter((line) => !line.startsWith("github"))).toEqual([]);
    // GitHub may hold some new values: the deploys stay paused until the rotation goes on or is undone.
    expect(error.message).toContain(
      "the app's deploys stay paused (OPSCREW_DEPLOY_PAUSED) until `opscrew rotate db cache` or `opscrew rotate db cache --undo` finishes",
    );
    expect(w.log).not.toContain("github resume");
    // The rotation's own entry, by its hash: no move or rollback reads it as theirs.
    expect(JSON.parse(w.github.variable ?? "{}")).toMatchObject({
      "shop/staging": { reason: "rotation", hash: (await pending(w))?.hash },
    });
    const values = await pendingValues(w);
    expect(values).toHaveLength(4);
    expectNoValue(w, values, error);

    // The rotation's own pause doesn't stop it from going on, and its end resumes the deploys.
    const first = w.handler.requests[0]?.planHash;
    const result = await w.run(["db", "cache"]);
    expect(result.hash).toBe(first);
    expect(await pending(w)).toBeUndefined();
    expect(w.github.variable).toBeUndefined();
  });

  it("stops at an extra server's begin, says how to go on or undo, and goes on with the same values", async () => {
    const w = await world(splitStagingPlan());
    w.servers.data.fail.set("begin", {
      exitCode: 1,
      stderr:
        "The rotation stopped at step 3 of 6 (changing db to its new value), so deploys stay held.",
    });
    const error = await failure(w.run(["db", "cache"]));
    expect(error.message).toContain("stopped on server data");
    expect(error.message).toContain("step 3 of 6 (changing db to its new value)");
    expect(error.message).toContain("The old and the new values stay on this computer");
    expect(error.hint).toContain("`opscrew rotate db cache --undo`");
    expect(w.servers.app.runs).toEqual([]);
    expect(w.log).not.toContain("github resume");
    expect(w.github.variable).toBeDefined();
    const values = await pendingValues(w);
    expectNoValue(w, values, error);

    await w.run(["db", "cache"]);
    const [failed, again] = w.servers.data.runs;
    expect(again?.hash).toBe(failed?.hash);
    expect(again?.input).toBe(failed?.input);
    expect(w.log.slice(-4)).toEqual(["data begin", "app rotate", "data finish", "github resume"]);
  });

  it("puts the old values back after the app's server's run failed: there first, then on the extra server, then in GitHub", async () => {
    const w = await world(splitStagingPlan());
    w.servers.app.fail.set("rotate", {
      exitCode: 1,
      stderr: "The rotation stopped at step 5 of 6 (switching the app to the new values).",
    });
    const error = await failure(w.run(["db", "cache"]));
    expect(error.hint).toContain("--undo");
    const rotationHash = w.servers.app.runs[0]?.hash as string;
    const values = await pendingValues(w);

    w.log.length = 0;
    const undone = await w.run(["db", "cache"], { undo: true });
    expect(w.log).toEqual([
      "github pause",
      "app undo",
      "data undo",
      "github secret OPSCREW_STAGING_APP_ENV",
      "github secret OPSCREW_STAGING_SERVICE_DB_ENV",
      "github secret OPSCREW_STAGING_SERVICE_CACHE_ENV",
      "github resume",
    ]);
    expect(w.servers.app.runs.at(-1)?.hash).toBe(rotationHash);
    expect(undone.hash).not.toBe(rotationHash);
    const undo = w.handler.requests.at(-1);
    expect(undo?.planHash).toBe(undone.hash);
    expect(undo?.details).toContain(`Undo hash: ${undone.hash}`);
    // GitHub holds the old values again, and this computer only the old ones.
    expect(secret(w, "APP_ENV")).toBe(await appEnvWith(w.plan, w.old, w.dotenv));
    const after = await generated(w);
    expect(await pending(w)).toBeUndefined();
    expect(after.dbPassword).toBe(w.old.dbPassword);
    expect(after.services).toEqual(w.old.services);
    expect(after.history).toBeUndefined();
    await expect(readFile(credentialsRecordFile(w.deps.paths), "utf8")).rejects.toThrow();
    expectNoValue(w, values);
  });

  it("only goes forward once the app's server finished: no undo after an extra server's finish failed", async () => {
    const w = await world(splitStagingPlan());
    w.servers.data.fail.set("finish", { exitCode: 1, stderr: "server data is out of disk space." });
    const error = await failure(w.run(["db", "cache"]));
    expect(error.hint).toContain("only goes forward");
    expect(error.hint).not.toContain("--undo");
    expect(error.message).toContain(
      "stay paused (OPSCREW_DEPLOY_PAUSED) until `opscrew rotate db cache` finishes",
    );
    expect(w.github.variable).toBeDefined();
    const before = secret(w, "APP_ENV");

    const refused = await failure(w.run(["db", "cache"], { undo: true }));
    expect(refused.message).toContain("can't be undone");
    expect(refused.hint).toContain("run `opscrew rotate db cache` to finish it");
    expect(w.servers.data.runs.filter((run) => run.action === "undo")).toEqual([]);
    expect(secret(w, "APP_ENV")).toBe(before);
    expect((await pending(w))?.step).toBe("switched");

    await w.run(["db", "cache"]);
    expect(await pending(w)).toBeUndefined();
    expect(w.servers.data.runs.at(-1)?.action).toBe("finish");
    expect(w.github.variable).toBeUndefined();
  });
});

describe("rotateServices refuses before any change", () => {
  /** Nothing in GitHub or on the servers changed, and no value was made. */
  async function expectUntouched(w: World) {
    expect(w.log).toEqual([]);
    expect(Object.values(w.servers).flatMap((server) => server.runs)).toEqual([]);
    expect(await pending(w)).toBeUndefined();
  }

  it("while a service runs on its start command from before 025, saying a deploy puts it on the new one", async () => {
    const w = await world(
      stagingPlan([
        { kind: "postgres", name: "db" },
        { kind: "valkey", name: "cache" },
      ]),
    );
    w.servers.app.starts.set("cache", {
      entrypoint: ["docker-entrypoint.sh"],
      cmd: ["valkey-server"],
    });
    const error = await failure(w.run(["cache"]));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "cache (Valkey) on the app's server still runs on a start command from before",
    );
    expect(error.hint).toContain("`opscrew provision`");
    await expectUntouched(w);
  });

  it("while a service does not run", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    w.servers.app.starts.delete("db");
    const error = await failure(w.run(["db"]));
    expect(error.message).toContain("db (PostgreSQL) is not running on the app's server");
    await expectUntouched(w);
  });

  it("while a move, a rotation not begun here or a rollback pauses the deploys", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]), [false]);
    // A rotation of db only planned here (its approval refused) accepts no pause, even its hash's.
    await failure(w.run(["db"]));
    const planned = (await pending(w)) as PendingRotation;
    expect(planned.step).toBe("planned");
    const asked = w.handler.requests.length;
    w.github.variable = JSON.stringify({
      "shop/staging": { reason: "rotation", since: "2026-11-08T09:00:00Z", hash: planned.hash },
    });
    // Only planned here, it can't be the one that paused: that one began on another computer.
    const rotating = await failure(w.run(["db"]));
    expect(rotating.message).toContain(
      "paused since 2026-11-08T09:00:00Z for a credential rotation's window, begun on another computer",
    );
    expect(w.handler.requests).toHaveLength(asked);
    await w.run(["db"], { undo: true });
    // Without the file here, likewise.
    const elsewhere = await failure(w.run(["db"]));
    expect(elsewhere.message).toContain(
      "a credential rotation's window, begun on another computer",
    );
    w.github.variable = JSON.stringify({
      "shop/staging": { reason: "move", since: "2026-11-08T09:00:00Z" },
    });
    const moving = await failure(w.run(["db"]));
    expect(moving.message).toContain("paused for a move");
    w.github.variable = JSON.stringify({
      "shop/staging": {
        reason: "rollback",
        since: "2026-11-08T09:00:00Z",
        image: `sha256:${"b".repeat(64)}`,
        commit: "abc1234def",
      },
    });
    const pinned = await failure(w.run(["db"]));
    expect(pinned.message).toContain("which would end that pin");
    expect(pinned.hint).toContain("`opscrew rollback --resume`");
    await expectUntouched(w);
  });

  it("while a deploy runs", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    w.github.runs.push({ status: "in_progress", htmlUrl: RUN_URL });
    const error = await failure(w.run(["db"]));
    expect(error.message).toContain(RUN_URL);
    await expectUntouched(w);
  });

  it("when another computer rotated a value since (the two-computer guard)", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    await recordRotation(w.deps, ["db"]);
    const values = await generated(w);
    await writeFile(
      generatedValuesFile(w.deps),
      `${JSON.stringify({ ...values, generations: {} })}\n`,
    );
    const error = await failure(w.run(["db"]));
    expect(error.hint).toContain("opscrew secrets restore");
    await expectUntouched(w);
  });

  it("while another rotation is unfinished, for a name of no service, and for nothing to undo", async () => {
    const w = await world(splitStagingPlan());
    w.servers.data.fail.set("begin", { exitCode: 1, stderr: "stopped" });
    await failure(w.run(["db"]));
    const other = await failure(w.run(["cache"]));
    expect(other.message).toContain("The rotation of db in staging is unfinished");
    expect(other.hint).toContain("`opscrew rotate db --undo`");
    const unknown = await failure(w.run(["queue"]));
    expect(unknown.code).toBe("INVALID_INPUT");
    await w.run(["db"], { undo: true });
    const none = await failure(w.run(["db"], { undo: true }));
    expect(none.message).toContain("nothing to undo");
  });

  it("when the plan is not approved: the next run asks the same hash, and one of other services replaces it", async () => {
    const w = await world(
      stagingPlan([
        { kind: "postgres", name: "db" },
        { kind: "valkey", name: "cache" },
      ]),
      [false, true, false],
    );
    const error = await failure(w.run(["db"]));
    expect(error.code).toBe("APPROVAL_REFUSED");
    const refused = w.handler.requests[0]?.planHash as string;
    expect(error.hint).toContain(`--approve ${refused}`);
    expect(w.log).toEqual([]);
    expect(await pending(w)).toMatchObject({ names: ["db"], hash: refused, step: "planned" });
    const result = await w.run(["db"]);
    expect(result.hash).toBe(refused);

    // Planned only, nothing changed: a rotation of another service replaces it.
    await failure(w.run(["cache"]));
    expect(await pending(w)).toMatchObject({ names: ["cache"], step: "planned" });
    await failure(w.run(["db"]));
    expect((await pending(w))?.names).toEqual(["db"]);

    // Its undo only forgets it: no approval, no server, no GitHub, no recovery copy.
    const asked = w.handler.requests.length;
    const copy = join(w.deps.paths.root, copyPath(w.deps.paths));
    const copied = await exists(copy);
    w.log.length = 0;
    const forgotten = await w.run(["db"], { undo: true });
    expect(forgotten.copy).toEqual({ changed: false });
    expect(await exists(copy)).toBe(copied);
    expect(await pending(w)).toBeUndefined();
    expect(w.handler.requests).toHaveLength(asked);
    expect(w.log).toEqual([]);
  });

  it("when a rotation that began finds a move's pause, or another rotation's, in place of its own", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    w.servers.app.fail.set("rotate", { exitCode: 1, stderr: "stopped" });
    await failure(w.run(["db"]));
    expect((await pending(w))?.step).toBe("started");
    w.github.variable = JSON.stringify({
      "shop/staging": { reason: "move", since: "2026-11-08T09:00:00Z" },
    });
    w.log.length = 0;
    expect((await failure(w.run(["db"]))).message).toContain("paused for a move");
    w.github.variable = JSON.stringify({
      "shop/staging": { reason: "rotation", since: "2026-11-08T09:00:00Z", hash: "c".repeat(64) },
    });
    expect((await failure(w.run(["db"]))).message).toContain("so this rotation can't begin");
    expect(w.log).toEqual([]);
  });

  it("when an unfinished rotation began under another plan, whose hash its servers hold", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    w.servers.app.fail.set("rotate", { exitCode: 1, stderr: "stopped" });
    await failure(w.run(["db"]));
    const started = (await pending(w)) as PendingRotation;
    expect(started.step).toBe("started");
    await writeFile(
      pendingRotationFile(w.deps),
      `${JSON.stringify({ ...started, hash: "c".repeat(64) })}\n`,
    );
    // Its pause, kept since it stopped, names the hash it began with.
    w.github.variable = JSON.stringify({
      "shop/staging": { reason: "rotation", since: "2026-11-08T09:00:00Z", hash: "c".repeat(64) },
    });
    w.log.length = 0;
    const error = await failure(w.run(["db"]));
    expect(error.message).toContain("began under another plan");
    expect(w.log).toEqual([]);
  });

  it("when the unfinished rotation began in the user's Portainer or on this computer", async () => {
    for (const [target, where] of [
      ["portainer", "in your Portainer"],
      ["localhost", "on this computer"],
    ] as const) {
      const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
      w.servers.app.fail.set("rotate", { exitCode: 1, stderr: "stopped" });
      await failure(w.run(["db"]));
      const started = (await pending(w)) as PendingRotation;
      await writeFile(pendingRotationFile(w.deps), `${JSON.stringify({ ...started, target })}\n`);
      w.log.length = 0;
      const error = await failure(w.run(["db"]));
      expect(error.message).toContain(`The rotation of db began ${where}`);
      expect(error.message).toContain("Nothing was changed.");
      expect(error.hint).toContain("Finish it with `opscrew rotate db`");
      expect(error.hint).toContain("`opscrew rotate db --undo`");
      // Refused before any server or GitHub call.
      expect(w.log).toEqual([]);
    }
  });

  it("reuses only the values of a Portainer rotation planned here, so its own failed run goes on", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]), [false, true, true]);
    await failure(w.run(["db"]));
    const planned = (await pending(w)) as PendingRotation;
    // As a planned rotation of Portainer or this computer leaves it: its progress beside the values.
    await writeFile(
      pendingRotationFile(w.deps),
      `${JSON.stringify({ ...planned, target: "portainer", stackPlanHash: "d".repeat(64), done: 0 })}\n`,
    );
    w.servers.app.fail.set("rotate", { exitCode: 1, stderr: "stopped" });
    await failure(w.run(["db"]));
    const started = (await pending(w)) as PendingRotation;
    expect(started.step).toBe("started");
    expect(started).not.toHaveProperty("target");
    expect(started).not.toHaveProperty("stackPlanHash");
    expect(started).not.toHaveProperty("done");
    expect(started.services).toEqual(planned.services);
    w.servers.app.fail.delete("rotate");
    await w.run(["db"]);
    expect(await pending(w)).toBeUndefined();
  });

  it("when the app's settings hold the old password in a value of the user's own", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]));
    w.servers.app.appEnv = `${w.servers.app.appEnv}MY_DB=user=app password=${w.old.dbPassword}\n`;
    const error = await failure(w.run(["db"]));
    expect(error.message).toContain("in a way OpsCrew doesn't write it");
    expect(w.log).toEqual([]);
    expectNoValue(w, [w.old.dbPassword as string], error);
  });
});

/** Staging with `db` and the Valkey `cache` on its network, and device laptop's login to cache. */
function grantedPlan(): DeployPlan {
  const services = [
    { kind: "postgres", name: "db" },
    { kind: "valkey", name: "cache" },
  ] as const;
  const { network } = allocateNetwork(stagingPlan(services), {}, testKeyMaker("server"));
  const prefix = network.range.split(".").slice(0, 3).join(".");
  return stagingPlan(services, {
    fields: {
      network: {
        ...network,
        devices: [
          {
            name: "laptop",
            address: `${prefix}.100`,
            publicKey: testKeyPair("laptop").publicKey,
            addedAt: "2026-10-30T10:00:00.000Z",
          },
        ],
        grants: [{ device: "laptop", service: "cache", access: "read-only" }],
      },
    },
  });
}

/** The options `w.run` passes, for the other entries. */
function serversOf(w: World): RotateServicesOptions {
  const byHost: Record<string, FakeServer> = {
    [SERVER_IPV4]: w.servers.app,
    [DATA_IPV4]: w.servers.data,
  };
  return {
    github: { api: w.github as unknown as GitHubApi, owner: "acme", repo: "shop" },
    remote: (host) => (byHost[host] as FakeServer).remote(host),
    sleep: async () => {},
    now: () => 0,
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("rotateDeviceLogin: a device's own login to Valkey", () => {
  async function granted() {
    const w = await world(grantedPlan());
    const old = randomBytes(16).toString("hex");
    await recordGeneratedEntries(w.deps, "grants", { "laptop/cache": old });
    return { w, old, cache: w.plan.services.find((s) => s.name === "cache") as PlanService };
  }

  it("adds the new password beside the old under the deploys' pause, then drops the old, and shows it once", async () => {
    const { w, old } = await granted();

    const result = await rotateGrant(w.deps, w.plan, "laptop", "cache", { servers: serversOf(w) });

    const password = result.connection?.password as string;
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(password).not.toBe(old);
    expect(result.connection?.client).toContain("redis-cli");
    // The deploys paused around GitHub's secrets and the server's run: the cache's env file holds
    // only the new password's SHA-256.
    expect(w.log).toEqual([
      "github pause",
      "github secret OPSCREW_STAGING_APP_ENV",
      "github secret OPSCREW_STAGING_SERVICE_CACHE_ENV",
      "app rotate",
      "github resume",
    ]);
    const cacheEnv = secret(w, "SERVICE_CACHE_ENV") as string;
    expect(cacheEnv).toContain(sha256(password));
    expect(cacheEnv).not.toContain(sha256(old));
    // rotate.sh's one step: the grant's begin (the new password beside the old) and finish (the old
    // one dropped), the passwords only on its stdin; the app's settings as they were.
    const [run] = w.servers.app.runs;
    expect(run?.hash).toBe(result.hash);
    expect(run?.script).toContain("ACL SETUSER laptop >%s");
    expect(run?.script).toContain("ACL SETUSER laptop <%s");
    const input = readInput(run as ScriptRun, ["app.env", "cache.env"]);
    expect(input.files["cache.env"]).toBe(cacheEnv);
    expect(input.files["app.env"]).toBe(await appEnvWith(w.plan, w.old, w.dotenv));
    expect(input.values).toEqual([old, password]);

    const request = w.handler.requests.find((r) => r.kind === "remote-exec");
    expect(request?.title).toBe("Rotate the credentials of grant:laptop/cache in staging");
    expect(request?.details).toContain("laptop's login to cache (Valkey): seamless for the app");
    expect(request?.planHash).toBe(result.hash);

    const after = JSON.parse(await readFile(generatedValuesFile(w.deps), "utf8"));
    expect(after.grants).toEqual({ "laptop/cache": password });
    expect(after.services).toEqual(w.old.services);
    expect(await pending(w)).toBeUndefined();
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.staging?.["grant:laptop/cache"]).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    // Shown once: only in the result, never in any output, audit entry, approval or command.
    expect(w.deps.reporter.text()).toContain("The connection details are shown only now.");
    expectNoValue(w, [old, password]);
  });

  it("keeps both passwords after a failed run, then puts the old one back with --undo", async () => {
    const { w, old, cache } = await granted();
    w.servers.app.fail.set("rotate", {
      exitCode: 1,
      stderr: "The rotation stopped at step 3 of 6.",
    });

    const error = await failure(
      rotateDeviceLogin(w.deps, w.plan, { device: "laptop", service: cache }, serversOf(w)),
    );
    expect(error.hint).toContain("`opscrew rotate grant:laptop/cache --undo`");
    const kept = await pending(w);
    expect(kept?.names).toEqual(["grant:laptop/cache"]);
    expect(kept?.grants?.["laptop/cache"]?.old).toBe(old);
    expect(w.github.variable).toBeDefined();

    const undone = await rotateDeviceLogin(
      w.deps,
      w.plan,
      { device: "laptop", service: cache },
      { ...serversOf(w), undo: true },
    );

    expect(undone.password).toBeUndefined();
    expect(w.log.slice(-4)).toEqual([
      "app undo",
      "github secret OPSCREW_STAGING_APP_ENV",
      "github secret OPSCREW_STAGING_SERVICE_CACHE_ENV",
      "github resume",
    ]);
    expect(secret(w, "SERVICE_CACHE_ENV")).toContain(sha256(old));
    const after = JSON.parse(await readFile(generatedValuesFile(w.deps), "utf8"));
    expect(after.grants).toEqual({ "laptop/cache": old });
    expect(await pending(w)).toBeUndefined();
    expect(w.github.variable).toBeUndefined();
    expectNoValue(w, [old, kept?.grants?.["laptop/cache"]?.new as string], error);
  });
});
