import {
  applyHostPlan,
  type HostPlan,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  planPortainer,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { portainerHostname, renderPortainerCompose, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessProvider, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { setupCloudflare } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import {
  applyOwnHostPlan,
  dashboardsOnNetwork,
  portainerPasswordFile,
  portainerPasswordToSend,
  portainerWaitsForNetwork,
} from "../provision/own";
import {
  approveAndApplyHostPlan,
  type HostPlanOutcome,
  hasDeployment,
  localhostNotSupported,
  serverlessNoPortainer,
} from "../shared";
import { runPhase } from "../shared/phase-status";
import type { HostChangeResult } from "../shared/tunnel-connections";
import {
  cloudTunnelConnector,
  deployRemote,
  NO_LOGIN_CHECK,
  runTunnelledChange,
  type TunnelledChangeOptions,
  type TunnelledChangeServices,
} from "./change";
import {
  clearPendingPortainer,
  optionsDiffer,
  readPendingPortainer,
  sameSettings,
  savePendingPortainer,
} from "./pending";
import {
  CLOUD_PORTAINER_DIR,
  CLOUD_TUNNEL_DIR,
  PORTAINER_VERSION,
  type PortainerEnableRequest,
  portainerSettings,
  withPortainer,
} from "./settings";
import { describePortainerStatus, type PortainerStatus, portainerStatusOf } from "./status";

/** Collaborators of the Portainer commands; each defaults to the real implementation. */
export type PortainerServices = TunnelledChangeServices;

/** Options shared by `opscrew portainer enable` and `disable`. */
export type PortainerRunOptions = TunnelledChangeOptions;

export interface PortainerEnableOptions extends PortainerEnableRequest, PortainerRunOptions {}

export interface PortainerDisableOptions extends PortainerRunOptions {
  /**
   * Also delete Portainer's data (its `portainer_data` volume). Asked as a separate approval with
   * `allowDestroy` that needs the app's name typed to confirm.
   */
  deleteData?: boolean;
}

/** What an enable or disable run did. Never holds the password or a token. */
export interface PortainerResult {
  /** The infrastructure plan's hash (tunnel and Access), when the change needed one. */
  planHash?: string;
  /**
   * The Cloudflare plan's hash (OpsCrew's shared rules, the account's Zero Trust organization and
   * one-time PIN login), when it has changes: applied, or with `--plan-only` the one to approve.
   */
  cloudflarePlanHash?: string;
  /** True when this run applied the infrastructure plan. */
  applied: boolean;
  /** The host plan's hash (`.opscrew/plans/host-<hash>.json`). */
  hostPlanHash?: string;
  /** True when this run changed the server. */
  hostApplied: boolean;
  /** The hash of the host plan that deletes Portainer's data (disable with `deleteData`). */
  dataPlanHash?: string;
  /** Repository files this run wrote (commit them, or let `opscrew provision` publish them). */
  files: string[];
  status: PortainerStatus;
}

type Command = "enable" | "disable";

interface Change {
  command: Command;
  before: DeployPlan;
  after: DeployPlan;
  deleteData: boolean;
}

function noDeployment(command: Command): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `There is no deployment to ${command === "enable" ? "add Portainer to" : "remove Portainer from"} yet. Nothing was changed.`,
    { hint: "Run `opscrew provision` first." },
  );
}

/**
 * The shared enable/disable flow ({@link runTunnelledChange}) for Portainer: with a subdomain
 * involved, the Cloudflare plan of OpsCrew's shared resources (`cloudflare-apply` by its hash) →
 * render (when a subdomain is involved) → infrastructure plan, policies, `iac-apply` approval and
 * apply when a tunnel is involved → host plan, `host-apply` approval and apply → (disable with
 * `deleteData` on an own server) the data deletion's own approval with the typed app name →
 * `opscrew/plan.yaml` updated.
 */
async function runChange(
  deps: PhaseDeps,
  change: Change,
  options: PortainerRunOptions,
): Promise<PortainerResult> {
  const services = options.services ?? {};
  const command = `opscrew portainer ${change.command}`;
  const enabling = change.command === "enable";
  // Hetzner/DigitalOcean: enabling needs Docker 28 and looks for Portainer's data (both read-only).
  let cloudFacts: CloudFacts | undefined;
  const result = await runTunnelledChange(deps, {
    ...options,
    command,
    phase: "portainer",
    what: "Portainer",
    enabling,
    before: change.before,
    after: change.after,
    hostname: portainerHostname,
    infrastructureTitle:
      enabling && portainerHostname(change.after) !== undefined
        ? `Serve Portainer on ${portainerHostname(change.after)} behind Cloudflare Access (Cloudflare Tunnel and Access)`
        : "Apply the Cloudflare Tunnel and Access changes for Portainer",
    preflight: async ({ remote }) => {
      if (remote !== undefined && enabling) cloudFacts = await cloudPreflight(deps, remote);
    },
    hostChange: ({ ownRun, remote, plan, outputs, deployPublicKey, planOnly, shown }) => {
      if (ownRun !== undefined && enabling && portainerWaitsForNetwork(plan, ownRun.facts)) {
        deps.reporter.info(
          "Portainer's web UI goes on your server's private address for your devices at the next `opscrew provision`, which sets up the private network there: Docker can publish only on an address the server has.",
        );
      }
      return ownRun
        ? applyOwnHostPlan(deps, ownRun, {
            plan,
            outputs,
            deployPublicKey,
            planOnly,
            phase: "portainer",
            command,
            upToDate: enabling
              ? "Portainer already runs on your server as planned; nothing on it changes."
              : "Portainer is no longer on your server; nothing on it changes.",
            shown,
          })
        : cloudHostChange(deps, change, {
            plan,
            outputs,
            services,
            remote: remote as RemoteExec,
            facts: cloudFacts,
            planOnly,
            command,
            shown,
          });
    },
    afterHost: async ({ ownRun, plan, planOnly }) =>
      ownRun && change.deleteData
        ? approveAndApplyHostPlan(deps, {
            plan: planPortainer({
              app: plan.app.name,
              dir: PORTAINER_DIR,
              runAs: "root",
              disable: { deleteData: true },
            }),
            remote: ownRun.session.remote,
            apply: ownRun.host.apply,
            verifyLogin: ownRun.verifyLogin,
            title: `Delete Portainer's data on your server (its admin account and settings)`,
            server: "your server",
            upToDate: "Portainer's data is no longer on your server; nothing on it changes.",
            command,
            phase: "portainer",
            allowDestroy: true,
            planOnly,
            secrets: async () => ({}),
          })
        : undefined,
    planned: (plan) =>
      savePendingPortainer(deps.paths, {
        command: change.command,
        settings: plan.portainer ?? null,
        deleteData: change.deleteData,
      }),
  });
  const { plan, afterHostPlanHash, ...fields } = result;
  const done = {
    ...fields,
    ...(afterHostPlanHash !== undefined ? { dataPlanHash: afterHostPlanHash } : {}),
  };
  if (plan === undefined) {
    return { ...done, status: await portainerStatusOf(deps, change.before) };
  }
  await clearPendingPortainer(deps.paths);
  const status = await portainerStatusOf(deps, plan);
  if (enabling) {
    deps.reporter.success("Portainer is on.");
    deps.reporter.info(describePortainerStatus(status));
  } else {
    deps.reporter.success(
      change.deleteData
        ? "Portainer is off and its data is deleted."
        : "Portainer is off; its data stays on the server (`opscrew portainer disable --delete-data` deletes it).",
    );
  }
  const changedFiles = [...result.files, "opscrew/plan.yaml"];
  deps.reporter.info(
    `Commit ${changedFiles.join(", ")} so the repository describes the deployment (the next \`opscrew provision\` also publishes them in its pull request).`,
  );
  return { ...done, status };
}

/**
 * Read-only, before anything changes: Portainer needs Docker Engine 28 or newer on Hetzner and
 * DigitalOcean servers. Before 28, ports published on 127.0.0.1 are reachable from layer-2
 * neighbours (moby/moby#49325), so Portainer's local-only port would not be local. Servers the user
 * owns already get Docker 28 or newer through the host plan.
 */
async function cloudPreflight(deps: PhaseDeps, remote: RemoteExec): Promise<CloudFacts> {
  await requireDocker28(deps, remote);
  return { dataVolume: await portainerDataExists(deps, remote) };
}

/** What the read-only checks found on a Hetzner or DigitalOcean server. */
interface CloudFacts {
  /** Portainer's data volume exists: its admin account was created by an earlier run. */
  dataVolume: boolean;
}

/** Portainer's data volume (Compose project `opscrew-portainer`, volume `portainer_data`). */
const PORTAINER_DATA_VOLUME = "opscrew-portainer_portainer_data";

/**
 * Read-only: whether Portainer's data volume is on the server (as the deploy user). A failure
 * other than "no such volume" stops, so OpsCrew never guesses whether an admin account exists.
 */
async function portainerDataExists(deps: PhaseDeps, remote: RemoteExec): Promise<boolean> {
  let result: Awaited<ReturnType<RemoteExec["run"]>> | undefined;
  try {
    result = await remote.run(
      `docker volume inspect --format '{{.Name}}' ${PORTAINER_DATA_VOLUME}`,
      { timeoutMs: 60_000 },
    );
  } catch {
    result = undefined;
  }
  const exists = result?.exitCode === 0;
  if (!exists && !/no such volume/i.test(result?.stderr ?? "")) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not check whether Portainer's data is already on the server, so it did not set up Portainer. Nothing was changed.",
      {
        hint: "Check that the server is reachable over SSH and that Docker is running, then run the command again.",
      },
    );
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "look for Portainer's data volume (read-only)",
    phase: "portainer",
    target: "server",
    decision: "allow",
    detail: exists ? "present" : "absent",
  });
  return exists;
}

async function requireDocker28(deps: PhaseDeps, remote: RemoteExec): Promise<void> {
  let version = "";
  try {
    const result = await remote.run("docker version --format '{{.Server.Version}}'", {
      timeoutMs: 60_000,
    });
    if (result.exitCode === 0) version = result.stdout.trim().split(/\s+/)[0] ?? "";
  } catch {
    version = "";
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read Docker version (read-only)",
    phase: "portainer",
    target: "server",
    decision: "allow",
    ...(version !== "" ? { detail: `Docker ${version}` } : {}),
  });
  const match = /^(\d+)\.\d+/.exec(version);
  if (match === null) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not read the Docker version on the server as the deploy user, so it did not set up Portainer. Nothing was changed.",
      {
        hint: "Check that the server is reachable over SSH and that Docker is running (`docker version` as the deploy user), then run the command again.",
      },
    );
  }
  if (Number(match[1]) < MIN_DOCKER_MAJOR) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This server runs Docker ${deps.redactor.redact(version.slice(0, 40))}; Portainer needs Docker ${MIN_DOCKER_MAJOR} or newer, which keeps its local-only port truly local. Nothing was changed.`,
      {
        hint: "Upgrade Docker (OpsCrew-created servers get it from Docker's repository from now on), then run the command again.",
      },
    );
  }
}

/**
 * Hetzner and DigitalOcean: the deploy user's add-on plan, with Portainer on (pinned to the plan's
 * version; `needsPassword` when it has no admin account yet) or off, and the tunnel connector of
 * its subdomain when there is one to run or remove.
 */
function cloudPortainerPlan(
  plan: DeployPlan,
  portainer: { enabled: true; needsPassword: boolean } | { enabled: false; deleteData: boolean },
  connector?: Parameters<typeof planPortainer>[0]["connector"],
): HostPlan {
  return planPortainer({
    app: plan.app.name,
    dir: CLOUD_PORTAINER_DIR,
    runAs: "login",
    ...(portainer.enabled
      ? {
          enable: {
            version: plan.portainer?.version ?? PORTAINER_VERSION,
            compose: {
              initial: renderPortainerCompose(plan, {
                initialAdmin: true,
                dashboardsOnNetwork: dashboardsOnNetwork(plan),
              }).content,
              final: renderPortainerCompose(plan, {
                initialAdmin: false,
                dashboardsOnNetwork: dashboardsOnNetwork(plan),
              }).content,
            },
            needsPassword: portainer.needsPassword,
          },
        }
      : { disable: { deleteData: portainer.deleteData } }),
    ...(connector !== undefined ? { connector } : {}),
  });
}

/**
 * Hetzner and DigitalOcean: Portainer (and, for a subdomain, its tunnel connector) runs as the
 * deploy user in its home directory (the deploy user is in the docker group; no root needed),
 * over the deploy key and the pinned host key.
 */
async function cloudHostChange(
  deps: PhaseDeps,
  change: Change,
  input: {
    plan: DeployPlan;
    outputs: Record<string, unknown>;
    services: PortainerServices;
    remote: RemoteExec;
    /** From {@link cloudPreflight} (enable only). */
    facts: CloudFacts | undefined;
    planOnly: boolean;
    command: string;
    /** Told the host plan's hash as soon as it is shown. */
    shown: (hash: string) => void;
  },
): Promise<HostPlanOutcome> {
  const { plan, outputs } = input;
  const enabling = change.command === "enable";
  // With Portainer's data on the server a password is not required (an admin may exist); the
  // local one is still sent when it is here, so an admin missing after a stopped first start is made.
  const needsPassword = enabling && input.facts?.dataVolume !== true;
  if (enabling && !needsPassword) {
    const file = portainerPasswordFile(deps.paths);
    if (!(await exists(file))) {
      deps.reporter.warn(
        `Portainer's data is already on the server, so its admin account keeps the password it was created with, and that password is not on this computer (${file}). Copy the file from the computer that turned Portainer on, or run \`opscrew portainer disable --delete-data\` and then \`opscrew portainer enable\` again for a new admin account.`,
      );
    }
  }
  let connector: Parameters<typeof planPortainer>[0]["connector"];
  let tunnelToken: string | undefined;
  if (enabling && portainerHostname(plan) !== undefined) {
    ({ connector, tunnelToken } = await cloudTunnelConnector(deps, plan, outputs, {
      command: input.command,
      whose: "Portainer's",
    }));
  } else if (portainerHostname(change.before) !== undefined && !usesTunnel(plan)) {
    // The connector stays while another subdomain (Beszel's) still goes through the tunnel.
    connector = { dir: CLOUD_TUNNEL_DIR, remove: true };
  }
  return approveAndApplyHostPlan(deps, {
    plan: cloudPortainerPlan(
      plan,
      enabling
        ? { enabled: true, needsPassword }
        : { enabled: false, deleteData: change.deleteData },
      connector,
    ),
    remote: input.remote,
    apply: input.services.applyHost ?? applyHostPlan,
    verifyLogin: NO_LOGIN_CHECK,
    server: "the server",
    title: enabling
      ? "Run Portainer on the server as the deploy user"
      : change.deleteData
        ? "Remove Portainer and delete its data on the server"
        : "Remove Portainer from the server (its data stays)",
    upToDate: enabling
      ? "Portainer already runs on the server as planned; nothing on it changes."
      : change.deleteData
        ? "Portainer and its data are no longer on the server; nothing on it changes."
        : "Portainer is no longer on the server; nothing on it changes.",
    command: input.command,
    phase: "portainer",
    allowDestroy: !enabling && change.deleteData,
    planOnly: input.planOnly,
    secrets: async () => {
      // Required only without data; sent whenever it is on this computer (see portainerPasswordToSend).
      const portainerPassword = enabling
        ? await portainerPasswordToSend(deps, needsPassword)
        : undefined;
      return {
        ...(tunnelToken !== undefined ? { tunnelToken } : {}),
        ...(portainerPassword !== undefined ? { portainerPassword } : {}),
      };
    },
    shown: input.shown,
  });
}

/**
 * Hetzner and DigitalOcean: the deploy user's add-on plan that removes the Cloudflare Tunnel
 * connector of a Portainer subdomain the plan no longer has, keeping Portainer as the plan
 * describes it (on and local only, or off with its data kept). It goes before a plan that deletes
 * the tunnel (`opscrew provision`), with its own `host-apply` approval by its hash; with
 * `planOnly` it is only shown and saved. `shown` gets its hash as soon as it is shown.
 */
export async function cloudConnectorRemoval(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: PortainerServices;
    command: string;
    planOnly: boolean;
    shown: (hash: string) => void;
  },
): Promise<HostChangeResult> {
  const { plan, services } = input;
  const remote = await deployRemote(deps, services);
  const enabled = plan.portainer?.enabled === true;
  return approveAndApplyHostPlan(deps, {
    plan: cloudPortainerPlan(
      plan,
      // Portainer runs already: its admin account exists.
      enabled ? { enabled: true, needsPassword: false } : { enabled: false, deleteData: false },
      { dir: CLOUD_TUNNEL_DIR, remove: true },
    ),
    remote,
    apply: services.applyHost ?? applyHostPlan,
    verifyLogin: NO_LOGIN_CHECK,
    server: "the server",
    title:
      "Remove the Cloudflare Tunnel connector from the server (Portainer's subdomain is no longer planned)",
    upToDate: "The Cloudflare Tunnel connector is no longer on the server; nothing on it changes.",
    command: input.command,
    phase: "provision",
    planOnly: input.planOnly,
    secrets: async () => {
      const portainerPassword = enabled ? await portainerPasswordToSend(deps, false) : undefined;
      return portainerPassword !== undefined ? { portainerPassword } : {};
    },
    shown: input.shown,
  });
}

/**
 * Runs an enable or disable and records the `portainer` phase: `ok` with `summary` once the change
 * went through (a `--plan-only` run records nothing), `failed` with the reason when it stopped.
 */
async function recordedPhase(
  deps: PhaseDeps,
  planOnly: boolean,
  summary: "Portainer on" | "Portainer off",
  run: () => Promise<PortainerResult>,
): Promise<PortainerResult> {
  return runPhase(deps, "portainer", async () => {
    const result = await run();
    if (!planOnly) await deps.state.markPhase("portainer", "ok", summary);
    return result;
  });
}

/**
 * `opscrew portainer enable [--subdomain <host> --allow-email <email>…]`: turns Portainer CE on
 * for the project on any target, pinned to {@link PORTAINER_VERSION}, listening only on the
 * server itself. Its admin password is generated on this computer
 * (`~/.opscrew/projects/<id>/portainer_password`, 0600), supplied only at apply and never
 * printed. On a server the user owns it is a host-plan step (`host-apply`); on Hetzner and
 * DigitalOcean it runs as the deploy user. The subdomain opt-in also plans the Cloudflare Tunnel
 * and Access (`iac-apply`) and needs the app's Cloudflare domain and at least one email address.
 * Records the `portainer` phase.
 */
export function portainerEnable(
  deps: PhaseDeps,
  options: PortainerEnableOptions = {},
): Promise<PortainerResult> {
  return recordedPhase(deps, options.planOnly === true, "Portainer on", () =>
    enable(deps, options),
  );
}

/**
 * `opscrew portainer disable [--delete-data]`: removes Portainer (and the tunnel and Access of a
 * subdomain) behind the same approvals. Its data stays unless `deleteData` is set; deleting it is
 * a separate approval that needs the app's name typed to confirm. Records the `portainer` phase.
 */
export function portainerDisable(
  deps: PhaseDeps,
  options: PortainerDisableOptions = {},
): Promise<PortainerResult> {
  return recordedPhase(deps, options.planOnly === true, "Portainer off", () =>
    disable(deps, options),
  );
}

async function enable(deps: PhaseDeps, options: PortainerEnableOptions): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  if (before.target.provider === "localhost") {
    throw localhostNotSupported("`opscrew portainer enable`");
  }
  if (isServerlessProvider(before.target.provider)) {
    throw serverlessNoPortainer("`opscrew portainer enable`", before.target.provider);
  }
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("enable");
  const approving = (options.approvePlanHashes ?? []).length > 0;
  const pending = approving ? await readPendingPortainer(deps.paths) : undefined;
  if (pending !== undefined && pending.command !== "enable") throw optionsDiffer();
  const flags = options.subdomain !== undefined || (options.allowEmails ?? []).length > 0;
  const fromPending = pending?.settings != null && !flags ? pending.settings : undefined;
  let zone = before.dns.zone;
  if ((options.subdomain !== undefined || fromPending?.hostname !== undefined) && !zone) {
    // A subdomain needs the zone (a bare label like `portainer` too); the Cloudflare check learns it.
    zone = (await setupCloudflare(deps, before, options.services ?? {}))?.zoneName;
  }
  const base = zone === undefined ? before : { ...before, dns: { ...before.dns, zone } };
  // `--approve` without options applies exactly the settings the --plan-only run planned; other
  // options than those are refused.
  const after = withPortainer(base, fromPending ?? portainerSettings(before, options, zone));
  if (pending !== undefined && !sameSettings(pending.settings, after.portainer ?? null)) {
    throw optionsDiffer();
  }
  return runChange(deps, { command: "enable", before, after, deleteData: false }, options);
}

async function disable(
  deps: PhaseDeps,
  options: PortainerDisableOptions,
): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  if (before.target.provider === "localhost") {
    throw localhostNotSupported("`opscrew portainer disable`");
  }
  if (isServerlessProvider(before.target.provider)) {
    throw serverlessNoPortainer("`opscrew portainer disable`", before.target.provider);
  }
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("disable");
  const approving = (options.approvePlanHashes ?? []).length > 0;
  const pending = approving ? await readPendingPortainer(deps.paths) : undefined;
  if (pending !== undefined) {
    if (pending.command !== "disable") throw optionsDiffer();
    if (options.deleteData !== undefined && options.deleteData !== pending.deleteData) {
      throw optionsDiffer();
    }
  }
  const deleteData = pending?.deleteData ?? options.deleteData === true;
  // With `--approve` the planned removal runs even then: it changes nothing when Portainer is gone.
  if (!before.portainer?.enabled && !deleteData && !approving) {
    deps.reporter.info("Portainer is already off for this project; nothing to do.");
    return {
      applied: false,
      hostApplied: false,
      files: [],
      status: await portainerStatusOf(deps, before),
    };
  }
  const after = withPortainer(before, undefined);
  return runChange(deps, { command: "disable", before, after, deleteData }, options);
}
