import type { CloudDeployTarget, DeployTarget } from "@opscrew/plan-schema";
import { isCloudProvider } from "@opscrew/plan-schema";
import { wrongTarget } from "../providers";
import type { InfraLayout, LayoutSide } from "../types";

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

const isCloud = (side: LayoutSide): side is CloudDeployTarget => isCloudProvider(side.provider);

/**
 * `target` as a side of a move: a server OpsCrew creates, a server the user owns in public mode,
 * or a Portainer environment without a Cloudflare Tunnel (its app on a public address). Throws
 * {@link wrongTarget} for every other target: the move refuses them before any layout.
 */
function layoutSide(target: DeployTarget): LayoutSide {
  switch (target.provider) {
    case "hetzner":
    case "digitalocean":
      return target;
    case "own":
      if (target.access === "public") return target;
      break;
    case "portainer":
      if (target.web.mode !== "tunnel" && target.redeploy === "updater") return target;
      break;
  }
  throw wrongTarget(
    "A move's layouts point the app's DNS records at a server's public address: a server OpsCrew creates, a server you own in public mode, or a Portainer environment without a Cloudflare Tunnel.",
  );
}

/**
 * The layout `name` of a move from `from` (the side being replaced, `plan.retarget.from.target`)
 * to `to` (the new side, `plan.target`). A cloud side is a server module; a server the user owns
 * and a Portainer environment are an address, so only a cloud side being replaced gets the
 * `moved` blocks (`rename`, `abort-rename`). Both cloud providers are rendered in every layout:
 * removing a module's resources needs its provider configuration until they are gone. A new
 * Portainer side serving the app's records on Cloudflare must have `web.records: true` (its own
 * root then keeps them). Throws {@link wrongTarget} for a side without a public address.
 */
export function moveLayout(
  name: MoveLayoutName,
  from: DeployTarget,
  to: DeployTarget,
): InfraLayout {
  const previous = layoutSide(from);
  const next = layoutSide(to);
  const providers = [previous, next].filter(isCloud).map((side) => side.provider);
  const renames = isCloud(previous);
  switch (name) {
    case "rename":
      return {
        previous,
        ...(renames ? { moved: { from: "server", to: "server_previous" } } : {}),
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
        ...(renames ? { moved: { from: "server_previous", to: "server" } } : {}),
        live: "server",
        providers,
      };
  }
}
