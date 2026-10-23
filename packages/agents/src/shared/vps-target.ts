import type { VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployProvider,
  type DeployTarget,
  PORTAINER_TARGET_NO_MOVE,
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

/** True for a target on one server: Hetzner Cloud, DigitalOcean or a server the user owns. */
export function onOneServer(provider: DeployProvider): provider is VpsProviderId {
  return provider === "hetzner" || provider === "digitalocean" || provider === "own";
}

/** The server-less targets (feature 016), by their name in a sentence. */
const SERVERLESS_NAMES = {
  "cloudflare-workers": "Cloudflare hosting",
  "github-pages": "GitHub Pages",
} as const;

/** A target with no server of the user's: Cloudflare's hosting or GitHub Pages. */
export type ServerlessProvider = keyof typeof SERVERLESS_NAMES;

/** True for Cloudflare's hosting and GitHub Pages, which have no server. */
export function isServerless(provider: string | undefined): provider is ServerlessProvider {
  return provider !== undefined && Object.hasOwn(SERVERLESS_NAMES, provider);
}

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
  if (isServerless(provider)) throw serverlessTargetNoMove(provider);
  return provider;
}
