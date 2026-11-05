import { cloudTarget, type InfraLayout, type ServerModule } from "@opscrew/iac-templates";
import type { CloudDeployTarget, Retarget } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/**
 * The old server's cloud target (`plan.retarget.from.target`). Until the move's sides cover the
 * user's own server and Portainer, every move starts from a server OpsCrew created.
 */
export function previousCloud(move: Pick<Retarget, "from">): CloudDeployTarget {
  return cloudTarget(move.from.target) as CloudDeployTarget;
}

/** The old server's target (`plan.retarget.from.target`) with its image filled in. */
export function previousTarget(move: Pick<Retarget, "from">): CloudDeployTarget {
  const target = previousCloud(move);
  return { ...target, image: target.image ?? providerProfile(target.provider).defaultImage };
}

/**
 * The root variable that lifts the delete protection of `module` in `layout`
 * (`delete_protection` for `module "server"`, `previous_delete_protection` for
 * `module "server_previous"`), or `undefined` when the layout has no such module or its provider
 * has no delete protection: the variable is then not declared and must never be passed.
 */
export function protectionVariable(layout: InfraLayout, module: ServerModule): string | undefined {
  const target = module === "server" ? layout.server : layout.previous;
  if (target === undefined || !providerProfile(target.provider).deleteProtection) {
    return undefined;
  }
  return module === "server" ? "delete_protection" : "previous_delete_protection";
}
