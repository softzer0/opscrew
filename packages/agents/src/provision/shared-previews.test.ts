/**
 * Provisioning previews on another environment's server (spec.md US9, FR-2229): no server, base or
 * edge switch of their own; the wildcard points at dev's server; the recipe goes there through
 * dev's login; GitHub's machines reach it as dev's own do; nothing of dev's server is recorded in
 * the preview environment's state.
 */
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type AppRecord,
  appDirs,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { renderEdgeCompose, runtimeDir } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownProject } from "../drift/__fixtures__/own-project";
import { runDrift } from "../drift/run";
import { environmentPaths } from "../environments/paths";
import { HOST_SSH_PORT, recordHostLogin } from "../previews/__fixtures__/plan";
import { sharedServerWarning } from "../previews/host";
import { readServerAddresses } from "../shared";
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
  HOST_ADMIN,
  HOST_IPV4,
  HOST_KEY,
  hostTestPlan,
  OwnEngine,
  PREVIEW_ZONE,
  PUBLIC_CHANGES,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  sharedPreviewTestPlan,
  type TestPhaseDeps,
  testPlan,
  withLaptop,
  writeArchitecture,
  writeFakeState,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const HCLOUD = "hcloud-test-token-not-a-real-value";

/** `prod` as the plan of the environment `name`, as design writes it. */
function namedOf(prod: DeployPlan, name: string): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
  });
}

/** The record of the OpsCrew app `app` set up on a server. */
function recordOf(app: string): AppRecord {
  return {
    schemaVersion: 1,
    app,
    projectId: "other",
    state: "active",
    access: "public",
    hostnames: [],
    folders: appDirs(app),
    composeProject: app,
    services: [],
    memoryMb: 1024,
    deployKey: "",
  };
}

/**
 * dev's server as the host adapter reaches it: dev's app is there (its folders and record), and
 * the host plans' applies are kept; the shell each connection went to is kept too.
 */
class DevServer extends FakeHostServer {
  readonly hosts: string[] = [];

  constructor(own: boolean) {
    const fresh = freshFacts({ user: own ? "root" : "deploy" });
    super(
      HostFactsSchema.parse({
        ...fresh,
        deployUser: { groups: ["deploy", "docker"], keys: [] },
        apps: [{ name: "shop-dev", record: recordOf("shop-dev") }],
        dirs: [
          ...fresh.dirs,
          { path: "/srv/apps/shop-dev", kind: "dir" },
          { path: "/srv/data/shop-dev", kind: "dir" },
        ],
      }),
    );
    // Bound: a shared server's network host plan is handed `apply` as a function.
    this.apply = this.apply.bind(this);
  }

  override inspect(remote: RemoteExec): Promise<HostFacts> {
    this.hosts.push(remote.host);
    return super.inspect(remote);
  }

  override apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
    this.hosts.push(remote.host);
    return super.apply(remote, plan, options);
  }
}

/** Every file under `dir`, with its text. */
async function textsUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.filter((e) => e.isFile()).map((e) => readFile(join(e.parentPath, e.name), "utf8")),
  );
}

/**
 * An app in prod, dev provisioned on a server OpsCrew created (`own` false: provisioned here) or
 * on the user's own (its login, address, deploy key and host key recorded as dev's provision
 * leaves them), and the preview environment on dev's server with `.env.preview`, which git
 * ignores. GitHub enforces no branch rules here (GitHub Free, private).
 */
async function sharedApp(own: boolean) {
  const prod = testPlan({ userSecret: false });
  const project = await createProject(prod);
  const { root, git } = project;
  await writeArchitecture(join(root, "opscrew", "architecture.json"), "shop");
  const github = new FakeGitHub();
  github.branchPoliciesWork = false;
  const server = new DevServer(own);
  const zone = new FakeZone();
  const env = { ...process.env, OPSCREW_HOME: join(root, ".home-opscrew"), HCLOUD_TOKEN: HCLOUD };
  const deps = (environment?: string) =>
    createTestPhaseDeps({
      root,
      env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
      ...(environment === undefined ? {} : { environment }),
    });
  const services = (engine: ProvisionServices["engine"]): ProvisionServices => ({
    engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: (host) => ({ ...readyRemote(host), host }),
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
    cloudflare: fakeCloudflare(),
    serverHost: server,
  });
  const merge = async () => {
    const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--no-edit", branch);
    await git(root, "push", "-q", "origin", "main");
  };
  const prodDeps = await deps();
  await runProvision(prodDeps, { services: services(async () => new FakeEngine()) });
  await merge();
  await appendFile(join(root, ".gitignore"), ".env.*\n");
  await git(root, "commit", "-q", "-m", "Ignore the environments' values", "--", ".gitignore");
  const dev = environmentPaths(prodDeps.paths, "dev");
  if (own) {
    // dev on the user's own server, as its provision leaves this computer.
    await writeArtifact(
      "plan",
      dev.files.plan,
      DeployPlanSchema.parse({
        ...namedOf(prod, "dev"),
        target: { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" },
        deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
      }),
    );
    await recordHostLogin(dev, true);
  } else {
    await writeArtifact("plan", dev.files.plan, namedOf(prod, "dev"));
    const created = new FakeEngine({
      outputs: { server_ipv4: HOST_IPV4, server_id: "4712", server_name: "shop-dev" },
    });
    await runProvision(await deps("dev"), { services: services(async () => created) });
    await merge();
  }
  await writeArtifact(
    "plan",
    environmentPaths(prodDeps.paths, "preview").files.plan,
    // As `env add --share-server dev` designs it, not provisioned yet.
    sharedPreviewTestPlan({
      createdAt: prod.createdAt,
      updatedAt: prod.updatedAt,
      cost: prod.cost,
      deployment: undefined,
    }),
  );
  await writeFile(join(root, ".env.preview"), "");
  return { ...project, deps, services, github, server, zone, dev, merge };
}

const requestsOf = (deps: TestPhaseDeps) =>
  (deps.approvalHandler as ScriptedApprovalHandler).requests;

describe.skipIf(!findExecutable("git"))("provisioning previews on dev's server (US9)", () => {
  it.each([
    ["a server OpsCrew created", false],
    ["the user's own server", true],
  ])(
    "on %s: no server of their own, the recipe through dev's login, GitHub reaching it as dev's does",
    async (_name, own) => {
      const app = await sharedApp(own);
      const { server, github, root } = app;
      const devState = await readFile(join(app.dev.stateDir, "server.json"), "utf8");
      const devPlan = await readFile(app.dev.files.plan, "utf8");
      const preview = await app.deps("preview");
      const engine = new OwnEngine(PUBLIC_CHANGES, { url: `https://${PREVIEW_ZONE}` });
      const result = await runProvision(preview, { services: app.services(async () => engine) });
      expect(result).toMatchObject({ applied: true, previewsApplied: true });

      // The root holds only the wildcard record, to dev's address, given only as TF_VAR_*.
      expect(engine.plans[0]?.env.TF_VAR_server_ipv4).toBe(HOST_IPV4);
      const tfvars = await readFile(
        join(root, "opscrew/infra/preview/terraform.tfvars.json"),
        "utf8",
      );
      expect(tfvars).not.toContain(HOST_IPV4);

      // The recipe went to dev's server through dev's login: as deploy on a server OpsCrew created,
      // as root through the recorded admin login on the user's own; allowed beside dev's app.
      expect(server.applies).toHaveLength(1);
      const [installed] = server.applies;
      expect(installed?.plan.steps.map((step) => step.id)).toEqual(["previews"]);
      expect(installed?.plan.steps[0]?.params.runAs).toBe(own ? "root" : "login");
      expect(new Set(server.hosts)).toEqual(new Set([HOST_IPV4]));

      // Its approval names dev and repeats the warning, with allowDestroy and the typed name.
      const host = requestsOf(preview).find((r) => r.kind === "host-apply");
      expect(host).toMatchObject({ allowDestroy: true, confirmPhrase: "shop-preview" });
      expect(host?.title).toBe(
        "Let GitHub Actions run previews of acme/shop's pull requests on dev's server, within the recipe's bounds",
      );
      expect(host?.details).toContain(sharedServerWarning("dev"));
      expect(host?.details).toContain(
        "the server's web ports are open to everyone, as dev's plan sets them",
      );

      // GitHub's machines reach dev's server as dev's deploy does.
      const secrets = github.environments.get("preview");
      expect(secrets?.get("OPSCREW_PREVIEW_HOST")).toBe(HOST_IPV4);
      const pinned = own ? `[${HOST_IPV4}]:${HOST_SSH_PORT}` : HOST_IPV4;
      expect(secrets?.get("OPSCREW_PREVIEW_SSH_KNOWN_HOSTS")).toBe(`${pinned} ${HOST_KEY}\n`);
      const workflow = await readFile(join(root, ".github/workflows/opscrew-preview.yml"), "utf8");
      expect(
        workflow.includes(`-p ${HOST_SSH_PORT}`) || workflow.includes(`Port=${HOST_SSH_PORT}`),
      ).toBe(own);

      // The recipe's edge is dev's, byte for byte: dev's deploys and a preview's `up` put the same
      // /srv/edge/compose.yaml (web ports as dev's plan has them, not the previews' web filter).
      const recipeEdge = await readFile(
        join(root, "opscrew/environments/preview/previews/template/edge/compose.yaml"),
        "utf8",
      );
      const devPlanNow = await readArtifact("plan", app.dev.files.plan);
      expect(recipeEdge).toBe(renderEdgeCompose(devPlanNow).content);
      expect(recipeEdge).not.toContain("0.0.0.0:");
      if (!own) {
        // dev's own deploy files, as its provision committed them.
        const devEdge = join(root, runtimeDir(devPlanNow), "edge", "compose.yaml");
        expect(recipeEdge).toBe(await readFile(devEdge, "utf8"));
      }

      // Nothing of dev's server is recorded for the preview environment; dev's state is as it was.
      expect(await readServerAddresses(preview.paths)).toEqual({ schemaVersion: 1 });
      expect(existsSync(preview.paths.files.knownHosts)).toBe(false);
      expect(await readFile(join(app.dev.stateDir, "server.json"), "utf8")).toBe(devState);
      expect(await readFile(app.dev.files.plan, "utf8")).toBe(devPlan);

      // dev's address appears nowhere OpsCrew printed, audited, asked to approve or saved as plans.
      const shown = [
        preview.reporter.text(),
        JSON.stringify(preview.audit.entries),
        JSON.stringify(requestsOf(preview)),
        ...(await textsUnder(preview.paths.files.plansDir)),
        await readFile(preview.paths.files.plan, "utf8"),
      ].join("\n");
      expect(shown).not.toContain(HOST_IPV4);
      // Nor dev's admin login on the user's own server.
      expect(shown).not.toContain(HOST_ADMIN);
      // Nor any key: dev's deploy key stays out of the previews' secrets and every output, and the
      // previews' secrets hold the preview key only.
      const devKey = (await readFile(app.dev.files.deployKey, "utf8")).split("\n");
      const material = devKey[4] ?? devKey[0] ?? "";
      const previewKey =
        (await readFile(preview.paths.files.previewKey, "utf8")).split("\n")[4] ?? "";
      const stored = [
        ...[...github.secrets].flatMap(([name, value]) =>
          name.startsWith("OPSCREW_PREVIEW_") ? [value] : [],
        ),
        ...(secrets?.values() ?? []),
      ].join("\n");
      expect(material).not.toBe("");
      expect(stored).not.toContain(material);
      expect(shown).not.toContain(material);
      expect(shown).not.toContain(previewKey);
      expect(secrets?.get("OPSCREW_PREVIEW_SSH_PRIVATE_KEY")).toContain(previewKey);

      // Again with nothing changed: the recipe is as approved, and dev's address still not recorded.
      await app.merge();
      const again = await app.deps("preview");
      await runProvision(again, {
        services: app.services(async () => new OwnEngine([], { url: `https://${PREVIEW_ZONE}` })),
      });
      expect(await readServerAddresses(again.paths)).toEqual({ schemaVersion: 1 });
    },
  );

  it("dev's provision says to provision the previews again when its edge no longer matches their recipe's", async () => {
    const app = await sharedApp(false);
    const preview = await app.deps("preview");
    const engine = new OwnEngine(PUBLIC_CHANGES, { url: `https://${PREVIEW_ZONE}` });
    await runProvision(preview, { services: app.services(async () => engine) });
    await app.merge();
    const devEngine = async () =>
      new FakeEngine({
        outputs: { server_ipv4: HOST_IPV4, server_id: "4712", server_name: "shop-dev" },
      });
    const STALE =
      "dev's edge changes, and the previews of preview on its server still hold the old one in their recipe, which a preview's start puts back: run `opscrew provision --env preview` after this, so the previews' recipe follows.";
    // Their recipe holds dev's edge: nothing to say.
    const same = await app.deps("dev");
    await runProvision(same, { services: app.services(devEngine) });
    expect(same.reporter.text()).not.toContain(STALE);
    await app.merge();
    // The recipe from before dev's edge changed.
    const recipeEdge = join(
      app.root,
      "opscrew/environments/preview/previews/template/edge/compose.yaml",
    );
    await writeFile(recipeEdge, `${await readFile(recipeEdge, "utf8")}# an older edge\n`);
    await app.git(app.root, "commit", "-q", "-am", "An older edge in the previews' recipe");
    const changed = await app.deps("dev");
    await runProvision(changed, { services: app.services(devEngine) });
    expect(changed.reporter.text()).toContain(STALE);
  });

  it("drift plans the root with dev's address, compares the files, and leaves dev's server to dev", async () => {
    const app = await sharedApp(false);
    const preview = await app.deps("preview");
    const engine = new OwnEngine(PUBLIC_CHANGES, { url: `https://${PREVIEW_ZONE}` });
    await runProvision(preview, { services: app.services(async () => engine) });
    await app.merge();
    await writeFakeState(preview.paths);
    engine.changes = [];
    const drifting = await app.deps("preview");
    const report = await runDrift(drifting, { services: app.services(async () => engine) });
    expect(engine.plans.at(-1)?.env.TF_VAR_server_ipv4).toBe(HOST_IPV4);
    expect(report.files).toEqual({ changed: [], created: [] });
    expect(report.notes).toContain(
      "The previews run on dev's server: `opscrew drift --env dev` checks that server and its setup.",
    );
    expect(drifting.reporter.text()).not.toContain("Checking the login to your server");
    expect(await readServerAddresses(drifting.paths)).toEqual({ schemaVersion: 1 });
  });

  it("refuses a switch of dev's server's proxy while the previews run there", async () => {
    const app = await sharedApp(false);
    const { root } = app;
    const previewFile = join(root, "opscrew/environments/preview/plan.yaml");
    const preview = await readArtifact("plan", previewFile);
    await writeArtifact(
      "plan",
      previewFile,
      DeployPlanSchema.parse({
        ...preview,
        deployment: { lastApplyAt: "2026-10-12T11:00:00.000Z" },
      }),
    );
    const devPlan = await readArtifact("plan", app.dev.files.plan);
    await writeArtifact(
      "plan",
      app.dev.files.plan,
      DeployPlanSchema.parse({ ...devPlan, target: { ...devPlan.target, edge: "nginx" } }),
    );
    // dev's server runs Caddy, which the previews share.
    const edge = "opscrew-edge-read 1\nproxy=caddy\n--origin--\n--site--\n--end--\n";
    const engine = new FakeEngine();
    const services: ProvisionServices = {
      ...app.services(async () => engine),
      remote: (host) => ({
        host,
        run: async (command) =>
          command.includes("opscrew-edge-read")
            ? { exitCode: 0, stdout: edge, stderr: "" }
            : readyRemote(host).run(command),
      }),
    };
    const dev = await app.deps("dev");
    await expect(runProvision(dev, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of the preview environment run on dev's server, and switching dev's server to another proxy would break them. Nothing was changed.",
      hint: "Remove them first with `opscrew destroy --env preview` (it leaves dev's server as it is), then run `opscrew provision --env dev` again.",
    });
    expect(engine.calls).not.toContain("apply");
  });

  // The words of the previews' own refusal both ways: the previews' provision, and dev's own.
  it.each([
    [
      "preview",
      "Name another environment's server, or leave the option out for a server of the previews' own, then run `opscrew provision --env preview` again.",
    ],
    [
      "dev",
      "To put that on dev's server anyway, remove the previews of preview first with `opscrew env remove preview`; then run `opscrew provision --env dev` again.",
    ],
  ])(
    "%s's provision refuses before any change while dev's server is on a private network with a device",
    async (environment, hint) => {
      const app = await sharedApp(false);
      const devPlan = await readArtifact("plan", app.dev.files.plan);
      await writeArtifact("plan", app.dev.files.plan, withLaptop(devPlan));
      const deps = await app.deps(environment);
      const engine = new OwnEngine(PUBLIC_CHANGES, {});
      await expect(
        runProvision(deps, { services: app.services(async () => engine) }),
      ).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "dev's server is on a private network, and a preview's containers there could reach your device without escaping anything: traffic within the server passes no firewall. Turn it off on dev first, or give the previews a server of their own. Nothing was changed.",
        hint,
      });
      expect(engine.calls).toEqual([]);
      expect(requestsOf(deps)).toEqual([]);
      expect(app.server.applies).toEqual([]);
    },
  );

  it("refuses before any change when dev's server runs prod too", async () => {
    const app = await sharedApp(true);
    app.server.facts = HostFactsSchema.parse({
      ...app.server.facts,
      apps: [...app.server.facts.apps, { name: "shop", record: recordOf("shop") }],
    });
    const preview = await app.deps("preview");
    const engine = new OwnEngine(PUBLIC_CHANGES, {});
    await expect(
      runProvision(preview, { services: app.services(async () => engine) }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "prod runs on dev's server too, and previews never run beside prod's data. Nothing was changed.",
    });
    expect(engine.plans).toEqual([]);
    expect(app.server.applies).toEqual([]);
    expect(app.github.environments.has("preview")).toBe(false);
  });

  it("reads what dev's server serves for the previews through dev's login, so a renewal is cleaned up", async () => {
    const app = await sharedApp(false);
    const edge = "opscrew-edge-read 1\nproxy=caddy\n--origin--\n--site--\n--end--\n";
    const edgeReads: string[] = [];
    const services = (engine: OwnEngine): ProvisionServices => ({
      ...app.services(async () => engine),
      remote: (host) => ({
        host,
        run: async (command) => {
          if (!command.includes("opscrew-edge-read")) return readyRemote(host).run(command);
          edgeReads.push(host);
          return { exitCode: 0, stdout: edge, stderr: "" };
        },
      }),
    });
    await runProvision(await app.deps("preview"), {
      services: services(new OwnEngine(PUBLIC_CHANGES, { url: `https://${PREVIEW_ZONE}` })),
    });
    await app.merge();
    // Cloudflare no longer lists the certificate: this run makes a new one and supersedes it.
    const [old] = app.zone.originCertificates;
    if (old !== undefined) old.revoked_at = "2026-11-05T12:00:00Z";
    const renewal = await app.deps("preview");
    await runProvision(renewal, {
      services: services(new OwnEngine([], { url: `https://${PREVIEW_ZONE}` })),
    });
    expect(new Set(edgeReads)).toEqual(new Set([HOST_IPV4]));
    expect(renewal.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "read the edge's proxy and the app's origin TLS (read-only)",
        detail: "read",
      }),
    );
    expect(renewal.reporter.text()).not.toContain("could not read what your server serves");
  });
});

describe.skipIf(!findExecutable("git"))("prod on the user's own server beside previews", () => {
  it("refuses before any change on the server where another environment's previews run", async () => {
    const facts = HostFactsSchema.parse({
      ...freshFacts(),
      previews: [
        {
          app: "shop-preview",
          files: {},
          values: true,
          tls: true,
          cron: [],
          numbers: [42],
        },
      ],
    });
    const s = await ownProject({ facts });
    await writeArtifact(
      "plan",
      environmentPaths(s.deps.paths, "dev").files.plan,
      hostTestPlan({ own: true }),
    );
    await writeArtifact(
      "plan",
      environmentPaths(s.deps.paths, "preview").files.plan,
      sharedPreviewTestPlan(),
    );
    await expect(
      runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        'Your server runs the previews of "shop-preview", which run pull requests\' code, and prod would run beside them. Nothing was changed.',
      hint: "Remove them first with `opscrew destroy --env preview`, or give prod another server, then run `opscrew provision --env prod` again.",
    });
    expect(s.engine.plans).toEqual([]);
    expect(s.host.applies).toEqual([]);
  });
});
