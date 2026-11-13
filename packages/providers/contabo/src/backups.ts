import type { ProviderBackupsApi } from "@opscrew/contracts";
import { type ContaboClient, ContaboStatusError } from "./client";
import { instanceId } from "./servers";

/**
 * Contabo's Auto Backup through its API (research R15): a paid add-on of a Cloud VPS, turned on
 * with an upgrade of the instance, because Contabo's Terraform provider takes add-ons only by a
 * numeric id the API docs don't name. No call turns it off or restores a backup: the Customer
 * Control Panel does both.
 *
 * Unverified (R15): whether an upgrade of an instance that already has Auto Backup is harmless,
 * and which id in the instance's `addOns` list is Auto Backup. Neither is relied on: OpsCrew's
 * record of the upgrade keeps a re-run from sending it again, and nothing reads `addOns`.
 */
export function contaboBackupsApi(client: ContaboClient): ProviderBackupsApi {
  return {
    async turnOn(serverId: string): Promise<{ refused: string } | undefined> {
      const id = instanceId(serverId);
      try {
        await client.upgradeWithBackup(id);
      } catch (error) {
        // Contabo answered with an error status, so it turned nothing on.
        if (error instanceof ContaboStatusError) return { refused: error.message };
        throw error;
      }
      return undefined;
    },
  };
}
