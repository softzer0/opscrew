// Feature 025 (T2509): a server-less site's own secrets rotated through its GitHub secrets and a
// deploy started and followed to its end (US4, FR-2501, FR-2502, FR-2512).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exists, OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import { everythingShown } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  sitePlan,
  type TestPhaseDeps,
} from "../testing";
import { rotateSiteAppSecrets } from "./app-site";
import { dropPreviousNames } from "./app-values";
import { credentialsRecordFile } from "./record";
import { pendingRotationFile } from "./values-pending";

const hex = () => randomBytes(32).toString("hex");
const RUN_URL = "https://github.com/acme/docs/actions/runs/9";

/** The repository: its secrets and the deploy runs it was asked to start. */
class FakeGitHub {
  readonly secrets = new Map<string, string>();
  readonly log: string[] = [];
  /** How the next run ends. */
  conclusion: string | null = "success";
  status: "completed" | "waiting" = "completed";
  async setActionsSecret(_owner: string, _repo: string, name: string, value: string) {
    this.secrets.set(name, value);
    this.log.push(`secret ${name}`);
  }
  async deleteActionsSecret(_owner: string, _repo: string, name: string) {
    this.secrets.delete(name);
    this.log.push(`delete ${name}`);
  }
  async dispatchWorkflow(
    _owner: string,
    _repo: string,
    workflowFile: string,
    ref: string,
    _inputs: Record<string, string>,
    onAccepted?: () => Promise<void>,
  ) {
    this.log.push(`dispatch ${workflowFile} ${ref}`);
    await onAccepted?.();
    return { runId: 9, url: RUN_URL };
  }
  async waitForWorkflowRun() {
    return {
      id: 9,
      status: this.status,
      conclusion: this.conclusion,
      htmlUrl: RUN_URL,
      headSha: "0".repeat(40),
    };
  }
}

/**
 * A Cloudflare site rendered on the server (Astro), with an app key, Better Auth's and a session
 * secret.
 */
function plan(o: { promotedFrom?: string; render?: "static" | "ssr" } = {}): DeployPlan {
  const base = sitePlan({ render: "ssr", deployed: true, ...o });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: [
        { name: "APP_KEY", secret: true, source: "generated" },
        { name: "BETTER_AUTH_SECRET", secret: true, source: "generated" },
        { name: "SESSION_SECRET", secret: true, source: "generated" },
      ],
    },
  });
}

interface World {
  deps: TestPhaseDeps;
  handler: ScriptedApprovalHandler;
  github: FakeGitHub;
  plan: DeployPlan;
  old: Record<string, string>;
  run(names: readonly string[], undo?: boolean): ReturnType<typeof rotateSiteAppSecrets>;
}

async function world(p = plan()): Promise<World> {
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({ approvalHandler: handler });
  await writeArtifact("plan", deps.paths.files.plan, p);
  const old = {
    APP_KEY: `base64:${randomBytes(32).toString("base64")}`,
    BETTER_AUTH_SECRET: hex(),
    SESSION_SECRET: hex(),
  };
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), `${JSON.stringify({ env: old })}\n`);
  const github = new FakeGitHub();
  return {
    deps,
    handler,
    github,
    plan: p,
    old,
    run: (names, undo) =>
      rotateSiteAppSecrets(deps, p, names, {
        github: { api: github, owner: "acme", repo: "docs", defaultBranch: "main" },
        ...(undo === true ? { undo } : {}),
      }),
  };
}

async function generatedEnv(deps: TestPhaseDeps): Promise<Record<string, string>> {
  return JSON.parse(await readFile(generatedValuesFile(deps), "utf8")).env ?? {};
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("rotateSiteAppSecrets", () => {
  it("keeps the old app key in APP_PREVIOUS_KEYS and Better Auth's as version 1, with no typed name; a drop removes them", async () => {
    const w = await world();
    const result = await w.run(["app:APP_KEY", "app:BETTER_AUTH_SECRET"]);

    const env = await generatedEnv(w.deps);
    expect(env.APP_KEY).not.toBe(w.old.APP_KEY);
    expect(env.APP_PREVIOUS_KEYS).toBe(w.old.APP_KEY);
    expect(env.BETTER_AUTH_SECRETS).toBe(
      `2:${env.BETTER_AUTH_SECRET},1:${w.old.BETTER_AUTH_SECRET}`,
    );
    // Each in its own secret, which the site's workflow reads.
    for (const name of [
      "APP_KEY",
      "APP_PREVIOUS_KEYS",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_SECRETS",
    ]) {
      expect(w.github.secrets.get(`OPSCREW_ENV_${name}`)).toBe(env[name]);
    }
    expect(w.github.log.at(-1)).toBe("dispatch opscrew-deploy.yml main");
    const [request, ...others] = w.handler.requests;
    expect(others).toEqual([]);
    expect(request?.kind).toBe("remote-exec");
    expect(request?.planHash).toBe(result.hash);
    expect(request?.confirmPhrase).toBeUndefined();
    expect(request?.allowDestroy).toBeUndefined();
    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(Object.keys(record.environments.prod ?? {}).sort()).toEqual([
      "app:APP_KEY",
      "app:BETTER_AUTH_SECRET",
    ]);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    const said = everythingShown(w);
    for (const value of [...Object.values(w.old), ...Object.values(env)]) {
      expect(said).not.toContain(value);
    }

    // The drop: the app's name typed, APP_PREVIOUS_KEYS's secret deleted, Better Auth's current
    // version alone.
    await w.run(await dropPreviousNames(w.deps, w.plan));
    expect(w.handler.requests[1]?.confirmPhrase).toBe(w.plan.app.name);
    expect(w.github.secrets.has("OPSCREW_ENV_APP_PREVIOUS_KEYS")).toBe(false);
    expect(w.github.log).toContain("delete OPSCREW_ENV_APP_PREVIOUS_KEYS");
    const dropped = await generatedEnv(w.deps);
    expect(dropped.APP_PREVIOUS_KEYS).toBeUndefined();
    expect(w.github.secrets.get("OPSCREW_ENV_BETTER_AUTH_SECRETS")).toBe(
      `2:${env.BETTER_AUTH_SECRET}`,
    );
  });

  it("logs the site's users out of a session secret only after the typed app name", async () => {
    const w = await world();
    await w.run(["app:SESSION_SECRET"]);
    const [request] = w.handler.requests;
    expect(request?.confirmPhrase).toBe(w.plan.app.name);
    expect(request?.allowDestroy).toBe(true);
    expect(request?.details.split("\n")[0]).toBe(
      `Every user of ${w.plan.app.name} is logged out, or the tokens it issued stop working (app:SESSION_SECRET). To go ahead, type the app's name, ${w.plan.app.name}.`,
    );
    expect(w.github.secrets.get("OPSCREW_ENV_SESSION_SECRET")).toBe(
      (await generatedEnv(w.deps)).SESSION_SECRET,
    );
  });

  it("rotates Better Auth's secret as any other when the plan names BETTER_AUTH_SECRETS as the user's", async () => {
    const base = plan();
    const theirs = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [...base.app.env, { name: "BETTER_AUTH_SECRETS", secret: true, source: "user" }],
      },
    });
    const w = await world(theirs);
    await w.run(["app:BETTER_AUTH_SECRET"]);
    const [request] = w.handler.requests;
    // Their value stays theirs: no previous value of OpsCrew's goes into it, so users are logged
    // out and the app's name is typed.
    expect(request?.confirmPhrase).toBe(theirs.app.name);
    expect(request?.details.split("\n")[0]).toContain("(app:BETTER_AUTH_SECRET)");
    const env = await generatedEnv(w.deps);
    expect(env.BETTER_AUTH_SECRETS).toBeUndefined();
    expect(w.github.log).toEqual([
      "secret OPSCREW_ENV_BETTER_AUTH_SECRET",
      "dispatch opscrew-deploy.yml main",
    ]);
  });

  it("keeps the values after a failed deploy, goes on with the same ones, or puts the old ones back", async () => {
    const w = await world();
    w.github.conclusion = "failure";
    const error = await failure(w.run(["app:SESSION_SECRET"]));
    expect(error.message).toContain("The old and the new values stay on this computer");
    expect(error.hint).toContain("`opscrew rotate app:SESSION_SECRET --undo`");
    const fresh = w.github.secrets.get("OPSCREW_ENV_SESSION_SECRET");
    expect((await generatedEnv(w.deps)).SESSION_SECRET).toBe(w.old.SESSION_SECRET);

    // Run again: the same values, approved by the same hash.
    w.github.conclusion = "success";
    const again = await w.run(["app:SESSION_SECRET"]);
    expect(w.handler.requests[1]?.planHash).toBe(again.hash);
    expect(w.handler.requests[0]?.planHash).toBe(again.hash);
    expect((await generatedEnv(w.deps)).SESSION_SECRET).toBe(fresh);

    // An undo of a stopped rotation: the old values back, with a deploy.
    const u = await world();
    u.github.conclusion = "failure";
    await failure(u.run(["app:SESSION_SECRET"]));
    u.github.conclusion = "success";
    await u.run(["app:SESSION_SECRET"], true);
    expect(u.github.secrets.get("OPSCREW_ENV_SESSION_SECRET")).toBe(u.old.SESSION_SECRET);
    expect(u.github.log.at(-1)).toBe("dispatch opscrew-deploy.yml main");
    expect(await generatedEnv(u.deps)).toEqual(u.old);
    expect(await exists(pendingRotationFile(u.deps))).toBe(false);

    // Undone, a previous value the rotation added is deleted again.
    const k = await world();
    k.github.conclusion = "failure";
    await failure(k.run(["app:APP_KEY"]));
    expect(k.github.secrets.get("OPSCREW_ENV_APP_PREVIOUS_KEYS")).toBe(k.old.APP_KEY);
    k.github.conclusion = "success";
    await k.run(["app:APP_KEY"], true);
    expect(k.github.secrets.get("OPSCREW_ENV_APP_KEY")).toBe(k.old.APP_KEY);
    expect(k.github.secrets.has("OPSCREW_ENV_APP_PREVIOUS_KEYS")).toBe(false);
  });

  it("refuses a service's name, and a promoted environment whose workflow reads none of its own values", async () => {
    const w = await world();
    const named = await failure(w.run(["db"]));
    expect(named.code).toBe("INVALID_INPUT");
    expect(named.message).toContain("db is not among the credentials of the site");

    // A static site promoted from staging is built there, with staging's values.
    const promoted = await world(plan({ promotedFrom: "staging", render: "static" }));
    const error = await failure(promoted.run(["app"]));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "deploys the site built for the environment it is promoted from",
    );
    expect(promoted.github.log).toEqual([]);
  });
});
