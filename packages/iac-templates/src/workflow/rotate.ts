// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { RotationCommand, RotationMode, RotationStep } from "../catalog/types";
import { shellQuote } from "../runtime/services";
import { maskFileScript } from "./index";
import { opscrew, said } from "./shared";
import { SNAPSHOT_GENERATIONS, SNAPSHOTS_DIR } from "./snapshots";
import {
  appFolder,
  approvalExpiry,
  EDGE_FUNCTION,
  heldStop,
  processServices,
  proxyHosts,
  RESTORE_HELD,
  ROTATION_HOLDER,
  readApproval,
  SCRIPT_ROOTS,
  START_LOCK,
  serverWords,
  startProcesses,
  switchApp,
} from "./switch";

/**
 * The rotation's folder in the app's folder on each server it changes (025 plan.md 3.): the
 * one-time approval, the state, the commands' log and the `.previous` env files.
 */
export const ROTATE_DIR = ".rotate";

/**
 * The one-time approval of a `rotate.sh` run, which `opscrew rotate` writes once the user approved
 * the rotation's plan ({@link rotateApprovalLine}); the script reads and removes it before any
 * change.
 */
export const ROTATE_APPROVAL_FILE = `${ROTATE_DIR}/approval`;

/**
 * What a run of `rotate.sh` does: on the app's server `rotate` (the whole rotation) or `undo`; on
 * an extra server `begin` (up to its env files), `finish` (from its `finish` on) or `undo`.
 */
export type RotateAction = "rotate" | "begin" | "finish" | "undo";

/**
 * The line of {@link ROTATE_APPROVAL_FILE}, without its newline: the plan's hash (64 hex digits),
 * the run it approves and the time it expires, in Unix seconds.
 */
export function rotateApprovalLine(hash: string, action: RotateAction, expiresAt: number): string {
  return `${hash} ${action} ${expiresAt}`;
}

/** The output of the commands `rotate.sh` runs, on the server only: it can quote a value. */
export const ROTATE_LOG = `${ROTATE_DIR}/rotate.log`;

/**
 * The state of an unfinished rotation, one line: the plan's hash, the last unit done and the last
 * unit of its undo done.
 */
const STATE = `${ROTATE_DIR}/state`;

/** The hash of the last rotation that finished on the server. */
const FINISHED = `${ROTATE_DIR}/finished`;

/** The app's env file in its folder on the app's server, as the deploy writes it. */
const APP_ENV = "app.env";

/**
 * One secret's rotation on a server, from the catalog's `rotation` of its service (T2503), as
 * `rotate.sh` runs it. Its two values come on the script's stdin ({@link rotateInput}).
 */
export interface RotateStep {
  /** The Compose service it changes. */
  service: string;
  /** The service's env file in the app's folder (`<service>.env`), which its new values change. */
  envFile: string;
  /** The catalog's mode: a `restart` step gets its new env file and is recreated in step 3. */
  mode: RotationMode;
  /** Makes the new value work: `OPSCREW_OLD` is the value the service has, `OPSCREW_NEW` the new. */
  begin: readonly RotationStep[];
  /** Drops the old value once the app runs on the new one. */
  finish: readonly RotationStep[];
  /** True when the service is created again from its new env file before the app's switch. */
  recreate: boolean;
  /**
   * The commands that undo `begin` and `finish` where running them again with the two values
   * swapped does not (Garage's key), after the app's switch back; they see the values swapped too.
   */
  undo?: readonly RotationStep[];
  /**
   * The generation the service's values have once rotated (the rotation record's, one more than
   * now; the same on each step of the service), which {@link SNAPSHOT_GENERATIONS} records once its
   * data logs in with the new value, and the one before once an undo puts the old value back, so a
   * snapshot taken meanwhile names values its data logs in with (025 plan.md 12.). Nothing is
   * recorded without it.
   */
  generation?: number;
}

/**
 * The env files `rotate.sh` on `server` reads from its input, in order: on the app's server the
 * app's first, then each step's once.
 */
export function rotateEnvFiles(
  steps: readonly RotateStep[],
  server: string = APP_SERVER,
): string[] {
  return [
    ...new Set([...(server === APP_SERVER ? [APP_ENV] : []), ...steps.map((s) => s.envFile)]),
  ];
}

/**
 * `rotate.sh`'s stdin on `server`: one line per env file of {@link rotateEnvFiles}, the file's new
 * bytes in base64 (written as they are, as the deploy writes its secret and a newline), then the
 * old and the new value of each step, one line each, in the steps' order (empty for a step that
 * uses none).
 */
export function rotateInput(
  steps: readonly RotateStep[],
  input: {
    envFiles: Readonly<Record<string, string>>;
    values: readonly { old: string; new: string }[];
  },
  server: string = APP_SERVER,
): string {
  if (input.values.length !== steps.length) {
    throw new Error("rotate.sh's input needs the old and the new value of each step.");
  }
  const lines = rotateEnvFiles(steps, server).map((file) => {
    const content = input.envFiles[file];
    if (content === undefined) throw new Error(`rotate.sh's input has no new ${file}.`);
    return Buffer.from(content, "utf8").toString("base64");
  });
  for (const value of input.values) {
    if (value.old.includes("\n") || value.new.includes("\n")) {
      throw new Error("A value of a rotation can't hold a line break.");
    }
    lines.push(value.old, value.new);
  }
  return `${lines.join("\n")}\n`;
}

/** One unit of the rotation, done once: the state records the last one done. */
interface Unit {
  /** Its step of 025 plan.md 3., 1–6, which a failure names. */
  step: number;
  /** What it does, for a failure's message. */
  what: string;
  lines: string[];
}

/** One unit of the undo, run when its `when` (a test of `$rot_done`) holds. */
interface UndoUnit {
  what: string;
  when?: string;
  lines: string[];
  /** The service whose data it changes back, if one. */
  service?: string;
}

/**
 * `command` in the service's container `$rot_c`, with step `n`'s values (`$rot_old_<n>` and
 * `$rot_new_<n>`, `swapped` for an undo) as `OPSCREW_OLD` and `OPSCREW_NEW` only, its output in
 * {@link ROTATE_LOG}: a conditional one runs only when each `when` check succeeds and each `unless`
 * check fails, and a check's outcome is no failure.
 */
export function inContainer(command: RotationStep, n: number, swapped: boolean): string {
  const [old, now] = swapped ? ["new", "old"] : ["old", "new"];
  const exec = (words: RotationCommand) =>
    `OPSCREW_OLD="$rot_${old}_${n}" OPSCREW_NEW="$rot_${now}_${n}" docker exec -e OPSCREW_OLD -e OPSCREW_NEW "$rot_c" ${words.map(shellQuote).join(" ")} < /dev/null >> ${ROTATE_LOG} 2>&1`;
  if (!("run" in command)) return exec(command);
  const checks = [
    ...(command.when ?? []).map(exec),
    ...(command.unless ?? []).map((words) => `! ${exec(words)}`),
  ];
  if (checks.length === 0) return exec(command.run);
  return `if ${checks.join(" && ")}; then ${exec(command.run)}; fi`;
}

/** `services` created again from their env files (`force`: even when those are unchanged). */
function recreate(services: readonly string[], force = false): string {
  return `docker compose up -d --no-deps --wait${force ? " --force-recreate" : ""} ${services.join(" ")} >> ${ROTATE_LOG} 2>&1`;
}

/**
 * Grafana Alloy's masking file rewritten from the env files in place on `server`
 * ({@link maskFileScript}, run in the app's folder); nothing where Alloy masks no log line.
 */
function maskRewrite(plan: DeployPlan, server: string): string[] {
  const script = maskFileScript(plan, server, ".");
  return script === "" ? [] : [`bash -c ${shellQuote(script)} >> ${ROTATE_LOG} 2>&1`];
}

/**
 * The app's switch to the env files in place (`values`: which they hold) with the image that runs
 * (`.env`'s, as the deploy records it; nothing is pulled): the deploy's own switch by
 * `deploy.strategy` ({@link switchApp}, its EXIT trap also calling `rot_exit`), then the workers and
 * cron created again from the new `app.env`, each of which must keep running
 * ({@link startProcesses}). The services never move.
 */
function appSwitch(plan: DeployPlan, values: "new" | "old"): string[] {
  const kept =
    plan.deploy.strategy === "rolling"
      ? "so OpsCrew removed it, and the copy that ran keeps serving"
      : "so OpsCrew removed it, and the app is not serving now";
  return [
    "APP_IMAGE=\"$(sed -n 's/^APP_IMAGE=//p' .env)\"",
    "export APP_IMAGE",
    ...switchApp(
      plan,
      proxyHosts(plan, undefined),
      [
        `echo ${shellQuote(`The app's new copy did not pass its health check with the ${values} values (kamal-proxy's reason is above), ${kept}.`)} >&2`,
      ],
      ["rot_exit"],
    ),
    ...startProcesses(processServices(plan), [
      `${said(`The %s container did not keep running after it started with the ${values} values.`)} "$service" >&2`,
    ]),
  ];
}

/** The services in `steps` that a rotation creates again, in their order, once each. */
function recreated(steps: readonly RotateStep[]): string[] {
  return [
    ...new Set(
      steps.filter((step) => step.recreate || step.mode === "restart").map((step) => step.service),
    ),
  ];
}

/** `lines` indented by `pad`. */
function indent(pad: string, lines: readonly string[]): string[] {
  return lines.map((line) => `${pad}${line}`);
}

/**
 * The server script of a rotation (025 plan.md 3.), `rotate.sh`: POSIX sh, run as a file on
 * `server` with `steps`' input on stdin ({@link rotateInput}), `<hash>` the rotation plan's. On the
 * app's server `sh rotate.sh <hash>` rotates and `sh rotate.sh --undo <hash>` undoes; on an extra
 * server (split placement) only its services change: `sh rotate.sh begin <hash>` runs steps 1–4,
 * `sh rotate.sh finish <hash>` step 6 (once the app's server's run switched the app), and
 * `sh rotate.sh --undo <hash>` undoes (after the app's server's undo, if any). Before any change it
 * refuses without the one-time approval of exactly this run and hash ({@link ROTATE_APPROVAL_FILE},
 * read and removed at once), at once while a deploy, a rollback or a snapshot holds the app's start
 * lock, while a restore or another rotation holds the app, and while another rotation is
 * unfinished; it then reads its whole input, and holds the start lock to its end. Each unit once:
 * 1. deploys held ({@link RESTORE_HELD}, saying `rotation <hash>`), which the deploy refuses to run
 *    with;
 * 2. the current env files kept as `.previous` in {@link ROTATE_DIR};
 * 3. per step, `begin` in the service's container; a `restart` step's env file written and its
 *    service created again instead;
 * 4. the env files written (owner-only), Grafana Alloy's masking file rewritten from them where it
 *    runs ({@link maskRewrite}); the services of steps with `recreate` created again;
 * 5. on the app's server, the app's switch with the image that runs ({@link appSwitch}), and its
 *    workers and cron;
 * 6. per step, `finish`; the hold released (only this rotation's), the `.previous` files removed.
 * Each `begin` and `finish` command is a unit of its own, and the state ({@link STATE}) records the
 * last unit done, so running it again goes on after it, under this rotation's hold only. A failure
 * stops it there with the step and how to go on or, before step 6 began, undo it; deploys stay
 * held. `--undo`, before step 6 began, puts the `.previous` env files back (the masking file too),
 * creates the recreated services again, runs each `begin` command that ran again with the values
 * swapped, switches the app back if its switch began, then runs each begun step's `finish` swapped,
 * or its own `undo`, and releases the hold; it goes on after its own last unit too. The commands'
 * output stays in {@link ROTATE_LOG}; nothing it prints holds a value, and no value is ever on a
 * command line.
 */
export function renderRotateScript(
  plan: DeployPlan,
  steps: readonly RotateStep[],
  server: string = APP_SERVER,
): string[] {
  const app = server === APP_SERVER;
  const folder = appFolder(plan);
  const files = rotateEnvFiles(steps, server);
  const number = new Map(files.map((file, i) => [file, i + 1]));
  const write = (file: string) => [
    `printf '%s' "$rot_env_${number.get(file)}" | base64 -d > ${file}.new`,
    `mv -f ${file}.new ${file}`,
  ];
  const previous = (file: string) => `${ROTATE_DIR}/${file}.previous`;
  const services = recreated(steps);
  const mask = maskRewrite(plan, server);

  const units: Unit[] = [
    {
      step: 1,
      what: "holding the app's deploys",
      lines: [
        `mkdir -p ${SNAPSHOTS_DIR}`,
        `printf '%s %s\\n' ${ROTATION_HOLDER} "$rot_hash" > ${RESTORE_HELD}`,
      ],
    },
    {
      step: 2,
      what: "keeping the current env files",
      lines: files.map((file) => `cp ${file} ${previous(file)}`),
    },
  ];
  /** Adds `unit`, returning its number. */
  const push = (unit: Unit) => units.push(unit);
  /** `command` in the container of step `i`'s service, with its values. */
  const inService = (step: RotateStep, i: number, command: RotationStep, swapped: boolean) => [
    `rot_container ${step.service}`,
    inContainer(command, i + 1, swapped),
  ];
  /** Each step's `begin` commands with their units in step 3, by the step's index. */
  const begun = new Map<number, { command: RotationStep; unit: number }[]>();
  /** Each service's first unit in step 3. */
  const first = new Map<string, number>();
  const firstOf = (service: string, unit: number) => {
    if (!first.has(service)) first.set(service, unit);
  };
  /** Each `restart` step's unit, by the step's index. */
  const restarted = new Map<number, number>();
  steps.forEach((step, i) => {
    if (step.mode === "restart") {
      const unit = push({
        step: 3,
        what: `restarting ${step.service} with its new value`,
        lines: [...write(step.envFile), recreate([step.service])],
      });
      restarted.set(i, unit);
      firstOf(step.service, unit);
      return;
    }
    const mine = step.begin.map((command) => ({
      command,
      unit: push({
        step: 3,
        what: `changing ${step.service} to its new value`,
        lines: inService(step, i, command, false),
      }),
    }));
    const [start] = mine;
    if (start === undefined) return;
    begun.set(i, mine);
    firstOf(step.service, start.unit);
  });
  units.push({
    step: 4,
    what: `writing the new env files${services.length === 0 ? "" : ` and restarting ${services.join(", ")} with them`}`,
    lines: [
      ...files.flatMap(write),
      ...mask,
      ...(services.length === 0 ? [] : [recreate(services)]),
    ],
  });
  /** The last unit of `begin` on an extra server. */
  const envUnit = units.length;
  if (app) {
    units.push({
      step: 5,
      what: "switching the app to the new values",
      lines: appSwitch(plan, "new"),
    });
  }
  const switchUnit = units.length;
  /**
   * Step 6's first unit, before any `finish`: once it is done, an old value may be gone, so undo is
   * refused and a failure offers only to go on.
   */
  const limit = push({ step: 6, what: "starting to drop the old values", lines: [] });
  steps.forEach((step, i) => {
    for (const command of step.finish) {
      push({
        step: 6,
        what: `dropping the old value of ${step.service}`,
        lines: inService(step, i, command, false),
      });
    }
  });

  // The generations snapshots record (SNAPSHOT_GENERATIONS): a service's new one once its data logs
  // in with the new value: after its last `begin` (both values work in a `dual` one, only the new
  // in a `swap`), after its restart, and for a `dual` one created again (Garage's key, which its
  // start makes) or one without `begin`, with the env files.
  const generationOf = (service: string) =>
    steps.find((step) => step.service === service && step.generation !== undefined)?.generation;
  const recorded = new Map<string, number>();
  steps.forEach((step, i) => {
    const unit =
      restarted.get(i) ??
      (step.mode === "dual" && step.recreate ? envUnit : begun.get(i)?.at(-1)?.unit) ??
      envUnit;
    recorded.set(step.service, Math.max(recorded.get(step.service) ?? 0, unit));
  });
  for (const [service, unit] of recorded) {
    const generation = generationOf(service);
    if (generation !== undefined) {
      units[unit - 1]?.lines.push(`rot_generation ${service} ${generation}`);
    }
  }
  /** The line that records the generation before the rotation of `service` again, if any. */
  const before = (service: string) => {
    const generation = generationOf(service);
    return generation === undefined ? [] : [`rot_generation ${service} ${generation - 1}`];
  };

  const reversed = [...steps.entries()].reverse();
  // Each `begin` command that ran, again with the values swapped, the last first.
  const swappedBegins = reversed.flatMap(([i, step]): UndoUnit[] => {
    if (step.undo !== undefined) return [];
    return (begun.get(i) ?? [])
      .map(({ command, unit }) => ({
        what: `changing ${step.service} back to its old value`,
        when: `[ "$rot_done" -ge ${unit} ]`,
        lines: inService(step, i, command, true),
        service: step.service,
      }))
      .reverse();
  });
  // Once the app is back on the old values: each begun step's `finish` swapped, or its own undo.
  const swappedFinishes = reversed.flatMap(([i, step]): UndoUnit[] => {
    const start = begun.get(i)?.[0];
    if (start === undefined) return [];
    const what =
      step.undo === undefined
        ? `dropping the new value of ${step.service}`
        : `undoing the change of ${step.service}`;
    return (step.undo ?? step.finish).map((command) => ({
      what,
      when: `[ "$rot_done" -ge ${start.unit} ]`,
      lines: inService(step, i, command, true),
      service: step.service,
    }));
  });
  // The generation before the rotation recorded again with the last undo unit that changes the
  // service's data back: only the old value works from then on.
  const changedBack = [...swappedBegins, ...swappedFinishes];
  for (const service of new Set(changedBack.flatMap((unit) => unit.service ?? []))) {
    changedBack.findLast((unit) => unit.service === service)?.lines.push(...before(service));
  }
  const undone = (service: string) => changedBack.some((unit) => unit.service === service);
  const undos: UndoUnit[] = [
    {
      what: "putting the old env files back",
      when: `[ "$rot_done" -ge 2 ]`,
      lines: [
        ...files.flatMap((file) => [
          `cp ${previous(file)} ${file}.new`,
          `mv -f ${file}.new ${file}`,
        ]),
        ...mask,
        ...[...recorded.keys()]
          .filter((service) => !undone(service) && !services.includes(service))
          .flatMap(before),
      ],
    },
    ...(services.length === 0
      ? []
      : [
          {
            what: `restarting ${services.join(", ")} with the old values`,
            lines: services.map(
              (service) =>
                `if [ "$rot_done" -ge ${(first.get(service) ?? envUnit) - 1} ]; then ${[recreate([service], true), ...(undone(service) ? [] : before(service))].join("; ")}; fi`,
            ),
          },
        ]),
    ...swappedBegins,
    ...(app
      ? [
          {
            what: "switching the app back to the old values",
            when: `[ "$rot_done" -ge ${switchUnit - 1} ]`,
            lines: appSwitch(plan, "old"),
          },
        ]
      : []),
    ...swappedFinishes,
  ];

  const rotate = opscrew(plan, "rotate");
  const undo = opscrew(plan, "rotate --undo");
  const where = serverWords(server);
  const log = `The output of its commands stays on the server in %s/${ROTATE_LOG} (it can quote a value, so it is not printed here).`;
  const refuse = (text: string, pad = "  ") => [
    `${pad}echo ${shellQuote(text)} >&2`,
    `${pad}exit 1`,
  ];
  /** A refusal whose `%s` is the command to run again (`$rot_cmd`). */
  const refuseRun = (text: string, pad = "  ") => [
    `${pad}${said(text)} "$rot_cmd" >&2`,
    `${pad}exit 1`,
  ];
  const runs = app
    ? [
        ["<hash>", "rotates, or goes on after the last step it finished"],
        ["--undo <hash>", "puts the old values back, before step 6"],
      ]
    : [
        ["begin <hash>", "steps 1 to 4: the services' new values, before the app's switch"],
        ["finish <hash>", "step 6: the old values dropped, once the app switched"],
        ["--undo <hash>", "puts the old values back, before step 6"],
      ];
  const usage = `Usage: sh rotate.sh ${runs.map(([run]) => run).join(" | ")}`;
  /** The test that the hold is this rotation's ({@link RESTORE_HELD} reads `rotation <hash>`). */
  const ours = `[ "$(cat ${RESTORE_HELD} 2> /dev/null || true)" = "${ROTATION_HOLDER} $rot_hash" ]`;
  /** The hold released, only when it is this rotation's. */
  const unhold = `if ${ours}; then rm -f ${RESTORE_HELD}; fi`;
  /** The refusal of `finish` on an extra server before `begin` gave its services their new values. */
  const notBegun = `This rotation's services don't have their new values on ${where} yet, so nothing was changed. Run ${rotate} again to go on with it.`;
  /** The refusal while another holds the app. */
  const heldElsewhere = heldStop(plan, "The rotation changed nothing: ", "exit 1");
  // The hold goes last: a run that finds this rotation finished removes a hold it left.
  const release = [
    `rot_step=6; rot_what=${shellQuote("releasing the app's deploys")}`,
    `printf '%s\\n' "$rot_hash" > ${FINISHED}`,
    `rm -f ${STATE} ${files.map(previous).join(" ")}`,
    unhold,
    'rot_what=""',
    `echo ${shellQuote(`OpsCrew rotated the credentials on ${where}: ${app ? "the app runs on the new values, " : ""}the old values no longer work, and deploys are no longer held.`)}`,
  ];
  return [
    `# OpsCrew's credential rotation of ${plan.app.name} on ${where}, rendered for one rotation; opscrew rotate runs it.`,
    ...runs.map(([run, what]) => `#   sh rotate.sh ${run}   ${what}`),
    `# Its input on stdin, read before any change and never printed: one line per env file (${files.join(", ")}),`,
    "# its bytes in base64, then the old and the new value of each step, one line each.",
    ...SCRIPT_ROOTS,
    "set -eu",
    "umask 077",
    `cd ${folder}`,
    ...(app ? [EDGE_FUNCTION] : []),
    'rot_action=""',
    'rot_what=""',
    "rot_step=1",
    "rot_done=0",
    "rot_undone=0",
    "rot_exit() {",
    '  if [ -z "$rot_what" ]; then return 0; fi',
    '  if [ "$rot_action" = undo ]; then',
    `    ${said(`Undoing the rotation stopped while %s, so deploys stay held. ${log} Fix the cause, then run ${undo} again to finish the undo.`)} "$rot_what" ${folder} >&2`,
    '  elif [ "$rot_done" -eq 0 ]; then',
    `    ${said(`The rotation stopped at step 1 of 6 (%s), and nothing was changed. Fix the cause, then run ${rotate} again.`)} "$rot_what" >&2`,
    `  elif [ "$rot_done" -lt ${limit} ]; then`,
    `    ${said(`The rotation stopped at step %s of 6 (%s), so deploys stay held. ${log} Fix the cause, then run ${rotate} again to go on from this step, or ${undo} to put the old values back.`)} "$rot_step" "$rot_what" ${folder} >&2`,
    "  else",
    `    ${said(`The rotation stopped at step %s of 6 (%s), so deploys stay held. ${log} Fix the cause, then run ${rotate} again to finish it: it has begun to drop the old values, so it can no longer be undone.`)} "$rot_step" "$rot_what" ${folder} >&2`,
    "  fi",
    "}",
    "trap 'rot_exit' EXIT",
    "rot_save() {",
    `  printf '%s %s %s\\n' "$rot_hash" "$rot_done" "$rot_undone" > ${STATE}.new`,
    `  mv -f ${STATE}.new ${STATE}`,
    "}",
    // A service's generation in SNAPSHOT_GENERATIONS, replaced at once.
    "rot_generation() {",
    `  { grep -v "^$1 " ${SNAPSHOT_GENERATIONS} 2> /dev/null || true; printf '%s %s\\n' "$1" "$2"; } > ${SNAPSHOT_GENERATIONS}.new`,
    `  mv -f ${SNAPSHOT_GENERATIONS}.new ${SNAPSHOT_GENERATIONS}`,
    "}",
    "rot_container() {",
    '  rot_c="$(docker compose ps -q "$1")"',
    '  if [ -z "$rot_c" ]; then',
    `    ${said("%s is not running, so OpsCrew could not change its value.")} "$1" >&2`,
    "    return 1",
    "  fi",
    "}",
    'case "${1:-}" in',
    "  --undo) rot_action=undo; shift ;;",
    ...(app ? ["  *) rot_action=rotate ;;"] : ['  begin | finish) rot_action="$1"; shift ;;']),
    "esac",
    'rot_hash="${1:-}"',
    'if [ -z "$rot_action" ] || [ "$#" -ne 1 ]; then rot_hash=""; fi',
    'case "$rot_hash" in *[!0-9a-f]*) rot_hash="" ;; esac',
    'if [ "${#rot_hash}" -ne 64 ]; then',
    ...refuse(usage),
    "fi",
    `rot_cmd=${shellQuote(rotate)}`,
    `if [ "$rot_action" = undo ]; then rot_cmd=${shellQuote(undo)}; fi`,
    `if [ ! -f ${ROTATE_APPROVAL_FILE} ]; then`,
    ...refuseRun(
      `A rotation needs its one-time approval on ${where} (${ROTATE_APPROVAL_FILE} in the app's folder), which opscrew rotate writes once you approve its plan, so nothing was changed. Run %s again.`,
    ),
    "fi",
    ...readApproval(ROTATE_APPROVAL_FILE),
    'if [ "$approved" != "$rot_hash" ] || [ "$choice" != "$rot_action" ]; then',
    ...refuseRun(
      `The one-time approval on ${where} (${ROTATE_APPROVAL_FILE}) is for another rotation, so OpsCrew removed it and changed nothing. Run %s again.`,
    ),
    "fi",
    ...approvalExpiry(
      refuseRun(
        "The one-time approval of this rotation expired before it started, so nothing was changed. Run %s again.",
        "",
      ),
    ),
    `exec 7> ${START_LOCK}`,
    "if ! flock -n 7; then",
    `  rot_runs=${shellQuote(`A deploy, a rollback or a restore of the app is running on ${where}`)}`,
    `  for rot_each in ${SNAPSHOTS_DIR}/*.partial ${SNAPSHOTS_DIR}/*.taking; do`,
    `    if [ -d "$rot_each" ]; then rot_runs=${shellQuote(`OpsCrew is taking a snapshot of the app's data on ${where}`)}; fi`,
    "  done",
    `  ${said("%s, which holds the app's start lock, so the rotation changed nothing. Run %s again once it has finished.")} "$rot_runs" "$rot_cmd" >&2`,
    "  exit 1",
    "fi",
    `if [ -f ${STATE} ]; then`,
    `  read -r rot_state rot_done rot_undone < ${STATE} || true`,
    '  case "${rot_done:-x}:${rot_undone:-x}" in *[!0-9:]*)',
    ...refuse(
      `The state of the rotation on ${where} (${STATE} in the app's folder) is unreadable, so nothing was changed. Remove it once you know no rotation stopped part-way there, then run opscrew rotate again.`,
      "    ",
    ),
    "  esac",
    '  if [ "$rot_state" != "$rot_hash" ]; then',
    '    if [ "$rot_action" = undo ]; then',
    ...refuse(
      `The rotation that stopped on ${where} is another one than this, so nothing was changed. Run the opscrew rotate --undo of that rotation instead.`,
      "      ",
    ),
    "    fi",
    ...refuse(
      `An earlier rotation stopped on ${where} before it finished, so this one changed nothing. Finish that rotation by running its opscrew rotate again, or put its old values back with ${undo}, then try again.`,
      "    ",
    ),
    "  fi",
    '  if [ "$rot_action" != undo ] && [ "$rot_undone" -gt 0 ]; then',
    ...refuse(
      `Undoing this rotation stopped before it finished, so nothing was changed. Run ${undo} again to finish the undo.`,
      "    ",
    ),
    "  fi",
    `  if [ "$rot_action" = undo ] && [ "$rot_done" -ge ${limit} ]; then`,
    ...refuse(
      `This rotation has begun to drop the old values (step 6), so it can't be undone, and nothing was changed. Run ${rotate} again to finish it.`,
      "    ",
    ),
    "  fi",
    ...(app
      ? []
      : [
          `  if [ "$rot_action" = begin ] && [ "$rot_done" -ge ${envUnit} ]; then`,
          `    echo ${shellQuote(`This rotation's services have their new values on ${where} already, so nothing was changed.`)} >&2`,
          "    exit 0",
          "  fi",
          `  if [ "$rot_action" = finish ] && [ "$rot_done" -lt ${envUnit} ]; then`,
          ...refuse(notBegun, "    "),
          "  fi",
        ]),
    `elif [ "$(cat ${FINISHED} 2> /dev/null || true)" = "$rot_hash" ]; then`,
    '  if [ "$rot_action" = undo ]; then',
    ...refuse(
      "This rotation finished, and its old values no longer work, so it can't be undone; nothing was changed.",
      "    ",
    ),
    "  fi",
    `  if ${ours}; then`,
    `    rm -f ${RESTORE_HELD}`,
    `    echo ${shellQuote(`This rotation finished on ${where} already; OpsCrew removed the hold of the app's deploys it had left there.`)} >&2`,
    "  else",
    `    echo ${shellQuote(`This rotation finished on ${where} already, so nothing was changed.`)} >&2`,
    "  fi",
    "  exit 0",
    'elif [ "$rot_action" = undo ]; then',
    `  echo ${shellQuote(`No rotation of this plan is unfinished on ${where}, so there is nothing to undo.`)} >&2`,
    "  exit 0",
    ...(app ? [] : ['elif [ "$rot_action" = finish ]; then', ...refuse(notBegun)]),
    `elif [ -f ${RESTORE_HELD} ]; then`,
    `  ${heldElsewhere}`,
    "fi",
    // An unfinished rotation goes on only under its own hold: without it a deploy may have run
    // since it stopped, and under another's a restore or another rotation holds the app.
    'if [ "$rot_done" -gt 0 ]; then',
    `  if [ ! -f ${RESTORE_HELD} ]; then`,
    '    if [ "$rot_action" != undo ]; then',
    ...refuse(
      `This rotation's hold on ${where} (${RESTORE_HELD} in the app's folder) is gone, so a deploy may have changed the app since the rotation stopped, and nothing was changed. Put the old values back with ${undo}, then rotate again.`,
      "      ",
    ),
    "    fi",
    `  elif ! ${ours}; then`,
    `    ${heldElsewhere}`,
    "  fi",
    "fi",
    ...(app
      ? [
          "if [ -z \"$(sed -n 's/^APP_IMAGE=//p' .env 2> /dev/null || true)\" ]; then",
          ...refuseRun(
            `The app's .env on ${where} names no image (no deploy finished there yet), so the rotation changed nothing. Deploy the app, then run %s again.`,
          ),
          "fi",
        ]
      : []),
    `for rot_each in ${files.join(" ")}; do`,
    '  if [ ! -f "$rot_each" ]; then',
    `    ${said(`${where.charAt(0).toUpperCase()}${where.slice(1)} has no %s in the app's folder (each deploy writes it), so the rotation changed nothing. Deploy the app, then run %s again.`)} "$rot_each" "$rot_cmd" >&2`,
    "    exit 1",
    "  fi",
    "done",
    'rot_bad=""',
    ...files.map((_file, i) => `IFS= read -r rot_env_${i + 1} || rot_bad=1`),
    ...steps.flatMap((_step, i) => [
      `IFS= read -r rot_old_${i + 1} || rot_bad=1`,
      `IFS= read -r rot_new_${i + 1} || rot_bad=1`,
    ]),
    "exec < /dev/null",
    ...files.map(
      (_file, i) => `printf '%s' "$rot_env_${i + 1}" | base64 -d > /dev/null 2>&1 || rot_bad=1`,
    ),
    'if [ -n "$rot_bad" ]; then',
    ...refuseRun(
      "The rotation's input (the new env files and values on stdin) is incomplete or unreadable, so nothing was changed. Run %s again.",
    ),
    "fi",
    'if [ "$rot_action" != undo ]; then',
    `  if [ "$rot_done" -gt 0 ]; then echo ${shellQuote("OpsCrew goes on with the rotation after the last step it finished.")} >&2; fi`,
    // The last unit this run does: on an extra server `begin` stops after the env files.
    `  rot_last=${units.length}`,
    ...(app ? [] : [`  if [ "$rot_action" = begin ]; then rot_last=${envUnit}; fi`]),
    ...units.flatMap((unit, i) =>
      indent("  ", [
        `if [ "$rot_done" -lt ${i + 1} ] && [ "$rot_last" -ge ${i + 1} ]; then`,
        `  rot_step=${unit.step}; rot_what=${shellQuote(unit.what)}`,
        ...indent("  ", unit.lines),
        `  rot_done=${i + 1}; rot_save`,
        "fi",
      ]),
    ),
    ...(app
      ? indent("  ", release)
      : [
          '  if [ "$rot_action" = finish ]; then',
          ...indent("    ", release),
          "  else",
          '    rot_what=""',
          `    echo ${shellQuote(`OpsCrew gave the services on ${where} their new values; once the app runs on them, ${rotate} drops the old ones there.`)}`,
          "  fi",
        ]),
    "else",
    ...undos.flatMap((unit, i) =>
      indent("  ", [
        `if [ "$rot_undone" -lt ${i + 1} ]; then`,
        `  rot_what=${shellQuote(unit.what)}`,
        ...(unit.when === undefined
          ? indent("  ", unit.lines)
          : [`  if ${unit.when}; then`, ...indent("    ", unit.lines), "  fi"]),
        `  rot_undone=${i + 1}; rot_save`,
        "fi",
      ]),
    ),
    `  rot_what=${shellQuote("releasing the app's deploys")}`,
    `  ${unhold}`,
    `  rm -f ${files.map(previous).join(" ")} ${STATE}`,
    '  rot_what=""',
    `  echo ${shellQuote(`OpsCrew put the old values back on ${where}: ${app ? "the app runs on them again, and " : ""}deploys are no longer held.`)}`,
    "fi",
  ];
}
