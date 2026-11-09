// Feature 025 (T2508): the SSH keys, replaced add-first, proven, then removed (FR-2506).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkKeyLine, previewKeyLine } from "@opscrew/connector-ssh-host";
import type { CommandResult, IacEngine, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError, resolveProjectPaths, tfstateFile } from "@opscrew/core";
import { CHECK_SECRETS, DEPLOY_SECRETS, deploySecretName } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureCheckKey } from "../check/key";
import { networked, splitPlan } from "../network/__fixtures__/plans";
import { ensurePreviewKey } from "../previews/keys";
import { ensureStatePassphrase } from "../shared/secret-files";
import { updateServerAddresses } from "../shared/server-record";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  createTestPhaseDeps,
  FakeEngine,
  ownPlan,
  plainState,
  previewTestPlan,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { type OwnHostPlanInput, rotateSshKey, type SshKeyGitHub, type SshKeyName } from "./keys";
import { bareKey } from "./keys-files";
import { addKeyScript, keyHolders, removeKeyScript } from "./keys-servers";
import { credentialsRecordFile } from "./record";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const APP = "203.0.113.10";
const DATA = "203.0.113.20";
const REPOSITORY = "acme/shop";
const RUN_URL = "https://github.com/acme/shop/actions/runs/7";

/** `command` in a real `sh` with `home` as the deploy user's home. */
function sh(command: string, home: string, input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env: { ...process.env, HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

/**
 * Servers whose deploy user's authorized_keys is a real file, reached over a fake SSH that lets in
 * only a key listed there (its `.pub` beside the private key file says which), runs a restricted
 * line's forced command whatever is asked, and runs anything else in a real `sh`.
 */
class FakeServers {
  readonly homes = new Map<string, string>();
  /** Hosts that do not answer. */
  readonly offline = new Set<string>();
  /** Hosts whose scripts fail (a full disk). */
  readonly failing = new Set<string>();
  /** Hosts whose forced commands fail. */
  readonly forcedFails = new Set<string>();
  /** Every login: the host and the key file. */
  readonly logins: { host: string; keyFile: string }[] = [];

  constructor(private readonly dir: string) {}

  async add(host: string, lines: readonly string[]): Promise<void> {
    const home = join(this.dir, host).replaceAll("\\", "/");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(join(home, ".ssh", "authorized_keys"), `${lines.join("\n")}\n`);
    this.homes.set(host, home);
  }

  async keys(host: string): Promise<string[]> {
    const text = await readFile(
      join(this.homes.get(host) as string, ".ssh", "authorized_keys"),
      "utf8",
    );
    return text.split("\n").filter((line) => line !== "");
  }

  async set(host: string, lines: readonly string[]): Promise<void> {
    await this.add(host, lines);
  }

  remote = (host: string, keyFile: string): RemoteExec => ({
    host,
    run: async (command, options) => {
      if (this.offline.has(host) || !this.homes.has(host)) {
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host: Connection timed out" };
      }
      const key = bareKey(await readFile(`${keyFile}.pub`, "utf8"));
      const line = (await this.keys(host)).find((each) => each.includes(key));
      if (line === undefined) {
        return { exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." };
      }
      this.logins.push({ host, keyFile });
      if (line.startsWith('restrict,command="')) {
        if (this.forcedFails.has(host)) return { exitCode: 1, stdout: "", stderr: "" };
        if (!line.includes("opscrew-preview")) {
          return { exitCode: 0, stdout: "Filesystem 1-blocks Used\n/dev/sda1 50% /\n", stderr: "" };
        }
        return command === "list"
          ? { exitCode: 0, stdout: "opscrew-preview: listed 0\n", stderr: "" }
          : { exitCode: 2, stdout: "opscrew-preview: refused command\n", stderr: "" };
      }
      if (this.failing.has(host)) {
        return { exitCode: 1, stdout: "", stderr: "No space left on device" };
      }
      return sh(command, this.homes.get(host) as string, options?.input);
    },
  });
}

/** GitHub's secrets and workflow runs. */
class FakeGitHub {
  /** By `<environment>/<name>` (`/<name>` for a repository secret). */
  readonly secrets = new Map<string, string>();
  readonly dispatched: string[] = [];
  conclusion = "success";
  status: "completed" | "waiting" = "completed";
  failSecrets = false;
  /** Runs while a workflow is dispatched: what the servers hold then. */
  onDispatch: () => Promise<void> = async () => {};

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
    if (this.failSecrets) throw new OpsCrewError("PROVIDER_ERROR", "GitHub answered 502.");
    this.secrets.set(`${environment}/${name}`, value);
  }
  async dispatchWorkflow(
    _owner: string,
    _repo: string,
    file: string,
    ref: string,
    _inputs: Record<string, string>,
    onAccepted?: () => Promise<void>,
  ) {
    this.dispatched.push(`${file}@${ref}`);
    await onAccepted?.();
    await this.onDispatch();
    return { runId: 7, url: RUN_URL };
  }
  async waitForWorkflowRun() {
    return {
      id: 7,
      status: this.status,
      conclusion: this.status === "waiting" ? null : this.conclusion,
      htmlUrl: RUN_URL,
      headSha: "abc1234def",
    };
  }
}

/** A world: deps, plan, servers, GitHub, and the own servers' host plans. */
interface World {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  servers: FakeServers;
  github: FakeGitHub;
  /** The own server's host plans asked, in order. */
  hostPlans: OwnHostPlanInput[];
  /** The deploy keys the own server holds (`own` hosts in `servers` are set by the host plan). */
  run: (which: SshKeyName) => ReturnType<typeof rotateSshKey>;
}

async function world(
  plan: DeployPlan,
  options: { environment?: string; answer?: ScriptedApprovalHandler; engine?: IacEngine } = {},
): Promise<World> {
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.answer === undefined ? {} : { approvalHandler: options.answer }),
  });
  // A plan of another environment is not written there (a refusal reads none).
  if ((plan.environment?.name ?? "prod") === deps.paths.environment) {
    await writeArtifact("plan", deps.paths.files.plan, plan);
  }
  const servers = new FakeServers(await mkdtemp(join(deps.paths.root, "servers-")));
  const github = new FakeGitHub();
  const hostPlans: OwnHostPlanInput[] = [];
  const api = github as unknown as SshKeyGitHub["api"];
  return {
    deps,
    plan,
    servers,
    github,
    hostPlans,
    run: (which) =>
      rotateSshKey(deps, plan, which, {
        github: { api, owner: "acme", repo: "shop", defaultBranch: "main" },
        remote: servers.remote,
        ownHostPlan: async (input) => {
          hostPlans.push(input);
          // As the host plan's deploy-key step does: exactly the keys given.
          await servers.set(DATA, [
            input.deployKey,
            ...(input.previousDeployKey === undefined ? [] : [input.previousDeployKey]),
          ]);
        },
        ...(options.engine === undefined
          ? {}
          : { engine: async () => options.engine as IacEngine }),
      }),
  };
}

/** The app on its Hetzner server and Postgres on server `data` (Hetzner, or the user's own). */
async function split(
  data: "cloud" | "own" = "cloud",
  answer?: ScriptedApprovalHandler,
  engine?: IacEngine,
) {
  const { plan: networkedPlan } = networked(splitPlan({ data }), {
    app: { udpPortsInUse: [], wireguardInterfaces: [] },
    data: { udpPortsInUse: [], wireguardInterfaces: [] },
  });
  const plan = DeployPlanSchema.parse({
    ...networkedPlan,
    deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z" },
  });
  const w = await world(plan, {
    ...(answer === undefined ? {} : { answer }),
    ...(engine === undefined ? {} : { engine }),
  });
  await updateServerAddresses(w.deps.paths, () => ({
    schemaVersion: 1,
    deployment: { ipv4: APP },
    servers: { data: { ipv4: DATA } },
    ...(data === "own"
      ? { ownServers: { data: { host: DATA, port: 22, user: "admin", agent: true } } }
      : {}),
  }));
  const key = await ensureDeployKey(w.deps.paths, w.deps.redactor);
  await w.servers.add(APP, [key.publicKeyOpenSsh]);
  await w.servers.add(DATA, [key.publicKeyOpenSsh]);
  return { ...w, old: key };
}

async function deployKeyNow(w: World): Promise<string> {
  return (await readFile(w.deps.paths.files.deployKeyPub, "utf8")).trim();
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The private key's base64 lines, each of which no output may hold. */
function keyLines(privateKey: string): string[] {
  return privateKey.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
}

describe("rotateSshKey: the deploy key", () => {
  it("adds the new key on every server, replaces the secret, proves it with a deploy, then removes the old one", async () => {
    const w = await split();
    const old = w.old.publicKeyOpenSsh;
    const atDispatch: string[][] = [];
    w.github.onDispatch = async () => {
      atDispatch.push(await w.servers.keys(APP), await w.servers.keys(DATA));
    };
    const result = await w.run("deploy-key");

    const fresh = await deployKeyNow(w);
    expect(fresh).not.toBe(old);
    expect(fresh).toMatch(/^ssh-ed25519 \S+ opscrew-deploy@/);
    // Both keys on both servers while the deploy proved the new one; only the new one after.
    expect(atDispatch).toEqual([
      [old, fresh],
      [old, fresh],
    ]);
    expect(await w.servers.keys(APP)).toEqual([fresh]);
    expect(await w.servers.keys(DATA)).toEqual([fresh]);
    const privateKey = await readFile(w.deps.paths.files.deployKey, "utf8");
    const secret = deploySecretName(w.plan, DEPLOY_SECRETS.sshKey);
    expect(w.github.secrets.get(`/${secret}`)).toBe(privateKey);
    expect(w.github.dispatched).toEqual(["opscrew-deploy.yml@main"]);
    // The old key added the new one; the new one removed the old one.
    expect(w.servers.logins.map((login) => login.keyFile)).toEqual([
      w.deps.paths.files.deployKey,
      w.deps.paths.files.deployKey,
      w.deps.paths.files.deployKey,
      w.deps.paths.files.deployKey,
    ]);
    expect(await exists(`${w.deps.paths.files.deployKey}.next`)).toBe(false);
    expect(await exists(`${w.deps.paths.files.deployKey}.previous.pub`)).toBe(false);

    const handler = w.deps.approvalHandler as ScriptedApprovalHandler;
    const request = handler.requests.find((r) => r.kind === "remote-exec");
    expect(request?.planHash).toBe(result.hash);
    expect(request?.details).toContain("the app's server and server data over SSH");
    expect(request?.details).toContain(`GitHub's secret ${secret} of acme/shop is replaced`);
    expect(request?.details).toContain(`Rotation hash: ${result.hash}`);
    expect(handler.requests.filter((r) => r.kind === "remote-exec")).toHaveLength(1);

    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(record.environments.prod?.["deploy-key"]).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    expect(result.copy.changed).toBe(false);
    // No key material in any output, audit entry or approval.
    const said = [
      w.deps.reporter.text(),
      JSON.stringify(w.deps.audit.entries),
      JSON.stringify(handler.requests),
    ].join("\n");
    for (const line of [...keyLines(privateKey), ...keyLines(w.old.privateKeyOpenSsh)]) {
      expect(said).not.toContain(line);
    }
    expect(w.deps.redactor.redact(privateKey)).not.toContain(keyLines(privateKey)[0]);
  });

  it("then replaces the provider's copy of the deploy key in its own approved plan", async () => {
    const engine = new FakeEngine({
      changes: [
        {
          address: "module.server.hcloud_ssh_key.deploy[0]",
          type: "hcloud_ssh_key",
          name: "deploy",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "replace",
        },
      ],
    });
    const w = await split("cloud", undefined, engine);
    await ensureStatePassphrase(w.deps.paths);
    await mkdir(w.deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(tfstateFile(w.deps.paths), plainState([]));
    // The root's committed variables, where the new key goes before the plan.
    const tfvars = join(w.deps.paths.root, w.plan.infra.dir, "terraform.tfvars.json");
    await mkdir(dirname(tfvars), { recursive: true });
    await writeFile(
      tfvars,
      `${JSON.stringify({ deploy_ssh_public_key: w.old.publicKeyOpenSsh })}\n`,
    );
    let keysAtApply: string[] = [];
    const apply = engine.apply.bind(engine);
    engine.apply = async (...args) => {
      keysAtApply = await w.servers.keys(APP);
      return apply(...args);
    };
    await w.run("deploy-key");
    const handler = w.deps.approvalHandler as ScriptedApprovalHandler;
    expect(handler.requests.map((r) => r.kind)).toEqual(["remote-exec", "iac-apply"]);
    expect(handler.requests[1]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    // Only once the new key proved itself and the old one left the servers.
    expect(keysAtApply).toEqual([await deployKeyNow(w)]);
    expect(engine.applied).toHaveLength(1);
    expect(JSON.parse(await readFile(tfvars, "utf8"))).toEqual({
      deploy_ssh_public_key: await deployKeyNow(w),
    });
  });

  it("goes through the host plan on the user's own server: both keys, then the new one only", async () => {
    const w = await split("own");
    const old = w.old.publicKeyOpenSsh;
    let held: string[] = [];
    w.github.onDispatch = async () => {
      held = await w.servers.keys(DATA);
    };
    await w.run("deploy-key");
    const fresh = await deployKeyNow(w);
    expect(w.hostPlans).toEqual([
      { server: "data", deployKey: fresh, previousDeployKey: old },
      { server: "data", deployKey: fresh },
    ]);
    expect(held).toEqual([fresh, old]);
    expect(await w.servers.keys(DATA)).toEqual([fresh]);
    // Only the app's server, which OpsCrew created, is changed over SSH.
    expect(new Set(w.servers.logins.map((login) => login.host))).toEqual(new Set([APP]));
  });

  it("leaves both keys working when a server does not answer, and goes on with the same key", async () => {
    const w = await split();
    const old = w.old.publicKeyOpenSsh;
    w.servers.offline.add(DATA);
    const error = await failure(w.run("deploy-key"));
    expect(error.message).toMatch(/server data did not answer over SSH/);
    expect(error.message).toMatch(/The old key still works beside the new one: nothing removed it/);
    expect(error.hint).toContain("run `opscrew rotate deploy-key` again");
    expect(await deployKeyNow(w)).toBe(old);
    expect(await w.servers.keys(DATA)).toEqual([old]);
    expect((await w.servers.keys(APP))[0]).toBe(old);
    expect(w.github.secrets.size).toBe(0);
    expect(w.github.dispatched).toEqual([]);

    w.servers.offline.delete(DATA);
    const handler = w.deps.approvalHandler as ScriptedApprovalHandler;
    const first = handler.requests.at(-1)?.planHash;
    const result = await w.run("deploy-key");
    expect(result.hash).toBe(first);
    const fresh = await deployKeyNow(w);
    expect(await w.servers.keys(APP)).toEqual([fresh]);
    expect(await w.servers.keys(DATA)).toEqual([fresh]);
  });

  it("removes nothing when GitHub's secret can't be replaced", async () => {
    const w = await split();
    w.github.failSecrets = true;
    const error = await failure(w.run("deploy-key"));
    expect(error.message).toMatch(/GitHub answered 502\. The old key still works/);
    expect(await w.servers.keys(APP)).toContain(w.old.publicKeyOpenSsh);
    expect(await w.servers.keys(DATA)).toContain(w.old.publicKeyOpenSsh);
    expect(w.github.dispatched).toEqual([]);
    expect(await deployKeyNow(w)).toBe(w.old.publicKeyOpenSsh);
  });

  it("removes nothing when the deploy fails or waits for a reviewer", async () => {
    for (const fail of ["failure", "waiting"] as const) {
      const w = await split();
      if (fail === "waiting") w.github.status = "waiting";
      else w.github.conclusion = "failure";
      const error = await failure(w.run("deploy-key"));
      expect(error.message).toMatch(
        fail === "waiting"
          ? /waits in GitHub for a required reviewer/
          : /did not succeed \(failure\)/,
      );
      expect(error.message).toMatch(/The old key still works beside the new one/);
      expect(await w.servers.keys(APP)).toHaveLength(2);
      expect(await w.servers.keys(DATA)).toHaveLength(2);
      expect(await deployKeyNow(w)).toBe(w.old.publicKeyOpenSsh);
      expect(await exists(`${w.deps.paths.files.deployKey}.next`)).toBe(true);
    }
  });

  it("changes nothing when the plan is not approved, and names its hash for a script", async () => {
    const w = await split("cloud", new ScriptedApprovalHandler(() => false));
    const error = await failure(w.run("deploy-key"));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toMatch(/Nothing on the servers or in GitHub was changed/);
    const hash = (w.deps.approvalHandler as ScriptedApprovalHandler).requests[0]?.planHash;
    expect(error.hint).toContain(`--approve ${hash}`);
    expect(await w.servers.keys(APP)).toEqual([w.old.publicKeyOpenSsh]);
    expect(w.github.secrets.size).toBe(0);
  });

  it("keeps the old key where the removal stopped, and removes it when run again", async () => {
    const w = await split();
    w.github.onDispatch = async () => {
      w.servers.failing.add(DATA);
    };
    const error = await failure(w.run("deploy-key"));
    const fresh = await deployKeyNow(w);
    expect(error.message).toMatch(/could not remove the old deploy key on server data/);
    expect(error.message).toMatch(/The new deploy key is in place and works/);
    expect(error.hint).toContain("run `opscrew rotate deploy-key` again to remove it");
    expect(await w.servers.keys(APP)).toEqual([fresh]);
    expect(await w.servers.keys(DATA)).toEqual([w.old.publicKeyOpenSsh, fresh]);

    w.servers.failing.delete(DATA);
    w.github.onDispatch = async () => {};
    await w.run("deploy-key");
    expect(await w.servers.keys(DATA)).toEqual([fresh]);
    // The second run only removed: no second deploy; the same plan, its text the steps left.
    expect(w.github.dispatched).toHaveLength(1);
    const requests = (w.deps.approvalHandler as ScriptedApprovalHandler).requests.filter(
      (r) => r.kind === "remote-exec",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.details).toMatch(/is in place and proved itself/);
    expect(requests[1]?.planHash).toBe(requests[0]?.planHash);
    expect(await exists(`${w.deps.paths.files.deployKey}.previous.pub`)).toBe(false);
  });

  it("is refused in a preview environment, whose GitHub secret is the preview key", async () => {
    const w = await world(previewTestPlan(), { environment: "preview" });
    const error = await failure(w.run("deploy-key"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("preview-key");
  });
});

describe("rotateSshKey: the scheduled check's key", () => {
  async function checked() {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      observability: { ...base.observability, check: { enabled: true } },
    });
    const w = await world(plan);
    await updateServerAddresses(w.deps.paths, () => ({
      schemaVersion: 1,
      deployment: { ipv4: APP },
    }));
    const deploy = await ensureDeployKey(w.deps.paths, w.deps.redactor);
    const check = await ensureCheckKey(w.deps.paths, w.deps.redactor);
    const oldLine = checkKeyLine(check.publicKeyOpenSsh, REPOSITORY);
    await w.servers.add(APP, [deploy.publicKeyOpenSsh, oldLine]);
    return { ...w, deploy, check, oldLine };
  }

  it("keeps its restricted line, proves it over SSH and with a check run, then removes the old line", async () => {
    const w = await checked();
    let held: string[] = [];
    w.github.onDispatch = async () => {
      held = await w.servers.keys(APP);
    };
    await w.run("check-key");
    const now = (await readFile(w.deps.paths.files.checkKey, "utf8")).trim();
    const fresh = (await ensureCheckKey(w.deps.paths, w.deps.redactor)).publicKeyOpenSsh;
    expect(fresh).not.toBe(w.check.publicKeyOpenSsh);
    expect(held).toEqual([w.deploy.publicKeyOpenSsh, w.oldLine, checkKeyLine(fresh, REPOSITORY)]);
    expect(await w.servers.keys(APP)).toEqual([
      w.deploy.publicKeyOpenSsh,
      checkKeyLine(fresh, REPOSITORY),
    ]);
    expect(w.github.secrets.get(`/${CHECK_SECRETS.sshKey}`)?.trim()).toBe(now);
    expect(w.github.dispatched).toEqual(["opscrew-check.yml@main"]);
    // The proof logged in with the new check key, everything else with the deploy key.
    expect(w.servers.logins.map((login) => login.keyFile)).toEqual([
      w.deps.paths.files.deployKey,
      `${w.deps.paths.files.checkKey}.next`,
      w.deps.paths.files.deployKey,
    ]);
    expect(await exists(`${w.deps.paths.files.checkKey}.next.pub`)).toBe(false);
  });

  it("removes nothing when a server does not answer with the new key", async () => {
    const w = await checked();
    w.servers.forcedFails.add(APP);
    const error = await failure(w.run("check-key"));
    expect(error.message).toMatch(/did not answer the check's command over SSH with the new/);
    expect(error.message).toMatch(/The old key still works/);
    expect(await w.servers.keys(APP)).toContain(w.oldLine);
    expect(w.github.dispatched).toEqual([]);
  });

  it("removes nothing when the check run fails", async () => {
    const w = await checked();
    w.github.conclusion = "failure";
    const error = await failure(w.run("check-key"));
    expect(error.message).toMatch(/scheduled check's run did not succeed/);
    expect(await w.servers.keys(APP)).toContain(w.oldLine);
  });

  it("is the first app's prod's only", async () => {
    const w = await world(testPlan({ deployed: true }), { environment: "staging" });
    expect((await failure(w.run("check-key"))).code).toBe("INVALID_INPUT");
  });

  it("goes on every server each environment's check reads over SSH, each named in the plan", async () => {
    /** `base` with the check on, in `environment` (its app `shop-<env>`) unless prod. */
    const on = (base: DeployPlan, environment?: string, more: object = {}) =>
      DeployPlanSchema.parse({
        ...base,
        ...(environment === undefined
          ? {}
          : {
              app: { ...base.app, name: `shop-${environment}` },
              environment: { name: environment },
            }),
        observability: { ...base.observability, check: { enabled: true } },
        ...more,
      });
    const { plan: splitNetworked } = networked(splitPlan(), {
      app: { udpPortsInUse: [], wireguardInterfaces: [] },
      data: { udpPortsInUse: [], wireguardInterfaces: [] },
    });
    const prod = on(splitNetworked);
    const w = await world(prod, { answer: new ScriptedApprovalHandler(() => false) });
    const at = (environment: string) =>
      resolveProjectPaths(w.deps.paths.root, { env: w.deps.env, environment });
    const deployed = { deployment: { lastApplyAt: "2026-10-12T08:00:00.000Z" } };
    // staging's app server is read over SSH; dev is behind a tunnel, which the check's ssh
    // can't pass; old was torn down.
    await writeArtifact("plan", at("staging").files.plan, on(testPlan(), "staging", deployed));
    await writeArtifact("plan", at("dev").files.plan, on(ownPlan({ access: "tunnel" }), "dev"));
    await writeArtifact(
      "plan",
      at("old").files.plan,
      on(testPlan(), "old", {
        deployment: {
          lastApplyAt: "2026-10-01T08:00:00.000Z",
          destroyedAt: "2026-10-02T08:00:00.000Z",
        },
      }),
    );
    await ensureCheckKey(w.deps.paths, w.deps.redactor);

    const holders = await keyHolders(w.deps, prod, "check-key");
    expect(holders.map((h) => [h.deps.paths.environment, h.server, h.via, h.words])).toEqual([
      ["prod", "app", "ssh", "the app's server"],
      ["prod", "data", "ssh", "server data"],
      ["staging", "app", "ssh", "the app's server of shop-staging staging"],
    ]);
    const handler = w.deps.approvalHandler as ScriptedApprovalHandler;
    expect((await failure(w.run("check-key"))).code).toBe("APPROVAL_REFUSED");
    expect(handler.requests[0]?.details).toContain(
      "the app's server, server data and the app's server of shop-staging staging over SSH",
    );
    expect(handler.requests[0]?.details).toContain(
      `GitHub's secret ${CHECK_SECRETS.sshKey} of acme/shop is replaced`,
    );
  });
});

describe("rotateSshKey: a deploy key the deploy does not use", () => {
  it("is proven by a login from this computer when the deploy runs on the server itself", async () => {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      environment: { runner: "server" },
    });
    const w = await world(plan);
    await updateServerAddresses(w.deps.paths, () => ({
      schemaVersion: 1,
      deployment: { ipv4: APP },
    }));
    const old = await ensureDeployKey(w.deps.paths, w.deps.redactor);
    await w.servers.add(APP, [old.publicKeyOpenSsh]);
    await w.run("deploy-key");
    const fresh = await deployKeyNow(w);
    expect(await w.servers.keys(APP)).toEqual([fresh]);
    // No secret replaced and no deploy started: GitHub holds no copy of the key.
    expect(w.github.secrets.size).toBe(0);
    expect(w.github.dispatched).toEqual([]);
    expect(w.servers.logins.map((login) => login.keyFile)).toEqual([
      w.deps.paths.files.deployKey,
      `${w.deps.paths.files.deployKey}.next`,
      w.deps.paths.files.deployKey,
    ]);
    const details = (w.deps.approvalHandler as ScriptedApprovalHandler).requests[0]?.details;
    expect(details).toContain(
      "2. GitHub holds no copy of it: the deploy runs on the server itself.",
    );
    expect(details).toContain("This computer logs in to the server over SSH with the new key");
  });
});

describe("rotateSshKey: the preview key", () => {
  async function previews() {
    const plan = previewTestPlan();
    const w = await world(plan, { environment: "preview" });
    await updateServerAddresses(w.deps.paths, () => ({
      schemaVersion: 1,
      deployment: { ipv4: APP },
    }));
    const deploy = await ensureDeployKey(w.deps.paths, w.deps.redactor);
    const preview = await ensurePreviewKey(w.deps.paths, w.deps.redactor);
    const oldLine = previewKeyLine(bareKey(preview.publicKeyOpenSsh), REPOSITORY, plan.app.name);
    await w.servers.add(APP, [deploy.publicKeyOpenSsh, oldLine]);
    return { ...w, deploy, preview, oldLine };
  }

  it("goes on the preview server, proven by its check with the new key, and replaces the preview's secret", async () => {
    const w = await previews();
    await w.run("preview-key");
    const fresh = (await readFile(w.deps.paths.files.previewKeyPub, "utf8")).trim();
    const line = previewKeyLine(bareKey(fresh), REPOSITORY, w.plan.app.name);
    expect(await w.servers.keys(APP)).toEqual([w.deploy.publicKeyOpenSsh, line]);
    const secret = deploySecretName(w.plan, DEPLOY_SECRETS.sshKey);
    const stored = [...w.github.secrets.entries()].find(([place]) => place.endsWith(`/${secret}`));
    expect(stored?.[1]).toBe(await readFile(w.deps.paths.files.previewKey, "utf8"));
    expect(w.github.dispatched).toEqual([]);
    expect(w.servers.logins.map((login) => login.keyFile)).toContain(
      `${w.deps.paths.files.previewKey}.next`,
    );
  });

  it("removes nothing when the preview server's check fails with the new key", async () => {
    const w = await previews();
    w.servers.forcedFails.add(APP);
    const error = await failure(w.run("preview-key"));
    expect(error.message).toMatch(/did not answer the preview server's check/);
    expect(await w.servers.keys(APP)).toContain(w.oldLine);
    expect((await readFile(w.deps.paths.files.previewKeyPub, "utf8")).trim()).toBe(
      w.preview.publicKeyOpenSsh,
    );
  });

  it("is refused outside a preview environment", async () => {
    const w = await world(ownPlan({ deployed: true }));
    expect((await failure(w.run("preview-key"))).code).toBe("INVALID_INPUT");
  });
});

describe("the authorized_keys scripts", () => {
  it("append once, after a last line without its newline, and remove only while the new line is there", async () => {
    const home = (
      await mkdtemp(join((await createTestPhaseDeps()).paths.root, "home-"))
    ).replaceAll("\\", "/");
    await mkdir(join(home, ".ssh"));
    const file = join(home, ".ssh", "authorized_keys");
    await writeFile(file, "ssh-ed25519 AAAAold old");
    expect((await sh(addKeyScript("ssh-ed25519 AAAAnew new"), home)).exitCode).toBe(0);
    expect((await sh(addKeyScript("ssh-ed25519 AAAAnew new"), home)).exitCode).toBe(0);
    expect(await readFile(file, "utf8")).toBe("ssh-ed25519 AAAAold old\nssh-ed25519 AAAAnew new\n");
    const refused = await sh(
      removeKeyScript("ssh-ed25519 AAAAold", "ssh-ed25519 AAAAgone x"),
      home,
    );
    expect(refused.exitCode).toBe(4);
    expect(await readFile(file, "utf8")).toContain("AAAAold");
    expect(
      (await sh(removeKeyScript("ssh-ed25519 AAAAold", "ssh-ed25519 AAAAnew new"), home)).exitCode,
    ).toBe(0);
    expect(await readFile(file, "utf8")).toBe("ssh-ed25519 AAAAnew new\n");
  });
});
