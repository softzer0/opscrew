/**
 * What `opscrew snapshot schedule` and `snapshot offsite` share (US5, US6): where the settings may
 * be, the plan with `snapshots.schedule` or `snapshots.offsite` set or removed and validated, and
 * the write through the plan-writing path every phase uses.
 */
import { canonicalJson, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, type Snapshots } from "@opscrew/plan-schema";
import { NOTHING_CHANGED } from "../promote/shared";
import { planFile } from "../runners/words";
import { writePlanIfChanged } from "../shared/plan-file";
import { dataServers } from "./hosts";
import { type SnapshotRun, snapshotTarget } from "./run";

/** What `snapshot schedule on|off` or `snapshot offsite on|off` changed. */
export interface SnapshotSettingChange {
  /** The plan as it is now. */
  plan: DeployPlan;
  /** False when the plan already said so: nothing was written. */
  changed: boolean;
  /** What changed and what to run next, or that nothing changed. */
  lines: string[];
}

/**
 * Stops before any change where `field` cannot be (`what` says what the command does: `turn on
 * scheduled snapshots`): a site (`snapshotTarget`), a preview environment, and this computer.
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
export function requireSettingsPlace(run: SnapshotRun, field: keyof Snapshots, what: string): void {
  const target = snapshotTarget(run);
  const refuse = (why: string, hint: string) =>
    new OpsCrewError("PHASE_PRECONDITION", `OpsCrew does not ${what} ${why} ${NOTHING_CHANGED}`, {
      hint,
    });
  if (run.plan.environment?.previews !== undefined) {
    throw refuse(
      `in ${run.environment}, a preview environment: its previews come and go, with no data worth keeping.`,
      "Take snapshots in the environment that keeps the app's data, such as prod.",
    );
  }
  if (target !== "computer") {
    if (dataServers(run.plan).length > 0) return;
    throw refuse(
      `for ${run.environment}: it has no service that keeps data and no SQLite volume, so there is nothing to snapshot.`,
      "Run the command again once the app keeps data.",
    );
  }
  throw field === "schedule"
    ? refuse(
        "on this computer: it isn't always on to take them.",
        `Take one when you need it with \`opscrew snapshot${run.flags}\`.`,
      )
    : refuse(
        "on this computer: its snapshots stay on this computer, beside the data.",
        "Copy the app's .snapshots folder yourself if you need a copy elsewhere.",
      );
}

/**
 * `plan` with `snapshots.<field>` set to `value`, or removed with `undefined` (and `snapshots`
 * with it once empty), validated with the plan schema.
 * @throws OpsCrewError `INVALID_INPUT` with the schema's reason, before any change.
 */
export function withSnapshotSetting<F extends keyof Snapshots>(
  plan: DeployPlan,
  field: F,
  value: Snapshots[F],
  what: string,
): DeployPlan {
  const { [field]: _old, ...others } = plan.snapshots ?? {};
  const snapshots = value === undefined ? others : { ...others, [field]: value };
  const { snapshots: _previous, ...rest } = plan;
  const parsed = DeployPlanSchema.safeParse(
    Object.keys(snapshots).length === 0 ? rest : { ...rest, snapshots },
  );
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew cannot ${what}: ${issue?.path.join(".") || `snapshots.${field}`} ${issue?.message ?? "is not valid"}. ${planFile(plan)} was not changed.`,
    { hint: "Correct the value named above and run the command again." },
  );
}

/**
 * Writes `after` through {@link writePlanIfChanged} when its `snapshots` differ from `run`'s plan,
 * with `lines` (what changed and what to run next), or says `unchanged` and writes nothing.
 */
export async function writeSnapshotSetting(
  run: SnapshotRun,
  after: DeployPlan,
  lines: readonly string[],
  unchanged: string,
): Promise<SnapshotSettingChange> {
  if (canonicalJson(after.snapshots ?? null) === canonicalJson(run.plan.snapshots ?? null)) {
    return { plan: run.plan, changed: false, lines: [`${unchanged} ${NOTHING_CHANGED}`] };
  }
  await writePlanIfChanged(run.deps, after);
  return { plan: after, changed: true, lines: [...lines] };
}

/** `Run \`opscrew provision\` to …`, with the environment's flags. */
export function provisionLine(run: SnapshotRun, does: string): string {
  return `Run \`opscrew provision${run.flags}\` to ${does}.`;
}
