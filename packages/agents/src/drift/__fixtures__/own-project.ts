import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFacts } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { runProvision } from "../../provision/run";
import type { ProvisionServices } from "../../provision/types";
import { type OwnServerConnectionInput, recordOwnServer } from "../../shared";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeDestroyGitHub,
  FakeHostServer,
  fakeSharedCloudflare,
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
  ScriptedApprovalHandler,
  TUNNEL_CHANGES,
  tunnelOutputs,
} from "../../testing";

export { ED25519_FINGERPRINT, LAN_IPV4, OWN_IPV4 };

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
  const host = new FakeHostServer(
    o.facts ??
      (tunnel
        ? freshFacts({
            user: "alice",
            sshPorts: [2222],
            addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
          })
        : freshFacts()),
  );
  const github = new FakeDestroyGitHub();
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
    own: { host, homeDir: home },
    sharedCloudflare: fakeSharedCloudflare(),
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
