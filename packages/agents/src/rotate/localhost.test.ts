// Feature 025 (T2507): services' secrets rotated on this computer, through its Docker, with the
// app held meanwhile; and a deploy here that finds a rotation's hold.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandOptions, CommandResult } from "@opscrew/contracts";
import { exists, OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { heldByRotation } from "../localhost/apply";
import { appFolder } from "../localhost/services";
import { dotenvLine, serviceAppVariables } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import {
  createTestPhaseDeps,
  type ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import { rotateLocalServices } from "./localhost";
import { credentialsRecordFile } from "./record";
import { serviceEnvTexts } from "./values";
import { pendingRotationFile } from "./values-pending";

const NOW = new Date("2026-11-08T10:00:00.000Z");

/** The names Garage's start and a rotation give its keys (the catalog's). */
const KEY = "default access key";
const PREVIOUS = "opscrew-previous";

function service(name: string, kind: PlanService["kind"]) {
  const spec = serviceSpec(kind);
  return {
    name,
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    enabled: true,
    options: kind === "valkey" ? { mode: "cache" } : {},
    reason: "The app uses it.",
    licence: spec.licence.id,
  };
}

/** `shop` on this computer with PostgreSQL, Valkey and Garage (its key and its RPC secret). */
function plan(fields: Record<string, unknown> = {}, environment?: string): DeployPlan {
  const base = localPlan(environment === undefined ? {} : { environment });
  return DeployPlanSchema.parse({
    ...base,
    services: [service("db", "postgres"), service("cache", "valkey"), service("files", "garage")],
    storage: {
      objectStorage: {
        provider: "garage",
        bucket: "shop-uploads",
        region: "garage",
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: {
          monthly: 0,
          currency: "USD",
          source: "the server's own disk",
          checkedOn: "2026-10-19",
        },
      },
    },
    ...fields,
  });
}

/**
 * This computer's Docker: the app's containers, `docker exec` (Garage's keys by name, as its
 * `key info`, `rename` and `delete` and its start from the env change them) and `docker compose
 * up` in the app's folder.
 */
class FakeDocker {
  readonly running = new Set(["app", "db", "cache", "files"]);
  readonly execs: { service: string; command: string[]; env: { old?: string; new?: string } }[] =
    [];
  /** Each `compose up`: its services and the env files then. */
  readonly composes: { services: string[]; files: Record<string, string> }[] = [];
  /** Garage's keys: id → name. */
  readonly keys = new Map<string, string>();
  /** The hold each exec saw. */
  readonly holds: (string | undefined)[] = [];
  /** A command's exit code (default 0 for any but Garage's). */
  answer: (service: string, command: readonly string[]) => number | undefined = () => undefined;
  /** Makes the `compose up` of these services fail. */
  failCompose = new Set<string>();
  /** Services still on a start command from before 025. */
  readonly stale = new Set<string>();
  /** The command and entrypoint each service starts with, by the catalog (set by the world). */
  start: (service: string) => { command?: string[]; entrypoint?: string[] } = () => ({});

  constructor(
    private readonly folder: string,
    private readonly project: string,
  ) {}

  readonly runner = new ScriptedRunner((command, args, options) =>
    this.run(command, args, options),
  );

  private async run(
    command: string,
    args: readonly string[],
    options: CommandOptions | undefined,
  ): Promise<CommandResult> {
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (command !== "docker") return ok();
    const [first] = args;
    if (first === "ps") {
      return ok(
        [...this.running]
          .map((name) => `${this.project}-${name}-1|running|${name}|False|`)
          .join("\n"),
      );
    }
    if (first === "inspect") {
      const service = (args.at(-1) ?? "").slice(this.project.length + 1, -2);
      const { command, entrypoint } = this.start(service);
      const cmd = this.stale.has(service) ? ["old-start"] : command;
      expect(args.slice(0, 3)).toEqual([
        "inspect",
        "--format",
        "[{{json .Config.Cmd}},{{json .Config.Entrypoint}}]",
      ]);
      return ok(`${JSON.stringify([cmd ?? null, entrypoint ?? null])}\n`);
    }
    if (first === "exec") {
      const [, e1, v1, e2, v2, container = "", ...rest] = args;
      expect([e1, v1, e2, v2]).toEqual(["-e", "OPSCREW_OLD", "-e", "OPSCREW_NEW"]);
      const service = container.slice(this.project.length + 1, -2);
      this.holds.push(
        await readFile(join(this.folder, ".snapshots", ".held"), "utf8").catch(() => undefined),
      );
      const env = options?.env ?? {};
      this.execs.push({
        service,
        command: rest,
        env: {
          ...(env.OPSCREW_OLD === undefined ? {} : { old: env.OPSCREW_OLD }),
          ...(env.OPSCREW_NEW === undefined ? {} : { new: env.OPSCREW_NEW }),
        },
      });
      const said = this.answer(service, rest);
      if (said !== undefined) return { exitCode: said, stdout: "", stderr: "" };
      return { exitCode: service === "files" ? this.garage(rest) : 0, stdout: "", stderr: "" };
    }
    if (first === "compose") {
      expect(options?.cwd).toBe(this.folder);
      const services = args.slice(args.indexOf("--wait") + 1);
      const files: Record<string, string> = {};
      for (const file of ["app.env", "db.env", "cache.env", "files.env"]) {
        files[file] = await readFile(join(this.folder, file), "utf8");
      }
      this.composes.push({ services, files });
      if (services.some((s) => this.failCompose.has(s))) {
        return { exitCode: 1, stdout: "", stderr: "container opscrew-shop-app-1 is unhealthy" };
      }
      if (services.includes("files")) {
        // Garage's start makes the env's key when no key has its id.
        const id = /GARAGE_DEFAULT_ACCESS_KEY=(\S+)/.exec(files["files.env"] ?? "")?.[1] ?? "";
        if (!this.keys.has(id)) this.keys.set(id, KEY);
      }
      return ok();
    }
    return ok();
  }

  /** Garage's `key info`, `key rename` and `key delete --yes`, by name. */
  private garage(command: readonly string[]): number {
    const idOf = (name: string) => [...this.keys].find(([, n]) => n === name)?.[0];
    const [, , action, ...names] = command;
    if (action === "info") return idOf(names[0] ?? "") === undefined ? 1 : 0;
    if (action === "rename") {
      const id = idOf(names[0] ?? "");
      if (id === undefined) return 1;
      this.keys.set(id, names[1] ?? "");
      return 0;
    }
    if (action === "delete") {
      const id = idOf(names[1] ?? "");
      if (id === undefined) return 1;
      this.keys.delete(id);
      return 0;
    }
    return 2;
  }
}

interface World {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  docker: FakeDocker;
  folder: string;
  /** The values before, by `<service>/<secret>`. */
  old: Map<string, string>;
  rotate(names: readonly string[], undo?: boolean): ReturnType<typeof rotateLocalServices>;
}

async function world(
  options: { plan?: DeployPlan; environment?: string; answer?: ScriptedApprovalHandler } = {},
): Promise<World> {
  const p = options.plan ?? plan();
  const base = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const folder = appFolder(base.paths, p);
  const docker = new FakeDocker(folder, `opscrew-${p.app.name}`);
  docker.start = (name) => {
    const s = p.services.find((each) => each.name === name);
    if (s === undefined) return {};
    const ctx = { plan: p, service: s, secretRef: () => "" };
    const spec = serviceSpec(s.kind);
    const command = spec.command?.(ctx);
    const entrypoint = spec.entrypoint?.(ctx);
    return {
      ...(command === undefined ? {} : { command }),
      ...(entrypoint === undefined ? {} : { entrypoint }),
    };
  };
  const deps = await createTestPhaseDeps({
    root: base.paths.root,
    env: base.env,
    clock: { now: () => NOW },
    runner: docker.runner,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.answer === undefined ? {} : { approvalHandler: options.answer }),
  });
  await writeArtifact("plan", deps.paths.files.plan, p);
  const old = new Map<string, string>();
  const services: Record<string, Record<string, string>> = {};
  for (const s of p.services) {
    for (const secret of serviceSpec(s.kind).secrets) {
      const hex = randomBytes(32).toString("hex");
      const value = secret.format === "garage-key-id" ? `GK${hex.slice(0, 24)}` : hex;
      old.set(`${s.name}/${secret.name}`, value);
      if (s.kind !== "postgres") services[s.name] = { ...services[s.name], [secret.name]: value };
    }
  }
  const v = (key: string) => old.get(key) as string;
  await writeFileAtomic(
    generatedValuesFile(deps),
    `${JSON.stringify({ dbPassword: v("db/password"), services, env: {} })}\n`,
  );
  await mkdir(folder, { recursive: true });
  // The env files as provision writes them: the services' from the catalog, the app's settings.
  const files: Record<string, string> = {
    ...envFilesOf(p, old),
    ".env": "APP_IMAGE=opscrew-local/shop:0123456789ab\n",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(folder, name), content);
  docker.keys.set(v("files/key-id"), KEY);
  return {
    deps,
    plan: p,
    docker,
    folder,
    old,
    rotate: (names, undo) =>
      rotateLocalServices(deps, p, names, {
        ...(undo === true ? { undo } : {}),
        services: { sleep: async () => {} },
      }),
  };
}

/**
 * The env files provision writes with `values` (by `<service>/<secret>`): each service's
 * `<service>.env`, and `app.env` with the app's settings of the services.
 */
function envFilesOf(p: DeployPlan, values: Map<string, string>): Record<string, string> {
  const services: Record<string, Record<string, string>> = {};
  for (const [key, value] of values) {
    const [name, secret] = key.split("/") as [string, string];
    services[name] = { ...services[name], [secret]: value };
  }
  const app = serviceAppVariables(p, (s, name) => services[s.name]?.[name] as string);
  return {
    ...serviceEnvTexts(p, services),
    "app.env": `${[...app].map(([name, value]) => dotenvLine(name, value)).join("\n")}\n`,
  };
}

/** The new values of the unfinished rotation, by `<service>/<secret>`. */
async function pendingNew(w: World): Promise<Map<string, string>> {
  const pending = JSON.parse(await readFile(pendingRotationFile(w.deps), "utf8")) as {
    services: Record<string, Record<string, { new: string }>>;
  };
  return new Map(
    Object.entries(pending.services).flatMap(([service, secrets]) =>
      Object.entries(secrets).map(([secret, pair]) => [`${service}/${secret}`, pair.new]),
    ),
  );
}

async function envFile(w: World, name: string): Promise<string> {
  return readFile(join(w.folder, name), "utf8");
}

/** The values each service has now, by `<service>/<secret>`. */
async function current(w: World): Promise<Map<string, string>> {
  const values = JSON.parse(await readFile(generatedValuesFile(w.deps), "utf8")) as {
    dbPassword: string;
    services: Record<string, Record<string, string>>;
  };
  const now = new Map<string, string>();
  for (const key of w.old.keys()) {
    const [name, secret] = key.split("/") as [string, string];
    now.set(key, name === "db" ? values.dbPassword : (values.services[name]?.[secret] as string));
  }
  return now;
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** No value in any output, audit entry, approval or command line. */
function expectNoValue(w: World, values: Iterable<string>, ...texts: string[]) {
  const handler = w.deps.approvalHandler as ScriptedApprovalHandler;
  const runner = w.docker.runner.calls.map((call) => [call.command, ...call.args].join(" "));
  const seen = [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(handler.requests),
    ...runner,
    ...texts,
  ].join("\n");
  for (const value of values) expect(seen).not.toContain(value);
}

const held = (w: World) =>
  readFile(join(w.folder, ".snapshots", ".held"), "utf8").catch(() => undefined);

describe("rotateLocalServices", () => {
  it("holds the app, begins in each container, rewrites the env files, recreates, then finishes", async () => {
    const w = await world();
    const result = await w.rotate(["db", "cache", "files"]);
    if (!("copy" in result)) throw new Error("not rotated");
    const now = await current(w);
    for (const [key, value] of now) expect(value).not.toBe(w.old.get(key));

    // Compose creates only the app and Garage again here: the others keep their connections.
    const details = (w.deps.approvalHandler as ScriptedApprovalHandler).requests[0]?.details ?? "";
    expect(details).toContain(
      "db (PostgreSQL, password): a short swap; new connections the running app opens to it fail for about",
    );
    expect(details).toContain("open connections stay");
    expect(details).toContain("cache (Valkey, password): seamless");
    expect(details).not.toContain("when the stack plan applies");
    expect(w.docker.composes.flatMap((c) => c.services).sort()).toEqual(["app", "files", "files"]);

    // Held while it ran, released at the end.
    expect(w.docker.holds.every((hold) => hold === `rotation ${result.hash}\n`)).toBe(true);
    expect(await held(w)).toBeUndefined();

    // Each env file holds the new values in place, none of the old.
    for (const name of ["app.env", "db.env", "cache.env", "files.env"]) {
      const text = await envFile(w, name);
      for (const value of w.old.values()) expect(text).not.toContain(value);
    }
    // As provision would write them with the new values.
    const written = envFilesOf(w.plan, now);
    for (const name of ["app.env", "db.env", "cache.env", "files.env"]) {
      expect(await envFile(w, name)).toBe(written[name]);
    }

    // Garage: the old key renamed (its check first), its RPC secret's restart with only that new,
    // then Garage and the app created again from the new env files.
    const garage = w.docker.execs
      .filter((e) => e.service === "files")
      .map((e) => e.command.join(" "));
    expect(garage.slice(0, 2)).toEqual([
      `/garage key info ${PREVIOUS}`,
      `/garage key rename ${KEY} ${PREVIOUS}`,
    ]);
    const [restart, recreate, app] = w.docker.composes;
    expect(restart?.services).toEqual(["files"]);
    expect(restart?.files["files.env"]).toContain(
      `GARAGE_RPC_SECRET=${now.get("files/rpc-secret")}`,
    );
    expect(restart?.files["files.env"]).toContain(
      `GARAGE_DEFAULT_ACCESS_KEY=${w.old.get("files/key-id")}`,
    );
    expect(restart?.files["app.env"]).toContain(w.old.get("db/password"));
    expect(recreate?.services).toEqual(["files"]);
    expect(recreate?.files["files.env"]).toContain(
      `GARAGE_DEFAULT_ACCESS_KEY=${now.get("files/key-id")}`,
    );
    expect(app?.services).toEqual(["app"]);
    expect(app?.files["app.env"]).toContain(now.get("db/password"));
    // Its finish deleted the old key only once the new one was there.
    expect(garage.slice(-3)).toEqual([
      `/garage key info ${PREVIOUS}`,
      `/garage key info ${KEY}`,
      `/garage key delete --yes ${PREVIOUS}`,
    ]);
    expect([...w.docker.keys]).toEqual([[now.get("files/key-id"), KEY]]);

    // The values only in each command's environment: Postgres's pair, none for Garage's key.
    const db = w.docker.execs.find((e) => e.service === "db");
    expect(db?.env).toEqual({ old: w.old.get("db/password"), new: now.get("db/password") });
    expect(w.docker.execs.find((e) => e.service === "files")?.env).toEqual({ old: "", new: "" });

    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(Object.keys(record.environments.prod ?? {}).sort()).toEqual(["cache", "db", "files"]);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    // The snapshots here name each service's new generation, as on a server (T2514).
    expect((await envFile(w, ".snapshots/generations")).split("\n").sort()).toEqual([
      "",
      "cache 2",
      "db 2",
      "files 2",
    ]);
    expectNoValue(w, [...w.old.values(), ...now.values()]);
  });

  it("keeps the hold when the switch fails, which a deploy here explains, and undoes it", async () => {
    const w = await world();
    w.docker.failCompose.add("app");
    const error = await failure(w.rotate(["db", "cache"]));
    expect(error.message).toContain("Docker Compose could not start app with the values in place");
    expect(error.message).toContain(
      "The rotation stopped while switching the app to the new values",
    );
    expect(error.hint).toContain("`opscrew rotate db cache --undo`");
    const hold = (await held(w))?.trim() ?? "";
    expect(hold).toMatch(/^rotation [0-9a-f]{64}$/);

    // A deploy on this computer finds the hold (the rollback script's `held rotation <hash>`).
    const said = await heldByRotation(w.deps, `held ${hold}`);
    expect(said).toContain(`the rotation of the plan ${hold.slice("rotation ".length)}`);
    expect(said).toContain("finish it with `opscrew rotate db cache`");
    expect(said).toContain("`opscrew rotate db cache --undo`");
    expect(await heldByRotation(w.deps, "held")).toBeUndefined();
    expect(await heldByRotation(w.deps, "restored")).toBeUndefined();

    // The values this computer keeps stay the old ones until the rotation is done; the snapshots
    // here name the new generation of each service whose begin ran (T2514).
    expect(await current(w)).toEqual(w.old);
    expect(await envFile(w, ".snapshots/generations")).toBe("db 2\ncache 2\n");
    const next = await pendingNew(w);
    w.docker.failCompose.clear();
    w.docker.execs.length = 0;
    const undone = await w.rotate(["db", "cache"], true);
    expect(undone).toMatchObject({ undone: true });
    expect(await current(w)).toEqual(w.old);
    expect(await envFile(w, "app.env")).toContain(w.old.get("db/password"));
    expect(await envFile(w, "db.env")).toBe(envFilesOf(w.plan, w.old)["db.env"]);
    expect(await held(w)).toBeUndefined();
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    expect((await envFile(w, ".snapshots/generations")).split("\n").sort()).toEqual([
      "",
      "cache 1",
      "db 1",
    ]);
    // Postgres's begin again with the values swapped.
    expect(w.docker.execs.find((e) => e.service === "db")?.env).toEqual({
      old: next.get("db/password"),
      new: w.old.get("db/password"),
    });
    expect(w.docker.composes.at(-1)?.services).toEqual(["app"]);
    expectNoValue(w, [...w.old.values(), ...next.values()], error.message, said ?? "");
  });

  it("names the rotation without its credentials when this computer has no pending values", async () => {
    const w = await world();
    const said = await heldByRotation(w.deps, `held rotation ${"a".repeat(64)}`);
    expect(said).toContain("finish it with `opscrew rotate` and the credentials it rotates");
  });

  it("refuses before anything changes: the local runner, an env file without the value, a restore's hold", async () => {
    const runner = await world({
      plan: plan(
        { environment: { name: "dev", runner: "local", deploySource: { from: "main" } } },
        "dev",
      ),
      environment: "dev",
    });
    const local = await failure(runner.rotate(["db"]));
    expect(local.message).toContain("The local runner deploys the dev environment");

    const edited = await world();
    await writeFile(join(edited.folder, "cache.env"), "VALKEY_PASSWORD=edited\n");
    const mismatch = await failure(edited.rotate(["cache"]));
    expect(mismatch.message).toContain(
      "cache.env in the app's folder on this computer does not hold",
    );

    const restoring = await world();
    await mkdir(join(restoring.folder, ".snapshots"), { recursive: true });
    await writeFile(join(restoring.folder, ".snapshots", ".held"), "");
    const restore = await failure(restoring.rotate(["db"]));
    expect(restore.message).toContain("A restore holds the app on this computer");

    const stale = await world();
    stale.docker.stale.add("cache");
    const old = await failure(stale.rotate(["db", "cache"]));
    expect(old.message).toContain(
      "cache on this computer still runs on a start command from before this version of OpsCrew",
    );
    expect(old.hint).toContain("Run `opscrew provision` first");
    expect(await held(stale)).toBeUndefined();

    for (const w of [runner, edited, restoring, stale]) {
      expect(w.docker.execs).toEqual([]);
      expect((w.deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
      expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    }
  });
});
