/**
 * The side of a move in the user's Portainer (ADR 0027 D1, plan.md "1. Sides"): the app's stacks
 * through stack plans approved by hash (`preparePortainerStacks`, as provision sets them up), its
 * containers and volumes through Portainer's Docker proxy. It changes only the app's stacks,
 * containers and volumes, never Portainer or its environment (SC-2304), and refuses Edge Agent
 * environments before any change.
 */
import {
  type DockerClient,
  type DockerContainer,
  dockerClient,
  volumeCarrier,
} from "@opscrew/connector-docker";
import {
  COMPOSE_PROJECT_LABEL,
  DEPLOY_COMPOSE_FILE,
  PORTAINER_TOKEN_STEPS,
  type PortainerClient,
  planStackTeardown,
  stackPlanHash,
} from "@opscrew/connector-portainer";
import type { DockerTransport } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  fillPortainerStack,
  IMAGES,
  portainerStackName,
  portainerStackTemplatePath,
  portainerTarget,
  portainerVersionVolume,
  processServices,
} from "@opscrew/iac-templates";
import type { DeployPlan, PortainerDeployTarget, Retarget } from "@opscrew/plan-schema";
import { applyTeardown, approveTeardown, describeTeardown } from "../../destroy/portainer";
import type { DestroyPreview } from "../../destroy/types";
import {
  buildAppEnvironment,
  providerBucket,
  requireStorageKey,
  storageLogin,
} from "../../provision";
import { portainerOriginTls } from "../../provision/origin-tls";
import { ensurePortainerValueKey, requirePortainerToken } from "../../provision/portainer";
import { preparePortainerStacks } from "../../provision/portainer-flow";
import { requireNoStackBlockers, requireUsableFacts } from "../../provision/stack-plan";
import type { PortainerServices } from "../../provision/types";
import {
  committedStackPins,
  deployBranchOf,
  hidePortainerAddress,
  inspectAudited,
  type PortainerConnection,
  pollUntil,
  portainerClientFor,
} from "../../shared";
import { auditMove, type MoveSession, moveOf, renderFiles, waitsOf } from "../session";
import { pendingStop } from "../steps";
import { runOneOff } from "./postgres";
import type { MoveSide, SideDocker, SideVolume } from "./types";

/** The Compose label that names a container's service. */
const SERVICE_LABEL = "com.docker.compose.service";
/** The stack's Caddy, its edge. */
const EDGE = "caddy";
const HEALTH_TIMEOUT_MS = 5 * 60_000;

/** How OpsCrew reaches one side's Portainer and what it created there, in `.opscrew/server.json`. */
export interface PortainerRecord {
  read(): Promise<PortainerConnection | undefined>;
  write(connection: PortainerConnection): Promise<void>;
}

/** What {@link portainerSide} works with. */
export interface PortainerSideInput {
  /** The new side (`plan.target`) or the old one (`plan.retarget.from.target`). */
  which: "new" | "old";
  /**
   * This side's record: `portainer` for the new side (the stack step records there too), the
   * move's slot for the old one.
   */
  record: PortainerRecord;
  /** The image the old side runs (a `ghcr.io/…@sha256:…` reference), which the new side deploys. */
  image: (session: MoveSession) => Promise<string>;
  /**
   * The app's image is public on GitHub Container Registry, as the user said (`--public-image`);
   * used when the record doesn't say.
   */
  publicImage?: boolean;
  services?: PortainerServices;
}

/** The side's Portainer, checked and connected. */
interface Connected {
  plan: DeployPlan;
  target: PortainerDeployTarget;
  connection: PortainerConnection;
  client: PortainerClient;
  valueKey: Uint8Array;
}

/** The plain stop for an Edge Agent environment, before any change. */
function edgeRefused(environment: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Your Portainer environment "${environment}" is an Edge Agent environment, which OpsCrew cannot move an app to or from yet: its Docker API is reached only through the Edge Agent, and OpsCrew has not checked copying volumes that way. Nothing was changed.`,
    {
      hint: "Move the app to or from an environment Portainer reaches through its Docker socket or the Portainer Agent, or choose a server instead.",
    },
  );
}

/** The plain stop for a move from one Portainer environment to another, before any change. */
function betweenPortainers(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Moving an app between two Portainer environments isn't possible yet. Nothing was changed.",
    {
      hint: "Move the app to a server first, then into the other environment; or remove it with `opscrew destroy` and set it up there with `opscrew provision`.",
    },
  );
}

/**
 * Portainer's 401 and 403 through its Docker proxy, in plain words: the token, and that a
 * standard user's token reaches only the containers of the stacks that user deployed (R5).
 */
function accessRefused(status: 401 | 403, command: string): OpsCrewError {
  if (status === 401) {
    return new OpsCrewError(
      "CREDENTIALS_INVALID",
      "Portainer rejected the access token (PORTAINER_API_KEY) when OpsCrew used the environment's Docker.",
      {
        hint: `${PORTAINER_TOKEN_STEPS}, then set PORTAINER_API_KEY to it and run \`${command}\` again.`,
      },
    );
  }
  return new OpsCrewError(
    "PROVIDER_ERROR",
    "Portainer refused the access token (PORTAINER_API_KEY) on the app's containers or volumes (HTTP 403): a standard user's token reaches only the containers of the stacks that user deployed.",
    {
      hint: `Set PORTAINER_API_KEY to an administrator's access token, or to the token of the user who deployed the app's stacks, then run \`${command}\` again.`,
    },
  );
}

/** `transport`, with Portainer's 401 and 403 turned into {@link accessRefused}. */
function withAccessWords(transport: DockerTransport, command: string): DockerTransport {
  return {
    async request(request) {
      const response = await transport.request(request);
      if (response.status !== 401 && response.status !== 403) return response;
      response.body.destroy();
      throw accessRefused(response.status, command);
    },
  };
}

/** The Portainer target the move leaves. */
function oldTarget(target: Retarget["from"]["target"]): PortainerDeployTarget {
  if (target.provider !== "portainer") {
    throw new OpsCrewError(
      "INTERNAL",
      "The old side of this move is not a Portainer environment.",
      {
        hint: "This is a bug in OpsCrew; please report it.",
      },
    );
  }
  return target;
}

/** The MoveSide of a Portainer environment. */
export function portainerSide(input: PortainerSideInput): MoveSide {
  const services = input.services ?? {};

  /** The plan as this side runs the app: the new target, or the one being left. */
  function sidePlan(session: MoveSession): DeployPlan {
    return input.which === "new"
      ? session.plan
      : { ...session.plan, target: oldTarget(moveOf(session).from.target) };
  }

  /** The client of each session's Portainer, made and checked once. */
  const clients = new WeakMap<MoveSession, Promise<Pick<Connected, "client" | "valueKey">>>();

  /** A client for the recorded Portainer, with the token; stops on an Edge Agent environment. */
  async function openClient(
    session: MoveSession,
    connection: PortainerConnection,
    target: PortainerDeployTarget,
  ): Promise<Pick<Connected, "client" | "valueKey">> {
    const { deps } = session;
    // Portainer's address (and its host name) is never printed.
    hidePortainerAddress(deps.redactor, connection.url);
    const token = requirePortainerToken(deps);
    const valueKey = await ensurePortainerValueKey(deps, services.randomBytes);
    const client = portainerClientFor(deps, {
      connection,
      token,
      client: services.client,
      valueKey,
    });
    const kind = await client.environmentKind(target.environmentId);
    if (kind === "edge" || kind === "edge-async") throw edgeRefused(connection.environmentName);
    return { client, valueKey };
  }

  /**
   * The side's Portainer from its record (read each time: a stack step changes it), with the
   * session's client; stops on a move between two Portainer environments and on an Edge Agent
   * environment.
   */
  async function connect(session: MoveSession): Promise<Connected> {
    const from = session.plan.retarget?.from.target;
    if (session.plan.target.provider === "portainer" && from?.provider === "portainer") {
      throw betweenPortainers();
    }
    const plan = sidePlan(session);
    const target = portainerTarget(plan.target);
    const connection = await input.record.read();
    if (connection === undefined || connection.environmentId !== target.environmentId) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew does not know how to reach your Portainer environment ${target.environmentId} on this computer, so it changed nothing.`,
        {
          hint:
            input.which === "new"
              ? `Answer the Portainer questions for the new side (its address and the environment): run \`${session.command}\` in a terminal, or give them with --answers.`
              : "Run the move on the computer that set up the app in your Portainer (its .opscrew folder holds the connection).",
        },
      );
    }
    let opened = clients.get(session);
    if (opened === undefined) {
      opened = openClient(session, connection, target);
      clients.set(session, opened);
      // A failure is tried again on the next call.
      opened.catch(() => clients.delete(session));
    }
    return { plan, target, connection, ...(await opened) };
  }

  async function sideDocker(session: MoveSession): Promise<SideDocker> {
    const { client, target } = await connect(session);
    const docker = dockerClient(
      withAccessWords(client.dockerProxyTransport(target.environmentId), session.command),
    );
    return {
      client: docker,
      carrier: volumeCarrier(docker, IMAGES.busybox.ref),
      close: async () => {},
    };
  }

  /** The app stack's containers, by the Compose services they run. */
  async function containers(
    session: MoveSession,
    docker: DockerClient,
    names: readonly string[],
  ): Promise<DockerContainer[]> {
    const stack = portainerStackName(sidePlan(session));
    const all = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${stack}`]);
    return all.filter((container) => names.includes(container.labels[SERVICE_LABEL] ?? ""));
  }

  async function stop(session: MoveSession, names: readonly string[]): Promise<void> {
    const { client } = await sideDocker(session);
    for (const container of await containers(session, client, names)) {
      await client.stopContainer(container.id);
    }
  }

  async function start(session: MoveSession, names: readonly string[]): Promise<void> {
    const { client } = await sideDocker(session);
    for (const container of await containers(session, client, names)) {
      await client.startContainer(container.id);
    }
  }

  /** The app, its workers and its cron, which use its data. */
  const appServices = (session: MoveSession) => ["app", ...processServices(sidePlan(session))];

  async function healthy(session: MoveSession): Promise<boolean> {
    const plan = sidePlan(session);
    const { client } = await sideDocker(session);
    // A one-off busybox on the stack's network, as the carrier runs: it works whether the stack's
    // Caddy runs or not.
    const result = await runOneOff(client, {
      image: IMAGES.busybox.ref,
      cmd: [
        "wget",
        "-q",
        "-O",
        "/dev/null",
        "-T",
        "5",
        `http://app:${plan.app.port}${plan.app.healthPath}`,
      ],
      network: `${portainerStackName(plan)}_internal`,
    });
    return result.exitCode === 0;
  }

  /** The app's stacks as provision sets them up, connected and checked, for this side's plan. */
  async function stacksOf(session: MoveSession) {
    const { deps, github } = session;
    const { plan, target, connection, client, valueKey } = await connect(session);
    const inspect = async (detail?: string) => {
      const facts = await inspectAudited(deps, client, {
        plan,
        target,
        step: "Inspecting your Portainer (read-only)",
        phase: "retarget",
        ...(detail !== undefined ? { detail } : {}),
      });
      requireUsableFacts(facts, target);
      return facts;
    };
    const bucket = providerBucket(plan);
    let environment: Awaited<ReturnType<typeof buildAppEnvironment>> | undefined;
    const appEnvironment = async () => {
      if (environment === undefined) {
        // The bucket stays where it is: the app keeps its key.
        const key =
          bucket === undefined
            ? undefined
            : await requireStorageKey(deps, plan, session.services, {
                command: session.command,
                already: "Nothing in your Portainer was changed.",
              });
        environment = await buildAppEnvironment(deps, plan, session.services, undefined, {
          portainer: true,
          ...(key === undefined ? {} : { storage: storageLogin(plan, key, session.cloudflare) }),
        });
      }
      return environment;
    };
    const tls = session.site.edge.originTls;
    const bundle = tls === undefined ? undefined : portainerOriginTls(session.site.values);
    if (bundle !== undefined) deps.redactor.addLiteral(bundle, "origin-tls");
    const repository = await github.api.getRepo(github.owner, github.repo);
    const stacks = preparePortainerStacks(deps, {
      plan,
      phase: "retarget",
      command: session.command,
      client,
      connection,
      valueKey,
      facts: await inspect(),
      inspect,
      github,
      repositoryPrivate: repository.private,
      publicImage: connection.publicImage ?? input.publicImage ?? false,
      committed: await committedStackPins(deps.paths.root, plan),
      services,
      appEnvironment,
      origin: () => ({
        ...(tls !== undefined ? { tls } : {}),
        ...(bundle !== undefined ? { bundle } : {}),
      }),
    });
    return { plan, target, stacks };
  }

  /**
   * Points the deploy branch at the app's stack with `image` (the old side's), behind its own
   * `git-push` approval, unless it holds exactly that already: Portainer deploys the app stack
   * from it as soon as the stack exists.
   */
  async function writeDeployBranch(session: MoveSession, plan: DeployPlan, image: string) {
    const { deps, github } = session;
    const branch = deployBranchOf(plan);
    const repo = `${github.owner}/${github.repo}`;
    const template = (await renderFiles(session)).find(
      (file) => file.path === portainerStackTemplatePath(plan),
    );
    if (template === undefined) {
      throw new OpsCrewError("INTERNAL", "The app's stack template was not rendered.", {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    const content = fillPortainerStack(template.content, image);
    const exists = (await session.git.remoteBranchSha(branch)) !== undefined;
    const file = { path: DEPLOY_COMPOSE_FILE, content };
    if (exists && (await github.api.branchHoldsOnly(github.owner, github.repo, branch, file))) {
      deps.reporter.info(`The branch ${branch} already holds the app's version ${image}.`);
      return;
    }
    const approval = await deps.approvals.request({
      kind: "git-push",
      title: `${exists ? "Replace" : "Create"} the branch ${branch} in ${repo} with the version of the app the old side runs`,
      details: [
        `Portainer builds the app's stack from the ${branch} branch. OpsCrew points it at a new commit holding only this ${DEPLOY_COMPOSE_FILE}: the app's stack with the image the app runs now (${image}), so the new side runs the same version as the old one${exists ? " (the branch's earlier commits leave it)" : ""}:`,
        "",
        content,
      ].join("\n"),
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The ${branch} branch was not written, so OpsCrew cannot deploy the app in your Portainer. Nothing in Portainer was changed.`,
        { hint: `Run \`${session.command}\` again when you are ready.` },
      );
    }
    const change = {
      owner: github.owner,
      repo: github.repo,
      branch,
      path: DEPLOY_COMPOSE_FILE,
      content,
      message: `OpsCrew: deploy ${image} to the new side of the move`,
    };
    const detail = exists
      ? `move ${(await github.api.replaceOrphanBranch(change)).commit}`
      : `move ${(await github.api.createOrphanBranch(change)).commit}`;
    await auditMove(session, {
      kind: "git",
      action: "push",
      target: `${repo}:${branch}`,
      decision: "approved",
      detail,
    });
  }

  return {
    kind: "portainer",

    docker: sideDocker,

    async prepare(session) {
      // Read-only: the environment checked, and what blocks the stacks stops here.
      await stacksOf(session);
      return undefined;
    },

    async deploy(session) {
      const { deps } = session;
      const { plan, target, stacks } = await stacksOf(session);
      // A script names the stack plan it applies: shown and saved first.
      if (!deps.interactive && session.approve === undefined) {
        const shown = await stacks.step({}, { planOnly: true });
        if (shown.plan.changes.some((change) => change.state === "change")) {
          return pendingStop(session, shown.hash);
        }
      }
      await writeDeployBranch(session, plan, await input.image(session));
      const applied = await stacks.step({}, { planOnly: false });
      if (applied.approval !== undefined) session.approve = undefined;
      deps.reporter.step("Checking the app in your Portainer");
      const answered = await pollUntil(async () => ((await healthy(session)) ? true : undefined), {
        timeoutMs: HEALTH_TIMEOUT_MS,
        intervalMs: 5000,
        ...waitsOf(session.services),
      });
      if (answered === undefined) {
        throw new OpsCrewError(
          "COMMAND_FAILED",
          `The app in your Portainer did not answer on http://app:${plan.app.port}${plan.app.healthPath} within 5 minutes. The old side still serves your users.`,
          {
            hint: `See why in Portainer (the stack ${portainerStackName(plan)}, the app container's logs), push a fix, then run \`${session.command}\` again.`,
          },
        );
      }
      deps.reporter.step(
        "Stopping the stack's Caddy in your Portainer until traffic is switched to it",
      );
      await stop(session, [EDGE]);
      await auditMove(session, {
        kind: "provider-call",
        action: `stop ${EDGE}`,
        target: `portainer environment ${target.environmentId}`,
        decision: "approved",
      });
      return undefined;
    },

    stopApp: (session) => stop(session, appServices(session)),
    startApp: (session) => start(session, appServices(session)),
    stopServices: (session, names) => stop(session, names),
    startServices: (session, names) => start(session, names),
    stopEdge: (session) => stop(session, [EDGE]),
    startEdge: (session) => start(session, [EDGE]),
    healthy,

    async volumes(session) {
      const plan = sidePlan(session);
      const { client } = await sideDocker(session);
      const app = new Set(["app", "release", ...processServices(plan)]);
      const owned = new Set(plan.services.filter((service) => service.enabled).map((s) => s.name));
      const sizes = await client.volumeSizes();
      const found = new Map<string, SideVolume>();
      const stack = portainerStackName(plan);
      for (const container of await client.listContainers([`${COMPOSE_PROJECT_LABEL}=${stack}`])) {
        const service = container.labels[SERVICE_LABEL] ?? "";
        // The app's data and its services'; Caddy's certificates and the version stay.
        const owner = app.has(service) ? "app" : owned.has(service) ? service : undefined;
        if (owner === undefined) continue;
        for (const mount of container.mounts) {
          if (mount.type !== "volume" || mount.name === undefined || found.has(mount.name))
            continue;
          found.set(mount.name, {
            owner,
            key: mount.destination,
            source: { kind: "volume", name: mount.name },
            bytes: sizes.get(mount.name) ?? 0,
          });
        }
      }
      return [...found.values()].sort(
        (a, b) => a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key),
      );
    },

    async remove(session, confirm) {
      const { deps } = session;
      const { plan, target, connection, client } = await connect(session);
      const name = plan.app.name;
      const facts = await inspectAudited(deps, client, {
        plan,
        target,
        step: "Inspecting your Portainer (read-only)",
        phase: "retarget",
        detail: "removing the app",
      });
      // The app's stacks, its recorded volumes and its registry entry: never Portainer or the
      // environment, nor anything OpsCrew did not create.
      const teardown = planStackTeardown(facts, connection.created, {
        deleteData: true,
        app: name,
        versionVolume: portainerVersionVolume(plan),
      });
      requireNoStackBlockers(teardown);
      const work = teardown.changes.filter((change) => change.state === "change");
      if (work.length === 0) {
        deps.reporter.info(`Nothing of ${name} is left in your Portainer.`);
        return undefined;
      }
      const preview: DestroyPreview = {
        name,
        provider: "portainer",
        deleteProtection: false,
        resources: [],
        snapshot: false,
        stackChanges: work.map((change) => change.title),
      };
      if (!(await confirm(preview))) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          `${name} was not removed from your Portainer. Nothing was changed.`,
          { hint: `Run \`${session.command}\` again when you are ready.` },
        );
      }
      const again = `Run \`${session.command}\` again when you are ready; it shows the plan again.`;
      // A script names the teardown it applies, with the app's name.
      if (!deps.interactive && session.approve === undefined) {
        const hash = stackPlanHash(teardown);
        deps.reporter.info(describeTeardown(teardown, hash, connection.environmentName));
        return pendingStop(session, hash, ["--confirm", name]);
      }
      const approved = await approveTeardown(deps, {
        plan: teardown,
        environment: connection.environmentName,
        name,
        intro: [],
        refused: `${name} was not removed from your Portainer. Nothing was changed.`,
        hint: again,
      });
      session.approve = undefined;
      await applyTeardown(deps, approved, {
        client,
        connection,
        name,
        afterFailure: `Fix the cause shown above, then run \`${session.command}\` again; it continues with what is left.`,
        ...(services.wait !== undefined ? { wait: services.wait } : {}),
        phase: "retarget",
        save: (left) => input.record.write(left),
      });
      return undefined;
    },
  };
}
