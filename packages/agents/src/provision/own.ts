import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyHostPlan,
  type DesiredHost,
  type HostFacts,
  type HostPlan,
  hostPlanHash,
  inspectHost,
  planHost,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import {
  renderPortainerCompose,
  renderTunnelConnectorCompose,
  sshHostname,
} from "@opscrew/iac-templates";
import type { DeployPlan, OwnDeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  infrastructureOutputs,
  knownHostsName,
  randomPassword,
  readServerAddresses,
  type ServerAddress,
} from "../shared";
import {
  connectOwnServer,
  type OwnServerSession,
  ownServerLoginCheck,
  ownServerPublicAddress,
} from "../shared/own-server";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import type { HostAdapterApi, ProvisionOptions, ProvisionServices } from "./types";

/** What provision knows about the user's own server once it connected and inspected it. */
export interface OwnServerRun {
  session: OwnServerSession;
  facts: HostFacts;
  target: OwnDeployTarget;
  /** Public mode: the addresses DNS points to (local state only, never committed). */
  address?: ServerAddress;
  /** The port sshd listens on, on the server: the tunnel's SSH route (`ssh://localhost:<port>`). */
  sshPort: number;
  host: HostAdapterApi;
  /** Opens new SSH connections as the deploy user and the admin login (see `ownServerLoginCheck`). */
  verifyLogin: () => Promise<boolean>;
}

/** Placeholder tunnel id for the check before anything changes (the real one comes from the apply). */
const PENDING_TUNNEL_ID = "00000000-0000-0000-0000-000000000000";

/** The target of an own-server plan; throws for any other. */
export function ownTarget(plan: Pick<DeployPlan, "target">): OwnDeployTarget {
  if (plan.target.provider !== "own") {
    throw new Error(`Expected a plan for your own server, got ${plan.target.provider}.`);
  }
  return plan.target;
}

/** `~/.opscrew/projects/<id>/portainer_password` (0600): Portainer's admin password, local only. */
export function portainerPasswordFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer_password");
}

/**
 * Portainer's admin password from {@link portainerPasswordFile}, generated on this computer (32
 * random letters and digits, mode 0600) when the file does not exist yet. Never printed.
 */
export async function ensurePortainerPassword(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<string> {
  const file = portainerPasswordFile(deps.paths);
  const existing = (await readFile(file, "utf8").catch(() => "")).trim();
  const password = existing.length >= 12 ? existing : randomPassword(32);
  if (password !== existing) await writeFileAtomic(file, `${password}\n`, { mode: 0o600 });
  deps.redactor.addLiteral(password, "portainer-password");
  return password;
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The port sshd listens on, on the server: the login's port when sshd uses it, else sshd's first. */
function serverSshPort(facts: HostFacts, loginPort: number): number {
  const ports = facts.sshd?.ports ?? [];
  if (ports.length === 0 || ports.includes(loginPort)) return loginPort;
  return ports[0] as number;
}

/**
 * The desired state of the server for the plan: the app, the admin login, the deploy key, SSH and
 * firewall settings for the access mode, the tunnel connector (with the tunnel's id) and Portainer
 * when the plan turns it on.
 */
export function desiredHost(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<OwnServerRun, "session" | "facts" | "target">,
  input: {
    plan: DeployPlan;
    deployPublicKey: string;
    tunnelId?: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
  },
): DesiredHost {
  const { plan } = input;
  const { connection } = run.session;
  const tunnel =
    run.target.access === "tunnel"
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
    ...(input.passwordLogins !== undefined
      ? { disablePasswords: input.passwordLogins === "off" }
      : {}),
  };
}

/** Findings that need the user's explicit choice about password logins. */
const PASSWORD_CHOICE = new Set(["password-users-without-keys", "directory-logins"]);

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when the host plan has blocking findings or
 * blocked steps: each named with what was found and what to do (the host plan's policy check).
 */
export function requireNoBlockers(plan: HostPlan): void {
  const blocked = plan.steps.filter((step) => step.state === "blocked");
  if (plan.findings.length === 0 && blocked.length === 0) return;
  const reasons =
    plan.findings.length > 0
      ? plan.findings.map((finding) => finding.message)
      : blocked.map((step) => `${step.title}: ${step.reason ?? "blocked"}`);
  const hints = [...new Set(plan.findings.map((finding) => finding.hint))];
  if (plan.findings.some((finding) => PASSWORD_CHOICE.has(finding.code))) {
    hints.push(
      "To decide, run `opscrew provision --password-logins off` (turn password logins off anyway) or `opscrew provision --password-logins keep` (leave them as they are).",
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew cannot prepare your server, so it changed nothing:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}`,
    {
      hint:
        hints.length > 0
          ? hints.join(" ")
          : "Fix what blocks these steps on the server, then run `opscrew provision` again.",
    },
  );
}

/** Plain-English host plan shown before the `host-apply` approval: every step, then the hash. */
export function describeHostPlan(plan: HostPlan, hash: string): string {
  const count = (state: string) => plan.steps.filter((step) => step.state === state).length;
  const blocked = count("blocked");
  const lines = [
    `Host plan for your server: ${count("change")} to change, ${count("in-place")} already in place${blocked > 0 ? `, ${blocked} blocked` : ""}.`,
  ];
  for (const step of plan.steps) {
    if (step.state === "in-place") {
      lines.push(`  ✓ ${step.title} (already in place)`);
      continue;
    }
    lines.push(`  ${step.state === "change" ? "~" : "✗"} ${step.title}`);
    if (step.reason !== undefined) lines.push(`      ${step.reason}`);
  }
  for (const finding of plan.findings) {
    lines.push(`  ! ${finding.message}`, `      ${finding.hint}`);
  }
  lines.push(
    "OpsCrew changes nothing it did not list here, never removes what it did not install, and records every change (and the value it replaced) in /etc/opscrew/host.json on the server.",
    `Host plan hash: ${hash}`,
  );
  return lines.join("\n");
}

/** `.opscrew/plans/host-<hash>.json`: the host plan the hash names, kept for review and audit. */
export function hostPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `host-${hash}.json`);
}

/**
 * Connects to the user's own server (host key confirmed or `--host-key`, pinned), inspects it
 * read-only, and stops before any change when the host plan would be blocked: an unsupported
 * system, another firewall or web server, a different OpsCrew app, a password choice to make, and
 * so on. Also checks that the plan's architecture is the server's, and in public mode finds the
 * public address DNS points to.
 */
export async function prepareOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    options: Pick<ProvisionOptions, "hostKey" | "passwordLogins">;
    services: ProvisionServices;
    deployPublicKey: string;
    deployKeyFile: string;
  },
): Promise<OwnServerRun> {
  const { plan } = input;
  const target = ownTarget(plan);
  const own = input.services.own ?? {};
  const adapter = own.host;
  const host: HostAdapterApi = {
    inspect: (remote) => (adapter?.inspect ? adapter.inspect(remote) : inspectHost(remote)),
    apply: (remote, plan, options) =>
      adapter?.apply ? adapter.apply(remote, plan, options) : applyHostPlan(remote, plan, options),
  };
  if (target.access === "tunnel") sshHostname(plan); // a tunnel needs a Cloudflare domain
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
    phase: "provision",
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
    sshPort: serverSshPort(facts, session.connection.port),
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
    ),
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
 * setup (from the local state) still feeds the old configuration while its records are removed.
 */
export async function ownEngineEnv(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<OwnServerRun, "address" | "target">,
  env: Record<string, string | undefined>,
): Promise<void> {
  const address =
    run.address ?? (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
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
  },
): Promise<PlanAndApplyResult | undefined> {
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
  return planAndApply(deps, {
    engine: input.engine,
    dir: input.dir,
    env: input.env,
    deployPlan: plan,
    files: [],
    command: `opscrew ${input.phase}`,
    phase: input.phase,
    destroy: true,
    costDelta: null,
    approvalTitle: `Remove ${removed} before switching your server to ${MODE_TEXT[target.access]} (first of two applies)`,
    ...(input.approvePlanHash !== undefined ? { approvePlanHash: input.approvePlanHash } : {}),
    ...(input.planOnly ? { planOnly: true } : {}),
  });
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

/** Outcome of {@link applyOwnHostPlan}. */
export interface OwnHostResult {
  plan: HostPlan;
  hash: string;
  applied: boolean;
  approval?: ApprovalRecord;
}

/**
 * The host plan for the user's own server, after the infrastructure exists (the tunnel's id is
 * part of it): saved as `.opscrew/plans/host-<hash>.json`, shown, checked for blocking findings,
 * approved by its hash (`host-apply`), then applied through the host adapter, which refuses any
 * other plan, gets the tunnel token (and Portainer's password) only at apply, and calls
 * `verifyLogin` before keeping an SSH or firewall change. Every step is audited. With `planOnly`
 * it stops after saving and showing the plan. A plan without changes needs no approval.
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
    phase: Extract<PhaseName, "provision" | "dns">;
  },
): Promise<OwnHostResult> {
  const tunnel = run.target.access === "tunnel" ? tunnelOutputs(deps, input.outputs) : undefined;
  const plan = planHost(
    run.facts,
    desiredHost(deps, run, {
      plan: input.plan,
      deployPublicKey: input.deployPublicKey,
      ...(tunnel !== undefined ? { tunnelId: tunnel.id } : {}),
      ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
    }),
  );
  const hash = hostPlanHash(plan);
  await writeFileAtomic(hostPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
  const details = describeHostPlan(plan, hash);
  deps.reporter.info(details);
  requireNoBlockers(plan);
  const changes = plan.steps.filter((step) => step.state === "change");
  if (changes.length === 0) {
    deps.reporter.success("Your server is already prepared; nothing on it changes.");
    return { plan, hash, applied: false };
  }
  if (input.planOnly) {
    deps.reporter.info(`Saved the host plan (hash ${hash}); nothing on your server was changed.`);
    return { plan, hash, applied: false };
  }

  const approval = await deps.approvals.request({
    kind: "host-apply",
    title: `Apply the host plan to your server (${changes.length} change${changes.length === 1 ? "" : "s"})`,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The host plan was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing on your server was changed.`,
      { hint: `To apply it later without prompts, run: opscrew ${input.phase} --approve ${hash}` },
    );
  }
  await deps.approvals.assertApprovedHostPlan(hash);

  const portainerStep = changes.find((step) => step.id === "portainer");
  const portainerPassword =
    portainerStep?.params.needsPassword === true ? await ensurePortainerPassword(deps) : undefined;
  const secrets = {
    ...(tunnel !== undefined ? { tunnelToken: tunnel.token } : {}),
    ...(portainerPassword !== undefined ? { portainerPassword } : {}),
  };
  deps.reporter.step(
    `Preparing your server (${changes.length} change${changes.length === 1 ? "" : "s"}; installing Docker can take a few minutes)`,
  );
  let result: Awaited<ReturnType<HostAdapterApi["apply"]>>;
  try {
    result = await run.host.apply(run.session.remote, plan, {
      approvedHash: hash,
      secrets,
      verifyLogin: run.verifyLogin,
      ...(/^[0-9A-Za-z.+-]{1,64}$/.test(deps.version) ? { version: deps.version } : {}),
      now: () => deps.clock.now(),
    });
  } catch (error) {
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "host apply",
      phase: input.phase,
      target: hash,
      decision: "refused",
      detail: "host apply failed",
    });
    throw error;
  }
  for (const id of result.applied) {
    const step = plan.steps.find((item) => item.id === id);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: `host step ${id}`,
      phase: input.phase,
      target: hash,
      decision: "approved",
      ...(step !== undefined ? { detail: step.title } : {}),
    });
  }
  deps.reporter.success(
    `Prepared your server (${result.applied.length} change${result.applied.length === 1 ? "" : "s"} applied).`,
  );
  return { plan, hash, applied: result.applied.length > 0, approval };
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
  // The deploy workflow connects to sshd's port (`RenderContext.sshPort`, `-o Port=<port>` when it
  // is not 22), so ssh looks the key up as `[ip]:port` there.
  const name = knownHostsName(address.ipv4, run.sshPort);
  return { host: address.ipv4, knownHosts: `${name} ${key.type} ${key.key}\n` };
}
