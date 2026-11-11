import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isCloudTarget } from "@opscrew/plan-schema";
import { noProviderBackupsText } from "../design/snapshots";
import { providerProfile } from "../providers";
import { placeWords } from "../retarget/sides";
import { planFile } from "../runners";
import { extraCloudServers } from "../shared/servers";

/** What to say while `opscrew retarget` is moving the deployment. */
export interface MoveInProgress {
  message: string;
  hint: string;
}

/**
 * The plain-English notice for a move in progress (`plan.retarget` exists), or `undefined` when
 * no move is under way. `plan.target` is already the provider the move goes to. Once an abort
 * began (`retarget.abort`), the move can only be aborted, so the hint names only the abort.
 */
export function moveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget">,
): MoveInProgress | undefined {
  if (plan.retarget === undefined) return undefined;
  const to = placeWords(plan.target);
  if (plan.retarget.abort !== undefined) {
    return {
      message: `A move to ${to} is being aborted.`,
      hint: "Run `opscrew retarget --abort` to finish the abort; it continues where it stopped and puts the app back on the previous server.",
    };
  }
  return {
    message: `A move to ${to} is in progress.`,
    hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
  };
}

/**
 * Stops with `PHASE_PRECONDITION` while a move to another provider is in progress, so provision,
 * design, dns and drift never act on a half-moved deployment.
 */
export function requireNoMoveInProgress(plan: Pick<DeployPlan, "target" | "retarget">): void {
  const move = moveInProgress(plan);
  if (move !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", move.message, { hint: move.hint });
  }
}

/**
 * Stops with `INVALID_INPUT` before any plan when a server OpsCrew creates, the app's or an extra
 * one, has `backups: true` at a provider that offers no automated backups through OpsCrew
 * (`offering.providerBackups` false). `rerun` is the command to run again.
 */
export function requireProviderBackups(
  plan: Pick<DeployPlan, "app" | "environment" | "target" | "servers">,
  rerun: string,
): void {
  const servers = [
    ...(isCloudTarget(plan.target)
      ? [{ name: undefined, provider: plan.target.provider, backups: plan.target.backups }]
      : []),
    ...extraCloudServers(plan),
  ];
  const refused = servers.find(
    ({ provider, backups }) => backups && !providerProfile(provider).providerBackups,
  );
  if (refused === undefined) return;
  const { name, provider } = refused;
  const field = name === undefined ? "target.backups" : "servers[].target.backups";
  const server = name === undefined ? "The app's server" : `Server ${name}`;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${server} has automated backups on (${field}), but ${noProviderBackupsText(provider)} Nothing was changed.`,
    {
      hint: `Set ${field} to false${name === undefined ? "" : ` for server ${name}`} in ${planFile(plan)}, then run \`${rerun}\` again.`,
    },
  );
}
