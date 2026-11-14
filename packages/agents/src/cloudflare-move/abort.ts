/** Abort, before the switch only: the app's side in the new account removed (`opscrew cloudflare move`). */
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";

export async function abortMove(_deps: PhaseDeps, _options: unknown): Promise<never> {
  throw new OpsCrewError(
    "INTERNAL",
    "Moving an app to another Cloudflare account is not built yet.",
  );
}
