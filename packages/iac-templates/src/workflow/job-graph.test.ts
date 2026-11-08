// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { testContext } from "../__fixtures__/plans";
import * as templates from "../index";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { cloudflarePlan, pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { inEnvironment, localhostPlan, ofApp, serverPlan, withPlan } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

/*
 * Every deploy workflow's job graph, run through GitHub's rules for a job's `if:` on the cases
 * research R6 ran on real GitHub (S3, S4): a job runs when its condition holds, a condition with
 * no status function (success(), failure(), cancelled(), always()) is `success() && (…)`, and
 * success() holds only when every job before it, even indirectly, succeeded. A job that runs
 * succeeds unless the case fails it; its outputs are then `<job>'s <output>`.
 */

type Value = string | number | boolean | null | { [key: string]: Value };

/** GitHub's truthiness: false, 0, '', null and NaN are false. */
const truthy = (v: Value) =>
  !(v === false || v === 0 || v === "" || v === null || Number.isNaN(v as number));

/** GitHub's number for a comparison of values of different types. */
function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return Number.NaN;
}

/** GitHub's `==`: strings without case, values of different types as numbers. */
function equal(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b && (a === null || typeof a !== "object")) return a === b;
  return toNumber(a) === toNumber(b);
}

const TOKEN =
  /\s*(?:('(?:[^']|'')*')|(\d+)|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(&&|\|\||==|!=|>=|<=|[!()<>,]))/y;

/** The expression's tokens; anything else in it is an error. */
function tokenize(expression: string): { kind: string; text: string }[] {
  const tokens: { kind: string; text: string }[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.trimEnd().length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expression);
    if (m === null) throw new Error(`cannot read ${expression.slice(at)}`);
    const kind = m[1] ? "string" : m[2] ? "number" : m[3] ? "name" : "op";
    tokens.push({ kind, text: (m[1] ?? m[2] ?? m[3] ?? m[4]) as string });
  }
  return tokens;
}

/** A job's status functions and the contexts its expressions read. */
interface Scope {
  contexts: Record<string, Value>;
  success: boolean;
  failure: boolean;
}

/** Evaluates a GitHub Actions expression (without `${{ }}`) as GitHub does, for the forms used. */
function evaluate(expression: string, scope: Scope): Value {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at]?.text;
  const take = (text?: string) => {
    const token = tokens[at++];
    if (token === undefined || (text !== undefined && token.text !== text)) {
      throw new Error(`expected ${text ?? "more"} in ${expression}`);
    }
    return token;
  };
  const call = (name: string, args: Value[]): Value => {
    if (name === "success") return scope.success;
    if (name === "failure") return scope.failure;
    if (name === "cancelled") return false;
    if (name === "always") return true;
    if (name === "contains") {
      const [search, item] = args;
      return String(search ?? "")
        .toLowerCase()
        .includes(String(item ?? "").toLowerCase());
    }
    throw new Error(`no function ${name} in ${expression}`);
  };
  const primary = (): Value => {
    const token = take();
    if (token.text === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.kind === "string") return token.text.slice(1, -1).replaceAll("''", "'");
    if (token.kind === "number") return Number(token.text);
    if (token.kind !== "name") throw new Error(`unexpected ${token.text} in ${expression}`);
    if (peek() === "(") {
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      return call(token.text, args);
    }
    if (token.text === "true" || token.text === "false") return token.text === "true";
    if (token.text === "null") return null;
    return token.text
      .split(".")
      .reduce<Value>(
        (value, key) => (value !== null && typeof value === "object" ? (value[key] ?? null) : null),
        scope.contexts,
      );
  };
  const unary = (): Value => {
    if (peek() !== "!") return primary();
    take("!");
    return !truthy(unary());
  };
  const compare = (): Value => {
    let value = unary();
    for (let op = peek(); op && ["==", "!=", ">", "<", ">=", "<="].includes(op); op = peek()) {
      take();
      const right = unary();
      const [a, b] = [toNumber(value), toNumber(right)];
      value =
        op === "=="
          ? equal(value, right)
          : op === "!="
            ? !equal(value, right)
            : op === ">"
              ? a > b
              : op === "<"
                ? a < b
                : op === ">="
                  ? a >= b
                  : a <= b;
    }
    return value;
  };
  const and = (): Value => {
    let value = compare();
    while (peek() === "&&") {
      take();
      const right = compare();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unexpected ${peek()} in ${expression}`);
  return value;
}

/** The expression inside `${{ }}`. */
const inner = (text: string) => text.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, (_, e: string) => e);

/** One run of a workflow. */
interface Run {
  /** The dispatch's inputs; `{}` on a push (S3). */
  inputs?: Record<string, Value>;
  /** `OPSCREW_DEPLOY_PAUSED`, when it is set. */
  paused?: string;
  /** `github.run_attempt`, a string as GitHub gives it (S4). */
  attempt?: string;
  /** The jobs that fail when they run. */
  fail?: readonly string[];
}

type Result = "success" | "failure" | "skipped";
type JobDoc = {
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps: {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
  }[];
};

/**
 * Runs `content`'s jobs in the order of their needs, as GitHub decides them for `run`. Returns
 * each job's result, and an evaluator of an expression in a job, with that job's `needs`.
 */
function simulate(content: string, run: Run) {
  const jobs = (parse(content) as { jobs: Record<string, JobDoc> }).jobs;
  const needsOf = (id: string): string[] => {
    const needs = jobs[id]?.needs;
    return needs === undefined ? [] : typeof needs === "string" ? [needs] : needs;
  };
  const before = (id: string): string[] => needsOf(id).flatMap((n) => [n, ...before(n)]);
  const results: Record<string, Result> = {};
  const outputs: Record<string, Value> = {};
  const vars: Record<string, Value> =
    run.paused === undefined ? {} : { OPSCREW_DEPLOY_PAUSED: run.paused };
  const contexts = {
    inputs: run.inputs ?? {},
    vars,
    github: { run_attempt: run.attempt ?? "1" },
  };
  const scopeOf = (id: string): Scope => {
    const done = before(id).map((n) => results[n]);
    const needs = Object.fromEntries(
      needsOf(id).map((n) => [n, { result: results[n] ?? null, outputs: outputs[n] ?? {} }]),
    );
    return {
      contexts: { ...contexts, needs },
      success: done.every((r) => r === "success"),
      failure: done.some((r) => r === "failure"),
    };
  };
  const pending = Object.keys(jobs);
  while (pending.length > 0) {
    const next = pending.findIndex((id) => needsOf(id).every((n) => results[n] !== undefined));
    if (next < 0) throw new Error(`jobs ${pending.join(", ")} need a job that never runs`);
    const [id] = pending.splice(next, 1) as [string];
    const condition = inner(jobs[id]?.if ?? "success()");
    const status = /\b(success|failure|cancelled|always)\(/.test(condition);
    const runs = truthy(evaluate(status ? condition : `success() && (${condition})`, scopeOf(id)));
    results[id] = !runs ? "skipped" : run.fail?.includes(id) ? "failure" : "success";
    if (results[id] === "success") {
      outputs[id] = Object.fromEntries(
        Object.keys(jobs[id]?.outputs ?? {}).map((name) => [name, `${id}'s ${name}`]),
      );
    }
  }
  return { results, value: (id: string, text: string) => evaluate(inner(text), scopeOf(id)) };
}

/** The jobs that ran (succeeded or failed) in `run`, in name order. */
const ran = (content: string, run: Run) =>
  Object.entries(simulate(content, run).results)
    .filter(([, result]) => result !== "skipped")
    .map(([id]) => id)
    .sort();

const ctx = { ...testContext(), localhost: { hostname: "shop.localhost" }, builderBranch: "main" };
const content = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;
const jobsOf = (text: string) => (parse(text) as { jobs: Record<string, JobDoc> }).jobs;

const DIGEST = `sha256:${"b".repeat(64)}`;
const COMMIT = "c".repeat(40);
const FROM = "d".repeat(40);
const SINCE = "2026-10-31T10:02:11.000Z";
/** The variable with a rollback's entry for `key`. */
const pausedFor = (key: string) =>
  JSON.stringify({
    [key]: { reason: "rollback", since: SINCE, image: DIGEST, commit: COMMIT, from: FROM },
  });

const PUSH: Run = { inputs: {} };
const PUSH_PAUSED: Run = { inputs: {}, paused: pausedFor("shop/prod") };
/** "Run workflow" in GitHub without inputs: the defaults. */
const BY_HAND: Run = { inputs: { digest: "", tag: "", rollback: false } };
const ROLLBACK: Run = { inputs: { digest: DIGEST, tag: COMMIT, rollback: true } };
const ROLLBACK_PAUSED: Run = { ...ROLLBACK, paused: pausedFor("shop/prod") };
const PROMOTION: Run = { inputs: { digest: DIGEST, tag: COMMIT, rollback: false } };
const PROMOTION_PAUSED: Run = { ...PROMOTION, paused: pausedFor("shop/prod") };

const PAUSED = `contains(vars.OPSCREW_DEPLOY_PAUSED, '"shop/prod"')`;
const PROMOTE = { from: "promote", source: "staging" } as const;

describe("a server environment that follows its branch (S3)", () => {
  const plan = withPlan(serverPlan(), {
    supplyChain: { sign: true },
    deployTags: { enabled: true },
  });
  const flow = content(plan);
  const jobs = jobsOf(flow);

  it("takes digest, tag and rollback by hand, optional, besides its pushes", () => {
    const on = (parse(flow) as { on: Record<string, unknown> }).on;
    expect(Object.keys(on)).toEqual(["push", "workflow_dispatch"]);
    expect(on.workflow_dispatch).toEqual({
      inputs: {
        digest: {
          description: expect.stringContaining("`opscrew rollback` fills it in"),
          required: false,
          type: "string",
          default: "",
        },
        tag: {
          description: expect.stringContaining("`opscrew rollback` fills it in"),
          required: false,
          type: "string",
          default: "",
        },
        rollback: {
          description: expect.stringContaining("`opscrew rollback` sets it"),
          required: false,
          type: "boolean",
          default: false,
        },
      },
    });
    expect(templates.ROLLBACK_INPUTS).toEqual({
      digest: "digest",
      tag: "tag",
      rollback: "rollback",
    });
  });

  it("has the needs and the conditions S3 ran", () => {
    expect(Object.keys(jobs)).toEqual([
      "paused",
      "build",
      "verify",
      "deploy",
      "sign",
      "tag",
      "prune",
      "label",
    ]);
    const shape = Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id, { needs: job.needs, if: job.if }]),
    );
    const afterBuild =
      "${{ !cancelled() && needs.build.result == 'success' && needs.deploy.result == 'success' }}";
    expect(shape).toEqual({
      paused: { if: `\${{ !(inputs.rollback) && ${PAUSED} }}` },
      build: { if: "${{ !inputs.rollback }}" },
      verify: { if: "${{ inputs.rollback }}" },
      deploy: {
        needs: ["build", "verify"],
        if: `\${{ !cancelled() && (needs.build.result == 'success' || needs.verify.result == 'success') && (inputs.rollback || !${PAUSED}) }}`,
      },
      sign: { needs: "build" },
      tag: { needs: ["build", "deploy"], if: afterBuild },
      prune: { needs: ["build", "deploy"], if: afterBuild },
      label: {
        needs: ["build", "verify", "deploy"],
        if: "${{ !cancelled() && needs.deploy.result == 'success' }}",
      },
    });
    // A dispatch makes the input a boolean: never compared with 'true' (S3).
    expect(flow).not.toMatch(/inputs\.rollback\s*[!=]=/);
    expect(flow).not.toContain("github.event.inputs");
  });

  it("builds and deploys on a push, and by hand without inputs", () => {
    const all = ["build", "deploy", "label", "prune", "sign", "tag"];
    expect(ran(flow, PUSH)).toEqual(all);
    expect(ran(flow, BY_HAND)).toEqual(all);
    // Another environment's pause is not this one's.
    expect(ran(flow, { inputs: {}, paused: pausedFor("shop/staging") })).toEqual(all);
  });

  it("would skip prune on every push without its condition, as S3 found on GitHub", () => {
    const doc = parse(flow) as { jobs: Record<string, JobDoc> };
    const { if: _condition, ...prune } = doc.jobs.prune as JobDoc;
    const without = stringify({ ...doc, jobs: { ...doc.jobs, prune } });
    expect(simulate(without, PUSH).results.prune).toBe("skipped");
    expect(simulate(flow, PUSH).results.prune).toBe("success");
  });

  it("builds and signs a push while paused, and only says why it does not deploy", () => {
    expect(ran(flow, PUSH_PAUSED)).toEqual(["build", "paused", "sign"]);
    const move = JSON.stringify({ "shop/prod": { reason: "move", since: SINCE } });
    expect(ran(flow, { inputs: {}, paused: move })).toEqual(["build", "paused", "sign"]);
  });

  it("deploys a rollback's image after verify, paused or not, and labels it", () => {
    expect(ran(flow, ROLLBACK)).toEqual(["deploy", "label", "verify"]);
    expect(ran(flow, ROLLBACK_PAUSED)).toEqual(["deploy", "label", "verify"]);
  });

  it("gives the deploy and the label the image of the job that ran, and the mode", () => {
    const start = (run: Run) => {
      const { value } = simulate(flow, run);
      const env = jobs.deploy?.steps.find((s) => s.id === "start")?.env ?? {};
      return {
        IMAGE: value("deploy", env.IMAGE ?? ""),
        TAG: value("deploy", env.TAG ?? ""),
        MODE: value("deploy", env.MODE ?? ""),
        label: value("label", jobs.label?.steps[1]?.env?.IMAGE ?? ""),
      };
    };
    const built = { IMAGE: "build's image", TAG: "build's tag", label: "build's image" };
    expect(start(PUSH)).toEqual({ ...built, MODE: "deploy" });
    expect(start(BY_HAND)).toEqual({ ...built, MODE: "deploy" });
    expect(start(ROLLBACK)).toEqual({
      IMAGE: "verify's image",
      TAG: "verify's tag",
      MODE: "rollback",
      label: "verify's image",
    });
    const rollbackStep = jobs.deploy?.steps.find((s) => s.name?.startsWith("Roll back"));
    expect(simulate(flow, ROLLBACK).value("deploy", rollbackStep?.env?.MODE ?? "")).toBe(
      "rollback",
    );
  });

  it("says what a rollback went back to only after the check from outside passed", () => {
    const steps = jobs.deploy?.steps ?? [];
    const at = (key: string) => steps.findIndex((s) => s.id === key || s.name === key);
    const SAID = "Say what the rollback went back to";
    expect(at("start")).toBeLessThan(at("health"));
    expect(at(SAID)).toBe(at("health") + 1);
    const said = steps[at(SAID)];
    // No status function: the step runs only while every step before it succeeded.
    expect(said?.if).toBe("inputs.rollback");
    expect(simulate(flow, ROLLBACK).value("deploy", said?.if ?? "")).toBe(true);
    expect(truthy(simulate(flow, PUSH).value("deploy", said?.if ?? ""))).toBe(false);
    expect(truthy(simulate(flow, BY_HAND).value("deploy", said?.if ?? ""))).toBe(false);
    expect(said?.env).toEqual({
      IMAGE: "${{ needs.build.outputs.image || needs.verify.outputs.image }}",
      TAG: "${{ needs.build.outputs.tag || needs.verify.outputs.tag }}",
    });
    expect(steps.find((s) => s.id === "start")?.run).not.toContain("GITHUB_STEP_SUMMARY");
  });

  it("deploys nothing after a failed build or verify, and tags and prunes only a healthy deploy", () => {
    expect(simulate(flow, { ...PUSH, fail: ["build"] }).results).toMatchObject({
      build: "failure",
      sign: "skipped",
      deploy: "skipped",
      tag: "skipped",
      prune: "skipped",
      label: "skipped",
    });
    expect(simulate(flow, { ...ROLLBACK, fail: ["verify"] }).results).toMatchObject({
      verify: "failure",
      deploy: "skipped",
      label: "skipped",
    });
    expect(simulate(flow, { ...PUSH, fail: ["deploy"] }).results).toMatchObject({
      sign: "success",
      deploy: "failure",
      tag: "skipped",
      prune: "skipped",
      label: "skipped",
    });
  });

  it("checks a rollback's digest against its own branch", () => {
    const develop = onBranch(serverPlan(), "develop");
    const verify = jobsOf(content(develop)).verify;
    expect(verify?.steps.find((s) => s.id === "provenance")?.env?.BUILD_BRANCH).toBe("develop");
  });
});

/** `plan` following `branch`. */
function onBranch(plan: DeployPlan, branch: string): DeployPlan {
  return { ...plan, cicd: { ...plan.cicd, branch } };
}

describe("a promoted server environment", () => {
  const flow = content(inEnvironment(serverPlan(), { deploySource: PROMOTE }));
  const jobs = jobsOf(flow);

  it("takes rollback besides the digest and the tag", () => {
    const on = (parse(flow) as { on: Record<string, { inputs: Record<string, unknown> }> }).on;
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(on.workflow_dispatch?.inputs).toEqual({
      digest: expect.objectContaining({ required: true, type: "string" }),
      tag: expect.objectContaining({ required: true, type: "string" }),
      rollback: expect.objectContaining({ required: false, type: "boolean", default: false }),
    });
  });

  it("has the needs and the conditions of plan.md 1.", () => {
    const shape = Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id, { needs: job.needs, if: job.if }]),
    );
    expect(shape).toEqual({
      paused: { if: `\${{ !(inputs.rollback) && ${PAUSED} }}` },
      verify: {},
      // The server's conditions: with verify the only image job, they hold as GitHub's own.
      deploy: {
        needs: "verify",
        if: `\${{ !cancelled() && (needs.verify.result == 'success') && (inputs.rollback || !${PAUSED}) }}`,
      },
      label: {
        needs: ["verify", "deploy"],
        if: "${{ !cancelled() && needs.deploy.result == 'success' }}",
      },
    });
  });

  it("deploys a promotion, unless paused, and a rollback always", () => {
    expect(ran(flow, PROMOTION)).toEqual(["deploy", "label", "verify"]);
    expect(ran(flow, PROMOTION_PAUSED)).toEqual(["paused", "verify"]);
    expect(ran(flow, ROLLBACK)).toEqual(["deploy", "label", "verify"]);
    expect(ran(flow, ROLLBACK_PAUSED)).toEqual(["deploy", "label", "verify"]);
    const mode = (run: Run) =>
      simulate(flow, run).value(
        "deploy",
        jobs.deploy?.steps.find((s) => s.id === "start")?.env?.MODE ?? "",
      );
    expect(mode(PROMOTION)).toBe("deploy");
    expect(mode(ROLLBACK)).toBe("rollback");
    expect(simulate(flow, { ...ROLLBACK, fail: ["verify"] }).results.deploy).toBe("skipped");
    expect(simulate(flow, { ...PROMOTION, fail: ["deploy"] }).results.label).toBe("skipped");
  });
});

describe("Portainer and the local runner, as a server", () => {
  const portainer = content(portainerTestPlan({ redeploy: "cloudflare" }));
  const local = content(inEnvironment(localhostPlan(), { runner: "local" }));

  it("have a server's job graph and inputs", () => {
    const on = (flow: string) => (parse(flow) as { on: Record<string, unknown> }).on;
    const server = on(content(serverPlan())).workflow_dispatch;
    for (const flow of [portainer, local]) {
      expect(on(flow).workflow_dispatch).toEqual(server);
      expect(Object.keys(jobsOf(flow))).toEqual([
        "paused",
        "build",
        "verify",
        "deploy",
        "prune",
        "label",
      ]);
      expect(ran(flow, PUSH)).toEqual(["build", "deploy", "label", "prune"]);
      expect(ran(flow, BY_HAND)).toEqual(["build", "deploy", "label", "prune"]);
      expect(ran(flow, PUSH_PAUSED)).toEqual(["build", "paused"]);
      expect(ran(flow, ROLLBACK_PAUSED)).toEqual(["deploy", "label", "verify"]);
    }
    const promoted = content(
      inEnvironment(portainerTestPlan({ redeploy: "updater" }), { deploySource: PROMOTE }),
    );
    expect(ran(promoted, PROMOTION_PAUSED)).toEqual(["paused", "verify"]);
    expect(ran(promoted, ROLLBACK_PAUSED)).toEqual(["deploy", "label", "verify"]);
  });

  it("give Portainer's write step the mode and the image of the job that ran", () => {
    const write = jobsOf(portainer).deploy?.steps.find((s) => s.id === "write");
    const at = (run: Run) => ({
      IMAGE: simulate(portainer, run).value("deploy", write?.env?.IMAGE ?? ""),
      MODE: simulate(portainer, run).value("deploy", write?.env?.MODE ?? ""),
    });
    expect(at(PUSH)).toEqual({ IMAGE: "build's image", MODE: "deploy" });
    expect(at(ROLLBACK)).toEqual({ IMAGE: "verify's image", MODE: "rollback" });
  });
});

describe("the sites", () => {
  const workers = renderWorkflow(cloudflarePlan(), ctx).content;
  const promotedWorkers = templates.renderCloudflareWorkersWorkflow(
    ssrPlan({ promotedFrom: "staging" }),
    { builderBranch: "main", builderWorkflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
  ).content;
  const pages = renderWorkflow(pagesPlan(), ctx).content;
  // The sites' test app is example-app.
  const SITE_PAUSED = `contains(vars.OPSCREW_DEPLOY_PAUSED, '"example-app/prod"')`;
  const pushPaused: Run = { inputs: {}, paused: pausedFor("example-app/prod") };

  it("take no inputs by hand when they follow their branch", () => {
    for (const flow of [workers, pages]) {
      expect((parse(flow) as { on: Record<string, unknown> }).on.workflow_dispatch).toEqual({});
      expect(flow).not.toContain("inputs.rollback");
    }
  });

  it("skip Cloudflare's deploy while paused", () => {
    expect(jobsOf(workers).deploy?.if).toBe(`\${{ !${SITE_PAUSED} }}`);
    expect(jobsOf(workers).paused?.if).toBe(`\${{ ${SITE_PAUSED} }}`);
    expect(ran(workers, PUSH)).toEqual(["build", "deploy"]);
    expect(ran(workers, pushPaused)).toEqual(["build", "paused"]);
    expect(ran(workers, PUSH_PAUSED)).toEqual(["build", "deploy"]);
    const dispatch: Run = { inputs: { run: "4242", sha256: "e".repeat(64) } };
    expect(ran(promotedWorkers, dispatch)).toEqual(["deploy"]);
    expect(ran(promotedWorkers, { ...dispatch, paused: pushPaused.paused })).toEqual(["paused"]);
  });

  it("skip GitHub Pages' deploy while paused, except in a re-run (S4)", () => {
    expect(jobsOf(pages).deploy?.if).toBe(`\${{ github.run_attempt > 1 || !${SITE_PAUSED} }}`);
    expect(jobsOf(pages).paused?.if).toBe(`\${{ !(github.run_attempt > 1) && ${SITE_PAUSED} }}`);
    expect(ran(pages, PUSH)).toEqual(["build", "deploy"]);
    expect(ran(pages, pushPaused)).toEqual(["build", "paused"]);
    expect(ran(pages, { ...pushPaused, attempt: "2" })).toEqual(["build", "deploy"]);
    expect(ran(pages, { ...PUSH, attempt: "2" })).toEqual(["build", "deploy"]);
  });
});

describe("the paused job", { timeout: 30_000 }, () => {
  const prod = content(serverPlan());
  const job = (text: string) => jobsOf(text).paused as JobDoc;

  it("holds no permission and no secret, and reads the variable through its environment", () => {
    const flows = [
      [prod, "shop/prod"],
      [content(portainerTestPlan()), "shop/prod"],
      [renderWorkflow(cloudflarePlan(), ctx).content, "example-app/prod"],
      [renderWorkflow(pagesPlan(), ctx).content, "example-app/prod"],
    ] as const;
    for (const [flow, key] of flows) {
      const paused = job(flow);
      expect(paused.permissions).toEqual({});
      expect(paused["runs-on"]).toBe("ubuntu-latest");
      expect(paused.steps).toHaveLength(1);
      expect(paused.steps[0]?.env).toEqual({
        KEY: key,
        PAUSED: "${{ vars.OPSCREW_DEPLOY_PAUSED }}",
      });
      expect(paused.steps[0]?.run).not.toContain("${{");
      expect(JSON.stringify(paused)).not.toContain("secrets.");
    }
    expect(prod).toContain("    permissions: {}\n");
  });

  it("names the environment's key as the check does", () => {
    const api = ofApp(inEnvironment(serverPlan(), { name: "staging" }), "api");
    expect(job(content(api)).steps[0]?.env?.KEY).toBe("api/staging");
    expect(jobsOf(content(api)).deploy?.if).toContain(`'"api/staging"'`);
  });

  const work = mkdtempSync(join(tmpdir(), "opscrew-paused-")).replaceAll("\\", "/");
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const FILTER = ".[$key][$field] // empty";
  // jq stands in for the runner's, which this computer may not have: the step's one filter in
  // Node.js (the real jq's is checked below, where it is installed).
  const jqFake = [
    "jq() {",
    `  [[ "$#" -eq 8 && "$1 $2 $3 $5 $6" == "-r --arg key --arg field" && "$8" == '${FILTER}' ]] || { echo "unexpected jq $*" >&2; return 1; }`,
    `  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const v = JSON.parse(s)?.[process.argv[1]]?.[process.argv[2]]; if (v !== undefined && v !== null && v !== false) console.log(String(v)); });' "$4" "$7"`,
    "}",
  ].join("\n");

  function say(flow: string, paused: string, fakes: string) {
    const step = job(flow).steps[0];
    writeFileSync(join(work, "summary"), "");
    const result = spawnSync("bash", ["-c", `${fakes}\n${step?.run ?? ""}`], {
      env: {
        ...process.env,
        ...step?.env,
        PAUSED: paused,
        GITHUB_SHA: "f".repeat(40),
        GITHUB_STEP_SUMMARY: `${work}/summary`,
      },
      encoding: "utf8",
    });
    return {
      status: result.status,
      out: `${result.stdout}${result.stderr}`,
      summary: readFileSync(join(work, "summary"), "utf8").trim(),
    };
  }

  const bash = (() => {
    try {
      return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
    } catch {
      return false;
    }
  })();
  const jq = (() => {
    try {
      return spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
    } catch {
      return false;
    }
  })();
  if (!bash) console.warn("[iac-templates] skipping the paused job's script: bash is missing");
  if (!jq) console.warn("[iac-templates] checking the paused job's jq filter with a fake: no jq");

  const ROLLED_BACK = `Deploys of shop/prod are paused since ${SINCE}: \`opscrew rollback\` pinned it to ccccccc (sha256:bbbbbbbbbbbb).`;

  it.skipIf(!bash)("says why a rollback's pin skips the deploy, and how to resume", () => {
    const result = say(prod, pausedFor("shop/prod"), jqFake);
    expect(result.status, result.out).toBe(0);
    const text = `${ROLLED_BACK} This run built fffffff but didn't deploy it. \`opscrew rollback --resume --deploy\` deploys the branch's latest commit.`;
    expect(result.out.trim()).toBe(`::notice::${text}`);
    expect(result.summary).toBe(text);
    // Only the short commit and digest: never the commit rolled back from.
    expect(result.out).not.toContain(FROM.slice(0, 7));
  });

  it.skipIf(!bash)("names a further app's flags, and promotion for a promoted environment", () => {
    const staging = ofApp(inEnvironment(serverPlan(), { name: "staging" }), "api");
    const entry = pausedFor("api/staging");
    expect(say(content(staging), entry, jqFake).summary).toContain(
      "`opscrew rollback --app api --env staging --resume --deploy` deploys the branch's latest commit.",
    );
    const promoted = content(inEnvironment(serverPlan(), { deploySource: PROMOTE }));
    expect(say(promoted, pausedFor("shop/prod"), jqFake).summary).toBe(
      `${ROLLED_BACK} This run didn't deploy. \`opscrew rollback --resume\` resumes them; then \`opscrew promote --to prod\` deploys.`,
    );
  });

  it.skipIf(!bash)(
    "shows a site's pinned version whole: a Worker version id, a Pages run id",
    () => {
      for (const image of ["cccccccc-3333-4333-8333-333333333333", "12345678901"]) {
        const entry = JSON.stringify({
          "shop/prod": { reason: "rollback", since: SINCE, image, commit: COMMIT },
        });
        expect(say(prod, entry, jqFake).summary).toContain(
          `\`opscrew rollback\` pinned it to ${COMMIT.slice(0, 7)} (${image}).`,
        );
      }
    },
  );

  it.skipIf(!bash)("says why a move's window skips the deploy", () => {
    const move = JSON.stringify({ "shop/prod": { reason: "move", since: SINCE } });
    const result = say(prod, move, jqFake);
    expect(result.status, result.out).toBe(0);
    expect(result.summary).toBe(
      `Deploys of shop/prod are paused since ${SINCE} while a service moves between the app's servers; \`opscrew provision\` resumes them.`,
    );
  });

  it.skipIf(!bash)("says why a credential rotation's window skips the deploy", () => {
    const rotation = JSON.stringify({
      "shop/prod": { reason: "rotation", since: SINCE, hash: "a".repeat(64) },
    });
    const result = say(prod, rotation, jqFake);
    expect(result.status, result.out).toBe(0);
    expect(result.summary).toBe(
      `Deploys of shop/prod are paused since ${SINCE} for a credential rotation's window: \`opscrew rotate\` with its services, or with \`--undo\`, ends it.`,
    );
    const staging = ofApp(inEnvironment(serverPlan(), { name: "staging" }), "api");
    const entry = JSON.stringify({
      "api/staging": { reason: "rotation", since: SINCE, hash: "a".repeat(64) },
    });
    expect(say(content(staging), entry, jqFake).summary).toContain(
      "`opscrew rotate --app api --env staging` with its services",
    );
  });

  it.skipIf(!bash || !jq)("reads the entry with the real jq too", () => {
    const result = say(prod, pausedFor("shop/prod"), "");
    expect(result.status, result.out).toBe(0);
    expect(result.summary.startsWith(ROLLED_BACK)).toBe(true);
  });
});

describe("the package root", () => {
  it("exports the pause variable, the rollback inputs and Portainer's release placeholder", () => {
    expect(templates.DEPLOY_PAUSED_VARIABLE).toBe("OPSCREW_DEPLOY_PAUSED");
    expect(templates.ROLLBACK_INPUTS.rollback).toBe("rollback");
    expect(templates.PORTAINER_RELEASE_PLACEHOLDER).toBe("__OPSCREW_RELEASE__");
  });
});
