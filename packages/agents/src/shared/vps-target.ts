import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployTarget,
  isServerlessProvider,
  PORTAINER_TARGET_NO_MOVE,
  type ServerlessProvider,
} from "@opscrew/plan-schema";

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

/** The plain error of `opscrew retarget` for the localhost target, which never moves. */
export function localhostTargetNoMove(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Moving an app to or from the localhost target is not supported; OpsCrew moves apps only between cloud providers.",
    {
      hint: "Nothing runs on this computer yet: run `opscrew interview`, then `opscrew design` and `opscrew provision` for the new target.",
    },
  );
}

/**
 * The plain error of a step that does not support the localhost target yet; `what` names the
 * step, for example "`opscrew provision`".
 */
export function localhostNotSupported(what: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what} is not supported for the localhost target yet.`,
    {
      hint: "Choose a server or your Portainer as the target: run `opscrew interview`, then `opscrew design`.",
    },
  );
}

/** How the messages name the server-less targets. */
const SERVERLESS_NAMES: Readonly<Record<ServerlessProvider, string>> = {
  "cloudflare-workers": "Cloudflare hosting",
  "github-pages": "GitHub Pages",
};

/** A server-less target's name in a sentence: "Cloudflare hosting", "GitHub Pages". */
export function serverlessName(provider: ServerlessProvider): string {
  return SERVERLESS_NAMES[provider];
}

/**
 * The plain error of a step that is not available for a server-less target yet; `what` names the
 * step, for example "`opscrew provision`".
 */
export function serverlessNotSupported(what: string, provider: ServerlessProvider): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what} is not available for ${SERVERLESS_NAMES[provider]} yet.`,
    {
      hint: "Choose a server, your Portainer or this computer as the target: run `opscrew interview`, then `opscrew design`.",
    },
  );
}

/** The plain error of `opscrew retarget` for a server-less target, which does not move yet. */
export function serverlessTargetNoMove(provider: ServerlessProvider): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Moving an app to or from ${SERVERLESS_NAMES[provider]} is not available yet: moving to and from server-less targets comes with retarget anywhere.`,
    {
      hint: "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
    },
  );
}

/**
 * The provider of a target taking part in a move (`opscrew retarget`); throws
 * {@link portainerTargetNoMove} for a Portainer target, {@link localhostTargetNoMove} for the
 * localhost target and {@link serverlessTargetNoMove} for a server-less one.
 */
export function moveProvider(target: Pick<DeployTarget, "provider">): VpsProviderId {
  const { provider } = target;
  if (provider === "portainer") throw portainerTargetNoMove();
  if (provider === "localhost") throw localhostTargetNoMove();
  if (isServerlessProvider(provider)) throw serverlessTargetNoMove(provider);
  return provider;
}
