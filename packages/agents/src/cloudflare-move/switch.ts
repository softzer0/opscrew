/** The switch: the zone's nameservers moved to the new account (`opscrew cloudflare move`). */
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";

export async function switchMove(_deps: PhaseDeps, _options: unknown): Promise<never> {
  throw new OpsCrewError(
    "INTERNAL",
    "Moving an app to another Cloudflare account is not built yet.",
  );
}
