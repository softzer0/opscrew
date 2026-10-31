/**
 * `opscrew vpn grant` and `opscrew vpn revoke` (feature 018, US5, FR-1817, FR-1818): a device's own
 * login to one of the app's databases or caches, reached on the service's private address through
 * the app's private network, never the app's own login (research R6a).
 */
import { posix } from "node:path";
import { type GrantParams, GrantParamsSchema, planGrant } from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError } from "@opscrew/core";
import { publishedOnNetwork, serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  GRANTABLE_KINDS,
  type Network,
  type PlanService,
  REDIS_PROTOCOL_KINDS,
  readArtifact,
  serverOfService,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { hasPublicAddress } from "../network";
import { applyNetworkPlans, type NetworkServer } from "../provision/network";
import {
  approveAndApplyHostPlan,
  type HostPlanOutcome,
  randomPassword,
  readValidJson,
  writePlanIfChanged,
} from "../shared";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { withApprovals } from "./devices";
import { networkServer, requireServers, VPN_PHASE, type VpnServices } from "./servers";

type Access = Network["grants"][number]["access"];

/** `opscrew vpn grant <device> <service>`'s flags. */
export interface VpnGrantOptions {
  /** `--full`: read and write access to all of the app's data; read-only otherwise. */
  full?: boolean;
  /** `--yes-full-access`: full access confirmed without a question (a script needs it). */
  yesFullAccess?: boolean;
  /** Asks the user `question` after full access's warning (the CLI's prompt); true goes on. */
  confirmFull?: (question: string) => Promise<boolean>;
  services?: VpnServices;
}

/** How the device signs in with its login. It holds the password: print it once, never log it. */
export interface VpnConnection {
  /** The client's command line, which asks for the password: `psql`, `mysql`, `mongosh` or `redis-cli`. */
  client: string;
  password: string;
  /** The URL with the password, for a graphical client such as DBeaver. */
  url: string;
}

/** What `opscrew vpn grant` did. */
export interface VpnGrantResult {
  device: string;
  service: string;
  access: Access;
  /** The service's private address on the app's network. */
  address: string;
  port: number;
  connection: VpnConnection;
  /** The hashes of the host plans shown, on the service's server. */
  hostPlanHashes: string[];
  /** True when this run changed the server. */
  applied: boolean;
}

/** `opscrew vpn revoke <device> <service>`'s options. */
export interface VpnRevokeOptions {
  services?: VpnServices;
}

/** What `opscrew vpn revoke` did. */
export interface VpnRevokeResult {
  device: string;
  service: string;
  hostPlanHashes: string[];
  applied: boolean;
}

const GRANTABLE: ReadonlySet<string> = new Set(GRANTABLE_KINDS);
const DECLARED: ReadonlySet<string> = new Set(REDIS_PROTOCOL_KINDS);

/** True for Valkey, Redis and Dragonfly, whose device logins the service's environment declares. */
function declared(service: PlanService): boolean {
  return DECLARED.has(service.kind);
}

/** The grant's entry in the generated values' `grants`. */
function passwordKey(device: string, service: string): string {
  return `${device}/${service}`;
}

/** The private address of the server `server` on the app's network. */
function memberAddress(plan: DeployPlan, server: string): string {
  return plan.network?.members.find((m) => m.name === server)?.address ?? "";
}

/** The network, when `device` is on it. */
function requireDevice(plan: DeployPlan, device: string, flag: string): Network {
  const network = plan.network;
  if (network?.devices.some((d) => d.name === device) === true) return network;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `Device ${device} is not on the app's private network. Nothing was changed.`,
    { hint: `Add it first with \`opscrew vpn add ${device}${flag}\`, then grant it access.` },
  );
}

/** The enabled service `name`, when a device can have a login of its own to it (FR-1818). */
function grantableService(plan: DeployPlan, name: string): PlanService {
  const grantable = plan.services.filter((s) => s.enabled && GRANTABLE.has(s.kind));
  const hint =
    grantable.length > 0
      ? `Grant ${listText(grantable.map((s) => s.name))} instead.`
      : "The app has no database or cache a device can be given a login to.";
  const service = plan.services.find((s) => s.enabled && s.name === name);
  if (service === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app runs no service named ${name}. Nothing was changed.`,
      { hint },
    );
  }
  if (!GRANTABLE.has(service.kind)) {
    const spec = serviceSpec(service.kind);
    const why =
      spec.auth === "internal-only"
        ? "it has no login: only the app's servers reach it, through the private network"
        : `a device can have a login of its own only to ${listText(GRANTABLE_KINDS.map((k) => serviceSpec(k).title))}`;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${name} is a ${spec.title} service, and ${why}. Nothing was changed.`,
      { hint },
    );
  }
  return service;
}

/**
 * Stops when the device's name is a login a database or the app already uses (the `grant` step's
 * reserved logins). The plan already refuses `default`, Valkey's, Redis's and Dragonfly's own.
 */
function requireOwnLogin(service: PlanService, device: string): void {
  if (declared(service) || GrantParamsSchema.shape.login.safeParse(device).success) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `Device ${device} can't have a login of its own to ${service.name}: "${device}" is a login ${serviceSpec(service.kind).title} or the app already uses. Nothing was changed.`,
    {
      hint: "Add the device again under another name (`opscrew vpn add <name>`), grant that one, and remove this one.",
    },
  );
}

/** Stops when no device reaches the service's server: the app's server behind a Cloudflare Tunnel. */
function requireReachable(plan: DeployPlan, server: string, service: string): void {
  if (hasPublicAddress(plan, server)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${service} runs on the app's server, which has no public address (it is reached through a Cloudflare Tunnel), so no device reaches it. Nothing was changed.`,
    {
      hint: "Devices reach services on servers the internet reaches: place it on a server of its own (`services[].server` in opscrew/plan.yaml), run `opscrew design` and `opscrew provision`, then grant it.",
    },
  );
}

/** Full access's warning, then the user's confirmation: the question, or `--yes-full-access`. */
async function confirmFullAccess(
  deps: Pick<PhaseDeps, "reporter" | "interactive">,
  options: VpnGrantOptions,
  device: string,
  service: PlanService,
  command: string,
): Promise<void> {
  deps.reporter.warn(
    `Full access lets device ${device} change and delete the app's production data in ${service.name} (all of the app's data, never control of the ${serviceSpec(service.kind).title} server), and so can anyone who holds the device. Read-only access is enough to look at the data.`,
  );
  if (options.yesFullAccess === true) return;
  const readOnly = command.replace(" --full", "");
  if (!deps.interactive) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Full access to ${service.name} needs your confirmation. Nothing was changed.`,
      {
        hint: `To give it, run \`${command} --yes-full-access\`; for read-only access, run \`${readOnly}\`.`,
      },
    );
  }
  const question = `Give device ${device} full access to ${service.name}?`;
  if ((await options.confirmFull?.(question)) !== true) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Full access to ${service.name} was not confirmed. Nothing was changed.`,
      { hint: `For read-only access, run \`${readOnly}\`.` },
    );
  }
}

/**
 * The `grant` host plan on the service's server (`planGrant`), shown, approved by its hash and
 * applied: the login made, updated or (with `remove`) removed. The password goes to the server
 * only on apply, as `grantPassword`.
 */
function applyGrantPlan(
  deps: PhaseDeps,
  server: NetworkServer,
  plan: DeployPlan,
  grant: GrantParams,
  command: string,
  password?: string,
): Promise<HostPlanOutcome> {
  const hostPlan = planGrant(server.facts, { app: plan.app.name, grant }, command);
  const { rootImage } = server;
  const login = `device ${grant.login}'s login`;
  return approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote: server.remote,
    apply:
      rootImage === undefined
        ? server.apply
        : (remote, applied, options) => server.apply(remote, applied, { ...options, rootImage }),
    verifyLogin: server.verifyLogin,
    title: grant.remove
      ? `Remove ${login} from ${grant.service} on server ${server.name}`
      : `Give ${login} ${grant.access} access to ${grant.service} on server ${server.name}`,
    server: `server ${server.name}`,
    planOf: `server ${server.name}`,
    upToDate: `${login} on ${grant.service} is as planned; nothing on server ${server.name} changes.`,
    command,
    phase: VPN_PHASE,
    secrets: async () => (password === undefined ? {} : { grantPassword: password }),
    applying: grant.remove
      ? `Removing ${login} from ${grant.service}`
      : `Setting up ${login} on ${grant.service}`,
  });
}

/**
 * The client line (which asks for the password) and the URL with it, for `login` on `service` at
 * `host:port`; MongoDB's logins live in `admin` (`authSource=admin`).
 */
function connection(
  service: PlanService,
  login: string,
  password: string,
  host: string,
  port: number,
): VpnConnection {
  switch (service.kind) {
    case "postgres": {
      const url = (user: string) => `postgresql://${user}@${host}:${port}/app`;
      return { client: `psql "${url(login)}"`, password, url: url(`${login}:${password}`) };
    }
    case "mysql":
    case "mariadb":
      return {
        client: `mysql -h ${host} -P ${port} -u ${login} -p app`,
        password,
        url: `mysql://${login}:${password}@${host}:${port}/app`,
      };
    case "mongodb": {
      const url = (user: string) =>
        `mongodb://${user}@${host}:${port}/app?authSource=admin&directConnection=true`;
      return { client: `mongosh "${url(login)}"`, password, url: url(`${login}:${password}`) };
    }
    default:
      return {
        client: `redis-cli -h ${host} -p ${port} --user ${login} --askpass`,
        password,
        url: `redis://${login}:${password}@${host}:${port}`,
      };
  }
}

/** True when the service is published on its server's private address in `plan`. */
function published(plan: DeployPlan, server: string, service: string): boolean {
  return publishedOnNetwork(plan, server).some((entry) => entry.service === service);
}

/**
 * What the next `opscrew provision` and its deploy must still do after a device's login to
 * `service` was given (`granting`) or removed, said as a step to run (nothing when the host plans
 * did it all): store a Valkey, Redis or Dragonfly service's environment, and, with `publishing`,
 * publish the service on its server's private address or take it off.
 */
function deployStep(
  plan: DeployPlan,
  service: PlanService,
  granting: boolean,
  publishing: boolean,
  flag: string,
): string | undefined {
  const parts: string[] = [];
  if (declared(service)) {
    parts.push(
      granting
        ? `stores ${service.name}'s settings in GitHub with the device's login (only its password's SHA-256)`
        : `stores ${service.name}'s settings in GitHub without the device's login`,
    );
  }
  if (publishing) {
    parts.push(
      `opens the pull request whose deploy ${granting ? "publishes" : "stops publishing"} ${service.name} on its server's private address`,
    );
  }
  if (parts.length === 0) return undefined;
  const when = publishing
    ? "once that deploy has run"
    : `from the next deploy (run ${posix.basename(plan.cicd.workflowPath)} in GitHub Actions to deploy now)`;
  return `Run \`opscrew provision${flag}\`: it ${listText(parts)}. The change takes effect ${when}.`;
}

/**
 * `opscrew vpn grant <device> <service> [--full]`: gives the device its own login to one of the
 * app's databases or caches (FR-1817), read-only or, with `full`, all of the app's data (never
 * control of the server) after a warning and the user's confirmation (`confirmFull`, or
 * `yesFullAccess` in a script).
 * - The login's password is generated once (16 to 128 letters and digits) and kept only in the
 *   generated values' `grants` (`<device>/<service>`); the grant goes into `network.grants` before
 *   any host plan, so a run whose plans were refused is finished with `--approve` and the hashes.
 * - On the service's server: for Postgres, MySQL, MariaDB and MongoDB the `grant` host plan makes
 *   the login, then the private network's host plan admits the device to the service's port
 *   (`applyNetworkPlans`), each shown and approved by its own hash.
 * - Valkey, Redis and Dragonfly declare the login in the service's environment
 *   (`OPSCREW_ACL_USERS`, which provision stores), and a service not yet published on its server's
 *   private address is published by the deploy of provision's pull request: the reporter says so.
 * - Returns the connection details for the private address and the device's own login, which the
 *   caller prints once.
 * @throws OpsCrewError before any change: a service of another kind (FR-1818), an unknown service
 * or device, a device named like a login the engine uses, a service no device reaches, or full
 * access not confirmed.
 */
export async function vpnGrant(
  deps: PhaseDeps,
  device: string,
  serviceName: string,
  options: VpnGrantOptions = {},
): Promise<VpnGrantResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireServers(before);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const access: Access = options.full === true ? "full" : "read-only";
  // Running it again with `--approve` must plan the same.
  const command = `opscrew vpn grant ${device} ${serviceName}${flag}${access === "full" ? " --full" : ""}`;
  const network = requireDevice(before, device, flag);
  const service = grantableService(before, serviceName);
  requireOwnLogin(service, device);
  const server = serverOfService(before, service.name);
  requireReachable(before, server, service.name);
  const existing = network.grants.find((g) => g.device === device && g.service === service.name);
  // A grant already made with full access was confirmed then.
  if (access === "full" && existing?.access !== "full") {
    await confirmFullAccess(deps, options, device, service, command);
  }

  const key = passwordKey(device, service.name);
  const kept = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.grants?.[
    key
  ];
  const password = kept ?? randomPassword(32);
  deps.redactor.addLiteral(password, "grant-password");
  if (kept === undefined) await recordGeneratedEntries(deps, "grants", { [key]: password });
  const grant = { device, service: service.name, access };
  const grants =
    existing === undefined
      ? [...network.grants, grant]
      : network.grants.map((g) => (g === existing ? grant : g));
  let plan: DeployPlan = { ...before, network: { ...network, grants } };
  await writePlanIfChanged(deps, plan);

  const target = await networkServer(deps, plan, server, options.services ?? {});
  const outcomes: HostPlanOutcome[] = [];
  if (!declared(service)) {
    const params = { service: service.name, kind: service.kind, login: device, access };
    const login = GrantParamsSchema.parse({ ...params, remove: false });
    outcomes.push(await applyGrantPlan(deps, target, plan, login, command, password));
  }
  const admitted = await applyNetworkPlans(deps, {
    plan,
    servers: [target],
    command,
    phase: VPN_PHASE,
  });
  outcomes.push(...admitted.values());
  plan = withApprovals(plan, outcomes);
  await writePlanIfChanged(deps, plan);

  const address = memberAddress(plan, server);
  const { port, title } = serviceSpec(service.kind);
  deps.reporter.success(
    `Device ${device} has its own ${access} login to ${service.name} (${title}) at ${address}:${port}, through the app's private network. The app's own login stays the app's.`,
  );
  // Published before this device's grant, so a re-run after a refused plan still says so.
  const others = network.grants.filter((g) => g !== existing);
  const without: DeployPlan = { ...before, network: { ...network, grants: others } };
  const next = deployStep(plan, service, true, !published(without, server, service.name), flag);
  if (next !== undefined) deps.reporter.info(next);
  deps.reporter.info(
    `The connection details are shown only now. The password stays on this computer, with OpsCrew's generated values (${generatedValuesFile(deps)}).`,
  );
  return {
    device,
    service: service.name,
    access,
    address,
    port,
    connection: connection(service, device, password, address, port),
    hostPlanHashes: outcomes.map((o) => o.hash),
    applied: outcomes.some((o) => o.applied),
  };
}

/**
 * `opscrew vpn revoke <device> <service>`: the reverse of {@link vpnGrant}. On the service's
 * server, the private network's host plan first stops admitting the device to the service's port,
 * then for Postgres, MySQL, MariaDB and MongoDB the `grant` host plan removes its login, each
 * approved by its own hash. Then the grant leaves `network.grants`, and its password the generated
 * values. A Valkey, Redis or Dragonfly login goes with the service's environment at the next
 * deploy, and the deploy of provision's pull request takes a service no device needs any more off
 * the app server's private address: the reporter says so.
 * @throws OpsCrewError before any change when the device has no login to that service.
 */
export async function vpnRevoke(
  deps: PhaseDeps,
  device: string,
  serviceName: string,
  options: VpnRevokeOptions = {},
): Promise<VpnRevokeResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireServers(before);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const command = `opscrew vpn revoke ${device} ${serviceName}${flag}`;
  const network = before.network;
  const grant = network?.grants.find((g) => g.device === device && g.service === serviceName);
  if (network === undefined || grant === undefined) {
    const others = network?.grants.filter((g) => g.device === device).map((g) => g.service) ?? [];
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Device ${device} has no login to ${serviceName}. Nothing was changed.`,
      {
        hint:
          others.length > 0
            ? `It has logins to ${listText(others)}.`
            : `It has no logins; \`opscrew status${flag}\` lists the app's grants.`,
      },
    );
  }
  // The plan's rules guarantee the grant names an enabled service of a grantable kind.
  const service = before.services.find((s) => s.name === grant.service) as PlanService;
  const server = serverOfService(before, service.name);
  let plan: DeployPlan = {
    ...before,
    network: { ...network, grants: network.grants.filter((g) => g !== grant) },
  };

  const target = await networkServer(deps, plan, server, options.services ?? {});
  const outcomes: HostPlanOutcome[] = [
    ...(
      await applyNetworkPlans(deps, { plan, servers: [target], command, phase: VPN_PHASE })
    ).values(),
  ];
  if (!declared(service)) {
    const params = { service: service.name, kind: service.kind, login: device };
    const login = GrantParamsSchema.parse({ ...params, access: grant.access, remove: true });
    outcomes.push(await applyGrantPlan(deps, target, plan, login, command));
  }
  plan = withApprovals(plan, outcomes);
  await writePlanIfChanged(deps, plan);
  await recordGeneratedEntries(deps, "grants", { [passwordKey(device, service.name)]: undefined });

  deps.reporter.success(
    `Device ${device}'s ${declared(service) ? "grant" : "login"} to ${service.name} is removed, and server ${server}'s filter no longer lists the device for ${service.name}.`,
  );
  const unpublished =
    published(before, server, service.name) && !published(plan, server, service.name);
  const next = deployStep(plan, service, false, unpublished, flag);
  if (next !== undefined) deps.reporter.info(next);
  return {
    device,
    service: service.name,
    hostPlanHashes: outcomes.map((o) => o.hash),
    applied: outcomes.some((o) => o.applied),
  };
}
