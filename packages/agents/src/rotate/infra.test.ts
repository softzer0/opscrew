// Feature 025 (T2511): the Cloudflare tokens, the state passphrase and the deploy key's object at
// the provider, each through an infrastructure plan approved by its hash (US8, FR-2511).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type {
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacInitOptions,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
  ResourceDrift,
} from "@opscrew/contracts";
import { exists, OpsCrewError, tfstateFile } from "@opscrew/core";
import { stateKeyName } from "@opscrew/iac-engine";
import { checkEnvironmentKey, storageRootDir } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PortainerStacksSetup } from "../provision/portainer-flow";
import type { GitHubApi } from "../provision/types";
import { projectEngine } from "../shared/engine";
import { recordPortainerConnection, updateServerAddresses } from "../shared/server-record";
import { everythingShown, gitRemote } from "../snapshot/__fixtures__/world";
import {
  createTestPhaseDeps,
  freshFacts,
  ownPlan,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
  testPlan,
  withBucket,
} from "../testing";
import type { VpnServices } from "../vpn/servers";
import {
  accessTokenAddress,
  replaceDeployKeyObject,
  rotateAccessToken,
  rotateStatePassphrase,
  rotateTunnelToken,
  tunnelModules,
} from "./infra";
import {
  portainerTunnelConnectors,
  type RotatedTunnel,
  type TunnelConnectors,
} from "./infra-connectors";
import { credentialsRecordFile } from "./record";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const ACCESS = "module.access.cloudflare_zero_trust_access_service_token.ssh[0]";
/** A Cloudflare Tunnel id, as the host plan checks it. */
const TUNNEL_ID = "0a1b2c3d-1111-4e5f-8a9b-abcdefabcdef";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** A value as OpsCrew makes one, at run time. */
const secret = () => randomBytes(32).toString("base64url");

function change(address: string, action: ResourceChange["action"], type?: string): ResourceChange {
  return {
    address,
    type: type ?? address.split(".").at(-2) ?? "",
    name: "this",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action,
  };
}

/** `TF_ENCRYPTION` read back: the method state is written with, its fallback, the passphrases. */
function encryption(value: string | undefined) {
  if (value === undefined) return undefined;
  const keys = new Map(
    [...value.matchAll(/key_provider "pbkdf2" "(\w+)" \{\n {2}passphrase = "([^"]*)"/g)].map(
      (match) => [match[1] as string, match[2] as string],
    ),
  );
  const state =
    /state \{\n {2}method = method\.aes_gcm\.(\w+)(?:\n {2}fallback \{\n {4}method = method\.aes_gcm\.(\w+))?/.exec(
      value,
    );
  return { primary: state?.[1] as string, fallback: state?.[2], keys };
}

/** An encrypted state as the fake engine writes it: the key's name in its meta, and a lock. */
function lockedState(name: string, passphrase: string): string {
  return JSON.stringify({
    serial: 3,
    meta: { [`key_provider.pbkdf2.${name}`]: "c2FsdA==" },
    encrypted_data: sha256(`${name}:${passphrase}`),
    encryption_version: "v0",
  });
}

/**
 * An OpenTofu that encrypts its state as `TF_ENCRYPTION` says: it opens a state with the method
 * of the key name the state's meta has, the primary or the fallback, and an apply writes it with
 * the primary. Plans write real files whose hash an apply checks; every call is recorded.
 */
class CryptEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly plans: {
    replace?: readonly string[];
    vars?: Record<string, string>;
    refreshOnly?: boolean;
    env?: string;
    dir: string;
  }[] = [];
  readonly applied: IacApproval[] = [];
  readonly calls: string[] = [];
  /** The environment of each plan. */
  readonly envs: Record<string, string | undefined>[] = [];
  statePath: string | undefined;
  #count = 0;
  /** The state each plan was made from, by the plan's hash: a plan the state outgrew is stale. */
  readonly #from = new Map<string, string | undefined>();

  private async stateText(): Promise<string | undefined> {
    return this.statePath === undefined
      ? undefined
      : readFile(this.statePath, "utf8").catch(() => undefined);
  }

  constructor(
    private readonly scenario: {
      changes?: ResourceChange[];
      planJson?: unknown;
      outputs?: Record<string, unknown>;
      /** What `output` reads from the state. */
      stateOutputs?: Record<string, unknown>;
      applyLog?: string;
      /** The apply goes through but writes the state with the fallback (a broken engine). */
      writesFallback?: boolean;
      /** Managed resources changed outside the engine, which each plan reports. */
      drift?: ResourceDrift[];
    } = {},
  ) {}

  private async opens(file: string, value: string | undefined): Promise<boolean> {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) return true;
    const state = JSON.parse(text) as { encrypted_data?: string };
    if (state.encrypted_data === undefined) return true;
    const enc = encryption(value);
    const name = stateKeyName(text);
    if (enc === undefined || (enc.primary !== name && enc.fallback !== name)) return false;
    return state.encrypted_data === sha256(`${name}:${enc.keys.get(name)}`);
  }

  async init(_dir: string, options?: IacInitOptions): Promise<void> {
    this.calls.push("init");
    this.statePath = options?.backendConfig?.path;
  }

  async validate() {
    return { valid: true, diagnostics: [] };
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { replace?: readonly string[]; refreshOnly?: boolean } = {},
  ): Promise<PlanSummary> {
    this.calls.push("plan");
    if (
      this.statePath !== undefined &&
      !(await this.opens(this.statePath, options.env?.TF_ENCRYPTION))
    ) {
      throw new OpsCrewError("ENGINE_FAILED", "OpenTofu could not decrypt the state.");
    }
    this.envs.push({ ...options.env });
    this.plans.push({
      dir,
      ...(options.replace !== undefined ? { replace: options.replace } : {}),
      ...(options.vars !== undefined ? { vars: options.vars } : {}),
      ...(options.refreshOnly !== undefined ? { refreshOnly: options.refreshOnly } : {}),
      ...(options.env?.TF_ENCRYPTION !== undefined ? { env: options.env.TF_ENCRYPTION } : {}),
    });
    const changes = this.scenario.changes ?? [];
    // As both engines: nothing to replace at an address the state lacks, so no plan.
    const missing = (options.replace ?? []).filter(
      (address) => !changes.some((c) => c.address === address && c.action === "replace"),
    );
    if (missing.length > 0) {
      throw new OpsCrewError("INVALID_INPUT", `The plan does not replace ${missing.join(", ")}.`);
    }
    const content = `fake plan ${++this.#count} for ${dir}`;
    await writeFile(planFile, content);
    this.#from.set(sha256(content), await this.stateText());
    const count = (action: string) => changes.filter((c) => c.action === action).length;
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: sha256(content),
      createdAt: NOW.toISOString(),
      changes,
      counts: {
        create: count("create"),
        update: count("update"),
        delete: count("delete"),
        replace: count("replace"),
      },
      hasDestroy: changes.some((c) => c.action === "delete" || c.action === "replace"),
      planJson: this.scenario.planJson ?? { resource_changes: [] },
      ...(this.scenario.drift !== undefined ? { drift: this.scenario.drift } : {}),
    };
  }

  async apply(
    _dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    this.calls.push("apply");
    if (sha256(await readFile(planFile)) !== approval.approvedPlanHash) {
      throw new Error("plan hash mismatch");
    }
    // As both engines: a saved plan made from another state is refused, nothing applied.
    if (this.#from.get(approval.approvedPlanHash as string) !== (await this.stateText())) {
      return {
        ok: false,
        outputs: {},
        log: "Error: Saved plan is stale\n\nThe given plan file can no longer be applied because the state was changed by another operation after the plan was created.",
      };
    }
    this.applied.push(approval);
    if (this.scenario.applyLog !== undefined) {
      return { ok: false, outputs: {}, log: this.scenario.applyLog };
    }
    const enc = encryption(options.env?.TF_ENCRYPTION);
    if (enc !== undefined && this.statePath !== undefined && (await exists(this.statePath))) {
      const name =
        this.scenario.writesFallback === true ? (enc.fallback ?? enc.primary) : enc.primary;
      await writeFile(this.statePath, lockedState(name, enc.keys.get(name) as string));
    }
    return { ok: true, outputs: this.scenario.outputs ?? {}, log: "Apply complete!" };
  }

  async output(): Promise<Record<string, unknown>> {
    return this.scenario.stateOutputs ?? {};
  }

  async stateResources(file: string, options: IacRunOptions = {}): Promise<string[]> {
    this.calls.push("state list");
    if (!(await this.opens(file, options.env?.TF_ENCRYPTION))) {
      throw new OpsCrewError("ENGINE_FAILED", "OpenTofu could not decrypt the state.");
    }
    return [];
  }

  async providerSchemas(): Promise<unknown> {
    return {};
  }
  async untaint(): Promise<void> {}
  async importResource(): Promise<void> {}
}

/** GitHub's deploy pause, deploy runs and secrets. */
class FakeGitHub {
  /** By `<environment>/<name>` (`/<name>` for a repository secret). */
  readonly secrets = new Map<string, string>();
  variable: string | undefined;
  failSecret: string | undefined;
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
    this.put("", name, value);
  }
  async setEnvironmentSecret(
    _owner: string,
    _repo: string,
    environment: string,
    name: string,
    value: string,
  ) {
    this.put(environment, name, value);
  }
  private put(environment: string, name: string, value: string) {
    if (this.failSecret === name) {
      this.failSecret = undefined;
      throw new OpsCrewError("PROVIDER_ERROR", "GitHub answered 502.");
    }
    this.secrets.set(`${environment}/${name}`, value);
    this.log.push(`github secret ${name}`);
  }
}

interface World {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  handler: ScriptedApprovalHandler;
  engine: CryptEngine;
  github: FakeGitHub;
  log: string[];
  /** The state passphrase before the rotation. */
  passphrase: string;
}

/**
 * `plan`'s environment with its state on this computer, encrypted under OpsCrew's first key name
 * with its passphrase. Approvals answer `answer` (all approved by default).
 */
async function world(
  plan: DeployPlan,
  engine: CryptEngine = new CryptEngine(),
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0],
): Promise<World> {
  const handler = new ScriptedApprovalHandler(answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    runner: gitRemote(),
    clock: { now: () => NOW },
  });
  const passphrase = secret();
  await mkdir(dirname(deps.paths.files.statePassphrase), { recursive: true });
  await writeFile(deps.paths.files.statePassphrase, `${passphrase}\n`);
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), lockedState("opscrew", passphrase));
  const log: string[] = [];
  return { deps, plan, handler, engine, github: new FakeGitHub(log), log, passphrase };
}

const services = (w: World) => ({
  github: { api: w.github as unknown as GitHubApi, owner: "acme", repo: "shop" },
  services: { engine: async () => w.engine },
  sleep: async () => {},
  now: () => 0,
});

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Nothing printed, audited, asked or thrown holds any of `values`. */
function expectNoValue(w: World, values: readonly string[], error?: unknown): void {
  const said = everythingShown(w, error);
  for (const value of values) expect(said).not.toContain(value);
}

async function passphraseNow(w: World): Promise<string> {
  return (await readFile(w.deps.paths.files.statePassphrase, "utf8")).trim();
}

const nextFile = (w: World) => `${w.deps.paths.files.statePassphrase}.next`;

/** The rotation's saved plans and sidecars in the plans folder. */
async function savedPlans(w: World): Promise<string[]> {
  const names = await readdir(w.deps.paths.files.plansDir).catch(() => [] as string[]);
  return names.filter((name) => name.includes("-rotation.tfplan")).sort();
}

/** A script's approvals: exactly the plans whose hashes are in `approved` (`--approve`). */
function byHash(approved: readonly string[]) {
  return (request: { planHash?: string }) => approved.includes(request.planHash ?? "");
}

async function recorded(w: World, name: string) {
  const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
  return record.environments.prod?.[name];
}

describe("accessTokenAddress and tunnelModules", () => {
  it("name the Access token and the tunnels each target has", () => {
    expect(accessTokenAddress(ownPlan({ access: "tunnel" }))).toBe(ACCESS);
    expect(tunnelModules(ownPlan({ access: "tunnel" }))).toEqual(["tunnel"]);
    // A public own server has neither; with Portainer on a subdomain it has a tunnel, no token.
    expect(accessTokenAddress(ownPlan())).toBeUndefined();
    expect(tunnelModules(ownPlan())).toEqual([]);
    expect(accessTokenAddress(ownPlan({ portainer: "subdomain" }))).toBeUndefined();
    expect(tunnelModules(ownPlan({ portainer: "subdomain" }))).toEqual(["tunnel"]);
    // The user's Portainer: the app's tunnel (web mode tunnel), the webhook's tunnel and token.
    const webhook = portainerPlan({ redeploy: "cloudflare" });
    expect(accessTokenAddress(webhook)).toBe(ACCESS);
    expect(tunnelModules(webhook)).toEqual(["tunnel", "portainer_tunnel"]);
    const updater = portainerPlan({ web: { mode: "proxy", port: 8080 } });
    expect(accessTokenAddress(updater)).toBeUndefined();
    expect(tunnelModules(updater)).toEqual([]);
    expect(tunnelModules(testPlan())).toEqual([]);
  });
});

describe("rotateStatePassphrase", () => {
  it("rewrites the state under a new passphrase in one approved apply with the old one as fallback, then replaces the file", async () => {
    const w = await world(testPlan({ deployed: true }));
    const result = await rotateStatePassphrase(w.deps, w.plan, services(w));

    const next = await passphraseNow(w);
    expect(next).not.toBe(w.passphrase);
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await exists(nextFile(w))).toBe(false);
    // The plan read the state with the old key (`opscrew`) and wrote it with the new one, under
    // the other name; the state now opens with the new passphrase alone.
    const plan = encryption(w.engine.plans[0]?.env);
    expect(plan).toMatchObject({ primary: "opscrew_next", fallback: "opscrew" });
    expect(plan?.keys.get("opscrew")).toBe(w.passphrase);
    expect(plan?.keys.get("opscrew_next")).toBe(next);
    const state = await readFile(tfstateFile(w.deps.paths), "utf8");
    expect(stateKeyName(state)).toBe("opscrew_next");
    expect(state).toBe(lockedState("opscrew_next", next));
    // One plan, approved by its hash with no typed confirmation (it replaces nothing).
    const [request] = w.handler.requests;
    expect(request).toMatchObject({ kind: "iac-apply", planHash: result.hash });
    expect(request?.allowDestroy).toBeUndefined();
    expect(request?.details).toContain("The plan changes nothing in the cloud.");
    expect(w.engine.applied).toEqual([{ approvedPlanHash: result.hash, allowDestroy: false }]);
    expect(await recorded(w, "state-passphrase")).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expectNoValue(w, [w.passphrase, next]);
  });

  it("alternates the key name back on the next rotation", async () => {
    const w = await world(testPlan({ deployed: true }));
    await rotateStatePassphrase(w.deps, w.plan, services(w));
    await rotateStatePassphrase(w.deps, w.plan, services(w));
    const state = await readFile(tfstateFile(w.deps.paths), "utf8");
    expect(stateKeyName(state)).toBe("opscrew");
    expect(state).toBe(lockedState("opscrew", await passphraseNow(w)));
    expect(encryption(w.engine.plans[1]?.env)).toMatchObject({
      primary: "opscrew",
      fallback: "opscrew_next",
    });
    expect((await recorded(w, "state-passphrase"))?.generation).toBe(3);
  });

  it("changes nothing when its plan has other changes, or is not approved", async () => {
    const changed = await world(
      testPlan({ deployed: true }),
      new CryptEngine({ changes: [change("module.server.hcloud_server.this", "update")] }),
    );
    const error = await failure(
      rotateStatePassphrase(changed.deps, changed.plan, services(changed)),
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toBe(
      "The infrastructure plan of prod has changes besides the rotation's (module.server.hcloud_server.this (update)), so OpsCrew applied none of it. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Run `opscrew provision` to review and apply them first, then run `opscrew rotate state-passphrase` again.",
    );
    expect(changed.handler.requests).toEqual([]);

    // Refused in a terminal: the next run asks again with a new plan, so nothing is kept.
    const refused = await world(testPlan({ deployed: true }), new CryptEngine(), [false]);
    refused.deps.interactive = true;
    const refusal = await failure(
      rotateStatePassphrase(refused.deps, refused.plan, services(refused)),
    );
    expect(refusal.code).toBe("APPROVAL_REFUSED");
    expect(refusal.hint).toBe("Run `opscrew rotate state-passphrase` again when you are ready.");
    for (const w of [changed, refused]) {
      expect(await passphraseNow(w)).toBe(w.passphrase);
      expect(await exists(nextFile(w))).toBe(false);
      expect(await savedPlans(w)).toEqual([]);
      expect(w.engine.applied).toEqual([]);
      expect(await readFile(tfstateFile(w.deps.paths), "utf8")).toBe(
        lockedState("opscrew", w.passphrase),
      );
    }
  });

  it("in a script, keeps the refused plan and the new passphrase, and the next run applies that plan by its hash", async () => {
    const approved: string[] = [];
    const w = await world(testPlan({ deployed: true }), new CryptEngine(), byHash(approved));
    const refused = await failure(rotateStatePassphrase(w.deps, w.plan, services(w)));
    const hash = w.handler.requests[0]?.planHash as string;
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.message).toContain(
      "No state was changed. The new passphrase waits on this computer beside the current one, and until the rotation finishes or is undone, the commands that read the states stop.",
    );
    expect(refused.hint).toBe(
      `To apply this saved plan in a script, run \`opscrew rotate state-passphrase\` again with the flags you gave (each --approve <hash> too) and --approve ${hash} added. To step back instead, run \`opscrew rotate state-passphrase --undo\`.`,
    );
    expect(await passphraseNow(w)).toBe(w.passphrase);
    expect(await readFile(tfstateFile(w.deps.paths), "utf8")).toBe(
      lockedState("opscrew", w.passphrase),
    );
    const kept = (await readFile(nextFile(w), "utf8")).trim();
    const names = await savedPlans(w);
    expect(names).toEqual([
      "2026-11-08T10-00-00-000Z-state-passphrase-infra-rotation.tfplan",
      "2026-11-08T10-00-00-000Z-state-passphrase-infra-rotation.tfplan.json",
    ]);
    const sidecar = await readFile(join(w.deps.paths.files.plansDir, names[1] as string), "utf8");
    expect(JSON.parse(sidecar)).toMatchObject({ planHash: hash });

    approved.push(hash);
    const result = await rotateStatePassphrase(w.deps, w.plan, {
      ...services(w),
      approveHashes: [hash],
    });
    expect(result.hash).toBe(hash);
    // The saved plan was applied: no second plan.
    expect(w.engine.calls.filter((call) => call === "plan")).toHaveLength(1);
    expect(w.engine.applied).toEqual([{ approvedPlanHash: hash, allowDestroy: false }]);
    expect(await passphraseNow(w)).toBe(kept);
    expect(await exists(nextFile(w))).toBe(false);
    expect(await readFile(tfstateFile(w.deps.paths), "utf8")).toBe(
      lockedState("opscrew_next", kept),
    );
    expect(await savedPlans(w)).toEqual([]);
    for (const value of [w.passphrase, kept]) expect(sidecar).not.toContain(value);
    expectNoValue(w, [w.passphrase, kept], refused);
  });

  it("--undo steps back from a script's refused rotation while no state was rewritten", async () => {
    const w = await world(testPlan({ deployed: true }), new CryptEngine(), () => false);
    await failure(rotateStatePassphrase(w.deps, w.plan, services(w)));
    expect(await exists(nextFile(w))).toBe(true);
    expect(await savedPlans(w)).toHaveLength(2);

    await rotateStatePassphrase(w.deps, w.plan, { ...services(w), undo: true });
    expect(await exists(nextFile(w))).toBe(false);
    expect(await savedPlans(w)).toEqual([]);
    expect(await passphraseNow(w)).toBe(w.passphrase);
    expect(await readFile(tfstateFile(w.deps.paths), "utf8")).toBe(
      lockedState("opscrew", w.passphrase),
    );
    expect(w.engine.applied).toEqual([]);
    // The other commands open the state again.
    await expect(projectEngine(w.deps, w.plan, services(w))).resolves.toBeDefined();

    const none = await failure(
      rotateStatePassphrase(w.deps, w.plan, { ...services(w), undo: true }),
    );
    expect(none.message).toBe(
      "No rotation of the state passphrase is unfinished in prod, so there is nothing to undo. Nothing was changed.",
    );
  });

  it("refuses --undo once a state was rewritten with the new passphrase", async () => {
    const w = await world(testPlan({ deployed: true }));
    const next = secret();
    await writeFile(nextFile(w), `${next}\n`);
    await writeFile(tfstateFile(w.deps.paths), lockedState("opscrew_next", next));
    const error = await failure(
      rotateStatePassphrase(w.deps, w.plan, { ...services(w), undo: true }),
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toBe(
      "The infrastructure state (.opscrew/tfstate/prod.tfstate) is already encrypted with the new passphrase, and the rotation only goes forward from there, so OpsCrew can't undo it. Nothing was changed.",
    );
    expect(error.hint).toBe("Run `opscrew rotate state-passphrase` again to finish it.");
    expect((await readFile(nextFile(w), "utf8")).trim()).toBe(next);
    expect(await passphraseNow(w)).toBe(w.passphrase);
    expectNoValue(w, [w.passphrase, next], error);
  });

  it("keeps both passphrases when the apply fails, and finishes when run again", async () => {
    const w = await world(
      testPlan({ deployed: true }),
      new CryptEngine({ applyLog: "Error: Hetzner answered 503" }),
    );
    const error = await failure(rotateStatePassphrase(w.deps, w.plan, services(w)));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(await passphraseNow(w)).toBe(w.passphrase);
    const kept = (await readFile(nextFile(w), "utf8")).trim();
    expect(kept).not.toBe(w.passphrase);
    expect(error.hint).toBe(
      "Fix the cause shown above, then run `opscrew rotate state-passphrase` again; it plans again.",
    );
    const again = new CryptEngine();
    await rotateStatePassphrase(w.deps, w.plan, { services: { engine: async () => again } });
    // The run after the failure went on with the passphrase kept.
    expect(await passphraseNow(w)).toBe(kept);
    expect(encryption(again.plans[0]?.env)?.keys.get("opscrew_next")).toBe(kept);
    expect(await exists(nextFile(w))).toBe(false);
    expectNoValue(w, [w.passphrase, kept], error);
  });

  it("only finishes when an earlier run's apply already rewrote the state", async () => {
    const w = await world(testPlan({ deployed: true }));
    const next = secret();
    await writeFile(nextFile(w), `${next}\n`);
    await writeFile(tfstateFile(w.deps.paths), lockedState("opscrew_next", next));
    const result = await rotateStatePassphrase(w.deps, w.plan, services(w));
    expect(result.hash).toBeUndefined();
    expect(w.engine.calls).not.toContain("plan");
    expect(w.handler.requests).toEqual([]);
    expect(await passphraseNow(w)).toBe(next);
    expect(await exists(nextFile(w))).toBe(false);
    expect((await recorded(w, "state-passphrase"))?.generation).toBe(2);
  });

  it("stops, keeping both, when the new passphrase alone does not open the state after the apply", async () => {
    const w = await world(testPlan({ deployed: true }), new CryptEngine({ writesFallback: true }));
    const error = await failure(rotateStatePassphrase(w.deps, w.plan, services(w)));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain(
      "The infrastructure state (.opscrew/tfstate/prod.tfstate) does not open with the new passphrase alone, so OpsCrew kept both passphrases on this computer",
    );
    expect(await passphraseNow(w)).toBe(w.passphrase);
    expect(await exists(nextFile(w))).toBe(true);
  });

  it("replaces the passphrase at once when no state is encrypted with it yet", async () => {
    const w = await world(testPlan());
    await writeFile(tfstateFile(w.deps.paths), "");
    const result = await rotateStatePassphrase(w.deps, w.plan, services(w));
    expect(result.hash).toBeUndefined();
    expect(w.engine.calls).toEqual([]);
    expect(await passphraseNow(w)).not.toBe(w.passphrase);
  });

  it("rotates a bucket's state alone, which the next provision opens under its key name", async () => {
    const w = await world(withBucket(testPlan({ deployed: true }), "r2"));
    await writeFile(tfstateFile(w.deps.paths), "");
    const storage = join(w.deps.paths.files.tfstateDir, "storage.tfstate");
    await writeFile(storage, lockedState("opscrew", w.passphrase));
    await rotateStatePassphrase(w.deps, w.plan, services(w));
    const next = await passphraseNow(w);
    expect(await readFile(storage, "utf8")).toBe(lockedState("opscrew_next", next));
    // Provision's engine setup: the key name comes from the bucket's state, so it opens it.
    const { env } = await projectEngine(w.deps, w.plan, {
      services: { engine: async () => w.engine },
    });
    await expect(w.engine.stateResources(storage, { env })).resolves.toEqual([]);
  });

  it("rewrites every state the passphrase encrypts, each by its own approved plan, before the file", async () => {
    const w = await world(withBucket(testPlan({ deployed: true }), "r2"));
    const storage = join(w.deps.paths.files.tfstateDir, "storage.tfstate");
    await writeFile(storage, lockedState("opscrew", w.passphrase));
    await rotateStatePassphrase(w.deps, w.plan, services(w));
    const next = await passphraseNow(w);
    for (const state of [tfstateFile(w.deps.paths), storage]) {
      expect(await readFile(state, "utf8")).toBe(lockedState("opscrew_next", next));
    }
    // One plan per root module, each against its own state, approved by its own hash.
    expect(w.engine.plans.map((p) => p.dir)).toEqual([
      join(w.deps.paths.root, w.plan.infra.dir),
      join(w.deps.paths.root, storageRootDir(w.plan)),
    ]);
    expect(w.handler.requests.map((r) => r.title)).toEqual([
      "Rewrite the infrastructure state of prod under a new passphrase (1 of 2)",
      "Rewrite the app's bucket's state of prod under a new passphrase (2 of 2)",
    ]);
    expect(w.handler.requests[0]?.details).toContain(
      "It encrypts .opscrew/tfstate/prod.tfstate and .opscrew/tfstate/storage.tfstate, each rewritten by its own plan",
    );
    expectNoValue(w, [w.passphrase, next]);
  });

  it("keeps both passphrases until every state opens with the new one, and goes on with the rest when run again", async () => {
    // The second approval (the bucket's state) is refused once.
    let asked = 0;
    const w = await world(
      withBucket(testPlan({ deployed: true }), "r2"),
      new CryptEngine(),
      () => ++asked !== 2,
    );
    const storage = join(w.deps.paths.files.tfstateDir, "storage.tfstate");
    await writeFile(storage, lockedState("opscrew", w.passphrase));
    const refused = await failure(rotateStatePassphrase(w.deps, w.plan, services(w)));
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.message).toBe(
      "The plan rewriting the app's bucket's state under a new passphrase was not approved. The states rewritten so far are encrypted with the new passphrase, which stays on this computer beside the current one until every state is.",
    );
    // The environment's state is rewritten, the bucket's is not: the old passphrase stays current.
    expect(await passphraseNow(w)).toBe(w.passphrase);
    const kept = (await readFile(nextFile(w), "utf8")).trim();
    expect(await readFile(storage, "utf8")).toBe(lockedState("opscrew", w.passphrase));

    const engine = new CryptEngine();
    await rotateStatePassphrase(w.deps, w.plan, { services: { engine: async () => engine } });
    expect(engine.plans.map((p) => p.dir)).toEqual([
      join(w.deps.paths.root, storageRootDir(w.plan)),
    ]);
    expect(await passphraseNow(w)).toBe(kept);
    expect(await readFile(storage, "utf8")).toBe(lockedState("opscrew_next", kept));
    expect(await exists(nextFile(w))).toBe(false);
  });

  it("refuses without state encryption, with Terraform, and beside a bucket's state the plan no longer has", async () => {
    const plain = await world(testPlan({ deployed: true }));
    const off = { ...plain.plan, infra: { ...plain.plan.infra, stateEncryption: false } };
    expect(await failure(rotateStatePassphrase(plain.deps, off, services(plain)))).toMatchObject({
      code: "INVALID_INPUT",
    });
    const terraform = Object.assign(new CryptEngine(), {
      info: { name: "terraform" as const, version: "1.9.0", binary: "/fake/terraform" },
    });
    expect(
      await failure(
        rotateStatePassphrase(plain.deps, plain.plan, {
          services: { engine: async () => terraform },
        }),
      ),
    ).toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: "Run `opscrew rotate state-passphrase --engine tofu`.",
    });
    await writeFile(
      join(plain.deps.paths.files.tfstateDir, "storage.tfstate"),
      lockedState("opscrew", plain.passphrase),
    );
    const beside = await failure(rotateStatePassphrase(plain.deps, plain.plan, services(plain)));
    expect(beside.message).toBe(
      ".opscrew/tfstate/storage.tfstate is encrypted with the state passphrase, but shop's plan has no bucket any more, so OpsCrew can't rewrite it under a new one. Nothing was changed.",
    );
    expect(plain.engine.calls).toEqual([]);
    expect(await passphraseNow(plain)).toBe(plain.passphrase);
  });
});

/** The Access token's outputs, as the engine gives them after the apply. */
function accessOutputs() {
  return {
    deploy_service_token_client_id: `${randomBytes(16).toString("hex")}.access`,
    deploy_service_token_client_secret: randomBytes(32).toString("hex"),
  };
}

describe("rotateAccessToken", () => {
  it("replaces the token by an approved -replace plan with the deploys paused, then the deploy's secrets", async () => {
    const outputs = accessOutputs();
    const engine = new CryptEngine({
      changes: [
        change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token"),
        change("module.access.cloudflare_zero_trust_access_policy.ssh[0]", "update"),
      ],
      outputs,
    });
    const w = await world(ownPlan({ access: "tunnel", deployed: true }), engine);
    const result = await rotateAccessToken(w.deps, w.plan, services(w));

    expect(engine.plans[0]?.replace).toEqual([ACCESS]);
    const [request] = w.handler.requests;
    // A replacement: approved by its hash with the app's name typed.
    expect(request).toMatchObject({
      kind: "iac-apply",
      planHash: result.hash,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(request?.details).toContain(
      "± replace module.access.cloudflare_zero_trust_access_service_token.ssh[0]",
    );
    expect(engine.applied).toEqual([{ approvedPlanHash: result.hash, allowDestroy: true }]);
    expect(w.log).toEqual([
      "github pause",
      "github secret OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
      "github secret OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET",
      "github resume",
    ]);
    expect(w.github.secrets.get("/OPSCREW_TUNNEL_SERVICE_TOKEN_ID")).toBe(
      outputs.deploy_service_token_client_id,
    );
    expect(w.github.secrets.get("/OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET")).toBe(
      outputs.deploy_service_token_client_secret,
    );
    expect(await recorded(w, "access-token")).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expectNoValue(w, [...Object.values(outputs), w.passphrase]);
  });

  it("gives a Portainer's webhook secrets the new token", async () => {
    const outputs = accessOutputs();
    const engine = new CryptEngine({
      changes: [change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token")],
      outputs,
    });
    const w = await world(portainerPlan({ redeploy: "cloudflare", deployed: true }), engine);
    await recordPortainerConnection(w.deps.paths, {
      url: PORTAINER_URL,
      environmentId: 3,
      environmentName: "local",
    });
    await rotateAccessToken(w.deps, w.plan, services(w));
    // Portainer's address reached the engine only as the sensitive variable, never any output.
    expect(engine.envs[0]?.TF_VAR_portainer_origin).toBe(PORTAINER_URL);
    expectNoValue(w, [PORTAINER_HOST]);
    expect(w.github.secrets.get("/OPSCREW_PORTAINER_ACCESS_CLIENT_ID")).toBe(
      outputs.deploy_service_token_client_id,
    );
    expect(w.github.secrets.get("/OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET")).toBe(
      outputs.deploy_service_token_client_secret,
    );
  });

  it("refuses a plan with other changes, and a token the environment has not", async () => {
    const engine = new CryptEngine({
      changes: [
        change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token"),
        change("module.dns.cloudflare_dns_record.apex", "update"),
      ],
    });
    const w = await world(ownPlan({ access: "tunnel", deployed: true }), engine);
    const error = await failure(rotateAccessToken(w.deps, w.plan, services(w)));
    expect(error.message).toContain(
      "has changes besides the rotation's (module.dns.cloudflare_dns_record.apex (update))",
    );
    expect(w.log).toEqual([]);
    expect(w.handler.requests).toEqual([]);

    // In Access itself only the deploy's policy follows the token, updated in place: Portainer's
    // application, or that policy replaced, are other changes.
    for (const other of [
      change("module.access.cloudflare_zero_trust_access_application.portainer[0]", "update"),
      change("module.access.cloudflare_zero_trust_access_policy.ssh[0]", "replace"),
    ]) {
      const access = await world(
        ownPlan({ access: "tunnel", portainer: "subdomain", deployed: true }),
        new CryptEngine({
          changes: [change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token"), other],
        }),
      );
      const refused = await failure(rotateAccessToken(access.deps, access.plan, services(access)));
      expect(refused.message).toContain(
        `has changes besides the rotation's (${other.address} (${other.action}))`,
      );
      expect(access.engine.applied).toEqual([]);
    }

    const none = await world(ownPlan({ deployed: true }));
    expect(await failure(rotateAccessToken(none.deps, none.plan, services(none)))).toMatchObject({
      code: "INVALID_INPUT",
    });
    // A token not in the state yet: provision creates it first.
    const missing = await world(ownPlan({ access: "tunnel", deployed: true }));
    const created = await failure(rotateAccessToken(missing.deps, missing.plan, services(missing)));
    expect(created.message).toContain(`has no ${ACCESS} to replace yet`);
  });

  it("keeps the deploys paused when GitHub refuses a secret, and goes on under its own pause when run again", async () => {
    const engine = new CryptEngine({
      changes: [change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token")],
      outputs: accessOutputs(),
    });
    const w = await world(ownPlan({ access: "tunnel", deployed: true }), engine);
    w.github.failSecret = "OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET";
    const error = await failure(rotateAccessToken(w.deps, w.plan, services(w)));
    expect(error.message).toContain(
      "GitHub answered 502. The app's deploys stay paused (OPSCREW_DEPLOY_PAUSED) until `opscrew rotate access-token` finishes.",
    );
    expect(w.github.variable).toBeDefined();
    expect(w.log).not.toContain("github resume");
    await rotateAccessToken(w.deps, w.plan, services(w));
    expect(w.github.variable).toBeUndefined();
    expect(engine.applied).toHaveLength(2);
  });

  it("refuses while a move pauses the deploys", async () => {
    const w = await world(ownPlan({ access: "tunnel", deployed: true }));
    w.github.variable = JSON.stringify({
      [checkEnvironmentKey(w.plan)]: { reason: "move", since: "2026-11-08T09:00:00Z" },
    });
    const error = await failure(rotateAccessToken(w.deps, w.plan, services(w)));
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toContain("are paused for a move since 2026-11-08T09:00:00Z");
    expect(w.engine.calls).toEqual([]);
  });

  it("in a script, refuses a saved plan the state outgrew, removes it, and plans again in the next run", async () => {
    const engine = new CryptEngine({
      changes: [change(ACCESS, "replace", "cloudflare_zero_trust_access_service_token")],
      outputs: accessOutputs(),
    });
    const approved: string[] = [];
    const w = await world(ownPlan({ access: "tunnel", deployed: true }), engine, byHash(approved));
    const refused = await failure(rotateAccessToken(w.deps, w.plan, services(w)));
    const hash = w.handler.requests[0]?.planHash as string;
    expect(refused.hint).toBe(
      `To apply this saved plan in a script, run \`opscrew rotate access-token\` again with the flags you gave (each --approve <hash> too) and --approve ${hash} --confirm shop added.`,
    );
    expect(await savedPlans(w)).toHaveLength(2);

    // Another run changed the state after the plan was made.
    approved.push(hash);
    await writeFile(
      tfstateFile(w.deps.paths),
      lockedState("opscrew", w.passphrase).replace('"serial":3', '"serial":4'),
    );
    const stale = await failure(
      rotateAccessToken(w.deps, w.plan, { ...services(w), approveHashes: [hash] }),
    );
    expect(stale.code).toBe("PLAN_HASH_MISMATCH");
    expect(stale.message).toContain(
      `The saved plan with the hash ${hash} no longer fits the infrastructure state, which changed after the plan was made, so OpsCrew applied none of it.`,
    );
    expect(stale.hint).toContain(
      `Run \`opscrew rotate access-token\` again without --approve ${hash}: it plans again from the state as it is now, and you approve the new plan's hash.`,
    );
    expect(engine.applied).toEqual([]);
    expect(await savedPlans(w)).toEqual([]);

    // The next run, the stale hash still given, plans again and names the new plan's hash.
    const again = await failure(
      rotateAccessToken(w.deps, w.plan, { ...services(w), approveHashes: [hash] }),
    );
    expect(again.code).toBe("APPROVAL_REFUSED");
    const fresh = w.handler.requests.at(-1)?.planHash as string;
    expect(fresh).not.toBe(hash);
    expect(again.hint).toContain(`--approve ${fresh} --confirm shop`);
    expect(engine.calls.filter((call) => call === "plan")).toHaveLength(2);
  });
});

/** Cloudflare's API as the tunnel-token rotation uses it: each new secret and the token it gives. */
class FakeCloudflare {
  readonly calls: { account: string; tunnel: string; secret: string; token: string }[] = [];
  /** The next call fails this way. */
  failure: OpsCrewError | undefined;
  constructor(private readonly log: string[]) {}
  rotateTunnelSecret = async (account: string, tunnel: string, secret: string) => {
    if (this.failure !== undefined) throw this.failure;
    const token = randomBytes(48).toString("base64");
    this.calls.push({ account, tunnel, secret, token });
    this.log.push(`cloudflare secret ${tunnel}`);
    return token;
  };
}

/**
 * An environment with tunnels, its account in `terraform.tfvars.json` and its tunnels in the state,
 * rotated in a terminal (the rotation runs only there).
 */
async function tunnelWorld(
  plan: DeployPlan,
  outputs: Record<string, unknown>,
  answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0],
  drift?: ResourceDrift[],
) {
  const engine = new CryptEngine({
    stateOutputs: outputs,
    ...(drift !== undefined ? { drift } : {}),
  });
  const w = await world(plan, engine, answer);
  w.deps.interactive = true;
  const dir = join(w.deps.paths.root, plan.infra.dir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "terraform.tfvars.json"),
    `${JSON.stringify({ app_name: "shop", cloudflare_account_id: "acct-1" })}\n`,
  );
  const cloudflare = new FakeCloudflare(w.log);
  const restarted: RotatedTunnel[] = [];
  const connectors: TunnelConnectors = {
    check: async () => {
      w.log.push("check connectors");
    },
    restart: async (tunnels) => {
      restarted.push(...tunnels);
      w.log.push(
        `restart ${tunnels.map((t) => t.module).join(" ")} (applied: ${engine.applied.length})`,
      );
    },
  };
  const run = () =>
    rotateTunnelToken(w.deps, w.plan, {
      services: { engine: async () => engine },
      connectors,
      cloudflare,
    });
  return { ...w, cloudflare, restarted, run };
}

describe("rotateTunnelToken", () => {
  it("changes the tunnel's secret in place, records the new token in the state, then restarts the connector", async () => {
    const w = await tunnelWorld(ownPlan({ access: "tunnel", deployed: true }), {
      tunnel_id: "tun-1",
    });
    const result = await w.run();
    const [call] = w.cloudflare.calls;
    expect(call).toMatchObject({ account: "acct-1", tunnel: "tun-1" });
    // 32 random bytes, base64, made for this rotation only.
    expect(Buffer.from(call?.secret ?? "", "base64")).toHaveLength(32);
    expect(w.log).toEqual([
      "check connectors",
      "cloudflare secret tun-1",
      "restart tunnel (applied: 1)",
    ]);
    expect(w.restarted).toEqual([{ module: "tunnel", tunnelId: "tun-1", token: call?.token }]);
    // No replacement, no typed name: the rotation's own plan, then the state's refresh-only plan.
    const [rotation, refresh] = w.handler.requests;
    expect(rotation).toMatchObject({ kind: "cloudflare-apply", planHash: result.hash });
    expect(rotation?.confirmPhrase).toBeUndefined();
    expect(rotation?.details).toContain(
      "With one connector, what the tunnel serves pauses for that restart, a few seconds; with two, not at all.",
    );
    expect(refresh).toMatchObject({ kind: "iac-apply" });
    expect(refresh?.allowDestroy).toBeUndefined();
    expect(w.engine.plans).toEqual([expect.objectContaining({ refreshOnly: true })]);
    expect(w.engine.plans[0]?.replace).toBeUndefined();
    expect(await recorded(w, "tunnel-token")).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expectNoValue(w, [call?.secret ?? "", call?.token ?? ""]);
  });

  /**
   * A Portainer redeployed through Cloudflare with its app on a tunnel, and its stacks as
   * `portainerStacksFor` gives them: today's plan has `pending` changes, each later one the token's.
   */
  async function inPortainer(pending = 0) {
    const w = await tunnelWorld(portainerPlan({ redeploy: "cloudflare", deployed: true }), {
      tunnel_id: "tun-app",
      portainer_tunnel_id: "tun-hook",
    });
    await recordPortainerConnection(w.deps.paths, {
      url: PORTAINER_URL,
      environmentId: 3,
      environmentName: "local",
    });
    const today = {
      tunnel_id: "tun-app",
      tunnel_token: secret(),
      portainer_tunnel_token: secret(),
    };
    const planned: Record<string, unknown>[] = [];
    const applied: Record<string, unknown>[] = [];
    /** The next stack plans fail this way. */
    const stepFailures: OpsCrewError[] = [];
    const stacks = {
      plan: async (outputs: Record<string, unknown>) => {
        planned.push(outputs);
        return { plan: {}, hash: "a".repeat(64), details: "", changes: pending };
      },
      step: async (outputs: Record<string, unknown>) => {
        const failure = stepFailures.shift();
        if (failure !== undefined) throw failure;
        applied.push(outputs);
        w.log.push("stack plan");
        return {};
      },
    } as unknown as PortainerStacksSetup["stacks"];
    const connectors = portainerTunnelConnectors(w.deps, w.plan, {
      command: "opscrew rotate tunnel-token",
      stacksFor: async () => ({ stacks, outputs: today }),
    });
    const run = () =>
      rotateTunnelToken(w.deps, w.plan, {
        services: { engine: async () => w.engine },
        connectors,
        cloudflare: w.cloudflare,
      });
    return { ...w, today, planned, applied, stepFailures, run };
  }

  it("gives both of a Portainer's tunnels new tokens through one stack plan", async () => {
    const w = await inPortainer();
    await w.run();
    expect(w.cloudflare.calls.map((c) => c.tunnel)).toEqual(["tun-app", "tun-hook"]);
    // Today's stack plan was checked empty first; then one stack plan with both new tokens.
    expect(w.planned).toEqual([w.today]);
    expect(w.applied).toEqual([
      {
        ...w.today,
        tunnel_token: w.cloudflare.calls[0]?.token,
        portainer_tunnel_token: w.cloudflare.calls[1]?.token,
      },
    ]);
    expect(w.log).toEqual([
      "cloudflare secret tun-app",
      "cloudflare secret tun-hook",
      "stack plan",
    ]);
    expect(w.handler.requests[0]?.details).toContain(
      "The connectors' stacks in your Portainer get the new token through one stack plan, approved by its own hash",
    );
  });

  it("names provision when the stacks' plan fails once the state holds the new token", async () => {
    const w = await inPortainer();
    w.stepFailures.push(new OpsCrewError("PROVIDER_ERROR", "Portainer answered 502."));
    const error = await failure(w.run());
    expect(error.message).toBe(
      "Portainer answered 502. Cloudflare holds the tunnel's new secret; the connectors that run keep the tunnel up with the old token.",
    );
    expect(error.hint).toBe(
      "Fix what it names. Then run `opscrew provision`: it gives the stacks the new token the infrastructure state holds.",
    );
    // The refresh-only plan was applied first.
    expect(w.engine.applied).toHaveLength(1);
  });

  it("refuses, before anything changes, while the stacks have changes of their own", async () => {
    const w = await inPortainer(2);
    const error = await failure(w.run());
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
    expect(error.message).toContain(
      "The app's stacks in your Portainer have changes besides the rotation's (2 changes with the values this computer keeps",
    );
    expect(error.hint).toBe(
      "Run `opscrew provision` first so the stacks are as the plan says, then run the command again.",
    );
    expect(w.cloudflare.calls).toEqual([]);
    expect(w.handler.requests).toEqual([]);
  });

  it("changes nothing without approval, and says the connectors keep the tunnel up when a later step fails", async () => {
    const plan = ownPlan({ access: "tunnel", deployed: true });
    const refused = await tunnelWorld(plan, { tunnel_id: "tun-1" }, [false]);
    expect((await failure(refused.run())).code).toBe("APPROVAL_REFUSED");
    expect(refused.cloudflare.calls).toEqual([]);
    expect(refused.restarted).toEqual([]);

    const later = await tunnelWorld(plan, { tunnel_id: "tun-1" });
    const restart = await failure(
      rotateTunnelToken(later.deps, plan, {
        services: { engine: async () => later.engine },
        connectors: {
          check: async () => {},
          restart: async () => {
            throw new OpsCrewError("COMMAND_FAILED", "Your server did not answer over SSH.");
          },
        },
        cloudflare: later.cloudflare,
      }),
    );
    expect(restart.message).toBe(
      "Your server did not answer over SSH. Cloudflare holds the tunnel's new secret; the connectors that run keep the tunnel up with the old token.",
    );
    expect(restart.hint).toContain(
      "Then run `opscrew rotate tunnel-token` again: it gives the tunnel another new secret and goes on.",
    );
  });

  it("asks the same first hash in a run after a refusal, and runs only in a terminal", async () => {
    const w = await tunnelWorld(
      ownPlan({ access: "tunnel", deployed: true }),
      {
        tunnel_id: "tun-1",
      },
      [false, true, true],
    );
    expect((await failure(w.run())).hint).toBe(
      "Run `opscrew rotate tunnel-token` again when you are ready.",
    );
    await w.run();
    const [refused, again] = w.handler.requests;
    expect(again?.planHash).toBe(refused?.planHash);

    const script = await tunnelWorld(ownPlan({ access: "tunnel", deployed: true }), {
      tunnel_id: "tun-1",
    });
    script.deps.interactive = false;
    const error = await failure(script.run());
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Rotating the Cloudflare Tunnel token asks several approvals in turn, each of a plan made from the step before, so it runs only in a terminal. Nothing was changed.",
      hint: "Run `opscrew rotate tunnel-token` in a terminal.",
    });
    expect(script.cloudflare.calls).toEqual([]);
    expect(script.handler.requests).toEqual([]);
  });

  it("refuses a refresh that would take in changes made outside OpsCrew", async () => {
    const drifted = {
      address: 'module.tunnel.cloudflare_dns_record.route["shop.example.com"]',
      type: "cloudflare_dns_record",
      name: "route",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      action: "update" as const,
      attributes: ["content"],
    };
    const w = await tunnelWorld(
      ownPlan({ access: "tunnel", deployed: true }),
      { tunnel_id: "tun-1" },
      undefined,
      [drifted],
    );
    const error = await failure(w.run());
    expect(error.message).toContain(
      `has changes besides the rotation's (${drifted.address} (changed outside OpsCrew)), so OpsCrew applied none of it.`,
    );
    expect(error.hint).toContain("Run `opscrew provision` to review and apply them first");
    // Only the rotation's own approval was given: the refresh-only plan was never asked or applied.
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["cloudflare-apply"]);
    expect(w.engine.applied).toEqual([]);
    expect(w.restarted).toEqual([]);
  });

  it("refuses without a tunnel, without the tunnel in the state, or without Cloudflare's token", async () => {
    const none = await tunnelWorld(testPlan({ deployed: true }), {});
    expect((await failure(none.run())).code).toBe("INVALID_INPUT");
    const missing = await tunnelWorld(ownPlan({ access: "tunnel", deployed: true }), {});
    expect((await failure(missing.run())).message).toContain(
      "This computer has no tunnel in the infrastructure state (tunnel) of prod",
    );
    const token = await tunnelWorld(ownPlan({ access: "tunnel", deployed: true }), {
      tunnel_id: "tun-1",
    });
    const error = await failure(
      rotateTunnelToken(token.deps, token.plan, {
        services: { engine: async () => token.engine },
        connectors: { check: async () => {}, restart: async () => {} },
      }),
    );
    expect(error.code).toBe("CREDENTIALS_MISSING");
    for (const w of [none, missing, token]) expect(w.cloudflare.calls).toEqual([]);
  });
});

/** The app's server's host adapter: inspection, and each applied host plan with its options. */
function fakeServerHost() {
  const applies: { plan: HostPlan; options: ApplyOptions }[] = [];
  const failures: OpsCrewError[] = [];
  const services: Pick<VpnServices, "remote" | "host"> = {
    remote: async (server) => ({
      host: server,
      run: async () => {
        throw new Error("the fake host adapter does the work");
      },
    }),
    host: {
      inspect: async () => HostFactsSchema.parse(freshFacts({ user: "admin", privilege: "root" })),
      apply: async (_remote, plan, options): Promise<ApplyResult> => {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        applies.push({ plan, options });
        return { applied: plan.steps.map((step) => step.id), skipped: [] };
      },
    },
  };
  return { applies, failures, services };
}

describe("rotateTunnelToken on the user's own server", () => {
  /** The own server in tunnel mode, its login recorded, its connector's host plan faked. */
  async function onServer() {
    const w = await tunnelWorld(ownPlan({ access: "tunnel", deployed: true }), {
      tunnel_id: TUNNEL_ID,
    });
    await updateServerAddresses(w.deps.paths, (current) => ({
      ...current,
      own: { host: "192.0.2.50", port: 22, user: "admin", agent: true },
    }));
    const host = fakeServerHost();
    const run = () =>
      rotateTunnelToken(w.deps, w.plan, {
        services: { engine: async () => w.engine },
        cloudflare: w.cloudflare,
        server: host.services,
      });
    return { ...w, host, run };
  }

  it("restarts the connector with the new token through its host plan, approved by its hash", async () => {
    const w = await onServer();
    await w.run();
    const [{ plan, options }] = w.host.applies as [{ plan: HostPlan; options: ApplyOptions }];
    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: "tunnel-connector",
        state: "change",
        params: expect.objectContaining({ tunnelId: TUNNEL_ID, needsToken: true, rewrite: true }),
      }),
    ]);
    // The token goes only to the adapter, which sends it on the server's standard input.
    const token = w.cloudflare.calls[0]?.token as string;
    expect(options.secrets?.tunnelToken).toBe(token);
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(w.handler.requests.map((r) => r.kind)).toEqual([
      "cloudflare-apply",
      "iac-apply",
      "host-apply",
    ]);
    expect(w.handler.requests[2]?.planHash).toBe(hostPlanHash(plan));
    expectNoValue(w, [token, w.cloudflare.calls[0]?.secret as string]);
  });

  it("can be finished when the restart fails: the state holds the new token, and a run again restarts", async () => {
    const w = await onServer();
    w.host.failures.push(
      new OpsCrewError("COMMAND_FAILED", "Your server did not answer over SSH."),
    );
    const error = await failure(w.run());
    expect(error.message).toContain(
      "Cloudflare holds the tunnel's new secret; the connectors that run keep the tunnel up with the old token.",
    );
    // The refresh-only plan went through first: provision would hand the new token on as well.
    expect(w.engine.plans.map((p) => p.refreshOnly)).toEqual([true]);
    expect(w.engine.applied).toHaveLength(1);
    expect(await exists(credentialsRecordFile(w.deps.paths))).toBe(false);

    await w.run();
    const newest = w.cloudflare.calls[1]?.token;
    expect(w.host.applies.map((a) => a.options.secrets?.tunnelToken)).toEqual([newest]);
    expect(await recorded(w, "tunnel-token")).toMatchObject({ generation: 2 });
  });
});

/**
 * A Hetzner app whose deploy key's copy at the provider was planned in a script and refused: its
 * world, the approvals a later run gives (`approved`), the rotation's input and the plan's hash.
 */
async function refusedProviderCopy() {
  const engine = new CryptEngine({
    changes: [change("module.server.hcloud_ssh_key.deploy[0]", "replace", "hcloud_ssh_key")],
  });
  const approved: string[] = [];
  const w = await world(testPlan({ deployed: true }), engine, byHash(approved));
  const input = {
    publicKey: `ssh-ed25519 ${randomBytes(32).toString("base64")} opscrew-deploy`,
    again: "opscrew rotate deploy-key",
    services: { engine: async () => engine },
  };
  const refused = await failure(replaceDeployKeyObject(w.deps, w.plan, input));
  const hash = w.handler.requests[0]?.planHash as string;
  return { w, engine, approved, input, refused, hash };
}

describe("replaceDeployKeyObject", () => {
  it("replaces the provider's copy of the deploy key with the new key in its own approved plan", async () => {
    const engine = new CryptEngine({
      changes: [change("module.server.hcloud_ssh_key.deploy[0]", "replace", "hcloud_ssh_key")],
    });
    const w = await world(testPlan({ deployed: true }), engine);
    const publicKey = `ssh-ed25519 ${randomBytes(32).toString("base64")} opscrew-deploy`;
    const hash = await replaceDeployKeyObject(w.deps, w.plan, {
      publicKey: `${publicKey}\n`,
      again: "opscrew rotate deploy-key",
      services: { engine: async () => engine },
    });
    expect(engine.plans[0]?.vars).toEqual({ deploy_ssh_public_key: publicKey });
    expect(w.handler.requests[0]).toMatchObject({ planHash: hash, confirmPhrase: "shop" });
    expect(engine.applied).toEqual([{ approvedPlanHash: hash, allowDestroy: true }]);
  });

  it("in a script, is refused with the saved plan's hash, then applies that plan in the next run without planning again", async () => {
    const { w, engine, approved, input, refused, hash } = await refusedProviderCopy();
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.hint).toBe(
      `To apply this saved plan in a script, run \`opscrew rotate deploy-key\` again with the flags you gave (each --approve <hash> too) and --approve ${hash} --confirm shop added.`,
    );
    expect(await savedPlans(w)).toEqual([
      "2026-11-08T10-00-00-000Z-deploy-key-rotation.tfplan",
      "2026-11-08T10-00-00-000Z-deploy-key-rotation.tfplan.json",
    ]);

    // `--approve <hash> --confirm shop`: another run's hash beside it changes nothing.
    approved.push(hash);
    const other = "0".repeat(64);
    expect(
      await replaceDeployKeyObject(w.deps, w.plan, { ...input, approveHashes: [other, hash] }),
    ).toBe(hash);
    expect(engine.calls.filter((call) => call === "plan")).toHaveLength(1);
    expect(w.handler.requests[1]).toMatchObject({
      planHash: hash,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(engine.applied).toEqual([{ approvedPlanHash: hash, allowDestroy: true }]);
    expect(await savedPlans(w)).toEqual([]);
  });

  it("keeps only the newest saved plan: an older hash makes a new plan", async () => {
    const { w, engine, input, hash } = await refusedProviderCopy();
    await failure(replaceDeployKeyObject(w.deps, w.plan, input));
    const newer = w.handler.requests[1]?.planHash as string;
    expect(newer).not.toBe(hash);
    expect(await savedPlans(w)).toHaveLength(2);
    const sidecar = (await savedPlans(w))[1] as string;
    const saved = JSON.parse(await readFile(join(w.deps.paths.files.plansDir, sidecar), "utf8"));
    expect(saved.planHash).toBe(newer);
    await failure(replaceDeployKeyObject(w.deps, w.plan, { ...input, approveHashes: [hash] }));
    expect(engine.calls.filter((call) => call === "plan")).toHaveLength(3);
    expect(engine.applied).toEqual([]);
  });

  it("refuses a saved plan whose file changed after it was saved", async () => {
    const { w, engine, input, hash } = await refusedProviderCopy();
    const [planFile] = await savedPlans(w);
    await writeFile(join(w.deps.paths.files.plansDir, planFile as string), "another plan");
    const error = await failure(
      replaceDeployKeyObject(w.deps, w.plan, { ...input, approveHashes: [hash] }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toBe(
      `The saved plan with the hash ${hash} is missing or changed after it was saved, so OpsCrew will not apply it. Nothing was changed.`,
    );
    expect(error.hint).toBe(
      `Run \`opscrew rotate deploy-key\` again without --approve ${hash}: it plans again, and you approve the new plan's hash.`,
    );
    expect(engine.applied).toEqual([]);
    expect(await savedPlans(w)).toEqual([]);
  });

  it("refuses a saved plan whose sidecar is damaged", async () => {
    const { w, engine, input, hash } = await refusedProviderCopy();
    const sidecar = (await savedPlans(w))[1] as string;
    await writeFile(
      join(w.deps.paths.files.plansDir, sidecar),
      `${JSON.stringify({ planHash: hash })}\n`,
    );
    const error = await failure(
      replaceDeployKeyObject(w.deps, w.plan, { ...input, approveHashes: [hash] }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toContain(
      `The saved plan with the hash ${hash} is incomplete or damaged`,
    );
    expect(error.hint).toBe(
      `Run \`opscrew rotate deploy-key\` again without --approve ${hash}: it plans again, and you approve the new plan's hash.`,
    );
    expect(engine.calls.filter((call) => call === "plan")).toHaveLength(1);
    expect(engine.applied).toEqual([]);
  });

  it("refuses a saved plan made with the other engine, before anything runs", async () => {
    const { w, input, hash } = await refusedProviderCopy();
    const terraform = new CryptEngine();
    Object.assign(terraform, {
      info: { name: "terraform", version: "1.9.8", binary: "/fake/terraform" },
    });
    const error = await failure(
      replaceDeployKeyObject(w.deps, w.plan, {
        ...input,
        services: { engine: async () => terraform },
        approveHashes: [hash],
      }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toBe(
      `The saved plan with the hash ${hash} was made with OpenTofu, but this run uses Terraform, so OpsCrew will not apply it. Nothing was changed.`,
    );
    expect(error.hint).toBe(
      `Run \`opscrew rotate deploy-key\` again with --engine tofu, or without --approve ${hash} to plan again.`,
    );
    expect(terraform.calls).toEqual([]);
    expect(await savedPlans(w)).toHaveLength(2);
  });

  it("does nothing on a server the user owns or when the objects hold the new key, and refuses other changes", async () => {
    const own = await world(ownPlan({ deployed: true }));
    const input = {
      publicKey: "ssh-ed25519 AAAA opscrew-deploy",
      again: "opscrew rotate deploy-key",
    };
    expect(
      await replaceDeployKeyObject(own.deps, own.plan, {
        ...input,
        services: { engine: async () => own.engine },
      }),
    ).toBeUndefined();
    expect(own.engine.calls).toEqual([]);

    const current = await world(testPlan({ deployed: true }));
    expect(
      await replaceDeployKeyObject(current.deps, current.plan, {
        ...input,
        services: { engine: async () => current.engine },
      }),
    ).toBeUndefined();
    expect(current.handler.requests).toEqual([]);

    const other = new CryptEngine({
      changes: [
        change("module.server.hcloud_ssh_key.deploy[0]", "replace", "hcloud_ssh_key"),
        change("module.server.hcloud_server.this", "replace", "hcloud_server"),
      ],
    });
    const w = await world(testPlan({ deployed: true }), other);
    const error = await failure(
      replaceDeployKeyObject(w.deps, w.plan, { ...input, services: { engine: async () => other } }),
    );
    expect(error.message).toContain("module.server.hcloud_server.this (replace)");
    expect(other.applied).toEqual([]);
  });
});
