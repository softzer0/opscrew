import { join } from "node:path";
import { exists, formatMoney, listText, OpsCrewError } from "@opscrew/core";
import { cloudTarget, serviceSpec } from "@opscrew/iac-templates";
import {
  type AppBuild,
  type CloudDeployTarget,
  type DeployPlan,
  type DesignOption,
  type ProjectFacts,
  type Retarget,
  readArtifact,
  serviceOf,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { buildDesignOptions } from "../design";
import { chooseBuilder } from "../design/builder";
import { deployStrategyFor, ROLLING_NOTE } from "../design/strategy";
import { providerProfile, requestedProvider, vpsConnector } from "../providers";
import { providerBucket, readRequirements, requireStorageKey } from "../provision";
import { designOptionLine, hasState, serverAddress } from "../shared";
import {
  localhostTargetNoMove,
  ownServerNoMove,
  portainerTargetNoMove,
} from "../shared/vps-target";
import { databaseSize, serverOps } from "./server-ops";
import { recordMoveServers } from "./servers";
import { auditStep, type MoveSession, openSession, pinHost, remoteFor, saveMove } from "./session";
import {
  ABORT_COMMAND,
  downtimeMinutes,
  downtimeUntilDnsChange,
  FINISH_COMMAND,
  manualSwitchDowntime,
  providerWords,
  RUN_COMMAND,
  sizeText,
  untilSwitched,
} from "./texts";
import type { RetargetOptions, RetargetSummary } from "./types";

function nothingLive(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${plan.app.name} has no live deployment on this computer, so there is nothing to move. Nothing was changed.`,
    {
      hint: plan.deployment.destroyedAt
        ? "The deployment was torn down. Run `opscrew design` for the provider you want, then `opscrew provision`."
        : "Run `opscrew provision` to deploy the app first (or run OpsCrew on the computer that provisioned it).",
    },
  );
}

/**
 * Stops before any change when the app keeps data a move cannot copy yet (FR-1332): a running
 * service other than PostgreSQL and Valkey (MySQL, MongoDB, a broker, Garage, an engine), or a
 * SQLite database. Workers and cron move with the app, and a bucket at a provider stays where it
 * is, so neither stops a move.
 */
function requireMovableData(plan: DeployPlan): void {
  const stuck = plan.services
    .filter((service) => service.enabled && !MOVABLE_KINDS.has(service.kind))
    .map((service) => `${service.name} (${serviceSpec(service.kind).title})`);
  if (plan.storage?.sqlite !== undefined) stuck.push("the SQLite database");
  if (stuck.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `A move copies the PostgreSQL database to the new server, but not yet the data of ${listText(stuck)}, so OpsCrew did not start it. Nothing was changed.`,
    {
      hint: "Copying the data of these services to a new server comes in a later version of OpsCrew. Until then, the app stays on its server.",
    },
  );
}

/** The services a move handles (feature 005): PostgreSQL is copied, Valkey starts afresh. */
const MOVABLE_KINDS: ReadonlySet<string> = new Set(["postgres", "valkey"]);

/** The option the user chose: `--option`, the picker, else the recommended one. */
async function pickOption(
  options: DesignOption[],
  input: Pick<RetargetOptions, "option" | "choose">,
): Promise<DesignOption> {
  let id = input.option;
  if (id === undefined && input.choose !== undefined) id = await input.choose(options);
  if (id === undefined) {
    const recommended = options.find((option) => option.recommended) ?? options[0];
    if (recommended === undefined) {
      throw new OpsCrewError("INVALID_INPUT", "There is no server option to move to.", {
        hint: "Check the region and budget with `opscrew interview`, then run `opscrew retarget` again.",
      });
    }
    return recommended;
  }
  const chosen = options.find((option) => option.id === id);
  if (chosen === undefined) {
    throw new OpsCrewError("INVALID_INPUT", `There is no option "${id}" to move to.`, {
      hint: `Choose one of: ${options.map((option) => option.id).join(", ")}.`,
    });
  }
  return chosen;
}

/** The new target from the chosen option, with the provider's default image and the old proxy. */
function targetOf(option: DesignOption, edge: CloudDeployTarget["edge"]): CloudDeployTarget {
  const { provider } = option.target;
  if (provider === "own") throw ownServerNoMove();
  if (provider === "portainer") throw portainerTargetNoMove();
  if (provider === "localhost") throw localhostTargetNoMove();
  return {
    provider,
    mode: "vps-compose",
    location: option.target.location,
    serverType: option.target.serverType,
    image: providerProfile(provider).defaultImage,
    backups: option.backups,
    edge,
  };
}

/** How the traffic reaches the new server at the switch, in one sentence. */
function switchSentence(plan: DeployPlan, noun: string): string {
  const domain = plan.dns.domain;
  if (plan.dns.provider === "cloudflare" && domain !== undefined) {
    return `Switch the Cloudflare DNS records of ${domain} to the new ${noun} and check the app through its domain.`;
  }
  if (domain !== undefined) {
    return `You change the DNS records of ${domain} to the new ${noun} (OpsCrew shows them), then OpsCrew checks the app through its domain.`;
  }
  return `Your app moves to the new ${noun}'s address (OpsCrew shows it), then OpsCrew checks it there.`;
}

/** What a move to `option` sets: the builder and the deploy strategy design picks for it. */
interface NewServerBuild {
  build: AppBuild;
  deploy: DeployPlan["deploy"];
}

/**
 * The image builder (`chooseBuilder` for the new server's architecture) and the deploy strategy
 * (`deployStrategyFor` its memory) of a move to `option`, as design picks them, keeping the
 * plan's drain time. Stops with `INVALID_INPUT` when the plan's builder cannot build there, and
 * with `PHASE_PRECONDITION` when the builder needs a Dockerfile (`app.dockerfile`) the repository
 * lacks.
 */
async function newServerBuild(
  deps: PhaseDeps,
  facts: ProjectFacts,
  plan: DeployPlan,
  option: DesignOption,
): Promise<NewServerBuild> {
  const choice = chooseBuilder(
    facts,
    plan,
    option.target.architecture === "arm" ? "arm64" : "amd64",
  );
  if ("refused" in choice) {
    throw new OpsCrewError("INVALID_INPUT", `${choice.refused} Nothing was changed.`, {
      hint: `Change app.build.builder in opscrew/plan.yaml, then run \`${RUN_COMMAND}\` again.`,
    });
  }
  const dockerfileBuild =
    choice.builder === "generated-dockerfile" || choice.builder === "own-dockerfile";
  if (dockerfileBuild && !(await exists(join(deps.paths.root, plan.app.dockerfile)))) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The new server's builder needs a Dockerfile this repository lacks: run `opscrew design` and `opscrew adapt` first. Nothing was changed.",
    );
  }
  for (const warning of choice.warnings) deps.reporter.warn(deps.redactor.redact(warning));
  const { builder, chosen, reason, runtime, probe, automatic } = choice;
  return {
    build: { builder, chosen, reason, runtime, probe, automatic },
    deploy: { ...deployStrategyFor(option), drainSeconds: plan.deploy.drainSeconds },
  };
}

/** The builder and strategy lines of the summary that differ from the plan's, with reasons. */
function buildChanges(plan: DeployPlan, next: NewServerBuild): string[] {
  const changes: string[] = [];
  const before = plan.app.build?.builder;
  if (before !== next.build.builder) {
    const was = before === undefined ? "" : ` (was ${before})`;
    changes.push(`Image builder: ${next.build.builder}${was}. ${next.build.reason}`);
  }
  const { deploy } = next;
  if (plan.deploy.strategy !== deploy.strategy) {
    // Design gives every recreate its reason.
    const why = deploy.strategy === "rolling" ? ROLLING_NOTE : (deploy.reason ?? "");
    changes.push(`Deploys: ${deploy.strategy} (was ${plan.deploy.strategy}). ${why}`.trimEnd());
  }
  return changes;
}

/** The summary shown before the first change. */
export function moveSummary(
  plan: DeployPlan,
  to: CloudDeployTarget,
  option: DesignOption,
  databaseBytes: number | undefined,
  changes: string[],
): RetargetSummary {
  const from = cloudTarget(plan.target);
  const old = providerWords(from.provider);
  const fresh = providerWords(to.provider);
  const minutes = databaseBytes === undefined ? undefined : downtimeMinutes(databaseBytes);
  // Without managed DNS the old app stays stopped until the user's own switch has taken effect.
  const offline = downtimeUntilDnsChange(plan)
    ? `; the app stays offline from then ${untilSwitched(plan)}`
    : "";
  return {
    from,
    to,
    steps: [
      `Rename the current ${old.noun} in OpsCrew's infrastructure state (nothing changes in your cloud).`,
      `Create the new ${fresh.noun} on ${fresh.name} (${to.serverType} in ${to.location}) next to the current one.`,
      `Point the GitHub deploy secrets at the new ${fresh.noun}, run the deploy workflow on ${plan.cicd.branch} and check the app there; its web server stays stopped until the switch.`,
      databaseBytes !== undefined
        ? `Maintenance window (about ${minutes} minutes for the copy): stop the app on the old ${old.noun}, copy the database (${sizeText(databaseBytes)}) to the new ${fresh.noun} and start the app there${offline}.`
        : "No maintenance window: there is no self-hosted database to copy.",
      switchSentence(plan, fresh.noun),
      `Keep the old ${old.noun} (with its app stopped) until you run \`${FINISH_COMMAND}\`; until the switch, \`${ABORT_COMMAND}\` undoes the move.`,
    ],
    extraMonthly: option.cost.monthly,
    ...(databaseBytes !== undefined ? { databaseBytes } : {}),
    ...(minutes !== undefined ? { expectedDowntimeMinutes: minutes } : {}),
    changes,
  };
}

function summaryText(summary: RetargetSummary, plan: DeployPlan): string {
  const old = providerWords(summary.from.provider);
  const fresh = providerWords(summary.to.provider);
  // Valkey starts afresh on the new server.
  const queue = plan.services.find(
    (service) => service.enabled && service.kind === "valkey" && service.options.mode === "queue",
  );
  return [
    `Moving ${plan.app.name} from ${old.name} (${summary.from.serverType} in ${summary.from.location}) to ${fresh.name} (${summary.to.serverType} in ${summary.to.location}):`,
    ...summary.steps.map((step, i) => `  ${i + 1}. ${step}`),
    `Extra cost while both servers run: ${formatMoney(summary.extraMonthly)} per month for the new ${fresh.noun}; the old ${old.noun} is billed until the move is finished.`,
    ...(summary.databaseBytes === undefined
      ? ["Database: none on the server, so the app stays online until the switch."]
      : downtimeUntilDnsChange(plan)
        ? [
            `Database: ${sizeText(summary.databaseBytes)}; expected downtime: about ${summary.expectedDowntimeMinutes} minutes for the copy, plus the time ${plan.dns.domain !== undefined ? "your DNS change takes to reach your users" : "your users take to switch to the new address"}.`,
            ...manualSwitchDowntime(plan),
          ]
        : [
            `Database: ${sizeText(summary.databaseBytes)}; expected maintenance window: about ${summary.expectedDowntimeMinutes} minutes.`,
          ]),
    ...(queue === undefined
      ? []
      : [
          `Jobs waiting in the Valkey queue (${queue.name}) are not moved: let the queue drain before the move, or those jobs are lost.`,
        ]),
    ...(summary.changes.length === 0
      ? []
      : [
          `On the new ${fresh.noun} (opscrew/plan.yaml records it, and the final files use it):`,
          ...summary.changes.map((change) => `  - ${change}`),
        ]),
    `While the move runs, ${plan.infra.dir} holds a transitional version of the infrastructure files; \`${FINISH_COMMAND}\` publishes the final ones in a pull request.`,
  ].join("\n");
}

/**
 * Step 1 of a move: preconditions (live deployment, another provider, credentials, keys), the
 * new provider's options in the plan's region and budget (as `opscrew design` prices them, without
 * its provider-switch guard), the choice, the summary and `confirmStart`; then records the move
 * (`plan.target` and `cost` are the new server's, `retarget.step` is `started`).
 */
export async function startMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<MoveSession> {
  // A Portainer target never moves (feature 010): it is destroyed and provisioned again instead.
  if (plan.target.provider === "portainer") throw portainerTargetNoMove();
  // Nor does an app on this computer (feature 015).
  if (plan.target.provider === "localhost") throw localhostTargetNoMove();
  const address =
    plan.deployment.destroyedAt === undefined && (await hasState(deps.paths))
      ? await serverAddress(deps, plan, {
          engine: options.services?.engine,
          ...(options.engine !== undefined ? { preference: options.engine } : {}),
        })
      : undefined;
  if (address === undefined) throw nothingLive(plan);
  const requirements = await readRequirements(deps);
  if (requirements === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/requirements.yaml is missing, so OpsCrew does not know the region and budget to move into. Nothing was changed.",
      {
        hint: "Run `opscrew interview` to answer the questions again, then run `opscrew retarget`.",
      },
    );
  }
  // A server the user owns never moves (spec 009): said before the cloud-only steps.
  if (plan.target.provider === "own") throw ownServerNoMove();
  requireMovableData(plan);
  // The bucket stays where it is: the app on the new server needs its key, known before any change.
  if (providerBucket(plan) !== undefined) {
    await requireStorageKey(deps, plan, options.services ?? {}, { command: RUN_COMMAND });
  }
  const from = cloudTarget(plan.target);
  if (options.to === undefined && requirements.provider === "portainer") {
    throw portainerTargetNoMove();
  }
  if (options.to === undefined && requirements.provider === "localhost") {
    throw localhostTargetNoMove();
  }
  const to = options.to ?? requestedProvider(requirements);
  if (to === "own") throw ownServerNoMove();
  if (to === from.provider) {
    const name = providerProfile(to).displayName;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} already runs on ${name}, so there is nothing to move. Moves within one provider (another location or size) are not supported yet. Nothing was changed.`,
      {
        hint: `Run \`${RUN_COMMAND} --to <provider>\` with the other provider, or change the provider with \`opscrew interview\` first.`,
      },
    );
  }
  const services = options.services ?? {};
  const session = await openSession(deps, plan, {
    command: RUN_COMMAND,
    providers: [from.provider, to],
    services,
    servers: { from: address },
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.approvePlanHash !== undefined ? { approvePlanHash: options.approvePlanHash } : {}),
  });

  // The new provider's options in the plan's region and budget.
  const fresh = providerWords(to);
  deps.reporter.step(`Pricing ${fresh.name} options for ${plan.app.name}`);
  const facts = (await readArtifact("architecture", deps.paths.files.architecture)).facts;
  const catalog =
    services.catalogs?.[to] ?? vpsConnector(to, deps, { now: () => deps.clock.now() }).catalog();
  const designOptions = await buildDesignOptions({
    facts,
    requirements: { ...requirements, provider: to },
    catalog,
    now: deps.clock.now(),
    // The new server runs the same proxy, whose memory the sizing counts.
    edge: from.edge,
  });
  for (const option of designOptions) deps.reporter.info(designOptionLine(option));
  const chosen = await pickOption(designOptions, options);
  const target = targetOf(chosen, from.edge);
  // The builder and the deploy strategy for the new server, before anything is created.
  const next = await newServerBuild(deps, facts, plan, chosen);

  // What it means: database size (over SSH to the old server) and the summary.
  const oldHost = address.ipv4;
  let databaseBytes: number | undefined;
  if (serviceOf(plan, "postgres")) {
    await pinHost(session, oldHost, from.provider);
    deps.reporter.step("Measuring the database on the old server");
    const old = remoteFor(deps, services, session.deployKey.privateKeyFile, oldHost);
    databaseBytes = await databaseSize(old, serverOps(plan, deps.redactor));
  }
  const summary = moveSummary(plan, target, chosen, databaseBytes, buildChanges(plan, next));
  deps.reporter.info(summaryText(summary, plan));
  if (options.confirmStart !== undefined && !(await options.confirmStart(summary))) {
    throw new OpsCrewError("APPROVAL_REFUSED", "The move was not started. Nothing was changed.", {
      hint: `Run \`${RUN_COMMAND}\` again when you are ready.`,
    });
  }

  const retarget: Retarget = {
    from: {
      target: from,
      deploy: plan.deploy,
      ...(plan.app.build === undefined ? {} : { build: plan.app.build }),
    },
    step: "started",
    startedAt: deps.clock.now().toISOString(),
  };
  // The old server's address goes to the local state, never into opscrew/plan.yaml.
  await recordMoveServers(deps, session.servers);
  await saveMove(session, retarget, {
    target,
    cost: chosen.cost,
    app: { ...plan.app, build: next.build },
    deploy: next.deploy,
  });
  deps.reporter.success(
    `Started the move of ${plan.app.name} to ${fresh.name} (${chosen.id}); opscrew/plan.yaml records each step.`,
  );
  await auditStep(
    session,
    "started",
    `move from ${from.provider} (${from.serverType} in ${from.location}) to ${to} (${target.serverType} in ${target.location}), option ${chosen.id}`,
  );
  return session;
}
