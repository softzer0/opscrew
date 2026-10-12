import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type { ResourceChange, ServerSnapshotApi, VpsProviderId } from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { ProvisionServices } from "../provision";

/** The GitHub call the secret cleanup needs (a `GitHubClient` or a test fake). */
export type DestroyGitHubApi = Pick<GitHubClient, "deleteActionsSecret">;

/** The Cloudflare call the credential check needs (a `CloudflareClient` or a test fake). */
export type DestroyCloudflareApi = Pick<CloudflareClient, "verifyToken">;

/**
 * Collaborators that talk to the outside world, as in provisioning. Each defaults to the real
 * implementation built from `PhaseDeps` (env, fetch, runner); tests replace them with fakes.
 */
export interface DestroyServices extends Pick<ProvisionServices, "engine" | "provider"> {
  /** Cloudflare API (default: client from `CLOUDFLARE_API_TOKEN`); `null` means no token. */
  cloudflare?: DestroyCloudflareApi | null;
  /** GitHub REST API (default: client from `resolveGitHubToken`); `null` means no token. */
  github?: DestroyGitHubApi | null;
  /**
   * Server lookup and snapshots of the planned provider (default: the provider connector's
   * `servers`, built from its token).
   */
  servers?: ServerSnapshotApi;
  /** Delay between snapshot status polls (passed to the default connector). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds for the snapshot wait (passed to the default connector). */
  now?: () => number;
}

export interface DestroyOptions {
  /**
   * Take a snapshot of the server before deleting it. `auto` (the default) takes one when the
   * server holds the database (self-hosted Postgres) or the provider's automatic backups are on.
   */
  snapshot?: "auto" | boolean;
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  services?: DestroyServices;
  /**
   * Asked once after the preview and before anything changes (the snapshot, the protection lift):
   * the CLI shows the list and has the user type the server name. Returning false stops the run
   * with nothing changed. Without it, the approvals of each plan are the only confirmation.
   */
  confirm?: (preview: DestroyPreview) => Promise<boolean>;
}

/** What the teardown would delete, shown before the user confirms. */
export interface DestroyPreview {
  /** The server name the user types to confirm. */
  name: string;
  /** The planned provider. */
  provider: VpsProviderId;
  /**
   * False when the provider has no delete protection (DigitalOcean): the server is deleted as soon
   * as the approved destroy plan is applied, with no protection-lifting step before it.
   */
  deleteProtection: boolean;
  resources: ResourceChange[];
  /** True when a snapshot is taken before anything is deleted (announced before the prompt). */
  snapshot: boolean;
  /** Plain-English warning about data that lives only on the server, when there is any. */
  dataWarning?: string;
}

export interface DestroyResult {
  /**
   * Provider id of the snapshot taken (or reused) before the destroy, when there is one: the
   * Hetzner image id or the DigitalOcean snapshot id.
   */
  snapshotId?: string;
  /** Resources the applied destroy plan deleted (empty when nothing was left to delete). */
  destroyed: ResourceChange[];
  /** GitHub Actions secrets removed from the repository (names only). */
  secretsRemoved: string[];
  /** Plain-English list of what still exists and what the user may want to do about it. */
  remaining: string[];
}
