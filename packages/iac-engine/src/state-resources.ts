import type { IacEngine, IacRunOptions } from "@opscrew/contracts";

/**
 * Optional engine capability (not part of the `IacEngine` contract): the managed resources a state
 * file holds. Engines from `createEngine` and `selectEngine` have it; check others with
 * `readsStateResources`.
 */
export interface StateResourceReader {
  /**
   * Runs `state list -state=<stateFile>` in an empty scratch folder: no root module, `init`,
   * provider or credential is needed, and nothing is written. An OpenTofu-encrypted state opens
   * with the same `TF_ENCRYPTION` in `options.env` as every other command (`tofuEncryptionEnv`).
   * Returns the managed resource addresses, sorted, without data sources; `[]` for a state a
   * destroy emptied. A missing file, or one the engine cannot read (encrypted without the right
   * encryption settings, or damaged), throws `ENGINE_FAILED`.
   */
  stateResources(stateFile: string, options?: IacRunOptions): Promise<string[]>;
}

/** True when `engine` can list a state file's resources (`StateResourceReader`). */
export function readsStateResources(engine: IacEngine): engine is IacEngine & StateResourceReader {
  return typeof (engine as Partial<StateResourceReader>).stateResources === "function";
}

/** `data.…` at the root or inside modules (`module.a["k"].module.b.data.…`). */
const DATA_SOURCE = /^(?:module\.[^.[]+(?:\[[^\]]*\])?\.)*data\./;

/** The managed resource addresses in `state list` output, sorted (data sources left out). */
export function managedAddresses(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !DATA_SOURCE.test(line))
    .sort();
}
