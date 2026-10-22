import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import { deploySecretNames } from "../provision/secrets";
import { ensureStatePassphrase, stateFile } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeServers,
  fakeCloudflare,
  HOST_KEY,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

type Secrets = "environment" | "prefixed";

/** A deployed app's plan in `name` (prod without one) with its secrets kept as `secrets` says. */
function deployedIn(name: string | undefined, secrets: Secrets): DeployPlan {
  const plan = testPlan({ deployed: true, userSecret: false, postgres: false });
  const suffix = name === undefined ? "" : `-${name}`;
  return DeployPlanSchema.parse({
    ...plan,
    environment: { ...(name === undefined ? {} : { name }), secrets },
    app: { ...plan.app, name: `${plan.app.name}${suffix}` },
    infra: { ...plan.infra, dir: `opscrew/infra/${name ?? "prod"}` },
    cicd: { ...plan.cicd, workflowPath: `.github/workflows/opscrew-deploy${suffix}.yml` },
    deployment: { ...plan.deployment, lastPlanHash: "a".repeat(64) },
  });
}

/** Where `plan`'s secrets live in the fake: names by GitHub environment (`""`: the repository). */
function storeSecrets(github: FakeDestroyGitHub, plan: DeployPlan, value: string): void {
  const environment =
    plan.environment?.secrets === "environment"
      ? (plan.environment.name ?? "production")
      : undefined;
  for (const name of deploySecretNames(plan)) {
    if (
      environment === undefined ||
      name.endsWith("_BUILD_ENV") ||
      name.endsWith("_BUILD_SECRETS")
    ) {
      github.secrets.set(name, value);
    } else {
      const secrets = github.environments.get(environment) ?? new Map<string, string>();
      secrets.set(name, value);
      github.environments.set(environment, secrets);
    }
  }
}

/** A secret of the user's own in their `production` environment, which OpsCrew never touches. */
const USER_SECRET = "USER_DEPLOY_TOKEN";

/**
 * An app with prod and staging, both deployed and with their secrets stored, and the deps of the
 * environment `destroy` to tear down. `created`: OpsCrew created the GitHub environment of the
 * environment torn down (its record says so); otherwise the user made it, with a secret of their
 * own in it. `answer` decides each approval request (all approved by default).
 */
async function twoEnvironments(
  destroy: "prod" | "staging",
  secrets: Secrets,
  created = true,
  answer: (request: ApprovalRequest) => boolean = () => true,
) {
  const prod = deployedIn(undefined, secrets);
  const staging = deployedIn("staging", secrets);
  const project = await createProject(prod);
  const github = new FakeDestroyGitHub();
  storeSecrets(github, prod, "stored");
  storeSecrets(github, staging, "stored");
  const env = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: fakeSecret("hcloud-token"),
    CLOUDFLARE_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };
  const handler = new ScriptedApprovalHandler(answer);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    ...(destroy === "staging" ? { environment: "staging" } : {}),
  });
  await writeArtifact("plan", environmentPaths(deps.paths, "staging").files.plan, staging);
  const plan = destroy === "staging" ? staging : prod;
  const own = secrets === "environment" ? (plan.environment?.name ?? "production") : undefined;
  if (own !== undefined && !created) github.environments.get(own)?.set(USER_SECRET, "theirs");
  await mkdir(dirname(deps.paths.files.deploySecrets), { recursive: true });
  await writeFile(
    deps.paths.files.deploySecrets,
    `${JSON.stringify({
      host: SERVER_IPV4,
      repo: "acme/shop",
      names: deploySecretNames(plan),
      ...(own !== undefined ? { environment: own } : {}),
      ...(own !== undefined && created ? { createdEnvironment: true } : {}),
    })}\n`,
  );
  await ensureStatePassphrase(deps.paths);
  await mkdir(dirname(stateFile(deps.paths)), { recursive: true });
  await writeFile(stateFile(deps.paths), '{"version":4,"resources":[]}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  const services: DestroyServices = {
    engine: async () => new ScriptedDestroyEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers(),
    cloudflare: fakeCloudflare(),
    github,
    sleep: async () => undefined,
  };
  return { deps, handler, github, services, prod, staging };
}

/** The fake's secrets, by GitHub environment (`""`: the repository's). */
function secretsOf(github: FakeDestroyGitHub): Record<string, string[]> {
  return Object.fromEntries([
    ["", [...github.secrets.keys()].sort()],
    ...[...github.environments].map(([env, s]) => [env, [...s.keys()].sort()]),
  ]);
}

const BUILD = ["OPSCREW_BUILD_ENV", "OPSCREW_BUILD_SECRETS"];
const STAGING_BUILD = ["OPSCREW_STAGING_BUILD_ENV", "OPSCREW_STAGING_BUILD_SECRETS"];

describe.skipIf(!findExecutable("git"))("destroy per environment", () => {
  it("deletes the GitHub environment OpsCrew created for staging, and keeps prod's", async () => {
    const s = await twoEnvironments("staging", "environment");
    const before = secretsOf(s.github);
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });

    const after = secretsOf(s.github);
    expect(after.staging).toBeUndefined();
    expect(after.production).toEqual(before.production);
    expect(after[""]).toEqual(BUILD);
    // Repository secrets are deleted one by one: only the build values live there.
    expect(s.github.deleted.sort()).toEqual(STAGING_BUILD);
    expect(result.secretsRemoved.sort()).toEqual(deploySecretNames(s.staging).sort());
    // One approval, the one the typed server name confirms in a script: no settings change.
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-settings");
    const secrets = s.handler.requests.filter((r) => r.kind === "github-secrets");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.title).toBe(
      "Remove the deploy secrets from acme/shop, with the GitHub environment staging OpsCrew created",
    );
    expect(secrets[0]?.details).toBe(
      [
        "GitHub Actions secrets to delete (names only):",
        ...STAGING_BUILD.map((name) => `  ${name}`),
        "The GitHub environment staging, which OpsCrew created, to delete with the deploy secrets it holds (names only):",
        ...(before.staging ?? []).map((name) => `  ${name}`),
        "Without them the deploy workflow cannot reach a server; `opscrew provision` stores new ones.",
      ].join("\n"),
    );
    const text = s.deps.reporter.text();
    expect(text).toContain("Removed 2 deploy secrets from GitHub Actions in acme/shop.");
    expect(text).toContain(
      `Deleted the GitHub environment staging of acme/shop, with its ${before.staging?.length} deploy secrets.`,
    );
    expect(
      s.deps.audit.entries.filter((e) => e.kind === "provider-call").map((e) => e.action),
    ).toContain("delete environment staging");
    expect(text).toContain(".github/workflows/opscrew-deploy-staging.yml");
  });

  it("deletes the created environment when only the deploy secrets' approval is granted", async () => {
    // A script with --confirm and no --yes: the typed name grants the deploy secrets, and no
    // GitHub settings change.
    const s = await twoEnvironments("staging", "environment", true, (r) => {
      return r.kind !== "github-settings";
    });
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });

    expect(s.github.environments.has("staging")).toBe(false);
    expect(result.secretsRemoved.sort()).toEqual(deploySecretNames(s.staging).sort());
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-settings");
  });

  it("says why GitHub did not delete the environment, and how to finish", async () => {
    const s = await twoEnvironments("staging", "environment");
    const token = fakeSecret("github-token");
    s.deps.redactor.addLiteral(token);
    s.github.deleteEnvironment = async () => {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `GitHub refused to delete the environment staging (Must have admin rights ${token}).`,
        { hint: "The token needs Administration: Read and write." },
      );
    };
    const error = await runDestroy(s.deps, { services: s.services, snapshot: false }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(OpsCrewError);
    const failure = error as OpsCrewError;
    expect(failure.code).toBe("CREDENTIALS_INVALID");
    expect(failure.message).toContain(
      "and the deploy secrets outside it are removed, but deleting the GitHub environment staging failed: GitHub refused to delete the environment staging (Must have admin rights ",
    );
    expect(failure.message).not.toContain(token);
    expect(failure.hint).toBe(
      "The token needs Administration: Read and write. Then run `opscrew destroy` again to finish the cleanup.",
    );
    expect(s.github.environments.has("staging")).toBe(true);
  });

  it("keeps the user's own production environment: deletes only OpsCrew's secrets in it", async () => {
    const s = await twoEnvironments("prod", "environment", false);
    const before = secretsOf(s.github);
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });

    const after = secretsOf(s.github);
    expect(after.production).toEqual([USER_SECRET]);
    expect(after.staging).toEqual(before.staging);
    expect(after[""]).toEqual(STAGING_BUILD);
    expect(result.secretsRemoved.sort()).toEqual(deploySecretNames(s.prod).sort());
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-settings");
    const secrets = s.handler.requests.find((r) => r.kind === "github-secrets");
    expect(secrets?.details).toContain(
      "Secrets to delete from the GitHub environment production, which stays as you set it up (names only):\n  OPSCREW_APP_ENV\n",
    );
    expect(
      s.deps.audit.entries.filter((e) => e.kind === "secret-set").map((e) => e.action),
    ).toContain("delete secret OPSCREW_HOST in the environment production");
    expect(s.deps.reporter.text()).toContain(
      `Removed ${result.secretsRemoved.length} deploy secrets from GitHub Actions in acme/shop.`,
    );
  });

  it("deletes the production environment OpsCrew created, and keeps staging's", async () => {
    const s = await twoEnvironments("prod", "environment");
    const before = secretsOf(s.github);
    await runDestroy(s.deps, { services: s.services, snapshot: false });

    const after = secretsOf(s.github);
    expect(after.production).toBeUndefined();
    expect(after.staging).toEqual(before.staging);
    expect(after[""]).toEqual(STAGING_BUILD);
  });

  it("removes only staging's prefixed repository secrets, with no settings change", async () => {
    const s = await twoEnvironments("staging", "prefixed");
    const prodNames = deploySecretNames(s.prod);
    await runDestroy(s.deps, { services: s.services, snapshot: false });

    expect([...s.github.secrets.keys()].sort()).toEqual([...prodNames].sort());
    expect(s.github.deleted.sort()).toEqual(deploySecretNames(s.staging).sort());
    for (const name of s.github.deleted) expect(name).toMatch(/^OPSCREW_STAGING_/);
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-settings");
  });

  it("names the GitHub environment under what remains when GitHub cannot be reached", async () => {
    const s = await twoEnvironments("staging", "environment");
    const result = await runDestroy(s.deps, {
      services: { ...s.services, github: null },
      snapshot: false,
    });
    expect(result.remaining.join("\n")).toContain(
      ", and those in the GitHub environment staging in the repository's Settings → Environments.",
    );
    expect(result.remaining.join("\n")).toContain("OPSCREW_STAGING_HOST");
    expect(s.github.environments.has("staging")).toBe(true);
  });
});
