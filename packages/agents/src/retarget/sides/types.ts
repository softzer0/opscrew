/**
 * One side of a move (ADR 0027 D1): the old target or the new one. `opscrew retarget`'s steps ask
 * the sides; each target kind implements it once (`cloud` and `own` over SSH, `portainer` through
 * its API). Written by the lead (T2301); T2307 implements the SSH sides, T2308 Portainer's.
 */
import type { DockerClient, VolumeCarrier } from "@opscrew/connector-docker";
import type { DestroyPreview } from "../../destroy/types";
import type { MoveSession } from "../session";
import type { RetargetResult } from "../types";

/** The kinds of side: a server OpsCrew created, the user's own server, the user's Portainer. */
export type MoveSideKind = "cloud" | "own" | "portainer";

/**
 * One named volume on a side. Volumes are paired across the sides by `owner` and `key`, never by
 * Docker's name, which differs between Compose projects.
 */
export interface SideVolume {
  /** The service whose volume it is; `app` for the app's own, `monitoring` for its stack's. */
  owner: string;
  /** Compose's volume key (the `com.docker.compose.volume` label): the same on both sides. */
  key: string;
  /** Docker's name of the volume on this side. */
  name: string;
  /** Its size in bytes (`system/df`), for the summary's minutes. */
  bytes: number;
}

/**
 * The Docker API on a side's server, with the carrier that reads, empties, writes and hashes its
 * volumes (the pinned `busybox`). `close` ends the connection (an SSH session, say).
 */
export interface SideDocker {
  client: DockerClient;
  carrier: VolumeCarrier;
  close(): Promise<void>;
}

/**
 * A step that stopped before an apply a script must approve (`--approve <hash>`), or `undefined`
 * once the side's part of the step is done.
 */
export type SideStop = RetargetResult | undefined;

/**
 * A side of a move. Every method acts on the app of `session.plan` and changes only what the move
 * made or the app owns: never the user's server, Portainer or its environment (SC-2304). Each
 * change it makes goes through its approval (an IaC plan, a host plan or a stack plan by hash; the
 * window's container and volume changes under the window's one `remote-exec` approval).
 */
export interface MoveSide {
  readonly kind: MoveSideKind;
  /** Opens the Docker API on this side's server. The caller closes it. */
  docker(session: MoveSession): Promise<SideDocker>;
  /**
   * Step `created` (the new side): the server or environment made ready for the app, through its
   * approval: a cloud server's IaC plan, the own server's host plan, Portainer's stacks' setup.
   */
  prepare(session: MoveSession): Promise<SideStop>;
  /**
   * Step `deployed` (the new side): the app deployed with the image the old side runs, healthy,
   * and its edge stopped, so it takes no traffic before the switch.
   */
  deploy(session: MoveSession): Promise<SideStop>;
  /** Stops the app, its workers and its cron (not its stateful services, not the edge). */
  stopApp(session: MoveSession): Promise<void>;
  /** Starts what {@link stopApp} stopped. */
  startApp(session: MoveSession): Promise<void>;
  /** Stops the named stateful services cleanly (Compose service names). */
  stopServices(session: MoveSession, names: readonly string[]): Promise<void>;
  /** Starts the named stateful services. */
  startServices(session: MoveSession, names: readonly string[]): Promise<void>;
  /** Stops the edge (Caddy or nginx and kamal-proxy, or the stack's Caddy on Portainer). */
  stopEdge(session: MoveSession): Promise<void>;
  /** Starts the edge. */
  startEdge(session: MoveSession): Promise<void>;
  /** Whether the app answers its health route on this side. */
  healthy(session: MoveSession): Promise<boolean>;
  /** The app's named volumes on this side: its services', its own and its monitoring stack's. */
  volumes(session: MoveSession): Promise<SideVolume[]>;
  /**
   * `--finish` (the old side) and `--abort` (the new side): removes what the move made or left
   * there after `confirm` (the typed name): a cloud server through its IaC plan; on the user's
   * server, only the app (a teardown host plan); on Portainer, only the app's stacks and volumes.
   */
  remove(
    session: MoveSession,
    confirm: (preview: DestroyPreview) => Promise<boolean>,
  ): Promise<SideStop>;
}
