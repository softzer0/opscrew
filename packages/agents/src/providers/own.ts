import { OpsCrewError } from "@opscrew/core";
import type { CloudDeployTarget, DeployTarget } from "@opscrew/plan-schema";

/**
 * The plain error for a server the user already owns (`target.provider: own`) where a phase only
 * knows servers OpsCrew creates. Own servers arrive with the rest of feature 009, whose tasks
 * replace these calls.
 */
export function ownServerNotYet(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "This version of OpsCrew cannot yet deploy to a server you already own; it only creates servers on Hetzner Cloud or DigitalOcean.",
    {
      hint: "Choose Hetzner Cloud or DigitalOcean with `opscrew interview` and `opscrew design`. Servers you already own arrive with the rest of feature 009.",
    },
  );
}

/**
 * `target` when OpsCrew creates the server (Hetzner Cloud, DigitalOcean); throws
 * {@link ownServerNotYet} for a server the user owns.
 */
export function cloudTarget(target: DeployTarget): CloudDeployTarget {
  if (target.provider === "own") throw ownServerNotYet();
  return target;
}
