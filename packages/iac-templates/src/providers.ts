import { OpsCrewError, orText } from "@opscrew/core";
import {
  type CloudProvider,
  type DeployTarget,
  isCloudProvider,
  type PortainerDeployTarget,
  type ServerlessProvider,
} from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";

/**
 * The plain error for code reached with a target it does not handle. Every renderer is called
 * for the targets it knows, so this is a bug in OpsCrew.
 */
export function wrongTarget(message: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", message, {
    hint: "This is a bug in OpsCrew: please report it with the command you ran.",
  });
}

/**
 * `target` when OpsCrew creates the server on one of its cloud providers: a plan's target, a
 * server of a move layout, or just `{ provider }`. Throws {@link wrongTarget} for every other
 * target: a server the user owns, a Portainer, the localhost target and the server-less ones.
 */
export function cloudTarget<T extends Pick<DeployTarget, "provider">>(
  target: T,
): T & { provider: CloudProvider } {
  const { provider } = target;
  if (!isCloudProvider(provider)) {
    throw wrongTarget(
      `This step only applies to servers OpsCrew creates on ${orText(CLOUD_PROVIDERS.map((cloud) => cloud.displayName))}, not to ${NOT_CLOUD[provider]}.`,
    );
  }
  return target as T & { provider: CloudProvider };
}

/** How {@link cloudTarget} names a target that is not a cloud server. */
const NOT_CLOUD = {
  own: "a server you already own",
  portainer: "an app in your existing Portainer",
  localhost: "an app on this computer (the localhost target)",
  "cloudflare-workers": "an app on Cloudflare's hosting",
  "github-pages": "a site on GitHub Pages",
} as const satisfies Record<Exclude<DeployTarget["provider"], CloudProvider>, string>;

/**
 * The {@link wrongTarget} error for code for servers reached with a server-less target
 * (Cloudflare's hosting, GitHub Pages), which has no `what` (for example `Compose file`).
 */
export function notOnServer(provider: ServerlessProvider, what: string): OpsCrewError {
  return wrongTarget(
    `This step only applies to an app on a server, not to ${NOT_CLOUD[provider]}, which has no ${what}.`,
  );
}

/** `target` when the app runs in the user's existing Portainer; throws {@link wrongTarget} otherwise. */
export function portainerTarget(target: DeployTarget): PortainerDeployTarget {
  if (target.provider !== "portainer") {
    throw wrongTarget(
      "This step only applies to an app OpsCrew deploys into your existing Portainer.",
    );
  }
  return target;
}
