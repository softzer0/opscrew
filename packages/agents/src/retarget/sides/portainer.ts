/**
 * The side of a move in the user's Portainer (ADR 0027 D1, plan.md "1. Sides"): the app's stacks
 * through stack plans approved by hash (`preparePortainerStacks`, as provision sets them up), its
 * containers and volumes through Portainer's Docker proxy. It changes only the app's stacks,
 * containers and volumes, never Portainer or its environment (SC-2304); its inspection refuses Edge Agent
 * environments before any change.
 */
import {
  type DockerClient,
  type DockerContainer,
  dockerClient,
  runOneOff,
  volumeCarrier,
} from "@opscrew/connector-docker";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
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
import { confirmDeletion } from "../../destroy/deletion";
import { applyTeardown, approveTeardown, describeTeardown } from "../../destroy/portainer";
import type { DestroyPreview } from "../../destroy/types";
import { ensurePortainerValueKey, requirePortainerToken } from "../../provision/portainer";
import { portainerInspect, recordedPortainerStacks } from "../../provision/portainer-flow";
import { requireNoStackBlockers } from "../../provision/stack-plan";
import type { PortainerServices } from "../../provision/types";
import {
  deployBranchOf,
  hidePortainerAddress,
  inspectAudited,
  type PortainerConnection,
  pollUntil,
  portainerClientFor,
} from "../../shared";
import { auditMove, type MoveBase, type MoveSession, renderFiles, waitsOf } from "../session";
import { pendingStop } from "../steps";
import { sideTarget } from ".";

import { type MoveSide, type SideDocker, type SideVolume, STOP_SECONDS } from "./types";

/** The Compose label that names a container's service. */
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
function _oldTarget(target: Retarget["from"]["target"]): PortainerDeployTarget {
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
  function sidePlan(session: MoveBase): DeployPlan {
    return input.which === "new"
      ? session.plan
      : { ...session.plan, target: sideTarget(session, "old") };
  }

  /** The client of each session's Portainer, made and checked once. */
  const clients = new WeakMap<MoveBase, Promise<Pick<Connected, "client" | "valueKey">>>();

  /** A client for the recorded Portainer, with the token. */
  async function openClient(
    session: MoveBase,
    connection: PortainerConnection,
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
    return { client, valueKey };
  }

  /**
   * The side's Portainer from its record (read each time: a stack step changes it), with the
   * session's client. (A move between two Portainer
   * environments never starts.)
   */
  async function connect(session: MoveBase): Promise<Connected> {
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
      opened = openClient(session, connection);
      clients.set(session, opened);
      // A failure is tried again on the next call.
      opened.catch(() => clients.delete(session));
    }
    return { plan, target, connection, ...(await opened) };
  }

  async function sideDocker(session: MoveBase): Promise<SideDocker> {
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
    session: MoveBase,
    docker: DockerClient,
    names: readonly string[],
  ): Promise<DockerContainer[]> {
    const stack = portainerStackName(sidePlan(session));
    const all = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${stack}`]);
    return all.filter((container) => names.includes(container.labels[COMPOSE_SERVICE_LABEL] ?? ""));
  }

  /** Stops the stack's containers of `names`, each with `seconds` to stop cleanly (Docker's default without). */
  async function stop(
    session: MoveBase,
    names: readonly string[],
    seconds?: number,
  ): Promise<void> {
    const { client } = await sideDocker(session);
    for (const container of await containers(session, client, names)) {
      await client.stopContainer(container.id, seconds);
    }
  }

  async function start(session: MoveBase, names: readonly string[]): Promise<void> {
    const { client } = await sideDocker(session);
    for (const container of await containers(session, client, names)) {
      await client.startContainer(container.id);
    }
  }

  /** The app, its workers and its cron, which use its data. */
  const appServices = (session: MoveBase) => ["app", ...processServices(sidePlan(session))];

  async function healthy(session: MoveBase): Promise<boolean> {
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
    const { deps } = session;
    const { plan, target, connection, client, valueKey } = await connect(session);
    const inspect = portainerInspect(deps, client, { plan, phase: "retarget" });
    const stacks = await recordedPortainerStacks(deps, {
      plan,
      phase: "retarget",
      command: session.command,
      services: session.services,
      portainer: services,
      connected: { connection, client, valueKey, inspect, facts: await inspect() },
      github: session.github,
      cloudflare: session.cloudflare,
      site: session.site,
      publicImage: connection.publicImage ?? input.publicImage ?? false,
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
    // A stateful service gets 120 s to stop cleanly (T2306), so its files are whole.
    stopServices: (session, names) => stop(session, names, STOP_SECONDS),
    startServices: (session, names) => start(session, names),
    stopEdge: (session) => stop(session, [EDGE]),
    startEdge: (session) => start(session, [EDGE]),
    healthy,

    async release(session) {
      const plan = sidePlan(session);
      if (plan.app.releaseCommand === undefined) return;
      const { client } = await sideDocker(session);
      // The stack's one-off `release` container, which ran before the app's first start: it runs
      // the release command again, now on the copied data. Its output is never read.
      for (const container of await containers(session, client, ["release"])) {
        await client.startContainer(container.id);
        const exitCode = await client.waitContainer(container.id);
        if (exitCode !== 0) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `Could not run the release command (app.releaseCommand in opscrew/plan.yaml) in your Portainer: it exited with code ${exitCode} (it ran only on the copy of the data there; your users' data on the old side is untouched).`,
            {
              hint: `See its output in Portainer (the stack ${portainerStackName(plan)}, the release container's logs). Fix the release command or the app's migrations so they run on the old side's data, push the fix, then run \`${session.command}\` again.`,
            },
          );
        }
      }
    },

    async volumes(session) {
      const plan = sidePlan(session);
      const { client } = await sideDocker(session);
      const app = new Set(["app", "release", ...processServices(plan)]);
      const owned = new Set(plan.services.filter((service) => service.enabled).map((s) => s.name));
      const sizes = await client.volumeSizes();
      const found = new Map<string, SideVolume>();
      const stack = portainerStackName(plan);
      for (const container of await client.listContainers([`${COMPOSE_PROJECT_LABEL}=${stack}`])) {
        const service = container.labels[COMPOSE_SERVICE_LABEL] ?? "";
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
      // The typed name, audited as on the other sides.
      await confirmDeletion(
        {
          deps,
          provider: "portainer",
          app: name,
          command: session.command,
          what: `removal of ${name} from your Portainer`,
          phase: "retarget",
        },
        preview,
        confirm,
      );
      const again = `Run \`${session.command}\` again when you are ready; it shows the plan again.`;
      // A script names the teardown it applies, with the app's name; any other hash (an earlier,
      // stale one) shows the plan again.
      const hash = stackPlanHash(teardown);
      if (!deps.interactive && session.approve !== hash) {
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
      if (session.approve === hash) session.approve = undefined;
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
