import {
  type AddonConnector,
  type ApplySecrets,
  applyHostPlan,
  type HostPlan,
  planAddon,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { type AddonKind, beszelHostname, renderAddon, usesTunnel } from "@opscrew/iac-templates";
import type {
  BeszelSettings,
  DeployPlan,
  GrafanaCloudSettings,
  Money,
  Observability,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import {
  cloudTunnelConnector,
  NO_LOGIN_CHECK,
  runTunnelledChange,
  type TunnelledChangeOptions,
  type TunnelledChangeServices,
} from "../portainer/change";
import { CLOUD_TUNNEL_DIR } from "../portainer/settings";
import { setupCloudflare } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { applyOwnHostPlan, dashboardsOnNetwork, type OwnServerRun } from "../provision/own";
import { approveAndApplyHostPlan, hasDeployment } from "../shared";
import { connectAndInspectOwnServer } from "../shared/own-server";
import type { HostChangeResult } from "../shared/tunnel-connections";
import { hasAppInterface } from "../vpn/dashboards";
import { estimateText, grafanaEstimate, readServer, type ServerReading } from "./estimate";
import {
  BESZEL_EMAIL,
  ensureBeszelHubSecrets,
  readBeszelSecrets,
  readGrafanaToken,
  removeAddonSecrets,
  writeBeszelSecrets,
  writeGrafanaToken,
} from "./secrets";
import {
  ADDON_NAMES,
  ADDON_PHASE,
  addonEnabled,
  type BeszelRequest,
  beszelSettings,
  grafanaSettings,
  requireServerTarget,
  withAddon,
} from "./settings";
import { type AddonStatus, addonStatusOf, deployUserShell, describeAddonStatus } from "./status";

/** A value OpsCrew asks for in an interactive run. */
export interface AddonQuestion {
  /** The flag or variable that gives it without asking: `--metrics-url`, `OPSCREW_…`. */
  name: string;
  /** The question, in words. */
  prompt: string;
  /** A secret: never echoed, shown or logged. */
  secret: boolean;
}

/** Collaborators of the add-on commands; each defaults to the real implementation. */
export interface AddonServices extends TunnelledChangeServices {
  /** Asks the user for a missing value (interactive runs only). */
  ask?: (question: AddonQuestion) => Promise<string>;
}

/** Options every add-on command takes (`--plan-only`, `--approve`, `--host-key`, `--engine`). */
export interface AddonRunOptions extends Omit<TunnelledChangeOptions, "services"> {
  services?: AddonServices;
}

/** `opscrew addon enable`: Beszel's request, or Grafana Cloud's stack and log sampling. */
export interface AddonEnableOptions extends AddonRunOptions, BeszelRequest {
  /** Grafana Cloud: the stack's Prometheus `remote_write` URL and its numeric user id. */
  metricsUrl?: string;
  metricsUser?: string;
  /** Grafana Cloud: the stack's Loki push URL and its numeric user id. */
  logsUrl?: string;
  logsUser?: string;
  /** Grafana Cloud: the percentage of log lines sent (1–100). */
  logSampling?: number;
}

/** `opscrew addon disable`. */
export interface AddonDisableOptions extends AddonRunOptions {
  /** Beszel: keep its history (the dashboard's data) on the server; no typed name needed then. */
  keepData?: boolean;
}

/** What an enable or disable run did. Never holds a secret. */
export interface AddonResult {
  /** The infrastructure plan's hash (tunnel and Access), when the change needed one. */
  planHash?: string;
  /** The Cloudflare plan's hash of OpsCrew's shared resources, when it has changes. */
  cloudflarePlanHash?: string;
  /** True when this run applied the infrastructure plan. */
  applied: boolean;
  /** The hashes of the host plans shown (`.opscrew/plans/host-<hash>.json`), in order. */
  hostPlanHashes: string[];
  /** True when this run changed the server. */
  hostApplied: boolean;
  /** Repository files this run wrote. */
  files: string[];
  status: AddonStatus;
  /**
   * The command that makes the same plans again, to which `--approve <hash>` is added: the app's
   * `--app` and `--env` when they are not the defaults, the add-on's options, and the token's
   * variable when it must be set again (never its value).
   */
  approveCommand: string;
}

/** Grafana Cloud's access policy token: its scopes and where it is made. */
const GRAFANA_TOKEN_HELP =
  "Grafana Cloud needs an access policy token with only the metrics:write and logs:write scopes: create it in the Grafana Cloud Portal under Administration → Users and access → Cloud access policies (https://grafana.com/docs/grafana-cloud/account-management/authentication-and-permissions/access-policies/). The stack's details page lists its Prometheus and Loki URLs and their user ids.";

/** The host step of each add-on. */
function stepKind(kind: AddonKind): "beszel" | "alloy" {
  return kind === "beszel" ? "beszel" : "alloy";
}

function noDeployment(kind: AddonKind, enabling: boolean): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `There is no deployment to ${enabling ? "add" : "remove"} ${ADDON_NAMES[kind]} ${enabling ? "to" : "from"} yet. Nothing was changed.`,
    { hint: "Run `opscrew provision` first." },
  );
}

/** Checks shared by every add-on command: a server target with a deployment, not moving. */
function requireDeployedServer(
  plan: DeployPlan,
  kind: AddonKind,
  command: string,
  enabling: boolean,
): void {
  requireServerTarget(plan, kind, command);
  requireNoMoveInProgress(plan);
  if (!hasDeployment(plan)) throw noDeployment(kind, enabling);
}

/**
 * A value from a flag, the plan, an environment variable or the user, in that order; a run nobody
 * can answer stops with the flag or variable to give it with.
 */
async function answerFor(
  deps: Pick<PhaseDeps, "interactive">,
  services: AddonServices,
  given: string | undefined,
  question: AddonQuestion,
): Promise<string> {
  const value = given?.trim();
  if (value !== undefined && value !== "") return value;
  if (!deps.interactive || services.ask === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew needs ${question.prompt}, and nobody can be asked in this run. Nothing was changed.`,
      {
        hint: question.name.startsWith("OPSCREW_")
          ? `Set ${question.name} and run the command again.`
          : `Give it with \`${question.name}\` and run the command again.`,
      },
    );
  }
  const answer = (await services.ask(question)).trim();
  if (answer === "") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `No ${question.prompt} was given. Nothing was changed.`,
      {
        hint: `Run the command again and give it, or use \`${question.name}\`.`,
      },
    );
  }
  return answer;
}

/** What turning an add-on on needs besides the plan: the step's input and the secrets to send. */
interface EnableInput {
  after: DeployPlan;
  /** The host step's settings besides the rendered files (Beszel's mode, email and hub key). */
  step: { mode: "hub"; email: string; hubKey: string } | { mode: "agent" } | undefined;
  secrets: ApplySecrets;
  /** Kept on this computer once the add-on runs (values the user gave). */
  keep?: () => Promise<void>;
  /** The variable a later run needs set again: the token was given, not kept on this computer. */
  tokenVariable?: string;
}

/** A value as one shell word (quoted when it holds anything but plain characters). */
function shellWord(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that runs this change again, as every `--approve` hint names it: the app's and
 * environment's `flag`, Beszel's options given, Grafana Cloud's settings as planned (answers at a
 * prompt included), and the token's variable when it must be set again (never its value).
 */
function enableCommand(
  kind: AddonKind,
  options: AddonEnableOptions,
  input: EnableInput,
  flag: string,
): string {
  const grafana = input.after.observability?.grafanaCloud;
  const flags: [string, string | number | undefined][] = [
    ["--mode", options.mode],
    ["--access", options.access],
    ["--hostname", options.hostname],
    ...(options.allowEmails ?? []).map((email): [string, string] => ["--allow-email", email]),
    ["--hub-url", options.hubUrl],
    ["--hub-key", options.hubKey],
    ...(kind === "grafana-cloud" && grafana !== undefined
      ? ([
          ["--metrics-url", grafana.metrics?.url],
          ["--metrics-user", grafana.metrics?.user],
          ["--logs-url", grafana.logs?.url],
          ["--logs-user", grafana.logs?.user],
          ["--log-sampling", grafana.logSampling],
        ] as [string, string | number | undefined][])
      : []),
  ];
  const { tokenVariable } = input;
  return [
    ...(tokenVariable !== undefined ? [`${tokenVariable}=<token>`] : []),
    `opscrew addon enable ${kind}${flag}`,
    ...flags.flatMap(([flag, value]) =>
      value === undefined ? [] : [`${flag} ${shellWord(String(value))}`],
    ),
  ].join(" ");
}

/** Beszel: the plan's settings, the hub's secrets (generated once) or the agent's token. */
async function beszelInput(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AddonEnableOptions,
): Promise<EnableInput> {
  const services = options.services ?? {};
  const current = plan.observability?.beszel;
  const mode = options.mode ?? "hub";
  if (current?.enabled && current.mode !== mode) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Beszel runs in ${current.mode} mode on this server, so OpsCrew does not switch it to ${mode} mode in place. Nothing was changed.`,
      {
        hint: `Turn it off first with \`opscrew addon disable beszel\` (add \`--keep-data\` to keep its history), then run this command again.`,
      },
    );
  }
  const stored = await readBeszelSecrets(deps);
  if (mode === "agent" && stored?.mode === "hub") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Beszel's history from hub mode may be kept on the server, and its dashboard's password is in ${deps.paths.files.beszelSecrets}, so OpsCrew does not turn on agent mode over it. Nothing was changed.`,
      {
        hint: "Turn hub mode on again with `opscrew addon enable beszel`, or delete the kept history with `opscrew addon disable beszel` (it asks for the app's name), then run this command again.",
      },
    );
  }
  let zone = plan.dns.zone;
  if (options.access === "subdomain" && zone === undefined && plan.dns.provider === "cloudflare") {
    // A bare label (`beszel`) needs the zone; the Cloudflare check learns it.
    zone = (await setupCloudflare(deps, plan, services))?.zoneName;
  }
  const base = zone === undefined ? plan : { ...plan, dns: { ...plan.dns, zone } };
  const after = withAddon(base, "beszel", beszelSettings(base, options, zone));
  if (after.observability?.beszel?.mode === "hub") {
    const hub = await ensureBeszelHubSecrets(deps);
    return {
      after,
      step: { mode: "hub", email: BESZEL_EMAIL, hubKey: hub.hubPublicKey },
      secrets: { beszelPassword: hub.password, beszelToken: hub.token, beszelHubKey: hub.hubKey },
    };
  }
  const kept = stored?.mode === "agent" ? stored.token : undefined;
  const token = await answerFor(deps, services, deps.env.OPSCREW_BESZEL_TOKEN ?? kept, {
    name: "OPSCREW_BESZEL_TOKEN",
    prompt: "the token your Beszel hub shows for this server (Add system)",
    secret: true,
  });
  deps.redactor.addLiteral(token, "beszel-token");
  return {
    after,
    step: { mode: "agent" },
    secrets: { beszelToken: token },
    keep: () => writeBeszelSecrets(deps.paths, { mode: "agent", token }),
    ...(token !== kept ? { tokenVariable: "OPSCREW_BESZEL_TOKEN" } : {}),
  };
}

/** Grafana Cloud: the stack's endpoints and sampling, and the token (given or kept here). */
async function grafanaInput(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AddonEnableOptions,
): Promise<EnableInput> {
  const services = options.services ?? {};
  const current = plan.observability?.grafanaCloud;
  const stored = await readGrafanaToken(deps);
  if (stored === undefined) deps.reporter.info(GRAFANA_TOKEN_HELP);
  const ask = (given: string | undefined, name: string, prompt: string) =>
    answerFor(deps, services, given, { name, prompt, secret: false });
  const metrics = {
    url: await ask(
      options.metricsUrl ?? current?.metrics?.url,
      "--metrics-url",
      "your Grafana Cloud stack's Prometheus remote_write URL (https://…/api/prom/push)",
    ),
    user: await ask(
      options.metricsUser ?? current?.metrics?.user,
      "--metrics-user",
      "the numeric user id of your stack's Prometheus",
    ),
  };
  const logs = {
    url: await ask(
      options.logsUrl ?? current?.logs?.url,
      "--logs-url",
      "your Grafana Cloud stack's Loki push URL (https://…/loki/api/v1/push)",
    ),
    user: await ask(
      options.logsUser ?? current?.logs?.user,
      "--logs-user",
      "the numeric user id of your stack's Loki",
    ),
  };
  const after = withAddon(
    plan,
    "grafana-cloud",
    grafanaSettings(plan, {
      metrics,
      logs,
      logSampling: options.logSampling ?? current?.logSampling ?? 100,
    }),
  );
  const token = await answerFor(deps, services, deps.env.OPSCREW_GRAFANA_CLOUD_TOKEN ?? stored, {
    name: "OPSCREW_GRAFANA_CLOUD_TOKEN",
    prompt: "your Grafana Cloud access policy token (metrics:write and logs:write only)",
    secret: true,
  });
  deps.redactor.addLiteral(token, "grafana-cloud-token");
  return {
    after,
    step: undefined,
    secrets: { grafanaCloudToken: token },
    keep: () => writeGrafanaToken(deps.paths, token),
    ...(token !== stored ? { tokenVariable: "OPSCREW_GRAFANA_CLOUD_TOKEN" } : {}),
  };
}

/** The plan's `observability` block, which a plan with an add-on on has. */
function observability(plan: DeployPlan): Observability {
  return plan.observability as Observability;
}

/** The add-on's containers in the plan, each with its memory limit in MB. */
function addonContainers(plan: DeployPlan, kind: AddonKind): [string, number][] {
  const proxy = "the read-only Docker proxy";
  if (kind === "grafana-cloud") {
    const { memoryMb } = observability(plan).grafanaCloud as GrafanaCloudSettings;
    return [
      ["Alloy", memoryMb.alloy],
      [proxy, memoryMb.proxy],
    ];
  }
  const { mode, memoryMb } = observability(plan).beszel as BeszelSettings;
  return [
    ...(mode === "hub" ? [["the hub (dashboard)", memoryMb.hub] as [string, number]] : []),
    ["the agent", memoryMb.agent],
    [proxy, memoryMb.proxy],
  ];
}

/** Each container's memory limit and its share of the server's monthly price (`memoryText`'s way). */
function memoryLine(
  plan: DeployPlan,
  kind: AddonKind,
  server: { memoryMb: number; monthly?: Money },
): string {
  const containers = addonContainers(plan, kind);
  const { monthly } = server;
  const share = (mb: number) =>
    monthly === undefined
      ? ""
      : ` (${formatMoney({ amount: (monthly.amount * mb) / server.memoryMb, currency: monthly.currency })}/month)`;
  return `Memory limits of ${ADDON_NAMES[kind]}'s containers: ${containers.map(([name, mb]) => `${name} ${mb} MB${share(mb)}`).join(", ")}; the server has ${(server.memoryMb / 1024).toFixed(1)} GB.`;
}

/** What one add-on change needs to plan its host step. */
interface AddonChange {
  kind: AddonKind;
  enabling: boolean;
  command: string;
  before: DeployPlan;
  /** Enabling: the step's settings and the secrets. */
  input?: EnableInput;
  keepData: boolean;
  /** Beszel is off already; only the history its hub mode left on the server goes. */
  history?: boolean;
  services: AddonServices;
  /** Said before the host plan (memory and price share, Grafana's estimate). */
  intro: string[];
}

/**
 * The add-on's host plan (and, on a server OpsCrew created, the tunnel connector of Beszel's
 * subdomain): shown, approved by its hash (`host-apply`; deleting Beszel's history with
 * `allowDestroy` and the typed app name) and applied, the secrets on stdin only.
 */
async function addonHostChange(
  deps: PhaseDeps,
  change: AddonChange,
  input: {
    ownRun?: OwnServerRun;
    remote?: RemoteExec;
    plan: DeployPlan;
    outputs: Record<string, unknown>;
    planOnly: boolean;
    shown?: (hash: string) => void;
  },
): Promise<HostChangeResult> {
  const { kind, enabling, command } = change;
  const { ownRun, plan } = input;
  let connector: AddonConnector | undefined;
  let tunnelToken: string | undefined;
  if (!ownRun && kind === "beszel") {
    if (enabling && beszelHostname(plan) !== undefined) {
      ({ connector, tunnelToken } = await cloudTunnelConnector(deps, plan, input.outputs, {
        command,
        whose: "Beszel's",
      }));
    } else if (beszelHostname(change.before) !== undefined && !usesTunnel(plan)) {
      // The connector stays while Portainer's subdomain still goes through the tunnel.
      connector = { dir: CLOUD_TUNNEL_DIR, remove: true };
    }
  }
  const hostPlan = addonPlan(change, plan, ownRun, connector);
  if (
    ownRun !== undefined &&
    enabling &&
    plan.observability?.beszel?.mode === "hub" &&
    kind === "beszel" &&
    dashboardsOnNetwork(plan, ownRun.facts) &&
    !hasAppInterface(plan, ownRun.facts)
  ) {
    deps.reporter.info(
      "Beszel's dashboard goes on your server's private address for your devices once the private network is set up there: run `opscrew provision`, then `opscrew addon enable beszel` again.",
    );
  }
  const name = ADDON_NAMES[kind];
  const server = ownRun ? "your server" : "the server";
  const what = kind === "beszel" ? "Beszel" : "Grafana Alloy";
  const title = enabling
    ? kind === "beszel"
      ? plan.observability?.beszel?.mode === "agent"
        ? `Run Beszel's agent on ${server}, connected to your hub`
        : `Run Beszel (its dashboard and agent) on ${server}`
      : `Run Grafana Alloy on ${server}, sending the app's logs and the server's metrics to Grafana Cloud`
    : agentOnly(change)
      ? `Remove Beszel's agent from ${server}`
      : change.history === true
        ? `Delete Beszel's kept history on ${server}`
        : hostPlan.deleteData === true
          ? `Remove Beszel and delete its history on ${server}`
          : `Remove ${what} from ${server}${kind === "beszel" ? " (its history stays)" : ""}`;
  return approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote: ownRun?.session.remote ?? (input.remote as RemoteExec),
    apply: ownRun?.host.apply ?? change.services.applyHost ?? applyHostPlan,
    verifyLogin: ownRun?.verifyLogin ?? NO_LOGIN_CHECK,
    title,
    server,
    upToDate: enabling
      ? `${name} already runs on ${server} as planned; nothing on it changes.`
      : `${name} is no longer on ${server}; nothing on it changes.`,
    command,
    phase: ADDON_PHASE,
    ...(hostPlan.deleteData === true ? { allowDestroy: true } : {}),
    intro: change.intro,
    planOnly: input.planOnly,
    secrets: async () => ({
      ...(enabling ? change.input?.secrets : {}),
      ...(tunnelToken !== undefined ? { tunnelToken } : {}),
    }),
    ...(input.shown !== undefined ? { shown: input.shown } : {}),
  });
}

/**
 * True when the dashboards go on the app's server's private address (`dashboardsOnNetwork`), and,
 * on the user's own server, its WireGuard interface is there already: Docker never binds an address
 * the server doesn't have.
 */
function dashboardsPublished(plan: DeployPlan, ownRun: OwnServerRun | undefined): boolean {
  return (
    dashboardsOnNetwork(plan, ownRun?.facts) &&
    (ownRun === undefined || hasAppInterface(plan, ownRun.facts))
  );
}

/** The add-on's host plan: on (the files `renderAddon` renders for `plan`) or off. */
function addonPlan(
  change: AddonChange,
  plan: DeployPlan,
  ownRun: OwnServerRun | undefined,
  connector?: AddonConnector,
): HostPlan {
  const files = change.enabling
    ? Object.fromEntries(
        renderAddon(plan, change.kind, {
          dashboardsOnNetwork: dashboardsPublished(plan, ownRun),
        }).map((file) => [file.path, file.content]),
      )
    : {};
  const enable = change.input?.step === undefined ? { files } : { ...change.input.step, files };
  return planAddon(stepKind(change.kind), {
    app: plan.app.name,
    runAs: ownRun ? "root" : "login",
    ...(ownRun ? { facts: ownRun.facts } : {}),
    ...(change.enabling
      ? { enable }
      : {
          disable: {
            keepData: change.keepData,
            ...(change.kind === "beszel" ? { mode: agentOnly(change) ? "agent" : "hub" } : {}),
          },
        }),
    ...(connector !== undefined ? { connector } : {}),
  });
}

/** Turning off Beszel's agent mode: only the agent runs on the server, which keeps no history. */
function agentOnly(change: Pick<AddonChange, "kind" | "before">): boolean {
  return change.kind === "beszel" && change.before.observability?.beszel?.mode === "agent";
}

/**
 * The shared enable and disable flow (`runTunnelledChange`, as Portainer's): the plan's block
 * written once the change is on the server; with Beszel's subdomain involved, OpsCrew's shared
 * Cloudflare plan, the tunnel and Access (`iac-apply`) and the tunnel connector (on a server the
 * user owns its host plan, on one OpsCrew created in the add-on's); the add-on's host plan with its
 * memory and price share, approved by its hash; the secrets on stdin.
 */
async function runAddonChange(
  deps: PhaseDeps,
  change: Omit<AddonChange, "intro"> & { after: DeployPlan },
  options: AddonRunOptions,
): Promise<AddonResult> {
  const { kind, enabling, command, before, after } = change;
  const services = options.services ?? {};
  const name = ADDON_NAMES[kind];
  const intro: string[] = [];
  const addon: AddonChange = { ...change, intro };
  const hostname = (plan: DeployPlan) => (kind === "beszel" ? beszelHostname(plan) : undefined);
  const subdomain = hostname(before) !== undefined || hostname(after) !== undefined;
  const hashes: string[] = [];
  const shownHash = (shown?: (hash: string) => void) => (hash: string) => {
    hashes.push(hash);
    shown?.(hash);
  };
  const result = await runTunnelledChange(deps, {
    ...options,
    command,
    phase: ADDON_PHASE,
    what: name,
    enabling,
    before,
    after,
    hostname,
    tunnelOnlyForSubdomain: true,
    infrastructureTitle:
      enabling && hostname(after) !== undefined
        ? `Serve Beszel's dashboard on ${hostname(after)} behind Cloudflare Access (Cloudflare Tunnel and Access)`
        : `Apply the Cloudflare Tunnel and Access changes for ${name}`,
    preflight: async ({ ownRun, remote }) => {
      // One of each per server: another app's add-on is refused here, before anything changes.
      if (ownRun) addonPlan(addon, after, ownRun);
      if (!enabling) return;
      const shell = remote ?? (await deployUserShell(deps, after, services));
      const reading = await readServer(deps, shell, after.app.name, kind === "grafana-cloud");
      intro.push(
        memoryLine(after, kind, {
          memoryMb: reading.memoryMb,
          ...(ownRun ? {} : { monthly: after.cost.monthly }),
        }),
      );
      if (kind === "grafana-cloud") intro.push(...grafanaCheck(after, reading));
    },
    hostChange: ({ ownRun, remote, plan, outputs, deployPublicKey, planOnly, shown }) =>
      ownRun && subdomain
        ? applyOwnHostPlan(deps, ownRun, {
            plan,
            outputs,
            deployPublicKey,
            planOnly,
            phase: ADDON_PHASE,
            command,
            upToDate:
              "The Cloudflare Tunnel connector on your server is already as planned; nothing else on it changes.",
            shown: shownHash(shown),
          })
        : addonHostChange(deps, addon, {
            ...(ownRun !== undefined ? { ownRun } : {}),
            ...(remote !== undefined ? { remote } : {}),
            plan,
            outputs,
            planOnly,
            shown: shownHash(shown),
          }),
    // On a server the user owns, the connector came with its host plan; the add-on's own follows.
    afterHost: async ({ ownRun, plan, planOnly, shown }) =>
      ownRun && subdomain
        ? addonHostChange(deps, addon, {
            ownRun,
            plan,
            outputs: {},
            planOnly,
            shown: shownHash(shown),
          })
        : undefined,
    // `--approve` binds to the host plan's hash: the same options make the same plan again.
    planned: async () => undefined,
  });
  const { plan, afterHostPlanHash: _after, hostPlanHash: _host, ...fields } = result;
  const done = { ...fields, hostPlanHashes: [...new Set(hashes)], approveCommand: command };
  if (plan === undefined) return { ...done, status: await addonStatusOf(deps, before) };
  if (enabling) await change.input?.keep?.();
  else if (kind === "grafana-cloud" || agentOnly(change) || !change.keepData) {
    await removeAddonSecrets(deps.paths, kind);
  }
  const status = await addonStatusOf(deps, plan);
  const state = status.addons.find((item) => item.kind === kind);
  if (enabling) {
    deps.reporter.success(`${name} is on.`);
    if (state !== undefined) deps.reporter.info(describeAddonStatus(state));
    if (kind === "grafana-cloud") deps.reporter.info(GRAFANA_MASKING_NOTE);
  } else {
    deps.reporter.success(
      kind === "grafana-cloud"
        ? "Grafana Cloud is off: Grafana Alloy, its buffer and its token are removed from the server, and the token from this computer. The data already in Grafana Cloud stays in your account."
        : agentOnly(change)
          ? "Beszel's agent is off: it and its token are removed from the server and from this computer. Remove the system from your hub too."
          : change.history === true
            ? "Beszel's kept history and its dashboard's password are deleted."
            : change.keepData
              ? "Beszel is off; its history stays on the server (`opscrew addon disable beszel` without `--keep-data` deletes it)."
              : "Beszel is off, and its history and secrets are deleted.",
    );
  }
  deps.reporter.info(
    `Commit ${[...result.files, "opscrew/plan.yaml"].join(", ")} so the repository describes the deployment (the next \`opscrew provision\` also publishes them in its pull request).`,
  );
  return { ...done, status };
}

/** Said after Grafana Cloud is turned on: the app's own values are masked from the next deploy. */
const GRAFANA_MASKING_NOTE =
  "The app's own secret values are masked from the next deploy, which writes the masking file once the change is on your deploy branch; until then only values shaped like secrets are.";

/**
 * Grafana Cloud's estimate against the free tier, said in the host plan's text (shown before its
 * approval): past the free tier, a warning and the `--log-sampling` that would fit. It never
 * stops: a paid Grafana plan holds more.
 */
function grafanaCheck(plan: DeployPlan, reading: ServerReading): string[] {
  const sampling = plan.observability?.grafanaCloud?.logSampling ?? 100;
  const estimate = grafanaEstimate(reading, sampling);
  const text = estimateText(estimate, sampling);
  if (!estimate.over) return [text];
  const fit =
    estimate.fittingSampling !== undefined
      ? ` Sending ${estimate.fittingSampling}% of the log lines would fit it: run the command again with \`--log-sampling ${estimate.fittingSampling}\` before approving.`
      : "";
  return [
    text,
    `This is more than Grafana Cloud's free tier holds: on the free plan, Grafana drops what goes past it.${fit}`,
  ];
}

/**
 * `opscrew addon enable <beszel|grafana-cloud>`: turns the add-on on for the app's server (a cloud
 * server or the user's own), pinned, under the server's hardening, reading Docker only through
 * OpsCrew's read-only proxy. The plan's block (`plan.observability`) is written once the host
 * plan, shown with each container's memory limit and its share of the monthly price and approved
 * by its hash (`host-apply`), is applied; the secrets go to the server on stdin only and are kept
 * in the project's private files (in the recovery copy). Beszel's hub mode generates its password,
 * token and key; its agent mode takes the hub's address and key, and the token from
 * `OPSCREW_BESZEL_TOKEN` (or asked). Grafana Cloud takes the stack's addresses and the token from
 * `OPSCREW_GRAFANA_CLOUD_TOKEN` (or asked), and shows OpsCrew's estimate against the free tier
 * with the host plan, and past it the `--log-sampling` that would fit (never a refusal). A subdomain for Beszel's dashboard goes through Portainer's tunnel and Access path.
 */
export async function addonEnable(
  deps: PhaseDeps,
  plan: DeployPlan,
  kind: AddonKind,
  options: AddonEnableOptions = {},
): Promise<AddonResult> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const command = `opscrew addon enable ${kind}${flag}`;
  requireDeployedServer(plan, kind, command, true);
  if (kind === "grafana-cloud") {
    const beszelOnly = ["mode", "access", "hostname", "allowEmails", "hubUrl", "hubKey"] as const;
    if (beszelOnly.some((key) => options[key] !== undefined)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "`--mode`, `--access`, `--hostname`, `--allow-email`, `--hub-url` and `--hub-key` are Beszel's options.",
        { hint: "Leave them out for Grafana Cloud." },
      );
    }
  }
  const input =
    kind === "beszel"
      ? await beszelInput(deps, plan, options)
      : await grafanaInput(deps, plan, options);
  return runAddonChange(
    deps,
    {
      kind,
      enabling: true,
      command: enableCommand(kind, options, input, flag),
      before: plan,
      after: input.after,
      input,
      keepData: false,
      services: options.services ?? {},
    },
    options,
  );
}

/**
 * `opscrew addon disable <beszel|grafana-cloud> [--keep-data]`: the teardown host plan
 * (`host-apply`) removes everything the add-on added on the server, its secrets and data included,
 * then its local secrets. Deleting Beszel's history is a destroying plan: its approval needs the
 * app's name typed (`allowDestroy`); `--keep-data` keeps the history (and the dashboard's password
 * on this computer, which its user still has) and needs no typed name. Beszel's agent mode keeps no
 * history, and Alloy's buffer goes, both without one. Beszel's subdomain goes too: the tunnel
 * connector, then the tunnel and Access as Portainer's.
 */
export async function addonDisable(
  deps: PhaseDeps,
  plan: DeployPlan,
  kind: AddonKind,
  options: AddonDisableOptions = {},
): Promise<AddonResult> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const command = `opscrew addon disable ${kind}${flag}${options.keepData === true ? " --keep-data" : ""}`;
  requireDeployedServer(plan, kind, command, false);
  if (options.keepData === true && kind !== "beszel") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "`--keep-data` is for Beszel's history; Grafana Cloud keeps its data in your Grafana Cloud account, and Alloy's buffer on the server is removed.",
      { hint: "Leave out `--keep-data`." },
    );
  }
  const keepData = options.keepData === true;
  const enabled = addonEnabled(plan, kind);
  // Off, but its history kept: without --keep-data the history goes now.
  const history =
    !enabled && kind === "beszel" && !keepData && (await keptHistory(deps, plan, options));
  if (!enabled && !history) {
    // An agent token left on this computer is only a copy of the user's hub's: it goes.
    if (kind === "beszel" && (await readBeszelSecrets(deps))?.mode === "agent") {
      await removeAddonSecrets(deps.paths, kind);
      deps.reporter.info(
        `Removed Beszel's agent token left on this computer (${deps.paths.files.beszelSecrets}); your hub still has it.`,
      );
    }
    deps.reporter.info(`${ADDON_NAMES[kind]} is already off for this app; nothing to do.`);
    return {
      applied: false,
      hostPlanHashes: [],
      hostApplied: false,
      files: [],
      status: await addonStatusOf(deps, plan),
      approveCommand: command,
    };
  }
  return runAddonChange(
    deps,
    {
      kind,
      enabling: false,
      command,
      before: plan,
      after: enabled ? withAddon(plan, kind, undefined) : plan,
      keepData,
      history,
      services: options.services ?? {},
    },
    options,
  );
}

/**
 * Beszel is off, but the history of its hub mode is kept on the server: its secrets on this
 * computer are hub mode's, or (on a server the user owns) the host record names this app as
 * Beszel's (read-only).
 */
async function keptHistory(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AddonDisableOptions,
): Promise<boolean> {
  if ((await readBeszelSecrets(deps))?.mode === "hub") return true;
  if (plan.target.provider !== "own") return false;
  const { facts } = await connectAndInspectOwnServer(deps, {
    hostKey: options.hostKey,
    services: options.services?.own,
    phase: ADDON_PHASE,
    detail: "Beszel's kept history",
  });
  return facts.record?.addons?.beszel === plan.app.name;
}
