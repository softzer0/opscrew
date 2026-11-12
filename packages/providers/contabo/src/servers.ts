import type {
  AppServer,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { ContaboClient, ContaboInstance } from "./client";

/** Default wait for a revert or a start to finish (15 minutes). */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How long a graceful shutdown may take before OpsCrew stops waiting (it never forces one). */
const SHUTDOWN_TIMEOUT_MS = 5 * 60_000;
/** How the names of the snapshots OpsCrew takes start (Contabo has no labels on them). */
const SNAPSHOT_PREFIX = "opscrew-";
/** The longest snapshot name Contabo accepts; the description keeps the whole request. */
const SNAPSHOT_NAME_MAX = 30;
/** How the tag naming the app an instance belongs to starts (`opscrew-app:<app>`). */
const APP_TAG = "opscrew-app:";

/**
 * Server lookup by OpsCrew's app tag (and by name for a server never tagged), and snapshots,
 * reverts and power actions for the provider-neutral teardown and snapshot commands, backed by
 * `ContaboClient`. A snapshot's id is `<instance id>:<snapshot id>`: Contabo reaches a snapshot
 * only through its instance.
 */
export function contaboServerApi(client: ContaboClient): ServerSnapshotApi {
  return {
    /**
     * The instances tagged `opscrew-app:<app>`, and those with no OpsCrew app tag whose display
     * name is `<app>` or starts with `<app>-`, marked `nameOnly`: Contabo creates an instance
     * before it can be tagged, so a create that stopped halfway leaves it untagged.
     */
    async findAppServers(app: string): Promise<AppServer[]> {
      const own = `${APP_TAG}${app}`;
      const ours = new Set<string>();
      const tagged = new Set<string>();
      for (const tag of await client.listTags()) {
        if (!tag.name.startsWith(APP_TAG)) continue;
        for (const assignment of await client.listTagAssignments(tag.tagId)) {
          if (assignment.resourceType !== "instance") continue;
          tagged.add(assignment.resourceId);
          if (tag.name === own) ours.add(assignment.resourceId);
        }
      }
      const servers: AppServer[] = [];
      for (const instance of await client.listInstances()) {
        const id = String(instance.instanceId);
        const name = instance.displayName ?? "";
        if (ours.has(id)) {
          servers.push(appServer(instance));
        } else if (!tagged.has(id) && (name === app || name.startsWith(`${app}-`))) {
          servers.push({ ...appServer(instance), nameOnly: true });
        }
      }
      return servers;
    },

    async snapshotServer(
      serverId: string,
      request: SnapshotRequest,
    ): Promise<{ snapshotId: string }> {
      const id = instanceId(serverId);
      // Contabo answers with the snapshot; its snapshots have no status to wait for.
      const { snapshotId } = await client.createSnapshot(id, {
        name: request.name.slice(0, SNAPSHOT_NAME_MAX),
        description: request.description,
      });
      return { snapshotId: `${id}:${snapshotId}` };
    },

    async listSnapshots(serverId: string): Promise<ServerSnapshot[]> {
      const id = instanceId(serverId);
      const snapshots = await client.listSnapshots(id);
      return snapshots
        .filter((snapshot) => snapshot.name.startsWith(SNAPSHOT_PREFIX))
        .map((snapshot) => ({
          id: `${id}:${snapshot.snapshotId}`,
          createdAt: snapshot.createdDate,
        }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    async deleteSnapshot(snapshotId: string): Promise<void> {
      const { instance, snapshot } = snapshotRef(snapshotId);
      await client.deleteSnapshot(instance, snapshot);
    },

    async rebuild(serverId: string, snapshotId: string): Promise<void> {
      const id = instanceId(serverId);
      const { instance, snapshot } = snapshotRef(snapshotId);
      if (instance !== id) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `The snapshot ${snapshotId} is of Contabo instance ${instance}, not ${id}: Contabo reverts an instance only to its own snapshots.`,
          { hint: "`opscrew snapshot list` shows each snapshot with its server." },
        );
      }
      await client.rollbackSnapshot(id, snapshot);
      await client.waitForStatus(id, "running", { timeoutMs: ACTION_TIMEOUT_MS });
    },

    async powerOff(serverId: string): Promise<void> {
      const id = instanceId(serverId);
      // Already off (a destroy run again after a shutdown): Contabo would refuse the action.
      if ((await client.getInstance(id)).status === "stopped") return;
      // A graceful shutdown (ACPI); Contabo's `stop` would cut the power, which OpsCrew never does.
      await client.instanceAction(id, "shutdown");
      await client.waitForStatus(id, "stopped", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    },

    async powerOn(serverId: string): Promise<void> {
      const id = instanceId(serverId);
      await client.instanceAction(id, "start");
      await client.waitForStatus(id, "running", { timeoutMs: ACTION_TIMEOUT_MS });
    },
  };
}

/** An instance as the app's server: its display name, and its end date once cancelled. */
function appServer(instance: ContaboInstance): AppServer {
  return {
    id: String(instance.instanceId),
    name: instance.displayName || instance.name,
    status: instance.status,
    ...(instance.cancelDate ? { cancelledUntil: instance.cancelDate } : {}),
  };
}

/** `value` as a Contabo instance id; anything else is refused before calling the API. */
export function instanceId(value: string): number {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id)) {
    throw new OpsCrewError("INVALID_INPUT", `"${value}" is not a Contabo instance id.`, {
      hint: "Use the numeric id shown for the instance in Contabo's Customer Control Panel.",
    });
  }
  return id;
}

/**
 * A snapshot id OpsCrew gave out, `<instance id>:<snapshot id>`, as its two parts; anything else
 * is refused before calling the API.
 */
function snapshotRef(value: string): { instance: number; snapshot: string } {
  const match = /^(\d+):([0-9A-Za-z]+)$/.exec(value);
  const instance = Number(match?.[1]);
  if (match?.[2] === undefined || !Number.isSafeInteger(instance)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${value}" is not a Contabo snapshot id: OpsCrew writes them as <instance id>:<snapshot id>.`,
      { hint: "`opscrew snapshot list` shows each snapshot's id." },
    );
  }
  return { instance, snapshot: match[2] };
}
