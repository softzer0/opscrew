/**
 * A rotation of services' credentials as a plan (025 plan.md 2.–3., FR-2502, FR-2503): each
 * secret's step from the catalog's recipe in the order `rotate.sh` runs it, the run on each server
 * (on an extra server its `begin` before the app's server's whole run and its `finish` after, split
 * placement), what each step costs the running app, and the hash its approval is bound to.
 */
import { canonicalJson, listText, sha256Hex, toPosixRelative } from "@opscrew/core";
import {
  type RotateStep,
  renderRotateScript,
  type SecretRotation,
  type ServiceContext,
  serviceSpec,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, type PlanService } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { SecretPlace } from "../provision/secrets";
import { APPROVAL_SECONDS } from "../rollback/database";
import { PlanRefusedError } from "../shared/approvals";
import { serverWords } from "../shared/server-address";
import { extraServers, hasExtraServers } from "../shared/servers";
import { credentialsRecordFile } from "./record";
import type { RotationValues } from "./values-pending";

/**
 * About how long the app's switch to the new values takes, which a swap's or a restart's window
 * adds to the service's own seconds (plan, Decisions 2).
 */
const SWITCH_SECONDS = 30;

/** One secret's rotation on its server: the catalog's recipe as `rotate.sh` runs it. */
export interface ServiceStep {
  service: PlanService;
  /** `app`, or the extra server the service runs on. */
  server: string;
  /** The recipe: its secrets, mode, seconds and whether the service is created again. */
  rotation: SecretRotation;
  /** The step `rotate.sh` runs. */
  step: RotateStep;
}

/**
 * The context the catalog renders `service`'s start command and rotation steps with, as for a
 * rendered file: no secret, since a value reaches the container only as its env.
 */
export function rotationContext(plan: DeployPlan, service: PlanService): ServiceContext {
  return {
    plan,
    service,
    secretRef: (name) => {
      throw new Error(`${service.name}'s secret ${name} cannot appear in a rotation's step`);
    },
  };
}

/**
 * The steps of the running ones of `services` (an off service changes on this computer only), in
 * their order, each service's in its recipe's order.
 * @throws OpsCrewError where a recipe refuses the service (Garage's key without a bucket).
 */
export function serviceSteps(plan: DeployPlan, services: readonly PlanService[]): ServiceStep[] {
  return services
    .filter((service) => service.enabled)
    .flatMap((service) => {
      const ctx = rotationContext(plan, service);
      return serviceSpec(service.kind).rotation.secrets.map((rotation) => ({
        service,
        server: service.server ?? APP_SERVER,
        rotation,
        step: {
          service: service.name,
          envFile: `${service.name}.env`,
          mode: rotation.mode,
          begin: rotation.begin(ctx),
          finish: rotation.finish(ctx),
          recreate: rotation.recreate,
          ...(rotation.undo === undefined ? {} : { undo: rotation.undo(ctx) }),
        },
      }));
    });
}

/** The old and the new value `rotate.sh` gets for `step`: none for a step of several secrets. */
export function stepValues(
  step: ServiceStep,
  values: RotationValues,
): { old: string; new: string } {
  const [secret, ...more] = step.rotation.secrets;
  const pair = secret === undefined ? undefined : values.services[step.service.name]?.[secret];
  return more.length > 0 || pair === undefined ? { old: "", new: "" } : pair;
}

/** One server's part of a rotation: its steps and its `rotate.sh`. */
export interface ServerRun {
  /** `app`, or an extra server's name. */
  server: string;
  steps: ServiceStep[];
  /** The script, rendered for this server and these steps; it holds no value. */
  script: string;
}

/**
 * The servers a rotation of `steps` runs on: the app's server (its settings change with every
 * service's), then each extra server with a step, in the plan's order. None without a step.
 */
export function serverRuns(plan: DeployPlan, steps: readonly ServiceStep[]): ServerRun[] {
  if (steps.length === 0) return [];
  return [APP_SERVER, ...extraServers(plan)]
    .map((server) => ({ server, steps: steps.filter((step) => step.server === server) }))
    .filter((run) => run.server === APP_SERVER || run.steps.length > 0)
    .map((run) => ({
      ...run,
      script: `${renderRotateScript(
        plan,
        run.steps.map((step) => step.step),
        run.server,
      ).join("\n")}\n`,
    }));
}

/** What a rotation's approval names and its hash binds. */
export interface RotationPlan {
  /** The services rotated, by plan name, in the plan's order. */
  services: readonly PlanService[];
  values: RotationValues;
  runs: readonly ServerRun[];
  /** The GitHub secrets replaced. */
  secrets: readonly SecretPlace[];
}

/**
 * The SHA-256 a rotation's approval is bound to: the environment and app, the services, each
 * server's script, the GitHub secrets, and a fingerprint of each old and new value (so each
 * rotation has its own hash, never the values themselves).
 */
export function rotationHash(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  input: RotationPlan,
) {
  return sha256Hex(
    canonicalJson({
      rotation: "services",
      environment: deps.paths.environment,
      app: plan.app.name,
      services: input.services.map((service) => service.name),
      values: Object.entries(input.values.services).map(([service, secrets]) => ({
        service,
        secrets: Object.entries(secrets).map(([secret, pair]) => ({
          secret,
          old: sha256Hex(pair.old),
          new: sha256Hex(pair.new),
        })),
      })),
      servers: input.runs.map((run) => ({ server: run.server, script: sha256Hex(run.script) })),
      secrets: input.secrets,
    }),
  );
}

/** The hash an undo of the rotation `hash` is approved by. */
export function undoHash(hash: string): string {
  return sha256Hex(canonicalJson({ undo: hash }));
}

/** What one step costs the running app, in a sentence. */
function costText(step: ServiceStep): string {
  const { title } = serviceSpec(step.service.kind);
  const { mode, seconds = 0, recreate, closesConnections } = step.rotation;
  const window = seconds + SWITCH_SECONDS;
  switch (mode) {
    case "dual":
      return recreate
        ? `seamless for the app: ${title} restarts with the new value beside the old one (about ${seconds} seconds, answering no one meanwhile), and the old one works until the app runs on the new.`
        : `seamless: ${title} accepts the old and the new value until the app runs on the new one, then only the new one.`;
    case "swap":
      return `a short swap: new connections the running app opens to ${title} fail for about ${window} seconds, from the change until the app's switch; ${closesConnections === true ? `its open connections are closed too, and the app's clients reconnect with the new value after the switch` : "open connections stay"}.`;
    case "restart":
      return `a restart: ${title} restarts with the new value (about ${seconds} seconds, answering no one meanwhile), and new connections the running app opens to it fail until its switch, about ${window} seconds in all.`;
  }
}

/** The lines naming each credential and what its change costs. */
function credentialLines(plan: DeployPlan, input: RotationPlan): string[] {
  const steps = input.runs.flatMap((run) => run.steps);
  return input.services.flatMap((service) => {
    const { title } = serviceSpec(service.kind);
    if (!service.enabled) {
      return [
        `${service.name} (${title}) is off: only the values this computer keeps change, and it starts with the new ones.`,
      ];
    }
    const where = hasExtraServers(plan) ? ` on ${serverWords(service.server ?? APP_SERVER)}` : "";
    return steps
      .filter((step) => step.service.name === service.name)
      .map(
        (step) =>
          `${service.name} (${title})${where}, its ${listText([...step.rotation.secrets])}: ${costText(step)}`,
      );
  });
}

/** `GitHub's secrets A and B (in the GitHub environment E)`. */
function secretsText(secrets: readonly SecretPlace[]): string {
  const environment = secrets.find((place) => place.environment !== undefined)?.environment;
  const names = listText(secrets.map((place) => place.name));
  return `GitHub's secret${secrets.length === 1 ? "" : "s"} ${names}${environment === undefined ? "" : ` (in the GitHub environment ${environment})`}`;
}

/** The app's switch in words, by its deploy strategy. */
function switchText(plan: DeployPlan): string {
  return plan.deploy.strategy === "rolling"
    ? "the app's rolling switch to them with the image that runs (no request fails, nothing is pulled)"
    : "the app restarted with them on the image that runs, as its deploys do (nothing is pulled)";
}

/**
 * Asks the rotation's approval, bound to its hash (`remote-exec`, as 024's restore; `--approve
 * <hash>` in a script), listing each credential and what it costs, then each step in order.
 * @throws PlanRefusedError when it is not given.
 */
export async function approveRotation(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: RotationPlan,
  again: string,
): Promise<string> {
  const hash = rotationHash(deps, plan, input);
  const { environment } = deps.paths;
  const names = listText(input.services.map((service) => service.name));
  const extras = input.runs.filter((run) => run.server !== APP_SERVER);
  const app = input.runs.find((run) => run.server === APP_SERVER);
  const servicesOf = (run: ServerRun) =>
    listText([...new Set(run.steps.map((step) => step.service.name))]);
  const record = toPosixRelative(deps.paths.root, credentialsRecordFile(deps.paths));
  const steps =
    app === undefined
      ? ["No server runs them, so nothing else changes."]
      : [
          `Deploys are paused in GitHub (the repository variable OPSCREW_DEPLOY_PAUSED) until the end, once no deploy runs.`,
          `${secretsText(input.secrets)} ${input.secrets.length === 1 ? "is" : "are"} replaced with the new values, encrypted on this computer before upload.`,
          ...extras.map(
            (run) =>
              `On ${serverWords(run.server)} (rotate.sh begin): deploys held there, and ${servicesOf(run)} ${run.steps.length === 1 ? "gets its" : "get their"} new values and env files.`,
          ),
          `On the app's server (rotate.sh): deploys held there${app.steps.length === 0 ? "" : `, ${servicesOf(app)} changed to the new values`}, the new env files, ${switchText(plan)}, then the old values dropped there.`,
          ...extras.map(
            (run) => `On ${serverWords(run.server)} (rotate.sh finish): the old values dropped.`,
          ),
          `Deploys resume, ${record} records the rotation, and the recovery copy is refreshed.`,
        ].map((line, i) => `${i + 1}. ${line}`);
  const lines = [
    `New values made on this computer replace those of ${names} in ${environment}; neither the old nor the new ones are ever shown.`,
    ...credentialLines(plan, input),
    ...steps,
    ...(app === undefined
      ? []
      : [
          `OpsCrew leaves a one-time approval of each run in the app's folder on its server, valid for ${APPROVAL_SECONDS / 60} minutes. The old values stay on this computer until the rotation is done: if a step fails, \`${again}\` goes on from where it stopped, and \`${again} --undo\` puts the old values back until they are dropped.`,
        ]),
    `Rotation hash: ${hash}`,
  ];
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Rotate the credentials of ${names} in ${environment}`,
    details: lines.join("\n"),
    planHash: hash,
  });
  if (approval.approved) return hash;
  throw new PlanRefusedError({
    plan: `rotation of ${names}`,
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    unchanged: "Nothing on the servers or in GitHub was changed.",
    hint: `Run \`${again}\` again when you are ready (in a script: --approve ${hash}).`,
  });
}

/**
 * Asks the approval of the undo of the rotation `hash` (`remote-exec`, bound to {@link undoHash}):
 * on the app's server first, then each extra server, the old values back, then GitHub's secrets.
 * @throws PlanRefusedError when it is not given.
 */
export async function approveUndo(
  deps: PhaseDeps,
  input: RotationPlan,
  hash: string,
  again: string,
): Promise<string> {
  const undo = undoHash(hash);
  const { environment } = deps.paths;
  const names = listText(input.services.map((service) => service.name));
  const steps =
    input.runs.length === 0
      ? ["No server runs them: the new values are forgotten on this computer."]
      : [
          "Deploys are paused in GitHub (the repository variable OPSCREW_DEPLOY_PAUSED) until the end, once no deploy runs.",
          ...input.runs.map(
            (run) =>
              `On ${serverWords(run.server)} (rotate.sh --undo): the old env files back, ${run.server === APP_SERVER ? "each service's change undone and the app switched back to the old values" : "each service's change undone"}, where the rotation began there.`,
          ),
          `${secretsText(input.secrets)} get the old values back.`,
          "Deploys resume, and the new values are forgotten on this computer.",
        ].map((line, i) => `${i + 1}. ${line}`);
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Put the old values of ${names} back in ${environment}`,
    details: [
      `The rotation ${hash} of ${names} in ${environment} stopped before it finished; its old values come back, and the new ones are dropped.`,
      ...steps,
      `Undo hash: ${undo}`,
    ].join("\n"),
    planHash: undo,
  });
  if (approval.approved) return undo;
  throw new PlanRefusedError({
    plan: `undo of the rotation of ${names}`,
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    unchanged: "Nothing on the servers or in GitHub was changed.",
    hint: `Run \`${again} --undo\` again when you are ready (in a script: --approve ${undo}).`,
  });
}
