import { cloudTarget, type InfraLayout, type ServerModule } from "@opscrew/iac-templates";
import type { CloudDeployTarget, DeployTarget, Retarget } from "@opscrew/plan-schema";
import { isCloudProvider, isCloudTarget } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/**
 * The old side's cloud target (`plan.retarget.from.target`), for what only a server OpsCrew
 * created has (its module, its rename, its snapshot); throws for another side.
 */
export function previousCloud(move: Pick<Retarget, "from">): CloudDeployTarget {
  return cloudTarget(move.from.target) as CloudDeployTarget;
}

/** The old cloud server's target (`plan.retarget.from.target`) with its image filled in. */
export function previousTarget(move: Pick<Retarget, "from">): CloudDeployTarget {
  const target = previousCloud(move);
  return { ...target, image: target.image ?? providerProfile(target.provider).defaultImage };
}

/**
 * The old side's target for any side (`plan.retarget.from.target`): a cloud server's with its
 * image filled in, the user's own server or Portainer as recorded.
 */
export function oldSideTarget(move: Pick<Retarget, "from">): DeployTarget {
  const { target } = move.from;
  return isCloudTarget(target) ? previousTarget(move) : target;
}

/**
 * The root variable that lifts the delete protection of `module` in `layout`
 * (`delete_protection` for `module "server"`, `previous_delete_protection` for
 * `module "server_previous"`), or `undefined` when the layout has no such module (a side that is
 * the user's own server or Portainer is an address, not a module) or its provider has no delete
 * protection: the variable is then not declared and must never be passed.
 */
export function protectionVariable(layout: InfraLayout, module: ServerModule): string | undefined {
  const target = module === "server" ? layout.server : layout.previous;
  // Only a server OpsCrew created has a module, and so delete protection, in the root.
  if (
    target === undefined ||
    !isCloudProvider(target.provider) ||
    !providerProfile(target.provider).deleteProtection
  ) {
    return undefined;
  }
  return module === "server" ? "delete_protection" : "previous_delete_protection";
}
