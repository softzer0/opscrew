/**
 * The rotation of services' generated secrets that runs from this computer through Docker (025
 * plan.md 4.), shared by the user's Portainer (`./portainer`) and this computer (`./localhost`). It
 * keeps the order of the servers' `rotate.sh` (plan 3.): each service's `begin` in its running
 * container (the values only in the command's environment), the new values where the app reads
 * them and the app switched to them, then each service's `finish`. One plan approved by its hash
 * (`remote-exec`). The values are the server path's: made by `newRotationValues`, kept in the
 * environment's unfinished rotation (`./values-pending`, with this path's progress) until it is
 * done (`completePendingRotation`) or undone, so a run again goes on after the last unit done
 * with the same values and hash.
 *
 * The hash and the approval's text are this path's own: the servers' (`./plan`) bind each
 * server's `rotate.sh` and GitHub's secrets, which neither target has, and name its steps.
 */
import type { ApprovalRecord } from "@opscrew/contracts";
import { canonicalJson, listText, OpsCrewError, sha256Hex, upperFirst } from "@opscrew/core";
import {
  hasLogin,
  type RotationCommand,
  type RotationStep,
  type SecretRotation,
  serviceSpec,
} from "@opscrew/iac-templates";
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { requestApproval } from "../shared/approvals";
import { continued } from "../shared/errors";
import {
  type AppValues,
  appConsequence,
  appFingerprints,
  appSecretLines,
  appSecretNames,
  appSuccessNote,
  isAppName,
  newAppValues,
  serviceFingerprints,
} from "./app-values";
import { rotationContext, SWITCH_SECONDS, startsMatch, undoHash } from "./plan";
import { assertValuesCurrent } from "./record";
import { completePendingRotation, newRotationValues, recordedGeneration } from "./values";
import {
  ADDON_ROTATION_HASH,
  beganElsewhere,
  dropPendingRotation,
  forgetPlannedRotation,
  keepPendingRotation,
  nothingToUndo,
  type PendingRotation,
  type RotationValues,
  readPendingRotation,
  rotateCommand,
  sameNames,
  unfinishedRotation,
  type ValuePair,
} from "./values-pending";

/** Where a rotation through Docker runs: the user's Portainer, or this computer's Docker. */
export type DockerTarget = "portainer" | "localhost";

/** One secret rotation of a service, from the catalog, with its commands and its values. */
export interface ServiceStep {
  service: PlanService;
  /** The service's kind in plain text (`PostgreSQL`). */
  title: string;
  rotation: SecretRotation;
  begin: readonly RotationStep[];
  finish: readonly RotationStep[];
  /** The commands that undo it where its swapped `begin` and `finish` would not. */
  undo?: readonly RotationStep[];
  /** `OPSCREW_OLD` and `OPSCREW_NEW`: its one secret's values, both empty for several secrets. */
  values: ValuePair;
  /** False for a service that is off: only its kept values change, nothing runs in it. */
  runs: boolean;
}

/** What a rotation through Docker does on its target; each call but `check` is one unit. */
export interface DockerRotationTarget {
  target: DockerTarget;
  /** Where it runs, after "the services": `in your Portainer`, `on this computer`. */
  where: string;
  /** The plan's line on how the new values reach the app and its services. */
  valuesText: string;
  /**
   * Stops before the approval when the target can't take the rotation of `hash` (with what to
   * do); also before an undo.
   */
  check(steps: readonly ServiceStep[], values: RotationValues, hash: string): Promise<void>;
  /**
   * Runs the rotation's (or its undo's) units under the target's own lock or pause; `rotation`
   * is the command that goes on and the rotation's hash.
   */
  locked<T>(fn: () => Promise<T>, rotation: { command: string; hash: string }): Promise<T>;
  /**
   * The command and entrypoint the running container of `service` started with; `undefined` when
   * none runs.
   */
  startCommand(
    service: string,
  ): Promise<{ command?: readonly string[]; entrypoint?: readonly string[] } | undefined>;
  /** Runs `command` in the running container of `service`, the values only in its environment. */
  exec(service: string, command: RotationCommand, values: ValuePair): Promise<number>;
  /** Holds the app's deploys on the target for the rotation of `hash` (this computer). */
  hold?(hash: string): Promise<void>;
  /** Releases this rotation's hold. */
  release?(hash: string): Promise<void>;
  /**
   * A `restart` step's service created again with its new value (this computer); without it a
   * `restart` step has no unit of its own and changes with the app's switch (Portainer).
   */
  restart?(step: ServiceStep, values: RotationValues): Promise<void>;
  /** The values `which` in place where the app and its services read them. */
  writeValues(which: keyof ValuePair, values: RotationValues): Promise<void>;
  /**
   * Records `generation` as the one of `service`'s values that its snapshots name (T2514, as
   * `rotate.sh` does on a server): the new one once its data logs in with the new value, the old
   * one again once an undo puts the old value back (this computer).
   */
  generation?(service: string, generation: number): Promise<void>;
  /**
   * The app (and every service whose step recreates it) switched to the values in place: the new
   * ones under the rotation's `approval`, the old ones (an undo) without one.
   */
  switchApp(which: keyof ValuePair, approval?: ApprovalRecord): Promise<void>;
  /**
   * Plans, shows and keeps what the app's switch to the new values applies (Portainer's stack
   * plan, bound to them), before the approval: its hash is bound into the rotation's
   * (`boundHash(identity, hash)`, `identity` the hash of the rotation's own plan). `untouched`: the
   * switch has not begun, so what it applies must hold nothing else than the rotation's values.
   */
  prepare?(
    values: RotationValues,
    identity: string,
    untouched: boolean,
  ): Promise<{ hash: string; what: string }>;
}

/** A finished rotation. */
export interface DockerRotation {
  /** The hash the rotation was approved by. */
  hash: string;
  /** The recovery copy, refreshed with the new values: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** An undone rotation. */
export interface DockerUndo {
  /** The hash of the rotation undone. */
  hash: string;
  undone: true;
}

/** What {@link rotateThroughDocker} is given besides the target. */
export interface DockerRotationOptions {
  /** `--undo`: puts the old values back, before the old ones began to be dropped. */
  undo?: boolean;
}

// --- The plan -----------------------------------------------------------------------------------

/**
 * The services `names` of `plan`, refused before anything is made when a name is not a service
 * with a login and generated secrets.
 */
function servicesNamed(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  names: readonly string[],
): PlanService[] {
  const refuse = (message: string) =>
    new OpsCrewError("INVALID_INPUT", `${message} Nothing was changed.`, {
      hint: "Run `opscrew rotate` to list what it can rotate.",
    });
  if (names.length === 0) throw refuse("No service was named to rotate.");
  return names.map((name) => {
    const service = plan.services.find((s) => s.name === name);
    if (service === undefined || serviceSpec(service.kind).secrets.length === 0) {
      throw refuse(
        `${name} is not a service of the ${deps.paths.environment} environment with generated secrets.`,
      );
    }
    if (!hasLogin(service))
      throw refuse(`${name} has no login (019), so it has nothing to rotate.`);
    return service;
  });
}

/** The steps of `services` with `values`, in the catalog's order. */
function stepsOf(
  plan: DeployPlan,
  services: readonly PlanService[],
  values: RotationValues,
): ServiceStep[] {
  return services.flatMap((service) => {
    const spec = serviceSpec(service.kind);
    const ctx = rotationContext(plan, service);
    const kept = values.services[service.name] ?? {};
    return spec.rotation.secrets.map((rotation): ServiceStep => {
      const [only, ...more] = rotation.secrets;
      const pair = only === undefined ? undefined : kept[only];
      return {
        service,
        title: spec.title,
        rotation,
        begin: rotation.begin(ctx),
        finish: rotation.finish(ctx),
        ...(rotation.undo !== undefined ? { undo: rotation.undo(ctx) } : {}),
        values: more.length > 0 || pair === undefined ? { old: "", new: "" } : pair,
        runs: service.enabled,
      };
    });
  });
}

/** How the step rotates, in the plan's words. */
function stepText(step: ServiceStep, target: DockerTarget): string {
  const head = `${step.service.name} (${step.title}, ${step.rotation.secrets.join(" and ")})`;
  if (!step.runs) return `${head}: off, so only the values this computer keeps change.`;
  const seconds = (step.rotation.seconds ?? 0) + SWITCH_SECONDS;
  // In Portainer the stack's env names every service's values, so the stack plan's apply creates
  // each service again (this computer's Compose creates only the app and the `recreate` ones).
  const recreated = `created again with its new value when the stack plan applies, about ${seconds} seconds; its open connections close`;
  if (target === "portainer") {
    switch (step.rotation.mode) {
      case "dual":
        return `${head}: it accepts the old and the new value until then, and is ${recreated}.`;
      case "swap":
        return `${head}: a short swap; new connections the running app opens to it fail from its change until it is ${recreated}.`;
      case "restart":
        return `${head}: ${recreated}, and it answers no one meanwhile.`;
    }
  }
  switch (step.rotation.mode) {
    case "dual":
      return `${head}: seamless; it accepts the old and the new value until the app runs on the new one${step.rotation.recreate ? ` (it is created again with the new value meanwhile, about ${seconds} seconds)` : ""}.`;
    case "swap":
      return `${head}: a short swap; new connections the running app opens to it fail for about ${seconds} seconds, until the app runs on the new value${step.rotation.closesConnections === true ? ", and its open connections close and reconnect" : "; open connections stay"}.`;
    case "restart":
      return `${head}: a restart with the new value; it answers no one for about ${seconds} seconds, until the app runs on the new value.`;
  }
}

/** The plan's own hash: where it runs, what runs, and the old and new values by fingerprints. */
function planHash(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  target: DockerTarget,
  values: RotationValues,
  steps: readonly ServiceStep[],
): string {
  return sha256Hex(
    canonicalJson({
      rotation: "services",
      target,
      environment: deps.paths.environment,
      app: plan.app.name,
      services: values.names,
      values: serviceFingerprints(values.services),
      steps: steps.map((step) => ({
        service: step.service.name,
        secrets: [...step.rotation.secrets],
        mode: step.rotation.mode,
        recreate: step.rotation.recreate,
        runs: step.runs,
        begin: step.begin,
        finish: step.finish,
        undo: step.undo ?? null,
      })),
      ...(values.app === undefined ? {} : { appValues: appFingerprints(values.app) }),
    }),
  );
}

/** The rotation's hash: its plan's, with the hash of the stack plan its switch applies bound in. */
export function boundHash(identity: string, stack: string | undefined): string {
  return stack === undefined ? identity : sha256Hex(canonicalJson({ rotation: identity, stack }));
}

// --- The units ----------------------------------------------------------------------------------

/** One unit of the rotation, done once. */
interface Unit {
  /** What it does, for the reporter and a failure. */
  what: string;
  run(): Promise<void>;
}

/** A unit of the undo, run once the rotation's units done reached `after`. */
interface UndoUnit extends Unit {
  after: number;
  /** The service whose data it changes back, if one. */
  service?: string;
}

/** One of a step's commands, as its conditions allow (a failed check is no failure). */
async function runCommand(
  target: DockerRotationTarget,
  step: ServiceStep,
  command: RotationStep,
  swapped: boolean,
): Promise<void> {
  const values = swapped ? { old: step.values.new, new: step.values.old } : step.values;
  const exec = (words: RotationCommand) => target.exec(step.service.name, words, values);
  let words: RotationCommand;
  if ("run" in command) {
    for (const check of command.when ?? []) if ((await exec(check)) !== 0) return;
    for (const check of command.unless ?? []) if ((await exec(check)) === 0) return;
    words = command.run;
  } else {
    words = command;
  }
  const exitCode = await exec(words);
  if (exitCode === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `A command of ${step.service.name}'s rotation exited with code ${exitCode} in its container ${target.where} (its output is not shown: it can quote a value).`,
    { hint: `Check that ${step.service.name} runs and is healthy ${target.where}.` },
  );
}

/**
 * The rotation's units in rotate.sh's order, its undo's units, `switching` (the app's switch) and
 * `limit`: the unit once done an old value may be gone, so undo is refused.
 */
function rotationUnits(
  target: DockerRotationTarget,
  steps: readonly ServiceStep[],
  values: RotationValues,
  hash: string,
  approval?: ApprovalRecord,
  generations?: ReadonlyMap<string, number>,
) {
  const units: Unit[] = [];
  const runs = steps.filter((step) => step.runs);
  const { hold } = target;
  if (hold !== undefined) units.push({ what: "holding the app's deploys", run: () => hold(hash) });
  /** Each running step's begin units, in its commands' order. */
  const begun = new Map<ServiceStep, number[]>();
  /** The first unit that changes a container, which the switch back changes again. */
  let firstChange: number | undefined;
  /** Each `restart` step's unit. */
  const restarted = new Map<ServiceStep, number>();
  for (const step of runs) {
    if (step.rotation.mode === "restart") {
      const { restart } = target;
      if (restart === undefined) continue;
      firstChange ??= units.length;
      restarted.set(step, units.length);
      units.push({
        what: `restarting ${step.service.name} with its new value`,
        run: () => restart(step, values),
      });
      continue;
    }
    const mine = step.begin.map((command) => {
      units.push({
        what: `changing ${step.service.name} to its new value`,
        run: () => runCommand(target, step, command, false),
      });
      return units.length - 1;
    });
    if (mine.length > 0) begun.set(step, mine);
  }
  const written = units.length;
  units.push({ what: "writing the new values", run: () => target.writeValues("new", values) });
  const switching = units.length;
  units.push({
    what: "switching the app to the new values",
    run: () => target.switchApp("new", approval),
  });
  const limit = units.length;
  units.push({ what: "starting to drop the old values", run: async () => {} });
  for (const step of runs) {
    for (const command of step.finish) {
      units.push({
        what: `dropping the old value of ${step.service.name}`,
        run: () => runCommand(target, step, command, false),
      });
    }
  }

  const reversed = [...runs].reverse();
  const undo: UndoUnit[] = [
    {
      what: "putting the old values back",
      after: 0,
      run: () => target.writeValues("old", values),
    },
    // Each `begin` command that may have run, again with the values swapped, the last first.
    ...reversed.flatMap((step): UndoUnit[] =>
      step.undo !== undefined
        ? []
        : (begun.get(step) ?? [])
            .map((unit, i) => ({
              what: `changing ${step.service.name} back to its old value`,
              after: unit,
              run: () => runCommand(target, step, step.begin[i] as RotationStep, true),
              service: step.service.name,
            }))
            .reverse(),
    ),
    {
      what: "switching the app back to the old values",
      after: Math.min(firstChange ?? switching, switching),
      run: () => target.switchApp("old"),
    },
    // Once the app runs on the old values: each begun step's `finish` swapped, or its own undo.
    ...reversed.flatMap((step): UndoUnit[] => {
      const start = begun.get(step)?.[0];
      if (start === undefined) return [];
      return (step.undo ?? step.finish).map((command) => ({
        what:
          step.undo === undefined
            ? `dropping the new value of ${step.service.name}`
            : `undoing the change of ${step.service.name}`,
        after: start,
        run: () => runCommand(target, step, command, step.undo === undefined),
        service: step.service.name,
      }));
    }),
  ];
  if (target.generation !== undefined && generations !== undefined) {
    recordGenerations(target, runs, generations, { units, undo, begun, restarted, written });
  }
  return { units, undo, limit, switching };
}

/**
 * Adds to `units` and `undo` the generations `target` records (T2514), as `rotate.sh` does: a
 * service's next one once its data logs in with the new value (after its last `begin`, after its
 * restart, with the new values written for a `dual` one created again or one without `begin`), its
 * previous one with the last undo unit that changes its data back (with the old values written for
 * one no `begin` changed).
 */
function recordGenerations(
  target: DockerRotationTarget,
  runs: readonly ServiceStep[],
  generations: ReadonlyMap<string, number>,
  at: {
    units: Unit[];
    undo: UndoUnit[];
    begun: ReadonlyMap<ServiceStep, number[]>;
    restarted: ReadonlyMap<ServiceStep, number>;
    written: number;
  },
): void {
  const record = target.generation as NonNullable<DockerRotationTarget["generation"]>;
  const then = (unit: Unit | undefined, service: string, generation: number) => {
    if (unit === undefined) return;
    const run = unit.run;
    unit.run = async () => {
      await run();
      await record(service, generation);
    };
  };
  const forward = new Map<string, number>();
  for (const step of runs) {
    const unit =
      at.restarted.get(step) ??
      (step.rotation.mode === "dual" && step.rotation.recreate
        ? at.written
        : at.begun.get(step)?.at(-1)) ??
      at.written;
    const name = step.service.name;
    forward.set(name, Math.max(forward.get(name) ?? 0, unit));
  }
  for (const [service, unit] of forward) {
    const next = generations.get(service);
    if (next === undefined) continue;
    then(at.units[unit], service, next);
    const back = at.undo.findLast((each) => each.service === service) ?? at.undo[0];
    then(back, service, next - 1);
  }
}

// --- The run ------------------------------------------------------------------------------------

/**
 * Rotates the generated secrets of the services `names` of `plan`'s environment through `target`,
 * and the app's own secrets they name (`app`, `app:<NAME>`, `./app-values`: no step of their own,
 * the new values written and the app's switch).
 * An unfinished rotation of the same services goes on with its values (one only planned is
 * replaced by a rotation of others); the two-computer guard; new values (`newRotationValues`),
 * registered with the redactor; the target's checks; what the switch applies planned (Portainer's
 * stack plan) and its hash bound into the rotation's; the rotation kept as planned; the plan shown
 * and approved by its hash (`remote-exec`, `--approve <hash>` in a script); then, under the
 * target's lock or pause, its units, each recorded once done: the hold, each service's `begin` (a
 * `restart` service's own restart on this computer), the new values written, the app's switch,
 * each `finish`. Then the hold released, the new values made the services' own and the rotation
 * forgotten (`completePendingRotation`), the rotation recorded and the recovery copy refreshed. A
 * failure says the unit and how to go on or undo. With `options.undo`: a rotation never approved is
 * forgotten; one approved is undone after its own approval, before any old value was dropped.
 * @throws OpsCrewError `INVALID_INPUT` or `PHASE_PRECONDITION` before anything changes;
 * `APPROVAL_REFUSED` when the plan is not approved; the failed unit's error, saying how to go on.
 */
export async function rotateThroughDocker(
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  target: DockerRotationTarget,
  options: DockerRotationOptions = {},
): Promise<DockerRotation | DockerUndo> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const serviceNames = names.filter((name) => !isAppName(name));
  const appNames = names.filter(isAppName);
  const services =
    serviceNames.length === 0 && appNames.length > 0 ? [] : servicesNamed(deps, plan, serviceNames);
  // The app's own secrets, as `app:<NAME>` (`app` names each), after the services.
  const appSecrets = appNames.length === 0 ? [] : await appSecretNames(deps, plan, appNames);
  const named = [...services.map((service) => service.name), ...appSecrets];
  const again = rotateCommand(named, flags);
  const existing = await readPendingRotation(deps);
  const same = existing !== undefined && sameNames(existing.names, named);
  // An add-on's rotation (`monitoring`, `beszel`) is another rotation, whatever its name.
  const addon = existing?.hash === ADDON_ROTATION_HASH;
  const reused = same && !addon ? existing : undefined;
  // A rotation only planned changed nothing yet: one of other services replaces it, but never an
  // add-on's of the same name, which this command could not finish.
  if (existing !== undefined && (existing.step !== "planned" || (addon && same))) {
    if (reused === undefined) throw unfinishedRotation(existing, environment, flags);
    if (existing.target !== target.target) throw beganElsewhere(existing, target.target, again);
  }
  const began = reused !== undefined && reused.step !== "planned" ? reused : undefined;
  if (options.undo === true) {
    if (reused === undefined) throw nothingToUndo(named, environment);
    if (began === undefined) {
      await forgetPlannedRotation(deps, reused.names);
      return { hash: reused.hash, undone: true };
    }
    return undoRotation(deps, target, began, stepsOf(plan, services, began), again);
  }
  if (began?.undone !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Undoing the rotation of ${listText(began.names)} in ${environment} is unfinished, so OpsCrew does not rotate them again yet. Nothing was changed.`,
      { hint: `Run \`${again} --undo\` to finish the undo first.` },
    );
  }
  await assertValuesCurrent(deps);
  // A rotation planned before (shown, not approved) keeps its values, so its hash stays the same.
  const values: RotationValues = reused ?? {
    ...(await newRotationValues(deps, services)),
    names: named,
    ...(appSecrets.length === 0 ? {} : { app: await newAppValues(deps, plan, appSecrets) }),
  };
  const steps = stepsOf(plan, services, values);
  const identity = planHash(deps, plan, target.target, values, steps);
  if (began !== undefined && began.hash !== boundHash(identity, began.stackPlanHash)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The plan of the unfinished rotation of ${listText(began.names)} changed since it was approved (as ${began.hash}), so OpsCrew does not go on with it. Nothing was changed.`,
      {
        hint: `Put the plan back as it was, then run \`${again}\` to finish it or \`${again} --undo\` to put the old values back.`,
      },
    );
  }
  await target.check(steps, values, began?.hash ?? identity);
  await requireCurrentStart(target, plan, steps, { again, flags, begun: began !== undefined });
  // What the switch applies, planned now and bound into the hash, unless the switch is done.
  const done = began?.done ?? 0;
  const { switching } = rotationUnits(target, steps, values, identity);
  const stack =
    began !== undefined && done > switching
      ? began.stackPlanHash === undefined
        ? undefined
        : { hash: began.stackPlanHash, what: "" }
      : await target.prepare?.(values, identity, done < switching);
  const hash = boundHash(identity, stack?.hash);
  // A rotation not begun is kept before the approval, so a run approved by the hash shown reuses
  // the same values; one that began keeps the hash it began with until its new one is approved.
  const pending: PendingRotation = {
    names: values.names,
    services: values.services,
    ...(values.app === undefined ? {} : { app: values.app }),
    hash,
    step: began?.step ?? "planned",
    target: target.target,
    ...(stack === undefined ? {} : { stackPlanHash: stack.hash }),
    done,
  };
  if (began === undefined) await keepPendingRotation(deps, pending);
  const approval = await approve(deps, plan, target, steps, {
    hash,
    again,
    names: values.names,
    app: values.app,
    resumed: done > 0,
    ...(stack === undefined ? {} : { stack }),
  });
  const started: PendingRotation = {
    ...pending,
    step: pending.step === "planned" ? "started" : pending.step,
  };
  await keepPendingRotation(deps, started);
  return target.locked(() => runRotation(deps, plan, target, started, steps, { again, approval }), {
    command: again,
    hash,
  });
}

/**
 * Refuses, before anything changes, a service a step runs commands in that does not run on the
 * target (the commands run in its container) while the rotation has not `begun` (one that began
 * goes on, and its switch starts the service again; provision refuses while it is unfinished), or
 * whose container still runs another start command than the catalog's (one from before 025, or a
 * plan change not deployed yet): only the catalog's start writes the container file of its current
 * value, which the rotation's commands read and rewrite. `again` goes on, `flags` are the commands'.
 * @throws OpsCrewError `PHASE_PRECONDITION` saying that a deploy starts it, or that provision puts
 * it on the new start command.
 */
async function requireCurrentStart(
  target: DockerRotationTarget,
  plan: DeployPlan,
  steps: readonly ServiceStep[],
  run: { again: string; flags: string; begun: boolean },
): Promise<void> {
  const { again, flags, begun } = run;
  const services = [
    ...new Set(
      steps
        .filter((step) => step.runs && step.begin.length + step.finish.length > 0)
        .map((step) => step.service),
    ),
  ];
  for (const service of services) {
    const running = await target.startCommand(service.name);
    if (running === undefined) {
      if (begun) continue;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${service.name} (${serviceSpec(service.kind).title}) is not running ${target.where}, so OpsCrew can't change its value. Nothing was changed.`,
        {
          hint: `Start it with a deploy (\`opscrew provision${flags}\`), then run \`${again}\` again.`,
        },
      );
    }
    if (startsMatch(plan, service, running)) continue;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${service.name} ${target.where} still runs on a start command from before this version of OpsCrew (or one the plan changed since it was last deployed), so its container has no file of its current value for the rotation to change. Nothing was changed.`,
      {
        hint: `Run \`opscrew provision${flags}\` first: it creates ${service.name} again on the plan's start command. Then run the command again.`,
      },
    );
  }
}

/** Shows the plan and asks its approval, bound to its hash. */
async function approve(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: DockerRotationTarget,
  steps: readonly ServiceStep[],
  input: {
    hash: string;
    again: string;
    /** The credentials, by the names `opscrew rotate` takes. */
    names: readonly string[];
    /** The app's own secrets that change (`./app-values`). */
    app: AppValues | undefined;
    resumed: boolean;
    /** What the switch applies under this approval, planned and shown before it. */
    stack?: { hash: string; what: string };
  },
): Promise<ApprovalRecord> {
  const { hash, again, stack, app } = input;
  const services = [...new Set(steps.map((step) => step.service.name))];
  const secrets = appSecretLines(app);
  const credentials = [...input.names];
  const consequence = appConsequence(plan, app);
  const resumed = input.resumed
    ? " (this rotation began earlier: it goes on after its last step done, with the same values)"
    : "";
  const actions = [
    ...(services.length === 0
      ? []
      : [
          `Each service's new value is made valid in its running container through Docker's exec ${target.where}, the values only in the command's environment, never on its command line.`,
        ]),
    `${target.valuesText}${stack === undefined || stack.what === "" ? "" : ` ${stack.what}`}`,
    ...(services.length === 0
      ? []
      : ["Once the app runs on the new values, each service's old value is dropped."]),
  ];
  const details = [
    ...(consequence === undefined ? [] : [consequence.line]),
    `New values made on this computer replace ${services.length === 0 ? "" : `the generated secrets of ${listText(services)}${secrets.length === 0 ? "" : " and "}`}${secrets.length === 0 ? "" : "the app's own secrets"} in the ${deps.paths.environment} environment ${target.where}${resumed}:`,
    ...steps.map((step) => `  ${stepText(step, target.target)}`),
    ...secrets.map((line) => `  ${line}`),
    ...actions.map((line, i) => `${i + 1}. ${line}`),
    services.length === 0
      ? `If a step fails, the old and new values stay on this computer: \`${again}\` goes on from that step, and \`${again} --undo\` puts the old values back.`
      : `If a step fails, the old and new values stay on this computer: \`${again}\` goes on from that step, and before step ${actions.length} \`${again} --undo\` puts the old values back.`,
    `Rotation hash: ${hash}`,
  ].join("\n");
  return requestApproval(deps, {
    title: `Rotate the ${secrets.length === 0 ? "passwords" : "credentials"} of ${listText(credentials)} in ${deps.paths.environment}`,
    details,
    hash,
    guard: consequence?.guard,
    refused: {
      plan: `rotation of ${listText(credentials)}`,
      unchanged: `Nothing ${target.where} was changed.`,
      again,
    },
  });
}

/** Audits a moment of the rotation `hash` by its credentials' names. */
function audit(
  deps: Pick<PhaseDeps, "audit" | "paths">,
  target: DockerRotationTarget,
  pending: Pick<PendingRotation, "names">,
  hash: string,
  action: string,
  decision: "approved" | "refused",
): Promise<void> {
  return deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action,
    target: `${deps.paths.environment} ${target.target}`,
    decision,
    detail: `rotation ${hash} of ${pending.names.join(", ")}`,
  });
}

/** Each of the services `names`' generation once rotated: the record's, one more (T2514). */
async function nextGenerations(
  deps: PhaseDeps,
  names: readonly string[],
): Promise<Map<string, number>> {
  const generation = await recordedGeneration(deps);
  return new Map(names.map((name) => [name, generation(name) + 1]));
}

/** The units from the first one not done, each recorded once done; then the end. */
async function runRotation(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: DockerRotationTarget,
  pending: PendingRotation,
  steps: readonly ServiceStep[],
  input: { again: string; approval: ApprovalRecord },
): Promise<DockerRotation> {
  const { again, approval } = input;
  const { hash } = pending;
  const { units, limit } = rotationUnits(
    target,
    steps,
    pending,
    hash,
    approval,
    await nextGenerations(deps, pending.names),
  );
  let done = pending.done ?? 0;
  await audit(
    deps,
    target,
    pending,
    hash,
    done === 0 ? "rotation started" : "rotation resumed",
    "approved",
  );
  for (const unit of units.slice(done)) {
    deps.reporter.step(`${upperFirst(unit.what)} ${target.where}`);
    try {
      await unit.run();
    } catch (error) {
      await audit(deps, target, pending, hash, `rotation stopped while ${unit.what}`, "refused");
      throw stopped(error, unit.what, done <= limit ? `${again} --undo` : undefined, again);
    }
    done += 1;
    // Once an old value may be gone, the rotation only goes forward.
    await keepPendingRotation(deps, {
      ...pending,
      done,
      step: done > limit ? "switched" : pending.step,
    });
  }
  await target.release?.(hash);
  await completePendingRotation(deps, plan, pending);
  await audit(deps, target, pending, hash, "rotation finished", "approved");
  deps.reporter.success(
    `Rotated the generated secrets of ${listText(pending.names)} ${target.where}: the app runs on the new values, and the old ones no longer work.${appSuccessNote(pending.app)}`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan) };
}

/** Puts the old values back, once approved, before any old value was dropped. */
async function undoRotation(
  deps: PhaseDeps,
  target: DockerRotationTarget,
  pending: PendingRotation,
  steps: readonly ServiceStep[],
  again: string,
): Promise<DockerUndo> {
  const { hash } = pending;
  const { undo, limit } = rotationUnits(
    target,
    steps,
    pending,
    hash,
    undefined,
    await nextGenerations(deps, pending.names),
  );
  const done = pending.done ?? 0;
  if (pending.step === "switched" || done > limit) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The rotation of ${listText(pending.names)} has begun to drop the old values, so it can no longer be undone. Nothing was changed.`,
      { hint: `Run \`${again}\` to finish it.` },
    );
  }
  await target.check(steps, pending, hash);
  const undoing = undoHash(hash);
  await requestApproval(deps, {
    title: `Put back the old values of ${listText(pending.names)} in ${deps.paths.environment}`,
    details: [
      `The rotation ${hash} stopped before it dropped any old value. Undoing it puts the old values back ${target.where}: where the app and its services read them, in each service that took its new value, and in the app, which switches back to them.`,
      `Undo hash: ${undoing}`,
    ].join("\n"),
    hash: undoing,
    refused: {
      plan: `undo of the rotation of ${listText(pending.names)}`,
      unchanged: `Nothing ${target.where} was changed.`,
      again: `${again} --undo`,
    },
  });
  return target.locked(
    async () => {
      let undone = pending.undone ?? 0;
      await keepPendingRotation(deps, { ...pending, undone });
      for (const unit of undo.slice(undone)) {
        // A unit of the rotation may have run (in part) once the units before it were done.
        if (done >= unit.after) {
          deps.reporter.step(`${upperFirst(unit.what)} ${target.where}`);
          try {
            await unit.run();
          } catch (error) {
            await audit(deps, target, pending, hash, `undo stopped while ${unit.what}`, "refused");
            throw stopped(error, unit.what, undefined, `${again} --undo`, true);
          }
        }
        undone += 1;
        await keepPendingRotation(deps, { ...pending, undone });
      }
      await target.release?.(hash);
      await dropPendingRotation(deps);
      await audit(deps, target, pending, hash, "rotation undone", "approved");
      deps.reporter.success(
        `Put the old values of ${listText(pending.names)} back ${target.where}: the app runs on them as before the rotation.`,
      );
      return { hash, undone: true as const };
    },
    { command: `${again} --undo`, hash },
  );
}

/**
 * `error` with where the rotation stopped and the way on: `again`, or `undo` (a command) while it
 * may still be undone; `undoing` for a stopped undo, whose `again` finishes it.
 */
function stopped(
  error: unknown,
  what: string,
  undo: string | undefined,
  again: string,
  undoing = false,
): unknown {
  return continued(error, {
    said: `${undoing ? "Undoing the rotation" : "The rotation"} stopped while ${what}; the old and new values stay on this computer.`,
    next: undoing
      ? `Then run \`${again}\` again to finish the undo.`
      : undo === undefined
        ? `Then run \`${again}\` again to finish it: it has begun to drop the old values, so it can no longer be undone.`
        : `Then run \`${again}\` again to go on from this step, or \`${undo}\` to put the old values back.`,
  });
}
