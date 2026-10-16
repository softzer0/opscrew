import type { DeployTarget } from "@opscrew/plan-schema";
import { cloudTarget } from "../providers";
import type { InfraLayout } from "../types";

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
 * a module's resources needs its provider configuration until they are gone. Moves are only
 * between servers OpsCrew creates: throws for a server the user owns and a Portainer target.
 */
export function moveLayout(
  name: MoveLayoutName,
  from: DeployTarget,
  to: DeployTarget,
): InfraLayout {
  const previous = cloudTarget(from);
  const next = cloudTarget(to);
  const providers = [previous.provider, next.provider];
  switch (name) {
    case "rename":
      return {
        previous,
        moved: { from: "server", to: "server_previous" },
        live: "server_previous",
        providers,
      };
    case "both":
      return { server: next, previous, live: "server_previous", providers };
    case "switched":
      return { server: next, previous, live: "server", providers };
    case "finish":
      return { server: next, live: "server", providers };
    case "abort-remove":
      return { previous, live: "server_previous", providers };
    case "abort-rename":
      return {
        server: previous,
        moved: { from: "server_previous", to: "server" },
        live: "server",
        providers,
      };
  }
}
