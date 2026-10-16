import type { CloudDeployTarget, CloudProvider } from "@opscrew/plan-schema";
import { cloudTarget } from "../providers";
import { testPlan } from "./plans";

/** Both move directions between the two VPS providers: `[from, to]`. */
export const DIRECTIONS = [
  ["hetzner", "digitalocean"],
  ["digitalocean", "hetzner"],
] as const satisfies readonly (readonly [CloudProvider, CloudProvider])[];

/** The fixture target of a provider (the same values `testPlan` uses). */
export function testTarget(provider: CloudProvider): CloudDeployTarget {
  return cloudTarget(testPlan({ provider }).target);
}
