/**
 * `opscrew rotate monitoring` (025 plan.md 10., US8, FR-2511): Grafana's admin password and
 * OpsCrew's monitoring login to Postgres get new values through the monitoring's own host plans,
 * each approved by its hash (ADR 0011), which change the running add-on first (Grafana and Postgres
 * read their values at their first start only), then the files a restart reads. The new values stay
 * beside the old in the environment's unfinished rotation until done; then they become this
 * computer's, the rotation is recorded and the recovery copy refreshed. Shared monitoring: Grafana's
 * password is the owner environment's, so another environment rotates only its own login. Also the
 * lifecycle of an add-on's rotation that `./addons-beszel` shares.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { postgresOn } from "@opscrew/iac-templates";
import { type DeployPlan, monitoringOf, onOneServer } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { monitoringOwner } from "../network";
import { requireNoMoveInProgress } from "../provision/guard";
import { type MonitoringRotation, monitoringRotationHostPlans } from "../provision/monitoring";
import { keepMonitoringValues, monitoringValues } from "../provision/secrets";
import type { ProvisionServices } from "../provision/types";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { hasDeployment, randomPassword } from "../shared";
import { appServers } from "../shared/servers";
import { assertValuesCurrent, recordRotation } from "./record";
import {
  dropPendingRotation,
  keepPendingRotation,
  type PendingRotation,
  readPendingRotation,
  registerRotationValues,
} from "./values-pending";

/** What an add-on's rotation reaches besides this computer. */
export interface AddonRotationOptions {
  /** Tests: the servers' shells (`remote`) and the host adapter (`serverHost`). */
  services?: Pick<ProvisionServices, "remote" | "serverHost">;
}

/** A finished rotation of an add-on's credentials. */
export interface AddonRotation {
  /** The hashes of the host plans shown, in order. */
  hostPlanHashes: string[];
  /** The recovery copy, refreshed: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** An add-on's secrets in a rotation, by name, each with its old and new value. */
type Pairs = Record<string, { old: string; new: string }>;

/**
 * The hash an add-on's unfinished rotation keeps: never a plan's, since its host plans are what is
 * approved, each by its own hash. The services' rotations know an add-on's file by it, so a
 * service named `monitoring` or `beszel` never takes it for its own.
 */
export const ADDON_ROTATION_HASH = "0".repeat(64);

/** The secrets of the monitoring's rotation, as its unfinished rotation names them. */
const MONITORING_SECRETS = ["grafanaAdminPassword", "postgresPassword"] as const;

/**
 * Stops before any change unless `plan` runs on servers OpsCrew deployed, and no move is under way.
 */
export function requireAddonServers(plan: DeployPlan, what: string, flags: string): void {
  if (!onOneServer(plan.target.provider) || !hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} has no deployment on a server yet, so there are no values of ${what} on one to rotate. Nothing was changed.`,
      { hint: `Run \`opscrew provision${flags}\` first.` },
    );
  }
  requireNoMoveInProgress(plan);
}

/**
 * The rotation `name` of an add-on, whose secrets are among `secrets`: the unfinished one of it
 * again (its values reused, so its host plans set the same ones; one of a service of that name, or
 * of other secrets, is another rotation), else one of `make()`'s new values, kept as `planned`
 * before any change (registered with the redactor), so a run stopped anywhere goes on with them.
 * @throws OpsCrewError `PHASE_PRECONDITION` while a rotation of other credentials is unfinished.
 */
export async function addonRotationValues(
  deps: PhaseDeps,
  name: string,
  secrets: readonly string[],
  flags: string,
  make: () => Promise<Pairs>,
): Promise<PendingRotation> {
  const existing = await readPendingRotation(deps);
  if (
    existing?.names.length === 1 &&
    existing.names[0] === name &&
    Object.keys(existing.services[name] ?? {}).every((secret) => secrets.includes(secret))
  ) {
    return existing;
  }
  if (existing !== undefined && existing.step !== "planned") {
    const theirs = `opscrew rotate ${existing.names.join(" ")}${flags}`;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The rotation of ${listText(existing.names)} in ${deps.paths.environment} is unfinished: its new values are on this computer, and maybe on the servers. Nothing was changed.`,
      { hint: `Finish it with \`${theirs}\` first, then run this command again.` },
    );
  }
  const pairs = await make();
  const pending: PendingRotation = {
    names: [name],
    services: { [name]: pairs },
    hash: ADDON_ROTATION_HASH,
    step: "planned",
  };
  registerRotationValues(deps.redactor, pending);
  await keepPendingRotation(deps, pending);
  return pending;
}

/**
 * Marks `pending` as begun once a host plan of it is approved (it may change a server from then
 * on): `switched`, since an add-on's rotation only goes forward, so other commands name no undo,
 * and no rotation of other credentials replaces its values until it is done. Idempotent.
 */
export async function beginAddonRotation(deps: PhaseDeps, pending: PendingRotation): Promise<void> {
  if (pending.step === "planned") await keepPendingRotation(deps, { ...pending, step: "switched" });
}

/**
 * The end of an add-on's rotation `name`, once the servers run on its new values: `keep` makes
 * them this computer's, the unfinished rotation is forgotten, the rotation recorded and the
 * recovery copy refreshed.
 */
export async function finishAddonRotation(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  keep: () => Promise<void>,
): Promise<RefreshRecoveryResult> {
  await keep();
  await dropPendingRotation(deps);
  await recordRotation(deps, [name]);
  return refreshRecoveryCopy(deps, plan);
}

/**
 * Rotates the monitoring of `plan`'s environment (`deps.paths`): on the environment that runs the
 * stack, Grafana's admin password; on every environment with Postgres, OpsCrew's monitoring login.
 * Each is changed by the monitoring's host plans, shown and approved by their hashes; the values go
 * to the servers only on apply. Refused before any change when monitoring is off or holds nothing
 * of this environment's to rotate (another environment's stack and no Postgres: the refusal names
 * that environment's command), without a deployment, while a move is under way, by the two-computer
 * guard, while another rotation is unfinished, and when this computer has not the values. A run
 * that stopped goes on with the same values when the command is run again.
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION`, and the host plans' refusals.
 */
export async function rotateMonitoring(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AddonRotationOptions = {},
): Promise<AddonRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const command = `opscrew rotate monitoring${flags}`;
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Self-hosted monitoring is off in ${environment}, so it has no credentials to rotate. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  const postgres = appServers(plan).some((server) => postgresOn(plan, server) !== undefined);
  const owner = monitoringOwner(deps.paths, plan);
  const ownerCommand =
    owner === undefined
      ? undefined
      : `opscrew rotate monitoring${await commandFlags(root, owner.paths.environment, owner.paths.app)}`;
  if (owner !== undefined && !postgres) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The monitoring of ${environment} runs on ${owner.plan}'s server, and Grafana's admin password is that environment's, so it is rotated from there. Nothing was changed.`,
      { hint: `Run \`${ownerCommand}\`.` },
    );
  }
  requireAddonServers(plan, "Monitoring", flags);
  await assertValuesCurrent(deps);
  const pending = await addonRotationValues(
    deps,
    "monitoring",
    MONITORING_SECRETS,
    flags,
    async () => {
      const kept = await monitoringValues(deps);
      const pairs: Pairs = {};
      if (owner === undefined) {
        const old = kept?.grafanaAdminPassword;
        if (old === undefined) throw missingValue(environment, "Grafana's admin password", flags);
        pairs.grafanaAdminPassword = { old, new: randomPassword(32) };
      }
      if (postgres) {
        const old = kept?.postgresPassword;
        if (old === undefined)
          throw missingValue(environment, "the monitoring login's password", flags);
        pairs.postgresPassword = { old, new: randomPassword(32) };
      }
      return pairs;
    },
  );
  const values: Partial<Record<(typeof MONITORING_SECRETS)[number], string>> = {};
  for (const secret of MONITORING_SECRETS) {
    const value = pending.services.monitoring?.[secret]?.new;
    if (value !== undefined) values[secret] = value;
  }
  if (owner !== undefined) {
    deps.reporter.info(
      `Grafana's admin password is ${owner.plan}'s: \`${ownerCommand}\` rotates it. This rotates the monitoring login to Postgres of ${environment} only.`,
    );
  }
  // Begun once a host plan of it is approved, right before its apply.
  const rotating: MonitoringRotation = {
    ...values,
    begin: () => beginAddonRotation(deps, pending),
  };
  const outcomes = await monitoringRotationHostPlans(
    deps,
    plan,
    {
      services: options.services ?? {},
      ownRun: undefined,
      extraOwn: [],
      planOnly: false,
      command,
      phase: "provision",
    },
    rotating,
  );
  const copy = await finishAddonRotation(deps, plan, "monitoring", () =>
    keepMonitoringValues(deps, (current) => ({ ...current, ...values })),
  );
  deps.reporter.success(
    `Rotated the monitoring's ${listText([
      ...(values.grafanaAdminPassword === undefined ? [] : ["Grafana admin password"]),
      ...(values.postgresPassword === undefined ? [] : ["login to Postgres"]),
    ])} in ${environment}: the old ${Object.keys(values).length === 1 ? "value no longer works" : "values no longer work"}.${values.grafanaAdminPassword === undefined ? "" : " Sign in to Grafana with the new password, kept with OpsCrew's generated values (`opscrew addon open monitoring` opens it)."}`,
  );
  return { hostPlanHashes: outcomes.map((outcome) => outcome.hash), copy };
}

/** The stop when this computer has not the value it rotates (it set none up, or lost it). */
function missingValue(environment: string, what: string, flags: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `This computer does not keep ${what} of ${environment}'s monitoring, so OpsCrew can't rotate it. Nothing was changed.`,
    {
      hint: `Run \`opscrew provision${flags}\` on the computer that set monitoring up, or bring its values back from the recovery copy (\`opscrew secrets restore${flags}\`), then run this command again.`,
    },
  );
}
