import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type DeployTarget, PORTAINER_TARGET_NO_MOVE } from "@opscrew/plan-schema";

/** The plain error of `opscrew retarget` for a Portainer target, which never moves. */
export function portainerTargetNoMove(): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", PORTAINER_TARGET_NO_MOVE.message, {
    hint: PORTAINER_TARGET_NO_MOVE.hint,
  });
}

/** The plain error of `opscrew retarget` for a server the user owns, which never moves. */
export function ownServerNoMove(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Moving an app to or from a server you already own is not supported; OpsCrew moves apps only between cloud providers.",
    {
      hint: "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
    },
  );
}

/**
 * The provider of a target taking part in a move (`opscrew retarget`); throws
 * {@link portainerTargetNoMove} for a Portainer target.
 */
export function moveProvider(target: Pick<DeployTarget, "provider">): VpsProviderId {
  if (target.provider === "portainer") throw portainerTargetNoMove();
  return target.provider;
}
