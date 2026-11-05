import { type DeployPlan, DeployPlanSchema, type DeployTarget } from "@opscrew/plan-schema";
import { testTarget } from "../../__fixtures__/layouts";
import { testPlan } from "../../__fixtures__/plans";
import { portainerTestPlan } from "../../portainer-target/__fixtures__/plans";

/** The server targets a move goes between. */
export type SideName = "hetzner" | "digitalocean" | "own" | "portainer";

export const SIDES: readonly SideName[] = ["hetzner", "digitalocean", "own", "portainer"];

const isCloud = (side: SideName) => side === "hetzner" || side === "digitalocean";

/** Every move between two sides, `[from, to]`: never from a cloud provider to itself. */
export const PAIRS: readonly (readonly [SideName, SideName])[] = SIDES.flatMap((from) =>
  SIDES.filter((to) => to !== from || !isCloud(from)).map((to) => [from, to] as const),
);

/** The moves with a side that is an address (a server the user owns, or Portainer). */
export const ADDRESS_PAIRS = PAIRS.filter(([from, to]) => !isCloud(from) || !isCloud(to));

/** Options of {@link movePlan}. */
export interface MovePlanOptions {
  /** Default true: `example.com` on Cloudflare, with `www.`. */
  domain?: boolean;
  /** Default true (the web filter on a server the user owns). False: DNS only. */
  proxied?: boolean;
  /** A Portainer target's `web.records` (default true: OpsCrew manages them). */
  records?: boolean;
}

/**
 * The plan of a move to `to` (`plan.target` is already the new side): `shop` on `example.com`
 * with `www.`; Portainer serves through its Caddy (behind the user's proxy without a domain).
 */
export function movePlan(to: SideName, o: MovePlanOptions = {}): DeployPlan {
  const domain = o.domain ?? true;
  const proxied = o.proxied ?? true;
  const plan =
    to === "portainer"
      ? portainerTestPlan(
          domain
            ? {
                web: { mode: "caddy", ...(o.records === false ? {} : { records: true }) },
                domain: "example.com",
                www: true,
              }
            : { web: { mode: "proxy", port: 8080 }, domain: false },
        )
      : testPlan({ provider: to, ...(domain ? { domain: "example.com", www: true } : {}) });
  if (!domain || proxied) return plan;
  const { httpAllowedFrom: _default, ...security } = plan.security;
  return DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, proxied: false }, security });
}

/** The target of side `name`, as `plan.target` (the new side) or `plan.retarget.from.target`. */
export function sideTarget(name: SideName, o: MovePlanOptions = {}): DeployTarget {
  return isCloud(name) ? testTarget(name as "hetzner" | "digitalocean") : movePlan(name, o).target;
}
