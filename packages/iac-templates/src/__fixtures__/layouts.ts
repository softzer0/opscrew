import type { CloudDeployTarget, CloudProvider } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { cloudTarget } from "../providers";
import { testPlan } from "./plans";

/** Every move direction between two cloud providers: `[from, to]`. */
export const DIRECTIONS: readonly (readonly [CloudProvider, CloudProvider])[] =
  CLOUD_PROVIDERS.flatMap(({ id: from }) =>
    CLOUD_PROVIDERS.filter(({ id }) => id !== from).map(
      ({ id: to }) => [from as CloudProvider, to as CloudProvider] as const,
    ),
  );

/**
 * The move directions between Hetzner and DigitalOcean, whose rendered files the snapshots hold
 * (SC-2602); the other directions are checked by the tests that iterate {@link DIRECTIONS}.
 */
export const SNAPSHOT_DIRECTIONS = DIRECTIONS.filter(([from, to]) =>
  [from, to].every((provider) => provider === "hetzner" || provider === "digitalocean"),
);

/** The fixture target of a provider (the same values `testPlan` uses). */
export function testTarget(provider: CloudProvider): CloudDeployTarget {
  return cloudTarget(testPlan({ provider }).target);
}
