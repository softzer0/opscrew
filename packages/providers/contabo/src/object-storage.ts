import type { ObjectStorageApi, ObjectStorageKey, ProviderObjectStorage } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { ContaboClient, ContaboObjectStorage } from "./client";

/** How long a new object storage may take to become ready (15 minutes; unverified live). */
const READY_TIMEOUT_MS = 15 * 60_000;

/**
 * The long names Contabo may answer for a region it takes as `EU`, `US-central` and `SIN` (the
 * credentials' `regionName` filter's example is "Asia (Singapore)", R15): a guess, unverified live.
 */
const REGION_NAMES: Readonly<Record<string, readonly string[]>> = {
  EU: ["european union", "eu"],
  "US-central": ["united states (central)", "us-central"],
  SIN: ["asia (singapore)", "sin"],
};

/** True when Contabo's answered `region` is the region OpsCrew orders as `wanted`. */
function sameRegion(region: string, wanted: string): boolean {
  const names = REGION_NAMES[wanted] ?? [wanted.toLowerCase()];
  return names.includes(region.trim().toLowerCase());
}

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
 * ordered and cancelled here because Contabo's Terraform provider cannot import one. Its S3 key is
 * made by Contabo with the storage and read through the API user's credentials list.
 */
export function contaboObjectStorageApi(client: ContaboClient): ObjectStorageApi {
  return {
    async find(region: string): Promise<ProviderObjectStorage | undefined> {
      const storages = await client.listObjectStorages();
      const found = storages.find(
        (storage) => storage.status !== "CANCELLED" && sameRegion(storage.region, region),
      );
      return found === undefined ? undefined : storageOf(found);
    },

    async order(request): Promise<ProviderObjectStorage> {
      const ordered = await client.createObjectStorage({
        region: request.region,
        totalPurchasedSpaceTB: request.sizeTb,
        displayName: request.displayName,
      });
      const ready = await client.waitForObjectStorage(ordered.objectStorageId, {
        timeoutMs: READY_TIMEOUT_MS,
      });
      return storageOf(ready);
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

    async cancel(storageId: string): Promise<string> {
      // Cancelled already (a removal run again after a stop): its end date, never a second cancel.
      const { cancelDate } = await client.getObjectStorage(storageId);
      return cancelDate || client.cancelObjectStorage(storageId);
    },
  };
}
