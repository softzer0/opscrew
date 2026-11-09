// Feature 025 (T2515): `opscrew rotate`, its listing, its flags and the dispatch of each name to
// its rotation; `opscrew secrets rotate` moved to `opscrew rotate recovery-key`.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { credentialsRecordFile, portainerPasswordFile, refreshRecoveryCopy } from "@opscrew/agents";
import {
  createTestPhaseDeps,
  FAKE_SOPS,
  FakeEngine,
  FakeGitHub,
  FakeSops,
  ownPlan,
  ScriptedRunner,
  sitePlan,
  testPlan,
} from "@opscrew/agents/testing";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  IacRunOptions,
  RemoteExec,
} from "@opscrew/contracts";
import { resolveProjectPaths, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { CliServices } from "../deps";
import { type DeployProject, DeployRunner, deployProject } from "../ui/__fixtures__/deploy";
import {
  auditText,
  CANCEL,
  GIT,
  git,
  projectContext,
  run,
  ScriptedPrompts,
} from "../ui/__fixtures__/harness";
import { rotationApprovals } from "./rotate";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Approves everything (the scripted human). */
class ApproveAll implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-11-09T12:00:00.000Z" };
  }
}

const DB_PASSWORD = fakeSecret("generic-password", "cli-rotate-db");
const SESSION_SECRET = fakeSecret("generic-password", "cli-rotate-session");
const DEPLOY_KEY = fakeSecret("private-key-pem", "cli-rotate-deploy-key");
const HCLOUD_TOKEN = fakeSecret("hcloud-token", "cli-rotate");

/** GitHub's fake whose deploy runs, started to put new values in place, pass. */
class SiteGitHub extends FakeGitHub {
  async waitForWorkflowRun(_owner: string, _repo: string, options: { runId: number }) {
    return {
      id: options.runId,
      status: "completed" as const,
      conclusion: "success",
      htmlUrl: `https://github.com/acme/shop/actions/runs/${options.runId}`,
      headSha: "abc1234def",
    };
  }
}

/** A deployed Hetzner app (`plan`), with what provision leaves on this computer for it. */
async function setup(plan: DeployPlan = testPlan({ deployed: true, userSecret: false })) {
  project = await deployProject(plan);
  project.env.OPSCREW_SOPS_BIN = FAKE_SOPS;
  const home = resolveProjectPaths(project.root, { env: project.env }).projectHomeDir;
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "generated_values.json"),
    `${JSON.stringify({ dbPassword: DB_PASSWORD, env: { SESSION_SECRET } })}\n`,
  );
  await writeFile(path.join(home, "deploy_key"), `${DEPLOY_KEY}\n`);
  return project;
}

/** A run's context: a script unless `interactive`, GitHub faked, every approval given by default. */
function context(
  p: DeployProject,
  sops: FakeSops,
  options: {
    interactive?: boolean;
    prompts?: ScriptedPrompts;
    approvals?: ApprovalHandler | null;
    services?: CliServices;
  } = {},
) {
  const github = new FakeGitHub();
  const ctx = projectContext(p, {
    interactive: options.interactive ?? false,
    services: {
      runner: sops.runner(new DeployRunner()),
      clock: { now: () => new Date("2026-11-09T12:00:00.000Z") },
      ...(options.approvals === null
        ? {}
        : { approvalHandler: options.approvals ?? new ApproveAll() }),
      ...(options.prompts !== undefined ? { prompts: options.prompts } : {}),
      provision: { github },
      ...options.services,
    },
  });
  return { ctx, github };
}

/** The key line of a key file OpsCrew wrote. */
async function identityIn(file: string): Promise<string> {
  const line = (await readFile(file, "utf8"))
    .split("\n")
    .find((text) => text.startsWith("AGE-SECRET-KEY-1"));
  if (line === undefined) throw new Error(`no age key in ${file}`);
  return line;
}

/** The project's first recovery copy, committed (its key in `keyFile`). */
async function withCopy(p: DeployProject, sops: FakeSops) {
  const keyFile = path.join(p.dir, "age-key.txt");
  const first = await refreshRecoveryCopy(
    await createTestPhaseDeps({
      root: p.root,
      env: p.env,
      runner: sops.runner(new ScriptedRunner()),
    }),
    { app: { name: "shop" } },
    { repositoryPrivate: async () => true, keyOut: async () => keyFile },
  );
  if (!first.changed) throw new Error("expected the first copy");
  for (const file of first.repositoryFiles) {
    await mkdir(path.dirname(path.join(p.root, file.path)), { recursive: true });
    await writeFile(path.join(p.root, file.path), file.content);
  }
  await git(p.env, p.root, "add", "opscrew");
  await git(p.env, p.root, "commit", "-q", "-m", "copy");
  return { keyFile, identity: await identityIn(keyFile) };
}

const HASH = "ab".repeat(32);

/** The GitHub client a key's rotation follows its proof with. */
type RotateGitHub = NonNullable<CliServices["rotate"]>["github"];

/** The state passphrase and a plain infrastructure state, as provision leaves them here. */
async function withState(
  p: DeployProject,
  passphrase = fakeSecret("generic-password", "cli-rotate-state-file"),
) {
  const paths = resolveProjectPaths(p.root, { env: p.env });
  await mkdir(path.dirname(paths.files.statePassphrase), { recursive: true });
  await writeFile(paths.files.statePassphrase, `${passphrase}\n`);
  await mkdir(path.dirname(tfstateFile(paths)), { recursive: true });
  await writeFile(tfstateFile(paths), `${JSON.stringify({ version: 4, resources: [] })}\n`);
  return paths;
}

/**
 * An engine whose state opens with the current passphrase `current` until a plan rewrote it, and
 * with the new one alone from then on.
 */
class RewritingEngine extends FakeEngine {
  constructor(private readonly current: string) {
    super({ changes: [] });
  }
  override readonly stateResources = async (
    _file: string,
    options?: IacRunOptions,
  ): Promise<string[]> => {
    const withCurrent = (options?.env?.TF_ENCRYPTION ?? "").includes(this.current);
    if (withCurrent !== (this.applied.length === 0)) throw new Error("Failed to decrypt the state");
    return [];
  };
}

describe("opscrew rotate", () => {
  it("lists its names, flags and examples in its help", async () => {
    const p = await setup();
    const { ctx } = context(p, new FakeSops());
    expect(await run(ctx, "rotate", "--help")).toBe(0);
    for (const text of [
      "[names...]",
      "--all",
      "--json",
      "--approve <hash>",
      "--confirm <app>",
      "--undo",
      "--qr",
      "--key-out <path>",
      "--no-backup",
      "--app <key>",
      "--env <name>",
      "opscrew rotate grant:laptop/cache",
    ]) {
      expect(ctx.output, text).toContain(text);
    }
    const secrets = context(p, new FakeSops()).ctx;
    expect(await run(secrets, "secrets", "--help")).toBe(0);
    expect(secrets.output).not.toMatch(/^\s+rotate\b/m);
  });

  it("lists every credential with how it rotates and its date, as text and JSON, recording nothing", async () => {
    const base = testPlan({ deployed: true, userSecret: false });
    const p = await setup(
      DeployPlanSchema.parse({
        ...base,
        deployment: { ...base.deployment, firstDeployAt: "2026-10-11T11:00:00.000Z" },
      }),
    );
    p.env.HCLOUD_TOKEN = HCLOUD_TOKEN;
    const paths = resolveProjectPaths(p.root, { env: p.env });
    await mkdir(path.dirname(credentialsRecordFile(paths)), { recursive: true });
    await writeFile(
      credentialsRecordFile(paths),
      "schemaVersion: 1\nenvironments:\n  prod:\n    db:\n      rotatedAt: 2026-11-01T09:00:00.000Z\n      generation: 2\n",
    );
    const { ctx } = context(p, new FakeSops());
    expect(await run(ctx, "rotate"), ctx.errors).toBe(0);
    expect(ctx.output).toContain(
      "The credentials OpsCrew made for shop in prod (`opscrew rotate <name>` rotates one):",
    );
    expect(ctx.output).toContain(
      "- db: a short swap: new connections fail for up to 31 seconds; rotated 2026-11-01, 8 days ago.",
    );
    expect(ctx.output).toContain(
      "- app:SESSION_SECRET: the app's users are logged out, or its issued tokens stop working; since the first deploy, 2026-10-11, 29 days ago.",
    );
    expect(ctx.output).toContain("- deploy-key: seamless:");
    expect(ctx.output).toContain("Your own tokens (make the new one at its provider");
    expect(ctx.output).toContain("- hetzner (HCLOUD_TOKEN): date unknown.");

    const json = context(p, new FakeSops()).ctx;
    expect(await run(json, "rotate", "--json"), json.errors).toBe(0);
    const listed = JSON.parse(json.output) as {
      app: string;
      environment: string;
      credentials: { name: string; kind: string; variable?: string }[];
    };
    expect(listed).toMatchObject({ app: "shop", environment: "prod" });
    expect(listed.credentials.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "db",
        "app",
        "app:SESSION_SECRET",
        "deploy-key",
        "hetzner",
        "github",
      ]),
    );
    expect(listed.credentials.find((c) => c.name === "hetzner")).toMatchObject({
      kind: "user-token",
      variable: "HCLOUD_TOKEN",
    });
    const said = `${ctx.output}${ctx.errors}${json.output}${json.errors}`;
    for (const secret of [DB_PASSWORD, SESSION_SECRET, HCLOUD_TOKEN]) {
      expect(said).not.toContain(secret);
    }
    // The listing never records a token's first-seen date.
    expect(await readdir(paths.homeDir)).not.toContain("token-dates.json");
  });

  it("refuses flags that don't go with the names, before anything is read", async () => {
    const p = await setup();
    const cases: [string[], string][] = [
      [["--json", "db"], "--json goes only with the list"],
      [["db", "--qr"], "--qr goes only with network and device:<name>"],
      [["tunnel-token", "--approve", HASH], "rotates only in a terminal"],
      [["network", "db"], "network rotates on its own"],
      [["vault:db"], "vault:db is not a name `opscrew rotate` takes."],
      [["grant:laptop"], "grant:laptop is not a name"],
      [["deploy-key", "--undo"], "--undo goes only with services, app secrets and device logins"],
      [["--undo"], "--undo goes with a rotation: name the credential to rotate."],
      [["--all", "db"], "Use either --all or the names to rotate."],
      [
        ["db", "--key-out", "key.txt"],
        "--key-out, --backup and --no-backup go only with recovery-key",
      ],
      [["db", "--approve", "not-a-hash"], "--approve expects the 64-character SHA-256 hash"],
      [
        ["network", "--confirm", "shop"],
        "--confirm goes only with the app's secrets, access-token and deploy-key",
      ],
      // --yes publishes a rotation's record, so it needs a rotation.
      [["--yes"], "--yes goes with a rotation: name the credential to rotate."],
      [["db", "--drop-previous"], "--drop-previous goes only with app"],
    ];
    for (const [args, error] of cases) {
      const { ctx } = context(p, new FakeSops());
      expect(await run(ctx, "rotate", ...args), args.join(" ")).toBe(2);
      expect(ctx.errors, args.join(" ")).toContain(error);
    }
  });

  it.skipIf(GIT === undefined)(
    "takes each name to its own rotation, which refuses what the environment does not have",
    async () => {
      const p = await setup();
      const cases: [string[], string][] = [
        [["cache"], "cache is no service of shop. Nothing was changed."],
        [["network"], "shop has no private network, so it has no WireGuard key to rotate."],
        [["device:phone"], "Device phone is not on shop's private network"],
        [["access-token"], "prod has no Cloudflare Access service token"],
        [["tunnel-token"], "prod has no Cloudflare Tunnel, so it has no tunnel token."],
        [["portainer"], "OpsCrew did not install Portainer for prod"],
        [["beszel"], "Beszel is off in prod, so it has no credentials to rotate."],
        [["hetzner"], "HCLOUD_TOKEN is not set, so there is no new"],
        [["app:STRIPE_SECRET_KEY"], "STRIPE_SECRET_KEY is no secret OpsCrew generated for shop"],
      ];
      for (const [args, error] of cases) {
        const { ctx } = context(p, new FakeSops());
        expect(await run(ctx, "rotate", ...args), args.join(" ")).not.toBe(0);
        expect(ctx.errors, args.join(" ")).toContain(error);
      }
    },
  );

  it("--yes approves only the record's push and pull request, never a rotation's plan", async () => {
    const p = await setup();
    const asked: ApprovalRequest[] = [];
    const base: ApprovalHandler = {
      request: async (request) => {
        asked.push(request);
        return { approved: false, approver: "test", decidedAt: "2026-11-09T12:00:00.000Z" };
      },
    };
    const { ctx } = context(p, new FakeSops());
    const handler = rotationApprovals(ctx, { hashes: [], confirm: undefined, yes: true })(base, {
      now: () => new Date("2026-11-09T12:00:00.000Z"),
    });
    for (const kind of ["git-push", "pull-request"] as const) {
      expect((await handler.request({ kind, title: kind, details: "" })).approved, kind).toBe(true);
    }
    const rotations = [
      "github-secrets",
      "remote-exec",
      "iac-apply",
      "host-apply",
      "stack-apply",
      "cloudflare-apply",
    ] as const;
    for (const kind of rotations) {
      const request = { kind, title: kind, details: "", planHash: HASH };
      expect((await handler.request(request)).approved, kind).toBe(false);
    }
    expect(asked.map((request) => request.kind)).toEqual([...rotations]);
  });

  it.skipIf(GIT === undefined)(
    "rotates the state passphrase in a script: refused with its plan's hash, stepped back from with --undo, then a saved plan applied by its hash",
    async () => {
      const p = await setup();
      const sops = new FakeSops();
      await withCopy(p, sops);
      const passphrase = fakeSecret("generic-password", "cli-rotate-state");
      const paths = await withState(p, passphrase);
      const engine = new RewritingEngine(passphrase);
      const services = { provision: { github: new FakeGitHub(), engine: async () => engine } };

      // Refused, then stepped back from with --undo: the new passphrase is gone.
      const next = `${paths.files.statePassphrase}.next`;
      const stepped = context(p, sops, { approvals: null, services });
      expect(await run(stepped.ctx, "rotate", "state-passphrase")).toBe(1);
      expect(stepped.ctx.errors).toContain(
        "To step back instead, run `opscrew rotate state-passphrase --undo`.",
      );
      const undone = context(p, sops, { approvals: null, services });
      expect(await run(undone.ctx, "rotate", "state-passphrase", "--undo"), undone.ctx.errors).toBe(
        0,
      );
      await expect(stat(next)).rejects.toThrow();

      const first = context(p, sops, { approvals: null, services });
      expect(await run(first.ctx, "rotate", "state-passphrase")).toBe(1);
      const hash = /--approve ([0-9a-f]{64}) added/.exec(first.ctx.errors)?.[1] as string;
      expect(first.ctx.errors).toContain(
        `To apply this saved plan in a script, run \`opscrew rotate state-passphrase\` again with the flags you gave (each --approve <hash> too) and --approve ${hash} added.`,
      );
      expect(await readFile(paths.files.statePassphrase, "utf8")).toBe(`${passphrase}\n`);

      const second = context(p, sops, { approvals: null, services });
      const code = await run(second.ctx, "rotate", "state-passphrase", "--approve", hash, "--yes");
      expect(code, second.ctx.errors).toBe(0);
      // One plan per refused run; the approved run applied the saved one.
      expect(engine.calls.filter((call) => call === "plan")).toHaveLength(2);
      expect(engine.applied.map((applied) => applied.approval.approvedPlanHash)).toEqual([hash]);
      expect((await readFile(paths.files.statePassphrase, "utf8")).trim()).not.toBe(passphrase);
      expect(`${first.ctx.output}${first.ctx.errors}${second.ctx.output}`).not.toContain(
        passphrase,
      );
    },
  );

  it.skipIf(GIT === undefined)(
    "rotates the deploy key on Hetzner in a script: refused with the provider plan's hash, then finished with both hashes and --confirm",
    async () => {
      const p = await setup();
      const sops = new FakeSops();
      await withCopy(p, sops);
      const paths = await withState(p);
      await writeFile(
        paths.files.deployKeyPub,
        `ssh-ed25519 ${randomBytes(32).toString("base64")} opscrew-deploy@old\n`,
      );
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
      // The deploy user's shell on the server takes every key script; the deploy run passes.
      const remote = (host: string): RemoteExec => ({
        host,
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      const services: CliServices = {
        provision: { github: new FakeGitHub(), engine: async () => engine, remote },
        rotate: { github: new SiteGitHub() as unknown as RotateGitHub },
      };
      const script = (...args: string[]) => {
        const { ctx } = context(p, sops, { approvals: null, services });
        return run(ctx, "rotate", "deploy-key", ...args).then((code) => ({ code, ctx }));
      };

      // The rotation's own plan names its hash.
      const start = await script();
      expect(start.code).toBe(1);
      const rotation = /--approve ([0-9a-f]{64})/.exec(start.ctx.errors)?.[1] as string;

      // Run 1: the key is replaced on the server; the provider's copy is refused with its hash.
      const first = await script("--approve", rotation);
      expect(first.code).toBe(1);
      const provider = /--approve ([0-9a-f]{64}) --confirm shop added/.exec(
        first.ctx.errors,
      )?.[1] as string;
      expect(provider).not.toBe(rotation);
      expect(first.ctx.errors).toContain(
        `To apply this saved plan in a script, run \`opscrew rotate deploy-key\` again with the flags you gave (each --approve <hash> too) and --approve ${provider} --confirm shop added.`,
      );
      expect(first.ctx.errors).not.toContain("Then run");

      // Run 2: both hashes and the app's name; the saved plan is applied, none made again.
      const second = await script(
        "--approve",
        rotation,
        "--approve",
        provider,
        "--confirm",
        "shop",
        "--yes",
      );
      expect(second.code, second.ctx.errors).toBe(0);
      expect(engine.calls.filter((call) => call === "plan")).toHaveLength(1);
      expect(engine.applied.map((applied) => applied.approval.approvedPlanHash)).toEqual([
        provider,
      ]);
    },
  );

  it.skipIf(GIT === undefined)(
    "replaces the Access token in a script by the saved plan the refused run named",
    async () => {
      const p = await setup(ownPlan({ access: "tunnel", deployed: true }));
      const sops = new FakeSops();
      await withCopy(p, sops);
      await withState(p);
      const engine = new FakeEngine({
        changes: [
          {
            address: "module.access.cloudflare_zero_trust_access_service_token.ssh[0]",
            type: "cloudflare_zero_trust_access_service_token",
            name: "ssh",
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            action: "replace",
          },
        ],
        outputs: {
          deploy_service_token_client_id: randomBytes(16).toString("hex"),
          deploy_service_token_client_secret: randomBytes(32).toString("hex"),
        },
      });
      const services: CliServices = {
        provision: { github: new FakeGitHub(), engine: async () => engine },
      };
      const script = (...args: string[]) => {
        const { ctx } = context(p, sops, { approvals: null, services });
        return run(ctx, "rotate", "access-token", ...args).then((code) => ({ code, ctx }));
      };
      const first = await script();
      expect(first.code).toBe(1);
      const hash = /--approve ([0-9a-f]{64}) --confirm shop added/.exec(
        first.ctx.errors,
      )?.[1] as string;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      const second = await script("--approve", hash, "--confirm", "shop", "--yes");
      expect(second.code, second.ctx.errors).toBe(0);
      expect(engine.calls.filter((call) => call === "plan")).toHaveLength(1);
      expect(engine.applied.map((applied) => applied.approval.approvedPlanHash)).toEqual([hash]);
    },
  );

  it("forgets an add-on's rotation that was never approved with --undo, and refuses otherwise", async () => {
    const p = await setup();
    const none = context(p, new FakeSops()).ctx;
    expect(await run(none, "rotate", "monitoring", "--undo")).toBe(1);
    expect(none.errors).toContain(
      "No rotation of monitoring is unfinished in prod, so there is nothing to undo.",
    );

    const home = resolveProjectPaths(p.root, { env: p.env }).projectHomeDir;
    const pending = path.join(home, "pending_rotation.json");
    const pair = {
      old: fakeSecret("generic-password", "cli-grafana-old"),
      new: fakeSecret("generic-password", "cli-grafana-new"),
    };
    const write = (step: string) =>
      writeFile(
        pending,
        `${JSON.stringify({
          names: ["monitoring"],
          services: { monitoring: { grafanaAdminPassword: pair } },
          hash: "0".repeat(64),
          step,
        })}\n`,
      );
    await write("switched");
    const begun = context(p, new FakeSops()).ctx;
    expect(await run(begun, "rotate", "monitoring", "--undo")).toBe(1);
    expect(begun.errors).toContain("an add-on's rotation only goes forward, so it can't be undone");
    expect(begun.errors).toContain("`opscrew rotate monitoring` to finish it");

    await write("planned");
    const planned = context(p, new FakeSops()).ctx;
    expect(await run(planned, "rotate", "monitoring", "--undo"), planned.errors).toBe(0);
    expect(planned.output).toContain("Forgot the rotation of monitoring in prod");
    await expect(stat(pending)).rejects.toThrow();
    const said = `${begun.output}${begun.errors}${planned.output}${planned.errors}`;
    expect(said).not.toContain(pair.old);
    expect(said).not.toContain(pair.new);
  });

  it.skipIf(GIT === undefined)(
    "approves a rotation's plan in a script only by --approve and its hash; --yes publishes the record",
    async () => {
      const plan = DeployPlanSchema.parse({
        ...testPlan({ deployed: true, userSecret: false }),
        portainer: { enabled: true, version: "2.33.1", access: "local" },
      });
      const p = await setup(plan);
      const paths = resolveProjectPaths(p.root, { env: p.env });
      const current = fakeSecret("generic-password", "cli-portainer-current");
      await writeFile(portainerPasswordFile(paths), `${current}\n`);
      const inputs: string[] = [];
      const remote = (host: string): RemoteExec => ({
        host,
        run: async (_command, options) => {
          inputs.push(options?.input ?? "");
          return { exitCode: 0, stdout: "opscrew-rotate: portainer changed\n", stderr: "" };
        },
      });
      const github = new FakeGitHub();
      const services: CliServices = { provision: { github, remote } };

      // --yes never approves the rotation's own plan.
      const refused = context(p, new FakeSops(), { approvals: null, services }).ctx;
      expect(await run(refused, "rotate", "portainer", "--yes")).toBe(1);
      const hash = /--approve ([0-9a-f]{64})/.exec(refused.errors)?.[1];
      expect(hash, refused.errors).toBeDefined();
      expect(inputs).toEqual([]);

      const { ctx } = context(p, new FakeSops(), { approvals: null, services });
      expect(
        await run(ctx, "rotate", "portainer", "--approve", hash as string, "--yes"),
        ctx.errors,
      ).toBe(0);
      expect(ctx.output).toContain("(approved with --approve)");
      expect(inputs.some((input) => input.startsWith(`${current}\n`))).toBe(true);
      const next = (await readFile(portainerPasswordFile(paths), "utf8")).trim();
      expect(next).not.toBe(current);
      // With --yes, the record of the rotation is pushed and proposed in the deploy pull request.
      expect(
        await git(p.env, p.bare, "show", "opscrew/deploy-setup:opscrew/credentials.yaml"),
      ).toContain("portainer:");
      expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
      const said = `${refused.output}${refused.errors}${ctx.output}${ctx.errors}${await auditText(p)}`;
      expect(said).not.toContain(current);
      expect(said).not.toContain(next);
    },
  );

  it.skipIf(GIT === undefined)(
    "takes a lossy app secret in a script only with --confirm <app> and --approve <hash>",
    async () => {
      const base = sitePlan({ render: "ssr", deployed: true });
      const plan = DeployPlanSchema.parse({
        ...base,
        app: { ...base.app, env: [{ name: "SESSION_SECRET", secret: true, source: "generated" }] },
      });
      const p = await setup(plan);
      const github = new SiteGitHub();
      const services: CliServices = { provision: { github }, rotate: { github } };

      const refused = context(p, new FakeSops(), { approvals: null, services }).ctx;
      expect(await run(refused, "rotate", "app:SESSION_SECRET")).toBe(1);
      expect(refused.errors).toContain("--confirm example-app");
      // The request is shown first, with its hash and what it costs.
      expect(refused.output).toContain("Every user of example-app is logged out");
      const hash = /Rotation hash: ([0-9a-f]{64})/.exec(refused.output)?.[1];
      expect(hash, refused.output).toBeDefined();
      expect(github.secrets.size).toBe(0);

      const hashOnly = context(p, new FakeSops(), { approvals: null, services }).ctx;
      expect(await run(hashOnly, "rotate", "app:SESSION_SECRET", "--approve", hash as string)).toBe(
        1,
      );
      expect(github.secrets.size).toBe(0);

      const { ctx } = context(p, new FakeSops(), { approvals: null, services });
      expect(
        await run(
          ctx,
          "rotate",
          "app:SESSION_SECRET",
          "--confirm",
          "example-app",
          "--approve",
          hash as string,
        ),
        ctx.errors,
      ).toBe(0);
      expect(ctx.output).toContain("(confirmed with --confirm example-app)");
      expect(github.secrets.size).toBeGreaterThan(0);
      expect(github.dispatches).toHaveLength(1);
      const said = `${refused.output}${refused.errors}${ctx.output}${ctx.errors}`;
      expect(said).not.toContain(SESSION_SECRET);
      for (const value of github.secrets.values()) expect(said).not.toContain(value);
    },
  );

  describe.skipIf(GIT === undefined)(
    "recovery-key, which took over `opscrew secrets rotate`",
    () => {
      it("writes a new key only to --key-out and proposes the copy in a pull request", async () => {
        const p = await setup();
        const sops = new FakeSops();
        const { identity } = await withCopy(p, sops);
        const keyOut = path.join(p.dir, "new-key.txt");
        const { ctx, github } = context(p, sops);
        expect(await run(ctx, "rotate", "recovery-key", "--key-out", keyOut), ctx.errors).toBe(0);

        const fresh = await identityIn(keyOut);
        expect(fresh).not.toBe(identity);
        expect(ctx.output).toContain(`OpsCrew wrote your new age key to ${keyOut}.`);
        expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
        expect(ctx.output).toContain("Pull request: https://github.com/acme/shop/pull/7");
        expect(
          await git(p.env, p.root, "show", "opscrew/deploy-setup:opscrew/credentials.yaml"),
        ).toContain("recovery-key:");
        expect(`${ctx.output}${ctx.errors}${await auditText(p)}`).not.toContain(fresh);
      });

      it("asks for the key file in a terminal and refuses a script without --key-out", async () => {
        const p = await setup();
        const sops = new FakeSops();
        await withCopy(p, sops);
        const script = context(p, sops).ctx;
        expect(await run(script, "rotate", "recovery-key")).toBe(2);
        expect(script.errors).toContain("OpsCrew never prints a key");
        expect(script.errors).toContain("`opscrew rotate recovery-key` in a terminal");

        const cancel = context(p, sops, {
          interactive: true,
          prompts: new ScriptedPrompts([CANCEL]),
        }).ctx;
        expect(await run(cancel, "rotate", "recovery-key")).toBe(1);
        expect(cancel.errors).toContain("You cancelled the key rotation, so nothing was written.");

        const keyOut = path.join(p.dir, "asked-key.txt");
        const prompts = new ScriptedPrompts([keyOut]);
        const asked = context(p, sops, { interactive: true, prompts }).ctx;
        expect(await run(asked, "rotate", "recovery-key", "--no-backup"), asked.errors).toBe(0);
        expect(prompts.calls[0]?.message).toContain("Where should OpsCrew write your new age key");
        expect(`${asked.output}${asked.errors}`).not.toContain(await identityIn(keyOut));
      });
    },
  );
});
