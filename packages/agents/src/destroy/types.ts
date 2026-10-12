import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type { HetznerClient } from "@opscrew/connector-hetzner";
import type { ResourceChange } from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { ProvisionServices } from "../provision";

/** The Hetzner calls the snapshot step needs (a `HetznerClient` or a test fake). */
export type HetznerSnapshotApi = Pick<
  HetznerClient,
  "listServers" | "createSnapshot" | "waitForAction"
>;

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
  /** Hetzner API for the snapshot (default: client from `HCLOUD_TOKEN`). */
  hetznerClient?: HetznerSnapshotApi;
  /** Delay between snapshot status polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds for the snapshot wait. */
  now?: () => number;
}

export interface DestroyOptions {
  /**
   * Take a Hetzner snapshot of the server before deleting it. `auto` (the default) takes one when
   * the server holds the database (self-hosted Postgres) or Hetzner backups are on.
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
  resources: ResourceChange[];
  /** True when a snapshot is taken before anything is deleted (announced before the prompt). */
  snapshot: boolean;
  /** Plain-English warning about data that lives only on the server, when there is any. */
  dataWarning?: string;
}

export interface DestroyResult {
  /** Hetzner image id of the snapshot taken before the destroy, when one was taken. */
  snapshotImageId?: number;
  /** Resources the applied destroy plan deleted (empty when nothing was left to delete). */
  destroyed: ResourceChange[];
  /** GitHub Actions secrets removed from the repository (names only). */
  secretsRemoved: string[];
  /** Plain-English list of what still exists and what the user may want to do about it. */
  remaining: string[];
}
