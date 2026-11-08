// Feature 025 (T2509): the app's own secrets rotated through each target's own switch: the
// servers' rotate.sh (its env file and the app's switch, no service step) and this computer's
// env file and Compose (US4, FR-2502, FR-2504, FR-2507).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import type { GitHubApi } from "../provision/types";
import { updateServerAddresses } from "../shared";
import { assembleAppEnv, dotenvLine, type GeneratedValues } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import { DATA_IPV4, everythingShown, gitRemote, stagingPlan } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  ScriptedRunner,
  SERVER_IPV4,
  type TestPhaseDeps,
} from "../testing";
import { dropPreviousNames } from "./app-values";
import { rotateLocalServices } from "./localhost";
import { credentialsRecordFile } from "./record";
import { rotateServices } from "./server";
import { pendingRotationFile } from "./values-pending";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const hex = () => randomBytes(32).toString("hex");
const laravelKey = () => `base64:${randomBytes(32).toString("base64")}`;

/** The wrapper `server.ts` puts around each command: the app's folder, then the deploy user. */
const WRAPPED =
  /^cd '[^']*' \|\| exit 3; if \[ "\$\(id -u\)" = 0 \]; then runuser -u deploy -- sh -c ('(?:[^']|'\\'')*'); else sh -c \1; fi$/s;
const unquote = (quoted: string) => quoted.slice(1, -1).replaceAll("'\\''", "'");
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * The app's server: its `app.env`, and `rotate.sh`, which needs its one-time approval and writes
 * the app's settings from its input's first line (step 4), keeping the old ones for an undo.
 */
class FakeServer {
  readonly commands: string[] = [];
  readonly inputs: string[] = [];
  appEnv: string | undefined;
  /** The next run of this action fails. */
  fail: string | undefined;
  private approval: string | undefined;
  private previous: string | undefined;

  constructor(private readonly log: string[]) {}

  remote = (host: string): RemoteExec => ({
    host,
    run: async (wrapped, options) => this.handle(wrapped, options?.input ?? ""),
  });

  private handle(wrapped: string, input: string): CommandResult {
    const match = WRAPPED.exec(wrapped);
    if (match?.[1] === undefined) throw new Error(`unexpected command: ${wrapped}`);
    const command = unquote(match[1]);
    this.commands.push(command);
    if (command.includes("cat app.env")) {
      return this.appEnv === undefined ? { exitCode: 4, stdout: "", stderr: "" } : ok(this.appEnv);
    }
    if (command.includes("cat > .rotate/rotate.sh")) {
      this.approval = /printf '%s\\n' '([^']*)'/.exec(command)?.[1];
      return ok();
    }
    if (command === "rm -f .rotate/approval") return ok();
    const run = /^sh \.rotate\/rotate\.sh (.+)$/.exec(command);
    if (run?.[1] === undefined) throw new Error(`unexpected command: ${command}`);
    const [first = "", second] = run[1].split(" ");
    const action = second === undefined ? "rotate" : "undo";
    const hash = second ?? first;
    const [approved, choice] = (this.approval ?? "").split(" ");
    this.approval = undefined;
    this.log.push(`app ${action}`);
    this.inputs.push(input);
    if (approved !== hash || choice !== action) {
      return { exitCode: 1, stdout: "", stderr: "The one-time approval is for another rotation." };
    }
    if (this.fail === action) {
      this.fail = undefined;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "The app's switch failed: it did not get healthy.",
      };
    }
    if (action === "undo") {
      if (this.previous !== undefined) this.appEnv = this.previous;
      return ok();
    }
    this.previous = this.appEnv;
    this.appEnv = Buffer.from(input.split("\n")[0] ?? "", "base64").toString("utf8");
    return ok();
  }
}

/** GitHub's deploy pause, deploy runs and secrets. */
class FakeGitHub {
  readonly secrets = new Map<string, string>();
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
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.secrets.set(name, value);
    this.log.push(`github secret ${name}`);
  }
}

/**
 * `plan` with no database, and Laravel's key, Better Auth's secret and the cron jobs' secret
 * generated.
 */
function withAppSecrets(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      env: [
        ...plan.app.env.filter((variable) => variable.name !== "DATABASE_URL"),
        { name: "APP_KEY", secret: true, source: "generated" },
        { name: "BETTER_AUTH_SECRET", secret: true, source: "generated" },
        { name: "CRON_SECRET", secret: true, source: "generated" },
      ],
    },
  });
}

/** The generated app values of a deployed app: Laravel's, Better Auth's, the session's, cron's. */
function oldValues() {
  return {
    env: {
      SESSION_SECRET: hex(),
      APP_KEY: laravelKey(),
      BETTER_AUTH_SECRET: hex(),
      CRON_SECRET: hex(),
    },
  };
}

interface ServerWorld {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  handler: ScriptedApprovalHandler;
  server: FakeServer;
  github: FakeGitHub;
  log: string[];
  old: ReturnType<typeof oldValues>;
  dotenv: string;
  run(names: readonly string[], undo?: boolean): ReturnType<typeof rotateServices>;
}

/** `shop` in staging on a Hetzner server, deployed with the values this computer keeps. */
async function serverWorld(
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0],
): Promise<ServerWorld> {
  const plan = withAppSecrets(stagingPlan([]));
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
  const old = oldValues();
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), `${JSON.stringify(old)}\n`);
  const log: string[] = [];
  const server = new FakeServer(log);
  const dotenv = `STRIPE_SECRET_KEY=${hex()}\n`;
  server.appEnv = (await assembleAppEnv({ plan, previous: old, dotenvText: dotenv })).appEnv;
  const github = new FakeGitHub(log);
  return {
    deps,
    plan,
    handler,
    server,
    github,
    log,
    old,
    dotenv,
    run: (names, undo) =>
      rotateServices(deps, plan, names, {
        github: { api: github as unknown as GitHubApi, owner: "acme", repo: "shop" },
        remote: (host) => {
          if (host !== SERVER_IPV4) throw new Error(`no fake server at ${host}`);
          return server.remote(host);
        },
        sleep: async () => {},
        now: () => 0,
        ...(undo === true ? { undo } : {}),
      }),
  };
}

async function generatedEnv(deps: TestPhaseDeps): Promise<Record<string, string>> {
  return (
    (JSON.parse(await readFile(generatedValuesFile(deps), "utf8")) as GeneratedValues).env ?? {}
  );
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Nothing any output, audit entry, approval, error or server command holds any of `values`. */
function expectNoValue(
  w: Pick<ServerWorld, "deps" | "handler">,
  values: readonly string[],
  ...more: string[]
): void {
  const said = [everythingShown(w), ...more].join("\n");
  for (const value of values) expect(said).not.toContain(value);
}

describe("rotateServices with the app's own secrets", () => {
  it("rotates Laravel's key keeping the old one in APP_PREVIOUS_KEYS: GitHub's settings, rotate.sh's switch, then the record", async () => {
    const w = await serverWorld();
    const result = await w.run(["app:APP_KEY"]);

    const env = await generatedEnv(w.deps);
    const fresh = env.APP_KEY as string;
    expect(fresh).toMatch(/^base64:/);
    expect(fresh).not.toBe(w.old.env.APP_KEY);
    expect(env.APP_PREVIOUS_KEYS).toBe(w.old.env.APP_KEY);
    // The app's settings, as provision renders them from the values kept now: the new key, the old
    // one as the previous one; GitHub and the server hold the same.
    const rendered = (
      await assembleAppEnv({ plan: w.plan, previous: { env }, dotenvText: w.dotenv })
    ).appEnv;
    expect(w.github.secrets.get("OPSCREW_STAGING_APP_ENV")).toBe(rendered);
    expect(w.server.appEnv).toBe(rendered);
    expect(rendered).toContain(`${dotenvLine("APP_PREVIOUS_KEYS", w.old.env.APP_KEY)}\n`);
    // Only the app's settings: no service step, so rotate.sh gets one env file and no values.
    expect(w.server.inputs[0]?.replace(/\n$/, "").split("\n")).toHaveLength(1);
    expect(w.log).toEqual([
      "github pause",
      "github secret OPSCREW_STAGING_APP_ENV",
      "app rotate",
      "github resume",
    ]);

    // Seamless: approved by its hash alone, no typed name.
    const [request, ...others] = w.handler.requests;
    expect(others).toEqual([]);
    expect(request?.kind).toBe("remote-exec");
    expect(request?.planHash).toBe(result.hash);
    expect(request?.confirmPhrase).toBeUndefined();
    expect(request?.details).toContain(
      "app:APP_KEY: seamless: the new value is current, and the old one stays beside it in APP_PREVIOUS_KEYS",
    );
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(Object.keys(record.environments.staging ?? {})).toEqual(["app:APP_KEY"]);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    expect(w.deps.reporter.text()).toContain("stays as the previous one (APP_PREVIOUS_KEYS)");
    expectNoValue(w, [fresh, w.old.env.APP_KEY], ...w.server.commands);

    // `--drop-previous` drops it, once the app's name is typed: what it encrypted is lost.
    const names = await dropPreviousNames(w.deps, w.plan);
    expect(names).toEqual(["app:APP_PREVIOUS_KEYS"]);
    await w.run(names);
    const drop = w.handler.requests[1];
    expect(drop?.confirmPhrase).toBe(w.plan.app.name);
    expect(drop?.allowDestroy).toBe(true);
    expect((await generatedEnv(w.deps)).APP_PREVIOUS_KEYS).toBeUndefined();
    expect(w.server.appEnv).not.toContain("APP_PREVIOUS_KEYS");
    expect(w.server.appEnv).toContain(`${dotenvLine("APP_KEY", fresh)}\n`);
  });

  it("keeps Better Auth's old secret as version 1 of BETTER_AUTH_SECRETS, and changes CRON_SECRET with no typed name", async () => {
    const w = await serverWorld();
    await w.run(["app:BETTER_AUTH_SECRET", "app:CRON_SECRET"]);
    const env = await generatedEnv(w.deps);
    expect(env.BETTER_AUTH_SECRETS).toBe(
      `2:${env.BETTER_AUTH_SECRET},1:${w.old.env.BETTER_AUTH_SECRET}`,
    );
    expect(env.CRON_SECRET).not.toBe(w.old.env.CRON_SECRET);
    // The app and its cron jobs read the same app.env, which the one switch gives both.
    expect(w.server.appEnv).toContain(`${dotenvLine("CRON_SECRET", env.CRON_SECRET as string)}\n`);
    expect(w.handler.requests[0]?.confirmPhrase).toBeUndefined();
    expect(w.handler.requests[0]?.details).toContain(
      "app:CRON_SECRET: seamless: the app and its cron jobs get the new value in the same switch.",
    );
  });

  it("logs users out only after the consequence line and the app's name typed", async () => {
    const w = await serverWorld((request) =>
      request.confirmPhrase === undefined ? true : { approved: true, confirmation: "shopp" },
    );
    const before = w.server.appEnv;
    const error = await failure(w.run(["app"]));
    expect(error.code).toBe("APPROVAL_REFUSED");
    const [request] = w.handler.requests;
    expect(request?.details.split("\n")[0]).toBe(
      "Every user of shop-staging is logged out, or the tokens it issued stop working (app:SESSION_SECRET). To go ahead, type the app's name, shop-staging.",
    );
    expect(request?.allowDestroy).toBe(true);
    expect(request?.confirmPhrase).toBe("shop-staging");
    // Refused: nothing in GitHub or on the server changed, and the values stay as they were.
    expect(w.log).toEqual([]);
    expect(w.server.appEnv).toBe(before);
    expect(await generatedEnv(w.deps)).toEqual(w.old.env);

    // Typed right, it goes on with the same values and hash.
    const right = await serverWorld();
    const result = await right.run(["app"]);
    expect(right.handler.requests[0]?.planHash).toBe(result.hash);
    const env = await generatedEnv(right.deps);
    for (const [name, value] of Object.entries(right.old.env)) {
      expect(env[name]).not.toBe(value);
    }
    expectNoValue(right, [...Object.values(right.old.env), ...Object.values(env)]);
  });

  it("puts the old values back after a failed switch with --undo", async () => {
    const w = await serverWorld();
    w.server.fail = "rotate";
    const error = await failure(w.run(["app:APP_KEY"]));
    expect(error.hint).toContain("`opscrew rotate app:APP_KEY --undo`");
    const pending = JSON.parse(await readFile(pendingRotationFile(w.deps), "utf8"));
    expect(Object.keys(pending.app)).toEqual(["APP_KEY", "APP_PREVIOUS_KEYS"]);

    await w.run(["app:APP_KEY"], true);
    const before = (await assembleAppEnv({ plan: w.plan, previous: w.old, dotenvText: w.dotenv }))
      .appEnv;
    expect(w.github.secrets.get("OPSCREW_STAGING_APP_ENV")).toBe(before);
    expect(await generatedEnv(w.deps)).toEqual(w.old.env);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
  });
});

describe("rotateLocalServices with the app's own secrets", () => {
  it("rewrites the app's env file on this computer and recreates the app with Compose", async () => {
    const plan = withAppSecrets(localPlan());
    const composes: { args: readonly string[]; appEnv: string }[] = [];
    let folder = "";
    const runner = new ScriptedRunner(async (command, args) => {
      if (command === "docker" && args[0] === "compose") {
        composes.push({ args, appEnv: await readFile(join(folder, "app.env"), "utf8") });
      }
      return ok();
    });
    const deps = await createTestPhaseDeps({ runner, clock: { now: () => NOW } });
    folder = appFolder(deps.paths, plan);
    await writeArtifact("plan", deps.paths.files.plan, plan);
    // Its PostgreSQL's password too: the app's settings hold its address.
    const old = { ...oldValues(), dbPassword: hex() };
    await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
    await writeFile(generatedValuesFile(deps), `${JSON.stringify(old)}\n`);
    await mkdir(folder, { recursive: true });
    const appEnv = (await assembleAppEnv({ plan, previous: old })).appEnv;
    await writeFile(join(folder, "app.env"), appEnv);

    await rotateLocalServices(deps, plan, ["app:APP_KEY"], { services: { sleep: async () => {} } });
    const env = await generatedEnv(deps);
    const written = await readFile(join(folder, "app.env"), "utf8");
    expect(written).toBe(
      (await assembleAppEnv({ plan, previous: { env, dbPassword: old.dbPassword } })).appEnv,
    );
    expect(written).toContain(`${dotenvLine("APP_PREVIOUS_KEYS", old.env.APP_KEY)}\n`);
    // One `compose up`, of the app and its processes, once the file holds the new key.
    expect(composes).toHaveLength(1);
    expect(composes[0]?.args).toContain("app");
    expect(composes[0]?.appEnv).toBe(written);
    expect(await exists(join(folder, ".snapshots", ".held"))).toBe(false);
  });
});
