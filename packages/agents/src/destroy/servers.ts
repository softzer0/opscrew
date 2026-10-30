/**
 * `destroy` across an app's servers (feature 018, US2 #6, FR-1812): every server listed in the
 * confirmation, each extra cloud server deleted only after its own typed name (with Hetzner's
 * delete protection lifted), public SSH opened again before any private network is removed, and
 * on the user's own extra servers only what OpsCrew installed removed (the app's services, the
 * private network and its filter, then OpsCrew's setup), through host plans approved by hash.
 */
import { parseGitHubRepo } from "@opscrew/connector-github";
import {
  applyHostPlan,
  type HostFacts,
  inspectHost,
  otherActiveApps,
  planPublicSsh,
  planTeardown,
  planUndo,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, ResourceChange } from "@opscrew/contracts";
import { listText, plural } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  networkInterface,
  servicesOn,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers";
import { repositoryUrl } from "../runners";
import { approvalEntry, gitClient, type HostAdapterApi } from "../shared";
import { approveAndApplyHostPlan } from "../shared/host-plan";
import { serverLogin, serverRemote } from "../shared/server-address";
import { readServerAddresses, updateServerAddresses } from "../shared/server-record";
import { serverShell } from "../status/servers";
import { deletesServer, serverData, serverIdsInPlan } from "./checks";
import { COMMAND, SHOWS_PLAN_AGAIN } from "./common";
import {
  confirmDeletion,
  type DeletionScope,
  type DeletionSession,
  forgetHostKeys,
  type SnapshotBeforeDeleteInput,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "./deletion";
import { destroyTexts } from "./texts";
import type { DestroyOptions, DestroyPreview, DestroyServices } from "./types";

/** An extra server OpsCrew created: its module in the root and the name its provider shows. */
export interface ExtraCloudServer {
  /** Its name in the plan. */
  name: string;
  provider: CloudProvider;
  /** Its name at the provider, which the user types: `<app>-<name>`. */
  resource: string;
  /** Its module's address prefix: `module.server_<name>.`. */
  module: string;
  /** The provider's automatic backups are on. */
  backups: boolean;
}

/** The plan's extra servers OpsCrew created, in plan order. */
export function extraCloudServers(plan: DeployPlan): ExtraCloudServer[] {
  return (plan.servers ?? []).flatMap(({ name, target }) =>
    target.provider === "own"
      ? []
      : [
          {
            name,
            provider: target.provider,
            resource: `${plan.app.name}-${name}`,
            module: `module.server_${name}.`,
            backups: target.backups,
          },
        ],
  );
}

/** The names of the plan's extra servers the user owns, in plan order. */
export function extraOwnServers(plan: DeployPlan): string[] {
  return (plan.servers ?? []).flatMap((server) =>
    server.target.provider === "own" ? [server.name] : [],
  );
}

/**
 * `-var <name>_delete_protection=false` for each extra Hetzner server (only Hetzner has delete
 * protection), which the protection-lifting plan and the teardown pass.
 */
export function extraProtectionVars(plan: DeployPlan): Record<string, string> {
  return Object.fromEntries(
    extraCloudServers(plan)
      .filter((server) => providerProfile(server.provider).deleteProtection)
      .map((server) => [`${server.name}_delete_protection`, "false"]),
  );
}

/** ` with the PostgreSQL database on it`: the data of the services on `server`, or nothing. */
function dataOn(plan: DeployPlan, server: string): string {
  const data = serverData({ services: servicesOn(plan, server), storage: undefined });
  return data.length === 0 ? "" : ` with ${listText(data)} on it`;
}

/** A server OpsCrew created that the teardown deletes, and whether it gets a snapshot first. */
export interface ServerSnapshot {
  /** Its name in the plan: `app` or an extra server's. */
  server: string;
  provider: CloudProvider;
  /** An extra server's name at the provider (`<app>-<name>`); none for the app's server. */
  name?: string;
  /** The preview deletes it, and its ids as the state records them. */
  inState: boolean;
  ids: string[];
  /** What lives only on it: its services' data, and the provider's backups. */
  data: { serverData: boolean; backups: boolean };
  /** A snapshot is taken first (`--snapshot`, or `auto` with data on it; never `--no-snapshot`). */
  wanted: boolean;
}

/**
 * Each server OpsCrew created whose module the preview deletes, in plan order (the app's first,
 * on a cloud target), with whether it gets a snapshot first: `choice`, or with `auto` when the
 * services placed on it keep data (the app's also its SQLite database) or its backups are on.
 */
export function serverSnapshots(
  plan: DeployPlan,
  preview: { changes: readonly ResourceChange[]; planJson: unknown },
  choice: "auto" | boolean | undefined,
): ServerSnapshot[] {
  const target = plan.target;
  const app =
    target.provider === "hetzner" || target.provider === "digitalocean"
      ? [
          {
            server: APP_SERVER,
            provider: target.provider,
            module: "module.server.",
            backups: target.backups,
            storage: plan.storage,
          },
        ]
      : [];
  const extras = extraCloudServers(plan).map((server) => ({
    server: server.name,
    provider: server.provider,
    name: server.resource,
    module: server.module,
    backups: server.backups,
    storage: undefined,
  }));
  return [...app, ...extras].map(({ module, backups, storage, ...server }) => {
    const changes = preview.changes.filter((change) => change.address.startsWith(module));
    const inState = deletesServer(changes, server.provider);
    const data = {
      serverData: serverData({ services: servicesOn(plan, server.server), storage }).length > 0,
      backups,
    };
    return {
      ...server,
      inState,
      ids: serverIdsInPlan(preview.planJson, server.provider, module),
      data,
      wanted: inState && snapshotWanted(choice, data),
    };
  });
}

/**
 * The snapshot of each of `snapshots` before the teardown deletes it (`takeSnapshotBeforeDelete`,
 * each with its own record), by server name. Each is taken through its provider's snapshot API
 * (`input.servers` replaces it in tests).
 */
export async function snapshotServers(
  session: DeletionSession,
  snapshots: readonly ServerSnapshot[],
  input: Pick<SnapshotBeforeDeleteInput, "choice" | "servers" | "sleep" | "now">,
): Promise<Record<string, string | undefined>> {
  const ids: Record<string, string | undefined> = {};
  for (const snapshot of snapshots) {
    ids[snapshot.server] = await takeSnapshotBeforeDelete(
      { ...session, provider: snapshot.provider },
      {
        ...input,
        server: { inState: snapshot.inState, ids: snapshot.ids },
        data: snapshot.data,
        purpose: "destroy",
        ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
      },
    );
  }
  return ids;
}

/**
 * The confirmation's line for each server of an app with extra servers, by name (none without):
 * what happens to it, and for a server OpsCrew created what is deleted with it and whether it gets
 * a snapshot first (`snapshots`).
 */
export function serverLines(plan: DeployPlan, snapshots: readonly ServerSnapshot[] = []): string[] {
  if ((plan.servers ?? []).length === 0) return [];
  const snapshot = (server: string) =>
    snapshots.some((s) => s.server === server && s.wanted)
      ? "a snapshot of it is taken first"
      : "OpsCrew takes no snapshot of it";
  const app = plan.target.provider;
  const appTexts = app === "hetzner" || app === "digitalocean" ? destroyTexts(app) : undefined;
  const appLine =
    appTexts === undefined
      ? `Server ${APP_SERVER}: the app, its private network and OpsCrew's records of them are removed; your server stays.`
      : `Server ${APP_SERVER}: the ${appTexts.displayName} ${appTexts.noun} ${plan.app.name} is deleted${dataOn(plan, APP_SERVER)}; ${snapshot(APP_SERVER)}.`;
  const cloud = new Map(extraCloudServers(plan).map((server) => [server.name, server]));
  return [
    appLine,
    ...(plan.servers ?? []).map(({ name }) => {
      const server = cloud.get(name);
      if (server === undefined) {
        return `Server ${name}: OpsCrew's services, the private network and OpsCrew's setup are removed; your server stays.`;
      }
      const texts = destroyTexts(server.provider);
      return `Server ${name}: the ${texts.displayName} ${texts.noun} ${server.resource} is deleted${dataOn(plan, name)}; ${snapshot(name)}.`;
    }),
  ];
}

/**
 * After the app's typed name, each extra cloud server the confirmed teardown deletes (its module
 * in `preview.resources`) needs its own typed name, its name at the provider (`<app>-<name>`):
 * `confirm` is asked again with that name and `server` set. A name not typed stops with nothing
 * changed.
 */
export async function confirmExtraServers(
  scope: DeletionScope,
  plan: DeployPlan,
  preview: DestroyPreview,
  confirm: DestroyOptions["confirm"],
): Promise<void> {
  for (const server of extraCloudServers(plan)) {
    if (!preview.resources.some((change) => change.address.startsWith(server.module))) continue;
    const texts = destroyTexts(server.provider);
    await confirmDeletion(
      scope,
      {
        ...preview,
        name: server.resource,
        server: server.name,
        confirmPrompt: `Type ${server.resource} to delete server ${server.name} (the ${texts.displayName} ${texts.noun} ${server.resource}) and everything on it (anything else cancels)`,
      },
      confirm,
    );
  }
}

/** The host adapter for the user's own servers: the services' fake in tests, else ssh-host's. */
function hostAdapter(services: DestroyServices): HostAdapterApi {
  return services.own?.host ?? { inspect: (remote) => inspectHost(remote), apply: applyHostPlan };
}

/** True when a new login on the server `name` works (`plan`'s address for it), for the safety switch. */
function loginWorks(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: DestroyServices,
): () => Promise<boolean> {
  if (services.own?.verifyLogin !== undefined) return services.own.verifyLogin;
  return async () => {
    const remote =
      services.remote?.((await serverLogin(deps, plan, name)).host) ??
      (await serverRemote(deps, plan, name, { fresh: true }));
    return (await remote.run("true", { timeoutMs: 30_000 })).exitCode === 0;
  };
}

/** The sources public SSH opens to again: the plan's allow-list, else everyone (its default). */
function openTo(plan: DeployPlan): string[] {
  const cidrs = plan.security.sshAllowedCidrs;
  return cidrs.length > 0 ? [...cidrs] : ["0.0.0.0/0", "::/0"];
}

/**
 * With public SSH closed (`network.publicSsh: false`), opens it again on each of `servers` (the
 * user's own servers whose private network the teardown removes) before any network is removed,
 * since removing a network deletes the SSH rule on its interface: one `public-ssh` host plan per
 * server, reached over the private network and approved by its hash, under the safety switch.
 * Then `opscrew/plan.yaml` says public SSH is open (to the allow-list it was opened to), and every
 * later connection goes to the public address, and the plans' approvals are recorded in it. Returns
 * the plan as written; `plan` itself without closed SSH or such a server.
 */
export async function reopenPublicSsh(
  deps: PhaseDeps,
  plan: DeployPlan,
  servers: readonly string[],
  services: DestroyServices,
): Promise<DeployPlan> {
  const network = plan.network;
  if (network?.publicSsh !== false || servers.length === 0) return plan;
  const allowedCidrs = openTo(plan);
  const open: DeployPlan = {
    ...plan,
    network: { ...network, publicSsh: true },
    security: { ...plan.security, sshAllowedCidrs: allowedCidrs },
  };
  const adapter = hostAdapter(services);
  const approvals: ApprovalRecord[] = [];
  for (const name of servers) {
    const member = network.members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
    const shell = await serverShell(deps, plan, name, services);
    const facts = await adapter.inspect(shell.remote);
    const hostPlan = planPublicSsh(
      facts,
      {
        app: plan.app.name,
        publicSsh: {
          open: true,
          interface: networkInterface(member),
          allowedCidrs,
          sshPort: shell.login.port,
          cloudServer: false,
        },
      },
      COMMAND,
    );
    const where = `server ${name}`;
    const outcome = await approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: shell.remote,
      apply: (remote, p, options) => adapter.apply(remote, p, options),
      verifyLogin: loginWorks(deps, open, name, services),
      title: `Open SSH on server ${name} again before its private network is removed`,
      server: where,
      planOf: where,
      upToDate: `SSH is open on server ${name} already.`,
      command: COMMAND,
      phase: "provision",
      intro: [
        `Public SSH is closed, and removing the private network deletes the SSH rule on its interface, so OpsCrew opens SSH on server ${name} to ${listText(allowedCidrs)} first. Nothing is removed yet.`,
      ],
      refused: {
        message: `SSH on server ${name} was not opened again, so nothing was removed.`,
        hint: SHOWS_PLAN_AGAIN,
      },
      secrets: async () => ({}),
    });
    if (outcome.approval !== undefined) approvals.push(outcome.approval);
  }
  const opened = { ...open, approvals: [...plan.approvals, ...approvals.map(approvalEntry)] };
  await writeArtifact("plan", deps.paths.files.plan, opened);
  deps.reporter.info(
    "Public SSH is open again on the servers whose private network the teardown removes; opscrew/plan.yaml says so.",
  );
  return opened;
}

/**
 * The project's repository (its GitHub remote `origin`), so the host plans never touch another
 * repository's runner; none without such a remote (they then leave every runner, and say so).
 */
export async function project(deps: PhaseDeps): Promise<{ repositoryUrl?: string }> {
  const remote = parseGitHubRepo((await gitClient(deps).remoteUrl("origin")) ?? "");
  return remote === undefined ? {} : { repositoryUrl: repositoryUrl(remote) };
}

/**
 * On each extra server the user owns, OpsCrew's part goes and what was there before stays (FR-1812):
 * the teardown host plan (the app's services and their files, the private network's interface and
 * filter, the app's record; its data only with `deleteData`), then, unless another OpsCrew app
 * still uses the server, the undo host plan (OpsCrew's setup from its record). Each is shown,
 * approved by its hash with `allowDestroy` and the typed app name, and applied through the host
 * adapter under the safety switch. Returns the approvals.
 */
export async function removeExtraOwnServers(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { deleteData: boolean; services: DestroyServices },
): Promise<ApprovalRecord[]> {
  const names = extraOwnServers(plan);
  if (names.length === 0) return [];
  const { services } = options;
  const app = plan.app.name;
  const adapter = hostAdapter(services);
  const repository = await project(deps);
  const approvals: ApprovalRecord[] = [];
  for (const name of names) {
    const shell = await serverShell(deps, plan, name, services);
    const where = `server ${name}`;
    const step = {
      remote: shell.remote,
      apply: ((remote, p, o) => adapter.apply(remote, p, o)) satisfies HostAdapterApi["apply"],
      verifyLogin: loginWorks(deps, plan, name, services),
      server: where,
      planOf: where,
      command: COMMAND,
      phase: "provision" as const,
      allowDestroy: true,
      confirmPhrase: app,
      secrets: async () => ({}),
    };
    deps.reporter.step(`Reading server ${name}`);
    const facts: HostFacts = await adapter.inspect(shell.remote);
    const teardown = planTeardown(
      facts,
      { deleteData: options.deleteData, app, projectId: deps.paths.projectId, ...repository },
      COMMAND,
    );
    const changes = teardown.steps.filter((item) => item.state === "change").length;
    const removed = await approveAndApplyHostPlan(deps, {
      ...step,
      plan: teardown,
      title: `Remove ${app}'s services and private network from server ${name} (${plural(changes, "change")})`,
      upToDate: `Nothing of ${app} is left on server ${name}.`,
      intro: [
        options.deleteData
          ? `This removes ${app}'s services from server ${name}, including their data, and the private network's interface and filter.`
          : `This removes ${app}'s services from server ${name} and the private network's interface and filter; their data stays.`,
        "Your server itself stays.",
      ],
      refused: {
        message: `The removal of ${app} from server ${name} was not approved, so nothing on it was changed.`,
        hint: SHOWS_PLAN_AGAIN,
      },
      auditAs: "host teardown",
    });
    if (removed.approval !== undefined) approvals.push(removed.approval);
    const after = removed.applied ? await adapter.inspect(shell.remote) : facts;
    const others = otherActiveApps(after.apps, "").map((record) => record.app);
    if (others.length > 0) {
      deps.reporter.info(
        `OpsCrew's setup stays on server ${name}: the OpsCrew ${others.length === 1 ? "app" : "apps"} ${listText(others.map((other) => `"${other}"`))} still ${others.length === 1 ? "uses" : "use"} it.`,
      );
      continue;
    }
    const undo = planUndo(after, repository, COMMAND);
    const undoChanges = undo.steps.filter((item) => item.state === "change").length;
    const undone = await approveAndApplyHostPlan(deps, {
      ...step,
      plan: undo,
      title: `Undo OpsCrew's changes to server ${name} (${plural(undoChanges, "change")})`,
      upToDate: `OpsCrew's changes to server ${name} are undone already.`,
      intro: [
        `This reverses what OpsCrew changed on server ${name}, from its record in /etc/opscrew/host.json, and leaves alone anything OpsCrew did not install. Docker stays installed. SSH and firewall changes are undone under a safety switch.`,
        "Your server itself stays.",
      ],
      refused: {
        message: `Undoing OpsCrew's changes to server ${name} was not approved; ${app} is removed from it, and OpsCrew's setup stays.`,
        hint: SHOWS_PLAN_AGAIN,
      },
      auditAs: "host undo",
    });
    if (undone.approval !== undefined) approvals.push(undone.approval);
    deps.reporter.success(`Removed what OpsCrew installed on server ${name}; the server stays.`);
  }
  return approvals;
}

/**
 * After the teardown deleted the extra cloud servers: their addresses leave this computer's server
 * record and their host keys OpsCrew's known_hosts. The user's own servers keep their logins, as
 * the app's own server does.
 */
export async function forgetExtraCloudServers(deps: PhaseDeps, plan: DeployPlan): Promise<void> {
  const names = extraCloudServers(plan).map((server) => server.name);
  if (names.length === 0) return;
  const record = await readServerAddresses(deps.paths);
  const addresses = names.flatMap((name) => {
    const address = record.servers?.[name];
    return address === undefined ? [] : [address.ipv4, address.ipv6];
  });
  await forgetHostKeys(deps, addresses);
  await updateServerAddresses(deps.paths, ({ servers, ...rest }) => {
    const kept = Object.fromEntries(
      Object.entries(servers ?? {}).filter(([name]) => !names.includes(name)),
    );
    return Object.keys(kept).length === 0 ? rest : { ...rest, servers: kept };
  });
}
