import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalDecision, ApprovalRequest, FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { cloudTarget, DEPLOY_SECRETS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  fakeCloudflare,
  HOST_KEY,
  projectRunner,
  SERVER_IPV4,
  testPlan,
} from "../provision/__fixtures__/fakes";
import { ensureStatePassphrase, readServerAddresses } from "../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import {
  type DestroyScript,
  DROPLET_ADDRESS,
  deployedResources,
  FakeDestroyGitHub,
  FakeServers,
  ScriptedDestroyEngine,
  SERVER_ADDRESS,
  unprotectPlan,
} from "./__fixtures__/fakes";
import { runDestroy } from "./run";
import type { DestroyPreview, DestroyServices } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
const DIGITALOCEAN = fakeSecret("digitalocean-token");
const CLOUDFLARE = fakeSecret("cloudflare-token");
const GITHUB = fakeSecret("github-token");
const OTHER_HOST = `198.51.100.7 ${HOST_KEY}`;
const SECRET_NAMES = Object.values(DEPLOY_SECRETS).sort();
const NOW = "2026-10-11T12:00:00.000Z";
const SNAPSHOT_NAME = "opscrew-shop-before-destroy-20261011T120000Z";
const SNAPSHOT_LABELS = {
  app: "shop",
  "created-by": "opscrew",
  reason: "destroy",
  "taken-at": "20261011T120000Z",
};
/** Only a DigitalOcean token, as for a user who never had a Hetzner account. */
const DO_ENV = { HCLOUD_TOKEN: undefined, DIGITALOCEAN_TOKEN: DIGITALOCEAN };
const DO_RESOURCES = deployedResources({ provider: "digitalocean" });

type Answer = (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };

/** Scripted approvals that also record each request in the shared event log. */
class RecordingHandler extends ScriptedApprovalHandler {
  constructor(
    answer: Answer,
    private readonly events: string[],
  ) {
    super(answer);
  }
  override async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.events.push(`approval:${request.kind}`);
    return super.request(request);
  }
}

/** What the CLI does without a terminal: approve only when `--confirm` equals the server name. */
function confirmHandler(confirm: string | undefined, serverName: string): Answer {
  return () =>
    confirm !== undefined && confirm === serverName
      ? { approved: true, confirmation: confirm }
      : { approved: false };
}

/** A plan for a deployed app (Postgres and backups on, so the snapshot defaults to on). */
function deployedPlan(options: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = testPlan({ deployed: true, ...options });
  return {
    ...plan,
    deployment: {
      ...plan.deployment,
      ...(options.domain ? { url: `https://${options.domain}` } : {}),
      lastCompletedPhase: "provision",
      lastPlanHash: "a".repeat(64),
      lastApplyAt: "2026-10-10T09:00:00.000Z",
    },
  };
}

/** The same deployment on a DigitalOcean Droplet (prices in USD). */
function digitalOceanPlan(options: Parameters<typeof testPlan>[0] = {}): DeployPlan {
  const plan = deployedPlan(options);
  return {
    ...plan,
    target: {
      ...cloudTarget(plan.target),
      provider: "digitalocean",
      location: "fra1",
      serverType: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
    },
    cost: {
      ...plan.cost,
      monthly: { amount: 15.6, currency: "USD" },
      breakdown: [
        { item: "server", monthly: { amount: 12, currency: "USD" } },
        { item: "backups", monthly: { amount: 3.6, currency: "USD" } },
      ],
    },
  };
}

interface SetupOptions {
  plan?: DeployPlan;
  answer?: Answer;
  script?: DestroyScript;
  services?: Partial<DestroyServices>;
  env?: Record<string, string | undefined>;
  /** Write the local state file (default true). */
  state?: boolean;
  /** Infrastructure code that declares `delete_protection` (default: on Hetzner only). */
  protectionVariable?: boolean;
  /** Write the OpenTofu state passphrase as provision does (default true). */
  passphrase?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const plan = options.plan ?? deployedPlan();
  const project = await createProject(plan);
  const events: string[] = [];
  const engine = new ScriptedDestroyEngine(options.script, events);
  const servers = new FakeServers(events, cloudTarget(plan.target).provider);
  const github = new FakeDestroyGitHub(events);
  for (const name of SECRET_NAMES) github.secrets.set(name, "stored");
  const handler = new RecordingHandler(options.answer ?? (() => true), events);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    DIGITALOCEAN_TOKEN: undefined,
    DIGITALOCEAN_ACCESS_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    ...options.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });

  // No apply may ever happen before an approval for exactly that plan hash was recorded.
  engine.beforeApply = (planHash) => {
    const approved = deps.audit.entries.some(
      (e) =>
        e.kind === "approval" &&
        e.action === "iac-apply" &&
        e.target === planHash &&
        e.decision === "approved",
    );
    if (!approved) throw new Error(`apply of ${planHash} before its approval`);
  };

  // provision created the state passphrase; destroy only ever reads it
  if (options.passphrase !== false) await ensureStatePassphrase(deps.paths);
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  if (options.state !== false) {
    await mkdir(deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(statePath, '{"version":4,"resources":[]}\n');
  }
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  // DigitalOcean deployments never declare delete_protection (the provider has none)
  const protectionVariable = options.protectionVariable ?? plan.target.provider === "hetzner";
  await writeFile(
    join(project.root, plan.infra.dir, "variables.tf"),
    protectionVariable
      ? 'variable "delete_protection" {\n  type    = bool\n  default = true\n}\n'
      : 'variable "app_name" {\n  type = string\n}\n',
  );
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${OTHER_HOST}\n${SERVER_IPV4} ${HOST_KEY}\n`);
  const secretsRecord = join(deps.paths.projectHomeDir, "deploy_secrets.json");
  await writeFile(
    secretsRecord,
    `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names: SECRET_NAMES })}\n`,
  );

  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers,
    cloudflare: fakeCloudflare(),
    github,
    sleep: async () => undefined,
    ...options.services,
  };
  return {
    ...project,
    plan,
    deps,
    engine,
    servers,
    github,
    handler,
    services,
    events,
    statePath,
    secretsRecord,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function planFilesLeft(deps: Setup["deps"]): Promise<string[]> {
  return readdir(deps.paths.files.plansDir).catch(() => []);
}

/** The provider calls in the audit log (the snapshot) as `[action, target, detail]`. */
function providerCalls(deps: Setup["deps"]): unknown[][] {
  return deps.audit.entries
    .filter((e) => e.kind === "provider-call")
    .map((e) => [e.action, e.target, e.detail]);
}

/** Where a run remembers its snapshot so that a re-run reuses it. */
function snapshotRecord(deps: Setup["deps"]): string {
  return join(deps.paths.stateDir, "destroy-snapshot.json");
}

async function writeSnapshotRecord(deps: Setup["deps"], record: unknown): Promise<void> {
  await mkdir(deps.paths.stateDir, { recursive: true });
  await writeFile(
    snapshotRecord(deps),
    typeof record === "string" ? record : `${JSON.stringify(record)}\n`,
  );
}

/** The project is exactly as before the run: deployment recorded, secrets, host key, record. */
async function expectNothingCleanedUp(s: Setup) {
  const plan = await readArtifact("plan", s.deps.paths.files.plan);
  expect((await readServerAddresses(s.deps.paths)).deployment?.ipv4).toBe(SERVER_IPV4);
  expect(plan.deployment.destroyedAt).toBeUndefined();
  expect(s.github.deleted).toEqual([]);
  await expect(readFile(s.deps.paths.files.knownHosts, "utf8")).resolves.toContain(SERVER_IPV4);
  expect(existsSync(s.secretsRecord)).toBe(true);
  expect((await s.deps.state.read()).phases.provision).toBeUndefined();
  expect(await planFilesLeft(s.deps)).toEqual([]);
}

describe.skipIf(!findExecutable("git"))("runDestroy", () => {
  it("snapshots, lifts protection, destroys, removes the secrets and records the teardown", async () => {
    const s = await setup();
    const { deps, engine, servers, github, handler, services, events } = s;
    const serverAddressWhenSecretsGo: (string | undefined)[] = [];
    github.onDelete = async () => {
      serverAddressWhenSecretsGo.push((await readServerAddresses(deps.paths)).deployment?.ipv4);
    };

    const result = await runDestroy(deps, { services });

    // Order: preview → snapshot → unprotect plan, approval, apply → destroy plan, approval, apply
    // → secrets → plan update (the plan still had its address while the secrets were removed).
    expect(events).toEqual([
      "plan:destroy",
      "snapshot:create",
      "snapshot:ready",
      "plan:unprotect",
      "approval:iac-apply",
      "apply:unprotect",
      "plan:destroy",
      "approval:iac-apply",
      "apply:destroy",
      "approval:github-secrets",
      ...SECRET_NAMES.map((name) => `secret:${name}`),
    ]);
    expect(serverAddressWhenSecretsGo).toEqual(SECRET_NAMES.map(() => SERVER_IPV4));

    expect(result).toEqual({
      snapshotId: "9001",
      destroyed: deployedResources(),
      secretsRemoved: SECRET_NAMES,
      remaining: expect.any(Array),
    });
    const remaining = result.remaining.join("\n");
    expect(remaining).toContain("Hetzner image 9001");
    expect(remaining).toContain(
      "Hetzner bills snapshots per GB per month at the rate listed on https://www.hetzner.com/cloud and OpsCrew never deletes them",
    );
    expect(remaining).toContain("ghcr.io/acme/shop");
    expect(remaining).toContain(".github/workflows/opscrew-deploy.yml");
    expect(remaining).toContain("opscrew provision");

    // Engine: same backend and encryption as provision; every plan lifts protection via the var
    expect(engine.initOptions?.backendConfig?.path).toBe(s.statePath);
    expect(engine.initOptions?.env?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(engine.planOptions.map((o) => [o.destroy === true, o.vars])).toEqual([
      [true, { delete_protection: "false" }],
      [false, { delete_protection: "false" }],
      [true, { delete_protection: "false" }],
    ]);
    expect(engine.applied.map((a) => [a.kind, a.approval.allowDestroy])).toEqual([
      ["unprotect", false],
      ["destroy", true],
    ]);
    expect(engine.planFiles.filter((f) => existsSync(f))).toEqual([]);

    // Snapshot of the app's server, labelled with the app and time, waited for up to 15 minutes
    // (the label selector itself is checked against the real connector below)
    expect(servers.lookups).toEqual(["shop"]);
    expect(servers.snapshots).toEqual([
      {
        serverId: "4711",
        name: SNAPSHOT_NAME,
        description: `OpsCrew snapshot of shop before opscrew destroy (${NOW})`,
        labels: SNAPSHOT_LABELS,
        timeoutMs: 15 * 60_000,
      },
    ]);

    // Approvals: protection lift (no destroy), destroy (allowDestroy + typed name), secrets
    const [unprotect, destroy, secrets] = handler.requests;
    expect(handler.requests).toHaveLength(3);
    expect(unprotect).toMatchObject({ kind: "iac-apply", title: "Lift delete protection on shop" });
    expect(unprotect?.allowDestroy).toBeUndefined();
    expect(unprotect?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unprotect?.details).toContain(`~ update  ${SERVER_ADDRESS}`);
    expect(destroy).toMatchObject({
      kind: "iac-apply",
      allowDestroy: true,
      confirmPhrase: "shop",
      costDelta: { amount: -8.41, currency: "EUR" },
    });
    expect(destroy?.title).toBe("Delete shop on Hetzner Cloud (3 resources to delete)");
    expect(destroy?.details).toContain(`- delete  ${SERVER_ADDRESS}`);
    expect(destroy?.details).toContain("the PostgreSQL database");
    expect(destroy?.details).toContain("Hetzner's automatic backups");
    expect(destroy?.details).toContain("Snapshot: Hetzner image 9001");
    expect(destroy?.details).toContain(`Plan hash: ${destroy?.planHash}`);
    expect(secrets).toMatchObject({
      kind: "github-secrets",
      title: "Remove the deploy secrets from acme/shop",
    });
    for (const name of SECRET_NAMES) expect(secrets?.details).toContain(name);
    expect(github.secrets.size).toBe(0);

    // Host key of the server removed, the other host kept
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(`${OTHER_HOST}\n`);
    expect(existsSync(s.secretsRecord)).toBe(false);

    // Plan: no addresses, destroyedAt, approvals recorded; phase state
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment).toEqual({
      lastPlanHash: "a".repeat(64),
      lastApplyAt: "2026-10-10T09:00:00.000Z",
      destroyedAt: NOW,
    });
    expect(plan.updatedAt).toBe(NOW);
    expect(plan.approvals).toEqual([
      { planHash: unprotect?.planHash, approver: "test-user", at: NOW, kind: "iac-apply" },
      { planHash: destroy?.planHash, approver: "test-user", at: NOW, kind: "iac-apply" },
    ]);
    expect((await deps.state.read()).phases.provision).toMatchObject({
      status: "skipped",
      summary: "infrastructure destroyed",
    });

    // Audit: snapshot, both applies, every secret (names only) and the outcome
    const audit = deps.audit.entries;
    expect(providerCalls(deps)).toEqual([
      [
        "create snapshot",
        "hetzner server 4711",
        `snapshot ${SNAPSHOT_NAME} of shop before destroy`,
      ],
      ["snapshot ready", "hetzner server 4711", `snapshot 9001 of shop (${SNAPSHOT_NAME})`],
    ]);
    expect(audit.filter((e) => e.kind === "iac").map((e) => [e.target, e.detail])).toEqual([
      [unprotect?.planHash, "lifting delete protection: apply finished"],
      [destroy?.planHash, "deleting the infrastructure: apply finished"],
    ]);
    expect(audit.filter((e) => e.kind === "secret-set").map((e) => e.action)).toEqual(
      SECRET_NAMES.map((name) => `delete secret ${name}`),
    );
    expect(audit.filter((e) => e.kind === "approval").map((e) => [e.action, e.decision])).toEqual([
      ["iac-apply", "approved"],
      ["iac-apply", "approved"],
      ["github-secrets", "approved"],
    ]);
    expect(audit.find((e) => e.kind === "phase")?.detail).toContain("3 resources deleted");

    const text = deps.reporter.text();
    expect(text).toContain("The teardown deletes these resources:");
    expect(text).toContain("the PostgreSQL database");
    expect(text).toContain("What remains:");
  });

  it("stops when the typed name is wrong: nothing deleted, and says protection is already lifted", async () => {
    const s = await setup({
      answer: (request) =>
        request.confirmPhrase === undefined ? true : { approved: true, confirmation: "shpo" },
    });
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    const { message, hint } = error as OpsCrewError;
    expect(message).toContain("confirmation phrase did not match");
    expect(message).toContain("Nothing was deleted.");
    expect(message).toContain("Delete protection on shop is already lifted");
    expect(message).toContain("Hetzner image 9001) was kept");
    expect(hint).toContain("`opscrew provision` to turn delete protection back on");
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect"]);
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["iac-apply", "iac-apply"]);
    await expectNothingCleanedUp(s);
  });

  it("an up-front confirmation that fails stops before the snapshot: nothing at all changes", async () => {
    const s = await setup();
    const seen: string[] = [];
    const previews: DestroyPreview[] = [];
    await expect(
      runDestroy(s.deps, {
        services: s.services,
        confirm: async (preview) => {
          seen.push(preview.name, ...preview.resources.map((r) => r.address));
          previews.push(preview);
          expect(preview.dataWarning).toBeDefined();
          return false;
        },
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("nothing was deleted and nothing was changed"),
    });
    expect(seen[0]).toBe("shop");
    expect(seen).toContain("module.server.hcloud_server.this");
    expect(previews[0]).toMatchObject({
      provider: "hetzner",
      deleteProtection: true,
      snapshot: true,
    });
    expect(s.deps.reporter.text()).not.toContain("no delete protection");
    expect(s.servers.lookups).toEqual([]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.applied).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    expect(s.deps.audit.entries.find((e) => e.action === "destroy-confirm")?.decision).toBe(
      "refused",
    );
    await expectNothingCleanedUp(s);
  });

  it("an up-front confirmation that passes runs the usual approvals", async () => {
    const s = await setup();
    const result = await runDestroy(s.deps, { services: s.services, confirm: async () => true });
    expect(result.destroyed).toEqual(deployedResources());
    expect(s.deps.audit.entries.find((e) => e.action === "destroy-confirm")?.decision).toBe(
      "approved",
    );
  });

  it("stops before planning when the state passphrase is not on this computer, and never creates one", async () => {
    const s = await setup({ passphrase: false });
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("does not have its passphrase"),
    });
    expect(existsSync(s.deps.paths.files.statePassphrase)).toBe(false);
    expect(s.engine.calls.filter((c) => c.startsWith("plan"))).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("stops when the destroy plan would delete something that was not in the confirmed list", async () => {
    const s = await setup();
    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async () => {
        // someone adds a volume between the preview and the destroy plan
        (s.engine.script as DestroyScript).resources = [
          ...deployedResources(),
          {
            address: "module.server.hcloud_volume.data",
            type: "hcloud_volume",
            name: "data",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "delete",
          },
        ];
        return true;
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("module.server.hcloud_volume.data"),
    });
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect"]);
    // protection was lifted before this stop, so the error says so and how to turn it back on
    expect((error as OpsCrewError).message).toContain(
      "Nothing was deleted. Delete protection on shop is already lifted, so the server is not protected against deletion now.",
    );
    expect((error as OpsCrewError).hint).toBe(
      "Run `opscrew provision` to turn delete protection back on, or run `opscrew destroy` again to see the current list and confirm it.",
    );
  });

  it("stops when the destroy plan deletes another server than the confirmed one, and says protection is already lifted", async () => {
    const s = await setup();
    // the server is recreated between the preview and the destroy plan
    s.engine.beforeApply = (() => {
      const check = s.engine.beforeApply;
      return (planHash, kind) => {
        check?.(planHash, kind);
        if (kind === "unprotect") (s.engine.script as DestroyScript).serverId = "4712";
      };
    })();
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    const { message, hint } = error as OpsCrewError;
    expect(message).toContain(
      "The teardown plan now deletes a server other than the one you confirmed (id 4711), so OpsCrew stopped. Nothing was deleted.",
    );
    expect(message).toContain(
      "Delete protection on shop is already lifted, so the server is not protected against deletion now.",
    );
    expect(message).toContain("The snapshot (Hetzner image 9001) was kept");
    expect(hint).toBe(
      "Run `opscrew provision` to turn delete protection back on, or run `opscrew drift` to see what changed, then run `opscrew destroy` again to see the current list and confirm it.",
    );
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect"]);
    expect(s.handler.requests.map((r) => r.title)).toEqual(["Lift delete protection on shop"]);
    await expectNothingCleanedUp(s);
  });

  it("reuses the snapshot of an earlier run instead of taking another", async () => {
    let refuseDestroy = true;
    const s = await setup({
      answer: (request) => !(refuseDestroy && request.allowDestroy === true),
    });
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(s.servers.snapshots).toHaveLength(1);
    expect(JSON.parse(await readFile(snapshotRecord(s.deps), "utf8"))).toEqual({
      provider: "hetzner",
      serverId: "4711",
      snapshotId: "9001",
      takenAt: NOW,
    });

    refuseDestroy = false;
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBe("9001");
    expect(s.servers.snapshots).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain(
      "Reusing the snapshot taken by the earlier run (Hetzner image 9001).",
    );
    expect(existsSync(snapshotRecord(s.deps))).toBe(false);
  });

  it("reuses a snapshot recorded by OpsCrew 003 (numeric Hetzner ids)", async () => {
    const s = await setup();
    await writeSnapshotRecord(s.deps, {
      serverId: 4711,
      imageId: 9001,
      takenAt: "2026-10-10T09:00:00.000Z",
    });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBe("9001");
    expect(s.servers.snapshots).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      "Reusing the snapshot taken by the earlier run (Hetzner image 9001).",
    );
    expect(s.handler.requests[1]?.details).toContain("Snapshot: Hetzner image 9001");
  });

  it("refusing the protection lift changes nothing", async () => {
    const s = await setup({ answer: () => false });
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("Delete protection on shop was not lifted"),
    });
    expect(s.engine.applied).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("takes no snapshot with snapshot: false", async () => {
    const s = await setup();
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(result.snapshotId).toBeUndefined();
    expect(s.servers.lookups).toEqual([]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.deps.reporter.text()).toContain("Skipping the snapshot, as requested.");
    expect(s.handler.requests[1]?.details).toContain(
      "Snapshot: none. What is stored on the server cannot be recovered after this.",
    );
    expect(result.remaining.join("\n")).not.toContain("snapshot");
    expect(result.destroyed).toEqual(deployedResources());
  });

  it("auto takes no snapshot when no data lives only on the server", async () => {
    const base = deployedPlan({ postgres: false });
    const s = await setup({
      plan: { ...base, target: { ...cloudTarget(base.target), backups: false } },
    });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBeUndefined();
    expect(s.servers.lookups).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      "No snapshot: the database does not run on the server and Hetzner backups are off.",
    );
  });

  it.each([
    ["creating", "createError"],
    ["waiting for", "waitError"],
  ] as const)(
    "a snapshot error while %s it stops before anything changes",
    async (_what, field) => {
      const s = await setup();
      s.servers[field] = new OpsCrewError(
        "PROVIDER_ERROR",
        "Hetzner action 77 (create_image) failed: disk unavailable",
      );
      const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
      expect((error as OpsCrewError).message).toBe(
        "The snapshot of shop failed: Hetzner action 77 (create_image) failed: disk unavailable. Nothing was deleted.",
      );
      // Whether the snapshot was started is unknown here, so the hint covers both cases
      expect((error as OpsCrewError).hint).toContain("its snapshots in the Hetzner Cloud Console");
      expect((error as OpsCrewError).hint).toContain("`opscrew destroy --no-snapshot`");
      expect(s.engine.calls.filter((c) => c.startsWith("apply"))).toEqual([]);
      expect(s.engine.calls).not.toContain("plan:unprotect");
      expect(s.handler.requests).toEqual([]);
      expect(providerCalls(s.deps)).toEqual([
        [
          "create snapshot",
          "hetzner server 4711",
          `snapshot ${SNAPSHOT_NAME} of shop before destroy`,
        ],
        [
          "snapshot failed",
          "hetzner server 4711",
          `snapshot ${SNAPSHOT_NAME} of shop: Hetzner action 77 (create_image) failed: disk unavailable`,
        ],
      ]);
      expect(existsSync(snapshotRecord(s.deps))).toBe(false);
      await expectNothingCleanedUp(s);
    },
  );

  it.each([
    [
      "another resource",
      {
        changes: [
          ...unprotectPlan().changes,
          {
            address: "module.server.hcloud_firewall.this",
            type: "hcloud_firewall",
            name: "this",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "create" as const,
          },
        ],
        planJson: unprotectPlan().planJson,
      },
      "create module.server.hcloud_firewall.this",
    ],
    [
      "another server setting",
      unprotectPlan({ server_type: "cx53" }),
      `update ${SERVER_ADDRESS} (server_type)`,
    ],
  ])(
    "an unprotect plan that also changes %s stops, even when every approval is given",
    async (_what, unprotect, listed) => {
      const s = await setup({ answer: confirmHandler("shop", "shop"), script: { unprotect } });
      const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect((error as OpsCrewError).message).toContain(listed);
      expect((error as OpsCrewError).message).toContain("Nothing was changed.");
      expect((error as OpsCrewError).message).not.toContain("cx53");
      expect((error as OpsCrewError).hint).toContain("opscrew drift");
      expect(s.handler.requests).toEqual([]);
      expect(s.engine.applied).toEqual([]);
      await expectNothingCleanedUp(s);
    },
  );

  it("non-interactive: proceeds without prompts only when --confirm matches the server name", async () => {
    const matching = await setup({ answer: confirmHandler("shop", "shop") });
    const result = await runDestroy(matching.deps, { services: matching.services });
    expect(result.destroyed).toEqual(deployedResources());
    expect(matching.handler.requests.map((r) => r.kind)).toEqual([
      "iac-apply",
      "iac-apply",
      "github-secrets",
    ]);

    for (const confirm of ["shop2", undefined]) {
      const other = await setup({ answer: confirmHandler(confirm, "shop") });
      await expect(runDestroy(other.deps, { services: other.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
        message: expect.stringContaining("Delete protection on shop was not lifted"),
      });
      expect(other.engine.applied).toEqual([]);
      expect(other.handler.requests).toHaveLength(1);
      await expectNothingCleanedUp(other);
    }
  });

  it("handles a server that is already gone: no snapshot, no protection lift, deletes the rest", async () => {
    const s = await setup({ script: { resources: deployedResources({ server: false }) } });
    s.servers.servers = [];
    const result = await runDestroy(s.deps, { services: s.services });

    expect(result.snapshotId).toBeUndefined();
    expect(result.destroyed).toEqual(deployedResources({ server: false }));
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.calls).not.toContain("plan:unprotect");
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["destroy"]);
    const text = s.deps.reporter.text();
    expect(text).toContain("No snapshot: the server shop no longer exists in Hetzner Cloud");
    expect(text).toContain("no delete protection to lift");
    expect(text).not.toContain("PostgreSQL");
    expect(s.handler.requests[0]?.details).toContain("Snapshot: none.");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBe(NOW);
  });

  it("deletes the Cloudflare records too, and stops before planning without a Cloudflare token", async () => {
    const plan = deployedPlan({ domain: "shop.example.com" });
    const withToken = await setup({
      plan,
      script: { resources: deployedResources({ dns: true }) },
    });
    const result = await runDestroy(withToken.deps, { services: withToken.services });
    expect(result.destroyed).toHaveLength(5);
    expect(withToken.handler.requests[1]?.title).toBe(
      "Delete shop on Hetzner Cloud and Cloudflare (5 resources to delete)",
    );

    const without = await setup({ plan, services: { cloudflare: null } });
    const error = await runDestroy(without.deps, { services: without.services }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect((error as OpsCrewError).message).toContain("CLOUDFLARE_API_TOKEN");
    expect((error as OpsCrewError).hint).toContain("dead address");
    expect(without.engine.calls).toEqual([]);
    expect(without.servers.lookups).toEqual([]);
    await expectNothingCleanedUp(without);

    const rejected = await setup({
      plan,
      services: {
        cloudflare: {
          verifyToken: async () => ({ ok: false, message: "The token was rejected." }),
        },
      },
    });
    await expect(runDestroy(rejected.deps, { services: rejected.services })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });
    expect(rejected.engine.calls).toEqual([]);
  });

  it("without a GitHub token: warns, skips the secret cleanup and lists the secrets as remaining", async () => {
    const s = await setup({ services: { github: null } });
    const result = await runDestroy(s.deps, { services: s.services });

    expect(result.secretsRemoved).toEqual([]);
    expect(result.destroyed).toEqual(deployedResources());
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["iac-apply", "iac-apply"]);
    const warning = s.deps.reporter.lines.find(
      (l) => l.level === "warn" && l.message.includes("GitHub"),
    );
    expect(warning?.message).toContain("no GitHub token was found");
    expect(warning?.message).toContain("https://github.com/acme/shop/settings/secrets/actions");
    const remaining = result.remaining.join("\n");
    expect(remaining).toContain("OPSCREW_SSH_PRIVATE_KEY");
    expect(remaining).toContain("https://github.com/acme/shop/settings/secrets/actions");
    expect(s.deps.audit.entries.filter((e) => e.kind === "secret-set")).toEqual([]);
    // the rest of the cleanup still happens
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect((await readServerAddresses(s.deps.paths)).deployment).toBeUndefined();
    expect(plan.deployment.destroyedAt).toBe(NOW);
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).toBe(`${OTHER_HOST}\n`);
    expect(existsSync(s.secretsRecord)).toBe(false);
  });

  it("a failed destroy apply reports the log tail; running again continues where it stopped", async () => {
    const s = await setup({ script: { applyOk: { destroy: false } } });
    const error = await runDestroy(s.deps, { services: s.services, snapshot: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as OpsCrewError).message).toContain("Deleting the infrastructure failed:");
    expect((error as OpsCrewError).message).toContain("server is locked");
    expect((error as OpsCrewError).hint).toContain("run `opscrew destroy` again");
    expect(
      s.deps.audit.entries.filter((e) => e.kind === "iac").map((e) => [e.decision, e.detail]),
    ).toEqual([
      ["approved", "lifting delete protection: apply finished"],
      ["refused", "deleting the infrastructure: apply failed"],
    ]);
    await expectNothingCleanedUp(s);

    // Second run: protection is already off (empty unprotect plan, no approval for it)
    s.engine.script.applyOk = {};
    s.handler.requests.length = 0;
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(result.destroyed).toEqual(deployedResources());
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["iac-apply", "github-secrets"]);
    expect(s.handler.requests[0]?.allowDestroy).toBe(true);
    expect(s.deps.reporter.text()).toContain("Delete protection on shop is already off.");
  });

  it("a failed protection lift stops before the destroy plan", async () => {
    const s = await setup({ script: { applyOk: { unprotect: false } } });
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as OpsCrewError).message).toContain("Lifting delete protection failed:");
    expect((error as OpsCrewError).hint).toContain("Nothing was deleted.");
    expect(s.engine.calls.filter((c) => c === "plan:destroy")).toHaveLength(1);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect"]);
    await expectNothingCleanedUp(s);
  });

  it("a GitHub error while removing a secret says the infrastructure is gone and how to finish", async () => {
    const s = await setup();
    s.github.deleteError = new OpsCrewError(
      "CREDENTIALS_INVALID",
      "GitHub refused to delete the secret OPSCREW_APP_ENV (Resource not accessible by integration).",
      { hint: "The token needs access to this repository with: Secrets (read and write)." },
    );
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect((error as OpsCrewError).message).toContain(
      "The infrastructure is deleted, but removing the GitHub secret OPSCREW_APP_ENV failed",
    );
    expect((error as OpsCrewError).hint).toContain("Secrets (read and write).");
    expect((error as OpsCrewError).hint).toContain("run `opscrew destroy` again");
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    expect((await readServerAddresses(s.deps.paths)).deployment?.ipv4).toBe(SERVER_IPV4);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt).toBe(
      undefined,
    );
  });

  it("a refused secret cleanup leaves the plan as it was; running again finishes the cleanup", async () => {
    let removeSecrets = false;
    const s = await setup({
      answer: (request) => request.kind !== "github-secrets" || removeSecrets,
    });
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("The infrastructure is deleted."),
    });
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    let plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect((await readServerAddresses(s.deps.paths)).deployment?.ipv4).toBe(SERVER_IPV4);
    expect(plan.deployment.destroyedAt).toBeUndefined();

    s.servers.servers = [];
    s.handler.requests.length = 0;
    removeSecrets = true;
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.destroyed).toEqual([]);
    expect(result.secretsRemoved).toEqual(SECRET_NAMES);
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
    expect(s.deps.reporter.text()).toContain("Nothing is left to delete.");
    plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBe(NOW);

    // A third run finds nothing deployed
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "Nothing is deployed for this project, so there is nothing to destroy.",
      hint: expect.stringContaining(`already tore this deployment down (${NOW})`),
    });
  });

  it("refuses while a move to another provider is in progress, before any check or change", async () => {
    const from = deployedPlan();
    const plan: DeployPlan = {
      ...digitalOceanPlan(),
      retarget: {
        from: { target: cloudTarget(from.target) },
        step: "deployed",
        startedAt: NOW,
      },
    };
    const s = await setup({ plan });
    let asked = false;
    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async () => {
        asked = true;
        return true;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    const { code, message, hint } = error as OpsCrewError;
    expect(code).toBe("PHASE_PRECONDITION");
    expect(message).toBe(
      "A move to DigitalOcean is in progress, so OpsCrew will not delete this deployment.",
    );
    expect(hint).toContain("`opscrew retarget` to continue the move");
    expect(hint).toContain("`opscrew retarget --finish`");
    expect(hint).toContain("`opscrew retarget --abort`");
    expect(asked).toBe(false);
    expect(s.engine.calls).toEqual([]);
    expect(s.servers.lookups).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    expect(s.deps.audit.entries).toEqual([]);
    await expectNothingCleanedUp(s);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).retarget?.step).toBe("deployed");
  });

  it("stops before any credential check without local state or with old infrastructure code", async () => {
    const elsewhere = await setup({ state: false });
    await expect(
      runDestroy(elsewhere.deps, { services: elsewhere.services }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("is not on this computer"),
    });
    expect(elsewhere.engine.calls).toEqual([]);

    const fresh = await setup({ plan: testPlan(), state: false });
    await expect(runDestroy(fresh.deps, { services: fresh.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "Nothing is deployed for this project, so there is nothing to destroy.",
    });

    const old = await setup({ protectionVariable: false });
    await expect(runDestroy(old.deps, { services: old.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("generated by an older OpsCrew"),
    });
    expect(old.engine.calls).toEqual([]);

    const noInfra = await setup();
    await rm(join(noInfra.root, noInfra.plan.infra.dir), { recursive: true });
    await expect(runDestroy(noInfra.deps, { services: noInfra.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("opscrew/infra/prod) is missing"),
    });
  });

  it("never prints a token or the state passphrase (real connectors over a fake network)", async () => {
    const requests: { method: string; url: string; auth: string | null }[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url: url.toString(),
        auth: new Headers(init?.headers).get("authorization"),
      });
      const page = { pagination: { page: 1, next_page: null } };
      if (url.hostname === "api.hetzner.cloud") {
        if (url.pathname === "/v1/locations") {
          return json({ locations: [{ id: 1, name: "nbg1", country: "DE" }], meta: page });
        }
        if (url.pathname === "/v1/servers") {
          return json({
            servers: [
              {
                id: 4711,
                name: "shop",
                status: "running",
                labels: { "managed-by": "opscrew", app: "shop" },
                public_net: { ipv4: { ip: SERVER_IPV4 }, ipv6: null },
              },
            ],
            meta: page,
          });
        }
        if (url.pathname === "/v1/servers/4711/actions/create_image" && method === "POST") {
          return json(
            {
              image: { id: 9001, type: "snapshot" },
              action: { id: 77, command: "create_image", status: "running" },
            },
            201,
          );
        }
        if (url.pathname === "/v1/actions/77") {
          return json({ action: { id: 77, command: "create_image", status: "success" } });
        }
      }
      if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/user/tokens/verify")) {
        return json({ success: true, errors: [], result: { status: "active" } });
      }
      if (url.hostname === "api.github.com" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request in a test: ${method} ${url}`);
    };

    const plan = deployedPlan({ domain: "shop.example.com" });
    const s = await setup({
      plan,
      script: { resources: deployedResources({ dns: true }) },
      env: { HCLOUD_TOKEN: HCLOUD, CLOUDFLARE_API_TOKEN: CLOUDFLARE, GITHUB_TOKEN: GITHUB },
    });
    s.deps.fetch = fetch;
    const services: DestroyServices = {
      engine: s.services.engine as NonNullable<DestroyServices["engine"]>,
    };
    const result = await runDestroy(s.deps, { services });

    expect(result.snapshotId).toBe("9001");
    expect(result.secretsRemoved).toEqual(SECRET_NAMES);
    // The tokens were used, but only in Authorization headers
    expect(requests.some((r) => r.auth === `Bearer ${HCLOUD}`)).toBe(true);
    expect(requests.some((r) => r.auth === `Bearer ${CLOUDFLARE}`)).toBe(true);
    expect(requests.some((r) => r.auth === `Bearer ${GITHUB}`)).toBe(true);
    expect(requests.find((r) => r.url.includes("/v1/servers?"))?.url).toContain(
      "label_selector=managed-by%3Dopscrew%2Capp%3Dshop",
    );
    expect(requests.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual(
      SECRET_NAMES.map((n) => `https://api.github.com/repos/acme/shop/actions/secrets/${n}`),
    );
    expect(requests.every((r) => !r.url.includes(HCLOUD) && !r.url.includes(GITHUB))).toBe(true);

    const passphrase = (await readFile(s.deps.paths.files.statePassphrase, "utf8")).trim();
    expect(s.engine.initOptions?.env?.TF_ENCRYPTION).toContain(passphrase);
    const printed = [
      s.deps.reporter.text(),
      JSON.stringify(s.deps.audit.entries),
      JSON.stringify(s.handler.requests),
      result.remaining.join("\n"),
    ].join("\n");
    for (const secret of [HCLOUD, CLOUDFLARE, GITHUB, passphrase]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("stops before deleting a server that is in the teardown but cannot be found for its snapshot", async () => {
    const s = await setup();
    s.servers.servers = [];
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as OpsCrewError).message).toContain(
      "OpsCrew could not find the server shop in Hetzner Cloud",
    );
    expect((error as OpsCrewError).message).toContain("Nothing was changed.");
    expect((error as OpsCrewError).hint).toContain("`opscrew destroy --no-snapshot`");
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.applied).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("snapshots the server with the state's id when another one has the same name", async () => {
    const s = await setup();
    s.servers.servers = [
      { id: "999", name: "shop", status: "running" },
      { id: "4711", name: "shop", status: "running" },
    ];
    const result = await runDestroy(s.deps, { services: s.services });
    expect(s.servers.snapshots.map((snapshot) => snapshot.serverId)).toEqual(["4711"]);
    expect(result.snapshotId).toBe("9001");
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
  });

  it("takes no snapshot of a server the teardown does not delete", async () => {
    const s = await setup({ script: { resources: deployedResources({ server: false }) } });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBeUndefined();
    expect(s.servers.snapshots).toEqual([]);
    expect(providerCalls(s.deps)).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      "No snapshot: the teardown does not delete the server shop",
    );
    expect(result.destroyed).toEqual(deployedResources({ server: false }));
  });
});

describe.skipIf(!findExecutable("git"))("runDestroy on DigitalOcean", () => {
  it("says there is no delete protection, snapshots after the typed name and destroys without a protection step", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    const { deps, engine, servers, github, handler, events } = s;
    const previews: DestroyPreview[] = [];
    let printedBeforeConfirm = "";
    const result = await runDestroy(deps, {
      services: s.services,
      confirm: async (preview) => {
        previews.push(preview);
        printedBeforeConfirm = deps.reporter.text();
        events.push("confirm");
        return true;
      },
    });

    // Order: preview → typed name → snapshot → destroy plan, approval, apply → secrets
    expect(events).toEqual([
      "plan:destroy",
      "confirm",
      "snapshot:create",
      "snapshot:ready",
      "plan:destroy",
      "approval:iac-apply",
      "apply:destroy",
      "approval:github-secrets",
      ...SECRET_NAMES.map((name) => `secret:${name}`),
    ]);

    // The preview: resources, the data warning, the snapshot and the missing delete protection
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      name: "shop",
      provider: "digitalocean",
      deleteProtection: false,
      snapshot: true,
      resources: DO_RESOURCES,
    });
    expect(previews[0]?.dataWarning).toContain(
      "Deleting the Droplet also deletes the PostgreSQL database",
    );
    expect(printedBeforeConfirm).toContain(`- delete  ${DROPLET_ADDRESS}`);
    expect(printedBeforeConfirm).toContain(
      "DigitalOcean has no delete protection for Droplets, so the only safeguard is OpsCrew's own confirmation",
    );
    expect(printedBeforeConfirm).toContain("A snapshot of the Droplet is taken first");
    expect(printedBeforeConfirm).toContain(
      "DigitalOcean bills snapshots per GB per month at the rate listed on https://www.digitalocean.com/pricing;",
    );
    expect(printedBeforeConfirm).not.toContain("$0.06");

    // No protection step: no unprotect plan and no delete_protection variable on any plan
    expect(engine.calls).not.toContain("plan:unprotect");
    expect(engine.planOptions.map((o) => [o.destroy === true, o.vars])).toEqual([
      [true, undefined],
      [true, undefined],
    ]);
    expect(engine.applied.map((a) => [a.kind, a.approval.allowDestroy])).toEqual([
      ["destroy", true],
    ]);
    expect(engine.planFiles.filter((f) => existsSync(f))).toEqual([]);

    // The snapshot goes through the provider-neutral API with a findable name
    expect(servers.lookups).toEqual(["shop"]);
    expect(servers.snapshots).toEqual([
      {
        serverId: "3164444",
        name: SNAPSHOT_NAME,
        description: `OpsCrew snapshot of shop before opscrew destroy (${NOW})`,
        labels: SNAPSHOT_LABELS,
        timeoutMs: 15 * 60_000,
      },
    ]);

    // Approvals: the destroy plan (allowDestroy + typed name), then the secrets
    expect(handler.requests.map((r) => r.kind)).toEqual(["iac-apply", "github-secrets"]);
    const destroy = handler.requests[0];
    expect(destroy).toMatchObject({
      title: "Delete shop on DigitalOcean (4 resources to delete)",
      allowDestroy: true,
      confirmPhrase: "shop",
      costDelta: { amount: -15.6, currency: "USD" },
    });
    expect(destroy?.details).toContain(`- delete  ${DROPLET_ADDRESS}`);
    expect(destroy?.details).toContain("the PostgreSQL database");
    expect(destroy?.details).toContain(
      "Snapshot: DigitalOcean snapshot 6372321 keeps a copy of the Droplet (billed per GB per month at the rate listed on https://www.digitalocean.com/pricing; OpsCrew never deletes it).",
    );

    // Result and what remains: the snapshot and its price, the retained backups, images, files
    expect(result).toEqual({
      snapshotId: "6372321",
      destroyed: DO_RESOURCES,
      secretsRemoved: SECRET_NAMES,
      remaining: expect.any(Array),
    });
    const remaining = result.remaining.join("\n");
    expect(remaining).toContain("DigitalOcean snapshot 6372321");
    expect(remaining).toContain(
      "DigitalOcean bills snapshots per GB per month at the rate listed on https://www.digitalocean.com/pricing and OpsCrew never deletes them",
    );
    expect(remaining).not.toContain("$0.06");
    expect(remaining).toContain("OpsCrew never deletes them");
    expect(remaining).toContain(
      "The Droplet's automatic backups. DigitalOcean keeps them until they expire, four weeks after they were taken",
    );
    expect(remaining).not.toContain("bills them");
    expect(remaining).toContain("ghcr.io/acme/shop");
    expect(remaining).toContain(".github/workflows/opscrew-deploy.yml");

    // Secrets and the pinned host key are gone; the plan records the teardown
    expect(github.secrets.size).toBe(0);
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(`${OTHER_HOST}\n`);
    expect(existsSync(s.secretsRecord)).toBe(false);
    expect(existsSync(snapshotRecord(deps))).toBe(false);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect((await readServerAddresses(deps.paths)).deployment).toBeUndefined();
    expect(plan.deployment.destroyedAt).toBe(NOW);
    expect(plan.approvals).toEqual([
      { planHash: destroy?.planHash, approver: "test-user", at: NOW, kind: "iac-apply" },
    ]);

    // Audit: the typed confirmation, the snapshot (provider, Droplet, snapshot id), the apply
    const audit = deps.audit.entries;
    expect(audit.find((e) => e.action === "destroy-confirm")?.decision).toBe("approved");
    expect(providerCalls(deps)).toEqual([
      [
        "create snapshot",
        "digitalocean server 3164444",
        `snapshot ${SNAPSHOT_NAME} of shop before destroy`,
      ],
      [
        "snapshot ready",
        "digitalocean server 3164444",
        `snapshot 6372321 of shop (${SNAPSHOT_NAME})`,
      ],
    ]);
    expect(audit.filter((e) => e.kind === "iac").map((e) => [e.target, e.detail])).toEqual([
      [destroy?.planHash, "deleting the infrastructure: apply finished"],
    ]);
    expect(audit.find((e) => e.kind === "phase")?.detail).toContain(
      "DigitalOcean snapshot 6372321 kept",
    );

    // Nothing about Hetzner or lifting protection anywhere
    const text = [deps.reporter.text(), JSON.stringify(handler.requests), remaining].join("\n");
    expect(text).not.toContain("Hetzner");
    expect(text).not.toContain("Lift delete protection");
    expect(text).not.toContain("delete_protection");
  });

  it("runs without a typed confirmation hook too: the destroy approval is the only gate", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
      answer: confirmHandler("shop", "shop"),
    });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.destroyed).toEqual(DO_RESOURCES);
    expect(s.handler.requests.map((r) => [r.kind, r.allowDestroy])).toEqual([
      ["iac-apply", true],
      ["github-secrets", undefined],
    ]);

    for (const confirm of ["shpo", undefined]) {
      const other = await setup({
        plan: digitalOceanPlan(),
        script: { resources: DO_RESOURCES },
        env: DO_ENV,
        answer: confirmHandler(confirm, "shop"),
      });
      const error = await runDestroy(other.deps, { services: other.services }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
      expect((error as OpsCrewError).message).toContain("Nothing was deleted.");
      expect((error as OpsCrewError).message).toContain("DigitalOcean snapshot 6372321) was kept");
      expect((error as OpsCrewError).message).not.toContain("protection");
      expect(other.engine.applied).toEqual([]);
      await expectNothingCleanedUp(other);
    }
  });

  it("an up-front confirmation that fails changes nothing, not even a snapshot", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    await expect(
      runDestroy(s.deps, { services: s.services, confirm: async () => false }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("nothing was deleted and nothing was changed"),
    });
    expect(s.servers.lookups).toEqual([]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.applied).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("a Droplet deleted in the console: the snapshot is skipped with a note and the rest is deleted", async () => {
    const left = deployedResources({ provider: "digitalocean", server: false });
    const s = await setup({ plan: digitalOceanPlan(), script: { resources: left }, env: DO_ENV });
    s.servers.servers = [];
    const result = await runDestroy(s.deps, { services: s.services });

    expect(result.snapshotId).toBeUndefined();
    expect(result.destroyed).toEqual(left);
    expect(s.servers.lookups).toEqual(["shop"]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["destroy"]);
    const text = s.deps.reporter.text();
    expect(text).toContain(
      "No snapshot: the Droplet shop no longer exists in DigitalOcean, so there is nothing to keep.",
    );
    expect(text).not.toContain("PostgreSQL");
    expect(s.handler.requests[0]?.details).toContain("Snapshot: none.");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBe(NOW);
  });

  it.each([
    [
      "cannot start",
      "createError",
      "DigitalOcean could not start the snapshot: Droplet is currently busy.",
    ],
    ["errors", "waitError", "DigitalOcean action 36805022 (snapshot) failed."],
    [
      "times out",
      "waitError",
      "DigitalOcean action 36805022 (snapshot) did not finish within 15 minutes.",
    ],
  ] as const)(
    "a snapshot that %s stops before anything is deleted",
    async (_what, field, cause) => {
      const s = await setup({
        plan: digitalOceanPlan(),
        script: { resources: DO_RESOURCES },
        env: DO_ENV,
      });
      s.servers[field] = new OpsCrewError("PROVIDER_ERROR", cause);
      const error = await runDestroy(s.deps, {
        services: s.services,
        confirm: async () => true,
      }).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
      expect((error as OpsCrewError).message).toBe(
        `The snapshot of shop failed: ${cause.replace(/\.$/, "")}. Nothing was deleted.`,
      );
      expect((error as OpsCrewError).hint).toContain(
        "the Droplet and its snapshots in the DigitalOcean control panel",
      );
      expect(s.engine.calls.filter((c) => c.startsWith("plan"))).toEqual(["plan:destroy"]);
      expect(s.engine.applied).toEqual([]);
      expect(s.handler.requests).toEqual([]);
      expect(providerCalls(s.deps)).toEqual([
        [
          "create snapshot",
          "digitalocean server 3164444",
          `snapshot ${SNAPSHOT_NAME} of shop before destroy`,
        ],
        [
          "snapshot failed",
          "digitalocean server 3164444",
          `snapshot ${SNAPSHOT_NAME} of shop: ${cause.replace(/\.$/, "")}`,
        ],
      ]);
      expect(existsSync(snapshotRecord(s.deps))).toBe(false);
      await expectNothingCleanedUp(s);
    },
  );

  it("reuses a snapshot recorded with string ids for the same provider and Droplet", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    await writeSnapshotRecord(s.deps, {
      provider: "digitalocean",
      serverId: "3164444",
      snapshotId: "6372399",
      takenAt: "2026-10-10T09:00:00.000Z",
    });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBe("6372399");
    expect(s.servers.snapshots).toEqual([]);
    expect(providerCalls(s.deps)).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      "Reusing the snapshot taken by the earlier run (DigitalOcean snapshot 6372399).",
    );
    expect(s.handler.requests[0]?.details).toContain("Snapshot: DigitalOcean snapshot 6372399");
    expect(existsSync(snapshotRecord(s.deps))).toBe(false);
  });

  it.each([
    ["from another provider", { provider: "hetzner", serverId: "3164444", snapshotId: "1" }],
    ["from OpsCrew 003, which only knew Hetzner", { serverId: 3164444, imageId: 1 }],
    ["for another Droplet", { provider: "digitalocean", serverId: "999", snapshotId: "1" }],
    ["missing the snapshot id", { provider: "digitalocean", serverId: "3164444" }],
    ["unreadable", "{not json"],
  ])("takes a new snapshot when the record is %s", async (_what, record) => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
      // stop after the snapshot so the new record can be read
      answer: (request) => request.allowDestroy !== true,
    });
    await writeSnapshotRecord(s.deps, record);
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("DigitalOcean snapshot 6372321) was kept"),
    });
    expect(s.servers.snapshots.map((snapshot) => snapshot.serverId)).toEqual(["3164444"]);
    expect(JSON.parse(await readFile(snapshotRecord(s.deps), "utf8"))).toEqual({
      provider: "digitalocean",
      serverId: "3164444",
      snapshotId: "6372321",
      takenAt: NOW,
    });
    expect(s.engine.applied).toEqual([]);
  });

  it("snapshots the Droplet the state names, not another one with the same name", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    // an orphan from lost state, listed first, with the same name and tags
    s.servers.servers = [
      { id: "1111111", name: "shop", status: "active" },
      { id: "3164444", name: "shop", status: "active" },
    ];
    // a record from an earlier run for the orphan is not reused either
    await writeSnapshotRecord(s.deps, {
      provider: "digitalocean",
      serverId: "1111111",
      snapshotId: "5555",
    });
    const result = await runDestroy(s.deps, { services: s.services });
    expect(s.servers.snapshots.map((snapshot) => snapshot.serverId)).toEqual(["3164444"]);
    expect(result.snapshotId).toBe("6372321");
    expect(providerCalls(s.deps).map(([action, target]) => [action, target])).toEqual([
      ["create snapshot", "digitalocean server 3164444"],
      ["snapshot ready", "digitalocean server 3164444"],
    ]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["destroy"]);
  });

  it.each([
    [
      "no Droplet has the id the state records",
      { serverId: "3164444" },
      [
        { id: "1111111", name: "shop", status: "active" },
        { id: "2222222", name: "shop", status: "active" },
      ],
      "no Droplet tagged opscrew-app:shop and managed-by:opscrew has the id 3164444 that the infrastructure state records",
    ],
    [
      "the plan does not say the id and two Droplets have the name",
      { serverId: null },
      [
        { id: "1111111", name: "shop", status: "active" },
        { id: "3164444", name: "shop", status: "active" },
      ],
      "Several Droplets tagged opscrew-app:shop and managed-by:opscrew are named shop, and the infrastructure state does not say which one the teardown deletes",
    ],
  ] as const)("stops with nothing changed when %s", async (_what, script, droplets, message) => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES, ...script },
      env: DO_ENV,
    });
    s.servers.servers = droplets.map((droplet) => ({ ...droplet }));
    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async () => true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as OpsCrewError).message).toContain(message);
    expect((error as OpsCrewError).message).toContain("Nothing was changed.");
    expect((error as OpsCrewError).hint).toContain("`opscrew destroy --no-snapshot`");
    expect(s.servers.snapshots).toEqual([]);
    expect(providerCalls(s.deps)).toEqual([]);
    expect(s.engine.calls.filter((c) => c.startsWith("plan"))).toEqual(["plan:destroy"]);
    expect(s.engine.applied).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("falls back to the name when the plan does not say the id and exactly one Droplet has it", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES, serverId: null },
      env: DO_ENV,
    });
    s.servers.servers = [
      { id: "1111111", name: "shop-old", status: "active" },
      { id: "3164444", name: "shop", status: "active" },
    ];
    const result = await runDestroy(s.deps, { services: s.services });
    expect(s.servers.snapshots.map((snapshot) => snapshot.serverId)).toEqual(["3164444"]);
    expect(result.destroyed).toEqual(DO_RESOURCES);
  });

  it("stops when the destroy plan deletes another Droplet than the confirmed one", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    const error = await runDestroy(s.deps, {
      services: s.services,
      confirm: async () => {
        // the Droplet is recreated between the preview and the destroy plan
        (s.engine.script as DestroyScript).serverId = "9999999";
        return true;
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect((error as OpsCrewError).message).toContain(
      "The teardown plan now deletes a Droplet other than the one you confirmed (id 3164444)",
    );
    expect((error as OpsCrewError).message).toContain("Nothing was deleted.");
    expect((error as OpsCrewError).message).not.toContain("protection");
    expect((error as OpsCrewError).hint).not.toContain("protection");
    expect(s.servers.snapshots.map((snapshot) => snapshot.serverId)).toEqual(["3164444"]);
    expect(s.engine.applied).toEqual([]);
    expect(s.handler.requests).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("keeps reporting the snapshot when an earlier run already deleted the Droplet", async () => {
    let removeSecrets = false;
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
      answer: (request) => request.kind !== "github-secrets" || removeSecrets,
    });
    // First run: snapshot, Droplet deleted, then the secret cleanup is refused
    await expect(runDestroy(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("The infrastructure is deleted."),
    });
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["destroy"]);

    // Second run: the Droplet is gone, the snapshot it left is still reported
    s.servers.servers = [];
    removeSecrets = true;
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBe("6372321");
    expect(result.destroyed).toEqual([]);
    expect(s.servers.snapshots).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain(
      "The snapshot taken by the earlier run is kept (DigitalOcean snapshot 6372321).",
    );
    expect(result.remaining.join("\n")).toContain(
      "The snapshot of shop (DigitalOcean snapshot 6372321)",
    );
    expect(s.deps.audit.entries.filter((e) => e.kind === "phase").at(-1)?.detail).toContain(
      "DigitalOcean snapshot 6372321 kept",
    );
    expect(existsSync(snapshotRecord(s.deps))).toBe(false);
  });

  it("a failed lookup does not block deleting what is left when the teardown keeps no Droplet", async () => {
    const left = deployedResources({ provider: "digitalocean", server: false });
    const s = await setup({ plan: digitalOceanPlan(), script: { resources: left }, env: DO_ENV });
    s.servers.lookupError = new OpsCrewError(
      "PROVIDER_ERROR",
      "Could not reach the DigitalOcean API (GET /v2/droplets).",
    );
    const result = await runDestroy(s.deps, { services: s.services });
    expect(result.snapshotId).toBeUndefined();
    expect(result.destroyed).toEqual(left);
    expect(s.servers.lookups).toEqual(["shop"]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["destroy"]);
    const text = s.deps.reporter.text();
    expect(text).toContain(
      "No snapshot: the teardown does not delete the Droplet shop, so no snapshot is taken.",
    );
    expect(text).not.toContain("Could not reach");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBe(NOW);
  });

  it("a failed lookup still stops the run when the teardown deletes the Droplet", async () => {
    const s = await setup({
      plan: digitalOceanPlan(),
      script: { resources: DO_RESOURCES },
      env: DO_ENV,
    });
    s.servers.lookupError = new OpsCrewError(
      "PROVIDER_ERROR",
      "Could not reach the DigitalOcean API (GET /v2/droplets).",
    );
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "The snapshot of shop failed: Could not reach the DigitalOcean API (GET /v2/droplets). Nothing was deleted.",
    });
    expect(s.engine.applied).toEqual([]);
    await expectNothingCleanedUp(s);
  });

  it("does not report another provider's recorded snapshot after the Droplet is gone", async () => {
    const left = deployedResources({ provider: "digitalocean", server: false });
    const s = await setup({ plan: digitalOceanPlan(), script: { resources: left }, env: DO_ENV });
    s.servers.servers = [];
    await writeSnapshotRecord(s.deps, { serverId: 4711, imageId: 9001 });
    const result = await runDestroy(s.deps, { services: s.services, snapshot: false });
    expect(result.snapshotId).toBeUndefined();
    expect(result.remaining.join("\n")).not.toContain("snapshot");
  });

  it("never prints the DigitalOcean token (real connectors over a fake network)", async () => {
    const requests: { method: string; url: string; auth: string | null; body?: string }[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    let snapshotName: string | undefined;
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        method,
        url: url.toString(),
        auth: new Headers(init?.headers).get("authorization"),
        ...(body === undefined ? {} : { body }),
      });
      if (url.hostname === "api.digitalocean.com") {
        if (url.pathname === "/v2/account") {
          return json({
            account: { status: "active", email_verified: true, team: { name: "Acme" } },
          });
        }
        if (url.pathname === "/v2/droplets" && method === "GET") {
          return json({
            droplets: [
              {
                id: 3164444,
                name: "shop",
                status: "active",
                tags: ["opscrew-app:shop", "managed-by:opscrew"],
              },
            ],
            links: {},
            meta: { total: 1 },
          });
        }
        if (url.pathname === "/v2/droplets/3164444/actions" && method === "POST") {
          snapshotName = (JSON.parse(body ?? "{}") as { name?: string }).name;
          return json(
            {
              action: {
                id: 36805022,
                status: "in-progress",
                type: "snapshot",
                started_at: "2026-10-11T12:00:00Z",
              },
            },
            201,
          );
        }
        if (url.pathname === "/v2/actions/36805022") {
          return json({
            action: {
              id: 36805022,
              status: "completed",
              type: "snapshot",
              started_at: "2026-10-11T12:00:00Z",
              completed_at: "2026-10-11T12:04:00Z",
            },
          });
        }
        if (url.pathname === "/v2/droplets/3164444/snapshots") {
          return json({
            snapshots: [{ id: 6372321, name: snapshotName, created_at: "2026-10-11T12:00:05Z" }],
            links: {},
            meta: { total: 1 },
          });
        }
      }
      if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/user/tokens/verify")) {
        return json({ success: true, errors: [], result: { status: "active" } });
      }
      if (url.hostname === "api.github.com" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request in a test: ${method} ${url}`);
    };

    const s = await setup({
      plan: digitalOceanPlan({ domain: "shop.example.com" }),
      script: { resources: deployedResources({ provider: "digitalocean", dns: true }) },
      env: { ...DO_ENV, CLOUDFLARE_API_TOKEN: CLOUDFLARE, GITHUB_TOKEN: GITHUB },
    });
    s.deps.fetch = fetch;
    const services: DestroyServices = {
      engine: s.services.engine as NonNullable<DestroyServices["engine"]>,
      sleep: async () => undefined,
    };
    const result = await runDestroy(s.deps, { services });

    expect(result.snapshotId).toBe("6372321");
    expect(result.secretsRemoved).toEqual(SECRET_NAMES);
    expect(snapshotName).toBe(SNAPSHOT_NAME);
    // Only DigitalOcean was asked about the server; the token only went into Authorization headers
    expect(requests.some((r) => r.url.includes("hetzner"))).toBe(false);
    expect(requests.some((r) => r.auth === `Bearer ${DIGITALOCEAN}`)).toBe(true);
    expect(requests.find((r) => r.url.includes("/v2/droplets?"))?.url).toContain(
      "tag_name=opscrew-app%3Ashop",
    );
    expect(
      requests.every((r) => !r.url.includes(DIGITALOCEAN) && !r.body?.includes(DIGITALOCEAN)),
    ).toBe(true);

    const printed = [
      s.deps.reporter.text(),
      JSON.stringify(s.deps.audit.entries),
      JSON.stringify(s.handler.requests),
      result.remaining.join("\n"),
      await readFile(s.deps.paths.files.plan, "utf8"),
    ].join("\n");
    for (const secret of [DIGITALOCEAN, CLOUDFLARE, GITHUB]) {
      expect(printed).not.toContain(secret);
    }
    // No "NAME_TOKEN:" anywhere, which a reader (or a redactor) could take for an assignment
    expect(printed).not.toMatch(/[A-Z][A-Z0-9_]*_TOKEN\s*:/);
  });
});
