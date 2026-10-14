import type { CloudDeployTarget, CloudProvider, DeployTarget } from "@opscrew/plan-schema";
import { cloudTarget } from "../providers";
import type { InfraLayout } from "../types";
import { testPlan } from "./plans";

/** The six move layouts of `specs/005-retarget/plan.md` ("Templates"), in the order a move uses them. */
export const LAYOUT_NAMES = [
  "rename",
  "both",
  "switched",
  "finish",
  "abort-remove",
  "abort-rename",
] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

/** Both move directions between the two VPS providers: `[from, to]`. */
export const DIRECTIONS = [
  ["hetzner", "digitalocean"],
  ["digitalocean", "hetzner"],
] as const satisfies readonly (readonly [CloudProvider, CloudProvider])[];

/** The fixture target of a provider (the same values `testPlan` uses). */
export function testTarget(provider: CloudProvider): CloudDeployTarget {
  return cloudTarget(testPlan({ provider }).target);
}

/** A move layout from `from` (the server being replaced) to `to` (the new server). */
export function moveLayout(name: LayoutName, from: DeployTarget, to: DeployTarget): InfraLayout {
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
