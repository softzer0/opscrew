/** The public shapes of `opscrew snapshot`, `snapshot list` and `snapshot delete` (feature 024). */
import type { GitHubClient } from "@opscrew/connector-github";
import type { ServerSnapshotApi } from "@opscrew/contracts";
import type { CloudProvider } from "@opscrew/plan-schema";
import type { LocalhostServices } from "../localhost/services";
import type { PortainerServices, ProvisionServices } from "../provision/types";

/**
 * Collaborators that talk to the outside world. Each defaults to the real implementation built
 * from `PhaseDeps`; tests replace them with fakes.
 */
export interface SnapshotServices {
  /** The deploy workflow's runs (default: a client with the user's token); `null` means no token. */
  github?: Pick<GitHubClient, "listWorkflowRuns"> | null;
  /** A server's shell, given its address (default: ssh with the login `opscrew logs` uses). */
  remote?: ProvisionServices["remote"];
  /** This computer (`target.provider: localhost`). */
  localhost?: LocalhostServices;
  /** The user's Portainer: its client (default: pinned to the confirmed certificate). */
  portainer?: PortainerServices;
  /**
   * A provider's whole-server snapshots (default: its connector with its token); `undefined` when
   * no token is set.
   */
  serverSnapshots?: (provider: CloudProvider) => ServerSnapshotApi | undefined;
}

/**
 * How a snapshot was taken: by hand, before a release (019's), on the schedule, or a provider's
 * snapshot of the whole server.
 */
export type SnapshotKind = "manual" | "release" | "scheduled" | "server";

/** One service's part of a data snapshot. */
export interface SnapshotService {
  /** The service's name, or `sqlite` for the app's SQLite volume. */
  name: string;
  /** Its kind (`postgres`, `kafka`, `sqlite`…). */
  kind: string;
  /** The server that holds its part: `app` or an extra server's name (absent elsewhere). */
  server?: string;
  /**
   * `copied`, with its file's size in bytes when known; `skipped`: left out (`--skip`, a stop-only
   * service not named, or nothing to copy); `failed`: its copy failed (Portainer's schedule).
   */
  state: "copied" | "skipped" | "failed";
  size?: number;
}

/** One snapshot, as `opscrew snapshot list` shows it, the same in `--json`. */
export interface SnapshotEntry {
  /** Its id: the UTC time (`20261106T190000Z`), a release's digest, or the provider's id. */
  id: string;
  kind: SnapshotKind;
  /** When it was taken (ISO). */
  taken: string;
  /** The version that ran (`sha256:<hex>`); empty when unknown, and for a whole server. */
  version: string;
  /** Its size in bytes: the files' sizes added up, or the provider's billed size. */
  size?: number;
  /** The services it holds; none for a whole server. */
  services: SnapshotService[];
  /** Where it is, in words: `on the app's server`, `in your Portainer`, `at Hetzner`… */
  where: string;
  /** True when every part has its off-server copy (`offsite.done`). */
  offsite: boolean;
  /** A whole-server snapshot's provider and server. */
  server?: { provider: CloudProvider; id: string; name: string };
}

export interface TakeSnapshotOptions {
  /** `--skip <service>`: services left out of the snapshot. */
  skip?: readonly string[];
  services?: SnapshotServices;
}

/** A snapshot `opscrew snapshot` took. */
export interface TakenSnapshot {
  id: string;
  /** Where it is, in words. */
  where: string;
  /** Each service's part, copied or left out. */
  services: SnapshotService[];
}

export interface SnapshotCommandOptions {
  services?: SnapshotServices;
}

/** A snapshot `opscrew snapshot delete` removed, or found already gone. */
export interface DeletedSnapshot {
  id: string;
  where: string;
  outcome: "deleted" | "already gone";
}
