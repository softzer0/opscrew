import { OpsCrewError } from "@opscrew/core";
import {
  type CloudDeployTarget,
  type DeployPlan,
  type DesignOption,
  type Retarget,
  readArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { buildDesignOptions, formatMoney, priceLabel } from "../design";
import {
  cloudTarget,
  ownServerNotYet,
  providerProfile,
  requestedProvider,
  vpsConnector,
} from "../providers";
import { readRequirements } from "../provision";
import { serverAddress } from "../shared";
import { databaseSize } from "./server-ops";
import { recordMoveServers } from "./servers";
import {
  auditStep,
  type MoveSession,
  openSession,
  pinHost,
  redactWith,
  remoteFor,
  saveMove,
  stateExists,
} from "./session";
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

/** The new target from the chosen option, with the provider's default image. */
function targetOf(option: DesignOption): CloudDeployTarget {
  const { provider } = option.target;
  if (provider === "own") throw ownServerNotYet();
  return {
    provider,
    mode: "vps-compose",
    location: option.target.location,
    serverType: option.target.serverType,
    image: providerProfile(option.target.provider).defaultImage,
    backups: option.backups,
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

/** The summary shown before the first change. */
export function moveSummary(
  plan: DeployPlan,
  to: CloudDeployTarget,
  option: DesignOption,
  databaseBytes: number | undefined,
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
  };
}

function summaryText(summary: RetargetSummary, plan: DeployPlan): string {
  const old = providerWords(summary.from.provider);
  const fresh = providerWords(summary.to.provider);
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
  const address =
    plan.deployment.destroyedAt === undefined && (await stateExists(deps))
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
  const from = cloudTarget(plan.target);
  const to = options.to ?? requestedProvider(requirements);
  if (to === "own") throw ownServerNotYet();
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
  });
  for (const option of designOptions) {
    const marks = [
      option.fitsBudget ? "fits the budget" : "over budget",
      ...(option.recommended ? ["recommended"] : []),
    ];
    deps.reporter.info(
      `${option.title} (${option.id}): ${formatMoney(option.cost.monthly)}/month, ${priceLabel(option.cost)} — ${marks.join(", ")}`,
    );
  }
  const chosen = await pickOption(designOptions, options);
  const target = targetOf(chosen);

  // What it means: database size (over SSH to the old server) and the summary.
  const oldHost = address.ipv4;
  let databaseBytes: number | undefined;
  if (plan.services.postgres) {
    await pinHost(session, oldHost, from.provider);
    deps.reporter.step("Measuring the database on the old server");
    const old = remoteFor(deps, services, session.deployKey.privateKeyFile, oldHost);
    databaseBytes = await databaseSize(old, redactWith(deps));
  }
  const summary = moveSummary(plan, target, chosen, databaseBytes);
  deps.reporter.info(summaryText(summary, plan));
  if (options.confirmStart !== undefined && !(await options.confirmStart(summary))) {
    throw new OpsCrewError("APPROVAL_REFUSED", "The move was not started. Nothing was changed.", {
      hint: `Run \`${RUN_COMMAND}\` again when you are ready.`,
    });
  }

  const retarget: Retarget = {
    from: { target: from },
    step: "started",
    startedAt: deps.clock.now().toISOString(),
  };
  // The old server's address goes to the local state, never into opscrew/plan.yaml.
  await recordMoveServers(deps, session.servers);
  await saveMove(session, retarget, { target, cost: chosen.cost });
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
