import { join } from "node:path";
import { exists, formatMoney, listText, normalizeHostName, OpsCrewError } from "@opscrew/core";
import { usesTunnel } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type AppBuild,
  type CloudDeployTarget,
  type DeployPlan,
  type DeployTarget,
  type DesignOption,
  isServerlessProvider,
  monitoringOf,
  monitoringServerName,
  type ProjectFacts,
  type Retarget,
  readArtifact,
  servicesOn,
  targetArch,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { buildDesignOptions } from "../design";
import { chooseBuilder } from "../design/builder";
import { buildOwnServerOption, noServerCost } from "../design/own";
import { deployStrategyFor, ROLLING_NOTE } from "../design/strategy";
import { commandFlags } from "../environments/choice";
import { recordOwnServerAnswers } from "../interview/own-server";
import { recordPortainerAnswers } from "../interview/portainer";
import { providerProfile, vpsConnector } from "../providers";
import { providerBucket, readRequirements, requireStorageKey } from "../provision";
import {
  boundHostAdapter,
  designOptionLine,
  hasState,
  readPortainerConnection,
  readServerAddresses,
  restoreOldConnection,
  type ServerAddress,
  serverAddress,
  setAsideOldConnection,
} from "../shared";
import { connectAndInspectOwnServer, ownServerFacts } from "../shared/own-server";
import { extraServers, hasExtraServers } from "../shared/servers";
import { endMoveServers, startMoveServers } from "./servers";
import { auditStep, type MoveSession, openSession, saveMove, userRecords } from "./session";
import { cloudProviders, moveSide, placeWords, sideWords } from "./sides";
import type { SideVolume } from "./sides/types";
import {
  ABORT_COMMAND,
  downtimeUntilDnsChange,
  emptyLoses,
  FINISH_COMMAND,
  managedDns,
  manualSwitchDowntime,
  RUN_COMMAND,
  sizeText,
  untilSwitched,
  windowMinutes,
} from "./texts";
import type { MoveData, MoveTargetId, RetargetOptions, RetargetSummary } from "./types";

function nothingLive(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${plan.app.name} has no live deployment on this computer, so there is nothing to move. Nothing was changed.`,
    {
      hint: plan.deployment.destroyedAt
        ? "The deployment was torn down. Run `opscrew design` for the target you want, then `opscrew provision`."
        : "Run `opscrew provision` to deploy the app first (or run OpsCrew on the computer that provisioned it).",
    },
  );
}

/**
 * An app with services on other servers (`plan.servers`) is not moved yet: moving its app server
 * beside them comes in a later step of this feature. Said before any check or change.
 */
function splitAppNoMove(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${plan.app.name} runs services on other servers too (${listText(extraServers(plan))}), and moving an app with several servers to another provider comes with retarget anywhere. Nothing was changed.`,
    {
      hint: "Until then the app stays where it is. To move it now, place its services back on the app's server first: remove `server` from those services and the servers from `servers` in opscrew/plan.yaml, run `opscrew design` and `opscrew provision`, then run `opscrew retarget`.",
    },
  );
}

/**
 * An app with self-hosted monitoring on is not moved yet (FR-2026): its agents, its stack and the
 * monitoring server's network move later. Said before any check or change, with the commands that
 * turn it off.
 */
async function monitoringNoMove(deps: PhaseDeps, plan: DeployPlan): Promise<OpsCrewError> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Self-hosted monitoring is on for ${plan.app.name}, and moving an app with self-hosted monitoring to another provider comes with retarget anywhere. Nothing was changed.`,
    {
      hint: `Turn it off first: run \`opscrew addon disable monitoring${flag}\` and then \`opscrew provision${flag}\`, then run \`opscrew retarget${flag}\` again. Turn monitoring on again once the move is finished.`,
    },
  );
}

/** This computer is no side of a move (spec: `env remove`, then `env add`). */
function thisComputerNoMove(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "This computer runs a copy of the app for trying changes, not a deployment to move, so OpsCrew does not move an app to or from it. Nothing was changed.",
    {
      hint: "Remove that environment with `opscrew env remove <name>` and add one for the target you want with `opscrew env add <name>`.",
    },
  );
}

/** A site and a server are different designs: no move between them. */
function siteServerNoMove(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Moving ${plan.app.name} between a site host and a server changes the app's whole design, so OpsCrew does not do it as a move. Nothing was changed.`,
    {
      hint: "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
    },
  );
}

/**
 * The plain stop for a side that would need a Cloudflare Tunnel, or Portainer behind the user's
 * own proxy with Cloudflare DNS: a move switches between address records only (FR-2301, plan.md
 * "4.").
 */
function addressOnly(side: string, why: string, hint: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${side} ${why}, and a move switches the app's DNS between address records only: switching to or from that needs two changes with an outage between them, which OpsCrew does not do yet. Nothing was changed.`,
    { hint },
  );
}

/** Stops before any change when the old side serves the app other than at a public address. */
function requireAddressedOldSide(plan: DeployPlan): void {
  const from = plan.target;
  const words = `Your app on ${placeWords(from)}`;
  if (from.provider === "own" && from.access === "tunnel") {
    throw addressOnly(
      words,
      "is served through a Cloudflare Tunnel",
      "To move it now, serve it on the server's public address first (answer that the internet reaches your server in `opscrew interview`, then run `opscrew design` and `opscrew provision`), then run `opscrew retarget` again.",
    );
  }
  if (from.provider === "portainer") {
    if (from.web.mode === "tunnel" || from.redeploy === "cloudflare") {
      throw addressOnly(
        words,
        "is reached through a Cloudflare Tunnel",
        "To move it now, serve it with the stack's Caddy and the updater first (`opscrew interview`, `opscrew design` and `opscrew provision`), then run `opscrew retarget` again.",
      );
    }
    if (from.web.mode === "proxy" && managedDns(plan)) {
      throw addressOnly(
        words,
        "is served behind your own proxy with its DNS on Cloudflare",
        "To move it now, serve it with the stack's Caddy first (`opscrew interview`, `opscrew design` and `opscrew provision`), then run `opscrew retarget` again.",
      );
    }
  }
  if (usesTunnel(plan)) {
    throw addressOnly(
      words,
      "has Portainer or Beszel's hub on a subdomain, through a Cloudflare Tunnel",
      "Turn them off first (`opscrew portainer disable`, `opscrew addon disable beszel`) or reach them over the private network, move the app, then turn them on again.",
    );
  }
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

/** The new cloud target from the chosen option, with the provider's default image and the old proxy. */
export function targetOf(option: DesignOption, edge: CloudDeployTarget["edge"]): CloudDeployTarget {
  const { provider } = option.target;
  if (provider !== "hetzner" && provider !== "digitalocean") {
    throw new OpsCrewError("INTERNAL", `A cloud provider's options include ${provider}.`, {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
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

/** How the traffic reaches the new side at the switch, in one sentence. */
function switchSentence(plan: DeployPlan, fresh: string): string {
  const domain = plan.dns.domain;
  if (managedDns(plan) && domain !== undefined) {
    return `Switch the Cloudflare DNS records of ${domain} to ${fresh} and check the app through its domain.`;
  }
  if (domain !== undefined) {
    return `You change the DNS records of ${domain} to ${fresh} (OpsCrew shows them), then OpsCrew checks the app through its domain.`;
  }
  return `Your app moves to ${fresh}'s address (OpsCrew shows it), then OpsCrew checks it there.`;
}

/** What a move sets on the new side: its target and cost, the builder and deploy strategy. */
interface NewSide {
  target: DeployTarget;
  cost: DeployPlan["cost"];
  build: AppBuild;
  deploy: DeployPlan["deploy"];
  /** The new side's address when the move knows it from the start (a Portainer host's). */
  address?: ServerAddress;
}

/**
 * The image builder for the new side's architecture (`chooseBuilder`), as design picks it. Stops
 * with `INVALID_INPUT` when the plan's builder cannot build there, and with `PHASE_PRECONDITION`
 * when the builder needs a Dockerfile (`app.dockerfile`) the repository lacks.
 */
async function builderFor(
  deps: PhaseDeps,
  facts: ProjectFacts,
  plan: DeployPlan,
  arch: "amd64" | "arm64",
): Promise<AppBuild> {
  const choice = chooseBuilder(facts, plan, arch);
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
      "The new side's builder needs a Dockerfile this repository lacks: run `opscrew design` and `opscrew adapt` first. Nothing was changed.",
    );
  }
  for (const warning of choice.warnings) deps.reporter.warn(deps.redactor.redact(warning));
  const { builder, chosen, reason, runtime, probe, automatic } = choice;
  return { builder, chosen, reason, runtime, probe, automatic };
}

/** The builder and strategy lines of the summary that differ from the plan's, with reasons. */
function buildChanges(plan: DeployPlan, next: NewSide): string[] {
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

/** The old side's proxy, which a new server runs too. */
function oldEdge(plan: DeployPlan): CloudDeployTarget["edge"] {
  const from = plan.target;
  return "edge" in from ? from.edge : "caddy";
}

/**
 * A cloud provider's options in the plan's region and budget, priced as `opscrew design` prices
 * them (without its provider-switch guard), and the choice.
 */
async function cloudSide(
  deps: PhaseDeps,
  input: { plan: DeployPlan; facts: ProjectFacts; to: CloudDeployTarget["provider"] },
  options: RetargetOptions,
): Promise<NewSide> {
  const { plan, facts, to } = input;
  const requirements = await requireRequirements(deps);
  const services = options.services ?? {};
  deps.reporter.step(`Pricing ${providerProfile(to).displayName} options for ${plan.app.name}`);
  const catalog =
    services.catalogs?.[to] ?? vpsConnector(to, deps, { now: () => deps.clock.now() }).catalog();
  const edge = oldEdge(plan);
  const designOptions = await buildDesignOptions({
    facts,
    requirements: { ...requirements, provider: to },
    catalog,
    now: deps.clock.now(),
    // The new server runs the same proxy, whose memory the sizing counts.
    edge,
  });
  for (const option of designOptions) deps.reporter.info(designOptionLine(option));
  const chosen = await pickOption(designOptions, options);
  return {
    target: targetOf(chosen, edge),
    cost: chosen.cost,
    build: await builderFor(
      deps,
      facts,
      plan,
      chosen.target.architecture === "arm" ? "arm64" : "amd64",
    ),
    deploy: { ...deployStrategyFor(chosen), drainSeconds: plan.deploy.drainSeconds },
  };
}

/** `opscrew/requirements.yaml`, which a cloud provider's options are priced for. */
async function requireRequirements(deps: PhaseDeps) {
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
  return requirements;
}

/** The stop when the new side's answers are missing. */
function answersMissing(what: string, questions: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew needs the answers about ${what} to move the app there. Nothing was changed.`,
    {
      hint: `Run \`${RUN_COMMAND} --to ${questions}\` in a terminal to answer them, or give them with --answers.`,
    },
  );
}

/**
 * The user's own server as the new side: its answers (public, served directly), recorded in the
 * usual slot, then connected (its host key confirmed, or `--host-key`) and inspected read-only for
 * its architecture. Stops before any change on a tunnel and on the same server as the old side.
 */
async function ownServerSide(
  deps: PhaseDeps,
  input: { plan: DeployPlan; facts: ProjectFacts; fromOwn?: { host: string; port: number } },
  options: RetargetOptions,
): Promise<NewSide> {
  const { plan, facts, fromOwn } = input;
  const answers = options.ownServer;
  if (answers === undefined) throw answersMissing("your new server", "own");
  if (!answers.reachable || answers.serve === "tunnel") {
    throw addressOnly(
      "Your new server",
      "would serve the app through a Cloudflare Tunnel",
      "Answer that the internet reaches the server, and serve the app directly (server.serve dns-only or proxy), then run the move again.",
    );
  }
  if (
    fromOwn !== undefined &&
    normalizeHostName(fromOwn.host) === normalizeHostName(answers.host) &&
    fromOwn.port === answers.port
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} already runs on that server, so there is nothing to move. Nothing was changed.`,
      { hint: `Run \`${RUN_COMMAND} --to own\` with another server's answers.` },
    );
  }
  await recordOwnServerAnswers(deps.paths, answers);
  const own = options.services?.own ?? {};
  const { facts: host } = await connectAndInspectOwnServer(deps, {
    hostKey: options.hostKey,
    services: { ...own, host: boundHostAdapter(own.host) },
    phase: "retarget",
    detail: "the new side of a move",
  });
  if (host.arch !== "amd64" && host.arch !== "arm64") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your new server's processor (${host.arch}) is not one OpsCrew builds images for (amd64 or arm64). Nothing was changed.`,
      { hint: `Choose another server, then run \`${RUN_COMMAND} --to own\` again.` },
    );
  }
  // Its memory and free disk, as design checks a server of the user's for the app.
  const { warnings } = await buildOwnServerOption({
    facts,
    requirements: await requireRequirements(deps),
    catalog: vpsConnector("own", deps, { ownServer: ownServerFacts(host) }).catalog(),
    access: "public",
    edge: oldEdge(plan),
  });
  if (warnings.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your new server is too small for ${plan.app.name}: ${warnings.join(" ")} Nothing was changed.`,
      {
        hint: `Choose a bigger server, or free memory or disk on it, then run \`${RUN_COMMAND} --to own\` again.`,
      },
    );
  }
  const now = deps.clock.now().toISOString();
  return {
    target: {
      provider: "own",
      mode: "vps-compose",
      arch: host.arch,
      access: "public",
      edge: oldEdge(plan),
    },
    cost: noServerCost("Your own server (you already pay for it)", plan.cost.monthly.currency, now),
    build: await builderFor(deps, facts, plan, host.arch),
    deploy: plan.deploy,
  };
}

/**
 * The user's Portainer as the new side: its answers (web mode `caddy` with the updater; with the
 * app's DNS on Cloudflare OpsCrew manages its records there, `records: true`) recorded in the
 * usual slot, and the public address its Caddy serves the app on. Stops before any change on a
 * tunnel or the user's own proxy with Cloudflare DNS.
 */
async function portainerSide(
  deps: PhaseDeps,
  input: { plan: DeployPlan; facts: ProjectFacts },
  options: RetargetOptions,
): Promise<NewSide> {
  const { plan, facts } = input;
  const answers = options.portainer;
  if (answers === undefined) throw answersMissing("your Portainer", "portainer");
  const words = "Your Portainer";
  if (answers.web.mode === "tunnel" || answers.redeploy === "cloudflare") {
    throw addressOnly(
      words,
      "would reach the app through a Cloudflare Tunnel",
      "Answer web mode caddy and the updater for Portainer (portainer.web caddy, portainer.redeploy updater), then run the move again.",
    );
  }
  if (answers.web.mode === "proxy" && managedDns(plan)) {
    throw addressOnly(
      words,
      "would serve the app behind your own proxy with its DNS on Cloudflare",
      "Answer web mode caddy for Portainer (portainer.web caddy), then run the move again.",
    );
  }
  const address = options.portainerAddress;
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew needs the public address of your Portainer host, where its Caddy serves the app and the app's DNS records point. Nothing was changed.",
      {
        hint: `Run \`${RUN_COMMAND} --to portainer\` in a terminal to give it, or with --portainer-address <ipv4[,ipv6]>.`,
      },
    );
  }
  // Portainer runs the image the old side runs, built for that side's processor.
  const arch = targetArch(plan.target);
  if (answers.arch !== arch) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your Portainer environment runs on ${answers.arch}, but the app's image is built for ${arch}, and a move to Portainer deploys the image the app runs now. Nothing was changed.`,
      {
        hint: `Move the app to a server of ${answers.arch} first (\`${RUN_COMMAND} --to <hetzner|digitalocean|own>\`), or run \`opscrew design\` and \`opscrew provision\` to build it for ${answers.arch}, then move it to your Portainer.`,
      },
    );
  }
  await recordPortainerAnswers(deps.paths, answers);
  const web =
    answers.web.mode === "caddy" && managedDns(plan)
      ? { ...answers.web, records: true }
      : answers.web;
  return {
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: answers.environmentId,
      arch: answers.arch,
      redeploy: answers.redeploy,
      web,
    },
    cost: noServerCost(
      "Your Portainer (you already run it)",
      plan.cost.monthly.currency,
      deps.clock.now().toISOString(),
    ),
    build: await builderFor(deps, facts, plan, answers.arch),
    deploy: plan.deploy,
    address,
  };
}

/** The new side's target in words with its details, for the summary's first line. */
function targetLine(target: DeployTarget, which: "old" | "new"): string {
  if (target.provider === "hetzner" || target.provider === "digitalocean") {
    return `${providerProfile(target.provider).displayName} (${target.serverType} in ${target.location})`;
  }
  return sideWords(target, which);
}

/** The summary shown before the first change. */
export function moveSummary(
  plan: DeployPlan,
  next: Pick<NewSide, "target" | "cost">,
  data: MoveData[],
  changes: string[],
  portainer: boolean,
): RetargetSummary {
  const from = plan.target;
  const to = next.target;
  const old = sideWords(from, "old");
  const fresh = sideWords(to, "new");
  const copies = data.some((mount) => mount.copy);
  const bytes = data.filter((mount) => mount.copy).reduce((sum, mount) => sum + mount.bytes, 0);
  const minutes = copies ? windowMinutes(bytes, portainer) : undefined;
  // Without managed DNS the old app stays stopped until the user's own switch has taken effect.
  const offline = downtimeUntilDnsChange(plan, copies)
    ? `; the app stays offline from then ${untilSwitched(plan)}`
    : "";
  const cloudOld = from.provider === "hetzner" || from.provider === "digitalocean";
  const prepare =
    to.provider === "hetzner" || to.provider === "digitalocean"
      ? `Create ${fresh} (${to.serverType} in ${to.location}) next to ${old}.`
      : to.provider === "own"
        ? `Set up ${fresh} for the app with a host plan you approve by its hash, beside any other apps there.`
        : "Check your Portainer environment for the app's stacks.";
  const deploy =
    to.provider === "portainer"
      ? `Point the GitHub deploy secrets at ${fresh}, set up the app's stacks there with the version ${old} runs (a stack plan you approve by its hash) and check the app; the stack's Caddy stays stopped until the switch.`
      : `Point the GitHub deploy secrets at ${fresh}, run the deploy workflow on ${plan.cicd.branch} and check the app there; its web server stays stopped until the switch.`;
  return {
    from,
    to,
    steps: [
      cloudOld
        ? `Rename ${old} in OpsCrew's infrastructure state (nothing changes in your cloud).`
        : `Keep ${old} as it is: nothing in OpsCrew's infrastructure state is renamed.`,
      prepare,
      deploy,
      copies
        ? `Maintenance window (about ${minutes} minutes for ${sizeText(bytes)}): stop the app on ${old}, copy its data to ${fresh} and start the app there${offline}.`
        : "No maintenance window: there is no data to copy.",
      switchSentence(plan, fresh),
      `Keep ${old} (with its app stopped) until you run \`${FINISH_COMMAND}\`; until the switch, \`${ABORT_COMMAND}\` undoes the move.`,
    ],
    extraMonthly: next.cost.monthly,
    data,
    ...(minutes !== undefined ? { expectedDowntimeMinutes: minutes } : {}),
    changes,
  };
}

/** A data mount in words, for the summary. */
function dataLine(plan: DeployPlan, mount: MoveData): string {
  const what = `${mount.owner === "app" ? "The app's" : `${mount.owner}'s`} data at ${mount.key}: ${sizeText(mount.bytes)}`;
  return mount.copy ? `${what}, copied` : `${what}, starts empty. ${emptyLoses(plan, mount.owner)}`;
}

function summaryText(summary: RetargetSummary, plan: DeployPlan): string {
  const old = sideWords(summary.from, "old");
  const copies = summary.data.some((mount) => mount.copy);
  const free = summary.extraMonthly.amount === 0;
  return [
    `Moving ${plan.app.name} from ${targetLine(summary.from, "old")} to ${targetLine(summary.to, "new")}:`,
    ...summary.steps.map((step, i) => `  ${i + 1}. ${step}`),
    free
      ? `Extra cost: none for ${sideWords(summary.to, "new")}${summary.from.provider === "hetzner" || summary.from.provider === "digitalocean" ? `; ${old} is billed until the move is finished` : ""}.`
      : `Extra cost while both run: ${formatMoney(summary.extraMonthly)} per month for ${sideWords(summary.to, "new")}${summary.from.provider === "hetzner" || summary.from.provider === "digitalocean" ? `; ${old} is billed until the move is finished` : ""}.`,
    ...(summary.data.length === 0
      ? [`Data: none on ${old}, so the app stays online until the switch.`]
      : [
          `Data on ${old} (OpsCrew read these sizes with a small read-only container there):`,
          ...summary.data.map((mount) => `  - ${dataLine(plan, mount)}`),
          ...(copies
            ? downtimeUntilDnsChange(plan, true)
              ? [
                  `Expected downtime: about ${summary.expectedDowntimeMinutes} minutes for the copy, plus the time ${plan.dns.domain !== undefined ? "your DNS change takes to reach your users" : "your users take to switch to the new address"}.`,
                  ...manualSwitchDowntime(plan, true),
                ]
              : [`Expected maintenance window: about ${summary.expectedDowntimeMinutes} minutes.`]
            : []),
        ]),
    ...bucketLines(plan),
    ...(summary.changes.length === 0
      ? []
      : [
          `On ${sideWords(summary.to, "new")} (opscrew/plan.yaml records it, and the final files use it):`,
          ...summary.changes.map((change) => `  - ${change}`),
        ]),
    `While the move runs, ${plan.infra.dir} holds a transitional version of the infrastructure files; \`${FINISH_COMMAND}\` publishes the final ones in a pull request.`,
  ].join("\n");
}

/** What happens to the app's bucket at a provider, for the summary (it stays where it is). */
function bucketLines(plan: DeployPlan): string[] {
  const bucket = providerBucket(plan);
  if (bucket === undefined) return [];
  return [
    `Bucket: ${bucket.bucket} stays where it is; the app on the new side keeps using it with the same key.`,
  ];
}

/**
 * The owners of data that start empty: `--empty`, each checked, and for each other owner of data
 * the answer to `chooseEmpty` in a terminal (copy is the default). Stops before any change on a
 * name that is no service of the app's server, `app` or `monitoring` there.
 */
async function emptyChoices(
  deps: PhaseDeps,
  plan: DeployPlan,
  volumes: readonly SideVolume[],
  options: Pick<RetargetOptions, "empty" | "chooseEmpty">,
): Promise<string[]> {
  const names = servicesOn(plan, APP_SERVER).map((service) => service.name);
  const allowed = new Set([
    ...names,
    "app",
    ...(monitoringServerName(plan) === APP_SERVER ? ["monitoring"] : []),
  ]);
  const given = [...new Set(options.empty ?? [])];
  const unknown = given.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--empty ${listText(unknown)}: no service of the app's server is named so. Nothing was changed.`,
      {
        hint: `Name a service on the app's server${names.length > 0 ? ` (${listText(names)})` : ""}, or app for the app's own files.`,
      },
    );
  }
  const empty = new Set(given);
  if (deps.interactive && options.chooseEmpty !== undefined) {
    const owners = [...new Set(volumes.map((volume) => volume.owner))].filter(
      (owner) => !empty.has(owner),
    );
    for (const owner of owners) {
      const bytes = volumes
        .filter((volume) => volume.owner === owner)
        .reduce((sum, volume) => sum + volume.bytes, 0);
      const copy = await options.chooseEmpty({ owner, bytes, loses: emptyLoses(plan, owner) });
      if (!copy) empty.add(owner);
    }
  }
  return [...empty];
}

/**
 * The old side's address and whether it runs the app: a server's from OpsCrew's local state (else
 * the infrastructure state's outputs), the user's Portainer's stacks from its record. Stops with
 * {@link nothingLive}.
 */
async function liveOldSide(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<ServerAddress | undefined> {
  if (plan.deployment.destroyedAt !== undefined) throw nothingLive(plan);
  if (plan.target.provider === "portainer") {
    const connection = await readPortainerConnection(deps.paths);
    if (connection === undefined || connection.created.stacks.length === 0) throw nothingLive(plan);
    return (await readServerAddresses(deps.paths)).deployment;
  }
  // A server OpsCrew created lives in the infrastructure state; the user's own server is live
  // where OpsCrew recorded its address.
  const cloud = plan.target.provider !== "own";
  if (cloud && !(await hasState(deps.paths))) throw nothingLive(plan);
  const address = cloud
    ? await serverAddress(deps, plan, {
        engine: options.services?.engine,
        ...(options.engine !== undefined ? { preference: options.engine } : {}),
      })
    : (await readServerAddresses(deps.paths)).deployment;
  if (address === undefined) throw nothingLive(plan);
  return address;
}

/** The new target the move goes to: `--to`, else the requirements' provider. */
async function newTargetId(deps: PhaseDeps, options: RetargetOptions): Promise<MoveTargetId> {
  if (options.to !== undefined) return options.to;
  const { provider } = await requireRequirements(deps);
  if (provider === "localhost") throw thisComputerNoMove();
  if (isServerlessProvider(provider)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/requirements.yaml asks for a site host, and an app with a server does not move to one. Nothing was changed.",
      {
        hint: `Run \`${RUN_COMMAND} --to <hetzner|digitalocean|own|portainer>\`, or \`opscrew destroy\`, then \`opscrew interview\`, \`opscrew design\` and \`opscrew provision\` for the site host.`,
      },
    );
  }
  return provider;
}

/**
 * Step 1 of a move (plan.md "2." started): every refusal of plan.md "4." and the spec's edge cases
 * before any change (this computer, a site and a server, previews, a tunnel or Portainer behind the
 * user's own proxy with Cloudflare DNS on either side, two Portainers, the same place, public SSH
 * closed, Edge Agent environments, an app that cannot be built for the new side); the new side
 * (a cloud provider's options and the choice, the user's own server inspected, or the user's
 * Portainer reached); the old side's data mounts and their sizes, copied or started empty
 * (`--empty`, or a question for each); the summary and `confirmStart`; then the move is recorded
 * (`plan.target` and `cost` are the new side's, `retarget.step` is `started`, `retarget.empty`
 * what starts empty). The old side's connection is set aside at the start (`retarget.fromOwn` or
 * `fromPortainer`) so the new side's takes its slot; any stop before the record puts it back.
 */
export async function startMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<MoveSession> {
  const from = plan.target;
  if (from.provider === "localhost") throw thisComputerNoMove();
  if (isServerlessProvider(from.provider)) throw siteServerNoMove(plan);
  // Not yet: an app with self-hosted monitoring on (FR-2026), said before the extra servers (its
  // monitoring server may be one), nor one with services on other servers (FR-1820).
  if (monitoringOf(plan) !== undefined) throw await monitoringNoMove(deps, plan);
  if (hasExtraServers(plan)) throw splitAppNoMove(plan);
  // A side over SSH is reached at its public address before it joins the app's private network.
  if (plan.network?.publicSsh === false) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Public SSH is closed, and a move reaches the servers over public SSH before they join the app's private network. Nothing was changed.",
      {
        hint: "Open public SSH first (`opscrew secure --open-public-ssh`), move the app, then close it again with `opscrew secure --close-public-ssh`.",
      },
    );
  }
  requireAddressedOldSide(plan);
  const oldAddress = await liveOldSide(deps, plan, options);
  // The bucket stays where it is: the app on the new side needs its key, known before any change.
  if (providerBucket(plan) !== undefined) {
    await requireStorageKey(deps, plan, options.services ?? {}, { command: RUN_COMMAND });
  }
  const to = await newTargetId(deps, options);
  if (to === from.provider) {
    if (to === "portainer") throw betweenPortainers();
    if (to !== "own") {
      const name = providerProfile(to).displayName;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${plan.app.name} already runs on ${name}, so there is nothing to move. Moves within one provider (another location or size) are not supported yet. Nothing was changed.`,
        {
          hint: `Run \`${RUN_COMMAND} --to <target>\` with another target, or change the provider with \`opscrew interview\` first.`,
        },
      );
    }
  }
  const facts = (await readArtifact("architecture", deps.paths.files.architecture)).facts;
  const services = options.services ?? {};
  const fromOwn = from.provider === "own" ? (await readServerAddresses(deps.paths)).own : undefined;

  // From here the old side's connection is set aside, and the new side's takes its slot: a stop
  // before the move is recorded puts it back, so nothing is changed.
  await setAsideOldConnection(deps.paths, from.provider);
  let started: { session: MoveSession; next: NewSide; empty: string[] };
  try {
    const next =
      to === "own"
        ? await ownServerSide(
            deps,
            { plan, facts, ...(fromOwn !== undefined ? { fromOwn } : {}) },
            options,
          )
        : to === "portainer"
          ? await portainerSide(deps, { plan, facts }, options)
          : await cloudSide(deps, { plan, facts, to }, options);
    const retarget: Retarget = {
      from: {
        target: plan.target,
        deploy: plan.deploy,
        ...(plan.app.build === undefined ? {} : { build: plan.app.build }),
      },
      step: "started",
      empty: [],
      startedAt: deps.clock.now().toISOString(),
    };
    // The move's plan, recorded only once the summary is confirmed.
    const moving: DeployPlan = {
      ...plan,
      target: next.target,
      cost: next.cost,
      app: { ...plan.app, build: next.build },
      deploy: next.deploy,
      retarget,
    };
    // A Portainer old side's address is where the user's records on Cloudflare point.
    const fromAddress = oldAddress ?? (await userRecords(deps, moving, services))?.address;
    const session = await openSession(deps, moving, {
      command: RUN_COMMAND,
      providers: cloudProviders({ plan: moving }),
      services,
      servers: {
        ...(fromAddress !== undefined ? { from: fromAddress } : {}),
        ...(next.address !== undefined ? { next: next.address } : {}),
      },
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
    });
    const old = moveSide(session, "old");
    const fresh = moveSide(session, "new");
    // An Edge Agent environment is refused when Portainer is reached (either side), before any
    // change.
    if (fresh.kind === "portainer") await (await fresh.docker(session)).close();
    deps.reporter.step(`Measuring the app's data on ${sideWords(plan.target, "old")}`);
    const volumes = await old.volumes(session);
    const empty = await emptyChoices(deps, plan, volumes, options);
    const data: MoveData[] = volumes.map((volume) => ({
      owner: volume.owner,
      key: volume.key,
      bytes: volume.bytes,
      copy: !empty.includes(volume.owner),
    }));
    const summary = moveSummary(
      plan,
      next,
      data,
      buildChanges(plan, next),
      old.kind === "portainer" || fresh.kind === "portainer",
    );
    deps.reporter.info(summaryText(summary, plan));
    if (options.confirmStart !== undefined && !(await options.confirmStart(summary))) {
      throw new OpsCrewError("APPROVAL_REFUSED", "The move was not started. Nothing was changed.", {
        hint: `Run \`${RUN_COMMAND}\` again when you are ready.`,
      });
    }
    // The sides' addresses go to the local state, never into opscrew/plan.yaml.
    await startMoveServers(deps, session.servers);
    await saveMove(session, { ...retarget, empty });
    started = { session, next, empty };
  } catch (error) {
    // Nothing of the move stays: the old side's connection back in its slot, no move record.
    await restoreOldConnection(deps.paths, { from: from.provider, to });
    await endMoveServers(deps, undefined);
    throw error;
  }
  const { session, next, empty } = started;
  deps.reporter.success(
    `Started the move of ${plan.app.name} to ${placeWords(next.target)}; opscrew/plan.yaml records each step.`,
  );
  await auditStep(
    session,
    "started",
    `move from ${from.provider} to ${next.target.provider}${empty.length > 0 ? `, starting empty: ${empty.join(", ")}` : ""}`,
  );
  return session;
}

/** The plain stop for a move from one Portainer environment to another, before any change. */
function betweenPortainers(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Moving an app between two Portainer environments isn't possible yet: the app has one deploy branch and one Portainer token. Nothing was changed.",
    {
      hint: "Move the app to a server first, then into the other environment; or remove it with `opscrew destroy` and set it up there with `opscrew provision`.",
    },
  );
}
