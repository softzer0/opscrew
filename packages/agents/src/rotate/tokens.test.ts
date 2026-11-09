// Feature 025 (T2512): the user's own tokens, their expiry or first-seen date, and replacing one.
import { readFile } from "node:fs/promises";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest, CommandResult, FetchLike } from "@opscrew/contracts";
import { exists } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { InitServices } from "../init";
import type { RunProvisionOptions } from "../provision/run";
import {
  createTestPhaseDeps,
  FakeGitHub,
  portainerPlan,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { readCredentialsRecord } from "./record";
import { tokenDatesFile, tokenFirstSeen, tokenSeenAt } from "./record-tokens";
import { type ReplaceTokenOptions, replaceToken, tokenExpiries } from "./tokens";

const HETZNER = fakeSecret("hcloud-token", "rotate-tokens");
const DIGITALOCEAN = fakeSecret("digitalocean-token", "rotate-tokens");
const CLOUDFLARE = fakeSecret("cloudflare-token", "rotate-main");
const DEPLOY = fakeSecret("cloudflare-token", "rotate-deploy");
const GITHUB = fakeSecret("github-token", "rotate-user");
const GHCR = fakeSecret("github-token", "rotate-ghcr");
const NTFY = fakeSecret("generic-password", "rotate-ntfy");
const VALUES = [HETZNER, DIGITALOCEAN, CLOUDFLARE, DEPLOY, GITHUB, GHCR, NTFY];

/** Each Cloudflare token's expiry as Cloudflare's verify answer gives it (none for the others). */
const CLOUDFLARE_EXPIRY: Record<string, string> = { [CLOUDFLARE]: "2027-01-31T00:00:00Z" };
/** Each GitHub token's expiry header. */
const GITHUB_EXPIRY: Record<string, string> = {
  [GITHUB]: "2026-12-01 00:00:00 UTC",
  [GHCR]: "2027-02-01 09:30:00 UTC",
};

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** A git checkout of github.com/acme/shop. */
function repoRunner(): ScriptedRunner {
  return new ScriptedRunner((command, args) => {
    if (args.includes("rev-parse")) return ok("true\n");
    if (args.includes("remote")) return ok("git@github.com:acme/shop.git\n");
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Hetzner, Cloudflare and GitHub as they answer each token; `rejected` tokens are refused. */
function net(rejected: readonly string[] = []): FetchLike {
  const zone = new FakeZone();
  return async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^(Bearer|token) /, "");
    const refused = token === undefined || rejected.includes(token);
    if (url.hostname === "api.hetzner.cloud") {
      return refused || token !== HETZNER
        ? json(401, { error: { code: "unauthorized", message: "unable to authenticate" } })
        : json(200, { locations: [{ id: 1, name: "fsn1", country: "DE" }] });
    }
    if (url.hostname === "api.cloudflare.com") {
      if (refused) {
        return json(401, {
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        });
      }
      if (url.pathname.endsWith("/user/tokens/verify")) {
        const expiry = CLOUDFLARE_EXPIRY[token];
        return json(200, {
          success: true,
          errors: [],
          result: { id: "t1", status: "active", ...(expiry ? { expires_on: expiry } : {}) },
        });
      }
      if (url.pathname === "/client/v4/accounts") {
        return json(200, { success: true, errors: [], result: [] });
      }
      if (url.pathname === "/client/v4/zones") {
        const zones =
          url.searchParams.get("name") === "example.com"
            ? [
                {
                  id: FAKE_ZONE_ID,
                  name: "example.com",
                  status: "active",
                  name_servers: [],
                  account: { id: FAKE_ACCOUNT_ID },
                },
              ]
            : [];
        return json(200, { success: true, errors: [], result: zones });
      }
      return zone.fetch(input, init);
    }
    if (url.hostname === "api.github.com") {
      if (refused) return json(401, { message: "Bad credentials" });
      if (url.pathname === "/user") {
        const expiry = GITHUB_EXPIRY[token];
        return json(
          200,
          { login: "acme" },
          expiry ? { "github-authentication-token-expiration": expiry } : {},
        );
      }
      if (url.pathname === "/repos/acme/shop") {
        return json(200, {
          default_branch: "main",
          private: true,
          permissions: { push: true },
          owner: { login: "acme", type: "User" },
        });
      }
    }
    return json(404, { message: `unexpected ${url}` });
  };
}

/** `init` finds git (the repository and its GitHub origin), nothing else. */
const INIT: InitServices = {
  which: (name) => (name === "git" ? "/usr/bin/git" : undefined),
  nodeVersion: "22.12.0",
  timeoutMs: 5000,
};

/** Deps for `plan` with `env` set (OpsCrew's home stays in the test's folder). */
async function setup(
  plan: DeployPlan,
  env: Record<string, string>,
  o: {
    rejected?: string[];
    approve?: boolean;
    /** Another environment of the project in `root`. */
    root?: string;
    environment?: string;
    /** The clock's time (default the test deps' fixed one). */
    at?: string;
  } = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({
    runner: repoRunner(),
    fetch: net(o.rejected),
    approvalHandler: new ScriptedApprovalHandler(() => o.approve ?? true),
    ...(o.root === undefined ? {} : { root: o.root }),
    ...(o.environment === undefined ? {} : { environment: o.environment }),
    ...(o.at === undefined ? {} : { clock: { now: () => new Date(o.at as string) } }),
  });
  Object.assign(deps.env, env);
  await writeArtifact("plan", deps.paths.files.plan, plan);
  return deps;
}

/** No token value in anything the run showed, audited, asked or returned. */
function expectNoValue(deps: TestPhaseDeps, ...more: unknown[]): void {
  const requests = (deps.approvalHandler as ScriptedApprovalHandler).requests;
  const text = [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(requests),
    JSON.stringify(more, (_key, value) =>
      value instanceof Error ? { ...value, message: value.message } : value,
    ),
  ].join("\n");
  for (const value of VALUES) expect(text).not.toContain(value);
}

async function failure(
  promise: Promise<unknown>,
): Promise<Error & { code?: string; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string; hint?: string };
  }
  throw new Error("expected a failure");
}

function checkedPlan(base: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    observability: { check: { enabled: true, webhook: "ntfy" } },
  });
}

/** What a fake provision run was asked, and what it returned. */
function fakeProvision() {
  const calls: RunProvisionOptions[] = [];
  const provision: ReplaceTokenOptions["provision"] = async (options) => {
    calls.push(options);
    return { applied: true, outputs: {} };
  };
  return { calls, provision };
}

describe("tokenExpiries", () => {
  it("gives Cloudflare's and GitHub's expiry, and the date this computer first saw a Hetzner token", async () => {
    const plan = testPlan({ domain: "shop.example.com", deployed: true });
    const deps = await setup(plan, {
      HCLOUD_TOKEN: HETZNER,
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      GITHUB_TOKEN: GITHUB,
    });
    const seen = await tokenFirstSeen(
      { ...deps, clock: { now: () => new Date("2026-03-01T08:00:00.000Z") } },
      "hetzner",
      HETZNER,
    );
    const list = await tokenExpiries(deps, plan);
    expect(list).toEqual([
      { name: "hetzner", variable: "HCLOUD_TOKEN", firstSeen: seen },
      { name: "cloudflare", variable: "CLOUDFLARE_API_TOKEN", expiresAt: "2027-01-31T00:00:00Z" },
      { name: "github", variable: "GITHUB_TOKEN", expiresAt: "2026-12-01T00:00:00Z" },
    ]);
    // Read-only: a token not seen before is not recorded here.
    expect(await tokenSeenAt(deps, "cloudflare", CLOUDFLARE)).toBeUndefined();
    expectNoValue(deps, list);
  });

  it("reads the deploy token's and the GHCR token's expiry with those tokens, the ntfy token's first-seen date", async () => {
    const site = await setup(sitePlan(), {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    });
    const siteList = await tokenExpiries(site, sitePlan());
    // Cloudflare gives the deploy token no expiry: it has none set.
    expect(siteList.find((token) => token.name === "cloudflare-deploy")).toEqual({
      name: "cloudflare-deploy",
      variable: "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
    });

    const plan = checkedPlan(portainerPlan());
    const deps = await setup(plan, {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      GITHUB_TOKEN: GITHUB,
      OPSCREW_GHCR_READ_TOKEN: GHCR,
      OPSCREW_CHECK_NTFY_TOKEN: NTFY,
    });
    const seen = await tokenFirstSeen(deps, "ntfy", NTFY);
    const list = await tokenExpiries(deps, plan);
    expect(list.find((token) => token.name === "ghcr")).toEqual({
      name: "ghcr",
      variable: "OPSCREW_GHCR_READ_TOKEN",
      expiresAt: "2027-02-01T09:30:00Z",
    });
    expect(list.find((token) => token.name === "ntfy")).toEqual({
      name: "ntfy",
      variable: "OPSCREW_CHECK_NTFY_TOKEN",
      firstSeen: seen,
    });
    const refused = await setup(
      sitePlan(),
      { CLOUDFLARE_API_TOKEN: CLOUDFLARE, OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY },
      { rejected: [DEPLOY] },
    );
    const refusedList = await tokenExpiries(refused, sitePlan());
    expect(refusedList.find((token) => token.name === "cloudflare-deploy")?.notRead).toBe(
      "The Cloudflare deploy token in OPSCREW_CLOUDFLARE_DEPLOY_TOKEN could not be verified (Cloudflare refused it or did not answer).",
    );
    expectNoValue(refused, refusedList);
    expectNoValue(site, siteList);
    expectNoValue(deps, list);
  });

  it("says why an expiry was not read, never with the token", async () => {
    const plan = testPlan({ domain: "shop.example.com" });
    const deps = await setup(
      plan,
      { HCLOUD_TOKEN: HETZNER, CLOUDFLARE_API_TOKEN: CLOUDFLARE, GITHUB_TOKEN: GITHUB },
      { rejected: [CLOUDFLARE, GITHUB] },
    );
    const list = await tokenExpiries(deps, plan);
    expect(list.find((token) => token.name === "cloudflare")?.notRead).toContain(
      "The Cloudflare token was rejected.",
    );
    expect(list.find((token) => token.name === "github")?.notRead).toMatch(/GitHub/);
    expectNoValue(deps, list);

    const unset = await setup(plan, {});
    expect((await tokenExpiries(unset, plan)).map((token) => token.name)).toEqual([
      "hetzner",
      "cloudflare",
      "github",
    ]);
    expect((await tokenExpiries(unset, plan)).find((t) => t.name === "hetzner")).toEqual({
      name: "hetzner",
      variable: "HCLOUD_TOKEN",
      notRead: "HCLOUD_TOKEN is not set.",
    });
  });
});

describe("replaceToken", () => {
  it("checks a new Hetzner token, records the date and names the page to delete the old one", async () => {
    const plan = testPlan({ deployed: true });
    const deps = await setup(plan, { HCLOUD_TOKEN: HETZNER, GITHUB_TOKEN: GITHUB });
    const result = await replaceToken(deps, plan, "hetzner", { init: INIT });
    expect(result).toEqual({
      name: "hetzner",
      copies: [],
      deletePage:
        "the Hetzner Cloud Console (https://console.hetzner.cloud/ → your project → Security → API tokens)",
    });
    // Nothing remote changed, so nothing was asked.
    expect((deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
    expect(await tokenSeenAt(deps, "hetzner", HETZNER)).toBe(deps.clock.now().toISOString());
    expect((await readCredentialsRecord(deps)).environments.prod?.hetzner).toEqual({
      rotatedAt: deps.clock.now().toISOString(),
      generation: 2,
    });
    expect(deps.reporter.text()).toContain(
      "Delete the old Hetzner Cloud token in the Hetzner Cloud Console (https://console.hetzner.cloud/ → your project → Security → API tokens): OpsCrew no longer uses it.",
    );
    expectNoValue(deps, result);
  });

  it("refuses an unset token and one this computer already knows, changing nothing", async () => {
    const plan = testPlan({ deployed: true });
    const unset = await setup(plan, {});
    const missing = await failure(replaceToken(unset, plan, "hetzner", { init: INIT }));
    expect(missing).toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect(missing.message).toBe(
      "HCLOUD_TOKEN is not set, so there is no new Hetzner Cloud token to put in place. Nothing was changed.",
    );
    expect(missing.hint).toContain("set the new token in HCLOUD_TOKEN first");

    const deps = await setup(plan, { HCLOUD_TOKEN: HETZNER });
    await tokenFirstSeen(deps, "hetzner", HETZNER);
    const same = await failure(replaceToken(deps, plan, "hetzner", { init: INIT }));
    expect(same).toMatchObject({ code: "INVALID_INPUT" });
    expect(same.message).toBe(
      "HCLOUD_TOKEN holds the Hetzner Cloud token OpsCrew already knows, not a new one. Nothing was changed.",
    );
    expect(same.hint).toContain("set the new token in HCLOUD_TOKEN first");
    expect(await exists(deps.paths.files.plan)).toBe(true);
    expect((await readCredentialsRecord(deps)).environments).toEqual({});
    expectNoValue(deps, same, missing);
  });

  it("refuses a token the environment does not use", async () => {
    const plan = testPlan();
    const deps = await setup(plan, { DIGITALOCEAN_TOKEN: DIGITALOCEAN });
    const error = await failure(replaceToken(deps, plan, "digitalocean", { init: INIT }));
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.message).toBe(
      "The prod environment does not use a DigitalOcean token, so there is none to replace. Nothing was changed.",
    );
  });

  it("refuses a new token that fails init's check, naming what it lacks, and records nothing", async () => {
    const plan = testPlan({ deployed: true });
    const deps = await setup(plan, { HCLOUD_TOKEN: HETZNER }, { rejected: [HETZNER] });
    const error = await failure(replaceToken(deps, plan, "hetzner", { init: INIT }));
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(error.message).toMatch(
      /^The new Hetzner Cloud token in HCLOUD_TOKEN does not pass OpsCrew's check: HCLOUD_TOKEN does not work: .+ Nothing was changed\.$/,
    );
    expect(error.hint).toContain("Read & Write API token");
    expect(await exists(tokenDatesFile(deps.paths))).toBe(false);
    expect((await readCredentialsRecord(deps)).environments).toEqual({});
    expectNoValue(deps, error);
  });

  it("checks a new GitHub token's push access as init does", async () => {
    const plan = testPlan({ deployed: true });
    const deps = await setup(plan, { GITHUB_TOKEN: GITHUB });
    const result = await replaceToken(deps, plan, "github", { init: INIT });
    expect(result.copies).toEqual([]);
    expect(result.deletePage).toContain("https://github.com/settings/personal-access-tokens");

    const refused = await setup(plan, { GITHUB_TOKEN: GITHUB }, { rejected: [GITHUB] });
    const error = await failure(replaceToken(refused, plan, "github", { init: INIT }));
    expect(error.message).toMatch(
      /^The new GitHub token in GITHUB_TOKEN does not pass OpsCrew's check: The GitHub token from GITHUB_TOKEN cannot read acme\/shop/,
    );
    expectNoValue(refused, error);
  });

  it("replaces the Workers deploy token's GitHub secret after an approval bound to the plan's hash", async () => {
    const plan = sitePlan();
    const deps = await setup(plan, {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    });
    const github = new FakeGitHub();
    const result = await replaceToken(deps, plan, "cloudflare-deploy", { init: INIT, github });
    expect(result.copies).toEqual([
      { kind: "github-secret", name: "OPSCREW_CLOUDFLARE_API_TOKEN" },
    ]);
    expect(github.secrets.get("OPSCREW_CLOUDFLARE_API_TOKEN")).toBe(DEPLOY);
    const [request] = (deps.approvalHandler as ScriptedApprovalHandler).requests as [
      ApprovalRequest,
    ];
    expect(request).toMatchObject({
      kind: "github-secrets",
      title: "Replace the Cloudflare deploy token in 1 GitHub secret of acme/shop",
    });
    expect(request.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(request.details).toContain("  OPSCREW_CLOUDFLARE_API_TOKEN (a repository secret)");
    expect(request.details).toContain(`Hash: ${request.planHash}`);
    expect(deps.audit.entries.map((entry) => entry.action)).toContain(
      "set secret OPSCREW_CLOUDFLARE_API_TOKEN",
    );
    expect(deps.reporter.text()).toContain(
      "Delete the old Cloudflare deploy token at https://dash.cloudflare.com/profile/api-tokens once every other environment with a copy of it has the new one too (`opscrew rotate cloudflare-deploy --env <name>`).",
    );
    expect(await tokenSeenAt(deps, "cloudflare-deploy", DEPLOY)).toBeDefined();
    expectNoValue(deps, result);
  });

  it("puts the token another environment got into this one's copy, then knows it here too", async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    };
    const prod = await setup(sitePlan(), env);
    const github = new FakeGitHub();
    await replaceToken(prod, sitePlan(), "cloudflare-deploy", { init: INIT, github });
    const staging = await createTestPhaseDeps({
      root: prod.paths.root,
      environment: "staging",
      runner: repoRunner(),
      fetch: net(),
    });
    Object.assign(staging.env, env);
    const plan = sitePlan({ environment: "staging" });
    await writeArtifact("plan", staging.paths.files.plan, plan);
    const result = await replaceToken(staging, plan, "cloudflare-deploy", { init: INIT, github });
    expect(result.copies).toEqual([
      { kind: "github-secret", name: "OPSCREW_STAGING_CLOUDFLARE_API_TOKEN" },
    ]);
    expect(github.secrets.get("OPSCREW_STAGING_CLOUDFLARE_API_TOKEN")).toBe(DEPLOY);
    const again = await failure(
      replaceToken(staging, plan, "cloudflare-deploy", { init: INIT, github }),
    );
    expect(again).toMatchObject({ code: "INVALID_INPUT" });
    expectNoValue(staging, result, again);
  });

  it("knows a token here that was first seen before another environment's rotation", async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    };
    const prod = await setup(sitePlan(), env);
    // This computer saw staging's token in March, before prod got a new one of its own.
    await tokenFirstSeen(
      { paths: prod.paths, clock: { now: () => new Date("2026-03-01T08:00:00.000Z") } },
      "cloudflare-deploy",
      DEPLOY,
    );
    const other = fakeSecret("cloudflare-token", "rotate-deploy-prod");
    Object.assign(prod.env, { OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: other });
    await replaceToken(prod, sitePlan(), "cloudflare-deploy", {
      init: INIT,
      github: new FakeGitHub(),
    });
    const plan = sitePlan({ environment: "staging" });
    const staging = await setup(plan, env, { root: prod.paths.root, environment: "staging" });
    const error = await failure(
      replaceToken(staging, plan, "cloudflare-deploy", { init: INIT, github: new FakeGitHub() }),
    );
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("knows a token another environment rotated away from", async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    };
    const first = await setup(sitePlan(), env, { at: "2026-09-01T10:00:00.000Z" });
    const github = new FakeGitHub();
    await replaceToken(first, sitePlan(), "cloudflare-deploy", { init: INIT, github });
    // Prod moves on from that token (T1) to another (T2) a month later.
    const later = await setup(
      sitePlan(),
      { ...env, OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: fakeSecret("cloudflare-token", "rotate-t2") },
      { root: first.paths.root, at: "2026-10-01T10:00:00.000Z" },
    );
    await replaceToken(later, sitePlan(), "cloudflare-deploy", { init: INIT, github });
    const plan = sitePlan({ environment: "staging" });
    const staging = await setup(plan, env, { root: first.paths.root, environment: "staging" });
    const error = await failure(
      replaceToken(staging, plan, "cloudflare-deploy", { init: INIT, github }),
    );
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("replaces a copy in the environment's GitHub environment, bound to that environment", async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    };
    const inEnvironment = (plan: DeployPlan) =>
      DeployPlanSchema.parse({
        ...plan,
        environment: { ...plan.environment, secrets: "environment" },
      });
    const plan = inEnvironment(sitePlan());
    const deps = await setup(plan, env);
    const github = new FakeGitHub();
    github.environments.set("production", new Map());
    github.environments.set("staging", new Map());
    const result = await replaceToken(deps, plan, "cloudflare-deploy", { init: INIT, github });
    expect(result.copies).toEqual([
      { kind: "github-secret", name: "OPSCREW_CLOUDFLARE_API_TOKEN", environment: "production" },
    ]);
    expect(github.environments.get("production")?.get("OPSCREW_CLOUDFLARE_API_TOKEN")).toBe(DEPLOY);
    expect(github.secrets.size).toBe(0);
    const [request] = (deps.approvalHandler as ScriptedApprovalHandler).requests as [
      ApprovalRequest,
    ];
    expect(request.details).toContain(
      "  OPSCREW_CLOUDFLARE_API_TOKEN (in the GitHub environment production)",
    );
    expect(deps.audit.entries.map((entry) => entry.action)).toContain(
      "set secret OPSCREW_CLOUDFLARE_API_TOKEN in the environment production",
    );

    const stagingPlan = inEnvironment(sitePlan({ environment: "staging" }));
    const staging = await setup(stagingPlan, env, {
      root: deps.paths.root,
      environment: "staging",
    });
    const copied = await replaceToken(staging, stagingPlan, "cloudflare-deploy", {
      init: INIT,
      github,
    });
    expect(copied.copies).toEqual([
      {
        kind: "github-secret",
        name: "OPSCREW_STAGING_CLOUDFLARE_API_TOKEN",
        environment: "staging",
      },
    ]);
    const [second] = (staging.approvalHandler as ScriptedApprovalHandler).requests as [
      ApprovalRequest,
    ];
    expect(second.planHash).not.toBe(request.planHash);
    expectNoValue(deps, result);
    expectNoValue(staging, copied);
  });

  it("binds the hash to the new token and changes nothing when the approval is refused", async () => {
    const plan = sitePlan();
    const env = {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    };
    const deps = await setup(plan, env, { approve: false });
    const github = new FakeGitHub();
    const error = await failure(
      replaceToken(deps, plan, "cloudflare-deploy", { init: INIT, github }),
    );
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(error.message).toBe(
      "The replacement of the Cloudflare deploy token was not approved. Nothing was changed.",
    );
    const [request] = (deps.approvalHandler as ScriptedApprovalHandler).requests as [
      ApprovalRequest,
    ];
    expect(error.hint).toBe(
      `Run \`opscrew rotate cloudflare-deploy\` again when you are ready (in a script: --approve ${request.planHash}).`,
    );
    expect(github.secrets.size).toBe(0);
    expect(await tokenSeenAt(deps, "cloudflare-deploy", DEPLOY)).toBeUndefined();
    expect((await readCredentialsRecord(deps)).environments).toEqual({});

    // Another new token is another plan.
    const other = fakeSecret("cloudflare-token", "rotate-deploy-2");
    const again = await setup(plan, { ...env, OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: other });
    await replaceToken(again, plan, "cloudflare-deploy", { init: INIT, github: new FakeGitHub() });
    const [second] = (again.approvalHandler as ScriptedApprovalHandler).requests as [
      ApprovalRequest,
    ];
    expect(second.planHash).not.toBe(request.planHash);
    expectNoValue(deps, error);
  });

  it("replaces the scheduled check's ntfy token, a repository secret every environment reads", async () => {
    const plan = checkedPlan(testPlan({ deployed: true }));
    const deps = await setup(plan, { OPSCREW_CHECK_NTFY_TOKEN: NTFY, GITHUB_TOKEN: GITHUB });
    const github = new FakeGitHub();
    const result = await replaceToken(deps, plan, "ntfy", { init: INIT, github });
    expect(result.copies).toEqual([{ kind: "github-secret", name: "OPSCREW_CHECK_NTFY_TOKEN" }]);
    expect(github.secrets.get("OPSCREW_CHECK_NTFY_TOKEN")).toBe(NTFY);
    expect(result.deletePage).toContain("ntfy");
    expectNoValue(deps, result);
  });

  it("replaces Portainer's registry entry through provision's stack plan", async () => {
    const plan = portainerPlan();
    const deps = await setup(plan, { OPSCREW_GHCR_READ_TOKEN: GHCR, GITHUB_TOKEN: GITHUB });
    const { calls, provision } = fakeProvision();
    const result = await replaceToken(deps, plan, "ghcr", { init: INIT, provision });
    expect(result.copies).toEqual([{ kind: "portainer-registry" }]);
    expect(calls).toEqual([{ replaceTokens: { registry: true }, push: false, secrets: false }]);
    // Portainer's own stack plan is approved by its hash; nothing else is asked here.
    expect((deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
    expect(deps.reporter.text()).toContain("Portainer's registry entry for ghcr.io");
    expect(result.deletePage).toBe("https://github.com/settings/tokens");
    expect(await tokenSeenAt(deps, "ghcr", GHCR)).toBeDefined();
    expectNoValue(deps, result, calls);
  });

  it("keeps the date unrecorded when a copy fails, so the run can be repeated", async () => {
    const plan = portainerPlan();
    const deps = await setup(plan, { OPSCREW_GHCR_READ_TOKEN: GHCR, GITHUB_TOKEN: GITHUB });
    const error = await failure(
      replaceToken(deps, plan, "ghcr", {
        init: INIT,
        provision: async () => {
          throw new Error("Portainer did not answer");
        },
      }),
    );
    expect(error.message).toBe("Portainer did not answer");
    expect(await tokenSeenAt(deps, "ghcr", GHCR)).toBeUndefined();
    expect(await readFile(deps.paths.files.plan, "utf8")).toContain("portainer");
  });
});
