/** Finish: the app's state, secrets and connector on the new account, and the old account's pieces removed (`opscrew cloudflare move`). */
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";

export async function finishMove(_deps: PhaseDeps, _options: unknown): Promise<never> {
  throw new OpsCrewError(
    "INTERNAL",
    "Moving an app to another Cloudflare account is not built yet.",
  );
}
