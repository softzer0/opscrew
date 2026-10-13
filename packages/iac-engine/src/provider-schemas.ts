import type { IacEngine, IacRunOptions } from "@opscrew/contracts";

/**
 * Optional engine capability (not part of the `IacEngine` contract): the provider schemas of an
 * initialised directory. Engines from `createEngine` and `selectEngine` have it; check others
 * with `readsProviderSchemas`.
 */
export interface ProviderSchemaReader {
  /**
   * Runs `providers schema -json` in `dir` after `init` (reads the installed providers, no
   * network) and returns the parsed, not yet validated document. Cached per directory for the
   * engine's lifetime; a failure throws `ENGINE_FAILED` and is not cached.
   */
  providerSchemas(dir: string, options?: IacRunOptions): Promise<unknown>;
}

/** True when `engine` can read provider schemas (`ProviderSchemaReader`). */
export function readsProviderSchemas(
  engine: IacEngine,
): engine is IacEngine & ProviderSchemaReader {
  return typeof (engine as Partial<ProviderSchemaReader>).providerSchemas === "function";
}
