/** A provider's whole-server snapshots for the snapshot commands' tests. */
import type { ServerSnapshot, ServerSnapshotApi } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/** OpsCrew's snapshot of the app's server at the provider. */
export const WHOLE_SERVER: ServerSnapshot = {
  id: "770011",
  name: "opscrew shop-staging 2026-11-05",
  createdAt: "2026-11-05T08:00:00Z",
  sizeGb: 2,
  labels: { "created-by": "opscrew" },
};

/**
 * The provider of the app's server `shop-staging` (id 42) with `snapshots`. With `gone`, a deletion
 * answers 404, as for a snapshot deleted meanwhile in the provider's console.
 */
export function fakeProvider(snapshots: ServerSnapshot[], o: { gone?: boolean } = {}) {
  const deleted: string[] = [];
  const api: ServerSnapshotApi = {
    findAppServers: async (app) => [{ id: "42", name: app, status: "running" }],
    snapshotServer: async () => {
      throw new Error("not in these tests");
    },
    listSnapshots: async (serverId) =>
      serverId === "42" ? snapshots.filter((snapshot) => !deleted.includes(snapshot.id)) : [],
    deleteSnapshot: async (id) => {
      deleted.push(id);
      if (o.gone) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Hetzner API request /images/${id} failed (HTTP 404): image not found`,
        );
      }
    },
    rebuild: async () => {
      throw new Error("not in these tests");
    },
  };
  return { api, deleted };
}
