import type {
  AppServer,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { errorText, OpsCrewError } from "@opscrew/core";
import type { HetznerClient, HetznerServerState } from "./client";

/** Default wait for a snapshot or a rebuild to finish (15 minutes). */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How long a graceful shutdown may take before OpsCrew stops waiting (it never forces one). */
const SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
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
          createdAt: image.created,
          ...(typeof image.image_size === "number" && { sizeGb: image.image_size }),
        }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async deleteSnapshot(snapshotId: string): Promise<void> {
      await client.deleteImage(numericId(snapshotId, "snapshot"));
    },
    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const id = numericId(serverId, "server");
      const image = numericId(snapshotId, "snapshot");
      // OpsCrew's servers are delete- and rebuild-protected (Hetzner wants both the same): the
      // protection is lifted for the rebuild and always set back, as the state records it.
      const { protection } = await client.getServer(id);
      const lifted = protection.rebuild;
      const before = { delete: protection.delete, rebuild: protection.rebuild };
      let failure: unknown;
      try {
        if (lifted) await setProtection(client, id, { delete: false, rebuild: false });
        const { actionId } = await client.rebuildServer(id, image);
        await client.waitForAction(actionId, { timeoutMs: ACTION_TIMEOUT_MS });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (lifted) {
          await setProtection(client, id, before).catch((error: unknown) => {
            throw unprotected(id, failure, error);
          });
        }
      }
    },
    async powerOff(serverId: string): Promise<void> {
      const id = numericId(serverId, "server");
      // The action only says the request was sent: the server's status says when it is off.
      await client.shutdownServer(id);
      await client.waitForServerStatus(id, "off", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    },
    async powerOn(serverId: string): Promise<void> {
      const { actionId } = await client.powerOnServer(numericId(serverId, "server"));
      await client.waitForAction(actionId, { timeoutMs: ACTION_TIMEOUT_MS });
    },
  };
}

/** Sets the server's protection and waits until Hetzner reports it set. */
async function setProtection(
  client: HetznerClient,
  serverId: number,
  protection: HetznerServerState["protection"],
): Promise<void> {
  const { actionId } = await client.changeProtection(serverId, protection);
  await client.waitForAction(actionId, { timeoutMs: ACTION_TIMEOUT_MS });
}

/**
 * The error when the protection lifted for a rebuild could not be set back; `failure` is the
 * rebuild's own error, if it failed.
 */
function unprotected(serverId: number, failure: unknown, cause: unknown): OpsCrewError {
  const outcome = failure === undefined ? "which finished" : `which failed (${errorText(failure)})`;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Hetzner server ${serverId} is unprotected: OpsCrew lifted its delete and rebuild protection for the rebuild, ${outcome}, and could not set it again (${errorText(cause)}).`,
    {
      hint: "Run `opscrew provision`: it sets the protection again from the infrastructure state (or turn it on for the server in the Hetzner Cloud Console).",
      cause,
    },
  );
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
