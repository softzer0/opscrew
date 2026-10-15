import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployProvider,
  type DeployTarget,
  isVpsTarget,
  PORTAINER_TARGET_NO_MOVE,
  PORTAINER_TARGET_NOT_YET,
  type VpsDeployTarget,
} from "@opscrew/plan-schema";

/**
 * The plain error of a command that does not handle a Portainer target yet. The Portainer tasks
 * of feature 010 replace these calls.
 */
export function portainerTargetNotYet(): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", PORTAINER_TARGET_NOT_YET.message, {
    hint: PORTAINER_TARGET_NOT_YET.hint,
  });
}

/** The plain error of `opscrew retarget` for a Portainer target, which never moves. */
export function portainerTargetNoMove(): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", PORTAINER_TARGET_NO_MOVE.message, {
    hint: PORTAINER_TARGET_NO_MOVE.hint,
  });
}

/** `target` when the app runs on one server; throws {@link portainerTargetNotYet} for Portainer. */
export function vpsTarget(target: DeployTarget): VpsDeployTarget {
  if (!isVpsTarget(target)) throw portainerTargetNotYet();
  return target;
}

/** `provider` when it names a single server's provider; throws {@link portainerTargetNotYet}. */
export function vpsProvider(provider: DeployProvider): VpsProviderId {
  if (provider === "portainer") throw portainerTargetNotYet();
  return provider;
}

/**
 * The provider of a target taking part in a move (`opscrew retarget`); throws
 * {@link portainerTargetNoMove} for a Portainer target.
 */
export function moveProvider(target: Pick<DeployTarget, "provider">): VpsProviderId {
  if (target.provider === "portainer") throw portainerTargetNoMove();
  return target.provider;
}
