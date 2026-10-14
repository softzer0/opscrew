/**
 * Fakes for a server the user already owns (`target.provider: own`): an own-server plan, the facts
 * the host adapter's inspection reports for a fresh Ubuntu server, a fake host adapter that
 * checks the approved hash, a command runner answering `ssh-keyscan` and `ssh`, and the services
 * provision, design, destroy and Portainer take. Adapted from `@opscrew/agents`' own-server
 * fixtures (not exported). Tests only: no network, no real server.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type OwnServerConnectionInput,
  type OwnServerServices,
  type ProvisionServices,
  recordOwnServer,
} from "@opscrew/agents";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  RemoteExec,
  ResourceChange,
} from "@opscrew/contracts";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { type FakeEngine, type FakeGitHub, fakeCloudflare } from "./deploy";
import type { TempProject } from "./harness";

type HostAdapter = NonNullable<OwnServerServices["host"]>;
/** What the host adapter's inspection reports (`HostFacts` of `@opscrew/connector-ssh-host`). */
export type HostFacts = Awaited<ReturnType<NonNullable<HostAdapter["inspect"]>>>;
type ApplyArgs = Parameters<NonNullable<HostAdapter["apply"]>>;
/** A host plan (`HostPlan` of `@opscrew/connector-ssh-host`). */
export type HostPlan = ApplyArgs[1];
type ApplyOptions = ApplyArgs[2];

/** The user's own server: a documentation address (RFC 5737), public. */
export const OWN_IPV4 = "203.0.113.20";
export const OWN_ACCOUNT_ID = "acct-0001";

/** An SSH public key blob (wire format) of `type`, deterministic from `seed`. Not a secret. */
export function hostKeyBlob(type = "ssh-ed25519", seed = "own-server"): string {
  const name = Buffer.from(type);
  const key = createHash("sha256").update(seed).digest();
  const length = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };
  return Buffer.concat([length(name.length), name, length(key.length), key]).toString("base64");
}

/** The fingerprint OpenSSH prints for a key blob. */
export function fingerprintOf(blob: string): string {
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export const OWN_HOST_KEY = hostKeyBlob();
export const OWN_FINGERPRINT = fingerprintOf(OWN_HOST_KEY);

export interface OwnPlanOptions {
  access?: "public" | "tunnel";
  /** Default `shop.example.com` on Cloudflare (proxied); `null` for no domain. */
  domain?: string | null;
  deployed?: boolean;
  portainer?: boolean;
}

/** A valid own-server `opscrew/plan.yaml` for the `shop` app. */
export function ownPlan(o: OwnPlanOptions = {}): DeployPlan {
  const domain = o.domain === undefined ? "shop.example.com" : o.domain;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    app: {
      name: "shop",
      port: 3000,
      healthPath: "/api/health",
      env: [
        { name: "DATABASE_URL", secret: true, source: "derived" },
        { name: "SESSION_SECRET", secret: true, source: "generated" },
      ],
    },
    target: { provider: "own", mode: "vps-compose", arch: "amd64", access: o.access ?? "public" },
    services: { postgres: true, redis: false },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [
        {
          item: "Your own server (you already pay for it)",
          monthly: { amount: 0, currency: "EUR" },
        },
      ],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-14T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: domain
      ? { provider: "cloudflare", domain, zone: "example.com", proxied: true, www: false }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    ...(o.portainer
      ? { portainer: { enabled: true, version: "2.45.2", access: "local" } }
      : {}),
    ...(o.deployed ? { deployment: { lastApplyAt: "2026-10-14T11:00:00.000Z" } } : {}),
  });
}

const ADDON = {
  installed: false,
  composeSha256: null,
  running: false,
  secretFile: false,
  dataVolume: false,
  tunnelId: null,
};

/** A fresh Ubuntu 24.04 server as the host adapter's inspection reports it. */
export function freshFacts(o: { memoryGb?: number } = {}): HostFacts {
  return {
    user: "root",
    privilege: "root",
    os: {
      id: "ubuntu",
      idLike: "debian",
      versionId: "24.04",
      codename: "noble",
      prettyName: "Ubuntu 24.04.3 LTS",
    },
    arch: "amd64",
    machine: "x86_64",
    cpus: 2,
    memoryBytes: (o.memoryGb ?? 4) * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    diskFreeBytes: 40 * 1024 ** 3,
    diskTotalBytes: 80 * 1024 ** 3,
    systemd: true,
    flock: true,
    addresses: [{ interface: "eth0", family: "ipv4", address: OWN_IPV4, public: true }],
    sshd: {
      ports: [22],
      passwordAuthentication: true,
      kbdInteractiveAuthentication: false,
      permitRootLogin: "yes",
      authenticationMethods: "any",
      allowUsers: [],
      allowGroups: [],
      denyUsers: [],
      denyGroups: [],
      authorizedKeysCommand: false,
      allowTcpForwarding: "yes",
      dropInIncluded: true,
      dropIn: null,
    },
    listeners: [{ proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd" }],
    webServers: [],
    firewall: {
      ufw: "inactive",
      ufwRules: [],
      ufwDefaults: { incoming: "deny", outgoing: "allow", routed: "disabled" },
      foreign: [],
    },
    docker: {
      kind: "absent",
      version: null,
      running: false,
      composePlugin: false,
      buildxPlugin: false,
      conflicting: [],
      sources: [],
      daemonFlags: [],
      swarm: false,
    },
    containers: [],
    volumeProjects: [],
    directoryLogins: [],
    dpkgInterrupted: false,
    loginUsers: [{ name: "root", uid: 0, password: false, keys: true }],
    deployUser: null,
    packages: { ufw: true, unattendedUpgrades: true, curl: true, fail2ban: false },
    autoUpgrades: false,
    autoUpgradesService: false,
    dockerDaemonJson: "absent",
    fail2ban: { active: false, jail: null, sshdJail: false },
    ready: false,
    dirs: [
      { path: "/srv/app", kind: "absent" },
      { path: "/srv/data", kind: "absent" },
    ],
    marker: null,
    markerDamaged: false,
    record: null,
    recordDamaged: false,
    pendingUndo: { sshd: false, ufw: false },
    tunnel: ADDON,
    portainer: ADDON,
  } as HostFacts;
}

/**
 * A server OpsCrew prepared for the app `shop` of the project `projectId`: Docker from Docker's
 * repository, the deploy user, the runtime directories, the app marker and OpsCrew's record.
 */
export function preparedFacts(projectId: string): HostFacts {
  const fresh = freshFacts();
  const entry = (step: string, previous: Record<string, string | boolean>) => ({
    step,
    purpose: "setup",
    at: "2026-10-14T12:00:00.000Z",
    previous,
  });
  return {
    ...fresh,
    docker: {
      ...fresh.docker,
      kind: "docker-repo",
      version: "28.5.1",
      running: true,
      composePlugin: true,
      buildxPlugin: true,
    },
    deployUser: { groups: ["deploy", "docker"], keys: [] },
    ready: true,
    dirs: ["/srv/app", "/srv/data"].map((dir) => ({
      path: dir,
      kind: "dir",
      owner: "deploy",
      group: "deploy",
      mode: "750",
      entries: 0,
    })),
    marker: { app: "shop", projectId },
    record: {
      schemaVersion: 1,
      app: "shop",
      projectId,
      opscrewVersion: "0.0.0-test",
      changes: [
        entry("deploy-user", { existed: false }),
        entry("runtime-dirs", { app: "absent", data: "absent" }),
      ],
    },
  } as HostFacts;
}

/** One host apply the fake adapter received. */
export interface FakeHostApply {
  plan: HostPlan;
  options: ApplyOptions;
  verified?: boolean;
}

/**
 * The host adapter over a fake server: `inspect` reports its facts, `apply` records the plan and
 * the approved hash, calls `verifyLogin` around SSH and firewall steps, and never touches a server.
 */
export class FakeHost implements Required<HostAdapter> {
  readonly applies: FakeHostApply[] = [];
  inspections = 0;
  constructor(public facts: HostFacts = freshFacts()) {}

  async inspect(_remote: RemoteExec): Promise<HostFacts> {
    this.inspections++;
    return this.facts;
  }

  async apply(_remote: RemoteExec, plan: HostPlan, options: ApplyOptions) {
    const record: FakeHostApply = { plan, options };
    this.applies.push(record);
    const changes = plan.steps.filter((step) => step.state === "change");
    if (changes.some((step) => step.id === "sshd" || step.id === "ufw")) {
      record.verified = await options.verifyLogin();
    }
    // A teardown removes the app's marker, so a later undo sees the app gone.
    if (plan.purpose === "teardown") this.facts = { ...this.facts, marker: null, ready: false };
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}

/** The admin login's shell: answers the test login (`true`); nothing else may run on it. */
export function fakeAdminShell(host = OWN_IPV4): RemoteExec {
  return {
    host,
    run: async (command) =>
      command === "true"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `unexpected command in a test: ${command}` },
  };
}

/**
 * Real git; `ssh-keyscan` answers with {@link OWN_HOST_KEY} (named `[host]:port` on other ports
 * than 22, like the real tool); `ssh` succeeds; anything else reports "not found".
 */
export class OwnRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });
  readonly calls: string[][] = [];

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    this.calls.push([name, ...args]);
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      const host = args[args.length - 1] as string;
      const port = Number(args[args.indexOf("-p") + 1] ?? 22);
      const shown = port === 22 ? host : `[${host}]:${port}`;
      return {
        exitCode: 0,
        stdout: `# ${host}:${port} SSH-2.0-OpenSSH_9.6\n${shown} ssh-ed25519 ${OWN_HOST_KEY}\n`,
        stderr: "",
      };
    }
    if (name === "ssh") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/** The own-server services: the fake host adapter, admin shell, home and Zero Trust lookup. */
export function ownServices(host: FakeHost, home: string): OwnServerServices {
  return {
    host,
    remote: () => fakeAdminShell(),
    verifyLogin: async () => true,
    homeDir: home,
    zeroTrust: { organization: async () => undefined },
  };
}

/** Provision fakes for an own server: engine, GitHub, Cloudflare (with its account) and the host. */
export function ownProvisionServices(
  engine: FakeEngine,
  github: FakeGitHub,
  own: OwnServerServices,
): ProvisionServices {
  const cloudflare = fakeCloudflare();
  return {
    engine: async () => engine,
    github,
    cloudflare: {
      ...cloudflare,
      findZone: async () => ({
        id: "zone-123",
        name: "example.com",
        status: "active",
        nameServers: [],
        accountId: OWN_ACCOUNT_ID,
      }),
    },
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own,
    accessLoginMethods: { oneTimePin: async () => undefined },
  };
}

/** The DNS record a public-mode own plan creates. */
export const OWN_PUBLIC_CHANGES: ResourceChange[] = [
  {
    address: "module.dns.cloudflare_dns_record.a",
    type: "cloudflare_dns_record",
    name: "a",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create",
  },
];

/** Records how OpsCrew reaches the server (`.opscrew/server.json` → `own`), as the interview does. */
export async function recordOwnLogin(
  project: TempProject,
  login: Partial<OwnServerConnectionInput> = {},
): Promise<void> {
  const paths = resolveProjectPaths(project.root, { env: project.env });
  await recordOwnServer(paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
    ...login,
  } as OwnServerConnectionInput);
}

/** A home directory for `~/` key paths (holds nothing). */
export async function fakeHome(project: TempProject): Promise<string> {
  const home = path.join(project.dir, "home");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "README"), "no keys here; tests use the SSH agent\n");
  return home;
}
