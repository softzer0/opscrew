import { join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  type DesiredHost,
  type DesiredRunner,
  type HostFacts,
  type HostPlan,
  otherActiveApps,
  planAddon,
  planHost,
  planTeardown,
  planUndo,
} from "@opscrew/connector-ssh-host";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, plural } from "@opscrew/core";
import {
  hostSysctl,
  keepNewerPins,
  renderPortainerCompose,
  renderTunnelConnectorCompose,
  siteHosts,
  sshHostname,
  usesTunnel,
  wrongTarget,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type OwnDeployTarget,
  servicesOn,
} from "@opscrew/plan-schema";
import type { CheckKey } from "../check/key";
import type { PhaseDeps } from "../context";
import { serverNetworkInputs } from "../network";
import {
  applyRunnerSettings,
  lazyRepository,
  planServerRunner,
  type RunnerRepository,
  removeKeptRegistrations,
  repositoryUrl,
  runnerTokens,
} from "../runners";
import {
  addressFromOutputs,
  appMemoryMb,
  approveAndApplyHostPlan,
  committedText,
  ensureSecretFile,
  gitClient,
  githubCoordinates,
  type HostAdapterApi,
  type HostPlanOutcome,
  infrastructureOutputs,
  knownHostsName,
  randomPassword,
  readSecretFile,
  readServerAddresses,
  requireNoBlockers,
  type SecretFile,
  type ServerAddress,
  stringOutput,
  updateServerAddresses,
} from "../shared";
import { boundHostAdapter, keepServerSetup } from "../shared/host-plan";
import {
  connectAndInspectOwnServer,
  connectExtraServer,
  type OwnServerSession,
  ownServerLoginCheck,
  ownServerPublicAddress,
} from "../shared/own-server";
import { networkSshPort } from "../shared/server-address";
import {
  type ConnectorFirst,
  connectorFirst,
  type HostChangeResult,
  tunnelChange,
} from "../shared/tunnel-connections";
import { hasAppInterface } from "../vpn/dashboards";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import type { ServerReach } from "./secrets";
import type { CloudflareApi, ProvisionOptions, ProvisionServices } from "./types";

/** Cloudflare's IP ranges, the only sources of web traffic when the site is served directly behind the proxy. */
export type OwnWebSources = NonNullable<DesiredHost["webFilter"]>;

/** What provision knows about the user's own server once it connected and inspected it. */
export interface OwnServerRun {
  session: OwnServerSession;
  facts: HostFacts;
  target: OwnDeployTarget;
  /** Public mode: the addresses DNS points to (local state only, never committed). */
  address?: ServerAddress;
  /**
   * Served directly behind Cloudflare's proxy ({@link ownWebFromCloudflare}): Cloudflare's IP
   * ranges as read at the start of this run, for the host plan's web filter.
   */
  webSources?: OwnWebSources;
  /**
   * The SSH port the deploy reaches: in public mode the login's port (GitHub Actions connects to
   * the public address as the user does, through any router forwarding it); in tunnel mode the
   * port sshd listens on, on the server (the tunnel's SSH route, `ssh://localhost:<port>`).
   */
  sshPort: number;
  host: HostAdapterApi;
  /** Opens new SSH connections as the deploy user and the admin login (see `ownServerLoginCheck`). */
  verifyLogin: () => Promise<boolean>;
  /**
   * The app's GitHub Actions runner (`environment.runner: server`), in every host plan of the run;
   * absent, a runner the app has on the server is removed.
   */
  runner?: DesiredRunner;
  /** The project's GitHub repository, for the runner's tokens and registrations (read when needed). */
  repository: () => Promise<RunnerRepository>;
}

/** An extra server the user owns (`plan.servers[]`), once provision connected and inspected it. */
export interface ExtraOwnServerRun {
  /** Its name in the plan. */
  name: string;
  session: OwnServerSession;
  facts: HostFacts;
  host: HostAdapterApi;
  /** Opens new SSH connections as the deploy user and the admin login (see `ownServerLoginCheck`). */
  verifyLogin: () => Promise<boolean>;
}

/** Placeholder tunnel id for the check before anything changes (the real one comes from the apply). */
const PENDING_TUNNEL_ID = "00000000-0000-0000-0000-000000000000";

/** The target of an own-server plan; any other here is a bug in OpsCrew. */
export function ownTarget(plan: Pick<DeployPlan, "target">): OwnDeployTarget {
  if (plan.target.provider !== "own") {
    throw wrongTarget("This step only applies to a server you already own.");
  }
  return plan.target;
}

/** `~/.opscrew/projects/<id>/portainer_password` (0600): Portainer's admin password, local only. */
export function portainerPasswordFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer_password");
}

/** Portainer's admin password: at least 12 characters (OpsCrew writes 32). */
function portainerPassword(paths: Pick<ProjectPaths, "projectHomeDir">): SecretFile {
  const file = portainerPasswordFile(paths);
  return {
    file,
    valid: (value) => value.length >= 12,
    damaged: {
      message: `The Portainer admin password OpsCrew keeps for this project (${file}) is damaged, so OpsCrew stopped instead of making a new one: Portainer's admin account may already use it. Nothing was changed.`,
      hint: "Put the password back from a backup of that file, then run the command again. If Portainer has no admin account yet, delete the file instead: OpsCrew then makes a new password.",
    },
  };
}

/**
 * Portainer's admin password from {@link portainerPasswordFile}, generated on this computer (32
 * random letters and digits, mode 0600) when the file does not exist yet; a damaged one stops and
 * is never replaced. Never printed.
 */
export async function ensurePortainerPassword(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<string> {
  const password = await ensureSecretFile(portainerPassword(deps.paths), () => randomPassword(32));
  deps.redactor.addLiteral(password, "portainer-password");
  return password;
}

/**
 * The password to send when Portainer is started: a new one only when Portainer has no data yet
 * (`required`), else the one in {@link portainerPasswordFile} when it is on this computer. Sending
 * it whenever it exists means the first-start Compose file is used, so a Portainer whose earlier
 * first start stopped before the admin existed still gets its admin; Portainer ignores it when an
 * admin exists. `undefined` when it is not required and not on this computer; a damaged one stops.
 */
export async function portainerPasswordToSend(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  required: boolean,
): Promise<string | undefined> {
  if (required) return ensurePortainerPassword(deps);
  const existing = await readSecretFile(portainerPassword(deps.paths));
  if (existing !== undefined) deps.redactor.addLiteral(existing, "portainer-password");
  return existing;
}

/**
 * True when the user's own server serves the site directly behind Cloudflare's proxy (the user's
 * explicit choice): public mode, the domain on Cloudflare, proxied, and `security.httpAllowedFrom:
 * cloudflare` (the plan schema refuses `any` there). The host plan's web filter then lets only
 * Cloudflare's IP ranges reach the web ports Docker publishes, as the cloud firewall does on
 * Hetzner and DigitalOcean.
 */
export function ownWebFromCloudflare(plan: DeployPlan): boolean {
  return (
    plan.target.provider === "own" &&
    plan.target.access === "public" &&
    plan.dns.provider === "cloudflare" &&
    plan.dns.proxied &&
    plan.security.httpAllowedFrom === "cloudflare"
  );
}

function rangesUnreadable(cause?: unknown): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    "OpsCrew could not read Cloudflare's IP ranges, which your server's web filter needs so that only Cloudflare can reach the app's web ports. Nothing was changed.",
    {
      hint: "Check this computer's internet connection (OpsCrew reads https://api.cloudflare.com/client/v4/ips, which needs no token), then run the command again. OpsCrew never opens the web ports to every address instead.",
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

/**
 * Cloudflare's current IP ranges for an own server behind Cloudflare's proxy
 * ({@link ownWebFromCloudflare}); `undefined` for any other plan. Read from `api` (the provision
 * services' Cloudflare client) or, without one, from Cloudflare's public endpoint (no token).
 * Throws `PROVIDER_ERROR` in plain English when they cannot be read: OpsCrew never falls back to
 * opening the web ports to every address.
 */
export async function ownWebSources(
  deps: Pick<PhaseDeps, "fetch" | "version">,
  plan: DeployPlan,
  api?: Pick<CloudflareApi, "getIpRanges"> | null,
): Promise<OwnWebSources | undefined> {
  if (!ownWebFromCloudflare(plan)) return undefined;
  const client = api ?? new CloudflareClient({ fetch: deps.fetch, version: deps.version });
  let ranges: { ipv4: string[] };
  try {
    ranges = await client.getIpRanges();
  } catch (error) {
    throw rangesUnreadable(error);
  }
  if (ranges.ipv4.length === 0) throw rangesUnreadable();
  return { ipv4: [...ranges.ipv4] };
}

/**
 * The desired state of the server for the plan: the app and the project's repository (the
 * `origin` remote: no host plan touches another repository's runner), the admin login, the deploy key, SSH and
 * firewall settings for the access mode, the tunnel connector (with the tunnel's id) whenever the
 * plan has a Cloudflare Tunnel (tunnel mode, or a Portainer subdomain in either mode), Portainer
 * when the plan turns it on, and the web filter with Cloudflare's ranges (`run.webSources`) when
 * the site is served directly behind Cloudflare's proxy. The connector's Compose file keeps the
 * newer pins of its committed copy, so the server runs what Dependabot updated.
 * @throws Error when the plan needs the web filter but `run.webSources` is missing: a host plan
 * must never drop the filter because the ranges were not read.
 */
export async function desiredHost(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  run: Pick<OwnServerRun, "session" | "facts" | "target" | "webSources" | "runner">,
  input: {
    plan: DeployPlan;
    deployPublicKey: string;
    tunnelId?: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    /**
     * No tunnel connector even when the plan has a tunnel: the host change that goes before a plan
     * deletes the current tunnel (Cloudflare refuses that while the connector runs).
     */
    withoutTunnel?: boolean;
  },
): Promise<DesiredHost> {
  const { plan } = input;
  const filtered = ownWebFromCloudflare(plan);
  if (filtered && run.webSources === undefined) {
    throw new Error("The web filter needs Cloudflare's IP ranges (read them with ownWebSources).");
  }
  const connector = renderTunnelConnectorCompose(plan);
  const tunnel =
    usesTunnel(plan) && input.withoutTunnel !== true
      ? {
          compose: keepNewerPins(
            await committedText(deps.paths.root, [connector.path]),
            connector.content,
          ),
          tunnelId: input.tunnelId ?? PENDING_TUNNEL_ID,
        }
      : undefined;
  // Portainer's web UI is also on the private address only while the server hosts this app alone,
  // and once that address is on the server: Docker never binds an address that isn't there.
  const dashboards = dashboardsOnNetwork(plan, run.facts) && hasAppInterface(plan, run.facts);
  const portainer = plan.portainer?.enabled
    ? {
        version: plan.portainer.version,
        compose: {
          initial: renderPortainerCompose(plan, {
            initialAdmin: true,
            dashboardsOnNetwork: dashboards,
          }).content,
          final: renderPortainerCompose(plan, {
            initialAdmin: false,
            dashboardsOnNetwork: dashboards,
          }).content,
        },
      }
    : undefined;
  // Kernel settings the services need (vm.max_map_count for the search engines).
  const sysctl = hostSysctl(plan);
  return {
    ...(await hostLogin(deps, run, input)),
    hostnames: siteHosts(plan),
    services: plan.services.filter((service) => service.enabled).map((service) => service.name),
    memoryMb: appMemoryMb(plan),
    access: run.target.access,
    ...(tunnel !== undefined ? { tunnel } : {}),
    ...(portainer !== undefined ? { portainer } : {}),
    ...(Object.keys(sysctl).length > 0 ? { sysctl } : {}),
    ...(run.runner !== undefined ? { runner: run.runner } : {}),
    ...(filtered && run.webSources !== undefined ? { webFilter: run.webSources } : {}),
  };
}

/**
 * True when the dashboards (Beszel's hub, Portainer's web UI) are also published on the app's
 * server's private address, as the network's host plans and drift say (`serverNetworkInputs`):
 * the network has devices, and the app's server hosts this app alone (always so on a server
 * OpsCrew created, which has no `facts` here; on the user's own, no other OpsCrew app is active
 * there), so its dashboards are this app's.
 */
export function dashboardsOnNetwork(plan: DeployPlan, facts?: Pick<HostFacts, "apps">): boolean {
  const alone = facts === undefined || otherActiveApps(facts.apps, plan.app.name).length === 0;
  return serverNetworkInputs(plan, APP_SERVER, alone).dashboardsOnNetwork;
}

/**
 * True when the dashboards should be on the app's server's private address
 * ({@link dashboardsOnNetwork}) but wait for the next provision: the server does not have the
 * private network's interface yet, which the network host plan sets up.
 */
export function dashboardsWaitForNetwork(
  plan: DeployPlan,
  facts: Pick<HostFacts, "apps" | "network">,
): boolean {
  return dashboardsOnNetwork(plan, facts) && !hasAppInterface(plan, facts);
}

/** True when Portainer's web UI waits for the private network ({@link dashboardsWaitForNetwork}). */
export function portainerWaitsForNetwork(
  plan: DeployPlan,
  facts: Pick<HostFacts, "apps" | "network">,
): boolean {
  return plan.portainer?.enabled === true && dashboardsWaitForNetwork(plan, facts);
}

/**
 * What every server the user owns gets in its desired state: the app, the logins and SSH, which
 * stays off the public firewall once public SSH is closed (`network.publicSsh: false`).
 */
async function hostLogin(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  run: Pick<OwnServerRun, "session" | "facts">,
  input: { plan: DeployPlan; deployPublicKey: string; passwordLogins?: "off" | "keep" },
): Promise<
  Pick<
    DesiredHost,
    | "app"
    | "projectId"
    | "repositoryUrl"
    | "admin"
    | "deploy"
    | "sshPort"
    | "hostKeyType"
    | "disablePasswords"
    | "publicSsh"
  >
> {
  const { connection } = run.session;
  return {
    app: input.plan.app.name,
    projectId: deps.paths.projectId,
    repositoryUrl: repositoryUrl(await githubCoordinates(gitClient(deps))),
    admin: {
      user: run.facts.user || connection.user,
      isRoot: run.facts.privilege === "root",
    },
    deploy: { user: "deploy", publicKey: input.deployPublicKey.trim() },
    sshPort: connection.port,
    // The pinned key's ssh-keyscan type; planHost refuses any other.
    hostKeyType: run.session.hostKey.type as DesiredHost["hostKeyType"],
    ...(input.passwordLogins !== undefined
      ? { disablePasswords: input.passwordLogins === "off" }
      : {}),
    // Public SSH closed: ufw keeps SSH on the private network's interface only.
    ...(input.plan.network?.publicSsh === false ? { publicSsh: false as const } : {}),
  };
}

/**
 * The desired state of an extra server the user owns (`plan.servers`, ADR 0022): the own-server
 * setup an app's server gets (Docker, the deploy user and key, SSH and ufw), for the services
 * placed there only. It serves no site, so it has no hostnames, tunnel, Portainer or runner.
 */
export async function desiredExtraHost(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  run: Pick<ExtraOwnServerRun, "name" | "session" | "facts">,
  input: { plan: DeployPlan; deployPublicKey: string; passwordLogins?: "off" | "keep" },
): Promise<DesiredHost> {
  const services = servicesOn(input.plan, run.name);
  const sysctl = hostSysctl(input.plan, run.name);
  return {
    ...(await hostLogin(deps, run, input)),
    hostnames: [],
    services: services.map((service) => service.name),
    memoryMb: services.reduce((sum, service) => sum + service.memoryMb, 0),
    access: "public",
    web: false,
    ...(Object.keys(sysctl).length > 0 ? { sysctl } : {}),
  };
}

/**
 * Stops before any change when the plan runs MongoDB on `server` (the app's, or an extra one the
 * user owns), an x86 server whose CPU lacks AVX, which MongoDB 5 and later need (FR-1312): the
 * inspected CPU flags say so.
 */
function requireMongoAvx(
  plan: DeployPlan,
  facts: Pick<HostFacts, "arch" | "avx">,
  server = APP_SERVER,
): void {
  const mongo = servicesOn(plan, server).find((service) => service.kind === "mongodb");
  if (mongo === undefined || facts.arch !== "amd64" || facts.avx) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${server === APP_SERVER ? "Your server's" : `Server ${server}'s`} CPU lacks AVX, which MongoDB needs on x86 since version 5, so the service ${mongo.name} could not start there. Nothing was changed.`,
    {
      hint: "Run the app on a server with a newer CPU (most x86 CPUs since 2011 have AVX), or use a hosted MongoDB such as MongoDB Atlas: put its mongodb+srv:// address in the app's settings, then run `opscrew analyze`, `opscrew design` and `opscrew provision` again (OpsCrew keeps a hosted MongoDB as it is).",
    },
  );
}

/** The phases that change a server the user owns through its host plan. */
type OwnHostPhase = Extract<PhaseName, "provision" | "dns" | "portainer">;

/**
 * Connects to the user's own server (host key confirmed or `--host-key`, pinned), inspects it
 * read-only (audited as `phase`), and stops before any change when the host plan would be blocked:
 * an unsupported system, another firewall or web server, another OpsCrew app on the server that
 * holds one of the app's hostnames, its name or another access mode, an app without a domain next
 * to another, a password choice to make, and so on (the stop says to run `command` again). Other
 * OpsCrew apps on the server are welcome otherwise: the host plan sets up only what this app needs
 * that is not there yet. Also checks that the plan's architecture is the server's, and in public
 * mode finds the public address DNS points to.
 */
export async function prepareOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    options: Pick<ProvisionOptions, "hostKey" | "passwordLogins" | "planOnly">;
    services: ProvisionServices;
    deployPublicKey: string;
    deployKeyFile: string;
    phase: OwnHostPhase;
    /** The command a stop says to run again, for example `opscrew portainer enable`. */
    command: string;
  },
): Promise<OwnServerRun> {
  const { plan } = input;
  const target = ownTarget(plan);
  const own = input.services.own ?? {};
  // Bound, so `run.host.apply` can be passed on as a function.
  const host = boundHostAdapter(own.host);
  if (target.access === "tunnel") sshHostname(plan); // a tunnel needs a Cloudflare domain
  // Behind Cloudflare's proxy the firewall needs Cloudflare's current ranges; read them first, so
  // a failure stops before anything is changed.
  const webSources = await ownWebSources(deps, plan, input.services.cloudflare);
  const { session, facts } = await connectAndInspectOwnServer(deps, {
    hostKey: input.options.hostKey,
    services: { ...own, host },
    phase: input.phase,
  });
  if ((facts.arch === "amd64" || facts.arch === "arm64") && facts.arch !== target.arch) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml builds the app for ${target.arch}, but your server is ${facts.arch}. Nothing was changed.`,
      {
        hint: `Run \`opscrew design\` again so OpsCrew builds the image for ${facts.arch}, then run \`opscrew provision\` again.`,
      },
    );
  }
  requireMongoAvx(plan, facts);
  const repo = lazyRepository(deps, input.services.runnerGitHub);
  // The server's runner, after the repository's check (a public one needs its own approval).
  const runner =
    plan.environment?.runner === "server"
      ? await planServerRunner(await repo(), plan, {
          arch: target.arch,
          host: session.connection.host,
        })
      : {};
  const run: OwnServerRun = {
    session,
    facts,
    target,
    // Public mode: the login's port, which differs from sshd's when a router forwards it (2222 to
    // 22). Only the tunnel's SSH route, on the server itself, needs sshd's own port.
    sshPort:
      target.access === "tunnel"
        ? networkSshPort(facts, session.connection.port)
        : session.connection.port,
    ...(webSources !== undefined ? { webSources } : {}),
    host,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: input.deployKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
    ...(runner.step !== undefined ? { runner: runner.step } : {}),
    repository: repo,
  };
  // The check before anything changes: the tunnel's id is not known yet, so a placeholder stands in.
  requireNoBlockers(
    planHost(
      facts,
      await desiredHost(deps, run, {
        plan,
        deployPublicKey: input.deployPublicKey,
        ...(input.options.passwordLogins !== undefined
          ? { passwordLogins: input.options.passwordLogins }
          : {}),
      }),
      input.command,
    ),
    { server: "your server", command: input.command },
  );
  if (target.access === "public") {
    const address = ownServerPublicAddress(session.connection, facts);
    if (address === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "OpsCrew could not find your server's public IPv4 address, which the app's DNS record and GitHub Actions' deploys need. Nothing was changed.",
        {
          hint: "Give the server's public IP address as its address in `opscrew interview`. If the internet cannot reach the server, answer no to that question instead: OpsCrew then serves the app through a Cloudflare Tunnel.",
        },
      );
    }
    run.address = address;
  }
  // The last check before any change: a public repository's runner needs every outside
  // contributor's workflow runs approved first, set after its own approval (FR-1527).
  if (runner.settings !== undefined && runner.refusal !== undefined) {
    await applyRunnerSettings(
      deps,
      await repo(),
      { settings: runner.settings, refusal: runner.refusal },
      {
        phase: input.phase,
        command: input.command,
        ...(input.options.planOnly === true ? { planOnly: true } : {}),
      },
    );
  }
  return run;
}

/**
 * The engine environment for an own server: its public address as `TF_VAR_server_ipv4` and
 * `TF_VAR_server_ipv6`, never in a file (FR-902). In tunnel mode the address of an earlier public
 * setup still feeds the old configuration while its records are removed: from the local state, else
 * from the infrastructure state's outputs (`outputs`, read only when needed).
 */
export async function ownEngineEnv(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<OwnServerRun, "address" | "target">,
  env: Record<string, string | undefined>,
  outputs?: () => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const recorded = (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  const address =
    run.address ??
    recorded ??
    (outputs === undefined ? undefined : addressFromOutputs((await outputs()) ?? {}));
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  if (address === undefined) return;
  env.TF_VAR_server_ipv4 = address.ipv4;
  if (address.ipv6 !== undefined) env.TF_VAR_server_ipv6 = address.ipv6;
}

const MODE_TEXT = {
  public: "serving the app directly on its public address",
  tunnel: "serving the app through a Cloudflare Tunnel",
} as const;

/**
 * Switching an own server between public and tunnel mode runs as two applies, so Cloudflare never
 * holds an A/AAAA record and a CNAME for the same name: this one removes everything the last
 * setup created (DNS records, or the tunnel, its records and Access), from the files and state of
 * that setup; the normal plan adds the new ones afterwards. Each apply has its own approval (this
 * one deletes, so it needs the typed app name). `undefined` when the mode did not change.
 *
 * When this removal deletes the Cloudflare Tunnel (the old setup had one), Cloudflare refuses while
 * the tunnel's connector still runs on the server. Then, after the removal's approval, the host
 * plan of the new setup without a connector (`input.host`) is shown, approved by its hash and
 * applied first; OpsCrew waits until Cloudflare reports no active connections for the tunnel
 * (read-only, up to 3 minutes) and only then applies the removal. The host plan is returned as
 * `host` (with `planOnly`, shown and saved only, so a script can approve both hashes).
 */
export async function removeOldAccessMode(
  deps: PhaseDeps,
  input: {
    engine: IacEngine;
    dir: string;
    env: Record<string, string | undefined>;
    plan: DeployPlan;
    approvePlanHash?: string;
    planOnly?: boolean;
    phase: Extract<PhaseName, "provision" | "dns">;
    /** The server, for the host change that goes before a removal that deletes the tunnel. */
    host?: {
      run: OwnServerRun;
      deployPublicKey: string;
      passwordLogins?: ProvisionOptions["passwordLogins"];
      sleep?: (ms: number) => Promise<void>;
    };
  },
): Promise<(PlanAndApplyResult & { host?: HostChangeResult }) | undefined> {
  const { plan } = input;
  const target = ownTarget(plan);
  const outputs = await infrastructureOutputs(deps, plan, {
    engine: async () => input.engine,
    engineEnv: input.env,
  });
  if (outputs === undefined) return undefined;
  const last =
    stringOutput(outputs, "ssh_hostname") !== undefined
      ? "tunnel"
      : stringOutput(outputs, "server_ipv4") !== undefined
        ? "public"
        : undefined;
  if (last === undefined || last === target.access) return undefined;
  deps.reporter.warn(
    `Your server switches from ${MODE_TEXT[last]} to ${MODE_TEXT[target.access]}. Cloudflare cannot hold the old records and the new ones for the same name at once, so OpsCrew first removes what the current setup created (this plan), then adds the new setup in a second plan. The app is unreachable between the two applies.`,
  );
  const removed =
    last === "tunnel"
      ? "the Cloudflare Tunnel, its DNS records and Access"
      : "the DNS records pointing at your server";
  const command = `opscrew ${input.phase}`;
  const server = input.host;
  // The host change that goes first when the removal deletes the tunnel (see above).
  const first =
    server === undefined
      ? undefined
      : ownConnectorFirst(deps, {
          ...server,
          plan,
          phase: input.phase,
          done: `Your server is switched to ${MODE_TEXT[target.access]} already (its Cloudflare Tunnel connector is removed); the current setup's Cloudflare resources are still there, so the app is unreachable until the switch finishes.`,
        });
  let result: PlanAndApplyResult;
  try {
    result = await planAndApply(deps, {
      engine: input.engine,
      dir: input.dir,
      env: input.env,
      deployPlan: plan,
      files: [],
      command,
      phase: input.phase,
      destroy: true,
      costDelta: null,
      approvalTitle: `Remove ${removed} before switching your server to ${MODE_TEXT[target.access]} (first of two applies)`,
      ...first?.hooks,
      ...(input.approvePlanHash !== undefined ? { approvePlanHash: input.approvePlanHash } : {}),
      ...(input.planOnly ? { planOnly: true } : {}),
    });
  } catch (error) {
    throw first === undefined ? error : first.stopped(error);
  }
  // `--plan-only`: a removal that deletes the tunnel needs the host plan too; show it now.
  const pending = (result.plan?.changes.length ?? 0) > 0 && !result.applied;
  if (
    first !== undefined &&
    input.planOnly &&
    pending &&
    tunnelChange(result.plan?.changes ?? [], "delete")
  ) {
    return { ...result, host: await first.show() };
  }
  return first?.host === undefined ? result : { ...result, host: first.host };
}

/**
 * {@link connectorFirst} on a server the user owns: the host change that goes before a plan that
 * deletes the tunnel is the host plan of `plan` without a tunnel connector (its own `host-apply`
 * approval by its hash). After it applied, the server is inspected again, so the next host plan
 * (of the new setup) starts from what the server is now. `show()` only shows and saves it
 * (`--plan-only`).
 */
export function ownConnectorFirst(
  deps: PhaseDeps,
  input: {
    run: OwnServerRun;
    plan: DeployPlan;
    deployPublicKey: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    phase: Extract<PhaseName, "provision" | "dns">;
    sleep?: (ms: number) => Promise<void>;
    done: string;
    notes?: readonly string[];
  },
): ConnectorFirst & { show(): Promise<HostPlanOutcome> } {
  const { run } = input;
  let shownHash: string | undefined;
  const apply = (planOnly: boolean) =>
    applyOwnHostPlan(deps, run, {
      plan: input.plan,
      outputs: {},
      deployPublicKey: input.deployPublicKey,
      ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
      planOnly,
      phase: input.phase,
      command: `opscrew ${input.phase}`,
      withoutTunnel: true,
      shown: (hash) => {
        shownHash = hash;
      },
    });
  const first = connectorFirst(deps, {
    command: `opscrew ${input.phase}`,
    app: input.plan.app.name,
    where: "on your server",
    hostChange: async () => {
      const host = await apply(false);
      if (host.applied) {
        run.facts = await run.host.inspect(run.session.remote);
        await deps.audit.append({
          kind: "remote-exec",
          actor: "opscrew",
          action: "inspect host (read-only)",
          phase: input.phase,
          target: "own server",
          decision: "allow",
          detail: "after removing the tunnel connector",
        });
      }
      return host;
    },
    hostHash: () => shownHash,
    done: input.done,
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  return Object.assign(first, { show: () => apply(true) });
}

/** The infrastructure outputs a tunnel-mode host plan needs: the tunnel's id and token. */
function tunnelOutputs(
  deps: Pick<PhaseDeps, "redactor">,
  outputs: Record<string, unknown>,
): { id: string; token: string } {
  const id = stringOutput(outputs, "tunnel_id");
  const token = stringOutput(outputs, "tunnel_token");
  if (token !== undefined) deps.redactor.addLiteral(token, "tunnel-token");
  if (id === undefined || token === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      "The infrastructure state has no Cloudflare Tunnel id or token, so OpsCrew cannot set up the tunnel connector on your server.",
      {
        hint: "Run `opscrew provision` again; it plans what is missing. If the tunnel was deleted in the Cloudflare dashboard, the next plan creates a new one.",
      },
    );
  }
  return { id, token };
}

/**
 * The host plan for the user's own server, after the infrastructure exists (the tunnel's id is
 * part of it), through {@link approveAndApplyHostPlan}: saved, shown, checked for blocking
 * findings, approved by its hash (`host-apply`) and applied through the host adapter, which gets
 * the tunnel token (and Portainer's password, the runner's token) only then and calls
 * `verifyLogin` before keeping an SSH or firewall change; audited as `phase`, and a refusal or stop
 * says to run `command`. A runner registration GitHub kept after its removal is deleted through
 * GitHub's API. With `planOnly` it stops after saving and showing the plan.
 */
export async function applyOwnHostPlan(
  deps: PhaseDeps,
  run: OwnServerRun,
  input: {
    plan: DeployPlan;
    outputs: Record<string, unknown>;
    deployPublicKey: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    planOnly?: boolean;
    phase: OwnHostPhase;
    /** The command that applies the plan later (`--approve <hash>`), e.g. `opscrew portainer enable`. */
    command: string;
    /** Said when the plan changes nothing (default: `Your server is already prepared; …`). */
    upToDate?: string;
    /** No tunnel connector (see {@link desiredHost}); `outputs` are then not needed. */
    withoutTunnel?: boolean;
    /** Told the host plan's hash as soon as it is shown. */
    shown?: (hash: string) => void;
  },
): Promise<HostPlanOutcome> {
  // The connector runs whenever the plan has a tunnel: tunnel mode or a Portainer subdomain.
  const tunnel =
    usesTunnel(input.plan) && input.withoutTunnel !== true
      ? tunnelOutputs(deps, input.outputs)
      : undefined;
  const plan = planHost(
    run.facts,
    await desiredHost(deps, run, {
      plan: input.plan,
      deployPublicKey: input.deployPublicKey,
      ...(tunnel !== undefined ? { tunnelId: tunnel.id } : {}),
      ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
      ...(input.withoutTunnel === true ? { withoutTunnel: true } : {}),
    }),
    input.command,
  );
  const changes = plural(plan.steps.filter((step) => step.state === "change").length, "change");
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: run.session.remote,
    apply: run.host.apply,
    verifyLogin: run.verifyLogin,
    title: `Apply the host plan to your server (${changes})`,
    server: "your server",
    upToDate: input.upToDate ?? "Your server is already prepared; nothing on it changes.",
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async (steps) => {
      const portainerStep = steps.find((step) => step.id === "portainer");
      const portainerPassword =
        portainerStep === undefined || portainerStep.params.remove === true
          ? undefined
          : await portainerPasswordToSend(deps, portainerStep.params.needsPassword === true);
      return {
        ...(tunnel !== undefined ? { tunnelToken: tunnel.token } : {}),
        ...(portainerPassword !== undefined ? { portainerPassword } : {}),
      };
    },
    runnerToken: runnerTokens(deps, run.repository),
    applying: `Preparing your server (${changes}; installing Docker can take a few minutes)`,
    ...(input.shown !== undefined ? { shown: input.shown } : {}),
  });
  if (!outcome.approval) return outcome;
  if (outcome.stillRegistered !== undefined) {
    await removeKeptRegistrations(deps, run.repository, input.plan, {
      phase: input.phase,
      stillRegistered: outcome.stillRegistered,
      host: run.session.connection.host,
    });
  }
  deps.reporter.success(
    `Prepared your server (${plural(outcome.steps.length, "change")} applied).`,
  );
  if (switchesToWebFilter(run.facts, plan, input.plan.app.name, outcome.steps)) {
    deps.reporter.warn(SWITCH_TO_FILTER_NOTE);
  }
  return outcome;
}

/** Said after a running app switched to the web filter mode (published on IPv4 only). */
export const SWITCH_TO_FILTER_NOTE =
  "Your site stops answering on the server's IPv6 address only after the next deploy re-creates Caddy (until then the running Caddy still listens on IPv6 ports 80 and 443, around the web filter): merge the deploy pull request, or re-run the deploy workflow now.";

/**
 * True when this apply installed the web filter for the first time on a server where the app
 * already runs (a switch from DNS only or the tunnel): the running Caddy keeps its IPv6 listeners
 * until the next deploy re-creates it with the filter mode's IPv4-only ports.
 */
function switchesToWebFilter(
  facts: HostFacts,
  plan: HostPlan,
  app: string,
  applied: readonly string[],
): boolean {
  const filter = plan.steps.find((step) => step.id === "web-filter");
  if (filter === undefined || filter.params.remove === true || !applied.includes("web-filter")) {
    return false;
  }
  const wasFiltered = facts.webFilter.files.script !== null;
  return !wasFiltered && facts.containers.some((container) => container.project === app);
}

/**
 * What the deploy secrets hold for the user's own server: the host GitHub Actions connects to
 * (the public address, or the tunnel's SSH hostname) and the pinned host key under that name, and
 * in tunnel mode the Access service token from the infrastructure outputs.
 */
export function ownDeployTarget(
  deps: Pick<PhaseDeps, "redactor">,
  run: Pick<OwnServerRun, "session" | "address" | "target" | "sshPort">,
  input: { plan: DeployPlan; outputs: Record<string, unknown> },
): {
  host: string;
  knownHosts: string;
  tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
} {
  const key = run.session.hostKey;
  if (run.target.access === "tunnel") {
    const host = sshHostname(input.plan) as string;
    const serviceTokenId = stringOutput(input.outputs, "deploy_service_token_client_id");
    const serviceTokenSecret = stringOutput(input.outputs, "deploy_service_token_client_secret");
    if (serviceTokenId !== undefined) deps.redactor.addLiteral(serviceTokenId, "service-token-id");
    if (serviceTokenSecret !== undefined) {
      deps.redactor.addLiteral(serviceTokenSecret, "service-token-secret");
    }
    if (serviceTokenId === undefined || serviceTokenSecret === undefined) {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        "The infrastructure state has no Cloudflare Access service token for deploys, so GitHub Actions could not reach your server through the tunnel.",
        { hint: "Run `opscrew provision` again; it plans what is missing." },
      );
    }
    // The workflow connects to the SSH hostname through cloudflared, so ssh looks the key up there.
    return {
      host,
      knownHosts: `${host} ${key.type} ${key.key}\n`,
      tunnel: { serviceTokenId, serviceTokenSecret },
    };
  }
  const address = run.address as ServerAddress;
  // The deploy workflow connects to the login's port (`run.sshPort`, `-o Port=<port>` when it is
  // not 22), so ssh looks the key up as `[ip]:port` there.
  const name = knownHostsName(address.ipv4, run.sshPort);
  return { host: address.ipv4, knownHosts: `${name} ${key.type} ${key.key}\n` };
}

/**
 * Connects to the extra server `name` the user owns with the login design recorded
 * (`.opscrew/server.json` → `ownServers`, its host key pinned there) and inspects it read-only
 * (`connectExtraServer`) through the host adapter of `services.own` (default `inspectHost` and
 * `applyHostPlan`).
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no login for it.
 */
async function connectExtraOwnServer(
  deps: PhaseDeps,
  input: { name: string; services: ProvisionServices; deployKeyFile: string; phase: PhaseName },
): Promise<ExtraOwnServerRun> {
  const { name } = input;
  const own = input.services.own ?? {};
  const host = boundHostAdapter(own.host);
  const login = (await readServerAddresses(deps.paths)).ownServers?.[name];
  if (login === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not know how to log in to server ${name} on this computer. Nothing was changed.`,
      {
        hint: "Run `opscrew design` in a terminal: it asks for the server's address and SSH login once and keeps them on this computer.",
      },
    );
  }
  deps.reporter.step(`Connecting to server ${name}`);
  const { session, facts } = await connectExtraServer(deps, name, login, {
    services: { ...own, host },
    phase: input.phase,
  });
  return {
    name,
    session,
    facts,
    host,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: input.deployKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
  };
}

/**
 * Connects to the extra server `name` the user owns and inspects it ({@link
 * connectExtraOwnServer}), then stops before any change, as {@link prepareOwnServer} does for the
 * app's server, when its architecture is not the plan's or its setup host plan would be blocked.
 */
export async function prepareExtraOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    name: string;
    services: ProvisionServices;
    deployPublicKey: string;
    deployKeyFile: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    phase: OwnHostPhase;
    command: string;
  },
): Promise<ExtraOwnServerRun> {
  const { plan, name } = input;
  const run = await connectExtraOwnServer(deps, input);
  const target = plan.servers?.find((server) => server.name === name)?.target;
  const arch = run.facts.arch;
  if (
    target?.provider === "own" &&
    (arch === "amd64" || arch === "arm64") &&
    arch !== target.arch
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml says server ${name} is ${target.arch}, but it is ${arch}. Nothing was changed.`,
      {
        hint: "Run `opscrew design` again so OpsCrew reads the server again, then run `opscrew provision` again.",
      },
    );
  }
  requireMongoAvx(plan, run.facts, name);
  // A server that only holds a moving service's old copy has nothing new to set up.
  if (servicesOn(plan, name).length > 0) {
    requireNoBlockers(
      planHost(run.facts, await desiredExtraHost(deps, run, input), input.command),
      {
        server: `server ${name}`,
        command: input.command,
      },
    );
  }
  return run;
}

/**
 * The own-server setup host plan of the extra server `run.name` ({@link desiredExtraHost}),
 * through {@link approveAndApplyHostPlan}: saved, shown with the server's name, approved by its
 * hash and applied, the host adapter checking new logins after an SSH or firewall change. Once the
 * server is as the plan says (applied, or nothing to change), it is kept as the server's last setup
 * ({@link lastServerSetup}). `undefined` for a server with no service placed on it.
 */
export async function applyExtraOwnHostPlan(
  deps: PhaseDeps,
  run: ExtraOwnServerRun,
  input: {
    plan: DeployPlan;
    deployPublicKey: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome | undefined> {
  if (servicesOn(input.plan, run.name).length === 0) return undefined;
  const plan = planHost(run.facts, await desiredExtraHost(deps, run, input), input.command);
  const pending = plan.steps.filter((step) => step.state === "change").length;
  const changes = plural(pending, "change");
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: run.session.remote,
    apply: run.host.apply,
    verifyLogin: run.verifyLogin,
    title: `Apply the host plan to server ${run.name} (${changes})`,
    server: `server ${run.name}`,
    planOf: `server ${run.name}`,
    upToDate: `Server ${run.name} is already prepared; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    applying: `Preparing server ${run.name} (${changes}; installing Docker can take a few minutes)`,
  });
  if (outcome.applied || pending === 0) await keepServerSetup(deps, run.name, outcome.hash);
  if (outcome.applied) {
    deps.reporter.success(
      `Prepared server ${run.name} (${plural(outcome.steps.length, "change")} applied).`,
    );
  }
  return outcome;
}

/**
 * The scheduled check's key (`key`, the repository's) on the extra server `run.name` the user
 * owns, as the app's server the user owns gets it: the `check-key` host step as root, shown with
 * the server's name and approved by its hash. `undefined` when its inspection found the key there.
 */
export async function addExtraServerCheckKey(
  deps: PhaseDeps,
  run: ExtraOwnServerRun,
  input: {
    plan: DeployPlan;
    key: CheckKey;
    repository: string;
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome | undefined> {
  const { repository } = input;
  const known = run.facts.deployUser?.checkKeys ?? [];
  if (known.some((name) => name.toLowerCase() === repository.toLowerCase())) return undefined;
  const server = `server ${run.name}`;
  return approveAndApplyHostPlan(deps, {
    plan: planAddon("check-key", {
      app: input.plan.app.name,
      runAs: "root",
      repository,
      enable: { publicKey: input.key.publicKeyOpenSsh },
    }),
    remote: run.session.remote,
    apply: run.host.apply,
    // The step changes no SSH or firewall setting.
    verifyLogin: async () => true,
    title: `Let the scheduled check of ${repository} read the disk of ${server} with its own key`,
    server,
    planOf: server,
    upToDate: `The scheduled check's key is on ${server}; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    applying: `Adding the scheduled check's key to ${server}`,
  });
}

/**
 * How the deploy reaches the extra server `run.name` the user owns: its public address (as design
 * recorded it in `.opscrew/server.json` → `servers`) on the login's SSH port, with the pinned host
 * key under that name (`[host]:port` when the port is not 22); once public SSH is closed, where
 * this run connected to it instead (`session.reach`: its private address, sshd's port there).
 * @throws OpsCrewError `PHASE_PRECONDITION` when its public address is not known.
 */
export async function extraOwnReach(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<ExtraOwnServerRun, "name" | "session" | "facts">,
): Promise<ServerReach> {
  const { connection, hostKey, reach } = run.session;
  const at = (host: string, port: number): ServerReach => ({
    name: run.name,
    host,
    knownHosts: `${knownHostsName(host, port)} ${hostKey.type} ${hostKey.key}\n`,
  });
  if (reach !== undefined) return at(reach.host, reach.port);
  const address =
    (await readServerAddresses(deps.paths)).servers?.[run.name] ??
    ownServerPublicAddress(connection, run.facts);
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew could not find the public IPv4 address of server ${run.name}, which the deploys reach it at.`,
      {
        hint: "Run `opscrew design` again: it reads the server's addresses and keeps them on this computer.",
      },
    );
  }
  return at(address.ipv4, connection.port);
}

/**
 * Takes the app off the extra server `name` the user owns, which `servers` no longer lists, and
 * leaves what was there before: the teardown host plan (the app's containers, its folder, its
 * private network and its record; its data stays), then, when no other OpsCrew app is on the
 * server, the undo host plan (OpsCrew's own host settings). Each is shown with the server's name
 * and needs an approval that allows destroying, with the server's name typed. Then this computer
 * forgets the server. With `planOnly` the teardown is only shown and saved.
 */
export async function removeExtraOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    name: string;
    services: ProvisionServices;
    deployKeyFile: string;
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome[]> {
  const { plan, name, command } = input;
  const run = await connectExtraOwnServer(deps, input);
  const repository = repositoryUrl(await githubCoordinates(gitClient(deps)));
  const apply = (hostPlan: HostPlan, title: string) =>
    approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: run.session.remote,
      apply: run.host.apply,
      verifyLogin: run.verifyLogin,
      title,
      server: `server ${name}`,
      planOf: `server ${name}`,
      upToDate: `Nothing on server ${name} needs to change.`,
      command,
      phase: input.phase,
      allowDestroy: true,
      confirmPhrase: name,
      intro: [`Server ${name} is no longer in servers in opscrew/plan.yaml.`],
      auditAs: `host ${hostPlan.purpose}`,
      ...(input.planOnly === true ? { planOnly: true } : {}),
      secrets: async () => ({}),
    });
  const teardown = await apply(
    planTeardown(
      run.facts,
      {
        deleteData: false,
        app: plan.app.name,
        projectId: deps.paths.projectId,
        repositoryUrl: repository,
      },
      command,
    ),
    `Remove ${plan.app.name} from server ${name} (its data stays)`,
  );
  if (input.planOnly === true) return [teardown];
  const outcomes = [teardown];
  const facts = await run.host.inspect(run.session.remote);
  if (otherActiveApps(facts.apps, plan.app.name).length === 0) {
    outcomes.push(
      await apply(
        planUndo(facts, { repositoryUrl: repository }, command),
        `Undo OpsCrew's settings on server ${name}`,
      ),
    );
  }
  await updateServerAddresses(deps.paths, ({ servers, ownServers, ...rest }) => {
    const { [name]: _address, ...otherServers } = servers ?? {};
    const { [name]: _login, ...otherLogins } = ownServers ?? {};
    return {
      ...rest,
      ...(Object.keys(otherServers).length > 0 ? { servers: otherServers } : {}),
      ...(Object.keys(otherLogins).length > 0 ? { ownServers: otherLogins } : {}),
    };
  });
  deps.reporter.success(`Took the app off server ${name}; OpsCrew no longer reaches it.`);
  return outcomes;
}
