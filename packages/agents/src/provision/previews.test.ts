import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
  previewKeyLine,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { findExecutable, sha256Hex, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import { recordOwnServer } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  fakeCloudflare,
  fakeSharedCloudflare,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  opscrewRecord,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  previewTestPlan,
  projectRunner,
  publicOutputs,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  type TestPhaseDeps,
  testPlan,
  withOtherApp,
  writeArchitecture,
  writeFakeState,
} from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { previewDeploymentFiles } from "./render";
import { runProvision } from "./run";
import { placeDeploySecrets } from "./secrets";
import type { ProvisionServices } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
/** Prod's own value, which must never reach a preview. */
const PROD_STRIPE = fakeSecret("stripe-live-key", "prod");
/** The previews' test key, from `.env.preview`. */
const PREVIEW_STRIPE = fakeSecret("stripe-live-key", "preview");
const BASE = "shop.example.com";
const PREVIEW_WORKFLOW = ".github/workflows/opscrew-preview.yml";
const RECIPE = "opscrew/environments/preview/previews";
const STANDING =
  "The standing approval: GitHub Actions will create, update and delete previews of same-repository pull requests within these bounds without asking again; each preview's data is deleted when it ends.";
const NO_BRANCH_RULES =
  "GitHub enforces no branch rules on the environments of acme/shop (GitHub Free has none in private repositories), so any workflow, a pull request's included, can read every secret of the repository.";

/** `prod` as the preview environment's plan, as `env add preview --previews` designs it. */
function previewOf(prod: DeployPlan, cap = 3): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    app: { ...prod.app, name: "shop-preview" },
    environment: {
      name: "preview",
      previews: { cap, lifetimeDays: 7, domain: BASE, seed: "npm run seed" },
    },
    infra: { ...prod.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: "example.com", proxied: false, www: false },
    security: { ...prod.security, httpAllowedFrom: "any" },
    supplyChain: { ...prod.supplyChain, sign: false },
    cicd: {
      ...prod.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}

/**
 * The preview server as the host adapter reaches it: inspection reports its facts, and a previews
 * plan's apply leaves them as the adapter does (the recipe's files by their hashes, the values
 * file, the restricted key line and the cleanup's cron line).
 */
class PreviewServer {
  readonly applies: { plan: HostPlan; options: ApplyOptions }[] = [];
  facts: HostFacts = HostFactsSchema.parse({
    ...freshFacts({ user: "deploy" }),
    deployUser: { groups: ["deploy", "docker"], keys: [] },
  });
  readonly inspect = async (): Promise<HostFacts> => this.facts;
  readonly apply = async (
    _remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push({ plan, options });
    const changes = plan.steps.filter((step) => step.state === "change");
    for (const step of changes) {
      const files = Object.entries(step.params).flatMap(([name, text]) =>
        name.startsWith("file:") ? [[name.slice("file:".length), sha256Hex(String(text))]] : [],
      );
      const minute = /at minute (\d+) of every hour/.exec(step.reason ?? "")?.[1];
      const { publicKey, repository } = step.params;
      this.facts = HostFactsSchema.parse({
        ...this.facts,
        deployUser: {
          groups: ["deploy", "docker"],
          keys: [],
          previewKeys: [previewKeyLine(String(publicKey), String(repository), plan.app)],
        },
        previews: [
          {
            app: plan.app,
            files: Object.fromEntries(files),
            values: true,
            cron: [`${minute} * * * * /srv/apps/${plan.app}/bin/opscrew-preview gc`],
            numbers: [],
          },
        ],
      });
    }
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  };
}

/** `.env.*` in the project's `.gitignore`, committed: previews refuse a values file git keeps. */
async function ignoreValueFiles(
  root: string,
  git: (cwd: string, ...args: string[]) => Promise<string>,
): Promise<void> {
  await appendFile(join(root, ".gitignore"), ".env.*\n");
  await git(root, "commit", "-q", "-m", "Ignore the environments' values", "--", ".gitignore");
}

/**
 * An app provisioned in prod (its pull request merged), with the preview environment's plan and
 * `.env.preview` beside it, which git ignores; one GitHub fake and one preview server for every
 * run.
 */
async function appWithPreviews() {
  const prod = testPlan({ postgres: true });
  const project = await createProject(prod);
  const { root, git } = project;
  await writeArchitecture(join(root, "opscrew", "architecture.json"), "shop");
  await writeFile(join(root, "production.env"), `STRIPE_SECRET_KEY=${PROD_STRIPE}\n`);
  const github = new FakeGitHub();
  const server = new PreviewServer();
  const env = {
    ...process.env,
    OPSCREW_HOME: join(root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  const deps = (environment?: string, answer?: ScriptedApprovalHandler) =>
    createTestPhaseDeps({
      root,
      env,
      runner: projectRunner(),
      approvalHandler: answer ?? new ScriptedApprovalHandler(() => true),
      ...(environment === undefined ? {} : { environment }),
    });
  const services = (engine = new FakeEngine()): ProvisionServices => ({
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    cloudflare: fakeCloudflare(),
    serverHost: server,
  });
  /** The user merges the run's pull request and goes back to the updated main. */
  const merge = async () => {
    const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--no-edit", branch);
    await git(root, "push", "-q", "origin", "main");
  };
  const prodDeps = await deps();
  await runProvision(prodDeps, { services: services() });
  await merge();
  await ignoreValueFiles(root, git);
  const previewPlan = environmentPaths(prodDeps.paths, "preview").files.plan;
  await writeArtifact("plan", previewPlan, previewOf(prod));
  await writeFile(join(root, ".env.preview"), `STRIPE_SECRET_KEY=${PREVIEW_STRIPE}\n`);
  return { ...project, prod, prodDeps, deps, services, github, server, merge, previewPlan };
}

const requestsOf = (deps: TestPhaseDeps) =>
  (deps.approvalHandler as ScriptedApprovalHandler).requests;
const hostRequest = (deps: TestPhaseDeps) =>
  requestsOf(deps).find((request) => request.kind === "host-apply");

/** A line of an OpenSSH private key that only this key has (the first is every key's header). */
const keyMaterial = (privateKey: string) => privateKey.split("\n")[4] as string;

/** Every file under `dir` (relative, `/`-separated), with its text. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length + 1).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return files;
}

describe.skipIf(!findExecutable("git"))("provisioning previews (ADR 0026)", () => {
  it("refuses before any change while prod's deploy secrets are repository secrets GitHub could keep apart", async () => {
    const app = await appWithPreviews();
    const prodSecrets = new Map(app.github.secrets);
    const preview = await app.deps("preview");
    const engine = new FakeEngine();
    await expect(runProvision(preview, { services: app.services(engine) })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A pull request could read the deploy key of prod: its deploy secrets are repository secrets, which every workflow in acme/shop can read, a pull request's included. Nothing was changed.",
      hint: "Run `opscrew provision --env prod` first, which moves its secrets into a GitHub environment only its branch can use, then run `opscrew provision --env preview` again.",
    });
    // Only GitHub's capability was checked, on its throwaway environment.
    expect(requestsOf(preview).map((r) => r.kind)).toEqual(["github-settings"]);
    expect(engine.calls).toEqual([]);
    expect(app.github.environments.size).toBe(0);
    expect(app.github.secrets).toEqual(prodSecrets);
    expect(app.server.applies).toEqual([]);
    expect(existsSync(join(app.root, PREVIEW_WORKFLOW))).toBe(false);
    expect(existsSync(join(app.root, RECIPE))).toBe(false);
  });

  it("refuses, before reading it, a .env.preview git doesn't ignore", async () => {
    const app = await appWithPreviews();
    await writeFile(join(app.root, ".gitignore"), ".opscrew/\n.env\n");
    await app.git(app.root, "commit", "-q", "-m", "Keep .env.*", "--", ".gitignore");
    // Read, it would be refused for the value it lacks.
    await writeFile(join(app.root, ".env.preview"), `UNUSED=${PREVIEW_STRIPE}\n`);
    const preview = await app.deps("preview");
    const error = await runProvision(preview, { services: app.services() }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        ".env.preview holds the previews' values, and git doesn't ignore it, so a commit could take them. Nothing was changed.",
      hint: "Add .env.* to .gitignore (if .env.preview is committed already, also run `git rm --cached .env.preview`), then run `opscrew provision --env preview` again.",
    });
    expect(requestsOf(preview)).toEqual([]);
    expect(preview.reporter.text()).not.toContain(PREVIEW_STRIPE);
  });

  it("refuses before any change while .env.preview lacks a value the app needs", async () => {
    const app = await appWithPreviews();
    await writeFile(join(app.root, ".env.preview"), "# test keys only\n");
    const preview = await app.deps("preview");
    await expect(runProvision(preview, { services: app.services() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        ".env.preview has no value for STRIPE_SECRET_KEY, which the app needs, so previews could not start. Nothing was changed.",
    });
    expect(requestsOf(preview)).toEqual([]);
  });

  it("sets previews up once prod's secrets are apart: the recipe approved as a standing approval, only the preview key in GitHub, prod untouched", async () => {
    const app = await appWithPreviews();
    const { github, root, server } = app;
    // Prod's provision moves its secrets into its GitHub environment, which only main can use.
    await runProvision(await app.deps(), { services: app.services() });
    await app.merge();
    expect(github.deploymentBranches.get("production")).toEqual(["main"]);
    // No Dependabot entry for the preview environment, which has no runtime folder.
    const dependabot = await readFile(join(root, ".github/dependabot.yml"), "utf8");
    expect(dependabot).not.toContain("environments/preview");

    // Prod as it is before previews are set up (SC-2205).
    const prodPlan = await readFile(app.prodDeps.paths.files.plan, "utf8");
    await writeFakeState(app.prodDeps.paths);
    const prodState = await readFile(tfstateFile(app.prodDeps.paths), "utf8");
    const prodSecrets = new Map(github.secrets);
    const production = new Map(github.environments.get("production"));
    const prodWorkflow = await readFile(join(root, ".github/workflows/opscrew-deploy.yml"), "utf8");

    const preview = await app.deps("preview");
    const result = await runProvision(preview, { services: app.services() });
    expect(requestsOf(preview).map((r) => r.kind)).toEqual([
      "github-settings",
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);

    // The previews host plan: the standing approval with every bound and the values' names,
    // approved by its hash with allowDestroy and the typed <app>-<env>.
    const host = hostRequest(preview);
    expect(host).toMatchObject({ allowDestroy: true, confirmPhrase: "shop-preview" });
    expect(host?.planHash).toBe(result.previewsHostPlanHash);
    const details = host?.details ?? "";
    for (const line of [
      STANDING,
      "  At most 3 previews at once; a preview with no push for 7 days is removed.",
      `  Addresses: pr-<number>.${BASE}, DNS only, each with its own certificate and marked noindex.`,
      "  Image: only ghcr.io/acme/shop, pinned by digest.",
      "  Seed: `npm run seed`, once for each new preview (tried again at its next update until it succeeds).",
      "  Preview values from .env.preview (names only): STRIPE_SECRET_KEY.",
    ]) {
      expect(details).toContain(line);
    }
    expect(details).toMatch(/Each preview runs the app \d+ MB and db \d+ MB/);
    expect(details).toContain(
      "  Each preview's files, from template/ in /srv/apps/shop-preview: compose.yaml, edge/compose.yaml, ",
    );
    expect(details).not.toContain(NO_BRANCH_RULES);
    expect(result).toMatchObject({ applied: true, previewsApplied: true });

    // The server got the recipe, the preview key and the values, the values only at apply.
    expect(server.applies).toHaveLength(1);
    const [installed] = server.applies;
    expect(installed?.options.secrets).toEqual({
      previewValues: `STRIPE_SECRET_KEY=${PREVIEW_STRIPE}\n`,
    });
    expect(JSON.stringify(installed?.plan)).not.toContain(PREVIEW_STRIPE);
    const keyPub = (await readFile(preview.paths.files.previewKeyPub, "utf8")).trim();
    expect(installed?.plan.steps[0]?.params.publicKey).toBe(
      keyPub.split(" ").slice(0, 2).join(" "),
    );

    // The committed recipe is exactly what the server got, and holds no value.
    const recipe = await filesUnder(join(root, RECIPE));
    const params = installed?.plan.steps[0]?.params ?? {};
    expect(
      Object.fromEntries(
        Object.entries(params).flatMap(([name, text]) =>
          name.startsWith("file:") ? [[name.slice("file:".length), text]] : [],
        ),
      ),
    ).toEqual(recipe);
    expect(recipe["settings.env"]).toContain("IMAGE_NAME=ghcr.io/acme/shop\n");
    expect(recipe["template/env/app.env"]).toContain("@SECRET:db-password:hex32@");
    expect(recipe["template/env/db.env"]).toContain("POSTGRES_PASSWORD=@SECRET:db-password:hex32@");
    for (const text of Object.values(recipe)) {
      expect(text).not.toContain(PREVIEW_STRIPE);
      expect(text).not.toContain(PROD_STRIPE);
    }

    // Its root holds the server and the wildcard record in the zone; and what drift renders to
    // compare is exactly what this run wrote.
    const tfvars = await readFile(
      join(root, "opscrew/infra/preview/terraform.tfvars.json"),
      "utf8",
    );
    expect(JSON.parse(tfvars)).toMatchObject({
      preview_domain: BASE,
      cloudflare_zone_id: FAKE_ZONE_ID,
    });
    const rendered = await previewDeploymentFiles(await app.deps("preview"), {
      services: app.services(),
      createDeployKey: false,
    });
    expect(rendered).toMatchObject({ created: [], changed: [] });
    expect(rendered.unchanged).toContain(`${RECIPE}/template/env/app.env`);

    // The preview workflow, and no push-deploy workflow, runtime, check or monitoring of its own.
    expect(await readFile(join(root, PREVIEW_WORKFLOW), "utf8")).toContain("pull_request:");
    expect(existsSync(join(root, ".github/workflows/opscrew-deploy-preview.yml"))).toBe(false);
    expect(existsSync(join(root, "opscrew/environments/preview/runtime"))).toBe(false);
    expect(await readFile(join(root, ".github/dependabot.yml"), "utf8")).toBe(dependabot);

    // GitHub: the preview key, the address and the host key in the environment `preview`, which
    // has no branch rule, and the build values; no app or service env secret.
    expect([...(github.environments.get("preview")?.keys() ?? [])].sort()).toEqual([
      "OPSCREW_PREVIEW_HOST",
      "OPSCREW_PREVIEW_SSH_KNOWN_HOSTS",
      "OPSCREW_PREVIEW_SSH_PRIVATE_KEY",
    ]);
    expect(
      [...github.secrets.keys()].filter((name) => name.startsWith("OPSCREW_PREVIEW_")),
    ).toEqual(["OPSCREW_PREVIEW_BUILD_ENV", "OPSCREW_PREVIEW_BUILD_SECRETS"]);
    expect(github.deploymentBranches.has("preview")).toBe(false);
    expect(github.rules.get("preview")?.branchPolicy).toBeNull();
    const environment = github.environments.get("preview");
    expect(environment?.get("OPSCREW_PREVIEW_HOST")).toBe(SERVER_IPV4);
    const previewKey = await readFile(preview.paths.files.previewKey, "utf8");
    expect(environment?.get("OPSCREW_PREVIEW_SSH_PRIVATE_KEY")).toBe(previewKey);
    const deployKey = await readFile(preview.paths.files.deployKey, "utf8");
    const stored = [
      ...github.secrets.values(),
      ...[...github.environments.values()].flatMap((secrets) => [...secrets.values()]),
    ];
    for (const value of stored) expect(value).not.toContain(keyMaterial(deployKey));
    expect(requestsOf(preview).find((r) => r.kind === "github-secrets")?.details).toContain(
      "The SSH key is the preview key, which can run only the preview command on the preview server; the environment's deploy key stays on this computer.",
    );

    // The pull request brings the workflow and the recipe; no first deploy.
    const body = github.pulls.at(-1)?.body ?? "";
    expect(body).toContain(`\`${PREVIEW_WORKFLOW}\``);
    expect(body).toContain(`\`${RECIPE}/\``);
    expect(github.dispatches).toEqual([]);
    expect(preview.reporter.text()).toContain(
      `Once https://github.com/acme/shop/pull/7 is merged, each pull request from a branch of this repository that changes the app gets its own preview at pr-<number>.${BASE}`,
    );

    // Prod's plan, state, workflow and secrets are as they were.
    expect(await readFile(app.prodDeps.paths.files.plan, "utf8")).toBe(prodPlan);
    expect(await readFile(tfstateFile(app.prodDeps.paths), "utf8")).toBe(prodState);
    expect(await readFile(join(root, ".github/workflows/opscrew-deploy.yml"), "utf8")).toBe(
      prodWorkflow,
    );
    for (const [name, value] of prodSecrets) expect(github.secrets.get(name)).toBe(value);
    expect(github.environments.get("production")).toEqual(production);

    // No secret in what the run printed, audited, asked to approve or saved as plans.
    const shown = [
      preview.reporter.text(),
      JSON.stringify(preview.audit.entries),
      JSON.stringify(requestsOf(preview)),
      ...Object.values(await filesUnder(preview.paths.files.plansDir)),
    ].join("\n");
    for (const secret of [PREVIEW_STRIPE, PROD_STRIPE, keyMaterial(previewKey)]) {
      expect(shown).not.toContain(secret);
    }
    await app.merge();

    // Again with nothing changed: no infrastructure apply and no host change.
    const again = await app.deps("preview");
    const unchanged = new FakeEngine({ changes: [] });
    const second = await runProvision(again, { services: app.services(unchanged) });
    expect(unchanged.calls).not.toContain("apply");
    expect(server.applies).toHaveLength(1);
    expect(hostRequest(again)).toBeUndefined();
    expect(second).toMatchObject({ previewsApplied: false });
    expect(again.reporter.text()).toContain(
      "The previews' recipe on the preview server is as approved; nothing on it changes.",
    );

    // Changed values are a host plan to approve again (the values are never in it), which
    // rewrites values.env.
    const rotated = fakeSecret("stripe-live-key", "rotated");
    await writeFile(join(root, ".env.preview"), `STRIPE_SECRET_KEY=${rotated}\n`);
    const values = await app.deps("preview");
    await runProvision(values, { services: app.services(new FakeEngine({ changes: [] })) });
    expect(hostRequest(values)).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "shop-preview",
    });
    expect(server.applies).toHaveLength(2);
    expect(server.applies.at(-1)?.options.secrets).toEqual({
      previewValues: `STRIPE_SECRET_KEY=${rotated}\n`,
    });
    expect(server.applies.at(-1)?.plan.steps[0]?.params.rewrite).toBe(true);
    await app.merge();

    // So is a changed recipe: a lower cap.
    await writeArtifact("plan", app.previewPlan, previewOf(app.prod, 2));
    const recipeChange = await app.deps("preview");
    await runProvision(recipeChange, { services: app.services(new FakeEngine({ changes: [] })) });
    expect(hostRequest(recipeChange)?.details).toContain("  At most 2 previews at once;");
    expect(server.applies).toHaveLength(3);
    expect(await readFile(join(root, RECIPE, "settings.env"), "utf8")).toContain("CAP=2\n");
  });

  it("writes the workflow and the recipe in a plan-only run, asking GitHub and the server nothing", async () => {
    const app = await appWithPreviews();
    const preview = await app.deps("preview");
    const result = await runProvision(preview, { services: app.services(), planOnly: true });
    expect(requestsOf(preview).map((r) => r.kind)).toEqual(["repo-write"]);
    expect(app.github.probes).toEqual([]);
    expect(app.server.applies).toEqual([]);
    expect(result.previewsHostPlanHash).toBeUndefined();
    expect(existsSync(join(app.root, PREVIEW_WORKFLOW))).toBe(true);
    expect(existsSync(join(app.root, RECIPE, "bin/opscrew-preview"))).toBe(true);
  });

  it("refuses while a GitHub environment lets every branch deploy, or another app keeps repository secrets; a prod-only app then places them apart", async () => {
    const app = await appWithPreviews();
    const { github, root } = app;
    // Prod's provision moves its secrets into `production`, but the user declines its branch rule.
    const rules = "Set the rules of the GitHub environment";
    const declined = new ScriptedApprovalHandler((r) => !r.title.startsWith(rules));
    await runProvision(await app.deps(undefined, declined), { services: app.services() });
    await app.merge();
    expect(github.rules.get("production")?.branchPolicy).toBeNull();
    const open = await app.deps("preview");
    await expect(runProvision(open, { services: app.services() })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A pull request could read the deploy key of prod: the GitHub environment production that holds its deploy secrets lets every branch deploy, a pull request's included. Nothing was changed.",
      hint: "Run `opscrew provision --env prod` again and accept its branch rule, or let only its branch deploy to production in https://github.com/acme/shop/settings/environments; then run `opscrew provision --env preview` again.",
    });
    expect(github.environments.has("preview")).toBe(false);

    // Accepted on the next provision: only main may deploy there now.
    await runProvision(await app.deps(), { services: app.services() });
    await app.merge();
    expect(github.deploymentBranches.get("production")).toEqual(["main"]);

    // Another app of the repository, deployed with repository secrets, is refused too.
    await writeArtifact("app", join(root, "opscrew/apps/docs/app.yaml"), {
      schemaVersion: 1,
      dir: "docs",
    });
    const docsPlan = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      app: { ...testPlan().app, key: "docs", name: "docs" },
    });
    await writeArtifact("plan", join(root, "opscrew/apps/docs/plan.yaml"), docsPlan);
    const other = await app.deps("preview");
    await expect(runProvision(other, { services: app.services() })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A pull request could read the deploy key of the app docs's prod: its deploy secrets are repository secrets, which every workflow in acme/shop can read, a pull request's included. Nothing was changed.",
      hint: "Run `opscrew provision --app docs` first, which moves its secrets into a GitHub environment only its branch can use, then run `opscrew provision --app . --env preview` again.",
    });

    // That prod-only app's provision now places its secrets apart, as an app with several
    // environments does, since a pull request could read them.
    const docs = await createTestPhaseDeps({
      root,
      env: app.prodDeps.env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
      app: "docs",
    });
    const placed = await placeDeploySecrets(
      docs,
      { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      docsPlan,
      { command: "opscrew provision", phase: "provision", planOnly: false },
    );
    expect(placed).toMatchObject({ plan: { environment: { secrets: "environment" } } });
    expect(github.deploymentBranches.get("docs-production")).toEqual(["main"]);
    await writeArtifact("plan", join(root, "opscrew/apps/docs/plan.yaml"), placed.plan);

    // docs' own provisioned preview environment, whose GitHub environment serves its pull
    // requests (no branch rule); a site on Cloudflare's hosting, whose token is a repository
    // secret; and a GitHub Pages site without secrets: none of them stops these previews.
    const docsPreview = previewOf(placed.plan);
    await writeArtifact(
      "plan",
      join(root, "opscrew/apps/docs/environments/preview/plan.yaml"),
      DeployPlanSchema.parse({
        ...docsPreview,
        app: { ...docsPreview.app, name: "docs-preview" },
        environment: {
          ...docsPreview.environment,
          secrets: "environment",
          previews: { ...docsPreview.environment?.previews, domain: "docs.example.com" },
        },
      }),
    );
    github.environments.set("docs-preview", new Map([["OPSCREW_PREVIEW_HOST", "x"]]));
    for (const [key, plan] of [
      ["site", sitePlan()],
      ["pages", pagesTestPlan()],
    ] as const) {
      await writeArtifact("app", join(root, `opscrew/apps/${key}/app.yaml`), {
        schemaVersion: 1,
        dir: key,
      });
      await writeArtifact(
        "plan",
        join(root, `opscrew/apps/${key}/plan.yaml`),
        DeployPlanSchema.parse({
          ...plan,
          app: { ...plan.app, key, name: key },
          deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
        }),
      );
    }
    const allowed = await app.deps("preview");
    await runProvision(allowed, { services: app.services() });
    const details = hostRequest(allowed)?.details ?? "";
    expect(details).toContain(
      "The Cloudflare token of the app site's prod is a repository secret: any workflow, a pull request's included, can read it.",
    );
    expect(details).not.toContain("the app pages's prod");
    await app.merge();
    // Nor does its own re-provision stop.
    await runProvision(await app.deps("preview"), {
      services: app.services(new FakeEngine({ changes: [] })),
    });
  });

  it("refuses the user's own server when it holds another app, before anything is applied", async () => {
    const project = await createProject(ownPlan());
    await ignoreValueFiles(project.root, project.git);
    const env: Record<string, string | undefined> = {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
    };
    delete env.TF_VAR_server_ipv4;
    delete env.TF_VAR_server_ipv6;
    const deps = await createTestPhaseDeps({
      root: project.root,
      env,
      runner: ownRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
      environment: "preview",
    });
    await writeArtifact("plan", deps.paths.files.plan, previewTestPlan({ own: true }));
    await writeFile(join(project.root, ".env.preview"), "");
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
    });
    const host = new FakeHostServer(withOtherApp());
    const github = new FakeGitHub();
    const engine = new OwnEngine(PUBLIC_CHANGES, publicOutputs());
    const services: ProvisionServices = {
      engine: async () => engine,
      github,
      cloudflare: ownCloudflare(),
      tcpConnect: async () => true,
      sleep: async () => undefined,
      own: { host, homeDir: join(project.root, ".home") },
      sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    };
    await expect(
      runProvision(deps, { services, hostKey: ED25519_FINGERPRINT }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        'Your server holds "blog", and previews run pull requests\' code: it would run beside it, so previews need a server with nothing else on it. Nothing on it was changed.',
      hint: "Give the preview environment a server of its own, then run `opscrew provision --env preview` again.",
    });
    expect(engine.plans).toEqual([]);
    expect(host.applies).toEqual([]);
    // Before any change at GitHub: no check of its environments, no GitHub environment made.
    expect(github.probes).toEqual([]);
    expect(github.environments.has("preview")).toBe(false);
  });

  it("renders no scheduled check and no monitoring for the preview environment", async () => {
    const app = await appWithPreviews();
    const { github, root, server } = app;
    github.branchPoliciesWork = false;
    // Prod has the scheduled check on: its files are the repository's, rendered by every run.
    const prod = await readArtifact("plan", app.prodDeps.paths.files.plan);
    await writeArtifact(
      "plan",
      app.prodDeps.paths.files.plan,
      DeployPlanSchema.parse({ ...prod, observability: { check: { enabled: true } } }),
    );
    const preview = await app.deps("preview");
    await runProvision(preview, { services: app.services() });
    const listed = await readFile(join(root, "opscrew/check/check.json"), "utf8");
    expect(listed).toContain("shop/prod");
    expect(listed).not.toContain("shop/preview");
    // Only the previews' host plan, no check key or monitoring's, and no check or monitoring files.
    expect(requestsOf(preview).filter((r) => r.kind === "host-apply")).toHaveLength(1);
    expect(server.applies.map((a) => a.plan.steps.map((s) => s.id))).toEqual([["previews"]]);
    expect(existsSync(join(root, "opscrew/environments/preview/monitoring"))).toBe(false);
    // The scheduled check's key (the repository's) was not made for it.
    expect(existsSync(app.prodDeps.paths.files.checkKey)).toBe(false);
    const names = [
      ...github.secrets.keys(),
      ...[...github.environments.values()].flatMap((s) => [...s.keys()]),
    ].filter((name) => name.startsWith("OPSCREW_PREVIEW_"));
    expect(names.filter((name) => /CHECK|GRAFANA|BESZEL/.test(name))).toEqual([]);
  });

  it("says in the host plan that any workflow can read every secret where GitHub enforces no branch rules", async () => {
    const app = await appWithPreviews();
    app.github.branchPoliciesWork = false;
    const preview = await app.deps("preview");
    await runProvision(preview, { services: app.services() });
    expect(hostRequest(preview)?.details).toContain(NO_BRANCH_RULES);
    // Prod's repository secrets stay where they are.
    expect(app.github.secrets.has("OPSCREW_HOST")).toBe(true);
  });

  it("checks the wildcard record in the zone before any change", async () => {
    const app = await appWithPreviews();
    const preview = await app.deps("preview");
    const services = {
      ...app.services(),
      cloudflare: fakeCloudflare({
        records: [{ ...opscrewRecord(`*.${BASE}`, "A", "198.51.100.9"), comment: "" }],
      }),
    };
    await expect(runProvision(preview, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        `Cloudflare already has DNS records for *.${BASE} that OpsCrew did not create:`,
      ),
    });
    expect(requestsOf(preview)).toEqual([]);
    expect((await readArtifact("plan", app.previewPlan)).deployment.lastApplyAt).toBeUndefined();
  });
});
