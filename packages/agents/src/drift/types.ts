import type {
  IacEngineInfo,
  ResourceChange,
  ResourceDrift,
  VpsProviderId,
} from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { ProvisionServices } from "../provision/types";
import type { HostDrift } from "./host";

export interface DriftOptions {
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  /**
   * A server the user owns: `--host-key SHA256:…`, the fingerprint to trust on the first
   * connection from this computer when nobody can answer a prompt.
   */
  hostKey?: string;
  /** Engine, cloud provider, Cloudflare and own-server fakes for tests (same shape as provision's). */
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
  /**
   * A server the user owns: how it differs from what OpsCrew set up (SSH settings, firewall rules,
   * deploy user, runtime directories, the add-on and app containers). Never an address or secret.
   */
  host?: HostDrift;
  /** True when nothing drifted, nothing is pending and every file (and the server) matches. */
  clean: boolean;
  engine: IacEngineInfo;
  /** ISO time of the check. */
  checkedAt: string;
  /** Cloud provider of the deployment, named in the report (absent in reports made before 004). */
  provider?: VpsProviderId;
  /**
   * Plain-English remarks about the check itself, for example that the provider schemas could
   * not be read, so values the cloud maintains itself may show as drift. Absent when there are none.
   */
  notes?: string[];
}
