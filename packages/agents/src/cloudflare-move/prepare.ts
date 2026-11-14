/** Prepare: the app's side in the new account, built while the old one serves (`opscrew cloudflare move`). */
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";

export async function prepareMove(_deps: PhaseDeps, _options: unknown): Promise<never> {
  throw new OpsCrewError(
    "INTERNAL",
    "Moving an app to another Cloudflare account is not built yet.",
  );
}
