import type { ObjectStorageApi, ObjectStorageKey, ProviderObjectStorage } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { type ContaboClient, type ContaboObjectStorage, ContaboStatusError } from "./client";

/** How long a new object storage may take to become ready (15 minutes; unverified live). */
const READY_TIMEOUT_MS = 15 * 60_000;

/** The regions OpsCrew orders object storage in, as Contabo takes them (research R15). */
const REGIONS: readonly string[] = ["EU", "US-central", "SIN"];

/** `s3Url` with its scheme (Contabo's examples give both forms) and no trailing slash. */
function endpoint(s3Url: string): string {
  const url = s3Url.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

/** A Contabo object storage as the connector reports it. */
function storageOf(storage: ContaboObjectStorage): ProviderObjectStorage {
  return {
    id: storage.objectStorageId,
    region: storage.region,
    s3Url: endpoint(storage.s3Url),
    ...(storage.cancelDate ? { cancelledUntil: storage.cancelDate } : {}),
  };
}

/**
 * Contabo's Object Storage through its API (research R15): one storage per region and account,
 * ordered here because Contabo's Terraform provider cannot import one, and never cancelled. Its
 * S3 key is made by Contabo with the storage and read through the API user's credentials list.
 */
export function contaboObjectStorageApi(client: ContaboClient): ObjectStorageApi {
  return {
    async find(region: string): Promise<ProviderObjectStorage | undefined> {
      const storages = (await client.listObjectStorages()).filter(
        (storage) => storage.status !== "CANCELLED",
      );
      // A region named otherwise could hide the account's storage: never answer "none" then.
      const unknown = storages.find((storage) => !REGIONS.includes(storage.region));
      if (unknown !== undefined) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Contabo lists the object storage ${unknown.objectStorageId} in the region "${unknown.region}", which OpsCrew does not know, so it cannot tell whether the account has object storage in ${region}. Nothing was changed.`,
          { hint: "Please report this to OpsCrew with the region Contabo shows." },
        );
      }
      const found = storages.find((storage) => storage.region === region);
      return found === undefined ? undefined : storageOf(found);
    },

    async order(request) {
      let ordered: ContaboObjectStorage;
      try {
        ordered = await client.createObjectStorage({
          region: request.region,
          totalPurchasedSpaceTB: request.sizeTb,
          displayName: request.displayName,
        });
      } catch (error) {
        if (error instanceof ContaboStatusError) return { refused: error.message };
        throw error;
      }
      const ready = await client.waitForObjectStorage(ordered.objectStorageId, {
        timeoutMs: READY_TIMEOUT_MS,
      });
      return { ordered: storageOf(ready) };
    },

    async key(storageId: string): Promise<ObjectStorageKey> {
      const userId = await client.apiUserId();
      const [credential] = await client.objectStorageCredentials(userId, storageId);
      if (credential === undefined) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Contabo lists no S3 key of the object storage ${storageId} for the API user.`,
          {
            hint: "Open the object storage in Contabo's Customer Control Panel and check its S3 credentials, then run the command again.",
          },
        );
      }
      return { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
    },
  };
}
