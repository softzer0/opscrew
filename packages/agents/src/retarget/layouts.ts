import type { InfraLayout, ServerModule } from "@opscrew/iac-templates";
import type { CloudDeployTarget, DeployTarget, Retarget } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";

/** The old server's target (`plan.retarget.from.target`) with its image filled in. */
export function previousTarget(move: Pick<Retarget, "from">): CloudDeployTarget {
  const target = move.from.target;
  return { ...target, image: target.image ?? providerProfile(target.provider).defaultImage };
}

/**
 * The root-module layouts of a move (specs/005-retarget/plan.md, "Templates"), in the order a
 * move uses them: `rename` (moves-only: the live server becomes `module.server_previous`), `both`
 * (the new server is created as `module.server`), `switched` (DNS follows the new server),
 * `finish` (the old server is removed), `abort-remove` (the new server is removed) and
 * `abort-rename` (moves-only: the old server becomes `module.server` again).
 */
export const MOVE_LAYOUTS = [
  "rename",
  "both",
  "switched",
  "finish",
  "abort-remove",
  "abort-rename",
] as const;
export type MoveLayoutName = (typeof MOVE_LAYOUTS)[number];

/**
 * The layout `name` of a move from `from` (the server being replaced, `plan.retarget.from.target`)
 * to `to` (the new server, `plan.target`). Both providers are rendered in every layout: removing
 * a module's resources needs its provider configuration until they are gone.
 */
export function moveLayout(
  name: MoveLayoutName,
  from: DeployTarget,
  to: DeployTarget,
): InfraLayout {
  const providers = [from.provider, to.provider];
  switch (name) {
    case "rename":
      return {
        previous: from,
        moved: { from: "server", to: "server_previous" },
        live: "server_previous",
        providers,
      };
    case "both":
      return { server: to, previous: from, live: "server_previous", providers };
    case "switched":
      return { server: to, previous: from, live: "server", providers };
    case "finish":
      return { server: to, live: "server", providers };
    case "abort-remove":
      return { previous: from, live: "server_previous", providers };
    case "abort-rename":
      return {
        server: from,
        moved: { from: "server_previous", to: "server" },
        live: "server",
        providers,
      };
  }
}

/**
 * The root variable that lifts the delete protection of `module` in `layout`
 * (`delete_protection` for `module "server"`, `previous_delete_protection` for
 * `module "server_previous"`), or `undefined` when the layout has no such module or its provider
 * has no delete protection: the variable is then not declared and must never be passed.
 */
export function protectionVariable(layout: InfraLayout, module: ServerModule): string | undefined {
  const target = module === "server" ? layout.server : layout.previous;
  if (target === undefined || !providerProfile(target.provider).deleteProtection) return undefined;
  return module === "server" ? "delete_protection" : "previous_delete_protection";
}
