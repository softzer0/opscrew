import type { AppServer, ServerSnapshotApi, SnapshotRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { HetznerClient } from "./client";

/** Default wait for a snapshot to finish (15 minutes). */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;

/** Server lookup and snapshots for the provider-neutral teardown, backed by `HetznerClient`. */
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
      const id = Number(serverId);
      if (!/^\d+$/.test(serverId) || !Number.isSafeInteger(id)) {
        throw new OpsCrewError("INVALID_INPUT", `"${serverId}" is not a Hetzner server id.`, {
          hint: "Use the numeric id shown for the server in the Hetzner Cloud Console.",
        });
      }
      const { imageId, actionId } = await client.createSnapshot(id, {
        description: request.description,
        labels: request.labels,
      });
      await client.waitForAction(actionId, {
        timeoutMs: request.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
      });
      return { snapshotId: String(imageId) };
    },
  };
}
