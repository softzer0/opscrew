import { join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  applyHostPlan,
  type DesiredHost,
  type HostFacts,
  type HostPlan,
  inspectHost,
  planHost,
} from "@opscrew/connector-ssh-host";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, plural } from "@opscrew/core";
import {
  renderPortainerCompose,
  renderTunnelConnectorCompose,
  sshHostname,
  usesTunnel,
  wrongTarget,
} from "@opscrew/iac-templates";
import type { DeployPlan, OwnDeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  addressFromOutputs,
  approveAndApplyHostPlan,
  ensureSecretFile,
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
} from "../shared";
import {
  connectOwnServer,
  type OwnServerSession,
  ownServerLoginCheck,
  ownServerPublicAddress,
} from "../shared/own-server";
import {
  type ConnectorFirst,
  connectorFirst,
  type HostChangeResult,
  tunnelChange,
} from "../shared/tunnel-connections";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
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

/** The port sshd listens on, on the server: the login's port when sshd uses it, else sshd's first. */
function serverSshPort(facts: HostFacts, loginPort: number): number {
  const ports = facts.sshd?.ports ?? [];
  if (ports.length === 0 || ports.includes(loginPort)) return loginPort;
  return ports[0] as number;
}

/**
 * The desired state of the server for the plan: the app, the admin login, the deploy key, SSH and
 * firewall settings for the access mode, the tunnel connector (with the tunnel's id) whenever the
 * plan has a Cloudflare Tunnel (tunnel mode, or a Portainer subdomain in either mode), Portainer
 * when the plan turns it on, and the web filter with Cloudflare's ranges (`run.webSources`) when
 * the site is served directly behind Cloudflare's proxy.
 * @throws Error when the plan needs the web filter but `run.webSources` is missing: a host plan
 * must never drop the filter because the ranges were not read.
 */
export function desiredHost(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<OwnServerRun, "session" | "facts" | "target" | "webSources">,
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
): DesiredHost {
  const { plan } = input;
  const filtered = ownWebFromCloudflare(plan);
  if (filtered && run.webSources === undefined) {
    throw new Error("The web filter needs Cloudflare's IP ranges (read them with ownWebSources).");
  }
  const { connection } = run.session;
  const tunnel =
    usesTunnel(plan) && input.withoutTunnel !== true
      ? {
          compose: renderTunnelConnectorCompose(plan).content,
          tunnelId: input.tunnelId ?? PENDING_TUNNEL_ID,
        }
      : undefined;
  const portainer = plan.portainer?.enabled
    ? {
        version: plan.portainer.version,
        compose: {
          initial: renderPortainerCompose(plan, { initialAdmin: true }).content,
          final: renderPortainerCompose(plan, { initialAdmin: false }).content,
        },
      }
    : undefined;
  return {
    app: plan.app.name,
    projectId: deps.paths.projectId,
    admin: {
      user: run.facts.user || connection.user,
      isRoot: run.facts.privilege === "root",
    },
    deploy: { user: "deploy", publicKey: input.deployPublicKey.trim() },
    sshPort: connection.port,
    access: run.target.access,
    ...(tunnel !== undefined ? { tunnel } : {}),
    ...(portainer !== undefined ? { portainer } : {}),
    ...(filtered && run.webSources !== undefined ? { webFilter: run.webSources } : {}),
    ...(input.passwordLogins !== undefined
      ? { disablePasswords: input.passwordLogins === "off" }
      : {}),
  };
}

/** The phases that change a server the user owns through its host plan. */
type OwnHostPhase = Extract<PhaseName, "provision" | "dns" | "portainer">;

/**
 * Connects to the user's own server (host key confirmed or `--host-key`, pinned), inspects it
 * read-only (audited as `phase`), and stops before any change when the host plan would be blocked:
 * an unsupported system, another firewall or web server, a different OpsCrew app, a password
 * choice to make, and so on (the stop says to run `command` again). Also checks that the plan's
 * architecture is the server's, and in public mode finds the public address DNS points to.
 */
export async function prepareOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    options: Pick<ProvisionOptions, "hostKey" | "passwordLogins">;
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
  const adapter = own.host ?? { inspect: inspectHost, apply: applyHostPlan };
  // Bound, so `run.host.apply` can be passed on as a function.
  const host: HostAdapterApi = {
    inspect: (remote) => adapter.inspect(remote),
    apply: (remote, plan, options) => adapter.apply(remote, plan, options),
  };
  if (target.access === "tunnel") sshHostname(plan); // a tunnel needs a Cloudflare domain
  // Behind Cloudflare's proxy the firewall needs Cloudflare's current ranges; read them first, so
  // a failure stops before anything is changed.
  const webSources = await ownWebSources(deps, plan, input.services.cloudflare);
  deps.reporter.step("Connecting to your server");
  const session = await connectOwnServer(deps, {
    ...(input.options.hostKey !== undefined ? { hostKey: input.options.hostKey } : {}),
    ...(own.remote !== undefined ? { remote: own.remote } : {}),
    ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
  });
  if (session.pinned) {
    deps.reporter.success(`Pinned your server's SSH host key ${session.hostKey.fingerprint}.`);
  }
  deps.reporter.step("Inspecting your server (read-only)");
  const facts = await host.inspect(session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    phase: input.phase,
    target: "own server",
    decision: "allow",
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
  const run: OwnServerRun = {
    session,
    facts,
    target,
    // Public mode: the login's port, which differs from sshd's when a router forwards it (2222 to
    // 22). Only the tunnel's SSH route, on the server itself, needs sshd's own port.
    sshPort:
      target.access === "tunnel"
        ? serverSshPort(facts, session.connection.port)
        : session.connection.port,
    ...(webSources !== undefined ? { webSources } : {}),
    host,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: input.deployKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
  };
  // The check before anything changes: the tunnel's id is not known yet, so a placeholder stands in.
  requireNoBlockers(
    planHost(
      facts,
      desiredHost(deps, run, {
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
 * the tunnel token (and Portainer's password) only then and calls `verifyLogin` before keeping an
 * SSH or firewall change; audited as `phase`, and a refusal or stop says to run `command`. With
 * `planOnly` it stops after saving and showing the plan.
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
    desiredHost(deps, run, {
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
    applying: `Preparing your server (${changes}; installing Docker can take a few minutes)`,
    ...(input.shown !== undefined ? { shown: input.shown } : {}),
  });
  if (!outcome.approval) return outcome;
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
