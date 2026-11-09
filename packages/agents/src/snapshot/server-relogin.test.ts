// Feature 025 (T2520): whole-server restores after a rotation (plan.md 12., FR-2512).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppServer, CommandResult, RemoteExec, ServerSnapshotApi } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { checkEnvironmentKey, serviceSpec } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { GitHubApi } from "../provision/types";
import { rotationContext } from "../rotate/plan";
import { credentialsRecordFile } from "../rotate/record";
import { assembleAppEnv } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import { SERVER_IPV4 } from "../testing";
import {
  DATA_IPV4,
  everythingShown,
  type SnapshotWorld,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "./__fixtures__/world";
import { restoreServerSnapshot } from "./server";

/** The password a service has now (generation `n` of the record) and had before, made at runtime. */
const pw = (name: string) => fakeSecret("generic-password", name);
const DB = { g1: pw("db-1"), g2: pw("db-2"), g3: pw("db-3") };
const SQL = {
  app1: pw("sql-app-1"),
  root1: pw("sql-root-1"),
  app2: pw("sql-app-2"),
  root2: pw("sql-root-2"),
};
const CACHE = pw("cache-now");
/** The user's own value in the app's settings. */
const DOTENV = `STRIPE_SECRET_KEY=${pw("stripe")}\n`;
/** The app's own generated secret, the same before and after. */
const ENV = { SESSION_SECRET: pw("session") };
const VALUES = [...Object.values(DB), ...Object.values(SQL), CACHE, ENV.SESSION_SECRET];

/** The whole-server snapshots at the provider, taken before the rotations of 2026-11-07. */
const SNAPSHOT = { id: "770011", createdAt: "2026-11-05T08:00:00Z", sizeGb: 2 };
const DATA_SNAPSHOT = { id: "770099", createdAt: "2026-11-05T08:00:00Z", sizeGb: 2 };
const ROTATED_AT = "2026-11-07T10:00:00.000Z";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** The wrapper the hosts put around each command: the app's folder, then the deploy user. */
const WRAPPED =
  /^cd '[^']*' \|\| exit 3; if \[ "\$\(id -u\)" = 0 \]; then runuser -u deploy -- sh -c ('(?:[^']|'\\'')*'); else sh -c \1; fi$/s;
const unquote = (quoted: string) => quoted.slice(1, -1).replaceAll("'\\''", "'");

/** One run of `rotate.sh` the restored server got. */
interface ScriptRun {
  args: string;
  input: string;
  script: string;
}

/**
 * A server rebuilt from a snapshot: it answers the wait for its services with its own
 * `.snapshots/generations` (`generations`; none without), its app's settings of then, and plays
 * `rotate.sh` with its one-time approval: each step's old value must log in to the restored data
 * (`accepts`), which then accepts the new one instead. `unreachable` first answers that many
 * commands as SSH does while the server boots.
 */
class RestoredServer {
  readonly commands: string[] = [];
  readonly runs: ScriptRun[] = [];
  /** The passwords the restored data accepts. */
  readonly accepts = new Set<string>();
  /** The start command of each running service, as Docker holds it. */
  readonly starts = new Map<string, { entrypoint: unknown; cmd: unknown }>();
  /** The commands that wrote the plan's Compose file and settings files. */
  readonly written: string[] = [];
  /** The services its restored Compose file names. */
  readonly composeServices = new Set<string>();
  generations: string | undefined;
  appEnv: string | undefined;
  unreachable = 0;
  /** The exit codes of the wait for its services and of the start on the current commands. */
  upExit = 0;
  startExit = 0;
  private script = "";
  private approval = "";

  constructor(
    private readonly name: string,
    private readonly log: string[],
    /** The env files at the head of `rotate.sh`'s input. */
    private readonly files: number,
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
    if (this.unreachable > 0) {
      this.unreachable -= 1;
      return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection refused" };
    }
    const starts = /^for s in ([^;\n]*); do/.exec(command)?.[1];
    if (starts !== undefined) {
      const lines = starts.split(" ").flatMap((service) => {
        const start = this.starts.get(service);
        if (start === undefined) return [];
        return [
          `entrypoint ${service} ${JSON.stringify(start.entrypoint)}`,
          `cmd ${service} ${JSON.stringify(start.cmd)}`,
        ];
      });
      return ok(`${lines.join("\n")}\n`);
    }
    if (command.includes("starts.yaml.new")) {
      this.log.push(`${this.name} start-current`);
      this.written.push(command);
      return this.startExit === 0 ? ok() : { exitCode: this.startExit, stdout: "", stderr: "" };
    }
    if (command.includes(".snapshots/generations")) {
      this.log.push(`${this.name} up`);
      if (this.upExit !== 0) return { exitCode: this.upExit, stdout: "", stderr: "" };
      const services = [...this.composeServices].map((service) => `service ${service}\n`);
      const appEnv = command.includes("cat app.env") ? `--- app.env ---\n${this.appEnv ?? ""}` : "";
      return ok(`${services.join("")}${this.generations ?? ""}${appEnv}`);
    }
    if (command.includes("cat app.env")) return ok(this.appEnv ?? "");
    if (command.includes("cat > .rotate/rotate.sh")) {
      this.script = input;
      this.approval = /printf '%s\\n' '([^']*)'/.exec(command)?.[1] ?? "";
      return ok();
    }
    if (command === "rm -f .rotate/approval") return ok();
    const run = /^sh \.rotate\/rotate\.sh (.+)$/.exec(command)?.[1];
    if (run === undefined) throw new Error(`unexpected command: ${command}`);
    this.runs.push({ args: run, input, script: this.script });
    const args = run.split(" ");
    const action = args.length === 1 ? "rotate" : (args[0] as string);
    this.log.push(`${this.name} ${action}`);
    const [approved, choice] = this.approval.split(" ");
    this.approval = "";
    if (approved !== args.at(-1) || choice !== action) {
      return { exitCode: 1, stdout: "", stderr: "The one-time approval is for another rotation." };
    }
    if (action === "finish") return ok();
    const lines = input.replace(/\n$/, "").split("\n");
    for (let i = this.files; i < lines.length; i += 2) {
      const [old, now] = [lines[i] ?? "", lines[i + 1] ?? ""];
      if (!this.accepts.has(old)) {
        return { exitCode: 1, stdout: "", stderr: "The rotation stopped at step 3 of 6." };
      }
      this.accepts.delete(old);
      this.accepts.add(now);
    }
    if (this.name === "app") this.appEnv = Buffer.from(lines[0] ?? "", "base64").toString("utf8");
    return ok();
  }
}

/** GitHub's deploy pause and deploy runs. */
class FakeGitHub {
  variable: string | undefined;
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
    return [];
  }
}

/** The provider of `shop-staging` (42) and `shop-staging-data` (43), its rebuilds logged. */
function provider(log: string[]): ServerSnapshotApi {
  const servers: AppServer[] = [
    { id: "42", name: "shop-staging", status: "running" },
    { id: "43", name: "shop-staging-data", status: "running" },
  ];
  const unused = async () => {
    throw new Error("not in these tests");
  };
  return {
    findAppServers: async () => servers,
    snapshotServer: unused,
    listSnapshots: async (id) => (id === "42" ? [SNAPSHOT] : [DATA_SNAPSHOT]),
    deleteSnapshot: unused,
    rebuild: async (id, snapshot) => {
      log.push(`rebuild ${id} ${snapshot}`);
    },
    powerOff: unused,
    powerOn: unused,
  };
}

/** What a test works with. */
interface World extends SnapshotWorld {
  log: string[];
  app: RestoredServer;
  data: RestoredServer;
  github: FakeGitHub;
  restore: (id?: string) => ReturnType<typeof restoreServerSnapshot>;
}

/**
 * Staging of `plan`, with the record's `rotated` services rotated on 2026-11-07 (to `generation`)
 * and this computer's values (`generated`, with their earlier generations); its restored servers
 * hold the app's settings with `appEnv`'s values.
 */
async function world(
  plan: DeployPlan,
  o: {
    rotated: Record<string, number>;
    generated: object;
    appEnv?: object;
    files?: number;
    /** The user's own values in the app's settings ({@link DOTENV} by default). */
    dotenv?: string;
    /** The app answers once the log has this event (always by default). */
    healthyAfter?: string;
  },
): Promise<World> {
  const base = await snapshotWorld(plan);
  const log: string[] = [];
  base.deps.fetch = async () =>
    o.healthyAfter === undefined || log.includes(o.healthyAfter)
      ? new Response("ok", { status: 200 })
      : new Response("cannot reach the database", { status: 503 });
  await writeArtifact("credentials", credentialsRecordFile(base.deps.paths), {
    schemaVersion: 1,
    environments: {
      staging: Object.fromEntries(
        Object.entries(o.rotated).map(([name, generation]) => [
          name,
          { rotatedAt: ROTATED_AT, generation },
        ]),
      ),
    },
  });
  const file = generatedValuesFile(base.deps);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ env: ENV, services: {}, ...o.generated })}\n`);
  const app = new RestoredServer("app", log, o.files ?? 2);
  const data = new RestoredServer("data", log, 1);
  // Each service is in its server's Compose file and runs on the catalog's start command, as a
  // deploy of this version starts it.
  for (const service of plan.services) {
    const spec = serviceSpec(service.kind);
    const ctx = rotationContext(plan, service);
    const server = (service.server ?? APP_SERVER) === APP_SERVER ? app : data;
    server.composeServices.add(service.name);
    server.starts.set(service.name, {
      entrypoint: spec.entrypoint?.(ctx) ?? ["docker-entrypoint.sh"],
      cmd: spec.command?.(ctx) ?? [service.kind],
    });
  }
  if (o.appEnv !== undefined) {
    app.appEnv = (
      await assembleAppEnv({
        plan,
        previous: { env: ENV, services: {}, ...o.appEnv },
        dotenvText: o.dotenv ?? DOTENV,
      })
    ).appEnv;
  }
  const github = new FakeGitHub(log);
  const byHost: Record<string, RestoredServer> = { [SERVER_IPV4]: app, [DATA_IPV4]: data };
  const api = provider(log);
  // Time moves only when OpsCrew waits, so a wait that runs out ends at once.
  let clock = 0;
  return {
    ...base,
    log,
    app,
    data,
    github,
    restore: (id = SNAPSHOT.id) =>
      restoreServerSnapshot(base.deps, id, {
        services: {
          github: github as unknown as GitHubApi,
          remote: (host) => {
            const server = byHost[host];
            if (server === undefined) throw new Error(`no fake server at ${host}`);
            return server.remote(host);
          },
          serverSnapshots: () => api,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      }),
  };
}

/** Staging with PostgreSQL `db` rotated twice since generation 1, its values kept. */
function postgresWorld(o: { history?: object; generation?: number } = {}) {
  const generation = o.generation ?? 2;
  return world(stagingPlan([{ kind: "postgres", name: "db" }]), {
    rotated: { db: generation },
    generated: {
      dbPassword: generation === 3 ? DB.g3 : DB.g2,
      generations: { db: generation },
      history: o.history ?? { db: { "1": { password: DB.g1 }, "2": { password: DB.g2 } } },
    },
    appEnv: { dbPassword: DB.g1 },
  });
}

/** A run's stdin read back: the env files (`files` of them), then the values' lines. */
function readInput(run: ScriptRun | undefined, files: number) {
  const lines = (run?.input ?? "").replace(/\n$/, "").split("\n");
  return {
    files: lines.slice(0, files).map((line) => Buffer.from(line, "base64").toString("utf8")),
    values: lines.slice(files),
  };
}

/** Nothing shown, audited, asked or sent on a command line holds any of the values. */
function expectNoValue(w: World, error?: unknown): void {
  const said = [
    everythingShown(w, error),
    ...w.app.commands,
    ...w.data.commands,
    ...[...w.app.runs, ...w.data.runs].map((run) => run.script),
    w.github.variable ?? "",
  ].join("\n");
  for (const value of VALUES) expect(said).not.toContain(value);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("opscrew restore --server after a rotation", () => {
  it("restores an image from before a PostgreSQL rotation, and the app logs in with the current password", async () => {
    const w = await postgresWorld();
    w.app.accepts.add(DB.g1);
    const restored = await w.restore();

    expect(restored.checked).toBe(true);
    // The deploys were paused from before the rebuild until rotate.sh had run.
    expect(w.log).toEqual([
      "github pause",
      "rebuild 42 770011",
      "app up",
      "app rotate",
      "github resume",
    ]);
    expect(w.github.variable).toBeUndefined();
    // rotate.sh logged in with the password of then and set the current one, on stdin only.
    const [run] = w.app.runs;
    const input = readInput(run, 2);
    expect(input.values).toEqual([DB.g1, DB.g2]);
    expect([...w.app.accepts]).toEqual([DB.g2]);
    // The app's settings now hold the current password, as the deploy writes them.
    const current = await assembleAppEnv({
      plan: w.plan,
      previous: { env: ENV, services: {}, dbPassword: DB.g2 },
      dotenvText: DOTENV,
    });
    expect(w.app.appEnv).toBe(current.appEnv);
    expect(w.app.appEnv).toContain(DB.g2);
    // The restored server's generations name the current one once its data logs in with it.
    expect(run?.script).toContain("rot_generation db 2");
    // One approval, the restore's: its hash is rotate.sh's one-time approval.
    expect(w.handler.requests).toHaveLength(1);
    const [request] = w.handler.requests;
    expect(request?.details).toContain("db was rotated after the snapshot was taken");
    expect(request?.details).toContain("OPSCREW_DEPLOY_PAUSED");
    expect(run?.args).toBe(request?.planHash);
    expect(w.deps.reporter.text()).toContain("gave db its current values again");
    expectNoValue(w);
  });

  it("reads the generation of then from the restored server's own generations file", async () => {
    const w = await postgresWorld({ generation: 3 });
    w.app.generations = "db 2\n";
    w.app.accepts.add(DB.g2);
    await w.restore();
    expect(readInput(w.app.runs[0], 2).values).toEqual([DB.g2, DB.g3]);
    expect(w.app.runs[0]?.script).toContain("rot_generation db 3");
  });

  it("counts a service as its first generation when the server has no generations file", async () => {
    const w = await postgresWorld({ generation: 3 });
    w.app.accepts.add(DB.g1);
    await w.restore();
    expect(readInput(w.app.runs[0], 2).values).toEqual([DB.g1, DB.g3]);
  });

  it("waits for the rebuilt server to answer over SSH before reading it", async () => {
    const w = await postgresWorld();
    w.app.accepts.add(DB.g1);
    w.app.unreachable = 2;
    await w.restore();
    expect(w.log).toContain("app rotate");
  });

  it("refuses before the restore when this computer keeps none of the values of then", async () => {
    const w = await postgresWorld({ history: {} });
    const error = await failure(w.restore());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "db was rotated after the snapshot 770011 was taken, and this computer keeps none of its earlier values",
    );
    expect(error.message).toContain("Nothing was changed.");
    expect(error.hint).toContain("opscrew secrets restore");
    expect(w.handler.requests).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("keeps the deploys paused when the server holds a later generation than the record", async () => {
    const w = await postgresWorld();
    w.app.generations = "db 3\n";
    const error = await failure(w.restore());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("holds db at a later generation of its values (3)");
    expect(error.message).toContain("The server was rebuilt from the snapshot.");
    expect(error.message).toContain("The app's deploys stay paused (OPSCREW_DEPLOY_PAUSED)");
    expect(error.hint).toContain("opscrew restore --server 770011");
    expect(w.log).toEqual(["github pause", "rebuild 42 770011", "app up"]);
    // The pause is the restore's rotation, marked with the snapshot it restores.
    expect(Object.values(JSON.parse(w.github.variable ?? "{}"))).toEqual([
      expect.objectContaining({ reason: "rotation", restore: { server: "770011" } }),
    ]);
  });

  it("keeps the deploys paused when rotate.sh stops, saying to run the restore again", async () => {
    const w = await postgresWorld();
    // The restored data accepts no password this computer kept: rotate.sh stops at its step 3.
    const error = await failure(w.restore());
    expect(error.message).toContain("rotate.sh rotate stopped on the app's server");
    expect(error.message).toContain("The app's deploys stay paused");
    expect(w.github.variable).toContain("rotation");
    expectNoValue(w, error);
  });

  it("sets nothing, and pauses nothing, when no service was rotated after the snapshot", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]), {
      rotated: {},
      generated: { dbPassword: DB.g1 },
    });
    await w.restore();
    expect(w.log).toEqual(["rebuild 42 770011"]);
    expect(w.handler.requests[0]?.details).not.toContain("rotated after the snapshot");
  });

  it("on an extra server, runs rotate.sh's begin then finish there, and leaves the app's server alone", async () => {
    const w = await world(splitStagingPlan(), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g2,
        services: { cache: { password: CACHE } },
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
    });
    w.data.accepts.add(DB.g1);
    await w.restore(DATA_SNAPSHOT.id);
    expect(w.log).toEqual([
      "github pause",
      "rebuild 43 770099",
      "data up",
      "data begin",
      "data finish",
      "github resume",
    ]);
    expect(readInput(w.data.runs[0], 1).values).toEqual([DB.g1, DB.g2]);
    expect(w.app.commands).toEqual([]);
    expectNoValue(w);
  });

  it("gives the app's settings the current password of an extra server's PostgreSQL rotated since, and switches the app", async () => {
    const w = await world(splitStagingPlan(), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g2,
        services: { cache: { password: CACHE } },
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
      appEnv: { dbPassword: DB.g1, services: { cache: { password: CACHE } } },
      files: 1,
    });
    await w.restore();
    expect(w.log).toEqual([
      "github pause",
      "rebuild 42 770011",
      "app up",
      "app rotate",
      "github resume",
    ]);
    // No service of the app's server changes: rotate.sh only writes the app's settings and switches.
    const [run] = w.app.runs;
    expect(readInput(run, 1).values).toEqual([]);
    expect(run?.script).toContain("switching the app to the new values");
    const current = await assembleAppEnv({
      plan: w.plan,
      previous: { env: ENV, services: { cache: { password: CACHE } }, dbPassword: DB.g2 },
      dotenvText: DOTENV,
    });
    expect(w.app.appEnv).toBe(current.appEnv);
    expect(w.data.commands).toEqual([]);
    expect(w.handler.requests[0]?.details).toContain(
      "db (on server data) was rotated after the snapshot",
    );
    expectNoValue(w);
  });

  it("checks the app only once the data server's begin has run, on an extra server's restore", async () => {
    const w = await world(splitStagingPlan(), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g2,
        services: { cache: { password: CACHE } },
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
      healthyAfter: "data begin",
    });
    w.data.accepts.add(DB.g1);
    expect((await w.restore(DATA_SNAPSHOT.id)).checked).toBe(true);
  });

  it("checks the app only once its switch has run, when a service elsewhere was rotated since", async () => {
    const w = await world(splitStagingPlan(), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g2,
        services: { cache: { password: CACHE } },
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
      appEnv: { dbPassword: DB.g1, services: { cache: { password: CACHE } } },
      files: 1,
      healthyAfter: "app rotate",
    });
    expect((await w.restore()).checked).toBe(true);
  });

  it("leaves a service added since the snapshot to the next deploy", async () => {
    const w = await world(
      stagingPlan([
        { kind: "postgres", name: "db" },
        { kind: "mysql", name: "sql" },
      ]),
      {
        rotated: { db: 2, sql: 2 },
        generated: {
          dbPassword: DB.g2,
          services: { sql: { password: SQL.app2, "root-password": SQL.root2 } },
          generations: { db: 2, sql: 2 },
          history: {
            db: { "1": { password: DB.g1 } },
            sql: { "1": { password: SQL.app1, "root-password": SQL.root1 } },
          },
        },
        appEnv: {
          dbPassword: DB.g1,
          services: { sql: { password: SQL.app1, "root-password": SQL.root1 } },
        },
      },
    );
    // The restored Compose file has no sql: it was added after the snapshot.
    w.app.composeServices.delete("sql");
    w.app.accepts.add(DB.g1);
    await w.restore();
    const [run] = w.app.runs;
    expect(readInput(run, 2).values).toEqual([DB.g1, DB.g2]);
    expect(run?.script).not.toContain("rot_container sql");
  });

  it("swaps nothing for a service elsewhere whose values the restored app's settings don't hold", async () => {
    const w = await world(splitStagingPlan(), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g2,
        services: { cache: { password: CACHE } },
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
      // db came after the snapshot: the restored settings hold none of its values.
      appEnv: { dbPassword: pw("never-kept"), services: { cache: { password: CACHE } } },
      files: 1,
    });
    await w.restore();
    expect(w.log).toEqual(["github pause", "rebuild 42 770011", "app up", "github resume"]);
    expect(w.app.runs).toEqual([]);
  });

  it("refuses before the approval while another pause holds the app's deploys", async () => {
    const w = await postgresWorld();
    w.github.variable = JSON.stringify({
      [checkEnvironmentKey(w.plan)]: {
        reason: "rotation",
        since: ROTATED_AT,
        hash: "f".repeat(64),
      },
    });
    const error = await failure(w.restore());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Nothing was changed.");
    expect(w.handler.requests).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("goes on under its own pause when run again, and resumes the deploys once done", async () => {
    const w = await postgresWorld();
    // rotate.sh stops: the restored data accepts no password this computer kept.
    await failure(w.restore());
    expect(w.github.variable).toContain("rotation");
    w.app.accepts.add(DB.g1);
    expect((await w.restore()).checked).toBe(true);
    expect(w.github.variable).toBeUndefined();
    expect(w.log.slice(-4)).toEqual(["rebuild 42 770011", "app up", "app rotate", "github resume"]);
  });

  it("binds each service's generation and its current values' fingerprints into the restore's hash", async () => {
    const a = await postgresWorld();
    a.app.accepts.add(DB.g1);
    await a.restore();
    const b = await world(stagingPlan([{ kind: "postgres", name: "db" }]), {
      rotated: { db: 2 },
      generated: {
        dbPassword: DB.g3,
        generations: { db: 2 },
        history: { db: { "1": { password: DB.g1 } } },
      },
      appEnv: { dbPassword: DB.g1 },
    });
    b.app.accepts.add(DB.g1);
    await b.restore();
    const [first, second] = [a.handler.requests[0], b.handler.requests[0]];
    expect(first?.details.replace(/Restore hash: \S+/, "")).toBe(
      second?.details.replace(/Restore hash: \S+/, ""),
    );
    expect(first?.planHash).not.toBe(second?.planHash);
  });

  it.each(["mysql", "mariadb"] as const)(
    "gives %s its root password first, as the app password's commands log in as root",
    async (kind) => {
      const w = await sqlWorld(kind);
      await w.restore();
      expect(readInput(w.app.runs[0], 2).values).toEqual([
        SQL.root1,
        SQL.root2,
        SQL.app1,
        SQL.app2,
      ]);
      expect(w.app.appEnv).toContain(SQL.app2);
      expect(w.app.appEnv).not.toContain(SQL.app1);
      expectNoValue(w);
    },
  );

  it("starts a service still on a start command from before 0.2.6 on the current one through an override, keeping its image and env files", async () => {
    const w = await sqlWorld("mysql");
    w.app.starts.set("sql", { entrypoint: ["docker-entrypoint.sh"], cmd: ["mysqld"] });
    await w.restore();
    expect(w.log).toEqual([
      "github pause",
      "rebuild 42 770011",
      "app up",
      "app start-current",
      "app rotate",
      "github resume",
    ]);
    const [written] = w.app.written;
    // The restored compose.yaml stays; the override holds the start command and the settings
    // file it reads, written as a deploy writes it.
    expect(written).not.toContain("compose.yaml.new");
    expect(written).toContain("> '.rotate/starts.yaml.new'");
    expect(written).toContain("./services/sql/my.cnf:/etc/mysql/conf.d/opscrew.cnf:ro");
    expect(written).toContain("command:");
    expect(written).not.toContain("image:");
    expect(written).toMatch(/> 'services\/sql\/my\.cnf\.new'/);
    expect(written).not.toMatch(/> '[^']*\.env(\.new)?'/);
    expect(written).toContain(
      "docker compose -f compose.yaml -f .rotate/starts.yaml up -d --no-deps --wait 'sql'",
    );
    expectNoValue(w);
  });

  it("recreates Garage on its restored start command in rotate.sh, which reads the current env file", async () => {
    const plan = stagingPlan([{ kind: "garage", name: "s3" }], {
      fields: {
        storage: {
          objectStorage: {
            provider: "garage",
            bucket: "shop-uploads",
            region: "garage",
            expected: { storageGb: 10, egressGbPerMonth: 50 },
            price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
          },
        },
      },
    });
    const names = serviceSpec("garage").secrets.map((secret) => secret.name);
    const at = (n: number) =>
      Object.fromEntries(names.map((name) => [name, pw(`s3-${name}-${n}`)]));
    const w = await world(plan, {
      rotated: { s3: 2 },
      generated: {
        services: { s3: at(2) },
        generations: { s3: 2 },
        history: { s3: { "1": at(1) } },
      },
      appEnv: { services: { s3: at(1) } },
      // The test plan's app reads a database of its own.
      dotenv: `${DOTENV}DATABASE_URL=postgresql://app:${pw("own-db")}@db.example:5432/app
`,
    });
    // Its key's step takes no value; its RPC secret's logs in with the one of then.
    w.app.accepts.add("");
    for (const value of Object.values(at(1))) w.app.accepts.add(value);
    w.app.starts.set("s3", { entrypoint: ["/garage"], cmd: ["server"] });
    await w.restore();
    expect(w.log).toContain("app start-current");
    const [run] = w.app.runs;
    // Step 4 recreates it from the restored compose.yaml, without the override.
    expect(run?.script).toContain("docker compose up -d --no-deps --wait s3");
    expect(run?.script).not.toContain("starts.yaml");
    const env = readInput(run, 2).files[1] ?? "";
    for (const value of Object.values(at(2))) expect(env).toContain(value);
  });

  it.each([
    [5, "did not start and pass its health check on the app's server on the start command"],
    [1, "could not write the services' current start commands"],
  ])(
    "keeps the deploys paused when the start on the current command fails (exit code %s)",
    async (code, said) => {
      const w = await sqlWorld("mysql");
      w.app.starts.set("sql", { entrypoint: ["docker-entrypoint.sh"], cmd: ["mysqld"] });
      w.app.startExit = code;
      const error = await failure(w.restore());
      expect(error.message).toContain(said);
      expect(error.message).toContain("The app's deploys stay paused");
      expect(w.app.runs).toEqual([]);
      expect(w.github.variable).toContain("rotation");
    },
  );

  it("refuses before the approval when the deploy key was rotated since the snapshot", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]), {
      rotated: { "deploy-key": 2 },
      generated: { dbPassword: DB.g1 },
    });
    const error = await failure(w.restore());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "The deploy key was rotated after the snapshot 770011 was taken",
    );
    expect(error.message).toContain("locked out");
    expect(error.hint).toContain("Provision a fresh server");
    expect(w.handler.requests).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("names the check key and a device's key rotated since, and says to provision after the restore", async () => {
    const w = await world(stagingPlan([{ kind: "postgres", name: "db" }]), {
      rotated: { "check-key": 2, "device:laptop": 2 },
      generated: { dbPassword: DB.g1 },
    });
    await w.restore();
    expect(w.handler.requests[0]?.details).toContain(
      "The scheduled check's SSH key and device laptop's key were rotated after the snapshot was taken",
    );
    const text = w.deps.reporter.text();
    expect(text).toContain("opscrew provision");
    expect(text).toContain(
      "the scheduled check's SSH key and device laptop's key as before their rotation",
    );
  });
});

/** Staging with MySQL or MariaDB `sql` rotated once since the snapshot, its values kept. */
async function sqlWorld(kind: "mysql" | "mariadb") {
  const w = await world(stagingPlan([{ kind, name: "sql" }]), {
    rotated: { sql: 2 },
    generated: {
      services: { sql: { password: SQL.app2, "root-password": SQL.root2 } },
      generations: { sql: 2 },
      history: { sql: { "1": { password: SQL.app1, "root-password": SQL.root1 } } },
    },
    appEnv: { services: { sql: { password: SQL.app1, "root-password": SQL.root1 } } },
  });
  w.app.accepts.add(SQL.app1);
  w.app.accepts.add(SQL.root1);
  return w;
}
