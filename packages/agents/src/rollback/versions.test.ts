import type { WorkflowRunSource } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, serializeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import { environmentPaths } from "../environments";
import { ghcrReadCredential } from "../localhost/image";
import { inEnvironment } from "../promote/__fixtures__/world";
import { testPlan } from "../testing";
import { at, type Built, type VersionsWorld, versionsWorld } from "./__fixtures__/versions";
import type { Version, VersionList, VersionsContext } from "./types";
import { checkOldPlan, chooseVersion, describeImage, listVersions, versionText } from "./versions";

const COMMAND = "opscrew rollback --env prod";

/** Prod, deployed from main on each push. */
const prodPlan = (): DeployPlan => testPlan({ domain: "shop.example.com", deployed: true });

/** The context of `environment` (default prod) in `world`, read with `credential` when given. */
async function contextOf(
  world: VersionsWorld,
  plan: DeployPlan,
  environment = "prod",
): Promise<VersionsContext> {
  const { deps, github } = world;
  const credential = ghcrReadCredential(deps, "acme");
  return {
    image: {
      github,
      owner: "acme",
      repo: "shop",
      ...(credential !== undefined ? { credential } : {}),
    },
    plan,
    paths: environmentPaths(deps.paths, environment),
  };
}

/** Prod with the builds a, b, c (minutes 1–3), running c, its previous b. */
async function prodWorld(env?: Record<string, string>) {
  const world = await versionsWorld(env !== undefined ? { env } : {});
  const plan = prodPlan();
  await world.writePlan("prod", plan);
  const a = world.deploy("a", 1);
  const b = world.deploy("b", 2);
  const c = world.deploy("c", 3);
  world.label("prod", c);
  world.label("prod", b, true);
  return { world, plan, a, b, c, ctx: await contextOf(world, plan) };
}

const digests = (list: VersionList) => list.versions.map((version) => version.digest);
const marked = (list: VersionList, digest: string) =>
  list.versions.find((version) => version.digest === digest)?.marks;

/** The refusal `run` throws. */
function refusal(run: () => unknown): OpsCrewError {
  try {
    run();
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("listVersions", () => {
  it("lists prod's images newest first, with their commit, message, time and marks", async () => {
    const { world, a, b, c, ctx } = await prodWorld();
    // The tags were read with describeTags's one pull token.
    world.github.taggedDigest = async () => {
      throw new Error("a second pull token");
    };
    const list = await listVersions(world.deps, ctx);
    expect(digests(list)).toEqual([c.digest, b.digest, a.digest]);
    expect(list.versions[1]).toEqual({
      digest: b.digest,
      image: `ghcr.io/acme/shop@${b.digest}`,
      tag: b.commit,
      commit: b.commit,
      message: "b",
      builtAt: at(2),
      runUrl: `https://github.com/acme/shop/actions/runs/${b.runId}/attempts/1`,
      buildSucceeded: true,
      marks: ["previous"],
    });
    expect(marked(list, c.digest)).toEqual(["running"]);
    expect(marked(list, a.digest)).toEqual([]);
    expect(list.running).toBe(c.digest);
    expect(list.previous).toBe(b.digest);
    expect(list.leftOut).toEqual([]);
    // One read of the deploy workflow's runs on its branch, and one of GHCR's tag list.
    expect(world.github.runLists).toEqual([
      { workflowFile: "opscrew-deploy.yml", branch: "main", perPage: 100 },
    ]);
    expect(world.github.described).toEqual([
      [c.commit, b.commit, a.commit, "opscrew-prod", "opscrew-prod-previous"],
    ]);
  });

  it("lists at most 20 versions, the newest", async () => {
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const built = Array.from({ length: 25 }, (_, i) => world.deploy(`v${i}`, i));
    world.label("prod", built[24] as Built);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    expect(digests(list)).toEqual(
      built
        .slice(5)
        .reverse()
        .map((one) => one.digest),
    );
  });

  it("lists the running version and the ones before it after more than 20 paused pushes", async () => {
    const { world, a, b, c, ctx } = await prodWorld();
    const paused = Array.from({ length: 25 }, (_, i) => world.deploy(`paused${i}`, 10 + i));
    const list = await listVersions(world.deps, ctx);
    expect(digests(list)).toEqual([
      ...paused
        .slice(5)
        .map((one) => one.digest)
        .reverse(),
      c.digest,
      b.digest,
      a.digest,
    ]);
    // One more read of GHCR, for the window from the running image's build run down.
    expect(world.github.described).toHaveLength(2);
    expect(chooseVersion(list, { environment: "prod", command: COMMAND }).target.digest).toBe(
      b.digest,
    );
    const to = { environment: "prod", to: a.commit.slice(0, 7), command: COMMAND };
    expect(chooseVersion(list, to).target.digest).toBe(a.digest);
  });

  it("orders by run, which may share a second with another", async () => {
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const first = world.deploy("first", 1);
    const second = world.deploy("second", 1);
    world.label("prod", second);
    world.label("prod", first, true);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    expect(digests(list)).toEqual([second.digest, first.digest]);
    expect(chooseVersion(list, { environment: "prod", command: COMMAND }).target.digest).toBe(
      first.digest,
    );
  });

  it("orders by the build run, and lists a commit once", async () => {
    const { world, b, c, ctx } = await prodWorld();
    // A later run of c's commit started by hand, whose build failed before pushing: the tag stays
    // the push's image, built at minute 3.
    world.github.runs.set(900, {
      ...(world.github.runs.get(c.runId) as WorkflowRunSource),
      event: "workflow_dispatch",
      createdAt: at(30),
      conclusion: "failure",
    });
    const list = await listVersions(world.deps, ctx);
    expect(list.versions.slice(0, 2).map((version) => [version.digest, version.builtAt])).toEqual([
      [c.digest, at(3)],
      [b.digest, at(2)],
    ]);
  });

  it("lists a failed build's image, and a build run started by hand (D1)", async () => {
    const { world, ctx } = await prodWorld();
    const failed = world.deploy("deploy-failed", 4, { run: { conclusion: "failure" } });
    const byHand = world.deploy("by-hand", 5, { run: { event: "workflow_dispatch" } });
    // A build that failed before it pushed an image: no tag, so nothing to list.
    const unpushed = world.deploy("unpushed", 6, { run: { conclusion: "failure" } });
    world.github.tags.delete(unpushed.commit);
    const list = await listVersions(world.deps, ctx);
    expect(digests(list).slice(0, 2)).toEqual([byHand.digest, failed.digest]);
    expect(list.versions[1]?.buildSucceeded).toBe(false);
    expect(list.leftOut).toEqual([]);
  });

  it("leaves out an image for another CPU, or built elsewhere, saying why", async () => {
    const { world, ctx } = await prodWorld();
    const arm = world.deploy("arm", 4, { platforms: [{ architecture: "arm64", os: "linux" }] });
    const foreign = world.deploy("foreign", 5);
    world.github.provenance.set(foreign.digest, {
      builderId: "https://github.com/other/fork/actions/runs/9/attempts/1",
      runId: 9,
      repository: "other/fork",
    });
    const list = await listVersions(world.deps, ctx);
    expect(digests(list)).not.toContain(arm.digest);
    expect(list.leftOut).toEqual([
      {
        commit: foreign.commit,
        digest: foreign.digest,
        reason: expect.stringContaining("a run of other/fork, not of acme/shop."),
      },
      {
        commit: arm.commit,
        digest: arm.digest,
        reason: expect.stringContaining("is built for arm64 only, but prod runs on amd64"),
      },
    ]);
    for (const left of list.leftOut) expect(left.reason).not.toContain("Nothing was deployed");
  });

  it("leaves out an image GHCR no longer has", async () => {
    const { world, a, ctx } = await prodWorld();
    world.github.lost.add(a.digest);
    const list = await listVersions(world.deps, ctx);
    expect(list.leftOut).toEqual([
      {
        commit: a.commit,
        digest: a.digest,
        reason: "GitHub Container Registry no longer has the image.",
      },
    ]);
  });

  it("lists staging from its own branch, with its commit tags", async () => {
    const world = await versionsWorld({ environment: "staging" });
    const staging = inEnvironment(prodPlan(), "staging");
    const plan = { ...staging, cicd: { ...staging.cicd, branch: "staging" } };
    await world.writePlan("prod", prodPlan());
    await world.writePlan("staging", plan);
    const run = { headBranch: "staging" };
    const one = world.deploy("one", 1, { environment: "staging", run });
    const two = world.deploy("two", 2, { environment: "staging", run });
    // Prod's build of the same commit is another image, of another workflow.
    world.deploy("two", 3);
    world.label("staging", two);
    world.label("staging", one, true);
    const list = await listVersions(world.deps, await contextOf(world, plan, "staging"));
    expect(list.versions.map((version) => [version.tag, version.marks])).toEqual([
      [`${two.commit}-staging`, ["running"]],
      [`${one.commit}-staging`, ["previous"]],
    ]);
    expect(world.github.runLists).toEqual([
      { workflowFile: "opscrew-deploy-staging.yml", branch: "staging", perPage: 100 },
    ]);
  });

  it("lists a promoted environment's images in its builder's form, marked by its own labels", async () => {
    const world = await versionsWorld();
    const base = prodPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    await world.writePlan("prod", plan);
    await world.writePlan("staging", inEnvironment(base, "staging"));
    const one = world.deploy("one", 1, { environment: "staging" });
    const two = world.deploy("two", 2, { environment: "staging" });
    const three = world.deploy("three", 3, { environment: "staging" });
    world.label("staging", three);
    world.label("prod", two);
    world.label("prod", one, true);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    expect(list.versions.map((version) => [version.tag, version.marks])).toEqual([
      [`${three.commit}-staging`, []],
      [`${two.commit}-staging`, ["running"]],
      [`${one.commit}-staging`, ["previous"]],
    ]);
    expect(world.github.runLists[0]?.workflowFile).toBe("opscrew-deploy-staging.yml");
  });

  it("reads GHCR with OPSCREW_GHCR_READ_TOKEN, and never shows it", async () => {
    const token = fakeSecret("github-token", "ghcr-read");
    const { world, ctx } = await prodWorld({ OPSCREW_GHCR_READ_TOKEN: token });
    const list = await listVersions(world.deps, ctx);
    expect(world.github.credentials.length).toBeGreaterThan(0);
    for (const credential of world.github.credentials) {
      expect(credential).toEqual({ username: "acme", token });
    }
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("stops with the connector's hint when GHCR refuses the token's tag list", async () => {
    const { world, ctx } = await prodWorld();
    world.github.denied = true;
    const error = await listVersions(world.deps, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("CREDENTIALS_INVALID");
    expect((error as OpsCrewError).hint).toContain("OPSCREW_GHCR_READ_TOKEN");
  });

  it("redacts a secret in a commit message", async () => {
    const secret = fakeSecret("github-token", "in-a-message");
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const built = world.deploy("leaky", 1, {
      run: { headCommit: { message: `fix: rotate ${secret}\n\nmore`, timestamp: at(1) } },
    });
    world.label("prod", built);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    expect(list.versions[0]?.message).toMatch(/^fix: rotate /);
    expect(JSON.stringify(list)).not.toContain(secret);
  });
});

describe("the default version (D4)", () => {
  it("is the previous deployment after a forward deploy", async () => {
    const { world, b, c, ctx } = await prodWorld();
    const list = await listVersions(world.deps, ctx);
    const chosen = chooseVersion(list, { environment: "prod", command: COMMAND });
    expect(chosen.target.digest).toBe(b.digest);
    expect(chosen.running?.digest).toBe(c.digest);
  });

  it("after a rollback, is the newest successful build before the running one", async () => {
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const a = world.deploy("a", 1);
    world.deploy("x", 2, { run: { conclusion: "failure" } });
    const b = world.deploy("b", 3);
    const c = world.deploy("c", 4);
    // Rolled back from c to b: the workflow labelled b, and c as the one before it.
    world.label("prod", b);
    world.label("prod", c, true);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    expect(marked(list, a.digest)).toEqual(["previous"]);
    expect(chooseVersion(list, { environment: "prod", command: COMMAND }).target.digest).toBe(
      a.digest,
    );
  });

  it("refuses when the previous version's image is gone, naming the versions there", async () => {
    const { world, a, b, c, ctx } = await prodWorld();
    // b's commit tag is gone, so the previous label names an image that isn't listed.
    world.github.tags.delete(b.commit);
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      `the version it ran before (${b.digest.slice(0, 19)}) is not among its versions.`,
    );
    const there = [c, a].map((one) => list.versions.find((v) => v.digest === one.digest));
    expect(error.message).toContain(
      `The newest 2 versions there: ${there.map((v) => versionText(v as Version)).join("; ")}.`,
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("--to");
  });

  it("refuses when the previous version was left out, with its reason", async () => {
    const { world, b, ctx } = await prodWorld();
    world.github.platforms.set(b.digest, [{ architecture: "arm64", os: "linux" }]);
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.message).toContain(
      `the version it ran before (${b.digest.slice(0, 19)}) can't be deployed:`,
    );
    expect(error.message).toContain("is built for arm64 only");
  });

  it("refuses without the previous label, even with older builds", async () => {
    const { world, ctx } = await prodWorld();
    world.github.tags.delete("opscrew-prod-previous");
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.message).toContain("it has run only one version");
    expect(error.message).toContain("no image labelled opscrew-prod-previous");
    expect(error.hint).toBe(
      `Name a version with --to: \`${COMMAND} --list\` shows the versions there. Or deploy a fix forward.`,
    );
  });

  it("refuses for a promoted environment after its first promotion", async () => {
    const world = await versionsWorld();
    const base = prodPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    await world.writePlan("prod", plan);
    await world.writePlan("staging", inEnvironment(base, "staging"));
    world.deploy("one", 1, { environment: "staging" });
    const two = world.deploy("two", 2, { environment: "staging" });
    world.label("staging", two);
    world.label("prod", two);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.message).toContain("it has run only one version");
    expect(error.hint).toContain("--to");
  });

  it("refuses when only one version exists", async () => {
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const only = world.deploy("only", 1);
    world.label("prod", only);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      `it has run only one version, ${versionText(list.versions[0] as Version)}`,
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toBe("Deploy a fix forward instead.");
  });

  it("refuses without the opscrew-<env> label", async () => {
    const { world, ctx } = await prodWorld();
    world.github.tags.delete("opscrew-prod");
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.message).toContain("no image labelled opscrew-prod");
    expect(error.message).toContain("Nothing was changed.");
  });

  it("refuses when the running image is not listed, pointing to --to", async () => {
    const { world, c, ctx } = await prodWorld();
    world.github.platforms.set(c.digest, [{ architecture: "arm64", os: "linux" }]);
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => chooseVersion(list, { environment: "prod", command: COMMAND }));
    expect(error.message).toContain(`the image it runs (${c.digest.slice(0, 19)})`);
    expect(error.hint).toContain("--to");
  });
});

describe("--to", () => {
  const choose = (list: VersionList, to: string) =>
    chooseVersion(list, { environment: "prod", to, command: COMMAND });

  it("takes a commit prefix, a digest or a digest prefix", async () => {
    const { world, a, ctx } = await prodWorld();
    const list = await listVersions(world.deps, ctx);
    expect(choose(list, a.commit.slice(0, 7)).target.digest).toBe(a.digest);
    expect(choose(list, a.commit.toUpperCase()).target.digest).toBe(a.digest);
    expect(choose(list, a.digest).target.digest).toBe(a.digest);
    expect(choose(list, a.digest.slice(0, 19)).target.digest).toBe(a.digest);
  });

  it("refuses what is neither a commit nor a digest", async () => {
    const { world, ctx } = await prodWorld();
    const list = await listVersions(world.deps, ctx);
    for (const to of ["main", "abc12", "sha256:0123456789a"]) {
      const error = refusal(() => choose(list, to));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/Nothing was changed\.$/);
    }
  });

  it("refuses the running version", async () => {
    const { world, c, ctx } = await prodWorld();
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => choose(list, c.commit.slice(0, 8)));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("runs");
    expect(error.message).toContain("already");
  });

  it("refuses a version not listed, naming the newest five and the oldest", async () => {
    const world = await versionsWorld();
    const plan = prodPlan();
    await world.writePlan("prod", plan);
    const built = Array.from({ length: 8 }, (_, i) => world.deploy(`v${i}`, i));
    world.label("prod", built[7] as Built);
    // Retention deleted the oldest.
    world.github.tags.delete((built[0] as Built).commit);
    const list = await listVersions(world.deps, await contextOf(world, plan));
    const error = refusal(() => choose(list, (built[0] as Built).commit.slice(0, 10)));
    expect(error.code).toBe("PHASE_PRECONDITION");
    const [newest, oldest] = [list.versions[0] as Version, list.versions.at(-1) as Version];
    expect(error.message).toContain(`The newest 5 versions there: ${versionText(newest)};`);
    expect(error.message).toContain(`The oldest still there: ${versionText(oldest)}.`);
    expect(error.message).not.toContain(versionText(list.versions[5] as Version));
    expect(error.hint).toContain(`${COMMAND} --list`);
  });

  it("refuses a version left out, with its reason", async () => {
    const { world, ctx } = await prodWorld();
    const arm = world.deploy("arm", 4, { platforms: [{ architecture: "arm64", os: "linux" }] });
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => choose(list, arm.digest.slice(0, 20)));
    expect(error.message).toContain("is built for arm64 only");
    expect(error.message).toMatch(/Nothing was changed\.$/);
  });

  it("refuses a prefix of more than one version", async () => {
    const { world, ctx } = await prodWorld();
    // Two commits that share their first seven digits.
    world.deploy("one", 4, { commit: `abcdef1${"1".repeat(33)}` });
    const two = world.deploy("two", 5, { commit: `abcdef1${"2".repeat(33)}` });
    const list = await listVersions(world.deps, ctx);
    const error = refusal(() => choose(list, "abcdef1"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("names 2 versions of prod");
    expect(choose(list, "abcdef12").target.digest).toBe(two.digest);
  });
});

describe("checkOldPlan", () => {
  const PLAN_FILE = "opscrew/plan.yaml";

  async function oldPlanWorld(old: DeployPlan | string | undefined) {
    const { world, plan, a, ctx } = await prodWorld();
    if (old !== undefined) {
      world.github.files.set(
        `${a.commit}:${PLAN_FILE}`,
        typeof old === "string" ? old : serializeArtifact("plan", old),
      );
    }
    const list = await listVersions(world.deps, ctx);
    const target = list.versions.find((version) => version.digest === a.digest) as Version;
    return { plan, ctx, target };
  }

  it("refuses when a service that version ran with is gone", async () => {
    const plan = prodPlan();
    const old = { ...plan, services: selfHostedServices({ postgres: true, redis: true }) };
    const { ctx, target } = await oldPlanWorld(old);
    const error = await checkOldPlan(ctx, target, COMMAND).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      `${target.commit.slice(0, 7)} ran with the service cache, which prod's plan no longer has`,
    );
    expect((error as OpsCrewError).message).toMatch(/Nothing was changed\.$/);
  });

  it("lists the workers, cron jobs and variables added since", async () => {
    const plan = prodPlan();
    const old = DeployPlanSchema.parse({
      ...plan,
      app: {
        ...plan.app,
        env: plan.app.env.filter((variable) => variable.name !== "STRIPE_SECRET_KEY"),
      },
    });
    const { ctx, target } = await oldPlanWorld(old);
    const today = DeployPlanSchema.parse({
      ...plan,
      processes: {
        workers: [{ name: "mailer", command: "node mailer.js", source: "user" }],
        cron: [{ name: "cleanup", schedule: "@daily", command: "node cleanup.js" }],
      },
    });
    const short = target.commit.slice(0, 7);
    expect(await checkOldPlan({ ...ctx, plan: today }, target, COMMAND)).toEqual({
      unchecked: false,
      added: [
        `Workers added since ${short}, which run with the earlier image too: mailer.`,
        `Cron jobs added since ${short}, which run with the earlier image too: cleanup.`,
        `Variables added since ${short}, which the earlier image gets too: STRIPE_SECRET_KEY.`,
      ],
    });
    expect(await checkOldPlan(ctx, target, COMMAND)).toEqual({
      unchecked: false,
      added: [
        `Variables added since ${short}, which the earlier image gets too: STRIPE_SECRET_KEY.`,
      ],
    });
  });

  it("is not checked when the old plan is missing or unreadable", async () => {
    for (const old of [undefined, "schemaVersion: 1\napp: {}\n", "{ not yaml"]) {
      const { ctx, target } = await oldPlanWorld(old);
      expect(await checkOldPlan(ctx, target, COMMAND)).toEqual({ unchecked: true, added: [] });
    }
  });
});

describe("describeImage", () => {
  it("names the commit, message, time and run of an image", async () => {
    const { world, b, ctx } = await prodWorld();
    expect(await describeImage(world.deps, ctx.image, b.digest)).toEqual({
      commit: b.commit,
      message: "b",
      builtAt: at(2),
      runUrl: `https://github.com/acme/shop/actions/runs/${b.runId}/attempts/1`,
    });
  });

  it("is undefined for an image GHCR doesn't have, or one built elsewhere", async () => {
    const { world, b, ctx } = await prodWorld();
    expect(await describeImage(world.deps, ctx.image, `sha256:${"0".repeat(64)}`)).toBeUndefined();
    world.github.provenance.set(b.digest, {
      builderId: `https://github.com/other/fork/actions/runs/${b.runId}/attempts/1`,
      runId: b.runId,
      repository: "other/fork",
    });
    expect(await describeImage(world.deps, ctx.image, b.digest)).toBeUndefined();
  });

  it("redacts a secret in the commit message", async () => {
    const secret = fakeSecret("github-token", "described");
    const { world, b, ctx } = await prodWorld();
    const run = world.github.runs.get(b.runId);
    if (run === undefined) throw new Error("no run");
    world.github.runs.set(b.runId, {
      ...run,
      headCommit: { message: `oops ${secret}`, timestamp: at(2) },
    });
    const described = await describeImage(world.deps, ctx.image, b.digest);
    expect(described?.message).toMatch(/^oops /);
    expect(JSON.stringify(described)).not.toContain(secret);
  });
});
