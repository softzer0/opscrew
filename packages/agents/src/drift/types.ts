import type { IacEngineInfo, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { ProvisionServices } from "../provision/types";

export interface DriftOptions {
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  /** Engine, Hetzner and Cloudflare fakes for tests (same shape as provision's). */
  services?: ProvisionServices;
}

/** Result of `opscrew drift`. Holds resource addresses, attribute names and paths, never values. */
export interface DriftReport {
  /** Resources changed outside OpsCrew (console, API), sorted by address. */
  drift: ResourceDrift[];
  /** What `opscrew provision` would change now (code not applied yet, or undoing drift). */
  pending: ResourceChange[];
  /**
   * Repository files that differ from what OpsCrew renders from `opscrew/plan.yaml`: `changed`
   * were edited, `created` are missing (OpsCrew would add them). Sorted repo-relative paths.
   */
  files: { changed: string[]; created: string[] };
  /**
   * DNS records at the app's hostnames that OpsCrew did not create (someone replaced or added one
   * in the Cloudflare dashboard). Type, name and content, sorted by name.
   */
  foreignDnsRecords: { type: string; name: string; content: string }[];
  /** True when nothing drifted, nothing is pending and every file matches. */
  clean: boolean;
  engine: IacEngineInfo;
  /** ISO time of the check. */
  checkedAt: string;
}
