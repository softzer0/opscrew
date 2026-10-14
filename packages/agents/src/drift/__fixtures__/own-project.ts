import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { createProject, FakeGitHub } from "../../provision/__fixtures__/fakes";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakeZeroTrust,
  freshFacts,
  LAN_IPV4,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  placeholderKey,
  publicOutputs,
  TUNNEL_CHANGES,
  tunnelOutputs,
} from "../../provision/__fixtures__/own";
import { runProvision } from "../../provision/run";
import type { ProvisionServices } from "../../provision/types";
import { type OwnServerConnectionInput, recordOwnServer } from "../../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../../testing";

export { ED25519_FINGERPRINT, LAN_IPV4, OWN_IPV4 };

const ADDON = {
  installed: false,
  composeSha256: null,
  running: false,
  secretFile: false,
  dataVolume: false,
  tunnelId: null,
};

/**
 * A fake host adapter for the whole life of an own server: setup plans as provision's fake, and
 * teardown and undo plans that change only what OpsCrew set up (the app's Compose project, the
 * add-ons, the marker; then OpsCrew's host settings), as the real adapter does. Containers,
 * volumes and users that OpsCrew did not create are never touched.
 */
export class LifecycleHost extends FakeHostServer {
  override async apply(
    remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    if (plan.purpose === "setup") return super.apply(remote, plan, options);
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    const record = { plan, options } as (typeof this.applies)[number];
    this.applies.push(record);
    if (this.fail !== undefined) {
      const error = this.fail;
      this.fail = undefined;
      throw error;
    }
    const changes = plan.steps.filter((step) => step.state === "change");
    if (changes.some((step) => step.id === "sshd" || step.id === "ufw")) {
      record.verified = await options.verifyLogin();
    }
    const f = structuredClone(this.facts) as HostFacts;
    if (plan.purpose === "teardown") {
      const app = plan.app;
      f.containers = f.containers.filter((container) => container.project !== app);
      if (plan.deleteData === true) {
        f.volumeProjects = f.volumeProjects.filter((project) => project !== app);
      }
      f.dirs = f.dirs.map((dir) =>
        dir.path === "/srv/app" || (plan.deleteData === true && dir.path === "/srv/data")
          ? { ...dir, entries: 0 }
          : dir,
      );
      f.tunnel = ADDON;
      f.portainer = { ...ADDON, dataVolume: plan.deleteData === true ? false : f.portainer.dataVolume };
      f.marker = null;
    } else {
      f.deployUser = null;
      f.sshd = f.sshd === null ? null : { ...f.sshd, dropIn: null, permitRootLogin: "yes" };
      f.firewall = { ...f.firewall, ufw: "inactive", ufwRules: [] };
      f.fail2ban = { active: false, jail: null, sshdJail: false };
      f.autoUpgrades = false;
      f.dockerDaemonJson = "absent";
      f.dirs = f.dirs.map((dir) => ((dir.entries ?? 0) === 0 ? { path: dir.path, kind: "absent" } : dir));
      f.record = null;
      f.ready = false;
    }
    this.facts = HostFactsSchema.parse(f);
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}

/** GitHub fake that also deletes Actions secrets (names recorded in order). */
export class LifecycleGitHub extends FakeGitHub {
  readonly deleted: string[] = [];
  async deleteActionsSecret(_owner: string, _repo: string, name: string): Promise<void> {
    this.deleted.push(name);
    this.secrets.delete(name);
  }
}

export interface OwnProjectOptions {
  access?: "public" | "tunnel";
  plan?: DeployPlan;
  facts?: HostFacts;
  answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
}

/** Synthetic tunnel secrets (never real): the token, and the Access service token. */
export function tunnelSecrets() {
  return {
    token: `eyJ${fakeSecret("cloudflare-token", "tunnel")}`,
    clientId: `${fakeSecret("generic-password", "client-id")}.access`,
    clientSecret: fakeSecret("generic-password", "client-secret"),
  };
}

/**
 * A git project deploying to the user's own server (public mode at {@link OWN_IPV4}, or tunnel mode
 * at the LAN address {@link LAN_IPV4} with SSH on port 2222 as `alice`), with fakes for the
 * engine, the host adapter, GitHub, Cloudflare and Zero Trust. Nothing is provisioned yet.
 */
export async function ownProject(o: OwnProjectOptions = {}) {
  const tunnel = o.access === "tunnel";
  const secrets = tunnelSecrets();
  const plan = o.plan ?? ownPlan({ access: o.access ?? "public" });
  const project = await createProject(plan);
  const engine = tunnel
    ? new OwnEngine(TUNNEL_CHANGES, tunnelOutputs(secrets))
    : new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  const host = new LifecycleHost(
    o.facts ??
      (tunnel
        ? freshFacts({
            user: "alice",
            sshPorts: [2222],
            addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
          })
        : freshFacts()),
  );
  const github = new LifecycleGitHub();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const home = await mkdtemp(join(tmpdir(), "opscrew-own-day2-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const runner = ownRunner();
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner,
    approvalHandler: handler,
    interactive: false,
  });
  const own: OwnServerConnectionInput = tunnel
    ? {
        host: LAN_IPV4,
        port: 2222,
        user: "alice",
        agent: false,
        keyPath: "~/.ssh/id_ed25519",
        reachable: false,
      }
    : { host: OWN_IPV4, port: 22, user: "root", agent: true, reachable: true };
  await recordOwnServer(deps.paths, own);
  if (tunnel) await placeholderKey(home);
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, zeroTrust: fakeZeroTrust(), homeDir: home },
  };
  return { ...project, deps, engine, host, github, handler, services, runner, home, secrets };
}

export type OwnProject = Awaited<ReturnType<typeof ownProject>>;

/**
 * Provisions the project as `opscrew provision` does (both plans approved); afterwards the engine
 * plans nothing more and the fake server is prepared.
 */
export async function provisionOwn(s: OwnProject): Promise<void> {
  await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
  s.engine.changes = [];
  s.handler.requests.length = 0;
}

/** Every user-visible or persisted text a run produced (reporter and audit log). */
export function everythingPrinted(s: OwnProject): string {
  return `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
}

/** Every committed file of HEAD, the commit messages and the pull request bodies. */
export async function published(s: OwnProject): Promise<string> {
  const files = (await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
  const contents = await Promise.all(
    files.filter((f) => f !== "").map((f) => readFile(join(s.root, f), "utf8").catch(() => "")),
  );
  const log = await s.git(s.root, "log", "--format=%B");
  return [...contents, log, ...s.github.pulls.map((p) => `${p.title}\n${p.body}`)].join("\n");
}
