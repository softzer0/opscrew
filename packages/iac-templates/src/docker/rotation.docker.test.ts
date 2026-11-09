/**
 * The catalog's rotation recipes (feature 025) on Docker with the pinned images, each service as the
 * localhost target renders it (its volumes, settings, env file and the internal network), as
 * research R10's spike ran them:
 * - a client logs in with the old value and keeps its connection open through the change;
 * - `begin` and `finish` run as the server script runs them, `docker exec -e OPSCREW_OLD -e
 *   OPSCREW_NEW <container> …` with the values only in the docker CLI's environment;
 * - the service is created again from its new env file only where the recipe says (`recreate`).
 * Then: the open connection still works (NATS's is closed, as its recipe says), the old value fails
 * after `begin` (swap) or `finish` (dual) while the new one works, and so after a `docker restart`
 * of the container (still created from the old env file), whose health check passes: a restart
 * keeps the rotated value. PostgreSQL, MariaDB (swaps), MySQL (dual, the app's and root's, then the
 * app's again on root's new password), Valkey, Redis and Dragonfly (dual, and a device's login on
 * Valkey), Kafka and Redpanda with their login, OpenSearch and Elasticsearch (swaps), ClickHouse
 * (its users file rewritten, no restart, a fresh first start), NATS (the included token file and
 * its reload) and Garage (the second key, the old one deleted, then the RPC secret by a restart; and
 * a restore's re-login of a copy from before its key's rotation, the old key deleted by its ID).
 *
 * It pulls the pinned images, so it runs only with OPSCREW_DOCKER_TESTS=1. Each case removes its
 * project with its volumes and network, and the run removes the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { docker, hasImage } from "../__fixtures__/docker";
import { initStepsFor, renderContext, serviceSpec } from "../catalog";
import { GARAGE_STORAGE, withPlacement, withServices } from "../catalog/__fixtures__/plans";
import type {
  RotationCommand,
  RotationStep,
  SecretRotation,
  ServiceContext,
} from "../catalog/types";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { IMAGES } from "../pins";
import { renderCompose } from "../runtime";
import { composeLiteral } from "../runtime/services";
import { skipReason } from "../workflow/__fixtures__/sh";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the rotation recipes on Docker: ${reason}`);

/** The run's id, in every project's name. */
const RUN = randomBytes(3).toString("hex");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fn`'s value once it stops throwing, retried every second for up to `ms`. */
async function eventually<T>(fn: () => T, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
}

/** A new random value in the format of `kind`'s secret `name`. */
function newValue(kind: PlanService["kind"], name: string): string {
  const secret = serviceSpec(kind).secrets.find((s) => s.name === name);
  return secret?.format === "garage-key-id"
    ? `GK${randomBytes(12).toString("hex")}`
    : randomBytes(32).toString("hex");
}

/** Whether `step` is a plain command, not a conditional one. */
function isCommand(step: RotationStep): step is RotationCommand {
  return Array.isArray(step);
}

/** `env` as `docker` arguments. */
function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

/** One case's Compose project: the rendered service alone, its env file, on this computer. */
class Project {
  readonly name: string;
  readonly dir: string;
  readonly service: PlanService;
  readonly ctx: ServiceContext;
  /** The container the held client runs in: the service's own, or a client of its own. */
  private holder = "";

  constructor(
    kind: string,
    readonly plan: DeployPlan,
    public secrets: Record<string, string>,
    /** Replaces the rendered service's fields (a device's login on Valkey). */
    readonly fields: (service: Record<string, unknown>) => Record<string, unknown> = (s) => s,
  ) {
    this.name = `opscrew-rotate-${RUN}-${kind}`;
    this.dir = mkdtempSync(join(root, `${kind}-`)).replaceAll("\\", "/");
    const service = plan.services[0];
    if (service === undefined) throw new Error("no service");
    this.service = service;
    this.ctx = renderContext(plan, service);
  }

  get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.name,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
    };
  }

  /** The project's network, where the app's containers are. */
  get network(): string {
    return `${this.name}_internal`;
  }

  /** Writes `compose.yaml` and the service's env file from {@link secrets}. */
  write(): void {
    const rendered = parse(renderCompose(this.plan).content);
    const own = { ...rendered.services[this.service.name] };
    delete own.depends_on;
    delete own.ports;
    const used = new Set((own.volumes as string[]).map((mount) => mount.split(":")[0]));
    const volumes = Object.fromEntries(
      Object.entries(rendered.volumes ?? {}).filter(([key]) => used.has(key)),
    );
    writeFileSync(
      join(this.dir, "compose.yaml"),
      stringify({
        services: { [this.service.name]: this.fields(own) },
        networks: { internal: {} },
        ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
        ...(rendered.configs === undefined ? {} : { configs: rendered.configs }),
      }),
    );
    const env = serviceSpec(this.service.kind).environment({
      ...this.ctx,
      secretRef: (name) => {
        const value = this.secrets[name];
        if (value === undefined) throw new Error(`No secret ${name}.`);
        return value;
      },
    });
    writeFileSync(
      join(this.dir, `${this.service.name}.env`),
      `${Object.entries(env)
        .map(([name, value]) => `${name}=${value.replaceAll("\n", "\\n")}`)
        .join("\n")}\n`,
    );
  }

  compose(args: string[]): string {
    return docker(["compose", ...args], { cwd: this.dir, env: this.env, timeoutMs: 900_000 });
  }

  /** Starts the service, or creates it again from a changed env file, and waits until healthy. */
  up(): void {
    this.write();
    this.compose(["up", "-d", "--wait", "--wait-timeout", "600"]);
  }

  container(): string {
    return this.compose(["ps", "-q", this.service.name]);
  }

  /** When the container last started, to tell a restart. */
  startedAt(): string {
    return docker(["inspect", "-f", "{{.State.StartedAt}} {{.RestartCount}}", this.container()]);
  }

  /** The catalog's health check, run once in the container now: its exit status. */
  checkHealth(): number | null {
    const [form, ...test] = serviceSpec(this.service.kind).healthcheck(this.ctx).test;
    const args = form === "CMD-SHELL" ? ["sh", "-c", test[0] ?? ""] : test;
    return spawnSync("docker", ["exec", this.container(), ...args], { env: this.env }).status;
  }

  /**
   * `docker restart` of the container (created from the env file it had), until Docker says it is
   * healthy again; then its health check passes now too.
   */
  async restart(): Promise<void> {
    const container = this.container();
    docker(["restart", container]);
    await eventually(
      () =>
        expect(docker(["inspect", "-f", "{{.State.Health.Status}}", container])).toBe("healthy"),
      600_000,
    );
    expect(this.checkHealth()).toBe(0);
  }

  /** `script` in the container with `sh -c`, `env` added; its status and output. */
  sh(script: string, env: Record<string, string> = {}) {
    const result = spawnSync(
      "docker",
      ["exec", ...envArgs(env), this.container(), "sh", "-c", script],
      { env: this.env, encoding: "utf8", timeout: 300_000 },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  /** `script` as {@link sh} that must pass; its output. */
  ok(script: string, env: Record<string, string> = {}): string {
    const result = this.sh(script, env);
    expect(result.status, result.output).toBe(0);
    return result.output.trim();
  }

  /** `script` with `sh -c` in a one-off of `image` on the project's network; its output. */
  client(image: string, script: string, env: Record<string, string> = {}): string {
    remember(image);
    return docker([
      "run",
      "--rm",
      "--network",
      this.network,
      ...envArgs(env),
      "--entrypoint",
      "sh",
      image,
      "-c",
      script,
    ]);
  }

  /**
   * The recipe's `steps` as the server script runs them, each twice, as a resumed rotation would:
   * `docker exec -e OPSCREW_OLD -e OPSCREW_NEW`, the two values in the docker CLI's own
   * environment, nothing on stdin; a conditional step's command only when each of its `when`
   * passes and each of its `unless` fails.
   */
  run(steps: RotationStep[], old: string, next: string): void {
    for (const step of steps) {
      for (const _ of [1, 2]) {
        if (isCommand(step)) {
          this.runCommand(step, old, next);
          continue;
        }
        const passes = (check: RotationCommand) => this.runCommand(check, old, next, false) === 0;
        if ((step.when ?? []).every(passes) && !(step.unless ?? []).some(passes)) {
          this.runCommand(step.run, old, next);
        }
      }
    }
  }

  /** One command of {@link run}: its exit status, which must be 0 when `must`. */
  private runCommand(command: RotationCommand, old: string, next: string, must = true) {
    const result = spawnSync(
      "docker",
      ["exec", "-e", "OPSCREW_OLD", "-e", "OPSCREW_NEW", this.container(), ...command],
      {
        env: { ...this.env, OPSCREW_OLD: old, OPSCREW_NEW: next },
        input: "",
        encoding: "utf8",
        timeout: 300_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    if (must) expect(result.status, `${command.join(" ")}\n${output}`).toBe(0);
    // A recipe's own output names no value (Garage's names the key ID, which it is told to keep).
    if (this.service.kind !== "garage") {
      expect(output).not.toContain(old);
      expect(output).not.toContain(next);
    }
    return result.status;
  }

  /** `args` in the container as they are (an image without a shell): their exit status. */
  exec(args: readonly string[]): number | null {
    return spawnSync("docker", ["exec", this.container(), ...args], { env: this.env }).status;
  }

  /**
   * A client started in the background that logs in with `script`'s first part, waits for
   * /tmp/go, then runs its second part on the same connection, writing everything to
   * /tmp/held.out and `exit <status>` at its end: in the service's container, or with `image` in a
   * container of its own on the project's network.
   */
  hold(script: string, env: Record<string, string>, image?: string): void {
    const run = `rm -f /tmp/go /tmp/held.out; (${script}) > /tmp/held.out 2>&1; echo "exit $?" >> /tmp/held.out`;
    if (image === undefined) {
      this.holder = this.container();
      docker(["exec", "-d", ...envArgs(env), this.holder, "sh", "-c", run]);
      return;
    }
    remember(image);
    this.holder = `${this.name}-held`;
    docker([
      "run",
      "-d",
      "--name",
      this.holder,
      "--network",
      this.network,
      ...envArgs(env),
      "--entrypoint",
      "sh",
      image,
      "-c",
      `${run}; sleep 600`,
    ]);
  }

  /** What the held client wrote so far. */
  held(): string {
    const result = spawnSync("docker", ["exec", this.holder, "cat", "/tmp/held.out"], {
      env: this.env,
      encoding: "utf8",
    });
    return result.stdout ?? "";
  }

  /** Lets the held client go on, and what it wrote by its end. */
  async release(): Promise<string> {
    docker(["exec", this.holder, "touch", "/tmp/go"]);
    return eventually(() => {
      const out = this.held();
      if (!/exit \d+/.test(out)) throw new Error(`the held client has not ended:\n${out}`);
      return out;
    }, 60_000);
  }

  /** The pinned curl on the project's network with `args`: its HTTP status code. */
  curl(args: string[]): string {
    remember(IMAGES.curl.ref);
    return docker([
      "run",
      "--rm",
      "--network",
      this.network,
      IMAGES.curl.ref,
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      ...args,
    ]);
  }

  down(): void {
    spawnSync("docker", ["rm", "-f", `${this.name}-held`], { env: this.env });
    spawnSync("docker", ["compose", "down", "--volumes", "--remove-orphans", "--timeout", "5"], {
      cwd: this.dir,
      env: this.env,
    });
  }
}

/** The shell loop a held client reads from: `first`, then `second` once /tmp/go exists. */
function twoParts(first: string, second: string): string {
  return `{ ${first}; while [ ! -f /tmp/go ]; do sleep 0.2; done; ${second}; }`;
}

/** The rotation of `secret` in the project's catalog entry. */
function rotationOf(project: Project, secret: string): SecretRotation {
  const found = serviceSpec(project.service.kind).rotation.secrets.find((r) =>
    r.secrets.includes(secret),
  );
  if (found === undefined) throw new Error(`no rotation of ${secret}`);
  return found;
}

/** The images present before the run, by reference. */
const before = new Map<string, boolean>();

function remember(ref: string): void {
  if (!before.has(ref)) before.set(ref, hasImage(ref));
}

const root = mkdtempSync(join(tmpdir(), "opscrew-rotation-docker-"));

// Removing a dozen images, some over a gigabyte, takes longer than a hook's default 10 seconds.
afterAll(() => {
  for (const [ref, present] of before) {
    if (!present && hasImage(ref)) spawnSync("docker", ["image", "rm", ref]);
  }
  rmSync(root, { recursive: true, force: true });
}, 600_000);

/** Runs `body` with the case's project up, then removes it with its volumes and network. */
async function withProject(project: Project, body: () => Promise<void>): Promise<void> {
  remember(IMAGES[serviceSpec(project.service.kind).image].ref);
  try {
    project.up();
    await body();
  } finally {
    project.down();
  }
}

/** A plan on this computer with the one service `entry`, and `fields`. */
function planOf(entry: Record<string, unknown>, fields: Record<string, unknown> = {}): DeployPlan {
  return onThisComputer(withServices([entry as never], fields), { environment: "staging" });
}

/** MySQL's and MariaDB's logins: the app's over TCP, root's over the socket and over TCP. */
function sqlLogins(project: Project, client: string) {
  return {
    app: (password: string) =>
      project.sh(`${client} -h 127.0.0.1 -u app -N -B app -e 'SELECT 1'`, { MYSQL_PWD: password })
        .status,
    root: (password: string) => [
      project.sh(`${client} -u root -N -B -e 'SELECT 1'`, { MYSQL_PWD: password }).status,
      project.sh(`${client} -h 127.0.0.1 -u root -N -B -e 'SELECT 1'`, { MYSQL_PWD: password })
        .status,
    ],
  };
}

/** A held SQL session as the app over TCP, until it shows in the server's process list. */
async function holdSql(project: Project, client: string, password: string, root: string) {
  const query = (mark: string) => `echo "SELECT '${mark}', CONNECTION_ID();"`;
  project.hold(
    `${twoParts(query("before"), query("after"))} | ${client} -h 127.0.0.1 -u app -N -B app`,
    { MYSQL_PWD: password },
  );
  await eventually(() =>
    expect(
      project.ok(
        `${client} -u root -N -B -e "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'app'"`,
        { MYSQL_PWD: root },
      ),
    ).toBe("1"),
  );
}

/** The held SQL session's two connection IDs, which must be one. */
async function heldSqlSession(project: Project): Promise<void> {
  const held = await project.release();
  const ids = [...held.matchAll(/^(before|after)\t(\d+)$/gm)].map((m) => m[2]);
  expect(ids, held).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(held).toContain("exit 0");
}

describe.skipIf(reason !== undefined)(
  "the rotation recipes on Docker (OPSCREW_DOCKER_TESTS=1)",
  { timeout: 1_800_000 },
  () => {
    it("PostgreSQL swaps: the old password fails once begin ran, the open session stays", async () => {
      const old = newValue("postgres", "password");
      const project = new Project("postgres", planOf({ kind: "postgres" }), { password: old });
      await withProject(project, async () => {
        // By the service's name, as the app: the image trusts the container's own loopback.
        const host = project.service.name;
        const login = (password: string) =>
          project.sh(`psql -X -t -A -h ${host} -U app -d app -c 'SELECT 1'`, {
            PGPASSWORD: password,
          }).status;
        expect(login(old)).toBe(0);
        expect(login(newValue("postgres", "password"))).not.toBe(0);
        const query = (mark: string) => `echo "SELECT '${mark}', pg_backend_pid();"`;
        project.hold(
          `${twoParts(query("before"), query("after"))} | PGAPPNAME=held psql -X -q -t -A -h ${host} -U app -d app`,
          { PGPASSWORD: old },
        );
        await eventually(() =>
          expect(
            project.ok(
              `psql -X -t -A -U app -d app -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'held'"`,
            ),
          ).toBe("1"),
        );
        const next = newValue("postgres", "password");
        const r = rotationOf(project, "password");
        project.run(r.begin(project.ctx), old, next);
        expect(login(old)).not.toBe(0);
        expect(login(next)).toBe(0);
        const held = await project.release();
        const pids = [...held.matchAll(/^(before|after)\|(\d+)$/gm)].map((m) => m[2]);
        expect(pids, held).toHaveLength(2);
        expect(pids[0]).toBe(pids[1]);
        expect(held).toContain("exit 0");
        await project.restart();
        expect(login(next)).toBe(0);
        expect(login(old)).not.toBe(0);
        // The image reads its env password on the first start only: the new env changes nothing.
        project.secrets = { password: next };
        project.up();
        expect(login(next)).toBe(0);
      });
    });

    it("MySQL holds both passwords until finish, the app's and root's two accounts", async () => {
      const old = {
        password: newValue("mysql", "password"),
        root: newValue("mysql", "root-password"),
      };
      const project = new Project("mysql", planOf({ kind: "mysql" }), {
        password: old.password,
        "root-password": old.root,
      });
      await withProject(project, async () => {
        const { app, root } = sqlLogins(project, "mysql");
        expect(app(old.password)).toBe(0);
        await holdSql(project, "mysql", old.password, old.root);
        const next = {
          password: newValue("mysql", "password"),
          root: newValue("mysql", "root-password"),
        };
        const password = rotationOf(project, "password");
        const rootPassword = rotationOf(project, "root-password");
        // An undo after `begin`: the old passwords the only ones again, root's file too.
        project.run(password.begin(project.ctx), old.password, next.password);
        project.run(rootPassword.begin(project.ctx), old.root, next.root);
        project.run(password.undo?.(project.ctx) ?? [], old.password, next.password);
        project.run(rootPassword.undo?.(project.ctx) ?? [], old.root, next.root);
        expect(app(old.password)).toBe(0);
        expect(app(next.password)).not.toBe(0);
        expect(root(old.root)).toEqual([0, 0]);
        expect(root(next.root).every((status) => status !== 0)).toBe(true);
        expect(project.ok("cat /tmp/opscrew-root-password")).toBe(old.root);
        // A whole service's run: every begin in the recipe's order, then every finish.
        project.run(password.begin(project.ctx), old.password, next.password);
        project.run(rootPassword.begin(project.ctx), old.root, next.root);
        expect([app(old.password), app(next.password)]).toEqual([0, 0]);
        expect([...root(old.root), ...root(next.root)]).toEqual([0, 0, 0, 0]);
        project.run(password.finish(project.ctx), old.password, next.password);
        project.run(rootPassword.finish(project.ctx), old.root, next.root);
        expect(app(old.password)).not.toBe(0);
        expect(app(next.password)).toBe(0);
        expect(root(old.root).every((status) => status !== 0)).toBe(true);
        expect(root(next.root)).toEqual([0, 0]);
        await heldSqlSession(project);
        await project.restart();
        expect(app(old.password)).not.toBe(0);
        expect(app(next.password)).toBe(0);
        expect(root(old.root).every((status) => status !== 0)).toBe(true);
        expect(root(next.root)).toEqual([0, 0]);
        // The app's password again, in the same container: its commands log in as root with
        // root's new password, which the container keeps.
        const third = newValue("mysql", "password");
        project.run(password.begin(project.ctx), next.password, third);
        project.run(password.finish(project.ctx), next.password, third);
        expect(app(next.password)).not.toBe(0);
        expect(app(third)).toBe(0);
      });
    });

    it("MariaDB swaps the app's password, then root's two accounts", async () => {
      const old = {
        password: newValue("mariadb", "password"),
        root: newValue("mariadb", "root-password"),
      };
      const project = new Project("mariadb", planOf({ kind: "mariadb" }), {
        password: old.password,
        "root-password": old.root,
      });
      await withProject(project, async () => {
        const { app, root } = sqlLogins(project, "mariadb");
        expect(app(old.password)).toBe(0);
        await holdSql(project, "mariadb", old.password, old.root);
        const next = {
          password: newValue("mariadb", "password"),
          root: newValue("mariadb", "root-password"),
        };
        const password = rotationOf(project, "password");
        const rootPassword = rotationOf(project, "root-password");
        // An undo after `begin` is `begin` with the values swapped (no own undo): the old
        // passwords the only ones again, root's file too.
        expect([password.undo, rootPassword.undo]).toEqual([undefined, undefined]);
        project.run(password.begin(project.ctx), old.password, next.password);
        project.run(rootPassword.begin(project.ctx), old.root, next.root);
        project.run(password.begin(project.ctx), next.password, old.password);
        project.run(rootPassword.begin(project.ctx), next.root, old.root);
        expect(app(old.password)).toBe(0);
        expect(app(next.password)).not.toBe(0);
        expect(root(old.root)).toEqual([0, 0]);
        expect(root(next.root).every((status) => status !== 0)).toBe(true);
        expect(project.ok("cat /tmp/opscrew-root-password")).toBe(old.root);
        project.run(password.begin(project.ctx), old.password, next.password);
        expect(app(old.password)).not.toBe(0);
        expect(app(next.password)).toBe(0);
        project.run(rootPassword.begin(project.ctx), old.root, next.root);
        expect(root(old.root).every((status) => status !== 0)).toBe(true);
        expect(root(next.root)).toEqual([0, 0]);
        await heldSqlSession(project);
        await project.restart();
        expect(app(old.password)).not.toBe(0);
        expect(app(next.password)).toBe(0);
        expect(root(next.root)).toEqual([0, 0]);
        const third = newValue("mariadb", "password");
        project.run(password.begin(project.ctx), next.password, third);
        expect(app(next.password)).not.toBe(0);
        expect(app(third)).toBe(0);
      });
    });

    it("MongoDB with a replica set swaps its root password, its setup step on the new one", async () => {
      const old = newValue("mongodb", "password");
      const plan = planOf({ kind: "mongodb", options: { replicaSet: true } });
      const project = new Project("mongodb", plan, { password: old });
      await withProject(project, async () => {
        // The deploy's one-time setup as the switch runs it: `run` only when `check` fails.
        const [step] = initStepsFor(plan);
        if (step === undefined) throw new Error("no setup step");
        if (project.exec(step.check) !== 0) expect(project.exec(step.run)).toBe(0);
        await eventually(() => expect(project.exec(step.check)).toBe(0));
        const login = (password: string) =>
          project.sh(
            `mongosh --quiet -u app -p "$P" --authenticationDatabase admin admin --eval 'db.runCommand({ ping: 1 }).ok'`,
            { P: password },
          ).status;
        expect(login(old)).toBe(0);
        const next = newValue("mongodb", "password");
        project.run(rotationOf(project, "password").begin(project.ctx), old, next);
        expect(login(old)).not.toBe(0);
        expect(login(next)).toBe(0);
        // The setup step's check logs in with the container's current password.
        expect(project.exec(step.check)).toBe(0);
        await project.restart();
        expect(login(next)).toBe(0);
        expect(login(old)).not.toBe(0);
        expect(project.exec(step.check)).toBe(0);
      });
    });

    for (const kind of ["valkey", "redis", "dragonfly"] as const) {
      it(`${kind} holds both passwords until finish, and its ACL file keeps the change`, async () => {
        const old = newValue(kind, "password");
        const project = new Project(kind, planOf({ kind }), { password: old });
        const host = project.service.name;
        await withProject(project, async () => {
          // A client of its own on the app's network, as the app; it keeps its side open a second,
          // since Dragonfly closes a connection whose client has stopped sending before it replies.
          const auth = (password: string) =>
            project.client(
              IMAGES.busybox.ref,
              `{ printf 'AUTH %s\\r\\nPING\\r\\n' "$P"; sleep 1; } | nc ${host} 6379`,
              { P: password },
            );
          expect(auth(old)).toMatch(/^\+OK/);
          project.hold(
            `${twoParts(`printf 'AUTH %s\\r\\nPING\\r\\n' "$P"`, "printf 'PING\\r\\n'; sleep 1")} | nc ${host} 6379`,
            { P: old },
            IMAGES.busybox.ref,
          );
          await eventually(() => expect(project.held()).toContain("+PONG"));
          const next = newValue(kind, "password");
          const r = rotationOf(project, "password");
          project.run(r.begin(project.ctx), old, next);
          expect(auth(old)).toMatch(/^\+OK/);
          expect(auth(next)).toMatch(/^\+OK/);
          project.run(r.finish(project.ctx), old, next);
          expect(auth(old)).not.toMatch(/^\+OK/);
          expect(auth(next)).toMatch(/^\+OK/);
          expect(project.checkHealth()).toBe(0);
          const held = await project.release();
          expect(held.match(/\+PONG/g), held).toHaveLength(2);
          await project.restart();
          expect(auth(next)).toMatch(/^\+OK/);
          expect(auth(old)).not.toMatch(/^\+OK/);
        });
      });
    }

    it("Valkey with a device's login: its new password beside the old, then the old dropped", async () => {
      const app = newValue("valkey", "password");
      const device = {
        old: randomBytes(32).toString("hex"),
        next: randomBytes(32).toString("hex"),
      };
      // The grant's plan for its environment; the service on this computer as every other case.
      const granted = withPlacement(withServices([{ kind: "valkey" }]), {
        devices: ["laptop"],
        grants: [{ device: "laptop", service: "cache", access: "full" }],
      });
      const grantedService = granted.services[0] as PlanService;
      const command = serviceSpec("valkey").command?.(renderContext(granted, grantedService));
      const sha256 = createHash("sha256").update(device.old).digest("hex");
      const plan = planOf({ kind: "valkey", name: grantedService.name });
      const project = new Project("valkey-grant", plan, { password: app }, (service) => ({
        ...service,
        command: command?.map(composeLiteral),
        environment: { OPSCREW_ACL_USERS: `laptop:full:${sha256}` },
      }));
      const host = project.service.name;
      await withProject(project, async () => {
        const auth = (password: string) =>
          project.client(
            IMAGES.busybox.ref,
            `{ printf 'AUTH laptop %s\\r\\nPING\\r\\n' "$P"; sleep 1; } | nc ${host} 6379`,
            { P: password },
          );
        expect(auth(device.old)).toMatch(/^\+OK/);
        project.hold(
          `${twoParts(`printf 'AUTH laptop %s\\r\\nPING\\r\\n' "$P"`, "printf 'PING\\r\\n'; sleep 1")} | nc ${host} 6379`,
          { P: device.old },
          IMAGES.busybox.ref,
        );
        await eventually(() => expect(project.held()).toContain("+PONG"));
        const grant = serviceSpec("valkey").rotation.grant;
        project.run(grant?.begin("laptop") ?? [], device.old, device.next);
        expect(auth(device.old)).toMatch(/^\+OK/);
        expect(auth(device.next)).toMatch(/^\+OK/);
        project.run(grant?.finish("laptop") ?? [], device.old, device.next);
        expect(auth(device.old)).not.toMatch(/^\+OK/);
        expect(auth(device.next)).toMatch(/^\+OK/);
        const held = await project.release();
        expect(held.match(/\+PONG/g), held).toHaveLength(2);
        await project.restart();
        expect(auth(device.next)).toMatch(/^\+OK/);
        expect(auth(device.old)).not.toMatch(/^\+OK/);
      });
    });

    it("Kafka with its login swaps the password, and its start keeps the new one", async () => {
      const old = newValue("kafka", "password");
      const plan = planOf({ kind: "kafka", options: { login: true } });
      const project = new Project("kafka", plan, { password: old });
      const host = project.service.name;
      await withProject(project, async () => {
        // A Kafka client's SCRAM login through the clients' listener, with the image's own tools.
        const login = (password: string) =>
          project.sh(
            `printf 'security.protocol=SASL_PLAINTEXT\\nsasl.mechanism=SCRAM-SHA-512\\nsasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="%s";\\n' "$P" > /tmp/client.properties && KAFKA_HEAP_OPTS=-Xmx64m timeout 120 /opt/kafka/bin/kafka-topics.sh --bootstrap-server ${host}:9092 --command-config /tmp/client.properties --list`,
            { P: password },
          ).status;
        expect(login(old)).toBe(0);
        const next = newValue("kafka", "password");
        project.run(rotationOf(project, "password").begin(project.ctx), old, next);
        expect(login(next)).toBe(0);
        expect(login(old)).not.toBe(0);
        await project.restart();
        await eventually(() => expect(login(next)).toBe(0));
        expect(login(old)).not.toBe(0);
      });
    });

    it("Redpanda with its login swaps the password, rpk and its health check on the new one", async () => {
      const old = newValue("redpanda", "password");
      const plan = planOf({ kind: "redpanda", options: { login: true } });
      const project = new Project("redpanda", plan, { password: old });
      await withProject(project, async () => {
        const login = (password: string) =>
          project.sh("rpk topic list", { RPK_PASS: password }).status;
        expect(login(old)).toBe(0);
        const next = newValue("redpanda", "password");
        project.run(rotationOf(project, "password").begin(project.ctx), old, next);
        expect(login(next)).toBe(0);
        expect(login(old)).not.toBe(0);
        expect(project.checkHealth()).toBe(0);
        await project.restart();
        expect(login(next)).toBe(0);
        expect(login(old)).not.toBe(0);
      });
    });

    for (const [kind, user] of [
      ["opensearch", "admin"],
      ["elasticsearch", "elastic"],
    ] as const) {
      it(`${kind} swaps ${user}'s password, its health check on the new one`, async () => {
        const old = newValue(kind, "password");
        const project = new Project(kind, planOf({ kind }), { password: old });
        await withProject(project, async () => {
          const http = (password: string) =>
            project.curl(["-u", `${user}:${password}`, `http://${project.service.name}:9200/`]);
          expect(http(old)).toBe("200");
          const next = newValue(kind, "password");
          project.run(rotationOf(project, "password").begin(project.ctx), old, next);
          expect(http(old)).toBe("401");
          expect(http(next)).toBe("200");
          expect(project.checkHealth()).toBe(0);
          await project.restart();
          expect(http(next)).toBe("200");
          expect(http(old)).toBe("401");
        });
      });
    }

    it("ClickHouse: a fresh start, then its users file rewritten while it runs, no restart", async () => {
      const old = newValue("clickhouse", "password");
      const project = new Project("clickhouse", planOf({ kind: "clickhouse" }), { password: old });
      await withProject(project, async () => {
        const http = (user: string, password: string) =>
          project.curl(["-u", `${user}:${password}`, "http://clickhouse:8123/?query=SELECT%201"]);
        // The first start: the app's user from the env, its database, and no `default` user.
        await eventually(() => expect(http("app", old)).toBe("200"));
        expect(
          project.ok("clickhouse-client -u app -q 'SHOW DATABASES'", { CLICKHOUSE_PASSWORD: old }),
        ).toMatch(/^app$/m);
        expect(project.sh("clickhouse-client --user default -q 'SELECT 1'").status).not.toBe(0);
        expect(http("default", "")).not.toBe("200");
        const started = project.startedAt();
        const next = newValue("clickhouse", "password");
        const r = rotationOf(project, "password");
        project.run(r.begin(project.ctx), old, next);
        expect(http("app", old)).not.toBe("200");
        expect(http("app", next)).toBe("200");
        expect(project.startedAt()).toBe(started);
        // A restart keeps the rewritten file: the env's old password is for the first start only.
        await project.restart();
        await eventually(() => expect(http("app", next)).toBe("200"));
        expect(http("app", old)).not.toBe("200");
        // The container created again from the new env file starts with the new password.
        project.secrets = { password: next };
        project.up();
        await eventually(() => expect(http("app", next)).toBe("200"));
        expect(http("app", old)).not.toBe("200");
      });
    });

    it("NATS: the token's included file rewritten and reloaded, the old clients closed", async () => {
      const old = newValue("nats", "token");
      const project = new Project("nats", planOf({ kind: "nats" }), { token: old });
      await withProject(project, async () => {
        const connect = (token: string) =>
          project.ok(
            `{ printf 'CONNECT {"auth_token":"%s","verbose":false}\\r\\nPING\\r\\n' "$T"; sleep 1; } | nc 127.0.0.1 4222`,
            { T: token },
          );
        expect(connect(old)).toContain("PONG");
        project.hold(
          `${twoParts(`printf 'CONNECT {"auth_token":"%s","verbose":false}\\r\\nPING\\r\\n' "$T"`, "printf 'PING\\r\\n'; sleep 1")} | nc 127.0.0.1 4222`,
          { T: old },
        );
        await eventually(() => expect(project.held()).toContain("PONG"));
        const started = project.startedAt();
        const next = newValue("nats", "token");
        const r = rotationOf(project, "token");
        project.run(r.begin(project.ctx), old, next);
        await eventually(() => expect(project.held()).toContain("Authorization Violation"));
        expect(connect(old)).toContain("Authorization Violation");
        expect(connect(next)).toContain("PONG");
        expect(project.startedAt()).toBe(started);
        await project.restart();
        await eventually(() => expect(connect(next)).toContain("PONG"));
        expect(connect(old)).toContain("Authorization Violation");
      });
    });

    it("Garage: a second key, the old one deleted after the switch, then a new RPC secret", async () => {
      const old = {
        "rpc-secret": newValue("garage", "rpc-secret"),
        "key-id": newValue("garage", "key-id"),
        "secret-key": newValue("garage", "secret-key"),
      };
      const project = new Project(
        "garage",
        planOf({ kind: "garage" }, { storage: GARAGE_STORAGE }),
        old,
      );
      const bucket = GARAGE_STORAGE.objectStorage.bucket;
      await withProject(project, async () => {
        const s3 = (key: { "key-id": string; "secret-key": string }) =>
          project.curl([
            "--aws-sigv4",
            "aws:amz:garage:s3",
            "--user",
            `${key["key-id"]}:${key["secret-key"]}`,
            `http://${project.service.name}:3900/${bucket}`,
          ]);
        await eventually(() => expect(s3(old)).toBe("200"));
        const next = {
          ...old,
          "key-id": newValue("garage", "key-id"),
          "secret-key": newValue("garage", "secret-key"),
        };
        const key = rotationOf(project, "key-id");
        project.run(key.begin(project.ctx), "", "");
        expect(s3(old)).toBe("200");
        // `finish` before the recreate (a resume after a start from an env still naming the old
        // key, which makes no new one): it leaves the only key there is.
        project.run(key.finish(project.ctx), "", "");
        expect(s3(old)).toBe("200");
        // Created again from the new env file: its start makes the new key beside the old.
        expect(key.recreate).toBe(true);
        project.secrets = next;
        project.up();
        await eventually(() => expect(s3(next)).toBe("200"));
        expect(s3(old)).toBe("200");
        project.run(key.finish(project.ctx), "", "");
        expect(s3(old)).toBe("403");
        expect(s3(next)).toBe("200");
        await project.restart();
        expect(s3(next)).toBe("200");
        expect(s3(old)).toBe("403");
        // The RPC secret: a restart with the new env, the key and bucket as they were.
        expect(rotationOf(project, "rpc-secret").mode).toBe("restart");
        project.secrets = { ...next, "rpc-secret": newValue("garage", "rpc-secret") };
        project.up();
        await eventually(() => expect(s3(next)).toBe("200"));
        expect(s3(old)).toBe("403");
      });
    });

    it("Garage: its key's undo puts the old key back wherever the rotation stopped", async () => {
      const old = {
        "rpc-secret": newValue("garage", "rpc-secret"),
        "key-id": newValue("garage", "key-id"),
        "secret-key": newValue("garage", "secret-key"),
      };
      const project = new Project(
        "garage-undo",
        planOf({ kind: "garage" }, { storage: GARAGE_STORAGE }),
        old,
      );
      const bucket = GARAGE_STORAGE.objectStorage.bucket;
      await withProject(project, async () => {
        const s3 = (key: { "key-id": string; "secret-key": string }) =>
          project.curl([
            "--aws-sigv4",
            "aws:amz:garage:s3",
            "--user",
            `${key["key-id"]}:${key["secret-key"]}`,
            `http://${project.service.name}:3900/${bucket}`,
          ]);
        const named = (name: string) => project.exec(["/garage", "key", "info", name]);
        const key = rotationOf(project, "key-id");
        const undo = () => project.run(key.undo?.(project.ctx) ?? [], "", "");
        // The old key under the name its start gives it, and no other.
        const asBefore = () => {
          expect(s3(old)).toBe("200");
          expect(named("default access key")).toBe(0);
          expect(named("opscrew-previous")).not.toBe(0);
        };
        await eventually(() => expect(s3(old)).toBe("200"));
        // Stopped before begin: nothing to put back, and the key in use stays.
        undo();
        asBefore();
        // Stopped after begin, before the recreate: the start has made no new key yet.
        project.run(key.begin(project.ctx), "", "");
        undo();
        asBefore();
        // Stopped after the recreate, before finish: the new key goes.
        const next = {
          ...old,
          "key-id": newValue("garage", "key-id"),
          "secret-key": newValue("garage", "secret-key"),
        };
        project.run(key.begin(project.ctx), "", "");
        project.secrets = next;
        project.up();
        await eventually(() => expect(s3(next)).toBe("200"));
        undo();
        expect(s3(next)).toBe("403");
        asBefore();
        // Then the old env file back, the service created again from it.
        project.secrets = old;
        project.up();
        await eventually(() => expect(s3(old)).toBe("200"));
        asBefore();
        expect(s3(next)).toBe("403");
      });
    });

    it("Garage: a restored copy from before its key's rotation loses that key by its ID, the env's key kept", async () => {
      const old = {
        "rpc-secret": newValue("garage", "rpc-secret"),
        "key-id": newValue("garage", "key-id"),
        "secret-key": newValue("garage", "secret-key"),
      };
      const project = new Project(
        "garage-restore",
        planOf({ kind: "garage" }, { storage: GARAGE_STORAGE }),
        old,
      );
      const bucket = GARAGE_STORAGE.objectStorage.bucket;
      const copy = `${project.name}-copy`;
      remember(IMAGES.busybox.ref);
      try {
        await withProject(project, async () => {
          const s3 = (key: { "key-id": string; "secret-key": string }) =>
            project.curl([
              "--aws-sigv4",
              "aws:amz:garage:s3",
              "--user",
              `${key["key-id"]}:${key["secret-key"]}`,
              `http://${project.service.name}:3900/${bucket}`,
            ]);
          const garageKey = (args: string[]) => project.exec(["/garage", "key", ...args]);
          /** Garage stopped, then `script` with its data folder and the copy's volume at /copy. */
          const stopped = (script: string) => {
            const container = project.container();
            project.compose(["stop", project.service.name]);
            docker(
              [
                "run",
                "--rm",
                "--volumes-from",
                container,
                "-v",
                `${copy}:/copy`,
                IMAGES.busybox.ref,
                "sh",
                "-c",
                script,
              ],
              { env: project.env },
            );
          };
          const data = serviceSpec("garage").dataDir;
          await eventually(() => expect(s3(old)).toBe("200"));
          // The snapshot by stopping Garage: its data with the old key.
          stopped(`cp -a ${data}/. /copy/`);
          project.up();
          await eventually(() => expect(s3(old)).toBe("200"));
          // The key's rotation: begin, the start from the new env file, finish.
          const next = {
            ...old,
            "key-id": newValue("garage", "key-id"),
            "secret-key": newValue("garage", "secret-key"),
          };
          const key = rotationOf(project, "key-id");
          project.run(key.begin(project.ctx), "", "");
          project.secrets = next;
          project.up();
          await eventually(() => expect(s3(next)).toBe("200"));
          project.run(key.finish(project.ctx), "", "");
          expect(s3(old)).toBe("403");
          // The restore: the copy back, and Garage started from the current env file, which makes
          // the env's key beside the restored one, under the same name, and allows it on the bucket.
          stopped(
            `find ${data} -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -a /copy/. ${data}/`,
          );
          project.up();
          await eventually(() => expect(s3(next)).toBe("200"));
          expect(s3(old)).toBe("200");
          expect(garageKey(["info", "default access key"])).not.toBe(0);
          // The re-login, as the restore runs it (twice, as a try again would): once Garage holds
          // the env's key, the old key deleted by its ID while Garage holds it, never the env's.
          for (const _ of [1, 2]) {
            expect(garageKey(["info", next["key-id"]])).toBe(0);
            if (old["key-id"] !== next["key-id"] && garageKey(["info", old["key-id"]]) === 0) {
              expect(garageKey(["delete", "--yes", old["key-id"]])).toBe(0);
            }
          }
          const keys = docker(["exec", project.container(), "/garage", "key", "list"], {
            env: project.env,
          });
          expect(keys.match(/GK[0-9a-f]+/g)).toEqual([next["key-id"]]);
          expect(garageKey(["info", "default access key"])).toBe(0);
          expect(s3(next)).toBe("200");
          expect(s3(old)).toBe("403");
          await project.restart();
          expect(s3(next)).toBe("200");
          expect(s3(old)).toBe("403");
        });
      } finally {
        spawnSync("docker", ["volume", "rm", "-f", copy]);
      }
    });
  },
);
