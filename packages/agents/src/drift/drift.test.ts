import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID } from "@opscrew/connector-cloudflare/testing";
import type {
  IacApplyResult,
  IacEngine,
  IacEngineName,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  ResourceChange,
  ResourceDrift,
} from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderDeployment } from "@opscrew/iac-templates";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { RootEngine, withBucket } from "../provision/__fixtures__/storage";
import { deploymentRenderContext } from "../provision/render";
import { STORAGE_KEY_VARS, storageStateFile } from "../provision/storage";
import type { ProvisionServices } from "../provision/types";
import { ensureDeployKey, ensureStatePassphrase, writeRenderedFiles } from "../shared";
import {
  CF_V4,
  CF_V6,
  createProject,
  createTestPhaseDeps,
  fakeCloudflare,
  movingPlan,
  plainStateResources,
  projectRunner,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import { driftNextSteps, renderDriftReport } from "./render";
import { runDrift } from "./run";
import {
  mergeAttributes,
  readOnlyAttributes,
  SCHEMA_UNREADABLE_NOTE,
  withoutIgnored,
} from "./schema";
import type { DriftReport } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
const HCLOUD_PROVIDER = "registry.opentofu.org/hetznercloud/hcloud";

const FIREWALL = "module.server.hcloud_firewall.this";
const SERVER = "module.server.hcloud_server.this";
const DO_DROPLET = "module.server.digitalocean_droplet.this";
const DO_FIREWALL = "module.server.digitalocean_firewall.this";
const DO_TAG = "module.server.digitalocean_tag.this";
const DNS_RECORD = "module.dns.cloudflare_dns_record.app";
const WAF = "module.dns.cloudflare_ruleset.waf";

/** Excerpts of a recorded `tofu providers schema -json` (hcloud, digitalocean, cloudflare). */
const RECORDED_SCHEMAS: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__", "providers-schema.json"), "utf8"),
);

function resource(address: string) {
  const parts = address.split(".");
  return {
    address,
    type: parts[parts.length - 2] ?? "",
    name: parts[parts.length - 1] ?? "",
    provider: HCLOUD_PROVIDER,
  };
}

const change = (address: string, action: ResourceChange["action"]): ResourceChange => ({
  ...resource(address),
  action,
});

const drifted = (
  address: string,
  action: ResourceDrift["action"],
  attributes: string[] = [],
): ResourceDrift => ({ ...resource(address), action, attributes });

interface PlanCall {
  planFile: string;
  refreshOnly: boolean;
  env: IacRunOptions["env"];
}

interface DriftScenario {
  name?: IacEngineName;
  drift?: ResourceDrift[];
  pending?: ResourceChange[];
  /** Throw (after writing the plan file) from the refresh-only or the normal plan. */
  failOn?: "refresh" | "plan";
  /**
   * What `providerSchemas` returns (default: the recorded excerpts); `fail` throws like a failed
   * command.
   */
  schemas?: unknown;
}

/** Engine fake for drift: scripted refresh-only and normal plans; `apply` is a test failure. */
class DriftEngine implements IacEngine {
  readonly info;
  readonly calls: string[] = [];
  readonly plans: PlanCall[] = [];
  readonly schemaCalls: { dir: string; env: IacRunOptions["env"] }[] = [];
  initOptions: IacInitOptions | undefined;
  readonly stateResources = plainStateResources;
  async untaint(): Promise<void> {}
  async importResource(): Promise<void> {}

  constructor(readonly scenario: DriftScenario = {}) {
    const name = scenario.name ?? "tofu";
    this.info = { name, version: "1.13.1", binary: `/fake/${name}` };
  }

  async providerSchemas(dir: string, options?: IacRunOptions): Promise<unknown> {
    this.calls.push("providers-schema");
    this.schemaCalls.push({ dir, env: options?.env });
    if (this.scenario.schemas === "fail") {
      throw new OpsCrewError("ENGINE_FAILED", "OpenTofu providers schema failed (exit code 1).");
    }
    return this.scenario.schemas === undefined ? RECORDED_SCHEMAS : this.scenario.schemas;
  }

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    this.initOptions = options;
  }

  async validate() {
    this.calls.push("validate");
    return { valid: true, diagnostics: [] };
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { destroy?: boolean; refreshOnly?: boolean } = {},
  ): Promise<PlanSummary> {
    const refreshOnly = options.refreshOnly === true;
    this.calls.push(refreshOnly ? "plan:refresh-only" : "plan");
    this.plans.push({ planFile, refreshOnly, env: options.env });
    await writeFile(planFile, `fake ${refreshOnly ? "refresh" : "normal"} plan`);
    if (this.scenario.failOn === (refreshOnly ? "refresh" : "plan")) {
      throw new OpsCrewError("ENGINE_FAILED", "Planning failed: provider exploded.");
    }
    const changes = refreshOnly ? [] : (this.scenario.pending ?? []);
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    const drift = refreshOnly ? (this.scenario.drift ?? []) : [];
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: "0".repeat(64),
      createdAt: "2026-10-11T12:00:00.000Z",
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson: {},
      ...(drift.length > 0 ? { drift } : {}),
    };
  }

  async apply(): Promise<IacApplyResult> {
    this.calls.push("apply");
    throw new Error("drift must never apply");
  }

  async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return {};
  }
}

type StateKind = "encrypted" | "plain" | "empty-resources" | "zero-bytes" | "none";

function stateContent(kind: StateKind): string | undefined {
  switch (kind) {
    case "encrypted":
      return JSON.stringify({
        serial: 3,
        lineage: "lineage-1",
        meta: { "key_provider.pbkdf2.opscrew": "e30=" },
        encrypted_data: "AAAA",
        encryption_version: "v0",
      });
    case "plain":
      return JSON.stringify({
        version: 4,
        terraform_version: "1.13.1",
        serial: 3,
        lineage: "lineage-1",
        outputs: {},
        resources: [
          { mode: "managed", module: "module.server", type: "hcloud_server", name: "this" },
        ],
      });
    case "empty-resources":
      return JSON.stringify({ version: 4, serial: 1, lineage: "lineage-1", resources: [] });
    case "zero-bytes":
      return "";
    case "none":
      return undefined;
  }
}

interface SetupOptions {
  plan?: ReturnType<typeof testPlan>;
  engine?: DriftEngine;
  state?: StateKind;
  services?: ProvisionServices;
  passphrase?: boolean;
  env?: Record<string, string | undefined>;
}

async function setup(options: SetupOptions = {}) {
  const plan = options.plan ?? testPlan({ deployed: true });
  const project = await createProject(plan);
  const handler = new ScriptedApprovalHandler(() => true);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    ...options.env,
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const passphrase =
    options.passphrase === false ? undefined : await ensureStatePassphrase(deps.paths);

  // What `opscrew provision` left behind: the rendered files and the state.
  const deployKey = await ensureDeployKey(deps.paths, deps.redactor);
  // Matches what provision learns from `fakeCloudflare()` for a Cloudflare plan.
  const cloudflare =
    plan.dns.provider === "cloudflare"
      ? {
          zoneId: FAKE_ZONE_ID,
          zoneName: "example.com",
          accountId: FAKE_ACCOUNT_ID,
          ipRanges: { ipv4: CF_V4, ipv6: CF_V6 },
        }
      : undefined;
  const rendered = cloudflare ? { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } } : plan;
  const files = renderDeployment(
    rendered,
    await deploymentRenderContext(deps, {
      plan: rendered,
      requirements: undefined,
      github: { owner: "acme", repo: "shop" },
      deployPublicKey: deployKey.publicKeyOpenSsh,
      cloudflare,
    }),
  );
  await writeRenderedFiles(project.root, files);
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  const content = stateContent(options.state ?? "encrypted");
  if (content !== undefined) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, content);
  }

  const engine = options.engine ?? new DriftEngine();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    ...options.services,
  };
  return { ...project, deps, engine, handler, services, statePath, passphrase };
}

async function driftPlanFiles(plansDir: string): Promise<string[]> {
  try {
    return (await readdir(plansDir)).filter((name) => name.startsWith("drift-"));
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))("runDrift", () => {
  it("checks the app's bucket in its own root and state: a bucket deleted in the console is drift", async () => {
    const key = {
      [STORAGE_KEY_VARS.accessKeyId]: fakeSecret("aws-access-key-id", "drift"),
      [STORAGE_KEY_VARS.secretAccessKey]: fakeSecret("aws-secret-access-key", "drift"),
    };
    const bucketEngine = new DriftEngine({
      drift: [drifted("aws_s3_bucket.this", "delete")],
      pending: [change("aws_s3_bucket.this", "create")],
    });
    const main = new DriftEngine();
    const engine = new RootEngine(main, bucketEngine);
    const { deps, services } = await setup({
      plan: withBucket(testPlan({ deployed: true }), "hetzner"),
      services: { engine: async () => engine },
      env: key,
    });
    await writeFile(storageStateFile(deps.paths), stateContent("plain") ?? "");
    const report = await runDrift(deps, { services });
    expect(report.drift).toEqual([
      expect.objectContaining({ address: "aws_s3_bucket.this", action: "delete" }),
    ]);
    expect(report.pending.map((p) => p.address)).toEqual(["aws_s3_bucket.this"]);
    expect(bucketEngine.initOptions?.backendConfig?.path).toBe(storageStateFile(deps.paths));
    for (const call of bucketEngine.plans) {
      expect(call.env?.AWS_SECRET_ACCESS_KEY).toBe(key[STORAGE_KEY_VARS.secretAccessKey]);
    }
    expect(report.clean).toBe(false);
    expect(await driftPlanFiles(deps.paths.files.plansDir)).toEqual([]);
  });

  it("ignores the bucket's inline copy of the CORS rule its own resource manages", async () => {
    // A fresh Hetzner bucket refreshed: the provider copies the CORS configuration into
    // aws_s3_bucket.cors_rule ([] before). A CORS rule changed in the console still shows.
    const bucketEngine = new DriftEngine({
      drift: [
        drifted("aws_s3_bucket.this", "update", ["cors_rule"]),
        drifted("aws_s3_bucket_cors_configuration.this", "update", ["cors_rule"]),
      ],
    });
    const engine = new RootEngine(new DriftEngine(), bucketEngine);
    const { deps, services } = await setup({
      plan: withBucket(testPlan({ deployed: true }), "hetzner"),
      services: { engine: async () => engine },
      env: {
        [STORAGE_KEY_VARS.accessKeyId]: fakeSecret("aws-access-key-id", "drift"),
        [STORAGE_KEY_VARS.secretAccessKey]: fakeSecret("aws-secret-access-key", "drift"),
      },
    });
    await writeFile(storageStateFile(deps.paths), stateContent("plain") ?? "");
    const report = await runDrift(deps, { services });
    expect(report.drift).toEqual([
      drifted("aws_s3_bucket_cors_configuration.this", "update", ["cors_rule"]),
    ]);
  });

  it("reports a clean deployment without applying or leaving plan files behind", async () => {
    const { deps, engine, handler, services, statePath } = await setup();
    const report = await runDrift(deps, { services });

    expect(report).toEqual({
      drift: [],
      pending: [],
      files: { changed: [], created: [] },
      foreignDnsRecords: [],
      clean: true,
      engine: engine.info,
      checkedAt: "2026-10-11T12:00:00.000Z",
      provider: "hetzner",
    });
    expect(engine.calls).toEqual(["init", "plan:refresh-only", "plan"]);
    expect(engine.calls).not.toContain("apply");
    expect(engine.initOptions?.backendConfig?.path).toBe(statePath);
    for (const call of engine.plans) {
      expect(dirname(call.planFile)).toBe(deps.paths.files.plansDir);
      expect(basename(call.planFile)).toMatch(/^drift-.+\.tfplan$/);
      expect(call.env?.TF_ENCRYPTION).toContain("pbkdf2");
    }
    expect(new Set(engine.plans.map((p) => p.planFile)).size).toBe(2);
    expect(await readdir(deps.paths.files.plansDir)).toEqual([]);
    expect(handler.requests).toEqual([]);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "iac", actor: "opscrew", action: "drift-check" }),
    ]);

    const text = renderDriftReport(report);
    expect(text).toContain("matches the plan");
    expect(text).not.toContain("changed outside OpsCrew");
  });

  it("names a firewall changed outside OpsCrew and its attribute, and explains both choices", async () => {
    const engine = new DriftEngine({
      drift: [drifted(FIREWALL, "update", ["rule"])],
      pending: [change(FIREWALL, "update")],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });

    expect(report.clean).toBe(false);
    expect(report.drift).toEqual([drifted(FIREWALL, "update", ["rule"])]);
    expect(report.pending).toEqual([change(FIREWALL, "update")]);
    expect(engine.calls).not.toContain("apply");

    const text = renderDriftReport(report);
    expect(text).toContain("changed outside OpsCrew");
    expect(text).toContain(FIREWALL);
    expect(text).toMatch(/hcloud_firewall\.this.*rule/);
    expect(text).toContain("`opscrew provision` would undo");
    expect(text).toContain("opscrew/plan.yaml");
  });

  it("ignores the firewall attachment Hetzner mirrors into apply_to, but not other firewall changes", async () => {
    // Found by the first real run: the server attaches the firewall (firewall_ids) and Hetzner
    // reports it back on the firewall's apply_to, so every refresh saw a change nobody made.
    const mirrored = new DriftEngine({
      drift: [drifted(FIREWALL, "update", ["apply_to"])],
      pending: [],
    });
    const clean = await setup({ engine: mirrored });
    const report = await runDrift(clean.deps, { services: clean.services });
    expect(report.drift).toEqual([]);
    expect(report.clean).toBe(true);

    const mixed = new DriftEngine({
      drift: [drifted(FIREWALL, "update", ["apply_to", "rule"])],
      pending: [change(FIREWALL, "update")],
    });
    const changed = await setup({ engine: mixed });
    const second = await runDrift(changed.deps, { services: changed.services });
    expect(second.drift).toEqual([drifted(FIREWALL, "update", ["rule"])]);
    expect(second.clean).toBe(false);
  });

  it("ignores values the cloud maintains itself (read-only in the provider schema)", async () => {
    // Found by the first real runs: counts, status and timestamps change without anyone
    // touching the console, so every refresh reported them as drift.
    const engine = new DriftEngine({
      drift: [
        drifted(SERVER, "update", ["backup_window", "status"]),
        drifted(FIREWALL, "update", ["apply_to"]),
        drifted(DNS_RECORD, "update", [
          "comment_modified_on",
          "meta",
          "modified_on",
          "tags_modified_on",
        ]),
        drifted(WAF, "update", ["last_updated", "version"]),
      ],
      pending: [],
    });
    const { deps, services, root } = await setup({ engine });
    const report = await runDrift(deps, { services });

    expect(report.drift).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.notes).toBeUndefined();
    expect(engine.calls).toEqual(["init", "plan:refresh-only", "providers-schema", "plan"]);
    expect(engine.schemaCalls.map((call) => call.dir)).toEqual([
      join(root, "opscrew", "infra", "prod"),
    ]);
    expect(engine.schemaCalls[0]?.env?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(renderDriftReport(report)).toContain("matches the plan");
  });

  it("ignores DigitalOcean tag counts, firewall status and droplet prices", async () => {
    const token = fakeSecret("digitalocean-token", "drift-schema");
    const engine = new DriftEngine({
      drift: [
        drifted(DO_TAG, "update", ["droplets_count", "total_resource_count"]),
        drifted(DO_FIREWALL, "update", ["created_at", "pending_changes", "status"]),
        drifted(DO_DROPLET, "update", ["locked", "price_hourly", "price_monthly", "status"]),
      ],
      pending: [],
    });
    const { deps, services } = await setup({
      plan: testPlan({ deployed: true, provider: "digitalocean" }),
      engine,
      env: { HCLOUD_TOKEN: undefined, DIGITALOCEAN_TOKEN: token },
    });
    const report = await runDrift(deps, { services });
    expect(report.drift).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("still reports real changes next to read-only values, and deletes", async () => {
    const engine = new DriftEngine({
      drift: [
        drifted(SERVER, "update", ["firewall_ids", "status"]),
        drifted(DO_DROPLET, "update", ["price_monthly", "size"]),
        drifted(DO_FIREWALL, "update", ["inbound_rule", "pending_changes"]),
        drifted(WAF, "update", ["last_updated", "rules", "version"]),
        drifted(DNS_RECORD, "update", ["content", "modified_on"]),
        drifted(DO_TAG, "delete"),
      ],
      pending: [change(SERVER, "update")],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });

    expect(report.drift).toEqual([
      drifted(DNS_RECORD, "update", ["content"]),
      drifted(WAF, "update", ["rules"]),
      drifted(DO_DROPLET, "update", ["size"]),
      drifted(DO_FIREWALL, "update", ["inbound_rule"]),
      drifted(DO_TAG, "delete"),
      drifted(SERVER, "update", ["firewall_ids"]),
    ]);
    expect(report.clean).toBe(false);
    expect(report.notes).toBeUndefined();
    const text = renderDriftReport(report);
    expect(text).toContain(`${DO_TAG} no longer exists`);
    expect(text).toMatch(/hcloud_server\.this: firewall_ids changed/);
    expect(text).not.toContain("provider schemas");
  });

  it("sorts the report once: resources by address with their attribute names, files by path", async () => {
    const engine = new DriftEngine({
      drift: [
        drifted(SERVER, "update", ["labels", "delete_protection"]),
        drifted(FIREWALL, "update", ["rule"]),
      ],
      pending: [change(SERVER, "update"), change(FIREWALL, "update")],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });
    expect(report.drift).toEqual([
      drifted(FIREWALL, "update", ["rule"]),
      drifted(SERVER, "update", ["delete_protection", "labels"]),
    ]);
    expect(report.pending).toEqual([change(FIREWALL, "update"), change(SERVER, "update")]);
  });

  it.each([
    ["the schema command fails", "fail"],
    ["the schema has an unexpected shape", { provider_schemas: "nope" }],
  ])("reports everything as before with a plain note when %s", async (_, schemas) => {
    const engine = new DriftEngine({
      schemas,
      drift: [
        drifted(SERVER, "update", ["status"]),
        drifted(FIREWALL, "update", ["apply_to", "rule"]),
      ],
      pending: [change(FIREWALL, "update")],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });

    // The mirrored attachment is still ignored: that list does not need the schema.
    expect(report.drift).toEqual([
      drifted(FIREWALL, "update", ["rule"]),
      drifted(SERVER, "update", ["status"]),
    ]);
    expect(report.notes).toEqual([SCHEMA_UNREADABLE_NOTE]);
    expect(report.clean).toBe(false);
    const text = renderDriftReport(report);
    expect(text).toContain(SCHEMA_UNREADABLE_NOTE);
    expect(text).toMatch(/hcloud_server\.this: status changed/);
    expect(engine.calls).not.toContain("apply");
  });

  it("adds no note when the schema is unreadable but only mirrored values changed", async () => {
    const engine = new DriftEngine({
      schemas: "fail",
      drift: [drifted(FIREWALL, "update", ["apply_to"])],
      pending: [],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });
    expect(report.drift).toEqual([]);
    expect(report.notes).toBeUndefined();
    expect(report.clean).toBe(true);
  });

  it("reports a server deleted outside OpsCrew", async () => {
    const engine = new DriftEngine({
      drift: [drifted(SERVER, "delete")],
      pending: [change(SERVER, "create")],
    });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });

    expect(report.drift).toEqual([drifted(SERVER, "delete")]);
    expect(report.pending).toEqual([change(SERVER, "create")]);
    expect(engine.calls).not.toContain("providers-schema");
    const text = renderDriftReport(report);
    expect(text).toContain(`${SERVER} no longer exists`);
    expect(text).toMatch(/create\s+module\.server\.hcloud_server\.this/);
  });

  describe("the app's components on the server, once deployed (FR-1331)", () => {
    /** The deployed plan with a worker and MySQL, after a deploy `opscrew verify` saw. */
    function deployedPlan(provider: "hetzner" | "digitalocean" = "hetzner") {
      const base = testPlan({ deployed: true, provider });
      return DeployPlanSchema.parse({
        ...base,
        deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
        processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
        services: [
          ...base.services,
          { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
        ],
      });
    }
    /** The deploy user's shell, answering `docker ps` with `lines`. */
    function server(lines: string[], exitCode = 0) {
      const hosts: string[] = [];
      const remote = (host: string): RemoteExec => {
        hosts.push(host);
        return {
          host,
          run: async () => ({ exitCode, stdout: lines.join("\n"), stderr: "" }),
        };
      };
      return { remote, hosts };
    }

    it("a component without its container, a stray one and a stopped one are reported, with the server read through status's SSH read", async () => {
      const ssh = server([
        "shop-app-1|running",
        "shop-worker-1|exited",
        "shop-db-1|running",
        "shop-cache-1|running",
      ]);
      const { deps, services } = await setup({
        plan: deployedPlan("digitalocean"),
        services: { remote: ssh.remote },
      });
      const report = await runDrift(deps, { services });
      expect(ssh.hosts).toEqual([SERVER_IPV4]);
      expect(report.host?.differences.map((d) => `${d.title}: ${d.detail}`)).toEqual([
        "The app's components: MySQL (mysql) is in opscrew/plan.yaml but has no container on the server. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it starts every component.",
        "The app's components: cache runs on the server but is not a component in opscrew/plan.yaml any more (turned off or removed there): the next deploy removes it.",
        "The app's containers: shop-worker-1 is stopped.",
      ]);
      expect(report.clean).toBe(false);
      const text = renderDriftReport(report);
      expect(text).toContain("Your server differs from what OpsCrew set up (3).");
      expect(text).not.toContain(SERVER_IPV4);
      expect(driftNextSteps(report)).toContain(
        "for the app's containers on the server, follow the step the report gives with each.",
      );
    });

    it("every component running is clean; before a deploy was seen, the server is not read", async () => {
      const running = server([
        "shop-app-1|running",
        "shop-worker-1|running",
        "shop-db-1|running",
        "shop-mysql-1|running",
      ]);
      const deployed = await setup({
        plan: deployedPlan(),
        services: { remote: running.remote },
      });
      const report = await runDrift(deployed.deps, { services: deployed.services });
      expect(report.host).toEqual({ differences: [] });
      expect(report.clean).toBe(true);

      const unread = server([]);
      const fresh = await setup({ services: { remote: unread.remote } });
      expect((await runDrift(fresh.deps, { services: fresh.services })).host).toBeUndefined();
      expect(unread.hosts).toEqual([]);
    });

    it("a server it cannot read is a note, and the rest of the report stands", async () => {
      const ssh = server([], 255);
      const engine = new DriftEngine({ drift: [drifted(SERVER, "delete")] });
      const { deps, services } = await setup({
        plan: deployedPlan(),
        engine,
        services: { remote: ssh.remote },
      });
      const report = await runDrift(deps, { services });
      expect(report.host).toBeUndefined();
      expect(report.drift).toEqual([drifted(SERVER, "delete")]);
      expect(report.notes).toEqual([
        expect.stringContaining(
          "OpsCrew could not compare the app's components on the server. OpsCrew could not read the app's containers on the server over SSH (exit code 255).",
        ),
      ]);
    });
  });

  it("reports pending changes in the code that were never applied", async () => {
    const engine = new DriftEngine({ pending: [change(SERVER, "update")] });
    const { deps, services } = await setup({ engine });
    const report = await runDrift(deps, { services });

    expect(report).toMatchObject({ drift: [], pending: [change(SERVER, "update")], clean: false });
    const text = renderDriftReport(report);
    expect(text).toContain("not applied yet");
    expect(text).toMatch(/update\s+module\.server\.hcloud_server\.this/);
    expect(text).not.toContain("changed outside OpsCrew");
  });

  it("lists infrastructure files edited by hand or missing", async () => {
    const { deps, services, root } = await setup();
    const mainTf = join(root, "opscrew", "infra", "prod", "main.tf");
    await writeFile(mainTf, `${await readFile(mainTf, "utf8")}\n# hand edit\n`);
    await rm(join(root, "opscrew", "runtime", "edge", "sites", "shop.caddy"));

    const report = await runDrift(deps, { services });
    expect(report.files).toEqual({
      changed: ["opscrew/infra/prod/main.tf"],
      created: ["opscrew/runtime/edge/sites/shop.caddy"],
    });
    expect(report.clean).toBe(false);
    const text = renderDriftReport(report);
    expect(text).toMatch(/changed\s+opscrew\/infra\/prod\/main\.tf/);
    expect(text).toMatch(/missing\s+opscrew\/runtime\/edge\/sites\/shop\.caddy/);
  });

  it("refuses without the state file and explains where it lives", async () => {
    const { deps, engine, services } = await setup({ state: "none" });
    const error = await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
    expect(error.message).toContain(".opscrew/tfstate");
    expect(error.hint).toMatch(/copy/i);
    expect(engine.calls).toEqual([]);
    expect(await driftPlanFiles(deps.paths.files.plansDir)).toEqual([]);
  });

  it.each(["zero-bytes", "empty-resources"] as const)(
    "never plans against empty state (%s)",
    async (state) => {
      const { deps, engine, services } = await setup({ state });
      await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
      expect(engine.calls).toEqual([]);
    },
  );

  it("refuses while a move to another provider is in progress, before any check", async () => {
    const { deps, engine, services } = await setup();
    await writeArtifact("plan", deps.paths.files.plan, movingPlan("created"));
    const error = await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
    expect(error.message).toBe("A move to DigitalOcean is in progress.");
    expect(error.hint).toBe(
      "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
    );
    expect(engine.calls).toEqual([]);
    expect(deps.reporter.lines).toEqual([]);
    expect(deps.audit.entries).toEqual([]);
    expect(await driftPlanFiles(deps.paths.files.plansDir)).toEqual([]);
  });

  it("refuses when nothing is deployed", async () => {
    const { deps, engine, services } = await setup({ plan: testPlan() });
    const error = await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew provision");
    expect(engine.calls).toEqual([]);
  });

  it("explains the engine mismatch when Terraform meets OpenTofu-encrypted state", async () => {
    const engine = new DriftEngine({ name: "terraform" });
    const { deps, services } = await setup({ engine });
    const error = await expectError(
      runDrift(deps, { services, engine: "terraform" }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toContain("OpenTofu");
    expect(error.message).toContain("Terraform");
    expect(error.hint).toContain("--engine tofu");
    expect(engine.calls).not.toContain("plan");
  });

  it("works with Terraform and plain state", async () => {
    const engine = new DriftEngine({ name: "terraform" });
    const plan = testPlan({ deployed: true });
    const { deps, services } = await setup({
      engine,
      state: "plain",
      plan: { ...plan, infra: { ...plan.infra, engine: "terraform", stateEncryption: false } },
    });
    const report = await runDrift(deps, { services });
    expect(report.clean).toBe(true);
    for (const call of engine.plans) expect(call.env?.TF_ENCRYPTION).toBeUndefined();
  });

  it("asks for the state passphrase instead of creating a new one", async () => {
    const { deps, engine, services } = await setup({ passphrase: false });
    const error = await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
    expect(error.hint).toContain(deps.paths.files.statePassphrase);
    expect(error.hint).toContain("then run `opscrew drift` again.");
    expect(await exists(deps.paths.files.statePassphrase)).toBe(false);
    expect(engine.calls).not.toContain("plan");
  });

  it.each(["refresh", "plan"] as const)(
    "deletes the drift plan files when the %s step fails",
    async (failOn) => {
      const engine = new DriftEngine({ failOn });
      const { deps, services } = await setup({ engine });
      await expectError(runDrift(deps, { services }), "ENGINE_FAILED");
      expect(engine.plans.length).toBeGreaterThan(0);
      expect(await readdir(deps.paths.files.plansDir)).toEqual([]);
      expect(engine.calls).not.toContain("apply");
    },
  );

  it("needs the Hetzner token", async () => {
    const { deps, engine, services } = await setup({
      services: {
        provider: { configured: false, verify: async () => ({ ok: true, message: "" }) },
      },
    });
    await expectError(runDrift(deps, { services }), "CREDENTIALS_MISSING");
    expect(engine.calls).toEqual([]);
  });

  it("needs the Cloudflare token when the plan uses Cloudflare", async () => {
    const { deps, engine, services } = await setup({
      plan: testPlan({ deployed: true, domain: "shop.example.com" }),
      services: { cloudflare: null },
    });
    await expectError(runDrift(deps, { services }), "CREDENTIALS_MISSING");
    expect(engine.calls).toEqual([]);
  });

  it("checks Cloudflare and renders with its zone when the token works", async () => {
    const cloudflare = fakeCloudflare();
    const { deps, services } = await setup({
      plan: testPlan({ deployed: true, domain: "shop.example.com" }),
      services: { cloudflare },
    });
    const report = await runDrift(deps, { services });
    expect(cloudflare.listed).toContain("shop.example.com");
    expect(report.files).toEqual({ changed: [], created: [] });
    expect(report.clean).toBe(true);
  });

  it("never creates a deploy key: without it on this computer the check stops", async () => {
    const { deps, services, engine } = await setup();
    await rm(deps.paths.files.deployKey, { force: true });
    await rm(deps.paths.files.deployKeyPub, { force: true });
    await expectError(runDrift(deps, { services }), "PHASE_PRECONDITION");
    expect(existsSync(deps.paths.files.deployKeyPub)).toBe(false);
    expect(engine.calls).not.toContain("apply");
  });

  it("reports DNS records someone added outside OpsCrew instead of stopping", async () => {
    const cloudflare = fakeCloudflare({
      records: [
        {
          id: "old",
          type: "A",
          name: "shop.example.com",
          content: "198.51.100.7",
          ttl: 1,
          proxied: false,
        },
      ],
    });
    const { deps, services, engine } = await setup({
      plan: testPlan({ deployed: true, domain: "shop.example.com" }),
      services: { cloudflare },
    });
    const report = await runDrift(deps, { services });
    expect(report.foreignDnsRecords).toEqual([
      { type: "A", name: "shop.example.com", content: "198.51.100.7" },
    ]);
    expect(report.clean).toBe(false);
    const text = renderDriftReport(report);
    expect(text).toContain("A shop.example.com 198.51.100.7");
    expect(text).toContain("did not create");
    expect(engine.calls).not.toContain("apply");
  });

  it("reports a DigitalOcean firewall changed in the DigitalOcean console", async () => {
    const token = fakeSecret("digitalocean-token", "drift");
    const firewall = "module.server.digitalocean_firewall.this";
    const engine = new DriftEngine({
      drift: [drifted(firewall, "update", ["inbound_rule"])],
      pending: [change(firewall, "update")],
    });
    const { deps, services } = await setup({
      plan: testPlan({ deployed: true, provider: "digitalocean" }),
      engine,
      env: { HCLOUD_TOKEN: undefined, DIGITALOCEAN_TOKEN: token },
    });
    const report = await runDrift(deps, { services });

    expect(report.provider).toBe("digitalocean");
    expect(report.clean).toBe(false);
    expect(report.drift).toEqual([drifted(firewall, "update", ["inbound_rule"])]);
    expect(report.files).toEqual({ changed: [], created: [] });
    expect(engine.calls).not.toContain("apply");
    const text = renderDriftReport(report);
    expect(text).toMatch(/digitalocean_firewall\.this.*inbound_rule/);
    expect(text).toContain("in the DigitalOcean or Cloudflare console");
    expect(text).not.toContain("Hetzner");
    expect(deps.reporter.text()).toContain("Checking your DigitalOcean access");
    const everything = [
      JSON.stringify(report),
      text,
      JSON.stringify(deps.audit.entries),
      deps.reporter.text(),
    ].join("\n");
    expect(everything).not.toContain(token);
  });

  it("never puts a secret value in the report, its text, the audit log or the output", async () => {
    const engine = new DriftEngine({
      drift: [drifted(FIREWALL, "update", ["rule"])],
      pending: [change(FIREWALL, "update")],
    });
    const { deps, services, passphrase } = await setup({ engine });
    const report = await runDrift(deps, { services });
    const everything = [
      JSON.stringify(report),
      renderDriftReport(report),
      JSON.stringify(deps.audit.entries),
      deps.reporter.text(),
    ].join("\n");
    expect(passphrase).toBeDefined();
    expect(everything).not.toContain(HCLOUD);
    expect(everything).not.toContain(passphrase as string);
  });
});

describe("read-only attributes from the provider schema", () => {
  it("derives computed attributes that are neither optional nor required", () => {
    const readOnly = readOnlyAttributes(RECORDED_SCHEMAS);
    expect(readOnly?.digitalocean_tag).toEqual(
      expect.arrayContaining(["droplets_count", "total_resource_count", "volumes_count"]),
    );
    expect(readOnly?.digitalocean_tag).not.toContain("name");
    expect(readOnly?.digitalocean_firewall).toEqual(["created_at", "pending_changes", "status"]);
    expect(readOnly?.digitalocean_droplet).toEqual(
      expect.arrayContaining(["locked", "price_hourly", "price_monthly", "status"]),
    );
    expect(readOnly?.digitalocean_droplet).not.toContain("size");
    expect(readOnly?.hcloud_server).toEqual(expect.arrayContaining(["backup_window", "status"]));
    // Optional and computed: OpsCrew sets it, so a change is real.
    expect(readOnly?.hcloud_server).not.toContain("firewall_ids");
    // apply_to is a block, so the mirrored list keeps it out of drift instead.
    expect(readOnly?.hcloud_firewall ?? []).not.toContain("apply_to");
    expect(readOnly?.cloudflare_dns_record).toEqual(
      expect.arrayContaining(["comment_modified_on", "meta", "modified_on", "tags_modified_on"]),
    );
    expect(readOnly?.cloudflare_dns_record).not.toContain("content");
    expect(readOnly?.cloudflare_ruleset).toEqual(
      expect.arrayContaining(["last_updated", "version"]),
    );
    expect(readOnly?.cloudflare_ruleset).not.toContain("rules");
  });

  it("accepts a document without providers and rejects one with a different shape", () => {
    expect(readOnlyAttributes({ format_version: "1.0" })).toEqual({});
    expect(readOnlyAttributes({ provider_schemas: [] })).toBeUndefined();
    expect(readOnlyAttributes("not a schema")).toBeUndefined();
  });

  it("keeps deletes and updates without named attributes, drops emptied updates", () => {
    const ignored = mergeAttributes(
      { hcloud_firewall: ["apply_to"] },
      { hcloud_server: ["status"], hcloud_firewall: ["apply_to"] },
    );
    expect(ignored).toEqual({ hcloud_firewall: ["apply_to"], hcloud_server: ["status"] });
    expect(
      withoutIgnored(
        [
          drifted(SERVER, "delete"),
          drifted(SERVER, "update", []),
          drifted(SERVER, "update", ["status"]),
          drifted(FIREWALL, "update", ["apply_to", "rule"]),
        ],
        ignored,
      ),
    ).toEqual([
      drifted(SERVER, "delete"),
      drifted(SERVER, "update", []),
      drifted(FIREWALL, "update", ["rule"]),
    ]);
  });
});

describe("renderDriftReport", () => {
  // As runDrift returns it: every list sorted.
  const base: DriftReport = {
    drift: [
      drifted(FIREWALL, "update", ["rule"]),
      drifted(SERVER, "update", ["delete_protection", "labels"]),
    ],
    pending: [change(FIREWALL, "update"), change(SERVER, "update")],
    files: { changed: ["opscrew/runtime/compose.yaml"], created: ["opscrew/infra/prod/main.tf"] },
    foreignDnsRecords: [],
    clean: false,
    engine: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
    checkedAt: "2026-10-11T12:00:00.000Z",
    provider: "hetzner",
  };

  it("lists the resources in the report's order and the files by path, edited and missing together", () => {
    const text = renderDriftReport(base);
    expect(text.indexOf(FIREWALL)).toBeLessThan(text.indexOf(SERVER));
    expect(text).toContain("delete_protection, labels");
    expect(text.indexOf("opscrew/infra/prod/main.tf")).toBeLessThan(
      text.indexOf("opscrew/runtime/compose.yaml"),
    );
  });

  it("names the deployment's provider console", () => {
    expect(renderDriftReport(base)).toContain("in the Hetzner Cloud or Cloudflare console");
    expect(renderDriftReport({ ...base, provider: "digitalocean" })).toContain(
      "in the DigitalOcean or Cloudflare console",
    );
  });

  it("names the engine and the time of the check", () => {
    const text = renderDriftReport(base);
    expect(text).toContain("OpenTofu 1.13.1");
    expect(text).toContain("2026-10-11T12:00:00.000Z");
  });

  it("prints the notes, also for a clean report", () => {
    const note = "OpsCrew could not read something.";
    expect(renderDriftReport({ ...base, notes: [note] })).toContain(note);
    const clean: DriftReport = {
      ...base,
      drift: [],
      pending: [],
      files: { changed: [], created: [] },
      clean: true,
      notes: [note],
    };
    expect(renderDriftReport(clean)).toContain(note);
    expect(renderDriftReport({ ...clean, notes: undefined })).not.toContain(note);
  });
});
