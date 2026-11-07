/**
 * `opscrew snapshot schedule on|off` (US5, FR-2406): scheduled data snapshots in the plan
 * (`snapshots.schedule`), which provision then puts on the servers (a line in the deploy user's
 * crontab, D2) or into the Portainer stack. Only the plan changes here.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { snapshotParts } from "@opscrew/iac-templates";
import { type DeployPlan, snapshotScheduleOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { planFile } from "../runners/words";
import { dataServers } from "./hosts";
import { type SnapshotRun, snapshotRun } from "./run";
import {
  provisionLine,
  requireSettingsPlace,
  type SnapshotSettingChange,
  withSnapshotSetting,
  writeSnapshotSetting,
} from "./settings";

/** `opscrew snapshot schedule on`'s flags; each one left out keeps the plan's value, else its default. */
export interface ScheduleOnOptions {
  /** `--every daily|weekly|<n>h`: how often (default weekly). */
  every?: string;
  /** `--keep <n>`: how many scheduled snapshots stay (default 4). */
  keep?: number;
  /** `--stop <service>`: the stop-only services the scheduled snapshot also copies, each stopped alone. */
  stop?: readonly string[];
}

/** `weekly`, `daily`, `every 12 hours`. */
function everyText(every: string): string {
  if (every === "daily" || every === "weekly") return every;
  const hours = Number.parseInt(every, 10);
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}

/** A schedule in words: `weekly, the last 4 kept, kafka stopped for its copy`; `off`. */
export function scheduleText(plan: Pick<DeployPlan, "snapshots">): string {
  const schedule = snapshotScheduleOf(plan);
  if (schedule === undefined) return "off";
  const stop = schedule.stop;
  return [
    everyText(schedule.every),
    schedule.keep === 1 ? "the last one kept" : `the last ${schedule.keep} kept`,
    ...(stop.length === 0
      ? []
      : [`${listText(stop)} stopped for ${stop.length === 1 ? "its" : "their"} copy`]),
  ].join(", ");
}

/** The plan's stop-only services with data, on every server that has some. */
function stopOnlyServices(plan: DeployPlan): string[] {
  return dataServers(plan).flatMap((server) =>
    snapshotParts(plan, server)
      .filter((part) => !part.online)
      .map((part) => part.name),
  );
}

/** What the schedule leaves out: the stop-only services it does not stop, and why. */
function leftOutLine(run: SnapshotRun, plan: DeployPlan): string | undefined {
  const stop = snapshotScheduleOf(plan)?.stop ?? [];
  const left = stopOnlyServices(plan).filter((name) => !stop.includes(name));
  if (left.length === 0) return undefined;
  const names = listText(left);
  const verb = left.length === 1 ? "is" : "are";
  if (plan.target.provider === "portainer") {
    return `${names} ${verb} left out: in Portainer the scheduled snapshots copy only the services copied while they run, because stopping one needs Docker on the host, which the stack has no access to. Take a snapshot with ${left.length === 1 ? "it" : "them"} by hand with \`opscrew snapshot${run.flags}\`.`;
  }
  return `${names} ${verb} left out: ${left.length === 1 ? "it" : "each"} must stop for its copy. Add ${left.map((name) => `--stop ${name}`).join(" ")} to copy ${left.length === 1 ? "it" : "them"} on the schedule, stopped alone meanwhile.`;
}

/** Where provision puts the schedule, or takes it away from. */
function where(plan: DeployPlan): string {
  return plan.target.provider === "portainer" ? "the app's stack in your Portainer" : "the server";
}

/**
 * `opscrew snapshot schedule on` (FR-2406): `snapshots.schedule` in the plan of the environment
 * `deps` belong to, with `options` over the plan's values or the defaults (weekly, keep 4, no
 * stop-only service), written through the plan-writing path; the lines say what changed, what the
 * schedule leaves out and to run provision.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, a preview environment, this computer or an
 * environment without data, and for `--stop` in Portainer (D3); `INVALID_INPUT` for a value the
 * plan schema refuses. Nothing is written then.
 */
export async function snapshotScheduleOn(
  deps: PhaseDeps,
  options: ScheduleOnOptions = {},
): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  requireSettingsPlace(run, "schedule", "take scheduled snapshots");
  if (plan.target.provider === "portainer" && (options.stop ?? []).length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `In Portainer a scheduled snapshot can't stop a service: stopping one needs Docker on the host, which the app's stack has no access to. ${NOTHING_CHANGED}`,
      {
        hint: `Leave out --stop; take a snapshot with those services by hand with \`opscrew snapshot${run.flags}\`, which stops each alone for its copy.`,
      },
    );
  }
  const current = snapshotScheduleOf(plan);
  const stop = options.stop === undefined ? (current?.stop ?? []) : [...new Set(options.stop)];
  const after = withSnapshotSetting(
    plan,
    "schedule",
    {
      every: options.every ?? current?.every ?? "weekly",
      keep: options.keep ?? current?.keep ?? 4,
      ...(stop.length === 0 ? {} : { stop }),
    },
    "take scheduled snapshots",
  );
  const left = leftOutLine(run, after);
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled snapshots of ${run.environment}'s data (snapshots.schedule in ${planFile(plan)}): ${scheduleText(plan)} → ${scheduleText(after)}.`,
      ...(left === undefined ? [] : [left]),
      "Each stays on the machine that holds the data, as the snapshots by hand do.",
      provisionLine(run, `put the schedule on ${where(after)}`),
    ],
    `Scheduled snapshots of ${run.environment}'s data are already ${scheduleText(plan)}.`,
  );
}

/**
 * `opscrew snapshot schedule off` (US5 #3): `snapshots.schedule` removed from the plan; the
 * snapshots it took stay until deleted, and the lines say so and to run provision.
 */
export async function snapshotScheduleOff(deps: PhaseDeps): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  const after = withSnapshotSetting(plan, "schedule", undefined, "turn off scheduled snapshots");
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled snapshots of ${run.environment}'s data (snapshots.schedule in ${planFile(plan)}): ${scheduleText(plan)} → off.`,
      `The scheduled snapshots already taken stay until you delete them with \`opscrew snapshot delete <id>${run.flags}\`; \`opscrew snapshot list${run.flags}\` lists them.`,
      provisionLine(run, `take the schedule off ${where(plan)}`),
    ],
    `Scheduled snapshots of ${run.environment}'s data are already off.`,
  );
}
