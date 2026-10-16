import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostApplyError,
  type HostFacts,
  HostPlanSchema,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDns } from "../dns";
import type { PortainerServices } from "../portainer";
import {
  hostPlanFile,
  type OwnServerConnectionInput,
  readOwnServer,
  readServerAddresses,
  recordOwnServer,
  recordServerAddress,
} from "../shared";
import {
  ACCOUNT_ID,
  createProject,
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  FakeGitHub,
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
  ScriptedApprovalHandler,
  TUNNEL_CHANGES,
  TUNNEL_ID,
  tunnelOutputs,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionOptions } from "./types";

const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };

interface OwnSetup {
  plan?: DeployPlan;
  own?: OwnServerConnectionInput;
  facts?: HostFacts;
  engine?: OwnEngine;
  interactive?: boolean;
  answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
  zeroTrust?: ReturnType<typeof fakeZeroTrust>;
}

async function setup(o: OwnSetup = {}) {
  const project = await createProject(o.plan ?? ownPlan());
  const engine = o.engine ?? new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  const host = new FakeHostServer(o.facts ?? freshFacts());
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const home = await mkdtemp(join(tmpdir(), "opscrew-own-home-"));
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
    interactive: o.interactive ?? false,
  });
  await recordOwnServer(
    deps.paths,
    o.own ?? { host: OWN_IPV4, port: 22, user: "root", agent: true, reachable: true },
  );
  const zeroTrust = o.zeroTrust ?? fakeZeroTrust();
  const services: PortainerServices = {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: home },
    // The account has no one-time PIN login method yet (a Portainer subdomain creates one).
    zeroTrust,
  };
  return { ...project, deps, engine, host, github, handler, services, runner, home, zeroTrust };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Every user-visible or persisted text a run produced (reporter and audit log). */
function everythingPrinted(deps: Setup["deps"]) {
  return `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
}

/** Every committed file of HEAD, the commit messages and the pull request bodies. */
async function published(s: Setup): Promise<string> {
  const files = (await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
  const contents = await Promise.all(
    files.filter((f) => f !== "").map((f) => readFile(join(s.root, f), "utf8").catch(() => "")),
  );
  const log = await s.git(s.root, "log", "--format=%B");
  return [...contents, log, ...s.github.pulls.map((p) => `${p.title}\n${p.body}`)].join("\n");
}

const kinds = (s: Setup) => s.handler.requests.map((r) => r.kind);

describe.skipIf(!findExecutable("git"))("runProvision on a server the user owns", () => {
  it("public mode: pins the host key, plans DNS and the host, applies both after approval, and keeps the address out of the repository", async () => {
    const s = await setup();
    const result = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    });

    expect(kinds(s)).toEqual([
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    // The infrastructure approval names Cloudflare and no server cost.
    const iac = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(iac?.title).toContain("on Cloudflare");
    expect(iac?.costDelta).toBeUndefined();
    expect(iac?.details).toContain("Cost: unchanged");

    // The address reaches the engine only through TF_VAR_* on every call.
    expect(s.engine.plans).toHaveLength(1);
    expect(s.engine.plans[0]?.env.TF_VAR_server_ipv4).toBe(OWN_IPV4);
    expect(s.engine.plans[0]?.env).not.toHaveProperty("TF_VAR_server_ipv6");
    for (const env of s.engine.envs) expect(env.TF_VAR_server_ipv4).toBe(OWN_IPV4);
    expect(s.engine.applies).toHaveLength(1);

    // The host plan: saved, approved by its hash, applied with that hash and verified logins.
    expect(result.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    const hostRequest = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(hostRequest?.planHash).toBe(result.hostPlanHash);
    expect(hostRequest?.title).not.toContain(OWN_IPV4);
    expect(hostRequest?.details).toContain(`Host plan hash: ${result.hostPlanHash}`);
    const saved = HostPlanSchema.parse(
      JSON.parse(await readFile(hostPlanFile(s.deps.paths, result.hostPlanHash as string), "utf8")),
    );
    expect(hostPlanHash(saved)).toBe(result.hostPlanHash);
    expect(s.host.applies).toHaveLength(1);
    const apply = s.host.applies[0];
    expect(apply?.options.approvedHash).toBe(result.hostPlanHash);
    expect(apply?.options.secrets).toEqual({});
    expect(apply?.verified).toBe(true);
    // verifyLogin opened NEW connections as deploy (deploy key) and as the admin login.
    // The first ssh call is connectOwnServer's test login; then verifyLogin's two new logins.
    const ssh = s.runner.calls.filter((c) => c.command === "ssh");
    expect(ssh[0]?.args.at(-1)).toBe("true");
    const logins = ssh.slice(1);
    expect(logins.map((c) => c.args.at(-2))).toEqual([`deploy@${OWN_IPV4}`, `root@${OWN_IPV4}`]);
    for (const call of logins) {
      expect(call.args).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]));
    }
    expect(logins[0]?.args).toEqual(expect.arrayContaining(["-i", s.deps.paths.files.deployKey]));
    expect(result).toMatchObject({ applied: true, hostApplied: true });
    expect(
      await s.deps.approvals.assertApprovedHostPlan(result.hostPlanHash as string),
    ).toBeTruthy();

    // Local state: the address and the pinned host key; never the repository.
    expect((await readServerAddresses(s.deps.paths)).deployment).toEqual({ ipv4: OWN_IPV4 });
    const own = await readOwnServer(s.deps.paths);
    expect(own).toMatchObject({ hostKey: ED25519_FINGERPRINT, publicIpv4: OWN_IPV4 });
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).toContain(
      `${OWN_IPV4} ssh-ed25519 ${ED25519}`,
    );
    const committed = await published(s);
    expect(committed).toContain("shop.example.com");
    expect(committed).not.toContain(OWN_IPV4);
    const tfvars = await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8");
    expect(tfvars).not.toContain("server_ipv4");
    expect(s.github.pulls[0]?.body).toContain("never creates, reinstalls or deletes your server");
    expect(s.github.pulls[0]?.body).toContain("backups are your responsibility");

    // Deploy secrets: the public address, and the pinned host key under that name.
    expect(s.github.secrets.get("OPSCREW_HOST")).toBe(OWN_IPV4);
    expect(s.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
      `${OWN_IPV4} ssh-ed25519 ${ED25519}\n`,
    );
    expect(s.github.secrets.has("OPSCREW_TUNNEL_SERVICE_TOKEN_ID")).toBe(false);

    // The plan records both approvals; the audit log every host step, by hash and without address.
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.approvals.map((a) => a.kind)).toEqual(["iac-apply", "host-apply"]);
    expect(plan.deployment.lastApplyAt).toBeDefined();
    const steps = s.deps.audit.entries.filter((e) => e.action.startsWith("host step "));
    expect(steps.map((e) => e.action)).toContain("host step docker");
    expect(steps.every((e) => e.target === result.hostPlanHash)).toBe(true);
    expect(JSON.stringify(s.deps.audit.entries)).not.toContain(OWN_IPV4);
    expect((await s.deps.state.read()).phases.provision?.status).toBe("ok");
  });

  it("public mode on SSH port 2222: the workflow uses the port and known_hosts holds [ip]:2222", async () => {
    const s = await setup({
      own: { host: OWN_IPV4, port: 2222, user: "root", agent: true, reachable: true },
      facts: freshFacts({ sshPorts: [2222] }),
    });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain("-o Port=2222");
    expect(s.github.secrets.get("OPSCREW_HOST")).toBe(OWN_IPV4);
    expect(s.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
      `[${OWN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    );
    const ufw = s.host.applies[0]?.plan.steps.find((step) => step.id === "ufw");
    expect(ufw?.params.sshPorts).toBe("2222");
  });

  it("public mode behind a router forwarding 2222 to sshd's 22: the deploy uses the login port", async () => {
    const s = await setup({
      own: { host: OWN_IPV4, port: 2222, user: "root", agent: true, reachable: true },
      facts: freshFacts({ sshPorts: [22] }),
    });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    // GitHub Actions reaches the public address as the user does: on the forwarded port.
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain("-o Port=2222");
    expect(s.github.secrets.get("OPSCREW_HOST")).toBe(OWN_IPV4);
    expect(s.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
      `[${OWN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    );
  });

  it("re-running on a prepared server shows no changes and changes nothing", async () => {
    const s = await setup();
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    s.engine.changes = [];
    s.github.openPull = OPEN_PULL;
    s.handler.requests.length = 0;

    const again = await runProvision(s.deps, { services: s.services });
    expect(kinds(s)).not.toContain("iac-apply");
    expect(kinds(s)).not.toContain("host-apply");
    expect(kinds(s)).not.toContain("remote-exec");
    expect(again).toMatchObject({ applied: false, hostApplied: false });
    expect(s.host.applies).toHaveLength(1);
    expect(s.engine.applies).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain("Your server is already prepared");
  });

  it("tunnel mode: confirms the host key, routes SSH to sshd's port, hands the tunnel token to the host only, and stores the service token as deploy secrets", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "tunnel")}`;
    const clientId = `${fakeSecret("generic-password", "client-id")}.access`;
    const clientSecret = fakeSecret("generic-password", "client-secret");
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      interactive: true,
      own: {
        host: LAN_IPV4,
        port: 2222,
        user: "alice",
        agent: false,
        keyPath: "~/.ssh/id_ed25519",
        reachable: false,
      },
      // A home server behind a router: port 2222 forwarded to sshd's 22.
      facts: freshFacts({
        user: "alice",
        sshPorts: [22],
        addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
      }),
      engine: new OwnEngine(TUNNEL_CHANGES, tunnelOutputs({ token, clientId, clientSecret })),
    });
    const key = await placeholderKey(s.home);
    const result = await runProvision(s.deps, { services: s.services });

    expect(kinds(s)).toEqual([
      "remote-exec",
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(s.handler.requests[0]?.details).toContain(ED25519_FINGERPRINT);
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).toContain(
      `[${LAN_IPV4}]:2222 ssh-ed25519 ${ED25519}`,
    );

    // The render: sshd's own port, the account, a new Zero Trust organization; no address.
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars).toMatchObject({
      ssh_port: 22,
      ssh_hostname: "ssh-shop.example.com",
      cloudflare_account_id: ACCOUNT_ID,
      create_zero_trust_organization: true,
    });
    expect(s.zeroTrust.asked).toEqual([ACCOUNT_ID]);
    expect(existsSync(join(s.root, "opscrew/runtime/cloudflared/compose.yaml"))).toBe(true);
    for (const env of s.engine.envs) expect(env).not.toHaveProperty("TF_VAR_server_ipv4");

    // The host plan carries the tunnel's id; the token reaches only the host adapter.
    const apply = s.host.applies[0];
    const tunnelStep = apply?.plan.steps.find((step) => step.id === "tunnel-connector");
    expect(tunnelStep?.params.tunnelId).toBe(TUNNEL_ID);
    expect(apply?.options.secrets).toEqual({ tunnelToken: token });
    expect(apply?.verified).toBe(true);
    // The first ssh call is connectOwnServer's test login; then verifyLogin's two new logins.
    const ssh = s.runner.calls.filter((c) => c.command === "ssh");
    expect(ssh[0]?.args.at(-1)).toBe("true");
    const logins = ssh.slice(1);
    expect(logins.map((c) => c.args.at(-2))).toEqual([`deploy@${LAN_IPV4}`, `alice@${LAN_IPV4}`]);
    expect(logins[1]?.args).toEqual(expect.arrayContaining(["-i", key, "-p", "2222"]));

    // Deploy secrets: the SSH hostname, the host key under it, and the Access service token.
    expect(s.github.secrets.get("OPSCREW_HOST")).toBe("ssh-shop.example.com");
    expect(s.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
      `ssh-shop.example.com ssh-ed25519 ${ED25519}\n`,
    );
    expect(s.github.secrets.get("OPSCREW_TUNNEL_SERVICE_TOKEN_ID")).toBe(clientId);
    expect(s.github.secrets.get("OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET")).toBe(clientSecret);

    // No address in the repository; no tunnel secret anywhere it could leak.
    expect((await readServerAddresses(s.deps.paths)).deployment).toBeUndefined();
    const committed = await published(s);
    expect(committed).not.toContain(LAN_IPV4);
    expect(committed).toContain("ProxyCommand");
    const printed = everythingPrinted(s.deps);
    const stored = [
      JSON.stringify(result),
      await readFile(s.deps.paths.files.plan, "utf8"),
      await readFile(hostPlanFile(s.deps.paths, result.hostPlanHash as string), "utf8"),
      committed,
      printed,
    ].join("\n");
    for (const secret of [token, clientSecret, clientId]) expect(stored).not.toContain(secret);
    expect(result.outputs).not.toHaveProperty("tunnel_token");
    expect(result.outputs.tunnel_id).toBe(TUNNEL_ID);
  });

  it("stops before any change when inspection finds a blocking problem", async () => {
    const s = await setup({
      facts: freshFacts({
        listeners: [{ proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" }],
      }),
    });
    const error = (await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("nginx on port 80");
    expect(error.message).toContain("changed nothing");
    expect(error.hint).toContain("Cloudflare Tunnel");
    expect(kinds(s)).toEqual([]);
    expect(s.engine.plans).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
    expect(existsSync(join(s.root, "opscrew/infra"))).toBe(false);
    expect((await s.deps.state.read()).phases.provision?.status).toBe("failed");
  });

  it("opscrew dns audits the server's inspection as dns and names itself to approve the host plan", async () => {
    // A blocking problem: the run stops before any change, its inspection audited as dns.
    const blocked = await setup({
      facts: freshFacts({
        listeners: [{ proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx" }],
      }),
    });
    const stop = (await runDns(blocked.deps, {
      services: blocked.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(stop.code).toBe("PHASE_PRECONDITION");
    expect(stop.message).toContain("nginx on port 80");
    // The finding says to run the command that is running again, not `opscrew provision`.
    expect(stop.hint).toMatch(/, then run opscrew dns again\.$/);
    expect(stop.hint).not.toContain("provision");
    expect(blocked.engine.plans).toHaveLength(0);
    expect(blocked.host.applies).toHaveLength(0);
    const inspected = blocked.deps.audit.entries.filter(
      (entry) => entry.action === "inspect host (read-only)",
    );
    expect(inspected.map((entry) => entry.phase)).toEqual(["dns"]);

    // A refused host plan names `opscrew dns` with its hash, and nothing on the server changes.
    const s = await setup({ answer: (request) => request.kind !== "host-apply" });
    const error = (await runDns(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      "The host plan was not approved. Nothing on your server was changed.",
    );
    expect(error.hint).toMatch(
      /^To apply it later without prompts, run: opscrew dns --approve [0-9a-f]{64}$/,
    );
    expect(s.host.applies).toHaveLength(0);
    expect(
      s.deps.audit.entries
        .filter((entry) => entry.action === "inspect host (read-only)")
        .map((entry) => entry.phase),
    ).toEqual(["dns"]);
  });

  it("asks for an explicit choice when other users log in with passwords", async () => {
    const facts = freshFacts({
      loginUsers: [
        { name: "root", uid: 0, password: false, keys: true },
        { name: "bob", uid: 1001, password: true, keys: false },
      ],
    });
    const s = await setup({ facts });
    const error = (await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("bob");
    expect(error.hint).toContain("--password-logins keep");
    expect(s.engine.plans).toHaveLength(0);

    await runProvision(s.deps, { services: s.services, passwordLogins: "keep" });
    const sshd = s.host.applies[0]?.plan.steps.find((step) => step.id === "sshd");
    expect(sshd?.params.disablePasswords).toBe(false);
  });

  it("stops when the server's architecture is not the plan's", async () => {
    const s = await setup({ plan: ownPlan({ arch: "arm64" }) });
    await expect(
      runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT }),
    ).rejects.toThrow(/builds the app for arm64, but your server is amd64/);
    expect(s.engine.plans).toHaveLength(0);
  });

  it("stops on a changed host key before anything else happens", async () => {
    const s = await setup({
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        hostKey: `SHA256:${"A".repeat(43)}`,
      },
    });
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      /host key of your server .* changed/,
    );
    expect(s.host.inspections).toBe(0);
    expect(kinds(s)).toEqual([]);
  });

  it("--plan-only prints both plans' hashes and changes nothing", async () => {
    const s = await setup();
    const result = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
      planOnly: true,
    });
    expect(result.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.applied).toBe(false);
    expect(kinds(s)).toEqual(["repo-write"]);
    expect(s.engine.applies).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
    expect(existsSync(hostPlanFile(s.deps.paths, result.hostPlanHash as string))).toBe(true);
    expect(s.github.secrets.size).toBe(0);
    expect(s.deps.reporter.text()).toContain(`Host plan hash: ${result.hostPlanHash}`);
  });

  it("--plan-only in tunnel mode says the host plan follows once the tunnel exists", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "plan-only")}`;
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      engine: new OwnEngine(
        TUNNEL_CHANGES,
        tunnelOutputs({ token, clientId: "id", clientSecret: "secret-value" }),
      ),
    });
    const result = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
      planOnly: true,
    });
    expect(result.planHash).toBeDefined();
    expect(result.hostPlanHash).toBeUndefined();
    expect(s.deps.reporter.text()).toContain("needs the Cloudflare Tunnel's id");
  });

  it("scripts approve both plans by hash with two --approve values (never --yes)", async () => {
    const approved: string[] = [];
    // Like the CLI's non-interactive handler: infrastructure and host plans only by hash.
    const answer = (request: ApprovalRequest) =>
      request.kind === "iac-apply" || request.kind === "host-apply"
        ? approved.includes(request.planHash ?? "")
        : request.kind !== "remote-exec";
    const s = await setup({ answer });
    const planned = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
      planOnly: true,
    });
    const iacHash = planned.planHash as string;
    const hostHash = planned.hostPlanHash as string;

    // Only the infrastructure hash: the host plan is refused and the hint names its hash.
    approved.push(iacHash);
    const options: ProvisionOptions = { services: s.services, approveHashes: [iacHash] };
    const refused = (await runProvision(s.deps, options).catch((e: unknown) => e)) as OpsCrewError;
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.hint).toContain(`--approve ${hostHash}`);
    expect(s.engine.applies).toHaveLength(1);
    expect(s.engine.plans).toHaveLength(1); // the saved plan was applied, not re-made
    expect(s.host.applies).toHaveLength(0);

    // Both hashes again: the applied infrastructure plan is not applied twice (a real engine
    // refuses a stale saved plan); a fresh plan finds nothing to change and the host plan applies.
    approved.push(hostHash);
    s.engine.changes = [];
    const result = await runProvision(s.deps, {
      services: s.services,
      approveHashes: [iacHash, hostHash],
    });
    expect(result.hostApplied).toBe(true);
    expect(s.host.applies[0]?.options.approvedHash).toBe(hostHash);
    expect(s.engine.applies).toHaveLength(1);
    expect(s.engine.plans).toHaveLength(2);
  });

  it("applies both plans in one scripted run after --plan-only", async () => {
    const approved: string[] = [];
    const answer = (request: ApprovalRequest) =>
      request.kind === "iac-apply" || request.kind === "host-apply"
        ? approved.includes(request.planHash ?? "")
        : request.kind !== "remote-exec";
    const s = await setup({ answer });
    const planned = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
      planOnly: true,
    });
    approved.push(planned.planHash as string, planned.hostPlanHash as string);
    const result = await runProvision(s.deps, {
      services: s.services,
      approveHashes: [planned.planHash as string, planned.hostPlanHash as string],
    });
    expect(result).toMatchObject({
      applied: true,
      hostApplied: true,
      planHash: planned.planHash,
      hostPlanHash: planned.hostPlanHash,
    });
    expect(s.engine.plans).toHaveLength(1);
  });

  it("switching from public to tunnel mode removes the old records in an apply of its own first", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "switch")}`;
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: false,
        hostKey: ED25519_FINGERPRINT,
        publicIpv4: OWN_IPV4,
      },
      engine: new OwnEngine(
        TUNNEL_CHANGES,
        tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-secret-x" }),
        publicOutputs(),
      ),
    });
    // The last run applied public mode: its state and the address are on this computer.
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
    await recordServerAddress(s.deps.paths, { ipv4: OWN_IPV4 });

    await runProvision(s.deps, { services: s.services });

    expect(kinds(s).slice(0, 3)).toEqual(["iac-apply", "repo-write", "iac-apply"]);
    const removal = s.handler.requests[0];
    expect(removal?.allowDestroy).toBe(true);
    expect(removal?.confirmPhrase).toBe("shop");
    expect(removal?.title).toContain("Remove the DNS records");
    expect(s.engine.plans.map((p) => p.destroy)).toEqual([true, false]);
    // The old configuration still gets the old address, through the environment only.
    expect(s.engine.plans[0]?.env.TF_VAR_server_ipv4).toBe(OWN_IPV4);
    expect(s.engine.applies.map((a) => a.destroy)).toEqual([true, false]);
    expect(s.deps.reporter.text()).toContain("first removes what the current setup created");
    expect((await readServerAddresses(s.deps.paths)).deployment).toBeUndefined();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.approvals.map((a) => a.kind)).toEqual(["iac-apply", "iac-apply", "host-apply"]);
  });

  it("--plan-only during a mode switch shows only the removal; approving its hash applies it, then the new setup", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "switch-plan")}`;
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: false,
        hostKey: ED25519_FINGERPRINT,
      },
      engine: new OwnEngine(
        TUNNEL_CHANGES,
        tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-secret-x" }),
        publicOutputs(),
      ),
    });
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
    await recordServerAddress(s.deps.paths, { ipv4: OWN_IPV4 });

    const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(planned.planHash).toBeDefined();
    expect(planned.hostPlanHash).toBeUndefined();
    expect(s.engine.plans.map((p) => p.destroy)).toEqual([true]);
    expect(s.engine.applies).toHaveLength(0);
    expect(kinds(s)).toEqual([]);
    expect(s.deps.reporter.text()).toContain("After this removal is applied");

    await runProvision(s.deps, {
      services: s.services,
      approveHashes: [planned.planHash as string],
    });
    expect(s.engine.applies.map((a) => a.destroy)).toEqual([true, false]);
    expect(s.engine.plans.map((p) => p.destroy)).toEqual([true, false]);
    // The approved removal plan was applied as the removal only, never as the main plan.
    expect(s.engine.applies[0]?.planFile.endsWith("-removal.tfplan")).toBe(true);
    expect(s.engine.applies[1]?.planFile.endsWith("-removal.tfplan")).toBe(false);
    expect(s.engine.applies[1]?.planFile).toBe(s.engine.plans[1]?.planFile);
    expect(s.host.applies).toHaveLength(1);
  });

  it("refuses an approved removal plan when no switch is pending, and changes nothing", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "no-switch")}`;
    const outputs = tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-x" });
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: false,
        hostKey: ED25519_FINGERPRINT,
      },
      engine: new OwnEngine(TUNNEL_CHANGES, outputs, publicOutputs()),
    });
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
    const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
    // Meanwhile the switch happened another way: the state already holds the tunnel.
    s.engine.state = { ...outputs };

    const error = (await runProvision(s.deps, {
      services: s.services,
      approveHashes: [planned.planHash as string],
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toContain("no switch is pending");
    expect(error.message).toContain("Nothing was changed");
    expect(error.hint).toContain("--plan-only");
    expect(s.engine.applies).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
    expect(kinds(s)).not.toContain("iac-apply");
  });

  it("feeds the old address from the state's outputs to the removal when the local record is gone", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "outputs")}`;
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: false,
        hostKey: ED25519_FINGERPRINT,
      },
      engine: new OwnEngine(
        TUNNEL_CHANGES,
        tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-x" }),
        publicOutputs(),
      ),
    });
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
    expect((await readServerAddresses(s.deps.paths)).deployment).toBeUndefined();

    await runProvision(s.deps, { services: s.services });
    expect(s.engine.plans[0]?.destroy).toBe(true);
    expect(s.engine.plans[0]?.env.TF_VAR_server_ipv4).toBe(OWN_IPV4);
  });

  it("records the address right after the infrastructure apply and audits the host apply's start and failure", async () => {
    const s = await setup();
    s.host.fail = new HostApplyError(
      "COMMAND_FAILED",
      "OpsCrew stopped while installing Docker: apt failed.",
      ["docker"],
    );
    await expect(
      runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT }),
    ).rejects.toThrow(/installing Docker/);
    expect(s.engine.applies).toHaveLength(1);
    // The DNS records point at the address now, so it is recorded although the host apply failed.
    expect((await readServerAddresses(s.deps.paths)).deployment).toEqual({ ipv4: OWN_IPV4 });
    expect((await readOwnServer(s.deps.paths))?.publicIpv4).toBe(OWN_IPV4);

    const hash = s.handler.requests.find((r) => r.kind === "host-apply")?.planHash;
    const actions = s.deps.audit.entries.map((e) => e.action);
    const started = s.deps.audit.entries.find((e) => e.action === "host apply started");
    const failed = s.deps.audit.entries.find((e) => e.action === "host apply failed");
    expect(started).toMatchObject({ target: hash, decision: "approved" });
    expect(started?.detail).toContain("docker");
    expect(started?.detail).toContain("sshd");
    expect(failed).toMatchObject({ target: hash, decision: "refused" });
    expect(failed?.detail).toBe("steps applied before the failure: docker");
    expect(actions.indexOf("host apply started")).toBeLessThan(
      actions.indexOf("host apply failed"),
    );

    // Without a report from the adapter, the entry points to the server's own record.
    s.host.fail = new OpsCrewError("COMMAND_FAILED", "OpsCrew lost the connection.");
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(/lost the/);
    const second = s.deps.audit.entries.filter((e) => e.action === "host apply failed")[1];
    expect(second?.detail).toContain("/etc/opscrew/host.json");
  });

  it("runs the tunnel connector for a Portainer subdomain on a public server too", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "portainer")}`;
    const s = await setup({
      plan: ownPlan({ portainer: "subdomain" }),
      engine: new OwnEngine(PUBLIC_CHANGES, {
        ...publicOutputs(),
        tunnel_id: TUNNEL_ID,
        tunnel_token: token,
        portainer_url: "https://portainer.example.com",
      }),
    });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(existsSync(join(s.root, "opscrew/runtime/cloudflared/compose.yaml"))).toBe(true);
    const apply = s.host.applies[0];
    expect(apply?.options.secrets?.tunnelToken).toBe(token);
    expect(s.zeroTrust.asked).toEqual([ACCOUNT_ID]);
    expect(everythingPrinted(s.deps)).not.toContain(token);
  });

  it("never asks to replace a token when the server's login is missing", async () => {
    const s = await setup();
    await recordOwnServer(s.deps.paths, undefined);
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew interview");
    expect(`${error.message} ${error.hint}`).not.toMatch(/replace the token|create a new one/i);
  });
});
