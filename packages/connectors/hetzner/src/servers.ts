import type {
  AppServer,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { HetznerClient } from "./client";

/** Default wait for a snapshot or a rebuild to finish (15 minutes). */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** The label every snapshot OpsCrew takes carries (never `managed-by`, so cleanups keep it). */
const OPSCREW_SNAPSHOTS = "created-by=opscrew";

/**
 * Server lookup, snapshots and rebuilds for the provider-neutral teardown and snapshot commands,
 * backed by `HetznerClient`.
 */
export function hetznerServerApi(client: HetznerClient): ServerSnapshotApi {
  return {
    async findAppServers(app: string): Promise<AppServer[]> {
      const servers = await client.listServers({
        labelSelector: `managed-by=opscrew,app=${app}`,
      });
      return servers.map((server) => ({
        id: String(server.id),
        name: server.name,
        status: server.status,
      }));
    },
    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const { imageId, actionId } = await client.createSnapshot(numericId(serverId, "server"), {
        description: request.description,
        labels: request.labels,
      });
      await client.waitForAction(actionId, {
        timeoutMs: request.timeoutMs ?? ACTION_TIMEOUT_MS,
      });
      return { snapshotId: String(imageId) };
    },
    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      const images = await client.listSnapshots(numericId(serverId, "server"), OPSCREW_SNAPSHOTS);
      return images
        .map((image) => ({
          id: String(image.id),
          name: image.description ?? "",
          createdAt: image.created,
          ...(typeof image.image_size === "number" && { sizeGb: image.image_size }),
          labels: { ...image.labels },
        }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async deleteSnapshot(snapshotId: string): Promise<void> {
      await client.deleteImage(numericId(snapshotId, "snapshot"));
    },
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const { actionId } = await client.rebuildServer(
        numericId(serverId, "server"),
        numericId(snapshotId, "snapshot"),
      );
      await client.waitForAction(actionId, { timeoutMs: ACTION_TIMEOUT_MS });
    },
  };
}

/** `value` as a Hetzner numeric id; anything else is refused before calling the API. */
function numericId(value: string, what: "server" | "snapshot"): number {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not a Hetzner ${what} id.`, {
      hint: `Use the numeric id shown for the ${what} in the Hetzner Cloud Console.`,
    });
  }
  return id;
}
