/**
 * Previews on another environment's server (spec.md US9, FR-2228–FR-2230, research R7.3 (1)):
 * the one helper every reach of the preview server goes through ({@link previewServer}), the
 * warning the user opts in after, what such a server must be, and what its environment refuses
 * while previews run there. Nothing of the host's address or logins is copied into the preview
 * environment's state: each reader takes them from the host environment.
 */
import type { HostFacts } from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError, type ProjectPaths, readTextIfExists } from "@opscrew/core";
import { edgeProxy } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  isServerlessProvider,
  monitoringOf,
  monitoringServerName,
  previewEnvironmentOf,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { appFlag } from "../apps/choice";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { environmentPaths } from "../environments/paths";
import { serverNetworkInputs } from "../network/inputs";
import { deployLogin } from "../provision/origin-tls";
import { appMemoryMb, type MemoryLimit } from "../shared/memory";
import { hasDeployment, sameIp, serverAddress } from "../shared/server-address";
import { readServerAddresses, type ServerAddress } from "../shared/server-record";
import { keysFor, knownHostsName } from "../shared/wait";

/**
 * The warning said at `env add` and again in the previews host plan's approval when previews run
 * on `host`'s server (research R7.3 (1)).
 */
export function sharedServerWarning(host: string): string {
  return `Anyone who can push a branch to this repository then runs code on ${host}'s server, beside its data and secrets. If that code escaped its container, it could reach them. Without escaping, it reaches whatever ${host}'s server serves to the internet (its web ports), as any visitor can. Use it only when ${host} holds test data and test keys.`;
}

/** The server previews run on, as every reach of it sees it ({@link previewServer}). */
export interface PreviewServer<D extends Pick<PhaseDeps, "paths"> = PhaseDeps> {
  /** `deps` with the paths of the environment whose server it is: the host's with a shared one. */
  deps: D;
  /** That environment's plan. */
  plan: DeployPlan;
  /** The host environment's name, when previews run on its server (`previews.server`). */
  host?: string;
}

/** A refusal that ends as every one before a change does. */
function refusal(message: string, hint: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", `${message} Nothing was changed.`, { hint });
}

/**
 * The server the preview environment `plan` runs its previews on, and how to reach it: its own
 * (`deps` and `plan` as they are), or with `previews.server` the host environment's paths (its
 * address, logins, deploy key and pinned host key on this computer) and plan. Every reach of the
 * preview server takes it from here: the previews host plan (the host's deploy login on a server
 * OpsCrew created, its recorded admin login as root on the user's own), the preview commands,
 * `verify`, `drift`, `status`, the GitHub secrets and the preview root's addresses.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the host environment has no plan or is not
 * provisioned.
 */
export async function previewServer<D extends Pick<PhaseDeps, "paths">>(
  deps: D,
  plan: DeployPlan,
): Promise<PreviewServer<D>> {
  const host = plan.environment?.previews?.server?.environment;
  if (host === undefined) return { deps, plan };
  const paths = environmentPaths(deps.paths, host);
  const hostPlan = await readOptionalArtifact("plan", paths.files.plan);
  if (hostPlan === undefined || !hasDeployment(hostPlan)) {
    const flags = await commandFlags(paths.root, host, paths.app);
    throw refusal(
      `The previews run on ${host}'s server, and ${host} ${hostPlan === undefined ? "has no plan" : "is not provisioned"} on this computer.`,
      `Run \`opscrew provision${flags}\` on the computer that set ${host} up, or run the command there.`,
    );
  }
  return { deps: { ...deps, paths }, plan: hostPlan, host };
}

/**
 * The public address of the server previews run on: on a shared one, the host environment's as
 * this computer recorded it (its root's outputs on a server OpsCrew created, its `server.json` on
 * the user's own), for the preview root's `TF_VAR_server_ipv4` and `TF_VAR_server_ipv6`. Never
 * written into the preview environment's state.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer does not know it.
 */
export async function previewServerAddress(server: PreviewServer): Promise<ServerAddress> {
  const address = await serverAddress(server.deps, server.plan);
  if (address !== undefined) return address;
  const flags = await commandFlags(
    server.deps.paths.root,
    server.deps.paths.environment,
    server.deps.paths.app,
  );
  throw refusal(
    `OpsCrew does not know the address of ${server.host ?? "the preview"}'s server on this computer.`,
    `Run the command on the computer that ran \`opscrew provision${flags}\`.`,
  );
}

/**
 * What GitHub's machines reach a shared server with: the host's public IPv4 address (the secret
 * `HOST`), its host key pinned on this computer under that address and the port (`KNOWN_HOSTS`),
 * and the port the host's deploy login uses, which the preview workflow connects to.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no deploy login there or no
 * pinned host key.
 */
export async function sharedServerReach(
  server: PreviewServer,
): Promise<{ host: string; knownHosts: string; sshPort: number }> {
  const { paths } = server.deps;
  const flags = await commandFlags(paths.root, paths.environment, paths.app);
  const again = `Run the command on the computer that ran \`opscrew provision${flags}\`.`;
  const login = await deployLogin(server.deps, server.plan);
  if (login === undefined) {
    throw refusal(
      `OpsCrew has no deploy login to ${server.host}'s server on this computer (its address or ${server.host}'s deploy key is missing).`,
      again,
    );
  }
  const pinned = keysFor(
    (await readTextIfExists(paths.files.knownHosts)) ?? "",
    knownHostsName(login.host, login.port),
  );
  if (pinned.length === 0) {
    throw refusal(
      `The SSH host key of ${server.host}'s server is not pinned on this computer.`,
      again,
    );
  }
  const address = await previewServerAddress(server);
  const name = knownHostsName(address.ipv4, login.port);
  return {
    host: address.ipv4,
    knownHosts: pinned.map((key) => `${name} ${key}\n`).join(""),
    sshPort: login.port,
  };
}

/** The previews' memory on their server: `cap` previews, each with the plan's memory limits. */
export function previewsMemoryMb(plan: DeployPlan): number {
  return (plan.environment?.previews?.cap ?? 0) * appMemoryMb(plan);
}

/**
 * The previews another environment runs on the server of the environment `paths` belong to, as a
 * memory limit design and `advise` count beside its own (FR-2230); `undefined` while no preview
 * environment names it.
 */
export async function sharedPreviewsLimit(paths: ProjectPaths): Promise<MemoryLimit | undefined> {
  if (paths.environment === "prod") return undefined;
  const shared = await sharedPreviewsOn(paths, paths.environment);
  return shared === undefined
    ? undefined
    : { name: `the previews of ${shared.name}`, memoryMb: previewsMemoryMb(shared.plan) };
}

/** The app's preview environment that names `environment`'s server, with its plan. */
export interface SharedPreviews {
  name: string;
  plan: DeployPlan;
}

/**
 * The app's preview environment whose previews run on `environment`'s server
 * (`previews.server.environment`), with its plan; `undefined` when there is none.
 */
export async function sharedPreviewsOn(
  paths: ProjectPaths,
  environment: string,
): Promise<SharedPreviews | undefined> {
  const name = await previewEnvironmentOf(paths.root, paths.app);
  if (name === undefined || name === environment) return undefined;
  const plan = await readOptionalArtifact("plan", environmentPaths(paths, name).files.plan);
  return plan?.environment?.previews?.server?.environment === environment
    ? { name, plan }
    : undefined;
}

/**
 * Refuses `what` (a phrase such as "destroying dev") for the environment `paths` belong to while
 * the app's preview environment runs previews on its server (FR-2230), naming the command that
 * removes them; with `named`, also while the preview environment only names its server, not
 * provisioned yet (then naming the command that removes the preview environment).
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
export async function requireNoSharedPreviews(
  paths: ProjectPaths,
  what: string,
  again: string,
  named = false,
): Promise<void> {
  const env = paths.environment;
  const shared = await sharedPreviewsOn(paths, env);
  if (shared === undefined) return;
  if (hasDeployment(shared.plan)) {
    const flags = await commandFlags(paths.root, shared.name, paths.app);
    throw refusal(
      `The previews of the ${shared.name} environment run on ${env}'s server, and ${what} would break them.`,
      `Remove them first with \`opscrew destroy${flags}\` (it leaves ${env}'s server as it is), then run \`${again}\` again.`,
    );
  }
  if (!named) return;
  throw refusal(
    `The previews of the ${shared.name} environment are set up to run on ${env}'s server, and ${what} would break them.`,
    `Remove that environment first with \`opscrew env remove ${shared.name}${await appFlag(paths.root, paths.app)}\`, then run \`${again}\` again.`,
  );
}

/**
 * Refuses the user's own server for `plan` (the environment `paths` belong to) when its inspection
 * (`facts`) lists previews it may not run beside (constitution I): any but `plan`'s own and those of
 * the preview environment that names its server. Pull requests' code runs there.
 * @throws OpsCrewError `PHASE_PRECONDITION`, naming `opscrew destroy` of the app's preview
 * environment when the previews are its.
 */
export async function requireNoForeignPreviews(
  paths: ProjectPaths,
  plan: DeployPlan,
  facts: Pick<HostFacts, "previews">,
  again: string,
): Promise<void> {
  const shared = await sharedPreviewsOn(paths, paths.environment);
  const allowed = new Set([plan.app.name, ...(shared === undefined ? [] : [shared.plan.app.name])]);
  const foreign = facts.previews.map((recipe) => recipe.app).filter((app) => !allowed.has(app));
  if (foreign.length === 0) return;
  // The app's own preview environment, when the previews are its.
  const name = await previewEnvironmentOf(paths.root, paths.app);
  const preview =
    name === undefined
      ? undefined
      : await readOptionalArtifact("plan", environmentPaths(paths, name).files.plan);
  const remove =
    name !== undefined && preview !== undefined && foreign.includes(preview.app.name)
      ? `\`opscrew destroy${await commandFlags(paths.root, name, paths.app)}\``
      : "`opscrew destroy` of their preview environment";
  throw refusal(
    `Your server runs the previews of ${listText(foreign.map((app) => `"${app}"`))}, which run pull requests' code, and ${paths.environment} would run beside them.`,
    `Remove them first with ${remove}, or give ${paths.environment} another server, then run \`${again}\` again.`,
  );
}

/** What {@link shareableHost} needs to word its refusals. */
export interface HostCheck {
  /** The preview environment's name. */
  preview: string;
  /** The command a refusal says to run again. */
  again: string;
}

/**
 * The server of `host`, the environment whose server previews would share, as
 * {@link previewServer} reaches it, once its plan allows it (FR-2228): not prod, not the preview
 * environment itself or another one, not Portainer, this computer or a site; its server reached
 * over public SSH (no tunnel, public SSH not closed), with the Caddy edge; provisioned. What only
 * inspection shows is {@link requireHostApps}'s.
 * @throws OpsCrewError `INVALID_INPUT` or `PHASE_PRECONDITION`, each before any change.
 */
export async function shareableHost<D extends Pick<PhaseDeps, "paths">>(
  deps: D,
  host: string,
  check: HostCheck,
): Promise<PreviewServer<D>> {
  const { preview, again } = check;
  const paths = environmentPaths(deps.paths, host);
  const rerun = `then run \`${again}\` again`;
  const instead = `Name another environment's server, or leave the option out for a server of the previews' own, ${rerun}.`;
  if (host === "prod") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Previews never run on prod's server: anyone who can push a branch would run code beside prod's data. Nothing was changed.",
      { hint: instead },
    );
  }
  if (host === preview) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${host} is the preview environment itself; previews share another environment's server, such as dev's. Nothing was changed.`,
      { hint: instead },
    );
  }
  const plan = await readOptionalArtifact("plan", paths.files.plan);
  if (plan === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The app has no ${host} environment. Nothing was changed.`,
      { hint: `\`opscrew env list\` shows the app's environments. ${instead}` },
    );
  }
  const why = hostProblem(plan, host);
  if (why !== undefined) throw refusal(why, instead);
  if (!hasDeployment(plan)) {
    const flags = await commandFlags(paths.root, host, paths.app);
    throw refusal(
      `${host} is not provisioned yet, so it has no server for previews to share.`,
      `Run \`opscrew provision${flags}\` first, ${rerun}.`,
    );
  }
  // prod on the same server of the user's, by the addresses this computer recorded.
  const prodPaths = environmentPaths(deps.paths, "prod");
  const prod = await readOptionalArtifact("plan", prodPaths.files.plan);
  if (prod?.target.provider === "own") {
    const prodAddress = (await readServerAddresses(prodPaths)).deployment;
    const hostAddress = (await readServerAddresses(paths)).deployment;
    if (
      prodAddress !== undefined &&
      hostAddress !== undefined &&
      sameIp(prodAddress.ipv4, hostAddress.ipv4)
    ) {
      throw refusal(prodBeside(host), instead);
    }
  }
  return { deps: { ...deps, paths }, plan, host };
}

/** Why previews never share a server prod runs on. */
function prodBeside(host: string): string {
  return `prod runs on ${host}'s server too, and previews never run beside prod's data.`;
}

/** Why `host`'s plan has no server previews can share, or `undefined` when it has one. */
function hostProblem(plan: DeployPlan, host: string): string | undefined {
  const { provider } = plan.target;
  if (plan.environment?.previews !== undefined) {
    return `${host} is a preview environment, whose server runs pull requests' code already.`;
  }
  if (provider === "portainer") {
    return `${host} runs in your Portainer, which OpsCrew reaches only through its API, and GitHub's machines reach previews over SSH.`;
  }
  if (provider === "localhost") {
    return `${host} runs on this computer, which GitHub's machines can't reach.`;
  }
  if (isServerlessProvider(provider)) {
    return `${host} is a site without a server of its own.`;
  }
  if (provider === "own" && plan.target.access === "tunnel") {
    return `${host}'s server is served through a Cloudflare Tunnel and takes no public SSH, and GitHub's machines reach previews over SSH.`;
  }
  if (plan.network?.publicSsh === false) {
    return `${host}'s server takes no public SSH (it was closed with \`opscrew secure --close-public-ssh\`), and GitHub's machines reach previews over SSH.`;
  }
  if (edgeProxy(plan) !== "caddy") {
    return `${host}'s server runs nginx as its proxy, and previews are served by Caddy, which every app on a server shares.`;
  }
  return privateNetworkProblem(plan, host);
}

/**
 * Why previews can't share `host`'s server while its plan puts it on a private network (what
 * {@link privateNetworkReach} lists, with what a command is `adding`), or `undefined` when it
 * puts it on none.
 */
function privateNetworkProblem(
  plan: DeployPlan,
  host: string,
  adding: readonly string[] = [],
): string | undefined {
  const reach = [...new Set([...privateNetworkReach(plan), ...adding])];
  if (reach.length === 0) return undefined;
  return `${host}'s server is on a private network, and a preview's containers there could reach ${listText(reach)} without escaping anything: traffic within the server passes no firewall. Turn ${reach.length === 1 ? "it" : "them"} off on ${host} first, or give the previews a server of their own.`;
}

/**
 * Refuses a command of the environment `paths` belong to (provision, `vpn add`, `vpn grant`, an
 * add-on or Portainer on) when `plan`, as it would apply it, puts its server on a private network
 * (other servers, devices, granted services, dashboards), or the command is `adding` something
 * there (a phrase such as `device laptop`), while the app's preview environment names that server
 * (FR-2228), with the words of the previews' own refusal: a preview's containers would reach
 * them. Removals never come here.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change.
 */
export async function requireNoNetworkBesidePreviews(
  paths: ProjectPaths,
  plan: DeployPlan,
  again: string,
  adding: readonly string[] = [],
): Promise<void> {
  const shared = await sharedPreviewsOn(paths, paths.environment);
  if (shared === undefined) return;
  const why = privateNetworkProblem(plan, paths.environment, adding);
  if (why === undefined) return;
  const remove = hasDeployment(shared.plan)
    ? `\`opscrew destroy${await commandFlags(paths.root, shared.name, paths.app)}\``
    : `\`opscrew env remove ${shared.name}${await appFlag(paths.root, paths.app)}\``;
  throw refusal(
    why,
    `To put that on ${paths.environment}'s server anyway, remove the previews of ${shared.name} first with ${remove}; then run \`${again}\` again.`,
  );
}

/** How a dashboard published on the private network is named in a refusal. */
const DASHBOARDS: Record<string, string> = {
  beszel: "Beszel's hub",
  portainer: "Portainer's web UI",
};

/**
 * What the app's server of `plan` reaches or publishes on its private network, as its plan has it:
 * the network's other servers, the user's devices, the services and dashboards published there for
 * them, and Grafana when the monitoring stack runs on it. None without a network.
 */
function privateNetworkReach(plan: DeployPlan): string[] {
  const { network } = plan;
  if (network === undefined) return [];
  const devices = network.devices.length;
  const stack = monitoringOf(plan);
  return [
    ...new Set([
      ...network.members
        .filter((member) => member.name !== APP_SERVER)
        .map((member) => `server ${member.name}`),
      ...(devices > 0 ? [`your ${devices === 1 ? "device" : `${devices} devices`}`] : []),
      ...serverNetworkInputs(plan, APP_SERVER, true).published.map(
        (entry) => DASHBOARDS[entry.service] ?? entry.service,
      ),
      ...(stack !== undefined &&
      stack.where.kind !== "shared" &&
      monitoringServerName(plan) === APP_SERVER
        ? ["Grafana"]
        : []),
    ]),
  ];
}

/** The environments of the app whose servers previews could share ({@link shareableHost}'s plan checks, provisioned). */
export async function shareableHosts(
  paths: ProjectPaths,
  environments: readonly string[],
): Promise<string[]> {
  const hosts: string[] = [];
  for (const name of environments) {
    if (name === "prod" || name === paths.environment) continue;
    const plan = await readOptionalArtifact("plan", environmentPaths(paths, name).files.plan);
    if (plan !== undefined && hasDeployment(plan) && hostProblem(plan, name) === undefined) {
      hosts.push(name);
    }
  }
  return hosts;
}

/**
 * Refuses a shared server whose inspection shows another OpsCrew app than the host's and the
 * previews' own (`apps`, by name): prod's, which previews never run beside, or any other.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change.
 */
export function requireHostApps(
  apps: readonly string[],
  input: { host: string; hostApp: string; previewApp: string; prodApp: string; again: string },
): void {
  const own = new RegExp(`^${input.previewApp}(-pr-[1-9][0-9]{0,5})?$`);
  const others = [...new Set(apps)].filter((app) => app !== input.hostApp && !own.test(app)).sort();
  if (others.length === 0) return;
  const rerun = `Name another environment's server, or leave the option out for a server of the previews' own, then run \`${input.again}\` again.`;
  if (others.includes(input.prodApp)) {
    throw refusal(prodBeside(input.host), rerun);
  }
  throw refusal(
    `${input.host}'s server also runs ${listText(others.map((app) => `"${app}"`))}, and previews may share a server only with ${input.host} itself.`,
    rerun,
  );
}
