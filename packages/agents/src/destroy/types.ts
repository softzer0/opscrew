import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type { ResourceChange, ServerSnapshotApi, VpsProviderId } from "@opscrew/contracts";
import type { EnginePreference } from "@opscrew/iac-engine";
import type { ServerlessProvider } from "@opscrew/plan-schema";
import type { OwnServerServices, ProvisionServices } from "../provision";
import type { PortainerServices } from "../provision/types";

/**
 * The GitHub calls the cleanup needs (a `GitHubClient` or a test fake): the deploy secrets, the
 * GitHub environment that holds them when they live in one, the scheduled check's pause, and for
 * the user's Portainer its deploy branch (without `deleteBranch` the branch stays and is listed
 * under what remains).
 */
export type DestroyGitHubApi = Pick<
  GitHubClient,
  | "deleteActionsSecret"
  | "deleteEnvironmentSecret"
  | "deleteEnvironment"
  | "getRepoVariable"
  | "setRepoVariable"
  | "deleteRepoVariable"
> &
  Partial<Pick<GitHubClient, "deleteBranch">>;

/** The Cloudflare call the credential check needs (a `CloudflareClient` or a test fake). */
export type DestroyCloudflareApi = Pick<CloudflareClient, "verifyToken">;

/**
 * Collaborators that talk to the outside world, as in provisioning. Each defaults to the real
 * implementation built from `PhaseDeps` (env, fetch, runner); tests replace them with fakes.
 */
export interface DestroyServices
  extends Pick<
    ProvisionServices,
    "engine" | "provider" | "sharedCloudflare" | "runnerGitHub" | "runnerMachine" | "remote"
  > {
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
  /** A server the user owns: its shell, the host adapter and the login check (fakes in tests). */
  own?: OwnServerServices;
  /** The user's Portainer: its client and the teardown's bounded wait (fakes in tests). */
  portainer?: Pick<PortainerServices, "client" | "wait">;
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
   * the CLI shows the list and has the user type the server name (on a server the user owns, the
   * app's name; ask with `preview.confirmPrompt`). Returning false stops the run
   * with nothing changed. Without it, the approvals of each plan are the only confirmation.
   */
  confirm?: (preview: DestroyPreview) => Promise<boolean>;
  /**
   * A server the user owns: also delete the app's data (`/srv/data`, its Docker volumes and
   * Portainer's data). Off by default: OpsCrew takes no snapshot of the user's own server, so the
   * data is kept unless asked for; deleting it needs the teardown approval with `allowDestroy` and
   * the typed app name. The user's Portainer: also delete the app stack's recorded volumes (the
   * stack teardown plan's approval with `allowDestroy` and the typed app name); a later run with
   * it deletes the volumes an earlier teardown kept. On a server, also delete the app's bucket at
   * a provider (the `storage` root) with its files, through its own destroy plan with the same
   * typed name (R2 deletes an empty bucket only).
   */
  deleteData?: boolean;
  /**
   * A server the user owns: after removing the app, also reverse OpsCrew's own host changes (deploy
   * user, SSH and firewall settings, automatic updates, runtime directories), as a separate host
   * plan with its own `host-apply` approval (`--undo-host`). Also works after an earlier destroy.
   */
  undoHost?: boolean;
  /**
   * A server the user owns: `--host-key SHA256:…`, the fingerprint to trust on the first
   * connection from this computer when nobody can answer a prompt.
   */
  hostKey?: string;
  /**
   * GitHub Pages: also delete GitHub's domain verification record (`--delete-verification`), last
   * and through its own destroy plan. Without it the record stays, so the domain stays verified.
   */
  deleteVerification?: boolean;
}

/**
 * Where a deletion happens: a provider's server, a server the user owns, the user's Portainer, or
 * a server-less target (Cloudflare's hosting, GitHub Pages).
 */
export type DeletionProvider = VpsProviderId | "portainer" | ServerlessProvider;

/** What the teardown would delete, shown before the user confirms. */
export interface DestroyPreview {
  /**
   * The name the user types to confirm: the server's (the app's name) or, on their own server, the
   * app's; for an extra cloud server (`server` set), its name at the provider, `<app>-<server>`.
   */
  name: string;
  /**
   * Set when the confirmation is for an extra cloud server, asked after the app's (each one's name
   * is typed): its name in the plan.
   */
  server?: string;
  /** With extra servers, a line per server (`serverLines`): what happens to it. */
  servers?: string[];
  /**
   * The question to ask before the user types {@link name} (`destroyConfirmPrompt`); set by
   * `opscrew destroy`. On a server the user owns it asks for the app's name and says the server stays.
   */
  confirmPrompt?: string;
  /** The planned provider (`portainer` for the user's Portainer). */
  provider: DeletionProvider;
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
  /**
   * A server the user owns: what the teardown host plan removes from the server (step titles). The
   * server itself always stays.
   */
  hostSteps?: string[];
  /**
   * The user's Portainer: what the stack teardown plan removes there (change titles). Portainer
   * itself and everything OpsCrew did not create always stay.
   */
  stackChanges?: string[];
  /** GitHub Pages: what the Pages plan changes after the DNS records are deleted (step titles). */
  pagesChanges?: string[];
  /**
   * The Cloudflare plan that removes this app's hostnames from OpsCrew's shared rules in the zone,
   * in words, when it changes something (approved with `allowDestroy` and the same typed name).
   */
  cloudflarePlan?: string;
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
  /**
   * A server the user owns: the SHA-256 hashes of the host plans this run applied (their files are
   * `.opscrew/plans/host-<hash>.json`): the teardown and, with `undoHost`, the undo.
   */
  hostPlans?: { teardown?: string; undo?: string };
  /**
   * The user's Portainer: the SHA-256 hash of the stack teardown plan this run applied (its file,
   * `.opscrew/plans/stack-<hash>.json`, is deleted once the stacks are gone).
   */
  stackPlan?: string;
}
